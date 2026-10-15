//! Recovery-purpose relay channel — port of `recovery-channel.ts`.
//!
//! Opens a relay session with `purpose: "recover_device"` — the wire purpose
//! that admits only recovery kinds and never forwards opaque frames.
//! `round_trip` correlates one in-flight response at a time and settles ONLY
//! on a matching response, a transport/session failure, or an explicit
//! `close()` — a silent endpoint is never folded into a fabricated
//! `unreachable` outcome.

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::error::{entry_error, EntryError, Result};
use crate::wire::recovery::recovery_message_kind;
use crate::wire::session::RelayAdmission;

use super::address::relay_session_url;
use super::session::{PrivateRelaySession, SessionEvent, TransportPort};
use super::transport::{WssRelayTransport, WsEvent};

/// Which response kind settles a pending round-trip — `defaultAcceptsFor`.
#[derive(Debug, Clone)]
struct Accepts {
    kind: String,
    challenge_id: Option<String>,
}

impl Accepts {
    fn matches(&self, kind: &str, message: &Value) -> bool {
        if kind != self.kind {
            return false;
        }
        match &self.challenge_id {
            None => true,
            Some(expected) => {
                message.get("challengeId").and_then(|v| v.as_str()) == Some(expected.as_str())
            }
        }
    }
}

fn default_accepts_for(message: &Value) -> Accepts {
    let kind = message.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "recovery-request" => Accepts { kind: "recovery-challenge".into(), challenge_id: None },
        "recovery-proof" => Accepts {
            kind: "recovery-result".into(),
            challenge_id: message
                .get("challengeId")
                .and_then(|v| v.as_str())
                .map(String::from),
        },
        "rotation-begin" => Accepts { kind: "rotation-state".into(), challenge_id: None },
        _ => Accepts { kind: kind.to_string(), challenge_id: None },
    }
}

enum Command {
    RoundTrip { message: Value, reply: oneshot::Sender<Result<Value>> },
    Close,
}

/// One recovery wire exchange over one short-lived recover_device session.
/// The caller opens it, runs request/challenge/proof/result (or rotation
/// messages) and closes it — no inner TLS channel is ever established on
/// this purpose.
pub struct EntryRecoveryChannel {
    cmd_tx: mpsc::UnboundedSender<Command>,
}

impl EntryRecoveryChannel {
    /// Open the session and wait for relay admission. There is no local
    /// deadline: admission settles on the relay's admit/reject frame or on
    /// transport failure — never on silence.
    pub async fn connect(
        relay_service: &str,
        admission: &RelayAdmission,
        bearer: &str,
        allow_insecure_loopback: bool,
    ) -> Result<Self> {
        let url = relay_session_url(relay_service, &admission.tenant_id, &admission.route_id, allow_insecure_loopback)?;
        let headers = vec![("authorization".into(), format!("Bearer {bearer}"))];
        let (transport, ws_events) =
            WssRelayTransport::spawn(&url, headers, allow_insecure_loopback, 4 * 1024 * 1024)?;
        let session = PrivateRelaySession::new(transport.sink(), admission.clone(), "recover_device");
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let (open_tx, open_rx) = oneshot::channel::<Result<()>>();
        RecoveryActor {
            transport,
            session,
            ws_events,
            pending: Vec::new(),
            open_waiters: vec![open_tx],
            cmd_rx,
        }
        .spawn();
        match open_rx.await {
            Ok(result) => result?,
            Err(_) => {
                return Err(entry_error("entry_session_closed", "The recovery channel was closed.")
                    .with_effect("unknown"))
            }
        }
        Ok(Self { cmd_tx })
    }

    /// One request → one matching response. Settles on a matching response
    /// (however late), send failure, transport drop, session close, or
    /// `close()` — never on a silence budget.
    pub async fn round_trip(&self, message: &Value) -> Result<Value> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.cmd_tx
            .send(Command::RoundTrip { message: message.clone(), reply: reply_tx })
            .map_err(|_| {
                entry_error("entry_session_closed", "The recovery channel was closed.")
                    .with_effect("unknown")
            })?;
        reply_rx.await.map_err(|_| {
            entry_error("entry_session_closed", "The recovery channel was closed.")
                .with_effect("unknown")
        })?
    }

    pub fn close(&self) {
        let _ = self.cmd_tx.send(Command::Close);
    }
}

struct RecoveryActor {
    transport: WssRelayTransport,
    session: PrivateRelaySession<super::transport::WsSink>,
    ws_events: mpsc::UnboundedReceiver<WsEvent>,
    pending: Vec<(Accepts, oneshot::Sender<Result<Value>>)>,
    open_waiters: Vec<oneshot::Sender<Result<()>>>,
    cmd_rx: mpsc::UnboundedReceiver<Command>,
}

impl RecoveryActor {
    fn spawn(self) {
        tokio::spawn(async move { self.run().await });
    }

    fn settle_open(&mut self, result: Result<()>) {
        for waiter in self.open_waiters.drain(..) {
            let _ = waiter.send(result.clone());
        }
    }

    fn fail_all(&mut self, error: &EntryError) {
        for (_, reply) in self.pending.drain(..) {
            let _ = reply.send(Err(error.clone()));
        }
        self.settle_open(Err(error.clone()));
    }

    fn handle_events(&mut self, message: &Value) -> Option<String> {
        // Recovery sessions never carry frames — delivery always refuses.
        let mut deliver = |_: &str, _: &str, _: &str| -> bool { false };
        let handled = self.session.handle_message(message, &mut deliver);
        let Some((kind, events)) = handled else {
            return recovery_message_kind(message).map(String::from);
        };
        for event in events {
            match event {
                SessionEvent::Admitted(_) => self.settle_open(Ok(())),
                SessionEvent::Rejected { reason, .. } => {
                    self.fail_all(&entry_error(
                        "entry_admission_rejected",
                        format!("The relay rejected the recovery session admission ({reason})."),
                    )
                    .with_effect("not_started"));
                }
                SessionEvent::Closed { reason } => {
                    self.fail_all(&entry_error(
                        "entry_session_closed",
                        format!("The recovery session closed ({reason})."),
                    )
                    .with_effect("unknown"));
                }
                _ => {}
            }
        }
        Some(kind.to_string())
    }

    async fn run(mut self) {
        loop {
            tokio::select! {
                cmd = self.cmd_rx.recv() => {
                    let Some(cmd) = cmd else { break };
                    match cmd {
                        Command::RoundTrip { message, reply } => {
                            let accepts = default_accepts_for(&message);
                            self.pending.push((accepts, reply));
                            if self.transport.sink().send(&message).is_err() {
                                // The send failed — settle this request only.
                                let (_, reply) = self.pending.pop().unwrap();
                                let _ = reply.send(Err(entry_error(
                                    "endpoint_unreachable",
                                    "The recovery message could not be sent to the relay.",
                                )
                                .with_effect("not_started")));
                            }
                        }
                        Command::Close => {
                            self.fail_all(&entry_error(
                                "entry_session_closed",
                                "The recovery channel was closed.",
                            )
                            .with_effect("unknown"));
                            let _ = self.session.close("normal");
                            self.transport.close();
                            break;
                        }
                    }
                }
                ws = self.ws_events.recv() => {
                    match ws {
                        Some(WsEvent::Open) => {
                            if self.session.state() == "initiated" {
                                if let Err(e) = self.session.open().map(|_| ()) {
                                    self.fail_all(&e);
                                }
                            }
                        }
                        Some(WsEvent::Message(message)) => {
                            if let Some(kind) = self.handle_events(&message) {
                                let index = self.pending.iter().position(|(accepts, _)| {
                                    accepts.matches(&kind, &message)
                                });
                                if let Some(index) = index {
                                    let (_, reply) = self.pending.remove(index);
                                    let _ = reply.send(Ok(message));
                                }
                            }
                        }
                        Some(WsEvent::Closed { .. }) | None => {
                            self.fail_all(&entry_error(
                                "endpoint_unreachable",
                                "The relay transport dropped during a recovery exchange.",
                            )
                            .with_effect("unknown"));
                            let _ = self.session.transport_lost();
                            break;
                        }
                        Some(WsEvent::ProtocolError(_)) => {}
                    }
                }
            }
        }
        self.fail_all(&entry_error(
            "entry_session_closed",
            "The recovery channel was closed.",
        )
        .with_effect("unknown"));
    }
}

/// Bind the channel to the `RecoveryEndpointPort` contract — the concrete
/// method used by `EntryRecoverySession::recover`.
impl crate::recovery::session::RecoveryEndpointPort for EntryRecoveryChannel {
    async fn round_trip(
        &self,
        _endpoint_route_id: &str,
        message: &Value,
    ) -> Result<Option<Value>> {
        EntryRecoveryChannel::round_trip(self, message).await.map(Some)
    }
}
