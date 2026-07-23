import { queueIdentityGenerator } from "./identity.mjs";
import { computeDeterministicRetryDelay, DEFAULT_QUEUE_POLICY } from "./policies.mjs";
import { systemQueueTimeSource } from "./time-source.mjs";

function toText(value) {
  return String(value ?? "").trim();
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
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

function mergePolicy(policy = {}) {
  return {
    ...DEFAULT_QUEUE_POLICY,
    ...asObject(policy),
    fallbackRetry: {
      ...DEFAULT_QUEUE_POLICY.fallbackRetry,
      ...asObject(policy.fallbackRetry)
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function createQueueFallbackCoordinator({
  store,
  timeSource = systemQueueTimeSource,
  identityGenerator = queueIdentityGenerator,
  policy = DEFAULT_QUEUE_POLICY,
  fallback = null,
  logger = null
} = {}) {
  if (!store || typeof store.retry !== "function") {
    throw new Error("Queue Fallback Coordinator requires a work queue store.");
  }
  const resolvedPolicy = mergePolicy(policy);
  const locks = new Set();

  function writeState(input = {}) {
    if (typeof store.writeFallbackCoordinatorState !== "function") {
      return null;
    }
    return store.writeFallbackCoordinatorState({
      ...input,
      nowMs: input.nowMs ?? timeSource.nowMs()
    });
  }

  function lock(workItemId) {
    const key = toText(workItemId);
    if (!key) {
      throw new Error("Fallback workItemId is required.");
    }
    if (locks.has(key)) {
      throw new Error(`Fallback already in progress for work item ${key}.`);
    }
    locks.add(key);
    return () => locks.delete(key);
  }

  async function defaultFallbackAction(input = {}) {
    const delayMs = input.delayMs === undefined
      ? computeDeterministicRetryDelay({
          queueDefinitionId: input.workItem?.queueDefinitionId,
          workItemId: input.workItemId,
          attempt: asInt(input.workItem?.attempt, 1),
          ...resolvedPolicy.retryBackoff
        })
      : Math.max(0, asInt(input.delayMs, 0));
    return store.retry({
      workItemId: input.workItemId,
      leaseId: input.leaseId,
      delayMs,
      actor: input.actor,
      reason: input.reason || "fallback_retry",
      error: input.error || {}
    });
  }

  async function executeFallbackAction(input = {}) {
    const fallbackHandler = input.fallback || fallback;
    if (typeof fallbackHandler !== "function") {
      return defaultFallbackAction(input);
    }
    const outcome = await fallbackHandler({
      workItem: input.workItem,
      lease: input.lease,
      error: input.error,
      reason: input.reason,
      attempt: input.attempt
    });
    if (outcome?.action === "retry") {
      return store.retry({
        workItemId: input.workItemId,
        leaseId: input.leaseId,
        delayMs: outcome?.delayMs ?? input.delayMs,
        actor: input.actor,
        reason: outcome?.reason || input.reason || "fallback_retry",
        error: outcome?.error || input.error || {}
      });
    }
    if (outcome?.action === "completed") {
      return store.complete({
        workItemId: input.workItemId,
        leaseId: input.leaseId,
        actor: input.actor,
        reason: outcome.reason || "fallback_completed"
      });
    }
    if (outcome?.action === "cancelled") {
      return store.cancelRunning({
        workItemId: input.workItemId,
        leaseId: input.leaseId,
        actor: input.actor,
        reason: outcome.reason || "fallback_cancelled"
      });
    }
    if (outcome?.action === "failed") {
      return store.fail({
        workItemId: input.workItemId,
        leaseId: input.leaseId,
        actor: input.actor,
        reason: outcome.reason || "fallback_fail",
        error: outcome.error || input.error || {}
      });
    }
    if (outcome?.action === "progress") {
      return store.progress({
        workItemId: input.workItemId,
        leaseId: input.leaseId,
        extendMs: outcome.extendMs,
        actor: input.actor,
        reason: outcome.reason || "fallback_progress"
      });
    }
    throw new Error("Fallback outcome action must be one of: completed, retry, cancelled, failed, progress.");
  }

  async function runFallback(input = {}) {
    const workItem = input.workItem || {};
    const lease = input.lease || workItem.lease || {};
    const workItemId = toText(input.workItemId || workItem.workItemId);
    const leaseId = toText(input.leaseId || lease.leaseId);
    const fallbackTaskId = toText(input.fallbackTaskId || identityGenerator.fallbackTaskId());
    const unlock = lock(workItemId);
    const maxAttempts = Math.max(1, asInt(input.maxAttempts, resolvedPolicy.fallbackRetry.maxAttempts));
    let lastError = input.error || null;
    try {
      writeState({
        fallbackTaskId,
        workItemId,
        status: "running",
        attempt: 0,
        maxAttempts,
        reason: input.reason || "fallback_started",
        state: {
          workItemId,
          leaseId,
          startedAtMs: timeSource.nowMs()
        }
      });

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const result = await executeFallbackAction({
            ...input,
            workItem,
            lease,
            workItemId,
            leaseId,
            fallbackTaskId,
            attempt
          });
          writeState({
            fallbackTaskId,
            workItemId,
            status: "committed",
            attempt,
            maxAttempts,
            reason: input.reason || "fallback_committed",
            state: {
              result,
              committedAtMs: timeSource.nowMs()
            }
          });
          return {
            fallbackTaskId,
            committed: true,
            attempt,
            result
          };
        } catch (error) {
          lastError = error;
          logger?.error?.("queue.fallback.attempt.failed", {
            fallbackTaskId,
            workItemId,
            attempt,
            error: summarizeError(error)
          });
          writeState({
            fallbackTaskId,
            workItemId,
            status: attempt >= maxAttempts ? "exhausted" : "retrying",
            attempt,
            maxAttempts,
            reason: "fallback_attempt_failed",
            lastError: summarizeError(error),
            state: {
              failedAtMs: timeSource.nowMs()
            }
          });
          if (attempt < maxAttempts) {
            await sleep(computeDeterministicRetryDelay({
              queueDefinitionId: "fallback",
              workItemId: fallbackTaskId,
              attempt,
              ...resolvedPolicy.fallbackRetry
            }));
          }
        }
      }

      if (typeof store.fail === "function") {
        const result = await store.fail({
          workItemId,
          leaseId,
          fallbackTaskId,
          actor: input.actor,
          reason: "fallback_exhausted",
          error: summarizeError(lastError),
          maxAttempts
        });
        return {
          fallbackTaskId,
          committed: false,
          failed: true,
          error: summarizeError(lastError),
          result
        };
      }
      throw lastError || new Error("Fallback exhausted.");
    } finally {
      unlock();
    }
  }

  function startFallback(input = {}) {
    const fallbackTaskId = toText(input.fallbackTaskId || identityGenerator.fallbackTaskId());
    const promise = Promise.resolve().then(() => runFallback({
      ...input,
      fallbackTaskId
    }));
    return {
      fallbackTaskId,
      promise
    };
  }

  return Object.freeze({
    runFallback,
    startFallback,
    inFlightCount() {
      return locks.size;
    }
  });
}
