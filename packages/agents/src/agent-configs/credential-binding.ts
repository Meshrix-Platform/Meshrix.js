function text(value?: any) : any {
  return String(value || "").trim();
}

export function normalizeModelTokenPrefix(value: any = "") : any {
  const prefix: any = String(value ?? "");
  if (/[\r\n\0]/u.test(prefix)) {
    throw new TypeError("Model credential tokenPrefix must not contain CR, LF, or NUL characters.");
  }
  return prefix;
}

const FORBIDDEN_MODEL_CREDENTIAL_HEADERS: any = new Set<any>([
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function normalizeModelTokenHeader(value: any = "") : any {
  const header: any = String(value ?? "").trim();
  if (!header) {
    return "";
  }
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(header)) {
    throw new TypeError("Model credential tokenHeader must be a valid HTTP field name.");
  }
  if (FORBIDDEN_MODEL_CREDENTIAL_HEADERS.has(header.toLowerCase())) {
    throw new TypeError(`Model credential tokenHeader is reserved: ${header}`);
  }
  return header;
}

export function normalizeModelEndpoint(value: any = "") : any {
  const endpoint: any = String(value ?? "").trim();
  if (!endpoint) {
    return "";
  }
  let parsed: any;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeError("Model endpoint must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new TypeError("Model endpoint must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("Model endpoint must not contain userinfo, query, or fragment data.");
  }
  return endpoint;
}

export function modelCredentialOrigin(entry: Record<string, any> = {}) : any {
  let endpoint: any;
  try {
    endpoint = normalizeModelEndpoint(entry.baseUrl || entry.url);
  } catch {
    return "";
  }
  if (!endpoint) {
    return "";
  }
  try {
    const parsed: any = new URL(endpoint);
    if (!new Set<any>(["http:", "https:"]).has(parsed.protocol)) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

export function modelCredentialBindingKey(entry: Record<string, any> = {}) : any {
  const identity: any = text(entry.uid || entry.instanceId || entry.alias || entry.id);
  const provider: any = text(entry.provider).toLowerCase();
  const origin: any = modelCredentialOrigin(entry);
  if (!identity || !provider || !origin) {
    return "";
  }
  return [identity, provider, origin].join("\n");
}
