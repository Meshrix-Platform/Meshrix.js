//! `account-pairing.ts` — endpoint-owned pairing policy. Relay hints only
//! locate account-owned pending state; the authority read, invite bearer,
//! device signature and fresh account permit are all verified before an
//! identity-store write.

use std::collections::HashMap;
use std::sync::Arc;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::b64::{b64u_decode, b64u_encode};
use crate::canonical::canonical_json;
use crate::endpoint::authority::{CurrentBindingResponse, EndpointAuthorityClient, PendingPairing, StepUpConsume};
use crate::endpoint::identity_store::{
    EndpointDeviceRecord, EndpointGrantOperationRecord, EndpointIdentityStore,
    EndpointInvitationRecord, EndpointPairingOperationRecord,
};
use crate::error::{entry_error, Result};
use crate::wire::account::{
    is_account_step_up_permit_id, is_pairing_peer_identity,
    AccountActionTarget, AccountAuthorityBinding, PairingPeerIdentity,
};
use crate::wire::recovery::peer_id_for_route_device;

const ED25519_SPKI_DER_PREFIX: &[u8] = &[
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];
const MAX_ACTIVE_PAIRINGS: usize = 128;
const INVITE_TTL_MS: i64 = 24 * 60 * 60_000;
const CHALLENGE_TTL_MS: i64 = 5 * 60_000;
const GRANT_OP_TTL_MS: i64 = 5 * 60_000;

fn is_opaque(value: &str) -> bool {
    crate::wire::common::is_opaque_id(value, 127)
}

fn digest(value: &str) -> String {
    b64u_encode(&Sha256::digest(value.as_bytes()))
}

fn same_secret(left: &str, right: &str) -> bool {
    let (Ok(a), Ok(b)) = (b64u_decode(left, 4096), b64u_decode(right, 4096)) else {
        return false;
    };
    // Constant-time equality on equal-length buffers.
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub(crate) fn raw_ed25519_pin(public_key: &str) -> Option<String> {
    let raw = b64u_decode(public_key, 44).ok()?;
    if raw.len() != 32 || b64u_encode(&raw) != public_key {
        return None;
    }
    let mut spki = ED25519_SPKI_DER_PREFIX.to_vec();
    spki.extend_from_slice(&raw);
    Some(b64u_encode(&Sha256::digest(&spki)))
}

fn route_peer_id(tenant_id: &str, route_id: &str, device_id: &str) -> String {
    peer_id_for_route_device(tenant_id, route_id, device_id).unwrap_or_default()
}

fn valid_peer_identity(value: Option<&PairingPeerIdentity>, expected_peer_id: &str) -> bool {
    let Some(identity) = value else { return true };
    let v = serde_json::to_value(identity).unwrap_or(Value::Null);
    if !is_pairing_peer_identity(&v, Some(expected_peer_id)) {
        return false;
    }
    b64u_decode(&identity.identity_key, 64)
        .map(|raw| raw.len() == 33 && b64u_encode(&raw) == identity.identity_key)
        .unwrap_or(false)
}

fn same_binding(a: Option<&AccountAuthorityBinding>, b: Option<&AccountAuthorityBinding>) -> bool {
    match (a, b) {
        (Some(l), Some(r)) => l.account_id == r.account_id && l.auth_epoch == r.auth_epoch,
        _ => false,
    }
}

fn same_target(a: Option<&AccountActionTarget>, b: Option<&AccountActionTarget>) -> bool {
    match (a, b) {
        (Some(l), Some(r)) => {
            serde_json::to_value(l).map(|v| canonical_json(&v)).ok()
                == serde_json::to_value(r).map(|v| canonical_json(&v)).ok()
        }
        _ => false,
    }
}

/// `verifyPairingDeviceProof` — Ed25519 over the canonical pairing transcript.
fn verify_pairing_device_proof(
    endpoint_route_id: &str,
    challenge_id: &str,
    invite_id: &str,
    device_id: &str,
    device_public_key: &str,
    entry_peer_identity: Option<&PairingPeerIdentity>,
    signature: &str,
) -> bool {
    let Ok(raw) = b64u_decode(device_public_key, 44) else { return false };
    if raw.len() != 32 || b64u_encode(&raw) != device_public_key {
        return false;
    }
    let Some(raw32) = raw.as_slice().first_chunk::<32>() else { return false };
    let Ok(key) = VerifyingKey::from_bytes(raw32) else {
        return false;
    };
    let transcript = canonical_json(&serde_json::json!({
        "challengeId": challenge_id,
        "inviteId": invite_id,
        "endpointRouteId": endpoint_route_id,
        "deviceId": device_id,
        "devicePublicKey": device_public_key,
        "entryPeerIdentity": entry_peer_identity,
        "purpose": "pair_device",
    }));
    let Ok(sig_bytes) = b64u_decode(signature, 128) else { return false };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else { return false };
    key.verify(transcript.as_bytes(), &sig).is_ok()
}

/// `verifyGrantAccessDeviceProof`.
fn verify_grant_access_device_proof(
    account: &AccountAuthorityBinding,
    operation_id: &str,
    purpose: &str,
    target: &AccountActionTarget,
    signature: &str,
) -> bool {
    let Ok(raw) = b64u_decode(&target.device_public_key, 44) else { return false };
    if raw.len() != 32 || b64u_encode(&raw) != target.device_public_key {
        return false;
    }
    let Some(raw32) = raw.as_slice().first_chunk::<32>() else { return false };
    let Ok(key) = VerifyingKey::from_bytes(raw32) else {
        return false;
    };
    let transcript = canonical_json(&serde_json::json!({
        "account": account,
        "operationId": operation_id,
        "purpose": purpose,
        "target": target,
    }));
    let Ok(sig_bytes) = b64u_decode(signature, 128) else { return false };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else { return false };
    key.verify(transcript.as_bytes(), &sig).is_ok()
}

/// `EndpointPairingInviteContext` — immutable route facts this endpoint
/// attests inside every invitation it issues.
#[derive(Debug, Clone)]
pub struct EndpointPairingInviteContext {
    pub tenant_id: String,
    pub route_id: String,
    pub endpoint_device_id: String,
    pub endpoint_pin_ref: String,
    pub endpoint_spki_pin: String,
    pub endpoint_principal_ref: String,
    pub relay_service: String,
    pub vault_id: String,
    /// "personal" | "enterprise"
    pub mode: String,
}

/// `ActivePairingBootstrap`.
#[derive(Debug, Clone)]
pub struct ActivePairingBootstrap {
    pub bootstrap_id: String,
    pub entry_session_id: String,
    pub account: AccountAuthorityBinding,
    pub entry_device_id: String,
    pub entry_device_public_key: String,
    pub peer_spki: String,
    pub target: Option<AccountActionTarget>,
    pub expires_at: String,
}

/// `PairingBeginResult`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PairingBeginResult {
    Challenge {
        challenge_id: String,
        nonce: String,
        expires_at: String,
        account: AccountAuthorityBinding,
        target: AccountActionTarget,
    },
    Refused { refusal: String },
}

/// `PairingCompleteResult`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PairingCompleteResult {
    Enrolled {
        capability_grant_ref: String,
        admission_generation: u64,
        revocation_revision: u64,
        endpoint_peer_identity: Option<PairingPeerIdentity>,
    },
    Refused { refusal: String },
}

#[derive(Debug, Clone)]
struct PairingChallenge {
    entry_session_id: String,
    invite_id: String,
    challenge_id: String,
    nonce: String,
    account: AccountAuthorityBinding,
    target: AccountActionTarget,
    expires_at: String,
}

fn id_factory(prefix: &str) -> String {
    let mut raw = [0u8; 18];
    use rand::RngCore;
    rand::rng().fill_bytes(&mut raw);
    format!("{prefix}.{}", b64u_encode(&raw))
}

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn iso_at(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(iso_now)
}

fn instant_ms(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}

fn refused(refusal: &str) -> PairingCompleteResult {
    PairingCompleteResult::Refused { refusal: refusal.to_string() }
}

/// `EndpointAccountPairingApplication`.
///
/// The authority and proof ports collapse onto `EndpointAuthorityClient` (the
/// TS client implements both); injection points stay separate for tests.
pub struct EndpointPairingApplication {
    authority: Arc<EndpointAuthorityClient>,
    invite: EndpointPairingInviteContext,
    available_scopes: Vec<String>,
    endpoint_peer_identity: Option<PairingPeerIdentity>,
    active: HashMap<String, ActivePairingBootstrap>,
    challenges: HashMap<String, PairingChallenge>,
    /// bootstrapId → (operationId, permitId, target, entryPeerIdentity) —
    /// the in-flight dedup guard.
    in_flight: HashMap<String, (String, String, AccountActionTarget, Option<PairingPeerIdentity>)>,
}

impl EndpointPairingApplication {
    pub fn new(
        identity: &EndpointIdentityStore,
        authority: Arc<EndpointAuthorityClient>,
        invite: EndpointPairingInviteContext,
        available_scopes: Vec<String>,
        endpoint_peer_identity: Option<PairingPeerIdentity>,
    ) -> Result<Self> {
        let mut scopes = available_scopes;
        scopes.sort();
        scopes.dedup();
        if !valid_peer_identity(
            endpoint_peer_identity.as_ref(),
            &route_peer_id(&invite.tenant_id, &invite.route_id, &invite.endpoint_device_id),
        ) {
            return Err(entry_error("peer_identity_invalid", "Account-managed pairing could not be completed."));
        }
        let mut challenges = HashMap::new();
        let now_ms = chrono::Utc::now().timestamp_millis();
        for operation in identity.pairing_operations() {
            if operation.state != "revoked" && instant_ms(&operation.expires_at) > now_ms {
                challenges.insert(
                    operation.bootstrap_id.clone(),
                    PairingChallenge {
                        entry_session_id: operation.entry_session_id,
                        invite_id: operation.invite_id,
                        challenge_id: operation.challenge_id,
                        nonce: operation.nonce,
                        account: operation.account,
                        target: operation.target,
                        expires_at: operation.expires_at,
                    },
                );
            }
        }
        Ok(Self {
            authority,
            invite,
            available_scopes: scopes,
            endpoint_peer_identity,
            active: HashMap::new(),
            challenges,
            in_flight: HashMap::new(),
        })
    }

    /// `inspectBootstrap` — resolve a relay-hint bootstrap to verified
    /// account-owned pending state, or `None`.
    pub fn inspect_bootstrap(
        &mut self,
        identity: &EndpointIdentityStore,
        bootstrap_id: &str,
        entry_session_id: &str,
    ) -> Result<Option<ActivePairingBootstrap>> {
        if !is_opaque(bootstrap_id) || !is_opaque(entry_session_id) {
            return Ok(None);
        }
        let now_ms = chrono::Utc::now().timestamp_millis();
        if let Some(cached) = self.active.get(bootstrap_id) {
            if cached.entry_session_id == entry_session_id && instant_ms(&cached.expires_at) > now_ms {
                let current = self.authority.current_binding(&cached.account.account_id, &cached.entry_device_id)?;
                if same_binding(current.as_ref(), Some(&cached.account)) {
                    return Ok(Some(cached.clone()));
                }
                self.active.remove(bootstrap_id);
                self.challenges.remove(bootstrap_id);
                return Ok(None);
            }
        }
        // A replacement session invalidates provisional challenge state for
        // the old session before the new peer pin can become active.
        let stale: Vec<String> = self
            .active
            .iter()
            .filter(|(id, a)| *id == bootstrap_id && a.entry_session_id != entry_session_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            self.active.remove(&id);
            self.challenges.remove(&id);
        }
        let pending = match self.authority.inspect_pending_pairing(bootstrap_id) {
            Ok(Some(p)) => p,
            Ok(None) => {
                tracing::debug!(bootstrap = %bootstrap_id, "authority returned no pending pairing");
                return Ok(None);
            }
            Err(e) => {
                tracing::debug!(bootstrap = %bootstrap_id, error = %e, "authority pairing inspect failed");
                return Err(e);
            }
        };
        if pending.bootstrap_id != bootstrap_id
            || pending.tenant_id != self.invite.tenant_id
            || pending.route_id != self.invite.route_id
            || pending.endpoint_device_id != self.invite.endpoint_device_id
            || pending.endpoint_pin_ref != self.invite.endpoint_pin_ref
            || instant_ms(&pending.expires_at) <= now_ms
            || raw_ed25519_pin(&pending.entry_device_public_key).is_none()
        {
            return Ok(None);
        }
        let current = self.authority.current_binding(&pending.account.account_id, &pending.entry_device_id)?;
        if !same_binding(current.as_ref(), Some(&pending.account)) {
            return Ok(None);
        }
        let peer_spki = raw_ed25519_pin(&pending.entry_device_public_key).unwrap_or_default();
        let mut next = ActivePairingBootstrap {
            bootstrap_id: pending.bootstrap_id.clone(),
            entry_session_id: entry_session_id.to_string(),
            account: pending.account.clone(),
            entry_device_id: pending.entry_device_id.clone(),
            entry_device_public_key: pending.entry_device_public_key.clone(),
            peer_spki,
            target: pending.target.clone(),
            expires_at: pending.expires_at.clone(),
        };
        if let Some(saved) = identity.pairing_operation(bootstrap_id) {
            // A provisional `challenged` record bound to a superseded session
            // is dead state — a fresh session must be able to re-issue.
            if saved.state == "revoked"
                || (saved.entry_session_id != entry_session_id && saved.state != "challenged")
                || saved.account.account_id != pending.account.account_id
                || saved.account.auth_epoch != pending.account.auth_epoch
            {
                return Ok(None);
            }
        }
        if self
            .challenges
            .get(bootstrap_id)
            .is_some_and(|c| c.entry_session_id != entry_session_id)
        {
            self.challenges.remove(bootstrap_id);
        }
        if let Some(challenge) = self.challenges.get(bootstrap_id) {
            if challenge.target.device_id != pending.entry_device_id
                || challenge.target.device_public_key != pending.entry_device_public_key
            {
                return Ok(None);
            }
            next.target = Some(challenge.target.clone());
        }
        self.active.insert(bootstrap_id.to_string(), next.clone());
        if self.active.len() > MAX_ACTIVE_PAIRINGS {
            if let Some(first) = self.active.keys().next().cloned() {
                self.active.remove(&first);
                self.challenges.remove(&first);
            }
        }
        Ok(Some(next))
    }

    /// `authorizeProtectedEffect` — one current-authority read for a
    /// protected effect; scopes live only when device+epoch+grant all match.
    pub fn authorize_protected_effect(
        &self,
        device: &EndpointDeviceRecord,
        scope: Option<&str>,
    ) -> Option<Vec<String>> {
        let binding = device.account_binding.as_ref()?;
        if device.revoked {
            return None;
        }
        let response = self.authority.current_device_authorization(&device.device_id).ok()?;
        if !account_device_authorization_matches(&response, binding, device, scope) {
            return None;
        }
        Some(response.authorized_scopes)
    }

    pub fn current_device_is_authorized(&self, device: &EndpointDeviceRecord, scope: Option<&str>) -> bool {
        self.authorize_protected_effect(device, scope).is_some()
    }

    /// `issueInvite` — mint a single-use bearer invite; only its digest is
    /// persisted.
    pub fn issue_invite(
        &mut self,
        identity: &mut EndpointIdentityStore,
        vault_id: Option<&str>,
        endpoint_label: Option<&str>,
    ) -> Result<(Value, String)> {
        if vault_id.is_some_and(|v| v != self.invite.vault_id) {
            return Err(entry_error("pairing_vault_mismatch", "Account-managed pairing could not be completed."));
        }
        let mut raw = [0u8; 32];
        use rand::RngCore;
        rand::rng().fill_bytes(&mut raw);
        let token = b64u_encode(&raw);
        if !(40..=128).contains(&token.len()) {
            return Err(entry_error("pairing_token_invalid", "Account-managed pairing could not be completed."));
        }
        let now_ms = chrono::Utc::now().timestamp_millis();
        let invite_id = id_factory("invite");
        let issued_at = iso_at(now_ms);
        let expires_at = iso_at(now_ms + INVITE_TTL_MS);
        let recovery_authority = identity
            .recovery_authorities()
            .into_iter()
            .find(|a| a.state == "active")
            .map(|a| serde_json::json!({ "keyId": a.recovery_key_id, "generation": a.generation }));
        let mut invite = serde_json::json!({
            "schemaVersion": "v0.0.1:entry:pairing-invite-2",
            "kind": "entry-pairing-invite",
            "inviteId": invite_id,
            "endpointRouteId": self.invite.route_id,
            "tenantId": self.invite.tenant_id,
            "mode": self.invite.mode,
            "endpointDeviceId": self.invite.endpoint_device_id,
            "endpointPrincipalRef": self.invite.endpoint_principal_ref,
            "endpointSpkiPin": self.invite.endpoint_spki_pin,
            "endpointPinRef": self.invite.endpoint_pin_ref,
            "relayService": self.invite.relay_service,
            "vaultId": self.invite.vault_id,
            "recoveryAuthority": recovery_authority,
            "issuedAt": issued_at,
            "expiresAt": expires_at,
            "pairingToken": token,
        });
        if let Some(label) = endpoint_label.filter(|l| !l.trim().is_empty()) {
            invite["endpointLabel"] = serde_json::json!(label);
        }
        if !is_opaque(&self.invite.vault_id) {
            return Err(entry_error("pairing_vault_unconfigured", "Account-managed pairing could not be completed."));
        }
        identity.save_invitation(EndpointInvitationRecord {
            invite_id: invite_id.clone(),
            token_digest: digest(&token),
            tenant_id: self.invite.tenant_id.clone(),
            route_id: self.invite.route_id.clone(),
            endpoint_device_id: self.invite.endpoint_device_id.clone(),
            endpoint_pin_ref: self.invite.endpoint_pin_ref.clone(),
            mode: self.invite.mode.clone(),
            issued_at,
            expires_at,
            consumed_by_operation_id: None,
        })?;
        Ok((invite, token))
    }

    /// `beginPairing` — verify the invite bearer and device pin, publish the
    /// exact target at the authority, then emit the challenge.
    pub fn begin_pairing(
        &mut self,
        identity: &mut EndpointIdentityStore,
        bootstrap_id: &str,
        entry_session_id: &str,
        invite_id: &str,
        pairing_token: &str,
        device_id: &str,
        device_public_key: &str,
    ) -> Result<PairingBeginResult> {
        let refuse = |r: &str| Ok(PairingBeginResult::Refused { refusal: r.to_string() });
        let Some(active) = self.active.get(bootstrap_id).cloned() else {
            return refuse("pairing_invite_refused");
        };
        let Some(invitation) = identity.invitation(invite_id).cloned() else {
            return refuse("pairing_invite_refused");
        };
        if active.entry_session_id != entry_session_id
            || invitation.tenant_id != self.invite.tenant_id
            || invitation.route_id != self.invite.route_id
            || invitation.endpoint_device_id != self.invite.endpoint_device_id
            || instant_ms(&invitation.expires_at) <= chrono::Utc::now().timestamp_millis()
            || !same_secret(&invitation.token_digest, &digest(pairing_token))
            || invitation.consumed_by_operation_id.is_some()
        {
            return refuse("pairing_invite_refused");
        }
        if active.entry_device_id != device_id || active.entry_device_public_key != device_public_key {
            return refuse("pairing_device_mismatch");
        }
        if let Some(old) = self.challenges.get(bootstrap_id).cloned() {
            if old.entry_session_id != entry_session_id {
                // Stale challenge from a superseded session — drop it and
                // fall through to a fresh challenge.
                self.challenges.remove(bootstrap_id);
            } else {
                if old.invite_id != invite_id
                    || old.target.device_id != device_id
                    || old.target.device_public_key != device_public_key
                {
                    return refuse("pairing_target_mismatch");
                }
                let published = self.authority.publish_pairing_target(bootstrap_id, &old.target)?;
                if !published
                    .as_ref()
                    .is_some_and(|p| same_target(p.target.as_ref(), Some(&old.target)) && same_binding(Some(&p.account), Some(&old.account)))
                {
                    return refuse("pairing_target_refused");
                }
                return Ok(PairingBeginResult::Challenge {
                    challenge_id: old.challenge_id,
                    nonce: old.nonce,
                    expires_at: old.expires_at,
                    account: old.account,
                    target: old.target,
                });
            }
        }
        let current = self.authority.current_binding(&active.account.account_id, &active.entry_device_id)?;
        if !same_binding(current.as_ref(), Some(&active.account)) {
            return refuse("account_stale");
        }
        if self.available_scopes.is_empty() {
            return refuse("pairing_no_scopes");
        }
        let target = AccountActionTarget {
            tenant_id: self.invite.tenant_id.clone(),
            route_id: self.invite.route_id.clone(),
            device_id: device_id.to_string(),
            device_public_key: device_public_key.to_string(),
            grant_ref: id_factory("grant"),
            scopes: self.available_scopes.clone(),
            vault_writer_rotation: None,
        };
        let challenge = PairingChallenge {
            entry_session_id: entry_session_id.to_string(),
            invite_id: invite_id.to_string(),
            challenge_id: id_factory("challenge"),
            nonce: id_factory("nonce"),
            account: active.account.clone(),
            target: target.clone(),
            expires_at: iso_at(instant_ms(&active.expires_at).min(chrono::Utc::now().timestamp_millis() + CHALLENGE_TTL_MS)),
        };
        identity.save_pairing_operation(EndpointPairingOperationRecord {
            bootstrap_id: bootstrap_id.to_string(),
            entry_session_id: entry_session_id.to_string(),
            invite_id: invite_id.to_string(),
            challenge_id: challenge.challenge_id.clone(),
            nonce: challenge.nonce.clone(),
            account: challenge.account.clone(),
            target: challenge.target.clone(),
            expires_at: challenge.expires_at.clone(),
            state: "challenged".to_string(),
            operation_id: None,
            permit_id: None,
            capability_grant_ref: None,
            entry_peer_identity: None,
            endpoint_peer_identity: self.endpoint_peer_identity.clone(),
        })?;
        self.challenges.insert(bootstrap_id.to_string(), challenge.clone());
        if let Some(active_entry) = self.active.get_mut(bootstrap_id) {
            active_entry.target = Some(target.clone());
        }
        let published = self.authority.publish_pairing_target(bootstrap_id, &target)?;
        if !published
            .as_ref()
            .is_some_and(|p| same_target(p.target.as_ref(), Some(&target)) && same_binding(Some(&p.account), Some(&active.account)))
        {
            return refuse("pairing_target_refused");
        }
        Ok(PairingBeginResult::Challenge {
            challenge_id: challenge.challenge_id,
            nonce: challenge.nonce,
            expires_at: challenge.expires_at,
            account: challenge.account,
            target: challenge.target,
        })
    }

    /// `completePairing` — the authority consume is the idempotent effect
    /// boundary; local enrollment lands before promotion is checked.
    #[allow(clippy::too_many_arguments)]
    pub fn complete_pairing(
        &mut self,
        identity: &mut EndpointIdentityStore,
        input: &PairingCompleteInput,
    ) -> Result<PairingCompleteResult> {
        // In-flight dedup: identical retry returns the pending conclusion.
        if let Some((operation_id, permit_id, target, entry_peer)) = self.in_flight.get(bootstrap_key(input)) {
            if operation_id != &input.operation_id
                || permit_id != &input.permit_id
                || !same_target(Some(target), Some(&input.target))
                || serde_json::to_value(entry_peer).ok() != serde_json::to_value(&input.entry_peer_identity).ok()
            {
                return Ok(refused("pairing_operation_conflict"));
            }
        }
        let key = bootstrap_key(input).to_string();
        self.in_flight.insert(
            key.clone(),
            (
                input.operation_id.clone(),
                input.permit_id.clone(),
                input.target.clone(),
                input.entry_peer_identity.clone(),
            ),
        );
        let result = self.complete_pairing_inner(identity, input);
        self.in_flight.remove(&key);
        result
    }

    fn complete_pairing_inner(
        &mut self,
        identity: &mut EndpointIdentityStore,
        input: &PairingCompleteInput,
    ) -> Result<PairingCompleteResult> {
        let saved = identity.pairing_operation(&input.bootstrap_id).cloned();
        let active = self.active.get(&input.bootstrap_id).cloned();
        let challenge = self
            .challenges
            .get(&input.bootstrap_id)
            .cloned()
            .or_else(|| {
                saved.as_ref().map(|s| PairingChallenge {
                    entry_session_id: s.entry_session_id.clone(),
                    invite_id: s.invite_id.clone(),
                    challenge_id: s.challenge_id.clone(),
                    nonce: s.nonce.clone(),
                    account: s.account.clone(),
                    target: s.target.clone(),
                    expires_at: s.expires_at.clone(),
                })
            });
        let invitation = identity.invitation(&input.invite_id).cloned();
        let now_ms = chrono::Utc::now().timestamp_millis();
        let replayed_enrollment = saved.as_ref().is_some_and(|s| {
            s.state == "enrolled"
                && s.operation_id.as_deref() == Some(input.operation_id.as_str())
                && s.permit_id.as_deref() == Some(input.permit_id.as_str())
                && s.invite_id == input.invite_id
                && s.challenge_id == input.challenge_id
        });
        let Some(challenge) = challenge.clone() else {
            return Ok(refused("pairing_proof_refused"));
        };
        let Some(invitation) = invitation else {
            return Ok(refused("pairing_proof_refused"));
        };
        if (!replayed_enrollment && (active.is_none() || active.as_ref().unwrap().entry_session_id != input.entry_session_id))
            || (!replayed_enrollment && challenge.entry_session_id != input.entry_session_id)
            || challenge.challenge_id != input.challenge_id
            || challenge.invite_id != input.invite_id
            || (!replayed_enrollment && instant_ms(&challenge.expires_at) <= now_ms)
            || (!replayed_enrollment && instant_ms(&invitation.expires_at) <= now_ms)
            || !same_secret(&invitation.token_digest, &digest(&input.pairing_token))
            || (invitation.consumed_by_operation_id.is_some()
                && invitation.consumed_by_operation_id.as_deref() != Some(input.operation_id.as_str()))
            || challenge.target.device_id != input.device_id
            || challenge.target.device_public_key != input.device_public_key
            || !valid_peer_identity(
                input.entry_peer_identity.as_ref(),
                &route_peer_id(&challenge.target.tenant_id, &challenge.target.route_id, &input.device_id),
            )
            || input.entry_peer_identity.is_none() != self.endpoint_peer_identity.is_none()
            || input.purpose != "pair_device"
            || !same_binding(Some(&challenge.account), Some(&input.account))
            || !same_target(Some(&challenge.target), Some(&input.target))
            || !is_opaque(&input.operation_id)
            || !is_account_step_up_permit_id(&input.permit_id)
            || saved
                .as_ref()
                .and_then(|s| s.entry_peer_identity.clone())
                .is_some_and(|saved_peer| {
                    serde_json::to_value(&Some(saved_peer)).ok()
                        != serde_json::to_value(&input.entry_peer_identity).ok()
                })
            || saved
                .as_ref()
                .and_then(|s| s.endpoint_peer_identity.clone())
                .is_some_and(|saved_peer| {
                    serde_json::to_value(&Some(saved_peer)).ok()
                        != serde_json::to_value(&self.endpoint_peer_identity).ok()
                })
            || !verify_pairing_device_proof(
                &challenge.target.route_id,
                &input.challenge_id,
                &input.invite_id,
                &input.device_id,
                &input.device_public_key,
                input.entry_peer_identity.as_ref(),
                &input.signature,
            )
        {
            return Ok(refused("pairing_proof_refused"));
        }
        let current = self.authority.current_binding(&input.account.account_id, &input.device_id)?;
        if !same_binding(current.as_ref(), Some(&input.account)) {
            return Ok(refused("account_stale"));
        }
        if replayed_enrollment {
            let completed = self.authority.complete_pairing(
                &input.account,
                &input.bootstrap_id,
                &input.operation_id,
                &challenge.target,
            )?;
            if !completed.completed || !completed.relay_admission_active {
                return Ok(refused("pairing_promotion_pending"));
            }
            let enrolled = identity.device(&input.device_id).cloned();
            let Some(enrolled) = enrolled else {
                return Ok(refused("pairing_enrollment_missing"));
            };
            if enrolled.revoked
                || enrolled.account_binding.as_ref().map(|b| b.account_id.as_str()) != Some(input.account.account_id.as_str())
                || enrolled.account_binding.as_ref().map(|b| b.auth_epoch) != Some(input.account.auth_epoch)
            {
                return Ok(refused("pairing_enrollment_missing"));
            }
            return Ok(PairingCompleteResult::Enrolled {
                capability_grant_ref: challenge.target.grant_ref.clone(),
                admission_generation: enrolled.admission_generation,
                revocation_revision: identity.revocation_revision(&enrolled.tenant_id),
                endpoint_peer_identity: saved
                    .as_ref()
                    .and_then(|s| s.endpoint_peer_identity.clone())
                    .or_else(|| self.endpoint_peer_identity.clone()),
            });
        }
        // Consume is the authority's idempotent effect boundary.
        let consumed = self.authority.consume_step_up_permit(
            &input.account,
            &input.permit_id,
            "pair_device",
            &challenge.target,
            Some(&input.bootstrap_id),
            &input.operation_id,
        )?;
        if !matches!(consumed, StepUpConsume::Consumed { .. }) {
            return Ok(refused("pairing_permit_refused"));
        }
        identity.save_pairing_operation(EndpointPairingOperationRecord {
            bootstrap_id: input.bootstrap_id.clone(),
            entry_session_id: input.entry_session_id.clone(),
            invite_id: input.invite_id.clone(),
            challenge_id: challenge.challenge_id.clone(),
            nonce: challenge.nonce.clone(),
            account: challenge.account.clone(),
            target: challenge.target.clone(),
            expires_at: challenge.expires_at.clone(),
            state: "authorized".to_string(),
            operation_id: Some(input.operation_id.clone()),
            permit_id: Some(input.permit_id.clone()),
            capability_grant_ref: None,
            entry_peer_identity: input.entry_peer_identity.clone(),
            endpoint_peer_identity: self.endpoint_peer_identity.clone(),
        })?;
        identity.enroll_account_device(
            &input.account,
            &challenge.target,
            &self.invite.mode,
            input.entry_peer_identity.as_ref(),
        )?;
        identity.save_invitation(EndpointInvitationRecord {
            consumed_by_operation_id: Some(input.operation_id.clone()),
            ..invitation.clone()
        })?;
        identity.save_pairing_operation(EndpointPairingOperationRecord {
            bootstrap_id: input.bootstrap_id.clone(),
            entry_session_id: input.entry_session_id.clone(),
            invite_id: input.invite_id.clone(),
            challenge_id: challenge.challenge_id.clone(),
            nonce: challenge.nonce.clone(),
            account: challenge.account.clone(),
            target: challenge.target.clone(),
            expires_at: challenge.expires_at.clone(),
            state: "enrolled".to_string(),
            operation_id: Some(input.operation_id.clone()),
            permit_id: Some(input.permit_id.clone()),
            capability_grant_ref: Some(challenge.target.grant_ref.clone()),
            entry_peer_identity: input.entry_peer_identity.clone(),
            endpoint_peer_identity: self.endpoint_peer_identity.clone(),
        })?;
        let completed = self.authority.complete_pairing(
            &input.account,
            &input.bootstrap_id,
            &input.operation_id,
            &challenge.target,
        )?;
        if !completed.completed || !completed.relay_admission_active {
            return Ok(refused("pairing_promotion_pending"));
        }
        let enrolled = identity.device(&input.device_id).cloned();
        let Some(enrolled) = enrolled else {
            return Ok(refused("pairing_enrollment_missing"));
        };
        if enrolled.revoked
            || enrolled.account_binding.as_ref().map(|b| b.account_id.as_str()) != Some(input.account.account_id.as_str())
            || enrolled.account_binding.as_ref().map(|b| b.auth_epoch) != Some(input.account.auth_epoch)
        {
            return Ok(refused("pairing_enrollment_missing"));
        }
        self.challenges.remove(&input.bootstrap_id);
        self.active.remove(&input.bootstrap_id);
        Ok(PairingCompleteResult::Enrolled {
            capability_grant_ref: challenge.target.grant_ref.clone(),
            admission_generation: enrolled.admission_generation,
            revocation_revision: identity.revocation_revision(&enrolled.tenant_id),
            endpoint_peer_identity: self.endpoint_peer_identity.clone(),
        })
    }

    /// `grantCatalog`.
    pub fn grant_catalog(&self, device: &EndpointDeviceRecord) -> Result<PairingGrantCatalog> {
        let Some(binding) = device.account_binding.clone() else {
            return Ok(PairingGrantCatalog::Refused { refusal: "account_binding_missing".into() });
        };
        if device.revoked {
            return Ok(PairingGrantCatalog::Refused { refusal: "account_binding_missing".into() });
        }
        let current = self.authority.current_binding(&binding.account_id, &device.device_id)?;
        if !same_binding(current.as_ref(), Some(&binding)) {
            return Ok(PairingGrantCatalog::Refused { refusal: "account_stale".into() });
        }
        Ok(PairingGrantCatalog::Catalog {
            account: binding,
            endpoint_device_id: device.device_id.clone(),
            available_scopes: self.available_scopes.clone(),
        })
    }

    /// `grantTarget` — stage a grant operation for a later signed consume.
    pub fn grant_target(
        &self,
        identity: &mut EndpointIdentityStore,
        device: &EndpointDeviceRecord,
        scopes: &[String],
    ) -> Result<PairingGrantTarget> {
        let Some(binding) = device.account_binding.clone() else {
            return Ok(PairingGrantTarget::Refused { refusal: "grant_target_invalid".into() });
        };
        if device.revoked
            || scopes.is_empty()
            || scopes.iter().any(|s| !self.available_scopes.contains(s))
            || scopes.iter().collect::<std::collections::HashSet<_>>().len() != scopes.len()
        {
            return Ok(PairingGrantTarget::Refused { refusal: "grant_target_invalid".into() });
        }
        let current = self.authority.current_binding(&binding.account_id, &device.device_id)?;
        if !same_binding(current.as_ref(), Some(&binding)) {
            return Ok(PairingGrantTarget::Refused { refusal: "account_stale".into() });
        }
        let mut sorted = scopes.to_vec();
        sorted.sort();
        let target = AccountActionTarget {
            tenant_id: device.tenant_id.clone(),
            route_id: device.route_id.clone(),
            device_id: device.device_id.clone(),
            device_public_key: device.paired_identity_key.clone(),
            grant_ref: id_factory("grant"),
            scopes: sorted,
            vault_writer_rotation: None,
        };
        let operation_id = id_factory("grant.op");
        let expires_at = iso_at(chrono::Utc::now().timestamp_millis() + GRANT_OP_TTL_MS);
        identity.save_grant_operation(EndpointGrantOperationRecord {
            operation_id: operation_id.clone(),
            account: binding.clone(),
            device_id: device.device_id.clone(),
            target: target.clone(),
            expires_at: expires_at.clone(),
            state: "issued".to_string(),
        })?;
        Ok(PairingGrantTarget::Target {
            account: binding,
            operation_id,
            expires_at,
            target,
        })
    }

    /// `grantAccess` — consume a fresh grant permit and enroll the widened
    /// scope set.
    pub fn grant_access(
        &mut self,
        identity: &mut EndpointIdentityStore,
        device: &EndpointDeviceRecord,
        account: &AccountAuthorityBinding,
        operation_id: &str,
        permit_id: &str,
        purpose: &str,
        target: &AccountActionTarget,
        signature: &str,
    ) -> Result<GrantAccessResult> {
        let refuse = |r: &str| Ok(GrantAccessResult::Refused { refusal: r.to_string() });
        if device.account_binding.is_none()
            || device.revoked
            || purpose != "grant_access"
            || target.vault_writer_rotation.is_some()
            || !same_binding(device.account_binding.as_ref(), Some(account))
            || target.tenant_id != device.tenant_id
            || target.route_id != device.route_id
            || target.device_id != device.device_id
            || target.device_public_key != device.paired_identity_key
            || target.scopes.is_empty()
            || target.scopes.iter().any(|s| !self.available_scopes.contains(s))
            || !is_opaque(operation_id)
            || !is_account_step_up_permit_id(permit_id)
            || !verify_grant_access_device_proof(account, operation_id, purpose, target, signature)
        {
            return refuse("grant_target_mismatch");
        }
        let grant_operation = match identity.grant_operation(operation_id).cloned() {
            Some(g) => g,
            None => return refuse("grant_target_expired"),
        };
        if grant_operation.state == "revoked"
            || grant_operation.device_id != device.device_id
            || !same_binding(Some(&grant_operation.account), Some(account))
            || !same_target(Some(&grant_operation.target), Some(target))
            || instant_ms(&grant_operation.expires_at) <= chrono::Utc::now().timestamp_millis()
        {
            return refuse("grant_target_expired");
        }
        let current = self.authority.current_binding(&account.account_id, &device.device_id)?;
        if !same_binding(current.as_ref(), Some(account)) {
            return refuse("account_stale");
        }
        let consumed = self.authority.consume_step_up_permit(
            account,
            permit_id,
            "grant_access",
            target,
            None,
            operation_id,
        )?;
        if !matches!(consumed, StepUpConsume::Consumed { .. }) {
            return refuse("grant_permit_refused");
        }
        identity.save_grant_operation(EndpointGrantOperationRecord {
            state: "authorized".to_string(),
            ..grant_operation
        })?;
        let enrolled = identity.enroll_account_device(account, target, &device.mode, None)?;
        Ok(GrantAccessResult::Granted {
            capability_grant_ref: target.grant_ref.clone(),
            authorized_scopes: enrolled.account_scopes.unwrap_or_default(),
        })
    }
}

fn bootstrap_key(input: &PairingCompleteInput) -> &str {
    &input.bootstrap_id
}

/// `PairingCompleteRequest` — the endpoint-visible fields of a completion.
#[derive(Debug, Clone)]
pub struct PairingCompleteInput {
    pub bootstrap_id: String,
    pub entry_session_id: String,
    pub invite_id: String,
    pub pairing_token: String,
    pub challenge_id: String,
    pub device_id: String,
    pub device_public_key: String,
    pub entry_peer_identity: Option<PairingPeerIdentity>,
    pub signature: String,
    pub account: AccountAuthorityBinding,
    pub permit_id: String,
    /// Always "pair_device".
    pub purpose: String,
    pub target: AccountActionTarget,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PairingGrantCatalog {
    #[serde(rename = "grant_catalog")]
    Catalog {
        account: AccountAuthorityBinding,
        endpoint_device_id: String,
        available_scopes: Vec<String>,
    },
    Refused { refusal: String },
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PairingGrantTarget {
    #[serde(rename = "grant_target")]
    Target {
        account: AccountAuthorityBinding,
        operation_id: String,
        expires_at: String,
        target: AccountActionTarget,
    },
    Refused { refusal: String },
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GrantAccessResult {
    Granted {
        capability_grant_ref: String,
        authorized_scopes: Vec<String>,
    },
    Refused { refusal: String },
}

/// `accountDeviceAuthorizationMatches` — current authority vs exact durable
/// grant records. Additive scope sets may span several grants but cannot
/// contain an unknown scope or grant ref.
pub fn account_device_authorization_matches(
    response: &CurrentBindingResponse,
    binding: &AccountAuthorityBinding,
    device: &EndpointDeviceRecord,
    scope: Option<&str>,
) -> bool {
    let Some(target) = &response.target else { return false };
    if response.account.account_id != binding.account_id
        || response.account.auth_epoch != binding.auth_epoch
        || target.tenant_id != device.tenant_id
        || target.route_id != device.route_id
        || target.device_id != device.device_id
        || target.device_public_key != device.paired_identity_key
    {
        return false;
    }
    if response.authorized_scopes.iter().any(|s| s.is_empty())
        || response.authorized_scopes.iter().collect::<std::collections::HashSet<_>>().len()
            != response.authorized_scopes.len()
        || target.scopes.iter().collect::<std::collections::HashSet<_>>().len() != target.scopes.len()
    {
        return false;
    }
    let exact_grant = device
        .account_grants
        .as_deref()
        .unwrap_or_default()
        .iter()
        .find(|g| g.grant_ref == target.grant_ref);
    let Some(exact_grant) = exact_grant else { return false };
    let mut a = exact_grant.scopes.clone();
    a.sort();
    let mut b = target.scopes.clone();
    b.sort();
    if a != b {
        return false;
    }
    let enrolled: std::collections::HashSet<&str> = device
        .account_grants
        .as_deref()
        .unwrap_or_default()
        .iter()
        .flat_map(|g| g.scopes.iter().map(String::as_str))
        .collect();
    let authorized: std::collections::HashSet<&str> =
        response.authorized_scopes.iter().map(String::as_str).collect();
    if target.scopes.iter().any(|s| !authorized.contains(s.as_str()))
        || response.authorized_scopes.iter().any(|s| !enrolled.contains(s.as_str()))
    {
        return false;
    }
    scope.is_none_or(|s| authorized.contains(s))
}

/// Pending pairing from `inspect_pending_pairing` — re-exported for callers.
pub type EndpointPendingPairing = PendingPairing;
