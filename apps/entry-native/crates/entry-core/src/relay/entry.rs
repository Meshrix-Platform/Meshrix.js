//! Entry-side session + inner-channel composition — port of
//! `entry-session.ts` `EntryRelaySession`.
//!
//! Owns one `PrivateRelaySession` driving the WSS transport, the bounded
//! relay-frame pump, the pinned inner mutual-TLS channel and the request
//! channel over it. Reconnect rebuilds pump, TLS handshake and request
//! channel — never replaying acknowledged frames and never resurrecting a
//! pending request as a second dispatch.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use crate::b64::b64u_encode;
use crate::error::{entry_error, EntryError, Result};
use crate::wire::recovery::{create_operation_query, parse_operation_status, recovery_message_kind};
use crate::wire::session::RelayAdmission;

use super::frame_io::{frame_io_default, FrameIoHandle};
use super::inner_channel::{spawn_inner_channel, InnerChannelHandle, INNER_LINE_MAX_BYTES};
use super::inner_tls::{inner_server_name, pinned_connector};
use super::session::{PrivateRelaySession, SessionEvent, TransportPort};
use super::transport::{WssRelayTransport, WsEvent, WsSink};

pub const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 30_000;
pub const DEFAULT_OPERATION_QUERY_TIMEOUT_MS: u64 = 15_000;
pub const DEFAULT_HANDSHAKE_TIMEOUT_MS: u64 = 15_000;
const TICK: Duration = Duration::from_millis(100);
static CHANNEL_IDS: AtomicU64 = AtomicU64::new(1);

/// The entry's paired device credential plus the pinned endpoint SPKI pins.
#[derive(Clone)]
pub struct InnerTlsOptions {
    /// DER self-signed device certificate issued for the enrolled identity.
    pub cert_der: Vec<u8>,
    /// PKCS#8 DER private key material from the custody layer.
    pub key_der: Vec<u8>,
    /// Endpoint SPKI pin set (sha256 SPKI, base64url).
    pub pinned_peer_spki: Vec<String>,
    pub handshake_timeout: Duration,
}

#[derive(Clone)]
pub struct EntrySessionOptions {
    /// `/session/:tenantId/:routeId` relay URL.
    pub relay_session_url: String,
    /// Extra upgrade headers (e.g. `authorization: Bearer …`).
    pub headers: Vec<(String, String)>,
    pub allow_insecure_loopback: bool,
    pub admission: RelayAdmission,
    pub purpose: String,
    pub inner_tls: InnerTlsOptions,
    /// `None` waits for a real relay/channel outcome or explicit
    /// cancellation (TS `connectTimeoutMs: null`).
    pub connect_timeout: Option<Duration>,
    /// Principal + authority generation the endpoint binds operation
    /// queries to.
    pub operation_principal: Option<(String, u64)>,
    pub operation_query_timeout: Duration,
    pub max_pending_requests: usize,
    pub max_inner_line_bytes: usize,
    pub request_timeout: Option<Duration>,
    pub max_ws_message_bytes: usize,
}

impl EntrySessionOptions {
    pub fn forward(relay_session_url: impl Into<String>, admission: RelayAdmission, inner_tls: InnerTlsOptions) -> Self {
        Self {
            relay_session_url: relay_session_url.into(),
            headers: Vec::new(),
            allow_insecure_loopback: false,
            admission,
            purpose: "forward".into(),
            inner_tls,
            connect_timeout: Some(Duration::from_millis(DEFAULT_CONNECT_TIMEOUT_MS)),
            operation_principal: None,
            operation_query_timeout: Duration::from_millis(DEFAULT_OPERATION_QUERY_TIMEOUT_MS),
            max_pending_requests: 256,
            max_inner_line_bytes: INNER_LINE_MAX_BYTES,
            request_timeout: None,
            max_ws_message_bytes: 4 * 1024 * 1024,
        }
    }
}

/// Session surface for the UI/CLI — mirrors the TS handler vocabulary.
#[derive(Debug, Clone)]
pub enum EntrySessionEvent {
    /// The relay admitted the forward session — the peer lane gate opens.
    Admitted,
    /// Pinned inner channel is live; the session accepts work.
    Ready,
    /// Relay rejected the admission.
    Rejected { reason: String, retryable: bool },
    /// Endpoint route status changed.
    RouteStatus { route_id: String, state: String, generation: u64 },
    /// Relay session closed (peer close, transport drop or local close).
    Closed { reason: String },
    /// The inner TLS handshake or channel failed; the session is closing.
    ChannelLost { code: String, message: String },
    /// An endpoint operation ledger answer arrived.
    OperationStatus(Value),
}

#[derive(Debug, Clone)]
pub struct SessionStateView {
    pub session_state: String,
    pub route_state: String,
    pub session_id: Option<String>,
    /// True only when the relay reports the route reachable AND an inner
    /// channel is live — `acceptsNewWork` in TS.
    pub accepts_new_work: bool,
}

/// Inbound side of a stub session's peer lane — test injection point for
/// peer-schema objects arriving "from the relay".
#[doc(hidden)]
#[derive(Clone)]
pub struct PeerLaneStub {
    peer_tx: mpsc::UnboundedSender<Value>,
    events_tx: watch::Sender<EntrySessionEvent>,
    state: Arc<Mutex<SessionStateView>>,
}

impl PeerLaneStub {
    /// Inject one peer-schema wire object as if the relay delivered it.
    pub fn inject(&self, message: Value) {
        let _ = self.peer_tx.send(message);
    }

    /// Emit `Admitted` — opens the send gate exactly like relay admission.
    pub fn admit(&self) {
        self.state.lock().unwrap().accepts_new_work = true;
        let _ = self.events_tx.send(EntrySessionEvent::Admitted);
    }

    /// Emit `Closed` — the transport/lifecycle loss signal to the runtime.
    pub fn close(&self, reason: &str) {
        self.state.lock().unwrap().accepts_new_work = false;
        let _ = self.events_tx.send(EntrySessionEvent::Closed {
            reason: reason.to_string(),
        });
    }
}

enum Command {
    /// Transport reopen + session-reconnect + wait ready.
    Reopen { revocation_revision: Option<u64>, reply: oneshot::Sender<Result<()>> },
    Request { message: Value, reply: oneshot::Sender<Result<Value>> },
    QueryOperation { operation_id: String, reply: oneshot::Sender<Result<Value>> },
    /// A peer-schema wire object offered to the relay forward stream —
    /// admitted sessions only, like `createPeerSessionChannel`'s gate.
    SendPeer { message: Value, reply: oneshot::Sender<Result<()>> },
    Close { reason: String },
}

/// Notes async subsystems post back into the actor — handshake results and
/// channel losses arrive as one-ownership events, never cross-task mutation.
enum ActorNote {
    HandshakeDone(std::result::Result<InnerChannelHandle, EntryError>),
    ChannelLost { id: u64, error: EntryError },
}

pub struct EntrySession {
    cmd_tx: mpsc::UnboundedSender<Command>,
    events: watch::Receiver<EntrySessionEvent>,
    state: Arc<Mutex<SessionStateView>>,
    /// Peer-schema inbound lane; `take_peer_inbox` detaches the receiver for
    /// the peer runtime that owns demux'd messages.
    peer_inbox: Arc<Mutex<Option<mpsc::UnboundedReceiver<Value>>>>,
}

impl EntrySession {
    /// Open the session and wait for the pinned inner channel to come up.
    pub async fn connect(options: EntrySessionOptions) -> Result<Self> {
        let (transport, ws_events) = WssRelayTransport::spawn(
            &options.relay_session_url,
            options.headers.clone(),
            options.allow_insecure_loopback,
            options.max_ws_message_bytes,
        )?;
        let session = PrivateRelaySession::new(transport.sink(), options.admission.clone(), &options.purpose);
        let (events_tx, events_rx) = watch::channel(EntrySessionEvent::Closed { reason: "initiated".into() });
        let state = Arc::new(Mutex::new(SessionStateView {
            session_state: session.state().to_string(),
            route_state: session.route_state().to_string(),
            session_id: None,
            accepts_new_work: false,
        }));
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let (peer_tx, peer_rx) = mpsc::unbounded_channel();
        let peer_inbox = Arc::new(Mutex::new(Some(peer_rx)));
        let (ready_tx, ready_rx) = oneshot::channel::<Result<()>>();
        let connect_timeout = options.connect_timeout;
        let actor = Actor {
            transport,
            session,
            ws_events,
            pump: None,
            pump_drain: None,
            channel: None,
            bound_peer_session_id: None,
            peer_detached: false,
            peer_tx,
            handshake_pending: false,
            ready_waiters: vec![ready_tx],
            status_queries: HashMap::new(),
            note_tx: None,
            note_rx: mpsc::unbounded_channel().1,
            events_tx,
            state: state.clone(),
            cmd_rx,
            opening: true,
            options,
        };
        actor.spawn_with_notes();
        match connect_timeout {
            Some(budget) => match tokio::time::timeout(budget, ready_rx).await {
                Ok(Ok(result)) => result?,
                Ok(Err(_)) => {
                    return Err(entry_error("entry_session_closed", "The entry session actor is gone."));
                }
                Err(_) => {
                    let session_state = state.lock().unwrap().session_state.clone();
                    return Err(entry_error(
                        "entry_connect_timeout",
                        format!("The inner channel did not establish within the connect budget (session state: {session_state})."),
                    )
                    .with_effect("not_started"));
                }
            },
            None => match ready_rx.await {
                Ok(result) => result?,
                Err(_) => {
                    return Err(entry_error("entry_session_closed", "The entry session actor is gone."));
                }
            },
        }
        Ok(Self { cmd_tx, events: events_rx, state, peer_inbox })
    }

    /// Session-level reconnect per the wire contract: the transport is
    /// re-established first, then session-reconnect carries the preserved
    /// cursors and a fresh revocation revision.
    pub async fn reconnect(&self, revocation_revision: Option<u64>) -> Result<()> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::Reopen { revocation_revision, reply: reply_tx })
            .map_err(|_| entry_error("entry_session_closed", "The entry session actor is gone."))?;
        reply_rx
            .await
            .map_err(|_| entry_error("entry_session_closed", "The entry session actor is gone."))?
    }

    /// Forward one JSON-RPC-shaped inner request; resolves with the endpoint
    /// outcome (or null).
    pub async fn request(&self, message: Value) -> Result<Value> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::Request { message, reply: reply_tx })
            .map_err(|_| entry_error("entry_session_closed", "The entry session actor is gone."))?;
        reply_rx
            .await
            .map_err(|_| entry_error("entry_session_closed", "The entry session actor is gone."))?
    }

    /// Wire-level operation status query over the relay recovery channel —
    /// the endpoint ledger's own record, never a local guess.
    pub async fn query_operation(&self, operation_id: &str) -> Result<Value> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::QueryOperation {
                operation_id: operation_id.to_string(),
                reply: reply_tx,
            })
            .map_err(|_| entry_error("entry_session_closed", "The entry session actor is gone."))?;
        reply_rx
            .await
            .map_err(|_| entry_error("entry_session_closed", "The entry session actor is gone."))?
    }

    pub fn state(&self) -> SessionStateView {
        self.state.lock().unwrap().clone()
    }

    /// True only when the relay reports the route reachable AND an inner
    /// channel is live — `acceptsNewWork` in TS.
    pub fn accepts_new_work(&self) -> bool {
        self.state.lock().unwrap().accepts_new_work
    }

    pub fn events(&self) -> watch::Receiver<EntrySessionEvent> {
        self.events.clone()
    }

    /// Best-effort close; pending requests settle by dispatch evidence.
    pub fn close(&self, reason: &str) {
        let _ = self.cmd_tx.send(Command::Close { reason: reason.to_string() });
    }

    /// Offer one peer-schema wire object to the relay forward stream.
    /// Fails fast with `peer_channel_not_admitted` while the session is down —
    /// `createPeerSessionChannel`'s send gate in TS.
    pub async fn send_peer(&self, message: Value) -> Result<()> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::SendPeer { message, reply: reply_tx })
            .map_err(|_| entry_error("entry_session_closed", "The entry session actor is gone."))?;
        reply_rx
            .await
            .map_err(|_| entry_error("entry_session_closed", "The entry session actor is gone."))?
    }

    /// Detach the peer-schema inbound lane for the peer runtime that owns
    /// demux'd relay objects. `None` after the first take.
    pub fn take_peer_inbox(&self) -> Option<mpsc::UnboundedReceiver<Value>> {
        self.peer_inbox.lock().unwrap().take()
    }

    #[doc(hidden)]
    /// Test seam — a relay-free `EntrySession` whose `send_peer` writes wire
    /// objects into the returned `wire_rx` and whose inbound peer lane is fed
    /// through `PeerLaneStub::inject`. Exposed for host-level integration
    /// tests only; production sessions come from `EntrySession::connect`.
    pub fn stub_for_tests() -> (
        Self,
        mpsc::UnboundedReceiver<Value>,
        PeerLaneStub,
    ) {
        let (events_tx, events_rx) =
            watch::channel(EntrySessionEvent::Closed { reason: "stub".into() });
        let state = Arc::new(Mutex::new(SessionStateView {
            session_state: "stub".into(),
            route_state: "stub".into(),
            session_id: Some("stub".into()),
            accepts_new_work: false,
        }));
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel();
        let (peer_tx, peer_rx) = mpsc::unbounded_channel();
        let (wire_tx, wire_rx) = mpsc::unbounded_channel();
        let state2 = state.clone();
        let events_tx2 = events_tx.clone();
        tokio::spawn(async move {
            while let Some(cmd) = cmd_rx.recv().await {
                match cmd {
                    Command::SendPeer { message, reply } => {
                        let admitted = state2.lock().unwrap().accepts_new_work;
                        let result = if admitted {
                            wire_tx.send(message).map_err(|_| {
                                entry_error(
                                    "peer_channel_not_admitted",
                                    "The peer channel is not admitted.",
                                )
                            })
                        } else {
                            Err(entry_error(
                                "peer_channel_not_admitted",
                                "The peer channel is not admitted.",
                            ))
                        };
                        let _ = reply.send(result);
                    }
                    Command::Close { reason } => {
                        {
                            let mut s = state2.lock().unwrap();
                            s.accepts_new_work = false;
                            s.session_state = "closed".into();
                        }
                        let _ = events_tx2.send(EntrySessionEvent::Closed { reason });
                    }
                    Command::Request { reply, .. } => {
                        let _ = reply.send(Err(entry_error(
                            "entry_session_closed",
                            "The stub session serves peer messages only.",
                        )));
                    }
                    Command::QueryOperation { reply, .. } => {
                        let _ = reply.send(Err(entry_error(
                            "entry_session_closed",
                            "The stub session serves peer messages only.",
                        )));
                    }
                    Command::Reopen { reply, .. } => {
                        let _ = reply.send(Err(entry_error(
                            "entry_session_closed",
                            "The stub session serves peer messages only.",
                        )));
                    }
                }
            }
        });
        (
            Self {
                cmd_tx,
                events: events_rx,
                state: state.clone(),
                peer_inbox: Arc::new(Mutex::new(Some(peer_rx))),
            },
            wire_rx,
            PeerLaneStub { peer_tx, events_tx, state },
        )
    }
}

struct Actor {
    transport: WssRelayTransport,
    session: PrivateRelaySession<WsSink>,
    ws_events: mpsc::UnboundedReceiver<WsEvent>,
    pump: Option<FrameIoHandle>,
    pump_drain: Option<mpsc::Receiver<Vec<u8>>>,
    channel: Option<InnerChannelHandle>,
    bound_peer_session_id: Option<String>,
    peer_detached: bool,
    /// Peer-schema wire objects demux'd out of the session driver — the peer
    /// runtime drains this lane; relay bytes are ciphertext envelopes only.
    peer_tx: mpsc::UnboundedSender<Value>,
    handshake_pending: bool,
    ready_waiters: Vec<oneshot::Sender<Result<()>>>,
    status_queries: HashMap<String, (oneshot::Sender<Result<Value>>, Instant)>,
    note_tx: Option<mpsc::UnboundedSender<ActorNote>>,
    note_rx: mpsc::UnboundedReceiver<ActorNote>,
    events_tx: watch::Sender<EntrySessionEvent>,
    state: Arc<Mutex<SessionStateView>>,
    cmd_rx: mpsc::UnboundedReceiver<Command>,
    /// True until the first ws Open arrives — a socket dying before open
    /// settles as entry_transport_open_failed, not a session close.
    opening: bool,
    options: EntrySessionOptions,
}

impl Actor {
    /// Wire the note channel (needs &mut for construction-time wiring) and
    /// start the task.
    fn spawn_with_notes(mut self) {
        let (note_tx, note_rx) = mpsc::unbounded_channel();
        self.note_tx = Some(note_tx);
        self.note_rx = note_rx;
        tokio::spawn(async move { self.run().await });
    }

    fn publish_state(&self) {
        let mut view = self.state.lock().unwrap();
        view.session_state = self.session.state().to_string();
        view.route_state = self.session.route_state().to_string();
        view.session_id = self.session.session_id().map(|s| s.to_string());
        view.accepts_new_work = self.session.accepts_new_work() && self.channel.is_some();
    }

    fn settle_ready(&mut self, result: Result<()>) {
        for waiter in self.ready_waiters.drain(..) {
            let _ = waiter.send(result.clone());
        }
    }

    fn fail_status_queries(&mut self, error: &EntryError) {
        for (_, (reply, _)) in self.status_queries.drain() {
            let _ = reply.send(Err(error.clone()));
        }
    }

    fn teardown_channel(&mut self, code: &str) {
        if let Some(channel) = self.channel.take() {
            channel.close(code);
        }
        self.handshake_pending = false;
        self.bound_peer_session_id = None;
        if let Some(pump) = self.pump.take() {
            pump.close();
        }
        self.pump_drain = None;
    }

    /// Fires for both session-admitted and session-restored: a restored
    /// session rebuilds the whole inner channel so acknowledged cursors are
    /// honored and no stale TLS state survives into the new generation.
    fn establish_channel(&mut self) {
        self.teardown_channel("entry_channel_replaced");
        let (io, handle, drain) = frame_io_default();
        self.pump = Some(handle);
        self.pump_drain = Some(drain);
        self.handshake_pending = true;
        let tls = self.options.inner_tls.clone();
        let max_pending = self.options.max_pending_requests;
        let max_line = self.options.max_inner_line_bytes;
        let request_timeout = self.options.request_timeout;
        let note_tx = self.note_tx.clone().unwrap();
        let channel_id = CHANNEL_IDS.fetch_add(1, Ordering::Relaxed);
        tokio::spawn(async move {
            let connect_result = async {
                let (connector, _pin) =
                    pinned_connector(tls.pinned_peer_spki.clone(), tls.cert_der, tls.key_der)?;
                tokio::time::timeout(tls.handshake_timeout, connector.connect(inner_server_name(), io))
                    .await
                    .map_err(|_| {
                        entry_error("entry_handshake_failed", "The pinned inner TLS handshake timed out.")
                            .with_effect("not_started")
                    })?
                    .map_err(|e| {
                        entry_error("entry_handshake_failed", format!("The pinned inner TLS handshake failed: {e}"))
                            .with_effect("not_started")
                    })
            }
            .await;
            let result = connect_result.map(|stream| {
                let note_lost = note_tx.clone();
                spawn_inner_channel(
                    stream,
                    channel_id,
                    max_pending,
                    max_line,
                    request_timeout,
                    Box::new(move |error| {
                        let _ = note_lost.send(ActorNote::ChannelLost { id: channel_id, error });
                    }),
                )
            });
            let _ = note_tx.send(ActorNote::HandshakeDone(result));
        });
    }

    /// Feed one decoded transport message into the session driver, then run
    /// the emitted events. Returns the routed wire kind. Peer-schema objects
    /// bypass the driver entirely — `isPeerSchemaMessage` in the TS host.
    fn handle_message(&mut self, message: &Value) -> Option<String> {
        if crate::peer::wire::is_peer_schema_message(message) {
            let kind = crate::peer::wire::peer_message_kind(message).unwrap_or("peer").to_string();
            let _ = self.peer_tx.send(message.clone());
            return Some(kind);
        }
        let rebuild_needed = std::cell::Cell::new(false);
        let events;
        {
            let pump = self.pump.clone();
            let bound = &mut self.bound_peer_session_id;
            let needed = &rebuild_needed;
            let mut deliver = move |payload: &str, _message_id: &str, peer_session_id: &str| -> bool {
                // The relay forwards the sender's sessionId verbatim. An
                // endpoint session replacement means a fresh TLS endpoint on
                // its side — the channel bound to the previous session
                // answers nothing, so rebuild before feeding new records.
                if bound.as_deref() != Some(peer_session_id) {
                    if bound.is_some() {
                        needed.set(true);
                    }
                    *bound = Some(peer_session_id.to_string());
                }
                let fed = pump.as_ref().is_some_and(|h| h.feed(payload));
                tracing::debug!(fed, peer = %peer_session_id, bytes = %payload.len(), "entry inbound frame");
                fed
            };
            let handled = self.session.handle_message(message, &mut deliver);
            events = handled.map(|(kind, events)| (kind.to_string(), events));
        }
        if rebuild_needed.get() {
            self.establish_channel();
        }
        let (kind, events) = events?;
        for event in events {
            match event {
                SessionEvent::Admitted(_) => {
                    self.establish_channel();
                    let _ = self.events_tx.send(EntrySessionEvent::Admitted);
                }
                SessionEvent::Rejected { reason, retryable } => {
                    let error = entry_error(
                        "entry_admission_rejected",
                        format!("The relay rejected the session admission ({reason})."),
                    )
                    .with_effect("not_started");
                    self.settle_ready(Err(error));
                    let _ = self.events_tx.send(EntrySessionEvent::Rejected { reason, retryable });
                }
                SessionEvent::RouteStatus { route_id, state, generation } => {
                    if state == "unreachable" {
                        // The endpoint session is gone — the inner channel is
                        // dead weight. Settle waiters honestly instead of
                        // burning the budget.
                        self.peer_detached = true;
                        self.teardown_channel("entry_endpoint_detached");
                        self.settle_ready(Err(entry_error(
                            "endpoint_unreachable",
                            "The private endpoint detached from the route.",
                        )
                        .with_effect("not_started")));
                    } else if state == "reachable" && self.peer_detached {
                        // A fresh endpoint session re-handshakes from zero.
                        self.peer_detached = false;
                        if self.session.state() == "admitted" || self.session.state() == "streaming" {
                            self.establish_channel();
                        }
                    }
                    let _ = self.events_tx.send(EntrySessionEvent::RouteStatus { route_id, state, generation });
                }
                SessionEvent::Closed { reason } => {
                    self.teardown_channel("entry_session_closed");
                    let error = entry_error(
                        "entry_session_closed",
                        format!("The relay session closed ({reason})."),
                    )
                    .with_effect("not_started");
                    self.settle_ready(Err(error));
                    self.fail_status_queries(&entry_error(
                        "entry_session_closed",
                        "The relay session closed before the operation status arrived.",
                    )
                    .with_effect("unknown"));
                    let _ = self.events_tx.send(EntrySessionEvent::Closed { reason });
                }
                SessionEvent::Frame { .. } => {}
            }
        }
        Some(kind)
    }

    /// The underlying socket died without a session-close: pending requests
    /// settle by dispatch evidence, then the driver closes so reconnect()
    /// becomes valid.
    fn handle_transport_close(&mut self, opening_failure: bool, detail: &str) {
        self.teardown_channel("entry_transport_lost");
        if opening_failure {
            self.settle_ready(Err(entry_error(
                "entry_transport_open_failed",
                format!("The relay socket failed before it opened ({detail})."),
            )
            .with_effect("unknown")));
        } else {
            self.settle_ready(Err(entry_error(
                "entry_transport_lost",
                "The relay transport dropped before the channel established.",
            )
            .with_effect("unknown")));
        }
        self.fail_status_queries(&entry_error(
            "entry_transport_lost",
            "The relay transport dropped before the operation status arrived.",
        )
        .with_effect("unknown"));
        let _ = self.session.transport_lost();
        let _ = self.events_tx.send(EntrySessionEvent::Closed { reason: detail.to_string() });
    }

    async fn run(mut self) {
        // Kick the wire: once the socket opens, session.open() sends the
        // admission request — equivalent to awaiting transport.ready then
        // open() in TS.
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                cmd = self.cmd_rx.recv() => {
                    let Some(cmd) = cmd else { break };
                    match cmd {
                        Command::Reopen { revocation_revision, reply } => {
                            match self.transport.reopen().await {
                                Ok(()) => {
                                    match self.session.reconnect(revocation_revision, None) {
                                        Ok(true) => {
                                            self.ready_waiters.push(reply);
                                        }
                                        Ok(false) => {
                                            let _ = reply.send(Err(entry_error(
                                                "entry_session_state",
                                                format!("A session in state \"{}\" cannot reconnect.", self.session.state()),
                                            )));
                                        }
                                        Err(e) => {
                                            let _ = reply.send(Err(e));
                                        }
                                    }
                                }
                                Err(e) => {
                                    let _ = reply.send(Err(e));
                                }
                            }
                        }
                        Command::Request { message, reply } => {
                            match self.channel.clone() {
                                Some(channel) if !channel.is_closed() => {
                                    tokio::spawn(async move {
                                        let result = channel.request(message).await;
                                        let _ = reply.send(result);
                                    });
                                }
                                _ => {
                                    let _ = reply.send(Err(entry_error(
                                        "endpoint_unreachable",
                                        "The private endpoint is unreachable; no inner channel is established.",
                                    )
                                    .with_effect("not_started")));
                                }
                            }
                        }
                        Command::QueryOperation { operation_id, reply } => {
                            match &self.options.operation_principal {
                                None => {
                                    let _ = reply.send(Err(entry_error(
                                        "entry_operation_principal_missing",
                                        "An operation principal is required to bind recovery queries.",
                                    )));
                                }
                                Some((principal_ref, generation)) => {
                                    let deadline = Instant::now() + self.options.operation_query_timeout;
                                    self.status_queries.insert(operation_id.clone(), (reply, deadline));
                                    let query = create_operation_query(&operation_id, principal_ref, *generation);
                                    if self.transport.sink().send(&query).is_err() {
                                        let (reply, _) = self.status_queries.remove(&operation_id).unwrap();
                                        let _ = reply.send(Err(entry_error(
                                            "endpoint_unreachable",
                                            "The operation query could not be sent to the relay.",
                                        )
                                        .with_effect("unknown")));
                                    }
                                }
                            }
                        }
                        Command::SendPeer { message, reply } => {
                            // `createPeerSessionChannel` admission gate: the
                            // peer client's in-flight slot must never wait on
                            // a channel that cannot answer.
                            let admitted = self.session.state() == "admitted"
                                || self.session.state() == "streaming";
                            let result = if !admitted {
                                Err(crate::peer::wire::peer_channel_not_admitted_error())
                            } else {
                                self.transport.sink().send(&message).map_err(|_| {
                                    crate::peer::wire::peer_channel_not_admitted_error()
                                })
                            };
                            let _ = reply.send(result);
                        }
                        Command::Close { reason } => {
                            self.teardown_channel("entry_session_closed");
                            self.settle_ready(Err(entry_error(
                                "entry_session_closed",
                                "The entry session was closed.",
                            )
                            .with_effect("not_started")));
                            let _ = self.session.close(&reason);
                            self.transport.close();
                            self.fail_status_queries(&entry_error(
                                "entry_session_closed",
                                "The entry session was closed before the operation status arrived.",
                            )
                            .with_effect("unknown"));
                            self.publish_state();
                            break;
                        }
                    }
                }
                ws = self.ws_events.recv() => {
                    match ws {
                        Some(WsEvent::Open) => {
                            self.opening = false;
                            if self.session.state() == "initiated" {
                                match self.session.open() {
                                    Ok(true) => {}
                                    Ok(false) => {
                                        self.settle_ready(Err(entry_error(
                                            "entry_session_state",
                                            format!("A session in state \"{}\" cannot open.", self.session.state()),
                                        )));
                                    }
                                    Err(e) => self.settle_ready(Err(e)),
                                }
                            } else {
                                // A reopened socket: the driver was already
                                // put in `reconnecting` by reconnect(); the
                                // session-reconnect frame was sent then.
                            }
                        }
                        Some(WsEvent::Message(message)) => {
                            let kind = self.handle_message(&message);
                            let kind = kind.or_else(|| {
                                recovery_message_kind(&message).map(String::from)
                            });
                            if kind.as_deref() == Some("operation-status") {
                                if let Some(status) = parse_operation_status(&message) {
                                    let _ = self.events_tx.send(EntrySessionEvent::OperationStatus(message.clone()));
                                    if let Some((reply, _)) = self.status_queries.remove(&status.operation_id) {
                                        let _ = reply.send(Ok(message.clone()));
                                    }
                                }
                            }
                            self.publish_state();
                        }
                        Some(WsEvent::Closed { code, reason }) => {
                            self.handle_transport_close(self.opening, &format!("code {code}: {reason}"));
                            self.publish_state();
                        }
                        Some(WsEvent::ProtocolError(_e)) => {
                            // Mirrors onProtocolError: malformed frames are
                            // dropped, never folded into session state.
                        }
                        None => {
                            self.handle_transport_close(self.opening, "transport task ended");
                            self.publish_state();
                            break;
                        }
                    }
                }
                drain = async {
                    match self.pump_drain.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    match drain {
                        Some(record) => {
                            let payload = b64u_encode(&record);
                            match self.session.send_payload(&payload, None, false) {
                                Ok(true) => {
                                    tracing::debug!(bytes = %record.len(), "entry outbound frame sent");
                                }
                                Ok(false) | Err(_) => {
                                    // Refused (backpressure/oversize/not
                                    // streaming) or transport lost: the TLS
                                    // write side must see a failed socket —
                                    // drop the drain so FrameIo writes break
                                    // and the channel reports honestly.
                                    self.pump_drain = None;
                                    self.teardown_channel("relay_backpressure");
                                }
                            }
                        }
                        None => { self.pump_drain = None; }
                    }
                }
                note = self.note_rx.recv() => {
                    match note {
                        Some(ActorNote::HandshakeDone(result)) => {
                            self.handshake_pending = false;
                            tracing::debug!(ok = result.is_ok(), "entry inner TLS handshake done");
                            match result {
                                Ok(channel) => {
                                    self.channel = Some(channel);
                                    // Frames the driver queued while the
                                    // channel was down can drain now.
                                    let pump = self.pump.clone();
                                    let bound = &mut self.bound_peer_session_id;
                                    let mut deliver = move |payload: &str, _mid: &str, peer: &str| -> bool {
                                        if bound.as_deref() != Some(peer) { *bound = Some(peer.to_string()); }
                                        pump.as_ref().is_some_and(|h| h.feed(payload))
                                    };
                                    let _ = self.session.flush_inbound(&mut deliver);
                                    self.publish_state();
                                    let _ = self.events_tx.send(EntrySessionEvent::Ready);
                                    self.settle_ready(Ok(()));
                                }
                                Err(e) => {
                                    self.teardown_channel("entry_handshake_failed");
                                    self.settle_ready(Err(e.clone()));
                                    let _ = self.events_tx.send(EntrySessionEvent::ChannelLost {
                                        code: e.code.clone(),
                                        message: e.message.clone(),
                                    });
                                    // The peer is not the pinned endpoint (or
                                    // the channel was poisoned): close the
                                    // session so the next work attempt goes
                                    // through a fresh admission.
                                    let _ = self.session.fail_session("protocol_error");
                                }
                            }
                        }
                        Some(ActorNote::ChannelLost { id, error }) => {
                            if self.channel.as_ref().is_some_and(|c| c.id == id) {
                                self.teardown_channel("entry_channel_lost");
                                let _ = self.events_tx.send(EntrySessionEvent::ChannelLost {
                                    code: error.code.clone(),
                                    message: error.message.clone(),
                                });
                            }
                        }
                        None => {}
                    }
                }
                _ = tick.tick() => {
                    let now = Instant::now();
                    let expired: Vec<String> = self.status_queries.iter()
                        .filter(|(_, (_, deadline))| *deadline <= now)
                        .map(|(k, _)| k.clone())
                        .collect();
                    for op_id in expired {
                        if let Some((reply, _)) = self.status_queries.remove(&op_id) {
                            let _ = reply.send(Err(entry_error(
                                "entry_operation_query_timeout",
                                "The endpoint did not answer the operation query; the status stays unknown.",
                            )
                            .with_effect("unknown")));
                        }
                    }
                }
            }
        }
        // Terminal sweep: anything still pending settles honestly.
        self.teardown_channel("entry_session_closed");
        self.settle_ready(Err(entry_error("entry_session_closed", "The entry session was closed.").with_effect("not_started")));
        self.fail_status_queries(&entry_error("entry_session_closed", "The entry session was closed.").with_effect("unknown"));
        self.publish_state();
    }
}
