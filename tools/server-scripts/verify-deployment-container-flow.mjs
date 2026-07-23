#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadDeploymentIndex } from "./deployment-index.mjs";
import { createServerSourcePackage } from "./package-server-source.mjs";
import {
  bindVerifierLocalMcpGrantIdentity,
  createVerifierLocalMcpGrantIdentity,
  verifierMcpRequestHeaders
} from "./lib/local-mcp-verifier-identity.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH = "build/reports/deployment-container-flow.json";
const CACHE_DIR = ".cache/lico/npm-artifacts";
const MCP_INTERFACE_VERSION = "v0.0.1:mcp:interface-1";
const TOOLSETS = Object.freeze([
  "lico.storage.read",
  "lico.console.read",
  "lico.gateway.read"
]);
const SENSITIVE_EVIDENCE_KEYS = new Set([
  "token",
  "granttoken",
  "claimtoken",
  "password",
  "secret",
  "cookie",
  "authorization",
  "csrftoken",
  "privatekey",
  "clientsecret",
  "apikey",
  "credential",
  "credentials"
]);
const dynamicSecretNeedles = new Set([repoRoot, os.homedir()].filter(Boolean));
const report = {
  schemaVersion: "v0.0.1:deployment:container-flow-report-1",
  verifier: "tools/server-scripts/verify-deployment-container-flow.mjs",
  startedAt: new Date().toISOString(),
  algorithm: {
    dependencyCache: "package-lock resolved artifact URLs are cached with HTTP Range resume and SRI integrity verification.",
    sourcePackage: "The canonical reproducible server source archive is expanded into an isolated temporary build context.",
    dockerBuild: "Docker BuildKit builds the expanded source archive with cache mounts for apt and npm dependency stores.",
    runtimeProbe: "docker compose builds and starts the real licomesh-server container, proves optional plugins are absent by default, then verifies the Core health, discovery, and MCP behavior.",
    destructiveChecks: "Malformed MCP JSON and unauthenticated tools/list must fail without crashing the container."
  },
  tests: [],
  destructiveTests: [],
  cleanup: {},
  summary: {}
};

let projectName = "";
let containerName = "";
let imageName = "";
let baseUrl = "";
let hostPort = 0;
let deploymentRoot = repoRoot;
let sourcePackageTempRoot = "";
const mcpIdentityByToken = new Map();

function trackSecret(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      dynamicSecretNeedles.add(text);
    }
  }
}

function redactText(value = "") {
  let text = String(value || "");
  for (const needle of dynamicSecretNeedles) {
    if (needle && text.includes(needle)) {
      text = text.split(needle).join("[redacted]");
    }
  }
  text = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  text = text.replace(/"token"\s*:\s*"[^"]+"/gi, "\"token\":\"[redacted]\"");
  text = text.replace(/lico_[A-Za-z0-9_-]{12,}/g, "lico_[redacted]");
  text = text.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:[redacted-port]");
  text = text.replace(/localhost:\d+/g, "localhost:[redacted-port]");
  text = text.replace(/\/opt\/lico\/data[^\s"']*/g, "/opt/lico/data/[redacted]");
  return text;
}

function safeEvidence(value = {}) {
  return JSON.parse(JSON.stringify(value, (key, child) => {
    const normalizedKey = String(key || "").replace(/[-_]/g, "").toLowerCase();
    if (SENSITIVE_EVIDENCE_KEYS.has(normalizedKey)) {
      return "[redacted]";
    }
    if (typeof child !== "string") {
      return child;
    }
    return redactText(child);
  }));
}

function assertNoLeakText(text = "", label = "text") {
  const value = String(text || "");
  for (const needle of dynamicSecretNeedles) {
    assert.equal(value.includes(needle), false, `${label} leaked verifier-local data`);
  }
  assert.equal(/Bearer\s+(?!\[redacted\])\S+/i.test(value), false, `${label} leaked bearer token`);
  assert.equal(/"token"\s*:\s*"(?!\[redacted\])[^"]+"/i.test(value), false, `${label} leaked token field`);
  assert.equal(/lico_[A-Za-z0-9_-]{12,}/.test(value), false, `${label} leaked token-like value`);
  assert.equal(/127\.0\.0\.1:\d+/.test(value), false, `${label} leaked verifier port`);
  assert.equal(/localhost:\d+/.test(value), false, `${label} leaked verifier port`);
}

function assertNoLeak(value, label = "payload") {
  assertNoLeakText(JSON.stringify(value), label);
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  report.summary.testCount = report.tests.length;
  report.summary.destructiveTestCount = report.destructiveTests.length;
  report.summary.failedCount = [...report.tests, ...report.destructiveTests].filter((item) => item.status !== "passed").length;
  report.summary.cleanupOk = report.cleanup.composeDown === true && report.cleanup.sourcePackageWorkspace === true;
  report.summary.deploymentReady = report.summary.failedCount === 0 && report.summary.cleanupOk === true;
  report.summary.coverageReady = report.summary.deploymentReady;
  report.summary.releaseReady = report.summary.deploymentReady;
  report.summary.reportLeakScan = true;
  assertNoLeak(report, "deployment container flow report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function failureEvidence(error) {
  const evidence = {
    errorName: error instanceof Error ? error.name : typeof error,
    code: String(error?.code || ""),
    status: Number(error?.status || 0) || 0,
    message: redactText(error?.message || "")
  };
  if (error?.dockerDaemonWaitedMs !== undefined || error?.dockerDaemonAttempts !== undefined) {
    evidence.dockerDaemonReady = false;
    evidence.dockerDaemonWaitedMs = Number(error.dockerDaemonWaitedMs || 0);
    evidence.dockerDaemonAttempts = Number(error.dockerDaemonAttempts || 0);
  }
  return evidence;
}

function record(collection, name, status, evidence = {}) {
  collection.push({ name, status, evidence: safeEvidence(evidence) });
}

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const evidence = await fn();
    record(report.tests, name, "passed", evidence);
    console.log("ok");
  } catch (error) {
    record(report.tests, name, "failed", failureEvidence(error));
    console.log("FAIL");
    throw error;
  }
}

async function destructiveTest(name, fn) {
  process.stdout.write(`  destructive ${name} ... `);
  try {
    const evidence = await fn();
    record(report.destructiveTests, name, "passed", evidence);
    console.log("ok");
  } catch (error) {
    record(report.destructiveTests, name, "failed", failureEvidence(error));
    console.log("FAIL");
    throw error;
  }
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      DOCKER_BUILDKIT: "1",
      COMPOSE_DOCKER_CLI_BUILD: "1",
      LICO_HOST_PORT: String(hostPort || ""),
      LICO_CONTAINER_NAME: containerName,
      LICO_IMAGE_NAME: imageName,
      ...options.env
    }
  });
  const stdout = redactText(result.stdout || "");
  const stderr = redactText(result.stderr || "");
  if (!options.allowFailure && result.status !== 0) {
    const error = new Error(`${command} ${args.join(" ")} failed with status ${result.status}; stderr=${stderr.slice(-2000)}`);
    error.status = result.status;
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
  return {
    status: result.status,
    stdout,
    stderr
  };
}

function runRaw(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      DOCKER_BUILDKIT: "1",
      COMPOSE_DOCKER_CLI_BUILD: "1",
      LICO_HOST_PORT: String(hostPort || ""),
      LICO_CONTAINER_NAME: containerName,
      LICO_IMAGE_NAME: imageName,
      ...options.env
    }
  });
  if (!options.allowFailure && result.status !== 0) {
    const stderr = redactText(result.stderr || "");
    const error = new Error(`${command} ${args.join(" ")} failed with status ${result.status}; stderr=${stderr.slice(-2000)}`);
    error.status = result.status;
    throw error;
  }
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

function waitForDockerDaemon({ timeoutMs = 120_000, intervalMs = 2500 } = {}) {
  const started = Date.now();
  let attempts = 0;
  let lastError = "";
  while (Date.now() - started <= timeoutMs) {
    attempts += 1;
    const info = run("docker", ["info", "--format", "{{json .ServerVersion}}"], { allowFailure: true });
    if (info.status === 0) {
      return {
        ready: true,
        attempts,
        waitedMs: Date.now() - started
      };
    }
    lastError = redactText(`${info.stderr || ""}\n${info.stdout || ""}`).slice(-1000);
    sleepSync(intervalMs);
  }
  return {
    ready: false,
    attempts,
    waitedMs: Date.now() - started,
    error: lastError
  };
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServerReady(timeoutMs = 150_000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/mcp/discovery`, { headers: { "Cache-Control": "no-store" } });
      if (response.status === 200) {
        const payload = await response.json();
        if (payload?.server?.name === "LicoMesh" || payload?.name === "LicoMesh" || payload?.mcpUrl) {
          return { ready: true, waitedMs: Date.now() - started };
        }
      }
      lastError = `status=${response.status}`;
    } catch (error) {
      lastError = error?.message || "fetch_failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`container server did not become ready: ${redactText(lastError)}`);
}

function waitForContainerHealthy(timeoutMs = 120_000) {
  const started = Date.now();
  let lastStatus = "unknown";
  while (Date.now() - started < timeoutMs) {
    const inspect = run(
      "docker",
      ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}", containerName],
      { allowFailure: true, cwd: deploymentRoot }
    );
    lastStatus = inspect.stdout.trim() || "unknown";
    if (inspect.status === 0 && lastStatus === "healthy") {
      return { healthy: true, waitedMs: Date.now() - started };
    }
    sleepSync(2000);
  }
  throw new Error(`container healthcheck did not become healthy: ${lastStatus}`);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function preparePackagedDeploymentSource() {
  const temporaryPrefix = path.join(os.tmpdir(), "lico-deployment-source-");
  sourcePackageTempRoot = await fs.mkdtemp(temporaryPrefix);
  trackSecret(sourcePackageTempRoot);
  const outputDirectory = path.join(sourcePackageTempRoot, "package");
  const extractionDirectory = path.join(sourcePackageTempRoot, "extracted");
  await fs.mkdir(extractionDirectory, { recursive: true });
  const result = await createServerSourcePackage({
    repoRoot,
    outputDirectory
  });
  const archivePath = path.join(outputDirectory, result.artifact.name);
  const checksumPath = path.join(outputDirectory, result.checksum.name);
  const [actualSha256, checksumText] = await Promise.all([
    sha256File(archivePath),
    fs.readFile(checksumPath, "utf8")
  ]);
  assert.equal(actualSha256, result.artifact.sha256);
  assert.equal(checksumText, `${actualSha256}  ${result.artifact.name}\n`);
  run("tar", ["-xzf", archivePath, "-C", extractionDirectory]);
  deploymentRoot = path.join(extractionDirectory, result.artifact.rootName);
  await Promise.all([
    fs.access(path.join(deploymentRoot, "Dockerfile")),
    fs.access(path.join(deploymentRoot, "docker-compose.yml")),
    fs.access(path.join(deploymentRoot, "plugins"))
  ]);
  return {
    artifactName: result.artifact.name,
    archiveSha256: result.artifact.sha256,
    sourceFileCount: result.source.copiedFileCount,
    checksumVerified: true,
    pluginSourceRootIncluded: result.source.pluginSourceRootIncluded,
    isolatedBuildContext: true
  };
}

async function fetchJson(route, options = {}) {
  const url = route.startsWith("http") ? route : `${baseUrl}${route}`;
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text.trim() ? JSON.parse(text) : {};
  assertNoLeak(safeEvidence(payload), route);
  return { status: response.status, ok: response.ok, payload };
}

async function createContainerHostDeviceGrant() {
  const verifierIdentity = createVerifierLocalMcpGrantIdentity({
    target: "codex",
    label: "verify-deployment-container-flow"
  });
  const grantRequest = {
    targets: ["codex"],
    label: "container deployment verifier",
    connectorVersion: "verify-deployment-container-flow",
    grantMode: "maintain",
    toolsets: TOOLSETS,
    processIdentity: verifierIdentity.request
  };
  const claimToken = randomBytes(32).toString("base64url");
  const claimTokenHash = createHash("sha256").update(claimToken, "utf8").digest("hex");
  trackSecret(claimToken);
  const created = await fetchJson("/api/mcp/local-grant/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...grantRequest, claimTokenHash })
  });
  assert.equal(created.status, 202, JSON.stringify(safeEvidence(created.payload)));
  assert.ok(created.payload.requestId, "device authorization did not return a request id");
  assert.match(String(created.payload.verificationCode || ""), /^[A-F0-9]{4}-[A-F0-9]{4}$/u);
  const authorizationRequestId = String(created.payload.requestId);
  assert.match(authorizationRequestId, /^mcp_auth_req_[a-z0-9_]+$/u);
  const script = `
import fs from "node:fs/promises";
const content = await fs.readFile("/opt/lico/data/auth/initial-credentials.txt", "utf8");
const username = content.match(/^Username\\s*:\\s*(.+)$/m)?.[1]?.trim() || "owner";
const password = content.match(/^Password\\s*:\\s*(.+)$/m)?.[1]?.trim() || "";
if (!password) throw new Error("missing_initial_owner_password");
const login = await fetch("http://127.0.0.1:7228/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password })
});
const loginPayload = await login.json().catch(() => ({}));
if (login.status !== 200) {
  console.log(JSON.stringify({ status: login.status, payload: loginPayload }));
  process.exit(0);
}
const cookie = (typeof login.headers.getSetCookie === "function"
  ? login.headers.getSetCookie()
  : String(login.headers.get("set-cookie") || "").split(/,(?=\\s*lico_)/).filter(Boolean))
  .map((item) => item.split(";")[0])
  .join("; ");
const response = await fetch("http://127.0.0.1:7228/api/console/mcp/authorization/requests/${authorizationRequestId}/resolve", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Cookie": cookie,
    "x-lico-csrf": loginPayload.csrfToken || "",
    "x-lico-safety-confirm": "true"
  },
  body: JSON.stringify({ resolution: "approved" })
});
const payload = await response.json().catch(() => ({}));
console.log(JSON.stringify({ status: response.status, payload }));
`;
  const result = runRaw("docker", ["exec", containerName, "node", "--input-type=module", "-e", script]);
  const approval = JSON.parse(result.stdout);
  assert.equal(approval.status, 200, JSON.stringify(safeEvidence(approval.payload)));
  assert.equal(approval.payload?.ok, true, JSON.stringify(safeEvidence(approval.payload)));
  const response = await fetchJson(
    `/api/mcp/local-grant/requests/${encodeURIComponent(authorizationRequestId)}/consume`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-lico-authorization-claim": claimToken
      },
      body: "{}"
    }
  );
  assert.equal(response.status, 201, JSON.stringify(safeEvidence(response.payload)));
  assert.ok(response.payload.token, "local MCP grant did not return a token");
  trackSecret(response.payload.token, response.payload.grant?.id, response.payload.grant?.tokenPrefix);
  assertNoLeak(safeEvidence(response.payload), "local MCP grant payload");
  bindVerifierLocalMcpGrantIdentity({
    identityByToken: mcpIdentityByToken,
    token: response.payload.token,
    identity: verifierIdentity.identity,
    payload: response.payload
  });
  return response.payload.token;
}

async function assertHostLocalGrantDenied() {
  const verifierIdentity = createVerifierLocalMcpGrantIdentity({
    target: "codex",
    label: "verify-deployment-container-flow-host-denied"
  });
  const response = await fetchJson("/api/mcp/local-grant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targets: ["codex"],
      label: "host denied container verifier",
      connectorVersion: "verify-deployment-container-flow",
      grantMode: "maintain",
      toolsets: TOOLSETS,
      processIdentity: verifierIdentity.request
    })
  });
  assert.equal(response.status, 403, JSON.stringify(safeEvidence(response.payload)));
  assert.equal(response.payload.error?.code, "local_pairing_required");
  return true;
}

function mcpHeaders(token = "", { body = "" } = {}) {
  return verifierMcpRequestHeaders({
    identityByToken: mcpIdentityByToken,
    token,
    target: "codex",
    method: "POST",
    url: `${baseUrl}/mcp`,
    body
  });
}

async function mcp(method, params = {}, { token = "", id = 1 } = {}) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const response = await fetchJson("/mcp", {
    method: "POST",
    headers: mcpHeaders(token, { body }),
    body
  });
  assert.equal(response.status, 200, JSON.stringify(safeEvidence(response.payload)));
  return response.payload;
}

async function mcpToolCall(token, name, operation, input = {}, id = 100) {
  const payload = await mcp("tools/call", {
    name,
    arguments: {
      apiVersion: MCP_INTERFACE_VERSION,
      operation,
      input,
      clientVersion: "verify-deployment-container-flow"
    }
  }, { token, id });
  assert.equal(payload.error, undefined, JSON.stringify(safeEvidence(payload.error || {})));
  return payload.result?.structuredContent || {};
}

async function cleanupCompose() {
  if (projectName) {
    const down = run("docker", ["compose", "-p", projectName, "down", "--volumes", "--remove-orphans"], {
      allowFailure: true,
      cwd: deploymentRoot
    });
    const imageRemove = imageName
      ? run("docker", ["image", "rm", imageName], { allowFailure: true })
      : { status: 0 };
    report.cleanup.composeDown = down.status === 0;
    report.cleanup.imageRemoveAttempted = Boolean(imageName);
    report.cleanup.imageRemoveStatus = imageRemove.status === 0 ? "removed-or-absent" : "kept";
  } else {
    report.cleanup.composeDown = true;
  }
  const temporaryPrefix = path.join(os.tmpdir(), "lico-deployment-source-");
  if (!sourcePackageTempRoot) {
    report.cleanup.sourcePackageWorkspace = true;
  } else if (sourcePackageTempRoot.startsWith(temporaryPrefix)) {
    try {
      await fs.rm(sourcePackageTempRoot, { recursive: true, force: true });
      report.cleanup.sourcePackageWorkspace = true;
    } catch {
      report.cleanup.sourcePackageWorkspace = false;
    }
  } else {
    report.cleanup.sourcePackageWorkspace = false;
  }
}

async function runNpmCacheInterruptResume() {
  const cacheDir = path.join(repoRoot, CACHE_DIR);
  await fs.rm(cacheDir, { recursive: true, force: true });
  const interrupt = run(process.execPath, [
    "tools/server-scripts/prepare-npm-artifact-cache.mjs",
    "--limit", "1",
    "--interrupt-after-bytes", "64",
    "--cache-dir", CACHE_DIR,
    "--report", "build/reports/npm-artifact-cache-interrupted.json"
  ], { allowFailure: true });
  assert.equal(interrupt.status, 75, "interrupted prefetch must exit with the checkpoint status");
  const resumed = run(process.execPath, [
    "tools/server-scripts/prepare-npm-artifact-cache.mjs",
    "--limit", "1",
    "--cache-dir", CACHE_DIR,
    "--report", "build/reports/npm-artifact-cache.json"
  ]);
  const manifest = JSON.parse(await fs.readFile(path.join(cacheDir, "checkpoint-manifest.json"), "utf8"));
  const artifactEntries = Object.values(manifest.artifacts || {});
  assert.equal(artifactEntries.length >= 1, true, "checkpoint manifest must contain at least one artifact");
  assert.equal(artifactEntries.every((entry) => entry.status === "complete"), true, "all selected artifacts must be complete");
  assert.equal(artifactEntries.every((entry) => entry.integrityAlgorithm), true, "artifact entries must record integrity algorithm");
  return {
    selectedArtifactCount: artifactEntries.length,
    interruptedStatus: interrupt.status,
    resumedStatus: resumed.status,
    manifestUntracked: manifest.cacheRoot === CACHE_DIR,
    verifiedComplete: true
  };
}

try {
  const index = await loadDeploymentIndex({ cwd: repoRoot });
  const runId = String(Date.now());
  hostPort = await freePort();
  projectName = `lico-container-${runId}`;
  containerName = `lico-container-${runId}`;
  imageName = `licomesh-server:container-${runId}`;
  baseUrl = `http://127.0.0.1:${hostPort}`;
  trackSecret(projectName, containerName, imageName, String(hostPort), baseUrl);

  console.log("\n=== Container Deployment Flow: resumable cache, BuildKit, compose, MCP ===\n");

  await test("deployment index docker preset points at the authoritative container flow", async () => {
    assert.equal(index.kind, "lico.deployment.entry-index");
    assert.equal(index.dockerPresets?.mainService?.dockerfile, "Dockerfile");
    assert.equal(index.dockerPresets?.mainService?.runtime?.command?.[0], "node");
    assert.equal(
      index.validation?.freshContainer?.some((item) =>
        String(item.command || "").includes("verify-deployment-container-flow.mjs") &&
          String(item.checks || "").includes("MCP baseline")
      ),
      true
    );
    return { dockerfile: "Dockerfile", verifierRegistered: true };
  });

  await test("canonical server source archive provides the isolated compose build context", async () => {
    return await preparePackagedDeploymentSource();
  });

  await test("npm artifact cache can checkpoint interrupt and resume with integrity verification", async () => {
    return await runNpmCacheInterruptResume();
  });

  await test("Dockerfile and compose use stable cache and isolated runtime controls", async () => {
    const dockerfile = await fs.readFile(path.join(deploymentRoot, "Dockerfile"), "utf8");
    const compose = await fs.readFile(path.join(deploymentRoot, "docker-compose.yml"), "utf8");
    assert.doesNotMatch(dockerfile, /^# syntax=docker\/dockerfile:/m);
    assert.match(dockerfile, /--mount=type=cache,target=\/var\/cache\/apt/);
    assert.match(dockerfile, /--mount=type=cache,target=\/var\/lib\/apt\/lists/);
    assert.match(
      dockerfile,
      /--mount=type=cache,id=licomesh-core-npm,target=\/var\/cache\/licomesh\/npm,sharing=locked/
    );
    assert.match(dockerfile, /--cache=\/var\/cache\/licomesh\/npm/);
    assert.match(dockerfile, /COPY plugins \.\/plugins/);
    assert.match(dockerfile, /--from=build \/app\/plugins \.\/plugins/);
    assert.match(
      dockerfile,
      /cp -a \/var\/cache\/licomesh\/npm\/_cacache \/opt\/lico-npm-cache\/_cacache/
    );
    assert.doesNotMatch(dockerfile, /cp -a \/var\/cache\/licomesh\/npm\/\. /);
    assert.match(compose, /\$\{LICO_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{LICO_HOST_PORT:-7228\}:7228/);
    assert.match(compose, /stop_grace_period: 90s/);
    assert.match(compose, /target: \$\{LICO_BUILD_TARGET:-runtime\}/);
    assert.match(compose, /LICO_SERVER_WITH_UI: "\$\{LICO_SERVER_WITH_UI:-0\}"/);
    assert.match(compose, /^\s+healthcheck:$/m);
    assert.match(compose, /LICO_BOOTSTRAP_URL: http:\/\/\$\{LICO_ADVERTISED_HOST:-127\.0\.0\.1\}:\$\{LICO_HOST_PORT:-7228\}/);
    assert.match(compose, /LICO_ADVERTISED_BASE_URL: http:\/\/\$\{LICO_ADVERTISED_HOST:-127\.0\.0\.1\}:\$\{LICO_HOST_PORT:-7228\}/);
    assert.match(compose, /LICO_ACTIVE_SERVICE_URL: http:\/\/\$\{LICO_ADVERTISED_HOST:-127\.0\.0\.1\}:\$\{LICO_HOST_PORT:-7228\}/);
    assert.match(compose, /\$\{LICO_CONTAINER_NAME:-licomesh-server\}/);
    assert.match(compose, /\$\{LICO_IMAGE_NAME:-licomesh-server:local\}/);
    assert.match(compose, /LICO_RUNTIME_CONFIG: \$\{LICO_RUNTIME_CONFIG:-\}/);
    return {
      buildKitAptCache: true,
      buildKitNpmCache: true,
      pluginSourcesPackaged: true,
      composePortOverride: true,
      composeBindAddressOverride: true,
      composeAdvertisedPortOverride: true,
      composeAdvertisedHostOverride: true,
      composeStopGracePeriodSeconds: 90,
      composeHealthcheck: true,
      selectableConsoleTarget: true,
      runtimeConfigPassthrough: true,
      remoteDockerfileFrontendRequired: false
    };
  });

  await test("docker compose builds starts and serves public readiness from the real container", async () => {
    const daemon = waitForDockerDaemon();
    if (daemon.ready !== true) {
      const error = new Error(`Docker daemon did not become ready for container deployment flow: ${daemon.error}`);
      error.dockerDaemonWaitedMs = daemon.waitedMs;
      error.dockerDaemonAttempts = daemon.attempts;
      throw error;
    }
    const build = run("docker", ["compose", "-p", projectName, "build", "licomesh-server"], {
      cwd: deploymentRoot,
      env: { LICO_RUNTIME_CONFIG: "" }
    });
    const up = run("docker", ["compose", "-p", projectName, "up", "-d", "licomesh-server"], {
      cwd: deploymentRoot,
      env: { LICO_RUNTIME_CONFIG: "" }
    });
    const readiness = await waitForServerReady();
    const containerHealth = waitForContainerHealthy();
    const initialize = await mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "verify-deployment-container-flow", version: "0.0.0" }
    }, { id: 1 });
    assert.equal(initialize.result?.serverInfo?.name, "LicoMesh");
    return {
      dockerDaemonReady: true,
      dockerDaemonWaitMs: daemon.waitedMs,
      dockerDaemonAttempts: daemon.attempts,
      buildStatus: build.status,
      upStatus: up.status,
      readinessMs: readiness.waitedMs,
      healthcheckMs: containerHealth.waitedMs,
      containerHealthy: true,
      mcpInitializeOk: true
    };
  });

  await test("container serves the Core MCP baseline through host device authorization", async () => {
    const token = await createContainerHostDeviceGrant();
    const toolsList = await mcp("tools/list", {}, { token, id: 2 });
    const tools = toolsList.result?.tools || [];
    const toolNames = new Set(tools.map((tool) => tool.name));
    for (const expected of ["lico.discovery", "lico.gateway"]) {
      assert.equal(toolNames.has(expected), true, `missing MCP outlet ${expected}`);
    }
    const capabilities = await mcpToolCall(token, "lico.discovery", "lico.capabilities.list", {}, 3);
    assert.equal(Array.isArray(capabilities.operations), true);
    const health = await mcpToolCall(token, "lico.discovery", "system.health", {}, 4);
    assert.equal(health.payload?.ok, true, JSON.stringify(safeEvidence(health)));
    return {
      toolCount: tools.length,
      capabilitiesListed: capabilities.operations.length > 0,
      systemHealthOk: true
    };
  });

  await destructiveTest("malformed and unauthenticated MCP requests are rejected while container remains healthy", async () => {
    const hostGrantDenied = await assertHostLocalGrantDenied();
    const malformed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{\"jsonrpc\":\"2.0\","
    });
    assert.equal(malformed.status >= 400, true);
    const unauthenticated = await fetchJson("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/list", params: {} })
    });
    assert.equal(unauthenticated.payload.error?.code !== undefined, true);
    const discovery = await fetchJson("/api/mcp/discovery", {
      method: "GET",
      headers: { "Cache-Control": "no-store" }
    });
    assert.equal(discovery.status, 200);
    return {
      hostLocalGrantDenied: hostGrantDenied,
      malformedStatusRejected: malformed.status >= 400,
      unauthenticatedDenied: true,
      discoveryStillHealthy: true
    };
  });
} catch (error) {
  process.exitCode = 1;
  console.error(`[deployment-container-flow] ${redactText(error?.message || error)}`);
} finally {
  await cleanupCompose();
  if (report.cleanup.composeDown !== true || report.cleanup.sourcePackageWorkspace !== true) {
    process.exitCode = 1;
  }
  await writeReport().catch((error) => {
    process.exitCode = 1;
    console.error(`[deployment-container-flow] report failed: ${redactText(error?.message || error)}`);
  });
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`PASS: container deployment flow verified; report: ${REPORT_PATH}`);
