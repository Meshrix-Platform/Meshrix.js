//! Deterministic process-boundary coverage for the AwP/A4AA Peer executor.
//!
//! The Antigravity case uses the maintained card and replaces only its
//! executable with a shell fixture. The ACP case uses a minimal local agent
//! to exercise Meshrix's explicit permission roundtrip through A4AA.

#[cfg(unix)]
use a4aa::{AgentSpec, CommandSpec, EnvPolicy, EnvValue, LaneSpec};
#[cfg(unix)]
use awp::{ProfilePatch, Registry, RegistryDocument};
#[cfg(unix)]
use futures_util::future::LocalBoxFuture;
#[cfg(unix)]
use meshrix_entry_core::agent::executor::ProfiledAgentExecutor;
#[cfg(unix)]
use meshrix_entry_core::agent::registry::FileAgentProfileRegistry;
#[cfg(unix)]
use meshrix_entry_core::peer::application::{AcpAgentSummary, AcpPermissionResolution};
#[cfg(unix)]
use meshrix_entry_core::peer::application_engine::{
    PeerApplicationAgentDirectory, PeerApplicationAgentExecutor, PeerApplicationExecutionHandlers,
    PeerApplicationProgressKind,
};
#[cfg(unix)]
use std::cell::{Cell, RefCell};
#[cfg(unix)]
use std::collections::BTreeMap;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::rc::Rc;
#[cfg(unix)]
use std::sync::Arc;
#[cfg(unix)]
use tokio::task::LocalSet;

#[cfg(unix)]
const RESERVATION_ENV: &str = "MESHRIX_EXECUTOR_RESERVATION";

#[cfg(unix)]
struct RestorePath(Option<std::ffi::OsString>);

#[cfg(unix)]
impl Drop for RestorePath {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            std::env::set_var("PATH", path);
        } else {
            std::env::remove_var("PATH");
        }
    }
}

#[cfg(unix)]
fn prepend_path(directory: &std::path::Path) -> RestorePath {
    let previous = std::env::var_os("PATH");
    let mut paths = vec![directory.to_path_buf()];
    if let Some(path) = previous.as_ref() {
        paths.extend(std::env::split_paths(path));
    }
    std::env::set_var(
        "PATH",
        std::env::join_paths(paths).expect("temporary executable path joins"),
    );
    RestorePath(previous)
}

#[cfg(unix)]
const ACP_AGENT: &str = r#"
import json, os, sys

def send(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()

session_id = "session.fixture.1"
for line in sys.stdin:
    try:
        message = json.loads(line)
    except Exception:
        continue
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": []
        }})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"sessionId": session_id}})
    elif method == "session/prompt":
        marker = os.environ["MESHRIX_EXECUTOR_RESERVATION"]
        if not os.path.isfile(marker):
            sys.exit(31)
        prompt = "".join(block.get("text", "") for block in params.get("prompt", [])
                         if block.get("type") == "text")
        send({"jsonrpc": "2.0", "id": 9000,
              "method": "session/request_permission", "params": {
                  "sessionId": session_id,
                  "toolCall": {
                      "toolCallId": "fixture-call-1",
                      "title": "Fixture tool call",
                      "kind": "execute",
                      "content": [],
                      "locations": []
                  },
                  "options": [
                      {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                      {"optionId": "deny", "name": "Deny", "kind": "reject_once"}
                  ]
              }})
        try:
            response = json.loads(sys.stdin.readline())
        except Exception:
            sys.exit(32)
        outcome = ((response.get("result") or {}).get("outcome") or {})
        allowed = (response.get("id") == 9000
                   and outcome.get("outcome") == "selected"
                   and outcome.get("optionId") == "allow-once")
        text = ("approved: " if allowed else "denied: ") + prompt
        send({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": session_id,
            "update": {"sessionUpdate": "agent_message_chunk",
                       "content": {"type": "text", "text": text}}
        }})
        send({"jsonrpc": "2.0", "id": request_id, "result": {
            "stopReason": "end_turn" if allowed else "refusal"
        }})
    elif request_id is not None:
        send({"jsonrpc": "2.0", "id": request_id, "result": None})
"#;

#[cfg(unix)]
const ANTIGRAVITY_SHELL_FIXTURE: &str = r#"
prompt=''
model=''
effort=''
mode=''
format=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --print) prompt=$2; shift 2 ;;
    --output-format) format=$2; shift 2 ;;
    --model) model=$2; shift 2 ;;
    --effort) effort=$2; shift 2 ;;
    --mode) mode=$2; shift 2 ;;
    *) shift ;;
  esac
done
expected_prompt='Profile instructions

user task'
[ "$prompt" = "$expected_prompt" ] || exit 41
[ "$format" = "stream-json" ] || exit 42
[ "$model" = "request-model" ] || [ "$model" = "profile-model" ] || exit 43
[ "$effort" = "request-effort" ] || [ "$effort" = "profile-effort" ] || exit 44
[ "$mode" = "plan" ] || exit 45
[ -f "reserved" ] || exit 46
printf '%s\n' '{"event":"init","conversation_id":"fixture-conversation"}'
printf '{"event":"result","result":{"response":"model=%s;effort=%s;mode=%s"}}\n' "$model" "$effort" "$mode"
"#;

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn antigravity_card_executes_through_awp_and_meshrix_bridge() {
    let card = a4aa_dialects::card("antigravity").expect("maintained Antigravity card");
    assert!(card.features.permission_modes.is_empty());
    assert_eq!(card.features.permission_default, None);
    assert!(matches!(&card.spec().lane, LaneSpec::Cli(_)));
    assert!(
        !a4aa::Adapter::new(card.spec())
            .capabilities()
            .permission_prompts
    );
    let temp_dir = tempfile::tempdir().expect("temporary fixture directory");
    let bin_dir = temp_dir.path().join("bin");
    std::fs::create_dir_all(&bin_dir).expect("create fixture executable directory");
    let script_path = bin_dir.join("agy");
    std::fs::write(&script_path, ANTIGRAVITY_SHELL_FIXTURE)
        .expect("write deterministic Antigravity CLI fixture");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755))
        .expect("make deterministic CLI fixture executable");
    let _restore_path = prepend_path(&bin_dir);

    let reservation_path = temp_dir.path().join("reserved");
    let registry = FileAgentProfileRegistry::new(
        temp_dir.path().join("agents.json"),
        Arc::new(a4aa::NoSecrets),
    )
    .expect("production FileAgentProfileRegistry opens");
    let antigravity = registry
        .available_agent_cards()
        .expect("A4AA cards are available")
        .into_iter()
        .find(|card| card.id == "antigravity")
        .expect("Antigravity card is available");
    assert!(antigravity.permission_modes.is_empty());
    assert_eq!(antigravity.permission_default, None);
    registry
        .enroll_card("antigravity")
        .await
        .expect("explicitly enroll the maintained A4AA card");
    let profile_id = "profile.antigravity-review";
    let profile = registry
        .upsert_profile(
            profile_id,
            ProfilePatch {
                name: Some("Antigravity review".to_string()),
                agent: Some("antigravity".to_string()),
                model: Some("profile-model".to_string()),
                effort: Some("profile-effort".to_string()),
                mode: Some("plan".to_string()),
                instructions: Some("Profile instructions".to_string()),
                cwd: Some(temp_dir.path().to_path_buf()),
                ..Default::default()
            },
        )
        .await
        .expect("save a named AwP profile");
    assert_eq!(profile.id, profile_id);
    assert_eq!(profile.agent, "antigravity");
    let executor = registry
        .get(profile_id)
        .expect("production Peer directory resolves the named profile");
    let reservations = Rc::new(Cell::new(0));
    let permission_requests = Rc::new(Cell::new(0));
    let reservations_after = reservations.clone();
    let permission_requests_after = permission_requests.clone();

    let (default_result, override_result) = LocalSet::new()
        .run_until(async move {
            let default_execution = executor.start(
                "antigravity-operation",
                "user task",
                None,
                None,
                handlers(
                    reservation_path.clone(),
                    reservations.clone(),
                    permission_requests.clone(),
                    Rc::new(RefCell::new(Vec::new())),
                    AcpPermissionResolution::Cancelled,
                ),
            );
            let default_result = default_execution
                .result
                .await
                .expect("profile-default result channel");
            let override_execution = executor.start(
                "antigravity-operation-override",
                "user task",
                Some("request-model".to_string()),
                Some("request-effort".to_string()),
                handlers(
                    reservation_path,
                    reservations.clone(),
                    permission_requests.clone(),
                    Rc::new(RefCell::new(Vec::new())),
                    AcpPermissionResolution::Cancelled,
                ),
            );
            let override_result = override_execution
                .result
                .await
                .expect("turn-override result channel");
            (default_result, override_result)
        })
        .await;
    let default_result = default_result.expect("profile defaults execute");
    let override_result = override_result.expect("explicit turn overrides execute");

    assert_eq!(default_result.stop_reason, "end_turn");
    assert_eq!(
        default_result.text,
        "model=profile-model;effort=profile-effort;mode=plan"
    );
    assert_eq!(override_result.stop_reason, "end_turn");
    assert_eq!(
        override_result.text,
        "model=request-model;effort=request-effort;mode=plan"
    );
    assert_eq!(reservations_after.get(), 2);
    assert_eq!(permission_requests_after.get(), 0);
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn acp_permission_roundtrip_uses_meshrix_selection() {
    let temp_dir = tempfile::tempdir().expect("temporary fixture directory");
    let script = temp_dir.path().join("permission_agent.py");
    std::fs::write(&script, ACP_AGENT).expect("write local ACP fixture");
    let reservation_path = temp_dir.path().join("reserved");
    let mut agent_env = BTreeMap::new();
    agent_env.insert(
        RESERVATION_ENV.to_string(),
        EnvValue::Literal(reservation_path.display().to_string()),
    );
    let agent = AgentSpec {
        id: "fixture-acp".to_string(),
        client_name: Some("Meshrix bridge test".to_string()),
        lane: LaneSpec::Acp {
            mcp_servers: Vec::new(),
            prefer_load: false,
        },
        command: CommandSpec {
            program: "python3".to_string(),
            args: vec![script.display().to_string()],
            cwd: Some(temp_dir.path().to_path_buf()),
            env: EnvPolicy::Sanitized {
                inherit: Vec::new(),
                set: agent_env,
            },
        },
        max_output_bytes: None,
    };
    let profile_id = "fixture-acp-profile";
    let registry = Registry::from_document(RegistryDocument {
        agents: BTreeMap::from([(agent.id.clone(), agent)]),
        profiles: BTreeMap::from([(
            profile_id.to_string(),
            ProfilePatch {
                name: Some("Fixture ACP profile".to_string()),
                agent: Some("fixture-acp".to_string()),
                instructions: Some("Profile instructions".to_string()),
                ..Default::default()
            },
        )]),
        bindings: BTreeMap::new(),
    })
    .expect("valid AwP profile registry");
    let executor = ProfiledAgentExecutor::new(
        summary(profile_id, "Fixture ACP profile", "acp"),
        Rc::new(registry),
        profile_id.to_string(),
        Arc::new(a4aa::NoSecrets),
    );
    let reservations = Rc::new(Cell::new(0));
    let permission_requests = Rc::new(Cell::new(0));
    let progress = Rc::new(RefCell::new(Vec::new()));
    let reservations_after = reservations.clone();
    let permission_requests_after = permission_requests.clone();
    let progress_after = progress.clone();

    let result = LocalSet::new()
        .run_until(async move {
            let execution = executor.start(
                "acp-permission-operation",
                "hello",
                None,
                None,
                handlers(
                    reservation_path,
                    reservations.clone(),
                    permission_requests.clone(),
                    progress.clone(),
                    AcpPermissionResolution::Selected {
                        option_id: "allow-once".to_string(),
                    },
                ),
            );
            execution.result.await.expect("executor result channel")
        })
        .await
        .expect("ACP permission roundtrip succeeds");

    assert_eq!(result.stop_reason, "end_turn");
    assert_eq!(result.text, "approved: Profile instructions\n\nhello");
    assert_eq!(reservations_after.get(), 1);
    assert_eq!(permission_requests_after.get(), 1);
    assert!(progress_after.borrow().iter().any(|(kind, text)| {
        *kind == PeerApplicationProgressKind::Message
            && text == "approved: Profile instructions\n\nhello"
    }));
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn unsupported_turn_selectors_fail_before_reservation() {
    let temp_dir = tempfile::tempdir().expect("temporary fixture directory");
    let reservation_path = temp_dir.path().join("reserved");
    let spec = AgentSpec {
        id: "no-selector-agent".to_string(),
        client_name: None,
        lane: LaneSpec::Cli(Box::default()),
        command: CommandSpec {
            program: temp_dir.path().join("must-not-start").display().to_string(),
            cwd: Some(temp_dir.path().to_path_buf()),
            ..Default::default()
        },
        max_output_bytes: None,
    };
    let profile_id = "no-selector-profile";
    let registry = Registry::from_document(RegistryDocument {
        agents: BTreeMap::from([(spec.id.clone(), spec)]),
        profiles: BTreeMap::from([(
            profile_id.to_string(),
            ProfilePatch {
                agent: Some("no-selector-agent".to_string()),
                ..Default::default()
            },
        )]),
        bindings: BTreeMap::new(),
    })
    .expect("valid AwP profile registry");
    let executor = ProfiledAgentExecutor::new(
        summary(profile_id, "No selector", "cli"),
        Rc::new(registry),
        profile_id.to_string(),
        Arc::new(a4aa::NoSecrets),
    );
    let reservations = Rc::new(Cell::new(0));
    let reservations_after = reservations.clone();
    let permissions = Rc::new(Cell::new(0));
    let permissions_after = permissions.clone();
    let progress = Rc::new(RefCell::new(Vec::new()));

    let result = LocalSet::new()
        .run_until(async move {
            let execution = executor.start(
                "unsupported-selector-operation",
                "must not run",
                Some("model".to_string()),
                Some("high".to_string()),
                handlers(
                    reservation_path,
                    reservations,
                    permissions,
                    progress,
                    AcpPermissionResolution::Cancelled,
                ),
            );
            execution.result.await.expect("executor result channel")
        })
        .await
        .expect_err("unapplied model and effort are rejected");

    assert_eq!(result.code, "agent_model_unsupported");
    assert_eq!(reservations_after.get(), 0);
    assert_eq!(permissions_after.get(), 0);
}

#[cfg(unix)]
fn summary(profile_id: &str, name: &str, transport: &str) -> AcpAgentSummary {
    AcpAgentSummary {
        id: profile_id.to_string(),
        display_name: name.to_string(),
        description: None,
        enabled: true,
        detected: None,
        transport: Some(transport.to_string()),
    }
}

#[cfg(unix)]
fn handlers(
    reservation_path: PathBuf,
    reservations: Rc<Cell<usize>>,
    permission_requests: Rc<Cell<usize>>,
    progress: Rc<RefCell<Vec<(PeerApplicationProgressKind, String)>>>,
    permission_resolution: AcpPermissionResolution,
) -> PeerApplicationExecutionHandlers {
    PeerApplicationExecutionHandlers {
        before_prompt: Box::new(move || {
            let reservations = reservations.clone();
            let reservation_path = reservation_path.clone();
            Box::pin(async move {
                std::fs::write(&reservation_path, b"reserved")
                    .expect("write durable reservation marker before prompt");
                reservations.set(reservations.get() + 1);
                Ok(())
            }) as LocalBoxFuture<'static, meshrix_entry_core::Result<()>>
        }),
        on_progress: Box::new(move |kind, text| {
            let progress = progress.clone();
            Box::pin(async move {
                progress.borrow_mut().push((kind, text));
                Ok(())
            }) as LocalBoxFuture<'static, meshrix_entry_core::Result<()>>
        }),
        request_permission: Box::new(move |_| {
            let permission_requests = permission_requests.clone();
            let resolution = permission_resolution.clone();
            Box::pin(async move {
                permission_requests.set(permission_requests.get() + 1);
                resolution
            }) as LocalBoxFuture<'static, AcpPermissionResolution>
        }),
    }
}
