import { inject, provide, type InjectionKey } from "vue";
import type { useMaintenanceAgentViewConsole } from "./console-maintenance-agent-view-controller";

export type MaintenanceAgentViewContext = ReturnType<typeof useMaintenanceAgentViewConsole>;

const maintenanceAgentViewKey: any = Symbol("maintenance-agent-view") as InjectionKey<MaintenanceAgentViewContext>;

export function provideMaintenanceAgentView(context: MaintenanceAgentViewContext) : any {
  provide(maintenanceAgentViewKey, context);
}

export function useMaintenanceAgentViewContext() : any {
  const context: any = inject(maintenanceAgentViewKey);
  if (!context) {
    throw new Error("Maintenance agent view context is not available");
  }
  return context;
}
