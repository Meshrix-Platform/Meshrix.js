/**
 * Shared environment bindings and bounded runtime constants for the private
 * relay Worker. All values are routing/metadata bounds — the relay never sees
 * plaintext, inner keys or semantic content.
 */

export interface PrivateRelayEnv {
  RELAY_DIRECTORY: DurableObjectNamespace;
  RELAY_SESSION: DurableObjectNamespace;
  RECOVERY_VAULT: DurableObjectNamespace;
  RELAY_MAILBOX: DurableObjectNamespace;
  /** Local provisioning token for admin routes (local dev/tests only). */
  RELAY_ADMIN_TOKEN?: string;
  /** Ingress bound for a single session-channel message in bytes. */
  RELAY_MAX_SESSION_MESSAGE_BYTES?: string;
  /** Ingress bound for a single vault API message body in bytes. */
  RELAY_MAX_VAULT_MESSAGE_BYTES?: string;
  /** Deployment-selected mailbox byte capacity per recipient partition. */
  RELAY_MAILBOX_CAPACITY_BYTES?: string;
  /** Deployment-selected mailbox retention in milliseconds. */
  RELAY_MAILBOX_RETENTION_MS?: string;
  /** Deployment-selected bound on stored messages per partition. */
  RELAY_MAILBOX_MAX_ITEMS?: string;
  /**
   * `"0"`/`"false"`/`"off"` → billing counters never persist; every tier is
   * kept ephemeral (zero counter writes to Durable Object SQLite storage).
   * Any other value — including unset — keeps the durable tier.
   */
  RELAY_METRICS_DURABLE?: string;
  /**
   * Exposure of the `/admin/*` control plane — see `adminSurfaceMode`.
   * Unset/unknown is the closed default: the surface does not exist.
   */
  RELAY_ADMIN_SURFACE?: string;
  /**
   * HMAC key for session-credential tickets (`src/ticket.ts`). Set it on
   * anything reachable from the public internet: forged upgrades are then
   * rejected before they can instantiate Durable Objects. Unset keeps the
   * bare-token private shape — acceptable only on non-public surfaces.
   */
  RELAY_TICKET_SECRET?: string;
  /**
   * Ed25519 public verification key for invitation tickets
   * (`src/invite.ts`), base64url raw 32 bytes. It is a verification key,
   * not a credential — committing it in `vars` is correct, and the relay
   * can never mint invitations from it. The signing private key lives
   * only with the invitation authority (offline mint or the closed
   * activation service). Unset keeps redemption fully closed — there is
   * no open registration anywhere.
   */
  RELAY_INVITE_PUBLIC_KEY?: string;
  /**
   * Cloudflare Access team name for the `"access"` admin surface
   * (`src/access.ts`) — forms `https://{team}.cloudflareaccess.com`.
   * Required for that mode; without it the surface stays closed.
   */
  RELAY_ACCESS_TEAM?: string;
  /**
   * Access application AUD tag the JWT must carry. Required for `"access"`
   * mode; without it the surface stays closed.
   */
  RELAY_ACCESS_AUD?: string;
}

declare global {
  // Lets cloudflare:test `env` resolve to the declared bindings in this
  // package's typecheck without a generated worker-configuration.d.ts.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env extends PrivateRelayEnv {}
  }
}

export const RELAY_RUNTIME_LIMITS = Object.freeze({
  /** Maximum simultaneously open sockets on one pair/session object. */
  maxSocketsPerSessionObject: 8,
  /** Retained session records (live plus closed tombstones) per route. */
  maxSessionRecordsPerRoute: 32,
  /** Frames tracked per direction for acknowledgement accounting. */
  maxTrackedSentFrames: 256,
  /** Consecutive refused admissions before a flooding sender is closed. */
  maxConsecutiveBackpressureDrops: 64,
  /** Pending (not yet admitted) socket lifetime is always short. */
  pendingSocketTimeoutMs: 60_000,
  /** Minimum interval between durable route-cursor checkpoints. */
  cursorCheckpointMinIntervalMs: 30_000,
  /** Default ingress bound for one session-channel message (~384 KiB). */
  defaultMaxSessionMessageBytes: 384 * 1024,
  /** Default ingress bound for one vault request body (1.5 MiB). */
  defaultMaxVaultMessageBytes: 1_572_864,
  /** Enrolled devices bound to one tenant directory object. */
  maxDevicesPerTenant: 256,
  /** Enrolled routes bound to one tenant directory object. */
  maxRoutesPerTenant: 256,
  /** Registered writer keys per recovery vault. */
  maxWritersPerVault: 8,
  /** Retained single-use proof nonces per vault. */
  maxProofNoncesPerVault: 512,
  /** Accepted clock window for vault proofs (ms). */
  proofValidityWindowMs: 15 * 60 * 1000,
  /** Vault fetch token bucket: requests per window. */
  vaultFetchWindowMs: 60_000,
  vaultFetchMaxPerWindow: 60,
});

/**
 * Recovery-purpose sessions get deliberately tighter forwarding budgets than
 * `PRIVATE_RELAY_LIMITS` — recovery routing is independent and bounded.
 */
export const RECOVERY_SESSION_LIMITS = Object.freeze({
  maxFramePayloadBytes: 65_536,
  maxOutstandingBytes: 262_144,
  maxBufferedFrames: 32,
  maxMessageRatePerSecond: 16,
});

export function integerEnv(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

/**
 * Whether billing counters keep a SQLite-flushed durable tier (default
 * `true` — the self-hosted/local shape). `RELAY_METRICS_DURABLE` values
 * `"0"`, `"false"` and `"off"` (case-insensitive) disable persistence: every
 * counter is kept in memory only, so Workers-mode deployments perform zero
 * counter writes into Durable Object storage — the values are never billed
 * writes, and the exposition reports them under `scope="ephemeral"`.
 */
export function metricsDurableEnabled(env: PrivateRelayEnv): boolean {
  const raw = env.RELAY_METRICS_DURABLE;
  if (typeof raw !== "string" || !raw.trim()) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

/**
 * Deployment-selected exposure of the `/admin/*` control plane. The default
 * is deliberately closed — a public route must never carry a control
 * surface by accident:
 *
 * - `"off"` (also unset/unknown — fail-closed): every `/admin/*` request
 *   returns 404; the surface does not exist at this deployment. Required
 *   posture for anything reachable from the public internet.
 * - `"local"`: bearer-gated admin for private/self-hosted shapes only —
 *   loopback, LAN, tailnet, `wrangler dev`. Never a public route.
 * - `"access"`: bearer-gated admin that additionally requires a
 *   cryptographically verified Cloudflare Access JWT
 *   (`verifyAccessJwt`: RS256 against the team JWKS, matching issuer,
 *   unexpired, configured AUD). Header *presence* alone is forgeable —
 *   notably `*.workers.dev` never traverses the custom domain's Access
 *   policy — so the worker verifies the assertion itself. The mode is
 *   fail-closed without `RELAY_ACCESS_TEAM`+`RELAY_ACCESS_AUD`.
 */
export type RelayAdminSurface = "off" | "local" | "access";

export function adminSurfaceMode(env: PrivateRelayEnv): RelayAdminSurface {
  const raw = env.RELAY_ADMIN_SURFACE;
  if (typeof raw !== "string" || !raw.trim()) return "off";
  const normalized = raw.trim().toLowerCase();
  return normalized === "local" || normalized === "access" ? normalized : "off";
}

/**
 * Deployment-selected mailbox retention policy. There is no invented
 * implicit default: committed `[vars]` pin these values for the local
 * deployment shape, and every bound stays inside
 * `PRIVATE_RELAY_PEER_LIMITS` (≤ 1 GiB / ≤ 365 d / ≤ 1 000 000 items).
 * `mailboxRetentionFloorMs` bounds the *envelope* size that can ever fit:
 * a partition whose capacity is smaller than one envelope refuses to store.
 */
export const RELAY_MAILBOX_DEFAULTS = Object.freeze({
  mailboxCapacityBytes: 16_777_216,
  mailboxRetentionMs: 2_592_000_000,
  mailboxMaxItems: 4_096,
});

export interface MailboxRetentionPolicyValues {
  mailboxCapacityBytes: number;
  mailboxRetentionMs: number;
  mailboxMaxItems: number;
}

export function mailboxPolicyFromEnv(env: PrivateRelayEnv): MailboxRetentionPolicyValues {
  return {
    mailboxCapacityBytes: integerEnv(
      env.RELAY_MAILBOX_CAPACITY_BYTES,
      RELAY_MAILBOX_DEFAULTS.mailboxCapacityBytes,
      1,
      1_073_741_824,
    ),
    mailboxRetentionMs: integerEnv(
      env.RELAY_MAILBOX_RETENTION_MS,
      RELAY_MAILBOX_DEFAULTS.mailboxRetentionMs,
      1,
      31_536_000_000,
    ),
    mailboxMaxItems: integerEnv(
      env.RELAY_MAILBOX_MAX_ITEMS,
      RELAY_MAILBOX_DEFAULTS.mailboxMaxItems,
      1,
      1_000_000,
    ),
  };
}
