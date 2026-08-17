import crypto from "node:crypto";

import { sandboxDigest } from "#meshrix/foundation/execution-sandbox/contracts";

export const SANDBOX_EXECUTION_PORT_ID = "SandboxExecutionPort";
export const SANDBOX_EXECUTION_QUEUE_DEFINITION_ID = "platform.sandbox-execution";

const QUEUE_DEFINITION_VERSION = 1;
const MAX_PENDING_EXECUTIONS = 4096;
const QUEUE_SCOPE = Object.freeze({ tenantId: "", workspaceId: "", projectId: "" });

interface SandboxReceiptLike { runtimeState?: string; status?: string; reasonCode?: string }
interface ExecutionOptions { signal?: AbortSignal; [key: string]: unknown }
type ExecutionTask = (signal?: AbortSignal) => Promise<unknown>;

interface PendingExecution {
  contextRef: string;
  workItemId: string;
  dedupeKey: string;
  promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  task: ExecutionTask;
  settled: boolean;
}

interface QueueWorkItem { payloadRef?: { contextRef?: string } }
interface QueueHandlerContext { signal?: AbortSignal }
interface QueueRegistration {
  enqueue(input: Record<string, unknown>): Promise<unknown>;
  requestDispatch(): Promise<unknown>;
  cancel(input: { workItemId: string; reason: string }): Promise<{ cancelled?: boolean }>;
  close(): Promise<void>;
}
interface QueueApplicationPort {
  registerQueue(input: Record<string, unknown>): Promise<QueueRegistration>;
}
interface SandboxBroker {
  execute(request: unknown, options?: ExecutionOptions): Promise<unknown>;
  executeConfigured(request: unknown, resolveInput?: unknown, options?: ExecutionOptions): Promise<unknown>;
  executeOpaque(request: unknown, inputs?: readonly unknown[], options?: ExecutionOptions): Promise<unknown>;
  executeConfiguredOpaque(request: unknown, inputs?: readonly unknown[], options?: ExecutionOptions): Promise<unknown>;
  cancel(reference: unknown, options?: Record<string, unknown>): Promise<boolean>;
  recover(): Promise<unknown>;
  close(): Promise<void>;
  getStatus: (...args: unknown[]) => unknown;
  getReceipt: (...args: unknown[]) => unknown;
  resolveQuarantinedOutput: (...args: unknown[]) => unknown;
  disposeOutput: (...args: unknown[]) => unknown;
  configurationState: (...args: unknown[]) => unknown;
  publicAvailability: (...args: unknown[]) => unknown;
  administrativeAvailability: (...args: unknown[]) => unknown;
  requiredBackendRestrictions: (...args: unknown[]) => unknown;
}

interface QueuedSandboxExecutionOptions {
  broker?: SandboxBroker;
  queueApplicationPort?: QueueApplicationPort;
  maxInFlight?: number;
}

function requestDeadline(request: unknown): string {
  return request !== null && typeof request === "object" && "deadlineAt" in request
    ? String(request.deadlineAt || "")
    : "";
}

function combinedSignal(left?: AbortSignal, right?: AbortSignal): AbortSignal | undefined {
  const signals = [left, right].filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function queueIdentity(kind: string, request: unknown) {
  const digest = sandboxDigest({ kind, request });
  const dispatchRef = crypto.randomUUID();
  return Object.freeze({
    contextRef: digest,
    workItemId: `sandbox-work:${digest.slice(0, 32)}:${dispatchRef}`,
    dedupeKey: `sandbox-execution:${digest}:${dispatchRef}`
  });
}

function terminalAction(receipt: SandboxReceiptLike): "cancelled" | "failed" | "completed" {
  if (receipt.runtimeState === "cancelled") return "cancelled";
  if (receipt.runtimeState === "timed_out") return "failed";
  return receipt.status === "failed" || receipt.status === "denied" ? "failed" : "completed";
}

function receiptLike(value: unknown): SandboxReceiptLike {
  return value !== null && typeof value === "object" ? value : {};
}

export async function createQueuedSandboxExecutionPort({
  broker,
  queueApplicationPort,
  maxInFlight = 64
}: QueuedSandboxExecutionOptions = {}) {
  if (!broker) throw new TypeError("Queued sandbox execution requires the canonical broker.");
  if (!queueApplicationPort) throw new TypeError("Queued sandbox execution requires the canonical queue application port.");
  const pending = new Map<string, PendingExecution>();
  let closing = false;
  const queue = await queueApplicationPort.registerQueue({
    queueDefinitionId: SANDBOX_EXECUTION_QUEUE_DEFINITION_ID,
    queueDefinitionVersion: QUEUE_DEFINITION_VERSION,
    label: "Controlled sandbox execution",
    ownerCapability: "platform.controlled-execution",
    metadata: { lifecycleStateOwner: "queue-application-port", executionStateOwner: "sandbox-execution-broker" },
    policy: { policyVersion: "meshrix.sandbox-execution-queue-policy/1", maxInFlight, maxAttempts: 1 },
    scope: QUEUE_SCOPE,
    workerId: "platform-sandbox-execution-worker",
    maxInFlight,
    batchSize: Math.min(16, maxInFlight),
    onTerminal: ({ workItem }: { workItem: QueueWorkItem }) => {
      const record = pending.get(String(workItem.payloadRef?.contextRef || ""));
      if (!record || record.settled) return;
      record.settled = true;
      pending.delete(record.contextRef);
      record.reject(Object.assign(new Error("Sandbox execution queue reached a terminal state."), {
        code: "sandbox_execution_queue_terminal"
      }));
    },
    handler: async ({ workItem }: { workItem: QueueWorkItem }, context?: QueueHandlerContext) => {
      const contextRef = String(workItem.payloadRef?.contextRef || "");
      const record = pending.get(contextRef);
      if (!record || record.settled) return { action: "failed", reason: "sandbox_execution_context_unavailable" };
      try {
        const receipt = await record.task(context?.signal);
        record.settled = true;
        pending.delete(contextRef);
        record.resolve(receipt);
        const terminal = receiptLike(receipt);
        return { action: terminalAction(terminal), reason: String(terminal.reasonCode || "sandbox_execution_terminal") };
      } catch (error: unknown) {
        record.settled = true;
        pending.delete(contextRef);
        record.reject(error);
        return { action: "failed", reason: "sandbox_execution_failed" };
      }
    }
  });

  async function dispatch(kind: string, request: unknown, task: ExecutionTask, deadlineAt = ""): Promise<unknown> {
    if (closing) throw new Error("Sandbox execution port is closing.");
    const identity = queueIdentity(kind, request);
    const existing = pending.get(identity.contextRef);
    if (existing) return existing.promise;
    if (pending.size >= MAX_PENDING_EXECUTIONS) {
      throw Object.assign(new Error("Sandbox execution queue capacity is exhausted."), {
        code: "sandbox_execution_queue_capacity_exhausted"
      });
    }
    let resolvePromise!: (value: unknown) => void;
    let rejectPromise!: (reason: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const record: PendingExecution = {
      ...identity, promise, resolve: resolvePromise, reject: rejectPromise, task, settled: false
    };
    pending.set(identity.contextRef, record);
    try {
      const parsedDeadline = Date.parse(deadlineAt);
      await queue.enqueue({
        schedulingScope: QUEUE_SCOPE,
        dedupeKey: identity.dedupeKey,
        workItemId: identity.workItemId,
        payloadRef: Object.freeze({ kind, contextRef: identity.contextRef }),
        payloadKind: "sandbox_execution",
        ownerRef: { capability: "platform.controlled-execution" },
        maxAttempts: 1,
        ...(Number.isFinite(parsedDeadline) ? { expiresAtMs: parsedDeadline } : {}),
        actor: { system: "sandbox-execution-port" },
        reason: "sandbox_execution_queued",
        policyVersion: "meshrix.sandbox-execution-queue-policy/1"
      });
      void queue.requestDispatch().catch((error: unknown) => {
        if (record.settled) return;
        record.settled = true;
        pending.delete(identity.contextRef);
        rejectPromise(error);
      });
    } catch (error: unknown) {
      pending.delete(identity.contextRef);
      record.settled = true;
      rejectPromise(error);
    }
    return promise;
  }

  const withSignal = (options: ExecutionOptions, queueSignal?: AbortSignal): ExecutionOptions => ({
    ...options,
    signal: combinedSignal(options.signal, queueSignal)
  });
  const execute = (request: unknown, options: ExecutionOptions = {}) => dispatch(
    "execute", request, (signal) => broker.execute(request, withSignal(options, signal)), requestDeadline(request)
  );
  const executeConfigured = (request: unknown, resolveInput?: unknown, options: ExecutionOptions = {}) => dispatch(
    "executeConfigured", request,
    (signal) => broker.executeConfigured(request, resolveInput, withSignal(options, signal)), requestDeadline(request)
  );
  const executeOpaque = (request: unknown, inputs: readonly unknown[] = [], options: ExecutionOptions = {}) => dispatch(
    "executeOpaque", request, (signal) => broker.executeOpaque(request, inputs, withSignal(options, signal)), requestDeadline(request)
  );
  const executeConfiguredOpaque = (
    request: unknown, inputs: readonly unknown[] = [], options: ExecutionOptions = {}
  ) => dispatch(
    "executeConfiguredOpaque", request,
    (signal) => broker.executeConfiguredOpaque(request, inputs, withSignal(options, signal)), requestDeadline(request)
  );

  return Object.freeze({
    id: SANDBOX_EXECUTION_PORT_ID,
    execute,
    executeConfigured,
    executeOpaque,
    executeConfiguredOpaque,
    async cancel(reference: unknown, options: Record<string, unknown> = {}) {
      const brokerCancelled = await broker.cancel(reference, options);
      const queueRecord = [...pending.values()].find((record) =>
        record.workItemId === reference || record.contextRef === reference
      );
      const queueCancelled = queueRecord
        ? await queue.cancel({ workItemId: queueRecord.workItemId, reason: "sandbox_execution_cancelled" })
        : null;
      return brokerCancelled || queueCancelled?.cancelled === true;
    },
    getStatus: broker.getStatus,
    getReceipt: broker.getReceipt,
    resolveQuarantinedOutput: broker.resolveQuarantinedOutput,
    disposeOutput: broker.disposeOutput,
    recover: broker.recover,
    configurationState: broker.configurationState,
    publicAvailability: broker.publicAvailability,
    administrativeAvailability: broker.administrativeAvailability,
    requiredBackendRestrictions: broker.requiredBackendRestrictions,
    async close(): Promise<void> {
      closing = true;
      await queue.close();
      for (const record of pending.values()) if (!record.settled) record.reject(new Error("Sandbox execution port closed."));
      pending.clear();
      await broker.close();
    }
  });
}
