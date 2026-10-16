//! Peer application layer — caller/receiver operation records, catalog
//! discovery, transport fragmentation and the durable journal contract.
//! Port of `packages/peer-client/src/application.ts` (and the pure helpers
//! from `application-engine.ts`). All application envelopes ride inside the
//! encrypted peer-send plaintext: the relay never sees this layer.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::client::PEER_CLIENT_MAX_PLAINTEXT_BYTES;
use crate::b64::b64u_encode;
use crate::error::{entry_error, EntryError, Result};
use crate::wire::common::is_opaque_id;

pub const PEER_APPLICATION_PROTOCOL_VERSION: u64 = 1;

pub type PeerApplicationOperationStatus = String;

pub fn status_terminal(s: &str) -> bool {
    matches!(
        s,
        "completed" | "refused" | "stopped" | "cancelled" | "unknown" | "failed"
    )
}

pub fn status_valid(s: &str) -> bool {
    matches!(
        s,
        "delivery_pending"
            | "accepted"
            | "running"
            | "awaiting_permission"
            | "cancel_requested"
            | "completed"
            | "refused"
            | "stopped"
            | "cancelled"
            | "unknown"
            | "failed"
    )
}

pub fn stop_reason_valid(s: &str) -> bool {
    matches!(
        s,
        "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
    )
}

/// `canFollowOperationState` — receiver-published state transitions the
/// caller's durable record may adopt.
pub fn can_follow_operation_state(current: &str, next: &str) -> bool {
    match next {
        "cancel_requested" => true,
        "accepted" => current == "delivery_pending" || current == "accepted",
        "running" | "awaiting_permission" => matches!(
            current,
            "delivery_pending" | "accepted" | "running" | "awaiting_permission"
        ),
        _ => false,
    }
}

/* --------------------------------- address --------------------------------- */

/// Exact paired route context, directed from this device to its counterpart.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerApplicationAddress {
    pub tenant_id: String,
    pub route_id: String,
    pub local_device_id: String,
    pub peer_device_id: String,
}

pub fn assert_peer_client_opaque_id(value: &str, field: &str) -> Result<String> {
    if !is_opaque_id(value, 128) {
        return Err(entry_error(
            "peer_client_state",
            &format!(
                "Peer application {field} is empty or does not satisfy the opaque id contract."
            ),
        ));
    }
    Ok(value.to_string())
}

fn app_error(detail: &str) -> EntryError {
    entry_error("peer_client_state", detail)
}

pub fn assert_address(value: &PeerApplicationAddress) -> Result<PeerApplicationAddress> {
    Ok(PeerApplicationAddress {
        tenant_id: assert_peer_client_opaque_id(&value.tenant_id, "address.tenantId")?,
        route_id: assert_peer_client_opaque_id(&value.route_id, "address.routeId")?,
        local_device_id: assert_peer_client_opaque_id(
            &value.local_device_id,
            "address.localDeviceId",
        )?,
        peer_device_id: assert_peer_client_opaque_id(
            &value.peer_device_id,
            "address.peerDeviceId",
        )?,
    })
}

pub fn parse_peer_application_address(value: &Value) -> Option<PeerApplicationAddress> {
    let parsed: PeerApplicationAddress = serde_json::from_value(value.clone()).ok()?;
    assert_address(&parsed).ok()
}

/// Receiver-side view of the same route: swap the direction fields.
pub fn reverse_peer_application_address(
    address: &PeerApplicationAddress,
) -> PeerApplicationAddress {
    PeerApplicationAddress {
        tenant_id: address.tenant_id.clone(),
        route_id: address.route_id.clone(),
        local_device_id: address.peer_device_id.clone(),
        peer_device_id: address.local_device_id.clone(),
    }
}

/* ---------------------------------- keys ---------------------------------- */

fn sha256_hex(parts: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(parts.join("\u{0}").as_bytes());
    format!("{:x}", hasher.finalize())
}

/// `peerApplicationOperationKey` — stable storage identity derived from the
/// origin tuple + operation id.
pub fn peer_application_operation_key(
    address: &PeerApplicationAddress,
    operation_id: &str,
) -> String {
    let origin = address.clone();
    sha256_hex(&[
        origin.tenant_id,
        origin.route_id,
        origin.local_device_id,
        origin.peer_device_id,
        operation_id.to_string(),
    ])
}

/// `peerApplicationDiscoveryKey`.
pub fn peer_application_discovery_key(
    address: &PeerApplicationAddress,
    request_id: &str,
) -> String {
    sha256_hex(&[
        address.tenant_id.clone(),
        address.route_id.clone(),
        address.local_device_id.clone(),
        address.peer_device_id.clone(),
        request_id.to_string(),
    ])
}

/// `peerApplicationTransportMessageId` — deterministic transport identity for
/// one logical application event of one operation.
pub fn peer_application_transport_message_id(
    sender_device_id: &str,
    key: &str,
    kind: &str,
    revision: u64,
    part: u64,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(
        [
            sender_device_id.to_string(),
            key.to_string(),
            kind.to_string(),
            revision.to_string(),
            part.to_string(),
        ]
        .join("\u{0}")
        .as_bytes(),
    );
    format!("app.{}", b64u_encode(&hasher.finalize()))
}

/// `peerApplicationFragmentMessageId` — stable child transport identity for
/// each part of a logical envelope.
pub fn peer_application_fragment_message_id(message_id: &str, part_index: u64) -> Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(
        [
            assert_peer_client_opaque_id(message_id, "fragment.messageId")?,
            part_index.to_string(),
        ]
        .join("\u{0}")
        .as_bytes(),
    );
    Ok(format!("appf.{}", b64u_encode(&hasher.finalize())))
}

/// `peerApplicationRequestDigest` — sha256 hex over the canonical request
/// projection `{address, callerAgentId, targetAgentId, prompt[, model][, effort]}`.
/// Optional selectors enter the projection only when present, preserving the
/// canonical digest for requests that omit them.
pub fn peer_application_request_digest(
    address: &PeerApplicationAddress,
    caller_agent_id: Option<&str>,
    target_agent_id: &str,
    prompt: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> String {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct RequestDigestProjection<'a> {
        address: &'a PeerApplicationAddress,
        caller_agent_id: Option<&'a str>,
        target_agent_id: &'a str,
        prompt: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        effort: Option<&'a str>,
    }
    let projection = RequestDigestProjection {
        address,
        caller_agent_id,
        target_agent_id,
        prompt,
        model,
        effort,
    };
    let mut hasher = Sha256::new();
    hasher.update(
        serde_json::to_string(&projection)
            .unwrap_or_default()
            .as_bytes(),
    );
    format!("{:x}", hasher.finalize())
}

/// sha256 hex over utf8 text — result digest and fragment message ids.
pub fn peer_application_text_digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub fn new_peer_application_operation_id() -> String {
    format!("op.{}", super::client::uuid_simple())
}

pub fn new_peer_application_discovery_id() -> String {
    format!("catalog.{}", super::client::uuid_simple())
}

/* ---------------------------------- types ---------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentSummary {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub enabled: bool,
    /// How the card was found on this device — `cli`, `desktop`,
    /// `cli+desktop`, `configured`, or absent when no detection evidence applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected: Option<String>,
    /// Callable A4AA lane — `acp`, `rpc`, or `cli`; absent when no lane is
    /// callable on this device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionToolCall {
    pub tool_call_id: String,
    pub title: String,
    pub name: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub content: Vec<AcpPermissionContent>,
    pub raw_input: Option<Value>,
    pub locations: Vec<AcpPermissionLocation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionContent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionLocation {
    pub path: String,
    pub line: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionPrompt {
    pub session_id: String,
    pub tool_call: AcpPermissionToolCall,
    pub options: Vec<AcpPermissionOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AcpPermissionResolution {
    Cancelled,
    Selected { option_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerApplicationProgress {
    pub revision: u64,
    pub kind: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerApplicationPermissionRecord {
    pub id: String,
    pub status: String,
    pub request: AcpPermissionPrompt,
    pub selected_option_id: Option<String>,
    pub updated_at: String,
}

/// One profile-level operation record shared by both directions of a call.
/// Field order matches the TS record for byte-stable journal diffs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerApplicationRecord {
    pub version: u64,
    pub key: String,
    pub operation_id: String,
    pub origin_address: PeerApplicationAddress,
    pub route_address: PeerApplicationAddress,
    pub role: String,
    pub caller_agent_id: Option<String>,
    pub target_agent_id: String,
    pub request_digest: String,
    pub prompt: String,
    /// Optional per-turn model override; AwP supplies profile defaults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Optional per-turn reasoning effort override; AwP supplies profile defaults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub status: String,
    pub prompt_reserved: bool,
    pub prompt_execution_id: Option<String>,
    pub terminal_prepared: bool,
    pub state_revision: u64,
    pub progress: Option<PeerApplicationProgress>,
    pub result_text: Option<String>,
    pub result_digest: Option<String>,
    pub result_stop_reason: Option<String>,
    pub result_status: Option<String>,
    pub result_part_count: Option<u64>,
    pub permission_history: Vec<PeerApplicationPermissionRecord>,
    pub permission: Option<PeerApplicationPermissionRecord>,
    pub cancel_requested: bool,
    pub inbound_message_id: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerApplicationDiscoveryRecord {
    pub version: u64,
    pub key: String,
    pub request_id: String,
    pub address: PeerApplicationAddress,
    pub status: String,
    pub agents: Vec<AcpAgentSummary>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One bounded transport fragment of a deterministic application envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerApplicationFragment {
    pub address: PeerApplicationAddress,
    pub message_id: String,
    pub message_kind: String,
    pub part_index: u64,
    pub part_count: u64,
    pub total_bytes: u64,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerApplicationFragmentSaveStatus {
    Incomplete,
    Complete,
    Applied,
    Backpressured,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerApplicationFragmentSaveResult {
    pub status: PeerApplicationFragmentSaveStatus,
    pub received_parts: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PeerApplicationPage<T> {
    pub items: Vec<T>,
    pub next_after_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerApplicationOperationRecovery {
    pub key: String,
    pub role: String,
    pub operation_id: String,
    pub origin_address: PeerApplicationAddress,
    pub route_address: PeerApplicationAddress,
    pub request_digest: String,
    pub cancel_requested: bool,
    pub terminal: bool,
    pub terminal_prepared: bool,
    pub execution_pending: bool,
    pub result_part_count: Option<u64>,
    pub state_revision: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerApplicationDiscoveryRecovery {
    pub key: String,
    pub address: PeerApplicationAddress,
    pub request_id: String,
    pub action: String,
}

/// Local-only handoff custody; payload bytes stay in the source record and
/// the peer outbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerApplicationHandoffPlan {
    pub key: String,
    pub source_kind: String,
    pub source_key: String,
    pub address: PeerApplicationAddress,
    pub logical_id: String,
    pub message_kind: String,
    pub message_id: String,
    pub part_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerApplicationResultPart {
    pub index: u64,
    pub text: String,
}

#[derive(Debug, Clone)]
pub enum PeerApplicationChange {
    Operation(PeerApplicationRecord),
    Discovery(PeerApplicationDiscoveryRecord),
}

/* -------------------------------- envelopes -------------------------------- */

/// Parsed application envelope: version + kind + raw object.
pub fn parse_application_envelope(bytes: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(bytes).ok()?;
    let value: Value = serde_json::from_str(text).ok()?;
    let obj = value.as_object()?;
    if obj.get("version").and_then(Value::as_u64) != Some(PEER_APPLICATION_PROTOCOL_VERSION) {
        return None;
    }
    if !obj.get("kind").map(|k| k.is_string()).unwrap_or(false) {
        return None;
    }
    Some(value)
}

pub fn serialize_application_envelope(envelope: &Value) -> Vec<u8> {
    serde_json::to_vec(envelope).unwrap_or_default()
}

/// `bytesFor` — envelope JSON bound to the encrypted transport limit.
pub fn application_envelope_bytes(envelope: &Value) -> Result<Vec<u8>> {
    let bytes = serialize_application_envelope(envelope);
    if bytes.len() > PEER_CLIENT_MAX_PLAINTEXT_BYTES {
        return Err(app_error(
            "The Peer application envelope exceeds the encrypted message bound.",
        ));
    }
    Ok(bytes)
}

/// `assertPeerApplicationString`.
pub fn assert_peer_application_string(value: &Value, field: &str, max: usize) -> Result<String> {
    let s = value.as_str().unwrap_or_default();
    if s.is_empty() || s.len() > max {
        return Err(app_error(&format!(
            "Peer application {field} is empty or exceeds its bound."
        )));
    }
    Ok(s.to_string())
}

pub fn nullable_string(value: &Value, field: &str, max: usize) -> Result<Option<String>> {
    if value.is_null() {
        return Ok(None);
    }
    Ok(Some(assert_peer_application_string(value, field, max)?))
}

fn base64url_length(byte_length: usize) -> usize {
    byte_length / 3 * 4
        + if byte_length % 3 == 0 {
            0
        } else {
            byte_length % 3 + 1
        }
}

/// `maxRawFragmentBytes` — largest raw byte count a fragment envelope can
/// carry for this header shape.
fn max_raw_fragment_bytes(
    message_id: &str,
    message_kind: &str,
    part_count: u64,
    total_bytes: u64,
) -> Result<usize> {
    let header = json!({
        "version": PEER_APPLICATION_PROTOCOL_VERSION,
        "kind": "application_fragment",
        "messageId": message_id,
        "messageKind": message_kind,
        "partIndex": part_count - 1,
        "partCount": part_count,
        "totalBytes": total_bytes,
        "data": ""
    });
    let header_len = serde_json::to_vec(&header).unwrap_or_default().len();
    if header_len >= PEER_CLIENT_MAX_PLAINTEXT_BYTES {
        return Err(app_error(
            "The Peer fragment header exceeds the encrypted transport bound.",
        ));
    }
    let available = PEER_CLIENT_MAX_PLAINTEXT_BYTES - header_len;
    let mut candidate = available / 4 * 3;
    match available % 4 {
        2 => candidate += 1,
        3 => candidate += 2,
        _ => {}
    }
    while candidate > 0 && base64url_length(candidate) > available {
        candidate -= 1;
    }
    if candidate < 1 {
        return Err(app_error(
            "The Peer fragment header exceeds the encrypted transport bound.",
        ));
    }
    Ok(candidate)
}

/// One deterministic fragment of a logical envelope.
#[derive(Debug, Clone)]
pub struct LogicalFragment {
    pub message_id: String,
    pub plaintext: Vec<u8>,
    pub part_index: u64,
    pub part_count: u64,
}

/// `fragmentLogicalEnvelope` — deterministic byte-identical fragmentation of
/// an application envelope into peer-send plaintexts.
pub fn fragment_logical_envelope(
    message_id: &str,
    message_kind: &str,
    bytes: &[u8],
) -> Result<Vec<LogicalFragment>> {
    let mut part_count: u64 = 1;
    let mut part_bytes =
        max_raw_fragment_bytes(message_id, message_kind, part_count, bytes.len() as u64)?;
    loop {
        let next = (bytes.len() as u64).div_ceil(part_bytes as u64);
        if next < 1 {
            return Err(app_error(
                "The Peer application envelope is too large to fragment safely.",
            ));
        }
        if next == part_count {
            break;
        }
        part_count = next;
        part_bytes =
            max_raw_fragment_bytes(message_id, message_kind, part_count, bytes.len() as u64)?;
    }
    let mut out = Vec::new();
    let mut offset = 0usize;
    let mut part_index = 0u64;
    while offset < bytes.len() {
        let end = (offset + part_bytes).min(bytes.len());
        let fragment = json!({
            "version": PEER_APPLICATION_PROTOCOL_VERSION,
            "kind": "application_fragment",
            "messageId": message_id,
            "messageKind": message_kind,
            "partIndex": part_index,
            "partCount": part_count,
            "totalBytes": bytes.len() as u64,
            "data": b64u_encode(&bytes[offset..end])
        });
        let plaintext = application_envelope_bytes(&fragment)?;
        out.push(LogicalFragment {
            message_id: peer_application_fragment_message_id(message_id, part_index)?,
            plaintext,
            part_index,
            part_count,
        });
        part_index += 1;
        offset += part_bytes;
    }
    Ok(out)
}

/// `resultParts` — split a result into index/text parts bounded so each
/// `operation_result_part` envelope fits the transport.
pub fn result_parts(
    text: &str,
    operation_id: &str,
    origin_address: &PeerApplicationAddress,
    request_digest: &str,
) -> Result<Vec<PeerApplicationResultPart>> {
    let make_envelope = |index: u64, text: &str| {
        json!({
            "version": PEER_APPLICATION_PROTOCOL_VERSION,
            "kind": "operation_result_part",
            "operationId": operation_id,
            "originAddress": origin_address,
            "requestDigest": request_digest,
            "index": index,
            "text": text,
            "deliveryId": format!("result:part:{index}")
        })
    };
    let mut output: Vec<PeerApplicationResultPart> = Vec::new();
    let mut current = String::new();
    let mut encoded_bytes = serde_json::to_vec(&make_envelope(0, ""))
        .unwrap_or_default()
        .len();
    for ch in text.chars() {
        let escaped = serde_json::to_string(&ch.to_string()).unwrap_or_default();
        let escaped = escaped[1..escaped.len() - 1].to_string();
        let next_bytes = encoded_bytes + escaped.len();
        if !current.is_empty() && next_bytes > PEER_CLIENT_MAX_PLAINTEXT_BYTES {
            let index = output.len() as u64;
            output.push(PeerApplicationResultPart {
                index,
                text: std::mem::take(&mut current),
            });
            encoded_bytes = serde_json::to_vec(&make_envelope(index + 1, ""))
                .unwrap_or_default()
                .len();
        }
        let character_bytes = escaped.len();
        if encoded_bytes + character_bytes > PEER_CLIENT_MAX_PLAINTEXT_BYTES {
            return Err(app_error(
                "A single result character exceeds the encrypted transport bound.",
            ));
        }
        current.push(ch);
        encoded_bytes += character_bytes;
    }
    if !current.is_empty() || output.is_empty() {
        output.push(PeerApplicationResultPart {
            index: output.len() as u64,
            text: current,
        });
    }
    Ok(output)
}

/* ---------------------------- port trait types ----------------------------- */

/// Inbound delivery handed to the application engine by the peer layer.
#[derive(Debug, Clone)]
pub struct PeerApplicationInbound {
    pub address: PeerApplicationAddress,
    pub message: super::client::PeerInboundMessage,
}

/// `PeerApplicationSendState` — the outbox entry's durable state.
pub type PeerApplicationSendState = String;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerApplicationRouteAuthority {
    Current,
    Unavailable,
    Revoked,
}
