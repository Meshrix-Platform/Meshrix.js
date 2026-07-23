#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { createOperationPermissionPlatform } from "../../packages/capabilities/src/operation-permission-core/index.mjs";
import { createToolSkillManagementProvider } from "../../packages/capabilities/src/skills/tool-skill-management-provider.mjs";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.mjs";
import { executeConsoleDomainOperation } from "../../packages/server-runtime/src/composition/console-domain/operation-executor.mjs";
import { installAuthenticatedFetch } from "./test-auth-helper.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";
import { createVerifierOperationDispatcher } from "./lib/verifier-operation-dispatcher.mjs";

const REPORT_PATH = "build/reports/mcp-authorization-request-filters.json";

const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-mcp-auth-filters-"));
const report = {
  schemaVersion: "v0.0.1:mcp:authorization-request-filters-report-1",
  verifier: "tools/server-scripts/verify-mcp-authorization-request-filters.mjs",
  startedAt: new Date().toISOString(),
  tests: [],
  summary: {}
};

let server = null;
let platform = null;
let provider = null;
const verifierDispatcher = createVerifierOperationDispatcher("verify-mcp-authorization-request-filters");

function safeEvidence(value = {}) {
  return JSON.parse(JSON.stringify(value, (_, child) => {
    if (typeof child !== "string") return child;
    if (child.includes(userDataPath) || child.includes(os.homedir())) {
      return "[redacted-local-path]";
    }
    if (/Bearer\s+\S+/i.test(child) || /lico_[a-z0-9_-]+=/i.test(child)) {
      return "[redacted-secret]";
    }
    if (/mcp_auth_req|grant_|tool_exec|trace_/i.test(child)) {
      return "[redacted-runtime-id]";
    }
    return child;
  }));
}

function assertNoLeak(value, label = "payload") {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(userDataPath), false, `${label} leaked verifier data path`);
  assert.equal(serialized.includes(os.homedir()), false, `${label} leaked user home path`);
  assert.equal(/Bearer\s+\S+/i.test(serialized), false, `${label} leaked bearer token`);
  assert.equal(/lico_[a-z0-9_-]+=/i.test(serialized), false, `${label} leaked cookie`);
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  report.summary.testCount = report.tests.length;
  report.summary.failedCount = report.tests.filter((item) => item.status !== "passed").length;
  report.summary.releaseReady = report.summary.failedCount === 0;
  report.summary.reportLeakScan = false;
  assertNoLeak(report, "mcp authorization request filter report");
  report.summary.reportLeakScan = true;
  assertNoLeak(report, "mcp authorization request filter report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function record(name, status, evidence = {}) {
  report.tests.push({ name, status, evidence: safeEvidence(evidence) });
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
    record(name, "passed", evidence);
    console.log("ok");
  } catch (error) {
    record(name, "failed", failureEvidence(error));
    console.log("FAIL");
    throw error;
  }
}

async function fetchJson(route, options = {}) {
  const response = await fetch(`${server.url}${route}`, options);
  const text = await response.text();
  const payload = text.trim() ? JSON.parse(text) : {};
  assertNoLeak(payload, route);
  return { status: response.status, payload };
}

async function api(method, route, body = undefined) {
  return fetchJson(route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function createRequest(clientName) {
  const response = provider.createMcpAuthorizationRequest({
    clientName,
    requestedScopes: ["gateway:read"],
    requestedTools: ["lico.gateway.metrics"],
    reason: "filter verifier"
  });
  assert.equal(response.status, "pending");
  assert.ok(response.requestId);
  return response.requestId;
}

async function listViaHttp(status = "") {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const response = await api("GET", `/api/console/mcp/authorization/requests${query}`);
  assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
  return response.payload.requests || [];
}

async function listViaConsole(provider, status = "") {
  const result = await executeConsoleDomainOperation({
    operationId: "operation_permission.mcp.list_requests",
    input: status ? { status } : {},
    context: { toolSkillManagementProvider: provider }
  });
  assert.equal(result.status, 200, JSON.stringify(result, null, 2));
  assertNoLeak(result.payload, `console ${status || "default"}`);
  return result.payload.requests || [];
}

function statusCounts(requests = []) {
  return requests.reduce((acc, request) => {
    const status = String(request.status || "unknown");
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

  const pendingId = await createRequest("pending-client");
  const approvedId = await createRequest("approved-client");
  const deniedId = await createRequest("denied-client");
  const expiredId = await createRequest("expired-client");

  await test("missing status defaults to pending", async () => {
    const requests = await listViaHttp("");
    assert.equal(requests.length, 4);
    assert.deepEqual(Object.keys(statusCounts(requests)), ["pending"]);
    return { count: requests.length, statuses: statusCounts(requests) };
  });

  await test("approved and denied filters use shared store semantics", async () => {
    const approved = await api("POST", `/api/console/mcp/authorization/requests/${encodeURIComponent(approvedId)}/resolve`, {
      resolution: "approved",
      clientName: "approved-client",
      scopes: ["gateway:read"],
      toolsets: ["lico.gateway.read"]
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.payload, null, 2));
    const denied = await api("POST", `/api/console/mcp/authorization/requests/${encodeURIComponent(deniedId)}/resolve`, {
      resolution: "rejected"
    });
    assert.equal(denied.status, 200, JSON.stringify(denied.payload, null, 2));

    const approvedRows = await listViaHttp("approved");
    const deniedRows = await listViaHttp("denied");
    const rejectedRows = await listViaHttp("rejected");
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

  await test("expired and all status filters do not query a literal all status", async () => {
    platform.store.db.prepare("UPDATE mcp_authorization_requests SET status = 'expired' WHERE request_id = ?").run(expiredId);
    const pendingRows = await listViaHttp("pending");
    const expiredRows = await listViaHttp("expired");
    const allRows = await listViaHttp("all");
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

  await test("HTTP and console-domain filters share all, denied, expired, and default semantics", async () => {
    const httpAll = await listViaHttp("all");
    const consoleAll = await listViaConsole(provider, "all");
    const httpDenied = await listViaHttp("denied");
    const consoleDenied = await listViaConsole(provider, "denied");
    const httpExpired = await listViaHttp("expired");
    const consoleExpired = await listViaConsole(provider, "expired");
    const httpDefault = await listViaHttp("");
    const consoleDefault = await listViaConsole(provider, "");
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
} catch (error) {
  await writeReport().catch(() => {});
  console.error(JSON.stringify(safeEvidence({
    ok: false,
    verifier: "tools/server-scripts/verify-mcp-authorization-request-filters.mjs",
    failure: failureEvidence(error)
  }), null, 2));
  process.exitCode = 1;
} finally {
  await server?.close?.();
  platform?.close?.();
  await verifierDispatcher.close();
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  restoreCapabilityKernelEnv();
}
