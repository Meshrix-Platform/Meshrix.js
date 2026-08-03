#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import { createServerUpstreamGatewayRegistry } from "../../packages/server-runtime/src/composition/server-runtime-providers.ts";
import { executeConsoleDomainOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executor.ts";
import { compileUpstreamOperationCapability } from "../../packages/agents/src/upstream-gateway/operation-capability.ts";
import { installAuthenticatedFetch } from "./test-auth-helper.ts";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.ts";
import { createSignedMcpHeaders, createVerifierMcpProcessIdentity } from "./mcp-process-identity-test-helper.ts";
import { createUpstreamGatewayFixture, createUpstreamGatewayE2eServices, gatewayOperationNames, runConcurrentTrafficSlotWorkflow, structuredPayload } from "./lib/upstream-gateway-e2e-helpers.ts";
import { loadVerifierPublishedServices, seedVerifierUpstreamServices, verifierOpaqueServiceId, writeVerifierLocalUpstreamSecret } from "./lib/upstream-gateway-verifier-publication.ts";
import { createRawMcpCaller, runAggregateTrafficPolicyWorkflow, runEndpointPoolWorkflow, runProjectedToolWorkflows, runUrlAuthorityEscapeWorkflow } from "./lib/upstream-gateway-projected-tools-workflows.ts";
import { issueVerifierMcpApiKey } from "./lib/verifier-mcp-api-key.ts";
import { provisionVerifierLocalSecretKey } from "./lib/local-secret-verifier-key.ts";

const REPORT_PATH: any = "build/reports/upstream-gateway-e2e.json";
const MCP_INTERFACE_VERSION: any = "v0.0.1:mcp:interface-1";
const VERIFIED_TRAFFIC_ALGORITHM: any = "token_bucket_with_concurrency";
const VERIFIED_ROUTING_ALGORITHM: any = "weighted_endpoint_round_robin_with_circuit_breaker";
const [SERVICE_ID, LIMITED_SERVICE_ID, CONCURRENT_LIMITED_SERVICE_ID, AGGREGATE_LIMITED_SERVICE_ID, LOAD_BALANCED_SERVICE_ID, DISABLED_SERVICE_ID] = [
  "verify-upstream-gateway", "verify-upstream-gateway-limited", "verify-upstream-gateway-concurrent-limited",
  "verify-upstream-gateway-aggregate-limited", "verify-upstream-gateway-endpoint-pool", "verify-upstream-gateway-disabled"
].map(verifierOpaqueServiceId);
const [SECRET_REF, RAW_TOKEN, RESOLVED_SECRET_TOKEN, BAD_SECRET, BODY_SECRET] = [
  "secret://verify/upstream/token", "raw-token-must-be-redacted", "resolved-upstream-e2e-token-must-be-redacted",
  "bad-secret", "json-rpc-body-secret-must-be-redacted"
];

const restoreCapabilityKernelEnv: any = useIsolatedCapabilityKernelForVerifier();
const localSecretKeyCustody: any = await provisionVerifierLocalSecretKey();
const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-gateway-"));
const gatewayFixture: any = createUpstreamGatewayFixture({
  resolvedSecretToken: RESOLVED_SECRET_TOKEN
});
const fixtureState: any = gatewayFixture.state;
const report: Record<string, any> = {
  schemaVersion: "v0.0.1:upstream-gateway:e2e-report-1",
  verifier: "tools/server-scripts/verify-upstream-gateway-e2e.ts",
  startedAt: new Date().toISOString(),
  tests: [],
  destructiveTests: [],
  summary: {}
};

let server: any = null;
let fixture: any = null;
let fixtureUrl: any = "";
let failingFixture: any = null;
let failingFixtureUrl: any = "";
let failingFixtureState: any = null;
let consoleUpstreamGatewayRegistry: any = null;
const dynamicSecretNeedles: any = new Set<any>();
const mcpIdentityByToken: any = new Map<any, any>();
let configuredServices: any[] = [];

function safeEvidence(value: Record<string, any> = {}) : any {
  const fixtureHost: any = fixtureUrl ? new URL(fixtureUrl).host : "";
  return JSON.parse(JSON.stringify(value, (_?: any, child?: any) : any => {
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
    if (/Bearer\s+\S+/i.test(child) || /meshrix_[a-z0-9_-]+=/i.test(child)) {
      return "[redacted-secret]";
    }
    return child;
  }));
}

function assertNoLeak(value?: any, label: any = "payload") : any {
  const serialized: any = JSON.stringify(value);
  assert.equal(serialized.includes(userDataPath), false, `${label} leaked verifier data path`);
  assert.equal(serialized.includes(os.homedir()), false, `${label} leaked user home path`);
  assert.equal(serialized.includes(RAW_TOKEN), false, `${label} leaked raw credential`);
  assert.equal(serialized.includes(BAD_SECRET), false, `${label} leaked rejected raw credential`);
  assert.equal(serialized.includes(BODY_SECRET), false, `${label} leaked body secret`);
  for (const needle of dynamicSecretNeedles) {
    assert.equal(needle ? serialized.includes(needle) : false, false, `${label} leaked dynamic secret`);
  }
  assert.equal(/Bearer\s+\S+/i.test(serialized), false, `${label} leaked bearer token`);
  assert.equal(/meshrix_[a-z0-9_-]+=/i.test(serialized), false, `${label} leaked cookie`);
}

async function writeReport() : Promise<any> {
  report.finishedAt = new Date().toISOString();
  const outcomes: any = new Map<any, any>([...report.tests, ...report.destructiveTests].map((item?: any) : any => [item.name, item.status]));
  report.summary.testCount = report.tests.length;
  report.summary.destructiveTestCount = report.destructiveTests.length;
  report.summary.failedCount = [...report.tests, ...report.destructiveTests].filter((item?: any) : any => item.status !== "passed").length;
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
  report.summary.downstreamMcpDistributionOperation = "meshrix.gateway.forward";
  report.summary.concurrentMcpForwardingVerified =
    outcomes.get("concurrent MCP forwarding is isolated and counted") === "passed";
  report.summary.releaseReady = report.summary.failedCount === 0;
  assertNoLeak(report, "upstream gateway e2e report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function record(collection?: any, name?: any, status?: any, evidence: Record<string, any> = {}) : any {
  collection.push({ name, status, evidence });
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
    record(report.tests, name, "passed", safeEvidence(evidence));
    console.log("ok");
  } catch (error: any) {
    record(report.tests, name, "failed", safeEvidence(failureEvidence(error)));
    console.log("FAIL");
    throw error;
  }
}

async function destructiveTest(name?: any, fn?: any) : Promise<any> {
  process.stdout.write(`  destructive ${name} ... `);
  try {
    const evidence: any = await fn();
    record(report.destructiveTests, name, "passed", safeEvidence(evidence));
    console.log("ok");
  } catch (error: any) {
    record(report.destructiveTests, name, "failed", safeEvidence(failureEvidence(error)));
    console.log("FAIL");
    throw error;
  }
}

async function fetchJson(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(url, options);
  const text: any = await response.text();
  const payload: any = text.trim() ? JSON.parse(text) : {};
  assertNoLeak(payload, url.replace(server?.url || "", ""));
  return { status: response.status, ok: response.ok, payload };
}

function mcpRequest(method?: any, params: Record<string, any> = {}, id: any = 1) : any {
  return { jsonrpc: "2.0", id, method, params };
}

async function api(method?: any, route?: any, body: any = undefined) : Promise<any> {
  return fetchJson(`${server.url}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function rpc(method?: any, params: Record<string, any> = {}, id: any = 9000) : Promise<any> {
  const response: any = await fetchJson(`${server.url}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  assert.equal(response.status, 200);
  assertNoLeak(response.payload, `rpc ${method}`);
  return response.payload;
}

async function consoleOperation(operationId?: any, input: Record<string, any> = {}) : Promise<any> {
  if (!consoleUpstreamGatewayRegistry) {
    consoleUpstreamGatewayRegistry = createServerUpstreamGatewayRegistry({ userDataPath });
    await loadVerifierPublishedServices({ userDataPath, registry: consoleUpstreamGatewayRegistry });
  }
  const result: any = await executeConsoleDomainOperation({
    operationId,
    input,
    context: {
      userDataPath,
      upstreamGatewayRegistry: consoleUpstreamGatewayRegistry,
      subject: {
        subjectId: "verifier-console-subject",
        roleId: "maintainer",
        scopes: ["gateway:read", "gateway:write", "gateway:maintain", "gateway:admin"]
      }
    }
  });
  assertNoLeak(result, `console ${operationId}`);
  return result;
}

async function createGrant(label?: any, toolsets?: any, extra: Record<string, any> = {}) : Promise<any> {
  const descriptors: any = configuredServices.flatMap((service?: any) : any =>
    (service.operations || []).map((operation?: any) : any => compileUpstreamOperationCapability(service, operation))
  );
  const dynamicCapabilities: any = Object.hasOwn(extra, "dynamicCapabilities")
    ? extra.dynamicCapabilities
    : descriptors.map((descriptor?: any) : any => descriptor.capabilityId);
  const allowedServiceIds: any = Object.hasOwn(extra, "allowedServiceIds")
    ? extra.allowedServiceIds
    : configuredServices.map((service?: any) : any => service.serviceId);
  const allowedSecretBindings: any = Object.hasOwn(extra, "allowedSecretBindings")
    ? extra.allowedSecretBindings
    : descriptors.flatMap((descriptor?: any) : any => descriptor.credentialBindingIds || []);
  const response: any = await issueVerifierMcpApiKey({
    server,
    access: {
      targets: ["codex"],
      label,
      connectorVersion: "verify-upstream-gateway-e2e",
      grantMode: "maintain",
      toolsets,
      dynamicCapabilities,
      allowedServiceIds,
      allowedSecretBindings,
      ...extra
    }
  });
  assert.ok(response.apiKey);
  dynamicSecretNeedles.add(response.apiKey);
  return response.apiKey;
}

async function callMcp(token?: any, toolName?: any, operation?: any, input: Record<string, any> = {}, id: any = 1, expectedStatuses: any = [200]) : Promise<any> {
  const body: any = JSON.stringify(mcpRequest("tools/call", {
    name: toolName,
    arguments: {
      apiVersion: MCP_INTERFACE_VERSION,
      operation,
      input,
      clientVersion: "verify-upstream-gateway-e2e"
    }
  }, id));
  const response: any = await fetchJson(`${server.url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Meshrix-Api-Key": token, "X-Meshrix-MCP-Target": "codex" },
    body
  });
  assert.equal(expectedStatuses.includes(response.status), true, `Unexpected MCP HTTP status ${response.status}: ${JSON.stringify(response.payload, null, 2)}`);
  return response.payload;
}

try {
  const fixtureStarted: any = await gatewayFixture.start();
  fixture = fixtureStarted.server;
  fixtureUrl = fixtureStarted.url;
  const failingGatewayFixture: any = createUpstreamGatewayFixture({
    resolvedSecretToken: RESOLVED_SECRET_TOKEN,
    failPaths: ["/echo"]
  });
  const failingFixtureStarted: any = await failingGatewayFixture.start();
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
    trackSecret: (value?: any) : any => dynamicSecretNeedles.add(value)
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
  const callMcpRaw: any = createRawMcpCaller({
    getServer: () : any => server,
    mcpIdentityByToken,
    fetchJson
  });

  console.log("\n=== Upstream Gateway E2E: durable publication, MCP forwarding, destructive inputs ===\n");

  await runUrlAuthorityEscapeWorkflow({ test });

  await test("interfaces expose current upstream gateway operations", async () : Promise<any> => {
    const response: any = await api("GET", "/api/interfaces");
    assert.equal(response.status, 200);
    const ids: any = new Set<any>((response.payload.interfaces || []).map((item?: any) : any => item.id));
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

  await test("durable manifest fixture is loaded through the production observer", async () : Promise<any> => {
    const response: any = await api("GET", "/api/gateway/v1/external-services");
    assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
    const service: any = response.payload.items.find((item?: any) : any => item.serviceId === SERVICE_ID);
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

  await destructiveTest("non-canonical mutation payloads are rejected without material leakage", async () : Promise<any> => {
    const create: any = await api("POST", "/api/gateway/v1/external-services", {
      serviceId: "remote-registration-forbidden",
      baseUrl: fixtureUrl,
      token: RAW_TOKEN
    });
    assert.equal(create.status >= 400, true);
    assert.equal(JSON.stringify(create.payload).includes(RAW_TOKEN), false);
    const disable: any = await api("POST", `/api/gateway/v1/external-services/${SERVICE_ID}/disable`, {
      reason: "forbidden"
    });
    assert.equal(disable.status >= 400, true);
    return { createStatus: create.status, disableStatus: disable.status };
  });

  await test("health, policy preview, and direct HTTP forwarding work", async () : Promise<any> => {
    const health: any = await api("GET", `/api/gateway/v1/external-services/${SERVICE_ID}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.payload.ok, true);
    const preview: any = await api("POST", "/api/gateway/v1/policy/preview", {
      serviceId: SERVICE_ID,
      operationKey: "echo"
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.allowed, true);
    const forwarded: any = await api("POST", "/api/gateway/v1/forward", {
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

  await test("HTTP, RPC, and console forwarding share the same governed operation path", async () : Promise<any> => {
    const before: any = fixtureState.echoCount;
    const rpcForwarded: any = await rpc("gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { message: "rpc-forward" }
    }, 9101);
    assert.equal(rpcForwarded.error, undefined, JSON.stringify(rpcForwarded.error || {}, null, 2));
    assert.equal(rpcForwarded.result.response.json.echoed.message, "rpc-forward");

    const consoleForwarded: any = await consoleOperation("gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { message: "console-forward" }
    });
    assert.equal(consoleForwarded.status, 200, JSON.stringify(consoleForwarded, null, 2));
    assert.equal(consoleForwarded.payload.response.json.echoed.message, "console-forward");
    assert.equal(fixtureState.echoCount, before + 2);

    const audit: any = await api("GET", "/api/gateway/v1/audit");
    assert.equal(audit.status, 200);
    const completed: any = audit.payload.items.filter((item?: any) : any => item.eventType === "upstream.forward.completed");
    assert.equal(
      completed.length >= 3,
      true,
      `expected at least 3 completed forward audit entries, got ${completed.length}; operationKeys=${completed.map((item?: any) : any => item.payload?.operationKey || "").join(",")}`
    );
    assert.equal(
      completed.every((item?: any) : any => item.payload?.requestBody?.metadataOnly === true),
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

  await test("MCP discovery exposes gateway operations and read grants hide writes", async () : Promise<any> => {
    const writeToken: any = await createGrant("verify-gateway-write", ["meshrix.gateway.read", "meshrix.gateway.write", "meshrix.gateway.maintain"]);
    const capabilitiesPayload: any = await callMcp(writeToken, "meshrix.discovery", "meshrix.capabilities.list", {}, 1001);
    const capabilities: any = capabilitiesPayload.result?.structuredContent || {};
    const names: any = gatewayOperationNames(capabilities);
    assert.equal(names.has("meshrix.gateway.forward"), true);
    assert.equal(names.has("meshrix.gateway.externalServices.health"), true);
    const forward: any = (capabilities.operations || []).find((operation?: any) : any => operation.name === "meshrix.gateway.forward");
    assert.equal(forward?._meta?.mcpOutlet, "meshrix.gateway");

    const readToken: any = await createGrant("verify-gateway-read", ["meshrix.gateway.read"]);
    const readCapabilitiesPayload: any = await callMcp(readToken, "meshrix.discovery", "meshrix.capabilities.list", {}, 1002);
    const readNames: any = gatewayOperationNames(readCapabilitiesPayload.result?.structuredContent || {});
    assert.equal(readNames.has("meshrix.gateway.metrics"), true);
    assert.equal(readNames.has("meshrix.gateway.forward"), false);
    return {
      gatewayOperationCount: names.size,
      readForwardHidden: !readNames.has("meshrix.gateway.forward"),
      outlet: forward?._meta?.mcpOutlet
    };
  });

  await destructiveTest("gateway forwarding cannot be called through the wrong MCP outlet", async () : Promise<any> => {
    const token: any = await createGrant("verify-gateway-outlet-mismatch", ["meshrix.gateway.read", "meshrix.gateway.write"]);
    const payload: any = await callMcp(token, "meshrix.discovery", "meshrix.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { message: "wrong-outlet" }
    }, 1006);
    assert.ok(payload.error, JSON.stringify(payload, null, 2));
    assert.equal(payload.error.data?.code, "operation_outlet_mismatch");
    assert.equal(payload.error.data?.expectedTool, "meshrix.gateway");
    assertNoLeak(payload, "wrong outlet response");
    return {
      denied: true,
      code: payload.error.data?.code,
      expectedOutlet: payload.error.data?.expectedTool
    };
  });

  await test("MCP gateway forwarding reaches fixture and records audit metrics", async () : Promise<any> => {
    const token: any = await createGrant("verify-gateway-forward", ["meshrix.gateway.read", "meshrix.gateway.write", "meshrix.gateway.maintain"]);
    const before: any = fixtureState.echoCount;
    const mcpPayload: any = await callMcp(token, "meshrix.gateway", "meshrix.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { message: "mcp-forward" }
    }, 1003);
    assert.equal(mcpPayload.error, undefined, JSON.stringify(mcpPayload.error || {}, null, 2));
    const forwarded: any = structuredPayload(mcpPayload);
    assert.equal(forwarded.response.json.echoed.message, "mcp-forward");
    assert.equal(fixtureState.echoCount, before + 1);
    const audit: any = await api("GET", "/api/gateway/v1/audit");
    assert.equal(audit.status, 200);
    assert.equal(audit.payload.items.some((item?: any) : any => item.eventType === "upstream.forward.completed"), true);
    const metrics: any = await api("GET", "/api/gateway/v1/metrics");
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

  await test("MCP gateway can call JSON-RPC upstream with sensitive body redaction", async () : Promise<any> => {
    const token: any = await createGrant("verify-gateway-json-rpc", ["meshrix.gateway.read", "meshrix.gateway.write"]);
    const before: any = fixtureState.jsonRpcCount;
    const mcpPayload: any = await callMcp(token, "meshrix.gateway", "meshrix.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "json-rpc-echo",
      rpcParams: {
        message: "json-rpc-forward",
        password: BODY_SECRET
      }
    }, 1005);
    assert.equal(mcpPayload.error, undefined, JSON.stringify(mcpPayload.error || {}, null, 2));
    const forwarded: any = structuredPayload(mcpPayload);
    assert.equal(forwarded.response.json.jsonrpc, "2.0");
    assert.equal(forwarded.response.json.result.echoed.message, "json-rpc-forward");
    assert.equal(forwarded.response.json.result.echoed.password, undefined);
    assert.equal(forwarded.response.json.result.ok, undefined);
    assert.equal(fixtureState.jsonRpcCount, before + 1);
    assertNoLeak(mcpPayload, "json-rpc mcp response");

    const audit: any = await api("GET", "/api/gateway/v1/audit");
    const event: any = audit.payload.items.find((item?: any) : any =>
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
    const toolAudit: any = await api("GET", "/api/operation-permission/v1/audit?limit=20");
    assert.equal(toolAudit.status, 200, JSON.stringify(toolAudit.payload, null, 2));
    const gatewayExecutions: any = (toolAudit.payload.items || []).filter((item?: any) : any => item.toolId === "meshrix.gateway.forward");
    assert.equal(gatewayExecutions.length >= 1, true);
    assert.equal(
      gatewayExecutions.some((item?: any) : any =>
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

  await test("response schema mismatch is rejected before public output", async () : Promise<any> => {
    const rejected: any = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "schema-mismatch"
    });
    assert.equal(rejected.status, 502, JSON.stringify(rejected.payload, null, 2));
    assert.equal(rejected.payload.ok, false);
    assert.equal(rejected.payload.details?.reasonCode, "response_schema_mismatch");
    assert.equal(JSON.stringify(rejected.payload).includes("unexpected"), false);
    const audit: any = await api("GET", "/api/gateway/v1/audit");
    const event: any = audit.payload.items.find((item?: any) : any =>
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

  await destructiveTest("approval-required forwarding cannot be unlocked by request body", async () : Promise<any> => {
    const before: any = fixtureState.approvalCount;
    const pending: any = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "approval",
      body: { message: "hold" }
    });
    assert.equal(pending.status, 202);
    assert.equal(pending.payload.status, "pending_approval");
    assert.equal(fixtureState.approvalCount, before);
    const rejectedApproved: any = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "approval",
      approved: true,
      body: { message: "go" }
    });
    assert.equal(rejectedApproved.status, 400);
    assert.equal(rejectedApproved.payload.ok, false);
    assert.equal(rejectedApproved.payload.details?.reasonCode, "upstream_approval_override_denied");
    const rejectedApprovalApproved: any = await api("POST", "/api/gateway/v1/forward", {
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

  await destructiveTest("unauthorized MCP read grant cannot call forwarding", async () : Promise<any> => {
    const token: any = await createGrant("verify-gateway-read-deny", ["meshrix.gateway.read"]);
    const payload: any = await callMcp(token, "meshrix.gateway", "meshrix.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { message: "deny" }
    }, 1004, [200, 403]);
    assert.ok(payload.error, JSON.stringify(payload, null, 2));
    assertNoLeak(payload, "unauthorized mcp response");
    return { denied: true, code: payload.error.code };
  });

  await destructiveTest("timeout, non-json, and oversized response are controlled", async () : Promise<any> => {
    const timeout: any = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "slow",
      body: { message: "timeout" }
    });
    assert.equal(timeout.status, 504);
    const nonJson: any = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "non-json"
    });
    assert.equal(nonJson.status, 200);
    assert.equal(nonJson.payload.response.text, "plain fixture response");
    const large: any = await api("POST", "/api/gateway/v1/forward", {
      serviceId: SERVICE_ID,
      operationKey: "large"
    });
    assert.equal(large.status, 502);
    assertNoLeak(timeout.payload, "timeout response");
    assertNoLeak(large.payload, "large response");
    return { timeout: timeout.status, nonJson: nonJson.status, large: large.status };
  });

  await destructiveTest("traffic-control rejection is deterministic", async () : Promise<any> => {
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
    ].map((request?: any) : any => request.catch((error?: any) : any => ({ status: 0, payload: { error: error?.code || "request_failed" } }))));
    const statuses: any = [first.status, rejected.status].sort((left?: any, right?: any) : any => left - right);
    assert.deepEqual(statuses, [200, 429], JSON.stringify({ first: first.payload, rejected: rejected.payload }, null, 2));
    const rejectedResponse: any = [first, rejected].find((item?: any) : any => item.status === 429);
    assertNoLeak(rejectedResponse?.payload || {}, "traffic rejection response");
    return { statuses };
  });

  await destructiveTest("traffic-control enforces concurrent in-flight slots", async () : Promise<any> => {
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

  await destructiveTest("invalid remote registration inputs fail without leaking secrets", async () : Promise<any> => {
    const badUrl: any = await api("POST", "/api/gateway/v1/external-services", {
      serviceId: "bad-url",
      baseUrl: "file:///tmp/nope",
      token: BAD_SECRET
    });
    assert.equal(badUrl.status >= 400, true);
    assert.equal(JSON.stringify(badUrl.payload).includes("bad-secret"), false);
    const traversal: any = await api("POST", "/api/gateway/v1/external-services", {
      serviceId: "bad-path",
      baseUrl: fixtureUrl,
      operations: [{ operationKey: "bad", path: "/../secret" }]
    });
    assert.equal(traversal.status >= 400, true);
    return { badUrl: badUrl.status, traversal: traversal.status };
  });

  await destructiveTest("concurrent MCP forwarding is isolated and counted", async () : Promise<any> => {
    const token: any = await createGrant("verify-gateway-concurrent", ["meshrix.gateway.read", "meshrix.gateway.write"]);
    const before: any = fixtureState.concurrentCount;
    const calls: any = Array.from({ length: 32 }, (_?: any, index?: any) : any =>
      callMcp(token, "meshrix.gateway", "meshrix.gateway.forward", {
        serviceId: SERVICE_ID,
        operationKey: "concurrent",
        query: { i: String(index) }
      }, 2000 + index)
    );
    const responses: any = await Promise.all(calls);
    assert.equal(responses.every((payload?: any) : any => !payload.error), true);
    assert.equal(fixtureState.concurrentCount, before + 32);
    return { calls: responses.length, fixtureHits: fixtureState.concurrentCount - before };
  });

  await test("disabled config service cannot forward", async () : Promise<any> => {
    const denied: any = await api("POST", "/api/gateway/v1/forward", {
      serviceId: DISABLED_SERVICE_ID,
      operationKey: "echo",
      body: { message: "after-disable" }
    });
    assert.equal(denied.status, 403);
    return { disabledByConfig: true, deniedStatus: denied.status };
  });

  await writeReport();
  console.log(`\n=== Upstream Gateway E2E passed; report: ${REPORT_PATH} ===`);
} catch (error: any) {
  await writeReport().catch(() : any => {});
  console.error(JSON.stringify(safeEvidence({
    ok: false,
    verifier: "tools/server-scripts/verify-upstream-gateway-e2e.ts",
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
    await new Promise((resolve?: any) : any => failingFixture.close(resolve));
  }
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
  await localSecretKeyCustody.close();
  restoreCapabilityKernelEnv();
}
