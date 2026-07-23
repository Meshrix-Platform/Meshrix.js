#!/usr/bin/env node
// Optional real external HTTPS compatibility probe for the upstream gateway.
//
// This check reaches a real public HTTPS endpoint and is therefore excluded
// from default and container acceptance gates, which run on the self-contained
// fixture scenarios instead (verify-upstream-fixture-transit.mjs and
// verify-downstream-agent-tool-loop.mjs). Opt in explicitly with:
//   LICO_UPSTREAM_EXTERNAL_COMPAT=1 npm run verify:upstream-gateway-external
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.LICO_UPSTREAM_EXTERNAL_COMPAT !== "1") {
  console.log(
    "[upstream-gateway-external] skipped: this optional check contacts a real external HTTPS endpoint. " +
    "Set LICO_UPSTREAM_EXTERNAL_COMPAT=1 to run it."
  );
  process.exit(0);
}

import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { executeConsoleDomainOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executor.mjs";
import { installAuthenticatedFetch } from "./test-auth-helper.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";
import {
  createSignedMcpHeaders,
  createVerifierMcpProcessIdentity
} from "./mcp-process-identity-test-helper.mjs";
import { structuredPayload } from "./lib/upstream-gateway-e2e-helpers.mjs";
import { seedVerifierUpstreamServices, verifierOpaqueServiceId } from "./lib/upstream-gateway-verifier-publication.mjs";
import { upstreamOperationCapabilityId } from "../../packages/agents/src/upstream-gateway/operation-capability.mjs";
import { issueVerifierLocalMcpGrant } from "./lib/local-mcp-device-authorization.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH = "build/reports/upstream-gateway-external-compatibility.json";
const MCP_INTERFACE_VERSION = "v0.0.1:mcp:interface-1";
const SERVICE_ID = verifierOpaqueServiceId("verify-external-github-api");
const OPERATION_KEY = "rate-limit";
const EXTERNAL_HOST = "api.github.com";
const EXTERNAL_RETRY_ATTEMPTS = 3;
const EXTERNAL_RETRY_DELAY_MS = 750;

const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-upstream-external-"));
const dynamicSecretNeedles = new Set();
const mcpIdentityByToken = new Map();
let server = null;
let mcpNonceSequence = 0;

const report = {
  schemaVersion: "v0.0.1:upstream-gateway:external-conformance-report-1",
  verifier: "tools/server-scripts/verify-upstream-gateway-external-compatibility.mjs",
  startedAt: new Date().toISOString(),
  tests: [],
  destructiveTests: [],
  summary: {}
};

function externalServiceDescriptor() {
  return {
    serviceId: SERVICE_ID,
    label: "Verifier external GitHub API",
    baseUrl: `https://${EXTERNAL_HOST}:443`,
    healthPath: "/rate_limit",
    defaultHeaders: {
      "user-agent": "LicoMesh-Upstream-Gateway-External-Verifier",
      accept: "application/vnd.github+json"
    },
    trafficPolicy: { perMinute: 20, burst: 20 },
    operations: [
      {
        operationKey: OPERATION_KEY,
        method: "GET",
        path: "/rate_limit",
        risk: "read_only",
        requiredScopes: ["gateway:read"],
        timeoutMs: 10000,
        payloadTransport: {
          request: { mode: "structured_json", maxBytes: 1024, mediaTypes: ["application/json"] },
          response: { mode: "structured_json", maxBytes: 65536, mediaTypes: ["application/json"] }
        },
        publicResponseFields: ["rate.limit", "resources.core.limit"],
        responseSchema: {
          type: "object",
          required: ["resources", "rate"],
          properties: {
            resources: {
              type: "object",
              required: ["core"],
              properties: {
                core: {
                  type: "object",
                  required: ["limit", "remaining", "reset"],
                  properties: {
                    limit: { type: "number" },
                    remaining: { type: "number" },
                    reset: { type: "number" }
                  },
                  additionalProperties: true
                }
              },
              additionalProperties: true
            },
            rate: {
              type: "object",
              required: ["limit", "remaining", "reset"],
              properties: {
                limit: { type: "number" },
                remaining: { type: "number" },
                reset: { type: "number" }
              },
              additionalProperties: true
            }
          },
          additionalProperties: true
        }
      }
    ]
  };
}

function safeEvidence(value = {}) {
  return JSON.parse(JSON.stringify(value, (_, child) => {
    if (typeof child !== "string") {
      return child;
    }
    for (const needle of dynamicSecretNeedles) {
      if (needle && child.includes(needle)) {
        return "[redacted-dynamic-secret]";
      }
    }
    if (server?.url && child.includes(server.url)) {
      return "[redacted-local-url]";
    }
    if (child.includes(userDataPath) || child.includes(os.homedir()) || child.includes(repoRoot)) {
      return "[redacted-local-path]";
    }
    if (/Bearer\s+\S+/iu.test(child) || /lico_[a-z0-9_-]+=/iu.test(child)) {
      return "[redacted-secret]";
    }
    return child;
  }));
}

function assertNoLeak(value, label = "payload") {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(userDataPath), false, `${label} leaked verifier data path`);
  assert.equal(serialized.includes(os.homedir()), false, `${label} leaked user home path`);
  assert.equal(serialized.includes(repoRoot), false, `${label} leaked repo path`);
  for (const needle of dynamicSecretNeedles) {
    assert.equal(needle ? serialized.includes(needle) : false, false, `${label} leaked dynamic secret`);
  }
  assert.equal(/Bearer\s+\S+/iu.test(serialized), false, `${label} leaked bearer token`);
  assert.equal(/lico_[a-z0-9_-]+=/iu.test(serialized), false, `${label} leaked cookie`);
}

function record(collection, name, status, evidence = {}) {
  collection.push({ name, status, evidence: safeEvidence(evidence) });
}

function failureEvidence(error) {
  const message = String(error?.message || "").trim();
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    code: String(error?.code || ""),
    status: Number(error?.status || 0) || 0,
    message: message ? safeEvidence({ message }).message.slice(0, 600) : ""
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withExternalRetry(fn, {
  attempts = EXTERNAL_RETRY_ATTEMPTS,
  delayMs = EXTERNAL_RETRY_DELAY_MS
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fn({ attempt });
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  report.summary.testCount = report.tests.length;
  report.summary.destructiveTestCount = report.destructiveTests.length;
  report.summary.failedCount = [...report.tests, ...report.destructiveTests].filter((item) => item.status !== "passed").length;
  report.summary.externalHost = EXTERNAL_HOST;
  report.summary.releaseReady = report.summary.failedCount === 0;
  report.summary.reportLeakScan = true;
  assertNoLeak(report, "upstream gateway external compatibility report");
  await fs.mkdir(path.join(repoRoot, path.dirname(REPORT_PATH)), { recursive: true });
  await fs.writeFile(path.join(repoRoot, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text.trim() ? JSON.parse(text) : {};
  assertNoLeak(payload, url.replace(server?.url || "", ""));
  return { status: response.status, ok: response.ok, payload };
}

async function api(method, route, body = undefined) {
  return fetchJson(`${server.url}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function rpc(method, params = {}, id = 7000) {
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
  const result = await executeConsoleDomainOperation({
    operationId,
    input,
    context: {
      userDataPath,
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

function mcpRequest(method, params = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

async function createGrant(label, toolsets, {
  dynamicCapabilities = [],
  allowedServiceIds = []
} = {}) {
  const identity = createVerifierMcpProcessIdentity({ target: "codex", label });
  const response = await issueVerifierLocalMcpGrant({
    server,
    grantRequest: {
      targets: ["codex"],
      label,
      connectorVersion: "verify-upstream-gateway-external-compatibility",
      grantMode: "maintain",
      toolsets,
      dynamicCapabilities,
      allowedServiceIds,
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

async function callMcp(token, toolName, operation, input = {}, id = 1) {
  const binding = mcpIdentityByToken.get(token);
  assert.ok(binding, "MCP token must have a verifier process identity binding");
  const body = JSON.stringify(mcpRequest("tools/call", {
    name: toolName,
    arguments: {
      apiVersion: MCP_INTERFACE_VERSION,
      operation,
      input,
      clientVersion: "verify-upstream-gateway-external-compatibility"
    }
  }, id));
  const response = await fetchJson(`${server.url}/mcp`, {
    method: "POST",
    headers: createSignedMcpHeaders({
      token,
      body,
      nonce: `verify-upstream-external-${id}-${++mcpNonceSequence}`,
      url: new URL("/mcp", server.url),
      privateKeyPem: binding.identity.keyPair.privateKeyPem,
      clientIdentityPackage: binding.clientIdentityPackage
    }),
    body
  });
  assert.equal(response.status, 200, `Unexpected MCP HTTP status ${response.status}`);
  return response.payload;
}

function assertExternalForwardPayload(payload = {}, label = "forward payload") {
  assert.equal(payload.ok, true, `${label} did not report ok`);
  assert.equal(payload.serviceId, SERVICE_ID);
  assert.equal(payload.operationKey, OPERATION_KEY);
  assert.equal(payload.upstream?.status, 200);
  assert.equal(typeof payload.response?.json?.rate?.limit, "number");
  assert.equal(typeof payload.response?.json?.resources?.core?.limit, "number");
  assert.equal(payload.response.json.rate.remaining, undefined);
  assertNoLeak(payload, label);
}

try {
  await seedVerifierUpstreamServices({
    userDataPath,
    services: [externalServiceDescriptor()]
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

  console.log("\n=== Upstream Gateway External Compatibility: real HTTPS upstream ===\n");

  await test("server-local external service descriptor is loaded redacted", async () => {
    const response = await api("GET", "/api/gateway/v1/external-services");
    assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
    const service = response.payload.items.find((item) => item.serviceId === SERVICE_ID);
    assert.ok(service, "external service missing");
    assert.equal(service.baseUrl, "");
    assert.equal(service.endpointRedacted, true);
    assert.equal(service.operations.length, 1);
    return {
      serviceId: service.serviceId,
      endpointRedacted: service.endpointRedacted,
      operationCount: service.operations.length
    };
  });

  await test("health and policy preview reach the real external upstream", async () => {
    return withExternalRetry(async () => {
      const health = await api("GET", `/api/gateway/v1/external-services/${SERVICE_ID}/health`);
      assert.equal(health.status, 200, JSON.stringify(health.payload, null, 2));
      assert.equal(health.payload.ok, true);
      assert.equal(health.payload.status, 200);
      const preview = await api("POST", "/api/gateway/v1/policy/preview", {
        serviceId: SERVICE_ID,
        operationKey: OPERATION_KEY
      });
      assert.equal(preview.status, 200, JSON.stringify(preview.payload, null, 2));
      assert.equal(preview.payload.allowed, true);
      assert.equal(preview.payload.requiredScopes.includes("gateway:read"), true);
      return {
        healthStatus: health.payload.status,
        previewAllowed: preview.payload.allowed,
        externalHost: EXTERNAL_HOST
      };
    });
  });

  await test("HTTP RPC console and MCP forwarding share real external upstream compatibility", async () => {
    const httpForwarded = await withExternalRetry(async () => {
      const forwarded = await api("POST", "/api/gateway/v1/forward", {
        serviceId: SERVICE_ID,
        operationKey: OPERATION_KEY
      });
      assert.equal(forwarded.status, 200, JSON.stringify(forwarded.payload, null, 2));
      assertExternalForwardPayload(forwarded.payload, "http forward");
      return { payload: forwarded.payload };
    });

    const rpcForwarded = await withExternalRetry(async () => {
      const forwarded = await rpc("gateway.forward", {
        serviceId: SERVICE_ID,
        operationKey: OPERATION_KEY
      }, 7101);
      assert.equal(forwarded.error, undefined, JSON.stringify(forwarded.error || {}, null, 2));
      assertExternalForwardPayload(forwarded.result, "rpc forward");
      return { result: forwarded.result };
    });

    const consoleForwarded = await withExternalRetry(async () => {
      const forwarded = await consoleOperation("gateway.forward", {
        serviceId: SERVICE_ID,
        operationKey: OPERATION_KEY
      });
      assert.equal(forwarded.status, 200, JSON.stringify(forwarded, null, 2));
      assertExternalForwardPayload(forwarded.payload, "console forward");
      return { payload: forwarded.payload };
    });

    const token = await createGrant(
      "verify-upstream-external-forward",
      ["lico.gateway.read", "lico.gateway.write"],
      {
        dynamicCapabilities: [upstreamOperationCapabilityId(
          { serviceId: SERVICE_ID },
          { operationKey: OPERATION_KEY }
        )],
        allowedServiceIds: [SERVICE_ID]
      }
    );
    const mcpForwarded = await withExternalRetry(async () => {
      const mcpPayload = await callMcp(token, "lico.gateway", "lico.gateway.forward", {
        serviceId: SERVICE_ID,
        operationKey: OPERATION_KEY
      }, 7201);
      assert.equal(mcpPayload.error, undefined, JSON.stringify(mcpPayload.error || {}, null, 2));
      const forwarded = structuredPayload(mcpPayload);
      assertExternalForwardPayload(forwarded, "mcp forward");
      return { payload: forwarded };
    });

    return {
      httpStatus: httpForwarded.payload.upstream.status,
      rpcStatus: rpcForwarded.result.upstream.status,
      consoleStatus: consoleForwarded.payload.upstream.status,
      mcpStatus: mcpForwarded.payload.upstream.status,
      retryAttempts: {
        http: httpForwarded.attempts,
        rpc: rpcForwarded.attempts,
        console: consoleForwarded.attempts,
        mcp: mcpForwarded.attempts
      }
    };
  });

  await test("external forwarding records metadata-only audit and metrics", async () => {
    const audit = await api("GET", "/api/gateway/v1/audit");
    assert.equal(audit.status, 200);
    const completed = audit.payload.items.filter((item) =>
      item.eventType === "upstream.forward.completed" &&
      item.payload?.serviceId === SERVICE_ID &&
      item.payload?.operationKey === OPERATION_KEY
    );
    assert.equal(completed.length >= 4, true, `expected at least 4 external forwarding audit records, got ${completed.length}`);
    assert.equal(completed.every((item) => item.payload?.responsePolicy?.schemaValidated === true), true);
    assert.equal(completed.every((item) => item.payload?.responsePolicy?.publicFieldCount === 2), true);
    assert.equal(completed.every((item) => item.payload?.requestBody?.metadataOnly === true), true);

    const metrics = await api("GET", "/api/gateway/v1/metrics");
    assert.equal(metrics.status, 200);
    assert.equal(Number(metrics.payload.totalForwardCount) >= 4, true);
    assertNoLeak(audit.payload, "external audit payload");
    assertNoLeak(metrics.payload, "external metrics payload");
    return {
      completedAuditCount: completed.length,
      totalForwardCount: metrics.payload.totalForwardCount,
      schemaValidated: true,
      publicFieldCount: 2
    };
  });

  await writeReport();
  console.log(`\n=== Upstream Gateway External Compatibility passed; report: ${REPORT_PATH} ===`);
} catch (error) {
  await writeReport().catch(() => {});
  console.error(JSON.stringify(safeEvidence({
    ok: false,
    verifier: "tools/server-scripts/verify-upstream-gateway-external-compatibility.mjs",
    failure: failureEvidence(error)
  }), null, 2));
  process.exitCode = 1;
} finally {
  if (server?.close) {
    await server.close();
  }
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  restoreCapabilityKernelEnv();
}
