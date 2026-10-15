//! Restricted pairing channels — port of `pairing-relay-channel.ts`.
//!
//! `EntryPairingRelayChannel` exposes only the two pairing RPCs over the
//! relay's pair_device purpose and the invite-pinned inner TLS channel.
//! `EntryPairingCompletionRelayChannel` replays one already-checkpointed
//! completion on a fresh forward session — never a second begin.

use serde_json::{json, Value};

use crate::error::{entry_error, Result};
use crate::keys::generate_opaque_id;
use crate::pairing::invite::PairingInvite;
use crate::pairing::session::{
    BeginOutcome, CompleteOutcomeRaw, PairingCompletionRequest, PairingEndpointPort,
    PairingChallenge,
};
use crate::wire::account::{
    canonical_account_action_target, is_account_step_up_permit_id, is_action_target, is_binding,
    is_pairing_peer_identity, AccountActionTarget, AccountAuthorityBinding,
};
use crate::wire::recovery::peer_id_for_route_device;
use crate::wire::session::RelayAdmission;

use super::address::relay_session_url;
use super::entry::{EntrySession, EntrySessionOptions, InnerTlsOptions};

/// The account-issued pairing bootstrap — `PairingRelayBootstrap` in TS.
#[derive(Debug, Clone)]
pub struct PairingRelayBootstrap {
    pub bootstrap_id: String,
    /// Bearer credential presented to the relay upgrade.
    pub relay_admission: String,
    pub account: AccountAuthorityBinding,
    pub tenant_id: String,
    pub route_id: String,
    pub endpoint_device_id: String,
    pub endpoint_pin_ref: String,
    pub entry_device_id: String,
    pub mode: String,
    pub admission_generation: u64,
    pub revocation_revision: u64,
    pub expires_at: String,
}

pub struct EntryPairingRelayChannelOptions {
    pub relay_service: String,
    pub bootstrap: PairingRelayBootstrap,
    pub invite: PairingInvite,
    pub inner_tls: InnerTlsOptions,
    pub connect_timeout: Option<std::time::Duration>,
    pub allow_insecure_loopback: bool,
}

fn is_operation_id(s: &str) -> bool {
    s.len() >= 2
        && s.len() <= 128
        && s.bytes().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b':'))
}

fn safe_text(value: &str) -> String {
    value
        .chars()
        .map(|c| if (c < '\u{20}' && c != '\t') || c == '\u{7f}' { ' ' } else { c })
        .take(256)
        .collect()
}

fn route_peer_id(tenant_id: &str, route_id: &str, device_id: &str) -> String {
    peer_id_for_route_device(tenant_id, route_id, device_id).unwrap_or_default()
}

fn assert_bootstrap_matches_invite(bootstrap: &PairingRelayBootstrap, invite: &PairingInvite) -> Result<()> {
    if bootstrap.tenant_id != invite.tenant_id
        || bootstrap.route_id != invite.endpoint_route_id
        || bootstrap.endpoint_device_id != invite.endpoint_device_id
        || bootstrap.endpoint_pin_ref != invite.endpoint_pin_ref
        || bootstrap.mode != invite.mode
        || !is_operation_id(&bootstrap.bootstrap_id)
        || bootstrap.account.auth_epoch < 1
        || bootstrap.account.account_id.is_empty()
        || bootstrap.relay_admission.len() < 32
        || bootstrap.admission_generation < 1
        || chrono::DateTime::parse_from_rfc3339(&bootstrap.expires_at).is_err()
    {
        return Err(entry_error(
            "account_bootstrap_invalid",
            "The pairing bootstrap does not match the endpoint invite.",
        ));
    }
    if chrono::DateTime::parse_from_rfc3339(&bootstrap.expires_at)
        .map(|e| e <= chrono::Utc::now())
        .unwrap_or(true)
    {
        return Err(entry_error(
            "account_bootstrap_expired",
            "The restricted pairing bootstrap has expired.",
        ));
    }
    Ok(())
}

fn assert_same_invite(input: &PairingInvite, expected: &PairingInvite) -> Result<()> {
    if input.invite_id != expected.invite_id
        || input.tenant_id != expected.tenant_id
        || input.endpoint_route_id != expected.endpoint_route_id
        || input.endpoint_device_id != expected.endpoint_device_id
        || input.endpoint_pin_ref != expected.endpoint_pin_ref
        || input.pairing_token != expected.pairing_token
    {
        return Err(entry_error(
            "pairing_invite_mismatch",
            "The pairing request is not bound to the active endpoint invite.",
        ));
    }
    Ok(())
}

#[derive(Clone)]
struct StoredChallenge {
    challenge_id: String,
    device_id: String,
    device_public_key: String,
    account: AccountAuthorityBinding,
    target: AccountActionTarget,
}

/// Restricted pairing channel over the pair_device session. Callers cannot
/// attach MCP, recovery or ordinary endpoint operation traffic here.
pub struct EntryPairingRelayChannel {
    invite: PairingInvite,
    bootstrap: PairingRelayBootstrap,
    session: EntrySession,
    challenge: std::sync::Mutex<Option<StoredChallenge>>,
}

impl EntryPairingRelayChannel {
    pub async fn connect(options: EntryPairingRelayChannelOptions) -> Result<Self> {
        assert_bootstrap_matches_invite(&options.bootstrap, &options.invite)?;
        let url = relay_session_url(
            &options.relay_service,
            &options.bootstrap.tenant_id,
            &options.bootstrap.route_id,
            options.allow_insecure_loopback,
        )?;
        let mut session_options = EntrySessionOptions::forward(
            url,
            RelayAdmission {
                tenant_id: options.bootstrap.tenant_id.clone(),
                route_id: options.bootstrap.route_id.clone(),
                device_id: options.bootstrap.entry_device_id.clone(),
                role: "entry".into(),
                mode: options.invite.mode.clone(),
                admission_generation: options.bootstrap.admission_generation,
                revocation_revision: options.bootstrap.revocation_revision,
            },
            options.inner_tls,
        );
        session_options.purpose = "pair_device".into();
        session_options.headers = vec![(
            "authorization".into(),
            format!("Bearer {}", options.bootstrap.relay_admission),
        )];
        session_options.connect_timeout = options.connect_timeout;
        session_options.allow_insecure_loopback = options.allow_insecure_loopback;
        let session = EntrySession::connect(session_options).await?;
        Ok(Self {
            invite: options.invite,
            bootstrap: options.bootstrap,
            session,
            challenge: std::sync::Mutex::new(None),
        })
    }

    pub fn close(&self) {
        *self.challenge.lock().unwrap() = None;
        self.session.close("normal");
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        if !self.session.accepts_new_work() {
            return Err(entry_error(
                "endpoint_unreachable",
                "The restricted pairing endpoint is not ready.",
            )
            .with_effect("not_started"));
        }
        self.session
            .request(json!({
                "jsonrpc": "2.0",
                "id": format!("pair.rpc.{}", generate_opaque_id()),
                "method": method,
                "params": params,
            }))
            .await
    }
}

impl PairingEndpointPort for EntryPairingRelayChannel {
    async fn begin_pairing(
        &self,
        invite: &PairingInvite,
        device_id: &str,
        device_public_key: &str,
    ) -> Result<BeginOutcome> {
        assert_same_invite(invite, &self.invite)?;
        if self.challenge.lock().unwrap().is_some() {
            return Err(entry_error(
                "pairing_state_invalid",
                "The restricted channel already has an outstanding endpoint challenge.",
            ));
        }
        let value = self
            .request(
                "meshrix/pairing/begin",
                json!({
                    "bootstrapId": self.bootstrap.bootstrap_id,
                    "inviteId": invite.invite_id,
                    "pairingToken": invite.pairing_token,
                    "deviceId": device_id,
                    "devicePublicKey": device_public_key,
                }),
            )
            .await?;
        if value.get("outcome").and_then(|v| v.as_str()) == Some("refused") {
            let refusal = value
                .get("refusal")
                .and_then(|v| v.as_str())
                .map(safe_text)
                .unwrap_or_else(|| "refused".into());
            return Ok(BeginOutcome::Refused(refusal));
        }
        let valid = value.is_object()
            && value.get("outcome").and_then(|v| v.as_str()) == Some("challenge")
            && value.get("challengeId").and_then(|v| v.as_str()).is_some()
            && value.get("nonce").and_then(|v| v.as_str()).is_some()
            && value.get("expiresAt").and_then(|v| v.as_str()).is_some_and(|s| {
                chrono::DateTime::parse_from_rfc3339(s).is_ok()
            })
            && value.get("account").is_some_and(is_binding)
            && value.get("target").is_some_and(is_action_target);
        tracing::debug!(
            response = %value,
            expected_account = ?self.bootstrap.account,
            expected_tenant = %invite.tenant_id,
            expected_route = %invite.endpoint_route_id,
            device_id,
            device_public_key,
            "pairing begin challenge"
        );
        if !valid {
            return Err(entry_error(
                "pairing_target_mismatch",
                "The endpoint returned a challenge outside this account bootstrap and device key.",
            ));
        }
        let account: AccountAuthorityBinding =
            serde_json::from_value(value.get("account").cloned().unwrap()).map_err(|_| {
                entry_error("pairing_target_mismatch", "The endpoint returned a malformed account binding.")
            })?;
        let target: AccountActionTarget =
            serde_json::from_value(value.get("target").cloned().unwrap()).map_err(|_| {
                entry_error("pairing_target_mismatch", "The endpoint returned a malformed action target.")
            })?;
        if account.account_id != self.bootstrap.account.account_id
            || account.auth_epoch != self.bootstrap.account.auth_epoch
            || target.tenant_id != invite.tenant_id
            || target.route_id != invite.endpoint_route_id
            || target.device_id != device_id
            || target.device_public_key != device_public_key
        {
            return Err(entry_error(
                "pairing_target_mismatch",
                "The endpoint returned a challenge outside this account bootstrap and device key.",
            ));
        }
        let challenge = PairingChallenge {
            challenge_id: value.get("challengeId").and_then(|v| v.as_str()).unwrap().to_string(),
            nonce: value.get("nonce").and_then(|v| v.as_str()).unwrap().to_string(),
            expires_at: value.get("expiresAt").and_then(|v| v.as_str()).unwrap().to_string(),
            account: account.clone(),
            target: target.clone(),
        };
        *self.challenge.lock().unwrap() = Some(StoredChallenge {
            challenge_id: challenge.challenge_id.clone(),
            device_id: device_id.to_string(),
            device_public_key: device_public_key.to_string(),
            account,
            target,
        });
        Ok(BeginOutcome::Challenge(challenge))
    }

    async fn complete_pairing(&self, input: &PairingCompletionRequest) -> Result<CompleteOutcomeRaw> {
        let invite_json = input.invite.clone();
        let invite = crate::pairing::invite::parse_pairing_invite_json(&invite_json)
            .ok_or_else(|| entry_error("pairing_invite_mismatch", "The pairing request is not bound to the active endpoint invite."))?;
        assert_same_invite(&invite, &self.invite)?;
        let challenge = self.challenge.lock().unwrap().clone().map(|c| {
            (
                c.challenge_id,
                c.device_id,
                c.device_public_key,
                c.account,
                c.target,
            )
        });
        let Some((challenge_id, device_id, device_public_key, account, target)) = challenge else {
            return Err(entry_error(
                "pairing_authorization_invalid",
                "The completion permit does not match the active endpoint challenge.",
            ));
        };
        let expected_entry_peer = route_peer_id(&invite.tenant_id, &invite.endpoint_route_id, &device_id);
        let peer_ok = input.entry_peer_identity.is_null()
            || is_pairing_peer_identity(&input.entry_peer_identity, Some(&expected_entry_peer));
        if input.challenge_id != challenge_id
            || input.device_id != device_id
            || input.device_public_key != device_public_key
            || !peer_ok
            || input.account.account_id != account.account_id
            || input.account.auth_epoch != account.auth_epoch
            || input.purpose != "pair_device"
            || canonical_account_action_target(&input.target) != canonical_account_action_target(&target)
            || input.target.device_public_key != device_public_key
            || !is_account_step_up_permit_id(&input.permit_id)
            || !is_operation_id(&input.operation_id)
        {
            return Err(entry_error(
                "pairing_authorization_invalid",
                "The completion permit does not match the active endpoint challenge.",
            ));
        }
        let value = self
            .request(
                "meshrix/pairing/complete",
                json!({
                    "bootstrapId": self.bootstrap.bootstrap_id,
                    "inviteId": invite.invite_id,
                    "pairingToken": invite.pairing_token,
                    "challengeId": input.challenge_id,
                    "deviceId": input.device_id,
                    "devicePublicKey": input.device_public_key,
                    "entryPeerIdentity": input.entry_peer_identity,
                    "account": input.account,
                    "permitId": input.permit_id,
                    "purpose": input.purpose,
                    "target": input.target,
                    "operationId": input.operation_id,
                    "signature": input.signature,
                }),
            )
            .await?;
        if value.get("outcome").and_then(|v| v.as_str()) == Some("refused") {
            *self.challenge.lock().unwrap() = None;
            let refusal = value
                .get("refusal")
                .and_then(|v| v.as_str())
                .map(safe_text)
                .unwrap_or_else(|| "refused".into());
            return Ok(CompleteOutcomeRaw::Refused(refusal));
        }
        let expected_endpoint_peer = route_peer_id(
            &invite.tenant_id,
            &invite.endpoint_route_id,
            &invite.endpoint_device_id,
        );
        let endpoint_peer = value.get("endpointPeerIdentity").cloned().unwrap_or(Value::Null);
        let peer_shape_ok = if endpoint_peer.is_null() {
            input.entry_peer_identity.is_null()
        } else {
            !input.entry_peer_identity.is_null()
                && is_pairing_peer_identity(&endpoint_peer, Some(&expected_endpoint_peer))
        };
        let enrolled_ok = value.get("outcome").and_then(|v| v.as_str()) == Some("enrolled")
            && value.get("capabilityGrantRef").and_then(|v| v.as_str()) == Some(input.target.grant_ref.as_str())
            && value.get("admissionGeneration").and_then(|v| v.as_u64()).is_some()
            && value.get("revocationRevision").and_then(|v| v.as_u64()).is_some()
            && peer_shape_ok;
        if !enrolled_ok {
            return Err(entry_error(
                "pairing_completion_invalid",
                "The endpoint did not confirm durable enrollment for the authorized grant.",
            ));
        }
        *self.challenge.lock().unwrap() = None;
        Ok(CompleteOutcomeRaw::Enrolled {
            capability_grant_ref: value.get("capabilityGrantRef").and_then(|v| v.as_str()).unwrap().to_string(),
            admission_generation: value.get("admissionGeneration").and_then(|v| v.as_u64()).unwrap(),
            revocation_revision: value.get("revocationRevision").and_then(|v| v.as_u64()).unwrap(),
            endpoint_peer_identity: if endpoint_peer.is_null() { None } else { Some(endpoint_peer) },
        })
    }
}

/// Narrow forward-session caller used only to replay an already
/// checkpointed pairing completion — begin is impossible here.
pub struct EntryPairingCompletionRelayChannel {
    session: EntrySession,
    completion: PairingCompletionRequest,
    invite: PairingInvite,
    bootstrap_id: String,
    attempted: std::sync::atomic::AtomicBool,
}

impl EntryPairingCompletionRelayChannel {
    pub async fn connect(options: CompletionRelayChannelOptions) -> Result<Self> {
        assert_completion_matches_bootstrap(&options.bootstrap, &options.completion)?;
        let invite = crate::pairing::invite::parse_pairing_invite_json(&options.completion.invite)
            .ok_or_else(|| entry_error("pairing_completion_invalid", "The saved completion carries an invalid invite."))?;
        if !options
            .inner_tls
            .pinned_peer_spki
            .contains(&invite.endpoint_pin_ref)
        {
            return Err(entry_error(
                "pairing_pin_mismatch",
                "The completion replay TLS pin does not match its original endpoint invite.",
            ));
        }
        let url = relay_session_url(
            &options.relay_service,
            &options.bootstrap.tenant_id,
            &options.bootstrap.route_id,
            options.allow_insecure_loopback,
        )?;
        let mut session_options = EntrySessionOptions::forward(
            url,
            RelayAdmission {
                tenant_id: options.bootstrap.tenant_id.clone(),
                route_id: options.bootstrap.route_id.clone(),
                device_id: options.bootstrap.entry_device_id.clone(),
                role: "entry".into(),
                mode: options.bootstrap.mode.clone(),
                admission_generation: options.bootstrap.admission_generation,
                revocation_revision: options.bootstrap.revocation_revision,
            },
            options.inner_tls,
        );
        session_options.headers = vec![(
            "authorization".into(),
            format!("Bearer {}", options.bootstrap.relay_admission),
        )];
        session_options.connect_timeout = options.connect_timeout;
        session_options.allow_insecure_loopback = options.allow_insecure_loopback;
        let session = EntrySession::connect(session_options).await?;
        Ok(Self {
            session,
            bootstrap_id: options.bootstrap.bootstrap_id.clone(),
            completion: options.completion,
            invite,
            attempted: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// Send the saved complete operation once on this fresh forward session.
    pub async fn replay_completion(&self) -> Result<CompleteOutcomeRaw> {
        if self.attempted.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Err(entry_error(
                "pairing_completion_replay_used",
                "This completion-only channel has already submitted its saved operation.",
            ));
        }
        if !self.session.accepts_new_work() {
            return Err(entry_error(
                "endpoint_unreachable",
                "The promoted forward endpoint is not ready for completion replay.",
            )
            .with_effect("not_started"));
        }
        let input = &self.completion;
        let value = self
            .session
            .request(json!({
                "jsonrpc": "2.0",
                "id": format!("pair.replay.{}", generate_opaque_id()),
                "method": "meshrix/pairing/complete",
                "params": {
                    "bootstrapId": self.bootstrap_id,
                    "inviteId": self.invite.invite_id,
                    "pairingToken": self.invite.pairing_token,
                    "challengeId": input.challenge_id,
                    "deviceId": input.device_id,
                    "devicePublicKey": input.device_public_key,
                    "entryPeerIdentity": input.entry_peer_identity,
                    "account": input.account,
                    "permitId": input.permit_id,
                    "purpose": input.purpose,
                    "target": input.target,
                    "operationId": input.operation_id,
                    "signature": input.signature,
                },
            }))
            .await?;
        if value.get("outcome").and_then(|v| v.as_str()) == Some("refused") {
            let refusal = value
                .get("refusal")
                .and_then(|v| v.as_str())
                .map(safe_text)
                .unwrap_or_else(|| "refused".into());
            return Ok(CompleteOutcomeRaw::Refused(refusal));
        }
        let expected_endpoint_peer = route_peer_id(
            &self.invite.tenant_id,
            &self.invite.endpoint_route_id,
            &self.invite.endpoint_device_id,
        );
        let endpoint_peer = value.get("endpointPeerIdentity").cloned().unwrap_or(Value::Null);
        let peer_shape_ok = if endpoint_peer.is_null() {
            input.entry_peer_identity.is_null()
        } else {
            !input.entry_peer_identity.is_null()
                && is_pairing_peer_identity(&endpoint_peer, Some(&expected_endpoint_peer))
        };
        let enrolled_ok = value.get("outcome").and_then(|v| v.as_str()) == Some("enrolled")
            && value.get("capabilityGrantRef").and_then(|v| v.as_str()) == Some(input.target.grant_ref.as_str())
            && value.get("admissionGeneration").and_then(|v| v.as_u64()).is_some_and(|g| g >= 1)
            && value.get("revocationRevision").and_then(|v| v.as_u64()).is_some()
            && peer_shape_ok;
        if !enrolled_ok {
            return Err(entry_error(
                "pairing_completion_invalid",
                "The endpoint did not confirm the saved pairing operation.",
            ));
        }
        Ok(CompleteOutcomeRaw::Enrolled {
            capability_grant_ref: value.get("capabilityGrantRef").and_then(|v| v.as_str()).unwrap().to_string(),
            admission_generation: value.get("admissionGeneration").and_then(|v| v.as_u64()).unwrap(),
            revocation_revision: value.get("revocationRevision").and_then(|v| v.as_u64()).unwrap(),
            endpoint_peer_identity: if endpoint_peer.is_null() { None } else { Some(endpoint_peer) },
        })
    }

    pub fn close(&self) {
        self.session.close("normal");
    }
}

pub struct CompletionRelayChannelOptions {
    pub relay_service: String,
    pub bootstrap: PairingRelayBootstrap,
    pub completion: PairingCompletionRequest,
    pub inner_tls: InnerTlsOptions,
    pub connect_timeout: Option<std::time::Duration>,
    pub allow_insecure_loopback: bool,
}

fn assert_completion_matches_bootstrap(
    bootstrap: &PairingRelayBootstrap,
    input: &PairingCompletionRequest,
) -> Result<()> {
    let invite_ok = crate::pairing::invite::parse_pairing_invite_json(&input.invite).is_some_and(|invite| {
        bootstrap.tenant_id == invite.tenant_id
            && bootstrap.route_id == invite.endpoint_route_id
            && bootstrap.endpoint_device_id == invite.endpoint_device_id
            && bootstrap.endpoint_pin_ref == invite.endpoint_pin_ref
            && bootstrap.mode == invite.mode
    });
    let expected_entry_peer = crate::pairing::invite::parse_pairing_invite_json(&input.invite)
        .map(|i| route_peer_id(&i.tenant_id, &i.endpoint_route_id, &input.device_id))
        .unwrap_or_default();
    if !invite_ok
        || !is_operation_id(&bootstrap.bootstrap_id)
        || bootstrap.relay_admission.len() < 32
        || !is_binding(&serde_json::to_value(&bootstrap.account).unwrap_or(Value::Null))
        || bootstrap.account.account_id != input.account.account_id
        || bootstrap.account.auth_epoch != input.account.auth_epoch
        || bootstrap.entry_device_id != input.device_id
        || input.purpose != "pair_device"
        || input.target.tenant_id != bootstrap.tenant_id
        || input.target.route_id != bootstrap.route_id
        || input.target.device_id != input.device_id
        || input.target.device_public_key != input.device_public_key
        || (!input.entry_peer_identity.is_null()
            && !is_pairing_peer_identity(&input.entry_peer_identity, Some(&expected_entry_peer)))
        || input.device_public_key.len() < 32
        || input.challenge_id.len() < 8
        || !is_account_step_up_permit_id(&input.permit_id)
        || !is_operation_id(&input.operation_id)
        || !input.signature.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        || !(80..=100).contains(&input.signature.len())
        || !is_action_target(&serde_json::to_value(&input.target).unwrap_or(Value::Null))
        || bootstrap.admission_generation < 1
        || chrono::DateTime::parse_from_rfc3339(&bootstrap.expires_at).is_err()
    {
        return Err(entry_error(
            "pairing_completion_invalid",
            "The saved completion does not match its original account, endpoint and device admission.",
        ));
    }
    Ok(())
}
