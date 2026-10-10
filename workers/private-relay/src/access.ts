/**
 * Cloudflare Access JWT verification for the `"access"` admin surface.
 *
 * Checking only that a `Cf-Access-Jwt-Assertion` header is *present* is
 * forgeable — anyone can attach the header themselves on a hostname that
 * is not actually behind an Access application (notably `*.workers.dev`,
 * which never traverses the custom domain's Access policy). This module
 * performs the real verification instead: the assertion's RS256 signature
 * is checked against the team's published JWKS, and the payload must be
 * unexpired, issued by the team domain, and carry the configured
 * application AUD tag.
 *
 * Configuration is deployment-selected:
 *   RELAY_ACCESS_TEAM — team name, forming https://{team}.cloudflareaccess.com
 *   RELAY_ACCESS_AUD  — the Access application's AUD tag
 * Either missing while `RELAY_ADMIN_SURFACE=access` → the admin surface
 * stays closed (fail-closed; an Access surface without verifiable Access
 * configuration is not an Access surface).
 *
 * The JWKS fetcher is injectable so tests can exercise verification
 * without external egress. The isolate-local key cache bounds egress to
 * at most one fetch per team per TTL — plus a single refresh on an
 * unknown `kid` (key rotation), then it gives up rather than retry-loop.
 */

import type { PrivateRelayEnv } from "./env.ts";
import { utf8Bytes } from "./ids.ts";

const JWKS_TTL_MS = 60 * 60 * 1000;
const TEAM_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/u;

interface JwksCacheEntry {
  readonly keys: Map<string, CryptoKey>;
  readonly expiresAt: number;
}

const jwksCache = new Map<string, JwksCacheEntry>();

type FetchLike = (input: string) => Promise<Response>;

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function loadTeamKeys(team: string, fetchImpl: FetchLike): Promise<Map<string, CryptoKey> | null> {
  const response = await fetchImpl(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!response.ok) return null;
  const jwks = await response.json() as { keys?: { kid?: string; kty?: string }[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of jwks.keys ?? []) {
    if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
    try {
      keys.set(jwk.kid, await crypto.subtle.importKey(
        "jwk",
        jwk as JsonWebKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ));
    } catch {
      // A malformed advertised key is skipped, not fatal to the set.
    }
  }
  return keys.size ? keys : null;
}

async function teamKeys(team: string, fetchImpl: FetchLike, refresh: boolean): Promise<Map<string, CryptoKey> | null> {
  const cached = jwksCache.get(team);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.keys;
  const keys = await loadTeamKeys(team, fetchImpl);
  if (keys) jwksCache.set(team, { keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return keys;
}

/**
 * Verify the `Cf-Access-Jwt-Assertion` on this request against the
 * configured Access team and application. Returns false — never throws —
 * when configuration is absent, the token is malformed, the signature is
 * invalid, or the claims do not match.
 */
export async function verifyAccessJwt(
  env: PrivateRelayEnv,
  request: Request,
  fetchImpl: FetchLike = (input) => fetch(input),
): Promise<boolean> {
  const team = env.RELAY_ACCESS_TEAM?.trim().toLowerCase() ?? "";
  const audience = env.RELAY_ACCESS_AUD?.trim() ?? "";
  if (!TEAM_DOMAIN_RE.test(team) || !audience) return false;

  const assertion = request.headers.get("cf-access-jwt-assertion") ?? "";
  const parts = assertion.split(".");
  if (parts.length !== 3) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  const headerBytes = base64UrlToBytes(encodedHeader);
  const payloadBytes = base64UrlToBytes(encodedPayload);
  const signature = base64UrlToBytes(encodedSignature);
  if (!headerBytes || !payloadBytes || !signature) return false;

  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; exp?: number; iss?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes));
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return false;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return false;

  // Signature first — claims are unauthenticated input until it verifies.
  let keys = await teamKeys(team, fetchImpl, false).catch(() => null);
  let key = keys?.get(header.kid);
  if (!key) {
    // Unknown kid: the team may have rotated — one refresh, then stop.
    keys = await teamKeys(team, fetchImpl, true).catch(() => null);
    key = keys?.get(header.kid);
    if (!key) return false;
  }
  const signed = utf8Bytes(`${encodedHeader}.${encodedPayload}`);
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    signature as BufferSource,
    signed as BufferSource,
  ).catch(() => false);
  if (!valid) return false;

  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return false;
  if (payload.iss !== `https://${team}.cloudflareaccess.com`) return false;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return audiences.includes(audience);
}
