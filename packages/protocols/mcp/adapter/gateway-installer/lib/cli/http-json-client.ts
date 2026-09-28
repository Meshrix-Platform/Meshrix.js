import { Agent, fetch as undiciFetch } from "undici";

import { normalizeBaseUrl } from "./basic-utils.ts";

export const CALLER_OWNED_HTTP_LIFETIME: any = "caller-owned";
const MAX_SUPPORTED_TIMEOUT_MS: any = 2_147_483_647;

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

/**
 * Starts a connector-owned request and returns an owner that must remain alive
 * until its response body is consumed. Caller-owned mode disables only
 * Undici's implicit response-header/body inactivity deadlines; connection
 * establishment and explicitly selected request deadlines stay in force.
 */
export async function fetchResponse(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const {
    requestLifetime = "control",
    timeoutMs: requestedTimeoutMs,
    signal: externalSignal,
    fetchImpl,
    dispatcherFactory = (agentOptions?: any) : any => new Agent(agentOptions),
    ...fetchOptions
  } = options;
  if (requestLifetime !== "control" && requestLifetime !== CALLER_OWNED_HTTP_LIFETIME) {
    throw new TypeError("HTTP request lifetime is invalid.");
  }
  if (requestLifetime === CALLER_OWNED_HTTP_LIFETIME && !externalSignal) {
    throw new TypeError("Caller-owned HTTP requests require an AbortSignal.");
  }

  const hasExplicitTimeout: any = requestedTimeoutMs !== undefined;
  const timeoutMs: any = !hasExplicitTimeout
    ? requestLifetime === CALLER_OWNED_HTTP_LIFETIME ? 0 : 10000
    : requestedTimeoutMs;
  if (hasExplicitTimeout && (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 0
    || timeoutMs > MAX_SUPPORTED_TIMEOUT_MS
  )) {
    throw new RangeError(`timeoutMs must be a whole number between 0 and ${MAX_SUPPORTED_TIMEOUT_MS}.`);
  }
  const controller: any = new AbortController();
  const performFetch: any = fetchImpl || (requestLifetime === CALLER_OWNED_HTTP_LIFETIME ? undiciFetch : fetch);
  const dispatcher: any = requestLifetime === CALLER_OWNED_HTTP_LIFETIME
    ? dispatcherFactory({ headersTimeout: 0, bodyTimeout: 0 })
    : null;
  let timeout: any = null;
  let disposed = false;
  let dispatcherDisposal: Promise<any> | null = null;

  function destroyDispatcher(reason?: any) : Promise<any> {
    if (!dispatcher) return Promise.resolve();
    if (!dispatcherDisposal) {
      dispatcherDisposal = Promise.resolve(dispatcher.destroy(reason)).catch(() : any => {});
    }
    return dispatcherDisposal;
  }

  const abortFromRequestSignal: any = () : any => {
    void destroyDispatcher(controller.signal.reason);
  };
  const abortFromExternalSignal: any = () : any => {
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason);
  };
  controller.signal.addEventListener("abort", abortFromRequestSignal, { once: true });
  if (externalSignal?.aborted) {
    abortFromExternalSignal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  }
  if (timeoutMs > 0) {
    timeout = setTimeout(() : any => {
      const error: any = new Error(`HTTP request timed out after ${timeoutMs} ms.`);
      error.name = "TimeoutError";
      if (!controller.signal.aborted) controller.abort(error);
    }, timeoutMs);
  }

  async function dispose({ failed = false }: Record<string, any> = {}) : Promise<any> {
    if (disposed) return dispatcherDisposal || Promise.resolve();
    disposed = true;
    if (timeout) clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    controller.signal.removeEventListener("abort", abortFromRequestSignal);
    if (!dispatcher) return;
    if (failed || controller.signal.aborted) {
      return destroyDispatcher(controller.signal.reason);
    }
    if (!dispatcherDisposal) {
      dispatcherDisposal = Promise.resolve(dispatcher.close());
    }
    return dispatcherDisposal;
  }

  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response: any = await performFetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {})
    });
    return { response, signal: controller.signal, dispose };
  } catch (error: any) {
    await dispose({ failed: true });
    throw error;
  }
}

export async function fetchJson(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const request: any = await fetchResponse(url, options);
  let failed: any = true;
  try {
    const response: any = request.response;
    const text: any = await response.text();
    const result: any = {
      ok: response.ok,
      status: response.status,
      payload: text.trim() ? JSON.parse(text) : {}
    };
    failed = false;
    return result;
  } finally {
    await request.dispose({ failed });
  }
}
