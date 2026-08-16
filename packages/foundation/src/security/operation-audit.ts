import { createSqliteExecutionLane } from "../storage/sqlite-execution-lane.ts";
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
  userDataPath?: string;
  maxPending?: number;
  maxPendingBytes?: number;
  defaultDeadlineMs?: number;
}
interface SqliteExecutionLane {
  execute(kind: string, payload: DataRecord): Promise<unknown>;
  close(): Promise<unknown>;
  getStats(): unknown;
}
export interface OperationAuditStore {
  lane: SqliteExecutionLane;
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
  maxPending = 1024,
  maxPendingBytes = 16 * 1024 * 1024,
  defaultDeadlineMs = 30_000
}: OperationAuditStoreOptions): Readonly<OperationAuditStore> {
  const lane = createSqliteExecutionLane({
    owner: "mandatory-evidence-operation-audit",
    workerUrl: new URL(
      `./operation-audit-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
      import.meta.url
    ),
    workerData: { userDataPath },
    allowedCommands: COMMANDS,
    maxPending,
    maxPendingBytes,
    defaultDeadlineMs
  }) as SqliteExecutionLane;

  async function execute(kind: string, payload: DataRecord = {}): Promise<unknown> {
    try {
      return await lane.execute(kind, payload);
    } catch (error: unknown) {
      return restoreOperationAuditError(error);
    }
  }

  return Object.freeze({
    lane,
    append: (entry: DataRecord = {}) => execute("append", entry),
    appendIdempotent: (entry: DataRecord = {}) => execute("appendIdempotent", entry),
    getById: (auditId = "") => execute("getById", auditId ? { auditId } : {}),
    list: (input: DataRecord = {}) => execute("list", input),
    getRetentionPolicy: () => execute("getRetentionPolicy"),
    setRetentionPolicy: (input: DataRecord = {}) => execute("setRetentionPolicy", input),
    pruneExpired: (input: DataRecord = {}) => execute("pruneExpired", input),
    exportRedacted: (input: DataRecord = {}) => execute("exportRedacted", input),
    getTrace: (traceId = "", input: DataRecord = {}) => execute("getTrace", { traceId, input }),
    getCapacityStats: () => execute("getCapacityStats"),
    close: () => lane.close(),
    getStats: () => lane.getStats()
  });
}

export default createOperationAuditStore;
