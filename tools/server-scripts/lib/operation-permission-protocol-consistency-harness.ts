import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { seedVerifierUpstreamServices, verifierOpaqueServiceId } from "./upstream-gateway-verifier-publication.ts";
import { createProtocolConsistencyTokenHeaders } from "./operation-permission-protocol-consistency-helpers.ts";
import { issueVerifierMcpApiKey } from "./verifier-mcp-api-key.ts";

export const OPERATION_PERMISSION_PROTOCOL_CONSISTENCY: Readonly<Record<string, any>> = Object.freeze({
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

export async function createOperationPermissionProtocolConsistencyHarness() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-permission-protocol-"));
  const dynamicSecretNeedles: any = new Set<any>([userDataPath, os.homedir()].filter(Boolean));
  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:operation-permission:protocol-consistency-report-1",
    verifier: "tools/server-scripts/verify-operation-permission-protocol-consistency.ts",
    startedAt: new Date().toISOString(),
    algorithm: {
      registration: "Compare the generated operation registry, protocol definitions, and generated capability artifact with the required tag_management.* and Operation Permission operation set.",
      parity: "Start a real local HTTP server and exercise the same Operation Permission runtime through HTTP, JSON-RPC console passthrough, and MCP tools/call.",
      discoveryRefresh: "Keep a real scoped API Key policy immutable while refreshing meshrix.capabilities.list after an unrelated tag governance update.",
      destructiveChecks: "Insufficient credential scope, stale Operation Permission Grant approval, governed API Key approval, revocation, rate limiting, malformed authorization, and unauthorized discovery are checked without mocks or synthetic stores."
    },
    tests: [],
    destructiveTests: [],
    summary: {}
  };

  let server: any = null;
  let fixtureUrl: any = "";
  const tokenHeaders: any = createProtocolConsistencyTokenHeaders({
    agentProfileId: OPERATION_PERMISSION_PROTOCOL_CONSISTENCY.agentProfileId
  });

  function trackSecret(...values: any[]) : any {
    for (const value of values) {
      const text: any = String(value || "").trim();
      if (text) {
        dynamicSecretNeedles.add(text);
      }
    }
  }

  function redactText(value: any = "") : any {
    let text: any = String(value || "");
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

  function safeEvidence(value: Record<string, any> = {}) : any {
    return JSON.parse(JSON.stringify(value, (_?: any, child?: any) : any => {
      if (typeof child !== "string") {
        return child;
      }
      return redactText(child);
    }));
  }

  function assertNoLeakText(text: any = "", label: any = "text") : any {
    const value: any = String(text || "");
    for (const needle of dynamicSecretNeedles) {
      assert.equal(needle ? value.includes(needle) : false, false, `${label} leaked verifier data`);
    }
    assert.equal(/Bearer\s+(?!\[redacted\])\S+/i.test(value), false, `${label} leaked bearer token`);
    assert.equal(/"token"\s*:\s*"(?!\[redacted\])[^"]+"/i.test(value), false, `${label} leaked token field`);
    assert.equal(/meshrix_[A-Za-z0-9_-]{12,}/.test(value), false, `${label} leaked token-like value`);
  }

  function assertNoLeak(value?: any, label: any = "payload") : any {
    assertNoLeakText(JSON.stringify(value), label);
  }

  async function writeReport() : Promise<any> {
    report.finishedAt = new Date().toISOString();
    report.summary.testCount = report.tests.length;
    report.summary.destructiveTestCount = report.destructiveTests.length;
    report.summary.failedCount = [...report.tests, ...report.destructiveTests].filter((item?: any) : any => item.status !== "passed").length;
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

  function record(collection?: any, name?: any, status?: any, evidence: Record<string, any> = {}) : any {
    collection.push({ name, status, evidence: safeEvidence(evidence) });
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
      record(report.tests, name, "passed", evidence);
      console.log("ok");
    } catch (error: any) {
      record(report.tests, name, "failed", failureEvidence(error));
      console.log("FAIL");
      throw error;
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
      throw error;
    }
  }

  async function writeUpstreamGatewayConfig(services: any = []) : Promise<any> {
    await seedVerifierUpstreamServices({ userDataPath, services });
  }

  function closeServer(target?: any) : any {
    return new Promise((resolve?: any) : any => {
      if (!target?.close) {
        resolve();
        return;
      }
      target.close(() : any => resolve());
    });
  }

  async function fetchJson(routeOrUrl?: any, options: Record<string, any> = {}) : Promise<any> {
    const {
      allowSecretPayload = false,
      assertNoLeakPayload = false,
      expectedStatuses = null,
      ...fetchOptions
    } = options;
    const url: any = String(routeOrUrl).startsWith("http")
      ? routeOrUrl
      : `${server.url}${routeOrUrl}`;
    const response: any = await fetch(url, fetchOptions);
    const text: any = await response.text();
    const payload: any = text.trim() ? JSON.parse(text) : {};
    if (expectedStatuses) {
      const publicErrorCode: any = String(payload?.error?.code || "unknown_error").slice(0, 96);
      const publicErrorDetail: any = String(
        payload?.error?.message || (typeof payload?.error === "string" ? payload.error : "")
      ).slice(0, 180);
      assert.equal(
        expectedStatuses.includes(response.status),
        true,
        `Unexpected status ${response.status} (${publicErrorCode}) for ${routeOrUrl}${publicErrorDetail ? `: ${publicErrorDetail}` : ""}`
      );
    }
    if (!allowSecretPayload && assertNoLeakPayload) {
      assertNoLeak(payload, String(routeOrUrl));
    }
    return { status: response.status, ok: response.ok, payload };
  }

  async function api(method?: any, route?: any, body: any = undefined, options: Record<string, any> = {}) : Promise<any> {
    return fetchJson(route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...options
    });
  }

  async function verifierApiKey(input: Record<string, any> = {}) : Promise<any> {
    const response: any = await issueVerifierMcpApiKey({
      server,
      access: {
        targets: ["codex"],
        label: "Operation Permission protocol verifier",
        connectorVersion: "verify-operation-permission-protocol-consistency",
        agentProfileId: OPERATION_PERMISSION_PROTOCOL_CONSISTENCY.agentProfileId,
        ...input
      }
    });
    assert.ok(response.apiKey, "API Key issuance did not return plaintext to the direct verifier caller");
    assert.ok(response.record.keyId, "API Key issuance did not return a bounded record identifier");
    trackSecret(response.apiKey, response.record.keyId);
    return { token: response.apiKey, keyId: response.record.keyId, record: response.record };
  }

  async function issueConsoleOperationGrant(input: Record<string, any> = {}) : Promise<any> {
    const response: any = await fetchJson("/api/operation-permission/v1/grants", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-meshrix-safety-confirm": "true"
      },
      body: JSON.stringify(input),
      allowSecretPayload: true,
      expectedStatuses: [201]
    });
    const token: any = String(response.payload.token || "");
    const grantId: any = String(response.payload.grant?.id || "");
    assert.ok(token, "Operation Permission Grant creation did not return a token");
    assert.ok(grantId, "Operation Permission Grant creation did not return a Grant identifier");
    trackSecret(token, grantId, response.payload.grant?.tokenPrefix);
    return { token, grantId, grant: response.payload.grant };
  }

  async function operationHttp(token?: any, toolId?: any, input: Record<string, any> = {}, expectedStatuses: any = [200, 202, 400, 401, 403, 429]) : Promise<any> {
    const body: any = JSON.stringify({ toolId, input });
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

  async function operationRpc(token?: any, toolId?: any, input: Record<string, any> = {}, id: any = 1) : Promise<any> {
    const targetBody: any = JSON.stringify({ toolId, input });
    const body: any = JSON.stringify({
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
    token?: any,
    toolName?: any,
    operation?: any,
    input: Record<string, any> = {},
    id: any = 1,
    expectedStatuses: any = [200, 202, 400, 401, 403, 410, 429]
  ) : Promise<any> {
    const body: any = JSON.stringify({
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
    const response: any = await fetchJson("/mcp", {
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

  function mcpPayload(jsonRpcPayload: Record<string, any> = {}) : any {
    return jsonRpcPayload?.result?.structuredContent?.payload ||
      jsonRpcPayload?.result?.structuredContent ||
      jsonRpcPayload?.result ||
      {};
  }

  function publicPayload(channel?: any, value: Record<string, any> = {}) : any {
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

  function collectStrings(value?: any, output: any = []) : any {
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
    for (const entry of (Object.values(value) as any[])) {
      collectStrings(entry, output);
    }
    return output;
  }

  function classifyDecision(payload: Record<string, any> = {}) : any {
    const text: any = collectStrings(payload).join(" ").toLowerCase();
    const status: any = String(payload.status || payload.resultStatus || "").toLowerCase();
    if (status === "ok" || (payload.ok === true && !payload.error)) {
      return "allow";
    }
    if (status === "pending_approval" || text.includes("pending_approval")) {
      return "approval_required";
    }
    if (text.includes("rate_limited") || text.includes("rate limited")) {
      return "rate_limited";
    }
    if (text.includes("api_key_inactive") || text.includes("grant_revoked") || text.includes("invalid_token") || text.includes("grant_disabled")) {
      return "revoked_credential";
    }
    if (payload.error || status === "denied" || text.includes("missing_scopes") || text.includes("missing_capabilities") || text.includes("policy_denied")) {
      return "deny";
    }
    return "unknown";
  }

  function hasStalePolicy(payload: Record<string, any> = {}) : any {
    return collectStrings(payload).some((entry?: any) : any => entry === "stale" || entry.includes("grantPolicyState\":\"stale"));
  }

  async function callAllChannels({ token, mcpToken = token, toolId, mcpToolName, operation, input, idBase = 100 }: Record<string, any>) : Promise<any> {
    const httpResult: any = await operationHttp(token, toolId, input);
    const rpcResult: any = await operationRpc(token, toolId, input, idBase + 1);
    const mcpResult: any = await callMcp(mcpToken, mcpToolName, operation, input, idBase + 2);
    const payloads: Record<string, any> = {
      http: publicPayload("http", httpResult),
      rpc: publicPayload("rpc", rpcResult),
      mcp: publicPayload("mcp", mcpResult)
    };
    return {
      payloads,
      decisions: Object.fromEntries(
        (Object.entries(payloads) as [string, any][]).map(([channel, payload]: any[]) : any => [channel, classifyDecision(payload)])
      )
    };
  }

  function assertSameDecision(decisions: Record<string, any> = {}, expected?: any) : any {
    assert.deepEqual((Object.values(decisions) as any[]), [expected, expected, expected]);
  }

  async function capabilities(token?: any, id: any = 1) : Promise<any> {
    const payload: any = await callMcp(token, "meshrix.discovery", "meshrix.capabilities.list", {}, id);
    assert.equal(payload.error, undefined, JSON.stringify(safeEvidence(payload.error || {})));
    return mcpPayload(payload);
  }

  async function cleanup({ fixture = null, restoreCapabilityKernelEnv = null }: Record<string, any> = {}) : Promise<any> {
    if (server?.close) {
      await server.close();
    }
    await closeServer(fixture);
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
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
    setFixtureUrl(url: any = "") : any {
      fixtureUrl = String(url || "");
      if (fixtureUrl) {
        trackSecret(fixtureUrl, new URL(fixtureUrl).host);
      }
    },
    setServer(target?: any) : any {
      server = target;
      if (server?.url) {
        trackSecret(server.url, new URL(server.url).host);
      }
    },
    api,
    verifierApiKey,
    issueConsoleOperationGrant,
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
    cleanup
  };
}
