#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_REPORT_PATH,
  MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_SCHEMA_VERSION,
  MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_VERIFIER,
  createMcpProcessIdentityCredentialStoreReadiness,
  currentPlatformSystemBackends
} from "./lib/mcp-process-identity-credential-store-evidence.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function resolveRepositoryRoot() : any {
  const acceptanceRoot: any = String(process.env.MESHRIX_ACCEPTANCE_REPOSITORY_ROOT || "").trim();
  if (acceptanceRoot) {
    return path.resolve(acceptanceRoot);
  }
  const gitDir: any = String(process.env.GIT_DIR || "").trim();
  if (gitDir) {
    return path.dirname(gitDir);
  }
  return repoRoot;
}
const protocolInstaller: any = "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts";
const nativeInstaller: any = "packages/protocols/mcp/adapter/native-installer/meshrix-mcp-install.sh";
const reportPath: any = path.join(repoRoot, MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_REPORT_PATH);

function redactText(value: any = "") : any {
  return String(value || "")
    .split(repoRoot).join("[redacted-path]")
    .split(os.homedir()).join("[redacted-path]")
    .replace(/(?:\/Users\/|\/private\/|\/var\/folders\/)[^\s"'`]+/gu, "[redacted-path]")
    .replace(/verify-private-key-[A-Za-z0-9_-]+/gu, "verify-private-key-[redacted]");
}

function assertNoLeak(value?: any, label?: any) : any {
  const text: any = JSON.stringify(value);
  assert.equal(text.includes(repoRoot), false, `${label} leaked repo path`);
  assert.equal(text.includes(os.homedir()), false, `${label} leaked home path`);
  assert.equal(/verify-private-key-[A-Za-z0-9_-]+/u.test(text), false, `${label} leaked self-test secret`);
}

function parseJsonOutput(stdout: any = "") : any {
  const text: any = String(stdout || "").trim();
  const start: any = text.indexOf("{");
  assert.notEqual(start, -1, "self-test output did not contain JSON");
  return JSON.parse(text.slice(start));
}

function runNodeSelfTest({ target, store, timeoutMs = 30000 }: Record<string, any> = {}) : any {
  const result: any = spawnSync(process.execPath, [
    protocolInstaller,
    "identity-store-self-test",
    "--target", target,
    "--json"
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MESHRIX_MCP_PROCESS_IDENTITY_STORE: store
    },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(redactText(`${result.stderr || ""}\n${result.stdout || ""}`).slice(-2000));
  }
  const payload: any = parseJsonOutput(result.stdout);
  assert.equal(payload.ok, true);
  assertNoLeak(payload, `${store} self-test`);
  return payload;
}

function runExplicitSystemNoFileFallbackSelfTest({ timeoutMs = 30000 }: Record<string, any> = {}) : any {
  const tempHome: any = fsSync.mkdtempSync(path.join(os.tmpdir(), "meshrix-mcp-pi-home-"));
  const script: any = `
    import { deleteProcessIdentity, loadProcessIdentity, saveProcessIdentity } from "./packages/protocols/mcp/adapter/gateway-installer/lib/process-identity-store.ts";
    const target = "verify-explicit-system-no-file-fallback";
    const marker = "verify-private-key-explicit-system-no-file-fallback";
    const record = {
      schemaVersion: "v0.0.1:process-identity:mcp-self-test-1",
      target,
      baseUrl: "http://127.0.0.1:0",
      savedAt: new Date().toISOString(),
      privateKeyPem: marker,
      clientIdentityPackage: {
        clientId: target,
        packageId: "pkg_explicit_system_no_file_fallback",
        processKey: { processKeyId: "pkey_explicit_system_no_file_fallback" },
        clientFingerprint: {
          fingerprintId: "fp_explicit_system_no_file_fallback",
          machineInstanceId: "machine_explicit_system_no_file_fallback",
          appInstanceId: "app_explicit_system_no_file_fallback",
          runtimeInstanceId: "runtime_explicit_system_no_file_fallback",
          fingerprintHash: "sha256:explicit-system-no-file-fallback"
        }
      }
    };
    process.env.MESHRIX_MCP_PROCESS_IDENTITY_STORE = "file";
    await deleteProcessIdentity(target);
    await saveProcessIdentity(target, record);
    process.env.MESHRIX_MCP_PROCESS_IDENTITY_STORE = "system";
    const systemLoaded = await loadProcessIdentity(target);
    process.env.MESHRIX_MCP_PROCESS_IDENTITY_STORE = "file";
    const fileLoaded = await loadProcessIdentity(target);
    await deleteProcessIdentity(target);
    console.log(JSON.stringify({
      ok: systemLoaded === null && fileLoaded?.storageBackend === "private-file-fallback",
      explicitSystemLoadNull: systemLoaded === null,
      fileFallbackStillExplicit: fileLoaded?.storageBackend === "private-file-fallback"
    }));
  `;
  try {
    const result: any = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: tempHome,
        MESHRIX_MCP_PROCESS_IDENTITY_STORE: "file"
      },
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024
    });
    if (result.status !== 0) {
      throw new Error(redactText(`${result.stderr || ""}\n${result.stdout || ""}`).slice(-2000));
    }
    const payload: any = parseJsonOutput(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.explicitSystemLoadNull, true);
    assert.equal(payload.fileFallbackStillExplicit, true);
    assertNoLeak(payload, "explicit system no file fallback self-test");
    return payload;
  } finally {
    fsSync.rmSync(tempHome, { recursive: true, force: true });
  }
}

function sleepSync(ms?: any) : any {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

function runDocker(args: any = [], { timeoutMs = 30000, allowFailure = false }: Record<string, any> = {}) : any {
  const result: any = spawnSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(redactText(`${result.stderr || ""}\n${result.stdout || ""}`).slice(-3000));
  }
  return result;
}

function linuxSecretServiceImageName() : any {
  return String(process.env.MESHRIX_MCP_PROCESS_IDENTITY_LINUX_IMAGE || "meshrix-mcp-secret-service-proof:node24-bookworm").trim();
}

function dockerImageExists(image?: any) : any {
  return runDocker(["image", "inspect", image], {
    timeoutMs: 30000,
    allowFailure: true
  }).status === 0;
}

function ensureLinuxSecretServiceImage() : any {
  const image: any = linuxSecretServiceImageName();
  if (dockerImageExists(image)) {
    return { image, built: false };
  }
  const dockerfile: any = [
    "FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203",
    "ENV DEBIAN_FRONTEND=noninteractive",
    "RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\",
    "  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\",
    "  apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update \\",
    "  && apt-get -o Dpkg::Use-Pty=0 -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends dbus-x11 libsecret-tools gnome-keyring",
    ""
  ].join("\n");
  const result: any = spawnSync("docker", ["build", "-t", image, "-"], {
    cwd: repoRoot,
    input: dockerfile,
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKER_BUILDKIT: process.env.DOCKER_BUILDKIT || "1"
    },
    timeout: Number(process.env.MESHRIX_MCP_PROCESS_IDENTITY_LINUX_IMAGE_BUILD_TIMEOUT_MS || 900000),
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(redactText(`Linux Secret Service proof image build failed with status=${result.status ?? ""} signal=${result.signal || ""}\n${result.error?.message || ""}\n${result.stderr || ""}\n${result.stdout || ""}`).slice(-3000));
  }
  return { image, built: true };
}

function waitForDockerDaemon({ timeoutMs = 120000, intervalMs = 2500 }: Record<string, any> = {}) : any {
  const started: any = Date.now();
  let lastError: any = "";
  let attempts: any = 0;
  while (Date.now() - started <= timeoutMs) {
    attempts += 1;
    const result: any = runDocker(["info", "--format", "{{json .ServerVersion}}"], {
      timeoutMs: 8000,
      allowFailure: true
    });
    if (result.status === 0) {
      return {
        ready: true,
        attempts,
        waitedMs: Date.now() - started
      };
    }
    lastError = redactText(`${result.stderr || ""}\n${result.stdout || ""}`).slice(-1000);
    sleepSync(intervalMs);
  }
  return {
    ready: false,
    attempts,
    waitedMs: Date.now() - started,
    error: lastError
  };
}

function runLinuxSecretServiceContainer() : any {
  const daemon: any = waitForDockerDaemon();
  if (daemon.ready !== true) {
    throw new Error(`Docker daemon did not become ready for Linux Secret Service portability proof: ${daemon.error}`);
  }
  const image: any = ensureLinuxSecretServiceImage();
  const containerTimeoutMs: any = Math.max(1000, Number(process.env.MESHRIX_MCP_PROCESS_IDENTITY_LINUX_CONTAINER_TIMEOUT_MS || 300000));
  const containerTimeoutSeconds: any = Math.max(1, Math.ceil(containerTimeoutMs / 1000));
  const script: any = [
    "set -eu",
    "command -v dbus-run-session >/dev/null",
    "command -v secret-tool >/dev/null",
    "command -v gnome-keyring-daemon >/dev/null",
    "dbus-run-session -- sh -lc 'printf pass | gnome-keyring-daemon --unlock >/dev/null 2>&1 || true; MESHRIX_MCP_PROCESS_IDENTITY_STORE=linux-secret-service node packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts identity-store-self-test --target verify-linux-secret-service --json'"
  ].join(" && ");
  const dockerRepoRoot: any = resolveRepositoryRoot();
  const result: any = spawnSync("docker", [
    "run",
    "--rm",
    "-v", `${dockerRepoRoot}:/work:ro`,
    "-w", "/work",
    image.image,
    "timeout",
    `${containerTimeoutSeconds}s`,
    "sh",
    "-lc",
    script
  ], {
    cwd: dockerRepoRoot,
    encoding: "utf8",
    timeout: containerTimeoutMs + 15000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    const exitSummary: any = result.status === 124
      ? `Linux Secret Service container proof timed out after ${containerTimeoutSeconds}s`
      : `Linux Secret Service container proof failed with status=${result.status ?? ""} signal=${result.signal || ""}`;
    throw new Error(redactText(`${exitSummary}\n${result.error?.message || ""}\n${result.stderr || ""}\n${result.stdout || ""}`).slice(-3000));
  }
  const payload: any = parseJsonOutput(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.storageBackend, "linux-secret-service");
  assert.equal(payload.systemCredential, true);
  assert.equal(payload.fileFallback, false);
  assertNoLeak(payload, "linux container secret service self-test");
  payload.containerImage = image.image;
  payload.containerImageBuilt = image.built;
  return payload;
}

let linuxSecretServiceContainerProof: any;
function controlledLinuxSecretServiceProof() : any {
  linuxSecretServiceContainerProof ||= runLinuxSecretServiceContainer();
  return linuxSecretServiceContainerProof;
}

await fs.mkdir(path.dirname(reportPath), { recursive: true });

const nativeInstallerSource: any = await fs.readFile(path.join(repoRoot, nativeInstaller), "utf8");

const tests: any[] = [];
function record(name?: any, fn?: any) : any {
  process.stdout.write(`[mcp-process-identity-store] ${name} ... `);
  try {
    const evidence: any = fn();
    tests.push({ name, status: "passed", evidence });
    console.log("ok");
  } catch (error: any) {
    tests.push({ name, status: "failed", evidence: { error: redactText(error?.message || String(error)) } });
    console.log("FAIL");
  }
}

record("native installer stays out of credential-store backend implementation", () : any => {
  assert.match(nativeInstallerSource, /gateway-installer\/bin\/meshrix-mcp\.ts/u);
  assert.equal(/\beval\b/u.test(nativeInstallerSource), false);
  assert.equal(nativeInstallerSource.includes("macos-keychain"), false);
  assert.equal(nativeInstallerSource.includes("linux-secret-service"), false);
  assert.equal(nativeInstallerSource.includes("windows-dpapi"), false);
  return {
    protocolInstaller,
    nativeInstaller,
    installerMode: "platform-native-launcher"
  };
});

record("private file fallback remains explicit and 0600 scoped", () : any => {
  const payload: any = runNodeSelfTest({
    target: "verify-file-fallback",
    store: "file"
  });
  assert.equal(payload.storageBackend, "private-file-fallback");
  assert.equal(payload.fileFallback, true);
  assert.equal(payload.fileModeChecked, true);
  return {
    storageBackend: payload.storageBackend,
    fileFallback: payload.fileFallback,
    fileModeChecked: payload.fileModeChecked
  };
});

record("explicit system mode does not read private file fallback", () : any => {
  const payload: any = runExplicitSystemNoFileFallbackSelfTest();
  return {
    explicitSystemLoadNull: payload.explicitSystemLoadNull,
    fileFallbackStillExplicit: payload.fileFallbackStillExplicit
  };
});

record("current platform system credential store is release-ready", () : any => {
  const expectedBackends: any = currentPlatformSystemBackends();
  assert.notEqual(expectedBackends.length, 0, `${process.platform} has no supported MCP process identity system credential backend`);
  const headlessLinux: any = process.platform === "linux" &&
    !String(process.env.DBUS_SESSION_BUS_ADDRESS || "").trim();
  const payload: any = headlessLinux
    ? controlledLinuxSecretServiceProof()
    : runNodeSelfTest({
        target: `verify-${process.platform}-system-credential`,
        store: "system"
      });
  assert.equal(payload.systemCredential, true);
  assert.equal(payload.fileFallback, false);
  assert.ok(
    expectedBackends.includes(payload.storageBackend),
    `unexpected ${process.platform} process identity backend ${payload.storageBackend || "(empty)"}`
  );
  return {
    platform: process.platform,
    expectedBackends,
    storageBackend: payload.storageBackend,
    systemCredential: payload.systemCredential,
    fileFallback: payload.fileFallback,
    controlledHeadlessProof: headlessLinux
  };
});

record("Linux container Secret Service stores process identity", () : any => {
  const payload: any = controlledLinuxSecretServiceProof();
  return {
    storageBackend: payload.storageBackend,
    systemCredential: payload.systemCredential,
    fileFallback: payload.fileFallback,
    container: payload.containerImage,
    containerImageBuilt: payload.containerImageBuilt
  };
});

const failedCount: any = tests.filter((item?: any) : any => item.status === "failed").length;
const skippedCount: any = tests.filter((item?: any) : any => item.status === "skipped").length;
const privateFileFallbackPassed: any = tests.some((item?: any) : any =>
  item.name === "private file fallback remains explicit and 0600 scoped" &&
  item.status === "passed" &&
  item.evidence?.storageBackend === "private-file-fallback" &&
  item.evidence?.fileFallback === true &&
  item.evidence?.fileModeChecked === true);
const explicitSystemNoFileFallbackPassed: any = tests.some((item?: any) : any =>
  item.name === "explicit system mode does not read private file fallback" &&
  item.status === "passed" &&
  item.evidence?.explicitSystemLoadNull === true &&
  item.evidence?.fileFallbackStillExplicit === true);
const currentPlatformSystemCredential: any = tests.find((item?: any) : any =>
  item.name === "current platform system credential store is release-ready");
const currentPlatformSystemCredentialPassed: any = Boolean(
  currentPlatformSystemCredential?.status === "passed" &&
  currentPlatformSystemCredential?.evidence?.systemCredential === true &&
  currentPlatformSystemCredential?.evidence?.fileFallback === false &&
  currentPlatformSystemBackends().includes(currentPlatformSystemCredential?.evidence?.storageBackend)
);
const linuxContainerSecretServicePassed: any = tests.some((item?: any) : any =>
  item.status === "passed" && item.evidence?.storageBackend === "linux-secret-service");
const report: Record<string, any> = {
  schemaVersion: MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  verifier: MCP_PROCESS_IDENTITY_CREDENTIAL_STORE_VERIFIER,
  tests,
  summary: {
    reportLeakScan: true,
    testCount: tests.length,
    failedCount,
    skippedCount,
    platform: process.platform,
    currentPlatformSystemBackends: currentPlatformSystemBackends(),
    privateFileFallbackPassed,
    explicitSystemNoFileFallbackPassed,
    currentPlatformSystemCredentialReady: currentPlatformSystemCredentialPassed,
    currentPlatformSystemCredentialBackend: currentPlatformSystemCredential?.evidence?.storageBackend || "",
    linuxContainerSecretServicePassed,
    linuxContainerSecretService: tests.some((item?: any) : any =>
      item.status === "passed" && item.evidence?.storageBackend === "linux-secret-service"),
    macosKeychain: tests.some((item?: any) : any =>
      item.status === "passed" && item.evidence?.storageBackend === "macos-keychain")
  }
};
const readiness: any = createMcpProcessIdentityCredentialStoreReadiness(report);
report.summary.releaseReady = readiness.releaseReady;
report.summary.readinessSource = readiness.sourceOfTruth;
report.summary.readinessReasons = readiness.reasons;

assertNoLeak(report, "credential store report");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (!readiness.releaseReady) {
  throw new Error(`MCP process identity credential store verification failed: ${readiness.reasons.join(", ")}`);
}
console.log(`[mcp-process-identity-store] ok report=build/reports/mcp-process-identity-credential-store.json`);
