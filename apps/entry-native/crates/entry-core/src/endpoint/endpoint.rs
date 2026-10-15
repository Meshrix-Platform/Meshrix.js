//! `endpoint.ts` — `PrivateEndpoint`: the endpoint-side composition of relay
//! session, identity store, pairing application, recovery authority,
//! operation recovery and the pinned inner-TLS channel.
//!
//! The relay driver and account-authority calls are blocking work on the
//! owning endpoint thread. The inner TLS channel runs on a dedicated
//! std::thread owning the rustls connection and frame duplex; it touches
//! shared state only through the `EndpointShared` mutexes.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::b64::{b64u_decode, b64u_encode};
use crate::endpoint::channel::{frame_duplex, FrameDuplex, FrameDuplexHandle};
use crate::endpoint::identity_store::{EndpointDeviceRecord, EndpointIdentityStore};
use crate::endpoint::operation_recovery::{EndpointOperationRecovery, OperationQueryContext, PermitState};
use crate::endpoint::pairing::{ActivePairingBootstrap, EndpointPairingApplication, PairingCompleteInput};
use crate::endpoint::recovery_flow::EndpointRecoveryAuthority;
use crate::relay::inner_tls::pinned_server_config;
use crate::relay::session::{PrivateRelaySession, SessionEvent, TransportPort};
use crate::wire::account::{is_account_step_up_permit_id, AccountActionTarget, AccountAuthorityBinding};
use crate::wire::recovery::{
    parse_operation_query, parse_recovery_proof, parse_recovery_request, recovery_message_kind,
};
use crate::wire::session::{parse_pairing_bootstrap, RelayAdmission};

/// `pinCandidatesFromStoredIdentity` — a stored field yields its raw form,
/// its `fp.`-stripped form, and — when it is a raw Ed25519 key — the derived
/// SPKI pin, so paired and recovered devices both bind by public-key digest.
fn pin_candidates(value: &str, into: &mut std::collections::HashSet<String>) {
    if value.is_empty() {
        return;
    }
    into.insert(value.to_string());
    if let Some(stripped) = value.strip_prefix("fp.") {
        into.insert(stripped.to_string());
    }
    if let Some(pin) = crate::endpoint::pairing::raw_ed25519_pin(value) {
        into.insert(pin);
    }
}

/// `pinnedPeerSpkiCandidates` — every enrolled, non-revoked entry binding
/// plus the admitted device's own paired identity.
pub fn pinned_peer_spki_candidates(
    identity: &EndpointIdentityStore,
    current_device: &EndpointDeviceRecord,
) -> Vec<String> {
    let mut pins = std::collections::HashSet::new();
    let collect = |record: &EndpointDeviceRecord, pins: &mut std::collections::HashSet<String>| {
        if record.revoked {
            return;
        }
        pin_candidates(&record.paired_identity_key, pins);
        pin_candidates(&record.paired_identity_fingerprint, pins);
    };
    collect(current_device, &mut pins);
    for record in identity.devices() {
        if record.role == "entry" {
            collect(&record, &mut pins);
        }
    }
    pins.into_iter().collect()
}

#[derive(Debug, Clone, PartialEq)]
struct PairingLocator {
    bootstrap_id: String,
    entry_session_id: String,
}

/// The authenticated inner-channel peer, resolved exactly once at handshake
/// completion — a fresh pairing locator or a pinned enrolled device.
#[derive(Debug, Clone)]
pub struct ChannelPeer {
    pub peer_session_id: String,
    pub peer_spki: String,
    pub pairing_only: bool,
    pub device: Option<EndpointDeviceRecord>,
}

/// `EndpointAuthorityPort.contextFor` — the authenticated caller context the
/// operation-recovery answer binds to.
#[derive(Debug, Clone)]
pub struct EndpointAuthorityContext {
    pub tenant: String,
    pub principal: String,
    pub auth_generation: String,
    pub grant_revision: String,
    pub routes: Vec<String>,
}

pub trait EndpointAuthorityPort: Send + Sync {
    fn context_for(&self, device: &EndpointDeviceRecord) -> Option<EndpointAuthorityContext>;
}

/// Personal-mode `contextFor` — the TS `endpointAuthority` literal.
pub struct PersonalEndpointAuthority {
    pub scope: String,
}

impl EndpointAuthorityPort for PersonalEndpointAuthority {
    fn context_for(&self, device: &EndpointDeviceRecord) -> Option<EndpointAuthorityContext> {
        Some(EndpointAuthorityContext {
            tenant: device.tenant_id.clone(),
            principal: device.principal_ref.clone(),
            auth_generation: device.trust_generation.to_string(),
            grant_revision: device.admission_generation.to_string(),
            routes: vec![self.scope.clone()],
        })
    }
}

/// Inbound line dispatch — the resolved peer plus the decoded JSON-RPC line
/// produce the response payload (`Value::Null` writes nothing back).
pub trait EndpointChannelDispatch: Send + Sync {
    fn dispatch(&self, peer: &ChannelPeer, message: &Value) -> Value;
}

/// State the inner-channel dispatch surface shares between the endpoint
/// owner thread and channel threads.
pub struct EndpointShared {
    pub identity: Arc<Mutex<EndpointIdentityStore>>,
    pub pairing: Option<Arc<Mutex<EndpointPairingApplication>>>,
    pub active_pairing: Mutex<Option<ActivePairingBootstrap>>,
}

impl EndpointShared {
    /// `dispatchAccountMessage` — pairing control surface over the inner
    /// channel. Pairing-only channels admit only `meshrix/pairing/*`.
    pub fn dispatch_account_message(
        &self,
        peer_session_id: &str,
        pairing_only: bool,
        device: Option<&EndpointDeviceRecord>,
        message: &Value,
    ) -> Value {
        let Some(pairing) = &self.pairing else { return Value::Null };
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return Value::Null;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let param_str = |k: &str| params.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let parse_binding = |v: &Value| {
            serde_json::from_value(v.clone()).unwrap_or(AccountAuthorityBinding {
                account_id: String::new(),
                auth_epoch: 0,
            })
        };
        let parse_target = |v: &Value| {
            serde_json::from_value(v.clone()).unwrap_or(AccountActionTarget {
                tenant_id: String::new(),
                route_id: String::new(),
                device_id: String::new(),
                device_public_key: String::new(),
                grant_ref: String::new(),
                scopes: vec![],
                vault_writer_rotation: None,
            })
        };
        if pairing_only {
            let active = self.active_pairing.lock().unwrap().clone();
            let Some(active) = active else {
                return json!({ "outcome": "refused", "refusal": "pairing_bootstrap_stale" });
            };
            if active.entry_session_id != peer_session_id
                || params.get("bootstrapId").and_then(Value::as_str) != Some(active.bootstrap_id.as_str())
            {
                return json!({ "outcome": "refused", "refusal": "pairing_bootstrap_stale" });
            }
            let mut app = pairing.lock().unwrap();
            let mut identity = self.identity.lock().unwrap();
            match method {
                "meshrix/pairing/begin" => match app.begin_pairing(
                    &mut identity,
                    &active.bootstrap_id,
                    &active.entry_session_id,
                    &param_str("inviteId"),
                    &param_str("pairingToken"),
                    &active.entry_device_id,
                    &active.entry_device_public_key,
                ) {
                    Ok(r) => serde_json::to_value(r).unwrap_or(Value::Null),
                    Err(e) => {
                        tracing::debug!(error = ?e, "pairing begin dispatch failed");
                        json!({ "outcome": "refused", "refusal": "pairing_method_refused" })
                    }
                },
                "meshrix/pairing/complete" => {
                    let input = PairingCompleteInput {
                        bootstrap_id: active.bootstrap_id.clone(),
                        entry_session_id: active.entry_session_id.clone(),
                        invite_id: param_str("inviteId"),
                        pairing_token: param_str("pairingToken"),
                        challenge_id: param_str("challengeId"),
                        device_id: active.entry_device_id.clone(),
                        device_public_key: active.entry_device_public_key.clone(),
                        entry_peer_identity: params
                            .get("entryPeerIdentity")
                            .and_then(|v| serde_json::from_value(v.clone()).ok()),
                        signature: param_str("signature"),
                        account: parse_binding(params.get("account").unwrap_or(&Value::Null)),
                        permit_id: param_str("permitId"),
                        purpose: param_str("purpose"),
                        target: parse_target(params.get("target").unwrap_or(&Value::Null)),
                        operation_id: param_str("operationId"),
                    };
                    match app.complete_pairing(&mut identity, &input) {
                        Ok(r) => serde_json::to_value(r).unwrap_or(Value::Null),
                        Err(_) => json!({ "outcome": "refused", "refusal": "pairing_method_refused" }),
                    }
                }
                _ => json!({ "outcome": "refused", "refusal": "pairing_method_refused" }),
            }
        } else {
            let Some(entry) = device.cloned() else { return Value::Null };
            if entry.role != "entry" || entry.revoked {
                return Value::Null;
            }
            let mut app = pairing.lock().unwrap();
            let mut identity = self.identity.lock().unwrap();
            match method {
                "meshrix/pairing/begin" => json!({ "outcome": "refused", "refusal": "pairing_method_refused" }),
                "meshrix/pairing/complete" => self.dispatch_replayed_completion(
                    &mut app,
                    &mut identity,
                    &entry,
                    peer_session_id,
                    &params,
                ),
                "meshrix/pairing/grant_catalog" => match app.grant_catalog(&entry) {
                    Ok(r) => serde_json::to_value(r).unwrap_or(Value::Null),
                    Err(_) => json!({ "outcome": "refused", "refusal": "account_binding_missing" }),
                },
                "meshrix/pairing/grant_targets" => {
                    let scopes: Vec<String> = params
                        .get("scopes")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
                        .unwrap_or_default();
                    match app.grant_target(&mut identity, &entry, &scopes) {
                        Ok(r) => serde_json::to_value(r).unwrap_or(Value::Null),
                        Err(_) => json!({ "outcome": "refused", "refusal": "grant_target_invalid" }),
                    }
                }
                "meshrix/pairing/grant_access" => match app.grant_access(
                    &mut identity,
                    &entry,
                    &parse_binding(params.get("account").unwrap_or(&Value::Null)),
                    &param_str("operationId"),
                    &param_str("permitId"),
                    &param_str("purpose"),
                    &parse_target(params.get("target").unwrap_or(&Value::Null)),
                    &param_str("signature"),
                ) {
                    Ok(r) => serde_json::to_value(r).unwrap_or(Value::Null),
                    Err(_) => json!({ "outcome": "refused", "refusal": "grant_target_mismatch" }),
                },
                _ => Value::Null,
            }
        }
    }

    /// Replayed `pairing/complete` on a fresh forward session — only the
    /// exact enrolled operation may re-answer via the persisted context.
    fn dispatch_replayed_completion(
        &self,
        app: &mut EndpointPairingApplication,
        identity: &mut EndpointIdentityStore,
        entry: &EndpointDeviceRecord,
        peer_session_id: &str,
        params: &Value,
    ) -> Value {
        let Some(bootstrap_id) = params.get("bootstrapId").and_then(Value::as_str) else {
            return json!({ "outcome": "refused", "refusal": "pairing_operation_not_replayable" });
        };
        let Some(operation) = identity.pairing_operation(bootstrap_id).cloned() else {
            return json!({ "outcome": "refused", "refusal": "pairing_operation_not_replayable" });
        };
        let Some(current_entry) = identity.device(&entry.device_id).cloned() else {
            return json!({ "outcome": "refused", "refusal": "pairing_operation_not_replayable" });
        };
        let param_str = |k: &str| params.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let same_binding = params
            .get("account")
            .and_then(|a| serde_json::from_value::<AccountAuthorityBinding>(a.clone()).ok())
            .is_some_and(|a| {
                a.account_id == operation.account.account_id && a.auth_epoch == operation.account.auth_epoch
            });
        let same_target = params
            .get("target")
            .and_then(|t| serde_json::from_value::<AccountActionTarget>(t.clone()).ok())
            .is_some_and(|t| {
                crate::canonical::canonical_json(&serde_json::to_value(&t).unwrap_or(Value::Null))
                    == crate::canonical::canonical_json(&serde_json::to_value(&operation.target).unwrap_or(Value::Null))
            });
        let entry_peer_matches = serde_json::to_value(params.get("entryPeerIdentity").cloned().unwrap_or(Value::Null)).ok()
            == serde_json::to_value(&operation.entry_peer_identity).ok()
            && serde_json::to_value(&current_entry.entry_peer_identity).ok()
                == serde_json::to_value(&operation.entry_peer_identity).ok();
        let valid = operation.state == "enrolled"
            && peer_session_id != operation.entry_session_id
            && current_entry.role == "entry"
            && !current_entry.revoked
            && operation.operation_id.as_deref().is_some_and(|s| !s.is_empty())
            && operation.permit_id.as_deref().is_some_and(is_account_step_up_permit_id)
            && operation.bootstrap_id == bootstrap_id
            && operation.target.tenant_id == current_entry.tenant_id
            && operation.target.route_id == current_entry.route_id
            && operation.target.device_id == current_entry.device_id
            && operation.target.device_public_key == current_entry.paired_identity_key
            && current_entry.account_binding.as_ref().is_some_and(|b| {
                b.account_id == operation.account.account_id && b.auth_epoch == operation.account.auth_epoch
            })
            && params.get("deviceId").and_then(Value::as_str) == Some(current_entry.device_id.as_str())
            && params.get("devicePublicKey").and_then(Value::as_str) == Some(current_entry.paired_identity_key.as_str())
            && params.get("inviteId").and_then(Value::as_str) == Some(operation.invite_id.as_str())
            && params.get("challengeId").and_then(Value::as_str) == Some(operation.challenge_id.as_str())
            && params.get("operationId").and_then(Value::as_str) == operation.operation_id.as_deref()
            && params.get("permitId").and_then(Value::as_str) == operation.permit_id.as_deref()
            && params.get("purpose").and_then(Value::as_str) == Some("pair_device")
            && same_binding
            && same_target
            && entry_peer_matches
            && !param_str("pairingToken").is_empty()
            && !param_str("signature").is_empty();
        if !valid {
            return json!({ "outcome": "refused", "refusal": "pairing_operation_not_replayable" });
        }
        let input = PairingCompleteInput {
            bootstrap_id: operation.bootstrap_id.clone(),
            entry_session_id: operation.entry_session_id.clone(),
            invite_id: operation.invite_id.clone(),
            pairing_token: param_str("pairingToken"),
            challenge_id: operation.challenge_id.clone(),
            device_id: current_entry.device_id.clone(),
            device_public_key: current_entry.paired_identity_key.clone(),
            entry_peer_identity: operation.entry_peer_identity.clone(),
            signature: param_str("signature"),
            account: operation.account.clone(),
            permit_id: operation.permit_id.clone().unwrap_or_default(),
            purpose: "pair_device".to_string(),
            target: operation.target.clone(),
            operation_id: operation.operation_id.clone().unwrap_or_default(),
        };
        match app.complete_pairing(identity, &input) {
            Ok(r) => serde_json::to_value(r).unwrap_or(Value::Null),
            Err(_) => json!({ "outcome": "refused", "refusal": "pairing_method_refused" }),
        }
    }
}

impl EndpointChannelDispatch for EndpointShared {
    fn dispatch(&self, peer: &ChannelPeer, message: &Value) -> Value {
        self.dispatch_account_message(
            &peer.peer_session_id,
            peer.pairing_only,
            peer.device.as_ref(),
            message,
        )
    }
}

/// Live channel handle held by the endpoint owner.
pub struct InnerChannelHandle {
    outbound: Mutex<std::sync::mpsc::Receiver<Vec<u8>>>,
    duplex: FrameDuplexHandle,
    established: Mutex<std::sync::mpsc::Receiver<Option<String>>>,
    peer_tx: Mutex<std::sync::mpsc::Sender<Option<ChannelPeer>>>,
    peer_session_id: String,
    closed: Arc<std::sync::atomic::AtomicBool>,
    join: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl InnerChannelHandle {
    pub fn peer_session_id(&self) -> &str {
        &self.peer_session_id
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(std::sync::atomic::Ordering::SeqCst) || self.duplex.is_closed()
    }

    /// Drain pending outbound TLS records — the owner encodes each as a
    /// base64url frame payload.
    pub fn drain_outbound(&self) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        let rx = self.outbound.lock().unwrap();
        while let Ok(bytes) = rx.try_recv() {
            out.push(bytes);
        }
        out
    }

    /// `established` — the verified peer pin once the handshake completes.
    /// `Ok(None)` on handshake failure, `Err` while still pending.
    pub fn take_established(&self) -> Result<Option<String>, std::sync::mpsc::TryRecvError> {
        self.established.lock().unwrap().try_recv()
    }

    /// Hand the resolved peer (or `None` verdict) to the channel thread so
    /// it can start or abort the request loop.
    pub fn resolve_peer(&self, peer: Option<ChannelPeer>) {
        let _ = self.peer_tx.lock().unwrap().send(peer);
    }

    pub fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        self.duplex.close();
        if let Some(join) = self.join.lock().unwrap().take() {
            let _ = join.join();
        }
    }
}

impl Drop for InnerChannelHandle {
    fn drop(&mut self) {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        self.duplex.close();
    }
}

/// The channel thread: TLS-accept on the frame duplex, report the verified
/// peer pin, wait for the owner's peer verdict, then run the ndJSON request
/// loop — line in → dispatch → response line out. The owner breaks the
/// blocking read by closing the duplex handle.
fn channel_thread(
    mut duplex: FrameDuplex,
    config: rustls::ServerConfig,
    verified_pin: Arc<Mutex<Option<String>>>,
    established_tx: std::sync::mpsc::SyncSender<Option<String>>,
    peer_rx: std::sync::mpsc::Receiver<Option<ChannelPeer>>,
    dispatch: Arc<dyn EndpointChannelDispatch>,
    closed: Arc<std::sync::atomic::AtomicBool>,
    wake: Option<tokio::sync::mpsc::UnboundedSender<()>>,
) {
    // Exactly one `established` signal — the verified pin, or `None` when the
    // handshake fails before one exists.
    let mut conn = match rustls::ServerConnection::new(Arc::new(config)) {
        Ok(conn) => conn,
        Err(e) => {
            tracing::debug!(error = %e, "inner channel accept failed to build");
            let _ = established_tx.send(None);
            if let Some(wake) = &wake {
                let _ = wake.send(());
            }
            closed.store(true, std::sync::atomic::Ordering::SeqCst);
            return;
        }
    };
    let mut handshake_ok = true;
    while conn.is_handshaking() {
        if closed.load(std::sync::atomic::Ordering::SeqCst) {
            handshake_ok = false;
            break;
        }
        if let Err(e) = conn.complete_io(&mut duplex) {
            tracing::debug!(error = %e, "inner channel handshake io failed");
            handshake_ok = false;
            break;
        }
    }
    let pin = if handshake_ok {
        verified_pin.lock().unwrap().clone()
    } else {
        None
    };
    tracing::debug!(ok = handshake_ok, pin = ?pin, "inner channel handshake");
    let _ = established_tx.send(pin);
    if let Some(wake) = &wake {
        let _ = wake.send(());
    }
    let Some(peer) = (if handshake_ok {
        // The owner resolves the pin to a ChannelPeer; a stale owner must
        // never park this thread indefinitely.
        peer_rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .ok()
            .flatten()
    } else {
        None
    }) else {
        closed.store(true, std::sync::atomic::Ordering::SeqCst);
        return;
    };
    let mut stream = rustls::StreamOwned::new(conn, duplex);
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = [0u8; 16384];
    'outer: loop {
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let mut line = pending.drain(..=pos).collect::<Vec<u8>>();
            line.pop();
            let Ok(text) = String::from_utf8(line) else { continue };
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            let response = dispatch.dispatch(&peer, &message);
            if !response.is_null() {
                // The entry correlates replies by an exact {id, outcome}
                // envelope — echo the request id verbatim.
                let envelope = json!({
                    "id": message.get("id").cloned().unwrap_or(Value::Null),
                    "outcome": response,
                });
                let mut out = serde_json::to_string(&envelope).unwrap_or_default();
                out.push('\n');
                if stream.write_all(out.as_bytes()).is_err() || stream.flush().is_err() {
                    break 'outer;
                }
            }
        }
        if closed.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => pending.extend_from_slice(&buf[..n]),
        }
    }
    closed.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// `PrivateEndpoint`.
pub struct PrivateEndpoint<T: TransportPort> {
    pub session: PrivateRelaySession<T>,
    pub shared: Arc<EndpointShared>,
    pub recovery: EndpointRecoveryAuthority,
    pub operations: EndpointOperationRecovery,
    authority: Arc<dyn EndpointAuthorityPort>,
    admission: RelayAdmission,
    server_cert_der: Vec<u8>,
    server_key_der: Vec<u8>,
    channel: Option<Arc<InnerChannelHandle>>,
    bound_peer_session_id: Option<String>,
    pending_pairing_locator: Option<PairingLocator>,
    pending_pairing_last_inspect: Option<std::time::Instant>,
    device: Option<EndpointDeviceRecord>,
    on_inner_channel: Arc<dyn Fn(Arc<InnerChannelHandle>, ChannelPeer) + Send + Sync>,
    permit_lookup: Arc<dyn Fn(&str) -> Option<PermitState> + Send + Sync>,
    /// Wakes the runtime drain task whenever a channel thread queues an
    /// outbound record or reports handshake completion.
    outbound_wake: tokio::sync::mpsc::UnboundedSender<()>,
}

impl<T: TransportPort> PrivateEndpoint<T> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        transport: T,
        admission: RelayAdmission,
        identity: Arc<Mutex<EndpointIdentityStore>>,
        authority: Arc<dyn EndpointAuthorityPort>,
        recovery: EndpointRecoveryAuthority,
        pairing: Option<Arc<Mutex<EndpointPairingApplication>>>,
        server_cert_der: Vec<u8>,
        server_key_der: Vec<u8>,
        on_inner_channel: Arc<dyn Fn(Arc<InnerChannelHandle>, ChannelPeer) + Send + Sync>,
        permit_lookup: Arc<dyn Fn(&str) -> Option<PermitState> + Send + Sync>,
        outbound_wake: tokio::sync::mpsc::UnboundedSender<()>,
    ) -> Self {
        Self {
            session: PrivateRelaySession::new(transport, admission.clone(), "forward"),
            shared: Arc::new(EndpointShared {
                identity,
                pairing,
                active_pairing: Mutex::new(None),
            }),
            recovery,
            operations: EndpointOperationRecovery::new(),
            authority,
            admission,
            server_cert_der,
            server_key_der,
            channel: None,
            bound_peer_session_id: None,
            pending_pairing_locator: None,
            pending_pairing_last_inspect: None,
            device: None,
            on_inner_channel,
            permit_lookup,
            outbound_wake,
        }
    }

    pub fn device(&self) -> Option<&EndpointDeviceRecord> {
        self.device.as_ref()
    }

    pub fn open(&mut self) -> crate::error::Result<bool> {
        self.session.open()
    }

    /// `reconnect` — resume the same session generation; callers supply the
    /// cursors the relay last acknowledged.
    pub fn reconnect(&mut self) -> crate::error::Result<bool> {
        self.session.reconnect(None, None)
    }

    pub fn close(&mut self, reason: &str) -> bool {
        self.tear_channel();
        self.bound_peer_session_id = None;
        self.clear_pairing_locator();
        self.session.close(reason)
    }

    fn clear_pairing_locator(&mut self) {
        self.pending_pairing_locator = None;
        *self.shared.active_pairing.lock().unwrap() = None;
    }

    fn tear_channel(&mut self) {
        if let Some(channel) = self.channel.take() {
            channel.close();
        }
    }

    /// `handleRelayMessage` — feed one decoded relay transport message.
    pub fn handle_relay_message(&mut self, message: &Value) {
        if let Some((bootstrap_id, entry_session_id)) = parse_pairing_bootstrap(message) {
            self.handle_pairing_bootstrap(bootstrap_id, entry_session_id);
            return;
        }
        // Identity admission must bind `device` before the driver's
        // synchronous admitted event fires inside handle_message.
        if message.get("kind").and_then(Value::as_str) == Some("session-admitted") {
            let admitted = self.shared.identity.lock().unwrap().admit(
                &self.admission.tenant_id,
                &self.admission.device_id,
                &self.admission.route_id,
                &self.admission.role,
                &self.admission.mode,
                self.admission.admission_generation,
                self.admission.revocation_revision,
            );
            if admitted.admitted {
                self.device = self
                    .shared
                    .identity
                    .lock()
                    .unwrap()
                    .device(&self.admission.device_id)
                    .cloned();
            }
        }
        // Frames park in `pending_inbound` first — `deliver_frame` needs the
        // whole endpoint, so it cannot run inside the session's `&mut` call.
        let mut admitted_seen = false;
        let kind = self
            .session
            .handle_message(message, &mut |_payload, _id, _peer_session_id| false)
            .map(|(kind, events)| {
                admitted_seen = events.iter().any(|e| matches!(e, SessionEvent::Admitted(_)));
                kind.to_string()
            })
            .or_else(|| recovery_message_kind(message).map(str::to_string));
        if admitted_seen {
            self.ensure_inner_channel();
        }
        self.flush_inbound();
        self.pump_channel_outbound();

        let Some(kind) = kind else { return };
        if kind == "session-admitted" {
            return;
        }
        // Account recovery advances an account-global epoch; the endpoint's
        // older possession-only recovery authority must not bypass it.
        let account_bound = self
            .shared
            .identity
            .lock()
            .unwrap()
            .device(&self.admission.device_id)
            .and_then(|d| d.account_binding.clone())
            .is_some();
        if self.shared.pairing.is_some()
            && account_bound
            && (kind == "recovery-request" || kind == "recovery-proof")
        {
            return;
        }
        match kind.as_str() {
            "recovery-request" => {
                if parse_recovery_request(message).is_some() {
                    let challenge = {
                        let identity = self.shared.identity.lock().unwrap();
                        self.recovery.begin_recovery(&identity, message)
                    };
                    if let Some(challenge) = challenge {
                        let _ = self.session.transport_send(&challenge);
                    }
                }
            }
            "recovery-proof" => {
                if parse_recovery_proof(message).is_some() {
                    let result = {
                        let mut identity = self.shared.identity.lock().unwrap();
                        self.recovery.complete_recovery(&mut identity, message)
                    };
                    if let Some(result) = result {
                        let _ = self.session.transport_send(&result);
                    }
                }
            }
            "operation-query" => self.handle_operation_query(message),
            _ => {}
        }
    }

    fn handle_pairing_bootstrap(&mut self, bootstrap_id: String, entry_session_id: String) {
        let Some(pairing) = self.shared.pairing.clone() else {
            self.session.fail_session("protocol_error");
            return;
        };
        let locator = PairingLocator {
            bootstrap_id: bootstrap_id.clone(),
            entry_session_id: entry_session_id.clone(),
        };
        if let Some(active) = self.shared.active_pairing.lock().unwrap().clone() {
            if active.bootstrap_id == locator.bootstrap_id && active.entry_session_id == locator.entry_session_id {
                return;
            }
        }
        if self.pending_pairing_locator.as_ref() == Some(&locator) {
            // Relay replay of the same locator — re-inspect; the account-side
            // pairing facts may have settled since the previous attempt.
            self.resolve_pending_pairing(&pairing, &locator);
            return;
        }
        self.tear_channel();
        self.bound_peer_session_id = Some(locator.entry_session_id.clone());
        *self.shared.active_pairing.lock().unwrap() = None;
        self.pending_pairing_locator = Some(locator.clone());
        self.pending_pairing_last_inspect = None;
        self.resolve_pending_pairing(&pairing, &locator);
    }

    /// Inspect a pending locator against the account authority. An
    /// unresolved or errored answer is not terminal — the bootstrap's
    /// pairing facts may still be provisioning, so the locator stays
    /// pending and inbound frames/bootstrap replays re-drive resolution.
    fn resolve_pending_pairing(
        &mut self,
        pairing: &Arc<Mutex<EndpointPairingApplication>>,
        locator: &PairingLocator,
    ) {
        self.pending_pairing_last_inspect = Some(std::time::Instant::now());
        let inspected = {
            let identity = self.shared.identity.lock().unwrap();
            let mut app = pairing.lock().unwrap();
            app.inspect_bootstrap(&identity, &locator.bootstrap_id, &locator.entry_session_id)
        };
        tracing::debug!(
            bootstrap = %locator.bootstrap_id,
            outcome = match &inspected {
                Ok(Some(_)) => "active",
                Ok(None) => "unresolved",
                Err(_) => "error",
            },
            "pairing bootstrap inspected"
        );
        if self.pending_pairing_locator.as_ref() != Some(locator) {
            return;
        }
        let active = match inspected {
            Ok(Some(active))
                if active.bootstrap_id == locator.bootstrap_id && active.entry_session_id == locator.entry_session_id =>
            {
                active
            }
            _ => {
                tracing::debug!(bootstrap = %locator.bootstrap_id, "pairing bootstrap still pending");
                return;
            }
        };
        self.pending_pairing_locator = None;
        *self.shared.active_pairing.lock().unwrap() = Some(active);
        self.ensure_inner_channel();
        self.flush_inbound();
    }

    /// `onFrame` — relay forwards the sender's sessionId verbatim; a
    /// replaced peer session starts a fresh handshake.
    fn deliver_frame(&mut self, payload: &str, peer_session_id: &str) -> bool {
        if let Some(bound) = &self.bound_peer_session_id {
            if bound != peer_session_id {
                self.tear_channel();
                if self
                    .shared
                    .active_pairing
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|a| a.entry_session_id.as_str())
                    != Some(peer_session_id)
                {
                    self.clear_pairing_locator();
                }
            }
        }
        // Keep the bounded inbound queue unacknowledged until the locator is
        // authenticated with the account authority. Provisioning lag makes
        // the first inspect transiently unresolved — arriving frames re-drive
        // the inspection on a throttle instead of dropping the session.
        while self.pending_pairing_locator.is_some()
            && self.shared.active_pairing.lock().unwrap().is_none()
        {
            let inspect_due = self
                .pending_pairing_last_inspect
                .map(|t| t.elapsed() >= std::time::Duration::from_millis(1200))
                .unwrap_or(true);
            if !inspect_due {
                return false;
            }
            let (Some(pairing), Some(locator)) = (
                self.shared.pairing.clone(),
                self.pending_pairing_locator.clone(),
            ) else {
                return false;
            };
            self.resolve_pending_pairing(&pairing, &locator);
        }
        if let Some(active) = self.shared.active_pairing.lock().unwrap().clone() {
            if active.entry_session_id != peer_session_id {
                return false;
            }
        }
        self.bound_peer_session_id = Some(peer_session_id.to_string());
        if self.channel.as_ref().map(|c| c.is_closed()).unwrap_or(true) {
            self.ensure_inner_channel();
        }
        let Some(channel) = &self.channel else { return false };
        let Ok(bytes) = b64u_decode(payload, 256 * 1024) else { return false };
        channel.duplex.feed(&bytes)
    }

    /// `flushInbound` — redrive queued frames through `deliver_frame`,
    /// stopping at the first undeliverable head. Delivered cursors commit
    /// with one cumulative `frame-ack`.
    fn flush_inbound(&mut self) {
        let pending = self.session.take_pending_inbound();
        let mut last_delivered = None;
        let mut holdback: Vec<crate::relay::session::PendingInbound> = Vec::new();
        for frame in pending {
            if !holdback.is_empty() {
                holdback.push(frame);
                continue;
            }
            if self.deliver_frame(&frame.payload, &frame.session_id) {
                last_delivered = Some(frame.seq);
            } else {
                holdback.push(frame);
            }
        }
        if let Some(seq) = last_delivered {
            self.session.commit_inbound(seq);
        }
        if !holdback.is_empty() {
            self.session.restore_pending_inbound(holdback);
        }
    }

    /// `ensureInnerChannel` — the liveness guard: a replayed admission must
    /// not orphan the live channel or stack a second handshake on it.
    fn ensure_inner_channel(&mut self) {
        let Some(device) = self.device.clone() else { return };
        if let Some(channel) = &self.channel {
            if !channel.is_closed() {
                return;
            }
        }
        self.tear_channel();
        let Some(peer_session_id) = self.bound_peer_session_id.clone() else { return };
        let active = self.shared.active_pairing.lock().unwrap().clone();
        let pairing = active.filter(|a| a.entry_session_id == peer_session_id);
        self.establish_inner_channel(device, pairing, peer_session_id);
    }

    fn establish_inner_channel(
        &mut self,
        device: EndpointDeviceRecord,
        pairing: Option<ActivePairingBootstrap>,
        peer_session_id: String,
    ) {
        let (duplex, handle, outbound) =
            frame_duplex(4 * 1024 * 1024, Some(self.outbound_wake.clone()));
        let pins: Vec<String> = match &pairing {
            Some(p) => vec![p.peer_spki.clone()],
            None => pinned_peer_spki_candidates(&self.shared.identity.lock().unwrap(), &device),
        };
        tracing::debug!(pairing = pairing.is_some(), pins = pins.len(), peer = %peer_session_id, "inner channel establishing");
        let Ok((config, verified_pin)) = pinned_server_config(
            pins,
            self.server_cert_der.clone(),
            self.server_key_der.clone(),
        ) else {
            self.session.fail_session("protocol_error");
            return;
        };
        let (established_tx, established_rx) = std::sync::mpsc::sync_channel(1);
        let (peer_tx, peer_rx) = std::sync::mpsc::channel();
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let closed_thread = closed.clone();
        let dispatch: Arc<dyn EndpointChannelDispatch> = self.shared.clone();
        let thread_wake = Some(self.outbound_wake.clone());
        let join = std::thread::spawn(move || {
            channel_thread(
                duplex,
                config,
                verified_pin,
                established_tx,
                peer_rx,
                dispatch,
                closed_thread,
                thread_wake,
            );
        });
        let channel = Arc::new(InnerChannelHandle {
            outbound: Mutex::new(outbound),
            duplex: handle,
            established: Mutex::new(established_rx),
            peer_tx: Mutex::new(peer_tx),
            peer_session_id,
            closed,
            join: Mutex::new(Some(join)),
        });
        self.channel = Some(channel);
        self.flush_inbound();
        // Resolve a fast handshake immediately instead of waiting for the
        // next relay tick — mirror of the `established.then` continuation.
        self.resolve_channel_if_ready();
    }

    /// `established.then` continuation — resolve the peer pin to a pairing
    /// locator or an enrolled device, hand the channel thread its verdict,
    /// then surface the live channel to the runtime dispatch hook.
    /// Idempotent; called after each event tick.
    pub fn resolve_channel_if_ready(&mut self) {
        let Some(channel) = self.channel.clone() else { return };
        let pin = match channel.take_established() {
            Ok(v) => v,
            Err(_) => return,
        };
        let Some(peer_spki) = pin else {
            channel.resolve_peer(None);
            channel.close();
            self.channel = None;
            return;
        };
        let peer_pin = peer_spki.clone();
        let active = self.shared.active_pairing.lock().unwrap().clone();
        let peer = match &active {
            Some(pairing) if pairing.entry_session_id == channel.peer_session_id => {
                (peer_spki == pairing.peer_spki).then(|| ChannelPeer {
                    peer_session_id: channel.peer_session_id.clone(),
                    peer_spki,
                    pairing_only: true,
                    device: None,
                })
            }
            _ => self
                .shared
                .identity
                .lock()
                .unwrap()
                .device_by_fingerprint(&peer_spki)
                .cloned()
                .filter(|d| d.role == "entry" && !d.revoked)
                .map(|d| ChannelPeer {
                    peer_session_id: channel.peer_session_id.clone(),
                    peer_spki,
                    pairing_only: false,
                    device: Some(d),
                }),
        };
        let Some(peer) = peer else {
            tracing::debug!(pin = ?peer_pin, "inner channel peer unresolvable");
            channel.resolve_peer(None);
            channel.close();
            self.channel = None;
            return;
        };
        tracing::debug!(pin = %peer.peer_spki, pairing_only = peer.pairing_only, "inner channel peer resolved");
        channel.resolve_peer(Some(peer.clone()));
        (self.on_inner_channel)(channel, peer);
    }

    fn handle_operation_query(&mut self, message: &Value) {
        let Some(query) = parse_operation_query(message) else { return };
        let Some(device) = self.device.clone() else { return };
        if let Some(pairing) = &self.shared.pairing {
            // Resolve to the live Entry trust record and pass the same
            // current-account grant check as an inner request.
            let candidates: Vec<EndpointDeviceRecord> = self
                .shared
                .identity
                .lock()
                .unwrap()
                .devices()
                .into_iter()
                .filter(|d| {
                    d.role == "entry"
                        && !d.revoked
                        && d.principal_ref == query.principal_ref
                        && d.trust_generation == query.generation
                })
                .collect();
            if candidates.len() != 1 {
                return;
            }
            let entry = candidates.into_iter().next().unwrap();
            let authorized = {
                let app = pairing.lock().unwrap();
                app.current_device_is_authorized(&entry, None)
            };
            if !authorized {
                return;
            }
            let Some(context) = self.authority.context_for(&entry) else { return };
            let status = self.operations.answer_query(
                message,
                &OperationQueryContext { principal: context.principal },
                &*self.permit_lookup,
            );
            if let Some(status) = status {
                let _ = self.session.transport_send(&status);
            }
            return;
        }
        let Some(context) = self.authority.context_for(&device) else { return };
        let status = self.operations.answer_query(
            message,
            &OperationQueryContext { principal: context.principal },
            &*self.permit_lookup,
        );
        if let Some(status) = status {
            let _ = self.session.transport_send(&status);
        }
    }

    /// Deliver outbound TLS records as relay frames — owner drains after each
    /// event tick and resolves a finished handshake.
    pub fn pump_channel_outbound(&mut self) {
        let Some(channel) = self.channel.clone() else { return };
        for bytes in channel.drain_outbound() {
            match self.session.send_payload(&b64u_encode(&bytes), None, false) {
                Ok(sent) => tracing::debug!(sent, bytes = bytes.len(), "inner channel outbound frame"),
                Err(err) => tracing::debug!(error = ?err, bytes = bytes.len(), "inner channel outbound refused"),
            }
        }
        self.resolve_channel_if_ready();
    }
}
