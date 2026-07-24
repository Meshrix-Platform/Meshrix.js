import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { seedVerifierUpstreamServices, verifierOpaqueServiceId } from "./upstream-gateway-verifier-publication.mjs";
import {
  createProtocolConsistencyTokenHeaders,
  parseMcpSseBlock
} from "./operation-permission-protocol-consistency-helpers.mjs";
import {
  createVerifierMcpProcessIdentity
} from "../mcp-process-identity-test-helper.mjs";
import { issueVerifierLocalMcpGrant } from "./local-mcp-device-authorization.mjs";

export const OPERATION_PERMISSION_PROTOCOL_CONSISTENCY = Object.freeze({
  reportPath: "build/reports/operation-permission-protocol-consistency.json",
  mcpInterfaceVersion: "v0.0.1:mcp:interface-1",
  agentProfileId: "verify-operation-permission-protocol-agent",
  serviceIdPrefix: verifierOpaqueServiceId("verify-op-permission-protocol"),
  readTool: "meshrix.gateway.metrics",
  writeTool: "meshrix.gateway.forward",
  approvalTool: "meshrix.tagManagement.tags.upsert",
  forbiddenConfigMutationTool: "meshrix.gateway.externalServices.register",
  requiredTagOperations: Object.freeze([
    "tag_management.tags.list",
    "tag_management.tags.get",
    "tag_management.tags.upsert",
    "tag_management.tags.archive",
    "tag_management.tags.restore",
    "tag_management.projections.list",
    "tag_management.projections.rebuild",
    "tag_management.audit.list"
  ]),
  requiredAuthorizationGovernanceOperations: Object.freeze([
    "authorization.subject.resolve",
    "authorization.policy.evaluate",
    "authorization.governance.summary",
    "authorization.roles.list",
    "authorization.roles.upsert",
    "authorization.departments.list",
    "authorization.departments.upsert",
    "authorization.teams.list",
    "authorization.teams.upsert",
    "authorization.users.policies.list",
    "authorization.users.policy.upsert",
    "authorization.agent_groups.list",
    "authorization.agent_groups.upsert",
    "authorization.agents.bindings.list",
    "authorization.agents.binding.upsert",
    "authorization.approvals.list",
    "authorization.approvals.upsert",
    "authorization.approvals.revoke",
    "authorization.receipts.list",
    "authorization.loan_records.list",
    "authorization.denied_requests.list"
  ]),
  requiredOperationPermissionOperations: Object.freeze([
    "operation_permission.execute",
    "operation_permission.batch",
    "operation_permission.dry_run",
    "operation_permission.policy_evaluate",
    "operation_permission.policy_preview",
    "operation_permission.create_grant",
    "operation_permission.update_grant",
    "operation_permission.revoke_grant",
    "operation_permission.audit",
    "operation_permission.metrics_summary"
  ])
});

export async function createOperationPermissionProtocolConsistencyHarness() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-permission-protocol-"));
  const dynamicSecretNeedles = new Set([userDataPath, os.homedir()].filter(Boolean));
  const mcpIdentityByToken = new Map();
  const report = {
    schemaVersion: "v0.0.1:operation-permission:protocol-consistency-report-1",
    verifier: "tools/server-scripts/verify-operation-permission-protocol-consistency.mjs",
    startedAt: new Date().toISOString(),
    algorithm: {
      registration: "Compare the generated operation registry, protocol definitions, and generated capability artifact with the required tag_management.* and Operation Permission operation set.",
      parity: "Start a real local HTTP server and exercise the same Operation Permission runtime through HTTP, JSON-RPC console passthrough, and MCP tools/call.",
      discoveryRefresh: "Open a real MCP SSE stream, update a live grant and a live tag governance policy, then require notifications/tools/list_changed and refreshed meshrix.capabilities.list output.",
      destructiveChecks: "Insufficient grant, stale policy approval, revoked grant, per-grant rate limit, malformed authorization surface, and unauthorized discovery are checked without mocks or synthetic stores."
    },
    tests: [],
    destructiveTests: [],
    summary: {}
  };

  let server = null;
  let fixtureUrl = "";
  const tokenHeaders = createProtocolConsistencyTokenHeaders({
    identityByToken: mcpIdentityByToken,
    serverUrl: () => server.url,
    agentProfileId: OPERATION_PERMISSION_PROTOCOL_CONSISTENCY.agentProfileId
  });

  function trackSecret(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) {
        dynamicSecretNeedles.add(text);
      }
    }
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
    text = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    text = text.replace(/"token"\s*:\s*"[^"]+"/gi, "\"token\":\"[redacted]\"");
    text = text.replace(/meshrix_[A-Za-z0-9_-]{12,}/g, "meshrix_[redacted]");
    text = text.replace(/\b(?:grant|tool_exec|trace|pending_op|token_family)_[A-Za-z0-9_-]{8,}\b/g, "[redacted-id]");
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
      assert.equal(needle ? value.includes(needle) : false, false, `${label} leaked verifier data`);
    }
    assert.equal(/Bearer\s+(?!\[redacted\])\S+/i.test(value), false, `${label} leaked bearer token`);
    assert.equal(/"token"\s*:\s*"(?!\[redacted\])[^"]+"/i.test(value), false, `${label} leaked token field`);
    assert.equal(/meshrix_[A-Za-z0-9_-]{12,}/.test(value), false, `${label} leaked token-like value`);
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
    report.summary.reportLeakScan = true;
    assertNoLeak(report, "operation permission protocol consistency report");
    await fs.mkdir(path.dirname(OPERATION_PERMISSION_PROTOCOL_CONSISTENCY.reportPath), { recursive: true });
    await fs.writeFile(
      OPERATION_PERMISSION_PROTOCOL_CONSISTENCY.reportPath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
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

  async function writeUpstreamGatewayConfig(services = []) {
    await seedVerifierUpstreamServices({ userDataPath, services });
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

  async function fetchJson(routeOrUrl, options = {}) {
    const {
      allowSecretPayload = false,
      assertNoLeakPayload = false,
      expectedStatuses = null,
      ...fetchOptions
    } = options;
    const url = String(routeOrUrl).startsWith("http")
      ? routeOrUrl
      : `${server.url}${routeOrUrl}`;
    const response = await fetch(url, fetchOptions);
    const text = await response.text();
    const payload = text.trim() ? JSON.parse(text) : {};
    if (expectedStatuses) {
      const publicErrorCode = String(payload?.error?.code || "unknown_error").slice(0, 96);
      assert.equal(
        expectedStatuses.includes(response.status),
        true,
        `Unexpected status ${response.status} (${publicErrorCode}) for ${routeOrUrl}`
      );
    }
    if (!allowSecretPayload && assertNoLeakPayload) {
      assertNoLeak(payload, String(routeOrUrl));
    }
    return { status: response.status, ok: response.ok, payload };
  }

  async function api(method, route, body = undefined, options = {}) {
    return fetchJson(route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...options
    });
  }

  async function localMcpGrant(input = {}) {
    const verifierIdentity = createVerifierMcpProcessIdentity({
      target: "codex",
      label: "verify-operation-permission-protocol"
    });
    const response = await issueVerifierLocalMcpGrant({
      server,
      grantRequest: {
        targets: ["codex"],
        connectorVersion: "verify-operation-permission-protocol-consistency",
        agentProfileId: OPERATION_PERMISSION_PROTOCOL_CONSISTENCY.agentProfileId,
        processIdentity: verifierIdentity.request,
        ...input
      }
    });
    const token = String(response.payload.token || "");
    const grantId = String(response.payload.grant?.id || "");
    assert.ok(token, "local MCP grant did not return a token");
    assert.ok(grantId, "local MCP grant did not return a grant id");
    assert.ok(response.payload.processIdentity?.clientIdentityPackage, "local MCP grant did not return a process identity package");
    trackSecret(token, grantId, response.payload.grant?.tokenPrefix, response.payload.tokenPrefix);
    mcpIdentityByToken.set(token, {
      identity: verifierIdentity,
      clientIdentityPackage: response.payload.processIdentity.clientIdentityPackage
    });
    return { token, grantId, grant: response.payload.grant };
  }

  async function consoleGrant(input = {}) {
    const response = await fetchJson("/api/operation-permission/v1/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-meshrix-safety-confirm": "true" },
      body: JSON.stringify(input),
      allowSecretPayload: true,
      expectedStatuses: [201]
    });
    const token = String(response.payload.token || "");
    const grantId = String(response.payload.grant?.id || "");
    assert.ok(token, "grant create did not return a token");
    assert.ok(grantId, "grant create did not return a grant id");
    trackSecret(token, grantId, response.payload.grant?.tokenPrefix);
    return { token, grantId, grant: response.payload.grant };
  }

  async function operationHttp(token, toolId, input = {}, expectedStatuses = [200, 202, 400, 401, 403, 429]) {
    const body = JSON.stringify({ toolId, input });
    return fetchJson("/api/operation-permission/v1/execute", {
      method: "POST",
      headers: tokenHeaders(token, {
        method: "POST",
        route: "/api/operation-permission/v1/execute",
        body
      }),
      body,
      expectedStatuses
    });
  }

  async function operationRpc(token, toolId, input = {}, id = 1) {
    const targetBody = JSON.stringify({ toolId, input });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "operation_permission.execute",
      params: { toolId, input }
    });
    return fetchJson("/api/rpc", {
      method: "POST",
      headers: tokenHeaders(token, {
        method: "POST",
        route: "/api/operation-permission/v1/execute",
        body: targetBody
      }),
      body,
      expectedStatuses: [200]
    });
  }

  async function callMcp(
    token,
    toolName,
    operation,
    input = {},
    id = 1,
    expectedStatuses = [200, 202, 400, 401, 403, 429]
  ) {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: {
          apiVersion: OPERATION_PERMISSION_PROTOCOL_CONSISTENCY.mcpInterfaceVersion,
          operation,
          input,
          clientVersion: "verify-operation-permission-protocol-consistency"
        }
      }
    });
    const response = await fetchJson("/mcp", {
      method: "POST",
      headers: tokenHeaders(token, {
        method: "POST",
        route: "/mcp",
        body
      }),
      body,
      expectedStatuses
    });
    return response.payload;
  }

  function mcpPayload(jsonRpcPayload = {}) {
    return jsonRpcPayload?.result?.structuredContent?.payload ||
      jsonRpcPayload?.result?.structuredContent ||
      jsonRpcPayload?.result ||
      {};
  }

  function publicPayload(channel, value = {}) {
    if (channel === "http") {
      return value.payload || {};
    }
    if (channel === "rpc") {
      return value.payload?.error
        ? { error: value.payload.error }
        : value.payload?.result || {};
    }
    if (channel === "mcp") {
      return value.error ? { error: value.error } : mcpPayload(value);
    }
    return value || {};
  }

  function collectStrings(value, output = []) {
    if (value === null || value === undefined) {
      return output;
    }
    if (typeof value === "string") {
      output.push(value);
      return output;
    }
    if (typeof value !== "object") {
      return output;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collectStrings(item, output);
      }
      return output;
    }
    for (const entry of Object.values(value)) {
      collectStrings(entry, output);
    }
    return output;
  }

  function classifyDecision(payload = {}) {
    const text = collectStrings(payload).join(" ").toLowerCase();
    const status = String(payload.status || payload.resultStatus || "").toLowerCase();
    if (status === "ok" || (payload.ok === true && !payload.error)) {
      return "allow";
    }
    if (status === "pending_approval" || text.includes("pending_approval")) {
      return "approval_required";
    }
    if (text.includes("rate_limited") || text.includes("rate limited")) {
      return "rate_limited";
    }
    if (text.includes("grant_revoked") || text.includes("invalid_token") || text.includes("grant_disabled")) {
      return "revoked_grant";
    }
    if (payload.error || status === "denied" || text.includes("missing_scopes") || text.includes("missing_capabilities") || text.includes("policy_denied")) {
      return "deny";
    }
    return "unknown";
  }

  function hasStalePolicy(payload = {}) {
    return collectStrings(payload).some((entry) => entry === "stale" || entry.includes("grantPolicyState\":\"stale"));
  }

  async function callAllChannels({ token, toolId, mcpToolName, operation, input, idBase = 100 }) {
    const httpResult = await operationHttp(token, toolId, input);
    const rpcResult = await operationRpc(token, toolId, input, idBase + 1);
    const mcpResult = await callMcp(token, mcpToolName, operation, input, idBase + 2);
    const payloads = {
      http: publicPayload("http", httpResult),
      rpc: publicPayload("rpc", rpcResult),
      mcp: publicPayload("mcp", mcpResult)
    };
    return {
      payloads,
      decisions: Object.fromEntries(
        Object.entries(payloads).map(([channel, payload]) => [channel, classifyDecision(payload)])
      )
    };
  }

  function assertSameDecision(decisions = {}, expected) {
    assert.deepEqual(Object.values(decisions), [expected, expected, expected]);
  }

  async function capabilities(token, id = 1) {
    const payload = await callMcp(token, "meshrix.discovery", "meshrix.capabilities.list", {}, id);
    assert.equal(payload.error, undefined, JSON.stringify(safeEvidence(payload.error || {})));
    return mcpPayload(payload);
  }

  async function openMcpSse(token) {
    const controller = new AbortController();
    const events = [];
    let buffer = "";
    const route = "/mcp?capability=upstream.catalog.list_changed";
    const stream = fetch(`${server.url}${route}`, {
      method: "GET",
      headers: tokenHeaders(token, {
        method: "GET",
        route,
        body: "",
        extraHeaders: {
          "X-Meshrix-Mcp-Proxy-Session": "protocolconsistency01"
        }
      }),
      signal: controller.signal
    }).then(async (response) => {
      assert.equal(response.status, 200, "MCP SSE stream did not open");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseMcpSseBlock(block);
          if (parsed) {
            events.push(parsed);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    }).catch((error) => {
      if (error?.name !== "AbortError") {
        throw error;
      }
    });

    async function waitForReasonCode(reasonCode, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = events.find((event) =>
          event?.method === "notifications/tools/list_changed" &&
            String(event?.params?.change?.reasonCode || "") === reasonCode
        );
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for MCP list_changed reason ${reasonCode}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      events,
      waitForReasonCode,
      close: async () => {
        controller.abort();
        await stream;
      }
    };
  }

  async function cleanup({ fixture = null, restoreCapabilityKernelEnv = null } = {}) {
    if (server?.close) {
      await server.close();
    }
    await closeServer(fixture);
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
    if (typeof restoreCapabilityKernelEnv === "function") {
      restoreCapabilityKernelEnv();
    }
  }

  return {
    userDataPath,
    report,
    trackSecret,
    redactText,
    safeEvidence,
    writeReport,
    test,
    destructiveTest,
    writeUpstreamGatewayConfig,
    setFixtureUrl(url = "") {
      fixtureUrl = String(url || "");
      if (fixtureUrl) {
        trackSecret(fixtureUrl, new URL(fixtureUrl).host);
      }
    },
    setServer(target) {
      server = target;
      if (server?.url) {
        trackSecret(server.url, new URL(server.url).host);
      }
    },
    api,
    localMcpGrant,
    consoleGrant,
    operationHttp,
    operationRpc,
    callMcp,
    mcpPayload,
    publicPayload,
    classifyDecision,
    hasStalePolicy,
    callAllChannels,
    assertSameDecision,
    capabilities,
    openMcpSse,
    cleanup
  };
}
