// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleServerEventController } from "../../../apps/console/composables/console-server-event-controller";
import { subscribeEvents } from "../../../apps/console/lib/server-events-client";
import type { EventSubscriptionResponse, ProtocolEvent } from "../../../apps/console/lib/types";

const serverEventsClientMock = vi.hoisted(() => ({
  subscribeEvents: vi.fn(),
}));

vi.mock("../../../apps/console/lib/server-events-client", () => ({
  subscribeEvents: serverEventsClientMock.subscribeEvents,
}));

const mockedSubscribeEvents = vi.mocked(subscribeEvents);

function makeEvent(offset: number, overrides: Partial<ProtocolEvent> = {}): ProtocolEvent {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    offset,
    id: `event-${offset}`,
    topic: "console.topic",
    type: "console.event",
    publisher: "server",
    publishedAt: "2026-06-04T00:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

function makeResponse(overrides: Partial<EventSubscriptionResponse> = {}): EventSubscriptionResponse {
  return {
    cursor: 0,
    nextCursor: 0,
    topics: ["console.topic"],
    events: [],
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createFixture(options: { currentTopics?: string; applyServerEvent?: (event: ProtocolEvent) => boolean } = {}) {
  const applyServerEvent = vi.fn(options.applyServerEvent || (() => true));
  const refreshState = vi.fn().mockResolvedValue(undefined);
  const controller = createConsoleServerEventController({
    applyServerEvent,
    currentTopics: options.currentTopics ? () => options.currentTopics! : () => "console.topic",
    refreshState,
  });

  return {
    applyServerEvent,
    controller,
    refreshState,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-04T00:00:00.000Z"));
  vi.clearAllMocks();
  mockedSubscribeEvents.mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("console server event controller", () => {
  it("calculates cursors from protocol events and refreshes when some incoming events are unhandled", async () => {
    const { applyServerEvent, controller, refreshState } = createFixture({
      applyServerEvent: (event) => event.offset !== 7,
    });
    mockedSubscribeEvents.mockResolvedValueOnce(
      makeResponse({
        nextCursor: 6,
        snapshots: [makeEvent(1), makeEvent(3)],
        events: [makeEvent(2), makeEvent(4), makeEvent(7)],
      }),
    );

    expect(controller.nextCursorFromProtocolEvents([])).toBe(0);
    expect(controller.nextCursorFromProtocolEvents([makeEvent(2), makeEvent(4)])).toBe(5);

    await controller.runServerEventSubscription();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockedSubscribeEvents).toHaveBeenCalledWith(
      {
        cursor: 0,
        topic: "console.topic",
        timeoutMs: 0,
        includeSnapshot: true,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(applyServerEvent.mock.calls.map(([event]) => event.offset)).toEqual([1, 3, 4, 7]);
    expect(refreshState).toHaveBeenCalledWith({ silent: true });
    expect(controller.serverEventCursor.value).toBe(8);

    controller.stopServerEventSubscription();
  });

  it("runs without snapshots after the first cursor and skips refresh when every event is handled", async () => {
    const { controller, refreshState } = createFixture({
      applyServerEvent: () => true,
    });
    controller.serverEventCursor.value = 8;
    mockedSubscribeEvents.mockResolvedValueOnce(
      makeResponse({
        nextCursor: 9,
        snapshots: [makeEvent(1), makeEvent(2)],
        events: [makeEvent(4), makeEvent(5), makeEvent(9)],
      }),
    );

    await controller.runServerEventSubscription();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockedSubscribeEvents).toHaveBeenCalledWith(
      {
        cursor: 8,
        topic: "console.topic",
        timeoutMs: 25000,
        includeSnapshot: false,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(refreshState).not.toHaveBeenCalled();
    expect(controller.serverEventCursor.value).toBe(10);

    controller.stopServerEventSubscription();
  });

  it("starts a fresh subscription, aborts the previous request, and clears pending retry timers on stop", async () => {
    const request = createDeferred<EventSubscriptionResponse>();
    mockedSubscribeEvents.mockReturnValueOnce(request.promise);
    const { controller } = createFixture();
    const priorAbortController = new AbortController();
    controller.serverEventAbortController.value = priorAbortController;
    const retryWait = controller.waitForServerEventRetry(3000);

    controller.serverEventCursor.value = 5;
    controller.serverEventSubscriptionGeneration.value = 2;

    expect(controller.serverEventTimer.value).not.toBeNull();
    controller.startServerEventSubscription();

    expect(priorAbortController.signal.aborted).toBe(true);
    expect(controller.serverEventSubscriptionStopped.value).toBe(false);
    expect(controller.serverEventCursor.value).toBe(0);
    expect(controller.serverEventSubscriptionGeneration.value).toBe(4);
    expect(controller.serverEventTimer.value).toBeNull();
    expect(mockedSubscribeEvents).toHaveBeenCalledWith(
      {
        cursor: 0,
        topic: "console.topic",
        timeoutMs: 0,
        includeSnapshot: true,
      },
      { signal: expect.any(AbortSignal) },
    );

    controller.stopServerEventSubscription();
    request.resolve(makeResponse());
    await retryWait;
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.serverEventSubscriptionStopped.value).toBe(true);
    expect(controller.serverEventTimer.value).toBeNull();
    expect(controller.serverEventAbortController.value).toBeNull();
  });

  it("retries after non-abort failures and stops retrying on abort errors", async () => {
    const { controller } = createFixture();

    mockedSubscribeEvents.mockRejectedValueOnce(Object.assign(new Error("abort"), { name: "AbortError" }));
    await controller.runServerEventSubscription();
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.serverEventTimer.value).toBeNull();
    expect(mockedSubscribeEvents).toHaveBeenCalledTimes(1);

    mockedSubscribeEvents.mockReset();
    mockedSubscribeEvents
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(makeResponse({ nextCursor: 2, events: [makeEvent(1)] }));

    const retryPromise = controller.runServerEventSubscription();
    await Promise.resolve();

    expect(controller.serverEventTimer.value).not.toBeNull();
    expect(mockedSubscribeEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(100);
    await retryPromise;
    await vi.advanceTimersByTimeAsync(0);

    expect(mockedSubscribeEvents).toHaveBeenCalledTimes(2);
    expect(controller.serverEventTimer.value).not.toBeNull();

    controller.stopServerEventSubscription();
  });
});
