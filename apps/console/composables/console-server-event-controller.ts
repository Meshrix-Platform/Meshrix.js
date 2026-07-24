import { subscribeEvents } from "../lib/server-events-client";
import type { ProtocolEvent } from "../lib/types";
import { ref } from "vue";
import { createConsoleTimeoutController } from "./console-timer-controller";

export type ConsoleServerEventControllerOptions = {
  applyServerEvent: (event: ProtocolEvent) => boolean;
  currentTopics: () => string;
  refreshState: (options?: { silent?: boolean }) => Promise<void>;
};

export function createConsoleServerEventController(options: ConsoleServerEventControllerOptions) {
  const serverEventCursor = ref(0);
  const serverEventSubscriptionStopped = ref(false);
  const serverEventSubscriptionGeneration = ref(0);
  const serverEventAbortController = ref<AbortController | null>(null);
  const serverEventDelay = createConsoleTimeoutController();
  const serverEventTimer = serverEventDelay.timer;
  const serverEventTimerResolve = ref<(() => void) | null>(null);

  function resetServerEventCursor() {
    serverEventCursor.value = 0;
  }

  function clearServerEventTimer() {
    serverEventDelay.stop();
    if (serverEventTimerResolve.value) {
      serverEventTimerResolve.value();
      serverEventTimerResolve.value = null;
    }
  }

  function waitForServerEventRetry(ms: number) {
    return new Promise<void>((resolve) => {
      clearServerEventTimer();
      serverEventTimerResolve.value = resolve;
      const scheduledTimer = serverEventDelay.schedule(() => {
        serverEventTimerResolve.value = null;
        resolve();
      }, ms);
      if (scheduledTimer === null) {
        serverEventTimerResolve.value = null;
        resolve();
      }
    });
  }

  function isAbortError(nextError: unknown) {
    return (
      (nextError instanceof DOMException && nextError.name === "AbortError") ||
      (nextError instanceof Error && nextError.name === "AbortError")
    );
  }

  function nextCursorFromProtocolEvents(events: ProtocolEvent[]) {
    return events.reduce((cursor, event) => Math.max(cursor, event.offset + 1), 0);
  }

  function stopServerEventSubscription() {
    serverEventSubscriptionStopped.value = true;
    serverEventSubscriptionGeneration.value += 1;
    clearServerEventTimer();
    if (serverEventAbortController.value) {
      serverEventAbortController.value.abort();
      serverEventAbortController.value = null;
    }
  }

  async function runServerEventSubscription(generation = serverEventSubscriptionGeneration.value) {
    if (
      serverEventSubscriptionStopped.value ||
      generation !== serverEventSubscriptionGeneration.value
    ) {
      return;
    }

    const controller = new AbortController();
    serverEventAbortController.value = controller;
    const requestCursor = serverEventCursor.value;
    try {
      const response = await subscribeEvents({
        cursor: requestCursor,
        topic: options.currentTopics(),
        timeoutMs: requestCursor === 0 ? 0 : 25000,
        includeSnapshot: requestCursor === 0,
      }, { signal: controller.signal });
      if (
        serverEventSubscriptionStopped.value ||
        generation !== serverEventSubscriptionGeneration.value ||
        controller.signal.aborted
      ) {
        return;
      }
      const snapshotEvents = requestCursor === 0 ? response.snapshots || [] : [];
      const snapshotCursor = nextCursorFromProtocolEvents(snapshotEvents);
      const liveEvents =
        snapshotCursor > 0
          ? response.events.filter((event) => event.offset >= snapshotCursor)
          : response.events;
      const incomingEvents = [...snapshotEvents, ...liveEvents];
      const hasUpdates = incomingEvents.length > 0;
      const handledUpdates = incomingEvents.filter(options.applyServerEvent).length;
      serverEventCursor.value = Math.max(
        serverEventCursor.value,
        response.nextCursor || 0,
        snapshotCursor,
        nextCursorFromProtocolEvents(liveEvents),
      );
      if (hasUpdates && handledUpdates < incomingEvents.length) {
        await options.refreshState({ silent: true });
      }
    } catch (nextError) {
      if (
        isAbortError(nextError) ||
        serverEventSubscriptionStopped.value ||
        generation !== serverEventSubscriptionGeneration.value
      ) {
        return;
      }
      await waitForServerEventRetry(3000);
    } finally {
      if (serverEventAbortController.value === controller) {
        serverEventAbortController.value = null;
      }
    }

    if (
      !serverEventSubscriptionStopped.value &&
      generation === serverEventSubscriptionGeneration.value
    ) {
      serverEventDelay.schedule(() => {
        void runServerEventSubscription(generation);
      }, 100);
    }
  }

  function startServerEventSubscription() {
    stopServerEventSubscription();
    serverEventCursor.value = 0;
    serverEventSubscriptionStopped.value = false;
    serverEventSubscriptionGeneration.value += 1;
    void runServerEventSubscription(serverEventSubscriptionGeneration.value);
  }

  return {
    clearServerEventTimer,
    isAbortError,
    nextCursorFromProtocolEvents,
    resetServerEventCursor,
    runServerEventSubscription,
    serverEventAbortController,
    serverEventCursor,
    serverEventSubscriptionGeneration,
    serverEventSubscriptionStopped,
    serverEventTimer,
    serverEventTimerResolve,
    startServerEventSubscription,
    stopServerEventSubscription,
    waitForServerEventRetry,
  };
}
