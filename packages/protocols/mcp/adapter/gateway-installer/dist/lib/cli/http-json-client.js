import { normalizeBaseUrl } from "./basic-utils.js";
export function vmBaseUrl(baseUrl) {
    const parsed = new URL(baseUrl);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${parsed.protocol}//host.orb.internal:${port}`;
}
export function baseUrlWithHost(baseUrl, host) {
    const parsed = new URL(baseUrl);
    parsed.hostname = host;
    return normalizeBaseUrl(parsed.toString());
}
export function isLoopbackHost(hostname) {
    const value = String(hostname || "").toLowerCase();
    return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
}
export async function fetchJson(url, options = {}) {
    const { timeoutMs = 10000, signal: externalSignal, ...fetchOptions } = options;
    const controller = new AbortController();
    const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) {
        abortFromExternalSignal();
    }
    else {
        externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
    }
    const timeout = timeoutMs > 0
        ? setTimeout(() => {
            const error = new Error(`HTTP request timed out after ${timeoutMs} ms.`);
            error.name = "TimeoutError";
            controller.abort(error);
        }, timeoutMs)
        : null;
    try {
        const response = await fetch(url, {
            ...fetchOptions,
            signal: controller.signal
        });
        const text = await response.text();
        return {
            ok: response.ok,
            status: response.status,
            payload: text.trim() ? JSON.parse(text) : {}
        };
    }
    finally {
        if (timeout) {
            clearTimeout(timeout);
        }
        externalSignal?.removeEventListener("abort", abortFromExternalSignal);
    }
}
//# sourceMappingURL=http-json-client.js.map