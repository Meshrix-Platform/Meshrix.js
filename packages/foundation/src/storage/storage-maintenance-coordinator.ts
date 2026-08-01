import path from "node:path";

const DEFAULT_EXECUTION_BUDGET: Readonly<Record<string, any>> = Object.freeze({
  maxFiles: 100_000,
  maxBytes: 1_099_511_627_776,
  maxCleanupItems: 100_000,
  maxQueueDepth: 64,
  maxDurationMs: 3_600_000,
  bufferBytes: 64 * 1024
});

export const STORAGE_EXECUTION_BUDGET_HARD_LIMITS: Readonly<Record<string, any>> = Object.freeze({
  maxFiles: 1_000_000,
  maxBytes: 4 * 1024 * 1024 * 1024 * 1024,
  maxCleanupItems: 1_000_000,
  maxQueueDepth: 1024,
  maxDurationMs: 24 * 60 * 60 * 1000,
  bufferBytes: 16 * 1024 * 1024,
  maxConcurrentMutationsPerRoot: 1,
  queueAllocationBytes: 64 * 1024,
  queuedBufferProductBytes: 1024 * 1024 * 1024
});

const ARRAY_SLOT_BYTES: any = 8;
const lanes: any = new Map<any, any>();

function maintenanceError(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.name = "StorageMaintenanceError";
  error.code = code;
  error.reasonCode = code;
  return error;
}

function boundedPositiveInteger(value?: any, fallback?: any, maximum?: any, field?: any) : any {
  if (value === undefined || value === null || value === "") return fallback;
  const number: any = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw maintenanceError("storage_execution_budget_invalid", `${field} must be a positive safe integer.`);
  }
  if (number > maximum) {
    throw maintenanceError(
      "storage_execution_budget_limit_exceeded",
      `${field} exceeds the storage runtime hard limit.`
    );
  }
  return number;
}

export function normalizeStorageExecutionBudget(value: Record<string, any> = {}) : any {
  const source: any = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized: Record<string, any> = {
    maxFiles: boundedPositiveInteger(
      source.maxFiles,
      DEFAULT_EXECUTION_BUDGET.maxFiles,
      STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxFiles,
      "maxFiles"
    ),
    maxBytes: boundedPositiveInteger(
      source.maxBytes,
      DEFAULT_EXECUTION_BUDGET.maxBytes,
      STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxBytes,
      "maxBytes"
    ),
    maxCleanupItems: boundedPositiveInteger(
      source.maxCleanupItems,
      DEFAULT_EXECUTION_BUDGET.maxCleanupItems,
      STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxCleanupItems,
      "maxCleanupItems"
    ),
    maxQueueDepth: boundedPositiveInteger(
      source.maxQueueDepth,
      DEFAULT_EXECUTION_BUDGET.maxQueueDepth,
      STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxQueueDepth,
      "maxQueueDepth"
    ),
    maxDurationMs: boundedPositiveInteger(
      source.maxDurationMs,
      DEFAULT_EXECUTION_BUDGET.maxDurationMs,
      STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxDurationMs,
      "maxDurationMs"
    ),
    bufferBytes: boundedPositiveInteger(
      source.bufferBytes,
      DEFAULT_EXECUTION_BUDGET.bufferBytes,
      STORAGE_EXECUTION_BUDGET_HARD_LIMITS.bufferBytes,
      "bufferBytes"
    )
  };
  const queueAllocationBytes: any = normalized.maxQueueDepth * ARRAY_SLOT_BYTES;
  const queuedBufferProductBytes: any = normalized.maxQueueDepth * normalized.bufferBytes;
  if (
    !Number.isSafeInteger(queueAllocationBytes) ||
    queueAllocationBytes > STORAGE_EXECUTION_BUDGET_HARD_LIMITS.queueAllocationBytes ||
    !Number.isSafeInteger(queuedBufferProductBytes) ||
    queuedBufferProductBytes > STORAGE_EXECUTION_BUDGET_HARD_LIMITS.queuedBufferProductBytes
  ) {
    throw maintenanceError(
      "storage_execution_budget_product_exceeded",
      "Storage queue and buffer capacity product exceeds the runtime allocation limit."
    );
  }
  return Object.freeze(normalized);
}

class FixedRingDeque {
  capacity: any;
  head: any;
  length: any;
  values: any;
  constructor(capacity?: any) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      capacity > STORAGE_EXECUTION_BUDGET_HARD_LIMITS.maxQueueDepth ||
      capacity * ARRAY_SLOT_BYTES > STORAGE_EXECUTION_BUDGET_HARD_LIMITS.queueAllocationBytes
    ) {
      throw maintenanceError(
        "storage_operation_queue_capacity_invalid",
        "Storage maintenance queue capacity exceeds its allocation boundary."
      );
    }
    this.capacity = capacity;
    this.values = new Array(capacity);
    this.head = 0;
    this.length = 0;
  }

  push(value?: any) : any {
    if (this.length >= this.capacity) return false;
    this.values[(this.head + this.length) % this.capacity] = value;
    this.length += 1;
    return true;
  }

  shift() : any {
    if (this.length === 0) return null;
    const value: any = this.values[this.head];
    this.values[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.length -= 1;
    return value;
  }
}

export function createStorageWorkTracker({ signal = null, budget = {}, startedAt = Date.now() }: Record<string, any> = {}) : any {
  const limits: any = normalizeStorageExecutionBudget(budget);
  const counters: Record<string, any> = { files: 0, bytes: 0, cleanupItems: 0 };
  const deadlineAt: any = startedAt + limits.maxDurationMs;

  function assertActive() : any {
    if (signal?.aborted) {
      throw signal.reason || maintenanceError("storage_operation_cancelled", "Storage operation was cancelled.");
    }
    if (Date.now() > deadlineAt) {
      throw maintenanceError("storage_operation_timeout", "Storage operation exceeded its execution deadline.");
    }
  }

  function checkedNextCounters({ files = 0, bytes = 0, cleanupItems = 0 }: Record<string, any> = {}) : any {
    assertActive();
    const next: Record<string, any> = { ...counters };
    for (const [field, amount] of (Object.entries({ files, bytes, cleanupItems }) as [string, any][])) {
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw maintenanceError("storage_execution_budget_invalid", `${field} consumption must be a non-negative safe integer.`);
      }
      next[field] += amount;
    }
    if (
      next.files > limits.maxFiles ||
      next.bytes > limits.maxBytes ||
      next.cleanupItems > limits.maxCleanupItems
    ) {
      throw maintenanceError("storage_execution_budget_exceeded", "Storage operation exceeded its execution budget.");
    }
    return next;
  }

  function consume(amounts: Record<string, any> = {}) : any {
    Object.assign(counters, checkedNextCounters(amounts));
    return Object.freeze({ ...counters });
  }

  return Object.freeze({
    signal,
    budget: limits,
    deadlineAt,
    assertActive,
    assertFits(amounts: Record<string, any> = {}) : any {
      return Object.freeze(checkedNextCounters(amounts));
    },
    consume,
    snapshot() : any {
      return Object.freeze({ ...counters });
    }
  });
}

function normalizedRoot(value?: any) : any {
  return path.resolve(String(value || "."));
}

function rejectCaller(entry?: any, error?: any) : any {
  if (entry.callerSettled) return;
  entry.callerSettled = true;
  entry.reject(error);
}

function settleCaller(entry?: any, method?: any, value?: any) : any {
  if (entry.callerSettled) return;
  entry.callerSettled = true;
  entry[method](value);
}

function beginNext(lane?: any) : any {
  if (lane.active) return;
  let entry: any = lane.queue.shift();
  while (entry?.cancelled) {
    entry.removeAbortListener?.();
    entry = lane.queue.shift();
  }
  if (!entry) {
    lanes.delete(lane.root);
    return;
  }
  lane.active = entry;
  const remainingMs: any = entry.enqueuedAt + entry.budget.maxDurationMs - Date.now();
  if (remainingMs <= 0) {
    rejectCaller(entry, maintenanceError("storage_operation_timeout", "Storage operation expired before admission."));
    lane.active = null;
    beginNext(lane);
    return;
  }

  const timeout: any = setTimeout(() : any => {
    const error: any = maintenanceError("storage_operation_timeout", "Storage operation exceeded its execution deadline.");
    lane.fenced = true;
    entry.controller.abort(error);
    rejectCaller(entry, error);
  }, remainingMs);
  timeout.unref?.();

  const tracker: any = createStorageWorkTracker({
    signal: entry.controller.signal,
    budget: entry.budget,
    startedAt: entry.enqueuedAt
  });
  Promise.resolve()
    .then(() : any => entry.task(tracker))
    .then(
      (result?: any) : any => settleCaller(entry, "resolve", result),
      (error?: any) : any => settleCaller(entry, "reject", error)
    )
    .finally(() : any => {
      clearTimeout(timeout);
      entry.removeAbortListener?.();
      lane.active = null;
      lane.fenced = false;
      beginNext(lane);
    });
}

export function runStorageMaintenanceMutation(
  storageRoot?: any,
  task?: any,
  { signal = null, budget = {}, kind = "storage.maintenance" }: Record<string, any> = {}
) : any {
  if (typeof task !== "function") {
    throw new TypeError("runStorageMaintenanceMutation requires a task function.");
  }
  const root: any = normalizedRoot(storageRoot);
  const normalizedBudget: any = normalizeStorageExecutionBudget(budget);
  let lane: any = lanes.get(root);
  if (!lane) {
    lane = {
      root,
      active: null,
      fenced: false,
      queue: new FixedRingDeque(normalizedBudget.maxQueueDepth)
    };
    lanes.set(root, lane);
  }
  if (lane.fenced) {
    return Promise.reject(maintenanceError(
      "storage_operation_fenced",
      "Storage maintenance is fenced by an indeterminate earlier mutation."
    ));
  }
  if (lane.queue.length >= Math.min(lane.queue.capacity, normalizedBudget.maxQueueDepth)) {
    return Promise.reject(maintenanceError("storage_operation_queue_full", "Storage maintenance queue is full."));
  }
  if (signal?.aborted) {
    return Promise.reject(signal.reason || maintenanceError("storage_operation_cancelled", "Storage operation was cancelled."));
  }

  return new Promise((resolve?: any, reject?: any) : any => {
    const controller: any = new AbortController();
    const entry: Record<string, any> = {
      kind,
      task,
      budget: normalizedBudget,
      controller,
      enqueuedAt: Date.now(),
      resolve,
      reject,
      callerSettled: false,
      cancelled: false,
      removeAbortListener: null
    };
    if (signal) {
      const onAbort: any = () : any => {
        const error: any = signal.reason || maintenanceError("storage_operation_cancelled", "Storage operation was cancelled.");
        entry.cancelled = lane.active !== entry;
        if (lane.active === entry) lane.fenced = true;
        controller.abort(error);
        rejectCaller(entry, error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.removeAbortListener = () : any => signal.removeEventListener("abort", onAbort);
    }
    if (!lane.queue.push(entry)) {
      entry.removeAbortListener?.();
      reject(maintenanceError("storage_operation_queue_full", "Storage maintenance queue is full."));
      return;
    }
    beginNext(lane);
  });
}

export function storageMaintenanceLaneStatus(storageRoot?: any) : any {
  const lane: any = lanes.get(normalizedRoot(storageRoot));
  return Object.freeze({
    active: Boolean(lane?.active),
    fenced: lane?.fenced === true,
    queued: lane?.queue.length || 0
  });
}
