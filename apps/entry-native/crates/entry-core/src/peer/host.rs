//! The peer host thread — one dedicated `current_thread` runtime + `LocalSet`
//! owning every `!Send` peer object: the application router, the durable
//! engine, the ACP agent registry, and one `EntryPeerRuntime` per enrolled
//! connection. This is the faithful port of the TS product service's
//! single-threaded composition; the multi-thread `EntryService` talks to it
//! over unbounded channels only.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use futures_util::future::LocalBoxFuture;
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::error::entry_error;
use crate::relay::entry::{EntrySession, EntrySessionEvent};
use crate::Result;

use super::application::{
    AcpAgentSummary, AcpPermissionResolution, PeerApplicationAddress, PeerApplicationDiscoveryRecord,
    PeerApplicationRecord, PeerApplicationRouteAuthority,
};
use super::application_engine::{
    PeerApplicationAgentDirectory, PeerApplicationEngine, PeerApplicationPeerPort,
};
use super::application_journal::FilePeerApplicationJournal;
use super::client::{PeerClientEvent, PeerInboundOutcome, PeerRouteIdentity};
use super::client_store::{FilePeerClientStore, StoredOutboxEntry};
use super::runtime::{EntryPeerRuntime, EntryPeerRuntimeOptions, EntryPeerStatus};
use super::router::{ApplicationPeerRouteBinding, EntryApplicationPeerRouter};
use super::identity::PairedSignalIdentity;
use crate::endpoint::runtime::{
    PersonalEndpointEnrollmentInput, PersonalEndpointEntryDevice, PersonalEndpointRuntime,
    PersonalEndpointRuntimeOptions, PersonalEndpointSnapshot,
};
use crate::endpoint::runtime::PersonalEndpointInboundHandler;
use crate::pairing::invite::PairingInvite;

/// Everything the host needs to bind one enrolled connection.
pub struct PeerAttachRequest {
    pub connection_id: String,
    pub store_dir: std::path::PathBuf,
    pub route: PeerRouteIdentity,
    /// `stored.endpointDeviceId` — the only peer device this binding allows.
    pub endpoint_device_id: String,
    /// `stored.endpointPeerIdentity` — pairing-pinned remote Signal identity.
    pub endpoint_peer_identity: Option<PairedSignalIdentity>,
    /// Authority snapshot logic lives with the service — the host calls this
    /// synchronously for both `allowsPeer` and `resolvePeerAuthority`.
    /// `true` = the exact stored connection still permits this peer route.
    pub allows_peer: Arc<dyn Fn() -> bool + Send + Sync>,
    pub peer_authority: Arc<dyn Fn() -> PeerApplicationRouteAuthority + Send + Sync>,
    pub session: Arc<EntrySession>,
}

pub enum PeerHostCommand {
    Attach {
        request: PeerAttachRequest,
        reply: oneshot::Sender<Result<()>>,
    },
    Detach {
        connection_id: String,
    },
    PeerSend {
        connection_id: String,
        peer_device_id: String,
        plaintext: Vec<u8>,
        message_id: Option<String>,
        reply: oneshot::Sender<Result<StoredOutboxEntry>>,
    },
    PeerStatus {
        connection_id: String,
        reply: oneshot::Sender<Result<EntryPeerStatus>>,
    },
    PeerInbox {
        connection_id: String,
        limit: usize,
        after_sequence: u64,
        reply: oneshot::Sender<Result<crate::peer::runtime::PeerInboxResult>>,
    },
    PeerPairSafety {
        connection_id: String,
        peer_device_id: String,
        reply: oneshot::Sender<Result<crate::peer::runtime::PeerPairSafety>>,
    },
    Submit {
        address: PeerApplicationAddress,
        operation_id: Option<String>,
        caller_agent_id: Option<String>,
        target_agent_id: String,
        prompt: String,
        model: Option<String>,
        reply: oneshot::Sender<Result<PeerApplicationRecord>>,
    },
    Discover {
        address: PeerApplicationAddress,
        request_id: Option<String>,
        reply: oneshot::Sender<Result<PeerApplicationDiscoveryRecord>>,
    },
    Cancel {
        operation_id: String,
        reply: oneshot::Sender<Result<PeerApplicationRecord>>,
    },
    ResolvePermission {
        operation_id: String,
        permission_id: String,
        resolution: AcpPermissionResolution,
        reply: oneshot::Sender<Result<PeerApplicationRecord>>,
    },
    ListOperations {
        reply: oneshot::Sender<Result<Vec<PeerApplicationRecord>>>,
    },
    GetOperation {
        operation_id: String,
        reply: oneshot::Sender<Result<Option<PeerApplicationRecord>>>,
    },
    LocalAgents {
        reply: oneshot::Sender<Result<Vec<AcpAgentSummary>>>,
    },
    RemoteAgents {
        address: PeerApplicationAddress,
        reply: oneshot::Sender<Result<Vec<AcpAgentSummary>>>,
    },
    AgentRegister {
        input: crate::agent::registry::AcpAgentDefinitionInput,
        reply: oneshot::Sender<Result<AcpAgentSummary>>,
    },
    AgentUpdate {
        id: String,
        input: crate::agent::registry::AcpAgentDefinitionInput,
        reply: oneshot::Sender<Result<AcpAgentSummary>>,
    },
    AgentRemove {
        id: String,
        reply: oneshot::Sender<Result<bool>>,
    },
    Resume,
    /// Create (or replace) the personal endpoint runtime on this host thread.
    /// `options` is `Send`; the `!Send` runtime is built inside the LocalSet.
    EndpointAttach {
        options: PersonalEndpointRuntimeOptions,
        reply: oneshot::Sender<Result<()>>,
    },
    EndpointEnroll {
        input: PersonalEndpointEnrollmentInput,
        reply: oneshot::Sender<Result<PersonalEndpointSnapshot>>,
    },
    EndpointReenroll {
        input: PersonalEndpointEnrollmentInput,
        reply: oneshot::Sender<Result<PersonalEndpointSnapshot>>,
    },
    EndpointStart {
        reply: oneshot::Sender<Result<PersonalEndpointSnapshot>>,
    },
    EndpointStop {
        reply: oneshot::Sender<()>,
    },
    EndpointSnapshot {
        reply: oneshot::Sender<Result<PersonalEndpointSnapshot>>,
    },
    EndpointInvite {
        reply: oneshot::Sender<Result<PairingInvite>>,
    },
    EndpointPeerSend {
        peer_device_id: String,
        plaintext: Vec<u8>,
        message_id: Option<String>,
        reply: oneshot::Sender<Result<StoredOutboxEntry>>,
    },
    EndpointPeerStatus {
        reply: oneshot::Sender<Result<Vec<PersonalEndpointEntryDevice>>>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

#[derive(Debug, Clone)]
pub enum PeerHostEvent {
    /// One durable application change (operation or discovery record).
    ApplicationOperation(PeerApplicationRecord),
    ApplicationDiscovery(PeerApplicationDiscoveryRecord),
    /// A peer-runtime lifecycle/transport event for one connection.
    PeerClient {
        connection_id: String,
        event: PeerClientEvent,
    },
    /// Personal endpoint snapshot change — emitted by the runtime's
    /// `on_state` hook so the UI tracks relay/authority transitions live.
    Endpoint(Box<PersonalEndpointSnapshot>),
}

/// `Send + Sync` facade — safe to hold inside `EntryService`.
pub struct PeerHost {
    cmd: mpsc::UnboundedSender<PeerHostCommand>,
    events: broadcast::Sender<PeerHostEvent>,
    thread: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl PeerHost {
    /// Spawn the dedicated thread and its `LocalSet` actor loop.
    pub fn spawn(options: PeerHostOptions) -> Result<Arc<Self>> {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<PeerHostCommand>();
        let (events_tx, _) = broadcast::channel(256);
        let events2 = events_tx.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<()>>();
        let thread = std::thread::Builder::new()
            .name("meshrix-peer-host".to_string())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                let Ok(rt) = rt else {
                    let _ = ready_tx.send(Err(entry_error(
                        "peer_unavailable",
                        "The peer host runtime could not start.",
                    )));
                    return;
                };
                let _ = ready_tx.send(Ok(()));
                let local = tokio::task::LocalSet::new();
                rt.block_on(local.run_until(async move {
                    match host_main(options, cmd_rx, events2).await {
                        Ok(()) => {}
                        Err(e) => {
                            let _ = e;
                        }
                    }
                }));
            })
            .map_err(|_| entry_error("peer_unavailable", "The peer host thread could not spawn."))?;
        ready_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| entry_error("peer_unavailable", "The peer host did not signal readiness."))??;
        Ok(Arc::new(Self {
            cmd: cmd_tx,
            events: events_tx,
            thread: std::sync::Mutex::new(Some(thread)),
        }))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PeerHostEvent> {
        self.events.subscribe()
    }

    async fn call<T>(
        &self,
        build: impl FnOnce(oneshot::Sender<Result<T>>) -> PeerHostCommand,
    ) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.cmd
            .send(build(tx))
            .map_err(|_| entry_error("peer_unavailable", "The peer host is stopped."))?;
        rx.await
            .map_err(|_| entry_error("peer_unavailable", "The peer host dropped the request."))?
    }

    pub async fn attach_connection(&self, request: PeerAttachRequest) -> Result<()> {
        self.call(|reply| PeerHostCommand::Attach { request, reply })
            .await
    }

    pub fn detach_connection(&self, connection_id: &str) {
        let _ = self.cmd.send(PeerHostCommand::Detach {
            connection_id: connection_id.to_string(),
        });
    }

    pub async fn peer_send(
        &self,
        connection_id: &str,
        peer_device_id: &str,
        plaintext: Vec<u8>,
        message_id: Option<String>,
    ) -> Result<StoredOutboxEntry> {
        self.call(|reply| PeerHostCommand::PeerSend {
            connection_id: connection_id.to_string(),
            peer_device_id: peer_device_id.to_string(),
            plaintext,
            message_id,
            reply,
        })
        .await
    }

    pub async fn peer_status(&self, connection_id: &str) -> Result<EntryPeerStatus> {
        self.call(|reply| PeerHostCommand::PeerStatus {
            connection_id: connection_id.to_string(),
            reply,
        })
        .await
    }

    /// `runtime.inbox` — bounded local inbox history + pending-handoff pages.
    pub async fn peer_inbox(
        &self,
        connection_id: &str,
        limit: usize,
        after_sequence: u64,
    ) -> Result<crate::peer::runtime::PeerInboxResult> {
        let connection_id = connection_id.to_string();
        self.call(|reply| PeerHostCommand::PeerInbox {
            connection_id,
            limit,
            after_sequence,
            reply,
        })
        .await
    }

    /// `runtime.pairSafety` — out-of-band peer identity evidence.
    pub async fn peer_pair_safety(
        &self,
        connection_id: &str,
        peer_device_id: &str,
    ) -> Result<crate::peer::runtime::PeerPairSafety> {
        let connection_id = connection_id.to_string();
        let peer_device_id = peer_device_id.to_string();
        self.call(|reply| PeerHostCommand::PeerPairSafety {
            connection_id,
            peer_device_id,
            reply,
        })
        .await
    }

    pub async fn application_submit(
        &self,
        address: PeerApplicationAddress,
        operation_id: Option<String>,
        caller_agent_id: Option<String>,
        target_agent_id: String,
        prompt: String,
        model: Option<String>,
    ) -> Result<PeerApplicationRecord> {
        self.call(|reply| PeerHostCommand::Submit {
            address,
            operation_id,
            caller_agent_id,
            target_agent_id,
            prompt,
            model,
            reply,
        })
        .await
    }

    pub async fn application_discover(
        &self,
        address: PeerApplicationAddress,
        request_id: Option<String>,
    ) -> Result<PeerApplicationDiscoveryRecord> {
        self.call(|reply| PeerHostCommand::Discover {
            address,
            request_id,
            reply,
        })
        .await
    }

    pub async fn application_cancel(&self, operation_id: &str) -> Result<PeerApplicationRecord> {
        self.call(|reply| PeerHostCommand::Cancel {
            operation_id: operation_id.to_string(),
            reply,
        })
        .await
    }

    pub async fn application_resolve_permission(
        &self,
        operation_id: &str,
        permission_id: &str,
        resolution: AcpPermissionResolution,
    ) -> Result<PeerApplicationRecord> {
        self.call(|reply| PeerHostCommand::ResolvePermission {
            operation_id: operation_id.to_string(),
            permission_id: permission_id.to_string(),
            resolution,
            reply,
        })
        .await
    }

    pub async fn list_operations(&self) -> Result<Vec<PeerApplicationRecord>> {
        self.call(|reply| PeerHostCommand::ListOperations { reply })
            .await
    }

    pub async fn get_operation(
        &self,
        operation_id: &str,
    ) -> Result<Option<PeerApplicationRecord>> {
        self.call(|reply| PeerHostCommand::GetOperation {
            operation_id: operation_id.to_string(),
            reply,
        })
        .await
    }

    pub async fn local_agents(&self) -> Result<Vec<AcpAgentSummary>> {
        self.call(|reply| PeerHostCommand::LocalAgents { reply })
            .await
    }

    pub async fn remote_agents(
        &self,
        address: PeerApplicationAddress,
    ) -> Result<Vec<AcpAgentSummary>> {
        self.call(|reply| PeerHostCommand::RemoteAgents { address, reply })
            .await
    }

    pub async fn agent_register(
        &self,
        input: crate::agent::registry::AcpAgentDefinitionInput,
    ) -> Result<AcpAgentSummary> {
        self.call(|reply| PeerHostCommand::AgentRegister { input, reply })
            .await
    }

    pub async fn agent_update(
        &self,
        id: &str,
        input: crate::agent::registry::AcpAgentDefinitionInput,
    ) -> Result<AcpAgentSummary> {
        self.call(|reply| PeerHostCommand::AgentUpdate {
            id: id.to_string(),
            input,
            reply,
        })
        .await
    }

    pub async fn agent_remove(&self, id: &str) -> Result<bool> {
        self.call(|reply| PeerHostCommand::AgentRemove {
            id: id.to_string(),
            reply,
        })
        .await
    }

    pub async fn resume(&self) {
        let _ = self.cmd.send(PeerHostCommand::Resume);
    }

    /// `PersonalEndpointRuntime.create` on the host thread — the runtime is
    /// `!Send` and never crosses the channel boundary.
    pub async fn endpoint_attach(&self, options: PersonalEndpointRuntimeOptions) -> Result<()> {
        self.call(|reply| PeerHostCommand::EndpointAttach { options, reply })
            .await
    }

    pub async fn endpoint_enroll(
        &self,
        input: PersonalEndpointEnrollmentInput,
    ) -> Result<PersonalEndpointSnapshot> {
        self.call(|reply| PeerHostCommand::EndpointEnroll { input, reply })
            .await
    }

    pub async fn endpoint_reenroll(
        &self,
        input: PersonalEndpointEnrollmentInput,
    ) -> Result<PersonalEndpointSnapshot> {
        self.call(|reply| PeerHostCommand::EndpointReenroll { input, reply })
            .await
    }

    /// `start()` plus application-route registration — the endpoint side
    /// mirrors `product-service`'s `registerEndpointRoute`.
    pub async fn endpoint_start(&self) -> Result<PersonalEndpointSnapshot> {
        self.call(|reply| PeerHostCommand::EndpointStart { reply })
            .await
    }

    pub async fn endpoint_stop(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.cmd
            .send(PeerHostCommand::EndpointStop { reply: tx })
            .map_err(|_| entry_error("peer_unavailable", "The peer host is stopped."))?;
        rx.await
            .map_err(|_| entry_error("peer_unavailable", "The peer host dropped the request."))?;
        Ok(())
    }

    pub async fn endpoint_snapshot(&self) -> Result<PersonalEndpointSnapshot> {
        self.call(|reply| PeerHostCommand::EndpointSnapshot { reply })
            .await
    }

    pub async fn endpoint_invite(&self) -> Result<PairingInvite> {
        self.call(|reply| PeerHostCommand::EndpointInvite { reply })
            .await
    }

    pub async fn endpoint_peer_send(
        &self,
        peer_device_id: &str,
        plaintext: &[u8],
        message_id: Option<String>,
    ) -> Result<StoredOutboxEntry> {
        let peer_device_id = peer_device_id.to_string();
        let plaintext = plaintext.to_vec();
        self.call(|reply| PeerHostCommand::EndpointPeerSend {
            peer_device_id,
            plaintext,
            message_id,
            reply,
        })
        .await
    }

    pub async fn endpoint_peer_status(&self) -> Result<Vec<PersonalEndpointEntryDevice>> {
        self.call(|reply| PeerHostCommand::EndpointPeerStatus { reply })
            .await
    }

    pub async fn shutdown(&self) {
        let (tx, rx) = oneshot::channel();
        if self.cmd.send(PeerHostCommand::Shutdown { reply: tx }).is_ok() {
            let _ = rx.await;
        }
        if let Some(thread) = self.thread.lock().unwrap().take() {
            let _ = thread.join();
        }
    }
}

impl Drop for PeerHost {
    fn drop(&mut self) {
        let (tx, _rx) = oneshot::channel();
        let _ = self.cmd.send(PeerHostCommand::Shutdown { reply: tx });
    }
}

pub struct PeerHostOptions {
    /// `<dataDir>/personal-agent` — journal + agents.json root.
    pub agent_root: std::path::PathBuf,
    /// Secret resolution for `secret_reference` agent environment sources.
    pub secret_resolver: Arc<dyn crate::agent::registry::AcpAgentSecretResolver>,
    /// Stored-connection authority — resolved against live service state on
    /// the service's thread context, callable synchronously from the host.
    pub authority_resolver:
        Arc<dyn Fn(&PeerApplicationAddress) -> PeerApplicationRouteAuthority + Send + Sync>,
    /// `isReachable` extension — whether the connection's live session can
    /// currently carry work. Defaults to runtime presence alone.
    pub connection_sessions: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    /// Test seam — substitutes the local agent directory the engine receives.
    /// A `Send` factory because `PeerHostOptions` crosses the spawn boundary;
    /// the host thread builds the `Rc` locally on its own `LocalSet`.
    /// (`None` = `FileAcpAgentRegistry` over `agent_root`, the production path.)
    #[doc(hidden)]
    pub agents_override:
        Option<Box<dyn Fn() -> Rc<dyn super::application_engine::PeerApplicationAgentDirectory> + Send>>,
}

/* ------------------------------ actor internals ---------------------------- */

struct HostState {
    router: Rc<EntryApplicationPeerRouter>,
    engine: Rc<PeerApplicationEngine>,
    registry: Rc<crate::agent::registry::FileAcpAgentRegistry>,
    runtimes: HashMap<String, Rc<EntryPeerRuntime>>,
    unbind: HashMap<String, Box<dyn Fn()>>,
    watchers: HashMap<String, tokio::task::AbortHandle>,
    connection_sessions: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    /// The personal endpoint runtime — this device acting as the relay-side
    /// endpoint that paired entry clients talk to.
    endpoint: Option<PersonalEndpointRuntime>,
    endpoint_unbind: Option<Box<dyn Fn()>>,
    events: broadcast::Sender<PeerHostEvent>,
}

async fn host_main(
    options: PeerHostOptions,
    mut cmd: mpsc::UnboundedReceiver<PeerHostCommand>,
    events: broadcast::Sender<PeerHostEvent>,
) -> Result<()> {
    let journal_dir = options.agent_root.join("history");
    let journal = Rc::new(FilePeerApplicationJournal::new(journal_dir)?);
    let registry = crate::agent::registry::FileAcpAgentRegistry::new(
        options.agent_root.join("agents.json"),
        options.secret_resolver.clone(),
    )?;
    // Load before accepting inbound ACP requests; otherwise a valid enrolled
    // Agent could be mistaken for an unknown id during first recovery.
    let _ = registry.list().await;

    let authority = options.authority_resolver.clone();
    let router = EntryApplicationPeerRouter::new(Some(Rc::new(move |address| {
        let authority = authority.clone();
        Box::pin(async move {
            // The resolver performs custody + blocking account HTTP — run it
            // on the blocking pool so the LocalSet never stalls.
            tokio::task::spawn_blocking(move || authority(&address))
                .await
                .unwrap_or(PeerApplicationRouteAuthority::Unavailable)
        }) as LocalBoxFuture<'static, _>
    })));

    let agents: Rc<dyn super::application_engine::PeerApplicationAgentDirectory> = match
        &options.agents_override
    {
        Some(factory) => factory(),
        None => crate::agent::detect::DetectedAgentDirectory::new(
            registry.clone(),
            options.secret_resolver.clone(),
        ),
    };
    let engine = PeerApplicationEngine::new(
        super::application_engine::PeerApplicationEngineOptions {
            peer: router.clone(),
            journal,
            agents,
        },
    );

    let state = Rc::new(RefCell::new(HostState {
        router: router.clone(),
        engine: engine.clone(),
        registry: registry.clone(),
        runtimes: HashMap::new(),
        unbind: HashMap::new(),
        watchers: HashMap::new(),
        connection_sessions: options.connection_sessions.clone(),
        endpoint: None,
        endpoint_unbind: None,
        events: events.clone(),
    }));

    // Engine change feed → service broadcast.
    {
        let events = events.clone();
        engine.on_change(Box::new(move |change| {
            let event = match change {
                super::application::PeerApplicationChange::Operation(record) => {
                    PeerHostEvent::ApplicationOperation(record)
                }
                super::application::PeerApplicationChange::Discovery(record) => {
                    PeerHostEvent::ApplicationDiscovery(record)
                }
            };
            let _ = events.send(event);
        }));
    }
    // Authority settled → resume engine + retry durable inbox, exactly like
    // the TS `onAuthorityResolved` wiring.
    {
        let engine = engine.clone();
        let router2 = router.clone();
        let state = state.clone();
        router.on_authority_resolved(Rc::new(move |address, _state| {
            let engine = engine.clone();
            let router2 = router2.clone();
            let _ = &state;
            tokio::task::spawn_local(async move {
                let _ = engine.resume().await;
                let _ = router2.retry_pending_inbound(&address).await;
            });
        }));
    }
    // Recovery sweep at startup — interrupted prompt reservations become
    // `unknown`, never silently re-run.
    let _ = engine.resume().await;

    while let Some(command) = cmd.recv().await {
        match command {
            PeerHostCommand::Attach { request, reply } => {
                let _ = reply.send(attach(&state, request).await);
            }
            PeerHostCommand::Detach { connection_id } => {
                detach(&state, &connection_id).await;
            }
            PeerHostCommand::PeerSend {
                connection_id,
                peer_device_id,
                plaintext,
                message_id,
                reply,
            } => {
                let result = match state.borrow().runtimes.get(&connection_id) {
                    Some(runtime) => {
                        runtime.send_message(&peer_device_id, plaintext, message_id).await
                    }
                    None => Err(entry_error(
                        "peer_unavailable",
                        "The peer runtime is not attached for this connection.",
                    )),
                };
                let _ = reply.send(result);
            }
            PeerHostCommand::PeerStatus { connection_id, reply } => {
                let runtime = state.borrow().runtimes.get(&connection_id).cloned();
                let result = match runtime {
                    Some(runtime) => runtime.status().await,
                    None => Err(entry_error(
                        "peer_unavailable",
                        "The peer runtime is not attached for this connection.",
                    )),
                };
                let _ = reply.send(result);
            }
            PeerHostCommand::PeerInbox {
                connection_id,
                limit,
                after_sequence,
                reply,
            } => {
                let runtime = state.borrow().runtimes.get(&connection_id).cloned();
                let result = match runtime {
                    Some(runtime) => runtime.inbox(limit, after_sequence).await,
                    None => Err(entry_error(
                        "peer_unavailable",
                        "The peer runtime is not attached for this connection.",
                    )),
                };
                let _ = reply.send(result);
            }
            PeerHostCommand::PeerPairSafety {
                connection_id,
                peer_device_id,
                reply,
            } => {
                let runtime = state.borrow().runtimes.get(&connection_id).cloned();
                let result = match runtime {
                    Some(runtime) => runtime.pair_safety(&peer_device_id).await,
                    None => Err(entry_error(
                        "peer_unavailable",
                        "The peer runtime is not attached for this connection.",
                    )),
                };
                let _ = reply.send(result);
            }
            PeerHostCommand::Submit {
                address,
                operation_id,
                caller_agent_id,
                target_agent_id,
                prompt,
                model,
                reply,
            } => {
                let _ = reply.send(
                    state
                        .borrow()
                        .engine
                        .clone()
                        .submit(address, operation_id, caller_agent_id, target_agent_id, prompt, model)
                        .await,
                );
            }
            PeerHostCommand::Discover {
                address,
                request_id,
                reply,
            } => {
                let _ = reply.send(
                    state.borrow().engine.clone().discover_agents(address, request_id).await,
                );
            }
            PeerHostCommand::Cancel { operation_id, reply } => {
                let _ = reply.send(state.borrow().engine.clone().cancel(&operation_id).await);
            }
            PeerHostCommand::ResolvePermission {
                operation_id,
                permission_id,
                resolution,
                reply,
            } => {
                let _ = reply.send(
                    state
                        .borrow()
                        .engine
                        .clone()
                        .resolve_permission(&operation_id, &permission_id, resolution)
                        .await,
                );
            }
            PeerHostCommand::ListOperations { reply } => {
                let _ = reply.send(state.borrow().engine.clone().list_operations().await);
            }
            PeerHostCommand::GetOperation { operation_id, reply } => {
                let _ = reply.send(
                    state.borrow().engine.clone().get_operation(&operation_id).await,
                );
            }
            PeerHostCommand::LocalAgents { reply } => {
                let _ = reply.send(state.borrow().engine.clone().local_agents().await);
            }
            PeerHostCommand::RemoteAgents { address, reply } => {
                let _ = reply.send(
                    state.borrow().engine.clone().remote_agents(&address).await,
                );
            }
            PeerHostCommand::AgentRegister { input, reply } => {
                let _ = reply.send(state.borrow().registry.clone().register(input).await);
            }
            PeerHostCommand::AgentUpdate { id, input, reply } => {
                let _ = reply.send(state.borrow().registry.clone().update(&id, input).await);
            }
            PeerHostCommand::AgentRemove { id, reply } => {
                let _ = reply.send(state.borrow().registry.clone().remove(&id).await);
            }
            PeerHostCommand::Resume => {
                let _ = state.borrow().engine.clone().resume().await;
            }
            PeerHostCommand::EndpointAttach { options, reply } => {
                let mut options = options;
                if options.on_state.is_none() {
                    let events = state.borrow().events.clone();
                    options.on_state = Some(Arc::new(move |snapshot| {
                        let _ = events.send(PeerHostEvent::Endpoint(Box::new(snapshot)));
                    }));
                }
                let _ = reply.send(endpoint_attach(&state, options));
            }
            PeerHostCommand::EndpointEnroll { input, reply } => {
                let result = match endpoint_of(&state) {
                    Ok(runtime) => runtime.enroll_current_account(input).await,
                    Err(e) => Err(e),
                };
                let _ = reply.send(result);
            }
            PeerHostCommand::EndpointReenroll { input, reply } => {
                let result = match endpoint_of(&state) {
                    Ok(runtime) => runtime.reenroll_current_account(input).await,
                    Err(e) => Err(e),
                };
                let _ = reply.send(result);
            }
            PeerHostCommand::EndpointStart { reply } => {
                let _ = reply.send(endpoint_start(&state).await);
            }
            PeerHostCommand::EndpointStop { reply } => {
                let _ = reply.send(endpoint_stop(&state).await);
            }
            PeerHostCommand::EndpointSnapshot { reply } => {
                let result = endpoint_of(&state).map(|runtime| runtime.snapshot());
                let _ = reply.send(result);
            }
            PeerHostCommand::EndpointInvite { reply } => {
                let result = match endpoint_of(&state) {
                    Ok(runtime) => runtime.create_pairing_invite().await,
                    Err(e) => Err(e),
                };
                let _ = reply.send(result);
            }
            PeerHostCommand::EndpointPeerSend {
                peer_device_id,
                plaintext,
                message_id,
                reply,
            } => {
                let result = match endpoint_of(&state) {
                    Ok(runtime) => {
                        runtime
                            .send_message(&peer_device_id, &plaintext, message_id)
                            .await
                    }
                    Err(e) => Err(e),
                };
                let _ = reply.send(result);
            }
            PeerHostCommand::EndpointPeerStatus { reply } => {
                let result = match endpoint_of(&state) {
                    Ok(runtime) => Ok(runtime.list_paired_entry_devices().await),
                    Err(e) => Err(e),
                };
                let _ = reply.send(result);
            }
            PeerHostCommand::Shutdown { reply } => {
                shutdown_host(&state).await;
                let _ = reply.send(());
                return Ok(());
            }
        }
    }
    Ok(())
}

fn endpoint_of(state: &Rc<RefCell<HostState>>) -> Result<PersonalEndpointRuntime> {
    state
        .borrow()
        .endpoint
        .clone()
        .ok_or_else(|| entry_error("personal_endpoint_unavailable", "The personal endpoint is not attached."))
}

fn endpoint_attach(
    state: &Rc<RefCell<HostState>>,
    options: PersonalEndpointRuntimeOptions,
) -> Result<()> {
    // Attach is idempotent: a live runtime keeps its relay session. Read-only
    // calls like `endpoint_snapshot` also arrive here — recreating the runtime
    // on those paths fences the started runtime's transport events and kills
    // its socket. A stopped runtime is detached by `endpoint_stop`, so the
    // next attach builds a fresh one.
    if state.borrow().endpoint.is_some() {
        return Ok(());
    }
    let runtime = PersonalEndpointRuntime::create(options)?;
    state.borrow_mut().endpoint = Some(runtime);
    Ok(())
}

/// `runtime.start()` then register the claimed route with the application
/// router — mirrors `product-service`'s endpoint binding (`subscribe`
/// routes inbound through the runtime's sender-validation dispatch).
async fn endpoint_start(state: &Rc<RefCell<HostState>>) -> Result<PersonalEndpointSnapshot> {
    let runtime = endpoint_of(state)?;
    let snapshot = runtime.start().await?;
    if state.borrow().endpoint_unbind.is_none() {
        let (Some(address), Some(client)) =
            (runtime.claimed_route(), runtime.peer_client())
        else {
            return Ok(snapshot);
        };
        let runtime_allow = runtime.clone();
        let runtime_authority = runtime.clone();
        let runtime_reach = runtime.clone();
        let runtime_sub = runtime.clone();
        let (tenant_id, route_id, local_device_id) = address;
        let route_of = {
            let tenant_id = tenant_id.clone();
            let route_id = route_id.clone();
            let local_device_id = local_device_id.clone();
            move |peer_device_id: String| crate::endpoint::runtime::PersonalEndpointPeerRoute {
                tenant_id: tenant_id.clone(),
                route_id: route_id.clone(),
                local_device_id: local_device_id.clone(),
                peer_device_id,
            }
        };
        let binding = ApplicationPeerRouteBinding {
            tenant_id,
            route_id,
            local_device_id,
            client,
            allows_peer: {
                let route_of = route_of.clone();
                Rc::new(move |peer_device_id| {
                    let runtime = runtime_allow.clone();
                    let route = route_of(peer_device_id);
                    Box::pin(async move {
                        matches!(
                            runtime.resolve_peer_authority(&route).await,
                            PeerApplicationRouteAuthority::Current
                        )
                    }) as LocalBoxFuture<'static, bool>
                })
            },
            resolve_peer_authority: Some(Rc::new(move |peer_device_id| {
                let runtime = runtime_authority.clone();
                let route = route_of(peer_device_id);
                Box::pin(
                    async move { runtime.resolve_peer_authority(&route).await },
                )
                    as LocalBoxFuture<'static, PeerApplicationRouteAuthority>
            })),
            is_reachable: Rc::new(move |peer_device_id| {
                let runtime = runtime_reach.clone();
                Box::pin(async move { runtime.is_peer_reachable(&peer_device_id).await })
                    as LocalBoxFuture<'static, bool>
            }),
            subscribe: Some(Rc::new(move |handler: super::client::PeerDispatchHandler| {
                // Adapt the router dispatch handler into the runtime's
                // sender-validated inbound signature; the address argument
                // is already pinned to this binding by the router itself.
                runtime_sub.on_inbound_message(Rc::new(
                    move |inbound: crate::endpoint::runtime::PersonalEndpointInboundMessage| {
                        let handler = handler.clone();
                        Box::pin(async move { handler(inbound.message).await })
                            as LocalBoxFuture<'static, PeerInboundOutcome>
                    },
                ) as PersonalEndpointInboundHandler)
            })),
        };
        let unregister = state.borrow().router.clone().register(binding)?;
        state.borrow_mut().endpoint_unbind = Some(unregister);
    }
    Ok(snapshot)
}

async fn endpoint_stop(state: &Rc<RefCell<HostState>>) {
    if let Some(unbind) = state.borrow_mut().endpoint_unbind.take() {
        unbind();
    }
    if let Some(runtime) = state.borrow_mut().endpoint.take() {
        // A stopped runtime cannot restart (`assert_not_stopped`); detach it
        // so the next `endpoint_attach` builds a fresh runtime.
        runtime.stop().await;
    }
}

async fn attach(
    state: &Rc<RefCell<HostState>>,
    request: PeerAttachRequest,
) -> Result<()> {
    detach(state, &request.connection_id).await;

    let (client_events_tx, mut client_events_rx) = mpsc::unbounded_channel::<PeerClientEvent>();
    {
        let events = state.borrow().events.clone();
        let connection_id = request.connection_id.clone();
        tokio::task::spawn_local(async move {
            while let Some(event) = client_events_rx.recv().await {
                let _ = events.send(PeerHostEvent::PeerClient {
                    connection_id: connection_id.clone(),
                    event,
                });
            }
        });
    }

    // The device directory resolves ONLY this connection's pinned endpoint
    // identity — a peer id never wanders to another route.
    let endpoint_identity = request.endpoint_peer_identity.clone();
    let endpoint_device = request.endpoint_device_id.clone();
    let directory = LocalPeerDeviceDirectory {
        endpoint_device: endpoint_device.clone(),
        identity: endpoint_identity.clone(),
    };

    let runtime = EntryPeerRuntime::create(EntryPeerRuntimeOptions {
        store_dir: request.store_dir.clone(),
        route: request.route.clone(),
        paired_peer_identity: request.endpoint_peer_identity.clone(),
        client_store: Rc::new(FilePeerClientStore::new(request.store_dir.join("client"))?),
        directory: Some(Rc::new(directory)),
        dispatch: None,
        event_forward: Some(client_events_tx),
    })
    .await?;

    runtime.attach_channel(request.session.clone());

    // The application binding mirrors `#bindEntryApplicationPeer`: only the
    // exact stored endpoint device may speak to this route.
    let allows = request.allows_peer.clone();
    let authority = request.peer_authority.clone();
    let sessions_probe = state.borrow().connection_sessions.clone();
    let connection_id = request.connection_id.clone();
    let endpoint = request.endpoint_device_id.clone();
    let binding = ApplicationPeerRouteBinding {
        tenant_id: request.route.tenant_id.clone(),
        route_id: request.route.route_id.clone(),
        local_device_id: request.route.device_id.clone(),
        client: runtime.client.clone(),
        allows_peer: {
            let allows = allows.clone();
            let endpoint = endpoint.clone();
            Rc::new(move |peer_device_id| {
                let allows = allows.clone();
                let endpoint = endpoint.clone();
                Box::pin(async move { peer_device_id == endpoint && allows() })
                    as LocalBoxFuture<'static, bool>
            })
        },
        resolve_peer_authority: Some({
            let authority = authority.clone();
            let endpoint = endpoint.clone();
            Rc::new(move |peer_device_id| {
                let authority = authority.clone();
                let endpoint = endpoint.clone();
                Box::pin(async move {
                    if peer_device_id != endpoint {
                        return PeerApplicationRouteAuthority::Revoked;
                    }
                    // Custody + blocking account HTTP — keep it off the
                    // LocalSet thread.
                    tokio::task::spawn_blocking(move || authority())
                        .await
                        .unwrap_or(PeerApplicationRouteAuthority::Unavailable)
                })
                    as LocalBoxFuture<'static, PeerApplicationRouteAuthority>
            })
        }),
        is_reachable: {
            let runtime2 = runtime.clone();
            let sessions_probe = sessions_probe.clone();
            let connection_id = connection_id.clone();
            Rc::new(move |peer_device_id| {
                let runtime2 = runtime2.clone();
                let sessions_probe = sessions_probe.clone();
                let connection_id = connection_id.clone();
                Box::pin(async move {
                    sessions_probe(&connection_id) && runtime2.is_peer_reachable(&peer_device_id)
                }) as LocalBoxFuture<'static, bool>
            })
        },
        subscribe: None,
    };
    let unregister = state.borrow().router.clone().register(binding)?;
    let address = PeerApplicationAddress {
        tenant_id: request.route.tenant_id.clone(),
        route_id: request.route.route_id.clone(),
        local_device_id: request.route.device_id.clone(),
        peer_device_id: endpoint.clone(),
    };
    let _ = &address;

    // Watch the live session generation: admitted opens the gate, close
    // transitions close it — `attachTransport` in the TS host.
    let session = request.session.clone();
    let mut events_rx = session.events();
    let runtime2 = runtime.clone();
    let watcher = tokio::task::spawn_local(async move {
        loop {
            match events_rx.changed().await {
                Ok(()) => match events_rx.borrow().clone() {
                    EntrySessionEvent::Admitted | EntrySessionEvent::Ready => {
                        runtime2.on_session_admitted();
                    }
                    EntrySessionEvent::Closed { .. }
                    | EntrySessionEvent::Rejected { .. }
                    | EntrySessionEvent::ChannelLost { .. } => {
                        runtime2.on_session_closed();
                    }
                    _ => {}
                },
                Err(_) => break,
            }
        }
    });

    let mut state = state.borrow_mut();
    state
        .runtimes
        .insert(connection_id.clone(), runtime.clone());
    state.unbind.insert(connection_id.clone(), unregister);
    state.watchers.insert(connection_id, watcher.abort_handle());
    std::mem::forget(watcher);
    // If the session is already live by the time we attach, open the gate.
    if session.state().accepts_new_work {
        runtime.on_session_admitted();
    }
    Ok(())
}

async fn detach(state: &Rc<RefCell<HostState>>, connection_id: &str) {
    let (runtime, unbind, watcher) = {
        let mut state = state.borrow_mut();
        (
            state.runtimes.remove(connection_id),
            state.unbind.remove(connection_id),
            state.watchers.remove(connection_id),
        )
    };
    if let Some(unbind) = unbind {
        unbind();
    }
    if let Some(watcher) = watcher {
        watcher.abort();
    }
    if let Some(runtime) = runtime {
        runtime.close().await;
    }
}

async fn shutdown_host(state: &Rc<RefCell<HostState>>) {
    let ids: Vec<String> = state.borrow().runtimes.keys().cloned().collect();
    for id in ids {
        detach(state, &id).await;
    }
    state.borrow().engine.dispose();
    state.borrow().router.dispose();
}

use std::cell::RefCell;

/// Directory bound to exactly one stored endpoint identity — a peer device id
/// never resolves through another route's pairing.
struct LocalPeerDeviceDirectory {
    endpoint_device: String,
    identity: Option<PairedSignalIdentity>,
}

impl super::client::PeerDeviceDirectory for LocalPeerDeviceDirectory {
    fn resolve_peer_identity(
        &self,
        peer_device_id: &str,
    ) -> LocalBoxFuture<'static, Option<PairedSignalIdentity>> {
        let found = if peer_device_id == self.endpoint_device {
            self.identity.clone()
        } else {
            None
        };
        Box::pin(async move { found })
    }
}
