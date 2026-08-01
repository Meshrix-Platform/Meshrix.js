export const OBSERVABILITY_BUDGETS: Readonly<Record<string, any>> = Object.freeze({
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
  code: any;
  name: any;
  reasonCode: any;
  constructor(reasonCode?: any, message: any = reasonCode) {
    super(message);
    this.name = "ObservabilityBudgetError";
    this.code = reasonCode;
    this.reasonCode = reasonCode;
  }
}

export function throwIfObservabilityAborted(signal?: any) : any {
  if (signal?.aborted) {
    const error: Error & Record<string, any> = new Error("Observability work was cancelled.");
    error.name = "AbortError";
    error.code = "observability_cancelled";
    error.reasonCode = "observability_cancelled";
    throw error;
  }
}

export function startObservabilityBudgetObservation({
  now = () : any => Date.now(),
  cpuUsage = () : any => process.cpuUsage(),
  rss = () : any => process.memoryUsage().rss
}: Record<string, any> = {}) : any {
  const startedAtMs: any = now();
  const startedCpu: any = cpuUsage();
  const startedRss: any = rss();

  return {
    finish({ signal, budgets = OBSERVABILITY_BUDGETS }: Record<string, any> = {}) : any {
      throwIfObservabilityAborted(signal);
      const elapsedMs: any = Math.max(0, now() - startedAtMs);
      const cpu: any = cpuUsage(startedCpu);
      const cpuMs: any = Math.max(0, (Number(cpu?.user || 0) + Number(cpu?.system || 0)) / 1_000);
      const rssDeltaBytes: any = Math.max(0, rss() - startedRss);
      const observation: Readonly<Record<string, any>> = Object.freeze({ elapsedMs, cpuMs, rssDeltaBytes });
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

export function assertBoundedCollection(value?: any, limit?: any, reasonCode?: any) : any {
  const size: any = value instanceof Map || value instanceof Set
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
}: Record<string, any> = {}) : any {
  let active: any = 0;
  let pending: any[] = [];

  function drain() : any {
    while (active < maxConcurrent && pending.length > 0) {
      const entry: any = pending.shift();
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
        .finally(() : any => {
          active -= 1;
          drain();
        });
    }
  }

  function run(work?: any, { signal }: Record<string, any> = {}) : any {
    if (typeof work !== "function") {
      throw new TypeError("Observability queued work must be a function.");
    }
    throwIfObservabilityAborted(signal);
    if (pending.length >= maxPending) {
      throw new ObservabilityBudgetError("observability_work_queue_budget_exceeded");
    }
    return new Promise((resolve?: any, reject?: any) : any => {
      pending.push({ work, signal, resolve, reject });
      drain();
    });
  }

  function snapshot() : any {
    return Object.freeze({ active, pending: pending.length, maxConcurrent, maxPending });
  }

  return Object.freeze({ run, snapshot });
}

export function createBoundedSnapshotCache({
  maxEntries = OBSERVABILITY_BUDGETS.maxReports,
  overflow = "evict"
}: Record<string, any> = {}) : any {
  let entries: any = new Map<any, any>();
  let evictions: any = 0;

  function get(key?: any) : any {
    if (!entries.has(key)) return undefined;
    const value: any = entries.get(key);
    entries.delete(key);
    entries.set(key, value);
    return value;
  }

  function set(key?: any, value?: any) : any {
    const replacing: any = entries.has(key);
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

  function clear() : any {
    entries.clear();
  }

  function snapshot() : any {
    return Object.freeze({ size: entries.size, maxEntries, evictions });
  }

  return Object.freeze({ clear, get, set, snapshot });
}
