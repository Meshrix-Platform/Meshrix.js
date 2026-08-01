import { createSqliteProtocolEventStore } from "./sqlite-protocol-event-store.ts";

export async function createProtocolEventRuntime({
  userDataPath,
  logger,
  createEventBus,
  storePolicy = {},
  busPolicy = {}
}: Record<string, any> = {}) : Promise<any> {
  if (typeof createEventBus !== "function") {
    throw Object.assign(
      new TypeError("Protocol event bus factory is required."),
      { code: "protocol_event_bus_factory_required" }
    );
  }
  const eventStore: any = createSqliteProtocolEventStore({
    userDataPath,
    policy: storePolicy
  });
  let protocolEventBus: any;
  try {
    protocolEventBus = createEventBus({
      eventStore,
      logger,
      ...busPolicy
    });
  } catch (error: any) {
    eventStore.close();
    throw error;
  }
  let closePromise: any = null;
  return Object.freeze({
    protocolEventBus,
    eventStore,
    close() : any {
      if (closePromise) return closePromise;
      closePromise = (async () : Promise<any> => {
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
