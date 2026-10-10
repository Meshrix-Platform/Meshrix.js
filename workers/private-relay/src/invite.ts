/**
 * Invitation tickets — the invite-only admission contract.
 *
 * There is no open registration: the only way a new device enters a route
 * is a signed invitation minted offline by the operator
 * (`tools/invite-mint.mjs`) holding `RELAY_INVITE_SECRET`. The public
 * `/invite/redeem` route verifies the HMAC tag with zero storage, so
 * forged invitations die at the worker edge without instantiating a
 * Durable Object — the same cost posture as session tickets. Replay is
 * bounded by the directory object, which spends each `jti` in a
 * transaction and honors the minted `uses` count.
 *
 * Wire format: `inv1.<base64url(json-claims)>.<tag24>` where claims are
 * `{ j: jti, t: tenantId, r: routeId, role, m?: mode, e: expiryMs }`.
 * Single-use by slot semantics — a route holds exactly one device per
 * role, so one `jti` can only ever mint once. The tag is
 * `base64url(HMAC-SHA256(secret, payload)[:18])` —
 * identical construction to session tickets but a different secret and
 * domain, so a session credential can never be forged into an invite.
 *
 * Unset secret = invite redemption closed entirely (no surface, not even
 * a verifying one). Private deployments mint through the same CLI with
 * their own secret.
 */

import type { PrivateRelayEnv } from "./env.ts";
import { base64UrlToBytes, bytesToBase64Url, constantTimeEqual, isOpaqueId, randomToken, utf8Bytes } from "./ids.ts";

const INVITE_DOMAIN = "meshrix-relay-invite:";
const INVITE_TAG_LENGTH = 24;
const INVITE_PREFIX = "inv1.";

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

async function inviteTag(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Bytes(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, utf8Bytes(`${INVITE_DOMAIN}${payload}`) as BufferSource);
  return bytesToBase64Url(new Uint8Array(signature).slice(0, 18));
}

/** Mint an invite ticket (operator-side; also used by the mint CLI's twin). */
export async function issueInviteTicket(
  secret: string,
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
  return `${INVITE_PREFIX}${payload}.${await inviteTag(secret, payload)}`;
}

export interface VerifiedInvite {
  readonly claims: InviteClaims;
  readonly jti: string;
}

/**
 * Edge-of-worker verification: returns the parsed claims when the ticket
 * is well-formed, correctly tagged and unexpired — `null` otherwise.
 * `null` on a missing secret too: redemption stays closed where no invite
 * authority exists.
 */
export async function verifyInviteTicket(
  env: PrivateRelayEnv,
  invite: string,
  now: number = Date.now(),
): Promise<VerifiedInvite | null> {
  const secret = env.RELAY_INVITE_SECRET;
  if (!secret || typeof invite !== "string" || !invite.startsWith(INVITE_PREFIX)) return null;
  const rest = invite.slice(INVITE_PREFIX.length);
  const separator = rest.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = rest.slice(0, separator);
  const tag = rest.slice(separator + 1);
  if (tag.length !== INVITE_TAG_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(tag)) return null;
  if (!constantTimeEqual(tag, await inviteTag(secret, payload))) return null;

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
