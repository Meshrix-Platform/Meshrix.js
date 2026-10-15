//! `account-authority-client.ts` — signed, fail-closed HTTP adapter for
//! endpoint-owned account authority calls. Every request carries a fresh
//! `AccountDeviceAuthorityProof` signed by this endpoint's route key; every
//! response is bounded and shape-checked before use.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::account::normalize_account_origin;
use crate::b64::b64u_encode;
use crate::error::{entry_error, EntryError, Result};
use crate::wire::account::{
    account_device_authority_transcript, canonical_account_action_target,
    is_account_step_up_permit_id, AccountActionTarget, AccountAuthorityBinding,
    AccountDeviceAuthorityProof,
};

const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;

fn authority_error(code: &str, message: &str) -> EntryError {
    entry_error(code, message)
}

pub mod routes {
    const BASE: &str = "/api/account";
    pub fn device_current_binding() -> String {
        format!("{BASE}/device/current-binding")
    }
    pub fn device_managed_route() -> String {
        format!("{BASE}/device/managed-route")
    }
    pub fn device_pending_pairing_inspect() -> String {
        format!("{BASE}/device/pairing/inspect")
    }
    pub fn device_pairing_target_publish() -> String {
        format!("{BASE}/device/pairing/target")
    }
    pub fn device_step_up_inspect() -> String {
        format!("{BASE}/device/authorization/inspect")
    }
    pub fn device_step_up_consume() -> String {
        format!("{BASE}/device/authorization/consume")
    }
    pub fn device_pairing_complete() -> String {
        format!("{BASE}/device/pairing/complete")
    }
    pub fn device_endpoint_claim_prepare() -> String {
        format!("{BASE}/device/endpoints/claim/prepare")
    }
    pub fn device_endpoint_claim_complete() -> String {
        format!("{BASE}/device/endpoints/claim/complete")
    }
}

fn target_digest(target: &AccountActionTarget) -> String {
    b64u_encode(&Sha256::digest(canonical_account_action_target(target).as_bytes()))
}

/// `AccountManagedRouteBinding` — the route owner row for this endpoint key.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRouteBinding {
    pub account_id: String,
    pub tenant_id: String,
    pub route_id: String,
    pub auth_epoch: u64,
    pub endpoint_device_id: String,
    pub endpoint_public_key: String,
    pub endpoint_pin_ref: String,
    pub vault_id: String,
}

fn is_managed_route(value: &Value) -> bool {
    let Some(o) = value.as_object() else { return false };
    o.get("accountId").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
        && o.get("tenantId").and_then(Value::as_str).is_some()
        && o.get("routeId").and_then(Value::as_str).is_some()
        && o.get("authEpoch").and_then(Value::as_u64).is_some_and(|n| n > 0)
        && o.get("endpointDeviceId").and_then(Value::as_str).is_some()
        && o.get("endpointPublicKey").and_then(Value::as_str).is_some()
        && o.get("endpointPinRef").and_then(Value::as_str).is_some()
        && o.get("vaultId").and_then(Value::as_str).is_some()
}

/// `AccountPendingPairing` — pending pairing bootstrap visible to the
/// endpoint authority.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPairing {
    pub bootstrap_id: String,
    pub account: AccountAuthorityBinding,
    pub tenant_id: String,
    pub route_id: String,
    pub entry_device_id: String,
    pub entry_device_public_key: String,
    pub endpoint_device_id: String,
    pub endpoint_pin_ref: String,
    pub target: Option<AccountActionTarget>,
    pub expires_at: String,
}

fn is_pending_pairing(value: &Value) -> bool {
    let Some(o) = value.as_object() else { return false };
    o.get("bootstrapId").and_then(Value::as_str).is_some()
        && crate::wire::account::is_binding(o.get("account").unwrap_or(&Value::Null))
        && o.get("tenantId").and_then(Value::as_str).is_some()
        && o.get("routeId").and_then(Value::as_str).is_some()
        && o.get("entryDeviceId").and_then(Value::as_str).is_some()
        && o.get("entryDevicePublicKey").and_then(Value::as_str).is_some()
        && o.get("endpointDeviceId").and_then(Value::as_str).is_some()
        && o.get("endpointPinRef").and_then(Value::as_str).is_some()
        && o.get("expiresAt").and_then(Value::as_str).is_some()
        && o.get("target").is_some_and(|t| t.is_null() || crate::wire::account::is_action_target(t))
}

/// `AccountDeviceCurrentBindingResponse`.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentBindingResponse {
    pub account: AccountAuthorityBinding,
    pub target: Option<AccountActionTarget>,
    pub authorized_scopes: Vec<String>,
}

fn is_current_binding_response(value: &Value) -> bool {
    let Some(o) = value.as_object() else { return false };
    if !crate::wire::account::is_binding(o.get("account").unwrap_or(&Value::Null)) {
        return false;
    }
    let Some(scopes) = o.get("authorizedScopes").and_then(Value::as_array) else { return false };
    if !scopes.iter().all(|s| s.is_string()) {
        return false;
    }
    match o.get("target") {
        Some(Value::Null) => true,
        Some(t) => crate::wire::account::is_action_target(t)
            && t.get("deviceId").and_then(Value::as_str).is_some_and(|s| !s.is_empty()),
        None => false,
    }
}

/// `AccountStepUpInspectionResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum StepUpInspection {
    Valid { permit_id: String },
    Invalid { reason: String },
}

fn parse_step_up_inspection(value: &Value) -> Option<StepUpInspection> {
    let o = value.as_object()?;
    match o.get("valid")?.as_bool()? {
        true => {
            let permit_id = o.get("permit")?.get("permitId")?.as_str()?;
            if !is_account_step_up_permit_id(permit_id) {
                return None;
            }
            Some(StepUpInspection::Valid {
                permit_id: permit_id.to_string(),
            })
        }
        false => Some(StepUpInspection::Invalid {
            reason: o.get("reason")?.as_str()?.to_string(),
        }),
    }
}

/// `AccountStepUpConsumeResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum StepUpConsume {
    Consumed { replayed: bool },
    Refused { reason: String },
}

fn parse_step_up_consume(value: &Value) -> StepUpConsume {
    let Some(o) = value.as_object() else {
        return StepUpConsume::Refused { reason: "permit_missing".into() };
    };
    match o.get("consumed").and_then(Value::as_bool) {
        Some(true) => StepUpConsume::Consumed {
            replayed: o.get("replayed").and_then(Value::as_bool).unwrap_or(false),
        },
        Some(false) => StepUpConsume::Refused {
            reason: o
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("permit_missing")
                .to_string(),
        },
        None => StepUpConsume::Refused { reason: "permit_missing".into() },
    }
}

/// `AccountEndpointOwnershipClaimPrepareResponse`.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimPrepareResponse {
    pub claim_id: String,
    pub account: AccountAuthorityBinding,
    pub vault_id: String,
    pub target: AccountActionTarget,
    pub expires_at: String,
}

/// `AccountEndpointOwnershipClaimCompleteResponse`.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimCompleteResponse {
    /// The authority response carries no claimId — the claim is bound by the
    /// durable checkpoint. Older checkpoints may have persisted the field.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub claim_id: String,
    pub account: AccountAuthorityBinding,
    pub vault_id: String,
    pub relay_admission: String,
    pub admission_generation: u64,
    pub revocation_revision: u64,
    pub expires_at: Option<String>,
}

/// Signing callback for the endpoint route key (custody-resolved).
pub type EndpointSigner = Arc<dyn Fn(&[u8]) -> Result<Vec<u8>> + Send + Sync>;

/// `AccountEndpointAuthorityClient`.
pub struct EndpointAuthorityClient {
    origin: String,
    tenant_id: String,
    route_id: String,
    device_id: String,
    signer: EndpointSigner,
    agent: ureq::Agent,
    access_token: Option<crate::account::AccessServiceToken>,
}

impl EndpointAuthorityClient {
    pub fn new(
        origin: &str,
        tenant_id: &str,
        route_id: &str,
        device_id: &str,
        signer: EndpointSigner,
        access_token: Option<crate::account::AccessServiceToken>,
    ) -> Result<Self> {
        // Endpoint authority is HTTPS-only without path or credentials —
        // stricter than the desktop client's normalization.
        let normalized = normalize_account_origin(origin)?;
        let url = url::Url::parse(&normalized).map_err(|_| {
            authority_error("account_authority_origin_invalid", "Account authority origin must be an HTTPS origin without a path or credentials.")
        })?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(authority_error(
                "account_authority_origin_invalid",
                "Account authority origin must be an HTTPS origin without a path or credentials.",
            ));
        }
        Ok(Self {
            origin: normalized,
            tenant_id: tenant_id.to_string(),
            route_id: route_id.to_string(),
            device_id: device_id.to_string(),
            signer,
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(std::time::Duration::from_secs(30)))
                .http_status_as_error(false)
                .build()
                .into(),
            access_token,
        })
    }

    fn proof(&self, unsigned: &Value) -> Result<AccountDeviceAuthorityProof> {
        let transcript = {
            // Reuse the wire transcript over the unsigned proof body.
            let p = AccountDeviceAuthorityProof {
                purpose: unsigned.get("purpose").and_then(Value::as_str).unwrap_or("").to_string(),
                tenant_id: self.tenant_id.clone(),
                route_id: self.route_id.clone(),
                device_id: self.device_id.clone(),
                nonce: unsigned.get("nonce").and_then(Value::as_str).unwrap_or("").to_string(),
                bootstrap_id: unsigned.get("bootstrapId").and_then(Value::as_str).map(str::to_string),
                endpoint_pin_ref: unsigned.get("endpointPinRef").and_then(Value::as_str).map(str::to_string),
                claim_id: unsigned.get("claimId").and_then(Value::as_str).map(str::to_string),
                permit_id: unsigned.get("permitId").and_then(Value::as_str).map(str::to_string),
                operation_id: unsigned.get("operationId").and_then(Value::as_str).map(str::to_string),
                peer_device_id: unsigned.get("peerDeviceId").and_then(Value::as_str).map(str::to_string),
                request_digest: unsigned.get("requestDigest").and_then(Value::as_str).map(str::to_string),
                target_digest: unsigned.get("targetDigest").and_then(Value::as_str).map(str::to_string),
                signature: String::new(),
            };
            account_device_authority_transcript(&p)
        };
        let signature = b64u_encode(&(self.signer)(transcript.as_bytes())?);
        Ok(AccountDeviceAuthorityProof {
            purpose: unsigned.get("purpose").and_then(Value::as_str).unwrap_or("").to_string(),
            tenant_id: self.tenant_id.clone(),
            route_id: self.route_id.clone(),
            device_id: self.device_id.clone(),
            nonce: unsigned.get("nonce").and_then(Value::as_str).unwrap_or("").to_string(),
            bootstrap_id: unsigned.get("bootstrapId").and_then(Value::as_str).map(str::to_string),
            endpoint_pin_ref: unsigned.get("endpointPinRef").and_then(Value::as_str).map(str::to_string),
            claim_id: unsigned.get("claimId").and_then(Value::as_str).map(str::to_string),
            permit_id: unsigned.get("permitId").and_then(Value::as_str).map(str::to_string),
            operation_id: unsigned.get("operationId").and_then(Value::as_str).map(str::to_string),
            peer_device_id: unsigned.get("peerDeviceId").and_then(Value::as_str).map(str::to_string),
            request_digest: unsigned.get("requestDigest").and_then(Value::as_str).map(str::to_string),
            target_digest: unsigned.get("targetDigest").and_then(Value::as_str).map(str::to_string),
            signature,
        })
    }

    fn fresh_nonce() -> String {
        let mut nonce = [0u8; 24];
        use rand::RngCore;
        rand::rng().fill_bytes(&mut nonce);
        b64u_encode(&nonce)
    }

    fn post(&self, route: &str, body: &Value) -> Result<Value> {
        let url = format!("{}{}", self.origin.trim_end_matches('/'), route);
        let request = self
            .agent
            .post(&url)
            .header("accept", "application/json")
            .header("cache-control", "no-store")
            .header("content-type", "application/json");
        let request = match &self.access_token {
            Some(token) => request
                .header("CF-Access-Client-Id", &token.client_id)
                .header("CF-Access-Client-Secret", &token.client_secret),
            None => request,
        };
        let response = request
            .send_json(body)
            .map_err(|_| authority_error("account_authority_unavailable", "Account authority could not be reached."))?;
        let status = response.status().as_u16();
        let text = response
            .into_body()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_string()
            .map_err(|_| authority_error("account_authority_response_invalid", "Account authority returned an invalid response."))?;
        let parsed: Value = serde_json::from_str(&text)
            .map_err(|_| authority_error("account_authority_response_invalid", "Account authority returned an invalid response."))?;
        if !(200..300).contains(&status) {
            let code = parsed
                .get("error")
                .and_then(|e| e.get("code"))
                .and_then(|c| c.as_str())
                .unwrap_or("account_authority_refused");
            return Err(authority_error(code, "Account authority refused the endpoint request."));
        }
        Ok(parsed)
    }

    /// `currentBinding` — fail-closed `None` when the account does not match.
    pub fn current_binding(&self, account_id: &str, peer_device_id: &str) -> Result<Option<AccountAuthorityBinding>> {
        let proof = self.proof(&json!({
            "purpose": "current_binding",
            "nonce": Self::fresh_nonce(),
            "peerDeviceId": peer_device_id,
        }))?;
        let value = self.post(&routes::device_current_binding(), &json!({
            "peerDeviceId": peer_device_id,
            "proof": serde_json::to_value(&proof).unwrap_or(Value::Null),
        }))?;
        if !is_current_binding_response(&value) {
            return Ok(None);
        }
        let parsed: CurrentBindingResponse = serde_json::from_value(value)
            .map_err(|_| authority_error("account_authority_response_invalid", "Account authority returned an invalid current-binding response."))?;
        if parsed.account.account_id != account_id {
            return Ok(None);
        }
        Ok(Some(parsed.account))
    }

    /// `currentDeviceAuthorization` — full response, fail-closed on shape.
    pub fn current_device_authorization(&self, peer_device_id: &str) -> Result<CurrentBindingResponse> {
        let proof = self.proof(&json!({
            "purpose": "current_binding",
            "nonce": Self::fresh_nonce(),
            "peerDeviceId": peer_device_id,
        }))?;
        let value = self.post(&routes::device_current_binding(), &json!({
            "peerDeviceId": peer_device_id,
            "proof": serde_json::to_value(&proof).unwrap_or(Value::Null),
        }))?;
        if !is_current_binding_response(&value) {
            return Err(authority_error("account_authority_response_invalid", "Account authority returned an invalid current-binding response."));
        }
        serde_json::from_value(value)
            .map_err(|_| authority_error("account_authority_response_invalid", "Account authority returned an invalid current-binding response."))
    }

    /// `managedRoute` — the canonical route owner row for this endpoint key.
    pub fn managed_route(&self) -> Result<Option<ManagedRouteBinding>> {
        let proof = self.proof(&json!({
            "purpose": "managed_route",
            "nonce": Self::fresh_nonce(),
        }))?;
        let value = self.post(&routes::device_managed_route(), &json!({
            "proof": serde_json::to_value(&proof).unwrap_or(Value::Null),
        }))?;
        let route = value.get("managedRoute").cloned().unwrap_or(Value::Null);
        if !is_managed_route(&route) {
            return Ok(None);
        }
        serde_json::from_value(route).map(Some).map_err(|_| {
            authority_error("account_authority_response_invalid", "Account authority returned an invalid managed-route response.")
        })
    }

    /// `inspectPendingPairing`.
    pub fn inspect_pending_pairing(&self, bootstrap_id: &str) -> Result<Option<PendingPairing>> {
        let proof = self.proof(&json!({
            "purpose": "inspect_pairing",
            "nonce": Self::fresh_nonce(),
            "bootstrapId": bootstrap_id,
        }))?;
        let value = self.post(&routes::device_pending_pairing_inspect(), &json!({
            "bootstrapId": bootstrap_id,
            "proof": serde_json::to_value(&proof).unwrap_or(Value::Null),
        }))?;
        if value.is_null() {
            return Ok(None);
        }
        if !is_pending_pairing(&value) {
            return Ok(None);
        }
        serde_json::from_value(value).map(Some).map_err(|_| {
            authority_error("account_authority_response_invalid", "Account authority returned an invalid pending-pairing response.")
        })
    }

    /// `publishPairingTarget`.
    pub fn publish_pairing_target(&self, bootstrap_id: &str, target: &AccountActionTarget) -> Result<Option<PendingPairing>> {
        let proof = self.proof(&json!({
            "purpose": "publish_pairing_target",
            "nonce": Self::fresh_nonce(),
            "bootstrapId": bootstrap_id,
            "targetDigest": target_digest(target),
        }))?;
        let value = self.post(&routes::device_pairing_target_publish(), &json!({
            "bootstrapId": bootstrap_id,
            "target": serde_json::to_value(target).unwrap_or(Value::Null),
            "proof": serde_json::to_value(&proof).unwrap_or(Value::Null),
        }))?;
        if value.is_null() {
            return Ok(None);
        }
        if !is_pending_pairing(&value) {
            return Ok(None);
        }
        serde_json::from_value(value).map(Some).map_err(|_| {
            authority_error("account_authority_response_invalid", "Account authority returned an invalid pending-pairing response.")
        })
    }

    /// `inspectStepUpPermit`.
    pub fn inspect_step_up_permit(
        &self,
        account: &AccountAuthorityBinding,
        permit_id: &str,
        purpose: &str,
        target: &AccountActionTarget,
        bootstrap_id: Option<&str>,
    ) -> Result<StepUpInspection> {
        if !is_account_step_up_permit_id(permit_id) {
            return Ok(StepUpInspection::Invalid { reason: "permit_missing".into() });
        }
        let mut unsigned = json!({
            "purpose": "inspect_step_up",
            "nonce": Self::fresh_nonce(),
            "permitId": permit_id,
            "targetDigest": target_digest(target),
        });
        if let Some(id) = bootstrap_id {
            unsigned["bootstrapId"] = Value::from(id);
        }
        let proof = self.proof(&unsigned)?;
        let value = self.post(&routes::device_step_up_inspect(), &json!({
            "account": serde_json::to_value(account).unwrap_or(Value::Null),
            "permitId": permit_id,
            "purpose": purpose,
            "target": serde_json::to_value(target).unwrap_or(Value::Null),
            "bootstrapId": bootstrap_id,
            "proof": serde_json::to_value(&proof).unwrap_or(Value::Null),
        }))?;
        parse_step_up_inspection(&value).ok_or_else(|| {
            authority_error("account_authority_response_invalid", "Account authority returned an invalid step-up decision.")
        })
    }

    /// `consumeStepUpPermit`.
    pub fn consume_step_up_permit(
        &self,
        account: &AccountAuthorityBinding,
        permit_id: &str,
        purpose: &str,
        target: &AccountActionTarget,
        bootstrap_id: Option<&str>,
        operation_id: &str,
    ) -> Result<StepUpConsume> {
        if !is_account_step_up_permit_id(permit_id) {
            return Ok(StepUpConsume::Refused { reason: "permit_missing".into() });
        }
        let mut unsigned = json!({
            "purpose": "consume_step_up",
            "nonce": Self::fresh_nonce(),
            "permitId": permit_id,
            "operationId": operation_id,
            "targetDigest": target_digest(target),
        });
        if let Some(id) = bootstrap_id {
            unsigned["bootstrapId"] = Value::from(id);
        }
        let proof = self.proof(&unsigned)?;
        let value = self.post(&routes::device_step_up_consume(), &json!({
            "account": serde_json::to_value(account).unwrap_or(Value::Null),
            "permitId": permit_id,
            "purpose": purpose,
            "target": serde_json::to_value(target).unwrap_or(Value::Null),
            "bootstrapId": bootstrap_id,
            "operationId": operation_id,
            "proof": serde_json::to_value(&proof).unwrap_or(Value::Null),
        }))?;
        Ok(parse_step_up_consume(&value))
    }

    /// `completePairing`.
    pub fn complete_pairing(
        &self,
        account: &AccountAuthorityBinding,
        bootstrap_id: &str,
        operation_id: &str,
        target: &AccountActionTarget,
    ) -> Result<PairingCompletion> {
        let proof = self.proof(&json!({
            "purpose": "complete_pairing",
            "nonce": Self::fresh_nonce(),
            "bootstrapId": bootstrap_id,
            "operationId": operation_id,
            "targetDigest": target_digest(target),
        }))?;
        let value = self.post(&routes::device_pairing_complete(), &json!({
            "account": serde_json::to_value(account).unwrap_or(Value::Null),
            "bootstrapId": bootstrap_id,
            "operationId": operation_id,
            "target": serde_json::to_value(target).unwrap_or(Value::Null),
            "proof": serde_json::to_value(&proof).unwrap_or(Value::Null),
        }))?;
        let completed = value.get("completed").and_then(Value::as_bool);
        let relay_active = value.get("relayAdmissionActive").and_then(Value::as_bool);
        match (completed, relay_active) {
            (Some(c), Some(r)) => Ok(PairingCompletion { completed: c, relay_admission_active: r }),
            _ => Ok(PairingCompletion { completed: false, relay_admission_active: false }),
        }
    }

    /// `signClaimProof` — narrowly scoped proof for ownership claim completion.
    pub fn sign_claim_proof(
        &self,
        claim_id: &str,
        permit_id: &str,
        operation_id: &str,
        endpoint_pin_ref: &str,
        target: &AccountActionTarget,
    ) -> Result<AccountDeviceAuthorityProof> {
        if !is_account_step_up_permit_id(permit_id) {
            return Err(authority_error(
                "account_authority_permit_invalid",
                "The step-up permit does not match the account authority format.",
            ));
        }
        self.proof(&json!({
            "purpose": "claim_endpoint",
            "nonce": Self::fresh_nonce(),
            "claimId": claim_id,
            "permitId": permit_id,
            "operationId": operation_id,
            "endpointPinRef": endpoint_pin_ref,
            "targetDigest": target_digest(target),
        }))
    }

    /// `device/endpoints/claim/prepare` — first half of ownership claim;
    /// carries the caller's desktop session proof, not the endpoint proof.
    pub fn claim_prepare(
        &self,
        endpoint_public_key: &str,
        endpoint_pin_ref: &str,
        desktop_proof: &Value,
    ) -> Result<Value> {
        self.post(&routes::device_endpoint_claim_prepare(), &json!({
            "routeId": self.route_id,
            "endpointDeviceId": self.device_id,
            "endpointPublicKey": endpoint_public_key,
            "endpointPinRef": endpoint_pin_ref,
            "mode": "personal",
            "desktopProof": desktop_proof,
        }))
    }

    /// `device/endpoints/claim/complete`.
    pub fn claim_complete(
        &self,
        claim_id: &str,
        permit_id: &str,
        operation_id: &str,
        endpoint_proof: &AccountDeviceAuthorityProof,
        desktop_proof: &Value,
    ) -> Result<Value> {
        self.post(&routes::device_endpoint_claim_complete(), &json!({
            "claimId": claim_id,
            "permitId": permit_id,
            "operationId": operation_id,
            "endpointProof": serde_json::to_value(endpoint_proof).unwrap_or(Value::Null),
            "desktopProof": desktop_proof,
        }))
    }
}

/// `completePairing` result.
#[derive(Debug, Clone, PartialEq)]
pub struct PairingCompletion {
    pub completed: bool,
    pub relay_admission_active: bool,
}
