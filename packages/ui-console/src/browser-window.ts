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
