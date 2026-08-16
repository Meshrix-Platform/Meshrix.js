export class ProviderEgressError extends Error {
  constructor(message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.name = "ProviderEgressError";
    this.retryable = retryable;
    this.status = status;
  }
}

function validateBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl));
  } catch {
    throw new ProviderEgressError("Provider base URL is invalid.", { retryable: false });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderEgressError("Provider base URL must use http or https.", { retryable: false });
  }
  if (url.username || url.password) {
    throw new ProviderEgressError("Provider base URL must not embed credentials.", { retryable: false });
  }
  return url;
}

export function createProviderEgress({ fetchImpl = fetch, defaultTimeoutMs = 30_000 } = {}) {
  const SENSITIVE_HEADERS = new Set([
    "authorization",
    "x-api-key",
    "cookie",
    "set-cookie",
    "host",
    "content-length",
    "connection",
    "proxy-authorization",
  ]);

  function forwardedHeaders(incoming) {
    const forwarded = {};
    for (const [name, value] of Object.entries(incoming ?? {})) {
      const lower = String(name).toLowerCase();
      if (SENSITIVE_HEADERS.has(lower) || typeof value !== "string") continue;
      forwarded[lower] = value;
    }
    return forwarded;
  }

  async function call({
    protocol,
    baseUrl,
    credential,
    body,
    headers = {},
    signal,
    timeoutMs = defaultTimeoutMs
  }) {
    const url = validateBaseUrl(baseUrl);
    let target = url;
    const requestHeaders = { "content-type": "application/json", ...forwardedHeaders(headers) };
    if (protocol === "openai") {
      target = new URL("/v1/chat/completions", url);
      requestHeaders.authorization = `Bearer ${credential}`;
    } else if (protocol === "anthropic") {
      target = new URL("/v1/messages", url);
      requestHeaders["x-api-key"] = credential;
      requestHeaders["anthropic-version"] = String(headers["anthropic-version"] || "2023-06-01");
    } else if (protocol === "http") {
      requestHeaders["x-api-key"] = credential;
    } else {
      throw new ProviderEgressError(`Unsupported provider protocol: ${protocol}`, { retryable: false });
    }

    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let response;
    try {
      response = await fetchImpl(target, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal: attemptSignal,
        redirect: "error"
      });
    } catch (error) {
      throw new ProviderEgressError("Provider egress failed.", {
        retryable: error?.name !== "AbortError",
        status: 0
      });
    }
    const text = await response.text();
    let parsed = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ProviderEgressError("Provider returned invalid JSON.", {
          retryable: true,
          status: response.status
        });
      }
    }
    return { status: response.status, body: parsed };
  }

  return { call };
}
