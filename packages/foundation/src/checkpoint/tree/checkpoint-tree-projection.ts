import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import { randomUUID } from "node:crypto";
import {
  PACTIUM_PACKAGE_VERSION,
  PACTIUM_PROTOCOL,
  PACTIUM_SCHEMA_VERSION
} from "pactium";
import { assertServerToken, serverToken } from "#meshrix/client-strings";
import { queueStateMutation } from "../../storage/state-coordinator.ts";
import {
  normalizeMeshrixPactiumRuntime,
  resolveMeshrixPactiumDataDir
} from "./pactium-substrate-preflight.ts";

export const CHECKPOINT_TREE_PROJECTION_PROTOCOL: any = PACTIUM_PROTOCOL;
export const CHECKPOINT_TREE_PROJECTION_PROVIDER: any = "pactium.checkpoint-projection";

const TREE_SCOPE: any = "meshrix-checkpoint-tree";
const INDEX_SCOPE: any = "meshrix-checkpoint-tree-index";
const INDEX_KEY: any = "tree-ids";
const TREE_TYPE: any = "meshrix.checkpoint-tree";
const OWNS_PACTIUM_RUNTIME: any = Symbol("ownsPactiumRuntime");

const VALID_NODE_STATUS: any = new Set<any>(["pending", "running", "paused", "completed", "failed", "skipped"]);
const VALID_TREE_STATUS: any = new Set<any>(["running", "completed", "failed", "paused", "cancelled"]);
async function withCheckpointProjectionMutation(input?: any, task?: any) : Promise<any> {
  const normalized: any = withRuntime(input);
  const { core, storage } = normalized.pactiumRuntime;
  try {
    return await queueStateMutation(`pactium-storage:${normalized.dataDir}`, async () : Promise<any> => {
      const mutate: any = async () : Promise<any> => {
        if (!storage.inMemory) storage.clearCache?.();
        return task(normalized);
      };
      await storage.initialize?.();
      const backend: any = text(storage.selectedStorageBackend || storage.storageBackend || "").toLowerCase();
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

function nowIso() : any {
  return new Date().toISOString();
}

function asObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

function text(value?: any, fallback: any = "") : any {
  const normalized: any = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeNodeId(value?: any, fallback: any = "root") : any {
  return text(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "") || fallback;
}

function normalizeStatus(value?: any, fallback: any = "running") : any {
  const status: any = text(value, fallback).toLowerCase();
  return VALID_NODE_STATUS.has(status) ? status : fallback;
}

function normalizeTreeStatus(value?: any, fallback: any = "completed") : any {
  const status: any = text(value, fallback).toLowerCase();
  return VALID_TREE_STATUS.has(status) ? status : fallback;
}

function eventId(type: any = "checkpoint.event") : any {
  return serverToken("checkpoint_event", type, nowIso(), randomUUID());
}

function withRuntime(input: Record<string, any> = {}) : any {
  const ownsPactiumRuntime: any = !input.pactiumRuntime && !input.runtime;
  const dataDir: any = resolveMeshrixPactiumDataDir(input.userDataPath || input.dataDir || "");
  const pactiumRuntime: any = normalizeMeshrixPactiumRuntime({
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

async function closeOwnedRuntime(normalized?: any) : Promise<any> {
  if (normalized?.[OWNS_PACTIUM_RUNTIME]) {
    await normalized.pactiumRuntime.close?.();
  }
}

async function withCheckpointProjectionRuntime(input?: any, task?: any) : Promise<any> {
  const normalized: any = withRuntime(input);
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
}: Record<string, any> = {}) : any {
  const normalizedStatus: any = normalizeStatus(status);
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

function appendEvent(tree?: any, {
  type = "checkpoint.event",
  nodeId = "",
  message = "",
  data = {},
  envelope = null
}: Record<string, any> = {}) : any {
  const at: any = nowIso();
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

function createTree(input: Record<string, any> = {}, attempt: any = 1) : any {
  const at: any = nowIso();
  const rootNodeId: any = normalizeNodeId(input.rootNodeId || "root");
  const root: any = createNode({
    nodeId: rootNodeId,
    label: input.rootLabel || "Root",
    status: "running",
    metadata: input.rootMetadata || {},
    at
  });
  const tree: Record<string, any> = {
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

function isCurrentTree(value?: any, treeId: any = "") : any {
  return value &&
    typeof value === "object" &&
    value.protocol === PACTIUM_PROTOCOL &&
    value.schema === PACTIUM_SCHEMA_VERSION &&
    value.treeType === TREE_TYPE &&
    (!treeId || value.treeId === treeId) &&
    value.nodes &&
    typeof value.nodes === "object";
}

function shouldResetTree(existing?: any, input: Record<string, any> = {}) : any {
  const mode: any = text(input.resumePolicy?.mode || "");
  if (mode === "resume-after-reset" || mode === "reset" || mode === "cold") return true;
  const ownerId: any = text(input.ownerId);
  const inputHash: any = text(input.inputHash);
  return Boolean((ownerId && ownerId !== existing.ownerId) || (inputHash && inputHash !== existing.inputHash));
}

function descendantsFor(tree?: any, nodeId?: any) : any {
  const nodes: any = (Object.values(asObject(tree.nodes)) as any[]);
  const selected: any[] = [];
  const visited: any = new Set<any>();
  const queue: any[] = [nodeId];
  while (queue.length > 0) {
    const current: any = queue.shift();
    if (!current || visited.has(current)) continue;
    const node: any = tree.nodes[current];
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

function pathFor(tree?: any, nodeId?: any) : any {
  const steps: any[] = [];
  const visited: any = new Set<any>();
  let current: any = tree.nodes[nodeId]?.parentId || "";
  while (current && !visited.has(current)) {
    const node: any = tree.nodes[current];
    if (!node) break;
    visited.add(current);
    steps.push(node);
    current = node.parentId;
  }
  return steps;
}

function byStatus(nodes?: any) : any {
  return nodes.reduce((result?: any, node?: any) : any => {
    const status: any = text(node.status, "unknown");
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
}


function nodeFieldChanges(fromNode: Record<string, any> = {}, toNode: Record<string, any> = {}) : any {
  return ["label", "status", "cursor", "totals", "metadata", "error"]
    .filter((field?: any) : any => stableJson(fromNode[field]) !== stableJson(toNode[field]))
    .map((field?: any) : any => ({
      field,
      before: fromNode[field] ?? null,
      after: toNode[field] ?? null
    }));
}

async function loadTreeIds(runtime?: any) : Promise<any> {
  return asArray(await runtime.storage.getProtocolObject(INDEX_SCOPE, INDEX_KEY, []));
}

async function saveTreeIds(runtime?: any, treeIds?: any) : Promise<any> {
  await runtime.storage.putProtocolObject(INDEX_SCOPE, INDEX_KEY, [...new Set<any>(asArray(treeIds).map(text).filter(Boolean))]);
}

function isTerminalTreeStatus(status?: any) : any {
  return ["completed", "cancelled"].includes(text(status));
}

function checkpointProjectionError(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  return error;
}

function checkpointNodeReplayProjection(node: Record<string, any> = {}) : any {
  return {
    parentId: text(node.parentId),
    label: text(node.label),
    status: normalizeStatus(node.status),
    cursor: asObject(node.cursor),
    totals: asObject(node.totals),
    metadata: asObject(node.metadata),
    error: text(node.error)
  };
}

async function saveTree(runtime?: any, tree?: any, { allowTerminalOverwrite = false }: Record<string, any> = {}) : Promise<any> {
  if (!runtime.storage.inMemory && typeof runtime.storage.clearCache === "function") runtime.storage.clearCache();
  const current: any = await runtime.storage.getProtocolObject(TREE_SCOPE, tree.treeId, null);
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
  const treeIds: any = await loadTreeIds(runtime);
  if (!treeIds.includes(tree.treeId)) {
    treeIds.push(tree.treeId);
    await saveTreeIds(runtime, treeIds);
  }
  return tree;
}

async function recordCheckpointOperation(runtime?: any, tree?: any, operationId?: any, result: Record<string, any> = {}) : Promise<any> {
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

export function checkpointTreeId(kind: any, ...parts: any[]) : any {
  return serverToken("checkpoint_tree", kind, ...parts);
}

export async function loadCheckpointTree(input: Record<string, any> = {}) : Promise<any> {
  return withCheckpointProjectionRuntime(input, async (normalized?: any) : Promise<any> => {
    try {
      assertServerToken(normalized.treeId, "checkpoint_tree");
    } catch {
      return null;
    }
    const tree: any = await normalized.pactiumRuntime.storage.getProtocolObject(TREE_SCOPE, normalized.treeId, null);
    return isCurrentTree(tree, normalized.treeId) ? tree : null;
  });
}

export async function listCheckpointTrees(input: Record<string, any> = {}) : Promise<any> {
  return withCheckpointProjectionRuntime(input, async (normalized?: any) : Promise<any> => {
    const treeIds: any = await loadTreeIds(normalized.pactiumRuntime);
    const trees: any[] = [];
    for (const treeId of treeIds) {
      const tree: any = await normalized.pactiumRuntime.storage.getProtocolObject(TREE_SCOPE, treeId, null);
      if (!isCurrentTree(tree)) continue;
      if (normalized.kind && tree.kind !== normalized.kind) continue;
      if (normalized.ownerId && tree.ownerId !== normalized.ownerId) continue;
      trees.push(tree);
    }
    trees.sort((left?: any, right?: any) : any => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    const limit: any = Math.max(1, Math.min(Number(normalized.limit || 100), 1000));
    return trees.slice(0, limit).map(checkpointTreeSummary);
  });
}

export function checkpointTreeSummary(tree: Record<string, any> = {}) : any {
  const nodes: any = (Object.values(asObject(tree.nodes)) as any[]);
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

async function startCheckpointTreeUnlocked(input: Record<string, any> = {}) : Promise<any> {
  const normalized: any = withRuntime(input);
  assertServerToken(normalized.treeId, "checkpoint_tree");
  const existing: any = await loadCheckpointTree(normalized);
  let tree: any;
  let allowTerminalOverwrite: any = false;
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
    const rootNodeId: any = normalizeNodeId(normalized.rootNodeId || tree.rootNodeId || "root");
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
  const envelope: any = await recordCheckpointOperation(normalized.pactiumRuntime, tree, "checkpoint.tree.start", {
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

export async function startCheckpointTree(input: Record<string, any> = {}) : Promise<any> {
  return withCheckpointProjectionMutation(input, startCheckpointTreeUnlocked);
}

async function upsertCheckpointNodeUnlocked(input: Record<string, any> = {}) : Promise<any> {
  const normalized: any = withRuntime(input);
  const tree: any = await loadCheckpointTree(normalized);
  if (!tree) throw new Error("checkpoint tree is missing");
  if (isTerminalTreeStatus(tree.status)) {
    throw checkpointProjectionError(
      "checkpoint_tree_terminal",
      "A terminal checkpoint tree does not accept node updates."
    );
  }
  const at: any = nowIso();
  const nodeId: any = normalizeNodeId(normalized.nodeId);
  const parentId: any = normalized.parentId ? normalizeNodeId(normalized.parentId, "") : "";
  const status: any = normalizeStatus(normalized.status);
  const previous: any = tree.nodes[nodeId] || {};
  const idempotencyKey: any = text(normalized.idempotencyKey);
  if (idempotencyKey && previous.nodeId) {
    const previousIdempotencyKey: any = text(previous.idempotencyKey);
    if (!previousIdempotencyKey) {
      throw checkpointProjectionError(
        "checkpoint_node_idempotency_unbound",
        "Existing checkpoint node has no adoptable idempotency binding."
      );
    }
    const requestedProjection: any = checkpointNodeReplayProjection({
      parentId,
      label: normalized.label || previous.label || nodeId,
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
      error: text(normalized.error, previous.error || "")
    });
    if (
      previousIdempotencyKey !== idempotencyKey ||
      stableJson(checkpointNodeReplayProjection(previous)) !==
        stableJson(requestedProjection)
    ) {
      throw checkpointProjectionError(
        "checkpoint_node_idempotency_conflict",
        "Checkpoint node idempotency key is already bound to another projection."
      );
    }
    return previous;
  }
  const node: Record<string, any> = {
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
    idempotencyKey:
      idempotencyKey || text(previous.idempotencyKey),
    updatedAt: at,
    startedAt: previous.startedAt || at,
    completedAt: ["completed", "failed", "skipped"].includes(status) ? at : (previous.completedAt || "")
  };
  tree.nodes[nodeId] = node;
  if (status === "failed") {
    tree.status = "failed";
    tree.failedAt = tree.failedAt || at;
  }
  const envelope: any = await recordCheckpointOperation(normalized.pactiumRuntime, tree, "checkpoint.node.upsert", {
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

export async function upsertCheckpointNode(input: Record<string, any> = {}) : Promise<any> {
  return withCheckpointProjectionMutation(input, upsertCheckpointNodeUnlocked);
}

async function finishCheckpointTreeUnlocked(input: Record<string, any> = {}) : Promise<any> {
  const normalized: any = withRuntime(input);
  const tree: any = await loadCheckpointTree(normalized);
  if (!tree) throw new Error("checkpoint tree is missing");
  const at: any = nowIso();
  const status: any = normalizeTreeStatus(normalized.status);
  tree.status = status;
  tree.completedAt = at;
  if (status === "failed") tree.failedAt = tree.failedAt || at;
  tree.metadata = {
    ...asObject(tree.metadata),
    ...asObject(normalized.metadata)
  };
  const root: any = tree.nodes[tree.rootNodeId];
  if (root) {
    root.status = status === "failed" ? "failed" : "completed";
    root.updatedAt = at;
    root.completedAt = root.completedAt || at;
  }
  const envelope: any = await recordCheckpointOperation(normalized.pactiumRuntime, tree, "checkpoint.tree.finish", {
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

export async function finishCheckpointTree(input: Record<string, any> = {}) : Promise<any> {
  return withCheckpointProjectionMutation(input, finishCheckpointTreeUnlocked);
}

export async function queryCheckpointScope(input: Record<string, any> = {}) : Promise<any> {
  return withCheckpointProjectionRuntime(input, async (normalized?: any) : Promise<any> => {
    const tree: any = await loadCheckpointTree(normalized);
    if (!tree) throw new Error("checkpoint tree is missing");
    const nodeId: any = normalizeNodeId(normalized.nodeId || tree.rootNodeId || "root");
    if (!tree.nodes[nodeId]) throw new Error("checkpoint node is missing");
    const nodes: any = descendantsFor(tree, nodeId);
    const nodeIds: any = new Set<any>(nodes.map((node?: any) : any => node.nodeId));
    return {
      treeId: tree.treeId,
      nodeId,
      target: tree.nodes[nodeId],
      nodes,
      path: pathFor(tree, nodeId),
      events: tree.events.filter((event?: any) : any => !event.nodeId || event.nodeId === nodeId || nodeIds.has(event.nodeId)),
      affectedNodeCount: nodes.length,
      byStatus: byStatus(nodes)
    };
  });
}

export async function previewCheckpointRestore(input: Record<string, any> = {}) : Promise<any> {
  return withCheckpointProjectionRuntime(input, async (normalized?: any) : Promise<any> => {
    const scope: any = await queryCheckpointScope(normalized);
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

async function restoreCheckpointTreeUnlocked(input: Record<string, any> = {}) : Promise<any> {
  const normalized: any = withRuntime(input);
  const tree: any = await loadCheckpointTree(normalized);
  if (!tree) throw new Error("checkpoint tree is missing");
  const nodeId: any = normalizeNodeId(normalized.nodeId || tree.rootNodeId || "root");
  if (!tree.nodes[nodeId]) throw new Error("checkpoint node is missing");
  const restoreId: any = serverToken("checkpoint_restore", tree.treeId, nodeId, nowIso(), randomUUID());
  const markerNodeId: any = `restore:${nodeId}:${restoreId}`;
  const marker: any = createNode({
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
  const envelope: any = await recordCheckpointOperation(normalized.pactiumRuntime, tree, "checkpoint.tree.restore", {
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

export async function restoreCheckpointTree(input: Record<string, any> = {}) : Promise<any> {
  return withCheckpointProjectionMutation(input, restoreCheckpointTreeUnlocked);
}

export async function diffCheckpointTree(input: Record<string, any> = {}) : Promise<any> {
  return withCheckpointProjectionRuntime(input, async (normalized?: any) : Promise<any> => {
    const fromTreeId: any = normalized.fromTreeId || normalized.treeId;
    const toTreeId: any = normalized.toTreeId || normalized.treeId;
    const fromTree: any = await loadCheckpointTree({ ...normalized, treeId: fromTreeId });
    const toTree: any = await loadCheckpointTree({ ...normalized, treeId: toTreeId });
    if (!fromTree || !toTree) throw new Error("checkpoint tree is missing");
    const fromNodeId: any = normalized.fromNodeId ? normalizeNodeId(normalized.fromNodeId) : (fromTree.rootNodeId || "root");
    const toNodeId: any = normalized.toNodeId ? normalizeNodeId(normalized.toNodeId) : (toTree.rootNodeId || "root");
    if (!fromTree.nodes[fromNodeId] || !toTree.nodes[toNodeId]) {
      throw new Error("checkpoint diff node is missing");
    }
    const fromScope: any = await queryCheckpointScope({ ...normalized, treeId: fromTree.treeId, nodeId: fromNodeId });
    const toScope: any = await queryCheckpointScope({ ...normalized, treeId: toTree.treeId, nodeId: toNodeId });
    const fromSummary: any = checkpointTreeSummary(fromTree);
    const toSummary: any = checkpointTreeSummary(toTree);
    const fieldChanges: any = ["kind", "ownerId", "status", "inputHash", "nodeCount"]
      .filter((field?: any) : any => String(fromSummary[field] ?? "") !== String(toSummary[field] ?? ""));
    const changes: any[] = [
      ...fieldChanges.map((field?: any) : any => ({
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

async function deleteCheckpointTreeUnlocked(input: Record<string, any> = {}) : Promise<any> {
  const normalized: any = withRuntime(input);
  assertServerToken(normalized.treeId, "checkpoint_tree");
  const tree: any = await loadCheckpointTree(normalized);
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
  const treeIds: any = (await loadTreeIds(normalized.pactiumRuntime)).filter((treeId?: any) : any => treeId !== normalized.treeId);
  await saveTreeIds(normalized.pactiumRuntime, treeIds);
  return { ok: true, treeId: normalized.treeId };
}

export async function deleteCheckpointTree(input: Record<string, any> = {}) : Promise<any> {
  return withCheckpointProjectionMutation(input, deleteCheckpointTreeUnlocked);
}
