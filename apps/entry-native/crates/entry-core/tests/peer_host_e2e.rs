//! Host-level end-to-end: two `PeerHost` threads, two stub `EntrySession`s
//! cross-wired through an in-memory endpoint authority — bundle directory,
//! forwarding and presence — exercising the exact production paths
//! `attach → admit → publish bundle → send → decrypt → delivery ACK →
//! delivered` and `application submit → remote agent run → result` without
//! a network.

use futures_util::future::LocalBoxFuture;
use meshrix_entry_core::peer::application::AcpAgentSummary;
use meshrix_entry_core::peer::application::PeerApplicationAddress;
use meshrix_entry_core::peer::application_engine::{
    PeerApplicationAgentDirectory, PeerApplicationAgentExecutor, PeerApplicationExecution,
    PeerApplicationExecutionHandlers, PeerApplicationExecutionResult,
};
use meshrix_entry_core::peer::client::PeerClientEvent;
use meshrix_entry_core::peer::host::{PeerAttachRequest, PeerHost, PeerHostOptions};
use meshrix_entry_core::peer::wire as peer_wire;
use meshrix_entry_core::peer::{
    create_peer_identity, peer_id_for_route_device, FilePeerCryptoStore, PairedSignalIdentity,
    PeerApplicationRouteAuthority, PeerHostEvent, PeerRouteIdentity,
};
use meshrix_entry_core::relay::entry::PeerLaneStub;
use meshrix_entry_core::relay::EntrySession;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

const TENANT: &str = "tenant.e2e";
const ROUTE: &str = "route.e2e";
const DEV_A: &str = "dev.entry.a";
const DEV_B: &str = "dev.endpoint.b";

struct NoSecrets;
#[async_trait::async_trait]
impl a4aa::SecretResolver for NoSecrets {
    async fn resolve(&self, _reference: &str) -> Option<String> {
        None
    }
}

fn spawn_host(
    root: &std::path::Path,
    agents_override: Option<Box<dyn Fn() -> Rc<dyn PeerApplicationAgentDirectory> + Send>>,
) -> Arc<PeerHost> {
    PeerHost::spawn(PeerHostOptions {
        agent_root: root.join("personal-agent"),
        secret_resolver: Arc::new(NoSecrets),
        authority_resolver: Arc::new(|_| PeerApplicationRouteAuthority::Current),
        connection_sessions: Arc::new(|_| true),
        agents_override,
    })
    .expect("peer host spawns")
}

/// The endpoint's peer-authority duties the wire contract assigns: the
/// bundle directory (`publish`/`fetch`), forwarding receipts for
/// `peer-send`/`peer-delivery-ack`, and reachability presence notices.
struct EndpointAuthority {
    bundles: Mutex<HashMap<String, Value>>,
    route_id: String,
    tenant_id: String,
    lanes: HashMap<String, PeerLaneStub>,
}

impl EndpointAuthority {
    fn wire(&self, kind: &str, extras: serde_json::Map<String, Value>) -> Value {
        let mut map = serde_json::Map::new();
        map.insert(
            "schemaVersion".into(),
            Value::from(peer_wire::PRIVATE_RELAY_PEER_SCHEMA_VERSION),
        );
        map.insert(
            "wireProtocol".into(),
            Value::from(peer_wire::PRIVATE_RELAY_PEER_WIRE),
        );
        map.insert("kind".into(), Value::from(kind));
        map.extend(extras);
        Value::Object(map)
    }

    /// What the relay emits once both forward sessions are admitted.
    fn presence_notice(&self, device: &str, peer: &str) -> Value {
        self.wire(
            "peer-presence",
            json!({
                "tenantId": self.tenant_id,
                "routeId": self.route_id,
                "deviceId": device,
                "peerDeviceId": peer,
                "state": "reachable",
                "sessionId": "sess.endpoint.1",
            })
            .as_object()
            .unwrap()
            .clone(),
        )
    }

    /// `peer-presence` notices a live endpoint pushes to each device.
    fn announce_reachability(&self, a: &str, b: &str) {
        self.lanes[a].inject(self.presence_notice(a, b));
        self.lanes[b].inject(self.presence_notice(b, a));
    }

    fn handle(&self, _from: &str, message: Value) {
        let kind = message
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        match kind.as_str() {
            "peer-bundle-publish" => {
                let publish = peer_wire::parse_peer_bundle_publish(&message).unwrap();
                self.bundles.lock().unwrap().insert(
                    publish.device_id.clone(),
                    serde_json::to_value(&publish.bundle).unwrap(),
                );
                let reply = self.wire(
                    "peer-bundle-published",
                    json!({
                        "routeId": publish.route_id,
                        "deviceId": publish.device_id,
                        "bundleId": publish.bundle.bundle_id,
                        "outcome": "published",
                        "currentRevision": publish.bundle.revision,
                        "refusal": Value::Null,
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                );
                self.lanes[_from].inject(reply);
            }
            "peer-bundle-fetch" => {
                let fetch = peer_wire::parse_peer_bundle_fetch(&message).unwrap();
                let stored = self
                    .bundles
                    .lock()
                    .unwrap()
                    .get(&fetch.peer_device_id)
                    .cloned();
                let (state, bundle) = match stored {
                    Some(bundle) => ("available", bundle),
                    None => ("unpublished", Value::Null),
                };
                let reply = self.wire(
                    "peer-bundle",
                    json!({
                        "routeId": fetch.route_id,
                        "deviceId": fetch.peer_device_id,
                        "state": state,
                        "bundle": bundle,
                        "refusal": Value::Null,
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                );
                self.lanes[_from].inject(reply);
            }
            "peer-send" | "peer-delivery-ack" => {
                // Wire fields describe the ORIGINAL send direction: a send is
                // delivered to `recipientDeviceId`; a delivery ACK travels the
                // other way — to the original sender awaiting its receipt.
                let (target, message_id) = if kind == "peer-send" {
                    let s = peer_wire::parse_peer_send(&message).unwrap();
                    (s.recipient_device_id, s.message_id)
                } else {
                    let a = peer_wire::parse_peer_delivery_ack(&message).unwrap();
                    (a.sender_device_id, a.message_id)
                };
                if let Some(lane) = self.lanes.get(&target) {
                    lane.inject(message);
                }
                let receipt = self.wire(
                    "peer-forwarded",
                    json!({
                        "tenantId": self.tenant_id,
                        "routeId": self.route_id,
                        "requestKind": kind.as_str(),
                        "sourceDeviceId": _from,
                        "targetDeviceId": target,
                        "messageId": message_id,
                        "outcome": "forwarded",
                        "refusal": Value::Null,
                    })
                    .as_object()
                    .unwrap()
                    .clone(),
                );
                self.lanes[_from].inject(receipt);
            }
            _ => {}
        }
    }
}

struct Pair {
    host_a: Arc<PeerHost>,
    host_b: Arc<PeerHost>,
    stub_b: PeerLaneStub,
    authority: Arc<EndpointAuthority>,
    _dir_a: tempfile::TempDir,
    _dir_b: tempfile::TempDir,
}

/// Provision route-bound Signal identities, stub sessions, an endpoint
/// authority and both hosts; admit + attach exactly like a live `connect`.
async fn wire_pair(
    agents_override: Option<Box<dyn Fn() -> Rc<dyn PeerApplicationAgentDirectory> + Send>>,
) -> Pair {
    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();

    let crypto_a = FilePeerCryptoStore::new(dir_a.path().join("peer/conn.a/crypto"));
    let crypto_b = FilePeerCryptoStore::new(dir_b.path().join("peer/conn.b/crypto"));
    let id_a = create_peer_identity(
        &crypto_a,
        Some(&peer_id_for_route_device(TENANT, ROUTE, DEV_A).unwrap()),
    )
    .unwrap()
    .paired_signal_identity();
    let id_b = create_peer_identity(
        &crypto_b,
        Some(&peer_id_for_route_device(TENANT, ROUTE, DEV_B).unwrap()),
    )
    .unwrap()
    .paired_signal_identity();

    let host_a = spawn_host(dir_a.path(), None);
    let host_b = spawn_host(dir_b.path(), agents_override);
    let (session_a, wire_a, stub_a) = EntrySession::stub_for_tests();
    let (session_b, wire_b, stub_b) = EntrySession::stub_for_tests();

    let authority = Arc::new(EndpointAuthority {
        bundles: Mutex::new(HashMap::new()),
        route_id: ROUTE.to_string(),
        tenant_id: TENANT.to_string(),
        lanes: HashMap::from([
            (DEV_A.to_string(), stub_a.clone()),
            (DEV_B.to_string(), stub_b.clone()),
        ]),
    });
    for (wire, device) in [(wire_a, DEV_A), (wire_b, DEV_B)] {
        let authority = authority.clone();
        tokio::spawn(async move {
            let mut wire = wire;
            while let Some(m) = wire.recv().await {
                authority.handle(device, m);
            }
        });
    }

    let attach = |session: Arc<EntrySession>,
                  conn: &str,
                  store: &std::path::Path,
                  local: &str,
                  remote: &str,
                  remote_id: PairedSignalIdentity| {
        PeerAttachRequest {
            connection_id: conn.to_string(),
            store_dir: store.to_path_buf(),
            route: PeerRouteIdentity {
                tenant_id: TENANT.into(),
                route_id: ROUTE.into(),
                device_id: local.into(),
            },
            endpoint_device_id: remote.into(),
            endpoint_peer_identity: Some(remote_id),
            allows_peer: Arc::new(|| true),
            peer_authority: Arc::new(|| PeerApplicationRouteAuthority::Current),
            session,
        }
    };

    // `EntrySession::connect` resolves only after admission — attach always
    // sees an admitted session in production.
    stub_a.admit();
    stub_b.admit();
    host_a
        .attach_connection(attach(
            Arc::new(session_a),
            "conn.a",
            &dir_a.path().join("peer/conn.a"),
            DEV_A,
            DEV_B,
            id_b.clone(),
        ))
        .await
        .unwrap();
    host_b
        .attach_connection(attach(
            Arc::new(session_b),
            "conn.b",
            &dir_b.path().join("peer/conn.b"),
            DEV_B,
            DEV_A,
            id_a.clone(),
        ))
        .await
        .unwrap();

    Pair {
        host_a,
        host_b,
        stub_b,
        authority,
        _dir_a: dir_a,
        _dir_b: dir_b,
    }
}

/// Wait for one `PeerClientEvent` matching `expected` on a host feed.
async fn await_client_event(
    events: &mut tokio::sync::broadcast::Receiver<PeerHostEvent>,
    expected: &str,
    timeout: std::time::Duration,
) -> PeerClientEvent {
    tokio::time::timeout(timeout, async {
        loop {
            match events.recv().await {
                Ok(PeerHostEvent::PeerClient { event, .. }) => {
                    if let PeerClientEvent::Error { code, detail } = &event {
                        panic!("peer runtime error {code}: {detail}");
                    }
                    let matches = match (&event, expected) {
                        (PeerClientEvent::BundlePublished { .. }, "bundle_published") => true,
                        (PeerClientEvent::SendState { state, .. }, s) if s == "delivered" => {
                            state == "delivered"
                        }
                        (PeerClientEvent::Inbound(_), "inbound") => true,
                        _ => false,
                    };
                    if matches {
                        return event;
                    }
                }
                Ok(_) => continue,
                Err(_) => panic!("event feed closed waiting for {expected}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {expected}"))
}

#[test]
fn host_peer_send_roundtrips_through_real_runtime() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let pair = wire_pair(None).await;
        let mut events_a = pair.host_a.subscribe();
        let mut events_b = pair.host_b.subscribe();

        // Production ordering: a bundle must be in the endpoint's directory
        // before the counterpart first contacts — wait for B's publish.
        await_client_event(
            &mut events_b,
            "bundle_published",
            std::time::Duration::from_secs(10),
        )
        .await;

        // Send through the host facade → runtime gate → client → session.
        let entry = pair
            .host_a
            .peer_send("conn.a", DEV_B, b"hello endpoint".to_vec(), None)
            .await
            .unwrap();
        assert_eq!(entry.identity.sender_device_id, DEV_A);

        // B decrypts → Inbound event; its signed ACK → A's send state settles.
        match await_client_event(&mut events_b, "inbound", std::time::Duration::from_secs(10)).await
        {
            PeerClientEvent::Inbound(msg) => {
                assert_eq!(msg.plaintext, b"hello endpoint");
                assert_eq!(msg.sender_device_id, DEV_A);
            }
            _ => unreachable!(),
        }
        await_client_event(
            &mut events_a,
            "delivered",
            std::time::Duration::from_secs(10),
        )
        .await;

        pair.stub_b.close("test-done");
        pair.host_a.shutdown().await;
        pair.host_b.shutdown().await;
    });
}

/* --------------------- application-level end to end ---------------------- */

/// Engine-side test double: one always-available `agent.echo` that answers
/// the prompt text back. The whole submit → envelope → Signal → receive →
/// dispatch → execute → result → ACK path stays real.
struct EchoAgents;
struct EchoExecutor;

impl PeerApplicationAgentDirectory for EchoAgents {
    fn list(&self) -> LocalBoxFuture<'_, meshrix_entry_core::error::Result<Vec<AcpAgentSummary>>> {
        Box::pin(async { Ok(vec![EchoExecutor.summary()]) })
    }
    fn get(&self, agent_id: &str) -> Option<Rc<dyn PeerApplicationAgentExecutor>> {
        (agent_id == "agent.echo")
            .then(|| Rc::new(EchoExecutor) as Rc<dyn PeerApplicationAgentExecutor>)
    }
}

impl PeerApplicationAgentExecutor for EchoExecutor {
    fn summary(&self) -> AcpAgentSummary {
        AcpAgentSummary {
            id: "agent.echo".into(),
            display_name: "Echo".into(),
            description: Some("test double".into()),
            enabled: true,
            detected: None,
            transport: Some("acp".into()),
        }
    }
    fn start(
        &self,
        _operation_id: &str,
        prompt: &str,
        _model: Option<String>,
        _effort: Option<String>,
        handlers: PeerApplicationExecutionHandlers,
    ) -> PeerApplicationExecution {
        let (tx, rx) = oneshot::channel();
        let text = format!("echo:{prompt}");
        tokio::task::spawn_local(async move {
            if (handlers.before_prompt)().await.is_err() {
                let _ = tx.send(Err(meshrix_entry_core::error::entry_error(
                    "peer_application_failed",
                    "before_prompt rejected",
                )));
                return;
            }
            let _ = tx.send(Ok(PeerApplicationExecutionResult {
                stop_reason: "end_turn".into(),
                text,
            }));
        });
        PeerApplicationExecution {
            cancel: Rc::new(|| Box::pin(async {})),
            result: rx,
        }
    }
}

#[test]
fn host_application_submit_runs_remote_agent() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let pair = wire_pair(Some(Box::new(|| Rc::new(EchoAgents)))).await;
        let mut events_a = pair.host_a.subscribe();
        let mut events_b = pair.host_b.subscribe();

        // Bundles published + mutual reachability announced before the first
        // application message, exactly like a settled live pair.
        await_client_event(
            &mut events_a,
            "bundle_published",
            std::time::Duration::from_secs(10),
        )
        .await;
        await_client_event(
            &mut events_b,
            "bundle_published",
            std::time::Duration::from_secs(10),
        )
        .await;
        pair.authority.announce_reachability(DEV_A, DEV_B);
        // Presence lands as a client event — wait until both sides observed it.
        for events in [&mut events_a, &mut events_b] {
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                loop {
                    match events.recv().await {
                        Ok(PeerHostEvent::PeerClient {
                            event: PeerClientEvent::PeerPresence(presence),
                            ..
                        }) if presence.state == "reachable" => break,
                        Ok(_) => continue,
                        Err(_) => panic!("event feed closed waiting for presence"),
                    }
                }
            })
            .await
            .expect("presence timed out");
        }

        let record = pair
            .host_a
            .application_submit(
                PeerApplicationAddress {
                    tenant_id: TENANT.into(),
                    route_id: ROUTE.into(),
                    local_device_id: DEV_A.into(),
                    peer_device_id: DEV_B.into(),
                },
                None,
                None,
                "agent.echo".into(),
                "ping".into(),
                Some("gpt-6.1-sol".into()),
                Some("low".into()),
            )
            .await
            .unwrap();
        assert_eq!(record.model.as_deref(), Some("gpt-6.1-sol"));
        assert_eq!(record.effort.as_deref(), Some("low"));
        let operation_id = record.operation_id.clone();
        assert!(matches!(
            record.status.as_str(),
            "delivery_pending" | "accepted" | "running"
        ));

        // The caller's journal must settle `completed` with the echoed text.
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                match events_a.recv().await {
                    Ok(PeerHostEvent::ApplicationOperation(op))
                        if op.operation_id == operation_id =>
                    {
                        match op.status.as_str() {
                            "completed" => {
                                assert_eq!(op.result_text.as_deref(), Some("echo:ping"));
                                return;
                            }
                            "failed" | "refused" | "stopped" | "cancelled" => {
                                panic!("operation {operation_id} terminated as {}", op.status)
                            }
                            _ => continue,
                        }
                    }
                    Ok(PeerHostEvent::PeerClient {
                        event: PeerClientEvent::Error { code, detail },
                        ..
                    }) => panic!("peer runtime error {code}: {detail}"),
                    Ok(_) => continue,
                    Err(_) => panic!("event feed closed waiting for completion"),
                }
            }
        })
        .await
        .expect("operation completion timed out");

        // B's journal keeps the receiver-side record of the same operation.
        let operations_b = pair.host_b.list_operations().await.unwrap();
        assert!(operations_b
            .iter()
            .any(|op| op.operation_id == operation_id && op.role == "receiver"));

        pair.stub_b.close("test-done");
        pair.host_a.shutdown().await;
        pair.host_b.shutdown().await;
    });
}
