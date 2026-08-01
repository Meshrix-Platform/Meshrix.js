const DEFAULT_LIMITS: Readonly<Record<string, any>> = Object.freeze({
  maxAdapters: 32,
  maxConcurrent: 4,
  maxQueued: 64,
  connectTimeoutMs: 5_000,
  taskTimeoutMs: 30_000,
  closeTimeoutMs: 5_000,
  shutdownTimeoutMs: 10_000,
  maxConnectAttempts: 3,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 5_000
});

const ADAPTER_ID_PATTERN: any = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const RETRYABLE_STATES: any = new Set<any>(["idle", "connecting", "retry_wait", "degraded"]);

export const INTEGRATION_TASK_SUPERVISOR_PROTOCOL_VERSION: any =
  "v0.0.1:platform:integration-task-supervisor-1";

export class IntegrationTaskSupervisorError extends Error {
  adapterState: any;
  code: any;
  name: any;
  retryable: any;
  constructor(code?: any, { retryable = false, adapterState = "unavailable" }: Record<string, any> = {}) {
    super("The optional integration task was not accepted.");
    this.name = "IntegrationTaskSupervisorError";
    this.code = String(code || "integration_task_rejected");
    this.retryable = retryable === true;
    this.adapterState = String(adapterState || "unavailable");
  }
}

function boundedInteger(value?: any, fallback?: any, minimum?: any, maximum?: any, field?: any) : any {
  if (value === undefined) return fallback;
  const parsed: any = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function normalizeLimits(options: Record<string, any> = {}) : any {
  const maxAdapters: any = boundedInteger(
    options.maxAdapters,
    DEFAULT_LIMITS.maxAdapters,
    1,
    256,
    "maxAdapters"
  );
  const maxConcurrent: any = boundedInteger(
    options.maxConcurrent,
    DEFAULT_LIMITS.maxConcurrent,
    1,
    64,
    "maxConcurrent"
  );
  const maxQueued: any = boundedInteger(
    options.maxQueued,
    DEFAULT_LIMITS.maxQueued,
    1,
    10_000,
    "maxQueued"
  );
  const connectTimeoutMs: any = boundedInteger(
    options.connectTimeoutMs,
    DEFAULT_LIMITS.connectTimeoutMs,
    10,
    300_000,
    "connectTimeoutMs"
  );
  const taskTimeoutMs: any = boundedInteger(
    options.taskTimeoutMs,
    DEFAULT_LIMITS.taskTimeoutMs,
    10,
    900_000,
    "taskTimeoutMs"
  );
  const closeTimeoutMs: any = boundedInteger(
    options.closeTimeoutMs,
    DEFAULT_LIMITS.closeTimeoutMs,
    10,
    120_000,
    "closeTimeoutMs"
  );
  const shutdownTimeoutMs: any = boundedInteger(
    options.shutdownTimeoutMs,
    DEFAULT_LIMITS.shutdownTimeoutMs,
    closeTimeoutMs,
    300_000,
    "shutdownTimeoutMs"
  );
  const maxConnectAttempts: any = boundedInteger(
    options.maxConnectAttempts,
    DEFAULT_LIMITS.maxConnectAttempts,
    1,
    10,
    "maxConnectAttempts"
  );
  const retryBaseDelayMs: any = boundedInteger(
    options.retryBaseDelayMs,
    DEFAULT_LIMITS.retryBaseDelayMs,
    10,
    60_000,
    "retryBaseDelayMs"
  );
  const retryMaxDelayMs: any = boundedInteger(
    options.retryMaxDelayMs,
    DEFAULT_LIMITS.retryMaxDelayMs,
    retryBaseDelayMs,
    300_000,
    "retryMaxDelayMs"
  );
  return Object.freeze({
    maxAdapters,
    maxConcurrent,
    maxQueued,
    connectTimeoutMs,
    taskTimeoutMs,
    closeTimeoutMs,
    shutdownTimeoutMs,
    maxConnectAttempts,
    retryBaseDelayMs,
    retryMaxDelayMs
  });
}

function safeLog(logger?: any, level?: any, event?: any, details?: any) : any {
  try {
    logger?.[level]?.(event, details);
  } catch {
    // Optional observability must not acquire authority over Core lifecycle.
  }
}

function invalidAdapterRecord(index?: any, code?: any) : any {
  return {
    id: `invalid-adapter-${index + 1}`,
    enabled: false,
    configured: false,
    valid: false,
    state: "invalid",
    code,
    descriptor: null,
    connection: null,
    connectAttempts: 0,
    completedTasks: 0,
    failedTasks: 0,
    queuedTasks: 0,
    runningTasks: 0,
    fenced: false,
    retryTimer: null,
    connectScheduled: false
  };
}

function normalizeAdapter(descriptor?: any, index?: any, knownIds?: any) : any {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    return invalidAdapterRecord(index, "integration_adapter_descriptor_invalid");
  }
  const id: any = String(descriptor.id || "").trim();
  if (!ADAPTER_ID_PATTERN.test(id) || knownIds.has(id)) {
    return invalidAdapterRecord(
      index,
      knownIds.has(id)
        ? "integration_adapter_id_duplicate"
        : "integration_adapter_id_invalid"
    );
  }
  knownIds.add(id);
  const enabled: any = descriptor.enabled === true;
  const configured: any = descriptor.configured === true;
  if (!enabled) {
    return {
      ...invalidAdapterRecord(index, "integration_disabled"),
      id,
      enabled,
      configured,
      valid: true,
      state: "disabled",
      descriptor
    };
  }
  if (!configured) {
    return {
      ...invalidAdapterRecord(index, "integration_unconfigured"),
      id,
      enabled,
      configured,
      valid: true,
      state: "unconfigured",
      descriptor
    };
  }
  if (
    typeof descriptor.execute !== "function" ||
    (descriptor.connect !== undefined && typeof descriptor.connect !== "function") ||
    (descriptor.close !== undefined && typeof descriptor.close !== "function")
  ) {
    return {
      ...invalidAdapterRecord(index, "integration_adapter_contract_invalid"),
      id,
      enabled,
      configured,
      state: "invalid"
    };
  }
  return {
    id,
    enabled,
    configured,
    valid: true,
    state: "idle",
    code: "integration_idle",
    descriptor,
    connection: null,
    connectAttempts: 0,
    completedTasks: 0,
    failedTasks: 0,
    queuedTasks: 0,
    runningTasks: 0,
    fenced: false,
    retryTimer: null,
    connectScheduled: false
  };
}

function publicAdapterState(record?: any) : any {
  return Object.freeze({
    id: record.id,
    enabled: record.enabled,
    configured: record.configured,
    valid: record.valid,
    state: record.state,
    code: record.code,
    fenced: record.fenced,
    connectAttempts: record.connectAttempts,
    queuedTasks: record.queuedTasks,
    runningTasks: record.runningTasks,
    completedTasks: record.completedTasks,
    failedTasks: record.failedTasks
  });
}

function retryDelayMs(attempt?: any, limits?: any) : any {
  const exponent: any = Math.max(0, Math.min(20, Number(attempt || 1) - 1));
  return Math.min(
    limits.retryMaxDelayMs,
    limits.retryBaseDelayMs * (2 ** exponent)
  );
}

function createAbortOutcome(controller?: any, flags?: any) : any {
  if (flags.timedOut) return { kind: "timeout" };
  if (flags.shuttingDown) return { kind: "shutdown" };
  if (controller.signal.aborted) return { kind: "cancelled" };
  return { kind: "failed" };
}

async function runBoundedInvocation({
  invoke,
  timeoutMs,
  supervisorSignal,
  externalSignal = null
}: Record<string, any>) : Promise<any> {
  const controller: any = new AbortController();
  const flags: Record<string, any> = {
    timedOut: false,
    shuttingDown: false
  };
  const listeners: any[] = [];
  const forwardAbort: any = (signal?: any, kind?: any) : any => {
    const abort: any = () : any => {
      if (kind === "shutdown") flags.shuttingDown = true;
      if (!controller.signal.aborted) controller.abort();
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    listeners.push(() : any => signal.removeEventListener("abort", abort));
  };
  forwardAbort(supervisorSignal, "shutdown");
  if (externalSignal) forwardAbort(externalSignal, "external");

  let settleAbort: any;
  const aborted: any = new Promise((resolve?: any) : any => {
    settleAbort = () : any => resolve(createAbortOutcome(controller, flags));
    if (controller.signal.aborted) {
      settleAbort();
      return;
    }
    controller.signal.addEventListener("abort", settleAbort, { once: true });
    listeners.push(() : any => controller.signal.removeEventListener("abort", settleAbort));
  });
  const timeout: any = setTimeout(() : any => {
    flags.timedOut = true;
    if (!controller.signal.aborted) controller.abort();
  }, timeoutMs);

  const invocation: any = Promise.resolve()
    .then(() : any => invoke(controller.signal))
    .then(
      (value?: any) : any => ({ kind: "succeeded", value }),
      () : any => (controller.signal.aborted
        ? createAbortOutcome(controller, flags)
        : { kind: "failed" })
    );
  try {
    return await Promise.race([invocation, aborted]);
  } finally {
    clearTimeout(timeout);
    for (const removeListener of listeners) removeListener();
  }
}

function taskError(code?: any, record?: any, retryable: any = false) : any {
  return new IntegrationTaskSupervisorError(code, {
    retryable,
    adapterState: record?.state || "unavailable"
  });
}

export function createIntegrationTaskSupervisor(options: Record<string, any> = {}) : any {
  const limits: any = normalizeLimits(options);
  const logger: any = options.logger || null;
  const declaredAdapters: any = Array.isArray(options.adapters)
    ? options.adapters.slice(0, limits.maxAdapters)
    : [];
  const declaredAdapterCount: any = Array.isArray(options.adapters)
    ? options.adapters.length
    : 0;
  const knownIds: any = new Set<any>();
  const records: any = declaredAdapters
    .slice(0, limits.maxAdapters)
    .map((descriptor?: any, index?: any) : any => normalizeAdapter(descriptor, index, knownIds));
  const recordById: any = new Map<any, any>(records.map((record?: any) : any => [record.id, record]));
  const rejectedAdapterCount: any = Math.max(0, declaredAdapterCount - records.length);
  const supervisorAbort: any = new AbortController();
  const queue: any[] = [];
  const activeJobs: any = new Set<any>();
  let lifecycleState: any = "waiting_core";
  let coreReady: any = false;
  let acceptingTasks: any = false;
  let activeJobCount: any = 0;
  let shutdownPromise: any = null;

  function snapshot() : any {
    const adapters: any = records.map(publicAdapterState);
    const stateCounts: Record<string, any> = {};
    for (const adapter of adapters) {
      stateCounts[adapter.state] = (stateCounts[adapter.state] || 0) + 1;
    }
    return Object.freeze({
      protocolVersion: INTEGRATION_TASK_SUPERVISOR_PROTOCOL_VERSION,
      lifecycleState,
      coreReady,
      acceptingTasks,
      limits,
      summary: Object.freeze({
        declaredAdapterCount,
        admittedAdapterCount: records.length,
        rejectedAdapterCount,
        activeJobCount,
        queuedJobCount: queue.length,
        stateCounts: Object.freeze({ ...stateCounts })
      }),
      adapters: Object.freeze(adapters)
    });
  }

  function rejectQueuedJob(job?: any, code: any = "integration_task_cancelled") : any {
    if (job.type === "task") {
      job.record.queuedTasks = Math.max(0, job.record.queuedTasks - 1);
      job.reject(taskError(code, job.record, false));
    }
  }

  function removeQueuedJob(job?: any) : any {
    const index: any = queue.indexOf(job);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  }

  function enqueue(job?: any, { internal = false }: Record<string, any> = {}) : any {
    if (lifecycleState !== "running" || supervisorAbort.signal.aborted) {
      if (job.type === "task") {
        job.reject(taskError("integration_supervisor_not_running", job.record, false));
      }
      return false;
    }
    const queuedExternalTaskCount: any = queue.reduce(
      (count?: any, queued?: any) : any => count + (queued.type === "task" ? 1 : 0),
      0
    );
    if (!internal && queuedExternalTaskCount >= limits.maxQueued) {
      job.reject(taskError("integration_task_queue_full", job.record, true));
      return false;
    }
    if (job.type === "task") {
      job.record.queuedTasks += 1;
      if (job.externalSignal) {
        const onAbort: any = () : any => {
          if (!removeQueuedJob(job)) return;
          job.record.queuedTasks = Math.max(0, job.record.queuedTasks - 1);
          job.reject(taskError("integration_task_cancelled", job.record, false));
        };
        if (job.externalSignal.aborted) {
          job.record.queuedTasks = Math.max(0, job.record.queuedTasks - 1);
          job.reject(taskError("integration_task_cancelled", job.record, false));
          return false;
        }
        job.externalSignal.addEventListener("abort", onAbort, { once: true });
        job.removeQueuedAbortListener = () : any =>
          job.externalSignal.removeEventListener("abort", onAbort);
      }
    }
    queue.push(job);
    drain();
    return true;
  }

  function scheduleRetry(record?: any) : any {
    if (
      lifecycleState !== "running" ||
      record.fenced ||
      record.connectAttempts >= limits.maxConnectAttempts
    ) {
      record.state = "degraded";
      record.code = record.fenced
        ? "integration_adapter_fenced"
        : "integration_connect_attempts_exhausted";
      return;
    }
    record.state = "retry_wait";
    record.code = "integration_connect_retry_wait";
    const timer: any = setTimeout(() : any => {
      record.retryTimer = null;
      scheduleConnect(record);
    }, retryDelayMs(record.connectAttempts, limits));
    timer.unref?.();
    record.retryTimer = timer;
  }

  async function runConnect(record?: any) : Promise<any> {
    record.connectScheduled = false;
    if (
      lifecycleState !== "running" ||
      record.fenced ||
      !record.valid ||
      !record.enabled ||
      !record.configured
    ) {
      return;
    }
    record.state = "connecting";
    record.code = "integration_connecting";
    record.connectAttempts += 1;
    const outcome: any = await runBoundedInvocation({
      timeoutMs: limits.connectTimeoutMs,
      supervisorSignal: supervisorAbort.signal,
      invoke: (signal?: any) : any => record.descriptor.connect
        ? record.descriptor.connect({ adapterId: record.id, signal })
        : null
    });
    if (outcome.kind === "succeeded" && lifecycleState === "running") {
      record.connection = outcome.value ?? null;
      record.state = "ready";
      record.code = "integration_ready";
      safeLog(logger, "info", "integration.adapter.ready", {
        adapterId: record.id,
        connectAttempts: record.connectAttempts
      });
      return;
    }
    if (outcome.kind === "timeout" || outcome.kind === "cancelled") {
      record.fenced = true;
      record.state = "degraded";
      record.code = outcome.kind === "timeout"
        ? "integration_connect_timeout"
        : "integration_connect_cancelled";
      safeLog(logger, "warn", "integration.adapter.fenced", {
        adapterId: record.id,
        code: record.code
      });
      return;
    }
    if (outcome.kind === "shutdown") {
      record.state = "stopping";
      record.code = "integration_stopping";
      return;
    }
    record.state = "degraded";
    record.code = "integration_connect_failed";
    safeLog(logger, "warn", "integration.adapter.degraded", {
      adapterId: record.id,
      code: record.code,
      connectAttempts: record.connectAttempts
    });
    scheduleRetry(record);
  }

  async function runTask(job?: any) : Promise<any> {
    const { record } = job;
    job.removeQueuedAbortListener?.();
    record.queuedTasks = Math.max(0, record.queuedTasks - 1);
    if (record.state !== "ready" || record.fenced || lifecycleState !== "running") {
      throw taskError("integration_adapter_unavailable", record, false);
    }
    record.runningTasks += 1;
    const outcome: any = await runBoundedInvocation({
      timeoutMs: job.timeoutMs,
      supervisorSignal: supervisorAbort.signal,
      externalSignal: job.externalSignal,
      invoke: (signal?: any) : any => record.descriptor.execute({
        adapterId: record.id,
        connection: record.connection,
        input: job.input,
        signal
      })
    });
    record.runningTasks = Math.max(0, record.runningTasks - 1);
    if (outcome.kind === "succeeded") {
      record.completedTasks += 1;
      return outcome.value;
    }
    record.failedTasks += 1;
    if (outcome.kind === "timeout" || outcome.kind === "cancelled") {
      record.fenced = true;
      record.state = "degraded";
      record.code = outcome.kind === "timeout"
        ? "integration_task_timeout"
        : "integration_task_cancelled";
      throw taskError(record.code, record, false);
    }
    if (outcome.kind === "shutdown") {
      throw taskError("integration_task_cancelled", record, false);
    }
    throw taskError("integration_task_failed", record, true);
  }

  function drain() : any {
    if (lifecycleState !== "running") return;
    while (activeJobCount < limits.maxConcurrent && queue.length > 0) {
      const job: any = queue.shift();
      activeJobCount += 1;
      const active: any = Promise.resolve()
        .then(() : any => (job.type === "connect" ? runConnect(job.record) : runTask(job)))
        .then(job.resolve, job.reject)
        .finally(() : any => {
          activeJobCount = Math.max(0, activeJobCount - 1);
          activeJobs.delete(active);
          drain();
        });
      activeJobs.add(active);
    }
  }

  function scheduleConnect(record?: any) : any {
    if (
      record.connectScheduled ||
      record.retryTimer ||
      lifecycleState !== "running" ||
      record.fenced ||
      !record.valid ||
      !record.enabled ||
      !record.configured
    ) {
      return false;
    }
    record.connectScheduled = true;
    return enqueue({
      type: "connect",
      record,
      resolve() : any {},
      reject() : any {}
    }, { internal: true });
  }

  function start({ coreReady: declaredCoreReady = false }: Record<string, any> = {}) : any {
    if (lifecycleState === "stopping" || lifecycleState === "stopped") {
      return snapshot();
    }
    if (declaredCoreReady !== true) {
      coreReady = false;
      lifecycleState = "waiting_core";
      acceptingTasks = false;
      return snapshot();
    }
    if (lifecycleState === "running") return snapshot();
    coreReady = true;
    lifecycleState = "running";
    acceptingTasks = true;
    for (const record of records) scheduleConnect(record);
    return snapshot();
  }

  function execute(adapterId?: any, input?: any, { signal = null, timeoutMs }: Record<string, any> = {}) : any {
    const record: any = recordById.get(String(adapterId || ""));
    if (!record) {
      return Promise.reject(
        new IntegrationTaskSupervisorError("integration_adapter_unknown", {
          retryable: false,
          adapterState: "missing"
        })
      );
    }
    if (!acceptingTasks || lifecycleState !== "running") {
      return Promise.reject(taskError("integration_supervisor_not_running", record, false));
    }
    if (signal !== null && !(signal instanceof AbortSignal)) {
      return Promise.reject(taskError("integration_task_signal_invalid", record, false));
    }
    if (signal?.aborted) {
      return Promise.reject(taskError("integration_task_cancelled", record, false));
    }
    if (record.state !== "ready" || record.fenced) {
      return Promise.reject(
        taskError(
          "integration_adapter_unavailable",
          record,
          RETRYABLE_STATES.has(record.state) && !record.fenced
        )
      );
    }
    const effectiveTimeoutMs: any = timeoutMs === undefined
      ? limits.taskTimeoutMs
      : Math.min(
          limits.taskTimeoutMs,
          boundedInteger(timeoutMs, limits.taskTimeoutMs, 10, limits.taskTimeoutMs, "timeoutMs")
        );
    return new Promise((resolve?: any, reject?: any) : any => {
      enqueue({
        type: "task",
        record,
        input,
        externalSignal: signal,
        timeoutMs: effectiveTimeoutMs,
        resolve,
        reject,
        removeQueuedAbortListener: null
      });
    });
  }

  function recover(adapterId?: any) : any {
    const record: any = recordById.get(String(adapterId || ""));
    if (
      !record ||
      record.fenced ||
      !record.valid ||
      !record.enabled ||
      !record.configured ||
      lifecycleState !== "running"
    ) {
      return false;
    }
    if (record.retryTimer) {
      clearTimeout(record.retryTimer);
      record.retryTimer = null;
    }
    record.connection = null;
    record.connectAttempts = 0;
    record.state = "idle";
    record.code = "integration_idle";
    return scheduleConnect(record);
  }

  async function closeRecord(record?: any, timeoutMs?: any) : Promise<any> {
    const close: any = record.descriptor?.close ||
      (typeof record.connection?.close === "function"
        ? ({ signal }: Record<string, any>) : any => record.connection.close({ signal })
        : null);
    if (!close || record.connectAttempts === 0) return "not_required";
    const closeController: any = new AbortController();
    const timeout: any = setTimeout(() : any => closeController.abort(), timeoutMs);
    const invocation: any = Promise.resolve()
      .then(() : any => close({
        adapterId: record.id,
        connection: record.connection,
        signal: closeController.signal
      }))
      .then(() : any => "closed", () : any => "failed");
    const aborted: any = new Promise((resolve?: any) : any => {
      closeController.signal.addEventListener("abort", () : any => resolve("timeout"), {
        once: true
      });
    });
    try {
      return await Promise.race([invocation, aborted]);
    } finally {
      clearTimeout(timeout);
    }
  }

  function shutdown() : any {
    if (shutdownPromise) return shutdownPromise;
    if (lifecycleState === "stopped") return Promise.resolve(snapshot());
    shutdownPromise = (async () : Promise<any> => {
      acceptingTasks = false;
      lifecycleState = "stopping";
      for (const record of records) {
        if (record.retryTimer) clearTimeout(record.retryTimer);
        record.retryTimer = null;
        if (!["disabled", "unconfigured", "invalid"].includes(record.state)) {
          record.state = "stopping";
          record.code = "integration_stopping";
        }
      }
      while (queue.length > 0) {
        const job: any = queue.shift();
        job.removeQueuedAbortListener?.();
        rejectQueuedJob(job);
      }
      if (!supervisorAbort.signal.aborted) supervisorAbort.abort();

      let activeDeadlineTimer: any;
      const activeDeadline: any = new Promise((resolve?: any) : any => {
        activeDeadlineTimer = setTimeout(resolve, limits.shutdownTimeoutMs);
      });
      try {
        await Promise.race([
          Promise.allSettled([...activeJobs]),
          activeDeadline
        ]);
      } finally {
        clearTimeout(activeDeadlineTimer);
      }

      const closeStartedAt: any = Date.now();
      const closeResults: any = await Promise.all(records.map(async (record?: any) : Promise<any> => {
        const remaining: any = Math.max(
          10,
          limits.shutdownTimeoutMs - (Date.now() - closeStartedAt)
        );
        return closeRecord(record, Math.min(limits.closeTimeoutMs, remaining));
      }));
      closeResults.forEach((result?: any, index?: any) : any => {
        const record: any = records[index];
        record.connection = null;
        record.queuedTasks = 0;
        record.runningTasks = 0;
        if (!["disabled", "unconfigured", "invalid"].includes(record.state)) {
          record.state = "stopped";
          record.code = result === "failed"
            ? "integration_close_failed"
            : result === "timeout"
              ? "integration_close_timeout"
              : "integration_stopped";
        }
      });
      activeJobCount = 0;
      coreReady = false;
      lifecycleState = "stopped";
      return snapshot();
    })();
    return shutdownPromise;
  }

  return Object.freeze({
    protocolVersion: INTEGRATION_TASK_SUPERVISOR_PROTOCOL_VERSION,
    start,
    execute,
    recover,
    snapshot,
    close: shutdown,
    shutdown
  });
}
