//! Signal session lifecycle over a durable store — port of
//! `peer-crypto/session.ts`.
//!
//! Three entry points mirror TS exactly:
//!   initiate — X3DH/PQXDH over a fetched bundle, then encrypt first message
//!   accept   — decrypt an inbound envelope (prekey establishes the session)
//!   resume   — encrypt over an existing ratchet session
//!
//! Trust: remote identity keys are pinned by authenticated pairing, never
//! silently trusted on receive. A changed key is a typed
//! `peer_identity_changed` failure until the caller re-pins explicitly.

use std::cell::RefCell;
use std::rc::Rc;

use libsignal_protocol::{
    message_decrypt_prekey, message_decrypt_signal, message_encrypt, process_prekey_bundle,
    DeviceId, PreKeySignalMessage, ProtocolAddress, SessionRecord, SignalMessage,
};

use crate::b64::{b64u_decode, b64u_encode};
use crate::error::{entry_error, EntryError, Result};
use crate::peer::bridge::{
    StoreIdentityKeyStore, StoreKyberPreKeyStore, StorePreKeyStore, StoreSessionStore,
    StoreSignedPreKeyStore,
};
use crate::peer::bundle::PeerPreKeyBundle;
use crate::peer::envelope::{PeerEnvelope, PeerEnvelopeMessageType};
use crate::peer::identity::PeerIdentity;
use crate::peer::store::{
    peer_session_address_key, PeerCryptoStore, PeerIdentityBinding, PeerPrekeyState,
    StoredPreKeyRecord,
};
use crate::peer::types::{
    PEER_MAX_PLAINTEXT_BYTES, PEER_SAFETY_NUMBER_ITERATIONS,
};

fn session_error(code: &str, message: &str) -> EntryError {
    entry_error(code, message)
}

fn now_timestamp() -> std::time::SystemTime {
    std::time::SystemTime::now()
}

/// Shared bridge context: one Rc store + the five libsignal store adapters.
pub struct PeerSessionStores {
    pub session: StoreSessionStore,
    pub identity: StoreIdentityKeyStore,
    pub pre_key: StorePreKeyStore,
    pub signed_pre_key: StoreSignedPreKeyStore,
    pub kyber_pre_key: StoreKyberPreKeyStore,
    store: Rc<RefCell<dyn PeerCryptoStore>>,
}

impl PeerSessionStores {
    pub fn new(store: Rc<RefCell<dyn PeerCryptoStore>>, identity: &PeerIdentity) -> Self {
        let pending = Rc::new(RefCell::new(Vec::new()));
        Self {
            session: StoreSessionStore::new(store.clone()),
            identity: StoreIdentityKeyStore::new(store.clone(), identity.identity_key_pair().clone()),
            pre_key: StorePreKeyStore::new(store.clone()),
            signed_pre_key: StoreSignedPreKeyStore::new(store.clone()),
            kyber_pre_key: StoreKyberPreKeyStore::new(store.clone(), pending),
            store,
        }
    }

    /// Mark Kyber prekeys consumed by a successful PQXDH receive as `used`.
    fn commit_used_kyber(&self) -> Result<()> {
        for id in self.kyber_pre_key.take_pending() {
            if let Some(record) = self.store.borrow().load_kyber_pre_key(id)? {
                self.store.borrow().save_kyber_pre_key(&StoredPreKeyRecord {
                    id,
                    state: PeerPrekeyState::Used,
                    record: record.record,
                })?;
            }
        }
        Ok(())
    }
}

/// One device↔device Signal session. Construct on the peer runtime thread.
pub struct PeerSession {
    local_identity: PeerIdentity,
    stores: PeerSessionStores,
    remote_address: ProtocolAddress,
}

fn remote_address(peer_id: &str, device_id: u32) -> Result<ProtocolAddress> {
    let device = DeviceId::try_from(device_id).map_err(|_| {
        session_error("peer_bundle_malformed", "The remote device id is out of range.")
    })?;
    Ok(ProtocolAddress::new(peer_id.to_string(), device))
}

impl PeerSession {
    /// Initiator: run PQXDH against the fetched bundle, then send.
    pub async fn initiate(
        local_identity: PeerIdentity,
        store: Rc<RefCell<dyn PeerCryptoStore>>,
        bundle: &PeerPreKeyBundle,
    ) -> Result<Self> {
        let mut stores = PeerSessionStores::new(store, &local_identity);
        let (remote, signal_bundle) = bundle.to_signal_bundle()?;
        let local = remote_address(&local_identity.peer_id, local_identity.device_id)?;
        let mut rng = rand::rng();
        process_prekey_bundle(
            &remote,
            &local,
            &mut stores.session,
            &mut stores.identity,
            &signal_bundle,
            now_timestamp(),
            &mut rng,
        )
        .await
        .map_err(|e| map_signal_error("peer_bundle_malformed", e))?;
        Ok(Self { local_identity, stores, remote_address: remote })
    }

    /// Resume an existing session for (peer_id, device_id).
    pub async fn resume(
        local_identity: PeerIdentity,
        store: Rc<RefCell<dyn PeerCryptoStore>>,
        peer_id: &str,
        device_id: u32,
    ) -> Result<Self> {
        let stores = PeerSessionStores::new(store.clone(), &local_identity);
        let remote = remote_address(peer_id, device_id)?;
        let key = peer_session_address_key(peer_id, device_id);
        if store.borrow().load_session(&key)?.is_none() {
            return Err(session_error(
                "peer_session_missing",
                "No established session exists for this peer; fetch a bundle and initiate.",
            ));
        }
        // Touch the record so a corrupt serialization fails here, not mid-encrypt.
        let bytes = store.borrow().load_session(&key)?.unwrap_or_default();
        SessionRecord::deserialize(&bytes).map_err(|_| {
            session_error("peer_state_invalid", "The stored session cannot be deserialized.")
        })?;
        Ok(Self { local_identity, stores, remote_address: remote })
    }

    /// Responder: decrypt an inbound envelope; a `prekey` envelope establishes
    /// the session on first contact.
    pub async fn accept(
        local_identity: PeerIdentity,
        store: Rc<RefCell<dyn PeerCryptoStore>>,
        envelope: &PeerEnvelope,
    ) -> Result<(Self, Vec<u8>)> {
        let mut stores = PeerSessionStores::new(store.clone(), &local_identity);
        let remote = remote_address(&envelope.sender_peer_id, envelope.sender_device_id)?;
        let local = remote_address(&local_identity.peer_id, local_identity.device_id)?;
        let mut rng = rand::rng();
        let plaintext = match envelope.message_type {
            PeerEnvelopeMessageType::PreKey => {
                let message = PreKeySignalMessage::try_from(envelope.body.as_slice()).map_err(|_| {
                    session_error("peer_envelope_malformed", "The prekey ciphertext cannot be decoded.")
                })?;
                message_decrypt_prekey(
                    &message,
                    &remote,
                    &local,
                    &mut stores.session,
                    &mut stores.identity,
                    &mut stores.pre_key,
                    &stores.signed_pre_key,
                    &mut stores.kyber_pre_key,
                    &mut rng,
                )
                .await
                .map_err(|e| map_signal_error("peer_decrypt_failed", e))?
            }
            PeerEnvelopeMessageType::Signal => {
                let message = SignalMessage::try_from(envelope.body.as_slice()).map_err(|_| {
                    session_error("peer_envelope_malformed", "The signal ciphertext cannot be decoded.")
                })?;
                message_decrypt_signal(
                    &message,
                    &remote,
                    &local,
                    &mut stores.session,
                    &mut stores.identity,
                    &mut rng,
                )
                .await
                .map_err(|e| map_signal_error("peer_decrypt_failed", e))?
            }
        };
        stores.commit_used_kyber()?;
        if plaintext.len() > PEER_MAX_PLAINTEXT_BYTES {
            return Err(session_error(
                "peer_envelope_malformed",
                "The decrypted plaintext exceeds the peer plaintext limit.",
            ));
        }
        let session = Self { local_identity, stores, remote_address: remote };
        Ok((session, plaintext))
    }

    /// Encrypt under the current ratchet state; returns the wire envelope.
    pub async fn encrypt(&mut self, plaintext: &[u8]) -> Result<PeerEnvelope> {
        if plaintext.is_empty() || plaintext.len() > PEER_MAX_PLAINTEXT_BYTES {
            return Err(session_error(
                "peer_envelope_malformed",
                "The peer plaintext is empty or exceeds the peer plaintext limit.",
            ));
        }
        let local = remote_address(&self.local_identity.peer_id, self.local_identity.device_id)?;
        let mut rng = rand::rng();
        let ciphertext = message_encrypt(
            plaintext,
            &self.remote_address,
            &local,
            &mut self.stores.session,
            &mut self.stores.identity,
            now_timestamp(),
            &mut rng,
        )
        .await
        .map_err(|e| map_signal_error("peer_encrypt_failed", e))?;
        let message_type = match ciphertext.message_type() {
            libsignal_protocol::CiphertextMessageType::PreKey => PeerEnvelopeMessageType::PreKey,
            _ => PeerEnvelopeMessageType::Signal,
        };
        Ok(PeerEnvelope {
            sender_peer_id: self.local_identity.peer_id.clone(),
            sender_device_id: self.local_identity.device_id,
            message_type,
            body: ciphertext.serialize().to_vec(),
        })
    }

    /// Decrypt a non-prekey envelope on an already-established session.
    /// `accept` handles the establish-and-decrypt case; this covers the
    /// resume-then-decrypt path the client uses for `session` envelopes.
    pub async fn decrypt_envelope(&mut self, envelope: &PeerEnvelope) -> Result<Vec<u8>> {
        let local = remote_address(&self.local_identity.peer_id, self.local_identity.device_id)?;
        let mut rng = rand::rng();
        let plaintext = match envelope.message_type {
            PeerEnvelopeMessageType::PreKey => {
                let message = PreKeySignalMessage::try_from(envelope.body.as_slice()).map_err(|_| {
                    session_error("peer_envelope_malformed", "The prekey ciphertext cannot be decoded.")
                })?;
                message_decrypt_prekey(
                    &message,
                    &self.remote_address,
                    &local,
                    &mut self.stores.session,
                    &mut self.stores.identity,
                    &mut self.stores.pre_key,
                    &self.stores.signed_pre_key,
                    &mut self.stores.kyber_pre_key,
                    &mut rng,
                )
                .await
                .map_err(|e| map_signal_error("peer_decrypt_failed", e))?
            }
            PeerEnvelopeMessageType::Signal => {
                let message = SignalMessage::try_from(envelope.body.as_slice()).map_err(|_| {
                    session_error("peer_envelope_malformed", "The signal ciphertext cannot be decoded.")
                })?;
                message_decrypt_signal(
                    &message,
                    &self.remote_address,
                    &local,
                    &mut self.stores.session,
                    &mut self.stores.identity,
                    &mut rng,
                )
                .await
                .map_err(|e| map_signal_error("peer_decrypt_failed", e))?
            }
        };
        self.stores.commit_used_kyber()?;
        if plaintext.len() > PEER_MAX_PLAINTEXT_BYTES {
            return Err(session_error(
                "peer_envelope_malformed",
                "The decrypted plaintext exceeds the peer plaintext limit.",
            ));
        }
        Ok(plaintext)
    }

    pub fn remote_peer_id(&self) -> &str {
        self.remote_address.name()
    }
}

/// Persisted trust-binding helpers — pairing uses `pin`, re-pairing uses
/// `repin`, a detected change may `block`.
pub fn pin_peer_identity(
    store: &dyn PeerCryptoStore,
    peer_id: &str,
    device_id: u32,
    identity_key: &[u8],
) -> Result<PeerIdentityBinding> {
    let binding = PeerIdentityBinding {
        peer_id: peer_id.to_string(),
        device_id,
        identity_key: b64u_encode(identity_key),
        trust_generation: 0,
        pinned_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        state: "active".to_string(),
    };
    store.save_peer_binding(&binding)?;
    Ok(binding)
}

/// Re-pairing: bump the trust generation and drop every stale ratchet session
/// for that peer so old keys can never decrypt new traffic.
pub fn repin_peer_identity(
    store: &dyn PeerCryptoStore,
    peer_id: &str,
    device_id: u32,
    identity_key: &[u8],
) -> Result<PeerIdentityBinding> {
    let existing = store.load_peer_binding(peer_id)?;
    let generation = existing.as_ref().map(|b| b.trust_generation + 1).unwrap_or(0);
    let binding = PeerIdentityBinding {
        peer_id: peer_id.to_string(),
        device_id,
        identity_key: b64u_encode(identity_key),
        trust_generation: generation,
        pinned_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        state: "active".to_string(),
    };
    store.save_peer_binding(&binding)?;
    for key in store.list_session_keys()? {
        if key.ends_with(&format!("--{peer_id}")) {
            store.delete_session(&key)?;
        }
    }
    Ok(binding)
}

/// Evidence-preserving block: the pin stays for audit, traffic is refused.
pub fn block_peer_identity(store: &dyn PeerCryptoStore, peer_id: &str) -> Result<()> {
    let Some(mut binding) = store.load_peer_binding(peer_id)? else {
        return Err(session_error("peer_state_invalid", "No pinned identity exists for this peer."));
    };
    binding.state = "blocked".to_string();
    store.save_peer_binding(&binding)
}

/// Standard Signal 60-digit safety number over both identity public keys —
/// `PEER_SAFETY_NUMBER_ITERATIONS` SHA-512 rounds, lexicographic order.
pub fn peer_safety_number(local_key: &[u8], remote_key: &[u8]) -> Result<String> {
    use sha2::{Digest, Sha512};
    let (first, second) = if local_key <= remote_key { (local_key, remote_key) } else { (remote_key, local_key) };
    let mut out = String::with_capacity(60);
    for (i, key) in [first, second].iter().enumerate() {
        let mut hash = {
            let mut h = Sha512::new();
            h.update([0u8; 32]); // fingerprint version prefix
            h.update(key);
            h.update(key);
            h.finalize().to_vec()
        };
        for _ in 1..PEER_SAFETY_NUMBER_ITERATIONS {
            let mut h = Sha512::new();
            h.update(&hash);
            h.update(key);
            hash = h.finalize().to_vec();
        }
        for chunk in 0..6 {
            let offset = chunk * 5;
            let value = u32::from_be_bytes([
                hash[offset], hash[offset + 1], hash[offset + 2], hash[offset + 3],
            ]) % 100_000;
            out.push_str(&format!("{value:05}"));
            let _ = i;
        }
    }
    Ok(out)
}

fn map_signal_error(code: &str, e: libsignal_protocol::SignalProtocolError) -> EntryError {
    use libsignal_protocol::SignalProtocolError as E;
    match e {
        E::UntrustedIdentity(_) => entry_error(
            "peer_identity_changed",
            "The remote peer identity key does not match the pinned binding.",
        ),
        _ => session_error(code, &format!("The Signal operation failed: {e}")),
    }
}

/// Convenience: check whether a stored binding still matches the key the
/// remote just presented (from a prekey bundle or pairing descriptor).
pub fn pinned_identity_matches(
    store: &dyn PeerCryptoStore,
    peer_id: &str,
    identity_key_b64: &str,
) -> Result<Option<bool>> {
    match store.load_peer_binding(peer_id)? {
        None => Ok(None),
        Some(b) if b.state == "blocked" => Ok(Some(false)),
        Some(b) => Ok(Some(b.identity_key == identity_key_b64)),
    }
}

pub fn decode_identity_key(b64: &str) -> Result<Vec<u8>> {
    b64u_decode(b64, 128).map_err(|_| {
        session_error("peer_bundle_malformed", "The peer identity key cannot be decoded.")
    })
}

/// Probe whether serialized ciphertext is a `PreKeySignalMessage` (version
/// byte 3 in the high nibble, carrying the PQXDH preamble).
pub fn ciphertext_is_prekey(body: &[u8]) -> bool {
    PreKeySignalMessage::try_from(body).is_ok()
}
