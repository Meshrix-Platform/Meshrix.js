//! `PeerApplicationEngine` — durable MCP-to-ACP operation router.
//! Port of `packages/peer-client/src/application-engine.ts`. One engine per
//! profile; route multiplexing and PeerClient lifetimes stay in the host.
//!
//! Concurrency model: everything runs on the peer runtime's single-thread
//! `LocalSet`; the TS promise-chain key locks map to `futures_util::lock`
//! `LocalMutex`es (fair FIFO), and `setImmediate` defers map to
//! `tokio::task::spawn_local`.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use futures_util::future::LocalBoxFuture;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::error::{entry_error, EntryError, Result};

use super::application::*;
use super::application_journal::PeerApplicationJournal;
use super::client::{PeerInboundOutcome, PEER_CLIENT_MAX_PLAINTEXT_BYTES};
use crate::b64::b64u_encode;
use super::client_store::StoredOutboxEntry;
use super::types::is_peer_client_error_kind;

const MAX_CONCURRENT_EXECUTIONS: usize = 2;
const MAX_QUEUED_EXECUTIONS: usize = 32;
const MAX_OUTSTANDING_EXECUTIONS: usize = MAX_CONCURRENT_EXECUTIONS + MAX_QUEUED_EXECUTIONS;
const APPLICATION_RECOVERY_RETRY_INITIAL_DELAY_MS: u64 = 1_000;
const APPLICATION_RECOVERY_RETRY_MAX_DELAY_MS: u64 = 30_000;
const APPLICATION_RECOVERY_PAGE_SIZE: usize = 32;

fn app_error(detail: &str) -> EntryError {
    entry_error("peer_client_state", detail)
}

fn transport_err(detail: &str) -> EntryError {
    entry_error("peer_client_transport", detail)
}

/* --------------------------------- ports ----------------------------------- */

/// Composition-owned route multiplexer for all per-route `PeerClient`s.
pub trait PeerApplicationPeerPort {
    /// Current local permission for this exact route, independent of socket.
    fn resolve_peer_authority<'a>(
        &'a self,
        address: &'a PeerApplicationAddress,
    ) -> LocalBoxFuture<'a, Result<PeerApplicationRouteAuthority>>;
    fn is_peer_reachable<'a>(
        &'a self,
        address: &'a PeerApplicationAddress,
    ) -> LocalBoxFuture<'a, Result<bool>>;
    fn send_message<'a>(
        &'a self,
        address: &'a PeerApplicationAddress,
        plaintext: Vec<u8>,
        message_id: String,
    ) -> LocalBoxFuture<'a, Result<StoredOutboxEntry>>;
    fn get_send_state<'a>(
        &'a self,
        address: &'a PeerApplicationAddress,
        message_id: &'a str,
    ) -> LocalBoxFuture<'a, Result<Option<String>>>;
    /// Register the engine's inbound dispatcher once, at engine construction.
    fn set_inbound_handler(
        &self,
        handler: Rc<dyn Fn(PeerApplicationInbound) -> LocalBoxFuture<'static, PeerInboundOutcome>>,
    );
    /// Retry this exact route's locally durable pending inbox after admission frees.
    fn retry_pending_inbound<'a>(
        &'a self,
        address: &'a PeerApplicationAddress,
    ) -> LocalBoxFuture<'a, Result<()>>;
}

/// Handlers the engine passes to a local ACP execution. `before_prompt` must
/// commit the durable prompt reservation before the adapter writes
/// session/prompt.
pub struct PeerApplicationExecutionHandlers {
    pub before_prompt: Box<dyn Fn() -> LocalBoxFuture<'static, Result<()>>>,
    pub on_progress:
        Box<dyn Fn(PeerApplicationProgressKind, String) -> LocalBoxFuture<'static, Result<()>>>,
    pub request_permission:
        Box<dyn Fn(AcpPermissionPrompt) -> LocalBoxFuture<'static, AcpPermissionResolution>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerApplicationProgressKind {
    State,
    Message,
    Tool,
    Plan,
}

#[derive(Debug)]
pub struct PeerApplicationExecutionResult {
    pub stop_reason: String,
    pub text: String,
}

/// One running local ACP execution. `result` is a one-shot channel — the
/// engine awaits it inside `execute`; `cancel` stays callable while running.
pub struct PeerApplicationExecution {
    pub cancel: Rc<dyn Fn() -> LocalBoxFuture<'static, ()>>,
    pub result: oneshot::Receiver<Result<PeerApplicationExecutionResult>>,
}

pub trait PeerApplicationAgentExecutor {
    fn summary(&self) -> AcpAgentSummary;
    fn start(
        &self,
        operation_id: &str,
        prompt: &str,
        model: Option<String>,
        handlers: PeerApplicationExecutionHandlers,
    ) -> PeerApplicationExecution;
}

pub trait PeerApplicationAgentDirectory {
    fn list(&self) -> LocalBoxFuture<'_, Result<Vec<AcpAgentSummary>>>;
    fn get(&self, agent_id: &str) -> Option<Rc<dyn PeerApplicationAgentExecutor>>;
}

/* --------------------------------- helpers --------------------------------- */

type ChangeListener = Box<dyn Fn(PeerApplicationChange)>;

fn safe_error_code(error: &EntryError) -> String {
    if !error.code.is_empty() {
        return error.code.clone();
    }
    "peer_application_failed".to_string()
}

fn event_detail(code: &str) -> Vec<u8> {
    code.as_bytes().to_vec()
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn make_operation_record(input: OperationRecordSeed) -> PeerApplicationRecord {
    let timestamp = now_iso();
    PeerApplicationRecord {
        version: PEER_APPLICATION_PROTOCOL_VERSION,
        key: input.key,
        operation_id: input.operation_id,
        origin_address: input.origin_address,
        route_address: input.route_address,
        role: input.role,
        caller_agent_id: input.caller_agent_id,
        target_agent_id: input.target_agent_id,
        request_digest: input.request_digest,
        prompt: input.prompt,
        model: input.model,
        status: input.status.clone(),
        prompt_reserved: false,
        prompt_execution_id: None,
        terminal_prepared: false,
        state_revision: if input.status == "accepted" { 1 } else { 0 },
        progress: None,
        result_text: None,
        result_digest: None,
        result_stop_reason: None,
        result_status: None,
        result_part_count: None,
        permission_history: Vec::new(),
        permission: None,
        cancel_requested: false,
        inbound_message_id: input.inbound_message_id,
        last_error: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    }
}

struct OperationRecordSeed {
    key: String,
    operation_id: String,
    origin_address: PeerApplicationAddress,
    route_address: PeerApplicationAddress,
    role: String,
    caller_agent_id: Option<String>,
    target_agent_id: String,
    request_digest: String,
    prompt: String,
    model: Option<String>,
    status: String,
    inbound_message_id: Option<String>,
}

/// `updateRecord` — bump `stateRevision` when `status` changes unless the
/// patch pins a revision; always refresh `updatedAt`.
fn update_record(record: &PeerApplicationRecord, patch: RecordPatch) -> PeerApplicationRecord {
    let status = patch.status.unwrap_or_else(|| record.status.clone());
    let state_revision = patch.state_revision.unwrap_or_else(|| {
        if status == record.status {
            record.state_revision
        } else {
            record.state_revision + 1
        }
    });
    let mut next = record.clone();
    next.status = status;
    next.state_revision = state_revision;
    next.updated_at = now_iso();
    if let Some(v) = patch.prompt_reserved {
        next.prompt_reserved = v;
    }
    if let Some(v) = patch.prompt_execution_id {
        next.prompt_execution_id = v;
    }
    if let Some(v) = patch.terminal_prepared {
        next.terminal_prepared = v;
    }
    if let Some(v) = patch.progress {
        next.progress = v;
    }
    if let Some(v) = patch.result_text {
        next.result_text = v;
    }
    if let Some(v) = patch.result_digest {
        next.result_digest = v;
    }
    if let Some(v) = patch.result_stop_reason {
        next.result_stop_reason = v;
    }
    if let Some(v) = patch.result_status {
        next.result_status = v;
    }
    if let Some(v) = patch.result_part_count {
        next.result_part_count = v;
    }
    if let Some(v) = patch.permission_history {
        next.permission_history = v;
    }
    if let Some(v) = patch.permission {
        next.permission = v;
    }
    if let Some(v) = patch.cancel_requested {
        next.cancel_requested = v;
    }
    if let Some(v) = patch.last_error {
        next.last_error = v;
    }
    next
}

#[derive(Default)]
struct RecordPatch {
    status: Option<String>,
    state_revision: Option<u64>,
    prompt_reserved: Option<bool>,
    prompt_execution_id: Option<Option<String>>,
    terminal_prepared: Option<bool>,
    progress: Option<Option<PeerApplicationProgress>>,
    result_text: Option<Option<String>>,
    result_digest: Option<Option<String>>,
    result_stop_reason: Option<Option<String>>,
    result_status: Option<Option<String>>,
    result_part_count: Option<Option<u64>>,
    permission_history: Option<Vec<PeerApplicationPermissionRecord>>,
    permission: Option<Option<PeerApplicationPermissionRecord>>,
    cancel_requested: Option<bool>,
    last_error: Option<Option<String>>,
}

/* --------------------------------- engine ---------------------------------- */

pub struct PeerApplicationEngineOptions {
    pub peer: Rc<dyn PeerApplicationPeerPort>,
    pub journal: Rc<dyn PeerApplicationJournal>,
    pub agents: Rc<dyn PeerApplicationAgentDirectory>,
}

struct PendingPermission {
    resolve: oneshot::Sender<AcpPermissionResolution>,
}

struct RecoveryRetry {
    running: bool,
    requested: bool,
    timer: Option<tokio::task::AbortHandle>,
    delay_ms: u64,
    operation_cursor: Option<String>,
    discovery_cursor: Option<String>,
    handoff_cursor: Option<String>,
    sweep_failed: bool,
}

/// Durable application engine; see the TS original for the state machine
/// contract this mirrors one-to-one.
pub struct PeerApplicationEngine {
    peer: Rc<dyn PeerApplicationPeerPort>,
    journal: Rc<dyn PeerApplicationJournal>,
    agents: Rc<dyn PeerApplicationAgentDirectory>,
    listeners: RefCell<Vec<ChangeListener>>,
    key_locks: RefCell<HashMap<String, Rc<tokio::sync::Mutex<()>>>>,
    deferred_routes: RefCell<HashMap<String, PeerApplicationAddress>>,
    /// key → cancel handle of a live ACP execution.
    running: RefCell<HashMap<String, Rc<dyn Fn() -> LocalBoxFuture<'static, ()>>>>,
    started: RefCell<HashSet<String>>,
    execution_queue: RefCell<Vec<String>>,
    partial_result_chunk_counts: RefCell<HashMap<String, u64>>,
    permission_waiters: RefCell<HashMap<String, PendingPermission>>,
    permission_locks: RefCell<HashMap<String, Rc<tokio::sync::Mutex<()>>>>,
    admission_lock: tokio::sync::Mutex<()>,
    execution_id: String,
    disposed: Cell<bool>,
    execution_pump_scheduled: Cell<bool>,
    recovery_retry: RefCell<RecoveryRetry>,
}

impl PeerApplicationEngine {
    pub fn new(options: PeerApplicationEngineOptions) -> Rc<Self> {
        let engine = Rc::new(Self {
            peer: options.peer,
            journal: options.journal,
            agents: options.agents,
            listeners: RefCell::new(Vec::new()),
            key_locks: RefCell::new(HashMap::new()),
            deferred_routes: RefCell::new(HashMap::new()),
            running: RefCell::new(HashMap::new()),
            started: RefCell::new(HashSet::new()),
            execution_queue: RefCell::new(Vec::new()),
            partial_result_chunk_counts: RefCell::new(HashMap::new()),
            permission_waiters: RefCell::new(HashMap::new()),
            permission_locks: RefCell::new(HashMap::new()),
            admission_lock: tokio::sync::Mutex::new(()),
            execution_id: uuid_simple_pub(),
            disposed: Cell::new(false),
            execution_pump_scheduled: Cell::new(false),
            recovery_retry: RefCell::new(RecoveryRetry {
                running: false,
                requested: false,
                timer: None,
                delay_ms: APPLICATION_RECOVERY_RETRY_INITIAL_DELAY_MS,
                operation_cursor: None,
                discovery_cursor: None,
                handoff_cursor: None,
                sweep_failed: false,
            }),
        });
        let weak = Rc::downgrade(&engine);
        engine.peer.set_inbound_handler(Rc::new(move |delivery| {
            let weak = weak.clone();
            Box::pin(async move {
                match weak.upgrade() {
                    Some(engine) => engine.handle_inbound(delivery).await,
                    None => PeerInboundOutcome::Deferred {
                        detail: event_detail("engine_disposed"),
                    },
                }
            })
        }));
        engine
    }

    pub fn on_change(&self, listener: ChangeListener) -> usize {
        let mut listeners = self.listeners.borrow_mut();
        listeners.push(listener);
        listeners.len() - 1
    }

    fn emit(&self, change: PeerApplicationChange) {
        for listener in self.listeners.borrow().iter() {
            listener(change.clone());
        }
    }

    fn defer_recovery(self: &Rc<Self>, task: impl FnOnce(Rc<Self>) -> LocalBoxFuture<'static, Result<()>> + 'static) {
        let this = Rc::clone(self);
        tokio::task::spawn_local(async move {
            if task(this.clone()).await.is_err() {
                this.schedule_recovery_retry(false, true);
            }
        });
    }

    fn key_lock(&self, key: &str) -> Rc<tokio::sync::Mutex<()>> {
        self.key_locks
            .borrow_mut()
            .entry(key.to_string())
            .or_insert_with(|| Rc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn permission_lock(&self, key: &str) -> Rc<tokio::sync::Mutex<()>> {
        self.permission_locks
            .borrow_mut()
            .entry(key.to_string())
            .or_insert_with(|| Rc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    async fn with_key_lock<R>(&self, key: &str, op: impl AsyncFnOnce() -> Result<R>) -> Result<R> {
        let lock = self.key_lock(key);
        let _guard = lock.lock().await;
        op().await
    }

    fn route_key(address: &PeerApplicationAddress) -> String {
        [
            address.tenant_id.as_str(),
            address.route_id.as_str(),
            address.local_device_id.as_str(),
            address.peer_device_id.as_str(),
        ]
        .join("\u{0}")
    }

    fn wake_deferred_routes(self: &Rc<Self>) {
        if self.disposed.get() {
            return;
        }
        let routes: Vec<PeerApplicationAddress> =
            self.deferred_routes.borrow_mut().drain().map(|(_, v)| v).collect();
        for address in routes {
            let this = Rc::clone(self);
            tokio::task::spawn_local(async move {
                let _ = this.peer.retry_pending_inbound(&address).await;
            });
        }
    }

    /// `#saveOperation` — publish recovery responsibility before the main
    /// record; a crash may leave a marker, never an accepted task without one.
    async fn save_operation(&self, record: &PeerApplicationRecord) -> Result<()> {
        let needs_recovery = if record.role == "receiver" {
            !status_terminal(&record.status)
                || record.terminal_prepared
                || record.result_part_count.is_some()
        } else {
            record.status == "delivery_pending"
                || (record.cancel_requested && !status_terminal(&record.status))
        };
        if needs_recovery {
            self.journal.save_pending_operation_recovery(record)?;
        }
        self.journal.save_operation(record)?;
        self.emit(PeerApplicationChange::Operation(record.clone()));
        Ok(())
    }

    async fn clear_operation_recovery(&self, recovery: &PeerApplicationOperationRecovery) -> Result<bool> {
        self.with_key_lock(&recovery.key, || async {
            self.journal
                .clear_pending_operation_recovery(&recovery.key, Some(recovery.state_revision))
        })
        .await
    }

    async fn clear_discovery_recovery(&self, recovery: &PeerApplicationDiscoveryRecovery) -> Result<bool> {
        self.with_key_lock(&format!("discovery:{}", recovery.key), || async {
            self.journal
                .clear_pending_discovery_recovery(&recovery.key, Some(&recovery.action))
        })
        .await
    }

    async fn caller_operation(&self, operation_id: &str) -> Result<Option<PeerApplicationRecord>> {
        let records = self.records_for_operation_id(operation_id).await?;
        let matches: Vec<_> = records.into_iter().filter(|r| r.role == "caller").collect();
        if matches.len() > 1 {
            return Err(app_error("The caller operation id is already bound to multiple requests."));
        }
        Ok(matches.into_iter().next())
    }

    async fn records_for_operation_id(&self, operation_id: &str) -> Result<Vec<PeerApplicationRecord>> {
        let keys = self.journal.find_operation_keys_by_id(operation_id)?;
        let mut records = Vec::new();
        for key in keys {
            if let Some(record) = self.journal.get_operation(&key)? {
                records.push(record);
            }
        }
        Ok(records)
    }

    async fn get_by_operation_id(&self, operation_id: &str) -> Result<Option<PeerApplicationRecord>> {
        let records = self.records_for_operation_id(operation_id).await?;
        let caller: Vec<_> = records.iter().filter(|r| r.role == "caller").collect();
        if caller.len() > 1 {
            return Err(app_error("The caller operation id is already bound to multiple requests."));
        }
        if let Some(record) = caller.into_iter().next() {
            return Ok(Some(record.clone()));
        }
        let receivers: Vec<_> = records.into_iter().filter(|r| r.role == "receiver").collect();
        if receivers.len() > 1 {
            return Err(app_error("The operation id is ambiguous across paired routes."));
        }
        Ok(receivers.into_iter().next())
    }

    pub async fn local_agents(&self) -> Result<Vec<AcpAgentSummary>> {
        self.agents.list().await
    }

    pub async fn list_operations(&self) -> Result<Vec<PeerApplicationRecord>> {
        self.journal.list_operations()
    }

    async fn count_outstanding_executions(&self) -> Result<usize> {
        let mut count = 0usize;
        let mut after: Option<String> = None;
        loop {
            let page = self
                .journal
                .list_pending_operation_recovery_page(after.as_deref(), 32)?;
            for record in &page.items {
                if record.execution_pending {
                    count += 1;
                }
            }
            after = page.next_after_key;
            if after.is_none() {
                return Ok(count);
            }
        }
    }

    pub async fn get_operation(&self, operation_id: &str) -> Result<Option<PeerApplicationRecord>> {
        let checked = assert_peer_client_opaque_id(operation_id, "operationId")?;
        self.get_by_operation_id(&checked).await
    }

    /// Reject known-offline new work before creating any durable row.
    pub async fn submit(
        self: &Rc<Self>,
        address: PeerApplicationAddress,
        operation_id: Option<String>,
        caller_agent_id: Option<String>,
        target_agent_id: String,
        prompt: String,
        model: Option<String>,
    ) -> Result<PeerApplicationRecord> {
        let operation_id = match operation_id {
            Some(id) => assert_peer_client_opaque_id(&id, "operationId")?,
            None => new_peer_application_operation_id(),
        };
        let route_address = assert_address(&address)?;
        let target_agent_id = assert_peer_client_opaque_id(&target_agent_id, "targetAgentId")?;
        let caller_agent_id = caller_agent_id
            .map(|id| assert_peer_client_opaque_id(&id, "callerAgentId"))
            .transpose()?;
        let prompt = {
            if prompt.is_empty() || prompt.len() > 32_000 {
                return Err(app_error("Peer application prompt is empty or exceeds its bound."));
            }
            prompt
        };
        let model = model
            .map(|m| assert_peer_application_string(&Value::String(m), "model", 128))
            .transpose()?;
        let digest = peer_application_request_digest(
            &route_address,
            caller_agent_id.as_deref(),
            &target_agent_id,
            &prompt,
            model.as_deref(),
        );
        let key = peer_application_operation_key(&route_address, &operation_id);
        let lock = self.key_lock(&format!("caller-operation:{operation_id}"));
        let _guard = lock.lock().await;
        if let Some(existing) = self.caller_operation(&operation_id).await? {
            if existing.request_digest != digest
                || existing.origin_address != route_address
                || existing.caller_agent_id != caller_agent_id
                || existing.target_agent_id != target_agent_id
                || existing.prompt != prompt
            {
                return Err(app_error(
                    "This operation id is already bound to different immutable request data.",
                ));
            }
            return Ok(existing);
        }
        if !self.peer.is_peer_reachable(&route_address).await? {
            return Err(transport_err(
                "The paired Agent device is not reachable; the operation was not accepted.",
            ));
        }
        let request = json!({
            "version": PEER_APPLICATION_PROTOCOL_VERSION,
            "kind": "operation_request",
            "operationId": operation_id,
            "originAddress": route_address,
            "callerAgentId": caller_agent_id,
            "targetAgentId": target_agent_id,
            "prompt": prompt,
            "model": model,
            "requestDigest": digest,
            "deliveryId": "request"
        });
        // Validate the transport encoding before durable acceptance.
        let _ = serialize_application_envelope(&request);
        let accepted = make_operation_record(OperationRecordSeed {
            key: key.clone(),
            operation_id,
            origin_address: route_address.clone(),
            route_address,
            role: "caller".to_string(),
            caller_agent_id,
            target_agent_id,
            request_digest: digest,
            prompt,
            model,
            status: "delivery_pending".to_string(),
            inbound_message_id: None,
        });
        let accepted2 = accepted.clone();
        self.with_key_lock(&key, || async move {
            self.save_operation(&accepted2).await
        })
        .await?;
        let accepted3 = accepted.clone();
        self.defer_recovery(move |this| {
            Box::pin(async move { this.resume_caller(&accepted3).await })
        });
        Ok(accepted)
    }

    pub async fn discover_agents(
        self: &Rc<Self>,
        address: PeerApplicationAddress,
        request_id: Option<String>,
    ) -> Result<PeerApplicationDiscoveryRecord> {
        let request_id = match request_id {
            Some(id) => assert_peer_client_opaque_id(&id, "requestId")?,
            None => new_peer_application_discovery_id(),
        };
        let address = assert_address(&address)?;
        let key = peer_application_discovery_key(&address, &request_id);
        let lock = self.key_lock(&format!("discovery:{key}"));
        let _guard = lock.lock().await;
        if let Some(existing) = self.journal.get_discovery(&key)? {
            return Ok(existing);
        }
        if !self.peer.is_peer_reachable(&address).await? {
            return Err(transport_err(
                "The paired Agent device is not reachable; discovery was not accepted.",
            ));
        }
        let timestamp = now_iso();
        let record = PeerApplicationDiscoveryRecord {
            version: PEER_APPLICATION_PROTOCOL_VERSION,
            key: key.clone(),
            request_id,
            address,
            status: "pending".to_string(),
            agents: Vec::new(),
            last_error: None,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        self.journal.save_pending_discovery_recovery(&PeerApplicationDiscoveryRecovery {
            key: record.key.clone(),
            address: record.address.clone(),
            request_id: record.request_id.clone(),
            action: "request".to_string(),
        })?;
        self.journal.save_discovery(&record)?;
        self.emit(PeerApplicationChange::Discovery(record.clone()));
        let record2 = record.clone();
        self.defer_recovery(move |this| {
            Box::pin(async move { this.resume_discovery(&record2).await })
        });
        Ok(record)
    }

    pub async fn get_discovery(
        &self,
        address: &PeerApplicationAddress,
        request_id: &str,
    ) -> Result<Option<PeerApplicationDiscoveryRecord>> {
        let route = assert_address(address)?;
        let id = assert_peer_client_opaque_id(request_id, "requestId")?;
        self.journal.get_discovery(&peer_application_discovery_key(&route, &id))
    }

    /// Latest completed remote agent list for this route.
    pub async fn remote_agents(&self, address: &PeerApplicationAddress) -> Result<Vec<AcpAgentSummary>> {
        let route = assert_address(address)?;
        let mut rows: Vec<PeerApplicationDiscoveryRecord> = self
            .journal
            .list_discoveries()?
            .into_iter()
            .filter(|d| d.status == "completed" && d.address == route)
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows.first().map(|r| r.agents.clone()).unwrap_or_default())
    }

    pub async fn cancel(self: &Rc<Self>, operation_id: &str) -> Result<PeerApplicationRecord> {
        let Some(record) = self.get_operation(operation_id).await? else {
            return Err(app_error("The requested operation does not exist."));
        };
        self.with_key_lock(&record.key, || async {
            let Some(current) = self.journal.get_operation(&record.key)? else {
                return Err(app_error("The requested operation does not exist."));
            };
            if status_terminal(&current.status) {
                return Ok(current);
            }
            let cancelled = update_record(&current, RecordPatch {
                cancel_requested: Some(true),
                status: Some("cancel_requested".to_string()),
                last_error: Some(None),
                ..Default::default()
            });
            self.save_operation(&cancelled).await?;
            Ok(cancelled)
        })
        .await
        .inspect(|cancelled| {
            let is_caller = cancelled.role == "caller";
            let c = cancelled.clone();
            let key = record.key.clone();
            if is_caller {
                self.defer_recovery(move |this| {
                    Box::pin(async move { this.resume_caller(&c).await })
                });
            } else {
                let c2 = c.clone();
                self.defer_recovery(move |this| {
                    Box::pin(async move { this.publish_receiver_state(&c2).await })
                });
                self.resolve_permission_waiter(&key, AcpPermissionResolution::Cancelled);
                let running = self.running.borrow().get(&key).cloned();
                if let Some(cancel) = running {
                    tokio::task::spawn_local(async move { cancel().await });
                }
            }
        })
    }

    pub async fn resolve_permission(
        self: &Rc<Self>,
        operation_id: &str,
        permission_id: &str,
        resolution: AcpPermissionResolution,
    ) -> Result<PeerApplicationRecord> {
        let Some(record) = self.get_operation(operation_id).await? else {
            return Err(app_error("The local permission request does not exist."));
        };
        if record.role != "receiver" {
            return Err(app_error("The local permission request does not exist."));
        }
        let updated = self.with_key_lock(&record.key, || async {
            let Some(current) = self.journal.get_operation(&record.key)? else {
                return Err(app_error("The permission request is no longer pending."));
            };
            let permission = current.permission.clone().unwrap_or_else(|| PeerApplicationPermissionRecord {
                id: String::new(),
                status: "pending".to_string(),
                request: AcpPermissionPrompt {
                    session_id: String::new(),
                    tool_call: AcpPermissionToolCall {
                        tool_call_id: String::new(),
                        title: String::new(),
                        name: None,
                        kind: None,
                        status: None,
                        content: Vec::new(),
                        raw_input: None,
                        locations: Vec::new(),
                    },
                    options: Vec::new(),
                },
                selected_option_id: None,
                updated_at: now_iso(),
            });
            if permission.id != permission_id || permission.status != "pending" {
                return Err(app_error("The permission request is no longer pending."));
            }
            if !self.permission_waiters.borrow().contains_key(&record.key) {
                return Err(app_error(
                    "The local ACP process is no longer waiting for this permission.",
                ));
            }
            let mut selected_option_id: Option<String> = None;
            if let AcpPermissionResolution::Selected { option_id } = &resolution {
                let option_id = assert_peer_client_opaque_id(option_id, "permission.optionId")?;
                if !permission.request.options.iter().any(|o| o.option_id == option_id) {
                    return Err(app_error(
                        "The selected permission option does not belong to this request.",
                    ));
                }
                selected_option_id = Some(option_id);
            }
            let updated_at = now_iso();
            let updated = update_record(&current, RecordPatch {
                permission: Some(Some(PeerApplicationPermissionRecord {
                    status: "resolved".to_string(),
                    selected_option_id: selected_option_id.clone(),
                    updated_at: updated_at.clone(),
                    ..permission.clone()
                })),
                permission_history: Some(
                    current
                        .permission_history
                        .iter()
                        .map(|p| {
                            if p.id == permission_id {
                                PeerApplicationPermissionRecord {
                                    status: "resolved".to_string(),
                                    selected_option_id: selected_option_id.clone(),
                                    updated_at: updated_at.clone(),
                                    ..p.clone()
                                }
                            } else {
                                p.clone()
                            }
                        })
                        .collect(),
                ),
                status: Some(if current.cancel_requested {
                    "cancel_requested".to_string()
                } else {
                    "running".to_string()
                }),
                ..Default::default()
            });
            self.save_operation(&updated).await?;
            Ok(updated)
        })
        .await?;
        if updated.role == "receiver" {
            let updated2 = updated.clone();
            self.defer_recovery(move |this| {
                Box::pin(async move { this.publish_receiver_state(&updated2).await })
            });
        }
        self.resolve_permission_waiter(&record.key, resolution);
        Ok(updated)
    }

    /// Reconnect path: redeliver exact accepted operations/results, never ACP prompts.
    pub async fn resume(self: &Rc<Self>) -> Result<()> {
        if self.disposed.get() {
            return Ok(());
        }
        let mut operations: Vec<PeerApplicationOperationRecovery> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = self
                .journal
                .list_pending_operation_recovery_page(cursor.as_deref(), APPLICATION_RECOVERY_PAGE_SIZE)?;
            operations.extend(page.items);
            match page.next_after_key {
                Some(k) => cursor = Some(k),
                None => break,
            }
        }
        let mut waiting: Vec<_> = operations
            .iter()
            .filter(|r| r.execution_pending)
            .cloned()
            .collect();
        waiting.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.key.cmp(&b.key)));
        for record in &waiting {
            self.schedule_execution(&record.key);
        }
        let mut failed = false;
        for record in &operations {
            if self.resume_operation_recovery(record).await.is_err() {
                failed = true;
            }
        }
        let mut discoveries: Vec<PeerApplicationDiscoveryRecovery> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = self
                .journal
                .list_pending_discovery_recovery_page(cursor.as_deref(), APPLICATION_RECOVERY_PAGE_SIZE)?;
            discoveries.extend(page.items);
            match page.next_after_key {
                Some(k) => cursor = Some(k),
                None => break,
            }
        }
        for discovery in &discoveries {
            if self.resume_discovery_recovery(discovery).await.is_err() {
                failed = true;
            }
        }
        let op_handoffs = self.resume_handoff_pages(false).await;
        let res_handoffs = self.resume_handoff_pages(true).await;
        self.wake_deferred_routes();
        self.pump_execution_queue();
        if failed || !op_handoffs || !res_handoffs {
            self.schedule_recovery_retry(false, true);
        } else {
            let retry = self.recovery_retry.borrow();
            if !retry.running && retry.timer.is_none() {
                drop(retry);
                self.reset_recovery_retry();
            }
        }
        Ok(())
    }

    pub fn dispose(&self) {
        self.disposed.set(true);
        self.reset_recovery_retry();
        self.deferred_routes.borrow_mut().clear();
        // Healthy work and subprocesses intentionally remain alive on close.
    }

    /* ------------------------------ recovery retry ------------------------- */

    fn schedule_recovery_retry(self: &Rc<Self>, increase_delay: bool, recovery_failure: bool) {
        if self.disposed.get() {
            return;
        }
        {
            let mut rr = self.recovery_retry.borrow_mut();
            if recovery_failure {
                rr.sweep_failed = true;
            }
            if increase_delay {
                rr.delay_ms = (rr.delay_ms * 2).min(APPLICATION_RECOVERY_RETRY_MAX_DELAY_MS);
            }
            if rr.running {
                rr.requested = true;
                return;
            }
            if rr.timer.is_some() {
                return;
            }
        }
        let delay = self.recovery_retry.borrow().delay_ms;
        let this = Rc::clone(self);
        let handle = tokio::task::spawn_local(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            {
                let mut rr = this.recovery_retry.borrow_mut();
                rr.timer = None;
                if rr.operation_cursor.is_none() && rr.discovery_cursor.is_none() && rr.handoff_cursor.is_none() {
                    rr.sweep_failed = false;
                }
                rr.running = true;
            }
            let retry_result = this.retry_pending_recovery_page().await;
            {
                let mut rr = this.recovery_retry.borrow_mut();
                rr.running = false;
                if retry_result.is_err() {
                    drop(rr);
                    this.schedule_recovery_retry(true, true);
                    return;
                }
                if rr.requested {
                    rr.requested = false;
                    drop(rr);
                    this.schedule_recovery_retry(false, false);
                }
            }
        })
        .abort_handle();
        self.recovery_retry.borrow_mut().timer = Some(handle);
    }

    fn reset_recovery_retry(&self) {
        let mut rr = self.recovery_retry.borrow_mut();
        if let Some(timer) = rr.timer.take() {
            timer.abort();
        }
        if self.disposed.get() {
            rr.requested = false;
        }
        rr.delay_ms = APPLICATION_RECOVERY_RETRY_INITIAL_DELAY_MS;
        rr.operation_cursor = None;
        rr.discovery_cursor = None;
        rr.handoff_cursor = None;
        rr.sweep_failed = false;
    }

    async fn retry_pending_recovery_page(self: &Rc<Self>) -> Result<()> {
        if self.disposed.get() {
            return Ok(());
        }
        let mut failed = false;
        let mut more = false;
        {
            let cursor = self.recovery_retry.borrow().operation_cursor.clone();
            match self
                .journal
                .list_pending_operation_recovery_page(cursor.as_deref(), APPLICATION_RECOVERY_PAGE_SIZE)
            {
                Ok(page) => {
                    for recovery in &page.items {
                        if self.resume_operation_recovery(recovery).await.is_err() {
                            failed = true;
                        }
                    }
                    self.recovery_retry.borrow_mut().operation_cursor = page.next_after_key.clone();
                    more |= page.next_after_key.is_some();
                }
                Err(_) => failed = true,
            }
        }
        if self.disposed.get() {
            return Ok(());
        }
        {
            let cursor = self.recovery_retry.borrow().discovery_cursor.clone();
            match self
                .journal
                .list_pending_discovery_recovery_page(cursor.as_deref(), APPLICATION_RECOVERY_PAGE_SIZE)
            {
                Ok(page) => {
                    for recovery in &page.items {
                        if self.resume_discovery_recovery(recovery).await.is_err() {
                            failed = true;
                        }
                    }
                    self.recovery_retry.borrow_mut().discovery_cursor = page.next_after_key.clone();
                    more |= page.next_after_key.is_some();
                }
                Err(_) => failed = true,
            }
        }
        if self.disposed.get() {
            return Ok(());
        }
        {
            let cursor = self.recovery_retry.borrow().handoff_cursor.clone();
            match self
                .journal
                .list_pending_handoff_page(cursor.as_deref(), APPLICATION_RECOVERY_PAGE_SIZE)
            {
                Ok(page) => {
                    for plan in &page.items {
                        if self.resume_handoff(plan).await.is_err() {
                            failed = true;
                        }
                    }
                    self.recovery_retry.borrow_mut().handoff_cursor = page.next_after_key.clone();
                    more |= page.next_after_key.is_some();
                }
                Err(_) => failed = true,
            }
        }
        if self.disposed.get() {
            return Ok(());
        }
        {
            let mut rr = self.recovery_retry.borrow_mut();
            if failed {
                rr.sweep_failed = true;
                rr.delay_ms = (rr.delay_ms * 2).min(APPLICATION_RECOVERY_RETRY_MAX_DELAY_MS);
            }
            if more {
                if !rr.sweep_failed {
                    rr.delay_ms = APPLICATION_RECOVERY_RETRY_INITIAL_DELAY_MS;
                }
                drop(rr);
                self.schedule_recovery_retry(false, false);
            } else if self.recovery_retry.borrow().sweep_failed {
                // Continue past failed rows for fairness, then wrap the cursors
                // to retry them without another inbound message or reconnect.
                let mut rr = self.recovery_retry.borrow_mut();
                rr.operation_cursor = None;
                rr.discovery_cursor = None;
                rr.handoff_cursor = None;
                rr.sweep_failed = false;
                drop(rr);
                self.schedule_recovery_retry(false, false);
            } else {
                rr.delay_ms = APPLICATION_RECOVERY_RETRY_INITIAL_DELAY_MS;
                drop(rr);
                self.reset_recovery_retry();
            }
        }
        Ok(())
    }

    /* ------------------------------ resume paths --------------------------- */

    async fn resume_operation_recovery(self: &Rc<Self>, recovery: &PeerApplicationOperationRecovery) -> Result<()> {
        if recovery.terminal
            && recovery.role == "receiver"
            && !recovery.terminal_prepared
            && recovery.result_part_count.is_none()
        {
            self.clear_operation_recovery(recovery).await?;
            return Ok(());
        }
        if recovery.role == "caller" && recovery.terminal {
            self.clear_operation_recovery(recovery).await?;
            return Ok(());
        }
        if recovery.role == "caller" {
            let request_id = peer_application_transport_message_id(
                &recovery.route_address.local_device_id,
                &recovery.key,
                "request",
                0,
                0,
            );
            let request_state = self.peer.get_send_state(&recovery.route_address, &request_id).await?;
            if request_state.as_deref() == Some("conflict") {
                return Err(app_error("A Peer operation request id has a sender-scope conflict."));
            }
            if request_state.is_some() {
                if recovery.cancel_requested {
                    let cancel_id = peer_application_transport_message_id(
                        &recovery.route_address.local_device_id,
                        &recovery.key,
                        "cancel",
                        0,
                        0,
                    );
                    let cancel_state = self.peer.get_send_state(&recovery.route_address, &cancel_id).await?;
                    if cancel_state.as_deref() == Some("conflict") {
                        return Err(app_error("A Peer cancellation id has a sender-scope conflict."));
                    }
                    if cancel_state.is_some() {
                        self.clear_operation_recovery(recovery).await?;
                        return Ok(());
                    }
                    let cancel = json!({
                        "version": PEER_APPLICATION_PROTOCOL_VERSION,
                        "kind": "operation_cancel",
                        "operationId": recovery.operation_id,
                        "originAddress": recovery.origin_address,
                        "requestDigest": recovery.request_digest,
                        "deliveryId": "cancel"
                    });
                    self.send_logical(SendLogical {
                        operation_key: &recovery.key,
                        address: &recovery.route_address,
                        logical_id: "cancel",
                        kind: "operation_cancel",
                        envelope: &cancel,
                        source_kind: "operation",
                        prepared: None,
                        retain_plan: false,
                    })
                    .await?;
                    self.clear_operation_recovery(recovery).await?;
                    return Ok(());
                }
                self.clear_operation_recovery(recovery).await?;
                return Ok(());
            }
        } else if recovery.result_part_count.is_some()
            && !recovery.terminal_prepared
            && self.result_handoffs_durable(&recovery.key, &recovery.route_address, recovery.result_part_count).await?
        {
            self.clear_operation_recovery(recovery).await?;
            self.clear_result_handoff_plans(&recovery.key, &recovery.route_address, recovery.result_part_count).await?;
            self.journal.clear_partial_result_chunks(&recovery.key)?;
            self.wake_deferred_routes();
            return Ok(());
        }

        let key = recovery.key.clone();
        let recovery2 = recovery.clone();
        let record = self
            .with_key_lock(&key, || async {
                match self.journal.get_operation(&key)? {
                    Some(current) => Ok(Some(current)),
                    None => {
                        self.journal
                            .clear_pending_operation_recovery(&key, Some(recovery2.state_revision))?;
                        Ok(None)
                    }
                }
            })
            .await?;
        let Some(record) = record else { return Ok(()) };
        if record.role == "caller" {
            self.resume_caller(&record).await
        } else {
            self.resume_receiver(&record).await
        }
    }

    async fn resume_discovery_recovery(self: &Rc<Self>, recovery: &PeerApplicationDiscoveryRecovery) -> Result<()> {
        let logical_id = if recovery.action == "request" {
            "catalog:request"
        } else {
            "catalog:response"
        };
        let address = if recovery.action == "request" {
            recovery.address.clone()
        } else {
            reverse_peer_application_address(&recovery.address)
        };
        let message_id = peer_application_transport_message_id(
            &address.local_device_id,
            &recovery.key,
            logical_id,
            0,
            0,
        );
        let plan = self.journal.get_pending_handoff(&message_id)?;
        if let Some(plan) = &plan {
            if self.handoff_is_durable(plan).await? {
                self.journal.clear_pending_handoff(&plan.key)?;
                self.clear_discovery_recovery(recovery).await?;
                return Ok(());
            }
        }
        if plan.is_none() {
            let state = self.peer.get_send_state(&address, &message_id).await?;
            if state.as_deref() == Some("conflict") {
                return Err(app_error("A Peer catalog message id has a sender-scope conflict."));
            }
            if state.is_some() {
                self.clear_discovery_recovery(recovery).await?;
                return Ok(());
            }
        }
        let key = recovery.key.clone();
        let recovery2 = recovery.clone();
        let record = self
            .with_key_lock(&format!("discovery:{key}"), || async {
                match self.journal.get_discovery(&key)? {
                    Some(current) => Ok(Some(current)),
                    None => {
                        self.journal
                            .clear_pending_discovery_recovery(&key, Some(&recovery2.action))?;
                        Ok(None)
                    }
                }
            })
            .await?;
        let Some(record) = record else { return Ok(()) };
        if recovery.action == "request" {
            self.resume_discovery(&record).await
        } else {
            self.resume_catalog_response(&record).await
        }
    }

    async fn resume_handoff_pages(self: &Rc<Self>, include_result_events: bool) -> bool {
        let mut failed = false;
        let mut cursor: Option<String> = None;
        loop {
            let page = match self.journal.list_pending_handoff_page(cursor.as_deref(), 32) {
                Ok(p) => p,
                Err(_) => return false,
            };
            for plan in &page.items {
                let result_event = plan.message_kind == "operation_result_part"
                    || plan.message_kind == "operation_result_end";
                if result_event != include_result_events {
                    continue;
                }
                if self.resume_handoff(plan).await.is_err() {
                    failed = true;
                }
            }
            match page.next_after_key {
                Some(k) => cursor = Some(k),
                None => break,
            }
        }
        !failed
    }

    async fn resume_caller(self: &Rc<Self>, record: &PeerApplicationRecord) -> Result<()> {
        let mut current = self.journal.get_operation(&record.key)?;
        if current.as_ref().map(|c| c.role.as_str()) != Some("caller") {
            return Ok(());
        }
        if let Some(cur) = &current {
            if !status_terminal(&cur.status) {
                let request = json!({
                    "version": PEER_APPLICATION_PROTOCOL_VERSION,
                    "kind": "operation_request",
                    "operationId": cur.operation_id,
                    "originAddress": cur.origin_address,
                    "callerAgentId": cur.caller_agent_id,
                    "targetAgentId": cur.target_agent_id,
                    "prompt": cur.prompt,
                    "model": cur.model,
                    "requestDigest": cur.request_digest,
                    "deliveryId": "request"
                });
                self.send_operation_event(cur, "request", "operation_request", &request, None, false)
                    .await?;
            }
        }
        current = self.journal.get_operation(&record.key)?;
        if let Some(cur) = &current {
            if cur.cancel_requested && !status_terminal(&cur.status) {
                let cancel = json!({
                    "version": PEER_APPLICATION_PROTOCOL_VERSION,
                    "kind": "operation_cancel",
                    "operationId": cur.operation_id,
                    "originAddress": cur.origin_address,
                    "requestDigest": cur.request_digest,
                    "deliveryId": "cancel"
                });
                self.send_operation_event(cur, "cancel", "operation_cancel", &cancel, None, false)
                    .await?;
            }
        }
        let key = record.key.clone();
        self.with_key_lock(&key, || async {
            let latest = self.journal.get_operation(&key)?;
            let Some(latest) = latest else {
                self.journal.clear_pending_operation_recovery(&key, None)?;
                return Ok(());
            };
            if latest.role != "caller" {
                self.journal.clear_pending_operation_recovery(&key, None)?;
                return Ok(());
            }
            if latest.cancel_requested && !status_terminal(&latest.status) {
                let cancel_id = peer_application_transport_message_id(
                    &latest.route_address.local_device_id,
                    &latest.key,
                    "cancel",
                    0,
                    0,
                );
                let state = self.peer.get_send_state(&latest.route_address, &cancel_id).await?;
                if state.as_deref() == Some("conflict") {
                    return Err(app_error("A Peer transport cancellation id has a sender-scope conflict."));
                }
                if state.is_none() {
                    return Ok(());
                }
            }
            self.journal
                .clear_pending_operation_recovery(&key, Some(latest.state_revision))?;
            Ok(())
        })
        .await
    }

    async fn resume_receiver(self: &Rc<Self>, record: &PeerApplicationRecord) -> Result<()> {
        let mut current = self.journal.get_operation(&record.key)?;
        let Some(mut cur) = current.clone() else { return Ok(()) };
        if cur.terminal_prepared {
            self.complete_prepared_terminal(&cur).await?;
            current = self.journal.get_operation(&record.key)?;
            cur = current.clone().unwrap_or(cur);
        }
        if !status_terminal(&cur.status) {
            if cur.prompt_reserved && !self.running.borrow().contains_key(&cur.key) {
                let saved_parts = self.journal.list_result_parts(&cur.key)?;
                let partial_chunks = if saved_parts.is_empty() {
                    self.journal.list_partial_result_chunks(&cur.key)?
                } else {
                    saved_parts
                };
                let partial = partial_chunks.iter().map(|p| p.text.as_str()).collect::<String>();
                self.set_terminal(&cur, "unknown", Some("execution_outcome_unknown"), &partial, None)
                    .await?;
            } else if matches!(cur.status.as_str(), "accepted" | "running" | "awaiting_permission") {
                if !cur.prompt_reserved {
                    self.schedule_execution(&cur.key);
                }
            } else if cur.cancel_requested && !cur.prompt_reserved {
                self.schedule_execution(&cur.key);
            }
        }
        let Some(cur) = self.journal.get_operation(&record.key)? else { return Ok(()) };
        if status_terminal(&cur.status) {
            self.send_stored_result(&cur, true).await?;
            self.journal.clear_partial_result_chunks(&cur.key)?;
        } else {
            self.publish_receiver_state(&cur).await?;
        }
        Ok(())
    }

    async fn resume_discovery(self: &Rc<Self>, record: &PeerApplicationDiscoveryRecord) -> Result<()> {
        let envelope = json!({
            "version": PEER_APPLICATION_PROTOCOL_VERSION,
            "kind": "catalog_request",
            "requestId": record.request_id,
            "address": record.address,
            "deliveryId": "catalog:request"
        });
        self.send_discovery_event(record, &envelope, false, false).await?;
        self.clear_discovery_recovery(&PeerApplicationDiscoveryRecovery {
            key: record.key.clone(),
            address: record.address.clone(),
            request_id: record.request_id.clone(),
            action: "request".to_string(),
        })
        .await?;
        Ok(())
    }

    async fn resume_catalog_response(self: &Rc<Self>, record: &PeerApplicationDiscoveryRecord) -> Result<()> {
        self.journal.save_pending_discovery_recovery(&PeerApplicationDiscoveryRecovery {
            key: record.key.clone(),
            address: record.address.clone(),
            request_id: record.request_id.clone(),
            action: "response".to_string(),
        })?;
        let envelope = json!({
            "version": PEER_APPLICATION_PROTOCOL_VERSION,
            "kind": "catalog_response",
            "requestId": record.request_id,
            "address": record.address,
            "agents": record.agents,
            "deliveryId": "catalog:response"
        });
        self.send_discovery_event(record, &envelope, true, false).await?;
        self.clear_discovery_recovery(&PeerApplicationDiscoveryRecovery {
            key: record.key.clone(),
            address: record.address.clone(),
            request_id: record.request_id.clone(),
            action: "response".to_string(),
        })
        .await?;
        Ok(())
    }

    /* ------------------------------- sending ------------------------------- */

    async fn send_operation_event(
        self: &Rc<Self>,
        record: &PeerApplicationRecord,
        logical_id: &str,
        kind: &str,
        envelope: &Value,
        prepared: Option<Vec<u8>>,
        retain_plan: bool,
    ) -> Result<()> {
        self.send_logical(SendLogical {
            operation_key: &record.key,
            address: &record.route_address,
            logical_id,
            kind,
            envelope,
            source_kind: "operation",
            prepared,
            retain_plan,
        })
        .await
    }

    async fn send_discovery_event(
        self: &Rc<Self>,
        record: &PeerApplicationDiscoveryRecord,
        envelope: &Value,
        response: bool,
        retain_plan: bool,
    ) -> Result<()> {
        let logical_id = if response { "catalog:response" } else { "catalog:request" };
        let address = if response {
            reverse_peer_application_address(&record.address)
        } else {
            record.address.clone()
        };
        self.send_logical(SendLogical {
            operation_key: &record.key,
            address: &address,
            logical_id,
            kind: envelope.get("kind").and_then(Value::as_str).unwrap_or(""),
            envelope,
            source_kind: "discovery",
            prepared: None,
            retain_plan,
        })
        .await
    }

    async fn send_logical(&self, input: SendLogical<'_>) -> Result<()> {
        let message_id = peer_application_transport_message_id(
            &input.address.local_device_id,
            input.operation_key,
            input.logical_id,
            0,
            0,
        );
        let state = self.peer.get_send_state(input.address, &message_id).await?;
        if state.as_deref() == Some("conflict") {
            return Err(app_error("A Peer transport message id has a sender-scope conflict."));
        }
        if matches!(state.as_deref(), Some("delivered") | Some("pending")) {
            if !input.retain_plan {
                self.journal.clear_pending_handoff(&message_id)?;
            }
            return Ok(());
        }
        let plaintext = input
            .prepared
            .clone()
            .unwrap_or_else(|| serialize_application_envelope(input.envelope));
        if plaintext.len() <= PEER_CLIENT_MAX_PLAINTEXT_BYTES {
            let plan = self.handoff_plan(&input, &message_id, 0);
            self.journal.save_pending_handoff(&plan)?;
            self.peer
                .send_message(input.address, plaintext, message_id.clone())
                .await?;
            if !input.retain_plan {
                self.journal.clear_pending_handoff(&message_id)?;
            }
            return Ok(());
        }
        let mut saved_plan = false;
        let mut part_count = 0u64;
        for fragment in fragment_logical_envelope(&message_id, input.kind, &plaintext)? {
            if !saved_plan {
                part_count = fragment.part_count;
                self.journal
                    .save_pending_handoff(&self.handoff_plan(&input, &message_id, part_count))?;
                saved_plan = true;
            } else if part_count != fragment.part_count {
                return Err(app_error(
                    "A Peer application fragment count changed during one logical handoff.",
                ));
            }
            let fragment_state = self.peer.get_send_state(input.address, &fragment.message_id).await?;
            if fragment_state.as_deref() == Some("conflict") {
                return Err(app_error(
                    "A Peer application fragment id has a sender-scope conflict.",
                ));
            }
            if matches!(fragment_state.as_deref(), Some("delivered") | Some("pending")) {
                continue;
            }
            self.peer
                .send_message(input.address, fragment.plaintext, fragment.message_id)
                .await?;
        }
        if !saved_plan {
            return Err(app_error("A Peer application envelope produced no transport fragments."));
        }
        if !input.retain_plan {
            self.journal.clear_pending_handoff(&message_id)?;
        }
        Ok(())
    }

    fn handoff_plan(&self, input: &SendLogical<'_>, message_id: &str, part_count: u64) -> PeerApplicationHandoffPlan {
        PeerApplicationHandoffPlan {
            key: message_id.to_string(),
            source_kind: input.source_kind.to_string(),
            source_key: input.operation_key.to_string(),
            address: input.address.clone(),
            logical_id: input.logical_id.to_string(),
            message_kind: input.kind.to_string(),
            message_id: message_id.to_string(),
            part_count,
        }
    }

    async fn resume_handoff(self: &Rc<Self>, plan: &PeerApplicationHandoffPlan) -> Result<()> {
        if self.handoff_is_durable(plan).await? {
            self.journal.clear_pending_handoff(&plan.key)?;
            return Ok(());
        }
        if plan.source_kind == "operation" {
            let Some(record) = self.journal.get_operation(&plan.source_key)? else {
                return Err(app_error("A pending Peer handoff has no matching durable operation source."));
            };
            if record.route_address != plan.address {
                return Err(app_error("A pending Peer handoff has no matching durable operation source."));
            }
            let envelope = self.operation_envelope_for_handoff(&record, plan)?;
            self.send_operation_event(&record, &plan.logical_id, &plan.message_kind, &envelope, None, false)
                .await?;
            return Ok(());
        }
        let Some(record) = self.journal.get_discovery(&plan.source_key)? else {
            return Err(app_error("A pending Peer handoff has no matching durable discovery source."));
        };
        let response = plan.message_kind == "catalog_response";
        let expected_address = if response {
            reverse_peer_application_address(&record.address)
        } else {
            record.address.clone()
        };
        if expected_address != plan.address {
            return Err(app_error("A pending Peer catalog handoff has a mismatched route."));
        }
        let envelope = if response {
            json!({
                "version": PEER_APPLICATION_PROTOCOL_VERSION,
                "kind": "catalog_response",
                "requestId": record.request_id,
                "address": record.address,
                "agents": record.agents,
                "deliveryId": "catalog:response"
            })
        } else {
            json!({
                "version": PEER_APPLICATION_PROTOCOL_VERSION,
                "kind": "catalog_request",
                "requestId": record.request_id,
                "address": record.address,
                "deliveryId": "catalog:request"
            })
        };
        self.send_discovery_event(&record, &envelope, response, false).await
    }

    async fn handoff_is_durable(&self, plan: &PeerApplicationHandoffPlan) -> Result<bool> {
        let transport_ids: Vec<String> = if plan.part_count == 0 {
            vec![plan.message_id.clone()]
        } else {
            (0..plan.part_count)
                .map(|i| peer_application_fragment_message_id(&plan.message_id, i).unwrap_or_default())
                .collect()
        };
        for id in &transport_ids {
            let state = self.peer.get_send_state(&plan.address, id).await?;
            if state.as_deref() == Some("conflict") {
                return Err(app_error(
                    "A durable Peer handoff conflicts with its fixed transport identity.",
                ));
            }
            if state.is_none() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// `#operationEnvelopeForHandoff` — rebuild the durable envelope a pending
    /// handoff points at; every kind derives from the source record, never
    /// from stored wire bytes.
    fn operation_envelope_for_handoff(
        &self,
        record: &PeerApplicationRecord,
        plan: &PeerApplicationHandoffPlan,
    ) -> Result<Value> {
        let base = json!({
            "version": PEER_APPLICATION_PROTOCOL_VERSION,
            "operationId": record.operation_id,
            "originAddress": record.origin_address,
            "requestDigest": record.request_digest
        });
        if plan.message_kind == "operation_request" && plan.logical_id == "request" && record.role == "caller" {
            let mut v = base.as_object().unwrap().clone();
            v.insert("kind".into(), json!("operation_request"));
            v.insert("callerAgentId".into(), json!(record.caller_agent_id));
            v.insert("targetAgentId".into(), json!(record.target_agent_id));
            v.insert("prompt".into(), json!(record.prompt));
            v.insert("model".into(), json!(record.model));
            v.insert("deliveryId".into(), json!("request"));
            return Ok(Value::Object(v));
        }
        if plan.message_kind == "operation_cancel" && plan.logical_id == "cancel" {
            let mut v = base.as_object().unwrap().clone();
            v.insert("kind".into(), json!("operation_cancel"));
            v.insert("deliveryId".into(), json!("cancel"));
            return Ok(Value::Object(v));
        }
        if plan.message_kind == "operation_state" {
            let captures = parse_state_logical_id(&plan.logical_id)?;
            let (revision, status) = captures;
            let mut v = base.as_object().unwrap().clone();
            v.insert("kind".into(), json!("operation_state"));
            v.insert("status".into(), json!(status));
            v.insert("stateRevision".into(), json!(revision));
            v.insert("deliveryId".into(), json!(plan.logical_id));
            return Ok(Value::Object(v));
        }
        if plan.message_kind == "operation_result_part" {
            let index = plan
                .logical_id
                .strip_prefix("result:part:")
                .and_then(|s| s.parse::<u64>().ok())
                .ok_or_else(|| app_error("A pending Peer result handoff has an invalid part index."))?;
            let part = self
                .journal
                .get_result_part(&record.key, index)?
                .ok_or_else(|| app_error("A pending Peer result handoff has no matching durable result part."))?;
            let mut v = base.as_object().unwrap().clone();
            v.insert("kind".into(), json!("operation_result_part"));
            v.insert("index".into(), json!(part.index));
            v.insert("text".into(), json!(part.text));
            v.insert("deliveryId".into(), json!(plan.logical_id));
            return Ok(Value::Object(v));
        }
        if plan.message_kind == "operation_result_end"
            && plan.logical_id == "result:end"
            && record.result_status.is_some()
            && record.result_part_count.is_some()
            && record.result_digest.is_some()
        {
            let mut v = base.as_object().unwrap().clone();
            v.insert("kind".into(), json!("operation_result_end"));
            v.insert("status".into(), json!(record.result_status));
            v.insert("stopReason".into(), json!(record.result_stop_reason));
            v.insert("partCount".into(), json!(record.result_part_count));
            v.insert("resultDigest".into(), json!(record.result_digest));
            v.insert("deliveryId".into(), json!("result:end"));
            return Ok(Value::Object(v));
        }
        Err(app_error("A pending Peer operation handoff has no matching durable event source."))
    }

    /* ------------------------------- inbound -------------------------------- */

    async fn handle_inbound(self: &Rc<Self>, delivery: PeerApplicationInbound) -> PeerInboundOutcome {
        if self.disposed.get() {
            return PeerInboundOutcome::Deferred { detail: event_detail("engine_disposed") };
        }
        let message = &delivery.message;
        if message.sender_device_id != delivery.address.peer_device_id {
            return PeerInboundOutcome::Rejected { detail: event_detail("sender_mismatch") };
        }
        let result = self.handle_inbound_inner(&delivery).await;
        match result {
            Ok(outcome) => outcome,
            Err(e) => {
                if is_deferred(&e) || !is_peer_client_error_kind(&e) {
                    tracing::debug!(error = ?e, "inbound handling deferred");
                    self.deferred_routes
                        .borrow_mut()
                        .insert(Self::route_key(&delivery.address), delivery.address.clone());
                    PeerInboundOutcome::Deferred {
                        detail: event_detail("deferred"),
                    }
                } else {
                    PeerInboundOutcome::Rejected {
                        detail: event_detail(&safe_error_code(&e)),
                    }
                }
            }
        }
    }

    async fn handle_inbound_inner(self: &Rc<Self>, delivery: &PeerApplicationInbound) -> Result<PeerInboundOutcome> {
        let parsed = parse_application_envelope(&delivery.message.plaintext)
            .ok_or_else(|| app_error("invalid_application_envelope"))?;
        let mut envelope = parsed;
        let mut fragment_message_id: Option<String> = None;
        if envelope.get("kind").and_then(Value::as_str) == Some("application_fragment") {
            let mid = assert_peer_client_opaque_id(
                envelope.get("messageId").and_then(Value::as_str).unwrap_or(""),
                "fragment.messageId",
            )?;
            fragment_message_id = Some(mid.clone());
            match self.receive_application_fragment(delivery, &envelope).await? {
                FragmentAssembly::Backpressured => {
                    self.deferred_routes
                        .borrow_mut()
                        .insert(Self::route_key(&delivery.address), delivery.address.clone());
                    return Ok(PeerInboundOutcome::Deferred { detail: event_detail("backpressured") });
                }
                FragmentAssembly::Applied | FragmentAssembly::Incomplete => {
                    return Ok(PeerInboundOutcome::AcceptedByAgent)
                }
                FragmentAssembly::Conflict => {
                    return Ok(PeerInboundOutcome::Rejected {
                        detail: event_detail("application_fragment_conflict"),
                    })
                }
                FragmentAssembly::Complete(env) => {
                    envelope = env;
                }
            }
        }
        self.dispatch_inbound_envelope(delivery, &envelope).await?;
        if let Some(mid) = fragment_message_id {
            self.journal
                .mark_application_fragment_applied(&delivery.address, &mid)?;
        }
        self.wake_deferred_routes();
        Ok(PeerInboundOutcome::AcceptedByAgent)
    }

    async fn dispatch_inbound_envelope(self: &Rc<Self>, delivery: &PeerApplicationInbound, envelope: &Value) -> Result<()> {
        match envelope.get("kind").and_then(Value::as_str).unwrap_or("") {
            "operation_request" => {
                match self.receive_request(delivery, envelope).await? {
                    RequestAdmission::Deferred => {
                        self.deferred_routes
                            .borrow_mut()
                            .insert(Self::route_key(&delivery.address), delivery.address.clone());
                        return Err(deferred_dispatch());
                    }
                    _ => {}
                }
            }
            "operation_state" => self.receive_state(delivery, envelope).await?,
            "operation_result_part" => self.receive_result_part(delivery, envelope).await?,
            "operation_result_end" => self.receive_result_end(delivery, envelope).await?,
            "operation_cancel" => self.receive_cancel(delivery, envelope).await?,
            "catalog_request" => self.receive_catalog_request(delivery, envelope).await?,
            "catalog_response" => self.receive_catalog_response(delivery, envelope).await?,
            _ => return Err(app_error("The Peer application message kind is unsupported.")),
        }
        Ok(())
    }

    async fn receive_application_fragment(
        &self,
        delivery: &PeerApplicationInbound,
        envelope: &Value,
    ) -> Result<FragmentAssembly> {
        let message_id = assert_peer_client_opaque_id(
            envelope.get("messageId").and_then(Value::as_str).unwrap_or(""),
            "fragment.messageId",
        )?;
        let message_kind = assert_peer_application_string(
            envelope.get("messageKind").unwrap_or(&Value::Null),
            "fragment.messageKind",
            64,
        )?;
        let part_index = envelope.get("partIndex").and_then(Value::as_u64);
        let part_count = envelope.get("partCount").and_then(Value::as_u64);
        let total_bytes = envelope.get("totalBytes").and_then(Value::as_u64);
        let data = envelope.get("data").and_then(Value::as_str).unwrap_or("");
        let (part_index, part_count, total_bytes) = match (part_index, part_count, total_bytes) {
            (Some(i), Some(c), Some(t)) if c >= 1 && i < c && t >= 1 => (i, c, t),
            _ => return Err(app_error("The Peer application fragment declaration is malformed.")),
        };
        // Canonical base64url data.
        let decoded = crate::b64::b64u_decode(data, usize::MAX)
            .map_err(|_| app_error("The Peer application fragment data is malformed."))?;
        if decoded.is_empty() || b64u_encode(&decoded) != data {
            return Err(app_error("The Peer application fragment data is malformed."));
        }
        if delivery.message.message_id != peer_application_fragment_message_id(&message_id, part_index)? {
            return Err(app_error(
                "The Peer application fragment transport id does not match its part index.",
            ));
        }
        let fragment = PeerApplicationFragment {
            address: delivery.address.clone(),
            message_id: message_id.clone(),
            message_kind: message_kind.clone(),
            part_index,
            part_count,
            total_bytes,
            data: data.to_string(),
        };
        let saved = self.journal.save_application_fragment(&fragment)?;
        match saved.status {
            PeerApplicationFragmentSaveStatus::Backpressured => return Ok(FragmentAssembly::Backpressured),
            PeerApplicationFragmentSaveStatus::Conflict => return Ok(FragmentAssembly::Conflict),
            PeerApplicationFragmentSaveStatus::Applied => return Ok(FragmentAssembly::Applied),
            PeerApplicationFragmentSaveStatus::Incomplete => return Ok(FragmentAssembly::Incomplete),
            PeerApplicationFragmentSaveStatus::Complete => {}
        }
        let Some(bytes) = self
            .journal
            .read_application_fragment_message(&delivery.address, &message_id)?
        else {
            return Err(deferred_dispatch());
        };
        let Some(logical) = parse_application_envelope(&bytes) else {
            return Err(app_error("The completed Peer application fragments do not form their declared envelope."));
        };
        if logical.get("kind").and_then(Value::as_str) != Some(message_kind.as_str()) {
            return Err(app_error("The completed Peer application fragments do not form their declared envelope."));
        }
        let expected = self.expected_logical_message_id(delivery, &logical)?;
        if expected.as_deref() != Some(message_id.as_str()) {
            return Err(app_error(
                "The Peer application fragment set is not bound to its authenticated logical message.",
            ));
        }
        Ok(FragmentAssembly::Complete(logical))
    }

    /// `#expectedLogicalMessageId` — bind a reassembled envelope to the exact
    /// transport identity its authenticated content requires.
    fn expected_logical_message_id(&self, delivery: &PeerApplicationInbound, envelope: &Value) -> Result<Option<String>> {
        let sender_device_id = &delivery.address.peer_device_id;
        match envelope.get("kind").and_then(Value::as_str) {
            Some("operation_request") => {
                let origin = self.read_address(envelope.get("originAddress"))?;
                let operation_id = assert_peer_client_opaque_id(
                    envelope.get("operationId").and_then(Value::as_str).unwrap_or(""),
                    "operationId",
                )?;
                if envelope.get("deliveryId").and_then(Value::as_str) != Some("request") {
                    return Ok(None);
                }
                Ok(Some(peer_application_transport_message_id(
                    sender_device_id,
                    &peer_application_operation_key(&origin, &operation_id),
                    "request",
                    0,
                    0,
                )))
            }
            Some("operation_state") | Some("operation_result_part") | Some("operation_result_end")
            | Some("operation_cancel") => {
                let origin = self.read_address(envelope.get("originAddress"))?;
                let operation_id = assert_peer_client_opaque_id(
                    envelope.get("operationId").and_then(Value::as_str).unwrap_or(""),
                    "operationId",
                )?;
                let Some(delivery_id) = envelope.get("deliveryId").and_then(Value::as_str) else {
                    return Ok(None);
                };
                Ok(Some(peer_application_transport_message_id(
                    sender_device_id,
                    &peer_application_operation_key(&origin, &operation_id),
                    delivery_id,
                    0,
                    0,
                )))
            }
            Some("catalog_request") | Some("catalog_response") => {
                let address = self.read_address(envelope.get("address"))?;
                let request_id = assert_peer_client_opaque_id(
                    envelope.get("requestId").and_then(Value::as_str).unwrap_or(""),
                    "requestId",
                )?;
                let expected = if envelope.get("kind").and_then(Value::as_str) == Some("catalog_request") {
                    "catalog:request"
                } else {
                    "catalog:response"
                };
                if envelope.get("deliveryId").and_then(Value::as_str) != Some(expected) {
                    return Ok(None);
                }
                Ok(Some(peer_application_transport_message_id(
                    sender_device_id,
                    &peer_application_discovery_key(&address, &request_id),
                    expected,
                    0,
                    0,
                )))
            }
            _ => Ok(None),
        }
    }

    /* ------------------------------ receivers ------------------------------ */

    async fn receive_request(self: &Rc<Self>, inbound: &PeerApplicationInbound, envelope: &Value) -> Result<RequestAdmission> {
        let origin_address = self.read_address(envelope.get("originAddress"))?;
        if origin_address != reverse_peer_application_address(&inbound.address) {
            return Err(app_error("The operation request route is out of scope."));
        }
        let operation_id = assert_peer_client_opaque_id(
            envelope.get("operationId").and_then(Value::as_str).unwrap_or(""),
            "operationId",
        )?;
        let target_agent_id = assert_peer_client_opaque_id(
            envelope.get("targetAgentId").and_then(Value::as_str).unwrap_or(""),
            "targetAgentId",
        )?;
        let caller_agent_id = match envelope.get("callerAgentId") {
            Some(Value::Null) | None => None,
            Some(v) => Some(assert_peer_client_opaque_id(
                v.as_str().unwrap_or(""),
                "callerAgentId",
            )?),
        };
        let prompt = assert_peer_application_string(
            envelope.get("prompt").unwrap_or(&Value::Null),
            "prompt",
            32_000,
        )?;
        let model = match envelope.get("model") {
            Some(Value::Null) | None => None,
            Some(v) => Some(assert_peer_application_string(v, "model", 128)?),
        };
        let digest = assert_peer_application_string(
            envelope.get("requestDigest").unwrap_or(&Value::Null),
            "requestDigest",
            128,
        )?;
        let expected_digest = peer_application_request_digest(
            &origin_address,
            caller_agent_id.as_deref(),
            &target_agent_id,
            &prompt,
            model.as_deref(),
        );
        if digest != expected_digest || envelope.get("deliveryId").and_then(Value::as_str) != Some("request") {
            return Err(app_error("The operation request is immutable or malformed."));
        }
        let key = peer_application_operation_key(&origin_address, &operation_id);

        let validate_existing = |existing: Option<PeerApplicationRecord>| -> Result<Option<PeerApplicationRecord>> {
            if let Some(existing) = &existing {
                if existing.request_digest != digest
                    || existing.origin_address != origin_address
                    || existing.route_address != inbound.address
                {
                    return Err(app_error(
                        "The operation id is already bound to different request data.",
                    ));
                }
            }
            Ok(existing)
        };

        // Re-delivery of accepted work is not a new admission; check the
        // journal before consulting live authority.
        let mut existing = validate_existing(self.journal.get_operation(&key)?)?;
        if existing.is_none() {
            let authority = self.resolve_execution_authority(&inbound.address).await;
            if authority != PeerApplicationRouteAuthority::Current {
                existing = validate_existing(self.journal.get_operation(&key)?)?;
                if existing.is_none() {
                    if authority == PeerApplicationRouteAuthority::Unavailable {
                        tracing::debug!("request deferred: execution authority unavailable");
                        return Ok(RequestAdmission::Deferred);
                    }
                    return Err(entry_error(
                        "peer_application_route_revoked",
                        "The paired route was revoked before this request was accepted.",
                    ));
                }
            }
        }

        let admission_result: Result<RequestAdmission> = {
            let _admission = self.admission_lock.lock().await;
            let key2 = key.clone();
            let inbound_address = inbound.address.clone();
            let message_id = inbound.message.message_id.clone();
            let origin2 = origin_address.clone();
            let digest2 = digest.clone();
            let this = Rc::clone(self);
            self.with_key_lock(&key2, || async {
                let existing = validate_existing(this.journal.get_operation(&key2)?)?;
                if let Some(existing) = existing {
                    return Ok(RequestAdmission::Existing(existing));
                }
                let agents = match this.agents.list().await {
                    Ok(list) => list,
                    Err(e) => {
                        tracing::debug!(error = ?e, "request deferred: agent list failed");
                        return Ok(RequestAdmission::Deferred);
                    }
                };
                let agent = if agents.iter().any(|a| a.id == target_agent_id && a.enabled) {
                    this.agents.get(&target_agent_id)
                } else {
                    None
                };
                let accepted_record = make_operation_record(OperationRecordSeed {
                    key: key2.clone(),
                    operation_id: operation_id.clone(),
                    origin_address: origin2.clone(),
                    route_address: inbound_address.clone(),
                    role: "receiver".to_string(),
                    caller_agent_id,
                    target_agent_id: target_agent_id.clone(),
                    request_digest: digest2.clone(),
                    prompt: prompt.clone(),
                    model: model.clone(),
                    status: "accepted".to_string(),
                    inbound_message_id: Some(message_id),
                });
                if agent.is_none() {
                    this.save_operation(&accepted_record).await?;
                    return Ok(RequestAdmission::UnavailableAgent(accepted_record));
                }
                let outstanding = this.count_outstanding_executions().await?;
                if outstanding >= MAX_OUTSTANDING_EXECUTIONS {
                    tracing::debug!(outstanding, "request deferred: execution slots full");
                    return Ok(RequestAdmission::Deferred);
                }
                this.save_operation(&accepted_record).await?;
                Ok(RequestAdmission::Accepted(accepted_record))
            })
            .await
        };
        let admission = match admission_result {
            Ok(a) => a,
            Err(e) => {
                if is_peer_client_error_kind(&e) {
                    return Err(e);
                }
                tracing::debug!(error = ?e, "request deferred: admission failed");
                return Ok(RequestAdmission::Deferred);
            }
        };
        if matches!(admission, RequestAdmission::Deferred) {
            return Ok(RequestAdmission::Deferred);
        }
        let accepted_record = admission.record().clone();
        if matches!(admission, RequestAdmission::UnavailableAgent(_)) {
            self.set_terminal(
                &accepted_record,
                "refused",
                Some("agent_unavailable"),
                "The requested local Agent is unavailable.",
                Some("refusal"),
            )
            .await?;
        } else if !accepted_record.prompt_reserved && !status_terminal(&accepted_record.status) {
            self.schedule_execution(&key);
        }
        let record2 = accepted_record.clone();
        self.defer_recovery(move |this| {
            Box::pin(async move { this.publish_receiver_state(&record2).await })
        });
        Ok(RequestAdmission::Accepted(accepted_record))
    }

    async fn publish_receiver_state(self: &Rc<Self>, record: &PeerApplicationRecord) -> Result<()> {
        if status_terminal(&record.status) {
            return self.send_stored_result(record, true).await;
        }
        let logical_id = format!("state:{}:{}", record.state_revision, record.status);
        let state = json!({
            "version": PEER_APPLICATION_PROTOCOL_VERSION,
            "kind": "operation_state",
            "operationId": record.operation_id,
            "originAddress": record.origin_address,
            "requestDigest": record.request_digest,
            "status": record.status,
            "stateRevision": record.state_revision,
            "deliveryId": logical_id
        });
        self.send_operation_event(record, &logical_id, "operation_state", &state, None, false)
            .await
    }

    async fn receive_state(&self, inbound: &PeerApplicationInbound, envelope: &Value) -> Result<()> {
        let record = self.find_matching_operation(inbound, envelope, "caller").await?;
        let status = envelope.get("status").and_then(Value::as_str).unwrap_or("");
        if !status_valid(status) || status == "delivery_pending" || status_terminal(status) {
            return Err(app_error("The remote operation state is invalid."));
        }
        let revision = envelope.get("stateRevision").and_then(Value::as_u64);
        let Some(revision) = revision else {
            return Err(app_error("The remote operation state revision is invalid."));
        };
        if revision < 1 || envelope.get("deliveryId").and_then(Value::as_str) != Some(format!("state:{revision}:{status}").as_str()) {
            return Err(app_error("The remote operation state revision is invalid."));
        }
        self.with_key_lock(&record.key, || async {
            let Some(current) = self.journal.get_operation(&record.key)? else {
                return Ok(());
            };
            if status_terminal(&current.status) {
                return Ok(());
            }
            if revision < current.state_revision {
                return Ok(());
            }
            if revision == current.state_revision {
                if status != current.status {
                    return Err(app_error(
                        "The remote operation state revision conflicts with durable state.",
                    ));
                }
                return Ok(());
            }
            if !can_follow_operation_state(&current.status, status) {
                return Err(app_error("The remote operation state transition is invalid."));
            }
            self.save_operation(&update_record(&current, RecordPatch {
                status: Some(status.to_string()),
                state_revision: Some(revision),
                ..Default::default()
            }))
            .await
        })
        .await
    }

    async fn receive_result_part(&self, inbound: &PeerApplicationInbound, envelope: &Value) -> Result<()> {
        let record = self.find_matching_operation(inbound, envelope, "caller").await?;
        let index = envelope.get("index").and_then(Value::as_u64);
        let text = envelope.get("text").and_then(Value::as_str);
        let (index, text) = match (index, text) {
            (Some(i), Some(t)) => (i, t),
            _ => return Err(app_error("The operation result part is invalid.")),
        };
        self.journal.save_result_part(&record.key, &PeerApplicationResultPart {
            index,
            text: text.to_string(),
        })
    }

    async fn receive_result_end(&self, inbound: &PeerApplicationInbound, envelope: &Value) -> Result<()> {
        let record = self.find_matching_operation(inbound, envelope, "caller").await?;
        let status = envelope.get("status").and_then(Value::as_str).unwrap_or("");
        let digest = assert_peer_application_string(
            envelope.get("resultDigest").unwrap_or(&Value::Null),
            "resultDigest",
            128,
        )?;
        let part_count = envelope.get("partCount").and_then(Value::as_u64);
        let stop_reason = match envelope.get("stopReason") {
            Some(Value::Null) | None => None,
            Some(v) => v.as_str().map(|s| s.to_string()),
        };
        let Some(part_count) = part_count else {
            return Err(app_error("The operation result terminator is invalid."));
        };
        if !status_valid(status)
            || !status_terminal(status)
            || (stop_reason.is_some() && !stop_reason_valid(stop_reason.as_deref().unwrap()))
            || envelope.get("deliveryId").and_then(Value::as_str) != Some("result:end")
        {
            return Err(app_error("The operation result terminator is invalid."));
        }
        let parts = self.journal.list_result_parts(&record.key)?;
        if parts.len() as u64 > part_count || parts.iter().any(|p| p.index >= part_count) {
            return Err(app_error("The operation result contains parts outside its declared range."));
        }
        if parts.len() as u64 != part_count {
            return Err(deferred_dispatch());
        }
        let mut text = String::new();
        for (index, part) in parts.iter().enumerate() {
            if part.index != index as u64 {
                return Err(deferred_dispatch());
            }
            text.push_str(&part.text);
        }
        let actual_digest = peer_application_text_digest(&text);
        if actual_digest != digest {
            return Err(app_error("The operation result digest does not match."));
        }
        self.with_key_lock(&record.key, || async {
            let Some(current) = self.journal.get_operation(&record.key)? else {
                return Ok(());
            };
            if status_terminal(&current.status) {
                if current.result_digest.as_deref() != Some(digest.as_str()) {
                    return Err(app_error("A terminal result conflicts with durable content."));
                }
                return Ok(());
            }
            self.save_operation(&update_record(&current, RecordPatch {
                status: Some(status.to_string()),
                result_text: Some(Some(text.clone())),
                result_digest: Some(Some(digest.clone())),
                result_stop_reason: Some(stop_reason.clone()),
                result_status: Some(Some(status.to_string())),
                result_part_count: Some(Some(part_count)),
                last_error: Some(if status == "unknown" {
                    Some("execution_outcome_unknown".to_string())
                } else {
                    None
                }),
                ..Default::default()
            }))
            .await
        })
        .await
    }

    async fn receive_cancel(self: &Rc<Self>, inbound: &PeerApplicationInbound, envelope: &Value) -> Result<()> {
        let record = self.find_matching_operation(inbound, envelope, "receiver").await?;
        if envelope.get("deliveryId").and_then(Value::as_str) != Some("cancel") {
            return Err(app_error("The operation cancellation id is invalid."));
        }
        let cancelled_before_prompt = self
            .with_key_lock(&record.key, || async {
                let Some(current) = self.journal.get_operation(&record.key)? else {
                    return Ok(None);
                };
                if status_terminal(&current.status) {
                    return Ok(None);
                }
                let updated = update_record(&current, RecordPatch {
                    cancel_requested: Some(true),
                    status: Some("cancel_requested".to_string()),
                    ..Default::default()
                });
                self.save_operation(&updated).await?;
                self.resolve_permission_waiter(&record.key, AcpPermissionResolution::Cancelled);
                let running = self.running.borrow().get(&record.key).cloned();
                if let Some(cancel) = running {
                    tokio::task::spawn_local(async move { cancel().await });
                }
                Ok(if current.prompt_reserved { None } else { Some(updated) })
            })
            .await?;
        if let Some(current) = self.journal.get_operation(&record.key)? {
            if current.status == "cancel_requested" {
                let this = Rc::clone(self);
                let c = current.clone();
                self.defer_recovery(move |_| Box::pin(async move { this.publish_receiver_state(&c).await }));
            }
        }
        if let Some(cancelled) = cancelled_before_prompt {
            let this = Rc::clone(self);
            self.defer_recovery(move |_| {
                Box::pin(async move { this.set_terminal(&cancelled, "cancelled", None, "", Some("cancelled")).await })
            });
        }
        Ok(())
    }

    async fn receive_catalog_request(self: &Rc<Self>, inbound: &PeerApplicationInbound, envelope: &Value) -> Result<()> {
        let request_id = assert_peer_client_opaque_id(
            envelope.get("requestId").and_then(Value::as_str).unwrap_or(""),
            "requestId",
        )?;
        let origin = self.read_address(envelope.get("address"))?;
        if origin != reverse_peer_application_address(&inbound.address)
            || envelope.get("deliveryId").and_then(Value::as_str) != Some("catalog:request")
        {
            return Err(app_error("The Agent catalog request route is invalid."));
        }
        let key = peer_application_discovery_key(&origin, &request_id);
        let response_record = self.with_key_lock(&format!("discovery:{key}"), || async {
            let existing = self.journal.get_discovery(&key)?;
            if let Some(existing) = &existing {
                if existing.status == "completed" {
                    self.journal.save_pending_discovery_recovery(&PeerApplicationDiscoveryRecovery {
                        key: existing.key.clone(),
                        address: existing.address.clone(),
                        request_id: existing.request_id.clone(),
                        action: "response".to_string(),
                    })?;
                    return Ok(Some(existing.clone()));
                }
            }
            let agents = self.agents.list().await?;
            let timestamp = now_iso();
            let record = PeerApplicationDiscoveryRecord {
                version: PEER_APPLICATION_PROTOCOL_VERSION,
                key: key.clone(),
                request_id: request_id.clone(),
                address: origin.clone(),
                status: "completed".to_string(),
                agents,
                last_error: None,
                created_at: existing.as_ref().map(|e| e.created_at.clone()).unwrap_or_else(|| timestamp.clone()),
                updated_at: timestamp,
            };
            self.journal.save_pending_discovery_recovery(&PeerApplicationDiscoveryRecovery {
                key: record.key.clone(),
                address: record.address.clone(),
                request_id: record.request_id.clone(),
                action: "response".to_string(),
            })?;
            self.journal.save_discovery(&record)?;
            self.emit(PeerApplicationChange::Discovery(record.clone()));
            Ok(Some(record))
        })
        .await?;
        if let Some(record) = response_record {
            self.defer_recovery(move |this| {
                Box::pin(async move { this.resume_catalog_response(&record).await })
            });
        }
        Ok(())
    }

    async fn receive_catalog_response(&self, inbound: &PeerApplicationInbound, envelope: &Value) -> Result<()> {
        let request_id = assert_peer_client_opaque_id(
            envelope.get("requestId").and_then(Value::as_str).unwrap_or(""),
            "requestId",
        )?;
        let origin = self.read_address(envelope.get("address"))?;
        if origin != inbound.address
            || !envelope.get("agents").map(|a| a.is_array()).unwrap_or(false)
            || envelope.get("deliveryId").and_then(Value::as_str) != Some("catalog:response")
        {
            return Err(app_error("The Agent catalog response route is invalid."));
        }
        let agents: Vec<AcpAgentSummary> = serde_json::from_value(
            envelope.get("agents").cloned().unwrap_or(Value::Null),
        )
        .map_err(|_| app_error("The Agent catalog response contains an invalid item."))?;
        let key = peer_application_discovery_key(&origin, &request_id);
        self.with_key_lock(&format!("discovery:{key}"), || async {
            let Some(current) = self.journal.get_discovery(&key)? else {
                return Err(app_error("The Agent catalog response has no matching request."));
            };
            let mut updated = current.clone();
            updated.status = "completed".to_string();
            updated.agents = agents.clone();
            updated.updated_at = now_iso();
            updated.last_error = None;
            self.journal.save_discovery(&updated)?;
            self.emit(PeerApplicationChange::Discovery(updated));
            Ok(())
        })
        .await
    }

    async fn find_matching_operation(
        &self,
        inbound: &PeerApplicationInbound,
        envelope: &Value,
        role: &str,
    ) -> Result<PeerApplicationRecord> {
        let origin_address = self.read_address(envelope.get("originAddress"))?;
        let operation_id = assert_peer_client_opaque_id(
            envelope.get("operationId").and_then(Value::as_str).unwrap_or(""),
            "operationId",
        )?;
        let digest = assert_peer_application_string(
            envelope.get("requestDigest").unwrap_or(&Value::Null),
            "requestDigest",
            128,
        )?;
        let record = if role == "caller" {
            self.caller_operation_for_address(&operation_id, &origin_address, &inbound.address, &digest)
                .await?
        } else {
            self.journal
                .get_operation(&peer_application_operation_key(&origin_address, &operation_id))?
                .ok_or_else(|| app_error("The application message has no matching durable operation."))?
        };
        if record.request_digest != digest {
            return Err(app_error("The application message has no matching durable operation."));
        }
        if record.role != role {
            return Err(app_error("The application message has the wrong operation role."));
        }
        let expected_route = if record.role == "caller" {
            record.origin_address.clone()
        } else {
            reverse_peer_application_address(&record.origin_address)
        };
        if inbound.address != expected_route || inbound.message.sender_device_id != inbound.address.peer_device_id {
            return Err(app_error("The application message does not match its authenticated route."));
        }
        Ok(record)
    }

    async fn caller_operation_for_address(
        &self,
        operation_id: &str,
        origin_address: &PeerApplicationAddress,
        inbound_address: &PeerApplicationAddress,
        request_digest: &str,
    ) -> Result<PeerApplicationRecord> {
        let record = self
            .journal
            .get_operation(&peer_application_operation_key(origin_address, operation_id))?
            .ok_or_else(|| app_error("The application message has no matching durable caller operation."))?;
        if record.role != "caller"
            || record.request_digest != request_digest
            || record.origin_address != *origin_address
            || *inbound_address != record.origin_address
        {
            return Err(app_error("The application message has no matching durable caller operation."));
        }
        Ok(record)
    }

    fn read_address(&self, value: Option<&Value>) -> Result<PeerApplicationAddress> {
        let value = value.ok_or_else(|| app_error("The application route address is invalid."))?;
        let parsed: PeerApplicationAddress = serde_json::from_value(value.clone())
            .map_err(|_| app_error("The application route address is invalid."))?;
        assert_address(&parsed)
    }

    /* ------------------------------ execution ------------------------------ */

    fn schedule_execution(self: &Rc<Self>, key: &str) {
        if self.started.borrow().contains(key) || self.disposed.get() {
            return;
        }
        let mut queue = self.execution_queue.borrow_mut();
        if !queue.contains(&key.to_string()) {
            queue.push(key.to_string());
        }
        drop(queue);
        self.pump_execution_queue();
    }

    fn pump_execution_queue(self: &Rc<Self>) {
        if self.disposed.get() || self.execution_pump_scheduled.get() {
            return;
        }
        self.execution_pump_scheduled.set(true);
        let this = Rc::clone(self);
        tokio::task::spawn_local(async move {
            this.execution_pump_scheduled.set(false);
            loop {
                if this.started.borrow().len() >= MAX_CONCURRENT_EXECUTIONS
                    || this.execution_queue.borrow().is_empty()
                {
                    return;
                }
                let mut next: Option<PeerApplicationRecord> = None;
                let keys: Vec<String> = this.execution_queue.borrow().clone();
                for key in keys {
                    match this.journal.get_operation(&key) {
                        Ok(Some(record))
                            if record.role == "receiver"
                                && !record.prompt_reserved
                                && !record.terminal_prepared
                                && !status_terminal(&record.status) =>
                        {
                            next = Some(record);
                            break;
                        }
                        _ => {
                            this.execution_queue.borrow_mut().retain(|k| k != &key);
                        }
                    }
                }
                let Some(next) = next else { return };
                this.execution_queue.borrow_mut().retain(|k| k != &next.key);
                if this.started.borrow().contains(&next.key) {
                    continue;
                }
                this.started.borrow_mut().insert(next.key.clone());
                let this2 = Rc::clone(&this);
                let key = next.key.clone();
                tokio::task::spawn_local(async move {
                    let _ = this2.execute(&key).await;
                    this2.started.borrow_mut().remove(&key);
                    this2.execution_queue.borrow_mut().retain(|k| k != &key);
                    this2.pump_execution_queue();
                    this2.wake_deferred_routes();
                });
            }
        });
    }

    async fn execute(self: &Rc<Self>, key: &str) -> Result<()> {
        let Some(record) = self.journal.get_operation(key)? else {
            return Ok(());
        };
        if record.role != "receiver" || record.prompt_reserved || status_terminal(&record.status) {
            return Ok(());
        }
        if record.cancel_requested {
            return self.set_terminal(&record, "cancelled", None, "", Some("cancelled")).await;
        }
        let authority = self.resolve_execution_authority(&record.route_address).await;
        if authority == PeerApplicationRouteAuthority::Unavailable {
            return Ok(());
        }
        if authority == PeerApplicationRouteAuthority::Revoked {
            return self
                .set_terminal(&record, "refused", Some("peer_route_revoked"),
                    "The paired route was revoked before Agent execution.", Some("refusal"))
                .await;
        }
        let agent = match self.agents.list().await {
            Ok(_) => self.agents.get(&record.target_agent_id),
            Err(_) => return Ok(()),
        };
        let Some(agent) = agent else {
            return self
                .finish(&record, &PeerApplicationExecutionResult {
                    stop_reason: "refusal".to_string(),
                    text: String::new(),
                }, "refused", Some("agent_unavailable"))
                .await;
        };
        let key2 = key.to_string();
        let handlers = PeerApplicationExecutionHandlers {
            before_prompt: {
                let this = Rc::clone(self);
                let record = record.clone();
                Box::new(move || {
                    let this = Rc::clone(&this);
                    let record = record.clone();
                    let key2 = key2.clone();
                    Box::pin(async move {
                        let current_authority = this.resolve_execution_authority(&record.route_address).await;
                        match current_authority {
                            PeerApplicationRouteAuthority::Unavailable => {
                                return Err(entry_error(
                                    "peer_application_authority_unavailable",
                                    "The paired route authority is temporarily unavailable.",
                                ));
                            }
                            PeerApplicationRouteAuthority::Revoked => {
                                return Err(entry_error(
                                    "peer_application_route_revoked",
                                    "The paired route was revoked before Agent execution.",
                                ));
                            }
                            PeerApplicationRouteAuthority::Current => {}
                        }
                        this.with_key_lock(&key2, || async {
                            let Some(current) = this.journal.get_operation(&key2)? else {
                                return Err(app_error("The durable ACP prompt reservation is no longer available."));
                            };
                            if current.prompt_reserved
                                || status_terminal(&current.status)
                                || current.cancel_requested
                            {
                                return Err(app_error("The durable ACP prompt reservation is no longer available."));
                            }
                            let reserved = update_record(&current, RecordPatch {
                                prompt_reserved: Some(true),
                                prompt_execution_id: Some(Some(this.execution_id.clone())),
                                status: Some(if current.cancel_requested {
                                    "cancel_requested".to_string()
                                } else {
                                    "running".to_string()
                                }),
                                ..Default::default()
                            });
                            this.save_operation(&reserved).await?;
                            let r2 = reserved.clone();
                            this.defer_recovery(move |t| {
                                Box::pin(async move { t.publish_receiver_state(&r2).await })
                            });
                            Ok(())
                        })
                        .await
                    }) as LocalBoxFuture<'static, Result<()>>
                })
            },
            on_progress: {
                let this = Rc::clone(self);
                let key = key.to_string();
                Box::new(move |kind: PeerApplicationProgressKind, text: String| {
                    let this = Rc::clone(&this);
                    let key = key.clone();
                    Box::pin(async move { this.record_progress(&key, kind, &text).await })
                        as LocalBoxFuture<'static, Result<()>>
                })
            },
            request_permission: {
                let this = Rc::clone(self);
                let key = key.to_string();
                Box::new(move |request: AcpPermissionPrompt| {
                    let this = Rc::clone(&this);
                    let key = key.clone();
                    Box::pin(async move { this.request_permission(&key, request).await })
                        as LocalBoxFuture<'static, AcpPermissionResolution>
                })
            },
        };
        let execution = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            agent.start(&record.operation_id, &record.prompt, record.model.clone(), handlers)
        }));
        let mut execution = match execution {
            Ok(e) => e,
            Err(_) => {
                return self
                    .set_terminal(&record, "failed", Some("peer_application_failed"), "", None)
                    .await;
            }
        };
        // Keep the cancel handle reachable while the result is awaited.
        self.running.borrow_mut().insert(key.to_string(), execution.cancel.clone());
        let result = (&mut execution.result).await;
        self.running.borrow_mut().remove(key);
        self.resolve_permission_waiter(key, AcpPermissionResolution::Cancelled);
        match result {
            Ok(Ok(result)) => {
                let status = match result.stop_reason.as_str() {
                    "end_turn" => "completed",
                    "refusal" => "refused",
                    "cancelled" => "cancelled",
                    _ => "stopped",
                };
                self.finish(&record, &result, status, None).await
            }
            Ok(Err(error)) => self.execute_failed(key, &error).await,
            Err(_) => self.execute_failed(key, &app_error("peer_application_failed")).await,
        }
    }

    async fn execute_failed(self: &Rc<Self>, key: &str, error: &EntryError) -> Result<()> {
        let Some(current) = self.journal.get_operation(key)? else {
            return Ok(());
        };
        if current.terminal_prepared {
            return self.complete_prepared_terminal(&current).await;
        }
        if current.prompt_reserved {
            // The ACP write may have crossed the process boundary before a
            // lost response; never invoke a paid prompt twice.
            let saved_parts = self.journal.list_result_parts(key)?;
            let partial_chunks = if saved_parts.is_empty() {
                self.journal.list_partial_result_chunks(key)?
            } else {
                saved_parts
            };
            let partial = partial_chunks.iter().map(|p| p.text.as_str()).collect::<String>();
            return self
                .set_terminal(&current, "unknown", Some("execution_outcome_unknown"), &partial, None)
                .await;
        }
        if current.cancel_requested {
            return self.set_terminal(&current, "cancelled", None, "", Some("cancelled")).await;
        }
        let code = safe_error_code(error);
        if code == "peer_application_authority_unavailable" {
            // Keep the accepted request queued; a route-restoration wake
            // re-schedules it.
            return Ok(());
        }
        if code == "peer_application_route_revoked" {
            return self
                .set_terminal(&current, "refused", Some("peer_route_revoked"),
                    "The paired route was revoked before Agent execution.", Some("refusal"))
                .await;
        }
        self.set_terminal(&current, "failed", Some(&code), "", None).await
    }

    async fn resolve_execution_authority(&self, address: &PeerApplicationAddress) -> PeerApplicationRouteAuthority {
        match self.peer.resolve_peer_authority(address).await {
            Ok(a @ (PeerApplicationRouteAuthority::Current | PeerApplicationRouteAuthority::Revoked)) => a,
            _ => PeerApplicationRouteAuthority::Unavailable,
        }
    }

    async fn record_progress(&self, key: &str, kind: PeerApplicationProgressKind, text: &str) -> Result<()> {
        if kind != PeerApplicationProgressKind::Message || text.is_empty() {
            return Ok(());
        }
        self.with_key_lock(key, || async {
            let Some(current) = self.journal.get_operation(key)? else {
                return Ok(());
            };
            if status_terminal(&current.status) {
                return Ok(());
            }
            let mut counts = self.partial_result_chunk_counts.borrow_mut();
            let index = match counts.get(key) {
                Some(i) => *i,
                None => {
                    drop(counts);
                    let saved = self.journal.list_partial_result_chunks(key)?;
                    let index = saved.last().map(|p| p.index + 1).unwrap_or(0);
                    counts = self.partial_result_chunk_counts.borrow_mut();
                    counts.insert(key.to_string(), index);
                    index
                }
            };
            drop(counts);
            self.journal.save_partial_result_chunk(key, index, text)?;
            self.partial_result_chunk_counts.borrow_mut().insert(key.to_string(), index + 1);
            Ok(())
        })
        .await
    }

    /* ------------------------------ permission ------------------------------ */

    async fn request_permission(self: &Rc<Self>, key: &str, request: AcpPermissionPrompt) -> AcpPermissionResolution {
        let lock = self.permission_lock(key);
        let _guard = lock.lock().await;
        let permission_id = format!("permission.{}", uuid_simple_pub());
        let mut state_to_send: Option<PeerApplicationRecord> = None;
        let (tx, rx) = oneshot::channel::<AcpPermissionResolution>();
        let pending = self
            .with_key_lock(key, || async {
                let Some(current) = self.journal.get_operation(key)? else {
                    return Ok(false);
                };
                if status_terminal(&current.status) || current.cancel_requested {
                    return Ok(false);
                }
                let permission = PeerApplicationPermissionRecord {
                    id: permission_id.clone(),
                    status: "pending".to_string(),
                    request: request.clone(),
                    selected_option_id: None,
                    updated_at: now_iso(),
                };
                let mut history = current.permission_history.clone();
                history.push(permission.clone());
                let updated = update_record(&current, RecordPatch {
                    status: Some(if current.cancel_requested {
                        "cancel_requested".to_string()
                    } else {
                        "awaiting_permission".to_string()
                    }),
                    permission: Some(Some(permission)),
                    permission_history: Some(history),
                    ..Default::default()
                });
                self.save_operation(&updated).await?;
                state_to_send = Some(updated);
                self.permission_waiters.borrow_mut().insert(
                    key.to_string(),
                    PendingPermission { resolve: tx },
                );
                Ok(true)
            })
            .await;
        match pending {
            Ok(true) => {
                if let Some(record) = state_to_send {
                    self.defer_recovery(move |this| {
                        Box::pin(async move { this.publish_receiver_state(&record).await })
                    });
                }
                rx.await.unwrap_or(AcpPermissionResolution::Cancelled)
            }
            _ => AcpPermissionResolution::Cancelled,
        }
    }

    fn resolve_permission_waiter(&self, key: &str, resolution: AcpPermissionResolution) {
        if let Some(waiter) = self.permission_waiters.borrow_mut().remove(key) {
            let _ = waiter.resolve.send(resolution);
        }
    }

    /* -------------------------------- terminal ------------------------------ */

    async fn finish(
        self: &Rc<Self>,
        record: &PeerApplicationRecord,
        result: &PeerApplicationExecutionResult,
        status: &str,
        error_code: Option<&str>,
    ) -> Result<()> {
        let Some(current) = self.journal.get_operation(&record.key)? else {
            return Ok(());
        };
        if current.status == "unknown" {
            return Ok(());
        }
        self.set_terminal(&current, status, error_code, &result.text, Some(&result.stop_reason))
            .await
    }

    /// `#setTerminal` — prepare durable result parts before the terminal state
    /// so a crash leaves a completable prepared result.
    async fn set_terminal(
        self: &Rc<Self>,
        record: &PeerApplicationRecord,
        status: &str,
        error_code: Option<&str>,
        result_text: &str,
        stop_reason: Option<&str>,
    ) -> Result<()> {
        let digest = peer_application_text_digest(result_text);
        let parts = result_parts(result_text, &record.operation_id, &record.origin_address, &record.request_digest)?;
        let status_string = status.to_string();
        let prepared = self
            .with_key_lock(&record.key, || async {
                let Some(current) = self.journal.get_operation(&record.key)? else {
                    return Ok(None);
                };
                if status_terminal(&current.status) {
                    return Ok(None);
                }
                if current.terminal_prepared {
                    if current.result_digest.as_deref() != Some(digest.as_str())
                        || current.result_status.as_deref() != Some(status_string.as_str())
                    {
                        return Err(app_error("A prepared application result conflicts with the durable result."));
                    }
                    return Ok(Some(current));
                }
                let updated = update_record(&current, RecordPatch {
                    terminal_prepared: Some(true),
                    result_status: Some(Some(status_string.clone())),
                    result_text: Some(Some(result_text.to_string())),
                    result_digest: Some(Some(digest.clone())),
                    result_stop_reason: Some(stop_reason.map(|s| s.to_string())),
                    result_part_count: Some(Some(parts.len() as u64)),
                    last_error: Some(error_code.map(|s| s.to_string())),
                    ..Default::default()
                });
                self.save_operation(&updated).await?;
                Ok(Some(updated))
            })
            .await?;
        if let Some(prepared) = prepared {
            self.complete_prepared_terminal(&prepared).await?;
        }
        Ok(())
    }

    async fn complete_prepared_terminal(self: &Rc<Self>, record: &PeerApplicationRecord) -> Result<()> {
        if !record.terminal_prepared
            || record.result_text.is_none()
            || record.result_digest.is_none()
            || record.result_part_count.is_none()
            || record.result_status.is_none()
        {
            return Ok(());
        }
        let text = record.result_text.clone().unwrap_or_default();
        let digest = peer_application_text_digest(&text);
        let parts = result_parts(&text, &record.operation_id, &record.origin_address, &record.request_digest)?;
        if Some(digest.as_str()) != record.result_digest.as_deref()
            || Some(parts.len() as u64) != record.result_part_count
        {
            return Err(app_error("The prepared application result is malformed."));
        }
        for part in &parts {
            self.journal.save_result_part(&record.key, part)?;
        }
        self.with_key_lock(&record.key, || async {
            let Some(current) = self.journal.get_operation(&record.key)? else {
                return Ok(());
            };
            if status_terminal(&current.status) || !current.terminal_prepared {
                return Ok(());
            }
            let updated_at = now_iso();
            let updated = update_record(&current, RecordPatch {
                status: current.result_status.clone(),
                terminal_prepared: Some(false),
                permission: Some(current.permission.clone().map(|p| {
                    if p.status == "pending" {
                        PeerApplicationPermissionRecord {
                            status: "unavailable".to_string(),
                            updated_at: updated_at.clone(),
                            ..p
                        }
                    } else {
                        p
                    }
                })),
                permission_history: Some(
                    current
                        .permission_history
                        .iter()
                        .map(|p| {
                            if p.status == "pending" {
                                PeerApplicationPermissionRecord {
                                    status: "unavailable".to_string(),
                                    updated_at: updated_at.clone(),
                                    ..p.clone()
                                }
                            } else {
                                p.clone()
                            }
                        })
                        .collect(),
                ),
                ..Default::default()
            });
            self.save_operation(&updated).await
        })
        .await?;
        self.journal.clear_partial_result_chunks(&record.key)?;
        self.partial_result_chunk_counts.borrow_mut().remove(&record.key);
        if let Some(completed) = self.journal.get_operation(&record.key)? {
            let c = completed.clone();
            self.defer_recovery(move |this| {
                Box::pin(async move { this.send_stored_result(&c, false).await })
            });
        }
        self.wake_deferred_routes();
        Ok(())
    }

    async fn send_stored_result(self: &Rc<Self>, record: &PeerApplicationRecord, _recovery: bool) -> Result<()> {
        if record.result_status.is_none() || record.result_part_count.is_none() || record.result_digest.is_none() {
            return Ok(());
        }
        self.journal.save_pending_operation_recovery(record)?;
        if self
            .result_handoffs_durable(&record.key, &record.route_address, record.result_part_count)
            .await?
        {
            self.finish_result_handoff(record).await?;
            return Ok(());
        }
        let parts = self.journal.list_result_parts(&record.key)?;
        for part in &parts {
            let logical_id = format!("result:part:{}", part.index);
            let envelope = json!({
                "version": PEER_APPLICATION_PROTOCOL_VERSION,
                "kind": "operation_result_part",
                "operationId": record.operation_id,
                "originAddress": record.origin_address,
                "requestDigest": record.request_digest,
                "index": part.index,
                "text": part.text,
                "deliveryId": logical_id
            });
            self.send_operation_event(record, &logical_id, "operation_result_part", &envelope, None, true)
                .await?;
        }
        let end = json!({
            "version": PEER_APPLICATION_PROTOCOL_VERSION,
            "kind": "operation_result_end",
            "operationId": record.operation_id,
            "originAddress": record.origin_address,
            "requestDigest": record.request_digest,
            "status": record.result_status,
            "stopReason": record.result_stop_reason,
            "partCount": record.result_part_count,
            "resultDigest": record.result_digest,
            "deliveryId": "result:end"
        });
        self.send_operation_event(record, "result:end", "operation_result_end", &end, None, true)
            .await?;
        self.finish_result_handoff(record).await
    }

    async fn result_handoffs_durable(
        &self,
        key: &str,
        route_address: &PeerApplicationAddress,
        result_part_count: Option<u64>,
    ) -> Result<bool> {
        let Some(part_count) = result_part_count else {
            return Ok(false);
        };
        for index in 0..part_count {
            let logical_id = format!("result:part:{index}");
            let message_id = peer_application_transport_message_id(
                &route_address.local_device_id,
                key,
                &logical_id,
                0,
                0,
            );
            let plan = self.journal.get_pending_handoff(&message_id)?;
            let ids: Vec<String> = match &plan {
                Some(p) if p.part_count > 0 => (0..p.part_count)
                    .map(|i| peer_application_fragment_message_id(&message_id, i).unwrap_or_default())
                    .collect(),
                _ => vec![message_id],
            };
            for id in &ids {
                let state = self.peer.get_send_state(route_address, id).await?;
                if state.as_deref() == Some("conflict") {
                    return Err(app_error(
                        "A durable Peer result conflicts with its fixed transport identity.",
                    ));
                }
                if state.is_none() {
                    return Ok(false);
                }
            }
        }
        let end_id = peer_application_transport_message_id(
            &route_address.local_device_id,
            key,
            "result:end",
            0,
            0,
        );
        let state = self.peer.get_send_state(route_address, &end_id).await?;
        if state.as_deref() == Some("conflict") {
            return Err(app_error(
                "A durable Peer result terminator conflicts with its fixed transport identity.",
            ));
        }
        Ok(state.is_some())
    }

    async fn finish_result_handoff(self: &Rc<Self>, record: &PeerApplicationRecord) -> Result<()> {
        self.with_key_lock(&record.key, || async {
            let Some(current) = self.journal.get_operation(&record.key)? else {
                return Ok(());
            };
            if current.result_digest == record.result_digest
                && status_terminal(&current.status)
                && !current.terminal_prepared
            {
                self.journal.clear_partial_result_chunks(&record.key)?;
                self.journal
                    .clear_pending_operation_recovery(&record.key, Some(current.state_revision))?;
            }
            Ok(())
        })
        .await?;
        self.clear_result_handoff_plans(&record.key, &record.route_address, record.result_part_count)
            .await?;
        self.wake_deferred_routes();
        Ok(())
    }

    async fn clear_result_handoff_plans(
        &self,
        key: &str,
        route_address: &PeerApplicationAddress,
        result_part_count: Option<u64>,
    ) -> Result<()> {
        let Some(part_count) = result_part_count else {
            return Ok(());
        };
        for index in 0..part_count {
            let logical_id = format!("result:part:{index}");
            self.journal.clear_pending_handoff(&peer_application_transport_message_id(
                &route_address.local_device_id,
                key,
                &logical_id,
                0,
                0,
            ))?;
        }
        self.journal.clear_pending_handoff(&peer_application_transport_message_id(
            &route_address.local_device_id,
            key,
            "result:end",
            0,
            0,
        ))
    }
}

struct SendLogical<'a> {
    operation_key: &'a str,
    address: &'a PeerApplicationAddress,
    logical_id: &'a str,
    kind: &'a str,
    envelope: &'a Value,
    source_kind: &'a str,
    prepared: Option<Vec<u8>>,
    retain_plan: bool,
}

enum FragmentAssembly {
    Incomplete,
    Complete(Value),
    Applied,
    Backpressured,
    Conflict,
}

enum RequestAdmission {
    Existing(PeerApplicationRecord),
    Accepted(PeerApplicationRecord),
    UnavailableAgent(PeerApplicationRecord),
    Deferred,
}

impl RequestAdmission {
    fn record(&self) -> &PeerApplicationRecord {
        match self {
            Self::Existing(r) | Self::Accepted(r) | Self::UnavailableAgent(r) => r,
            Self::Deferred => unreachable!(),
        }
    }
}

fn parse_state_logical_id(logical_id: &str) -> Result<(u64, String)> {
    // `state:<revision>:<status>` — revision digits then a snake_case status.
    let rest = logical_id.strip_prefix("state:").ok_or_else(|| {
        app_error("A pending Peer state handoff has an invalid revision.")
    })?;
    let (digits, status) = rest.split_once(':').ok_or_else(|| {
        app_error("A pending Peer state handoff has an invalid revision.")
    })?;
    let revision: u64 = digits.parse().ok().filter(|r| *r >= 1).ok_or_else(|| {
        app_error("A pending Peer state handoff has an invalid revision.")
    })?;
    if !status_valid(status) || logical_id != format!("state:{revision}:{status}") {
        return Err(app_error("A pending Peer state handoff has an invalid revision."));
    }
    Ok((revision, status.to_string()))
}

fn deferred_dispatch() -> EntryError {
    let mut e = app_error("deferred_dispatch");
    e.code = "deferred_dispatch".to_string();
    e
}

fn is_deferred(e: &EntryError) -> bool {
    e.code == "deferred_dispatch"
}

fn uuid_simple_pub() -> String {
    super::client::uuid_simple()
}
