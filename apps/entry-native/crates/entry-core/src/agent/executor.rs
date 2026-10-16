//! Meshrix bridge from durable Peer application operations to AwP/A4AA.
//!
//! AwP resolves the selected profile and owns prompt composition and model /
//! effort defaults. A4AA owns agent adaptation, process supervision, session
//! lifecycle, permissions and cancellation. This module only connects those
//! events to Meshrix's durable reservation, permission and progress handlers.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use futures_util::future::LocalBoxFuture;
use tokio::sync::{mpsc, oneshot};

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

enum BridgeEvent {
    Permission(
        AcpPermissionPrompt,
        oneshot::Sender<AcpPermissionResolution>,
    ),
    BeforePrompt(oneshot::Sender<Result<()>>),
}

struct PermissionBridge {
    sender: mpsc::UnboundedSender<BridgeEvent>,
}

#[async_trait::async_trait]
impl a4aa::PermissionHandler for PermissionBridge {
    async fn decide(&self, prompt: a4aa::PermissionPrompt) -> a4aa::PermissionDecision {
        let (reply_tx, reply_rx) = oneshot::channel();
        if self
            .sender
            .send(BridgeEvent::Permission(public_permission(prompt), reply_tx))
            .is_err()
        {
            return a4aa::PermissionDecision::Cancelled;
        }

        match reply_rx.await.unwrap_or(AcpPermissionResolution::Cancelled) {
            AcpPermissionResolution::Cancelled => a4aa::PermissionDecision::Cancelled,
            AcpPermissionResolution::Selected { option_id } => {
                a4aa::PermissionDecision::Selected(option_id)
            }
        }
    }
}

struct BeforePromptBridge {
    sender: mpsc::UnboundedSender<BridgeEvent>,
}

#[async_trait::async_trait]
impl a4aa::BeforeTurn for BeforePromptBridge {
    async fn run(&self) -> a4aa::Result<()> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.sender
            .send(BridgeEvent::BeforePrompt(reply_tx))
            .map_err(|_| {
                a4aa::AdapterError::permanent(
                    "peer_prompt_reservation_unavailable",
                    "meshrix/before-turn",
                )
            })?;
        let result = reply_rx.await.map_err(|_| {
            a4aa::AdapterError::permanent(
                "peer_prompt_reservation_unavailable",
                "meshrix/before-turn",
            )
        })?;
        result.map_err(|error| {
            a4aa::AdapterError::permanent("peer_prompt_reservation_failed", "meshrix/before-turn")
                .with_detail(error.code)
        })
    }
}

/// Executes a selected AwP profile through its resolved A4AA agent descriptor.
pub struct ProfiledAgentExecutor {
    summary: AcpAgentSummary,
    registry: Rc<awp::Registry>,
    profile_id: String,
    secret_resolver: Arc<dyn a4aa::SecretResolver>,
}

impl ProfiledAgentExecutor {
    pub fn new(
        summary: AcpAgentSummary,
        registry: Rc<awp::Registry>,
        profile_id: String,
        secret_resolver: Arc<dyn a4aa::SecretResolver>,
    ) -> Self {
        Self {
            summary,
            registry,
            profile_id,
            secret_resolver,
        }
    }
}

impl PeerApplicationAgentExecutor for ProfiledAgentExecutor {
    fn summary(&self) -> AcpAgentSummary {
        self.summary.clone()
    }

    fn start(
        &self,
        _operation_id: &str,
        prompt: &str,
        model: Option<String>,
        effort: Option<String>,
        handlers: PeerApplicationExecutionHandlers,
    ) -> PeerApplicationExecution {
        let registry = self.registry.clone();
        let profile_id = self.profile_id.clone();
        let secret_resolver = self.secret_resolver.clone();
        let prompt = prompt.to_owned();

        let (bridge_tx, mut bridge_rx) = mpsc::unbounded_channel::<BridgeEvent>();
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<a4aa::AgentEvent>();
        let (cancel_tx, mut cancel_rx) = mpsc::unbounded_channel::<oneshot::Sender<()>>();
        let (result_tx, result_rx) = oneshot::channel();
        let streamed_text = Rc::new(RefCell::new(None::<String>));
        let streamed_text_for_events = streamed_text.clone();
        let streamed_text_for_run = streamed_text.clone();
        let reservation_error = Rc::new(RefCell::new(None));
        let reservation_error_for_bridge = reservation_error.clone();

        let PeerApplicationExecutionHandlers {
            before_prompt,
            on_progress,
            request_permission,
        } = handlers;

        // A4AA's event channel is consumed directly on the Meshrix LocalSet.
        // This keeps one event queue and invokes durable progress storage as
        // soon as each canonical event arrives.
        let event_task = tokio::task::spawn_local(async move {
            while let Some(event) = event_rx.recv().await {
                if let a4aa::AgentEvent::MessageChunk { text } = &event {
                    if let Some(output) = streamed_text_for_events.borrow_mut().as_mut() {
                        output.push_str(text);
                    }
                }
                if let Some((kind, text)) = progress(event) {
                    let _ = on_progress(kind, text).await;
                }
            }
        });

        // ACP permission and before-turn callbacks are Send-bound in A4AA,
        // while Meshrix's persistence callbacks are LocalSet-bound. This
        // small bridge returns each result without moving product logic into
        // the adapter.
        let drainer = tokio::task::spawn_local(async move {
            while let Some(event) = bridge_rx.recv().await {
                match event {
                    BridgeEvent::Permission(prompt, reply) => {
                        let resolution = request_permission(prompt).await;
                        let _ = reply.send(resolution);
                    }
                    BridgeEvent::BeforePrompt(reply) => {
                        let result = before_prompt().await;
                        if let Err(error) = &result {
                            // Keep local authority/durability outcomes intact;
                            // the adapter's generic error cannot express the
                            // engine's defer-versus-refuse decision.
                            *reservation_error_for_bridge.borrow_mut() = Some(error.clone());
                        }
                        let _ = reply.send(result);
                    }
                }
            }
        });

        let cancel = Rc::new(move || {
            let (ack_tx, ack_rx) = oneshot::channel();
            if cancel_tx.send(ack_tx).is_err() {
                return Box::pin(async {}) as LocalBoxFuture<'static, ()>;
            }
            Box::pin(async move {
                let _ = ack_rx.await;
            }) as LocalBoxFuture<'static, ()>
        });

        let run = async move {
            let outcome = async {
                let agent = registry.resolve(&profile_id).map_err(execution_error)?;
                let is_acp = matches!(&agent.spec().lane, a4aa::LaneSpec::Acp { .. });
                validate_request_selectors(&agent, model.as_deref(), effort.as_deref())?;
                let agent = agent
                    .secrets(secret_resolver)
                    .permission(Arc::new(PermissionBridge {
                        sender: bridge_tx.clone(),
                    }))
                    .before_turn(Arc::new(BeforePromptBridge {
                        sender: bridge_tx.clone(),
                    }));

                let session = agent
                    .open_session(a4aa::SessionRequest::default(), event_tx.clone())
                    .await
                    .map_err(execution_error)?;
                if is_acp {
                    *streamed_text_for_run.borrow_mut() = Some(String::new());
                }

                let turn = a4aa::TurnRequest {
                    text: prompt,
                    model,
                    effort,
                };
                let result = prompt_with_cancellation(&session, turn, &mut cancel_rx).await;
                let close_result = session.close().await;
                drop(agent);

                match result {
                    Err(error) => Err(reservation_error
                        .borrow_mut()
                        .take()
                        .unwrap_or_else(|| execution_error(error))),
                    Ok(result) => {
                        if let Err(error) = close_result {
                            tracing::warn!(
                                code = error.code,
                                stage = error.stage,
                                "A4AA session cleanup did not complete after a finished turn"
                            );
                        }
                        Ok(PeerApplicationExecutionResult {
                            stop_reason: peer_stop_reason(&result.stop_reason),
                            text: result.text,
                        })
                    }
                }
            }
            .await;

            // Close cancellation admission and acknowledge any request that
            // raced with session setup or a completed turn. No cancellation
            // request is retried or reinterpreted as an Agent failure.
            cancel_rx.close();
            while let Ok(reply) = cancel_rx.try_recv() {
                let _ = reply.send(());
            }
            drop(event_tx);
            drop(bridge_tx);
            outcome
        };

        tokio::task::spawn_local(async move {
            let mut outcome = run.await;
            let _ = event_task.await;
            let _ = drainer.await;
            if let Ok(result) = &mut outcome {
                if result.text.is_empty() {
                    if let Some(text) = streamed_text.borrow_mut().take() {
                        result.text = text;
                    }
                }
            }
            let _ = result_tx.send(outcome);
        });

        PeerApplicationExecution {
            cancel,
            result: result_rx,
        }
    }
}

fn validate_request_selectors(
    agent: &awp::VirtualAgent,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<()> {
    let support = agent.spec().selector_support(a4aa::SelectorPhase::Turn);
    if model.is_some_and(|value| !value.trim().is_empty())
        && support.model == a4aa::SelectorSupport::Unsupported
    {
        return Err(entry_error(
            "agent_model_unsupported",
            "The selected Agent does not apply model selection for this turn.",
        ));
    }
    if effort.is_some_and(|value| !value.trim().is_empty())
        && support.effort == a4aa::SelectorSupport::Unsupported
    {
        return Err(entry_error(
            "agent_effort_unsupported",
            "The selected Agent does not apply reasoning effort for this turn.",
        ));
    }
    Ok(())
}

async fn prompt_with_cancellation(
    session: &awp::VirtualSession,
    request: a4aa::TurnRequest,
    cancel_rx: &mut mpsc::UnboundedReceiver<oneshot::Sender<()>>,
) -> a4aa::Result<a4aa::TurnOutcome> {
    let mut cancellation_channel_open = true;
    let mut cancellation_sent = false;
    let prompt = session.prompt_with(request);
    tokio::pin!(prompt);

    loop {
        tokio::select! {
            outcome = &mut prompt => return outcome,
            cancellation = cancel_rx.recv(), if cancellation_channel_open => {
                match cancellation {
                    Some(acknowledge) => {
                        if !cancellation_sent {
                            cancellation_sent = true;
                            if let Err(error) = session.cancel().await {
                                tracing::warn!(
                                    code = error.code,
                                    stage = error.stage,
                                    "A4AA did not accept the explicit cancellation request"
                                );
                            }
                        }
                        let _ = acknowledge.send(());
                    }
                    None => cancellation_channel_open = false,
                }
            }
        }
    }
}

fn public_permission(request: a4aa::PermissionPrompt) -> AcpPermissionPrompt {
    let tool_call = request.raw.get("toolCall");
    let content = request
        .content_texts
        .into_iter()
        .map(|text| AcpPermissionContent {
            kind: "text".to_string(),
            text: Some(text),
        })
        .collect();
    let locations = tool_call
        .and_then(|value| value.get("locations"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|location| {
            let path = location.get("path").and_then(serde_json::Value::as_str)?;
            Some(AcpPermissionLocation {
                path: path.to_owned(),
                line: location.get("line").and_then(serde_json::Value::as_u64),
            })
        })
        .collect();

    AcpPermissionPrompt {
        session_id: request.session_id,
        tool_call: AcpPermissionToolCall {
            tool_call_id: request.tool_call_id,
            title: request.title,
            name: tool_call
                .and_then(|value| value.get("name"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            kind: request.kind,
            status: tool_call
                .and_then(|value| value.get("status"))
                .and_then(json_value_text),
            content,
            raw_input: tool_call.and_then(|value| value.get("rawInput")).cloned(),
            locations,
        },
        options: request
            .options
            .into_iter()
            .map(|(option_id, name, kind)| AcpPermissionOption {
                option_id,
                name,
                kind,
            })
            .collect(),
    }
}

fn json_value_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

fn progress(event: a4aa::AgentEvent) -> Option<(PeerApplicationProgressKind, String)> {
    match event {
        a4aa::AgentEvent::MessageChunk { text } => {
            Some((PeerApplicationProgressKind::Message, text))
        }
        a4aa::AgentEvent::ToolCall { .. } => Some((
            PeerApplicationProgressKind::Tool,
            "Agent is working with a tool.".to_string(),
        )),
        a4aa::AgentEvent::Plan { .. } => Some((
            PeerApplicationProgressKind::Plan,
            "Agent updated its plan.".to_string(),
        )),
        a4aa::AgentEvent::Truncated => Some((
            PeerApplicationProgressKind::State,
            "Agent output reached its configured limit.".to_string(),
        )),
        a4aa::AgentEvent::Raw { .. } | a4aa::AgentEvent::Usage { .. } => None,
    }
}

fn peer_stop_reason(reason: &str) -> String {
    match reason {
        "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" => {
            reason.to_string()
        }
        _ => "end_turn".to_string(),
    }
}

fn execution_error(error: a4aa::AdapterError) -> crate::EntryError {
    entry_error(
        "agent_execution_failed",
        "The selected local Agent profile could not complete the operation.",
    )
    .caused_by(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;
    use std::io::Read;
    use std::path::PathBuf;

    use a4aa::{AgentSpec, CliLaneSpec, CommandSpec, EnvPolicy, EnvValue, LaneSpec, PromptChannel};
    use awp::{ProfilePatch, RegistryDocument};
    use serde_json::json;
    use tokio::task::LocalSet;

    const FIXTURE_ENABLED: &str = "MESHRIX_A4AA_AWP_FIXTURE";
    const FIXTURE_RESERVATION: &str = "MESHRIX_A4AA_AWP_RESERVATION";

    /// This test doubles as the child process used by the bridge test. The
    /// A4AA CLI descriptor starts this test binary with a JSON stdin template,
    /// so the test exercises Registry resolution, AwP prompt/default handling,
    /// A4AA process supervision, streamed events and the durable hook ordering.
    #[test]
    fn a4aa_awp_fixture_agent() {
        let Ok(enabled) = std::env::var(FIXTURE_ENABLED) else {
            return;
        };
        assert_eq!(enabled, "1");

        let reservation = std::env::var_os(FIXTURE_RESERVATION)
            .map(PathBuf::from)
            .expect("reservation path is supplied by the test descriptor");
        assert!(reservation.is_file(), "reservation runs before Agent spawn");

        let mut input = String::new();
        std::io::stdin()
            .read_to_string(&mut input)
            .expect("read profiled turn request");
        let request: serde_json::Value =
            serde_json::from_str(&input).expect("A4AA sends the configured JSON template");
        assert_eq!(request["prompt"], "Profile instructions\n\nuser task");
        println!(
            "profiled-a4aa-fixture:{}:{}",
            request["model"]
                .as_str()
                .filter(|value| !value.is_empty())
                .unwrap_or("unset"),
            request["effort"]
                .as_str()
                .filter(|value| !value.is_empty())
                .unwrap_or("unset")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn execution_uses_awp_and_a4aa_and_reserves_before_spawn() {
        let temp_dir = tempfile::tempdir().expect("temporary fixture directory");
        let reservation_path = temp_dir.path().join("reserved");
        let registry = fixture_registry(reservation_path.clone());
        let summary = AcpAgentSummary {
            id: "review-profile".to_string(),
            display_name: "Review profile".to_string(),
            description: None,
            enabled: true,
            detected: None,
            transport: Some("cli".to_string()),
        };
        let executor = ProfiledAgentExecutor::new(
            summary,
            registry,
            "review-profile".to_string(),
            Arc::new(a4aa::NoSecrets),
        );

        let reservations = Rc::new(Cell::new(0));
        let progress_events = Rc::new(RefCell::new(Vec::new()));
        let reservations_after = reservations.clone();
        let progress_events_after = progress_events.clone();
        let (override_result, default_result) = LocalSet::new()
            .run_until(async move {
                let override_execution = executor.start(
                    "fixture-operation",
                    "user task",
                    Some("request-model".to_string()),
                    Some("request-effort".to_string()),
                    fixture_handlers(
                        reservation_path.clone(),
                        reservations.clone(),
                        progress_events.clone(),
                    ),
                );
                let override_result = override_execution
                    .result
                    .await
                    .expect("override result channel")
                    .expect("profiled override execution succeeds");

                let default_execution = executor.start(
                    "fixture-default-operation",
                    "user task",
                    None,
                    None,
                    fixture_handlers(reservation_path, reservations, progress_events),
                );
                let default_result = default_execution
                    .result
                    .await
                    .expect("profile default result channel")
                    .expect("profile default execution succeeds");
                (override_result, default_result)
            })
            .await;

        assert_eq!(reservations_after.get(), 2);
        assert_eq!(
            override_result
                .text
                .matches("profiled-a4aa-fixture:request-model:request-effort")
                .count(),
            1,
            "the explicit override operation reaches the fixture once"
        );
        assert_eq!(
            default_result
                .text
                .matches("profiled-a4aa-fixture:profile-model:profile-effort")
                .count(),
            1,
            "the profile default operation reaches the fixture once"
        );
        assert_eq!(override_result.stop_reason, "end_turn");
        assert_eq!(default_result.stop_reason, "end_turn");
        assert!(progress_events_after.borrow().iter().any(|(kind, text)| {
            *kind == PeerApplicationProgressKind::Message
                && text.contains("profiled-a4aa-fixture:request-model:request-effort")
        }));
        assert!(progress_events_after.borrow().iter().any(|(kind, text)| {
            *kind == PeerApplicationProgressKind::Message
                && text.contains("profiled-a4aa-fixture:profile-model:profile-effort")
        }));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reservation_authority_failures_preserve_engine_recovery_semantics() {
        let temp_dir = tempfile::tempdir().expect("temporary fixture directory");
        let reservation_path = temp_dir.path().join("reserved");
        let executor = ProfiledAgentExecutor::new(
            AcpAgentSummary {
                id: "review-profile".to_owned(),
                display_name: "Review profile".to_owned(),
                description: None,
                enabled: true,
                detected: None,
                transport: Some("cli".to_owned()),
            },
            fixture_registry(reservation_path.clone()),
            "review-profile".to_owned(),
            Arc::new(a4aa::NoSecrets),
        );
        LocalSet::new()
            .run_until(async {
                for code in [
                    "peer_application_authority_unavailable",
                    "peer_application_route_revoked",
                ] {
                    let execution = executor.start(
                        "authority-operation",
                        "user task",
                        None,
                        None,
                        PeerApplicationExecutionHandlers {
                            before_prompt: Box::new(move || {
                                Box::pin(async move { Err(entry_error(code, "authority changed")) })
                            }),
                            on_progress: Box::new(|_, _| {
                                panic!("an unreserved turn must not emit Agent progress")
                            }),
                            request_permission: Box::new(|_| {
                                panic!("an unreserved turn must not request permission")
                            }),
                        },
                    );
                    let error = execution
                        .result
                        .await
                        .expect("execution completes")
                        .expect_err("authority failure aborts before Agent spawn");
                    assert_eq!(error.code, code);
                    assert!(!reservation_path.exists());
                }
            })
            .await;
    }

    #[test]
    fn permission_projection_preserves_meshrix_decision_fields() {
        let projected = public_permission(permission_fixture());
        assert_eq!(projected.session_id, "session-1");
        assert_eq!(projected.tool_call.tool_call_id, "tool-1");
        assert_eq!(projected.tool_call.name.as_deref(), Some("write_file"));
        assert_eq!(projected.tool_call.status.as_deref(), Some("pending"));
        assert_eq!(
            projected.tool_call.raw_input,
            Some(json!({"path": "notes.md"}))
        );
        assert_eq!(projected.tool_call.locations[0].line, Some(4));
        assert_eq!(projected.options[0].option_id, "allow-once");
    }

    #[test]
    fn unsupported_explicit_turn_selectors_fail_closed() {
        let profile_id = "unsupported-profile";
        let registry = awp::Registry::from_document(awp::RegistryDocument {
            agents: BTreeMap::from([(
                "unsupported-agent".to_string(),
                a4aa::AgentSpec {
                    id: "unsupported-agent".to_string(),
                    client_name: None,
                    lane: a4aa::LaneSpec::Cli(Box::default()),
                    command: a4aa::CommandSpec {
                        program: "unused-fixture-agent".to_string(),
                        ..Default::default()
                    },
                    max_output_bytes: None,
                },
            )]),
            profiles: BTreeMap::from([(
                profile_id.to_string(),
                awp::ProfilePatch {
                    agent: Some("unsupported-agent".to_string()),
                    ..Default::default()
                },
            )]),
            bindings: BTreeMap::new(),
        })
        .expect("valid AwP registry");
        let agent = registry.resolve(profile_id).expect("valid fixture profile");

        let model_error = validate_request_selectors(&agent, Some("model"), None)
            .expect_err("model selectors without a lane consumer must fail closed");
        assert_eq!(model_error.code, "agent_model_unsupported");
        let effort_error = validate_request_selectors(&agent, None, Some("high"))
            .expect_err("effort selectors without a lane consumer must fail closed");
        assert_eq!(effort_error.code, "agent_effort_unsupported");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn permission_bridge_returns_only_the_meshrix_selection() {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let bridge = PermissionBridge { sender };
        let decision = LocalSet::new()
            .run_until(async move {
                let decision = tokio::task::spawn_local(async move {
                    a4aa::PermissionHandler::decide(&bridge, permission_fixture()).await
                });
                let BridgeEvent::Permission(prompt, reply) = receiver
                    .recv()
                    .await
                    .expect("permission reaches the Meshrix handler")
                else {
                    panic!("permission bridge emitted a different event");
                };
                assert_eq!(prompt.tool_call.tool_call_id, "tool-1");
                reply
                    .send(AcpPermissionResolution::Selected {
                        option_id: "allow-once".to_string(),
                    })
                    .expect("Meshrix decision reaches A4AA");
                decision.await.expect("permission bridge task")
            })
            .await;

        match decision {
            a4aa::PermissionDecision::Selected(option_id) => {
                assert_eq!(option_id, "allow-once")
            }
            a4aa::PermissionDecision::Cancelled => {
                panic!("an explicit Meshrix selection must not be cancelled")
            }
        }
    }

    fn permission_fixture() -> a4aa::PermissionPrompt {
        a4aa::PermissionPrompt {
            session_id: "session-1".to_string(),
            tool_call_id: "tool-1".to_string(),
            title: "Write file".to_string(),
            kind: Some("edit".to_string()),
            content_texts: vec!["change summary".to_string()],
            options: vec![(
                "allow-once".to_string(),
                "Allow once".to_string(),
                "allow_once".to_string(),
            )],
            raw: json!({
                "toolCall": {
                    "name": "write_file",
                    "status": "pending",
                    "rawInput": {"path": "notes.md"},
                    "locations": [{"path": "notes.md", "line": 4}]
                }
            }),
        }
    }

    fn fixture_registry(reservation_path: PathBuf) -> Rc<awp::Registry> {
        let executable = std::env::current_exe().expect("test executable path");
        let mut environment = BTreeMap::new();
        environment.insert(
            FIXTURE_ENABLED.to_string(),
            EnvValue::Literal("1".to_string()),
        );
        environment.insert(
            FIXTURE_RESERVATION.to_string(),
            EnvValue::Literal(reservation_path.display().to_string()),
        );

        let agent = AgentSpec {
            id: "fixture-agent".to_string(),
            client_name: None,
            lane: LaneSpec::Cli(Box::new(CliLaneSpec {
                prompt_channel: PromptChannel::Stdin,
                stdin_template: Some(json!({
                    "prompt": "{prompt}",
                    "model": "{model}",
                    "effort": "{effort}"
                })),
                ..Default::default()
            })),
            command: CommandSpec {
                program: executable.display().to_string(),
                args: vec![
                    "--exact".to_string(),
                    "agent::executor::tests::a4aa_awp_fixture_agent".to_string(),
                    "--nocapture".to_string(),
                ],
                cwd: std::env::current_dir().ok(),
                env: EnvPolicy::Sanitized {
                    inherit: Vec::new(),
                    set: environment,
                },
            },
            max_output_bytes: None,
        };
        let document = RegistryDocument {
            agents: BTreeMap::from([("fixture-agent".to_string(), agent)]),
            profiles: BTreeMap::from([(
                "review-profile".to_string(),
                ProfilePatch {
                    name: Some("Review profile".to_string()),
                    agent: Some("fixture-agent".to_string()),
                    model: Some("profile-model".to_string()),
                    effort: Some("profile-effort".to_string()),
                    instructions: Some("Profile instructions".to_string()),
                    ..Default::default()
                },
            )]),
            bindings: BTreeMap::new(),
        };
        Rc::new(awp::Registry::from_document(document).expect("valid fixture registry"))
    }

    fn fixture_handlers(
        reservation_path: PathBuf,
        reservations: Rc<Cell<usize>>,
        progress_events: Rc<RefCell<Vec<(PeerApplicationProgressKind, String)>>>,
    ) -> PeerApplicationExecutionHandlers {
        PeerApplicationExecutionHandlers {
            before_prompt: Box::new(move || {
                let reservations = reservations.clone();
                let reservation_path = reservation_path.clone();
                Box::pin(async move {
                    std::fs::write(&reservation_path, b"reserved")
                        .map_err(|_| entry_error("fixture_reservation_failed", "fixture"))?;
                    reservations.set(reservations.get() + 1);
                    Ok(())
                }) as LocalBoxFuture<'static, Result<()>>
            }),
            on_progress: Box::new(move |kind, text| {
                let progress_events = progress_events.clone();
                Box::pin(async move {
                    progress_events.borrow_mut().push((kind, text));
                    Ok(())
                }) as LocalBoxFuture<'static, Result<()>>
            }),
            request_permission: Box::new(|_| {
                Box::pin(async { AcpPermissionResolution::Cancelled })
                    as LocalBoxFuture<'static, AcpPermissionResolution>
            }),
        }
    }
}
