import { computed, ref } from "vue";

export function createConsoleBusyController() {
  const busyKeys = ref<Set<string>>(new Set<string>());

  function isBusy(key: string): boolean {
    return busyKeys.value.has(key);
  }

  function isBusyPrefix(prefix: string): boolean {
    return [...busyKeys.value].some((key) => key.startsWith(prefix));
  }

  function setBusy(key: string): void {
    busyKeys.value = new Set([...busyKeys.value, key]);
  }

  function clearBusy(key: string): void {
    const next = new Set(busyKeys.value);
    next.delete(key);
    busyKeys.value = next;
  }

  const busyKey = computed(() => [...busyKeys.value].at(-1) ?? "");

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
