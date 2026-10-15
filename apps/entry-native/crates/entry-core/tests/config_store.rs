//! `EntryConfigStore` multi-writer semantics — the GUI, CLI and endpoint
//! runtime share `entry-gui.config.json`. External writes must surface via
//! `reload_if_changed`, and `update` must merge them instead of clobbering
//! with a stale in-memory snapshot.

use meshrix_entry_core::store::EntryConfigStore;

fn write_external(dir: &std::path::Path, connections: serde_json::Value) {
    let doc = serde_json::json!({
        "schemaVersion": "entry-gui-config-1",
        "profile": { "displayLabel": "Meshrix Entry" },
        "connections": connections,
        "recovery": null,
        "accountVaultWriterOperation": null,
        "journal": null,
        "rotations": [],
        "mcp": { "managedConfigPath": null },
        "pairingServiceDefault": null,
        "pairingCompletionCheckpointRef": null,
        "account": null
    });
    std::fs::write(
        dir.join("entry-gui.config.json"),
        serde_json::to_string_pretty(&doc).unwrap(),
    )
    .unwrap();
}

fn connection(id: &str) -> serde_json::Value {
    serde_json::json!({
        "connectionId": id,
        "displayLabel": id,
        "tenantId": "personal:t",
        "routeId": "route.x",
        "mode": "personal",
        "endpointPrincipalRef": "personal.x",
        "endpointDeviceId": "dev.personal.y",
        "endpointPeerIdentity": null,
        "endpointSpkiPin": "pin",
        "relayService": "wss://relay.example.com",
        "vaultId": null,
        "deviceId": "dev.entry.x",
        "deviceFingerprint": "fp",
        "capabilityGrantRef": "none",
        "accountActionTarget": null,
        "relayCredentialRef": "ref.x",
        "boundRecoveryKeyId": null,
        "pairingService": null,
        "admissionGeneration": 1,
        "revocationRevision": 0,
        "enrolledAt": "2026-01-01T00:00:00Z",
        "remoteRevocation": "none",
        "routeRevocation": null,
        "accountBinding": null,
        "rePairRequired": false,
        "pairingCompletionCheckpointRef": null
    })
}

#[test]
fn reload_if_changed_picks_up_external_writes() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = EntryConfigStore::new(dir.path());
    store.load().unwrap();
    assert!(!store.reload_if_changed().unwrap());

    write_external(dir.path(), serde_json::json!([connection("conn.a")]));

    assert!(store.reload_if_changed().unwrap());
    assert_eq!(store.config().connections.len(), 1);
    assert_eq!(store.config().connections[0].connection_id, "conn.a");
    assert!(!store.reload_if_changed().unwrap());
}

#[test]
fn update_merges_external_writes_instead_of_clobbering() {
    let dir = tempfile::tempdir().unwrap();
    let mut stale = EntryConfigStore::new(dir.path());
    stale.load().unwrap(); // snapshot before the external pairing lands

    write_external(dir.path(), serde_json::json!([connection("conn.b")]));

    stale
        .update(|c| c.profile.display_label = "renamed".into())
        .unwrap();

    let mut fresh = EntryConfigStore::new(dir.path());
    fresh.load().unwrap();
    assert_eq!(fresh.config().profile.display_label, "renamed");
    assert_eq!(fresh.config().connections.len(), 1);
    assert_eq!(fresh.config().connections[0].connection_id, "conn.b");
}

#[test]
fn duplicate_principal_records_collapse_to_last() {
    let dir = tempfile::tempdir().unwrap();
    let mut old = connection("conn.old");
    old["enrolledAt"] = serde_json::json!("2026-01-01T00:00:00Z");
    let mut new = connection("conn.new");
    new["enrolledAt"] = serde_json::json!("2026-02-01T00:00:00Z");
    new["relayCredentialRef"] = serde_json::json!("ref.new");
    write_external(dir.path(), serde_json::json!([old, new]));

    let mut store = EntryConfigStore::new(dir.path());
    store.load().unwrap();
    assert_eq!(store.config().connections.len(), 1);
    assert_eq!(store.config().connections[0].connection_id, "conn.new");
    assert_eq!(store.config().connections[0].relay_credential_ref, "ref.new");
}
