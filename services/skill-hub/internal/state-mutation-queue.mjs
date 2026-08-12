export function createStateMutationQueue() {
  const lanes = new Map();
  let accepting = true;
  let closePromise = null;

  function run(key, task) {
    if (typeof task !== "function") throw new TypeError("State mutation requires a task function.");
    if (!accepting) {
      const error = new Error("Skill Hub mutation queue is closed.");
      error.code = "skill_hub_runtime_closed";
      throw error;
    }
    const normalizedKey = String(key || "default");
    const previous = lanes.get(normalizedKey) || Promise.resolve();
    const operation = previous.catch(() => {}).then(task);
    const tail = operation.catch(() => {}).finally(() => {
      if (lanes.get(normalizedKey) === tail) lanes.delete(normalizedKey);
    });
    lanes.set(normalizedKey, tail);
    return operation;
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

  return Object.freeze({ run, close, isAccepting: () => accepting });
}
