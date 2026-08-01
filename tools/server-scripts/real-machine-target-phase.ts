#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const repoRoot: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHA256_PATTERN: any = /^sha256:[a-f0-9]{64}$/u;
const GIT_COMMIT_PATTERN: any = /^[a-f0-9]{40}$/u;
const SAFE_ID_PATTERN: any = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const DOCKER_TARGETS: any = new Set<any>([
  "native-linux-x64",
  "native-linux-arm64",
  "public-cloud-single-node",
  "clean-host-recovery",
]);
const PORTABLE_TARGETS: any = new Set<any>([
  "native-macos-arm64",
  "native-windows-x64",
]);
const PORTABLE_CHILD_ARGUMENT: any = "--portable-child";
const PORTABLE_HANDLE_SCHEMA: any = "v0.0.1:real-machine:portable-handle-1";

function fail(code?: any) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  throw error;
}

function requireCondition(condition?: any, code?: any) : any {
  if (!condition) fail(code);
}

function requiredEnv(name?: any, pattern: any = null) : any {
  const value: any = String(process.env[name] || "").trim();
  requireCondition(value && (!pattern || pattern.test(value)), `real_machine_${name.toLowerCase()}_required`);
  return value;
}

function context() : any {
  const target: any = requiredEnv("MESHRIX_REAL_MACHINE_TARGET");
  const phase: any = String(process.argv[2] || "").trim();
  const declaredTarget: any = String(process.argv[3] || "").trim();
  const platform: any = requiredEnv("MESHRIX_REAL_MACHINE_PLATFORM");
  const architecture: any = requiredEnv("MESHRIX_REAL_MACHINE_ARCHITECTURE");
  const candidateDigest: any = requiredEnv(
    "MESHRIX_REAL_MACHINE_CANDIDATE_DIGEST",
    SHA256_PATTERN,
  );
  const sourceRevision: any = requiredEnv(
    "MESHRIX_REAL_MACHINE_SOURCE_REVISION",
    GIT_COMMIT_PATTERN,
  );
  const runId: any = requiredEnv("MESHRIX_REAL_MACHINE_RUN_ID", SAFE_ID_PATTERN);
  const environmentId: any = requiredEnv(
    "MESHRIX_REAL_MACHINE_ENVIRONMENT_ID",
    SAFE_ID_PATTERN,
  );
  requireCondition(target === declaredTarget, "real_machine_target_command_mismatch");
  requireCondition(
    ["prepare", "start", "verify", "stop", "cleanup"].includes(phase),
    "real_machine_target_phase_invalid",
  );
  return Object.freeze({
    phase,
    target,
    platform,
    architecture,
    candidateDigest,
    sourceRevision,
    runId,
    environmentId,
  });
}

async function run(executable?: any, args?: any, {
  cwd = repoRoot,
  env = process.env,
  timeoutMs = 15 * 60_000,
  acceptedExitCodes = [0],
}: Record<string, any> = {}) : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(executable, args, {
      cwd,
      env,
      stdio: "ignore",
      windowsHide: true,
    });
    let timedOut: any = false;
    let forceTimer: any;
    const timer: any = setTimeout(() : any => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() : any => child.kill("SIGKILL"), 5_000);
      forceTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.once("error", reject);
    child.once("close", (exitCode?: any) : any => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (timedOut) {
        reject(Object.assign(new Error("real_machine_target_command_timeout"), {
          code: "real_machine_target_command_timeout",
        }));
      } else if (!acceptedExitCodes.includes(exitCode)) {
        reject(Object.assign(new Error("real_machine_target_command_failed"), {
          code: "real_machine_target_command_failed",
        }));
      } else {
        resolve(exitCode);
      }
    });
  });
}

async function output(executable?: any, args?: any, options: Record<string, any> = {}) : Promise<any> {
  const chunks: any[] = [];
  const maxOutputBytes: any = options.maxOutputBytes || 1024 * 1024;
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(executable, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let timedOut: any = false;
    let forceTimer: any;
    const timer: any = setTimeout(() : any => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() : any => child.kill("SIGKILL"), 5_000);
      forceTimer.unref?.();
    }, options.timeoutMs || 60_000);
    timer.unref?.();
    let bytes: any = 0;
    child.stdout.on("data", (chunk?: any) : any => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        child.kill("SIGKILL");
        reject(new Error("real_machine_target_output_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", (error?: any) : any => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      reject(error);
    });
    child.once("close", (exitCode?: any) : any => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (timedOut) {
        reject(new Error("real_machine_target_command_timeout"));
      } else if (exitCode !== 0) {
        reject(new Error("real_machine_target_command_failed"));
      } else {
        resolve(Buffer.concat(chunks).toString("utf8").trim());
      }
    });
  });
}

async function fileSha256(filePath?: any) : Promise<any> {
  const hash: any = crypto.createHash("sha256");
  const handle: any = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return `sha256:${hash.digest("hex")}`;
}

async function writePrivateJsonAtomic(filePath?: any, value?: any) : Promise<any> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath: any = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temporaryPath, filePath);
}

async function readJson(filePath?: any, code?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    fail(code);
  }
}

function portableTargetRoot() : any {
  const configured: any = String(
    process.env.MESHRIX_REAL_MACHINE_TARGET_ROOT || "",
  ).trim();
  const root: any = configured || path.join(
    String(process.env.RUNNER_TEMP || os.tmpdir()),
    "meshrix-real-machine-target",
  );
  requireCondition(path.isAbsolute(root), "real_machine_target_root_invalid");
  return path.resolve(root);
}

function portablePaths(ctx?: any) : any {
  const workspace: any = path.join(
    portableTargetRoot(),
    `${ctx.target}-${ctx.runId}`,
  );
  return Object.freeze({
    workspace,
    extracted: path.join(workspace, "candidate"),
    home: path.join(workspace, "home"),
    temporary: path.join(workspace, "tmp"),
    handle: path.join(workspace, "handle.json"),
    health: path.join(workspace, "health.json"),
    stopRequest: path.join(workspace, "stop.request"),
    stopped: path.join(workspace, "stopped.json"),
  });
}

async function assertSafeExtractedTree(root?: any) : Promise<any> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const childPath: any = path.join(root, entry.name);
    const stat: any = await fs.lstat(childPath);
    requireCondition(
      !stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()),
      "real_machine_portable_extracted_entry_invalid",
    );
    if (stat.isDirectory()) await assertSafeExtractedTree(childPath);
  }
}

function assertSafeArchiveListing(listing?: any) : any {
  const entries: any = String(listing || "")
    .split(/\r?\n/u)
    .filter(Boolean);
  requireCondition(entries.length > 0, "real_machine_portable_archive_empty");
  for (const entry of entries) {
    const portable: any = entry.replaceAll("\\", "/");
    requireCondition(
      !portable.startsWith("/") &&
        !/^[a-z]:\//iu.test(portable) &&
        !portable.split("/").includes("..") &&
        !portable.includes("\u0000"),
      "real_machine_portable_archive_path_invalid",
    );
  }
}

function assertArchiveContainsOnlyFilesAndDirectories(listing?: any) : any {
  const entries: any = String(listing || "")
    .split(/\r?\n/u)
    .filter(Boolean);
  requireCondition(entries.length > 0, "real_machine_portable_archive_empty");
  for (const entry of entries) {
    requireCondition(
      entry.startsWith("-") || entry.startsWith("d"),
      "real_machine_portable_archive_entry_type_invalid",
    );
  }
}

async function findPortableEntry(root?: any, target?: any) : Promise<any> {
  const desired: any = target === "native-windows-x64"
    ? ["meshrix-mcp-install.ps1"]
    : ["meshrix-mcp"];
  const matches: any[] = [];
  async function visit(directory?: any) : Promise<any> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const childPath: any = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(childPath);
      } else if (entry.isFile() && desired.includes(entry.name)) {
        matches.push(childPath);
      }
    }
  }
  await visit(root);
  requireCondition(matches.length === 1, "real_machine_portable_entry_invalid");
  return matches[0];
}

function portableCandidateCommand(target?: any, entry?: any) : any {
  return target === "native-windows-x64"
    ? Object.freeze({
        executable: "pwsh",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          entry,
          "-Command",
          "version",
          "-Json",
        ],
      })
    : Object.freeze({
        executable: entry,
        args: ["version", "--json"],
      });
}

async function processAlive(pid?: any) : Promise<any> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath?: any, timeoutMs?: any, code?: any) : Promise<any> {
  const deadline: any = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.access(filePath).then(() : any => true, () : any => false)) return;
    await new Promise((resolve?: any) : any => setTimeout(resolve, 100));
  }
  fail(code);
}

async function portableChild(argv?: any) : Promise<any> {
  const [workspace, target, candidateDigest] = argv;
  requireCondition(
    path.isAbsolute(workspace) &&
      PORTABLE_TARGETS.has(target) &&
      SHA256_PATTERN.test(String(candidateDigest || "")),
    "real_machine_portable_child_arguments_invalid",
  );
  const selected: any = portablePaths({
    target,
    runId: path.basename(workspace).slice(target.length + 1),
  });
  requireCondition(
    selected.workspace === path.resolve(workspace),
    "real_machine_portable_child_workspace_invalid",
  );
  const entry: any = await findPortableEntry(selected.extracted, target);
  const command: any = portableCandidateCommand(target, entry);
  await run(command.executable, command.args, {
    cwd: path.dirname(entry),
    env: {
      ...process.env,
      HOME: selected.home,
      USERPROFILE: selected.home,
      XDG_CONFIG_HOME: path.join(selected.home, ".config"),
      TMPDIR: selected.temporary,
      MESHRIX_MCP_TOKEN: "",
      MESHRIX_TOOL_TOKEN: "",
    },
    timeoutMs: 60_000,
  });
  await writePrivateJsonAtomic(selected.health, {
    schemaVersion: PORTABLE_HANDLE_SCHEMA,
    candidateDigest,
    candidateEntryExecuted: true,
    supervisorPid: process.pid,
  });
  while (!await fs.access(selected.stopRequest).then(() : any => true, () : any => false)) {
    await new Promise((resolve?: any) : any => setTimeout(resolve, 100));
  }
  await writePrivateJsonAtomic(selected.stopped, {
    schemaVersion: PORTABLE_HANDLE_SCHEMA,
    candidateDigest,
    stoppedGracefully: true,
  });
}

function dockerContext(ctx?: any) : any {
  const repositoryOwner: any = String(process.env.GITHUB_REPOSITORY_OWNER || "")
    .trim()
    .toLowerCase();
  const candidateImage: any = String(
    process.env.MESHRIX_REAL_MACHINE_CANDIDATE_IMAGE ||
      (repositoryOwner
        ? `ghcr.io/${repositoryOwner}/meshrix@${ctx.candidateDigest}`
        : ""),
  ).trim();
  requireCondition(
    candidateImage.endsWith(`@${ctx.candidateDigest}`) &&
      !candidateImage.includes(" "),
    "real_machine_candidate_image_mismatch",
  );
  const project: any = `meshrix-rm-${ctx.runId}`;
  const container: any = `meshrix-rm-${ctx.runId}`;
  const composeArgs: any[] = [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.enterprise.yml",
    "-p",
    project,
  ];
  const env: Record<string, any> = {
    ...process.env,
    MESHRIX_IMAGE_NAME: candidateImage,
    MESHRIX_PULL_POLICY: "never",
    MESHRIX_CONTAINER_NAME: container,
  };
  return Object.freeze({
    candidateImage,
    project,
    container,
    composeArgs,
    env,
  });
}

async function waitForDockerHealth(container?: any, timeoutMs: any = 120_000) : Promise<any> {
  const deadline: any = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status: any = await output("docker", [
      "inspect",
      "--format",
      "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
      container,
    ]).catch(() : any => "");
    if (status === "running healthy") return;
    await new Promise((resolve?: any) : any => setTimeout(resolve, 1_000));
  }
  fail("real_machine_container_health_timeout");
}

async function verifyDockerHardening(ctx?: any, selected?: any) : Promise<any> {
  const inspection: any = JSON.parse(await output("docker", [
    "inspect",
    selected.container,
  ]));
  const [container] = inspection;
  requireCondition(container?.State?.Running === true, "real_machine_container_not_running");
  requireCondition(
    container?.State?.Health?.Status === "healthy",
    "real_machine_container_not_healthy",
  );
  requireCondition(
    container?.Config?.User === "10001:10001",
    "real_machine_container_user_invalid",
  );
  requireCondition(
    container?.HostConfig?.ReadonlyRootfs === true,
    "real_machine_container_rootfs_not_readonly",
  );
  requireCondition(
    container?.HostConfig?.CapDrop?.includes("ALL") === true,
    "real_machine_container_capabilities_invalid",
  );
  requireCondition(
    container?.HostConfig?.SecurityOpt?.includes("no-new-privileges:true") === true,
    "real_machine_container_security_options_invalid",
  );
  requireCondition(
    container?.HostConfig?.SecurityOpt?.some((entry?: any) : any =>
      String(entry).includes("seccomp=unconfined")) !== true,
    "real_machine_container_seccomp_unconfined",
  );
  requireCondition(
    Array.isArray(container?.Mounts) &&
      container.Mounts.some((mount?: any) : any => mount.Destination === "/app/data") &&
      container.Mounts.some((mount?: any) : any => mount.Destination === "/app/backups"),
    "real_machine_container_persistent_mounts_missing",
  );
  const imageArchitecture: any = await output("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Architecture}}",
    selected.candidateImage,
  ]);
  const expectedDockerArchitecture: any = ctx.architecture === "x64" ? "amd64" : "arm64";
  requireCondition(
    imageArchitecture === expectedDockerArchitecture,
    "real_machine_candidate_architecture_mismatch",
  );
  await run("docker", [
    "exec",
    selected.container,
    "node",
    "-e",
    "const fs=require('node:fs');const v=fs.readFileSync('/proc/1/cgroup','utf8').trim();if(!v)process.exit(1)",
  ], { timeoutMs: 30_000 });
}

function publicHealthUrl() : any {
  const baseUrl: any = requiredEnv("MESHRIX_PUBLIC_BASE_URL");
  try {
    const parsed: any = new URL(baseUrl);
    requireCondition(parsed.protocol === "https:", "real_machine_public_url_invalid");
    return new URL("/api/healthz", parsed);
  } catch {
    fail("real_machine_public_url_invalid");
  }
}

async function publicHealthProbe() : Promise<any> {
  const healthUrl: any = publicHealthUrl();
  const response: any = await fetch(healthUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() : any => null);
  requireCondition(response?.ok === true, "real_machine_public_health_failed");
}

function requiredPublicUrl(name?: any) : any {
  const value: any = requiredEnv(name);
  let selected: any;
  try {
    selected = new URL(value);
  } catch {
    fail("real_machine_public_probe_url_invalid");
  }
  requireCondition(
    selected.protocol === "https:" &&
      !selected.username &&
      !selected.password,
    "real_machine_public_probe_url_invalid",
  );
  return selected;
}

async function tlsCertificateDigest(url?: any) : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    const socket: any = tls.connect({
      host: url.hostname,
      port: Number(url.port || 443),
      servername: url.hostname,
      rejectUnauthorized: true,
    });
    const timer: any = setTimeout(() : any => {
      socket.destroy();
      reject(new Error("real_machine_public_tls_timeout"));
    }, 15_000);
    timer.unref?.();
    socket.once("secureConnect", () : any => {
      clearTimeout(timer);
      const certificate: any = socket.getPeerCertificate(true);
      socket.end();
      if (!Buffer.isBuffer(certificate?.raw)) {
        reject(new Error("real_machine_public_certificate_missing"));
        return;
      }
      resolve(`sha256:${crypto.createHash("sha256").update(certificate.raw).digest("hex")}`);
    });
    socket.once("error", (error?: any) : any => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function remoteHeaders(tokenEnvName?: any) : any {
  const token: any = String(process.env[tokenEnvName] || "").trim();
  return token
    ? { authorization: `Bearer ${token}` }
    : {};
}

async function mcpProbe(url?: any, tokenEnvName?: any) : Promise<any> {
  const commonHeaders: Record<string, any> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...remoteHeaders(tokenEnvName),
  };
  const initialize: any = await fetch(url, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "real-machine-probe",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "meshrix-real-machine-probe", version: "0.0.1" },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() : any => null);
  requireCondition(initialize?.ok === true, "real_machine_remote_mcp_probe_failed");
  const sessionId: any = String(initialize.headers.get("mcp-session-id") || "").trim();
  const response: any = await fetch(url, {
    method: "POST",
    headers: {
      ...commonHeaders,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "real-machine-tools",
      method: "tools/list",
      params: {},
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() : any => null);
  requireCondition(response?.ok === true, "real_machine_remote_mcp_probe_failed");
  const text: any = await response.text();
  requireCondition(
    text.includes("result") || text.includes("event:"),
    "real_machine_remote_mcp_probe_invalid",
  );
}

async function publicCloudProbe() : Promise<any> {
  const healthUrl: any = publicHealthUrl();
  const agentMcpUrl: any = requiredPublicUrl(
    "MESHRIX_REAL_MACHINE_PUBLIC_AGENT_MCP_URL",
  );
  const upstreamHttpUrl: any = requiredPublicUrl(
    "MESHRIX_REAL_MACHINE_PUBLIC_UPSTREAM_HTTP_URL",
  );
  const upstreamMcpUrl: any = requiredPublicUrl(
    "MESHRIX_REAL_MACHINE_PUBLIC_UPSTREAM_MCP_URL",
  );
  const expectedCertificateDigest: any = requiredEnv(
    "MESHRIX_REAL_MACHINE_EXPECTED_CERT_SHA256",
    SHA256_PATTERN,
  );
  const addresses: any = await dns.lookup(healthUrl.hostname, { all: true });
  requireCondition(addresses.length > 0, "real_machine_public_dns_failed");
  requireCondition(
    await tlsCertificateDigest(healthUrl) === expectedCertificateDigest,
    "real_machine_public_certificate_mismatch",
  );
  await publicHealthProbe();
  const proxySpoof: any = await fetch(healthUrl, {
    headers: {
      "x-forwarded-host": "untrusted.invalid",
      "x-forwarded-proto": "http",
      "x-forwarded-for": "203.0.113.7",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  }).catch(() : any => null);
  requireCondition(
    proxySpoof?.ok === true &&
      !String(proxySpoof.headers.get("location") || "").includes("untrusted.invalid"),
    "real_machine_trusted_proxy_probe_failed",
  );
  const upstreamHttp: any = await fetch(upstreamHttpUrl, {
    headers: remoteHeaders("MESHRIX_REAL_MACHINE_PUBLIC_UPSTREAM_HTTP_TOKEN"),
    signal: AbortSignal.timeout(30_000),
  }).catch(() : any => null);
  requireCondition(upstreamHttp?.ok === true, "real_machine_remote_http_probe_failed");
  await mcpProbe(
    agentMcpUrl,
    "MESHRIX_REAL_MACHINE_PUBLIC_AGENT_MCP_TOKEN",
  );
  await mcpProbe(
    upstreamMcpUrl,
    "MESHRIX_REAL_MACHINE_PUBLIC_UPSTREAM_MCP_TOKEN",
  );
  const faultUrl: any = requiredPublicUrl(
    "MESHRIX_REAL_MACHINE_PUBLIC_FAULT_URL",
  );
  const faultResponse: any = await fetch(faultUrl, {
    signal: AbortSignal.timeout(2_000),
  }).catch(() : any => null);
  requireCondition(
    faultResponse === null || faultResponse.status >= 500,
    "real_machine_network_fault_probe_not_observed",
  );
  const capacityRequests: any = Number(
    process.env.MESHRIX_REAL_MACHINE_CAPACITY_REQUESTS || 20,
  );
  requireCondition(
    Number.isInteger(capacityRequests) &&
      capacityRequests >= 1 &&
      capacityRequests <= 100,
    "real_machine_capacity_request_count_invalid",
  );
  const capacityStartedAt: any = Date.now();
  const capacityResults: any = await Promise.all(
    Array.from({ length: capacityRequests }, () : any =>
      fetch(healthUrl, {
        signal: AbortSignal.timeout(15_000),
      }).then((response?: any) : any => response.ok, () : any => false)),
  );
  requireCondition(
    capacityResults.every(Boolean) && Date.now() - capacityStartedAt <= 60_000,
    "real_machine_capacity_probe_failed",
  );
}

async function dockerPhase(ctx?: any) : Promise<any> {
  const selected: any = dockerContext(ctx);
  if (ctx.phase === "prepare") {
    await run("docker", ["info"], { timeoutMs: 30_000 });
    const imagePresent: any = await run("docker", [
      "image",
      "inspect",
      selected.candidateImage,
    ]).then(() : any => true, () : any => false);
    if (!imagePresent && process.env.MESHRIX_REAL_MACHINE_ALLOW_PULL !== "0") {
      await run("docker", ["pull", selected.candidateImage], {
        timeoutMs: 30 * 60_000,
      });
    } else if (!imagePresent) {
      fail("real_machine_candidate_image_not_loaded");
    }
    await run("docker", [...selected.composeArgs, "config", "--quiet"], {
      env: selected.env,
    });
    if (ctx.target === "public-cloud-single-node") {
      publicHealthUrl();
      requiredPublicUrl("MESHRIX_REAL_MACHINE_PUBLIC_AGENT_MCP_URL");
      requiredPublicUrl("MESHRIX_REAL_MACHINE_PUBLIC_UPSTREAM_HTTP_URL");
      requiredPublicUrl("MESHRIX_REAL_MACHINE_PUBLIC_UPSTREAM_MCP_URL");
      requiredPublicUrl("MESHRIX_REAL_MACHINE_PUBLIC_FAULT_URL");
      requiredEnv(
        "MESHRIX_REAL_MACHINE_EXPECTED_CERT_SHA256",
        SHA256_PATTERN,
      );
    }
    if (ctx.target === "clean-host-recovery") {
      const backupInput: any = requiredEnv("MESHRIX_REAL_MACHINE_BACKUP_INPUT");
      const backupStat: any = await fs.lstat(backupInput).catch(() : any => null);
      requireCondition(
        path.isAbsolute(backupInput) &&
          backupStat?.isDirectory() &&
          !backupStat.isSymbolicLink(),
        "real_machine_backup_input_invalid",
      );
      const manifest: any = path.join(backupInput, "backup-manifest.json");
      const manifestStat: any = await fs.lstat(manifest).catch(() : any => null);
      requireCondition(
        manifestStat?.isFile() && !manifestStat.isSymbolicLink(),
        "real_machine_backup_manifest_invalid",
      );
    }
    return;
  }
  if (ctx.phase === "start") {
    await run("docker", [
      ...selected.composeArgs,
      "up",
      "-d",
      "--no-build",
      "--pull",
      "never",
      "--wait",
      "meshrix-server",
    ], { env: selected.env, timeoutMs: 10 * 60_000 });
    await waitForDockerHealth(selected.container);
    return;
  }
  if (ctx.phase === "verify") {
    await waitForDockerHealth(selected.container);
    await verifyDockerHardening(ctx, selected);
    if (ctx.target === "public-cloud-single-node") {
      await publicCloudProbe();
    }
    if (ctx.target === "clean-host-recovery") {
      const backupInput: any = requiredEnv("MESHRIX_REAL_MACHINE_BACKUP_INPUT");
      const manifestPath: any = path.join(backupInput, "backup-manifest.json");
      const manifest: any = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const backupId: any = String(manifest?.backupId || "");
      requireCondition(
        /^backup_[A-Za-z0-9_.-]+$/u.test(backupId),
        "real_machine_backup_manifest_invalid",
      );
      await run("docker", [
        "exec",
        selected.container,
        "mkdir",
        "-p",
        `/app/backups/${backupId}`,
      ]);
      await run("docker", [
        "cp",
        `${backupInput}${path.sep}.`,
        `${selected.container}:/app/backups/${backupId}`,
      ], { timeoutMs: 10 * 60_000 });
      await run("docker", ["stop", "--time", "90", selected.container], {
        timeoutMs: 100_000,
      });
      const restoreScript: any = [
        "import {restoreStorageBackup} from './packages/foundation/src/storage/restore-execution.ts';",
        "const backupId=process.env.MESHRIX_REAL_MACHINE_BACKUP_ID;",
        "const preview=await restoreStorageBackup({userDataPath:'/app/data',backupId,dryRun:true});",
        "if(preview?.summary?.blocked)process.exit(2);",
        "const applied=await restoreStorageBackup({userDataPath:'/app/data',backupId,dryRun:false,apply:true});",
        "if(applied?.applied!==true||applied?.integrity?.verified!==true)process.exit(3);",
      ].join("");
      await run("docker", [
        ...selected.composeArgs,
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "node",
        "-e",
        "MESHRIX_REAL_MACHINE_BACKUP_ID",
        "meshrix-server",
        "--input-type=module",
        "-e",
        restoreScript,
      ], {
        env: {
          ...selected.env,
          MESHRIX_REAL_MACHINE_BACKUP_ID: backupId,
        },
        timeoutMs: 30 * 60_000,
      });
      await run("docker", [
        ...selected.composeArgs,
        "up",
        "-d",
        "--no-build",
        "--pull",
        "never",
        "--wait",
        "meshrix-server",
      ], { env: selected.env, timeoutMs: 10 * 60_000 });
      await waitForDockerHealth(selected.container);
    }
    await run("docker", ["restart", "--time", "90", selected.container], {
      timeoutMs: 120_000,
    });
    await waitForDockerHealth(selected.container);
    await verifyDockerHardening(ctx, selected);
    return;
  }
  if (ctx.phase === "stop") {
    const startedAt: any = Date.now();
    await run("docker", ["stop", "--time", "90", selected.container], {
      timeoutMs: 100_000,
      acceptedExitCodes: [0, 1],
    });
    requireCondition(
      Date.now() - startedAt <= 100_000,
      "real_machine_container_stop_unbounded",
    );
    const running: any = await output("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      selected.container,
    ]).catch(() : any => "false");
    requireCondition(running === "false", "real_machine_container_stop_failed");
    return;
  }
  await run("docker", [...selected.composeArgs, "down", "--remove-orphans"], {
    env: selected.env,
    timeoutMs: 5 * 60_000,
    acceptedExitCodes: [0],
  });
}

async function portableContext(ctx?: any) : Promise<any> {
  const artifact: any = requiredEnv("MESHRIX_REAL_MACHINE_CANDIDATE_ARTIFACT");
  requireCondition(path.isAbsolute(artifact), "real_machine_candidate_artifact_invalid");
  const stat: any = await fs.lstat(artifact).catch(() : any => null);
  requireCondition(
    stat?.isFile() && !stat.isSymbolicLink(),
    "real_machine_candidate_artifact_invalid",
  );
  requireCondition(
    await fileSha256(artifact) === ctx.candidateDigest,
    "real_machine_candidate_artifact_mismatch",
  );
  return Object.freeze({ artifact, ...portablePaths(ctx) });
}

async function portablePhase(ctx?: any) : Promise<any> {
  const selected: any = await portableContext(ctx);
  if (ctx.phase === "prepare") {
    requireCondition(
      !await fs.access(selected.workspace).then(() : any => true, () : any => false),
      "real_machine_portable_workspace_exists",
    );
    await fs.mkdir(selected.extracted, { recursive: true, mode: 0o700 });
    await Promise.all([
      fs.mkdir(selected.home, { recursive: true, mode: 0o700 }),
      fs.mkdir(selected.temporary, { recursive: true, mode: 0o700 }),
    ]);
    try {
      const listing: any = await output("tar", ["-tf", selected.artifact], {
        timeoutMs: 5 * 60_000,
        maxOutputBytes: 32 * 1024 * 1024,
      });
      assertSafeArchiveListing(listing);
      const verboseListing: any = await output("tar", ["-tvf", selected.artifact], {
        timeoutMs: 5 * 60_000,
        maxOutputBytes: 64 * 1024 * 1024,
      });
      assertArchiveContainsOnlyFilesAndDirectories(verboseListing);
      await run("tar", [
        "-xf",
        selected.artifact,
        "-C",
        selected.extracted,
      ], { timeoutMs: 5 * 60_000 });
      await assertSafeExtractedTree(selected.extracted);
      await findPortableEntry(selected.extracted, ctx.target);
    } catch (error: any) {
      await fs.rm(selected.workspace, { recursive: true, force: true });
      throw error;
    }
    return;
  }
  if (ctx.phase === "start") {
    requireCondition(
      await fs.access(selected.extracted).then(() : any => true, () : any => false),
      "real_machine_portable_workspace_missing",
    );
    requireCondition(
      !await fs.access(selected.handle).then(() : any => true, () : any => false),
      "real_machine_portable_already_started",
    );
    const child: any = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      PORTABLE_CHILD_ARGUMENT,
      selected.workspace,
      ctx.target,
      ctx.candidateDigest,
    ], {
      cwd: repoRoot,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    await writePrivateJsonAtomic(selected.handle, {
      schemaVersion: PORTABLE_HANDLE_SCHEMA,
      candidateDigest: ctx.candidateDigest,
      supervisorPid: child.pid,
    });
    await waitForFile(
      selected.health,
      60_000,
      "real_machine_portable_start_timeout",
    );
    const health: any = await readJson(
      selected.health,
      "real_machine_portable_health_invalid",
    );
    requireCondition(
      health.schemaVersion === PORTABLE_HANDLE_SCHEMA &&
        health.candidateDigest === ctx.candidateDigest &&
        health.candidateEntryExecuted === true &&
        health.supervisorPid === child.pid &&
        await processAlive(child.pid),
      "real_machine_portable_start_failed",
    );
    return;
  }
  if (ctx.phase === "verify") {
    const handle: any = await readJson(
      selected.handle,
      "real_machine_portable_handle_invalid",
    );
    const health: any = await readJson(
      selected.health,
      "real_machine_portable_health_invalid",
    );
    requireCondition(
      handle.schemaVersion === PORTABLE_HANDLE_SCHEMA &&
        handle.candidateDigest === ctx.candidateDigest &&
        health.schemaVersion === PORTABLE_HANDLE_SCHEMA &&
        health.candidateDigest === ctx.candidateDigest &&
        health.candidateEntryExecuted === true &&
        handle.supervisorPid === health.supervisorPid &&
        await processAlive(handle.supervisorPid),
      "real_machine_portable_not_running",
    );
  }
  if (ctx.phase === "verify" && ctx.target === "native-macos-arm64") {
    const inputDir: any = requiredEnv("MESHRIX_REAL_MACHINE_PORTABLE_INPUT_DIR");
    const stat: any = await fs.lstat(inputDir).catch(() : any => null);
    requireCondition(
      path.isAbsolute(inputDir) && stat?.isDirectory() && !stat.isSymbolicLink(),
      "real_machine_portable_input_invalid",
    );
    const reportPath: any = path.join(
      repoRoot,
      "build",
      "reports",
      "real-machine",
      `${ctx.runId}-macos-arm64.json`,
    );
    await fs.mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
    await fs.rm(reportPath, { force: true });
    await run(process.execPath, [
      "tools/server-scripts/verify-mcp-final-release-asset.ts",
      "--input-dir",
      inputDir,
      "--report-path",
      reportPath,
    ], { timeoutMs: 10 * 60_000 });
    return;
  }
  if (ctx.phase === "verify") {
    const installer: any = path.join(
      selected.extracted,
      path.relative(
        selected.extracted,
        await findPortableEntry(selected.extracted, ctx.target),
      ),
    );
    await run("pwsh", [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installer,
      "-Command",
      "version",
      "-Json",
    ], { timeoutMs: 5 * 60_000 });
    await run(process.execPath, [
      "tools/server-scripts/verify-npm-package-installability.ts",
      "--required-host-probe",
      "--report-path",
      path.join(
        "build",
        "reports",
        "real-machine",
        `${ctx.runId}-windows-x64.json`,
      ),
    ], { timeoutMs: 20 * 60_000 });
    await run(process.execPath, [
      "tools/server-scripts/verify-mcp-windows-process-identity-credential-store.ts",
    ], { timeoutMs: 5 * 60_000 });
    return;
  }
  if (ctx.phase === "stop") {
    const handle: any = await readJson(
      selected.handle,
      "real_machine_portable_handle_invalid",
    );
    requireCondition(
      handle.schemaVersion === PORTABLE_HANDLE_SCHEMA &&
        handle.candidateDigest === ctx.candidateDigest,
      "real_machine_portable_handle_invalid",
    );
    if (await processAlive(handle.supervisorPid)) {
      await fs.writeFile(selected.stopRequest, "", {
        encoding: "utf8",
        mode: 0o600,
        flag: "a",
      });
      await waitForFile(
        selected.stopped,
        30_000,
        "real_machine_portable_stop_timeout",
      );
      const deadline: any = Date.now() + 30_000;
      while (await processAlive(handle.supervisorPid) && Date.now() < deadline) {
        await new Promise((resolve?: any) : any => setTimeout(resolve, 100));
      }
    }
    const stopped: any = await readJson(
      selected.stopped,
      "real_machine_portable_stop_invalid",
    );
    requireCondition(
      stopped.schemaVersion === PORTABLE_HANDLE_SCHEMA &&
        stopped.candidateDigest === ctx.candidateDigest &&
        stopped.stoppedGracefully === true &&
        !await processAlive(handle.supervisorPid),
      "real_machine_portable_stop_failed",
    );
    return;
  }
  if (ctx.phase === "cleanup") {
    if (!await fs.access(selected.workspace).then(() : any => true, () : any => false)) {
      return;
    }
    const handle: any = await readJson(
      selected.handle,
      "real_machine_portable_handle_invalid",
    );
    requireCondition(
      handle.candidateDigest === ctx.candidateDigest &&
        !await processAlive(handle.supervisorPid),
      "real_machine_portable_cleanup_running",
    );
    await fs.rm(selected.workspace, { recursive: true, force: true });
  }
}

async function main() : Promise<any> {
  if (process.argv[2] === PORTABLE_CHILD_ARGUMENT) {
    await portableChild(process.argv.slice(3));
    return;
  }
  const ctx: any = context();
  if (DOCKER_TARGETS.has(ctx.target)) {
    requireCondition(ctx.platform === "linux", "real_machine_target_platform_mismatch");
    await dockerPhase(ctx);
  } else if (PORTABLE_TARGETS.has(ctx.target)) {
    await portablePhase(ctx);
  } else {
    fail("real_machine_target_invalid");
  }
}

main().catch((error?: any) : any => {
  process.stderr.write(`${String(error?.code || error?.message || "real_machine_target_phase_failed")}\n`);
  process.exitCode = 1;
});
