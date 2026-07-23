import {
  isStorageRecord,
  readBrowserJsonStorage,
  writeBrowserJsonStorage,
} from "./browser-storage";
import { browserWindow } from "./browser-window";

export type StoredServerAddresses = {
  activeUrl: string;
  addresses: string[];
};

export const SERVER_ADDRESS_STORAGE_KEY = "v0.0.1:frontend:console-server-addresses-1";
export const SERVER_ADDRESS_STORAGE_EVENT = "lico:console-server-addresses-updated";

export const DEFAULT_SERVER_ADDRESS_STORAGE: StoredServerAddresses = {
  activeUrl: "",
  addresses: [],
};

let memoryServerAddresses: StoredServerAddresses = DEFAULT_SERVER_ADDRESS_STORAGE;

function hasBrowserLocalStorage() {
  try {
    return Boolean(browserWindow()?.localStorage);
  } catch {
    return false;
  }
}

export function normalizeServerAddressUrl(value: string | undefined) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  try {
    const url = new URL(rawValue);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function uniqueServerAddressStrings(addresses: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const address of addresses) {
    const normalized = normalizeServerAddressUrl(address) || address.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

export function normalizeStoredServerAddresses(value: unknown): StoredServerAddresses | null {
  if (!isStorageRecord(value)) {
    return null;
  }

  const addresses = Array.isArray(value.addresses)
    ? value.addresses.map((item) => String(item || "").trim()).filter(Boolean)
    : [];

  return {
    activeUrl: String(value.activeUrl || "").trim(),
    addresses: uniqueServerAddressStrings(addresses),
  };
}

export function readStoredServerAddresses() {
  if (!hasBrowserLocalStorage()) {
    return memoryServerAddresses;
  }

  return readBrowserJsonStorage<StoredServerAddresses>(
    SERVER_ADDRESS_STORAGE_KEY,
    memoryServerAddresses,
    normalizeStoredServerAddresses,
  );
}

export function writeStoredServerAddresses(value: StoredServerAddresses) {
  memoryServerAddresses = {
    activeUrl: normalizeServerAddressUrl(value.activeUrl),
    addresses: uniqueServerAddressStrings(value.addresses),
  };
  const saved = hasBrowserLocalStorage()
    ? writeBrowserJsonStorage(SERVER_ADDRESS_STORAGE_KEY, memoryServerAddresses)
    : false;
  browserWindow()?.dispatchEvent(new CustomEvent(SERVER_ADDRESS_STORAGE_EVENT));
  return saved;
}

export async function probeServerAddressUrl(value: string, timeoutMs = 5_000) {
  const nextUrl = normalizeServerAddressUrl(value);
  if (!nextUrl) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = new URL("/api/bootstrap", nextUrl).toString();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      mode: "cors",
      credentials: "omit",
      signal: controller.signal,
    });

    if (!response.ok) {
      return false;
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return false;
    }
    const payload = await response.json().catch(() => null);
    return isStorageRecord(payload);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
