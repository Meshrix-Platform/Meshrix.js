import {
  createPostgresWorkQueueStore,
  createQueueDefinitionRegistry,
  createQueueFallbackCoordinator,
  createQueuePushDispatcher,
  createQueueWorkerRuntime,
  resolveQueueMaxInFlight
} from "@meshrix/foundation/work-queue/index";
import { createSqliteWorkQueueLane } from "@meshrix/foundation/work-queue/sqlite-store-lane";

function toText(value?: any) : any {
  return String(value ?? "").trim();
}

function asPositiveInt(value?: any, fallback?: any) : any {
  const parsed: any = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function summarizeError(error?: any) : any {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code || ""
  };
}

function projectWorkItem(workItem?: any) : any {
  if (!workItem || typeof workItem !== "object") return null;
  return Object.freeze({
    workItemId: toText(workItem.workItemId),
    queueDefinitionId: toText(workItem.queueDefinitionId),
    queueDefinitionVersion: Number(workItem.queueDefinitionVersion || 0),
    state: toText(workItem.state),
    priorityClass: toText(workItem.priorityClass || "normal"),
    availableAtMs: Number(workItem.availableAtMs || 0),
    expiresAtMs: Number(workItem.expiresAtMs || 0),
    attempt: Number(workItem.attempt || 0),
    maxAttempts: Number(workItem.maxAttempts || 0),
    createdAtMs: Number(workItem.createdAtMs || 0),
    updatedAtMs: Number(workItem.updatedAtMs || 0),
    lastTransitionSeq: Number(workItem.lastTransitionSeq || 0)
  });
}

function projectTransition(transition?: any) : any {
  if (!transition || typeof transition !== "object") return null;
  return Object.freeze({
    seq: Number(transition.seq || 0),
    workItemId: toText(transition.workItemId),
    queueDefinitionId: toText(transition.queueDefinitionId),
    queueDefinitionVersion: Number(transition.queueDefinitionVersion || 0),
    transition: toText(transition.transition),
    fromState: transition.fromState === null ? null : toText(transition.fromState),
    toState: toText(transition.toState),
    leaseId: toText(transition.leaseId),
    leaseSeq: Number(transition.leaseSeq || 0),
    operationId: toText(transition.operationId),
    reason: toText(transition.reason),
    createdAtMs: Number(transition.createdAtMs || 0),
    adoptedTimeMs: Number(transition.adoptedTimeMs || 0)
  });
}

function projectInspection(inspection: Record<string, any> = {}) : any {
  if (Object.hasOwn(inspection, "workItem")) {
    return {
      workItem: projectWorkItem(inspection.workItem),
      journal: Array.isArray(inspection.journal)
        ? inspection.journal.map(projectTransition).filter(Boolean)
        : []
    };
  }
  return {
    items: Array.isArray(inspection.items)
      ? inspection.items.map(projectWorkItem).filter(Boolean)
      : [],
    stateCounts: Array.isArray(inspection.stateCounts)
      ? inspection.stateCounts.map((entry?: any) : any => ({
          state: toText(entry?.state),
          count: Number(entry?.count || 0)
        }))
      : []
  };
}

function projectMutationResult(result: Record<string, any> = {}) : any {
  const projected: Record<string, any> = {};
  for (const key of [
    "accepted",
    "deduped",
    "cancelled",
    "completed",
    "expired",
    "failed",
    "idempotent",
    "recovered"
  ]) {
    if (Object.hasOwn(result, key)) projected[key] = result[key];
  }
  if (Object.hasOwn(result, "workItem")) projected.workItem = projectWorkItem(result.workItem);
  return projected;
}

function projectControlResult(result: Record<string, any> = {}) : any {
  return {
    queueDefinitionId: toText(result.queueDefinitionId),
    mode: toText(result.mode),
    updatedAtMs: Number(result.updatedAtMs || 0)
  };
}

function projectRebuildResult(result: Record<string, any> = {}) : any {
  return {
    ok: result.ok === true,
    replayed: Number(result.replayed || 0),
    journalEntries: Number(result.journalEntries || 0),
    errors: Array.isArray(result.errors)
      ? result.errors.map((entry?: any) : any => ({
          seq: Number(entry?.seq || 0),
          workItemId: toText(entry?.workItemId),
          reason: "projection_replay_error"
        }))
      : [],
    drift: Array.isArray(result.drift)
      ? result.drift.map((entry?: any) : any => ({
          workItemId: toText(entry?.workItemId),
          column: toText(entry?.column),
          reason: toText(entry?.reason || "projection_drift")
        }))
      : []
  };
}

async function createDefaultStore({ userDataPath, store = null }: Record<string, any> = {}) : Promise<any> {
  if (store) return store;
  const storeKind: any = toText(process.env.MESHRIX_WORK_QUEUE_STORE || "sqlite").toLowerCase();
  if (storeKind === "postgres" || storeKind === "postgresql") {
    return createPostgresWorkQueueStore({
      connectionString: process.env.MESHRIX_WORK_QUEUE_POSTGRES_URL || process.env.DATABASE_URL || "",
      poolOptions: {
        max: Number(process.env.MESHRIX_WORK_QUEUE_POSTGRES_POOL_MAX || 10)
      }
    });
  }
  return createSqliteWorkQueueLane({ userDataPath });
}

export async function createQueueApplicationPort({
  userDataPath,
  store = null,
  logger = null,
  dispatchIntervalMs = Number(process.env.MESHRIX_WORK_QUEUE_DISPATCH_INTERVAL_MS || 500),
  maxGlobalInFlight = Number(process.env.MESHRIX_WORK_QUEUE_GLOBAL_MAX_IN_FLIGHT || 8192)
}: Record<string, any> = {}) : Promise<any> {
  const queueStore: any = await createDefaultStore({ userDataPath, store });
  const ownsStore: any = !store;
  const registry: any = createQueueDefinitionRegistry();
  const fallbackCoordinator: any = createQueueFallbackCoordinator({ store: queueStore, logger });
  const workerRuntime: any = createQueueWorkerRuntime({
    store: queueStore,
    workerId: "platform-queue-application-worker",
    fallbackCoordinator,
    handlers: {},
    logger
  });
  const registrations: any = new Map<any, any>();
  const creditWaiters: Set<any> = new Set();
  const globalCredit: any = resolveQueueMaxInFlight(maxGlobalInFlight, { fallback: 8192 });
  const isSharedRemoteStore: boolean = (queueStore.kind || "sqlite") === "postgres";
  const configuredSharedReconcileMs: number = Number(process.env.MESHRIX_WORK_QUEUE_SHARED_RECONCILE_MS || 0);
  const crossProcessReconcileMs: number =
    isSharedRemoteStore && Number.isFinite(configuredSharedReconcileMs) && configuredSharedReconcileMs > 0
      ? Math.max(1_000, Math.trunc(configuredSharedReconcileMs))
      : 0;
  void dispatchIntervalMs;
  let started: boolean = false;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeWake: (() => void) | null = null;
  let stopped: any = false;
  let stopPromise: Promise<unknown> | undefined;
  let closePromise: Promise<void> | undefined;
  let dispatchCursor: any = 0;
  let globalReserved: any = 0;
  const MAX_TIMEOUT_MS = 2_147_483_647;

  function clearRegistrationWake(registration?: any): void {
    if (!registration) return;
    if (registration.wakeTimer) {
      clearTimeout(registration.wakeTimer);
      registration.wakeTimer = null;
    }
    registration.wakeDeadlineMs = Infinity;
  }

  function clearRegistrationExpiryWake(registration?: any): void {
    if (!registration) return;
    if (registration.expiryTimer) {
      clearTimeout(registration.expiryTimer);
      registration.expiryTimer = null;
    }
    registration.expiryDeadlineMs = Infinity;
  }

  function clearAllWakeTimers(): void {
    creditWaiters.clear();
    for (const registration of registrations.values()) {
      clearRegistrationWake(registration);
      clearRegistrationExpiryWake(registration);
    }
  }

  function scheduleRegistrationWakeAt(registration: any, targetMs: number): void {
    if (!started || stopped || !registration || registration.closed || !registration.consumerEnabled) return;
    if (!Number.isFinite(targetMs)) return;
    const now = Date.now();
    const clampedTarget = Math.max(now + 5, Math.trunc(targetMs));
    if (clampedTarget >= registration.wakeDeadlineMs && registration.wakeTimer !== null) return;
    clearRegistrationWake(registration);
    registration.wakeDeadlineMs = clampedTarget;
    const delay = Math.min(MAX_TIMEOUT_MS, clampedTarget - now);
    registration.wakeTimer = setTimeout(() => {
      registration.wakeTimer = null;
      registration.wakeDeadlineMs = Infinity;
      if (!started || stopped || registration.closed) return;
      if (Date.now() < clampedTarget) {
        scheduleRegistrationWakeAt(registration, targetMs);
        return;
      }
      registration.lastFiredWakeMs = Math.max(registration.lastFiredWakeMs || 0, Math.trunc(targetMs));
      void triggerRegistration(registration);
    }, delay);
    registration.wakeTimer.unref?.();
  }

  async function runExpirySweep(registration: any): Promise<void> {
    if (!started || stopped || !registration || registration.closed || !registration.consumerEnabled) return;
    if (typeof queueStore.expireDue !== "function") return;
    try {
      while (started && !stopped && !registration.closed) {
        const out: any = await queueStore.expireDue({
          queueDefinitionId: registration.definition.queueDefinitionId,
          scope: registration.scope,
          limit: 64
        });
        const expiredItems: any[] = Array.isArray(out?.expired) ? out.expired : [];
        if (typeof registration.onTerminal === "function") {
          for (const workItem of expiredItems) {
            await registration.onTerminal({ workItem, source: "expiry" });
          }
        }
        if (!out?.hasMore) break;
      }
    } catch {
      // Best-effort independent expiry maintenance.
    }
    if (started && !stopped && !registration.closed) {
      void refreshNextDueWake(registration);
    }
  }

  function scheduleRegistrationExpiryAt(registration: any, targetMs: number): void {
    if (!started || stopped || !registration || registration.closed || !registration.consumerEnabled) return;
    if (!Number.isFinite(targetMs)) return;
    const now = Date.now();
    const clampedTarget = Math.max(now + 5, Math.trunc(targetMs));
    if (clampedTarget >= registration.expiryDeadlineMs && registration.expiryTimer !== null) return;
    clearRegistrationExpiryWake(registration);
    registration.expiryDeadlineMs = clampedTarget;
    const delay = Math.min(MAX_TIMEOUT_MS, clampedTarget - now);
    registration.expiryTimer = setTimeout(() => {
      registration.expiryTimer = null;
      registration.expiryDeadlineMs = Infinity;
      if (!started || stopped || registration.closed) return;
      if (Date.now() < clampedTarget) {
        scheduleRegistrationExpiryAt(registration, targetMs);
        return;
      }
      registration.lastFiredExpiryMs = Math.max(registration.lastFiredExpiryMs || 0, Math.trunc(targetMs));
      void runExpirySweep(registration);
    }, delay);
    registration.expiryTimer.unref?.();
  }

  async function refreshNextDueWake(registration?: any): Promise<void> {
    if (!started || stopped || !registration || registration.closed || !registration.consumerEnabled) return;
    if (typeof queueStore.nextWakeAtMs !== "function") return;
    try {
      const canClaimReady =
        globalCredit.limit - globalReserved - globalInFlight() > 0 &&
        Number(registration.dispatcher?.status().availableCredit || 0) > 0;
      const wakeInfo: any = await queueStore.nextWakeAtMs({
        queueDefinitionId: registration.definition.queueDefinitionId,
        scope: registration.scope,
        canClaimReady,
        afterMs: Number(registration.lastFiredWakeMs || 0),
        afterExpiryMs: Number(registration.lastFiredExpiryMs || 0)
      });
      const candidate = Number(wakeInfo?.nextWakeAtMs ?? 0);
      if (canClaimReady && Number.isFinite(candidate) && candidate > 0) {
        scheduleRegistrationWakeAt(registration, candidate);
      } else {
        clearRegistrationWake(registration);
      }
      const expiryCandidate = Number(wakeInfo?.nextExpiryAtMs ?? 0);
      if (Number.isFinite(expiryCandidate) && expiryCandidate > 0) {
        scheduleRegistrationExpiryAt(registration, expiryCandidate);
      } else {
        clearRegistrationExpiryWake(registration);
      }
    } catch {
      // Best-effort wakeup hint; explicit enqueue/settle/resume signals remain active.
    }
  }

  function globalInFlight() : any {
    let total: any = 0;
    for (const registration of registrations.values()) {
      total += Number(registration.dispatcher?.status().inFlight || 0);
    }
    return total;
  }

  function reserveGlobalCredit(requested: any = 0) : any {
    const available: any = Math.max(0, globalCredit.limit - globalReserved - globalInFlight());
    const grant: any = Math.min(Math.max(0, Math.trunc(Number(requested) || 0)), available);
    globalReserved += grant;
    return grant;
  }

  function releaseGlobalCredit(count: any = 0) : any {
    globalReserved = Math.max(0, globalReserved - Math.max(0, Math.trunc(Number(count) || 0)));
    if (started && !stopped && creditWaiters.size > 0) {
      let free = globalCredit.limit - globalReserved - globalInFlight();
      for (const waiter of [...creditWaiters]) {
        if (free <= 0) break;
        creditWaiters.delete(waiter);
        if (!waiter.closed && waiter.consumerEnabled) {
          free -= 1;
          void triggerRegistration(waiter);
        }
      }
    }
  }

  async function dispatchRegistration(registration?: any) : Promise<any> {
    if (stopped || registration.closed) return null;
    if (!registration.consumerEnabled) {
      return { dispatched: 0, reason: "consumer_not_owned" };
    }
    const grant: any = reserveGlobalCredit(registration.batchSize);
    if (grant <= 0) {
      if (started && !stopped && !registration.closed) {
        creditWaiters.add(registration);
      }
      return {
        dispatched: 0,
        reason: "global_credit_exhausted",
        backpressure: { globalSaturated: true }
      };
    }
    creditWaiters.delete(registration);
    try {
      const result: any = await registration.dispatcher.dispatchOnce({ batchSize: grant });
      return result;
    } catch (error: any) {
      const summary: any = summarizeError(error);
      logger?.error?.("work_queue.application.dispatch.failed", {
        queueDefinitionId: registration.definition.queueDefinitionId,
        error: summary
      });
      return { dispatched: 0, error: summary };
    } finally {
      releaseGlobalCredit(grant);
    }
  }

  function triggerRegistration(registration?: any) : any {
    if (stopped || registration.closed) {
      return Promise.resolve({ dispatched: 0, reason: "registration_closed" });
    }
    if (!registration.consumerEnabled) {
      return Promise.resolve({ dispatched: 0, reason: "consumer_not_owned" });
    }
    if (registration.dispatching) {
      registration.triggerPending = true;
      return registration.dispatchPromise || Promise.resolve({ dispatched: 0, coalesced: true });
    }
    registration.dispatching = true;
    const dispatchPromise: any = (async () : Promise<any> => {
      try {
        const result: any = await dispatchRegistration(registration);
        if (result && Number(result.dispatched || 0) >= registration.batchSize &&
            Number(registration.dispatcher?.status().availableCredit || 0) > 0) {
          registration.triggerPending = true;
        }
        return result;
      } finally {
        registration.dispatching = false;
        registration.dispatchPromise = null;
        if (registration.triggerPending && !stopped && !registration.closed) {
          registration.triggerPending = false;
          registration.dispatchPromise = triggerRegistration(registration);
        } else if (started && !stopped && !registration.closed) {
          void refreshNextDueWake(registration);
        }
      }
    })();
    registration.dispatchPromise = dispatchPromise;
    return dispatchPromise;
  }

  async function requestDispatch(queueDefinitionId: any = "") : Promise<any> {
    const id: any = toText(queueDefinitionId);
    if (id) {
      const registration: any = registrations.get(id);
      if (!registration) throw new Error(`Queue definition is not registered: ${id}`);
      return triggerRegistration(registration);
    }
    const cycle: any = async () : Promise<any> => {
      const active: any = [...registrations.values()].filter((entry?: any) : any =>
        entry.consumerEnabled && !entry.closed
      );
      if (active.length === 0) return { queueCount: 0, results: [] };
      const offset: any = dispatchCursor % active.length;
      dispatchCursor = (offset + 1) % active.length;
      const ordered: any[] = [...active.slice(offset), ...active.slice(0, offset)];
      const pending: any[] = ordered.map(triggerRegistration);
      const settled: any = await Promise.allSettled(pending);
      const results: any[] = settled.map((outcome?: any) : any =>
        outcome.status === "fulfilled"
          ? outcome.value
          : { dispatched: 0, error: summarizeError(outcome.reason) }
      );
      return { queueCount: ordered.length, results };
    };
    return cycle();
  }

  async function registerQueue({
    queueDefinitionId,
    queueDefinitionVersion,
    label,
    ownerCapability,
    metadata = {},
    policy = {},
    scope = {},
    handler,
    workerId = "platform-queue-worker",
    maxInFlight = 1,
    batchSize = 1,
    onTerminal = null,
    consumerEnabled = true
  }: Record<string, any> = {}) : Promise<any> {
    if (stopped) throw new Error("Queue application port is stopped.");
    if (consumerEnabled && typeof handler !== "function") {
      throw new TypeError("Queue consumer registration requires a handler.");
    }
    const definition: any = registry.registerQueueDefinition({
      queueDefinitionId,
      queueDefinitionVersion,
      label,
      ownerCapability,
      metadata,
      policy
    });
    if (registrations.has(definition.queueDefinitionId)) {
      throw new Error(`Queue definition is already registered: ${definition.queueDefinitionId}`);
    }
    await queueStore.registerQueueDefinition?.(definition);
    const resolvedMaxInFlight: any = resolveQueueMaxInFlight(maxInFlight, { fallback: 1 });
    const ownsConsumer: any = consumerEnabled === true;
    if (ownsConsumer) workerRuntime.registerHandler(definition.queueDefinitionId, handler);
    const dispatcher: any = ownsConsumer
      ? createQueuePushDispatcher({
          store: queueStore,
          workerRuntime,
          queueDefinitionId: definition.queueDefinitionId,
          scope,
          workerId,
          maxInFlight: resolvedMaxInFlight.limit,
          onTerminal,
          onSettled: () => {
            if (started && !stopped) void requestDispatch();
          },
          logger
        })
      : null;
    const registration: Record<string, any> = {
      definition,
      scope: { ...scope },
      dispatcher,
      consumerEnabled: ownsConsumer,
      batchSize: asPositiveInt(batchSize, 1),
      maxInFlight: resolvedMaxInFlight,
      onTerminal,
      dispatching: false,
      triggerPending: false,
      dispatchPromise: null,
      wakeTimer: null,
      wakeDeadlineMs: Infinity,
      lastFiredWakeMs: 0,
      expiryTimer: null,
      expiryDeadlineMs: Infinity,
      lastFiredExpiryMs: 0,
      closed: false
    };
    registrations.set(definition.queueDefinitionId, registration);

    const remoteScope: Readonly<Record<string, any>> = Object.freeze({ ...scope });
    function remoteGuard() : void {
      if (registration.consumerEnabled) {
        throw Object.assign(new Error("Remote consumption is not enabled for this queue."), {
          code: "remote_consumer_disabled"
        });
      }
      if (registration.closed) {
        throw new Error(`Queue registration is closed: ${definition.queueDefinitionId}`);
      }
    }
    function scopeBoundCommand(input: Record<string, any> = {}) : Record<string, any> {
      // Callers never influence the queue, scheduling scope or tenant routing:
      // every remote mutation is bound to the registration captured here.
      const bound: Record<string, any> = { ...input };
      delete bound.queueDefinitionId;
      delete bound.queueDefinitionVersion;
      delete bound.scope;
      delete bound.scopeKey;
      delete bound.schedulingScope;
      delete bound.consumerId;
      delete bound.workerId;
      bound.queueDefinitionId = definition.queueDefinitionId;
      bound.scope = remoteScope;
      bound.workerId = workerId;
      return bound;
    }
    async function assertForeignTaskGuard(input: Record<string, any> = {}, inspection?: any) : Promise<any> {
      // Inspect the target item inside the captured queue definition and scope
      // and reject mutations aimed at work owned by another queue,
      // organization or device before the store-level lease fence is reached.
      const workItemId = toText(input.workItemId || input.taskId || "");
      if (!workItemId) {
        const error: any = new Error("Remote queue mutation requires workItemId.");
        error.code = "remote_consumer_target_invalid";
        throw error;
      }
      const inspected: any = inspection ?? await queueStore.inspect(scopeBoundCommand({ workItemId }));
      const item: any = inspected?.workItem || null;
      if (!item || item.queueDefinitionId !== definition.queueDefinitionId ||
          ["tenantId", "workspaceId", "projectId"].some((field) =>
            toText(item.schedulingScope?.[field]) !== toText(remoteScope[field]))) {
        const error: any = new Error(`Remote queue work item is not in scope: ${workItemId}`);
        error.code = "remote_consumer_foreign_task";
        throw error;
      }
      return item;
    }

    const facet: Readonly<Record<string, any>> = Object.freeze({
      definition,
      maxInFlight: resolvedMaxInFlight,
      enqueue(input: Record<string, any> = {}) : any {
        if (registration.closed) throw new Error(`Queue registration is closed: ${definition.queueDefinitionId}`);
        const resolved: any = registry.resolveQueueDefinitionForEnqueue({
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope,
          dedupeKey: input.dedupeKey
        });
        return Promise.resolve(queueStore.enqueue({ ...input, ...resolved, scope: registration.scope })).then((enqueued: any) => {
          if (started && !stopped && registration.consumerEnabled && !registration.closed) {
            const availableAt = Number(enqueued?.workItem?.availableAtMs || 0);
            const expiresAt = Number(enqueued?.workItem?.expiresAtMs || 0);
            if (expiresAt > 0) {
              scheduleRegistrationExpiryAt(registration, expiresAt);
            }
            if (availableAt > Date.now()) {
              scheduleRegistrationWakeAt(registration, availableAt);
            } else {
              registration.lastFiredWakeMs = 0;
              void triggerRegistration(registration);
            }
          }
          return enqueued;
        });
      },
      observe(input: Record<string, any> = {}) : any {
        return Promise.resolve().then(() : any => queueStore.inspect({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectInspection);
      },
      cancel(input: Record<string, any> = {}) : any {
        registration.dispatcher?.cancel(
          input.workItemId,
          new Error(input.reason || "Queue work cancellation requested.")
        );
        return Promise.resolve().then(() : any => queueStore.cancel({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectMutationResult);
      },
      expire(input: Record<string, any> = {}) : any {
        return Promise.resolve().then(() : any => queueStore.expire({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectMutationResult);
      },
      fail(input: Record<string, any> = {}) : any {
        return Promise.resolve().then(() : any => queueStore.fail({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectMutationResult);
      },
      recoverFailed(input: Record<string, any> = {}) : any {
        return Promise.resolve().then(() : any => queueStore.recover({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then((res: any) => {
          if (started && !stopped && registration.consumerEnabled && !registration.closed) {
            void triggerRegistration(registration);
          }
          return projectMutationResult(res);
        });
      },
      pause(input: Record<string, any> = {}) : any {
        return Promise.resolve().then(() : any => queueStore.pause({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then((res: any) => {
          clearRegistrationWake(registration);
          return projectControlResult(res);
        });
      },
      resume(input: Record<string, any> = {}) : any {
        return Promise.resolve().then(() : any => queueStore.resume({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then((res: any) => {
          registration.lastFiredWakeMs = 0;
          if (started && !stopped && registration.consumerEnabled && !registration.closed) {
            void triggerRegistration(registration);
          }
          return projectControlResult(res);
        });
      },
      drain(input: Record<string, any> = {}) : any {
        return Promise.resolve().then(() : any => queueStore.drain({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectControlResult);
      },
      rebuildProjection(input: Record<string, any> = {}) : any {
        return Promise.resolve().then(() : any => queueStore.rebuildProjection({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectRebuildResult);
      },
      requestDispatch() : any {
        if (registration.closed) throw new Error(`Queue registration is closed: ${definition.queueDefinitionId}`);
        return requestDispatch(definition.queueDefinitionId);
      },
      remote: Object.freeze({
        scope: remoteScope,
        inspectWorkItem(input: Record<string, any> = {}) : any {
          remoteGuard();
          return Promise.resolve().then(async () : Promise<any> => {
            const inspected: any = await queueStore.inspect({
              workItemId: input.workItemId || input.taskId || "",
              includeJournal: input.includeJournal === true
            });
            if (inspected?.workItem) await assertForeignTaskGuard(input, inspected);
            return inspected || { workItem: null, journal: [] };
          });
        },
        async listLeased(afterWorkItemId = "") : Promise<any[]> {
          remoteGuard();
          const inspection = await queueStore.inspect(scopeBoundCommand({
            states: ["running"], afterWorkItemId, limit: 128, includeStateCounts: false
          }));
          const items = inspection?.items || [];
          for (const workItem of items) {
            await assertForeignTaskGuard({ workItemId: workItem.workItemId }, { workItem });
          }
          return items;
        },
        claim(input: Record<string, any> = {}) : any {
          remoteGuard();
          return Promise.resolve().then(() : any => queueStore.claim(scopeBoundCommand({
            ...input,
            // The worker identity is always the server-derived consumer id;
            // device requests can never choose or spoof it.
            workerId
          })));
        },
        progress(input: Record<string, any> = {}) : any {
          remoteGuard();
          return Promise.resolve().then(async () : Promise<any> => {
            await assertForeignTaskGuard(input);
            return queueStore.progress(scopeBoundCommand(input));
          });
        },
        complete(input: Record<string, any> = {}) : any {
          remoteGuard();
          return Promise.resolve().then(async () : Promise<any> => {
            await assertForeignTaskGuard(input);
            return queueStore.complete(scopeBoundCommand(input));
          });
        },
        fail(input: Record<string, any> = {}) : any {
          remoteGuard();
          return Promise.resolve().then(async () : Promise<any> => {
            await assertForeignTaskGuard(input);
            return queueStore.fail(scopeBoundCommand(input));
          });
        },
        markInDoubt(input: Record<string, any> = {}) : any {
          remoteGuard();
          return Promise.resolve().then(async () : Promise<any> => {
            await assertForeignTaskGuard(input);
            return queueStore.markInDoubt(scopeBoundCommand(input));
          });
        },
        acknowledgeTermination(input: Record<string, any> = {}) : any {
          remoteGuard();
          return Promise.resolve().then(async () : Promise<any> => {
            await assertForeignTaskGuard(input);
            return queueStore.acknowledgeTermination(scopeBoundCommand(input));
          });
        },
        recordSinkReceipt(input: Record<string, any> = {}) : any {
          remoteGuard();
          return Promise.resolve().then(async () : Promise<any> => {
            await assertForeignTaskGuard(input);
            return queueStore.recordSinkReceipt(scopeBoundCommand(input));
          });
        },
        reconcileInDoubt(input: Record<string, any> = {}) : any {
          remoteGuard();
          return Promise.resolve().then(async () : Promise<any> => {
            await assertForeignTaskGuard(input);
            return queueStore.reconcileInDoubt(scopeBoundCommand(input));
          });
        },
        cancelRunning(input: Record<string, any> = {}) : any {
          remoteGuard();
          return Promise.resolve().then(async () : Promise<any> => {
            await assertForeignTaskGuard(input);
            return queueStore.cancelRunning(scopeBoundCommand(input));
          });
        }
      }),
      describe() : any {
        const status: any = dispatcher?.status() || {
          inFlight: 0,
          creditLimit: 0,
          availableCredit: 0
        };
        return {
          queueDefinitionId: definition.queueDefinitionId,
          label: definition.label,
          storeKind: queueStore.kind || "sqlite",
          configuredMaxInFlight: resolvedMaxInFlight.normalizedRequested,
          effectiveMaxInFlight: resolvedMaxInFlight.limit,
          hardMaxInFlight: resolvedMaxInFlight.hardLimit,
          maxInFlightClamped: resolvedMaxInFlight.clamped,
          consumerEnabled: registration.consumerEnabled,
          execution: {
            inFlight: status.inFlight,
            capacity: status.creditLimit,
            availableCapacity: status.availableCredit,
            maxHandlerDurationMs: workerRuntime.maxHandlerDurationMs
          }
        };
      },
      close({ timeoutMs }: { timeoutMs?: number } = {}) {
        if (registration.closePromise) return registration.closePromise;
        registration.closed = true;
        creditWaiters.delete(registration);
        clearRegistrationWake(registration);
        clearRegistrationExpiryWake(registration);
        // Retain the registration until all work settles so owner stop/close
        // can still drain it, including after an explicitly bounded attempt.
        registration.closePromise = (async () => {
          while (registration.dispatchPromise) await registration.dispatchPromise;
          if (dispatcher) {
            const drained = await dispatcher.drain({ timeoutMs });
            if (drained?.drained !== true) {
              throw new Error(`Queue dispatcher did not drain: ${definition.queueDefinitionId}`);
            }
            workerRuntime.unregisterHandler?.(definition.queueDefinitionId);
          }
          registrations.delete(definition.queueDefinitionId);
          return { closed: true };
        })().catch((error: unknown) => {
          registration.closePromise = null;
          throw error;
        });
        return registration.closePromise;
      }
    });
    return facet;
  }

  function start() : any {
    if (started || stopped) return { started: false, reason: stopped ? "stopped" : "already_started" };
    started = true;
    if (typeof queueStore.subscribeNotifications === "function") {
      const sub = queueStore.subscribeNotifications({
        onWake: () => {
          if (started && !stopped) void requestDispatch();
        },
        onConnected: () => {
          if (started && !stopped) void requestDispatch();
        }
      });
      unsubscribeWake = typeof sub === "function" ? sub : () => sub?.close?.();
    }
    if (crossProcessReconcileMs > 0) {
      reconcileTimer = setInterval(() => void requestDispatch(), crossProcessReconcileMs);
      reconcileTimer.unref?.();
    }
    void requestDispatch();
    return { started: true };
  }

  function stop(): Promise<unknown> {
    if (!stopPromise) {
      stopped = true;
      started = false;
      clearAllWakeTimers();
      if (unsubscribeWake) { unsubscribeWake(); unsubscribeWake = null; }
      if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
      stopPromise = (async () => {
        for (const registration of registrations.values()) {
          while (registration.dispatchPromise) await registration.dispatchPromise;
          if (registration.closePromise) await registration.closePromise;
          else if (registration.dispatcher) await registration.dispatcher.drain();
        }
        return { stopped: true };
      })().catch((error: unknown) => {
        stopPromise = undefined;
        throw error;
      });
    }
    return stopPromise;
  }

  return Object.freeze({
    registerQueue,
    requestDispatch,
    start,
    stop,
    describe() : any {
      return {
        storeKind: queueStore.kind || "sqlite",
        queueCount: registrations.size,
        globalExecution: {
          inFlight: [...registrations.values()].reduce((total?: any, registration?: any) : any =>
            total + Number(registration.dispatcher?.status().inFlight || 0), 0
          ),
          capacity: globalCredit.limit,
          reserved: globalReserved,
          configuredCapacity: globalCredit.normalizedRequested,
          capacityClamped: globalCredit.clamped
        },
        queues: [...registrations.values()].map((registration?: any) : any => ({
          queueDefinitionId: registration.definition.queueDefinitionId,
          consumerEnabled: registration.consumerEnabled,
          inFlight: registration.dispatcher?.status().inFlight || 0
        }))
      };
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        await stop();
        if (ownsStore) await queueStore.close?.();
      })().catch((error: unknown) => {
        closePromise = undefined;
        throw error;
      });
      return closePromise;
    }
  });
}
