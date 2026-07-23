import { ref, type Ref } from "vue";
import { getServerConsoleState } from "../lib/console-state-client";
import type { ServerConsoleState } from "../lib/types";
import type { RefreshStateOptions } from "../types/app";
import { createConsoleTimeoutController } from "./console-timer-controller";

export const REFRESH_STATE_DELAY_MS = 3000;

export type ConsoleRefreshStateControllerOptions = {
  applyConsoleState: (
    nextState: ServerConsoleState,
    options?: { forceSettings?: boolean; forceDrafts?: boolean },
  ) => void;
  busyKey: Ref<string>;
  clearAllBusy: () => void;
  error: Ref<string>;
  serverAvailable: Ref<boolean>;
  setBusy: (key: string) => void;
};

export function createConsoleRefreshStateController(options: ConsoleRefreshStateControllerOptions) {
  const lastRefreshStateStartedAt = ref(0);
  const pendingRefreshStateDelay = createConsoleTimeoutController();
  const pendingRefreshStateTimer = pendingRefreshStateDelay.timer;
  const pendingRefreshStateOptions = ref<RefreshStateOptions | null>(null);
  const pendingRefreshStatePromise = ref<Promise<void> | null>(null);
  const pendingRefreshStateResolve = ref<(() => void) | null>(null);

  function normalizeRefreshStateOptions(value: RefreshStateOptions = {}): RefreshStateOptions {
    return {
      silent: value.silent === true,
      forceSettings: value.forceSettings === true,
      forceDrafts: value.forceDrafts === true,
    };
  }

  function mergeRefreshStateOptions(
    current: RefreshStateOptions | null,
    incoming: RefreshStateOptions = {},
  ): RefreshStateOptions {
    if (!current) {
      return normalizeRefreshStateOptions(incoming);
    }
    const left = normalizeRefreshStateOptions(current || {});
    const right = normalizeRefreshStateOptions(incoming);
    return {
      silent: left.silent && right.silent,
      forceSettings: Boolean(left.forceSettings || right.forceSettings),
      forceDrafts: Boolean(left.forceDrafts || right.forceDrafts),
    };
  }

  function clearPendingRefreshStateTimer() {
    pendingRefreshStateDelay.stop();
  }

  function scheduleDelayedRefreshState(value: RefreshStateOptions, delayMs: number) {
    pendingRefreshStateOptions.value = mergeRefreshStateOptions(pendingRefreshStateOptions.value, value);
    if (!pendingRefreshStatePromise.value) {
      pendingRefreshStatePromise.value = new Promise<void>((resolve) => {
        pendingRefreshStateResolve.value = resolve;
      });
    }
    if (pendingRefreshStateTimer.value) {
      return pendingRefreshStatePromise.value;
    }
    pendingRefreshStateDelay.schedule(() => {
      const nextOptions = pendingRefreshStateOptions.value || {};
      const resolve = pendingRefreshStateResolve.value;
      pendingRefreshStateOptions.value = null;
      pendingRefreshStatePromise.value = null;
      pendingRefreshStateResolve.value = null;
      void performRefreshState(nextOptions).finally(() => {
        resolve?.();
      });
    }, Math.max(0, delayMs));
    return pendingRefreshStatePromise.value;
  }

  async function performRefreshState(value: RefreshStateOptions = {}) {
    lastRefreshStateStartedAt.value = Date.now();
    const showBusy = !value.silent;
    const forceDrafts = value.forceDrafts === true;
    if (showBusy) {
      options.setBusy(options.busyKey.value || "refresh");
    }
    options.error.value = "";

    try {
      const nextState = await getServerConsoleState();
      options.applyConsoleState(nextState, {
        forceSettings: value.forceSettings,
        forceDrafts,
      });
      options.serverAvailable.value = true;
    } catch (nextError) {
      options.serverAvailable.value = false;
      options.error.value =
        nextError instanceof Error ? nextError.message : "加载服务端控制台失败。";
    } finally {
      if (showBusy) {
        options.clearAllBusy();
      }
    }
  }

  async function refreshState(value: RefreshStateOptions = {}) {
    const normalized = normalizeRefreshStateOptions(value);
    if (normalized.forceSettings || normalized.forceDrafts) {
      return performRefreshState(normalized);
    }
    const elapsedMs = Date.now() - lastRefreshStateStartedAt.value;
    if (lastRefreshStateStartedAt.value > 0 && elapsedMs < REFRESH_STATE_DELAY_MS) {
      return scheduleDelayedRefreshState(
        normalized,
        REFRESH_STATE_DELAY_MS - elapsedMs,
      );
    }
    return performRefreshState(normalized);
  }

  function clearPendingRefreshState() {
    clearPendingRefreshStateTimer();
    pendingRefreshStateOptions.value = null;
    pendingRefreshStateResolve.value?.();
    pendingRefreshStatePromise.value = null;
    pendingRefreshStateResolve.value = null;
  }

  return {
    REFRESH_STATE_DELAY_MS,
    clearPendingRefreshState,
    clearPendingRefreshStateTimer,
    lastRefreshStateStartedAt,
    mergeRefreshStateOptions,
    normalizeRefreshStateOptions,
    pendingRefreshStateOptions,
    pendingRefreshStatePromise,
    pendingRefreshStateResolve,
    pendingRefreshStateTimer,
    performRefreshState,
    refreshState,
    scheduleDelayedRefreshState,
  };
}
