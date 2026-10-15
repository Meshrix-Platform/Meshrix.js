//! End-to-end PeerClient round-trip on one current-thread runtime:
//! bundle publish → PQXDH send → durable inbox → signed delivery ACK →
//! outbox delivered. Mirrors the TS client over an in-memory relay.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use futures_util::future::LocalBoxFuture;
use serde_json::{json, Value};
use tempfile::TempDir;

use meshrix_entry_core::peer::client::{
    new_peer_message_id, PeerClient, PeerClientEvent, PeerClientOptions, PeerClientTransport,
    PeerDeviceDirectory, PeerInboundMessage, PeerInboundOutcome, PeerRouteIdentity,
};
use meshrix_entry_core::peer::client_store::create_file_peer_client_store;
use meshrix_entry_core::peer::identity::{create_peer_identity, PairedSignalIdentity};
use meshrix_entry_core::peer::store::{FilePeerCryptoStore, PeerCryptoStore};
use meshrix_entry_core::peer::wire;
use meshrix_entry_core::wire::recovery::peer_id_for_route_device;

const TENANT: &str = "t.tenant";
const ROUTE: &str = "r.route";

/// In-memory relay: stores bundles, answers fetches/publishes, forwards
/// sends/acks between attached devices, and emits `peer-forwarded` receipts.
struct Relay {
    bundles: RefCell<HashMap<String, wire::PrekeyBundlePublication>>,
    handlers: RefCell<HashMap<String, Rc<dyn Fn(Value)>>>,
}

impl Relay {
    fn new() -> Rc<Self> {
        Rc::new(Self {
            bundles: RefCell::new(HashMap::new()),
            handlers: RefCell::new(HashMap::new()),
        })
    }

    fn attach(&self, device_id: &str, handler: Rc<dyn Fn(Value)>) {
        self.handlers.borrow_mut().insert(device_id.to_string(), handler);
    }

    fn deliver(&self, device_id: &str, message: Value) {
        if let Some(handler) = self.handlers.borrow().get(device_id) {
            handler(message);
        }
    }

    fn envelope(kind: &str, extras: Value) -> Value {
        let mut map = extras.as_object().unwrap().clone();
        map.insert("schemaVersion".into(), json!(wire::PRIVATE_RELAY_PEER_SCHEMA_VERSION));
        map.insert("wireProtocol".into(), json!("meshrix-private-relay/0"));
        map.insert("kind".into(), json!(kind));
        Value::Object(map)
    }

    fn on_send(&self, from_device: &str, message: Value) {
        match message.get("kind").and_then(Value::as_str) {
            Some("peer-bundle-publish") => {
                let publish = wire::parse_peer_bundle_publish(&message).unwrap();
                self.bundles
                    .borrow_mut()
                    .insert(publish.device_id.clone(), publish.bundle.clone());
                self.deliver(
                    from_device,
                    Self::envelope(
                        "peer-bundle-published",
                        json!({
                            "routeId": publish.route_id,
                            "deviceId": publish.device_id,
                            "bundleId": publish.bundle.bundle_id,
                            "outcome": "published",
                            "currentRevision": publish.bundle.revision,
                            "refusal": null
                        }),
                    ),
                );
            }
            Some("peer-bundle-fetch") => {
                let fetch = wire::parse_peer_bundle_fetch(&message).unwrap();
                let bundle = self.bundles.borrow().get(&fetch.peer_device_id).cloned();
                let response = match bundle {
                    Some(b) => Self::envelope(
                        "peer-bundle",
                        json!({
                            "routeId": fetch.route_id,
                            "deviceId": fetch.peer_device_id,
                            "state": "available",
                            "bundle": {
                                "format": b.format,
                                "bundleId": b.bundle_id,
                                "revision": b.revision,
                                "material": b.material
                            },
                            "refusal": null
                        }),
                    ),
                    None => Self::envelope(
                        "peer-bundle",
                        json!({
                            "routeId": fetch.route_id,
                            "deviceId": fetch.peer_device_id,
                            "state": "unpublished",
                            "bundle": null,
                            "refusal": null
                        }),
                    ),
                };
                self.deliver(from_device, response);
            }
            Some("peer-send") => {
                let send = wire::parse_peer_send(&message).unwrap();
                let target = send.recipient_device_id.clone();
                let reachable = self.handlers.borrow().contains_key(&target);
                if reachable {
                    self.deliver(&target, message.clone());
                }
                self.deliver(
                    from_device,
                    Self::envelope(
                        "peer-forwarded",
                        json!({
                            "tenantId": send.tenant_id,
                            "routeId": send.route_id,
                            "requestKind": "peer-send",
                            "sourceDeviceId": send.sender_device_id,
                            "targetDeviceId": target,
                            "messageId": send.message_id,
                            "outcome": if reachable { "forwarded" } else { "endpoint_unreachable" },
                            "refusal": null
                        }),
                    ),
                );
            }
            Some("peer-delivery-ack") => {
                let ack = wire::parse_peer_delivery_ack(&message).unwrap();
                let target = ack.sender_device_id.clone();
                self.deliver(&target, message);
            }
            _ => {}
        }
    }
}

struct RelayTransport {
    relay: Rc<Relay>,
    device_id: String,
}

impl PeerClientTransport for RelayTransport {
    fn send<'a>(
        &'a self,
        message: Value,
    ) -> LocalBoxFuture<'a, meshrix_entry_core::error::Result<()>> {
        Box::pin(async move {
            self.relay.on_send(&self.device_id, message);
            Ok(())
        })
    }
}

struct StaticDirectory {
    devices: HashMap<String, PairedSignalIdentity>,
}

impl PeerDeviceDirectory for StaticDirectory {
    fn resolve_peer_identity(
        &self,
        peer_device_id: &str,
    ) -> LocalBoxFuture<'static, Option<PairedSignalIdentity>> {
        let found = self.devices.get(peer_device_id).cloned();
        Box::pin(async move { found })
    }
}

#[test]
fn peer_client_send_receive_ack() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = tokio::task::LocalSet::new();
    rt.block_on(async {
        local
            .run_until(async {
                let relay = Relay::new();
                let device_a = "d.alice";
                let device_b = "d.bob";

                let dir_a = TempDir::new().unwrap();
                let crypto_a: Rc<RefCell<dyn PeerCryptoStore>> = Rc::new(RefCell::new(
                    FilePeerCryptoStore::new(dir_a.path().join("crypto")),
                ));
                let identity_a = create_peer_identity(
                    &*crypto_a.borrow(),
                    peer_id_for_route_device(TENANT, ROUTE, device_a).as_deref(),
                )
                .unwrap();
                let dir_b = TempDir::new().unwrap();
                let crypto_b: Rc<RefCell<dyn PeerCryptoStore>> = Rc::new(RefCell::new(
                    FilePeerCryptoStore::new(dir_b.path().join("crypto")),
                ));
                let identity_b = create_peer_identity(
                    &*crypto_b.borrow(),
                    peer_id_for_route_device(TENANT, ROUTE, device_b).as_deref(),
                )
                .unwrap();

                let descriptors: HashMap<String, PairedSignalIdentity> = [
                    (device_a.to_string(), identity_a.paired_signal_identity()),
                    (device_b.to_string(), identity_b.paired_signal_identity()),
                ]
                .into_iter()
                .collect();

                let (tx_a, rx_a) = tokio::sync::mpsc::unbounded_channel();
                let rx_a = Rc::new(RefCell::new(rx_a));
                let (tx_b, rx_b) = tokio::sync::mpsc::unbounded_channel();
                let rx_b = Rc::new(RefCell::new(rx_b));

                let client_a = PeerClient::new(PeerClientOptions {
                    identity: identity_a,
                    crypto_store: crypto_a,
                    client_store: Rc::new(
                        create_file_peer_client_store(dir_a.path().join("client")).unwrap(),
                    ),
                    transport: Rc::new(RelayTransport {
                        relay: relay.clone(),
                        device_id: device_a.to_string(),
                    }),
                    route: PeerRouteIdentity {
                        tenant_id: TENANT.to_string(),
                        route_id: ROUTE.to_string(),
                        device_id: device_a.to_string(),
                    },
                    directory: Some(Rc::new(StaticDirectory {
                        devices: descriptors.clone(),
                    })),
                    dispatch: None,
                    wire_profile: None,
                    page_size: None,
                    events: tx_a,
                })
                .unwrap();
                let client_b = PeerClient::new(PeerClientOptions {
                    identity: identity_b,
                    crypto_store: crypto_b,
                    client_store: Rc::new(
                        create_file_peer_client_store(dir_b.path().join("client")).unwrap(),
                    ),
                    transport: Rc::new(RelayTransport {
                        relay: relay.clone(),
                        device_id: device_b.to_string(),
                    }),
                    route: PeerRouteIdentity {
                        tenant_id: TENANT.to_string(),
                        route_id: ROUTE.to_string(),
                        device_id: device_b.to_string(),
                    },
                    directory: Some(Rc::new(StaticDirectory { devices: descriptors })),
                    dispatch: None,
                    wire_profile: None,
                    page_size: None,
                    events: tx_b,
                })
                .unwrap();

                let ca = client_a.clone();
                relay.attach(device_a, Rc::new(move |m| ca.handle_inbound_message(&m)));
                let cb = client_b.clone();
                relay.attach(device_b, Rc::new(move |m| cb.handle_inbound_message(&m)));

                let received: Rc<RefCell<Vec<PeerInboundMessage>>> = Rc::new(RefCell::new(Vec::new()));
                let received_clone = received.clone();
                client_b.on_inbound_message(Rc::new(move |msg| {
                    let received = received_clone.clone();
                    Box::pin(async move {
                        received.borrow_mut().push(msg);
                        PeerInboundOutcome::AcceptedByAgent
                    }) as LocalBoxFuture<'static, PeerInboundOutcome>
                }));

                client_b.publish_bundle().await.unwrap();
                let entry = client_a
                    .send_message(device_b, b"hello peer", Some(new_peer_message_id()))
                    .await
                    .unwrap();
                assert_eq!(entry.state, "pending");

                let a_state = Rc::new(RefCell::new(String::new()));
                let a_log = Rc::new(RefCell::new(Vec::<String>::new()));
                let b_log = Rc::new(RefCell::new(Vec::<String>::new()));
                let mut ok = false;
                for _ in 0..10_000 {
                    while let Ok(ev) = rx_a.borrow_mut().try_recv() {
                        if let PeerClientEvent::SendState { state, .. } = &ev {
                            *a_state.borrow_mut() = state.clone();
                        }
                        a_log.borrow_mut().push(format!("{ev:?}"));
                    }
                    while let Ok(ev) = rx_b.borrow_mut().try_recv() {
                        b_log.borrow_mut().push(format!("{ev:?}"));
                    }
                    if *a_state.borrow() == "delivered" && !received.borrow().is_empty() {
                        ok = true;
                        break;
                    }
                    tokio::task::yield_now().await;
                    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                }
                assert!(
                    ok,
                    "condition not reached\nA events: {:#?}\nB events: {:#?}\nreceived: {}",
                    a_log.borrow().as_slice(),
                    b_log.borrow().as_slice(),
                    received.borrow().len()
                );

                let msgs = received.borrow();
                assert_eq!(msgs[0].plaintext, b"hello peer");
                assert_eq!(msgs[0].sender_device_id, device_a);
                drop(msgs);

                client_a.dispose().await;
                client_b.dispose().await;
            })
            .await;
    });
}
