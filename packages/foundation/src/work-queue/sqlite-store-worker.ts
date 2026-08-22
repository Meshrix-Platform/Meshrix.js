import { parentPort, workerData } from "node:worker_threads";
import { createSqliteWorkQueueStore } from "./sqlite-store.ts";

type WorkerRecord = Record<string, unknown>;
type QueueCommand = (payload?: unknown) => unknown | Promise<unknown>;
interface LaneReply {
  id: unknown;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}
interface WorkerFailure extends Error {
  code?: string;
}
function record(value: unknown): WorkerRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkerRecord)
    : null;
}
function failure(value: unknown): WorkerFailure | null {
  return value instanceof Error ? (value as WorkerFailure) : null;
}

const concreteStore = createSqliteWorkQueueStore(workerData);
const store: Readonly<Record<string, unknown>> = { ...concreteStore };
const allowed = new Set<string>([
  "enqueue",
  "claim",
  "complete",
  "retry",
  "progress",
  "checkpoint",
  "expire",
  "cancel",
  "cancelRunning",
  "fail",
  "recover",
  "markInDoubt",
  "acknowledgeTermination",
  "recordSinkReceipt",
  "reconcileInDoubt",
  "inspect",
  "rebuildProjection",
  "registerQueueDefinition",
  "setQueueControl",
  "pause",
  "resume",
  "drain",
  "getQueueControl",
  "recordBackgroundWrite",
  "writeFallbackCoordinatorState",
  "writeSnapshotState",
  "writeCompactionState",
  "writeInternalHealthState",
  "isClosed",
  "close",
]);

parentPort?.on("message", async (message: unknown): Promise<void> => {
  const request = record(message);
  const reply: LaneReply = { id: request?.id, ok: false };
  const closeAfterReply: boolean = request?.kind === "close";
  try {
    const kind = typeof request?.kind === "string" ? request.kind : "";
    const command = store[kind];
    if (!allowed.has(kind) || typeof command !== "function") {
      throw Object.assign(new Error("Queue SQLite command is not allowed."), {
        code: "sqlite_lane_command_rejected",
      });
    }
    if (Date.now() > Number(request?.deadlineAtMs || 0)) {
      throw Object.assign(new Error("Queue SQLite command deadline elapsed."), {
        code: "sqlite_lane_deadline_exceeded",
      });
    }
    reply.result = await (command as QueueCommand)(request?.payload);
    reply.ok = true;
  } catch (error: unknown) {
    const observed = failure(error);
    reply.error = {
      code: String(observed?.code || "sqlite_lane_command_failed"),
      message: String(observed?.message || "Queue SQLite command failed."),
    };
  }
  parentPort?.postMessage(reply);
  if (reply.ok && closeAfterReply) parentPort?.close();
});
