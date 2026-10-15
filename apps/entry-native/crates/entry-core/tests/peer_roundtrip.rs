//! Focused peer-foundation tests: identity persistence, bundle generation
//! and strict parsing, envelope round-trips, trust pinning, and a full
//! PQXDH encrypt/decrypt cycle between two on-disk stores.

use std::cell::RefCell;
use std::rc::Rc;

use meshrix_entry_core::peer::{
    create_peer_identity, generate_peer_prekey_bundle, load_peer_identity, pin_peer_identity,
    FilePeerCryptoStore, PeerCryptoStore, PeerEnvelope, PeerPreKeyBundle, PeerSession,
};
use tokio::task::LocalSet;

#[test]
fn identity_persists_and_loads() {
    let dir = tempfile::tempdir().unwrap();
    let store = FilePeerCryptoStore::new(dir.path().join("crypto"));
    let identity = create_peer_identity(&store, Some("peer:test-device")).unwrap();
    assert_eq!(identity.peer_id, "peer:test-device");
    assert_eq!(identity.device_id, 1);
    assert!(identity.registration_id >= 1 && identity.registration_id <= 0x3fff);

    // Prekey pool was committed before the identity record.
    assert_eq!(store.list_pre_keys().unwrap().len(), 8);
    assert_eq!(store.list_kyber_pre_keys().unwrap().len(), 8);
    assert_eq!(store.list_signed_pre_keys().unwrap().len(), 1);

    let loaded = load_peer_identity(&store).unwrap().unwrap();
    assert_eq!(loaded.peer_id, identity.peer_id);
    assert_eq!(
        loaded.identity_key_pair().public_key().serialize(),
        identity.identity_key_pair().public_key().serialize()
    );

    // A second create on a live store refuses — load, don't overwrite.
    assert!(create_peer_identity(&store, Some("peer:other")).is_err());
}

#[test]
fn bundle_generation_and_strict_parse() {
    let dir = tempfile::tempdir().unwrap();
    let store = FilePeerCryptoStore::new(dir.path().join("crypto"));
    let identity = create_peer_identity(&store, Some("peer:bob")).unwrap();

    let bundle = generate_peer_prekey_bundle(&identity, &store).unwrap();
    let json = bundle.to_json();
    let parsed = PeerPreKeyBundle::from_json(&json).unwrap();
    assert_eq!(parsed.peer_id, "peer:bob");
    assert_eq!(parsed.device_id, 1);
    assert!(parsed.pre_key_id.is_some());
    assert!(parsed.kyber_pre_key_id >= 1);

    // The advertised prekeys were claimed, not left available.
    use meshrix_entry_core::peer::store::PeerPrekeyState;
    let one_time = store.load_pre_key(parsed.pre_key_id.unwrap()).unwrap().unwrap();
    assert_eq!(one_time.state, PeerPrekeyState::Published);

    // Exact-key strictness: extra keys are rejected outright.
    let mut bad = json.clone();
    bad["extra"] = serde_json::Value::from(1);
    assert!(PeerPreKeyBundle::from_json(&bad).is_err());
    bad = json.clone();
    bad.as_object_mut().unwrap().remove("kyberPreKey");
    assert!(PeerPreKeyBundle::from_json(&bad).is_err());
}

#[test]
fn envelope_exact_keys_and_bounds() {
    let env = PeerEnvelope {
        sender_peer_id: "peer:a".into(),
        sender_device_id: 1,
        message_type: meshrix_entry_core::peer::PeerEnvelopeMessageType::Signal,
        body: vec![1, 2, 3],
    };
    let bytes = env.serialize().unwrap();
    let parsed = PeerEnvelope::parse_bytes(&bytes).unwrap();
    assert_eq!(parsed.sender_peer_id, "peer:a");
    assert_eq!(parsed.body, vec![1, 2, 3]);

    let mut v = env.to_json();
    v["surprise"] = serde_json::Value::from(true);
    assert!(PeerEnvelope::from_json(&v).is_err());
    let mut v2 = env.to_json();
    v2.as_object_mut().unwrap().remove("body");
    assert!(PeerEnvelope::from_json(&v2).is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn pqxdh_roundtrip() {
    LocalSet::new()
        .run_until(async {
            let dir_a = tempfile::tempdir().unwrap();
            let dir_b = tempfile::tempdir().unwrap();
            let store_a: Rc<RefCell<dyn PeerCryptoStore>> =
                Rc::new(RefCell::new(FilePeerCryptoStore::new(dir_a.path().join("crypto"))));
            let store_b: Rc<RefCell<dyn PeerCryptoStore>> =
                Rc::new(RefCell::new(FilePeerCryptoStore::new(dir_b.path().join("crypto"))));

            let alice = create_peer_identity(&*store_a.borrow(), Some("peer:alice")).unwrap();
            let bob = create_peer_identity(&*store_b.borrow(), Some("peer:bob")).unwrap();

            // Pairing pins each other's identity key — no wire-trusted keys.
            let bob_desc = bob.paired_signal_identity();
            let alice_desc = alice.paired_signal_identity();
            pin_peer_identity(
                &*store_a.borrow(),
                &bob_desc.peer_id,
                bob_desc.signal_device_id,
                &meshrix_entry_core::b64::b64u_decode(&bob_desc.identity_key, 128).unwrap(),
            )
            .unwrap();
            pin_peer_identity(
                &*store_b.borrow(),
                &alice_desc.peer_id,
                alice_desc.signal_device_id,
                &meshrix_entry_core::b64::b64u_decode(&alice_desc.identity_key, 128).unwrap(),
            )
            .unwrap();

            // Bob publishes a bundle; Alice initiates over it.
            let bundle = generate_peer_prekey_bundle(&bob, &*store_b.borrow()).unwrap();
            let mut alice_session =
                PeerSession::initiate(alice, store_a.clone(), &bundle).await.unwrap();
            let envelope = alice_session.encrypt(b"hello bob").await.unwrap();
            assert_eq!(envelope.sender_peer_id, "peer:alice");

            // Bob accepts the prekey envelope — session established.
            let wire = envelope.serialize().unwrap();
            let inbound = PeerEnvelope::parse_bytes(&wire).unwrap();
            let (mut bob_session, plaintext) =
                PeerSession::accept(bob, store_b.clone(), &inbound).await.unwrap();
            assert_eq!(plaintext, b"hello bob");

            // Bob replies over the established session.
            let reply = bob_session.encrypt(b"hello alice").await.unwrap();
            let (mut alice_back, plain2) =
                PeerSession::accept(load_peer_identity(&*store_a.borrow()).unwrap().unwrap(), store_a.clone(), &reply)
                    .await
                    .unwrap();
            assert_eq!(plain2, b"hello alice");

            // Resume keeps working after reload.
            let _ = alice_back.encrypt(b"again").await.unwrap();
            assert_eq!(alice_back.remote_peer_id(), "peer:bob");
        })
        .await;
}

#[test]
fn peer_id_derivation_matches_contract() {
    use meshrix_entry_core::peer::peer_id_for_route_device;
    assert_eq!(
        peer_id_for_route_device("tenant.acme", "route.1", "dev.x").as_deref(),
        Some("peer:tenant.acme:route.1:dev.x")
    );
    // `:` inside components becomes `~` so separators stay unambiguous.
    assert_eq!(
        peer_id_for_route_device("t:1", "r:2", "d:3").as_deref(),
        Some("peer:t~1:r~2:d~3")
    );
    assert_eq!(peer_id_for_route_device("x", "route.1", "dev.x"), None); // min 2 chars
}
