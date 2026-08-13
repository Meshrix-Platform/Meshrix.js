import { createSqliteExecutionLane } from "../../storage/sqlite-execution-lane.ts";

const COMMANDS: readonly string[] = Object.freeze([
  "appendDecision", "appendReceipt", "appendLoanRecord", "appendDeniedRequest",
  "listDecisions", "listReceipts", "listLoanRecords", "listDeniedRequests",
  "getRefactorInstrumentation", "close"
]);

export function createAuthorizationStore({
  userDataPath = "",
  rootPath = "",
  maxPending = 1024,
  maxPendingBytes = 16 * 1024 * 1024,
  defaultDeadlineMs = 30_000
}: Record<string, any> = {}) : Readonly<Record<string, any>> {
  const lane: any = createSqliteExecutionLane({
    owner: "authorization-evidence",
    workerUrl: new URL(
      `./authorization-store-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
      import.meta.url
    ),
    workerData: { userDataPath, rootPath },
    allowedCommands: COMMANDS,
    maxPending,
    maxPendingBytes,
    defaultDeadlineMs
  });
  const execute: any = (kind: string, payload: Record<string, any> = {}) : Promise<any> => lane.execute(kind, payload);
  return Object.freeze({
    lane,
    appendDecision: (decision: Record<string, any> = {}) : Promise<any> => execute("appendDecision", decision),
    appendReceipt: (record: Record<string, any> = {}, metadata: Record<string, any> = {}) : Promise<any> => execute("appendReceipt", { record, metadata }),
    appendLoanRecord: (record: Record<string, any> = {}, metadata: Record<string, any> = {}) : Promise<any> => execute("appendLoanRecord", { record, metadata }),
    appendDeniedRequest: (record: Record<string, any> = {}) : Promise<any> => execute("appendDeniedRequest", record),
    listDecisions: (input: Record<string, any> = {}) : Promise<any> => execute("listDecisions", input),
    listReceipts: (input: Record<string, any> = {}) : Promise<any> => execute("listReceipts", input),
    listLoanRecords: (input: Record<string, any> = {}) : Promise<any> => execute("listLoanRecords", input),
    listDeniedRequests: (input: Record<string, any> = {}) : Promise<any> => execute("listDeniedRequests", input),
    getRefactorInstrumentation: () : Promise<any> => execute("getRefactorInstrumentation"),
    close: () : Promise<any> => lane.close(),
    getStats: () : any => lane.getStats()
  });
}

let globalAuthorizationStore: any = null;

export function getGlobalAuthorizationStore() : any {
  if (!globalAuthorizationStore) globalAuthorizationStore = createAuthorizationStore();
  return globalAuthorizationStore;
}
