//! Pairing session state model — port of `pairing-session.ts`.
//!
//! Drives the explicit trusted-pairing handshake against a narrow endpoint
//! port: invite validated → fresh device key into custody → endpoint
//! challenge → device-signed proof → enrolled device record. Honest states:
//! `offline`/`retry_required` are first-class outcomes.

use serde_json::Value;

use crate::custody::CustodyAdapter;
use crate::error::{entry_error, Result};
use crate::identity::{
    enroll_device_identity, load_device_keypair, DeviceIdentity,
};
use crate::keys::generate_opaque_id;
use crate::transcripts::pairing_proof_transcript;
use crate::wire::account::{
    canonical_account_action_target, is_account_step_up_permit_id, is_action_target, is_binding,
    AccountActionTarget, AccountAuthorityBinding,
};
use crate::wire::recovery::peer_id_for_route_device;

use super::invite::{invite_to_trust_binding, PairingInvite};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingState {
    Pending,
    ChallengeIssued,
    ProofSubmitted,
    Enrolled,
    Refused,
    Offline,
    RetryRequired,
    Expired,
    Cancelled,
}

impl PairingState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::ChallengeIssued => "challenge_issued",
            Self::ProofSubmitted => "proof_submitted",
            Self::Enrolled => "enrolled",
            Self::Refused => "refused",
            Self::Offline => "offline",
            Self::RetryRequired => "retry_required",
            Self::Expired => "expired",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone)]
pub struct EnrolledDeviceRecord {
    pub device_id: String,
    pub device_public_key: String,
    pub fingerprint: String,
    /// The wire `endpoint-trust-binding` record.
    pub trust_binding: Value,
    pub invite_id: String,
    pub enrolled_at: String,
    pub capability_grant_ref: String,
    pub admission_generation: u64,
    pub revocation_revision: u64,
    pub endpoint_peer_identity: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct PairingChallenge {
    pub challenge_id: String,
    pub nonce: String,
    pub expires_at: String,
    pub account: AccountAuthorityBinding,
    pub target: AccountActionTarget,
}

#[derive(Debug, Clone)]
pub enum BeginOutcome {
    Challenge(PairingChallenge),
    Refused(String),
    Offline,
    Expired,
}

#[derive(Debug, Clone)]
pub enum CompleteOutcome {
    Enrolled(EnrolledDeviceRecord),
    Refused(String),
    /// Unknown effect — retry only via the same checkpointed operation.
    RetryRequired(String),
}

/// Narrow endpoint port the relay channel implements (`PairingEndpointPort`).
/// Native `async_trait` replacement via boxed futures keeps the trait
/// object-safe without another dependency.
pub trait PairingEndpointPort: Send + Sync {
    fn begin_pairing(
        &self,
        invite: &PairingInvite,
        device_id: &str,
        device_public_key: &str,
    ) -> impl std::future::Future<Output = Result<BeginOutcome>> + Send;

    fn complete_pairing(
        &self,
        completion: &PairingCompletionRequest,
    ) -> impl std::future::Future<Output = Result<CompleteOutcomeRaw>> + Send;
}

/// The endpoint-returned receipt, pre-validation.
#[derive(Debug, Clone)]
pub enum CompleteOutcomeRaw {
    Enrolled {
        capability_grant_ref: String,
        admission_generation: u64,
        revocation_revision: u64,
        endpoint_peer_identity: Option<Value>,
    },
    Refused(String),
}

/// The exact signed operation checkpointed in custody before dispatch.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCompletionRequest {
    pub invite: Value,
    pub challenge_id: String,
    pub device_id: String,
    pub device_public_key: String,
    pub entry_peer_identity: Value,
    pub signature: String,
    pub account: AccountAuthorityBinding,
    pub permit_id: String,
    pub purpose: &'static str,
    pub target: AccountActionTarget,
    pub operation_id: String,
}

pub struct PairingSession<'a, P: PairingEndpointPort> {
    custody: &'a dyn CustodyAdapter,
    endpoint: &'a P,
    invite: PairingInvite,
    bound_recovery_key_id: Option<String>,
    entry_peer_identity: Option<Value>,
    state: PairingState,
    device: Option<DeviceIdentity>,
    challenge_id: Option<String>,
    account: Option<AccountAuthorityBinding>,
    target: Option<AccountActionTarget>,
    operation_id: Option<String>,
    refusal: Option<String>,
    record: Option<EnrolledDeviceRecord>,
}

impl<'a, P: PairingEndpointPort> PairingSession<'a, P> {
    pub fn new(
        invite: PairingInvite,
        custody: &'a dyn CustodyAdapter,
        endpoint: &'a P,
        bound_recovery_key_id: Option<String>,
        entry_peer_identity: Option<Value>,
    ) -> Self {
        Self {
            custody,
            endpoint,
            invite,
            bound_recovery_key_id,
            entry_peer_identity,
            state: PairingState::Pending,
            device: None,
            challenge_id: None,
            account: None,
            target: None,
            operation_id: None,
            refusal: None,
            record: None,
        }
    }

    pub fn state(&self) -> PairingState {
        self.state
    }
    pub fn device(&self) -> Option<&DeviceIdentity> {
        self.device.as_ref()
    }
    pub fn challenge_id(&self) -> Option<&str> {
        self.challenge_id.as_deref()
    }
    pub fn account(&self) -> Option<&AccountAuthorityBinding> {
        self.account.as_ref()
    }
    pub fn target(&self) -> Option<&AccountActionTarget> {
        self.target.as_ref()
    }
    pub fn record(&self) -> Option<&EnrolledDeviceRecord> {
        self.record.as_ref()
    }

    fn expect_state(&self, allowed: &[PairingState]) -> Result<()> {
        if !allowed.contains(&self.state) {
            return Err(entry_error(
                "pairing_state_invalid",
                format!(
                    "Pairing session in state {}; expected {}.",
                    self.state.as_str(),
                    allowed.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("|")
                ),
            ));
        }
        Ok(())
    }

    /// Begin: mint the fresh device key into custody and request a challenge.
    pub async fn begin(&mut self) -> Result<PairingState> {
        self.expect_state(&[PairingState::Pending, PairingState::RetryRequired])?;
        if self.invite.is_expired() {
            self.state = PairingState::Expired;
            return Ok(self.state);
        }
        if self.device.is_none() {
            self.device = Some(enroll_device_identity(self.custody, None, None)?);
        }
        let device = self.device.clone().unwrap();
        let answer = match self
            .endpoint
            .begin_pairing(&self.invite, &device.device_id, &device.public_key)
            .await
        {
            Ok(a) => a,
            Err(e) if e.code == "endpoint_unreachable" => {
                self.state = PairingState::Offline;
                return Ok(self.state);
            }
            Err(e) => return Err(e),
        };
        match answer {
            BeginOutcome::Refused(refusal) => {
                self.state = PairingState::Refused;
                self.refusal = Some(refusal);
            }
            BeginOutcome::Offline => {
                self.state = PairingState::Offline;
            }
            BeginOutcome::Expired => {
                self.state = PairingState::Expired;
            }
            BeginOutcome::Challenge(challenge) => {
                if chrono::DateTime::parse_from_rfc3339(&challenge.expires_at)
                    .map(|e| e <= chrono::Utc::now())
                    .unwrap_or(true)
                {
                    self.state = PairingState::Expired;
                    return Ok(self.state);
                }
                let target_json = serde_json::to_value(&challenge.target)?;
                if !is_binding(&serde_json::to_value(&challenge.account)?)
                    || !is_action_target(&target_json)
                    || challenge.target.tenant_id != self.invite.tenant_id
                    || challenge.target.route_id != self.invite.endpoint_route_id
                    || challenge.target.device_id != device.device_id
                    || challenge.target.device_public_key != device.public_key
                {
                    return Err(entry_error(
                        "pairing_target_mismatch",
                        "The endpoint challenge did not bind the active account and fresh device key.",
                    ));
                }
                self.challenge_id = Some(challenge.challenge_id);
                self.account = Some(challenge.account);
                self.target = Some(challenge.target);
                if self.operation_id.is_none() {
                    self.operation_id = Some(format!("pair.operation.{}", generate_opaque_id()));
                }
                self.state = PairingState::ChallengeIssued;
            }
        }
        Ok(self.state)
    }

    /// Submit the device-signed proof for the issued challenge.
    /// `before_complete` checkpoints the exact signed operation in custody
    /// before first endpoint dispatch (replay-on-loss semantics). Custody
    /// operations are synchronous, so the hook is a plain closure.
    pub async fn submit_proof(
        &mut self,
        account: &AccountAuthorityBinding,
        permit_id: &str,
        target: &AccountActionTarget,
        before_complete: impl FnOnce(&PairingCompletionRequest) -> Result<()>,
    ) -> Result<CompleteOutcome> {
        self.expect_state(&[PairingState::ChallengeIssued, PairingState::RetryRequired])?;
        let device = self.device.clone().ok_or_else(|| {
            entry_error("pairing_state_invalid", "No issued challenge is bound to this session.")
        })?;
        let challenge_id = self.challenge_id.clone().unwrap();
        let own_target = self.target.clone().ok_or_else(|| {
            entry_error("pairing_state_invalid", "No endpoint target is bound to this session.")
        })?;
        let own_account = self.account.clone().unwrap();
        if !is_binding(&serde_json::to_value(account)?)
            || account != &own_account
            || canonical_account_action_target(target) != canonical_account_action_target(&own_target)
            || !is_account_step_up_permit_id(permit_id)
        {
            return Err(entry_error(
                "pairing_authorization_invalid",
                "A fresh action permit bound to this account, device and endpoint target is required.",
            ));
        }
        let keypair = load_device_keypair(self.custody, None, &device.device_id)?
            .ok_or_else(|| entry_error("custody_unavailable", "The paired device key is not in custody."))?;
        let peer_json = self
            .entry_peer_identity
            .clone()
            .unwrap_or(Value::Null);
        let signature = crate::b64::b64u_encode(&keypair.sign(
            pairing_proof_transcript(
                &challenge_id,
                &self.invite.invite_id,
                &self.invite.endpoint_route_id,
                &device.device_id,
                &device.public_key,
                self.entry_peer_identity.as_ref(),
            )
            .as_bytes(),
        ));
        let completion = PairingCompletionRequest {
            invite: self.invite.to_json(),
            challenge_id: challenge_id.clone(),
            device_id: device.device_id.clone(),
            device_public_key: device.public_key.clone(),
            entry_peer_identity: peer_json,
            signature,
            account: own_account,
            permit_id: permit_id.to_string(),
            purpose: "pair_device",
            target: own_target.clone(),
            operation_id: self.operation_id.clone().unwrap(),
        };
        // Checkpoint the exact signed operation before any endpoint call so a
        // lost response or restart can replay the same action.
        before_complete(&completion)?;
        self.state = PairingState::ProofSubmitted;
        let answer = match self.endpoint.complete_pairing(&completion).await {
            Ok(a) => a,
            Err(_) => {
                self.state = PairingState::RetryRequired;
                return Ok(CompleteOutcome::RetryRequired(
                    "The pairing completion outcome is unknown; replay the checkpointed operation.".into(),
                ));
            }
        };
        match answer {
            CompleteOutcomeRaw::Refused(refusal) => {
                self.state = PairingState::Refused;
                self.refusal = Some(refusal.clone());
                Ok(CompleteOutcome::Refused(refusal))
            }
            CompleteOutcomeRaw::Enrolled {
                capability_grant_ref,
                admission_generation,
                revocation_revision,
                endpoint_peer_identity,
            } => {
                let expected_peer = peer_id_for_route_device(
                    &self.invite.tenant_id,
                    &self.invite.endpoint_route_id,
                    &self.invite.endpoint_device_id,
                );
                let peer_ok = match &endpoint_peer_identity {
                    None => self.entry_peer_identity.is_none(),
                    Some(id) => {
                        self.entry_peer_identity.is_some()
                            && expected_peer.is_some()
                            && crate::wire::account::is_pairing_peer_identity(id, expected_peer.as_deref())
                    }
                };
                if capability_grant_ref != own_target.grant_ref
                    || admission_generation < 1
                    || !peer_ok
                {
                    self.state = PairingState::RetryRequired;
                    self.refusal = Some(
                        "The endpoint did not confirm this exact pairing operation; its state remains pending."
                            .into(),
                    );
                    return Ok(CompleteOutcome::RetryRequired(
                        "The endpoint did not confirm this exact pairing operation.".into(),
                    ));
                }
                let trust_binding = invite_to_trust_binding(
                    &self.invite,
                    &device.public_key,
                    &device.fingerprint,
                    &capability_grant_ref,
                    self.bound_recovery_key_id.as_deref(),
                );
                // The record is only enrolled when it satisfies the wire contract.
                if crate::wire::recovery::recovery_message_kind(&trust_binding)
                    != Some("endpoint-trust-binding")
                {
                    return Err(entry_error(
                        "device_record_invalid",
                        "The produced trust binding fails the wire contract.",
                    ));
                }
                let record = EnrolledDeviceRecord {
                    device_id: device.device_id,
                    device_public_key: device.public_key,
                    fingerprint: device.fingerprint,
                    trust_binding,
                    invite_id: self.invite.invite_id.clone(),
                    enrolled_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    capability_grant_ref,
                    admission_generation,
                    revocation_revision,
                    endpoint_peer_identity,
                };
                self.record = Some(record.clone());
                self.state = PairingState::Enrolled;
                Ok(CompleteOutcome::Enrolled(record))
            }
        }
    }

    /// Mark the session interrupted and retry-safe (app restart).
    pub fn interrupt(&mut self) -> PairingState {
        if !matches!(
            self.state,
            PairingState::Enrolled | PairingState::Refused | PairingState::Cancelled
        ) {
            self.state = PairingState::RetryRequired;
        }
        self.state
    }

    pub fn cancel(&mut self) -> PairingState {
        if self.state != PairingState::Enrolled {
            self.state = PairingState::Cancelled;
        }
        self.state
    }
}
