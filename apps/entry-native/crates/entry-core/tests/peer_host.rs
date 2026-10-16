//! PeerHost integration — the dedicated current-thread runtime owning all
//! `!Send` peer objects behind a thread-safe channel facade. These tests
//! exercise the AwP profile API, explicit A4AA card enrollment, and actor
//! persistence without a live relay session or real Agent execution.

use meshrix_entry_core::peer::host::{PeerHost, PeerHostOptions};
use meshrix_entry_core::peer::PeerApplicationRouteAuthority;
use std::sync::Arc;

struct NoSecrets;

#[async_trait::async_trait]
impl a4aa::SecretResolver for NoSecrets {
    async fn resolve(&self, _reference: &str) -> Option<String> {
        None
    }
}

fn spawn_host(agent_root: std::path::PathBuf) -> Arc<PeerHost> {
    PeerHost::spawn(PeerHostOptions {
        agent_root,
        secret_resolver: Arc::new(NoSecrets),
        authority_resolver: Arc::new(|_| PeerApplicationRouteAuthority::Unavailable),
        connection_sessions: Arc::new(|_| false),
        agents_override: None,
    })
    .expect("peer host spawns")
}

#[test]
fn host_exposes_explicit_awp_profile_management() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let agent_root = dir.path().join("personal-agent");
        let host = spawn_host(agent_root);

        // A4AA cards are read-only templates; an empty document has no
        // saved AgentSpecs or callable profiles.
        assert!(host.agent_specs().await.unwrap().is_empty());
        assert!(host.profiles().await.unwrap().is_empty());
        assert!(host.local_agents().await.unwrap().is_empty());

        let cards = host.agent_cards().await.unwrap();
        let card = cards
            .iter()
            .find(|card| card.callable)
            .expect("A4AA publishes callable card descriptors");
        assert!(!card.enrolled);

        // Enrollment is the explicit write that creates both the A4AA
        // AgentSpec and the AwP profile. The wire selection id is the
        // unchanged profile id.
        let profile = host.profile_enroll(&card.id).await.unwrap();
        assert!(host
            .agent_specs()
            .await
            .unwrap()
            .iter()
            .any(|spec| spec.id == profile.agent));
        assert!(host
            .profiles()
            .await
            .unwrap()
            .iter()
            .any(|saved| saved.id == profile.id));
        let summaries = host.local_agents().await.unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, profile.id);

        let renamed = host
            .profile_upsert(
                &profile.id,
                awp::ProfilePatch {
                    name: Some("Renamed profile".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(renamed.name, "Renamed profile");
        assert!(host.profile_set_enabled(&profile.id, false).await.unwrap());
        let disabled = host.local_agents().await.unwrap();
        assert_eq!(disabled[0].id, profile.id);
        assert!(!disabled[0].enabled);
        assert!(host.profile_remove(&profile.id).await.unwrap());
        assert!(host.profiles().await.unwrap().is_empty());
        assert!(host.local_agents().await.unwrap().is_empty());

        // Operations remain durable-empty and readable without a peer.
        assert!(host.list_operations().await.unwrap().is_empty());
        assert!(host.get_operation("missing").await.unwrap().is_none());
        host.shutdown().await;
    });
}

#[test]
fn profile_ids_survive_peer_host_restart() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let agent_root = dir.path().join("personal-agent");
        let host = spawn_host(agent_root.clone());
        let card = host
            .agent_cards()
            .await
            .unwrap()
            .into_iter()
            .filter(|card| card.callable)
            .next()
            .expect("A4AA publishes callable card descriptors");
        let profile = host.profile_enroll(&card.id).await.unwrap();
        let profile_id = profile.id.clone();
        host.shutdown().await;

        let host2 = spawn_host(agent_root);
        let profiles = host2.profiles().await.unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, profile_id);
        let agents = host2.local_agents().await.unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, profile_id);
        host2.shutdown().await;
    });
}

#[test]
fn unattached_connection_errors_are_explicit() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let host = spawn_host(dir.path().join("personal-agent"));
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
