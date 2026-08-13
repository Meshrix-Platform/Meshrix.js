import { queueIdentityGenerator } from "./identity.ts";
import { computeDeterministicRetryDelay, DEFAULT_QUEUE_POLICY } from "./policies.ts";
import { systemQueueTimeSource } from "./time-source.ts";

function toText(value?: any) : any {
  return String(value ?? "").trim();
}

function asObject(value?: any, fallback: Record<string, any> | null = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asInt(value?: any, fallback: any = 0) : any {
  const parsed: any = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
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

function mergePolicy(policy: Record<string, any> = {}) : any {
  return {
    ...DEFAULT_QUEUE_POLICY,
    ...asObject(policy),
    fallbackRetry: {
      ...DEFAULT_QUEUE_POLICY.fallbackRetry,
      ...asObject(policy.fallbackRetry)
    }
  };
}

function sleep(ms?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function createQueueFallbackCoordinator({
  store,
  timeSource = systemQueueTimeSource,
  identityGenerator = queueIdentityGenerator,
  policy = DEFAULT_QUEUE_POLICY,
  fallback = null,
  logger = null
}: Record<string, any> = {}) : any {
  if (!store || typeof store.retry !== "function") {
    throw new Error("Queue Fallback Coordinator requires a work queue store.");
  }
  const resolvedPolicy: any = mergePolicy(policy);
  const locks: any = new Set<any>();

  function writeState(input: Record<string, any> = {}) : any {
    if (typeof store.writeFallbackCoordinatorState !== "function") {
      return null;
    }
    return store.writeFallbackCoordinatorState({
      ...input,
      nowMs: input.nowMs ?? timeSource.nowMs()
    });
  }

  function lock(workItemId?: any) : any {
    const key: any = toText(workItemId);
    if (!key) {
      throw new Error("Fallback workItemId is required.");
    }
    if (locks.has(key)) {
      throw new Error(`Fallback already in progress for work item ${key}.`);
    }
    locks.add(key);
    return () : any => locks.delete(key);
  }

  async function defaultFallbackAction(input: Record<string, any> = {}) : Promise<any> {
    const delayMs: any = input.delayMs === undefined
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

  async function executeFallbackAction(input: Record<string, any> = {}) : Promise<any> {
    const fallbackHandler: any = input.fallback || fallback;
    if (typeof fallbackHandler !== "function") {
      return defaultFallbackAction(input);
    }
    const outcome: any = await fallbackHandler({
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

  async function runFallback(input: Record<string, any> = {}) : Promise<any> {
    const workItem: any = input.workItem || {};
    const lease: any = input.lease || workItem.lease || {};
    const workItemId: any = toText(input.workItemId || workItem.workItemId);
    const leaseId: any = toText(input.leaseId || lease.leaseId);
    const fallbackTaskId: any = toText(input.fallbackTaskId || identityGenerator.fallbackTaskId());
    const unlock: any = lock(workItemId);
    const maxAttempts: any = Math.max(1, asInt(input.maxAttempts, resolvedPolicy.fallbackRetry.maxAttempts));
    let lastError: any = input.error || null;
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

      for (let attempt: any = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const result: any = await executeFallbackAction({
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
        } catch (error: any) {
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
        const result: any = await store.fail({
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

  function startFallback(input: Record<string, any> = {}) : any {
    const fallbackTaskId: any = toText(input.fallbackTaskId || identityGenerator.fallbackTaskId());
    const promise: any = Promise.resolve().then(() : any => runFallback({
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
    inFlightCount() : any {
      return locks.size;
    }
  });
}
