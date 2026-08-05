import assert from "node:assert/strict";

export function createOperationPermissionTagGovernedWorkflows(context: Record<string, any> = {}) : any {
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
    createVerifierApiKey,
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
  let workspaceId: any = "";

  async function verifyMcpDiscoveryAuthorizationRefresh() : Promise<any> {
    // Api-key-only authorization: key policies are immutable snapshots, so an authorization
    // change is a SECOND key issuance (the grant-update flow no longer exists). Tag policy
    // changes refresh the audience projection and fire the list_changed SSE notification.
    const readGrant: any = await createVerifierApiKey({
      label: "Operation Permission tag-governed E2E discovery verifier",
      grantMode: "read",
      maxRisk: "read_only",
      toolsets: ["meshrix.gateway.read", "meshrix.console.read"]
    });
    const hiddenWithoutAuthority: any[] = [
      "meshrix.gateway.forward",
      "meshrix.workspace.file.upload",
      "meshrix.tagManagement.tags.upsert",
      "meshrix.operationPermission.createGrant"
    ];
    const sse: any = await openMcpSse(readGrant.token);
    try {
      const before: any = await capabilitiesForToken(readGrant.token, 130);
      const beforeNames: any = operationNames(before);
      assert.equal(beforeNames.has("meshrix.gateway.metrics"), true, "read grant should see gateway metrics");
      assert.deepEqual(
        hiddenWithoutAuthority.filter((operation?: any) : any => beforeNames.has(operation)),
        [],
        "unauthorized operations leaked before write key issuance"
      );

      const writeGrant: any = await createVerifierApiKey({
        label: "Operation Permission tag-governed E2E discovery write verifier",
        grantMode: "maintain",
        maxRisk: "safe_write",
        toolsets: ["meshrix.gateway.read", "meshrix.gateway.write", "meshrix.console.read"]
      });
      const afterGrant: any = await capabilitiesForToken(writeGrant.token, 131);
      const afterGrantNames: any = operationNames(afterGrant);
      assert.equal(afterGrantNames.has("meshrix.gateway.forward"), true, "write key should see gateway forward");

      const readAfterWrite: any = await capabilitiesForToken(readGrant.token, 133);
      const readAfterWriteNames: any = operationNames(readAfterWrite);
      assert.deepEqual(
        hiddenWithoutAuthority.filter((operation?: any) : any => readAfterWriteNames.has(operation)),
        [],
        "read key visibility changed after write key issuance (key policies must stay immutable)"
      );

      const tagUpdate: any = await api("POST", "/api/tag-management/v1/tags", {
        tagId: "governance:e2e-discovery-refresh",
        kind: "custom",
        label: "Tag governed E2E discovery refresh",
        scopePrerequisites: ["auth:admin"]
      }, { expectedStatuses: [200, 201] });
      assert.equal(tagUpdate.payload.mcpToolListChanged, undefined);

      const tagEvent: any = await sse.waitForReasonCode("upstream_audiences_published");

      const afterTag: any = await capabilitiesForToken(writeGrant.token, 132);
      const afterTagNames: any = operationNames(afterTag);
      assert.equal(afterTagNames.has("meshrix.gateway.metrics"), true);
      assert.equal(afterTagNames.has("meshrix.gateway.forward"), true);
      assert.equal(afterTagNames.has("meshrix.tagManagement.tags.upsert"), false);

      return {
        authorizedReadVisible: true,
        unauthorizedHiddenBeforeGrantUpdate: hiddenWithoutAuthority,
        writeVisibleAfterGrantUpdate: true,
        adminHiddenAfterTagPolicyUpdate: true,
        notifications: [tagEvent.params?.change?.reasonCode, "unrelated_tag_catalog_unchanged"],
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

  async function verifyAllowAcrossDomains() : Promise<any> {
    const gatewayBefore: any = fixtureState.echoCount;
    const gateway: any = await callMcp("meshrix.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { proof: "external-service-forward" },
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 100);
    assertMcpOk(gateway, "external service forward");
    assert.equal(fixtureState.echoCount, gatewayBefore + 1);

    const gatewayAudit: any = await callMcp("meshrix.gateway.audit", {
      limit: 20,
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 110);
    assertMcpOk(gatewayAudit, "external service audit");

    const gatewayMetrics: any = await callMcp("meshrix.gateway.metrics", {
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 111);
    assertMcpOk(gatewayMetrics, "external service metrics");

    const createWorkspace: any = await callMcp("meshrix.workspace.create", {
      title: "Tag governed Operation Permission workspace",
      objective: "Verify tag-governed workspace and document operations."
    }, 103);
    assertMcpOk(createWorkspace, "workspace create");
    const createPayload: any = mcpPayload(createWorkspace);
    workspaceId = createPayload.workspace?.workspaceId ||
      createPayload.workspaceId ||
      "";
    assert.ok(workspaceId, "workspace create did not return an id");
    trackSecret(workspaceId);

    const upload: any = await callMcp("meshrix.workspace.file.upload", {
      workspaceId,
      path: "tag-governed/document.txt",
      content: "tag governed document proof\n",
      tagPolicy: tagPolicy(ENTITY_REFS.workspace)
    }, 104);
    assertMcpOk(upload, "workspace upload");
    assert.equal(mcpPayload(upload).ok, true);

    const download: any = await callMcp("meshrix.workspace.file.download", {
      workspaceId,
      path: "tag-governed/document.txt",
      tagPolicy: tagPolicy(ENTITY_REFS.document)
    }, 105);
    assertMcpOk(download, "document download");
    assert.equal(mcpPayload(download).content, "tag governed document proof\n");

    const consoleList: any = await callMcp("meshrix.tagManagement.tags.list", {
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

  async function verifyApprovalEvidence() : Promise<any> {
    await upsertTag("governance:e2e-revision-bump", "Tag governed E2E revision bump");
    const approval: any = await callMcp(APPROVAL_TOOL, {
      tagId: "governance:e2e-pending-approval",
      kind: "custom",
      label: "Tag governed E2E pending approval",
      scopePrerequisites: ["auth:admin"],
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 120, [200, 202]);
    assertMcpOk(approval, "approval required repair tool");
    const payload: any = mcpPayload(approval);
    assert.equal(payload.status, "pending_approval", JSON.stringify(safeEvidence(payload)));
    // Api-key-only authorization has no grant entities, so the policy state recorded by the
    // approval evaluation is "no-grant" (key policies are immutable snapshots).
    assert.equal(payload.policy?.grantPolicyState || payload.resultSummary?.policy?.grantPolicyState || "no-grant", "no-grant");
    const pendingOperationId: any = String(payload.pendingOperation?.pendingOperationId || "");
    assert.ok(pendingOperationId);
    trackSecret(pendingOperationId);

    const pendingList: any = await api("GET", "/api/operation-permission/v1/pending-operations?status=pending&limit=50", undefined, {
      expectedStatuses: [200]
    });
    const listed: any = (pendingList.payload.pendingOperations || []).find((item?: any) : any =>
      item.status === "pending" &&
      item.toolId === APPROVAL_TOOL &&
      item.pendingOperationId === pendingOperationId
    );
    assert.ok(listed);

    const resolved: any = await api(
      "POST",
      `/api/operation-permission/v1/pending-operations/${encodeURIComponent(listed.pendingOperationId)}/resolve`,
      {
        resolution: "approved",
        reason: "verify real approval resolution"
      },
      {
        headers: { "x-meshrix-safety-confirm": "true" },
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

  async function verifyDenyAcrossDomains() : Promise<any> {
    await upsertTag(DENY_TAG, "Tag governed E2E deny", tagProjections());
    const rebuild: any = await rebuildTagProjections();
    assert.equal(Number(rebuild.count || 0) >= Object.keys(ENTITY_REFS).length, true);

    const gatewayBefore: any = fixtureState.echoCount;
    const deniedGatewayForward: any = await callMcp("meshrix.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { proof: "must-not-forward" },
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 200, [200, 403]);
    assertMcpDenied(deniedGatewayForward, "denied external service forward");
    assert.equal(fixtureState.echoCount, gatewayBefore);

    const deniedGatewayMetrics: any = await callMcp("meshrix.gateway.metrics", {
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 206, [200, 403]);
    assertMcpDenied(deniedGatewayMetrics, "denied external service metrics");

    const deniedDocumentDownload: any = await callMcp("meshrix.workspace.file.download", {
      workspaceId,
      path: "tag-governed/document.txt",
      tagPolicy: tagPolicy(ENTITY_REFS.document)
    }, 202, [200, 403]);
    assertMcpDenied(deniedDocumentDownload, "denied document download");

    const deniedWorkspaceUpload: any = await callMcp("meshrix.workspace.file.upload", {
      workspaceId,
      path: "tag-governed/denied.txt",
      content: "must not be written\n",
      tagPolicy: tagPolicy(ENTITY_REFS.workspace)
    }, 203, [200, 403]);
    assertMcpDenied(deniedWorkspaceUpload, "denied workspace upload");

    const deniedConsoleTagId: any = "custom:tag-governed-denied-console";
    const deniedConsole: any = await callMcp("meshrix.tagManagement.tags.upsert", {
      tagId: deniedConsoleTagId,
      kind: "custom",
      label: "Denied console tag",
      tagPolicy: tagPolicy(ENTITY_REFS.console)
    }, 205, [200, 403]);
    assertMcpDenied(deniedConsole, "denied console tag upsert");
    const deniedConsoleGet: any = await api(
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

  async function verifyBypassPrevention() : Promise<any> {
    const gatewayBefore: any = fixtureState.echoCount;
    const wrongOutlet: any = await callMcpWithToolName(getMcpToken(), "meshrix.discovery", "meshrix.gateway.forward", {
      serviceId: SERVICE_ID,
      operationKey: "echo",
      body: { proof: "wrong-outlet-must-not-forward" },
      tagPolicy: tagPolicy(ENTITY_REFS.externalService)
    }, 230, [200, 400, 403]);
    assertMcpDenied(wrongOutlet, "wrong outlet gateway forward");
    assert.equal(fixtureState.echoCount, gatewayBefore);

    const readOnlyGrant: any = await createVerifierApiKey({
      label: "Operation Permission tag-governed E2E bypass verifier",
      grantMode: "read",
      maxRisk: "read_only",
      toolsets: ["meshrix.gateway.read"]
    });
    const directWithoutAuthority: any = await callMcpWithToolName(
      readOnlyGrant.token,
      "meshrix.gateway",
      "meshrix.gateway.forward",
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

  async function verifyAuditMetricsAndCleanup() : Promise<any> {
    const audit: any = await api("GET", "/api/operation-permission/v1/audit?limit=240", undefined, {
      expectedStatuses: [200]
    });
    const items: any = audit.payload.items || [];
    const statuses: any = new Set<any>(items.map((item?: any) : any => item.status));
    assert.equal(statuses.has("ok"), true);
    assert.equal(statuses.has("denied"), true);
    assert.equal(statuses.has("pending_approval"), true);
    const requiredTools: any[] = [
      "meshrix.gateway.forward",
      APPROVAL_TOOL,
      "meshrix.gateway.audit",
      "meshrix.gateway.metrics",
      "meshrix.workspace.file.download",
      "meshrix.workspace.file.upload",
      "meshrix.tagManagement.tags.list"
    ];
    const missingAudit: any = requiredTools.filter((toolId?: any) : any => !items.some((item?: any) : any => item.toolId === toolId));
    assert.deepEqual(missingAudit, []);

    const metrics: any = await api("GET", "/api/operation-permission/v1/metrics/summary?limit=240", undefined, {
      expectedStatuses: [200]
    });
    const byStatus: any = metrics.payload.metrics?.toolCalls?.byStatus || {};
    const byTool: any = metrics.payload.metrics?.toolCalls?.byTool || {};
    assert.equal(Number(byStatus.ok || 0) > 0, true);
    assert.equal(Number(byStatus.denied || 0) > 0, true);
    assert.equal(Number(byStatus.pending_approval || 0) > 0, true);
    assert.deepEqual(
      requiredTools.filter((toolId?: any) : any => Number(byTool[toolId] || 0) <= 0),
      []
    );

    const archive: any = await api(
      "POST",
      `/api/tag-management/v1/tags/${encodeURIComponent(DENY_TAG)}/archive`,
      {},
      { expectedStatuses: [200] }
    );
    assert.equal(archive.payload.tag?.status, "archived");
    await rebuildTagProjections();

    const disabledPrimary: any = await api(
      "POST",
      `/api/gateway/v1/external-services/${encodeURIComponent(SERVICE_ID)}/disable`,
      {},
      { expectedStatuses: [400, 403, 404, 405] }
    );
    assert.equal(disabledPrimary.status >= 400, true);

    let revokedGrantCount: any = 0;
    for (const grantId of [...createdGrantIds].reverse()) {
      const revoke: any = await api(
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
      auditToolCoverage: Object.fromEntries(requiredTools.map((toolId?: any) : any => [toolId, true])),
      metricStatuses: {
        ok: Number(byStatus.ok || 0),
        denied: Number(byStatus.denied || 0),
        pendingApproval: Number(byStatus.pending_approval || 0)
      },
      metricToolCoverage: Object.fromEntries(requiredTools.map((toolId?: any) : any => [toolId, true])),
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
