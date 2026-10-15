//! Local device identity — port of `peer-crypto/identity.ts`.
//!
//! Private key material stays inside `IdentityKeyPair` and the store; the
//! public projection (`PeerIdentityPublic`) is the only value allowed on the
//! wire or in logs.

use libsignal_protocol::{
    kem, GenericSignedPreKey, IdentityKeyPair, KeyPair, KyberPreKeyRecord, PreKeyRecord,
    PublicKey, SignedPreKeyRecord, Timestamp,
};

use crate::b64::{b64u_decode, b64u_encode};
use crate::error::{entry_error, Result};
use crate::peer::store::{
    PeerCryptoCounters, PeerCryptoStore, PeerIdentitySecretRecord, StoredPreKeyRecord,
    PeerPrekeyState,
};
use crate::peer::types::{
    assert_peer_id, PEER_DEFAULT_KYBER_PREKEY_COUNT, PEER_DEFAULT_ONE_TIME_PREKEY_COUNT,
    PEER_DEVICE_ID, PEER_MAX_PREKEY_ID, PEER_STORE_RECORD_VERSION,
};

fn crypto_error(code: &str, message: &str) -> crate::error::EntryError {
    entry_error(code, message)
}

#[derive(Clone)]
pub struct PeerIdentity {
    pub peer_id: String,
    pub device_id: u32,
    pub registration_id: u32,
    pub created_at: String,
    key_pair: IdentityKeyPair,
}

impl PeerIdentity {
    pub fn from_record(record: &PeerIdentitySecretRecord) -> Result<Self> {
        let bytes = b64u_decode(&record.identity_key_pair, 4096).map_err(|_| {
            crypto_error("peer_store_error", "The stored identity keypair cannot be decoded.")
        })?;
        let key_pair = IdentityKeyPair::try_from(bytes.as_slice()).map_err(|_| {
            crypto_error("peer_store_error", "The stored identity keypair cannot be deserialized.")
        })?;
        Ok(Self {
            peer_id: record.peer_id.clone(),
            device_id: record.device_id,
            registration_id: record.registration_id,
            created_at: record.created_at.clone(),
            key_pair,
        })
    }

    pub fn identity_key_pair(&self) -> &IdentityKeyPair {
        &self.key_pair
    }

    /// Public-only projection — no private key bytes; the value signed into
    /// the pairing completion and compared out of band.
    pub fn public_descriptor(&self) -> serde_json::Value {
        serde_json::json!({
            "peerId": self.peer_id,
            "deviceId": self.device_id,
            "registrationId": self.registration_id,
            "identityKey": b64u_encode(&self.key_pair.identity_key().serialize()),
            "createdAt": self.created_at,
        })
    }

    /// The `PairingPeerIdentity` projection the pairing wire shape carries:
    /// peerId + signal device id + registration id + identity key.
    pub fn paired_signal_identity(&self) -> PairedSignalIdentity {
        PairedSignalIdentity {
            peer_id: self.peer_id.clone(),
            signal_device_id: self.device_id,
            registration_id: self.registration_id,
            identity_key: b64u_encode(&self.key_pair.public_key().serialize()),
        }
    }
}

/// `PeerPairedSignalIdentity` — the pairing-pinned remote or local Signal
/// public identity (no private material).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedSignalIdentity {
    pub peer_id: String,
    pub signal_device_id: u32,
    pub registration_id: u32,
    /// Canonical unpadded base64url of `PublicKey.serialize()`.
    pub identity_key: String,
}

/// Sign a domain-separated peer control transcript with the enrolled Signal identity.
pub fn sign_peer_identity_message(identity: &PeerIdentity, message: &[u8]) -> Result<Vec<u8>> {
    let mut rng = rand::rng();
    identity
        .key_pair
        .private_key()
        .calculate_signature(message, &mut rng)
        .map(|sig| sig.to_vec())
        .map_err(|_| crypto_error("peer_state_invalid", "The local identity cannot sign."))
}

/// Verify a Signal identity signature against pairing-pinned public bytes.
pub fn verify_peer_identity_message(identity_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    if signature.len() != 64 {
        return false;
    }
    PublicKey::deserialize(identity_key)
        .map(|key| key.verify_signature(message, signature))
        .unwrap_or(false)
}

fn next_id(store: &dyn PeerCryptoStore, field: u8) -> Result<u32> {
    let mut counters = store.load_counters()?.unwrap_or_default();
    let id = match field {
        0 => &mut counters.next_pre_key_id,
        1 => &mut counters.next_signed_pre_key_id,
        _ => &mut counters.next_kyber_pre_key_id,
    };
    if *id < 1 || *id > PEER_MAX_PREKEY_ID {
        return Err(crypto_error(
            "peer_state_invalid",
            "The prekey id space is exhausted; reset requires a fresh device identity.",
        ));
    }
    let out = *id;
    *id += 1;
    store.save_counters(&counters)?;
    Ok(out)
}

fn mint_one_time_pre_key(store: &dyn PeerCryptoStore) -> Result<u32> {
    let id = next_id(store, 0)?;
    let mut rng = rand::rng();
    let key_pair = KeyPair::generate(&mut rng);
    let record = PreKeyRecord::new(id.into(), &key_pair);
    let serialized = record.serialize().map_err(|_| {
        crypto_error("peer_store_error", "A fresh prekey record cannot be serialized.")
    })?;
    store.save_pre_key(&StoredPreKeyRecord { id, state: PeerPrekeyState::Available, record: serialized })?;
    Ok(id)
}

fn mint_kyber_pre_key(identity: &PeerIdentity, store: &dyn PeerCryptoStore) -> Result<u32> {
    let id = next_id(store, 2)?;
    let record = KyberPreKeyRecord::generate(
        kem::KeyType::Kyber1024,
        id.into(),
        identity.key_pair.private_key(),
    )
    .map_err(|_| crypto_error("peer_store_error", "A fresh Kyber prekey cannot be generated."))?;
    let serialized = record.serialize().map_err(|_| {
        crypto_error("peer_store_error", "A fresh Kyber prekey cannot be serialized.")
    })?;
    store.save_kyber_pre_key(&StoredPreKeyRecord { id, state: PeerPrekeyState::Available, record: serialized })?;
    Ok(id)
}

fn mint_signed_pre_key(identity: &PeerIdentity, store: &dyn PeerCryptoStore) -> Result<u32> {
    let id = next_id(store, 1)?;
    let mut rng = rand::rng();
    let key_pair = KeyPair::generate(&mut rng);
    let signature = identity
        .key_pair
        .private_key()
        .calculate_signature(&key_pair.public_key.serialize(), &mut rng)
        .map_err(|_| crypto_error("peer_store_error", "The signed prekey cannot be signed."))?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let record = SignedPreKeyRecord::new(
        id.into(),
        Timestamp::from_epoch_millis(now_ms),
        &key_pair,
        &signature,
    );
    let serialized = record.serialize().map_err(|_| {
        crypto_error("peer_store_error", "A fresh signed prekey cannot be serialized.")
    })?;
    store.save_signed_pre_key(id, &serialized)?;
    Ok(id)
}

#[derive(Debug, Clone, Copy)]
pub struct PeerPrekeyPoolSize {
    pub one_time_count: usize,
    pub kyber_count: usize,
}

/// Mint fresh one-time and Kyber prekeys up to the requested pool depth.
/// Already-published or used records are never touched.
pub fn replenish_peer_prekeys(
    identity: &PeerIdentity,
    store: &dyn PeerCryptoStore,
    one_time_target: Option<usize>,
    kyber_target: Option<usize>,
) -> Result<PeerPrekeyPoolSize> {
    let target_one_time = one_time_target.unwrap_or(PEER_DEFAULT_ONE_TIME_PREKEY_COUNT);
    let target_kyber = kyber_target.unwrap_or(PEER_DEFAULT_KYBER_PREKEY_COUNT);
    let available_one_time = store
        .list_pre_keys()?
        .iter()
        .filter(|e| e.state == PeerPrekeyState::Available)
        .count();
    let available_kyber = store
        .list_kyber_pre_keys()?
        .iter()
        .filter(|e| e.state == PeerPrekeyState::Available)
        .count();
    for _ in available_one_time..target_one_time {
        mint_one_time_pre_key(store)?;
    }
    for _ in available_kyber..target_kyber {
        mint_kyber_pre_key(identity, store)?;
    }
    Ok(PeerPrekeyPoolSize { one_time_count: target_one_time, kyber_count: target_kyber })
}

/// Rotate the signed prekey under a new id; older records stay loadable.
pub fn rotate_signed_pre_key(identity: &PeerIdentity, store: &dyn PeerCryptoStore) -> Result<u32> {
    mint_signed_pre_key(identity, store)
}

/// Create a fresh device identity: keypair + registration id + initial prekey
/// pool. The identity record commits last. An existing record is never
/// overwritten — `load_peer_identity` resumes it.
pub fn create_peer_identity(
    store: &dyn PeerCryptoStore,
    peer_id: Option<&str>,
) -> Result<PeerIdentity> {
    if store.load_identity()?.is_some() {
        return Err(crypto_error(
            "peer_state_invalid",
            "A local peer identity already exists in this store; load it with load_peer_identity.",
        ));
    }
    let peer_id = match peer_id {
        Some(id) => assert_peer_id(id)?.to_string(),
        None => format!("peer.{}", b64u_encode(&crate::keys::random_bytes(12))),
    };
    let mut rng = rand::rng();
    let key_pair = IdentityKeyPair::generate(&mut rng);
    let registration_id = (rand::Rng::random_range(&mut rng, 1..0x4000)) as u32;
    let record = PeerIdentitySecretRecord {
        version: PEER_STORE_RECORD_VERSION,
        peer_id: peer_id.clone(),
        device_id: PEER_DEVICE_ID,
        registration_id,
        identity_key_pair: b64u_encode(&key_pair.serialize()),
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    let identity = PeerIdentity::from_record(&record)?;
    store.save_counters(&PeerCryptoCounters::default())?;
    mint_signed_pre_key(&identity, store)?;
    replenish_peer_prekeys(&identity, store, None, None)?;
    store.save_identity(&record)?;
    Ok(identity)
}

/// Resume the device identity committed in this store, or None when none exists.
pub fn load_peer_identity(store: &dyn PeerCryptoStore) -> Result<Option<PeerIdentity>> {
    let Some(record) = store.load_identity()? else { return Ok(None) };
    let identity = PeerIdentity::from_record(&record)?;
    if store.load_counters()?.is_none() {
        store.save_counters(&PeerCryptoCounters::default())?;
    }
    Ok(Some(identity))
}
