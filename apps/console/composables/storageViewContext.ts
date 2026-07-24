import { inject, provide, type InjectionKey } from "vue";
import type { useStorageViewConsole } from "./console-storage-view-controller";

export type StorageViewContext = ReturnType<typeof useStorageViewConsole>;

const storageViewKey = Symbol("storage-view") as InjectionKey<StorageViewContext>;

export function provideStorageView(context: StorageViewContext) {
  provide(storageViewKey, context);
}

export function useStorageViewContext() {
  const context = inject(storageViewKey);
  if (!context) {
    throw new Error("Storage view context is not available");
  }
  return context;
}
