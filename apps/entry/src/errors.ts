/**
 * Typed failure surface for the entry identity/custody/pairing/recovery layer.
 *
 * Every expected failure carries a stable `code`; callers branch on codes and
 * never parse message text. Unknown exceptions still propagate normally —
 * these codes exist so the GUI can render exact next actions.
 */
export type EntryErrorCode =
  | "custody_unavailable"
  | "custody_backend_error"
  | "custody_invalid_ref"
  | "custody_decrypt_failed"
  | "custody_payload_invalid"
  | "unsupported_platform"
  | "recovery_key_invalid"
  | "recovery_locator_missing"
  | "snapshot_decrypt_failed"
  | "snapshot_malformed"
  | "snapshot_stale"
  | "snapshot_authority_mismatch"
  | "vault_transport_error"
  | "vault_unexpected_response"
  | "vault_refused"
  | "vault_conflict"
  | "endpoint_unreachable"
  | "endpoint_refused"
  | "endpoint_unexpected_response"
  | "pairing_invite_invalid"
  | "pairing_expired"
  | "pairing_state_invalid"
  | "recovery_state_invalid"
  | "rotation_state_invalid"
  | "device_record_invalid"
  | "peer_disabled"
  | "peer_identity_invalid"
  | "peer_unavailable"
  | "peer_message_invalid";

export interface EntryError extends Error {
  readonly code: EntryErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function entryError(
  code: EntryErrorCode,
  message: string,
  details?: Record<string, unknown>
): EntryError {
  return Object.assign(new Error(message), { code, details });
}

export function isEntryError(error: unknown, code?: EntryErrorCode): error is EntryError {
  return error instanceof Error
    && typeof (error as { code?: unknown }).code === "string"
    && (code === undefined || (error as { code?: unknown }).code === code);
}
