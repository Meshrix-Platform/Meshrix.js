// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import {
  createConsoleRefreshStateController,
  REFRESH_STATE_DELAY_MS,
} from "../../../apps/console/composables/console-refresh-state-controller";

const consoleStateClientMock: any = vi.hoisted(() : any => ({
  getServerConsoleState: vi.fn(),
}));

vi.mock("../../../apps/console/lib/console-state-client", () : any => ({
  getServerConsoleState: consoleStateClientMock.getServerConsoleState,
}));

function makeState(id: string) : any {
  return {
    server: { runtimeId: id },
  } as any;
}

function createFixture() : any {
  const busyKey: any = ref("");
  const error: any = ref("seed");
  const serverAvailable: any = ref(false);
  const applyConsoleState: any = vi.fn();
  const clearAllBusy: any = vi.fn();
  const setBusy: any = vi.fn();
  const controller: any = createConsoleRefreshStateController({
    applyConsoleState,
    busyKey,
    clearAllBusy,
    error,
    serverAvailable,
    setBusy,
  });
  return {
    applyConsoleState,
    busyKey,
    clearAllBusy,
    controller,
    error,
    serverAvailable,
    setBusy,
  };
}

beforeEach(() : any => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-04T00:00:00.000Z"));
  vi.clearAllMocks();
});

afterEach(() : any => {
  vi.useRealTimers();
});

describe("console refresh state controller", () : any => {
  it("normalizes and merges refresh options", () : any => {
    const { controller } = createFixture();

    expect(controller.normalizeRefreshStateOptions({})).toEqual({
      silent: false,
      forceSettings: false,
      forceDrafts: false,
    });
    expect(controller.normalizeRefreshStateOptions({
      silent: true,
      forceSettings: true,
      forceDrafts: true,
    })).toEqual({
      silent: true,
      forceSettings: true,
      forceDrafts: true,
    });
    expect(controller.mergeRefreshStateOptions(null, { silent: true })).toEqual({
      silent: true,
      forceSettings: false,
      forceDrafts: false,
    });
    expect(controller.mergeRefreshStateOptions(
      { silent: true, forceSettings: false, forceDrafts: true },
      { silent: false, forceSettings: true, forceDrafts: false },
    )).toEqual({
      silent: false,
      forceSettings: true,
      forceDrafts: true,
    });
  });

  it("performs a visible refresh and applies the server state", async () : Promise<any> => {
    const { applyConsoleState, busyKey, clearAllBusy, controller, error, serverAvailable, setBusy } = createFixture();
    busyKey.value = "manual-refresh";
    consoleStateClientMock.getServerConsoleState.mockResolvedValueOnce(makeState("runtime-1"));

    await controller.performRefreshState({ forceSettings: true });

    expect(setBusy).toHaveBeenCalledWith("manual-refresh");
    expect(error.value).toBe("");
    expect(applyConsoleState).toHaveBeenCalledWith(makeState("runtime-1"), {
      forceSettings: true,
      forceDrafts: false,
    });
    expect(serverAvailable.value).toBe(true);
    expect(clearAllBusy).toHaveBeenCalledTimes(1);
    expect(controller.lastRefreshStateStartedAt.value).toBe(Date.now());
  });

  it("marks the server unavailable and reports fallback errors", async () : Promise<any> => {
    const { applyConsoleState, clearAllBusy, controller, error, serverAvailable, setBusy } = createFixture();
    consoleStateClientMock.getServerConsoleState.mockRejectedValueOnce("offline");

    await controller.performRefreshState();

    expect(setBusy).toHaveBeenCalledWith("refresh");
    expect(applyConsoleState).not.toHaveBeenCalled();
    expect(serverAvailable.value).toBe(false);
    expect(error.value).toBe("加载服务端控制台失败。");
    expect(clearAllBusy).toHaveBeenCalledTimes(1);

    consoleStateClientMock.getServerConsoleState.mockRejectedValueOnce(new Error("server down"));
    await controller.performRefreshState({ silent: true });

    expect(error.value).toBe("server down");
    expect(setBusy).toHaveBeenCalledTimes(1);
    expect(clearAllBusy).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid refreshes into one delayed refresh and merges silent flags", async () : Promise<any> => {
    const { applyConsoleState, clearAllBusy, controller, setBusy } = createFixture();
    consoleStateClientMock.getServerConsoleState
      .mockResolvedValueOnce(makeState("initial"))
      .mockResolvedValueOnce(makeState("coalesced"));

    await controller.refreshState({ silent: true });
    expect(consoleStateClientMock.getServerConsoleState).toHaveBeenCalledTimes(1);
    expect(setBusy).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 500);
    const firstPending: any = controller.refreshState({ silent: true });
    const secondPending: any = controller.refreshState({ silent: false });

    expect(controller.pendingRefreshStatePromise.value).not.toBeNull();
    expect(controller.pendingRefreshStateOptions.value).toEqual({
      silent: false,
      forceSettings: false,
      forceDrafts: false,
    });
    expect(consoleStateClientMock.getServerConsoleState).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REFRESH_STATE_DELAY_MS - 500);
    await Promise.all([firstPending, secondPending]);

    expect(consoleStateClientMock.getServerConsoleState).toHaveBeenCalledTimes(2);
    expect(setBusy).toHaveBeenCalledWith("refresh");
    expect(clearAllBusy).toHaveBeenCalledTimes(1);
    expect(applyConsoleState).toHaveBeenLastCalledWith(makeState("coalesced"), {
      forceSettings: false,
      forceDrafts: false,
    });
    expect(controller.pendingRefreshStatePromise.value).toBeNull();
  });

  it("bypasses throttling for force refreshes and clears pending delayed refreshes", async () : Promise<any> => {
    const { applyConsoleState, controller, setBusy } = createFixture();
    consoleStateClientMock.getServerConsoleState
      .mockResolvedValueOnce(makeState("initial"))
      .mockResolvedValueOnce(makeState("forced"));

    await controller.refreshState();
    setBusy.mockClear();
    vi.setSystemTime(Date.now() + 100);
    const pending: any = controller.scheduleDelayedRefreshState({ silent: true }, 5000);
    expect(controller.pendingRefreshStateTimer.value).not.toBeNull();

    controller.clearPendingRefreshState();
    await expect(pending).resolves.toBeUndefined();
    expect(controller.pendingRefreshStateTimer.value).toBeNull();
    expect(controller.pendingRefreshStateOptions.value).toBeNull();

    await controller.refreshState({ silent: true, forceDrafts: true });

    expect(consoleStateClientMock.getServerConsoleState).toHaveBeenCalledTimes(2);
    expect(setBusy).not.toHaveBeenCalled();
    expect(applyConsoleState).toHaveBeenLastCalledWith(makeState("forced"), {
      forceSettings: false,
      forceDrafts: true,
    });
  });
});
