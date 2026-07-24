import { inject, provide, type InjectionKey } from "vue";
import type { useOpsMonitorViewConsole } from "./console-ops-monitor-view-controller";

export type OpsMonitorViewContext = ReturnType<typeof useOpsMonitorViewConsole>;

const opsMonitorViewKey = Symbol("ops-monitor-view") as InjectionKey<OpsMonitorViewContext>;

export function provideOpsMonitorView(context: OpsMonitorViewContext) {
  provide(opsMonitorViewKey, context);
}

export function useOpsMonitorViewContext() {
  const context = inject(opsMonitorViewKey);
  if (!context) {
    throw new Error("Ops monitor view context is not available");
  }
  return context;
}
