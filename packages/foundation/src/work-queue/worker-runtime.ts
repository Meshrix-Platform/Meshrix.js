import { queueIdentityGenerator } from "./identity.ts";
import { systemQueueTimeSource } from "./time-source.ts";

export const WORK_QUEUE_HANDLER_MAX_DURATION_MS = 15 * 60 * 1000;

interface QueueRecord { [key: string]: unknown }
interface QueueLease extends QueueRecord { leaseId: string; expiresAtMs?: number }
interface QueueCheckpoint extends QueueRecord { checkpointSeq?: number }
interface QueueWorkItem extends QueueRecord {
  workItemId: string; queueDefinitionId: string; queueDefinitionVersion?: number; payloadKind?: string;
  payloadRef?: unknown; ownerRef?: unknown; checkpoint?: QueueCheckpoint;
}
interface StoreResult extends QueueRecord { progressed?: boolean; interrupted?: boolean; lease?: QueueLease; workItem?: QueueWorkItem }
type StoreOperation = (input: QueueRecord) => Promise<StoreResult>;
interface QueueStore {
  claim: StoreOperation; complete: StoreOperation; retry: StoreOperation; cancelRunning: StoreOperation;
  fail: StoreOperation; progress: StoreOperation; checkpoint: StoreOperation; markInDoubt: StoreOperation;
}
interface QueueIdentityGenerator { workerId(): string }
interface QueueTimeSource { nowMs(): number }
class QueueRuntimeError extends Error {
  override name = "QueueWorkerRuntimeError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
interface QueueLogger { error?(event: string, facts: object): void }
interface QueueHandler {
  (input: { workItem: QueueWorkItem; lease: QueueLease; payloadRef?: unknown; ownerRef?: unknown }, context: WorkerContext): Promise<unknown> | unknown;
  terminable?: boolean;
}
interface WorkerContext extends QueueRecord {
  workerId: string; timeSource: QueueTimeSource; workItem: QueueWorkItem; readonly lease: QueueLease;
  readonly checkpoint: QueueCheckpoint | null; signal: AbortSignal; payloadRef?: unknown; ownerRef?: unknown;
  renewLease(input?: QueueRecord): Promise<StoreResult>; progress(input?: QueueRecord): Promise<StoreResult>;
  saveCheckpoint(checkpointRef?: unknown, input?: QueueRecord): Promise<StoreResult>;
  complete(input?: QueueRecord): Promise<StoreResult>; retry(input?: QueueRecord): Promise<StoreResult>;
  cancelRunning(input?: QueueRecord): Promise<StoreResult>; fail(input?: QueueRecord): Promise<StoreResult>;
}
interface QueueOutcome extends QueueRecord { action: string; reason?: string; delayMs?: number; retryAfterMs?: number; error?: unknown; lastError?: unknown; reasonDetails?: unknown; extendMs?: number }

function isQueueRecord(value: unknown): value is QueueRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isQueueRuntimeError(value: unknown): value is QueueRuntimeError {
  return value instanceof Error && isQueueRecord(value) && typeof value.code === "string";
}

function toText(value?: unknown): string {
  return String(value ?? "").trim();
}

function asObject(value: unknown, fallback: QueueRecord = {}): QueueRecord {
  return isQueueRecord(value) ? value : fallback;
}

function asPositiveInt(value: unknown, fallback = 1): number {
  const parsed = Number(value);
  return Math.max(1, Number.isFinite(parsed) ? Math.trunc(parsed) : fallback);
}

function normalizeHandlerMap(handlers: QueueHandler | Map<string, QueueHandler> | Record<string, QueueHandler> = {}): Map<string, QueueHandler> {
  if (typeof handlers === "function") {
    return new Map([["*", handlers]]);
  }
  if (handlers instanceof Map) {
    return new Map(handlers);
  }
  return new Map(Object.entries(handlers));
}

function summarizeError(error?: unknown) {
  if (!error) {
    return {};
  }
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    code: isQueueRecord(error) ? toText(error.code) : "",
    stack: error instanceof Error && typeof error.stack === "string" ? error.stack.split("\n").slice(0, 8).join("\n") : ""
  };
}

function queueRuntimeError(code: string, message: string): QueueRuntimeError {
  return new QueueRuntimeError(code, message);
}

function normalizeOutcome(outcome?: unknown): QueueOutcome {
  const canonicalActions = new Set(["completed", "retry", "cancelled", "failed", "progress"]);
  if (typeof outcome === "string") {
    const action = toText(outcome).toLowerCase();
    if (canonicalActions.has(action)) {
      return { action };
    }
  }
  if (isQueueRecord(outcome)) {
    const action = toText(outcome.action).toLowerCase();
    if (canonicalActions.has(action)) {
      return { ...outcome, action };
    }
  }
  throw new Error("Queue worker outcome action must be one of: completed, retry, cancelled, failed, progress.");
}

function handlerKey(workItem: QueueWorkItem): string[] {
  return [
    toText(workItem.queueDefinitionId),
    `${workItem.queueDefinitionId}@${workItem.queueDefinitionVersion}`,
    toText(workItem.payloadKind),
    "*"
  ];
}

export function createQueueWorkerRuntime({
  store,
  handlers = {},
  workerId = "",
  identityGenerator = queueIdentityGenerator,
  timeSource = systemQueueTimeSource,
  fallbackCoordinator = null,
  errorExplainer = null,
  enableErrorExplanation = false,
  leaseRenewIntervalMs = 0,
  maxHandlerDurationMs = WORK_QUEUE_HANDLER_MAX_DURATION_MS,
  logger = null
}: {
  store?: QueueStore; handlers?: QueueHandler | Map<string, QueueHandler> | Record<string, QueueHandler>; workerId?: unknown;
  identityGenerator?: QueueIdentityGenerator; timeSource?: QueueTimeSource; fallbackCoordinator?: { runFallback(input: QueueRecord): Promise<unknown> } | null;
  errorExplainer?: ((input: QueueRecord) => unknown) | null; enableErrorExplanation?: boolean; leaseRenewIntervalMs?: unknown;
  maxHandlerDurationMs?: unknown; logger?: QueueLogger | null;
} = {}) {
  if (!store || typeof store.claim !== "function") {
    throw new Error("Queue Worker Runtime requires a work queue store.");
  }
  const queueStore = store;
  const registeredHandlers = normalizeHandlerMap(handlers);
  const runtimeWorkerId = toText(workerId || identityGenerator.workerId());
  const runtimeHandlerDurationLimitMs = asPositiveInt(
    maxHandlerDurationMs,
    WORK_QUEUE_HANDLER_MAX_DURATION_MS
  );

  function registerHandler(key: unknown, handler: QueueHandler) {
    if (typeof handler !== "function") {
      throw new Error("Queue worker handler must be a function.");
    }
    registeredHandlers.set(toText(key || "*"), handler);
    return { key: toText(key || "*") };
  }

  function unregisterHandler(key?: unknown) {
    const normalizedKey = toText(key || "*");
    return { key: normalizedKey, removed: registeredHandlers.delete(normalizedKey) };
  }

  function resolveHandler(workItem: QueueWorkItem): QueueHandler {
    for (const key of handlerKey(workItem)) {
      const handler = registeredHandlers.get(key);
      if (handler) {
        return handler;
      }
    }
    throw new Error(`No queue worker handler registered for ${workItem.queueDefinitionId}.`);
  }

  function explainError(error: unknown, context: QueueRecord = {}) {
    const summary = summarizeError(error);
    if (!enableErrorExplanation || typeof errorExplainer !== "function") {
      return summary;
    }
    try {
      const explanation = errorExplainer({
        error,
        summary,
        ...context
      });
      return {
        ...summary,
        explanation: asObject(explanation, { value: explanation })
      };
    } catch (explanationError: unknown) {
      return {
        ...summary,
        explanationError: summarizeError(explanationError)
      };
    }
  }

  async function applyOutcome({ workItem, lease, outcome, actor }: { workItem: QueueWorkItem; lease: QueueLease; outcome: unknown; actor: QueueRecord }): Promise<StoreResult> {
    const normalized = normalizeOutcome(outcome);
    const action = toText(normalized.action).toLowerCase();
    if (action === "completed") {
      return queueStore.complete({
        workItemId: workItem.workItemId,
        leaseId: lease.leaseId,
        actor,
        reason: normalized.reason || "handler_completed"
      });
    }
    if (action === "retry") {
      return queueStore.retry({
        workItemId: workItem.workItemId,
        leaseId: lease.leaseId,
        delayMs: normalized.delayMs ?? normalized.retryAfterMs,
        actor,
        reason: normalized.reason || "handler_retry",
        error: normalized.error || normalized.lastError || {}
      });
    }
    if (action === "cancelled") {
      return queueStore.cancelRunning({
        workItemId: workItem.workItemId,
        leaseId: lease.leaseId,
        actor,
        reason: normalized.reason || "handler_cancelled",
        reasonDetails: normalized.reasonDetails || {}
      });
    }
    if (action === "failed") {
      return queueStore.fail({
        workItemId: workItem.workItemId,
        leaseId: lease.leaseId,
        actor,
        reason: normalized.reason || "handler_failed",
        error: normalized.error || normalized.lastError || {}
      });
    }
    if (action === "progress") {
      return queueStore.progress({
        workItemId: workItem.workItemId,
        leaseId: lease.leaseId,
        extendMs: normalized.extendMs,
        actor,
        reason: normalized.reason || "handler_progress"
      });
    }
    throw new Error(`Unknown queue worker outcome action: ${normalized.action}`);
  }

  async function runLeased({ workItem, lease, handler = null, actor = {}, signal = null }: {
    workItem?: QueueWorkItem; lease?: QueueLease; handler?: QueueHandler | null; actor?: QueueRecord; signal?: AbortSignal | null;
  } = {}) {
    if (!workItem || !lease) throw new Error("Queue worker requires a work item and lease.");
    const resolvedHandler = handler || resolveHandler(workItem);
    let settled = false;
    let activeLease: QueueLease = { ...lease };
    let activeCheckpoint: QueueCheckpoint | null = workItem.checkpoint || null;
    let leaseLostError: QueueRuntimeError | null = null;
    let renewalPromise: Promise<StoreResult> = Promise.resolve({});
    let renewalTimer: ReturnType<typeof setTimeout> | null = null;
    let handlerTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const executionController = new AbortController();
    const abortFromCaller = (): void => {
      if (!executionController.signal.aborted) {
        executionController.abort(signal?.reason || queueRuntimeError("queue_worker_aborted", "Queue worker execution was aborted."));
      }
    };
    signal?.addEventListener?.("abort", abortFromCaller, { once: true });
    if (signal?.aborted) abortFromCaller();
    const runtimeActor: QueueRecord = {
      workerId: runtimeWorkerId,
      ...actor
    };

    const renewLease = async (input: QueueRecord = {}): Promise<StoreResult> => {
      if (settled || stopped) {
        throw queueRuntimeError("queue_worker_settled", "Cannot renew a settled queue work item.");
      }
      if (executionController.signal.aborted) {
        throw executionController.signal.reason || queueRuntimeError("queue_worker_aborted", "Queue worker execution was aborted.");
      }
      renewalPromise = renewalPromise.then(async () => {
        const renewed = await queueStore.progress({
          ...input,
          workItemId: workItem.workItemId,
          leaseId: activeLease.leaseId,
          actor: input.actor || runtimeActor,
          reason: input.reason || "lease_renewal"
        });
        if (renewed?.progressed !== true || !renewed?.lease?.leaseId) {
          throw queueRuntimeError("queue_lease_lost", "Queue worker lease renewal was rejected.");
        }
        activeLease = { ...renewed.lease };
        return renewed;
      });
      try {
        return await renewalPromise;
      } catch (error: unknown) {
        leaseLostError = isQueueRuntimeError(error) && error.code === "queue_lease_lost"
          ? error
          : queueRuntimeError("queue_lease_lost", "Queue worker lease renewal failed.");
        if (!executionController.signal.aborted) executionController.abort(leaseLostError);
        throw leaseLostError;
      }
    };

    const initialRemainingMs = Math.max(1, Number(activeLease.expiresAtMs || 0) - Number(timeSource.nowMs()));
    const requestedRenewInterval = Number(leaseRenewIntervalMs || 0);
    const renewalInterval = Math.max(
      10,
      Math.min(
        initialRemainingMs,
        requestedRenewInterval > 0 ? Math.trunc(requestedRenewInterval) : Math.max(10, Math.trunc(initialRemainingMs / 3))
      )
    );
    const scheduleRenewal = (): void => {
      if (stopped || settled || executionController.signal.aborted) return;
      renewalTimer = setTimeout(() => {
        renewalTimer = null;
        void renewLease({ extendMs: initialRemainingMs, reason: "lease_renewal" })
          .then(scheduleRenewal)
          .catch(() => {});
      }, renewalInterval);
      renewalTimer.unref?.();
    };
    scheduleRenewal();

    handlerTimer = setTimeout(() => {
      if (!executionController.signal.aborted) {
        executionController.abort(queueRuntimeError(
          "queue_handler_timeout",
          "Queue worker handler exceeded the server duration limit."
        ));
      }
    }, runtimeHandlerDurationLimitMs);
    const executionAborted = new Promise<never>((_resolve, reject) => {
      const rejectAborted = (): void => reject(
        executionController.signal.reason ||
        queueRuntimeError("queue_worker_aborted", "Queue worker execution was aborted.")
      );
      if (executionController.signal.aborted) rejectAborted();
      else executionController.signal.addEventListener("abort", rejectAborted, { once: true });
    });

    const context: WorkerContext = {
      workerId: runtimeWorkerId,
      timeSource,
      workItem,
      get lease(): QueueLease {
        return { ...activeLease };
      },
      get checkpoint(): QueueCheckpoint | null {
        return activeCheckpoint ? { ...activeCheckpoint } : null;
      },
      signal: executionController.signal,
      payloadRef: workItem.payloadRef,
      ownerRef: workItem.ownerRef,
      renewLease,
      async progress(input: QueueRecord = {}): Promise<StoreResult> {
        if (settled) {
          throw new Error("Cannot progress a settled queue work item.");
        }
        return renewLease(input);
      },
      async saveCheckpoint(checkpointRef?: unknown, input: QueueRecord = {}): Promise<StoreResult> {
        if (settled) {
          throw new Error("Cannot checkpoint a settled queue work item.");
        }
        const result = await queueStore.checkpoint({
          ...input,
          workItemId: workItem.workItemId,
          leaseId: activeLease.leaseId,
          checkpointRef,
          expectedCheckpointSeq: input.expectedCheckpointSeq ?? activeCheckpoint?.checkpointSeq ?? 0,
          actor: input.actor || runtimeActor
        });
        activeCheckpoint = result.workItem?.checkpoint || null;
        return result;
      },
      async complete(input: QueueRecord = {}): Promise<StoreResult> {
        if (settled) {
          throw new Error("Queue work item already settled.");
        }
        settled = true;
        return queueStore.complete({
          ...input,
          workItemId: workItem.workItemId,
          leaseId: activeLease.leaseId,
          actor: input.actor || runtimeActor
        });
      },
      async retry(input: QueueRecord = {}): Promise<StoreResult> {
        if (settled) {
          throw new Error("Queue work item already settled.");
        }
        settled = true;
        return queueStore.retry({
          ...input,
          workItemId: workItem.workItemId,
          leaseId: activeLease.leaseId,
          actor: input.actor || runtimeActor
        });
      },
      async cancelRunning(input: QueueRecord = {}): Promise<StoreResult> {
        if (settled) {
          throw new Error("Queue work item already settled.");
        }
        settled = true;
        return queueStore.cancelRunning({
          ...input,
          workItemId: workItem.workItemId,
          leaseId: activeLease.leaseId,
          actor: input.actor || runtimeActor
        });
      },
      async fail(input: QueueRecord = {}): Promise<StoreResult> {
        if (settled) {
          throw new Error("Queue work item already settled.");
        }
        settled = true;
        return queueStore.fail({
          ...input,
          workItemId: workItem.workItemId,
          leaseId: activeLease.leaseId,
          actor: input.actor || runtimeActor
        });
      }
    };

    try {
      const outcome = await Promise.race([
        resolvedHandler({
          workItem,
          lease: activeLease,
          payloadRef: workItem.payloadRef,
          ownerRef: workItem.ownerRef
        }, context),
        executionAborted
      ]);
      if (settled) {
        return { settled: true, workItemId: workItem.workItemId };
      }
      await renewLease({ extendMs: initialRemainingMs, reason: "handler_terminal_fence" });
      settled = true;
      const result = await applyOutcome({
        workItem,
        lease: activeLease,
        outcome,
        actor: runtimeActor
      });
      return {
        settled: true,
        workItemId: workItem.workItemId,
        result
      };
    } catch (error: unknown) {
      logger?.error?.("queue.worker.handler.failed", {
        workerId: runtimeWorkerId,
        workItemId: workItem.workItemId,
        error: summarizeError(error)
      });
      if (settled || leaseLostError) {
        throw error;
      }
      if (executionController.signal.aborted) {
        settled = true;
        const explained = explainError(error, { workItem, lease: activeLease });
        const provablyTerminable = resolvedHandler.terminable === true;
        try {
          if (provablyTerminable) {
            const result = await queueStore.retry({
              workItemId: workItem.workItemId,
              leaseId: activeLease.leaseId,
              delayMs: 0,
              actor: runtimeActor,
              reason: isQueueRecord(error) && error.code === "queue_handler_timeout" ? "handler_timeout" : "handler_interrupted",
              error: explained
            });
            return {
              settled: true,
              interrupted: true,
              workItemId: workItem.workItemId,
              error: explained,
              result
            };
          }
          const inDoubt = await queueStore.markInDoubt({
            workItemId: workItem.workItemId,
            leaseId: activeLease.leaseId,
            actor: runtimeActor,
            reason: isQueueRecord(error) && error.code === "queue_handler_timeout" ? "handler_timeout_unconfirmed" : "handler_interrupted_unconfirmed",
            error: {
              type: "handler_unconfirmed",
              ...explained
            }
          });
          return {
            settled: true,
            interrupted: true,
            inDoubt: inDoubt.interrupted === true,
            workItemId: workItem.workItemId,
            error: explained,
            result: inDoubt
          };
        } catch {
          throw error;
        }
      }
      settled = true;
      const explained = explainError(error, { workItem, lease: activeLease });
      if (fallbackCoordinator && typeof fallbackCoordinator.runFallback === "function") {
        const result = await fallbackCoordinator.runFallback({
          workItem,
          lease: activeLease,
          workItemId: workItem.workItemId,
          leaseId: activeLease.leaseId,
          actor: runtimeActor,
          reason: "handler_error",
          error: explained
        });
        return {
          settled: true,
          failed: true,
          fallback: true,
          workItemId: workItem.workItemId,
          error: explained,
          result
        };
      }
      const result = await queueStore.retry({
        workItemId: workItem.workItemId,
        leaseId: activeLease.leaseId,
        actor: runtimeActor,
        reason: "handler_error",
        error: explained
      });
      return {
        settled: true,
        failed: true,
        workItemId: workItem.workItemId,
        error: explained,
        result
      };
    } finally {
      stopped = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      if (handlerTimer) clearTimeout(handlerTimer);
      signal?.removeEventListener?.("abort", abortFromCaller);
      await renewalPromise.catch(() => {});
    }
  }

  return Object.freeze({
    workerId: runtimeWorkerId,
    maxHandlerDurationMs: runtimeHandlerDurationLimitMs,
    registerHandler,
    unregisterHandler,
    runLeased
  });
}
