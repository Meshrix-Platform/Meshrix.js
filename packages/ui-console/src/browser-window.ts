export function browserWindow() : any {
  return typeof window === "undefined" ? null : window;
}

export function browserLocationOrigin(fallback: any = "") : any {
  return browserWindow()?.location.origin || fallback;
}

export function browserUrlBase(fallback: any = "http://localhost") : any {
  return browserLocationOrigin(fallback) || fallback;
}

export function parseBrowserRelativeUrl(value: string, fallbackBase: any = "http://localhost") : any {
  return new URL(value, browserUrlBase(fallbackBase));
}

export function normalizeBrowserHashRoute(route: string, fallbackRoute: any = "/") : any {
  const rawRoute: any = String(route || fallbackRoute || "").trim();
  const routeWithoutHash: any = rawRoute.startsWith("#") ? rawRoute.slice(1) : rawRoute;
  if (!routeWithoutHash) {
    return "";
  }
  return routeWithoutHash.startsWith("/") ? routeWithoutHash : `/${routeWithoutHash}`;
}

export function navigateBrowserHashRoute(route: string, fallbackRoute: any = "/") : any {
  const normalizedRoute: any = normalizeBrowserHashRoute(route, fallbackRoute);
  const browser: any = browserWindow();
  if (!browser || !normalizedRoute) {
    return false;
  }
  browser.location.hash = normalizedRoute;
  return true;
}

export function openBrowserPopup(url: string, target: string, features?: string) : any {
  const browser: any = browserWindow();
  const href: any = String(url || "").trim();
  if (!browser || !href) {
    return null;
  }
  return browser.open(href, target, features);
}

export function readBrowserLocalStorageItem(key: string) : any {
  return browserWindow()?.localStorage.getItem(key) ?? null;
}

export function writeBrowserLocalStorageItem(key: string, value: string) : any {
  const storage: any = browserWindow()?.localStorage;
  if (!storage) {
    return false;
  }
  storage.setItem(key, value);
  return true;
}

export function removeBrowserLocalStorageItem(key: string) : any {
  const storage: any = browserWindow()?.localStorage;
  if (!storage) {
    return false;
  }
  storage.removeItem(key);
  return true;
}
