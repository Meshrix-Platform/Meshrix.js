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
  bytes: number;
  command: string;
  payload: unknown;
  revision: number;
  deadlineAtMs?: number;
  timer?: NodeJS.Timeout;
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
  ready(): Promise<void>;
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
  requiresReadyHandshake?: boolean;
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

function remoteError(incoming: DataRecord): SqliteExecutionLaneError {
  const source = record(incoming.error);
  const error = new SqliteExecutionLaneError(
    String(source.code || "sqlite_lane_command_failed"),
    String(source.message || "SQLite lane command failed.")
  );
  error.remoteName = String(source.name || "Error");
  error.details = Object.freeze({ ...record(source.details) });
  if (Number(source.statusCode || 0) > 0) error.statusCode = Number(source.statusCode);
  if (String(source.field || "")) error.field = String(source.field);
  return error;
}

/**
 * Bounded single-writer RPC lane for one typed SQLite owner worker. Commands
 * are serialized in FIFO order. Explicit deadlines apply only while a command
 * waits in this queue; once dispatched, the lane retains ownership until the
 * worker returns its actual result.
 */
export function createSqliteExecutionLane({
  owner,
  workerUrl,
  workerData = {},
  allowedCommands = [],
  hostHandlers = {},
  maxPending = 1024,
  maxPendingBytes = 16 * 1024 * 1024,
  requiresReadyHandshake = false
}: SqliteExecutionLaneOptions = {}): Readonly<SqliteExecutionLane> {
  if (!(typeof workerUrl === "string" || workerUrl instanceof URL)) {
    throw new TypeError("SQLite execution lane requires a worker URL.");
  }
  const selectedOwner = String(owner || "sqlite");
  const allowed = new Set(allowedCommands.map(String));
  const hostHandlerByKind = new Map<string, HostHandler>(
    Object.entries(hostHandlers).filter((entry): entry is [string, HostHandler] => typeof entry[1] === "function")
  );
  const worker = new Worker(workerUrl as string | import("url").URL, { workerData });
  const workerExit: Promise<number> = new Promise((resolve): void => {
    worker.once("exit", resolve);
  });
  const pending = new Map<number, PendingEntry>();
  const queue: number[] = [];
  const hostHandlerTasks = new Set<Promise<void>>();
  let resolveWorkerReady!: () => void;
  let rejectWorkerReady!: (error: unknown) => void;
  let workerReadyState: "pending" | "ready" | "failed" = requiresReadyHandshake ? "pending" : "ready";
  const workerReady = new Promise<void>((resolve, reject) => {
    resolveWorkerReady = resolve;
    rejectWorkerReady = reject;
    if (!requiresReadyHandshake) resolve();
  });
  void workerReady.catch(() => {});

  let sequence = 0;
  let pendingBytes = 0;
  let activeId: number | null = null;
  let closeId: number | null = null;
  let closeResolve: (() => void) | null = null;
  let closeReject: ((error: unknown) => void) | null = null;
  let closePromise: Promise<void> | null = null;
  let closing = false;
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
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    queue.length = 0;
    activeId = null;
    pendingBytes = 0;
  }

  function finishClose(error?: unknown): void {
    const resolve = closeResolve;
    const reject = closeReject;
    closeResolve = null;
    closeReject = null;
    if (error !== undefined) reject?.(error);
    else resolve?.();
  }

  async function waitForHostHandlers(): Promise<void> {
    while (hostHandlerTasks.size > 0) {
      await Promise.all(Array.from(hostHandlerTasks));
    }
  }

  function removeQueued(id: number): void {
    const index = queue.indexOf(id);
    if (index >= 0) queue.splice(index, 1);
  }

  function removePending(id: number): PendingEntry | undefined {
    const entry = pending.get(id);
    if (!entry) return undefined;
    pending.delete(id);
    pendingBytes -= entry.bytes;
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  }

  function armQueueDeadline(id: number, entry: PendingEntry): void {
    if (entry.deadlineAtMs === undefined || activeId === id || !pending.has(id)) return;
    const remainingMs = entry.deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      removeQueued(id);
      removePending(id)?.reject(new SqliteExecutionLaneError("sqlite_lane_deadline_exceeded"));
      dispatchNext();
      return;
    }
    // Node timers have a platform-sized maximum; longer explicit deadlines are
    // re-armed after each timer turn until their queue deadline is reached.
    entry.timer = setTimeout(() => armQueueDeadline(id, entry), Math.min(remainingMs, 2_147_483_647));
    entry.timer.unref?.();
  }

  function failLane(error: unknown, causeCode = "sqlite_worker_error"): void {
    crashed = true;
    closed = true;
    const errorRecord = record(error);
    const observedCauseCode = String(errorRecord.code || causeCode);
    crashDetails = Object.freeze({
      causeCode: /^[A-Z][A-Z0-9_]{1,79}$/u.test(observedCauseCode) ? observedCauseCode : causeCode,
      owner: selectedOwner
    });
    rejectAll(error);
    finishClose(error);
  }

  function dispatchNext(): void {
    if (closed || workerReadyState !== "ready" || activeId !== null) return;
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) return;
      const entry = pending.get(id);
      if (!entry) continue;
      if (entry.deadlineAtMs !== undefined && Date.now() >= entry.deadlineAtMs) {
        removePending(id)?.reject(new SqliteExecutionLaneError("sqlite_lane_deadline_exceeded"));
        continue;
      }
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      activeId = id;
      try {
        worker.postMessage(Object.freeze({
          id,
          owner: selectedOwner,
          kind: entry.command,
          payload: entry.payload,
          deadlineAtMs: entry.deadlineAtMs || 0,
          revision: entry.revision
        }));
      } catch (error: unknown) {
        failLane(error, "sqlite_worker_post_failed");
      }
      return;
    }

    if (closing && closeId === null) {
      const id = ++sequence;
      closeId = id;
      activeId = id;
      try {
        worker.postMessage(Object.freeze({
          id,
          owner: selectedOwner,
          kind: "close",
          payload: {},
          deadlineAtMs: 0,
          revision: 0
        }));
      } catch (error: unknown) {
        failLane(error, "sqlite_worker_post_failed");
      }
    }
  }

  worker.on("message", async (message: unknown): Promise<void> => {
    const incoming = record(message);
    if (incoming.type === "worker-start-error") {
      if (workerReadyState === "pending") {
        workerReadyState = "failed";
        const code = /^operation_audit_[a-z0-9_]{1,80}$/u.test(String(incoming.code || ""))
          ? String(incoming.code)
          : "sqlite_worker_start_failed";
        const error = new SqliteExecutionLaneError(code, "SQLite owner worker could not finish startup.");
        rejectWorkerReady(error);
        closed = true;
        rejectAll(error);
        finishClose(error);
      }
      return;
    }
    if (incoming.type === "worker-ready") {
      if (workerReadyState === "pending") {
        workerReadyState = "ready";
        resolveWorkerReady();
        dispatchNext();
      }
      return;
    }
    if (incoming.type === "host-call") {
      const kind = String(incoming.kind || "");
      const handler = hostHandlerByKind.get(kind);
      if (!handler) {
        try {
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
        } catch (error: unknown) {
          if (!closed) failLane(error, "sqlite_worker_post_failed");
        }
        return;
      }
      const task = (async (): Promise<void> => {
        let response: Record<string, unknown>;
        try {
          const result = await handler(structuredClone(incoming.payload ?? {}));
          response = { type: "host-response", id: incoming.id, ok: true, result };
        } catch (error: unknown) {
          const errorRecord = record(error);
          response = {
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
          };
        }
        if (closed) return;
        try {
          worker.postMessage(response);
        } catch (error: unknown) {
          if (!closed) failLane(error, "sqlite_worker_post_failed");
        }
      })();
      hostHandlerTasks.add(task);
      void task.finally(() => hostHandlerTasks.delete(task));
      return;
    }

    const id = typeof incoming.id === "number" ? incoming.id : -1;
    if (closeId === id) {
      activeId = null;
      if (incoming.ok) {
        closed = true;
        finishClose();
      } else {
        finishClose(remoteError(incoming));
      }
      return;
    }
    if (activeId !== id) return;
    const entry = removePending(id);
    activeId = null;
    if (!entry) {
      dispatchNext();
      return;
    }
    if (incoming.ok) entry.resolve(incoming.result);
    else entry.reject(remoteError(incoming));
    dispatchNext();
  });

  worker.on("error", (cause: Error): void => {
    if (workerReadyState === "pending") {
      workerReadyState = "failed";
      rejectWorkerReady(cause);
    }
    failLane(cause);
  });
  worker.on("exit", (code: number): void => {
    if (!closed && code !== 0) crashed = true;
    closed = true;
    const error = closedError();
    if (workerReadyState === "pending") {
      workerReadyState = "failed";
      rejectWorkerReady(error);
    }
    rejectAll(error);
    if (closing) finishClose(error);
  });

  function enqueue(
    command: string,
    payload: unknown = {},
    options: { deadlineMs?: number; revision?: number } = {}
  ): Promise<unknown> {
    if (closed || closing) return Promise.reject(closedError());
    const kind = String(command || "");
    if (!allowed.has(kind) || kind === "close") {
      return Promise.reject(new SqliteExecutionLaneError("sqlite_lane_command_rejected"));
    }
    const payloadRecord = record(payload);
    if (typeof payload === "function" || typeof payloadRecord.sql === "string" || typeof payloadRecord.path === "string") {
      return Promise.reject(new SqliteExecutionLaneError("sqlite_lane_payload_rejected"));
    }
    let frozenPayload: unknown;
    let bytes: number;
    try {
      frozenPayload = structuredClone(payload);
      bytes = byteLength(frozenPayload);
    } catch {
      return Promise.reject(new SqliteExecutionLaneError("sqlite_lane_payload_rejected"));
    }
    if (pending.size >= maxPending || pendingBytes + bytes > maxPendingBytes) {
      return Promise.reject(new SqliteExecutionLaneError("sqlite_lane_capacity_exceeded"));
    }
    const requestedDeadline = options.deadlineMs === undefined ? undefined : Number(options.deadlineMs);
    if (requestedDeadline !== undefined && (!Number.isFinite(requestedDeadline) || requestedDeadline < 0)) {
      return Promise.reject(new SqliteExecutionLaneError("sqlite_lane_deadline_invalid"));
    }
    const deadlineAtMs = requestedDeadline && requestedDeadline > 0
      ? Date.now() + requestedDeadline
      : undefined;
    if (deadlineAtMs !== undefined && !Number.isSafeInteger(Math.trunc(deadlineAtMs))) {
      return Promise.reject(new SqliteExecutionLaneError("sqlite_lane_deadline_invalid"));
    }

    const id = ++sequence;
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingEntry = {
        resolve,
        reject,
        bytes,
        command: kind,
        payload: frozenPayload,
        revision: Number(options.revision || 0),
        ...(deadlineAtMs !== undefined ? { deadlineAtMs } : {})
      };
      pending.set(id, entry);
      pendingBytes += bytes;
      queue.push(id);
      if (deadlineAtMs !== undefined) armQueueDeadline(id, entry);
      dispatchNext();
    });
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    if (closed) {
      closePromise = waitForHostHandlers();
      return closePromise;
    }
    closing = true;
    closePromise = workerReady.then(async (): Promise<void> => {
      if (closed) return;
      const completion = new Promise<void>((resolve, reject) => {
        closeResolve = resolve;
        closeReject = reject;
      });
      dispatchNext();
      await completion;
      const exitCode = await workerExit;
      if (exitCode !== 0) {
        crashed = true;
        throw closedError();
      }
    }).catch(async (error: unknown): Promise<void> => {
      closed = true;
      rejectAll(error);
      await waitForHostHandlers();
      await worker.terminate();
      throw error;
    });
    return closePromise;
  }

  return Object.freeze({
    execute: enqueue,
    ready: () => workerReady,
    close,
    getStats(): Readonly<SqliteExecutionLaneStats> {
      return Object.freeze({
        owner: selectedOwner,
        pending: pending.size,
        pendingBytes,
        maxPending,
        maxPendingBytes,
        writerWorkers: closed ? 0 : 1,
        closed: closed || closing,
        crashed
      });
    }
  });
}
