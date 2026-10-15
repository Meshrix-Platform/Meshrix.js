//! Focused tests for the fresh-profile recovery composition
//! (`recovery/service.rs`) and the service-level import guards.

use std::collections::HashMap;
use std::sync::Mutex;

use meshrix_entry_core::custody::{CustodyPreference, FileCustodyAdapter};
use meshrix_entry_core::recovery::bundle::BundleConnection;
use meshrix_entry_core::recovery::crypto::derive_recovery_material;
use meshrix_entry_core::recovery::key::{format_recovery_text, generate_recovery_key};
use meshrix_entry_core::recovery::service::{
    EntryRecoveryService, FreshRecoveryOutcome, RecoveryAccessOutcome, RecoveryAccessPort,
};
use meshrix_entry_core::recovery::session::RecoveryEndpointPort;
use meshrix_entry_core::recovery::sync::{InMemorySnapshotJournal, SnapshotSynchronizer};
use meshrix_entry_core::recovery::vault::{RecoveryVaultClient, VaultTransport};
use meshrix_entry_core::service::{EntryService, ServiceConfig, FileCustodyOpts};
use meshrix_entry_core::wire::recovery::{
    create_recovery_challenge, create_recovery_result_enrolled, parse_recovery_proof,
    parse_recovery_request,
};
use serde_json::{json, Value};

/* ------------------------------ fixtures ------------------------------ */

struct FakeVault {
    inner: Mutex<HashMap<String, (u64, Value)>>,
}

impl VaultTransport for FakeVault {
    fn post(&self, vault_id: &str, message: &Value) -> meshrix_entry_core::Result<(u16, Value)> {
        let kind = message.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let mut vaults = self.inner.lock().unwrap();
        match kind {
            "vault-fetch" => match vaults.get(vault_id) {
                Some((_rev, snapshot)) => Ok((
                    200,
                    json!({
                        "schemaVersion": "v0.0.1:private-relay:recovery-1",
                        "kind": "vault-snapshot",
                        "vaultId": vault_id,
                        "revision": snapshot.get("revision").cloned().unwrap_or(Value::from(1)),
                        "generation": snapshot.get("generation").cloned().unwrap_or(Value::from(1)),
                        "snapshot": snapshot.get("snapshot").cloned().unwrap_or(Value::Null),
                        "publicVerifier": snapshot.get("publicVerifier").cloned().unwrap_or(Value::Null),
                    }),
                )),
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

/// Endpoint stub: answers the recovery-request with a bound challenge and the
/// recovery-proof with an enrolled result carrying admission generation 7.
struct StubEndpoint;

impl RecoveryEndpointPort for StubEndpoint {
    async fn round_trip(
        &self,
        endpoint_route_id: &str,
        message: &Value,
    ) -> meshrix_entry_core::Result<Option<Value>> {
        let kind = message.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "recovery-request" => {
                let request = parse_recovery_request(message).expect("valid request");
                let now = chrono::Utc::now();
                Ok(Some(create_recovery_challenge(
                    "chal.import.1",
                    endpoint_route_id,
                    "principal.test",
                    1,
                    "nonce.import.0000000001",
                    &request.fresh_device_public_key,
                    &now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    &(now + chrono::Duration::minutes(5))
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                )))
            }
            "recovery-proof" => {
                let proof = parse_recovery_proof(message).expect("valid proof");
                Ok(Some(create_recovery_result_enrolled(
                    &proof.challenge_id,
                    &proof.fresh_device_id,
                    7,
                )))
            }
            _ => Ok(None),
        }
    }
}

fn file_custody(dir: &std::path::Path) -> FileCustodyAdapter {
    FileCustodyAdapter::new(dir.join("custody"), [9u8; 32]).unwrap()
}

/* ------------------------------ tests ------------------------------- */

/// Snapshot published under one device → fresh profile recovers from the text
/// alone: fetch, decrypt, pick the single connection, challenge/proof enroll.
#[tokio::test(flavor = "current_thread")]
async fn recover_fresh_profile_enrolls_from_text_alone() {
    let vault_id = "vault.import.1";
    let key = generate_recovery_key(Some(vault_id.into())).unwrap();
    let material = derive_recovery_material(&key.secret).unwrap();
    let text = format_recovery_text(&key).unwrap();

    let vault = std::sync::Arc::new(FakeVault {
        inner: Mutex::new(HashMap::new()),
    });

    // Seed the vault: publish one snapshot under the derived writer.
    let connection = BundleConnection {
        connection_id: "conn.seed".into(),
        display_label: "seeded".into(),
        route_id: "route.test".into(),
        tenant_id: "tenant.test".into(),
        mode: "personal".into(),
        endpoint_spki_pin: "spki.test".into(),
        principal_ref: "principal.test".into(),
        relay_service: "https://relay.test".into(),
        vault_id: vault_id.into(),
        trust_generation: 1,
        admission_generation: 1,
        revocation_revision: 0,
        recovery_authority: None,
    };
    let bundle = meshrix_entry_core::recovery::bundle::build_entry_recovery_bundle(
        "prof.entry.1",
        "seeded profile",
        vec![connection],
        None,
    )
    .unwrap();
    {
        let vault_ref = vault.clone();
        let mut sync = SnapshotSynchronizer::new(
            RecoveryVaultClient::new(SharedVault(vault_ref)),
            InMemorySnapshotJournal::new(),
        );
        let outcome = sync
            .publish(vault_id, &bundle, &material, 1, None, &[])
            .unwrap();
        assert!(matches!(
            outcome,
            meshrix_entry_core::recovery::sync::PublishOutcome::Committed { .. }
        ));
    }

    // Fresh profile — nothing but the text, fresh custody, a stub endpoint.
    let dir = tempfile::tempdir().unwrap();
    let custody = file_custody(dir.path());
    let endpoint = StubEndpoint;
    let mut sync = SnapshotSynchronizer::new(
        RecoveryVaultClient::new(SharedVault(vault)),
        InMemorySnapshotJournal::new(),
    );
    let mut service = EntryRecoveryService::new(&mut sync, &endpoint);
    let outcome = service
        .recover_fresh_profile(&text, &custody, None, Some("dev.fresh.1".into()))
        .await
        .unwrap();
    let FreshRecoveryOutcome::Enrolled {
        device,
        connection,
        admission_generation,
        generation,
        principal_ref,
        ..
    } = outcome
    else {
        panic!("expected enrolled, got {outcome:?}");
    };
    assert_eq!(device.device_id, "dev.fresh.1");
    assert_eq!(connection.route_id, "route.test");
    assert_eq!(admission_generation, 7);
    assert_eq!(generation, 1);
    assert_eq!(principal_ref, "principal.test");
    // The fresh device key was enrolled into custody.
    assert!(
        meshrix_entry_core::identity::load_device_keypair(&custody, None, "dev.fresh.1")
            .unwrap()
            .is_some()
    );
}

/// A bundle with two connections requires an explicit route selection.
#[tokio::test(flavor = "current_thread")]
async fn recover_fresh_profile_requires_route_selection_for_multiple() {
    let vault_id = "vault.import.multi";
    let key = generate_recovery_key(Some(vault_id.into())).unwrap();
    let material = derive_recovery_material(&key.secret).unwrap();
    let text = format_recovery_text(&key).unwrap();
    let vault = std::sync::Arc::new(FakeVault {
        inner: Mutex::new(HashMap::new()),
    });
    let conn = |route: &str| BundleConnection {
        connection_id: format!("conn.{route}"),
        display_label: route.into(),
        route_id: route.into(),
        tenant_id: "tenant.test".into(),
        mode: "personal".into(),
        endpoint_spki_pin: "spki.test".into(),
        principal_ref: "principal.test".into(),
        relay_service: "https://relay.test".into(),
        vault_id: vault_id.into(),
        trust_generation: 1,
        admission_generation: 1,
        revocation_revision: 0,
        recovery_authority: None,
    };
    let bundle = meshrix_entry_core::recovery::bundle::build_entry_recovery_bundle(
        "prof.entry.1",
        "multi",
        vec![conn("route.a"), conn("route.b")],
        None,
    )
    .unwrap();
    {
        let mut sync = SnapshotSynchronizer::new(
            RecoveryVaultClient::new(SharedVault(vault.clone())),
            InMemorySnapshotJournal::new(),
        );
        sync.publish(vault_id, &bundle, &material, 1, None, &[]).unwrap();
    }
    let dir = tempfile::tempdir().unwrap();
    let custody = file_custody(dir.path());
    let endpoint = StubEndpoint;
    let mut sync = SnapshotSynchronizer::new(
        RecoveryVaultClient::new(SharedVault(vault)),
        InMemorySnapshotJournal::new(),
    );
    let mut service = EntryRecoveryService::new(&mut sync, &endpoint);
    let err = service
        .recover_fresh_profile(&text, &custody, None, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "recovery_state_invalid");
}

/// With no snapshot the outcome is `snapshot_missing`, not an error.
#[tokio::test(flavor = "current_thread")]
async fn recover_fresh_profile_reports_missing_snapshot() {
    let key = generate_recovery_key(Some("vault.import.empty".into())).unwrap();
    let text = format_recovery_text(&key).unwrap();
    let vault = std::sync::Arc::new(FakeVault {
        inner: Mutex::new(HashMap::new()),
    });
    let dir = tempfile::tempdir().unwrap();
    let custody = file_custody(dir.path());
    let endpoint = StubEndpoint;
    let mut sync = SnapshotSynchronizer::new(
        RecoveryVaultClient::new(SharedVault(vault)),
        InMemorySnapshotJournal::new(),
    );
    let mut service = EntryRecoveryService::new(&mut sync, &endpoint);
    let outcome = service
        .recover_fresh_profile(&text, &custody, None, None)
        .await
        .unwrap();
    assert!(matches!(outcome, FreshRecoveryOutcome::SnapshotMissing));
}

/// Service-level guard: without a provisioning seam the import reports the
/// endpoint surface honestly, before any channel or custody mutation.
#[tokio::test(flavor = "current_thread")]
async fn import_recovery_text_requires_access_provisioner() {
    let dir = tempfile::tempdir().unwrap();
    let service = EntryService::open(
        dir.path().to_path_buf(),
        ServiceConfig {
            custody: CustodyPreference::File,
            file_custody: Some(FileCustodyOpts {
                data_dir: dir.path().join("custody"),
                wrap_secret: [5u8; 32],
            }),
            ..ServiceConfig::default()
        },
    )
    .unwrap();
    let key = generate_recovery_key(Some("vault.import.guard".into())).unwrap();
    let text = format_recovery_text(&key).unwrap();
    let err = service
        .import_recovery_text(&text, Some("https://svc.test"), None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "endpoint_unreachable");
}

/// A refused provisioning answer surfaces as `endpoint_refused` before any
/// channel work begins.
#[tokio::test(flavor = "current_thread")]
async fn import_recovery_text_propagates_access_refusal() {
    struct Refused;
    impl RecoveryAccessPort for Refused {
        fn provision(
            &self,
            _vault_id: &str,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = meshrix_entry_core::Result<RecoveryAccessOutcome>> + Send + '_>,
        > {
            Box::pin(async move {
                Ok(RecoveryAccessOutcome::Refused {
                    refusal: "device_limit".into(),
                })
            })
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let service = EntryService::open(
        dir.path().to_path_buf(),
        ServiceConfig {
            custody: CustodyPreference::File,
            file_custody: Some(FileCustodyOpts {
                data_dir: dir.path().join("custody"),
                wrap_secret: [5u8; 32],
            }),
            ..ServiceConfig::default()
        },
    )
    .unwrap();
    let key = generate_recovery_key(Some("vault.import.refused".into())).unwrap();
    let text = format_recovery_text(&key).unwrap();
    let err = service
        .import_recovery_text(&text, Some("https://svc.test"), Some(&Refused))
        .await
        .unwrap_err();
    assert_eq!(err.code, "endpoint_refused");
}

/// Shared vault handle so two synchronizers can address the same CAS store.
struct SharedVault(std::sync::Arc<FakeVault>);

impl VaultTransport for SharedVault {
    fn post(&self, vault_id: &str, message: &Value) -> meshrix_entry_core::Result<(u16, Value)> {
        self.0.post(vault_id, message)
    }
}
