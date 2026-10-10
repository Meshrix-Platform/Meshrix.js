/**
 * Stateless session-credential tickets.
 *
 * `/session/:t/:r` upgrades used to reach the Durable Object before any
 * authentication ran, so a forged upgrade instantiated two objects
 * (session + directory lookup) — unauthenticated compute/storage cost on
 * a public route. When `RELAY_TICKET_SECRET` is configured, enrollment
 * appends `.<tag>` where
 * `tag = base64url(HMAC-SHA256(secret, tenant:route:token)[:18])` — bound
 * to the upgrade path, so a valid credential is only honored on its own
 * tenant+route. The outer fetch verifies the tag with zero storage and
 * forged or cross-scope upgrades die at the edge of the worker — before
 * `idFromName`/`stub.fetch` ever run. The Durable Object keeps validating
 * the full credential digest as before (revocation lives there); the
 * ticket only bounds *cost*, it is not the authority.
 *
 * Unset secret = private/self-hosted shape: bare tokens are issued and no
 * ticket check runs — identical to the pre-ticket behavior, intended for
 * non-public surfaces only.
 */

import type { PrivateRelayEnv } from "./env.ts";
import { bytesToBase64Url, constantTimeEqual, utf8Bytes } from "./ids.ts";

const TICKET_DOMAIN = "meshrix-relay-ticket:";
const TICKET_TAG_LENGTH = 24; // base64url of 18 HMAC bytes

/**
 * The tag covers `tenantId:routeId:token`, not the token alone: a valid
 * credential must therefore pass the edge check only on *its own* upgrade
 * path. Carrying a real credential to a different tenant or route fails
 * the tag — cross-scope forgery dies at the worker edge, before the
 * directory lookup a bare-token tag would have permitted.
 */
async function ticketTag(secret: string, tenantId: string, routeId: string, token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Bytes(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    utf8Bytes(`${TICKET_DOMAIN}${tenantId}:${routeId}:${token}`) as BufferSource,
  );
  return bytesToBase64Url(new Uint8Array(signature).slice(0, 18));
}

/** Mint the presented credential: bare token on private shapes, `token.tag` when ticketed. */
export async function issueSessionCredential(
  env: PrivateRelayEnv,
  token: string,
  scope: { tenantId: string; routeId: string },
): Promise<string> {
  const secret = env.RELAY_TICKET_SECRET;
  if (!secret) return token;
  return `${token}.${await ticketTag(secret, scope.tenantId, scope.routeId, token)}`;
}

/**
 * Edge-of-worker verification for the exact upgrade path being attempted.
 * Returns `true` without a secret (private shape, check skipped);
 * otherwise requires a well-formed tag bound to this tenant and route.
 */
export async function verifySessionCredential(
  env: PrivateRelayEnv,
  credential: string,
  scope: { tenantId: string; routeId: string },
): Promise<boolean> {
  const secret = env.RELAY_TICKET_SECRET;
  if (!secret) return true;
  const separator = credential.lastIndexOf(".");
  if (separator < 1) return false;
  const token = credential.slice(0, separator);
  const tag = credential.slice(separator + 1);
  if (tag.length !== TICKET_TAG_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(tag)) return false;
  return constantTimeEqual(tag, await ticketTag(secret, scope.tenantId, scope.routeId, token));
}
