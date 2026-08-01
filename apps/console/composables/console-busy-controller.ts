import { computed, ref } from "vue";

export function createConsoleBusyController() : any {
  const busyKeys: any = ref<Set<string>>(new Set<string>());

  function isBusy(key: string): boolean {
    return busyKeys.value.has(key);
  }

  function isBusyPrefix(prefix: string): boolean {
    return [...busyKeys.value].some((key?: any) : any => key.startsWith(prefix));
  }

  function setBusy(key: string): void {
    busyKeys.value = new Set<any>([...busyKeys.value, key]);
  }

  function clearBusy(key: string): void {
    const next: any = new Set<any>(busyKeys.value);
    next.delete(key);
    busyKeys.value = next;
  }

  const busyKey: any = computed(() : any => [...busyKeys.value].at(-1) ?? "");

  function clearAllBusy(): void {
    busyKeys.value = new Set<string>();
  }

  return {
    busyKey,
    clearAllBusy,
    clearBusy,
    isBusy,
    isBusyPrefix,
    setBusy,
  };
}
