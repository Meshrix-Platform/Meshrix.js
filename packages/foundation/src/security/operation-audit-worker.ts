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

const store = createOperationAuditWorkerStore(workerData);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function errorRecord(error: unknown): Readonly<Record<string, unknown>> {
  const source = record(error);
  const details: Record<string, unknown> = {};
  for (const key of ["actual", "auditId", "limit", "reason", "statusCode"]) {
    if (source[key] !== undefined) details[key] = source[key];
  }
  return Object.freeze({
    name: String(source.name || "Error"),
    code: String(source.code || "sqlite_lane_command_failed"),
    message: String(source.message || "Operation audit command failed."),
    details
  });
}

function capacityStats(): Readonly<Record<string, unknown>> {
  const meta = record(store.db.prepare(`
    SELECT row_count AS rowCount,
           logical_bytes AS logicalBytes,
           append_count AS appendCount,
           last_maintenance_at AS lastMaintenanceAt
    FROM operation_audit_meta
    WHERE singleton = 1
  `).get());
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

parentPort?.on("message", async (message: unknown): Promise<void> => {
  const request = record(message);
  const payload = record(request.payload);
  const reply: Record<string, unknown> = { id: request.id, ok: false };
  try {
    const kind = String(request.kind || "");
    if (!COMMANDS.has(kind)) {
      throw Object.assign(new Error("Operation audit SQLite command is not allowed."), {
        code: "sqlite_lane_command_rejected"
      });
    }
    if (Date.now() > Number(request.deadlineAtMs || 0)) {
      throw Object.assign(new Error("Operation audit SQLite command deadline elapsed."), {
        code: "sqlite_lane_deadline_exceeded"
      });
    }
    if (kind === "getCapacityStats") {
      reply.result = capacityStats();
    } else if (kind === "getById") {
      reply.result = store.getById(payload.auditId);
    } else if (kind === "getTrace") {
      reply.result = store.getTrace(payload.traceId, record(payload.input));
    } else if (kind === "close") {
      store.close();
      reply.result = undefined;
    } else {
      const command = store[kind as keyof typeof store];
      if (typeof command !== "function") {
        throw Object.assign(new Error("Operation audit SQLite command is not implemented."), {
          code: "sqlite_lane_command_rejected"
        });
      }
      reply.result = await (command as (input: Record<string, unknown>) => unknown)(payload);
    }
    reply.ok = true;
  } catch (error: unknown) {
    reply.error = errorRecord(error);
  }
  parentPort?.postMessage(reply);
});
