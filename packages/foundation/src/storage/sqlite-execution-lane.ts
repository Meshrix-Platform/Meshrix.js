import { Worker } from "node:worker_threads";

export class SqliteExecutionLaneError extends Error {
  code: any;
  constructor(code?: any, message?: any) {
    super(message || code);
    this.name = "SqliteExecutionLaneError";
    this.code = code;
  }
}

function byteLength(value?: any) : any {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

/**
 * Bounded RPC lane for one typed SQLite owner worker. Commands are immutable
 * discriminated records; executable values, SQL and filesystem paths are not
 * accepted at the request boundary.
 */
export function createSqliteExecutionLane({
  owner,
  workerUrl,
  workerData = {},
  allowedCommands = [],
  hostHandlers = {},
  maxPending = 1024,
  maxPendingBytes = 16 * 1024 * 1024,
  defaultDeadlineMs = 30_000
}: Record<string, any> = {}) : any {
  const allowed: any = new Set<any>(allowedCommands.map(String));
  const hostHandlerByKind: any = new Map<any, any>(
    Object.entries(hostHandlers || {}).filter(([, handler]: any) : any => typeof handler === "function")
  );
  const worker: any = new Worker(workerUrl, { workerData });
  const pending: any = new Map<any, any>();
  let sequence: any = 0;
  let pendingBytes: any = 0;
  let closed: any = false;
  let crashed: any = false;
  let crashDetails: any = null;

  function closedError() : any {
    const error: any = new SqliteExecutionLaneError(
      crashed ? "sqlite_lane_crashed" : "sqlite_lane_closed",
      "SQLite execution lane is closed."
    );
    if (crashDetails) error.details = crashDetails;
    return error;
  }

  function rejectAll(error?: any) : any {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    pendingBytes = 0;
  }

  worker.on("message", async (message?: any) : Promise<any> => {
    if (message?.type === "host-call") {
      const kind: any = String(message.kind || "");
      const handler: any = hostHandlerByKind.get(kind);
      if (!handler) {
        worker.postMessage({
          type: "host-response",
          id: message.id,
          ok: false,
          error: {
            name: "SqliteExecutionLaneError",
            code: "sqlite_lane_host_command_rejected",
            message: "SQLite lane host command is not allowed."
          }
        });
        return;
      }
      try {
        const result: any = await handler(structuredClone(message.payload ?? {}));
        worker.postMessage({ type: "host-response", id: message.id, ok: true, result });
      } catch (error: any) {
        worker.postMessage({
          type: "host-response",
          id: message.id,
          ok: false,
          error: {
            name: String(error?.name || "Error"),
            code: String(error?.code || "sqlite_lane_host_command_failed"),
            message: String(error?.message || "SQLite lane host command failed."),
            statusCode: Number(error?.statusCode || error?.status || 0),
            details: error?.details && typeof error.details === "object" ? error.details : {}
          }
        });
      }
      return;
    }
    const entry: any = pending.get(message?.id);
    if (!entry) return;
    pending.delete(message.id);
    pendingBytes -= entry.bytes;
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else {
      const error: any = new SqliteExecutionLaneError(message.error?.code || "sqlite_lane_command_failed", message.error?.message || "SQLite lane command failed.");
      error.remoteName = String(message.error?.name || "Error");
      error.details = message.error?.details && typeof message.error.details === "object"
        ? Object.freeze({ ...message.error.details })
        : Object.freeze({});
      if (Number(message.error?.statusCode || 0) > 0) {
        error.statusCode = Number(message.error.statusCode);
      }
      if (String(message.error?.field || "")) {
        error.field = String(message.error.field);
      }
      entry.reject(error);
    }
  });
  worker.on("error", (cause?: any) : any => {
    crashed = true;
    closed = true;
    const error: any = new SqliteExecutionLaneError("sqlite_lane_crashed", "SQLite execution lane crashed.");
    error.cause = cause;
    crashDetails = Object.freeze({
      causeCode: /^[A-Z][A-Z0-9_]{1,79}$/u.test(String(cause?.code || ""))
        ? String(cause.code)
        : "sqlite_worker_error",
      owner: String(owner || "sqlite")
    });
    error.details = crashDetails;
    rejectAll(error);
  });
  worker.on("exit", (code?: any) : any => {
    if (!closed && code !== 0) crashed = true;
    closed = true;
    rejectAll(closedError());
  });

  function execute(command?: any, payload: any = {}, options: Record<string, any> = {}) : any {
    if (closed) return Promise.reject(closedError());
    const kind: any = String(command || "");
    if (!allowed.has(kind)) return Promise.reject(new SqliteExecutionLaneError("sqlite_lane_command_rejected"));
    if (typeof payload === "function" || typeof payload?.sql === "string" || typeof payload?.path === "string") {
      return Promise.reject(new SqliteExecutionLaneError("sqlite_lane_payload_rejected"));
    }
    const frozenPayload: any = structuredClone(payload);
    const bytes: any = byteLength(frozenPayload);
    if (pending.size >= maxPending || pendingBytes + bytes > maxPendingBytes) {
      return Promise.reject(new SqliteExecutionLaneError("sqlite_lane_capacity_exceeded"));
    }
    const deadlineMs: any = Math.max(1, Math.min(Number(options.deadlineMs || defaultDeadlineMs), 300_000));
    const id: any = ++sequence;
    return new Promise((resolve?: any, reject?: any) : any => {
      const timer: any = setTimeout(() : any => {
        const entry: any = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        pendingBytes -= entry.bytes;
        reject(new SqliteExecutionLaneError("sqlite_lane_deadline_exceeded"));
      }, deadlineMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, bytes });
      pendingBytes += bytes;
      worker.postMessage(Object.freeze({
        id,
        owner: String(owner || "sqlite"),
        kind,
        payload: frozenPayload,
        deadlineAtMs: Date.now() + deadlineMs,
        revision: Number(options.revision || 0)
      }));
    });
  }

  async function close() : Promise<any> {
    if (closed) return;
    await execute("close", {}, { deadlineMs: defaultDeadlineMs }).catch(() : any => {});
    closed = true;
    await worker.terminate();
  }

  return Object.freeze({
    execute,
    close,
    getStats() : any {
      return Object.freeze({
        owner: String(owner || "sqlite"),
        pending: pending.size,
        pendingBytes,
        maxPending,
        maxPendingBytes,
        writerWorkers: closed ? 0 : 1,
        closed,
        crashed
      });
    }
  });
}
