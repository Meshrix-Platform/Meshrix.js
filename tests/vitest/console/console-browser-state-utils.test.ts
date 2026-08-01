// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLEAR_LOCAL_STATE_PARAM,
  clearBrowserCacheStorage,
  clearBrowserLocalStateFromUrl,
  clearIndexedDbDatabases,
  unregisterServiceWorkers,
} from "../../../apps/console/composables/console-browser-state-utils";

const originalIndexedDbDescriptor: any = Object.getOwnPropertyDescriptor(window, "indexedDB");
const originalCachesDescriptor: any = Object.getOwnPropertyDescriptor(window, "caches");
const originalServiceWorkerDescriptor: any = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

function defineWindowProperty(name: string, value: unknown) : any {
  Object.defineProperty(window, name, {
    configurable: true,
    value,
  });
}

function defineNavigatorProperty(name: string, value: unknown) : any {
  Object.defineProperty(navigator, name, {
    configurable: true,
    value,
  });
}

afterEach(() : any => {
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
  delete (window as Window & { __meshrixLocalStateClearReport?: unknown }).__meshrixLocalStateClearReport;
  history.replaceState(null, "", "/");
});

describe("console browser state utils", () : any => {
  it("clears indexedDB databases and resolves blocked/error delete requests", async () : Promise<any> => {
    const deleteDatabase: any = vi.fn((name: string) : any => {
      const request: Record<string, (() => void) | null> = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      setTimeout(() : any => {
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
      databases: vi.fn(async () : Promise<any> => [
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

  it("handles missing browser storage APIs", async () : Promise<any> => {
    defineWindowProperty("indexedDB", {});
    delete (window as Window & { caches?: unknown }).caches;
    delete (navigator as Navigator & { serviceWorker?: unknown }).serviceWorker;

    await expect(clearIndexedDbDatabases()).resolves.toEqual([]);
    await expect(clearBrowserCacheStorage()).resolves.toEqual([]);
    await expect(unregisterServiceWorkers()).resolves.toBe(0);
  });

  it("clears cache storage and unregisters service workers", async () : Promise<any> => {
    const deleteCache: any = vi.fn(async () : Promise<any> => true);
    defineWindowProperty("caches", {
      keys: vi.fn(async () : Promise<any> => ["assets", "api"]),
      delete: deleteCache,
    });
    const unregisterA: any = vi.fn(async () : Promise<any> => true);
    const unregisterB: any = vi.fn(async () : Promise<any> => false);
    defineNavigatorProperty("serviceWorker", {
      getRegistrations: vi.fn(async () : Promise<any> => [
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

  it("ignores URLs without the clear-local-state flag", async () : Promise<any> => {
    history.replaceState(null, "", "/console?x=1#dashboard");
    const clearMemoryCaches: any = vi.fn();

    await expect(clearBrowserLocalStateFromUrl({ clearMemoryCaches })).resolves.toBe(false);

    expect(clearMemoryCaches).not.toHaveBeenCalled();
    expect((window as Window & { __meshrixLocalStateClearReport?: unknown }).__meshrixLocalStateClearReport).toBeUndefined();
  });

  it("clears browser local state from URL and records a report", async () : Promise<any> => {
    history.replaceState(null, "", `/console?x=1&${CLEAR_LOCAL_STATE_PARAM}=1#dashboard`);
    window.localStorage.setItem("alpha", "1");
    window.sessionStorage.setItem("beta", "2");
    const replaceState: any = vi.spyOn(window.history, "replaceState");
    const clearMemoryCaches: any = vi.fn();
    defineWindowProperty("indexedDB", {
      databases: vi.fn(async () : Promise<any> => [{ name: "db-a" }]),
      deleteDatabase: vi.fn(() : any => {
        const request: Record<string, (() => void) | null> = { onsuccess: null, onerror: null, onblocked: null };
        setTimeout(() : any => request.onsuccess?.(), 0);
        return request;
      }),
    });
    defineWindowProperty("caches", {
      keys: vi.fn(async () : Promise<any> => ["cache-a"]),
      delete: vi.fn(async () : Promise<any> => true),
    });
    defineNavigatorProperty("serviceWorker", {
      getRegistrations: vi.fn(async () : Promise<any> => [{ unregister: vi.fn(async () : Promise<any> => true) }]),
    });

    await expect(clearBrowserLocalStateFromUrl({ clearMemoryCaches })).resolves.toBe(true);

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(clearMemoryCaches).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/console?x=1#dashboard");
    const report: any = (window as Window & { __meshrixLocalStateClearReport?: Record<string, unknown> }).__meshrixLocalStateClearReport;
    expect(report).toMatchObject({
      localStorageKeys: ["alpha"],
      sessionStorageKeys: ["beta"],
      indexedDbNames: ["db-a"],
      cacheNames: ["cache-a"],
      serviceWorkers: 1,
    });
    expect(report?.clearedAt).toEqual(expect.any(String));
  });

  it("records cleanup errors but still clears local and session storage", async () : Promise<any> => {
    history.replaceState(null, "", "/console?custom=1");
    window.localStorage.setItem("alpha", "1");
    window.sessionStorage.setItem("beta", "2");
    defineWindowProperty("indexedDB", {
      databases: vi.fn(async () : Promise<any> => {
        throw new Error("indexed db failed");
      }),
    });
    defineWindowProperty("caches", {
      keys: vi.fn(async () : Promise<any> => {
        throw "cache failed";
      }),
    });
    defineNavigatorProperty("serviceWorker", {
      getRegistrations: vi.fn(async () : Promise<any> => {
        throw new Error("sw failed");
      }),
    });

    await expect(clearBrowserLocalStateFromUrl({ param: "custom" })).resolves.toBe(true);

    const report: any = (window as Window & { __meshrixLocalStateClearReport?: Record<string, unknown> }).__meshrixLocalStateClearReport;
    expect(report).toMatchObject({
      indexedDbError: "indexed db failed",
      cacheStorageError: "cache failed",
      serviceWorkerError: "sw failed",
    });
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
