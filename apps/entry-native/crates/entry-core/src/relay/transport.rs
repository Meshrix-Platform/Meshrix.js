//! WebSocket transport for the private-relay wire — port of
//! `createWssRelayTransport`.
//!
//! The relay channel carries versioned JSON text messages; the transport owns
//! socket lifecycle (open, stale-socket isolation, reconnect) and surfaces
//! only decoded objects to the session driver. `wss:` is required for
//! non-loopback relays; plaintext `ws:` only for literal loopback behind an
//! explicit opt-in.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async_tls_with_config, Connector, MaybeTlsStream, WebSocketStream};

use crate::error::{entry_error, EntryError, Result};
use crate::wire::common::is_plain_object;

use super::session::TransportPort;

pub const DEFAULT_MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug)]
pub enum WsEvent {
    /// The socket finished its handshake.
    Open,
    /// A decoded relay message object.
    Message(Value),
    /// The live socket closed or failed before an explicit transport close.
    Closed { code: u16, reason: String },
    /// A frame that was not a decodable relay message object.
    ProtocolError(EntryError),
}

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Send half surfaced to `PrivateRelaySession` as its `TransportPort`.
/// Internally swappable: `reopen()` installs the next socket's sender while
/// the session keeps the same handle.
#[derive(Clone)]
pub struct WsSink {
    inner: Arc<Mutex<Inner>>,
    open: Arc<AtomicBool>,
}

struct Inner {
    tx: Option<mpsc::UnboundedSender<String>>,
}

impl WsSink {
    fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(Inner { tx: None })), open: Arc::new(AtomicBool::new(false)) }
    }

    fn install(&self, tx: mpsc::UnboundedSender<String>) {
        self.inner.lock().unwrap().tx = Some(tx);
        self.open.store(true, Ordering::SeqCst);
    }

    fn mark_closed(&self) {
        self.open.store(false, Ordering::SeqCst);
        self.inner.lock().unwrap().tx = None;
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }
}

impl TransportPort for WsSink {
    fn send(&self, message: &Value) -> Result<()> {
        if !self.open.load(Ordering::SeqCst) {
            return Err(entry_error(
                "entry_transport_closed",
                "The relay socket is not open; the message was not sent.",
            ));
        }
        let text = serde_json::to_string(message)?;
        let tx = self.inner.lock().unwrap().tx.clone();
        match tx {
            Some(tx) => tx.send(text).map_err(|_| {
                entry_error("entry_transport_closed", "The relay socket is not open; the message was not sent.")
            }),
            None => Err(entry_error(
                "entry_transport_closed",
                "The relay socket is not open; the message was not sent.",
            )),
        }
    }

    fn close(&self) {
        self.mark_closed();
    }
}

enum TransportCmd {
    Reopen(oneshot::Sender<Result<()>>),
    Terminate,
}

/// WSS relay transport — spawn once, then drive `events` and pass `sink()`
/// to the session driver as its TransportPort. `Open`/`Closed` events mirror
/// the TypeScript socket lifecycle, including failures before first open.
pub struct WssRelayTransport {
    sink: WsSink,
    cmd_tx: mpsc::UnboundedSender<TransportCmd>,
    terminated: Arc<AtomicBool>,
}

impl WssRelayTransport {
    /// Validate the URL and start the socket task. The first event the caller
    /// receives is either `Open` or `Closed` (a socket that dies during the
    /// handshake reports Closed, never silence).
    pub fn spawn(
        url: &str,
        headers: Vec<(String, String)>,
        allow_insecure_loopback: bool,
        max_message_bytes: usize,
    ) -> Result<(Self, mpsc::UnboundedReceiver<WsEvent>)> {
        validate_url(url, allow_insecure_loopback)?;
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let sink = WsSink::new();
        let terminated = Arc::new(AtomicBool::new(false));
        TransportActor {
            url: url.to_string(),
            headers,
            sink: sink.clone(),
            events_tx,
            cmd_rx,
            max_message_bytes: max_message_bytes.max(1024),
        }
        .spawn();
        Ok((Self { sink, cmd_tx, terminated }, events_rx))
    }

    pub fn sink(&self) -> WsSink {
        self.sink.clone()
    }

    /// Re-establish the socket after a drop; refused after close().
    pub async fn reopen(&self) -> Result<()> {
        if self.terminated.load(Ordering::SeqCst) {
            return Err(entry_error("entry_transport_closed", "A closed transport cannot be reopened."));
        }
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(TransportCmd::Reopen(tx)).map_err(|_| {
            entry_error("entry_transport_closed", "A closed transport cannot be reopened.")
        })?;
        rx.await.map_err(|_| {
            entry_error("entry_transport_closed", "A closed transport cannot be reopened.")
        })?
    }

    pub fn close(&self) {
        if self.terminated.swap(true, Ordering::SeqCst) {
            return;
        }
        self.sink.mark_closed();
        let _ = self.cmd_tx.send(TransportCmd::Terminate);
    }
}

fn validate_url(url: &str, allow_insecure_loopback: bool) -> Result<()> {
    let parsed = url::Url::parse(url)
        .map_err(|_| entry_error("entry_transport_url_invalid", "The relay URL must use wss://."))?;
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err(entry_error(
            "entry_transport_url_invalid",
            "The relay URL must not carry credentials or fragments.",
        ));
    }
    match parsed.scheme() {
        "wss" => Ok(()),
        "ws" if allow_insecure_loopback => {
            let host = parsed.host_str().unwrap_or("").to_lowercase();
            if matches!(host.as_str(), "127.0.0.1" | "::1" | "[::1]" | "localhost") {
                Ok(())
            } else {
                Err(entry_error(
                    "entry_transport_insecure",
                    "Plaintext ws:// relays are only permitted for explicit loopback fixtures.",
                ))
            }
        }
        "ws" => Err(entry_error(
            "entry_transport_insecure",
            "Plaintext ws:// relays are only permitted for explicit loopback fixtures.",
        )),
        _ => Err(entry_error(
            "entry_transport_url_invalid",
            "The relay URL must use wss://.",
        )),
    }
}

struct TransportActor {
    url: String,
    headers: Vec<(String, String)>,
    sink: WsSink,
    events_tx: mpsc::UnboundedSender<WsEvent>,
    cmd_rx: mpsc::UnboundedReceiver<TransportCmd>,
    max_message_bytes: usize,
}

impl TransportActor {
    fn spawn(self) {
        tokio::spawn(async move { self.run().await });
    }

    async fn run(mut self) {
        tracing::debug!("relay transport actor started");
        loop {
            match self.connect_once().await {
                Ok(ws) => match self.drive_socket(ws).await {
                    SocketOutcome::ClosedByPeer => {
                        // A live socket dropped — the session driver owns the
                        // reconnect decision; wait for Reopen/Terminate.
                        self.sink.mark_closed();
                        match self.wait_cmd().await {
                            Some(TransportCmd::Reopen(reply)) => {
                                let _ = reply.send(Ok(()));
                            }
                            _ => break,
                        }
                    }
                    SocketOutcome::Reopen(reply) => {
                        let _ = reply.send(Ok(()));
                    }
                    SocketOutcome::Terminate => break,
                },
                Err(e) => {
                    tracing::warn!(code = %e.code, reason = %e.message, "relay transport connect failed");
                    let _ = self.events_tx.send(WsEvent::Closed { code: 1006, reason: e.message.clone() });
                    match self.wait_cmd().await {
                        Some(TransportCmd::Reopen(reply)) => {
                            let _ = reply.send(Err(e));
                        }
                        _ => break,
                    }
                }
            }
        }
        self.sink.mark_closed();
    }

    async fn connect_once(&self) -> Result<WsStream> {
        // `http::Request::into_client_request` is a pass-through — the caller
        // owns every handshake header. `ClientRequestBuilder` generates the
        // required WS headers (key, upgrade, version, host) and merges the
        // custom ones.
        let uri: http::Uri = self.url.parse().map_err(|e| {
            entry_error("entry_transport_url_invalid", format!("Relay URL rejected: {e}"))
        })?;
        let mut builder =
            tokio_tungstenite::tungstenite::client::ClientRequestBuilder::new(uri);
        for (name, value) in &self.headers {
            builder = builder.with_header(name.clone(), value.clone());
        }
        let request: Request = builder.into_client_request().map_err(|e| {
            entry_error("entry_transport_url_invalid", format!("Relay URL rejected: {e}"))
        })?;
        let connector = if self.url.starts_with("wss:") {
            let config = rustls::ClientConfig::builder()
                .with_root_certificates(rustls::RootCertStore::from_iter(
                    webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
                ))
                .with_no_client_auth();
            Some(Connector::Rustls(Arc::new(config)))
        } else {
            None
        };
        tracing::debug!(url = %self.url, "relay transport dialing");
        let (ws, _response) = connect_async_tls_with_config(request, None, false, connector)
            .await
            .map_err(|e| entry_error("entry_transport_open_failed", format!("The relay socket failed before it opened: {e}")))?;
        tracing::debug!("relay transport handshake complete");
        Ok(ws)
    }

    async fn drive_socket(&mut self, ws: WsStream) -> SocketOutcome {
        let (mut write, mut read) = ws.split();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        self.sink.install(out_tx);
        let _ = self.events_tx.send(WsEvent::Open);
        loop {
            tokio::select! {
                outgoing = out_rx.recv() => {
                    match outgoing {
                        Some(text) => {
                            if write.send(WsMessage::Text(text.into())).await.is_err() {
                                return SocketOutcome::ClosedByPeer;
                            }
                        }
                        None => {}
                    }
                }
                incoming = read.next() => {
                    match incoming {
                        Some(Ok(WsMessage::Text(text))) => {
                            match decode_relay_message(text.as_str(), self.max_message_bytes) {
                                Ok(value) => { let _ = self.events_tx.send(WsEvent::Message(value)); }
                                Err(e) => { let _ = self.events_tx.send(WsEvent::ProtocolError(e)); }
                            }
                        }
                        Some(Ok(WsMessage::Close(frame))) => {
                            let (code, reason) = frame
                                .map(|f| (u16::from(f.code), f.reason.to_string()))
                                .unwrap_or((1005, String::new()));
                            let _ = self.events_tx.send(WsEvent::Closed { code, reason });
                            return SocketOutcome::ClosedByPeer;
                        }
                        Some(Ok(_)) => {
                            let _ = self.events_tx.send(WsEvent::ProtocolError(entry_error(
                                "entry_transport_protocol",
                                "The relay sent a non-text message; the wire is JSON text only.",
                            )));
                        }
                        Some(Err(_)) => {
                            let _ = self.events_tx.send(WsEvent::Closed { code: 1006, reason: "socket error".into() });
                            return SocketOutcome::ClosedByPeer;
                        }
                        None => {
                            let _ = self.events_tx.send(WsEvent::Closed { code: 1006, reason: "socket closed".into() });
                            return SocketOutcome::ClosedByPeer;
                        }
                    }
                }
                cmd = self.cmd_rx.recv() => {
                    match cmd {
                        Some(TransportCmd::Reopen(reply)) => return SocketOutcome::Reopen(reply),
                        Some(TransportCmd::Terminate) | None => return SocketOutcome::Terminate,
                    }
                }
            }
        }
    }

    async fn wait_cmd(&mut self) -> Option<TransportCmd> {
        self.cmd_rx.recv().await
    }
}

enum SocketOutcome {
    ClosedByPeer,
    Reopen(oneshot::Sender<Result<()>>),
    Terminate,
}

fn decode_relay_message(text: &str, max_bytes: usize) -> Result<Value> {
    if text.len() > max_bytes {
        return Err(entry_error(
            "entry_transport_oversize",
            "The relay message exceeds the wire byte budget.",
        ));
    }
    let value: Value = serde_json::from_str(text).map_err(|e| {
        entry_error("entry_transport_protocol", "The relay message is not valid JSON.").caused_by(e)
    })?;
    if !is_plain_object(&value) {
        return Err(entry_error(
            "entry_transport_protocol",
            "The relay message is not a JSON object.",
        ));
    }
    Ok(value)
}
