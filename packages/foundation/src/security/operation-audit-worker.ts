import { parentPort, workerData } from "node:worker_threads";
import { createOperationAuditWorkerStore } from "./operation-audit-worker-store.ts";

const COMMANDS: ReadonlySet<string> = new Set([
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

const store: any = createOperationAuditWorkerStore(workerData);

function errorRecord(error: any) : Readonly<Record<string, any>> {
  const details: Record<string, any> = {};
  for (const key of ["actual", "auditId", "limit", "reason", "statusCode"]) {
    if (error?.[key] !== undefined) details[key] = error[key];
  }
  return Object.freeze({
    name: String(error?.name || "Error"),
    code: String(error?.code || "sqlite_lane_command_failed"),
    message: String(error?.message || "Operation audit command failed."),
    details
  });
}

function capacityStats() : Readonly<Record<string, any>> {
  const meta: any = store.db.prepare(`
    SELECT row_count AS rowCount,
           logical_bytes AS logicalBytes,
           append_count AS appendCount,
           last_maintenance_at AS lastMaintenanceAt
    FROM operation_audit_meta
    WHERE singleton = 1
  `).get();
  return Object.freeze({
    ...meta,
    databaseBytes: Number(store.db.pragma("page_count", { simple: true }) || 0) *
      Number(store.db.pragma("page_size", { simple: true }) || 0),
    pageSize: Number(store.db.pragma("page_size", { simple: true }) || 0),
    maxPageCount: Number(store.db.pragma("max_page_count", { simple: true }) || 0),
    autoVacuum: Number(store.db.pragma("auto_vacuum", { simple: true }) || 0),
    journalSizeLimit: Number(store.db.pragma("journal_size_limit", { simple: true }) || 0)
  });
}

parentPort?.on("message", async (message?: any) : Promise<void> => {
  const reply: Record<string, any> = { id: message?.id, ok: false };
  try {
    const kind: string = String(message?.kind || "");
    if (!COMMANDS.has(kind)) {
      throw Object.assign(new Error("Operation audit SQLite command is not allowed."), {
        code: "sqlite_lane_command_rejected"
      });
    }
    if (Date.now() > Number(message?.deadlineAtMs || 0)) {
      throw Object.assign(new Error("Operation audit SQLite command deadline elapsed."), {
        code: "sqlite_lane_deadline_exceeded"
      });
    }
    if (kind === "getCapacityStats") {
      reply.result = capacityStats();
    } else if (kind === "getById") {
      reply.result = store.getById(message.payload?.auditId);
    } else if (kind === "getTrace") {
      reply.result = store.getTrace(message.payload?.traceId, message.payload?.input || {});
    } else if (kind === "close") {
      store.close();
      reply.result = undefined;
    } else {
      reply.result = await store[kind](message.payload || {});
    }
    reply.ok = true;
  } catch (error: any) {
    reply.error = errorRecord(error);
  }
  parentPort?.postMessage(reply);
});
