import { computed, ref, type ComputedRef, type Ref } from "vue";

/**
 * Read side of busy tracking.
 *
 * Consumers ask about the exact operation they render, so a slow operation can
 * never mask, disable, or re-enable an unrelated one.
 */
export type ConsoleBusyReader = {
  /** True while any tracked operation runs. Only for global shell indicators. */
  isAnyBusy: ComputedRef<boolean>;
  /** True while this exact operation runs. */
  isBusy: (key: string) => boolean;
  /** True while any operation in this namespace runs, for example `ws:`. */
  isBusyPrefix: (prefix: string) => boolean;
};

export type ConsoleBusyController = ConsoleBusyReader & {
  /** Marks one operation as started. Repeated calls for one key are idempotent. */
  setBusy: (key: string) => void;
  /** Marks one operation as finished. Never clears another operation. */
  clearBusy: (key: string) => void;
  /** Holds one busy key for exactly the duration of one attempt. */
  withBusy: <T>(key: string, run: () => Promise<T>) => Promise<T>;
};

/**
 * Tracks which named operations are currently in flight.
 *
 * There is deliberately no "current busy key" and no "clear every key":
 * a single current key collapses independent operations into one identity, and
 * clearing every key lets a finishing request re-enable a control whose own
 * request is still running. For governed operations that re-enable is a
 * double-submit hazard, so both escape hatches are intentionally absent.
 */
export function createConsoleBusyController(): ConsoleBusyController {
  const busyKeys: Ref<Set<string>> = ref(new Set<string>());

  function isBusy(key: string): boolean {
    return busyKeys.value.has(key);
  }

  function isBusyPrefix(prefix: string): boolean {
    for (const key of busyKeys.value) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  function setBusy(key: string): void {
    if (!key || busyKeys.value.has(key)) {
      return;
    }
    busyKeys.value = new Set<string>([...busyKeys.value, key]);
  }

  function clearBusy(key: string): void {
    if (!busyKeys.value.has(key)) {
      return;
    }
    const next: Set<string> = new Set<string>(busyKeys.value);
    next.delete(key);
    busyKeys.value = next;
  }

  async function withBusy<T>(key: string, run: () => Promise<T>): Promise<T> {
    setBusy(key);
    try {
      return await run();
    } finally {
      clearBusy(key);
    }
  }

  return {
    clearBusy,
    isAnyBusy: computed(() => busyKeys.value.size > 0),
    isBusy,
    isBusyPrefix,
    setBusy,
    withBusy,
  };
}

/**
 * Combines several busy readers into one read-only view.
 *
 * Used where a feature owns local operations but must also reflect operations
 * owned by the surrounding shell.
 */
export function mergeConsoleBusyReaders(
  ...readers: readonly ConsoleBusyReader[]
): ConsoleBusyReader {
  return {
    isAnyBusy: computed(() => readers.some((reader) => reader.isAnyBusy.value)),
    isBusy: (key: string) => readers.some((reader) => reader.isBusy(key)),
    isBusyPrefix: (prefix: string) => readers.some((reader) => reader.isBusyPrefix(prefix)),
  };
}
