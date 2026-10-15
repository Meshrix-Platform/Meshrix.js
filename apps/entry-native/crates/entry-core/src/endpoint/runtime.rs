//! `personal-endpoint.ts` — `PersonalEndpointRuntime`: the same-client
//! receiving endpoint for the personal profile. The account authority owns
//! route/device allocation; this host owns custody, the encrypted relay
//! session, pairing and a durable `PeerClient`. The regular gateway path is
//! disabled by construction — application messages only travel through
//! `PeerClient` and the host-neutral application engine.
//!
//! Runs on the peer host's `LocalSet` — all state lives behind one
//! `Rc<RefCell<..>>`, matching the TS class's fields on the single-threaded
//! event loop. Blocking account HTTP calls go through `spawn_blocking` so
//! the local executor never stalls.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use futures_util::future::LocalBoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio::task::spawn_blocking;

use crate::account::{DesktopAccountClient, DesktopAuth};
use crate::b64::{b64u_decode, b64u_encode};
use crate::custody::CustodyAdapter;
use crate::endpoint::authority::{
    CurrentBindingResponse, EndpointAuthorityClient, EndpointSigner, ManagedRouteBinding,
};
use crate::endpoint::endpoint::{
    ChannelPeer, EndpointAuthorityPort, InnerChannelHandle, PersonalEndpointAuthority,
    PrivateEndpoint,
};
use crate::endpoint::identity_store::{EndpointDeviceRecord, EndpointIdentityStore};
use crate::endpoint::operation_recovery::PermitState;
use crate::endpoint::pairing::{
    account_device_authorization_matches, EndpointPairingApplication,
    EndpointPairingInviteContext,
};
use crate::endpoint::recovery_flow::{Ed25519RecoverySigner, EndpointRecoveryAuthority};
use crate::error::{entry_error, EntryError};
use crate::identity::{
    device_identity_from_custody, enroll_device_identity, load_device_keypair, DeviceIdentity,
};
use crate::keys::{random_bytes, Ed25519Keypair};
use crate::pairing::invite::{parse_pairing_invite_json, PairingInvite};
use crate::peer::application::PeerApplicationRouteAuthority;
use crate::peer::client::{
    PeerClient, PeerClientOptions, PeerClientTransport, PeerInboundMessage, PeerInboundOutcome,
    PeerRouteIdentity,
};
use crate::peer::client_store::FilePeerClientStore;
use crate::peer::identity::{create_peer_identity, load_peer_identity, PeerIdentity};
use crate::peer::wire::is_peer_schema_message;
use crate::peer::{
    peer_id_for_route_device, FilePeerCryptoStore, PairedSignalIdentity, PeerCryptoStore,
};
use crate::relay::address::{normalize_relay_base, relay_session_url};
use crate::relay::session::TransportPort;
use crate::relay::transport::{WsEvent, WsSink, WssRelayTransport};
use crate::wire::account::{
    canonical_account_action_target, is_account_step_up_permit_id, AccountActionTarget,
    AccountAuthorityBinding, PairingPeerIdentity,
};
use crate::wire::recovery::PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION;
use crate::wire::session::{
    parse_session_close, parse_session_rejected, RelayAdmission,
};
use crate::Result;

const PROFILE_SCHEMA_VERSION: u32 = 1;
const PROFILE_FILE: &str = "personal-endpoint.json";
const IDENTITY_FILE: &str = "endpoint-identity.json";
const CLAIM_SECRET_PREFIX: &str = "personal.endpoint.claim";
const RELAY_SECRET_REF: &str = "personal.endpoint.relay";
const DEVICE_CUSTODY_PREFIX: &str = "personal.endpoint.device";
const PEER_STORE_DIR: &str = "peer";
const TRUST_SCOPE: &str = "peer:message";
const PRIVATE_PERSONAL_PREFIX: &str = "personal-endpoint";
const RECONNECT_INITIAL_MS: u64 = 500;
const RECONNECT_MAX_MS: u64 = 30_000;
const MAX_WS_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

fn personal_error(code: &str, message: &str) -> EntryError {
    entry_error(code, message)
}

/// `^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$`
fn opaque(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() >= 2
        && b.len() <= 127
        && b[0].is_ascii_alphanumeric()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'-'))
}

/// `^[A-Za-z0-9_-]{32,8192}$`
fn token_ok(value: &str) -> bool {
    let b = value.as_bytes();
    (32..=8192).contains(&b.len())
        && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}

/// `^[A-Za-z0-9_-]{32,8192}(?:\.[A-Za-z0-9_-]{24})?$`
fn relay_credential_ok(value: &str) -> bool {
    let (base, tagged) = match value.rsplit_once('.') {
        Some((base, tag)) => (base, tag.len() == 24),
        None => (value, false),
    };
    let tag_ok = tagged || !value.contains('.');
    token_ok(base) && tag_ok
}

fn same_binding(
    left: Option<&AccountAuthorityBinding>,
    right: Option<&AccountAuthorityBinding>,
) -> bool {
    matches!((left, right),
        (Some(a), Some(b)) if a.account_id == b.account_id && a.auth_epoch == b.auth_epoch)
}

fn binding_ok(value: Option<&AccountAuthorityBinding>) -> bool {
    value.is_some_and(|b| opaque(&b.account_id) && b.auth_epoch > 0)
}

fn digest(value: &str) -> String {
    b64u_encode(&Sha256::digest(value.as_bytes())[..])
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn claim_secret_ref(route_id: &str) -> String {
    // Custody refs must match the lowercase contract; hex keeps the digest
    // injective where base64url is not.
    format!(
        "{CLAIM_SECRET_PREFIX}.{}",
        hex_encode(&Sha256::digest(route_id.as_bytes()))
    )
}

fn endpoint_identity_id(prefix: &str) -> String {
    format!("{prefix}.{}", b64u_encode(&random_bytes(18)))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn account_session_transcript_body(
    route_id: &str,
    endpoint_device_id: &str,
    endpoint_public_key: &str,
    endpoint_pin_ref: &str,
) -> Value {
    json!({
        "routeId": route_id,
        "endpointDeviceId": endpoint_device_id,
        "endpointPublicKey": endpoint_public_key,
        "endpointPinRef": endpoint_pin_ref,
        "mode": "personal",
    })
}

fn validate_prepared_claim(
    value: &Value,
    account: &AccountAuthorityBinding,
    route_id: &str,
    endpoint_device_id: &str,
    endpoint_public_key: &str,
    at_ms: i64,
) -> Result<crate::endpoint::authority::ClaimPrepareResponse> {
    let fail = || {
        personal_error(
            "account_endpoint_claim_invalid",
            "Account authority returned a claim target outside this local endpoint identity.",
        )
    };
    let parsed: crate::endpoint::authority::ClaimPrepareResponse =
        serde_json::from_value(value.clone()).map_err(|_| fail())?;
    let target = &parsed.target;
    let expires_ok = chrono::DateTime::parse_from_rfc3339(&parsed.expires_at)
        .map(|t| t.timestamp_millis() > at_ms)
        .unwrap_or(false);
    let valid = opaque(&parsed.claim_id)
        && parsed.account.account_id == account.account_id
        && parsed.account.auth_epoch == account.auth_epoch
        && opaque(&parsed.vault_id)
        && target.route_id == route_id
        && target.device_id == endpoint_device_id
        && target.device_public_key == endpoint_public_key
        && opaque(&target.tenant_id)
        && opaque(&target.grant_ref)
        && !target.scopes.is_empty()
        && target.scopes.iter().all(|s| !s.is_empty())
        && target.vault_writer_rotation.is_none()
        && expires_ok;
    if !valid {
        return Err(fail());
    }
    Ok(parsed)
}

fn validate_completed_claim(
    value: &Value,
    checkpoint: &ClaimCheckpoint,
) -> Result<crate::endpoint::authority::ClaimCompleteResponse> {
    let fail = || {
        personal_error(
            "account_endpoint_claim_invalid",
            "Account authority returned an invalid endpoint claim result.",
        )
    };
    let parsed: crate::endpoint::authority::ClaimCompleteResponse =
        serde_json::from_value(value.clone()).map_err(|_| fail())?;
    let valid = value.get("claimed").and_then(Value::as_bool) == Some(true)
        && parsed.account.account_id == checkpoint.account.account_id
        && parsed.account.auth_epoch == checkpoint.account.auth_epoch
        && value.get("tenantId").and_then(Value::as_str)
            == Some(checkpoint.prepared.target.tenant_id.as_str())
        && value.get("routeId").and_then(Value::as_str) == Some(checkpoint.route_id.as_str())
        && value.get("endpointDeviceId").and_then(Value::as_str)
            == Some(checkpoint.endpoint_device_id.as_str())
        && value.get("endpointPublicKey").and_then(Value::as_str)
            == Some(checkpoint.endpoint_public_key.as_str())
        && value.get("endpointPinRef").and_then(Value::as_str)
            == Some(checkpoint.endpoint_pin_ref.as_str())
        && parsed.vault_id == checkpoint.prepared.vault_id
        && value.get("mode").and_then(Value::as_str) == Some("personal")
        && relay_credential_ok(&parsed.relay_admission)
        && parsed.admission_generation >= 1;
    if !valid {
        return Err(fail());
    }
    Ok(parsed)
}

/// `saveOwnerOnly` — atomic 0600 write inside a 0700 directory.
fn save_owner_only(path: &std::path::Path, contents: &str) -> Result<()> {
    let fail =
        || personal_error("personal_endpoint_state_write_failed", "Personal endpoint state could not be saved safely.");
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    std::fs::create_dir_all(dir).map_err(|_| fail())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("state"),
        hex_encode(&random_bytes(12))
    ));
    let write = (|| -> Result<()> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|_| fail())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        file.write_all(contents.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| fail())?;
        drop(file);
        std::fs::rename(&tmp, path).map_err(|_| fail())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    })();
    if write.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    write
}

/// `PersonalEndpointProfile` — `personal-endpoint.json` on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalEndpointProfile {
    pub schema_version: u32,
    pub endpoint_device_id: String,
    pub route_id: String,
    pub peer_store_key: Option<String>,
    pub prior_account_id: Option<String>,
    /// unregistered | enrolled | revoked
    pub state: String,
    pub account: Option<AccountAuthorityBinding>,
    pub tenant_id: Option<String>,
    pub vault_id: Option<String>,
    pub endpoint_pin_ref: Option<String>,
    pub endpoint_principal_ref: Option<String>,
    pub capability_grant_ref: Option<String>,
    pub relay_service: String,
    pub admission_generation: Option<u64>,
    pub revocation_revision: Option<u64>,
    pub pending_route_revocation_operation_id: Option<String>,
    #[serde(default)]
    pub route_revocations: Vec<crate::account::DeviceRevokeReceipt>,
}

fn default_profile(relay_service: &url::Url) -> PersonalEndpointProfile {
    let route_id = endpoint_identity_id("route.personal");
    PersonalEndpointProfile {
        schema_version: PROFILE_SCHEMA_VERSION,
        endpoint_device_id: endpoint_identity_id("dev.personal"),
        peer_store_key: Some(route_id.clone()),
        route_id,
        prior_account_id: None,
        state: "unregistered".to_string(),
        account: None,
        tenant_id: None,
        vault_id: None,
        endpoint_pin_ref: None,
        endpoint_principal_ref: None,
        capability_grant_ref: None,
        relay_service: relay_service.to_string(),
        admission_generation: None,
        revocation_revision: None,
        pending_route_revocation_operation_id: None,
        route_revocations: Vec::new(),
    }
}

fn load_profile(path: &std::path::Path, relay_service: &url::Url) -> Result<PersonalEndpointProfile> {
    let fail =
        || personal_error("personal_endpoint_state_invalid", "Personal endpoint state is malformed or unsupported.");
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(default_profile(relay_service));
        }
        Err(_) => {
            return Err(personal_error(
                "personal_endpoint_state_unreadable",
                "Personal endpoint state could not be read.",
            ));
        }
    };
    let profile: PersonalEndpointProfile = serde_json::from_str(&raw).map_err(|_| fail())?;
    let valid = profile.schema_version == PROFILE_SCHEMA_VERSION
        && opaque(&profile.endpoint_device_id)
        && opaque(&profile.route_id)
        && profile.peer_store_key.as_deref().map_or(true, opaque)
        && profile.prior_account_id.as_deref().map_or(true, opaque)
        && ["unregistered", "enrolled", "revoked"].contains(&profile.state.as_str())
        && (profile.account.is_none() || binding_ok(profile.account.as_ref()))
        && profile.tenant_id.as_deref().map_or(true, opaque)
        && profile.vault_id.as_deref().map_or(true, opaque)
        && profile.endpoint_principal_ref.as_deref().map_or(true, opaque)
        && profile.capability_grant_ref.as_deref().map_or(true, opaque)
        && profile
            .pending_route_revocation_operation_id
            .as_deref()
            .map_or(true, opaque)
        && profile
            .route_revocations
            .iter()
            .all(|r| {
                r.authority_revoked
                    && opaque(&r.operation_id)
                    && (r.target == "route" || r.target == "device")
                    && opaque(&r.tenant_id)
                    && opaque(&r.route_id)
                    && opaque(&r.device_id)
                    && (r.enforcement == "pending" || r.enforcement == "complete")
            });
    if !valid {
        return Err(fail());
    }
    let stored_relay = normalize_relay_base(&profile.relay_service, true).map_err(|_| fail())?;
    if stored_relay.as_str() != relay_service.as_str() {
        return Err(personal_error(
            "personal_endpoint_relay_conflict",
            "This personal endpoint is already bound to a different release-configured relay.",
        ));
    }
    Ok(profile)
}

/// Durable claim checkpoint kept in custody — a claim may be replayed
/// idempotently after an ambiguous response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimCheckpoint {
    pub schema_version: u32,
    /// prepared | ready | completed
    pub phase: String,
    pub account: AccountAuthorityBinding,
    pub desktop_device_id: String,
    pub desktop_public_key: String,
    pub route_id: String,
    pub endpoint_device_id: String,
    pub endpoint_public_key: String,
    pub endpoint_pin_ref: String,
    pub prepared: crate::endpoint::authority::ClaimPrepareResponse,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permit_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<crate::endpoint::authority::ClaimCompleteResponse>,
}

fn validate_checkpoint(checkpoint: &ClaimCheckpoint) -> bool {
    ["prepared", "ready", "completed"].contains(&checkpoint.phase.as_str())
        && checkpoint.schema_version == 1
        && binding_ok(Some(&checkpoint.account))
        && opaque(&checkpoint.desktop_device_id)
        && !checkpoint.desktop_public_key.is_empty()
        && opaque(&checkpoint.route_id)
        && opaque(&checkpoint.endpoint_device_id)
        && !checkpoint.endpoint_public_key.is_empty()
        && !checkpoint.endpoint_pin_ref.is_empty()
        && (checkpoint.phase == "prepared"
            || checkpoint
                .permit_id
                .as_deref()
                .is_some_and(is_account_step_up_permit_id))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalEndpointIdentity {
    pub tenant_id: String,
    pub route_id: String,
    pub endpoint_device_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PersonalEndpointPeerRoute {
    pub tenant_id: String,
    pub route_id: String,
    pub local_device_id: String,
    pub peer_device_id: String,
}

pub struct PersonalEndpointInboundMessage {
    pub address: PersonalEndpointPeerRoute,
    pub message: PeerInboundMessage,
}

pub type PersonalEndpointInboundHandler =
    Rc<dyn Fn(PersonalEndpointInboundMessage) -> LocalBoxFuture<'static, PeerInboundOutcome>>;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalEndpointEntryDevice {
    pub device_id: String,
}

enum AuthorityDecision<T> {
    Current(T),
    Changed(T),
    Revoked,
    Unavailable,
}

/// `PersonalEndpointSnapshot` — the state the service/UI layer renders.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalEndpointSnapshot {
    /// unregistered | enrolled | connecting | connected | unreachable | action_required | revoked
    pub state: String,
    pub account: Option<AccountAuthorityBinding>,
    pub endpoint: Option<PersonalEndpointIdentity>,
    pub peer_id: Option<String>,
    /// idle | connecting | open | closed
    pub relay_state: String,
    pub route_state: String,
    pub accepts_new_work: bool,
    pub route_revocations: Vec<crate::account::DeviceRevokeReceipt>,
}

#[derive(Debug, Clone)]
pub struct PersonalEndpointStepUpRequest {
    pub claim_id: String,
    pub account: AccountAuthorityBinding,
    pub target: AccountActionTarget,
}

#[derive(Debug, Clone)]
pub struct PersonalEndpointStepUpResult {
    pub account: AccountAuthorityBinding,
    pub permit_id: String,
    pub target: AccountActionTarget,
}

/// Fresh account verification is a caller-supplied round-trip — the service
/// layer drives the account step-up transaction on its own thread.
pub type StepUpDriver = Arc<
    dyn Fn(
            PersonalEndpointStepUpRequest,
        ) -> LocalBoxFuture<'static, Result<PersonalEndpointStepUpResult>>
        + Send
        + Sync,
>;

pub struct PersonalEndpointEnrollmentInput {
    pub account: AccountAuthorityBinding,
    pub account_credential: String,
    pub desktop_device_id: String,
    pub desktop_public_key: String,
    /// Custody-resolved desktop key — replaces `desktopPrivateKey`.
    pub desktop_key: Arc<Ed25519Keypair>,
    pub request_fresh_step_up: StepUpDriver,
}

pub struct PersonalEndpointRuntimeOptions {
    pub data_dir: PathBuf,
    pub custody: Arc<dyn CustodyAdapter>,
    /// Trusted release-owned relay base URL.
    pub relay_service: String,
    /// Trusted release-owned account HTTPS origin.
    pub account_origin: String,
    /// Cloudflare Access service-token pair for a gated account origin.
    pub account_access: Option<crate::account::AccessServiceToken>,
    pub allow_insecure_loopback: bool,
    pub on_state: Option<Arc<dyn Fn(PersonalEndpointSnapshot) + Send + Sync>>,
}

struct PeerClientBinding {
    client: Rc<PeerClient>,
    peer_id: String,
    channel: Rc<EndpointPeerChannel>,
}

/// `createPeerSessionChannel` for the endpoint side — sends travel the
/// relay socket verbatim while the gate refuses work outside an admitted
/// session.
struct EndpointPeerChannel {
    sink: RefCell<Option<WsSink>>,
    admitted: Cell<bool>,
}

impl PeerClientTransport for EndpointPeerChannel {
    fn send<'a>(&'a self, message: Value) -> LocalBoxFuture<'a, Result<()>> {
        Box::pin(async move {
            if !self.admitted.get() {
                return Err(entry_error(
                    "peer_channel_not_admitted",
                    "The peer channel is not admitted; the message was not sent.",
                ));
            }
            match self.sink.borrow().clone() {
                Some(sink) => sink.send(&message),
                None => Err(entry_error(
                    "peer_channel_not_admitted",
                    "The peer channel is not admitted; the message was not sent.",
                )),
            }
        })
    }
}

struct RuntimeInner {
    options: PersonalEndpointRuntimeOptions,
    data_dir: PathBuf,
    relay_base: url::Url,
    account_origin: String,
    profile_path: PathBuf,
    peer_store_dir: PathBuf,
    identity: Arc<std::sync::Mutex<EndpointIdentityStore>>,
    inbound_handlers: Vec<PersonalEndpointInboundHandler>,
    profile: PersonalEndpointProfile,
    peer_binding: Option<PeerClientBinding>,
    endpoint: Option<PrivateEndpoint<WsSink>>,
    transport: Option<Rc<WssRelayTransport>>,
    /// Monotonic generation fencing stale sockets' events.
    transport_generation: u64,
    account_authority: Option<Arc<EndpointAuthorityClient>>,
    pairing: Option<Arc<std::sync::Mutex<EndpointPairingApplication>>>,
    endpoint_key: Option<Arc<Ed25519Keypair>>,
    device_identity: Option<DeviceIdentity>,
    peer_identity: Option<PeerIdentity>,
    peer_crypto_store: Option<Rc<RefCell<dyn PeerCryptoStore>>>,
    published_peer_bundle_for: Option<String>,
    route_state: String,
    relay_state: String,
    connecting: bool,
    stopping: bool,
    reconnect_attempt: u32,
    reconnect_task: Option<tokio::task::AbortHandle>,
    started_once: bool,
}

/// `PersonalEndpointRuntime` — a cloneable `Rc` handle; all copies share one
/// inner state, matching `this` captures in the TS implementation.
#[derive(Clone)]
pub struct PersonalEndpointRuntime {
    inner: Rc<RefCell<RuntimeInner>>,
}

impl PersonalEndpointRuntime {
    /// `PersonalEndpointRuntime.create` — load or mint the durable profile,
    /// then reload claimed identity and peer identity when already enrolled.
    pub fn create(options: PersonalEndpointRuntimeOptions) -> Result<Self> {
        if options.data_dir.as_os_str().is_empty() {
            return Err(personal_error(
                "personal_endpoint_data_dir_invalid",
                "Personal endpoint data directory is required.",
            ));
        }
        if !options.custody.available() {
            return Err(personal_error(
                "personal_endpoint_custody_unavailable",
                "A protected local credential store is required for endpoint keys and relay admission.",
            ));
        }
        let data_dir = options.data_dir.join(PRIVATE_PERSONAL_PREFIX);
        let relay_base = normalize_relay_base(&options.relay_service, options.allow_insecure_loopback)?;
        let account_origin = crate::account::normalize_account_origin(&options.account_origin)?;
        let profile_path = data_dir.join(PROFILE_FILE);
        let profile = load_profile(&profile_path, &relay_base)?;
        let peer_store_dir = match &profile.peer_store_key {
            Some(key) => data_dir.join(PEER_STORE_DIR).join(key),
            None => data_dir.join(PEER_STORE_DIR),
        };
        let identity = EndpointIdentityStore::open(data_dir.join(IDENTITY_FILE))?;
        let runtime = Self {
            inner: Rc::new(RefCell::new(RuntimeInner {
                options,
                data_dir,
                relay_base,
                account_origin,
                profile_path: profile_path.clone(),
                peer_store_dir,
                identity: Arc::new(std::sync::Mutex::new(identity)),
                inbound_handlers: Vec::new(),
                profile,
                peer_binding: None,
                endpoint: None,
                transport: None,
                transport_generation: 0,
                account_authority: None,
                pairing: None,
                endpoint_key: None,
                device_identity: None,
                peer_identity: None,
                peer_crypto_store: None,
                published_peer_bundle_for: None,
                route_state: "unreachable".to_string(),
                relay_state: "idle".to_string(),
                connecting: false,
                stopping: false,
                reconnect_attempt: 0,
                reconnect_task: None,
                started_once: false,
            })),
        };
        // Persist generated route/device ids before any authority request so
        // an ambiguous response replays with the same exact claim target.
        if !profile_path.exists() {
            runtime.save_profile()?;
        }
        if runtime.inner.borrow().profile.state == "enrolled" {
            runtime.load_claimed_identity()?;
            runtime.ensure_peer_identity()?;
        }
        Ok(runtime)
    }

    pub fn peer_client(&self) -> Option<Rc<PeerClient>> {
        self.inner.borrow().peer_binding.as_ref().map(|b| b.client.clone())
    }

    /// Claimed `(tenant, route, local endpoint device)` tuple — present once
    /// the claim checkpoint or enrolled profile carries the triple. This is
    /// the address the application router binds.
    pub fn claimed_route(&self) -> Option<(String, String, String)> {
        let inner = self.inner.borrow();
        let tenant_id = inner.profile.tenant_id.clone()?;
        if inner.profile.route_id.is_empty() || inner.profile.endpoint_device_id.is_empty() {
            return None;
        }
        Some((
            tenant_id,
            inner.profile.route_id.clone(),
            inner.profile.endpoint_device_id.clone(),
        ))
    }

    pub fn endpoint_identity(&self) -> Option<PersonalEndpointIdentity> {
        let inner = self.inner.borrow();
        if inner.profile.state != "enrolled" {
            return None;
        }
        let tenant_id = inner.profile.tenant_id.clone()?;
        Some(PersonalEndpointIdentity {
            tenant_id,
            route_id: inner.profile.route_id.clone(),
            endpoint_device_id: inner.profile.endpoint_device_id.clone(),
        })
    }

    /// `enrollCurrentAccount` — prepare/claim the account-owned route,
    /// persist custody secrets, activate the identity store and profile.
    pub async fn enroll_current_account(
        &self,
        input: PersonalEndpointEnrollmentInput,
    ) -> Result<PersonalEndpointSnapshot> {
        self.assert_not_stopped()?;
        self.validate_enrollment_input(&input)?;
        {
            let inner = self.inner.borrow();
            match inner.profile.state.as_str() {
                "enrolled" => {
                    if inner.profile.account.as_ref().map(|a| a.account_id.as_str())
                        != Some(input.account.account_id.as_str())
                    {
                        return Err(personal_error(
                            "personal_endpoint_account_conflict",
                            "This endpoint is already owned by another account.",
                        ));
                    }
                    if !same_binding(inner.profile.account.as_ref(), Some(&input.account)) {
                        return Err(personal_error(
                            "personal_endpoint_reenrollment_required",
                            "This account recovered or changed epoch. Explicitly refresh the endpoint to create a new route after fresh account verification.",
                        ));
                    }
                }
                "revoked" => {
                    return Err(personal_error(
                        "personal_endpoint_reenrollment_required",
                        "This endpoint was revoked. Explicitly refresh it under the same account to create a new route after fresh account verification.",
                    ));
                }
                _ => {
                    if let Some(prior) = &inner.profile.prior_account_id {
                        if *prior != input.account.account_id {
                            return Err(personal_error(
                                "personal_endpoint_account_conflict",
                                "This retained personal profile can only be re-enrolled by its original account.",
                            ));
                        }
                    }
                }
            }
        }
        if self.inner.borrow().profile.state == "enrolled" {
            self.load_claimed_identity()?;
            return Ok(self.snapshot());
        }

        // Endpoint device key in custody — enroll on first use.
        let (device_identity, endpoint_key) = {
            let device_id = self.inner.borrow().profile.endpoint_device_id.clone();
            let custody = self.inner.borrow().options.custody.clone();
            let identity = match device_identity_from_custody(
                &*custody,
                Some(DEVICE_CUSTODY_PREFIX),
                &device_id,
            )? {
                Some(identity) => identity,
                None => enroll_device_identity(
                    &*custody,
                    Some(DEVICE_CUSTODY_PREFIX),
                    Some(device_id.clone()),
                )?,
            };
            let keypair =
                load_device_keypair(&*custody, Some(DEVICE_CUSTODY_PREFIX), &device_id)?
                    .ok_or_else(|| {
                        personal_error(
                            "personal_endpoint_key_unavailable",
                            "The endpoint signing key is unavailable in local custody.",
                        )
                    })?;
            (identity, Arc::new(keypair))
        };
        {
            let mut inner = self.inner.borrow_mut();
            inner.endpoint_key = Some(endpoint_key.clone());
            inner.device_identity = Some(device_identity.clone());
        }
        let certificate = issue_endpoint_certificate_for(&endpoint_key, &device_identity)?;
        let endpoint_pin_ref = certificate.spki_pin.clone();

        let claim_secret = self.load_claim_checkpoint()?;
        let (route_id, profile_device_id) = {
            let inner = self.inner.borrow();
            (
                inner.profile.route_id.clone(),
                inner.profile.endpoint_device_id.clone(),
            )
        };
        let checkpoint_matches = claim_secret.as_ref().is_some_and(|cp| {
            same_binding(Some(&cp.account), Some(&input.account))
                && cp.desktop_device_id == input.desktop_device_id
                && cp.desktop_public_key == input.desktop_public_key
                && cp.route_id == route_id
                && cp.endpoint_device_id == profile_device_id
                && cp.endpoint_public_key == device_identity.public_key
                && cp.endpoint_pin_ref == endpoint_pin_ref
        });
        if claim_secret.is_some() && !checkpoint_matches {
            return Err(personal_error(
                "personal_endpoint_claim_checkpoint_conflict",
                "A pending endpoint claim belongs to a different local identity or account. Preserve it or use a separate profile.",
            ));
        }
        let mut checkpoint = if checkpoint_matches { claim_secret } else { None };
        // A prepared-phase checkpoint whose claim is no longer valid (expired,
        // rotated identity, stale authority response) is not resumable — the
        // authority expires it server-side, so drop it and prepare again.
        // `ready`/`completed` checkpoints are kept: their permit is already
        // obtained (and possibly consumed), and claim completion replays
        // idempotently on operationId even when the claim itself has settled.
        if let Some(cp) = checkpoint.as_ref() {
            if cp.phase == "prepared"
                && validate_prepared_claim(
                    &serde_json::to_value(&cp.prepared).unwrap_or(Value::Null),
                    &input.account,
                    &cp.route_id,
                    &cp.endpoint_device_id,
                    &cp.endpoint_public_key,
                    now_ms(),
                )
                .is_err()
            {
                checkpoint = None;
            }
        }
        if checkpoint.is_none() {
            let prepare_body = account_session_transcript_body(
                &route_id,
                &profile_device_id,
                &device_identity.public_key,
                &endpoint_pin_ref,
            );
            let desktop_key = input.desktop_key.clone();
            let desktop_proof = crate::account::sign_desktop_account_proof(
                crate::endpoint::authority::routes::device_endpoint_claim_prepare().as_str(),
                &input.account,
                &input.account_credential,
                &input.desktop_public_key,
                &prepare_body,
                None,
                &move |msg: &[u8]| desktop_key.sign(msg),
            );
            // `device/endpoints/claim/prepare` — the claim carries the
            // desktop session proof; the endpoint proof only signs complete.
            let origin = self.inner.borrow().account_origin.clone();
            let access = self.inner.borrow().options.account_access.clone();
            let prepared_value = {
                let body = {
                    let mut body = prepare_body;
                    body.as_object_mut().unwrap().insert(
                        "desktopProof".into(),
                        desktop_proof.to_json(),
                    );
                    body
                };
                spawn_blocking(move || {
                    let client = DesktopAccountClient::new(&origin, access)?;
                    client.post_json(
                        &crate::endpoint::authority::routes::device_endpoint_claim_prepare(),
                        &body,
                    )
                })
                .await
                .map_err(|_| {
                    personal_error(
                        "account_authority_unavailable",
                        "Account authority could not be reached.",
                    )
                })??
            };
            let prepared = validate_prepared_claim(
                &prepared_value,
                &input.account,
                &route_id,
                &profile_device_id,
                &device_identity.public_key,
                now_ms(),
            )?;
            checkpoint = Some(ClaimCheckpoint {
                schema_version: 1,
                phase: "prepared".to_string(),
                account: input.account.clone(),
                desktop_device_id: input.desktop_device_id.clone(),
                desktop_public_key: input.desktop_public_key.clone(),
                route_id: route_id.clone(),
                endpoint_device_id: profile_device_id.clone(),
                endpoint_public_key: device_identity.public_key.clone(),
                endpoint_pin_ref: endpoint_pin_ref.clone(),
                prepared,
                permit_id: None,
                operation_id: None,
                completed: None,
            });
            self.save_claim_checkpoint(checkpoint.as_ref().unwrap())?;
        }
        let mut checkpoint = checkpoint.unwrap();
        // The prepared claim binds identity, route and target. Expiry only
        // matters while the checkpoint is still "prepared" — a stale claim can
        // be re-prepared. Once the permit exists ("ready"/"completed") the
        // claim row is the authority and completion replays on operationId, so
        // validate structure and identity here without the expiry gate.
        let prepared = if checkpoint.phase == "prepared" {
            validate_prepared_claim(
                &serde_json::to_value(&checkpoint.prepared).unwrap_or(Value::Null),
                &input.account,
                &checkpoint.route_id,
                &checkpoint.endpoint_device_id,
                &checkpoint.endpoint_public_key,
                now_ms(),
            )?
        } else {
            serde_json::from_value::<crate::endpoint::authority::ClaimPrepareResponse>(
                serde_json::to_value(&checkpoint.prepared).unwrap_or(Value::Null),
            )
            .map_err(|_| {
                personal_error(
                    "personal_endpoint_claim_checkpoint_invalid",
                    "The endpoint claim checkpoint is malformed.",
                )
            })?
        };
        checkpoint.prepared = prepared.clone();
        if checkpoint.phase == "prepared" {
            let step_up = (input.request_fresh_step_up)(PersonalEndpointStepUpRequest {
                claim_id: prepared.claim_id.clone(),
                account: input.account.clone(),
                target: prepared.target.clone(),
            })
            .await?;
            if !same_binding(Some(&step_up.account), Some(&input.account))
                || !is_account_step_up_permit_id(&step_up.permit_id)
                || canonical_account_action_target(&step_up.target)
                    != canonical_account_action_target(&prepared.target)
            {
                return Err(personal_error(
                    "personal_endpoint_step_up_mismatch",
                    "The fresh account factor was not bound to this endpoint claim.",
                ));
            }
            checkpoint.phase = "ready".to_string();
            checkpoint.permit_id = Some(step_up.permit_id);
            checkpoint.operation_id = Some(b64u_encode(&random_bytes(32)));
            self.save_claim_checkpoint(&checkpoint)?;
        }
        let (Some(permit_id), Some(operation_id)) =
            (checkpoint.permit_id.clone(), checkpoint.operation_id.clone())
        else {
            return Err(personal_error(
                "personal_endpoint_claim_checkpoint_invalid",
                "The endpoint claim checkpoint is missing its idempotent completion identity.",
            ));
        };
        if checkpoint.phase != "completed" {
            let endpoint_proof = {
                let access = self.inner.borrow().options.account_access.clone();
                let authority = EndpointAuthorityClient::new(
                    &self.inner.borrow().account_origin,
                    &prepared.target.tenant_id,
                    &checkpoint.route_id,
                    &checkpoint.endpoint_device_id,
                    endpoint_signer(endpoint_key.clone()),
                    access,
                )?;
                authority.sign_claim_proof(
                    &prepared.claim_id,
                    &permit_id,
                    &operation_id,
                    &endpoint_pin_ref,
                    &prepared.target,
                )?
            };
            let complete_body = json!({
                "claimId": prepared.claim_id,
                "permitId": permit_id,
                "operationId": operation_id,
                "endpointProof": serde_json::to_value(&endpoint_proof).unwrap_or(Value::Null),
            });
            let desktop_key = input.desktop_key.clone();
            let desktop_proof = crate::account::sign_desktop_account_proof(
                crate::endpoint::authority::routes::device_endpoint_claim_complete().as_str(),
                &input.account,
                &input.account_credential,
                &input.desktop_public_key,
                &complete_body,
                None,
                &move |msg: &[u8]| desktop_key.sign(msg),
            );
            let mut request = complete_body;
            request
                .as_object_mut()
                .unwrap()
                .insert("desktopProof".into(), desktop_proof.to_json());
            let origin = self.inner.borrow().account_origin.clone();
            let access = self.inner.borrow().options.account_access.clone();
            // Claim completion is idempotent on operationId — the authority
            // settles route binding, vault binding and relay admission through
            // its outbox and answers `account_effect_pending` (HTTP 503) or a
            // `claimed: false` body until the route is current. Both mean
            // "retry the same operation", not failure.
            let mut settled: Option<crate::endpoint::authority::ClaimCompleteResponse> = None;
            for attempt in 0..60 {
                if attempt > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                }
                let origin = origin.clone();
                let access = access.clone();
                let request = request.clone();
                let completed_value = match spawn_blocking(move || {
                    let client = DesktopAccountClient::new(&origin, access)?;
                    client.post_json(
                        &crate::endpoint::authority::routes::device_endpoint_claim_complete(),
                        &request,
                    )
                })
                .await
                {
                    Ok(Ok(value)) => value,
                    Ok(Err(e)) => {
                        if e.code == "account_request_refused"
                            && e.message.contains("account_effect_pending")
                        {
                            continue;
                        }
                        return Err(e.into());
                    }
                    Err(_) => {
                        return Err(personal_error(
                            "account_authority_unavailable",
                            "Account authority could not be reached.",
                        ))
                    }
                };
                if completed_value.get("claimed").and_then(Value::as_bool) != Some(true) {
                    continue;
                }
                settled = Some(validate_completed_claim(&completed_value, &checkpoint)?);
                break;
            }
            let completed = match settled {
                Some(completed) => completed,
                None => {
                    // A ready-phase claim that never settles is dead at the
                    // authority (expired pending, consumed permit). Drop the
                    // checkpoint so a retry prepares a fresh claim instead of
                    // looping on a tombstone. A claim that completed but
                    // settled slowly is re-claimed idempotently on retry.
                    if checkpoint.phase == "ready" {
                        let claim_ref = claim_secret_ref(&checkpoint.route_id);
                        let _ = self.inner.borrow().options.custody.delete_secret(&claim_ref);
                    }
                    return Err(personal_error(
                        "account_endpoint_claim_unsettled",
                        "The account claim was accepted but the route did not become current in time.",
                    ));
                }
            };
            checkpoint.phase = "completed".to_string();
            checkpoint.completed = Some(completed);
            self.save_claim_checkpoint(&checkpoint)?;
        }
        let completed = checkpoint.completed.clone().ok_or_else(|| {
            personal_error(
                "personal_endpoint_claim_checkpoint_invalid",
                "The completed account claim is missing its durable result.",
            )
        })?;

        let authority = Arc::new(EndpointAuthorityClient::new(
            &self.inner.borrow().account_origin,
            &prepared.target.tenant_id,
            &checkpoint.route_id,
            &checkpoint.endpoint_device_id,
            endpoint_signer(endpoint_key.clone()),
            self.inner.borrow().options.account_access.clone(),
        )?);
        let managed = {
            let authority = authority.clone();
            spawn_blocking(move || authority.managed_route())
                .await
                .map_err(|_| {
                    personal_error(
                        "account_authority_unavailable",
                        "Account authority could not be reached.",
                    )
                })??
        };
        let Some(managed) = managed else {
            return Err(personal_error(
                "account_endpoint_claim_not_current",
                "The account authority has not confirmed this endpoint claim as the current route owner.",
            ));
        };
        if managed.account_id != input.account.account_id
            || managed.auth_epoch != input.account.auth_epoch
            || managed.tenant_id != prepared.target.tenant_id
            || managed.route_id != checkpoint.route_id
            || managed.endpoint_device_id != checkpoint.endpoint_device_id
            || managed.endpoint_public_key != device_identity.public_key
            || managed.endpoint_pin_ref != endpoint_pin_ref
            || managed.vault_id != completed.vault_id
        {
            return Err(personal_error(
                "account_endpoint_claim_not_current",
                "The account authority has not confirmed this endpoint claim as the current route owner.",
            ));
        }
        let principal_ref = format!(
            "personal.{}",
            &digest(&format!(
                "{}\n{}",
                input.account.account_id, checkpoint.endpoint_device_id
            ))[..32]
        );
        {
            let inner = self.inner.borrow();
            let mut identity = inner.identity.lock().unwrap();
            match identity.device(&checkpoint.endpoint_device_id) {
                None => {
                    identity.enroll(
                        &checkpoint.endpoint_device_id,
                        &checkpoint.route_id,
                        &prepared.target.tenant_id,
                        &json!({
                            "schemaVersion": PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
                            "kind": "endpoint-trust-binding",
                            "pairedIdentityKey": device_identity.public_key,
                            "pairedIdentityFingerprint": device_identity.fingerprint,
                            "mode": "personal",
                            "role": "endpoint",
                            "trustGeneration": 1,
                            "endpointPrincipalRef": principal_ref,
                            "capabilityGrantRef": checkpoint.prepared.target.grant_ref,
                            "boundRecoveryKeyId": null,
                        }),
                    )?;
                }
                Some(record) => {
                    if record.role != "endpoint"
                        || record.tenant_id != prepared.target.tenant_id
                        || record.route_id != checkpoint.route_id
                        || record.paired_identity_key != device_identity.public_key
                        || record.capability_grant_ref != checkpoint.prepared.target.grant_ref
                    {
                        return Err(personal_error(
                            "personal_endpoint_identity_conflict",
                            "Stored endpoint trust does not match the verified account claim.",
                        ));
                    }
                }
            }
            identity.activate_account_endpoint_claim(
                &checkpoint.endpoint_device_id,
                &AccountAuthorityBinding {
                    account_id: managed.account_id.clone(),
                    auth_epoch: managed.auth_epoch,
                },
                completed.admission_generation,
                completed.revocation_revision,
            )?;
        }
        self.inner
            .borrow()
            .options
            .custody
            .store_secret(RELAY_SECRET_REF, completed.relay_admission.as_bytes())?;
        {
            let mut inner = self.inner.borrow_mut();
            let peer_store_key = inner
                .profile
                .peer_store_key
                .clone()
                .unwrap_or_else(|| checkpoint.route_id.clone());
            inner.profile = PersonalEndpointProfile {
                schema_version: PROFILE_SCHEMA_VERSION,
                endpoint_device_id: checkpoint.endpoint_device_id.clone(),
                route_id: checkpoint.route_id.clone(),
                peer_store_key: Some(peer_store_key),
                prior_account_id: None,
                state: "enrolled".to_string(),
                account: Some(AccountAuthorityBinding {
                    account_id: managed.account_id.clone(),
                    auth_epoch: managed.auth_epoch,
                }),
                tenant_id: Some(prepared.target.tenant_id.clone()),
                vault_id: Some(completed.vault_id.clone()),
                endpoint_pin_ref: Some(endpoint_pin_ref),
                endpoint_principal_ref: Some(principal_ref),
                capability_grant_ref: Some(checkpoint.prepared.target.grant_ref.clone()),
                relay_service: inner.relay_base.to_string(),
                admission_generation: Some(completed.admission_generation),
                revocation_revision: Some(completed.revocation_revision),
                pending_route_revocation_operation_id: None,
                route_revocations: inner.profile.route_revocations.clone(),
            };
            inner.peer_store_dir = inner
                .data_dir
                .join(PEER_STORE_DIR)
                .join(inner.profile.peer_store_key.clone().unwrap_or_default());
        }
        self.save_profile()?;
        let claim_ref = claim_secret_ref(&checkpoint.route_id);
        let _ = self.inner.borrow().options.custody.delete_secret(&claim_ref);
        self.load_claimed_identity()?;
        self.ensure_peer_identity()?;
        self.emit_state();
        Ok(self.snapshot())
    }

    /// `reenrollCurrentAccount` — explicit recovery after account recovery or
    /// endpoint-route revocation. The old route and its Peer journal remain
    /// addressable; only a same-owner fresh claim creates a new route.
    pub async fn reenroll_current_account(
        &self,
        input: PersonalEndpointEnrollmentInput,
    ) -> Result<PersonalEndpointSnapshot> {
        self.assert_not_stopped()?;
        self.validate_enrollment_input(&input)?;
        let owner_account_id = {
            let inner = self.inner.borrow();
            inner
                .profile
                .account
                .as_ref()
                .map(|a| a.account_id.clone())
                .or_else(|| inner.profile.prior_account_id.clone())
        };
        let Some(owner) = owner_account_id else {
            return Err(personal_error(
                "personal_endpoint_account_conflict",
                "A personal endpoint can only be refreshed by its original account.",
            ));
        };
        if owner != input.account.account_id {
            return Err(personal_error(
                "personal_endpoint_account_conflict",
                "A personal endpoint can only be refreshed by its original account.",
            ));
        }
        if self.inner.borrow().profile.state == "unregistered" {
            return self.enroll_current_account(input).await;
        }
        self.load_claimed_identity()?;
        let decision = self.require_current_endpoint_binding().await;
        if matches!(decision, AuthorityDecision::Unavailable) {
            return Err(personal_error(
                "account_authority_unavailable",
                "Account authority is temporarily unavailable; the existing endpoint identity and data were preserved.",
            ));
        }
        if matches!(decision, AuthorityDecision::Current(_))
            && same_binding(
                self.inner.borrow().profile.account.as_ref(),
                Some(&input.account),
            )
        {
            if self.inner.borrow().profile.state == "revoked" {
                // Recover profiles previously fenced by an ambiguous local
                // error — the authority confirms the exact original route.
                self.inner.borrow_mut().profile.state = "enrolled".to_string();
                self.save_profile()?;
                self.inner.borrow_mut().stopping = false;
                self.load_claimed_identity()?;
                self.ensure_peer_identity()?;
                self.emit_state();
                return Ok(self.snapshot());
            }
            return Err(personal_error(
                "personal_endpoint_still_current",
                "This route is still current. No replacement identity was created.",
            ));
        }
        if let AuthorityDecision::Changed(route) = &decision {
            if route.account_id != input.account.account_id {
                return Err(personal_error(
                    "personal_endpoint_account_conflict",
                    "The current route belongs to a different account; this profile cannot be taken over.",
                ));
            }
            if route.auth_epoch != input.account.auth_epoch {
                return Err(personal_error(
                    "account_stale",
                    "Sign in again with the account's current session before replacing this route.",
                ));
            }
        }
        self.revoke_current_route(&input).await?;
        self.mark_profile_revoked().await?;
        let replacement_route_id = endpoint_identity_id("route.personal");
        {
            let mut inner = self.inner.borrow_mut();
            inner.profile.endpoint_device_id = endpoint_identity_id("dev.personal");
            inner.profile.route_id = replacement_route_id.clone();
            inner.profile.peer_store_key = Some(replacement_route_id.clone());
            inner.profile.state = "unregistered".to_string();
            inner.profile.account = None;
            inner.profile.prior_account_id = Some(owner);
            inner.profile.tenant_id = None;
            inner.profile.vault_id = None;
            inner.profile.endpoint_pin_ref = None;
            inner.profile.endpoint_principal_ref = None;
            inner.profile.capability_grant_ref = None;
            inner.profile.admission_generation = None;
            inner.profile.revocation_revision = None;
            inner.profile.pending_route_revocation_operation_id = None;
            inner.peer_store_dir =
                inner.data_dir.join(PEER_STORE_DIR).join(&replacement_route_id);
            inner.peer_binding = None;
            inner.peer_identity = None;
            inner.peer_crypto_store = None;
            inner.account_authority = None;
            inner.endpoint_key = None;
            inner.device_identity = None;
            inner.pairing = None;
            inner.stopping = false;
            inner.started_once = false;
        }
        self.save_profile()?;
        self.emit_state();
        self.enroll_current_account(input).await
    }

    /// `createPairingInvite` — invite over the live admitted session only.
    pub async fn create_pairing_invite(&self) -> Result<PairingInvite> {
        self.assert_not_stopped()?;
        {
            let inner = self.inner.borrow();
            if inner.pairing.is_none() || inner.profile.state != "enrolled" {
                return Err(personal_error(
                    "personal_endpoint_not_started",
                    "Start the account-enrolled personal endpoint before creating a pairing invite.",
                ));
            }
            let admitted = inner
                .endpoint
                .as_ref()
                .map(|e| e.session.accepts_new_work())
                .unwrap_or(false);
            if inner.peer_binding.is_none() || !admitted {
                return Err(personal_error(
                    "peer_route_unavailable",
                    "The personal endpoint has not completed Relay admission.",
                ));
            }
        }
        let peer_id = self
            .inner
            .borrow()
            .peer_binding
            .as_ref()
            .map(|b| b.peer_id.clone())
            .unwrap_or_default();
        self.on_peer_session_ready().await;
        let published = self.inner.borrow().published_peer_bundle_for.as_deref()
            == Some(peer_id.as_str())
            && self.snapshot().accepts_new_work;
        if !published {
            return Err(personal_error(
                "peer_client_bundle_unavailable",
                "The personal endpoint's Signal bundle is not published yet.",
            ));
        }
        let current = self.require_current_endpoint_binding().await;
        match &current {
            AuthorityDecision::Revoked | AuthorityDecision::Changed(_) => {
                self.mark_profile_revoked().await?;
                return Err(personal_error(
                    "personal_endpoint_not_current",
                    "Account authority no longer recognizes this endpoint as current.",
                ));
            }
            AuthorityDecision::Unavailable => {
                return Err(personal_error(
                    "account_authority_unavailable",
                    "Account authority is temporarily unavailable; the enrolled endpoint identity remains available for recovery.",
                ));
            }
            AuthorityDecision::Current(_) => {}
        }
        let (pairing, vault_id) = {
            let inner = self.inner.borrow();
            (inner.pairing.clone().unwrap(), inner.profile.vault_id.clone())
        };
        let invite_value = {
            let mut app = pairing.lock().unwrap();
            let inner = self.inner.borrow();
            let mut identity = inner.identity.lock().unwrap();
            app.issue_invite(
                &mut identity,
                vault_id.as_deref(),
                Some(&crate::service::host_label()),
            )?
            .0
        };
        let invite = parse_pairing_invite_json(&invite_value).ok_or_else(|| {
            personal_error(
                "personal_endpoint_invite_invalid",
                "Endpoint pairing generated a malformed or expired invite.",
            )
        })?;
        {
            let inner = self.inner.borrow();
            let expired = chrono::DateTime::parse_from_rfc3339(&invite.expires_at)
                .map(|t| t.timestamp_millis() <= now_ms())
                .unwrap_or(true);
            if expired
                || Some(&invite.tenant_id) != inner.profile.tenant_id.as_ref()
                || invite.endpoint_route_id != inner.profile.route_id
                || invite.endpoint_device_id != inner.profile.endpoint_device_id
                || Some(&invite.endpoint_pin_ref) != inner.profile.endpoint_pin_ref.as_ref()
                || invite.relay_service != inner.relay_base.to_string()
            {
                return Err(personal_error(
                    "personal_endpoint_invite_invalid",
                    "Endpoint pairing generated an invite outside its account-bound route.",
                ));
            }
        }
        Ok(invite)
    }

    /// `start` — assemble authority, pairing, `PrivateEndpoint`, transport
    /// and the durable `PeerClient`, then open the relay session.
    pub async fn start(&self) -> Result<PersonalEndpointSnapshot> {
        self.assert_not_stopped()?;
        if self.inner.borrow().profile.state != "enrolled" {
            return Err(personal_error(
                "personal_endpoint_not_enrolled",
                "Sign in and enroll this device under the personal account before hosting pairing.",
            ));
        }
        if self.inner.borrow().endpoint.is_some() && self.inner.borrow().transport.is_some() {
            return Ok(self.snapshot());
        }
        self.load_claimed_identity()?;
        let peer_identity = self.ensure_peer_identity()?;
        let current = self.require_current_endpoint_binding().await;
        match &current {
            AuthorityDecision::Revoked | AuthorityDecision::Changed(_) => {
                self.mark_profile_revoked().await?;
                return Err(personal_error(
                    "personal_endpoint_not_current",
                    "This endpoint's account-owned route has been revoked or changed.",
                ));
            }
            AuthorityDecision::Unavailable => {
                {
                    let mut inner = self.inner.borrow_mut();
                    inner.started_once = true;
                    inner.route_state = "unreachable".to_string();
                }
                self.emit_state();
                return Err(personal_error(
                    "account_authority_unavailable",
                    "Account authority could not verify this endpoint. Its identity and stored application data remain available for recovery.",
                ));
            }
            AuthorityDecision::Current(_) => {}
        }
        let endpoint_key = self
            .inner
            .borrow()
            .endpoint_key
            .clone()
            .ok_or_else(|| {
                personal_error(
                    "personal_endpoint_key_unavailable",
                    "The endpoint signing key is unavailable in local custody.",
                )
            })?;
        let device_identity = self
            .inner
            .borrow()
            .device_identity
            .clone()
            .ok_or_else(|| {
                personal_error(
                    "personal_endpoint_key_unavailable",
                    "The endpoint public identity is unavailable in local custody.",
                )
            })?;
        {
            let inner = self.inner.borrow();
            let identity = inner.identity.lock().unwrap();
            let own = identity.device(&inner.profile.endpoint_device_id);
            let bound = own.is_some_and(|own| {
                !own.revoked
                    && own.role == "endpoint"
                    && same_binding(own.account_binding.as_ref(), inner.profile.account.as_ref())
            });
            if !bound {
                return Err(personal_error(
                    "personal_endpoint_identity_unavailable",
                    "The local endpoint identity is revoked or does not match the current account binding.",
                ));
            }
        }
        let authority = self
            .inner
            .borrow()
            .account_authority
            .clone()
            .ok_or_else(|| {
                personal_error(
                    "personal_endpoint_identity_unavailable",
                    "The account authority client is not initialized.",
                )
            })?;
        let invite_context = {
            let inner = self.inner.borrow();
            EndpointPairingInviteContext {
                tenant_id: inner.profile.tenant_id.clone().unwrap_or_default(),
                route_id: inner.profile.route_id.clone(),
                endpoint_device_id: inner.profile.endpoint_device_id.clone(),
                endpoint_pin_ref: inner.profile.endpoint_pin_ref.clone().unwrap_or_default(),
                endpoint_spki_pin: inner.profile.endpoint_pin_ref.clone().unwrap_or_default(),
                endpoint_principal_ref: inner
                    .profile
                    .endpoint_principal_ref
                    .clone()
                    .unwrap_or_default(),
                relay_service: inner.relay_base.to_string(),
                vault_id: inner.profile.vault_id.clone().unwrap_or_default(),
                mode: "personal".to_string(),
            }
        };
        let pairing_app = {
            let inner = self.inner.borrow();
            let identity = inner.identity.lock().unwrap();
            EndpointPairingApplication::new(
                &identity,
                authority.clone(),
                invite_context,
                vec![TRUST_SCOPE.to_string()],
                Some(peer_identity_descriptor(&peer_identity)),
            )?
        };
        let pairing = Arc::new(std::sync::Mutex::new(pairing_app));
        self.inner.borrow_mut().pairing = Some(pairing.clone());

        let admission = {
            let inner = self.inner.borrow();
            let identity = inner.identity.lock().unwrap();
            RelayAdmission {
                tenant_id: inner.profile.tenant_id.clone().unwrap_or_default(),
                route_id: inner.profile.route_id.clone(),
                device_id: inner.profile.endpoint_device_id.clone(),
                role: "endpoint".to_string(),
                mode: "personal".to_string(),
                admission_generation: inner.profile.admission_generation.unwrap_or(0),
                revocation_revision: inner
                    .profile
                    .revocation_revision
                    .unwrap_or(0)
                    .max(identity.revocation_revision(
                        inner.profile.tenant_id.as_deref().unwrap_or(""),
                    )),
            }
        };
        let credential = self.load_relay_admission()?;
        let (url, allow_insecure) = {
            let inner = self.inner.borrow();
            (
                relay_session_url(
                    inner.relay_base.as_str(),
                    &admission.tenant_id,
                    &admission.route_id,
                    inner.options.allow_insecure_loopback,
                )?,
                inner.options.allow_insecure_loopback,
            )
        };
        let (transport, events) = WssRelayTransport::spawn(
            &url,
            vec![("authorization".to_string(), format!("Bearer {credential}"))],
            allow_insecure,
            MAX_WS_MESSAGE_BYTES,
        )?;
        self.inner.borrow_mut().transport_generation += 1;
        let generation = self.inner.borrow().transport_generation;

        let cert = self.issue_endpoint_certificate(&device_identity)?;
        let endpoint = self.build_endpoint(transport.sink(), &admission, cert.cert_der.clone(), &endpoint_key);
        let peer_route = PeerRouteIdentity {
            tenant_id: admission.tenant_id.clone(),
            route_id: admission.route_id.clone(),
            device_id: admission.device_id.clone(),
        };
        let binding = self.create_peer_client(peer_route, &transport)?;
        {
            let mut inner = self.inner.borrow_mut();
            inner.endpoint = Some(endpoint);
            inner.transport = Some(Rc::new(transport));
            inner.peer_binding = Some(binding);
            inner.started_once = true;
            inner.relay_state = "connecting".to_string();
        }
        if !self.inner.borrow().inbound_handlers.is_empty() {
            self.attach_peer_dispatch();
            let client = self.inner.borrow().peer_binding.as_ref().unwrap().client.clone();
            tokio::task::spawn_local(async move {
                let _ = client.retry_pending_dispatch().await;
            });
        }
        // Transport event pump — fenced by generation.
        {
            let runtime = self.clone();
            tokio::task::spawn_local(async move {
                runtime.transport_event_loop(generation, events).await;
            });
        }
        self.inner.borrow_mut().connecting = true;
        self.emit_state();
        Ok(self.snapshot())
    }

    /// Assemble `PrivateEndpoint` over the relay sink — shared by `start`
    /// and the fresh-session reconnect branch.
    fn build_endpoint(
        &self,
        sink: WsSink,
        admission: &RelayAdmission,
        cert_der: Vec<u8>,
        endpoint_key: &Arc<Ed25519Keypair>,
    ) -> PrivateEndpoint<WsSink> {
        let identity = self.inner.borrow().identity.clone();
        let pairing = self.inner.borrow().pairing.clone();
        let permit_lookup: Arc<dyn Fn(&str) -> Option<PermitState> + Send + Sync> =
            Arc::new(|_| None);
        let authority: Arc<dyn EndpointAuthorityPort> = Arc::new(PersonalEndpointAuthority {
            scope: TRUST_SCOPE.to_string(),
        });
        let on_inner_channel: Arc<dyn Fn(Arc<InnerChannelHandle>, ChannelPeer) + Send + Sync> =
            Arc::new(|_channel, _peer| {
                // The inner TLS channel carries pairing control only;
                // `EndpointShared::dispatch_account_message` handles each
                // line — no additional per-channel loop is required.
            });
        let (wake_tx, mut wake_rx) = mpsc::unbounded_channel::<()>();
        {
            // Channel threads produce outbound TLS records asynchronously;
            // the wake lets this task drain them into relay frames without
            // waiting for an inbound relay message.
            let runtime = self.clone();
            tokio::task::spawn_local(async move {
                while wake_rx.recv().await.is_some() {
                    tracing::debug!("channel wake: draining outbound");
                    if let Some(endpoint) = runtime.inner.borrow_mut().endpoint.as_mut() {
                        endpoint.pump_channel_outbound();
                    }
                }
            });
        }
        PrivateEndpoint::new(
            sink,
            admission.clone(),
            identity,
            authority,
            EndpointRecoveryAuthority::new(Arc::new(Ed25519RecoverySigner)),
            pairing,
            cert_der,
            crate::cert::device_key_pkcs8_for_rustls(endpoint_key),
            on_inner_channel,
            permit_lookup,
            wake_tx,
        )
    }

    /// The WS event pump for one transport generation — mirrors the four
    /// `transport.handlers` closures of the TS runtime.
    async fn transport_event_loop(
        &self,
        generation: u64,
        mut events: mpsc::UnboundedReceiver<WsEvent>,
    ) {
        tracing::debug!("transport event loop started");
        while let Some(event) = events.recv().await {
            let current = self.is_current_transport(generation);
            tracing::debug!(event = ?event, current, "transport event");
            if !current {
                continue;
            }
            match event {
                WsEvent::Open => {
                    tracing::debug!("relay socket open");
                    self.on_socket_open();
                }
                WsEvent::Message(message) => {
                    let kind = message.get("kind").and_then(Value::as_str).unwrap_or("");
                    tracing::debug!(kind, "relay message");
                    self.on_transport_message(&message);
                }
                WsEvent::Closed { code, reason } => {
                    tracing::debug!(code, %reason, "relay socket closed");
                    self.on_socket_close();
                }
                WsEvent::ProtocolError(_) => {
                    self.inner.borrow_mut().route_state = "unreachable".to_string();
                    self.emit_state();
                }
            }
        }
        // A drained event stream without `Closed` still means a dead socket.
        if self.is_current_transport(generation) {
            self.on_socket_close();
        }
    }

    fn is_current_transport(&self, generation: u64) -> bool {
        let inner = self.inner.borrow();
        !inner.stopping
            && inner.transport.is_some()
            && inner.transport_generation == generation
    }

    fn on_socket_open(&self) {
        {
            let mut inner = self.inner.borrow_mut();
            inner.route_state = "connecting".to_string();
            inner.relay_state = "open".to_string();
            if let Some(endpoint) = inner.endpoint.as_mut() {
                match endpoint.session.state() {
                    "initiated" => {
                        let r = endpoint.open();
                        tracing::debug!(result = ?r, "endpoint session open sent");
                    }
                    "closed" if endpoint.session.session_id().is_some() => {
                        let _ = endpoint.reconnect();
                    }
                    _ => {}
                }
            }
        }
        self.update_peer_channel_admission();
        self.emit_state();
    }

    fn on_socket_close(&self) {
        if let Some(client) = self.inner.borrow().peer_binding.as_ref().map(|b| b.client.clone()) {
            client.transport_lost();
        }
        let rejected = {
            let mut inner = self.inner.borrow_mut();
            if let Some(endpoint) = inner.endpoint.as_mut() {
                endpoint.session.transport_lost();
            }
            inner.route_state = "unreachable".to_string();
            inner.relay_state = "closed".to_string();
            inner
                .endpoint
                .as_ref()
                .map(|e| e.session.state() == "rejected")
                .unwrap_or(false)
        };
        self.update_peer_channel_admission();
        self.emit_state();
        if !rejected {
            self.schedule_reconnect();
        }
    }

    fn on_transport_message(&self, message: &Value) {
        let kind = message.get("kind").and_then(Value::as_str);
        let (session_state, session_id) = {
            let inner = self.inner.borrow();
            inner
                .endpoint
                .as_ref()
                .map(|e| {
                    (
                        e.session.state().to_string(),
                        e.session.session_id().map(str::to_string),
                    )
                })
                .unwrap_or_default()
        };
        let rejected = if kind == Some("session-rejected") {
            parse_session_rejected(message)
        } else {
            None
        };
        let closed = if kind == Some("session-close") {
            parse_session_close(message)
        } else {
            None
        };
        let current_rejection = rejected.is_some()
            && (session_state == "open_sent" || session_state == "reconnecting");
        let current_close = closed
            .as_ref()
            .is_some_and(|(sid, _, _)| Some(sid) == session_id.as_ref())
            && (session_state == "admitted"
                || session_state == "streaming"
                || session_state == "closing");
        let retryable_rejection =
            current_rejection && rejected.as_ref().is_some_and(|r| r.retryable);
        let recoverable_close = current_close
            && closed.as_ref().is_some_and(|(_, reason, _)| {
                reason == "capacity_exceeded" || reason == "idle_timeout"
            });
        let current_admission = kind == Some("session-admitted")
            && (session_state == "open_sent" || session_state == "reconnecting");
        let current_restore =
            kind == Some("session-restored") && session_state == "reconnecting";
        // Terminal messages from an older session must never close the
        // current generation.
        if (kind == Some("session-rejected") && !current_rejection)
            || (kind == Some("session-close") && !current_close)
        {
            return;
        }
        if is_peer_schema_message(message) {
            if session_state != "closed" && session_state != "rejected" {
                if let Some(client) =
                    self.inner.borrow().peer_binding.as_ref().map(|b| b.client.clone())
                {
                    client.handle_inbound_message(message);
                }
            }
            return;
        }
        if current_rejection || current_close {
            if let Some(client) =
                self.inner.borrow().peer_binding.as_ref().map(|b| b.client.clone())
            {
                client.transport_lost();
            }
        }
        {
            let mut inner = self.inner.borrow_mut();
            if let Some(endpoint) = inner.endpoint.as_mut() {
                if retryable_rejection || recoverable_close {
                    // These server terminal messages are followed by a socket
                    // close — preserve session cursors and let the real close
                    // event drive the existing reconnect path.
                    endpoint.session.transport_lost();
                } else {
                    endpoint.handle_relay_message(message);
                }
            }
        }
        let admitted = self
            .inner
            .borrow()
            .endpoint
            .as_ref()
            .map(|e| {
                e.session.state() == "admitted" || e.session.state() == "streaming"
            })
            .unwrap_or(false);
        if (current_admission || current_restore) && admitted {
            self.inner.borrow_mut().reconnect_attempt = 0;
            self.update_peer_channel_admission();
            let runtime = self.clone();
            tokio::task::spawn_local(async move {
                runtime.on_peer_session_ready().await;
            });
        }
        {
            let mut inner = self.inner.borrow_mut();
            inner.route_state = match inner.endpoint.as_ref() {
                Some(e) if e.session.state() == "admitted" || e.session.state() == "streaming" => {
                    e.session.route_state().to_string()
                }
                _ => "unreachable".to_string(),
            };
        }
        self.update_peer_channel_admission();
        self.emit_state();
    }

    /// The `PeerClient` admitted gate — `createPeerSessionChannel`'s
    /// `admitted` predicate, refreshed on every session/transport event.
    fn update_peer_channel_admission(&self) {
        let inner = self.inner.borrow_mut();
        let admitted = inner
            .endpoint
            .as_ref()
            .map(|e| e.session.accepts_new_work())
            .unwrap_or(false)
            && inner
                .transport
                .as_ref()
                .map(|t| t.sink().is_open())
                .unwrap_or(false);
        let sink = inner.transport.as_ref().map(|t| t.sink());
        if let Some(binding) = inner.peer_binding.as_ref() {
            binding.channel.admitted.set(admitted);
            *binding.channel.sink.borrow_mut() = sink;
        }
    }

    /// `stop` — drain the active connection; profile and peer stores stay
    /// durable for the next start.
    pub async fn stop(&self) {
        self.close_active_connection("reconnect").await;
        self.emit_state();
    }

    async fn close_active_connection(&self, _reason: &str) {
        if self.inner.borrow().stopping {
            return;
        }
        self.inner.borrow_mut().stopping = true;
        self.drain_active_connection().await;
    }

    async fn drain_active_connection(&self) {
        let client = {
            let mut inner = self.inner.borrow_mut();
            if let Some(task) = inner.reconnect_task.take() {
                task.abort();
            }
            let client = inner.peer_binding.as_ref().map(|b| b.client.clone());
            if let Some(endpoint) = inner.endpoint.as_mut() {
                let _ = endpoint.close("reconnect");
            }
            if let Some(transport) = inner.transport.as_ref() {
                transport.close();
            }
            inner.endpoint = None;
            inner.transport = None;
            inner.peer_binding = None;
            inner.route_state = "unreachable".to_string();
            inner.relay_state = "closed".to_string();
            inner.connecting = false;
            client
        };
        if let Some(client) = client {
            client.dispose().await;
        }
    }

    fn ensure_peer_identity(&self) -> Result<PeerIdentity> {
        if let Some(identity) = &self.inner.borrow().peer_identity {
            return Ok(identity.clone());
        }
        let (tenant_id, route_id, device_id, peer_store_dir) = {
            let inner = self.inner.borrow();
            if inner.profile.state != "enrolled" || inner.profile.tenant_id.is_none() {
                return Err(personal_error(
                    "personal_endpoint_not_enrolled",
                    "A stable account route is required before creating the Peer identity.",
                ));
            }
            (
                inner.profile.tenant_id.clone().unwrap_or_default(),
                inner.profile.route_id.clone(),
                inner.profile.endpoint_device_id.clone(),
                inner.peer_store_dir.clone(),
            )
        };
        let peer_id = peer_id_for_route_device(&tenant_id, &route_id, &device_id).ok_or_else(|| {
            personal_error(
                "peer_identity_invalid",
                "Account-assigned route identifiers cannot derive a safe peer identity.",
            )
        })?;
        std::fs::create_dir_all(&peer_store_dir).map_err(|_| {
            personal_error("peer_store_error", "The peer store directory could not be created.")
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&peer_store_dir, std::fs::Permissions::from_mode(0o700));
        }
        let crypto_store: Rc<RefCell<dyn PeerCryptoStore>> =
            match &self.inner.borrow().peer_crypto_store {
                Some(store) => store.clone(),
                None => Rc::new(RefCell::new(FilePeerCryptoStore::new(
                    peer_store_dir.join("crypto"),
                ))),
            };
        let identity = match load_peer_identity(&*crypto_store.borrow())? {
            Some(existing) => {
                if existing.peer_id != peer_id {
                    return Err(personal_error(
                        "peer_identity_invalid",
                        "Durable Peer identity does not match this account route.",
                    ));
                }
                existing
            }
            None => {
                let has_paired = {
                    let inner = self.inner.borrow();
                    let identity = inner.identity.lock().unwrap();
                    identity.devices().into_iter().any(|device| {
                        device.role == "entry"
                            && device.tenant_id == tenant_id
                            && device.route_id == route_id
                    })
                };
                if has_paired {
                    return Err(personal_error(
                        "peer_identity_missing",
                        "This route has paired devices but its retained Peer identity is missing; preserve the existing Peer data before recovery.",
                    ));
                }
                create_peer_identity(&*crypto_store.borrow(), Some(&peer_id))?
            }
        };
        {
            let mut inner = self.inner.borrow_mut();
            inner.peer_crypto_store = Some(crypto_store);
            inner.peer_identity = Some(identity.clone());
        }
        Ok(identity)
    }

    fn load_claimed_identity(&self) -> Result<()> {
        {
            let inner = self.inner.borrow();
            let p = &inner.profile;
            if (p.state != "enrolled" && p.state != "revoked")
                || p.account.is_none()
                || p.tenant_id.is_none()
                || p.endpoint_pin_ref.is_none()
                || p.endpoint_principal_ref.is_none()
                || p.capability_grant_ref.is_none()
            {
                return Ok(());
            }
        }
        let (device_id, tenant_id, route_id, pin_ref) = {
            let inner = self.inner.borrow();
            (
                inner.profile.endpoint_device_id.clone(),
                inner.profile.tenant_id.clone().unwrap_or_default(),
                inner.profile.route_id.clone(),
                inner.profile.endpoint_pin_ref.clone().unwrap_or_default(),
            )
        };
        let custody = self.inner.borrow().options.custody.clone();
        let identity =
            device_identity_from_custody(&*custody, Some(DEVICE_CUSTODY_PREFIX), &device_id)?
                .ok_or_else(|| {
                    personal_error(
                        "personal_endpoint_key_unavailable",
                        "The enrolled endpoint key is missing from local custody.",
                    )
                })?;
        let keypair = Arc::new(
            load_device_keypair(&*custody, Some(DEVICE_CUSTODY_PREFIX), &device_id)?
                .ok_or_else(|| {
                    personal_error(
                        "personal_endpoint_key_unavailable",
                        "The enrolled endpoint key is missing from local custody.",
                    )
                })?,
        );
        let certificate = issue_endpoint_certificate_for(&keypair, &identity)?;
        if certificate.spki_pin != pin_ref {
            return Err(personal_error(
                "personal_endpoint_pin_mismatch",
                "The local endpoint key no longer matches its account-registered TLS pin.",
            ));
        }
        {
            let mut inner = self.inner.borrow_mut();
            inner.endpoint_key = Some(keypair.clone());
            inner.device_identity = Some(identity);
            inner.account_authority = Some(Arc::new(EndpointAuthorityClient::new(
                &inner.account_origin,
                &tenant_id,
                &route_id,
                &device_id,
                endpoint_signer(keypair),
                inner.options.account_access.clone(),
            )?));
        }
        Ok(())
    }

    fn issue_endpoint_certificate(
        &self,
        identity: &DeviceIdentity,
    ) -> Result<crate::cert::IssuedDeviceCertificate> {
        let key = self.inner.borrow().endpoint_key.clone().ok_or_else(|| {
            personal_error(
                "personal_endpoint_key_unavailable",
                "The endpoint key is unavailable for its pinned TLS channel.",
            )
        })?;
        issue_endpoint_certificate_for(&key, identity)
    }

    /// `#createPeerClient` — durable client over the route-scoped store,
    /// gated peer channel and pairing-pinned peer directory.
    fn create_peer_client(
        &self,
        route: PeerRouteIdentity,
        transport: &WssRelayTransport,
    ) -> Result<PeerClientBinding> {
        let identity = self.ensure_peer_identity()?;
        let peer_id = identity.peer_id.clone();
        let crypto_store = self
            .inner
            .borrow()
            .peer_crypto_store
            .clone()
            .ok_or_else(|| {
                personal_error("peer_store_error", "The peer crypto store is not initialized.")
            })?;
        let client_store =
            FilePeerClientStore::new(self.inner.borrow().peer_store_dir.join("client"))?;
        let channel = Rc::new(EndpointPeerChannel {
            sink: RefCell::new(Some(transport.sink())),
            admitted: Cell::new(false),
        });
        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        {
            let runtime = self.clone();
            tokio::task::spawn_local(async move {
                while events_rx.recv().await.is_some() {
                    runtime.emit_state();
                }
            });
        }
        let client = PeerClient::new(PeerClientOptions {
            identity,
            crypto_store,
            client_store: Rc::new(client_store),
            transport: channel.clone(),
            route: route.clone(),
            directory: Some(Rc::new(EndpointPeerDirectory {
                runtime: self.clone(),
            })),
            dispatch: None,
            wire_profile: None,
            page_size: None,
            events: events_tx,
        })?;
        Ok(PeerClientBinding {
            client,
            peer_id,
            channel,
        })
    }

    /// `#onPeerSessionReady` — deduped admission work: bundle publication,
    /// then durable resume and pending dispatch.
    async fn on_peer_session_ready(&self) {
        self.finish_peer_admission().await;
    }

    async fn finish_peer_admission(&self) {
        let Some(client) = self.inner.borrow().peer_binding.as_ref().map(|b| b.client.clone())
        else {
            return;
        };
        if !self.is_peer_session_ready(&client) {
            return;
        }
        if let Err(e) = self.publish_peer_bundle().await {
            tracing::debug!(error = ?e, "peer bundle publish failed");
            // A later session restore retries the same stable identity; the
            // shared scheduler retries publication directly when WSS stays up.
            if self.is_peer_session_ready(&client) {
                self.schedule_reconnect();
            }
            self.emit_state();
            return;
        }
        if !self.is_peer_session_ready(&client) {
            return;
        }
        let _ = client.resume().await;
        let _ = client.retry_pending_dispatch().await;
        if !self.is_peer_session_ready(&client) {
            return;
        }
        let route_state = self
            .inner
            .borrow()
            .endpoint
            .as_ref()
            .map(|e| e.session.route_state().to_string())
            .unwrap_or_else(|| "unreachable".to_string());
        self.inner.borrow_mut().route_state = route_state;
        self.emit_state();
    }

    fn is_peer_session_ready(&self, client: &Rc<PeerClient>) -> bool {
        let inner = self.inner.borrow();
        !inner.stopping
            && inner.profile.state == "enrolled"
            && inner
                .peer_binding
                .as_ref()
                .is_some_and(|b| Rc::ptr_eq(&b.client, client))
            && inner
                .endpoint
                .as_ref()
                .map(|e| e.session.accepts_new_work())
                .unwrap_or(false)
            && inner
                .transport
                .as_ref()
                .map(|t| t.sink().is_open())
                .unwrap_or(false)
    }

    async fn publish_peer_bundle(&self) -> Result<()> {
        let Some((client, peer_id)) = self
            .inner
            .borrow()
            .peer_binding
            .as_ref()
            .map(|b| (b.client.clone(), b.peer_id.clone()))
        else {
            return Err(personal_error(
                "personal_endpoint_not_started",
                "Personal endpoint PeerClient is not running.",
            ));
        };
        if self.inner.borrow().published_peer_bundle_for.as_deref() == Some(peer_id.as_str()) {
            return Ok(());
        }
        client.publish_bundle().await?;
        self.inner.borrow_mut().published_peer_bundle_for = Some(peer_id);
        Ok(())
    }

    /// `onInboundMessage` — register a dispatch handler; installing the
    /// first handler wires the client's dispatch and retries pending inbox.
    /// Returns the unsubscribe closure.
    pub fn on_inbound_message(
        &self,
        handler: PersonalEndpointInboundHandler,
    ) -> Box<dyn Fn()> {
        {
            self.inner.borrow_mut().inbound_handlers.push(handler.clone());
        }
        if self.inner.borrow().peer_binding.is_some() {
            self.attach_peer_dispatch();
            let client = self
                .inner
                .borrow()
                .peer_binding
                .as_ref()
                .unwrap()
                .client
                .clone();
            tokio::task::spawn_local(async move {
                let _ = client.retry_pending_dispatch().await;
            });
        }
        let weak = Rc::downgrade(&self.inner);
        Box::new(move || {
            let Some(inner) = weak.upgrade() else { return };
            inner
                .borrow_mut()
                .inbound_handlers
                .retain(|h| !Rc::ptr_eq(h, &handler));
            if inner.borrow().inbound_handlers.is_empty() {
                if let Some(binding) = inner.borrow().peer_binding.as_ref() {
                    binding.client.clear_inbound_message_handler();
                }
            }
        })
    }

    fn attach_peer_dispatch(&self) {
        let Some(client) = self.inner.borrow().peer_binding.as_ref().map(|b| b.client.clone())
        else {
            return;
        };
        let runtime = self.clone();
        client.on_inbound_message(Rc::new(move |message| {
            let runtime = runtime.clone();
            Box::pin(async move { runtime.dispatch_inbound(message).await })
                as LocalBoxFuture<'static, PeerInboundOutcome>
        }));
    }

    /// `#dispatchInbound` — the sender must be an enrolled, non-revoked entry
    /// device on this exact route/account before any handler sees delivery.
    async fn dispatch_inbound(&self, message: PeerInboundMessage) -> PeerInboundOutcome {
        let (sender, profile_account, profile_tenant, profile_route, local_device_id) = {
            let inner = self.inner.borrow();
            let identity = inner.identity.lock().unwrap();
            (
                identity.device(&message.sender_device_id).cloned(),
                inner.profile.account.clone(),
                inner.profile.tenant_id.clone(),
                inner.profile.route_id.clone(),
                inner.profile.endpoint_device_id.clone(),
            )
        };
        let Some(sender) = sender else {
            return PeerInboundOutcome::Rejected { detail: Vec::new() };
        };
        if sender.role != "entry"
            || sender.revoked
            || !same_binding(sender.account_binding.as_ref(), profile_account.as_ref())
            || Some(&sender.tenant_id) != profile_tenant.as_ref()
            || sender.route_id != profile_route
        {
            return PeerInboundOutcome::Rejected { detail: Vec::new() };
        }
        let route = PersonalEndpointPeerRoute {
            tenant_id: sender.tenant_id.clone(),
            route_id: sender.route_id.clone(),
            local_device_id,
            peer_device_id: sender.device_id.clone(),
        };
        let handlers: Vec<PersonalEndpointInboundHandler> =
            self.inner.borrow().inbound_handlers.clone();
        if handlers.is_empty() {
            tracing::debug!("inbound dispatch deferred: no handlers");
            return PeerInboundOutcome::Deferred { detail: Vec::new() };
        }
        let mut result = PeerInboundOutcome::AcceptedByAgent;
        for handler in handlers {
            result = handler(PersonalEndpointInboundMessage {
                address: route.clone(),
                message: message.clone(),
            })
            .await;
            if matches!(result, PeerInboundOutcome::Rejected { .. }) {
                tracing::debug!(outcome = ?result, "inbound dispatch rejected");
                return result;
            }
        }
        if !matches!(result, PeerInboundOutcome::AcceptedByAgent) {
            tracing::debug!(outcome = ?result, "inbound dispatch outcome");
        }
        result
    }

    /// `sendMessage` — fresh authority + presence checks before plaintext
    /// leaves the host.
    pub async fn send_message(
        &self,
        peer_device_id: &str,
        plaintext: &[u8],
        message_id: Option<String>,
    ) -> Result<crate::peer::client_store::StoredOutboxEntry> {
        self.assert_reachable_peer(peer_device_id).await?;
        let client = self
            .inner
            .borrow()
            .peer_binding
            .as_ref()
            .map(|b| b.client.clone())
            .ok_or_else(|| {
                personal_error(
                    "personal_endpoint_not_started",
                    "Personal endpoint PeerClient is not running.",
                )
            })?;
        client.send_message(peer_device_id, plaintext, message_id).await
    }

    pub async fn is_peer_reachable(&self, peer_device_id: &str) -> bool {
        self.assert_reachable_peer(peer_device_id).await.is_ok()
    }

    /// `listPairedEntryDevices` — enrolled entry devices still current under
    /// the account authority.
    pub async fn list_paired_entry_devices(&self) -> Vec<PersonalEndpointEntryDevice> {
        let (account, tenant_id, route_id, devices) = {
            let inner = self.inner.borrow();
            let identity = inner.identity.lock().unwrap();
            (
                inner.profile.account.clone(),
                inner.profile.tenant_id.clone(),
                inner.profile.route_id.clone(),
                identity.devices(),
            )
        };
        let (Some(account), Some(tenant_id)) = (account, tenant_id) else {
            return Vec::new();
        };
        let candidates: Vec<EndpointDeviceRecord> = devices
            .into_iter()
            .filter(|d| {
                d.role == "entry"
                    && !d.revoked
                    && d.tenant_id == tenant_id
                    && d.route_id == route_id
                    && same_binding(d.account_binding.as_ref(), Some(&account))
            })
            .collect();
        let mut out = Vec::new();
        for device in candidates {
            if matches!(
                self.current_entry_authorization(&device).await,
                AuthorityDecision::Current(_)
            ) {
                out.push(PersonalEndpointEntryDevice {
                    device_id: device.device_id.clone(),
                });
            }
        }
        out
    }

    /// `resolvePairedPeerIdentity` — the pairing-pinned Signal identity of a
    /// current entry device.
    pub fn resolve_paired_peer_identity(
        &self,
        peer_device_id: &str,
    ) -> Option<PairingPeerIdentity> {
        let inner = self.inner.borrow();
        let identity = inner.identity.lock().unwrap();
        let entry = identity.device(peer_device_id)?;
        if entry.role != "entry"
            || entry.revoked
            || !same_binding(entry.account_binding.as_ref(), inner.profile.account.as_ref())
            || Some(&entry.tenant_id) != inner.profile.tenant_id.as_ref()
            || entry.route_id != inner.profile.route_id
        {
            return None;
        }
        entry.entry_peer_identity.clone()
    }

    /// `resolvePeerAuthority` — fresh source authority for this exact route
    /// address; independent of relay reachability.
    pub async fn resolve_peer_authority(
        &self,
        address: &PersonalEndpointPeerRoute,
    ) -> PeerApplicationRouteAuthority {
        let entry = {
            let inner = self.inner.borrow();
            if Some(&address.tenant_id) != inner.profile.tenant_id.as_ref()
                || address.route_id != inner.profile.route_id
                || address.local_device_id != inner.profile.endpoint_device_id
                || !opaque(&address.peer_device_id)
            {
                return PeerApplicationRouteAuthority::Revoked;
            }
            let identity = inner.identity.lock().unwrap();
            identity.device(&address.peer_device_id).cloned()
        };
        let Some(entry) = entry else {
            return PeerApplicationRouteAuthority::Revoked;
        };
        {
            let inner = self.inner.borrow();
            if entry.role != "entry"
                || entry.revoked
                || !same_binding(entry.account_binding.as_ref(), inner.profile.account.as_ref())
                || Some(&entry.tenant_id) != inner.profile.tenant_id.as_ref()
                || entry.route_id != inner.profile.route_id
            {
                return PeerApplicationRouteAuthority::Revoked;
            }
        }
        match self.current_entry_authorization(&entry).await {
            AuthorityDecision::Current(_) => PeerApplicationRouteAuthority::Current,
            AuthorityDecision::Unavailable => PeerApplicationRouteAuthority::Unavailable,
            _ => PeerApplicationRouteAuthority::Revoked,
        }
    }

    /// `getPeerTrustAnchor` — trust anchor for the PeerClient's signed
    /// Signal-identity binding.
    pub async fn peer_trust_anchor(
        &self,
        peer_device_id: &str,
    ) -> Option<(String, String, AccountAuthorityBinding)> {
        let entry = {
            let inner = self.inner.borrow();
            let identity = inner.identity.lock().unwrap();
            identity.device(peer_device_id).cloned()
        };
        let entry = entry.filter(|e| {
            let inner = self.inner.borrow();
            e.role == "entry"
                && !e.revoked
                && same_binding(e.account_binding.as_ref(), inner.profile.account.as_ref())
        })?;
        match self.current_entry_authorization(&entry).await {
            AuthorityDecision::Current(_) => Some((
                entry.device_id.clone(),
                entry.paired_identity_key.clone(),
                entry.account_binding.clone()?,
            )),
            _ => None,
        }
    }

    /// `#assertReachablePeer` — route live + paired + authority-current +
    /// presence before accepting outbound work.
    async fn assert_reachable_peer(&self, peer_device_id: &str) -> Result<EndpointDeviceRecord> {
        {
            let inner = self.inner.borrow();
            let ready = opaque(peer_device_id)
                && inner.endpoint.is_some()
                && inner.transport.is_some()
                && inner.account_authority.is_some()
                && inner.profile.state == "enrolled"
                && inner
                    .endpoint
                    .as_ref()
                    .map(|e| e.session.accepts_new_work())
                    .unwrap_or(false)
                && inner
                    .transport
                    .as_ref()
                    .map(|t| t.sink().is_open())
                    .unwrap_or(false)
                && inner.route_state == "reachable";
            if !ready {
                return Err(personal_error(
                    "endpoint_unreachable",
                    "The personal endpoint route is not currently available for new work.",
                ));
            }
        }
        let entry = {
            let inner = self.inner.borrow();
            let identity = inner.identity.lock().unwrap();
            identity.device(peer_device_id).cloned()
        };
        let Some(entry) = entry else {
            return Err(personal_error(
                "account_device_revoked",
                "This device is not paired to the current personal route.",
            ));
        };
        {
            let inner = self.inner.borrow();
            if entry.role != "entry"
                || entry.revoked
                || !same_binding(entry.account_binding.as_ref(), inner.profile.account.as_ref())
                || Some(&entry.tenant_id) != inner.profile.tenant_id.as_ref()
                || entry.route_id != inner.profile.route_id
            {
                return Err(personal_error(
                    "account_device_revoked",
                    "This device is not paired to the current personal route.",
                ));
            }
        }
        match self.current_entry_authorization(&entry).await {
            AuthorityDecision::Revoked | AuthorityDecision::Changed(_) => {
                return Err(personal_error(
                    "account_device_revoked",
                    "The current account authority does not authorize this paired device.",
                ));
            }
            AuthorityDecision::Unavailable => {
                return Err(personal_error(
                    "account_authority_unavailable",
                    "Account authority is temporarily unavailable; no new work was accepted for delivery.",
                ));
            }
            AuthorityDecision::Current(_) => {}
        }
        let presence = self
            .inner
            .borrow()
            .peer_binding
            .as_ref()
            .and_then(|b| b.client.presence(peer_device_id));
        let local_device_id = self.inner.borrow().profile.endpoint_device_id.clone();
        let presence_ok = presence.is_some_and(|p| {
            p.tenant_id == entry.tenant_id
                && p.route_id == entry.route_id
                && p.device_id == local_device_id
                && p.peer_device_id == entry.device_id
                && p.state == "reachable"
        });
        if !presence_ok {
            return Err(personal_error(
                "endpoint_unreachable",
                "The paired device is not currently reachable; the new operation was not accepted.",
            ));
        }
        Ok(entry)
    }

    /// `#currentEntryAuthorization` — account-authority point check with the
    /// exact error-code decision table.
    async fn current_entry_authorization(
        &self,
        entry: &EndpointDeviceRecord,
    ) -> AuthorityDecision<CurrentBindingResponse> {
        if entry.revoked {
            return AuthorityDecision::Revoked;
        }
        let (binding, authority) = {
            let inner = self.inner.borrow();
            (entry.account_binding.clone(), inner.account_authority.clone())
        };
        let (Some(binding), Some(authority)) = (binding, authority) else {
            return AuthorityDecision::Revoked;
        };
        let device_id = entry.device_id.clone();
        let response =
            spawn_blocking(move || authority.current_device_authorization(&device_id)).await;
        match response {
            Ok(Ok(response)) => {
                if account_device_authorization_matches(
                    &response,
                    &binding,
                    entry,
                    Some(TRUST_SCOPE),
                ) {
                    AuthorityDecision::Current(response)
                } else {
                    AuthorityDecision::Revoked
                }
            }
            Ok(Err(err)) => {
                tracing::debug!(error = ?err, "entry authorization check failed");
                match err.code.as_str() {
                    "not_found" | "forbidden" => AuthorityDecision::Revoked,
                    _ => AuthorityDecision::Unavailable,
                }
            }
            Err(e) => {
                tracing::debug!(error = ?e, "entry authorization check join failed");
                AuthorityDecision::Unavailable
            }
        }
    }

    /// `#requireCurrentEndpointBinding` — the account authority must still
    /// recognize this exact local identity as route owner.
    async fn require_current_endpoint_binding(&self) -> AuthorityDecision<ManagedRouteBinding> {
        let (authority, profile) = {
            let inner = self.inner.borrow();
            (inner.account_authority.clone(), inner.profile.clone())
        };
        let Some(authority) = authority else {
            return AuthorityDecision::Revoked;
        };
        if (profile.state != "enrolled" && profile.state != "revoked") || profile.account.is_none()
        {
            return AuthorityDecision::Revoked;
        }
        let account = profile.account.clone().unwrap();
        let response = spawn_blocking(move || authority.managed_route()).await;
        match response {
            Ok(Ok(Some(route))) => {
                let identity_matches = route.account_id == account.account_id
                    && Some(&route.tenant_id) == profile.tenant_id.as_ref()
                    && route.route_id == profile.route_id
                    && route.endpoint_device_id == profile.endpoint_device_id
                    && Some(&route.endpoint_pin_ref) == profile.endpoint_pin_ref.as_ref()
                    && Some(&route.vault_id) == profile.vault_id.as_ref();
                if !identity_matches {
                    return AuthorityDecision::Revoked;
                }
                if route.auth_epoch == account.auth_epoch {
                    AuthorityDecision::Current(route)
                } else {
                    AuthorityDecision::Changed(route)
                }
            }
            Ok(Ok(None)) => AuthorityDecision::Unavailable,
            Ok(Err(err)) => match err.code.as_str() {
                "not_found" => AuthorityDecision::Revoked,
                _ => AuthorityDecision::Unavailable,
            },
            Err(_) => AuthorityDecision::Unavailable,
        }
    }

    /// `#revokeCurrentRoute` — idempotent account-side route fence before a
    /// replacement identity is created.
    async fn revoke_current_route(
        &self,
        input: &PersonalEndpointEnrollmentInput,
    ) -> Result<crate::account::DeviceRevokeReceipt> {
        let (tenant_id, route_id, device_id) = {
            let mut inner = self.inner.borrow_mut();
            if inner.profile.tenant_id.is_none() || inner.profile.account.is_none() {
                return Err(personal_error(
                    "personal_endpoint_reenrollment_invalid",
                    "The retained route identity is incomplete; no replacement route was created.",
                ));
            }
            if inner.profile.pending_route_revocation_operation_id.is_none() {
                inner.profile.pending_route_revocation_operation_id =
                    Some(b64u_encode(&random_bytes(32)));
            }
            (
                inner.profile.tenant_id.clone().unwrap_or_default(),
                inner.profile.route_id.clone(),
                inner.profile.endpoint_device_id.clone(),
            )
        };
        self.save_profile()?;
        let operation_id = self
            .inner
            .borrow()
            .profile
            .pending_route_revocation_operation_id
            .clone()
            .unwrap_or_default();
        let origin = self.inner.borrow().account_origin.clone();
        let access = self.inner.borrow().options.account_access.clone();
        let auth = DesktopAuth {
            account: input.account.clone(),
            credential: input.account_credential.clone(),
        };
        let public_key = input.desktop_public_key.clone();
        let key = input.desktop_key.clone();
        let receipt = spawn_blocking(move || {
            let client = DesktopAccountClient::new(&origin, access)?;
            client.revoke_device(
                &operation_id,
                &tenant_id,
                &route_id,
                &device_id,
                &auth,
                &public_key,
                &move |msg: &[u8]| key.sign(msg),
            )
        })
        .await
        .map_err(|_| {
            personal_error(
                "account_route_revocation_invalid",
                "Account authority did not confirm the exact route fence; no replacement route was created.",
            )
        })??;
        {
            let mut inner = self.inner.borrow_mut();
            inner
                .profile
                .route_revocations
                .retain(|r| r.operation_id != receipt.operation_id);
            inner.profile.route_revocations.push(receipt.clone());
            inner.profile.pending_route_revocation_operation_id = None;
        }
        self.save_profile()?;
        Ok(receipt)
    }

    fn load_relay_admission(&self) -> Result<String> {
        let bytes = self
            .inner
            .borrow()
            .options
            .custody
            .load_secret(RELAY_SECRET_REF)?
            .ok_or_else(|| {
                personal_error(
                    "personal_endpoint_credential_unavailable",
                    "The Relay admission credential is missing from local custody.",
                )
            })?;
        let credential = String::from_utf8(bytes).map_err(|_| {
            personal_error(
                "personal_endpoint_credential_invalid",
                "The Relay admission credential in local custody is malformed.",
            )
        })?;
        if !relay_credential_ok(&credential) {
            return Err(personal_error(
                "personal_endpoint_credential_invalid",
                "The Relay admission credential in local custody is invalid.",
            ));
        }
        Ok(credential)
    }

    fn load_claim_checkpoint(&self) -> Result<Option<ClaimCheckpoint>> {
        let invalid = || {
            personal_error(
                "personal_endpoint_claim_checkpoint_invalid",
                "The protected pending endpoint claim is malformed; no identity or application history was changed.",
            )
        };
        let ref_ = claim_secret_ref(&self.inner.borrow().profile.route_id);
        let bytes = self.inner.borrow().options.custody.load_secret(&ref_)?;
        let Some(bytes) = bytes else { return Ok(None) };
        let checkpoint: ClaimCheckpoint =
            serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if !validate_checkpoint(&checkpoint) {
            return Err(invalid());
        }
        Ok(Some(checkpoint))
    }

    fn save_claim_checkpoint(&self, checkpoint: &ClaimCheckpoint) -> Result<()> {
        let ref_ = claim_secret_ref(&checkpoint.route_id);
        let body = serde_json::to_vec(checkpoint).map_err(|_| {
            personal_error(
                "personal_endpoint_state_write_failed",
                "Personal endpoint state could not be saved safely.",
            )
        })?;
        self.inner
            .borrow()
            .options
            .custody
            .store_secret(&ref_, &body)
    }

    fn save_profile(&self) -> Result<()> {
        let (path, body) = {
            let inner = self.inner.borrow();
            (
                inner.profile_path.clone(),
                format!("{}\n", serde_json::to_string(&inner.profile).unwrap_or_default()),
            )
        };
        save_owner_only(&path, &body)
    }

    fn validate_enrollment_input(&self, input: &PersonalEndpointEnrollmentInput) -> Result<()> {
        if !binding_ok(Some(&input.account))
            || !token_ok(&input.account_credential)
            || !opaque(&input.desktop_device_id)
            || input.desktop_public_key.is_empty()
        {
            return Err(personal_error(
                "personal_endpoint_enrollment_invalid",
                "A current account session and desktop device identity are required.",
            ));
        }
        if input.desktop_key.public_key_b64u() != input.desktop_public_key {
            return Err(personal_error(
                "account_desktop_key_mismatch",
                "The desktop public key does not match its custodied signing key.",
            ));
        }
        Ok(())
    }

    async fn mark_profile_revoked(&self) -> Result<()> {
        {
            let mut inner = self.inner.borrow_mut();
            if inner.profile.state != "revoked" {
                inner.profile.state = "revoked".to_string();
            }
        }
        self.save_profile()?;
        self.close_active_connection("revoked").await;
        self.inner.borrow_mut().route_state = "unreachable".to_string();
        self.emit_state();
        Ok(())
    }

    fn schedule_reconnect(&self) {
        {
            let inner = self.inner.borrow();
            if inner.stopping || inner.transport.is_none() || inner.reconnect_task.is_some() {
                tracing::debug!(
                    stopping = inner.stopping,
                    has_transport = inner.transport.is_some(),
                    task_pending = inner.reconnect_task.is_some(),
                    "relay reconnect skipped"
                );
                return;
            }
        }
        let attempt = self.inner.borrow().reconnect_attempt.min(16);
        let delay = RECONNECT_MAX_MS.min(RECONNECT_INITIAL_MS.saturating_mul(1 << attempt));
        self.inner.borrow_mut().reconnect_attempt += 1;
        tracing::debug!(attempt, delay_ms = delay, "relay reconnect scheduled");
        let runtime = self.clone();
        let task = tokio::task::spawn_local(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            runtime.on_reconnect_timer().await;
        });
        self.inner.borrow_mut().reconnect_task = Some(task.abort_handle());
    }

    async fn on_reconnect_timer(&self) {
        self.inner.borrow_mut().reconnect_task = None;
        let binding = self
            .inner
            .borrow()
            .peer_binding
            .as_ref()
            .map(|b| (b.client.clone(), b.peer_id.clone()));
        if let Some((client, peer_id)) = binding {
            let ready = self.is_peer_session_ready(&client);
            tracing::debug!(ready, "reconnect timer: peer session check");
            if ready {
                if self.inner.borrow().published_peer_bundle_for.as_deref()
                    != Some(peer_id.as_str())
                {
                    self.on_peer_session_ready().await;
                }
                return;
            }
        } else {
            tracing::debug!("reconnect timer: no peer binding");
        }
        self.reconnect().await;
    }

    /// `#reconnect` — reopen the socket, then resume the same session
    /// generation or rebuild a never-admitted session in place.
    async fn reconnect(&self) {
        {
            let inner = self.inner.borrow();
            if inner.stopping || inner.transport.is_none() || inner.endpoint.is_none() {
                tracing::debug!(
                    stopping = inner.stopping,
                    has_transport = inner.transport.is_some(),
                    has_endpoint = inner.endpoint.is_some(),
                    "relay reconnect skipped: inert runtime"
                );
                return;
            }
        }
        self.inner.borrow_mut().connecting = true;
        self.emit_state();
        let transport = self.inner.borrow().transport.clone().unwrap();
        let reopen_result = transport.reopen().await;
        tracing::debug!(ok = reopen_result.is_ok(), "relay transport reopen result");
        if reopen_result.is_err() {
            {
                let mut inner = self.inner.borrow_mut();
                inner.connecting = false;
                inner.route_state = "unreachable".to_string();
            }
            self.emit_state();
            self.schedule_reconnect();
            return;
        }
        if self.inner.borrow().stopping {
            return;
        }
        self.inner.borrow_mut().route_state = "connecting".to_string();
        let (state, has_session) = {
            let inner = self.inner.borrow();
            (
                inner
                    .endpoint
                    .as_ref()
                    .map(|e| e.session.state().to_string()),
                inner
                    .endpoint
                    .as_ref()
                    .and_then(|e| e.session.session_id().map(str::to_string))
                    .is_some(),
            )
        };
        tracing::debug!(state = ?state, has_session, "relay reconnect: session state");
        if state.as_deref() == Some("closed") && has_session {
            let mut inner = self.inner.borrow_mut();
            if let Some(endpoint) = inner.endpoint.as_mut() {
                let _ = endpoint.reconnect();
            }
        } else if state.as_deref() == Some("closed") {
            // A never-admitted session has no cursor to restore. Rebuild the
            // endpoint over the same identity and admission; durable peer
            // stores are untouched.
            let (sink, admission, cert_der, key) = {
                let inner = self.inner.borrow();
                let Some(transport) = inner.transport.as_ref() else { return };
                let Some(key) = inner.endpoint_key.clone() else { return };
                let Some(identity) = inner.device_identity.clone() else { return };
                let Ok(cert) = self.issue_endpoint_certificate(&identity) else { return };
                let admission = RelayAdmission {
                    tenant_id: inner.profile.tenant_id.clone().unwrap_or_default(),
                    route_id: inner.profile.route_id.clone(),
                    device_id: inner.profile.endpoint_device_id.clone(),
                    role: "endpoint".to_string(),
                    mode: "personal".to_string(),
                    admission_generation: inner.profile.admission_generation.unwrap_or(0),
                    revocation_revision: inner.profile.revocation_revision.unwrap_or(0),
                };
                (transport.sink(), admission, cert.cert_der, key)
            };
            let mut endpoint = self.build_endpoint(sink, &admission, cert_der, &key);
            let _ = endpoint.open();
            self.inner.borrow_mut().endpoint = Some(endpoint);
        }
        {
            let mut inner = self.inner.borrow_mut();
            inner.route_state = "unreachable".to_string();
            inner.connecting = false;
        }
        self.emit_state();
    }

    pub fn snapshot(&self) -> PersonalEndpointSnapshot {
        let inner = self.inner.borrow();
        let endpoint_identity = if inner.profile.state == "enrolled" {
            inner
                .profile
                .tenant_id
                .clone()
                .map(|tenant_id| PersonalEndpointIdentity {
                    tenant_id,
                    route_id: inner.profile.route_id.clone(),
                    endpoint_device_id: inner.profile.endpoint_device_id.clone(),
                })
        } else {
            None
        };
        let relay_state = if inner.transport.is_none() {
            "idle"
        } else {
            inner.relay_state.as_str()
        };
        let accepts_new_work = inner
            .endpoint
            .as_ref()
            .map(|e| e.session.accepts_new_work())
            .unwrap_or(false)
            && relay_state == "open"
            && inner.profile.state == "enrolled"
            && inner.route_state == "reachable"
            && inner.peer_binding.as_ref().is_some_and(|b| {
                inner.published_peer_bundle_for.as_deref() == Some(b.peer_id.as_str())
            });
        let state = if inner.profile.state == "revoked" {
            "revoked"
        } else if inner.profile.state == "unregistered" {
            "unregistered"
        } else if inner.connecting {
            "connecting"
        } else if accepts_new_work {
            "connected"
        } else if inner.started_once {
            "unreachable"
        } else {
            "enrolled"
        };
        PersonalEndpointSnapshot {
            state: state.to_string(),
            account: inner.profile.account.clone(),
            endpoint: endpoint_identity,
            peer_id: inner.peer_binding.as_ref().map(|b| b.peer_id.clone()),
            relay_state: relay_state.to_string(),
            route_state: inner.route_state.clone(),
            accepts_new_work,
            route_revocations: inner.profile.route_revocations.clone(),
        }
    }

    fn emit_state(&self) {
        let callback = self.inner.borrow().options.on_state.clone();
        if let Some(callback) = callback {
            callback(self.snapshot());
        }
    }

    fn assert_not_stopped(&self) -> Result<()> {
        if self.inner.borrow().stopping {
            return Err(personal_error(
                "personal_endpoint_stopped",
                "The personal endpoint runtime has stopped.",
            ));
        }
        Ok(())
    }
}

/// `PeerDeviceDirectory` over the endpoint identity store — resolves a paired
/// entry device to its Signal identity.
struct EndpointPeerDirectory {
    runtime: PersonalEndpointRuntime,
}

impl crate::peer::client::PeerDeviceDirectory for EndpointPeerDirectory {
    fn resolve_peer_identity(
        &self,
        peer_device_id: &str,
    ) -> LocalBoxFuture<'static, Option<PairedSignalIdentity>> {
        let runtime = self.runtime.clone();
        let device = peer_device_id.to_string();
        Box::pin(async move {
            runtime
                .resolve_paired_peer_identity(&device)
                .map(|identity| PairedSignalIdentity {
                    peer_id: identity.peer_id,
                    signal_device_id: identity.signal_device_id as u32,
                    registration_id: identity.registration_id as u32,
                    identity_key: identity.identity_key,
                })
        })
    }
}

/// `#peerIdentityDescriptor` — the local Signal identity embedded in issued
/// pairing invites.
fn peer_identity_descriptor(identity: &PeerIdentity) -> PairingPeerIdentity {
    let paired = identity.paired_signal_identity();
    PairingPeerIdentity {
        peer_id: paired.peer_id,
        signal_device_id: paired.signal_device_id as u64,
        registration_id: paired.registration_id as u64,
        identity_key: paired.identity_key,
    }
}

fn endpoint_signer(key: Arc<Ed25519Keypair>) -> EndpointSigner {
    Arc::new(move |msg: &[u8]| Ok(key.sign(msg)))
}

fn issue_endpoint_certificate_for(
    key: &Ed25519Keypair,
    identity: &DeviceIdentity,
) -> Result<crate::cert::IssuedDeviceCertificate> {
    let public_raw = b64u_decode(&identity.public_key, 64)
        .ok()
        .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
        .ok_or_else(|| {
            personal_error(
                "personal_endpoint_key_unavailable",
                "The endpoint public identity is malformed.",
            )
        })?;
    let key_clone = key.clone();
    crate::cert::issue_device_certificate(
        &public_raw,
        move |tbs: &[u8]| {
            let sig = key_clone.sign(tbs);
            <[u8; 64]>::try_from(sig.as_slice()).unwrap_or([0u8; 64])
        },
        Some(&format!("meshrix-personal-endpoint {}", identity.device_id)),
        None,
        Some(now_ms()),
        None,
    )
}
