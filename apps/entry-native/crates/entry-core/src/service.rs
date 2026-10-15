//! EntryService — the single facade the CLI, TUI and GUI drive. Composes
//! the config store, custody adapter, device identity, account client,
//! pairing/recovery channels and forward relay sessions, mirroring
//! `product-service.ts` state and honesty semantics.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::account::{
    new_operation_id, pairing_bootstrap_body, sign_desktop_pairing_bootstrap, DesktopAccountClient,
    DesktopAccountTransaction, DesktopAuth, DeviceAuthorizationCheck, DeviceAuthorizationDecision,
    sign_desktop_account_proof, TransactionPoll, ROUTE_DESKTOP_WRITER_COMPLETE,
    ROUTE_DESKTOP_WRITER_PREPARE,
};
use crate::custody::{select_custody_adapter, CustodyAdapter, CustodyOptions, CustodyPreference};
use crate::error::{entry_error, Result};
use crate::identity::{
    device_identity_from_custody, enroll_device_identity, load_device_keypair, DeviceIdentity,
};
use crate::peer::{
    AcpPermissionResolution, PeerApplicationAddress, PeerApplicationDiscoveryRecord,
    PeerApplicationRecord, PeerApplicationRouteAuthority, PeerAttachRequest, PeerHost,
    PeerHostEvent, PeerHostOptions,
};
use crate::endpoint::runtime::{
    PersonalEndpointEnrollmentInput, PersonalEndpointEntryDevice, PersonalEndpointRuntimeOptions,
    PersonalEndpointSnapshot, PersonalEndpointStepUpRequest, StepUpDriver,
};
use crate::pairing::invite::{parse_pairing_invite_text, PairingInvite};
use crate::pairing::session::{
    BeginOutcome, CompleteOutcomeRaw, PairingCompletionRequest, PairingEndpointPort,
};
use crate::recovery::key::parse_recovery_text;
use crate::relay::entry::{EntrySession, EntrySessionOptions, InnerTlsOptions};
use crate::relay::pairing::{
    EntryPairingRelayChannel, EntryPairingRelayChannelOptions, PairingRelayBootstrap,
};
use crate::relay::recovery::EntryRecoveryChannel;
use crate::store::{
    parse_entry_gui_config, EntryConfigStore, EntryGuiConfig, StoredConnection, StoredRecovery,
    StoredRotation, StoredSnapshotJournal, StoredVaultWriterOperation,
};
use crate::wire::account::{
    account_device_authority_transcript, canonical_account_action_target,
    canonical_account_vault_writer_rotation_input, AccountActionTarget,
    AccountAuthorityBinding, AccountDeviceAuthorityProof,
};
use crate::wire::session::RelayAdmission;

/// Service-level configuration (account origin + relay defaults).
#[derive(Debug, Clone)]
pub struct ServiceConfig {
    /// Bare HTTPS account origin.
    pub account_origin: Option<String>,
    /// Cloudflare Access service-token credentials presented on every account
    /// call when the account surface sits behind an Access application.
    pub account_access: Option<crate::account::AccessServiceToken>,
    /// Default relay service for connections that don't carry one.
    pub default_relay_service: Option<String>,
    /// Opt-in for literal loopback `ws://` relays — fixtures only.
    pub allow_insecure_loopback: bool,
    /// Explicit file-custody fallback configuration (required on platforms
    /// without an OS store when `file` custody is selected).
    pub custody: CustodyPreference,
    pub file_custody: Option<FileCustodyOpts>,
}

#[derive(Debug, Clone)]
pub struct FileCustodyOpts {
    pub data_dir: std::path::PathBuf,
    pub wrap_secret: [u8; 32],
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            account_origin: None,
            account_access: None,
            default_relay_service: None,
            allow_insecure_loopback: false,
            custody: CustodyPreference::Auto,
            file_custody: None,
        }
    }
}

/// Redacted state snapshot for the front-ends — no secrets, ever.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceState {
    pub profile_label: String,
    pub connections: Vec<RedactedConnection>,
    pub account_signed_in: bool,
    /// Display-only account email captured at sign-in.
    pub account_email: Option<String>,
    /// This device's human-readable name (hostname minus `.local`).
    pub device_label: String,
    pub recovery_configured: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedConnection {
    pub connection_id: String,
    pub display_label: String,
    pub tenant_id: String,
    pub route_id: String,
    pub mode: String,
    /// The locally enrolled device id — lets the UI match peer-application
    /// route addresses to connections.
    pub device_id: String,
    /// The paired endpoint device id — the only allowed peer counterpart.
    pub endpoint_device_id: Option<String>,
    pub device_fingerprint: String,
    pub admission_generation: u64,
    pub revocation_revision: u64,
    pub enrolled_at: String,
    pub remote_revocation: String,
    pub re_pair_required: bool,
    /// Live session view when connected.
    pub session_state: Option<String>,
    pub route_state: Option<String>,
}

/// A pairing flow in flight — state the UI renders and drives.
pub struct PairingFlow {
    pub invite: PairingInvite,
    pub device: DeviceIdentity,
    /// The account-issued restricted bootstrap id — binds the pair_device
    /// step-up transaction to this pairing attempt.
    pub bootstrap_id: String,
    /// The account binding the endpoint must see on the step-up permit.
    pub bootstrap_account: AccountAuthorityBinding,
    /// Ticketed relay bearer activated for `forward` sessions on enrollment.
    pub relay_admission: String,
    pub challenge: Option<crate::pairing::session::PairingChallenge>,
    pub channel: EntryPairingRelayChannel,
    pub state: String,
}

/// Result of one step-up transaction poll.
#[derive(Debug, Clone)]
pub enum StepUpPoll {
    Pending,
    Expired,
    Consumed,
    Complete {
        account: AccountAuthorityBinding,
        permit_id: String,
        target: AccountActionTarget,
    },
}

pub struct EntryService {
    /// Data directory the store and custody backends are rooted at.
    pub data_dir: PathBuf,
    pub store: Arc<std::sync::Mutex<EntryConfigStore>>,
    custody: Arc<dyn CustodyAdapter>,
    config: ServiceConfig,
    account_client: Option<Arc<DesktopAccountClient>>,
    sessions: Arc<std::sync::Mutex<HashMap<String, Arc<EntrySession>>>>,
    /// One lazily-spawned peer host thread for the whole service — the
    /// single-threaded composition root from `product-service.ts`.
    peer_host: std::sync::Mutex<Option<Arc<PeerHost>>>,
    /// Reveal-once recovery key candidate — in-memory only, ten-minute
    /// window, never persisted (the root secret is never at rest).
    pending_recovery: std::sync::Mutex<Option<PendingRecoverySecret>>,
    /// The derived material for the active recovery key — loaded from OS
    /// custody on start and after confirmation.
    recovery_material: std::sync::Mutex<Option<crate::recovery::crypto::RecoveryMaterial>>,
    /// In-flight account-managed vault-writer registration — the durable
    /// record lives in the config store; the replayable request/transaction
    /// blob lives in OS custody under `flow_ref`.
    pending_vault_writer: std::sync::Mutex<Option<PendingVaultWriter>>,
    /// In-flight grant_access request awaiting its step-up permit — mirrors
    /// `#pendingGrant` (in-memory only; a restart asks the user to retry).
    pending_grant: std::sync::Mutex<Option<PendingGrant>>,
}

impl EntryService {
    /// Open the data directory, select the custody adapter and load config.
    pub fn open(data_dir: PathBuf, config: ServiceConfig) -> Result<Self> {
        let custody: Arc<dyn CustodyAdapter> = select_custody_adapter(CustodyOptions {
            preference: config.custody,
            file: config.file_custody.clone().map(|c| crate::custody::FileCustodyConfig {
                data_dir: c.data_dir,
                wrap_secret: c.wrap_secret,
            }),
        })?
        .into();
        let mut store = EntryConfigStore::new(&data_dir);
        store.load()?;
        let account_client = match &config.account_origin {
            Some(origin) => Some(Arc::new(DesktopAccountClient::new(
                origin,
                config.account_access.clone(),
            )?)),
            None => None,
        };
        let service = Self {
            data_dir,
            store: Arc::new(std::sync::Mutex::new(store)),
            custody,
            config,
            account_client,
            sessions: Arc::new(std::sync::Mutex::new(HashMap::new())),
            peer_host: std::sync::Mutex::new(None),
            pending_recovery: std::sync::Mutex::new(None),
            recovery_material: std::sync::Mutex::new(None),
            pending_vault_writer: std::sync::Mutex::new(None),
            pending_grant: std::sync::Mutex::new(None),
        };
        service.restore_recovery_state()?;
        Ok(service)
    }

    /// `start`-time restoration: recover the derived material and any
    /// durable vault-writer operation; abort restart-stranded `staged`
    /// rotations (their candidate secret lived only in the save window).
    pub fn restore_recovery_state(&self) -> Result<()> {
        {
            let material = {
                let store = self.store.lock().unwrap();
                store.config().recovery.clone()
            };
            if let Some(recovery) = material {
                if let Some(secret) = self.custody.load_secret(&recovery.material_ref)? {
                    *self.recovery_material.lock().unwrap() =
                        Some(crate::recovery::crypto::deserialize_recovery_material(&secret)?);
                }
            }
        }
        // A restart-stranded `staged` rotation is uncompletable by design.
        {
            let stale: Vec<String> = {
                let store = self.store.lock().unwrap();
                store
                    .config()
                    .rotations
                    .iter()
                    .filter(|r| r.state == "staged")
                    .map(|r| r.rotation_id.clone())
                    .collect()
            };
            if !stale.is_empty() {
                let mut manager = self.rotation_manager();
                for rotation_id in stale {
                    let _ = manager.abort(&rotation_id);
                }
            }
        }
        self.restore_vault_writer_rotation()
    }

    pub fn custody(&self) -> &dyn CustodyAdapter {
        self.custody.as_ref()
    }

    /// Merge external writers' config changes (CLI, endpoint runtime) into
    /// this process's store. Returns true when state actually changed.
    pub fn reload_if_changed(&self) -> Result<bool> {
        self.store.lock().unwrap().reload_if_changed()
    }

    /// Redacted state for the UI — only non-secret facts.
    pub fn state(&self) -> ServiceState {
        let store = self.store.lock().unwrap();
        let config = store.config();
        let sessions = self.sessions.try_lock().ok();
        ServiceState {
            profile_label: config.profile.display_label.clone(),
            account_signed_in: config.account.as_ref().is_some_and(|a| a.account_id.is_some()),
            account_email: config.account.as_ref().and_then(|a| a.email.clone()),
            device_label: host_label(),
            recovery_configured: config.recovery.is_some(),
            connections: config
                .connections
                .iter()
                .map(|c| {
                    let live = sessions
                        .as_ref()
                        .and_then(|s| s.get(&c.connection_id))
                        .map(|s| s.state());
                    RedactedConnection {
                        connection_id: c.connection_id.clone(),
                        display_label: c.display_label.clone(),
                        tenant_id: c.tenant_id.clone(),
                        route_id: c.route_id.clone(),
                        mode: c.mode.clone(),
                        device_id: c.device_id.clone(),
                        endpoint_device_id: c.endpoint_device_id.clone(),
                        device_fingerprint: c.device_fingerprint.clone(),
                        admission_generation: c.admission_generation,
                        revocation_revision: c.revocation_revision,
                        enrolled_at: c.enrolled_at.clone(),
                        remote_revocation: c.remote_revocation.clone(),
                        re_pair_required: c.re_pair_required,
                        session_state: live.as_ref().map(|v| v.session_state.clone()),
                        route_state: live.as_ref().map(|v| v.route_state.clone()),
                    }
                })
                .collect(),
        }
    }

    /// The desktop device identity public key — the `clientPublicKey` for
    /// account transactions.
    pub fn account_device_public_key(&self) -> Result<String> {
        Ok(self.account_device_identity()?.public_key)
    }

    /// Account desktop login transaction — returns the browser URL the shell
    /// opens plus the opaque verifier needed to poll. The verifier never
    /// leaves this process. The pending desktop device binding is persisted
    /// up front so the completion poll records the same device key the
    /// transaction was created for.
    pub fn begin_account_login(&self) -> Result<crate::account::DesktopAccountTransaction> {
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        let device = self.account_device_identity()?;
        self.store.lock().unwrap().update(|config| {
            let existing = config.account.take();
            config.account = Some(crate::store::StoredAccountClient {
                desktop_device_id: device.device_id.clone(),
                account_id: existing.as_ref().and_then(|a| a.account_id.clone()),
                auth_epoch: existing.as_ref().and_then(|a| a.auth_epoch),
                email: existing.as_ref().and_then(|a| a.email.clone()),
                session_credential_ref: existing.and_then(|a| a.session_credential_ref),
            });
        })?;
        client.create_transaction("login", &device.public_key, None, None, None, None, None)
    }

    /// Poll the account login transaction; on `Complete` the device session
    /// credential is stored in custody and the binding recorded in config.
    pub fn poll_account_login(&self, transaction_id: &str, verifier: &str) -> Result<String> {
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        match client.poll_transaction(transaction_id, verifier)? {
            TransactionPoll::Pending => Ok("pending".into()),
            TransactionPoll::Expired => Ok("expired".into()),
            TransactionPoll::Consumed => Ok("consumed".into()),
            TransactionPoll::Complete { account, account_email, device_session_credential, .. } => {
                let credential = device_session_credential.ok_or_else(|| {
                    entry_error("account_transaction_invalid", "The account worker returned an invalid transaction result.")
                })?;
                let credential_ref = format!("entry.account.session.{}", generate_suffix());
                self.custody.store_secret(&credential_ref, credential.as_bytes())?;
                let account_id = account.account_id.clone();
                let auth_epoch = account.auth_epoch;
                let device = self.account_device_identity()?;
                self.store.lock().unwrap().update(|config| {
                    config.account = Some(crate::store::StoredAccountClient {
                        desktop_device_id: device.device_id.clone(),
                        account_id: Some(account_id.clone()),
                        auth_epoch: Some(auth_epoch),
                        email: account_email.clone(),
                        session_credential_ref: Some(credential_ref.clone()),
                    });
                })?;
                client.acknowledge_transaction(transaction_id, verifier)?;
                Ok("complete".into())
            }
        }
    }

    /// The desktop device identity used for account session proofs —
    /// distinct from per-connection pairing identities. Reuses the identity
    /// recorded in config while its key remains in custody; otherwise enrols
    /// a fresh device key.
    fn account_device_identity(&self) -> Result<DeviceIdentity> {
        let stored_id = self
            .store
            .lock()
            .unwrap()
            .config()
            .account
            .as_ref()
            .map(|a| a.desktop_device_id.clone());
        if let Some(id) = stored_id {
            if let Some(identity) =
                device_identity_from_custody(&*self.custody, Some("entry.account.desktop"), &id)?
            {
                return Ok(identity);
            }
        }
        enroll_device_identity(&*self.custody, Some("entry.account.desktop"), None)
    }

    /// Entry device identity for a pairing attempt. Retries reuse the stored
    /// pending identity so the account authority replays the same bootstrap
    /// instead of conflicting on a freshly minted device; a lost custody key
    /// falls back to a fresh enrollment. The pending marker clears when a
    /// pairing completes.
    fn pairing_device_identity(&self) -> Result<DeviceIdentity> {
        let pending = self
            .store
            .lock()
            .unwrap()
            .config()
            .pending_pairing_device_id
            .clone();
        if let Some(id) = pending {
            if let Some(identity) = device_identity_from_custody(&*self.custody, None, &id)? {
                return Ok(identity);
            }
        }
        let device = enroll_device_identity(&*self.custody, None, None)?;
        self.store.lock().unwrap().update(|config| {
            config.pending_pairing_device_id = Some(device.device_id.clone());
        })?;
        Ok(device)
    }

    fn desktop_auth(&self) -> Result<(DesktopAuth, String)> {
        let store = self.store.lock().unwrap();
        let Some(account) = &store.config().account else {
            return Err(entry_error("account_login_required", "A current OS-custodied account session is required for this authorization."));
        };
        let (Some(account_id), Some(auth_epoch), Some(credential_ref)) =
            (account.account_id.clone(), account.auth_epoch, account.session_credential_ref.clone())
        else {
            return Err(entry_error("account_login_required", "A current OS-custodied account session is required for this authorization."));
        };
        let credential = self
            .custody
            .load_secret(&credential_ref)?
            .ok_or_else(|| entry_error("account_login_required", "The account session credential is not in custody."))?;
        Ok((
            DesktopAuth {
                account: AccountAuthorityBinding { account_id, auth_epoch },
                credential: String::from_utf8(credential).map_err(|_| {
                    entry_error("account_login_required", "The account session credential is unreadable.")
                })?,
            },
            credential_ref,
        ))
    }

    fn account_signer(&self) -> Result<(String, impl Fn(&[u8]) -> Vec<u8>)> {
        let device = self.account_device_identity()?;
        let signer = account_signer_for(&*self.custody, &device.device_id)?;
        Ok((device.public_key, signer))
    }

    /// Per-connection peer store root — `peerStoreDirFor` in the TS host:
    /// `<dataDir>/peer/conn.<sanitized-deviceId>`.
    fn peer_store_dir(&self, device_id: &str) -> std::path::PathBuf {
        let safe = device_id
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '.' })
            .collect::<String>();
        self.data_dir.join("peer").join(format!("conn.{safe}"))
    }

    /// Provision the local Signal peer identity bound to this pairing route —
    /// `EntryPeerRuntime.preparePairingIdentity`. The peerId derives
    /// deterministically from (tenant, route, device); a stored identity
    /// bound to another route is a hard error, never silently rotated.
    fn prepare_pairing_peer_identity(
        &self,
        flow: &PairingFlow,
    ) -> Result<crate::peer::PairedSignalIdentity> {
        let peer_id = crate::peer::peer_id_for_route_device(
            &flow.invite.tenant_id,
            &flow.invite.endpoint_route_id,
            &flow.device.device_id,
        )
        .ok_or_else(|| {
            entry_error(
                "peer_identity_invalid",
                "The pairing route cannot derive a Peer identity.",
            )
        })?;
        let store_dir = self.peer_store_dir(&flow.device.device_id);
        std::fs::create_dir_all(&store_dir).map_err(|_| {
            entry_error("peer_store_error", "The peer store directory could not be created.")
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&store_dir, std::fs::Permissions::from_mode(0o700));
        }
        let crypto_store = crate::peer::FilePeerCryptoStore::new(store_dir.join("crypto"));
        let identity = match crate::peer::load_peer_identity(&crypto_store)? {
            Some(identity) if identity.peer_id == peer_id => identity,
            Some(_) => {
                return Err(entry_error(
                    "peer_identity_invalid",
                    "The saved local Signal identity is bound to another pairing route.",
                ))
            }
            None => crate::peer::create_peer_identity(&crypto_store, Some(&peer_id))?,
        };
        Ok(identity.paired_signal_identity())
    }

    /// Begin pairing for a pasted invite: provision the fresh device key in
    /// custody, request the restricted bootstrap from the account service,
    /// open the pinned pair_device channel and request the endpoint
    /// challenge.
    pub async fn begin_pairing(&self, invite_text: &str) -> Result<PairingFlow> {
        let invite = parse_pairing_invite_text(invite_text)?;
        let device = self.pairing_device_identity()?;
        let (auth, _cred_ref) = self.desktop_auth()?;
        let (client_public_key, signer) = self.account_signer()?;
        let body = pairing_bootstrap_body(
            &invite.tenant_id,
            &invite.endpoint_route_id,
            &device.device_id,
            &device.public_key,
            &invite.endpoint_pin_ref,
            &invite.mode,
        );
        let request = sign_desktop_pairing_bootstrap(&auth.account, &auth.credential, &client_public_key, &body, &signer);
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        let bootstrap = client.create_pairing_bootstrap(&request)?;
        let bootstrap_id = bootstrap.bootstrap_id.clone();
        let bootstrap_account = bootstrap.account.clone();
        let cert = {
            let keypair = load_device_keypair(&*self.custody, None, &device.device_id)?
                .ok_or_else(|| entry_error("custody_unavailable", "The fresh device key is not in custody."))?;
            crate::cert::device_certificate_for_keypair(&keypair)?
        };
        let key_der = custody_pkcs8(&*self.custody, &device.device_id)?;
        let relay_admission = bootstrap.relay_admission.clone();
        let channel = EntryPairingRelayChannel::connect(EntryPairingRelayChannelOptions {
            relay_service: invite.relay_service.clone(),
            bootstrap: PairingRelayBootstrap {
                bootstrap_id: bootstrap.bootstrap_id,
                relay_admission: bootstrap.relay_admission,
                account: bootstrap.account,
                tenant_id: bootstrap.tenant_id,
                route_id: bootstrap.route_id,
                endpoint_device_id: bootstrap.endpoint_device_id,
                endpoint_pin_ref: bootstrap.endpoint_pin_ref,
                entry_device_id: bootstrap.entry_device_id,
                mode: bootstrap.mode,
                admission_generation: bootstrap.admission_generation,
                revocation_revision: bootstrap.revocation_revision,
                expires_at: bootstrap.expires_at,
            },
            invite: invite.clone(),
            inner_tls: InnerTlsOptions {
                cert_der: cert.cert_der,
                key_der,
                pinned_peer_spki: vec![invite.endpoint_spki_pin.clone()],
                handshake_timeout: std::time::Duration::from_millis(15_000),
            },
            connect_timeout: Some(std::time::Duration::from_secs(30)),
            allow_insecure_loopback: self.config.allow_insecure_loopback,
        })
        .await?;
        Ok(PairingFlow {
            invite,
            device,
            bootstrap_id,
            bootstrap_account,
            relay_admission,
            challenge: None,
            channel,
            state: "challenge_required".into(),
        })
    }

    /// Issue the endpoint challenge for an open pairing flow.
    pub async fn pairing_challenge(&self, flow: &mut PairingFlow) -> Result<String> {
        match flow
            .channel
            .begin_pairing(&flow.invite, &flow.device.device_id, &flow.device.public_key)
            .await
        {
            Ok(BeginOutcome::Challenge(challenge)) => {
                let id = challenge.challenge_id.clone();
                flow.challenge = Some(challenge);
                flow.state = "challenge_issued".into();
                Ok(id)
            }
            Ok(BeginOutcome::Refused(refusal)) => {
                flow.state = "refused".into();
                Err(entry_error("pairing_refused", refusal))
            }
            Ok(BeginOutcome::Offline) => {
                flow.state = "offline".into();
                Err(entry_error("endpoint_unreachable", "The pairing endpoint is offline."))
            }
            Ok(BeginOutcome::Expired) => {
                flow.state = "expired".into();
                Err(entry_error("pairing_expired", "The pairing invite has expired."))
            }
            Err(e) => Err(e),
        }
    }

    /// Create the account browser step-up transaction that authorizes this
    /// pairing attempt (`pair_device` bound to the issued challenge target
    /// and the restricted bootstrap id).
    pub fn begin_pairing_step_up(&self, flow: &PairingFlow) -> Result<DesktopAccountTransaction> {
        let challenge = flow.challenge.as_ref().ok_or_else(|| {
            entry_error("pairing_state_invalid", "No issued challenge is bound to this flow.")
        })?;
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        let (auth, _cred_ref) = self.desktop_auth()?;
        let (client_public_key, signer) = self.account_signer()?;
        client.create_transaction(
            "step_up",
            &client_public_key,
            Some(&challenge.target),
            Some("pair_device"),
            Some(&flow.bootstrap_id),
            None,
            Some((&auth, &signer)),
        )
    }

    /// Poll the pairing step-up transaction; on `Complete` the result is
    /// verified to bind the challenge target and the bootstrap account before
    /// the permit is released to `complete_pairing`.
    pub fn poll_pairing_step_up(
        &self,
        flow: &PairingFlow,
        transaction: &DesktopAccountTransaction,
    ) -> Result<StepUpPoll> {
        let challenge = flow.challenge.as_ref().ok_or_else(|| {
            entry_error("pairing_state_invalid", "No issued challenge is bound to this flow.")
        })?;
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        match client.poll_transaction(&transaction.transaction_id, &transaction.verifier)? {
            TransactionPoll::Pending => Ok(StepUpPoll::Pending),
            TransactionPoll::Expired => Ok(StepUpPoll::Expired),
            TransactionPoll::Consumed => Ok(StepUpPoll::Consumed),
            TransactionPoll::Complete {
                account,
                purpose,
                permit_id,
                action_purpose,
                target,
                ..
            } => {
                let mismatch = || {
                    entry_error(
                        "account_step_up_mismatch",
                        "The verified factor result does not match the pending pairing action.",
                    )
                };
                if purpose != "step_up"
                    || action_purpose.as_deref() != Some("pair_device")
                    || transaction.purpose != "step_up"
                {
                    return Err(mismatch());
                }
                let permit_id = permit_id.ok_or_else(mismatch)?;
                let target = target.ok_or_else(mismatch)?;
                if canonical_account_action_target(&target)
                    != canonical_account_action_target(&challenge.target)
                    || crate::canonical::canonical_json(&serde_json::to_value(&account).unwrap_or(Value::Null))
                        != crate::canonical::canonical_json(
                            &serde_json::to_value(&flow.bootstrap_account).unwrap_or(Value::Null),
                        )
                {
                    return Err(mismatch());
                }
                Ok(StepUpPoll::Complete { account, permit_id, target })
            }
        }
    }

    /// Complete pairing with an account step-up permit; checkpoints the exact
    /// signed operation in custody before dispatch so a lost response can
    /// replay the same operation.
    pub async fn complete_pairing(
        &self,
        flow: &mut PairingFlow,
        account: &AccountAuthorityBinding,
        permit_id: &str,
        target: &AccountActionTarget,
    ) -> Result<StoredConnection> {
        let challenge = flow.challenge.clone().ok_or_else(|| {
            entry_error("pairing_state_invalid", "No issued challenge is bound to this flow.")
        })?;
        let keypair = load_device_keypair(&*self.custody, None, &flow.device.device_id)?.ok_or_else(|| {
            entry_error("custody_unavailable", "The paired device key is not in custody.")
        })?;
        // Provision the route-bound Signal peer identity before signing — the
        // public descriptor is part of the signed completion transcript, so a
        // later store corruption changes the signature, not just the payload.
        let entry_peer_identity = self.prepare_pairing_peer_identity(flow)?;
        let entry_peer_identity_json = serde_json::to_value(&entry_peer_identity)
            .map_err(|_| entry_error("peer_state_invalid", "The peer identity descriptor cannot be encoded."))?;
        let signature = crate::b64::b64u_encode(&keypair.sign(
            crate::transcripts::pairing_proof_transcript(
                &challenge.challenge_id,
                &flow.invite.invite_id,
                &flow.invite.endpoint_route_id,
                &flow.device.device_id,
                &flow.device.public_key,
                Some(&entry_peer_identity_json),
            )
            .as_bytes(),
        ));
        let completion = PairingCompletionRequest {
            invite: flow.invite.to_json(),
            challenge_id: challenge.challenge_id.clone(),
            device_id: flow.device.device_id.clone(),
            device_public_key: flow.device.public_key.clone(),
            entry_peer_identity: entry_peer_identity_json,
            signature,
            account: account.clone(),
            permit_id: permit_id.to_string(),
            purpose: "pair_device",
            target: target.clone(),
            operation_id: new_operation_id("pair.operation"),
        };
        // Checkpoint the exact signed operation in custody before dispatch.
        let checkpoint_ref = format!("entry-gui.pairing.completion.{}", hex_32());
        let completion_json = serde_json::to_vec(&completion)?;
        self.custody.store_secret(&checkpoint_ref, &completion_json)?;
        let result = flow.channel.complete_pairing(&completion).await;
        match result {
            Ok(CompleteOutcomeRaw::Refused(refusal)) => {
                flow.state = "refused".into();
                let _ = self.custody.delete_secret(&checkpoint_ref);
                Err(entry_error("pairing_refused", refusal))
            }
            Ok(CompleteOutcomeRaw::Enrolled {
                capability_grant_ref,
                admission_generation,
                revocation_revision,
                endpoint_peer_identity,
            }) => {
                flow.state = "enrolled".into();
                // Re-pairing a known endpoint refreshes the existing record:
                // keep its connection id and custody slot so per-connection
                // peer state stays anchored instead of accumulating twins.
                let existing = {
                    self.store.lock().unwrap().config().connections.iter()
                        .find(|c| {
                            c.endpoint_principal_ref == flow.invite.endpoint_principal_ref
                        })
                        .map(|c| (c.connection_id.clone(), c.relay_credential_ref.clone()))
                };
                let (connection_id, credential_ref) = existing.unwrap_or_else(|| {
                    (
                        format!("conn.{}", generate_suffix()),
                        format!("entry.relay.credential.{}", generate_suffix()),
                    )
                });
                self.custody
                    .store_secret(&credential_ref, flow.relay_admission.as_bytes())?;
                let connection = StoredConnection {
                    connection_id: connection_id.clone(),
                    display_label: flow
                        .invite
                        .endpoint_label
                        .clone()
                        .unwrap_or_else(|| flow.invite.endpoint_principal_ref.clone()),
                    tenant_id: flow.invite.tenant_id.clone(),
                    route_id: flow.invite.endpoint_route_id.clone(),
                    mode: flow.invite.mode.clone(),
                    endpoint_principal_ref: flow.invite.endpoint_principal_ref.clone(),
                    endpoint_device_id: Some(flow.invite.endpoint_device_id.clone()),
                    endpoint_peer_identity,
                    endpoint_spki_pin: flow.invite.endpoint_spki_pin.clone(),
                    relay_service: flow.invite.relay_service.clone(),
                    vault_id: Some(flow.invite.vault_id.clone()),
                    device_id: flow.device.device_id.clone(),
                    device_fingerprint: flow.device.fingerprint.clone(),
                    capability_grant_ref,
                    account_action_target: Some(target.clone()),
                    relay_credential_ref: credential_ref,
                    bound_recovery_key_id: flow
                        .invite
                        .recovery_authority
                        .as_ref()
                        .map(|a| a.key_id.clone()),
                    pairing_service: None,
                    admission_generation,
                    revocation_revision,
                    enrolled_at: chrono::Utc::now()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    remote_revocation: "none".into(),
                    route_revocation: None,
                    account_binding: Some(crate::store::StoredAccountBinding {
                        account_id: account.account_id.clone(),
                        auth_epoch: account.auth_epoch,
                    }),
                    re_pair_required: false,
                    pairing_completion_checkpoint_ref: None,
                };
                let stored = connection.clone();
                self.store.lock().unwrap().update(|config| {
                    config.connections.retain(|c| {
                        c.endpoint_principal_ref != connection.endpoint_principal_ref
                    });
                    config.connections.push(connection);
                    if config.pending_pairing_device_id.as_deref()
                        == Some(flow.device.device_id.as_str())
                    {
                        config.pending_pairing_device_id = None;
                    }
                })?;
                let _ = self.custody.delete_secret(&checkpoint_ref);
                Ok(stored)
            }
            Err(e) => {
                // Unknown effect — the checkpoint stays in custody for the
                // completion-replay path.
                flow.state = "retry_required".into();
                Err(e)
            }
        }
    }

    /// Connect (or reuse) the forward session for one stored connection, then
    /// attach its peer lane to the shared `PeerHost` — `bindEntryPeer` in the
    /// TS product service.
    pub async fn connect(&self, connection_id: &str) -> Result<Arc<EntrySession>> {
        if let Some(session) = self.sessions.lock().unwrap().get(connection_id) {
            return Ok(session.clone());
        }
        let connection = {
            let store = self.store.lock().unwrap();
            store
                .config()
                .connections
                .iter()
                .find(|c| c.connection_id == connection_id)
                .cloned()
        }
        .ok_or_else(|| entry_error("connection_not_found", "The connection is not enrolled."))?;
        let cert_der = {
            let keypair = load_device_keypair(&*self.custody, None, &connection.device_id)?
                .ok_or_else(|| entry_error("custody_unavailable", "The paired device key is not in custody."))?;
            crate::cert::device_certificate_for_keypair(&keypair)?.cert_der
        };
        let key_der = custody_pkcs8(&*self.custody, &connection.device_id)?;
        let url = crate::relay::address::relay_session_url(
            &connection.relay_service,
            &connection.tenant_id,
            &connection.route_id,
            self.config.allow_insecure_loopback,
        )?;
        let mut options = EntrySessionOptions::forward(
            url,
            RelayAdmission {
                tenant_id: connection.tenant_id.clone(),
                route_id: connection.route_id.clone(),
                device_id: connection.device_id.clone(),
                role: "entry".into(),
                mode: connection.mode.clone(),
                admission_generation: connection.admission_generation,
                revocation_revision: connection.revocation_revision,
            },
            InnerTlsOptions {
                cert_der,
                key_der,
                pinned_peer_spki: vec![connection.endpoint_spki_pin.clone()],
                handshake_timeout: std::time::Duration::from_millis(15_000),
            },
        );
        options.allow_insecure_loopback = self.config.allow_insecure_loopback;
        options.headers = vec![(
            "authorization".into(),
            format!(
                "Bearer {}",
                recovery_bearer(&*self.custody, &connection.relay_credential_ref)?
            ),
        )];
        options.operation_principal = Some((
            connection.endpoint_principal_ref.clone(),
            connection.admission_generation,
        ));
        let session = Arc::new(EntrySession::connect(options).await?);
        self.sessions
            .lock()
            .unwrap()
            .insert(connection_id.to_string(), session.clone());
        self.attach_peer_host(&connection, session.clone()).await;
        Ok(session)
    }

    /// Attach the peer runtime for one connection to the lazily spawned host.
    /// Peer capability requires the pairing-pinned endpoint identity —
    /// connections enrolled before peer pairing skip attachment but still
    /// serve plain JSON-RPC sessions.
    async fn attach_peer_host(&self, connection: &StoredConnection, session: Arc<EntrySession>) {
        let Some(endpoint_device_id) = connection.endpoint_device_id.clone() else {
            return;
        };
        let endpoint_peer_identity = connection
            .endpoint_peer_identity
            .clone()
            .and_then(|v| serde_json::from_value::<crate::peer::PairedSignalIdentity>(v).ok());
        let Some(endpoint_peer_identity) = endpoint_peer_identity else {
            return;
        };
        let Ok(host) = self.peer_host() else { return };
        let connection_id = connection.connection_id.clone();
        let address = PeerApplicationAddress {
            tenant_id: connection.tenant_id.clone(),
            route_id: connection.route_id.clone(),
            local_device_id: connection.device_id.clone(),
            peer_device_id: endpoint_device_id.clone(),
        };
        let store = self.store.clone();
        let custody = self.custody.clone();
        let account_client = self.account_client.clone();
        let cid = connection_id.clone();
        let endpoint = endpoint_device_id.clone();
        let refresh_address = address.clone();
        let attach = host
            .attach_connection(PeerAttachRequest {
                connection_id: connection_id.clone(),
                store_dir: self.peer_store_dir(&connection.device_id),
                route: crate::peer::PeerRouteIdentity {
                    tenant_id: connection.tenant_id.clone(),
                    route_id: connection.route_id.clone(),
                    device_id: connection.device_id.clone(),
                },
                endpoint_device_id,
                endpoint_peer_identity: Some(endpoint_peer_identity),
                allows_peer: {
                    let store = store.clone();
                    let cid = cid.clone();
                    let endpoint = endpoint.clone();
                    Arc::new(move || {
                        let store = store.lock().unwrap();
                        store
                            .config()
                            .connections
                            .iter()
                            .find(|c| c.connection_id == cid)
                            .is_some_and(|c| {
                                !c.re_pair_required
                                    && !c.route_revocation.as_ref().is_some_and(|r| r.authority_revoked)
                                    && c.account_binding.is_some()
                                    && c.endpoint_peer_identity.is_some()
                                    && c.endpoint_device_id.as_deref() == Some(endpoint.as_str())
                            })
                    })
                },
                peer_authority: Arc::new(move || {
                    resolve_peer_authority(&store, &*custody, account_client.as_deref(), &address)
                }),
                session,
            })
            .await;
        if attach.is_ok() {
            // Keep the persisted agent catalog fresh: every successful peer
            // attachment refreshes the discovery record in the background so
            // `remote_agents` answers from the latest scan, not a stale one.
            tokio::spawn(async move {
                if let Err(error) = host.application_discover(refresh_address, None).await {
                    tracing::debug!(%error, "background agent discovery refresh failed");
                }
            });
        }
    }

    /// The lazily spawned peer host — created on first use so plain JSON-RPC
    /// sessions never pay the thread cost.
    fn peer_host(&self) -> Result<Arc<PeerHost>> {
        let mut slot = self.peer_host.lock().unwrap();
        if let Some(host) = slot.as_ref() {
            return Ok(host.clone());
        }
        let store = self.store.clone();
        let custody = self.custody.clone();
        let account_client = self.account_client.clone();
        let sessions = self.sessions.clone();
        let host = PeerHost::spawn(PeerHostOptions {
            agent_root: self.data_dir.join("personal-agent"),
            secret_resolver: Arc::new(CustodySecretResolver {
                custody: custody.clone(),
            }),
            authority_resolver: Arc::new(move |address| {
                resolve_peer_authority(&store, &*custody, account_client.as_deref(), address)
            }),
            connection_sessions: Arc::new(move |connection_id| {
                sessions
                    .lock()
                    .unwrap()
                    .get(connection_id)
                    .is_some_and(|s| s.accepts_new_work())
            }),
            agents_override: None,
        })?;
        *slot = Some(host.clone());
        Ok(host)
    }

    /// Subscribe to the peer host event feed (application records + per
    /// connection client lifecycle). Spawns the host on first use.
    pub fn peer_events(&self) -> Result<tokio::sync::broadcast::Receiver<PeerHostEvent>> {
        Ok(self.peer_host()?.subscribe())
    }

    /// Forward one JSON-RPC request on a connected session.
    pub async fn request(&self, connection_id: &str, message: Value) -> Result<Value> {
        let session = self.connect(connection_id).await?;
        session.request(message).await
    }

    /// Query the endpoint ledger for one operation's honest status.
    pub async fn query_operation(&self, connection_id: &str, operation_id: &str) -> Result<Value> {
        let session = self.connect(connection_id).await?;
        session.query_operation(operation_id).await
    }

    /// Close a connection's session (if any) and detach its peer runtime.
    pub async fn disconnect(&self, connection_id: &str) {
        if let Some(session) = self.sessions.lock().unwrap().remove(connection_id) {
            session.close("normal");
        }
        if let Some(host) = self.peer_host.lock().unwrap().as_ref() {
            host.detach_connection(connection_id);
        }
    }

    /// Run the recovery bootstrap for one connection: recovery text →
    /// recover_device channel → fresh device key → enrolled admission.
    pub async fn recover_connection(&self, connection_id: &str, recovery_text: &str) -> Result<String> {
        let connection = {
            let store = self.store.lock().unwrap();
            store
                .config()
                .connections
                .iter()
                .find(|c| c.connection_id == connection_id)
                .cloned()
        }
        .ok_or_else(|| entry_error("connection_not_found", "The connection is not enrolled."))?;
        let material = parse_recovery_text(recovery_text)?;
        let vault_id = connection.vault_id.clone().ok_or_else(|| {
            entry_error("recovery_vault_missing", "The connection has no recovery vault.")
        })?;
        if material.vault_id != vault_id {
            return Err(entry_error(
                "recovery_locator_mismatch",
                "The recovery text does not address this connection's vault.",
            ));
        }
        // The admission for a recover_device session reuses the paired
        // device's route binding (the endpoint decides authority).
        let channel = EntryRecoveryChannel::connect(
            &connection.relay_service,
            &RelayAdmission {
                tenant_id: connection.tenant_id.clone(),
                route_id: connection.route_id.clone(),
                device_id: connection.device_id.clone(),
                role: "entry".into(),
                mode: connection.mode.clone(),
                admission_generation: connection.admission_generation,
                revocation_revision: connection.revocation_revision,
            },
            &recovery_bearer(&*self.custody, &connection.relay_credential_ref)?,
            self.config.allow_insecure_loopback,
        )
        .await?;
        let bundle_connection = crate::recovery::bundle::BundleConnection {
            connection_id: connection.connection_id.clone(),
            display_label: connection.display_label.clone(),
            route_id: connection.route_id.clone(),
            tenant_id: connection.tenant_id.clone(),
            mode: connection.mode.clone(),
            endpoint_spki_pin: connection.endpoint_spki_pin.clone(),
            principal_ref: connection.endpoint_principal_ref.clone(),
            relay_service: connection.relay_service.clone(),
            vault_id: vault_id.clone(),
            trust_generation: connection.admission_generation,
            admission_generation: connection.admission_generation,
            revocation_revision: connection.revocation_revision,
            recovery_authority: connection.bound_recovery_key_id.as_ref().map(|key_id| {
                crate::recovery::bundle::BundleRecoveryAuthority {
                    key_id: key_id.clone(),
                    generation: connection.admission_generation,
                }
            }),
        };
        let recovery_session = crate::recovery::session::EntryRecoverySession::new(&channel);
        match recovery_session
            .recover(&bundle_connection, &*self.custody, None)
            .await
        {
            Ok(crate::recovery::session::RecoveryBootstrapOutcome::Enrolled {
                device,
                admission_generation,
                ..
            }) => {
                // The route's device identity changed — the old session and
                // peer runtime are stale evidence; close them so the next
                // connect binds the fresh device.
                self.disconnect(connection_id).await;
                self.store.lock().unwrap().update(|config| {
                    if let Some(c) = config
                        .connections
                        .iter_mut()
                        .find(|c| c.connection_id == connection_id)
                    {
                        c.device_id = device.device_id.clone();
                        c.device_fingerprint = device.fingerprint.clone();
                        c.admission_generation = admission_generation;
                        c.re_pair_required = false;
                    }
                })?;
                Ok(format!("enrolled:{}", device.device_id))
            }
            Ok(crate::recovery::session::RecoveryBootstrapOutcome::Refused { refusal }) => {
                Err(entry_error("recovery_refused", refusal))
            }
            Err(e) => Err(e),
        }
    }

    /* ---------- peer + application surface (ACP conversation layer) -------- */

    /// The route-bound application address for one enrolled connection.
    fn peer_connection_address(&self, connection_id: &str) -> Result<PeerApplicationAddress> {
        let store = self.store.lock().unwrap();
        let connection = store
            .config()
            .connections
            .iter()
            .find(|c| c.connection_id == connection_id)
            .ok_or_else(|| entry_error("connection_not_found", "The connection is not enrolled."))?;
        let endpoint = connection.endpoint_device_id.clone().ok_or_else(|| {
            entry_error("peer_unavailable", "The connection has no paired endpoint device.")
        })?;
        Ok(PeerApplicationAddress {
            tenant_id: connection.tenant_id.clone(),
            route_id: connection.route_id.clone(),
            local_device_id: connection.device_id.clone(),
            peer_device_id: endpoint,
        })
    }

    /// Send one opaque peer-schema plaintext to the paired endpoint — durable
    /// outbox entry returns immediately; delivery is retried on the runtime.
    pub async fn peer_send(
        &self,
        connection_id: &str,
        plaintext: Vec<u8>,
        message_id: Option<String>,
    ) -> Result<crate::peer::client_store::StoredOutboxEntry> {
        let address = self.peer_connection_address(connection_id)?;
        self.peer_host()?
            .peer_send(connection_id, &address.peer_device_id, plaintext, message_id)
            .await
    }

    /// Durable peer-runtime status for one connection (outbox/inbox/presence).
    pub async fn peer_status(
        &self,
        connection_id: &str,
    ) -> Result<crate::peer::runtime::EntryPeerStatus> {
        self.peer_host()?.peer_status(connection_id).await
    }

    /// Submit one application operation (prompt to the remote Agent) — the
    /// caller-side `submit` of `PeerApplicationEngine`.
    pub async fn application_submit(
        &self,
        connection_id: &str,
        operation_id: Option<String>,
        caller_agent_id: Option<String>,
        target_agent_id: &str,
        prompt: &str,
        model: Option<String>,
    ) -> Result<PeerApplicationRecord> {
        let address = self.peer_connection_address(connection_id)?;
        self.peer_host()?
            .application_submit(
                address,
                operation_id,
                caller_agent_id,
                target_agent_id.to_string(),
                prompt.to_string(),
                model,
            )
            .await
    }

    /// Request the remote Agent catalog for one connection.
    pub async fn application_discover(
        &self,
        connection_id: &str,
        request_id: Option<String>,
    ) -> Result<PeerApplicationDiscoveryRecord> {
        let address = self.peer_connection_address(connection_id)?;
        self.peer_host()?.application_discover(address, request_id).await
    }

    /// Cancel one application operation — propagates to the receiver's
    /// running execution when the route is live.
    pub async fn application_cancel(&self, operation_id: &str) -> Result<PeerApplicationRecord> {
        self.peer_host()?.application_cancel(operation_id).await
    }

    /// Resolve a pending permission request — explicit user decision, the
    /// only allowed resolution path (`policy: "ask"`).
    pub async fn application_resolve_permission(
        &self,
        operation_id: &str,
        permission_id: &str,
        resolution: AcpPermissionResolution,
    ) -> Result<PeerApplicationRecord> {
        self.peer_host()?
            .application_resolve_permission(operation_id, permission_id, resolution)
            .await
    }

    /// All durable application records (operations + their status history).
    pub async fn application_operations(&self) -> Result<Vec<PeerApplicationRecord>> {
        self.peer_host()?.list_operations().await
    }

    /// One durable operation record by id.
    pub async fn application_operation(
        &self,
        operation_id: &str,
    ) -> Result<Option<PeerApplicationRecord>> {
        self.peer_host()?.get_operation(operation_id).await
    }

    /// Local ACP agents registered for inbound execution.
    pub async fn local_agents(&self) -> Result<Vec<crate::peer::AcpAgentSummary>> {
        self.peer_host()?.local_agents().await
    }

    /// The remote Agent catalog for one connection (last discovery result).
    pub async fn remote_agents(
        &self,
        connection_id: &str,
    ) -> Result<Vec<crate::peer::AcpAgentSummary>> {
        let address = self.peer_connection_address(connection_id)?;
        self.peer_host()?.remote_agents(address).await
    }

    /// Register a local ACP agent definition (command + env; secret values
    /// stay as custody references, never serialized).
    pub async fn agent_register(
        &self,
        input: crate::agent::registry::AcpAgentDefinitionInput,
    ) -> Result<crate::peer::AcpAgentSummary> {
        self.peer_host()?.agent_register(input).await
    }

    /// Update a local ACP agent definition in place.
    pub async fn agent_update(
        &self,
        id: &str,
        input: crate::agent::registry::AcpAgentDefinitionInput,
    ) -> Result<crate::peer::AcpAgentSummary> {
        self.peer_host()?.agent_update(id, input).await
    }

    /// Remove a local ACP agent definition.
    pub async fn agent_remove(&self, id: &str) -> Result<bool> {
        self.peer_host()?.agent_remove(id).await
    }

    /// Remove a paired connection record and its custody-held secrets. The
    /// endpoint itself is never touched — this is local un-pairing; a fresh
    /// pairing can be made afterwards.
    pub fn remove_connection(&self, connection_id: &str) -> Result<bool> {
        let mut removed: Option<crate::store::StoredConnection> = None;
        self.store.lock().unwrap().update(|config| {
            let before = config.connections.len();
            let pos = config
                .connections
                .iter()
                .position(|c| c.connection_id == connection_id);
            if let Some(i) = pos {
                removed = Some(config.connections.remove(i));
            }
            debug_assert!(config.connections.len() == before - removed.is_some() as usize);
        })?;
        let Some(conn) = removed else {
            return Ok(false);
        };
        let _ = self.custody.delete_secret(&conn.relay_credential_ref);
        if let Some(cp) = &conn.pairing_completion_checkpoint_ref {
            let _ = self.custody.delete_secret(cp);
        }
        Ok(true)
    }

    /// Export the whole config for debugging — strictly non-secret.
    pub fn export_config(&self) -> Value {
        let store = self.store.lock().unwrap();
        serde_json::to_value(store.config()).unwrap_or(Value::Null)
    }

    /* ---------------------- personal endpoint surface --------------------- */

    /// `PersonalEndpointRuntime.create` — attach (or lazily spawn + attach)
    /// the endpoint runtime on the peer host thread. The relay base and
    /// account origin come from release-owned config, never user input.
    pub async fn endpoint_attach(&self) -> Result<()> {
        let host = self.peer_host()?;
        let options = PersonalEndpointRuntimeOptions {
            data_dir: self.data_dir.clone(),
            custody: self.custody.clone(),
            relay_service: self
                .config
                .default_relay_service
                .clone()
                .ok_or_else(|| entry_error("relay_service_missing", "No relay service is configured."))?,
            account_origin: self
                .config
                .account_origin
                .clone()
                .ok_or_else(|| entry_error("account_origin_missing", "No account origin is configured."))?,
            account_access: self.config.account_access.clone(),
            allow_insecure_loopback: self.config.allow_insecure_loopback,
            on_state: None,
        };
        host.endpoint_attach(options).await
    }

    fn endpoint_input(
        &self,
        request_fresh_step_up: StepUpDriver,
    ) -> Result<PersonalEndpointEnrollmentInput> {
        let (auth, _credential_ref) = self.desktop_auth()?;
        let device = self.account_device_identity()?;
        let keypair = load_device_keypair(&*self.custody, Some("entry.account.desktop"), &device.device_id)?
            .ok_or_else(|| {
                entry_error(
                    "account_custody_required",
                    "The desktop account signing key is unavailable in OS custody.",
                )
            })?;
        Ok(PersonalEndpointEnrollmentInput {
            account: auth.account,
            account_credential: auth.credential,
            desktop_device_id: device.device_id,
            desktop_public_key: device.public_key,
            desktop_key: Arc::new(keypair),
            request_fresh_step_up,
        })
    }

    /// `enrollCurrentAccount` — claim the account-owned personal route and
    /// persist the endpoint custody material. `request_fresh_step_up` is the
    /// caller's approval round-trip (CLI prints the URL and polls; the GUI
    /// surfaces its own sheet).
    pub async fn endpoint_enroll(
        &self,
        request_fresh_step_up: StepUpDriver,
    ) -> Result<PersonalEndpointSnapshot> {
        self.endpoint_attach().await?;
        let input = self.endpoint_input(request_fresh_step_up)?;
        self.peer_host()?.endpoint_enroll(input).await
    }

    /// `reenrollCurrentAccount` — re-claim after revocation under the
    /// original account only.
    pub async fn endpoint_reenroll(
        &self,
        request_fresh_step_up: StepUpDriver,
    ) -> Result<PersonalEndpointSnapshot> {
        self.endpoint_attach().await?;
        let input = self.endpoint_input(request_fresh_step_up)?;
        self.peer_host()?.endpoint_reenroll(input).await
    }

    pub async fn endpoint_start(&self) -> Result<PersonalEndpointSnapshot> {
        self.endpoint_attach().await?;
        self.peer_host()?.endpoint_start().await
    }

    pub async fn endpoint_stop(&self) -> Result<()> {
        self.peer_host()?.endpoint_stop().await
    }

    pub async fn endpoint_snapshot(&self) -> Result<PersonalEndpointSnapshot> {
        self.endpoint_attach().await?;
        self.peer_host()?.endpoint_snapshot().await
    }

    /// `createPairingInvite` — requires an admitted relay session plus a
    /// published peer bundle; the runtime enforces both.
    pub async fn endpoint_invite(&self) -> Result<PairingInvite> {
        self.peer_host()?.endpoint_invite().await
    }

    pub async fn endpoint_peer_send(
        &self,
        peer_device_id: &str,
        plaintext: &[u8],
        message_id: Option<String>,
    ) -> Result<crate::peer::client_store::StoredOutboxEntry> {
        self.peer_host()?
            .endpoint_peer_send(peer_device_id, plaintext, message_id)
            .await
    }

    pub async fn endpoint_peer_status(&self) -> Result<Vec<PersonalEndpointEntryDevice>> {
        self.peer_host()?.endpoint_peer_status().await
    }

    /// `peerInbox` — bounded inbox history + pending-handoff pages.
    pub async fn peer_inbox(
        &self,
        connection_id: &str,
        limit: usize,
        after_sequence: u64,
    ) -> Result<crate::peer::runtime::PeerInboxResult> {
        self.peer_host()?
            .peer_inbox(connection_id, limit, after_sequence)
            .await
    }

    /// `peerPairSafety` — out-of-band Signal identity safety evidence.
    pub async fn peer_pair_safety(
        &self,
        connection_id: &str,
        peer_device_id: &str,
    ) -> Result<crate::peer::runtime::PeerPairSafety> {
        self.peer_host()?
            .peer_pair_safety(connection_id, peer_device_id)
            .await
    }

    /// `approveDeviceCode` — approve a pending `XXXX-XXXX` desktop code
    /// transaction (device login or step-up) with this device's signed
    /// session proof. Headless counterpart of the browser approval card.
    pub fn approve_device_code(&self, code: &str) -> Result<()> {
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        let (auth, _credential_ref) = self.desktop_auth()?;
        let (client_public_key, signer) = self.account_signer()?;
        client.approve_device_code(code, &auth, &client_public_key, &signer)
    }

    /// `signOutAccount` — drop the session credential from custody and clear
    /// the stored account binding. Local connections/peer stores stay; a
    /// fresh login re-binds them by account id + epoch.
    pub fn sign_out(&self) -> Result<()> {
        let credential_ref = {
            let store = self.store.lock().unwrap();
            store
                .config()
                .account
                .as_ref()
                .and_then(|a| a.session_credential_ref.clone())
        };
        if let Some(reference) = credential_ref {
            let _ = self.custody.delete_secret(&reference);
        }
        self.store.lock().unwrap().update(|config| {
            if let Some(account) = config.account.as_mut() {
                account.account_id = None;
                account.auth_epoch = None;
                account.session_credential_ref = None;
            }
        })?;
        Ok(())
    }

    /// `revokeConnection(remote: true)` — device-only remote revoke: durable
    /// `routeRevocation` first (idempotent retries reuse the operation id),
    /// local session teardown, then the signed account call. The route and
    /// peer store stay untouched — recovery/re-pair still need them.
    pub async fn revoke_connection(&self, connection_id: &str, remote: bool) -> Result<()> {
        if !remote {
            self.disconnect(connection_id).await;
            return Ok(());
        }
        let mut current = {
            let store = self.store.lock().unwrap();
            store
                .config()
                .connections
                .iter()
                .find(|c| c.connection_id == connection_id)
                .cloned()
        }
        .ok_or_else(|| entry_error("connection_not_found", "The connection is not enrolled."))?;
        let auth = self.desktop_auth()?.0;
        let stored_binding = current.account_binding.clone().ok_or_else(|| {
            entry_error("account_binding_mismatch", "This connection is not bound to an account.")
        })?;
        if auth.account.account_id != stored_binding.account_id {
            return Err(entry_error(
                "account_binding_mismatch",
                "Sign in to the account that owns this paired device before revoking it.",
            ));
        }
        let (client_public_key, signer) = self.account_signer()?;
        if current.route_revocation.is_none() {
            let revocation = crate::store::StoredRouteRevocation {
                operation_id: format!("device-revoke.{}", crate::b64::b64u_encode(&crate::keys::random_bytes(18))),
                target: "device".to_string(),
                authority_revoked: false,
                enforcement: "pending".to_string(),
            };
            self.store.lock().unwrap().update(|config| {
                if let Some(c) = config
                    .connections
                    .iter_mut()
                    .find(|c| c.connection_id == connection_id)
                {
                    c.route_revocation = Some(revocation.clone());
                    c.re_pair_required = true;
                }
            })?;
            let store = self.store.lock().unwrap();
            current = store
                .config()
                .connections
                .iter()
                .find(|c| c.connection_id == connection_id)
                .cloned()
                .unwrap_or(current);
        }
        // Tear the local session down before the remote call — same order as
        // the TS revokeConnection.
        self.disconnect(connection_id).await;
        let operation = current.route_revocation.clone().unwrap();
        if operation.authority_revoked && operation.enforcement == "complete" {
            return Ok(());
        }
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        let receipt = client.revoke_device(
            &operation.operation_id,
            &current.tenant_id,
            &current.route_id,
            &current.device_id,
            &auth,
            &client_public_key,
            &signer,
        )?;
        if receipt.target != "device" {
            return Err(entry_error(
                "account_device_revoke_invalid",
                "The account service returned a route-wide revoke for a device-only action.",
            ));
        }
        self.store.lock().unwrap().update(|config| {
            if let Some(c) = config
                .connections
                .iter_mut()
                .find(|c| c.connection_id == connection_id)
            {
                if let Some(r) = c.route_revocation.as_mut() {
                    r.authority_revoked = receipt.authority_revoked;
                    r.enforcement = receipt.enforcement.clone();
                }
            }
        })?;
        Ok(())
    }

    /// `mcpSnippet` — the stdio `mcpServers` block for local MCP clients.
    pub fn mcp_snippet(&self) -> Value {
        let snippet = crate::mcp::build_mcp_stdio_snippet(
            "meshrix-entry",
            "meshrix-entry",
            &["--mcp-stdio"],
        );
        let managed_path = crate::mcp::managed_mcp_config_path(&self.data_dir);
        json!({
            "snippet": snippet,
            "instructions": "Paste this entry into your MCP client's server configuration. The stdio transport needs no listener or port.",
            "managedPath": managed_path.to_string_lossy(),
        })
    }

    /// `writeMcpConfig` — write the owned managed snippet under dataDir.
    pub fn write_mcp_config(&self) -> Result<Value> {
        let view = self.mcp_snippet();
        let snippet = view
            .get("snippet")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let managed_path = crate::mcp::managed_mcp_config_path(&self.data_dir);
        crate::mcp::write_managed_mcp_config(&managed_path, &snippet)?;
        Ok(json!({
            "snippet": snippet,
            "managedPath": managed_path.to_string_lossy(),
        }))
    }

    /// `begin_endpoint_step_up` — the `pair_device` step-up transaction bound
    /// to the personal-route claim id. Mirrors `#requestPersonalStepUp` in
    /// the TS product service.
    pub fn begin_endpoint_step_up(
        &self,
        request: &PersonalEndpointStepUpRequest,
    ) -> Result<DesktopAccountTransaction> {
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        let (auth, _credential_ref) = self.desktop_auth()?;
        if crate::canonical::canonical_json(&serde_json::to_value(&auth.account).unwrap_or(Value::Null))
            != crate::canonical::canonical_json(&serde_json::to_value(&request.account).unwrap_or(Value::Null))
        {
            return Err(entry_error(
                "account_binding_mismatch",
                "The local account session changed before this authorization began.",
            ));
        }
        let (client_public_key, signer) = self.account_signer()?;
        client.create_transaction(
            "step_up",
            &client_public_key,
            Some(&request.target),
            Some("pair_device"),
            None,
            Some(&request.claim_id),
            Some((&auth, &signer)),
        )
    }

    /// Poll the endpoint step-up transaction — `Complete` yields the
    /// `PersonalEndpointStepUpResult` the enrollment driver returns.
    pub fn poll_endpoint_step_up(
        &self,
        request: &PersonalEndpointStepUpRequest,
        transaction: &DesktopAccountTransaction,
    ) -> Result<StepUpPoll> {
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        match client.poll_transaction(&transaction.transaction_id, &transaction.verifier)? {
            TransactionPoll::Pending => Ok(StepUpPoll::Pending),
            TransactionPoll::Expired => Ok(StepUpPoll::Expired),
            TransactionPoll::Consumed => Ok(StepUpPoll::Consumed),
            TransactionPoll::Complete {
                account,
                purpose,
                permit_id,
                action_purpose,
                target,
                ..
            } => {
                let mismatch = || {
                    entry_error(
                        "account_step_up_mismatch",
                        "The verified factor result does not match the pending personal route claim.",
                    )
                };
                if purpose != "step_up"
                    || action_purpose.as_deref() != Some("pair_device")
                    || transaction.purpose != "step_up"
                {
                    return Err(mismatch());
                }
                let permit_id = permit_id.ok_or_else(mismatch)?;
                let target = target.ok_or_else(mismatch)?;
                if canonical_account_action_target(&target)
                    != canonical_account_action_target(&request.target)
                    || crate::canonical::canonical_json(&serde_json::to_value(&account).unwrap_or(Value::Null))
                        != crate::canonical::canonical_json(
                            &serde_json::to_value(&request.account).unwrap_or(Value::Null),
                        )
                {
                    return Err(mismatch());
                }
                let _ = client.acknowledge_transaction(&transaction.transaction_id, &transaction.verifier);
                Ok(StepUpPoll::Complete { account, permit_id, target })
            }
        }
    }
}

/// Human-readable device label — the OS hostname minus a `.local` suffix.
pub(crate) fn host_label() -> String {
    let raw = gethostname::gethostname().to_string_lossy().into_owned();
    raw.strip_suffix(".local").unwrap_or(&raw).to_string()
}

/// Lowercase opaque suffix — must stay within the custody ref alphabet
/// (`[a-z0-9._-]`), so hex is used instead of base64url.
fn generate_suffix() -> String {
    hex_32()
}

fn hex_32() -> String {
    crate::keys::random_bytes(16).iter().map(|b| format!("{b:02x}")).collect()
}

/// Load the custody-held PKCS#8 seed for the desktop account device key —
/// custodied under the `entry.account.desktop` prefix — and derive a signer.
fn account_signer_for(custody: &dyn CustodyAdapter, device_id: &str) -> Result<impl Fn(&[u8]) -> Vec<u8>> {
    let keypair = load_device_keypair(custody, Some("entry.account.desktop"), device_id)?.ok_or_else(|| {
        entry_error("custody_unavailable", "The desktop account key is not in custody.")
    })?;
    Ok(move |message: &[u8]| keypair.sign(message))
}

fn custody_pkcs8(custody: &dyn CustodyAdapter, device_id: &str) -> Result<Vec<u8>> {
    let keypair = load_device_keypair(custody, None, device_id)?.ok_or_else(|| {
        entry_error("custody_unavailable", "The paired device key is not in custody.")
    })?;
    Ok(crate::keys::ed25519_pkcs8_der(&keypair.signing_key))
}



fn recovery_bearer(custody: &dyn CustodyAdapter, credential_ref: &str) -> Result<String> {
    let bytes = custody.load_secret(credential_ref)?.ok_or_else(|| {
        entry_error("custody_unavailable", "The relay bearer credential is not in custody.")
    })?;
    String::from_utf8(bytes)
        .map_err(|_| entry_error("custody_unavailable", "The relay bearer credential is unreadable."))
}

/// `AcpAgentSecretResolver` backed by custody — an agent env
/// `secret_reference` resolves to the custody-held value at launch time and
/// is never persisted in the registry document.
struct CustodySecretResolver {
    custody: Arc<dyn CustodyAdapter>,
}

impl crate::agent::registry::AcpAgentSecretResolver for CustodySecretResolver {
    fn resolve(
        &self,
        reference: &str,
    ) -> futures_util::future::LocalBoxFuture<'static, Option<String>> {
        let custody = self.custody.clone();
        let reference = reference.to_string();
        Box::pin(async move {
            custody
                .load_secret(&reference)
                .ok()
                .flatten()
                .and_then(|b| String::from_utf8(b).ok())
        })
    }
}

/// `#resolvePeerAuthority` — the caller-side authority decision from
/// `product-service.ts`: exact connection match → stored revocation → account
/// binding epoch → pairing grant target → signed `deviceCurrentBinding`
/// check. `denied` settles as revoked on this client (no separate surface).
fn resolve_peer_authority(
    store: &std::sync::Mutex<EntryConfigStore>,
    custody: &dyn CustodyAdapter,
    account_client: Option<&DesktopAccountClient>,
    address: &PeerApplicationAddress,
) -> PeerApplicationRouteAuthority {
    let (binding, target, device_id, endpoint_device_id) = {
        let store = store.lock().unwrap();
        let config = store.config();
        let Some(connection) = config.connections.iter().find(|c| {
            c.tenant_id == address.tenant_id
                && c.route_id == address.route_id
                && c.device_id == address.local_device_id
                && c.endpoint_device_id.as_deref() == Some(address.peer_device_id.as_str())
        }) else {
            // This client owns no personal-endpoint runtime — the TS
            // fall-through resolves `unavailable`.
            return PeerApplicationRouteAuthority::Unavailable;
        };
        if connection.re_pair_required
            || connection
                .route_revocation
                .as_ref()
                .is_some_and(|r| r.authority_revoked)
            || connection.account_binding.is_none()
            || connection.endpoint_peer_identity.is_none()
        {
            return PeerApplicationRouteAuthority::Revoked;
        }
        let binding = connection.account_binding.clone().unwrap();
        let account_matches = config.account.as_ref().is_some_and(|a| {
            a.account_id.as_deref() == Some(binding.account_id.as_str())
                && a.auth_epoch == Some(binding.auth_epoch)
        });
        if !account_matches {
            return PeerApplicationRouteAuthority::Revoked;
        }
        let Some(target) = connection.account_action_target.clone() else {
            return PeerApplicationRouteAuthority::Unavailable;
        };
        (
            binding,
            target,
            connection.device_id.clone(),
            connection.endpoint_device_id.clone().unwrap(),
        )
    };
    let Some(client) = account_client else {
        return PeerApplicationRouteAuthority::Unavailable;
    };
    // The device key in custody must still equal the pairing grant's key —
    // a silently re-keyed device loses its authority grant.
    let keypair = match load_device_keypair(custody, None, &device_id) {
        Ok(Some(k)) => k,
        _ => return PeerApplicationRouteAuthority::Unavailable,
    };
    if keypair.public_key_b64u() != target.device_public_key
        || target.tenant_id != address.tenant_id
        || target.route_id != address.route_id
        || target.device_id != device_id
    {
        return PeerApplicationRouteAuthority::Revoked;
    }
    let targets = [target];
    let binding = AccountAuthorityBinding {
        account_id: binding.account_id,
        auth_epoch: binding.auth_epoch,
    };
    match client.check_device_authorization(
        &DeviceAuthorizationCheck {
            tenant_id: &address.tenant_id,
            route_id: &address.route_id,
            device_id: &device_id,
            peer_device_id: &endpoint_device_id,
            binding: &binding,
            authorized_targets: &targets,
            scope: Some("peer:message"),
        },
        &keypair,
    ) {
        DeviceAuthorizationDecision::Current(_) => PeerApplicationRouteAuthority::Current,
        DeviceAuthorizationDecision::Unavailable => PeerApplicationRouteAuthority::Unavailable,
        DeviceAuthorizationDecision::Revoked | DeviceAuthorizationDecision::Denied => {
            PeerApplicationRouteAuthority::Revoked
        }
    }
}

/// Restore a stored config document (e.g. imported state) — strict parse.
pub fn parse_stored_config(value: &Value) -> Option<EntryGuiConfig> {
    parse_entry_gui_config(value)
}

/// Convenience: the JSON body for a GUI state request.
pub fn redacted_state_json(state: &ServiceState) -> Value {
    serde_json::to_value(state).unwrap_or(Value::Null)
}

/* ================================================================== */
/* Recovery lifecycle + account-managed vault-writer rotation          */
/* ================================================================== */

/// `MAX_RECOVERY_SECRET_WINDOW_MS` — the reveal-once candidate dies with
/// its save window; a rotation bound to it can never reach publication.
const MAX_RECOVERY_SECRET_WINDOW_MS: i64 = 10 * 60_000;

/// `PendingRecoverySecret` — the reveal-once candidate held only in memory.
struct PendingRecoverySecret {
    recovery_text: String,
    material: crate::recovery::crypto::RecoveryMaterial,
    vault_id: String,
    key_id: String,
    generation: u64,
    rotation_id: Option<String>,
    revealed: bool,
    expires_at_ms: i64,
}

/// The custody-held flow blob for a pending writer rotation — the exact
/// replayable requests and the in-flight browser transaction.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultWriterFlow {
    account: AccountAuthorityBinding,
    #[serde(default)]
    prepare_request: Option<Value>,
    #[serde(default)]
    target: Option<AccountActionTarget>,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    browser_transaction: Option<DesktopAccountTransaction>,
    #[serde(default)]
    complete_request: Option<Value>,
}

/// `PendingVaultWriterRotation` — durable record + custody-held flow.
#[derive(Debug, Clone)]
struct PendingVaultWriter {
    operation_id: String,
    connection_id: String,
    vault_id: String,
    candidate_key_id: String,
    generation: u64,
    material_ref: String,
    flow_ref: String,
    state: String,
    flow: VaultWriterFlow,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn custody_recovery_ref(vault_id: &str) -> String {
    let safe: String = vault_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c.to_ascii_lowercase() } else { '-' })
        .collect();
    format!("entry.recovery.{safe}")
}

fn custody_recovery_key_ref(vault_id: &str, key_id: &str) -> String {
    let safe: String = key_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c.to_ascii_lowercase() } else { '-' })
        .collect();
    custody_recovery_ref(vault_id)
        .split_at(custody_recovery_ref(vault_id).len().min(128))
        .0
        .to_string()
        + "."
        + &safe
}

/// `retainedRecoveryRefs` — the prior material refs kept for decrypting the
/// preserved older snapshot; the next active ref is never retained.
fn retained_recovery_refs(
    current: Option<&StoredRecovery>,
    vault_id: &str,
    next_material_ref: &str,
) -> Vec<String> {
    let mut refs: Vec<String> = match current {
        Some(c) if c.vault_id == vault_id => {
            let mut v = c.retained_material_refs.clone();
            v.push(c.material_ref.clone());
            v
        }
        _ => Vec::new(),
    };
    refs.retain(|r| r != next_material_ref);
    refs.sort();
    refs.dedup();
    refs
}

/// `ConfigSnapshotJournal` — journal bound to the owned config file so
/// high-water marks never regress across restarts.
struct ConfigSnapshotJournal {
    store: Arc<std::sync::Mutex<EntryConfigStore>>,
}

impl crate::recovery::sync::SnapshotJournalPort for ConfigSnapshotJournal {
    fn load(&mut self) -> Option<StoredSnapshotJournal> {
        self.store.lock().unwrap().config().journal.clone()
    }
    fn save(&mut self, journal: &StoredSnapshotJournal) -> Result<()> {
        self.store
            .lock()
            .unwrap()
            .update(|c| c.journal = Some(journal.clone()))
    }
}

/// `ConfigRotationStore` — durable rotation records in the owned config.
struct ConfigRotationStore {
    store: Arc<std::sync::Mutex<EntryConfigStore>>,
}

impl crate::recovery::rotation::RotationDurablePort for ConfigRotationStore {
    fn load(&mut self, rotation_id: &str) -> Option<StoredRotation> {
        self.store
            .lock()
            .unwrap()
            .config()
            .rotations
            .iter()
            .find(|r| r.rotation_id == rotation_id)
            .cloned()
    }
    fn load_all(&mut self) -> Vec<StoredRotation> {
        self.store.lock().unwrap().config().rotations.clone()
    }
    fn save(&mut self, rotation: &StoredRotation) -> Result<()> {
        let rotation = rotation.clone();
        self.store.lock().unwrap().update(|c| {
            if let Some(existing) = c
                .rotations
                .iter_mut()
                .find(|r| r.rotation_id == rotation.rotation_id)
            {
                *existing = rotation.clone();
            } else {
                c.rotations.push(rotation.clone());
            }
        })
    }
    fn delete(&mut self, rotation_id: &str) -> Result<()> {
        self.store
            .lock()
            .unwrap()
            .update(|c| c.rotations.retain(|r| r.rotation_id != rotation_id))
    }
}

/// Poll result for the account-managed vault-writer step-up — mirrors the
/// endpoint step-up surface for the CLI/GUI drivers.
#[derive(Debug)]
pub enum VaultWriterStepUpPoll {
    /// No pending writer operation is waiting for authorization.
    Idle,
    /// The browser transaction is still open.
    Pending { browser_url: String, user_code: String },
    /// The transaction expired; retry prepares a fresh target.
    Expired,
    /// The transaction was consumed without completing.
    Consumed,
    /// The permit was issued and the completion submission ran.
    Complete,
}

impl EntryService {
    fn is_account_managed_vault(&self, vault_id: &str) -> bool {
        let store = self.store.lock().unwrap();
        let config = store.config();
        config
            .recovery
            .as_ref()
            .is_some_and(|r| r.vault_id == vault_id && r.account_writer_state != "unmanaged")
            || config.connections.iter().any(|c| {
                c.vault_id.as_deref() == Some(vault_id) && c.account_binding.is_some()
            })
    }

    fn account_managed_connection(&self, vault_id: &str) -> Option<StoredConnection> {
        let store = self.store.lock().unwrap();
        let config = store.config();
        if config.account.as_ref().and_then(|a| a.account_id.clone()).is_none()
            || config.account.as_ref().and_then(|a| a.auth_epoch).is_none()
        {
            return None;
        }
        config
            .connections
            .iter()
            .find(|c| c.vault_id.as_deref() == Some(vault_id) && c.account_binding.is_some() && !c.re_pair_required)
            .cloned()
    }

    fn recovery_material(&self) -> Option<crate::recovery::crypto::RecoveryMaterial> {
        self.recovery_material.lock().unwrap().clone()
    }

    fn synchronizer(
        &self,
    ) -> Result<
        crate::recovery::sync::SnapshotSynchronizer<
            crate::recovery::vault::HttpsVaultTransport,
            ConfigSnapshotJournal,
        >,
    > {
        let base = self.default_service_base()?;
        let transport = crate::recovery::vault::HttpsVaultTransport::new(&base)?;
        Ok(crate::recovery::sync::SnapshotSynchronizer::new(
            crate::recovery::vault::RecoveryVaultClient::new(transport),
            ConfigSnapshotJournal {
                store: self.store.clone(),
            },
        ))
    }

    fn default_service_base(&self) -> Result<String> {
        let store = self.store.lock().unwrap();
        if let Some(configured) = &store.config().pairing_service_default {
            return Ok(configured.clone());
        }
        let first = store.config().connections.first().ok_or_else(|| {
            entry_error(
                "recovery_locator_missing",
                "No endpoint service address is known for the recovery vault.",
            )
        })?;
        crate::relay::address::relay_http_base(&first.relay_service, self.config.allow_insecure_loopback)
    }

    fn rotation_manager(
        &self,
    ) -> crate::recovery::rotation::RecoveryRotationManager<ConfigRotationStore> {
        crate::recovery::rotation::RecoveryRotationManager::new(ConfigRotationStore {
            store: self.store.clone(),
        })
    }

    /// `#buildBundle` — the current configuration as a recovery bundle.
    fn build_bundle(&self) -> Result<crate::recovery::bundle::EntryRecoveryBundle> {
        let store = self.store.lock().unwrap();
        let config = store.config();
        let recovery = config.recovery.clone();
        let connections: Vec<crate::recovery::bundle::BundleConnection> = config
            .connections
            .iter()
            .map(|c| crate::recovery::bundle::BundleConnection {
                connection_id: c.connection_id.clone(),
                display_label: c.display_label.clone(),
                route_id: c.route_id.clone(),
                tenant_id: c.tenant_id.clone(),
                mode: c.mode.clone(),
                endpoint_spki_pin: c.endpoint_spki_pin.clone(),
                principal_ref: c.endpoint_principal_ref.clone(),
                relay_service: c.relay_service.clone(),
                vault_id: c
                    .vault_id
                    .clone()
                    .or_else(|| recovery.as_ref().map(|r| r.vault_id.clone()))
                    .unwrap_or_default(),
                trust_generation: recovery.as_ref().map(|r| r.generation).unwrap_or(1),
                admission_generation: c.admission_generation,
                revocation_revision: c.revocation_revision,
                recovery_authority: recovery.as_ref().map(|r| {
                    crate::recovery::bundle::BundleRecoveryAuthority {
                        key_id: r.key_id.clone(),
                        generation: r.generation,
                    }
                }),
            })
            .collect();
        crate::recovery::bundle::build_entry_recovery_bundle(
            "prof.entry-gui.1",
            &config.profile.display_label,
            connections,
            None,
        )
    }

    /// `GuiRecoveryView` equivalent — redacted recovery state for callers.
    pub fn recovery_view(&self) -> Value {
        let store = self.store.lock().unwrap();
        let config = store.config();
        let recovery = config.recovery.clone();
        let pending = self.pending_recovery.lock().unwrap();
        let writer = self.pending_vault_writer.lock().unwrap();
        let journal = config.journal.clone();
        let rotation = config
            .rotations
            .iter()
            .filter(|r| r.state != "completed" && r.state != "aborted")
            .last()
            .cloned();
        let writer_state = if let Some(p) = writer.as_ref() {
            match p.state.as_str() {
                "prepare_pending" => "prepare_pending",
                "authorization_required" => "authorization_required",
                _ => "service_pending",
            }
        } else {
            recovery
                .as_ref()
                .map(|r| match r.account_snapshot_state.as_str() {
                    "older_snapshot_preserved" => "older_snapshot_preserved",
                    _ => r.account_writer_state.as_str(),
                })
                .unwrap_or("unmanaged")
        };
        let state = if pending.is_some() {
            "awaiting_save"
        } else if recovery.is_none() {
            "not_configured"
        } else if writer_state == "prepare_pending" {
            "account_writer_pending"
        } else if writer_state == "authorization_required" {
            "account_authorization_required"
        } else if rotation.is_some() {
            "rotation_pending"
        } else {
            "ready"
        };
        json!({
            "state": state,
            "vaultId": recovery.as_ref().map(|r| r.vault_id.clone()),
            "keyId": recovery.as_ref().map(|r| r.key_id.clone()),
            "generation": recovery.as_ref().map(|r| r.generation),
            "keyRevealed": pending.as_ref().is_some_and(|p| p.revealed),
            "writerRegistration": {
                "state": writer_state,
                "candidateVaultId": writer.as_ref().map(|w| w.vault_id.clone()),
                "candidateKeyId": writer.as_ref().map(|w| w.candidate_key_id.clone()),
                "candidateGeneration": writer.as_ref().map(|w| w.generation),
                "detail": Value::Null,
            },
            "backup": {
                "lastSuccessAt": journal.as_ref().and_then(|j| j.last_success_at.clone()),
                "lastCommittedRevision": journal.as_ref().and_then(|j| j.last_committed.as_ref().map(|c| c.revision)),
                "lastError": journal.as_ref().and_then(|j| j.last_error.clone()),
            },
            "rotation": rotation.map(|r| json!({
                "rotationId": r.rotation_id,
                "state": r.state,
                "candidateGeneration": r.candidate_generation,
                "endpoints": r.endpoints.iter().map(|e| json!({
                    "endpointRouteId": e.endpoint_route_id,
                    "state": e.state,
                })).collect::<Vec<_>>(),
            })),
        })
    }

    /* ------------------------- setup candidates ----------------------- */

    fn discard_expired_recovery_candidate(&self) {
        let mut guard = self.pending_recovery.lock().unwrap();
        let expired = guard
            .as_ref()
            .is_some_and(|p| p.expires_at_ms <= now_ms());
        if expired {
            let pending = guard.take().unwrap();
            drop(guard);
            if let Some(rotation_id) = &pending.rotation_id {
                let mut manager = self.rotation_manager();
                if let Ok(rotation) = manager.get(rotation_id).ok_or(()).and_then(|r| {
                    if r.state != "completed" && r.state != "aborted" {
                        Ok(r)
                    } else {
                        Err(())
                    }
                }) {
                    let _ = manager.abort(&rotation.rotation_id);
                }
            }
        }
    }

    /// `beginRecoverySetup` — stage a fresh recovery key behind the one-shot
    /// reveal contract. Nothing persists until confirmation.
    pub fn begin_recovery_setup(&self) -> Result<Value> {
        self.discard_expired_recovery_candidate();
        {
            let store = self.store.lock().unwrap();
            if store.config().recovery.is_some() {
                return Err(entry_error(
                    "recovery_state_invalid",
                    "A recovery key is already configured; begin a rotation instead.",
                ));
            }
        }
        if self.pending_recovery.lock().unwrap().is_some() {
            return Err(entry_error(
                "recovery_state_invalid",
                "A recovery key candidate is already awaiting save confirmation; cancel it before generating another.",
            ));
        }
        let vault_id = {
            let store = self.store.lock().unwrap();
            let config = store.config();
            config
                .connections
                .iter()
                .find(|c| c.vault_id.is_some() && c.account_binding.is_some() && !c.re_pair_required)
                .or_else(|| config.connections.iter().find(|c| c.vault_id.is_some()))
                .and_then(|c| c.vault_id.clone())
                .unwrap_or_else(|| {
                    format!(
                        "vault.entry.{}",
                        crate::b64::b64u_encode(&crate::keys::random_bytes(9))
                    )
                })
        };
        let key = crate::recovery::key::generate_recovery_key(Some(vault_id.clone()))?;
        let material = crate::recovery::crypto::derive_recovery_material(&key.secret)?;
        let recovery_text = crate::recovery::key::format_recovery_text(&key)?;
        *self.pending_recovery.lock().unwrap() = Some(PendingRecoverySecret {
            recovery_text,
            material: material.clone(),
            vault_id: vault_id.clone(),
            key_id: material.signing.key_id.clone(),
            generation: 1,
            rotation_id: None,
            revealed: false,
            expires_at_ms: now_ms() + MAX_RECOVERY_SECRET_WINDOW_MS,
        });
        Ok(json!({
            "vaultId": vault_id,
            "keyId": material.signing.key_id,
            "generation": 1,
        }))
    }

    /// `revealRecoveryKey` — returns the recovery text exactly once, inside
    /// the bounded save window.
    pub fn reveal_recovery_key(&self) -> Result<Value> {
        let mut guard = self.pending_recovery.lock().unwrap();
        let pending = guard.as_mut().ok_or_else(|| {
            entry_error(
                "recovery_state_invalid",
                "No recovery key is pending save confirmation.",
            )
        })?;
        if pending.revealed {
            return Err(entry_error(
                "recovery_state_invalid",
                "The recovery text was already revealed once; it cannot be shown again.",
            ));
        }
        if pending.expires_at_ms <= now_ms() {
            let rotation_id = pending.rotation_id.clone();
            drop(guard);
            if let Some(rotation_id) = rotation_id {
                let _ = self.rotation_manager().abort(&rotation_id);
            }
            return Err(entry_error(
                "recovery_state_invalid",
                "The recovery key save window expired; generate a fresh key.",
            ));
        }
        pending.revealed = true;
        Ok(json!({
            "recoveryText": pending.recovery_text,
            "vaultId": pending.vault_id,
            "keyId": pending.key_id,
        }))
    }

    /// `confirmRecoverySaved` — persist derived material to custody, then
    /// either register the writer through the account authority (managed
    /// vault) or publish the first snapshot (unmanaged vault).
    pub async fn confirm_recovery_saved(&self) -> Result<Value> {
        let pending = {
            let guard = self.pending_recovery.lock().unwrap();
            let pending = guard.as_ref().ok_or_else(|| {
                entry_error(
                    "recovery_state_invalid",
                    "The recovery text must be revealed and saved before confirmation.",
                )
            })?;
            if !pending.revealed {
                return Err(entry_error(
                    "recovery_state_invalid",
                    "The recovery text must be revealed and saved before confirmation.",
                ));
            }
            PendingRecoverySecret {
                recovery_text: pending.recovery_text.clone(),
                material: pending.material.clone(),
                vault_id: pending.vault_id.clone(),
                key_id: pending.key_id.clone(),
                generation: pending.generation,
                rotation_id: pending.rotation_id.clone(),
                revealed: pending.revealed,
                expires_at_ms: pending.expires_at_ms,
            }
        };
        let managed = self.account_managed_connection(&pending.vault_id);
        if managed.is_some() || self.is_account_managed_vault(&pending.vault_id) {
            let connection = managed.ok_or_else(|| {
                entry_error(
                    "account_repair_required",
                    "Pair a current account-authorized device before registering vault backup keys.",
                )
            })?;
            self.begin_account_vault_writer_registration(&pending, &connection)
                .await?;
            return Ok(json!({ "state": "writer_registration_pending" }));
        }
        // Unmanaged vault: custody-store the material and activate it.
        let material_ref = custody_recovery_key_ref(&pending.vault_id, &pending.key_id);
        self.custody.store_secret(
            &material_ref,
            &crate::recovery::crypto::serialize_recovery_material(&pending.material),
        )?;
        *self.recovery_material.lock().unwrap() = Some(pending.material.clone());
        let rotation_id = pending.rotation_id.clone();
        let prior = {
            let store = self.store.lock().unwrap();
            store.config().recovery.clone()
        };
        self.store.lock().unwrap().update(|c| {
            c.recovery = Some(StoredRecovery {
                vault_id: pending.vault_id.clone(),
                key_id: pending.key_id.clone(),
                generation: pending.generation,
                material_ref: material_ref.clone(),
                confirmed_at: now_iso(),
                account_writer_state: "unmanaged".into(),
                account_snapshot_state: "ready".into(),
                snapshot_source_material_ref: None,
                retained_material_refs: retained_recovery_refs(
                    prior.as_ref(),
                    &pending.vault_id,
                    &material_ref,
                ),
            });
        })?;
        // The text is cleared here — the root secret is never at rest.
        *self.pending_recovery.lock().unwrap() = None;
        if let Some(rotation_id) = rotation_id {
            let mut manager = self.rotation_manager();
            manager.mark_published(&rotation_id)?;
            // Endpoints that acknowledged before publication still count.
            let rotation = manager.get(&rotation_id);
            if let Some(rotation) = rotation {
                if rotation
                    .endpoints
                    .iter()
                    .all(|e| e.state == "acknowledged")
                {
                    if let Some(first) = rotation.endpoints.first() {
                        let _ = manager.mark_endpoint(
                            &rotation_id,
                            &first.endpoint_route_id,
                            "acknowledged",
                        );
                    }
                }
            }
        }
        self.publish_snapshot().await
    }

    /* ------------------- account-managed writer flow ------------------- */

    async fn begin_account_vault_writer_registration(
        &self,
        candidate: &PendingRecoverySecret,
        connection: &StoredConnection,
    ) -> Result<()> {
        if self.pending_vault_writer.lock().unwrap().is_some() {
            return Err(entry_error(
                "account_transaction_pending",
                "An account vault writer operation is already pending.",
            ));
        }
        if connection.account_binding.is_none()
            || connection.re_pair_required
            || connection.vault_id.as_deref() != Some(candidate.vault_id.as_str())
        {
            return Err(entry_error(
                "account_repair_required",
                "The selected route is not paired under the current account epoch for this vault.",
            ));
        }
        let (auth, _credential_ref) = self.desktop_auth()?;
        if let Some(bound) = &connection.account_binding {
            if bound.account_id != auth.account.account_id || bound.auth_epoch != auth.account.auth_epoch {
                return Err(entry_error(
                    "account_binding_mismatch",
                    "The local account session changed before this authorization began.",
                ));
            }
        }
        let identity = device_identity_from_custody(&*self.custody, None, &connection.device_id)?
            .ok_or_else(|| {
                entry_error(
                    "custody_unavailable",
                    "The current Entry device signing key is unavailable in OS custody.",
                )
            })?;
        let entry_key = load_device_keypair(&*self.custody, None, &connection.device_id)?
            .ok_or_else(|| {
                entry_error(
                    "custody_unavailable",
                    "The current Entry device signing key is unavailable in OS custody.",
                )
            })?;
        let material_ref = custody_recovery_key_ref(&candidate.vault_id, &candidate.key_id);
        self.custody.store_secret(
            &material_ref,
            &crate::recovery::crypto::serialize_recovery_material(&candidate.material),
        )?;
        let operation_id = format!(
            "vault-writer-{}",
            crate::b64::b64u_encode(&crate::keys::random_bytes(24))
        );
        let flow_ref = format!("entry.account.vault-writer.{}", hex_32().chars().take(36).collect::<String>());
        let writers = vec![crate::wire::account::AccountManagedVaultWriterKey {
            key_id: candidate.material.writer.key_id.clone(),
            algorithm: "Ed25519".into(),
            public_key: candidate.material.writer.public_key.clone(),
        }];
        let recovery_verifier = crate::wire::account::AccountManagedVaultWriterKey {
            key_id: candidate.material.signing.key_id.clone(),
            algorithm: "Ed25519".into(),
            public_key: candidate.material.signing.public_key.clone(),
        };
        let request_digest = crate::b64::b64u_encode(
            &Sha256::digest(
                canonical_account_vault_writer_rotation_input(
                    &operation_id,
                    &candidate.vault_id,
                    &writers,
                    &recovery_verifier,
                )
                .as_bytes(),
            )[..],
        );
        let mut device_proof = AccountDeviceAuthorityProof {
            purpose: "prepare_vault_writer_rotation".into(),
            tenant_id: connection.tenant_id.clone(),
            route_id: connection.route_id.clone(),
            device_id: connection.device_id.clone(),
            nonce: format!(
                "entry-device.{}",
                crate::b64::b64u_encode(&crate::keys::random_bytes(24))
            ),
            bootstrap_id: None,
            endpoint_pin_ref: None,
            claim_id: None,
            permit_id: None,
            operation_id: Some(operation_id.clone()),
            request_digest: Some(request_digest),
            peer_device_id: None,
            target_digest: None,
            signature: String::new(),
        };
        device_proof.signature = crate::b64::b64u_encode(
            &entry_key
                .sign(account_device_authority_transcript(&device_proof).as_bytes()),
        );
        let (client_public_key, signer) = self.account_signer()?;
        let desktop_body = json!({
            "operationId": operation_id,
            "vaultId": candidate.vault_id,
            "writers": writers,
            "recoveryVerifier": recovery_verifier,
            "deviceProof": device_proof,
        });
        let desktop_proof = sign_desktop_account_proof(
            ROUTE_DESKTOP_WRITER_PREPARE,
            &auth.account,
            &auth.credential,
            &client_public_key,
            &desktop_body,
            None,
            &signer,
        );
        let mut prepare_request = desktop_body.clone();
        prepare_request
            .as_object_mut()
            .unwrap()
            .insert("desktopProof".into(), desktop_proof.to_json());
        let pending = PendingVaultWriter {
            operation_id: operation_id.clone(),
            connection_id: connection.connection_id.clone(),
            vault_id: candidate.vault_id.clone(),
            candidate_key_id: candidate.key_id.clone(),
            generation: candidate.generation,
            material_ref,
            flow_ref,
            state: "prepare_pending".into(),
            flow: VaultWriterFlow {
                account: auth.account.clone(),
                prepare_request: Some(prepare_request),
                target: None,
                expires_at: None,
                browser_transaction: None,
                complete_request: None,
            },
        };
        // identity was only needed to assert custody presence; unused beyond.
        let _ = identity;
        self.persist_vault_writer_rotation(&pending)?;
        *self.pending_vault_writer.lock().unwrap() = Some(pending.clone());
        *self.pending_recovery.lock().unwrap() = None;
        self.submit_vault_writer_prepare(&pending).await
    }

    async fn submit_vault_writer_prepare(&self, pending: &PendingVaultWriter) -> Result<()> {
        let request = pending.flow.prepare_request.clone().ok_or_else(|| {
            entry_error(
                "account_vault_rotation_invalid",
                "The exact pending prepare request is unavailable.",
            )
        })?;
        if request.get("operationId").and_then(|v| v.as_str()) != Some(pending.operation_id.as_str()) {
            return Err(entry_error(
                "account_vault_rotation_invalid",
                "The exact pending prepare request is unavailable.",
            ));
        }
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        let response = client.prepare_vault_writer_rotation(&request)?;
        self.assert_vault_writer_target(pending, &response)?;
        let target: AccountActionTarget = serde_json::from_value(
            response.get("target").cloned().unwrap_or(Value::Null),
        )
        .map_err(|_| {
            entry_error(
                "account_vault_rotation_invalid",
                "The account service returned an unparseable writer target.",
            )
        })?;
        let mut updated = pending.clone();
        updated.state = "authorization_required".into();
        updated.flow.prepare_request = None;
        updated.flow.target = Some(target);
        updated.flow.expires_at = response
            .get("expiresAt")
            .and_then(|v| v.as_str())
            .map(String::from);
        self.persist_vault_writer_rotation(&updated)?;
        *self.pending_vault_writer.lock().unwrap() = Some(updated.clone());
        self.start_vault_writer_step_up(&updated).await?;
        Ok(())
    }

    fn assert_vault_writer_target(&self, pending: &PendingVaultWriter, response: &Value) -> Result<()> {
        let connection = {
            let store = self.store.lock().unwrap();
            store
                .config()
                .connections
                .iter()
                .find(|c| c.connection_id == pending.connection_id)
                .cloned()
        }
        .ok_or_else(|| entry_error("connection_not_found", "The connection is not enrolled."))?;
        let material_bytes = self.custody.load_secret(&pending.material_ref)?.ok_or_else(|| {
            entry_error(
                "custody_unavailable",
                "The saved candidate keys are unavailable for exact target comparison.",
            )
        })?;
        let material = crate::recovery::crypto::deserialize_recovery_material(&material_bytes)?;
        let identity = device_identity_from_custody(&*self.custody, None, &connection.device_id)?;
        let expected_rotation = json!({
            "vaultId": pending.vault_id,
            "generation": pending.generation,
            "writers": [{
                "keyId": material.writer.key_id,
                "algorithm": "Ed25519",
                "publicKey": material.writer.public_key,
            }],
            "recoveryVerifier": {
                "keyId": material.signing.key_id,
                "algorithm": "Ed25519",
                "publicKey": material.signing.public_key,
            },
        });
        let account_ok = response
            .get("account")
            .and_then(|v| serde_json::from_value::<AccountAuthorityBinding>(v.clone()).ok())
            .is_some_and(|a| {
                a.account_id == pending.flow.account.account_id
                    && a.auth_epoch == pending.flow.account.auth_epoch
            });
        let target = response.get("target");
        let target_rotation = target.and_then(|t| t.get("vaultWriterRotation"));
        let ok = response.get("operationId").and_then(|v| v.as_str()) == Some(pending.operation_id.as_str())
            && account_ok
            && target.and_then(|t| t.get("tenantId")).and_then(|v| v.as_str()) == Some(connection.tenant_id.as_str())
            && target.and_then(|t| t.get("routeId")).and_then(|v| v.as_str()) == Some(connection.route_id.as_str())
            && target.and_then(|t| t.get("deviceId")).and_then(|v| v.as_str()) == Some(connection.device_id.as_str())
            && identity
                .as_ref()
                .is_some_and(|i| {
                    target.and_then(|t| t.get("devicePublicKey")).and_then(|v| v.as_str())
                        == Some(i.public_key.as_str())
                })
            && target_rotation.is_some()
            && crate::canonical::canonical_json(target_rotation.unwrap())
                == crate::canonical::canonical_json(&expected_rotation);
        if !ok {
            return Err(entry_error(
                "account_vault_rotation_invalid",
                "The account service returned a writer target outside this exact vault and Entry device operation.",
            ));
        }
        Ok(())
    }

    /// `startVaultWriterStepUp` — create the grant_access browser
    /// transaction and persist it into the custody-held flow.
    async fn start_vault_writer_step_up(&self, pending: &PendingVaultWriter) -> Result<DesktopAccountTransaction> {
        let target = pending.flow.target.clone().ok_or_else(|| {
            entry_error(
                "grant_target_expired",
                "The account writer target expired; retry registration to prepare a new target.",
            )
        })?;
        if pending
            .flow
            .expires_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .is_none_or(|d| d.timestamp_millis() <= now_ms())
        {
            return Err(entry_error(
                "grant_target_expired",
                "The account writer target expired; retry registration to prepare a new target.",
            ));
        }
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        let (auth, _credential_ref) = self.desktop_auth()?;
        let (client_public_key, signer) = self.account_signer()?;
        let transaction = client.create_transaction(
            "step_up",
            &client_public_key,
            Some(&target),
            Some("grant_access"),
            None,
            None,
            Some((&auth, &signer as &dyn Fn(&[u8]) -> Vec<u8>)),
        )?;
        let mut updated = pending.clone();
        updated.flow.browser_transaction = Some(transaction.clone());
        updated.state = "authorization_required".into();
        self.persist_vault_writer_rotation(&updated)?;
        *self.pending_vault_writer.lock().unwrap() = Some(updated);
        Ok(transaction)
    }

    /// Poll the in-flight writer step-up; on a complete permit, build and
    /// submit the completion request — the caller-visible state stays honest.
    pub async fn poll_vault_writer_step_up(&self) -> Result<VaultWriterStepUpPoll> {
        let pending = self.pending_vault_writer.lock().unwrap().clone();
        let Some(pending) = pending else {
            return Ok(VaultWriterStepUpPoll::Idle);
        };
        let Some(transaction) = pending.flow.browser_transaction.clone() else {
            return Ok(VaultWriterStepUpPoll::Idle);
        };
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        match client.poll_transaction(&transaction.transaction_id, &transaction.verifier)? {
            TransactionPoll::Pending => Ok(VaultWriterStepUpPoll::Pending {
                browser_url: transaction.browser_url.clone(),
                user_code: transaction.user_code.clone(),
            }),
            TransactionPoll::Expired => Ok(VaultWriterStepUpPoll::Expired),
            TransactionPoll::Consumed => Ok(VaultWriterStepUpPoll::Consumed),
            TransactionPoll::Complete {
                account,
                purpose,
                permit_id,
                action_purpose,
                target,
                ..
            } => {
                let mismatch = || {
                    entry_error(
                        "account_step_up_mismatch",
                        "The fresh factor permit does not match the exact vault writer target.",
                    )
                };
                if purpose != "step_up" || action_purpose.as_deref() != Some("grant_access") {
                    return Err(mismatch());
                }
                let permit_id = permit_id.ok_or_else(mismatch)?;
                let target = target.ok_or_else(mismatch)?;
                let stored_target = pending.flow.target.clone().ok_or_else(mismatch)?;
                if account.account_id != pending.flow.account.account_id
                    || account.auth_epoch != pending.flow.account.auth_epoch
                    || canonical_account_action_target(&target)
                        != canonical_account_action_target(&stored_target)
                {
                    return Err(mismatch());
                }
                self.complete_vault_writer_rotation(&pending, &permit_id).await?;
                Ok(VaultWriterStepUpPoll::Complete)
            }
        }
    }

    /// `#completeVaultWriterRotation` — build the exact completion request
    /// once the fresh-factor permit landed, then submit it.
    async fn complete_vault_writer_rotation(
        &self,
        pending: &PendingVaultWriter,
        permit_id: &str,
    ) -> Result<()> {
        let mut pending = pending.clone();
        if pending.flow.complete_request.is_none() {
            let connection = {
                let store = self.store.lock().unwrap();
                store
                    .config()
                    .connections
                    .iter()
                    .find(|c| c.connection_id == pending.connection_id)
                    .cloned()
            }
            .ok_or_else(|| entry_error("connection_not_found", "The connection is not enrolled."))?;
            if connection.re_pair_required || connection.account_binding.is_none() {
                return Err(entry_error(
                    "account_repair_required",
                    "The paired Entry device was revoked before writer registration completed.",
                ));
            }
            let entry_key = load_device_keypair(&*self.custody, None, &connection.device_id)?
                .ok_or_else(|| {
                    entry_error(
                        "custody_unavailable",
                        "A required account or Entry signing key is unavailable in OS custody.",
                    )
                })?;
            let (client_public_key, signer) = self.account_signer()?;
            let target = pending.flow.target.clone().ok_or_else(|| {
                entry_error("account_vault_rotation_invalid", "The stored writer target is missing.")
            })?;
            let target_digest = crate::b64::b64u_encode(
                &Sha256::digest(canonical_account_action_target(&target).as_bytes())[..],
            );
            let mut device_proof = AccountDeviceAuthorityProof {
                purpose: "complete_vault_writer_rotation".into(),
                tenant_id: connection.tenant_id.clone(),
                route_id: connection.route_id.clone(),
                device_id: connection.device_id.clone(),
                nonce: format!(
                    "entry-device.{}",
                    crate::b64::b64u_encode(&crate::keys::random_bytes(24))
                ),
                bootstrap_id: None,
                endpoint_pin_ref: None,
                claim_id: None,
                permit_id: Some(permit_id.to_string()),
                operation_id: Some(pending.operation_id.clone()),
                request_digest: None,
                peer_device_id: None,
                target_digest: Some(target_digest),
                signature: String::new(),
            };
            device_proof.signature = crate::b64::b64u_encode(
                &entry_key
                    .sign(account_device_authority_transcript(&device_proof).as_bytes()),
            );
            let (auth, _credential_ref) = self.desktop_auth()?;
            let desktop_body = json!({
                "operationId": pending.operation_id,
                "permitId": permit_id,
                "target": target,
                "keyCustodyConfirmed": true,
                "deviceProof": device_proof,
            });
            let desktop_proof = sign_desktop_account_proof(
                ROUTE_DESKTOP_WRITER_COMPLETE,
                &auth.account,
                &auth.credential,
                &client_public_key,
                &desktop_body,
                None,
                &signer,
            );
            let mut complete_request = desktop_body.clone();
            complete_request
                .as_object_mut()
                .unwrap()
                .insert("desktopProof".into(), desktop_proof.to_json());
            pending.flow.complete_request = Some(complete_request);
            pending.state = "completion_pending".into();
            self.persist_vault_writer_rotation(&pending)?;
            *self.pending_vault_writer.lock().unwrap() = Some(pending.clone());
        }
        self.submit_vault_writer_completion(&pending).await
    }

    async fn submit_vault_writer_completion(&self, pending: &PendingVaultWriter) -> Result<()> {
        let request = pending.flow.complete_request.clone().ok_or_else(|| {
            entry_error(
                "account_vault_rotation_invalid",
                "The exact completion request is unavailable for retry.",
            )
        })?;
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        let response = client.complete_vault_writer_rotation(&request)?;
        let account_ok = response
            .get("account")
            .and_then(|v| serde_json::from_value::<AccountAuthorityBinding>(v.clone()).ok())
            .is_some_and(|a| {
                a.account_id == pending.flow.account.account_id
                    && a.auth_epoch == pending.flow.account.auth_epoch
            });
        if !account_ok
            || response.get("vaultId").and_then(|v| v.as_str()) != Some(pending.vault_id.as_str())
            || response.get("generation").and_then(|v| v.as_u64()) != Some(pending.generation)
        {
            return Err(entry_error(
                "account_vault_rotation_invalid",
                "The writer rotation result does not match its stored account target.",
            ));
        }
        if response.get("state").and_then(|v| v.as_str()) == Some("pending") {
            let mut updated = pending.clone();
            updated.state = "completion_pending".into();
            updated.flow.browser_transaction = None;
            self.persist_vault_writer_rotation(&updated)?;
            *self.pending_vault_writer.lock().unwrap() = Some(updated);
            self.ack_vault_writer_transaction(pending);
            return Ok(());
        }
        let material_bytes = self.custody.load_secret(&pending.material_ref)?.ok_or_else(|| {
            entry_error(
                "custody_unavailable",
                "The newly saved recovery keys are missing from OS custody; the old vault snapshot remains fenced.",
            )
        })?;
        let material = crate::recovery::crypto::deserialize_recovery_material(&material_bytes)?;
        if material.signing.key_id != pending.candidate_key_id
            || Some(material.writer.key_id.as_str())
                != pending
                    .flow
                    .target
                    .as_ref()
                    .and_then(|t| t.vault_writer_rotation.as_ref())
                    .and_then(|r| r.get("writers"))
                    .and_then(|w| w.as_array())
                    .and_then(|a| a.first())
                    .and_then(|w| w.get("keyId"))
                    .and_then(|v| v.as_str())
        {
            return Err(entry_error(
                "account_vault_rotation_invalid",
                "The saved local keys no longer match the approved public writer target.",
            ));
        }
        let prior = {
            let store = self.store.lock().unwrap();
            store.config().recovery.clone()
        };
        let retained: Vec<String> = if prior.as_ref().is_some_and(|p| p.vault_id == pending.vault_id)
        {
            let mut refs: Vec<String> = prior
                .as_ref()
                .map(|p| p.retained_material_refs.clone())
                .unwrap_or_default();
            if let Some(p) = &prior {
                if p.material_ref != pending.material_ref {
                    refs.push(p.material_ref.clone());
                }
            }
            refs.retain(|r| r != &pending.material_ref);
            refs.sort();
            refs.dedup();
            refs
        } else {
            Vec::new()
        };
        let snapshot_source = match &prior {
            Some(p) if p.vault_id != pending.vault_id => None,
            Some(p) if p.material_ref == pending.material_ref => p.snapshot_source_material_ref.clone(),
            Some(p) => Some(p.material_ref.clone()),
            None => None,
        };
        self.store.lock().unwrap().update(|c| {
            c.recovery = Some(StoredRecovery {
                vault_id: pending.vault_id.clone(),
                key_id: pending.candidate_key_id.clone(),
                generation: pending.generation,
                material_ref: pending.material_ref.clone(),
                confirmed_at: now_iso(),
                account_writer_state: "complete".into(),
                account_snapshot_state: "unverified".into(),
                snapshot_source_material_ref: snapshot_source,
                retained_material_refs: retained,
            });
        })?;
        *self.recovery_material.lock().unwrap() = Some(material.clone());
        self.ack_vault_writer_transaction(pending);
        let reconciliation = self
            .reconcile_account_vault_snapshot(pending, &material)
            .await?;
        if reconciliation == "complete" || reconciliation == "preserved" {
            self.clear_vault_writer_rotation()?;
        }
        Ok(())
    }

    /// `#reconcileAccountVaultSnapshot` — fetch the preserved encrypted
    /// snapshot with retained keys, merge and publish under the new writer.
    /// Returns complete | preserved | retry — fencing stays honest.
    async fn reconcile_account_vault_snapshot(
        &self,
        pending: &PendingVaultWriter,
        material: &crate::recovery::crypto::RecoveryMaterial,
    ) -> Result<&'static str> {
        let recovery = {
            let store = self.store.lock().unwrap();
            store.config().recovery.clone()
        }
        .filter(|r| r.vault_id == pending.vault_id)
        .ok_or_else(|| {
            entry_error(
                "account_vault_rotation_invalid",
                "The registered vault no longer matches the pending writer operation.",
            )
        })?;
        let mut synchronizer = self.synchronizer()?;
        let candidate_refs: Vec<String> = {
            let mut v: Vec<String> = Vec::new();
            if let Some(r) = &recovery.snapshot_source_material_ref {
                if r != &recovery.material_ref {
                    v.push(r.clone());
                }
            }
            for r in &recovery.retained_material_refs {
                if r != &recovery.material_ref {
                    v.push(r.clone());
                }
            }
            v.sort();
            v.dedup();
            v
        };
        let mut prior_materials: Vec<crate::recovery::crypto::RecoveryMaterial> = Vec::new();
        for reference in &candidate_refs {
            let Ok(Some(stored)) = self.custody.load_secret(reference).map_err(|_| ()) else {
                continue;
            };
            if let Ok(m) = crate::recovery::crypto::deserialize_recovery_material(&stored) {
                prior_materials.push(m);
            }
        }
        let fetched = synchronizer.fetch_snapshot(
            &recovery.vault_id,
            material,
            Some(&material.signing),
            &prior_materials,
            true,
        )?;
        match fetched {
            crate::recovery::sync::SyncFetchOutcome::Snapshot {
                bundle,
                revision,
                generation,
                ..
            } => {
                let published = synchronizer.publish(
                    &recovery.vault_id,
                    &self.build_bundle()?,
                    material,
                    recovery.generation,
                    Some((&bundle, revision, generation)),
                    &prior_materials,
                )?;
                match published {
                    crate::recovery::sync::PublishOutcome::Committed { .. } => {
                        self.store.lock().unwrap().update(|c| {
                            if let Some(r) = c.recovery.as_mut() {
                                if r.vault_id == recovery.vault_id {
                                    r.account_snapshot_state = "ready".into();
                                    r.snapshot_source_material_ref = None;
                                }
                            }
                        })?;
                        Ok("complete")
                    }
                    crate::recovery::sync::PublishOutcome::ConflictUndecryptable { .. } => {
                        self.persist_older_snapshot_fence(
                            pending,
                            recovery.snapshot_source_material_ref.clone(),
                            "The vault changed during reconciliation and the latest encrypted snapshot could not be verified. Publishing remains fenced.",
                        )?;
                        Ok("retry")
                    }
                    crate::recovery::sync::PublishOutcome::Refused { retryable: true } => {
                        Ok("retry")
                    }
                    _ => Err(entry_error(
                        "vault_transport_error",
                        "The preserved snapshot could not be reconciled; publishing remains fenced.",
                    )),
                }
            }
            crate::recovery::sync::SyncFetchOutcome::AuthorityMismatch
            | crate::recovery::sync::SyncFetchOutcome::DecryptFailed => {
                self.persist_older_snapshot_fence(
                    pending,
                    recovery.snapshot_source_material_ref.clone(),
                    "The previous encrypted snapshot is preserved, but none of the retained local keys can decrypt it. New publishing is fenced to protect that data.",
                )?;
                Ok("preserved")
            }
            crate::recovery::sync::SyncFetchOutcome::Refused { refusal, .. }
                if refusal == "not_found"
                    && recovery.snapshot_source_material_ref.is_none()
                    && recovery.retained_material_refs.is_empty()
                    && synchronizer.committed_revision() == 0 =>
            {
                let published = synchronizer.publish(
                    &recovery.vault_id,
                    &self.build_bundle()?,
                    material,
                    recovery.generation,
                    None,
                    &[],
                )?;
                match published {
                    crate::recovery::sync::PublishOutcome::Committed { .. } => {
                        self.store.lock().unwrap().update(|c| {
                            if let Some(r) = c.recovery.as_mut() {
                                if r.vault_id == recovery.vault_id {
                                    r.account_snapshot_state = "ready".into();
                                    r.snapshot_source_material_ref = None;
                                }
                            }
                        })?;
                        Ok("complete")
                    }
                    _ => Err(entry_error(
                        "vault_transport_error",
                        "The new account vault's first snapshot could not be published.",
                    )),
                }
            }
            crate::recovery::sync::SyncFetchOutcome::Stale { .. } => Err(entry_error(
                "snapshot_stale",
                "The vault returned a snapshot older than Entry's durable revision history; publishing remains fenced.",
            )),
            crate::recovery::sync::SyncFetchOutcome::Refused { refusal, .. } => Err(entry_error(
                "vault_refused",
                format!(
                    "The current vault snapshot could not be fetched ({refusal}); publishing remains fenced."
                ),
            )),
            _ => Err(entry_error(
                "vault_unexpected_response",
                "The current vault snapshot could not be verified; publishing remains fenced.",
            )),
        }
    }

    fn persist_older_snapshot_fence(
        &self,
        pending: &PendingVaultWriter,
        source_material_ref: Option<String>,
        _detail: &str,
    ) -> Result<()> {
        self.store.lock().unwrap().update(|c| {
            if let Some(r) = c.recovery.as_mut() {
                if r.vault_id == pending.vault_id {
                    r.account_snapshot_state = "older_snapshot_preserved".into();
                    r.snapshot_source_material_ref = source_material_ref;
                }
            }
            c.account_vault_writer_operation = None;
        })?;
        let _ = self.custody.delete_secret(&pending.flow_ref);
        *self.pending_vault_writer.lock().unwrap() = None;
        Ok(())
    }

    fn ack_vault_writer_transaction(&self, pending: &PendingVaultWriter) {
        if let Some(transaction) = &pending.flow.browser_transaction {
            if let Some(client) = &self.account_client {
                let _ = client.acknowledge_transaction(&transaction.transaction_id, &transaction.verifier);
            }
        }
    }

    fn persist_vault_writer_rotation(&self, pending: &PendingVaultWriter) -> Result<()> {
        self.custody.store_secret(
            &pending.flow_ref,
            &serde_json::to_vec(&pending.flow).map_err(|e| {
                entry_error("account_vault_rotation_invalid", "The writer flow could not be serialized.").caused_by(e)
            })?,
        )?;
        self.store.lock().unwrap().update(|c| {
            c.account_vault_writer_operation = Some(StoredVaultWriterOperation {
                operation_id: pending.operation_id.clone(),
                connection_id: pending.connection_id.clone(),
                vault_id: pending.vault_id.clone(),
                candidate_key_id: pending.candidate_key_id.clone(),
                generation: pending.generation,
                material_ref: pending.material_ref.clone(),
                flow_ref: pending.flow_ref.clone(),
                state: pending.state.clone(),
            });
        })
    }

    /// `restoreVaultWriterRotation` — resume a persisted writer operation
    /// after restart; a missing/undecryptable flow blob abandons honestly.
    pub fn restore_vault_writer_rotation(&self) -> Result<()> {
        let stored = {
            let store = self.store.lock().unwrap();
            store.config().account_vault_writer_operation.clone()
        };
        let Some(stored) = stored else { return Ok(()) };
        let Some(bytes) = self.custody.load_secret(&stored.flow_ref)? else {
            return Ok(());
        };
        let flow: VaultWriterFlow = match serde_json::from_slice(&bytes) {
            Ok(f) => f,
            Err(_) => return Ok(()),
        };
        if flow
            .prepare_request
            .as_ref()
            .is_some_and(|r| r.get("operationId").and_then(|v| v.as_str()) != Some(stored.operation_id.as_str()))
            || flow
                .complete_request
                .as_ref()
                .is_some_and(|r| {
                    r.get("operationId").and_then(|v| v.as_str()) != Some(stored.operation_id.as_str())
                        || r.get("keyCustodyConfirmed") != Some(&Value::Bool(true))
                })
        {
            return Ok(());
        }
        *self.pending_vault_writer.lock().unwrap() = Some(PendingVaultWriter {
            operation_id: stored.operation_id,
            connection_id: stored.connection_id,
            vault_id: stored.vault_id,
            candidate_key_id: stored.candidate_key_id,
            generation: stored.generation,
            material_ref: stored.material_ref,
            flow_ref: stored.flow_ref,
            state: stored.state,
            flow,
        });
        Ok(())
    }

    fn clear_vault_writer_rotation(&self) -> Result<()> {
        let pending = self.pending_vault_writer.lock().unwrap().take();
        let Some(pending) = pending else { return Ok(()) };
        self.store
            .lock()
            .unwrap()
            .update(|c| c.account_vault_writer_operation = None)?;
        let _ = self.custody.delete_secret(&pending.flow_ref);
        Ok(())
    }

    /// `retryVaultWriterRegistration` — resume whichever phase the durable
    /// record reached; the exact stored request is replayed, never rebuilt.
    pub async fn retry_vault_writer_registration(&self) -> Result<Value> {
        let pending = self.pending_vault_writer.lock().unwrap().clone().ok_or_else(|| {
            entry_error(
                "account_vault_rotation_invalid",
                "No account vault writer registration is waiting.",
            )
        })?;
        if pending.flow.complete_request.is_some() {
            self.submit_vault_writer_completion(&pending).await?;
            return Ok(self.recovery_view());
        }
        if pending.flow.prepare_request.is_some() {
            self.submit_vault_writer_prepare(&pending).await?;
            return Ok(self.recovery_view());
        }
        if pending.flow.target.is_none() {
            return Err(entry_error(
                "account_vault_rotation_invalid",
                "The account service has not returned a writer target yet.",
            ));
        }
        if pending.flow.browser_transaction.is_none() {
            self.start_vault_writer_step_up(&pending).await?;
        }
        Ok(self.recovery_view())
    }

    /* ------------------------------ publish --------------------------- */

    /// `publishSnapshot` — one bounded publication attempt of the current
    /// configuration bundle under the active writer.
    pub async fn publish_snapshot(&self) -> Result<Value> {
        let (recovery, material) = {
            let store = self.store.lock().unwrap();
            let recovery = store.config().recovery.clone();
            (recovery, self.recovery_material())
        };
        let Some(recovery) = recovery else {
            return Ok(self.recovery_view());
        };
        let Some(material) = material else {
            return Ok(self.recovery_view());
        };
        {
            let store = self.store.lock().unwrap();
            if store.config().account_vault_writer_operation.is_some()
                || recovery.account_writer_state == "pending"
            {
                self.store.lock().unwrap().update(|c| {
                    if let Some(j) = c.journal.as_mut() {
                        j.last_error = Some(
                            "Account-managed writer registration is pending; the existing encrypted snapshot is preserved and publishing is fenced.".into(),
                        );
                    }
                })?;
                return Ok(self.recovery_view());
            }
        }
        if self.is_account_managed_vault(&recovery.vault_id) {
            let active = self.account_managed_connection(&recovery.vault_id);
            if active.is_none() || recovery.account_writer_state != "complete" {
                return Err(entry_error(
                    "account_repair_required",
                    "Account recovery revoked the previous vault writer. Re-pair this device and explicitly register new keys before publishing.",
                ));
            }
            if recovery.account_snapshot_state != "ready" {
                let detail = if recovery.account_snapshot_state == "older_snapshot_preserved" {
                    "The older encrypted snapshot is preserved. Entry cannot verify it with retained local keys, so publishing remains fenced."
                } else {
                    "The new writer is registered, but the existing snapshot has not been reconciled yet; publishing remains fenced."
                };
                return Err(entry_error("vault_refused", detail));
            }
        }
        let bundle = self.build_bundle()?;
        let mut synchronizer = self.synchronizer()?;
        let outcome = synchronizer.publish(
            &recovery.vault_id,
            &bundle,
            &material,
            recovery.generation,
            None,
            &[],
        )?;
        match outcome {
            crate::recovery::sync::PublishOutcome::Committed { .. } => Ok(self.recovery_view()),
            crate::recovery::sync::PublishOutcome::ConflictUndecryptable { current_revision } => {
                if recovery.account_writer_state == "complete" {
                    self.store.lock().unwrap().update(|c| {
                        if let Some(r) = c.recovery.as_mut() {
                            if r.vault_id == recovery.vault_id {
                                r.account_snapshot_state = "older_snapshot_preserved".into();
                            }
                        }
                    })?;
                }
                Err(entry_error(
                    "vault_transport_error",
                    format!("The vault write conflicted at revision {current_revision} and the remote snapshot could not be verified."),
                ))
            }
            crate::recovery::sync::PublishOutcome::ConflictUnresolved { current_revision } => {
                Err(entry_error(
                    "vault_transport_error",
                    format!("The vault write conflicted at revision {current_revision} and could not be reconciled."),
                ))
            }
            crate::recovery::sync::PublishOutcome::Superseded { generation } => Err(entry_error(
                "snapshot_stale",
                format!("Snapshot generation superseded (vault at generation {generation})."),
            )),
            crate::recovery::sync::PublishOutcome::Refused { retryable } => Err(entry_error(
                "vault_refused",
                if retryable {
                    "The vault refused the write; capacity may recover — retry publishing."
                } else {
                    "The vault refused the snapshot write."
                },
            )),
            crate::recovery::sync::PublishOutcome::InvalidResponse => Err(entry_error(
                "vault_unexpected_response",
                "The vault returned an unverifiable write result.",
            )),
        }
    }

    /* --------------------------- rotation ----------------------------- */

    fn open_rotation(&self) -> Option<StoredRotation> {
        self.rotation_manager()
            .load_all()
            .into_iter()
            .filter(|r| r.state != "completed" && r.state != "aborted")
            .max_by_key(|r| r.started_at.clone())
    }

    /// `beginRecoveryRotation` — managed vaults rotate through the account
    /// authority (writer registration); unmanaged vaults stage a per-endpoint
    /// `rotation-begin` exchange on dedicated recovery channels.
    pub async fn begin_recovery_rotation(&self) -> Result<Value> {
        self.discard_expired_recovery_candidate();
        let (recovery, material) = {
            let store = self.store.lock().unwrap();
            (store.config().recovery.clone(), self.recovery_material())
        };
        let (Some(recovery), Some(material)) = (recovery, material) else {
            return Err(entry_error(
                "recovery_state_invalid",
                "No active recovery key to rotate.",
            ));
        };
        if self.pending_recovery.lock().unwrap().is_some() {
            return Err(entry_error(
                "recovery_state_invalid",
                "A recovery key candidate is already awaiting save confirmation; cancel it before generating another.",
            ));
        }
        if self.is_account_managed_vault(&recovery.vault_id) {
            if self.pending_vault_writer.lock().unwrap().is_some()
                || self
                    .store
                    .lock()
                    .unwrap()
                    .config()
                    .account_vault_writer_operation
                    .is_some()
            {
                return Err(entry_error(
                    "account_transaction_pending",
                    "Finish the existing vault writer registration before generating another key.",
                ));
            }
            let connection = self
                .account_managed_connection(&recovery.vault_id)
                .ok_or_else(|| {
                    entry_error(
                        "account_repair_required",
                        "Re-pair a device under the current account epoch before re-enrolling this vault.",
                    )
                })?;
            let key = crate::recovery::key::generate_recovery_key(Some(recovery.vault_id.clone()))?;
            let candidate = crate::recovery::crypto::derive_recovery_material(&key.secret)?;
            let pending = PendingRecoverySecret {
                recovery_text: crate::recovery::key::format_recovery_text(&key)?,
                material: candidate.clone(),
                vault_id: recovery.vault_id.clone(),
                key_id: candidate.signing.key_id.clone(),
                generation: recovery.generation + 1,
                rotation_id: None,
                revealed: false,
                expires_at_ms: now_ms() + MAX_RECOVERY_SECRET_WINDOW_MS,
            };
            *self.pending_recovery.lock().unwrap() = Some(pending);
            let _ = connection;
            return Ok(json!({
                "state": "awaiting_save",
                "vaultId": recovery.vault_id,
                "keyId": candidate.signing.key_id,
                "generation": recovery.generation + 1,
            }));
        }
        let connections = {
            let store = self.store.lock().unwrap();
            store.config().connections.clone()
        };
        if connections.is_empty() {
            return Err(entry_error(
                "recovery_state_invalid",
                "Rotation needs at least one enrolled endpoint.",
            ));
        }
        let principal_ref = connections[0].endpoint_principal_ref.clone();
        let staged = self.rotation_manager().begin(
            &material,
            recovery.generation,
            &principal_ref,
            &recovery.vault_id,
            &connections.iter().map(|c| c.route_id.clone()).collect::<Vec<_>>(),
            None,
        )?;
        *self.pending_recovery.lock().unwrap() = Some(PendingRecoverySecret {
            recovery_text: crate::recovery::key::format_recovery_text(&staged.candidate)?,
            material: crate::recovery::crypto::derive_recovery_material(&staged.candidate.secret)?,
            vault_id: recovery.vault_id.clone(),
            key_id: staged.rotation.candidate_key_id.clone(),
            generation: staged.rotation.candidate_generation,
            rotation_id: Some(staged.rotation.rotation_id.clone()),
            revealed: false,
            expires_at_ms: now_ms() + MAX_RECOVERY_SECRET_WINDOW_MS,
        });
        // Deliver rotation-begin per endpoint on a dedicated recovery channel.
        for outbound in &staged.rotation.outbound {
            let Some(stored) = connections
                .iter()
                .find(|c| c.route_id == outbound.endpoint_route_id)
                .cloned()
            else {
                let _ = self.rotation_manager().mark_endpoint(
                    &staged.rotation.rotation_id,
                    &outbound.endpoint_route_id,
                    "unreachable",
                );
                continue;
            };
            self.deliver_rotation_message(
                &staged.rotation.rotation_id,
                &stored,
                &outbound.message,
            )
            .await;
        }
        Ok(self.recovery_view())
    }

    /// `#deliverRotationMessage` — one `rotation-begin` to one endpoint on a
    /// dedicated recovery channel; the reply settles the per-endpoint state.
    async fn deliver_rotation_message(
        &self,
        rotation_id: &str,
        stored: &StoredConnection,
        message: &Value,
    ) {
        let outcome = async {
            let credential = recovery_bearer(&*self.custody, &stored.relay_credential_ref)?;
            let channel = crate::relay::recovery::EntryRecoveryChannel::connect(
                &stored.relay_service,
                &RelayAdmission {
                    tenant_id: stored.tenant_id.clone(),
                    route_id: stored.route_id.clone(),
                    device_id: stored.device_id.clone(),
                    role: "entry".into(),
                    mode: stored.mode.clone(),
                    admission_generation: stored.admission_generation,
                    revocation_revision: stored.revocation_revision,
                },
                &credential,
                self.config.allow_insecure_loopback,
            )
            .await?;
            let reply = channel.round_trip(message).await;
            channel.close();
            reply
        }
        .await;
        let mut manager = self.rotation_manager();
        match outcome {
            Ok(reply) => {
                let parsed = crate::wire::recovery::parse_rotation_state(&reply);
                if let Some(state) = parsed {
                    if state.acknowledged.iter().any(|r| r == &stored.route_id) {
                        let _ = manager.mark_endpoint(rotation_id, &stored.route_id, "acknowledged");
                    } else {
                        let _ = manager.mark_endpoint(rotation_id, &stored.route_id, "staged");
                    }
                }
                // Any other resolved shape is silence-equivalent: leave pending.
            }
            Err(_) => {
                let _ = manager.mark_endpoint(rotation_id, &stored.route_id, "unreachable");
            }
        }
    }

    /// `retryRotationDelivery` — re-deliver only the un-acknowledged
    /// endpoints; acknowledged ones are never replayed.
    pub async fn retry_rotation_delivery(&self) -> Result<Value> {
        let active = self.open_rotation().ok_or_else(|| {
            entry_error("rotation_state_invalid", "No rotation is in flight.")
        })?;
        let owed = self.rotation_manager().pending_outbound(&active.rotation_id)?;
        let connections = {
            let store = self.store.lock().unwrap();
            store.config().connections.clone()
        };
        for target in owed {
            let stored = connections
                .iter()
                .find(|c| c.route_id == target.endpoint_route_id)
                .cloned();
            match stored {
                Some(stored) => {
                    self.deliver_rotation_message(
                        &active.rotation_id,
                        &stored,
                        &target.message,
                    )
                    .await;
                }
                None => {
                    let _ = self.rotation_manager().mark_endpoint(
                        &active.rotation_id,
                        &target.endpoint_route_id,
                        "unreachable",
                    );
                }
            }
        }
        Ok(self.recovery_view())
    }

    /// Abort the in-flight rotation for this install — endpoints keep the
    /// incumbent key; the candidate secret is dropped.
    pub fn abort_rotation(&self) -> Result<Value> {
        let active = self.open_rotation().ok_or_else(|| {
            entry_error("rotation_state_invalid", "No rotation is in flight.")
        })?;
        self.rotation_manager().abort(&active.rotation_id)?;
        // A pending candidate bound to this rotation dies with it.
        let bound = self
            .pending_recovery
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|p| p.rotation_id.as_deref() == Some(active.rotation_id.as_str()));
        if bound {
            *self.pending_recovery.lock().unwrap() = None;
        }
        Ok(self.recovery_view())
    }
}


// ---------------------------------------------------------------------------
// Fresh-profile import — `importRecoveryText`. The recovery text alone is the
// input: vault locator → fresh-device credential (endpoint provisioning seam)
// → recovery channel → snapshot fetch/decrypt → challenge/proof enrollment →
// durable connection + recovery state.
// ---------------------------------------------------------------------------

/// Outcome of `import_recovery_text` — mirrors the `recoveryImport.phase`
/// event surface in the reference client.
#[derive(Debug, Clone)]
pub enum RecoveryImportPhase {
    Enrolled {
        connection_id: String,
        vault_id: String,
        key_id: String,
        generation: u64,
    },
    Refused {
        refusal: String,
    },
    SnapshotMissing,
    SnapshotUnusable {
        reason: String,
    },
}

impl EntryService {
    /// Import a fresh profile from a recovery text. `service_url` overrides
    /// the default pairing/relay service; the access provisioner is the
    /// optional endpoint-admin seam — absent surfaces report unreachable.
    pub async fn import_recovery_text(
        &self,
        recovery_text: &str,
        service_url: Option<&str>,
        provisioner: Option<&dyn crate::recovery::service::RecoveryAccessPort>,
    ) -> Result<RecoveryImportPhase> {
        let parsed = crate::recovery::key::parse_recovery_text(recovery_text)?;
        if parsed.vault_id.is_empty() {
            return Err(entry_error(
                "recovery_locator_missing",
                "The recovery text carries no vault locator.",
            ));
        }
        let service_base = service_url
            .map(str::to_string)
            .or_else(|| self.store.lock().unwrap().config().pairing_service_default.clone())
            .ok_or_else(|| {
                entry_error(
                    "recovery_locator_missing",
                    "Fresh-install recovery needs the endpoint service address (relay/vault base URL).",
                )
            })?;
        let Some(provisioner) = provisioner else {
            return Err(entry_error(
                "endpoint_unreachable",
                "The endpoint surface does not expose recovery access provisioning.",
            ));
        };
        let access = provisioner.provision(&parsed.vault_id).await?;
        let access = match access {
            crate::recovery::service::RecoveryAccessOutcome::Issued {
                device_id,
                relay_credential,
                tenant_id,
                route_id,
                admission_generation,
                revocation_revision,
            } => (
                device_id,
                relay_credential,
                tenant_id,
                route_id,
                admission_generation,
                revocation_revision,
            ),
            crate::recovery::service::RecoveryAccessOutcome::Refused { refusal } => {
                return Err(entry_error(
                    "endpoint_refused",
                    format!("Recovery access refused: {refusal}"),
                ));
            }
        };
        let (fresh_device_id, relay_credential, tenant_id, route_id, admission_generation, revocation_revision) =
            access;
        let admission = crate::wire::session::RelayAdmission {
            tenant_id: tenant_id.clone(),
            device_id: fresh_device_id.clone(),
            route_id: route_id.clone(),
            role: "entry".into(),
            mode: "personal".into(),
            admission_generation,
            revocation_revision,
        };
        let channel = crate::relay::recovery::EntryRecoveryChannel::connect(
            &service_base,
            &admission,
            &relay_credential,
            self.config.allow_insecure_loopback,
        )
        .await?;
        let outcome = {
            let endpoint =
                crate::recovery::service::RecoveryChannelEndpoint::new(&channel);
            let vault = crate::recovery::vault::RecoveryVaultClient::new(
                crate::recovery::vault::HttpsVaultTransport::new(&service_base)?,
            );
            let mut synchronizer = crate::recovery::sync::SnapshotSynchronizer::new(
                vault,
                crate::recovery::sync::InMemorySnapshotJournal::new(),
            );
            let mut service =
                crate::recovery::service::EntryRecoveryService::new(&mut synchronizer, &endpoint);
            service
                .recover_fresh_profile(
                    recovery_text,
                    &*self.custody,
                    None,
                    Some(fresh_device_id.clone()),
                )
                .await
        };
        channel.close();
        use crate::recovery::service::FreshRecoveryOutcome;
        match outcome? {
            FreshRecoveryOutcome::Refused { refusal } => {
                Ok(RecoveryImportPhase::Refused { refusal })
            }
            FreshRecoveryOutcome::SnapshotMissing => Ok(RecoveryImportPhase::SnapshotMissing),
            FreshRecoveryOutcome::SnapshotUnusable { reason } => {
                Ok(RecoveryImportPhase::SnapshotUnusable { reason })
            }
            FreshRecoveryOutcome::Enrolled {
                device,
                connection,
                admission_generation,
                generation,
                ..
            } => {
                let connection_id = format!(
                    "conn.{}",
                    device
                        .device_id
                        .to_lowercase()
                        .chars()
                        .map(|c| if c.is_ascii_alphanumeric() { c } else { '.' })
                        .collect::<String>()
                );
                let relay_credential_ref =
                    format!("entry.relay.credential.{}", generate_suffix());
                self.custody
                    .store_secret(&relay_credential_ref, relay_credential.as_bytes())?;
                let stored = StoredConnection {
                    connection_id: connection_id.clone(),
                    display_label: format!("{} @ {}", connection.principal_ref, connection.route_id),
                    tenant_id: connection.tenant_id.clone(),
                    route_id: connection.route_id.clone(),
                    mode: connection.mode.clone(),
                    endpoint_principal_ref: connection.principal_ref.clone(),
                    endpoint_device_id: None,
                    endpoint_peer_identity: None,
                    endpoint_spki_pin: connection.endpoint_spki_pin.clone(),
                    relay_service: connection.relay_service.clone(),
                    vault_id: Some(connection.vault_id.clone()),
                    device_id: device.device_id.clone(),
                    device_fingerprint: device.fingerprint.clone(),
                    capability_grant_ref: "none".into(),
                    account_action_target: None,
                    relay_credential_ref,
                    bound_recovery_key_id: connection
                        .recovery_authority
                        .as_ref()
                        .map(|a| a.key_id.clone()),
                    pairing_service: Some(service_base.clone()),
                    admission_generation,
                    revocation_revision,
                    enrolled_at: chrono::Utc::now().to_rfc3339(),
                    remote_revocation: "none".into(),
                    route_revocation: None,
                    account_binding: None,
                    re_pair_required: false,
                    pairing_completion_checkpoint_ref: None,
                };
                let material =
                    crate::recovery::crypto::derive_recovery_material(&parsed.secret)?;
                let material_ref =
                    custody_recovery_key_ref(&connection.vault_id, &material.signing.key_id);
                self.custody.store_secret(
                    &material_ref,
                    &crate::recovery::crypto::serialize_recovery_material(&material),
                )?;
                *self.recovery_material.lock().unwrap() = Some(material.clone());
                let key_id = material.signing.key_id.clone();
                let vault_id = connection.vault_id.clone();
                let mut store = self.store.lock().unwrap();
                let stored_clone = stored.clone();
                store.update(|draft| {
                    draft.connections.retain(|e| e.connection_id != connection_id);
                    draft.connections.push(stored_clone);
                    draft.recovery = Some(StoredRecovery {
                        vault_id,
                        key_id,
                        generation,
                        material_ref,
                        confirmed_at: chrono::Utc::now().to_rfc3339(),
                        account_writer_state: "unmanaged".into(),
                        account_snapshot_state: "ready".into(),
                        snapshot_source_material_ref: None,
                        retained_material_refs: vec![],
                    });
                    if draft.pairing_service_default.is_none() {
                        draft.pairing_service_default = Some(service_base.clone());
                    }
                })?;
                Ok(RecoveryImportPhase::Enrolled {
                    connection_id,
                    vault_id: connection.vault_id.clone(),
                    key_id: material.signing.key_id.clone(),
                    generation,
                })
            }
        }
    }
}


// ---------------------------------------------------------------------------
// Grant catalog / grant access — `loadGrantCatalog`, `requestGrantAccess`,
// `#completeGrantAccess` in the reference client.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantView {
    pub connection_id: String,
    pub available_scopes: Vec<String>,
    pub target_scopes: Vec<String>,
    pub grant_ref: Option<String>,
    /// `catalog_ready` | `authorization_required` | `granted`
    pub status: String,
    pub notice: Option<String>,
}

#[derive(Debug)]
pub enum GrantPoll {
    Pending,
    Expired,
    Consumed,
    Granted(GrantView),
}

#[derive(Debug)]
struct PendingGrant {
    connection_id: String,
    operation_id: String,
    target: AccountActionTarget,
    expires_at: String,
}

fn is_scope_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .enumerate()
            .all(|(i, c)| c.is_ascii_alphanumeric() || (i > 0 && matches!(c, '.' | '_' | ':' | '/' | '-')))
}

fn grant_catalog_request() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": format!("grant.catalog.{}", generate_suffix()),
        "method": "meshrix/pairing/grant_catalog",
        "params": {},
    })
}

fn is_operation_id(value: &str) -> bool {
    value.len() >= 2
        && value.len() <= 127
        && value
            .chars()
            .enumerate()
            .all(|(i, c)| c.is_ascii_alphanumeric() || (i > 0 && matches!(c, '.' | '_' | ':' | '-')))
}

impl EntryService {
    fn grant_bound_connection(&self, connection_id: &str) -> Result<StoredConnection> {
        let connection = {
            let store = self.store.lock().unwrap();
            store
                .config()
                .connections
                .iter()
                .find(|c| c.connection_id == connection_id)
                .cloned()
        }
        .ok_or_else(|| entry_error("connection_not_found", "The connection is not enrolled."))?;
        if connection.re_pair_required
            || connection.account_binding.is_none()
            || connection.endpoint_device_id.is_none()
        {
            return Err(entry_error(
                "account_repair_required",
                "This connection is not an active account-bound enrollment; pair it again before changing grants.",
            ));
        }
        Ok(connection)
    }

    /// `loadGrantCatalog` — ask the endpoint which scopes it can grant.
    pub async fn load_grant_catalog(&self, connection_id: &str) -> Result<GrantView> {
        let connection = self.grant_bound_connection(connection_id)?;
        let current = self.desktop_auth()?.0;
        let binding = connection.account_binding.clone().unwrap();
        if binding.account_id != current.account.account_id
            || binding.auth_epoch != current.account.auth_epoch
        {
            return Err(entry_error(
                "account_binding_mismatch",
                "The signed-in account and endpoint enrollment do not match.",
            ));
        }
        let response = self.request(connection_id, grant_catalog_request()).await?;
        let available = response
            .get("availableScopes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let valid = response.get("outcome").and_then(|v| v.as_str()) == Some("grant_catalog")
            && response
                .get("account")
                .and_then(crate::wire::account::parse_binding)
                .map(|a| {
                    a.account_id == current.account.account_id
                        && a.auth_epoch == current.account.auth_epoch
                })
                .unwrap_or(false)
            && response.get("endpointDeviceId").and_then(|v| v.as_str())
                == connection.endpoint_device_id.as_deref()
            && !available.is_empty()
            || response.get("outcome").and_then(|v| v.as_str()) == Some("grant_catalog")
                && available.is_empty();
        let all_scopes = available.iter().filter_map(|v| v.as_str()).all(is_scope_name)
            && available.len() == available.iter().filter(|v| v.is_string()).count();
        if !valid || !all_scopes {
            return Err(entry_error(
                "grant_catalog_invalid",
                "The endpoint returned a catalog outside this account-bound route.",
            ));
        }
        let mut scopes: Vec<String> = available
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        scopes.sort();
        scopes.dedup();
        Ok(GrantView {
            connection_id: connection_id.to_string(),
            available_scopes: scopes,
            target_scopes: vec![],
            grant_ref: None,
            status: "catalog_ready".into(),
            notice: None,
        })
    }

    /// `requestGrantAccess` — validate scopes against the catalog, fetch the
    /// exact grant target, then start the `grant_access` step-up transaction.
    /// Returns the grant view plus the browser-approval transaction.
    pub async fn request_grant_access(
        &self,
        connection_id: &str,
        scopes: Vec<String>,
    ) -> Result<(GrantView, DesktopAccountTransaction)> {
        if self.pending_grant.lock().unwrap().is_some() {
            return Err(entry_error(
                "account_transaction_pending",
                "Finish the current account action before requesting another grant.",
            ));
        }
        let connection = self.grant_bound_connection(connection_id)?;
        let current = self.desktop_auth()?.0;
        let binding = connection.account_binding.clone().unwrap();
        if binding.account_id != current.account.account_id
            || binding.auth_epoch != current.account.auth_epoch
        {
            return Err(entry_error(
                "account_binding_mismatch",
                "The signed-in account and endpoint enrollment do not match.",
            ));
        }
        let mut scopes = scopes;
        scopes.sort();
        scopes.dedup();
        if scopes.is_empty() || scopes.iter().any(|s| !is_scope_name(s)) {
            return Err(entry_error(
                "grant_scope_invalid",
                "Choose one or more valid endpoint scopes.",
            ));
        }
        let catalog = self.request(connection_id, grant_catalog_request()).await?;
        let available: Vec<String> = catalog
            .get("availableScopes")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let catalog_ok = catalog.get("outcome").and_then(|v| v.as_str()) == Some("grant_catalog")
            && catalog
                .get("account")
                .and_then(crate::wire::account::parse_binding)
                .map(|a| {
                    a.account_id == current.account.account_id
                        && a.auth_epoch == current.account.auth_epoch
                })
                .unwrap_or(false)
            && catalog.get("endpointDeviceId").and_then(|v| v.as_str())
                == connection.endpoint_device_id.as_deref()
            && available.iter().all(|s| is_scope_name(s))
            && scopes.iter().all(|s| available.contains(s));
        if !catalog_ok {
            return Err(entry_error(
                "grant_scope_invalid",
                "The selected scope is not available on this endpoint.",
            ));
        }
        let answer = self
            .request(
                connection_id,
                json!({
                    "jsonrpc": "2.0",
                    "id": format!("grant.target.{}", generate_suffix()),
                    "method": "meshrix/pairing/grant_targets",
                    "params": { "scopes": scopes },
                }),
            )
            .await?;
        let target: Option<AccountActionTarget> = answer
            .get("target")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok());
        let target = target.ok_or_else(|| {
            entry_error(
                "grant_target_invalid",
                "The endpoint returned a grant target that does not match the selected route and scopes.",
            )
        })?;
        let expected_target = AccountActionTarget {
            tenant_id: connection.tenant_id.clone(),
            route_id: connection.route_id.clone(),
            device_id: connection.device_id.clone(),
            device_public_key: target.device_public_key.clone(),
            grant_ref: target.grant_ref.clone(),
            scopes: scopes.clone(),
            vault_writer_rotation: target.vault_writer_rotation.clone(),
        };
        let valid = answer.get("outcome").and_then(|v| v.as_str()) == Some("grant_target")
            && answer
                .get("account")
                .and_then(crate::wire::account::parse_binding)
                .map(|a| {
                    a.account_id == current.account.account_id
                        && a.auth_epoch == current.account.auth_epoch
                })
                .unwrap_or(false)
            && answer
                .get("operationId")
                .and_then(|v| v.as_str())
                .map(is_operation_id)
                .unwrap_or(false)
            && answer
                .get("expiresAt")
                .and_then(|v| v.as_str())
                .map(|e| chrono::DateTime::parse_from_rfc3339(e).is_ok())
                .unwrap_or(false)
            && target.tenant_id == connection.tenant_id
            && target.route_id == connection.route_id
            && target.device_id == connection.device_id
            && target.grant_ref != connection.capability_grant_ref
            && canonical_account_action_target(&target)
                == canonical_account_action_target(&expected_target);
        if !valid {
            return Err(entry_error(
                "grant_target_invalid",
                "The endpoint returned a grant target that does not match the selected route and scopes.",
            ));
        }
        let device = crate::identity::device_identity_from_custody(&*self.custody, None, &connection.device_id)?
            .ok_or_else(|| {
                entry_error("custody_unavailable", "The Entry device signing key is unavailable in OS custody.")
            })?;
        if device.public_key != target.device_public_key {
            return Err(entry_error(
                "grant_device_mismatch",
                "The target is not bound to this Entry device key.",
            ));
        }
        *self.pending_grant.lock().unwrap() = Some(PendingGrant {
            connection_id: connection_id.to_string(),
            operation_id: answer.get("operationId").unwrap().as_str().unwrap().to_string(),
            target: target.clone(),
            expires_at: answer.get("expiresAt").unwrap().as_str().unwrap().to_string(),
        });
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        let (auth, _cred_ref) = self.desktop_auth()?;
        let (client_public_key, signer) = self.account_signer()?;
        let transaction = client.create_transaction(
            "step_up",
            &client_public_key,
            Some(&target),
            Some("grant_access"),
            None,
            None,
            Some((&auth, &signer)),
        )?;
        Ok((
            GrantView {
                connection_id: connection_id.to_string(),
                available_scopes: available,
                target_scopes: target.scopes.clone(),
                grant_ref: Some(target.grant_ref.clone()),
                status: "authorization_required".into(),
                notice: None,
            },
            transaction,
        ))
    }

    /// `poll_grant_access` — poll the step-up transaction; on `Complete` run
    /// the endpoint `grant_access` request signed by the device key and
    /// persist the confirmed grant.
    pub async fn poll_grant_access(
        &self,
        transaction: &DesktopAccountTransaction,
    ) -> Result<GrantPoll> {
        let client = self.account_client.as_ref().ok_or_else(|| {
            entry_error("account_origin_missing", "No account origin is configured.")
        })?;
        let poll = client.poll_transaction(&transaction.transaction_id, &transaction.verifier)?;
        let TransactionPoll::Complete {
            account,
            purpose,
            permit_id,
            target,
            ..
        } = poll
        else {
            let non_terminal = matches!(
                poll,
                TransactionPoll::Pending
            );
            if !non_terminal {
                *self.pending_grant.lock().unwrap() = None;
                return Ok(match poll {
                    TransactionPoll::Expired => GrantPoll::Expired,
                    TransactionPoll::Consumed => GrantPoll::Consumed,
                    _ => GrantPoll::Expired,
                });
            }
            return Ok(GrantPoll::Pending);
        };
        if purpose != "step_up" {
            *self.pending_grant.lock().unwrap() = None;
            return Err(entry_error(
                "account_step_up_mismatch",
                "The grant access transaction is not a step-up permit.",
            ));
        }
        let pending = self.pending_grant.lock().unwrap().take().ok_or_else(|| {
            entry_error("grant_state_invalid", "No grant request is waiting for its permit.")
        })?;
        if chrono::DateTime::parse_from_rfc3339(&pending.expires_at)
            .map(|d| d.timestamp_millis() <= chrono::Utc::now().timestamp_millis())
            .unwrap_or(true)
        {
            return Err(entry_error(
                "grant_access_refused",
                "The grant target expired before the permit arrived; request a fresh grant.",
            ));
        }
        let connection = self.grant_bound_connection(&pending.connection_id)?;
        let binding = connection.account_binding.clone().unwrap();
        if binding.account_id != account.account_id || binding.auth_epoch != account.auth_epoch {
            return Err(entry_error(
                "account_binding_mismatch",
                "The signed-in account and endpoint enrollment do not match.",
            ));
        }
        if let Some(target) = &target {
            if canonical_account_action_target(target)
                != canonical_account_action_target(&pending.target)
            {
                return Err(entry_error(
                    "account_step_up_mismatch",
                    "The permit does not bind the requested grant target.",
                ));
            }
        }
        let permit_id = permit_id.ok_or_else(|| {
            entry_error("account_step_up_mismatch", "The transaction completed without a permit.")
        })?;
        let transcript = crate::canonical::canonical_json(&json!({
            "account": {
                "accountId": account.account_id,
                "authEpoch": account.auth_epoch,
            },
            "operationId": pending.operation_id,
            "purpose": "grant_access",
            "target": serde_json::to_value(&pending.target)?,
        }));
        let signature = crate::identity::sign_with_device_key(
            &*self.custody,
            None,
            &connection.device_id,
            transcript.as_bytes(),
        )?;
        let answer = self
            .request(
                &pending.connection_id,
                json!({
                    "jsonrpc": "2.0",
                    "id": format!("grant.complete.{}", generate_suffix()),
                    "method": "meshrix/pairing/grant_access",
                    "params": {
                        "account": {
                            "accountId": account.account_id,
                            "authEpoch": account.auth_epoch,
                        },
                        "operationId": pending.operation_id,
                        "permitId": permit_id,
                        "purpose": "grant_access",
                        "target": serde_json::to_value(&pending.target)?,
                        "signature": signature,
                    },
                }),
            )
            .await?;
        let authorized: Vec<String> = answer
            .get("authorizedScopes")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let granted = answer.get("outcome").and_then(|v| v.as_str()) == Some("granted")
            && answer.get("capabilityGrantRef").and_then(|v| v.as_str())
                == Some(pending.target.grant_ref.as_str())
            && pending.target.scopes.iter().all(|s| authorized.contains(s));
        if !granted {
            return Err(entry_error(
                "grant_access_refused",
                "The endpoint did not confirm the exact authorized grant.",
            ));
        }
        {
            let target = pending.target.clone();
            let mut store = self.store.lock().unwrap();
            store.update(|draft| {
                draft.connections = draft
                    .connections
                    .iter()
                    .map(|entry| {
                        if entry.connection_id == pending.connection_id {
                            let mut e = entry.clone();
                            e.capability_grant_ref = target.grant_ref.clone();
                            e.account_action_target = Some(target.clone());
                            e
                        } else {
                            entry.clone()
                        }
                    })
                    .collect();
            })?;
        }
        let _ = client.acknowledge_transaction(&transaction.transaction_id, &transaction.verifier);
        Ok(GrantPoll::Granted(GrantView {
            connection_id: pending.connection_id,
            available_scopes: vec![],
            target_scopes: pending.target.scopes.clone(),
            grant_ref: Some(pending.target.grant_ref),
            status: "granted".into(),
            notice: Some("The endpoint confirmed the new access grant.".into()),
        }))
    }
}
