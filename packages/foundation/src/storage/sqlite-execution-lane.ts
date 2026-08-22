import { Worker } from "node:worker_threads";

export class SqliteExecutionLaneError extends Error {
  readonly code: string;
  details?: Readonly<Record<string, unknown>>;
  remoteName?: string;
  statusCode?: number;
  field?: string;

  constructor(code = "sqlite_lane_error", message?: string) {
    super(message || code);
    this.name = "SqliteExecutionLaneError";
    this.code = code;
  }
}

type DataRecord = Record<string, unknown>;
type HostHandler = (payload: unknown) => unknown | Promise<unknown>;

interface PendingEntry {
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
  timer: NodeJS.Timeout;
  bytes: number;
}

export interface SqliteExecutionLaneStats {
  owner: string;
  pending: number;
  pendingBytes: number;
  maxPending: number;
  maxPendingBytes: number;
  writerWorkers: 0 | 1;
  closed: boolean;
  crashed: boolean;
}

export interface SqliteExecutionLane {
  execute(command: string, payload?: unknown, options?: { deadlineMs?: number; revision?: number }): Promise<unknown>;
  close(): Promise<void>;
  getStats(): Readonly<SqliteExecutionLaneStats>;
}

export interface SqliteExecutionLaneOptions {
  owner?: string;
  workerUrl?: string | URL;
  workerData?: unknown;
  allowedCommands?: readonly string[];
  hostHandlers?: Readonly<Record<string, HostHandler>>;
  maxPending?: number;
  maxPendingBytes?: number;
  defaultDeadlineMs?: number;
}

function record(value: unknown): DataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as DataRecord
    : {};
}

function errorText(error: unknown, field: "name" | "code" | "message"): string {
  const value = record(error)[field];
  return typeof value === "string" ? value : "";
}

function byteLength(value?: unknown): number {
  const serialized = JSON.stringify(value ?? null);
  if (serialized === undefined) throw new TypeError("SQLite lane payload is not serializable.");
  return Buffer.byteLength(serialized);
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
}: SqliteExecutionLaneOptions = {}): Readonly<SqliteExecutionLane> {
  if (!(typeof workerUrl === "string" || workerUrl instanceof URL)) {
    throw new TypeError("SQLite execution lane requires a worker URL.");
  }
  const selectedOwner = String(owner || "sqlite");
  const allowed = new Set(allowedCommands.map(String));
  const hostHandlerByKind = new Map<string, HostHandler>(
    Object.entries(hostHandlers).filter((entry): entry is [string, HostHandler] => typeof entry[1] === "function")
  );
  const worker = new Worker(workerUrl, { workerData });
  const workerExit: Promise<number> = new Promise((resolve): void => {
    worker.once("exit", resolve);
  });
  const pending = new Map<number, PendingEntry>();
  let sequence = 0;
  let pendingBytes = 0;
  let closed = false;
  let crashed = false;
  let crashDetails: Readonly<Record<string, unknown>> | null = null;

  function closedError(): SqliteExecutionLaneError {
    const error = new SqliteExecutionLaneError(
      crashed ? "sqlite_lane_crashed" : "sqlite_lane_closed",
      "SQLite execution lane is closed."
    );
    if (crashDetails) error.details = crashDetails;
    return error;
  }

  function rejectAll(error: unknown): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    pendingBytes = 0;
  }

  worker.on("message", async (message: unknown): Promise<void> => {
    const incoming = record(message);
    if (incoming.type === "host-call") {
      const kind = String(incoming.kind || "");
      const handler = hostHandlerByKind.get(kind);
      if (!handler) {
        worker.postMessage({
          type: "host-response",
          id: incoming.id,
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
        const result = await handler(structuredClone(incoming.payload ?? {}));
        worker.postMessage({ type: "host-response", id: incoming.id, ok: true, result });
      } catch (error: unknown) {
        const errorRecord = record(error);
        worker.postMessage({
          type: "host-response",
          id: incoming.id,
          ok: false,
          error: {
            name: errorText(error, "name") || "Error",
            code: errorText(error, "code") || "sqlite_lane_host_command_failed",
            message: errorText(error, "message") || "SQLite lane host command failed.",
            statusCode: Number(errorRecord.statusCode || errorRecord.status || 0),
            details: record(errorRecord.details)
          }
        });
      }
      return;
    }
    const id = typeof incoming.id === "number" ? incoming.id : -1;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    pendingBytes -= entry.bytes;
    clearTimeout(entry.timer);
    if (incoming.ok) entry.resolve(incoming.result);
    else {
      const remoteError = record(incoming.error);
      const error = new SqliteExecutionLaneError(
        String(remoteError.code || "sqlite_lane_command_failed"),
        String(remoteError.message || "SQLite lane command failed.")
      );
      error.remoteName = String(remoteError.name || "Error");
      error.details = Object.freeze({ ...record(remoteError.details) });
      if (Number(remoteError.statusCode || 0) > 0) {
        error.statusCode = Number(remoteError.statusCode);
      }
      if (String(remoteError.field || "")) {
        error.field = String(remoteError.field);
      }
      entry.reject(error);
    }
  });
  worker.on("error", (cause: Error): void => {
    crashed = true;
    closed = true;
    const error = new SqliteExecutionLaneError("sqlite_lane_crashed", "SQLite execution lane crashed.");
    error.cause = cause;
    const causeCode = errorText(cause, "code");
    crashDetails = Object.freeze({
      causeCode: /^[A-Z][A-Z0-9_]{1,79}$/u.test(causeCode)
        ? causeCode
        : "sqlite_worker_error",
      owner: selectedOwner
    });
    error.details = crashDetails;
    rejectAll(error);
  });
  worker.on("exit", (code: number): void => {
    if (!closed && code !== 0) crashed = true;
    closed = true;
    rejectAll(closedError());
  });

  function execute(
    command: string,
    payload: unknown = {},
    options: { deadlineMs?: number; revision?: number } = {}
  ): Promise<unknown> {
    if (closed) return Promise.reject(closedError());
    const kind = String(command || "");
    if (!allowed.has(kind)) return Promise.reject(new SqliteExecutionLaneError("sqlite_lane_command_rejected"));
    const payloadRecord = record(payload);
    if (typeof payload === "function" || typeof payloadRecord.sql === "string" || typeof payloadRecord.path === "string") {
      return Promise.reject(new SqliteExecutionLaneError("sqlite_lane_payload_rejected"));
    }
    const frozenPayload: unknown = structuredClone(payload);
    const bytes = byteLength(frozenPayload);
    if (pending.size >= maxPending || pendingBytes + bytes > maxPendingBytes) {
      return Promise.reject(new SqliteExecutionLaneError("sqlite_lane_capacity_exceeded"));
    }
    const deadlineMs = Math.max(1, Math.min(Number(options.deadlineMs || defaultDeadlineMs), 300_000));
    const id = ++sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout((): void => {
        const entry = pending.get(id);
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
        owner: selectedOwner,
        kind,
        payload: frozenPayload,
        deadlineAtMs: Date.now() + deadlineMs,
        revision: Number(options.revision || 0)
      }));
    });
  }

  async function close(): Promise<void> {
    if (closed) return;
    try {
      await execute("close", {}, { deadlineMs: defaultDeadlineMs });
      closed = true;
      const exitCode: number = await workerExit;
      if (exitCode !== 0) {
        crashed = true;
        throw closedError();
      }
    } catch (error: unknown) {
      closed = true;
      await worker.terminate();
      throw error;
    }
  }

  return Object.freeze({
    execute,
    close,
    getStats(): Readonly<SqliteExecutionLaneStats> {
      return Object.freeze({
        owner: selectedOwner,
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
