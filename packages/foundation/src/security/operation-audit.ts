import crypto from "node:crypto";
import path from "node:path";

import { createSqliteExecutionLane } from "../storage/sqlite-execution-lane.ts";
import {
  inspectOperationAuditProjectionDatabase,
  operationAuditProjectionKeyId,
  projectOperationAuditEntry,
  projectOperationAuditFilter,
  projectOperationAuditRetentionPolicy
} from "./operation-audit-projection.ts";
import {
  OperationAuditCapacityError,
  OperationAuditIdempotencyConflictError,
  OperationAuditIdRequiredError,
  redactOperationAuditValue
} from "./operation-audit-common.ts";

export {
  OperationAuditCapacityError,
  OperationAuditIdempotencyConflictError,
  OperationAuditIdRequiredError,
  redactOperationAuditValue
};

const COMMANDS: readonly string[] = Object.freeze([
  "append",
  "appendIdempotent",
  "getById",
  "list",
  "getRetentionPolicy",
  "setRetentionPolicy",
  "pruneExpired",
  "exportRedacted",
  "getTrace",
  "getCapacityStats",
  "close"
]);

type DataRecord = Record<string, unknown>;
interface OperationAuditStoreOptions {
  userDataPath: string;
  projectionKey: Uint8Array;
  projectionKeyId: string;
  maxPending?: number;
  maxPendingBytes?: number;
}
interface SqliteExecutionLane {
  execute(kind: string, payload: DataRecord): Promise<unknown>;
  ready(): Promise<void>;
  close(): Promise<unknown>;
  getStats(): unknown;
}
export interface OperationAuditStore {
  append(entry?: DataRecord): Promise<unknown>;
  appendIdempotent(entry?: DataRecord): Promise<unknown>;
  getById(auditId?: string): Promise<unknown>;
  list(input?: DataRecord): Promise<unknown>;
  getRetentionPolicy(): Promise<unknown>;
  setRetentionPolicy(input?: DataRecord): Promise<unknown>;
  pruneExpired(input?: DataRecord): Promise<unknown>;
  exportRedacted(input?: DataRecord): Promise<unknown>;
  getTrace(traceId?: string, input?: DataRecord): Promise<unknown>;
  getCapacityStats(): Promise<unknown>;
  ready(): Promise<void>;
  close(): Promise<unknown>;
  getStats(): unknown;
}

function record(value: unknown): DataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as DataRecord
    : {};
}

function restoreOperationAuditError(error: unknown): never {
  const source = record(error);
  const details = record(source.details);
  if (source.code === "operation_audit_capacity_exhausted") {
    throw new OperationAuditCapacityError(String(details.reason || "unknown"), Number(details.limit || 0), Number(details.actual || 0));
  }
  if (source.code === "operation_audit_id_required") {
    throw new OperationAuditIdRequiredError();
  }
  if (source.code === "operation_audit_idempotency_conflict") {
    throw new OperationAuditIdempotencyConflictError(String(details.auditId || ""));
  }
  throw error instanceof Error ? error : new Error("Operation audit execution failed.");
}

/**
 * One bounded asynchronous lane owns the operation-audit database. The
 * returned facade intentionally exposes no database handle or synchronous
 * fallback, so request paths cannot execute SQLite work on the event loop.
 */
export function createOperationAuditStore({
  userDataPath,
  projectionKey: suppliedProjectionKey,
  projectionKeyId,
  maxPending = 1024,
  maxPendingBytes = 16 * 1024 * 1024
}: OperationAuditStoreOptions): Readonly<OperationAuditStore> {
  const projectionKey = Buffer.from(suppliedProjectionKey);
  const expectedKeyId = operationAuditProjectionKeyId(projectionKey);
  if (projectionKey.length !== 32 || expectedKeyId !== projectionKeyId) {
    projectionKey.fill(0);
    throw Object.assign(new Error("Operation audit projection key is invalid."), {
      code: "operation_audit_projection_key_invalid"
    });
  }

  let lane: SqliteExecutionLane;
  try {
    lane = createSqliteExecutionLane({
      owner: "mandatory-evidence-operation-audit",
      workerUrl: new URL(
        `./operation-audit-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
        import.meta.url
      ),
      workerData: { userDataPath, projectionKey, projectionKeyId },
      requiresReadyHandshake: true,
      allowedCommands: COMMANDS,
      maxPending,
      maxPendingBytes
    }) as SqliteExecutionLane;
  } catch (error: unknown) {
    projectionKey.fill(0);
    throw error;
  }

  async function execute(kind: string, payload: DataRecord = {}): Promise<unknown> {
    try {
      return await lane.execute(kind, payload);
    } catch (error: unknown) {
      return restoreOperationAuditError(error);
    }
  }

  function projectEntry(entry: DataRecord = {}, idempotent = false): DataRecord {
    const source = record(entry);
    const auditId = String(source.auditId || (idempotent ? "" : `op_audit_${crypto.randomUUID()}`));
    if (idempotent && !auditId.trim()) throw new OperationAuditIdRequiredError();
    const createdAt = source.createdAt ? String(source.createdAt) : undefined;
    const projected = projectOperationAuditEntry(source, {
      key: projectionKey,
      auditId,
      ...(createdAt ? { createdAt } : {})
    });
    if (idempotent && !createdAt) projected.createdAt = "";
    return {
      projectionVersion: "meshrix-operation-audit-projection-v1",
      ...projected
    };
  }

  async function close(): Promise<void> {
    try {
      await lane.close();
    } finally {
      projectionKey.fill(0);
    }
  }

  return Object.freeze({
    append: async (entry: DataRecord = {}) => execute("append", projectEntry(entry)),
    appendIdempotent: async (entry: DataRecord = {}) => execute("appendIdempotent", projectEntry(entry, true)),
    getById: (auditId = "") => execute("getById", auditId ? { auditId } : {}),
    list: (input: DataRecord = {}) => execute("list", projectOperationAuditFilter(input, projectionKey)),
    getRetentionPolicy: () => execute("getRetentionPolicy"),
    setRetentionPolicy: (input: DataRecord = {}) => execute("setRetentionPolicy", projectOperationAuditRetentionPolicy(input, projectionKey)),
    pruneExpired: (input: DataRecord = {}) => execute("pruneExpired", projectOperationAuditRetentionPolicy(input, projectionKey)),
    exportRedacted: (input: DataRecord = {}) => execute("exportRedacted", projectOperationAuditFilter(input, projectionKey)),
    getTrace: (traceId = "", input: DataRecord = {}) => execute("getTrace", {
      traceId: projectOperationAuditFilter({ traceId }, projectionKey).traceId || "",
      input: projectOperationAuditFilter(input, projectionKey)
    }),
    getCapacityStats: () => execute("getCapacityStats"),
    ready: () => lane.ready(),
    close,
    getStats: () => lane.getStats()
  });
}

export async function inspectOperationAuditProjection({
  userDataPath
}: { userDataPath: string }): Promise<ReturnType<typeof inspectOperationAuditProjectionDatabase>> {
  return inspectOperationAuditProjectionDatabase(path.join(path.resolve(userDataPath), "security", "operation-audit.sqlite"));
}

export default createOperationAuditStore;
