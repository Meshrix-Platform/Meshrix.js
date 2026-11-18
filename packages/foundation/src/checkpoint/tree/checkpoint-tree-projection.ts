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
} from "./pactium-runtime.ts";
import type { PactiumProofEnvelope, PactiumRecord } from "pactium";
import {
  type CheckpointEvent,
  type CheckpointNode,
  type CheckpointNodeStatus,
  type CheckpointProjectionInput,
  type CheckpointTree,
  type CheckpointTreeStatus,
  type CodedError,
  type MeshrixPactiumRuntime,
  type NormalizedCheckpointProjectionInput,
  isRecord,
  stringArray
} from "./types.ts";

export const CHECKPOINT_TREE_PROJECTION_PROTOCOL = PACTIUM_PROTOCOL;
export const CHECKPOINT_TREE_PROJECTION_PROVIDER = "pactium.checkpoint-projection";

const TREE_META_SCOPE = "meshrix-checkpoint-tree-meta";
const TREE_NODE_SCOPE = "meshrix-checkpoint-tree-node";
const TREE_CHILD_SCOPE = "meshrix-checkpoint-tree-child";
const TREE_EVENT_SCOPE = "meshrix-checkpoint-tree-event";
const TREE_EVENT_INDEX_SCOPE = "meshrix-checkpoint-tree-event-index";
const INDEX_SCOPE = "meshrix-checkpoint-tree-index";
const INDEX_KEY = "tree-ids";
const TREE_TYPE = "meshrix.checkpoint-tree";
const OWNS_PACTIUM_RUNTIME = Symbol("ownsPactiumRuntime");

const VALID_NODE_STATUS = new Set<CheckpointNodeStatus>(["pending", "running", "paused", "completed", "failed", "skipped"]);
const VALID_TREE_STATUS = new Set<CheckpointTreeStatus>(["running", "completed", "failed", "paused", "cancelled"]);
async function withCheckpointProjectionMutation<Result>(
  input: CheckpointProjectionInput,
  task: (input: NormalizedCheckpointProjectionInput) => Promise<Result>
): Promise<Result> {
  const normalized = withRuntime(input);
  const { core, storage } = normalized.pactiumRuntime;
  try {
    return await queueStateMutation(`pactium-storage:${normalized.dataDir}`, async () => {
      const mutate = async (): Promise<Result> => {
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

function nowIso(): string {
  return new Date().toISOString();
}

function asObject(value: unknown, fallback: PactiumRecord = {}): PactiumRecord {
  return isRecord(value) ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ""): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeNodeId(value: unknown, fallback = "root"): string {
  return text(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "") || fallback;
}

function normalizeStatus(value: unknown, fallback: CheckpointNodeStatus = "running"): CheckpointNodeStatus {
  const status = text(value, fallback).toLowerCase();
  return VALID_NODE_STATUS.has(status as CheckpointNodeStatus) ? status as CheckpointNodeStatus : fallback;
}

function normalizeTreeStatus(value: unknown, fallback: CheckpointTreeStatus = "completed"): CheckpointTreeStatus {
  const status = text(value, fallback).toLowerCase();
  return VALID_TREE_STATUS.has(status as CheckpointTreeStatus) ? status as CheckpointTreeStatus : fallback;
}

function eventId(type = "checkpoint.event"): string {
  return serverToken("checkpoint_event", type, nowIso(), randomUUID());
}

function withRuntime(input: CheckpointProjectionInput = {}): NormalizedCheckpointProjectionInput & { [OWNS_PACTIUM_RUNTIME]: boolean } {
  const ownsPactiumRuntime = !input.pactiumRuntime && !input.runtime;
  const dataDir = resolveMeshrixPactiumDataDir(input.userDataPath || input.dataDir || "");
  const pactiumRuntime = normalizeMeshrixPactiumRuntime({
    dataDir,
    pactiumRuntime: input.pactiumRuntime || input.runtime
  });
  return {
    ...input,
    userDataPath: dataDir,
    dataDir,
    pactiumRuntime,
    treeId: text(input.treeId),
    kind: text(input.kind),
    ownerId: text(input.ownerId),
    inputHash: text(input.inputHash),
    rootNodeId: text(input.rootNodeId),
    rootLabel: text(input.rootLabel),
    message: text(input.message),
    nodeId: text(input.nodeId),
    parentId: text(input.parentId),
    label: text(input.label),
    status: text(input.status),
    error: text(input.error),
    idempotencyKey: text(input.idempotencyKey),
    eventType: text(input.eventType),
    reason: text(input.reason),
    mode: text(input.mode),
    actor: text(input.actor),
    fromTreeId: text(input.fromTreeId),
    toTreeId: text(input.toTreeId),
    fromNodeId: text(input.fromNodeId),
    toNodeId: text(input.toNodeId),
    [OWNS_PACTIUM_RUNTIME]: ownsPactiumRuntime
  };
}

async function closeOwnedRuntime(normalized: NormalizedCheckpointProjectionInput & { [OWNS_PACTIUM_RUNTIME]?: boolean }): Promise<void> {
  if (normalized?.[OWNS_PACTIUM_RUNTIME]) {
    await normalized.pactiumRuntime.close?.();
  }
}

async function withCheckpointProjectionRuntime<Result>(
  input: CheckpointProjectionInput,
  task: (input: NormalizedCheckpointProjectionInput) => Promise<Result>
): Promise<Result> {
  const normalized = withRuntime(input);
  try {
    return await task(normalized);
  } finally {
    await closeOwnedRuntime(normalized);
  }
}

interface CreateNodeInput {
  nodeId?: unknown;
  parentId?: unknown;
  label?: unknown;
  status?: unknown;
  cursor?: unknown;
  totals?: unknown;
  metadata?: unknown;
  error?: unknown;
  at?: string;
}

interface AppendEventInput {
  type?: string;
  nodeId?: string;
  message?: string;
  data?: unknown;
  envelope?: PactiumProofEnvelope | null;
}

interface CheckpointTreeMeta extends Omit<CheckpointTree, "nodes" | "events"> {
  storageFormat: "meshrix.checkpoint-tree.normalized";
  nodeIds: string[];
  nodeDigests: Record<string, string>;
  childrenByParent: Record<string, string[]>;
  eventCount: number;
  eventDigests: string[];
  summary: ReturnType<typeof checkpointTreeSummary>;
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
}: CreateNodeInput = {}): CheckpointNode {
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

function appendEvent(tree: CheckpointTree, {
  type = "checkpoint.event",
  nodeId = "",
  message = "",
  data = {},
  envelope = null
}: AppendEventInput = {}): void {
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
      ledgerEventId: text(envelope.factRef?.ledgerEventId),
      ledgerIndex: Number(envelope.factRef?.ledgerIndex ?? -1)
    } : null
  });
  tree.updatedAt = at;
}

function createTree(input: CheckpointProjectionInput = {}, attempt = 1): CheckpointTree {
  const at = nowIso();
  const rootNodeId = normalizeNodeId(input.rootNodeId || "root");
  const root = createNode({
    nodeId: rootNodeId,
    label: input.rootLabel || "Root",
    status: "running",
    metadata: input.rootMetadata || {},
    at
  });
  const tree: CheckpointTree = {
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

function isCheckpointNode(value: unknown): value is CheckpointNode {
  return isRecord(value) &&
    typeof value.nodeId === "string" &&
    typeof value.parentId === "string" &&
    typeof value.label === "string" &&
    typeof value.status === "string" &&
    VALID_NODE_STATUS.has(value.status as CheckpointNodeStatus) &&
    isRecord(value.cursor) &&
    isRecord(value.totals) &&
    isRecord(value.metadata) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.completedAt === "string" &&
    typeof value.error === "string";
}

function isCheckpointEvent(value: unknown): value is CheckpointEvent {
  const proof = value && isRecord(value) ? value.pactium : undefined;
  return isRecord(value) &&
    typeof value.eventId === "string" &&
    typeof value.at === "string" &&
    typeof value.type === "string" &&
    typeof value.nodeId === "string" &&
    typeof value.message === "string" &&
    isRecord(value.data) &&
    (proof === null || (
      isRecord(proof) &&
      typeof proof.envelopeId === "string" &&
      typeof proof.outcomeId === "string" &&
      typeof proof.ledgerEventId === "string" &&
      typeof proof.ledgerIndex === "number"
    ));
}

function isCurrentTree(value: unknown, treeId = ""): value is CheckpointTree {
  return Boolean(isRecord(value) &&
    value.protocol === PACTIUM_PROTOCOL &&
    value.schema === PACTIUM_SCHEMA_VERSION &&
    value.treeType === TREE_TYPE &&
    (!treeId || value.treeId === treeId) &&
    value.nodes &&
    isRecord(value.nodes));
}

function isCheckpointTreeMeta(value: unknown): value is CheckpointTreeMeta {
  return isRecord(value) &&
    value.protocol === PACTIUM_PROTOCOL &&
    value.schema === PACTIUM_SCHEMA_VERSION &&
    value.treeType === TREE_TYPE &&
    typeof value.treeId === "string" &&
    typeof value.kind === "string" &&
    typeof value.ownerId === "string" &&
    typeof value.status === "string" &&
    VALID_TREE_STATUS.has(value.status as CheckpointTreeStatus) &&
    typeof value.inputHash === "string" &&
    isRecord(value.resumePolicy) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.completedAt === "string" &&
    typeof value.failedAt === "string" &&
    typeof value.attempt === "number" &&
    typeof value.rootNodeId === "string" &&
    isRecord(value.metadata) &&
    value.storageFormat === "meshrix.checkpoint-tree.normalized" &&
    Array.isArray(value.nodeIds) && value.nodeIds.every((nodeId) => typeof nodeId === "string") &&
    isRecord(value.nodeDigests) && Object.values(value.nodeDigests).every((digest) => typeof digest === "string") &&
    isRecord(value.childrenByParent) && Object.values(value.childrenByParent).every(
      (children) => Array.isArray(children) && children.every((nodeId) => typeof nodeId === "string")
    ) &&
    typeof value.eventCount === "number" &&
    Array.isArray(value.eventDigests) && value.eventDigests.every((digest) => typeof digest === "string") &&
    isRecord(value.summary);
}

function shouldResetTree(existing: CheckpointTree, input: CheckpointProjectionInput = {}): boolean {
  const mode = text(asObject(input.resumePolicy).mode);
  if (mode === "resume-after-reset" || mode === "reset" || mode === "cold") return true;
  const ownerId = text(input.ownerId);
  const inputHash = text(input.inputHash);
  return Boolean((ownerId && ownerId !== existing.ownerId) || (inputHash && inputHash !== existing.inputHash));
}

function byStatus(nodes: readonly CheckpointNode[]): Record<string, number> {
  return nodes.reduce<Record<string, number>>((result, node) => {
    const status = text(node.status, "unknown");
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
}

function projectionDigest(value: unknown): string {
  return stableJson(value);
}

function nodeStorageKey(treeId: string, nodeId: string): string {
  return `${treeId}:${nodeId}`;
}

function eventStorageKey(treeId: string, index: number): string {
  return `${treeId}:${String(Number(index)).padStart(12, "0")}`;
}

function treeMetaProjection(tree: CheckpointTree): CheckpointTreeMeta {
  const { nodes: _nodes, events: _events, ...meta } = tree;
  const nodeIds = Object.keys(asObject(tree.nodes)).sort();
  const childrenByParent: Record<string, string[]> = {};
  const nodeDigests: Record<string, string> = {};
  for (const nodeId of nodeIds) {
    const node = tree.nodes[nodeId];
    nodeDigests[nodeId] = projectionDigest(node);
    const parentId = text(node.parentId);
    if (parentId) (childrenByParent[parentId] ||= []).push(nodeId);
  }
  for (const children of Object.values(childrenByParent)) children.sort();
  return {
    ...meta,
    storageFormat: "meshrix.checkpoint-tree.normalized",
    nodeIds,
    nodeDigests,
    childrenByParent,
    eventCount: asArray(tree.events).length,
    eventDigests: asArray(tree.events).map(projectionDigest),
    summary: checkpointTreeSummary(tree)
  };
}

async function loadNormalizedTree(runtime: MeshrixPactiumRuntime, treeId: string): Promise<CheckpointTree | null> {
  const storedMeta = await runtime.storage.getProtocolObject(TREE_META_SCOPE, treeId, null);
  if (!isCheckpointTreeMeta(storedMeta)) return null;
  const meta = storedMeta;
  const nodes: Record<string, CheckpointNode> = {};
  for (const nodeId of stringArray(meta.nodeIds)) {
    const node = await runtime.storage.getProtocolObject(TREE_NODE_SCOPE, nodeStorageKey(treeId, nodeId), null);
    if (!isCheckpointNode(node)) throw checkpointProjectionError("checkpoint_tree_node_incomplete", "Checkpoint node projection is incomplete.");
    nodes[nodeId] = node;
  }
  const events: CheckpointEvent[] = [];
  for (let index = 0; index < Number(meta.eventCount || 0); index += 1) {
    const event = await runtime.storage.getProtocolObject(TREE_EVENT_SCOPE, eventStorageKey(treeId, index), null);
    if (!isCheckpointEvent(event)) throw checkpointProjectionError("checkpoint_tree_event_incomplete", "Checkpoint event projection is incomplete.");
    events.push(event);
  }
  const {
    storageFormat: _storageFormat,
    nodeIds: _nodeIds,
    nodeDigests: _nodeDigests,
    childrenByParent: _childrenByParent,
    eventCount: _eventCount,
    eventDigests: _eventDigests,
    summary: _summary,
    ...treeMeta
  } = meta;
  return { ...treeMeta, nodes, events };
}


function nodeFieldChanges(fromNode: CheckpointNode, toNode: CheckpointNode) {
  const fields = ["label", "status", "cursor", "totals", "metadata", "error"] as const;
  return fields
    .filter((field) => stableJson(fromNode[field]) !== stableJson(toNode[field]))
    .map((field) => ({
      field,
      before: fromNode[field] ?? null,
      after: toNode[field] ?? null
    }));
}

async function loadTreeIds(runtime: MeshrixPactiumRuntime): Promise<string[]> {
  return stringArray(await runtime.storage.getProtocolObject(INDEX_SCOPE, INDEX_KEY, []));
}

async function saveTreeIds(runtime: MeshrixPactiumRuntime, treeIds: readonly string[]): Promise<void> {
  await runtime.storage.putProtocolObject(INDEX_SCOPE, INDEX_KEY, [...new Set(treeIds.map((treeId) => text(treeId)).filter(Boolean))]);
}

function isTerminalTreeStatus(status: unknown): boolean {
  return ["completed", "cancelled"].includes(text(status));
}

function checkpointProjectionError(code: string, message: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

function checkpointNodeReplayProjection(node: Partial<CheckpointNode> = {}) {
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

async function saveTree(runtime: MeshrixPactiumRuntime, tree: CheckpointTree, { allowTerminalOverwrite = false }: { allowTerminalOverwrite?: boolean } = {}): Promise<CheckpointTree> {
  if (!runtime.storage.inMemory && typeof runtime.storage.clearCache === "function") runtime.storage.clearCache();
  const storedCurrentMeta = await runtime.storage.getProtocolObject(TREE_META_SCOPE, tree.treeId, null);
  const currentMeta = isCheckpointTreeMeta(storedCurrentMeta) ? storedCurrentMeta : null;
  const current = currentMeta
    ? { ...currentMeta, nodes: {} }
    : null;
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
  const nextMeta = treeMetaProjection(tree);
  const previousNodeIds = new Set<string>(currentMeta?.nodeIds || []);
  for (const nodeId of nextMeta.nodeIds) {
    if (currentMeta?.nodeDigests?.[nodeId] !== nextMeta.nodeDigests[nodeId]) {
      await runtime.storage.putProtocolObject(TREE_NODE_SCOPE, nodeStorageKey(tree.treeId, nodeId), tree.nodes[nodeId]);
    }
    previousNodeIds.delete(nodeId);
  }
  for (const removedNodeId of previousNodeIds) {
    await runtime.storage.deleteProtocolObject?.(TREE_NODE_SCOPE, nodeStorageKey(tree.treeId, removedNodeId));
  }
  const parentIds = new Set([
    ...Object.keys(asObject(currentMeta?.childrenByParent)),
    ...Object.keys(asObject(nextMeta.childrenByParent))
  ]);
  for (const parentId of parentIds) {
    const before = asArray(currentMeta?.childrenByParent?.[parentId]);
    const after = asArray(nextMeta.childrenByParent[parentId]);
    if (projectionDigest(before) === projectionDigest(after)) continue;
    if (after.length === 0) await runtime.storage.deleteProtocolObject?.(TREE_CHILD_SCOPE, nodeStorageKey(tree.treeId, parentId));
    else await runtime.storage.putProtocolObject(TREE_CHILD_SCOPE, nodeStorageKey(tree.treeId, parentId), after);
  }
  for (let index = 0; index < nextMeta.eventCount; index += 1) {
    if (currentMeta?.eventDigests?.[index] === nextMeta.eventDigests[index]) continue;
    const event = tree.events[index];
    await runtime.storage.putProtocolObject(TREE_EVENT_SCOPE, eventStorageKey(tree.treeId, index), event);
    if (event.nodeId) {
      const indexKey = nodeStorageKey(tree.treeId, event.nodeId);
      const existingIndexes = asArray(await runtime.storage.getProtocolObject(TREE_EVENT_INDEX_SCOPE, indexKey, []));
      if (!existingIndexes.includes(index)) {
        await runtime.storage.putProtocolObject(TREE_EVENT_INDEX_SCOPE, indexKey, [...existingIndexes, index]);
      }
    }
  }
  await runtime.storage.putProtocolObject(TREE_META_SCOPE, tree.treeId, nextMeta);
  const treeIds = await loadTreeIds(runtime);
  if (!treeIds.includes(tree.treeId)) {
    treeIds.push(tree.treeId);
    await saveTreeIds(runtime, treeIds);
  }
  return tree;
}

async function recordCheckpointOperation(
  runtime: MeshrixPactiumRuntime,
  tree: CheckpointTree,
  operationId: string,
  result: PactiumRecord = {}
): Promise<PactiumProofEnvelope> {
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

export function checkpointTreeId(kind: unknown, ...parts: unknown[]): string {
  return serverToken("checkpoint_tree", kind, ...parts);
}

export async function loadCheckpointTree(input: CheckpointProjectionInput = {}) {
  return withCheckpointProjectionRuntime(input, async (normalized) => {
    try {
      assertServerToken(normalized.treeId, "checkpoint_tree");
    } catch {
      return null;
    }
    const tree = await loadNormalizedTree(normalized.pactiumRuntime, normalized.treeId);
    return isCurrentTree(tree, normalized.treeId) ? tree : null;
  });
}

export async function listCheckpointTrees(input: CheckpointProjectionInput = {}) {
  return withCheckpointProjectionRuntime(input, async (normalized) => {
    const treeIds = await loadTreeIds(normalized.pactiumRuntime);
    const trees: ReturnType<typeof checkpointTreeSummary>[] = [];
    for (const treeId of treeIds) {
      const meta = await normalized.pactiumRuntime.storage.getProtocolObject(TREE_META_SCOPE, treeId, null);
      if (!isCheckpointTreeMeta(meta) || !isRecord(meta.summary)) continue;
      const summary = meta.summary as ReturnType<typeof checkpointTreeSummary>;
      if (normalized.kind && summary.kind !== normalized.kind) continue;
      if (normalized.ownerId && summary.ownerId !== normalized.ownerId) continue;
      trees.push(summary);
    }
    trees.sort((left, right)  => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    const limit = Math.max(1, Math.min(Number(normalized.limit || 100), 1000));
    return trees.slice(0, limit);
  });
}

export function checkpointTreeSummary(tree: Partial<CheckpointTree> = {}) {
  const nodes = Object.values(tree.nodes || {});
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

async function startCheckpointTreeUnlocked(input: CheckpointProjectionInput = {}) {
  const normalized = withRuntime(input);
  assertServerToken(normalized.treeId, "checkpoint_tree");
  const existing = await loadCheckpointTree(normalized);
  let tree: CheckpointTree;
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
      ledgerEventId: text(envelope.factRef?.ledgerEventId),
      ledgerIndex: Number(envelope.factRef?.ledgerIndex ?? -1)
  };
  return saveTree(normalized.pactiumRuntime, tree, { allowTerminalOverwrite });
}

export async function startCheckpointTree(input: CheckpointProjectionInput = {}) {
  return withCheckpointProjectionMutation(input, startCheckpointTreeUnlocked);
}

async function upsertCheckpointNodeUnlocked(input: CheckpointProjectionInput = {}) {
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
  const idempotencyKey = text(normalized.idempotencyKey);
  if (idempotencyKey && previous.nodeId) {
    const previousIdempotencyKey = text(previous.idempotencyKey);
    if (!previousIdempotencyKey) {
      throw checkpointProjectionError(
        "checkpoint_node_idempotency_unbound",
        "Existing checkpoint node has no adoptable idempotency binding."
      );
    }
    const requestedProjection = checkpointNodeReplayProjection({
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
  const node: CheckpointNode = {
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

export async function upsertCheckpointNode(input: CheckpointProjectionInput = {}) {
  return withCheckpointProjectionMutation(input, upsertCheckpointNodeUnlocked);
}

async function finishCheckpointTreeUnlocked(input: CheckpointProjectionInput = {}) {
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

export async function finishCheckpointTree(input: CheckpointProjectionInput = {}) {
  return withCheckpointProjectionMutation(input, finishCheckpointTreeUnlocked);
}

export async function queryCheckpointScope(input: CheckpointProjectionInput = {}) {
  return withCheckpointProjectionRuntime(input, async (normalized) => {
    const runtime = normalized.pactiumRuntime;
    const meta = await runtime.storage.getProtocolObject(TREE_META_SCOPE, normalized.treeId, null);
    if (!isCheckpointTreeMeta(meta)) throw new Error("checkpoint tree is missing");
    const nodeId = normalizeNodeId(normalized.nodeId || meta.rootNodeId || "root");
    const target = await runtime.storage.getProtocolObject(TREE_NODE_SCOPE, nodeStorageKey(normalized.treeId, nodeId), null);
    if (!isCheckpointNode(target)) throw new Error("checkpoint node is missing");
    const nodes: CheckpointNode[] = [];
    const queue: string[] = [nodeId];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const currentId = queue.shift();
      if (!currentId) continue;
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      const node = currentId === nodeId
        ? target
        : await runtime.storage.getProtocolObject(TREE_NODE_SCOPE, nodeStorageKey(normalized.treeId, currentId), null);
      if (!isCheckpointNode(node)) throw checkpointProjectionError("checkpoint_tree_node_incomplete", "Checkpoint node projection is incomplete.");
      nodes.push(node);
      const children = stringArray(await runtime.storage.getProtocolObject(TREE_CHILD_SCOPE, nodeStorageKey(normalized.treeId, currentId), []));
      queue.push(...children);
    }
    const nodeIds = new Set<string>(nodes.map((node) => node.nodeId));
    const path: CheckpointNode[] = [];
    let parentId = text(target.parentId);
    const pathVisited = new Set<string>();
    while (parentId && !pathVisited.has(parentId)) {
      pathVisited.add(parentId);
      const parent = await runtime.storage.getProtocolObject(TREE_NODE_SCOPE, nodeStorageKey(normalized.treeId, parentId), null);
      if (!isCheckpointNode(parent)) break;
      path.push(parent);
      parentId = text(parent.parentId);
    }
    const eventIndexes = new Set<number>();
    for (const scopedNodeId of nodeIds) {
      for (const index of asArray(await runtime.storage.getProtocolObject(
        TREE_EVENT_INDEX_SCOPE,
        nodeStorageKey(normalized.treeId, scopedNodeId),
        []
      ))) eventIndexes.add(Number(index));
    }
    const events: CheckpointEvent[] = [];
    for (const index of [...eventIndexes].sort((left, right)  => left - right)) {
      const event = await runtime.storage.getProtocolObject(TREE_EVENT_SCOPE, eventStorageKey(normalized.treeId, index), null);
      if (isCheckpointEvent(event)) events.push(event);
    }
    return {
      treeId: normalized.treeId,
      nodeId,
      target,
      nodes,
      path,
      events,
      affectedNodeCount: nodes.length,
      byStatus: byStatus(nodes)
    };
  });
}

export async function previewCheckpointRestore(input: CheckpointProjectionInput = {}) {
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

async function restoreCheckpointTreeUnlocked(input: CheckpointProjectionInput = {}) {
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

export async function restoreCheckpointTree(input: CheckpointProjectionInput = {}) {
  return withCheckpointProjectionMutation(input, restoreCheckpointTreeUnlocked);
}

export async function diffCheckpointTree(input: CheckpointProjectionInput = {}) {
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
    const summaryFields = ["kind", "ownerId", "status", "inputHash", "nodeCount"] as const;
    const fieldChanges = summaryFields
      .filter((field)  => String(fromSummary[field] ?? "") !== String(toSummary[field] ?? ""));
    const changes = [
      ...fieldChanges.map((field)  => ({
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

async function deleteCheckpointTreeUnlocked(input: CheckpointProjectionInput = {}) {
  const normalized = withRuntime(input);
  assertServerToken(normalized.treeId, "checkpoint_tree");
  const tree = await loadCheckpointTree(normalized);
  if (tree) {
    await recordCheckpointOperation(normalized.pactiumRuntime, tree, "checkpoint.tree.delete", {
      deleted: true
    });
  }
  if (typeof normalized.pactiumRuntime.storage.deleteProtocolObject === "function") {
    const storedMeta = await normalized.pactiumRuntime.storage.getProtocolObject(TREE_META_SCOPE, normalized.treeId, null);
    const meta = isCheckpointTreeMeta(storedMeta) ? storedMeta : null;
    for (const nodeId of meta?.nodeIds || []) {
      await normalized.pactiumRuntime.storage.deleteProtocolObject(TREE_NODE_SCOPE, nodeStorageKey(normalized.treeId, nodeId));
      await normalized.pactiumRuntime.storage.deleteProtocolObject(TREE_CHILD_SCOPE, nodeStorageKey(normalized.treeId, nodeId));
      await normalized.pactiumRuntime.storage.deleteProtocolObject(TREE_EVENT_INDEX_SCOPE, nodeStorageKey(normalized.treeId, nodeId));
    }
    for (let index = 0; index < Number(meta?.eventCount || 0); index += 1) {
      await normalized.pactiumRuntime.storage.deleteProtocolObject(TREE_EVENT_SCOPE, eventStorageKey(normalized.treeId, index));
    }
    await normalized.pactiumRuntime.storage.deleteProtocolObject(TREE_META_SCOPE, normalized.treeId);
  }
  const treeIds = (await loadTreeIds(normalized.pactiumRuntime)).filter((treeId) => treeId !== normalized.treeId);
  await saveTreeIds(normalized.pactiumRuntime, treeIds);
  return { ok: true, treeId: normalized.treeId };
}

export async function deleteCheckpointTree(input: CheckpointProjectionInput = {}) {
  return withCheckpointProjectionMutation(input, deleteCheckpointTreeUnlocked);
}
