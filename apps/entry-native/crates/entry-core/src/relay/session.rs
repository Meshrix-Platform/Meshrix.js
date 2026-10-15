//! Wire-level relay session driver — port of `session-driver.ts`.
//!
//! Owns the wire session lifecycle over a caller-supplied transport:
//! session-open/admission, bounded opaque frame pumping with explicit
//! backpressure accounting, route queries, close/reconnect with cursor
//! bookkeeping. Frame payloads are never interpreted.

use serde_json::Value;

use crate::error::Result;
use crate::keys::generate_opaque_id;
use crate::wire::session::*;

/// Transport contract: `send` receives contract message objects; the
/// transport serializes them (the relay wire is JSON text).
pub trait TransportPort: Send {
    /// Returns Err when the transport cannot accept the message (closed or
    /// not open yet) — the caller maps this to honest dispatch evidence.
    fn send(&self, message: &Value) -> Result<()>;
    fn close(&self);
}

/// Events the driver surfaces — same vocabulary as `RelaySessionHandlers`.
#[derive(Debug, Clone)]
pub enum SessionEvent {
    /// Session admitted or restored; carries relay-issued limits and cursors.
    Admitted(SessionAdmitted),
    /// Session rejected by the relay with the typed reason.
    Rejected { reason: String, retryable: bool },
    /// Inbound opaque frame payload destined for the inner channel.
    /// `session_id` is the *sender's* session, forwarded verbatim — a peer
    /// reconnect replaces it, which signals the inner channel must rebuild.
    Frame {
        payload: String,
        message_id: String,
        session_id: String,
    },
    /// Peer channel closed; `reconnect` means the contract allows a new
    /// generation session.
    Closed { reason: String },
    /// Route status change.
    RouteStatus {
        route_id: String,
        state: String,
        generation: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboundRefusal {
    Backpressure,
    PayloadTooLarge,
    NotStreaming,
    /// The transport could not accept the frame — the session is effectively
    /// dead (dispatch evidence: unknown).
    TransportLost,
}

#[derive(Debug)]
pub struct PendingInbound {
    pub seq: u64,
    pub message_id: String,
    pub payload: String,
    pub session_id: String,
}

pub struct PrivateRelaySession<T: TransportPort> {
    transport: T,
    admission: RelayAdmission,
    purpose: String,
    nonce_factory: Box<dyn Fn() -> String + Send>,
    state: &'static str,
    limits: RelayLimits,
    accounting: FrameAccounting,
    sent_frames: Vec<(u64, u64)>, // (seq, payloadBytes)
    /// Inbound frames accepted by the wire but not yet deliverable to the
    /// inner channel; acks are withheld until delivered.
    pending_inbound: Vec<PendingInbound>,
    /// Sender session of the inbound frame stream; a change invalidates
    /// queued payloads because they are dead peer bytes.
    inbound_peer_session_id: Option<String>,
    /// Highest outbound seq the peer acknowledged.
    outbound_acked: u64,
    next_seq: u64,
    session_id: Option<String>,
    reconnect_generation: u64,
    cursors: SequenceCursors,
    route_state: String,
    /// Frames whose inbound delivery is pending; the caller drains them via
    /// `take_pending_delivery` after re-establishing a channel.
    inbound_delivery_blocked: bool,
}

impl<T: TransportPort> PrivateRelaySession<T> {
    pub fn new(transport: T, admission: RelayAdmission, purpose: &str) -> Self {
        Self {
            transport,
            admission,
            purpose: purpose.into(),
            nonce_factory: Box::new(|| format!("nonce.{}.{}", generate_opaque_id(), chrono::Utc::now().timestamp_millis())),
            state: "initiated",
            limits: RelayLimits::default(),
            accounting: FrameAccounting::default(),
            sent_frames: Vec::new(),
            pending_inbound: Vec::new(),
            inbound_peer_session_id: None,
            outbound_acked: 0,
            next_seq: 1,
            session_id: None,
            reconnect_generation: 0,
            cursors: SequenceCursors::default(),
            route_state: "unreachable".into(),
            inbound_delivery_blocked: false,
        }
    }

    pub fn set_nonce_factory(&mut self, f: impl Fn() -> String + Send + 'static) {
        self.nonce_factory = Box::new(f);
    }

    pub fn state(&self) -> &'static str {
        self.state
    }
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }
    pub fn route_state(&self) -> &str {
        &self.route_state
    }
    pub fn reconnect_generation(&self) -> u64 {
        self.reconnect_generation
    }

    /// True when a new call can be submitted; false maps to
    /// endpoint_unreachable for callers.
    pub fn accepts_new_work(&self) -> bool {
        endpoint_reachable_for_new_work(&self.route_state)
            && (self.state == "admitted" || self.state == "streaming")
    }

    /// Route direction carrying frames this side receives. Endpoint reads
    /// `toEndpoint`, entry reads `toEntry`.
    fn inbound_cursor_key(&self) -> &'static str {
        if self.admission.role == "endpoint" {
            "toEndpoint"
        } else {
            "toEntry"
        }
    }

    /// Route direction carrying frames this side sends. Endpoint writes
    /// `toEntry`, entry writes `toEndpoint`.
    fn outbound_cursor_key(&self) -> &'static str {
        if self.admission.role == "endpoint" {
            "toEntry"
        } else {
            "toEndpoint"
        }
    }

    fn transition(&mut self, event: &str) -> bool {
        match relay_session_transition(self.state, event) {
            Some(next) => {
                self.state = next;
                true
            }
            None => false,
        }
    }

    /// Open a new session. Returns false when the state machine forbids it.
    pub fn open(&mut self) -> Result<bool> {
        if !self.transition("open") {
            return Ok(false);
        }
        let open = create_session_open(&self.purpose, &self.admission, &(self.nonce_factory)());
        self.transport.send(&open)?;
        Ok(true)
    }

    /// Reconnect after close/hibernation with cursors; rechecks authorization
    /// via a fresh admission.
    pub fn reconnect(&mut self, revocation_revision: Option<u64>, last_acknowledged: Option<SequenceCursors>) -> Result<bool> {
        if self.state != "closed" && self.state != "closing" {
            return Ok(false);
        }
        if !self.transition("reconnect") {
            return Ok(false);
        }
        let admission = match revocation_revision {
            Some(rev) => {
                let mut a = self.admission.clone();
                a.revocation_revision = rev;
                a
            }
            None => self.admission.clone(),
        };
        // Each direction reports its own truth: inbound is what we durably
        // delivered, outbound is what the peer acked — never the other side's.
        let last = last_acknowledged.unwrap_or_else(|| {
            let inbound = self.inbound_cursor_key();
            SequenceCursors {
                to_endpoint: if inbound == "toEndpoint" {
                    self.cursors.to_endpoint
                } else {
                    self.outbound_acked
                },
                to_entry: if inbound == "toEntry" {
                    self.cursors.to_entry
                } else {
                    self.outbound_acked
                },
            }
        });
        let _ = outbound_is_consistent(&last);
        let msg = create_session_reconnect(
            self.session_id.as_deref().unwrap_or("unknown"),
            &admission,
            last,
            self.reconnect_generation + 1,
            &(self.nonce_factory)(),
        );
        self.transport.send(&msg)?;
        Ok(true)
    }

    /// Mark the transport gone without writing to its dead socket.
    /// Direct transport send for channel-adjacent control replies
    /// (recovery challenge/result, operation status) that bypass the frame
    /// stream — same `options.transport.send` the TS endpoint uses.
    pub fn transport_send(&mut self, message: &Value) -> Result<()> {
        self.transport.send(message)
    }

    pub fn transport_lost(&mut self) -> bool {
        if !self.transition("transport_lost") {
            return false;
        }
        self.route_state = "unreachable".into();
        true
    }

    pub fn bind_route(&mut self) -> Result<bool> {
        if self.state != "admitted" || self.session_id.is_none() {
            return Ok(false);
        }
        let bind = create_route_bind(
            self.session_id.as_deref().unwrap(),
            &self.admission.route_id,
            self.admission.admission_generation,
        );
        self.transport.send(&bind)?;
        Ok(true)
    }

    pub fn query_route(&self, route_id: &str) -> Result<()> {
        self.transport.send(&create_route_query(route_id))
    }

    /// Offer an outbound opaque payload. Admission to the frame stream is
    /// refused rather than silently queued when bounded buffers are full.
    pub fn send_payload(&mut self, payload_base64url: &str, message_id: Option<&str>, final_: bool) -> std::result::Result<bool, OutboundRefusal> {
        if self.state != "admitted" && self.state != "streaming" {
            return Err(OutboundRefusal::NotStreaming);
        }
        let frame = Frame {
            session_id: self.session_id.clone().unwrap_or_else(|| "pending".into()),
            route_id: self.admission.route_id.clone(),
            seq: self.next_seq,
            message_id: message_id
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("msg.{}.{}", self.admission.device_id, self.next_seq)),
            payload: payload_base64url.to_string(),
            final_,
        };
        let Some(accounting) = admit_outbound_frame(self.accounting, &frame, &self.limits) else {
            return Err(if payload_base64url.len() > (limits::MAX_FRAME_PAYLOAD_BYTES * 4).div_ceil(3) + 8 {
                OutboundRefusal::PayloadTooLarge
            } else {
                OutboundRefusal::Backpressure
            });
        };
        self.accounting = accounting;
        self.sent_frames
            .push((self.next_seq, (payload_base64url.len() * 3).div_ceil(4) as u64));
        self.next_seq += 1;
        self.transition("frame");
        let wire = create_frame(&frame);
        if self.transport.send(&wire).is_err() {
            return Err(OutboundRefusal::TransportLost);
        }
        Ok(true)
    }

    pub fn close(&mut self, reason: &str) -> bool {
        if self.state == "closed" || self.state == "closing" || self.state == "initiated" {
            return false;
        }
        if !self.transition("close") {
            return false;
        }
        let wire_reason = if PRIVATE_RELAY_CLOSE_REASONS.contains(&reason) {
            reason
        } else {
            "protocol_error"
        };
        let msg = create_session_close(
            self.session_id.as_deref().unwrap_or("unknown"),
            wire_reason,
            self.cursors,
        );
        let _ = self.transport.send(&msg);
        self.transition("close_complete");
        true
    }

    /// Typed session failure: tell the peer why the session ends and close
    /// the transport.
    pub fn fail_session(&mut self, reason: &str) -> bool {
        if self.state == "closed" || self.state == "closing" {
            return false;
        }
        let closed = self.close(reason);
        self.transport.close();
        closed
    }

    /// Deliver queued inbound frames after the inner channel drained —
    /// `deliver` must return true only when the payload was durably accepted
    /// by the inner channel buffer (matching the TS onFrame contract).
    pub fn flush_inbound(&mut self, deliver: &mut dyn FnMut(&str, &str, &str) -> bool) -> usize {
        let mut delivered = 0usize;
        let mut last_seq = 0u64;
        while let Some(head) = self.pending_inbound.first() {
            if !deliver(&head.payload, &head.message_id, &head.session_id) {
                break;
            }
            let head = self.pending_inbound.remove(0);
            let key = self.inbound_cursor_key();
            if key == "toEndpoint" {
                self.cursors.to_endpoint = self.cursors.to_endpoint.max(head.seq);
            } else {
                self.cursors.to_entry = self.cursors.to_entry.max(head.seq);
            }
            last_seq = head.seq;
            delivered += 1;
        }
        // One cumulative ack per flush — a deep drain must not turn into a
        // burst of inbound relay messages.
        if delivered > 0 {
            let _ = self
                .transport
                .send(&create_frame_ack(&self.admission.route_id, last_seq));
        }
        delivered
    }

    fn ack_inbound(&mut self, seq: u64) {
        let key = self.inbound_cursor_key();
        if key == "toEndpoint" {
            self.cursors.to_endpoint = self.cursors.to_endpoint.max(seq);
        } else {
            self.cursors.to_entry = self.cursors.to_entry.max(seq);
        }
        // frame-ack is the only client→relay receipt kind the relay runtime
        // accepts; frame-status/flow-credit are relay-originated.
        let _ = self
            .transport
            .send(&create_frame_ack(&self.admission.route_id, seq));
    }

    /// Adopt the relay's route cursors and continue outbound numbering past
    /// them — a fresh session resuming seq at 1 would be dropped as replay.
    fn apply_route_cursors(&mut self, cursors: SequenceCursors) {
        self.cursors = cursors;
        let key = self.outbound_cursor_key();
        let outbound = if key == "toEndpoint" {
            self.cursors.to_endpoint
        } else {
            self.cursors.to_entry
        };
        self.next_seq = self.next_seq.max(outbound + 1);
    }

    /// Take the queued inbound frames for caller-managed delivery. The
    /// caller reports delivered cursors through `commit_inbound` and hands
    /// undeliverable frames back through `restore_pending_inbound` — needed
    /// when the frame sink borrows the same owner as this session (Rust
    /// equivalent of the TS callback whose closure sees the whole endpoint).
    pub fn take_pending_inbound(&mut self) -> Vec<PendingInbound> {
        std::mem::take(&mut self.pending_inbound)
    }

    /// Re-queue undelivered frames ahead of anything still pending —
    /// preserves ordering when delivery fails mid-batch.
    pub fn restore_pending_inbound(&mut self, mut frames: Vec<PendingInbound>) {
        frames.append(&mut self.pending_inbound);
        self.pending_inbound = frames;
    }

    /// `ackInbound` for caller-drained frames — advances the inbound cursor
    /// and sends the cumulative `frame-ack`.
    pub fn commit_inbound(&mut self, seq: u64) {
        self.ack_inbound(seq);
    }

    /// Feed a decoded relay message into the driver. Returns
    /// `Option<(kind, events)>` — `None` when the message is not a
    /// session-channel message (caller routes recovery/other kinds).
    /// `deliver` is the inner-channel frame sink — same contract as TS
    /// `onFrame` (true only when durably accepted).
    pub fn handle_message(
        &mut self,
        message: &Value,
        deliver: &mut dyn FnMut(&str, &str, &str) -> bool,
    ) -> Option<(&'static str, Vec<SessionEvent>)> {
        let kind = relay_message_kind(message)?;
        let mut events = Vec::new();
        match kind {
            "session-admitted" => {
                if self.state != "open_sent" && self.state != "reconnecting" {
                    return Some((kind, events));
                }
                let parsed = parse_session_admitted(message).unwrap();
                self.session_id = Some(parsed.session_id.clone());
                self.limits = parsed.limits.clone();
                self.reconnect_generation = parsed.reconnect_generation;
                self.route_state = parsed.route_state.clone();
                self.apply_route_cursors(parsed.cursors);
                self.transition("admit");
                events.push(SessionEvent::Admitted(parsed));
            }
            "session-rejected" => {
                let parsed = parse_session_rejected(message).unwrap();
                self.transition("reject");
                events.push(SessionEvent::Rejected {
                    reason: parsed.reason,
                    retryable: parsed.retryable,
                });
            }
            "session-restored" => {
                if self.state != "reconnecting" {
                    return Some((kind, events));
                }
                let parsed = parse_session_restored(message).unwrap();
                self.session_id = Some(parsed.session_id.clone());
                self.reconnect_generation = parsed.reconnect_generation;
                self.limits = parsed.limits.clone();
                self.apply_route_cursors(parsed.cursors);
                self.transition("restore");
                // A restored session is equivalent to a fresh admission for
                // the channel layer.
                events.push(SessionEvent::Admitted(SessionAdmitted {
                    session_id: parsed.session_id,
                    purpose: self.purpose.clone(),
                    admitted_generation: self.admission.admission_generation,
                    revocation_revision: self.admission.revocation_revision,
                    route_state: self.route_state.clone(),
                    limits: parsed.limits,
                    reconnect_generation: parsed.reconnect_generation,
                    cursors: parsed.cursors,
                    server_nonce: String::new(),
                }));
            }
            "route-status" => {
                let parsed = parse_route_status(message).unwrap();
                self.route_state = parsed.state.clone();
                events.push(SessionEvent::RouteStatus {
                    route_id: parsed.route_id,
                    state: parsed.state,
                    generation: parsed.generation,
                });
            }
            "frame" => {
                if self.state != "admitted" && self.state != "streaming" {
                    return Some((kind, events));
                }
                self.transition("frame");
                let parsed = parse_frame(message).unwrap();
                let peer_session_id = parsed.session_id.clone();
                if self.inbound_peer_session_id.is_some()
                    && self.inbound_peer_session_id.as_deref() != Some(&peer_session_id)
                {
                    // The peer session was replaced: every queued payload is
                    // dead bytes from the old session.
                    self.pending_inbound.clear();
                }
                self.inbound_peer_session_id = Some(peer_session_id.clone());
                let inbound_seq = parsed.seq;
                let cursor = if self.inbound_cursor_key() == "toEndpoint" {
                    self.cursors.to_endpoint
                } else {
                    self.cursors.to_entry
                };
                if inbound_seq <= cursor {
                    // Retransmit of an already-delivered frame — ack idempotently.
                    self.ack_inbound(inbound_seq);
                    return Some((kind, events));
                }
                if !self.pending_inbound.is_empty() {
                    // Preserve ordering behind the undelivered head; a
                    // retransmitted seq already queued is dropped.
                    if self.pending_inbound.iter().any(|p| p.seq == inbound_seq) {
                        return Some((kind, events));
                    }
                    if self.pending_inbound.len() >= self.limits.max_buffered_frames as usize {
                        self.fail_session("capacity_exceeded");
                        return Some((kind, events));
                    }
                    self.pending_inbound.push(PendingInbound {
                        seq: inbound_seq,
                        message_id: parsed.message_id,
                        payload: parsed.payload,
                        session_id: peer_session_id,
                    });
                    return Some((kind, events));
                }
                if deliver(&parsed.payload, &parsed.message_id, &peer_session_id) {
                    self.ack_inbound(inbound_seq);
                } else {
                    self.pending_inbound.push(PendingInbound {
                        seq: inbound_seq,
                        message_id: parsed.message_id,
                        payload: parsed.payload,
                        session_id: peer_session_id,
                    });
                    self.inbound_delivery_blocked = true;
                }
            }
            "frame-ack" => {
                let (_route, up_to_seq) = parse_frame_ack(message).unwrap();
                if let Some(accounting) = acknowledge_frames(self.accounting, up_to_seq, &self.sent_frames) {
                    self.sent_frames.retain(|(seq, _)| *seq > up_to_seq);
                    self.accounting = accounting;
                    self.outbound_acked = self.outbound_acked.max(up_to_seq);
                }
            }
            "session-close" => {
                let (_id, reason, final_cursors) = parse_session_close(message).unwrap();
                self.cursors = final_cursors;
                self.transition("close");
                self.transition("close_complete");
                events.push(SessionEvent::Closed { reason });
                self.transport.close();
            }
            _ => {}
        }
        Some((kind, events))
    }
}

fn outbound_is_consistent(_cursors: &SequenceCursors) -> bool {
    true
}
