//! Account authority types — the contract subset the entry consumes from
//! `packages/contracts/src/account/*`.

use serde_json::Value;

use super::common::is_opaque_id;

pub const ACCOUNT_API_BASE: &str = "/api/account";

pub mod routes {
    use super::ACCOUNT_API_BASE;

    pub fn desktop_transaction() -> String {
        format!("{ACCOUNT_API_BASE}/desktop/transactions")
    }
    pub fn desktop_transaction_poll(transaction_id: &str) -> String {
        format!("{ACCOUNT_API_BASE}/desktop/transactions/{transaction_id}/poll")
    }
    pub fn desktop_transaction_acknowledge(transaction_id: &str) -> String {
        format!("{ACCOUNT_API_BASE}/desktop/transactions/{transaction_id}/acknowledge")
    }
    pub fn desktop_pairing_bootstrap() -> String {
        format!("{ACCOUNT_API_BASE}/desktop/pairing/bootstrap")
    }
    pub fn device_revoke() -> String {
        format!("{ACCOUNT_API_BASE}/device/revoke")
    }
    pub fn desktop_vault_writer_rotation_prepare() -> String {
        format!("{ACCOUNT_API_BASE}/desktop/vault-writers/prepare")
    }
    pub fn desktop_vault_writer_rotation_complete() -> String {
        format!("{ACCOUNT_API_BASE}/desktop/vault-writers/complete")
    }
}

/// `{accountId, authEpoch}` — the account authority binding attached to
/// every authorized desktop operation.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAuthorityBinding {
    pub account_id: String,
    pub auth_epoch: u64,
}

pub fn is_binding(value: &Value) -> bool {
    value
        .get("accountId")
        .and_then(|v| v.as_str())
        .is_some_and(|s| is_opaque_id(s, 128))
        && value.get("authEpoch").and_then(|v| v.as_u64()).is_some_and(|n| n >= 1)
}

pub fn parse_binding(value: &Value) -> Option<AccountAuthorityBinding> {
    if !is_binding(value) {
        return None;
    }
    Some(AccountAuthorityBinding {
        account_id: value["accountId"].as_str()?.into(),
        auth_epoch: value["authEpoch"].as_u64()?,
    })
}

/// The exact account-authorized grant target a step-up permit binds.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountActionTarget {
    pub tenant_id: String,
    pub route_id: String,
    pub device_id: String,
    pub device_public_key: String,
    pub grant_ref: String,
    pub scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_writer_rotation: Option<Value>,
}

pub fn is_action_target(value: &Value) -> bool {
    let Some(o) = value.as_object() else { return false };
    o.get("tenantId").and_then(|v| v.as_str()).is_some()
        && o.get("routeId").and_then(|v| v.as_str()).is_some()
        && o.get("deviceId").and_then(|v| v.as_str()).is_some()
        && o.get("devicePublicKey").and_then(|v| v.as_str()).is_some()
        && o.get("grantRef").and_then(|v| v.as_str()).is_some()
        && o.get("scopes")
            .and_then(|v| v.as_array())
            .is_some_and(|a| a.iter().all(|s| s.is_string()))
}

/// `canonicalAccountActionTarget` — JSON.stringify with the contract's fixed
/// field order (tenantId, routeId, deviceId, devicePublicKey, grantRef,
/// deduped+sorted scopes, vaultWriterRotation). Not the sorted-keys
/// canonicalJson — byte equality with the endpoint's own serialization is
/// what binds the permit.
pub fn canonical_account_action_target(target: &AccountActionTarget) -> String {
    let mut scopes: Vec<String> = target.scopes.clone();
    scopes.sort();
    scopes.dedup();
    let mut out = String::with_capacity(256);
    out.push_str("{\"tenantId\":");
    out.push_str(&serde_json::to_string(&target.tenant_id).unwrap());
    out.push_str(",\"routeId\":");
    out.push_str(&serde_json::to_string(&target.route_id).unwrap());
    out.push_str(",\"deviceId\":");
    out.push_str(&serde_json::to_string(&target.device_id).unwrap());
    out.push_str(",\"devicePublicKey\":");
    out.push_str(&serde_json::to_string(&target.device_public_key).unwrap());
    out.push_str(",\"grantRef\":");
    out.push_str(&serde_json::to_string(&target.grant_ref).unwrap());
    out.push_str(",\"scopes\":");
    out.push_str(&serde_json::to_string(&scopes).unwrap());
    out.push_str(",\"vaultWriterRotation\":");
    match &target.vault_writer_rotation {
        Some(rotation) => {
            // Fixed order: vaultId, generation, writers (sorted by keyId),
            // recoveryVerifier.
            let vault_id = rotation.get("vaultId").cloned().unwrap_or(Value::Null);
            let generation = rotation.get("generation").cloned().unwrap_or(Value::Null);
            let mut writers: Vec<Value> = rotation
                .get("writers")
                .and_then(|w| w.as_array())
                .cloned()
                .unwrap_or_default();
            writers.sort_by(|a, b| {
                let ka = a.get("keyId").and_then(|v| v.as_str()).unwrap_or("");
                let kb = b.get("keyId").and_then(|v| v.as_str()).unwrap_or("");
                ka.cmp(kb)
            });
            let verifier = rotation.get("recoveryVerifier").cloned().unwrap_or(Value::Null);
            let mut rotation_obj = serde_json::Map::new();
            rotation_obj.insert("vaultId".into(), vault_id);
            rotation_obj.insert("generation".into(), generation);
            rotation_obj.insert("writers".into(), Value::Array(writers));
            rotation_obj.insert("recoveryVerifier".into(), verifier);
            out.push_str(&serde_json::to_string(&Value::Object(rotation_obj)).unwrap());
        }
        None => out.push_str("null"),
    }
    out.push('}');
    out
}

/// `isAccountStepUpPermitId` — account-issued permits are the canonical
/// base64url encoding of 32 random bytes (43 chars); unlike opaque record
/// ids they may begin with `_` or `-`.
pub fn is_account_step_up_permit_id(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 43 {
        return false;
    }
    const TAIL: &[u8] = b"AEIMQUYcgkosw048";
    b[..42].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
        && TAIL.contains(&b[42])
}

/// Route-scoped Signal peer identity exchanged during pairing.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPeerIdentity {
    pub peer_id: String,
    pub signal_device_id: u64,
    pub registration_id: u64,
    /// Serialized libsignal public key, base64url (44 chars = 33 bytes).
    pub identity_key: String,
}

/// `isPairingPeerIdentity` — validates shape and the expected peer id.
pub fn is_pairing_peer_identity(value: &Value, expected_peer_id: Option<&str>) -> bool {
    let Some(o) = value.as_object() else { return false };
    let peer_id_ok = o.get("peerId").and_then(|v| v.as_str()).is_some_and(|s| {
        let b = s.as_bytes();
        !b.is_empty()
            && b.len() <= 128
            && b[0].is_ascii_alphanumeric()
            && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(*c, b'.' | b'_' | b':' | b'~' | b'-'))
            && expected_peer_id.is_none_or(|e| s == e)
    });
    peer_id_ok
        && o.get("signalDeviceId").and_then(|v| v.as_u64()) == Some(1)
        && o.get("registrationId")
            .and_then(|v| v.as_u64())
            .is_some_and(|n| (1..=0x3fff).contains(&n))
        && o.get("identityKey").and_then(|v| v.as_str()).is_some_and(|s| {
            s.len() == 44 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        })
}

/// A proof made by a device key already enrolled for the exact route/device —
/// `AccountDeviceAuthorityProof` in `contracts/account/authorization.ts`.
/// `nonce` is fresh per request; the signed transcript binds it to the route
/// and device.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDeviceAuthorityProof {
    pub purpose: String,
    pub tenant_id: String,
    pub route_id: String,
    pub device_id: String,
    pub nonce: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bootstrap_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_pin_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_digest: Option<String>,
    pub signature: String,
}

/// `accountDeviceAuthorityTranscript` — canonical Ed25519 signing input; the
/// verifier recomputes this exact newline-delimited transcript.
pub fn account_device_authority_transcript(p: &AccountDeviceAuthorityProof) -> String {
    [
        "meshrix-account-device-proof-v1",
        &p.purpose,
        &p.tenant_id,
        &p.route_id,
        &p.device_id,
        &p.nonce,
        p.bootstrap_id.as_deref().unwrap_or(""),
        p.endpoint_pin_ref.as_deref().unwrap_or(""),
        p.claim_id.as_deref().unwrap_or(""),
        p.permit_id.as_deref().unwrap_or(""),
        p.operation_id.as_deref().unwrap_or(""),
        p.request_digest.as_deref().unwrap_or(""),
        p.peer_device_id.as_deref().unwrap_or(""),
        p.target_digest.as_deref().unwrap_or(""),
    ]
    .join("\n")
}

/// `AccountDeviceCurrentBindingResponse` — answer of `deviceCurrentBinding`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDeviceCurrentBinding {
    pub account: AccountAuthorityBinding,
    pub target: Option<AccountActionTarget>,
    #[serde(default)]
    pub authorized_scopes: Vec<String>,
}

/// `isCurrentBinding` — strict shape validation of the authority response.
pub fn is_current_binding(value: &Value) -> bool {
    let Some(o) = value.as_object() else { return false };
    let binding_ok = o
        .get("account")
        .and_then(|a| a.as_object())
        .is_some_and(|a| {
            a.get("accountId").and_then(|v| v.as_str()).is_some()
                && a.get("authEpoch").and_then(|v| v.as_u64()).is_some_and(|n| n > 0)
        });
    let target_ok = match o.get("target") {
        None | Some(Value::Null) => true,
        Some(v) => {
            is_action_target(v)
                && v.get("deviceId")
                    .and_then(|d| d.as_str())
                    .is_some_and(|d| !d.is_empty())
        }
    };
    binding_ok
        && target_ok
        && o.get("authorizedScopes")
            .and_then(|v| v.as_array())
            .is_some_and(|a| a.iter().all(|s| s.is_string()))
}

/// The signed desktop-session proof attached to account API calls.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDesktopSessionProof {
    pub credential: String,
    pub client_public_key: String,
    pub nonce: String,
    pub body_digest: String,
    pub signature: String,
}

/// `accountDesktopSessionTranscript` — newline-joined transcript binding an
/// installed-client signature to its account session and exact HTTP
/// operation. `credentialDigest`/`bodyDigest` are base64url SHA-256 values.
pub fn account_desktop_session_transcript(
    method: &str,
    pathname: &str,
    account: &AccountAuthorityBinding,
    client_public_key: &str,
    credential_digest: &str,
    nonce: &str,
    body_digest: &str,
) -> String {
    [
        "meshrix-account-desktop-proof-v1",
        method,
        pathname,
        &account.account_id,
        &account.auth_epoch.to_string(),
        client_public_key,
        credential_digest,
        nonce,
        body_digest,
    ]
    .join("\n")
}

/* -------------------- vault writer rotation (desktop) -------------------- */

/// `AccountManagedVaultWriterKey` — one Ed25519 writer/verifier public key.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountManagedVaultWriterKey {
    pub key_id: String,
    pub algorithm: String,
    pub public_key: String,
}

/// `canonicalAccountVaultWriterRotationInput` — the exact JSON.stringify
/// ordering the account service hashes for the device possession proof.
pub fn canonical_account_vault_writer_rotation_input(
    operation_id: &str,
    vault_id: &str,
    writers: &[AccountManagedVaultWriterKey],
    recovery_verifier: &AccountManagedVaultWriterKey,
) -> String {
    let mut writers: Vec<AccountManagedVaultWriterKey> = writers.to_vec();
    writers.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    let key_json = |k: &AccountManagedVaultWriterKey| -> String {
        format!(
            "{{\"keyId\":{},\"algorithm\":{},\"publicKey\":{}}}",
            serde_json::to_string(&k.key_id).unwrap(),
            serde_json::to_string(&k.algorithm).unwrap(),
            serde_json::to_string(&k.public_key).unwrap(),
        )
    };
    let writer_list = writers
        .iter()
        .map(key_json)
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"operationId\":{},\"vaultId\":{},\"writers\":[{}],\"recoveryVerifier\":{}}}",
        serde_json::to_string(operation_id).unwrap(),
        serde_json::to_string(vault_id).unwrap(),
        writer_list,
        key_json(recovery_verifier),
    )
}
