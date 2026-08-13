import { parentPort, workerData } from "node:worker_threads";
import { createAuthorizationStoreWorkerOwner } from "./authorization-store-worker-owner.ts";

const COMMANDS: ReadonlySet<string> = new Set([
  "appendDecision", "appendReceipt", "appendLoanRecord", "appendDeniedRequest",
  "listDecisions", "listReceipts", "listLoanRecords", "listDeniedRequests",
  "getRefactorInstrumentation", "close"
]);
const store: any = createAuthorizationStoreWorkerOwner(workerData);

parentPort?.on("message", async (message?: any) : Promise<void> => {
  const reply: Record<string, any> = { id: message?.id, ok: false };
  try {
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
    } else {
      reply.result = await store[kind](message.payload || {});
    }
    reply.ok = true;
  } catch (error: any) {
    reply.error = {
      name: String(error?.name || "Error"),
      code: String(error?.code || "sqlite_lane_command_failed"),
      message: String(error?.message || "Authorization SQLite command failed."),
      details: {}
    };
  }
  parentPort?.postMessage(reply);
});
