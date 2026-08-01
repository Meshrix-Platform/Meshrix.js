import {
  readBrowserLocalStorageItem,
  writeBrowserLocalStorageItem,
} from "./browser-window";

export type BrowserStorageLike = Pick<Storage, "getItem" | "setItem">;

export function isStorageRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readStorageItem(key: string, storage?: BrowserStorageLike) : any {
  return storage ? storage.getItem(key) : readBrowserLocalStorageItem(key);
}

function writeStorageItem(key: string, value: string, storage?: BrowserStorageLike) : any {
  if (!storage) {
    return writeBrowserLocalStorageItem(key, value);
  }
  storage.setItem(key, value);
  return true;
}

export function readBrowserJsonStorage<T>(
  key: string,
  fallbackValue: T,
  normalize: (value: unknown) => T | null | undefined,
  storage?: BrowserStorageLike,
) : any {
  const rawValue: any = readStorageItem(key, storage);
  if (!rawValue) {
    return fallbackValue;
  }
  try {
    return normalize(JSON.parse(rawValue)) ?? fallbackValue;
  } catch {
    return fallbackValue;
  }
}

export function readBrowserJsonRecord(key: string) : any {
  return readBrowserJsonStorage<Record<string, unknown>>(
    key,
    {},
    (value?: any) : any => (isStorageRecord(value) ? value : null),
  );
}

export function writeBrowserJsonStorage(key: string, value: unknown, storage?: BrowserStorageLike) : any {
  try {
    return writeStorageItem(key, JSON.stringify(value), storage);
  } catch {
    return false;
  }
}
