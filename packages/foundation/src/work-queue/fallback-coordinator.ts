import { queueIdentityGenerator } from "./identity.ts";
import { computeDeterministicRetryDelay, DEFAULT_QUEUE_POLICY } from "./policies.ts";
import { systemQueueTimeSource } from "./time-source.ts";

interface QueueRecord { [key: string]: unknown }
interface WorkItem extends QueueRecord { workItemId?: string; queueDefinitionId?: string; attempt?: number; lease?: QueueLease }
interface QueueLease extends QueueRecord { leaseId?: string }
interface QueueStore {
  retry(input: QueueRecord): Promise<unknown>;
  complete(input: QueueRecord): Promise<unknown>;
  cancelRunning(input: QueueRecord): Promise<unknown>;
  fail?(input: QueueRecord): Promise<unknown>;
  progress(input: QueueRecord): Promise<unknown>;
  writeFallbackCoordinatorState?(input: QueueRecord): unknown;
}
interface QueueTimeSource { nowMs(): number }
interface QueueIdentityGenerator { fallbackTaskId(): string }
interface QueueLogger { error?(event: string, facts: object): void }
interface FallbackRetryPolicy { maxAttempts: number; initialDelayMs: number; multiplier: number; maxDelayMs: number }
interface FallbackPolicy extends QueueRecord { fallbackRetry: FallbackRetryPolicy; retryBackoff: QueueRecord }
interface FallbackOutcome extends QueueRecord { action?: string; delayMs?: number; reason?: string; error?: unknown; extendMs?: number }
type FallbackHandler = (input: { workItem: WorkItem; lease: QueueLease; error: unknown; reason: unknown; attempt: unknown }) => Promise<FallbackOutcome> | FallbackOutcome;
interface FallbackInput extends QueueRecord {
  workItem?: WorkItem; lease?: QueueLease; workItemId?: unknown; leaseId?: unknown; fallbackTaskId?: unknown;
  maxAttempts?: unknown; error?: unknown; reason?: unknown; actor?: object; delayMs?: unknown; fallback?: FallbackHandler;
}

function toText(value?: unknown): string {
  return String(value ?? "").trim();
}

function asObject(value: unknown, fallback: QueueRecord = {}): QueueRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : fallback;
}

function asInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function summarizeError(error?: unknown) {
  if (!error) {
    return {};
  }
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    code: typeof error === "object" && error !== null && "code" in error ? String(error.code ?? "") : "",
    stack: error instanceof Error && typeof error.stack === "string" ? error.stack.split("\n").slice(0, 8).join("\n") : ""
  };
}

function mergePolicy(policy: QueueRecord = {}): FallbackPolicy {
  return {
    ...DEFAULT_QUEUE_POLICY,
    ...asObject(policy),
    fallbackRetry: {
      ...DEFAULT_QUEUE_POLICY.fallbackRetry,
      ...asObject(policy.fallbackRetry)
    }
  };
}

function sleep(ms?: unknown): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function createQueueFallbackCoordinator({
  store,
  timeSource = systemQueueTimeSource,
  identityGenerator = queueIdentityGenerator,
  policy = DEFAULT_QUEUE_POLICY,
  fallback = null,
  logger = null
}: {
  store?: QueueStore; timeSource?: QueueTimeSource; identityGenerator?: QueueIdentityGenerator; policy?: QueueRecord;
  fallback?: FallbackHandler | null; logger?: QueueLogger | null;
} = {}) {
  if (!store || typeof store.retry !== "function") {
    throw new Error("Queue Fallback Coordinator requires a work queue store.");
  }
  const queueStore = store;
  const resolvedPolicy = mergePolicy(policy);
  const locks = new Set<string>();

  function writeState(input: QueueRecord = {}): unknown {
    if (typeof queueStore.writeFallbackCoordinatorState !== "function") {
      return null;
    }
    return queueStore.writeFallbackCoordinatorState({
      ...input,
      nowMs: input.nowMs ?? timeSource.nowMs()
    });
  }

  function lock(workItemId?: unknown): () => boolean {
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

  async function defaultFallbackAction(input: FallbackInput = {}): Promise<unknown> {
    const delayMs = input.delayMs === undefined
      ? computeDeterministicRetryDelay({
          queueDefinitionId: input.workItem?.queueDefinitionId,
          workItemId: input.workItemId,
          attempt: asInt(input.workItem?.attempt, 1),
          ...resolvedPolicy.retryBackoff
        })
      : Math.max(0, asInt(input.delayMs, 0));
    return queueStore.retry({
      workItemId: input.workItemId,
      leaseId: input.leaseId,
      delayMs,
      actor: input.actor,
      reason: input.reason || "fallback_retry",
      error: input.error || {}
    });
  }

  async function executeFallbackAction(input: FallbackInput = {}): Promise<unknown> {
    const fallbackHandler = input.fallback || fallback;
    if (typeof fallbackHandler !== "function") {
      return defaultFallbackAction(input);
    }
    const outcome = await fallbackHandler({
      workItem: input.workItem || {},
      lease: input.lease || {},
      error: input.error,
      reason: input.reason,
      attempt: input.attempt
    });
    if (outcome?.action === "retry") {
      return queueStore.retry({
        workItemId: input.workItemId,
        leaseId: input.leaseId,
        delayMs: outcome?.delayMs ?? input.delayMs,
        actor: input.actor,
        reason: outcome?.reason || input.reason || "fallback_retry",
        error: outcome?.error || input.error || {}
      });
    }
    if (outcome?.action === "completed") {
      return queueStore.complete({
        workItemId: input.workItemId,
        leaseId: input.leaseId,
        actor: input.actor,
        reason: outcome.reason || "fallback_completed"
      });
    }
    if (outcome?.action === "cancelled") {
      return queueStore.cancelRunning({
        workItemId: input.workItemId,
        leaseId: input.leaseId,
        actor: input.actor,
        reason: outcome.reason || "fallback_cancelled"
      });
    }
    if (outcome?.action === "failed") {
      if (typeof queueStore.fail !== "function") throw new Error("Queue store fail operation is unavailable.");
      return queueStore.fail({
        workItemId: input.workItemId,
        leaseId: input.leaseId,
        actor: input.actor,
        reason: outcome.reason || "fallback_fail",
        error: outcome.error || input.error || {}
      });
    }
    if (outcome?.action === "progress") {
      return queueStore.progress({
        workItemId: input.workItemId,
        leaseId: input.leaseId,
        extendMs: outcome.extendMs,
        actor: input.actor,
        reason: outcome.reason || "fallback_progress"
      });
    }
    throw new Error("Fallback outcome action must be one of: completed, retry, cancelled, failed, progress.");
  }

  async function runFallback(input: FallbackInput = {}) {
    const workItem = input.workItem || {};
    const lease = input.lease || workItem.lease || {};
    const workItemId = toText(input.workItemId || workItem.workItemId);
    const leaseId = toText(input.leaseId || lease.leaseId);
    const fallbackTaskId = toText(input.fallbackTaskId || identityGenerator.fallbackTaskId());
    const unlock = lock(workItemId);
    const maxAttempts = Math.max(1, asInt(input.maxAttempts, resolvedPolicy.fallbackRetry.maxAttempts));
    let lastError: unknown = input.error || null;
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
        } catch (error: unknown) {
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

      if (typeof queueStore.fail === "function") {
        const result = await queueStore.fail({
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

  function startFallback(input: FallbackInput = {}) {
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
    inFlightCount(): number {
      return locks.size;
    }
  });
}
