import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { createConsoleRuntimeLifecycleController } from "../../../apps/console/composables/console-runtime-lifecycle-controller";

type AuthSnapshot = {
  bootstrap: { required: boolean };
  session: { authenticated: boolean };
};

function deferred<T>() : any {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise: any = new Promise<T>((nextResolve?: any, nextReject?: any) : any => {
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

function fixture(overrides: Partial<Parameters<typeof createConsoleRuntimeLifecycleController>[0]> = {}) : any {
  const options: Record<string, any> = {
    consoleBootstrapping: ref(false),
    clearBrowserLocalStateFromUrl: vi.fn(async () : Promise<any> => undefined),
    clearConfigTargetHighlight: vi.fn(),
    clearPendingRefreshState: vi.fn(),
    liveDashboardAlerts: { value: [] },
    onBootstrapError: vi.fn(),
    refreshAuthState: vi.fn(async () : Promise<any> => authenticatedSnapshot()),
    refreshMonitorAlerts: vi.fn(async () : Promise<any> => undefined),
    refreshState: vi.fn(async () : Promise<any> => undefined),
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

describe("console runtime lifecycle", () : any => {
  it("keeps route access gated until authenticated console state is loaded", async () : Promise<any> => {
    const state: any = deferred<void>();
    const { controller, options } = fixture({
      refreshState: vi.fn(() : any => state.promise),
    });

    const initialization: any = controller.mountConsoleRuntime();
    await vi.waitFor(() : any => expect(options.refreshState).toHaveBeenCalledTimes(1));
    expect(options.consoleBootstrapping.value).toBe(true);

    state.resolve();
    await initialization;
    expect(options.consoleBootstrapping.value).toBe(false);
  });

  it("does not resume initialization side effects after the last mount is removed", async () : Promise<any> => {
    const auth: any = deferred<AuthSnapshot>();
    const { controller, options } = fixture({
      refreshAuthState: vi.fn(() : any => auth.promise),
    });

    const initialization: any = controller.mountConsoleRuntime();
    await vi.waitFor(() : any => expect(options.refreshAuthState).toHaveBeenCalledTimes(1));
    controller.unmountConsoleRuntime();
    auth.resolve(authenticatedSnapshot());
    await initialization;

    expect(options.refreshState).not.toHaveBeenCalled();
    expect(options.startServerEventSubscription).not.toHaveBeenCalled();
    expect(options.consoleBootstrapping.value).toBe(false);
  });

  it("keeps a remount isolated from an older in-flight bootstrap", async () : Promise<any> => {
    const firstAuth: any = deferred<AuthSnapshot>();
    const refreshAuthState: any = vi.fn()
      .mockImplementationOnce(() : any => firstAuth.promise)
      .mockResolvedValueOnce(authenticatedSnapshot());
    const { controller, options } = fixture({ refreshAuthState });

    const firstInitialization: any = controller.mountConsoleRuntime();
    await vi.waitFor(() : any => expect(refreshAuthState).toHaveBeenCalledTimes(1));
    controller.unmountConsoleRuntime();
    const secondInitialization: any = controller.mountConsoleRuntime();
    await secondInitialization;

    firstAuth.resolve(authenticatedSnapshot());
    await firstInitialization;

    expect(options.startServerEventSubscription).toHaveBeenCalledTimes(1);
    expect(options.syncDashboardAlertInbox).toHaveBeenCalledTimes(1);
  });

  it("reports bootstrap rejection and never starts the event subscription", async () : Promise<any> => {
    const failure: any = new Error("bootstrap failed");
    const { controller, options } = fixture({
      refreshAuthState: vi.fn(async () : Promise<any> => {
        throw failure;
      }),
    });

    await expect(controller.mountConsoleRuntime()).rejects.toBe(failure);
    await vi.waitFor(() : any => expect(options.onBootstrapError).toHaveBeenCalledWith(failure));
    expect(options.startServerEventSubscription).not.toHaveBeenCalled();
    expect(options.consoleBootstrapping.value).toBe(false);
  });
});
