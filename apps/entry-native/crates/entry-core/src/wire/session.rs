//! Relay wire contract — port of `private-relay-session.ts`.
//! The relay sees only opaque routing identifiers, generations, revisions
//! and ciphertext bytes; every parser enforces the contract's exact key
//! sets and field bounds, and every constructor builds only valid messages.

use serde_json::{Map, Value};

use super::common::*;

pub const PRIVATE_RELAY_SCHEMA_VERSION: &str = "v0.0.1:private-relay:wire-1";
pub const PRIVATE_RELAY_WIRE_PROTOCOL: &str = "meshrix-private-relay/0";

pub const PRIVATE_RELAY_ROLES: &[&str] = &["entry", "endpoint"];
pub const PRIVATE_RELAY_MODES: &[&str] = &["personal", "enterprise"];
pub const PRIVATE_RELAY_SESSION_PURPOSES: &[&str] = &["forward", "recover_device", "pair_device"];
pub const PRIVATE_RELAY_PAIRING_CLIENT_KINDS: &[&str] = &["frame", "frame-ack", "session-close"];
pub const PRIVATE_RELAY_PAIRING_RELAY_KINDS: &[&str] = &["pairing-bootstrap"];
pub const PRIVATE_RELAY_REJECT_REASONS: &[&str] = &[
    "identity_unknown",
    "identity_ambiguous",
    "mode_mismatch",
    "tenant_mismatch",
    "revoked",
    "stale_revocation_revision",
    "capacity_exceeded",
    "protocol_version_unsupported",
    "purpose_denied",
    "authority_stale",
];
pub const PRIVATE_RELAY_CLOSE_REASONS: &[&str] = &[
    "normal",
    "reconnect",
    "revoked",
    "capacity_exceeded",
    "protocol_error",
    "idle_timeout",
];
pub const PRIVATE_RELAY_ROUTE_STATES: &[&str] = &["reachable", "unreachable"];
pub const PRIVATE_RELAY_FRAME_STATES: &[&str] = &["accepted", "received"];
pub const PRIVATE_RELAY_GAP_CAUSES: &[&str] = &["expired", "capacity_truncated"];

pub const PRIVATE_RELAY_SESSION_STATES: &[&str] = &[
    "initiated",
    "open_sent",
    "admitted",
    "rejected",
    "streaming",
    "closing",
    "closed",
    "reconnecting",
];

pub mod limits {
    pub const MAX_OPAQUE_ID_BYTES: usize = 128;
    pub const MAX_NONCE_BYTES: usize = 96;
    pub const MAX_FRAME_PAYLOAD_BYTES: usize = 262_144;
    pub const MAX_OUTSTANDING_BYTES: usize = 4_194_304;
    pub const MAX_BUFFERED_FRAMES: usize = 256;
    pub const MAX_MESSAGE_RATE_PER_SECOND: usize = 128;
    pub const MAX_SESSION_CONTROL_BYTES: usize = 16_384;
    pub const MAX_GAPS: usize = 64;
    pub const MAX_ROUTE_IDS: usize = 64;
}

pub const PRIVATE_RELAY_OFFLINE_NEW_CALL_QUEUES: bool = false;

fn envelope(kind: &str, extras: Map<String, Value>) -> Value {
    let mut map = Map::with_capacity(3 + extras.len());
    map.insert("schemaVersion".into(), Value::String(PRIVATE_RELAY_SCHEMA_VERSION.into()));
    map.insert("wireProtocol".into(), Value::String(PRIVATE_RELAY_WIRE_PROTOCOL.into()));
    map.insert("kind".into(), Value::String(kind.into()));
    map.extend(extras);
    Value::Object(map)
}

fn check_envelope(value: &Value, kind: &str) -> bool {
    value.get("schemaVersion").and_then(|v| v.as_str()) == Some(PRIVATE_RELAY_SCHEMA_VERSION)
        && value.get("wireProtocol").and_then(|v| v.as_str()) == Some(PRIVATE_RELAY_WIRE_PROTOCOL)
        && value.get("kind").and_then(|v| v.as_str()) == Some(kind)
        && !contains_forbidden_relay_keys(value)
}

// ---------------------------------------------------------------- admission

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayAdmission {
    pub tenant_id: String,
    pub device_id: String,
    pub route_id: String,
    pub role: String,
    pub mode: String,
    pub admission_generation: u64,
    pub revocation_revision: u64,
}

pub fn parse_relay_admission_binding(value: &Value) -> Option<RelayAdmission> {
    if !has_exact_keys(
        value,
        &["admissionGeneration", "deviceId", "mode", "revocationRevision", "role", "routeId", "tenantId"],
    ) {
        return None;
    }
    let o = value.as_object()?;
    Some(RelayAdmission {
        tenant_id: opaque_id(get(o, "tenantId"), limits::MAX_OPAQUE_ID_BYTES)?,
        device_id: opaque_id(get(o, "deviceId"), limits::MAX_OPAQUE_ID_BYTES)?,
        route_id: opaque_id(get(o, "routeId"), limits::MAX_OPAQUE_ID_BYTES)?,
        role: enum_value(get(o, "role"), PRIVATE_RELAY_ROLES)?.into(),
        mode: enum_value(get(o, "mode"), PRIVATE_RELAY_MODES)?.into(),
        admission_generation: positive_revision(get(o, "admissionGeneration"))?,
        revocation_revision: revision(get(o, "revocationRevision"))?,
    })
}

impl RelayAdmission {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("admissionGeneration".into(), self.admission_generation.into());
        map.insert("deviceId".into(), self.device_id.clone().into());
        map.insert("mode".into(), self.mode.clone().into());
        map.insert("revocationRevision".into(), self.revocation_revision.into());
        map.insert("role".into(), self.role.clone().into());
        map.insert("routeId".into(), self.route_id.clone().into());
        map.insert("tenantId".into(), self.tenant_id.clone().into());
        Value::Object(map)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayLimits {
    pub max_frame_payload_bytes: u64,
    pub max_outstanding_bytes: u64,
    pub max_buffered_frames: u64,
    pub max_message_rate_per_second: u64,
}

impl Default for RelayLimits {
    fn default() -> Self {
        Self {
            max_frame_payload_bytes: limits::MAX_FRAME_PAYLOAD_BYTES as u64,
            max_outstanding_bytes: limits::MAX_OUTSTANDING_BYTES as u64,
            max_buffered_frames: limits::MAX_BUFFERED_FRAMES as u64,
            max_message_rate_per_second: limits::MAX_MESSAGE_RATE_PER_SECOND as u64,
        }
    }
}

pub fn parse_relay_limits(value: &Value) -> Option<RelayLimits> {
    if !has_exact_keys(
        value,
        &[
            "maxBufferedFrames",
            "maxFramePayloadBytes",
            "maxMessageRatePerSecond",
            "maxOutstandingBytes",
        ],
    ) {
        return None;
    }
    let o = value.as_object()?;
    let bounded = |k: &str, cap: u64| -> Option<u64> {
        let n = get(o, k).as_u64()?;
        (n >= 1 && n <= cap).then_some(n)
    };
    Some(RelayLimits {
        max_frame_payload_bytes: bounded("maxFramePayloadBytes", limits::MAX_FRAME_PAYLOAD_BYTES as u64)?,
        max_outstanding_bytes: bounded("maxOutstandingBytes", limits::MAX_OUTSTANDING_BYTES as u64)?,
        max_buffered_frames: bounded("maxBufferedFrames", limits::MAX_BUFFERED_FRAMES as u64)?,
        max_message_rate_per_second: bounded("maxMessageRatePerSecond", limits::MAX_MESSAGE_RATE_PER_SECOND as u64)?,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SequenceCursors {
    pub to_endpoint: u64,
    pub to_entry: u64,
}

pub fn parse_sequence_cursors(value: &Value) -> Option<SequenceCursors> {
    if !has_exact_keys(value, &["toEndpoint", "toEntry"]) {
        return None;
    }
    let o = value.as_object()?;
    Some(SequenceCursors {
        to_endpoint: revision(get(o, "toEndpoint"))?,
        to_entry: revision(get(o, "toEntry"))?,
    })
}

// --------------------------------------------------------------- open/admit

pub fn create_session_open(purpose: &str, admission: &RelayAdmission, client_nonce: &str) -> Value {
    let mut extras = Map::new();
    extras.insert("purpose".into(), purpose.into());
    extras.insert("admission".into(), admission.to_json());
    extras.insert("clientNonce".into(), client_nonce.into());
    envelope("session-open", extras)
}

pub fn parse_session_open(value: &Value) -> Option<(String, RelayAdmission, String)> {
    if !check_envelope(value, "session-open")
        || !has_exact_keys(
            value,
            &["admission", "clientNonce", "kind", "purpose", "schemaVersion", "wireProtocol"],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    Some((
        enum_value(get(o, "purpose"), PRIVATE_RELAY_SESSION_PURPOSES)?.into(),
        parse_relay_admission_binding(get(o, "admission"))?,
        nonce_token(get(o, "clientNonce"), limits::MAX_NONCE_BYTES)?,
    ))
}

#[derive(Debug, Clone)]
pub struct SessionAdmitted {
    pub session_id: String,
    pub purpose: String,
    pub admitted_generation: u64,
    pub revocation_revision: u64,
    pub route_state: String,
    pub limits: RelayLimits,
    pub reconnect_generation: u64,
    pub cursors: SequenceCursors,
    pub server_nonce: String,
}

pub fn parse_session_admitted(value: &Value) -> Option<SessionAdmitted> {
    if !check_envelope(value, "session-admitted")
        || !has_exact_keys(
            value,
            &[
                "admittedGeneration", "cursors", "kind", "limits", "purpose", "reconnectGeneration",
                "revocationRevision", "routeState", "schemaVersion", "serverNonce", "sessionId",
                "wireProtocol",
            ],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    Some(SessionAdmitted {
        session_id: opaque_id(get(o, "sessionId"), limits::MAX_OPAQUE_ID_BYTES)?,
        purpose: enum_value(get(o, "purpose"), PRIVATE_RELAY_SESSION_PURPOSES)?.into(),
        admitted_generation: positive_revision(get(o, "admittedGeneration"))?,
        revocation_revision: revision(get(o, "revocationRevision"))?,
        route_state: enum_value(get(o, "routeState"), PRIVATE_RELAY_ROUTE_STATES)?.into(),
        limits: parse_relay_limits(get(o, "limits"))?,
        reconnect_generation: positive_revision(get(o, "reconnectGeneration"))?,
        cursors: parse_sequence_cursors(get(o, "cursors"))?,
        server_nonce: nonce_token(get(o, "serverNonce"), limits::MAX_NONCE_BYTES)?,
    })
}

#[derive(Debug, Clone)]
pub struct SessionRejected {
    pub reason: String,
    pub expected_revocation_revision: u64,
    pub retryable: bool,
}

pub fn parse_session_rejected(value: &Value) -> Option<SessionRejected> {
    if !check_envelope(value, "session-rejected")
        || !has_exact_keys(
            value,
            &[
                "expectedRevocationRevision", "kind", "reason", "retryable", "schemaVersion",
                "wireProtocol",
            ],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    Some(SessionRejected {
        reason: enum_value(get(o, "reason"), PRIVATE_RELAY_REJECT_REASONS)?.into(),
        expected_revocation_revision: revision(get(o, "expectedRevocationRevision"))?,
        retryable: bool_value(get(o, "retryable"))?,
    })
}

// ------------------------------------------------------------------- frames

pub fn create_route_bind(session_id: &str, route_id: &str, admission_generation: u64) -> Value {
    let mut extras = Map::new();
    extras.insert("sessionId".into(), session_id.into());
    extras.insert("routeId".into(), route_id.into());
    extras.insert("admissionGeneration".into(), admission_generation.into());
    envelope("route-bind", extras)
}

pub fn create_route_query(route_id: &str) -> Value {
    let mut extras = Map::new();
    extras.insert("routeId".into(), route_id.into());
    envelope("route-query", extras)
}

#[derive(Debug, Clone)]
pub struct RouteStatus {
    pub route_id: String,
    pub state: String,
    pub generation: u64,
}

pub fn parse_route_status(value: &Value) -> Option<RouteStatus> {
    if !check_envelope(value, "route-status")
        || !has_exact_keys(
            value,
            &["generation", "kind", "routeId", "schemaVersion", "state", "wireProtocol"],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    Some(RouteStatus {
        route_id: opaque_id(get(o, "routeId"), limits::MAX_OPAQUE_ID_BYTES)?,
        state: enum_value(get(o, "state"), PRIVATE_RELAY_ROUTE_STATES)?.into(),
        generation: positive_revision(get(o, "generation"))?,
    })
}

#[derive(Debug, Clone)]
pub struct Frame {
    pub session_id: String,
    pub route_id: String,
    pub seq: u64,
    pub message_id: String,
    /// Opaque base64url payload (inner TLS records in production).
    pub payload: String,
    pub final_: bool,
}

pub fn create_frame(frame: &Frame) -> Value {
    let mut extras = Map::new();
    extras.insert("sessionId".into(), frame.session_id.clone().into());
    extras.insert("routeId".into(), frame.route_id.clone().into());
    extras.insert("seq".into(), frame.seq.into());
    extras.insert("messageId".into(), frame.message_id.clone().into());
    extras.insert("payload".into(), frame.payload.clone().into());
    extras.insert("final".into(), frame.final_.into());
    envelope("frame", extras)
}

pub fn parse_frame(value: &Value) -> Option<Frame> {
    if !check_envelope(value, "frame")
        || !has_exact_keys(
            value,
            &[
                "final", "kind", "messageId", "payload", "routeId", "schemaVersion", "seq",
                "sessionId", "wireProtocol",
            ],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    Some(Frame {
        session_id: opaque_id(get(o, "sessionId"), limits::MAX_OPAQUE_ID_BYTES)?,
        route_id: opaque_id(get(o, "routeId"), limits::MAX_OPAQUE_ID_BYTES)?,
        seq: revision(get(o, "seq"))?,
        message_id: opaque_id(get(o, "messageId"), limits::MAX_OPAQUE_ID_BYTES)?,
        payload: opaque_bytes(get(o, "payload"), limits::MAX_FRAME_PAYLOAD_BYTES)?,
        final_: bool_value(get(o, "final"))?,
    })
}

#[derive(Debug, Clone, Copy)]
pub struct FrameAck {
    pub route_id_present: (),
}

pub fn create_frame_ack(route_id: &str, up_to_seq: u64) -> Value {
    let mut extras = Map::new();
    extras.insert("routeId".into(), route_id.into());
    extras.insert("upToSeq".into(), up_to_seq.into());
    envelope("frame-ack", extras)
}

pub fn parse_frame_ack(value: &Value) -> Option<(String, u64)> {
    if !check_envelope(value, "frame-ack")
        || !has_exact_keys(value, &["kind", "routeId", "schemaVersion", "upToSeq", "wireProtocol"])
    {
        return None;
    }
    let o = value.as_object()?;
    Some((
        opaque_id(get(o, "routeId"), limits::MAX_OPAQUE_ID_BYTES)?,
        revision(get(o, "upToSeq"))?,
    ))
}

pub fn parse_frame_status(value: &Value) -> Option<(String, String, String)> {
    if !check_envelope(value, "frame-status")
        || !has_exact_keys(
            value,
            &["kind", "messageId", "routeId", "schemaVersion", "state", "wireProtocol"],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    Some((
        opaque_id(get(o, "routeId"), limits::MAX_OPAQUE_ID_BYTES)?,
        opaque_id(get(o, "messageId"), limits::MAX_OPAQUE_ID_BYTES)?,
        enum_value(get(o, "state"), PRIVATE_RELAY_FRAME_STATES)?.into(),
    ))
}

// ---------------------------------------------------------------- close/etc

pub fn create_session_close(session_id: &str, reason: &str, final_cursors: SequenceCursors) -> Value {
    let mut extras = Map::new();
    extras.insert("sessionId".into(), session_id.into());
    extras.insert("reason".into(), reason.into());
    let mut cursors = Map::new();
    cursors.insert("toEndpoint".into(), final_cursors.to_endpoint.into());
    cursors.insert("toEntry".into(), final_cursors.to_entry.into());
    extras.insert("finalCursors".into(), Value::Object(cursors));
    envelope("session-close", extras)
}

pub fn parse_session_close(value: &Value) -> Option<(String, String, SequenceCursors)> {
    if !check_envelope(value, "session-close")
        || !has_exact_keys(
            value,
            &[
                "finalCursors", "kind", "reason", "schemaVersion", "sessionId", "wireProtocol",
            ],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    Some((
        opaque_id(get(o, "sessionId"), limits::MAX_OPAQUE_ID_BYTES)?,
        enum_value(get(o, "reason"), PRIVATE_RELAY_CLOSE_REASONS)?.into(),
        parse_sequence_cursors(get(o, "finalCursors"))?,
    ))
}

pub fn create_session_reconnect(
    previous_session_id: &str,
    admission: &RelayAdmission,
    last_acknowledged: SequenceCursors,
    reconnect_generation: u64,
    client_nonce: &str,
) -> Value {
    let mut extras = Map::new();
    extras.insert("previousSessionId".into(), previous_session_id.into());
    extras.insert("admission".into(), admission.to_json());
    let mut cursors = Map::new();
    cursors.insert("toEndpoint".into(), last_acknowledged.to_endpoint.into());
    cursors.insert("toEntry".into(), last_acknowledged.to_entry.into());
    extras.insert("lastAcknowledged".into(), Value::Object(cursors));
    extras.insert("reconnectGeneration".into(), reconnect_generation.into());
    extras.insert("clientNonce".into(), client_nonce.into());
    envelope("session-reconnect", extras)
}

#[derive(Debug, Clone)]
pub struct SessionRestored {
    pub session_id: String,
    pub reconnect_generation: u64,
    pub gaps: Vec<Value>,
    pub limits: RelayLimits,
    pub cursors: SequenceCursors,
}

pub fn parse_session_restored(value: &Value) -> Option<SessionRestored> {
    if !check_envelope(value, "session-restored")
        || !has_exact_keys(
            value,
            &[
                "cursors", "gaps", "kind", "limits", "reconnectGeneration", "schemaVersion",
                "sessionId", "wireProtocol",
            ],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    let gaps = get(o, "gaps").as_array()?;
    if gaps.len() > limits::MAX_GAPS {
        return None;
    }
    Some(SessionRestored {
        session_id: opaque_id(get(o, "sessionId"), limits::MAX_OPAQUE_ID_BYTES)?,
        reconnect_generation: positive_revision(get(o, "reconnectGeneration"))?,
        gaps: gaps.clone(),
        limits: parse_relay_limits(get(o, "limits"))?,
        cursors: parse_sequence_cursors(get(o, "cursors"))?,
    })
}

pub fn parse_pairing_bootstrap(value: &Value) -> Option<(String, String)> {
    if !check_envelope(value, "pairing-bootstrap")
        || !has_exact_keys(
            value,
            &["bootstrapId", "entrySessionId", "kind", "schemaVersion", "wireProtocol"],
        )
    {
        return None;
    }
    let o = value.as_object()?;
    Some((
        opaque_id(get(o, "bootstrapId"), limits::MAX_OPAQUE_ID_BYTES)?,
        opaque_id(get(o, "entrySessionId"), limits::MAX_OPAQUE_ID_BYTES)?,
    ))
}

/// Parse any relay message; returns the kind string for routing.
/// Mirrors `parsePrivateRelayMessage` — forbidden keys reject outright.
pub fn relay_message_kind(value: &Value) -> Option<&'static str> {
    if !value.is_object() || contains_forbidden_relay_keys(value) {
        return None;
    }
    let kind = value.get("kind")?.as_str()?;
    let ok = match kind {
        "session-open" => parse_session_open(value).is_some(),
        "session-admitted" => parse_session_admitted(value).is_some(),
        "session-rejected" => parse_session_rejected(value).is_some(),
        "route-bind" => has_exact_keys(
            value,
            &[
                "admissionGeneration", "kind", "routeId", "schemaVersion", "sessionId",
                "wireProtocol",
            ],
        ) && opaque_id(get(value.as_object()?, "sessionId"), limits::MAX_OPAQUE_ID_BYTES).is_some()
            && opaque_id(get(value.as_object()?, "routeId"), limits::MAX_OPAQUE_ID_BYTES).is_some()
            && positive_revision(get(value.as_object()?, "admissionGeneration")).is_some(),
        "route-query" => {
            has_exact_keys(value, &["kind", "routeId", "schemaVersion", "wireProtocol"])
                && opaque_id(get(value.as_object()?, "routeId"), limits::MAX_OPAQUE_ID_BYTES).is_some()
        }
        "route-status" => parse_route_status(value).is_some(),
        "frame" => parse_frame(value).is_some(),
        "frame-ack" => parse_frame_ack(value).is_some(),
        "frame-status" => parse_frame_status(value).is_some(),
        "flow-credit" => {
            has_exact_keys(
                value,
                &[
                    "grantBytes", "grantFrames", "kind", "routeId", "schemaVersion", "wireProtocol",
                ],
            ) && opaque_id(get(value.as_object()?, "routeId"), limits::MAX_OPAQUE_ID_BYTES).is_some()
                && positive_revision(get(value.as_object()?, "grantBytes")).is_some()
                && positive_revision(get(value.as_object()?, "grantFrames")).is_some()
        }
        "session-close" => parse_session_close(value).is_some(),
        "session-reconnect" => {
            let o = value.as_object()?;
            has_exact_keys(
                value,
                &[
                    "admission", "clientNonce", "kind", "lastAcknowledged", "previousSessionId",
                    "reconnectGeneration", "schemaVersion", "wireProtocol",
                ],
            ) && opaque_id(get(o, "previousSessionId"), limits::MAX_OPAQUE_ID_BYTES).is_some()
                && parse_relay_admission_binding(get(o, "admission")).is_some()
                && parse_sequence_cursors(get(o, "lastAcknowledged")).is_some()
                && positive_revision(get(o, "reconnectGeneration")).is_some()
                && nonce_token(get(o, "clientNonce"), limits::MAX_NONCE_BYTES).is_some()
        }
        "session-restored" => parse_session_restored(value).is_some(),
        "pairing-bootstrap" => parse_pairing_bootstrap(value).is_some(),
        _ => return None,
    };
    if ok {
        Some(match kind {
            "session-open" => "session-open",
            "session-admitted" => "session-admitted",
            "session-rejected" => "session-rejected",
            "route-bind" => "route-bind",
            "route-query" => "route-query",
            "route-status" => "route-status",
            "frame" => "frame",
            "frame-ack" => "frame-ack",
            "frame-status" => "frame-status",
            "flow-credit" => "flow-credit",
            "session-close" => "session-close",
            "session-reconnect" => "session-reconnect",
            "session-restored" => "session-restored",
            "pairing-bootstrap" => "pairing-bootstrap",
            _ => unreachable!(),
        })
    } else {
        None
    }
}

// --------------------------------------------------------------- accounting

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FrameAccounting {
    pub outstanding_bytes: u64,
    pub outstanding_frames: u64,
}

/// `admitOutboundFrame` — bounded window accounting, refuses silently queued
/// growth.
pub fn admit_outbound_frame(accounting: FrameAccounting, frame: &Frame, limits: &RelayLimits) -> Option<FrameAccounting> {
    let payload_bytes = (frame.payload.len() * 3).div_ceil(4) as u64;
    let bytes = accounting.outstanding_bytes + payload_bytes;
    let frames = accounting.outstanding_frames + 1;
    if bytes > limits.max_outstanding_bytes || frames > limits.max_buffered_frames {
        return None;
    }
    Some(FrameAccounting {
        outstanding_bytes: bytes,
        outstanding_frames: frames,
    })
}

/// `acknowledgeFrames` — reconcile the accounting against an ack cursor.
pub fn acknowledge_frames(
    accounting: FrameAccounting,
    up_to_seq: u64,
    sent_frames: &[(u64, u64)],
) -> Option<FrameAccounting> {
    let remaining: Vec<(u64, u64)> = sent_frames.iter().copied().filter(|(seq, _)| *seq > up_to_seq).collect();
    if remaining.len() == sent_frames.len() && up_to_seq > 0 {
        return None;
    }
    let bytes: u64 = remaining.iter().map(|(_, b)| *b).sum();
    if bytes > accounting.outstanding_bytes {
        return None;
    }
    Some(FrameAccounting {
        outstanding_bytes: bytes,
        outstanding_frames: remaining.len() as u64,
    })
}

// -------------------------------------------------------------- transitions

fn transition_table(state: &str, event: &str) -> Option<&'static str> {
    Some(match (state, event) {
        ("initiated", "open") => "open_sent",
        ("initiated", "transport_lost") => "closed",
        ("open_sent", "admit") => "admitted",
        ("open_sent", "reject") => "rejected",
        ("open_sent", "close" | "transport_lost") => "closed",
        ("admitted", "frame") => "streaming",
        ("admitted", "close") => "closing",
        ("admitted", "reconnect") => "reconnecting",
        ("admitted", "transport_lost") => "closed",
        ("streaming", "frame") => "streaming",
        ("streaming", "close") => "closing",
        ("streaming", "reconnect") => "reconnecting",
        ("streaming", "transport_lost") => "closed",
        ("closing", "close_complete" | "transport_lost") => "closed",
        ("closed", "reconnect") => "reconnecting",
        ("reconnecting", "restore") => "admitted",
        ("reconnecting", "reject") => "rejected",
        ("reconnecting", "transport_lost") => "closed",
        _ => return None,
    })
}

pub fn relay_session_transition(state: &str, event: &str) -> Option<&'static str> {
    transition_table(state, event)
}

/// `endpointReachabilityForNewWork` — only a reachable route admits new calls.
pub fn endpoint_reachable_for_new_work(route_state: &str) -> bool {
    route_state == "reachable"
}

/// `pairingChannelAdmitsOnlyPairing` — the pair_device session allowlist.
pub fn pairing_channel_admits_only_pairing(kind: &str, session_purpose: &str) -> bool {
    if !PRIVATE_RELAY_SESSION_PURPOSES.contains(&session_purpose) {
        return false;
    }
    if session_purpose != "pair_device" {
        return true;
    }
    PRIVATE_RELAY_PAIRING_CLIENT_KINDS.contains(&kind)
}

/// `recoveryChannelAdmitsOnlyRecovery` — recover_device session allowlist.
pub fn recovery_channel_admits_only_recovery(kind: &str, session_purpose: &str) -> bool {
    if session_purpose != "recover_device" {
        return true;
    }
    matches!(
        kind,
        "recovery-request" | "recovery-challenge" | "recovery-proof" | "recovery-result"
            | "session-close" | "session-reconnect"
    )
}
