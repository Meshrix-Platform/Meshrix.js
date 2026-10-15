//! Automatic encrypted snapshot publication and retrieval — port of
//! `entry/src/recovery/snapshot-sync.ts`.
//!
//! The writer holds a derived backup key (kept in OS custody for routine
//! updates — the recovery root never participates in day-to-day writes) and
//! publishes revisioned `EncryptedRecoverySnapshot` envelopes through the
//! vault CAS path. On conflict it fetches the committed snapshot, decrypts
//! the concurrent configuration and merges before retrying once — an
//! idempotent retry reuses the exact same ciphertext; a genuinely divergent
//! write is reconciled, never blindly overwritten.
//!
//! Freshness is enforced locally: a durable high-water mark (highest seen
//! generation, then revision) rejects stale snapshots so a backup rollback
//! can never reduce revocation state or resurrect retired trust references.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::canonical::canonical_json;
use crate::error::{entry_error, Result};
use crate::store::{JournalCommit, JournalSeen, PendingSnapshotWrite, StoredSnapshotJournal};
use crate::wire::recovery::{
    parse_encrypted_recovery_snapshot, PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
};

use super::bundle::{merge_recovery_bundles, parse_entry_recovery_bundle, EntryRecoveryBundle};
use super::crypto::{open_recovery_snapshot, seal_recovery_snapshot, RecoveryMaterial};
use super::vault::{RecoveryVaultClient, VaultFetchOutcome, VaultSigningMaterial, VaultTransport, VaultWriteOutcome};

pub const ENTRY_SNAPSHOT_FORMAT_VERSION: u64 = 1;

/// `SnapshotJournalPort` — durable journal surface. Production binds it to
/// the owned config file (`ConfigSnapshotJournal` in `service.rs`); tests
/// may use an in-memory implementation.
pub trait SnapshotJournalPort {
    fn load(&mut self) -> Option<StoredSnapshotJournal>;
    fn save(&mut self, journal: &StoredSnapshotJournal) -> Result<()>;
}

/// In-memory journal for tests — mirrors `InMemorySnapshotJournal`.
pub struct InMemorySnapshotJournal {
    journal: Option<StoredSnapshotJournal>,
}

impl InMemorySnapshotJournal {
    pub fn new() -> Self {
        Self { journal: None }
    }
}

impl Default for InMemorySnapshotJournal {
    fn default() -> Self {
        Self::new()
    }
}

impl SnapshotJournalPort for InMemorySnapshotJournal {
    fn load(&mut self) -> Option<StoredSnapshotJournal> {
        self.journal.clone()
    }
    fn save(&mut self, journal: &StoredSnapshotJournal) -> Result<()> {
        self.journal = Some(journal.clone());
        Ok(())
    }
}

#[derive(Debug)]
pub enum PublishOutcome {
    Committed { revision: u64, digest: String },
    ConflictUnresolved { current_revision: u64 },
    ConflictUndecryptable { current_revision: u64 },
    Superseded { generation: u64 },
    Refused { retryable: bool },
    InvalidResponse,
}

#[derive(Debug)]
pub enum SyncFetchOutcome {
    Snapshot {
        bundle: EntryRecoveryBundle,
        revision: u64,
        generation: u64,
        public_verifier: crate::wire::recovery::PublicVerifier,
    },
    Stale { revision: u64, generation: u64 },
    Refused { refusal: String, retryable: bool },
    DecryptFailed,
    AuthorityMismatch,
    InvalidResponse,
}

/// `snapshotEnvelope` — seal `canonicalJson(bundle)` into the vault's
/// protected record shape.
fn snapshot_envelope(
    bundle: &EntryRecoveryBundle,
    backup_key: &[u8; 32],
    vault_id: &str,
    generation: u64,
    revision: u64,
    public_verifier: &crate::wire::recovery::PublicVerifier,
) -> Result<Value> {
    let aead = seal_recovery_snapshot(
        canonical_json(&bundle.to_json()).as_bytes(),
        backup_key,
        vault_id,
        ENTRY_SNAPSHOT_FORMAT_VERSION,
        generation,
        revision,
        None,
    )?;
    Ok(json!({
        "schemaVersion": PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
        "kind": "encrypted-recovery-snapshot",
        "vaultId": vault_id,
        "formatVersion": ENTRY_SNAPSHOT_FORMAT_VERSION,
        "generation": generation,
        "revision": revision,
        "snapshot": {
            "algorithm": aead.algorithm,
            "nonce": aead.nonce,
            "ciphertext": aead.ciphertext,
            "byteLength": aead.byte_length,
        },
        "publicVerifier": {
            "keyId": public_verifier.key_id,
            "algorithm": public_verifier.algorithm,
            "publicKey": public_verifier.public_key,
        },
    }))
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub struct SnapshotSynchronizer<T: VaultTransport, J: SnapshotJournalPort> {
    vault: RecoveryVaultClient<T>,
    journal: J,
}

impl<T: VaultTransport, J: SnapshotJournalPort> SnapshotSynchronizer<T, J> {
    pub fn new(vault: RecoveryVaultClient<T>, journal: J) -> Self {
        Self { vault, journal }
    }

    fn load_journal(&mut self) -> StoredSnapshotJournal {
        self.journal.load().unwrap_or(StoredSnapshotJournal {
            pending_write: None,
            last_committed: None,
            highest_seen: None,
            last_success_at: None,
            last_error: None,
        })
    }

    fn save_journal(&mut self, patch: impl FnOnce(&mut StoredSnapshotJournal)) -> Result<()> {
        let mut journal = self.load_journal();
        patch(&mut journal);
        self.journal.save(&journal)
    }

    /// Current committed revision (0 when nothing committed yet).
    pub fn committed_revision(&mut self) -> u64 {
        self.load_journal()
            .last_committed
            .map(|c| c.revision)
            .unwrap_or(0)
    }

    /// `publish` — single idempotent writer path: conflict → fetch → decrypt
    /// the concurrent configuration → merge → one reconcile write.
    pub fn publish(
        &mut self,
        vault_id: &str,
        bundle: &EntryRecoveryBundle,
        material: &RecoveryMaterial,
        generation: u64,
        base_snapshot: Option<(&EntryRecoveryBundle, u64, u64)>,
        decrypt_with: &[RecoveryMaterial],
    ) -> Result<PublishOutcome> {
        let journal = self.load_journal();
        let generation = generation
            .max(base_snapshot.map(|(_, _, g)| g).unwrap_or(0))
            .max(journal.highest_seen.map(|h| h.generation).unwrap_or(0))
            .max(1);
        let pending = journal.pending_write.as_ref().filter(|p| {
            p.vault_id == vault_id
                && p.writer_key_id == material.writer.key_id
                && p.generation == generation
        });
        let expected = pending
            .map(|p| p.expected_revision)
            .or_else(|| base_snapshot.map(|(_, r, _)| r))
            .or_else(|| journal.last_committed.as_ref().map(|c| c.revision))
            .unwrap_or(0);
        let bundle = match base_snapshot {
            Some((base, _, _)) => merge_recovery_bundles(bundle, base)?,
            None => bundle.clone(),
        };

        let digest_of = |snapshot: &Value| -> String {
            if parse_encrypted_recovery_snapshot(snapshot).is_some() {
                crate::transcripts::vault_snapshot_digest(snapshot)
            } else {
                format!("sha256:{}", sha256_hex(&canonical_json(snapshot)))
            }
        };

        // Input digest pins the configuration this attempt was built from —
        // `createdAt` is excluded because a merged snapshot stamps a fresh one.
        let mut input_bundle_json = bundle.to_json();
        if let Some(o) = input_bundle_json.as_object_mut() {
            o.remove("createdAt");
        }
        let input_digest = sha256_hex(&canonical_json(&input_bundle_json));
        let snapshot = match pending {
            Some(p) => p.snapshot.clone(),
            None => snapshot_envelope(
                &bundle,
                &material.backup_key,
                vault_id,
                generation,
                expected + 1,
                &crate::wire::recovery::PublicVerifier {
                    key_id: material.signing.key_id.clone(),
                    algorithm: "Ed25519".into(),
                    public_key: material.signing.public_key.clone(),
                },
            )?,
        };
        let pending_write = PendingSnapshotWrite {
            vault_id: vault_id.into(),
            writer_key_id: material.writer.key_id.clone(),
            generation,
            expected_revision: expected,
            input_digest: input_digest.clone(),
            snapshot: snapshot.clone(),
        };
        let retained = pending.map(|_| pending_write.clone());
        self.save_journal(|j| {
            j.pending_write = Some(retained.clone().unwrap_or(pending_write.clone()));
        })?;

        let writer = VaultSigningMaterial {
            key_id: &material.writer.key_id,
            keypair: &material.writer.keypair,
        };
        let attempt = self.vault.write_snapshot(vault_id, expected, &snapshot, &writer)?;

        match attempt {
            VaultWriteOutcome::Committed { committed_revision } => {
                let digest = digest_of(&snapshot);
                self.save_journal(|j| {
                    j.pending_write = None;
                    j.last_committed = Some(JournalCommit {
                        revision: committed_revision,
                        generation,
                        digest: digest.clone(),
                    });
                    j.highest_seen = Some(JournalSeen {
                        revision: committed_revision,
                        generation,
                    });
                    j.last_success_at = Some(now_iso());
                    j.last_error = None;
                })?;
                // Finish a retained operation first; a changed configuration
                // then gets its own revision.
                if let Some(retained) = retained {
                    if retained.input_digest != input_digest {
                        let envelope = parse_encrypted_recovery_snapshot(&snapshot)
                            .ok_or_else(|| entry_error("vault_unexpected_response", "The retained snapshot no longer parses."))?;
                        let plaintext = open_recovery_snapshot(
                            envelope.get("snapshot").ok_or_else(|| {
                                entry_error("vault_unexpected_response", "The retained snapshot envelope is incomplete.")
                            })?,
                            &material.backup_key,
                            vault_id,
                            envelope.get("formatVersion").and_then(|v| v.as_u64()).unwrap_or(ENTRY_SNAPSHOT_FORMAT_VERSION),
                            envelope.get("generation").and_then(|v| v.as_u64()).unwrap_or(generation),
                            envelope.get("revision").and_then(|v| v.as_u64()).unwrap_or(committed_revision),
                        )?;
                        let retained_bundle = parse_entry_recovery_bundle(
                            &serde_json::from_slice::<Value>(&plaintext)
                                .map_err(|_| entry_error("snapshot_malformed", "The retained snapshot plaintext is not JSON."))?,
                        )
                        .ok_or_else(|| entry_error("snapshot_malformed", "The retained snapshot plaintext is not a bundle."))?;
                        let merged = merge_recovery_bundles(&bundle, &retained_bundle)?;
                        return self.publish(vault_id, &merged, material, generation, None, decrypt_with);
                    }
                }
                Ok(PublishOutcome::Committed {
                    revision: committed_revision,
                    digest,
                })
            }
            VaultWriteOutcome::Refused { retryable: true } => {
                self.save_journal(|j| j.last_error = Some("vault_write_capacity".into()))?;
                Ok(PublishOutcome::Refused { retryable: true })
            }
            VaultWriteOutcome::Refused { retryable: false } => {
                // Probe once — a refused write may mean this writer's
                // generation was superseded.
                let probe = self.fetch_snapshot(
                    vault_id,
                    material,
                    None,
                    decrypt_with,
                    false,
                )?;
                if let SyncFetchOutcome::Snapshot { generation: g, .. } = probe {
                    if g > generation {
                        return Ok(PublishOutcome::Superseded { generation: g });
                    }
                }
                self.save_journal(|j| j.last_error = Some("vault_write_refused".into()))?;
                Ok(PublishOutcome::Refused { retryable: false })
            }
            VaultWriteOutcome::InvalidResponse => {
                self.save_journal(|j| j.last_error = Some("vault_write_invalid_response".into()))?;
                Ok(PublishOutcome::InvalidResponse)
            }
            VaultWriteOutcome::Conflict { current_revision } => {
                // CAS conflict: reconcile once.
                let remote = self.fetch_snapshot(vault_id, material, None, decrypt_with, false)?;
                // CAS conflict: fetch the committed head, then reconcile once.
                let (remote_bundle, remote_generation) = match remote {
                    SyncFetchOutcome::Refused { refusal, .. } => {
                        self.save_journal(|j| {
                            j.last_error = Some(format!("vault_fetch_refused:{refusal}"));
                        })?;
                        return Ok(PublishOutcome::ConflictUnresolved { current_revision });
                    }
                    SyncFetchOutcome::Snapshot {
                        bundle: remote_bundle,
                        generation: remote_generation,
                        ..
                    } => (Some(remote_bundle), remote_generation),
                    SyncFetchOutcome::Stale {
                        generation: remote_generation,
                        ..
                    } => (None, remote_generation),
                    _ => {
                        return Ok(PublishOutcome::ConflictUndecryptable { current_revision });
                    }
                };
                if remote_generation > generation {
                    return Ok(PublishOutcome::Superseded {
                        generation: remote_generation,
                    });
                }
                let merged = match remote_bundle {
                    Some(remote_bundle) => merge_recovery_bundles(&bundle, &remote_bundle)?,
                    None => bundle,
                };
                let reconciled = snapshot_envelope(
                    &merged,
                    &material.backup_key,
                    vault_id,
                    generation,
                    current_revision + 1,
                    &crate::wire::recovery::PublicVerifier {
                        key_id: material.signing.key_id.clone(),
                        algorithm: "Ed25519".into(),
                        public_key: material.signing.public_key.clone(),
                    },
                )?;
                self.save_journal(|j| {
                    j.pending_write = Some(PendingSnapshotWrite {
                        vault_id: vault_id.into(),
                        writer_key_id: material.writer.key_id.clone(),
                        generation,
                        expected_revision: current_revision,
                        input_digest: input_digest.clone(),
                        snapshot: reconciled.clone(),
                    });
                })?;
                let retry = self.vault.write_snapshot(
                    vault_id,
                    current_revision,
                    &reconciled,
                    &writer,
                )?;
                match retry {
                    VaultWriteOutcome::Committed { committed_revision } => {
                        let digest = digest_of(&reconciled);
                        self.save_journal(|j| {
                            j.pending_write = None;
                            j.last_committed = Some(JournalCommit {
                                revision: committed_revision,
                                generation,
                                digest: digest.clone(),
                            });
                            j.highest_seen = Some(JournalSeen {
                                revision: committed_revision,
                                generation,
                            });
                            j.last_success_at = Some(now_iso());
                            j.last_error = None;
                        })?;
                        Ok(PublishOutcome::Committed {
                            revision: committed_revision,
                            digest,
                        })
                    }
                    VaultWriteOutcome::Conflict {
                        current_revision: retry_revision,
                    } => {
                        self.save_journal(|j| {
                            j.last_error = Some("vault_write_conflict".into());
                        })?;
                        Ok(PublishOutcome::ConflictUnresolved {
                            current_revision: retry_revision,
                        })
                    }
                    VaultWriteOutcome::Refused { retryable } => {
                        self.save_journal(|j| {
                            j.last_error = Some(if retryable {
                                "vault_write_capacity".into()
                            } else {
                                "vault_write_refused".into()
                            });
                        })?;
                        Ok(PublishOutcome::Refused { retryable })
                    }
                    VaultWriteOutcome::InvalidResponse => {
                        self.save_journal(|j| {
                            j.last_error = Some("vault_write_invalid_response".into());
                        })?;
                        Ok(PublishOutcome::InvalidResponse)
                    }
                }
            }
        }
    }

    /// `fetchSnapshot` — fetch and locally decrypt the committed snapshot.
    /// The returned bundle is configuration only.
    pub fn fetch_snapshot(
        &mut self,
        vault_id: &str,
        material: &RecoveryMaterial,
        fetch_key: Option<&crate::recovery::crypto::DerivedRecoveryKey>,
        decrypt_with: &[RecoveryMaterial],
        check_verifier: bool,
    ) -> Result<SyncFetchOutcome> {
        let signing = fetch_key.unwrap_or(&material.signing);
        let fetched = self.vault.fetch_snapshot(
            vault_id,
            &VaultSigningMaterial {
                key_id: &signing.key_id,
                keypair: &signing.keypair,
            },
        )?;
        match fetched {
            VaultFetchOutcome::Refused { refusal, retryable } => {
                return Ok(SyncFetchOutcome::Refused { refusal, retryable });
            }
            VaultFetchOutcome::InvalidResponse => return Ok(SyncFetchOutcome::InvalidResponse),
            VaultFetchOutcome::Snapshot(view) => {
                let mut last = SyncFetchOutcome::InvalidResponse;
                let mut tried = std::collections::HashSet::new();
                for candidate in std::iter::once(material).chain(decrypt_with.iter()) {
                    if !tried.insert(candidate.signing.key_id.clone()) {
                        continue;
                    }
                    last = self.decrypt_view(vault_id, candidate, &view, check_verifier)?;
                    if !matches!(
                        last,
                        SyncFetchOutcome::AuthorityMismatch | SyncFetchOutcome::DecryptFailed
                    ) {
                        return Ok(last);
                    }
                }
                Ok(last)
            }
        }
    }

    fn decrypt_view(
        &mut self,
        vault_id: &str,
        material: &RecoveryMaterial,
        view: &crate::wire::recovery::VaultSnapshot,
        check_verifier: bool,
    ) -> Result<SyncFetchOutcome> {
        if check_verifier {
            let verifier = &view.public_verifier;
            if verifier.algorithm != "Ed25519"
                || verifier.key_id != material.signing.key_id
                || verifier.public_key != material.signing.public_key
            {
                return Ok(SyncFetchOutcome::AuthorityMismatch);
            }
        }
        let high = self.load_journal().highest_seen;
        if let Some(high) = high {
            if view.generation < high.generation
                || (view.generation == high.generation && view.revision < high.revision)
            {
                return Ok(SyncFetchOutcome::Stale {
                    revision: view.revision,
                    generation: view.generation,
                });
            }
        }
        let envelope = serde_json::to_value(&view.snapshot).map_err(|e| {
            entry_error("snapshot_malformed", "The snapshot envelope could not be re-serialized.").caused_by(e)
        })?;
        let plaintext = match open_recovery_snapshot(
            &envelope,
            &material.backup_key,
            &view.vault_id,
            ENTRY_SNAPSHOT_FORMAT_VERSION,
            view.generation,
            view.revision,
        ) {
            Ok(p) => p,
            Err(e) => {
                if e.code == "snapshot_decrypt_failed" {
                    return Ok(SyncFetchOutcome::DecryptFailed);
                }
                return Ok(SyncFetchOutcome::InvalidResponse);
            }
        };
        let bundle = serde_json::from_slice::<Value>(&plaintext)
            .ok()
            .and_then(|v| parse_entry_recovery_bundle(&v))
            .ok_or(SyncFetchOutcome::InvalidResponse);
        let bundle = match bundle {
            Ok(b) => b,
            Err(outcome) => return Ok(outcome),
        };
        self.save_journal(|j| {
            j.highest_seen = Some(JournalSeen {
                revision: view.revision,
                generation: view.generation,
            });
        })?;
        let _ = vault_id;
        Ok(SyncFetchOutcome::Snapshot {
            bundle,
            revision: view.revision,
            generation: view.generation,
            public_verifier: view.public_verifier.clone(),
        })
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
