export function browserWindow(): Window | null {
  return typeof window === "undefined" ? null : window;
}

export function browserLocationOrigin(fallback = ""): string {
  return browserWindow()?.location.origin || fallback;
}

export function browserUrlBase(fallback = "http://localhost"): string {
  return browserLocationOrigin(fallback) || fallback;
}

export function parseBrowserRelativeUrl(value: string, fallbackBase = "http://localhost"): URL {
  return new URL(value, browserUrlBase(fallbackBase));
}

export function normalizeBrowserHashRoute(route: string, fallbackRoute = "/"): string {
  const rawRoute = String(route || fallbackRoute || "").trim();
  const routeWithoutHash = rawRoute.startsWith("#") ? rawRoute.slice(1) : rawRoute;
  if (!routeWithoutHash) {
    return "";
  }
  return routeWithoutHash.startsWith("/") ? routeWithoutHash : `/${routeWithoutHash}`;
}

export function navigateBrowserHashRoute(route: string, fallbackRoute = "/"): boolean {
  const normalizedRoute = normalizeBrowserHashRoute(route, fallbackRoute);
  const browser = browserWindow();
  if (!browser || !normalizedRoute) {
    return false;
  }
  browser.location.hash = normalizedRoute;
  return true;
}

export function openBrowserPopup(url: string, target: string, features?: string): WindowProxy | null {
  const browser = browserWindow();
  const href = String(url || "").trim();
  if (!browser || !href) {
    return null;
  }
  return browser.open(href, target, features);
}

export function readBrowserLocalStorageItem(key: string): string | null {
  return browserWindow()?.localStorage.getItem(key) ?? null;
}

export function writeBrowserLocalStorageItem(key: string, value: string): boolean {
  const storage = browserWindow()?.localStorage;
  if (!storage) {
    return false;
  }
  storage.setItem(key, value);
  return true;
}

export function removeBrowserLocalStorageItem(key: string): boolean {
  const storage = browserWindow()?.localStorage;
  if (!storage) {
    return false;
  }
  storage.removeItem(key);
  return true;
}
