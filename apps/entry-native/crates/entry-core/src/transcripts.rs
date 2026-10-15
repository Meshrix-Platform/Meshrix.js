//! Canonical proof transcripts — port of `apps/entry/src/transcripts.ts`.
//! Byte shapes are fixed by the endpoint/vault implementations; the entry is
//! a separate runtime duplicating them on purpose.

use sha2::{Digest, Sha256};
use serde_json::{json, Map, Value};

use crate::canonical::canonical_json;

pub const VAULT_TRANSCRIPT_DOMAIN: &str = "meshrix.private-relay.vault";

/// `vaultFetchTranscript` — UTF-8 "|"-joined fixed field order.
pub fn vault_fetch_transcript(vault_id: &str, key_id: &str, nonce: &str, issued_at: &str) -> Vec<u8> {
    [
        VAULT_TRANSCRIPT_DOMAIN,
        "vault_fetch",
        vault_id,
        key_id,
        nonce,
        issued_at,
    ]
    .join("|")
    .into_bytes()
}

/// `vaultWriteTranscript`.
pub fn vault_write_transcript(
    vault_id: &str,
    writer_key_id: &str,
    nonce: &str,
    expected_revision: u64,
    snapshot_digest: &str,
) -> Vec<u8> {
    [
        VAULT_TRANSCRIPT_DOMAIN,
        "vault_write",
        vault_id,
        writer_key_id,
        nonce,
        &expected_revision.to_string(),
        snapshot_digest,
    ]
    .join("|")
    .into_bytes()
}

/// `vaultSnapshotDigest` — sha256 over the canonical "|"-joined protected
/// snapshot field list (the full signed surface). Returns `sha256:<hex>`.
pub fn vault_snapshot_digest(snapshot: &Value) -> String {
    let get_str = |key: &str| snapshot.get(key).and_then(|v| v.as_str()).unwrap_or("");
    let get_num = |key: &str| {
        snapshot
            .get(key)
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .to_string()
    };
    let env = snapshot.get("snapshot").cloned().unwrap_or(Value::Null);
    let ver = snapshot.get("publicVerifier").cloned().unwrap_or(Value::Null);
    let joined = [
        VAULT_TRANSCRIPT_DOMAIN.to_string(),
        "vault_snapshot".to_string(),
        get_str("schemaVersion").into(),
        get_str("kind").into(),
        get_str("vaultId").into(),
        get_num("formatVersion"),
        get_num("generation"),
        get_num("revision"),
        env.get("algorithm").and_then(|v| v.as_str()).unwrap_or("").into(),
        env.get("nonce").and_then(|v| v.as_str()).unwrap_or("").into(),
        env.get("byteLength").and_then(|v| v.as_u64()).unwrap_or(0).to_string(),
        env.get("ciphertext").and_then(|v| v.as_str()).unwrap_or("").into(),
        ver.get("keyId").and_then(|v| v.as_str()).unwrap_or("").into(),
        ver.get("algorithm").and_then(|v| v.as_str()).unwrap_or("").into(),
        ver.get("publicKey").and_then(|v| v.as_str()).unwrap_or("").into(),
    ]
    .join("|");
    let digest = Sha256::digest(joined.as_bytes());
    format!("sha256:{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// `recoveryProofTranscript` — canonicalJson of the typed recovery proof the
/// fresh device key signs during recover_device enrollment.
pub fn recovery_proof_transcript(
    challenge_id: &str,
    endpoint_route_id: &str,
    principal_ref: &str,
    generation: u64,
    fresh_device_id: &str,
    fresh_device_public_key: &str,
) -> String {
    let mut map = Map::new();
    map.insert("challengeId".into(), challenge_id.into());
    map.insert("endpointRouteId".into(), endpoint_route_id.into());
    map.insert("principalRef".into(), principal_ref.into());
    map.insert("generation".into(), generation.into());
    map.insert("freshDeviceId".into(), fresh_device_id.into());
    map.insert("freshDevicePublicKey".into(), fresh_device_public_key.into());
    map.insert("purpose".into(), "recover_device".into());
    canonical_json(&Value::Object(map))
}

/// `pairingProofTranscript` — canonical transcript the fresh device key
/// signs inside the pairing challenge.
pub fn pairing_proof_transcript(
    challenge_id: &str,
    invite_id: &str,
    endpoint_route_id: &str,
    device_id: &str,
    device_public_key: &str,
    entry_peer_identity: Option<&Value>,
) -> String {
    let mut map = Map::new();
    map.insert("challengeId".into(), challenge_id.into());
    map.insert("inviteId".into(), invite_id.into());
    map.insert("endpointRouteId".into(), endpoint_route_id.into());
    map.insert("deviceId".into(), device_id.into());
    map.insert("devicePublicKey".into(), device_public_key.into());
    map.insert(
        "entryPeerIdentity".into(),
        entry_peer_identity.cloned().unwrap_or(Value::Null),
    );
    map.insert("purpose".into(), "pair_device".into());
    canonical_json(&Value::Object(map))
}

/// Desktop-session body digest — `accountDesktopProofDigest`: sha256 of the
/// canonical JSON body, base64url.
pub fn account_desktop_proof_digest(body: &Value) -> String {
    use crate::b64::b64u_encode;
    b64u_encode(&Sha256::digest(canonical_json(body).as_bytes()))
}

/// Convenience for `{a:1}`-style fixed transcripts in tests.
#[allow(dead_code)]
pub fn canonical_of(value: Value) -> String {
    canonical_json(&value)
}

#[allow(dead_code)]
fn _unused(v: Value) -> Value {
    json!(v)
}
