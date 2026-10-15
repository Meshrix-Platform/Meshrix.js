//! Real-process verification for `AcpSubprocessExecutor`: a minimal ndJSON
//! ACP agent (initialize → session/new → session/prompt with an
//! `agent_message_chunk` update) runs as an actual child process over piped
//! stdio — the exact wire the production executor speaks.

use futures_util::future::LocalBoxFuture;
use meshrix_entry_core::agent::executor::AcpSubprocessExecutor;
use meshrix_entry_core::agent::registry::{
    AcpAgentDefinition, AcpAgentSecretResolver,
};
use meshrix_entry_core::peer::application_engine::{
    PeerApplicationAgentExecutor, PeerApplicationExecutionHandlers,
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

struct NoSecrets;
impl AcpAgentSecretResolver for NoSecrets {
    fn resolve(&self, _reference: &str) -> LocalBoxFuture<'static, Option<String>> {
        Box::pin(async { None })
    }
}

/// Minimal ACP agent: answers `initialize`/`session/new`, echoes the prompt
/// back as an `agent_message_chunk` update, then closes with `end_turn`.
const FAKE_AGENT: &str = r#"
import json, sys

def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()

session_id = "sess.fake.1"
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    method = msg.get("method")
    mid = msg.get("id")
    params = msg.get("params") or {}
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid,
              "result": {"protocolVersion": 1, "agentCapabilities": {},
                         "authMethods": []}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": session_id}})
    elif method == "session/prompt":
        text = "".join(b.get("text", "") for b in params.get("prompt", [])
                       if b.get("type") == "text")
        send({"jsonrpc": "2.0", "method": "session/update",
              "params": {"sessionId": session_id,
                         "update": {"sessionUpdate": "agent_message_chunk",
                                    "content": {"type": "text",
                                                "text": "pong:" + text}}}})
        send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": None})
"#;

#[tokio::test(flavor = "current_thread")]
async fn acp_subprocess_executor_roundtrips_prompt() {
    if std::process::Command::new("python3")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("python3 unavailable — skipping real-process check");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fake_agent.py");
    std::fs::write(&script, FAKE_AGENT).unwrap();

    let executor = AcpSubprocessExecutor::new(
        AcpAgentDefinition {
            id: "agent.fake".into(),
            display_name: "Fake".into(),
            description: None,
            command: "python3".into(),
            args: vec![script.display().to_string()],
            cwd: dir.path().to_path_buf(),
            environment: BTreeMap::new(),
            permission_policy: "default".into(),
            enabled: true,
        },
        Arc::new(NoSecrets),
    );

    let progress_log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let progress = progress_log.clone();
    let local = tokio::task::LocalSet::new();
    local
        .run_until(async move {
            let execution = executor.start(
                "op.test.1",
                "hello",
                PeerApplicationExecutionHandlers {
                    before_prompt: Box::new(|| Box::pin(async { Ok(()) })),
                    on_progress: Box::new(move |kind, text| {
                        let progress = progress.clone();
                        Box::pin(async move {
                            progress.lock().unwrap().push(format!("{kind:?}:{text}"));
                            Ok(())
                        })
                    }),
                    request_permission: Box::new(|_| {
                        Box::pin(async {
                            meshrix_entry_core::peer::application::AcpPermissionResolution::Cancelled
                        })
                    }),
                },
            );
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(20),
                execution.result,
            )
            .await
            .expect("agent run timed out")
            .unwrap()
            .unwrap();
            assert_eq!(result.stop_reason, "end_turn");
            assert_eq!(result.text, "pong:hello");
        })
        .await;

    let log = progress_log.lock().unwrap();
    assert!(log.iter().any(|l| l.starts_with("Message:")), "no message progress observed: {log:?}");
}
