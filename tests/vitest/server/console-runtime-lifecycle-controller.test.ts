import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { createConsoleRuntimeLifecycleController } from "../../../apps/console/composables/console-runtime-lifecycle-controller";

type AuthSnapshot = {
  bootstrap: { required: boolean };
  session: { authenticated: boolean };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function authenticatedSnapshot(): AuthSnapshot {
  return {
    bootstrap: { required: false },
    session: { authenticated: true },
  };
}

function fixture(overrides: Partial<Parameters<typeof createConsoleRuntimeLifecycleController>[0]> = {}) {
  const options = {
    consoleBootstrapping: ref(false),
    clearBrowserLocalStateFromUrl: vi.fn(async () => undefined),
    clearConfigTargetHighlight: vi.fn(),
    clearPendingRefreshState: vi.fn(),
    liveDashboardAlerts: { value: [] },
    onBootstrapError: vi.fn(),
    refreshAuthState: vi.fn(async () => authenticatedSnapshot()),
    refreshContextCompiler: vi.fn(async () => undefined),
    refreshMonitorAlerts: vi.fn(async () => undefined),
    refreshState: vi.fn(async () => undefined),
    startServerEventSubscription: vi.fn(),
    stopServerEventSubscription: vi.fn(),
    syncDashboardAlertInbox: vi.fn(),
    ...overrides,
  };
  return {
    controller: createConsoleRuntimeLifecycleController(options),
    options,
  };
}

describe("console runtime lifecycle", () => {
  it("keeps route access gated until authenticated console state is loaded", async () => {
    const state = deferred<void>();
    const { controller, options } = fixture({
      refreshState: vi.fn(() => state.promise),
    });

    const initialization = controller.mountConsoleRuntime();
    await vi.waitFor(() => expect(options.refreshState).toHaveBeenCalledTimes(1));
    expect(options.consoleBootstrapping.value).toBe(true);

    state.resolve();
    await initialization;
    expect(options.consoleBootstrapping.value).toBe(false);
  });

  it("does not resume initialization side effects after the last mount is removed", async () => {
    const auth = deferred<AuthSnapshot>();
    const { controller, options } = fixture({
      refreshAuthState: vi.fn(() => auth.promise),
    });

    const initialization = controller.mountConsoleRuntime();
    await vi.waitFor(() => expect(options.refreshAuthState).toHaveBeenCalledTimes(1));
    controller.unmountConsoleRuntime();
    auth.resolve(authenticatedSnapshot());
    await initialization;

    expect(options.refreshState).not.toHaveBeenCalled();
    expect(options.startServerEventSubscription).not.toHaveBeenCalled();
    expect(options.consoleBootstrapping.value).toBe(false);
  });

  it("keeps a remount isolated from an older in-flight bootstrap", async () => {
    const firstAuth = deferred<AuthSnapshot>();
    const refreshAuthState = vi.fn()
      .mockImplementationOnce(() => firstAuth.promise)
      .mockResolvedValueOnce(authenticatedSnapshot());
    const { controller, options } = fixture({ refreshAuthState });

    const firstInitialization = controller.mountConsoleRuntime();
    await vi.waitFor(() => expect(refreshAuthState).toHaveBeenCalledTimes(1));
    controller.unmountConsoleRuntime();
    const secondInitialization = controller.mountConsoleRuntime();
    await secondInitialization;

    firstAuth.resolve(authenticatedSnapshot());
    await firstInitialization;

    expect(options.startServerEventSubscription).toHaveBeenCalledTimes(1);
    expect(options.syncDashboardAlertInbox).toHaveBeenCalledTimes(1);
  });

  it("reports bootstrap rejection and never starts the event subscription", async () => {
    const failure = new Error("bootstrap failed");
    const { controller, options } = fixture({
      refreshContextCompiler: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(controller.mountConsoleRuntime()).rejects.toBe(failure);
    await vi.waitFor(() => expect(options.onBootstrapError).toHaveBeenCalledWith(failure));
    expect(options.startServerEventSubscription).not.toHaveBeenCalled();
    expect(options.consoleBootstrapping.value).toBe(false);
  });
});
