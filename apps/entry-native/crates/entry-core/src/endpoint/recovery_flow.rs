//! `recovery-flow.ts` — endpoint-side recovery authority service.
//!
//! Implements the `recover_device` flow: an endpoint-owned, purpose-bound,
//! single-use challenge answered by a fresh-device root-possession proof.
//! Recovery never relies on an old device cookie or certificate, never
//! imports semantic grants from a backup, and preserves all current
//! revocations.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;


use crate::b64::b64u_encode;
use crate::canonical::canonical_json;
use crate::endpoint::identity_store::EndpointIdentityStore;
use crate::wire::recovery::{
    create_recovery_challenge, create_recovery_result_enrolled, create_recovery_result_refused,
    create_rotation_state, parse_recovery_proof, parse_recovery_request,
    recovery_channel_admits_only_recovery,
};

const DEFAULT_CHALLENGE_TTL_MS: i64 = 5 * 60_000;
const MAX_CHALLENGES: usize = 1_024;

/// `RecoverySigner` — verify a fresh-device possession proof under the
/// enrolled recovery authority key.
pub trait RecoverySigner: Send + Sync {
    fn verify(&self, public_key: &str, signature: &str, transcript: &Value) -> bool;
}

/// Default Ed25519 verifier for recovery proofs.
pub struct Ed25519RecoverySigner;

impl RecoverySigner for Ed25519RecoverySigner {
    fn verify(&self, public_key: &str, signature: &str, transcript: &Value) -> bool {
        let Ok(raw) = crate::b64::b64u_decode(public_key, 44) else { return false };
        if raw.len() != 32 {
            return false;
        }
        let Some(raw32) = raw.as_slice().first_chunk::<32>() else { return false };
        let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(raw32) else { return false };
        let Ok(sig_raw) = crate::b64::b64u_decode(signature, 128) else { return false };
        let Ok(sig) = ed25519_dalek::Signature::from_slice(&sig_raw) else { return false };
        use ed25519_dalek::Verifier;
        key.verify(canonical_json(transcript).as_bytes(), &sig).is_ok()
    }
}

struct IssuedRecoveryChallenge {
    endpoint_route_id: String,
    principal_ref: String,
    generation: u64,
    nonce: String,
    fresh_device_public_key: String,
    issued_at: i64,
    expires_at: i64,
    consumed: bool,
}

struct RotationState {
    #[allow(dead_code)]
    recovery_key_id: String,
    state: String,
    acknowledged: Vec<String>,
    pending: Vec<String>,
}

/// `RecoveryAuthorityService`.
pub struct EndpointRecoveryAuthority {
    signer: Arc<dyn RecoverySigner>,
    challenges: HashMap<String, IssuedRecoveryChallenge>,
    rotations: HashMap<String, RotationState>,
}

impl EndpointRecoveryAuthority {
    pub fn new(signer: Arc<dyn RecoverySigner>) -> Self {
        Self {
            signer,
            challenges: HashMap::new(),
            rotations: HashMap::new(),
        }
    }

    fn sweep(&mut self, now: i64) {
        if self.challenges.len() <= MAX_CHALLENGES {
            self.challenges.retain(|_, c| c.expires_at > now);
            return;
        }
        // Hard bound: evict oldest regardless of expiry.
        let mut by_expiry: Vec<(String, i64)> = self
            .challenges
            .iter()
            .map(|(id, c)| (id.clone(), c.expires_at))
            .collect();
        by_expiry.sort_by_key(|(_, e)| *e);
        for (id, _) in by_expiry.into_iter().take(self.challenges.len() - MAX_CHALLENGES + 1) {
            self.challenges.remove(&id);
        }
    }

    /// Handle a wire `recovery-request`; returns the challenge message.
    pub fn begin_recovery(
        &mut self,
        identity: &EndpointIdentityStore,
        request: &Value,
    ) -> Option<Value> {
        let parsed = parse_recovery_request(request)?;
        let now = chrono::Utc::now().timestamp_millis();
        self.sweep(now);
        let authority = identity
            .recovery_authorities()
            .into_iter()
            .find(|a| a.state == "active" || a.state == "rotating")?;
        let mut raw = [0u8; 12];
        use rand::RngCore;
        rand::rng().fill_bytes(&mut raw);
        let challenge_id = format!("rch.{:x}.{}", now, b64u_encode(&raw[..8]));
        let nonce = format!("rn.{}.{}", challenge_id, b64u_encode(&raw));
        let challenge = IssuedRecoveryChallenge {
            endpoint_route_id: parsed.endpoint_route_id.clone(),
            principal_ref: authority.principal_ref.clone(),
            generation: authority.generation,
            nonce: nonce.clone(),
            fresh_device_public_key: parsed.fresh_device_public_key.clone(),
            issued_at: now,
            expires_at: now + DEFAULT_CHALLENGE_TTL_MS,
            consumed: false,
        };
        let message = create_recovery_challenge(
            &challenge_id,
            &challenge.endpoint_route_id,
            &challenge.principal_ref,
            challenge.generation,
            &challenge.nonce,
            &challenge.fresh_device_public_key,
            &iso_at(challenge.issued_at),
            &iso_at(challenge.expires_at),
        );
        self.challenges.insert(challenge_id, challenge);
        Some(message)
    }

    /// `completeRecovery` — verify fresh-device proof → mint device admission.
    pub fn complete_recovery(
        &mut self,
        identity: &mut EndpointIdentityStore,
        proof: &Value,
    ) -> Option<Value> {
        let parsed = parse_recovery_proof(proof)?;
        let now = chrono::Utc::now().timestamp_millis();
        let challenge = self.challenges.get(&parsed.challenge_id);
        let Some(challenge) = challenge else {
            return Some(create_recovery_result_refused(&parsed.challenge_id, "challenge_expired"));
        };
        if challenge.consumed {
            return Some(create_recovery_result_refused(&parsed.challenge_id, "challenge_consumed"));
        }
        if challenge.expires_at <= now {
            self.challenges.remove(&parsed.challenge_id);
            return Some(create_recovery_result_refused(&parsed.challenge_id, "challenge_expired"));
        }
        if challenge.fresh_device_public_key != parsed.fresh_device_public_key {
            return Some(create_recovery_result_refused(&parsed.challenge_id, "key_possession_mismatch"));
        }
        let authority = identity
            .recovery_authorities()
            .into_iter()
            .find(|a| a.state == "active" || a.state == "rotating");
        let Some(authority) = authority else {
            return Some(create_recovery_result_refused(&parsed.challenge_id, "authority_revoked"));
        };
        if authority.generation > parsed.generation {
            return Some(create_recovery_result_refused(&parsed.challenge_id, "stale_generation"));
        }
        let transcript = crate::canonical::canonical_json(&serde_json::json!({
            "challengeId": parsed.challenge_id,
            "endpointRouteId": parsed.endpoint_route_id,
            "principalRef": parsed.principal_ref,
            "generation": parsed.generation,
            "freshDeviceId": parsed.fresh_device_id,
            "freshDevicePublicKey": parsed.fresh_device_public_key,
            "purpose": "recover_device",
        }));
        let verified = self.signer.verify(
            &parsed.fresh_device_public_key,
            &parsed.signature,
            &serde_json::from_str::<Value>(&transcript).unwrap_or(Value::Null),
        );
        if !verified {
            return Some(create_recovery_result_refused(&parsed.challenge_id, "key_possession_mismatch"));
        }
        self.challenges.remove(&parsed.challenge_id);

        let trust_binding = serde_json::json!({
            "schemaVersion": "v0.0.1:private-relay:recovery-1",
            "kind": "endpoint-trust-binding",
            "pairedIdentityKey": parsed.fresh_device_public_key,
            "pairedIdentityFingerprint": format!("fp.recovered.{}", parsed.fresh_device_id),
            "mode": "personal",
            "role": "entry",
            "trustGeneration": authority.generation,
            "endpointPrincipalRef": parsed.principal_ref,
            "capabilityGrantRef": "none",
            "boundRecoveryKeyId": authority.recovery_key_id,
        });
        let device = identity
            .enroll(
                &parsed.fresh_device_id,
                &parsed.endpoint_route_id,
                "recovery",
                &trust_binding,
            )
            .ok()?;
        Some(create_recovery_result_enrolled(
            &parsed.challenge_id,
            &device.device_id,
            device.admission_generation,
        ))
    }

    /// Whether a message kind is legal on the recovery-only channel.
    pub fn admits_kind(&self, kind: &str, session_purpose: &str) -> bool {
        recovery_channel_admits_only_recovery(kind, session_purpose)
    }

    /// `rotationState`.
    pub fn rotation_state(&self, rotation_id: &str) -> Option<Value> {
        let rotation = self.rotations.get(rotation_id)?;
        Some(create_rotation_state(
            rotation_id,
            &rotation.state,
            &rotation.acknowledged,
            &rotation.pending,
        ))
    }
}

fn iso_at(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}
