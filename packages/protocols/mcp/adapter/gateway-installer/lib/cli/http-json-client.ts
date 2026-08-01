import { normalizeBaseUrl } from "./basic-utils.ts";

export function vmBaseUrl(baseUrl?: any) : any {
  const parsed: any = new URL(baseUrl);
  const port: any = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `${parsed.protocol}//host.orb.internal:${port}`;
}

export function baseUrlWithHost(baseUrl?: any, host?: any) : any {
  const parsed: any = new URL(baseUrl);
  parsed.hostname = host;
  return normalizeBaseUrl(parsed.toString());
}

export function isLoopbackHost(hostname?: any) : any {
  const value: any = String(hostname || "").toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
}

export async function fetchJson(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const { timeoutMs = 10000, signal: externalSignal, ...fetchOptions } = options;
  const controller: any = new AbortController();
  const abortFromExternalSignal: any = () : any => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    abortFromExternalSignal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  }
  const timeout: any = timeoutMs > 0
    ? setTimeout(() : any => {
        const error: any = new Error(`HTTP request timed out after ${timeoutMs} ms.`);
        error.name = "TimeoutError";
        controller.abort(error);
      }, timeoutMs)
    : null;
  try {
    const response: any = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal
    });
    const text: any = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      payload: text.trim() ? JSON.parse(text) : {}
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}
