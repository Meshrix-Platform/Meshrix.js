import type { PactiumCore, PactiumIndexEngine, PactiumRecord, PactiumStoragePort } from "pactium";

export type CheckpointNodeStatus = "pending" | "running" | "paused" | "completed" | "failed" | "skipped";
export type CheckpointTreeStatus = "running" | "completed" | "failed" | "paused" | "cancelled";

export interface MeshrixPactiumRuntime {
  readonly protocol: string;
  readonly schema: string;
  readonly packageVersion: string;
  readonly dataDir: string;
  readonly core: PactiumCore;
  readonly storage: PactiumStoragePort;
  readonly indexEngine: PactiumIndexEngine;
  close?(): Promise<void>;
}

export interface CheckpointNode {
  nodeId: string;
  parentId: string;
  label: string;
  status: CheckpointNodeStatus;
  cursor: PactiumRecord;
  totals: PactiumRecord;
  metadata: PactiumRecord;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt: string;
  error: string;
  idempotencyKey?: string;
}

export interface CheckpointEventProof {
  envelopeId: string;
  outcomeId: string;
  ledgerEventId: string;
  ledgerIndex: number;
}

export interface CheckpointEvent {
  eventId: string;
  at: string;
  type: string;
  nodeId: string;
  message: string;
  data: PactiumRecord;
  pactium: CheckpointEventProof | null;
}

export interface CheckpointTree {
  protocol: string;
  schema: string;
  pactiumPackageVersion: string;
  provider: string;
  treeType: "meshrix.checkpoint-tree";
  protocolVersion: string;
  treeId: string;
  kind: string;
  ownerId: string;
  status: CheckpointTreeStatus;
  inputHash: string;
  resumePolicy: PactiumRecord;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt: string;
  failedAt: string;
  attempt: number;
  rootNodeId: string;
  metadata: PactiumRecord;
  nodes: Record<string, CheckpointNode>;
  events: CheckpointEvent[];
}

export interface CheckpointProjectionInput extends PactiumRecord {
  userDataPath?: string;
  dataDir?: string;
  pactiumRuntime?: MeshrixPactiumRuntime | null;
  runtime?: MeshrixPactiumRuntime | null;
  treeId?: string;
  kind?: string;
  ownerId?: string;
  inputHash?: string;
  rootNodeId?: string;
  rootLabel?: string;
  rootMetadata?: PactiumRecord;
  resumePolicy?: PactiumRecord | null;
  metadata?: PactiumRecord;
  message?: string;
  nodeId?: string;
  parentId?: string;
  label?: string;
  status?: string;
  cursor?: PactiumRecord;
  totals?: PactiumRecord;
  error?: string;
  idempotencyKey?: string;
  eventType?: string;
  reason?: string;
  mode?: string;
  actor?: string;
  fromTreeId?: string;
  toTreeId?: string;
  fromNodeId?: string;
  toNodeId?: string;
  limit?: number;
}

export interface NormalizedCheckpointProjectionInput extends CheckpointProjectionInput {
  userDataPath: string;
  dataDir: string;
  pactiumRuntime: MeshrixPactiumRuntime;
  treeId: string;
  kind: string;
  ownerId: string;
  inputHash: string;
  rootNodeId: string;
  rootLabel: string;
  message: string;
  nodeId: string;
  parentId: string;
  label: string;
  status: string;
  error: string;
  idempotencyKey: string;
  eventType: string;
  reason: string;
  mode: string;
  actor: string;
  fromTreeId: string;
  toTreeId: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface CodedError extends Error {
  code: string;
}

export function isRecord(value: unknown): value is PactiumRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function recordArray(value: unknown): PactiumRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
