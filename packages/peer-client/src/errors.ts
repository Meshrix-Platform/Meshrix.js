/**
 * Typed errors for the peer client layer. `code` is the stable
 * machine-readable vocabulary surfaced to hosts; the layer never fabricates
 * a delivery or decryption result — every failure is one of these codes or a
 * propagated `PeerCryptoError` code from the crypto layer beneath.
 */
export const PEER_CLIENT_ERROR_CODES = Object.freeze([
  /** The session channel dropped or answered with a malformed response. */
  "peer_client_transport",
  /** Same exact route/device/message tuple, different envelope bytes — never retried. */
  "peer_client_conflict",
  /** No directory or learned binding resolves the wire device id to a crypto peer id. */
  "peer_client_unknown_peer",
  /** Pairing authority is temporarily unavailable; retain encrypted inbound work and retry. */
  "peer_client_trust_unavailable",
  /** The remote bundle is unpublished or the fetch was refused (unpaired, revoked, stale). */
  "peer_client_bundle_unavailable",
  /** A durable outbox/inbox store record cannot be read or is corrupt. */
  "peer_client_store",
  /** Local storage rejected a new durable event; sender retains exact ciphertext. */
  "peer_client_backpressured",
  /** The call is invalid for the current outbox/inbox lifecycle state. */
  "peer_client_state",
  /** Current route authority could not be checked; accepted work remains queued. */
  "peer_application_authority_unavailable",
  /** The exact paired route was revoked before an accepted operation started. */
  "peer_application_route_revoked"
] as const);

export type PeerClientErrorCode = (typeof PEER_CLIENT_ERROR_CODES)[number];

export interface PeerClientError extends Error {
  readonly code: PeerClientErrorCode;
}

export function peerClientError(
  code: PeerClientErrorCode,
  message: string,
  options: { readonly cause?: unknown } = {}
): PeerClientError {
  const error = new Error(message, options.cause === undefined ? undefined : { cause: options.cause }) as Error & { code: PeerClientErrorCode };
  error.code = code;
  return error;
}

export function isPeerClientError(value: unknown, code?: PeerClientErrorCode): value is PeerClientError {
  return typeof value === "object" && value !== null
    && typeof (value as { code?: unknown }).code === "string"
    && PEER_CLIENT_ERROR_CODES.includes((value as { code: PeerClientErrorCode }).code)
    && (code === undefined || (value as { code?: unknown }).code === code);
}
