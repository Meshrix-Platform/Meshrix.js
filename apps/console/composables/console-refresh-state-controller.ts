import { ref, type Ref } from "vue";
import { getServerConsoleState } from "../lib/console-state-client";
import type { ServerConsoleState } from "../lib/types";
import type { RefreshStateOptions } from "../types/app";
import { createConsoleTimeoutController } from "./console-timer-controller";

export const REFRESH_STATE_DELAY_MS: any = 3000;

/** Busy key owned by the console state refresh. */
export const REFRESH_STATE_BUSY_KEY = "refresh";

export type ConsoleRefreshStateControllerOptions = {
  applyConsoleState: (
    nextState: ServerConsoleState,
    options?: { forceSettings?: boolean; forceDrafts?: boolean },
  ) => void;
  clearBusy: (key: string) => void;
  error: Ref<string>;
  serverAvailable: Ref<boolean>;
  setBusy: (key: string) => void;
};

export function createConsoleRefreshStateController(options: ConsoleRefreshStateControllerOptions) : any {
  const lastRefreshStateStartedAt: any = ref(0);
  const pendingRefreshStateDelay: any = createConsoleTimeoutController();
  const pendingRefreshStateTimer: any = pendingRefreshStateDelay.timer;
  const pendingRefreshStateOptions: any = ref<RefreshStateOptions | null>(null);
  const pendingRefreshStatePromise: any = ref<Promise<void> | null>(null);
  const pendingRefreshStateResolve: any = ref<(() => void) | null>(null);

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
    const left: any = normalizeRefreshStateOptions(current || {});
    const right: any = normalizeRefreshStateOptions(incoming);
    return {
      silent: left.silent && right.silent,
      forceSettings: Boolean(left.forceSettings || right.forceSettings),
      forceDrafts: Boolean(left.forceDrafts || right.forceDrafts),
    };
  }

  function clearPendingRefreshStateTimer() : any {
    pendingRefreshStateDelay.stop();
  }

  function scheduleDelayedRefreshState(value: RefreshStateOptions, delayMs: number) : any {
    pendingRefreshStateOptions.value = mergeRefreshStateOptions(pendingRefreshStateOptions.value, value);
    if (!pendingRefreshStatePromise.value) {
      pendingRefreshStatePromise.value = new Promise<void>((resolve?: any) : any => {
        pendingRefreshStateResolve.value = resolve;
      });
    }
    if (pendingRefreshStateTimer.value) {
      return pendingRefreshStatePromise.value;
    }
    pendingRefreshStateDelay.schedule(() : any => {
      const nextOptions: any = pendingRefreshStateOptions.value || {};
      const resolve: any = pendingRefreshStateResolve.value;
      pendingRefreshStateOptions.value = null;
      pendingRefreshStatePromise.value = null;
      pendingRefreshStateResolve.value = null;
      void performRefreshState(nextOptions).finally(() : any => {
        resolve?.();
      });
    }, Math.max(0, delayMs));
    return pendingRefreshStatePromise.value;
  }

  async function performRefreshState(value: RefreshStateOptions = {}) : Promise<any> {
    lastRefreshStateStartedAt.value = Date.now();
    const showBusy: any = !value.silent;
    const forceDrafts: any = value.forceDrafts === true;
    if (showBusy) {
      options.setBusy(REFRESH_STATE_BUSY_KEY);
    }
    options.error.value = "";

    try {
      const nextState: any = await getServerConsoleState();
      options.applyConsoleState(nextState, {
        forceSettings: value.forceSettings,
        forceDrafts,
      });
      options.serverAvailable.value = true;
    } catch (nextError: any) {
      options.serverAvailable.value = false;
      options.error.value =
        nextError instanceof Error ? nextError.message : "加载服务端控制台失败。";
    } finally {
      if (showBusy) {
        options.clearBusy(REFRESH_STATE_BUSY_KEY);
      }
    }
  }

  async function refreshState(value: RefreshStateOptions = {}) : Promise<any> {
    const normalized: any = normalizeRefreshStateOptions(value);
    if (normalized.forceSettings || normalized.forceDrafts) {
      return performRefreshState(normalized);
    }
    const elapsedMs: any = Date.now() - lastRefreshStateStartedAt.value;
    if (lastRefreshStateStartedAt.value > 0 && elapsedMs < REFRESH_STATE_DELAY_MS) {
      return scheduleDelayedRefreshState(
        normalized,
        REFRESH_STATE_DELAY_MS - elapsedMs,
      );
    }
    return performRefreshState(normalized);
  }

  function clearPendingRefreshState() : any {
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
