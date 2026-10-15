//! `acp-executor.ts` — executes one registered local ACP command over the
//! official `agent-client-protocol` crate. The durable prompt reservation
//! (`before_prompt`) commits before the agent's `session/prompt` call — a
//! crash after that point must never silently re-bill the prompt.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionNotification, SessionUpdate, SetSessionConfigOptionRequest,
    StopReason, TextContent, ToolCallContent,
};
use agent_client_protocol::{Agent, ByteStreams, ConnectionTo};
use futures_util::future::LocalBoxFuture;
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::error::entry_error;
use crate::peer::application::{
    AcpAgentSummary, AcpPermissionContent, AcpPermissionLocation, AcpPermissionOption,
    AcpPermissionPrompt, AcpPermissionResolution, AcpPermissionToolCall,
};
use crate::peer::application_engine::{
    PeerApplicationAgentExecutor, PeerApplicationExecution, PeerApplicationExecutionHandlers,
    PeerApplicationExecutionResult, PeerApplicationProgressKind,
};
use crate::Result;

use super::registry::{AcpAgentDefinition, AcpAgentSecretResolver, AcpEnvironmentSource};

/// Inherited host variables the agent process may see — mirrors the TS
/// allowlist verbatim; everything else is dropped via `env_clear`.
const INHERITED_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
];

fn public_permission(request: &RequestPermissionRequest) -> AcpPermissionPrompt {
    let fields = &request.tool_call.fields;
    let content = fields
        .content
        .clone()
        .unwrap_or_default()
        .iter()
        .flat_map(|item| match item {
            ToolCallContent::Content(c) => match &c.content {
                ContentBlock::Text(t) => vec![AcpPermissionContent {
                    kind: "text".to_string(),
                    text: Some(t.text.clone()),
                }],
                _ => Vec::new(),
            },
            ToolCallContent::Diff(d) => vec![AcpPermissionContent {
                kind: "diff".to_string(),
                text: Some(format!(
                    "{}\n{}\n→\n{}",
                    d.path.display(),
                    d.old_text.as_deref().unwrap_or("(new file)"),
                    d.new_text
                )),
            }],
            ToolCallContent::Terminal(t) => vec![AcpPermissionContent {
                kind: "terminal".to_string(),
                text: Some(format!("Terminal: {}", t.terminal_id)),
            }],
            _ => Vec::new(),
        })
        .collect();
    AcpPermissionPrompt {
        session_id: request.session_id.to_string(),
        tool_call: AcpPermissionToolCall {
            tool_call_id: request.tool_call.tool_call_id.to_string(),
            title: fields
                .title
                .clone()
                .or_else(|| fields.name.clone())
                .unwrap_or_else(|| "Agent action".to_string()),
            name: fields.name.clone(),
            kind: fields.kind.as_ref().map(|k| serde_json::to_string(k).unwrap_or_default().trim_matches('"').to_string()),
            status: fields.status.as_ref().map(|s| serde_json::to_string(s).unwrap_or_default().trim_matches('"').to_string()),
            content,
            raw_input: fields.raw_input.clone(),
            locations: fields
                .locations
                .clone()
                .unwrap_or_default()
                .iter()
                .map(|l| AcpPermissionLocation {
                    path: l.path.display().to_string(),
                    line: l.line.map(|line| line as u64),
                })
                .collect(),
        },
        options: request
            .options
            .iter()
            .map(|o| AcpPermissionOption {
                option_id: o.option_id.to_string(),
                name: o.name.clone(),
                kind: serde_json::to_string(&o.kind)
                    .unwrap_or_default()
                    .trim_matches('"')
                    .to_string(),
            })
            .collect(),
    }
}

fn progress(update: &SessionUpdate) -> Option<(PeerApplicationProgressKind, String)> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => match &chunk.content {
            ContentBlock::Text(t) => {
                Some((PeerApplicationProgressKind::Message, t.text.clone()))
            }
            _ => None,
        },
        SessionUpdate::ToolCall(_) | SessionUpdate::ToolCallUpdate(_) => Some((
            PeerApplicationProgressKind::Tool,
            "Agent is working with a tool.".to_string(),
        )),
        SessionUpdate::Plan(_) => Some((
            PeerApplicationProgressKind::Plan,
            "Agent updated its plan.".to_string(),
        )),
        _ => None,
    }
}

fn stop_reason_str(reason: &StopReason) -> String {
    match reason {
        StopReason::EndTurn => "end_turn",
        StopReason::MaxTokens => "max_tokens",
        StopReason::MaxTurnRequests => "max_turn_requests",
        StopReason::Refusal => "refusal",
        StopReason::Cancelled => "cancelled",
        _ => "end_turn",
    }
    .to_string()
}

async fn resolve_environment(
    definition: &AcpAgentDefinition,
    secret_resolver: &Arc<dyn AcpAgentSecretResolver>,
) -> Result<BTreeMap<String, String>> {
    let mut resolved: BTreeMap<String, String> = INHERITED_ENV
        .iter()
        .filter_map(|key| std::env::var(key).ok().map(|v| (key.to_string(), v)))
        .collect();
    for (name, source) in &definition.environment {
        let value = match source {
            AcpEnvironmentSource::HostEnvironment { variable } => std::env::var(variable).ok(),
            AcpEnvironmentSource::SecretReference { reference } => {
                secret_resolver.resolve(reference).await
            }
            AcpEnvironmentSource::Literal { value } => Some(value.clone()),
        }
        .ok_or_else(|| {
            entry_error(
                "agent_execution_failed",
                "A configured Agent environment source is unavailable.",
            )
        })?;
        resolved.insert(name.clone(), value);
    }
    Ok(resolved)
}

/// Executes one registered local ACP command.
pub struct AcpSubprocessExecutor {
    pub definition: AcpAgentDefinition,
    summary: AcpAgentSummary,
    secret_resolver: Arc<dyn AcpAgentSecretResolver>,
}

impl AcpSubprocessExecutor {
    pub fn new(
        definition: AcpAgentDefinition,
        secret_resolver: Arc<dyn AcpAgentSecretResolver>,
    ) -> Self {
        Self {
            summary: AcpAgentSummary {
                id: definition.id.clone(),
                display_name: definition.display_name.clone(),
                description: definition.description.clone(),
                enabled: definition.enabled,
                detected: None,
                transport: Some("acp".to_string()),
            },
            definition,
            secret_resolver,
        }
    }
}

impl PeerApplicationAgentExecutor for AcpSubprocessExecutor {
    fn summary(&self) -> AcpAgentSummary {
        self.summary.clone()
    }

    fn start(
        &self,
        _operation_id: &str,
        prompt: &str,
        model: Option<String>,
        handlers: PeerApplicationExecutionHandlers,
    ) -> PeerApplicationExecution {
        let definition = self.definition.clone();
        let secret_resolver = self.secret_resolver.clone();
        let prompt = prompt.to_string();

        let cancel_requested = Rc::new(Cell::new(false));
        let connection_cell: Rc<RefCell<Option<ConnectionTo<Agent>>>> = Rc::new(RefCell::new(None));
        let session_cell: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
        let child_cell: Rc<RefCell<Option<tokio::process::Child>>> = Rc::new(RefCell::new(None));
        // Text accumulation shared by the `Send` notification handler and
        // the `LocalSet` result path.
        let accumulated = std::sync::Arc::new(std::sync::Mutex::new(String::new()));

        /// `agent-client-protocol` handlers are `Send`-bound while the engine
        /// callbacks are `LocalSet`-bound — events cross on a `Send` channel
        /// and run on this thread's local drainer.
        enum BridgeEvent {
            Progress(PeerApplicationProgressKind, String),
            Permission(AcpPermissionPrompt, oneshot::Sender<AcpPermissionResolution>),
            BeforePrompt(oneshot::Sender<Result<()>>),
        }
        let (bridge_tx, mut bridge_rx) = mpsc::unbounded_channel::<BridgeEvent>();
        let (result_tx, result_rx) = oneshot::channel();

        let PeerApplicationExecutionHandlers {
            before_prompt,
            on_progress,
            request_permission,
        } = handlers;
        let drainer = tokio::task::spawn_local(async move {
            while let Some(event) = bridge_rx.recv().await {
                match event {
                    BridgeEvent::Progress(kind, text) => {
                        let _ = on_progress(kind, text).await;
                    }
                    BridgeEvent::Permission(prompt, reply) => {
                        let resolution = request_permission(prompt).await;
                        let _ = reply.send(resolution);
                    }
                    BridgeEvent::BeforePrompt(reply) => {
                        let _ = reply.send(before_prompt().await);
                    }
                }
            }
        });

        let cancel = {
            let cancel_requested = cancel_requested.clone();
            let connection_cell = connection_cell.clone();
            let session_cell = session_cell.clone();
            Rc::new(move || {
                cancel_requested.set(true);
                let connection = connection_cell.borrow().clone();
                let session_id = session_cell.borrow().clone();
                Box::pin(async move {
                    if let (Some(connection), Some(session_id)) = (connection, session_id) {
                        let _ = connection
                            .send_notification(CancelNotification::new(session_id));
                    }
                }) as LocalBoxFuture<'static, ()>
            }) as Rc<dyn Fn() -> LocalBoxFuture<'static, ()>>
        };

        let run = {
            let connection_cell = connection_cell.clone();
            let session_cell = session_cell.clone();
            let child_cell = child_cell.clone();
            let accumulated = accumulated.clone();
            let cancel_requested = cancel_requested.clone();
            let bridge_tx = bridge_tx.clone();
            async move {
                let env = resolve_environment(&definition, &secret_resolver).await?;
                #[cfg(windows)]
                let mut command = {
                    let lower = definition.command.to_ascii_lowercase();
                    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
                        let mut c = tokio::process::Command::new(
                            std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()),
                        );
                        c.arg("/c").arg(&definition.command);
                        c
                    } else {
                        tokio::process::Command::new(&definition.command)
                    }
                };
                #[cfg(not(windows))]
                let mut command = tokio::process::Command::new(&definition.command);
                command
                    .args(&definition.args)
                    .current_dir(&definition.cwd)
                    .env_clear()
                    .envs(&env)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .kill_on_drop(false);
                #[cfg(unix)]
                command.process_group(0);
                let mut child = command.spawn().map_err(|_| {
                    entry_error(
                        "agent_execution_failed",
                        "The local ACP process could not be started.",
                    )
                })?;
                let child_stdin = child.stdin.take().ok_or_else(|| {
                    entry_error(
                        "agent_execution_failed",
                        "The local ACP process did not provide its standard input.",
                    )
                })?;
                let child_stdout = child.stdout.take().ok_or_else(|| {
                    entry_error(
                        "agent_execution_failed",
                        "The local ACP process did not provide its standard output.",
                    )
                })?;
                *child_cell.borrow_mut() = Some(child);

                let accumulated_notify = accumulated.clone();
                let transport = ByteStreams::new(
                    child_stdin.compat_write(),
                    child_stdout.compat(),
                );
                let notify_tx = bridge_tx.clone();
                let permission_tx = bridge_tx.clone();
                let run_result = agent_client_protocol::Client
                    .builder()
                    .name("Meshrix")
                    .on_receive_notification(
                        async move |notification: SessionNotification, _cx| {
                            if let Some((kind, text)) = progress(&notification.update) {
                                if kind == PeerApplicationProgressKind::Message {
                                    accumulated_notify.lock().unwrap().push_str(&text);
                                }
                                let _ = notify_tx.send(BridgeEvent::Progress(kind, text));
                            }
                            Ok(())
                        },
                        agent_client_protocol::on_receive_notification!(),
                    )
                    .on_receive_request(
                        async move |request: RequestPermissionRequest, responder, _cx| {
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if permission_tx
                                .send(BridgeEvent::Permission(
                                    public_permission(&request),
                                    reply_tx,
                                ))
                                .is_err()
                            {
                                let _ = responder.respond(RequestPermissionResponse::new(
                                    RequestPermissionOutcome::Cancelled,
                                ));
                                return Ok(());
                            }
                            let decision = reply_rx.await.unwrap_or(AcpPermissionResolution::Cancelled);
                            let response = match decision {
                                AcpPermissionResolution::Cancelled => {
                                    RequestPermissionResponse::new(
                                        RequestPermissionOutcome::Cancelled,
                                    )
                                }
                                AcpPermissionResolution::Selected { option_id } => {
                                    RequestPermissionResponse::new(
                                        RequestPermissionOutcome::Selected(
                                            SelectedPermissionOutcome::new(option_id),
                                        ),
                                    )
                                }
                            };
                            let _ = responder.respond(response);
                            Ok(())
                        },
                        agent_client_protocol::on_receive_request!(),
                    )
                    .connect_with(transport, {
                        let session_cell = session_cell.clone();
                        let connection_cell = connection_cell.clone();
                        let accumulated = accumulated.clone();
                        move |connection: ConnectionTo<Agent>| async move {
                            *connection_cell.borrow_mut() = Some(connection.clone());
                            let initialized = connection
                                .send_request(InitializeRequest::new(
                                    agent_client_protocol::schema::ProtocolVersion::V1,
                                ))
                                .block_task()
                                .await?;
                            if initialized.protocol_version
                                != agent_client_protocol::schema::ProtocolVersion::V1
                            {
                                return Err(agent_client_protocol::Error::internal_error().data(
                                    "The ACP agent negotiated an unsupported protocol version.",
                                ));
                            }
                            let session = connection
                                .send_request(NewSessionRequest::new(definition.cwd.clone()))
                                .block_task()
                                .await?;
                            let session_id = session.session_id.to_string();
                            *session_cell.borrow_mut() = Some(session_id.clone());
                            // `model[effort]` — the catalog's modelId syntax —
                            // splits into the agent's `model` and
                            // `reasoning_effort` config options.
                            if let Some(model) = &model {
                                let (base, effort) = match model.split_once('[') {
                                    Some((base, e)) => {
                                        (base, e.strip_suffix(']').unwrap_or(e))
                                    }
                                    None => (model.as_str(), ""),
                                };
                                connection
                                    .send_request(SetSessionConfigOptionRequest::new(
                                        session_id.clone(),
                                        "model",
                                        base,
                                    ))
                                    .block_task()
                                    .await?;
                                if !effort.is_empty() {
                                    connection
                                        .send_request(SetSessionConfigOptionRequest::new(
                                            session_id.clone(),
                                            "reasoning_effort",
                                            effort,
                                        ))
                                        .block_task()
                                        .await?;
                                }
                            }
                            if cancel_requested.get() {
                                let _ = connection
                                    .send_notification(CancelNotification::new(session_id.clone()));
                            }
                            // The durable reservation commits through the
                            // LocalSet bridge — never inside this Send future.
                            let (reply_tx, reply_rx) = oneshot::channel();
                            bridge_tx
                                .send(BridgeEvent::BeforePrompt(reply_tx))
                                .map_err(|_| {
                                    agent_client_protocol::Error::internal_error()
                                        .data("The prompt reservation bridge is closed.")
                                })?;
                            reply_rx
                                .await
                                .map_err(|_| {
                                    agent_client_protocol::Error::internal_error()
                                        .data("The prompt reservation bridge is closed.")
                                })?
                                .map_err(|e| {
                                    agent_client_protocol::Error::internal_error().data(format!(
                                        "The durable prompt reservation could not be committed: {}",
                                        e.code
                                    ))
                                })?;
                            let response = connection
                                .send_request(PromptRequest::new(
                                    session_id,
                                    vec![ContentBlock::Text(TextContent::new(prompt))],
                                ))
                                .block_task()
                                .await?;
                            Ok(PeerApplicationExecutionResult {
                                stop_reason: stop_reason_str(&response.stop_reason),
                                text: accumulated.lock().unwrap().clone(),
                            })
                        }
                    })
                    .await;
                // `terminate()` — kill the process tree, surface nothing.
                if let Some(mut child) = child_cell.borrow_mut().take() {
                    #[cfg(unix)]
                    {
                        if let Some(id) = child.id() {
                            unsafe {
                                libc::killpg(id as i32, libc::SIGKILL);
                            }
                        }
                    }
                    let _ = child.kill().await;
                }
                run_result.map_err(|e| {
                    entry_error(
                        "agent_execution_failed",
                        "The local ACP process could not complete the operation.",
                    )
                    .caused_by(e)
                })
            }
        };

        tokio::task::spawn_local(async move {
            let outcome = run.await;
            drop(bridge_tx);
            drainer.await.ok();
            let _ = result_tx.send(outcome);
        });

        PeerApplicationExecution {
            cancel,
            result: result_rx,
        }
    }
}


