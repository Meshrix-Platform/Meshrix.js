//! Client-owned reliable delivery over the online private relay — port of
//! `peer-client/src/client.ts` (+ `inbox.ts` / `outbox.ts` helpers).
//!
//! The relay forwards ciphertext only; the exact local outbox survives
//! uncertainty and the recipient's signed durable receipt is the only
//! delivered transition. Everything here runs on the peer runtime's
//! single-thread local executor — crypto stores are `?Send` and file IO is
//! synchronous by design.
//!
//! Wire compatibility: this emits and consumes the exact `private-relay-peer`
//! wire contract so Rust and TypeScript clients interoperate byte-for-byte.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use futures_util::future::LocalBoxFuture;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

use crate::b64::{b64u_decode, b64u_encode};
use crate::error::{entry_error, EntryError, Result};

use super::bundle::{generate_peer_prekey_bundle, PeerPreKeyBundle};
use super::client_store::{
    empty_peer_client_meta, PeerClientMeta, PeerClientPage, PeerClientPageQuery,
    PeerClientRouteIdentity, PeerClientRouteScope, PeerClientStore, StoredBundleObservation,
    StoredInboxEntry, StoredLocalBundle, StoredOutboxEntry, PEER_CLIENT_STORE_RECORD_VERSION,
};
use super::envelope::{PeerEnvelope, PeerEnvelopeMessageType};
use super::identity::{
    replenish_peer_prekeys, sign_peer_identity_message, verify_peer_identity_message, PairedSignalIdentity, PeerIdentity,
};
use super::overlay::create_peer_crypto_transaction_overlay;
use super::session::{
    block_peer_identity, peer_safety_number, pin_peer_identity, repin_peer_identity, PeerSession,
};
use super::store::{
    mutations_to_json, PeerCryptoPreparedOperation, PeerCryptoStore, PeerIdentityBinding,
};
use super::types::is_peer_id;
use super::wire::{
    self, create_peer_bundle_fetch, create_peer_bundle_publish, create_peer_delivery_ack,
    create_peer_send, parse_peer_bundle, parse_peer_bundle_published,
    parse_peer_delivery_ack, parse_peer_forwarded, parse_peer_presence, parse_peer_send,
    parse_private_relay_peer_message, peer_delivery_ack_matches_send,
    peer_delivery_ack_signing_input_for_send, peer_delivery_ack_transcript, PeerBundleFetch,
    PeerBundlePublish, PeerDeliveryAck, PeerForwarded, PeerMessageIdentity, PeerPresence, PeerSend,
    PeerWireEnvelope, PrekeyBundlePublication, PEER_KIND_DELIVERY_ACK, PEER_KIND_SEND,
};

fn client_error(detail: &str) -> EntryError {
    entry_error("peer_client_state", detail)
}

fn conflict_error(detail: &str) -> EntryError {
    entry_error("peer_client_conflict", detail)
}

fn transport_error(detail: &str) -> EntryError {
    entry_error("peer_client_transport", detail)
}

fn store_error(detail: &str) -> EntryError {
    entry_error("peer_client_store", detail)
}

fn crypto_error(code: &str, detail: &str) -> EntryError {
    entry_error(code, detail)
}

pub const PEER_CLIENT_MAX_PLAINTEXT_BYTES: usize = 32_768;
pub const PEER_CLIENT_DEFAULT_PAGE_SIZE: usize = 32;
pub const PEER_CLIENT_MAX_UNCONFIRMED_MESSAGES_PER_ROUTE: usize = 16;
const CLIENT_RECEIVE_WINDOW: usize = 16;
const CLIENT_DISPATCH_WINDOW: usize = CLIENT_RECEIVE_WINDOW;
const OLD_PLAINTEXT_LIMIT: usize = 57_344;
const FORWARD_RETRY_INITIAL_DELAY_MS: u64 = 1_000;
const FORWARD_RETRY_MAX_DELAY_MS: u64 = 30_000;
const PEER_CLIENT_DEFAULT_WIRE_PROFILE: &str = wire::PROFILE_PQXDH;

/// Sender-scoped message id — uuid-shaped, unique per sender.
pub fn new_peer_message_id() -> String {
    format!("msg.{}", uuid_simple())
}

/// Local bundle record id — allocated once per store.
pub fn new_peer_bundle_id() -> String {
    format!("bundle.{}", uuid_simple())
}

pub(crate) fn uuid_simple() -> String {
    let mut bytes = [0u8; 16];
    rand::Rng::fill(&mut rand::rng(), &mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

fn assert_opaque_id(value: &str, field: &str) -> Result<String> {
    if !wire::is_peer_opaque_id(value) {
        return Err(client_error(&format!(
            "The {field} field is not a valid opaque wire identifier."
        )));
    }
    Ok(value.to_string())
}

fn assert_peer_id(value: &str, field: &str) -> Result<String> {
    if !is_peer_id(value) {
        return Err(client_error(&format!(
            "The {field} field is not a valid peer identifier."
        )));
    }
    Ok(value.to_string())
}

/* ------------------------------ public types ------------------------------- */

#[derive(Debug, Clone)]
pub struct PeerRouteIdentity {
    pub tenant_id: String,
    pub route_id: String,
    pub device_id: String,
}

/// Decrypted message committed to the local inbox before application dispatch.
#[derive(Debug, Clone)]
pub struct PeerInboundMessage {
    pub message_id: String,
    pub sender_peer_id: String,
    pub sender_device_id: String,
    pub plaintext: Vec<u8>,
    pub received_at: String,
}

/// Outcome a dispatch handler settles an inbound message with.
#[derive(Debug, Clone)]
pub enum PeerInboundOutcome {
    AcceptedByAgent,
    Rejected { detail: Vec<u8> },
    Deferred { detail: Vec<u8> },
}

impl PeerInboundOutcome {
    fn kind(&self) -> &'static str {
        match self {
            Self::AcceptedByAgent => "accepted_by_agent",
            Self::Rejected { .. } => "rejected",
            Self::Deferred { .. } => "deferred",
        }
    }
}

pub type PeerDispatchHandler =
    Rc<dyn Fn(PeerInboundMessage) -> LocalBoxFuture<'static, PeerInboundOutcome>>;

/// Resolves a route peer device to its authenticated pairing identity.
/// Implementations read stored connection state — never relay metadata.
pub trait PeerDeviceDirectory {
    fn resolve_peer_identity(
        &self,
        peer_device_id: &str,
    ) -> LocalBoxFuture<'static, Option<PairedSignalIdentity>>;
}

/// Outbound transport: serializes a peer-schema wire object onto the admitted
/// session lane. Failure is transport evidence, not durable state.
pub trait PeerClientTransport {
    fn send<'a>(&'a self, message: Value) -> LocalBoxFuture<'a, Result<()>>;
}

/// Client events the owning runtime forwards to the service/UI layer.
#[derive(Debug, Clone)]
pub enum PeerClientEvent {
    Inbound(PeerInboundMessage),
    SendState {
        message_id: String,
        peer_device_id: String,
        state: String,
        last_forwarded: Option<PeerForwarded>,
    },
    Conflict {
        message_id: String,
        peer_device_id: String,
    },
    RequiresRePair {
        peer_id: String,
        source: String,
        detail: String,
    },
    BundlePublished {
        bundle_id: String,
        revision: u64,
        outcome: String,
    },
    BundleRefused {
        refusal: String,
    },
    /// Route-scoped retry wakeup, not authorization.
    PeerPresence(PeerPresence),
    DispatchDeferred {
        message_id: String,
        sender_device_id: String,
    },
    Error {
        code: String,
        detail: String,
    },
}

/* --------------------------------- outbox ---------------------------------- */

/// Durable sender-owned ciphertext queue.
pub struct PeerOutbox {
    store: Rc<dyn PeerClientStore>,
    scope: PeerClientRouteScope,
    sender_device_id: String,
}

impl PeerOutbox {
    pub fn new(store: Rc<dyn PeerClientStore>, route: &PeerRouteIdentity) -> Self {
        Self {
            store,
            scope: PeerClientRouteScope {
                tenant_id: route.tenant_id.clone(),
                route_id: route.route_id.clone(),
            },
            sender_device_id: route.device_id.clone(),
        }
    }

    pub fn identity(&self, message_id: &str, recipient_device_id: &str) -> Result<PeerMessageIdentity> {
        Ok(PeerMessageIdentity {
            tenant_id: self.scope.tenant_id.clone(),
            route_id: self.scope.route_id.clone(),
            sender_device_id: self.sender_device_id.clone(),
            recipient_device_id: assert_opaque_id(recipient_device_id, "recipientDeviceId")?,
            message_id: assert_opaque_id(message_id, "messageId")?,
        })
    }

    pub fn entry(&self, message_id: &str, recipient_device_id: &str) -> Result<Option<StoredOutboxEntry>> {
        self.store.load_outbox_entry(&self.identity(message_id, recipient_device_id)?)
    }

    pub fn entry_for_identity(&self, identity: &PeerMessageIdentity) -> Result<Option<StoredOutboxEntry>> {
        self.store.load_outbox_entry(identity)
    }

    pub fn pending_page(
        &self,
        after_sequence: u64,
        limit: usize,
    ) -> Result<PeerClientPage<StoredOutboxEntry>> {
        self.store.list_pending_outbox_page(&self.scope, PeerClientPageQuery { after_sequence, limit })
    }

    pub fn history_page(
        &self,
        after_sequence: u64,
        limit: usize,
    ) -> Result<PeerClientPage<StoredOutboxEntry>> {
        self.store.list_outbox_history_page(&self.scope, PeerClientPageQuery { after_sequence, limit })
    }

    /// Create (not yet persisted) a pending outbox entry.
    pub fn create_entry(&self, input: NewOutboxEntry) -> Result<StoredOutboxEntry> {
        let identity = self.identity(&input.message_id, &input.recipient_device_id)?;
        let now = iso_now();
        let sequence = match input.sequence {
            Some(s) => s,
            None => self.store.allocate_outbox_sequence(&self.scope)?,
        };
        Ok(StoredOutboxEntry {
            identity,
            version: PEER_CLIENT_STORE_RECORD_VERSION,
            sequence,
            peer_id: assert_peer_id(&input.peer_id, "peerId")?,
            state: "pending".to_string(),
            envelope: input.envelope,
            attempts: 0,
            last_forwarded: None,
            delivery_ack: None,
            last_error: None,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    /// Idempotent create+persist; identical ciphertext is a retry.
    pub fn enqueue(&self, input: NewOutboxEntry) -> Result<StoredOutboxEntry> {
        let identity = self.identity(&input.message_id, &input.recipient_device_id)?;
        if let Some(existing) = self.store.load_outbox_entry(&identity)? {
            if serde_json::to_value(&existing.envelope).unwrap_or(Value::Null) == serde_json::to_value(&input.envelope).unwrap_or(Value::Null) {
                return Ok(existing);
            }
            return Err(conflict_error(&format!(
                "Message {} already has different ciphertext in the durable outbox.",
                identity.message_id
            )));
        }
        let entry = self.create_entry(input)?;
        self.save_entry(&entry)?;
        Ok(entry)
    }

    pub fn save_entry(&self, entry: &StoredOutboxEntry) -> Result<()> {
        let identity = self.identity(&entry.identity.message_id, &entry.identity.recipient_device_id)?;
        if let Some(existing) = self.store.load_outbox_entry(&identity)? {
            if serde_json::to_value(&existing).unwrap_or(Value::Null) == serde_json::to_value(entry).unwrap_or(Value::Null) {
                return Ok(());
            }
            return Err(conflict_error(&format!(
                "Message {} already has a different durable outbox record.",
                identity.message_id
            )));
        }
        self.store.save_outbox_entry(entry)
    }

    pub fn mark_attempt(&self, identity: &PeerMessageIdentity, last_error: Option<String>) -> Result<Option<StoredOutboxEntry>> {
        self.update(identity, |entry| {
            let mut next = entry.clone();
            next.attempts += 1;
            next.last_error = last_error.clone();
            next.updated_at = iso_now();
            Ok(next)
        })
    }

    pub fn note_forwarded(&self, identity: &PeerMessageIdentity, forwarded: &PeerForwarded) -> Result<Option<StoredOutboxEntry>> {
        self.update(identity, |entry| {
            if entry.state != "pending" {
                return Ok(entry.clone());
            }
            if serde_json::to_value(&entry.last_forwarded).unwrap_or(Value::Null) == serde_json::to_value(Some(forwarded)).unwrap_or(Value::Null) {
                return Ok(entry.clone());
            }
            let mut next = entry.clone();
            next.last_forwarded = Some(forwarded.clone());
            next.updated_at = iso_now();
            Ok(next)
        })
    }

    pub fn apply_delivery_ack(&self, identity: &PeerMessageIdentity, ack: &PeerDeliveryAck) -> Result<Option<StoredOutboxEntry>> {
        self.update(identity, |entry| {
            if entry.state == "delivered" {
                if serde_json::to_value(&entry.delivery_ack).unwrap_or(Value::Null) != serde_json::to_value(Some(ack)).unwrap_or(Value::Null) {
                    return Err(conflict_error(
                        "A delivered outbox identity received a different signed delivery ACK.",
                    ));
                }
                return Ok(entry.clone());
            }
            if entry.state == "conflict" {
                return Ok(entry.clone());
            }
            let mut next = entry.clone();
            next.state = "delivered".to_string();
            next.delivery_ack = Some(ack.clone());
            next.last_error = None;
            next.updated_at = iso_now();
            Ok(next)
        })
    }

    pub fn mark_conflict(&self, identity: &PeerMessageIdentity, detail: &str) -> Result<Option<StoredOutboxEntry>> {
        self.update(identity, |entry| {
            if entry.state == "conflict" {
                return Ok(entry.clone());
            }
            let mut next = entry.clone();
            next.state = "conflict".to_string();
            next.last_error = Some(detail.to_string());
            next.updated_at = iso_now();
            Ok(next)
        })
    }

    fn update(
        &self,
        identity: &PeerMessageIdentity,
        mutate: impl Fn(&StoredOutboxEntry) -> Result<StoredOutboxEntry>,
    ) -> Result<Option<StoredOutboxEntry>> {
        let Some(existing) = self.store.load_outbox_entry(identity)? else {
            return Ok(None);
        };
        let next = mutate(&existing)?;
        if serde_json::to_value(&next).unwrap_or(Value::Null) != serde_json::to_value(&existing).unwrap_or(Value::Null) {
            self.store.save_outbox_entry(&next)?;
        }
        Ok(Some(next))
    }
}

pub struct NewOutboxEntry {
    pub recipient_device_id: String,
    pub message_id: String,
    pub peer_id: String,
    pub envelope: PeerWireEnvelope,
    pub sequence: Option<u64>,
}

/* ---------------------------------- inbox ----------------------------------- */

#[derive(Debug)]
pub enum PeerInboxLookup {
    New,
    Duplicate(StoredInboxEntry),
    Conflict(StoredInboxEntry),
}

/// Local durable inbox keyed by the complete sender/recipient/message tuple.
pub struct PeerInbox {
    store: Rc<dyn PeerClientStore>,
    scope: PeerClientRouteScope,
    recipient_device_id: String,
}

impl PeerInbox {
    pub fn new(store: Rc<dyn PeerClientStore>, route: &PeerRouteIdentity) -> Self {
        Self {
            store,
            scope: PeerClientRouteScope {
                tenant_id: route.tenant_id.clone(),
                route_id: route.route_id.clone(),
            },
            recipient_device_id: route.device_id.clone(),
        }
    }

    pub fn identity(&self, message_id: &str, sender_device_id: &str) -> Result<PeerMessageIdentity> {
        Ok(PeerMessageIdentity {
            tenant_id: self.scope.tenant_id.clone(),
            route_id: self.scope.route_id.clone(),
            sender_device_id: assert_opaque_id(sender_device_id, "senderDeviceId")?,
            recipient_device_id: self.recipient_device_id.clone(),
            message_id: assert_opaque_id(message_id, "messageId")?,
        })
    }

    pub fn lookup(&self, identity: &PeerMessageIdentity, envelope: &PeerWireEnvelope) -> Result<PeerInboxLookup> {
        let Some(existing) = self.store.load_inbox_entry(identity)? else {
            return Ok(PeerInboxLookup::New);
        };
        if serde_json::to_value(&existing.envelope).unwrap_or(Value::Null) == serde_json::to_value(envelope).unwrap_or(Value::Null) {
            Ok(PeerInboxLookup::Duplicate(existing))
        } else {
            Ok(PeerInboxLookup::Conflict(existing))
        }
    }

    pub fn entry(&self, identity: &PeerMessageIdentity) -> Result<Option<StoredInboxEntry>> {
        self.store.load_inbox_entry(identity)
    }

    /// Strict idempotent insert: a differing tuple is a conflict.
    pub fn record(&self, entry: &StoredInboxEntry) -> Result<()> {
        if let Some(existing) = self.store.load_inbox_entry(&entry.identity)? {
            if serde_json::to_value(&existing).unwrap_or(Value::Null) == serde_json::to_value(entry).unwrap_or(Value::Null) {
                return Ok(());
            }
            return Err(conflict_error(
                "A durable inbox tuple already contains different message data.",
            ));
        }
        self.store.save_inbox_entry(entry)
    }

    /// Forgiving persist used during WAL recovery.
    pub fn save_entry(&self, entry: &StoredInboxEntry) -> Result<()> {
        if let Some(existing) = self.store.load_inbox_entry(&entry.identity)? {
            if serde_json::to_value(&existing).unwrap_or(Value::Null) == serde_json::to_value(entry).unwrap_or(Value::Null) {
                return Ok(());
            }
        }
        self.store.save_inbox_entry(entry)
    }

    pub fn pending_dispatch_page(
        &self,
        after_sequence: u64,
        limit: usize,
    ) -> Result<PeerClientPage<StoredInboxEntry>> {
        let mut page = self.store.list_pending_inbox_page(&self.scope, PeerClientPageQuery { after_sequence, limit })?;
        page.items.retain(|e| e.plaintext.is_some());
        Ok(page)
    }

    pub fn pending_delivery_ack_page(
        &self,
        after_sequence: u64,
        limit: usize,
    ) -> Result<PeerClientPage<StoredInboxEntry>> {
        self.store.list_pending_delivery_ack_page(&self.scope, PeerClientPageQuery { after_sequence, limit })
    }

    pub fn history_page(
        &self,
        after_sequence: u64,
        limit: usize,
    ) -> Result<PeerClientPage<StoredInboxEntry>> {
        self.store.list_inbox_history_page(&self.scope, PeerClientPageQuery { after_sequence, limit })
    }

    pub fn mark_dispatch(&self, identity: &PeerMessageIdentity, dispatch: &str) -> Result<Option<StoredInboxEntry>> {
        let Some(entry) = self.store.load_inbox_entry(identity)? else {
            return Ok(None);
        };
        if entry.dispatch == dispatch {
            return Ok(Some(entry));
        }
        let mut next = entry;
        next.dispatch = dispatch.to_string();
        next.updated_at = iso_now();
        self.store.save_inbox_entry(&next)?;
        Ok(Some(next))
    }

    pub fn mark_delivery_ack(&self, identity: &PeerMessageIdentity, ack: &PeerDeliveryAck) -> Result<Option<StoredInboxEntry>> {
        let Some(entry) = self.store.load_inbox_entry(identity)? else {
            return Ok(None);
        };
        if let Some(existing) = entry.delivery_ack.as_ref() {
            if serde_json::to_value(existing).unwrap_or(Value::Null) != serde_json::to_value(ack).unwrap_or(Value::Null) {
                return Err(conflict_error("A durable inbox tuple already has a different signed ACK."));
            }
            return Ok(Some(entry));
        }
        let mut next = entry;
        next.delivery_ack = Some(ack.clone());
        next.updated_at = iso_now();
        self.store.save_inbox_entry(&next)?;
        Ok(Some(next))
    }

    pub fn create_entry(&self, input: NewInboxEntry) -> StoredInboxEntry {
        let now = iso_now();
        StoredInboxEntry {
            identity: input.identity,
            version: PEER_CLIENT_STORE_RECORD_VERSION,
            sequence: input.sequence,
            sender_peer_id: input.sender_peer_id,
            envelope: input.envelope,
            plaintext: input.plaintext,
            decrypt_error: input.decrypt_error,
            dispatch: input.dispatch,
            delivery_ack: input.delivery_ack,
            received_at: now.clone(),
            updated_at: now,
        }
    }
}

pub struct NewInboxEntry {
    pub identity: PeerMessageIdentity,
    pub sequence: u64,
    pub sender_peer_id: Option<String>,
    pub envelope: PeerWireEnvelope,
    pub plaintext: Option<String>,
    pub decrypt_error: Option<String>,
    pub dispatch: String,
    pub delivery_ack: Option<PeerDeliveryAck>,
}

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn json_decode(bytes: &[u8]) -> Option<Value> {
    serde_json::from_slice(bytes).ok()
}

fn error_code(error: &EntryError) -> String {
    if error.code == "private_storage_capacity" {
        return "peer_client_backpressured".to_string();
    }
    let code = &error.code;
    if code.starts_with("peer_") {
        code.to_string()
    } else {
        "peer_client_transport".to_string()
    }
}

/* --------------------------------- client ----------------------------------- */

struct PendingRequest {
    matches: Box<dyn Fn(&Value) -> bool>,
    sender: tokio::sync::oneshot::Sender<std::result::Result<Value, EntryError>>,
}

struct ForwardRetry {
    kind: &'static str,
    identity: PeerMessageIdentity,
    peer_device_id: String,
    delay_ms: u64,
    wait_for_presence: bool,
    sending: bool,
    timer: Option<JoinHandle<()>>,
}

#[derive(Clone, Copy, PartialEq)]
enum DispatchAttemptResult {
    Settled,
    Deferred,
    NotAttempted,
}

pub struct PeerClientOptions {
    pub identity: PeerIdentity,
    pub crypto_store: Rc<RefCell<dyn PeerCryptoStore>>,
    pub client_store: Rc<dyn PeerClientStore>,
    pub transport: Rc<dyn PeerClientTransport>,
    pub route: PeerRouteIdentity,
    pub directory: Option<Rc<dyn PeerDeviceDirectory>>,
    pub dispatch: Option<PeerDispatchHandler>,
    pub wire_profile: Option<String>,
    pub page_size: Option<usize>,
    /// Sink for client events; the runtime forwards these to service APIs.
    pub events: mpsc::UnboundedSender<PeerClientEvent>,
}

/// Reliable-delivery peer client bound to one route identity.
pub struct PeerClient {
    pub outbox: PeerOutbox,
    pub inbox: PeerInbox,

    identity: PeerIdentity,
    crypto: Rc<RefCell<dyn PeerCryptoStore>>,
    store: Rc<dyn PeerClientStore>,
    transport: Rc<dyn PeerClientTransport>,
    route: PeerRouteIdentity,
    directory: Option<Rc<dyn PeerDeviceDirectory>>,
    wire_profile: String,
    page_size: usize,
    events: mpsc::UnboundedSender<PeerClientEvent>,

    pending_requests: RefCell<Vec<Rc<RefCell<Option<PendingRequest>>>>>,
    presence: RefCell<HashMap<String, PeerPresence>>,
    dispatching: RefCell<HashMap<String, Rc<RefCell<()>>>>,
    dispatch_retry: RefCell<Option<JoinHandle<()>>>,
    dispatch_retry_running: Cell<bool>,
    dispatch_retry_requested: Cell<bool>,
    dispatch_retry_waiting_for_active: Cell<bool>,
    dispatch_retry_delay_ms: Cell<u64>,
    dispatch_retry_after_sequence: Cell<u64>,
    dispatch_handler: RefCell<Option<PeerDispatchHandler>>,
    meta_cache: RefCell<Option<PeerClientMeta>>,
    store_lock: Mutex<()>,
    crypto_lock: Mutex<()>,
    crypto_queue_depth: Cell<usize>,
    forwarding: RefCell<std::collections::HashSet<String>>,
    acknowledging: RefCell<HashMap<String, Rc<Cell<bool>>>>,
    forward_retries: RefCell<HashMap<String, Rc<RefCell<ForwardRetry>>>>,
    bundle_fetches: RefCell<HashMap<String, Rc<tokio::sync::Mutex<Option<Result<(PairedSignalIdentity, PeerPreKeyBundle)>>>>>>,
    prepared_route: RefCell<Option<Result<()>>>,
    disposed: Cell<bool>,
}

impl PeerClient {
    pub fn new(options: PeerClientOptions) -> Result<Rc<Self>> {
        let route = PeerRouteIdentity {
            tenant_id: assert_opaque_id(&options.route.tenant_id, "route.tenantId")?,
            route_id: assert_opaque_id(&options.route.route_id, "route.routeId")?,
            device_id: assert_opaque_id(&options.route.device_id, "route.deviceId")?,
        };
        let page_size = options.page_size.unwrap_or(PEER_CLIENT_DEFAULT_PAGE_SIZE).clamp(1, 256);
        Ok(Rc::new(Self {
            outbox: PeerOutbox::new(options.client_store.clone(), &route),
            inbox: PeerInbox::new(options.client_store.clone(), &route),
            identity: options.identity,
            crypto: options.crypto_store,
            store: options.client_store,
            transport: options.transport,
            route,
            directory: options.directory,
            wire_profile: options.wire_profile.unwrap_or_else(|| PEER_CLIENT_DEFAULT_WIRE_PROFILE.to_string()),
            page_size,
            events: options.events,
            pending_requests: RefCell::new(Vec::new()),
            presence: RefCell::new(HashMap::new()),
            dispatching: RefCell::new(HashMap::new()),
            dispatch_retry: RefCell::new(None),
            dispatch_retry_running: Cell::new(false),
            dispatch_retry_requested: Cell::new(false),
            dispatch_retry_waiting_for_active: Cell::new(false),
            dispatch_retry_delay_ms: Cell::new(FORWARD_RETRY_INITIAL_DELAY_MS),
            dispatch_retry_after_sequence: Cell::new(0),
            dispatch_handler: RefCell::new(options.dispatch),
            meta_cache: RefCell::new(None),
            store_lock: Mutex::new(()),
            crypto_lock: Mutex::new(()),
            crypto_queue_depth: Cell::new(0),
            forwarding: RefCell::new(std::collections::HashSet::new()),
            acknowledging: RefCell::new(HashMap::new()),
            forward_retries: RefCell::new(HashMap::new()),
            bundle_fetches: RefCell::new(HashMap::new()),
            prepared_route: RefCell::new(None),
            disposed: Cell::new(false),
        }))
    }

    fn emit(&self, event: PeerClientEvent) {
        let _ = self.events.send(event);
    }

    fn emit_error(&self, error: &EntryError) {
        self.emit(PeerClientEvent::Error {
            code: error_code(error),
            detail: error.to_string(),
        });
    }

    fn emit_send(&self, entry: &StoredOutboxEntry) {
        self.emit(PeerClientEvent::SendState {
            message_id: entry.identity.message_id.clone(),
            peer_device_id: entry.identity.recipient_device_id.clone(),
            state: entry.state.clone(),
            last_forwarded: entry.last_forwarded.clone(),
        });
        if entry.state == "conflict" {
            self.emit(PeerClientEvent::Conflict {
                message_id: entry.identity.message_id.clone(),
                peer_device_id: entry.identity.recipient_device_id.clone(),
            });
        }
    }

    /// Latest relay reachability for one paired device on this exact route.
    pub fn presence(&self, peer_device_id: &str) -> Option<PeerPresence> {
        self.presence.borrow().get(peer_device_id).cloned()
    }

    /// Bind the route's local stores and recover prepared state without
    /// network or application dispatch.
    pub async fn prepare_local_state(&self) -> Result<()> {
        let _guard = self.crypto_lock.lock().await;
        if self.disposed.get() {
            return Err(client_error("The Peer client was disposed."));
        }
        self.prepare_route().await?;
        self.recover_prepared_operation().await
    }

    async fn prepare_route(&self) -> Result<()> {
        if let Some(state) = self.prepared_route.borrow().clone() {
            return state;
        }
        let result = self.store.prepare_route(&PeerClientRouteIdentity {
            tenant_id: self.route.tenant_id.clone(),
            route_id: self.route.route_id.clone(),
            device_id: self.route.device_id.clone(),
        });
        *self.prepared_route.borrow_mut() = Some(result.clone());
        result
    }

    /// Serialized crypto-lane work: route prep + WAL recovery precede it.
    /// `crypto_queue_depth` bounds queued receives like the TS client window.
    async fn with_crypto<T>(&self, operation: impl AsyncFnOnce() -> Result<T>) -> Result<T> {
        if self.disposed.get() {
            return Err(client_error("The Peer client was disposed."));
        }
        self.crypto_queue_depth.set(self.crypto_queue_depth.get() + 1);
        let result = async {
            let _guard = self.crypto_lock.lock().await;
            self.prepare_route().await?;
            self.recover_prepared_operation().await?;
            operation().await
        }
        .await;
        self.crypto_queue_depth.set(self.crypto_queue_depth.get() - 1);
        result
    }

    async fn with_store<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        if self.disposed.get() {
            return Err(client_error("The Peer client was disposed."));
        }
        let _guard = self.store_lock.lock().await;
        operation()
    }

    /// Recover a prepared WAL operation: apply staged mutations, commit the
    /// durable application record, then finalize — exactly the TS order.
    async fn recover_prepared_operation(&self) -> Result<()> {
        let Some(prepared) = self.crypto.borrow().load_prepared_operation()? else {
            return Ok(());
        };
        let application = self.decode_prepared_record(&prepared)?;
        self.crypto.borrow().apply_prepared_operation()?;
        match application {
            DecodedPreparedRecord::Send(entry) => self.outbox.save_entry(&entry)?,
            DecodedPreparedRecord::Receive(entry) => self.inbox.save_entry(&entry)?,
        }
        self.crypto
            .borrow()
            .finalize_prepared_operation(&prepared.message_id, &prepared.kind)
    }

    fn decode_prepared_record(&self, prepared: &PeerCryptoPreparedOperation) -> Result<DecodedPreparedRecord> {
        let bytes = b64u_decode(&prepared.application_record, 4 * 1024 * 1024)
            .map_err(|_| store_error("A prepared Peer operation record is malformed."))?;
        let value = json_decode(&bytes).filter(|v| v.is_object()).ok_or_else(|| {
            store_error("A prepared Peer operation record is malformed.")
        })?;
        if value.get("version").and_then(Value::as_u64) != Some(PEER_CLIENT_STORE_RECORD_VERSION)
            || value.get("messageId").and_then(Value::as_str) != Some(prepared.message_id.as_str())
        {
            return Err(store_error("A prepared Peer operation does not match its message id."));
        }
        if prepared.kind == "send" {
            let entry: StoredOutboxEntry = serde_json::from_value(value.clone())
                .map_err(|_| store_error("A prepared Peer send is malformed."))?;
            if entry.state != "pending" || entry.identity.recipient_device_id.is_empty() {
                return Err(store_error("A prepared Peer send is malformed."));
            }
            return Ok(DecodedPreparedRecord::Send(entry));
        }
        let entry: StoredInboxEntry = serde_json::from_value(value.clone())
            .map_err(|_| store_error("A prepared Peer receive is malformed."))?;
        if entry.dispatch != "pending"
            || entry.identity.recipient_device_id.is_empty()
            || entry.identity.sender_device_id.is_empty()
            || entry.plaintext.is_none()
        {
            return Err(store_error("A prepared Peer receive is malformed."));
        }
        Ok(DecodedPreparedRecord::Receive(entry))
    }

    async fn meta(&self) -> Result<PeerClientMeta> {
        if let Some(meta) = self.meta_cache.borrow().as_ref() {
            return Ok(meta.clone());
        }
        let meta = self.store.load_meta()?.unwrap_or_else(empty_peer_client_meta);
        *self.meta_cache.borrow_mut() = Some(meta.clone());
        Ok(meta)
    }

    async fn save_meta_patch(&self, patch: impl FnOnce(&mut PeerClientMeta)) -> Result<PeerClientMeta> {
        let mut meta = self.meta().await?;
        patch(&mut meta);
        meta.version = PEER_CLIENT_STORE_RECORD_VERSION;
        self.store.save_meta(&meta)?;
        *self.meta_cache.borrow_mut() = Some(meta.clone());
        Ok(meta)
    }

    /// Control request: queue a matcher, send, await the first matching reply.
    async fn request(
        &self,
        message: Value,
        matches: impl Fn(&Value) -> bool + 'static,
    ) -> Result<Value> {
        if self.disposed.get() {
            return Err(client_error("The Peer client was disposed."));
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        let pending = Rc::new(RefCell::new(Some(PendingRequest {
            matches: Box::new(matches),
            sender: tx,
        })));
        self.pending_requests.borrow_mut().push(pending.clone());
        if self.transport.send(message).await.is_err() {
            self.remove_pending(&pending, Err(transport_error(
                "The session channel could not carry a Peer control request.",
            )));
            return Err(transport_error("The session channel could not carry a Peer control request."));
        }
        rx.await.map_err(|_| client_error("The Peer client was disposed."))?
    }

    fn remove_pending(&self, pending: &Rc<RefCell<Option<PendingRequest>>>, result: Result<Value>) {
        if let Some(request) = pending.borrow_mut().take() {
            self.pending_requests.borrow_mut().retain(|p| !Rc::ptr_eq(p, pending));
            let _ = request.sender.send(result.map_err(|e| e));
        }
    }

    /// Demultiplex control pushes before any queued decrypt or dispatch work.
    /// Called by the runtime for every inbound peer-schema wire object.
    pub fn handle_inbound_message(self: &Rc<Self>, value: &Value) {
        if self.disposed.get() {
            return;
        }
        let Some(message) = parse_private_relay_peer_message(value) else {
            return;
        };
        match message.get("kind").and_then(Value::as_str).unwrap_or("") {
            "peer-presence" => {
                let Some(presence) = parse_peer_presence(&message) else { return };
                if presence.tenant_id != self.route.tenant_id
                    || presence.route_id != self.route.route_id
                    || presence.device_id != self.route.device_id
                {
                    return;
                }
                let prior = self.presence.borrow().get(&presence.peer_device_id).cloned();
                self.presence.borrow_mut().insert(presence.peer_device_id.clone(), presence.clone());
                self.emit(PeerClientEvent::PeerPresence(presence.clone()));
                if presence.state == "reachable"
                    && (prior.as_ref().map(|p| p.state.as_str()) != Some("reachable")
                        || prior.as_ref().and_then(|p| p.session_id.clone()) != presence.session_id)
                {
                    let this = Rc::clone(self);
                    let peer = presence.peer_device_id.clone();
                    tokio::task::spawn_local(async move {
                        if let Err(e) = this.wake_peer(&peer).await {
                            this.emit_error(&e);
                        }
                    });
                }
            }
            "peer-delivery-ack" => {
                let Some(ack) = parse_peer_delivery_ack(&message) else { return };
                let this = Rc::clone(self);
                tokio::task::spawn_local(async move {
                    if let Err(e) = this.apply_delivery_ack(&ack).await {
                        this.emit_error(&e);
                    }
                });
            }
            "peer-forwarded" => {
                let Some(forwarded) = parse_peer_forwarded(&message) else { return };
                let this = Rc::clone(self);
                tokio::task::spawn_local(async move {
                    if let Err(e) = this.apply_forwarded(&forwarded).await {
                        this.emit_error(&e);
                    }
                });
            }
            "peer-send" => {
                let Some(send) = parse_peer_send(&message) else { return };
                self.admit_receive(send);
            }
            _ => {
                let waiting = self
                    .pending_requests
                    .borrow()
                    .iter()
                    .find(|p| {
                        p.borrow()
                            .as_ref()
                            .map(|r| (r.matches)(&message))
                            .unwrap_or(false)
                    })
                    .cloned();
                if let Some(pending) = waiting {
                    self.remove_pending(&pending, Ok(message));
                }
            }
        }
    }

    /// Called only when the current admitted transport is lost. Durable work
    /// and active dispatch stay owned; pending control replies are rejected.
    pub fn transport_lost(&self) {
        self.presence.borrow_mut().clear();
        for retry in self.forward_retries.borrow_mut().values_mut() {
            let mut retry = retry.borrow_mut();
            if let Some(timer) = retry.timer.take() {
                timer.abort();
            }
            retry.wait_for_presence = true;
        }
        let pendings: Vec<_> = self.pending_requests.borrow().iter().cloned().collect();
        for pending in pendings {
            self.remove_pending(&pending, Err(transport_error(
                "The admitted transport was lost before its Peer control response.",
            )));
        }
    }

    /// Stop local retry timers; durable outbox/inbox responsibility stays in
    /// the store for a future instance.
    pub async fn dispose(&self) {
        self.disposed.set(true);
        for retry in self.forward_retries.borrow_mut().values_mut() {
            if let Some(timer) = retry.borrow_mut().timer.take() {
                timer.abort();
            }
        }
        self.clear_dispatch_retry();
        self.forward_retries.borrow_mut().clear();
        *self.dispatch_handler.borrow_mut() = None;
        let pendings: Vec<_> = self.pending_requests.borrow().iter().cloned().collect();
        for pending in pendings {
            self.remove_pending(&pending, Err(client_error(
                "The Peer client was disposed while a control request was pending.",
            )));
        }
        let _ = self.store_lock.lock().await;
        let _ = self.crypto_lock.lock().await;
    }

    fn clear_dispatch_retry(&self) {
        if let Some(timer) = self.dispatch_retry.borrow_mut().take() {
            timer.abort();
        }
        self.dispatch_retry_requested.set(false);
        self.dispatch_retry_waiting_for_active.set(false);
        self.dispatch_retry_delay_ms.set(FORWARD_RETRY_INITIAL_DELAY_MS);
        self.dispatch_retry_after_sequence.set(0);
    }

    fn schedule_dispatch_retry(self: &Rc<Self>) {
        if self.disposed.get() || self.dispatch_handler.borrow().is_none() {
            return;
        }
        if self.dispatch_retry_running.get() {
            self.dispatch_retry_requested.set(true);
            return;
        }
        if self.dispatch_retry.borrow().is_some() {
            return;
        }
        let delay = self.dispatch_retry_delay_ms.get();
        self.dispatch_retry_delay_ms
            .set((delay * 2).min(FORWARD_RETRY_MAX_DELAY_MS));
        let this = Rc::clone(self);
        let timer = tokio::task::spawn_local(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            this.dispatch_retry.borrow_mut().take();
            if this.disposed.get() || this.dispatch_handler.borrow().is_none() {
                this.clear_dispatch_retry();
                return;
            }
            if this.dispatch_retry_running.get() {
                this.dispatch_retry_requested.set(true);
                return;
            }
            this.dispatch_retry_running.set(true);
            this.dispatch_retry_requested.set(false);
            let after = this.dispatch_retry_after_sequence.get();
            let result = this.retry_pending_dispatch_pages(after).await;
            this.dispatch_retry_running.set(false);
            if let Err(e) = result {
                this.emit_error(&e);
                this.dispatch_retry_after_sequence.set(0);
                this.dispatch_retry_requested.set(true);
            }
            if this.disposed.get() || this.dispatch_handler.borrow().is_none() {
                this.dispatch_retry_requested.set(false);
                return;
            }
            if this.dispatch_retry_requested.replace(false) {
                this.schedule_dispatch_retry();
                return;
            }
            this.dispatch_retry_delay_ms.set(FORWARD_RETRY_INITIAL_DELAY_MS);
            this.dispatch_retry_after_sequence.set(0);
        });
        *self.dispatch_retry.borrow_mut() = Some(timer);
    }

    async fn retry_pending_dispatch_pages(self: &Rc<Self>, after_sequence: u64) -> Result<()> {
        let mut cursor = after_sequence;
        loop {
            if self.disposed.get() || self.dispatch_handler.borrow().is_none() {
                return Ok(());
            }
            let page = self.inbox.pending_dispatch_page(cursor, self.page_size)?;
            for entry in page.items {
                if self.disposed.get() || self.dispatch_handler.borrow().is_none() {
                    return Ok(());
                }
                let key = tuple_key(&entry.identity);
                if self.dispatching.borrow().contains_key(&key) {
                    continue;
                }
                let this = Rc::clone(self);
                tokio::task::spawn_local(async move {
                    if let Err(e) = this.dispatch_entry(entry).await {
                        this.emit_error(&e);
                    }
                });
                if self.dispatch_retry_waiting_for_active.get() {
                    self.dispatch_retry_after_sequence.set(0);
                    return Ok(());
                }
            }
            match page.next_after_sequence {
                None => {
                    self.dispatch_retry_after_sequence.set(0);
                    return Ok(());
                }
                Some(next) => {
                    cursor = next;
                    self.dispatch_retry_after_sequence.set(next);
                }
            }
        }
    }

    fn admit_receive(self: &Rc<Self>, send: PeerSend) {
        if send.tenant_id != self.route.tenant_id
            || send.route_id != self.route.route_id
            || send.recipient_device_id != self.route.device_id
            || send.sender_device_id == self.route.device_id
        {
            return;
        }
        if self.crypto_queue_depth.get() >= CLIENT_RECEIVE_WINDOW {
            self.emit(PeerClientEvent::Error {
                code: "peer_client_backpressured".to_string(),
                detail: "The bounded local receive window is full; sender retains its ciphertext.".to_string(),
            });
            return;
        }
        let this = Rc::clone(self);
        tokio::task::spawn_local(async move {
            let received = {
                let inner = Rc::clone(&this);
                let send_wire = send.clone();
                this.with_crypto(async move || inner.receive_send(&send_wire).await).await
            };
            match received {
                Ok(Some(entry)) => this.replay_inbox_entry(entry, &send).await,
                Ok(None) => {}
                Err(e) => this.emit_error(&e),
            }
        });
    }

    /* ------------------------------- receive -------------------------------- */

    async fn receive_send(&self, send: &PeerSend) -> Result<Option<StoredInboxEntry>> {
        let identity = PeerMessageIdentity {
            tenant_id: send.tenant_id.clone(),
            route_id: send.route_id.clone(),
            sender_device_id: send.sender_device_id.clone(),
            recipient_device_id: send.recipient_device_id.clone(),
            message_id: send.message_id.clone(),
        };
        match self.inbox.lookup(&identity, &send.envelope)? {
            PeerInboxLookup::Conflict(_) => {
                self.emit(PeerClientEvent::Error {
                    code: "peer_client_conflict".to_string(),
                    detail: "A message tuple was replayed with different ciphertext.".to_string(),
                });
                return Ok(None);
            }
            PeerInboxLookup::Duplicate(entry) => return Ok(Some(entry)),
            PeerInboxLookup::New => {}
        }

        let Ok(ciphertext) = b64u_decode(&send.envelope.ciphertext, wire::MAX_ENVELOPE_BYTES * 4 / 3 + 4) else {
            return Ok(None);
        };
        let raw_envelope = json_decode(&ciphertext);
        let parsed_envelope = PeerEnvelope::parse_bytes(&ciphertext).ok();
        let (Some(_raw), Some(parsed)) = (raw_envelope, parsed_envelope) else {
            return Ok(None);
        };

        let (descriptor, identity_key) = self.paired_signal_identity(&send.sender_device_id).await?;
        if descriptor.peer_id != parsed.sender_peer_id || parsed.sender_device_id != descriptor.signal_device_id {
            self.emit(PeerClientEvent::RequiresRePair {
                peer_id: descriptor.peer_id.clone(),
                source: "inbound".to_string(),
                detail: "The encrypted sender does not match the pinned pairing identity.".to_string(),
            });
            return Err(crypto_error("peer_identity_changed", "The encrypted sender does not match the pinned pairing identity."));
        }
        let meta = self.meta().await?;
        if let Some(bound) = meta.peers.get(&send.sender_device_id) {
            if *bound != descriptor.peer_id {
                self.emit(PeerClientEvent::RequiresRePair {
                    peer_id: descriptor.peer_id.clone(),
                    source: "inbound".to_string(),
                    detail: "The route device now resolves to a different pinned crypto peer.".to_string(),
                });
                return Err(crypto_error("peer_identity_changed", "The route device now resolves to a different pinned crypto peer."));
            }
        }

        pin_peer_identity(
            &*self.crypto.borrow(),
            &descriptor.peer_id,
            descriptor.signal_device_id,
            &identity_key,
        )?;
        let overlay = create_peer_crypto_transaction_overlay(self.crypto.clone());
        let plaintext: Vec<u8> = {
            let decrypt = async {
                if parsed.message_type == PeerEnvelopeMessageType::PreKey {
                    let (_, plaintext) = PeerSession::accept(
                        self.identity.clone(),
                        overlay.store.clone(),
                        &parsed,
                    )
                    .await?;
                    Ok(plaintext)
                } else {
                    let mut session = PeerSession::resume(
                        self.identity.clone(),
                        overlay.store.clone(),
                        &parsed.sender_peer_id,
                        parsed.sender_device_id,
                    )
                    .await?;
                    // Decrypt a signal-type envelope via the resumed session.
                    session.decrypt_envelope(&parsed).await
                }
            };
            match decrypt.await {
                Ok(p) => p,
                Err(error) => {
                    // A Signal duplicate under a new transport tuple is not
                    // durable evidence; record it without a receipt.
                    if error.code == "peer_duplicate_message" {
                        let sequence = self.store.allocate_inbox_sequence(&PeerClientRouteScope {
                            tenant_id: self.route.tenant_id.clone(),
                            route_id: self.route.route_id.clone(),
                        })?;
                        let skipped = self.inbox.create_entry(NewInboxEntry {
                            identity: identity.clone(),
                            sequence,
                            sender_peer_id: Some(descriptor.peer_id.clone()),
                            envelope: send.envelope.clone(),
                            plaintext: None,
                            decrypt_error: Some(error.code.to_string()),
                            dispatch: "skipped".to_string(),
                            delivery_ack: None,
                        });
                        self.inbox.record(&skipped)?;
                    }
                    return Err(error);
                }
            }
        };

        let sequence = self.store.allocate_inbox_sequence(&PeerClientRouteScope {
            tenant_id: self.route.tenant_id.clone(),
            route_id: self.route.route_id.clone(),
        })?;
        let entry = self.inbox.create_entry(NewInboxEntry {
            identity: identity.clone(),
            sequence,
            sender_peer_id: Some(descriptor.peer_id.clone()),
            envelope: send.envelope.clone(),
            plaintext: Some(b64u_encode(&plaintext)),
            decrypt_error: None,
            dispatch: "pending".to_string(),
            delivery_ack: None,
        });
        let prepared = PeerCryptoPreparedOperation {
            version: 1,
            kind: "receive".to_string(),
            message_id: send.message_id.clone(),
            mutations: mutations_to_json(&overlay.mutations()),
            application_record: b64u_encode(
                &serde_json::to_vec(&entry).map_err(|_| store_error("The inbox record could not be encoded."))?,
            ),
            prepared_at: iso_now(),
        };
        let record_bytes = serde_json::to_vec(&entry).map_err(|_| store_error("The inbox record could not be encoded."))?.len();
        self.store.assert_available_capacity(record_bytes + 4_096)?;
        self.crypto.borrow().prepare_operation(&prepared)?;
        self.recover_prepared_operation().await?;
        self.inbox.entry(&identity)
    }

    async fn replay_inbox_entry(self: &Rc<Self>, entry: StoredInboxEntry, send: &PeerSend) {
        if entry.delivery_ack.is_some() || entry.plaintext.is_some() {
            if let Err(e) = self.create_and_forward_ack(&entry, send).await {
                self.emit_error(&e);
            }
        }
        if entry.dispatch == "pending" {
            let _ = self.dispatch_entry(entry).await;
        }
    }

    async fn create_and_forward_ack(self: &Rc<Self>, entry: &StoredInboxEntry, send: &PeerSend) -> Result<()> {
        let key = tuple_key(&entry.identity);
        if let Some(active) = self.acknowledging.borrow().get(&key) {
            active.set(true);
            return Ok(());
        }
        let state = Rc::new(Cell::new(false));
        self.acknowledging.borrow_mut().insert(key.clone(), state.clone());
        let result: Result<()> = async {
            let mut attempts = 0;
            loop {
                state.set(false);
                self.forward_stored_ack(entry, send).await?;
                attempts += 1;
                if !(state.get() && attempts < 2) {
                    break;
                }
            }
            if state.get() {
                self.schedule_forward_retry(PEER_KIND_DELIVERY_ACK, entry.identity.clone(), entry.identity.sender_device_id.clone());
            }
            Ok(())
        }
        .await;
        self.acknowledging.borrow_mut().remove(&key);
        result
    }

    async fn forward_stored_ack(self: &Rc<Self>, entry: &StoredInboxEntry, send: &PeerSend) -> Result<()> {
        let result: Result<()> = async {
            let Some(current) = self.inbox.entry(&entry.identity)? else {
                return Ok(());
            };
            if let Some(ack) = current.delivery_ack.clone() {
                let key = self.forward_retry_key(PEER_KIND_DELIVERY_ACK, &current.identity);
                {
                    let retries = self.forward_retries.borrow();
                    if let Some(retry) = retries.get(&key) {
                        let r = retry.borrow();
                        if r.timer.is_some() || r.sending {
                            return Ok(());
                        }
                    }
                }
                if let Some(retry) = self.forward_retries.borrow().get(&key).cloned() {
                    retry.borrow_mut().wait_for_presence = false;
                    return self.retry_forward(&retry).await;
                }
                return self.send_ack(&ack).await;
            }
            if current.plaintext.is_none() {
                return Ok(());
            }
            let Some(signing_input) = peer_delivery_ack_signing_input_for_send(send) else {
                return Err(client_error("The committed send cannot produce a signed delivery receipt."));
            };
            let signature = b64u_encode(&sign_peer_identity_message(
                &self.identity,
                peer_delivery_ack_transcript(&signing_input).as_bytes(),
            )?);
            let ack = PeerDeliveryAck {
                tenant_id: signing_input.tenant_id,
                route_id: signing_input.route_id,
                sender_device_id: signing_input.sender_device_id,
                recipient_device_id: signing_input.recipient_device_id,
                message_id: signing_input.message_id,
                ciphertext_digest: signing_input.ciphertext_digest,
                signature,
            };
            let saved = self.with_store(|| self.inbox.mark_delivery_ack(&current.identity, &ack)).await?;
            if let Some(ack) = saved.and_then(|s| s.delivery_ack) {
                self.send_ack(&ack).await?;
            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            self.emit_error(&e);
        }
        Ok(())
    }

    async fn send_ack(self: &Rc<Self>, ack: &PeerDeliveryAck) -> Result<()> {
        let wire = create_peer_delivery_ack(ack);
        if let Err(error) = self.transport.send(wire).await {
            self.schedule_forward_retry(
                PEER_KIND_DELIVERY_ACK,
                PeerMessageIdentity {
                    tenant_id: ack.tenant_id.clone(),
                    route_id: ack.route_id.clone(),
                    sender_device_id: ack.sender_device_id.clone(),
                    recipient_device_id: ack.recipient_device_id.clone(),
                    message_id: ack.message_id.clone(),
                },
                ack.sender_device_id.clone(),
            );
            return Err(error);
        }
        Ok(())
    }

    async fn apply_delivery_ack(self: &Rc<Self>, ack: &PeerDeliveryAck) -> Result<()> {
        if ack.tenant_id != self.route.tenant_id
            || ack.route_id != self.route.route_id
            || ack.sender_device_id != self.route.device_id
            || ack.recipient_device_id == self.route.device_id
        {
            return Ok(());
        }
        let identity = PeerMessageIdentity {
            tenant_id: ack.tenant_id.clone(),
            route_id: ack.route_id.clone(),
            sender_device_id: ack.sender_device_id.clone(),
            recipient_device_id: ack.recipient_device_id.clone(),
            message_id: ack.message_id.clone(),
        };
        let Some(entry) = self.with_store(|| self.outbox.entry_for_identity(&identity)).await? else {
            return Ok(());
        };
        if entry.state == "conflict" {
            return Ok(());
        }
        let send = PeerSend {
            tenant_id: entry.identity.tenant_id.clone(),
            route_id: entry.identity.route_id.clone(),
            sender_device_id: entry.identity.sender_device_id.clone(),
            recipient_device_id: entry.identity.recipient_device_id.clone(),
            message_id: entry.identity.message_id.clone(),
            envelope: entry.envelope.clone(),
        };
        if !peer_delivery_ack_matches_send(ack, &send) {
            self.emit(PeerClientEvent::Error {
                code: "peer_client_invalid_delivery_ack".to_string(),
                detail: "A receipt did not match the exact pending ciphertext.".to_string(),
            });
            return Ok(());
        }
        let (descriptor, _) = self.paired_signal_identity(&ack.recipient_device_id).await?;
        let binding = self.crypto.borrow().load_peer_binding(&descriptor.peer_id)?;
        let pinned_identity_key = binding
            .as_ref()
            .filter(|b| b.state == "active")
            .and_then(|b| b64u_decode(&b.identity_key, 512).ok());
        let paired_identity_key = b64u_decode(&descriptor.identity_key, 512).ok();
        let signature_bytes = b64u_decode(&ack.signature, 128).ok()
            .filter(|sig| sig.len() == 64);
        let valid = match (&binding, &pinned_identity_key, &paired_identity_key, &signature_bytes) {
            (Some(binding), Some(pinned), Some(paired), Some(sig))
                if binding.state == "active" && pinned == paired =>
            {
                verify_peer_identity_message(
                    pinned,
                    peer_delivery_ack_transcript(&super::wire::PeerDeliveryAckSigningInput {
                        tenant_id: ack.tenant_id.clone(),
                        route_id: ack.route_id.clone(),
                        sender_device_id: ack.sender_device_id.clone(),
                        recipient_device_id: ack.recipient_device_id.clone(),
                        message_id: ack.message_id.clone(),
                        ciphertext_digest: ack.ciphertext_digest.clone(),
                    })
                    .as_bytes(),
                    sig,
                )
            }
            _ => false,
        };
        if !valid {
            self.emit(PeerClientEvent::Error {
                code: "peer_client_invalid_delivery_ack".to_string(),
                detail: "A receipt signature did not match the active pairing-pinned Signal identity.".to_string(),
            });
            return Ok(());
        }
        if let Some(next) = self.with_store(|| self.outbox.apply_delivery_ack(&identity, ack)).await? {
            self.clear_forward_retry(PEER_KIND_SEND, &identity);
            self.emit_send(&next);
            let this = Rc::clone(self);
            tokio::task::spawn_local(async move {
                if let Err(e) = this.drive_pending(None, false).await {
                    this.emit_error(&e);
                }
            });
        }
        Ok(())
    }

    async fn apply_forwarded(self: &Rc<Self>, forwarded: &PeerForwarded) -> Result<()> {
        if forwarded.tenant_id != self.route.tenant_id
            || forwarded.route_id != self.route.route_id
            || forwarded.source_device_id != self.route.device_id
            || forwarded.target_device_id == self.route.device_id
        {
            return Ok(());
        }
        if forwarded.request_kind == PEER_KIND_SEND {
            let identity = self.outbox.identity(&forwarded.message_id, &forwarded.target_device_id)?;
            let entry = self.with_store(|| self.outbox.note_forwarded(&identity, forwarded)).await?;
            if let Some(entry) = &entry {
                self.emit_send(entry);
            }
            match &entry {
                None => {
                    self.clear_forward_retry(PEER_KIND_SEND, &identity);
                    return Ok(());
                }
                Some(e) if e.state != "pending" => {
                    self.clear_forward_retry(PEER_KIND_SEND, &identity);
                    return Ok(());
                }
                _ => {}
            }
            if forwarded.outcome == "endpoint_unreachable" {
                self.wait_for_peer_presence(PEER_KIND_SEND, &identity, &forwarded.target_device_id);
                return Ok(());
            }
            if forwarded.outcome == "forwarded" || Self::is_retryable_forward(forwarded) {
                self.schedule_forward_retry(PEER_KIND_SEND, identity, forwarded.target_device_id.clone());
            } else {
                self.clear_forward_retry(PEER_KIND_SEND, &identity);
            }
            return Ok(());
        }

        // ACK result: wire source is the recipient, target the original sender.
        let identity = PeerMessageIdentity {
            tenant_id: forwarded.tenant_id.clone(),
            route_id: forwarded.route_id.clone(),
            sender_device_id: forwarded.target_device_id.clone(),
            recipient_device_id: forwarded.source_device_id.clone(),
            message_id: forwarded.message_id.clone(),
        };
        let entry = self.with_store(|| self.inbox.entry(&identity)).await?;
        match &entry {
            None => {
                self.clear_forward_retry(PEER_KIND_DELIVERY_ACK, &identity);
                return Ok(());
            }
            Some(e) if e.delivery_ack.is_none() => {
                self.clear_forward_retry(PEER_KIND_DELIVERY_ACK, &identity);
                return Ok(());
            }
            _ => {}
        }
        match forwarded.outcome.as_str() {
            "forwarded" => self.clear_forward_retry(PEER_KIND_DELIVERY_ACK, &identity),
            "endpoint_unreachable" => {
                self.wait_for_peer_presence(PEER_KIND_DELIVERY_ACK, &identity, &forwarded.target_device_id)
            }
            _ if Self::is_retryable_forward(forwarded) => {
                self.schedule_forward_retry(PEER_KIND_DELIVERY_ACK, identity, forwarded.target_device_id.clone())
            }
            _ => self.clear_forward_retry(PEER_KIND_DELIVERY_ACK, &identity),
        }
        Ok(())
    }

    fn is_retryable_forward(forwarded: &PeerForwarded) -> bool {
        forwarded.outcome == "backpressured"
            || (forwarded.outcome == "refused"
                && matches!(forwarded.refusal.as_deref(), Some("authority_stale") | Some("rate_limited")))
    }

    fn forward_retry_key(&self, kind: &str, identity: &PeerMessageIdentity) -> String {
        json!([kind, identity.tenant_id, identity.route_id, identity.sender_device_id,
               identity.recipient_device_id, identity.message_id])
        .to_string()
    }

    fn clear_forward_retry(&self, kind: &str, identity: &PeerMessageIdentity) {
        let key = self.forward_retry_key(kind, identity);
        if let Some(retry) = self.forward_retries.borrow_mut().remove(&key) {
            if let Some(timer) = retry.borrow_mut().timer.take() {
                timer.abort();
            }
        }
    }

    fn retry_for(&self, kind: &'static str, identity: &PeerMessageIdentity, peer_device_id: &str) -> Rc<RefCell<ForwardRetry>> {
        let key = self.forward_retry_key(kind, identity);
        if let Some(retry) = self.forward_retries.borrow().get(&key) {
            return retry.clone();
        }
        let retry = Rc::new(RefCell::new(ForwardRetry {
            kind,
            identity: identity.clone(),
            peer_device_id: peer_device_id.to_string(),
            delay_ms: FORWARD_RETRY_INITIAL_DELAY_MS,
            wait_for_presence: false,
            sending: false,
            timer: None,
        }));
        self.forward_retries.borrow_mut().insert(key, retry.clone());
        retry
    }

    fn schedule_forward_retry(self: &Rc<Self>, kind: &'static str, identity: PeerMessageIdentity, peer_device_id: String) {
        if self.disposed.get() {
            return;
        }
        let retry = self.retry_for(kind, &identity, &peer_device_id);
        retry.borrow_mut().wait_for_presence = false;
        if retry.borrow().timer.is_some() {
            return;
        }
        if self.presence(&peer_device_id).map(|p| p.state != "reachable").unwrap_or(true) {
            retry.borrow_mut().wait_for_presence = true;
            return;
        }
        let key = self.forward_retry_key(kind, &identity);
        let delay = retry.borrow().delay_ms;
        let this = Rc::clone(self);
        let retry_clone = retry.clone();
        let timer = tokio::task::spawn_local(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            {
                let mut r = retry_clone.borrow_mut();
                r.timer = None;
            }
            if this.forward_retries.borrow().get(&key).map(|r| Rc::ptr_eq(r, &retry_clone)) != Some(true) {
                return;
            }
            if this.disposed.get() {
                this.clear_forward_retry(kind, &retry_clone.borrow().identity.clone());
                return;
            }
            if this.presence(&retry_clone.borrow().peer_device_id).map(|p| p.state != "reachable").unwrap_or(true) {
                retry_clone.borrow_mut().wait_for_presence = true;
                return;
            }
            {
                let mut r = retry_clone.borrow_mut();
                r.delay_ms = (r.delay_ms * 2).min(FORWARD_RETRY_MAX_DELAY_MS);
            }
            if let Err(e) = this.retry_forward(&retry_clone).await {
                this.emit_error(&e);
                let still = this.forward_retries.borrow().get(&key).map(|r| Rc::ptr_eq(r, &retry_clone)) == Some(true)
                    && retry_clone.borrow().timer.is_none();
                if still {
                    let identity = retry_clone.borrow().identity.clone();
                    let peer = retry_clone.borrow().peer_device_id.clone();
                    this.schedule_forward_retry(kind, identity, peer);
                }
            }
        });
        retry.borrow_mut().timer = Some(timer);
    }

    fn wait_for_peer_presence(&self, kind: &'static str, identity: &PeerMessageIdentity, peer_device_id: &str) {
        if self.disposed.get() {
            return;
        }
        let retry = self.retry_for(kind, identity, peer_device_id);
        let mut r = retry.borrow_mut();
        if let Some(timer) = r.timer.take() {
            timer.abort();
        }
        r.wait_for_presence = true;
    }

    async fn retry_forward(self: &Rc<Self>, retry: &Rc<RefCell<ForwardRetry>>) -> Result<()> {
        let (kind, identity, peer_device_id) = {
            let r = retry.borrow();
            (r.kind, r.identity.clone(), r.peer_device_id.clone())
        };
        let key = self.forward_retry_key(kind, &identity);
        if self.forward_retries.borrow().get(&key).map(|r| Rc::ptr_eq(r, retry)) != Some(true)
            || retry.borrow().sending
        {
            return Ok(());
        }
        if self.presence(&peer_device_id).map(|p| p.state != "reachable").unwrap_or(true) {
            retry.borrow_mut().wait_for_presence = true;
            return Ok(());
        }
        retry.borrow_mut().wait_for_presence = false;
        retry.borrow_mut().sending = true;
        let result: Result<()> = async {
            if kind == PEER_KIND_SEND {
                let entry = self.with_store(|| self.outbox.entry_for_identity(&identity)).await?;
                let Some(entry) = entry else {
                    self.clear_forward_retry(kind, &identity);
                    return Ok(());
                };
                if entry.state != "pending" {
                    self.clear_forward_retry(kind, &identity);
                    return Ok(());
                }
                if self.forward_retries.borrow().get(&key).map(|r| Rc::ptr_eq(r, retry)) != Some(true) {
                    return Ok(());
                }
                return self.forward_entry(&entry).await;
            }
            let entry = self.with_store(|| self.inbox.entry(&identity)).await?;
            let Some(ack) = entry.and_then(|e| e.delivery_ack) else {
                self.clear_forward_retry(kind, &identity);
                return Ok(());
            };
            if self.disposed.get()
                || self.forward_retries.borrow().get(&key).map(|r| Rc::ptr_eq(r, retry)) != Some(true)
            {
                return Ok(());
            }
            self.send_ack(&ack).await
        }
        .await;
        retry.borrow_mut().sending = false;
        result
    }

    async fn retry_tracked_for_peer(self: &Rc<Self>, peer_device_id: &str) -> Result<()> {
        let retries: Vec<Rc<RefCell<ForwardRetry>>> = self
            .forward_retries
            .borrow()
            .values()
            .filter(|r| r.borrow().peer_device_id == peer_device_id && r.borrow().wait_for_presence)
            .cloned()
            .collect();
        for retry in retries {
            {
                let mut r = retry.borrow_mut();
                r.wait_for_presence = false;
                if let Some(timer) = r.timer.take() {
                    timer.abort();
                }
            }
            self.retry_forward(&retry).await?;
        }
        Ok(())
    }

    /* ------------------------------ identity -------------------------------- */

    /// Authenticated paired Signal identity for a route device — pairing
    /// data only, never relay metadata.
    async fn paired_signal_identity(
        &self,
        peer_device_id: &str,
    ) -> Result<(PairedSignalIdentity, Vec<u8>)> {
        let descriptor = match &self.directory {
            Some(dir) => dir.resolve_peer_identity(peer_device_id).await,
            None => None,
        }
        .ok_or_else(|| client_error("The route device has no authenticated paired Signal identity."))?;
        let peer_id = assert_peer_id(&descriptor.peer_id, "pairedIdentity.peerId")?;
        let expected = crate::wire::recovery::peer_id_for_route_device(
            &self.route.tenant_id,
            &self.route.route_id,
            peer_device_id,
        );
        if expected.as_deref() != Some(peer_id.as_str()) {
            return Err(client_error("The pairing identity is not bound to this exact route device."));
        }
        let identity_key = b64u_decode(&descriptor.identity_key, 512)
            .map_err(|_| client_error("The paired Signal identity descriptor is malformed."))?;
        if descriptor.signal_device_id != super::types::PEER_DEVICE_ID
            || descriptor.registration_id < 1
            || descriptor.registration_id > 0x3fff
        {
            return Err(client_error("The paired Signal identity descriptor is malformed."));
        }
        Ok((PairedSignalIdentity { peer_id, ..descriptor }, identity_key))
    }

    async fn remote_bundle(
        self: &Rc<Self>,
        peer_device_id: &str,
        descriptor: &PairedSignalIdentity,
    ) -> Result<Option<PeerPreKeyBundle>> {
        // Dedupe concurrent fetches per device.
        if let Some(pending) = self.bundle_fetches.borrow().get(peer_device_id).cloned() {
            let guard = pending.lock().await;
            if let Some(result) = guard.clone() {
                return result.map(|(_, b)| Some(b));
            }
        }
        let cell = Rc::new(Mutex::new(None));
        self.bundle_fetches.borrow_mut().insert(peer_device_id.to_string(), cell.clone());
        let result: Result<(PairedSignalIdentity, PeerPreKeyBundle)> = async {
            let response = self
                .request(
                    create_peer_bundle_fetch(&PeerBundleFetch {
                        tenant_id: self.route.tenant_id.clone(),
                        route_id: self.route.route_id.clone(),
                        device_id: self.route.device_id.clone(),
                        peer_device_id: peer_device_id.to_string(),
                    }),
                    {
                        let route_id = self.route.route_id.clone();
                        let peer = peer_device_id.to_string();
                        move |m| {
                            m.get("kind").and_then(Value::as_str) == Some("peer-bundle")
                                && m.get("deviceId").and_then(Value::as_str) == Some(peer.as_str())
                                && m.get("routeId").and_then(Value::as_str) == Some(route_id.as_str())
                        }
                    },
                )
                .await?;
            let bundle_message = parse_peer_bundle(&response)
                .filter(|b| b.device_id == peer_device_id)
                .ok_or_else(|| transport_error("The peer bundle response is malformed or out of route scope."))?;
            if bundle_message.state == "refused" {
                return Err(entry_error(
                    "peer_client_bundle_unavailable",
                    &format!("The bundle was refused: {}.", bundle_message.refusal.unwrap_or_default()),
                ));
            }
            if bundle_message.state != "available" || bundle_message.bundle.is_none() {
                return Err(entry_error(
                    "peer_client_bundle_unavailable",
                    "The paired device has not published a prekey bundle.",
                ));
            }
            let publication = bundle_message.bundle.clone().unwrap();
            let bytes = b64u_decode(&publication.material, wire::MAX_BUNDLE_BYTES * 4 / 3 + 8)
                .map_err(|_| transport_error("The peer bundle material cannot be decoded."))?;
            let json = json_decode(&bytes).ok_or_else(|| transport_error("The peer bundle material is malformed."))?;
            let bundle = PeerPreKeyBundle::from_json(&json)
                .map_err(|_| transport_error("The peer bundle material is malformed."))?;
            if bundle.peer_id != descriptor.peer_id
                || bundle.device_id != descriptor.signal_device_id
                || bundle.registration_id != descriptor.registration_id
                || b64u_encode(&bundle.identity_key) != descriptor.identity_key
            {
                self.emit(PeerClientEvent::RequiresRePair {
                    peer_id: descriptor.peer_id.clone(),
                    source: "send".to_string(),
                    detail: "The bundle differs from the authenticated pairing identity.".to_string(),
                });
                return Err(crypto_error("peer_identity_changed", "The fetched prekey bundle does not match the pairing identity."));
            }
            let observation = StoredBundleObservation {
                bundle_id: publication.bundle_id.clone(),
                revision: publication.revision,
                one_time_pre_key_id: bundle.pre_key_id,
                signed_prekey_id: Some(bundle.signed_pre_key_id),
            };
            self.save_meta_patch(|meta| {
                meta.peers.insert(peer_device_id.to_string(), descriptor.peer_id.clone());
                meta.bundle_observations.insert(peer_device_id.to_string(), observation);
            })
            .await?;
            Ok((descriptor.clone(), bundle))
        }
        .await;
        *cell.lock().await = Some(result.clone());
        self.bundle_fetches.borrow_mut().remove(peer_device_id);
        result.map(|(_, b)| Some(b))
    }

    async fn session_for(
        self: &Rc<Self>,
        peer_device_id: &str,
        local_store: Rc<RefCell<dyn PeerCryptoStore>>,
    ) -> Result<(PeerSession, String, Option<StoredBundleObservation>)> {
        let meta = self.meta().await?;
        let (descriptor, identity_key) = self.paired_signal_identity(peer_device_id).await?;
        if let Some(bound) = meta.peers.get(peer_device_id) {
            if *bound != descriptor.peer_id {
                self.emit(PeerClientEvent::RequiresRePair {
                    peer_id: descriptor.peer_id.clone(),
                    source: "send".to_string(),
                    detail: "The paired device resolves to a different retained Signal identity.".to_string(),
                });
                return Err(crypto_error("peer_identity_changed", "The route's authenticated Signal identity changed."));
            }
        }
        pin_peer_identity(
            &*self.crypto.borrow(),
            &descriptor.peer_id,
            descriptor.signal_device_id,
            &identity_key,
        )?;
        if let Some(binding) = self.crypto.borrow().load_peer_binding(&descriptor.peer_id)? {
            if binding.state != "active" {
                self.emit(PeerClientEvent::RequiresRePair {
                    peer_id: descriptor.peer_id.clone(),
                    source: "send".to_string(),
                    detail: "The pinned peer identity is blocked.".to_string(),
                });
                return Err(crypto_error("peer_identity_changed", "The pinned peer identity is blocked."));
            }
        }
        let observation = meta.bundle_observations.get(peer_device_id).cloned();
        let address = super::store::peer_session_address_key(&descriptor.peer_id, descriptor.signal_device_id);
        if self.crypto.borrow().load_session(&address)?.is_some() {
            let session = PeerSession::resume(
                self.identity.clone(),
                local_store,
                &descriptor.peer_id,
                descriptor.signal_device_id,
            )
            .await?;
            return Ok((session, descriptor.peer_id, observation));
        }
        let Some(bundle) = self.remote_bundle(peer_device_id, &descriptor).await? else {
            return Err(entry_error("peer_client_bundle_unavailable", "The prekey bundle could not be decoded."));
        };
        let session = PeerSession::initiate(self.identity.clone(), local_store, &bundle).await?;
        let observation = self.meta().await?.bundle_observations.get(peer_device_id).cloned();
        Ok((session, descriptor.peer_id, observation))
    }

    async fn wire_envelope(
        &self,
        envelope: &PeerEnvelope,
        observation: Option<&StoredBundleObservation>,
    ) -> Result<PeerWireEnvelope> {
        let local = self.local_bundle().await?;
        Ok(PeerWireEnvelope {
            format: self.wire_profile.clone(),
            headers: wire::PeerEnvelopeHeaders {
                message_type: if envelope.message_type == PeerEnvelopeMessageType::PreKey {
                    wire::HEADER_TYPE_PREKEY.to_string()
                } else {
                    wire::HEADER_TYPE_SESSION.to_string()
                },
                sender_bundle_id: local.bundle_id.clone(),
                recipient_bundle_id: observation
                    .map(|o| o.bundle_id.clone())
                    .unwrap_or_else(|| "unpublished".to_string()),
                prekey_id: observation.and_then(|o| o.one_time_pre_key_id.map(|id| format!("opk.{id}"))),
                signed_prekey_id: observation.and_then(|o| o.signed_prekey_id.map(|id| format!("spk.{id}"))),
                base_key_id: None,
            },
            ciphertext: b64u_encode(&envelope.serialize()?),
        })
    }

    async fn local_bundle(&self) -> Result<StoredLocalBundle> {
        let meta = self.meta().await?;
        if let Some(bundle) = meta.local_bundle.clone() {
            return Ok(bundle);
        }
        let bundle = StoredLocalBundle {
            version: PEER_CLIENT_STORE_RECORD_VERSION,
            bundle_id: new_peer_bundle_id(),
            revision: 0,
            format: self.wire_profile.clone(),
            material: None,
        };
        self.save_meta_patch(|m| m.local_bundle = Some(bundle.clone())).await?;
        Ok(bundle)
    }

    /* --------------------------------- send --------------------------------- */

    /// Durable send: encrypt + WAL-commit + forward; a signed ACK is the only
    /// delivered transition. Idempotent on the exact message identity.
    pub async fn send_message(
        self: &Rc<Self>,
        peer_device_id: &str,
        plaintext: &[u8],
        message_id: Option<String>,
    ) -> Result<StoredOutboxEntry> {
        self.prepare_route().await?;
        let recipient = assert_opaque_id(peer_device_id, "peerDeviceId")?;
        if recipient == self.route.device_id {
            return Err(client_error("A device cannot send to itself."));
        }
        if plaintext.is_empty() || plaintext.len() > PEER_CLIENT_MAX_PLAINTEXT_BYTES {
            return Err(client_error("The Peer plaintext is empty or exceeds the supported encoded size."));
        }
        let message_id = match message_id {
            Some(id) => assert_opaque_id(&id, "messageId")?,
            None => new_peer_message_id(),
        };
        let identity = self.outbox.identity(&message_id, &recipient)?;
        if let Some(existing) = self.outbox.entry_for_identity(&identity)? {
            if existing.state == "conflict" {
                return Err(conflict_error("This message identity is already conflicted."));
            }
            if existing.state == "pending"
                && !self
                    .forward_retries
                    .borrow()
                    .contains_key(&self.forward_retry_key(PEER_KIND_SEND, &identity))
            {
                self.forward_entry(&existing).await?;
            }
            return Ok(self.outbox.entry_for_identity(&identity)?.unwrap_or(existing));
        }

        let entry = self
            .with_crypto({
                let this = Rc::clone(self);
                let identity = identity.clone();
                let recipient = recipient.clone();
                let message_id = message_id.clone();
                let plaintext = plaintext.to_vec();
                async move || {
                    // A prior process may have crashed after the WAL commit
                    // but before the caller observed success; never encrypt
                    // the same logical identity again.
                    if let Some(recovered) = this.outbox.entry_for_identity(&identity)? {
                        if recovered.state == "conflict" {
                            return Err(conflict_error("This message identity is already conflicted."));
                        }
                        return Ok(recovered);
                    }
                    let overlay = create_peer_crypto_transaction_overlay(this.crypto.clone());
                    let (mut session, peer_id, observation) = this
                        .session_for(&recipient, overlay.store.clone())
                        .await?;
                    let crypto_envelope = session.encrypt(&plaintext).await?;
                    let envelope = this.wire_envelope(&crypto_envelope, observation.as_ref()).await?;
                    let sequence = this.store.allocate_outbox_sequence(&PeerClientRouteScope {
                        tenant_id: this.route.tenant_id.clone(),
                        route_id: this.route.route_id.clone(),
                    })?;
                    let entry = this.outbox.create_entry(NewOutboxEntry {
                        recipient_device_id: recipient.clone(),
                        message_id: message_id.clone(),
                        peer_id,
                        envelope,
                        sequence: Some(sequence),
                    })?;
                    let prepared = PeerCryptoPreparedOperation {
                        version: 1,
                        kind: "send".to_string(),
                        message_id: message_id.clone(),
                        mutations: mutations_to_json(&overlay.mutations()),
                        application_record: b64u_encode(
                            &serde_json::to_vec(&entry)
                                .map_err(|_| store_error("The outbox record could not be encoded."))?,
                        ),
                        prepared_at: iso_now(),
                    };
                    this.crypto.borrow().prepare_operation(&prepared)?;
                    this.recover_prepared_operation().await?;
                    let Some(saved) = this.outbox.entry_for_identity(&identity)? else {
                        return Err(store_error("The prepared ciphertext was not committed to the durable outbox."));
                    };
                    this.emit_send(&saved);
                    Ok(saved)
                }
            })
            .await?;
        self.forward_entry(&entry).await?;
        Ok(self.outbox.entry_for_identity(&identity)?.unwrap_or(entry))
    }

    async fn forward_entry(self: &Rc<Self>, entry: &StoredOutboxEntry) -> Result<()> {
        if self.disposed.get() || entry.state != "pending" {
            return Ok(());
        }
        let key = tuple_key(&entry.identity);
        if !self.forwarding.borrow_mut().insert(key.clone()) {
            return Ok(());
        }
        let result: Result<()> = async {
            let pending = self.outbox.pending_page(0, CLIENT_RECEIVE_WINDOW)?;
            if !pending.items.iter().any(|c| {
                c.identity.message_id == entry.identity.message_id
                    && c.identity.recipient_device_id == entry.identity.recipient_device_id
            }) {
                return Ok(());
            }
            let identity = self.outbox.identity(&entry.identity.message_id, &entry.identity.recipient_device_id)?;
            let Some(updated) = self.with_store(|| self.outbox.mark_attempt(&identity, None)).await? else {
                return Ok(());
            };
            if updated.state != "pending" || self.disposed.get() {
                return Ok(());
            }
            let send = PeerSend {
                tenant_id: updated.identity.tenant_id.clone(),
                route_id: updated.identity.route_id.clone(),
                sender_device_id: updated.identity.sender_device_id.clone(),
                recipient_device_id: updated.identity.recipient_device_id.clone(),
                message_id: updated.identity.message_id.clone(),
                envelope: updated.envelope.clone(),
            };
            // A relay-forwarded frame may still fail receiver admission or
            // durable storage; keep retrying until a signed ACK settles it.
            self.schedule_forward_retry(PEER_KIND_SEND, updated.identity.clone(), updated.identity.recipient_device_id.clone());
            if let Err(error) = self.transport.send(create_peer_send(&send)).await {
                self.schedule_forward_retry(PEER_KIND_SEND, identity, updated.identity.recipient_device_id.clone());
                return Err(error);
            }
            Ok(())
        }
        .await;
        self.forwarding.borrow_mut().remove(&key);
        if let Err(e) = result {
            self.emit_error(&e);
        }
        Ok(())
    }

    async fn drive_pending(self: &Rc<Self>, peer_device_id: Option<&str>, force: bool) -> Result<()> {
        let page = self.outbox.pending_page(0, CLIENT_RECEIVE_WINDOW)?;
        for entry in page.items {
            if let Some(peer) = peer_device_id {
                if entry.identity.recipient_device_id != peer {
                    continue;
                }
            }
            let presence = self.presence(&entry.identity.recipient_device_id);
            if presence.as_ref().map(|p| p.state.as_str()) == Some("unreachable") {
                continue;
            }
            if self
                .forward_retries
                .borrow()
                .contains_key(&self.forward_retry_key(PEER_KIND_SEND, &entry.identity))
            {
                continue;
            }
            if entry.last_forwarded.is_some()
                && (!force || presence.as_ref().map(|p| p.state.as_str()) != Some("reachable"))
            {
                continue;
            }
            self.forward_entry(&entry).await?;
        }
        Ok(())
    }

    async fn wake_peer(self: &Rc<Self>, peer_device_id: &str) -> Result<()> {
        self.retry_tracked_for_peer(peer_device_id).await?;
        self.retry_acks_for_peer(Some(peer_device_id)).await?;
        self.drive_pending(Some(peer_device_id), true).await
    }

    async fn retry_acks_for_peer(self: &Rc<Self>, peer_device_id: Option<&str>) -> Result<()> {
        let mut after_sequence = 0u64;
        loop {
            let page = self.inbox.pending_delivery_ack_page(after_sequence, self.page_size)?;
            for entry in page.items {
                if entry.plaintext.is_none() || entry.delivery_ack.is_some() {
                    continue;
                }
                if let Some(peer) = peer_device_id {
                    if entry.identity.sender_device_id != peer {
                        continue;
                    }
                }
                let send = PeerSend {
                    tenant_id: entry.identity.tenant_id.clone(),
                    route_id: entry.identity.route_id.clone(),
                    sender_device_id: entry.identity.sender_device_id.clone(),
                    recipient_device_id: entry.identity.recipient_device_id.clone(),
                    message_id: entry.identity.message_id.clone(),
                    envelope: entry.envelope.clone(),
                };
                self.create_and_forward_ack(&entry, &send).await?;
            }
            match page.next_after_sequence {
                None => return Ok(()),
                Some(next) => after_sequence = next,
            }
        }
    }

    /* -------------------------------- dispatch ------------------------------- */

    pub fn on_inbound_message(self: &Rc<Self>, handler: PeerDispatchHandler) {
        *self.dispatch_handler.borrow_mut() = Some(handler);
        let this = Rc::clone(self);
        tokio::task::spawn_local(async move {
            if let Err(e) = this.retry_pending_dispatch().await {
                this.emit_error(&e);
            }
        });
    }

    pub fn clear_inbound_message_handler(&self) {
        *self.dispatch_handler.borrow_mut() = None;
        self.clear_dispatch_retry();
    }

    pub async fn retry_pending_dispatch(self: &Rc<Self>) -> Result<()> {
        if self.disposed.get() || self.dispatch_handler.borrow().is_none() {
            return Ok(());
        }
        self.prepare_route().await?;
        let mut after_sequence = 0u64;
        loop {
            let page = self.inbox.pending_dispatch_page(after_sequence, self.page_size)?;
            for entry in page.items {
                self.dispatch_entry(entry).await?;
            }
            match page.next_after_sequence {
                None => return Ok(()),
                Some(next) => after_sequence = next,
            }
        }
    }

    async fn dispatch_entry(self: &Rc<Self>, entry: StoredInboxEntry) -> Result<DispatchAttemptResult> {
        let handler = self.dispatch_handler.borrow().clone();
        let Some(handler) = handler else {
            return Ok(DispatchAttemptResult::NotAttempted);
        };
        if self.disposed.get() || entry.plaintext.is_none() || entry.dispatch != "pending" {
            return Ok(DispatchAttemptResult::NotAttempted);
        }
        let key = tuple_key(&entry.identity);
        if self.dispatching.borrow().contains_key(&key) {
            return Ok(DispatchAttemptResult::NotAttempted);
        }
        if self.dispatching.borrow().len() >= CLIENT_DISPATCH_WINDOW {
            self.dispatch_retry_waiting_for_active.set(true);
            return Ok(DispatchAttemptResult::NotAttempted);
        }
        self.dispatching.borrow_mut().insert(key.clone(), Rc::new(RefCell::new(())));
        let result = self.dispatch_entry_once(&entry, handler).await;
        self.dispatching.borrow_mut().remove(&key);
        let result = match result {
            Ok(r) => r,
            Err(e) => {
                self.emit_error(&e);
                DispatchAttemptResult::Deferred
            }
        };
        if self.dispatch_retry_waiting_for_active.replace(false) {
            self.dispatch_retry_after_sequence.set(0);
            self.schedule_dispatch_retry();
        }
        if result == DispatchAttemptResult::Deferred {
            self.schedule_dispatch_retry();
        }
        Ok(result)
    }

    async fn dispatch_entry_once(
        self: &Rc<Self>,
        snapshot: &StoredInboxEntry,
        handler: PeerDispatchHandler,
    ) -> Result<DispatchAttemptResult> {
        let Some(entry) = self.with_store(|| self.inbox.entry(&snapshot.identity)).await? else {
            return Ok(DispatchAttemptResult::Settled);
        };
        if self.dispatch_handler.borrow().as_ref().map(|h| Rc::ptr_eq(h, &handler)) != Some(true) {
            return Ok(DispatchAttemptResult::NotAttempted);
        }
        if entry.dispatch != "pending" {
            return Ok(DispatchAttemptResult::Settled);
        }
        let Some(encoded) = entry.plaintext.clone() else {
            return Ok(DispatchAttemptResult::NotAttempted);
        };
        let Ok(plaintext) = b64u_decode(&encoded, OLD_PLAINTEXT_LIMIT) else {
            self.emit(PeerClientEvent::Error {
                code: "peer_client_store".to_string(),
                detail: "A durable inbox plaintext cannot be decoded.".to_string(),
            });
            return Ok(DispatchAttemptResult::NotAttempted);
        };
        let message = PeerInboundMessage {
            message_id: entry.identity.message_id.clone(),
            sender_peer_id: entry.sender_peer_id.clone().unwrap_or_default(),
            sender_device_id: entry.identity.sender_device_id.clone(),
            plaintext,
            received_at: entry.received_at.clone(),
        };
        let outcome = (handler)(message.clone()).await;
        match outcome.kind() {
            "deferred" => {
                self.emit(PeerClientEvent::DispatchDeferred {
                    message_id: entry.identity.message_id.clone(),
                    sender_device_id: entry.identity.sender_device_id.clone(),
                });
                Ok(DispatchAttemptResult::Deferred)
            }
            kind @ ("accepted_by_agent" | "rejected") => {
                self.with_store(|| self.inbox.mark_dispatch(&entry.identity, kind)).await?;
                self.emit(PeerClientEvent::Inbound(message));
                Ok(DispatchAttemptResult::Settled)
            }
            _ => {
                self.emit(PeerClientEvent::Error {
                    code: "peer_client_state".to_string(),
                    detail: "The inbound handler returned an invalid dispatch outcome.".to_string(),
                });
                Ok(DispatchAttemptResult::Deferred)
            }
        }
    }

    /* --------------------------------- bundle --------------------------------- */

    /// Publish this device's public prekey bundle; refreshes the pool first.
    pub async fn publish_bundle(self: &Rc<Self>) -> Result<(String, u64, String)> {
        self.prepare_route().await?;
        replenish_peer_prekeys(&self.identity, &*self.crypto.borrow(), None, None)?;
        let bundle = generate_peer_prekey_bundle(&self.identity, &*self.crypto.borrow())?;
        let material = b64u_encode(
            &serde_json::to_vec(&bundle.to_json())
                .map_err(|_| store_error("The prekey bundle could not be encoded."))?,
        );
        let local = self.local_bundle().await?;
        let mut revision = local.revision + 1;
        let mut retried_stale = false;
        loop {
            let response = self
                .request(
                    create_peer_bundle_publish(&PeerBundlePublish {
                        tenant_id: self.route.tenant_id.clone(),
                        route_id: self.route.route_id.clone(),
                        device_id: self.route.device_id.clone(),
                        bundle: PrekeyBundlePublication {
                            format: self.wire_profile.clone(),
                            bundle_id: local.bundle_id.clone(),
                            revision,
                            material: material.clone(),
                        },
                    }),
                    {
                        let route_id = self.route.route_id.clone();
                        let device_id = self.route.device_id.clone();
                        let bundle_id = local.bundle_id.clone();
                        move |m| {
                            m.get("kind").and_then(Value::as_str) == Some("peer-bundle-published")
                                && m.get("routeId").and_then(Value::as_str) == Some(route_id.as_str())
                                && m.get("deviceId").and_then(Value::as_str) == Some(device_id.as_str())
                                && m.get("bundleId").and_then(Value::as_str) == Some(bundle_id.as_str())
                        }
                    },
                )
                .await?;
            let published = parse_peer_bundle_published(&response)
                .filter(|p| p.device_id == self.route.device_id && p.bundle_id == local.bundle_id)
                .ok_or_else(|| transport_error("The prekey publish response is malformed or out of scope."))?;
            if published.outcome == "refused" {
                if published.refusal.as_deref() == Some("stale_revision") && !retried_stale {
                    retried_stale = true;
                    revision = published.current_revision + 1;
                    continue;
                }
                self.emit(PeerClientEvent::BundleRefused {
                    refusal: published.refusal.clone().unwrap_or_else(|| "authority_stale".to_string()),
                });
                return Err(entry_error(
                    "peer_client_bundle_unavailable",
                    &format!("The prekey bundle was refused: {}.", published.refusal.unwrap_or_default()),
                ));
            }
            self.save_meta_patch(|meta| {
                meta.local_bundle = Some(StoredLocalBundle {
                    version: PEER_CLIENT_STORE_RECORD_VERSION,
                    bundle_id: local.bundle_id.clone(),
                    revision: published.current_revision,
                    format: self.wire_profile.clone(),
                    material: Some(material.clone()),
                });
            })
            .await?;
            self.emit(PeerClientEvent::BundlePublished {
                bundle_id: local.bundle_id.clone(),
                revision: published.current_revision,
                outcome: published.outcome.clone(),
            });
            return Ok((local.bundle_id.clone(), published.current_revision, published.outcome));
        }
    }

    /* --------------------------------- resume -------------------------------- */

    /// Reconcile device-local durable work over the online transport.
    pub async fn sync(self: &Rc<Self>) -> Result<()> {
        self.resume().await
    }

    pub async fn resume(self: &Rc<Self>) -> Result<()> {
        let _guard = self.crypto_lock.lock().await;
        if self.disposed.get() {
            return Err(client_error("The Peer client was disposed."));
        }
        self.prepare_route().await?;
        self.recover_prepared_operation().await?;
        drop(_guard);
        self.retry_acks_for_peer(None).await?;
        self.retry_pending_dispatch().await?;
        self.drive_pending(None, true).await
    }

    /// Re-pairing: bump the trust generation and drop stale ratchet sessions.
    pub fn repin_peer(&self, peer_id: &str, device_id: u32, new_identity_key: &[u8]) -> Result<PeerIdentityBinding> {
        repin_peer_identity(&*self.crypto.borrow(), peer_id, device_id, new_identity_key)
    }

    /// Evidence-preserving block: the pin stays for audit, traffic is refused.
    pub fn block_peer(&self, peer_id: &str) -> Result<()> {
        block_peer_identity(&*self.crypto.borrow(), peer_id)
    }

    /// Signal 60-digit safety number over the paired identity keys.
    pub fn peer_safety_number_for(&self, peer_id: &str) -> Result<Option<String>> {
        let Some(binding) = self.crypto.borrow().load_peer_binding(peer_id)? else {
            return Ok(None);
        };
        if binding.state != "active" {
            return Ok(None);
        }
        let Ok(key) = b64u_decode(&binding.identity_key, 512) else {
            return Ok(None);
        };
        let local_key = self.identity.identity_key_pair().identity_key().serialize();
        peer_safety_number(local_key.as_ref(), &key).map(Some)
    }

    pub async fn learned_peers(&self) -> Result<HashMap<String, String>> {
        Ok(self.meta().await?.peers)
    }

    pub async fn local_bundle_header(&self) -> Result<Option<(String, u64)>> {
        Ok(self.meta().await?.local_bundle.map(|b| (b.bundle_id, b.revision)))
    }
}

enum DecodedPreparedRecord {
    Send(StoredOutboxEntry),
    Receive(StoredInboxEntry),
}

fn tuple_key(identity: &PeerMessageIdentity) -> String {
    json!([
        identity.tenant_id,
        identity.route_id,
        identity.sender_device_id,
        identity.recipient_device_id,
        identity.message_id
    ])
    .to_string()
}
