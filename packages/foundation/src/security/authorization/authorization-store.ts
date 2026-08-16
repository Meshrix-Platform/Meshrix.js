import { createSqliteExecutionLane } from "../../storage/sqlite-execution-lane.ts";

const COMMANDS: readonly string[] = Object.freeze([
  "appendDecision", "appendReceipt", "appendLoanRecord", "appendDeniedRequest",
  "listDecisions", "listReceipts", "listLoanRecords", "listDeniedRequests",
  "getRefactorInstrumentation", "close"
]);

type AuthorizationStoreInput = Record<string, unknown>;
type AuthorizationLane = ReturnType<typeof createSqliteExecutionLane>;

export interface AuthorizationStore {
  readonly lane: AuthorizationLane;
  appendDecision(decision?: AuthorizationStoreInput): Promise<unknown>;
  appendReceipt(record?: AuthorizationStoreInput, metadata?: AuthorizationStoreInput): Promise<unknown>;
  appendLoanRecord(record?: AuthorizationStoreInput, metadata?: AuthorizationStoreInput): Promise<unknown>;
  appendDeniedRequest(record?: AuthorizationStoreInput): Promise<unknown>;
  listDecisions(input?: AuthorizationStoreInput): Promise<unknown>;
  listReceipts(input?: AuthorizationStoreInput): Promise<unknown>;
  listLoanRecords(input?: AuthorizationStoreInput): Promise<unknown>;
  listDeniedRequests(input?: AuthorizationStoreInput): Promise<unknown>;
  getRefactorInstrumentation(): Promise<unknown>;
  close(): Promise<unknown>;
  getStats(): unknown;
}

interface AuthorizationStoreOptions {
  userDataPath?: string;
  rootPath?: string;
  maxPending?: number;
  maxPendingBytes?: number;
  defaultDeadlineMs?: number;
}

export function createAuthorizationStore({
  userDataPath = "",
  rootPath = "",
  maxPending = 1024,
  maxPendingBytes = 16 * 1024 * 1024,
  defaultDeadlineMs = 30_000
}: AuthorizationStoreOptions = {}): Readonly<AuthorizationStore> {
  const lane = createSqliteExecutionLane({
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
  const execute = (kind: string, payload: AuthorizationStoreInput = {}): Promise<unknown> => lane.execute(kind, payload);
  return Object.freeze({
    lane,
    appendDecision: (decision: AuthorizationStoreInput = {}) => execute("appendDecision", decision),
    appendReceipt: (record: AuthorizationStoreInput = {}, metadata: AuthorizationStoreInput = {}) => execute("appendReceipt", { record, metadata }),
    appendLoanRecord: (record: AuthorizationStoreInput = {}, metadata: AuthorizationStoreInput = {}) => execute("appendLoanRecord", { record, metadata }),
    appendDeniedRequest: (record: AuthorizationStoreInput = {}) => execute("appendDeniedRequest", record),
    listDecisions: (input: AuthorizationStoreInput = {}) => execute("listDecisions", input),
    listReceipts: (input: AuthorizationStoreInput = {}) => execute("listReceipts", input),
    listLoanRecords: (input: AuthorizationStoreInput = {}) => execute("listLoanRecords", input),
    listDeniedRequests: (input: AuthorizationStoreInput = {}) => execute("listDeniedRequests", input),
    getRefactorInstrumentation: () => execute("getRefactorInstrumentation"),
    close: () => lane.close(),
    getStats: () => lane.getStats()
  });
}

let globalAuthorizationStore: Readonly<AuthorizationStore> | null = null;

export function getGlobalAuthorizationStore(): Readonly<AuthorizationStore> {
  if (!globalAuthorizationStore) globalAuthorizationStore = createAuthorizationStore();
  return globalAuthorizationStore;
}
