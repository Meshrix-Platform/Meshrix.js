import { canonicalJson as stableJson } from "@lico/contracts/serialization/canonical-json";
import { randomUUID } from "node:crypto";
import {
  PACTIUM_PACKAGE_VERSION,
  PACTIUM_PROTOCOL,
  PACTIUM_SCHEMA_VERSION
} from "pactium";
import { assertServerToken, serverToken } from "#lico/client-strings";
import { queueStateMutation } from "../../storage/state-coordinator.mjs";
import {
  normalizeLicoPactiumRuntime,
  resolveLicoPactiumDataDir
} from "./pactium-substrate-preflight.mjs";

export const CHECKPOINT_TREE_PROJECTION_PROTOCOL = PACTIUM_PROTOCOL;
export const CHECKPOINT_TREE_PROJECTION_PROVIDER = "pactium.checkpoint-projection";

const TREE_SCOPE = "licomesh-checkpoint-tree";
const INDEX_SCOPE = "licomesh-checkpoint-tree-index";
const INDEX_KEY = "tree-ids";
const TREE_TYPE = "licomesh.checkpoint-tree";
const OWNS_PACTIUM_RUNTIME = Symbol("ownsPactiumRuntime");

const VALID_NODE_STATUS = new Set(["pending", "running", "paused", "completed", "failed", "skipped"]);
const VALID_TREE_STATUS = new Set(["running", "completed", "failed", "paused", "cancelled"]);
async function withCheckpointProjectionMutation(input, task) {
  const normalized = withRuntime(input);
  const { core, storage } = normalized.pactiumRuntime;
  try {
    return await queueStateMutation(`pactium-storage:${normalized.dataDir}`, async () => {
      const mutate = async () => {
        if (!storage.inMemory) storage.clearCache?.();
        return task(normalized);
      };
      await storage.initialize?.();
      const backend = text(storage.selectedStorageBackend || storage.storageBackend || "").toLowerCase();
      if (!storage.inMemory && backend !== "sqlite") {
        throw checkpointProjectionError(
          "pactium_transactional_storage_required",
          "Durable checkpoint mutations require Pactium SQLite transactional storage."
        );
      }
      if (typeof core.withMutationTransaction === "function") {
        return core.withMutationTransaction(mutate);
      }
      if (storage.inMemory) return mutate();
      throw checkpointProjectionError(
        "pactium_transaction_api_required",
        "Durable checkpoint mutations require Pactium compound mutation transactions."
      );
    });
  } finally {
    await closeOwnedRuntime(normalized);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeNodeId(value, fallback = "root") {
  return text(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "") || fallback;
}

function normalizeStatus(value, fallback = "running") {
  const status = text(value, fallback).toLowerCase();
  return VALID_NODE_STATUS.has(status) ? status : fallback;
}

function normalizeTreeStatus(value, fallback = "completed") {
  const status = text(value, fallback).toLowerCase();
  return VALID_TREE_STATUS.has(status) ? status : fallback;
}

function eventId(type = "checkpoint.event") {
  return serverToken("checkpoint_event", type, nowIso(), randomUUID());
}

function withRuntime(input = {}) {
  const ownsPactiumRuntime = !input.pactiumRuntime && !input.runtime;
  const dataDir = resolveLicoPactiumDataDir(input.userDataPath || input.dataDir || "");
  const pactiumRuntime = normalizeLicoPactiumRuntime({
    dataDir,
    pactiumRuntime: input.pactiumRuntime || input.runtime
  });
  return {
    ...input,
    userDataPath: dataDir,
    dataDir,
    pactiumRuntime,
    [OWNS_PACTIUM_RUNTIME]: ownsPactiumRuntime
  };
}

async function closeOwnedRuntime(normalized) {
  if (normalized?.[OWNS_PACTIUM_RUNTIME]) {
    await normalized.pactiumRuntime.close?.();
  }
}

async function withCheckpointProjectionRuntime(input, task) {
  const normalized = withRuntime(input);
  try {
    return await task(normalized);
  } finally {
    await closeOwnedRuntime(normalized);
  }
}

function createNode({
  nodeId,
  parentId = "",
  label = "",
  status = "running",
  cursor = {},
  totals = {},
  metadata = {},
  error = "",
  at = nowIso()
} = {}) {
  const normalizedStatus = normalizeStatus(status);
  return {
    nodeId: normalizeNodeId(nodeId),
    parentId: parentId ? normalizeNodeId(parentId, "") : "",
    label: text(label, normalizeNodeId(nodeId)),
    status: normalizedStatus,
    cursor: asObject(cursor),
    totals: asObject(totals),
    metadata: asObject(metadata),
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    completedAt: ["completed", "failed", "skipped"].includes(normalizedStatus) ? at : "",
    error: text(error)
  };
}

function appendEvent(tree, {
  type = "checkpoint.event",
  nodeId = "",
  message = "",
  data = {},
  envelope = null
} = {}) {
  const at = nowIso();
  tree.events.push({
    eventId: eventId(type),
    at,
    type,
    nodeId: nodeId ? normalizeNodeId(nodeId, "") : "",
    message: text(message),
    data: asObject(data),
    pactium: envelope ? {
      envelopeId: envelope.envelopeId,
      outcomeId: envelope.factId,
      ledgerEventId: envelope.factRef?.ledgerEventId || "",
      ledgerIndex: envelope.factRef?.ledgerIndex ?? -1
    } : null
  });
  tree.updatedAt = at;
}

function createTree(input = {}, attempt = 1) {
  const at = nowIso();
  const rootNodeId = normalizeNodeId(input.rootNodeId || "root");
  const root = createNode({
    nodeId: rootNodeId,
    label: input.rootLabel || "Root",
    status: "running",
    metadata: input.rootMetadata || {},
    at
  });
  const tree = {
    protocol: PACTIUM_PROTOCOL,
    schema: PACTIUM_SCHEMA_VERSION,
    pactiumPackageVersion: PACTIUM_PACKAGE_VERSION,
    provider: CHECKPOINT_TREE_PROJECTION_PROVIDER,
    treeType: TREE_TYPE,
    protocolVersion: PACTIUM_PROTOCOL,
    treeId: text(input.treeId),
    kind: text(input.kind),
    ownerId: text(input.ownerId),
    status: "running",
    inputHash: text(input.inputHash),
    resumePolicy: asObject(input.resumePolicy),
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    completedAt: "",
    failedAt: "",
    attempt,
    rootNodeId,
    metadata: asObject(input.metadata),
    nodes: {
      [rootNodeId]: root
    },
    events: []
  };
  appendEvent(tree, {
    type: "checkpoint.tree.started",
    nodeId: rootNodeId,
    message: input.message || "Checkpoint tree started."
  });
  return tree;
}

function isCurrentTree(value, treeId = "") {
  return value &&
    typeof value === "object" &&
    value.protocol === PACTIUM_PROTOCOL &&
    value.schema === PACTIUM_SCHEMA_VERSION &&
    value.treeType === TREE_TYPE &&
    (!treeId || value.treeId === treeId) &&
    value.nodes &&
    typeof value.nodes === "object";
}

function shouldResetTree(existing, input = {}) {
  const mode = text(input.resumePolicy?.mode || "");
  if (mode === "resume-after-reset" || mode === "reset" || mode === "cold") return true;
  const ownerId = text(input.ownerId);
  const inputHash = text(input.inputHash);
  return Boolean((ownerId && ownerId !== existing.ownerId) || (inputHash && inputHash !== existing.inputHash));
}

function descendantsFor(tree, nodeId) {
  const nodes = Object.values(asObject(tree.nodes));
  const selected = [];
  const visited = new Set();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    const node = tree.nodes[current];
    if (!node) continue;
    visited.add(current);
    selected.push(node);
    for (const candidate of nodes) {
      if (candidate.parentId === current && !visited.has(candidate.nodeId)) {
        queue.push(candidate.nodeId);
      }
    }
  }
  return selected;
}

function pathFor(tree, nodeId) {
  const steps = [];
  const visited = new Set();
  let current = tree.nodes[nodeId]?.parentId || "";
  while (current && !visited.has(current)) {
    const node = tree.nodes[current];
    if (!node) break;
    visited.add(current);
    steps.push(node);
    current = node.parentId;
  }
  return steps;
}

function byStatus(nodes) {
  return nodes.reduce((result, node) => {
    const status = text(node.status, "unknown");
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
}


function nodeFieldChanges(fromNode = {}, toNode = {}) {
  return ["label", "status", "cursor", "totals", "metadata", "error"]
    .filter((field) => stableJson(fromNode[field]) !== stableJson(toNode[field]))
    .map((field) => ({
      field,
      before: fromNode[field] ?? null,
      after: toNode[field] ?? null
    }));
}

async function loadTreeIds(runtime) {
  return asArray(await runtime.storage.getProtocolObject(INDEX_SCOPE, INDEX_KEY, []));
}

async function saveTreeIds(runtime, treeIds) {
  await runtime.storage.putProtocolObject(INDEX_SCOPE, INDEX_KEY, [...new Set(asArray(treeIds).map(text).filter(Boolean))]);
}

function isTerminalTreeStatus(status) {
  return ["completed", "cancelled"].includes(text(status));
}

function checkpointProjectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function saveTree(runtime, tree, { allowTerminalOverwrite = false } = {}) {
  if (!runtime.storage.inMemory && typeof runtime.storage.clearCache === "function") runtime.storage.clearCache();
  const current = await runtime.storage.getProtocolObject(TREE_SCOPE, tree.treeId, null);
  if (
    isCurrentTree(current, tree.treeId) &&
    isTerminalTreeStatus(current.status) &&
    !isTerminalTreeStatus(tree.status) &&
    !allowTerminalOverwrite
  ) {
    throw checkpointProjectionError(
      "checkpoint_tree_terminal",
      "A terminal checkpoint tree cannot be replaced by a non-terminal projection."
    );
  }
  await runtime.storage.putProtocolObject(TREE_SCOPE, tree.treeId, tree);
  const treeIds = await loadTreeIds(runtime);
  if (!treeIds.includes(tree.treeId)) {
    treeIds.push(tree.treeId);
    await saveTreeIds(runtime, treeIds);
  }
  return tree;
}

async function recordCheckpointOperation(runtime, tree, operationId, result = {}) {
  return runtime.core.recordOperation({
    operationId,
    workspaceId: text(tree.ownerId || tree.kind || "checkpoint"),
    input: {
      treeId: tree.treeId,
      kind: tree.kind,
      ownerId: tree.ownerId
    },
    result: {
      treeId: tree.treeId,
      status: tree.status,
      ...asObject(result)
    },
    stateMutations: [{
      action: "put",
      key: `checkpoint/${tree.treeId}`,
      value: checkpointTreeSummary(tree),
      metadata: {
        operationId,
        treeId: tree.treeId
      }
    }]
  });
}

export function checkpointTreeId(kind, ...parts) {
  return serverToken("checkpoint_tree", kind, ...parts);
}

export async function loadCheckpointTree(input = {}) {
  return withCheckpointProjectionRuntime(input, async (normalized) => {
    try {
      assertServerToken(normalized.treeId, "checkpoint_tree");
    } catch {
      return null;
    }
    const tree = await normalized.pactiumRuntime.storage.getProtocolObject(TREE_SCOPE, normalized.treeId, null);
    return isCurrentTree(tree, normalized.treeId) ? tree : null;
  });
}

export async function listCheckpointTrees(input = {}) {
  return withCheckpointProjectionRuntime(input, async (normalized) => {
    const treeIds = await loadTreeIds(normalized.pactiumRuntime);
    const trees = [];
    for (const treeId of treeIds) {
      const tree = await normalized.pactiumRuntime.storage.getProtocolObject(TREE_SCOPE, treeId, null);
      if (!isCurrentTree(tree)) continue;
      if (normalized.kind && tree.kind !== normalized.kind) continue;
      if (normalized.ownerId && tree.ownerId !== normalized.ownerId) continue;
      trees.push(tree);
    }
    trees.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    const limit = Math.max(1, Math.min(Number(normalized.limit || 100), 1000));
    return trees.slice(0, limit).map(checkpointTreeSummary);
  });
}

export function checkpointTreeSummary(tree = {}) {
  const nodes = Object.values(asObject(tree.nodes));
  return {
    protocol: PACTIUM_PROTOCOL,
    schema: PACTIUM_SCHEMA_VERSION,
    provider: CHECKPOINT_TREE_PROJECTION_PROVIDER,
    treeId: text(tree.treeId),
    kind: text(tree.kind),
    ownerId: text(tree.ownerId),
    status: text(tree.status),
    inputHash: text(tree.inputHash),
    rootNodeId: text(tree.rootNodeId),
    attempt: Number(tree.attempt || 0),
    nodeCount: nodes.length,
    byStatus: byStatus(nodes),
    createdAt: text(tree.createdAt),
    updatedAt: text(tree.updatedAt),
    completedAt: text(tree.completedAt),
    failedAt: text(tree.failedAt)
  };
}

async function startCheckpointTreeUnlocked(input = {}) {
  const normalized = withRuntime(input);
  assertServerToken(normalized.treeId, "checkpoint_tree");
  const existing = await loadCheckpointTree(normalized);
  let tree;
  let allowTerminalOverwrite = false;
  if (!existing) {
    tree = createTree(normalized, 1);
  } else if (shouldResetTree(existing, normalized)) {
    allowTerminalOverwrite = true;
    tree = createTree(normalized, Number(existing.attempt || 0) + 1);
    tree.events = [];
    appendEvent(tree, {
      type: "checkpoint.tree.reset",
      nodeId: tree.rootNodeId,
      message: "Checkpoint tree reset.",
      data: { previousAttempt: existing.attempt || 0 }
    });
    appendEvent(tree, {
      type: "checkpoint.tree.resumed",
      nodeId: tree.rootNodeId,
      message: "Checkpoint tree resumed after reset."
    });
  } else if (isTerminalTreeStatus(existing.status)) {
    return existing;
  } else {
    tree = {
      ...existing,
      attempt: Number(existing.attempt || 0) + 1,
      status: "running",
      failedAt: "",
      completedAt: "",
      resumePolicy: {
        ...asObject(existing.resumePolicy),
        ...asObject(normalized.resumePolicy)
      },
      metadata: {
        ...asObject(existing.metadata),
        ...asObject(normalized.metadata)
      }
    };
    const rootNodeId = normalizeNodeId(normalized.rootNodeId || tree.rootNodeId || "root");
    tree.rootNodeId = rootNodeId;
    tree.nodes[rootNodeId] ||= createNode({
      nodeId: rootNodeId,
      label: normalized.rootLabel || "Root",
      at: tree.createdAt || nowIso()
    });
    appendEvent(tree, {
      type: "checkpoint.tree.resumed",
      nodeId: rootNodeId,
      message: "Checkpoint tree resumed."
    });
  }
  const envelope = await recordCheckpointOperation(normalized.pactiumRuntime, tree, "checkpoint.tree.start", {
    attempt: tree.attempt
  });
  tree.events[tree.events.length - 1].pactium = {
    envelopeId: envelope.envelopeId,
    outcomeId: envelope.factId,
    ledgerEventId: envelope.factRef?.ledgerEventId || "",
    ledgerIndex: envelope.factRef?.ledgerIndex ?? -1
  };
  return saveTree(normalized.pactiumRuntime, tree, { allowTerminalOverwrite });
}

export async function startCheckpointTree(input = {}) {
  return withCheckpointProjectionMutation(input, startCheckpointTreeUnlocked);
}

async function upsertCheckpointNodeUnlocked(input = {}) {
  const normalized = withRuntime(input);
  const tree = await loadCheckpointTree(normalized);
  if (!tree) throw new Error("checkpoint tree is missing");
  if (isTerminalTreeStatus(tree.status)) {
    throw checkpointProjectionError(
      "checkpoint_tree_terminal",
      "A terminal checkpoint tree does not accept node updates."
    );
  }
  const at = nowIso();
  const nodeId = normalizeNodeId(normalized.nodeId);
  const parentId = normalized.parentId ? normalizeNodeId(normalized.parentId, "") : "";
  const status = normalizeStatus(normalized.status);
  const previous = tree.nodes[nodeId] || {};
  const node = {
    ...createNode({ nodeId, parentId, label: normalized.label || previous.label || nodeId, status, at }),
    ...previous,
    nodeId,
    parentId,
    label: text(normalized.label, previous.label || nodeId),
    status,
    cursor: {
      ...asObject(previous.cursor),
      ...asObject(normalized.cursor)
    },
    totals: {
      ...asObject(previous.totals),
      ...asObject(normalized.totals)
    },
    metadata: {
      ...asObject(previous.metadata),
      ...asObject(normalized.metadata)
    },
    error: text(normalized.error, previous.error || ""),
    updatedAt: at,
    startedAt: previous.startedAt || at,
    completedAt: ["completed", "failed", "skipped"].includes(status) ? at : (previous.completedAt || "")
  };
  tree.nodes[nodeId] = node;
  if (status === "failed") {
    tree.status = "failed";
    tree.failedAt = tree.failedAt || at;
  }
  const envelope = await recordCheckpointOperation(normalized.pactiumRuntime, tree, "checkpoint.node.upsert", {
    nodeId,
    status
  });
  appendEvent(tree, {
    type: normalized.eventType || "checkpoint.node.upserted",
    nodeId,
    message: normalized.message || "",
    data: {
      status,
      cursor: node.cursor,
      totals: node.totals
    },
    envelope
  });
  await saveTree(normalized.pactiumRuntime, tree);
  return node;
}

export async function upsertCheckpointNode(input = {}) {
  return withCheckpointProjectionMutation(input, upsertCheckpointNodeUnlocked);
}

async function finishCheckpointTreeUnlocked(input = {}) {
  const normalized = withRuntime(input);
  const tree = await loadCheckpointTree(normalized);
  if (!tree) throw new Error("checkpoint tree is missing");
  const at = nowIso();
  const status = normalizeTreeStatus(normalized.status);
  tree.status = status;
  tree.completedAt = at;
  if (status === "failed") tree.failedAt = tree.failedAt || at;
  tree.metadata = {
    ...asObject(tree.metadata),
    ...asObject(normalized.metadata)
  };
  const root = tree.nodes[tree.rootNodeId];
  if (root) {
    root.status = status === "failed" ? "failed" : "completed";
    root.updatedAt = at;
    root.completedAt = root.completedAt || at;
  }
  const envelope = await recordCheckpointOperation(normalized.pactiumRuntime, tree, "checkpoint.tree.finish", {
    status
  });
  appendEvent(tree, {
    type: "checkpoint.tree.finished",
    nodeId: tree.rootNodeId,
    message: normalized.message || "",
    data: { status },
    envelope
  });
  return saveTree(normalized.pactiumRuntime, tree);
}

export async function finishCheckpointTree(input = {}) {
  return withCheckpointProjectionMutation(input, finishCheckpointTreeUnlocked);
}

export async function queryCheckpointScope(input = {}) {
  return withCheckpointProjectionRuntime(input, async (normalized) => {
    const tree = await loadCheckpointTree(normalized);
    if (!tree) throw new Error("checkpoint tree is missing");
    const nodeId = normalizeNodeId(normalized.nodeId || tree.rootNodeId || "root");
    if (!tree.nodes[nodeId]) throw new Error("checkpoint node is missing");
    const nodes = descendantsFor(tree, nodeId);
    const nodeIds = new Set(nodes.map((node) => node.nodeId));
    return {
      treeId: tree.treeId,
      nodeId,
      target: tree.nodes[nodeId],
      nodes,
      path: pathFor(tree, nodeId),
      events: tree.events.filter((event) => !event.nodeId || event.nodeId === nodeId || nodeIds.has(event.nodeId)),
      affectedNodeCount: nodes.length,
      byStatus: byStatus(nodes)
    };
  });
}

export async function previewCheckpointRestore(input = {}) {
  return withCheckpointProjectionRuntime(input, async (normalized) => {
    const scope = await queryCheckpointScope(normalized);
    return {
      dryRun: true,
      applied: false,
      canApply: true,
      treeId: scope.treeId,
      nodeId: scope.nodeId,
      reason: text(normalized.reason),
      mode: text(normalized.mode, "restore-marker"),
      target: scope.target,
      scope,
      actions: [{
        action: "append_restore_marker",
        treeId: scope.treeId,
        nodeId: scope.nodeId,
        dryRun: true
      }]
    };
  });
}

async function restoreCheckpointTreeUnlocked(input = {}) {
  const normalized = withRuntime(input);
  const tree = await loadCheckpointTree(normalized);
  if (!tree) throw new Error("checkpoint tree is missing");
  const nodeId = normalizeNodeId(normalized.nodeId || tree.rootNodeId || "root");
  if (!tree.nodes[nodeId]) throw new Error("checkpoint node is missing");
  const restoreId = serverToken("checkpoint_restore", tree.treeId, nodeId, nowIso(), randomUUID());
  const markerNodeId = `restore:${nodeId}:${restoreId}`;
  const marker = createNode({
    nodeId: markerNodeId,
    parentId: nodeId,
    label: `Restore ${nodeId}`,
    status: "completed",
    metadata: {
      restoreId,
      reason: text(normalized.reason),
      actor: text(normalized.actor),
      mode: text(normalized.mode, "restore-marker")
    }
  });
  tree.nodes[markerNodeId] = marker;
  tree.metadata = {
    ...asObject(tree.metadata),
    lastRestore: {
      nodeId,
      reason: text(normalized.reason),
      actor: text(normalized.actor),
      mode: text(normalized.mode, "restore-marker"),
      restoreId,
      at: marker.createdAt
    }
  };
  const envelope = await recordCheckpointOperation(normalized.pactiumRuntime, tree, "checkpoint.tree.restore", {
    nodeId,
    restoreId
  });
  appendEvent(tree, {
    type: "checkpoint.restored",
    nodeId,
    message: text(normalized.reason),
    data: tree.metadata.lastRestore,
    envelope
  });
  await saveTree(normalized.pactiumRuntime, tree);
  return {
    dryRun: false,
    applied: true,
    treeId: tree.treeId,
    nodeId,
    restoreId,
    markerNodeId,
    summary: checkpointTreeSummary(tree),
    actions: [{
      action: "append_restore_marker",
      treeId: tree.treeId,
      nodeId,
      markerNodeId,
      dryRun: false
    }]
  };
}

export async function restoreCheckpointTree(input = {}) {
  return withCheckpointProjectionMutation(input, restoreCheckpointTreeUnlocked);
}

export async function diffCheckpointTree(input = {}) {
  return withCheckpointProjectionRuntime(input, async (normalized) => {
    const fromTreeId = normalized.fromTreeId || normalized.treeId;
    const toTreeId = normalized.toTreeId || normalized.treeId;
    const fromTree = await loadCheckpointTree({ ...normalized, treeId: fromTreeId });
    const toTree = await loadCheckpointTree({ ...normalized, treeId: toTreeId });
    if (!fromTree || !toTree) throw new Error("checkpoint tree is missing");
    const fromNodeId = normalized.fromNodeId ? normalizeNodeId(normalized.fromNodeId) : (fromTree.rootNodeId || "root");
    const toNodeId = normalized.toNodeId ? normalizeNodeId(normalized.toNodeId) : (toTree.rootNodeId || "root");
    if (!fromTree.nodes[fromNodeId] || !toTree.nodes[toNodeId]) {
      throw new Error("checkpoint diff node is missing");
    }
    const fromScope = await queryCheckpointScope({ ...normalized, treeId: fromTree.treeId, nodeId: fromNodeId });
    const toScope = await queryCheckpointScope({ ...normalized, treeId: toTree.treeId, nodeId: toNodeId });
    const fromSummary = checkpointTreeSummary(fromTree);
    const toSummary = checkpointTreeSummary(toTree);
    const fieldChanges = ["kind", "ownerId", "status", "inputHash", "nodeCount"]
      .filter((field) => String(fromSummary[field] ?? "") !== String(toSummary[field] ?? ""));
    const changes = [
      ...fieldChanges.map((field) => ({
        field,
        before: fromSummary[field] ?? null,
        after: toSummary[field] ?? null
      })),
      ...nodeFieldChanges(fromScope.target, toScope.target)
    ];
    return {
      treeId: toTree.treeId,
      changed: changes.length > 0 || fromScope.affectedNodeCount !== toScope.affectedNodeCount,
      from: fromScope,
      to: toScope,
      changes,
      summary: {
        fieldChangeCount: fieldChanges.length,
        fieldChanges,
        affectedNodeDelta: toScope.affectedNodeCount - fromScope.affectedNodeCount
      }
    };
  });
}

async function deleteCheckpointTreeUnlocked(input = {}) {
  const normalized = withRuntime(input);
  assertServerToken(normalized.treeId, "checkpoint_tree");
  const tree = await loadCheckpointTree(normalized);
  if (tree) {
    await recordCheckpointOperation(normalized.pactiumRuntime, tree, "checkpoint.tree.delete", {
      deleted: true
    });
  }
  if (typeof normalized.pactiumRuntime.storage.deleteProtocolObject === "function") {
    await normalized.pactiumRuntime.storage.deleteProtocolObject(TREE_SCOPE, normalized.treeId);
  } else {
    await normalized.pactiumRuntime.storage.putProtocolObject(TREE_SCOPE, normalized.treeId, null);
  }
  const treeIds = (await loadTreeIds(normalized.pactiumRuntime)).filter((treeId) => treeId !== normalized.treeId);
  await saveTreeIds(normalized.pactiumRuntime, treeIds);
  return { ok: true, treeId: normalized.treeId };
}

export async function deleteCheckpointTree(input = {}) {
  return withCheckpointProjectionMutation(input, deleteCheckpointTreeUnlocked);
}
