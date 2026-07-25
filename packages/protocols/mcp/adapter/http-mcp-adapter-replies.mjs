import { createMcpCatalogInvalidation } from "#meshrix/contracts/mcp-catalog-delivery";
import { broadcastConfiguredMcpNotification } from "./mcp-notification-bus.mjs";
import {
  jsonRpcNotification,
  mcpEnvelopePublic,
  publicMcpEnvelopeValue
} from "./http-mcp-adapter-response.mjs";

function firstString(values = []) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function findFirstDeepString(value, keys = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) {
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const found = findFirstDeepString(item, keys, depth + 1);
      if (found) {
        return found;
      }
    }
    return "";
  }
  for (const key of keys) {
    const candidate = value[key];
    if (candidate !== undefined && candidate !== null && candidate !== "") {
      return String(candidate).trim();
    }
  }
  for (const child of Object.values(value)) {
    const found = findFirstDeepString(child, keys, depth + 1);
    if (found) {
      return found;
    }
  }
  return "";
}

export function inferMcpTargetReceipt({ operation = "", input = {}, payload = {}, envelope = {} } = {}) {
  const operationId = String(operation || "").trim();
  const targetProvider = firstString([
    input.provider,
    input.targetProvider,
    input.reviewProvider,
    payload.provider,
    payload.targetProvider,
    findFirstDeepString(payload, ["provider", "targetProvider", "reviewProvider"])
  ]);
  let targetKind = "operation";
  if (/workspace|agentWorkspace|file|artifact|proposal|context/i.test(operationId)) {
    targetKind = "workspace";
  }
  const provider = targetProvider || "meshrix";
  const workspaceId = firstString([
    envelope.workspaceId,
    input.workspaceRef,
    input.workspaceId,
    payload.workspaceRef,
    payload.workspaceId,
    findFirstDeepString(payload, ["workspaceRef", "workspaceId"])
  ]);
  const repositoryRef = firstString([
    input.repositoryRef,
    input.repositoryId,
    input.repo,
    input.project,
    payload.repositoryRef,
    payload.repositoryId,
    payload.project,
    findFirstDeepString(payload, ["repositoryRef", "repositoryId", "repo", "project"])
  ]);
  const changeRef = firstString([
    input.changeRef,
    input.changeId,
    input.changeNumber,
    payload.changeRef,
    payload.changeId,
    payload.changeNumber,
    findFirstDeepString(payload, ["changeRef", "changeId", "changeNumber"])
  ]);
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    targetKind,
    targetProvider: provider,
    targetRef: firstString([
      input.targetRef,
      payload.targetRef,
      changeRef,
      repositoryRef,
      workspaceId
    ]),
    workspaceId,
    repositoryRef,
    branch: firstString([
      input.branch,
      input.branchName,
      payload.branch,
      payload.branchName,
      findFirstDeepString(payload, ["branch", "branchName"])
    ]),
    changeRef,
    reviewUrl: firstString([
      input.reviewUrl,
      input.url,
      payload.reviewUrl,
      payload.url,
      findFirstDeepString(payload, ["reviewUrl", "webUrl", "url"])
    ]),
    externalId: firstString([
      input.externalId,
      payload.externalId,
      findFirstDeepString(payload, ["externalId", "id"])
    ]),
    status: firstString([
      payload.status,
      payload.state,
      payload.ok === false ? "failed" : "",
      payload.ok === true ? "ok" : ""
    ]) || "completed"
  };
}

export function projectMcpOperationPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { payload, exchange: null };
  }
  const exchange = payload.exchange;
  if (!exchange || typeof exchange !== "object" || Array.isArray(exchange)) {
    return { payload, exchange: null };
  }
  const { exchange: _exchange, ...operationPayload } = payload;
  return { payload: operationPayload, exchange };
}

export function mcpReplyPayload(payload) {
  const text = JSON.stringify(payload ?? {});
  if (text.length <= 32_000) {
    return payload;
  }
  if (Array.isArray(payload)) {
    return { type: "array", length: payload.length };
  }
  if (payload && typeof payload === "object") {
    return { type: "object", keys: Object.keys(payload).slice(0, 40) };
  }
  return { value: payload };
}

export function broadcastMcpToolListChanged({
  grantId = "",
  reasonCode = "tool_list_changed",
  includePrivate = true,
  partitionKeys = null,
  grantIdDigests = null,
  sourceRevision = null,
  catalogRevision = null,
  audienceRevision = null,
  coalesceKey = ""
} = {}) {
  const scopedGrantId = String(grantId || "").trim();
  const revisionChain = {};
  if (Number.isSafeInteger(sourceRevision) && sourceRevision >= 0) {
    revisionChain.sourceRevision = sourceRevision;
  }
  if (catalogRevision !== null && catalogRevision !== undefined && String(catalogRevision).trim()) {
    revisionChain.catalogRevision = String(catalogRevision).trim();
  }
  if (Number.isSafeInteger(audienceRevision) && audienceRevision >= 0) {
    revisionChain.audienceRevision = audienceRevision;
  }
  const change = createMcpCatalogInvalidation({
    reasonCode: String(reasonCode || "tool_list_changed"),
    ...revisionChain,
    affectedPartitions: Array.isArray(partitionKeys) ? partitionKeys : []
  });
  const delivery = broadcastConfiguredMcpNotification(jsonRpcNotification("notifications/tools/list_changed", {
    change
  }), {
    grantId: scopedGrantId,
    includePrivate,
    partitionKeys,
    grantIdDigests,
    coalesceKey: coalesceKey || (revisionChain.audienceRevision !== undefined
      ? `audience:${revisionChain.audienceRevision}`
      : "")
  });
  return {
    ok: true,
    notification: "notifications/tools/list_changed",
    grantId: scopedGrantId,
    reasonCode: change.reasonCode || "tool_list_changed",
    ...revisionChain,
    ...delivery
  };
}

/**
 * Deliver revision-only catalog invalidation to affected audience partitions.
 * Resolves opaque partition keys to grant digests using current/previous projection maps.
 */
export function broadcastAudienceCatalogInvalidation({
  sourceRevision = null,
  catalogRevision = "",
  audienceRevision = null,
  affectedPartitions = [],
  partitions = null,
  previousPartitions = null,
  reasonCode = "upstream_audiences_published"
} = {}) {
  const partitionKeys = [...new Set(
    (Array.isArray(affectedPartitions) ? affectedPartitions : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )].sort();
  const grantIdDigests = [];
  const current = partitions instanceof Map ? partitions : new Map(partitions || []);
  const previous = previousPartitions instanceof Map
    ? previousPartitions
    : new Map(previousPartitions || []);
  for (const key of partitionKeys) {
    const part = current.get(key) || previous.get(key);
    const digest = String(part?.grantIdDigest || "").trim();
    if (digest) grantIdDigests.push(digest);
  }
  if (partitionKeys.length === 0 && grantIdDigests.length === 0) {
    return {
      ok: true,
      notification: "notifications/tools/list_changed",
      reasonCode,
      matchedConnectionCount: 0,
      deliveredConnectionCount: 0,
      skipped: true
    };
  }
  return broadcastMcpToolListChanged({
    reasonCode,
    includePrivate: true,
    partitionKeys,
    grantIdDigests: [...new Set(grantIdDigests)],
    sourceRevision,
    catalogRevision,
    audienceRevision,
    coalesceKey: Number.isSafeInteger(audienceRevision) ? `audience:${audienceRevision}` : ""
  });
}

export function broadcastMcpOperationReply({ envelope, operation, status, target, exchange = null, payload = {}, error = null, authorization = null, workspaceDirectory = null }) {
  const grantId = authorization?.grant?.id || "";
  const message = status === "completed"
    ? `已完成 ${operation} 任务`
    : `${operation} 任务执行失败`;
  broadcastConfiguredMcpNotification(jsonRpcNotification("notifications/meshrix/operation_reply", {
    schemaVersion: "v0.0.1:schema:definition-1",
    status,
    operation,
    message,
    envelope: mcpEnvelopePublic(envelope, workspaceDirectory),
    target: publicMcpEnvelopeValue(target || {}, workspaceDirectory),
    ...(exchange ? { exchange: publicMcpEnvelopeValue(exchange, workspaceDirectory) } : {}),
    payload: mcpReplyPayload(payload),
    error,
    completedAt: new Date().toISOString()
  }), { grantId });
}
