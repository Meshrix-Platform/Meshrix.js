import { browserWindow } from "@meshrix/ui-console/browser-window";

export const CLEAR_LOCAL_STATE_PARAM: any = "clearLocalState";

export async function clearIndexedDbDatabases() : Promise<any> {
  const browser: any = browserWindow();
  if (!browser || !("indexedDB" in browser) || typeof browser.indexedDB.databases !== "function") {
    return [];
  }
  const databases: any = await browser.indexedDB.databases();
  const names: any = databases
    .map((database?: any) : any => String(database.name || "").trim())
    .filter(Boolean);
  await Promise.all(
    names.map(
      (name?: any) : any =>
        new Promise<void>((resolve?: any) : any => {
          const request: any = browser.indexedDB.deleteDatabase(name);
          request.onsuccess = () : any => resolve();
          request.onerror = () : any => resolve();
          request.onblocked = () : any => resolve();
        }),
    ),
  );
  return names;
}

export async function clearBrowserCacheStorage() : Promise<any> {
  const browser: any = browserWindow();
  if (!browser || !("caches" in browser)) {
    return [];
  }
  const names: any = await browser.caches.keys();
  await Promise.all(names.map((name?: any) : any => browser.caches.delete(name)));
  return names;
}

export async function unregisterServiceWorkers() : Promise<any> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return 0;
  }
  const registrations: any = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration?: any) : any => registration.unregister()));
  return registrations.length;
}

export async function clearBrowserLocalStateFromUrl(
  options: {
    clearMemoryCaches?: () => void;
    param?: string;
  } = {},
) : Promise<any> {
  const browser: any = browserWindow();
  if (!browser) {
    return false;
  }
  const param: any = options.param || CLEAR_LOCAL_STATE_PARAM;
  const url: any = new URL(browser.location.href);
  if (url.searchParams.get(param) !== "1") {
    return false;
  }
  const report: Record<string, unknown> = {
    localStorageKeys: Object.keys(browser.localStorage || {}),
    sessionStorageKeys: Object.keys(browser.sessionStorage || {}),
    clearedAt: new Date().toISOString(),
  };
  try {
    report.indexedDbNames = await clearIndexedDbDatabases();
  } catch (nextError: any) {
    report.indexedDbError = nextError instanceof Error ? nextError.message : String(nextError);
  }
  try {
    report.cacheNames = await clearBrowserCacheStorage();
  } catch (nextError: any) {
    report.cacheStorageError = nextError instanceof Error ? nextError.message : String(nextError);
  }
  try {
    report.serviceWorkers = await unregisterServiceWorkers();
  } catch (nextError: any) {
    report.serviceWorkerError = nextError instanceof Error ? nextError.message : String(nextError);
  }
  browser.localStorage.clear();
  browser.sessionStorage.clear();
  options.clearMemoryCaches?.();
  url.searchParams.delete(param);
  browser.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  (browser as Window & { __meshrixLocalStateClearReport?: Record<string, unknown> }).__meshrixLocalStateClearReport = report;
  return true;
}
