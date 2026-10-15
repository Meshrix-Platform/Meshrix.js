//! Typed plaintext carried inside an EncryptedRecoverySnapshot — port of
//! `bundle.ts`. Recoverable objects only: profile identity + display
//! settings, named connection/routing configuration with prior trusted peer
//! references, and non-secret MCP preferences. Private keys, TLS keys,
//! credentials, grants and upstream secrets are never serialized — a
//! forbidden key is a bug, not a feature.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use crate::error::{entry_error, Result};
use crate::wire::common::*;

pub const ENTRY_BUNDLE_SCHEMA: &str = "v0.0.1:entry:recovery-bundle-1";
pub const ENTRY_BUNDLE_KIND: &str = "entry-recovery-bundle";
const MAX_TEXT_BYTES: usize = 256;
const MAX_CONNECTIONS: usize = 64;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleRecoveryAuthority {
    pub key_id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleConnection {
    /// Local connection identifier (opaque, non-secret).
    pub connection_id: String,
    /// Human-facing name shown in the connection list.
    pub display_label: String,
    pub route_id: String,
    pub tenant_id: String,
    pub mode: String,
    /// Endpoint SPKI pin — the trust anchor to re-validate, not a grant.
    pub endpoint_spki_pin: String,
    pub principal_ref: String,
    /// Relay service base URL for reaching this endpoint's relay route.
    pub relay_service: String,
    pub vault_id: String,
    pub trust_generation: u64,
    pub admission_generation: u64,
    pub revocation_revision: u64,
    /// Enrolled recovery authority reference observed at last contact.
    pub recovery_authority: Option<BundleRecoveryAuthority>,
}

#[derive(Debug, Clone)]
pub struct EntryRecoveryBundle {
    pub created_at: String,
    pub profile_ref: String,
    pub display_label: String,
    pub connections: Vec<BundleConnection>,
    pub pairing_preferences: Option<Value>,
}

impl EntryRecoveryBundle {
    pub fn to_json(&self) -> Value {
        json!({
            "schemaVersion": ENTRY_BUNDLE_SCHEMA,
            "kind": ENTRY_BUNDLE_KIND,
            "createdAt": self.created_at,
            "profileRef": self.profile_ref,
            "displayLabel": self.display_label,
            "connections": self.connections,
            "pairingPreferences": self.pairing_preferences.clone().unwrap_or(Value::Null),
        })
    }
}

fn parse_authority(value: &Value) -> Option<Option<BundleRecoveryAuthority>> {
    if value.is_null() {
        return Some(None);
    }
    if !has_exact_keys(value, &["generation", "keyId"]) {
        return None;
    }
    let key_id = opaque_id(value.get("keyId")?, OPAQUE_ID_MAX)?;
    let generation = value.get("generation")?.as_u64()?;
    if generation < 1 {
        return None;
    }
    Some(Some(BundleRecoveryAuthority { key_id, generation }))
}

fn parse_connection(value: &Value) -> Option<BundleConnection> {
    if !has_exact_keys(
        value,
        &[
            "admissionGeneration", "connectionId", "displayLabel", "endpointSpkiPin", "mode",
            "principalRef", "recoveryAuthority", "relayService", "revocationRevision", "routeId",
            "tenantId", "trustGeneration", "vaultId",
        ],
    ) {
        return None;
    }
    let o = value.as_object()?;
    let mode = match get(o, "mode").as_str()? {
        "personal" => "personal",
        "enterprise" => "enterprise",
        _ => return None,
    };
    Some(BundleConnection {
        connection_id: opaque_id(get(o, "connectionId"), OPAQUE_ID_MAX)?,
        display_label: bounded_text(get(o, "displayLabel"), MAX_TEXT_BYTES)?,
        route_id: opaque_id(get(o, "routeId"), OPAQUE_ID_MAX)?,
        tenant_id: opaque_id(get(o, "tenantId"), OPAQUE_ID_MAX)?,
        mode: mode.into(),
        endpoint_spki_pin: bounded_text(get(o, "endpointSpkiPin"), 96)?,
        principal_ref: opaque_id(get(o, "principalRef"), OPAQUE_ID_MAX)?,
        relay_service: bounded_text(get(o, "relayService"), 512)?,
        vault_id: opaque_id(get(o, "vaultId"), OPAQUE_ID_MAX)?,
        trust_generation: positive_revision(get(o, "trustGeneration"))?,
        admission_generation: positive_revision(get(o, "admissionGeneration"))?,
        revocation_revision: revision(get(o, "revocationRevision"))?,
        recovery_authority: parse_authority(get(o, "recoveryAuthority"))?,
    })
}

pub fn parse_entry_recovery_bundle(value: &Value) -> Option<EntryRecoveryBundle> {
    if !has_exact_keys(
        value,
        &[
            "connections", "createdAt", "displayLabel", "kind", "pairingPreferences", "profileRef",
            "schemaVersion",
        ],
    ) {
        return None;
    }
    let o = value.as_object()?;
    if get(o, "schemaVersion").as_str() != Some(ENTRY_BUNDLE_SCHEMA)
        || get(o, "kind").as_str() != Some(ENTRY_BUNDLE_KIND)
    {
        return None;
    }
    let created_at = bounded_text(get(o, "createdAt"), 64)?;
    chrono::DateTime::parse_from_rfc3339(&created_at).ok()?;
    let connections_value = get(o, "connections").as_array()?;
    if connections_value.len() > MAX_CONNECTIONS {
        return None;
    }
    let mut connections = Vec::with_capacity(connections_value.len());
    let mut seen = HashSet::new();
    for entry in connections_value {
        let connection = parse_connection(entry)?;
        if !seen.insert(connection.connection_id.clone()) {
            return None;
        }
        connections.push(connection);
    }
    let pairing_preferences = if get(o, "pairingPreferences").is_null() {
        None
    } else {
        let prefs = get(o, "pairingPreferences");
        if !prefs.is_object() {
            return None;
        }
        let mut clean = serde_json::Map::new();
        if let Some(mode) = prefs.get("mcpDisplayMode").and_then(|v| v.as_str()) {
            if let Some(text) = bounded_text(&Value::String(mode.into()), 64) {
                clean.insert("mcpDisplayMode".into(), text.into());
            }
        }
        Some(Value::Object(clean))
    };
    Some(EntryRecoveryBundle {
        created_at,
        profile_ref: opaque_id(get(o, "profileRef"), OPAQUE_ID_MAX)?,
        display_label: bounded_text(get(o, "displayLabel"), MAX_TEXT_BYTES)?,
        connections,
        pairing_preferences,
    })
}

/// Fail loudly when a caller hands us material the contract forbids.
pub fn assert_bundle_recoverable(bundle: &Value) -> Result<()> {
    if contains_forbidden_snapshot_keys(bundle) {
        return Err(entry_error(
            "snapshot_malformed",
            "Recovery bundles must not contain secrets, keys, grants or upstream material.",
        ));
    }
    Ok(())
}

pub fn build_entry_recovery_bundle(
    profile_ref: &str,
    display_label: &str,
    connections: Vec<BundleConnection>,
    pairing_preferences: Option<Value>,
) -> Result<EntryRecoveryBundle> {
    let candidate = EntryRecoveryBundle {
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        profile_ref: profile_ref.into(),
        display_label: display_label.into(),
        connections,
        pairing_preferences,
    };
    let as_json = candidate.to_json();
    let parsed = parse_entry_recovery_bundle(&as_json).ok_or_else(|| {
        entry_error("snapshot_malformed", "Recovery bundle does not satisfy the entry schema.")
    })?;
    assert_bundle_recoverable(&as_json)?;
    Ok(parsed)
}

/// Merge two decryptable bundles on CAS conflict — never a blind overwrite.
pub fn merge_recovery_bundles(
    local: &EntryRecoveryBundle,
    remote: &EntryRecoveryBundle,
) -> Result<EntryRecoveryBundle> {
    let mut merged: HashMap<String, BundleConnection> = HashMap::new();
    for connection in &remote.connections {
        merged.insert(connection.connection_id.clone(), connection.clone());
    }
    for connection in &local.connections {
        match merged.get(&connection.connection_id) {
            Some(existing) if existing.trust_generation > connection.trust_generation => {}
            _ => {
                merged.insert(connection.connection_id.clone(), connection.clone());
            }
        }
    }
    let local_time = chrono::DateTime::parse_from_rfc3339(&local.created_at)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0);
    let remote_time = chrono::DateTime::parse_from_rfc3339(&remote.created_at)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0);
    let winner = if local_time >= remote_time { local } else { remote };
    build_entry_recovery_bundle(
        &winner.profile_ref,
        &winner.display_label,
        merged.into_values().collect(),
        winner.pairing_preferences.clone(),
    )
}
