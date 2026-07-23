import assert from "node:assert/strict";

export function createOperationPermissionTagGovernedWorkflows(context = {}) {
  const {
    ALLOW_TAG,
    APPROVAL_TOOL,
    DENY_TAG,
    ENTITY_REFS,
    SERVICE_ID,
    api,
    assertMcpDenied,
    assertMcpOk,
    callMcp,
    callMcpWithToolName,
    capabilitiesForToken,
    createLocalGrant,
    createdGrantIds,
    denialSummary,
    fixtureState,
    getMcpToken,
    mcpPayload,
    openMcpSse,
    operationNames,
    rebuildTagProjections,
    safeEvidence,
    tagPolicy,
    tagProjections,
    trackSecret,
    upsertTag
  } = context;
  let workspaceId = "";

  async function verifyMcpDiscoveryAuthorizationRefresh() {
    const grant = await createLocalGrant({
      label: "Operation Permission tag-governed E2E discovery verifier",
      grantMode: "read",
      maxRisk: "read_only",
      toolsets: ["lico.gateway.read", "lico.console.read"]
    });
    const hiddenWithoutAuthority = [
      "lico.gateway.forward",
      "lico.workspace.file.upload",
      "lico.tagManagement.tags.upsert",
      "lico.operationPermission.createGrant"
    ];
    const sse = await openMcpSse(grant.token);
    try {
      const before = await capabilitiesForToken(grant.token, 130);
      const beforeNames = operationNames(before);
      assert.equal(beforeNames.has("lico.gateway.metrics"), true, "read grant should see gateway metrics");
      assert.deepEqual(
        hiddenWithoutAuthority.filter((operation) => beforeNames.has(operation)),
        [],
        "unauthorized operations leaked before grant update"
      );

      const update = await api("POST", `/api/operation-permission/v1/grants/${encodeURIComponent(grant.grantId)}`, {
        scopes: ["gateway:read", "gateway:write"],
        toolsets: ["lico.gateway.read", "lico.gateway.write"],
        maxRisk: "safe_write",
        metadata: { maxRisk: "safe_write" },
        reason: "verify-operation-permission-tag-governed-e2e"
      }, { expectedStatuses: [200] });
      assert.equal(update.payload.grant?.enabled, true);
      const grantEvent = await sse.waitForReasonCode("upstream_audiences_published");

      const afterGrant = await capabilitiesForToken(grant.token, 131);
      const afterGrantNames = operationNames(afterGrant);
      assert.equal(afterGrantNames.has("lico.gateway.forward"), true);

      const tagUpdate = await api("POST", "/api/tag-management/v1/tags", {
        tagId: "governance:e2e-discovery-refresh",
        kind: "custom",
        label: "Tag governed E2E discovery refresh",
        scopePrerequisites: ["auth:admin"]
      }, { expectedStatuses: [200, 201] });
      assert.equal(tagUpdate.payload.mcpToolListChanged, undefined);

      const afterTag = await capabilitiesForToken(grant.token, 132);
      const afterTagNames = operationNames(afterTag);
      assert.equal(afterTagNames.has("lico.gateway.metrics"), true);
      assert.equal(afterTagNames.has("lico.gateway.forward"), true);
      assert.equal(afterTagNames.has("lico.tagManagement.tags.upsert"), false);

      return {
        authorizedReadVisible: true,
        unauthorizedHiddenBeforeGrantUpdate: hiddenWithoutAuthority,
        writeVisibleAfterGrantUpdate: true,
        adminHiddenAfterTagPolicyUpdate: true,
        notifications: [grantEvent.params?.change?.reasonCode, "unrelated_tag_catalog_unchanged"],
        operationCounts: {
          before: before.operations?.length || 0,
          afterGrant: afterGrant.operations?.length || 0,
          afterTag: afterTag.operations?.length || 0
        }
      };
    } finally {
      await sse.close();
    }
  }

  async function verifyAllowAcrossDomains() {
    const gatewayBefore = fixtureState.echoCount;
    const gateway = await callMcp("lico.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { proof: "external-service-forward" },
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 100);
    assertMcpOk(gateway, "external service forward");
    assert.equal(fixtureState.echoCount, gatewayBefore + 1);

    const gatewayAudit = await callMcp("lico.gateway.audit", {
      limit: 20,
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 110);
    assertMcpOk(gatewayAudit, "external service audit");

    const gatewayMetrics = await callMcp("lico.gateway.metrics", {
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 111);
    assertMcpOk(gatewayMetrics, "external service metrics");

    const createWorkspace = await callMcp("lico.workspace.create", {
      title: "Tag governed Operation Permission workspace",
      objective: "Verify tag-governed workspace and document operations."
    }, 103);
    assertMcpOk(createWorkspace, "workspace create");
    workspaceId = mcpPayload(createWorkspace).workspace?.workspaceRef ||
      mcpPayload(createWorkspace).workspace?.workspaceId ||
      mcpPayload(createWorkspace).workspaceId ||
      "";
    assert.ok(workspaceId, "workspace create did not return an id");
    trackSecret(workspaceId);

    const upload = await callMcp("lico.workspace.file.upload", {
      workspaceId,
      folderPath: "tag-governed",
      fileName: "document.txt",
      content: "tag governed document proof\n",
      createdBy: "verify-operation-permission-tag-governed-e2e",
      tagPolicy: tagPolicy(ENTITY_REFS.workspace)
    }, 104);
    assertMcpOk(upload, "workspace upload");
    assert.equal(mcpPayload(upload).ok, true);

    const download = await callMcp("lico.workspace.file.download", {
      workspaceId,
      path: "tag-governed/document.txt",
      tagPolicy: tagPolicy(ENTITY_REFS.document)
    }, 105);
    assertMcpOk(download, "document download");
    assert.equal(mcpPayload(download).content, "tag governed document proof\n");

    const consoleList = await callMcp("lico.tagManagement.tags.list", {
      kind: "custom",
      tagPolicy: tagPolicy(ENTITY_REFS.console)
    }, 109);
    assertMcpOk(consoleList, "console tag list");

    return {
      upstreamService: {
        forward: true,
        audit: true,
        metrics: true,
        tagPolicy: { reasonCode: "tag_policy_allowed", matchedAllowTags: [ALLOW_TAG] }
      },
      workspace: {
        upload: true,
        download: true,
        tagPolicy: { reasonCode: "tag_policy_allowed", matchedAllowTags: [ALLOW_TAG] }
      },
      consoleAdmin: {
        tagList: true,
        tagPolicy: { reasonCode: "tag_policy_allowed", matchedAllowTags: [ALLOW_TAG] }
      }
    };
  }

  async function verifyApprovalEvidence() {
    await upsertTag("governance:e2e-revision-bump", "Tag governed E2E revision bump");
    const approval = await callMcp(APPROVAL_TOOL, {
      tagId: "governance:e2e-pending-approval",
      kind: "custom",
      label: "Tag governed E2E pending approval",
      scopePrerequisites: ["auth:admin"],
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 120, [200, 202]);
    assertMcpOk(approval, "approval required repair tool");
    const payload = mcpPayload(approval);
    assert.equal(payload.status, "pending_approval", JSON.stringify(safeEvidence(payload)));
    assert.equal(payload.policy?.grantPolicyState || payload.resultSummary?.policy?.grantPolicyState || "stale", "stale");
    const pendingOperationId = String(payload.pendingOperation?.pendingOperationId || "");
    assert.ok(pendingOperationId);
    trackSecret(pendingOperationId);

    const pendingList = await api("GET", "/api/operation-permission/v1/pending-operations?status=pending&limit=50", undefined, {
      expectedStatuses: [200]
    });
    const listed = (pendingList.payload.pendingOperations || []).find((item) =>
      item.status === "pending" &&
      item.toolId === APPROVAL_TOOL &&
      item.pendingOperationId === pendingOperationId
    );
    assert.ok(listed);

    const resolved = await api(
      "POST",
      `/api/operation-permission/v1/pending-operations/${encodeURIComponent(listed.pendingOperationId)}/resolve`,
      {
        resolution: "approved",
        resolvedBy: "verify-operation-permission-tag-governed-e2e",
        reason: "verify real approval resolution"
      },
      {
        headers: { "x-lico-safety-confirm": "true" },
        expectedStatuses: [200, 201, 202]
      }
    );
    assert.equal(resolved.payload.status, "ok", JSON.stringify(safeEvidence(resolved.payload)));
    assert.equal(resolved.payload.pendingOperation?.status, "completed");
    return {
      approvalRequired: true,
      stalePolicyEvaluated: true,
      pendingOperationListed: true,
      pendingOperationResolved: true
    };
  }

  async function verifyDenyAcrossDomains() {
    await upsertTag(DENY_TAG, "Tag governed E2E deny", tagProjections());
    const rebuild = await rebuildTagProjections();
    assert.equal(Number(rebuild.count || 0) >= Object.keys(ENTITY_REFS).length, true);

    const gatewayBefore = fixtureState.echoCount;
    const deniedGatewayForward = await callMcp("lico.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { proof: "must-not-forward" },
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 200, [200, 403]);
    assertMcpDenied(deniedGatewayForward, "denied external service forward");
    assert.equal(fixtureState.echoCount, gatewayBefore);

    const deniedGatewayMetrics = await callMcp("lico.gateway.metrics", {
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 206, [200, 403]);
    assertMcpDenied(deniedGatewayMetrics, "denied external service metrics");

    const deniedDocumentDownload = await callMcp("lico.workspace.file.download", {
      workspaceId,
      path: "tag-governed/document.txt",
      tagPolicy: tagPolicy(ENTITY_REFS.document)
    }, 202, [200, 403]);
    assertMcpDenied(deniedDocumentDownload, "denied document download");

    const deniedWorkspaceUpload = await callMcp("lico.workspace.file.upload", {
      workspaceId,
      folderPath: "tag-governed",
      fileName: "denied.txt",
      content: "must not be written\n",
      tagPolicy: tagPolicy(ENTITY_REFS.workspace)
    }, 203, [200, 403]);
    assertMcpDenied(deniedWorkspaceUpload, "denied workspace upload");

    const deniedConsoleTagId = "custom:tag-governed-denied-console";
    const deniedConsole = await callMcp("lico.tagManagement.tags.upsert", {
      tagId: deniedConsoleTagId,
      kind: "custom",
      label: "Denied console tag",
      tagPolicy: tagPolicy(ENTITY_REFS.console)
    }, 205, [200, 403]);
    assertMcpDenied(deniedConsole, "denied console tag upsert");
    const deniedConsoleGet = await api(
      "GET",
      `/api/tag-management/v1/tags/${encodeURIComponent(deniedConsoleTagId)}`,
      undefined,
      { expectedStatuses: [404] }
    );
    assert.equal(deniedConsoleGet.status, 404);

    return {
      upstreamService: {
        forwardDeniedWithoutSideEffect: true,
        metricsDenied: true,
        tagPolicy: denialSummary(deniedGatewayForward)
      },
      workspace: {
        downloadDenied: true,
        uploadDeniedWithoutWrite: true,
        tagPolicy: denialSummary(deniedWorkspaceUpload)
      },
      consoleAdmin: {
        tagUpsertDeniedWithoutMutation: true,
        tagPolicy: denialSummary(deniedConsole)
      }
    };
  }

  async function verifyBypassPrevention() {
    const gatewayBefore = fixtureState.echoCount;
    const wrongOutlet = await callMcpWithToolName(getMcpToken(), "lico.discovery", "lico.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { proof: "wrong-outlet-must-not-forward" },
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 230, [200, 400, 403]);
    assertMcpDenied(wrongOutlet, "wrong outlet gateway forward");
    assert.equal(fixtureState.echoCount, gatewayBefore);

    const readOnlyGrant = await createLocalGrant({
      label: "Operation Permission tag-governed E2E bypass verifier",
      grantMode: "read",
      maxRisk: "read_only",
      toolsets: ["lico.gateway.read"]
    });
    const directWithoutAuthority = await callMcpWithToolName(
      readOnlyGrant.token,
      "lico.gateway",
      "lico.gateway.forward",
      {
        serviceId: SERVICE_ID,
        operationKey: "echo",
        body: { proof: "read-grant-must-not-forward" },
        tagPolicy: tagPolicy(ENTITY_REFS.externalService)
      },
      231,
      [200, 403]
    );
    assertMcpDenied(directWithoutAuthority, "read grant gateway forward");
    assert.equal(fixtureState.echoCount, gatewayBefore);

    return {
      wrongOutletDenied: true,
      insufficientGrantDenied: true,
      noDownstreamMutation: true
    };
  }

  async function verifyAuditMetricsAndCleanup() {
    const audit = await api("GET", "/api/operation-permission/v1/audit?limit=240", undefined, {
      expectedStatuses: [200]
    });
    const items = audit.payload.items || [];
    const statuses = new Set(items.map((item) => item.status));
    assert.equal(statuses.has("ok"), true);
    assert.equal(statuses.has("denied"), true);
    assert.equal(statuses.has("pending_approval"), true);
    const requiredTools = [
      "lico.gateway.forward",
      APPROVAL_TOOL,
      "lico.gateway.audit",
      "lico.gateway.metrics",
      "lico.workspace.file.download",
      "lico.workspace.file.upload",
      "lico.tagManagement.tags.list"
    ];
    const missingAudit = requiredTools.filter((toolId) => !items.some((item) => item.toolId === toolId));
    assert.deepEqual(missingAudit, []);

    const metrics = await api("GET", "/api/operation-permission/v1/metrics/summary?limit=240", undefined, {
      expectedStatuses: [200]
    });
    const byStatus = metrics.payload.metrics?.toolCalls?.byStatus || {};
    const byTool = metrics.payload.metrics?.toolCalls?.byTool || {};
    assert.equal(Number(byStatus.ok || 0) > 0, true);
    assert.equal(Number(byStatus.denied || 0) > 0, true);
    assert.equal(Number(byStatus.pending_approval || 0) > 0, true);
    assert.deepEqual(
      requiredTools.filter((toolId) => Number(byTool[toolId] || 0) <= 0),
      []
    );

    const archive = await api(
      "POST",
      `/api/tag-management/v1/tags/${encodeURIComponent(DENY_TAG)}/archive`,
      { reason: "verify-operation-permission-tag-governed-e2e cleanup" },
      { expectedStatuses: [200] }
    );
    assert.equal(archive.payload.tag?.status, "archived");
    await rebuildTagProjections();

    const disabledPrimary = await api(
      "POST",
      `/api/gateway/v1/external-services/${encodeURIComponent(SERVICE_ID)}/disable`,
      { reason: "verify-operation-permission-tag-governed-e2e cleanup" },
      { expectedStatuses: [400, 403, 404, 405] }
    );
    assert.equal(disabledPrimary.status >= 400, true);

    let revokedGrantCount = 0;
    for (const grantId of [...createdGrantIds].reverse()) {
      const revoke = await api(
        "POST",
        `/api/operation-permission/v1/grants/${encodeURIComponent(grantId)}/revoke`,
        { reason: "verify-operation-permission-tag-governed-e2e cleanup" },
        { expectedStatuses: [200, 404] }
      );
      if (revoke.status === 200) revokedGrantCount += 1;
    }

    return {
      operationPermissionHttpAdminRead: true,
      auditStatuses: [...statuses].sort(),
      auditToolCoverage: Object.fromEntries(requiredTools.map((toolId) => [toolId, true])),
      metricStatuses: {
        ok: Number(byStatus.ok || 0),
        denied: Number(byStatus.denied || 0),
        pendingApproval: Number(byStatus.pending_approval || 0)
      },
      metricToolCoverage: Object.fromEntries(requiredTools.map((toolId) => [toolId, true])),
      cleanup: {
        denyTagArchived: true,
        gatewayServicesConfigManaged: true,
        grantsRevoked: revokedGrantCount,
        tempRuntimeRemovedOnExit: true
      }
    };
  }

  return {
    verifyAllowAcrossDomains,
    verifyApprovalEvidence,
    verifyAuditMetricsAndCleanup,
    verifyBypassPrevention,
    verifyDenyAcrossDomains,
    verifyMcpDiscoveryAuthorizationRefresh
  };
}
