import { parentPort, workerData } from "node:worker_threads";
import { createAuthorizationStoreWorkerOwner } from "./authorization-store-worker-owner.ts";

const COMMANDS: ReadonlySet<string> = new Set([
  "appendDecision", "appendReceipt", "appendLoanRecord", "appendDeniedRequest",
  "listDecisions", "listReceipts", "listLoanRecords", "listDeniedRequests",
  "getRefactorInstrumentation", "close"
]);
interface WorkerRequest {
  id?: number;
  kind?: string;
  deadlineAtMs?: number;
  payload?: {
    record?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

interface WorkerReply {
  id?: number;
  ok: boolean;
  result?: unknown;
  error?: {
    name: string;
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

function errorField(error: unknown, field: "name" | "code" | "message"): unknown {
  return error && typeof error === "object" && field in error
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

const store = createAuthorizationStoreWorkerOwner(workerData);

parentPort?.on("message", async (message?: WorkerRequest): Promise<void> => {
  const reply: WorkerReply = { id: message?.id, ok: false };
  try {
    if (!message) {
      throw Object.assign(new Error("Authorization SQLite command is missing."), { code: "sqlite_lane_command_rejected" });
    }
    const kind: string = String(message?.kind || "");
    if (!COMMANDS.has(kind)) {
      throw Object.assign(new Error("Authorization SQLite command is not allowed."), { code: "sqlite_lane_command_rejected" });
    }
    if (Date.now() > Number(message?.deadlineAtMs || 0)) {
      throw Object.assign(new Error("Authorization SQLite command deadline elapsed."), { code: "sqlite_lane_deadline_exceeded" });
    }
    if (kind === "appendReceipt") {
      reply.result = store.appendReceipt(message.payload?.record || {}, message.payload?.metadata || {});
    } else if (kind === "appendLoanRecord") {
      reply.result = store.appendLoanRecord(message.payload?.record || {}, message.payload?.metadata || {});
    } else if (kind === "close") {
      store.close();
    } else if (kind === "appendDecision") {
      reply.result = await store.appendDecision(message.payload || {});
    } else if (kind === "appendDeniedRequest") {
      reply.result = await store.appendDeniedRequest(message.payload || {});
    } else if (kind === "listDecisions") {
      reply.result = await store.listDecisions(message.payload || {});
    } else if (kind === "listReceipts") {
      reply.result = await store.listReceipts(message.payload || {});
    } else if (kind === "listLoanRecords") {
      reply.result = await store.listLoanRecords(message.payload || {});
    } else if (kind === "listDeniedRequests") {
      reply.result = await store.listDeniedRequests(message.payload || {});
    } else if (kind === "getRefactorInstrumentation") {
      reply.result = await store.getRefactorInstrumentation();
    }
    reply.ok = true;
  } catch (error: unknown) {
    reply.error = {
      name: String(errorField(error, "name") || "Error"),
      code: String(errorField(error, "code") || "sqlite_lane_command_failed"),
      message: String(errorField(error, "message") || "Authorization SQLite command failed."),
      details: {}
    };
  }
  parentPort?.postMessage(reply);
});
