//! Transaction overlay — port of `peer-crypto/src/transaction-overlay.ts`.
//!
//! Libsignal ratchet operations mutate store state at every step; the durable
//! inbox/outbox row that owns the plaintext/ciphertext commits only after the
//! mutations are staged into the single-record WAL. The overlay records each
//! write (last-write-wins per entity) and lets reads observe staged state, so
//! `prepare_operation` can persist mutations + application record atomically.

use std::cell::RefCell;
use std::rc::Rc;

use crate::error::Result;

use super::store::{
    PeerCryptoCounters, PeerCryptoMutation, PeerCryptoStore, PeerIdentityBinding,
    PeerIdentitySecretRecord, StoredPreKeyEntry, StoredPreKeyRecord,
};

fn mutation_key(mutation: &PeerCryptoMutation) -> String {
    match mutation {
        PeerCryptoMutation::Identity(_) => "identity".to_string(),
        PeerCryptoMutation::SavePeerBinding(b) => {
            serde_json::json!(["peerBinding", b.peer_id]).to_string()
        }
        PeerCryptoMutation::DeletePeerBinding(peer_id) => {
            serde_json::json!(["peerBinding", peer_id]).to_string()
        }
        PeerCryptoMutation::SaveSession { address_key, .. }
        | PeerCryptoMutation::DeleteSession(address_key) => {
            serde_json::json!(["session", address_key]).to_string()
        }
        PeerCryptoMutation::SavePreKey(r) => {
            serde_json::json!(["preKey", r.id]).to_string()
        }
        PeerCryptoMutation::DeletePreKey(id) => serde_json::json!(["preKey", id]).to_string(),
        PeerCryptoMutation::SaveSignedPreKey { id, .. }
        | PeerCryptoMutation::DeleteSignedPreKey(id) => {
            serde_json::json!(["signedPreKey", id]).to_string()
        }
        PeerCryptoMutation::SaveKyberPreKey(r) => {
            serde_json::json!(["kyberPreKey", r.id]).to_string()
        }
        PeerCryptoMutation::DeleteKyberPreKey(id) => {
            serde_json::json!(["kyberPreKey", id]).to_string()
        }
        PeerCryptoMutation::Counters(_) => "counters".to_string(),
    }
}

/// Staging overlay: `store` is used by session code while `mutations()`
/// captures the exact write set for the WAL record.
pub struct PeerCryptoTransactionOverlay {
    pub store: Rc<RefCell<dyn PeerCryptoStore>>,
    writes: Rc<RefCell<Vec<(String, PeerCryptoMutation)>>>,
}

impl PeerCryptoTransactionOverlay {
    pub fn new(base: Rc<RefCell<dyn PeerCryptoStore>>) -> Self {
        let writes = Rc::new(RefCell::new(Vec::new()));
        Self {
            store: Rc::new(RefCell::new(OverlayStore {
                base,
                writes: writes.clone(),
            })),
            writes,
        }
    }

    /// Staged mutations in write order (last write per entity wins).
    pub fn mutations(&self) -> Vec<PeerCryptoMutation> {
        self.writes
            .borrow()
            .iter()
            .map(|(_, m)| m.clone())
            .collect()
    }
}

struct OverlayStore {
    base: Rc<RefCell<dyn PeerCryptoStore>>,
    writes: Rc<RefCell<Vec<(String, PeerCryptoMutation)>>>,
}

impl OverlayStore {
    fn stage(&self, mutation: PeerCryptoMutation) {
        let key = mutation_key(&mutation);
        let mut writes = self.writes.borrow_mut();
        if let Some(slot) = writes.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = mutation;
        } else {
            writes.push((key, mutation));
        }
    }

    fn staged(&self, key: &str) -> Option<PeerCryptoMutation> {
        self.writes
            .borrow()
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, m)| m.clone())
    }
}

impl PeerCryptoStore for OverlayStore {
    fn load_identity(&self) -> Result<Option<PeerIdentitySecretRecord>> {
        if let Some(PeerCryptoMutation::Identity(record)) = self.staged("identity") {
            return Ok(Some(record));
        }
        self.base.borrow().load_identity()
    }

    fn save_identity(&self, record: &PeerIdentitySecretRecord) -> Result<()> {
        self.stage(PeerCryptoMutation::Identity(record.clone()));
        Ok(())
    }

    fn load_peer_binding(&self, peer_id: &str) -> Result<Option<PeerIdentityBinding>> {
        let key = serde_json::json!(["peerBinding", peer_id]).to_string();
        match self.staged(&key) {
            Some(PeerCryptoMutation::SavePeerBinding(b)) => return Ok(Some(b)),
            Some(PeerCryptoMutation::DeletePeerBinding(_)) => return Ok(None),
            _ => {}
        }
        self.base.borrow().load_peer_binding(peer_id)
    }

    fn save_peer_binding(&self, binding: &PeerIdentityBinding) -> Result<()> {
        self.stage(PeerCryptoMutation::SavePeerBinding(binding.clone()));
        Ok(())
    }

    fn delete_peer_binding(&self, peer_id: &str) -> Result<()> {
        self.stage(PeerCryptoMutation::DeletePeerBinding(peer_id.to_string()));
        Ok(())
    }

    fn list_peer_bindings(&self) -> Result<Vec<PeerIdentityBinding>> {
        let mut records: Vec<PeerIdentityBinding> = self.base.borrow().list_peer_bindings()?;
        for (_, mutation) in self.writes.borrow().iter() {
            match mutation {
                PeerCryptoMutation::SavePeerBinding(b) => {
                    records.retain(|r| r.peer_id != b.peer_id);
                    records.push(b.clone());
                }
                PeerCryptoMutation::DeletePeerBinding(peer_id) => {
                    records.retain(|r| r.peer_id != *peer_id);
                }
                _ => {}
            }
        }
        Ok(records)
    }

    fn load_session(&self, address_key: &str) -> Result<Option<Vec<u8>>> {
        let key = serde_json::json!(["session", address_key]).to_string();
        match self.staged(&key) {
            Some(PeerCryptoMutation::SaveSession { value, .. }) => return Ok(Some(value)),
            Some(PeerCryptoMutation::DeleteSession(_)) => return Ok(None),
            _ => {}
        }
        self.base.borrow().load_session(address_key)
    }

    fn save_session(&self, address_key: &str, serialized: &[u8]) -> Result<()> {
        self.stage(PeerCryptoMutation::SaveSession {
            address_key: address_key.to_string(),
            value: serialized.to_vec(),
        });
        Ok(())
    }

    fn delete_session(&self, address_key: &str) -> Result<()> {
        self.stage(PeerCryptoMutation::DeleteSession(address_key.to_string()));
        Ok(())
    }

    fn list_session_keys(&self) -> Result<Vec<String>> {
        let mut keys: Vec<String> = self.base.borrow().list_session_keys()?;
        for (_, mutation) in self.writes.borrow().iter() {
            match mutation {
                PeerCryptoMutation::SaveSession { address_key, .. } => {
                    if !keys.contains(address_key) {
                        keys.push(address_key.clone());
                    }
                }
                PeerCryptoMutation::DeleteSession(address_key) => {
                    keys.retain(|k| k != address_key);
                }
                _ => {}
            }
        }
        Ok(keys)
    }

    fn load_pre_key(&self, id: u32) -> Result<Option<StoredPreKeyRecord>> {
        let key = serde_json::json!(["preKey", id]).to_string();
        match self.staged(&key) {
            Some(PeerCryptoMutation::SavePreKey(r)) => return Ok(Some(r)),
            Some(PeerCryptoMutation::DeletePreKey(_)) => return Ok(None),
            _ => {}
        }
        self.base.borrow().load_pre_key(id)
    }

    fn save_pre_key(&self, record: &StoredPreKeyRecord) -> Result<()> {
        self.stage(PeerCryptoMutation::SavePreKey(record.clone()));
        Ok(())
    }

    fn delete_pre_key(&self, id: u32) -> Result<()> {
        self.stage(PeerCryptoMutation::DeletePreKey(id));
        Ok(())
    }

    fn list_pre_keys(&self) -> Result<Vec<StoredPreKeyEntry>> {
        let mut records: Vec<StoredPreKeyEntry> = self.base.borrow().list_pre_keys()?;
        for (_, mutation) in self.writes.borrow().iter() {
            match mutation {
                PeerCryptoMutation::SavePreKey(r) => {
                    records.retain(|e| e.id != r.id);
                    records.push(StoredPreKeyEntry { id: r.id, state: r.state });
                }
                PeerCryptoMutation::DeletePreKey(id) => records.retain(|e| e.id != *id),
                _ => {}
            }
        }
        Ok(records)
    }

    fn load_signed_pre_key(&self, id: u32) -> Result<Option<Vec<u8>>> {
        let key = serde_json::json!(["signedPreKey", id]).to_string();
        match self.staged(&key) {
            Some(PeerCryptoMutation::SaveSignedPreKey { value, .. }) => return Ok(Some(value)),
            Some(PeerCryptoMutation::DeleteSignedPreKey(_)) => return Ok(None),
            _ => {}
        }
        self.base.borrow().load_signed_pre_key(id)
    }

    fn save_signed_pre_key(&self, id: u32, serialized: &[u8]) -> Result<()> {
        self.stage(PeerCryptoMutation::SaveSignedPreKey {
            id,
            value: serialized.to_vec(),
        });
        Ok(())
    }

    fn delete_signed_pre_key(&self, id: u32) -> Result<()> {
        self.stage(PeerCryptoMutation::DeleteSignedPreKey(id));
        Ok(())
    }

    fn list_signed_pre_keys(&self) -> Result<Vec<u32>> {
        let mut ids: Vec<u32> = self.base.borrow().list_signed_pre_keys()?;
        for (_, mutation) in self.writes.borrow().iter() {
            match mutation {
                PeerCryptoMutation::SaveSignedPreKey { id, .. } => {
                    if !ids.contains(id) {
                        ids.push(*id);
                    }
                }
                PeerCryptoMutation::DeleteSignedPreKey(id) => ids.retain(|i| i != id),
                _ => {}
            }
        }
        Ok(ids)
    }

    fn load_kyber_pre_key(&self, id: u32) -> Result<Option<StoredPreKeyRecord>> {
        let key = serde_json::json!(["kyberPreKey", id]).to_string();
        match self.staged(&key) {
            Some(PeerCryptoMutation::SaveKyberPreKey(r)) => return Ok(Some(r)),
            Some(PeerCryptoMutation::DeleteKyberPreKey(_)) => return Ok(None),
            _ => {}
        }
        self.base.borrow().load_kyber_pre_key(id)
    }

    fn save_kyber_pre_key(&self, record: &StoredPreKeyRecord) -> Result<()> {
        self.stage(PeerCryptoMutation::SaveKyberPreKey(record.clone()));
        Ok(())
    }

    fn delete_kyber_pre_key(&self, id: u32) -> Result<()> {
        self.stage(PeerCryptoMutation::DeleteKyberPreKey(id));
        Ok(())
    }

    fn list_kyber_pre_keys(&self) -> Result<Vec<StoredPreKeyEntry>> {
        let mut records: Vec<StoredPreKeyEntry> = self.base.borrow().list_kyber_pre_keys()?;
        for (_, mutation) in self.writes.borrow().iter() {
            match mutation {
                PeerCryptoMutation::SaveKyberPreKey(r) => {
                    records.retain(|e| e.id != r.id);
                    records.push(StoredPreKeyEntry { id: r.id, state: r.state });
                }
                PeerCryptoMutation::DeleteKyberPreKey(id) => records.retain(|e| e.id != *id),
                _ => {}
            }
        }
        Ok(records)
    }

    fn load_counters(&self) -> Result<Option<PeerCryptoCounters>> {
        if let Some(PeerCryptoMutation::Counters(counters)) = self.staged("counters") {
            return Ok(Some(counters));
        }
        self.base.borrow().load_counters()
    }

    fn save_counters(&self, counters: &PeerCryptoCounters) -> Result<()> {
        self.stage(PeerCryptoMutation::Counters(counters.clone()));
        Ok(())
    }

    // WAL operations always hit the durable base store directly.
    fn load_prepared_operation(&self) -> Result<Option<super::store::PeerCryptoPreparedOperation>> {
        self.base.borrow().load_prepared_operation()
    }
    fn prepare_operation(&self, record: &super::store::PeerCryptoPreparedOperation) -> Result<()> {
        self.base.borrow().prepare_operation(record)
    }
    fn apply_prepared_operation(&self) -> Result<()> {
        self.base.borrow().apply_prepared_operation()
    }
    fn finalize_prepared_operation(&self, message_id: &str, kind: &str) -> Result<()> {
        self.base.borrow().finalize_prepared_operation(message_id, kind)
    }
}

/// `createPeerCryptoTransactionOverlay`.
pub fn create_peer_crypto_transaction_overlay(
    base: Rc<RefCell<dyn PeerCryptoStore>>,
) -> PeerCryptoTransactionOverlay {
    PeerCryptoTransactionOverlay::new(base)
}
