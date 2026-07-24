import { browserWindow } from "../lib/browser-window";

export const CLEAR_LOCAL_STATE_PARAM = "clearLocalState";

export async function clearIndexedDbDatabases() {
  const browser = browserWindow();
  if (!browser || !("indexedDB" in browser) || typeof browser.indexedDB.databases !== "function") {
    return [];
  }
  const databases = await browser.indexedDB.databases();
  const names = databases
    .map((database) => String(database.name || "").trim())
    .filter(Boolean);
  await Promise.all(
    names.map(
      (name) =>
        new Promise<void>((resolve) => {
          const request = browser.indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          request.onblocked = () => resolve();
        }),
    ),
  );
  return names;
}

export async function clearBrowserCacheStorage() {
  const browser = browserWindow();
  if (!browser || !("caches" in browser)) {
    return [];
  }
  const names = await browser.caches.keys();
  await Promise.all(names.map((name) => browser.caches.delete(name)));
  return names;
}

export async function unregisterServiceWorkers() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return 0;
  }
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  return registrations.length;
}

export async function clearBrowserLocalStateFromUrl(
  options: {
    clearMemoryCaches?: () => void;
    param?: string;
  } = {},
) {
  const browser = browserWindow();
  if (!browser) {
    return false;
  }
  const param = options.param || CLEAR_LOCAL_STATE_PARAM;
  const url = new URL(browser.location.href);
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
  } catch (nextError) {
    report.indexedDbError = nextError instanceof Error ? nextError.message : String(nextError);
  }
  try {
    report.cacheNames = await clearBrowserCacheStorage();
  } catch (nextError) {
    report.cacheStorageError = nextError instanceof Error ? nextError.message : String(nextError);
  }
  try {
    report.serviceWorkers = await unregisterServiceWorkers();
  } catch (nextError) {
    report.serviceWorkerError = nextError instanceof Error ? nextError.message : String(nextError);
  }
  browser.localStorage.clear();
  browser.sessionStorage.clear();
  options.clearMemoryCaches?.();
  url.searchParams.delete(param);
  browser.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  (browser as Window & { __licoLocalStateClearReport?: Record<string, unknown> }).__licoLocalStateClearReport = report;
  return true;
}
