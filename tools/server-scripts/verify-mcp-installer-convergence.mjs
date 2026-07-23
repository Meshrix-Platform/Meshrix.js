#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import {
  CLIENT_ADAPTER_DESCRIPTOR_SCHEMA,
  CLIENT_ADAPTER_MAX_MESSAGE_BYTES,
  clientAdapterConnectorRequest
} from "../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.mjs";
import { installAuthenticatedFetch } from "./test-auth-helper.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";

const execFileAsync = promisify(execFile);

const REPORT_PATH = "build/reports/mcp-installer-convergence.json";
const PROTOCOL_INSTALLER_BIN = "packages/protocols/mcp/adapter/gateway-installer/bin/lico-mcp.mjs";
const NATIVE_INSTALLER_SH = "packages/protocols/mcp/adapter/native-installer/lico-mcp-install.sh";
const NATIVE_INSTALLER_PS1 = "packages/protocols/mcp/adapter/native-installer/lico-mcp-install.ps1";
const BASIC_UTILS_SOURCE = "packages/protocols/mcp/adapter/gateway-installer/lib/cli/basic-utils.mjs";
const CLIENT_ADAPTER_RUNNER_SOURCE = "packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.mjs";
const INSTALL_COMMAND_SOURCE = "packages/protocols/mcp/adapter/gateway-installer/lib/cli/install-command.mjs";
const UNINSTALL_COMMAND_SOURCE = "packages/protocols/mcp/adapter/gateway-installer/lib/cli/uninstall-command.mjs";
const DISCOVERY_SOURCE = "packages/protocols/mcp/adapter/gateway-installer/lib/cli/discovery.mjs";
const FORMATTERS_SOURCE = "packages/protocols/mcp/adapter/gateway-installer/lib/cli/formatters.mjs";
const STANDALONE_INSTALL_WRAPPER = "tools/server-scripts/mcp-install.mjs";
const STANDALONE_DOCTOR = "tools/server-scripts/mcp-doctor.mjs";
const DOCTOR_TOKEN_ENV = "LICO_VERIFY_MCP_INSTALLER_CONVERGENCE_TOKEN";
const VERIFIED_DOWNLOAD_GUIDANCE_FILES = [
  ".github/RELEASE_TEMPLATE.md",
  "docs/architecture/MCP-NATIVE-INSTALLER.md",
  "packages/protocols/mcp/adapter/gateway-installer/lib/cli/connector-process.mjs",
  "packages/protocols/mcp/adapter/http-mcp-adapter-discovery.mjs",
  "packages/capabilities/src/skills/tool-skill-management-provider-local-mcp.mjs",
  "tools/server-scripts/lib/mcp-release-manifest.mjs"
];

const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-mcp-installer-convergence-"));
const manifestPath = path.join(userDataPath, "device", "servers.json");
const missingManifestPath = path.join(userDataPath, "missing", "servers.json");
const pathNeedles = [
  userDataPath,
  manifestPath,
  missingManifestPath,
  os.homedir(),
  process.cwd()
].filter(Boolean);

const report = {
  schemaVersion: "v0.0.1:mcp:installer-convergence-report-1",
  verifier: "tools/server-scripts/verify-mcp-installer-convergence.mjs",
  startedAt: new Date().toISOString(),
  tests: [],
  destructiveTests: [],
  summary: {}
};

let server = null;

function safeEvidence(value = {}) {
  return JSON.parse(JSON.stringify(value, (_, child) => {
    if (typeof child !== "string") return child;
    for (const needle of pathNeedles) {
      if (needle && child.includes(needle)) return "[redacted-local-path]";
    }
    if (/Bearer\s+\S+/i.test(child) || /lico_[A-Za-z0-9_-]{12,}=/.test(child)) return "[redacted-secret]";
    return child;
  }));
}

function assertNoLeakText(text = "", label = "text") {
  const value = String(text);
  for (const needle of pathNeedles) {
    assert.equal(needle ? value.includes(needle) : false, false, `${label} leaked local path`);
  }
  assert.equal(/Bearer\s+\S+/i.test(value), false, `${label} leaked bearer token`);
  assert.equal(/lico_[A-Za-z0-9_-]{12,}=/.test(value), false, `${label} leaked cookie`);
}

function assertNoLeak(value, label = "payload") {
  assertNoLeakText(JSON.stringify(value), label);
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  report.summary.testCount = report.tests.length;
  report.summary.destructiveTestCount = report.destructiveTests.length;
  report.summary.failedCount = [...report.tests, ...report.destructiveTests].filter((item) => item.status !== "passed").length;
  report.summary.releaseReady = report.summary.failedCount === 0;
  report.summary.reportLeakScan = false;
  assertNoLeak(report, "mcp installer convergence report");
  report.summary.reportLeakScan = true;
  assertNoLeak(report, "mcp installer convergence report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function record(collection, name, status, evidence = {}) {
  collection.push({ name, status, evidence: safeEvidence(evidence) });
}

function failureEvidence(error) {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    code: String(error?.code || ""),
    status: Number(error?.status || 0) || 0,
    message: String(error?.message || "")
  };
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

async function runNode(script, args = [], env = {}, { closeStdin = false } = {}) {
  let result = null;
  let status = 0;
  try {
    const execution = execFileAsync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30000
    });
    if (closeStdin) {
      execution.child?.stdin?.end();
    }
    result = await execution;
  } catch (error) {
    result = {
      stdout: error.stdout || "",
      stderr: error.stderr || ""
    };
    status = Number.isInteger(error.code) ? error.code : 1;
  }
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  assertNoLeakText(stdout, `${script} stdout`);
  assertNoLeakText(stderr, `${script} stderr`);
  return { status, stdout, stderr };
}

async function runNativeInstaller(args = [], env = {}) {
  let result = null;
  let status = 0;
  try {
    result = await execFileAsync("sh", [NATIVE_INSTALLER_SH, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30000
    });
  } catch (error) {
    result = {
      stdout: error.stdout || "",
      stderr: error.stderr || ""
    };
    const exitCode = Number(error.code);
    status = Number.isFinite(exitCode) ? exitCode : 1;
  }
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  assertNoLeakText(stdout, `${NATIVE_INSTALLER_SH} stdout`);
  assertNoLeakText(stderr, `${NATIVE_INSTALLER_SH} stderr`);
  return { status, stdout, stderr };
}

function parseJsonOutput(stdout = "", label = "stdout") {
  const text = String(stdout || "").trim();
  assert.ok(text, `${label} was empty`);
  const start = text.indexOf("{");
  assert.notEqual(start, -1, `${label} did not contain JSON`);
  const payload = JSON.parse(text.slice(start));
  assertNoLeak(payload, label);
  return payload;
}

function assertNoDeviceManifestPath(payload, label) {
  const serialized = JSON.stringify(payload?.checks?.deviceManifest || {});
  assert.equal(/"path"\s*:/.test(serialized), false, `${label} exposed a path key`);
  assert.equal(serialized.includes(".lico/mcp/servers.json"), false, `${label} exposed default manifest path`);
  assert.equal(serialized.includes(".lico\\\\mcp\\\\servers.json"), false, `${label} exposed default manifest path`);
}

function assertRedactedDeviceManifest(payload, label, exists) {
  const deviceManifest = payload?.checks?.deviceManifest;
  assert.equal(deviceManifest?.exists, exists, `${label} returned unexpected manifest existence`);
  assert.equal(deviceManifest?.pathRedacted, true, `${label} did not mark manifest path as redacted`);
  assertNoDeviceManifestPath(payload, label);
}

async function writeDeviceManifest(httpUrl) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify({
    servers: {
      lico: {
        httpUrl,
        connector: {
          type: "verifier",
          version: "mcp-installer-convergence"
        },
        targets: {
          "external-adapter": {
            status: "installed",
            installedAt: "2026-07-01T00:00:00.000Z"
          }
        }
      }
    }
  }, null, 2)}\n`, "utf8");
}

function doctorEnv(deviceManifestPath) {
  return {
    LICO_MCP_BASE_URL: server.url,
    LICO_MCP_DISCOVERY_FILE: deviceManifestPath,
    LICO_MCP_TOKEN: "",
    LICO_MCP_TARGET: "",
    [DOCTOR_TOKEN_ENV]: ""
  };
}

try {
  server = await startHttpServer({
    userDataPath,
    distPath: "",
    port: 0,
    runtimeOptions: {
      profile: "minimal",
      enableFeatures: ["operation-permission-core"]
    }
  });
  await installAuthenticatedFetch(server, { setProcessEnv: false });
  await writeDeviceManifest(`${server.url}/mcp`);

  console.log("\n=== MCP Installer Convergence: real server doctor and redaction verifier ===\n");

  await test("native installer scripts are the canonical user-device entrypoints", async () => {
    const shSource = await fs.readFile(NATIVE_INSTALLER_SH, "utf8");
    const ps1Source = await fs.readFile(NATIVE_INSTALLER_PS1, "utf8");
    assert.match(shSource, /gateway-installer\/bin\/lico-mcp\.mjs/u);
    assert.match(ps1Source, /gateway-installer\\bin\\lico-mcp\.mjs/u);
    assert.match(shSource, /--token\|--token=\*/u);
    assert.match(ps1Source, /Raw tokens are not accepted/u);
    assert.equal(/\beval\b/u.test(shSource), false);
    assert.equal(shSource.includes("/api/mcp/discovery"), false);
    assert.equal(ps1Source.includes("Invoke-RestMethod"), false);
    assert.equal(ps1Source.includes("Publish-TokenEnv"), false);
    assert.equal(/\[string\]\$Token\s*=/u.test(ps1Source), false);
    assert.equal(shSource.includes("LICO_MCP_CONNECTOR"), false);
    assert.equal(ps1Source.includes("LICO_MCP_CONNECTOR"), false);
    assert.equal(shSource.includes("command -v lico-mcp"), false);
    assert.equal(ps1Source.includes("Get-Command lico-mcp"), false);
    return {
      nativeInstallers: [NATIVE_INSTALLER_SH, NATIVE_INSTALLER_PS1],
      userDeviceInstallerMode: "secure-connector-delegation",
      duplicateDiscoveryImplementationRemoved: true,
      rawTokenArgumentsRejected: true,
      arbitraryConnectorOverridesRejected: true
    };
  });

  await destructiveTest("raw token arguments and token-env injection fail before connector execution", async () => {
    const secret = "lico_installer_argv_secret_should_not_escape";
    const direct = await runNode(PROTOCOL_INSTALLER_BIN, ["doctor", "--token", secret, "--json"]);
    assert.notEqual(direct.status, 0);
    assert.equal(`${direct.stdout}${direct.stderr}`.includes(secret), false);

    const native = await runNativeInstaller(["doctor", `--token=${secret}`, "--json"]);
    assert.notEqual(native.status, 0);
    assert.equal(`${native.stdout}${native.stderr}`.includes(secret), false);

    const canary = path.join(userDataPath, "token-env-injection-canary");
    const injected = await runNativeInstaller(["doctor", "--token-env", `BAD;touch ${canary}`, "--json"]);
    assert.notEqual(injected.status, 0);
    assert.equal(await fs.stat(canary).then(() => true).catch(() => false), false);
    const basicUtilsSource = await fs.readFile(BASIC_UTILS_SOURCE, "utf8");
    const adapterRunnerSource = await fs.readFile(CLIENT_ADAPTER_RUNNER_SOURCE, "utf8");
    const discoverySource = await fs.readFile(DISCOVERY_SOURCE, "utf8");
    assert.equal(basicUtilsSource.includes("--token TOKEN"), false);
    assert.equal(adapterRunnerSource.includes('"X-LicoMesh-Api-Key": token'), false);
    assert.match(adapterRunnerSource, /assertSecretFreeRequest/u);
    assert.match(adapterRunnerSource, /cleanEnv:\s*true/u);
    assert.match(discoverySource, /sensitive_environment_persistence_requires_a_secret_store/u);
    return {
      directCliRejected: true,
      nativeCliRejected: true,
      environmentNameInjectionRejected: true,
      tokenRedacted: true,
      childProcessArgumentsSecretFree: true,
      clientConfigsUseEnvironmentReferences: true
    };
  });

  await destructiveTest("external adapter requests contain connector metadata and secret references only", async () => {
    const tokenEnv = "LICO_VERIFY_CLIENT_TOKEN";
    const sentinel = "lico_sensitive_token_must_not_reach_argv";
    const request = clientAdapterConnectorRequest({
      baseUrl: server.url,
      tokenEnv,
      client: { configurationRoot: "<client-config-root>" }
    });
    const formatterSource = await fs.readFile(FORMATTERS_SOURCE, "utf8");
    const serialized = JSON.stringify(request);
    assert.equal(serialized.includes(sentinel), false);
    assert.equal(serialized.includes('"token"'), false);
    assert.equal(request.tokenEnv, tokenEnv);
    assert.equal(Array.isArray(request.connector.args), true);
    assert.equal(CLIENT_ADAPTER_DESCRIPTOR_SCHEMA, "licomesh.client-adapter.descriptor.v1");
    assert.equal(CLIENT_ADAPTER_MAX_MESSAGE_BYTES, 256 * 1024);
    assert.equal(formatterSource.includes("X-LicoMesh-Api-Key: <token>"), false);
    return {
      externalAdapterProtocolBounded: true,
      connectorMetadataOnly: true,
      directBearerQuickTestAbsent: true,
      rawTokenInChildArguments: false
    };
  });

  await test("installer lifecycle delegates client behavior through the external adapter protocol", async () => {
    const installSource = await fs.readFile(INSTALL_COMMAND_SOURCE, "utf8");
    const uninstallSource = await fs.readFile(UNINSTALL_COMMAND_SOURCE, "utf8");
    const lifecycleSource = `${installSource}\n${uninstallSource}`;
    const cliSourceFiles = await fs.readdir(path.dirname(CLIENT_ADAPTER_RUNNER_SOURCE));
    const embeddedAdapterModules = cliSourceFiles.filter((filename) => filename.endsWith("-adapter.mjs"));
    assert.match(installSource, /runClientAdapter/u);
    assert.match(uninstallSource, /runClientAdapter/u);
    assert.deepEqual(embeddedAdapterModules, [], "Core retained an embedded client adapter module");
    assert.equal(
      /from\s+["']\.\/(?!client-adapter-runner\.mjs)[^"']*adapter[^"']*["']/u.test(lifecycleSource),
      false,
      "installer lifecycle imported a client-specific adapter implementation"
    );
    return {
      lifecycleProtocol: "external-client-adapter",
      coreClientSpecificAdapterImports: false,
      coreEmbeddedAdapterModules: 0
    };
  });

  await test("standalone install wrapper delegates to native installer", async () => {
    const source = await fs.readFile(STANDALONE_INSTALL_WRAPPER, "utf8");
    assert.match(source, /native-installer\/lico-mcp-install\.sh/u);
    assert.match(source, /native-installer\/lico-mcp-install\.ps1/u);
    assert.equal(source.includes("gateway-installer/bin/lico-mcp.mjs"), false);
    return {
      wrapper: STANDALONE_INSTALL_WRAPPER,
      delegatesTo: "native-installer"
    };
  });

  await destructiveTest("release guidance never executes an unverified network response", async () => {
    for (const filePath of VERIFIED_DOWNLOAD_GUIDANCE_FILES) {
      const source = await fs.readFile(filePath, "utf8");
      assert.equal(/curl[^\n]*(?:\||\$\()[^\n]*(?:sh|bash)|(?:sh|bash)[^\n]*<\([^\n]*curl/iu.test(source), false, `${filePath} contains remote shell execution`);
    }
    const releaseTemplate = await fs.readFile(".github/RELEASE_TEMPLATE.md", "utf8");
    const releaseSource = await fs.readFile("tools/server-scripts/mcp-release.mjs", "utf8");
    assert.match(releaseTemplate, /RELEASE_SHA256SUMS\.sigstore\.json/u);
    assert.match(releaseTemplate, /cosign verify-blob RELEASE_SHA256SUMS/u);
    assert.match(releaseTemplate, /--certificate-identity/u);
    assert.match(releaseTemplate, /--certificate-oidc-issuer/u);
    assert.match(releaseTemplate, /test "\$actual" = "\$expected"/u);
    assert.match(releaseSource, /checksumFilePath/u);
    return {
      checkedFileCount: VERIFIED_DOWNLOAD_GUIDANCE_FILES.length,
      remoteShellExecutionAbsent: true,
      releaseChecksumVerificationDocumented: true,
      checksumIndexGenerated: true
    };
  });

  await test("canonical installer doctor verifies real MCP discovery without host path leakage", async () => {
    const result = await runNode(PROTOCOL_INSTALLER_BIN, ["doctor", "--url", server.url, "--token-env", DOCTOR_TOKEN_ENV, "--json"], doctorEnv(manifestPath));
    const payload = parseJsonOutput(result.stdout, "installer doctor");
    assert.equal(result.status, 0, `installer doctor failed against real server: ${JSON.stringify({
      ok: payload.ok === true,
      signedDiscovery: payload.checks?.signedDiscovery?.ok === true,
      discovery: payload.checks?.discovery?.ok === true,
      initialize: payload.checks?.initialize?.ok === true,
      toolsSkipped: payload.checks?.toolsList?.skipped === true,
      systemHealthSkipped: payload.checks?.systemHealth?.skipped === true,
      nextCommand: payload.nextCommand || ""
    })}`);
    assert.equal(payload.checks?.discovery?.ok, true);
    assert.equal(payload.checks?.initialize?.ok, true);
    assertRedactedDeviceManifest(payload, "installer doctor", true);
    return {
      ok: payload.ok === true,
      discoveryStatus: payload.checks?.discovery?.status,
      manifestPathRedacted: payload.checks?.deviceManifest?.pathRedacted === true,
      installedTargets: payload.checks?.deviceManifest?.installedTargets || []
    };
  });

  await test("native installer discover-local uses redacted output contract", async () => {
    const result = await runNativeInstaller(["discover-local", "--url", server.url, "--json"], doctorEnv(manifestPath));
    assert.equal(result.status, 0, `native installer discover-local failed against real server (status=${result.status}, stdoutBytes=${Buffer.byteLength(result.stdout)}, stderrBytes=${Buffer.byteLength(result.stderr)})`);
    const payload = parseJsonOutput(result.stdout, "native installer discover-local");
    assert.equal(payload.ok, true);
    assert.equal(payload.baseUrl, server.url);
    return {
      ok: payload.ok === true,
      sourceType: payload.sourceType
    };
  });

  await destructiveTest("marker-only discovery response is rejected without a signed handshake", async () => {
    const markerServer = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        name: "LicoMesh",
        interfaceVersion: "v0.0.1:mcp:interface-1",
        stableToolName: "lico.discovery"
      }));
    });
    await new Promise((resolve, reject) => {
      markerServer.once("error", reject);
      markerServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = markerServer.address();
      const fakeUrl = `http://127.0.0.1:${address.port}`;
      const result = await runNativeInstaller(["discover-local", "--url", fakeUrl, "--json"], doctorEnv(missingManifestPath));
      assert.notEqual(result.status, 0);
      assert.equal(/"ok"\s*:\s*true/u.test(result.stdout), false);
      return {
        rejected: true,
        signedHandshakeRequired: true
      };
    } finally {
      await new Promise((resolve) => markerServer.close(resolve));
    }
  });

  await test("standalone mcp-doctor honors temporary device manifest without host path leakage", async () => {
    const result = await runNode(STANDALONE_DOCTOR, ["--url", server.url], doctorEnv(manifestPath));
    assert.equal(result.status, 0, "standalone mcp-doctor failed against real server");
    const payload = parseJsonOutput(result.stdout, "standalone mcp-doctor");
    assert.equal(payload.checks?.discovery?.ok, true);
    assert.equal(payload.checks?.initialize?.ok, true);
    assertRedactedDeviceManifest(payload, "standalone mcp-doctor", true);
    return {
      ok: payload.ok === true,
      manifestPathRedacted: payload.checks?.deviceManifest?.pathRedacted === true
    };
  });

  await destructiveTest("missing device manifest never leaks the requested host path", async () => {
    const installer = await runNode(PROTOCOL_INSTALLER_BIN, ["doctor", "--url", server.url, "--token-env", DOCTOR_TOKEN_ENV, "--json"], doctorEnv(missingManifestPath));
    const installerPayload = parseJsonOutput(installer.stdout, "installer missing-manifest doctor");
    assertRedactedDeviceManifest(installerPayload, "installer missing-manifest doctor", false);

    const standalone = await runNode(STANDALONE_DOCTOR, ["--url", server.url], doctorEnv(missingManifestPath));
    assert.notEqual(standalone.status, 0);
    const standalonePayload = parseJsonOutput(standalone.stdout, "standalone missing-manifest doctor");
    assertRedactedDeviceManifest(standalonePayload, "standalone missing-manifest doctor", false);

    return {
      installerStatus: installer.status,
      installerWarnOnly: installerPayload.ok === true,
      standaloneStatus: standalone.status,
      redactionVerified: true
    };
  });

  await writeReport();
  console.log(`\n=== MCP Installer Convergence passed; report: ${REPORT_PATH} ===`);
} catch (error) {
  await writeReport().catch(() => {});
  console.error(JSON.stringify(safeEvidence({
    ok: false,
    verifier: "tools/server-scripts/verify-mcp-installer-convergence.mjs",
    failure: failureEvidence(error)
  }), null, 2));
  process.exitCode = 1;
} finally {
  await server?.close?.();
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  restoreCapabilityKernelEnv();
}
