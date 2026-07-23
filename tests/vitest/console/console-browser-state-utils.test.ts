// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLEAR_LOCAL_STATE_PARAM,
  clearBrowserCacheStorage,
  clearBrowserLocalStateFromUrl,
  clearIndexedDbDatabases,
  unregisterServiceWorkers,
} from "../../../apps/console/composables/console-browser-state-utils";

const originalIndexedDbDescriptor = Object.getOwnPropertyDescriptor(window, "indexedDB");
const originalCachesDescriptor = Object.getOwnPropertyDescriptor(window, "caches");
const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

function defineWindowProperty(name: string, value: unknown) {
  Object.defineProperty(window, name, {
    configurable: true,
    value,
  });
}

function defineNavigatorProperty(name: string, value: unknown) {
  Object.defineProperty(navigator, name, {
    configurable: true,
    value,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalIndexedDbDescriptor) {
    Object.defineProperty(window, "indexedDB", originalIndexedDbDescriptor);
  } else {
    delete (window as Window & { indexedDB?: unknown }).indexedDB;
  }
  if (originalCachesDescriptor) {
    Object.defineProperty(window, "caches", originalCachesDescriptor);
  } else {
    delete (window as Window & { caches?: unknown }).caches;
  }
  if (originalServiceWorkerDescriptor) {
    Object.defineProperty(navigator, "serviceWorker", originalServiceWorkerDescriptor);
  } else {
    delete (navigator as Navigator & { serviceWorker?: unknown }).serviceWorker;
  }
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete (window as Window & { __licoLocalStateClearReport?: unknown }).__licoLocalStateClearReport;
  history.replaceState(null, "", "/");
});

describe("console browser state utils", () => {
  it("clears indexedDB databases and resolves blocked/error delete requests", async () => {
    const deleteDatabase = vi.fn((name: string) => {
      const request: Record<string, (() => void) | null> = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      setTimeout(() => {
        if (name === "blocked") {
          request.onblocked?.();
          return;
        }
        if (name === "error") {
          request.onerror?.();
          return;
        }
        request.onsuccess?.();
      }, 0);
      return request;
    });
    defineWindowProperty("indexedDB", {
      databases: vi.fn(async () => [
        { name: "main" },
        { name: "" },
        { name: "blocked" },
        { name: "error" },
      ]),
      deleteDatabase,
    });

    await expect(clearIndexedDbDatabases()).resolves.toEqual(["main", "blocked", "error"]);
    expect(deleteDatabase).toHaveBeenCalledTimes(3);
    expect(deleteDatabase).toHaveBeenCalledWith("main");
    expect(deleteDatabase).toHaveBeenCalledWith("blocked");
    expect(deleteDatabase).toHaveBeenCalledWith("error");
  });

  it("handles missing browser storage APIs", async () => {
    defineWindowProperty("indexedDB", {});
    delete (window as Window & { caches?: unknown }).caches;
    delete (navigator as Navigator & { serviceWorker?: unknown }).serviceWorker;

    await expect(clearIndexedDbDatabases()).resolves.toEqual([]);
    await expect(clearBrowserCacheStorage()).resolves.toEqual([]);
    await expect(unregisterServiceWorkers()).resolves.toBe(0);
  });

  it("clears cache storage and unregisters service workers", async () => {
    const deleteCache = vi.fn(async () => true);
    defineWindowProperty("caches", {
      keys: vi.fn(async () => ["assets", "api"]),
      delete: deleteCache,
    });
    const unregisterA = vi.fn(async () => true);
    const unregisterB = vi.fn(async () => false);
    defineNavigatorProperty("serviceWorker", {
      getRegistrations: vi.fn(async () => [
        { unregister: unregisterA },
        { unregister: unregisterB },
      ]),
    });

    await expect(clearBrowserCacheStorage()).resolves.toEqual(["assets", "api"]);
    expect(deleteCache).toHaveBeenCalledWith("assets");
    expect(deleteCache).toHaveBeenCalledWith("api");
    await expect(unregisterServiceWorkers()).resolves.toBe(2);
    expect(unregisterA).toHaveBeenCalled();
    expect(unregisterB).toHaveBeenCalled();
  });

  it("ignores URLs without the clear-local-state flag", async () => {
    history.replaceState(null, "", "/console?x=1#dashboard");
    const clearMemoryCaches = vi.fn();

    await expect(clearBrowserLocalStateFromUrl({ clearMemoryCaches })).resolves.toBe(false);

    expect(clearMemoryCaches).not.toHaveBeenCalled();
    expect((window as Window & { __licoLocalStateClearReport?: unknown }).__licoLocalStateClearReport).toBeUndefined();
  });

  it("clears browser local state from URL and records a report", async () => {
    history.replaceState(null, "", `/console?x=1&${CLEAR_LOCAL_STATE_PARAM}=1#dashboard`);
    window.localStorage.setItem("alpha", "1");
    window.sessionStorage.setItem("beta", "2");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const clearMemoryCaches = vi.fn();
    defineWindowProperty("indexedDB", {
      databases: vi.fn(async () => [{ name: "db-a" }]),
      deleteDatabase: vi.fn(() => {
        const request: Record<string, (() => void) | null> = { onsuccess: null, onerror: null, onblocked: null };
        setTimeout(() => request.onsuccess?.(), 0);
        return request;
      }),
    });
    defineWindowProperty("caches", {
      keys: vi.fn(async () => ["cache-a"]),
      delete: vi.fn(async () => true),
    });
    defineNavigatorProperty("serviceWorker", {
      getRegistrations: vi.fn(async () => [{ unregister: vi.fn(async () => true) }]),
    });

    await expect(clearBrowserLocalStateFromUrl({ clearMemoryCaches })).resolves.toBe(true);

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(clearMemoryCaches).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/console?x=1#dashboard");
    const report = (window as Window & { __licoLocalStateClearReport?: Record<string, unknown> }).__licoLocalStateClearReport;
    expect(report).toMatchObject({
      localStorageKeys: ["alpha"],
      sessionStorageKeys: ["beta"],
      indexedDbNames: ["db-a"],
      cacheNames: ["cache-a"],
      serviceWorkers: 1,
    });
    expect(report?.clearedAt).toEqual(expect.any(String));
  });

  it("records cleanup errors but still clears local and session storage", async () => {
    history.replaceState(null, "", "/console?custom=1");
    window.localStorage.setItem("alpha", "1");
    window.sessionStorage.setItem("beta", "2");
    defineWindowProperty("indexedDB", {
      databases: vi.fn(async () => {
        throw new Error("indexed db failed");
      }),
    });
    defineWindowProperty("caches", {
      keys: vi.fn(async () => {
        throw "cache failed";
      }),
    });
    defineNavigatorProperty("serviceWorker", {
      getRegistrations: vi.fn(async () => {
        throw new Error("sw failed");
      }),
    });

    await expect(clearBrowserLocalStateFromUrl({ param: "custom" })).resolves.toBe(true);

    const report = (window as Window & { __licoLocalStateClearReport?: Record<string, unknown> }).__licoLocalStateClearReport;
    expect(report).toMatchObject({
      indexedDbError: "indexed db failed",
      cacheStorageError: "cache failed",
      serviceWorkerError: "sw failed",
    });
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
