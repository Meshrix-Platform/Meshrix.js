import { validateQueueBackgroundWriteAspectShape } from "./store-adapter-contract.ts";

interface QueueStateWrite { [key: string]: unknown }
type QueueStateWriter = (input?: QueueStateWrite) => unknown;
interface QueueBackgroundWriteStore {
  writeFallbackCoordinatorState: QueueStateWriter;
  writeSnapshotState: QueueStateWriter;
  writeCompactionState: QueueStateWriter;
  writeInternalHealthState: QueueStateWriter;
}
export interface QueueBackgroundWriteAspect extends QueueBackgroundWriteStore {}

function isBackgroundWriteStore(store: Partial<QueueBackgroundWriteStore> | undefined): store is QueueBackgroundWriteStore {
  return Boolean(store) && typeof store?.writeFallbackCoordinatorState === "function" &&
    typeof store.writeSnapshotState === "function" && typeof store.writeCompactionState === "function" &&
    typeof store.writeInternalHealthState === "function";
}

function requireStoreMethod(store: Partial<QueueBackgroundWriteStore> | undefined, method: keyof QueueBackgroundWriteStore): void {
  if (!store || typeof store[method] !== "function") {
    throw new Error(`Queue background write aspect requires store.${method}.`);
  }
}

export function createQueueBackgroundWriteAspect({ store }: { store?: Partial<QueueBackgroundWriteStore> } = {}): Readonly<QueueBackgroundWriteAspect> {
  const methods: Array<keyof QueueBackgroundWriteStore> = [
    "writeFallbackCoordinatorState",
    "writeSnapshotState",
    "writeCompactionState",
    "writeInternalHealthState"
  ];
  for (const method of methods) {
    requireStoreMethod(store, method);
  }

  if (!isBackgroundWriteStore(store)) throw new Error("Queue background write aspect requires a complete store.");
  const checkedStore = store;
  const aspect: Readonly<QueueBackgroundWriteAspect> = Object.freeze({
    writeFallbackCoordinatorState(input: QueueStateWrite = {}) {
      return checkedStore.writeFallbackCoordinatorState(input);
    },
    writeSnapshotState(input: QueueStateWrite = {}) {
      return checkedStore.writeSnapshotState(input);
    },
    writeCompactionState(input: QueueStateWrite = {}) {
      return checkedStore.writeCompactionState(input);
    },
    writeInternalHealthState(input: QueueStateWrite = {}) {
      return checkedStore.writeInternalHealthState(input);
    }
  });

  const validation: { ok: boolean; errors: string[] } = validateQueueBackgroundWriteAspectShape(aspect);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }
  return aspect;
}
