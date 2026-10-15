//! Relay-level peer wire contract — port of `private-relay-peer.ts`.
//!
//! Peer messages are top-level relay wire objects stamped with the peer
//! schema version. They bypass the session driver entirely and land on the
//! peer client; the relay only ever forwards ciphertext envelopes. Every
//! parser is exact-key, bounded, and rejects forbidden-key payloads — the
//! relay must never see plaintext or semantic/application fields.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::b64::{b64u_decode, b64u_encode};

/// Schema stamp every peer-schema wire object carries.
pub const PRIVATE_RELAY_PEER_SCHEMA_VERSION: &str = "v0.0.1:private-relay:peer-1";

/// Wire protocol identifier.
pub const PRIVATE_RELAY_PEER_WIRE: &str = "meshrix-private-relay/0";

/// The relay must never see peer plaintext.
pub const PRIVATE_RELAY_PEER_RELAY_SEES_PLAINTEXT: bool = false;

/// Wire kinds.
pub const PEER_KIND_BUNDLE_PUBLISH: &str = "peer-bundle-publish";
pub const PEER_KIND_BUNDLE_PUBLISHED: &str = "peer-bundle-published";
pub const PEER_KIND_BUNDLE_FETCH: &str = "peer-bundle-fetch";
pub const PEER_KIND_BUNDLE: &str = "peer-bundle";
pub const PEER_KIND_PRESENCE: &str = "peer-presence";
pub const PEER_KIND_SEND: &str = "peer-send";
pub const PEER_KIND_FORWARDED: &str = "peer-forwarded";
pub const PEER_KIND_DELIVERY_ACK: &str = "peer-delivery-ack";

/// Signal envelope profiles.
pub const PROFILE_X3DH: &str = "signal-x3dh";
pub const PROFILE_PQXDH: &str = "signal-pqxdh";

/// Relay envelope header message types.
pub const HEADER_TYPE_PREKEY: &str = "prekey";
pub const HEADER_TYPE_SESSION: &str = "session";

/// Wire bounds.
pub const MAX_OPAQUE_ID_BYTES: usize = 128;
pub const MAX_ENVELOPE_BYTES: usize = 65_536;
pub const MAX_BUNDLE_BYTES: usize = 65_536;
pub const MAX_SIGNATURE_BYTES: usize = 64;

/// Publish outcomes / bundle states / refusal codes.
pub const BUNDLE_PUBLISH_OUTCOMES: &[&str] = &["published", "superseded", "refused"];
pub const BUNDLE_STATES: &[&str] = &["available", "unpublished", "refused"];
pub const PEER_REFUSALS: &[&str] = &["peer_unpaired", "revoked", "stale_revision", "rate_limited", "authority_stale"];
pub const FORWARD_OUTCOMES: &[&str] = &["forwarded", "endpoint_unreachable", "backpressured", "refused"];
pub const FORWARD_REQUEST_KINDS: &[&str] = &[PEER_KIND_SEND, PEER_KIND_DELIVERY_ACK];
pub const FORWARD_REFUSALS: &[&str] = &["peer_unpaired", "revoked", "rate_limited", "authority_stale"];
pub const PRESENCE_STATES: &[&str] = &["reachable", "unreachable"];

/// Delivery-ack signing domain separator.
pub const DELIVERY_ACK_DOMAIN: &str = "meshrix-peer-delivery-ack-v1";

/// `PRIVATE_RELAY_PEER_FORBIDDEN_KEYS` — byte-exact port.
pub const FORBIDDEN_PEER_KEYS: &[&str] = &[
    "apiKey", "arguments", "authorization", "body", "callbackUrl", "catalog",
    "catalogName", "content", "credential", "credentials", "execute", "grant",
    "grantId", "grants", "instructions", "message", "payload", "plaintext",
    "principal", "privateKey", "prompt", "result", "scope", "scopes",
    "secret", "serviceLocation", "task", "toolName", "token", "tool",
    "upstream", "upstreamHost",
];

/* ------------------------------ field parsers ------------------------------ */

/// Wire-level opaque identifier predicate (client-side assertion surface).
pub fn is_peer_opaque_id(value: &str) -> bool {
    is_opaque_id(value, MAX_OPAQUE_ID_BYTES)
}

fn is_opaque_id(value: &str, max_bytes: usize) -> bool {
    let b = value.as_bytes();
    b.len() >= 2
        && b.len() <= max_bytes
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(*c, b'.' | b'_' | b':' | b'-'))
}

fn bounded_text(v: &Value, max_bytes: usize) -> Option<String> {
    let s = v.as_str()?;
    let s = s.trim();
    (!s.is_empty() && s.len() <= max_bytes).then(|| s.to_string())
}

fn opaque_id(v: &Value, max_bytes: usize) -> Option<String> {
    bounded_text(v, max_bytes).filter(|s| is_opaque_id(s, max_bytes))
}

fn revision(v: &Value) -> Option<u64> {
    v.as_u64()
}

fn positive_revision(v: &Value) -> Option<u64> {
    v.as_u64().filter(|r| *r >= 1)
}

fn enum_value<'a>(v: &Value, allowed: &'a [&'a str]) -> Option<&'a str> {
    v.as_str().and_then(|s| allowed.iter().copied().find(|a| *a == s))
}

/// Canonical base64url of exactly `expected_bytes` decoded bytes — re-encode
/// must round-trip so padded/non-canonical spellings are rejected.
fn canonical_b64(v: &Value, expected_bytes: usize, max_bytes: usize) -> Option<String> {
    let s = bounded_text(v, max_bytes * 4 / 3 + 4)?;
    if s.len() % 4 == 1 {
        return None;
    }
    let bytes = b64u_decode(&s, max_bytes * 4 / 3 + 4).ok()?;
    (bytes.len() == expected_bytes && bytes.len() <= max_bytes && b64u_encode(&bytes) == s).then_some(s)
}

/// Canonical base64url bounded by decoded byte count.
fn opaque_bytes(v: &Value, max_bytes: usize) -> Option<String> {
    let s = bounded_text(v, max_bytes * 4 / 3 + 4)?;
    if s.len() % 4 == 1 {
        return None;
    }
    let bytes = b64u_decode(&s, max_bytes * 4 / 3 + 4).ok()?;
    (!bytes.is_empty() && bytes.len() <= max_bytes && b64u_encode(&bytes) == s).then_some(s)
}

fn ciphertext_digest(v: &Value) -> Option<String> {
    let s = bounded_text(v, 64)?;
    let rest = s.strip_prefix("sha256:")?;
    canonical_b64(&Value::from(rest), 32, 32)?;
    Some(s)
}

fn opaque_signature(v: &Value) -> Option<String> {
    canonical_b64(v, MAX_SIGNATURE_BYTES, MAX_SIGNATURE_BYTES)
}

/// `containsForbiddenPeerKeys` — recursive object scan.
pub fn contains_forbidden_peer_keys(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            map.keys().any(|k| FORBIDDEN_PEER_KEYS.contains(&k.as_str()))
                || map.values().any(contains_forbidden_peer_keys)
        }
        Value::Array(items) => items.iter().any(contains_forbidden_peer_keys),
        _ => false,
    }
}

fn exact_keys<'a>(v: &'a Value, expected: &[&'a str]) -> Option<&'a Map<String, Value>> {
    let obj = v.as_object()?;
    if obj.len() != expected.len() {
        return None;
    }
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let mut expected_sorted = expected.to_vec();
    expected_sorted.sort_unstable();
    (keys == expected_sorted).then_some(obj)
}

fn envelope(kind: &str, extras: Map<String, Value>) -> Value {
    let mut map = Map::new();
    map.insert("schemaVersion".into(), Value::from(PRIVATE_RELAY_PEER_SCHEMA_VERSION));
    map.insert("wireProtocol".into(), Value::from(PRIVATE_RELAY_PEER_WIRE));
    map.insert("kind".into(), Value::from(kind));
    map.extend(extras);
    Value::Object(map)
}

fn common_remote<'a>(v: &'a Value, kind: &str, extra: &[&'a str]) -> Option<&'a Map<String, Value>> {
    let obj = exact_keys(v, &[&["schemaVersion", "wireProtocol", "kind"], extra].concat())?;
    if contains_forbidden_peer_keys(v) {
        return None;
    }
    if obj["schemaVersion"].as_str() != Some(PRIVATE_RELAY_PEER_SCHEMA_VERSION)
        || obj["wireProtocol"].as_str() != Some(PRIVATE_RELAY_PEER_WIRE)
        || obj["kind"].as_str() != Some(kind)
    {
        return None;
    }
    Some(obj)
}

/* -------------------------------- wire types ------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerEnvelopeHeaders {
    /// "prekey" | "session"
    pub message_type: String,
    pub sender_bundle_id: String,
    pub recipient_bundle_id: String,
    pub prekey_id: Option<String>,
    pub signed_prekey_id: Option<String>,
    pub base_key_id: Option<String>,
}

/// The relay-visible envelope — `format` + `headers` + opaque `ciphertext`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerWireEnvelope {
    /// Signal profile label; "signal-pqxdh" in practice.
    pub format: String,
    pub headers: PeerEnvelopeHeaders,
    /// base64url of the serialized crypto `PeerEnvelope` JSON bytes.
    pub ciphertext: String,
}

pub fn parse_peer_envelope_headers(v: &Value) -> Option<PeerEnvelopeHeaders> {
    let obj = exact_keys(v, &["messageType", "senderBundleId", "recipientBundleId", "prekeyId", "signedPrekeyId", "baseKeyId"])?;
    Some(PeerEnvelopeHeaders {
        message_type: enum_value(&obj["messageType"], &[HEADER_TYPE_PREKEY, HEADER_TYPE_SESSION])?.to_string(),
        sender_bundle_id: opaque_id(&obj["senderBundleId"], MAX_OPAQUE_ID_BYTES)?,
        recipient_bundle_id: opaque_id(&obj["recipientBundleId"], MAX_OPAQUE_ID_BYTES)?,
        prekey_id: if obj["prekeyId"].is_null() { None } else { Some(opaque_id(&obj["prekeyId"], MAX_OPAQUE_ID_BYTES)?) },
        signed_prekey_id: if obj["signedPrekeyId"].is_null() { None } else { Some(opaque_id(&obj["signedPrekeyId"], MAX_OPAQUE_ID_BYTES)?) },
        base_key_id: if obj["baseKeyId"].is_null() { None } else { Some(opaque_id(&obj["baseKeyId"], MAX_OPAQUE_ID_BYTES)?) },
    })
}

pub fn parse_peer_envelope(v: &Value) -> Option<PeerWireEnvelope> {
    let obj = exact_keys(v, &["format", "headers", "ciphertext"])?;
    Some(PeerWireEnvelope {
        format: enum_value(&obj["format"], &[PROFILE_X3DH, PROFILE_PQXDH])?.to_string(),
        headers: parse_peer_envelope_headers(&obj["headers"])?,
        ciphertext: opaque_bytes(&obj["ciphertext"], MAX_ENVELOPE_BYTES)?,
    })
}

/// The device's published public bundle header record.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrekeyBundlePublication {
    pub format: String,
    pub bundle_id: String,
    pub revision: u64,
    /// base64url of the bundle JSON bytes.
    pub material: String,
}

pub fn parse_prekey_bundle_publication(v: &Value) -> Option<PrekeyBundlePublication> {
    let obj = exact_keys(v, &["format", "bundleId", "revision", "material"])?;
    Some(PrekeyBundlePublication {
        format: enum_value(&obj["format"], &[PROFILE_X3DH, PROFILE_PQXDH])?.to_string(),
        bundle_id: opaque_id(&obj["bundleId"], MAX_OPAQUE_ID_BYTES)?,
        revision: positive_revision(&obj["revision"])?,
        material: opaque_bytes(&obj["material"], MAX_BUNDLE_BYTES)?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerSend {
    pub tenant_id: String,
    pub route_id: String,
    pub sender_device_id: String,
    pub recipient_device_id: String,
    pub message_id: String,
    pub envelope: PeerWireEnvelope,
}

/// Message identity tuple shared by outbox/inbox rows and ACKs.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerMessageIdentity {
    pub tenant_id: String,
    pub route_id: String,
    pub sender_device_id: String,
    pub recipient_device_id: String,
    pub message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerForwarded {
    pub tenant_id: String,
    pub route_id: String,
    /// "peer-send" | "peer-delivery-ack"
    pub request_kind: String,
    pub source_device_id: String,
    pub target_device_id: String,
    pub message_id: String,
    /// forwarded | endpoint_unreachable | backpressured | refused
    pub outcome: String,
    pub refusal: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerDeliveryAckSigningInput {
    pub tenant_id: String,
    pub route_id: String,
    pub sender_device_id: String,
    pub recipient_device_id: String,
    pub message_id: String,
    /// "sha256:<b64url>" over the exact decoded envelope ciphertext bytes.
    pub ciphertext_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerDeliveryAck {
    pub tenant_id: String,
    pub route_id: String,
    pub sender_device_id: String,
    pub recipient_device_id: String,
    pub message_id: String,
    pub ciphertext_digest: String,
    /// base64url of the XEdDSA signature by the recipient's Signal identity.
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerPresence {
    pub tenant_id: String,
    pub route_id: String,
    pub device_id: String,
    pub peer_device_id: String,
    /// reachable | unreachable
    pub state: String,
    /// Live session id when reachable.
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBundlePublish {
    pub tenant_id: String,
    pub route_id: String,
    pub device_id: String,
    pub bundle: PrekeyBundlePublication,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBundlePublished {
    pub route_id: String,
    pub device_id: String,
    pub bundle_id: String,
    /// published | superseded | refused
    pub outcome: String,
    pub current_revision: u64,
    pub refusal: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBundleFetch {
    pub tenant_id: String,
    pub route_id: String,
    pub device_id: String,
    pub peer_device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerBundle {
    pub route_id: String,
    pub device_id: String,
    /// available | unpublished | refused
    pub state: String,
    pub bundle: Option<PrekeyBundlePublication>,
    pub refusal: Option<String>,
}

/* ------------------------------- typed parses ------------------------------ */

pub fn parse_peer_send(v: &Value) -> Option<PeerSend> {
    let obj = common_remote(v, PEER_KIND_SEND, &["tenantId", "routeId", "senderDeviceId", "recipientDeviceId", "messageId", "envelope"])?;
    let out = PeerSend {
        tenant_id: opaque_id(&obj["tenantId"], MAX_OPAQUE_ID_BYTES)?,
        route_id: opaque_id(&obj["routeId"], MAX_OPAQUE_ID_BYTES)?,
        sender_device_id: opaque_id(&obj["senderDeviceId"], MAX_OPAQUE_ID_BYTES)?,
        recipient_device_id: opaque_id(&obj["recipientDeviceId"], MAX_OPAQUE_ID_BYTES)?,
        message_id: opaque_id(&obj["messageId"], MAX_OPAQUE_ID_BYTES)?,
        envelope: parse_peer_envelope(&obj["envelope"])?,
    };
    (out.sender_device_id != out.recipient_device_id).then_some(out)
}

pub fn parse_peer_forwarded(v: &Value) -> Option<PeerForwarded> {
    let obj = common_remote(v, PEER_KIND_FORWARDED, &["tenantId", "routeId", "requestKind", "sourceDeviceId", "targetDeviceId", "messageId", "outcome", "refusal"])?;
    let outcome = enum_value(&obj["outcome"], FORWARD_OUTCOMES)?.to_string();
    let refusal = if outcome == "refused" {
        Some(enum_value(&obj["refusal"], FORWARD_REFUSALS)?.to_string())
    } else {
        obj["refusal"].is_null().then_some(())?;
        None
    };
    let out = PeerForwarded {
        tenant_id: opaque_id(&obj["tenantId"], MAX_OPAQUE_ID_BYTES)?,
        route_id: opaque_id(&obj["routeId"], MAX_OPAQUE_ID_BYTES)?,
        request_kind: enum_value(&obj["requestKind"], FORWARD_REQUEST_KINDS)?.to_string(),
        source_device_id: opaque_id(&obj["sourceDeviceId"], MAX_OPAQUE_ID_BYTES)?,
        target_device_id: opaque_id(&obj["targetDeviceId"], MAX_OPAQUE_ID_BYTES)?,
        message_id: opaque_id(&obj["messageId"], MAX_OPAQUE_ID_BYTES)?,
        outcome,
        refusal,
    };
    (out.source_device_id != out.target_device_id).then_some(out)
}

pub fn parse_peer_delivery_ack_signing_input(v: &Value) -> Option<PeerDeliveryAckSigningInput> {
    let obj = exact_keys(v, &["tenantId", "routeId", "senderDeviceId", "recipientDeviceId", "messageId", "ciphertextDigest"])?;
    if contains_forbidden_peer_keys(v) {
        return None;
    }
    let out = PeerDeliveryAckSigningInput {
        tenant_id: opaque_id(&obj["tenantId"], MAX_OPAQUE_ID_BYTES)?,
        route_id: opaque_id(&obj["routeId"], MAX_OPAQUE_ID_BYTES)?,
        sender_device_id: opaque_id(&obj["senderDeviceId"], MAX_OPAQUE_ID_BYTES)?,
        recipient_device_id: opaque_id(&obj["recipientDeviceId"], MAX_OPAQUE_ID_BYTES)?,
        message_id: opaque_id(&obj["messageId"], MAX_OPAQUE_ID_BYTES)?,
        ciphertext_digest: ciphertext_digest(&obj["ciphertextDigest"])?,
    };
    (out.sender_device_id != out.recipient_device_id).then_some(out)
}

pub fn parse_peer_delivery_ack(v: &Value) -> Option<PeerDeliveryAck> {
    let obj = common_remote(v, PEER_KIND_DELIVERY_ACK, &["tenantId", "routeId", "senderDeviceId", "recipientDeviceId", "messageId", "ciphertextDigest", "signature"])?;
    let out = PeerDeliveryAck {
        tenant_id: opaque_id(&obj["tenantId"], MAX_OPAQUE_ID_BYTES)?,
        route_id: opaque_id(&obj["routeId"], MAX_OPAQUE_ID_BYTES)?,
        sender_device_id: opaque_id(&obj["senderDeviceId"], MAX_OPAQUE_ID_BYTES)?,
        recipient_device_id: opaque_id(&obj["recipientDeviceId"], MAX_OPAQUE_ID_BYTES)?,
        message_id: opaque_id(&obj["messageId"], MAX_OPAQUE_ID_BYTES)?,
        ciphertext_digest: ciphertext_digest(&obj["ciphertextDigest"])?,
        signature: opaque_signature(&obj["signature"])?,
    };
    (out.sender_device_id != out.recipient_device_id).then_some(out)
}

pub fn parse_peer_bundle_publish(v: &Value) -> Option<PeerBundlePublish> {
    let obj = common_remote(v, PEER_KIND_BUNDLE_PUBLISH, &["tenantId", "routeId", "deviceId", "bundle"])?;
    Some(PeerBundlePublish {
        tenant_id: opaque_id(&obj["tenantId"], MAX_OPAQUE_ID_BYTES)?,
        route_id: opaque_id(&obj["routeId"], MAX_OPAQUE_ID_BYTES)?,
        device_id: opaque_id(&obj["deviceId"], MAX_OPAQUE_ID_BYTES)?,
        bundle: parse_prekey_bundle_publication(&obj["bundle"])?,
    })
}

pub fn parse_peer_bundle_published(v: &Value) -> Option<PeerBundlePublished> {
    let obj = common_remote(v, PEER_KIND_BUNDLE_PUBLISHED, &["routeId", "deviceId", "bundleId", "outcome", "currentRevision", "refusal"])?;
    let outcome = enum_value(&obj["outcome"], BUNDLE_PUBLISH_OUTCOMES)?.to_string();
    let refusal = if outcome == "refused" {
        Some(enum_value(&obj["refusal"], PEER_REFUSALS)?.to_string())
    } else {
        obj["refusal"].is_null().then_some(())?;
        None
    };
    Some(PeerBundlePublished {
        route_id: opaque_id(&obj["routeId"], MAX_OPAQUE_ID_BYTES)?,
        device_id: opaque_id(&obj["deviceId"], MAX_OPAQUE_ID_BYTES)?,
        bundle_id: opaque_id(&obj["bundleId"], MAX_OPAQUE_ID_BYTES)?,
        outcome,
        current_revision: revision(&obj["currentRevision"])?,
        refusal,
    })
}

pub fn parse_peer_bundle_fetch(v: &Value) -> Option<PeerBundleFetch> {
    let obj = common_remote(v, PEER_KIND_BUNDLE_FETCH, &["tenantId", "routeId", "deviceId", "peerDeviceId"])?;
    let out = PeerBundleFetch {
        tenant_id: opaque_id(&obj["tenantId"], MAX_OPAQUE_ID_BYTES)?,
        route_id: opaque_id(&obj["routeId"], MAX_OPAQUE_ID_BYTES)?,
        device_id: opaque_id(&obj["deviceId"], MAX_OPAQUE_ID_BYTES)?,
        peer_device_id: opaque_id(&obj["peerDeviceId"], MAX_OPAQUE_ID_BYTES)?,
    };
    (out.device_id != out.peer_device_id).then_some(out)
}

pub fn parse_peer_bundle(v: &Value) -> Option<PeerBundle> {
    let obj = common_remote(v, PEER_KIND_BUNDLE, &["routeId", "deviceId", "state", "bundle", "refusal"])?;
    let state = enum_value(&obj["state"], BUNDLE_STATES)?.to_string();
    let bundle = if state == "available" {
        Some(parse_prekey_bundle_publication(&obj["bundle"])?)
    } else {
        obj["bundle"].is_null().then_some(())?;
        None
    };
    let refusal = if state == "refused" {
        Some(enum_value(&obj["refusal"], PEER_REFUSALS)?.to_string())
    } else {
        obj["refusal"].is_null().then_some(())?;
        None
    };
    Some(PeerBundle {
        route_id: opaque_id(&obj["routeId"], MAX_OPAQUE_ID_BYTES)?,
        device_id: opaque_id(&obj["deviceId"], MAX_OPAQUE_ID_BYTES)?,
        state,
        bundle,
        refusal,
    })
}

pub fn parse_peer_presence(v: &Value) -> Option<PeerPresence> {
    let obj = common_remote(v, PEER_KIND_PRESENCE, &["tenantId", "routeId", "deviceId", "peerDeviceId", "state", "sessionId"])?;
    let state = enum_value(&obj["state"], PRESENCE_STATES)?.to_string();
    let session_id = if state == "reachable" {
        Some(opaque_id(&obj["sessionId"], MAX_OPAQUE_ID_BYTES)?)
    } else {
        obj["sessionId"].is_null().then_some(())?;
        None
    };
    let out = PeerPresence {
        tenant_id: opaque_id(&obj["tenantId"], MAX_OPAQUE_ID_BYTES)?,
        route_id: opaque_id(&obj["routeId"], MAX_OPAQUE_ID_BYTES)?,
        device_id: opaque_id(&obj["deviceId"], MAX_OPAQUE_ID_BYTES)?,
        peer_device_id: opaque_id(&obj["peerDeviceId"], MAX_OPAQUE_ID_BYTES)?,
        state,
        session_id,
    };
    (out.device_id != out.peer_device_id).then_some(out)
}

/// `parsePrivateRelayPeerMessage` — kind-dispatched strict parse; rejects
/// unknown kinds and any object carrying forbidden keys.
pub fn parse_private_relay_peer_message(v: &Value) -> Option<Value> {
    if !v.is_object() || contains_forbidden_peer_keys(v) {
        return None;
    }
    let kind = v.get("kind")?.as_str()?;
    let ok = match kind {
        PEER_KIND_BUNDLE_PUBLISH => parse_peer_bundle_publish(v).is_some(),
        PEER_KIND_BUNDLE_PUBLISHED => parse_peer_bundle_published(v).is_some(),
        PEER_KIND_BUNDLE_FETCH => parse_peer_bundle_fetch(v).is_some(),
        PEER_KIND_BUNDLE => parse_peer_bundle(v).is_some(),
        PEER_KIND_PRESENCE => parse_peer_presence(v).is_some(),
        PEER_KIND_SEND => parse_peer_send(v).is_some(),
        PEER_KIND_FORWARDED => parse_peer_forwarded(v).is_some(),
        PEER_KIND_DELIVERY_ACK => parse_peer_delivery_ack(v).is_some(),
        _ => return None,
    };
    ok.then(|| v.clone())
}

/* --------------------------------- creators -------------------------------- */

fn must<T>(v: Option<T>, what: &str) -> T {
    v.unwrap_or_else(|| panic!("{what} does not satisfy the peer wire contract"))
}

fn envelope_to_json(e: &PeerWireEnvelope) -> Value {
    let mut headers = Map::new();
    headers.insert("messageType".into(), Value::from(e.headers.message_type.clone()));
    headers.insert("senderBundleId".into(), Value::from(e.headers.sender_bundle_id.clone()));
    headers.insert("recipientBundleId".into(), Value::from(e.headers.recipient_bundle_id.clone()));
    headers.insert("prekeyId".into(), e.headers.prekey_id.as_ref().map_or(Value::Null, |v| Value::from(v.clone())));
    headers.insert("signedPrekeyId".into(), e.headers.signed_prekey_id.as_ref().map_or(Value::Null, |v| Value::from(v.clone())));
    headers.insert("baseKeyId".into(), e.headers.base_key_id.as_ref().map_or(Value::Null, |v| Value::from(v.clone())));
    let mut env = Map::new();
    env.insert("format".into(), Value::from(e.format.clone()));
    env.insert("headers".into(), Value::Object(headers));
    env.insert("ciphertext".into(), Value::from(e.ciphertext.clone()));
    Value::Object(env)
}

fn publication_to_json(p: &PrekeyBundlePublication) -> Value {
    serde_json::json!({
        "format": p.format,
        "bundleId": p.bundle_id,
        "revision": p.revision,
        "material": p.material,
    })
}

pub fn create_peer_send(v: &PeerSend) -> Value {
    let mut extras = Map::new();
    extras.insert("tenantId".into(), Value::from(v.tenant_id.clone()));
    extras.insert("routeId".into(), Value::from(v.route_id.clone()));
    extras.insert("senderDeviceId".into(), Value::from(v.sender_device_id.clone()));
    extras.insert("recipientDeviceId".into(), Value::from(v.recipient_device_id.clone()));
    extras.insert("messageId".into(), Value::from(v.message_id.clone()));
    extras.insert("envelope".into(), envelope_to_json(&v.envelope));
    let out = envelope(PEER_KIND_SEND, extras);
    must(parse_peer_send(&out), "peer-send");
    out
}

pub fn create_peer_bundle_publish(v: &PeerBundlePublish) -> Value {
    let mut extras = Map::new();
    extras.insert("tenantId".into(), Value::from(v.tenant_id.clone()));
    extras.insert("routeId".into(), Value::from(v.route_id.clone()));
    extras.insert("deviceId".into(), Value::from(v.device_id.clone()));
    extras.insert("bundle".into(), publication_to_json(&v.bundle));
    let out = envelope(PEER_KIND_BUNDLE_PUBLISH, extras);
    must(parse_peer_bundle_publish(&out), "peer-bundle-publish");
    out
}

pub fn create_peer_bundle_fetch(v: &PeerBundleFetch) -> Value {
    let mut extras = Map::new();
    extras.insert("tenantId".into(), Value::from(v.tenant_id.clone()));
    extras.insert("routeId".into(), Value::from(v.route_id.clone()));
    extras.insert("deviceId".into(), Value::from(v.device_id.clone()));
    extras.insert("peerDeviceId".into(), Value::from(v.peer_device_id.clone()));
    let out = envelope(PEER_KIND_BUNDLE_FETCH, extras);
    must(parse_peer_bundle_fetch(&out), "peer-bundle-fetch");
    out
}

pub fn create_peer_presence(v: &PeerPresence) -> Value {
    let mut extras = Map::new();
    extras.insert("tenantId".into(), Value::from(v.tenant_id.clone()));
    extras.insert("routeId".into(), Value::from(v.route_id.clone()));
    extras.insert("deviceId".into(), Value::from(v.device_id.clone()));
    extras.insert("peerDeviceId".into(), Value::from(v.peer_device_id.clone()));
    extras.insert("state".into(), Value::from(v.state.clone()));
    extras.insert("sessionId".into(), if v.state == "reachable" {
        v.session_id.as_ref().map_or(Value::Null, |s| Value::from(s.clone()))
    } else {
        Value::Null
    });
    let out = envelope(PEER_KIND_PRESENCE, extras);
    must(parse_peer_presence(&out), "peer-presence");
    out
}

pub fn create_peer_delivery_ack(v: &PeerDeliveryAck) -> Value {
    let mut extras = Map::new();
    extras.insert("tenantId".into(), Value::from(v.tenant_id.clone()));
    extras.insert("routeId".into(), Value::from(v.route_id.clone()));
    extras.insert("senderDeviceId".into(), Value::from(v.sender_device_id.clone()));
    extras.insert("recipientDeviceId".into(), Value::from(v.recipient_device_id.clone()));
    extras.insert("messageId".into(), Value::from(v.message_id.clone()));
    extras.insert("ciphertextDigest".into(), Value::from(v.ciphertext_digest.clone()));
    extras.insert("signature".into(), Value::from(v.signature.clone()));
    let out = envelope(PEER_KIND_DELIVERY_ACK, extras);
    must(parse_peer_delivery_ack(&out), "peer-delivery-ack");
    out
}

/* --------------------------- digest / transcript ---------------------------- */

/// `digestPeerSendCiphertext` — sha256 of the *decoded* ciphertext bytes.
pub fn digest_peer_send_ciphertext(send: &PeerSend) -> String {
    let bytes = b64u_decode(&send.envelope.ciphertext, MAX_ENVELOPE_BYTES * 4 / 3 + 4)
        .unwrap_or_default();
    format!("sha256:{}", b64u_encode(&Sha256::digest(&bytes)))
}

/// Build the recipient's signing input from the exact received send.
pub fn peer_delivery_ack_signing_input_for_send(send: &PeerSend) -> Option<PeerDeliveryAckSigningInput> {
    let input = serde_json::json!({
        "tenantId": send.tenant_id,
        "routeId": send.route_id,
        "senderDeviceId": send.sender_device_id,
        "recipientDeviceId": send.recipient_device_id,
        "messageId": send.message_id,
        "ciphertextDigest": digest_peer_send_ciphertext(send),
    });
    parse_peer_delivery_ack_signing_input(&input)
}

/// Domain-separated newline-delimited XEdDSA transcript.
pub fn peer_delivery_ack_transcript(v: &PeerDeliveryAckSigningInput) -> String {
    [
        DELIVERY_ACK_DOMAIN,
        &v.tenant_id,
        &v.route_id,
        &v.sender_device_id,
        &v.recipient_device_id,
        &v.message_id,
        &v.ciphertext_digest,
    ]
    .join("\n")
}

/// Exact route/device/message/digest binding between an ACK and a send.
pub fn peer_delivery_ack_matches_send(ack: &PeerDeliveryAck, send: &PeerSend) -> bool {
    ack.tenant_id == send.tenant_id
        && ack.route_id == send.route_id
        && ack.sender_device_id == send.sender_device_id
        && ack.recipient_device_id == send.recipient_device_id
        && ack.message_id == send.message_id
        && ack.ciphertext_digest == digest_peer_send_ciphertext(send)
}

/// Sender-scoped retry classification for a replayed send.
pub fn peer_send_replay_class(first: &Value, replay: &Value) -> Option<&'static str> {
    let a = parse_peer_send(first)?;
    let b = parse_peer_send(replay)?;
    if a.tenant_id != b.tenant_id
        || a.route_id != b.route_id
        || a.sender_device_id != b.sender_device_id
        || a.recipient_device_id != b.recipient_device_id
        || a.message_id != b.message_id
    {
        return Some("distinct");
    }
    Some(if serde_json::to_value(&a.envelope).unwrap_or(Value::Null) == serde_json::to_value(&b.envelope).unwrap_or(Value::Null) {
        "retry"
    } else {
        "conflict"
    })
}

/// `peer_channel_not_admitted` — thrown when a peer request is offered while
/// the forward session cannot carry it.
pub fn peer_channel_not_admitted_error() -> crate::error::EntryError {
    crate::error::entry_error(
        "peer_channel_not_admitted",
        "The relay session is not admitted; peer messages cannot be carried until it is live.",
    )
}

/* --------------------------------- demux ---------------------------------- */

/// True when a top-level relay wire object carries the peer schema stamp and
/// a `peer-` kind. Peer objects bypass the session driver — they are routed
/// into the peer client inbox regardless of whether strict parsing succeeds.
pub fn is_peer_schema_message(v: &Value) -> bool {
    v.get("schemaVersion").and_then(Value::as_str) == Some(PRIVATE_RELAY_PEER_SCHEMA_VERSION)
        && v.get("kind").and_then(Value::as_str).is_some_and(|k| k.starts_with("peer-"))
}

/// The `kind` field of a peer-schema message, when present.
pub fn peer_message_kind(v: &Value) -> Option<&str> {
    if !is_peer_schema_message(v) {
        return None;
    }
    v.get("kind").and_then(Value::as_str)
}
