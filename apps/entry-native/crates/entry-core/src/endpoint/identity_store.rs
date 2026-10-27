//! `identity-store.ts` + `identity-durable-store.ts` — endpoint-side trust and
//! device admission state. Paired devices, trust bindings, per-route
//! revocation countersign and recovery-authority records, persisted as one
//! atomic owner-only snapshot.
//!
//! Trust always derives from the pinned paired key and current generation —
//! never from a product name, a relay-selected identifier, or a recovered
//! snapshot's stale contents.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::b64::b64u_decode;
use crate::error::{entry_error, Result};
use crate::wire::account::{
    is_account_step_up_permit_id, is_action_target, is_binding, is_pairing_peer_identity,
    AccountActionTarget, AccountAuthorityBinding, PairingPeerIdentity,
};
use crate::wire::recovery::peer_id_for_route_device;
use crate::wire::session::{PRIVATE_RELAY_MODES, PRIVATE_RELAY_ROLES};

const SCHEMA_VERSION: u32 = 1;
const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_DEVICES: usize = 4096;
const MAX_RECOVERIES: usize = 256;
const MAX_INVITATIONS: usize = 4096;
const MAX_OPERATIONS: usize = 4096;
/// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410).
const ED25519_SPKI_DER_PREFIX: &[u8] = &[
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

fn invalid(what: &str) -> crate::error::EntryError {
    entry_error("private_endpoint_state_invalid", what)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountGrant {
    pub grant_ref: String,
    pub scopes: Vec<String>,
}

/// `EndpointDeviceRecord`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointDeviceRecord {
    pub device_id: String,
    pub route_id: String,
    pub tenant_id: String,
    pub role: String,
    pub mode: String,
    pub paired_identity_key: String,
    pub paired_identity_fingerprint: String,
    pub principal_ref: String,
    pub capability_grant_ref: String,
    /// Always serialized (null when absent) — the persisted shape is fixed.
    pub bound_recovery_key_id: Option<String>,
    pub trust_generation: u64,
    pub admission_generation: u64,
    pub revoked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_binding: Option<AccountAuthorityBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_scopes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_grants: Option<Vec<AccountGrant>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_peer_identity: Option<PairingPeerIdentity>,
}

/// `RecoveryAuthorityRecord`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryAuthorityRecord {
    pub recovery_key_id: String,
    pub principal_ref: String,
    pub public_key: String,
    pub generation: u64,
    /// "active" | "rotating" | "revoked" | "superseded"
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_binding: Option<AccountAuthorityBinding>,
}

/// `EndpointInvitationRecord` — the one-time bearer is only ever digested.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointInvitationRecord {
    pub invite_id: String,
    pub token_digest: String,
    pub tenant_id: String,
    pub route_id: String,
    pub endpoint_device_id: String,
    pub endpoint_pin_ref: String,
    pub mode: String,
    pub issued_at: String,
    pub expires_at: String,
    /// Always serialized (null until consumed).
    pub consumed_by_operation_id: Option<String>,
}

/// `EndpointPairingOperationRecord`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointPairingOperationRecord {
    pub bootstrap_id: String,
    pub entry_session_id: String,
    pub invite_id: String,
    pub challenge_id: String,
    pub nonce: String,
    pub account: AccountAuthorityBinding,
    pub target: AccountActionTarget,
    pub expires_at: String,
    /// "challenged" | "authorized" | "enrolled" | "revoked"
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permit_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_grant_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_peer_identity: Option<PairingPeerIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_peer_identity: Option<PairingPeerIdentity>,
}

/// `EndpointGrantOperationRecord`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointGrantOperationRecord {
    pub operation_id: String,
    pub account: AccountAuthorityBinding,
    pub device_id: String,
    pub target: AccountActionTarget,
    pub expires_at: String,
    /// "issued" | "authorized" | "revoked"
    pub state: String,
}

/// `EndpointAdmissionDecision` refusal vocabulary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointAdmission {
    pub admitted: bool,
    /// ambiguous_identity | cross_tenant | mode_mismatch | role_mismatch |
    /// stale_generation | stale_revocation_revision | revoked | unknown_device
    pub refusal: Option<&'static str>,
}

fn is_opaque(value: &str) -> bool {
    crate::wire::common::is_opaque_id(value, 127)
}

/// The durable snapshot — one file, owner-only, whole-set validated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentitySnapshot {
    schema_version: u32,
    devices: Vec<Value>,
    recovery_authorities: Vec<Value>,
    invitations: Vec<Value>,
    pairing_operations: Vec<Value>,
    grant_operations: Vec<Value>,
    revocation_revisions: BTreeMap<String, u64>,
}

/// File durable port — validates every record on load exactly like
/// `validateSnapshot`; save is atomic + owner-only.
pub struct FileEndpointIdentityStore {
    path: PathBuf,
}

impl FileEndpointIdentityStore {
    pub fn new(path: PathBuf) -> Result<Self> {
        let store = Self { path };
        // Validate once up front — a malformed snapshot refuses construction.
        store.read_snapshot()?;
        Ok(store)
    }

    fn read_snapshot(&self) -> Result<ValidatedSnapshot> {
        if !self.path.exists() {
            return Ok(ValidatedSnapshot::default());
        }
        let raw = std::fs::read_to_string(&self.path).map_err(|_| {
            entry_error(
                "private_endpoint_state_unreadable",
                "The private endpoint identity state is not readable.",
            )
        })?;
        if raw.len() > MAX_STATE_BYTES {
            return Err(invalid("The private endpoint identity state exceeds its size bound."));
        }
        let parsed: IdentitySnapshot = serde_json::from_str(&raw)
            .map_err(|_| invalid("The private endpoint identity state is malformed."))?;
        if parsed.schema_version != SCHEMA_VERSION {
            return Err(invalid("The private endpoint identity state does not match its schema."));
        }
        let devices = parsed
            .devices
            .iter()
            .map(parse_device)
            .collect::<Result<Vec<_>>>()?;
        let recoveries = parsed
            .recovery_authorities
            .iter()
            .map(parse_recovery_authority)
            .collect::<Result<Vec<_>>>()?;
        let invitations = parsed
            .invitations
            .iter()
            .map(parse_invitation)
            .collect::<Result<Vec<_>>>()?;
        let operations = parsed
            .pairing_operations
            .iter()
            .map(parse_pairing_operation)
            .collect::<Result<Vec<_>>>()?;
        let grants = parsed
            .grant_operations
            .iter()
            .map(parse_grant_operation)
            .collect::<Result<Vec<_>>>()?;
        if devices.len() > MAX_DEVICES
            || recoveries.len() > MAX_RECOVERIES
            || invitations.len() > MAX_INVITATIONS
            || operations.len() > MAX_OPERATIONS
            || grants.len() > MAX_OPERATIONS
        {
            return Err(invalid("The private endpoint identity state exceeds its record bound."));
        }
        fn unique(records: &[String]) -> bool {
            records.iter().collect::<std::collections::HashSet<_>>().len() == records.len()
        }
        if !unique(&devices.iter().map(|d| d.device_id.clone()).collect::<Vec<_>>())
            || !unique(&invitations.iter().map(|i| i.invite_id.clone()).collect::<Vec<_>>())
            || !unique(&operations.iter().map(|o| o.bootstrap_id.clone()).collect::<Vec<_>>())
            || !unique(&grants.iter().map(|g| g.operation_id.clone()).collect::<Vec<_>>())
        {
            return Err(invalid("Persisted endpoint identity records contain duplicate identifiers."));
        }
        for (tenant, rev) in &parsed.revocation_revisions {
            if !is_opaque(tenant) {
                return Err(invalid("A persisted revocation revision is invalid."));
            }
            let _ = rev;
        }
        Ok(ValidatedSnapshot {
            devices,
            recoveries,
            invitations,
            operations,
            grants,
            revisions: parsed.revocation_revisions,
        })
    }

    fn write_snapshot(&self, snapshot: &ValidatedSnapshot) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|_| {
                entry_error("private_endpoint_state_write_failed", "The identity state directory could not be created.")
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
            }
        }
        let payload = serde_json::to_string(&IdentitySnapshot {
            schema_version: SCHEMA_VERSION,
            devices: snapshot
                .devices
                .iter()
                .map(|d| serde_json::to_value(d).unwrap_or(Value::Null))
                .collect(),
            recovery_authorities: snapshot
                .recoveries
                .iter()
                .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
                .collect(),
            invitations: snapshot
                .invitations
                .iter()
                .map(|i| serde_json::to_value(i).unwrap_or(Value::Null))
                .collect(),
            pairing_operations: snapshot
                .operations
                .iter()
                .map(|o| serde_json::to_value(o).unwrap_or(Value::Null))
                .collect(),
            grant_operations: snapshot
                .grants
                .iter()
                .map(|g| serde_json::to_value(g).unwrap_or(Value::Null))
                .collect(),
            revocation_revisions: snapshot.revisions.clone(),
        })
        .map_err(|_| entry_error("private_endpoint_state_write_failed", "The identity state could not be encoded."))?;
        if payload.len() > MAX_STATE_BYTES {
            return Err(entry_error(
                "private_endpoint_state_capacity",
                "The private endpoint identity state reached its storage bound.",
            ));
        }
        atomic_write(&self.path, payload.as_bytes()).map_err(|_| {
            entry_error(
                "private_endpoint_state_write_failed",
                "The private endpoint identity state could not be persisted atomically.",
            )
        })
    }
}

#[derive(Debug, Default)]
struct ValidatedSnapshot {
    devices: Vec<EndpointDeviceRecord>,
    recoveries: Vec<RecoveryAuthorityRecord>,
    invitations: Vec<EndpointInvitationRecord>,
    operations: Vec<EndpointPairingOperationRecord>,
    grants: Vec<EndpointGrantOperationRecord>,
    revisions: BTreeMap<String, u64>,
}

fn atomic_write(path: &std::path::Path, body: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body)
        .map_err(|_| entry_error("private_endpoint_state_write_failed", "A record could not be staged."))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path)
        .map_err(|_| entry_error("private_endpoint_state_write_failed", "A record could not be committed."))
}

fn instant(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
}

fn parse_device(value: &Value) -> Result<EndpointDeviceRecord> {
    let record: EndpointDeviceRecord = serde_json::from_value(value.clone())
        .map_err(|_| invalid("A persisted device identity is invalid."))?;
    if !(is_opaque(&record.device_id)
        && is_opaque(&record.route_id)
        && is_opaque(&record.tenant_id)
        && !record.role.is_empty()
        && !record.mode.is_empty()
        && !record.paired_identity_key.is_empty()
        && !record.paired_identity_fingerprint.is_empty()
        && !record.principal_ref.is_empty()
        && !record.capability_grant_ref.is_empty())
    {
        return Err(invalid("A persisted device identity is invalid."));
    }
    if let Some(scopes) = &record.account_scopes {
        if scopes.iter().any(|s| s.is_empty()) {
            return Err(invalid("Persisted account scopes are invalid."));
        }
    }
    if let Some(grants) = &record.account_grants {
        if grants
            .iter()
            .any(|g| !is_opaque(&g.grant_ref) || g.scopes.iter().any(|s| s.is_empty()))
        {
            return Err(invalid("Persisted account grants are invalid."));
        }
    }
    if let Some(peer_identity) = &record.entry_peer_identity {
        let expected = peer_id_for_route_device(&record.tenant_id, &record.route_id, &record.device_id);
        let ok = match expected.as_deref() {
            Some(peer_id) => {
                is_pairing_peer_identity(&serde_json::to_value(peer_identity).unwrap_or(Value::Null), Some(peer_id))
                    && b64u_decode(&peer_identity.identity_key, 64)
                        .map(|raw| raw.len() == 33)
                        .unwrap_or(false)
            }
            None => false,
        };
        if !ok {
            return Err(invalid(
                "A persisted paired Signal identity does not match its route and device.",
            ));
        }
    }
    if let Some(binding) = &record.account_binding {
        if !is_binding(&serde_json::to_value(binding).unwrap_or(Value::Null)) {
            return Err(invalid("A persisted device account binding is invalid."));
        }
    }
    Ok(record)
}

fn parse_recovery_authority(value: &Value) -> Result<RecoveryAuthorityRecord> {
    let record: RecoveryAuthorityRecord = serde_json::from_value(value.clone())
        .map_err(|_| invalid("A persisted recovery authority is invalid."))?;
    if !is_opaque(&record.recovery_key_id)
        || !matches!(record.state.as_str(), "active" | "rotating" | "revoked" | "superseded")
    {
        return Err(invalid("A persisted recovery authority is invalid."));
    }
    if let Some(binding) = &record.account_binding {
        if !is_binding(&serde_json::to_value(binding).unwrap_or(Value::Null)) {
            return Err(invalid("A persisted recovery authority is invalid."));
        }
    }
    Ok(record)
}

fn parse_invitation(value: &Value) -> Result<EndpointInvitationRecord> {
    let record: EndpointInvitationRecord = serde_json::from_value(value.clone())
        .map_err(|_| invalid("A persisted pairing invite is invalid."))?;
    if !(is_opaque(&record.invite_id)
        && is_opaque(&record.tenant_id)
        && is_opaque(&record.route_id)
        && is_opaque(&record.endpoint_device_id)
        && instant(&Value::from(record.issued_at.clone()))
        && instant(&Value::from(record.expires_at.clone()))
        && record
            .consumed_by_operation_id
            .as_deref()
            .map_or(true, is_opaque))
    {
        return Err(invalid("A persisted pairing invite is invalid."));
    }
    Ok(record)
}

fn parse_pairing_operation(value: &Value) -> Result<EndpointPairingOperationRecord> {
    let record: EndpointPairingOperationRecord = serde_json::from_value(value.clone())
        .map_err(|_| invalid("A persisted pairing operation is invalid."))?;
    if !(is_opaque(&record.bootstrap_id)
        && is_opaque(&record.entry_session_id)
        && is_opaque(&record.invite_id)
        && is_opaque(&record.challenge_id)
        && is_binding(&serde_json::to_value(&record.account).unwrap_or(Value::Null))
        && is_action_target(&serde_json::to_value(&record.target).unwrap_or(Value::Null))
        && instant(&Value::from(record.expires_at.clone()))
        && matches!(record.state.as_str(), "challenged" | "authorized" | "enrolled" | "revoked"))
    {
        return Err(invalid("A persisted pairing operation is invalid."));
    }
    if record.operation_id.as_deref().map_or(false, |v| !is_opaque(v))
        || record.permit_id.as_deref().map_or(false, |v| !is_account_step_up_permit_id(v))
        || record.capability_grant_ref.as_deref().map_or(false, |v| !is_opaque(v))
    {
        return Err(invalid("A persisted pairing operation reference is invalid."));
    }
    Ok(record)
}

fn parse_grant_operation(value: &Value) -> Result<EndpointGrantOperationRecord> {
    let record: EndpointGrantOperationRecord = serde_json::from_value(value.clone())
        .map_err(|_| invalid("A persisted grant operation is invalid."))?;
    if !(is_opaque(&record.operation_id)
        && is_binding(&serde_json::to_value(&record.account).unwrap_or(Value::Null))
        && is_opaque(&record.device_id)
        && is_action_target(&serde_json::to_value(&record.target).unwrap_or(Value::Null))
        && instant(&Value::from(record.expires_at.clone()))
        && matches!(record.state.as_str(), "issued" | "authorized" | "revoked"))
    {
        return Err(invalid("A persisted grant operation is invalid."));
    }
    Ok(record)
}

/* --------------------------------- store --------------------------------- */

/// `EndpointIdentityStore` — in-memory indexes over the durable snapshot.
pub struct EndpointIdentityStore {
    devices: HashMap<String, EndpointDeviceRecord>,
    by_fingerprint: HashMap<String, String>,
    recovery_authorities: HashMap<String, RecoveryAuthorityRecord>,
    invitations: HashMap<String, EndpointInvitationRecord>,
    pairing_operations: HashMap<String, EndpointPairingOperationRecord>,
    grant_operations: HashMap<String, EndpointGrantOperationRecord>,
    revocation_revisions: HashMap<String, u64>,
    durable: Option<FileEndpointIdentityStore>,
}

impl EndpointIdentityStore {
    pub fn open(path: PathBuf) -> Result<Self> {
        let durable = FileEndpointIdentityStore::new(path)?;
        let snapshot = durable.read_snapshot()?;
        let mut store = Self {
            devices: HashMap::new(),
            by_fingerprint: HashMap::new(),
            recovery_authorities: HashMap::new(),
            invitations: HashMap::new(),
            pairing_operations: HashMap::new(),
            grant_operations: HashMap::new(),
            revocation_revisions: HashMap::new(),
            durable: Some(durable),
        };
        for device in snapshot.devices {
            store
                .by_fingerprint
                .insert(device.paired_identity_fingerprint.clone(), device.device_id.clone());
            store.devices.insert(device.device_id.clone(), device);
        }
        for record in snapshot.recoveries {
            store
                .recovery_authorities
                .insert(record.recovery_key_id.clone(), record);
        }
        for record in snapshot.invitations {
            store.invitations.insert(record.invite_id.clone(), record);
        }
        for record in snapshot.operations {
            store
                .pairing_operations
                .insert(record.bootstrap_id.clone(), record);
        }
        for record in snapshot.grants {
            store
                .grant_operations
                .insert(record.operation_id.clone(), record);
        }
        store.revocation_revisions = snapshot.revisions.into_iter().collect();
        Ok(store)
    }

    /// In-memory only — the TS non-durable store (tests + runtime members).
    pub fn in_memory() -> Self {
        Self {
            devices: HashMap::new(),
            by_fingerprint: HashMap::new(),
            recovery_authorities: HashMap::new(),
            invitations: HashMap::new(),
            pairing_operations: HashMap::new(),
            grant_operations: HashMap::new(),
            revocation_revisions: HashMap::new(),
            durable: None,
        }
    }

    fn persist(&self) -> Result<()> {
        let Some(durable) = &self.durable else { return Ok(()) };
        durable.write_snapshot(&ValidatedSnapshot {
            devices: self.devices.values().cloned().collect(),
            recoveries: self.recovery_authorities.values().cloned().collect(),
            invitations: self.invitations.values().cloned().collect(),
            operations: self.pairing_operations.values().cloned().collect(),
            grants: self.grant_operations.values().cloned().collect(),
            revisions: self.revocation_revisions.iter().map(|(k, v)| (k.clone(), *v)).collect(),
        })
    }

    pub fn revocation_revision(&self, tenant_id: &str) -> u64 {
        self.revocation_revisions.get(tenant_id).copied().unwrap_or(0)
    }

    pub fn device(&self, device_id: &str) -> Option<&EndpointDeviceRecord> {
        self.devices.get(device_id)
    }

    pub fn device_by_fingerprint(&self, fingerprint: &str) -> Option<&EndpointDeviceRecord> {
        self.by_fingerprint
            .get(fingerprint)
            .and_then(|id| self.devices.get(id))
    }

    pub fn devices(&self) -> Vec<EndpointDeviceRecord> {
        self.devices.values().cloned().collect()
    }

    /// `accountGrantAllows` — an account id supplied by a caller is never
    /// enough to establish the grant relationship.
    pub fn account_grant_allows(
        &self,
        device_id: &str,
        account: &AccountAuthorityBinding,
        tenant_id: &str,
        route_id: &str,
        scope: &str,
    ) -> bool {
        let Some(device) = self.devices.get(device_id) else { return false };
        if device.revoked
            || device.tenant_id != tenant_id
            || device.route_id != route_id
            || device.account_binding.as_ref().map(|b| b.account_id.as_str()) != Some(account.account_id.as_str())
            || device.account_binding.as_ref().map(|b| b.auth_epoch) != Some(account.auth_epoch)
        {
            return false;
        }
        device
            .account_grants
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|grant| grant.scopes.iter().any(|s| s == scope))
    }

    pub fn account_devices(&self, account_id: &str) -> Vec<EndpointDeviceRecord> {
        self.devices
            .values()
            .filter(|d| d.account_binding.as_ref().map(|b| b.account_id.as_str()) == Some(account_id))
            .cloned()
            .collect()
    }

    pub fn invitation(&self, invite_id: &str) -> Option<&EndpointInvitationRecord> {
        self.invitations.get(invite_id)
    }

    pub fn invitations(&self) -> Vec<EndpointInvitationRecord> {
        self.invitations.values().cloned().collect()
    }

    pub fn save_invitation(&mut self, record: EndpointInvitationRecord) -> Result<()> {
        if let Some(existing) = self.invitations.get(&record.invite_id) {
            if existing.consumed_by_operation_id.is_some()
                && record.consumed_by_operation_id != existing.consumed_by_operation_id
            {
                return Err(entry_error(
                    "pairing_invite_consumed",
                    "A consumed pairing invitation cannot be restored or reassigned.",
                ));
            }
        }
        self.invitations.insert(record.invite_id.clone(), record);
        self.persist()
    }

    pub fn pairing_operation(&self, bootstrap_id: &str) -> Option<&EndpointPairingOperationRecord> {
        self.pairing_operations.get(bootstrap_id)
    }

    pub fn pairing_operations(&self) -> Vec<EndpointPairingOperationRecord> {
        self.pairing_operations.values().cloned().collect()
    }

    pub fn grant_operation(&self, operation_id: &str) -> Option<&EndpointGrantOperationRecord> {
        self.grant_operations.get(operation_id)
    }

    pub fn save_grant_operation(&mut self, record: EndpointGrantOperationRecord) -> Result<()> {
        if let Some(existing) = self.grant_operations.get(&record.operation_id) {
            let order = |s: &str| match s {
                "issued" => 0,
                "authorized" => 1,
                "revoked" => 2,
                _ => 3,
            };
            if existing.device_id != record.device_id
                || existing.account.account_id != record.account.account_id
                || existing.account.auth_epoch != record.account.auth_epoch
                || serde_json::to_value(&existing.target).ok() != serde_json::to_value(&record.target).ok()
                || order(&record.state) < order(&existing.state)
                || (existing.state == "revoked" && record.state != "revoked")
            {
                return Err(entry_error(
                    "grant_operation_conflict",
                    "A grant operation cannot change its account, target, or authorization state.",
                ));
            }
        }
        self.grant_operations.insert(record.operation_id.clone(), record);
        self.persist()
    }

    pub fn save_pairing_operation(&mut self, record: EndpointPairingOperationRecord) -> Result<()> {
        if let Some(permit) = &record.permit_id {
            if !is_account_step_up_permit_id(permit) {
                return Err(entry_error(
                    "pairing_operation_invalid",
                    "A pairing operation permit does not match the account authority format.",
                ));
            }
        }
        if let Some(existing) = self.pairing_operations.get(&record.bootstrap_id) {
            let order = |s: &str| match s {
                "challenged" => 0,
                "authorized" => 1,
                "enrolled" => 2,
                "revoked" => 3,
                _ => 4,
            };
            let same_identity = |a: &Option<PairingPeerIdentity>, b: &Option<PairingPeerIdentity>| {
                serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
            };
            if existing.entry_session_id != record.entry_session_id
                || existing.invite_id != record.invite_id
                || existing.target.grant_ref != record.target.grant_ref
                || existing.entry_peer_identity.is_some()
                    && !same_identity(&existing.entry_peer_identity, &record.entry_peer_identity)
                || !same_identity(&existing.endpoint_peer_identity, &record.endpoint_peer_identity)
                || (existing.operation_id.is_some()
                    && record.operation_id.is_some()
                    && existing.operation_id != record.operation_id)
                || order(&record.state) < order(&existing.state)
                || (existing.state == "revoked" && record.state != "revoked")
            {
                return Err(entry_error(
                    "pairing_operation_conflict",
                    "A pairing operation cannot change its session, invite, target, or operation identity.",
                ));
            }
        }
        self.pairing_operations.insert(record.bootstrap_id.clone(), record);
        self.persist()
    }

    /// Enroll a fresh device under a validated endpoint trust binding.
    /// Monotonic: re-enrollment advances admission generation and never
    /// resurrects a revoked device.
    pub fn enroll(&mut self, device_id: &str, route_id: &str, tenant_id: &str, trust_binding: &Value) -> Result<EndpointDeviceRecord> {
        let binding = trust_binding.as_object().ok_or_else(|| {
            entry_error("trust_binding_invalid", "Endpoint trust binding does not satisfy the wire contract.")
        })?;
        let get_str = |k: &str| binding.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let existing = self.devices.get(device_id).cloned();
        if existing.as_ref().map(|d| d.revoked) == Some(true) {
            return Err(entry_error(
                "device_revoked",
                "A revoked device cannot be re-enrolled without a fresh trust generation.",
            ));
        }
        let current_revision = self.revocation_revision(tenant_id);
        let record = EndpointDeviceRecord {
            device_id: device_id.to_string(),
            route_id: route_id.to_string(),
            tenant_id: tenant_id.to_string(),
            role: get_str("role"),
            mode: get_str("mode"),
            paired_identity_key: get_str("pairedIdentityKey"),
            paired_identity_fingerprint: get_str("pairedIdentityFingerprint"),
            principal_ref: get_str("endpointPrincipalRef"),
            capability_grant_ref: get_str("capabilityGrantRef"),
            bound_recovery_key_id: binding.get("boundRecoveryKeyId").and_then(Value::as_str).map(str::to_string),
            trust_generation: binding.get("trustGeneration").and_then(Value::as_u64).unwrap_or(0),
            admission_generation: existing.as_ref().map(|d| d.admission_generation).unwrap_or(0) + 1,
            revoked: false,
            // Account and peer state belong to the enrolled key identity; they
            // survive re-enrollment only while the paired key itself is unchanged.
            account_binding: existing
                .as_ref()
                .filter(|d| d.paired_identity_key == get_str("pairedIdentityKey"))
                .and_then(|d| d.account_binding.clone()),
            account_scopes: existing.as_ref().and_then(|d| {
                if d.paired_identity_key == get_str("pairedIdentityKey") {
                    d.account_binding.as_ref().and_then(|_| d.account_scopes.clone())
                } else {
                    None
                }
            }),
            account_grants: existing.as_ref().and_then(|d| {
                if d.paired_identity_key == get_str("pairedIdentityKey") {
                    d.account_binding.as_ref().and_then(|_| d.account_grants.clone())
                } else {
                    None
                }
            }),
            entry_peer_identity: existing.as_ref().and_then(|d| {
                if d.paired_identity_key == get_str("pairedIdentityKey") {
                    d.entry_peer_identity.clone()
                } else {
                    None
                }
            }),
        };
        if let Some(collision) = self.by_fingerprint.get(&record.paired_identity_fingerprint) {
            if collision != &record.device_id {
                return Err(entry_error(
                    "ambiguous_identity",
                    "The paired identity fingerprint already belongs to another device.",
                ));
            }
        }
        self.by_fingerprint
            .insert(record.paired_identity_fingerprint.clone(), record.device_id.clone());
        self.devices.insert(record.device_id.clone(), record.clone());
        self.revocation_revisions.insert(tenant_id.to_string(), current_revision);
        self.persist()?;
        Ok(record)
    }

    /// Bind the endpoint's account authority result to its enrolled identity.
    pub fn bind_account_endpoint(&mut self, device_id: &str, account: &AccountAuthorityBinding) -> Result<EndpointDeviceRecord> {
        let Some(existing) = self.devices.get(device_id).cloned() else {
            return Err(entry_error("account_endpoint_binding_invalid", "Managed endpoint account binding is unavailable."));
        };
        if existing.role != "endpoint"
            || existing.revoked
            || account.account_id.is_empty()
            || account.auth_epoch < 1
        {
            return Err(entry_error("account_endpoint_binding_invalid", "Managed endpoint account binding is unavailable."));
        }
        if let Some(bound) = &existing.account_binding {
            if bound.account_id != account.account_id || bound.auth_epoch > account.auth_epoch {
                return Err(entry_error(
                    "account_endpoint_binding_conflict",
                    "Endpoint account binding cannot change owner or move backward.",
                ));
            }
        }
        if existing.account_binding.as_ref().map(|b| b.auth_epoch) != Some(account.auth_epoch) {
            self.revoke_account_epoch(&account.account_id, account.auth_epoch);
        }
        let mut bound = existing.clone();
        bound.account_binding = Some(account.clone());
        self.devices.insert(device_id.to_string(), bound.clone());
        self.persist()?;
        Ok(bound)
    }

    /// Re-enable only the receiving endpoint after a verified fresh claim for
    /// the current account epoch. Entry grants stay revoked until re-paired.
    pub fn activate_account_endpoint_claim(
        &mut self,
        device_id: &str,
        account: &AccountAuthorityBinding,
        admission_generation: u64,
        revocation_revision: u64,
    ) -> Result<EndpointDeviceRecord> {
        let Some(existing) = self.devices.get(device_id).cloned() else {
            return Err(entry_error("account_endpoint_claim_invalid", "A verified current endpoint claim is required."));
        };
        if existing.role != "endpoint"
            || account.account_id.is_empty()
            || account.auth_epoch < 1
            || admission_generation < 1
            || existing
                .account_binding
                .as_ref()
                .is_some_and(|b| b.account_id != account.account_id || b.auth_epoch > account.auth_epoch)
        {
            return Err(entry_error("account_endpoint_claim_invalid", "A verified current endpoint claim is required."));
        }
        let changed_epoch = existing.account_binding.as_ref().map(|b| b.auth_epoch) != Some(account.auth_epoch);
        if changed_epoch {
            self.revoke_account_epoch(&account.account_id, account.auth_epoch);
        }
        let mut activated = self.devices.get(device_id).cloned().unwrap();
        activated.account_binding = Some(account.clone());
        activated.account_scopes = Some(Vec::new());
        activated.account_grants = Some(Vec::new());
        activated.admission_generation = admission_generation;
        if changed_epoch || activated.revoked {
            activated.trust_generation += 1;
        }
        activated.revoked = false;
        let tenant = activated.tenant_id.clone();
        self.devices.insert(device_id.to_string(), activated.clone());
        let floor = self.revocation_revision(&tenant).max(revocation_revision);
        self.revocation_revisions.insert(tenant, floor);
        self.persist()?;
        Ok(activated)
    }

    /// Persist an account-authorized Entry device and its exact scopes.
    pub fn enroll_account_device(
        &mut self,
        account: &AccountAuthorityBinding,
        target: &AccountActionTarget,
        mode: &str,
        entry_peer_identity: Option<&PairingPeerIdentity>,
    ) -> Result<EndpointDeviceRecord> {
        if account.account_id.is_empty()
            || account.auth_epoch < 1
            || target.tenant_id.is_empty()
            || target.route_id.is_empty()
            || target.device_id.is_empty()
            || target.grant_ref.is_empty()
            || target.device_public_key.is_empty()
            || target.scopes.is_empty()
            || target.scopes.iter().any(|s| s.trim().is_empty())
            || target.scopes.iter().collect::<std::collections::HashSet<_>>().len() != target.scopes.len()
        {
            return Err(entry_error("account_device_binding_invalid", "Account device grant is incomplete."));
        }
        let raw = b64u_decode(&target.device_public_key, 44).map_err(|_| {
            entry_error("account_device_key_invalid", "Account device public key must be a canonical raw Ed25519 key.")
        })?;
        if raw.len() != 32 || crate::b64::b64u_encode(&raw) != target.device_public_key {
            return Err(entry_error("account_device_key_invalid", "Account device public key must be a canonical raw Ed25519 key."));
        }
        if let Some(peer_identity) = entry_peer_identity {
            let expected = peer_id_for_route_device(&target.tenant_id, &target.route_id, &target.device_id);
            let ok = expected.as_deref().is_some_and(|peer_id| {
                is_pairing_peer_identity(&serde_json::to_value(peer_identity).unwrap_or(Value::Null), Some(peer_id))
                    && b64u_decode(&peer_identity.identity_key, 64).map(|r| r.len() == 33).unwrap_or(false)
            });
            if !ok {
                return Err(entry_error(
                    "account_peer_identity_invalid",
                    "Paired Signal identity must bind the exact account route and device.",
                ));
            }
        }
        let mut spki = ED25519_SPKI_DER_PREFIX.to_vec();
        spki.extend_from_slice(&raw);
        let fingerprint = crate::b64::b64u_encode(&Sha256::digest(&spki));
        let existing = self.devices.get(&target.device_id).cloned();
        if let Some(current) = &existing {
            if current.tenant_id != target.tenant_id
                || current.route_id != target.route_id
                || current.paired_identity_key != target.device_public_key
                || current
                    .account_binding
                    .as_ref()
                    .is_some_and(|b| b.account_id != account.account_id)
            {
                return Err(entry_error(
                    "account_device_conflict",
                    "Account device identity is already bound to another route or key.",
                ));
            }
        }
        let prior_grants: Vec<AccountGrant> = existing
            .as_ref()
            .filter(|e| e.account_binding.as_ref().map(|b| b.auth_epoch) == Some(account.auth_epoch))
            .and_then(|e| e.account_grants.clone())
            .unwrap_or_default();
        if let Some(prior) = prior_grants.iter().find(|g| g.grant_ref == target.grant_ref) {
            let mut prior_scopes = prior.scopes.clone();
            prior_scopes.sort();
            prior_scopes.dedup();
            let mut new_scopes = target.scopes.clone();
            new_scopes.sort();
            new_scopes.dedup();
            if prior_scopes != new_scopes {
                return Err(entry_error(
                    "account_target_mismatch",
                    "A grant reference cannot be reused for a different scope set.",
                ));
            }
            if entry_peer_identity.is_some()
                && serde_json::to_value(existing.as_ref().and_then(|e| e.entry_peer_identity.clone())).ok()
                    != serde_json::to_value(entry_peer_identity.cloned()).ok()
            {
                return Err(entry_error(
                    "account_peer_identity_conflict",
                    "A paired device grant cannot change its pinned Signal identity.",
                ));
            }
            return Ok(existing.unwrap());
        }
        let mut account_grants = prior_grants;
        account_grants.push(AccountGrant {
            grant_ref: target.grant_ref.clone(),
            scopes: {
                let mut s = target.scopes.clone();
                s.sort();
                s
            },
        });
        let mut scopes: Vec<String> = account_grants.iter().flat_map(|g| g.scopes.clone()).collect();
        scopes.sort();
        scopes.dedup();
        let principal_ref = existing
            .as_ref()
            .map(|e| e.principal_ref.clone())
            .unwrap_or_else(|| {
                format!(
                    "account.{}.{}",
                    &crate::b64::b64u_encode(&Sha256::digest(account.account_id.as_bytes()))[..24],
                    target.device_id
                )
            });
        let record = EndpointDeviceRecord {
            device_id: target.device_id.clone(),
            route_id: target.route_id.clone(),
            tenant_id: target.tenant_id.clone(),
            role: "entry".to_string(),
            mode: mode.to_string(),
            paired_identity_key: target.device_public_key.clone(),
            paired_identity_fingerprint: fingerprint.clone(),
            principal_ref,
            capability_grant_ref: target.grant_ref.clone(),
            bound_recovery_key_id: existing.as_ref().and_then(|e| e.bound_recovery_key_id.clone()),
            trust_generation: existing.as_ref().map(|e| e.trust_generation + 1).unwrap_or(1),
            admission_generation: existing.as_ref().map(|e| e.admission_generation + 1).unwrap_or(1),
            revoked: false,
            account_binding: Some(account.clone()),
            account_scopes: Some(scopes),
            account_grants: Some(account_grants),
            entry_peer_identity: match entry_peer_identity {
                Some(identity) => Some(identity.clone()),
                None => existing.as_ref().and_then(|e| e.entry_peer_identity.clone()),
            },
        };
        if let Some(collision) = self.by_fingerprint.get(&fingerprint) {
            if collision != &record.device_id {
                return Err(entry_error(
                    "ambiguous_identity",
                    "The account device key is already assigned to another device.",
                ));
            }
        }
        self.by_fingerprint.insert(fingerprint, record.device_id.clone());
        self.devices.insert(record.device_id.clone(), record.clone());
        let rev = self.revocation_revision(&target.tenant_id);
        self.revocation_revisions.insert(target.tenant_id.clone(), rev);
        self.persist()?;
        Ok(record)
    }

    /// Remove persisted grants from earlier account epochs.
    pub fn revoke_account_epoch(&mut self, account_id: &str, current_epoch: u64) -> Vec<EndpointDeviceRecord> {
        let mut revoked = Vec::new();
        let ids: Vec<String> = self.devices.keys().cloned().collect();
        for device_id in ids {
            let Some(current) = self.devices.get(&device_id).cloned() else { continue };
            let Some(binding) = &current.account_binding else { continue };
            if binding.account_id != account_id || binding.auth_epoch >= current_epoch {
                continue;
            }
            let has_grant_data = current
                .account_scopes
                .as_ref()
                .map(|s| !s.is_empty())
                .unwrap_or(false)
                || current
                    .account_grants
                    .as_ref()
                    .map(|g| !g.is_empty())
                    .unwrap_or(false);
            if current.revoked && !has_grant_data {
                continue;
            }
            let mut updated = current.clone();
            updated.revoked = true;
            updated.account_scopes = Some(Vec::new());
            updated.account_grants = Some(Vec::new());
            let tenant = updated.tenant_id.clone();
            let was_revoked = current.revoked;
            self.devices.insert(device_id.clone(), updated.clone());
            if !was_revoked {
                let next = self.revocation_revision(&tenant) + 1;
                self.revocation_revisions.insert(tenant, next);
            }
            revoked.push(updated);
        }
        let mut changed = !revoked.is_empty();
        for authority in self.recovery_authorities.values_mut() {
            if authority
                .account_binding
                .as_ref()
                .is_some_and(|b| b.account_id == account_id && b.auth_epoch < current_epoch)
                && authority.state != "revoked"
            {
                authority.state = "revoked".to_string();
                changed = true;
            }
        }
        for operation in self.pairing_operations.values_mut() {
            if operation.account.account_id == account_id
                && operation.account.auth_epoch < current_epoch
                && operation.state != "revoked"
            {
                operation.state = "revoked".to_string();
                changed = true;
            }
        }
        for operation in self.grant_operations.values_mut() {
            if operation.account.account_id == account_id
                && operation.account.auth_epoch < current_epoch
                && operation.state != "revoked"
            {
                operation.state = "revoked".to_string();
                changed = true;
            }
        }
        if changed {
            let _ = self.persist();
        }
        revoked
    }

    /// Local revocation takes effect immediately.
    pub fn revoke(&mut self, device_id: &str) -> Option<EndpointDeviceRecord> {
        let current = self.devices.get(device_id)?.clone();
        if current.revoked {
            return Some(current);
        }
        let mut updated = current.clone();
        updated.revoked = true;
        let tenant = updated.tenant_id.clone();
        self.devices.insert(device_id.to_string(), updated.clone());
        let next = self.revocation_revision(&tenant) + 1;
        self.revocation_revisions.insert(tenant, next);
        let _ = self.persist();
        Some(updated)
    }

    /// `admit` — exhaustive relay-admission evaluation; every refusal names
    /// its reason distinctly.
    pub fn admit(
        &self,
        tenant_id: &str,
        device_id: &str,
        route_id: &str,
        role: &str,
        mode: &str,
        admission_generation: u64,
        revocation_revision: u64,
    ) -> EndpointAdmission {
        let Some(device) = self.devices.get(device_id) else {
            return EndpointAdmission { admitted: false, refusal: Some("unknown_device") };
        };
        let refuse = |r: &'static str| EndpointAdmission { admitted: false, refusal: Some(r) };
        if device.tenant_id != tenant_id {
            return refuse("cross_tenant");
        }
        if device.route_id != route_id {
            return refuse("ambiguous_identity");
        }
        if device.role != role || !PRIVATE_RELAY_ROLES.contains(&role) {
            return refuse("role_mismatch");
        }
        if device.mode != mode || !PRIVATE_RELAY_MODES.contains(&mode) {
            return refuse("mode_mismatch");
        }
        if device.revoked {
            return refuse("revoked");
        }
        if admission_generation < device.admission_generation {
            return refuse("stale_generation");
        }
        if revocation_revision < self.revocation_revision(&device.tenant_id) {
            return refuse("stale_revocation_revision");
        }
        EndpointAdmission { admitted: true, refusal: None }
    }

    pub fn recovery_authority(&self, recovery_key_id: &str) -> Option<&RecoveryAuthorityRecord> {
        self.recovery_authorities.get(recovery_key_id)
    }

    pub fn recovery_authorities(&self) -> Vec<RecoveryAuthorityRecord> {
        self.recovery_authorities.values().cloned().collect()
    }

    pub fn enroll_recovery_authority(
        &mut self,
        recovery_key_id: &str,
        principal_ref: &str,
        public_key: &str,
        generation: u64,
        account_binding: Option<AccountAuthorityBinding>,
    ) -> Result<RecoveryAuthorityRecord> {
        let existing = self.recovery_authorities.get(recovery_key_id).cloned();
        if let Some(current) = &existing {
            if current.state == "revoked" || current.state == "superseded" {
                return Ok(current.clone());
            }
            if current.public_key != public_key
                || current.generation > generation
                || (current.account_binding.is_some()
                    && account_binding.is_some()
                    && (current.account_binding.as_ref().unwrap().account_id != account_binding.as_ref().unwrap().account_id
                        || current.account_binding.as_ref().unwrap().auth_epoch != account_binding.as_ref().unwrap().auth_epoch))
            {
                return Err(entry_error(
                    "recovery_authority_conflict",
                    "Recovery authority cannot replace or downgrade existing trust.",
                ));
            }
        }
        let record = RecoveryAuthorityRecord {
            recovery_key_id: recovery_key_id.to_string(),
            principal_ref: principal_ref.to_string(),
            public_key: public_key.to_string(),
            generation,
            state: existing.as_ref().map(|e| e.state.clone()).unwrap_or_else(|| "active".to_string()),
            account_binding: existing
                .as_ref()
                .and_then(|e| e.account_binding.clone())
                .or(account_binding),
        };
        self.recovery_authorities.insert(recovery_key_id.to_string(), record.clone());
        self.persist()?;
        Ok(record)
    }

    /// Bind already-configured local recovery authorities on first claim.
    pub fn bind_recovery_authorities_to_account(&mut self, account: &AccountAuthorityBinding) -> Result<Vec<RecoveryAuthorityRecord>> {
        let mut updated = Vec::new();
        let mut conflicts = false;
        for current in self.recovery_authorities.values_mut() {
            if let Some(bound) = &current.account_binding {
                if bound.account_id != account.account_id {
                    conflicts = true;
                    continue;
                }
                continue;
            }
            current.account_binding = Some(account.clone());
            updated.push(current.clone());
        }
        if conflicts {
            return Err(entry_error("recovery_authority_conflict", "Recovery authority belongs to another account."));
        }
        if !updated.is_empty() {
            self.persist()?;
        }
        Ok(updated)
    }

    pub fn set_recovery_authority_state(&mut self, recovery_key_id: &str, state: &str) -> Option<RecoveryAuthorityRecord> {
        let current = self.recovery_authorities.get_mut(recovery_key_id)?;
        current.state = state.to_string();
        let record = current.clone();
        let _ = self.persist();
        Some(record)
    }

    /// Stage a recovery root rotation — candidate must advance the generation.
    pub fn stage_recovery_rotation(
        &mut self,
        recovery_key_id: &str,
        candidate_key_id: &str,
        candidate_public_key: &str,
        principal_ref: &str,
        current_generation: u64,
        candidate_generation: u64,
    ) -> EndpointRotationDecision {
        let Some(incumbent) = self.recovery_authorities.get(recovery_key_id).cloned() else {
            return EndpointRotationDecision { accepted: false, refusal: Some("authority_revoked") };
        };
        if incumbent.state == "revoked" {
            return EndpointRotationDecision { accepted: false, refusal: Some("authority_revoked") };
        }
        if candidate_generation <= incumbent.generation || current_generation < incumbent.generation {
            return EndpointRotationDecision { accepted: false, refusal: Some("stale_generation") };
        }
        self.set_recovery_authority_state(recovery_key_id, "rotating");
        self.recovery_authorities.insert(
            candidate_key_id.to_string(),
            RecoveryAuthorityRecord {
                recovery_key_id: candidate_key_id.to_string(),
                principal_ref: principal_ref.to_string(),
                public_key: candidate_public_key.to_string(),
                generation: candidate_generation,
                state: "active".to_string(),
                account_binding: incumbent.account_binding,
            },
        );
        let _ = self.persist();
        EndpointRotationDecision { accepted: true, refusal: None }
    }

    pub fn complete_recovery_rotation(&mut self, recovery_key_id: &str) {
        if let Some(incumbent) = self.recovery_authorities.get_mut(recovery_key_id) {
            incumbent.state = "superseded".to_string();
            let _ = self.persist();
        }
    }

    pub fn abort_recovery_rotation(&mut self, recovery_key_id: &str, candidate_key_id: &str) {
        if self.recovery_authorities.contains_key(recovery_key_id) {
            self.set_recovery_authority_state(recovery_key_id, "active");
        }
        self.recovery_authorities.remove(candidate_key_id);
        let _ = self.persist();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointRotationDecision {
    pub accepted: bool,
    pub refusal: Option<&'static str>,
}
