#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { createServerUpstreamGatewayRegistry } from "../../packages/server-runtime/src/composition/server-runtime-providers.mjs";
import { executeConsoleDomainOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executor.mjs";
import { compileUpstreamOperationCapability } from "../../packages/agents/src/upstream-gateway/operation-capability.mjs";
import { installAuthenticatedFetch } from "./test-auth-helper.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";
import { createSignedMcpHeaders, createVerifierMcpProcessIdentity } from "./mcp-process-identity-test-helper.mjs";
import { createUpstreamGatewayFixture, createUpstreamGatewayE2eServices, gatewayOperationNames, runConcurrentTrafficSlotWorkflow, structuredPayload } from "./lib/upstream-gateway-e2e-helpers.mjs";
import { loadVerifierPublishedServices, seedVerifierUpstreamServices, verifierOpaqueServiceId, writeVerifierLocalUpstreamSecret } from "./lib/upstream-gateway-verifier-publication.mjs";
import { createRawMcpCaller, runAggregateTrafficPolicyWorkflow, runEndpointPoolWorkflow, runProjectedToolWorkflows, runUrlAuthorityEscapeWorkflow } from "./lib/upstream-gateway-projected-tools-workflows.mjs";
import { issueVerifierLocalMcpGrant } from "./lib/local-mcp-device-authorization.mjs";

const REPORT_PATH = "build/reports/upstream-gateway-e2e.json";
const MCP_INTERFACE_VERSION = "v0.0.1:mcp:interface-1";
const VERIFIED_TRAFFIC_ALGORITHM = "token_bucket_with_concurrency";
const VERIFIED_ROUTING_ALGORITHM = "weighted_endpoint_round_robin_with_circuit_breaker";
const [SERVICE_ID, LIMITED_SERVICE_ID, CONCURRENT_LIMITED_SERVICE_ID, AGGREGATE_LIMITED_SERVICE_ID, LOAD_BALANCED_SERVICE_ID, DISABLED_SERVICE_ID] = [
  "verify-upstream-gateway", "verify-upstream-gateway-limited", "verify-upstream-gateway-concurrent-limited",
  "verify-upstream-gateway-aggregate-limited", "verify-upstream-gateway-endpoint-pool", "verify-upstream-gateway-disabled"
].map(verifierOpaqueServiceId);
const [SECRET_REF, RAW_TOKEN, RESOLVED_SECRET_TOKEN, BAD_SECRET, BODY_SECRET] = [
  "secret://verify/upstream/token", "raw-token-must-be-redacted", "resolved-upstream-e2e-token-must-be-redacted",
  "bad-secret", "json-rpc-body-secret-must-be-redacted"
];

const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-upstream-gateway-"));
const gatewayFixture = createUpstreamGatewayFixture({
  resolvedSecretToken: RESOLVED_SECRET_TOKEN
});
const fixtureState = gatewayFixture.state;
const report = {
  schemaVersion: "v0.0.1:upstream-gateway:e2e-report-1",
  verifier: "tools/server-scripts/verify-upstream-gateway-e2e.mjs",
  startedAt: new Date().toISOString(),
  tests: [],
  destructiveTests: [],
  summary: {}
};

let server = null;
let fixture = null;
let fixtureUrl = "";
let failingFixture = null;
let failingFixtureUrl = "";
let failingFixtureState = null;
let consoleUpstreamGatewayRegistry = null;
const dynamicSecretNeedles = new Set();
const mcpIdentityByToken = new Map();
let configuredServices = [];

function safeEvidence(value = {}) {
  const fixtureHost = fixtureUrl ? new URL(fixtureUrl).host : "";
  return JSON.parse(JSON.stringify(value, (_, child) => {
    if (typeof child !== "string") {
      return child;
    }
    for (const needle of dynamicSecretNeedles) {
      if (needle && child.includes(needle)) {
        return "[redacted-dynamic-secret]";
      }
    }
    if (child.includes(userDataPath) || child.includes(os.homedir())) {
      return "[redacted-local-path]";
    }
    if ((fixtureUrl && child.includes(fixtureUrl)) || (fixtureHost && child.includes(fixtureHost))) {
      return "[redacted-upstream-url]";
    }
    if (child.includes(BODY_SECRET)) {
      return "[redacted-body-secret]";
    }
    if (child.includes(SECRET_REF)) {
      return "[redacted-secret-ref]";
    }
    if (/Bearer\s+\S+/i.test(child) || /lico_[a-z0-9_-]+=/i.test(child)) {
      return "[redacted-secret]";
    }
    return child;
  }));
}

function assertNoLeak(value, label = "payload") {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(userDataPath), false, `${label} leaked verifier data path`);
  assert.equal(serialized.includes(os.homedir()), false, `${label} leaked user home path`);
  assert.equal(serialized.includes(RAW_TOKEN), false, `${label} leaked raw credential`);
  assert.equal(serialized.includes(BAD_SECRET), false, `${label} leaked rejected raw credential`);
  assert.equal(serialized.includes(BODY_SECRET), false, `${label} leaked body secret`);
  for (const needle of dynamicSecretNeedles) {
    assert.equal(needle ? serialized.includes(needle) : false, false, `${label} leaked dynamic secret`);
  }
  assert.equal(/Bearer\s+\S+/i.test(serialized), false, `${label} leaked bearer token`);
  assert.equal(/lico_[a-z0-9_-]+=/i.test(serialized), false, `${label} leaked cookie`);
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  const outcomes = new Map([...report.tests, ...report.destructiveTests].map((item) => [item.name, item.status]));
  report.summary.testCount = report.tests.length;
  report.summary.destructiveTestCount = report.destructiveTests.length;
  report.summary.failedCount = [...report.tests, ...report.destructiveTests].filter((item) => item.status !== "passed").length;
  report.summary.reportLeakScan = true;
  report.summary.trafficControlAlgorithm = VERIFIED_TRAFFIC_ALGORITHM;
  report.summary.routingAlgorithm = VERIFIED_ROUTING_ALGORITHM;
  report.summary.tokenBucketTrafficVerified =
    outcomes.get("traffic-control rejection is deterministic") === "passed";
  report.summary.concurrentTrafficVerified =
    outcomes.get("traffic-control enforces concurrent in-flight slots") === "passed";
  report.summary.serviceAggregateTrafficVerified =
    outcomes.get("endpoint pools share the service-level aggregate traffic policy") === "passed";
  report.summary.downstreamMcpDistributionVerified =
    outcomes.get("configured upstream operations are projected as MCP tools and execute through Operation Permission") === "passed";
  report.summary.downstreamMcpDistributionOperation = "lico.gateway.forward";
  report.summary.concurrentMcpForwardingVerified =
    outcomes.get("concurrent MCP forwarding is isolated and counted") === "passed";
  report.summary.releaseReady = report.summary.failedCount === 0;
  assertNoLeak(report, "upstream gateway e2e report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function record(collection, name, status, evidence = {}) {
  collection.push({ name, status, evidence });
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
    record(report.tests, name, "passed", safeEvidence(evidence));
    console.log("ok");
  } catch (error) {
    record(report.tests, name, "failed", safeEvidence(failureEvidence(error)));
    console.log("FAIL");
    throw error;
  }
}

async function destructiveTest(name, fn) {
  process.stdout.write(`  destructive ${name} ... `);
  try {
    const evidence = await fn();
    record(report.destructiveTests, name, "passed", safeEvidence(evidence));
    console.log("ok");
  } catch (error) {
    record(report.destructiveTests, name, "failed", safeEvidence(failureEvidence(error)));
    console.log("FAIL");
    throw error;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text.trim() ? JSON.parse(text) : {};
  assertNoLeak(payload, url.replace(server?.url || "", ""));
  return { status: response.status, ok: response.ok, payload };
}

function mcpRequest(method, params = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

async function api(method, route, body = undefined) {
  return fetchJson(`${server.url}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function rpc(method, params = {}, id = 9000) {
  const response = await fetchJson(`${server.url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  assert.equal(response.status, 200);
  assertNoLeak(response.payload, `rpc ${method}`);
  return response.payload;
}

async function consoleOperation(operationId, input = {}) {
  if (!consoleUpstreamGatewayRegistry) {
    consoleUpstreamGatewayRegistry = createServerUpstreamGatewayRegistry({ userDataPath });
    await loadVerifierPublishedServices({ userDataPath, registry: consoleUpstreamGatewayRegistry });
  }
  const result = await executeConsoleDomainOperation({
    operationId,
    input,
    context: {
      userDataPath,
      upstreamGatewayRegistry: consoleUpstreamGatewayRegistry,
      subject: {
        subjectId: "verifier-console-subject",
        roleId: "admin",
        scopes: ["gateway:read", "gateway:write", "gateway:maintain", "gateway:admin"]
      }
    }
  });
  assertNoLeak(result, `console ${operationId}`);
  return result;
}

async function createGrant(label, toolsets, extra = {}) {
  const descriptors = configuredServices.flatMap((service) =>
    (service.operations || []).map((operation) => compileUpstreamOperationCapability(service, operation))
  );
  const dynamicCapabilities = Object.hasOwn(extra, "dynamicCapabilities")
    ? extra.dynamicCapabilities
    : descriptors.map((descriptor) => descriptor.capabilityId);
  const allowedServiceIds = Object.hasOwn(extra, "allowedServiceIds")
    ? extra.allowedServiceIds
    : configuredServices.map((service) => service.serviceId);
  const allowedSecretBindings = Object.hasOwn(extra, "allowedSecretBindings")
    ? extra.allowedSecretBindings
    : descriptors.flatMap((descriptor) => descriptor.credentialBindingIds || []);
  const identity = createVerifierMcpProcessIdentity({ target: "codex", label });
  const response = await issueVerifierLocalMcpGrant({
    server,
    grantRequest: {
      targets: ["codex"],
      label,
      connectorVersion: "verify-upstream-gateway-e2e",
      grantMode: "maintain",
      toolsets,
      dynamicCapabilities,
      allowedServiceIds,
      allowedSecretBindings,
      ...extra,
      processIdentity: identity.request
    }
  });
  assert.equal(response.status, 201, JSON.stringify(response.payload, null, 2));
  assert.ok(response.payload.token);
  assert.ok(response.payload.processIdentity?.clientIdentityPackage);
  dynamicSecretNeedles.add(String(response.payload.token));
  mcpIdentityByToken.set(response.payload.token, {
    identity,
    clientIdentityPackage: response.payload.processIdentity.clientIdentityPackage
  });
  return response.payload.token;
}

async function callMcp(token, toolName, operation, input = {}, id = 1, expectedStatuses = [200]) {
  const binding = mcpIdentityByToken.get(token);
  assert.ok(binding, "MCP token must have a verifier process identity binding");
  const body = JSON.stringify(mcpRequest("tools/call", {
    name: toolName,
    arguments: {
      apiVersion: MCP_INTERFACE_VERSION,
      operation,
      input,
      clientVersion: "verify-upstream-gateway-e2e"
    }
  }, id));
  const response = await fetchJson(`${server.url}/mcp`, {
    method: "POST",
    headers: createSignedMcpHeaders({
      token,
      body,
      nonce: `verify-upstream-gateway-${id}`,
      url: new URL("/mcp", server.url),
      privateKeyPem: binding.identity.keyPair.privateKeyPem,
      clientIdentityPackage: binding.clientIdentityPackage
    }),
    body
  });
  assert.equal(expectedStatuses.includes(response.status), true, `Unexpected MCP HTTP status ${response.status}: ${JSON.stringify(response.payload, null, 2)}`);
  return response.payload;
}

try {
  const fixtureStarted = await gatewayFixture.start();
  fixture = fixtureStarted.server;
  fixtureUrl = fixtureStarted.url;
  const failingGatewayFixture = createUpstreamGatewayFixture({
    resolvedSecretToken: RESOLVED_SECRET_TOKEN,
    failPaths: ["/echo"]
  });
  const failingFixtureStarted = await failingGatewayFixture.start();
  failingFixture = failingFixtureStarted.server;
  failingFixtureUrl = failingFixtureStarted.url;
  failingFixtureState = failingGatewayFixture.state;
  dynamicSecretNeedles.add(failingFixtureUrl);
  dynamicSecretNeedles.add(new URL(failingFixtureUrl).host);

  configuredServices = createUpstreamGatewayE2eServices({
    fixtureUrl,
    secretRef: SECRET_REF,
    serviceId: SERVICE_ID,
    limitedServiceId: LIMITED_SERVICE_ID,
    concurrentLimitedServiceId: CONCURRENT_LIMITED_SERVICE_ID,
    aggregateLimitedServiceId: AGGREGATE_LIMITED_SERVICE_ID,
    loadBalancedServiceId: LOAD_BALANCED_SERVICE_ID,
    failingFixtureUrl,
    disabledServiceId: DISABLED_SERVICE_ID
  });
  await seedVerifierUpstreamServices({
    userDataPath,
    services: configuredServices
  });
  await writeVerifierLocalUpstreamSecret({
    userDataPath,
    fixtureUrl,
    secretRef: SECRET_REF,
    resolvedSecretToken: RESOLVED_SECRET_TOKEN,
    serviceId: SERVICE_ID,
    provider: "upstream-gateway-e2e",
    family: "upstream-gateway",
    authType: "bearer",
    scopes: ["gateway:read", "gateway:write", "gateway:maintain"],
    trackSecret: (value) => dynamicSecretNeedles.add(value)
  });

  server = await startHttpServer({
    userDataPath,
    distPath: "",
    port: 0,
    runtimeOptions: {
      profile: "minimal",
      enableFeatures: ["upstream-gateway", "operation-permission-core"]
    }
  });
  await installAuthenticatedFetch(server);
  const callMcpRaw = createRawMcpCaller({
    getServer: () => server,
    mcpIdentityByToken,
    fetchJson
  });

  console.log("\n=== Upstream Gateway E2E: durable publication, MCP forwarding, destructive inputs ===\n");

  await runUrlAuthorityEscapeWorkflow({ test });

  await test("interfaces expose current upstream gateway operations", async () => {
    const response = await api("GET", "/api/interfaces");
    assert.equal(response.status, 200);
    const ids = new Set((response.payload.interfaces || []).map((item) => item.id));
    for (const id of [
      "external_services.list",
      "external_services.health",
      "external_services.publications.list",
      "external_services.publications.get",
      "external_services.create",
      "external_services.replace",
      "external_services.disable",
      "external_services.remove",
      "external_services.republish",
      "gateway.policy.preview",
      "gateway.forward",
      "gateway.audit",
      "gateway.metrics"
    ]) {
      assert.equal(ids.has(id), true, `${id} missing from interfaces`);
    }
    for (const id of [
      "external_services.register",
      "external_services.update",
      "external_services.refresh"
    ]) {
      assert.equal(ids.has(id), false, `${id} must not be exposed`);
    }
    return { operationCount: ids.size };
  });

  await test("durable manifest fixture is loaded through the production observer", async () => {
    const response = await api("GET", "/api/gateway/v1/external-services");
    assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
    const service = response.payload.items.find((item) => item.serviceId === SERVICE_ID);
    assert.ok(service, "configured service missing");
    assert.equal(service.credentialReferenceCount, 1);
    assert.equal(service.credentialBindingIds.length, 1);
    assert.equal(JSON.stringify(response.payload).includes("raw-token-must-be-redacted"), false);
    return {
      serviceId: service.serviceId,
      operationCount: service.operations.length,
      loadedFromPublishedManifest: true
    };
  });

  await destructiveTest("non-canonical mutation payloads are rejected without material leakage", async () => {
    const create = await api("POST", "/api/gateway/v1/external-services", {
      serviceId: "remote-registration-forbidden",
      baseUrl: fixtureUrl,
      token: RAW_TOKEN
    });
    assert.equal(create.status >= 400, true);
    assert.equal(JSON.stringify(create.payload).includes(RAW_TOKEN), false);
    const disable = await api("POST", `/api/gateway/v1/external-services/${SERVICE_ID}/disable`, {
      reason: "forbidden"
    });
    assert.equal(disable.status >= 400, true);
    return { createStatus: create.status, disableStatus: disable.status };
  });

  await test("health, policy preview, and direct HTTP forwarding work", async () => {
    const health = await api("GET", `/api/gateway/v1/external-services/${SERVICE_ID}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.payload.ok, true);
    const preview = await api("POST", "/api/gateway/v1/policy/preview", {
      serviceId: SERVICE_ID,
      operationKey: "echo"
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.allowed, true);
    const forwarded = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { message: "direct-http" }
    });
    assert.equal(forwarded.status, 200, JSON.stringify(forwarded.payload, null, 2));
    assert.equal(forwarded.payload.response.json.credentialOk, true);
    assert.equal(forwarded.payload.response.json.echoed.message, "direct-http");
    return {
      healthStatus: health.payload.status,
      previewAllowed: preview.payload.allowed,
      upstreamStatus: forwarded.payload.upstream.status
    };
  });

  await test("HTTP, RPC, and console forwarding share the same governed operation path", async () => {
    const before = fixtureState.echoCount;
    const rpcForwarded = await rpc("gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { message: "rpc-forward" }
    }, 9101);
    assert.equal(rpcForwarded.error, undefined, JSON.stringify(rpcForwarded.error || {}, null, 2));
    assert.equal(rpcForwarded.result.response.json.echoed.message, "rpc-forward");

    const consoleForwarded = await consoleOperation("gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { message: "console-forward" }
    });
    assert.equal(consoleForwarded.status, 200, JSON.stringify(consoleForwarded, null, 2));
    assert.equal(consoleForwarded.payload.response.json.echoed.message, "console-forward");
    assert.equal(fixtureState.echoCount, before + 2);

    const audit = await api("GET", "/api/gateway/v1/audit");
    assert.equal(audit.status, 200);
    const completed = audit.payload.items.filter((item) => item.eventType === "upstream.forward.completed");
    assert.equal(
      completed.length >= 3,
      true,
      `expected at least 3 completed forward audit entries, got ${completed.length}; operationKeys=${completed.map((item) => item.payload?.operationKey || "").join(",")}`
    );
    assert.equal(
      completed.every((item) => item.payload?.requestBody?.metadataOnly === true),
      true,
      "completed forward audit entries must only expose metadata request bodies"
    );
    return {
      rpcStatus: rpcForwarded.result.upstream.status,
      consoleStatus: consoleForwarded.status,
      auditCompletedCount: completed.length,
      sharedFixtureHits: fixtureState.echoCount - before
    };
  });

  await test("MCP discovery exposes gateway operations and read grants hide writes", async () => {
    const writeToken = await createGrant("verify-gateway-write", ["lico.gateway.read", "lico.gateway.write", "lico.gateway.maintain"]);
    const capabilitiesPayload = await callMcp(writeToken, "lico.discovery", "lico.capabilities.list", {}, 1001);
    const capabilities = capabilitiesPayload.result?.structuredContent || {};
    const names = gatewayOperationNames(capabilities);
    assert.equal(names.has("lico.gateway.forward"), true);
    assert.equal(names.has("lico.gateway.externalServices.health"), true);
    const forward = (capabilities.operations || []).find((operation) => operation.name === "lico.gateway.forward");
    assert.equal(forward?._meta?.mcpOutlet, "lico.gateway");

    const readToken = await createGrant("verify-gateway-read", ["lico.gateway.read"]);
    const readCapabilitiesPayload = await callMcp(readToken, "lico.discovery", "lico.capabilities.list", {}, 1002);
    const readNames = gatewayOperationNames(readCapabilitiesPayload.result?.structuredContent || {});
    assert.equal(readNames.has("lico.gateway.metrics"), true);
    assert.equal(readNames.has("lico.gateway.forward"), false);
    return {
      gatewayOperationCount: names.size,
      readForwardHidden: !readNames.has("lico.gateway.forward"),
      outlet: forward?._meta?.mcpOutlet
    };
  });

  await destructiveTest("gateway forwarding cannot be called through the wrong MCP outlet", async () => {
    const token = await createGrant("verify-gateway-outlet-mismatch", ["lico.gateway.read", "lico.gateway.write"]);
    const payload = await callMcp(token, "lico.discovery", "lico.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { message: "wrong-outlet" }
    }, 1006);
    assert.ok(payload.error, JSON.stringify(payload, null, 2));
    assert.equal(payload.error.data?.code, "operation_outlet_mismatch");
    assert.equal(payload.error.data?.expectedTool, "lico.gateway");
    assertNoLeak(payload, "wrong outlet response");
    return {
      denied: true,
      code: payload.error.data?.code,
      expectedOutlet: payload.error.data?.expectedTool
    };
  });

  await test("MCP gateway forwarding reaches fixture and records audit metrics", async () => {
    const token = await createGrant("verify-gateway-forward", ["lico.gateway.read", "lico.gateway.write", "lico.gateway.maintain"]);
    const before = fixtureState.echoCount;
    const mcpPayload = await callMcp(token, "lico.gateway", "lico.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { message: "mcp-forward" }
    }, 1003);
    assert.equal(mcpPayload.error, undefined, JSON.stringify(mcpPayload.error || {}, null, 2));
    const forwarded = structuredPayload(mcpPayload);
    assert.equal(forwarded.response.json.echoed.message, "mcp-forward");
    assert.equal(fixtureState.echoCount, before + 1);
    const audit = await api("GET", "/api/gateway/v1/audit");
    assert.equal(audit.status, 200);
    assert.equal(audit.payload.items.some((item) => item.eventType === "upstream.forward.completed"), true);
    const metrics = await api("GET", "/api/gateway/v1/metrics");
    assert.equal(metrics.status, 200);
    assert.equal(Number(metrics.payload.totalForwardCount) >= 2, true);
    return {
      fixtureHit: fixtureState.echoCount - before,
      auditCount: audit.payload.count,
      forwardCount: metrics.payload.totalForwardCount
    };
  });

  await runProjectedToolWorkflows({
    test,
    destructiveTest,
    createGrant,
    callMcpRaw,
    api,
    fixtureState,
    assertNoLeak,
    serviceId: SERVICE_ID
  });

  await test("MCP gateway can call JSON-RPC upstream with sensitive body redaction", async () => {
    const token = await createGrant("verify-gateway-json-rpc", ["lico.gateway.read", "lico.gateway.write"]);
    const before = fixtureState.jsonRpcCount;
    const mcpPayload = await callMcp(token, "lico.gateway", "lico.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "json-rpc-echo",
      rpcParams: {
        message: "json-rpc-forward",
        password: BODY_SECRET
      }
    }, 1005);
    assert.equal(mcpPayload.error, undefined, JSON.stringify(mcpPayload.error || {}, null, 2));
    const forwarded = structuredPayload(mcpPayload);
    assert.equal(forwarded.response.json.jsonrpc, "2.0");
    assert.equal(forwarded.response.json.result.echoed.message, "json-rpc-forward");
    assert.equal(forwarded.response.json.result.echoed.password, undefined);
    assert.equal(forwarded.response.json.result.ok, undefined);
    assert.equal(fixtureState.jsonRpcCount, before + 1);
    assertNoLeak(mcpPayload, "json-rpc mcp response");

    const audit = await api("GET", "/api/gateway/v1/audit");
    const event = audit.payload.items.find((item) =>
      item.eventType === "upstream.forward.completed" &&
      item.payload?.operationKey === "json-rpc-echo"
    );
    assert.ok(event, "json-rpc audit event missing");
    assert.equal(event.payload.protocol, "json-rpc");
    assert.equal(event.payload.requestBody.metadataOnly, true);
    assert.equal(event.payload.requestBody.sensitiveFieldCount >= 1, true);
    assert.equal(event.payload.responseBody.metadataOnly, true);
    assert.equal(event.payload.responseBody.sensitiveFieldCount >= 1, true);
    assert.equal(event.payload.responsePolicy.schemaValidated, true);
    assert.equal(event.payload.responsePolicy.publicFieldCount, 3);
    assertNoLeak(audit.payload, "json-rpc audit payload");
    const toolAudit = await api("GET", "/api/operation-permission/v1/audit?limit=20");
    assert.equal(toolAudit.status, 200, JSON.stringify(toolAudit.payload, null, 2));
    const gatewayExecutions = (toolAudit.payload.items || []).filter((item) => item.toolId === "lico.gateway.forward");
    assert.equal(gatewayExecutions.length >= 1, true);
    assert.equal(
      gatewayExecutions.some((item) =>
        item.redactedInput === "[redacted]" ||
        item.redactedInput?.rpcParams?.metadataOnly === true
      ),
      true,
      "Operation Permission audit did not redact or summarize rpcParams"
    );
    assertNoLeak(toolAudit.payload, "operation permission gateway audit");
    return {
      fixtureHits: fixtureState.jsonRpcCount - before,
      requestSensitiveFields: event.payload.requestBody.sensitiveFieldCount,
      responseSensitiveFields: event.payload.responseBody.sensitiveFieldCount,
      publicResponseFieldCount: event.payload.responsePolicy.publicFieldCount,
      toolExecutionAuditChecked: true
    };
  });

  await test("response schema mismatch is rejected before public output", async () => {
    const rejected = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "schema-mismatch"
    });
    assert.equal(rejected.status, 502, JSON.stringify(rejected.payload, null, 2));
    assert.equal(rejected.payload.ok, false);
    assert.equal(rejected.payload.details?.reasonCode, "response_schema_mismatch");
    assert.equal(JSON.stringify(rejected.payload).includes("unexpected"), false);
    const audit = await api("GET", "/api/gateway/v1/audit");
    const event = audit.payload.items.find((item) =>
      item.eventType === "upstream.forward.failed" &&
      item.payload?.operationKey === "schema-mismatch"
    );
    assert.ok(event, "schema mismatch audit event missing");
    assert.equal(event.payload.reasonCode, "response_schema_mismatch");
    assertNoLeak(rejected.payload, "schema mismatch response");
    return {
      rejectedStatus: rejected.status,
      reasonCode: event.payload.reasonCode
    };
  });

  await destructiveTest("approval-required forwarding cannot be unlocked by request body", async () => {
    const before = fixtureState.approvalCount;
    const pending = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "approval",
      body: { message: "hold" }
    });
    assert.equal(pending.status, 202);
    assert.equal(pending.payload.status, "pending_approval");
    assert.equal(fixtureState.approvalCount, before);
    const rejectedApproved = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "approval",
      approved: true,
      body: { message: "go" }
    });
    assert.equal(rejectedApproved.status, 400);
    assert.equal(rejectedApproved.payload.ok, false);
    assert.equal(rejectedApproved.payload.details?.reasonCode, "upstream_approval_override_denied");
    const rejectedApprovalApproved = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "approval",
      approvalApproved: true,
      body: { message: "go" }
    });
    assert.equal(rejectedApprovalApproved.status, 400);
    assert.equal(rejectedApprovalApproved.payload.ok, false);
    assert.equal(rejectedApprovalApproved.payload.details?.reasonCode, "upstream_approval_override_denied");
    assert.equal(fixtureState.approvalCount, before);
    assertNoLeak(rejectedApproved.payload, "approved override rejection");
    assertNoLeak(rejectedApprovalApproved.payload, "approvalApproved override rejection");
    return {
      pendingStatus: pending.status,
      rejectedApprovedStatus: rejectedApproved.status,
      rejectedApprovalApprovedStatus: rejectedApprovalApproved.status,
      reasonCode: rejectedApproved.payload.details?.reasonCode
    };
  });

  await destructiveTest("unauthorized MCP read grant cannot call forwarding", async () => {
    const token = await createGrant("verify-gateway-read-deny", ["lico.gateway.read"]);
    const payload = await callMcp(token, "lico.gateway", "lico.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { message: "deny" }
    }, 1004, [200, 403]);
    assert.ok(payload.error, JSON.stringify(payload, null, 2));
    assertNoLeak(payload, "unauthorized mcp response");
    return { denied: true, code: payload.error.code };
  });

  await destructiveTest("timeout, non-json, and oversized response are controlled", async () => {
    const timeout = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "slow",
      body: { message: "timeout" }
    });
    assert.equal(timeout.status, 504);
    const nonJson = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "non-json"
    });
    assert.equal(nonJson.status, 200);
    assert.equal(nonJson.payload.response.text, "plain fixture response");
    const large = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "large"
    });
    assert.equal(large.status, 502);
    assertNoLeak(timeout.payload, "timeout response");
    assertNoLeak(large.payload, "large response");
    return { timeout: timeout.status, nonJson: nonJson.status, large: large.status };
  });

  await destructiveTest("traffic-control rejection is deterministic", async () => {
    const [first, rejected] = await Promise.all([
      api("POST", "/api/gateway/v1/forward", {
        serviceId: LIMITED_SERVICE_ID,
        operationKey: "limited",
        query: { i: "first" }
      }),
      api("POST", "/api/gateway/v1/forward", {
        serviceId: LIMITED_SERVICE_ID,
        operationKey: "limited",
        query: { i: "second" }
      })
    ].map((request) => request.catch((error) => ({ status: 0, payload: { error: error?.code || "request_failed" } }))));
    const statuses = [first.status, rejected.status].sort((left, right) => left - right);
    assert.deepEqual(statuses, [200, 429], JSON.stringify({ first: first.payload, rejected: rejected.payload }, null, 2));
    const rejectedResponse = [first, rejected].find((item) => item.status === 429);
    assertNoLeak(rejectedResponse?.payload || {}, "traffic rejection response");
    return { statuses };
  });

  await destructiveTest("traffic-control enforces concurrent in-flight slots", async () => {
    return runConcurrentTrafficSlotWorkflow({
      api,
      gatewayFixture,
      concurrentLimitedServiceId: CONCURRENT_LIMITED_SERVICE_ID,
      assertNoLeak
    });
  });

  await runAggregateTrafficPolicyWorkflow({ destructiveTest, api, aggregateLimitedServiceId: AGGREGATE_LIMITED_SERVICE_ID, assertNoLeak });

  await runEndpointPoolWorkflow({
    test,
    api,
    loadBalancedServiceId: LOAD_BALANCED_SERVICE_ID,
    failingFixtureState,
    assertNoLeak
  });

  await destructiveTest("invalid remote registration inputs fail without leaking secrets", async () => {
    const badUrl = await api("POST", "/api/gateway/v1/external-services", {
      serviceId: "bad-url",
      baseUrl: "file:///tmp/nope",
      token: BAD_SECRET
    });
    assert.equal(badUrl.status >= 400, true);
    assert.equal(JSON.stringify(badUrl.payload).includes("bad-secret"), false);
    const traversal = await api("POST", "/api/gateway/v1/external-services", {
      serviceId: "bad-path",
      baseUrl: fixtureUrl,
      operations: [{ operationKey: "bad", path: "/../secret" }]
    });
    assert.equal(traversal.status >= 400, true);
    return { badUrl: badUrl.status, traversal: traversal.status };
  });

  await destructiveTest("concurrent MCP forwarding is isolated and counted", async () => {
    const token = await createGrant("verify-gateway-concurrent", ["lico.gateway.read", "lico.gateway.write"]);
    const before = fixtureState.concurrentCount;
    const calls = Array.from({ length: 32 }, (_, index) =>
      callMcp(token, "lico.gateway", "lico.gateway.forward", {
        serviceId: SERVICE_ID,
        operationKey: "concurrent",
        query: { i: String(index) }
      }, 2000 + index)
    );
    const responses = await Promise.all(calls);
    assert.equal(responses.every((payload) => !payload.error), true);
    assert.equal(fixtureState.concurrentCount, before + 32);
    return { calls: responses.length, fixtureHits: fixtureState.concurrentCount - before };
  });

  await test("disabled config service cannot forward", async () => {
    const denied = await api("POST", "/api/gateway/v1/forward", {
      serviceId: DISABLED_SERVICE_ID,
      operationKey: "echo",
      body: { message: "after-disable" }
    });
    assert.equal(denied.status, 403);
    return { disabledByConfig: true, deniedStatus: denied.status };
  });

  await writeReport();
  console.log(`\n=== Upstream Gateway E2E passed; report: ${REPORT_PATH} ===`);
} catch (error) {
  await writeReport().catch(() => {});
  console.error(JSON.stringify(safeEvidence({
    ok: false,
    verifier: "tools/server-scripts/verify-upstream-gateway-e2e.mjs",
    failure: failureEvidence(error)
  }), null, 2));
  process.exitCode = 1;
} finally {
  await consoleUpstreamGatewayRegistry?.close?.();
  if (server?.close) {
    await server.close();
  }
  await gatewayFixture.close(fixture);
  if (failingFixture?.close) {
    await new Promise((resolve) => failingFixture.close(resolve));
  }
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  restoreCapabilityKernelEnv();
}
