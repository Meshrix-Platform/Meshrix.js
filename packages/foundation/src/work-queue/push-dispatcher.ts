import {
  DEFAULT_QUEUE_POLICY,
  resolveQueueMaxInFlight
} from "./policies.ts";

interface QueueWorkItem { workItemId: string; state?: string; [key: string]: unknown }
interface QueueClaimEvent { [key: string]: unknown }
interface QueueLease { leaseId?: string; [key: string]: unknown }
interface ClaimedWork { workItem: QueueWorkItem; lease: QueueLease }
interface ClaimResult {
  claimed?: ClaimedWork[]; recovered?: QueueClaimEvent[]; matured?: QueueClaimEvent[]; failed?: QueueWorkItem[]; expired?: QueueWorkItem[]; control?: object | null;
}
interface DispatchInput {
  signal?: AbortSignal; batchSize?: unknown; batch?: unknown; queueDefinitionId?: unknown; scope?: object;
  schedulingScope?: object; workerId?: unknown; actor?: object; [key: string]: unknown;
}
interface QueueStore {
  claim(input: DispatchInput & { batchSize: number }): Promise<ClaimResult>;
  inspect(input: { workItemId: string; queueDefinitionId: unknown; scope: object }): Promise<{ workItem?: QueueWorkItem }>;
}
interface WorkerRuntime { workerId?: string; runLeased?(input: { workItem: QueueWorkItem; lease: QueueLease; actor?: object; signal: AbortSignal }): Promise<unknown> }
interface PeerDispatcher { dispatchOnce?: (input: DispatchInput) => unknown; offer?: (input: DispatchInput) => unknown }
interface InFlightEntry { promise: Promise<unknown>; executionController: AbortController }
interface QueueLogger { error?(event: string, facts: object): void }

function toText(value?: unknown): string {
  return String(value ?? "").trim();
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
    code: typeof error === "object" && error !== null && "code" in error ? String(error.code ?? "") : ""
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
}: {
  store?: QueueStore; workerRuntime?: WorkerRuntime; queueDefinitionId?: unknown; scope?: object; workerId?: unknown;
  maxInFlight?: unknown; peerSelector?: ((input: DispatchInput & { status: object; reason: string }) => Promise<PeerDispatcher | null>) | null;
  onTerminal?: ((input: { workItem: QueueWorkItem; source: unknown }) => Promise<void> | void) | null; logger?: QueueLogger | null;
} = {}) {
  if (!store || typeof store.claim !== "function") {
    throw new Error("Queue Push Dispatcher requires a work queue store.");
  }
  if (!workerRuntime || typeof workerRuntime.runLeased !== "function") {
    throw new Error("Queue Push Dispatcher requires Queue Worker Runtime.");
  }
  const queueStore = store;
  const queueWorkerRuntime = workerRuntime as WorkerRuntime & Required<Pick<WorkerRuntime, "runLeased">>;

  const dispatcherQueueDefinitionId = toText(queueDefinitionId);
  const dispatcherWorkerId = toText(workerId || workerRuntime.workerId || "push-dispatcher");
  const inFlight = new Map<string, InFlightEntry>();
  const creditLimitConfig: { limit: number; normalizedRequested: number; hardLimit: number; clamped: boolean } = resolveQueueMaxInFlight(maxInFlight, {
    fallback: DEFAULT_QUEUE_POLICY.maxInFlight || 1000
  });
  const creditLimit = creditLimitConfig.limit;
  const terminalStates = new Set(["completed", "failed", "cancelled", "expired"]);
  let reserved = 0;

  async function notifyTerminal(workItem: QueueWorkItem | undefined, source: unknown): Promise<void> {
    if (!workItem || typeof onTerminal !== "function" || !terminalStates.has(workItem.state ?? "")) return;
    await onTerminal({ workItem, source });
  }

  function status() {
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

  async function handoffToPeer(input: DispatchInput = {}): Promise<unknown> {
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

  async function dispatchOnce(input: DispatchInput = {}) {
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
    const requestedBatch = Math.max(1, asInt(input.batchSize ?? input.batch ?? 1, 1));
    const batchSize = Math.min(requestedBatch, Math.max(0, creditLimit - reserved - inFlight.size));
    if (batchSize <= 0) {
      const peer = await handoffToPeer(input);
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
    let claim: ClaimResult;
    try {
      claim = await queueStore.claim({
        ...input,
        queueDefinitionId: input.queueDefinitionId || dispatcherQueueDefinitionId,
        scope: input.scope || scope,
        schedulingScope: input.schedulingScope || {},
        workerId: input.workerId || dispatcherWorkerId,
        batchSize
      });
    } catch (error: unknown) {
      reserved = Math.max(0, reserved - batchSize);
      throw error;
    }
    // Convert only returned leases to in-flight and release the remainder.
    reserved = Math.max(0, reserved - batchSize);
    for (const workItem of [...(claim.failed || []), ...(claim.expired || [])]) {
      await notifyTerminal(workItem, "claim");
    }
    const started: Array<{ workItemId: string; lease: QueueLease }> = [];
    for (const leased of claim.claimed || []) {
      const workItemId = leased.workItem.workItemId;
      const executionController = new AbortController();
      const abortFromCaller = (): void => executionController.abort(input.signal?.reason);
      input.signal?.addEventListener?.("abort", abortFromCaller, { once: true });
      const promise = Promise.resolve()
        .then(() => queueWorkerRuntime.runLeased({
          workItem: leased.workItem,
          lease: leased.lease,
          actor: input.actor,
          signal: executionController.signal
        }))
        .then(async (result: unknown) => {
          const inspection = await queueStore.inspect({
            workItemId,
            queueDefinitionId: input.queueDefinitionId || dispatcherQueueDefinitionId,
            scope: input.scope || scope
          });
          await notifyTerminal(inspection.workItem, "worker");
          return result;
        })
        .catch((error: unknown) => {
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
      inFlight: inFlight.size,
      reserved
    };
  }

  async function drain({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}) {
    const startedAt = Date.now();
    while (inFlight.size > 0) {
      const remainingMs = Math.max(0, Number(timeoutMs) - (Date.now() - startedAt));
      if (remainingMs <= 0) {
        return {
          drained: false,
          inFlight: inFlight.size
        };
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const outcome = await Promise.race([
        Promise.allSettled([...inFlight.values()].map((entry) => entry.promise)).then((): "settled" => "settled"),
        new Promise<"deadline">((resolve) => {
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

  function cancel(workItemId?: unknown, reason: unknown = null) {
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
