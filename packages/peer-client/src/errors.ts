/**
 * Typed errors for the peer client layer. `code` is the stable
 * machine-readable vocabulary surfaced to hosts; the layer never fabricates
 * a delivery or decryption result — every failure is one of these codes or a
 * propagated `PeerCryptoError` code from the crypto layer beneath.
 */
export const PEER_CLIENT_ERROR_CODES = Object.freeze([
  /** The session channel dropped, timed out or answered with a malformed response. */
  "peer_client_transport",
  /** The mailbox provably never recorded the send (unpaired, revoked or dropped past the retry bound). */
  "peer_client_unrecorded",
  /** Same sender scope, different envelope bytes — the mailbox's typed conflict, never retried. */
  "peer_client_conflict",
  /** No directory or learned binding resolves the wire device id to a crypto peer id. */
  "peer_client_unknown_peer",
  /** The remote bundle is unpublished or the fetch was refused (unpaired, revoked, stale). */
  "peer_client_bundle_unavailable",
  /** A durable outbox/inbox store record cannot be read or is corrupt. */
  "peer_client_store",
  /** The call is invalid for the current outbox/inbox lifecycle state. */
  "peer_client_state"
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
