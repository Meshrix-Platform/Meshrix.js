import { inject, provide, type InjectionKey } from "vue";
import type { useMaintenanceAgentViewConsole } from "./console-maintenance-agent-view-controller";

export type MaintenanceAgentViewContext = ReturnType<typeof useMaintenanceAgentViewConsole>;

const maintenanceAgentViewKey = Symbol("maintenance-agent-view") as InjectionKey<MaintenanceAgentViewContext>;

export function provideMaintenanceAgentView(context: MaintenanceAgentViewContext) {
  provide(maintenanceAgentViewKey, context);
}

export function useMaintenanceAgentViewContext() {
  const context = inject(maintenanceAgentViewKey);
  if (!context) {
    throw new Error("Maintenance agent view context is not available");
  }
  return context;
}
