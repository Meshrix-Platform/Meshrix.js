import { Worker } from "node:worker_threads";

export const CONTEXT_COMPACTION_MAX_INPUT_BYTES: number = 16 * 1024 * 1024;
export const CONTEXT_COMPACTION_WORKER_THRESHOLD_BYTES: number = 512 * 1024;

export class ContextCompactionLaneError extends Error {
  code: string;
  constructor(code?: string, message?: unknown) {
    super(String(message || code || "context_compaction_lane_failed"));
    this.name = "ContextCompactionLaneError";
    this.code = String(code || "context_compaction_lane_failed");
  }
}

export interface ContextCompactionExecutionLaneOptions {
  maxPending?: number;
  maxPendingBytes?: number;
  defaultDeadlineMs?: number;
}

export interface ContextCompactionNormalizeOptions {
  bytes?: number;
  deadlineMs?: number;
}

export interface ContextCompactionExecutionLaneStats {
  pending: number;
  pendingBytes: number;
  maxPending: number;
  maxPendingBytes: number;
  closed: boolean;
}

export interface ContextCompactionExecutionLane {
  normalize(payload: unknown, options?: ContextCompactionNormalizeOptions): Promise<unknown>;
  close(): Promise<void>;
  getStats(): ContextCompactionExecutionLaneStats;
}

interface LaneWorkerMessage {
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
}

interface PendingLaneEntry {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  bytes: number;
}

export function conversationPayload(input: Record<string, unknown> = {}) : Record<string, unknown> {
  if (Array.isArray(input.messages)) return { messages: input.messages };
  if (Array.isArray(input.transcript)) return { transcript: input.transcript };
  return {
    history: input.history,
    compressedHistory: input.compressedHistory,
    recentTurns: input.recentTurns,
    toolState: input.toolState
  };
}

export function conversationPayloadBytes(input: Record<string, unknown> = {}) : number {
  const payload = conversationPayload(input);
  let bytes: number = 2;
  for (const [key, value] of Object.entries(payload)) {
    bytes += Buffer.byteLength(key, "utf8") + 4;
    if (Array.isArray(value)) {
      bytes += 2;
      for (const item of value) bytes += Buffer.byteLength(JSON.stringify(item ?? null), "utf8") + 1;
    } else {
      bytes += Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
    }
    if (bytes > CONTEXT_COMPACTION_MAX_INPUT_BYTES) {
      throw new ContextCompactionLaneError(
        "context_compaction_input_bytes_exceeded",
        "Context compaction input exceeds the authorized byte limit."
      );
    }
  }
  return bytes;
}

export function createContextCompactionExecutionLane({
  maxPending = 4,
  maxPendingBytes = 32 * 1024 * 1024,
  defaultDeadlineMs = 30_000
}: ContextCompactionExecutionLaneOptions = {}) : ContextCompactionExecutionLane {
  const worker = new Worker(new URL(
    `./execution-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
    import.meta.url
  ));
  const pending: Map<number, PendingLaneEntry> = new Map();
  let sequence: number = 0;
  let pendingBytes: number = 0;
  let closed: boolean = false;

  function rejectAll(error?: unknown) : void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    pendingBytes = 0;
  }

  worker.on("message", (message: LaneWorkerMessage) : void => {
    const entry = pending.get(Number(message?.id));
    if (!entry) return;
    pending.delete(Number(message.id));
    pendingBytes -= entry.bytes;
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new ContextCompactionLaneError(message.error?.code, message.error?.message));
  });
  worker.on("error", () : void => {
    closed = true;
    rejectAll(new ContextCompactionLaneError("context_compaction_lane_crashed"));
  });
  worker.on("exit", () : void => {
    closed = true;
    rejectAll(new ContextCompactionLaneError("context_compaction_lane_closed"));
  });

  function normalize(payload: unknown, { bytes, deadlineMs = defaultDeadlineMs }: ContextCompactionNormalizeOptions = {}) : Promise<unknown> {
    if (closed) return Promise.reject(new ContextCompactionLaneError("context_compaction_lane_closed"));
    const admittedBytes = Math.max(0, Number(bytes) || 0);
    if (pending.size >= maxPending || pendingBytes + admittedBytes > maxPendingBytes) {
      return Promise.reject(new ContextCompactionLaneError("context_compaction_lane_capacity_exceeded"));
    }
    const boundedDeadlineMs = Math.max(1, Math.min(Number(deadlineMs) || defaultDeadlineMs, 120_000));
    const id = ++sequence;
    return new Promise<unknown>((resolve: (value: unknown) => void, reject: (reason?: unknown) => void) : void => {
      const timer = setTimeout(() : void => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        pendingBytes -= entry.bytes;
        reject(new ContextCompactionLaneError("context_compaction_lane_deadline_exceeded"));
      }, boundedDeadlineMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, bytes: admittedBytes });
      pendingBytes += admittedBytes;
      worker.postMessage(Object.freeze({
        id,
        kind: "normalize",
        payload: structuredClone(payload),
        deadlineAtMs: Date.now() + boundedDeadlineMs
      }));
    });
  }

  async function close() : Promise<void> {
    if (closed) return;
    closed = true;
    rejectAll(new ContextCompactionLaneError("context_compaction_lane_closed"));
    await worker.terminate();
  }

  return Object.freeze({
    normalize,
    close,
    getStats: () : ContextCompactionExecutionLaneStats => Object.freeze({ pending: pending.size, pendingBytes, maxPending, maxPendingBytes, closed })
  });
}
