#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import { createOperationPermissionPlatform } from "../../packages/capabilities/src/operation-permission-core/index.ts";
import { createToolSkillManagementProvider } from "../../packages/capabilities/src/skills/tool-skill-management-provider.ts";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.ts";
import { executeConsoleDomainOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executor.ts";
import { installAuthenticatedFetch } from "./test-auth-helper.ts";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.ts";
import { createVerifierOperationDispatcher } from "./lib/verifier-operation-dispatcher.ts";

const REPORT_PATH: any = "build/reports/mcp-authorization-request-filters.json";

const restoreCapabilityKernelEnv: any = useIsolatedCapabilityKernelForVerifier();
const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-auth-filters-"));
const report: Record<string, any> = {
  schemaVersion: "v0.0.1:mcp:authorization-request-filters-report-1",
  verifier: "tools/server-scripts/verify-mcp-authorization-request-filters.ts",
  startedAt: new Date().toISOString(),
  tests: [],
  summary: {}
};

let server: any = null;
let platform: any = null;
let provider: any = null;
const verifierDispatcher: any = createVerifierOperationDispatcher("verify-mcp-authorization-request-filters");

function safeEvidence(value: Record<string, any> = {}) : any {
  return JSON.parse(JSON.stringify(value, (_?: any, child?: any) : any => {
    if (typeof child !== "string") return child;
    if (child.includes(userDataPath) || child.includes(os.homedir())) {
      return "[redacted-local-path]";
    }
    if (/Bearer\s+\S+/i.test(child) || /meshrix_[a-z0-9_-]+=/i.test(child)) {
      return "[redacted-secret]";
    }
    if (/mcp_auth_req|grant_|tool_exec|trace_/i.test(child)) {
      return "[redacted-runtime-id]";
    }
    return child;
  }));
}

function assertNoLeak(value?: any, label: any = "payload") : any {
  const serialized: any = JSON.stringify(value);
  assert.equal(serialized.includes(userDataPath), false, `${label} leaked verifier data path`);
  assert.equal(serialized.includes(os.homedir()), false, `${label} leaked user home path`);
  assert.equal(/Bearer\s+\S+/i.test(serialized), false, `${label} leaked bearer token`);
  assert.equal(/meshrix_[a-z0-9_-]+=/i.test(serialized), false, `${label} leaked cookie`);
}

async function writeReport() : Promise<any> {
  report.finishedAt = new Date().toISOString();
  report.summary.testCount = report.tests.length;
  report.summary.failedCount = report.tests.filter((item?: any) : any => item.status !== "passed").length;
  report.summary.releaseReady = report.summary.failedCount === 0;
  report.summary.reportLeakScan = false;
  assertNoLeak(report, "mcp authorization request filter report");
  report.summary.reportLeakScan = true;
  assertNoLeak(report, "mcp authorization request filter report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function record(name?: any, status?: any, evidence: Record<string, any> = {}) : any {
  report.tests.push({ name, status, evidence: safeEvidence(evidence) });
}

function failureEvidence(error?: any) : any {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    code: String(error?.code || ""),
    status: Number(error?.status || 0) || 0
  };
}

async function test(name?: any, fn?: any) : Promise<any> {
  process.stdout.write(`  ${name} ... `);
  try {
    const evidence: any = await fn();
    record(name, "passed", evidence);
    console.log("ok");
  } catch (error: any) {
    record(name, "failed", failureEvidence(error));
    console.log("FAIL");
    throw error;
  }
}

async function fetchJson(route?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(`${server.url}${route}`, options);
  const text: any = await response.text();
  const payload: any = text.trim() ? JSON.parse(text) : {};
  assertNoLeak(payload, route);
  return { status: response.status, payload };
}

async function api(method?: any, route?: any, body: any = undefined) : Promise<any> {
  return fetchJson(route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function createRequest(clientName?: any) : Promise<any> {
  const response: any = provider.createMcpAuthorizationRequest({
    clientName,
    requestedScopes: ["gateway:read"],
    requestedTools: ["meshrix.gateway.metrics"],
    reason: "filter verifier"
  });
  assert.equal(response.status, "pending");
  assert.ok(response.requestId);
  return response.requestId;
}

async function listViaHttp(status: any = "") : Promise<any> {
  const query: any = status ? `?status=${encodeURIComponent(status)}` : "";
  const response: any = await api("GET", `/api/console/mcp/authorization/requests${query}`);
  assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
  return response.payload.requests || [];
}

async function listViaConsole(provider?: any, status: any = "") : Promise<any> {
  const result: any = await executeConsoleDomainOperation({
    operationId: "operation_permission.mcp.list_requests",
    input: status ? { status } : {},
    context: { toolSkillManagementProvider: provider }
  });
  assert.equal(result.status, 200, JSON.stringify(result, null, 2));
  assertNoLeak(result.payload, `console ${status || "default"}`);
  return result.payload.requests || [];
}

function statusCounts(requests: any = []) : any {
  return requests.reduce((acc?: any, request?: any) : any => {
    const status: any = String(request.status || "unknown");
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
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
  await installAuthenticatedFetch(server);

  platform = createOperationPermissionPlatform({
    userDataPath,
    operations: SERVER_API_OPERATIONS,
    controllers: {},
    operationDispatcher: verifierDispatcher.operationDispatcher,
    operationConcurrencyScope: verifierDispatcher.operationConcurrencyScope
  });
  provider = createToolSkillManagementProvider({
    operationPermissionPlatform: platform,
    userDataPath
  });

  console.log("\n=== MCP Authorization Request Filters: real HTTP and console-domain semantics ===\n");

  const pendingId: any = await createRequest("pending-client");
  const approvedId: any = await createRequest("approved-client");
  const deniedId: any = await createRequest("denied-client");
  const expiredId: any = await createRequest("expired-client");

  await test("missing status defaults to pending", async () : Promise<any> => {
    const requests: any = await listViaHttp("");
    assert.equal(requests.length, 4);
    assert.deepEqual(Object.keys(statusCounts(requests)), ["pending"]);
    return { count: requests.length, statuses: statusCounts(requests) };
  });

  await test("approved and denied filters use shared store semantics", async () : Promise<any> => {
    const approved: any = await api("POST", `/api/console/mcp/authorization/requests/${encodeURIComponent(approvedId)}/resolve`, {
      resolution: "approved",
      clientName: "approved-client",
      scopes: ["gateway:read"],
      toolsets: ["meshrix.gateway.read"]
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.payload, null, 2));
    const denied: any = await api("POST", `/api/console/mcp/authorization/requests/${encodeURIComponent(deniedId)}/resolve`, {
      resolution: "denied"
    });
    assert.equal(denied.status, 200, JSON.stringify(denied.payload, null, 2));

    const approvedRows: any = await listViaHttp("approved");
    const deniedRows: any = await listViaHttp("denied");
    const rejectedRows: any = await listViaHttp("rejected");
    assert.equal(approvedRows.length, 1);
    assert.equal(deniedRows.length, 1);
    assert.equal(rejectedRows.length, 1);
    assert.equal(deniedRows[0].status, "rejected");
    return {
      approved: approvedRows.length,
      deniedAlias: deniedRows.length,
      rejected: rejectedRows.length
    };
  });

  await test("expired and all status filters do not query a literal all status", async () : Promise<any> => {
    platform.store.db.prepare("UPDATE mcp_authorization_requests SET status = 'expired' WHERE request_id = ?").run(expiredId);
    const pendingRows: any = await listViaHttp("pending");
    const expiredRows: any = await listViaHttp("expired");
    const allRows: any = await listViaHttp("all");
    assert.equal(pendingRows.length, 1);
    assert.equal(expiredRows.length, 1);
    assert.equal(allRows.length, 4);
    assert.deepEqual(statusCounts(allRows), {
      approved: 1,
      expired: 1,
      pending: 1,
      rejected: 1
    });
    void pendingId;
    return {
      pending: pendingRows.length,
      expired: expiredRows.length,
      all: allRows.length,
      allStatuses: statusCounts(allRows)
    };
  });

  await test("HTTP and console-domain filters share all, denied, expired, and default semantics", async () : Promise<any> => {
    const httpAll: any = await listViaHttp("all");
    const consoleAll: any = await listViaConsole(provider, "all");
    const httpDenied: any = await listViaHttp("denied");
    const consoleDenied: any = await listViaConsole(provider, "denied");
    const httpExpired: any = await listViaHttp("expired");
    const consoleExpired: any = await listViaConsole(provider, "expired");
    const httpDefault: any = await listViaHttp("");
    const consoleDefault: any = await listViaConsole(provider, "");
    assert.deepEqual(statusCounts(consoleAll), statusCounts(httpAll));
    assert.deepEqual(statusCounts(consoleDenied), statusCounts(httpDenied));
    assert.deepEqual(statusCounts(consoleExpired), statusCounts(httpExpired));
    assert.deepEqual(statusCounts(consoleDefault), statusCounts(httpDefault));
    return {
      all: statusCounts(consoleAll),
      denied: statusCounts(consoleDenied),
      expired: statusCounts(consoleExpired),
      default: statusCounts(consoleDefault)
    };
  });

  await writeReport();
  console.log(`\n=== MCP Authorization Request Filters passed; report: ${REPORT_PATH} ===`);
} catch (error: any) {
  await writeReport().catch(() : any => {});
  console.error(JSON.stringify(safeEvidence({
    ok: false,
    verifier: "tools/server-scripts/verify-mcp-authorization-request-filters.ts",
    failure: failureEvidence(error)
  }), null, 2));
  process.exitCode = 1;
} finally {
  await server?.close?.();
  platform?.close?.();
  await verifierDispatcher.close();
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
  restoreCapabilityKernelEnv();
}
