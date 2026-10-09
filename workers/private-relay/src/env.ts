/**
 * Shared environment bindings and bounded runtime constants for the private
 * relay Worker. All values are routing/metadata bounds — the relay never sees
 * plaintext, inner keys or semantic content.
 */

export interface PrivateRelayEnv {
  RELAY_DIRECTORY: DurableObjectNamespace;
  RELAY_SESSION: DurableObjectNamespace;
  RECOVERY_VAULT: DurableObjectNamespace;
  /** Local provisioning token for admin routes (local dev/tests only). */
  RELAY_ADMIN_TOKEN?: string;
  /** Ingress bound for a single session-channel message in bytes. */
  RELAY_MAX_SESSION_MESSAGE_BYTES?: string;
  /** Ingress bound for a single vault API message body in bytes. */
  RELAY_MAX_VAULT_MESSAGE_BYTES?: string;
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
