//! Durable crypto store for one device — port of `peer-crypto/store.ts` and
//! `file-store.ts`. One JSON document per record under an owner-only
//! directory; writes are temp-file → rename. Secret material lives here and
//! nowhere else.
//!
//! Layout (identical to TS):
//!   identity.json             local identity keypair + registration id (secret)
//!   meta.json                 monotonic prekey id counters
//!   peers/<peerId>.json       pinned remote identity bindings (public)
//!   sessions/<addr>.json      serialized SessionRecord ratchet state (secret)
//!   prekeys/<id>.json         one-time EC prekeys (secret)
//!   signed-prekeys/<id>.json  signed EC prekeys (secret)
//!   kyber-prekeys/<id>.json   post-quantum prekeys (secret)
//!   peer-operation.json       single-record WAL for ratchet+message commits

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::b64::{b64u_decode, b64u_encode};
use crate::error::{entry_error, Result};
use crate::peer::types::PEER_STORE_RECORD_VERSION;

fn store_error(message: &str) -> crate::error::EntryError {
    entry_error("peer_store_error", message)
}

/// Secret local identity record; `identity_key_pair` is base64url of
/// IdentityKeyPair.serialize().
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerIdentitySecretRecord {
    pub version: u64,
    pub peer_id: String,
    pub device_id: u32,
    pub registration_id: u32,
    pub identity_key_pair: String,
    pub created_at: String,
}

/// Public pinned remote identity; the trust root for peer_identity_changed honesty.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerIdentityBinding {
    pub peer_id: String,
    pub device_id: u32,
    /// base64url of the remote PublicKey.serialize() bytes.
    pub identity_key: String,
    pub trust_generation: u64,
    pub pinned_at: String,
    /// "blocked" keeps the pin as evidence after a detected change.
    pub state: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PeerPrekeyState {
    Available,
    Published,
    Used,
}

#[derive(Debug, Clone)]
pub struct StoredPreKeyEntry {
    pub id: u32,
    pub state: PeerPrekeyState,
}

#[derive(Debug, Clone)]
pub struct StoredPreKeyRecord {
    pub id: u32,
    pub state: PeerPrekeyState,
    /// Serialized PreKeyRecord / KyberPreKeyRecord bytes.
    pub record: Vec<u8>,
}

/// Monotonic id allocators; ids never recycle.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerCryptoCounters {
    pub next_pre_key_id: u32,
    pub next_signed_pre_key_id: u32,
    pub next_kyber_pre_key_id: u32,
}

impl Default for PeerCryptoCounters {
    fn default() -> Self {
        Self { next_pre_key_id: 1, next_signed_pre_key_id: 1, next_kyber_pre_key_id: 1 }
    }
}

/// A read-through overlay write captured during one ratchet operation.
#[derive(Debug, Clone)]
pub enum PeerCryptoMutation {
    Identity(PeerIdentitySecretRecord),
    SavePeerBinding(PeerIdentityBinding),
    DeletePeerBinding(String),
    SaveSession { address_key: String, value: Vec<u8> },
    DeleteSession(String),
    SavePreKey(StoredPreKeyRecord),
    DeletePreKey(u32),
    SaveSignedPreKey { id: u32, value: Vec<u8> },
    DeleteSignedPreKey(u32),
    SaveKyberPreKey(StoredPreKeyRecord),
    DeleteKyberPreKey(u32),
    Counters(PeerCryptoCounters),
}

/// One prepared ratchet + local-message commit. `application_record` is
/// opaque host-owned state (an inbox or outbox row).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerCryptoPreparedOperation {
    pub version: u64,
    pub kind: String,
    pub message_id: String,
    pub mutations: Vec<Value>,
    /// base64url of the opaque application record bytes.
    pub application_record: String,
    pub prepared_at: String,
}

/// Stable store key for one session address: `sesame` resolution is per (name, device).
pub fn peer_session_address_key(name: &str, device_id: u32) -> String {
    format!("{device_id}--{name}")
}

pub fn parse_peer_session_address_key(key: &str) -> Option<(u32, String)> {
    let split = key.find("--")?;
    if split == 0 {
        return None;
    }
    let device_id: u32 = key[..split].parse().ok()?;
    let name = &key[split + 2..];
    if device_id < 1 || !crate::peer::types::is_peer_id(name) {
        return None;
    }
    Some((device_id, name.to_string()))
}

/// Sync durable crypto store contract. File IO is synchronous — callers run
/// on the peer runtime's dedicated thread.
pub trait PeerCryptoStore {
    fn load_identity(&self) -> Result<Option<PeerIdentitySecretRecord>>;
    fn save_identity(&self, record: &PeerIdentitySecretRecord) -> Result<()>;

    fn load_peer_binding(&self, peer_id: &str) -> Result<Option<PeerIdentityBinding>>;
    fn save_peer_binding(&self, binding: &PeerIdentityBinding) -> Result<()>;
    fn delete_peer_binding(&self, peer_id: &str) -> Result<()>;
    fn list_peer_bindings(&self) -> Result<Vec<PeerIdentityBinding>>;

    fn load_session(&self, address_key: &str) -> Result<Option<Vec<u8>>>;
    fn save_session(&self, address_key: &str, serialized: &[u8]) -> Result<()>;
    fn delete_session(&self, address_key: &str) -> Result<()>;
    fn list_session_keys(&self) -> Result<Vec<String>>;

    fn load_pre_key(&self, id: u32) -> Result<Option<StoredPreKeyRecord>>;
    fn save_pre_key(&self, record: &StoredPreKeyRecord) -> Result<()>;
    fn delete_pre_key(&self, id: u32) -> Result<()>;
    fn list_pre_keys(&self) -> Result<Vec<StoredPreKeyEntry>>;

    fn load_signed_pre_key(&self, id: u32) -> Result<Option<Vec<u8>>>;
    fn save_signed_pre_key(&self, id: u32, serialized: &[u8]) -> Result<()>;
    fn delete_signed_pre_key(&self, id: u32) -> Result<()>;
    fn list_signed_pre_keys(&self) -> Result<Vec<u32>>;

    fn load_kyber_pre_key(&self, id: u32) -> Result<Option<StoredPreKeyRecord>>;
    fn save_kyber_pre_key(&self, record: &StoredPreKeyRecord) -> Result<()>;
    fn delete_kyber_pre_key(&self, id: u32) -> Result<()>;
    fn list_kyber_pre_keys(&self) -> Result<Vec<StoredPreKeyEntry>>;

    fn load_counters(&self) -> Result<Option<PeerCryptoCounters>>;
    fn save_counters(&self, counters: &PeerCryptoCounters) -> Result<()>;

    /// Single-record durable WAL.
    fn load_prepared_operation(&self) -> Result<Option<PeerCryptoPreparedOperation>>;
    fn prepare_operation(&self, record: &PeerCryptoPreparedOperation) -> Result<()>;
    fn apply_prepared_operation(&self) -> Result<()>;
    fn finalize_prepared_operation(&self, message_id: &str, kind: &str) -> Result<()>;
}

pub fn apply_peer_crypto_mutation(store: &dyn PeerCryptoStore, mutation: &PeerCryptoMutation) -> Result<()> {
    match mutation {
        PeerCryptoMutation::Identity(record) => store.save_identity(record),
        PeerCryptoMutation::SavePeerBinding(binding) => store.save_peer_binding(binding),
        PeerCryptoMutation::DeletePeerBinding(peer_id) => store.delete_peer_binding(peer_id),
        PeerCryptoMutation::SaveSession { address_key, value } => store.save_session(address_key, value),
        PeerCryptoMutation::DeleteSession(key) => store.delete_session(key),
        PeerCryptoMutation::SavePreKey(record) => store.save_pre_key(record),
        PeerCryptoMutation::DeletePreKey(id) => store.delete_pre_key(*id),
        PeerCryptoMutation::SaveSignedPreKey { id, value } => store.save_signed_pre_key(*id, value),
        PeerCryptoMutation::DeleteSignedPreKey(id) => store.delete_signed_pre_key(*id),
        PeerCryptoMutation::SaveKyberPreKey(record) => store.save_kyber_pre_key(record),
        PeerCryptoMutation::DeleteKyberPreKey(id) => store.delete_kyber_pre_key(*id),
        PeerCryptoMutation::Counters(counters) => store.save_counters(counters),
    }
}

fn safe_name(raw: &str) -> String {
    b64u_encode(raw.as_bytes())
}

fn unsafe_name(encoded: &str) -> Option<String> {
    let bytes = b64u_decode(encoded, 4096).ok()?;
    String::from_utf8(bytes).ok()
}

pub(crate) fn atomic_write(path: &Path, body: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| store_error("The peer store directory could not be created."))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, body).map_err(|_| store_error("The peer store record could not be written."))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|_| store_error("The peer store record could not be committed."))
}

fn read_json(path: &Path) -> Result<Option<Value>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| store_error("A peer store record is malformed.")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(store_error("A peer store record could not be read.")),
    }
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let body = serde_json::to_vec(value).map_err(|_| store_error("A peer store record could not be encoded."))?;
    atomic_write(path, &body)
}

fn as_bytes(value: &Value, what: &str) -> Result<Vec<u8>> {
    let s = value.as_str().ok_or_else(|| store_error(&format!("Store record {what} carries no valid base64url payload.")))?;
    b64u_decode(s, 16 * 1024 * 1024).map_err(|_| store_error(&format!("Store record {what} carries no valid base64url payload.")))
}

fn as_u32(value: &Value, what: &str) -> Result<u32> {
    value
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| store_error(&format!("Store record {what} is missing a required integer field.")))
}

fn as_state(value: &Value, what: &str) -> Result<PeerPrekeyState> {
    match value.as_str() {
        Some("available") => Ok(PeerPrekeyState::Available),
        Some("published") => Ok(PeerPrekeyState::Published),
        Some("used") => Ok(PeerPrekeyState::Used),
        _ => Err(store_error(&format!("Store record {what} carries an unknown prekey lifecycle state."))),
    }
}

pub struct FilePeerCryptoStore {
    root: PathBuf,
}

impl FilePeerCryptoStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn file(&self, kind: &str, name: &str) -> PathBuf {
        match kind {
            "identity" => self.root.join("identity.json"),
            "meta" => self.root.join("meta.json"),
            "peer-operation" => self.root.join("peer-operation.json"),
            dir => self.root.join(dir).join(format!("{}.json", safe_name(name))),
        }
    }

    fn load_pre_key_entry(&self, dir: &str, id: u32) -> Result<Option<StoredPreKeyRecord>> {
        let what = format!("{dir}/{id}");
        let Some(record) = read_json(&self.file(dir, &id.to_string()))? else { return Ok(None) };
        Ok(Some(StoredPreKeyRecord {
            id,
            state: as_state(&record["state"], &what)?,
            record: as_bytes(&record["record"], &what)?,
        }))
    }

    fn save_pre_key_entry(&self, dir: &str, entry: &StoredPreKeyRecord) -> Result<()> {
        write_json(
            &self.file(dir, &entry.id.to_string()),
            &serde_json::json!({
                "id": entry.id,
                "state": serde_json::to_value(entry.state).unwrap_or(Value::Null),
                "record": b64u_encode(&entry.record),
            }),
        )
    }

    fn list_pre_key_entries(&self, dir: &str) -> Result<Vec<StoredPreKeyEntry>> {
        let dir_path = self.root.join(dir);
        let mut out = Vec::new();
        let entries = match fs::read_dir(&dir_path) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(_) => return Err(store_error("The peer store directory could not be listed.")),
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") {
                continue;
            }
            let encoded = &name[..name.len() - 5];
            let Some(id_str) = unsafe_name(encoded) else { continue };
            let Ok(id) = id_str.parse::<u32>() else { continue };
            let what = format!("{dir}/{id}");
            if let Some(record) = read_json(&entry.path())? {
                out.push(StoredPreKeyEntry { id, state: as_state(&record["state"], &what)? });
            }
        }
        out.sort_by_key(|e| e.id);
        Ok(out)
    }
}

impl PeerCryptoStore for FilePeerCryptoStore {
    fn load_identity(&self) -> Result<Option<PeerIdentitySecretRecord>> {
        let Some(record) = read_json(&self.file("identity", ""))? else { return Ok(None) };
        serde_json::from_value(record).map(Some).map_err(|_| store_error("The identity record is malformed."))
    }

    fn save_identity(&self, record: &PeerIdentitySecretRecord) -> Result<()> {
        write_json(&self.file("identity", ""), &serde_json::to_value(record).unwrap_or(Value::Null))
    }

    fn load_peer_binding(&self, peer_id: &str) -> Result<Option<PeerIdentityBinding>> {
        let Some(record) = read_json(&self.file("peers", peer_id))? else { return Ok(None) };
        serde_json::from_value(record).map(Some).map_err(|_| store_error("A peer binding record is malformed."))
    }

    fn save_peer_binding(&self, binding: &PeerIdentityBinding) -> Result<()> {
        write_json(&self.file("peers", &binding.peer_id), &serde_json::to_value(binding).unwrap_or(Value::Null))
    }

    fn delete_peer_binding(&self, peer_id: &str) -> Result<()> {
        let _ = fs::remove_file(self.file("peers", peer_id));
        Ok(())
    }

    fn list_peer_bindings(&self) -> Result<Vec<PeerIdentityBinding>> {
        let dir_path = self.root.join("peers");
        let mut out = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir_path) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.ends_with(".json") {
                    continue;
                }
                if let Some(record) = read_json(&entry.path())? {
                    if let Ok(binding) = serde_json::from_value::<PeerIdentityBinding>(record) {
                        out.push(binding);
                    }
                }
            }
        }
        out.sort_by(|a, b| a.peer_id.cmp(&b.peer_id));
        Ok(out)
    }

    fn load_session(&self, address_key: &str) -> Result<Option<Vec<u8>>> {
        let what = format!("sessions/{address_key}");
        let Some(record) = read_json(&self.file("sessions", address_key))? else { return Ok(None) };
        as_bytes(&record["record"], &what).map(Some)
    }

    fn save_session(&self, address_key: &str, serialized: &[u8]) -> Result<()> {
        write_json(
            &self.file("sessions", address_key),
            &serde_json::json!({ "version": PEER_STORE_RECORD_VERSION, "record": b64u_encode(serialized) }),
        )
    }

    fn delete_session(&self, address_key: &str) -> Result<()> {
        let _ = fs::remove_file(self.file("sessions", address_key));
        Ok(())
    }

    fn list_session_keys(&self) -> Result<Vec<String>> {
        let dir_path = self.root.join("sessions");
        let mut out = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir_path) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.ends_with(".json") {
                    continue;
                }
                if let Some(key) = unsafe_name(&name[..name.len() - 5]) {
                    out.push(key);
                }
            }
        }
        out.sort();
        Ok(out)
    }

    fn load_pre_key(&self, id: u32) -> Result<Option<StoredPreKeyRecord>> {
        self.load_pre_key_entry("prekeys", id)
    }

    fn save_pre_key(&self, record: &StoredPreKeyRecord) -> Result<()> {
        self.save_pre_key_entry("prekeys", record)
    }

    fn delete_pre_key(&self, id: u32) -> Result<()> {
        let _ = fs::remove_file(self.file("prekeys", &id.to_string()));
        Ok(())
    }

    fn list_pre_keys(&self) -> Result<Vec<StoredPreKeyEntry>> {
        self.list_pre_key_entries("prekeys")
    }

    fn load_signed_pre_key(&self, id: u32) -> Result<Option<Vec<u8>>> {
        let what = format!("signed-prekeys/{id}");
        let Some(record) = read_json(&self.file("signed-prekeys", &id.to_string()))? else { return Ok(None) };
        as_bytes(&record["record"], &what).map(Some)
    }

    fn save_signed_pre_key(&self, id: u32, serialized: &[u8]) -> Result<()> {
        write_json(
            &self.file("signed-prekeys", &id.to_string()),
            &serde_json::json!({ "version": PEER_STORE_RECORD_VERSION, "record": b64u_encode(serialized) }),
        )
    }

    fn delete_signed_pre_key(&self, id: u32) -> Result<()> {
        let _ = fs::remove_file(self.file("signed-prekeys", &id.to_string()));
        Ok(())
    }

    fn list_signed_pre_keys(&self) -> Result<Vec<u32>> {
        let dir_path = self.root.join("signed-prekeys");
        let mut out = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir_path) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.ends_with(".json") {
                    continue;
                }
                if let Some(id_str) = unsafe_name(&name[..name.len() - 5]) {
                    if let Ok(id) = id_str.parse::<u32>() {
                        out.push(id);
                    }
                }
            }
        }
        out.sort();
        Ok(out)
    }

    fn load_kyber_pre_key(&self, id: u32) -> Result<Option<StoredPreKeyRecord>> {
        self.load_pre_key_entry("kyber-prekeys", id)
    }

    fn save_kyber_pre_key(&self, record: &StoredPreKeyRecord) -> Result<()> {
        self.save_pre_key_entry("kyber-prekeys", record)
    }

    fn delete_kyber_pre_key(&self, id: u32) -> Result<()> {
        let _ = fs::remove_file(self.file("kyber-prekeys", &id.to_string()));
        Ok(())
    }

    fn list_kyber_pre_keys(&self) -> Result<Vec<StoredPreKeyEntry>> {
        self.list_pre_key_entries("kyber-prekeys")
    }

    fn load_counters(&self) -> Result<Option<PeerCryptoCounters>> {
        let Some(record) = read_json(&self.file("meta", ""))? else { return Ok(None) };
        serde_json::from_value(record).map(Some).map_err(|_| store_error("The counters record is malformed."))
    }

    fn save_counters(&self, counters: &PeerCryptoCounters) -> Result<()> {
        write_json(&self.file("meta", ""), &serde_json::to_value(counters).unwrap_or(Value::Null))
    }

    fn load_prepared_operation(&self) -> Result<Option<PeerCryptoPreparedOperation>> {
        let Some(record) = read_json(&self.file("peer-operation", ""))? else { return Ok(None) };
        serde_json::from_value(record).map(Some).map_err(|_| store_error("The prepared operation record is malformed."))
    }

    fn prepare_operation(&self, record: &PeerCryptoPreparedOperation) -> Result<()> {
        if self.load_prepared_operation()?.is_some() {
            return Err(store_error("A ratchet operation is still awaiting recovery."));
        }
        write_json(&self.file("peer-operation", ""), &serde_json::to_value(record).unwrap_or(Value::Null))
    }

    fn apply_prepared_operation(&self) -> Result<()> {
        let Some(record) = self.load_prepared_operation()? else { return Ok(()) };
        if record.version != 1 {
            return Ok(());
        }
        for mutation in &record.mutations {
            apply_mutation_json(self, mutation)?;
        }
        Ok(())
    }

    fn finalize_prepared_operation(&self, message_id: &str, kind: &str) -> Result<()> {
        match self.load_prepared_operation()? {
            Some(record) if record.message_id == message_id && record.kind == kind => {
                let _ = fs::remove_file(self.file("peer-operation", ""));
                Ok(())
            }
            _ => Err(store_error("The ratchet operation does not match its finalization id.")),
        }
    }
}

/// JSON form of `PeerCryptoMutation` — kept inside prepared-op WAL records.
fn mutation_to_json(mutation: &PeerCryptoMutation) -> Value {
    match mutation {
        PeerCryptoMutation::Identity(record) => serde_json::json!({ "kind": "identity", "record": record }),
        PeerCryptoMutation::SavePeerBinding(binding) => serde_json::json!({ "kind": "peerBinding", "operation": "save", "record": binding }),
        PeerCryptoMutation::DeletePeerBinding(peer_id) => serde_json::json!({ "kind": "peerBinding", "operation": "delete", "peerId": peer_id }),
        PeerCryptoMutation::SaveSession { address_key, value } => serde_json::json!({ "kind": "session", "operation": "save", "addressKey": address_key, "value": b64u_encode(value) }),
        PeerCryptoMutation::DeleteSession(key) => serde_json::json!({ "kind": "session", "operation": "delete", "addressKey": key }),
        PeerCryptoMutation::SavePreKey(record) => serde_json::json!({ "kind": "preKey", "operation": "save", "record": prekey_record_json(record) }),
        PeerCryptoMutation::DeletePreKey(id) => serde_json::json!({ "kind": "preKey", "operation": "delete", "id": id }),
        PeerCryptoMutation::SaveSignedPreKey { id, value } => serde_json::json!({ "kind": "signedPreKey", "operation": "save", "id": id, "value": b64u_encode(value) }),
        PeerCryptoMutation::DeleteSignedPreKey(id) => serde_json::json!({ "kind": "signedPreKey", "operation": "delete", "id": id }),
        PeerCryptoMutation::SaveKyberPreKey(record) => serde_json::json!({ "kind": "kyberPreKey", "operation": "save", "record": prekey_record_json(record) }),
        PeerCryptoMutation::DeleteKyberPreKey(id) => serde_json::json!({ "kind": "kyberPreKey", "operation": "delete", "id": id }),
        PeerCryptoMutation::Counters(counters) => serde_json::json!({ "kind": "counters", "counters": counters }),
    }
}

fn prekey_record_json(record: &StoredPreKeyRecord) -> Value {
    serde_json::json!({
        "id": record.id,
        "state": serde_json::to_value(record.state).unwrap_or(Value::Null),
        "record": b64u_encode(&record.record),
    })
}

fn apply_mutation_json(store: &dyn PeerCryptoStore, value: &Value) -> Result<()> {
    let kind = value.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "identity" => {
            let record: PeerIdentitySecretRecord = serde_json::from_value(value["record"].clone())
                .map_err(|_| store_error("A prepared identity mutation is malformed."))?;
            store.save_identity(&record)
        }
        "peerBinding" => {
            if value["operation"].as_str() == Some("save") {
                let binding: PeerIdentityBinding = serde_json::from_value(value["record"].clone())
                    .map_err(|_| store_error("A prepared peer binding mutation is malformed."))?;
                store.save_peer_binding(&binding)
            } else {
                let peer_id = value["peerId"].as_str().unwrap_or("").to_string();
                store.delete_peer_binding(&peer_id)
            }
        }
        "session" => {
            let key = value["addressKey"].as_str().unwrap_or("").to_string();
            if value["operation"].as_str() == Some("save") {
                let bytes = as_bytes(&value["value"], "prepared session mutation")?;
                store.save_session(&key, &bytes)
            } else {
                store.delete_session(&key)
            }
        }
        "preKey" | "kyberPreKey" => {
            let save = value["operation"].as_str() == Some("save");
            if save {
                let record = StoredPreKeyRecord {
                    id: as_u32(&value["record"]["id"], "prepared prekey mutation")?,
                    state: as_state(&value["record"]["state"], "prepared prekey mutation")?,
                    record: as_bytes(&value["record"]["record"], "prepared prekey mutation")?,
                };
                if kind == "preKey" { store.save_pre_key(&record) } else { store.save_kyber_pre_key(&record) }
            } else {
                let id = as_u32(&value["id"], "prepared prekey mutation")?;
                if kind == "preKey" { store.delete_pre_key(id) } else { store.delete_kyber_pre_key(id) }
            }
        }
        "signedPreKey" => {
            let id = as_u32(&value["id"], "prepared signed prekey mutation")?;
            if value["operation"].as_str() == Some("save") {
                let bytes = as_bytes(&value["value"], "prepared signed prekey mutation")?;
                store.save_signed_pre_key(id, &bytes)
            } else {
                store.delete_signed_pre_key(id)
            }
        }
        "counters" => {
            let counters: PeerCryptoCounters = serde_json::from_value(value["counters"].clone())
                .map_err(|_| store_error("A prepared counters mutation is malformed."))?;
            store.save_counters(&counters)
        }
        _ => Err(store_error("An unknown prepared mutation kind was stored.")),
    }
}

/// Serialize a mutation list for WAL persistence.
pub fn mutations_to_json(mutations: &[PeerCryptoMutation]) -> Vec<Value> {
    mutations.iter().map(mutation_to_json).collect()
}
