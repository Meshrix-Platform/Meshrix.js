export function createStateMutationQueue({
  maxPending = 256,
  maxPendingBytes = 16 * 1024 * 1024,
  partitionCount = () => 0
} = {}) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 ||
      !Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1) {
    throw new TypeError("State mutation queue requires positive pending count and byte bounds.");
  }
  const lanes = new Map();
  let outstanding = 0;
  let outstandingBytes = 0;
  let accepting = true;
  let closePromise = null;

  function queueFullError() {
    const error = new Error("Skill Hub mutation queue capacity is exhausted.");
    error.code = "skill_hub_queue_full";
    return error;
  }

  // Pending work and active registry partitions share one capacity budget so
  // a flood of caller-selected partitions cannot grow the queue (or the
  // partition set) without bound.
  function run(key, task, { bytes = 0 } = {}) {
    if (typeof task !== "function") throw new TypeError("State mutation requires a task function.");
    if (!accepting) {
      const error = new Error("Skill Hub mutation queue is closed.");
      error.code = "skill_hub_runtime_closed";
      throw error;
    }
    const chargeBytes = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
    if (outstanding + partitionCount() >= maxPending || outstandingBytes + chargeBytes > maxPendingBytes) {
      throw queueFullError();
    }
    outstanding += 1;
    outstandingBytes += chargeBytes;
    const normalizedKey = String(key || "default");
    const previous = lanes.get(normalizedKey) || Promise.resolve();
    const operation = previous.catch(() => {}).then(task);
    const tail = operation.catch(() => {}).finally(() => {
      outstanding -= 1;
      outstandingBytes -= chargeBytes;
      if (lanes.get(normalizedKey) === tail) lanes.delete(normalizedKey);
    });
    lanes.set(normalizedKey, tail);
    return operation;
  }

  function idle(key) {
    return !lanes.has(String(key || "default"));
  }

  async function close() {
    if (closePromise) return closePromise;
    accepting = false;
    closePromise = Promise.allSettled([...lanes.values()]).then((results) => {
      lanes.clear();
      const rejected = results.filter((entry) => entry.status === "rejected");
      return Object.freeze({ ok: rejected.length === 0, drained: results.length });
    });
    return closePromise;
  }

  return Object.freeze({
    run,
    close,
    idle,
    isAccepting: () => accepting,
    pendingCount: () => outstanding
  });
}
