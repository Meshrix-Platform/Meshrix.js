#!/usr/bin/env node
// Optional real external HTTPS compatibility probe for the upstream gateway.
//
// This check reaches a real public HTTPS endpoint and is therefore excluded
// from default and container acceptance gates, which run on the self-contained
// fixture scenarios instead (verify-upstream-fixture-transit.ts and
// verify-downstream-agent-tool-loop.ts). Opt in explicitly with:
//   MESHRIX_UPSTREAM_EXTERNAL_COMPAT=1 npm run verify:upstream-gateway-external
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.MESHRIX_UPSTREAM_EXTERNAL_COMPAT !== "1") {
  console.log(
    "[upstream-gateway-external] skipped: this optional check contacts a real external HTTPS endpoint. " +
    "Set MESHRIX_UPSTREAM_EXTERNAL_COMPAT=1 to run it."
  );
  process.exit(0);
}

import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import { executeConsoleDomainOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executor.ts";
import { installAuthenticatedFetch } from "./test-auth-helper.ts";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.ts";
import {
  createSignedMcpHeaders,
  createVerifierMcpProcessIdentity
} from "./mcp-process-identity-test-helper.ts";
import { structuredPayload } from "./lib/upstream-gateway-e2e-helpers.ts";
import { seedVerifierUpstreamServices, verifierOpaqueServiceId } from "./lib/upstream-gateway-verifier-publication.ts";
import { upstreamOperationCapabilityId } from "../../packages/agents/src/upstream-gateway/operation-capability.ts";
import { issueVerifierMcpApiKey } from "./lib/verifier-mcp-api-key.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH: any = "build/reports/upstream-gateway-external-compatibility.json";
const MCP_INTERFACE_VERSION: any = "v0.0.1:mcp:interface-1";
const SERVICE_ID: any = verifierOpaqueServiceId("verify-external-github-api");
const OPERATION_KEY: any = "rate-limit";
const EXTERNAL_HOST: any = "api.github.com";
const EXTERNAL_RETRY_ATTEMPTS: any = 3;
const EXTERNAL_RETRY_DELAY_MS: any = 750;

const restoreCapabilityKernelEnv: any = useIsolatedCapabilityKernelForVerifier();
const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-external-"));
const dynamicSecretNeedles: any = new Set<any>();
const mcpIdentityByToken: any = new Map<any, any>();
let server: any = null;
let mcpNonceSequence: any = 0;

const report: Record<string, any> = {
  schemaVersion: "v0.0.1:upstream-gateway:external-conformance-report-1",
  verifier: "tools/server-scripts/verify-upstream-gateway-external-compatibility.ts",
  startedAt: new Date().toISOString(),
  tests: [],
  destructiveTests: [],
  summary: {}
};

function externalServiceDescriptor() : any {
  return {
    serviceId: SERVICE_ID,
    label: "Verifier external GitHub API",
    baseUrl: `https://${EXTERNAL_HOST}:443`,
    healthPath: "/rate_limit",
    defaultHeaders: {
      "user-agent": "Meshrix.js-Upstream-Gateway-External-Verifier",
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

function safeEvidence(value: Record<string, any> = {}) : any {
  return JSON.parse(JSON.stringify(value, (_?: any, child?: any) : any => {
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
    if (/Bearer\s+\S+/iu.test(child) || /meshrix_[a-z0-9_-]+=/iu.test(child)) {
      return "[redacted-secret]";
    }
    return child;
  }));
}

function assertNoLeak(value?: any, label: any = "payload") : any {
  const serialized: any = JSON.stringify(value);
  assert.equal(serialized.includes(userDataPath), false, `${label} leaked verifier data path`);
  assert.equal(serialized.includes(os.homedir()), false, `${label} leaked user home path`);
  assert.equal(serialized.includes(repoRoot), false, `${label} leaked repo path`);
  for (const needle of dynamicSecretNeedles) {
    assert.equal(needle ? serialized.includes(needle) : false, false, `${label} leaked dynamic secret`);
  }
  assert.equal(/Bearer\s+\S+/iu.test(serialized), false, `${label} leaked bearer token`);
  assert.equal(/meshrix_[a-z0-9_-]+=/iu.test(serialized), false, `${label} leaked cookie`);
}

function record(collection?: any, name?: any, status?: any, evidence: Record<string, any> = {}) : any {
  collection.push({ name, status, evidence: safeEvidence(evidence) });
}

function failureEvidence(error?: any) : any {
  const message: any = String(error?.message || "").trim();
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    code: String(error?.code || ""),
    status: Number(error?.status || 0) || 0,
    message: message ? safeEvidence({ message }).message.slice(0, 600) : ""
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
    throw error;
  }
}

function sleep(ms?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

async function withExternalRetry(fn?: any, {
  attempts = EXTERNAL_RETRY_ATTEMPTS,
  delayMs = EXTERNAL_RETRY_DELAY_MS
}: Record<string, any> = {}) : Promise<any> {
  let lastError: any = null;
  for (let attempt: any = 1; attempt <= attempts; attempt += 1) {
    try {
      const result: any = await fn({ attempt });
      return { ...result, attempts: attempt };
    } catch (error: any) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

async function writeReport() : Promise<any> {
  report.finishedAt = new Date().toISOString();
  report.summary.testCount = report.tests.length;
  report.summary.destructiveTestCount = report.destructiveTests.length;
  report.summary.failedCount = [...report.tests, ...report.destructiveTests].filter((item?: any) : any => item.status !== "passed").length;
  report.summary.externalHost = EXTERNAL_HOST;
  report.summary.releaseReady = report.summary.failedCount === 0;
  report.summary.reportLeakScan = true;
  assertNoLeak(report, "upstream gateway external compatibility report");
  await fs.mkdir(path.join(repoRoot, path.dirname(REPORT_PATH)), { recursive: true });
  await fs.writeFile(path.join(repoRoot, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function fetchJson(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(url, options);
  const text: any = await response.text();
  const payload: any = text.trim() ? JSON.parse(text) : {};
  assertNoLeak(payload, url.replace(server?.url || "", ""));
  return { status: response.status, ok: response.ok, payload };
}

async function api(method?: any, route?: any, body: any = undefined) : Promise<any> {
  return fetchJson(`${server.url}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function rpc(method?: any, params: Record<string, any> = {}, id: any = 7000) : Promise<any> {
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
  const result: any = await executeConsoleDomainOperation({
    operationId,
    input,
    context: {
      userDataPath,
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

function mcpRequest(method?: any, params: Record<string, any> = {}, id: any = 1) : any {
  return { jsonrpc: "2.0", id, method, params };
}

async function createGrant(label?: any, toolsets?: any, {
  dynamicCapabilities = [],
  allowedServiceIds = []
}: Record<string, any> = {}) : Promise<any> {
  const response: any = await issueVerifierMcpApiKey({
    server,
    access: {
      targets: ["codex"],
      label,
      connectorVersion: "verify-upstream-gateway-external-compatibility",
      grantMode: "maintain",
      toolsets,
      dynamicCapabilities,
      allowedServiceIds
    }
  });
  assert.ok(response.apiKey);
  dynamicSecretNeedles.add(response.apiKey);
  return response.apiKey;
}

async function callMcp(token?: any, toolName?: any, operation?: any, input: Record<string, any> = {}, id: any = 1) : Promise<any> {
  const body: any = JSON.stringify(mcpRequest("tools/call", {
    name: toolName,
    arguments: {
      apiVersion: MCP_INTERFACE_VERSION,
      operation,
      input,
      clientVersion: "verify-upstream-gateway-external-compatibility"
    }
  }, id));
  const response: any = await fetchJson(`${server.url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Meshrix.js-Api-Key": token, "X-Meshrix.js-MCP-Target": "codex" },
    body
  });
  assert.equal(response.status, 200, `Unexpected MCP HTTP status ${response.status}`);
  return response.payload;
}

function assertExternalForwardPayload(payload: Record<string, any> = {}, label: any = "forward payload") : any {
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

  await test("server-local external service descriptor is loaded redacted", async () : Promise<any> => {
    const response: any = await api("GET", "/api/gateway/v1/external-services");
    assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
    const service: any = response.payload.items.find((item?: any) : any => item.serviceId === SERVICE_ID);
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

  await test("health and policy preview reach the real external upstream", async () : Promise<any> => {
    return withExternalRetry(async () : Promise<any> => {
      const health: any = await api("GET", `/api/gateway/v1/external-services/${SERVICE_ID}/health`);
      assert.equal(health.status, 200, JSON.stringify(health.payload, null, 2));
      assert.equal(health.payload.ok, true);
      assert.equal(health.payload.status, 200);
      const preview: any = await api("POST", "/api/gateway/v1/policy/preview", {
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

  await test("HTTP RPC console and MCP forwarding share real external upstream compatibility", async () : Promise<any> => {
    const httpForwarded: any = await withExternalRetry(async () : Promise<any> => {
      const forwarded: any = await api("POST", "/api/gateway/v1/forward", {
        serviceId: SERVICE_ID,
        operationKey: OPERATION_KEY
      });
      assert.equal(forwarded.status, 200, JSON.stringify(forwarded.payload, null, 2));
      assertExternalForwardPayload(forwarded.payload, "http forward");
      return { payload: forwarded.payload };
    });

    const rpcForwarded: any = await withExternalRetry(async () : Promise<any> => {
      const forwarded: any = await rpc("gateway.forward", {
        serviceId: SERVICE_ID,
        operationKey: OPERATION_KEY
      }, 7101);
      assert.equal(forwarded.error, undefined, JSON.stringify(forwarded.error || {}, null, 2));
      assertExternalForwardPayload(forwarded.result, "rpc forward");
      return { result: forwarded.result };
    });

    const consoleForwarded: any = await withExternalRetry(async () : Promise<any> => {
      const forwarded: any = await consoleOperation("gateway.forward", {
        serviceId: SERVICE_ID,
        operationKey: OPERATION_KEY
      });
      assert.equal(forwarded.status, 200, JSON.stringify(forwarded, null, 2));
      assertExternalForwardPayload(forwarded.payload, "console forward");
      return { payload: forwarded.payload };
    });

    const token: any = await createGrant(
      "verify-upstream-external-forward",
      ["meshrix.gateway.read", "meshrix.gateway.write"],
      {
        dynamicCapabilities: [upstreamOperationCapabilityId(
          { serviceId: SERVICE_ID },
          { operationKey: OPERATION_KEY }
        )],
        allowedServiceIds: [SERVICE_ID]
      }
    );
    const mcpForwarded: any = await withExternalRetry(async () : Promise<any> => {
      const mcpPayload: any = await callMcp(token, "meshrix.gateway", "meshrix.gateway.forward", {
        serviceId: SERVICE_ID,
        operationKey: OPERATION_KEY
      }, 7201);
      assert.equal(mcpPayload.error, undefined, JSON.stringify(mcpPayload.error || {}, null, 2));
      const forwarded: any = structuredPayload(mcpPayload);
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

  await test("external forwarding records metadata-only audit and metrics", async () : Promise<any> => {
    const audit: any = await api("GET", "/api/gateway/v1/audit");
    assert.equal(audit.status, 200);
    const completed: any = audit.payload.items.filter((item?: any) : any =>
      item.eventType === "upstream.forward.completed" &&
      item.payload?.serviceId === SERVICE_ID &&
      item.payload?.operationKey === OPERATION_KEY
    );
    assert.equal(completed.length >= 4, true, `expected at least 4 external forwarding audit records, got ${completed.length}`);
    assert.equal(completed.every((item?: any) : any => item.payload?.responsePolicy?.schemaValidated === true), true);
    assert.equal(completed.every((item?: any) : any => item.payload?.responsePolicy?.publicFieldCount === 2), true);
    assert.equal(completed.every((item?: any) : any => item.payload?.requestBody?.metadataOnly === true), true);

    const metrics: any = await api("GET", "/api/gateway/v1/metrics");
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
} catch (error: any) {
  await writeReport().catch(() : any => {});
  console.error(JSON.stringify(safeEvidence({
    ok: false,
    verifier: "tools/server-scripts/verify-upstream-gateway-external-compatibility.ts",
    failure: failureEvidence(error)
  }), null, 2));
  process.exitCode = 1;
} finally {
  if (server?.close) {
    await server.close();
  }
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
  restoreCapabilityKernelEnv();
}
