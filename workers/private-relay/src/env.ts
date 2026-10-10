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
