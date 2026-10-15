//! Durable peer-client store — port of `store.ts` + `file-store.ts`.
//!
//! Device-local custody for outbox/inbox rows, sequence allocators, bundle
//! observations and legacy-migration history. Relay outcomes are transport
//! evidence only; a recipient-signed ACK is the sole "delivered" transition.
//!
//! File layout (same names as the TypeScript implementation):
//! ```text
//! <root>/peer-records/
//!   meta/{meta.json, route-binding.json}
//!   sequence/<scopeDigest>.json            { outbox, inbox, history }
//!   outbox/<scopeDigest>/<seq16>-<idDigest>.json
//!   inbox/...  history/...
//!   outbox-by-id/<scopeDigest>/<idDigest>.json   IndexPointer
//!   outbox-pending/<scopeDigest>/<bucket10>/<seq16>-<idDigest>.json
//!   outbox-history/... inbox-by-id/... inbox-pending/... inbox-ack-pending/...
//!   inbox-history/... peer-history/... peer-history-by-id/... migration/...
//! ```

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::{entry_error, EntryError, Result};

use super::wire::{
    parse_peer_envelope, PeerDeliveryAck, PeerForwarded, PeerMessageIdentity, PeerWireEnvelope,
};

fn store_error(detail: &str) -> EntryError {
    entry_error("peer_client_store", detail)
}

fn conflict_error(detail: &str) -> EntryError {
    entry_error("peer_client_conflict", detail)
}

/// Store record shape version; every persisted document carries it.
pub const PEER_CLIENT_STORE_RECORD_VERSION: u64 = 2;

pub const PEER_OUTBOX_STATES: &[&str] = &["pending", "delivered", "conflict"];
pub const PEER_INBOX_DISPATCH_STATES: &[&str] =
    &["pending", "accepted_by_agent", "rejected", "skipped", "failed"];

pub fn peer_outbox_state_is_terminal(state: &str) -> bool {
    state == "delivered" || state == "conflict"
}

/// Route scope used for local sequence allocation and paged projections.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerClientRouteScope {
    pub tenant_id: String,
    pub route_id: String,
}

/// Authenticated route identity: scope + the bound local device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerClientRouteIdentity {
    pub tenant_id: String,
    pub route_id: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredOutboxEntry {
    #[serde(flatten)]
    pub identity: PeerMessageIdentity,
    pub version: u64,
    /// Client-local FIFO order; never appears in the relay wire contract.
    pub sequence: u64,
    /// Crypto peer id pinned for the recipient device.
    pub peer_id: String,
    /// pending | delivered | conflict
    pub state: String,
    /// Exact ciphertext envelope reused across reconnect retries.
    pub envelope: PeerWireEnvelope,
    /// Transport write attempts only; no attempt count expires the record.
    pub attempts: u64,
    /// Last online relay result; never durable recipient delivery proof.
    pub last_forwarded: Option<PeerForwarded>,
    /// Verified recipient receipt persisted with the terminal delivered state.
    pub delivery_ack: Option<PeerDeliveryAck>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredInboxEntry {
    #[serde(flatten)]
    pub identity: PeerMessageIdentity,
    pub version: u64,
    pub sequence: u64,
    /// Crypto peer id recovered from the authenticated Signal envelope.
    pub sender_peer_id: Option<String>,
    pub envelope: PeerWireEnvelope,
    /// base64url plaintext for local application dispatch; never sent to relay.
    pub plaintext: Option<String>,
    pub decrypt_error: Option<String>,
    /// pending | accepted_by_agent | rejected | skipped | failed
    pub dispatch: String,
    /// Signed ACK persisted before send, replayed on duplicate delivery.
    pub delivery_ack: Option<PeerDeliveryAck>,
    pub received_at: String,
    pub updated_at: String,
}

/// The device's own published public prekey bundle header.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredLocalBundle {
    pub version: u64,
    pub bundle_id: String,
    pub revision: u64,
    pub format: String,
    pub material: Option<String>,
}

/// Header material remembered about a remote public bundle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBundleObservation {
    pub bundle_id: String,
    pub revision: u64,
    pub one_time_pre_key_id: Option<u32>,
    pub signed_prekey_id: Option<u32>,
}

/// Immutable evidence retained from the superseded local mailbox model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPeerHistoryEntry {
    pub sequence: u64,
    pub version: u64,
    pub evidence_id: String,
    pub tenant_id: String,
    pub route_id: String,
    /// legacy_outbox | legacy_inbox | legacy_gap
    pub source: String,
    pub message_id: Option<String>,
    pub device_id: Option<String>,
    pub former_position: Option<u64>,
    pub former_gap: Option<FormerGap>,
    pub former_state: Option<String>,
    pub former_receipt_facts: Vec<Value>,
    /// Original device-local record preserved verbatim; never interpreted as
    /// active authority or sent through the relay.
    pub legacy_record: Option<Value>,
    pub recorded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormerGap {
    pub from_seq: u64,
    pub to_seq: u64,
    /// expired | capacity_truncated
    pub cause: String,
    pub message_ids: Option<Vec<String>>,
}

/// Small metadata document; it contains no business message history.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerClientMeta {
    pub version: u64,
    pub local_bundle: Option<StoredLocalBundle>,
    /// Learned bindings: relay device id → paired Signal peer id.
    pub peers: HashMap<String, String>,
    pub bundle_observations: HashMap<String, StoredBundleObservation>,
}

pub fn empty_peer_client_meta() -> PeerClientMeta {
    PeerClientMeta {
        version: PEER_CLIENT_STORE_RECORD_VERSION,
        local_bundle: None,
        peers: HashMap::new(),
        bundle_observations: HashMap::new(),
    }
}

#[derive(Debug, Clone)]
pub struct PeerClientPage<T> {
    pub items: Vec<T>,
    /// Last local sequence examined, suitable as the next exclusive cursor.
    pub next_after_sequence: Option<u64>,
}

#[derive(Debug, Clone, Copy)]
pub struct PeerClientPageQuery {
    pub after_sequence: u64,
    pub limit: usize,
}

/// Durable client store contract. Synchronous file IO; callers run on the
/// peer runtime's dedicated local thread.
pub trait PeerClientStore {
    /// Idempotently import/preserve legacy records and bind the route.
    fn prepare_route(&self, route: &PeerClientRouteIdentity) -> Result<()>;

    /// Refuse new durable records when local storage cannot accommodate them.
    fn assert_available_capacity(&self, additional_bytes: usize) -> Result<()>;

    fn load_meta(&self) -> Result<Option<PeerClientMeta>>;
    fn save_meta(&self, meta: &PeerClientMeta) -> Result<()>;

    /// Durable, strictly increasing local order allocators scoped to the bound
    /// route and stream. Values are never reused after restart.
    fn allocate_outbox_sequence(&self, scope: &PeerClientRouteScope) -> Result<u64>;
    fn allocate_inbox_sequence(&self, scope: &PeerClientRouteScope) -> Result<u64>;
    fn allocate_history_sequence(&self, scope: &PeerClientRouteScope) -> Result<u64>;

    fn load_outbox_entry(&self, identity: &PeerMessageIdentity) -> Result<Option<StoredOutboxEntry>>;
    fn save_outbox_entry(&self, entry: &StoredOutboxEntry) -> Result<()>;
    fn list_pending_outbox_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredOutboxEntry>>;
    fn list_outbox_history_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredOutboxEntry>>;

    fn load_inbox_entry(&self, identity: &PeerMessageIdentity) -> Result<Option<StoredInboxEntry>>;
    fn save_inbox_entry(&self, entry: &StoredInboxEntry) -> Result<()>;
    fn list_pending_inbox_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredInboxEntry>>;
    /// Durable inbox rows without a signed ACK, independent of app dispatch.
    fn list_pending_delivery_ack_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredInboxEntry>>;
    fn list_inbox_history_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredInboxEntry>>;

    fn save_peer_history_entry(&self, entry: &StoredPeerHistoryEntry) -> Result<()>;
    fn list_peer_history_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredPeerHistoryEntry>>;
}

/* ------------------------------- in-memory -------------------------------- */

fn scope_key(scope: &PeerClientRouteScope) -> String {
    json!([scope.tenant_id, scope.route_id]).to_string()
}

fn identity_key(identity: &PeerMessageIdentity) -> String {
    json!([
        identity.tenant_id,
        identity.route_id,
        identity.sender_device_id,
        identity.recipient_device_id,
        identity.message_id
    ])
    .to_string()
}

fn in_scope<T, F>(
    entries: impl Iterator<Item = T>,
    scope: &PeerClientRouteScope,
    query: PeerClientPageQuery,
    predicate: F,
    fields: impl Fn(&T) -> (&str, &str, u64),
) -> PeerClientPage<T>
where
    F: Fn(&T) -> bool,
{
    let mut candidates: Vec<T> = entries
        .filter(|e| {
            let (tenant, route, seq) = fields(e);
            tenant == scope.tenant_id && route == scope.route_id && seq > query.after_sequence
        })
        .filter(|e| predicate(e))
        .collect();
    candidates.sort_by_key(|e| fields(e).2);
    let selected: Vec<T> = candidates.into_iter().take(query.limit).collect();
    PeerClientPage {
        next_after_sequence: selected.last().map(|e| fields(e).2),
        items: selected,
    }
}

/// Map-backed store for tests and ephemeral composition.
#[derive(Default)]
pub struct InMemoryPeerClientStore {
    meta: RefCell<Option<PeerClientMeta>>,
    outbox: RefCell<HashMap<String, StoredOutboxEntry>>,
    inbox: RefCell<HashMap<String, StoredInboxEntry>>,
    history: RefCell<HashMap<String, StoredPeerHistoryEntry>>,
    sequences: RefCell<HashMap<String, u64>>,
}

impl InMemoryPeerClientStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn next(&self, key: &str) -> u64 {
        let mut seqs = self.sequences.borrow_mut();
        let next = seqs.get(key).copied().unwrap_or(0) + 1;
        seqs.insert(key.to_string(), next);
        next
    }

    fn advance(&self, key: &str, sequence: u64) {
        let mut seqs = self.sequences.borrow_mut();
        if sequence > seqs.get(key).copied().unwrap_or(0) {
            seqs.insert(key.to_string(), sequence);
        }
    }
}

impl PeerClientStore for InMemoryPeerClientStore {
    fn prepare_route(&self, _route: &PeerClientRouteIdentity) -> Result<()> {
        Ok(())
    }
    fn assert_available_capacity(&self, _additional_bytes: usize) -> Result<()> {
        Ok(())
    }

    fn load_meta(&self) -> Result<Option<PeerClientMeta>> {
        Ok(self.meta.borrow().clone())
    }
    fn save_meta(&self, meta: &PeerClientMeta) -> Result<()> {
        *self.meta.borrow_mut() = Some(meta.clone());
        Ok(())
    }

    fn allocate_outbox_sequence(&self, scope: &PeerClientRouteScope) -> Result<u64> {
        Ok(self.next(&format!("outbox:{}", scope_key(scope))))
    }
    fn allocate_inbox_sequence(&self, scope: &PeerClientRouteScope) -> Result<u64> {
        Ok(self.next(&format!("inbox:{}", scope_key(scope))))
    }
    fn allocate_history_sequence(&self, scope: &PeerClientRouteScope) -> Result<u64> {
        Ok(self.next(&format!("history:{}", scope_key(scope))))
    }

    fn load_outbox_entry(&self, identity: &PeerMessageIdentity) -> Result<Option<StoredOutboxEntry>> {
        Ok(self.outbox.borrow().get(&identity_key(identity)).cloned())
    }
    fn save_outbox_entry(&self, entry: &StoredOutboxEntry) -> Result<()> {
        self.outbox
            .borrow_mut()
            .insert(identity_key(&entry.identity), entry.clone());
        self.advance(&format!("outbox:{}", scope_key(&PeerClientRouteScope {
            tenant_id: entry.identity.tenant_id.clone(),
            route_id: entry.identity.route_id.clone(),
        })), entry.sequence);
        Ok(())
    }
    fn list_pending_outbox_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredOutboxEntry>> {
        let store = self.outbox.borrow();
        Ok(in_scope(store.values().cloned(), scope, query,
            |e| e.state == "pending",
            |e| (e.identity.tenant_id.as_str(), e.identity.route_id.as_str(), e.sequence)))
    }
    fn list_outbox_history_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredOutboxEntry>> {
        let store = self.outbox.borrow();
        Ok(in_scope(store.values().cloned(), scope, query,
            |e| e.state != "pending",
            |e| (e.identity.tenant_id.as_str(), e.identity.route_id.as_str(), e.sequence)))
    }

    fn load_inbox_entry(&self, identity: &PeerMessageIdentity) -> Result<Option<StoredInboxEntry>> {
        Ok(self.inbox.borrow().get(&identity_key(identity)).cloned())
    }
    fn save_inbox_entry(&self, entry: &StoredInboxEntry) -> Result<()> {
        self.inbox
            .borrow_mut()
            .insert(identity_key(&entry.identity), entry.clone());
        self.advance(&format!("inbox:{}", scope_key(&PeerClientRouteScope {
            tenant_id: entry.identity.tenant_id.clone(),
            route_id: entry.identity.route_id.clone(),
        })), entry.sequence);
        Ok(())
    }
    fn list_pending_inbox_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredInboxEntry>> {
        let store = self.inbox.borrow();
        Ok(in_scope(store.values().cloned(), scope, query,
            |e| e.dispatch == "pending",
            |e| (e.identity.tenant_id.as_str(), e.identity.route_id.as_str(), e.sequence)))
    }
    fn list_pending_delivery_ack_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredInboxEntry>> {
        let store = self.inbox.borrow();
        Ok(in_scope(store.values().cloned(), scope, query,
            |e| e.delivery_ack.is_none(),
            |e| (e.identity.tenant_id.as_str(), e.identity.route_id.as_str(), e.sequence)))
    }
    fn list_inbox_history_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredInboxEntry>> {
        let store = self.inbox.borrow();
        Ok(in_scope(store.values().cloned(), scope, query,
            |e| e.dispatch != "pending",
            |e| (e.identity.tenant_id.as_str(), e.identity.route_id.as_str(), e.sequence)))
    }

    fn save_peer_history_entry(&self, entry: &StoredPeerHistoryEntry) -> Result<()> {
        self.history
            .borrow_mut()
            .insert(entry.evidence_id.clone(), entry.clone());
        self.advance(&format!("history:{}", scope_key(&PeerClientRouteScope {
            tenant_id: entry.tenant_id.clone(),
            route_id: entry.route_id.clone(),
        })), entry.sequence);
        Ok(())
    }
    fn list_peer_history_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredPeerHistoryEntry>> {
        let store = self.history.borrow();
        Ok(in_scope(store.values().cloned(), scope, query,
            |_| true,
            |e| (e.tenant_id.as_str(), e.route_id.as_str(), e.sequence)))
    }
}

/* --------------------------------- file store ------------------------------ */

const DATA_DIR: &str = "peer-records";
const INDEX_BUCKET_SIZE: u64 = 256;
const MINIMUM_FREE_SPACE_RESERVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 16 * 1024 * 1024;

fn is_opaque_id(value: &str) -> bool {
    let b = value.as_bytes();
    (2..=127).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(*c, b'.' | b'_' | b':' | b'-'))
}

fn is_peer_id(value: &str) -> bool {
    super::types::is_peer_id(value)
}

fn digest(value: &str) -> String {
    hex_lower(&Sha256::digest(value.as_bytes()))
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn identity_digest(identity: &PeerMessageIdentity) -> String {
    digest(&identity_key(identity))
}

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn scope_digest(scope: &PeerClientRouteScope) -> String {
    digest(&scope_key(scope))
}

fn sequence_name(sequence: u64) -> String {
    format!("{sequence:016}")
}

fn valid_record_id(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 81
        && b[..16].iter().all(|c| c.is_ascii_digit())
        && b[16] == b'-'
        && b[17..].iter().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn parse_index_name(value: &str) -> Option<(u64, String)> {
    let stem = value.strip_suffix(".json")?;
    let (seq, id) = stem.split_once('-')?;
    if seq.len() != 16 || id.len() != 64 {
        return None;
    }
    let sequence: u64 = seq.parse().ok()?;
    if sequence < 1 {
        return None;
    }
    Some((sequence, id.to_string()))
}

fn index_name(sequence: u64, record_digest: &str) -> String {
    format!("{}-{}.json", sequence_name(sequence), record_digest)
}

fn same_json(left: &Value, right: &Value) -> bool {
    left == right
}

fn same_envelope(left: &PeerWireEnvelope, right: &PeerWireEnvelope) -> bool {
    left == right
}

fn scope_of(identity: &PeerMessageIdentity) -> PeerClientRouteScope {
    PeerClientRouteScope {
        tenant_id: identity.tenant_id.clone(),
        route_id: identity.route_id.clone(),
    }
}

/* ----------------------------- record parsing ------------------------------ */

fn parse_identity(value: &Value, what: &str) -> Result<PeerMessageIdentity> {
    let get = |f: &str| -> Result<String> {
        let v = value.get(f).and_then(Value::as_str).unwrap_or("");
        if !is_opaque_id(v) {
            return Err(store_error(&format!("{what} is missing {f}.")));
        }
        Ok(v.to_string())
    };
    Ok(PeerMessageIdentity {
        tenant_id: get("tenantId")?,
        route_id: get("routeId")?,
        sender_device_id: get("senderDeviceId")?,
        recipient_device_id: get("recipientDeviceId")?,
        message_id: get("messageId")?,
    })
}

fn parse_outbox(value: &Value, what: &str) -> Result<StoredOutboxEntry> {
    let entry: StoredOutboxEntry = serde_json::from_value(value.clone())
        .map_err(|_| store_error(&format!("{what} is malformed.")))?;
    let identity = parse_identity(value, what)?;
    if entry.version != PEER_CLIENT_STORE_RECORD_VERSION
        || entry.sequence < 1
        || !PEER_OUTBOX_STATES.contains(&entry.state.as_str())
        || !is_peer_id(&entry.peer_id)
        || parse_peer_envelope(&serde_json::to_value(&entry.envelope).unwrap_or(Value::Null)).is_none()
        || identity != entry.identity
    {
        return Err(store_error(&format!("{what} is malformed.")));
    }
    Ok(entry)
}

fn parse_inbox(value: &Value, what: &str) -> Result<StoredInboxEntry> {
    let entry: StoredInboxEntry = serde_json::from_value(value.clone())
        .map_err(|_| store_error(&format!("{what} is malformed.")))?;
    let identity = parse_identity(value, what)?;
    if entry.version != PEER_CLIENT_STORE_RECORD_VERSION
        || entry.sequence < 1
        || !PEER_INBOX_DISPATCH_STATES.contains(&entry.dispatch.as_str())
        || entry.sender_peer_id.as_deref().is_some_and(|p| !is_peer_id(p))
        || parse_peer_envelope(&serde_json::to_value(&entry.envelope).unwrap_or(Value::Null)).is_none()
        || entry.plaintext.as_deref().is_some_and(|p| p.is_empty())
        || identity != entry.identity
    {
        return Err(store_error(&format!("{what} is malformed.")));
    }
    Ok(entry)
}

fn parse_history(value: &Value, what: &str) -> Result<StoredPeerHistoryEntry> {
    let entry: StoredPeerHistoryEntry = serde_json::from_value(value.clone())
        .map_err(|_| store_error(&format!("{what} is malformed.")))?;
    if entry.version != PEER_CLIENT_STORE_RECORD_VERSION
        || entry.sequence < 1
        || entry.evidence_id.is_empty()
        || entry.tenant_id.is_empty()
        || entry.route_id.is_empty()
        || !["legacy_outbox", "legacy_inbox", "legacy_gap"].contains(&entry.source.as_str())
    {
        return Err(store_error(&format!("{what} is malformed.")));
    }
    Ok(entry)
}

fn parse_meta(value: &Value) -> Result<PeerClientMeta> {
    let mut meta = empty_peer_client_meta();
    if let Some(local) = value.get("localBundle") {
        if local.is_object() {
            let parsed: StoredLocalBundle = serde_json::from_value(local.clone())
                .map_err(|_| store_error("The local bundle metadata is malformed."))?;
            if parsed.version == PEER_CLIENT_STORE_RECORD_VERSION && !parsed.bundle_id.is_empty() {
                meta.local_bundle = Some(parsed);
            }
        }
    }
    if let Some(peers) = value.get("peers").and_then(Value::as_object) {
        for (device, peer) in peers {
            if let Some(peer_id) = peer.as_str() {
                meta.peers.insert(device.clone(), peer_id.to_string());
            }
        }
    }
    if let Some(observations) = value.get("bundleObservations").and_then(Value::as_object) {
        for (device, item) in observations {
            if let Ok(obs) = serde_json::from_value::<StoredBundleObservation>(item.clone()) {
                meta.bundle_observations.insert(device.clone(), obs);
            }
        }
    }
    Ok(meta)
}

/* ------------------------------ capacity check ----------------------------- */

/// `assertPrivateStorageCapacity` — reserve = max(64 MiB, additional/10).
/// Uses statvfs on unix and GetDiskFreeSpaceExW on Windows.
pub fn assert_private_storage_capacity(root: &Path, additional_bytes: usize) -> Result<()> {
    if additional_bytes > MAX_RECORD_BYTES + MINIMUM_FREE_SPACE_RESERVE_BYTES as usize {
        return Err(store_error(
            "A durable client record exceeds the supported encoded size.",
        ));
    }
    let percentage_reserve = (additional_bytes as u64 + 9) / 10;
    let reserve = percentage_reserve.max(MINIMUM_FREE_SPACE_RESERVE_BYTES);
    let required = additional_bytes as u64 + reserve;
    match available_bytes(root) {
        Some(available) if available < required => Err(entry_error(
            "private_storage_capacity",
            "Private storage has insufficient free space for this write.",
        )),
        Some(_) | None => Ok(()),
    }
}

#[cfg(unix)]
fn available_bytes(root: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(root.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs writes into a caller-owned struct.
    unsafe {
        let mut stats: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c_path.as_ptr(), &mut stats) == 0 {
            Some(stats.f_bavail as u64 * stats.f_frsize as u64)
        } else {
            None
        }
    }
}

#[cfg(windows)]
fn available_bytes(root: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free: u64 = 0;
    // SAFETY: GetDiskFreeSpaceExW writes into caller-owned u64s.
    let ok = unsafe {
        windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            windows::core::PCWSTR(wide.as_ptr()),
            Some(&mut free as *mut u64 as *mut _),
            None,
            None,
        )
    };
    ok.is_ok().then_some(free)
}

#[cfg(not(any(unix, windows)))]
fn available_bytes(_root: &Path) -> Option<u64> {
    None
}

/* ------------------------------ index pointers ----------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexPointer {
    sequence: u64,
    record_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<PeerMessageIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<PeerClientRouteScope>,
}

#[derive(Clone, Copy, PartialEq)]
enum IndexKind {
    OutboxPending,
    OutboxHistory,
    InboxPending,
    InboxAckPending,
    InboxHistory,
    PeerHistory,
}

impl IndexKind {
    fn dir(self) -> &'static str {
        match self {
            IndexKind::OutboxPending => "outbox-pending",
            IndexKind::OutboxHistory => "outbox-history",
            IndexKind::InboxPending => "inbox-pending",
            IndexKind::InboxAckPending => "inbox-ack-pending",
            IndexKind::InboxHistory => "inbox-history",
            IndexKind::PeerHistory => "peer-history",
        }
    }
}

#[derive(Clone, Copy)]
enum RecordKind {
    Outbox,
    Inbox,
    History,
}

impl RecordKind {
    fn dir(self) -> &'static str {
        match self {
            RecordKind::Outbox => "outbox",
            RecordKind::Inbox => "inbox",
            RecordKind::History => "history",
        }
    }
    fn lane_indexes(self) -> &'static [IndexKind] {
        match self {
            RecordKind::Outbox => &[IndexKind::OutboxPending, IndexKind::OutboxHistory],
            RecordKind::Inbox => &[
                IndexKind::InboxPending,
                IndexKind::InboxAckPending,
                IndexKind::InboxHistory,
            ],
            RecordKind::History => &[IndexKind::PeerHistory],
        }
    }
}

/// File-backed device custody. Records are keyed by a digest of the full
/// identity tuple; index files hold only sequence + digest.
pub struct FilePeerClientStore {
    root: PathBuf,
    data: PathBuf,
    bound_route: RefCell<Option<PeerClientRouteIdentity>>,
}

fn atomic_write(path: &Path, body: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, body).map_err(|_| store_error("A client store record could not be written."))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|_| store_error("A client store record could not be committed."))
}

fn ensure_private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|_| store_error("A client store directory could not be created."))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn read_json(path: &Path, label: &str) -> Result<Option<Value>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| store_error(&format!("Client store record {label} cannot be parsed."))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(store_error(&format!("Client store record {label} could not be read."))),
    }
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value).map_err(|_| store_error("A client store record could not be encoded."))?;
    let mut body = body;
    body.push(b'\n');
    atomic_write(path, &body)
}

fn remove_file(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(store_error("A client store record could not be removed.")),
    }
}

impl FilePeerClientStore {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        if root.as_os_str().is_empty() {
            return Err(store_error("FilePeerClientStore requires a root directory path."));
        }
        let data = root.join(DATA_DIR);
        ensure_private_dir(&root)?;
        ensure_private_dir(&data)?;
        for dir in [
            "meta", "outbox", "inbox", "history", "sequence", "migration", "outbox-by-id",
            "outbox-pending", "outbox-history", "inbox-by-id", "inbox-pending",
            "inbox-ack-pending", "inbox-history", "peer-history", "peer-history-by-id",
        ] {
            ensure_private_dir(&data.join(dir))?;
        }
        Ok(Self { root, data, bound_route: RefCell::new(None) })
    }

    pub fn root_dir(&self) -> &Path {
        &self.root
    }

    fn scope_dir(&self, dir: &str, scope: &PeerClientRouteScope) -> PathBuf {
        self.data.join(dir).join(scope_digest(scope))
    }

    fn record_file(&self, kind: RecordKind, scope: &PeerClientRouteScope, record_id: &str) -> Result<PathBuf> {
        if !valid_record_id(record_id) {
            return Err(store_error("A client store record identifier is malformed."));
        }
        Ok(self.scope_dir(kind.dir(), scope).join(format!("{record_id}.json")))
    }

    fn index_bucket_dir(&self, kind: IndexKind, scope: &PeerClientRouteScope, sequence: u64) -> PathBuf {
        let bucket = (sequence.saturating_sub(1)) / INDEX_BUCKET_SIZE;
        self.scope_dir(kind.dir(), scope).join(format!("{bucket:010}"))
    }

    fn id_index_file(&self, kind_dir: &str, identity: &PeerMessageIdentity) -> PathBuf {
        self.data
            .join(kind_dir)
            .join(scope_digest(&scope_of(identity)))
            .join(format!("{}.json", identity_digest(identity)))
    }

    fn read(&self, file: &Path, label: &str) -> Result<Option<Value>> {
        read_json(file, label)
    }

    fn write(&self, file: &Path, value: &Value) -> Result<()> {
        write_json(file, value)
    }

    fn assert_record_capacity(&self, entry: &impl Serialize) -> Result<()> {
        let serialized = serde_json::to_vec(entry)
            .map_err(|_| store_error("A durable client record cannot be serialized."))?;
        assert_private_storage_capacity(&self.root, serialized.len() + 4_096)
    }

    fn sequence_file(&self, scope: &PeerClientRouteScope) -> PathBuf {
        self.data.join("sequence").join(format!("{}.json", scope_digest(scope)))
    }

    fn read_sequence_counts(&self, scope: &PeerClientRouteScope) -> Result<HashMap<String, u64>> {
        let file = self.sequence_file(scope);
        let value = self.read(&file, "sequence")?;
        let Some(value) = value else { return Ok(HashMap::new()) };
        let obj = value.as_object().ok_or_else(|| {
            store_error("The local sequence metadata is malformed; its original data was retained.")
        })?;
        let mut counts = HashMap::new();
        for lane in ["outbox", "inbox", "history"] {
            if let Some(v) = obj.get(lane) {
                let n = v.as_u64().ok_or_else(|| {
                    store_error("The local sequence metadata is malformed; its original data was retained.")
                })?;
                counts.insert(lane.to_string(), n);
            }
        }
        Ok(counts)
    }

    fn advance_sequence(&self, scope: &PeerClientRouteScope, lane: &str, value: u64) -> Result<()> {
        let file = self.sequence_file(scope);
        let mut counts = self.read_sequence_counts(scope)?;
        if counts.get(lane).copied().unwrap_or(0) >= value {
            return Ok(());
        }
        counts.insert(lane.to_string(), value);
        let mut obj = serde_json::Map::new();
        for (k, v) in counts {
            obj.insert(k, Value::from(v));
        }
        self.write(&file, &Value::Object(obj))
    }

    fn allocate(&self, scope: &PeerClientRouteScope, lane: &str) -> Result<u64> {
        self.ensure_migrated(scope)?;
        let file = self.sequence_file(scope);
        let mut counts = self.read_sequence_counts(scope)?;
        let next = counts.get(lane).copied().unwrap_or(0) + 1;
        counts.insert(lane.to_string(), next);
        let mut obj = serde_json::Map::new();
        for (k, v) in counts {
            obj.insert(k, Value::from(v));
        }
        self.write(&file, &Value::Object(obj))?;
        Ok(next)
    }

    /* ------------------------------- binding -------------------------------- */

    fn bind_route(&self, route: &PeerClientRouteIdentity) -> Result<()> {
        if !is_opaque_id(&route.tenant_id) || !is_opaque_id(&route.route_id) || !is_opaque_id(&route.device_id) {
            return Err(store_error("A bound route identity is malformed."));
        }
        {
            let bound = self.bound_route.borrow();
            if let Some(existing) = bound.as_ref() {
                if existing.tenant_id != route.tenant_id
                    || existing.route_id != route.route_id
                    || existing.device_id != route.device_id
                {
                    return Err(store_error(
                        "The file store cannot be rebound to another tenant, route or device.",
                    ));
                }
            }
        }
        let binding_file = self.data.join("meta").join("route-binding.json");
        let persisted = self.read(&binding_file, "route binding")?;
        match persisted {
            Some(value) => {
                let ok = value.get("version").and_then(Value::as_u64) == Some(1)
                    && value.get("tenantId").and_then(Value::as_str) == Some(route.tenant_id.as_str())
                    && value.get("routeId").and_then(Value::as_str) == Some(route.route_id.as_str())
                    && value.get("deviceId").and_then(Value::as_str) == Some(route.device_id.as_str());
                if !ok {
                    return Err(store_error(
                        "The file store belongs to a different tenant, route or device.",
                    ));
                }
            }
            None => {
                self.write(&binding_file, &json!({
                    "version": 1,
                    "tenantId": route.tenant_id,
                    "routeId": route.route_id,
                    "deviceId": route.device_id,
                }))?;
            }
        }
        *self.bound_route.borrow_mut() = Some(route.clone());
        self.ensure_migrated(&PeerClientRouteScope {
            tenant_id: route.tenant_id.clone(),
            route_id: route.route_id.clone(),
        })
    }

    fn bound(&self) -> Result<PeerClientRouteIdentity> {
        self.bound_route
            .borrow()
            .clone()
            .ok_or_else(|| store_error("The file store must be bound to an authenticated route before message access."))
    }

    fn assert_bound_identity(
        &self,
        identity: &PeerMessageIdentity,
        local_field: &'static str,
    ) -> Result<()> {
        let route = self.bound()?;
        if !is_opaque_id(&identity.sender_device_id)
            || !is_opaque_id(&identity.recipient_device_id)
            || !is_opaque_id(&identity.message_id)
        {
            return Err(store_error("A message identity contains a malformed wire identifier."));
        }
        if identity.tenant_id != route.tenant_id || identity.route_id != route.route_id {
            return Err(store_error("A message identity does not belong to the bound route."));
        }
        let local = if local_field == "senderDeviceId" {
            &identity.sender_device_id
        } else {
            &identity.recipient_device_id
        };
        if *local != route.device_id {
            return Err(store_error(&format!(
                "A message identity does not match the bound local device ({local_field})."
            )));
        }
        Ok(())
    }

    fn assert_bound_scope(&self, scope: &PeerClientRouteScope) -> Result<()> {
        let route = self.bound()?;
        if !is_opaque_id(&scope.tenant_id) || !is_opaque_id(&scope.route_id) {
            return Err(store_error("A route scope is malformed."));
        }
        if scope.tenant_id != route.tenant_id || scope.route_id != route.route_id {
            return Err(store_error("The file store is already bound to a different route."));
        }
        Ok(())
    }

    /* ------------------------------ migration ------------------------------- */

    fn ensure_migrated(&self, scope: &PeerClientRouteScope) -> Result<()> {
        self.assert_bound_scope(scope)?;
        let route = self.bound()?;
        let marker_file = self.data.join("migration").join(format!(
            "{}.json",
            digest(&format!("{}\n{}", scope_key(scope), route.device_id))
        ));
        let marker = self.read(&marker_file, "migration")?;
        if let Some(marker) = marker.as_ref() {
            if marker.get("routeScope").and_then(Value::as_str) == Some(scope_key(scope).as_str())
                && marker.get("deviceId").and_then(Value::as_str) == Some(route.device_id.as_str())
                && marker.get("complete").and_then(Value::as_bool) == Some(true)
            {
                return Ok(());
            }
        }
        self.recover_sequence_high_water(scope)?;
        self.migrate_legacy(scope, &route.device_id)?;
        self.write(&marker_file, &json!({
            "version": 1,
            "routeScope": scope_key(scope),
            "deviceId": route.device_id,
            "complete": true,
        }))
    }

    fn index_buckets(&self, kind: IndexKind, scope: &PeerClientRouteScope, first_bucket: u64) -> Result<Vec<u64>> {
        let dir = self.scope_dir(kind.dir(), scope);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(store_error("A client store index directory could not be listed.")),
        };
        let mut buckets: Vec<u64> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|n| n.len() >= 10 && n.chars().all(|c| c.is_ascii_digit()))
            .filter_map(|n| n.parse::<u64>().ok())
            .filter(|b| *b >= first_bucket)
            .collect();
        buckets.sort_unstable();
        Ok(buckets)
    }

    /// Cold-start recovery reads bucket names and last-bucket index names,
    /// never message bodies. Staged reservations may leave safe holes.
    fn recover_sequence_high_water(&self, scope: &PeerClientRouteScope) -> Result<()> {
        let file = self.sequence_file(scope);
        let mut counts = self.read_sequence_counts(scope)?;
        let mut changed = false;
        for (lane, kinds) in [
            ("outbox", RecordKind::Outbox.lane_indexes()),
            ("inbox", RecordKind::Inbox.lane_indexes()),
            ("history", RecordKind::History.lane_indexes()),
        ] {
            let mut high_water = counts.get(lane).copied().unwrap_or(0);
            for kind in kinds {
                let buckets = self.index_buckets(*kind, scope, 0)?;
                for bucket in buckets.iter().rev() {
                    let dir = self.scope_dir(kind.dir(), scope).join(format!("{bucket:010}"));
                    let names = match fs::read_dir(&dir) {
                        Ok(n) => n,
                        Err(_) => continue,
                    };
                    let has_seq = names
                        .filter_map(|e| e.ok())
                        .filter_map(|e| e.file_name().to_str().map(str::to_string))
                        .filter_map(|n| parse_index_name(&n))
                        .filter(|(seq, _)| (seq - 1) / INDEX_BUCKET_SIZE == *bucket)
                        .map(|(seq, _)| seq)
                        .max();
                    if let Some(max_seq) = has_seq {
                        high_water = high_water.max(max_seq);
                        break;
                    }
                }
            }
            if high_water > counts.get(lane).copied().unwrap_or(0) {
                counts.insert(lane.to_string(), high_water);
                changed = true;
            }
        }
        if changed {
            let mut obj = serde_json::Map::new();
            for (k, v) in counts {
                obj.insert(k, Value::from(v));
            }
            self.write(&file, &Value::Object(obj))?;
        }
        Ok(())
    }

    fn assert_sequence_available(
        &self,
        record_kind: RecordKind,
        scope: &PeerClientRouteScope,
        pointer: &IndexPointer,
    ) -> Result<()> {
        for kind in record_kind.lane_indexes() {
            let dir = self.index_bucket_dir(*kind, scope, pointer.sequence);
            let names = match fs::read_dir(&dir) {
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(store_error("A client store index could not be listed.")),
            };
            for name in names.filter_map(|e| e.ok()).filter_map(|e| e.file_name().to_str().map(str::to_string)) {
                if let Some((seq, digest)) = parse_index_name(&name) {
                    if seq == pointer.sequence && digest != pointer.record_id[17..] {
                        return Err(conflict_error(
                            "The local sequence is already reserved for another durable identity.",
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// Import legacy per-mailbox records (`<root>/outbox|inbox|gaps/*.json`)
    /// once per route+device, preserving originals verbatim as history before
    /// removal — faithful port of `#migrateLegacy`.
    fn migrate_legacy(&self, scope: &PeerClientRouteScope, local_device_id: &str) -> Result<()> {
        for (dir, source) in [
            ("outbox", "legacy_outbox"),
            ("inbox", "legacy_inbox"),
            ("gaps", "legacy_gap"),
        ] {
            let folder = self.root.join(dir);
            let mut names: Vec<String> = match fs::read_dir(&folder) {
                Ok(entries) => entries
                    .filter_map(|e| e.ok())
                    .filter_map(|e| e.file_name().to_str().map(str::to_string))
                    .collect(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(store_error("A legacy record directory could not be listed.")),
            };
            names.sort();
            for name in names {
                if !name.ends_with(".json") {
                    continue;
                }
                let source_file = folder.join(&name);
                let original = self.read(&source_file, &format!("legacy {dir}/{name}"))?;
                let raw = original.clone().filter(Value::is_object).unwrap_or_else(|| {
                    json!({ "legacyJsonValue": original })
                });
                let canonical = serde_json::to_string(&original).unwrap_or_default();
                let evidence_id = format!("legacy.{source}.{}", digest(&format!("{name}\n{canonical}")));
                if self.find_history_evidence(scope, &evidence_id)?.is_none() {
                    let sequence = self.reserved_history_sequence(scope, &evidence_id)?
                        .unwrap_or(self.allocate_without_migration(scope, "history")?);
                    let receipts = raw
                        .get("receipts")
                        .or_else(|| raw.get("reports"))
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .filter(Value::is_object)
                        .collect();
                    let gap = if source == "legacy_gap" { Some(&raw) } else { None };
                    let former_gap = gap.and_then(|g| {
                        let from = g.get("fromSeq").and_then(Value::as_u64)?;
                        let to = g.get("toSeq").and_then(Value::as_u64)?;
                        let cause = g.get("cause").and_then(Value::as_str)?;
                        if !["expired", "capacity_truncated"].contains(&cause) {
                            return None;
                        }
                        Some(FormerGap {
                            from_seq: from,
                            to_seq: to,
                            cause: cause.to_string(),
                            message_ids: g.get("messageIds").and_then(Value::as_array).map(|a| {
                                a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()
                            }),
                        })
                    });
                    let evidence = StoredPeerHistoryEntry {
                        sequence,
                        version: PEER_CLIENT_STORE_RECORD_VERSION,
                        evidence_id: evidence_id.clone(),
                        tenant_id: scope.tenant_id.clone(),
                        route_id: scope.route_id.clone(),
                        source: source.to_string(),
                        message_id: raw.get("messageId").and_then(Value::as_str).map(str::to_string),
                        device_id: raw
                            .get("peerDeviceId")
                            .or_else(|| raw.get("senderDeviceId"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        former_position: raw.get("position").and_then(Value::as_u64).filter(|p| *p > 0),
                        former_gap,
                        former_state: raw
                            .get("state")
                            .or_else(|| raw.get("dispatch"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        former_receipt_facts: receipts,
                        legacy_record: Some(raw.clone()),
                        recorded_at: iso_now(),
                    };
                    self.write_history_entry(&evidence)?;
                } else if let Some(existing) = self.find_history_evidence(scope, &evidence_id)? {
                    self.ensure_history_indexes(&existing, None)?;
                }

                if source == "legacy_outbox"
                    && ["pending", "accepted", "received", "accepted_by_agent"]
                        .contains(&raw.get("state").and_then(Value::as_str).unwrap_or(""))
                    && raw.get("messageId").and_then(Value::as_str).is_some_and(is_opaque_id)
                    && raw.get("peerDeviceId").and_then(Value::as_str).is_some_and(is_opaque_id)
                    && raw.get("peerId").and_then(Value::as_str).is_some_and(is_peer_id)
                    && raw.get("envelope").and_then(|e| parse_peer_envelope(e)).is_some()
                {
                    let identity = PeerMessageIdentity {
                        tenant_id: scope.tenant_id.clone(),
                        route_id: scope.route_id.clone(),
                        sender_device_id: local_device_id.to_string(),
                        recipient_device_id: raw["peerDeviceId"].as_str().unwrap_or_default().to_string(),
                        message_id: raw["messageId"].as_str().unwrap_or_default().to_string(),
                    };
                    match self.load_outbox_direct(&identity)? {
                        Some(existing) => {
                            let raw_env: PeerWireEnvelope = serde_json::from_value(raw["envelope"].clone())
                                .map_err(|_| store_error("A legacy outbox envelope is malformed."))?;
                            if existing.peer_id != raw["peerId"].as_str().unwrap_or_default()
                                || !same_envelope(&existing.envelope, &raw_env)
                            {
                                return Err(conflict_error(
                                    "A legacy outbox identity conflicts with a different durable ciphertext; its source record was retained.",
                                ));
                            }
                            self.ensure_outbox_indexes(&existing, None, false)?;
                        }
                        None => {
                            let sequence = self.reserved_sequence("outbox-by-id", &identity)?
                                .unwrap_or(self.allocate_without_migration(scope, "outbox")?);
                            let now = iso_now();
                            let entry = StoredOutboxEntry {
                                identity: identity.clone(),
                                version: PEER_CLIENT_STORE_RECORD_VERSION,
                                sequence,
                                peer_id: raw["peerId"].as_str().unwrap_or_default().to_string(),
                                state: "pending".to_string(),
                                envelope: serde_json::from_value(raw["envelope"].clone())
                                    .map_err(|_| store_error("A legacy outbox envelope is malformed."))?,
                                attempts: raw.get("attempts").and_then(Value::as_u64).unwrap_or(0),
                                last_forwarded: None,
                                delivery_ack: None,
                                last_error: raw.get("lastError").and_then(Value::as_str).map(str::to_string),
                                created_at: raw
                                    .get("createdAt")
                                    .and_then(Value::as_str)
                                    .map(str::to_string)
                                    .unwrap_or_else(|| now.clone()),
                                updated_at: raw
                                    .get("updatedAt")
                                    .and_then(Value::as_str)
                                    .map(str::to_string)
                                    .unwrap_or_else(|| now.clone()),
                            };
                            self.write_outbox_entry(&entry, true, true)?;
                        }
                    }
                } else if source == "legacy_inbox"
                    && raw.get("messageId").and_then(Value::as_str).is_some_and(is_opaque_id)
                    && raw.get("senderDeviceId").and_then(Value::as_str).is_some_and(is_opaque_id)
                    && raw
                        .get("senderPeerId")
                        .is_none_or(|v| v.is_null() || v.as_str().is_some_and(is_peer_id))
                    && raw.get("envelope").and_then(|e| parse_peer_envelope(e)).is_some()
                {
                    let identity = PeerMessageIdentity {
                        tenant_id: scope.tenant_id.clone(),
                        route_id: scope.route_id.clone(),
                        sender_device_id: raw["senderDeviceId"].as_str().unwrap_or_default().to_string(),
                        recipient_device_id: local_device_id.to_string(),
                        message_id: raw["messageId"].as_str().unwrap_or_default().to_string(),
                    };
                    match self.load_inbox_direct(&identity)? {
                        Some(existing) => {
                            let raw_env: PeerWireEnvelope = serde_json::from_value(raw["envelope"].clone())
                                .map_err(|_| store_error("A legacy inbox envelope is malformed."))?;
                            if !same_envelope(&existing.envelope, &raw_env) {
                                return Err(conflict_error(
                                    "A legacy inbox identity conflicts with a different durable ciphertext; its source record was retained.",
                                ));
                            }
                            self.ensure_inbox_indexes(&existing, None, false)?;
                        }
                        None => {
                            let sequence = self.reserved_sequence("inbox-by-id", &identity)?
                                .unwrap_or(self.allocate_without_migration(scope, "inbox")?);
                            let now = iso_now();
                            let plaintext = raw.get("plaintext").and_then(Value::as_str).map(str::to_string);
                            let dispatch = match raw.get("dispatch").and_then(Value::as_str) {
                                Some(d @ ("accepted_by_agent" | "rejected" | "skipped")) => d.to_string(),
                                Some("pending" | "failed") if plaintext.is_some() => "pending".to_string(),
                                _ => "failed".to_string(),
                            };
                            let entry = StoredInboxEntry {
                                identity: identity.clone(),
                                version: PEER_CLIENT_STORE_RECORD_VERSION,
                                sequence,
                                sender_peer_id: raw.get("senderPeerId").and_then(Value::as_str).map(str::to_string),
                                envelope: serde_json::from_value(raw["envelope"].clone())
                                    .map_err(|_| store_error("A legacy inbox envelope is malformed."))?,
                                plaintext,
                                decrypt_error: raw.get("decryptError").and_then(Value::as_str).map(str::to_string),
                                dispatch,
                                // Legacy unsigned mailbox receipts never become delivery proof.
                                delivery_ack: None,
                                received_at: raw
                                    .get("receivedAt")
                                    .and_then(Value::as_str)
                                    .map(str::to_string)
                                    .unwrap_or_else(|| now.clone()),
                                updated_at: now,
                            };
                            self.write_inbox_entry(&entry, true, true)?;
                        }
                    }
                }
                // The historical copy is durable and idempotent before removal.
                remove_file(&source_file)?;
            }
        }
        Ok(())
    }

    fn allocate_without_migration(&self, scope: &PeerClientRouteScope, lane: &str) -> Result<u64> {
        let file = self.sequence_file(scope);
        let mut counts = self.read_sequence_counts(scope)?;
        let next = counts.get(lane).copied().unwrap_or(0) + 1;
        counts.insert(lane.to_string(), next);
        let mut obj = serde_json::Map::new();
        for (k, v) in counts {
            obj.insert(k, Value::from(v));
        }
        self.write(&file, &Value::Object(obj))?;
        Ok(next)
    }

    /* ------------------------------- pointers ------------------------------- */

    fn find_history_evidence(
        &self,
        scope: &PeerClientRouteScope,
        evidence_id: &str,
    ) -> Result<Option<StoredPeerHistoryEntry>> {
        let id = digest(evidence_id);
        let file = self.data.join("peer-history-by-id").join(scope_digest(scope)).join(format!("{id}.json"));
        let Some(pointer) = self.read(&file, &format!("history-by-id/{id}"))? else {
            return Ok(None);
        };
        let pointer: IndexPointer = serde_json::from_value(pointer)
            .map_err(|_| store_error("A historical Peer evidence pointer is malformed; its source record was retained."))?;
        if !valid_record_id(&pointer.record_id)
            || pointer.sequence < 1
            || pointer.record_id != format!("{}-{id}", sequence_name(pointer.sequence))
        {
            return Err(store_error("A historical Peer evidence pointer is malformed; its source record was retained."));
        }
        let Some(value) = self.read(&self.record_file(RecordKind::History, scope, &pointer.record_id)?, "history record")? else {
            return Ok(None);
        };
        let entry = parse_history(&value, "history record")?;
        if entry.sequence != pointer.sequence
            || entry.evidence_id != evidence_id
            || entry.tenant_id != scope.tenant_id
            || entry.route_id != scope.route_id
        {
            return Err(store_error("A historical Peer evidence pointer resolves to a different immutable record."));
        }
        Ok(Some(entry))
    }

    fn reserved_history_sequence(&self, scope: &PeerClientRouteScope, evidence_id: &str) -> Result<Option<u64>> {
        Ok(self.find_history_evidence(scope, evidence_id)?.map(|e| e.sequence))
    }

    fn load_outbox_direct(&self, identity: &PeerMessageIdentity) -> Result<Option<StoredOutboxEntry>> {
        let id = identity_digest(identity);
        let file = self.id_index_file("outbox-by-id", identity);
        let Some(pointer) = self.read(&file, &format!("outbox-by-id/{id}"))? else {
            return Ok(None);
        };
        let pointer: IndexPointer = serde_json::from_value(pointer).map_err(|_| {
            store_error("A durable outbox identity pointer is malformed; its record was retained.")
        })?;
        if !valid_record_id(&pointer.record_id)
            || pointer.sequence < 1
            || pointer.record_id != format!("{}-{id}", sequence_name(pointer.sequence))
        {
            return Err(store_error("A durable outbox identity pointer is malformed; its record was retained."));
        }
        let scope = scope_of(identity);
        let Some(value) = self.read(&self.record_file(RecordKind::Outbox, &scope, &pointer.record_id)?, "outbox record")? else {
            return Ok(None);
        };
        let entry = parse_outbox(&value, "outbox record")?;
        if entry.sequence != pointer.sequence || identity_key(&entry.identity) != identity_key(identity) {
            return Err(store_error("A durable outbox identity pointer resolves to a different immutable record."));
        }
        Ok(Some(entry))
    }

    fn load_inbox_direct(&self, identity: &PeerMessageIdentity) -> Result<Option<StoredInboxEntry>> {
        let id = identity_digest(identity);
        let file = self.id_index_file("inbox-by-id", identity);
        let Some(pointer) = self.read(&file, &format!("inbox-by-id/{id}"))? else {
            return Ok(None);
        };
        let pointer: IndexPointer = serde_json::from_value(pointer).map_err(|_| {
            store_error("A durable inbox identity pointer is malformed; its record was retained.")
        })?;
        if !valid_record_id(&pointer.record_id)
            || pointer.sequence < 1
            || pointer.record_id != format!("{}-{id}", sequence_name(pointer.sequence))
        {
            return Err(store_error("A durable inbox identity pointer is malformed; its record was retained."));
        }
        let scope = scope_of(identity);
        let Some(value) = self.read(&self.record_file(RecordKind::Inbox, &scope, &pointer.record_id)?, "inbox record")? else {
            return Ok(None);
        };
        let entry = parse_inbox(&value, "inbox record")?;
        if entry.sequence != pointer.sequence || identity_key(&entry.identity) != identity_key(identity) {
            return Err(store_error("A durable inbox identity pointer resolves to a different immutable record."));
        }
        Ok(Some(entry))
    }

    fn reserved_sequence(&self, kind_dir: &str, identity: &PeerMessageIdentity) -> Result<Option<u64>> {
        let id = identity_digest(identity);
        let file = self.id_index_file(kind_dir, identity);
        let Some(pointer) = self.read(&file, "id reservation")? else {
            return Ok(None);
        };
        let pointer: IndexPointer = serde_json::from_value(pointer)
            .map_err(|_| store_error("A durable id reservation is malformed; its record was retained."))?;
        if pointer.sequence < 1
            || pointer.record_id != format!("{}-{id}", sequence_name(pointer.sequence))
        {
            return Err(store_error("A durable id reservation is malformed; its record was retained."));
        }
        Ok(Some(pointer.sequence))
    }

    /* -------------------------------- writers ------------------------------- */

    fn pointer_for(&self, entry: &PeerMessageIdentity, sequence: u64) -> IndexPointer {
        IndexPointer {
            sequence,
            record_id: format!("{}-{}", sequence_name(sequence), identity_digest(entry)),
            identity: Some(entry.clone()),
            scope: None,
        }
    }

    fn write_pointer(&self, file: &Path, pointer: &IndexPointer) -> Result<()> {
        let value = serde_json::to_value(pointer).map_err(|_| store_error("A client store pointer could not be encoded."))?;
        let current = self.read(file, "index pointer")?;
        if current.as_ref() == Some(&value) {
            return Ok(());
        }
        self.write(file, &value)
    }

    fn sync_index(
        &self,
        kind: IndexKind,
        scope: &PeerClientRouteScope,
        pointer: &IndexPointer,
        present: bool,
    ) -> Result<()> {
        if !valid_record_id(&pointer.record_id)
            || parse_index_name(&format!("{}.json", pointer.record_id))
                .map(|(seq, _)| seq)
                != Some(pointer.sequence)
        {
            return Err(store_error("A client store index pointer is malformed."));
        }
        let dir = self.index_bucket_dir(kind, scope, pointer.sequence);
        let file = dir.join(index_name(pointer.sequence, &pointer.record_id[17..]));
        if !present {
            remove_file(&file)?;
            let _ = fs::remove_dir(&dir);
            return Ok(());
        }
        ensure_private_dir(&dir)?;
        self.write_pointer(&file, pointer)
    }

    fn ensure_outbox_indexes(
        &self,
        entry: &StoredOutboxEntry,
        supplied: Option<IndexPointer>,
        publishing: bool,
    ) -> Result<()> {
        let scope = scope_of(&entry.identity);
        let pointer = supplied.unwrap_or_else(|| self.pointer_for(&entry.identity, entry.sequence));
        self.write_pointer(&self.id_index_file("outbox-by-id", &entry.identity), &pointer)?;
        if !publishing || entry.state == "pending" {
            self.sync_index(IndexKind::OutboxPending, &scope, &pointer, entry.state == "pending")?;
        }
        if !publishing || entry.state != "pending" {
            self.sync_index(IndexKind::OutboxHistory, &scope, &pointer, entry.state != "pending")?;
        }
        self.advance_sequence(&scope, "outbox", entry.sequence)
    }

    fn ensure_inbox_indexes(
        &self,
        entry: &StoredInboxEntry,
        supplied: Option<IndexPointer>,
        publishing: bool,
    ) -> Result<()> {
        let scope = scope_of(&entry.identity);
        let pointer = supplied.unwrap_or_else(|| self.pointer_for(&entry.identity, entry.sequence));
        self.write_pointer(&self.id_index_file("inbox-by-id", &entry.identity), &pointer)?;
        let pending = entry.dispatch == "pending" && entry.plaintext.is_some();
        if !publishing || pending {
            self.sync_index(IndexKind::InboxPending, &scope, &pointer, pending)?;
        }
        if !publishing || entry.delivery_ack.is_none() {
            self.sync_index(IndexKind::InboxAckPending, &scope, &pointer, entry.delivery_ack.is_none())?;
        }
        if !publishing || entry.dispatch != "pending" {
            self.sync_index(IndexKind::InboxHistory, &scope, &pointer, entry.dispatch != "pending")?;
        }
        self.advance_sequence(&scope, "inbox", entry.sequence)
    }

    fn ensure_history_indexes(&self, entry: &StoredPeerHistoryEntry, supplied: Option<IndexPointer>) -> Result<()> {
        let scope = PeerClientRouteScope {
            tenant_id: entry.tenant_id.clone(),
            route_id: entry.route_id.clone(),
        };
        let pointer = supplied.unwrap_or(IndexPointer {
            sequence: entry.sequence,
            record_id: format!("{}-{}", sequence_name(entry.sequence), digest(&entry.evidence_id)),
            identity: None,
            scope: None,
        });
        let id = digest(&entry.evidence_id);
        let file = self.data.join("peer-history-by-id").join(scope_digest(&scope)).join(format!("{id}.json"));
        self.write_pointer(&file, &pointer)?;
        self.sync_index(IndexKind::PeerHistory, &scope, &pointer, true)?;
        self.advance_sequence(&scope, "history", entry.sequence)
    }

    fn write_outbox_entry(&self, entry: &StoredOutboxEntry, check_capacity: bool, check_sequence: bool) -> Result<()> {
        if check_capacity {
            self.assert_record_capacity(entry)?;
        }
        let scope = scope_of(&entry.identity);
        let pointer = self.pointer_for(&entry.identity, entry.sequence);
        if check_sequence {
            self.assert_sequence_available(RecordKind::Outbox, &scope, &pointer)?;
        }
        self.ensure_outbox_indexes(entry, Some(pointer.clone()), true)?;
        let file = self.record_file(RecordKind::Outbox, &scope, &pointer.record_id)?;
        self.write(&file, &serde_json::to_value(entry).map_err(|_| store_error("A durable outbox record could not be encoded."))?)?;
        if entry.state != "pending" {
            self.sync_index(IndexKind::OutboxPending, &scope, &pointer, false)?;
        }
        Ok(())
    }

    fn write_inbox_entry(&self, entry: &StoredInboxEntry, check_capacity: bool, check_sequence: bool) -> Result<()> {
        if check_capacity {
            self.assert_record_capacity(entry)?;
        }
        let scope = scope_of(&entry.identity);
        let pointer = self.pointer_for(&entry.identity, entry.sequence);
        if check_sequence {
            self.assert_sequence_available(RecordKind::Inbox, &scope, &pointer)?;
        }
        self.ensure_inbox_indexes(entry, Some(pointer.clone()), true)?;
        let file = self.record_file(RecordKind::Inbox, &scope, &pointer.record_id)?;
        self.write(&file, &serde_json::to_value(entry).map_err(|_| store_error("A durable inbox record could not be encoded."))?)?;
        if entry.dispatch != "pending" || entry.plaintext.is_none() {
            self.sync_index(IndexKind::InboxPending, &scope, &pointer, false)?;
        }
        if entry.delivery_ack.is_some() {
            self.sync_index(IndexKind::InboxAckPending, &scope, &pointer, false)?;
        }
        if entry.dispatch == "pending" {
            self.sync_index(IndexKind::InboxHistory, &scope, &pointer, false)?;
        }
        Ok(())
    }

    fn write_history_entry(&self, entry: &StoredPeerHistoryEntry) -> Result<()> {
        self.assert_record_capacity(entry)?;
        let scope = PeerClientRouteScope {
            tenant_id: entry.tenant_id.clone(),
            route_id: entry.route_id.clone(),
        };
        let pointer = IndexPointer {
            sequence: entry.sequence,
            record_id: format!("{}-{}", sequence_name(entry.sequence), digest(&entry.evidence_id)),
            identity: None,
            scope: None,
        };
        self.assert_sequence_available(RecordKind::History, &scope, &pointer)?;
        self.ensure_history_indexes(entry, Some(pointer))?;
        let file = self.record_file(RecordKind::History, &scope, &format!("{}-{}", sequence_name(entry.sequence), digest(&entry.evidence_id)))?;
        self.write(&file, &serde_json::to_value(entry).map_err(|_| store_error("A durable history record could not be encoded."))?)
    }

    /* -------------------------------- listing ------------------------------- */

    fn list_indexed<T, P, F>(
        &self,
        kind: IndexKind,
        record_kind: RecordKind,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
        predicate: P,
        parse: F,
    ) -> Result<PeerClientPage<T>>
    where
        P: Fn(&T) -> bool,
        F: Fn(&Value, &str) -> Result<T>,
        T: Sequenced + Scoped + serde::Serialize,
    {
        self.ensure_migrated(scope)?;
        if query.limit < 1 {
            return Err(store_error("A page query is malformed."));
        }
        let limit = query.limit.min(256);
        let first_bucket = query.after_sequence / INDEX_BUCKET_SIZE;
        let mut items: Vec<T> = Vec::new();
        'buckets: for bucket in self.index_buckets(kind, scope, first_bucket)? {
            if items.len() >= limit {
                break;
            }
            let dir = self.scope_dir(kind.dir(), scope).join(format!("{bucket:010}"));
            let mut names: Vec<String> = match fs::read_dir(&dir) {
                Ok(entries) => entries
                    .filter_map(|e| e.ok())
                    .filter_map(|e| e.file_name().to_str().map(str::to_string))
                    .collect(),
                Err(_) => continue,
            };
            names.sort();
            if names.is_empty() {
                let _ = fs::remove_dir(&dir);
            }
            for name in names {
                if !name.ends_with(".json") {
                    continue;
                }
                let index_file = dir.join(&name);
                let Some((sequence, record_digest)) = parse_index_name(&name) else {
                    remove_file(&index_file)?;
                    continue;
                };
                if sequence <= query.after_sequence {
                    continue;
                }
                let record_id = format!("{}-{}", sequence_name(sequence), record_digest);
                let record_file = self.record_file(record_kind, scope, &record_id)?;
                let Some(value) = self.read(&record_file, &record_id)? else {
                    remove_file(&index_file)?;
                    continue;
                };
                let parsed = parse(&value, &record_id)?;
                let expected_digest = match record_kind {
                    RecordKind::History => {
                        let raw: StoredPeerHistoryEntry =
                            serde_json::from_value(value.clone()).unwrap_or_else(|_| StoredPeerHistoryEntry {
                                sequence: 0,
                                version: 0,
                                evidence_id: String::new(),
                                tenant_id: String::new(),
                                route_id: String::new(),
                                source: String::new(),
                                message_id: None,
                                device_id: None,
                                former_position: None,
                                former_gap: None,
                                former_state: None,
                                former_receipt_facts: Vec::new(),
                                legacy_record: None,
                                recorded_at: String::new(),
                            });
                        digest(&raw.evidence_id)
                    }
                    _ => {
                        let parsed_id = serde_json::from_value::<PeerMessageIdentity>(value.clone())
                            .unwrap_or_else(|_| PeerMessageIdentity {
                                tenant_id: String::new(),
                                route_id: String::new(),
                                sender_device_id: String::new(),
                                recipient_device_id: String::new(),
                                message_id: String::new(),
                            });
                        identity_digest(&parsed_id)
                    }
                };
                if parsed.sequence() != sequence
                    || parsed.tenant_id() != scope.tenant_id
                    || parsed.route_id() != scope.route_id
                    || record_id != format!("{}-{}", sequence_name(sequence), expected_digest)
                {
                    remove_file(&index_file)?;
                    continue;
                }
                let pointer = match record_kind {
                    RecordKind::History => IndexPointer {
                        sequence,
                        record_id: record_id.clone(),
                        identity: None,
                        scope: None,
                    },
                    _ => IndexPointer {
                        sequence,
                        record_id: record_id.clone(),
                        identity: Some(PeerMessageIdentity {
                            tenant_id: parsed.tenant_id().to_string(),
                            route_id: parsed.route_id().to_string(),
                            sender_device_id: parsed.sender_device_id().to_string(),
                            recipient_device_id: parsed.recipient_device_id().to_string(),
                            message_id: parsed.message_id().to_string(),
                        }),
                        scope: None,
                    },
                };
                let pointer_value = self.read(&index_file, &name)?;
                let expected_pointer = serde_json::to_value(&pointer).unwrap_or(Value::Null);
                if pointer_value.as_ref() != Some(&expected_pointer) {
                    self.write_pointer(&index_file, &pointer)?;
                }
                if !predicate(&parsed) {
                    remove_file(&index_file)?;
                    self.repair_indexes(record_kind, scope, &pointer, &parsed)?;
                    continue;
                }
                items.push(parsed);
                if items.len() >= limit {
                    break 'buckets;
                }
            }
        }
        Ok(PeerClientPage {
            next_after_sequence: items.last().map(|i| i.sequence()),
            items,
        })
    }

    fn repair_indexes<T: Sequenced + Scoped + serde::Serialize>(
        &self,
        record_kind: RecordKind,
        _scope: &PeerClientRouteScope,
        pointer: &IndexPointer,
        value: &T,
    ) -> Result<()> {
        match record_kind {
            RecordKind::Outbox => {
                let entry: StoredOutboxEntry = serde_json::from_value(serde_json::to_value(value).unwrap_or(Value::Null))
                    .map_err(|_| store_error("A durable outbox record is malformed."))?;
                self.ensure_outbox_indexes(&entry, Some(pointer.clone()), false)
            }
            RecordKind::Inbox => {
                let entry: StoredInboxEntry = serde_json::from_value(serde_json::to_value(value).unwrap_or(Value::Null))
                    .map_err(|_| store_error("A durable inbox record is malformed."))?;
                self.ensure_inbox_indexes(&entry, Some(pointer.clone()), false)
            }
            RecordKind::History => {
                let entry: StoredPeerHistoryEntry = serde_json::from_value(serde_json::to_value(value).unwrap_or(Value::Null))
                    .map_err(|_| store_error("A durable history record is malformed."))?;
                self.ensure_history_indexes(&entry, Some(pointer.clone()))
            }
        }
    }
}

/// Shared sequence/identity accessors for paged records.
pub trait Sequenced {
    fn sequence(&self) -> u64;
}

/// Shared scope accessors for paged records.
pub trait Scoped {
    fn tenant_id(&self) -> &str;
    fn route_id(&self) -> &str;
    fn sender_device_id(&self) -> &str {
        ""
    }
    fn recipient_device_id(&self) -> &str {
        ""
    }
    fn message_id(&self) -> &str {
        ""
    }
}

impl Sequenced for StoredOutboxEntry {
    fn sequence(&self) -> u64 {
        self.sequence
    }
}
impl Scoped for StoredOutboxEntry {
    fn tenant_id(&self) -> &str {
        &self.identity.tenant_id
    }
    fn route_id(&self) -> &str {
        &self.identity.route_id
    }
    fn sender_device_id(&self) -> &str {
        &self.identity.sender_device_id
    }
    fn recipient_device_id(&self) -> &str {
        &self.identity.recipient_device_id
    }
    fn message_id(&self) -> &str {
        &self.identity.message_id
    }
}

impl Sequenced for StoredInboxEntry {
    fn sequence(&self) -> u64 {
        self.sequence
    }
}
impl Scoped for StoredInboxEntry {
    fn tenant_id(&self) -> &str {
        &self.identity.tenant_id
    }
    fn route_id(&self) -> &str {
        &self.identity.route_id
    }
    fn sender_device_id(&self) -> &str {
        &self.identity.sender_device_id
    }
    fn recipient_device_id(&self) -> &str {
        &self.identity.recipient_device_id
    }
    fn message_id(&self) -> &str {
        &self.identity.message_id
    }
}

impl Sequenced for StoredPeerHistoryEntry {
    fn sequence(&self) -> u64 {
        self.sequence
    }
}
impl Scoped for StoredPeerHistoryEntry {
    fn tenant_id(&self) -> &str {
        &self.tenant_id
    }
    fn route_id(&self) -> &str {
        &self.route_id
    }
}

impl PeerClientStore for FilePeerClientStore {
    fn prepare_route(&self, route: &PeerClientRouteIdentity) -> Result<()> {
        self.bind_route(route)
    }

    fn assert_available_capacity(&self, additional_bytes: usize) -> Result<()> {
        assert_private_storage_capacity(&self.root, additional_bytes)
    }

    fn load_meta(&self) -> Result<Option<PeerClientMeta>> {
        let value = self.read(&self.data.join("meta").join("meta.json"), "meta")?;
        match value {
            Some(v) if v.is_object() => parse_meta(&v).map(Some),
            // Preserve the old metadata document in place until the retained
            // bundle and pins are read by the new client.
            _ => {
                let legacy = self.read(&self.root.join("meta.json"), "legacy meta")?;
                match legacy {
                    Some(v) if v.is_object() => parse_meta(&v).map(Some),
                    _ => Ok(None),
                }
            }
        }
    }

    fn save_meta(&self, meta: &PeerClientMeta) -> Result<()> {
        let target = self.data.join("meta").join("meta.json");
        let existing = self.read(&target, "meta")?;
        let legacy = match existing.as_ref().filter(|v| v.is_object()) {
            Some(v) => v.clone(),
            None => self
                .read(&self.root.join("meta.json"), "legacy meta")?
                .filter(|v| v.is_object())
                .unwrap_or(Value::Null),
        };
        let mut next = serde_json::Map::new();
        if let Some(obj) = legacy.as_object() {
            for (k, v) in obj {
                if !["version", "v", "localBundle", "peers", "bundleObservations"].contains(&k.as_str()) {
                    next.insert(k.clone(), v.clone());
                }
            }
        }
        let meta_value = serde_json::to_value(meta).map_err(|_| store_error("The client metadata could not be encoded."))?;
        if let Some(obj) = meta_value.as_object() {
            for (k, v) in obj {
                next.insert(k.clone(), v.clone());
            }
        }
        let next_value = Value::Object(next);
        if existing.as_ref() == Some(&next_value) {
            return Ok(());
        }
        self.write(&target, &next_value)
    }

    fn allocate_outbox_sequence(&self, scope: &PeerClientRouteScope) -> Result<u64> {
        self.allocate(scope, "outbox")
    }
    fn allocate_inbox_sequence(&self, scope: &PeerClientRouteScope) -> Result<u64> {
        self.allocate(scope, "inbox")
    }
    fn allocate_history_sequence(&self, scope: &PeerClientRouteScope) -> Result<u64> {
        self.allocate(scope, "history")
    }

    fn load_outbox_entry(&self, identity: &PeerMessageIdentity) -> Result<Option<StoredOutboxEntry>> {
        self.assert_bound_identity(identity, "senderDeviceId")?;
        self.ensure_migrated(&scope_of(identity))?;
        self.load_outbox_direct(identity)
    }

    fn save_outbox_entry(&self, entry: &StoredOutboxEntry) -> Result<()> {
        let checked = parse_outbox(&serde_json::to_value(entry).map_err(|_| store_error("The outbox entry could not be encoded."))?, "outbox entry")?;
        let scope = scope_of(&checked.identity);
        self.assert_bound_identity(&checked.identity, "senderDeviceId")?;
        self.ensure_migrated(&scope)?;
        match self.load_outbox_direct(&checked.identity)? {
            Some(existing) => {
                if existing.sequence != checked.sequence
                    || existing.peer_id != checked.peer_id
                    || !same_envelope(&existing.envelope, &checked.envelope)
                {
                    return Err(conflict_error(
                        "A durable outbox identity cannot change its sequence, peer or ciphertext.",
                    ));
                }
                if existing.state != "pending" && checked.state == "pending" {
                    return Err(conflict_error(
                        "A durable outbox state cannot return to pending after settlement.",
                    ));
                }
                if existing.state != "pending" && checked.state != existing.state {
                    return Err(conflict_error("A settled outbox state cannot be replaced."));
                }
                if existing.delivery_ack.is_some()
                    && !same_json(
                        &serde_json::to_value(&existing.delivery_ack).unwrap_or(Value::Null),
                        &serde_json::to_value(&checked.delivery_ack).unwrap_or(Value::Null),
                    )
                {
                    return Err(conflict_error("A durable outbox receipt cannot be replaced."));
                }
                if same_json(
                    &serde_json::to_value(&existing).unwrap_or(Value::Null),
                    &serde_json::to_value(&checked).unwrap_or(Value::Null),
                ) {
                    return self.ensure_outbox_indexes(&existing, None, false);
                }
                self.write_outbox_entry(&checked, false, false)
            }
            None => {
                if let Some(reserved) = self.reserved_sequence("outbox-by-id", &checked.identity)? {
                    if reserved != checked.sequence {
                        return Err(conflict_error(
                            "A durable outbox identity already reserves a different local sequence.",
                        ));
                    }
                }
                self.write_outbox_entry(&checked, false, true)
            }
        }
    }

    fn list_pending_outbox_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredOutboxEntry>> {
        self.assert_bound_scope(scope)?;
        self.list_indexed(IndexKind::OutboxPending, RecordKind::Outbox, scope, query,
            |e: &StoredOutboxEntry| e.state == "pending", parse_outbox)
    }

    fn list_outbox_history_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredOutboxEntry>> {
        self.assert_bound_scope(scope)?;
        self.list_indexed(IndexKind::OutboxHistory, RecordKind::Outbox, scope, query,
            |e: &StoredOutboxEntry| e.state != "pending", parse_outbox)
    }

    fn load_inbox_entry(&self, identity: &PeerMessageIdentity) -> Result<Option<StoredInboxEntry>> {
        self.assert_bound_identity(identity, "recipientDeviceId")?;
        self.ensure_migrated(&scope_of(identity))?;
        self.load_inbox_direct(identity)
    }

    fn save_inbox_entry(&self, entry: &StoredInboxEntry) -> Result<()> {
        let checked = parse_inbox(&serde_json::to_value(entry).map_err(|_| store_error("The inbox entry could not be encoded."))?, "inbox entry")?;
        let scope = scope_of(&checked.identity);
        self.assert_bound_identity(&checked.identity, "recipientDeviceId")?;
        self.ensure_migrated(&scope)?;
        match self.load_inbox_direct(&checked.identity)? {
            Some(existing) => {
                if existing.sequence != checked.sequence
                    || existing.sender_peer_id != checked.sender_peer_id
                    || !same_envelope(&existing.envelope, &checked.envelope)
                    || existing.plaintext != checked.plaintext
                    || existing.received_at != checked.received_at
                {
                    return Err(conflict_error(
                        "A durable inbox identity cannot change its committed message.",
                    ));
                }
                if existing.dispatch != "pending" && checked.dispatch == "pending" {
                    return Err(conflict_error(
                        "A durable inbox dispatch state cannot return to pending after settlement.",
                    ));
                }
                if existing.dispatch != "pending" && checked.dispatch != existing.dispatch {
                    return Err(conflict_error("A settled inbox dispatch state cannot be replaced."));
                }
                if existing.delivery_ack.is_some()
                    && !same_json(
                        &serde_json::to_value(&existing.delivery_ack).unwrap_or(Value::Null),
                        &serde_json::to_value(&checked.delivery_ack).unwrap_or(Value::Null),
                    )
                {
                    return Err(conflict_error("A durable inbox receipt cannot be replaced."));
                }
                if same_json(
                    &serde_json::to_value(&existing).unwrap_or(Value::Null),
                    &serde_json::to_value(&checked).unwrap_or(Value::Null),
                ) {
                    return self.ensure_inbox_indexes(&existing, None, false);
                }
                self.write_inbox_entry(&checked, false, false)
            }
            None => {
                if let Some(reserved) = self.reserved_sequence("inbox-by-id", &checked.identity)? {
                    if reserved != checked.sequence {
                        return Err(conflict_error(
                            "A durable inbox identity already reserves a different local sequence.",
                        ));
                    }
                }
                self.write_inbox_entry(&checked, false, true)
            }
        }
    }

    fn list_pending_inbox_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredInboxEntry>> {
        self.assert_bound_scope(scope)?;
        self.list_indexed(IndexKind::InboxPending, RecordKind::Inbox, scope, query,
            |e: &StoredInboxEntry| e.dispatch == "pending" && e.plaintext.is_some(), parse_inbox)
    }

    fn list_pending_delivery_ack_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredInboxEntry>> {
        self.assert_bound_scope(scope)?;
        self.list_indexed(IndexKind::InboxAckPending, RecordKind::Inbox, scope, query,
            |e: &StoredInboxEntry| e.delivery_ack.is_none(), parse_inbox)
    }

    fn list_inbox_history_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredInboxEntry>> {
        self.assert_bound_scope(scope)?;
        self.list_indexed(IndexKind::InboxHistory, RecordKind::Inbox, scope, query,
            |e: &StoredInboxEntry| e.dispatch != "pending", parse_inbox)
    }

    fn save_peer_history_entry(&self, entry: &StoredPeerHistoryEntry) -> Result<()> {
        let checked = parse_history(&serde_json::to_value(entry).map_err(|_| store_error("The history entry could not be encoded."))?, "history entry")?;
        let scope = PeerClientRouteScope {
            tenant_id: checked.tenant_id.clone(),
            route_id: checked.route_id.clone(),
        };
        self.ensure_migrated(&scope)?;
        match self.find_history_evidence(&scope, &checked.evidence_id)? {
            Some(existing) => {
                if !same_json(
                    &serde_json::to_value(&existing).unwrap_or(Value::Null),
                    &serde_json::to_value(&checked).unwrap_or(Value::Null),
                ) {
                    return Err(conflict_error(
                        "A historical Peer evidence identity already contains different data.",
                    ));
                }
                self.ensure_history_indexes(&existing, None)
            }
            None => {
                if let Some(reserved) = self.reserved_history_sequence(&scope, &checked.evidence_id)? {
                    if reserved != checked.sequence {
                        return Err(conflict_error(
                            "A historical Peer evidence identity already reserves a different local sequence.",
                        ));
                    }
                }
                self.write_history_entry(&checked)
            }
        }
    }

    fn list_peer_history_page(
        &self,
        scope: &PeerClientRouteScope,
        query: PeerClientPageQuery,
    ) -> Result<PeerClientPage<StoredPeerHistoryEntry>> {
        self.assert_bound_scope(scope)?;
        self.list_indexed(IndexKind::PeerHistory, RecordKind::History, scope, query,
            |_| true, parse_history)
    }
}

pub fn create_file_peer_client_store(root: impl Into<PathBuf>) -> Result<FilePeerClientStore> {
    FilePeerClientStore::new(root)
}

pub fn create_in_memory_peer_client_store() -> InMemoryPeerClientStore {
    InMemoryPeerClientStore::new()
}
