import { parentPort, workerData } from "node:worker_threads";
import { createSqliteWorkQueueStore } from "./sqlite-store.ts";

const store: any = createSqliteWorkQueueStore(workerData);
const allowed: any = new Set<any>([
  "enqueue", "claim", "complete", "retry", "progress", "checkpoint", "expire",
  "cancel", "cancelRunning", "fail", "recover", "markInDoubt", "acknowledgeTermination",
  "recordSinkReceipt", "reconcileInDoubt", "inspect", "rebuildProjection",
  "registerQueueDefinition", "setQueueControl", "pause", "resume", "drain",
  "getQueueControl", "recordBackgroundWrite", "writeFallbackCoordinatorState",
  "writeSnapshotState", "writeCompactionState", "writeInternalHealthState", "isClosed", "close"
]);

parentPort?.on("message", async (message?: any) : Promise<any> => {
  const reply: any = { id: message?.id, ok: false };
  try {
    if (!allowed.has(message?.kind) || typeof store[message.kind] !== "function") {
      throw Object.assign(new Error("Queue SQLite command is not allowed."), { code: "sqlite_lane_command_rejected" });
    }
    if (Date.now() > Number(message.deadlineAtMs || 0)) {
      throw Object.assign(new Error("Queue SQLite command deadline elapsed."), { code: "sqlite_lane_deadline_exceeded" });
    }
    reply.result = await store[message.kind](message.payload);
    reply.ok = true;
  } catch (error: any) {
    reply.error = { code: String(error?.code || "sqlite_lane_command_failed"), message: String(error?.message || "Queue SQLite command failed.") };
  }
  parentPort?.postMessage(reply);
});
