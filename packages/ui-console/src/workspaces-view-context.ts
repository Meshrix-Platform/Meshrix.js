import { inject, provide, type InjectionKey } from "vue";

const workspacesViewKey: any = Symbol("workspaces-view") as InjectionKey<unknown>;

export function provideWorkspacesView<T>(context: T) : any {
  provide(workspacesViewKey, context);
}

export function useWorkspacesViewContext<T>() : any {
  const context: any = inject(workspacesViewKey);
  if (!context) {
    throw new Error("Workspaces view context is not available");
  }
  return context as T;
}
