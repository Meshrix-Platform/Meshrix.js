import { queueIdentityGenerator } from "./identity.ts";
import { systemQueueTimeSource } from "./time-source.ts";

export const WORK_QUEUE_HANDLER_MAX_DURATION_MS: any = 15 * 60 * 1000;

function toText(value?: any) : any {
  return String(value ?? "").trim();
}

function asObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asPositiveInt(value?: any, fallback: any = 1) : any {
  const parsed: any = Number(value);
  return Math.max(1, Number.isFinite(parsed) ? Math.trunc(parsed) : fallback);
}

function normalizeHandlerMap(handlers: Record<string, any> = {}) : any {
  if (typeof handlers === "function") {
    return new Map<any, any>([["*", handlers]]);
  }
  if (handlers instanceof Map) {
    return new Map<any, any>(handlers);
  }
  return new Map<any, any>((Object.entries(asObject(handlers)) as [string, any][]));
}

function summarizeError(error?: any) : any {
  if (!error) {
    return {};
  }
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    code: error.code || "",
    stack: typeof error.stack === "string" ? error.stack.split("\n").slice(0, 8).join("\n") : ""
  };
}

function queueRuntimeError(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.name = "QueueWorkerRuntimeError";
  error.code = code;
  return error;
}

function normalizeOutcome(outcome?: any) : any {
  const canonicalActions: any = new Set<any>(["completed", "retry", "cancelled", "failed", "progress"]);
  if (typeof outcome === "string") {
    const action: any = toText(outcome).toLowerCase();
    if (canonicalActions.has(action)) {
      return { action };
    }
  }
  if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
    const action: any = toText(outcome.action).toLowerCase();
    if (canonicalActions.has(action)) {
      return { ...outcome, action };
    }
  }
  throw new Error("Queue worker outcome action must be one of: completed, retry, cancelled, failed, progress.");
}

function handlerKey(workItem?: any) : any {
  return [
    workItem.queueDefinitionId,
    `${workItem.queueDefinitionId}@${workItem.queueDefinitionVersion}`,
    workItem.payloadKind,
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
}: Record<string, any> = {}) : any {
  if (!store || typeof store.claim !== "function") {
    throw new Error("Queue Worker Runtime requires a work queue store.");
  }
  const registeredHandlers: any = normalizeHandlerMap(handlers);
  const runtimeWorkerId: any = toText(workerId || identityGenerator.workerId());
  const runtimeHandlerDurationLimitMs: any = asPositiveInt(
    maxHandlerDurationMs,
    WORK_QUEUE_HANDLER_MAX_DURATION_MS
  );

  function registerHandler(key?: any, handler?: any) : any {
    if (typeof handler !== "function") {
      throw new Error("Queue worker handler must be a function.");
    }
    registeredHandlers.set(toText(key || "*"), handler);
    return { key: toText(key || "*") };
  }

  function unregisterHandler(key?: any) : any {
    const normalizedKey: any = toText(key || "*");
    return { key: normalizedKey, removed: registeredHandlers.delete(normalizedKey) };
  }

  function resolveHandler(workItem?: any) : any {
    for (const key of handlerKey(workItem)) {
      const handler: any = registeredHandlers.get(key);
      if (handler) {
        return handler;
      }
    }
    throw new Error(`No queue worker handler registered for ${workItem.queueDefinitionId}.`);
  }

  function explainError(error?: any, context: Record<string, any> = {}) : any {
    const summary: any = summarizeError(error);
    if (!enableErrorExplanation || typeof errorExplainer !== "function") {
      return summary;
    }
    try {
      const explanation: any = errorExplainer({
        error,
        summary,
        ...context
      });
      return {
        ...summary,
        explanation: asObject(explanation, { value: explanation })
      };
    } catch (explanationError: any) {
      return {
        ...summary,
        explanationError: summarizeError(explanationError)
      };
    }
  }

  async function applyOutcome({ workItem, lease, outcome, actor }: Record<string, any>) : Promise<any> {
    const normalized: any = normalizeOutcome(outcome);
    const action: any = toText(normalized.action).toLowerCase();
    if (action === "completed") {
      return store.complete({
        workItemId: workItem.workItemId,
        leaseId: lease.leaseId,
        actor,
        reason: normalized.reason || "handler_completed"
      });
    }
    if (action === "retry") {
      return store.retry({
        workItemId: workItem.workItemId,
        leaseId: lease.leaseId,
        delayMs: normalized.delayMs ?? normalized.retryAfterMs,
        actor,
        reason: normalized.reason || "handler_retry",
        error: normalized.error || normalized.lastError || {}
      });
    }
    if (action === "cancelled") {
      return store.cancelRunning({
        workItemId: workItem.workItemId,
        leaseId: lease.leaseId,
        actor,
        reason: normalized.reason || "handler_cancelled",
        reasonDetails: normalized.reasonDetails || {}
      });
    }
    if (action === "failed") {
      return store.fail({
        workItemId: workItem.workItemId,
        leaseId: lease.leaseId,
        actor,
        reason: normalized.reason || "handler_failed",
        error: normalized.error || normalized.lastError || {}
      });
    }
    if (action === "progress") {
      return store.progress({
        workItemId: workItem.workItemId,
        leaseId: lease.leaseId,
        extendMs: normalized.extendMs,
        actor,
        reason: normalized.reason || "handler_progress"
      });
    }
    throw new Error(`Unknown queue worker outcome action: ${normalized.action}`);
  }

  async function runLeased({ workItem, lease, handler = null, actor = {}, signal = null }: Record<string, any> = {}) : Promise<any> {
    const resolvedHandler: any = handler || resolveHandler(workItem);
    let settled: any = false;
    let activeLease: Record<string, any> = { ...lease };
    let activeCheckpoint: any = workItem.checkpoint || null;
    let leaseLostError: any = null;
    let renewalPromise: any = Promise.resolve();
    let renewalTimer: any = null;
    let handlerTimer: any = null;
    let stopped: any = false;
    const executionController: any = new AbortController();
    const abortFromCaller: any = () : any => {
      if (!executionController.signal.aborted) {
        executionController.abort(signal?.reason || queueRuntimeError("queue_worker_aborted", "Queue worker execution was aborted."));
      }
    };
    signal?.addEventListener?.("abort", abortFromCaller, { once: true });
    if (signal?.aborted) abortFromCaller();
    const runtimeActor: Record<string, any> = {
      workerId: runtimeWorkerId,
      ...actor
    };

    const renewLease: any = async (input: Record<string, any> = {}) : Promise<any> => {
      if (settled || stopped) {
        throw queueRuntimeError("queue_worker_settled", "Cannot renew a settled queue work item.");
      }
      if (executionController.signal.aborted) {
        throw executionController.signal.reason || queueRuntimeError("queue_worker_aborted", "Queue worker execution was aborted.");
      }
      renewalPromise = renewalPromise.then(async () : Promise<any> => {
        const renewed: any = await store.progress({
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
      } catch (error: any) {
        leaseLostError = error?.code === "queue_lease_lost"
          ? error
          : queueRuntimeError("queue_lease_lost", "Queue worker lease renewal failed.");
        if (!executionController.signal.aborted) executionController.abort(leaseLostError);
        throw leaseLostError;
      }
    };

    const initialRemainingMs: any = Math.max(1, Number(activeLease.expiresAtMs || 0) - Number(timeSource.nowMs()));
    const requestedRenewInterval: any = Number(leaseRenewIntervalMs || 0);
    const renewalInterval: any = Math.max(
      10,
      Math.min(
        initialRemainingMs,
        requestedRenewInterval > 0 ? Math.trunc(requestedRenewInterval) : Math.max(10, Math.trunc(initialRemainingMs / 3))
      )
    );
    const scheduleRenewal: any = () : any => {
      if (stopped || settled || executionController.signal.aborted) return;
      renewalTimer = setTimeout(() : any => {
        renewalTimer = null;
        void renewLease({ extendMs: initialRemainingMs, reason: "lease_renewal" })
          .then(scheduleRenewal)
          .catch(() : any => {});
      }, renewalInterval);
      renewalTimer.unref?.();
    };
    scheduleRenewal();

    handlerTimer = setTimeout(() : any => {
      if (!executionController.signal.aborted) {
        executionController.abort(queueRuntimeError(
          "queue_handler_timeout",
          "Queue worker handler exceeded the server duration limit."
        ));
      }
    }, runtimeHandlerDurationLimitMs);
    const executionAborted: any = new Promise((_?: any, reject?: any) : any => {
      const rejectAborted: any = () : any => reject(
        executionController.signal.reason ||
        queueRuntimeError("queue_worker_aborted", "Queue worker execution was aborted.")
      );
      if (executionController.signal.aborted) rejectAborted();
      else executionController.signal.addEventListener("abort", rejectAborted, { once: true });
    });

    const context: Record<string, any> = {
      workerId: runtimeWorkerId,
      timeSource,
      workItem,
      get lease() : any {
        return { ...activeLease };
      },
      get checkpoint() : any {
        return activeCheckpoint ? { ...activeCheckpoint } : null;
      },
      signal: executionController.signal,
      payloadRef: workItem.payloadRef,
      ownerRef: workItem.ownerRef,
      renewLease,
      async progress(input: Record<string, any> = {}) : Promise<any> {
        if (settled) {
          throw new Error("Cannot progress a settled queue work item.");
        }
        return renewLease(input);
      },
      async saveCheckpoint(checkpointRef?: any, input: Record<string, any> = {}) : Promise<any> {
        if (settled) {
          throw new Error("Cannot checkpoint a settled queue work item.");
        }
        const result: any = await store.checkpoint({
          ...input,
          workItemId: workItem.workItemId,
          leaseId: activeLease.leaseId,
          checkpointRef,
          expectedCheckpointSeq: input.expectedCheckpointSeq ?? activeCheckpoint?.checkpointSeq ?? 0,
          actor: input.actor || runtimeActor
        });
        activeCheckpoint = result.workItem.checkpoint;
        return result;
      },
      async complete(input: Record<string, any> = {}) : Promise<any> {
        if (settled) {
          throw new Error("Queue work item already settled.");
        }
        settled = true;
        return store.complete({
          ...input,
          workItemId: workItem.workItemId,
          leaseId: activeLease.leaseId,
          actor: input.actor || runtimeActor
        });
      },
      async retry(input: Record<string, any> = {}) : Promise<any> {
        if (settled) {
          throw new Error("Queue work item already settled.");
        }
        settled = true;
        return store.retry({
          ...input,
          workItemId: workItem.workItemId,
          leaseId: activeLease.leaseId,
          actor: input.actor || runtimeActor
        });
      },
      async cancelRunning(input: Record<string, any> = {}) : Promise<any> {
        if (settled) {
          throw new Error("Queue work item already settled.");
        }
        settled = true;
        return store.cancelRunning({
          ...input,
          workItemId: workItem.workItemId,
          leaseId: activeLease.leaseId,
          actor: input.actor || runtimeActor
        });
      },
      async fail(input: Record<string, any> = {}) : Promise<any> {
        if (settled) {
          throw new Error("Queue work item already settled.");
        }
        settled = true;
        return store.fail({
          ...input,
          workItemId: workItem.workItemId,
          leaseId: activeLease.leaseId,
          actor: input.actor || runtimeActor
        });
      }
    };

    try {
      const outcome: any = await Promise.race([
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
      const result: any = await applyOutcome({
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
    } catch (error: any) {
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
        const explained: any = explainError(error, { workItem, lease: activeLease });
        try {
          const result: any = await store.retry({
            workItemId: workItem.workItemId,
            leaseId: activeLease.leaseId,
            delayMs: 0,
            actor: runtimeActor,
            reason: error?.code === "queue_handler_timeout" ? "handler_timeout" : "handler_interrupted",
            error: explained
          });
          return {
            settled: true,
            interrupted: true,
            workItemId: workItem.workItemId,
            error: explained,
            result
          };
        } catch {
          throw error;
        }
      }
      settled = true;
      const explained: any = explainError(error, { workItem, lease: activeLease });
      if (fallbackCoordinator && typeof fallbackCoordinator.runFallback === "function") {
        const result: any = await fallbackCoordinator.runFallback({
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
      const result: any = await store.retry({
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
      await renewalPromise.catch(() : any => {});
    }
  }

  async function runOnce(input: Record<string, any> = {}) : Promise<any> {
    const claim: any = await store.claim({
      ...input,
      workerId: input.workerId || runtimeWorkerId,
      batchSize: asPositiveInt(input.batchSize ?? input.batch ?? 1, 1)
    });
    const results: any[] = [];
    for (const leased of claim.claimed || []) {
      results.push(await runLeased({
        workItem: leased.workItem,
        lease: leased.lease,
        actor: input.actor
      }));
    }
    return {
      workerId: claim.workerId || runtimeWorkerId,
      claimed: claim.claimed || [],
      recovered: claim.recovered || [],
      matured: claim.matured || [],
      results
    };
  }

  async function startPolling({
    intervalMs = 1000,
    signal = null,
    maxIterations = 0,
    ...claimInput
  }: Record<string, any> = {}) : Promise<any> {
    const safeIntervalMs: any = Math.max(10, Number(intervalMs) || 1000);
    let iterations: any = 0;
    let stopped: any = false;
    const stop: any = () : any => {
      stopped = true;
    };
    signal?.addEventListener?.("abort", stop, { once: true });
    while (!stopped) {
      iterations += 1;
      await runOnce(claimInput);
      if (maxIterations > 0 && iterations >= maxIterations) {
        break;
      }
      await new Promise((resolve?: any) : any => setTimeout(resolve, safeIntervalMs));
    }
    signal?.removeEventListener?.("abort", stop);
    return { stopped: true, iterations };
  }

  return Object.freeze({
    workerId: runtimeWorkerId,
    maxHandlerDurationMs: runtimeHandlerDurationLimitMs,
    registerHandler,
    unregisterHandler,
    runLeased,
    runOnce,
    startPolling
  });
}
