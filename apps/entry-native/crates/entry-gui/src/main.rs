//! Meshrix Entry — egui desktop shell on `entry-core`.
//!
//! A background tokio worker owns `EntryService`; the egui UI is fully
//! message-driven (`Action` → worker, `Event` → UI) so the render loop never
//! blocks on the network.

use std::sync::Arc;

use eframe::egui;
use meshrix_entry_core::custody::CustodyPreference;
use meshrix_entry_core::endpoint::runtime::{
    PersonalEndpointSnapshot, PersonalEndpointStepUpResult, StepUpDriver,
};
use meshrix_entry_core::peer::{AcpAgentSummary, AcpPermissionResolution, PeerApplicationRecord, PeerHostEvent};
use meshrix_entry_core::relay::EntrySessionEvent;
use meshrix_entry_core::service::{
    EntryService, FileCustodyOpts, ServiceConfig, ServiceState, StepUpPoll,
};
use tokio::sync::mpsc;

mod theme;

// ── message plumbing ────────────────────────────────────────────────────────

enum Action {
    Refresh,
    BeginLogin,
    SignOut,
    Pair {
        invite: String,
    },
    Connect {
        connection_id: String,
    },
    Disconnect {
        connection_id: String,
    },
    /// Local un-pair: drop the connection record and its custody secrets.
    RemoveConnection {
        connection_id: String,
    },
    Recover {
        connection_id: String,
        text: String,
    },
    /// Fetch the remote agent catalog for a connection.
    Discover {
        connection_id: String,
    },
    OpCancel {
        operation_id: String,
    },
    Permit {
        operation_id: String,
        permission_id: String,
        resolution: AcpPermissionResolution,
    },
    RefreshAgents,
    EndpointRefresh,
    EndpointEnroll,
    EndpointStart,
    EndpointStop,
    EndpointInvite,
    RecoveryRefresh,
    RecoveryBegin,
    RecoveryReveal,
    RecoveryConfirm,
    RecoveryPublish,
    RecoveryRotate,
    RecoveryRetryWriter,
    RecoveryPollWriter,
    RecoveryRetryRotation,
    RecoveryAbortRotation,
    RecoveryImport {
        text: String,
        service_url: Option<String>,
    },
}

enum Event {
    State(ServiceState),
    Log(String),
    Busy(String),
    Idle,
    LoginUrl {
        url: String,
        code: String,
    },
    /// The login flow reached a terminal state — close the approval sheet.
    LoginFinished,
    PairingUrl {
        url: String,
        code: String,
    },
    PairingDone {
        connection_id: String,
    },
    Error(String),
    Session {
        connection_id: String,
        event: String,
    },
    /// Fresh remote agent catalog for one connection.
    RemoteAgents {
        connection_id: String,
        agents: Vec<AcpAgentSummary>,
    },
    /// Durable operation change pushed by the peer host.
    Operation(Box<PeerApplicationRecord>),
    /// Full local agent list.
    LocalAgents(Vec<AcpAgentSummary>),
    /// Personal endpoint snapshot after attach/start/stop/enroll.
    Endpoint(Box<PersonalEndpointSnapshot>),
    /// The enrollment step-up produced a browser approval URL.
    EndpointApprovalUrl { url: String, code: String },
    /// A fresh invite is ready to share.
    EndpointInviteReady { text: String },
    /// Redacted recovery view (`GuiRecoveryView` equivalent).
    Recovery(serde_json::Value),
    /// The one-shot recovery text reveal — shown in the sheet, never stored.
    RecoveryReveal { text: String },
    /// The writer step-up browser approval URL.
    WriterApprovalUrl { url: String, code: String },
}

struct Bridge {
    actions: mpsc::UnboundedSender<Action>,
    events: mpsc::UnboundedReceiver<Event>,
}

fn spawn_worker(service: EntryService) -> (Bridge, tokio::runtime::Runtime) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let (action_tx, mut action_rx) = mpsc::unbounded_channel::<Action>();
    let (event_tx, event_rx) = mpsc::unbounded_channel::<Event>();

    let service = Arc::new(service);
    {
        let service = service.clone();
        let event_tx = event_tx.clone();
        runtime.spawn(async move {
            let _ = event_tx.send(Event::State(service.state()));
            // External writers (CLI, other processes) share the config file —
            // poll it so their changes surface in the UI without a restart.
            {
                let service = service.clone();
                let tx = event_tx.clone();
                tokio::spawn(async move {
                    let mut interval =
                        tokio::time::interval(std::time::Duration::from_secs(1));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    loop {
                        interval.tick().await;
                        match service.reload_if_changed() {
                            Ok(true) => {
                                let _ = tx.send(Event::State(service.state()));
                            }
                            Ok(false) => {}
                            Err(e) => {
                                let _ = tx.send(Event::Log(format!("config reload failed: {e}")));
                            }
                        }
                    }
                });
            }
            // Eagerly spawn the peer host like `product-service.ts` startup —
            // `engine.resume()` runs inside it, and its change feed is the
            // live application surface for the UI.
            match service.peer_events() {
                Ok(mut feed) => {
                    let tx = event_tx.clone();
                    let service = service.clone();
                    tokio::spawn(async move {
                        loop {
                            match feed.recv().await {
                                Ok(PeerHostEvent::ApplicationOperation(record)) => {
                                    let _ = tx.send(Event::Operation(Box::new(record)));
                                }
                                Ok(PeerHostEvent::ApplicationDiscovery(record)) => {
                                    let _ = tx.send(Event::RemoteAgents {
                                        connection_id: record.address.local_device_id.clone(),
                                        agents: record.agents.clone(),
                                    });
                                }
                                Ok(PeerHostEvent::PeerClient {
                                    connection_id,
                                    event,
                                }) => {
                                    let _ = tx.send(Event::Session {
                                        connection_id,
                                        event: format!("peer: {event:?}"),
                                    });
                                }
                                Ok(PeerHostEvent::Endpoint(snapshot)) => {
                                    let _ = tx.send(Event::Endpoint(snapshot));
                                }
                                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                    continue
                                }
                                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                            }
                        }
                    });
                    if let Ok(agents) = service.local_agents().await {
                        let _ = event_tx.send(Event::LocalAgents(agents));
                    }
                }
                Err(e) => {
                    let _ = event_tx.send(Event::Log(format!("peer host unavailable: {e}")));
                }
            }
            while let Some(action) = action_rx.recv().await {
                let service = service.clone();
                let tx = event_tx.clone();
                match action {
                    Action::Refresh => {
                        let _ = tx.send(Event::State(service.state()));
                    }
                    Action::BeginLogin => {
                        tokio::spawn(async move {
                            if let Err(e) = login_flow(service, tx.clone()).await {
                                tracing::error!(error = %e, "login flow failed");
                                let _ = tx.send(Event::Error(format!("login failed: {e}")));
                                let _ = tx.send(Event::Idle);
                                let _ = tx.send(Event::LoginFinished);
                            }
                        });
                    }
                    Action::SignOut => {
                        match service.sign_out() {
                            Ok(()) => {
                                let _ = tx.send(Event::Log("signed out".into()));
                            }
                            Err(e) => {
                                let _ = tx.send(Event::Error(format!("sign out failed: {e}")));
                            }
                        }
                        let _ = tx.send(Event::State(service.state()));
                    }
                    Action::Pair { invite } => {
                        tokio::spawn(async move {
                            pairing_flow(service, tx, invite).await;
                        });
                    }
                    Action::Connect { connection_id } => {
                        tokio::spawn(async move {
                            connect_flow(service, tx, connection_id).await;
                        });
                    }
                    Action::Disconnect { connection_id } => {
                        service.disconnect(&connection_id).await;
                        let _ = tx.send(Event::Log(format!("{connection_id}: disconnected")));
                        let _ = tx.send(Event::State(service.state()));
                    }
                    Action::RemoveConnection { connection_id } => {
                        match service.remove_connection(&connection_id) {
                            Ok(true) => {
                                let _ = tx.send(Event::Log(format!("{connection_id}: removed")));
                            }
                            Ok(false) => {
                                let _ = tx.send(Event::Error(format!("{connection_id}: not found")));
                            }
                            Err(e) => {
                                let _ = tx.send(Event::Error(format!("{connection_id}: {e}")));
                            }
                        }
                        let _ = tx.send(Event::State(service.state()));
                    }
                    Action::Recover {
                        connection_id,
                        text,
                    } => {
                        tokio::spawn(async move {
                            let _ = tx.send(Event::Busy("running recovery…".into()));
                            match service.recover_connection(&connection_id, &text).await {
                                Ok(outcome) => {
                                    let _ =
                                        tx.send(Event::Log(format!("{connection_id}: {outcome}")));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("{connection_id}: {e}")));
                                }
                            }
                            let _ = tx.send(Event::Idle);
                            let _ = tx.send(Event::State(service.state()));
                        });
                    }
                    Action::Discover { connection_id } => {
                        tokio::spawn(async move {
                            let _ = tx.send(Event::Busy(format!(
                                "discovering agents on {connection_id}…"
                            )));
                            let result = async {
                                service.connect(&connection_id).await?;
                                service.application_discover(&connection_id, None).await
                            }
                            .await;
                            match result {
                                Ok(record) => {
                                    let _ = tx.send(Event::RemoteAgents {
                                        connection_id,
                                        agents: record.agents,
                                    });
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("discovery failed: {e}")));
                                }
                            }
                            let _ = tx.send(Event::Idle);
                        });
                    }
                    Action::OpCancel { operation_id } => {
                        tokio::spawn(async move {
                            match service.application_cancel(&operation_id).await {
                                Ok(record) => {
                                    let _ = tx.send(Event::Operation(Box::new(record)));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("cancel failed: {e}")));
                                }
                            }
                        });
                    }
                    Action::Permit {
                        operation_id,
                        permission_id,
                        resolution,
                    } => {
                        tokio::spawn(async move {
                            match service
                                .application_resolve_permission(
                                    &operation_id,
                                    &permission_id,
                                    resolution,
                                )
                                .await
                            {
                                Ok(record) => {
                                    let _ = tx.send(Event::Operation(Box::new(record)));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("permit failed: {e}")));
                                }
                            }
                        });
                    }
                    Action::RefreshAgents => {
                        tokio::spawn(async move {
                            if let Ok(agents) = service.local_agents().await {
                                let _ = tx.send(Event::LocalAgents(agents));
                            }
                        });
                    }
                    Action::EndpointRefresh => {
                        tokio::spawn(async move {
                            match service.endpoint_snapshot().await {
                                Ok(snap) => {
                                    let _ = tx.send(Event::Endpoint(Box::new(snap)));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Log(format!("endpoint: {e}")));
                                }
                            }
                        });
                    }
                    Action::EndpointStart => {
                        tokio::spawn(async move {
                            let _ = tx.send(Event::Busy("starting personal endpoint…".into()));
                            match service.endpoint_start().await {
                                Ok(snap) => {
                                    let _ = tx.send(Event::Endpoint(Box::new(snap)));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("endpoint start failed: {e}")));
                                }
                            }
                            let _ = tx.send(Event::Idle);
                        });
                    }
                    Action::EndpointStop => {
                        tokio::spawn(async move {
                            let _ = tx.send(Event::Busy("stopping personal endpoint…".into()));
                            if let Err(e) = service.endpoint_stop().await {
                                let _ = tx.send(Event::Error(format!("endpoint stop failed: {e}")));
                            }
                            if let Ok(snap) = service.endpoint_snapshot().await {
                                let _ = tx.send(Event::Endpoint(Box::new(snap)));
                            }
                            let _ = tx.send(Event::Idle);
                        });
                    }
                    Action::EndpointInvite => {
                        tokio::spawn(async move {
                            let _ = tx.send(Event::Busy("minting pairing invite…".into()));
                            match service.endpoint_invite().await {
                                Ok(invite) => {
                                    let _ = tx.send(Event::EndpointInviteReady {
                                        text: meshrix_entry_core::pairing::invite::encode_pairing_invite(&invite),
                                    });
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("invite failed: {e}")));
                                }
                            }
                            let _ = tx.send(Event::Idle);
                        });
                    }
                    Action::EndpointEnroll => {
                        tokio::spawn(async move {
                            let _ = tx.send(Event::Busy("enrolling personal endpoint…".into()));
                            let svc = service.clone();
                            let tx2 = tx.clone();
                            let driver: StepUpDriver = std::sync::Arc::new(move |request| {
                                let svc = svc.clone();
                                let tx2 = tx2.clone();
                                Box::pin(async move {
                                    let txn = svc.begin_endpoint_step_up(&request)?;
                                    let _ = tx2.send(Event::EndpointApprovalUrl {
                                        url: txn.browser_url.clone(),
                                        code: txn.user_code.clone(),
                                    });
                                    for _ in 0..150 {
                                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                                        match svc.poll_endpoint_step_up(&request, &txn)? {
                                            StepUpPoll::Pending => {}
                                            StepUpPoll::Expired | StepUpPoll::Consumed => {
                                                return Err(meshrix_entry_core::error::entry_error(
                                                    "account_step_up_expired",
                                                    "The personal route approval expired; start enrollment again.",
                                                ));
                                            }
                                            StepUpPoll::Complete { account, permit_id, target } => {
                                                return Ok(PersonalEndpointStepUpResult {
                                                    account,
                                                    permit_id,
                                                    target,
                                                });
                                            }
                                        }
                                    }
                                    Err(meshrix_entry_core::error::entry_error(
                                        "account_step_up_expired",
                                        "Timed out waiting for the personal route approval.",
                                    ))
                                }) as futures_util::future::LocalBoxFuture<
                                    'static,
                                    meshrix_entry_core::Result<PersonalEndpointStepUpResult>,
                                >
                            });
                            match service.endpoint_enroll(driver).await {
                                Ok(snap) => {
                                    let _ = tx.send(Event::Endpoint(Box::new(snap)));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("enroll failed: {e}")));
                                }
                            }
                            let _ = tx.send(Event::Idle);
                        });
                    }
                    Action::RecoveryRefresh => {
                        tokio::spawn(async move {
                            let _ = tx.send(Event::Recovery(service.recovery_view()));
                        });
                    }
                    Action::RecoveryBegin => {
                        tokio::spawn(async move {
                            match service.begin_recovery_setup() {
                                Ok(_) => {
                                    let _ = tx.send(Event::Recovery(service.recovery_view()));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("recovery begin failed: {e}")));
                                }
                            }
                        });
                    }
                    Action::RecoveryReveal => {
                        tokio::spawn(async move {
                            match service.reveal_recovery_key() {
                                Ok(view) => {
                                    let text = view
                                        .get("recoveryText")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or_default()
                                        .to_string();
                                    let _ = tx.send(Event::RecoveryReveal { text });
                                    let _ = tx.send(Event::Recovery(service.recovery_view()));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("reveal failed: {e}")));
                                }
                            }
                        });
                    }
                    Action::RecoveryConfirm => {
                        tokio::spawn(async move {
                            let _ = tx.send(Event::Busy("confirming recovery key…".into()));
                            match service.confirm_recovery_saved().await {
                                Ok(view) => {
                                    let _ = tx.send(Event::Recovery(view));
                                    // A managed vault now waits on browser authorization — poll it inline.
                                    for _ in 0..150 {
                                        match service.poll_vault_writer_step_up().await {
                                            Ok(meshrix_entry_core::service::VaultWriterStepUpPoll::Idle)
                                            | Ok(meshrix_entry_core::service::VaultWriterStepUpPoll::Complete) => break,
                                            Ok(meshrix_entry_core::service::VaultWriterStepUpPoll::Pending { browser_url, user_code }) => {
                                                let _ = tx.send(Event::WriterApprovalUrl { url: browser_url, code: user_code });
                                            }
                                            Ok(_) => break,
                                            Err(e) => {
                                                let _ = tx.send(Event::Error(format!("writer step-up failed: {e}")));
                                                break;
                                            }
                                        }
                                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                                    }
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("confirm failed: {e}")));
                                }
                            }
                            let _ = tx.send(Event::Recovery(service.recovery_view()));
                            let _ = tx.send(Event::Idle);
                        });
                    }
                    Action::RecoveryPublish => {
                        tokio::spawn(async move {
                            let _ = tx.send(Event::Busy("publishing recovery snapshot…".into()));
                            match service.publish_snapshot().await {
                                Ok(view) => {
                                    let _ = tx.send(Event::Recovery(view));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("publish failed: {e}")));
                                }
                            }
                            let _ = tx.send(Event::Idle);
                        });
                    }
                    Action::RecoveryRotate => {
                        tokio::spawn(async move {
                            let _ = tx.send(Event::Busy("staging recovery rotation…".into()));
                            match service.begin_recovery_rotation().await {
                                Ok(view) => {
                                    let _ = tx.send(Event::Recovery(view));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("rotation failed: {e}")));
                                }
                            }
                            let _ = tx.send(Event::Idle);
                        });
                    }
                    Action::RecoveryRetryWriter => {
                        tokio::spawn(async move {
                            match service.retry_vault_writer_registration().await {
                                Ok(view) => {
                                    let _ = tx.send(Event::Recovery(view));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("writer retry failed: {e}")));
                                }
                            }
                        });
                    }
                    Action::RecoveryPollWriter => {
                        tokio::spawn(async move {
                            for _ in 0..150 {
                                match service.poll_vault_writer_step_up().await {
                                    Ok(meshrix_entry_core::service::VaultWriterStepUpPoll::Idle) => break,
                                    Ok(meshrix_entry_core::service::VaultWriterStepUpPoll::Pending { browser_url, user_code }) => {
                                        let _ = tx.send(Event::WriterApprovalUrl { url: browser_url, code: user_code });
                                    }
                                    Ok(meshrix_entry_core::service::VaultWriterStepUpPoll::Expired)
                                    | Ok(meshrix_entry_core::service::VaultWriterStepUpPoll::Consumed) => {
                                        let _ = tx.send(Event::Error(
                                            "the writer authorization expired or was consumed".into(),
                                        ));
                                        break;
                                    }
                                    Ok(meshrix_entry_core::service::VaultWriterStepUpPoll::Complete) => {
                                        let _ = tx.send(Event::Recovery(service.recovery_view()));
                                        break;
                                    }
                                    Err(e) => {
                                        let _ = tx.send(Event::Error(format!("writer poll failed: {e}")));
                                        break;
                                    }
                                }
                                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                            }
                        });
                    }
                    Action::RecoveryRetryRotation => {
                        tokio::spawn(async move {
                            match service.retry_rotation_delivery().await {
                                Ok(view) => {
                                    let _ = tx.send(Event::Recovery(view));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("rotation retry failed: {e}")));
                                }
                            }
                        });
                    }
                    Action::RecoveryImport { text, service_url } => {
                        tokio::spawn(async move {
                            match service
                                .import_recovery_text(&text, service_url.as_deref(), None)
                                .await
                            {
                                Ok(phase) => {
                                    let _ = tx.send(Event::Log(format!("recovery import: {phase:?}")));
                                    let _ = tx.send(Event::Recovery(service.recovery_view()));
                                    let _ = tx.send(Event::State(service.state()));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("import failed: {e}")));
                                }
                            }
                        });
                    }
                    Action::RecoveryAbortRotation => {
                        tokio::spawn(async move {
                            match service.abort_rotation() {
                                Ok(view) => {
                                    let _ = tx.send(Event::Recovery(view));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::Error(format!("abort failed: {e}")));
                                }
                            }
                        });
                    }
                };
            }
        });
    }
    (
        Bridge {
            actions: action_tx,
            events: event_rx,
        },
        runtime,
    )
}

async fn login_flow(
    service: Arc<EntryService>,
    tx: mpsc::UnboundedSender<Event>,
) -> anyhow::Result<()> {
    let login = service.begin_account_login()?;
    let _ = tx.send(Event::LoginUrl {
        url: login.browser_url.clone(),
        code: login.user_code.clone(),
    });
    let _ = tx.send(Event::Busy("waiting for browser sign-in…".into()));
    for _ in 0..150 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        match service
            .poll_account_login(&login.transaction_id, &login.verifier)?
            .as_str()
        {
            "complete" => {
                let _ = tx.send(Event::Log("account signed in".into()));
                let _ = tx.send(Event::Idle);
                let _ = tx.send(Event::LoginFinished);
                let _ = tx.send(Event::State(service.state()));
                return Ok(());
            }
            "expired" | "consumed" => {
                let _ = tx.send(Event::Error("account transaction expired".into()));
                let _ = tx.send(Event::Idle);
                let _ = tx.send(Event::LoginFinished);
                return Ok(());
            }
            _ => {}
        }
    }
    let _ = tx.send(Event::Error("timed out waiting for sign-in".into()));
    let _ = tx.send(Event::Idle);
    let _ = tx.send(Event::LoginFinished);
    Ok(())
}

async fn pairing_flow(
    service: Arc<EntryService>,
    tx: mpsc::UnboundedSender<Event>,
    invite: String,
) {
    let _ = tx.send(Event::Busy("pairing: requesting challenge…".into()));
    let result = async {
        let mut flow = service.begin_pairing(&invite).await?;
        let challenge = service.pairing_challenge(&mut flow).await?;
        let _ = tx.send(Event::Log(format!("challenge issued: {challenge}")));
        let step_up = service.begin_pairing_step_up(&flow)?;
        let _ = tx.send(Event::PairingUrl {
            url: step_up.browser_url.clone(),
            code: step_up.user_code.clone(),
        });
        let _ = tx.send(Event::Busy("approve device pairing in the browser…".into()));
        let mut grant = None;
        for _ in 0..150 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            match service.poll_pairing_step_up(&flow, &step_up)? {
                StepUpPoll::Pending => {}
                StepUpPoll::Expired | StepUpPoll::Consumed => {
                    anyhow::bail!("the step-up approval expired; start pairing again");
                }
                StepUpPoll::Complete {
                    account,
                    permit_id,
                    target,
                } => {
                    grant = Some((account, permit_id, target));
                    break;
                }
            }
        }
        let Some((account, permit_id, target)) = grant else {
            anyhow::bail!("timed out waiting for step-up approval");
        };
        let _ = tx.send(Event::Busy("completing enrollment…".into()));
        let connection = service
            .complete_pairing(&mut flow, &account, &permit_id, &target)
            .await?;
        Ok::<String, anyhow::Error>(connection.connection_id)
    }
    .await;
    match result {
        Ok(connection_id) => {
            let _ = tx.send(Event::PairingDone { connection_id });
            let _ = tx.send(Event::State(service.state()));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("pairing failed: {e}")));
        }
    }
    let _ = tx.send(Event::Idle);
}

async fn connect_flow(
    service: Arc<EntryService>,
    tx: mpsc::UnboundedSender<Event>,
    connection_id: String,
) {
    let _ = tx.send(Event::Busy(format!("connecting {connection_id}…")));
    match service.connect(&connection_id).await {
        Ok(session) => {
            let _ = tx.send(Event::Log(format!("{connection_id}: session open")));
            let mut events = session.events();
            let id = connection_id.clone();
            let tx2 = tx.clone();
            tokio::spawn(async move {
                while events.changed().await.is_ok() {
                    let ev = events.borrow().clone();
                    let text = match &ev {
                        EntrySessionEvent::Admitted => "admitted".into(),
                        EntrySessionEvent::Ready => "ready".into(),
                        EntrySessionEvent::Rejected { reason, retryable } => {
                            format!("rejected: {reason} (retryable={retryable})")
                        }
                        EntrySessionEvent::RouteStatus {
                            state, generation, ..
                        } => {
                            format!("route {state} gen={generation}")
                        }
                        EntrySessionEvent::Closed { reason } => format!("closed: {reason}"),
                        EntrySessionEvent::ChannelLost { code, message } => {
                            format!("channel lost: {code} {message}")
                        }
                        EntrySessionEvent::OperationStatus(v) => {
                            format!(
                                "operation: {}",
                                serde_json::to_string(v).unwrap_or_default()
                            )
                        }
                    };
                    if tx2
                        .send(Event::Session {
                            connection_id: id.clone(),
                            event: text,
                        })
                        .is_err()
                    {
                        return;
                    }
                }
            });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("{connection_id}: {e}")));
        }
    }
    let _ = tx.send(Event::Idle);
    let _ = tx.send(Event::State(service.state()));
}

// ── UI ──────────────────────────────────────────────────────────────────────

use theme::Role;
use theme::{
    banner_frame, button, disclosure, grow, iconbtn, label, link_btn, rt,
    section_label, srow, status_pill, Btn, Icon, Lead,
};

/// Right-pane routing — the sidebar is a pure index; every row selects a page.
#[derive(Clone, Copy, PartialEq)]
enum Page {
    Connection,
    Agents,
    Endpoint,
    Recovery,
    Activity,
}

struct App {
    bridge: Bridge,
    state: Option<ServiceState>,
    busy: Option<String>,
    invite: String,
    login_url: Option<String>,
    login_code: Option<String>,
    pairing_url: Option<String>,
    pairing_code: Option<String>,
    recovery_target: Option<String>,
    recovery_text: String,
    logs: Vec<String>,
    /// Latest action error — surfaced as a dismissible banner so a failed
    /// button never looks like a dead one.
    last_error: Option<String>,
    /// Remote agent catalogs keyed by connection_id.
    remote_agents: std::collections::HashMap<String, Vec<AcpAgentSummary>>,
    /// Durable operation records keyed by operation_id (latest revision).
    operations: std::collections::HashMap<String, PeerApplicationRecord>,
    local_agents: Vec<AcpAgentSummary>,
    /// Personal endpoint snapshot (this device hosting paired peers).
    endpoint: Option<PersonalEndpointSnapshot>,
    /// Fresh invite text awaiting copy.
    endpoint_invite: Option<String>,
    /// Redacted recovery view + the one-shot reveal text (memory only).
    recovery: Option<serde_json::Value>,
    recovery_reveal: Option<String>,
    show_import: bool,
    import_text: String,
    /// Right-pane page; `selected_connection` feeds the Connection page.
    page: Page,
    selected_connection: Option<String>,
    ops_collapsed: bool,
    ops_show_all: bool,
    /// Modal sheet state.
    show_pairing: bool,
    show_account: bool,
    /// Appearance the style was last applied for (follows the system).
    dark: Option<bool>,
    /// Repository logo mark (accent tile + gateway), kept alive for painter use.
    logo: Option<egui::TextureHandle>,
}

impl App {
    fn new(bridge: Bridge, logo: Option<egui::TextureHandle>) -> Self {
        // Prime the device-side summaries so the sidebar tails are real.
        let _ = bridge.actions.send(Action::EndpointRefresh);
        let _ = bridge.actions.send(Action::RecoveryRefresh);
        let _ = bridge.actions.send(Action::RefreshAgents);
        Self {
            logo,
            bridge,
            state: None,
            busy: None,
            invite: String::new(),
            login_url: None,
            login_code: None,
            pairing_url: None,
            pairing_code: None,
            recovery_target: None,
            recovery_text: String::new(),
            logs: Vec::new(),
            last_error: None,
            remote_agents: Default::default(),
            operations: Default::default(),
            local_agents: Vec::new(),
            endpoint: None,
            endpoint_invite: None,
            recovery: None,
            recovery_reveal: None,
            show_import: false,
            import_text: String::new(),
            page: Page::Connection,
            selected_connection: None,
            ops_collapsed: false,
            ops_show_all: false,
            show_pairing: false,
            show_account: false,
            dark: None,
        }
    }

    fn send(&self, action: Action) {
        let _ = self.bridge.actions.send(action);
    }

    fn drain_events(&mut self) {
        while let Ok(ev) = self.bridge.events.try_recv() {
            match ev {
                Event::State(s) => {
                    if s.account_signed_in {
                        self.login_url = None;
                        self.login_code = None;
                    } else {
                        self.show_account = false;
                    }
                    if let Some(sel) = &self.selected_connection {
                        if !s.connections.iter().any(|c| &c.connection_id == sel) {
                            self.selected_connection = None;
                        }
                    }
                    if self.selected_connection.is_none() {
                        self.selected_connection =
                            s.connections.first().map(|c| c.connection_id.clone());
                    }
                    self.state = Some(s);
                }
                Event::Busy(m) => {
                    self.busy = Some(m);
                    self.last_error = None;
                }
                Event::Idle => self.busy = None,
                Event::Log(m) => self.push_log(m),
                Event::Error(m) => {
                    self.last_error = Some(m.clone());
                    self.push_log(format!("error: {m}"));
                }
                Event::LoginFinished => {
                    self.login_url = None;
                    self.login_code = None;
                }
                Event::LoginUrl { url, code } => {
                    self.login_url = Some(url.clone());
                    self.login_code = Some(code.clone());
                    self.push_log(format!("sign-in code {code} — approve in the browser"));
                    let _ = open_url(&url);
                }
                Event::PairingUrl { url, code } => {
                    self.pairing_url = Some(url.clone());
                    self.pairing_code = Some(code.clone());
                    self.push_log(format!("approve device pairing in the browser (code {code})"));
                    let _ = open_url(&url);
                }
                Event::PairingDone { connection_id } => {
                    self.pairing_url = None;
                    self.pairing_code = None;
                    self.invite.clear();
                    self.show_pairing = false;
                    self.selected_connection = Some(connection_id.clone());
                    self.page = Page::Connection;
                    self.push_log(format!("enrolled: {connection_id}"));
                }
                Event::Session {
                    connection_id,
                    event,
                } => {
                    self.push_log(format!("{connection_id}: {event}"));
                    self.send(Action::Refresh);
                }
                Event::RemoteAgents {
                    connection_id,
                    agents,
                } => {
                    // Discovery feed events carry the route's local device id;
                    // direct discover replies carry the connection id itself.
                    let key = if connection_id.is_empty() {
                        self.selected_connection.clone().unwrap_or_default()
                    } else {
                        self.state
                            .as_ref()
                            .and_then(|s| {
                                s.connections
                                    .iter()
                                    .find(|c| {
                                        c.connection_id == connection_id
                                            || c.device_id == connection_id
                                    })
                                    .map(|c| c.connection_id.clone())
                            })
                            .unwrap_or(connection_id)
                    };
                    if !key.is_empty() {
                        self.remote_agents.insert(key.clone(), agents);
                        self.push_log(format!(
                            "{key}: {} remote agent(s)",
                            self.remote_agents.get(&key).map(|v| v.len()).unwrap_or(0)
                        ));
                    }
                }
                Event::Operation(record) => {
                    if let Some(p) = &record.permission {
                        if p.status == "pending" {
                            self.push_log(format!(
                                "{}: permission requested — {}",
                                record.operation_id, p.request.tool_call.title
                            ));
                        }
                    }
                    if matches!(record.status.as_str(), "completed" | "failed" | "cancelled") {
                        self.push_log(format!("{}: {}", record.operation_id, record.status));
                    }
                    self.operations.insert(record.operation_id.clone(), *record);
                }
                Event::LocalAgents(agents) => {
                    self.local_agents = agents;
                }
                Event::Endpoint(snapshot) => {
                    self.endpoint = Some(*snapshot);
                }
                Event::EndpointApprovalUrl { url, code } => {
                    self.pairing_url = Some(url.clone());
                    self.pairing_code = Some(code.clone());
                    self.push_log(format!("approve the personal route in the browser (code {code})"));
                    let _ = open_url(&url);
                }
                Event::EndpointInviteReady { text } => {
                    self.endpoint_invite = Some(text);
                }
                Event::Recovery(view) => {
                    self.recovery = Some(view);
                }
                Event::RecoveryReveal { text } => {
                    self.recovery_reveal = Some(text);
                }
                Event::WriterApprovalUrl { url, code } => {
                    self.pairing_url = Some(url.clone());
                    self.pairing_code = Some(code.clone());
                    self.push_log(format!("approve the vault writer in the browser (code {code})"));
                    let _ = open_url(&url);
                }
            }
        }
    }

    fn push_log(&mut self, line: String) {
        self.logs.push(line);
        if self.logs.len() > 400 {
            self.logs.drain(..self.logs.len() - 400);
        }
    }
}

fn open_url(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())?;
    Ok(())
}

/// Map a session state string onto a semantic tone.
fn session_tone(state: Option<&str>, re_pair: bool, t: &theme::Tokens) -> egui::Color32 {
    if re_pair {
        return t.orange;
    }
    match state.unwrap_or("idle") {
        s if s.contains("ready") || s.contains("admit") || s.contains("open") => t.green,
        s if s.contains("reject")
            || s.contains("fail")
            || s.contains("lost")
            || s.contains("closed") =>
        {
            t.red
        }
        "idle" => t.neutral,
        _ => t.orange,
    }
}

fn op_tone(status: &str, t: &theme::Tokens) -> egui::Color32 {
    match status {
        "completed" => t.green,
        "failed" => t.red,
        "cancelled" => t.neutral,
        _ => t.orange,
    }
}

/// Compact status word rendered at the tail of a sidebar connection row.
fn short_state(state: Option<&str>, re_pair: bool) -> &'static str {
    if re_pair {
        return "re-pair";
    }
    match state.unwrap_or("offline") {
        s if s.contains("ready") || s.contains("admit") || s.contains("open") => "ready",
        s if s.contains("reject")
            || s.contains("fail")
            || s.contains("lost")
            || s.contains("closed") =>
        {
            "offline"
        }
        "idle" => "idle",
        _ => "connecting",
    }
}

/// `HH:MM` slice of an ISO-8601 timestamp for compact metadata lines.
fn hm(iso: &str) -> &str {
    iso.get(11..16).unwrap_or("")
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain_events();

        let dark = ctx.theme() == egui::Theme::Dark;
        if self.dark != Some(dark) {
            theme::apply_style(ctx, dark);
            self.dark = Some(dark);
        }
        let t = theme::tokens(dark);

        self.toolbar(ctx, &t);
        self.sidebar(ctx, &t);
        self.central(ctx, &t);
        self.sheets(ctx, &t);

        // Poll the worker event queue on a cadence — cheap when empty.
        ctx.request_repaint_after(std::time::Duration::from_millis(250));
    }
}

impl App {
    /// Slim toolbar under the native title bar: brand on the leading side,
    /// global status + refresh on the trailing side.
    fn toolbar(&mut self, ctx: &egui::Context, t: &theme::Tokens) {
        egui::TopBottomPanel::top("toolbar")
            .exact_height(44.0)
            .frame(
                egui::Frame::new()
                    .fill(t.toolbar_bg)
                    .inner_margin(egui::Margin::symmetric(16, 0)),
            )
            .show(ctx, |ui| {
                theme::hairline_bottom(ui, t);
                ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| {
                    if let Some(logo) = &self.logo {
                        ui.add(egui::Image::new(egui::load::SizedTexture::new(
                            logo.id(),
                            egui::Vec2::splat(24.0),
                        )));
                    }
                    ui.add_space(9.0);
                    label(ui, "Meshrix Entry", Role::Headline, t.label);

                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if iconbtn(ui, t, Icon::Refresh, self.busy.is_none()).clicked() {
                            self.send(Action::Refresh);
                        }
                        if let Some(busy) = self.busy.clone() {
                            ui.add_space(4.0);
                            label(ui, busy, Role::Callout, t.secondary_label);
                            ui.add(egui::Spinner::new().size(14.0).color(t.accent));
                            ui.add_space(6.0);
                        } else if let Some(s) = &self.state {
                            let n = s
                                .connections
                                .iter()
                                .filter(|c| {
                                    matches!(
                                        c.session_state.as_deref(),
                                        Some(s) if s.contains("ready") || s.contains("admit")
                                    )
                                })
                                .count();
                            status_pill(
                                ui,
                                if n > 0 { t.green } else { t.neutral },
                                &if n > 0 {
                                    format!("{n} live")
                                } else {
                                    "offline".into()
                                },
                            );
                            ui.add_space(4.0);
                        }
                    });
                });
            });
    }

    /// Source-list sidebar: account row, connection entities, device pages.
    fn sidebar(&mut self, ctx: &egui::Context, t: &theme::Tokens) {
        egui::SidePanel::left("sidebar")
            .resizable(true)
            .default_width(220.0)
            .width_range(200.0..=260.0)
            .frame(
                egui::Frame::new()
                    .fill(t.sidebar_bg)
                    .inner_margin(egui::Margin::symmetric(8, 10)),
            )
            .show(ctx, |ui| {
                let bottom_h = 44.0;
                egui::ScrollArea::vertical()
                    .auto_shrink([false, true])
                    .max_height((ui.available_height() - bottom_h).max(120.0))
                    .show(ui, |ui| {
                        self.sidebar_account(ui, t);
                        self.sidebar_connections(ui, t);
                        ui.add_space(10.0);
                        self.sidebar_device(ui, t);
                    });
                ui.add_space(6.0);
                let w = ui.available_width();
                let (sep, _) =
                    ui.allocate_exact_size(egui::Vec2::new(w, 1.0), egui::Sense::hover());
                ui.painter().hline(
                    sep.x_range(),
                    sep.center().y,
                    egui::Stroke::new(1.0, t.hairline),
                );
                ui.add_space(6.0);
                let selected = self.page == Page::Activity;
                if srow(
                    ui,
                    t,
                    selected,
                    Lead::Icon(Icon::Activity),
                    "Activity",
                    None,
                    &format!("{}", self.logs.len()),
                )
                .clicked()
                {
                    self.page = Page::Activity;
                }
            });
    }

    /// Account identity row — click to sign in, or reopen the pending
    /// browser approval page.
    fn sidebar_account(&mut self, ui: &mut egui::Ui, t: &theme::Tokens) {
        let signed_in = self
            .state
            .as_ref()
            .map(|s| s.account_signed_in)
            .unwrap_or(false);
        let profile = self
            .state
            .as_ref()
            .map(|s| s.profile_label.clone())
            .unwrap_or_default();
        let pending_url = self.login_url.clone();
        let email = self
            .state
            .as_ref()
            .and_then(|s| s.account_email.clone())
            .filter(|e| !e.is_empty());

        let title = if signed_in {
            email.clone().unwrap_or_else(|| "Signed In".to_owned())
        } else {
            "Not Signed In".to_owned()
        };
        let (sub, sub_col) = if pending_url.is_some() {
            (self.login_code.clone().map(|c| format!("Code {c}")).unwrap_or_else(|| "Approve in browser…".into()), t.accent)
        } else if signed_in {
            let device = self
                .state
                .as_ref()
                .map(|s| s.device_label.clone())
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| "This device".to_owned());
            (device, t.tertiary_label)
        } else {
            ("Sign in".to_owned(), t.tertiary_label)
        };
        let letter_src = if signed_in { email.as_deref().unwrap_or(&profile) } else { &profile };
        let letter = letter_src
            .chars()
            .next()
            .map(|c| c.to_uppercase().to_string())
            .unwrap_or_else(|| "?".into());

        let width = ui.available_width();
        let (rect, resp) =
            ui.allocate_exact_size(egui::Vec2::new(width, 42.0), egui::Sense::click());
        if resp.hovered() {
            ui.painter()
                .rect_filled(rect, egui::CornerRadius::same(7), t.hover_fill);
            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        }
        let p = ui.painter();
        let cy = rect.center().y;
        let avatar_c = egui::Pos2::new(rect.left() + 22.0, cy);
        p.circle_filled(
            avatar_c,
            14.0,
            if signed_in { t.accent } else { t.neutral },
        );
        p.text(
            avatar_c,
            egui::Align2::CENTER_CENTER,
            letter,
            egui::FontId::new(12.0, egui::FontFamily::Name("text-semibold".into())),
            egui::Color32::WHITE,
        );
        let tx = rect.left() + 46.0;
        let text_w = (rect.right() - tx - 8.0).max(24.0);
        p.text(
            egui::Pos2::new(tx, cy - 8.0),
            egui::Align2::LEFT_CENTER,
            theme::ellipsize(ui, &title, Role::BodyMedium, text_w),
            Role::BodyMedium.font(),
            t.label,
        );
        p.text(
            egui::Pos2::new(tx, cy + 9.0),
            egui::Align2::LEFT_CENTER,
            theme::ellipsize(ui, &sub, Role::Footnote, text_w),
            Role::Footnote.font(),
            sub_col,
        );
        if resp.clicked() {
            if let Some(url) = &pending_url {
                let _ = open_url(url);
            } else if signed_in {
                self.show_account = true;
            } else if self.busy.is_none() {
                self.send(Action::BeginLogin);
            }
        }
        ui.add_space(4.0);
    }

    fn sidebar_connections(&mut self, ui: &mut egui::Ui, t: &theme::Tokens) {
        ui.add_space(12.0);
        ui.horizontal(|ui| {
            ui.add_space(10.0);
            section_label(ui, t, "Connections");
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.add_space(4.0);
                if iconbtn(ui, t, Icon::Plus, self.busy.is_none()).clicked() {
                    self.show_pairing = true;
                }
            });
        });
        ui.add_space(5.0);
        let connections = self
            .state
            .as_ref()
            .map(|s| s.connections.clone())
            .unwrap_or_default();
        if connections.is_empty() {
            ui.horizontal(|ui| {
                ui.add_space(10.0);
                label(ui, "No endpoints paired.", Role::Footnote, t.tertiary_label);
            });
            ui.add_space(4.0);
        }
        for c in connections {
            let selected =
                self.page == Page::Connection && self.selected_connection.as_deref() == Some(&c.connection_id);
            let tone = session_tone(c.session_state.as_deref(), c.re_pair_required, t);
            let row = srow(
                ui,
                t,
                selected,
                Lead::Dot(tone),
                &c.display_label,
                None,
                short_state(c.session_state.as_deref(), c.re_pair_required),
            );
            row.context_menu(|ui| {
                if ui.button("Remove").clicked() {
                    self.send(Action::RemoveConnection {
                        connection_id: c.connection_id.clone(),
                    });
                    if self.selected_connection.as_deref() == Some(c.connection_id.as_str()) {
                        self.selected_connection = None;
                        self.page = Page::Connection;
                    }
                    ui.close();
                }
            });
            if row.clicked() {
                self.page = Page::Connection;
                self.selected_connection = Some(c.connection_id.clone());
                self.ops_show_all = false;
            }
            ui.add_space(1.0);
        }
    }

    /// Device-side pages — this device hosting paired peers.
    fn sidebar_device(&mut self, ui: &mut egui::Ui, t: &theme::Tokens) {
        ui.add_space(12.0);
        ui.horizontal(|ui| {
            ui.add_space(10.0);
            section_label(ui, t, "This Device");
        });
        ui.add_space(5.0);

        if srow(
            ui,
            t,
            self.page == Page::Agents,
            Lead::Icon(Icon::Agents),
            "Agents",
            None,
            &format!("{}", self.local_agents.len()),
        )
        .clicked()
        {
            self.page = Page::Agents;
        }
        ui.add_space(1.0);

        let (edot, eword) = match &self.endpoint {
            None => (t.neutral, "off"),
            Some(s) => match s.state.as_str() {
                "connected" => (t.green, "on"),
                "unregistered" | "revoked" => (t.neutral, "off"),
                _ => (t.orange, "setup"),
            },
        };
        if srow(
            ui,
            t,
            self.page == Page::Endpoint,
            Lead::Icon(Icon::Endpoint),
            "Endpoint",
            Some(edot),
            eword,
        )
        .clicked()
        {
            self.page = Page::Endpoint;
            self.send(Action::EndpointRefresh);
        }
        ui.add_space(1.0);

        let rstate = self
            .recovery
            .as_ref()
            .and_then(|v| v.get("state"))
            .and_then(|v| v.as_str())
            .unwrap_or("not_configured");
        let (rdot, rword) = match rstate {
            "ready" => (t.green, "ready"),
            "not_configured" => (t.neutral, "setup"),
            _ => (t.orange, "action"),
        };
        if srow(
            ui,
            t,
            self.page == Page::Recovery,
            Lead::Icon(Icon::Recovery),
            "Recovery",
            Some(rdot),
            rword,
        )
        .clicked()
        {
            self.page = Page::Recovery;
            if self.recovery.is_none() {
                self.send(Action::RecoveryRefresh);
            }
        }
    }

    fn central(&mut self, ctx: &egui::Context, t: &theme::Tokens) {
        egui::CentralPanel::default()
            .frame(
                egui::Frame::new()
                    .fill(t.window_bg)
                    .inner_margin(egui::Margin::symmetric(26, 20)),
            )
            .show(ctx, |ui| {
                // Action errors surface where the action was taken — a button
                // that fails must visibly say why, not only log to Activity.
                if let Some(err) = self.last_error.clone() {
                    banner_frame(t).show(ui, |ui| {
                        ui.horizontal(|ui| {
                            label(ui, err, Role::Callout, t.label);
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    if ui.link("Dismiss").clicked() {
                                        self.last_error = None;
                                    }
                                },
                            );
                        });
                    });
                    ui.add_space(10.0);
                }
                egui::ScrollArea::vertical()
                    .auto_shrink([false, true])
                    .show(ui, |ui| {
                        ui.set_max_width(ui.available_width().min(720.0));
                        match self.page {
                            Page::Connection => match self.selected_connection.clone() {
                                Some(id) => self.connection_detail(ui, t, &id),
                                None => self.empty_state(ui, t),
                            },
                            Page::Agents => self.agents_page(ui, t),
                            Page::Endpoint => self.endpoint_page(ui, t),
                            Page::Recovery => self.recovery_page(ui, t),
                            Page::Activity => self.activity_page(ui, t),
                        }
                    });
            });
    }

    /// Page scaffold: section label + optional trailing action + group frame.
    fn group_head(
        &mut self,
        ui: &mut egui::Ui,
        t: &theme::Tokens,
        text: &str,
        tail: impl FnOnce(&mut App, &mut egui::Ui, &theme::Tokens),
    ) {
        ui.add_space(22.0);
        ui.horizontal(|ui| {
            ui.add_space(12.0);
            section_label(ui, t, text);
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.add_space(10.0);
                tail(self, ui, t);
            });
        });
        ui.add_space(6.0);
    }

    fn empty_state(&mut self, ui: &mut egui::Ui, t: &theme::Tokens) {
        ui.add_space(ui.available_height() * 0.22);
        ui.vertical_centered(|ui| {
            if let Some(logo) = &self.logo {
                ui.add(egui::Image::new(egui::load::SizedTexture::new(
                    logo.id(),
                    egui::Vec2::splat(56.0),
                )));
            }
            ui.add_space(14.0);
            label(ui, "Meshrix Entry", Role::Title2, t.label);
            ui.add_space(4.0);
            let has_connections = self
                .state
                .as_ref()
                .map(|s| !s.connections.is_empty())
                .unwrap_or(false);
            label(
                ui,
                if has_connections {
                    "Select a connection in the sidebar."
                } else {
                    "Pair an endpoint to reach its agents over the private relay."
                },
                Role::Body,
                t.secondary_label,
            );
            ui.add_space(14.0);
            if !has_connections
                && button(ui, t, "Pair Endpoint…", Btn::Primary, self.busy.is_none()).clicked()
            {
                self.show_pairing = true;
            }
        });
    }

    fn connection_detail(&mut self, ui: &mut egui::Ui, t: &theme::Tokens, id: &str) {
        let conn = match self.state.as_ref().and_then(|s| {
            s.connections
                .iter()
                .find(|c| c.connection_id == id)
                .cloned()
        }) {
            Some(c) => c,
            None => {
                label(
                    ui,
                    "connection no longer exists",
                    Role::Body,
                    t.secondary_label,
                );
                return;
            }
        };

        ui.horizontal(|ui| {
            // Reserve room for the status pills so a long principal id ends
            // with "…" instead of running past the panel edge.
            let reserve = 130.0 + if conn.re_pair_required { 130.0 } else { 0.0 };
            let title = theme::ellipsize(
                ui,
                &conn.display_label,
                Role::Title2,
                (ui.available_width() - reserve).max(80.0),
            );
            label(ui, title, Role::Title2, t.label);
            ui.add_space(10.0);
            let session = conn
                .session_state
                .clone()
                .unwrap_or_else(|| "offline".into());
            status_pill(
                ui,
                session_tone(conn.session_state.as_deref(), conn.re_pair_required, t),
                &session,
            );
            if conn.re_pair_required {
                status_pill(ui, t.orange, "re-pair required");
            }
        });
        ui.add_space(14.0);
        ui.horizontal(|ui| {
            let live = matches!(
                conn.session_state.as_deref(),
                Some(s) if s.contains("ready") || s.contains("admit")
            );
            if live {
                if button(ui, t, "Disconnect", Btn::Bordered, self.busy.is_none()).clicked() {
                    self.send(Action::Disconnect {
                        connection_id: id.to_owned(),
                    });
                }
            } else if button(ui, t, "Connect", Btn::Primary, self.busy.is_none()).clicked() {
                self.send(Action::Connect {
                    connection_id: id.to_owned(),
                });
            }
            if button(ui, t, "Recover…", Btn::Quiet, self.busy.is_none()).clicked() {
                self.recovery_target = Some(id.to_owned());
            }
        });

        let conn_device = conn.device_id.clone();
        let mut pending: Vec<PeerApplicationRecord> = self
            .operations
            .values()
            .filter(|op| {
                op.permission
                    .as_ref()
                    .map(|p| p.status == "pending")
                    .unwrap_or(false)
                    && (conn_device.is_empty()
                        || op.route_address.local_device_id == conn_device
                        || op.origin_address.local_device_id == conn_device)
            })
            .cloned()
            .collect();
        pending.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        if let Some(op) = pending.first() {
            ui.add_space(14.0);
            self.permission_banner(ui, t, op, pending.len());
        }

        // Remote agents — the capability catalog this link exposes.
        let conn_id = id.to_owned();
        self.group_head(ui, t, "Remote Agents", |app, ui, t| {
            if link_btn(ui, t, "Discover", app.busy.is_none()).clicked() {
                app.send(Action::Discover {
                    connection_id: conn_id.clone(),
                });
            }
        });
        let agents = self.remote_agents.get(id).cloned().unwrap_or_default();
        theme::group(ui, t, |ui| {
            if agents.is_empty() {
                grow(ui, t, true, |ui| {
                    label(
                        ui,
                        "Run discovery to list the agents hosted by this endpoint.",
                        Role::Callout,
                        t.tertiary_label,
                    );
                });
            }
            for (i, a) in agents.iter().enumerate() {
                grow(ui, t, i == 0, |ui| {
                    let (r, _) =
                        ui.allocate_exact_size(egui::Vec2::splat(7.0), egui::Sense::hover());
                    ui.painter().circle_filled(
                        r.center(),
                        3.5,
                        if a.enabled { t.green } else { t.tertiary_label },
                    );
                    ui.add_space(8.0);
                    label(
                        ui,
                        &a.display_name,
                        Role::BodyMedium,
                        if a.enabled { t.label } else { t.secondary_label },
                    );
                    ui.add_space(10.0);
                    let desc = a.description.clone().unwrap_or_else(|| a.id.clone());
                    let desc = if a.enabled {
                        desc
                    } else {
                        format!("{desc} · disabled")
                    };
                    let desc = theme::ellipsize(
                        ui,
                        &desc,
                        Role::Footnote,
                        ui.available_width().max(24.0),
                    );
                    label(ui, desc, Role::Footnote, t.tertiary_label);
                });
            }
        });

        // Operations ledger — bounded, collapsible.
        let mut ops: Vec<PeerApplicationRecord> = self
            .operations
            .values()
            .filter(|op| {
                conn_device.is_empty()
                    || op.route_address.local_device_id == conn_device
                    || op.origin_address.local_device_id == conn_device
            })
            .cloned()
            .collect();
        ops.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        let total = ops.len();

        ui.add_space(22.0);
        let mut collapsed = self.ops_collapsed;
        ui.horizontal(|ui| {
            ui.add_space(6.0);
            if disclosure(ui, t, !collapsed).clicked() {
                collapsed = !collapsed;
            }
            ui.add_space(6.0);
            section_label(ui, t, "Operations");
            if total > 0 {
                label(ui, format!("{total}"), Role::Caption, t.tertiary_label);
            }
        });
        self.ops_collapsed = collapsed;
        if collapsed {
            return;
        }
        ui.add_space(6.0);
        let limit = if self.ops_show_all { 20 } else { 3 };
        let visible = total.min(limit);
        theme::group(ui, t, |ui| {
            if ops.is_empty() {
                grow(ui, t, true, |ui| {
                    label(ui, "No operations yet.", Role::Callout, t.tertiary_label);
                });
                return;
            }
            for (i, op) in ops.iter().take(visible).enumerate() {
                grow(ui, t, i == 0, |ui| {
                    status_pill(ui, op_tone(&op.status, t), &op.status);
                    ui.add_space(6.0);
                    label(
                        ui,
                        &op.operation_id[..op.operation_id.len().min(10)],
                        Role::Mono,
                        t.secondary_label,
                    );
                    ui.add_space(8.0);
                    label(
                        ui,
                        format!("{} · {}", op.target_agent_id, hm(&op.created_at)),
                        Role::Footnote,
                        t.tertiary_label,
                    );
                    let running =
                        !matches!(op.status.as_str(), "completed" | "failed" | "cancelled");
                    if running {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if link_btn(ui, t, "Cancel", true).clicked() {
                                self.send(Action::OpCancel {
                                    operation_id: op.operation_id.clone(),
                                });
                            }
                        });
                    }
                });
            }
            if total > visible {
                let text = format!("Show all {total}");
                if self.more_row(ui, t, &text) {
                    self.ops_show_all = true;
                }
            } else if self.ops_show_all && total > 3 {
                if self.more_row(ui, t, "Show less") {
                    self.ops_show_all = false;
                }
            }
        });
    }

    /// Full-width centered action row closing a group — "Show all N".
    fn more_row(&mut self, ui: &mut egui::Ui, t: &theme::Tokens, text: &str) -> bool {
        let w = ui.available_width();
        let (sep, _) = ui.allocate_exact_size(egui::Vec2::new(w, 1.0), egui::Sense::hover());
        ui.painter().hline(
            sep.left() + 14.0..=sep.right(),
            sep.center().y,
            egui::Stroke::new(1.0, t.hairline),
        );
        let (rect, resp) =
            ui.allocate_exact_size(egui::Vec2::new(w, 30.0), egui::Sense::click());
        if resp.hovered() {
            ui.painter()
                .rect_filled(rect, egui::CornerRadius::ZERO, t.hover_fill);
            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        }
        ui.painter().text(
            rect.center(),
            egui::Align2::CENTER_CENTER,
            text,
            Role::Footnote.font(),
            t.accent,
        );
        resp.clicked()
    }

    /// Pending permission request — an approval banner above the groups,
    /// not buried in the operation ledger.
    fn permission_banner(
        &mut self,
        ui: &mut egui::Ui,
        t: &theme::Tokens,
        op: &PeerApplicationRecord,
        count: usize,
    ) {
        let Some(permission) = &op.permission else { return };
        let agent = self
            .remote_agents
            .values()
            .flatten()
            .find(|a| a.id == op.target_agent_id)
            .map(|a| a.display_name.clone())
            .unwrap_or_else(|| op.target_agent_id.clone());
        let title = permission.request.tool_call.title.clone();
        let options = permission.request.options.clone();
        let op_id = op.operation_id.clone();
        let perm_id = permission.id.clone();

        banner_frame(t).show(ui, |ui| {
            ui.horizontal(|ui| {
                let (r, _) =
                    ui.allocate_exact_size(egui::Vec2::splat(22.0), egui::Sense::hover());
                ui.painter().rect_filled(
                    r,
                    egui::CornerRadius::same(6),
                    egui::Color32::from_rgba_unmultiplied(0xff, 0x9f, 0x0a, 55),
                );
                ui.painter().text(
                    r.center(),
                    egui::Align2::CENTER_CENTER,
                    "!",
                    egui::FontId::new(13.0, egui::FontFamily::Name("text-bold".into())),
                    t.orange,
                );
                ui.add_space(12.0);
                ui.vertical(|ui| {
                    ui.horizontal(|ui| {
                        label(ui, "Permission requested", Role::Headline, t.orange);
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if count > 1 {
                                label(ui, format!("1 of {count}"), Role::Footnote, t.orange);
                            }
                        });
                    });
                    ui.add_space(2.0);
                    label(
                        ui,
                        format!("{agent} wants to run {title}"),
                        Role::Body,
                        t.label,
                    );
                    ui.add_space(9.0);
                    ui.horizontal_wrapped(|ui| {
                        for (i, option) in options.iter().enumerate() {
                            let kind = if i == 0 { Btn::Primary } else { Btn::Bordered };
                            if button(ui, t, &option.name, kind, true).clicked() {
                                self.send(Action::Permit {
                                    operation_id: op_id.clone(),
                                    permission_id: perm_id.clone(),
                                    resolution: AcpPermissionResolution::Selected {
                                        option_id: option.option_id.clone(),
                                    },
                                });
                            }
                        }
                        if button(ui, t, "Deny", Btn::Destructive, true).clicked() {
                            self.send(Action::Permit {
                                operation_id: op_id.clone(),
                                permission_id: perm_id.clone(),
                                resolution: AcpPermissionResolution::Cancelled,
                            });
                        }
                    });
                });
            });
        });
    }

    fn agents_page(&mut self, ui: &mut egui::Ui, t: &theme::Tokens) {
        label(ui, "Local Agents", Role::Title2, t.label);
        ui.add_space(5.0);
        label(
            ui,
            "Detected on this device — PATH CLIs and installed apps. ACP agents are callable by paired endpoints.",
            Role::Callout,
            t.secondary_label,
        );
        ui.add_space(14.0);
        if button(ui, t, "Rescan", Btn::Bordered, self.busy.is_none()).clicked() {
            self.send(Action::RefreshAgents);
        }
        ui.add_space(16.0);
        let agents = self.local_agents.clone();
        theme::group(ui, t, |ui| {
            if agents.is_empty() {
                grow(ui, t, true, |ui| {
                    label(ui, "No agents detected.", Role::Callout, t.tertiary_label);
                });
            }
            if !agents.is_empty() {
                // Painted rows — the layout-stack variant (`grow` + nested
                // horizontal + `with_layout`) inflates row height; fixed
                // rects match the sidebar row treatment.
                let row_h = 40.0;
                let w = ui.available_width();
                let (rect, _) = ui.allocate_exact_size(
                    egui::Vec2::new(w, row_h * agents.len() as f32),
                    egui::Sense::hover(),
                );
                let p = ui.painter();
                for (i, a) in agents.iter().enumerate() {
                    let callable = a.transport.as_deref() == Some("acp");
                    let dot_tone = if a.enabled && callable {
                        t.green
                    } else if a.enabled {
                        t.orange
                    } else {
                        t.tertiary_label
                    };
                    let (pill_text, pill_tone) = if callable && a.enabled {
                        ("acp", t.green)
                    } else if a.detected.is_some() {
                        ("detected", t.neutral)
                    } else if a.enabled {
                        ("enabled", t.green)
                    } else {
                        ("disabled", t.neutral)
                    };
                    let source = match a.detected.as_deref() {
                        Some("cli") => "CLI",
                        Some("desktop") => "App",
                        Some("cli+desktop") => "CLI + App",
                        Some(_) => "Detected",
                        None => "Registered",
                    };
                    let top = rect.top() + i as f32 * row_h;
                    let cy = top + row_h * 0.5;
                    if i > 0 {
                        p.hline(
                            rect.left() + 14.0..=rect.right(),
                            top,
                            egui::Stroke::new(1.0, t.hairline),
                        );
                    }
                    p.circle_filled(egui::Pos2::new(rect.left() + 18.0, cy), 3.5, dot_tone);
                    let name_tone = if a.enabled { t.label } else { t.secondary_label };
                    let pg = p.layout_no_wrap(
                        pill_text.to_string(),
                        Role::Caption.font(),
                        pill_tone,
                    );
                    let pw = pg.size().x + 20.0;
                    let ph = pg.size().y + 6.0;
                    let pr = egui::Rect::from_min_size(
                        egui::Pos2::new(rect.right() - 14.0 - pw, cy - ph * 0.5),
                        egui::Vec2::new(pw, ph),
                    );
                    let mut x = rect.left() + 32.0;
                    let name_budget = (pr.left() - 8.0 - x).max(24.0);
                    let name_g = p.layout_no_wrap(
                        theme::ellipsize(
                            ui,
                            &a.display_name,
                            Role::BodyMedium,
                            name_budget,
                        ),
                        Role::BodyMedium.font(),
                        name_tone,
                    );
                    p.galley(
                        egui::Pos2::new(x, cy - name_g.size().y * 0.5),
                        name_g.clone(),
                        name_tone,
                    );
                    x += name_g.size().x + 8.0;
                    let src_g = p.layout_no_wrap(
                        theme::ellipsize(
                            ui,
                            source,
                            Role::Caption,
                            (pr.left() - 8.0 - x).max(0.0),
                        ),
                        Role::Caption.font(),
                        t.tertiary_label,
                    );
                    p.galley(
                        egui::Pos2::new(x, cy - src_g.size().y * 0.5),
                        src_g,
                        t.tertiary_label,
                    );
                    p.rect_filled(
                        pr,
                        egui::CornerRadius::same((ph * 0.5).round() as u8),
                        theme::soft(pill_tone),
                    );
                    p.circle_filled(egui::Pos2::new(pr.left() + 9.0, cy), 2.5, pill_tone);
                    p.galley(
                        egui::Pos2::new(pr.left() + 15.0, cy - pg.size().y * 0.5),
                        pg,
                        pill_tone,
                    );
                }
            }
        });
    }

    fn endpoint_page(&mut self, ui: &mut egui::Ui, t: &theme::Tokens) {
        let snap = self.endpoint.clone();
        let (tone, word) = match &snap {
            None => (t.neutral, "off".to_owned()),
            Some(s) => match s.state.as_str() {
                "connected" => (t.green, "connected".to_owned()),
                "unregistered" | "revoked" => (t.neutral, "off".to_owned()),
                other => (t.orange, other.to_owned()),
            },
        };
        ui.horizontal(|ui| {
            label(ui, "Personal Endpoint", Role::Title2, t.label);
            ui.add_space(10.0);
            status_pill(ui, tone, &word);
        });
        ui.add_space(5.0);
        label(
            ui,
            match snap.as_ref().map(|s| s.state.as_str()) {
                Some("connected") => "Accepting work from paired clients.",
                Some("unregistered") | Some("revoked") => {
                    "Enroll this device to host agents for paired clients."
                }
                _ => "This device acting as a relay-side endpoint.",
            },
            Role::Callout,
            t.secondary_label,
        );
        ui.add_space(14.0);
        ui.horizontal(|ui| {
            match &snap {
                None => {
                    if button(ui, t, "Load", Btn::Primary, self.busy.is_none()).clicked() {
                        self.send(Action::EndpointRefresh);
                    }
                }
                Some(s) => {
                    let enabled = self.busy.is_none();
                    match s.state.as_str() {
                        "unregistered" | "revoked" => {
                            if button(ui, t, "Enroll…", Btn::Primary, enabled).clicked() {
                                self.send(Action::EndpointEnroll);
                            }
                        }
                        _ => {
                            if s.accepts_new_work {
                                if button(ui, t, "Stop", Btn::Bordered, enabled).clicked() {
                                    self.send(Action::EndpointStop);
                                }
                            } else if button(ui, t, "Start", Btn::Primary, enabled).clicked()
                            {
                                self.send(Action::EndpointStart);
                            }
                        }
                    }
                    if s.state != "unregistered"
                        && button(ui, t, "Invite…", Btn::Quiet, enabled).clicked()
                    {
                        self.send(Action::EndpointInvite);
                    }
                }
            }
        });

        if let Some(text) = self.endpoint_invite.clone() {
            self.group_head(ui, t, "Invite", |app, ui, t| {
                if link_btn(ui, t, "Dismiss", true).clicked() {
                    app.endpoint_invite = None;
                }
            });
            theme::group(ui, t, |ui| {
                grow(ui, t, true, |ui| {
                    ui.vertical(|ui| {
                        label(
                            ui,
                            "Share this text with the operator pairing a new client:",
                            Role::Callout,
                            t.secondary_label,
                        );
                        ui.add_space(6.0);
                        ui.add(
                            egui::Label::new(rt(text, Role::MonoSmall, t.label))
                                .wrap()
                                .selectable(true),
                        );
                    });
                });
            });
        }
    }

    fn recovery_page(&mut self, ui: &mut egui::Ui, t: &theme::Tokens) {
        let view = self.recovery.clone();
        let Some(view) = view else {
            label(ui, "Recovery", Role::Title2, t.label);
            ui.add_space(5.0);
            label(
                ui,
                "Vault recovery for this install's paired connections.",
                Role::Callout,
                t.secondary_label,
            );
            ui.add_space(14.0);
            if button(ui, t, "Load", Btn::Primary, self.busy.is_none()).clicked() {
                self.send(Action::RecoveryRefresh);
            }
            return;
        };
        let state = view
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("not_configured")
            .to_owned();
        ui.horizontal(|ui| {
            label(ui, "Recovery", Role::Title2, t.label);
            ui.add_space(10.0);
            status_pill(
                ui,
                match state.as_str() {
                    "ready" => t.green,
                    "not_configured" => t.neutral,
                    _ => t.orange,
                },
                &state.replace('_', " "),
            );
        });
        ui.add_space(5.0);
        label(
            ui,
            match state.as_str() {
                "ready" => "A saved recovery key can restore this install's paired connections.",
                "not_configured" => "Set up recovery to protect paired connections.",
                "awaiting_save" => "Save the revealed key somewhere safe, then confirm.",
                "account_authorization_required" | "account_writer_pending" => {
                    "Waiting for account authorization in the browser."
                }
                _ => "The recovery vault is being updated.",
            },
            Role::Callout,
            t.secondary_label,
        );
        ui.add_space(14.0);
        ui.horizontal(|ui| {
            let enabled = self.busy.is_none();
            match state.as_str() {
                "not_configured" => {
                    if button(ui, t, "Set up", Btn::Primary, enabled).clicked() {
                        self.send(Action::RecoveryBegin);
                    }
                }
                "awaiting_save" => {
                    let revealed = view
                        .get("keyRevealed")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if !revealed
                        && button(ui, t, "Reveal key", Btn::Primary, enabled).clicked()
                    {
                        self.send(Action::RecoveryReveal);
                    }
                    if revealed
                        && button(ui, t, "I saved it", Btn::Primary, enabled).clicked()
                    {
                        self.send(Action::RecoveryConfirm);
                    }
                }
                "account_authorization_required" | "account_writer_pending" => {
                    if button(ui, t, "Check authorization", Btn::Bordered, enabled).clicked()
                    {
                        self.send(Action::RecoveryPollWriter);
                    }
                    if button(ui, t, "Retry", Btn::Quiet, enabled).clicked() {
                        self.send(Action::RecoveryRetryWriter);
                    }
                }
                _ => {
                    if button(ui, t, "Publish", Btn::Bordered, enabled).clicked() {
                        self.send(Action::RecoveryPublish);
                    }
                    if button(ui, t, "Rotate", Btn::Quiet, enabled).clicked() {
                        self.send(Action::RecoveryRotate);
                    }
                }
            }
            if view.get("rotation").is_some_and(|v| v.is_object()) {
                if button(ui, t, "Redeliver", Btn::Quiet, enabled).clicked() {
                    self.send(Action::RecoveryRetryRotation);
                }
                if button(ui, t, "Abort rotation", Btn::Quiet, enabled).clicked() {
                    self.send(Action::RecoveryAbortRotation);
                }
            }
            if button(ui, t, "Import fresh profile…", Btn::Quiet, enabled).clicked() {
                self.show_import = true;
            }
        });
    }

    fn activity_page(&mut self, ui: &mut egui::Ui, t: &theme::Tokens) {
        label(ui, "Activity", Role::Title2, t.label);
        ui.add_space(5.0);
        label(
            ui,
            "Session, pairing and device details for this run.",
            Role::Callout,
            t.secondary_label,
        );
        ui.add_space(16.0);
        theme::group(ui, t, |ui| {
            ui.add_space(10.0);
            for line in &self.logs {
                ui.horizontal(|ui| {
                    ui.add_space(14.0);
                    label(ui, line, Role::MonoSmall, t.secondary_label);
                });
                ui.add_space(3.0);
            }
            ui.add_space(7.0);
        });
    }

    /// Pairing + recovery sheets.
    fn sheets(&mut self, ctx: &egui::Context, t: &theme::Tokens) {
        if self.login_url.is_some() {
            let mut open = true;
            let modal = egui::Modal::new(egui::Id::new("login-sheet"))
                .backdrop_color(t.scrim)
                .frame(theme::sheet_frame(t))
                .show(ctx, |ui| {
                    ui.set_width(380.0);
                    ui.vertical_centered(|ui| {
                        label(ui, "Approve in Browser", Role::Title2, t.label);
                        ui.add_space(4.0);
                        label(
                            ui,
                            "A browser tab was opened for account.meshrix.io.\nConfirm this code there to sign in this device.",
                            Role::Callout,
                            t.secondary_label,
                        );
                        ui.add_space(16.0);
                        if let Some(code) = self.login_code.clone() {
                            ui.label(
                                egui::RichText::new(code)
                                    .font(egui::FontId::new(30.0, egui::FontFamily::Monospace))
                                    .color(t.label),
                            );
                        }
                        ui.add_space(14.0);
                        ui.horizontal(|ui| {
                            let gap = ui.spacing().item_spacing.x;
                            let button_width = |s: &str, font: egui::FontId| {
                                ui.fonts(|f| f.layout_no_wrap(s.to_owned(), font, t.label).size().x) + 28.0
                            };
                            let total = button_width("Cancel", Role::BodyMedium.font())
                                + button_width("Copy Code", Role::BodyMedium.font())
                                + button_width("Open Browser", Role::Headline.font())
                                + gap * 2.0;
                            ui.add_space(((ui.available_width() - total) / 2.0).max(0.0));
                            if button(ui, t, "Cancel", Btn::Quiet, true).clicked() {
                                open = false;
                            }
                            if button(ui, t, "Copy Code", Btn::Bordered, true).clicked() {
                                if let Some(code) = &self.login_code {
                                    ui.ctx().copy_text(code.clone());
                                    self.push_log("sign-in code copied".into());
                                }
                            }
                            if button(ui, t, "Open Browser", Btn::Primary, true).clicked() {
                                if let Some(url) = &self.login_url {
                                    let _ = open_url(url);
                                }
                            }
                        });
                    });
                });
            if modal.should_close() {
                open = false;
            }
            if !open {
                self.login_url = None;
                self.login_code = None;
            }
        }
        if self.show_account {
            let mut open = true;
            let email = self
                .state
                .as_ref()
                .and_then(|s| s.account_email.clone())
                .unwrap_or_default();
            let profile = self
                .state
                .as_ref()
                .map(|s| s.device_label.clone())
                .unwrap_or_default();
            let letter = email
                .chars()
                .next()
                .or_else(|| profile.chars().next())
                .map(|c| c.to_uppercase().to_string())
                .unwrap_or_else(|| "?".into());
            let modal = egui::Modal::new(egui::Id::new("account-sheet"))
                .backdrop_color(t.scrim)
                .frame(theme::sheet_frame(t))
                .show(ctx, |ui| {
                    ui.set_width(320.0);
                    ui.vertical_centered(|ui| {
                        ui.add_space(6.0);
                        let (rect, _) = ui.allocate_exact_size(
                            egui::Vec2::splat(56.0),
                            egui::Sense::hover(),
                        );
                        ui.painter().circle_filled(rect.center(), 28.0, t.accent);
                        ui.painter().text(
                            rect.center(),
                            egui::Align2::CENTER_CENTER,
                            letter,
                            egui::FontId::new(22.0, egui::FontFamily::Name("text-semibold".into())),
                            egui::Color32::WHITE,
                        );
                        ui.add_space(10.0);
                        label(
                            ui,
                            if email.is_empty() { "Account" } else { &email },
                            Role::Headline,
                            t.label,
                        );
                        if !profile.is_empty() {
                            label(ui, &profile, Role::Footnote, t.tertiary_label);
                        }
                        ui.add_space(18.0);
                        fn btn_w(ui: &egui::Ui, s: &str, font: egui::FontId, c: egui::Color32) -> f32 {
                            ui.fonts(|f| f.layout_no_wrap(s.to_owned(), font, c).size().x) + 28.0
                        }
                        let total = btn_w(ui, "Sign Out", Role::BodyMedium.font(), t.label)
                            + btn_w(ui, "Done", Role::BodyMedium.font(), t.label)
                            + ui.spacing().item_spacing.x;
                        ui.horizontal(|ui| {
                            ui.add_space(((ui.available_width() - total) / 2.0).max(0.0));
                            if button(ui, t, "Sign Out", Btn::Destructive, self.busy.is_none()).clicked() {
                                self.send(Action::SignOut);
                                open = false;
                            }
                            if button(ui, t, "Done", Btn::Bordered, true).clicked() {
                                open = false;
                            }
                        });
                    });
                });
            if modal.should_close() {
                open = false;
            }
            if !open {
                self.show_account = false;
            }
        }
        if self.show_pairing {
            let mut open = true;
            let modal = egui::Modal::new(egui::Id::new("pairing-sheet"))
                .backdrop_color(t.scrim)
                .frame(theme::sheet_frame(t))
                .show(ctx, |ui| {
                    ui.set_width(440.0);
                    label(ui, "Pair New Endpoint", Role::Title2, t.label);
                    ui.add_space(4.0);
                    label(
                        ui,
                        "Paste the invite text you received from the endpoint operator.",
                        Role::Callout,
                        t.secondary_label,
                    );
                    ui.add_space(10.0);
                    theme::input_frame(t).show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.add(
                            egui::TextEdit::multiline(&mut self.invite)
                                .desired_rows(4)
                                .desired_width(f32::INFINITY)
                                .hint_text(rt("meshrix-invite…", Role::Mono, t.tertiary_label))
                                .frame(false),
                        );
                    });
                    if let Some(url) = self.pairing_url.clone() {
                        ui.add_space(8.0);
                        if let Some(code) = self.pairing_code.clone() {
                            ui.horizontal(|ui| {
                                label(ui, "Device code:", Role::Footnote, t.secondary_label);
                                ui.label(
                                    egui::RichText::new(code.clone())
                                        .font(egui::FontId::new(20.0, egui::FontFamily::Monospace))
                                        .color(t.accent),
                                );
                                if ui
                                    .link(rt("Copy", Role::Footnote, t.accent))
                                    .clicked()
                                {
                                    ui.ctx().copy_text(code);
                                }
                            });
                        }
                        ui.horizontal(|ui| {
                            label(ui, "Approval required:", Role::Footnote, t.secondary_label);
                            if ui
                                .link(rt(url.as_str(), Role::Footnote, t.accent))
                                .clicked()
                            {
                                let _ = open_url(&url);
                            }
                        });
                    }
                    ui.add_space(12.0);
                    ui.allocate_ui_with_layout(egui::Vec2::new(ui.available_width(), 26.0), egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let can = !self.invite.trim().is_empty()
                            && self.busy.is_none()
                            && self
                                .state
                                .as_ref()
                                .map(|s| s.account_signed_in)
                                .unwrap_or(false);
                        if button(ui, t, "Pair", Btn::Primary, can).clicked() {
                            self.pairing_url = None;
                            self.send(Action::Pair {
                                invite: self.invite.trim().to_string(),
                            });
                        }
                        if button(ui, t, "Cancel", Btn::Quiet, true).clicked() {
                            open = false;
                        }
                    });
                    if !self
                        .state
                        .as_ref()
                        .map(|s| s.account_signed_in)
                        .unwrap_or(false)
                    {
                        ui.add_space(4.0);
                        label(
                            ui,
                            "Sign in first — pairing needs an account session.",
                            Role::Footnote,
                            t.orange,
                        );
                    }
                });
            if modal.should_close() {
                open = false;
            }
            self.show_pairing = open;
        }

        if let Some(target) = self.recovery_target.clone() {
            let mut open = true;
            let modal = egui::Modal::new(egui::Id::new("recovery-sheet"))
                .backdrop_color(t.scrim)
                .frame(theme::sheet_frame(t))
                .show(ctx, |ui| {
                    ui.set_width(440.0);
                    label(ui, "Recover Connection", Role::Title2, t.label);
                    ui.add_space(2.0);
                    label(
                        ui,
                        theme::ellipsize(ui, &target, Role::Mono, 420.0),
                        Role::Mono,
                        t.secondary_label,
                    );
                    ui.add_space(8.0);
                    label(
                        ui,
                        "Paste the recovery text shown once at enrollment.",
                        Role::Callout,
                        t.secondary_label,
                    );
                    ui.add_space(8.0);
                    theme::input_frame(t).show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.add(
                            egui::TextEdit::multiline(&mut self.recovery_text)
                                .desired_rows(5)
                                .desired_width(f32::INFINITY)
                                .frame(false),
                        );
                    });
                    ui.add_space(12.0);
                    ui.allocate_ui_with_layout(egui::Vec2::new(ui.available_width(), 26.0), egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let can = !self.recovery_text.trim().is_empty() && self.busy.is_none();
                        if button(ui, t, "Run Recovery", Btn::Primary, can).clicked() {
                            self.send(Action::Recover {
                                connection_id: target.clone(),
                                text: self.recovery_text.trim().to_string(),
                            });
                            self.recovery_text.clear();
                            open = false;
                        }
                        if button(ui, t, "Cancel", Btn::Quiet, true).clicked() {
                            open = false;
                        }
                    });
                });
            if modal.should_close() {
                open = false;
            }
            if !open {
                self.recovery_target = None;
                self.recovery_text.clear();
            }
        }

        if self.show_import {
            let mut open = true;
            let modal = egui::Modal::new(egui::Id::new("import-sheet"))
                .backdrop_color(t.scrim)
                .frame(theme::sheet_frame(t))
                .show(ctx, |ui| {
                    ui.set_width(460.0);
                    label(ui, "Import Fresh Profile", Role::Title2, t.label);
                    ui.add_space(4.0);
                    label(
                        ui,
                        "Paste your recovery text. The endpoint operator must have issued a recovery-access credential for this vault.",
                        Role::Callout,
                        t.secondary_label,
                    );
                    ui.add_space(10.0);
                    theme::input_frame(t).show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.add(
                            egui::TextEdit::multiline(&mut self.import_text)
                                .desired_rows(4)
                                .desired_width(f32::INFINITY)
                                .hint_text(rt("mrk1…", Role::Mono, t.tertiary_label))
                                .frame(false),
                        );
                    });
                    ui.add_space(12.0);
                    ui.allocate_ui_with_layout(egui::Vec2::new(ui.available_width(), 26.0), egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let can =
                            self.import_text.trim().starts_with("mrk1") && self.busy.is_none();
                        if button(ui, t, "Import", Btn::Primary, can).clicked() {
                            let text = self.import_text.trim().to_string();
                            self.import_text.clear();
                            self.send(Action::RecoveryImport {
                                text,
                                service_url: None,
                            });
                            open = false;
                        }
                        if button(ui, t, "Cancel", Btn::Quiet, true).clicked() {
                            open = false;
                        }
                    });
                });
            if modal.should_close() {
                open = false;
            }
            self.show_import = open;
        }

        if let Some(text) = self.recovery_reveal.clone() {
            let mut open = true;
            let modal = egui::Modal::new(egui::Id::new("recovery-reveal-sheet"))
                .backdrop_color(t.scrim)
                .frame(theme::sheet_frame(t))
                .show(ctx, |ui| {
                    ui.set_width(460.0);
                    label(ui, "Recovery Key", Role::Title2, t.label);
                    ui.add_space(4.0);
                    label(
                        ui,
                        "This text is shown once and never stored. Save it somewhere safe — it alone can recover this install's paired connections.",
                        Role::Callout,
                        t.secondary_label,
                    );
                    ui.add_space(10.0);
                    theme::input_frame(t).show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.add(
                            egui::Label::new(rt(&text, Role::Mono, t.label))
                                .selectable(true)
                                .wrap(),
                        );
                    });
                    ui.add_space(12.0);
                    ui.allocate_ui_with_layout(egui::Vec2::new(ui.available_width(), 26.0), egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if button(ui, t, "Done", Btn::Primary, true).clicked() {
                            open = false;
                        }
                        if button(ui, t, "Copy", Btn::Bordered, true).clicked() {
                            ui.ctx().copy_text(text.clone());
                        }
                    });
                });
            if modal.should_close() {
                open = false;
            }
            if !open {
                self.recovery_reveal = None;
            }
        }
    }
}

// ── boot ────────────────────────────────────────────────────────────────────

fn main() -> eframe::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let data_dir = std::env::var_os("MESHRIX_ENTRY_DATA_DIR")
        .map(Into::into)
        .or_else(|| {
            directories::ProjectDirs::from("ai", "meshrix", "entry")
                .map(|d| d.config_dir().to_path_buf())
        })
        .unwrap_or_else(|| std::path::PathBuf::from(".meshrix-entry"));

    let custody = std::env::var("MESHRIX_CUSTODY").unwrap_or_else(|_| "auto".into());
    let file_custody = if custody == "file" {
        let secret = std::env::var("MESHRIX_CUSTODY_SECRET")
            .expect("MESHRIX_CUSTODY_SECRET (64 hex) required for file custody");
        let bytes: Vec<u8> = (0..secret.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&secret[i..i + 2], 16).expect("hex secret"))
            .collect();
        let wrap_secret: [u8; 32] = bytes.try_into().expect("custody secret must be 32 bytes");
        Some(FileCustodyOpts {
            data_dir: data_dir.join("custody"),
            wrap_secret,
        })
    } else {
        None
    };

    let account_access = match (
        std::env::var("MESHRIX_ACCOUNT_ACCESS_ID").ok(),
        std::env::var("MESHRIX_ACCOUNT_ACCESS_SECRET").ok(),
    ) {
        (Some(client_id), Some(client_secret)) => {
            Some(meshrix_entry_core::account::AccessServiceToken { client_id, client_secret })
        }
        _ => None,
    };

    let config = ServiceConfig {
        account_origin: std::env::var("MESHRIX_ACCOUNT_ORIGIN").ok(),
        account_access,
        default_relay_service: std::env::var("MESHRIX_RELAY_SERVICE").ok(),
        allow_insecure_loopback: std::env::var_os("MESHRIX_INSECURE_LOOPBACK").is_some(),
        custody: match custody.as_str() {
            "os" => CustodyPreference::Os,
            "file" => CustodyPreference::File,
            _ => CustodyPreference::Auto,
        },
        file_custody,
        ..ServiceConfig::default()
    };
    let service = EntryService::open(data_dir, config).expect("failed to open entry service");
    let (bridge, runtime) = spawn_worker(service);

    let logo_img =
        egui_extras::image::load_image_bytes(include_bytes!(concat!(env!("OUT_DIR"), "/logo.png")))
            .ok();
    let mut viewport = egui::ViewportBuilder::default()
        .with_title("Meshrix Entry")
        .with_inner_size([1120.0, 700.0])
        .with_min_inner_size([880.0, 560.0]);
    if let Some(img) = &logo_img {
        viewport = viewport.with_icon(std::sync::Arc::new(egui::IconData {
            rgba: img.as_raw().to_vec(),
            width: img.width() as u32,
            height: img.height() as u32,
        }));
    }
    let options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };
    let result = eframe::run_native(
        "meshrix-entry",
        options,
        Box::new(move |cc| {
            theme::install(&cc.egui_ctx);
            let logo = logo_img.map(|img| {
                cc.egui_ctx
                    .load_texture("logo", img, egui::TextureOptions::LINEAR)
            });
            Ok(Box::new(App::new(bridge, logo)))
        }),
    );
    drop(result);
    runtime.shutdown_background();
    Ok(())
}
