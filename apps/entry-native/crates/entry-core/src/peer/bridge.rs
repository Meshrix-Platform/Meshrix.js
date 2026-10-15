//! Bridges `PeerCryptoStore` into libsignal's five store traits —
//! port of `peer-crypto/signal-bridge.ts`.
//!
//! libsignal store traits are `#[async_trait(?Send)]`; every impl here runs
//! on the peer runtime's dedicated single thread and holds a `Rc<RefCell>`
//! store, never moving crypto state across tokio workers.

use std::cell::RefCell;
use std::rc::Rc;

use async_trait::async_trait;
use libsignal_protocol::{
    Direction, GenericSignedPreKey, IdentityChange, IdentityKey, IdentityKeyPair, IdentityKeyStore,
    KyberPreKeyId, KyberPreKeyRecord, KyberPreKeyStore, PreKeyId, PreKeyRecord, PreKeyStore,
    ProtocolAddress, SessionRecord, SessionStore, SignalProtocolError, SignedPreKeyId,
    SignedPreKeyRecord, SignedPreKeyStore,
};

use crate::b64::{b64u_decode, b64u_encode};
use crate::peer::store::{
    peer_session_address_key, PeerCryptoStore, PeerIdentityBinding, StoredPreKeyRecord,
};

fn proto_err(message: &str) -> SignalProtocolError {
    SignalProtocolError::InvalidArgument(message.to_string())
}

fn to_proto(e: crate::error::EntryError) -> SignalProtocolError {
    proto_err(&e.to_string())
}

pub fn store_of(store: Rc<RefCell<dyn PeerCryptoStore>>) -> Rc<RefCell<dyn PeerCryptoStore>> {
    store
}

/// Sessions addressed by the stable `<deviceId>--<peerId>` store key.
pub struct StoreSessionStore {
    store: Rc<RefCell<dyn PeerCryptoStore>>,
}

impl StoreSessionStore {
    pub fn new(store: Rc<RefCell<dyn PeerCryptoStore>>) -> Self {
        Self { store }
    }
}

#[async_trait(?Send)]
impl SessionStore for StoreSessionStore {
    async fn load_session(
        &self,
        address: &ProtocolAddress,
    ) -> Result<Option<SessionRecord>, SignalProtocolError> {
        let key = peer_session_address_key(address.name(), address.device_id().into());
        let Some(bytes) = self.store.borrow().load_session(&key).map_err(to_proto)? else {
            return Ok(None);
        };
        SessionRecord::deserialize(&bytes)
            .map(Some)
            .map_err(|e| proto_err(&format!("session deserialize: {e}")))
    }

    async fn store_session(
        &mut self,
        address: &ProtocolAddress,
        record: &SessionRecord,
    ) -> Result<(), SignalProtocolError> {
        let key = peer_session_address_key(address.name(), address.device_id().into());
        let bytes = record.serialize().map_err(|e| proto_err(&e.to_string()))?;
        self.store.borrow().save_session(&key, &bytes).map_err(to_proto)
    }
}

/// Local identity + pinned remote identity bindings; `is_trusted_identity`
/// pins on first use and reports `identity_changed` on mismatch.
pub struct StoreIdentityKeyStore {
    store: Rc<RefCell<dyn PeerCryptoStore>>,
    identity: IdentityKeyPair,
}

impl StoreIdentityKeyStore {
    pub fn new(store: Rc<RefCell<dyn PeerCryptoStore>>, identity: IdentityKeyPair) -> Self {
        Self { store, identity }
    }
}

#[async_trait(?Send)]
impl IdentityKeyStore for StoreIdentityKeyStore {
    async fn get_identity_key_pair(&self) -> Result<IdentityKeyPair, SignalProtocolError> {
        Ok(self.identity.clone())
    }

    async fn get_local_registration_id(&self) -> Result<u32, SignalProtocolError> {
        let record = self
            .store
            .borrow()
            .load_identity()
            .map_err(to_proto)?
            .ok_or_else(|| proto_err("local identity record missing"))?;
        Ok(record.registration_id)
    }

    async fn save_identity(
        &mut self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
    ) -> Result<IdentityChange, SignalProtocolError> {
        let key = b64u_encode(&identity.serialize());
        let existing = self
            .store
            .borrow()
            .load_peer_binding(address.name())
            .map_err(to_proto)?;
        let changed = existing
            .as_ref()
            .map(|b| b.identity_key != key)
            .unwrap_or(false);
        self.store
            .borrow()
            .save_peer_binding(&PeerIdentityBinding {
                peer_id: address.name().to_string(),
                device_id: address.device_id().into(),
                identity_key: key,
                trust_generation: existing.as_ref().map(|b| b.trust_generation + 1).unwrap_or(0),
                pinned_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                state: "active".to_string(),
            })
            .map_err(to_proto)?;
        Ok(IdentityChange::from_changed(changed))
    }

    async fn is_trusted_identity(
        &self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
        direction: Direction,
    ) -> Result<bool, SignalProtocolError> {
        let binding = self
            .store
            .borrow()
            .load_peer_binding(address.name())
            .map_err(to_proto)?;
        match binding {
            None => {
                // Receiving requires a prior authenticated pin; sending allows
                // the first-use pin performed by save_identity upstream.
                Ok(direction == Direction::Sending)
            }
            Some(b) if b.state == "blocked" => Ok(false),
            Some(b) => Ok(b.identity_key == b64u_encode(&identity.serialize())),
        }
    }

    async fn get_identity(
        &self,
        address: &ProtocolAddress,
    ) -> Result<Option<IdentityKey>, SignalProtocolError> {
        let binding = self
            .store
            .borrow()
            .load_peer_binding(address.name())
            .map_err(to_proto)?;
        let Some(binding) = binding else { return Ok(None) };
        let bytes = b64u_decode(&binding.identity_key, 4096)
            .map_err(|_| proto_err("pinned identity key cannot be decoded"))?;
        IdentityKey::try_from(bytes.as_slice())
            .map(Some)
            .map_err(|e| proto_err(&e.to_string()))
    }
}

pub struct StorePreKeyStore {
    store: Rc<RefCell<dyn PeerCryptoStore>>,
}

impl StorePreKeyStore {
    pub fn new(store: Rc<RefCell<dyn PeerCryptoStore>>) -> Self {
        Self { store }
    }
}

#[async_trait(?Send)]
impl PreKeyStore for StorePreKeyStore {
    async fn get_pre_key(&self, id: PreKeyId) -> Result<PreKeyRecord, SignalProtocolError> {
        let Some(entry) = self.store.borrow().load_pre_key(id.into()).map_err(to_proto)? else {
            return Err(SignalProtocolError::InvalidPreKeyId);
        };
        PreKeyRecord::deserialize(&entry.record).map_err(|e| proto_err(&e.to_string()))
    }

    async fn save_pre_key(
        &mut self,
        id: PreKeyId,
        record: &PreKeyRecord,
    ) -> Result<(), SignalProtocolError> {
        let serialized = record.serialize().map_err(|e| proto_err(&e.to_string()))?;
        self.store
            .borrow()
            .save_pre_key(&StoredPreKeyRecord {
                id: id.into(),
                state: crate::peer::store::PeerPrekeyState::Available,
                record: serialized,
            })
            .map_err(to_proto)
    }

    async fn remove_pre_key(&mut self, id: PreKeyId) -> Result<(), SignalProtocolError> {
        self.store.borrow().delete_pre_key(id.into()).map_err(to_proto)
    }
}

pub struct StoreSignedPreKeyStore {
    store: Rc<RefCell<dyn PeerCryptoStore>>,
}

impl StoreSignedPreKeyStore {
    pub fn new(store: Rc<RefCell<dyn PeerCryptoStore>>) -> Self {
        Self { store }
    }
}

#[async_trait(?Send)]
impl SignedPreKeyStore for StoreSignedPreKeyStore {
    async fn get_signed_pre_key(
        &self,
        id: SignedPreKeyId,
    ) -> Result<SignedPreKeyRecord, SignalProtocolError> {
        let Some(bytes) = self.store.borrow().load_signed_pre_key(id.into()).map_err(to_proto)? else {
            return Err(SignalProtocolError::InvalidSignedPreKeyId);
        };
        SignedPreKeyRecord::deserialize(&bytes).map_err(|e| proto_err(&e.to_string()))
    }

    async fn save_signed_pre_key(
        &mut self,
        id: SignedPreKeyId,
        record: &SignedPreKeyRecord,
    ) -> Result<(), SignalProtocolError> {
        let serialized = record.serialize().map_err(|e| proto_err(&e.to_string()))?;
        self.store
            .borrow()
            .save_signed_pre_key(id.into(), &serialized)
            .map_err(to_proto)
    }
}

pub struct StoreKyberPreKeyStore {
    store: Rc<RefCell<dyn PeerCryptoStore>>,
    /// Ids used by the in-flight PQXDH receive; marked `used` only after the
    /// message decrypts, so a forged/duplicate bundle cannot burn keys.
    pending_used: Rc<RefCell<Vec<u32>>>,
}

impl StoreKyberPreKeyStore {
    pub fn new(store: Rc<RefCell<dyn PeerCryptoStore>>, pending_used: Rc<RefCell<Vec<u32>>>) -> Self {
        Self { store, pending_used }
    }

    pub fn take_pending(&self) -> Vec<u32> {
        std::mem::take(&mut *self.pending_used.borrow_mut())
    }
}

#[async_trait(?Send)]
impl KyberPreKeyStore for StoreKyberPreKeyStore {
    async fn get_kyber_pre_key(
        &self,
        id: KyberPreKeyId,
    ) -> Result<KyberPreKeyRecord, SignalProtocolError> {
        let Some(entry) = self.store.borrow().load_kyber_pre_key(id.into()).map_err(to_proto)? else {
            return Err(SignalProtocolError::InvalidKyberPreKeyId);
        };
        KyberPreKeyRecord::deserialize(&entry.record).map_err(|e| proto_err(&e.to_string()))
    }

    async fn save_kyber_pre_key(
        &mut self,
        id: KyberPreKeyId,
        record: &KyberPreKeyRecord,
    ) -> Result<(), SignalProtocolError> {
        let serialized = record.serialize().map_err(|e| proto_err(&e.to_string()))?;
        self.store
            .borrow()
            .save_kyber_pre_key(&StoredPreKeyRecord {
                id: id.into(),
                state: crate::peer::store::PeerPrekeyState::Available,
                record: serialized,
            })
            .map_err(to_proto)
    }

    async fn mark_kyber_pre_key_used(
        &mut self,
        id: KyberPreKeyId,
        _ec_prekey_id: SignedPreKeyId,
        _base_key: &libsignal_protocol::PublicKey,
    ) -> Result<(), SignalProtocolError> {
        self.pending_used.borrow_mut().push(id.into());
        Ok(())
    }
}
