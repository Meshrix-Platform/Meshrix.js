import type { Ref } from "vue";
import type { DashboardAlert, RefreshStateOptions } from "../types/app";

type SilentRefreshOptions = {
  silent?: boolean;
};

type ConsoleAuthSessionSnapshot = {
  bootstrap: {
    required: boolean;
  };
  session: {
    authenticated: boolean;
  };
};

type ConsoleRuntimeLifecycleControllerOptions = {
  consoleBootstrapping: Ref<boolean>;
  clearBrowserLocalStateFromUrl: () => Promise<unknown>;
  clearConfigTargetHighlight: () => void;
  clearPendingRefreshState: () => void;
  liveDashboardAlerts: { readonly value: DashboardAlert[] };
  onBootstrapError?: (error: unknown) => void;
  refreshAuthState: () => Promise<ConsoleAuthSessionSnapshot | null | undefined>;
  refreshContextCompiler: (options?: SilentRefreshOptions) => void | Promise<void>;
  refreshMonitorAlerts: (options?: SilentRefreshOptions) => void | Promise<void>;
  refreshState: (options?: RefreshStateOptions) => void | Promise<void>;
  startServerEventSubscription: () => void;
  stopServerEventSubscription: () => void;
  syncDashboardAlertInbox: (items: DashboardAlert[]) => void;
};

export function createConsoleRuntimeLifecycleController(options: ConsoleRuntimeLifecycleControllerOptions) : any {
  let consoleLifecycleRefCount: any = 0;
  let consoleLifecycleInitInProgress: Promise<void> | null = null;
  let consoleLifecycleInitialized: any = false;
  let consoleLifecycleGeneration: any = 0;

  function isGenerationActive(generation: number) : any {
    return consoleLifecycleRefCount > 0 && generation === consoleLifecycleGeneration;
  }

  async function bootstrapConsoleRuntime(generation: any = consoleLifecycleGeneration) : Promise<any> {
    await options.clearBrowserLocalStateFromUrl();
    if (!isGenerationActive(generation)) return;
    options.consoleBootstrapping.value = true;
    try {
      const session: any = await options.refreshAuthState();
      if (!isGenerationActive(generation)) return;
      if (!session?.bootstrap.required && session?.session.authenticated) {
        await options.refreshState({ silent: true });
        if (!isGenerationActive(generation)) return;
        await options.refreshMonitorAlerts({ silent: true });
        if (!isGenerationActive(generation)) return;
        await options.refreshContextCompiler({ silent: true });
        if (!isGenerationActive(generation)) return;
        options.startServerEventSubscription();
        options.syncDashboardAlertInbox(options.liveDashboardAlerts.value);
      }
    } finally {
      if (isGenerationActive(generation)) {
        options.consoleBootstrapping.value = false;
      }
    }
  }

  function ensureConsoleRuntimeInitialized() : any {
    if (consoleLifecycleInitialized) {
      return Promise.resolve();
    }
    if (consoleLifecycleInitInProgress) {
      return consoleLifecycleInitInProgress;
    }
    const generation: any = consoleLifecycleGeneration;
    const initialization: any = (async () : Promise<any> => {
      try {
        await bootstrapConsoleRuntime(generation);
        if (isGenerationActive(generation)) {
          consoleLifecycleInitialized = true;
        }
      } catch (nextError: any) {
        if (isGenerationActive(generation)) {
          consoleLifecycleInitialized = false;
        }
        throw nextError;
      } finally {
        if (generation === consoleLifecycleGeneration) {
          consoleLifecycleInitInProgress = null;
        }
      }
    })();
    consoleLifecycleInitInProgress = initialization;
    void initialization.catch((nextError?: any) : any => {
      if (isGenerationActive(generation)) {
        options.onBootstrapError?.(nextError);
      }
    });
    return initialization;
  }

  function cleanupConsoleRuntime() : any {
    consoleLifecycleGeneration += 1;
    options.clearPendingRefreshState();
    options.clearConfigTargetHighlight();
    options.stopServerEventSubscription();
    options.consoleBootstrapping.value = false;
    consoleLifecycleInitialized = false;
    consoleLifecycleInitInProgress = null;
  }

  function mountConsoleRuntime() : any {
    consoleLifecycleRefCount += 1;
    return ensureConsoleRuntimeInitialized();
  }

  function unmountConsoleRuntime() : any {
    if (consoleLifecycleRefCount > 0) {
      consoleLifecycleRefCount -= 1;
    }
    if (consoleLifecycleRefCount > 0) {
      return;
    }
    cleanupConsoleRuntime();
  }

  return {
    bootstrapConsoleRuntime,
    cleanupConsoleRuntime,
    ensureConsoleRuntimeInitialized,
    mountConsoleRuntime,
    unmountConsoleRuntime,
  };
}
