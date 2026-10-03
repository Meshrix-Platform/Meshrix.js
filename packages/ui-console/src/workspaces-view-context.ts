import { inject, provide, type InjectionKey } from "vue";

const workspacesViewKey: InjectionKey<unknown> = Symbol("workspaces-view");

export function provideWorkspacesView<T>(context: T): void {
  provide(workspacesViewKey, context);
}

export function useWorkspacesViewContext<T = any>(): T {
  const context = inject(workspacesViewKey);
  if (context === undefined) {
    throw new Error("Workspaces view context is not available");
  }
  return context as T;
}
