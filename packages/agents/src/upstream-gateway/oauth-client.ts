import { createHash } from "node:crypto";

/**
 * Service-level OAuth 2.0 client-credentials lifecycle for upstream calls.
 *
 * The descriptor declares the public client metadata (token endpoint, client
 * id, scopes) and a `secret://` reference to the client secret held by the
 * local secret store. This client resolves that secret, requests access
 * tokens through the same pinned-DNS egress path as ordinary upstream calls,
 * caches each token until shortly before expiry, and coalesces concurrent
 * misses into a single token-endpoint request. Failures are fail-closed: an
 * unreachable or misbehaving token endpoint denies the invocation without
 * touching the upstream service.
 */

const OAUTH_TOKEN_FETCH_TIMEOUT_MS: any = 10_000;
const OAUTH_TOKEN_RESPONSE_MAX_BYTES: any = 64 * 1024;
const OAUTH_TOKEN_MAX_LENGTH: any = 16 * 1024;
const OAUTH_TOKEN_CACHE_MAX_ENTRIES: any = 128;
const OAUTH_TOKEN_DEFAULT_TTL_MS: any = 60_000;
const OAUTH_TOKEN_MAX_TTL_MS: any = 3_600_000;
const OAUTH_TOKEN_REFRESH_MARGIN_MS: any = 15_000;

function text(value?: any) : any {
  return String(value ?? "").trim();
}

function oauthError(reasonCode?: any, message?: any, status: any = 502) : any {
  return Object.assign(new Error(message), { status, reasonCode });
}

function tokenResponseInvalid(message?: any) : any {
  return oauthError("upstream_oauth_token_invalid", message, 502);
}

interface UpstreamOauthConfig {
  grantType?: string;
  tokenUrl: string;
  clientId: string;
  clientSecretRef: string;
  scopes?: readonly string[];
  audience?: string;
  authMethod?: string;
}

interface UpstreamOauthTokenRequest {
  service: Record<string, any>;
  oauth: UpstreamOauthConfig;
  clientSecret: string;
  secretRevision: number;
  signal?: AbortSignal | null;
}

interface UpstreamOauthToken {
  accessToken: string;
  expiresAt: number;
}

type OauthTokenFetch = (
  service: Record<string, any>,
  url: string,
  init: Record<string, any>
) => Promise<any>;

function tokenRequestBody(oauth: UpstreamOauthConfig, clientSecret: string) : any {
  const body: any = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  const scopes: any = Array.isArray(oauth.scopes) ? oauth.scopes.map(text).filter(Boolean) : [];
  if (scopes.length > 0) body.set("scope", scopes.join(" "));
  const audience: any = text(oauth.audience);
  if (audience) body.set("audience", audience);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json"
  };
  if (oauth.authMethod === "client_secret_post") {
    body.set("client_id", oauth.clientId);
    body.set("client_secret", clientSecret);
  } else {
    // RFC 6749 §2.3.1: each credential is form-urlencoded before the
    // colon-joined basic credentials are base64 encoded.
    const credentials: any = `${encodeURIComponent(oauth.clientId)}:${encodeURIComponent(clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
  }
  return { body: body.toString(), headers };
}

function tokenCacheKey({ service, oauth, clientSecret, secretRevision }: UpstreamOauthTokenRequest) : any {
  const secretDigest: any = createHash("sha256").update(clientSecret, "utf8").digest("hex");
  return createHash("sha256").update(JSON.stringify([
    text(service.serviceId),
    Number(service.serviceRevision || service.revision || 0),
    text(oauth.tokenUrl),
    text(oauth.clientId),
    text(oauth.clientSecretRef),
    Math.max(0, Number(secretRevision || 0)),
    (oauth.scopes || []).join(" "),
    text(oauth.audience),
    text(oauth.authMethod || "client_secret_basic"),
    secretDigest
  ])).digest("hex");
}

async function readTokenResponse(response: any) : Promise<Record<string, any>> {
  const bodyText: any = await response.text();
  if (Buffer.byteLength(bodyText, "utf8") > OAUTH_TOKEN_RESPONSE_MAX_BYTES) {
    throw oauthError("upstream_oauth_token_invalid", "OAuth token response exceeds its configured limit.", 502);
  }
  let payload: any;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw tokenResponseInvalid("OAuth token endpoint did not return a JSON object.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw tokenResponseInvalid("OAuth token endpoint did not return a JSON object.");
  }
  return payload;
}

export function createUpstreamOAuthClient({ fetchToken, now = () : any => Date.now() }: {
  fetchToken: OauthTokenFetch;
  now?: () => number;
}) : any {
  if (typeof fetchToken !== "function") {
    throw new TypeError("createUpstreamOAuthClient requires a fetchToken transport.");
  }
  const cache: Map<string, UpstreamOauthToken> = new Map<string, UpstreamOauthToken>();
  const pending: Map<string, Promise<string>> = new Map<string, Promise<string>>();

  function cacheStore(key: string, token: UpstreamOauthToken) : void {
    if (token.expiresAt - OAUTH_TOKEN_REFRESH_MARGIN_MS <= now()) return;
    if (!cache.has(key) && cache.size >= OAUTH_TOKEN_CACHE_MAX_ENTRIES) {
      const present: any = now();
      for (const [entryKey, entry] of cache) {
        if (entry.expiresAt - OAUTH_TOKEN_REFRESH_MARGIN_MS <= present) cache.delete(entryKey);
      }
      if (cache.size >= OAUTH_TOKEN_CACHE_MAX_ENTRIES) {
        const oldest: any = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
    }
    cache.set(key, token);
  }

  async function requestToken({ service, oauth, clientSecret, signal }: UpstreamOauthTokenRequest) : Promise<UpstreamOauthToken> {
    const { body, headers } = tokenRequestBody(oauth, clientSecret);
    const timeout: any = AbortSignal.timeout(OAUTH_TOKEN_FETCH_TIMEOUT_MS);
    const requestSignal: any = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let pinned: any;
    try {
      pinned = await fetchToken(service, oauth.tokenUrl, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: requestSignal
      });
    } catch (error: any) {
      // Egress denials and aborts carry their own reason codes and stay
      // observable; only undifferentiated transport failures are re-labelled.
      if (error && (error.reasonCode || error.code || error.status)) throw error;
      throw oauthError("upstream_oauth_token_failed", "OAuth token endpoint request failed.", 502);
    }
    let payload: Record<string, any>;
    try {
      const response: any = pinned?.response ?? pinned;
      if (!response?.ok) {
        await response?.body?.cancel?.().catch?.(() : any => {});
        throw oauthError(
          "upstream_oauth_token_failed",
          `OAuth token endpoint returned HTTP ${Number(response?.status || 0)}.`,
          502
        );
      }
      payload = await readTokenResponse(response);
    } finally {
      await pinned?.close?.().catch?.(() : any => {});
    }
    const accessToken: any = payload.access_token;
    if (typeof accessToken !== "string" || !accessToken || accessToken.length > OAUTH_TOKEN_MAX_LENGTH) {
      throw tokenResponseInvalid("OAuth token response did not include a usable access_token.");
    }
    if (payload.token_type !== undefined && String(payload.token_type).toLowerCase() !== "bearer") {
      throw tokenResponseInvalid("OAuth token response did not grant a bearer token.");
    }
    let ttlMs: any = OAUTH_TOKEN_DEFAULT_TTL_MS;
    if (payload.expires_in !== undefined) {
      const expiresIn: any = Number(payload.expires_in);
      ttlMs = Number.isFinite(expiresIn) && expiresIn > 0
        ? Math.min(expiresIn * 1000, OAUTH_TOKEN_MAX_TTL_MS)
        : OAUTH_TOKEN_DEFAULT_TTL_MS;
    }
    return { accessToken, expiresAt: now() + ttlMs };
  }

  async function accessTokenFor(request: UpstreamOauthTokenRequest) : Promise<string> {
    const key: any = tokenCacheKey(request);
    const cached: any = cache.get(key);
    if (cached && cached.expiresAt - OAUTH_TOKEN_REFRESH_MARGIN_MS > now()) return cached.accessToken;
    if (cached) cache.delete(key);
    const inflight: any = pending.get(key);
    if (inflight) return inflight;
    const task: Promise<string> = (async () : Promise<string> => {
      const token: any = await requestToken(request);
      cacheStore(key, token);
      return token.accessToken;
    })();
    pending.set(key, task);
    try {
      return await task;
    } finally {
      pending.delete(key);
    }
  }

  return Object.freeze({ accessTokenFor });
}
