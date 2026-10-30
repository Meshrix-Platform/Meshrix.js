//! Focused coverage for the recovery lifecycle port: material serde,
//! snapshot synchronizer CAS semantics, rotation manager transitions and
//! the service-level recovery/vault-writer orchestration.

use std::collections::HashMap;
use serde_json::{json, Value};

use meshrix_entry_core::recovery::crypto::{
    deserialize_recovery_material, derive_recovery_material, serialize_recovery_material,
};
use meshrix_entry_core::recovery::key::{format_recovery_text, generate_recovery_key};
use meshrix_entry_core::recovery::rotation::{InMemoryRotationStore, RecoveryRotationManager};
use meshrix_entry_core::recovery::sync::{
    InMemorySnapshotJournal, PublishOutcome, SnapshotSynchronizer, SyncFetchOutcome,
};
use meshrix_entry_core::recovery::vault::{RecoveryVaultClient, VaultTransport};
use meshrix_entry_core::service::{EntryService, FileCustodyOpts, ServiceConfig};
use meshrix_entry_core::store::StoredVaultWriterOperation;
use meshrix_entry_core::custody::CustodyPreference;

/* ------------------------- fake vault transport --------------------- */

/// In-memory CAS vault: one snapshot per vaultId, strictly revisioned.
struct FakeVault {
    inner: std::sync::Mutex<HashMap<String, (u64, Value)>>,
}

impl FakeVault {
    fn new() -> Self {
        Self { inner: std::sync::Mutex::new(HashMap::new()) }
    }
}

impl VaultTransport for FakeVault {
    fn post(&self, vault_id: &str, message: &Value) -> meshrix_entry_core::Result<(u16, Value)> {
        let kind = message.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let mut vaults = self.inner.lock().unwrap();
        match kind {
            "vault-fetch" => match vaults.get(vault_id) {
                Some((_rev, snapshot)) => {
                    let env = snapshot.get("snapshot").cloned().unwrap_or(Value::Null);
                    Ok((
                        200,
                        json!({
                            "schemaVersion": "v0.0.1:private-relay:recovery-1",
                            "kind": "vault-snapshot",
                            "vaultId": vault_id,
                            "revision": snapshot.get("revision").cloned().unwrap_or(Value::from(1)),
                            "generation": snapshot.get("generation").cloned().unwrap_or(Value::from(1)),
                            "snapshot": env,
                            "publicVerifier": snapshot.get("publicVerifier").cloned().unwrap_or(Value::Null),
                        }),
                    ))
                }
                None => Ok((
                    200,
                    json!({
                        "schemaVersion": "v0.0.1:private-relay:recovery-1",
                        "kind": "vault-fetch-refused",
                        "vaultId": vault_id,
                        "refusal": "not_found",
                        "retryable": false,
                    }),
                )),
            },
            "vault-write" => {
                let expected = message
                    .get("expectedRevision")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let snapshot = message.get("snapshot").cloned().unwrap_or(Value::Null);
                let current = vaults.get(vault_id).map(|(r, _)| *r).unwrap_or(0);
                if expected != current {
                    return Ok((
                        200,
                        json!({
                            "schemaVersion": "v0.0.1:private-relay:recovery-1",
                            "kind": "vault-write-result",
                            "vaultId": vault_id,
                            "outcome": "conflict",
                            "currentRevision": current,
                            "committedRevision": current,
                        }),
                    ));
                }
                let revision = snapshot
                    .get("revision")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(expected + 1);
                vaults.insert(vault_id.to_string(), (revision, snapshot));
                Ok((
                    200,
                    json!({
                        "schemaVersion": "v0.0.1:private-relay:recovery-1",
                        "kind": "vault-write-result",
                        "vaultId": vault_id,
                        "outcome": "committed",
                        "currentRevision": revision,
                        "committedRevision": revision,
                    }),
                ))
            }
            _ => Ok((200, json!({}))),
        }
    }
}

fn make_bundle(label: &str) -> meshrix_entry_core::recovery::bundle::EntryRecoveryBundle {
    meshrix_entry_core::recovery::bundle::build_entry_recovery_bundle(
        "prof.entry-gui.1",
        label,
        vec![],
        None,
    )
    .unwrap()
}

/* ------------------------------ tests ------------------------------- */

#[test]
fn recovery_material_roundtrip_preserves_derived_keys() {
    let vault_id = format!("vault.test-{}", std::process::id());
        let key = generate_recovery_key(Some(vault_id)).unwrap();
    let material = derive_recovery_material(&key.secret).unwrap();
    let blob = serialize_recovery_material(&material);
    let restored = deserialize_recovery_material(&blob).unwrap();
    assert_eq!(restored.signing.key_id, material.signing.key_id);
    assert_eq!(restored.signing.public_key, material.signing.public_key);
    assert_eq!(restored.writer.key_id, material.writer.key_id);
    assert_eq!(restored.writer.public_key, material.writer.public_key);
    assert_eq!(restored.backup_key, material.backup_key);
}

#[test]
fn recovery_material_rejects_tampered_key_id() {
    let vault_id = format!("vault.test-{}", std::process::id());
        let key = generate_recovery_key(Some(vault_id)).unwrap();
    let material = derive_recovery_material(&key.secret).unwrap();
    let blob = serialize_recovery_material(&material);
    let mut parsed: Value = serde_json::from_slice(&blob).unwrap();
    parsed["signingKeyId"] = json!("rckey.forged");
    let tampered = serde_json::to_vec(&parsed).unwrap();
    assert!(deserialize_recovery_material(&tampered).is_err());
}

#[test]
fn synchronizer_publishes_then_fetches_its_own_snapshot() {
    let vault_id = format!("vault.test-{}", std::process::id());
    let key = generate_recovery_key(Some(vault_id.clone())).unwrap();
    let material = derive_recovery_material(&key.secret).unwrap();
    let mut sync = SnapshotSynchronizer::new(
        RecoveryVaultClient::new(FakeVault::new()),
        InMemorySnapshotJournal::new(),
    );
    let bundle = make_bundle("alpha");
    let outcome = sync
        .publish(&vault_id, &bundle, &material, 1, None, &[])
        .unwrap();
    assert!(matches!(outcome, PublishOutcome::Committed { revision: 1, .. }));

    let fetched = sync
        .fetch_snapshot(&vault_id, &material, None, &[], true)
        .unwrap();
    match fetched {
        SyncFetchOutcome::Snapshot { bundle, revision, generation, .. } => {
            assert_eq!(revision, 1);
            assert_eq!(generation, 1);
            assert_eq!(bundle.display_label, "alpha");
        }
        other => panic!("expected snapshot, got {other:?}"),
    }
}

#[test]
fn synchronizer_conflict_reconciles_one_write() {
    let vault_id = format!("vault.test-{}", std::process::id());
    let key = generate_recovery_key(Some(vault_id.clone())).unwrap();
    let material = derive_recovery_material(&key.secret).unwrap();
    let vault = std::sync::Arc::new(FakeVault::new());
    let mut sync_a = SnapshotSynchronizer::new(
        RecoveryVaultClient::new(FakeVaultHandle(vault.clone())),
        InMemorySnapshotJournal::new(),
    );
    let mut sync_b = SnapshotSynchronizer::new(
        RecoveryVaultClient::new(FakeVaultHandle(vault)),
        InMemorySnapshotJournal::new(),
    );
    // A commits revision 1.
    assert!(matches!(
        sync_a.publish(&vault_id, &make_bundle("a1"), &material, 1, None, &[]).unwrap(),
        PublishOutcome::Committed { revision: 1, .. }
    ));
    // B's journal still believes 0 — its write conflicts, fetches, merges, retries.
    let outcome = sync_b
        .publish(&vault_id, &make_bundle("b1"), &material, 1, None, &[])
        .unwrap();
    assert!(matches!(outcome, PublishOutcome::Committed { revision: 2, .. }));
}

struct FakeVaultHandle(std::sync::Arc<FakeVault>);
impl VaultTransport for FakeVaultHandle {
    fn post(&self, vault_id: &str, message: &Value) -> meshrix_entry_core::Result<(u16, Value)> {
        self.0.post(vault_id, message)
    }
}

#[test]
fn rotation_manager_stages_marks_and_completes() {
    let vault_id = format!("vault.test-{}", std::process::id());
    let key = generate_recovery_key(Some(vault_id.clone())).unwrap();
    let incumbent = derive_recovery_material(&key.secret).unwrap();
    let mut manager = RecoveryRotationManager::new(InMemoryRotationStore::new());
    let staged = manager
        .begin(&incumbent, 1, "prin.test", &vault_id, &["route.a".into(), "route.b".into()], None)
        .unwrap();
    assert_eq!(staged.rotation.state, "staged");
    assert_eq!(staged.rotation.candidate_generation, 2);
    assert_eq!(staged.rotation.outbound.len(), 2);

    let id = staged.rotation.rotation_id.clone();
    manager.mark_published(&id).unwrap();
    let r = manager.mark_endpoint(&id, "route.a", "acknowledged").unwrap();
    assert_eq!(r.state, "acknowledging");
    let r = manager.mark_endpoint(&id, "route.b", "acknowledged").unwrap();
    assert_eq!(r.state, "completed");
    assert!(manager.pending_outbound(&id).unwrap().is_empty());
}

#[test]
fn rotation_manager_aborts_nonterminal() {
    let vault_id = format!("vault.test-{}", std::process::id());
    let key = generate_recovery_key(Some(vault_id.clone())).unwrap();
    let incumbent = derive_recovery_material(&key.secret).unwrap();
    let mut manager = RecoveryRotationManager::new(InMemoryRotationStore::new());
    let staged = manager
        .begin(&incumbent, 1, "prin.test", &vault_id, &["route.a".into()], None)
        .unwrap();
    let aborted = manager.abort(&staged.rotation.rotation_id).unwrap();
    assert_eq!(aborted.state, "aborted");
    // A second begin must not collide with the aborted record.
    assert!(manager
        .begin(&incumbent, 1, "prin.test", &vault_id, &["route.a".into()], None)
        .is_ok());
}

/* --------------------------- service level -------------------------- */

fn open_service() -> (tempfile::TempDir, EntryService) {
    let dir = tempfile::tempdir().unwrap();
    let service = EntryService::open(
        dir.path().to_path_buf(),
        ServiceConfig {
            custody: CustodyPreference::File,
            file_custody: Some(FileCustodyOpts {
                data_dir: dir.path().join("custody"),
                wrap_secret: [7u8; 32],
            }),
            ..ServiceConfig::default()
        },
    )
    .unwrap();
    (dir, service)
}

#[tokio::test(flavor = "current_thread")]
async fn recovery_setup_reveal_once_and_confirm_unmanaged() {
    let (_dir, service) = open_service();
    let staged = service.begin_recovery_setup().unwrap();
    assert_eq!(staged["generation"], json!(1));
    let vault_id = staged["vaultId"].as_str().unwrap().to_string();
    assert!(vault_id.starts_with("vault.entry."));

    // One-shot reveal.
    let revealed = service.reveal_recovery_key().unwrap();
    let text = revealed["recoveryText"].as_str().unwrap().to_string();
    assert!(text.starts_with("mrk1"));
    let second = service.reveal_recovery_key();
    assert!(second.is_err());

    // Unmanaged confirm persists recovery and fences publish (no vault yet).
    let confirm = service.confirm_recovery_saved().await;
    assert!(confirm.is_err(), "publish with no vault must fail honestly");
    let view = service.recovery_view();
    assert_eq!(view["state"], json!("ready"));
    assert_eq!(view["vaultId"], json!(vault_id));
    assert_eq!(view["writerRegistration"]["state"], json!("unmanaged"));

    // Material is in custody; the text was never persisted.
    let store = service.store.lock().unwrap();
    let recovery = store.config().recovery.clone().unwrap();
    drop(store);
    let blob = service.custody().load_secret(&recovery.material_ref).unwrap();
    assert!(blob.is_some());
}

#[tokio::test(flavor = "current_thread")]
async fn vault_writer_operation_restores_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let flow_ref = "entry.account.vault-writer.testflow".to_string();
    {
        let service = open_service_at(dir.path());
        let flow = json!({
            "account": { "accountId": "acct.1", "authEpoch": 3 },
            "prepareRequest": { "operationId": "vault-writer-op1" },
            "target": null,
            "expiresAt": null,
            "browserTransaction": null,
            "completeRequest": null,
        });
        service.custody().store_secret(&flow_ref, flow.to_string().as_bytes()).unwrap();
        service.store.lock().unwrap().update(|c| {
            c.account_vault_writer_operation = Some(StoredVaultWriterOperation {
                operation_id: "vault-writer-op1".into(),
                connection_id: "conn.1".into(),
                vault_id: "vault.test".into(),
                candidate_key_id: "rckey.candidate".into(),
                generation: 2,
                material_ref: "entry.recovery.vault.test.rckey.candidate".into(),
                flow_ref: flow_ref.clone(),
                state: "prepare_pending".into(),
            });
        }).unwrap();
    }
    // Reopen — the operation and its custody-held flow must be restored.
    let service = open_service_at(dir.path());
    let view = service.recovery_view();
    assert_eq!(view["writerRegistration"]["state"], json!("prepare_pending"));
    assert_eq!(view["writerRegistration"]["candidateKeyId"], json!("rckey.candidate"));
}

fn open_service_at(path: &std::path::Path) -> EntryService {
    EntryService::open(
        path.to_path_buf(),
        ServiceConfig {
            custody: CustodyPreference::File,
            file_custody: Some(FileCustodyOpts {
                data_dir: path.join("custody"),
                wrap_secret: [7u8; 32],
            }),
            ..ServiceConfig::default()
        },
    )
    .unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn begin_rotation_requires_existing_recovery() {
    let (_dir, service) = open_service();
    let err = service.begin_recovery_rotation().await.unwrap_err();
    assert_eq!(err.code, "recovery_state_invalid");
}

#[test]
fn format_recovery_text_renders_grouped_secret() {
    let vault_id = format!("vault.test-{}", std::process::id());
        let key = generate_recovery_key(Some(vault_id)).unwrap();
    let text = format_recovery_text(&key).unwrap();
    assert!(text.starts_with("mrk1"));
}
