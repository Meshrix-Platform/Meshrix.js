import path from "node:path";

const DEFAULT_EXECUTION_BUDGET = Object.freeze({
  maxFiles: 100_000,
  maxBytes: 1_099_511_627_776,
  maxCleanupItems: 100_000,
  maxQueueDepth: 64,
  maxDurationMs: 3_600_000,
  bufferBytes: 64 * 1024
});

export const STORAGE_EXECUTION_BUDGET_HARD_LIMITS = Object.freeze({
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

const ARRAY_SLOT_BYTES = 8;
const lanes = new Map();

function maintenanceError(code, message) {
  const error = new Error(message);
  error.name = "StorageMaintenanceError";
  error.code = code;
  error.reasonCode = code;
  return error;
}

function boundedPositiveInteger(value, fallback, maximum, field) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
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

export function normalizeStorageExecutionBudget(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = {
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
  const queueAllocationBytes = normalized.maxQueueDepth * ARRAY_SLOT_BYTES;
  const queuedBufferProductBytes = normalized.maxQueueDepth * normalized.bufferBytes;
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
  constructor(capacity) {
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

  push(value) {
    if (this.length >= this.capacity) return false;
    this.values[(this.head + this.length) % this.capacity] = value;
    this.length += 1;
    return true;
  }

  shift() {
    if (this.length === 0) return null;
    const value = this.values[this.head];
    this.values[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.length -= 1;
    return value;
  }
}

export function createStorageWorkTracker({ signal = null, budget = {}, startedAt = Date.now() } = {}) {
  const limits = normalizeStorageExecutionBudget(budget);
  const counters = { files: 0, bytes: 0, cleanupItems: 0 };
  const deadlineAt = startedAt + limits.maxDurationMs;

  function assertActive() {
    if (signal?.aborted) {
      throw signal.reason || maintenanceError("storage_operation_cancelled", "Storage operation was cancelled.");
    }
    if (Date.now() > deadlineAt) {
      throw maintenanceError("storage_operation_timeout", "Storage operation exceeded its execution deadline.");
    }
  }

  function checkedNextCounters({ files = 0, bytes = 0, cleanupItems = 0 } = {}) {
    assertActive();
    const next = { ...counters };
    for (const [field, amount] of Object.entries({ files, bytes, cleanupItems })) {
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

  function consume(amounts = {}) {
    Object.assign(counters, checkedNextCounters(amounts));
    return Object.freeze({ ...counters });
  }

  return Object.freeze({
    signal,
    budget: limits,
    deadlineAt,
    assertActive,
    assertFits(amounts = {}) {
      return Object.freeze(checkedNextCounters(amounts));
    },
    consume,
    snapshot() {
      return Object.freeze({ ...counters });
    }
  });
}

function normalizedRoot(value) {
  return path.resolve(String(value || "."));
}

function rejectCaller(entry, error) {
  if (entry.callerSettled) return;
  entry.callerSettled = true;
  entry.reject(error);
}

function settleCaller(entry, method, value) {
  if (entry.callerSettled) return;
  entry.callerSettled = true;
  entry[method](value);
}

function beginNext(lane) {
  if (lane.active) return;
  let entry = lane.queue.shift();
  while (entry?.cancelled) {
    entry.removeAbortListener?.();
    entry = lane.queue.shift();
  }
  if (!entry) {
    lanes.delete(lane.root);
    return;
  }
  lane.active = entry;
  const remainingMs = entry.enqueuedAt + entry.budget.maxDurationMs - Date.now();
  if (remainingMs <= 0) {
    rejectCaller(entry, maintenanceError("storage_operation_timeout", "Storage operation expired before admission."));
    lane.active = null;
    beginNext(lane);
    return;
  }

  const timeout = setTimeout(() => {
    const error = maintenanceError("storage_operation_timeout", "Storage operation exceeded its execution deadline.");
    lane.fenced = true;
    entry.controller.abort(error);
    rejectCaller(entry, error);
  }, remainingMs);
  timeout.unref?.();

  const tracker = createStorageWorkTracker({
    signal: entry.controller.signal,
    budget: entry.budget,
    startedAt: entry.enqueuedAt
  });
  Promise.resolve()
    .then(() => entry.task(tracker))
    .then(
      (result) => settleCaller(entry, "resolve", result),
      (error) => settleCaller(entry, "reject", error)
    )
    .finally(() => {
      clearTimeout(timeout);
      entry.removeAbortListener?.();
      lane.active = null;
      lane.fenced = false;
      beginNext(lane);
    });
}

export function runStorageMaintenanceMutation(
  storageRoot,
  task,
  { signal = null, budget = {}, kind = "storage.maintenance" } = {}
) {
  if (typeof task !== "function") {
    throw new TypeError("runStorageMaintenanceMutation requires a task function.");
  }
  const root = normalizedRoot(storageRoot);
  const normalizedBudget = normalizeStorageExecutionBudget(budget);
  let lane = lanes.get(root);
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

  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const entry = {
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
      const onAbort = () => {
        const error = signal.reason || maintenanceError("storage_operation_cancelled", "Storage operation was cancelled.");
        entry.cancelled = lane.active !== entry;
        if (lane.active === entry) lane.fenced = true;
        controller.abort(error);
        rejectCaller(entry, error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
    if (!lane.queue.push(entry)) {
      entry.removeAbortListener?.();
      reject(maintenanceError("storage_operation_queue_full", "Storage maintenance queue is full."));
      return;
    }
    beginNext(lane);
  });
}

export function storageMaintenanceLaneStatus(storageRoot) {
  const lane = lanes.get(normalizedRoot(storageRoot));
  return Object.freeze({
    active: Boolean(lane?.active),
    fenced: lane?.fenced === true,
    queued: lane?.queue.length || 0
  });
}
