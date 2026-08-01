
import {
  actorFrom,
  arrayOfStrings,
  objectOrNull,
  result,
  subjectFromAuthSession,
  workspaceIdFrom
} from "./shared.ts";
import {
  operationProofSubstrateFor,
  workspaceAssetRegistryFor,
  workspaceGovernanceRegistryFor
} from "./registry-services.ts";
import {
  WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
  appendWorkspaceAssetToResult,
  workspaceAssetCanonicalStateForOperation,
  workspaceAssetCheckpointRef,
  workspaceAssetContentForRegistry,
  workspaceAssetDownstreamPayload,
  workspaceAssetExtractContentSummary,
  workspaceAssetExtractReceipts,
  workspaceAssetExtractState,
  workspaceAssetGovernanceAction,
  workspaceAssetKindForOperation,
  workspaceAssetReceiptsForRegistry,
  workspaceAssetRiskForOperation,
  workspaceAssetRouteDecision,
  workspaceAssetRef,
  workspaceAssetSubject,
  workspaceAssetTargetRef,
  workspaceAssetWorkspaceField
} from "./workspace-asset-model.ts";

export async function evaluateWorkspaceAssetGovernance({ operationId, input = {}, context = {}, semantic = "", target = {} }: Record<string, any> = {}) : Promise<any> {
  const workspaceId: any = workspaceIdFrom(input);
  const action: any = workspaceAssetGovernanceAction(operationId, semantic, input);
  const dataClass: any = input.policy?.dataClass || input.dataClass || "internal";
  const governance: any = workspaceGovernanceRegistryFor(context);
  let described: any = null;
  try {
    described = await governance.describe();
  } catch {
    return {
      allowed: true,
      policyMissing: true,
      warning: { code: "governance_policy_missing", workspaceId, action, dataClass },
      evaluation: null
    };
  }
  const policies: any = Array.isArray(described?.policies) ? described.policies : [];
  const hasPolicy: any = policies.some((policy?: any) : any => policy.workspaceId === workspaceId);
  if (!hasPolicy) {
    return {
      allowed: true,
      policyMissing: true,
      warning: { code: "governance_policy_missing", workspaceId, action, dataClass },
      evaluation: null
    };
  }
  const evaluation: any = await governance.evaluate({
    workspaceId,
    action,
    subject: workspaceAssetSubject(context, input),
    targetWorkspaceId: input.targetWorkspaceId || target.targetWorkspaceId || "",
    targetProjectId: input.targetProjectId || target.targetProjectId || "",
    approvals: input.approvals || input.approvalIds || [],
    dataClass
  });
  return {
    allowed: evaluation.allowed !== false,
    policyMissing: false,
    warning: null,
    evaluation
  };
}

export function workspaceAssetPolicyDecision(governance: Record<string, any> = {}) : any {
  return {
    allowed: governance.allowed !== false,
    policyMissing: governance.policyMissing === true,
    warning: governance.warning || null,
    evaluation: governance.evaluation || null
  };
}

export async function startWorkspaceAssetProof({ operationId, input = {}, context = {}, semantic = "", target = {}, downstreamOperationId = "", routeMode = "executed" }: Record<string, any> = {}) : Promise<any> {
  const governance: any = await evaluateWorkspaceAssetGovernance({ operationId, input, context, semantic, target });
  const warnings: any = governance.warning ? [governance.warning] : [];
  const proofSubstrate: any = operationProofSubstrateFor(context);
  const ledgerEntry: any = await proofSubstrate.beginLifecycle({
    operationId,
    workspaceId: workspaceIdFrom(input),
    semantic,
    assetRef: input.assetRef || input.assetId || "",
    targetKind: target.kind || "",
    targetRef: workspaceAssetTargetRef(input, target),
    subject: workspaceAssetSubject(context, input),
    risk: workspaceAssetRiskForOperation(operationId, input),
    idempotencyKey: input.idempotencyKey || input["idempotency-key"] || "",
    input: {
      ...input,
      downstreamOperationId,
      routeMode
    },
    policyDecision: workspaceAssetPolicyDecision(governance),
    warnings
  });
  return { proofSubstrate, ledgerEntry, governance, warnings };
}

export function workspaceAssetFailureResult({ operationId, input = {}, target = {}, semantic = "", downstreamOperationId = "", status = 503, error = "", ledgerEntry = null }: Record<string, any> = {}) : any {
  return workspaceAssetEnvelope({
    operationId,
    input,
    target,
    semantic,
    status,
    routeDecision: workspaceAssetRouteDecision({
      target,
      downstreamOperationId,
      mode: "failed",
      reason: error,
      ledgerEntry
    }),
    downstreamResult: {
      ok: false,
      error
    }
  });
}

export function buildWorkspaceAssetRegistryInput({ operationId, input = {}, target = {}, semantic = "", downstreamOperationId = "", downstream = {}, ledgerEntry = null, governance = null, routeDecision = {} }: Record<string, any> = {}) : any {
  const assetKind: any = workspaceAssetKindForOperation(downstreamOperationId || operationId, input, target);
  const canonicalState: any = workspaceAssetCanonicalStateForOperation(downstreamOperationId || operationId, semantic, target, downstream);
  const targetRef: any = workspaceAssetTargetRef(input, target);
  const contribution: any = objectOrNull(downstream.contribution) || {};
  const codeChange: any = objectOrNull(downstream.codeChange) || objectOrNull(downstream.change) || {};
  if (contribution.contributionId) {
    targetRef.contributionId = contribution.contributionId;
  }
  if (downstream.contributionId) {
    targetRef.contributionId = downstream.contributionId;
  }
  if (codeChange.codeChangeId || downstream.codeChangeId) {
    targetRef.codeChangeId = codeChange.codeChangeId || downstream.codeChangeId;
  }
  const file: any = objectOrNull(downstream.file) || {};
  if (file.path || file.relativePath) {
    targetRef.path = file.path || file.relativePath;
  }
  return {
    workspaceId: workspaceIdFrom(input),
    assetKind,
    canonicalState,
    dataClass: input.policy?.dataClass || input.dataClass || (assetKind === "codeChange" ? "codeChange" : "internal"),
    displayName:
      input.title ||
      input.name ||
      file.path ||
      file.relativePath ||
      targetRef.path ||
      targetRef.contributionId ||
      targetRef.codeChangeId ||
      assetKind,
    targetKind: target.kind || targetRef.kind || assetKind,
    targetRef,
    sourceRef: {
      kind: "operation",
      operationId,
      downstreamOperationId,
      semantic,
      source: input.source || {}
    },
    content: workspaceAssetContentForRegistry(input, downstream),
    ledgerEventId: ledgerEntry?.ledgerEventId || "",
    checkpointRef: workspaceAssetCheckpointRef(downstream),
    downstreamOperationId,
    receipts: workspaceAssetReceiptsForRegistry(downstream, { ledgerEntry, governance }),
    routeDecision,
    metadata: {
      routeMode: routeDecision.mode || "",
      governance: workspaceAssetPolicyDecision(governance || {})
    }
  };
}

export async function finalizeWorkspaceAssetProof({ proofSubstrate, ledgerEntry, workspaceAsset = null, downstreamResult = null, status = "succeeded", error = null, warnings = [] }: Record<string, any> = {}) : Promise<any> {
  if (!ledgerEntry?.ledgerEventId || !proofSubstrate) return null;
  const receiptRefs: any = Array.isArray(workspaceAsset?.receiptRefs) ? workspaceAsset.receiptRefs : [];
  if (error) {
    return proofSubstrate.finishLifecycle({
      entry: ledgerEntry,
      ledgerEventId: ledgerEntry.ledgerEventId,
      status,
      failed: true,
      assetRef: workspaceAsset?.assetRef || "",
      receiptRefs,
      warnings,
      error
    });
  }
  return proofSubstrate.finishLifecycle({
    entry: ledgerEntry,
    ledgerEventId: ledgerEntry.ledgerEventId,
    status,
    assetRef: workspaceAsset?.assetRef || "",
    receiptRefs,
    auditId: workspaceAssetDownstreamPayload(downstreamResult).auditId || "",
    warnings
  });
}

export async function recordWorkspaceAssetFromDownstream({ operationId, input = {}, context = {}, target = {}, semantic = "", downstreamOperationId = "", downstreamResult = null, ledgerEntry = null, governance = null, routeMode = "executed" }: Record<string, any> = {}) : Promise<any> {
  const downstream: any = workspaceAssetDownstreamPayload(downstreamResult);
  const routeDecision: any = workspaceAssetRouteDecision({
    target,
    downstreamOperationId,
    mode: routeMode,
    ledgerEntry,
    governance: workspaceAssetPolicyDecision(governance || {})
  });
  const registry: any = workspaceAssetRegistryFor(context);
  return registry.recordAssetMutation(buildWorkspaceAssetRegistryInput({
    operationId,
    input,
    target,
    semantic,
    downstreamOperationId,
    downstream,
    ledgerEntry,
    governance,
    routeDecision
  }));
}

export async function runManagedWorkspaceAssetWrite({ operationId, input = {}, context = {}, target = {}, semantic = "", downstreamOperationId = "", routeMode = "executed", run }: Record<string, any> = {}) : Promise<any> {
  let proofContext: any = null;
  try {
    proofContext = await startWorkspaceAssetProof({
      operationId,
      input,
      context,
      semantic,
      target,
      downstreamOperationId,
      routeMode
    });
  } catch (error: any) {
    return workspaceAssetFailureResult({
      operationId,
      input,
      target,
      semantic,
      downstreamOperationId,
      status: 503,
      error: `Operation Proof Substrate 不可用，写操作已关闭：${error instanceof Error ? error.message : String(error)}`
    });
  }

  const { proofSubstrate, ledgerEntry, governance, warnings } = proofContext;
  if (governance.allowed === false) {
    await finalizeWorkspaceAssetProof({
      proofSubstrate,
      ledgerEntry,
      status: "failed",
      error: { code: "workspace_asset_governance_denied", evaluation: governance.evaluation },
      warnings
    });
    return workspaceAssetFailureResult({
      operationId,
      input,
      target,
      semantic,
      downstreamOperationId,
      status: 403,
      error: "统一资产治理策略拒绝该写操作。",
      ledgerEntry
    });
  }

  let downstreamResult: any = null;
  try {
    downstreamResult = await run();
  } catch (error: any) {
    await finalizeWorkspaceAssetProof({
      proofSubstrate,
      ledgerEntry,
      status: "failed",
      error: {
        message: error instanceof Error ? error.message : String(error)
      },
      warnings
    });
    throw error;
  }
  const downstream: any = workspaceAssetDownstreamPayload(downstreamResult);
  const status: any = downstreamResult?.status || (downstream?.ok === false ? downstream.status || 400 : 200);
  const ok: any = Number(status || 200) < 400 && downstream?.ok !== false;
  if (!ok) {
    await finalizeWorkspaceAssetProof({
      proofSubstrate,
      ledgerEntry,
      status: "failed",
      error: downstream,
      warnings
    });
    return {
      ...downstreamResult,
      payload: {
        ...(objectOrNull(downstreamResult?.payload) || {}),
        workspaceAsset: {
          protocolVersion: WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
          assetRef: "",
          revisionRef: "",
          canonicalState: "failed",
          ledgerEventId: ledgerEntry.ledgerEventId,
          receiptRefs: [],
          routeDecision: workspaceAssetRouteDecision({
            target,
            downstreamOperationId,
            mode: "failed",
            ledgerEntry,
            governance: workspaceAssetPolicyDecision(governance)
          })
        }
      }
    };
  }
  let workspaceAsset: any = null;
  try {
    workspaceAsset = await recordWorkspaceAssetFromDownstream({
      operationId,
      input,
      context,
      target,
      semantic,
      downstreamOperationId,
      downstreamResult,
      ledgerEntry,
      governance,
      routeMode
    });
  } catch (error: any) {
    await finalizeWorkspaceAssetProof({
      proofSubstrate,
      ledgerEntry,
      status: "unknown",
      error: {
        code: "workspace_asset_registry_failed_after_downstream_success",
        message: error instanceof Error ? error.message : String(error)
      },
      warnings
    });
    return {
      ...downstreamResult,
      status: 500,
      payload: {
        ...(objectOrNull(downstreamResult?.payload) || {}),
        ok: false,
        error: "Workspace Asset Registry 写入失败；下游副作用可能已成功，operation proof 已标记 unknown。",
        registryError: error instanceof Error ? error.message : String(error),
        workspaceAsset: {
          protocolVersion: WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
          assetRef: "",
          revisionRef: "",
          canonicalState: "unknown",
          ledgerEventId: ledgerEntry.ledgerEventId,
          receiptRefs: [],
          routeDecision: workspaceAssetRouteDecision({
            target,
            downstreamOperationId,
            mode: "unknown",
            ledgerEntry,
            governance: workspaceAssetPolicyDecision(governance)
          })
        }
      }
    };
  }
  await finalizeWorkspaceAssetProof({
    proofSubstrate,
    ledgerEntry,
    workspaceAsset,
    downstreamResult,
    status: "succeeded",
    warnings
  });
  return appendWorkspaceAssetToResult(downstreamResult, workspaceAsset);
}

export function workspaceAssetEnvelope({ operationId, input = {}, target = {}, semantic = "", routeDecision = {}, downstreamResult = null, status = 200, contract = null }: Record<string, any>) : any {
  const downstream: any = downstreamResult?.payload ?? downstreamResult ?? {};
  const workspaceAsset: any = objectOrNull(downstream.workspaceAsset);
  const ok: any = Number(status || 200) < 400 && downstream?.ok !== false;
  return result(status, {
    ok,
    protocolVersion: WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
    operationId,
    workspaceRef: workspaceIdFrom(input),
    assetRef: workspaceAsset?.assetRef || workspaceAssetRef(input, target, semantic),
    revisionRef: workspaceAsset?.revisionRef || "",
    canonicalState: workspaceAsset?.canonicalState || "",
    ledgerEventId: workspaceAsset?.ledgerEventId || routeDecision.ledgerEventId || "",
    receiptRefs: Array.isArray(workspaceAsset?.receiptRefs) ? workspaceAsset.receiptRefs : [],
    semantic,
    routeDecision: workspaceAsset?.routeDecision || routeDecision,
    workspaceAsset: workspaceAsset || undefined,
    target,
    content: workspaceAssetExtractContentSummary(downstream),
    receipts: workspaceAssetExtractReceipts(downstream),
    state: workspaceAssetExtractState(downstream),
    downstream,
    ...(contract ? { contract } : {})
  });
}

export function workspaceAssetContract({ operationId, input = {}, target = {}, semantic = "", downstreamOperationId = "", reason = "", status = 200 }: Record<string, any>) : any {
  return workspaceAssetEnvelope({
    operationId,
    input,
    target,
    semantic,
    status,
    routeDecision: {
      targetKind: target.kind,
      downstreamOperationId,
      mode: "contract",
      reason
    },
    contract: {
      reason,
      downstreamOperationId,
      nextRequiredAction: downstreamOperationId ? "implement_downstream_projection" : "define_downstream_route"
    }
  });
}

export function workspaceAssetForbidden({ operationId, input = {}, target = {}, semantic = "", downstreamOperationId = "", missingScopes = [] }: Record<string, any>) : any {
  return workspaceAssetEnvelope({
    operationId,
    input,
    target,
    semantic,
    status: 403,
    routeDecision: {
      targetKind: target.kind,
      downstreamOperationId,
      mode: "denied",
      missingScopes
    },
    downstreamResult: {
      ok: false,
      error: "统一资产操作缺少下游能力所需的授权 scope。",
      missingScopes
    }
  });
}
