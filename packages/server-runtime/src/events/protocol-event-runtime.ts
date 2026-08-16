import {
  createSqliteProtocolEventStore,
  type ProtocolEventStorePolicy,
  type SqliteProtocolEventStore
} from "./sqlite-protocol-event-store.ts";

interface ClosableEventBus {
  close(): void | Promise<void>;
}

interface ProtocolEventRuntimeOptions<T extends ClosableEventBus> {
  userDataPath?: string;
  logger?: unknown;
  createEventBus: (options: {
    eventStore: SqliteProtocolEventStore;
    logger?: unknown;
  } & Record<string, unknown>) => T;
  storePolicy?: Partial<ProtocolEventStorePolicy>;
  busPolicy?: Record<string, unknown>;
}

export interface ProtocolEventRuntime<T extends ClosableEventBus> {
  protocolEventBus: T;
  eventStore: SqliteProtocolEventStore;
  close(): Promise<void>;
}

export async function createProtocolEventRuntime<T extends ClosableEventBus>({
  userDataPath,
  logger,
  createEventBus,
  storePolicy = {},
  busPolicy = {}
}: ProtocolEventRuntimeOptions<T>): Promise<ProtocolEventRuntime<T>> {
  if (typeof createEventBus !== "function") {
    throw Object.assign(
      new TypeError("Protocol event bus factory is required."),
      { code: "protocol_event_bus_factory_required" }
    );
  }
  const eventStore = createSqliteProtocolEventStore({
    userDataPath,
    policy: storePolicy
  });
  let protocolEventBus: T;
  try {
    protocolEventBus = createEventBus({
      eventStore,
      logger,
      ...busPolicy
    });
  } catch (error: unknown) {
    eventStore.close();
    throw error;
  }
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    protocolEventBus,
    eventStore,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = (async (): Promise<void> => {
        try {
          await protocolEventBus.close();
        } finally {
          eventStore.close();
        }
      })();
      return closePromise;
    }
  });
}
