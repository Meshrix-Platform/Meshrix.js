import { createSqliteExecutionLane } from "../storage/sqlite-execution-lane.ts";
import type { SqliteExecutionLane } from "../storage/sqlite-execution-lane.ts";

interface WorkQueueLaneOptions {
  userDataPath?: string;
  databasePath?: string;
  policy?: unknown;
  maxPending?: number;
  maxPendingBytes?: number;
}

export type SqliteWorkQueueLaneStore = Readonly<
  Record<string, unknown> & {
    lane: Readonly<SqliteExecutionLane>;
    databasePath: string;
  }
>;

const COMMANDS: readonly string[] = Object.freeze([
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

export function createSqliteWorkQueueLane(
  options: WorkQueueLaneOptions = {},
): SqliteWorkQueueLaneStore {
  const lane = createSqliteExecutionLane({
    owner: "work-queue",
    workerUrl: new URL(
      `./sqlite-store-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
      import.meta.url,
    ),
    workerData: {
      userDataPath: options.userDataPath,
      databasePath: options.databasePath,
      policy: options.policy,
    },
    allowedCommands: COMMANDS,
    maxPending: Number(options.maxPending || 2048),
    maxPendingBytes: Number(options.maxPendingBytes || 32 * 1024 * 1024),
  });
  const store: Record<string, unknown> & {
    lane: Readonly<SqliteExecutionLane>;
    databasePath: string;
  } = { lane, databasePath: options.databasePath || "" };
  for (const command of COMMANDS) {
    store[command] =
      command === "close"
        ? () => lane.close()
        : (input: Record<string, unknown> = {}) => lane.execute(command, input);
  }
  return Object.freeze(store);
}
