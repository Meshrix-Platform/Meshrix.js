import {
  createPostgresWorkQueueStore,
  createQueueDefinitionRegistry,
  createQueueFallbackCoordinator,
  createQueuePushDispatcher,
  createQueueWorkerRuntime,
  createSqliteWorkQueueStore,
  resolveQueueMaxInFlight
} from "@meshrix/foundation/work-queue/index";

function toText(value) {
  return String(value ?? "").trim();
}

function asPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function summarizeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code || ""
  };
}

function projectWorkItem(workItem) {
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

function projectTransition(transition) {
  if (!transition || typeof transition !== "object") return null;
  return Object.freeze({
    seq: Number(transition.seq || 0),
    workItemId: toText(transition.workItemId),
    queueDefinitionId: toText(transition.queueDefinitionId),
    queueDefinitionVersion: Number(transition.queueDefinitionVersion || 0),
    transition: toText(transition.transition),
    fromState: transition.fromState === null ? null : toText(transition.fromState),
    toState: toText(transition.toState),
    createdAtMs: Number(transition.createdAtMs || 0),
    adoptedTimeMs: Number(transition.adoptedTimeMs || 0)
  });
}

function projectInspection(inspection = {}) {
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
      ? inspection.stateCounts.map((entry) => ({
          state: toText(entry?.state),
          count: Number(entry?.count || 0)
        }))
      : []
  };
}

function projectMutationResult(result = {}) {
  const projected = {};
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

function projectControlResult(result = {}) {
  return {
    queueDefinitionId: toText(result.queueDefinitionId),
    mode: toText(result.mode),
    updatedAtMs: Number(result.updatedAtMs || 0)
  };
}

function projectRebuildResult(result = {}) {
  return {
    ok: result.ok === true,
    replayed: Number(result.replayed || 0),
    journalEntries: Number(result.journalEntries || 0),
    errors: Array.isArray(result.errors)
      ? result.errors.map((entry) => ({
          seq: Number(entry?.seq || 0),
          workItemId: toText(entry?.workItemId),
          reason: "projection_replay_error"
        }))
      : [],
    drift: Array.isArray(result.drift)
      ? result.drift.map((entry) => ({
          workItemId: toText(entry?.workItemId),
          column: toText(entry?.column),
          reason: toText(entry?.reason || "projection_drift")
        }))
      : []
  };
}

async function createDefaultStore({ userDataPath, store = null } = {}) {
  if (store) return store;
  const storeKind = toText(process.env.MESHRIX_WORK_QUEUE_STORE || "sqlite").toLowerCase();
  if (storeKind === "postgres" || storeKind === "postgresql") {
    return createPostgresWorkQueueStore({
      connectionString: process.env.MESHRIX_WORK_QUEUE_POSTGRES_URL || process.env.DATABASE_URL || "",
      poolOptions: {
        max: Number(process.env.MESHRIX_WORK_QUEUE_POSTGRES_POOL_MAX || 10)
      }
    });
  }
  return createSqliteWorkQueueStore({ userDataPath });
}

export async function createQueueApplicationPort({
  userDataPath,
  store = null,
  logger = null,
  dispatchIntervalMs = Number(process.env.MESHRIX_WORK_QUEUE_DISPATCH_INTERVAL_MS || 500),
  maxGlobalInFlight = Number(process.env.MESHRIX_WORK_QUEUE_GLOBAL_MAX_IN_FLIGHT || 8192)
} = {}) {
  const queueStore = await createDefaultStore({ userDataPath, store });
  const ownsStore = !store;
  const registry = createQueueDefinitionRegistry();
  const fallbackCoordinator = createQueueFallbackCoordinator({ store: queueStore, logger });
  const workerRuntime = createQueueWorkerRuntime({
    store: queueStore,
    workerId: "platform-queue-application-worker",
    fallbackCoordinator,
    handlers: {},
    logger
  });
  const registrations = new Map();
  const globalCredit = resolveQueueMaxInFlight(maxGlobalInFlight, { fallback: 8192 });
  let timer = null;
  let stopped = false;
  let dispatchCursor = 0;
  let dispatchChain = Promise.resolve();

  async function dispatchRegistration(registration, availableGlobalCredit = globalCredit.limit) {
    if (stopped || registration.closed || registration.dispatching) return null;
    if (!registration.consumerEnabled) {
      return { dispatched: 0, reason: "consumer_not_owned" };
    }
    registration.dispatching = true;
    const dispatchPromise = (async () => {
    try {
      return await registration.dispatcher.dispatchOnce({
        batchSize: Math.min(registration.batchSize, Math.max(0, availableGlobalCredit))
      });
    } catch (error) {
      const summary = summarizeError(error);
      logger?.error?.("work_queue.application.dispatch.failed", {
        queueDefinitionId: registration.definition.queueDefinitionId,
        error: summary
      });
      return { dispatched: 0, error: summary };
    } finally {
      registration.dispatching = false;
      if (registration.dispatchPromise === dispatchPromise) registration.dispatchPromise = null;
    }
    })();
    registration.dispatchPromise = dispatchPromise;
    return dispatchPromise;
  }

  async function requestDispatch(queueDefinitionId = "") {
    const id = toText(queueDefinitionId);
    if (id) {
      const registration = registrations.get(id);
      if (!registration) throw new Error(`Queue definition is not registered: ${id}`);
      if (!registration.consumerEnabled) return dispatchRegistration(registration);
    }
    const cycle = async () => {
      const active = [...registrations.values()].filter((entry) =>
        entry.consumerEnabled && !entry.closed
      );
      if (active.length === 0) return { queueCount: 0, results: [] };
      const offset = dispatchCursor % active.length;
      dispatchCursor = (offset + 1) % active.length;
      const ordered = [...active.slice(offset), ...active.slice(0, offset)];
      const results = [];
      for (const registration of ordered) {
        const inFlight = active.reduce((total, entry) =>
          total + Number(entry.dispatcher?.status().inFlight || 0), 0
        );
        const available = Math.max(0, globalCredit.limit - inFlight);
        if (available === 0) break;
        results.push(await dispatchRegistration(registration, available));
      }
      return { queueCount: ordered.length, results };
    };
    dispatchChain = dispatchChain.catch(() => null).then(cycle);
    return dispatchChain;
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
  } = {}) {
    if (stopped) throw new Error("Queue application port is stopped.");
    if (consumerEnabled && typeof handler !== "function") {
      throw new TypeError("Queue consumer registration requires a handler.");
    }
    const definition = registry.registerQueueDefinition({
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
    const resolvedMaxInFlight = resolveQueueMaxInFlight(maxInFlight, { fallback: 1 });
    const ownsConsumer = consumerEnabled === true;
    if (ownsConsumer) workerRuntime.registerHandler(definition.queueDefinitionId, handler);
    const dispatcher = ownsConsumer
      ? createQueuePushDispatcher({
          store: queueStore,
          workerRuntime,
          queueDefinitionId: definition.queueDefinitionId,
          scope,
          workerId,
          maxInFlight: resolvedMaxInFlight.limit,
          onTerminal,
          logger
        })
      : null;
    const registration = {
      definition,
      scope: { ...scope },
      dispatcher,
      consumerEnabled: ownsConsumer,
      batchSize: asPositiveInt(batchSize, 1),
      maxInFlight: resolvedMaxInFlight,
      dispatching: false,
      dispatchPromise: null,
      closed: false
    };
    registrations.set(definition.queueDefinitionId, registration);

    const facet = Object.freeze({
      definition,
      maxInFlight: resolvedMaxInFlight,
      enqueue(input = {}) {
        if (registration.closed) throw new Error(`Queue registration is closed: ${definition.queueDefinitionId}`);
        const resolved = registry.resolveQueueDefinitionForEnqueue({
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope,
          dedupeKey: input.dedupeKey
        });
        return queueStore.enqueue({ ...input, ...resolved, scope: registration.scope });
      },
      observe(input = {}) {
        return Promise.resolve().then(() => queueStore.inspect({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectInspection);
      },
      cancel(input = {}) {
        registration.dispatcher?.cancel(
          input.workItemId,
          new Error(input.reason || "Queue work cancellation requested.")
        );
        return Promise.resolve().then(() => queueStore.cancel({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectMutationResult);
      },
      expire(input = {}) {
        return Promise.resolve().then(() => queueStore.expire({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectMutationResult);
      },
      fail(input = {}) {
        return Promise.resolve().then(() => queueStore.fail({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectMutationResult);
      },
      recoverFailed(input = {}) {
        return Promise.resolve().then(() => queueStore.recover({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectMutationResult);
      },
      pause(input = {}) {
        return Promise.resolve().then(() => queueStore.pause({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectControlResult);
      },
      resume(input = {}) {
        return Promise.resolve().then(() => queueStore.resume({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectControlResult);
      },
      drain(input = {}) {
        return Promise.resolve().then(() => queueStore.drain({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectControlResult);
      },
      rebuildProjection(input = {}) {
        return Promise.resolve().then(() => queueStore.rebuildProjection({
          ...input,
          queueDefinitionId: definition.queueDefinitionId,
          scope: registration.scope
        })).then(projectRebuildResult);
      },
      requestDispatch() {
        if (registration.closed) throw new Error(`Queue registration is closed: ${definition.queueDefinitionId}`);
        return requestDispatch(definition.queueDefinitionId);
      },
      describe() {
        const status = dispatcher?.status() || {
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
      async close({ timeoutMs = 30_000 } = {}) {
        if (registration.closed) return { closed: true, idempotent: true };
        registration.closed = true;
        registrations.delete(definition.queueDefinitionId);
        await registration.dispatchPromise;
        if (dispatcher) {
          const drained = await dispatcher.drain({ timeoutMs });
          if (drained?.drained !== true) {
            throw new Error(`Queue dispatcher did not drain: ${definition.queueDefinitionId}`);
          }
          workerRuntime.unregisterHandler?.(definition.queueDefinitionId);
        }
        return { closed: true, idempotent: false };
      }
    });
    return facet;
  }

  function start() {
    if (timer || stopped) return { started: false, reason: stopped ? "stopped" : "already_started" };
    timer = setInterval(() => void requestDispatch(), Math.max(50, asPositiveInt(dispatchIntervalMs, 500)));
    timer.unref?.();
    void requestDispatch();
    return { started: true };
  }

  async function stop() {
    if (stopped) return { stopped: true, idempotent: true };
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    for (const registration of registrations.values()) {
      await registration.dispatchPromise;
      if (registration.dispatcher) {
        const drained = await registration.dispatcher.drain({ timeoutMs: 30_000 });
        if (drained?.drained !== true) {
          throw new Error(`Queue dispatcher did not drain: ${registration.definition.queueDefinitionId}`);
        }
      }
    }
    return { stopped: true, idempotent: false };
  }

  return Object.freeze({
    registerQueue,
    requestDispatch,
    start,
    stop,
    describe() {
      return {
        storeKind: queueStore.kind || "sqlite",
        queueCount: registrations.size,
        globalExecution: {
          inFlight: [...registrations.values()].reduce((total, registration) =>
            total + Number(registration.dispatcher?.status().inFlight || 0), 0
          ),
          capacity: globalCredit.limit,
          configuredCapacity: globalCredit.normalizedRequested,
          capacityClamped: globalCredit.clamped
        },
        queues: [...registrations.values()].map((registration) => ({
          queueDefinitionId: registration.definition.queueDefinitionId,
          consumerEnabled: registration.consumerEnabled,
          inFlight: registration.dispatcher?.status().inFlight || 0
        }))
      };
    },
    async close() {
      await stop();
      if (ownsStore) await queueStore.close?.();
    }
  });
}
