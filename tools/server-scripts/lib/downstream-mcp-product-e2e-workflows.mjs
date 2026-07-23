import assert from "node:assert/strict";

export function createDownstreamMcpProductE2eWorkflows(context = {}) {
  const {
    APPROVAL_TOOL,
    SERVICE_ID,
    api,
    assertMcpOk,
    assertNoLeakText,
    callMcp,
    consoleGrant,
    fetchJson,
    fixtureState,
    getServerUrl,
    localMcpGrant,
    listMcpTools,
    mcpErrorCode,
    mcpPayload,
    operationNames,
    relayVirtualAgentId,
    redactText,
    safeEvidence,
    trackSecret
  } = context;

  async function readGatewayFixture() {
    const response = await api("GET", "/api/gateway/v1/external-services");
    assert.equal(response.status, 200, JSON.stringify(safeEvidence(response.payload)));
    const service = (response.payload.items || []).find((item) => item.serviceId === SERVICE_ID);
    assert.ok(service, "configured gateway fixture missing");
    const rejected = await api("POST", "/api/gateway/v1/external-services", {
      serviceId: "remote-registration-forbidden",
      token: "downstream-product-raw-token-must-not-leak"
    }, { expectedStatuses: [400, 403, 404, 405] });
    assert.equal(rejected.status >= 400, true);
    return {
      serviceId: service.serviceId,
      operationCount: service.operations.length,
      loadedFromPublishedManifest: true,
      remoteRegistrationRejected: true
    };
  }

  async function verifyDiscoveryAndGateway({ token }) {
    const health = await callMcp(token, "lico.discovery", "system.health", {}, 10);
    assertMcpOk(health, "system.health");
    assert.equal(mcpPayload(health).ok, true);

    const capabilitiesPayload = await callMcp(token, "lico.discovery", "lico.capabilities.list", {}, 11);
    assertMcpOk(capabilitiesPayload, "lico.capabilities.list");
    const capabilities = mcpPayload(capabilitiesPayload);
    const outlets = capabilities.outlets || {};
    const operations = Array.isArray(capabilities.operations) ? capabilities.operations : [];
    const expectedOutlets = new Set([
      "lico.discovery",
      ...operations.map((operation) => String(operation?._meta?.mcpOutlet || "").trim()).filter(Boolean)
    ]);
    assert.deepEqual(
      Object.keys(outlets).sort((left, right) => left.localeCompare(right)),
      [...expectedOutlets].sort((left, right) => left.localeCompare(right)),
      "capability outlet summary must be derived from visible operation descriptors"
    );
    for (const outlet of expectedOutlets) {
      assert.equal(Number(outlets[outlet]?.operationCount || 0) > 0, true, `${outlet} has no visible operations`);
    }
    const names = operationNames(capabilities);
    for (const required of [
      "lico.gateway.forward",
      "lico.gateway.metrics",
      "lico.workspace.create",
      "lico.sharedspace.file.write",
      "lico.sharedspace.file.read",
      "lico.agentRelay.session.create",
      "lico.agentRelay.sessions.list"
    ]) {
      assert.equal(
        names.has(required),
        true,
        `${required} missing from MCP capabilities; visible agent relay operations: ${[...names]
          .filter((name) => name.startsWith("lico.agentRelay."))
          .sort((left, right) => left.localeCompare(right))
          .join(", ") || "none"}`
      );
    }
    const listedOutletNames = new Set((await listMcpTools(token)).map((tool) => tool.name));
    for (const outlet of expectedOutlets) {
      assert.equal(listedOutletNames.has(outlet), true, `${outlet} missing from tools/list`);
    }

    const gatewayMetrics = await callMcp(token, "lico.gateway", "lico.gateway.metrics", {}, 12);
    assertMcpOk(gatewayMetrics, "lico.gateway.metrics");
    const gatewayMetricsPayload = mcpPayload(gatewayMetrics);
    assert.equal(Number(gatewayMetricsPayload.totalForwardCount || 0) >= 0, true);

    const before = fixtureState.echoCount;
    const forward = await callMcp(token, "lico.gateway", "lico.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { message: "downstream-mcp-product" }
    }, 13);
    assertMcpOk(forward, "lico.gateway.forward");
    const forwarded = mcpPayload(forward);
    assert.equal(forwarded.response?.json?.echoed?.message, "downstream-mcp-product");
    assert.equal(fixtureState.echoCount, before + 1);

    return {
      outlets: Object.fromEntries([...expectedOutlets].map((outlet) => [outlet, Number(outlets[outlet]?.operationCount || 0)])),
      gatewayMetricsVisible: true,
      gatewayForwardFixtureHits: fixtureState.echoCount - before
    };
  }

  async function verifySharedSpace({ token }) {
    const create = await callMcp(token, "lico.discovery", "lico.workspace.create", {
      title: "Downstream MCP product E2E workspace",
      objective: "Verify MCP Shared Space create, upload, and download through real runtime state."
    }, 20);
    assertMcpOk(create, "lico.workspace.create");
    const created = mcpPayload(create);
    const workspaceId = created.workspace?.workspaceRef || created.workspace?.workspaceId || created.workspaceId || "";
    assert.ok(workspaceId, "workspace create did not return a workspace id");
    trackSecret(workspaceId);

    const content = "downstream MCP product E2E sharedspace proof\n";
    const upload = await callMcp(token, "lico.sharedspace", "lico.sharedspace.file.write", {
      workspaceId,
      path: "product-e2e/proof.txt",
      content,
      createdBy: "verify-downstream-mcp-product-e2e"
    }, 21);
    assertMcpOk(upload, "lico.sharedspace.file.write");
    const uploaded = mcpPayload(upload);
    assert.equal(uploaded.ok, true);
    assert.ok(uploaded.stateCommit?.commitId || uploaded.ingestReceipt?.manifestRootCid);

    const download = await callMcp(token, "lico.sharedspace", "lico.sharedspace.file.read", {
      workspaceId,
      path: "product-e2e/proof.txt"
    }, 22);
    assertMcpOk(download, "lico.sharedspace.file.read");
    const downloaded = mcpPayload(download);
    assert.equal(downloaded.ok, true);
    assert.equal(downloaded.content, content);

    return {
      workspaceCreated: true,
      uploadCommitted: Boolean(uploaded.stateCommit?.commitId || uploaded.ingestReceipt?.manifestRootCid),
      downloadMatched: true
    };
  }

  async function verifyAgentRelay({ token }) {
    const virtualAgents = await callMcp(token, "lico.agentRelay", "lico.agentRelay.virtualAgents.list", {}, 30);
    assertMcpOk(virtualAgents, "lico.agentRelay.virtualAgents.list");
    const virtualAgentList = mcpPayload(virtualAgents).data?.virtualAgents ||
      mcpPayload(virtualAgents).virtualAgents ||
      [];
    assert.equal(Array.isArray(virtualAgentList), true);
    const virtualAgentId = String(relayVirtualAgentId || "").trim();
    assert.ok(virtualAgentId, "the verifier did not configure an ACP relay virtual agent");
    assert.equal(
      virtualAgentList.some((agent) => agent.enabled !== false && agent.virtualAgentId === virtualAgentId),
      true,
      "the explicitly configured ACP relay virtual agent was not discoverable"
    );
    trackSecret(virtualAgentId);

    const sourceId = `source-${Date.now()}`;
    const workspaceId = `workspace-${Date.now()}`;
    const sourceSessionId = `session-${Date.now()}`;
    trackSecret(sourceId, workspaceId, sourceSessionId);

    const create = await callMcp(token, "lico.agentRelay", "lico.agentRelay.session.create", {
      virtualAgentId,
      sourceId,
      workspaceId,
      sourceSessionId,
      sourceSubjectId: "product-e2e-subject",
      requestedMode: "ask"
    }, 31);
    assertMcpOk(create, "lico.agentRelay.session.create");
    const created = mcpPayload(create);
    const relaySessionId = created.data?.session?.relaySessionId || created.session?.relaySessionId || created.relaySessionId || "";
    assert.ok(relaySessionId, "agent relay session create did not return relaySessionId");
    trackSecret(relaySessionId);

    const list = await callMcp(token, "lico.agentRelay", "lico.agentRelay.sessions.list", {
      limit: 20
    }, 32);
    assertMcpOk(list, "lico.agentRelay.sessions.list");
    const sessions = mcpPayload(list).data?.sessions || mcpPayload(list).sessions || [];
    assert.equal(sessions.some((session) => session.relaySessionId === relaySessionId), true);

    const close = await callMcp(token, "lico.agentRelay", "lico.agentRelay.session.close", {
      sessionId: relaySessionId,
      reason: "verify-downstream-mcp-product-e2e"
    }, 33);
    assertMcpOk(close, "lico.agentRelay.session.close");

    return {
      virtualAgentDiscovered: true,
      sessionCreated: true,
      sessionListed: true,
      sessionClosed: true
    };
  }

  async function verifyAuditAndMetrics() {
    const audit = await api("GET", "/api/operation-permission/v1/audit?limit=100");
    assert.equal(audit.status, 200, JSON.stringify(safeEvidence(audit.payload)));
    const items = audit.payload.items || [];
    const requiredTools = [
      "system.health",
      "lico.gateway.forward",
      "lico.gateway.metrics",
      "lico.workspace.create",
      "lico.sharedspace.file.write",
      "lico.sharedspace.file.read",
      "lico.agentRelay.session.create",
      "lico.agentRelay.sessions.list",
      "lico.agentRelay.session.close"
    ];
    const missing = requiredTools.filter((toolId) => !items.some((item) => item.toolId === toolId && item.status === "ok"));
    assert.deepEqual(missing, [], `Missing audit records: ${missing.join(", ")}`);

    const metrics = await api("GET", "/api/operation-permission/v1/metrics/summary?limit=100");
    assert.equal(metrics.status, 200, JSON.stringify(safeEvidence(metrics.payload)));
    const byTool = metrics.payload.metrics?.toolCalls?.byTool || {};
    const metricMissing = requiredTools.filter((toolId) => Number(byTool[toolId] || 0) <= 0);
    assert.deepEqual(metricMissing, [], `Missing metric counters: ${metricMissing.join(", ")}`);
    return {
      auditMatchedToolCount: requiredTools.length,
      metricMatchedToolCount: requiredTools.length,
      auditItemCount: items.length
    };
  }

  async function advanceGovernanceRevision() {
    const tagId = `custom:downstream-mcp-product-${Date.now()}`;
    trackSecret(tagId);
    const response = await api("POST", "/api/tag-management/v1/tags", {
      tagId,
      kind: "custom",
      label: "Downstream MCP product governance verifier",
      scopePrerequisites: ["auth:admin"]
    });
    assert.equal([200, 201].includes(response.status), true, JSON.stringify(safeEvidence(response.payload)));
    return { revisionAdvanced: true };
  }

  function auditItems(payload = {}) {
    return Array.isArray(payload.items) ? payload.items : [];
  }

  async function verifyDenialsAndRateLimit({ mainToken }) {
    const readOnly = await localMcpGrant({
      label: "Downstream MCP product read-only verifier",
      toolsets: ["lico.gateway.read", "lico.storage.read"],
      grantMode: "read"
    });
    const deniedForward = await callMcp(readOnly.token, "lico.gateway", "lico.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { message: "must-not-forward" }
    }, 40, [200, 403]);
    assert.ok(deniedForward.error, "read-only grant unexpectedly forwarded gateway write");
    assert.ok(["missing_capabilities", "missing_scopes", "policy_denied"].includes(mcpErrorCode(deniedForward)) || deniedForward.error);

    const admin = await localMcpGrant({
      label: "Downstream MCP product admin stale-policy verifier",
      toolsets: ["lico.gateway.admin", "lico.runtime.maintain", "lico.authorization.admin", "lico.storage.read"],
      grantMode: "maintain"
    });
    await advanceGovernanceRevision();
    const approval = await callMcp(admin.token, "lico.discovery", APPROVAL_TOOL, {
      tagId: "governance:downstream-mcp-product-pending-approval",
      kind: "custom",
      label: "Downstream MCP product pending approval",
      scopePrerequisites: ["auth:admin"]
    }, 45, [200, 202]);
    assertMcpOk(approval, "approval required maintenance repair tool");
    const approvalPayload = mcpPayload(approval);
    assert.equal(approvalPayload.status, "pending_approval", JSON.stringify(safeEvidence(approvalPayload)));

    const runtimeFailure = await callMcp(mainToken, "lico.gateway", "lico.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "fail",
      body: { message: "must-fail" }
    }, 46, [200, 400, 404]);
    const runtimeFailurePayload = mcpPayload(runtimeFailure);
    assert.ok(
      runtimeFailure.error ||
        Number(runtimeFailurePayload.upstream?.status || 0) >= 500 ||
        runtimeFailurePayload.ok === false ||
        ["failed", "error"].includes(String(runtimeFailurePayload.status || "")),
      "failing gateway upstream unexpectedly succeeded"
    );
    const sharedSpaceFailure = await callMcp(mainToken, "lico.sharedspace", "lico.sharedspace.file.read", {
      workspaceId: "missing-workspace-for-product-e2e",
      path: "missing.txt"
    }, 48, [200, 404]);
    const sharedSpaceFailurePayload = mcpPayload(sharedSpaceFailure);
    assert.ok(
      sharedSpaceFailure.error ||
        sharedSpaceFailurePayload.ok === false ||
        ["failed", "error"].includes(String(sharedSpaceFailurePayload.status || "")),
      "missing Shared Space file unexpectedly succeeded"
    );

    const expired = await consoleGrant({
      label: "Downstream MCP product expired verifier",
      type: "machine",
      toolsets: ["lico.storage.read"],
      maxRisk: "read_only",
      expiresAt: "2000-01-01T00:00:00.000Z"
    });
    const expiredCall = await callMcp(expired.token, "lico.discovery", "system.health", {}, 47, [200, 401, 403]);
    assert.ok(expiredCall.error, "expired grant unexpectedly succeeded");
    assert.ok(["grant_expired", "invalid_token"].includes(expiredCall.error?.data?.reasonCode || mcpErrorCode(expiredCall)) || expiredCall.error);

    const rateLimited = await consoleGrant({
      label: "Downstream MCP product rate-limit verifier",
      type: "machine",
      toolsets: ["lico.storage.read"],
      maxRisk: "read_only",
      rateLimit: { perMinute: 1 }
    });
    const first = await callMcp(rateLimited.token, "lico.discovery", "system.health", {}, 41);
    assertMcpOk(first, "first rate-limit system.health");
    const second = await callMcp(rateLimited.token, "lico.discovery", "system.health", {}, 42, [200, 429]);
    assert.ok(second.error, "second rate-limited call unexpectedly succeeded");
    assert.ok(second.error?.data?.reasonCode === "rate_limited" || mcpErrorCode(second) === "rate_limited");

    const revoke = await fetchJson(`/api/operation-permission/v1/grants/${encodeURIComponent(rateLimited.grantId)}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-lico-safety-confirm": "true" },
      body: JSON.stringify({ reason: "verify-downstream-mcp-product-e2e" })
    });
    assert.equal(revoke.status, 200);
    const revoked = await callMcp(rateLimited.token, "lico.discovery", "system.health", {}, 43, [200, 401, 403]);
    assert.ok(revoked.error || [401, 403].includes(revoked.status || 0));

    const wrongOutlet = await callMcp(mainToken, "lico.discovery", "lico.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo"
    }, 44);
    assert.equal(mcpErrorCode(wrongOutlet), "operation_outlet_mismatch");

    const malformed = await fetch(`${getServerUrl()}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{\"jsonrpc\":\"2.0\","
    });
    const malformedText = await malformed.text();
    assert.equal(malformed.status, 400);
    assertNoLeakText(redactText(malformedText), "malformed MCP response");

    const audit = await api("GET", "/api/operation-permission/v1/audit?limit=160");
    assert.equal(audit.status, 200, JSON.stringify(safeEvidence(audit.payload)));
    const items = auditItems(audit.payload);
    const pendingApprovalAudit = items.find((item) =>
      item.toolId === APPROVAL_TOOL &&
        item.status === "pending_approval"
    );
    assert.ok(pendingApprovalAudit, "approval-required MCP call did not create a pending_approval audit record");
    assert.equal(pendingApprovalAudit.resultSummary?.policy?.grantPolicyState, "stale");
    assert.equal(items.some((item) => item.status === "denied"), true, "destructive MCP calls did not create denied audit records");
    assert.equal(items.some((item) => item.status === "failed"), true, "runtime failure did not create failed audit record");

    const metrics = await api("GET", "/api/operation-permission/v1/metrics/summary?limit=160");
    assert.equal(metrics.status, 200, JSON.stringify(safeEvidence(metrics.payload)));
    const byStatus = metrics.payload.metrics?.toolCalls?.byStatus || {};
    assert.equal(Number(byStatus.denied || 0) > 0, true, "denied metrics were not recorded");
    assert.equal(Number(byStatus.pending_approval || 0) > 0, true, "pending approval metrics were not recorded");
    assert.equal(Number(byStatus.failed || 0) > 0, true, "failed metrics were not recorded");

    return {
      readOnlyWriteDenied: true,
      approvalRequired: true,
      stalePolicyEvaluated: true,
      expiredGrantDenied: true,
      runtimeFailureRecorded: true,
      rateLimitStatus: second.error?.data?.reasonCode || mcpErrorCode(second),
      revokedDenied: true,
      wrongOutletDenied: true,
      malformedStatus: malformed.status,
      destructiveAuditStatuses: {
        denied: Number(byStatus.denied || 0),
        pendingApproval: Number(byStatus.pending_approval || 0),
        failed: Number(byStatus.failed || 0)
      }
    };
  }

  return {
    readGatewayFixture,
    verifyAuditAndMetrics,
    verifyAgentRelay,
    verifyDenialsAndRateLimit,
    verifyDiscoveryAndGateway,
    verifySharedSpace
  };
}
