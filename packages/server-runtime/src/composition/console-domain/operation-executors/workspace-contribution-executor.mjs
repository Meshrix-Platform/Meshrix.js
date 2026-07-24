
import {
  appendAuthorizationArtifact,
  callerIdClaim,
  callerKindClaim,
  errorPayload,
  objectOrNull,
  protocolPayload,
  result,
  subjectFromAuthSession,
  workspaceIdFrom
} from "./shared.mjs";
import { contributionRegistryFor } from "./registry-services.mjs";
import {
  isManagedWorkspaceAssetWriteOperation,
  normalizeWorkspaceAssetTarget,
  workspaceAssetSemanticFromOperation
} from "./workspace-asset-model.mjs";
import { runManagedWorkspaceAssetWrite } from "./workspace-asset-governance.mjs";

export function filterContributionsForWorkspace(items = [], input = {}) {
  const workspaceId = String(input.workspaceId || input.workspace || "").trim();
  if (!workspaceId || !items.some((item) => Object.hasOwn(item, "workspaceId"))) {
    return items;
  }
  return items.filter((item) => item.workspaceId === workspaceId);
}

export async function executeWorkspaceContributionOperation({ operationId, input, context }) {
  if (!String(operationId || "").startsWith("workspace.contribution.")) {
    return null;
  }
  if (isManagedWorkspaceAssetWriteOperation(operationId) && context.workspaceAssetManagedWriteActive !== true) {
    const target = normalizeWorkspaceAssetTarget(input, operationId);
    return runManagedWorkspaceAssetWrite({
      operationId,
      input,
      context,
      target,
      semantic: workspaceAssetSemanticFromOperation(operationId),
      downstreamOperationId: operationId,
      routeMode: "managed_workspace_asset_write",
      run: () => executeWorkspaceContributionOperation({
        operationId,
        input,
        context: {
          ...context,
          workspaceAssetManagedWriteActive: true
        }
      })
    });
  }
  const registry = contributionRegistryFor(input, context);
  const authSubject = subjectFromAuthSession(context.authSession);
  const runtimeSubject = objectOrNull(context.subject) || {};
  const subject = {
    ...authSubject,
    ...runtimeSubject,
    subjectId: runtimeSubject.subjectId || runtimeSubject.id || authSubject.subjectId || "",
    username: runtimeSubject.username || authSubject.username || runtimeSubject.label || "",
    scopes: Array.isArray(runtimeSubject.scopes) ? runtimeSubject.scopes : authSubject.scopes
  };
  const callerId = callerIdClaim(context, input, subject);
  const contributorId = callerIdClaim(context, input, subject, ["contributorId", "contributor-id"]);
  const contributorKind = callerKindClaim(context, input, subject);
  const securityPermissions = context.securityPermissions;
  try {
    if (operationId === "workspace.contribution.submit") {
      const resultPayload = registry.submitContribution({
        ...input,
        workspaceId: workspaceIdFrom(input),
        contributorId,
        contributorKind
      });
      return result(201, protocolPayload(resultPayload));
    }
    if (operationId === "workspace.contribution.list") {
      const items = filterContributionsForWorkspace(registry.listContributions(), input);
      return result(200, protocolPayload({ items, count: items.length }));
    }
    if (operationId === "workspace.contribution.assets.list") {
      return result(200, protocolPayload(registry.listWorkspaceAssets(input)));
    }
    if (operationId === "workspace.contribution.leaderboard") {
      const items = filterContributionsForWorkspace(registry.getLeaderboard(), input);
      return result(200, protocolPayload({ items, count: items.length }));
    }
    if (operationId === "workspace.contribution.stats") {
      return result(200, protocolPayload(registry.getStats()));
    }
    if (operationId === "workspace.contribution.report") {
      return result(200, protocolPayload(registry.getContributionReport(input)));
    }
    if (operationId === "workspace.contribution.permission.request") {
      const resultPayload = registry.requestPermission(context.contributionId || input.contributionId, {
        ...input,
        requesterId: callerIdClaim(context, input, subject, ["requesterId", "requester-id"])
      });
      return result(201, protocolPayload(resultPayload));
    }
    if (operationId === "workspace.contribution.permission.grant") {
      const resultPayload = registry.grantPermission(context.contributionId || input.contributionId, {
        ...input,
        granteeId: input.granteeId || subject.subjectId || subject.username
      });
      appendAuthorizationArtifact(securityPermissions, "appendLoanRecord", resultPayload.loanRecord);
      return result(200, protocolPayload(resultPayload));
    }
    if (operationId === "workspace.contribution.scan") {
      return result(200, protocolPayload(registry.scanContribution(context.contributionId || input.contributionId, {
        ...input,
        actorId: callerId
      })));
    }
    if (operationId === "workspace.contribution.review") {
      return result(200, protocolPayload(registry.reviewContribution(context.contributionId || input.contributionId, {
        ...input,
        actorId: callerId,
        reviewerId: callerIdClaim(context, input, subject, ["reviewerId", "reviewer-id"])
      })));
    }
    if (operationId === "workspace.contribution.preview") {
      return result(200, protocolPayload(registry.previewContribution(context.contributionId || input.contributionId, {
        ...input,
        actorId: callerId
      })));
    }
    if (operationId === "workspace.contribution.publish") {
      return result(200, protocolPayload(registry.publishContribution(context.contributionId || input.contributionId, {
        ...input,
        actorId: callerId
      })));
    }
    if (operationId === "workspace.contribution.adopt") {
      return result(200, protocolPayload(registry.adoptContribution(context.contributionId || input.contributionId, {
        ...input,
        actorId: callerId
      })));
    }
    if (operationId === "workspace.contribution.reject") {
      return result(200, protocolPayload(registry.rejectContribution(context.contributionId || input.contributionId, {
        ...input,
        actorId: callerId
      })));
    }
    if (operationId === "workspace.contribution.request_changes") {
      return result(200, protocolPayload(registry.requestChanges(context.contributionId || input.contributionId, {
        ...input,
        actorId: callerId
      })));
    }
    if (operationId === "workspace.contribution.revoke") {
      return result(200, protocolPayload(registry.revokeContribution(context.contributionId || input.contributionId, {
        ...input,
        actorId: callerId
      })));
    }
  } catch (error) {
    return result(400, errorPayload(error, "Workspace contribution operation failed."));
  }
  return null;
}
