/**
 * Typed errors for the peer crypto layer. `code` is the stable
 * machine-readable vocabulary the online peer layer projects into its own
 * failure taxonomy; the layer never fabricates a decryption result — every
 * cryptographic failure surfaces as one of these codes.
 */
export const PEER_CRYPTO_ERROR_CODES = Object.freeze([
  /** Wire input is not a well-formed peer envelope/bundle/ciphertext. */
  "peer_envelope_malformed",
  /** No established session exists for the peer or the ratchet state is unusable. */
  "peer_session_broken",
  /** Remote identity key differs from the pinned record; explicit re-pair required. */
  "peer_identity_changed",
  /** The local one-time/Kyber prekey pool cannot mint a fresh bundle. */
  "peer_prekey_exhausted",
  /** The Double Ratchet rejected a replayed ciphertext — delivery evidence only. */
  "peer_duplicate_message",
  /** The ciphertext failed authentication/decryption (tampered or corrupt). */
  "peer_message_unauthentic",
  /** A durable store record cannot be read or is corrupt. */
  "peer_store_error",
  /** The call is invalid for the current identity/session lifecycle state. */
  "peer_state_invalid"
] as const);

export type PeerCryptoErrorCode = (typeof PEER_CRYPTO_ERROR_CODES)[number];

export interface PeerCryptoError extends Error {
  readonly code: PeerCryptoErrorCode;
}

export function peerCryptoError(
  code: PeerCryptoErrorCode,
  message: string,
  options: { readonly cause?: unknown } = {}
): PeerCryptoError {
  const error = new Error(message, options.cause === undefined ? undefined : { cause: options.cause }) as Error & { code: PeerCryptoErrorCode };
  error.code = code;
  return error;
}

export function isPeerCryptoError(value: unknown, code?: PeerCryptoErrorCode): value is PeerCryptoError {
  return typeof value === "object" && value !== null
    && typeof (value as { code?: unknown }).code === "string"
    && PEER_CRYPTO_ERROR_CODES.includes((value as { code: PeerCryptoErrorCode }).code)
    && (code === undefined || (value as { code?: unknown }).code === code);
}
