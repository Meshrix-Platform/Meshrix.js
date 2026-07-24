import { validateWorkQueueStoreAdapterShape } from "../work-queue/store-adapter-contract.mjs";

const OUTBOX_TRANSITION_METHODS = Object.freeze([
  "enqueue",
  "claim",
  "complete",
  "retry",
  "recover",
]);

const DISPATCHER_OPERATIONS = Object.freeze([
  "dispatchOnce",
  "status",
  "drain",
  "cancel",
]);

export const DURABLE_EVENT_DELIVERY_DISCIPLINE = Object.freeze({
  id: "durable-event-delivery",
  outbox: Object.freeze({
    journal: "work_queue_transition_journal",
    storeMethods: OUTBOX_TRANSITION_METHODS,
    writeMode: "transactional-journal",
  }),
  delivery: Object.freeze({
    dispatcherId: "queue-push-dispatcher",
    claimBeforeDispatch: true,
    boundedInFlight: "credit-limit",
    operations: DISPATCHER_OPERATIONS,
  }),
  separation: Object.freeze({
    intentPersistence: "work-queue-store",
    handlerExecution: "queue-worker-runtime",
    dispatchWithoutClaim: "forbidden",
  }),
});

function operationsMatch(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((operation, index) => actual[index] === operation);
}

function requireStoreClaim(store) {
  if (!store || typeof store.claim !== "function") {
    throw new Error("Transactional outbox requires a work queue store with claim.");
  }
}

function requireDispatcherDispatch(dispatcher) {
  if (!dispatcher || typeof dispatcher.dispatchOnce !== "function") {
    throw new Error("Bounded durable delivery requires a push dispatcher with dispatchOnce.");
  }
}

export function assertDurableEventDeliveryBoundaries({ store, dispatcher } = {}) {
  requireStoreClaim(store);
  requireDispatcherDispatch(dispatcher);

  const storeValidation = validateWorkQueueStoreAdapterShape(store);
  if (!storeValidation.ok) {
    throw new Error("Transactional outbox store adapter is incomplete.");
  }

  for (const method of DURABLE_EVENT_DELIVERY_DISCIPLINE.outbox.storeMethods) {
    if (typeof store[method] !== "function") {
      throw new Error("Transactional outbox store is missing a required transition method.");
    }
  }

  for (const operation of DURABLE_EVENT_DELIVERY_DISCIPLINE.delivery.operations) {
    if (typeof dispatcher[operation] !== "function") {
      throw new Error("Bounded durable delivery dispatcher is missing a required operation.");
    }
  }

  return true;
}

export function assertOutboxTransitionMethods(actualMethods) {
  if (!operationsMatch(actualMethods, DURABLE_EVENT_DELIVERY_DISCIPLINE.outbox.storeMethods)) {
    throw new Error("Transactional outbox transition methods changed without updating the delivery contract.");
  }
  return true;
}
