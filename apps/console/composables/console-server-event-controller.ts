import { subscribeEvents } from "../lib/server-events-client";
import type { ProtocolEvent } from "../lib/types";
import { ref } from "vue";
import { createConsoleTimeoutController } from "./console-timer-controller";

export type ConsoleServerEventControllerOptions = {
  applyServerEvent: (event: ProtocolEvent) => boolean;
  currentTopics: () => string;
  refreshState: (options?: { silent?: boolean }) => Promise<void>;
};

export function createConsoleServerEventController(options: ConsoleServerEventControllerOptions) : any {
  const serverEventCursor: any = ref(0);
  const serverEventSubscriptionStopped: any = ref(false);
  const serverEventSubscriptionGeneration: any = ref(0);
  const serverEventAbortController: any = ref<AbortController | null>(null);
  const serverEventDelay: any = createConsoleTimeoutController();
  const serverEventTimer: any = serverEventDelay.timer;
  const serverEventTimerResolve: any = ref<(() => void) | null>(null);

  function resetServerEventCursor() : any {
    serverEventCursor.value = 0;
  }

  function clearServerEventTimer() : any {
    serverEventDelay.stop();
    if (serverEventTimerResolve.value) {
      serverEventTimerResolve.value();
      serverEventTimerResolve.value = null;
    }
  }

  function waitForServerEventRetry(ms: number) : any {
    return new Promise<void>((resolve?: any) : any => {
      clearServerEventTimer();
      serverEventTimerResolve.value = resolve;
      const scheduledTimer: any = serverEventDelay.schedule(() : any => {
        serverEventTimerResolve.value = null;
        resolve();
      }, ms);
      if (scheduledTimer === null) {
        serverEventTimerResolve.value = null;
        resolve();
      }
    });
  }

  function isAbortError(nextError: unknown) : any {
    return (
      (nextError instanceof DOMException && nextError.name === "AbortError") ||
      (nextError instanceof Error && nextError.name === "AbortError")
    );
  }

  function nextCursorFromProtocolEvents(events: ProtocolEvent[]) : any {
    return events.reduce((cursor?: any, event?: any) : any => Math.max(cursor, event.offset + 1), 0);
  }

  function stopServerEventSubscription() : any {
    serverEventSubscriptionStopped.value = true;
    serverEventSubscriptionGeneration.value += 1;
    clearServerEventTimer();
    if (serverEventAbortController.value) {
      serverEventAbortController.value.abort();
      serverEventAbortController.value = null;
    }
  }

  async function runServerEventSubscription(generation: any = serverEventSubscriptionGeneration.value) : Promise<any> {
    if (
      serverEventSubscriptionStopped.value ||
      generation !== serverEventSubscriptionGeneration.value
    ) {
      return;
    }

    const controller: any = new AbortController();
    serverEventAbortController.value = controller;
    const requestCursor: any = serverEventCursor.value;
    try {
      const response: any = await subscribeEvents({
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
      const snapshotEvents: any = requestCursor === 0 ? response.snapshots || [] : [];
      const snapshotCursor: any = nextCursorFromProtocolEvents(snapshotEvents);
      const liveEvents: any =
        snapshotCursor > 0
          ? response.events.filter((event?: any) : any => event.offset >= snapshotCursor)
          : response.events;
      const incomingEvents: any[] = [...snapshotEvents, ...liveEvents];
      const hasUpdates: any = incomingEvents.length > 0;
      const handledUpdates: any = incomingEvents.filter(options.applyServerEvent).length;
      serverEventCursor.value = Math.max(
        serverEventCursor.value,
        response.nextCursor || 0,
        snapshotCursor,
        nextCursorFromProtocolEvents(liveEvents),
      );
      if (hasUpdates && handledUpdates < incomingEvents.length) {
        await options.refreshState({ silent: true });
      }
    } catch (nextError: any) {
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
      serverEventDelay.schedule(() : any => {
        void runServerEventSubscription(generation);
      }, 100);
    }
  }

  function startServerEventSubscription() : any {
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
