//! Exact-key encrypted envelope — port of `peer-crypto/envelope.ts`.
//! Format is wire-visible JSON; `body` is base64url of the serialized
//! libsignal ciphertext (PreKeySignalMessage or SignalMessage bytes).

use serde_json::Value;

use crate::b64::{b64u_decode, b64u_encode};
use crate::error::{entry_error, Result};
use crate::peer::types::{
    assert_peer_id, is_peer_id, PEER_ENVELOPE_FORMAT, PEER_ENVELOPE_VERSION,
    PEER_MAX_CIPHERTEXT_BYTES, PEER_MAX_ENVELOPE_BYTES,
};

fn malformed() -> crate::error::EntryError {
    entry_error("peer_envelope_malformed", "The peer envelope is malformed or out of bounds.")
}

const ENVELOPE_KEYS: &[&str] = &["format", "version", "senderPeerId", "senderDeviceId", "messageType", "body"];

/// Cipher message kinds carried inside the envelope — `prekey` for the first
/// message of a session (carries the X3DH/PQXDH preamble), `signal` after.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerEnvelopeMessageType {
    PreKey,
    Signal,
}

impl PeerEnvelopeMessageType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PreKey => "prekey",
            Self::Signal => "signal",
        }
    }
}

#[derive(Debug, Clone)]
pub struct PeerEnvelope {
    pub sender_peer_id: String,
    pub sender_device_id: u32,
    pub message_type: PeerEnvelopeMessageType,
    /// Serialized libsignal ciphertext bytes.
    pub body: Vec<u8>,
}

impl PeerEnvelope {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "format": PEER_ENVELOPE_FORMAT,
            "version": PEER_ENVELOPE_VERSION,
            "senderPeerId": self.sender_peer_id,
            "senderDeviceId": self.sender_device_id,
            "messageType": self.message_type.as_str(),
            "body": b64u_encode(&self.body),
        })
    }

    pub fn serialize(&self) -> Result<Vec<u8>> {
        let text = serde_json::to_string(&self.to_json())
            .map_err(|_| entry_error("peer_envelope_malformed", "The peer envelope cannot be encoded."))?;
        if text.len() > PEER_MAX_ENVELOPE_BYTES {
            return Err(entry_error(
                "peer_envelope_too_large",
                "The peer envelope exceeds the relay payload limit.",
            ));
        }
        Ok(text.into_bytes())
    }

    /// Strict exact-key parse. Every field type-checked and bounded.
    pub fn from_json(value: &Value) -> Result<Self> {
        let obj = value.as_object().ok_or_else(malformed)?;
        if obj.len() != ENVELOPE_KEYS.len()
            || !ENVELOPE_KEYS.iter().all(|k| obj.contains_key(*k))
        {
            return Err(malformed());
        }
        if obj["format"].as_str() != Some(PEER_ENVELOPE_FORMAT)
            || obj["version"].as_u64() != Some(PEER_ENVELOPE_VERSION)
        {
            return Err(malformed());
        }
        let sender_peer_id = obj["senderPeerId"].as_str().ok_or_else(malformed)?.to_string();
        assert_peer_id(&sender_peer_id)?;
        let sender_device_id = obj["senderDeviceId"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v >= 1)
            .ok_or_else(malformed)?;
        let message_type = match obj["messageType"].as_str() {
            Some("prekey") => PeerEnvelopeMessageType::PreKey,
            Some("signal") => PeerEnvelopeMessageType::Signal,
            _ => return Err(malformed()),
        };
        let body_str = obj["body"].as_str().ok_or_else(malformed)?;
        let body = b64u_decode(body_str, PEER_MAX_CIPHERTEXT_BYTES * 4 / 3 + 8).map_err(|_| malformed())?;
        if body.is_empty() || body.len() > PEER_MAX_CIPHERTEXT_BYTES {
            return Err(malformed());
        }
        Ok(Self { sender_peer_id, sender_device_id, message_type, body })
    }

    pub fn parse_bytes(raw: &[u8]) -> Result<Self> {
        if raw.is_empty() || raw.len() > PEER_MAX_ENVELOPE_BYTES {
            return Err(malformed());
        }
        let value: Value = serde_json::from_slice(raw).map_err(|_| malformed())?;
        Self::from_json(&value)
    }
}

pub fn is_valid_peer_id(id: &str) -> bool {
    is_peer_id(id)
}
