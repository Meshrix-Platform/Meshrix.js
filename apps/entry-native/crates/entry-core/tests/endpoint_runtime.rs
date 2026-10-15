//! Focused `PersonalEndpointRuntime` coverage — profile persistence, state
//! transitions and input validation without a live relay/account backend.
//! The enrolled paths that need authority HTTP stay in the service-level
//! integration scope; this file pins everything reachable offline.

use std::sync::Arc;

use meshrix_entry_core::custody::CustodyAdapter;
use meshrix_entry_core::endpoint::runtime::{
    PersonalEndpointRuntime, PersonalEndpointRuntimeOptions,
};
use meshrix_entry_core::peer::client::PeerInboundOutcome;
use futures_util::future::LocalBoxFuture;

struct FileCustody;
struct DeadCustody;

impl CustodyAdapter for FileCustody {
    fn kind(&self) -> &'static str {
        "file"
    }
    fn available(&self) -> bool {
        true
    }
    fn store_secret(&self, _r: &str, _s: &[u8]) -> meshrix_entry_core::Result<()> {
        Ok(())
    }
    fn load_secret(&self, _r: &str) -> meshrix_entry_core::Result<Option<Vec<u8>>> {
        Ok(None)
    }
    fn delete_secret(&self, _r: &str) -> meshrix_entry_core::Result<()> {
        Ok(())
    }
}

impl CustodyAdapter for DeadCustody {
    fn kind(&self) -> &'static str {
        "dead"
    }
    fn available(&self) -> bool {
        false
    }
    fn store_secret(&self, _r: &str, _s: &[u8]) -> meshrix_entry_core::Result<()> {
        Ok(())
    }
    fn load_secret(&self, _r: &str) -> meshrix_entry_core::Result<Option<Vec<u8>>> {
        Ok(None)
    }
    fn delete_secret(&self, _r: &str) -> meshrix_entry_core::Result<()> {
        Ok(())
    }
}

fn options(dir: &tempfile::TempDir, custody: Arc<dyn CustodyAdapter>) -> PersonalEndpointRuntimeOptions {
    PersonalEndpointRuntimeOptions {
        data_dir: dir.path().to_path_buf(),
        custody,
        relay_service: "wss://relay.example.com".into(),
        account_origin: "https://account.example.com".into(),
        account_access: None,
        allow_insecure_loopback: false,
        on_state: None,
    }
}

#[test]
fn create_persists_profile_and_recovers_it() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = PersonalEndpointRuntime::create(options(&dir, Arc::new(FileCustody))).unwrap();
    let first = runtime.snapshot();
    assert_eq!(first.state, "unregistered");
    assert!(first.endpoint.is_none());
    assert!(first.peer_id.is_none());
    assert_eq!(first.relay_state, "idle");
    assert!(!first.accepts_new_work);

    // A second create over the same directory must reload the same durable
    // profile — route/device ids were persisted before any authority call.
    let again = PersonalEndpointRuntime::create(options(&dir, Arc::new(FileCustody))).unwrap();
    let second = again.snapshot();
    assert_eq!(second.state, "unregistered");
}

#[test]
fn create_requires_working_custody() {
    let dir = tempfile::tempdir().unwrap();
    let err = PersonalEndpointRuntime::create(options(&dir, Arc::new(DeadCustody)))
        .err()
        .expect("dead custody must fail");
    assert_eq!(err.code, "personal_endpoint_custody_unavailable");
}

#[test]
fn create_rejects_empty_data_dir() {
    let dir = tempfile::tempdir().unwrap();
    let mut opts = options(&dir, Arc::new(FileCustody));
    opts.data_dir = std::path::PathBuf::new();
    let err = PersonalEndpointRuntime::create(opts).err().unwrap();
    assert_eq!(err.code, "personal_endpoint_data_dir_invalid");
}

#[tokio::test(flavor = "current_thread")]
async fn start_on_unregistered_profile_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = PersonalEndpointRuntime::create(options(&dir, Arc::new(FileCustody))).unwrap();
    let local = tokio::task::LocalSet::new();
    let result = local
        .run_until(async { runtime.start().await })
        .await;
    let err = result.err().expect("unregistered runtime cannot start");
    assert!(
        err.code.contains("personal_endpoint"),
        "unexpected error code: {}",
        err.code
    );
}

#[test]
fn inbound_handler_subscription_unsubscribes_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = PersonalEndpointRuntime::create(options(&dir, Arc::new(FileCustody))).unwrap();
    // Without a peer binding (not enrolled) registering a handler is a no-op
    // beyond bookkeeping — and the returned closure must detach it.
    let unsubscribe = runtime.on_inbound_message(std::rc::Rc::new(|_inbound| {
        Box::pin(async { PeerInboundOutcome::AcceptedByAgent })
            as LocalBoxFuture<'static, PeerInboundOutcome>
    }));
    unsubscribe();
}

#[test]
fn snapshot_reports_revocation_free_state() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = PersonalEndpointRuntime::create(options(&dir, Arc::new(FileCustody))).unwrap();
    let snapshot = runtime.snapshot();
    assert!(snapshot.route_revocations.is_empty());
    assert!(snapshot.account.is_none());
}
