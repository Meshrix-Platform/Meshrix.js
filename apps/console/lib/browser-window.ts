export function browserWindow() {
  return typeof window === "undefined" ? null : window;
}

export function browserLocationOrigin(fallback = "") {
  return browserWindow()?.location.origin || fallback;
}

export function browserUrlBase(fallback = "http://localhost") {
  return browserLocationOrigin(fallback) || fallback;
}

export function parseBrowserRelativeUrl(value: string, fallbackBase = "http://localhost") {
  return new URL(value, browserUrlBase(fallbackBase));
}

export function normalizeBrowserHashRoute(route: string, fallbackRoute = "/") {
  const rawRoute = String(route || fallbackRoute || "").trim();
  const routeWithoutHash = rawRoute.startsWith("#") ? rawRoute.slice(1) : rawRoute;
  if (!routeWithoutHash) {
    return "";
  }
  return routeWithoutHash.startsWith("/") ? routeWithoutHash : `/${routeWithoutHash}`;
}

export function navigateBrowserHashRoute(route: string, fallbackRoute = "/") {
  const normalizedRoute = normalizeBrowserHashRoute(route, fallbackRoute);
  const browser = browserWindow();
  if (!browser || !normalizedRoute) {
    return false;
  }
  browser.location.hash = normalizedRoute;
  return true;
}

export function openBrowserPopup(url: string, target: string, features?: string) {
  const browser = browserWindow();
  const href = String(url || "").trim();
  if (!browser || !href) {
    return null;
  }
  return browser.open(href, target, features);
}

export function readBrowserLocalStorageItem(key: string) {
  return browserWindow()?.localStorage.getItem(key) ?? null;
}

export function writeBrowserLocalStorageItem(key: string, value: string) {
  const storage = browserWindow()?.localStorage;
  if (!storage) {
    return false;
  }
  storage.setItem(key, value);
  return true;
}
