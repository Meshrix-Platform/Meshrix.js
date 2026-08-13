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

function restoreOperationAuditError(error: any) : never {
  const details: Record<string, any> = error?.details || {};
  if (error?.code === "operation_audit_capacity_exhausted") {
    throw new OperationAuditCapacityError(details.reason, details.limit, details.actual);
  }
  if (error?.code === "operation_audit_id_required") {
    throw new OperationAuditIdRequiredError();
  }
  if (error?.code === "operation_audit_idempotency_conflict") {
    throw new OperationAuditIdempotencyConflictError(details.auditId);
  }
  throw error;
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
}: Record<string, any>) : Readonly<Record<string, any>> {
  const lane: any = createSqliteExecutionLane({
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
  });

  async function execute(kind: string, payload: Record<string, any> = {}) : Promise<any> {
    try {
      return await lane.execute(kind, payload);
    } catch (error: any) {
      return restoreOperationAuditError(error);
    }
  }

  return Object.freeze({
    lane,
    append: (entry: Record<string, any> = {}) : Promise<any> => execute("append", entry),
    appendIdempotent: (entry: Record<string, any> = {}) : Promise<any> => execute("appendIdempotent", entry),
    getById: (auditId = "") : Promise<any> => execute("getById", auditId ? { auditId } : {}),
    list: (input: Record<string, any> = {}) : Promise<any> => execute("list", input),
    getRetentionPolicy: () : Promise<any> => execute("getRetentionPolicy"),
    setRetentionPolicy: (input: Record<string, any> = {}) : Promise<any> => execute("setRetentionPolicy", input),
    pruneExpired: (input: Record<string, any> = {}) : Promise<any> => execute("pruneExpired", input),
    exportRedacted: (input: Record<string, any> = {}) : Promise<any> => execute("exportRedacted", input),
    getTrace: (traceId = "", input: Record<string, any> = {}) : Promise<any> => execute("getTrace", { traceId, input }),
    getCapacityStats: () : Promise<any> => execute("getCapacityStats"),
    close: () : Promise<any> => lane.close(),
    getStats: () : any => lane.getStats()
  });
}

export default createOperationAuditStore;
