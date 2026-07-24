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
