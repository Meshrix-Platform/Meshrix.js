import { inject, provide, type InjectionKey } from "vue";
import type { useStorageViewConsole } from "./console-storage-view-controller";

export type StorageViewContext = ReturnType<typeof useStorageViewConsole>;

const storageViewKey: any = Symbol("storage-view") as InjectionKey<StorageViewContext>;

export function provideStorageView(context: StorageViewContext) : any {
  provide(storageViewKey, context);
}

export function useStorageViewContext() : any {
  const context: any = inject(storageViewKey);
  if (!context) {
    throw new Error("Storage view context is not available");
  }
  return context;
}
