//! PeerHost integration — the dedicated current-thread runtime owning all
//! `!Send` peer objects behind a thread-safe channel facade. These tests
//! exercise the real spawn/ready path, the registry surface and the
//! engine-facing commands without a live relay session.

use futures_util::future::LocalBoxFuture;
use meshrix_entry_core::agent::registry::{
    AcpAgentDefinitionInput, AcpAgentSecretResolver, FileAcpAgentRegistry,
};
use meshrix_entry_core::peer::application_engine::PeerApplicationAgentDirectory;
use meshrix_entry_core::peer::host::{PeerHost, PeerHostOptions};
use meshrix_entry_core::peer::PeerApplicationRouteAuthority;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::Arc;

struct NoSecrets;
impl AcpAgentSecretResolver for NoSecrets {
    fn resolve(&self, _reference: &str) -> LocalBoxFuture<'static, Option<String>> {
        Box::pin(async { None })
    }
}

/// Registry-only directory — keeps live machine detection out of tests.
fn registry_only(agent_root: std::path::PathBuf) -> impl Fn() -> Rc<dyn PeerApplicationAgentDirectory> + Send {
    move || {
        FileAcpAgentRegistry::new(agent_root.join("agents.json"), Arc::new(NoSecrets))
            .expect("registry opens") as Rc<dyn PeerApplicationAgentDirectory>
    }
}

fn spawn_host() -> (tempfile::TempDir, Arc<PeerHost>) {
    let dir = tempfile::tempdir().unwrap();
    let agent_root = dir.path().join("personal-agent");
    let host = PeerHost::spawn(PeerHostOptions {
        agent_root: agent_root.clone(),
        secret_resolver: Arc::new(NoSecrets),
        authority_resolver: Arc::new(|_| PeerApplicationRouteAuthority::Unavailable),
        connection_sessions: Arc::new(|_| false),
        agents_override: Some(Box::new(registry_only(agent_root))),
    })
    .expect("peer host spawns");
    (dir, host)
}

fn agent_input(name: &str) -> AcpAgentDefinitionInput {
    AcpAgentDefinitionInput {
        id: None,
        display_name: name.into(),
        description: Some("test agent".into()),
        command: "/bin/echo".into(),
        args: vec![],
        cwd: std::path::PathBuf::from("/tmp"),
        environment: BTreeMap::new(),
        enabled: true,
    }
}

#[test]
fn host_spawns_and_answers_local_agent_calls() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let (_dir, host) = spawn_host();

        // Empty registry by default.
        assert!(host.local_agents().await.unwrap().is_empty());

        // Register → list → remove round-trip through the actor.
        let summary = host.agent_register(agent_input("Echo")).await.unwrap();
        assert_eq!(summary.display_name, "Echo");
        assert_eq!(host.local_agents().await.unwrap().len(), 1);
        assert!(host.agent_remove(&summary.id).await.unwrap());
        assert!(host.local_agents().await.unwrap().is_empty());

        // Operations listing is durable-empty, not an error.
        assert!(host.list_operations().await.unwrap().is_empty());
        assert!(host.get_operation("missing").await.unwrap().is_none());

        host.shutdown().await;
    });
}

#[test]
fn unattached_connection_errors_are_explicit() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let (_dir, host) = spawn_host();
        let err = host
            .peer_send("conn.unknown", "dev-x", b"hi".to_vec(), None)
            .await
            .unwrap_err();
        assert_eq!(err.code, "peer_unavailable");
        let err = host.peer_status("conn.unknown").await.unwrap_err();
        assert_eq!(err.code, "peer_unavailable");
        host.shutdown().await;
    });
}

#[test]
fn registry_persists_across_host_restarts() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let (dir, host) = spawn_host();
        host.agent_register(agent_input("Persistent")).await.unwrap();
        host.shutdown().await;

        // A fresh host over the same data root sees the durable registry.
        let agent_root = dir.path().join("personal-agent");
        let host2 = PeerHost::spawn(PeerHostOptions {
            agent_root: agent_root.clone(),
            secret_resolver: Arc::new(NoSecrets),
            authority_resolver: Arc::new(|_| PeerApplicationRouteAuthority::Unavailable),
            connection_sessions: Arc::new(|_| false),
            agents_override: Some(Box::new(registry_only(agent_root))),
        })
        .unwrap();
        let agents = host2.local_agents().await.unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].display_name, "Persistent");
        host2.shutdown().await;
    });
}
