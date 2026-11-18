import { inject, provide, type InjectionKey } from "vue";
import type { useModulesViewConsole } from "./console-modules-view-controller";

export type ModulesViewContext = ReturnType<typeof useModulesViewConsole>;

const modulesViewKey: any = Symbol("modules-view") as InjectionKey<ModulesViewContext>;

export function provideModulesView(context: ModulesViewContext) : any {
  provide(modulesViewKey, context);
}

export function useModulesViewContext() : any {
  const context: any = inject(modulesViewKey);
  if (!context) {
    throw new Error("Modules view context is not available");
  }
  return context;
}
