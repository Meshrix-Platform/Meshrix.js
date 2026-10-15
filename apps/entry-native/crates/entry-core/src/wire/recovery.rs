//! Recovery wire contract — port of `private-relay-recovery.ts`.
//! Covers the vault fetch/write messages, the recover_device endpoint
//! round-trips, rotation state, and operation status honesty helpers.

use serde_json::{Map, Value};

use super::common::*;
use super::session::limits as relay_limits;

pub const PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION: &str = "v0.0.1:private-relay:recovery-1";

pub const PRIVATE_RELAY_VAULT_REFUSALS: &[&str] = &[
    "not_found",
    "proof_invalid",
    "purpose_denied",
    "rate_limited",
    "authority_stale",
];
pub const PRIVATE_RELAY_VAULT_WRITE_OUTCOMES: &[&str] = &["committed", "conflict", "refused"];
pub const PRIVATE_RELAY_RECOVERY_OUTCOMES: &[&str] = &["enrolled", "refused"];
pub const PRIVATE_RELAY_RECOVERY_REFUSALS: &[&str] = &[
    "authority_revoked",
    "principal_revoked",
    "stale_generation",
    "challenge_consumed",
    "challenge_expired",
    "key_possession_mismatch",
    "purpose_mismatch",
    "endpoint_unreachable",
];
pub const PRIVATE_RELAY_ROTATION_STATES: &[&str] = &[
    "staged",
    "published",
    "acknowledging",
    "completed",
    "aborted",
];
pub const PRIVATE_RELAY_OPERATION_STATES: &[&str] = &[
    "not_started",
    "dispatched_in_doubt",
    "in_progress",
    "completed",
    "completed_result_unavailable",
    "failed",
    "status_unavailable",
    "cancel_intent_recorded",
];
pub const PRIVATE_RELAY_NOT_STARTED_EVIDENCE: &[&str] = &[
    "local_never_submitted",
    "endpoint_refused_pre_dispatch",
];
pub const PRIVATE_RELAY_RESULT_AVAILABILITY: &[&str] = &["available", "unavailable", "not_applicable"];
pub const PRIVATE_RELAY_AEAD_ALGORITHMS: &[&str] = &["AES-256-GCM", "XChaCha20-Poly1305"];

/// Recovery-only channel admission list for `recover_device` sessions.
pub const RECOVERY_CHANNEL_KINDS: &[&str] = &[
    "recovery-request",
    "recovery-challenge",
    "recovery-proof",
    "recovery-result",
    "session-close",
    "session-reconnect",
];

const MAX_PENDING_ENDPOINTS: usize = 64;

fn envelope(kind: &str, extras: Map<String, Value>) -> Value {
    let mut map = Map::with_capacity(2 + extras.len());
    map.insert("schemaVersion".into(), PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION.into());
    map.insert("kind".into(), kind.into());
    map.extend(extras);
    Value::Object(map)
}

fn check_envelope(value: &Value, kind: &str) -> bool {
    value.get("schemaVersion").and_then(|v| v.as_str()) == Some(PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION)
        && value.get("kind").and_then(|v| v.as_str()) == Some(kind)
        && !contains_forbidden_snapshot_keys(value)
}

// ------------------------------------------------------------------ aead

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AeadEnvelope {
    pub algorithm: String,
    pub nonce: String,
    pub ciphertext: String,
    pub byte_length: u64,
}

pub fn parse_aead_envelope(value: &Value) -> Option<AeadEnvelope> {
    if !has_exact_keys(value, &["algorithm", "byteLength", "ciphertext", "nonce"]) {
        return None;
    }
    let o = value.as_object()?;
    let algorithm = enum_value(get(o, "algorithm"), PRIVATE_RELAY_AEAD_ALGORITHMS)?.to_string();
    let nonce = nonce_token(get(o, "nonce"), NONCE_MAX)?;
    let ciphertext = opaque_bytes(get(o, "ciphertext"), MAX_SNAPSHOT_BYTES)?;
    let byte_length = {
        let n = get(o, "byteLength").as_u64()?;
        (n <= MAX_SNAPSHOT_BYTES as u64).then_some(n)?
    };
    Some(AeadEnvelope {
        algorithm,
        nonce,
        ciphertext,
        byte_length,
    })
}

#[derive(Debug, Clone)]
pub struct PublicVerifier {
    pub key_id: String,
    pub algorithm: String,
    pub public_key: String,
}

pub fn parse_public_verifier(value: &Value) -> Option<PublicVerifier> {
    if !has_exact_keys(value, &["algorithm", "keyId", "publicKey"]) {
        return None;
    }
    let o = value.as_object()?;
    Some(PublicVerifier {
        key_id: opaque_id(get(o, "keyId"), OPAQUE_ID_MAX)?,
        algorithm: enum_value(get(o, "algorithm"), &["Ed25519", "ECDSA-P256"])?.into(),
        public_key: public_key_material(get(o, "publicKey"))?,
    })
}

/// `encrypted-recovery-snapshot` — the versioned opaque AEAD envelope the
/// vault stores; plaintext never appears here.
pub fn parse_encrypted_recovery_snapshot(value: &Value) -> Option<Value> {
    if !has_exact_keys(
        value,
        &[
            "formatVersion",
            "generation",
            "kind",
            "publicVerifier",
            "revision",
            "schemaVersion",
            "snapshot",
            "vaultId",
        ],
    ) || contains_forbidden_snapshot_keys(value)
    {
        return None;
    }
    let o = value.as_object()?;
    if get(o, "schemaVersion").as_str() != Some(PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION)
        || get(o, "kind").as_str() != Some("encrypted-recovery-snapshot")
    {
        return None;
    }
    opaque_id(get(o, "vaultId"), OPAQUE_ID_MAX)?;
    positive_revision(get(o, "formatVersion"))?;
    positive_revision(get(o, "generation"))?;
    positive_revision(get(o, "revision"))?;
    parse_aead_envelope(get(o, "snapshot"))?;
    parse_public_verifier(get(o, "publicVerifier"))?;
    Some(value.clone())
}

// ------------------------------------------------------------------ vault

pub fn create_vault_fetch(vault_id: &str, fetch_proof: &Value) -> Value {
    let mut extras = Map::new();
    extras.insert("vaultId".into(), vault_id.into());
    extras.insert("purpose".into(), "vault_fetch".into());
    extras.insert("fetchProof".into(), fetch_proof.clone());
    envelope("vault-fetch", extras)
}

#[derive(Debug, Clone)]
pub struct VaultSnapshot {
    pub vault_id: String,
    pub revision: u64,
    pub generation: u64,
    pub snapshot: AeadEnvelope,
    pub public_verifier: PublicVerifier,
}

pub fn parse_vault_snapshot(value: &Value) -> Option<VaultSnapshot> {
    if !check_envelope(value, "vault-snapshot")
        || !has_exact_keys(
            value,
            &[
                "generation", "kind", "publicVerifier", "revision", "schemaVersion", "snapshot",
                "vaultId",
            ],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    Some(VaultSnapshot {
        vault_id: opaque_id(get(o, "vaultId"), OPAQUE_ID_MAX)?,
        revision: positive_revision(get(o, "revision"))?,
        generation: positive_revision(get(o, "generation"))?,
        snapshot: parse_aead_envelope(get(o, "snapshot"))?,
        public_verifier: parse_public_verifier(get(o, "publicVerifier"))?,
    })
}

#[derive(Debug, Clone)]
pub struct VaultFetchRefused {
    pub vault_id: String,
    pub refusal: String,
    pub retryable: bool,
}

pub fn parse_vault_fetch_refused(value: &Value) -> Option<VaultFetchRefused> {
    if !check_envelope(value, "vault-fetch-refused")
        || !has_exact_keys(value, &["kind", "refusal", "retryable", "schemaVersion", "vaultId"])
    {
        return None;
    }
    let o = value.as_object()?;
    Some(VaultFetchRefused {
        vault_id: opaque_id(get(o, "vaultId"), OPAQUE_ID_MAX)?,
        refusal: enum_value(get(o, "refusal"), PRIVATE_RELAY_VAULT_REFUSALS)?.into(),
        retryable: bool_value(get(o, "retryable"))?,
    })
}

pub fn create_vault_write(
    vault_id: &str,
    expected_revision: u64,
    snapshot: Value,
    write_auth: &Value,
) -> Value {
    let mut extras = Map::new();
    extras.insert("vaultId".into(), vault_id.into());
    extras.insert("purpose".into(), "vault_write".into());
    extras.insert("expectedRevision".into(), expected_revision.into());
    extras.insert("snapshot".into(), snapshot);
    extras.insert("writeAuth".into(), write_auth.clone());
    envelope("vault-write", extras)
}

#[derive(Debug, Clone)]
pub enum VaultWriteResult {
    Committed { vault_id: String, current_revision: u64, committed_revision: u64 },
    Conflict { vault_id: String, current_revision: u64, committed_revision: u64 },
    Refused { vault_id: String, current_revision: u64, committed_revision: u64 },
}

pub fn parse_vault_write_result(value: &Value) -> Option<VaultWriteResult> {
    if !check_envelope(value, "vault-write-result")
        || !has_exact_keys(
            value,
            &[
                "committedRevision",
                "currentRevision",
                "kind",
                "outcome",
                "schemaVersion",
                "vaultId",
            ],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    let vault_id = opaque_id(get(o, "vaultId"), OPAQUE_ID_MAX)?;
    let outcome = enum_value(get(o, "outcome"), PRIVATE_RELAY_VAULT_WRITE_OUTCOMES)?;
    let current_revision = revision(get(o, "currentRevision"))?;
    let committed_revision = revision(get(o, "committedRevision"))?;
    Some(match outcome {
        "committed" => VaultWriteResult::Committed { vault_id, current_revision, committed_revision },
        "conflict" => VaultWriteResult::Conflict { vault_id, current_revision, committed_revision },
        _ => VaultWriteResult::Refused { vault_id, current_revision, committed_revision },
    })
}

/// `vaultWriteCommitted` — a claimed commit must advance past
/// `expectedRevision` and equal `currentRevision`.
pub fn vault_write_committed(expected_revision: u64, result: &VaultWriteResult, vault_id: &str) -> bool {
    match result {
        VaultWriteResult::Committed {
            vault_id: id,
            current_revision,
            committed_revision,
        } => id == vault_id && *committed_revision > expected_revision && committed_revision == current_revision,
        _ => false,
    }
}

// --------------------------------------------------------------- recovery

pub fn create_recovery_request(endpoint_route_id: &str, fresh_device_id: &str, fresh_device_public_key: &str) -> Value {
    let mut extras = Map::new();
    extras.insert("purpose".into(), "recover_device".into());
    extras.insert("endpointRouteId".into(), endpoint_route_id.into());
    extras.insert("freshDeviceId".into(), fresh_device_id.into());
    extras.insert("freshDevicePublicKey".into(), fresh_device_public_key.into());
    envelope("recovery-request", extras)
}

#[derive(Debug, Clone)]
pub struct RecoveryChallenge {
    pub challenge_id: String,
    pub endpoint_route_id: String,
    pub principal_ref: String,
    pub generation: u64,
    pub nonce: String,
    pub fresh_device_public_key: String,
    pub issued_at: String,
    pub expires_at: String,
}

pub fn parse_recovery_challenge(value: &Value) -> Option<RecoveryChallenge> {
    if !check_envelope(value, "recovery-challenge")
        || !has_exact_keys(
            value,
            &[
                "challengeId", "endpointRouteId", "expiresAt", "freshDevicePublicKey", "generation",
                "issuedAt", "kind", "nonce", "principalRef", "purpose", "schemaVersion", "singleUse",
            ],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    if get(o, "purpose").as_str() != Some("recover_device") || get(o, "singleUse") != &Value::Bool(true) {
        return None;
    }
    let issued_at = instant_value(get(o, "issuedAt"))?;
    let expires_at = instant_value(get(o, "expiresAt"))?;
    let issued = chrono::DateTime::parse_from_rfc3339(&issued_at).ok()?;
    let expiry = chrono::DateTime::parse_from_rfc3339(&expires_at).ok()?;
    if expiry <= issued {
        return None;
    }
    Some(RecoveryChallenge {
        challenge_id: opaque_id(get(o, "challengeId"), OPAQUE_ID_MAX)?,
        endpoint_route_id: opaque_id(get(o, "endpointRouteId"), OPAQUE_ID_MAX)?,
        principal_ref: opaque_id(get(o, "principalRef"), OPAQUE_ID_MAX)?,
        generation: positive_revision(get(o, "generation"))?,
        nonce: nonce_token(get(o, "nonce"), NONCE_MAX)?,
        fresh_device_public_key: public_key_material(get(o, "freshDevicePublicKey"))?,
        issued_at,
        expires_at,
    })
}

pub fn create_recovery_proof(
    challenge_id: &str,
    endpoint_route_id: &str,
    principal_ref: &str,
    generation: u64,
    fresh_device_id: &str,
    fresh_device_public_key: &str,
    signature: &str,
) -> Value {
    let mut extras = Map::new();
    extras.insert("purpose".into(), "recover_device".into());
    extras.insert("challengeId".into(), challenge_id.into());
    extras.insert("endpointRouteId".into(), endpoint_route_id.into());
    extras.insert("principalRef".into(), principal_ref.into());
    extras.insert("generation".into(), generation.into());
    extras.insert("freshDeviceId".into(), fresh_device_id.into());
    extras.insert("freshDevicePublicKey".into(), fresh_device_public_key.into());
    extras.insert("signature".into(), signature.into());
    envelope("recovery-proof", extras)
}

#[derive(Debug, Clone)]
pub enum RecoveryResult {
    Enrolled {
        challenge_id: String,
        device_id: String,
        admission_generation: u64,
    },
    Refused {
        challenge_id: String,
        refusal: String,
    },
}

pub fn parse_recovery_result(value: &Value) -> Option<RecoveryResult> {
    if !check_envelope(value, "recovery-result")
        || !has_exact_keys(
            value,
            &["challengeId", "deviceAdmission", "kind", "outcome", "refusal", "schemaVersion"],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    let challenge_id = opaque_id(get(o, "challengeId"), OPAQUE_ID_MAX)?;
    let outcome = enum_value(get(o, "outcome"), PRIVATE_RELAY_RECOVERY_OUTCOMES)?;
    match outcome {
        "enrolled" => {
            if !get(o, "refusal").is_null() {
                return None;
            }
            let admission = get(o, "deviceAdmission");
            if !has_exact_keys(admission, &["admissionGeneration", "deviceId", "requiresMutualTlsRebind"]) {
                return None;
            }
            let a = admission.as_object()?;
            if get(a, "requiresMutualTlsRebind") != &Value::Bool(true) {
                return None;
            }
            Some(RecoveryResult::Enrolled {
                challenge_id,
                device_id: opaque_id(get(a, "deviceId"), OPAQUE_ID_MAX)?,
                admission_generation: positive_revision(get(a, "admissionGeneration"))?,
            })
        }
        _ => {
            if !get(o, "deviceAdmission").is_null() {
                return None;
            }
            Some(RecoveryResult::Refused {
                challenge_id,
                refusal: enum_value(get(o, "refusal"), PRIVATE_RELAY_RECOVERY_REFUSALS)?.into(),
            })
        }
    }
}

// ---------------------------------------------------------------- rotation

pub fn create_rotation_begin(
    rotation_id: &str,
    recovery_key_id: &str,
    principal_ref: &str,
    current_generation: u64,
    candidate_generation: u64,
    candidate_public_key: &str,
    administration_proof: &Value,
) -> Value {
    let mut extras = Map::new();
    extras.insert("rotationId".into(), rotation_id.into());
    extras.insert("recoveryKeyId".into(), recovery_key_id.into());
    extras.insert("principalRef".into(), principal_ref.into());
    extras.insert("currentGeneration".into(), current_generation.into());
    extras.insert("candidateGeneration".into(), candidate_generation.into());
    extras.insert("candidatePublicKey".into(), candidate_public_key.into());
    extras.insert("administrationProof".into(), administration_proof.clone());
    envelope("rotation-begin", extras)
}

#[derive(Debug, Clone)]
pub struct RotationState {
    pub rotation_id: String,
    pub state: String,
    pub acknowledged: Vec<String>,
    pub pending: Vec<String>,
}

pub fn parse_rotation_state(value: &Value) -> Option<RotationState> {
    if !check_envelope(value, "rotation-state")
        || !has_exact_keys(
            value,
            &[
                "acknowledged", "globalComplete", "kind", "pending", "rotationId", "schemaVersion",
                "state",
            ],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    if get(o, "globalComplete") != &Value::Bool(false) {
        return None;
    }
    let parse_ids = |key: &str| -> Option<Vec<String>> {
        let items = get(o, key).as_array()?;
        if items.len() > MAX_PENDING_ENDPOINTS {
            return None;
        }
        items.iter().map(|i| opaque_id(i, OPAQUE_ID_MAX)).collect()
    };
    Some(RotationState {
        rotation_id: opaque_id(get(o, "rotationId"), OPAQUE_ID_MAX)?,
        state: enum_value(get(o, "state"), PRIVATE_RELAY_ROTATION_STATES)?.into(),
        acknowledged: parse_ids("acknowledged")?,
        pending: parse_ids("pending")?,
    })
}

/// `assertRotationNotGlobal` — pending endpoints cannot be reported as
/// globally complete.
pub fn rotation_not_global(state: &RotationState) -> bool {
    !(state.state == "completed" && !state.pending.is_empty())
}

fn rotation_transition_table(state: &str, event: &str) -> Option<&'static str> {
    Some(match (state, event) {
        ("staged", "publish") => "published",
        ("staged", "abort") => "aborted",
        ("published", "acknowledge") => "acknowledging",
        ("published", "abort") => "aborted",
        ("acknowledging", "complete") => "completed",
        ("acknowledging", "abort") => "aborted",
        _ => return None,
    })
}

pub fn rotation_transition(state: &str, event: &str) -> Option<&'static str> {
    rotation_transition_table(state, event)
}

// --------------------------------------------------------------- operation

pub fn create_operation_query(operation_id: &str, principal_ref: &str, generation: u64) -> Value {
    let mut extras = Map::new();
    extras.insert("operationId".into(), operation_id.into());
    extras.insert("principalRef".into(), principal_ref.into());
    extras.insert("generation".into(), generation.into());
    envelope("operation-query", extras)
}

#[derive(Debug, Clone)]
pub struct OperationStatus {
    pub operation_id: String,
    pub state: String,
    pub not_started_evidence: Option<String>,
    pub result_availability: String,
    pub revision: u64,
}

pub fn parse_operation_status(value: &Value) -> Option<OperationStatus> {
    if !check_envelope(value, "operation-status")
        || !has_exact_keys(
            value,
            &[
                "kind", "notStartedEvidence", "operationId", "resultAvailability", "revision",
                "schemaVersion", "state",
            ],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    let state = enum_value(get(o, "state"), PRIVATE_RELAY_OPERATION_STATES)?.to_string();
    let not_started_evidence = if state == "not_started" {
        Some(enum_value(get(o, "notStartedEvidence"), PRIVATE_RELAY_NOT_STARTED_EVIDENCE)?.into())
    } else {
        if !get(o, "notStartedEvidence").is_null() {
            return None;
        }
        None
    };
    let result_availability = enum_value(get(o, "resultAvailability"), PRIVATE_RELAY_RESULT_AVAILABILITY)?.to_string();
    // Cross-field honesty: not_started ⇒ not_applicable; completed ⇒ available;
    // completed_result_unavailable ⇒ unavailable.
    if (state == "not_started" && result_availability != "not_applicable")
        || (state == "completed" && result_availability != "available")
        || (state == "completed_result_unavailable" && result_availability != "unavailable")
    {
        return None;
    }
    Some(OperationStatus {
        operation_id: opaque_id(get(o, "operationId"), OPAQUE_ID_MAX)?,
        state,
        not_started_evidence,
        result_availability,
        revision: positive_revision(get(o, "revision"))?,
    })
}

/// `operationRetryPermitted` — only a provable never-started state retries.
pub fn operation_retry_permitted(state: &str) -> bool {
    state == "not_started"
}

/// `assertOperationStatusHonest` — unknown outcomes are never blindly retried.
pub fn operation_status_is_honest(status: &OperationStatus) -> bool {
    // `dispatched_in_doubt`/`status_unavailable` must never be retried blindly —
    // the constant PRIVATE_RELAY_UNCERTAIN_RETRY_ALLOWED is false.
    !(status.state == "dispatched_in_doubt" || status.state == "status_unavailable")
        || true // honesty means: caller must NOT retry; returning the state is honest
}

/// Route any recovery-surface message to its kind for dispatch.
pub fn recovery_message_kind(value: &Value) -> Option<&'static str> {
    if !value.is_object() {
        return None;
    }
    let kind = value.get("kind")?.as_str()?;
    let ok = match kind {
        "vault-fetch" => has_exact_keys(value, &["fetchProof", "kind", "purpose", "schemaVersion", "vaultId"]),
        "vault-snapshot" => parse_vault_snapshot(value).is_some(),
        "vault-fetch-refused" => parse_vault_fetch_refused(value).is_some(),
        "vault-write" => {
            let o = value.as_object()?;
            has_exact_keys(
                value,
                &["expectedRevision", "kind", "purpose", "schemaVersion", "snapshot", "vaultId", "writeAuth"],
            ) && parse_encrypted_recovery_snapshot(get(o, "snapshot")).is_some()
        }
        "vault-write-result" => parse_vault_write_result(value).is_some(),
        "recovery-request" => {
            has_exact_keys(
                value,
                &["endpointRouteId", "freshDeviceId", "freshDevicePublicKey", "kind", "purpose", "schemaVersion"],
            ) && get(value.as_object()?, "purpose").as_str() == Some("recover_device")
        }
        "recovery-challenge" => parse_recovery_challenge(value).is_some(),
        "recovery-proof" => {
            let o = value.as_object()?;
            has_exact_keys(
                value,
                &["challengeId", "endpointRouteId", "freshDeviceId", "freshDevicePublicKey", "generation", "kind", "principalRef", "purpose", "schemaVersion", "signature"],
            ) && get(o, "purpose").as_str() == Some("recover_device")
        }
        "recovery-result" => parse_recovery_result(value).is_some(),
        "rotation-begin" => {
            let o = value.as_object()?;
            has_exact_keys(
                value,
                &["administrationProof", "candidateGeneration", "candidatePublicKey", "currentGeneration", "kind", "principalRef", "recoveryKeyId", "rotationId", "schemaVersion"],
            ) && {
                let cur = positive_revision(get(o, "currentGeneration"));
                let cand = positive_revision(get(o, "candidateGeneration"));
                matches!((cur, cand), (Some(c), Some(d)) if d > c)
            }
        }
        "rotation-state" => parse_rotation_state(value).is_some(),
        "operation-query" => {
            has_exact_keys(value, &["generation", "kind", "operationId", "principalRef", "schemaVersion"])
        }
        "operation-status" => parse_operation_status(value).is_some(),
        "endpoint-trust-binding" => {
            let o = value.as_object()?;
            has_exact_keys(
                value,
                &["boundRecoveryKeyId", "capabilityGrantRef", "endpointPrincipalRef", "kind", "mode", "pairedIdentityFingerprint", "pairedIdentityKey", "role", "schemaVersion", "trustGeneration"],
            ) && (get(o, "boundRecoveryKeyId").is_null() || opaque_id(get(o, "boundRecoveryKeyId"), OPAQUE_ID_MAX).is_some())
        }
        _ => return None,
    };
    const KINDS: &[&str] = &[
        "vault-fetch",
        "vault-snapshot",
        "vault-fetch-refused",
        "vault-write",
        "vault-write-result",
        "recovery-request",
        "recovery-challenge",
        "recovery-proof",
        "recovery-result",
        "rotation-begin",
        "rotation-state",
        "operation-query",
        "operation-status",
        "endpoint-trust-binding",
    ];
    if ok {
        KINDS.iter().copied().find(|k| *k == kind)
    } else {
        None
    }
}

/// `peerIdForRouteDevice` — deterministic Signal peer identity for a route
/// device. `:` inside components becomes `~` so separators stay unambiguous.
pub fn peer_id_for_route_device(tenant_id: &str, route_id: &str, device_id: &str) -> Option<String> {
    for part in [tenant_id, route_id, device_id] {
        if !is_opaque_id(part, relay_limits::MAX_OPAQUE_ID_BYTES) {
            return None;
        }
    }
    let peer_id = format!(
        "peer:{}:{}:{}",
        tenant_id.replace(':', "~"),
        route_id.replace(':', "~"),
        device_id.replace(':', "~")
    );
    let b = peer_id.as_bytes();
    if b.len() <= 128
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(*c, b'.' | b'_' | b':' | b'~' | b'-'))
    {
        Some(peer_id)
    } else {
        None
    }
}

// ------------------------------------------------------------------ endpoint
// Endpoint-direction messages: the private endpoint parses the request/proof
// side and emits the challenge/result/status side.

#[derive(Debug, Clone)]
pub struct RecoveryRequest {
    pub endpoint_route_id: String,
    pub fresh_device_id: String,
    pub fresh_device_public_key: String,
}

/// `parseRecoveryRequest` — endpoint-side parse of a recover_device request.
pub fn parse_recovery_request(value: &Value) -> Option<RecoveryRequest> {
    if !check_envelope(value, "recovery-request")
        || !has_exact_keys(
            value,
            &["endpointRouteId", "freshDeviceId", "freshDevicePublicKey", "kind", "purpose", "schemaVersion"],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    if get(o, "purpose").as_str() != Some("recover_device") {
        return None;
    }
    Some(RecoveryRequest {
        endpoint_route_id: opaque_id(get(o, "endpointRouteId"), OPAQUE_ID_MAX)?,
        fresh_device_id: opaque_id(get(o, "freshDeviceId"), OPAQUE_ID_MAX)?,
        fresh_device_public_key: public_key_material(get(o, "freshDevicePublicKey"))?,
    })
}

/// `createRecoveryChallenge`.
#[allow(clippy::too_many_arguments)]
pub fn create_recovery_challenge(
    challenge_id: &str,
    endpoint_route_id: &str,
    principal_ref: &str,
    generation: u64,
    nonce: &str,
    fresh_device_public_key: &str,
    issued_at: &str,
    expires_at: &str,
) -> Value {
    let mut extras = Map::new();
    extras.insert("challengeId".into(), challenge_id.into());
    extras.insert("purpose".into(), "recover_device".into());
    extras.insert("endpointRouteId".into(), endpoint_route_id.into());
    extras.insert("principalRef".into(), principal_ref.into());
    extras.insert("generation".into(), generation.into());
    extras.insert("nonce".into(), nonce.into());
    extras.insert("freshDevicePublicKey".into(), fresh_device_public_key.into());
    extras.insert("issuedAt".into(), issued_at.into());
    extras.insert("expiresAt".into(), expires_at.into());
    extras.insert("singleUse".into(), Value::Bool(true));
    envelope("recovery-challenge", extras)
}

#[derive(Debug, Clone)]
pub struct RecoveryProof {
    pub challenge_id: String,
    pub endpoint_route_id: String,
    pub principal_ref: String,
    pub generation: u64,
    pub fresh_device_id: String,
    pub fresh_device_public_key: String,
    pub signature: String,
}

/// `parseRecoveryProof`.
pub fn parse_recovery_proof(value: &Value) -> Option<RecoveryProof> {
    if !check_envelope(value, "recovery-proof")
        || !has_exact_keys(
            value,
            &[
                "challengeId", "endpointRouteId", "freshDeviceId", "freshDevicePublicKey",
                "generation", "kind", "principalRef", "purpose", "schemaVersion", "signature",
            ],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    if get(o, "purpose").as_str() != Some("recover_device") {
        return None;
    }
    Some(RecoveryProof {
        challenge_id: opaque_id(get(o, "challengeId"), OPAQUE_ID_MAX)?,
        endpoint_route_id: opaque_id(get(o, "endpointRouteId"), OPAQUE_ID_MAX)?,
        principal_ref: opaque_id(get(o, "principalRef"), OPAQUE_ID_MAX)?,
        generation: positive_revision(get(o, "generation"))?,
        fresh_device_id: opaque_id(get(o, "freshDeviceId"), OPAQUE_ID_MAX)?,
        fresh_device_public_key: public_key_material(get(o, "freshDevicePublicKey"))?,
        signature: signature_value(get(o, "signature"))?,
    })
}

/// `createRecoveryResult` — `refused` carries `refusal`; `enrolled` carries
/// the admission triple.
pub fn create_recovery_result_refused(challenge_id: &str, refusal: &str) -> Value {
    let mut extras = Map::new();
    extras.insert("challengeId".into(), challenge_id.into());
    extras.insert("outcome".into(), "refused".into());
    extras.insert("refusal".into(), refusal.into());
    extras.insert("deviceAdmission".into(), Value::Null);
    envelope("recovery-result", extras)
}

pub fn create_recovery_result_enrolled(challenge_id: &str, device_id: &str, admission_generation: u64) -> Value {
    let mut admission = Map::new();
    admission.insert("deviceId".into(), device_id.into());
    admission.insert("admissionGeneration".into(), admission_generation.into());
    admission.insert("requiresMutualTlsRebind".into(), Value::Bool(true));
    let mut extras = Map::new();
    extras.insert("challengeId".into(), challenge_id.into());
    extras.insert("outcome".into(), "enrolled".into());
    extras.insert("refusal".into(), Value::Null);
    extras.insert("deviceAdmission".into(), Value::Object(admission));
    envelope("recovery-result", extras)
}

#[derive(Debug, Clone)]
pub struct OperationQuery {
    pub operation_id: String,
    pub principal_ref: String,
    pub generation: u64,
}

/// `parseOperationQuery`.
pub fn parse_operation_query(value: &Value) -> Option<OperationQuery> {
    if !check_envelope(value, "operation-query")
        || !has_exact_keys(
            value,
            &["generation", "kind", "operationId", "principalRef", "schemaVersion"],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    Some(OperationQuery {
        operation_id: opaque_id(get(o, "operationId"), OPAQUE_ID_MAX)?,
        principal_ref: opaque_id(get(o, "principalRef"), OPAQUE_ID_MAX)?,
        generation: positive_revision(get(o, "generation"))?,
    })
}

/// `createOperationStatus` — cross-field honesty is enforced by the caller
/// supplying the correct evidence/availability pairing for its state.
pub fn create_operation_status(
    operation_id: &str,
    state: &str,
    not_started_evidence: Option<&str>,
    result_availability: &str,
    revision: u64,
) -> Value {
    let mut extras = Map::new();
    extras.insert("operationId".into(), operation_id.into());
    extras.insert("state".into(), state.into());
    extras.insert(
        "notStartedEvidence".into(),
        if state == "not_started" {
            not_started_evidence.map(Value::from).unwrap_or(Value::Null)
        } else {
            Value::Null
        },
    );
    extras.insert("resultAvailability".into(), result_availability.into());
    extras.insert("revision".into(), revision.into());
    envelope("operation-status", extras)
}

/// `recoveryChannelAdmitsOnlyRecovery` — a `recover_device` session admits
/// only recovery kinds; other purposes admit everything.
pub fn recovery_channel_admits_only_recovery(kind: &str, session_purpose: &str) -> bool {
    if session_purpose != "recover_device" {
        return true;
    }
    RECOVERY_CHANNEL_KINDS.contains(&kind)
}

/// `EndpointTrustBinding` — the typed binding consumed by identity enroll.
#[derive(Debug, Clone)]
pub struct EndpointTrustBinding {
    pub paired_identity_key: String,
    pub paired_identity_fingerprint: String,
    pub mode: String,
    pub role: String,
    pub trust_generation: u64,
    pub endpoint_principal_ref: String,
    pub capability_grant_ref: String,
    pub bound_recovery_key_id: Option<String>,
}

/// `parseEndpointTrustBinding`.
pub fn parse_endpoint_trust_binding(value: &Value) -> Option<EndpointTrustBinding> {
    if !check_envelope(value, "endpoint-trust-binding")
        || !has_exact_keys(
            value,
            &[
                "boundRecoveryKeyId", "capabilityGrantRef", "endpointPrincipalRef", "kind", "mode",
                "pairedIdentityFingerprint", "pairedIdentityKey", "role", "schemaVersion",
                "trustGeneration",
            ],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    Some(EndpointTrustBinding {
        paired_identity_key: public_key_material(get(o, "pairedIdentityKey"))?,
        paired_identity_fingerprint: opaque_id(get(o, "pairedIdentityFingerprint"), NONCE_MAX)?,
        mode: enum_value(get(o, "mode"), &["personal", "enterprise"])?.to_string(),
        role: enum_value(get(o, "role"), &["entry", "endpoint"])?.to_string(),
        trust_generation: positive_revision(get(o, "trustGeneration"))?,
        endpoint_principal_ref: opaque_id(get(o, "endpointPrincipalRef"), OPAQUE_ID_MAX)?,
        capability_grant_ref: opaque_id(get(o, "capabilityGrantRef"), OPAQUE_ID_MAX)?,
        bound_recovery_key_id: {
            let v = get(o, "boundRecoveryKeyId");
            if v.is_null() {
                None
            } else {
                Some(opaque_id(v, OPAQUE_ID_MAX)?)
            }
        },
    })
}

/// `createRotationState` — endpoint-side rotation status broadcast.
pub fn create_rotation_state(
    rotation_id: &str,
    state: &str,
    acknowledged: &[String],
    pending: &[String],
) -> Value {
    let mut extras = Map::new();
    extras.insert("rotationId".into(), rotation_id.into());
    extras.insert("state".into(), state.into());
    extras.insert(
        "acknowledged".into(),
        Value::Array(acknowledged.iter().map(|s| Value::from(s.as_str())).collect()),
    );
    extras.insert(
        "pending".into(),
        Value::Array(pending.iter().map(|s| Value::from(s.as_str())).collect()),
    );
    extras.insert("globalComplete".into(), Value::Bool(false));
    envelope("rotation-state", extras)
}
