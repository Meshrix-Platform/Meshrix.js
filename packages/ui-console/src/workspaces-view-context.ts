import { inject, provide, type InjectionKey } from "vue";

const workspacesViewKey = Symbol("workspaces-view") as InjectionKey<unknown>;

export function provideWorkspacesView<T>(context: T) {
  provide(workspacesViewKey, context);
}

export function useWorkspacesViewContext<T>() {
  const context = inject(workspacesViewKey);
  if (!context) {
    throw new Error("Workspaces view context is not available");
  }
  return context as T;
}
