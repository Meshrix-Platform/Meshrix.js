//! `peer.ts` — entry-side peer messaging runtime, one per enrolled
//! connection. Identical composition to the TS host: a durable `PeerClient`
//! over file stores under `<dataDir>/peer/<connSlug>/`, bound to the
//! relay-authenticated route identity. The wire channel is the SAME admitted
//! forward session — `attach_channel` installs the live generation's send,
//! `on_session_admitted`/`on_session_closed` open and close the gate.
//!
//! Everything here is `!Send` and must live on the host's `LocalSet` thread,
//! exactly like the TS single-threaded event loop.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use futures_util::future::LocalBoxFuture;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::error::entry_error;
use crate::relay::entry::EntrySession;
use crate::Result;

use super::client::{
    PeerClient, PeerClientEvent, PeerClientOptions, PeerClientTransport, PeerDispatchHandler,
    PeerRouteIdentity,
};
use super::client_store::{PeerClientStore, StoredInboxEntry, StoredOutboxEntry};
use super::identity::{create_peer_identity, load_peer_identity, PairedSignalIdentity};
use super::store::{FilePeerCryptoStore, PeerCryptoStore};
use super::wire::{peer_channel_not_admitted_error, PeerPresence};

const PEER_EVENT_LOG_LIMIT: usize = 32;

/// Per-connection peer store location inside the owned data directory.
pub fn peer_store_dir_for(data_dir: &std::path::Path, connection_id: &str) -> std::path::PathBuf {
    let safe: String = connection_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    data_dir.join("peer").join(safe)
}

/// Mutable channel cell shared with the client's transport closure — the
/// `send` gate refuses immediately while the session generation is dead.
struct SessionChannelGate {
    session: RefCell<Option<std::sync::Arc<EntrySession>>>,
    live: Cell<bool>,
}

impl PeerClientTransport for SessionChannelGate {
    fn send<'a>(&'a self, message: Value) -> LocalBoxFuture<'a, Result<()>> {
        Box::pin(async move {
            if !self.live.get() {
                return Err(peer_channel_not_admitted_error());
            }
            let session = self.session.borrow().clone();
            match session {
                Some(session) => session.send_peer(message).await,
                None => Err(peer_channel_not_admitted_error()),
            }
        })
    }
}

/// Bounded tail of notable local runtime events.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRuntimeEvent {
    pub at: String,
    pub kind: String,
    pub detail: String,
}

/// Outbox/inbox operator view of a stored entry.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerOutboxView {
    pub message_id: String,
    pub peer_device_id: String,
    pub state: String,
    pub attempts: u64,
    pub sequence: u64,
    pub created_at: String,
    pub updated_at: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInboxView {
    pub message_id: String,
    pub sender_device_id: String,
    pub dispatch: String,
    pub sequence: u64,
    pub received_at: Option<String>,
    pub decrypt_error: Option<String>,
}

/// Paged inbox result — mirrors `runtime.inbox(limit, afterSequence)`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInboxResult {
    pub entries: Vec<PeerInboxView>,
    pub pending_entries: Vec<PeerInboxView>,
    pub history_next_after_sequence: Option<u64>,
    pub pending_next_after_sequence: Option<u64>,
}

/// `runtime.pairSafety` — out-of-band peer identity evidence.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerPairSafety {
    pub peer_device_id: String,
    pub peer_id: Option<String>,
    pub safety_number: Option<String>,
}

fn peer_inbox_view(entry: &StoredInboxEntry) -> PeerInboxView {
    PeerInboxView {
        message_id: entry.identity.message_id.clone(),
        sender_device_id: entry.identity.sender_device_id.clone(),
        dispatch: entry.dispatch.clone(),
        sequence: entry.sequence,
        received_at: Some(entry.received_at.clone()),
        decrypt_error: entry.decrypt_error.clone(),
    }
}

fn peer_outbox_view(entry: &StoredOutboxEntry) -> PeerOutboxView {
    PeerOutboxView {
        message_id: entry.identity.message_id.clone(),
        peer_device_id: entry.identity.recipient_device_id.clone(),
        state: entry.state.clone(),
        attempts: entry.attempts,
        sequence: entry.sequence,
        created_at: entry.created_at.clone(),
        updated_at: entry.updated_at.clone(),
        last_error: entry.last_error.clone(),
    }
}

/// `EntryPeerStatus` — operator-facing peer runtime snapshot.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryPeerStatus {
    pub enabled: bool,
    pub peer_id: String,
    pub route: PeerRouteIdentityView,
    pub session_live: bool,
    pub local_bundle: Option<(String, u64)>,
    pub peers: std::collections::HashMap<String, String>,
    pub outbox: Vec<PeerOutboxView>,
    pub outbox_next_after_sequence: Option<u64>,
    pub pending_outbox: Vec<PeerOutboxView>,
    pub pending_outbox_next_after_sequence: Option<u64>,
    pub pending_inbox_page_count: usize,
    pub pending_inbox_next_after_sequence: Option<u64>,
    pub inbox_next_after_sequence: Option<u64>,
    pub events: Vec<PeerRuntimeEvent>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRouteIdentityView {
    pub tenant_id: String,
    pub route_id: String,
    pub device_id: String,
}

pub struct EntryPeerRuntime {
    pub client: Rc<PeerClient>,
    pub peer_id: String,
    route: PeerRouteIdentity,
    channel: Rc<SessionChannelGate>,
    events: RefCell<VecDeque<PeerRuntimeEvent>>,
    live_generation: Cell<u64>,
    bundle_published: Cell<bool>,
    closed: Cell<bool>,
    /// Drains the live session's peer inbox into the client.
    inbox_task: RefCell<Option<tokio::task::AbortHandle>>,
    event_task: RefCell<Option<tokio::task::AbortHandle>>,
}

impl EntryPeerRuntime {
    /// `EntryPeerRuntime.create` — binds the route, opens the durable stores,
    /// loads (never silently rotates) the Signal identity.
    pub async fn create(
        options: EntryPeerRuntimeOptions,
    ) -> Result<Rc<Self>> {
        let route = options.route.clone();
        let peer_id = super::peer_id_for_route_device(
            &route.tenant_id,
            &route.route_id,
            &route.device_id,
        )
        .ok_or_else(|| {
            entry_error(
                "peer_identity_invalid",
                "The connection identity cannot derive a peer id; peer messaging is unavailable.",
            )
        })?;
        std::fs::create_dir_all(&options.store_dir).map_err(|_| {
            entry_error("peer_store_error", "The peer store directory could not be created.")
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                &options.store_dir,
                std::fs::Permissions::from_mode(0o700),
            );
        }
        let crypto_store: Rc<RefCell<dyn PeerCryptoStore>> = Rc::new(RefCell::new(
            FilePeerCryptoStore::new(options.store_dir.join("crypto")),
        ));
        let client_store: Rc<dyn PeerClientStore> = options.client_store;
        let channel = Rc::new(SessionChannelGate {
            session: RefCell::new(None),
            live: Cell::new(false),
        });
        let mut identity = load_peer_identity(&*crypto_store.borrow())?;
        match &identity {
            Some(existing) if existing.peer_id != peer_id => {
                return Err(entry_error(
                    "peer_identity_invalid",
                    "The stored peer identity does not match the derived binding; the peer store does not belong to this connection.",
                ));
            }
            None => {
                if options.paired_peer_identity.is_some() {
                    return Err(entry_error(
                        "peer_identity_unavailable",
                        "The local Signal identity from the completed pairing is unavailable; preserve task history and re-pair this device before sending Peer messages.",
                    ));
                }
                identity = Some(create_peer_identity(&*crypto_store.borrow(), Some(&peer_id))?);
            }
            _ => {}
        }
        let identity = identity.expect("identity resolved above");
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<PeerClientEvent>();
        let client = PeerClient::new(PeerClientOptions {
            identity,
            crypto_store: crypto_store.clone(),
            client_store: client_store.clone(),
            transport: channel.clone() as Rc<dyn PeerClientTransport>,
            route: route.clone(),
            directory: options.directory,
            dispatch: options.dispatch,
            wire_profile: None,
            page_size: None,
            events: event_tx,
        })?;
        let events: Rc<RefCell<VecDeque<PeerRuntimeEvent>>> = Rc::new(RefCell::new(VecDeque::new()));
        let log = events.clone();
        let forward = options.event_forward.clone();
        let event_task = tokio::task::spawn_local(async move {
            while let Some(event) = event_rx.recv().await {
                let (kind, detail) = describe_event(&event);
                if let Some(kind) = kind {
                    let mut log = log.borrow_mut();
                    log.push_back(PeerRuntimeEvent {
                        at: now_iso(),
                        kind: kind.to_string(),
                        detail: detail.chars().take(256).collect(),
                    });
                    while log.len() > PEER_EVENT_LOG_LIMIT {
                        log.pop_front();
                    }
                }
                if let Some(tx) = &forward {
                    let _ = tx.send(event);
                }
            }
        });
        let runtime = Rc::new(Self {
            client: client.clone(),
            peer_id,
            route,
            channel,
            events: RefCell::new(events.take()),
            live_generation: Cell::new(0),
            bundle_published: Cell::new(false),
            closed: Cell::new(false),
            inbox_task: RefCell::new(None),
            event_task: RefCell::new(Some(event_task.abort_handle())),
        });
        // Local status and history must work while disconnected — bind the
        // route and recover prepared transactions without resuming traffic.
        client.prepare_local_state().await?;
        // Keep the spawned event task alive through runtime.
        std::mem::forget(event_task);
        Ok(runtime)
    }

    /// `EntryPeerRuntime.preparePairingIdentity` — provision the stable local
    /// Signal identity before it is signed into pairing.
    pub fn prepare_pairing_identity(
        store_dir: &std::path::Path,
        route: &PeerRouteIdentity,
        require_existing: bool,
    ) -> Result<PairedSignalIdentity> {
        let peer_id = super::peer_id_for_route_device(
            &route.tenant_id,
            &route.route_id,
            &route.device_id,
        )
        .ok_or_else(|| {
            entry_error("peer_identity_invalid", "The pairing route cannot derive a Peer identity.")
        })?;
        std::fs::create_dir_all(store_dir).map_err(|_| {
            entry_error("peer_store_error", "The peer store directory could not be created.")
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(store_dir, std::fs::Permissions::from_mode(0o700));
        }
        let crypto_dir = store_dir.join("crypto");
        let file_store = FilePeerCryptoStore::new(crypto_dir);
        let mut identity = load_peer_identity(&file_store)?;
        if identity.is_none() && require_existing {
            return Err(entry_error(
                "peer_identity_unavailable",
                "The local Signal identity from the submitted pairing is unavailable; restore its protected state or explicitly pair again.",
            ));
        }
        if identity.is_none() {
            identity = Some(create_peer_identity(&file_store, Some(&peer_id))?);
        }
        let identity = identity.expect("identity resolved above");
        if identity.peer_id != peer_id {
            return Err(entry_error(
                "peer_identity_invalid",
                "The saved local Signal identity is bound to another pairing route.",
            ));
        }
        Ok(identity.paired_signal_identity())
    }

    /// Install the live session generation — drains its peer inbox lane into
    /// the client and stores the session for the send gate.
    pub fn attach_channel(self: &Rc<Self>, session: std::sync::Arc<EntrySession>) {
        if self.closed.get() {
            return;
        }
        *self.channel.session.borrow_mut() = Some(session.clone());
        if let Some(mut inbox) = session.take_peer_inbox() {
            let client = self.client.clone();
            let task = tokio::task::spawn_local(async move {
                while let Some(value) = inbox.recv().await {
                    client.handle_inbound_message(&value);
                }
            });
            *self.inbox_task.borrow_mut() = Some(task.abort_handle());
            std::mem::forget(task);
        }
    }

    /// The session generation's send is gone — the gate refuses immediately.
    pub fn detach_channel(&self) {
        *self.channel.session.borrow_mut() = None;
        self.channel.live.set(false);
    }

    /// The forward session regained admission: recover durable local receipt,
    /// dispatch, and outbox state, then publish the prekey bundle once.
    pub fn on_session_admitted(self: &Rc<Self>) {
        if self.closed.get() {
            return;
        }
        self.channel.live.set(true);
        self.live_generation.set(self.live_generation.get() + 1);
        let generation = self.live_generation.get();
        let this = Rc::clone(self);
        tokio::task::spawn_local(async move {
            if let Err(error) = this.client.resume().await {
                this.record_event("resume_failed", &error.to_string());
            }
            if this.closed.get() || generation != this.live_generation.get() {
                return;
            }
            if !this.bundle_published.get() {
                match this.client.publish_bundle().await {
                    Ok(_) => this.bundle_published.set(true),
                    Err(error) => this.record_event("bundle_publish_failed", &error.to_string()),
                }
            }
        });
    }

    /// The live session generation ended — the gate closes with it.
    pub fn on_session_closed(&self) {
        self.channel.live.set(false);
        self.live_generation.set(self.live_generation.get() + 1);
        self.client.transport_lost();
    }

    pub fn session_live(&self) -> bool {
        self.channel.live.get() && self.channel.session.borrow().is_some() && !self.closed.get()
    }

    /// `isPeerReachable` — presence must be the exact route's counterpart.
    pub fn is_peer_reachable(&self, peer_device_id: &str) -> bool {
        self.session_live()
            && self
                .client
                .presence(peer_device_id)
                .map(|p: PeerPresence| {
                    p.tenant_id == self.route.tenant_id
                        && p.route_id == self.route.route_id
                        && p.device_id == self.route.device_id
                        && p.peer_device_id == peer_device_id
                        && p.state == "reachable"
                })
                .unwrap_or(false)
    }

    pub async fn status(&self) -> Result<EntryPeerStatus> {
        let local_bundle = self.client.local_bundle_header().await?;
        let peers = self.client.learned_peers().await?;
        let outbox_history = self.client.outbox.history_page(0, 32)?;
        let outbox_pending = self.client.outbox.pending_page(0, 32)?;
        let inbox_history = self.client.inbox.history_page(0, 32)?;
        let inbox_pending = self.client.inbox.pending_dispatch_page(0, 32)?;
        Ok(EntryPeerStatus {
            enabled: true,
            peer_id: self.peer_id.clone(),
            route: PeerRouteIdentityView {
                tenant_id: self.route.tenant_id.clone(),
                route_id: self.route.route_id.clone(),
                device_id: self.route.device_id.clone(),
            },
            session_live: self.session_live(),
            local_bundle: local_bundle.map(|(id, rev)| (id, rev)),
            peers,
            outbox: outbox_history.items.iter().map(peer_outbox_view).collect(),
            outbox_next_after_sequence: outbox_history.next_after_sequence,
            pending_outbox: outbox_pending.items.iter().map(peer_outbox_view).collect(),
            pending_outbox_next_after_sequence: outbox_pending.next_after_sequence,
            pending_inbox_page_count: inbox_pending.items.len(),
            pending_inbox_next_after_sequence: inbox_pending.next_after_sequence,
            inbox_next_after_sequence: inbox_history.next_after_sequence,
            events: self.events.borrow().iter().cloned().collect(),
        })
    }

    /// `inbox` — operator inbox listing: bounded local history plus
    /// pending-handoff pages.
    pub async fn inbox(
        &self,
        limit: usize,
        after_sequence: u64,
    ) -> Result<PeerInboxResult> {
        let page_size = limit.clamp(1, 512);
        let history = self.client.inbox.history_page(after_sequence, page_size)?;
        let pending = self
            .client
            .inbox
            .pending_dispatch_page(after_sequence, page_size)?;
        Ok(PeerInboxResult {
            entries: history.items.iter().map(peer_inbox_view).collect(),
            pending_entries: pending.items.iter().map(peer_inbox_view).collect(),
            history_next_after_sequence: history.next_after_sequence,
            pending_next_after_sequence: pending.next_after_sequence,
        })
    }

    /// `pairSafety` — out-of-band safety evidence for one wire peer. The
    /// peer id resolves from the learned device binding or the shared route
    /// derivation — never from a wire message. `safety_number` stays `None`
    /// until the peer identity is pinned; it is never invented.
    pub async fn pair_safety(&self, peer_device_id: &str) -> Result<PeerPairSafety> {
        if peer_device_id.is_empty() {
            return Err(entry_error(
                "peer_message_invalid",
                "peer.pairSafety requires the counterparty peerDeviceId.",
            ));
        }
        let peers = self.client.learned_peers().await?;
        let peer_id = peers.get(peer_device_id).cloned().or_else(|| {
            crate::peer::peer_id_for_route_device(
                &self.route.tenant_id,
                &self.route.route_id,
                peer_device_id,
            )
        });
        let Some(peer_id) = peer_id else {
            return Ok(PeerPairSafety {
                peer_device_id: peer_device_id.to_string(),
                peer_id: None,
                safety_number: None,
            });
        };
        let safety_number = self.client.peer_safety_number_for(&peer_id)?;
        Ok(PeerPairSafety {
            peer_device_id: peer_device_id.to_string(),
            peer_id: Some(peer_id),
            safety_number,
        })
    }

    /// Queue + drive one send — returns the durable outbox entry.
    pub async fn send_message(
        &self,
        peer_device_id: &str,
        plaintext: Vec<u8>,
        message_id: Option<String>,
    ) -> Result<StoredOutboxEntry> {
        if self.closed.get() {
            return Err(entry_error("peer_unavailable", "The peer runtime is stopped."));
        }
        if peer_device_id.is_empty() {
            return Err(entry_error(
                "peer_message_invalid",
                "peer.send requires the counterparty peerDeviceId.",
            ));
        }
        self.client
            .send_message(peer_device_id, &plaintext, message_id)
            .await
    }

    /// Detach the channel; durable state is already on disk.
    pub async fn close(&self) {
        self.closed.set(true);
        *self.channel.session.borrow_mut() = None;
        self.channel.live.set(false);
        self.live_generation.set(self.live_generation.get() + 1);
        if let Some(task) = self.inbox_task.borrow_mut().take() {
            task.abort();
        }
        if let Some(task) = self.event_task.borrow_mut().take() {
            task.abort();
        }
        let _ = self.client.dispose().await;
    }

    fn record_event(&self, kind: &str, detail: &str) {
        let mut events = self.events.borrow_mut();
        events.push_back(PeerRuntimeEvent {
            at: now_iso(),
            kind: kind.to_string(),
            detail: detail.chars().take(256).collect(),
        });
        while events.len() > PEER_EVENT_LOG_LIMIT {
            events.pop_front();
        }
    }
}

/// Remove the whole per-connection peer store (revocation/uninstall).
pub fn remove_peer_store(store_dir: &std::path::Path) -> Result<()> {
    if store_dir.exists() {
        std::fs::remove_dir_all(store_dir).map_err(|_| {
            entry_error("peer_store_error", "The peer store directory could not be removed.")
        })?;
    }
    Ok(())
}

pub struct EntryPeerRuntimeOptions {
    pub store_dir: std::path::PathBuf,
    pub route: PeerRouteIdentity,
    /// Pairing-authenticated remote Signal identity; presence requires the
    /// local identity to already exist (fail-closed after pairing).
    pub paired_peer_identity: Option<PairedSignalIdentity>,
    pub client_store: Rc<dyn PeerClientStore>,
    pub directory: Option<Rc<dyn super::client::PeerDeviceDirectory>>,
    pub dispatch: Option<PeerDispatchHandler>,
    pub event_forward: Option<mpsc::UnboundedSender<PeerClientEvent>>,
}

fn describe_event(event: &PeerClientEvent) -> (Option<&'static str>, String) {
    match event {
        PeerClientEvent::RequiresRePair { peer_id, source, detail } => (
            Some("requiresRePair"),
            format!("{peer_id} ({source}): {detail}"),
        ),
        PeerClientEvent::Conflict { message_id, peer_device_id } => (
            Some("conflict"),
            format!("{message_id} → {peer_device_id}"),
        ),
        PeerClientEvent::BundleRefused { refusal } => {
            (Some("bundleRefused"), refusal.clone())
        }
        PeerClientEvent::PeerPresence(p) => (
            Some("peerPresence"),
            format!("{}: {}", p.peer_device_id, p.state),
        ),
        PeerClientEvent::DispatchDeferred { message_id, sender_device_id } => (
            Some("dispatchDeferred"),
            format!("{message_id}@{sender_device_id}"),
        ),
        PeerClientEvent::Error { code, detail } => {
            (Some("error"), format!("{code}: {detail}"))
        }
        _ => (None, String::new()),
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
