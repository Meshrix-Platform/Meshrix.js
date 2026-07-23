import {
  DEFAULT_QUEUE_POLICY,
  resolveQueueMaxInFlight
} from "./policies.mjs";

function toText(value) {
  return String(value ?? "").trim();
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
    code: error.code || ""
  };
}

export function createQueuePushDispatcher({
  store,
  workerRuntime,
  queueDefinitionId = "",
  scope = {},
  workerId = "",
  maxInFlight = DEFAULT_QUEUE_POLICY.maxInFlight || 1000,
  peerSelector = null,
  onTerminal = null,
  logger = null
} = {}) {
  if (!store || typeof store.claim !== "function") {
    throw new Error("Queue Push Dispatcher requires a work queue store.");
  }
  if (!workerRuntime || typeof workerRuntime.runLeased !== "function") {
    throw new Error("Queue Push Dispatcher requires Queue Worker Runtime.");
  }

  const dispatcherQueueDefinitionId = toText(queueDefinitionId);
  const dispatcherWorkerId = toText(workerId || workerRuntime.workerId || "push-dispatcher");
  const inFlight = new Map();
  const creditLimitConfig = resolveQueueMaxInFlight(maxInFlight, {
    fallback: DEFAULT_QUEUE_POLICY.maxInFlight || 1000
  });
  const creditLimit = creditLimitConfig.limit;
  const terminalStates = new Set(["completed", "failed", "cancelled", "expired"]);

  async function notifyTerminal(workItem, source) {
    if (typeof onTerminal !== "function" || !terminalStates.has(workItem?.state)) return;
    await onTerminal({ workItem, source });
  }

  function status() {
    return {
      queueDefinitionId: dispatcherQueueDefinitionId,
      workerId: dispatcherWorkerId,
      inFlight: inFlight.size,
      creditLimit,
      requestedCreditLimit: creditLimitConfig.normalizedRequested,
      hardCreditLimit: creditLimitConfig.hardLimit,
      creditLimitClamped: creditLimitConfig.clamped,
      availableCredit: Math.max(0, creditLimit - inFlight.size)
    };
  }

  async function handoffToPeer(input = {}) {
    if (typeof peerSelector !== "function") {
      return null;
    }
    const peer = await peerSelector({
      ...input,
      status: status(),
      reason: "local_backpressure"
    });
    if (!peer) {
      return null;
    }
    if (typeof peer.dispatchOnce === "function") {
      return peer.dispatchOnce(input);
    }
    if (typeof peer.offer === "function") {
      return peer.offer(input);
    }
    return {
      accepted: false,
      reason: "peer_has_no_dispatch_interface"
    };
  }

  async function dispatchOnce(input = {}) {
    if (input.signal?.aborted) {
      return {
        dispatched: 0,
        claimed: [],
        inFlight: inFlight.size,
        cancelled: true,
        reason: "dispatch_signal_aborted"
      };
    }
    const currentStatus = status();
    const requestedBatch = Math.max(1, asInt(input.batchSize ?? input.batch ?? 1, 1));
    const batchSize = Math.min(requestedBatch, currentStatus.availableCredit);
    if (batchSize <= 0) {
      const peer = await handoffToPeer(input);
      return {
        dispatched: 0,
        claimed: [],
        inFlight: inFlight.size,
        backpressure: {
          localSaturated: true,
          peer
        }
      };
    }

    const claim = await store.claim({
      ...input,
      queueDefinitionId: input.queueDefinitionId || dispatcherQueueDefinitionId,
      scope: input.scope || scope,
      schedulingScope: input.schedulingScope || {},
      workerId: input.workerId || dispatcherWorkerId,
      batchSize
    });
    for (const workItem of [...(claim.failed || []), ...(claim.expired || [])]) {
      await notifyTerminal(workItem, "claim");
    }
    const started = [];
    for (const leased of claim.claimed || []) {
      const workItemId = leased.workItem.workItemId;
      const executionController = new AbortController();
      const abortFromCaller = () => executionController.abort(input.signal?.reason);
      input.signal?.addEventListener?.("abort", abortFromCaller, { once: true });
      const promise = Promise.resolve()
        .then(() => workerRuntime.runLeased({
          workItem: leased.workItem,
          lease: leased.lease,
          actor: input.actor,
          signal: executionController.signal
        }))
        .then(async (result) => {
          const inspection = await store.inspect({
            workItemId,
            queueDefinitionId: input.queueDefinitionId || dispatcherQueueDefinitionId,
            scope: input.scope || scope
          });
          await notifyTerminal(inspection.workItem, "worker");
          return result;
        })
        .catch((error) => {
          logger?.error?.("queue.push.dispatch.failed", {
            workItemId,
            error: summarizeError(error)
          });
          return {
            failed: true,
            workItemId,
            error: summarizeError(error)
          };
        })
        .finally(() => {
          input.signal?.removeEventListener?.("abort", abortFromCaller);
          inFlight.delete(workItemId);
        });
      inFlight.set(workItemId, { promise, executionController });
      started.push({
        workItemId,
        lease: leased.lease
      });
    }

    return {
      dispatched: started.length,
      claimed: claim.claimed || [],
      recovered: claim.recovered || [],
      matured: claim.matured || [],
      failed: claim.failed || [],
      control: claim.control || null,
      started,
      inFlight: inFlight.size
    };
  }

  async function drain({ timeoutMs = 30_000 } = {}) {
    const startedAt = Date.now();
    while (inFlight.size > 0) {
      const remainingMs = Math.max(0, Number(timeoutMs) - (Date.now() - startedAt));
      if (remainingMs <= 0) {
        return {
          drained: false,
          inFlight: inFlight.size
        };
      }
      let timer = null;
      const outcome = await Promise.race([
        Promise.allSettled([...inFlight.values()].map((entry) => entry.promise)).then(() => "settled"),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("deadline"), remainingMs);
        })
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (outcome === "deadline" && inFlight.size > 0) {
        return {
          drained: false,
          inFlight: inFlight.size
        };
      }
    }
    return {
      drained: true,
      inFlight: 0
    };
  }

  function cancel(workItemId, reason = null) {
    const entry = inFlight.get(toText(workItemId));
    if (!entry) return { signalled: false, inFlight: false };
    if (!entry.executionController.signal.aborted) {
      entry.executionController.abort(reason || new Error("Queue work cancellation requested."));
    }
    return { signalled: true, inFlight: true };
  }

  return Object.freeze({
    status,
    dispatchOnce,
    cancel,
    drain
  });
}
