import { validateQueueBackgroundWriteAspectShape } from "./store-adapter-contract.mjs";

function requireStoreMethod(store, method) {
  if (!store || typeof store[method] !== "function") {
    throw new Error(`Queue background write aspect requires store.${method}.`);
  }
}

export function createQueueBackgroundWriteAspect({ store } = {}) {
  for (const method of [
    "writeFallbackCoordinatorState",
    "writeSnapshotState",
    "writeCompactionState",
    "writeInternalHealthState"
  ]) {
    requireStoreMethod(store, method);
  }

  const aspect = Object.freeze({
    writeFallbackCoordinatorState(input = {}) {
      return store.writeFallbackCoordinatorState(input);
    },
    writeSnapshotState(input = {}) {
      return store.writeSnapshotState(input);
    },
    writeCompactionState(input = {}) {
      return store.writeCompactionState(input);
    },
    writeInternalHealthState(input = {}) {
      return store.writeInternalHealthState(input);
    }
  });

  const validation = validateQueueBackgroundWriteAspectShape(aspect);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }
  return aspect;
}
