import { createSqliteProtocolEventStore } from "./sqlite-protocol-event-store.mjs";

export async function createProtocolEventRuntime({
  userDataPath,
  logger,
  createEventBus,
  storePolicy = {},
  busPolicy = {}
} = {}) {
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
  let protocolEventBus;
  try {
    protocolEventBus = createEventBus({
      eventStore,
      logger,
      ...busPolicy
    });
  } catch (error) {
    eventStore.close();
    throw error;
  }
  let closePromise = null;
  return Object.freeze({
    protocolEventBus,
    eventStore,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
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
