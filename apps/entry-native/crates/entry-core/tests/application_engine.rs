//! Focused coverage for the application engine: deterministic identities,
//! fragment reassembly, caller→receiver execution, discovery, permission,
//! cancellation, and durable recovery — all over an in-memory peer port.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;
use std::time::Duration;

use futures_util::future::LocalBoxFuture;
use meshrix_entry_core::peer::application::*;
use meshrix_entry_core::peer::application_engine::*;
use meshrix_entry_core::peer::application_journal::FilePeerApplicationJournal;
use meshrix_entry_core::peer::client::{PeerInboundMessage, PeerInboundOutcome};
use meshrix_entry_core::peer::client_store::StoredOutboxEntry;
use meshrix_entry_core::peer::wire::{PeerEnvelopeHeaders, PeerMessageIdentity, PeerWireEnvelope};
use meshrix_entry_core::error::entry_error;
use meshrix_entry_core::EntryError;

type Result<T> = std::result::Result<T, EntryError>;
type InboundHandler =
    Rc<dyn Fn(PeerApplicationInbound) -> LocalBoxFuture<'static, PeerInboundOutcome>>;

/* --------------------------------- mock port ------------------------------- */

/// One side of an in-memory application transport. `send_message` durably
/// records an outbox entry and queues the delivery; `flush` hands each queued
/// message to the counterpart port's registered inbound handler.
struct MockPort {
    device_id: String,
    inbound: RefCell<Option<InboundHandler>>,
    peer: RefCell<Option<Rc<MockPort>>>,
    queue: RefCell<VecDeque<PeerApplicationInbound>>,
    reachable: Cell<bool>,
    authority: RefCell<PeerApplicationRouteAuthority>,
    fail_sends: Cell<u32>,
    states: RefCell<HashMap<String, String>>,
    sent: Cell<u64>,
}

impl MockPort {
    fn new(device_id: &str) -> Rc<Self> {
        Rc::new(Self {
            device_id: device_id.to_string(),
            inbound: RefCell::new(None),
            peer: RefCell::new(None),
            queue: RefCell::new(VecDeque::new()),
            reachable: Cell::new(true),
            authority: RefCell::new(PeerApplicationRouteAuthority::Current),
            fail_sends: Cell::new(0),
            states: RefCell::new(HashMap::new()),
            sent: Cell::new(0),
        })
    }

    fn pair(device_a: &str, device_b: &str) -> (Rc<MockPort>, Rc<MockPort>) {
        let a = Self::new(device_a);
        let b = Self::new(device_b);
        *a.peer.borrow_mut() = Some(b.clone());
        *b.peer.borrow_mut() = Some(a.clone());
        (a, b)
    }

    /// Deliver everything queued on this port into the counterpart engine.
    async fn flush(&self) {
        loop {
            let next = self.queue.borrow_mut().pop_front();
            let Some(inbound) = next else { return };
            let handler = {
                let peer = self.peer.borrow();
                let peer = peer.as_ref().expect("mock port has no counterpart");
                let handler = peer.inbound.borrow().clone();
                handler
            };
            if let Some(handler) = handler {
                let outcome = handler(inbound).await;
                if matches!(outcome, PeerInboundOutcome::AcceptedByAgent) {
                    // The peer client's terminal state is driven by its own
                    // ACK lane; the application test only needs queue progress.
                }
            }
        }
    }
}

impl PeerApplicationPeerPort for MockPort {
    fn resolve_peer_authority<'a>(
        &'a self,
        _address: &'a PeerApplicationAddress,
    ) -> LocalBoxFuture<'a, Result<PeerApplicationRouteAuthority>> {
        Box::pin(async move { Ok(self.authority.borrow().clone()) })
    }

    fn is_peer_reachable<'a>(
        &'a self,
        _address: &'a PeerApplicationAddress,
    ) -> LocalBoxFuture<'a, Result<bool>> {
        Box::pin(async move { Ok(self.reachable.get()) })
    }

    fn send_message<'a>(
        &'a self,
        address: &'a PeerApplicationAddress,
        plaintext: Vec<u8>,
        message_id: String,
    ) -> LocalBoxFuture<'a, Result<StoredOutboxEntry>> {
        Box::pin(async move {
            if self.fail_sends.get() > 0 {
                self.fail_sends.set(self.fail_sends.get() - 1);
                self.states.borrow_mut().insert(message_id.clone(), "pending".to_string());
                return Err(entry_error(
                    "transport",
                    "mock transport write failed",
                ));
            }
            self.sent.set(self.sent.get() + 1);
            self.states
                .borrow_mut()
                .insert(message_id.clone(), "forwarded".to_string());
            let inbound = PeerApplicationInbound {
                address: PeerApplicationAddress {
                    tenant_id: address.tenant_id.clone(),
                    route_id: address.route_id.clone(),
                    local_device_id: address.peer_device_id.clone(),
                    peer_device_id: address.local_device_id.clone(),
                },
                message: PeerInboundMessage {
                    message_id: message_id.clone(),
                    sender_peer_id: format!("peer:{}", self.device_id),
                    sender_device_id: address.local_device_id.clone(),
                    plaintext: plaintext.clone(),
                    received_at: "2026-01-01T00:00:00.000Z".to_string(),
                },
            };
            self.queue.borrow_mut().push_back(inbound);
            Ok(StoredOutboxEntry {
                identity: PeerMessageIdentity {
                    tenant_id: address.tenant_id.clone(),
                    route_id: address.route_id.clone(),
                    sender_device_id: address.local_device_id.clone(),
                    recipient_device_id: address.peer_device_id.clone(),
                    message_id,
                },
                version: 1,
                sequence: self.sent.get(),
                peer_id: format!("peer:{}", self.device_id),
                state: "forwarded".to_string(),
                envelope: PeerWireEnvelope {
                    format: "signal-pqxdh".to_string(),
                    headers: PeerEnvelopeHeaders {
                        message_type: "session".to_string(),
                        sender_bundle_id: "b".to_string(),
                        recipient_bundle_id: "b".to_string(),
                        prekey_id: None,
                        signed_prekey_id: None,
                        base_key_id: None,
                    },
                    ciphertext: String::new(),
                },
                attempts: 1,
                last_forwarded: None,
                delivery_ack: None,
                last_error: None,
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            })
        })
    }

    fn get_send_state<'a>(
        &'a self,
        _address: &'a PeerApplicationAddress,
        message_id: &'a str,
    ) -> LocalBoxFuture<'a, Result<Option<String>>> {
        Box::pin(async move { Ok(self.states.borrow().get(message_id).cloned()) })
    }

    fn set_inbound_handler(&self, handler: InboundHandler) {
        *self.inbound.borrow_mut() = Some(handler);
    }

    fn retry_pending_inbound<'a>(
        &'a self,
        _address: &'a PeerApplicationAddress,
    ) -> LocalBoxFuture<'a, Result<()>> {
        Box::pin(async move { Ok(()) })
    }
}

/* --------------------------------- mock agent ------------------------------ */

enum AgentBehavior {
    /// Immediately completes with `echo:<prompt>` and one progress line.
    Echo,
    /// Requests one permission, then echoes. The resolution arrives through
    /// `resolve_permission`.
    Permission,
    /// Never completes on its own; cancel() finishes with `cancelled`.
    Hanging,
}

struct MockExecutor {
    summary: AcpAgentSummary,
    behavior: AgentBehavior,
    started: Rc<Cell<u32>>,
    cancelled: Rc<Cell<bool>>,
    permission_seen: Rc<Cell<bool>>,
}

impl PeerApplicationAgentExecutor for MockExecutor {
    fn summary(&self) -> AcpAgentSummary {
        self.summary.clone()
    }

    fn start(
        &self,
        _operation_id: &str,
        prompt: &str,
        _model: Option<String>,
        handlers: PeerApplicationExecutionHandlers,
    ) -> PeerApplicationExecution {
        self.started.set(self.started.get() + 1);
        let prompt = prompt.to_string();
        let cancelled = self.cancelled.clone();
        let permission_seen = self.permission_seen.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let cancel_flag = self.cancelled.clone();
        let behavior = match self.behavior {
            AgentBehavior::Echo => 0,
            AgentBehavior::Permission => 1,
            AgentBehavior::Hanging => 2,
        };
        let cancel: Rc<dyn Fn() -> LocalBoxFuture<'static, ()>> =
            Rc::new(move || {
                cancel_flag.set(true);
                Box::pin(async {})
            });
        match behavior {
            2 => {
                // Result arrives only when cancelled — poll the flag.
                tokio::task::spawn_local(async move {
                    for _ in 0..2000 {
                        if cancelled.get() {
                            let _ = tx.send(Ok(PeerApplicationExecutionResult {
                                stop_reason: "cancelled".to_string(),
                                text: String::new(),
                            }));
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                });
            }
            _ => {
                tokio::task::spawn_local(async move {
                    if (handlers.before_prompt)().await.is_err() {
                        let _ = tx.send(Err(entry_error(
                            "peer_client_state",
                            "before_prompt failed",
                        )));
                        return;
                    }
                    if behavior == 1 {
                        let prompt_req = AcpPermissionPrompt {
                            session_id: "s".to_string(),
                            tool_call: AcpPermissionToolCall {
                                tool_call_id: "tc".to_string(),
                                title: "run".to_string(),
                                name: None,
                                kind: None,
                                status: None,
                                content: Vec::new(),
                                raw_input: None,
                                locations: Vec::new(),
                            },
                            options: vec![
                                AcpPermissionOption {
                                    option_id: "allow".to_string(),
                                    name: "Allow".to_string(),
                                    kind: "allow_once".to_string(),
                                },
                                AcpPermissionOption {
                                    option_id: "deny".to_string(),
                                    name: "Deny".to_string(),
                                    kind: "reject_once".to_string(),
                                },
                            ],
                        };
                        permission_seen.set(true);
                        let resolution = (handlers.request_permission)(prompt_req).await;
                        if !matches!(resolution, AcpPermissionResolution::Selected { .. }) {
                            let _ = tx.send(Ok(PeerApplicationExecutionResult {
                                stop_reason: "cancelled".to_string(),
                                text: String::new(),
                            }));
                            return;
                        }
                    }
                    let _ = (handlers.on_progress)(
                        PeerApplicationProgressKind::Message,
                        "working".to_string(),
                    )
                    .await;
                    let _ = tx.send(Ok(PeerApplicationExecutionResult {
                        stop_reason: "end_turn".to_string(),
                        text: format!("echo:{prompt}"),
                    }));
                });
            }
        }
        PeerApplicationExecution { cancel, result: rx }
    }
}

struct MockDirectory {
    agents: Vec<AcpAgentSummary>,
    executors: HashMap<String, Rc<MockExecutor>>,
}

impl PeerApplicationAgentDirectory for MockDirectory {
    fn list(&self) -> LocalBoxFuture<'_, Result<Vec<AcpAgentSummary>>> {
        Box::pin(async move { Ok(self.agents.clone()) })
    }
    fn get(&self, agent_id: &str) -> Option<Rc<dyn PeerApplicationAgentExecutor>> {
        self.executors
            .get(agent_id)
            .map(|e| e.clone() as Rc<dyn PeerApplicationAgentExecutor>)
    }
}

/* --------------------------------- harness --------------------------------- */

struct Side {
    port: Rc<MockPort>,
    engine: Rc<PeerApplicationEngine>,
    started: Rc<Cell<u32>>,
    cancelled: Rc<Cell<bool>>,
    permission_seen: Rc<Cell<bool>>,
}

fn addr_a() -> PeerApplicationAddress {
    PeerApplicationAddress {
        tenant_id: "tenant".to_string(),
        route_id: "route".to_string(),
        local_device_id: "dev-a".to_string(),
        peer_device_id: "dev-b".to_string(),
    }
}

fn make_pair(behavior_b: Option<AgentBehavior>) -> (tempfile::TempDir, tempfile::TempDir, Side, Side) {
    let (pa, pb) = MockPort::pair("dev-a", "dev-b");
    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();
    let started = Rc::new(Cell::new(0));
    let cancelled = Rc::new(Cell::new(false));
    let permission_seen = Rc::new(Cell::new(false));
    let mut agents = Vec::new();
    let mut executors = HashMap::new();
    if let Some(b) = behavior_b {
        let summary = AcpAgentSummary {
            id: "agent-1".to_string(),
            display_name: "Mock Agent".to_string(),
            description: None,
            enabled: true,
            detected: None,
            transport: Some("acp".into()),
        };
        executors.insert(
            "agent-1".to_string(),
            Rc::new(MockExecutor {
                summary: summary.clone(),
                behavior: b,
                started: started.clone(),
                cancelled: cancelled.clone(),
                permission_seen: permission_seen.clone(),
            }),
        );
        agents.push(summary);
    }
    let engine_a = PeerApplicationEngine::new(PeerApplicationEngineOptions {
        peer: pa.clone(),
        journal: Rc::new(FilePeerApplicationJournal::new(dir_a.path().to_path_buf()).unwrap()),
        agents: Rc::new(MockDirectory { agents: Vec::new(), executors: HashMap::new() }),
    });
    let engine_b = PeerApplicationEngine::new(PeerApplicationEngineOptions {
        peer: pb.clone(),
        journal: Rc::new(FilePeerApplicationJournal::new(dir_b.path().to_path_buf()).unwrap()),
        agents: Rc::new(MockDirectory { agents, executors }),
    });
    (
        dir_a,
        dir_b,
        Side { port: pa, engine: engine_a, started: Rc::new(Cell::new(0)), cancelled: Rc::new(Cell::new(false)), permission_seen: Rc::new(Cell::new(false)) },
        Side { port: pb, engine: engine_b, started, cancelled, permission_seen },
    )
}

/// Pump the in-memory transport queues between both engines for `rounds`
/// passes — one direction's settlement may enqueue a reply for the other.
async fn settle(a: &Side, b: &Side, rounds: usize) {
    for _ in 0..rounds {
        a.port.flush().await;
        tokio::task::yield_now().await;
        b.port.flush().await;
        tokio::task::yield_now().await;
    }
}

/// Poll the caller-side record until it reaches one of `statuses`, driving
/// queue settlement while waiting so pending async work makes progress.
async fn wait_status(
    a: &Side,
    b: &Side,
    operation_id: &str,
    statuses: &[&str],
) -> PeerApplicationRecord {
    for _ in 0..500 {
        settle(a, b, 2).await;
        if let Some(record) = a.engine.get_operation(operation_id).await.unwrap() {
            if statuses.contains(&record.status.as_str()) {
                return record;
            }
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("operation {operation_id} did not reach {statuses:?}");
}

#[test]
fn submit_completes_with_result() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async move {
        tokio::task::LocalSet::new()
            .run_until(async move {
                let (_da, _db, a, b) = make_pair(Some(AgentBehavior::Echo));
                let record = a
                    .engine
                    .submit(addr_a(), None, None, "agent-1".to_string(), "hello".to_string(), None)
                    .await
                    .unwrap();
                assert_eq!(record.status, "delivery_pending");
                assert_eq!(record.role, "caller");
                // Idempotent resubmission returns the same durable record.
                let again = a
                    .engine
                    .submit(
                        addr_a(),
                        Some(record.operation_id.clone()),
                        None,
                        "agent-1".to_string(),
                        "hello".to_string(),
                        None,
                    )
                    .await
                    .unwrap();
                assert_eq!(again.key, record.key);
                for _ in 0..200 {
                    settle(&a, &b, 1).await;
                    let done = a.engine.get_operation(&record.operation_id).await.unwrap();
                    if done.map(|r| r.status == "completed").unwrap_or(false) {
                        break;
                    }
                }
                let final_record = wait_status(&a, &b, &record.operation_id, &["completed"]).await;
                assert_eq!(final_record.result_text.as_deref(), Some("echo:hello"));
                assert_eq!(final_record.result_stop_reason.as_deref(), Some("end_turn"));
                assert_eq!(b.started.get(), 1);
            })
            .await;
    });
}

#[test]
fn discovery_returns_remote_agents() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async move {
        tokio::task::LocalSet::new()
            .run_until(async move {
                let (_da, _db, a, b) = make_pair(Some(AgentBehavior::Echo));
                let record = a.engine.discover_agents(addr_a(), None).await.unwrap();
                assert_eq!(record.status, "pending");
                for _ in 0..200 {
                    settle(&a, &b, 1).await;
                    let current = a.engine.get_discovery(&addr_a(), &record.request_id).await.unwrap();
                    if current.map(|d| d.status == "completed").unwrap_or(false) {
                        break;
                    }
                }
                let discovery = a.engine.get_discovery(&addr_a(), &record.request_id).await.unwrap().unwrap();
                assert_eq!(discovery.status, "completed");
                assert_eq!(discovery.agents.len(), 1);
                assert_eq!(discovery.agents[0].id, "agent-1");
            })
            .await;
    });
}

#[test]
fn permission_roundtrip_resolves_execution() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async move {
        tokio::task::LocalSet::new()
            .run_until(async move {
                let (_da, _db, a, b) = make_pair(Some(AgentBehavior::Permission));
                let record = a
                    .engine
                    .submit(addr_a(), None, None, "agent-1".to_string(), "hi".to_string(), None)
                    .await
                    .unwrap();
                // Wait until the receiver's execution is waiting on permission.
                let receiver_record = loop {
                    settle(&a, &b, 1).await;
                    if b.permission_seen.get() {
                        let ops = b.engine.list_operations().await.unwrap();
                        if let Some(op) = ops.into_iter().next() {
                            break op;
                        }
                    }
                };
                assert_eq!(receiver_record.status, "awaiting_permission");
                let permission = receiver_record.permission.expect("pending permission record");
                b.engine
                    .resolve_permission(
                        &receiver_record.operation_id,
                        &permission.id,
                        AcpPermissionResolution::Selected {
                            option_id: "allow".to_string(),
                        },
                    )
                    .await
                    .unwrap();
                let final_record = wait_status(&a, &b, &record.operation_id, &["completed"]).await;
                assert_eq!(final_record.result_text.as_deref(), Some("echo:hi"));
            })
            .await;
    });
}

#[test]
fn cancel_stops_receiver_execution() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async move {
        tokio::task::LocalSet::new()
            .run_until(async move {
                let (_da, _db, a, b) = make_pair(Some(AgentBehavior::Hanging));
                let record = a
                    .engine
                    .submit(addr_a(), None, None, "agent-1".to_string(), "work".to_string(), None)
                    .await
                    .unwrap();
                // Wait until the receiver started the execution.
                loop {
                    settle(&a, &b, 1).await;
                    if b.started.get() > 0 {
                        break;
                    }
                }
                a.engine.cancel(&record.operation_id).await.unwrap();
                let final_record =
                    wait_status(&a, &b, &record.operation_id, &["cancelled", "completed"]).await;
                assert_eq!(final_record.status, "cancelled");
                assert!(b.cancelled.get());
            })
            .await;
    });
}

#[test]
fn result_survives_caller_restart() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async move {
        tokio::task::LocalSet::new()
            .run_until(async move {
                let (pa, pb) = MockPort::pair("dev-a", "dev-b");
                let dir_a = tempfile::tempdir().unwrap();
                let dir_b = tempfile::tempdir().unwrap();
                let started = Rc::new(Cell::new(0));
                let cancelled = Rc::new(Cell::new(false));
                let permission_seen = Rc::new(Cell::new(false));
                let summary = AcpAgentSummary {
                    id: "agent-1".to_string(),
                    display_name: "Mock Agent".to_string(),
                    description: None,
                    enabled: true,
                    detected: None,
                    transport: Some("acp".into()),
                };
                let executor = Rc::new(MockExecutor {
                    summary: summary.clone(),
                    behavior: AgentBehavior::Echo,
                    started: started.clone(),
                    cancelled: cancelled.clone(),
                    permission_seen: permission_seen.clone(),
                });
                let mut executors = HashMap::new();
                executors.insert("agent-1".to_string(), executor);
                let engine_b = PeerApplicationEngine::new(PeerApplicationEngineOptions {
                    peer: pb.clone(),
                    journal: Rc::new(
                        FilePeerApplicationJournal::new(dir_b.path().to_path_buf()).unwrap(),
                    ),
                    agents: Rc::new(MockDirectory {
                        agents: vec![summary],
                        executors,
                    }),
                });
                let b = Side { port: pb, engine: engine_b, started, cancelled, permission_seen };
                let engine_a = PeerApplicationEngine::new(PeerApplicationEngineOptions {
                    peer: pa.clone(),
                    journal: Rc::new(
                        FilePeerApplicationJournal::new(dir_a.path().to_path_buf()).unwrap(),
                    ),
                    agents: Rc::new(MockDirectory {
                        agents: Vec::new(),
                        executors: HashMap::new(),
                    }),
                });
                let a = Side {
                    port: pa.clone(),
                    engine: engine_a,
                    started: Rc::new(Cell::new(0)),
                    cancelled: Rc::new(Cell::new(false)),
                    permission_seen: Rc::new(Cell::new(false)),
                };
                let record = a
                    .engine
                    .submit(addr_a(), None, None, "agent-1".to_string(), "hi".to_string(), None)
                    .await
                    .unwrap();
                // Deliver the request only; hold B's result events in its queue.
                loop {
                    tokio::task::yield_now().await;
                    a.port.flush().await;
                    tokio::task::yield_now().await;
                    if b.started.get() > 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                // Simulate caller process restart: same journal, new engine on
                // the same port (re-registers the inbound handler).
                drop(a.engine);
                let engine_a2 = PeerApplicationEngine::new(PeerApplicationEngineOptions {
                    peer: pa.clone(),
                    journal: Rc::new(
                        FilePeerApplicationJournal::new(dir_a.path().to_path_buf()).unwrap(),
                    ),
                    agents: Rc::new(MockDirectory {
                        agents: Vec::new(),
                        executors: HashMap::new(),
                    }),
                });
                engine_a2.resume().await.unwrap();
                let a2 = Side {
                    port: pa,
                    engine: engine_a2,
                    started: Rc::new(Cell::new(0)),
                    cancelled: Rc::new(Cell::new(false)),
                    permission_seen: Rc::new(Cell::new(false)),
                };
                for _ in 0..200 {
                    settle(&a2, &b, 1).await;
                    let done = a2.engine.get_operation(&record.operation_id).await.unwrap();
                    if done.map(|r| r.status == "completed").unwrap_or(false) {
                        break;
                    }
                }
                let final_record =
                    wait_status(&a2, &b, &record.operation_id, &["completed"]).await;
                assert_eq!(final_record.result_text.as_deref(), Some("echo:hi"));
            })
            .await;
    });
}
