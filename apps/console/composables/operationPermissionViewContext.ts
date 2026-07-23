import { inject, provide, type InjectionKey } from "vue";
import type { useOperationPermissionViewConsole } from "./console-operation-permission-view-controller";

export type OperationPermissionViewContext = ReturnType<typeof useOperationPermissionViewConsole>;

const operationPermissionViewKey = Symbol("operation-permission-view") as InjectionKey<OperationPermissionViewContext>;

export function provideOperationPermissionView(context: OperationPermissionViewContext) {
  provide(operationPermissionViewKey, context);
}

export function useOperationPermissionViewContext() {
  const context = inject(operationPermissionViewKey);
  if (!context) {
    throw new Error("Operation Permission view context is not available");
  }
  return context;
}
