import assert from "node:assert/strict";
import { createSignedMcpHeaders } from "../mcp-process-identity-test-helper.mjs";
import {
  normalizePath,
  safeTargetUrl
} from "../../../packages/agents/src/upstream-gateway/support.mjs";

export function createRawMcpCaller({
  getServer,
  mcpIdentityByToken,
  fetchJson
}) {
  return async function callMcpRaw(token, message, id = 1, expectedStatuses = [200]) {
    const server = getServer();
    const binding = mcpIdentityByToken.get(token);
    assert.ok(binding, "MCP token must have a verifier process identity binding");
    const body = JSON.stringify({ jsonrpc: "2.0", id, ...message });
    const response = await fetchJson(`${server.url}/mcp`, {
      method: "POST",
      headers: createSignedMcpHeaders({
        token,
        body,
        nonce: `verify-upstream-gateway-raw-${id}`,
        url: new URL("/mcp", server.url),
        privateKeyPem: binding.identity.keyPair.privateKeyPem,
        clientIdentityPackage: binding.clientIdentityPackage
      }),
      body
    });
    assert.equal(
      expectedStatuses.includes(response.status),
      true,
      `Unexpected MCP HTTP status ${response.status}: ${JSON.stringify(response.payload, null, 2)}`
    );
    return response.payload;
  };
}

export async function runProjectedToolWorkflows({
  test,
  destructiveTest,
  createGrant,
  callMcpRaw,
  api,
  fixtureState,
  assertNoLeak,
  serviceId
}) {
  await destructiveTest("upstream operations stay hidden and uncallable without an exact dynamic capability", async () => {
    const token = await createGrant("verify-upstream-operation-tool-denied", ["lico.gateway.read", "lico.gateway.write"], {
      dynamicCapabilities: [],
      allowedServiceIds: [serviceId]
    });
    const directToolName = `upstream.${serviceId}.echo`;
    const beforeFixtureHits = fixtureState.echoCount;
    const listed = await callMcpRaw(token, { method: "tools/list", params: {} }, 1011);
    assert.equal((listed.result?.tools || []).some((tool) => tool.name === directToolName), false);
    const called = await callMcpRaw(token, {
      method: "tools/call",
      params: { name: directToolName, arguments: { message: "must-not-forward" } }
    }, 1012, [403]);
    assert.ok(called.error, "ungranted dynamic upstream tool call must fail");
    assert.equal(fixtureState.echoCount, beforeFixtureHits, "ungranted dynamic upstream tool reached the fixture");
    return { hidden: true, denied: true, upstreamNotHit: true };
  });

  await test("configured upstream operations are projected as MCP tools and execute through Operation Permission", async () => {
    const token = await createGrant("verify-upstream-operation-tool", ["lico.gateway.read", "lico.gateway.write"]);
    const directToolName = `upstream.${serviceId}.echo`;
    const listed = await callMcpRaw(token, { method: "tools/list", params: {} }, 1013);
    const tools = listed.result?.tools || [];
    const directTool = tools.find((tool) => tool.name === directToolName);
    assert.ok(directTool, `${directToolName} missing from downstream tools/list`);
    assert.equal(directTool._meta?.upstreamConfiguredOperation, true);
    assert.equal(directTool._meta?.toolId, directToolName);
    assert.equal(directTool._meta?.serviceId, serviceId);
    assert.equal(directTool._meta?.operationKey, "echo");
    assert.equal(directTool._meta?.capabilityId, `cap:upstream:${serviceId}:echo`);
    assert.equal(directTool._meta?.dynamicCapability?.capabilityId, directTool._meta.capabilityId);
    assert.deepEqual(directTool._meta?.requiredCapabilities, [directTool._meta.capabilityId]);

    const beforeAudit = await api("GET", "/api/operation-permission/v1/audit?limit=50");
    const beforeAuditCount = (beforeAudit.payload.items || [])
      .filter((item) => item.toolId === directToolName)
      .length;
    const beforeFixtureHits = fixtureState.echoCount;
    const called = await callMcpRaw(token, {
      method: "tools/call",
      params: {
        name: directToolName,
        arguments: { message: "projected-upstream-tool" }
      }
    }, 1014);
    assert.equal(called.error, undefined, JSON.stringify(called.error || {}, null, 2));
    const structured = called.result?.structuredContent || {};
    assert.equal(structured.operation, directToolName);
    assert.equal(structured.capabilityId, directTool._meta.capabilityId);
    assert.equal(structured.dynamicCapability?.capabilityId, directTool._meta.capabilityId);
    assert.equal(structured.upstreamConfiguredOperation, true);
    assert.equal(structured.payload?.response?.json?.echoed?.message, "projected-upstream-tool");
    assert.equal(fixtureState.echoCount, beforeFixtureHits + 1);

    const afterAudit = await api("GET", "/api/operation-permission/v1/audit?limit=50");
    const afterAuditCount = (afterAudit.payload.items || [])
      .filter((item) => item.toolId === directToolName)
      .length;
    assert.equal(afterAuditCount > beforeAuditCount, true, "projected upstream tool did not execute through Operation Permission");
    assertNoLeak(called, "projected upstream tool response");
    assertNoLeak(afterAudit.payload, "projected upstream tool audit");
    return {
      toolName: directToolName,
      operation: structured.operation,
      fixtureHits: fixtureState.echoCount - beforeFixtureHits,
      projectedToolAuditDelta: afterAuditCount - beforeAuditCount
    };
  });

  await destructiveTest("approval-required projected upstream tools create operation permission pending operations", async () => {
    const token = await createGrant("verify-upstream-operation-tool-approval", ["lico.gateway.read", "lico.gateway.write", "lico.gateway.maintain"], {
      scopes: ["gateway:read", "gateway:write", "gateway:maintain"],
      maxRisk: "repair_write"
    });
    const approvalToolName = `upstream.${serviceId}.approval`;
    const listed = await callMcpRaw(token, { method: "tools/list", params: {} }, 1016);
    const listedNames = (listed.result?.tools || []).map((tool) => tool.name);
    assert.equal(
      listedNames.includes(approvalToolName),
      true,
      `approval projected tool missing; visible=${listedNames.filter((name) => name.startsWith("upstream.")).join(",")}`
    );
    const before = fixtureState.approvalCount;
    const pending = await callMcpRaw(token, {
      method: "tools/call",
      params: {
        name: approvalToolName,
        arguments: { message: "approval-required-projected-tool" }
      }
    }, 1015);
    assert.equal(pending.error, undefined, JSON.stringify(pending.error || {}, null, 2));
    const structured = pending.result?.structuredContent || {};
    assert.equal(structured.operation, approvalToolName);
    assert.equal(structured.capabilityId, `cap:upstream:${serviceId}:approval`);
    assert.equal(structured.payload?.status, "pending_approval");
    assert.ok(structured.payload?.pendingOperation?.pendingOperationId, "projected upstream tool did not create an Operation Permission pending operation");
    assert.equal(structured.payload.pendingOperation.toolId, approvalToolName);
    assert.deepEqual(
      structured.payload.pendingOperation.approvalLayers,
      ["user"],
      "upstream projection must preserve the configured executable approval layer"
    );
    assert.deepEqual(structured.payload.pendingOperation.requiredApproval?.approvalLayers || [], ["user"]);
    assert.equal(fixtureState.approvalCount, before);
    assertNoLeak(pending, "projected upstream approval response");
    return {
      operation: structured.operation,
      pendingStatus: structured.payload?.status,
      toolId: structured.payload?.pendingOperation?.toolId,
      upstreamNotHit: fixtureState.approvalCount === before
    };
  });
}

export async function runUrlAuthorityEscapeWorkflow({ test }) {
  await test("upstream URL authority escape inputs are rejected before forwarding", async () => {
    const rejectedConfigPaths = [
      "//escape.invalid/path",
      "\\\\escape.invalid/path",
      "/\\escape.invalid/path",
      "https://escape.invalid/path"
    ];
    for (const candidate of rejectedConfigPaths) {
      assert.throws(
        () => normalizePath(candidate, "/"),
        /Upstream route path is invalid\./u,
        `${candidate} must be rejected during route normalization`
      );
    }
    for (const candidate of ["//escape.invalid/path", "/\\escape.invalid/path"]) {
      assert.throws(
        () => safeTargetUrl(
          { baseUrl: "https://service.example:8443" },
          { path: candidate },
          {}
        ),
        /Upstream configured target origin is outside configured service origin\./u,
        `${candidate} must not be allowed to escape the configured origin`
      );
    }
    const allowed = safeTargetUrl(
      { baseUrl: "https://service.example:8443" },
      { path: "/echo" },
      { query: { ok: "1" } }
    );
    assert.equal(allowed.origin, "https://service.example:8443");
    assert.equal(allowed.pathname, "/echo");
    return {
      rejectedConfigPathCount: rejectedConfigPaths.length,
      finalOriginPinned: true
    };
  });
}

export async function runAggregateTrafficPolicyWorkflow({
  destructiveTest,
  api,
  aggregateLimitedServiceId,
  assertNoLeak
}) {
  await destructiveTest("endpoint pools share the service-level aggregate traffic policy", async () => {
    const preview = await api("POST", "/api/gateway/v1/policy/preview", {
      serviceId: aggregateLimitedServiceId,
      operationKey: "aggregate-limited"
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.traffic.burst, 1);
    assert.equal(preview.payload.traffic.maxConcurrent, 10);
    assert.equal(preview.payload.traffic.serviceLimit?.burst, 1);
    assert.equal(preview.payload.traffic.endpoint?.trafficPolicySource, "service");

    const [first, rejected] = await Promise.all([
      api("POST", "/api/gateway/v1/forward", {
        serviceId: aggregateLimitedServiceId,
        operationKey: "aggregate-limited",
        query: { i: "first", waitMs: "120" }
      }),
      api("POST", "/api/gateway/v1/forward", {
        serviceId: aggregateLimitedServiceId,
        operationKey: "aggregate-limited",
        query: { i: "second", waitMs: "120" }
      })
    ].map((request) => request.catch((error) => ({ status: 0, payload: { error: error?.code || "request_failed" } }))));
    const statuses = [first.status, rejected.status].sort((left, right) => left - right);
    assert.deepEqual(statuses, [200, 429], JSON.stringify({ first: first.payload, rejected: rejected.payload }, null, 2));
    const rejectedResponse = [first, rejected].find((item) => item.status === 429);
    assert.equal(rejectedResponse?.payload?.details?.traffic?.deniedReason, "token_bucket_empty");
    assert.equal(rejectedResponse?.payload?.details?.traffic?.deniedScope, "service");
    assertNoLeak(rejectedResponse?.payload || {}, "aggregate endpoint pool rejection response");
    return {
      statuses,
      deniedReason: rejectedResponse?.payload?.details?.traffic?.deniedReason,
      deniedScope: rejectedResponse?.payload?.details?.traffic?.deniedScope,
      endpointPolicySource: preview.payload.traffic.endpoint?.trafficPolicySource
    };
  });
}

export async function runEndpointPoolWorkflow({
  test,
  api,
  loadBalancedServiceId,
  failingFixtureState,
  assertNoLeak
}) {
  await test("endpoint pool opens circuit on failing upstream and shifts to healthy endpoint", async () => {
    const first = await api("POST", "/api/gateway/v1/forward", {
      serviceId: loadBalancedServiceId,
      operationKey: "pooled-echo",
      body: { message: "first-fails" }
    });
    assert.equal(first.status, 200, JSON.stringify(first.payload, null, 2));
    assert.equal(first.payload.ok, false);
    assert.equal(first.payload.upstream.status, 503);
    assert.equal(first.payload.upstream.endpoint.endpointId, "failing");
    assert.equal(failingFixtureState.failureCount, 1);

    const second = await api("POST", "/api/gateway/v1/forward", {
      serviceId: loadBalancedServiceId,
      operationKey: "pooled-echo",
      body: { message: "second-healthy" }
    });
    assert.equal(second.status, 200, JSON.stringify(second.payload, null, 2));
    assert.equal(second.payload.ok, true);
    assert.equal(second.payload.upstream.status, 200);
    assert.equal(second.payload.upstream.endpoint.endpointId, "healthy");
    assert.equal(second.payload.response.json.echoed.message, "second-healthy");

    const preview = await api("POST", "/api/gateway/v1/policy/preview", {
      serviceId: loadBalancedServiceId,
      operationKey: "pooled-echo"
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.payload.traffic.routingAlgorithm, "weighted_endpoint_round_robin_with_circuit_breaker");
    assert.equal(preview.payload.traffic.endpoint.endpointId, "healthy");
    assert.equal(preview.payload.traffic.endpoint.circuitBreakerSource, "service");

    const audit = await api("GET", `/api/gateway/v1/audit?serviceId=${encodeURIComponent(loadBalancedServiceId)}`);
    assert.equal(audit.status, 200);
    const endpointIds = audit.payload.items
      .filter((item) => item.eventType === "upstream.forward.completed")
      .map((item) => item.payload?.endpoint?.endpointId)
      .filter(Boolean);
    assert.equal(endpointIds.includes("failing"), true);
    assert.equal(endpointIds.includes("healthy"), true);
    assertNoLeak(audit.payload, "endpoint pool audit");
    return {
      firstEndpoint: first.payload.upstream.endpoint.endpointId,
      secondEndpoint: second.payload.upstream.endpoint.endpointId,
      circuitOpen: preview.payload.traffic.circuit.open,
      circuitBreakerSource: preview.payload.traffic.endpoint.circuitBreakerSource,
      routingAlgorithm: preview.payload.traffic.routingAlgorithm
    };
  });
}
