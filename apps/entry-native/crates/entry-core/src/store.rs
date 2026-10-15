//! Owned configuration store — port of `config-store.ts`.
//!
//! Holds only non-secret facts: connection records (identifiers, pins,
//! counters), recovery bookkeeping (locator, key id, generation), custody ref
//! names and lifecycle metadata. Private keys, relay credentials, recovery
//! material and pairing tokens live in the custody adapter or in memory.
//! Written atomically (tmp+rename) so a crash never leaves a torn config.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::error::{entry_error, Result};
use crate::wire::account::{is_action_target, is_pairing_peer_identity, AccountActionTarget};
use crate::wire::common::{bounded_text, is_plain_object};
use crate::wire::recovery::{parse_encrypted_recovery_snapshot, peer_id_for_route_device};

pub const ENTRY_GUI_CONFIG_SCHEMA: &str = "entry-gui-config-1";
const CONFIG_FILE_NAME: &str = "entry-gui.config.json";

fn is_opaque_id(s: &str) -> bool {
    s.len() >= 2
        && s.len() <= 128
        && s.bytes().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b':'))
}

fn opaque(value: &Value) -> Option<String> {
    value.as_str().filter(|s| is_opaque_id(s)).map(String::from)
}

fn bounded(value: &Value, max: usize) -> Option<String> {
    bounded_text(value, max).filter(|s| !s.trim().is_empty())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConnection {
    pub connection_id: String,
    pub display_label: String,
    pub tenant_id: String,
    pub route_id: String,
    pub mode: String,
    pub endpoint_principal_ref: String,
    pub endpoint_device_id: Option<String>,
    /// Signal identity authenticated by the exact pairing completion receipt.
    pub endpoint_peer_identity: Option<Value>,
    pub endpoint_spki_pin: String,
    pub relay_service: String,
    pub vault_id: Option<String>,
    pub device_id: String,
    pub device_fingerprint: String,
    pub capability_grant_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_action_target: Option<AccountActionTarget>,
    /// Custody ref holding the relay bearer credential — never the credential.
    pub relay_credential_ref: String,
    pub bound_recovery_key_id: Option<String>,
    pub pairing_service: Option<String>,
    pub admission_generation: u64,
    pub revocation_revision: u64,
    pub enrolled_at: String,
    pub remote_revocation: String,
    pub route_revocation: Option<StoredRouteRevocation>,
    pub account_binding: Option<StoredAccountBinding>,
    pub re_pair_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pairing_completion_checkpoint_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRouteRevocation {
    pub operation_id: String,
    pub target: String,
    pub authority_revoked: bool,
    pub enforcement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccountBinding {
    pub account_id: String,
    pub auth_epoch: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccountClient {
    pub desktop_device_id: String,
    pub account_id: Option<String>,
    pub auth_epoch: Option<u64>,
    /// Display-only account email captured at sign-in; never an identity input.
    pub email: Option<String>,
    /// A ref only; the opaque credential is stored by the custody adapter.
    pub session_credential_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRecovery {
    pub vault_id: String,
    pub key_id: String,
    pub generation: u64,
    /// Custody ref holding derived writer/backup/signing material.
    pub material_ref: String,
    pub confirmed_at: String,
    pub account_writer_state: String,
    pub account_snapshot_state: String,
    pub snapshot_source_material_ref: Option<String>,
    /// Old private keys remain in OS custody for user-directed recovery.
    pub retained_material_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredVaultWriterOperation {
    pub operation_id: String,
    pub connection_id: String,
    pub vault_id: String,
    pub candidate_key_id: String,
    pub generation: u64,
    pub material_ref: String,
    /// Ref to the exact retryable request/transaction, stored in OS custody.
    pub flow_ref: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRotationEndpoint {
    pub endpoint_route_id: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRotationOutbound {
    pub endpoint_route_id: String,
    /// Replayable rotation-begin payload — public keys + signatures only.
    pub message: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRotation {
    pub rotation_id: String,
    pub incumbent_key_id: String,
    pub incumbent_generation: u64,
    pub candidate_key_id: String,
    pub candidate_public_key: String,
    pub candidate_generation: u64,
    pub principal_ref: String,
    pub state: String,
    pub endpoints: Vec<StoredRotationEndpoint>,
    pub outbound: Vec<StoredRotationOutbound>,
    pub started_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSnapshotWrite {
    pub vault_id: String,
    pub writer_key_id: String,
    pub generation: u64,
    pub expected_revision: u64,
    pub input_digest: String,
    pub snapshot: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSnapshotJournal {
    pub pending_write: Option<PendingSnapshotWrite>,
    pub last_committed: Option<JournalCommit>,
    pub highest_seen: Option<JournalSeen>,
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalCommit {
    pub revision: u64,
    pub generation: u64,
    pub digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalSeen {
    pub revision: u64,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMcp {
    pub managed_config_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryGuiConfig {
    pub schema_version: String,
    pub profile: StoredProfile,
    pub connections: Vec<StoredConnection>,
    pub recovery: Option<StoredRecovery>,
    pub account_vault_writer_operation: Option<StoredVaultWriterOperation>,
    pub journal: Option<StoredSnapshotJournal>,
    pub rotations: Vec<StoredRotation>,
    pub mcp: StoredMcp,
    pub pairing_service_default: Option<String>,
    /// Opaque pointer only; the replayable pairing request lives in custody.
    pub pairing_completion_checkpoint_ref: Option<String>,
    /// Entry device identity minted for the in-flight pairing. Retries reuse
    /// it so the account authority replays the same bootstrap instead of
    /// conflicting on a fresh device. Cleared when a pairing completes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_pairing_device_id: Option<String>,
    pub account: Option<StoredAccountClient>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProfile {
    pub display_label: String,
}

pub fn empty_entry_gui_config() -> EntryGuiConfig {
    EntryGuiConfig {
        schema_version: ENTRY_GUI_CONFIG_SCHEMA.into(),
        profile: StoredProfile { display_label: "Meshrix Entry".into() },
        connections: Vec::new(),
        recovery: None,
        account_vault_writer_operation: None,
        journal: None,
        rotations: Vec::new(),
        mcp: StoredMcp { managed_config_path: None },
        pairing_service_default: None,
        pairing_completion_checkpoint_ref: None,
        pending_pairing_device_id: None,
        account: None,
    }
}

fn checkpoint_ref(value: &Value) -> Option<String> {
    value.as_str().filter(|s| {
        s.len() == 32 + "entry-gui.pairing.completion.".len()
            && s.starts_with("entry-gui.pairing.completion.")
            && s["entry-gui.pairing.completion.".len()..]
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    }).map(String::from)
}

fn parse_stored_connection(value: &Value) -> Option<StoredConnection> {
    if !is_plain_object(value) {
        return None;
    }
    let connection_id = opaque(value.get("connectionId")?)?;
    let device_id = opaque(value.get("deviceId")?)?;
    let device_fingerprint = opaque(value.get("deviceFingerprint")?)?;
    let tenant_id = opaque(value.get("tenantId")?)?;
    let route_id = opaque(value.get("routeId")?)?;
    let principal = opaque(value.get("endpointPrincipalRef")?)?;
    let endpoint_device_id = value.get("endpointDeviceId").and_then(|v| {
        if v.is_null() {
            Some(None)
        } else {
            opaque(v).map(Some)
        }
    })?;
    let expected_peer = peer_id_for_route_device(
        &tenant_id,
        &route_id,
        endpoint_device_id.as_deref().unwrap_or(""),
    );
    let peer_value = value.get("endpointPeerIdentity");
    let endpoint_peer_identity = match peer_value {
        None | Some(Value::Null) => None,
        Some(v) => match &expected_peer {
            Some(expected) if is_pairing_peer_identity(v, Some(expected)) => Some(v.clone()),
            _ => return None,
        },
    };
    let route_revocation_value = value.get("routeRevocation");
    let route_revocation = match route_revocation_value {
        None | Some(Value::Null) => None,
        Some(v) => {
            let operation_id = opaque(v.get("operationId")?)?;
            let target = v.get("target")?.as_str()?;
            let enforcement = v.get("enforcement")?.as_str()?;
            let authority_revoked = v.get("authorityRevoked")?.as_bool()?;
            if (target != "route" && target != "device")
                || (enforcement != "pending" && enforcement != "complete")
            {
                return None;
            }
            Some(StoredRouteRevocation {
                operation_id,
                target: target.into(),
                authority_revoked,
                enforcement: enforcement.into(),
            })
        }
    };
    let spki_pin = bounded(value.get("endpointSpkiPin")?, 128)?;
    let relay_service = bounded(value.get("relayService")?, 512)?;
    let relay_credential_ref = opaque(value.get("relayCredentialRef")?)?;
    let account_action_target = match value.get("accountActionTarget") {
        None | Some(Value::Null) => None,
        Some(v) if is_action_target(v) => serde_json::from_value(v.clone()).ok(),
        Some(_) => None,
    };
    Some(StoredConnection {
        connection_id: connection_id.clone(),
        display_label: bounded(value.get("displayLabel").unwrap_or(&Value::Null), 128)
            .unwrap_or_else(|| connection_id.clone()),
        tenant_id,
        route_id,
        mode: match value.get("mode").and_then(|v| v.as_str()) {
            Some("enterprise") => "enterprise".into(),
            _ => "personal".into(),
        },
        endpoint_principal_ref: principal,
        endpoint_device_id,
        endpoint_peer_identity,
        endpoint_spki_pin: spki_pin,
        relay_service,
        vault_id: value.get("vaultId").and_then(|v| if v.is_null() { None } else { opaque(v) }),
        device_id,
        device_fingerprint,
        capability_grant_ref: opaque(value.get("capabilityGrantRef").unwrap_or(&Value::Null))
            .unwrap_or_else(|| "none".into()),
        account_action_target,
        relay_credential_ref,
        bound_recovery_key_id: value
            .get("boundRecoveryKeyId")
            .and_then(|v| if v.is_null() { None } else { opaque(v) }),
        pairing_service: value
            .get("pairingService")
            .and_then(|v| if v.is_null() { None } else { bounded(v, 512) }),
        admission_generation: value.get("admissionGeneration").and_then(|v| v.as_u64()).unwrap_or(1),
        revocation_revision: value.get("revocationRevision").and_then(|v| v.as_u64()).unwrap_or(0),
        enrolled_at: bounded(value.get("enrolledAt").unwrap_or(&Value::Null), 64).unwrap_or_default(),
        remote_revocation: match value.get("remoteRevocation").and_then(|v| v.as_str()) {
            Some("pending") => "pending".into(),
            Some("applied") => "applied".into(),
            _ => "none".into(),
        },
        route_revocation,
        account_binding: value.get("accountBinding").and_then(|v| {
            let account_id = v.get("accountId")?.as_str()?.to_string();
            let auth_epoch = v.get("authEpoch")?.as_u64()?;
            Some(StoredAccountBinding { account_id, auth_epoch })
        }),
        re_pair_required: value.get("rePairRequired").and_then(|v| v.as_bool()).unwrap_or(false),
        pairing_completion_checkpoint_ref: value.get("pairingCompletionCheckpointRef").and_then(checkpoint_ref),
    })
}

fn parse_stored_account(value: &Value) -> Option<StoredAccountClient> {
    if !is_plain_object(value) {
        return None;
    }
    let desktop_device_id = opaque(value.get("desktopDeviceId")?)?;
    let account_id = value.get("accountId").and_then(|v| if v.is_null() { None } else { opaque(v) });
    let auth_epoch = value.get("authEpoch").and_then(|v| if v.is_null() { None } else { v.as_u64() });
    if account_id.is_none() != auth_epoch.is_none() || auth_epoch.is_some_and(|e| e < 1) {
        return None;
    }
    Some(StoredAccountClient {
        desktop_device_id,
        account_id,
        auth_epoch,
        email: value.get("email").and_then(|v| v.as_str().map(String::from)),
        session_credential_ref: value
            .get("sessionCredentialRef")
            .and_then(|v| if v.is_null() { None } else { opaque(v) }),
    })
}

fn parse_vault_writer_operation(value: &Value) -> Option<StoredVaultWriterOperation> {
    if !is_plain_object(value) {
        return None;
    }
    let state = value.get("state")?.as_str()?;
    if !matches!(state, "prepare_pending" | "authorization_required" | "completion_pending") {
        return None;
    }
    Some(StoredVaultWriterOperation {
        operation_id: opaque(value.get("operationId")?)?,
        connection_id: opaque(value.get("connectionId")?)?,
        vault_id: opaque(value.get("vaultId")?)?,
        candidate_key_id: opaque(value.get("candidateKeyId")?)?,
        generation: value.get("generation").and_then(|v| v.as_u64()).filter(|g| *g >= 1)?,
        material_ref: opaque(value.get("materialRef")?)?,
        flow_ref: opaque(value.get("flowRef")?)?,
        state: state.into(),
    })
}

fn parse_journal(value: &Value) -> Option<StoredSnapshotJournal> {
    if !is_plain_object(value) {
        return None;
    }
    let pending = value.get("pendingWrite").filter(|v| is_plain_object(v));
    let pending_write = pending.and_then(|p| {
        let envelope = parse_encrypted_recovery_snapshot(p.get("snapshot")?)?;
        let writer_key_id = p.get("writerKeyId")?.as_str()?.to_string();
        if writer_key_id.len() > 128 {
            return None;
        }
        let expected_revision = p.get("expectedRevision")?.as_u64()?;
        let vault_id = envelope.get("vaultId")?.as_str()?.to_string();
        let generation = envelope.get("generation")?.as_u64()?;
        let revision = envelope.get("revision")?.as_u64()?;
        let input_digest = p.get("inputDigest")?.as_str()?;
        if p.get("vaultId")?.as_str() != Some(vault_id.as_str())
            || p.get("generation")?.as_u64() != Some(generation)
            || expected_revision + 1 != revision
            || input_digest.len() != 64
            || !input_digest.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return None;
        }
        Some(PendingSnapshotWrite {
            vault_id,
            writer_key_id,
            generation,
            expected_revision,
            input_digest: input_digest.into(),
            snapshot: p.get("snapshot")?.clone(),
        })
    });
    Some(StoredSnapshotJournal {
        pending_write,
        last_committed: value.get("lastCommitted").and_then(|v| {
            Some(JournalCommit {
                revision: v.get("revision")?.as_u64()?,
                generation: v.get("generation")?.as_u64().unwrap_or(1),
                digest: bounded(v.get("digest")?, 128).unwrap_or_default(),
            })
        }),
        highest_seen: value.get("highestSeen").and_then(|v| {
            Some(JournalSeen {
                revision: v.get("revision")?.as_u64()?,
                generation: v.get("generation")?.as_u64().unwrap_or(1),
            })
        }),
        last_success_at: value.get("lastSuccessAt").and_then(|v| bounded(v, 64)),
        last_error: value.get("lastError").and_then(|v| bounded(v, 256)),
    })
}

fn parse_rotation(value: &Value) -> Option<StoredRotation> {
    if !is_plain_object(value) {
        return None;
    }
    let rotation_id = opaque(value.get("rotationId")?)?;
    let incumbent_key_id = opaque(value.get("incumbentKeyId")?)?;
    let candidate_key_id = opaque(value.get("candidateKeyId")?)?;
    let principal_ref = opaque(value.get("principalRef")?)?;
    let state = match value.get("state").and_then(|v| v.as_str()) {
        Some(s) if matches!(s, "staged" | "published" | "acknowledging" | "completed" | "aborted") => s,
        _ => "staged",
    };
    let endpoints = value
        .get("endpoints")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let route_id = opaque(e.get("endpointRouteId")?)?;
                    Some(StoredRotationEndpoint {
                        endpoint_route_id: route_id,
                        state: bounded(e.get("state")?, 32).unwrap_or_else(|| "staged".into()),
                        detail: e.get("detail").and_then(|d| bounded(d, 256)),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let outbound = value
        .get("outbound")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let route_id = opaque(e.get("endpointRouteId")?)?;
                    if !is_plain_object(e.get("message")?) {
                        return None;
                    }
                    Some(StoredRotationOutbound {
                        endpoint_route_id: route_id,
                        message: e.get("message")?.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(StoredRotation {
        rotation_id,
        incumbent_key_id,
        incumbent_generation: value.get("incumbentGeneration").and_then(|v| v.as_u64()).unwrap_or(1),
        candidate_key_id,
        candidate_public_key: bounded(value.get("candidatePublicKey")?, 128).unwrap_or_default(),
        candidate_generation: value.get("candidateGeneration").and_then(|v| v.as_u64()).unwrap_or(2),
        principal_ref,
        state: state.into(),
        endpoints,
        outbound,
        started_at: bounded(value.get("startedAt")?, 64).unwrap_or_default(),
        updated_at: bounded(value.get("updatedAt")?, 64).unwrap_or_default(),
    })
}

/// Strict parse — unknown/malformed stored facts are dropped, never trusted.
pub fn parse_entry_gui_config(value: &Value) -> Option<EntryGuiConfig> {
    if !is_plain_object(value) || value.get("schemaVersion")?.as_str() != Some(ENTRY_GUI_CONFIG_SCHEMA) {
        return None;
    }
    let connections: Vec<StoredConnection> = value
        .get("connections")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(parse_stored_connection).collect())
        .unwrap_or_default();
    // A re-pair of the same endpoint principal must not produce twins —
    // older entries lose to the newest record (the latest enrollment owns
    // the live admission and credential slot).
    let mut deduped: Vec<StoredConnection> = Vec::with_capacity(connections.len());
    for conn in connections {
        if let Some(slot) = deduped
            .iter_mut()
            .find(|c| c.endpoint_principal_ref == conn.endpoint_principal_ref)
        {
            *slot = conn;
        } else {
            deduped.push(conn);
        }
    }
    let connections = deduped;
    let recovery = value.get("recovery").and_then(|v| {
        if !is_plain_object(v) {
            return None;
        }
        let account_writer_state = match v.get("accountWriterState").and_then(|s| s.as_str()) {
            Some("pending") => "pending".into(),
            Some("complete") => "complete".into(),
            _ => "unmanaged".into(),
        };
        let account_snapshot_state = match v.get("accountSnapshotState").and_then(|s| s.as_str()) {
            Some("unverified") => "unverified".into(),
            Some("older_snapshot_preserved") => "older_snapshot_preserved".into(),
            _ => "ready".into(),
        };
        Some(StoredRecovery {
            vault_id: opaque(v.get("vaultId")?)?,
            key_id: opaque(v.get("keyId")?)?,
            generation: v.get("generation").and_then(|g| g.as_u64()).unwrap_or(1),
            material_ref: opaque(v.get("materialRef")?)?,
            confirmed_at: bounded(v.get("confirmedAt")?, 64).unwrap_or_default(),
            account_writer_state,
            account_snapshot_state,
            snapshot_source_material_ref: v
                .get("snapshotSourceMaterialRef")
                .and_then(|s| if s.is_null() { None } else { opaque(s) }),
            retained_material_refs: v
                .get("retainedMaterialRefs")
                .and_then(|r| r.as_array())
                .map(|arr| arr.iter().filter_map(opaque).collect())
                .unwrap_or_default(),
        })
    });
    let mcp_path = value
        .get("mcp")
        .and_then(|m| m.get("managedConfigPath"))
        .and_then(|p| if p.is_null() { None } else { bounded(p, 1024) });
    Some(EntryGuiConfig {
        schema_version: ENTRY_GUI_CONFIG_SCHEMA.into(),
        profile: StoredProfile {
            display_label: value
                .get("profile")
                .and_then(|p| p.get("displayLabel"))
                .and_then(|l| bounded(l, 128))
                .unwrap_or_else(|| "Meshrix Entry".into()),
        },
        connections,
        recovery,
        account_vault_writer_operation: value.get("accountVaultWriterOperation").and_then(parse_vault_writer_operation),
        journal: value.get("journal").and_then(parse_journal),
        rotations: value
            .get("rotations")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(parse_rotation).collect())
            .unwrap_or_default(),
        mcp: StoredMcp { managed_config_path: mcp_path },
        pairing_service_default: value
            .get("pairingServiceDefault")
            .and_then(|v| if v.is_null() { None } else { bounded(v, 512) }),
                    pairing_completion_checkpoint_ref: value.get("pairingCompletionCheckpointRef").and_then(checkpoint_ref),
        pending_pairing_device_id: value
            .get("pendingPairingDeviceId")
            .and_then(|v| if v.is_null() { None } else { opaque(v) }),
        account: value.get("account").and_then(parse_stored_account),
    })
}

/// The single JSON document the app persists — serialized write queue,
/// tmp+rename atomicity, 0600 permissions.
pub struct EntryConfigStore {
    pub file_path: PathBuf,
    config: EntryGuiConfig,
    write_mutex: std::sync::Arc<std::sync::Mutex<()>>,
    /// Mtime of the file as last loaded or written — detects external writes.
    file_mtime: Option<std::time::SystemTime>,
}

fn config_file_mtime(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

impl EntryConfigStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            file_path: data_dir.join(CONFIG_FILE_NAME),
            config: empty_entry_gui_config(),
            write_mutex: std::sync::Arc::new(std::sync::Mutex::new(())),
            file_mtime: None,
        }
    }

    pub fn config(&self) -> &EntryGuiConfig {
        &self.config
    }

    /// Load and strictly parse; a missing or malformed file resets to empty.
    pub fn load(&mut self) -> Result<&EntryGuiConfig> {
        match std::fs::read_to_string(&self.file_path) {
            Ok(text) => {
                let parsed: Value = serde_json::from_str(&text).map_err(|e| {
                    entry_error("config_parse_failed", "The stored config is not valid JSON.").caused_by(e)
                })?;
                self.config = parse_entry_gui_config(&parsed).unwrap_or_else(empty_entry_gui_config);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.config = empty_entry_gui_config();
            }
            Err(e) => return Err(e.into()),
        }
        self.file_mtime = config_file_mtime(&self.file_path);
        Ok(&self.config)
    }

    /// Merge a fresh disk read over the in-memory state. Missing files keep
    /// the current state (an external writer may be mid-remove); unparsable
    /// files surface the error instead of being overwritten blindly.
    pub fn reload(&mut self) -> Result<&EntryGuiConfig> {
        let text = match std::fs::read_to_string(&self.file_path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(&self.config),
            Err(e) => return Err(e.into()),
        };
        let parsed: Value = serde_json::from_str(&text).map_err(|e| {
            entry_error("config_parse_failed", "The stored config is not valid JSON.").caused_by(e)
        })?;
        if let Some(config) = parse_entry_gui_config(&parsed) {
            self.config = config;
        }
        self.file_mtime = config_file_mtime(&self.file_path);
        Ok(&self.config)
    }

    /// Reload only when the on-disk file changed since our last load or write.
    /// Returns true when in-memory state was refreshed.
    pub fn reload_if_changed(&mut self) -> Result<bool> {
        let on_disk = config_file_mtime(&self.file_path);
        if on_disk.is_none() || on_disk == self.file_mtime {
            return Ok(false);
        }
        self.reload().map(|_| true)
    }

    /// Mutate-and-persist; the file is rewritten atomically behind a mutex so
    /// concurrent updates never interleave. The on-disk state is merged in
    /// first so a stale snapshot can never clobber another writer's records.
    pub fn update(&mut self, mutate: impl FnOnce(&mut EntryGuiConfig)) -> Result<()> {
        let write_mutex = self.write_mutex.clone();
        let _guard = write_mutex.lock().unwrap();
        self.reload()?;
        mutate(&mut self.config);
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let payload = format!("{}\n", serde_json::to_string_pretty(&self.config)?);
        let tmp = self
            .file_path
            .with_extension(format!("{}.tmp", std::process::id()));
        std::fs::write(&tmp, payload)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&tmp, &self.file_path)?;
        self.file_mtime = config_file_mtime(&self.file_path);
        Ok(())
    }

    /// Remove the owned config file (revoke/uninstall paths).
    pub fn remove(&self) -> Result<()> {
        match std::fs::remove_file(&self.file_path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other.map_err(|e| entry_error("config_store_remove_failed", "The configuration file could not be removed.").caused_by(e)),
        }
    }
}
