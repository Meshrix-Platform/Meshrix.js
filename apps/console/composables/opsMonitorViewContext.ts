import { inject, provide, type InjectionKey } from "vue";
import type { useOpsMonitorViewConsole } from "./console-ops-monitor-view-controller";

export type OpsMonitorViewContext = ReturnType<typeof useOpsMonitorViewConsole>;

const opsMonitorViewKey: any = Symbol("ops-monitor-view") as InjectionKey<OpsMonitorViewContext>;

export function provideOpsMonitorView(context: OpsMonitorViewContext) : any {
  provide(opsMonitorViewKey, context);
}

export function useOpsMonitorViewContext() : any {
  const context: any = inject(opsMonitorViewKey);
  if (!context) {
    throw new Error("Ops monitor view context is not available");
  }
  return context;
}
