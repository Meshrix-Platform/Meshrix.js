//! Durable application journal — intentionally separate from the Peer/Signal
//! stores. File layout under `dir`:
//!
//! ```text
//! operations/<key>.json            operation records (keyed by digest)
//! op-index/<operationId>.json      ["key", ...] index rows
//! recovery/operations/<key>.json   pending operation recovery markers
//! recovery/discovery/<key>.json    pending discovery recovery markers
//! recovery/handoff/<key>.json      pending handoff plans (key = messageId)
//! parts/<key>/<index>.json         committed result parts
//! partial/<key>/<index>.json       in-flight partial result chunks
//! fragments/<digest>/parts/<n>.part  reassembly bytes per logical message
//! fragments/<digest>/applied       applied marker for a reassembled message
//! fragments/<digest>/meta.json     fragment-set meta (partCount/totalBytes/kind)
//! discoveries/<key>.json           catalog discovery records
//! ```


use std::fs;
use std::path::{Path, PathBuf};


use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::b64::b64u_decode;
use crate::error::{entry_error, Result};

use super::application::{
    PeerApplicationAddress, PeerApplicationDiscoveryRecord, PeerApplicationDiscoveryRecovery,
    PeerApplicationFragment, PeerApplicationFragmentSaveResult, PeerApplicationFragmentSaveStatus,
    PeerApplicationHandoffPlan, PeerApplicationOperationRecovery, PeerApplicationPage,
    PeerApplicationRecord, PeerApplicationResultPart,
};

fn store_error(detail: &str) -> crate::error::EntryError {
    entry_error("peer_client_store", detail)
}




/// `PeerApplicationJournal` — synchronous file IO; callers run on the peer
/// runtime's single-thread executor so no async wrapping is needed.
pub trait PeerApplicationJournal {
    fn get_operation(&self, key: &str) -> Result<Option<PeerApplicationRecord>>;
    fn list_operations(&self) -> Result<Vec<PeerApplicationRecord>>;
    fn find_operation_keys_by_id(&self, operation_id: &str) -> Result<Vec<String>>;
    fn list_pending_operation_recovery_page(
        &self,
        after_key: Option<&str>,
        limit: usize,
    ) -> Result<PeerApplicationPage<PeerApplicationOperationRecovery>>;
    fn save_pending_operation_recovery(&self, record: &PeerApplicationRecord) -> Result<()>;
    fn clear_pending_operation_recovery(&self, key: &str, expected_state_revision: Option<u64>) -> Result<bool>;
    fn save_operation(&self, record: &PeerApplicationRecord) -> Result<()>;

    fn get_result_part(&self, operation_key: &str, index: u64) -> Result<Option<PeerApplicationResultPart>>;
    fn list_result_parts(&self, operation_key: &str) -> Result<Vec<PeerApplicationResultPart>>;
    fn save_result_part(&self, operation_key: &str, part: &PeerApplicationResultPart) -> Result<()>;
    fn save_partial_result_chunk(&self, operation_key: &str, index: u64, text: &str) -> Result<()>;
    fn list_partial_result_chunks(&self, operation_key: &str) -> Result<Vec<PeerApplicationResultPart>>;
    fn clear_partial_result_chunks(&self, operation_key: &str) -> Result<()>;

    fn save_application_fragment(
        &self,
        fragment: &PeerApplicationFragment,
    ) -> Result<PeerApplicationFragmentSaveResult>;
    fn read_application_fragment_message(
        &self,
        address: &PeerApplicationAddress,
        message_id: &str,
    ) -> Result<Option<Vec<u8>>>;
    fn mark_application_fragment_applied(
        &self,
        address: &PeerApplicationAddress,
        message_id: &str,
    ) -> Result<()>;

    fn get_discovery(&self, key: &str) -> Result<Option<PeerApplicationDiscoveryRecord>>;
    fn list_discoveries(&self) -> Result<Vec<PeerApplicationDiscoveryRecord>>;
    fn find_latest_pending_discovery(
        &self,
        address: &PeerApplicationAddress,
    ) -> Result<Option<PeerApplicationDiscoveryRecord>>;
    fn list_pending_discovery_recovery_page(
        &self,
        after_key: Option<&str>,
        limit: usize,
    ) -> Result<PeerApplicationPage<PeerApplicationDiscoveryRecovery>>;
    fn save_pending_discovery_recovery(
        &self,
        record: &PeerApplicationDiscoveryRecovery,
    ) -> Result<()>;
    fn clear_pending_discovery_recovery(&self, key: &str, expected_action: Option<&str>) -> Result<bool>;
    fn save_discovery(&self, record: &PeerApplicationDiscoveryRecord) -> Result<()>;

    fn list_pending_handoff_page(
        &self,
        after_key: Option<&str>,
        limit: usize,
    ) -> Result<PeerApplicationPage<PeerApplicationHandoffPlan>>;
    fn get_pending_handoff(&self, key: &str) -> Result<Option<PeerApplicationHandoffPlan>>;
    fn save_pending_handoff(&self, plan: &PeerApplicationHandoffPlan) -> Result<()>;
    fn clear_pending_handoff(&self, key: &str) -> Result<()>;
}

/* ------------------------------ file helpers ------------------------------- */

fn safe_key(raw: &str) -> String {
    if raw
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'~'))
        && !raw.is_empty()
        && raw.len() <= 512
    {
        raw.to_string()
    } else {
        format!("x.{}", hex_encode(&Sha256::digest(raw.as_bytes())))
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| store_error(&format!("The application journal directory cannot be created: {e}")))?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    fs::write(&tmp, bytes)
        .map_err(|e| store_error(&format!("The application journal record cannot be written: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path)
        .map_err(|e| store_error(&format!("The application journal record cannot be committed: {e}")))?;
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| store_error("The application journal record cannot be encoded."))?;
    write_private(path, &bytes)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path)
        .map_err(|e| store_error(&format!("The application journal record cannot be read: {e}")))?;
    let value: T = serde_json::from_slice(&bytes)
        .map_err(|e| store_error(&format!("The application journal record is malformed: {e}")))?;
    Ok(Some(value))
}

fn list_json_files(dir: &Path) -> Result<Vec<PathBuf>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)
        .map_err(|e| store_error(&format!("The application journal directory cannot be read: {e}")))?
    {
        let entry = entry.map_err(|e| store_error(&e.to_string()))?;
        if entry
            .file_name()
            .to_str()
            .map(|n| n.ends_with(".json"))
            .unwrap_or(false)
        {
            out.push(entry.path());
        }
    }
    out.sort();
    Ok(out)
}

/// `#listRecoveryPage` — filename cursor over sorted marker names. Selected
/// names count toward the page even when the marker fails to parse.
fn page_of<T: Clone>(
    mut keys: Vec<String>,
    after_key: Option<&str>,
    limit: usize,
    load: impl Fn(&str) -> Result<Option<T>>,
) -> Result<PeerApplicationPage<T>> {
    keys.sort();
    let after = after_key.unwrap_or("");
    let remaining: Vec<String> = keys.into_iter().filter(|k| k.as_str() > after).collect();
    let selected: Vec<String> = remaining.iter().take(limit).cloned().collect();
    let mut items: Vec<T> = Vec::new();
    for key in &selected {
        if let Some(item) = load(key)? {
            items.push(item);
        }
    }
    let next_after_key = if remaining.len() > selected.len() {
        selected.last().cloned()
    } else {
        None
    };
    Ok(PeerApplicationPage { items, next_after_key })
}

fn fragment_dir(address: &PeerApplicationAddress, message_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(
        [
            address.tenant_id.as_str(),
            address.route_id.as_str(),
            address.local_device_id.as_str(),
            address.peer_device_id.as_str(),
            message_id,
        ]
        .join("\u{0}")
        .as_bytes(),
    );
    format!("{:x}", hasher.finalize())
}

/* ------------------------------- file journal ------------------------------ */

/// `FilePeerApplicationJournal` — durable file-backed journal.
pub struct FilePeerApplicationJournal {
    dir: PathBuf,
}

/// `StoredFragmentAssembly` — durable manifest per logical message.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredFragmentAssembly {
    version: u64,
    address: PeerApplicationAddress,
    message_id: String,
    message_kind: String,
    part_count: u64,
    total_bytes: u64,
    complete: bool,
    applied: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredFragmentPart {
    part_index: u64,
    data: String,
}

const MAX_ACTIVE_FRAGMENT_ASSEMBLIES: usize = 128;

impl FilePeerApplicationJournal {
    pub fn new(dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&dir)
            .map_err(|e| store_error(&format!("The application journal directory cannot be created: {e}")))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        }
        Ok(Self { dir })
    }

    fn operation_path(&self, key: &str) -> PathBuf {
        self.dir.join("operations").join(format!("{}.json", safe_key(key)))
    }

    fn op_index_path(&self, operation_id: &str) -> PathBuf {
        self.dir.join("op-index").join(format!("{}.json", safe_key(operation_id)))
    }

    fn recovery_path(&self, kind: &str, key: &str) -> PathBuf {
        self.dir.join("recovery").join(kind).join(format!("{}.json", safe_key(key)))
    }

    fn recovery_keys(&self, kind: &str) -> Result<Vec<String>> {
        let dir = self.dir.join("recovery").join(kind);
        let mut keys = Vec::new();
        for path in list_json_files(&dir)? {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                keys.push(stem.to_string());
            }
        }
        Ok(keys)
    }

    fn parts_dir(&self, operation_key: &str, kind: &str) -> PathBuf {
        self.dir.join(kind).join(safe_key(operation_key))
    }

    fn list_parts_in(&self, dir: &Path) -> Result<Vec<PeerApplicationResultPart>> {
        let mut parts = Vec::new();
        for path in list_json_files(dir)? {
            if let Some(part) = read_json::<PeerApplicationResultPart>(&path)? {
                parts.push(part);
            }
        }
        parts.sort_by_key(|p| p.index);
        Ok(parts)
    }

    fn fragment_base(&self, address: &PeerApplicationAddress, message_id: &str) -> PathBuf {
        self.dir
            .join("fragments")
            .join(fragment_dir(address, message_id))
    }

    fn fragment_manifest_path(&self, address: &PeerApplicationAddress, message_id: &str) -> PathBuf {
        self.fragment_base(address, message_id).join("manifest.json")
    }

    fn read_fragment_manifest(
        &self,
        address: &PeerApplicationAddress,
        message_id: &str,
    ) -> Result<Option<StoredFragmentAssembly>> {
        read_json(&self.fragment_manifest_path(address, message_id))
    }

    fn write_fragment_manifest(&self, assembly: &StoredFragmentAssembly) -> Result<()> {
        write_json(
            &self
                .fragment_base(&assembly.address, &assembly.message_id)
                .join("manifest.json"),
            &serde_json::to_value(assembly).unwrap_or(Value::Null),
        )
    }

    /// Count of assemblies whose manifest exists and is not `applied`.
    fn count_active_fragment_assemblies(&self) -> Result<usize> {
        let root = self.dir.join("fragments");
        let mut active = 0usize;
        if !root.exists() {
            return Ok(0);
        }
        for entry in fs::read_dir(&root).map_err(|e| store_error(&e.to_string()))? {
            let entry = entry.map_err(|e| store_error(&e.to_string()))?;
            if !entry.path().is_dir() {
                continue;
            }
            if let Some(assembly) =
                read_json::<StoredFragmentAssembly>(&entry.path().join("manifest.json"))?
            {
                if !assembly.applied {
                    active += 1;
                }
            }
        }
        Ok(active)
    }

    /// (receivedParts, receivedBytes) scanned from the part files on disk.
    fn scan_fragment_progress(
        &self,
        address: &PeerApplicationAddress,
        message_id: &str,
        part_count: u64,
    ) -> Result<(u64, u64)> {
        let parts_dir = self.fragment_base(address, message_id).join("parts");
        let (mut received_parts, mut received_bytes) = (0u64, 0u64);
        if !parts_dir.exists() {
            return Ok((0, 0));
        }
        for entry in fs::read_dir(&parts_dir).map_err(|e| store_error(&e.to_string()))? {
            let entry = entry.map_err(|e| store_error(&e.to_string()))?;
            let name = entry.file_name();
            let name = name.to_str().unwrap_or_default().to_string();
            if !name.ends_with(".json") {
                continue;
            }
            let Some(part) = read_json::<StoredFragmentPart>(&entry.path())? else {
                continue;
            };
            let file_index = name[..name.len() - 5].parse::<u64>();
            if file_index != Ok(part.part_index) || part.part_index >= part_count {
                return Err(store_error(
                    "Peer application fragment part index conflicts with its immutable assembly.",
                ));
            }
            let bytes = b64u_decode(&part.data, usize::MAX)
                .map_err(|_| store_error("A Peer application fragment carries invalid data."))?;
            received_parts += 1;
            received_bytes += bytes.len() as u64;
        }
        Ok((received_parts, received_bytes))
    }

    fn operation_recovery_for(record: &PeerApplicationRecord) -> PeerApplicationOperationRecovery {
        PeerApplicationOperationRecovery {
            key: record.key.clone(),
            role: record.role.clone(),
            operation_id: record.operation_id.clone(),
            origin_address: record.origin_address.clone(),
            route_address: record.route_address.clone(),
            request_digest: record.request_digest.clone(),
            cancel_requested: record.cancel_requested,
            terminal: status_terminal_for(&record.status),
            terminal_prepared: record.terminal_prepared,
            execution_pending: record.role == "receiver"
                && !record.terminal_prepared
                && !status_terminal_for(&record.status),
            result_part_count: record.result_part_count,
            state_revision: record.state_revision,
            created_at: record.created_at.clone(),
        }
    }
}

fn status_terminal_for(s: &str) -> bool {
    matches!(s, "completed" | "refused" | "stopped" | "cancelled" | "unknown" | "failed")
}

impl PeerApplicationJournal for FilePeerApplicationJournal {
    fn get_operation(&self, key: &str) -> Result<Option<PeerApplicationRecord>> {
        read_json(&self.operation_path(key))
    }

    fn list_operations(&self) -> Result<Vec<PeerApplicationRecord>> {
        let mut out = Vec::new();
        for path in list_json_files(&self.dir.join("operations"))? {
            if let Some(record) = read_json::<PeerApplicationRecord>(&path)? {
                out.push(record);
            }
        }
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(out)
    }

    fn find_operation_keys_by_id(&self, operation_id: &str) -> Result<Vec<String>> {
        let index_path = self.op_index_path(operation_id);
        let keys = read_json::<Vec<String>>(&index_path)?.unwrap_or_default();
        let existing: Vec<String> = keys
            .iter()
            .filter(|k| matches!(self.get_operation(k), Ok(Some(_))))
            .cloned()
            .collect();
        if existing.len() != keys.len() {
            if existing.is_empty() {
                if index_path.exists() {
                    fs::remove_file(&index_path).map_err(|e| store_error(&e.to_string()))?;
                }
            } else {
                write_json(&index_path, &json!(existing))?;
            }
        }
        Ok(existing)
    }

    fn list_pending_operation_recovery_page(
        &self,
        after_key: Option<&str>,
        limit: usize,
    ) -> Result<PeerApplicationPage<PeerApplicationOperationRecovery>> {
        let keys = self.recovery_keys("operations")?;
        page_of(keys, after_key, limit, |k| {
            read_json(&self.recovery_path("operations", k))
        })
    }

    fn save_pending_operation_recovery(&self, record: &PeerApplicationRecord) -> Result<()> {
        let recovery = Self::operation_recovery_for(record);
        let path = self.recovery_path("operations", &record.key);
        if let Some(existing) = read_json::<PeerApplicationOperationRecovery>(&path)? {
            if existing == recovery {
                return Ok(());
            }
        }
        write_json(&path, &serde_json::to_value(&recovery).unwrap_or(Value::Null))
    }

    fn clear_pending_operation_recovery(&self, key: &str, expected_state_revision: Option<u64>) -> Result<bool> {
        let path = self.recovery_path("operations", key);
        let Some(current) = read_json::<PeerApplicationOperationRecovery>(&path)? else {
            return Ok(true);
        };
        if let Some(expected) = expected_state_revision {
            if current.state_revision != expected {
                return Ok(false);
            }
        }
        fs::remove_file(&path).map_err(|e| store_error(&e.to_string()))?;
        Ok(true)
    }

    fn save_operation(&self, record: &PeerApplicationRecord) -> Result<()> {
        write_json(
            &self.operation_path(&record.key),
            &serde_json::to_value(record).unwrap_or(Value::Null),
        )?;
        // Keep the operation-id index in lockstep with record writes.
        let index_path = self.op_index_path(&record.operation_id);
        let mut keys = read_json::<Vec<String>>(&index_path)?.unwrap_or_default();
        if !keys.iter().any(|k| k == &record.key) {
            keys.push(record.key.clone());
            keys.sort();
            write_json(&index_path, &json!(keys))?;
        }
        Ok(())
    }

    fn get_result_part(&self, operation_key: &str, index: u64) -> Result<Option<PeerApplicationResultPart>> {
        read_json(&self.parts_dir(operation_key, "parts").join(format!("{index}.json")))
    }

    fn list_result_parts(&self, operation_key: &str) -> Result<Vec<PeerApplicationResultPart>> {
        self.list_parts_in(&self.parts_dir(operation_key, "parts"))
    }

    fn save_result_part(&self, operation_key: &str, part: &PeerApplicationResultPart) -> Result<()> {
        write_json(
            &self.parts_dir(operation_key, "parts").join(format!("{}.json", part.index)),
            &serde_json::to_value(part).unwrap_or(Value::Null),
        )
    }

    fn save_partial_result_chunk(&self, operation_key: &str, index: u64, text: &str) -> Result<()> {
        write_json(
            &self.parts_dir(operation_key, "partial").join(format!("{index}.json")),
            &serde_json::to_value(&PeerApplicationResultPart {
                index,
                text: text.to_string(),
            })
            .unwrap_or(Value::Null),
        )
    }

    fn list_partial_result_chunks(&self, operation_key: &str) -> Result<Vec<PeerApplicationResultPart>> {
        self.list_parts_in(&self.parts_dir(operation_key, "partial"))
    }

    fn clear_partial_result_chunks(&self, operation_key: &str) -> Result<()> {
        let dir = self.parts_dir(operation_key, "partial");
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| store_error(&e.to_string()))?;
        }
        Ok(())
    }

    fn save_application_fragment(
        &self,
        fragment: &PeerApplicationFragment,
    ) -> Result<PeerApplicationFragmentSaveResult> {
        // `saveApplicationFragment` — single-threaded journal, so the TS
        // fragment lock is implicit.
        let mut assembly = match self.read_fragment_manifest(&fragment.address, &fragment.message_id)? {
            Some(existing) => {
                if existing.address != fragment.address
                    || existing.message_id != fragment.message_id
                    || existing.message_kind != fragment.message_kind
                    || existing.part_count != fragment.part_count
                    || existing.total_bytes != fragment.total_bytes
                {
                    return Ok(PeerApplicationFragmentSaveResult {
                        status: PeerApplicationFragmentSaveStatus::Conflict,
                        received_parts: 0,
                    });
                }
                existing
            }
            None => {
                if self.count_active_fragment_assemblies()? >= MAX_ACTIVE_FRAGMENT_ASSEMBLIES {
                    return Ok(PeerApplicationFragmentSaveResult {
                        status: PeerApplicationFragmentSaveStatus::Backpressured,
                        received_parts: 0,
                    });
                }
                let incoming = StoredFragmentAssembly {
                    version: 1,
                    address: fragment.address.clone(),
                    message_id: fragment.message_id.clone(),
                    message_kind: fragment.message_kind.clone(),
                    part_count: fragment.part_count,
                    total_bytes: fragment.total_bytes,
                    complete: false,
                    applied: false,
                };
                self.write_fragment_manifest(&incoming)?;
                incoming
            }
        };
        if fragment.part_index >= assembly.part_count {
            return Ok(PeerApplicationFragmentSaveResult {
                status: PeerApplicationFragmentSaveStatus::Conflict,
                received_parts: 0,
            });
        }
        if assembly.applied {
            let parts = self.fragment_base(&fragment.address, &fragment.message_id).join("parts");
            if parts.exists() {
                fs::remove_dir_all(&parts).map_err(|e| store_error(&e.to_string()))?;
            }
            return Ok(PeerApplicationFragmentSaveResult {
                status: PeerApplicationFragmentSaveStatus::Applied,
                received_parts: assembly.part_count,
            });
        }
        let (mut received_parts, mut received_bytes) = self.scan_fragment_progress(
            &fragment.address,
            &fragment.message_id,
            assembly.part_count,
        )?;
        if !assembly.complete
            && received_parts == assembly.part_count
            && received_bytes == assembly.total_bytes
        {
            assembly.complete = true;
            self.write_fragment_manifest(&assembly)?;
        }
        let part_path = self
            .fragment_base(&fragment.address, &fragment.message_id)
            .join("parts")
            .join(format!("{}.json", fragment.part_index));
        if let Some(stored) = read_json::<StoredFragmentPart>(&part_path)? {
            if stored.part_index != fragment.part_index || stored.data != fragment.data {
                return Ok(PeerApplicationFragmentSaveResult {
                    status: PeerApplicationFragmentSaveStatus::Conflict,
                    received_parts,
                });
            }
        } else {
            if assembly.complete {
                return Err(store_error(
                    "A completed Peer application fragment assembly is missing a durable part.",
                ));
            }
            let bytes = b64u_decode(&fragment.data, usize::MAX)
                .map_err(|_| store_error("A Peer application fragment carries invalid data."))?;
            let next_bytes = received_bytes + bytes.len() as u64;
            if next_bytes > assembly.total_bytes {
                return Ok(PeerApplicationFragmentSaveResult {
                    status: PeerApplicationFragmentSaveStatus::Conflict,
                    received_parts,
                });
            }
            write_json(
                &part_path,
                &serde_json::to_value(&StoredFragmentPart {
                    part_index: fragment.part_index,
                    data: fragment.data.clone(),
                })
                .unwrap_or(Value::Null),
            )?;
            received_parts += 1;
            received_bytes = next_bytes;
        }
        if !assembly.complete && received_parts == assembly.part_count {
            if received_bytes != assembly.total_bytes {
                return Ok(PeerApplicationFragmentSaveResult {
                    status: PeerApplicationFragmentSaveStatus::Conflict,
                    received_parts,
                });
            }
            assembly.complete = true;
            self.write_fragment_manifest(&assembly)?;
        }
        Ok(PeerApplicationFragmentSaveResult {
            status: if assembly.complete {
                PeerApplicationFragmentSaveStatus::Complete
            } else {
                PeerApplicationFragmentSaveStatus::Incomplete
            },
            received_parts,
        })
    }

    fn read_application_fragment_message(
        &self,
        address: &PeerApplicationAddress,
        message_id: &str,
    ) -> Result<Option<Vec<u8>>> {
        let Some(assembly) = self.read_fragment_manifest(address, message_id)? else {
            return Ok(None);
        };
        if !assembly.complete
            || assembly.applied
            || assembly.message_id != message_id
            || assembly.address != *address
        {
            return Ok(None);
        }
        let (received_parts, received_bytes) =
            self.scan_fragment_progress(address, message_id, assembly.part_count)?;
        if received_parts != assembly.part_count || received_bytes != assembly.total_bytes {
            return Err(store_error("Completed Peer application fragment assembly is incomplete."));
        }
        let parts_dir = self.fragment_base(address, message_id).join("parts");
        let mut out = Vec::with_capacity(received_bytes as usize);
        for index in 0..assembly.part_count {
            let part = read_json::<StoredFragmentPart>(&parts_dir.join(format!("{index}.json")))?
                .ok_or_else(|| store_error("Completed Peer application fragment assembly is missing a part."))?;
            let bytes = b64u_decode(&part.data, usize::MAX)
                .map_err(|_| store_error("A Peer application fragment carries invalid data."))?;
            out.extend_from_slice(&bytes);
        }
        Ok(Some(out))
    }

    fn mark_application_fragment_applied(
        &self,
        address: &PeerApplicationAddress,
        message_id: &str,
    ) -> Result<()> {
        let Some(mut assembly) = self.read_fragment_manifest(address, message_id)? else {
            return Err(store_error(
                "Peer application fragment assembly is missing before durable application commit.",
            ));
        };
        if assembly.message_id != message_id || assembly.address != *address || !assembly.complete {
            return Err(store_error(
                "Peer application fragment assembly is not complete for durable application commit.",
            ));
        }
        if !assembly.applied {
            assembly.applied = true;
            self.write_fragment_manifest(&assembly)?;
        }
        // The marker is durable before cleanup; a crash before removal is
        // recovered by the next duplicate fragment observing `applied`.
        let parts = self.fragment_base(address, message_id).join("parts");
        if parts.exists() {
            fs::remove_dir_all(&parts).map_err(|e| store_error(&e.to_string()))?;
        }
        Ok(())
    }

    fn get_discovery(&self, key: &str) -> Result<Option<PeerApplicationDiscoveryRecord>> {
        read_json(&self.dir.join("discoveries").join(format!("{}.json", safe_key(key))))
    }

    fn list_discoveries(&self) -> Result<Vec<PeerApplicationDiscoveryRecord>> {
        let mut out = Vec::new();
        for path in list_json_files(&self.dir.join("discoveries"))? {
            if let Some(record) = read_json::<PeerApplicationDiscoveryRecord>(&path)? {
                out.push(record);
            }
        }
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(out)
    }

    fn find_latest_pending_discovery(
        &self,
        address: &PeerApplicationAddress,
    ) -> Result<Option<PeerApplicationDiscoveryRecord>> {
        // TS scans pending discovery recovery markers with action="request"
        // then matches the durable record by status/requestId/address.
        let mut latest: Option<PeerApplicationDiscoveryRecord> = None;
        let mut after: Option<String> = None;
        loop {
            let page = self.list_pending_discovery_recovery_page(after.as_deref(), 128)?;
            for recovery in &page.items {
                if recovery.action != "request" || &recovery.address != address {
                    continue;
                }
                let Some(record) = self.get_discovery(&recovery.key)? else {
                    continue;
                };
                if record.status != "pending"
                    || record.request_id != recovery.request_id
                    || record.address != recovery.address
                {
                    continue;
                }
                if latest.as_ref().map(|l| record.updated_at > l.updated_at).unwrap_or(true) {
                    latest = Some(record);
                }
            }
            after = page.next_after_key;
            if after.is_none() {
                break;
            }
        }
        Ok(latest)
    }

    fn list_pending_discovery_recovery_page(
        &self,
        after_key: Option<&str>,
        limit: usize,
    ) -> Result<PeerApplicationPage<PeerApplicationDiscoveryRecovery>> {
        let keys = self.recovery_keys("discovery")?;
        page_of(keys, after_key, limit, |k| {
            read_json(&self.recovery_path("discovery", k))
        })
    }

    fn save_pending_discovery_recovery(&self, record: &PeerApplicationDiscoveryRecovery) -> Result<()> {
        let path = self.recovery_path("discovery", &record.key);
        if let Some(existing) = read_json::<PeerApplicationDiscoveryRecovery>(&path)? {
            if existing == *record {
                return Ok(());
            }
        }
        write_json(&path, &serde_json::to_value(record).unwrap_or(Value::Null))
    }

    fn clear_pending_discovery_recovery(&self, key: &str, expected_action: Option<&str>) -> Result<bool> {
        let path = self.recovery_path("discovery", key);
        let Some(current) = read_json::<PeerApplicationDiscoveryRecovery>(&path)? else {
            return Ok(true);
        };
        if let Some(expected) = expected_action {
            if current.action != expected {
                return Ok(false);
            }
        }
        fs::remove_file(&path).map_err(|e| store_error(&e.to_string()))?;
        Ok(true)
    }

    fn save_discovery(&self, record: &PeerApplicationDiscoveryRecord) -> Result<()> {
        write_json(
            &self.dir.join("discoveries").join(format!("{}.json", safe_key(&record.key))),
            &serde_json::to_value(record).unwrap_or(Value::Null),
        )
    }

    fn list_pending_handoff_page(
        &self,
        after_key: Option<&str>,
        limit: usize,
    ) -> Result<PeerApplicationPage<PeerApplicationHandoffPlan>> {
        let keys = self.recovery_keys("handoff")?;
        page_of(keys, after_key, limit, |k| {
            read_json(&self.recovery_path("handoff", k))
        })
    }

    fn get_pending_handoff(&self, key: &str) -> Result<Option<PeerApplicationHandoffPlan>> {
        read_json(&self.recovery_path("handoff", key))
    }

    fn save_pending_handoff(&self, plan: &PeerApplicationHandoffPlan) -> Result<()> {
        write_json(
            &self.recovery_path("handoff", &plan.key),
            &serde_json::to_value(plan).unwrap_or(Value::Null),
        )
    }

    fn clear_pending_handoff(&self, key: &str) -> Result<()> {
        let path = self.recovery_path("handoff", key);
        if path.exists() {
            fs::remove_file(&path).map_err(|e| store_error(&e.to_string()))?;
        }
        Ok(())
    }
}
