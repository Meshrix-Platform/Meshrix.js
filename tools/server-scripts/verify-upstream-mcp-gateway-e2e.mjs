#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { startHttpServer } from "../../apps/server/runtime/http-server.mjs";
import { compileUpstreamOperationCapability } from "../../packages/agents/src/upstream-gateway/operation-capability.mjs";
import { getOperationPermissionDatabasePath } from "../../packages/capabilities/src/operation-permission-core/store.mjs";
import { installAuthenticatedFetch } from "./test-auth-helper.mjs";
import { useIsolatedCapabilityKernelForVerifier } from "./capability-kernel-test-env.mjs";
import {
  createSignedMcpHeaders,
  createVerifierMcpProcessIdentity
} from "./mcp-process-identity-test-helper.mjs";
import { assertNoLeak as assertNoSensitiveReportLeak } from "./lib/report-evidence-safety.mjs";
import {
  UPSTREAM_FIXTURE_CLI_PATH,
  createUpstreamFixtureHttpService
} from "./lib/upstream-fixture-service.mjs";
import {
  UPSTREAM_FIXTURE_MCP_SERVICE_ID as SERVICE_ID,
  UPSTREAM_FIXTURE_TOOL_PREFIX
} from "./lib/upstream-fixture-grant.mjs";
import {
  UPSTREAM_MCP_GATEWAY_REPORT_PATH,
  UPSTREAM_MCP_GATEWAY_SCHEMA_VERSION,
  UPSTREAM_MCP_GATEWAY_VERIFIER,
  createUpstreamMcpGatewayReadiness
} from "./lib/upstream-mcp-gateway-evidence.mjs";
import {
  writeVerifierLocalUpstreamSecret,
  seedVerifierUpstreamServices,
  verifierOpaqueServiceId
} from "./lib/upstream-gateway-verifier-publication.mjs";
import { issueVerifierLocalMcpGrant } from "./lib/local-mcp-device-authorization.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtureCliPath = path.join(repoRoot, UPSTREAM_FIXTURE_CLI_PATH);
const REPORT_PATH = UPSTREAM_MCP_GATEWAY_REPORT_PATH;
const PUBLIC_TOOL_NAME = `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.records.search`;
const PUBLIC_FAILING_TOOL_NAME = `upstream.${UPSTREAM_FIXTURE_TOOL_PREFIX}.records.get`;
const APPROVAL_SERVICE_ID = verifierOpaqueServiceId("fixture-mcp-approval");
const APPROVAL_TOOL_PREFIX = "fixture-approval";
const APPROVAL_SECRET_REF = "secret://verify/upstream-mcp/approval-token";
const APPROVAL_UPSTREAM_TOOL_NAME = "records.purge";
const APPROVAL_PUBLIC_TOOL_NAME = `upstream.${APPROVAL_TOOL_PREFIX}.${APPROVAL_UPSTREAM_TOOL_NAME}`;
const APPROVAL_PROJECTED_TOOL_ID = `upstream.${APPROVAL_SERVICE_ID.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)}.tools-call`;
const APPROVAL_SCOPES = ["gateway:read", "gateway:write", "gateway:maintain"];

const restoreCapabilityKernelEnv = useIsolatedCapabilityKernelForVerifier();
const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-mcp-gateway-"));
const approvalFixtureToken = `fixture-approval-${randomBytes(18).toString("hex")}`;

let server = null;
let approvalFixture = null;
let approvalFixtureService = null;
let exitCode = 0;
let approvalGrantId = "";
let approvalCapability = null;
let approvalToken = "";
let mcpRequestId = 100;
const mcpIdentityByToken = new Map();
const redactionNeedles = new Set([
  userDataPath,
  os.homedir(),
  approvalFixtureToken,
  APPROVAL_SECRET_REF
]);
const report = {
  schemaVersion: UPSTREAM_MCP_GATEWAY_SCHEMA_VERSION,
  verifier: UPSTREAM_MCP_GATEWAY_VERIFIER,
  startedAt: new Date().toISOString(),
  tests: []
};

function safeEvidence(value = {}) {
  return JSON.parse(JSON.stringify(value, (_key, child) => {
    if (typeof child !== "string") return child;
    for (const needle of redactionNeedles) {
      if (needle && child.includes(needle)) return "[redacted-sensitive-value]";
    }
    if (server?.url && child.includes(server.url)) return "[redacted-server-url]";
    if (/Bearer\s+\S+/i.test(child) || /meshrix_[a-z0-9_-]+=/i.test(child)) return "[redacted-token]";
    return child;
  }));
}

function testEvidence(name) {
  return report.tests.find((item) => item.name === name)?.evidence || {};
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  const approval = testEvidence("approval-required upstream MCP call resumes exactly once with credential binding");
  const rejected = testEvidence("rejected and duplicate upstream MCP resolutions have no upstream side effects");
  const expired = testEvidence("expired upstream MCP approval has no upstream side effects");
  const audit = testEvidence("upstream MCP approval lifecycle emits bound audit evidence");
  report.summary = {
    testCount: report.tests.length,
    failedCount: report.tests.filter((item) => item.status !== "passed").length,
    reportLeakScan: true,
    approvalResumeVerified: approval.pendingBeforeForward === true && approval.resumeCompleted === true,
    approvalExactlyOnceVerified: Number(approval.upstreamHitDelta) === 1 && approval.duplicateResolveRejected === true,
    approvalDenialNoSideEffectVerified: rejected.rejected === true && Number(rejected.upstreamHitDelta) === 0,
    approvalExpiryNoSideEffectVerified: expired.expired === true && Number(expired.upstreamHitDelta) === 0,
    duplicateResolutionNoSideEffectVerified:
      approval.duplicateResolveRejected === true &&
      rejected.duplicateResolveRejected === true &&
      expired.duplicateResolveRejected === true,
    approvalAuditVerified: audit.boundGrantAuditVerified === true,
    credentialBindingVerified:
      approval.credentialBindingAuthorized === true && approval.credentialInjectionAccepted === true
  };
  let safeReport = safeEvidence(report);
  assertNoSensitiveReportLeak(safeReport, "upstream MCP gateway E2E report");
  const readiness = createUpstreamMcpGatewayReadiness(safeReport);
  safeReport.summary.releaseReady = readiness.releaseReady;
  safeReport.summary.liveStatus = readiness.liveStatus;
  safeReport.summary.readinessSourceOfTruth = readiness.sourceOfTruth;
  safeReport.readiness = readiness;
  assertNoSensitiveReportLeak(safeReport, "upstream MCP gateway E2E report");
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(safeReport, null, 2)}\n`, "utf8");
}

function record(name, status, evidence = {}) {
  report.tests.push({ name, status, evidence: safeEvidence(evidence) });
}

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const evidence = await fn();
    record(name, "passed", evidence);
    console.log("ok");
  } catch (error) {
    record(name, "failed", { errorName: error?.name || "Error", message: error?.message || String(error) });
    console.log("FAIL");
    throw error;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    status: response.status,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

async function api(method, route, body = undefined) {
  return fetchJson(`${server.url}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function mcp(token, body) {
  const grantIdentityBinding = mcpIdentityByToken.get(token);
  assert.ok(grantIdentityBinding, "MCP token must have a verifier process identity binding");
  const bodyText = JSON.stringify(body);
  return fetchJson(`${server.url}/mcp`, {
    method: "POST",
    headers: createSignedMcpHeaders({
      token,
      target: "opencode",
      body: bodyText,
      nonce: `verify-upstream-mcp-${body.id || Date.now()}`,
      url: new URL("/mcp", server.url),
      privateKeyPem: grantIdentityBinding.identity.keyPair.privateKeyPem,
      clientIdentityPackage: grantIdentityBinding.clientIdentityPackage
    }),
    body: bodyText
  });
}

function withOperationPermissionDatabase(callback) {
  const database = new Database(getOperationPermissionDatabasePath(userDataPath));
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function approvalFixtureHitCount() {
  return Number(approvalFixtureService?.fixture?.state?.callCount || 0);
}

async function resolvePendingOperation(pendingOperationId, resolution) {
  return api(
    "POST",
    `/api/operation-permission/v1/pending-operations/${encodeURIComponent(pendingOperationId)}/resolve`,
    {
      resolution,
      reason: "Verify the upstream MCP approval lifecycle."
    }
  );
}

async function createApprovalPendingOperation() {
  mcpRequestId += 1;
  const response = await mcp(approvalToken, {
    jsonrpc: "2.0",
    id: mcpRequestId,
    method: "tools/call",
    params: {
      name: APPROVAL_PUBLIC_TOOL_NAME,
      arguments: {}
    }
  });
  assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
  assert.equal(response.payload.error, undefined, JSON.stringify(response.payload, null, 2));
  const structured = response.payload.result?.structuredContent || {};
  const payload = structured.payload || {};
  assert.equal(
    payload.status || structured.status,
    "pending_approval",
    JSON.stringify(response.payload, null, 2)
  );
  const pendingOperationId = String(
    payload.pendingOperation?.pendingOperationId ||
      structured.pendingOperation?.pendingOperationId ||
      ""
  );
  assert.ok(pendingOperationId, "approval-required upstream MCP call must create a pending operation");
  redactionNeedles.add(pendingOperationId);
  return { pendingOperationId, payload: payload.status ? payload : structured };
}

try {
  approvalFixtureService = createUpstreamFixtureHttpService({ token: approvalFixtureToken });
  approvalFixture = await approvalFixtureService.start();
  redactionNeedles.add(approvalFixture.url);
  redactionNeedles.add(new URL(approvalFixture.url).host);
  await writeVerifierLocalUpstreamSecret({
    userDataPath,
    fixtureUrl: approvalFixture.url,
    secretRef: APPROVAL_SECRET_REF,
    resolvedSecretToken: approvalFixtureToken,
    serviceId: APPROVAL_SERVICE_ID,
    provider: "upstream-mcp-gateway-e2e",
    family: "upstream-gateway",
    authType: "bearer",
    scopes: APPROVAL_SCOPES,
    trackSecret: (value) => redactionNeedles.add(String(value || "")),
    payload: { token: approvalFixtureToken }
  });
  const approvalServiceConfig = {
    serviceId: APPROVAL_SERVICE_ID,
    serviceProtocol: "mcp",
    label: "Approval fixture MCP service",
    mcp: {
      transport: "http",
      url: `${approvalFixture.url}/mcp`,
      toolNamePrefix: APPROVAL_TOOL_PREFIX,
      toolsCacheTtlMs: 0,
      timeoutMs: 5000
    },
    credentialRefs: [APPROVAL_SECRET_REF],
    requiredScopes: APPROVAL_SCOPES,
    operations: [{
      operationKey: "tools/call",
      protocol: "mcp",
      requiredScopes: ["gateway:write"],
      risk: "repair_write",
      requiresApproval: true
    }],
    trafficPolicy: { perMinute: 120, burst: 120, maxConcurrent: 10 },
    circuitBreaker: { failureThreshold: 2, cooldownMs: 30000 }
  };
  approvalCapability = compileUpstreamOperationCapability(approvalServiceConfig, {
    operationKey: "tools/call",
    protocol: "mcp",
    requiredScopes: ["gateway:write"],
    risk: "repair_write",
    requiresApproval: true
  }, { upstreamToolName: APPROVAL_UPSTREAM_TOOL_NAME });
  await seedVerifierUpstreamServices({
    userDataPath,
    services: [
      {
        serviceId: SERVICE_ID,
        serviceProtocol: "mcp",
        label: "Upstream fixture MCP service",
        mcp: {
          transport: "stdio",
          command: process.execPath,
          args: [fixtureCliPath, "--mode", "mcp-stdio"],
          toolNamePrefix: UPSTREAM_FIXTURE_TOOL_PREFIX,
          timeoutMs: 5000
        },
        operations: [{
          operationKey: "tools/call",
          protocol: "mcp",
          requiredScopes: ["gateway:write"],
          risk: "safe_write"
        }],
        trafficPolicy: { perMinute: 120, burst: 120, maxConcurrent: 10 },
        circuitBreaker: { failureThreshold: 1, cooldownMs: 30000 }
      },
      approvalServiceConfig
    ]
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

  console.log("\n=== Upstream MCP Gateway E2E: stdio MCP upstream to downstream MCP tool ===\n");

  await test("load stdio MCP upstream service from the durable manifest snapshot", async () => {
    const listed = await api("GET", "/api/gateway/v1/external-services");
    assert.equal(listed.status, 200, JSON.stringify(listed.payload, null, 2));
    const service = (listed.payload.items || []).find((item) => item.serviceId === SERVICE_ID);
    assert.ok(service, "configured MCP upstream missing");
    assert.equal(service.serviceProtocol, "mcp");
    assert.equal(service.mcp.transport, "stdio");
    assert.equal(service.mcp.argCount, 3);
    const rejected = await api("POST", "/api/gateway/v1/external-services", {
      serviceId: "forbidden-mcp-registration",
      serviceProtocol: "mcp"
    });
    assert.equal(rejected.status >= 400, true);
    return {
      serviceId: service.serviceId,
      serviceProtocol: service.serviceProtocol,
      mcpTransport: service.mcp.transport,
      remoteRegistrationRejected: true
    };
  });

  let token = "";
  await test("create local agent grant with upstream MCP visibility", async () => {
    const identity = createVerifierMcpProcessIdentity({
      target: "opencode",
      label: "verify-upstream-mcp-agent-grant"
    });
    const localGrant = await issueVerifierLocalMcpGrant({
      server,
      grantRequest: {
        targets: ["opencode"],
        label: "verify-upstream-mcp-agent-grant",
        connectorVersion: "verify-upstream-mcp",
        toolsets: ["meshrix.gateway.read", "meshrix.gateway.write"],
        dynamicCapabilities: ["records.search", "records.get"].map((upstreamToolName) =>
          compileUpstreamOperationCapability({ serviceId: SERVICE_ID, serviceProtocol: "mcp" }, {
            operationKey: "tools/call",
            protocol: "mcp",
            requiredScopes: ["gateway:read"],
            risk: "read_only"
          }, { upstreamToolName }).capabilityId
        ),
        allowedServiceIds: [SERVICE_ID],
        processIdentity: identity.request
      }
    });
    assert.equal(localGrant.status, 201, JSON.stringify(localGrant.payload, null, 2));
    assert.ok(localGrant.payload.token);
    assert.ok(localGrant.payload.processIdentity?.clientIdentityPackage);
    token = localGrant.payload.token;
    redactionNeedles.add(token);
    mcpIdentityByToken.set(token, {
      identity,
      clientIdentityPackage: localGrant.payload.processIdentity.clientIdentityPackage
    });
    return {
      targetCount: localGrant.payload.targets?.length || 0,
      hasToken: true
    };
  });

  await test("downstream MCP tools/list exposes upstream MCP tool", async () => {
    const listed = await mcp(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    });
    assert.equal(listed.status, 200, JSON.stringify(listed.payload, null, 2));
    const tools = listed.payload.result.tools || [];
    assert.equal(tools.some((tool) => tool.name === PUBLIC_TOOL_NAME), true, JSON.stringify(tools.map((tool) => tool.name), null, 2));
    const tool = tools.find((item) => item.name === PUBLIC_TOOL_NAME);
    assert.equal(tool._meta.serviceId, SERVICE_ID);
    assert.deepEqual(tool._meta.requiredScopes, ["gateway:read"]);
    return {
      toolCount: tools.length,
      upstreamToolVisible: true,
      publicToolName: PUBLIC_TOOL_NAME
    };
  });

  await test("downstream MCP tools/call reaches upstream MCP tools/call", async () => {
    const called = await mcp(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: PUBLIC_TOOL_NAME,
        arguments: {
          query: "alpha",
          perPage: 1
        }
      }
    });
    assert.equal(called.status, 200, JSON.stringify(called.payload, null, 2));
    assert.equal(called.payload.error, undefined, JSON.stringify(called.payload, null, 2));
    assert.ok(called.payload.result, JSON.stringify(called.payload, null, 2));
    assert.ok(called.payload.result.structuredContent, JSON.stringify(called.payload.result, null, 2));
    const structured = called.payload.result.structuredContent;
    assert.equal(structured.upstreamMcp, true);
    assert.equal(structured.toolName, PUBLIC_TOOL_NAME);
    assert.equal(structured.payload.response.structuredContent.ok, true);
    assert.equal(structured.payload.response.structuredContent.count, 1);
    assert.equal(structured.payload.response.structuredContent.items[0]?.name, "alpha");
    return {
      upstreamMcp: structured.upstreamMcp,
      upstreamToolCount: structured.payload.response.structuredContent.count,
      auditRecorded: Boolean(structured.payload.auditId)
    };
  });

  await test("failed upstream MCP tools/call opens service circuit", async () => {
    const failed = await mcp(token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: PUBLIC_FAILING_TOOL_NAME,
        arguments: { recordId: "record-missing" }
      }
    });
    assert.equal(failed.status, 200, JSON.stringify(failed.payload, null, 2));
    assert.ok(failed.payload.error, JSON.stringify(failed.payload, null, 2));
    const preview = await api("POST", "/api/gateway/v1/policy/preview", {
      serviceId: SERVICE_ID,
      operationKey: "tools/call"
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.payload, null, 2));
    assert.equal(preview.payload.traffic.circuit.open, true);
    assert.equal(preview.payload.traffic.deniedReason, "circuit_open");
    const blocked = await mcp(token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: PUBLIC_TOOL_NAME,
        arguments: {
          query: "alpha"
        }
      }
    });
    assert.equal(blocked.status, 429, JSON.stringify(blocked.payload, null, 2));
    assert.ok(blocked.payload.error, JSON.stringify(blocked.payload, null, 2));
    return {
      failureObserved: true,
      circuitOpen: preview.payload.traffic.circuit.open,
      deniedReason: preview.payload.traffic.deniedReason
    };
  });

  await test("approval-required upstream MCP call resumes exactly once with credential binding", async () => {
    const identity = createVerifierMcpProcessIdentity({
      target: "opencode",
      label: "verify-upstream-mcp-approval-grant"
    });
    const localGrant = await issueVerifierLocalMcpGrant({
      server,
      grantRequest: {
        targets: ["opencode"],
        label: "verify-upstream-mcp-approval-grant",
        connectorVersion: "verify-upstream-mcp",
        grantMode: "maintain",
        maxRisk: "repair_write",
        toolsets: ["meshrix.gateway.read", "meshrix.gateway.write", "meshrix.gateway.maintain"],
        scopes: APPROVAL_SCOPES,
        dynamicCapabilities: [approvalCapability.capabilityId],
        allowedServiceIds: [APPROVAL_SERVICE_ID],
        allowedSecretBindings: approvalCapability.credentialBindingIds,
        processIdentity: identity.request
      }
    });
    assert.equal(localGrant.status, 201, JSON.stringify(localGrant.payload, null, 2));
    assert.ok(localGrant.payload.token);
    assert.ok(localGrant.payload.grant?.id);
    assert.ok(localGrant.payload.processIdentity?.clientIdentityPackage);
    assert.deepEqual(
      localGrant.payload.grant.allowedSecretBindings,
      approvalCapability.credentialBindingIds,
      "approval grant must retain the exact upstream credential binding"
    );
    approvalToken = localGrant.payload.token;
    approvalGrantId = localGrant.payload.grant.id;
    redactionNeedles.add(approvalToken);
    redactionNeedles.add(approvalGrantId);
    mcpIdentityByToken.set(approvalToken, {
      identity,
      clientIdentityPackage: localGrant.payload.processIdentity.clientIdentityPackage
    });

    approvalFixtureService.fixture.reset();
    const beforeHits = approvalFixtureHitCount();
    const pending = await createApprovalPendingOperation();
    assert.equal(approvalFixtureHitCount(), beforeHits, "pending approval must not reach the upstream MCP service");
    assert.equal(approvalFixtureService.fixture.state.purged, false);

    const pendingList = await api("GET", "/api/operation-permission/v1/pending-operations?status=pending&limit=20");
    assert.equal(pendingList.status, 200, JSON.stringify(pendingList.payload, null, 2));
    assert.equal(
      (pendingList.payload.pendingOperations || []).some((item) =>
        item.pendingOperationId === pending.pendingOperationId && item.toolId === APPROVAL_PROJECTED_TOOL_ID
      ),
      true,
      "approval-required upstream MCP operation must be resolvable from the pending list"
    );

    const approved = await resolvePendingOperation(pending.pendingOperationId, "approved");
    assert.equal(approved.status, 200, JSON.stringify(approved.payload, null, 2));
    assert.equal(approved.payload.pendingOperation?.status, "completed", JSON.stringify(approved.payload, null, 2));
    assert.equal(approvalFixtureHitCount(), beforeHits + 1, "approved resume must issue exactly one upstream MCP tools/call");
    assert.equal(approvalFixtureService.fixture.state.purged, true);

    const duplicate = await resolvePendingOperation(pending.pendingOperationId, "approved");
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.payload, null, 2));
    assert.equal(duplicate.payload.error?.code, "pending_operation_replayed");
    assert.equal(approvalFixtureHitCount(), beforeHits + 1, "duplicate approval must not replay the upstream MCP call");

    return {
      pendingBeforeForward: true,
      resumeCompleted: true,
      upstreamHitDelta: approvalFixtureHitCount() - beforeHits,
      duplicateResolveRejected: true,
      credentialBindingAuthorized: true,
      credentialInjectionAccepted: true
    };
  });

  await test("rejected and duplicate upstream MCP resolutions have no upstream side effects", async () => {
    approvalFixtureService.fixture.reset();
    const beforeHits = approvalFixtureHitCount();
    const pending = await createApprovalPendingOperation();
    assert.equal(approvalFixtureHitCount(), beforeHits);

    const rejected = await resolvePendingOperation(pending.pendingOperationId, "denied");
    assert.equal(rejected.status, 200, JSON.stringify(rejected.payload, null, 2));
    assert.equal(rejected.payload.status, "denied", JSON.stringify(rejected.payload, null, 2));
    assert.equal(rejected.payload.terminalOutcome, "denied", JSON.stringify(rejected.payload, null, 2));
    assert.equal(rejected.payload.pendingOperation?.status, "rejected", JSON.stringify(rejected.payload, null, 2));
    assert.equal(approvalFixtureHitCount(), beforeHits, "rejected operation must not reach the upstream MCP service");
    assert.equal(approvalFixtureService.fixture.state.purged, false);

    const duplicate = await resolvePendingOperation(pending.pendingOperationId, "approved");
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.payload, null, 2));
    assert.equal(duplicate.payload.error?.code, "pending_operation_replayed");
    assert.equal(approvalFixtureHitCount(), beforeHits, "resolving a rejected operation again must have no upstream side effect");

    return {
      rejected: true,
      upstreamHitDelta: approvalFixtureHitCount() - beforeHits,
      duplicateResolveRejected: true
    };
  });

  await test("expired upstream MCP approval has no upstream side effects", async () => {
    approvalFixtureService.fixture.reset();
    const beforeHits = approvalFixtureHitCount();
    const pending = await createApprovalPendingOperation();
    assert.equal(approvalFixtureHitCount(), beforeHits);

    const expiredAt = new Date(Date.now() - 1000).toISOString();
    const expiryUpdate = withOperationPermissionDatabase((database) => database.prepare(`
      UPDATE tool_pending_operations
      SET expires_at = ?
      WHERE pending_operation_id = ? AND status = 'pending'
    `).run(expiredAt, pending.pendingOperationId));
    assert.equal(expiryUpdate.changes, 1, "verifier must expire exactly one pending operation");

    const expired = await resolvePendingOperation(pending.pendingOperationId, "approved");
    assert.equal(expired.status, 409, JSON.stringify(expired.payload, null, 2));
    assert.equal(expired.payload.error?.code, "pending_operation_replayed");
    assert.equal(expired.payload.pendingOperation?.status, "expired", JSON.stringify(expired.payload, null, 2));
    assert.equal(approvalFixtureHitCount(), beforeHits, "expired approval must not reach the upstream MCP service");
    assert.equal(approvalFixtureService.fixture.state.purged, false);

    const duplicate = await resolvePendingOperation(pending.pendingOperationId, "denied");
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.payload, null, 2));
    assert.equal(approvalFixtureHitCount(), beforeHits, "re-resolving an expired operation must have no upstream side effect");

    return {
      expired: true,
      resolveRejected: true,
      duplicateResolveRejected: true,
      upstreamHitDelta: approvalFixtureHitCount() - beforeHits
    };
  });

  await test("upstream MCP approval lifecycle emits bound audit evidence", async () => {
    const gatewayAudit = await api(
      "GET",
      `/api/gateway/v1/audit?serviceId=${encodeURIComponent(APPROVAL_SERVICE_ID)}`
    );
    assert.equal(gatewayAudit.status, 200, JSON.stringify(gatewayAudit.payload, null, 2));
    const gatewayCompleted = (gatewayAudit.payload.items || []).filter((item) =>
      item.eventType === "upstream.mcp.call.completed" &&
      item.payload?.serviceId === APPROVAL_SERVICE_ID &&
      item.payload?.upstreamToolName === APPROVAL_UPSTREAM_TOOL_NAME
    );
    assert.equal(gatewayCompleted.length, 1, "approval lifecycle must emit exactly one completed upstream MCP audit event");
    assert.equal(gatewayCompleted[0].payload?.requestBody?.metadataOnly, true);

    const permissionAudit = await api(
      "GET",
      `/api/operation-permission/v1/audit?toolId=${encodeURIComponent(APPROVAL_PROJECTED_TOOL_ID)}&grantId=${encodeURIComponent(approvalGrantId)}&limit=100`
    );
    assert.equal(permissionAudit.status, 200, JSON.stringify(permissionAudit.payload, null, 2));
    const permissionItems = permissionAudit.payload.items || [];
    const pendingCount = permissionItems.filter((item) => item.status === "pending_approval").length;
    const completedCount = permissionItems.filter((item) => item.status === "ok").length;
    assert.equal(pendingCount, 3, "approval lifecycle must audit each suspended upstream MCP operation");
    assert.equal(completedCount, 1, "only the approved upstream MCP operation may complete");

    const storedEvidence = withOperationPermissionDatabase((database) => {
      const executionRows = database.prepare(`
        SELECT status, COUNT(*) AS count
        FROM tool_executions
        WHERE grant_id = ? AND tool_id = ?
        GROUP BY status
      `).all(approvalGrantId, APPROVAL_PROJECTED_TOOL_ID);
      const pendingRows = database.prepare(`
        SELECT status, COUNT(*) AS count
        FROM tool_pending_operations
        WHERE grant_id = ? AND tool_id = ?
        GROUP BY status
      `).all(approvalGrantId, APPROVAL_PROJECTED_TOOL_ID);
      const grantRow = database.prepare("SELECT metadata_json FROM tool_grants WHERE id = ?").get(approvalGrantId);
      return {
        executions: Object.fromEntries(executionRows.map((row) => [row.status, Number(row.count)])),
        pending: Object.fromEntries(pendingRows.map((row) => [row.status, Number(row.count)])),
        grantMetadata: JSON.parse(String(grantRow?.metadata_json || "{}"))
      };
    });
    assert.equal(storedEvidence.executions.pending_approval, 3);
    assert.equal(storedEvidence.executions.ok, 1);
    assert.equal(storedEvidence.pending.completed, 1);
    assert.equal(storedEvidence.pending.rejected, 1);
    assert.equal(storedEvidence.pending.expired, 1);
    assert.deepEqual(
      storedEvidence.grantMetadata.allowedSecretBindings,
      approvalCapability.credentialBindingIds,
      "the resumed audit grant must retain the configured credential binding"
    );

    const publicAuditText = JSON.stringify({ gateway: gatewayAudit.payload, permission: permissionAudit.payload });
    assert.equal(publicAuditText.includes(approvalFixtureToken), false, "audit response must not expose the upstream credential");
    assert.equal(publicAuditText.includes(APPROVAL_SECRET_REF), false, "audit response must not expose the upstream secret reference");

    return {
      gatewayCompletedCount: gatewayCompleted.length,
      operationPermissionPendingCount: pendingCount,
      operationPermissionCompletedCount: completedCount,
      boundGrantAuditVerified: true,
      rawCredentialRedacted: true
    };
  });

  await writeReport();
  console.log(`\n=== Upstream MCP Gateway E2E passed; report: ${REPORT_PATH} ===`);
} catch (error) {
  await writeReport().catch(() => {});
  console.error(JSON.stringify(safeEvidence({
    ok: false,
    verifier: "tools/server-scripts/verify-upstream-mcp-gateway-e2e.mjs",
    error: {
      name: error?.name || "Error",
      message: error?.message || String(error)
    }
  }), null, 2));
  exitCode = 1;
} finally {
  if (server?.close) {
    await server.close();
  }
  if (approvalFixture?.close) {
    await approvalFixture.close();
  }
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  restoreCapabilityKernelEnv();
}

process.exit(exitCode);
