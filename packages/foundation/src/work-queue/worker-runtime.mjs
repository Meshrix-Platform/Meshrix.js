import { queueIdentityGenerator } from "./identity.mjs";
import { systemQueueTimeSource } from "./time-source.mjs";

export const WORK_QUEUE_HANDLER_MAX_DURATION_MS = 15 * 60 * 1000;

function toText(value) {
  return String(value ?? "").trim();
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asPositiveInt(value, fallback = 1) {
  const parsed = Number(value);
  return Math.max(1, Number.isFinite(parsed) ? Math.trunc(parsed) : fallback);
}

function normalizeHandlerMap(handlers = {}) {
  if (typeof handlers === "function") {
    return new Map([["*", handlers]]);
  }
  if (handlers instanceof Map) {
    return new Map(handlers);
  }
  return new Map(Object.entries(asObject(handlers)));
}

function summarizeError(error) {
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

function queueRuntimeError(code, message) {
  const error = new Error(message);
  error.name = "QueueWorkerRuntimeError";
  error.code = code;
  return error;
}

function normalizeOutcome(outcome) {
  const canonicalActions = new Set(["completed", "retry", "cancelled", "failed", "progress"]);
  if (typeof outcome === "string") {
    const action = toText(outcome).toLowerCase();
    if (canonicalActions.has(action)) {
      return { action };
    }
  }
  if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
    const action = toText(outcome.action).toLowerCase();
    if (canonicalActions.has(action)) {
      return { ...outcome, action };
    }
  }
  throw new Error("Queue worker outcome action must be one of: completed, retry, cancelled, failed, progress.");
}

function handlerKey(workItem) {
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
} = {}) {
  if (!store || typeof store.claim !== "function") {
    throw new Error("Queue Worker Runtime requires a work queue store.");
  }
  const registeredHandlers = normalizeHandlerMap(handlers);
  const runtimeWorkerId = toText(workerId || identityGenerator.workerId());
  const runtimeHandlerDurationLimitMs = asPositiveInt(
    maxHandlerDurationMs,
    WORK_QUEUE_HANDLER_MAX_DURATION_MS
  );

  function registerHandler(key, handler) {
    if (typeof handler !== "function") {
      throw new Error("Queue worker handler must be a function.");
    }
    registeredHandlers.set(toText(key || "*"), handler);
    return { key: toText(key || "*") };
  }

  function unregisterHandler(key) {
    const normalizedKey = toText(key || "*");
    return { key: normalizedKey, removed: registeredHandlers.delete(normalizedKey) };
  }

  function resolveHandler(workItem) {
    for (const key of handlerKey(workItem)) {
      const handler = registeredHandlers.get(key);
      if (handler) {
        return handler;
      }
    }
    throw new Error(`No queue worker handler registered for ${workItem.queueDefinitionId}.`);
  }

  function explainError(error, context = {}) {
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
    } catch (explanationError) {
      return {
        ...summary,
        explanationError: summarizeError(explanationError)
      };
    }
  }

  async function applyOutcome({ workItem, lease, outcome, actor }) {
    const normalized = normalizeOutcome(outcome);
    const action = toText(normalized.action).toLowerCase();
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

  async function runLeased({ workItem, lease, handler = null, actor = {}, signal = null } = {}) {
    const resolvedHandler = handler || resolveHandler(workItem);
    let settled = false;
    let activeLease = { ...lease };
    let activeCheckpoint = workItem.checkpoint || null;
    let leaseLostError = null;
    let renewalPromise = Promise.resolve();
    let renewalTimer = null;
    let handlerTimer = null;
    let stopped = false;
    const executionController = new AbortController();
    const abortFromCaller = () => {
      if (!executionController.signal.aborted) {
        executionController.abort(signal?.reason || queueRuntimeError("queue_worker_aborted", "Queue worker execution was aborted."));
      }
    };
    signal?.addEventListener?.("abort", abortFromCaller, { once: true });
    if (signal?.aborted) abortFromCaller();
    const runtimeActor = {
      workerId: runtimeWorkerId,
      ...actor
    };

    const renewLease = async (input = {}) => {
      if (settled || stopped) {
        throw queueRuntimeError("queue_worker_settled", "Cannot renew a settled queue work item.");
      }
      if (executionController.signal.aborted) {
        throw executionController.signal.reason || queueRuntimeError("queue_worker_aborted", "Queue worker execution was aborted.");
      }
      renewalPromise = renewalPromise.then(async () => {
        const renewed = await store.progress({
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
      } catch (error) {
        leaseLostError = error?.code === "queue_lease_lost"
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
    const scheduleRenewal = () => {
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
    const executionAborted = new Promise((_, reject) => {
      const rejectAborted = () => reject(
        executionController.signal.reason ||
        queueRuntimeError("queue_worker_aborted", "Queue worker execution was aborted.")
      );
      if (executionController.signal.aborted) rejectAborted();
      else executionController.signal.addEventListener("abort", rejectAborted, { once: true });
    });

    const context = {
      workerId: runtimeWorkerId,
      timeSource,
      workItem,
      get lease() {
        return { ...activeLease };
      },
      get checkpoint() {
        return activeCheckpoint ? { ...activeCheckpoint } : null;
      },
      signal: executionController.signal,
      payloadRef: workItem.payloadRef,
      ownerRef: workItem.ownerRef,
      renewLease,
      async progress(input = {}) {
        if (settled) {
          throw new Error("Cannot progress a settled queue work item.");
        }
        return renewLease(input);
      },
      async saveCheckpoint(checkpointRef, input = {}) {
        if (settled) {
          throw new Error("Cannot checkpoint a settled queue work item.");
        }
        const result = await store.checkpoint({
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
      async complete(input = {}) {
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
      async retry(input = {}) {
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
      async cancelRunning(input = {}) {
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
      async fail(input = {}) {
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
    } catch (error) {
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
        try {
          const result = await store.retry({
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
      const result = await store.retry({
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

  async function runOnce(input = {}) {
    const claim = await store.claim({
      ...input,
      workerId: input.workerId || runtimeWorkerId,
      batchSize: asPositiveInt(input.batchSize ?? input.batch ?? 1, 1)
    });
    const results = [];
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
  } = {}) {
    const safeIntervalMs = Math.max(10, Number(intervalMs) || 1000);
    let iterations = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    signal?.addEventListener?.("abort", stop, { once: true });
    while (!stopped) {
      iterations += 1;
      await runOnce(claimInput);
      if (maxIterations > 0 && iterations >= maxIterations) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, safeIntervalMs));
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
