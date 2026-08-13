import {
  DEFAULT_QUEUE_POLICY,
  resolveQueueMaxInFlight
} from "./policies.ts";

function toText(value?: any) : any {
  return String(value ?? "").trim();
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
}: Record<string, any> = {}) : any {
  if (!store || typeof store.claim !== "function") {
    throw new Error("Queue Push Dispatcher requires a work queue store.");
  }
  if (!workerRuntime || typeof workerRuntime.runLeased !== "function") {
    throw new Error("Queue Push Dispatcher requires Queue Worker Runtime.");
  }

  const dispatcherQueueDefinitionId: any = toText(queueDefinitionId);
  const dispatcherWorkerId: any = toText(workerId || workerRuntime.workerId || "push-dispatcher");
  const inFlight: any = new Map<any, any>();
  const creditLimitConfig: any = resolveQueueMaxInFlight(maxInFlight, {
    fallback: DEFAULT_QUEUE_POLICY.maxInFlight || 1000
  });
  const creditLimit: any = creditLimitConfig.limit;
  const terminalStates: any = new Set<any>(["completed", "failed", "cancelled", "expired"]);
  let reserved: any = 0;

  async function notifyTerminal(workItem?: any, source?: any) : Promise<any> {
    if (typeof onTerminal !== "function" || !terminalStates.has(workItem?.state)) return;
    await onTerminal({ workItem, source });
  }

  function status() : any {
    return {
      queueDefinitionId: dispatcherQueueDefinitionId,
      workerId: dispatcherWorkerId,
      inFlight: inFlight.size,
      reserved,
      creditLimit,
      requestedCreditLimit: creditLimitConfig.normalizedRequested,
      hardCreditLimit: creditLimitConfig.hardLimit,
      creditLimitClamped: creditLimitConfig.clamped,
      availableCredit: Math.max(0, creditLimit - reserved - inFlight.size)
    };
  }

  async function handoffToPeer(input: Record<string, any> = {}) : Promise<any> {
    if (typeof peerSelector !== "function") {
      return null;
    }
    const peer: any = await peerSelector({
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

  async function dispatchOnce(input: Record<string, any> = {}) : Promise<any> {
    if (input.signal?.aborted) {
      return {
        dispatched: 0,
        claimed: [],
        inFlight: inFlight.size,
        reserved,
        cancelled: true,
        reason: "dispatch_signal_aborted"
      };
    }
    const requestedBatch: any = Math.max(1, asInt(input.batchSize ?? input.batch ?? 1, 1));
    const batchSize: any = Math.min(requestedBatch, Math.max(0, creditLimit - reserved - inFlight.size));
    if (batchSize <= 0) {
      const peer: any = await handoffToPeer(input);
      return {
        dispatched: 0,
        claimed: [],
        inFlight: inFlight.size,
        reserved,
        backpressure: {
          localSaturated: true,
          peer
        }
      };
    }

    // Reserve credit synchronously before the first await so that
    // reserved + inFlight never exceeds the credit limit.
    reserved += batchSize;
    let claim: any;
    try {
      claim = await store.claim({
        ...input,
        queueDefinitionId: input.queueDefinitionId || dispatcherQueueDefinitionId,
        scope: input.scope || scope,
        schedulingScope: input.schedulingScope || {},
        workerId: input.workerId || dispatcherWorkerId,
        batchSize
      });
    } catch (error: any) {
      reserved = Math.max(0, reserved - batchSize);
      throw error;
    }
    // Convert only returned leases to in-flight and release the remainder.
    reserved = Math.max(0, reserved - batchSize);
    for (const workItem of [...(claim.failed || []), ...(claim.expired || [])]) {
      await notifyTerminal(workItem, "claim");
    }
    const started: any[] = [];
    for (const leased of claim.claimed || []) {
      const workItemId: any = leased.workItem.workItemId;
      const executionController: any = new AbortController();
      const abortFromCaller: any = () : any => executionController.abort(input.signal?.reason);
      input.signal?.addEventListener?.("abort", abortFromCaller, { once: true });
      const promise: any = Promise.resolve()
        .then(() : any => workerRuntime.runLeased({
          workItem: leased.workItem,
          lease: leased.lease,
          actor: input.actor,
          signal: executionController.signal
        }))
        .then(async (result?: any) : Promise<any> => {
          const inspection: any = await store.inspect({
            workItemId,
            queueDefinitionId: input.queueDefinitionId || dispatcherQueueDefinitionId,
            scope: input.scope || scope
          });
          await notifyTerminal(inspection.workItem, "worker");
          return result;
        })
        .catch((error?: any) : any => {
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
        .finally(() : any => {
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
      inFlight: inFlight.size,
      reserved
    };
  }

  async function drain({ timeoutMs = 30_000 }: Record<string, any> = {}) : Promise<any> {
    const startedAt: any = Date.now();
    while (inFlight.size > 0) {
      const remainingMs: any = Math.max(0, Number(timeoutMs) - (Date.now() - startedAt));
      if (remainingMs <= 0) {
        return {
          drained: false,
          inFlight: inFlight.size
        };
      }
      let timer: any = null;
      const outcome: any = await Promise.race([
        Promise.allSettled([...inFlight.values()].map((entry?: any) : any => entry.promise)).then(() : any => "settled"),
        new Promise((resolve?: any) : any => {
          timer = setTimeout(() : any => resolve("deadline"), remainingMs);
        })
      ]).finally(() : any => {
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

  function cancel(workItemId?: any, reason: any = null) : any {
    const entry: any = inFlight.get(toText(workItemId));
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
