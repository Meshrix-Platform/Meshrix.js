
import crypto from "node:crypto";
import {
  actorFrom,
  arrayOfStrings,
  authSessionScopes,
  objectOrNull,
  subjectFromAuthSession,
  workspaceIdFrom
} from "./shared.mjs";

export const WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION = "v0.0.1:workspace:asset-operation-1";

export function missingWorkspaceAssetScopes(context = {}, requiredScopes = []) {
  const scopes = authSessionScopes(context);
  if (scopes.has("auth:admin")) {
    return [];
  }
  return requiredScopes
    .map((scope) => String(scope || "").trim())
    .filter(Boolean)
    .filter((scope) => !scopes.has(scope));
}

export function normalizeWorkspaceAssetTargetKind(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["workspace", "workspace-folder", "workspacefolder", "folder", "file", "files"].includes(normalized)) {
    return "workspaceFolder";
  }
  if (["local", "localdir", "local-dir", "local-directory", "localdirectory"].includes(normalized)) {
    return "localDirectory";
  }
  if (["contribution", "workspace-contribution", "workspacecontribution"].includes(normalized)) {
    return "workspaceContribution";
  }
  return value ? String(value).trim() : "";
}

export function inferWorkspaceAssetTargetKind(input = {}, operationId = "") {
  const target = objectOrNull(input.target) || {};
  const explicit = normalizeWorkspaceAssetTargetKind(
    input.targetKind || input["target-kind"] || input.kind || target.kind || target.type || ""
  );
  if (explicit) {
    return explicit;
  }
  if (target.mountRef || input.mountRef || input["mount-ref"] || target.sourcePath || input.sourcePath) {
    return "localDirectory";
  }
  if (input.contributionId || input["contribution-id"] || target.contributionId) {
    return "workspaceContribution";
  }
  return "workspaceFolder";
}

export function normalizeWorkspaceAssetTarget(input = {}, operationId = "") {
  const target = objectOrNull(input.target) || {};
  const kind = inferWorkspaceAssetTargetKind(input, operationId);
  return {
    ...target,
    kind,
    path: target.path || input.path || input.filePath || input["file-path"] || "",
    mountRef: target.mountRef || input.mountRef || input["mount-ref"] || "",
    sourcePath: target.sourcePath || input.sourcePath || input["source-path"] || ""
  };
}

export function workspaceAssetSemanticFromOperation(operationId = "") {
  const id = String(operationId || "");
  if (id.endsWith(".target.connect") || id.endsWith(".connect")) return "connect";
  if (id.endsWith(".list")) return "list";
  if (id.endsWith(".read")) return "read";
  if (id.endsWith(".submit") || id.endsWith(".file.upload")) return "submit";
  if (id.endsWith(".mutate") || id.endsWith(".file.write") || id.endsWith(".file.patch") || id.endsWith(".file.delete") || id.endsWith(".file.move")) return "mutate";
  if (id.endsWith(".sync.plan")) return "sync.plan";
  if (id.endsWith(".sync.apply") || id.endsWith(".status.sync")) return "sync.apply";
  if (id.endsWith(".import")) return "import";
  if (id.endsWith(".export")) return "export";
  if (id.endsWith(".review.comment")) return "review.comment";
  if (id.endsWith(".review.requestChanges")) return "review.requestChanges";
  if (id.endsWith(".review.approve")) return "review.approve";
  if (id.endsWith(".publish") || id.endsWith(".adopt")) return "review.approve";
  if (id.endsWith(".reject") || id.endsWith(".request_changes")) return "review.requestChanges";
  if (id.endsWith(".checkpoint")) return "checkpoint";
  if (id.endsWith(".lineage")) return "lineage";
  if (id.endsWith(".receipt.get")) return "receipt.get";
  if (id.endsWith(".backfill")) return "backfill";
  return "";
}

export function workspaceAssetRef(input = {}, target = {}, semantic = "") {
  const explicit = String(input.assetRef || input.assetId || input["asset-ref"] || input["asset-id"] || "").trim();
  if (explicit) {
    return explicit;
  }
  const content = objectOrNull(input.content) || {};
  const seed = JSON.stringify({
    workspaceId: workspaceIdFrom(input),
    semantic,
    submitKind: input.submitKind || input.kind || "",
    targetKind: target.kind,
    path: target.path,
    contentHash: input.contentHash || input.sha256 || content.sha256 || ""
  });
  return `workspace_asset_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

export function workspaceAssetDownstreamInput(input = {}, target = {}) {
  const content = objectOrNull(input.content) || {};
  return {
    ...input,
    ...target,
    target,
    workspaceId: workspaceIdFrom(input),
    path: target.path || input.path || input.filePath || input["file-path"] || "",
    content: content.content ?? input.content,
    contentBase64: content.contentBase64 ?? input.contentBase64,
    payloadRefs: content.payloadRefs ?? input.payloadRefs,
    files: content.files ?? input.files
  };
}

export function workspaceAssetExtractContentSummary(downstream = {}) {
  const file = objectOrNull(downstream.file) || objectOrNull(downstream.asset) || objectOrNull(downstream.item) || {};
  return {
    byteSize: Number(file.byteSize || file.sizeBytes || file.size || downstream.byteSize || downstream.sizeBytes || downstream.size || 0) || 0,
    sha256: String(file.sha256 || file.contentSha256 || file.contentHash || downstream.sha256 || downstream.contentSha256 || downstream.contentHash || downstream.hash || ""),
    mediaType: String(file.mediaType || downstream.mediaType || downstream.contentType || "")
  };
}

export function workspaceAssetExtractReceipts(downstream = {}) {
  return {
    accessReceipt: downstream.accessReceipt || downstream.cacheReceipt || null,
    transferReceipt: downstream.transferReceipt || null,
    ingestReceipt: downstream.ingestReceipt || null,
    uploadReceipt: downstream.uploadReceipt || downstream.receipt || null
  };
}

export function workspaceAssetExtractState(downstream = {}) {
  const checkpoint = objectOrNull(downstream.checkpoint) || {};
  return {
    stateCommit: downstream.stateCommit?.commitId || downstream.stateCommit || "",
    checkpointNodeId: checkpoint.nodeId || downstream.checkpointNodeId || downstream.checkpointRef || "",
    auditId: downstream.auditId || downstream.operationAuditId || "",
    ledgerEventId: downstream.ledgerEventId || downstream.eventId || ""
  };
}

export function isWorkspaceAssetReadOnlyOperation(operationId = "") {
  const id = String(operationId || "");
  return (
    id.endsWith(".list") ||
    id.endsWith(".read") ||
    id.endsWith(".sync.plan") ||
    id.endsWith(".lineage") ||
    id.endsWith(".receipt.get") ||
    id === "workspace.asset.permission.check" ||
    id === "workspace.file.list" ||
    id === "workspace.file.read" ||
    id === "workspace.file.download" ||
    id === "agent_workspaces.files.list" ||
    id === "agent_workspaces.file.stat" ||
    id === "agent_workspaces.file.download"
  );
}

export function isManagedWorkspaceAssetWriteOperation(operationId = "") {
  const id = String(operationId || "");
  if (isWorkspaceAssetReadOnlyOperation(id)) return false;
  if (id.startsWith("workspace.asset.")) return id !== "workspace.asset.policy.set";
  return (
    id === "workspace.file.upload" ||
    id === "workspace.file.write" ||
    id === "workspace.file.patch" ||
    id === "agent_workspaces.file.upload" ||
    id === "agent_workspaces.file.write" ||
    id === "agent_workspaces.file.delete" ||
    id === "agent_workspaces.file.move" ||
    id === "workspace.contribution.submit" ||
    id === "workspace.contribution.permission.request" ||
    id === "workspace.contribution.permission.grant" ||
    id === "workspace.contribution.review" ||
    id === "workspace.contribution.publish" ||
    id === "workspace.contribution.adopt" ||
    id === "workspace.contribution.reject" ||
    id === "workspace.contribution.request_changes" ||
    id === "workspace.contribution.revoke"
  );
}

export function workspaceAssetRiskForOperation(operationId = "", input = {}) {
  const id = String(operationId || "");
  if (id.includes(".export") || id.includes(".upload") || id.includes(".publish")) return "controlled_write";
  if (id.includes(".delete") || id.includes(".move") || input.action === "delete" || input.action === "move") return "destructive_write";
  if (id.includes(".sync.apply") || id.includes(".import")) return "materialization_write";
  return "safe_write";
}

export function workspaceAssetKindForOperation(operationId = "", input = {}, target = {}) {
  const id = String(operationId || "");
  const explicit = String(input.assetKind || input.submitKind || input.kind || "").trim();
  if (explicit) {
    if (["contribution", "workspaceContribution"].includes(explicit)) return "workspaceContribution";
    return explicit;
  }
  if (id.includes("contribution") || target.kind === "workspaceContribution") {
    return "workspaceContribution";
  }
  return "file";
}

export function workspaceAssetCanonicalStateForOperation(operationId = "", semantic = "", target = {}, downstream = {}) {
  const id = String(operationId || "");
  const state = String(downstream.canonicalState || downstream.state || downstream.status || "").trim();
  if (["canonical", "pending", "review", "projected", "source", "archived"].includes(state)) return state;
  if (id === "workspace.contribution.submit") return "pending";
  if (id === "workspace.contribution.review" || id === "workspace.contribution.request_changes" || id === "workspace.contribution.reject") return "review";
  if (id === "workspace.contribution.publish" || id === "workspace.contribution.adopt") return "canonical";
  if (semantic === "export") return "projected";
  if (target.kind === "localDirectory" || semantic === "sync.apply") return "projected";
  return "canonical";
}

export function workspaceAssetGovernanceAction(operationId = "", semantic = "", input = {}) {
  const id = String(operationId || "");
  if (semantic === "export" || id.includes(".export")) return "export";
  if (semantic === "import") return "copy";
  if (semantic === "sync.apply") return "copy";
  if (id.includes(".publish")) return "share";
  if (id.includes(".delete")) return "delete";
  if (id.includes(".upload")) return "upload";
  if (id.includes(".prepare")) return "prepare";
  return input.action || semantic || "write";
}

export function workspaceAssetSubject(context = {}, input = {}) {
  const subject = subjectFromAuthSession(context.authSession);
  return {
    ...subject,
    subjectId: subject.subjectId || actorFrom(context.authSession, input),
    organizationId: input.organizationId || input.orgId || context.authSession?.user?.orgId || "",
    projectIds: arrayOfStrings(input.projectIds || input.projectId),
    clearance: input.clearance || input.dataClassClearance || input.policy?.dataClassClearance || "internal",
    roles: Array.isArray(context.authSession?.user?.roles) ? context.authSession.user.roles : []
  };
}

export function workspaceAssetRouteDecision({ target = {}, downstreamOperationId = "", mode = "executed", reason = "", ledgerEntry = null, governance = null } = {}) {
  return {
    targetKind: target.kind || "",
    downstreamOperationId,
    mode,
    ...(reason ? { reason } : {}),
    ...(ledgerEntry?.ledgerEventId ? { ledgerEventId: ledgerEntry.ledgerEventId } : {}),
    ...(governance ? { governance } : {})
  };
}

export function workspaceAssetTargetRef(input = {}, target = {}) {
  return {
    ...target,
    path: target.path || input.path || input.filePath || input["file-path"] || input.targetPath || "",
    filePath: input.filePath || input["file-path"] || "",
    targetPath: input.targetPath || input["target-path"] || "",
    contributionId: input.contributionId || input["contribution-id"] || target.contributionId || "",
    codeChangeId: input.codeChangeId || input.changeId || target.codeChangeId || "",
    provider: target.provider || input.provider || "",
    repoId: target.repoId || input.repoId || "",
    repositoryRef: target.repositoryRef || input.repositoryRef || "",
    branch: target.branch || input.branch || ""
  };
}

export function workspaceAssetContentForRegistry(input = {}, downstream = {}) {
  const content = workspaceAssetExtractContentSummary(downstream);
  const file = objectOrNull(downstream.file) || {};
  const contentInput = objectOrNull(input.content) || {};
  return {
    contentHash: content.sha256 || file.contentSha256 || file.sha256 || downstream.contentSha256 || contentInput.sha256 || input.contentHash || "",
    byteSize: content.byteSize || file.sizeBytes || file.byteSize || downstream.sizeBytes || contentInput.byteSize || 0,
    mediaType: content.mediaType || file.mediaType || downstream.mediaType || contentInput.mediaType || ""
  };
}

export function workspaceAssetCheckpointRef(downstream = {}) {
  const checkpoint = objectOrNull(downstream.checkpoint) || {};
  return checkpoint.nodeId || checkpoint.checkpointNodeId || checkpoint.checkpointId || downstream.checkpointNodeId || downstream.checkpointRef || "";
}

export function workspaceAssetReceiptsForRegistry(downstream = {}, extra = {}) {
  const receipts = workspaceAssetExtractReceipts(downstream);
  const items = [];
  for (const [receiptType, receipt] of Object.entries(receipts)) {
    if (receipt) items.push({ receiptType, receipt });
  }
  if (downstream.checkpoint) items.push({ receiptType: "checkpoint", receipt: downstream.checkpoint });
  if (downstream.stateCommit) items.push({ receiptType: "stateCommit", receipt: downstream.stateCommit });
  if (extra.ledgerEntry?.ledgerEventId) {
    items.push({
      receiptType: "operationProof",
      receipt: {
        ledgerEventId: extra.ledgerEntry.ledgerEventId,
        status: extra.ledgerEntry.status
      }
    });
  }
  if (extra.governance?.warning) {
    items.push({
      receiptType: "governanceWarning",
      receipt: extra.governance.warning
    });
  }
  return items;
}

export function workspaceAssetDownstreamPayload(downstreamResult = null) {
  return objectOrNull(downstreamResult?.payload) || downstreamResult?.payload || downstreamResult || {};
}

export function workspaceAssetWorkspaceField(workspaceAsset = null) {
  if (!workspaceAsset) return null;
  return {
    protocolVersion: WORKSPACE_ASSET_OPERATION_PROTOCOL_VERSION,
    assetRef: workspaceAsset.assetRef || "",
    revisionRef: workspaceAsset.revisionRef || workspaceAsset.currentRevisionRef || "",
    canonicalState: workspaceAsset.canonicalState || "",
    ledgerEventId: workspaceAsset.ledgerEventId || "",
    receiptRefs: Array.isArray(workspaceAsset.receiptRefs) ? workspaceAsset.receiptRefs : [],
    routeDecision: objectOrNull(workspaceAsset.routeDecision) || {}
  };
}

export function appendWorkspaceAssetToResult(downstreamResult = null, workspaceAsset = null) {
  if (!downstreamResult || !workspaceAsset) return downstreamResult;
  const field = workspaceAssetWorkspaceField(workspaceAsset);
  if (!field) return downstreamResult;
  return {
    ...downstreamResult,
    payload: {
      ...(objectOrNull(downstreamResult.payload) || {}),
      workspaceAsset: field
    }
  };
}
