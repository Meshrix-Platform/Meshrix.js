
import {
  missingWorkspaceAssetScopes,
  isManagedWorkspaceAssetWriteOperation,
  normalizeWorkspaceAssetTarget,
  workspaceAssetDownstreamInput,
  workspaceAssetRouteDecision,
  workspaceAssetSemanticFromOperation
} from "./workspace-asset-model.mjs";
import {
  finalizeWorkspaceAssetProof,
  runManagedWorkspaceAssetWrite,
  startWorkspaceAssetProof,
  workspaceAssetEnvelope,
  workspaceAssetContract,
  workspaceAssetFailureResult,
  workspaceAssetForbidden,
  workspaceAssetPolicyDecision
} from "./workspace-asset-governance.mjs";
import { contributionRegistryFor, workspaceAssetRegistryFor } from "./registry-services.mjs";
import { objectOrNull, workspaceAccessOptions, workspaceIdFrom } from "./shared.mjs";
import { executeAgentWorkspaceFileOperation } from "./agent-workspace-files-executor.mjs";
import { executeWorkspaceContributionOperation } from "./workspace-contribution-executor.mjs";
import { executeWorkspaceGovernanceOperation } from "./runtime-admin-executors.mjs";

export async function executeWorkspaceAssetDownstream({ operationId, input, context, downstreamOperationId, downstreamInput, requiredScopes = [], routeMode = "executed" }) {
  const target = normalizeWorkspaceAssetTarget(input, operationId);
  const semantic = workspaceAssetSemanticFromOperation(operationId);
  const missingScopes = missingWorkspaceAssetScopes(context, requiredScopes);
  if (missingScopes.length > 0) {
    return workspaceAssetForbidden({ operationId, input, target, semantic, downstreamOperationId, missingScopes });
  }

  const runDownstream = async (managedContext = context) => {
    if (
      downstreamOperationId.startsWith("workspace.file.") ||
      downstreamOperationId.startsWith("agent_workspaces.")
    ) {
      return executeAgentWorkspaceFileOperation({
        operationId: downstreamOperationId,
        input: downstreamInput,
        context: managedContext
      });
    }
    if (downstreamOperationId.startsWith("workspace.contribution.")) {
      return executeWorkspaceContributionOperation({
        operationId: downstreamOperationId,
        input: downstreamInput,
        context: managedContext
      });
    }
    if (downstreamOperationId.startsWith("workspace_governance.")) {
      return executeWorkspaceGovernanceOperation({
        operationId: downstreamOperationId,
        input: downstreamInput,
        context: managedContext
      });
    }
    return null;
  };

  if (isManagedWorkspaceAssetWriteOperation(downstreamOperationId)) {
    const managedResult = await runManagedWorkspaceAssetWrite({
      operationId,
      input,
      context,
      target,
      semantic,
      downstreamOperationId,
      routeMode,
      run: () => runDownstream({
        ...context,
        workspaceAssetManagedWriteActive: true
      })
    });
    if (!managedResult) {
      return workspaceAssetContract({
        operationId,
        input,
        target,
        semantic,
        downstreamOperationId,
        reason: "downstream_operation_not_available",
        status: 501
      });
    }
    return workspaceAssetEnvelope({
      operationId,
      input,
      target,
      semantic,
      status: managedResult.status || 200,
      routeDecision: {
        targetKind: target.kind,
        downstreamOperationId,
        mode: routeMode
      },
      downstreamResult: managedResult
    });
  }

  let downstreamResult = await runDownstream();

  if (!downstreamResult) {
    return workspaceAssetContract({
      operationId,
      input,
      target,
      semantic,
      downstreamOperationId,
      reason: "downstream_operation_not_available",
      status: 501
    });
  }

  return workspaceAssetEnvelope({
    operationId,
    input,
    target,
    semantic,
    status: downstreamResult.status || 200,
    routeDecision: {
      targetKind: target.kind,
      downstreamOperationId,
      mode: routeMode
    },
    downstreamResult
  });
}


export async function executeWorkspaceAssetOperation({ operationId, input = {}, context = {} }) {
  const id = String(operationId || "");
  if (!id.startsWith("workspace.asset.") || id === "workspace.asset.policy.set" || id === "workspace.asset.permission.check") {
    return null;
  }

  const target = normalizeWorkspaceAssetTarget(input, id);
  const semantic = workspaceAssetSemanticFromOperation(id);
  const downstreamInput = workspaceAssetDownstreamInput(input, target);
  const mutation = objectOrNull(input.mutation) || {};
  const action = String(input.action || mutation.action || input.mutateAction || "").trim().toLowerCase();

  const execute = (downstreamOperationId, requiredScopes = [], extraInput = {}, routeMode = "executed") =>
    executeWorkspaceAssetDownstream({
      operationId: id,
      input,
      context,
      downstreamOperationId,
      downstreamInput: {
        ...downstreamInput,
        ...extraInput
      },
      requiredScopes,
      routeMode
    });

  if (id === "workspace.asset.backfill") {
    let proofContext = null;
    try {
      proofContext = await startWorkspaceAssetProof({
        operationId: id,
        input,
        context,
        semantic: "backfill",
        target,
        downstreamOperationId: "workspace.asset.backfill",
        routeMode: "registry_backfill"
      });
    } catch (error) {
      return workspaceAssetFailureResult({
        operationId: id,
        input,
        target,
        semantic: "backfill",
        downstreamOperationId: "workspace.asset.backfill",
        status: 503,
        error: `Operation Proof Substrate 不可用，backfill 已关闭：${error instanceof Error ? error.message : String(error)}`
      });
    }
    try {
      const registry = workspaceAssetRegistryFor(context);
	      const backfillResult = await registry.backfill({
	        ...input,
	        ...workspaceAccessOptions(context.authSession),
	        agentWorkspace: context.agentWorkspace,
	        contributionRegistry: contributionRegistryFor(input, context)
	      });
      await finalizeWorkspaceAssetProof({
        proofSubstrate: proofContext.proofSubstrate,
        ledgerEntry: proofContext.ledgerEntry,
        downstreamResult: { payload: backfillResult },
        status: "succeeded",
        warnings: proofContext.warnings
      });
      return workspaceAssetEnvelope({
        operationId: id,
        input,
        target,
        semantic: "backfill",
        status: 200,
        routeDecision: workspaceAssetRouteDecision({
          target,
          downstreamOperationId: "workspace.asset.backfill",
          mode: "registry_backfill",
          ledgerEntry: proofContext.ledgerEntry,
          governance: workspaceAssetPolicyDecision(proofContext.governance)
        }),
        downstreamResult: {
          status: 200,
          payload: {
            ...backfillResult,
            ledgerEventId: proofContext.ledgerEntry.ledgerEventId
          }
        }
      });
    } catch (error) {
      await finalizeWorkspaceAssetProof({
        proofSubstrate: proofContext.proofSubstrate,
        ledgerEntry: proofContext.ledgerEntry,
        status: "failed",
        error: { message: error instanceof Error ? error.message : String(error) },
        warnings: proofContext.warnings
      });
      return workspaceAssetFailureResult({
        operationId: id,
        input,
        target,
        semantic: "backfill",
        downstreamOperationId: "workspace.asset.backfill",
        status: 500,
        error: `workspace asset backfill failed: ${error instanceof Error ? error.message : String(error)}`,
        ledgerEntry: proofContext.ledgerEntry
      });
    }
  }

  if (semantic === "connect") {
    if (target.kind === "workspaceFolder") {
      let ledgerEntry = null;
      try {
        const proofContext = await startWorkspaceAssetProof({
          operationId: id,
          input,
          context,
          semantic,
          target,
          downstreamOperationId: "",
          routeMode: "no_op"
        });
        ledgerEntry = proofContext.ledgerEntry;
        await finalizeWorkspaceAssetProof({
          proofSubstrate: proofContext.proofSubstrate,
          ledgerEntry: proofContext.ledgerEntry,
          status: "succeeded",
          warnings: proofContext.warnings
        });
      } catch (error) {
        return workspaceAssetFailureResult({
          operationId: id,
          input,
          target,
          semantic,
          downstreamOperationId: "",
          status: 503,
          error: `Operation Proof Substrate 不可用，写操作已关闭：${error instanceof Error ? error.message : String(error)}`
        });
      }
      return workspaceAssetEnvelope({
        operationId: id,
        input,
        target,
        semantic,
        routeDecision: workspaceAssetRouteDecision({
          target,
          downstreamOperationId: "",
          mode: "no_op",
          ledgerEntry
        }),
        downstreamResult: {
          ok: true,
          connected: true,
          reason: "workspaceFolder is the native managed workspace target."
        }
      });
    }
    return workspaceAssetContract({
      operationId: id,
      input,
      target,
      semantic,
      downstreamOperationId: "",
      reason: "target_connect_adapter_disabled"
    });
  }

  if (semantic === "list") {
    const registry = workspaceAssetRegistryFor(context);
    return workspaceAssetEnvelope({
      operationId: id,
      input,
      target,
      semantic,
      routeDecision: workspaceAssetRouteDecision({
        target,
        downstreamOperationId: "workspace.asset.registry.list",
        mode: "registry"
      }),
      downstreamResult: {
        status: 200,
        payload: registry.listAssets({
          workspaceId: workspaceIdFrom(input),
          targetKind: input.targetKind || input["target-kind"] || "",
          assetKind: input.assetKind || "",
          canonicalState: input.canonicalState || "",
          limit: Number(input.limit || 100)
        })
      }
    });
  }

  if (semantic === "read") {
    const assetRef = String(input.assetRef || input.assetId || input.id || input["asset-ref"] || input["asset-id"] || "").trim();
    if (assetRef) {
      const registry = workspaceAssetRegistryFor(context);
      const asset = registry.getAsset({ assetRef });
      return workspaceAssetEnvelope({
        operationId: id,
        input,
        target,
        semantic,
        status: asset ? 200 : 404,
        routeDecision: workspaceAssetRouteDecision({
          target,
          downstreamOperationId: "workspace.asset.registry.read",
          mode: "registry"
        }),
        downstreamResult: {
          status: asset ? 200 : 404,
          payload: asset || { ok: false, error: "workspace asset 不存在。" }
        }
      });
    }
    return execute("workspace.file.read", ["storage:read"]);
  }

  if (semantic === "submit") {
    if (target.kind === "workspaceContribution") {
      return execute("workspace.contribution.submit", ["workspace:write"]);
    }
    return execute("workspace.file.upload", ["storage:write"]);
  }

  if (semantic === "mutate") {
    if (action === "delete") {
      return workspaceAssetContract({
        operationId: id,
        input,
        target,
        semantic,
        downstreamOperationId: "agent_workspaces.file.delete",
        reason: "delete_requires_explicit_confirmed_downstream_operation"
      });
    }
    if (action === "move" || action === "rename") {
      return workspaceAssetContract({
        operationId: id,
        input,
        target,
        semantic,
        downstreamOperationId: "agent_workspaces.file.move",
        reason: "move_requires_explicit_confirmed_downstream_operation"
      });
    }
    if (action === "patch") {
      return execute("workspace.file.patch", ["storage:write"]);
    }
    return execute("workspace.file.write", ["storage:write"]);
  }

  if (semantic === "sync.plan") {
    return workspaceAssetContract({
      operationId: id,
      input,
      target,
      semantic,
      reason: "sync_plan_target_not_supported"
    });
  }

  if (semantic === "sync.apply") {
    return workspaceAssetContract({
      operationId: id,
      input,
      target,
      semantic,
      reason: "sync_apply_target_not_supported"
    });
  }

  if (semantic === "import") {
    if (target.kind === "workspaceFolder" && (downstreamInput.content || downstreamInput.contentBase64 || downstreamInput.payloadRefs)) {
      return execute("workspace.file.upload", ["storage:write"], {}, "materialized_import");
    }
    return workspaceAssetContract({
      operationId: id,
      input,
      target,
      semantic,
      downstreamOperationId: "",
      reason: "import_requires_materialization_bridge"
    });
  }

  if (semantic === "export") {
    return workspaceAssetContract({
      operationId: id,
      input,
      target,
      semantic,
      downstreamOperationId: "",
      reason: "export_requires_source_asset_resolution"
    });
  }

  if (semantic === "review.comment") {
    if (target.kind === "workspaceContribution") {
      return execute("workspace.contribution.review", ["workspace:maintain"]);
    }
  }

  if (semantic === "review.requestChanges") {
    if (target.kind === "workspaceContribution") {
      return execute("workspace.contribution.request_changes", ["workspace:maintain"]);
    }
  }

  if (semantic === "review.approve") {
    if (target.kind === "workspaceContribution") {
      return workspaceAssetContract({
        operationId: id,
        input,
        target,
        semantic,
        downstreamOperationId: "workspace.contribution.publish",
        reason: "contribution_publish_requires_explicit_lifecycle_confirmation"
      });
    }
  }

  if (semantic === "lineage") {
    if (input.assetRef || input.assetId || input.id) {
      const registry = workspaceAssetRegistryFor(context);
      const lineage = registry.listLineage({
        workspaceId: workspaceIdFrom(input),
        assetRef: input.assetRef || input.assetId || input.id,
        limit: Number(input.limit || 100)
      });
      return workspaceAssetEnvelope({
        operationId: id,
        input,
        target,
        semantic,
        routeDecision: workspaceAssetRouteDecision({
          target,
          downstreamOperationId: "workspace.asset.registry.lineage",
          mode: "registry"
        }),
        downstreamResult: {
          status: 200,
          payload: lineage
        }
      });
    }
    return workspaceAssetContract({
      operationId: id,
      input,
      target,
      semantic,
      downstreamOperationId: "",
      reason: "workspace_asset_history_external_adapter_removed"
    });
  }

  if (semantic === "receipt.get") {
    const registry = workspaceAssetRegistryFor(context);
    return workspaceAssetEnvelope({
      operationId: id,
      input,
      target,
      semantic,
      routeDecision: workspaceAssetRouteDecision({
        target,
        downstreamOperationId: "workspace.asset.registry.receipts",
        mode: "registry"
      }),
      downstreamResult: {
        status: 200,
        payload: registry.listReceipts({
          workspaceId: workspaceIdFrom(input),
          assetRef: input.assetRef || input.assetId || input.id || "",
          limit: Number(input.limit || 100)
        })
      }
    });
  }

  if (semantic === "checkpoint") {
    return workspaceAssetContract({
      operationId: id,
      input,
      target,
      semantic,
      downstreamOperationId: "workspace.checkpoint.tree.list",
      reason: "checkpoint_creation_facade_not_bound_yet"
    });
  }

  return workspaceAssetContract({
    operationId: id,
    input,
    target,
    semantic,
    reason: "workspace_asset_semantic_not_supported"
  });
}
