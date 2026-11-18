import {
  isStorageRecord,
  readBrowserJsonStorage,
  writeBrowserJsonStorage,
} from "./browser-storage";
import { browserWindow } from "@meshrix/ui-console/browser-window";

export type StoredServerAddresses = {
  activeUrl: string;
  addresses: string[];
};

export const SERVER_ADDRESS_STORAGE_KEY: any = "v0.0.1:frontend:console-server-addresses-1";
export const SERVER_ADDRESS_STORAGE_EVENT: any = "meshrix:console-server-addresses-updated";

export const DEFAULT_SERVER_ADDRESS_STORAGE: StoredServerAddresses = {
  activeUrl: "",
  addresses: [],
};

let memoryServerAddresses: StoredServerAddresses = DEFAULT_SERVER_ADDRESS_STORAGE;

function hasBrowserLocalStorage() : any {
  try {
    return Boolean(browserWindow()?.localStorage);
  } catch {
    return false;
  }
}

export function normalizeServerAddressUrl(value: string | undefined) : any {
  const rawValue: any = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  try {
    const url: any = new URL(rawValue);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }
    // Credential-bearing URLs are never normalized, stored, probed or shown.
    if (url.username || url.password) {
      return "";
    }
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function uniqueServerAddressStrings(addresses: string[]) : any {
  const seen: any = new Set<string>();
  const result: string[] = [];

  for (const address of addresses) {
    // Anything that does not normalize to a credentialless http(s) URL is
    // dropped rather than persisted or displayed raw.
    const normalized: any = normalizeServerAddressUrl(address);
    const key: any = normalized.toLowerCase();
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

  const addresses: any = Array.isArray(value.addresses)
    ? value.addresses.map((item?: any) : any => String(item || "").trim()).filter(Boolean)
    : [];

  return {
    activeUrl: normalizeServerAddressUrl(String(value.activeUrl || "")),
    addresses: uniqueServerAddressStrings(addresses),
  };
}

export function readStoredServerAddresses() : any {
  if (!hasBrowserLocalStorage()) {
    return memoryServerAddresses;
  }

  return readBrowserJsonStorage<StoredServerAddresses>(
    SERVER_ADDRESS_STORAGE_KEY,
    memoryServerAddresses,
    normalizeStoredServerAddresses,
  );
}

export function writeStoredServerAddresses(value: StoredServerAddresses) : any {
  memoryServerAddresses = {
    activeUrl: normalizeServerAddressUrl(value.activeUrl),
    addresses: uniqueServerAddressStrings(value.addresses),
  };
  const saved: any = hasBrowserLocalStorage()
    ? writeBrowserJsonStorage(SERVER_ADDRESS_STORAGE_KEY, memoryServerAddresses)
    : false;
  browserWindow()?.dispatchEvent(new CustomEvent(SERVER_ADDRESS_STORAGE_EVENT));
  return saved;
}

export async function probeServerAddressUrl(value: string) : Promise<any> {
  const nextUrl: any = normalizeServerAddressUrl(value);
  if (!nextUrl) {
    return false;
  }

  const url: any = new URL("/api/bootstrap", nextUrl).toString();
  try {
    const response: any = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      mode: "cors",
      credentials: "omit",
    });

    if (!response.ok) {
      return false;
    }
    const contentType: any = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return false;
    }
    const payload: any = await response.json().catch(() : any => null);
    return isStorageRecord(payload);
  } catch {
    return false;
  }
}
