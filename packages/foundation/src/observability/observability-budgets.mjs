export const OBSERVABILITY_BUDGETS = Object.freeze({
  maxActiveAlerts: 1_000,
  maxAlertHistory: 200,
  maxAlertTransitionHistory: 32,
  maxMetricSeries: 512,
  maxMetricBuckets: 32,
  maxMetricVocabularyValues: 128,
  maxWorkQueueDepth: 256,
  maxReports: 50,
  maxReportBytes: 2 * 1024 * 1024,
  maxConcurrentReportBuilds: 2,
  maxPublicationPartitions: 1_024,
  maxPublicationRevisions: 128,
  maxCycleDurationMs: 5_000,
  maxCycleCpuMs: 1_000,
  maxCycleRssDeltaBytes: 64 * 1024 * 1024,
  maxScanDepth: 8,
  maxScanItems: 5_000
});

export class ObservabilityBudgetError extends Error {
  constructor(reasonCode, message = reasonCode) {
    super(message);
    this.name = "ObservabilityBudgetError";
    this.code = reasonCode;
    this.reasonCode = reasonCode;
  }
}

export function throwIfObservabilityAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("Observability work was cancelled.");
    error.name = "AbortError";
    error.code = "observability_cancelled";
    error.reasonCode = "observability_cancelled";
    throw error;
  }
}

export function startObservabilityBudgetObservation({
  now = () => Date.now(),
  cpuUsage = () => process.cpuUsage(),
  rss = () => process.memoryUsage().rss
} = {}) {
  const startedAtMs = now();
  const startedCpu = cpuUsage();
  const startedRss = rss();

  return {
    finish({ signal, budgets = OBSERVABILITY_BUDGETS } = {}) {
      throwIfObservabilityAborted(signal);
      const elapsedMs = Math.max(0, now() - startedAtMs);
      const cpu = cpuUsage(startedCpu);
      const cpuMs = Math.max(0, (Number(cpu?.user || 0) + Number(cpu?.system || 0)) / 1_000);
      const rssDeltaBytes = Math.max(0, rss() - startedRss);
      const observation = Object.freeze({ elapsedMs, cpuMs, rssDeltaBytes });
      if (elapsedMs > budgets.maxCycleDurationMs) {
        throw new ObservabilityBudgetError("observability_duration_budget_exceeded");
      }
      if (cpuMs > budgets.maxCycleCpuMs) {
        throw new ObservabilityBudgetError("observability_cpu_budget_exceeded");
      }
      if (rssDeltaBytes > budgets.maxCycleRssDeltaBytes) {
        throw new ObservabilityBudgetError("observability_rss_budget_exceeded");
      }
      return observation;
    }
  };
}

export function assertBoundedCollection(value, limit, reasonCode) {
  const size = value instanceof Map || value instanceof Set
    ? value.size
    : Array.isArray(value)
      ? value.length
      : 0;
  if (size > limit) {
    throw new ObservabilityBudgetError(reasonCode);
  }
  return value;
}

export function createBoundedWorkQueue({
  maxPending = OBSERVABILITY_BUDGETS.maxWorkQueueDepth,
  maxConcurrent = OBSERVABILITY_BUDGETS.maxConcurrentReportBuilds
} = {}) {
  let active = 0;
  let pending = [];

  function drain() {
    while (active < maxConcurrent && pending.length > 0) {
      const entry = pending.shift();
      if (entry.signal?.aborted) {
        entry.reject(Object.assign(new Error("Observability work was cancelled."), {
          name: "AbortError",
          code: "observability_cancelled",
          reasonCode: "observability_cancelled"
        }));
        continue;
      }
      active += 1;
      Promise.resolve()
        .then(entry.work)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  function run(work, { signal } = {}) {
    if (typeof work !== "function") {
      throw new TypeError("Observability queued work must be a function.");
    }
    throwIfObservabilityAborted(signal);
    if (pending.length >= maxPending) {
      throw new ObservabilityBudgetError("observability_work_queue_budget_exceeded");
    }
    return new Promise((resolve, reject) => {
      pending.push({ work, signal, resolve, reject });
      drain();
    });
  }

  function snapshot() {
    return Object.freeze({ active, pending: pending.length, maxConcurrent, maxPending });
  }

  return Object.freeze({ run, snapshot });
}

export function createBoundedSnapshotCache({
  maxEntries = OBSERVABILITY_BUDGETS.maxReports,
  overflow = "evict"
} = {}) {
  let entries = new Map();
  let evictions = 0;

  function get(key) {
    if (!entries.has(key)) return undefined;
    const value = entries.get(key);
    entries.delete(key);
    entries.set(key, value);
    return value;
  }

  function set(key, value) {
    const replacing = entries.has(key);
    if (!replacing && entries.size >= maxEntries) {
      if (overflow === "error") {
        throw new ObservabilityBudgetError("observability_snapshot_cache_budget_exceeded");
      }
      entries.delete(entries.keys().next().value);
      evictions += 1;
    }
    if (replacing) entries.delete(key);
    entries.set(key, value);
    return value;
  }

  function clear() {
    entries.clear();
  }

  function snapshot() {
    return Object.freeze({ size: entries.size, maxEntries, evictions });
  }

  return Object.freeze({ clear, get, set, snapshot });
}
