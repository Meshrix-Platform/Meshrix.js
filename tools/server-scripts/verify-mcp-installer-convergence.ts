#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import {
  CLIENT_ADAPTER_DESCRIPTOR_SCHEMA,
  CLIENT_ADAPTER_MAX_MESSAGE_BYTES,
  clientAdapterRegistrationRequest
} from "../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.ts";
import { installAuthenticatedFetch } from "./test-auth-helper.ts";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.ts";
import { summarizeMcpInstallerConvergenceReport } from "./lib/mcp-installer-convergence-report.ts";

const execFileAsync: any = promisify(execFile);
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}/iu;
const SCOPED_API_KEY = /mxak1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/u;

const REPORT_PATH: any = "build/reports/mcp-installer-convergence.json";
const PROTOCOL_INSTALLER_BIN: any = "packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts";
const BASIC_UTILS_SOURCE: any = "packages/protocols/mcp/adapter/gateway-installer/lib/cli/basic-utils.ts";
const CLIENT_ADAPTER_RUNNER_SOURCE: any = "packages/protocols/mcp/adapter/gateway-installer/lib/cli/client-adapter-runner.ts";
const INSTALL_COMMAND_SOURCE: any = "packages/protocols/mcp/adapter/gateway-installer/lib/cli/install-command.ts";
const UNINSTALL_COMMAND_SOURCE: any = "packages/protocols/mcp/adapter/gateway-installer/lib/cli/uninstall-command.ts";
const DISCOVERY_SOURCE: any = "packages/protocols/mcp/adapter/gateway-installer/lib/cli/discovery.ts";
const FORMATTERS_SOURCE: any = "packages/protocols/mcp/adapter/gateway-installer/lib/cli/formatters.ts";
const STANDALONE_INSTALL_WRAPPER: any = "tools/server-scripts/mcp-install.ts";
const STANDALONE_DOCTOR: any = "tools/server-scripts/mcp-doctor.ts";
const DOCTOR_TOKEN_ENV: any = "MESHRIX_VERIFY_MCP_INSTALLER_CONVERGENCE_TOKEN";
const VERIFIED_DOWNLOAD_GUIDANCE_FILES: any[] = [
  ".github/RELEASE_TEMPLATE.md",
  "docs/architecture/MCP-NATIVE-INSTALLER.md",
  "packages/protocols/mcp/adapter/gateway-installer/lib/cli/connector-process.ts",
  "packages/protocols/mcp/modern-downstream/discovery.ts",
  "tools/server-scripts/lib/mcp-release-manifest.ts"
];

const restoreCapabilityKernelEnv: any = useIsolatedCapabilityKernelForVerifier();
const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-installer-convergence-"));
const keyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-installer-key-"));
const previousMasterKeyFile = process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE;
const manifestPath: any = path.join(userDataPath, "device", "servers.json");
const missingManifestPath: any = path.join(userDataPath, "missing", "servers.json");
const pathNeedles: any = [
  userDataPath,
  keyRoot,
  manifestPath,
  missingManifestPath,
  os.homedir(),
  process.cwd()
].filter(Boolean);

const report: Record<string, any> = {
  schemaVersion: "v0.0.1:mcp:installer-convergence-report-1",
  verifier: "tools/server-scripts/verify-mcp-installer-convergence.ts",
  startedAt: new Date().toISOString(),
  tests: [],
  destructiveTests: [],
  executionFailure: null,
  summary: {}
};

let server: any = null;

function safeEvidence(value: Record<string, any> = {}) : any {
  return JSON.parse(JSON.stringify(value, (_?: any, child?: any) : any => {
    if (typeof child !== "string") return child;
    for (const needle of pathNeedles) {
      if (needle && child.includes(needle)) return "[redacted-local-path]";
    }
    if (BEARER_CREDENTIAL.test(child) || SCOPED_API_KEY.test(child) || /meshrix_[A-Za-z0-9_-]{12,}=/.test(child)) return "[redacted-secret]";
    return child;
  }));
}

function assertNoLeakText(text: any = "", label: any = "text") : any {
  const value: any = String(text);
  for (const needle of pathNeedles) {
    assert.equal(needle ? value.includes(needle) : false, false, `${label} leaked local path`);
  }
  assert.equal(BEARER_CREDENTIAL.test(value), false, `${label} leaked bearer credential`);
  assert.equal(SCOPED_API_KEY.test(value), false, `${label} leaked scoped API key`);
  assert.equal(/meshrix_[A-Za-z0-9_-]{12,}=/.test(value), false, `${label} leaked cookie`);
}

function assertNoLeak(value?: any, label: any = "payload") : any {
  assertNoLeakText(JSON.stringify(value), label);
}

async function writeReport() : Promise<any> {
  report.finishedAt = new Date().toISOString();
  Object.assign(report.summary, summarizeMcpInstallerConvergenceReport(report));
  report.summary.reportLeakScan = false;
  assertNoLeak(report, "mcp installer convergence report");
  report.summary.reportLeakScan = true;
  assertNoLeak(report, "mcp installer convergence report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function record(collection?: any, name?: any, status?: any, evidence: Record<string, any> = {}) : any {
  collection.push({ name, status, evidence: safeEvidence(evidence) });
}

function failureEvidence(error?: any) : any {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    code: String(error?.code || ""),
    status: Number(error?.status || 0) || 0,
    message: String(error?.message || "")
  };
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
  }
}

async function runNode(script?: any, args: any = [], env: Record<string, any> = {}, { closeStdin = false }: Record<string, any> = {}) : Promise<any> {
  let result: any = null;
  let status: any = 0;
  try {
    const execution: any = execFileAsync(process.execPath, ["--conditions=source", script, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env
      },
      maxBuffer: 4 * 1024 * 1024
    });
    if (closeStdin) {
      execution.child?.stdin?.end();
    }
    result = await execution;
  } catch (error: any) {
    result = {
      stdout: error.stdout || "",
      stderr: error.stderr || ""
    };
    status = Number.isInteger(error.code) ? error.code : 1;
  }
  const stdout: any = result.stdout || "";
  const stderr: any = result.stderr || "";
  assertNoLeakText(stdout, `${script} stdout`);
  assertNoLeakText(stderr, `${script} stderr`);
  return { status, stdout, stderr };
}

async function runInstallerCli(args: any = [], env: Record<string, any> = {}) : Promise<any> {
  let result: any = null;
  let status: any = 0;
  try {
    result = await execFileAsync(process.execPath, ["--conditions=source", PROTOCOL_INSTALLER_BIN, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env
      },
      maxBuffer: 4 * 1024 * 1024
    });
  } catch (error: any) {
    result = {
      stdout: error.stdout || "",
      stderr: error.stderr || ""
    };
    const exitCode: any = Number(error.code);
    status = Number.isFinite(exitCode) ? exitCode : 1;
  }
  const stdout: any = result.stdout || "";
  const stderr: any = result.stderr || "";
  assertNoLeakText(stdout, `${PROTOCOL_INSTALLER_BIN} stdout`);
  assertNoLeakText(stderr, `${PROTOCOL_INSTALLER_BIN} stderr`);
  return { status, stdout, stderr };
}

function parseJsonOutput(stdout: any = "", label: any = "stdout") : any {
  const text: any = String(stdout || "").trim();
  assert.ok(text, `${label} was empty`);
  const start: any = text.indexOf("{");
  assert.notEqual(start, -1, `${label} did not contain JSON`);
  const payload: any = JSON.parse(text.slice(start));
  assertNoLeak(payload, label);
  return payload;
}

function assertNoDeviceManifestPath(payload?: any, label?: any) : any {
  const serialized: any = JSON.stringify(payload?.checks?.deviceManifest || {});
  assert.equal(/"path"\s*:/.test(serialized), false, `${label} exposed a path key`);
  assert.equal(serialized.includes(".meshrix/mcp/servers.json"), false, `${label} exposed default manifest path`);
  assert.equal(serialized.includes(".meshrix\\\\mcp\\\\servers.json"), false, `${label} exposed default manifest path`);
}

function assertRedactedDeviceManifest(payload?: any, label?: any, exists?: any) : any {
  const deviceManifest: any = payload?.checks?.deviceManifest;
  assert.equal(deviceManifest?.exists, exists, `${label} returned unexpected manifest existence`);
  assert.equal(deviceManifest?.pathRedacted, true, `${label} did not mark manifest path as redacted`);
  assertNoDeviceManifestPath(payload, label);
}

async function writeDeviceManifest(httpUrl?: any) : Promise<any> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify({
    servers: {
      meshrix: {
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

function doctorEnv(deviceManifestPath?: any) : any {
  return {
    MESHRIX_MCP_BASE_URL: server.url,
    MESHRIX_MCP_DISCOVERY_FILE: deviceManifestPath,
    MESHRIX_MCP_TOKEN: "",
    MESHRIX_MCP_TARGET: "",
    [DOCTOR_TOKEN_ENV]: ""
  };
}

try {
  const masterKeyFile = path.join(keyRoot, "master.key");
  const masterKey = randomBytes(32);
  try { await fs.writeFile(masterKeyFile, masterKey.toString("hex"), { mode: 0o600, flag: "wx" }); }
  finally { masterKey.fill(0); }
  process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = masterKeyFile;
  server = await startHttpServer({
    userDataPath,
    distPath: "",
    port: 0,
    runtimeOptions: {
      profile: "minimal",
      enabledPlugins: [],
      disableFileLogging: true,
      enableFeatures: ["operation-permission-core"]
    }
  });
  await installAuthenticatedFetch(server, { setProcessEnv: false });
  await writeDeviceManifest(`${server.url}/mcp`);

  console.log("\n=== MCP Installer Convergence: real server Node CLI and redaction verifier ===\n");

  await test("public install and doctor wrappers delegate to the single Node CLI", async () : Promise<any> => {
    const installSource: any = await fs.readFile(STANDALONE_INSTALL_WRAPPER, "utf8");
    const doctorSource: any = await fs.readFile(STANDALONE_DOCTOR, "utf8");
    for (const source of [installSource, doctorSource]) {
      assert.match(source, /from "@meshrix\/protocols\/mcp\/adapter\/gateway-installer\/bin\/meshrix-mcp"/u);
      assert.equal(/\.\.\/\.\.\/packages\//u.test(source), false);
      assert.match(source, /runCli\(/u);
      assert.equal(/\b(?:spawn|execFile|execSync)\s*\(/u.test(source), false);
      assert.equal(/native-installer|powershell|\/bin\/sh/u.test(source), false);
    }
    assert.match(installSource, /\["install", \.\.\.process\.argv\.slice\(2\)\]/u);
    assert.match(doctorSource, /\["doctor", "--json", \.\.\.process\.argv\.slice\(2\)\]/u);
    return {
      wrappers: [STANDALONE_INSTALL_WRAPPER, STANDALONE_DOCTOR],
      delegatedCommands: ["install", "doctor"],
      shellReentry: false
    };
  });

  await destructiveTest("raw token arguments and token-env injection fail before connector execution", async () : Promise<any> => {
    const secret: any = "meshrix_installer_argv_secret_should_not_escape";
    const direct: any = await runNode(PROTOCOL_INSTALLER_BIN, ["doctor", "--token", secret, "--json"]);
    assert.notEqual(direct.status, 0);
    assert.equal(`${direct.stdout}${direct.stderr}`.includes(secret), false);

    const native: any = await runInstallerCli(["doctor", `--token=${secret}`, "--json"]);
    assert.notEqual(native.status, 0);
    assert.equal(`${native.stdout}${native.stderr}`.includes(secret), false);

    const canary: any = path.join(userDataPath, "token-env-injection-canary");
    const injected: any = await runInstallerCli(["doctor", "--token-env", `BAD;touch ${canary}`, "--json"]);
    assert.notEqual(injected.status, 0);
    assert.equal(await fs.stat(canary).then(() : any => true).catch(() : any => false), false);
    const basicUtilsSource: any = await fs.readFile(BASIC_UTILS_SOURCE, "utf8");
    const adapterRunnerSource: any = await fs.readFile(CLIENT_ADAPTER_RUNNER_SOURCE, "utf8");
    const discoverySource: any = await fs.readFile(DISCOVERY_SOURCE, "utf8");
    assert.equal(basicUtilsSource.includes("--token TOKEN"), false);
    assert.equal(adapterRunnerSource.includes('"X-Meshrix.js-Api-Key": token'), false);
    assert.match(adapterRunnerSource, /assertSecretFreeRequest/u);
    assert.match(adapterRunnerSource, /cleanEnv:\s*true/u);
    assert.match(discoverySource, /deviceEnvironmentPort\.read\(\)/u);
    assert.match(discoverySource, /persistedEnvironment\[MESHRIX_MCP_DISCOVERY_FILE_ENV\]/u);
    return {
      directCliRejected: true,
      sharedNodeCliRejected: true,
      environmentNameInjectionRejected: true,
      tokenRedacted: true,
      childProcessArgumentsSecretFree: true,
      clientConfigsUseEnvironmentReferences: true
    };
  });

  await destructiveTest("external adapter requests contain native endpoint metadata and credential references only", async () : Promise<any> => {
    const tokenEnv: any = "MESHRIX_VERIFY_CLIENT_TOKEN";
    const sentinel: any = "meshrix_sensitive_token_must_not_reach_argv";
    const request: any = clientAdapterRegistrationRequest({
      baseUrl: server.url,
      serverName: "meshrix",
      credentialRef: { kind: "env", name: tokenEnv },
      client: { configurationRoot: "<client-config-root>" }
    });
    const formatterSource: any = await fs.readFile(FORMATTERS_SOURCE, "utf8");
    const serialized: any = JSON.stringify(request);
    assert.equal(serialized.includes(sentinel), false);
    assert.equal(serialized.includes('"token"'), false);
    assert.deepEqual(request.credentialRef, { kind: "env", name: tokenEnv });
    assert.equal(request.baseUrl, server.url);
    assert.equal(request.serverName, "meshrix");
    assert.equal(CLIENT_ADAPTER_DESCRIPTOR_SCHEMA, "v0.0.1:meshrix:client-adapter-descriptor-1");
    assert.equal(CLIENT_ADAPTER_MAX_MESSAGE_BYTES, 256 * 1024);
    assert.equal(formatterSource.includes("X-Meshrix.js-Api-Key: <token>"), false);
    return {
      externalAdapterProtocolBounded: true,
      nativeRegistrationMetadataOnly: true,
      directBearerQuickTestAbsent: true,
      rawTokenInChildArguments: false
    };
  });

  await test("installer lifecycle delegates client behavior through the external adapter protocol", async () : Promise<any> => {
    const installSource: any = await fs.readFile(INSTALL_COMMAND_SOURCE, "utf8");
    const uninstallSource: any = await fs.readFile(UNINSTALL_COMMAND_SOURCE, "utf8");
    const lifecycleSource: any = `${installSource}\n${uninstallSource}`;
    const cliSourceFiles: any = await fs.readdir(path.dirname(CLIENT_ADAPTER_RUNNER_SOURCE));
    const embeddedAdapterModules: any = cliSourceFiles.filter((filename?: any) : any => filename.endsWith("-adapter.ts"));
    assert.match(installSource, /runClientAdapter/u);
    assert.match(uninstallSource, /runClientAdapter/u);
    assert.deepEqual(embeddedAdapterModules, [], "Core retained an embedded client adapter module");
    assert.equal(
      /from\s+["']\.\/(?!client-adapter-runner\.ts)[^"']*adapter[^"']*["']/u.test(lifecycleSource),
      false,
      "installer lifecycle imported a client-specific adapter implementation"
    );
    return {
      lifecycleProtocol: "external-client-adapter",
      coreClientSpecificAdapterImports: false,
      coreEmbeddedAdapterModules: 0
    };
  });

  await test("standalone install wrapper delegates to the Node installer", async () : Promise<any> => {
    const source: any = await fs.readFile(STANDALONE_INSTALL_WRAPPER, "utf8");
    assert.match(source, /from "@meshrix\/protocols\/mcp\/adapter\/gateway-installer\/bin\/meshrix-mcp"/u);
    assert.equal(/\.\.\/\.\.\/packages\//u.test(source), false);
    assert.match(source, /runCli\(\["install"/u);
    assert.equal(/native-installer|powershell|\/bin\/sh/u.test(source), false);
    return {
      wrapper: STANDALONE_INSTALL_WRAPPER,
      delegatesTo: "gateway-installer Node CLI"
    };
  });

  await destructiveTest("release guidance never executes an unverified network response", async () : Promise<any> => {
    for (const filePath of VERIFIED_DOWNLOAD_GUIDANCE_FILES) {
      const source: any = await fs.readFile(filePath, "utf8");
      assert.equal(/curl[^\n]*(?:\||\$\()[^\n]*(?:sh|bash)|(?:sh|bash)[^\n]*<\([^\n]*curl/iu.test(source), false, `${filePath} contains remote shell execution`);
    }
    const releaseTemplate: any = await fs.readFile(".github/RELEASE_TEMPLATE.md", "utf8");
    const releaseSource: any = await fs.readFile("tools/server-scripts/mcp-release.ts", "utf8");
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

  await test("canonical installer doctor verifies real MCP discovery without host path leakage", async () : Promise<any> => {
    const result: any = await runNode(PROTOCOL_INSTALLER_BIN, ["doctor", "--url", server.url, "--token-env", DOCTOR_TOKEN_ENV, "--json"], doctorEnv(manifestPath));
    const payload: any = parseJsonOutput(result.stdout, "installer doctor");
    assert.equal(result.status, 0, `installer doctor failed against real server: ${JSON.stringify({
      ok: payload.ok === true,
      signedDiscovery: payload.checks?.signedDiscovery?.ok === true,
      discovery: payload.checks?.discovery?.ok === true,
      discover: payload.checks?.discover?.ok === true,
      toolsSkipped: payload.checks?.toolsList?.skipped === true,
      systemHealthSkipped: payload.checks?.systemHealth?.skipped === true,
      nextCommand: payload.nextCommand || ""
    })}`);
    assert.equal(payload.checks?.discovery?.ok, true);
    assert.equal(payload.checks?.discover?.ok, true);
    assertRedactedDeviceManifest(payload, "installer doctor", true);
    return {
      ok: payload.ok === true,
      discoveryStatus: payload.checks?.discovery?.status,
      manifestPathRedacted: payload.checks?.deviceManifest?.pathRedacted === true,
      installedTargets: payload.checks?.deviceManifest?.installedTargets || []
    };
  });

  await test("native installer lifecycle joins signed discovery to reference-only configuration without credential provisioning", async () : Promise<any> => {
    const client = path.join(userDataPath, "synthetic-client.mjs");
    const config = path.join(userDataPath, "native-mcp.json");
    const registry = path.join(userDataPath, "native-registration.json");
    await fs.copyFile("tests/plugins/fixtures/fake-mcp-client.mjs", client);
    await fs.chmod(client, 0o700);
    const initial = { preference: "retained", mcpServers: { other: { command: "independent" } } };
    await fs.writeFile(config, JSON.stringify(initial), { mode: 0o600 });
    const args = ["--url", server.url, "--target", "pi", "--server-name", "synthetic", "--token-env", DOCTOR_TOKEN_ENV, "--client-command", client, "--client-config", config, "--discovery-file", registry, "--json"];
    const installed = await runInstallerCli(["install", ...args], doctorEnv(registry));
    assert.equal(installed.status, 0);
    const result = parseJsonOutput(installed.stdout);
    assert.equal(result.installed.pi.status, "configured");
    assert.equal(result.installed.pi.credentialStatus, "external-reference-unverified");
    assert.equal(result.installed.pi.connectivity, "not-run");
    assert.equal(result.installed.pi.credentialStored, false);
    assert.equal(result.installed.pi.environmentProvisioned, false);
    const stored = JSON.parse(await fs.readFile(config, "utf8"));
    assert.deepEqual(stored.mcpServers.synthetic, { url: `${server.url}/mcp`, headers: { "X-Meshrix.js-Api-Key": `\${${DOCTOR_TOKEN_ENV}}` } });
    assert.deepEqual(stored.mcpServers.other, initial.mcpServers.other);
    const removed = await runInstallerCli(["uninstall", ...args], doctorEnv(registry));
    assert.equal(removed.status, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(config, "utf8")), initial);
    const stdin = await runNode(PROTOCOL_INSTALLER_BIN, ["install", "--target", "pi", "--token-stdin", "--json"], doctorEnv(registry), { closeStdin: true });
    assert.notEqual(stdin.status, 0);
    assert.equal(parseJsonOutput(stdin.stdout || stdin.stderr).errorCode, "credential_handoff_required");
    return { signedDiscovery: true, configured: true, externalCredentialUnverified: true, nativeConnectivity: "not-run", unrelatedConfigurationPreserved: true, stdinHandoffRefused: true };
  });

  await test("Node installer discover-local uses redacted output contract", async () : Promise<any> => {
    const result: any = await runInstallerCli(["discover-local", "--url", server.url, "--json"], doctorEnv(manifestPath));
    assert.equal(result.status, 0, `Node installer discover-local failed against real server (status=${result.status}, stdoutBytes=${Buffer.byteLength(result.stdout)}, stderrBytes=${Buffer.byteLength(result.stderr)})`);
    const payload: any = parseJsonOutput(result.stdout, "Node installer discover-local");
    assert.equal(payload.ok, true);
    assert.equal(payload.baseUrl, server.url);
    return {
      ok: payload.ok === true,
      sourceType: payload.sourceType
    };
  });

  await destructiveTest("marker-only discovery response is rejected without a signed handshake", async () : Promise<any> => {
    const markerServer: any = createServer((request?: any, response?: any) : any => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        name: "Meshrix.js",
        interfaceVersion: "v0.0.1:mcp:interface-1",
        stableToolName: "meshrix.discovery"
      }));
    });
    await new Promise((resolve?: any, reject?: any) : any => {
      markerServer.once("error", reject);
      markerServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address: any = markerServer.address();
      const fakeUrl: any = `http://127.0.0.1:${address.port}`;
      const result: any = await runInstallerCli(["discover-local", "--url", fakeUrl, "--json"], doctorEnv(missingManifestPath));
      assert.notEqual(result.status, 0);
      assert.equal(/"ok"\s*:\s*true/u.test(result.stdout), false);
      return {
        rejected: true,
        signedHandshakeRequired: true
      };
    } finally {
      await new Promise((resolve?: any) : any => markerServer.close(resolve));
    }
  });

  await test("standalone mcp-doctor honors temporary device manifest without host path leakage", async () : Promise<any> => {
    const result: any = await runNode(STANDALONE_DOCTOR, ["--url", server.url], doctorEnv(manifestPath));
    assert.equal(result.status, 0, "standalone mcp-doctor failed against real server");
    const payload: any = parseJsonOutput(result.stdout, "standalone mcp-doctor");
    assert.equal(payload.checks?.discovery?.ok, true);
    assert.equal(payload.checks?.discover?.ok, true);
    assertRedactedDeviceManifest(payload, "standalone mcp-doctor", true);
    return {
      ok: payload.ok === true,
      manifestPathRedacted: payload.checks?.deviceManifest?.pathRedacted === true
    };
  });

  await destructiveTest("missing device manifest never leaks the requested host path", async () : Promise<any> => {
    const installer: any = await runNode(PROTOCOL_INSTALLER_BIN, ["doctor", "--url", server.url, "--token-env", DOCTOR_TOKEN_ENV, "--json"], doctorEnv(missingManifestPath));
    const installerPayload: any = parseJsonOutput(installer.stdout, "installer missing-manifest doctor");
    assertRedactedDeviceManifest(installerPayload, "installer missing-manifest doctor", false);

    const standalone: any = await runNode(STANDALONE_DOCTOR, ["--url", server.url], doctorEnv(missingManifestPath));
    assert.equal(standalone.status, 0);
    const standalonePayload: any = parseJsonOutput(standalone.stdout, "standalone missing-manifest doctor");
    assertRedactedDeviceManifest(standalonePayload, "standalone missing-manifest doctor", false);

    return {
      installerStatus: installer.status,
      installerWarnOnly: installerPayload.ok === true,
      standaloneStatus: standalone.status,
      redactionVerified: true
    };
  });

  await writeReport();
  const failed = [...report.tests, ...report.destructiveTests].filter(item => item.status === "failed").length;
  if (failed) process.exitCode = 1;
  console.log(`\n=== MCP Installer Convergence ${failed ? "failed" : "passed"}; report: ${REPORT_PATH} ===`);
} catch (error: any) {
  report.executionFailure = safeEvidence(failureEvidence(error));
  await writeReport().catch(() : any => {});
  console.error(JSON.stringify(safeEvidence({
    ok: false,
    verifier: "tools/server-scripts/verify-mcp-installer-convergence.ts",
    failure: failureEvidence(error)
  }), null, 2));
  process.exitCode = 1;
} finally {
  await server?.close?.();
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
  await fs.rm(keyRoot, { recursive: true, force: true });
  if (previousMasterKeyFile === undefined) delete process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE;
  else process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE = previousMasterKeyFile;
  restoreCapabilityKernelEnv();
}
