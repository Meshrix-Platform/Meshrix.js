import { validateQueueBackgroundWriteAspectShape } from "./store-adapter-contract.ts";

function requireStoreMethod(store?: any, method?: any) : any {
  if (!store || typeof store[method] !== "function") {
    throw new Error(`Queue background write aspect requires store.${method}.`);
  }
}

export function createQueueBackgroundWriteAspect({ store }: Record<string, any> = {}) : any {
  for (const method of [
    "writeFallbackCoordinatorState",
    "writeSnapshotState",
    "writeCompactionState",
    "writeInternalHealthState"
  ]) {
    requireStoreMethod(store, method);
  }

  const aspect: Readonly<Record<string, any>> = Object.freeze({
    writeFallbackCoordinatorState(input: Record<string, any> = {}) : any {
      return store.writeFallbackCoordinatorState(input);
    },
    writeSnapshotState(input: Record<string, any> = {}) : any {
      return store.writeSnapshotState(input);
    },
    writeCompactionState(input: Record<string, any> = {}) : any {
      return store.writeCompactionState(input);
    },
    writeInternalHealthState(input: Record<string, any> = {}) : any {
      return store.writeInternalHealthState(input);
    }
  });

  const validation: any = validateQueueBackgroundWriteAspectShape(aspect);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }
  return aspect;
}
