//! Pairing invite artifact — port of `pairing-invite.ts`.
//!
//! Wire shape: `meshrix-entry://pair#<base64url(canonical-json invite)>` or
//! the raw JSON object. The invite carries endpoint reachability + trust
//! anchors and a one-time pairing token — never private material.

use serde_json::Value;

use crate::b64::{b64u_decode, b64u_encode};
use crate::canonical::canonical_json;
use crate::error::{entry_error, Result};
use crate::wire::common::*;
use crate::wire::recovery::PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION;

pub const ENTRY_PAIRING_SCHEMA: &str = "v0.0.1:entry:pairing-invite-2";
pub const ENTRY_PAIRING_KIND: &str = "entry-pairing-invite";
pub const ENTRY_PAIRING_URI_PREFIX: &str = "meshrix-entry://pair#";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRecoveryAuthority {
    pub key_id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInvite {
    pub schema_version: &'static str,
    pub kind: &'static str,
    pub invite_id: String,
    pub endpoint_route_id: String,
    pub tenant_id: String,
    pub mode: String,
    pub endpoint_device_id: String,
    pub endpoint_principal_ref: String,
    pub endpoint_spki_pin: String,
    pub endpoint_pin_ref: String,
    pub relay_service: String,
    pub vault_id: String,
    /// Human label of the endpoint device (OS hostname). Display-only —
    /// pairing identity stays on the principal/device ids.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_label: Option<String>,
    pub recovery_authority: Option<PairingRecoveryAuthority>,
    pub issued_at: String,
    pub expires_at: String,
    /// One-time bearer proving invite legitimacy — sent to the endpoint once,
    /// never persisted into the device record.
    pub pairing_token: String,
}

fn parse_invite(value: &Value) -> Option<PairingInvite> {
    const BASE_KEYS: &[&str] = &[
        "endpointDeviceId", "endpointPinRef", "endpointPrincipalRef", "endpointRouteId",
        "endpointSpkiPin", "expiresAt", "inviteId", "issuedAt", "kind", "mode", "pairingToken",
        "recoveryAuthority", "relayService", "schemaVersion", "tenantId", "vaultId",
    ];
    let o = value.as_object()?;
    let keyset_ok = has_exact_keys(value, BASE_KEYS)
        || (o.len() == BASE_KEYS.len() + 1
            && o.contains_key("endpointLabel")
            && BASE_KEYS.iter().all(|k| o.contains_key(*k)));
    if !keyset_ok {
        return None;
    }
    if get(o, "schemaVersion").as_str() != Some(ENTRY_PAIRING_SCHEMA)
        || get(o, "kind").as_str() != Some(ENTRY_PAIRING_KIND)
    {
        return None;
    }
    let endpoint_spki_pin = bounded_text(get(o, "endpointSpkiPin"), 128)?;
    let endpoint_pin_ref = bounded_text(get(o, "endpointPinRef"), 128)?;
    if endpoint_pin_ref != endpoint_spki_pin {
        return None;
    }
    let issued_at = instant_value(get(o, "issuedAt"))?;
    let expires_at = instant_value(get(o, "expiresAt"))?;
    let issued = chrono::DateTime::parse_from_rfc3339(&issued_at).ok()?;
    let expiry = chrono::DateTime::parse_from_rfc3339(&expires_at).ok()?;
    if expiry <= issued {
        return None;
    }
    let mode = match get(o, "mode").as_str()? {
        "personal" => "personal",
        "enterprise" => "enterprise",
        _ => return None,
    };
    let recovery_authority = if get(o, "recoveryAuthority").is_null() {
        None
    } else {
        let ra = get(o, "recoveryAuthority");
        let key_id = opaque_id(ra.get("keyId")?, OPAQUE_ID_MAX)?;
        let generation = positive_revision(ra.get("generation")?)?;
        Some(PairingRecoveryAuthority { key_id, generation })
    };
    Some(PairingInvite {
        schema_version: ENTRY_PAIRING_SCHEMA,
        kind: ENTRY_PAIRING_KIND,
        invite_id: opaque_id(get(o, "inviteId"), OPAQUE_ID_MAX)?,
        endpoint_route_id: opaque_id(get(o, "endpointRouteId"), OPAQUE_ID_MAX)?,
        tenant_id: opaque_id(get(o, "tenantId"), OPAQUE_ID_MAX)?,
        mode: mode.into(),
        endpoint_device_id: opaque_id(get(o, "endpointDeviceId"), OPAQUE_ID_MAX)?,
        endpoint_principal_ref: opaque_id(get(o, "endpointPrincipalRef"), OPAQUE_ID_MAX)?,
        endpoint_spki_pin,
        endpoint_pin_ref,
        relay_service: bounded_text(get(o, "relayService"), 512)?,
        vault_id: opaque_id(get(o, "vaultId"), OPAQUE_ID_MAX)?,
        endpoint_label: if o.contains_key("endpointLabel") {
            Some(bounded_text(get(o, "endpointLabel"), 64)?)
        } else {
            None
        },
        recovery_authority,
        issued_at,
        expires_at,
        pairing_token: bounded_text(get(o, "pairingToken"), 256)?,
    })
}

impl PairingInvite {
    pub fn is_expired(&self) -> bool {
        chrono::DateTime::parse_from_rfc3339(&self.expires_at)
            .map(|e| e <= chrono::Utc::now())
            .unwrap_or(true)
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// Parse a decoded invite object — no expiry check; callers that need one
/// (deep-link intake) use `parse_pairing_invite_text` instead.
pub fn parse_pairing_invite_json(value: &Value) -> Option<PairingInvite> {
    parse_invite(value)
}

/// Accept the deep-link form or raw JSON text. Unknown prefixes and malformed
/// bodies fail with `pairing_invite_invalid`; an expired invite fails with
/// `pairing_expired`.
pub fn parse_pairing_invite_text(text: &str) -> Result<PairingInvite> {
    let trimmed = text.trim();
    let body: Value = if let Some(encoded) = trimmed.strip_prefix(ENTRY_PAIRING_URI_PREFIX) {
        if encoded.is_empty()
            || !encoded.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return Err(entry_error("pairing_invite_invalid", "Pairing payload is not base64url."));
        }
        let bytes = b64u_decode(encoded, 64 * 1024)
            .map_err(|_| entry_error("pairing_invite_invalid", "Pairing payload does not decode to JSON."))?;
        serde_json::from_slice(&bytes)
            .map_err(|_| entry_error("pairing_invite_invalid", "Pairing payload does not decode to JSON."))?
    } else {
        serde_json::from_str(trimmed).map_err(|_| {
            entry_error(
                "pairing_invite_invalid",
                "Pairing payload is neither a pairing URI nor JSON.",
            )
        })?
    };
    let invite = parse_invite(&body).ok_or_else(|| {
        entry_error(
            "pairing_invite_invalid",
            "Pairing payload does not satisfy the invite schema.",
        )
    })?;
    if invite.is_expired() {
        return Err(entry_error("pairing_expired", "Pairing invite has expired."));
    }
    Ok(invite)
}

/// Serialize an invite into the deep-link payload form.
pub fn encode_pairing_invite(invite: &PairingInvite) -> String {
    format!(
        "{}{}",
        ENTRY_PAIRING_URI_PREFIX,
        b64u_encode(canonical_json(&invite.to_json()).as_bytes())
    )
}

/// Map a validated invite + fresh device identity to the wire
/// `endpoint-trust-binding` shape.
pub fn invite_to_trust_binding(
    invite: &PairingInvite,
    device_public_key: &str,
    device_fingerprint: &str,
    capability_grant_ref: &str,
    bound_recovery_key_id: Option<&str>,
) -> Value {
    serde_json::json!({
        "schemaVersion": PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
        "kind": "endpoint-trust-binding",
        "pairedIdentityKey": device_public_key,
        "pairedIdentityFingerprint": device_fingerprint,
        "mode": invite.mode,
        "role": "entry",
        "trustGeneration": invite.recovery_authority.as_ref().map(|a| a.generation).unwrap_or(1),
        "endpointPrincipalRef": invite.endpoint_principal_ref,
        "capabilityGrantRef": capability_grant_ref,
        "boundRecoveryKeyId": bound_recovery_key_id
            .map(|s| s.to_string())
            .or_else(|| invite.recovery_authority.as_ref().map(|a| a.key_id.clone())),
    })
}
