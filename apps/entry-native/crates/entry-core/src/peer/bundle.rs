//! Prekey bundle generation and strict parsing — port of
//! `peer-crypto/bundle.ts`. Exact-key JSON, all fields bounded.

use libsignal_protocol::{
    GenericSignedPreKey, KyberPreKeyId, KyberPreKeyRecord, PreKeyBundle, PreKeyId,
    PreKeyRecord, ProtocolAddress, PublicKey, SignedPreKeyId, SignedPreKeyRecord,
};
use serde_json::Value;

use crate::b64::{b64u_decode, b64u_encode};
use crate::error::{entry_error, Result};
use crate::peer::identity::PeerIdentity;
use crate::peer::store::{PeerCryptoStore, PeerPrekeyState, StoredPreKeyRecord};
use crate::peer::types::{
    assert_peer_id, is_peer_id, PEER_MAX_PREKEY_ID, PEER_PREKEY_BUNDLE_FORMAT,
    PEER_PREKEY_BUNDLE_VERSION,
};

fn malformed() -> crate::error::EntryError {
    entry_error("peer_bundle_malformed", "The peer prekey bundle is malformed or out of bounds.")
}

const BUNDLE_KEYS: &[&str] = &[
    "format", "version", "peerId", "deviceId", "registrationId", "identityKey",
    "signedPreKeyId", "signedPreKey", "signedPreKeySignature",
    "preKeyId", "preKey", "kyberPreKeyId", "kyberPreKey", "kyberPreKeySignature",
];

fn get_u32(v: &Value, key: &str) -> Result<u32> {
    v.get(key)
        .and_then(|x| x.as_u64())
        .and_then(|x| u32::try_from(x).ok())
        .filter(|x| *x >= 1 && *x <= PEER_MAX_PREKEY_ID)
        .ok_or_else(malformed)
}

fn get_b64(v: &Value, key: &str, max: usize) -> Result<Vec<u8>> {
    let s = v.get(key).and_then(|x| x.as_str()).ok_or_else(malformed)?;
    b64u_decode(s, max).map_err(|_| malformed())
}

/// The public bundle shape published to the relay directory.
#[derive(Debug, Clone)]
pub struct PeerPreKeyBundle {
    pub peer_id: String,
    pub device_id: u32,
    pub registration_id: u32,
    /// Raw PublicKey bytes.
    pub identity_key: Vec<u8>,
    pub signed_pre_key_id: u32,
    pub signed_pre_key: Vec<u8>,
    pub signed_pre_key_signature: Vec<u8>,
    pub pre_key_id: Option<u32>,
    pub pre_key: Option<Vec<u8>>,
    pub kyber_pre_key_id: u32,
    pub kyber_pre_key: Vec<u8>,
    pub kyber_pre_key_signature: Vec<u8>,
}

impl PeerPreKeyBundle {
    pub fn to_json(&self) -> Value {
        let mut out = serde_json::json!({
            "format": PEER_PREKEY_BUNDLE_FORMAT,
            "version": PEER_PREKEY_BUNDLE_VERSION,
            "peerId": self.peer_id,
            "deviceId": self.device_id,
            "registrationId": self.registration_id,
            "identityKey": b64u_encode(&self.identity_key),
            "signedPreKeyId": self.signed_pre_key_id,
            "signedPreKey": b64u_encode(&self.signed_pre_key),
            "signedPreKeySignature": b64u_encode(&self.signed_pre_key_signature),
            "kyberPreKeyId": self.kyber_pre_key_id,
            "kyberPreKey": b64u_encode(&self.kyber_pre_key),
            "kyberPreKeySignature": b64u_encode(&self.kyber_pre_key_signature),
        });
        if let (Some(id), Some(key)) = (self.pre_key_id, &self.pre_key) {
            out["preKeyId"] = Value::from(id);
            out["preKey"] = Value::from(b64u_encode(key));
        }
        out
    }

    /// Strict exact-key parse — every field bounded.
    pub fn from_json(value: &Value) -> Result<Self> {
        let obj = value.as_object().ok_or_else(malformed)?;
        for key in obj.keys() {
            if !BUNDLE_KEYS.contains(&key.as_str()) {
                return Err(malformed());
            }
        }
        for required in [
            "format", "version", "peerId", "deviceId", "registrationId", "identityKey",
            "signedPreKeyId", "signedPreKey", "signedPreKeySignature",
            "kyberPreKeyId", "kyberPreKey", "kyberPreKeySignature",
        ] {
            if !obj.contains_key(required) {
                return Err(malformed());
            }
        }
        if obj["format"].as_str() != Some(PEER_PREKEY_BUNDLE_FORMAT)
            || obj["version"].as_u64() != Some(PEER_PREKEY_BUNDLE_VERSION)
        {
            return Err(malformed());
        }
        let peer_id = obj["peerId"].as_str().ok_or_else(malformed)?.to_string();
        assert_peer_id(&peer_id)?;
        let device_id = obj["deviceId"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v >= 1)
            .ok_or_else(malformed)?;
        let registration_id = obj["registrationId"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .ok_or_else(malformed)?;

        let has_pre_key_id = obj.contains_key("preKeyId");
        let has_pre_key = obj.contains_key("preKey");
        if has_pre_key_id != has_pre_key {
            return Err(malformed());
        }
        let (pre_key_id, pre_key) = if has_pre_key {
            (
                Some(get_u32(value, "preKeyId")?),
                Some(get_b64(value, "preKey", 128)?),
            )
        } else {
            (None, None)
        };

        Ok(Self {
            peer_id,
            device_id,
            registration_id,
            identity_key: get_b64(value, "identityKey", 128)?,
            signed_pre_key_id: get_u32(value, "signedPreKeyId")?,
            signed_pre_key: get_b64(value, "signedPreKey", 128)?,
            signed_pre_key_signature: get_b64(value, "signedPreKeySignature", 128)?,
            pre_key_id,
            pre_key,
            kyber_pre_key_id: get_u32(value, "kyberPreKeyId")?,
            kyber_pre_key: get_b64(value, "kyberPreKey", 4096)?,
            kyber_pre_key_signature: get_b64(value, "kyberPreKeySignature", 128)?,
        })
    }

    /// Build the libsignal `PreKeyBundle` + validated ProtocolAddress for
    /// `process_prekey_bundle`.
    pub fn to_signal_bundle(&self) -> Result<(ProtocolAddress, PreKeyBundle)> {
        let identity_key = libsignal_protocol::IdentityKey::try_from(self.identity_key.as_slice())
            .map_err(|_| malformed())?;
        let device_id: libsignal_protocol::DeviceId = self
            .device_id
            .try_into()
            .map_err(|_| malformed())?;
        let address = ProtocolAddress::new(self.peer_id.clone(), device_id);

        let signed_pre_key_public = PublicKey::deserialize(&self.signed_pre_key)
            .map_err(|_| malformed())?;
        let kyber_pre_key_public = libsignal_protocol::kem::PublicKey::deserialize(&self.kyber_pre_key)
            .map_err(|_| malformed())?;

        let ec_pre_key = match (&self.pre_key_id, &self.pre_key) {
            (Some(id), Some(bytes)) => Some((
                PreKeyId::from(*id),
                PublicKey::deserialize(bytes).map_err(|_| malformed())?,
            )),
            _ => None,
        };

        let bundle = PreKeyBundle::new(
            self.registration_id,
            device_id,
            ec_pre_key,
            SignedPreKeyId::from(self.signed_pre_key_id),
            signed_pre_key_public,
            self.signed_pre_key_signature.clone(),
            KyberPreKeyId::from(self.kyber_pre_key_id),
            kyber_pre_key_public,
            self.kyber_pre_key_signature.clone(),
            identity_key,
        )
        .map_err(|_| malformed())?;
        Ok((address, bundle))
    }
}

/// Pick the next unpublished one-time + Kyber prekeys, mark them `published`,
/// and emit the wire bundle — `generate_peer_prekey_bundle` in TS.
pub fn generate_peer_prekey_bundle(
    identity: &PeerIdentity,
    store: &dyn PeerCryptoStore,
) -> Result<PeerPreKeyBundle> {
    let signed_ids = store.list_signed_pre_keys()?;
    let Some(&signed_id) = signed_ids.iter().max() else {
        return Err(entry_error(
            "peer_state_invalid",
            "No signed prekey exists; the identity cannot publish a bundle.",
        ));
    };
    let Some(signed_bytes) = store.load_signed_pre_key(signed_id)? else {
        return Err(entry_error("peer_state_invalid", "The newest signed prekey cannot be loaded."));
    };
    let signed = SignedPreKeyRecord::deserialize(&signed_bytes).map_err(|_| {
        entry_error("peer_state_invalid", "The newest signed prekey cannot be deserialized.")
    })?;

    let one_time = store
        .list_pre_keys()?
        .into_iter()
        .filter(|e| e.state == PeerPrekeyState::Available)
        .min_by_key(|e| e.id);
    let mut claimed_one_time: Option<u32> = None;
    let (pre_key_id, pre_key) = match one_time {
        Some(entry) => {
            let Some(record) = store.load_pre_key(entry.id)? else {
                return Err(entry_error("peer_state_invalid", "The chosen one-time prekey cannot be loaded."));
            };
            let parsed = PreKeyRecord::deserialize(&record.record).map_err(|_| {
                entry_error("peer_state_invalid", "The chosen one-time prekey cannot be deserialized.")
            })?;
            store.save_pre_key(&StoredPreKeyRecord {
                id: entry.id,
                state: PeerPrekeyState::Published,
                record: record.record.clone(),
            })?;
            claimed_one_time = Some(entry.id);
            (Some(entry.id), Some(parsed.public_key().map_err(|_| {
                entry_error("peer_state_invalid", "The chosen one-time prekey has no public key.")
            })?.serialize().to_vec()))
        }
        None => (None, None),
    };

    let kyber_entry = store
        .list_kyber_pre_keys()?
        .into_iter()
        .filter(|e| e.state == PeerPrekeyState::Available)
        .min_by_key(|e| e.id);
    let Some(kyber_entry) = kyber_entry else {
        if let Some(id) = claimed_one_time {
            if let Some(record) = store.load_pre_key(id)? {
                let _ = store.save_pre_key(&StoredPreKeyRecord { id, state: PeerPrekeyState::Available, record: record.record });
            }
        }
        return Err(entry_error(
            "peer_state_invalid",
            "The Kyber prekey pool is empty; replenish it before publishing a bundle.",
        ));
    };
    let Some(kyber_record) = store.load_kyber_pre_key(kyber_entry.id)? else {
        return Err(entry_error("peer_state_invalid", "The chosen Kyber prekey cannot be loaded."));
    };
    let kyber = KyberPreKeyRecord::deserialize(&kyber_record.record).map_err(|_| {
        entry_error("peer_state_invalid", "The chosen Kyber prekey cannot be deserialized.")
    })?;
    if let Err(e) = store.save_kyber_pre_key(&StoredPreKeyRecord {
        id: kyber_entry.id,
        state: PeerPrekeyState::Published,
        record: kyber_record.record.clone(),
    }) {
        if let Some(id) = claimed_one_time {
            if let Some(record) = store.load_pre_key(id)? {
                let _ = store.save_pre_key(&StoredPreKeyRecord { id, state: PeerPrekeyState::Available, record: record.record });
            }
        }
        return Err(e);
    }

    let kyber_public = kyber
        .public_key()
        .map_err(|_| entry_error("peer_state_invalid", "The chosen Kyber prekey has no public key."))?;
    let kyber_signature = kyber
        .signature()
        .map_err(|_| entry_error("peer_state_invalid", "The chosen Kyber prekey has no signature."))?;

    Ok(PeerPreKeyBundle {
        peer_id: identity.peer_id.clone(),
        device_id: identity.device_id,
        registration_id: identity.registration_id,
        identity_key: identity.identity_key_pair().public_key().serialize().to_vec(),
        signed_pre_key_id: signed.id().map_err(|_| entry_error("peer_state_invalid", "The signed prekey id cannot be read."))?.into(),
        signed_pre_key: signed.public_key().map_err(|_| entry_error("peer_state_invalid", "The signed prekey public key cannot be read."))?.serialize().to_vec(),
        signed_pre_key_signature: signed.signature().map_err(|_| entry_error("peer_state_invalid", "The signed prekey signature cannot be read."))?,
        pre_key_id,
        pre_key,
        kyber_pre_key_id: kyber.id().map_err(|_| entry_error("peer_state_invalid", "The Kyber prekey id cannot be read."))?.into(),
        kyber_pre_key: kyber_public.serialize().to_vec(),
        kyber_pre_key_signature: kyber_signature,
    })
}

pub fn peer_bundle_from_json_text(text: &str) -> Result<PeerPreKeyBundle> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| entry_error("peer_bundle_malformed", "The peer prekey bundle is not JSON."))?;
    PeerPreKeyBundle::from_json(&value)
}

/// Quick peer-id sanity for wire surfaces that carry the id alongside the bundle.
pub fn validate_bundle_peer_id(bundle: &PeerPreKeyBundle, expected_peer_id: &str) -> Result<()> {
    if bundle.peer_id != expected_peer_id || !is_peer_id(&bundle.peer_id) {
        return Err(entry_error(
            "peer_bundle_malformed",
            "The bundle peerId does not match the expected peer.",
        ));
    }
    Ok(())
}
