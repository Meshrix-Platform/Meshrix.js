import { createSqliteExecutionLane } from "../storage/sqlite-execution-lane.ts";

const COMMANDS: readonly any[] = Object.freeze([
  "enqueue", "claim", "complete", "retry", "progress", "checkpoint", "expire",
  "cancel", "cancelRunning", "fail", "recover", "markInDoubt", "acknowledgeTermination",
  "recordSinkReceipt", "reconcileInDoubt", "inspect", "rebuildProjection",
  "registerQueueDefinition", "setQueueControl", "pause", "resume", "drain",
  "getQueueControl", "recordBackgroundWrite", "writeFallbackCoordinatorState",
  "writeSnapshotState", "writeCompactionState", "writeInternalHealthState", "isClosed", "close"
]);

export function createSqliteWorkQueueLane(options: Record<string, any> = {}) : any {
  const lane: any = createSqliteExecutionLane({
    owner: "work-queue",
    workerUrl: new URL(
      `./sqlite-store-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
      import.meta.url
    ),
    workerData: { userDataPath: options.userDataPath, databasePath: options.databasePath, policy: options.policy },
    allowedCommands: COMMANDS,
    maxPending: Number(options.maxPending || 2048),
    maxPendingBytes: Number(options.maxPendingBytes || 32 * 1024 * 1024)
  });
  const store: any = { lane, databasePath: options.databasePath || "" };
  for (const command of COMMANDS) {
    store[command] = command === "close"
      ? () : any => lane.close()
      : (input: Record<string, any> = {}) : any => lane.execute(command, input);
  }
  return Object.freeze(store);
}
