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
  | "agent_definition_invalid"
  | "peer_disabled"
  | "peer_identity_invalid"
  | "peer_identity_unavailable"
  | "peer_unavailable"
  | "peer_message_invalid"
  | "peer_route_unavailable"
  | "personal_endpoint_stopped"
  | "service_config_missing"
  | "team_not_available"
  | "account_action_unavailable"
  | "account_binding_mismatch"
  | "account_binding_missing"
  | "account_bootstrap_expired"
  | "account_bootstrap_invalid"
  | "account_bootstrap_mismatch"
  | "account_browser_url_invalid"
  | "account_custody_required"
  | "account_device_revoke_invalid"
  | "account_login_invalid"
  | "account_login_required"
  | "account_origin_invalid"
  | "account_origin_missing"
  | "account_repair_required"
  | "account_request_refused"
  | "account_response_invalid"
  | "account_response_oversize"
  | "account_service_unreachable"
  | "account_step_up_expired"
  | "account_step_up_mismatch"
  | "account_transaction_invalid"
  | "account_transaction_mismatch"
  | "account_transaction_missing"
  | "account_transaction_pending"
  | "account_vault_rotation_invalid"
  | "entry_admission_rejected"
  | "entry_endpoint_detached"
  | "entry_session_closed"
  | "entry_session_state"
  | "grant_access_refused"
  | "grant_catalog_invalid"
  | "grant_device_mismatch"
  | "grant_scope_invalid"
  | "grant_target_expired"
  | "grant_target_invalid"
  | "pairing_authorization_invalid"
  | "pairing_completion_invalid"
  | "pairing_invite_mismatch"
  | "pairing_pin_mismatch"
  | "pairing_target_mismatch";

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
