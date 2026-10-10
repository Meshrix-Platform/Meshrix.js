/**
 * Invitation tickets — the invite-only admission contract.
 *
 * There is no open registration: the only way a new device enters a route
 * is a signed invitation minted by the invitation authority holding the
 * Ed25519 *private* key (`tools/invite-mint.mjs` for self-hosted issuance;
 * a hosted activation service is a separate codebase). The relay holds
 * only the public verification key — `RELAY_INVITE_PUBLIC_KEY` is a var,
 * not a secret, and safe to commit — so a compromised relay can verify
 * invitations but can never mint them. `/invite/redeem` verifies the
 * signature with zero storage, so forged invitations die at the worker
 * edge without instantiating a Durable Object — the same cost posture as
 * session tickets. Replay is bounded by the directory object, which
 * spends each `jti` in a transaction under single-slot semantics.
 *
 * Wire format: `inv2.<base64url(json-claims)>.<sig>` where claims are
 * `{ j: jti, t: tenantId, r: routeId, role, m?: mode, e: expiryMs }` and
 * `sig` is the base64url Ed25519 signature (64 bytes) over
 * `INVITE_DOMAIN + payload`. Single-use by slot semantics — a route holds
 * exactly one device per role, so one `jti` can only ever mint once.
 *
 * Unset public key = invite redemption closed entirely (no surface, not
 * even a verifying one).
 */

import type { PrivateRelayEnv } from "./env.ts";
import { base64UrlToBytes, bytesToBase64Url, isOpaqueId, randomToken, utf8Bytes } from "./ids.ts";

const INVITE_DOMAIN = "meshrix-relay-invite:";
const INVITE_PREFIX = "inv2.";
const ED25519_SIGNATURE_BYTES = 64;

export interface InviteClaims {
  /** Single-use token id — replay-guarded inside the directory object. */
  readonly jti: string;
  readonly tenantId: string;
  readonly routeId: string;
  readonly role: "entry" | "endpoint";
  readonly mode: "personal" | "enterprise";
  readonly expiresAt: number;
}

export const INVITE_LIMITS = Object.freeze({
  maxLifetimeMs: 30 * 24 * 60 * 60 * 1000,
});

/** Import an operator-held Ed25519 signing key (PKCS8, base64url). */
export function importInviteSigningKey(pkcs8Base64Url: string): Promise<CryptoKey> {
  const der = base64UrlToBytes(pkcs8Base64Url);
  if (!der) return Promise.reject(new Error("invalid_pkcs8"));
  return crypto.subtle.importKey("pkcs8", der as BufferSource, { name: "Ed25519" }, false, ["sign"]);
}

/** Mint an invite ticket (issuer-side; also used by the mint CLI). */
export async function issueInviteTicket(
  privateKey: CryptoKey,
  input: {
    tenantId: string;
    routeId: string;
    role: "entry" | "endpoint";
    mode?: "personal" | "enterprise";
    expiresAt: number;
    jti?: string;
  },
): Promise<string> {
  const claims = {
    j: input.jti ?? `inv.${randomToken().slice(0, 24)}`,
    t: input.tenantId,
    r: input.routeId,
    role: input.role,
    m: input.mode ?? "personal",
    e: input.expiresAt,
  };
  const payload = bytesToBase64Url(utf8Bytes(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    utf8Bytes(`${INVITE_DOMAIN}${payload}`) as BufferSource,
  );
  return `${INVITE_PREFIX}${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export interface VerifiedInvite {
  readonly claims: InviteClaims;
  readonly jti: string;
}

/**
 * Edge-of-worker verification: returns the parsed claims when the ticket
 * is well-formed, correctly signed by the configured verification key and
 * unexpired — `null` otherwise. `null` on a missing public key too:
 * redemption stays closed where no invite authority is configured.
 */
export async function verifyInviteTicket(
  env: PrivateRelayEnv,
  invite: string,
  now: number = Date.now(),
): Promise<VerifiedInvite | null> {
  const publicKeyValue = env.RELAY_INVITE_PUBLIC_KEY;
  if (!publicKeyValue || typeof invite !== "string" || !invite.startsWith(INVITE_PREFIX)) return null;
  const rest = invite.slice(INVITE_PREFIX.length);
  const separator = rest.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = rest.slice(0, separator);
  const signature = base64UrlToBytes(rest.slice(separator + 1));
  if (!signature || signature.length !== ED25519_SIGNATURE_BYTES) return null;

  const publicKeyBytes = base64UrlToBytes(publicKeyValue);
  if (!publicKeyBytes || publicKeyBytes.length !== 32) return null;
  const publicKey = await crypto.subtle.importKey(
    "raw",
    publicKeyBytes as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  ).catch(() => null);
  if (!publicKey) return null;
  const valid = await crypto.subtle.verify(
    "Ed25519",
    publicKey,
    signature as BufferSource,
    utf8Bytes(`${INVITE_DOMAIN}${payload}`) as BufferSource,
  ).catch(() => false);
  if (!valid) return null;

  const raw = base64UrlToBytes(payload);
  if (!raw) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const jti = claims.j;
  const tenantId = claims.t;
  const routeId = claims.r;
  const role = claims.role;
  const mode = claims.m === "enterprise" ? "enterprise" : "personal";
  const expiresAt = Number(claims.e);
  if (typeof jti !== "string" || !isOpaqueId(jti)) return null;
  if (!isOpaqueId(tenantId) || !isOpaqueId(routeId)) return null;
  if (role !== "entry" && role !== "endpoint") return null;
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + INVITE_LIMITS.maxLifetimeMs) return null;

  return {
    jti,
    claims: { jti, tenantId, routeId, role, mode, expiresAt },
  };
}
