#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { installAuthenticatedFetch } from "./test-auth-helper.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";
import {
  bindVerifierLocalMcpGrantIdentity,
  createVerifierLocalMcpGrantIdentity,
  verifierMcpRequestHeaders
} from "./lib/local-mcp-verifier-identity.mjs";
import { startDownstreamMcpProductFixtureServer } from "./lib/downstream-mcp-product-fixture.mjs";
import { createDownstreamMcpProductE2eWorkflows } from "./lib/downstream-mcp-product-e2e-workflows.mjs";
import { issueVerifierLocalMcpGrant } from "./lib/local-mcp-device-authorization.mjs";
import {
  writeVerifierLocalUpstreamSecret,
  seedVerifierUpstreamServices,
  verifierOpaqueServiceId
} from "./lib/upstream-gateway-verifier-publication.mjs";
import { MCP_INTERFACE_VERSION } from "../../packages/protocols/mcp/adapter/http-mcp-adapter-constants.mjs";
import {
  compileUpstreamOperationCapability
} from "../../packages/agents/src/upstream-gateway/operation-capability.mjs";
import { pluginArtifactCoreContractDigest } from "../../packages/server-runtime/src/composition/plugin-artifact-core-contract.mjs";
import { stagePluginArtifactVerificationFixture } from "./lib/plugin-artifact-verification-fixture.mjs";

const REPORT_PATH = "build/reports/downstream-mcp-product-e2e.json";
const SERVICE_ID = verifierOpaqueServiceId("verify-downstream-mcp-product");
const APPROVAL_TOOL = "lico.tagManagement.tags.upsert";
const SECRET_REF = "secret://verify/downstream-mcp-product/token";
const RAW_SECRET = "downstream-product-raw-token-must-not-leak";
const RESOLVED_SECRET_TOKEN = "resolved-downstream-product-token-must-not-leak";
const RELAY_TARGET_ID = "downstream-product-target";
const RELAY_VIRTUAL_AGENT_ID = "downstream-product-agent";
const MAIN_TOOLSETS = Object.freeze([
  "lico.storage.read",
  "lico.console.read",
  "lico.gateway.read",
  "lico.gateway.write",
  "lico.agent.workspace",
  "lico.storage.write",
  "lico.agent.relay"
]);
const MAIN_UPSTREAM_CAPABILITIES = Object.freeze(["echo", "fail"].map((operationKey) =>
  compileUpstreamOperationCapability(
    { serviceId: SERVICE_ID, credentialRefs: [SECRET_REF] },
    { operationKey }
  )
));
const MAIN_DYNAMIC_CAPABILITIES = Object.freeze(MAIN_UPSTREAM_CAPABILITIES.map((item) => item.capabilityId));
const MAIN_ALLOWED_SECRET_BINDINGS = Object.freeze([
  ...new Set(MAIN_UPSTREAM_CAPABILITIES.flatMap((item) => item.credentialBindingIds))
]);

function verifierClientRuntimeHost() {
  return {
    enabled: true,
    processIdentity: { enabled: true },
    clientExecution: {
      enabled: true,
      targets: [{
        targetRef: "verify-downstream-acp-target",
        workloadKind: "acp-client-runtime",
        resultPath: "result.json",
        invocation: { args: [], workingDirectory: "work" },
        outputs: {
          schema: "acp-result",
          maxFiles: 1,
          maxBytes: 65_536,
          allowedTypes: ["application/json"]
        },
        capabilities: {
          filesystem: ["input:read", "output:write"],
          network: [],
          tools: [],
          secretRefs: [],
          clock: false,
          randomness: false,
          subprocesses: 0
        },
        resources: {
          wallTimeMs: 30_000,
          cpuMillis: 10_000,
          memoryBytes: 134_217_728,
          processes: 4,
          fileDescriptors: 64,
          diskBytes: 1_048_576,
          inodes: 64,
          fileCount: 16,
          outputBytes: 65_536,
          logBytes: 16_384,
          networkBytes: 1,
          toolCalls: 1
        }
      }]
    }
  };
}

function verifierAcpRelayConfiguration() {
  return {
    targets: {
      [RELAY_TARGET_ID]: {
        targetId: RELAY_TARGET_ID,
        targetRef: "verify-downstream-acp-target",
        label: "Downstream MCP product verifier target",
        communication: {
          protocol: "acp",
          mode: "client_runtime_port",
          finalResponsePolicy: "client_runtime_terminal_projection"
        },
        capabilityPolicy: { writes: "deny", terminal: "deny", maxRisk: "read_only" },
        metadata: { public: { frameworkId: "downstream-product-e2e" } }
      }
    },
    virtualAgents: {
      [RELAY_VIRTUAL_AGENT_ID]: {
        virtualAgentId: RELAY_VIRTUAL_AGENT_ID,
        targetId: RELAY_TARGET_ID,
        displayName: "Downstream MCP product verifier agent",
        advertisedModes: ["ask"],
        defaultMode: "ask",
        capabilityPolicy: { writes: "deny", terminal: "deny", maxRisk: "read_only" },
        enabled: true
      }
    }
  };
}

const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-downstream-mcp-product-"));
const repoRoot = path.resolve(import.meta.dirname, "../..");
const dynamicSecretNeedles = new Set([userDataPath, os.homedir()].filter(Boolean));
const fixtureState = {
  echoCount: 0
};
const report = {
  schemaVersion: "v0.0.1:mcp:downstream-product-e2e-report-1",
  verifier: "tools/server-scripts/verify-downstream-mcp-product-e2e.mjs",
  startedAt: new Date().toISOString(),
  algorithm: {
    protocol: "MCP JSON-RPC 2.0 over the real /mcp HTTP endpoint.",
    outletCoverage: "Every outlet discovered from currently visible core and enabled-plugin descriptors must execute at least one real operation; gateway, Shared Space, and Agent Relay include governed writes.",
    fixture: "Gateway forwarding uses an in-process HTTP upstream bound to loopback and reached through the real upstream gateway client.",
    destructiveChecks: "Wrong outlet, insufficient grant, approval-required, stale-policy, expired grant, revoked token, malformed JSON, runtime failure, and grant rate-limit requests must be handled without process failure."
  },
  tests: [],
  destructiveTests: [],
  summary: {}
};

let server = null;
let fixture = null;
let pluginArtifactFixture = null;
let fixtureUrl = "";
let exitCode = 0;
const mcpIdentityByToken = new Map();

function trackSecret(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      dynamicSecretNeedles.add(text);
    }
  }
}

function closeServer(target) {
  return new Promise((resolve) => {
    if (!target?.close) {
      resolve();
      return;
    }
    target.close(() => resolve());
  });
}

function redactText(value = "") {
  let text = String(value || "");
  for (const needle of dynamicSecretNeedles) {
    if (needle && text.includes(needle)) {
      text = text.split(needle).join("[redacted]");
    }
  }
  if (fixtureUrl) {
    text = text.split(fixtureUrl).join("[redacted-upstream-url]");
    text = text.split(new URL(fixtureUrl).host).join("[redacted-upstream-host]");
  }
  text = text.split(RAW_SECRET).join("[redacted-raw-secret]");
  text = text.split(SECRET_REF).join("[redacted-secret-ref]");
  text = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  text = text.replace(/"token"\s*:\s*"[^"]+"/gi, "\"token\":\"[redacted]\"");
  text = text.replace(/lico_[A-Za-z0-9_-]{12,}/g, "lico_[redacted]");
  return text;
}

function safeEvidence(value = {}) {
  return JSON.parse(JSON.stringify(value, (_, child) => {
    if (typeof child !== "string") {
      return child;
    }
    return redactText(child);
  }));
}

function assertNoLeakText(text = "", label = "text") {
  const value = String(text || "");
  for (const needle of dynamicSecretNeedles) {
    assert.equal(value.includes(needle), false, `${label} leaked a redacted verifier value`);
  }
  assert.equal(fixtureUrl && value.includes(fixtureUrl), false, `${label} leaked upstream URL`);
  assert.equal(value.includes(RAW_SECRET), false, `${label} leaked raw secret`);
  assert.equal(value.includes(SECRET_REF), false, `${label} leaked secret ref`);
  assert.equal(/Bearer\s+(?!\[redacted\])\S+/i.test(value), false, `${label} leaked bearer token`);
  assert.equal(/"token"\s*:\s*"(?!\[redacted\])[^"]+"/i.test(value), false, `${label} leaked token field`);
  assert.equal(/lico_[A-Za-z0-9_-]{12,}/.test(value), false, `${label} leaked cookie or token-like value`);
}

function assertNoLeak(value, label = "payload") {
  assertNoLeakText(JSON.stringify(value), label);
}

function assertNoRuntimeSecretLeak(value, label = "payload") {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(userDataPath), false, `${label} leaked verifier data path`);
  assert.equal(serialized.includes(os.homedir()), false, `${label} leaked user home path`);
  assert.equal(serialized.includes(RAW_SECRET), false, `${label} leaked raw secret`);
  assert.equal(/Bearer\s+\S+/i.test(serialized), false, `${label} leaked bearer token`);
  assert.equal(/"token"\s*:\s*"[^"]+"/i.test(serialized), false, `${label} leaked token field`);
  assert.equal(/lico_[A-Za-z0-9_-]{12,}/.test(serialized), false, `${label} leaked cookie or token-like value`);
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  report.summary.testCount = report.tests.length;
  report.summary.destructiveTestCount = report.destructiveTests.length;
  report.summary.failedCount = [...report.tests, ...report.destructiveTests].filter((item) => item.status !== "passed").length;
  report.summary.releaseReady = report.summary.failedCount === 0;
  report.summary.reportLeakScan = true;
  assertNoLeak(report, "downstream MCP product E2E report");
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
    status: Number(error?.status || 0) || 0
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

async function fetchJson(routeOrUrl, options = {}) {
  const { allowSecretPayload = false, ...fetchOptions } = options;
  const url = String(routeOrUrl).startsWith("http")
    ? routeOrUrl
    : `${server.url}${routeOrUrl}`;
  const response = await fetch(url, fetchOptions);
  const text = await response.text();
  const payload = text.trim() ? JSON.parse(text) : {};
  if (!allowSecretPayload) {
    assertNoRuntimeSecretLeak(payload, String(routeOrUrl));
  }
  return { status: response.status, ok: response.ok, payload };
}

async function api(method, route, body = undefined) {
  return fetchJson(route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function consoleGrant(input = {}) {
  const response = await fetchJson("/api/operation-permission/v1/grants", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-lico-safety-confirm": "true" },
    body: JSON.stringify(input),
    allowSecretPayload: true
  });
  assert.equal(response.status, 201, JSON.stringify(safeEvidence(response.payload)));
  const token = response.payload.token || "";
  const grantId = response.payload.grant?.id || "";
  assert.ok(token, "grant create did not return a token");
  trackSecret(token, grantId, response.payload.grant?.tokenPrefix);
  return { token, grantId, grant: response.payload.grant };
}

async function localMcpGrant({
  label,
  toolsets,
  grantMode = "maintain",
  dynamicCapabilities = [],
  allowedServiceIds = [],
  allowedSecretBindings = []
} = {}) {
  const verifierIdentity = createVerifierLocalMcpGrantIdentity({
    target: "codex",
    label: label || "verify-downstream-mcp-product"
  });
  const response = await issueVerifierLocalMcpGrant({
    server,
    grantRequest: {
      targets: ["codex"],
      label,
      grantMode,
      toolsets,
      dynamicCapabilities,
      allowedServiceIds,
      allowedSecretBindings,
      connectorVersion: "verify-downstream-mcp-product-e2e",
      processIdentity: verifierIdentity.request
    }
  });
  assert.equal(response.status, 201, JSON.stringify(safeEvidence(response.payload)));
  const token = response.payload.token || "";
  const grantId = response.payload.grant?.id || "";
  assert.ok(token, "local MCP grant did not return a token");
  trackSecret(token, grantId, response.payload.tokenPrefix, response.payload.grant?.tokenPrefix);
  bindVerifierLocalMcpGrantIdentity({
    identityByToken: mcpIdentityByToken,
    token,
    identity: verifierIdentity.identity,
    payload: response.payload
  });
  return { token, grantId, grant: response.payload.grant };
}

function mcpHeaders(token, { body = "" } = {}) {
  return verifierMcpRequestHeaders({
    identityByToken: mcpIdentityByToken,
    token,
    target: "codex",
    method: "POST",
    url: `${server.url}/mcp`,
    body
  });
}

async function callMcp(token, toolName, operation, input = {}, id = 1, expectedHttpStatuses = [200]) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: {
        apiVersion: MCP_INTERFACE_VERSION,
        operation,
        input,
        clientVersion: "verify-downstream-mcp-product-e2e"
      }
    }
  });
  const response = await fetchJson("/mcp", {
    method: "POST",
    headers: mcpHeaders(token, { body }),
    body
  });
  assert.equal(
    expectedHttpStatuses.includes(response.status),
    true,
    `Unexpected MCP HTTP status ${response.status}: ${JSON.stringify(safeEvidence(response.payload))}`
  );
  return response.payload;
}

async function listMcpTools(token, id = 9) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: {}
  });
  const response = await fetchJson("/mcp", {
    method: "POST",
    headers: mcpHeaders(token, { body }),
    body
  });
  assert.equal(response.status, 200, JSON.stringify(safeEvidence(response.payload)));
  assert.equal(response.payload.error, undefined, JSON.stringify(safeEvidence(response.payload.error || {})));
  return response.payload.result?.tools || [];
}

function mcpPayload(jsonRpcPayload = {}) {
  return jsonRpcPayload?.result?.structuredContent?.payload ||
    jsonRpcPayload?.result?.structuredContent ||
    jsonRpcPayload?.result ||
    {};
}

function assertMcpOk(payload, label) {
  assert.equal(payload.error, undefined, `${label} returned MCP error: ${JSON.stringify(safeEvidence(payload.error || {}))}`);
}

function operationNames(capabilities = {}) {
  return new Set((capabilities.operations || []).map((operation) => operation.name));
}

function mcpErrorCode(payload = {}) {
  return payload.error?.data?.code || payload.error?.code || "";
}

const workflows = createDownstreamMcpProductE2eWorkflows({
  APPROVAL_TOOL,
  SERVICE_ID,
  api,
  assertMcpOk,
  assertNoLeakText,
  callMcp,
  consoleGrant,
  fetchJson,
  fixtureState,
  getServerUrl: () => server.url,
  localMcpGrant,
  listMcpTools,
  mcpErrorCode,
  mcpPayload,
  operationNames,
  relayVirtualAgentId: RELAY_VIRTUAL_AGENT_ID,
  redactText,
  safeEvidence,
  trackSecret
});

try {
  const fixtureStarted = await startDownstreamMcpProductFixtureServer(fixtureState);
  fixture = fixtureStarted.server;
  fixtureUrl = fixtureStarted.url;
  trackSecret(fixtureUrl, new URL(fixtureUrl).host);

  await seedVerifierUpstreamServices({
    userDataPath,
    services: [
      {
        serviceId: SERVICE_ID,
        label: "Downstream MCP product verifier upstream",
        baseUrl: fixtureUrl,
        healthPath: "/health",
        credentialRefs: [SECRET_REF],
        trafficPolicy: { perMinute: 60, burst: 20 },
        operations: [
          {
            operationKey: "echo",
            method: "POST",
            path: "/echo",
            risk: "safe_write",
            requiredScopes: ["gateway:write"]
          },
          {
            operationKey: "approval",
            method: "POST",
            path: "/echo",
            risk: "repair_write",
            requiredScopes: ["gateway:maintain"],
            requiresApproval: true
          },
          {
            operationKey: "fail",
            method: "POST",
            path: "/fail",
            risk: "safe_write",
            requiredScopes: ["gateway:write"]
          }
        ]
      }
    ]
  });
  await writeVerifierLocalUpstreamSecret({
    userDataPath,
    fixtureUrl,
    secretRef: SECRET_REF,
    resolvedSecretToken: RESOLVED_SECRET_TOKEN,
    serviceId: SERVICE_ID,
    provider: "downstream-mcp-product-e2e",
    family: "upstream-gateway",
    authType: "bearer",
    scopes: ["gateway:read", "gateway:write", "gateway:maintain"],
    trackSecret
  });

  pluginArtifactFixture = await stagePluginArtifactVerificationFixture({
    sourcePluginRoot: path.join(repoRoot, "plugins"),
    artifactRoot: path.join(userDataPath, "plugin-artifacts"),
    userDataPath,
    coreContractDigest: pluginArtifactCoreContractDigest(),
    runtimeDependencyPackages: {
      "client-link": ["better-sqlite3", "bindings", "file-uri-to-path"]
    }
  });

  server = await startHttpServer({
    userDataPath,
    distPath: "",
    port: 0,
    runtimeOptions: {
      cwd: repoRoot,
      profile: "minimal",
      enableFeatures: ["upstream-gateway", "operation-permission-core"],
      enabledPlugins: ["client-link", "shared-space"],
      pluginArtifactTrustedPublicKeys: pluginArtifactFixture.trustedPublicKeys,
      pluginConfigurations: {
        "client-link": {
          hostCapabilities: [
            "owner-process-identity",
            "controlled-execution",
            "protected-recovery",
            "downstream-client-aspect",
            "outbound-egress-policy"
          ],
          hostCapabilityConfiguration: {
            "controlled-execution": verifierClientRuntimeHost().clientExecution,
            "downstream-client-aspect": { enabled: true, start: true, startOptions: {} }
          },
          enabledSubmodules: ["client-runtime", "acp-relay"],
          submodules: {
            "client-runtime": { productionHost: verifierClientRuntimeHost() },
            "acp-relay": verifierAcpRelayConfiguration()
          }
        }
      }
    }
  });
  trackSecret(server.url, new URL(server.url).host);
  await installAuthenticatedFetch(server);

  console.log("\n=== Downstream MCP Product E2E: outlet, governance, audit, and destructive verifier ===\n");

  const gatewayRegistration = await workflows.readGatewayFixture();
  const operationCatalog = await api("GET", "/api/operation-permission/v1/catalog");
  const relayTool = (operationCatalog.payload?.tools || []).find((tool) =>
    tool.id === "lico.agentRelay.session.create"
  );
  console.log(JSON.stringify({
    relayToolInCatalog: Boolean(relayTool),
    relayToolsets: relayTool?.toolsets || [],
    relayRequiredScopes: relayTool?.requiredScopes || []
  }));
  const mainGrant = await localMcpGrant({
    label: "Downstream MCP product E2E verifier",
    toolsets: [...MAIN_TOOLSETS],
    grantMode: "maintain",
    dynamicCapabilities: [...MAIN_DYNAMIC_CAPABILITIES],
    allowedServiceIds: [SERVICE_ID],
    allowedSecretBindings: [...MAIN_ALLOWED_SECRET_BINDINGS]
  });
  console.log(JSON.stringify({
    agentRelayToolsetGranted: (mainGrant.grant?.toolsets || []).includes("lico.agent.relay"),
    agentRelayScopes: (mainGrant.grant?.scopes || [])
      .filter((scope) => String(scope).startsWith("agent_relay:"))
      .sort()
  }));

  await test("discovery and gateway outlets execute concrete operations", async () => ({
    gatewayRegistration,
    ...(await workflows.verifyDiscoveryAndGateway({ token: mainGrant.token }))
  }));
  await test("sharedspace outlet creates uploads and downloads real workspace state", async () => workflows.verifySharedSpace({ token: mainGrant.token }));
  await test("agent relay outlet creates lists and closes a real relay session", async () => workflows.verifyAgentRelay({ token: mainGrant.token }));
  await test("tool execution audit and metrics cover every exercised outlet", workflows.verifyAuditAndMetrics);
  await destructiveTest("denial rate-limit revoked malformed and wrong-outlet inputs", async () => workflows.verifyDenialsAndRateLimit({
    mainToken: mainGrant.token
  }));
} catch (error) {
  console.error(`FAIL: ${redactText(error?.message || String(error))}`);
  if (process.env.LICO_VERIFY_VERBOSE) {
    console.error(redactText(error?.stack || String(error)));
  }
  exitCode = 1;
} finally {
  try {
    await writeReport();
  } catch (error) {
    console.error(`FAIL: could not write report: ${redactText(error?.message || String(error))}`);
    exitCode = 1;
  }
  if (server?.close) {
    await server.close();
  }
  await closeServer(fixture);
  await pluginArtifactFixture?.close().catch(() => {});
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  restoreCapabilityKernelEnv();
}

if (exitCode === 0) {
  console.log(`PASS: downstream MCP product E2E verified; report: ${REPORT_PATH}`);
}

process.exit(exitCode);
