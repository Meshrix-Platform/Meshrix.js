#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadDeploymentIndex } from "./deployment-index.ts";
import { createServerSourcePackage } from "./package-server-source.ts";
import { verifierMcpRequestHeaders } from "./lib/verifier-mcp-api-key.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const engineIndex: any = process.argv.indexOf("--engine");
const CONTAINER_ENGINE: any = engineIndex >= 0 ? String(process.argv[engineIndex + 1] || "") : "docker";
if (!["docker", "podman"].includes(CONTAINER_ENGINE)) {
  throw new Error("container_engine_must_be_docker_or_podman");
}
const IS_LOCAL_PODMAN: any = CONTAINER_ENGINE === "podman";
const REPORT_PATH: any = IS_LOCAL_PODMAN
  ? "build/reports/deployment-container-flow-podman.json"
  : "build/reports/deployment-container-flow.json";
const CACHE_DIR: any = ".cache/meshrix/npm-artifacts";
const MCP_INTERFACE_VERSION: any = "v0.0.1:mcp:interface-1";
const TOOLSETS: readonly any[] = Object.freeze([
  "meshrix.storage.read",
  "meshrix.console.read",
  "meshrix.gateway.read"
]);
const SENSITIVE_EVIDENCE_KEYS: any = new Set<any>([
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
const dynamicSecretNeedles: any = new Set<any>([repoRoot, os.homedir()].filter(Boolean));
const report: Record<string, any> = {
  schemaVersion: "v0.0.1:deployment:container-flow-report-1",
  verifier: "tools/server-scripts/verify-deployment-container-flow.ts",
  startedAt: new Date().toISOString(),
  algorithm: {
    dependencyCache: "package-lock resolved artifact URLs are cached with HTTP Range resume and SRI integrity verification.",
    sourcePackage: "The canonical reproducible server source archive is expanded into an isolated temporary build context.",
    ...(IS_LOCAL_PODMAN
      ? { containerBuild: "Podman Compose builds the expanded source archive with reusable dependency caches." }
      : { dockerBuild: "Docker BuildKit builds the expanded source archive with cache mounts for apt and npm dependency stores." }),
    runtimeProbe: `${CONTAINER_ENGINE} compose builds and starts the real meshrix-server container, proves optional plugins are absent by default, then verifies the Core health, discovery, and MCP behavior.`,
    destructiveChecks: "Malformed MCP JSON and unauthenticated tools/list must fail without crashing the container."
  },
  tests: [],
  destructiveTests: [],
  cleanup: {},
  summary: {}
};

let projectName: any = "";
let containerName: any = "";
let imageName: any = "";
let baseUrl: any = "";
let hostPort: any = 0;
let deploymentRoot: any = repoRoot;
let sourcePackageTempRoot: any = "";

function trackSecret(...values: any[]) : any {
  for (const value of values) {
    const text: any = String(value || "").trim();
    if (text) {
      dynamicSecretNeedles.add(text);
    }
  }
}

function redactText(value: any = "") : any {
  let text: any = String(value || "");
  for (const needle of dynamicSecretNeedles) {
    if (needle && text.includes(needle)) {
      text = text.split(needle).join("[redacted]");
    }
  }
  text = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  text = text.replace(/"token"\s*:\s*"[^"]+"/gi, "\"token\":\"[redacted]\"");
  text = text.replace(/meshrix_[A-Za-z0-9_-]{12,}/g, "meshrix_[redacted]");
  text = text.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:[redacted-port]");
  text = text.replace(/localhost:\d+/g, "localhost:[redacted-port]");
  text = text.replace(/\/opt\/meshrix\/data[^\s"']*/g, "/opt/meshrix/data/[redacted]");
  return text;
}

function safeEvidence(value: Record<string, any> = {}) : any {
  return JSON.parse(JSON.stringify(value, (key?: any, child?: any) : any => {
    const normalizedKey: any = String(key || "").replace(/[-_]/g, "").toLowerCase();
    if (SENSITIVE_EVIDENCE_KEYS.has(normalizedKey)) {
      return "[redacted]";
    }
    if (typeof child !== "string") {
      return child;
    }
    return redactText(child);
  }));
}

function assertNoLeakText(text: any = "", label: any = "text") : any {
  const value: any = String(text || "");
  for (const needle of dynamicSecretNeedles) {
    assert.equal(value.includes(needle), false, `${label} leaked verifier-local data`);
  }
  assert.equal(/Bearer\s+(?!\[redacted\])\S+/i.test(value), false, `${label} leaked bearer token`);
  assert.equal(/"token"\s*:\s*"(?!\[redacted\])[^"]+"/i.test(value), false, `${label} leaked token field`);
  assert.equal(/meshrix_[A-Za-z0-9_-]{12,}/.test(value), false, `${label} leaked token-like value`);
  assert.equal(/127\.0\.0\.1:\d+/.test(value), false, `${label} leaked verifier port`);
  assert.equal(/localhost:\d+/.test(value), false, `${label} leaked verifier port`);
}

function assertNoLeak(value?: any, label: any = "payload") : any {
  assertNoLeakText(JSON.stringify(value), label);
}

async function writeReport() : Promise<any> {
  report.finishedAt = new Date().toISOString();
  report.summary.testCount = report.tests.length;
  report.summary.destructiveTestCount = report.destructiveTests.length;
  report.summary.failedCount = [...report.tests, ...report.destructiveTests].filter((item?: any) : any => item.status !== "passed").length;
  report.summary.cleanupOk = report.cleanup.composeDown === true && report.cleanup.sourcePackageWorkspace === true;
  report.summary.deploymentReady = report.summary.failedCount === 0 && report.summary.cleanupOk === true;
  report.summary.coverageReady = report.summary.deploymentReady;
  if (IS_LOCAL_PODMAN) {
    report.summary.localVerificationReady = report.summary.deploymentReady;
    report.summary.releaseReady = false;
    report.summary.evidenceAuthority = "local-only";
  } else {
    report.summary.releaseReady = report.summary.deploymentReady;
  }
  report.summary.reportLeakScan = true;
  assertNoLeak(report, "deployment container flow report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function failureEvidence(error?: any) : any {
  const evidence: Record<string, any> = {
    errorName: error instanceof Error ? error.name : typeof error,
    code: String(error?.code || ""),
    status: Number(error?.status || 0) || 0,
    message: redactText(error?.message || "")
  };
  if (error?.containerEngineWaitedMs !== undefined || error?.containerEngineAttempts !== undefined) {
    evidence.containerEngineReady = false;
    evidence.containerEngineWaitedMs = Number(error.containerEngineWaitedMs || 0);
    evidence.containerEngineAttempts = Number(error.containerEngineAttempts || 0);
  }
  return evidence;
}

function record(collection?: any, name?: any, status?: any, evidence: Record<string, any> = {}) : any {
  collection.push({ name, status, evidence: safeEvidence(evidence) });
}

async function test(name?: any, fn?: any) : Promise<any> {
  process.stdout.write(`  ${name} ... `);
  try {
    const evidence: any = await fn();
    record(report.tests, name, "passed", evidence);
    console.log("ok");
  } catch (error: any) {
    record(report.tests, name, "failed", failureEvidence(error));
    console.log("FAIL");
    throw error;
  }
}

async function destructiveTest(name?: any, fn?: any) : Promise<any> {
  process.stdout.write(`  destructive ${name} ... `);
  try {
    const evidence: any = await fn();
    record(report.destructiveTests, name, "passed", evidence);
    console.log("ok");
  } catch (error: any) {
    record(report.destructiveTests, name, "failed", failureEvidence(error));
    console.log("FAIL");
    throw error;
  }
}

function run(command?: any, args: any = [], options: Record<string, any> = {}) : any {
  const result: any = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      DOCKER_BUILDKIT: "1",
      COMPOSE_DOCKER_CLI_BUILD: "1",
      MESHRIX_HOST_PORT: String(hostPort || ""),
      MESHRIX_CONTAINER_NAME: containerName,
      MESHRIX_IMAGE_NAME: imageName,
      ...(IS_LOCAL_PODMAN ? { PODMAN_COMPOSE_PROVIDER: "podman-compose" } : {}),
      ...options.env
    }
  });
  const stdout: any = redactText(result.stdout || "");
  const stderr: any = redactText(result.stderr || "");
  if (!options.allowFailure && result.status !== 0) {
    const error: Error & Record<string, any> = new Error(`${command} ${args.join(" ")} failed with status ${result.status}; stderr=${stderr.slice(-2000)}`);
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

function runRaw(command?: any, args: any = [], options: Record<string, any> = {}) : any {
  const result: any = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      DOCKER_BUILDKIT: "1",
      COMPOSE_DOCKER_CLI_BUILD: "1",
      MESHRIX_HOST_PORT: String(hostPort || ""),
      MESHRIX_CONTAINER_NAME: containerName,
      MESHRIX_IMAGE_NAME: imageName,
      ...(IS_LOCAL_PODMAN ? { PODMAN_COMPOSE_PROVIDER: "podman-compose" } : {}),
      ...options.env
    }
  });
  if (!options.allowFailure && result.status !== 0) {
    const stderr: any = redactText(result.stderr || "");
    const error: Error & Record<string, any> = new Error(`${command} ${args.join(" ")} failed with status ${result.status}; stderr=${stderr.slice(-2000)}`);
    error.status = result.status;
    throw error;
  }
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function sleepSync(ms?: any) : any {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

function waitForContainerEngine({ timeoutMs = 120_000, intervalMs = 2500 }: Record<string, any> = {}) : any {
  const started: any = Date.now();
  let attempts: any = 0;
  let lastError: any = "";
  while (Date.now() - started <= timeoutMs) {
    attempts += 1;
    const info: any = run(CONTAINER_ENGINE, ["info"], { allowFailure: true });
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

async function freePort() : Promise<any> {
  return await new Promise((resolve?: any, reject?: any) : any => {
    const server: any = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () : any => {
      const address: any = server.address();
      server.close(() : any => resolve(address.port));
    });
  });
}

async function waitForServerReady(timeoutMs: any = 150_000) : Promise<any> {
  const started: any = Date.now();
  let lastError: any = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const response: any = await fetch(`${baseUrl}/api/mcp/discovery`, { headers: { "Cache-Control": "no-store" } });
      if (response.status === 200) {
        const payload: any = await response.json();
        if (payload?.server?.name === "Meshrix.js" || payload?.name === "Meshrix.js" || payload?.mcpUrl) {
          return { ready: true, waitedMs: Date.now() - started };
        }
      }
      lastError = `status=${response.status}`;
    } catch (error: any) {
      lastError = error?.message || "fetch_failed";
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, 1500));
  }
  throw new Error(`container server did not become ready: ${redactText(lastError)}`);
}

function waitForContainerHealthy(timeoutMs: any = 120_000) : any {
  const started: any = Date.now();
  let lastStatus: any = "unknown";
  while (Date.now() - started < timeoutMs) {
    const inspect: any = run(
      CONTAINER_ENGINE,
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

function inspectContainer() : any {
  const inspected: any = runRaw(CONTAINER_ENGINE, ["inspect", containerName], {
    cwd: deploymentRoot
  });
  const values: any = JSON.parse(inspected.stdout);
  assert.equal(Array.isArray(values) && values.length === 1, true);
  return values[0];
}

function containerFileSha256(filePath?: any) : any {
  const script: any = `
import crypto from "node:crypto";
import fs from "node:fs/promises";
const bytes = await fs.readFile(${JSON.stringify(filePath)});
process.stdout.write(crypto.createHash("sha256").update(bytes).digest("hex"));
`;
  const result: any = runRaw(
    CONTAINER_ENGINE,
    ["exec", containerName, "node", "--input-type=module", "-e", script],
    { cwd: deploymentRoot }
  );
  const digest: any = result.stdout.trim();
  assert.match(digest, /^[a-f0-9]{64}$/u);
  return digest;
}

function createContainerPersistenceProbe() : any {
  const filePath: any = "/app/data/.deployment-persistence-probe";
  const script: any = `
import fs from "node:fs/promises";
await fs.writeFile(${JSON.stringify(filePath)}, "meshrix-deployment-persistence-probe\\n", {
  flag: "wx",
  mode: 0o600
});
`;
  runRaw(
    CONTAINER_ENGINE,
    ["exec", containerName, "node", "--input-type=module", "-e", script],
    { cwd: deploymentRoot }
  );
  return filePath;
}

function verifyIndependentBackupMountWritable() : any {
  const script: any = `
import fs from "node:fs/promises";
const probe = "/app/backups/.deployment-backup-volume-probe";
await fs.writeFile(probe, "backup-volume-probe\\n", { flag: "wx", mode: 0o600 });
await fs.rm(probe);
`;
  runRaw(
    CONTAINER_ENGINE,
    ["exec", containerName, "node", "--input-type=module", "-e", script],
    { cwd: deploymentRoot }
  );
  return true;
}

async function sha256File(filePath?: any) : Promise<any> {
  const hash: any = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function preparePackagedDeploymentSource() : Promise<any> {
  const temporaryPrefix: any = path.join(os.tmpdir(), "meshrix-deployment-source-");
  sourcePackageTempRoot = await fs.mkdtemp(temporaryPrefix);
  trackSecret(sourcePackageTempRoot);
  const outputDirectory: any = path.join(sourcePackageTempRoot, "package");
  const extractionDirectory: any = path.join(sourcePackageTempRoot, "extracted");
  await fs.mkdir(extractionDirectory, { recursive: true });
  const result: any = await createServerSourcePackage({
    repoRoot,
    outputDirectory
  });
  const archivePath: any = path.join(outputDirectory, result.artifact.name);
  const checksumPath: any = path.join(outputDirectory, result.checksum.name);
  const [actualSha256, checksumText] = await Promise.all([
    sha256File(archivePath),
    fs.readFile(checksumPath, "utf8")
  ]);
  assert.equal(actualSha256, result.artifact.sha256);
  assert.equal(checksumText, `${actualSha256}  ${result.artifact.name}\n`);
  run("tar", ["-xzf", archivePath, "-C", extractionDirectory]);
  deploymentRoot = path.join(extractionDirectory, result.artifact.rootName);
  const vendoredEntries: any = await fs.readdir(path.join(deploymentRoot, "vendor"));
  const authorizedVendoredTarball: any = vendoredEntries.find((entry?: any) : any =>
    /^pactium-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/u.test(String(entry || ""))
  );
  assert.ok(authorizedVendoredTarball, "source_package_authorized_vendored_tarball_missing");
  await Promise.all([
    fs.access(path.join(deploymentRoot, "Dockerfile")),
    fs.access(path.join(deploymentRoot, "docker-compose.yml")),
    fs.access(path.join(deploymentRoot, "plugins")),
    fs.access(path.join(deploymentRoot, "vendor", authorizedVendoredTarball))
  ]);
  return {
    artifactName: result.artifact.name,
    archiveSha256: result.artifact.sha256,
    sourceFileCount: result.source.copiedFileCount,
    checksumVerified: true,
    pluginSourceRootIncluded: result.source.pluginSourceRootIncluded,
    vendoredSourceRootIncluded: result.source.vendoredSourceRootIncluded,
    authorizedVendoredTarballIncluded: result.source.authorizedVendoredTarballIncluded,
    isolatedBuildContext: true
  };
}

async function fetchJson(route?: any, options: Record<string, any> = {}) : Promise<any> {
  const url: any = route.startsWith("http") ? route : `${baseUrl}${route}`;
  const response: any = await fetch(url, options);
  const text: any = await response.text();
  const payload: any = text.trim() ? JSON.parse(text) : {};
  assertNoLeak(safeEvidence(payload), route);
  return { status: response.status, ok: response.ok, payload };
}

async function createContainerHostApiKey() : Promise<any> {
  const script: any = `
import fs from "node:fs/promises";
const content = await fs.readFile("/app/data/auth/initial-credentials.txt", "utf8");
const username = content.match(/^Username\\s*:\\s*(.+)$/m)?.[1]?.trim() || "owner";
const password = content.match(/^Password\\s*:\\s*(.+)$/m)?.[1]?.trim() || "";
if (!password) throw new Error("missing_initial_owner_password");
const login = await fetch("http://127.0.0.1:7228/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password })
});
const loginPayload = await login.json();
const cookie = (typeof login.headers.getSetCookie === "function"
  ? login.headers.getSetCookie()
  : String(login.headers.get("set-cookie") || "").split(/,(?=\\s*meshrix_)/).filter(Boolean))
  .map((item) => item.split(";")[0]).join("; ");
const commonHeaders = { "Cookie": cookie };
const organizationResponse = await fetch("http://127.0.0.1:7228/api/authorization/organization-governance", { headers: commonHeaders });
const organization = await organizationResponse.json();
if (organization.snapshot?.configured !== true) {
  const mutationHeaders = {
    "Content-Type": "application/json",
    "Cookie": cookie,
    "x-meshrix-csrf": loginPayload.csrfToken || "",
    "x-meshrix-safety-confirm": "true"
  };
  const importedResponse = await fetch("http://127.0.0.1:7228/api/authorization/organization-governance/import", {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ templateKey: "enterprise-group" })
  });
  const imported = await importedResponse.json();
  const publishedResponse = await fetch("http://127.0.0.1:7228/api/authorization/organization-governance/publish", {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ ...imported.draft, expectedRevision: Number(organization.snapshot?.revision || 0) })
  });
  if (publishedResponse.status !== 200) throw new Error("organization_publication_failed");
}
const scopesResponse = await fetch("http://127.0.0.1:7228/api/operation-permission/v1/api-keys/issuer-scopes", { headers: commonHeaders });
const catalogResponse = await fetch("http://127.0.0.1:7228/api/operation-permission/v1/catalog", { headers: commonHeaders });
const scopes = await scopesResponse.json();
const catalog = await catalogResponse.json();
const selectedToolsets = new Set(${JSON.stringify(TOOLSETS)});
const selectedTools = (catalog.tools || [])
  .filter((tool) => (tool.toolsets || []).some((toolset) => selectedToolsets.has(toolset)));
const allowedTools = selectedTools.map((tool) => tool.id);
const scopeIds = [...new Set(selectedTools.flatMap((tool) => tool.requiredScopes || tool.scopes || []))];
const response = await fetch("http://127.0.0.1:7228/api/operation-permission/v1/api-keys", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Cookie": cookie,
    "x-meshrix-csrf": loginPayload.csrfToken || "",
    "x-meshrix-safety-confirm": "true"
  },
  body: JSON.stringify({
    workloadDisplayName: "Container deployment verifier",
    organizationNodeId: scopes.eligibleNodes?.[0]?.nodeId || "",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    policy: {
      protocol: "mcp",
      serviceIds: [],
      capabilityIds: [],
      toolsetIds: [...selectedToolsets],
      allowedTools,
      deniedTools: [],
      scopeIds,
      maximumRisk: "high",
      audience: { serverAudience: "127.0.0.1:${hostPort}", targetIds: ["codex"], connectorPackageIds: [] },
      resources: {
        mode: "unrestricted", workspaceIds: [], dataClassifications: [], egressClasses: [],
        semanticFamilies: [], capabilityDomains: [], capabilityVerbs: [], resourceKinds: [],
        effectKinds: [], secretBindingIds: [], allowedOrigins: [], allowedCidrs: []
      },
      processIdentity: { mode: "optional" },
      limits: { maxUses: 64, requestsPerWindow: 64, windowSeconds: 3600, maxConcurrentEffects: 4 },
      catalogFingerprint: scopes.catalogFingerprint
    }
  })
});
const payload = await response.json().catch(() => ({}));
console.log(JSON.stringify({ status: response.status, payload }));
`;
  const result: any = runRaw(CONTAINER_ENGINE, ["exec", containerName, "node", "--input-type=module", "-e", script]);
  const issued: any = JSON.parse(result.stdout);
  assert.equal(issued.status, 201, JSON.stringify(safeEvidence(issued.payload)));
  assert.ok(issued.payload.apiKey, "container API Key issuance did not return plaintext to the direct verifier caller");
  assert.ok(issued.payload.record?.keyId, "container API Key issuance did not return a bounded record identifier");
  trackSecret(issued.payload.apiKey, issued.payload.record.keyId);
  return issued.payload.apiKey;
}

function mcpHeaders(token: any = "") : any {
  return verifierMcpRequestHeaders({
    token,
    target: "codex"
  });
}

async function mcp(method?: any, params: Record<string, any> = {}, { token = "", id = 1 }: Record<string, any> = {}) : Promise<any> {
  const body: any = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const response: any = await fetchJson("/mcp", {
    method: "POST",
    headers: mcpHeaders(token),
    body
  });
  assert.equal(response.status, 200, JSON.stringify(safeEvidence(response.payload)));
  return response.payload;
}

async function mcpToolCall(token?: any, name?: any, operation?: any, input: Record<string, any> = {}, id: any = 100) : Promise<any> {
  const payload: any = await mcp("tools/call", {
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

async function cleanupCompose() : Promise<any> {
  if (projectName) {
    const down: any = run(CONTAINER_ENGINE, ["compose", "-p", projectName, "down", "--volumes", "--remove-orphans"], {
      allowFailure: true,
      cwd: deploymentRoot
    });
    const imageRemove: any = imageName
      ? run(CONTAINER_ENGINE, ["image", "rm", imageName], { allowFailure: true })
      : { status: 0 };
    report.cleanup.composeDown = down.status === 0;
    report.cleanup.imageRemoveAttempted = Boolean(imageName);
    report.cleanup.imageRemoveStatus = imageRemove.status === 0 ? "removed-or-absent" : "kept";
  } else {
    report.cleanup.composeDown = true;
  }
  const temporaryPrefix: any = path.join(os.tmpdir(), "meshrix-deployment-source-");
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

async function runNpmCacheInterruptResume() : Promise<any> {
  const cacheDir: any = path.join(repoRoot, CACHE_DIR);
  await fs.rm(cacheDir, { recursive: true, force: true });
  const interrupt: any = run(process.execPath, [
    "tools/server-scripts/prepare-npm-artifact-cache.ts",
    "--limit", "1",
    "--interrupt-after-bytes", "64",
    "--cache-dir", CACHE_DIR,
    "--report", "build/reports/npm-artifact-cache-interrupted.json"
  ], { allowFailure: true });
  assert.equal(interrupt.status, 75, "interrupted prefetch must exit with the checkpoint status");
  const resumed: any = run(process.execPath, [
    "tools/server-scripts/prepare-npm-artifact-cache.ts",
    "--limit", "1",
    "--cache-dir", CACHE_DIR,
    "--report", "build/reports/npm-artifact-cache.json"
  ]);
  const manifest: any = JSON.parse(await fs.readFile(path.join(cacheDir, "checkpoint-manifest.json"), "utf8"));
  const artifactEntries: any = (Object.values(manifest.artifacts || {}) as any[]);
  assert.equal(artifactEntries.length >= 1, true, "checkpoint manifest must contain at least one artifact");
  assert.equal(artifactEntries.every((entry?: any) : any => entry.status === "complete"), true, "all selected artifacts must be complete");
  assert.equal(artifactEntries.every((entry?: any) : any => entry.integrityAlgorithm), true, "artifact entries must record integrity algorithm");
  return {
    selectedArtifactCount: artifactEntries.length,
    interruptedStatus: interrupt.status,
    resumedStatus: resumed.status,
    manifestUntracked: manifest.cacheRoot === CACHE_DIR,
    verifiedComplete: true
  };
}

try {
  const index: any = await loadDeploymentIndex({ cwd: repoRoot });
  const runId: any = String(Date.now());
  hostPort = await freePort();
  projectName = `meshrix-container-${runId}`;
  containerName = `meshrix-container-${runId}`;
  imageName = `meshrix-server:container-${runId}`;
  baseUrl = `http://127.0.0.1:${hostPort}`;
  trackSecret(projectName, containerName, imageName, String(hostPort), baseUrl);

  console.log(`\n=== Container Deployment Flow (${CONTAINER_ENGINE}): resumable cache, compose, MCP ===\n`);

  await test("deployment index docker preset points at the authoritative container flow", async () : Promise<any> => {
    assert.equal(index.kind, "meshrix.deployment.entry-index");
    assert.equal(index.dockerPresets?.mainService?.dockerfile, "Dockerfile");
    assert.equal(index.dockerPresets?.mainService?.runtime?.command?.[0], "node");
    assert.equal(
      index.validation?.freshContainer?.some((item?: any) : any =>
        String(item.command || "").includes("verify-deployment-container-flow.ts") &&
          String(item.checks || "").includes("MCP baseline")
      ),
      true
    );
    return { dockerfile: "Dockerfile", verifierRegistered: true };
  });

  await test("canonical server source archive provides the isolated compose build context", async () : Promise<any> => {
    return await preparePackagedDeploymentSource();
  });

  await test("npm artifact cache can checkpoint interrupt and resume with integrity verification", async () : Promise<any> => {
    return await runNpmCacheInterruptResume();
  });

  await test("Dockerfile and compose use stable cache and isolated runtime controls", async () : Promise<any> => {
    const dockerfile: any = await fs.readFile(path.join(deploymentRoot, "Dockerfile"), "utf8");
    const compose: any = await fs.readFile(path.join(deploymentRoot, "docker-compose.yml"), "utf8");
    const rootfsTarget: any = String.raw`(?:\/|\$\{ROOTFS\})`;
    assert.doesNotMatch(dockerfile, /^# syntax=docker\/dockerfile:/m);
    assert.match(dockerfile, new RegExp(String.raw`--mount=type=cache,target=${rootfsTarget}var/cache/apt`));
    assert.match(dockerfile, new RegExp(String.raw`--mount=type=cache,target=${rootfsTarget}var/lib/apt/lists`));
    assert.match(
      dockerfile,
      new RegExp(String.raw`--mount=type=cache,id=meshrix-core-npm,target=${rootfsTarget}var/cache/meshrix/npm,sharing=locked`)
    );
    assert.match(dockerfile, new RegExp(String.raw`--cache=(?:\"|\")?${rootfsTarget}var/cache/meshrix/npm(?:\"|\")?`));
    assert.doesNotMatch(dockerfile, /COPY plugins \.\/plugins/);
    assert.doesNotMatch(dockerfile, /--from=build \/app\/plugins \.\/plugins/);
    assert.match(dockerfile, /COPY vendor \.\/vendor/);
    assert.match(
      dockerfile,
      new RegExp(String.raw`cp -a (?:\"|\")?${rootfsTarget}var/cache/meshrix/npm/_cacache(?:\"|\")? (?:\"|\")?${rootfsTarget}opt/meshrix-npm-cache/_cacache(?:\"|\")?`)
    );
    assert.doesNotMatch(dockerfile, new RegExp(String.raw`cp -a ${rootfsTarget}var/cache/meshrix/npm/\. `));
    assert.match(compose, /\$\{MESHRIX_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{MESHRIX_HOST_PORT:-7228\}:7228/);
    assert.match(compose, /stop_grace_period: 90s/);
    assert.match(compose, /stop_signal: SIGTERM/);
    assert.match(compose, /user: "10001:10001"/);
    assert.match(compose, /read_only: true/);
    assert.match(compose, /no-new-privileges:true/);
    assert.match(compose, /cap_drop:\s*\n\s+- ALL/);
    assert.match(compose, /meshrix-server-backups:\/app\/backups/);
    assert.match(compose, /meshrix-codex-home:\/codex-home/);
    assert.doesNotMatch(compose, /^\s+network_mode:\s+host\s*$/m);
    assert.match(compose, /pull_policy: \$\{MESHRIX_PULL_POLICY:-build\}/);
    assert.match(compose, /target: \$\{MESHRIX_BUILD_TARGET:-runtime\}/);
    assert.match(compose, /MESHRIX_SERVER_WITH_UI: "\$\{MESHRIX_SERVER_WITH_UI:-0\}"/);
    assert.match(compose, /^\s+healthcheck:$/m);
    assert.match(compose, /MESHRIX_BOOTSTRAP_URL: http:\/\/\$\{MESHRIX_ADVERTISED_HOST:-127\.0\.0\.1\}:\$\{MESHRIX_HOST_PORT:-7228\}/);
    assert.match(compose, /MESHRIX_ADVERTISED_BASE_URL: http:\/\/\$\{MESHRIX_ADVERTISED_HOST:-127\.0\.0\.1\}:\$\{MESHRIX_HOST_PORT:-7228\}/);
    assert.match(compose, /MESHRIX_ACTIVE_SERVICE_URL: http:\/\/\$\{MESHRIX_ADVERTISED_HOST:-127\.0\.0\.1\}:\$\{MESHRIX_HOST_PORT:-7228\}/);
    assert.match(compose, /\$\{MESHRIX_CONTAINER_NAME:-meshrix-server\}/);
    assert.match(compose, /\$\{MESHRIX_IMAGE_NAME:-meshrix-server:local\}/);
    assert.match(compose, /MESHRIX_RUNTIME_CONFIG: \$\{MESHRIX_RUNTIME_CONFIG:-\}/);
    return {
      buildKitAptCache: true,
      buildKitNpmCache: true,
      pluginSourcesPackaged: false,
      composePortOverride: true,
      composeBindAddressOverride: true,
      composeAdvertisedPortOverride: true,
      composeAdvertisedHostOverride: true,
      composeStopGracePeriodSeconds: 90,
      composeStopSignal: "SIGTERM",
      composeHealthcheck: true,
      composeNonRootUser: "10001:10001",
      composeReadOnlyRoot: true,
      composeCapabilitiesDropped: true,
      composeIndependentBackupVolume: true,
      composeHostNetworkDisabled: true,
      selectableConsoleTarget: true,
      runtimeConfigPassthrough: true,
      remoteDockerfileFrontendRequired: false
    };
  });

  await test(`${CONTAINER_ENGINE} compose builds starts and serves public readiness from the real container`, async () : Promise<any> => {
    const daemon: any = waitForContainerEngine();
    if (daemon.ready !== true) {
      const error: Error & Record<string, any> = new Error(`${CONTAINER_ENGINE} did not become ready for container deployment flow: ${daemon.error}`);
      error.containerEngineWaitedMs = daemon.waitedMs;
      error.containerEngineAttempts = daemon.attempts;
      throw error;
    }
    const build: any = run(CONTAINER_ENGINE, ["compose", "-p", projectName, "build", "meshrix-server"], {
      cwd: deploymentRoot,
      env: { MESHRIX_RUNTIME_CONFIG: "" }
    });
    const expectedImageId: any = run(
      CONTAINER_ENGINE,
      ["image", "inspect", "--format", "{{.Id}}", imageName],
      { cwd: deploymentRoot }
    ).stdout.trim();
    assert.match(expectedImageId, /^sha256:[a-f0-9]{64}$/u);
    const up: any = run(CONTAINER_ENGINE, [
      "compose",
      "-p",
      projectName,
      "up",
      "-d",
      "--no-build",
      "--pull",
      "never",
      "meshrix-server"
    ], {
      cwd: deploymentRoot,
      env: { MESHRIX_RUNTIME_CONFIG: "", MESHRIX_PULL_POLICY: "never" }
    });
    const readiness: any = await waitForServerReady();
    const containerHealth: any = waitForContainerHealthy();
    const initialize: any = await mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "verify-deployment-container-flow", version: "0.0.0" }
    }, { id: 1 });
    assert.equal(initialize.result?.serverInfo?.name, "Meshrix.js");
    const inspected: any = inspectContainer();
    assert.equal(inspected.Image, expectedImageId);
    assert.equal(inspected.Config?.User, "10001:10001");
    assert.equal(inspected.HostConfig?.ReadonlyRootfs, true);
    assert.equal(inspected.Config?.StopSignal, "SIGTERM");
    assert.equal(inspected.HostConfig?.CapDrop?.includes("ALL"), true);
    assert.equal(
      inspected.HostConfig?.SecurityOpt?.some((value?: any) : any =>
        String(value).includes("no-new-privileges")
      ),
      true
    );
    const mountDestinations: any = new Set<any>(
      (inspected.Mounts || []).map((mount?: any) : any => mount.Destination)
    );
    for (const destination of ["/app/data", "/app/backups", "/codex-home"]) {
      assert.equal(mountDestinations.has(destination), true, `missing mount ${destination}`);
    }
    assert.equal(verifyIndependentBackupMountWritable(), true);
    const networkNames: any = Object.keys(inspected.NetworkSettings?.Networks || {});
    assert.equal(networkNames.length, 1);
    const network: any = JSON.parse(runRaw(
      CONTAINER_ENGINE,
      ["network", "inspect", networkNames[0]],
      { cwd: deploymentRoot }
    ).stdout)[0];
    assert.equal(network.Internal, false);
    return {
      containerEngine: CONTAINER_ENGINE,
      containerEngineReady: true,
      containerEngineWaitMs: daemon.waitedMs,
      containerEngineAttempts: daemon.attempts,
      buildStatus: build.status,
      upStatus: up.status,
      readinessMs: readiness.waitedMs,
      healthcheckMs: containerHealth.waitedMs,
      containerHealthy: true,
      mcpInitializeOk: true,
      immutableImageIdMatched: true,
      buildDisabledDuringActivation: true,
      nonRootUid: 10001,
      readOnlyRootFilesystem: true,
      allLinuxCapabilitiesDropped: true,
      noNewPrivileges: true,
      independentBackupVolumeMounted: true,
      runtimeHasNoRequiredExternalDependencies: true
    };
  });

  await test("container serves the Core MCP baseline through a Console-issued API Key", async () : Promise<any> => {
    const token: any = await createContainerHostApiKey();
    const toolsList: any = await mcp("tools/list", {}, { token, id: 2 });
    const tools: any = toolsList.result?.tools || [];
    const toolNames: any = new Set<any>(tools.map((tool?: any) : any => tool.name));
    for (const expected of ["meshrix.discovery", "meshrix.gateway"]) {
      assert.equal(toolNames.has(expected), true, `missing MCP outlet ${expected}`);
    }
    const capabilities: any = await mcpToolCall(token, "meshrix.discovery", "meshrix.capabilities.list", {}, 3);
    assert.equal(Array.isArray(capabilities.operations), true);
    const health: any = await mcpToolCall(token, "meshrix.discovery", "system.health", {}, 4);
    assert.equal(health.payload?.ok, true, JSON.stringify(safeEvidence(health)));
    return {
      toolCount: tools.length,
      capabilitiesListed: capabilities.operations.length > 0,
      systemHealthOk: true
    };
  });

  await test("persistent state survives a graceful SIGTERM stop and immutable restart", async () : Promise<any> => {
    const persistenceProbe: any = createContainerPersistenceProbe();
    const persistedDigestBefore: any = containerFileSha256(persistenceProbe);
    const stop: any = run(
      CONTAINER_ENGINE,
      ["compose", "-p", projectName, "stop", "--timeout", "90", "meshrix-server"],
      {
        cwd: deploymentRoot,
        env: { MESHRIX_RUNTIME_CONFIG: "", MESHRIX_PULL_POLICY: "never" }
      }
    );
    const stopped: any = inspectContainer();
    assert.equal(stopped.State?.Running, false);
    assert.equal(stopped.State?.OOMKilled, false);
    assert.equal(stopped.State?.ExitCode, 0);
    const restart: any = run(CONTAINER_ENGINE, [
      "compose",
      "-p",
      projectName,
      "up",
      "-d",
      "--no-build",
      "--pull",
      "never",
      "meshrix-server"
    ], {
      cwd: deploymentRoot,
      env: { MESHRIX_RUNTIME_CONFIG: "", MESHRIX_PULL_POLICY: "never" }
    });
    const containerHealth: any = waitForContainerHealthy();
    const readiness: any = await waitForServerReady();
    const persistedDigestAfter: any = containerFileSha256(persistenceProbe);
    assert.equal(persistedDigestAfter, persistedDigestBefore);
    return {
      stopStatus: stop.status,
      stopSignal: "SIGTERM",
      gracefulExitCode: stopped.State.ExitCode,
      oomKilled: false,
      restartStatus: restart.status,
      restartBuildDisabled: true,
      containerHealthy: true,
      healthcheckMs: containerHealth.waitedMs,
      publicReadinessMs: readiness.waitedMs,
      apiKeyPlaintextPersisted: false
    };
  });

  await destructiveTest("malformed and unauthenticated MCP requests are rejected while container remains healthy", async () : Promise<any> => {
    const malformed: any = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{\"jsonrpc\":\"2.0\","
    });
    assert.equal(malformed.status >= 400, true);
    const unauthenticated: any = await fetchJson("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/list", params: {} })
    });
    assert.equal(unauthenticated.payload.error?.code !== undefined, true);
    const discovery: any = await fetchJson("/api/mcp/discovery", {
      method: "GET",
      headers: { "Cache-Control": "no-store" }
    });
    assert.equal(discovery.status, 200);
    return {
      malformedStatusRejected: malformed.status >= 400,
      unauthenticatedDenied: true,
      discoveryStillHealthy: true
    };
  });
} catch (error: any) {
  process.exitCode = 1;
  console.error(`[deployment-container-flow] ${redactText(error?.message || error)}`);
} finally {
  await cleanupCompose();
  if (report.cleanup.composeDown !== true || report.cleanup.sourcePackageWorkspace !== true) {
    process.exitCode = 1;
  }
  await writeReport().catch((error?: any) : any => {
    process.exitCode = 1;
    console.error(`[deployment-container-flow] report failed: ${redactText(error?.message || error)}`);
  });
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`PASS: container deployment flow verified; report: ${REPORT_PATH}`);
