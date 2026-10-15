//! Desktop account client — port of `account-client.ts`.
//!
//! Main-process HTTP client for the account worker's installed-Entry
//! handoff. Browser cookies never cross into this client. The only browser
//! URL accepted is the configured HTTPS origin's `/account` page with one
//! opaque transaction id; PKCE verifiers and completion material stay in
//! trusted main custody.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;
use url::Url;

use crate::b64::b64u_encode;
use crate::canonical::canonical_json;
use crate::error::{entry_error, Result};
use crate::keys::generate_opaque_id;
use crate::wire::account::{
    account_desktop_session_transcript, account_device_authority_transcript,
    canonical_account_action_target,
    is_account_step_up_permit_id, is_action_target, is_binding, is_current_binding,
    AccountActionTarget, AccountAuthorityBinding, AccountDeviceAuthorityProof,
    AccountDeviceCurrentBinding,
};
use crate::wire::common::is_plain_object;

pub const ACCOUNT_API_BASE: &str = "/api/account";
pub const ROUTE_DESKTOP_TRANSACTION: &str = "/api/account/desktop/transactions";
pub const ROUTE_DESKTOP_CODE_APPROVE: &str = "/api/account/desktop/code/approve";
pub const ROUTE_DESKTOP_PAIRING_BOOTSTRAP: &str = "/api/account/desktop/pairing/bootstrap";
pub const ROUTE_DESKTOP_WRITER_PREPARE: &str = "/api/account/desktop/vault-writers/prepare";
pub const ROUTE_DESKTOP_WRITER_COMPLETE: &str = "/api/account/desktop/vault-writers/complete";
pub const ROUTE_DEVICE_REVOKE: &str = "/api/account/device/revoke";
pub const ROUTE_DEVICE_CURRENT_BINDING: &str = "/api/account/device/current-binding";
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;

fn is_opaque_id(s: &str) -> bool {
    s.len() >= 2
        && s.len() <= 128
        && s.bytes().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b':'))
}

fn valid_verifier(v: &str) -> bool {
    (40..=64).contains(&v.len()) && v.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// `XXXX-XXXX` Crockford alphabet — the only accepted user-facing code shape.
fn is_user_code(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 9
        && b[4] == b'-'
        && b.iter().enumerate().all(|(i, c)| {
            i == 4 || matches!(c, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z')
        })
}

fn safe_error_code(v: &str) -> String {
    if v.len() <= 64 && v.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b':' | b'-')) {
        v.to_string()
    } else {
        "unknown".into()
    }
}

/// Bare HTTPS origin only — no credentials, path, query or fragment.
pub fn normalize_account_origin(value: &str) -> Result<String> {
    let url = Url::parse(value).map_err(|_| {
        entry_error("account_origin_invalid", "The account authentication origin is not a valid HTTPS origin.")
    })?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(entry_error(
            "account_origin_invalid",
            "The account authentication origin must be a bare HTTPS origin.",
        ));
    }
    Ok(url.origin().ascii_serialization())
}

/// The only accepted browser URL: `<origin>/account?code=<userCode>` —
/// one user-facing device-code param and nothing else.
pub fn validate_account_browser_url(value: &str, origin: &str, user_code: &str) -> Result<String> {
    let url = Url::parse(value).map_err(|_| {
        entry_error("account_browser_url_invalid", "The account service returned an invalid browser URL.")
    })?;
    let expected = normalize_account_origin(origin)?;
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if url.origin().ascii_serialization() != expected
        || url.path() != "/account"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || pairs.len() != 1
        || pairs[0].0 != "code"
        || pairs[0].1 != user_code
    {
        return Err(entry_error(
            "account_browser_url_invalid",
            "The account service returned a browser URL outside the configured account transaction.",
        ));
    }
    Ok(url.to_string())
}

/// base64url SHA-256 of a value's canonical JSON — desktop proof body digest.
pub fn account_desktop_proof_digest(value: &Value) -> String {
    b64u_encode(&Sha256::digest(canonical_json(value).as_bytes())[..])
}

/// The custody-backed desktop session credential: the signing key lives in
/// OS custody and is exposed only as a signer.
pub struct DesktopSessionProof {
    pub credential: String,
    pub client_public_key: String,
    pub nonce: String,
    pub body_digest: String,
    pub signature: String,
}

impl DesktopSessionProof {
    pub fn to_json(&self) -> Value {
        json!({
            "credential": self.credential,
            "clientPublicKey": self.client_public_key,
            "nonce": self.nonce,
            "bodyDigest": self.body_digest,
            "signature": self.signature,
        })
    }
}

/// Sign a desktop-account proof exactly as `signDesktopAccountProof` does:
/// the transcript binds method, pathname, account binding, client key,
/// credential digest, nonce and body digest.
pub fn sign_desktop_account_proof(
    pathname: &str,
    account: &AccountAuthorityBinding,
    credential: &str,
    client_public_key: &str,
    body: &Value,
    nonce: Option<&str>,
    sign: &dyn Fn(&[u8]) -> Vec<u8>,
) -> DesktopSessionProof {
    let nonce = nonce
        .map(String::from)
        .unwrap_or_else(|| format!("desktop.{}", b64u_encode(&crate::keys::random_bytes(24))));
    let body_digest = account_desktop_proof_digest(body);
    let credential_digest = b64u_encode(&Sha256::digest(credential.as_bytes())[..]);
    let transcript = account_desktop_session_transcript(
        "POST",
        pathname,
        account,
        client_public_key,
        &credential_digest,
        &nonce,
        &body_digest,
    );
    DesktopSessionProof {
        credential: credential.to_string(),
        client_public_key: client_public_key.to_string(),
        nonce,
        body_digest,
        signature: b64u_encode(&sign(transcript.as_bytes())),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAccountTransaction {
    pub transaction_id: String,
    /// PKCE verifier — stays in memory/custody, never leaves this process.
    pub verifier: String,
    pub browser_url: String,
    /// User-facing `XXXX-XXXX` code the browser page binds to this transaction.
    pub user_code: String,
    pub purpose: String,
    pub target: Option<AccountActionTarget>,
}

/// Account session credential for authenticated desktop mutations.
#[derive(Debug, Clone)]
pub struct DesktopAuth {
    pub account: AccountAuthorityBinding,
    pub credential: String,
}

/// `AccountDeviceAuthorizationDecision` — the role-neutral current-grant
/// check result for one exact personal route.
#[derive(Debug)]
pub enum DeviceAuthorizationDecision {
    Current(AccountDeviceCurrentBinding),
    Revoked,
    #[allow(dead_code)]
    Denied,
    Unavailable,
}

/// Input for `check_device_authorization` — mirrors the TS `check` input.
pub struct DeviceAuthorizationCheck<'a> {
    pub tenant_id: &'a str,
    pub route_id: &'a str,
    /// The locally enrolled device id — signs the request.
    pub device_id: &'a str,
    /// The counterpart device whose current grant is being checked.
    pub peer_device_id: &'a str,
    pub binding: &'a AccountAuthorityBinding,
    /// Exact Entry grants retained by the local pairing authority.
    pub authorized_targets: &'a [AccountActionTarget],
    /// Optional required scope (e.g. `"peer:message"`).
    pub scope: Option<&'a str>,
}

/// Optional Cloudflare Access service-token pair attached to every account
/// request — for deployments where the account surface sits behind an Access
/// application. Both values come from the deployment operator, not the user.
#[derive(Debug, Clone)]
pub struct AccessServiceToken {
    pub client_id: String,
    pub client_secret: String,
}

pub struct DesktopAccountClient {
    origin: String,
    agent: ureq::Agent,
    access_token: Option<AccessServiceToken>,
}

impl DesktopAccountClient {
    pub fn new(origin: &str, access_token: Option<AccessServiceToken>) -> Result<Self> {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(30)))
            .build();
        Ok(Self {
            origin: normalize_account_origin(origin)?,
            agent: config.into(),
            access_token,
        })
    }

    fn post(&self, route: &str) -> ureq::RequestBuilder<ureq::typestate::WithBody> {
        let request = self
            .agent
            .post(&self.url(route))
            .header("accept", "application/json")
            .header("cache-control", "no-store")
            .header("content-type", "application/json");
        match &self.access_token {
            Some(token) => request
                .header("CF-Access-Client-Id", &token.client_id)
                .header("CF-Access-Client-Secret", &token.client_secret),
            None => request,
        }
    }

    pub fn account_page_url(&self) -> String {
        format!("{}/account", self.origin)
    }

    fn url(&self, route: &str) -> String {
        format!("{}{}", self.origin, route)
    }

    /// POST JSON → JSON, bounded to 1 MiB. Non-2xx maps to
    /// `account_request_refused` carrying the worker's error code.
    fn request(&self, route: &str, body: &Value) -> Result<Value> {
        let response = self
            .post(route)
            .send_json(body)
            .map_err(|e| {
                entry_error("account_service_unreachable", "The account service could not be reached.").caused_by(e)
            })?;
        let status = response.status().as_u16();
        let text = response
            .into_body()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_string()
            .map_err(|e| {
                if matches!(e, ureq::Error::BodyExceedsLimit(_)) {
                    entry_error("account_response_oversize", "The account service response exceeded the size limit.")
                } else {
                    entry_error("account_response_invalid", "The account service returned an unreadable response.").caused_by(e)
                }
            })?;
        let parsed: Value = serde_json::from_str(&text).map_err(|_| {
            entry_error("account_response_invalid", "The account service returned invalid JSON.")
        })?;
        if !(200..300).contains(&status) {
            let code = parsed
                .get("error")
                .and_then(|e| e.get("code"))
                .and_then(|c| c.as_str())
                .map(safe_error_code)
                .unwrap_or_else(|| format!("http_{status}"));
            return Err(entry_error(
                "account_request_refused",
                format!("The account service refused the request ({code})."),
            ));
        }
        if !is_plain_object(&parsed) {
            return Err(entry_error("account_response_invalid", "The account service returned an invalid response."));
        }
        Ok(parsed)
    }

    /// Bounded JSON POST to an arbitrary account route — the `accountPost`
    /// shape the personal endpoint claim/revoke flows need.
    pub fn post_json(&self, route: &str, body: &Value) -> Result<Value> {
        self.request(route, body)
    }

    /// Create a desktop login or step-up transaction; the returned browser
    /// URL is validated against the configured origin before handoff.
    pub fn create_transaction(
        &self,
        purpose: &str,
        client_public_key: &str,
        target: Option<&AccountActionTarget>,
        action_purpose: Option<&str>,
        bootstrap_id: Option<&str>,
        claim_id: Option<&str>,
        desktop_auth: Option<(&DesktopAuth, &dyn Fn(&[u8]) -> Vec<u8>)>,
    ) -> Result<DesktopAccountTransaction> {
        if (purpose == "step_up") != target.is_some()
            || (purpose == "step_up") != action_purpose.is_some()
            || bootstrap_id.is_some_and(|b| !is_opaque_id(b))
            || claim_id.is_some_and(|c| !is_opaque_id(c))
            || (action_purpose == Some("pair_device") && bootstrap_id.is_some() == claim_id.is_some())
            || (action_purpose == Some("grant_access") && (bootstrap_id.is_some() || claim_id.is_some()))
        {
            return Err(entry_error(
                "account_transaction_invalid",
                "An action target is required only for a step-up transaction.",
            ));
        }
        let verifier = b64u_encode(&crate::keys::random_bytes(32));
        let verifier_digest = b64u_encode(&Sha256::digest(verifier.as_bytes())[..]);
        let request = if purpose == "login" {
            json!({
                "purpose": "login",
                "verifierDigest": verifier_digest,
                "clientPublicKey": client_public_key,
                "target": Value::Null,
            })
        } else {
            let Some((auth, sign)) = desktop_auth else {
                return Err(entry_error(
                    "account_login_required",
                    "A current OS-custodied account session is required for this authorization.",
                ));
            };
            let mut shared = json!({
                "purpose": "step_up",
                "verifierDigest": verifier_digest,
                "clientPublicKey": client_public_key,
                "target": serde_json::to_value(target.unwrap())?,
            });
            {
                let o = shared.as_object_mut().unwrap();
                o.insert("actionPurpose".into(), action_purpose.unwrap().into());
                if let Some(b) = bootstrap_id {
                    o.insert("bootstrapId".into(), b.into());
                }
                if let Some(c) = claim_id {
                    o.insert("claimId".into(), c.into());
                }
            }
            let proof = sign_desktop_account_proof(
                ROUTE_DESKTOP_TRANSACTION,
                &auth.account,
                &auth.credential,
                client_public_key,
                &shared,
                None,
                sign,
            );
            shared.as_object_mut().unwrap().insert("desktopProof".into(), proof.to_json());
            shared
        };
        let response = self.request(ROUTE_DESKTOP_TRANSACTION, &request)?;
        let transaction_id = response
            .get("transactionId")
            .and_then(|v| v.as_str())
            .filter(|id| is_opaque_id(id))
            .ok_or_else(|| {
                entry_error("account_transaction_invalid", "The account worker returned an invalid transaction reference.")
            })?;
        let user_code = response
            .get("userCode")
            .and_then(|v| v.as_str())
            .filter(|c| is_user_code(c))
            .ok_or_else(|| {
                entry_error("account_transaction_invalid", "The account worker returned an invalid device code.")
            })?;
        let browser_url = response
            .get("browserUrl")
            .and_then(|v| v.as_str())
            .and_then(|u| validate_account_browser_url(u, &self.origin, user_code).ok())
            .ok_or_else(|| {
                entry_error("account_browser_url_invalid", "The account service returned a browser URL outside the configured account transaction.")
            })?;
        Ok(DesktopAccountTransaction {
            transaction_id: transaction_id.to_string(),
            verifier,
            browser_url,
            user_code: user_code.to_string(),
            purpose: purpose.to_string(),
            target: target.cloned(),
        })
    }

    /// Poll the transaction for completion. `PollOutcome` mirrors the
    /// worker's `state` vocabulary.
    pub fn poll_transaction(&self, transaction_id: &str, verifier: &str) -> Result<TransactionPoll> {
        if !is_opaque_id(transaction_id) || !valid_verifier(verifier) {
            return Err(entry_error("account_transaction_invalid", "The account transaction reference is invalid."));
        }
        let route = format!(
            "{}/{}/poll",
            ROUTE_DESKTOP_TRANSACTION,
            urlencoding::encode(transaction_id)
        );
        let response = self.request(&route, &json!({ "verifier": verifier }))?;
        parse_poll_response(&response).ok_or_else(|| {
            entry_error("account_transaction_invalid", "The account worker returned an invalid transaction result.")
        })
    }

    /// Acknowledge transaction consumption.
    pub fn acknowledge_transaction(&self, transaction_id: &str, verifier: &str) -> Result<()> {
        if !is_opaque_id(transaction_id) || !valid_verifier(verifier) {
            return Err(entry_error("account_transaction_invalid", "The account transaction reference is invalid."));
        }
        let route = format!(
            "{}/{}/acknowledge",
            ROUTE_DESKTOP_TRANSACTION,
            urlencoding::encode(transaction_id)
        );
        self.request(&route, &json!({ "verifier": verifier }))?;
        Ok(())
    }

    /// Approve a pending `XXXX-XXXX` desktop code transaction (login or
    /// step-up) on behalf of this signed-in device — the headless
    /// counterpart of the browser approval card.
    pub fn approve_device_code(
        &self,
        code: &str,
        auth: &DesktopAuth,
        client_public_key: &str,
        sign: &dyn Fn(&[u8]) -> Vec<u8>,
    ) -> Result<()> {
        let normalized: String = code
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| c.to_ascii_uppercase())
            .collect();
        if normalized.len() != 8 {
            return Err(entry_error("device_code_invalid", "The device code is invalid or expired."));
        }
        let mut body = json!({ "code": normalized });
        let proof = sign_desktop_account_proof(
            ROUTE_DESKTOP_CODE_APPROVE,
            &auth.account,
            &auth.credential,
            client_public_key,
            &body,
            None,
            sign,
        );
        body.as_object_mut()
            .unwrap()
            .insert("desktopProof".into(), proof.to_json());
        let response = self.request(ROUTE_DESKTOP_CODE_APPROVE, &body)?;
        if response.get("approved").and_then(|v| v.as_bool()) != Some(true) {
            return Err(entry_error(
                "account_approval_invalid",
                "The account worker returned an invalid approval result.",
            ));
        }
        Ok(())
    }

    /// Request the restricted pairing bootstrap for one invite target. The
    /// request body must already carry the signed desktop proof
    /// (`sign_desktop_pairing_bootstrap`).
    pub fn create_pairing_bootstrap(&self, request: &Value) -> Result<PairingBootstrapResponse> {
        if request.get("mode").and_then(|v| v.as_str()) != Some("personal") {
            return Err(entry_error(
                "team_not_available",
                "Account-managed teams require an available paid team subscription.",
            ));
        }
        let response = self.request(ROUTE_DESKTOP_PAIRING_BOOTSTRAP, request)?;
        let invalid = || {
            entry_error("account_bootstrap_invalid", "The account worker returned an invalid pairing bootstrap.")
        };
        let account = response.get("account").cloned().filter(|v| is_binding(v)).ok_or_else(invalid)?;
        let binding: AccountAuthorityBinding = serde_json::from_value(account).map_err(|_| invalid())?;
        if !is_opaque_id(&binding.account_id) || binding.auth_epoch < 1 {
            return Err(invalid());
        }
        let resp = PairingBootstrapResponse {
            bootstrap_id: response.get("bootstrapId").and_then(|v| v.as_str()).filter(|s| is_opaque_id(s)).ok_or_else(invalid)?.into(),
            account: binding,
            tenant_id: response.get("tenantId").and_then(|v| v.as_str()).ok_or_else(invalid)?.into(),
            route_id: response.get("routeId").and_then(|v| v.as_str()).ok_or_else(invalid)?.into(),
            entry_device_id: response.get("entryDeviceId").and_then(|v| v.as_str()).ok_or_else(invalid)?.into(),
            endpoint_device_id: response.get("endpointDeviceId").and_then(|v| v.as_str()).filter(|s| is_opaque_id(s)).ok_or_else(invalid)?.into(),
            endpoint_pin_ref: response.get("endpointPinRef").and_then(|v| v.as_str()).ok_or_else(invalid)?.into(),
            role: response.get("role").and_then(|v| v.as_str()).ok_or_else(invalid)?.into(),
            mode: response.get("mode").and_then(|v| v.as_str()).ok_or_else(invalid)?.into(),
            admission_generation: response.get("admissionGeneration").and_then(|v| v.as_u64()).filter(|g| *g >= 1).ok_or_else(invalid)?,
            revocation_revision: response.get("revocationRevision").and_then(|v| v.as_u64()).ok_or_else(invalid)?,
            relay_admission: response
                .get("relayAdmission")
                .and_then(|v| v.as_str())
                .filter(|s| (32..=8192).contains(&s.len()))
                .ok_or_else(invalid)?
                .into(),
            expires_at: response
                .get("expiresAt")
                .and_then(|v| v.as_str())
                .filter(|s| {
                    chrono::DateTime::parse_from_rfc3339(s)
                        .map(|e| e > chrono::Utc::now())
                        .unwrap_or(false)
                })
                .ok_or_else(invalid)?
                .into(),
        };
        // Cross-field binding: the response must echo the request's targets.
        if resp.role != "entry"
            || resp.tenant_id != request.get("tenantId").and_then(|v| v.as_str()).unwrap_or("")
            || resp.route_id != request.get("routeId").and_then(|v| v.as_str()).unwrap_or("")
            || resp.entry_device_id != request.get("entryDeviceId").and_then(|v| v.as_str()).unwrap_or("")
            || resp.endpoint_pin_ref != request.get("endpointPinRef").and_then(|v| v.as_str()).unwrap_or("")
            || resp.mode != request.get("mode").and_then(|v| v.as_str()).unwrap_or("")
        {
            return Err(invalid());
        }
        Ok(resp)
    }

    /// Revoke a paired device/route through the account authority.
    pub fn revoke_device(
        &self,
        operation_id: &str,
        tenant_id: &str,
        route_id: &str,
        device_id: &str,
        auth: &DesktopAuth,
        client_public_key: &str,
        sign: &dyn Fn(&[u8]) -> Vec<u8>,
    ) -> Result<DeviceRevokeReceipt> {
        let body = json!({
            "operationId": operation_id,
            "tenantId": tenant_id,
            "routeId": route_id,
            "deviceId": device_id,
        });
        let proof = sign_desktop_account_proof(
            ROUTE_DEVICE_REVOKE,
            &auth.account,
            &auth.credential,
            client_public_key,
            &body,
            None,
            sign,
        );
        let mut request = body;
        request
            .as_object_mut()
            .unwrap()
            .insert("desktopProof".into(), proof.to_json());
        let response = self.request(ROUTE_DEVICE_REVOKE, &request)?;
        let receipt = DeviceRevokeReceipt {
            authority_revoked: response.get("authorityRevoked").and_then(|v| v.as_bool()).unwrap_or(false),
            operation_id: response.get("operationId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            target: response.get("target").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            tenant_id: response.get("tenantId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            route_id: response.get("routeId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            device_id: response.get("deviceId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            enforcement: response.get("enforcement").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        };
        if !receipt.authority_revoked
            || receipt.operation_id != operation_id
            || (receipt.target != "route" && receipt.target != "device")
            || receipt.tenant_id != tenant_id
            || receipt.route_id != route_id
            || receipt.device_id != device_id
            || (receipt.enforcement != "pending" && receipt.enforcement != "complete")
        {
            return Err(entry_error(
                "account_device_revoke_invalid",
                "The account service returned a receipt for a different device revoke operation.",
            ));
        }
        Ok(receipt)
    }

    /// POST a device-authority request that surfaces the worker's error code
    /// (`Err(Some(code))`) separately from transport/parse failures
    /// (`Err(None)`) — the authorization decision table keys on it.
    fn request_with_code(&self, route: &str, body: &Value) -> std::result::Result<Value, Option<String>> {
        let response = self
            .post(route)
            .send_json(body)
            .map_err(|_| None)?;
        let status = response.status().as_u16();
        let text = response
            .into_body()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_string()
            .map_err(|_| None)?;
        let parsed: Value = serde_json::from_str(&text).map_err(|_| None)?;
        if !(200..300).contains(&status) {
            let code = parsed
                .get("error")
                .and_then(|e| e.get("code"))
                .and_then(|c| c.as_str())
                .map(safe_error_code);
            return Err(code);
        }
        if !is_plain_object(&parsed) {
            return Err(None);
        }
        Ok(parsed)
    }

    /// `AccountDeviceAuthorizationClient.check` — role-neutral current-grant
    /// check for one exact personal route. The local device key signs the
    /// request; the authority checks the counterpart.
    pub fn check_device_authorization(
        &self,
        input: &DeviceAuthorizationCheck<'_>,
        keypair: &crate::keys::Ed25519Keypair,
    ) -> DeviceAuthorizationDecision {
        if input.authorized_targets.is_empty()
            || input.authorized_targets.iter().any(|t| {
                t.tenant_id != input.tenant_id || t.route_id != input.route_id
            })
        {
            return DeviceAuthorizationDecision::Revoked;
        }
        let mut proof = AccountDeviceAuthorityProof {
            purpose: "current_binding".into(),
            tenant_id: input.tenant_id.into(),
            route_id: input.route_id.into(),
            device_id: input.device_id.into(),
            nonce: b64u_encode(&crate::keys::random_bytes(24)),
            bootstrap_id: None,
            endpoint_pin_ref: None,
            claim_id: None,
            permit_id: None,
            operation_id: None,
            request_digest: None,
            peer_device_id: Some(input.peer_device_id.into()),
            target_digest: None,
            signature: String::new(),
        };
        let transcript = account_device_authority_transcript(&proof);
        proof.signature = b64u_encode(&keypair.sign(transcript.as_bytes()));
        let body = json!({ "peerDeviceId": input.peer_device_id, "proof": proof });
        let response = match self.request_with_code(ROUTE_DEVICE_CURRENT_BINDING, &body) {
            Ok(v) => v,
            Err(code) => {
                return match code.as_deref() {
                    Some("not_found") => DeviceAuthorizationDecision::Revoked,
                    Some("forbidden") => DeviceAuthorizationDecision::Denied,
                    _ => DeviceAuthorizationDecision::Unavailable,
                };
            }
        };
        if !is_current_binding(&response) {
            return DeviceAuthorizationDecision::Unavailable;
        }
        let response: AccountDeviceCurrentBinding = match serde_json::from_value(response) {
            Ok(v) => v,
            Err(_) => return DeviceAuthorizationDecision::Unavailable,
        };
        if response.account.account_id != input.binding.account_id
            || response.account.auth_epoch != input.binding.auth_epoch
        {
            return DeviceAuthorizationDecision::Revoked;
        }
        let Some(target) = &response.target else {
            return DeviceAuthorizationDecision::Revoked;
        };
        let matches = input
            .authorized_targets
            .iter()
            .any(|t| canonical_account_action_target(t) == canonical_account_action_target(target));
        if !matches {
            return DeviceAuthorizationDecision::Revoked;
        }
        let mut authorized_scopes = std::collections::BTreeSet::new();
        for t in input.authorized_targets {
            for s in &t.scopes {
                authorized_scopes.insert(s.as_str());
            }
        }
        let mut current_scopes = std::collections::BTreeSet::new();
        for s in &response.authorized_scopes {
            // A duplicate or out-of-grant scope is revocation evidence.
            if !current_scopes.insert(s.as_str()) || !authorized_scopes.contains(s.as_str()) {
                return DeviceAuthorizationDecision::Revoked;
            }
        }
        if target.scopes.iter().any(|s| !current_scopes.contains(s.as_str()))
            || input.scope.is_some_and(|s| !current_scopes.contains(s))
        {
            return DeviceAuthorizationDecision::Revoked;
        }
        DeviceAuthorizationDecision::Current(response)
    }

    /// Prepare an account-managed vault writer rotation.
    pub fn prepare_vault_writer_rotation(&self, request: &Value) -> Result<Value> {
        let response = self.request(ROUTE_DESKTOP_WRITER_PREPARE, request)?;
        let ok = is_plain_object(&response)
            && response.get("operationId").and_then(|v| v.as_str()) == request.get("operationId").and_then(|v| v.as_str())
            && response.get("account").is_some_and(is_binding)
            && response.get("target").is_some_and(is_action_target)
            && response.get("expiresAt").and_then(|v| v.as_str()).is_some_and(|s| {
                chrono::DateTime::parse_from_rfc3339(s).is_ok()
            });
        if !ok {
            return Err(entry_error(
                "account_vault_rotation_invalid",
                "The account worker returned an invalid vault writer target.",
            ));
        }
        Ok(response)
    }

    /// Complete an account-managed vault writer rotation.
    pub fn complete_vault_writer_rotation(&self, request: &Value) -> Result<Value> {
        let response = self.request(ROUTE_DESKTOP_WRITER_COMPLETE, request)?;
        let ok = is_plain_object(&response)
            && matches!(response.get("state").and_then(|v| v.as_str()), Some("pending") | Some("complete"))
            && response.get("account").is_some_and(is_binding)
            && response.get("operationId").and_then(|v| v.as_str()) == request.get("operationId").and_then(|v| v.as_str())
            && response.get("vaultId").and_then(|v| v.as_str()).is_some()
            && response.get("generation").and_then(|v| v.as_u64()).is_some_and(|g| g >= 1);
        if !ok {
            return Err(entry_error(
                "account_vault_rotation_invalid",
                "The account worker returned an invalid vault writer completion.",
            ));
        }
        Ok(response)
    }
}

#[derive(Debug, Clone)]
pub struct PairingBootstrapResponse {
    pub bootstrap_id: String,
    pub account: AccountAuthorityBinding,
    pub tenant_id: String,
    pub route_id: String,
    pub entry_device_id: String,
    pub endpoint_device_id: String,
    pub endpoint_pin_ref: String,
    pub role: String,
    pub mode: String,
    pub admission_generation: u64,
    pub revocation_revision: u64,
    pub relay_admission: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRevokeReceipt {
    pub authority_revoked: bool,
    pub operation_id: String,
    pub target: String,
    pub tenant_id: String,
    pub route_id: String,
    pub device_id: String,
    pub enforcement: String,
}

#[derive(Debug, Clone)]
pub enum TransactionPoll {
    Pending,
    Expired,
    Consumed,
    Complete {
        account: AccountAuthorityBinding,
        /// Presentational account email — display only, never an identity input.
        account_email: Option<String>,
        purpose: String,
        /// The issued device session credential (login only).
        device_session_credential: Option<String>,
        /// The step-up permit id (step_up only).
        permit_id: Option<String>,
        action_purpose: Option<String>,
        target: Option<AccountActionTarget>,
    },
}

fn parse_poll_response(value: &Value) -> Option<TransactionPoll> {
    if !is_plain_object(value) {
        return None;
    }
    match value.get("state")?.as_str()? {
        "pending" => Some(TransactionPoll::Pending),
        "expired" => Some(TransactionPoll::Expired),
        "consumed" => Some(TransactionPoll::Consumed),
        "complete" => {
            let account = value.get("account")?;
            if !is_binding(account) {
                return None;
            }
            let binding: AccountAuthorityBinding = serde_json::from_value(account.clone()).ok()?;
            if !is_opaque_id(&binding.account_id) || binding.auth_epoch < 1 {
                return None;
            }
            let account_email = account.get("email").and_then(|e| e.as_str()).map(String::from);
            match value.get("purpose")?.as_str()? {
                "login" => {
                    let credential = value.get("deviceSessionCredential")?.as_str()?;
                    if credential.len() < 32
                        || !value.get("permitId")?.is_null()
                        || !value.get("target")?.is_null()
                    {
                        return None;
                    }
                    Some(TransactionPoll::Complete {
                        account: binding,
                        account_email: account_email.clone(),
                        purpose: "login".into(),
                        device_session_credential: Some(credential.to_string()),
                        permit_id: None,
                        action_purpose: None,
                        target: None,
                    })
                }
                "step_up" => {
                    let action_purpose = value.get("actionPurpose")?.as_str()?;
                    if action_purpose != "pair_device" && action_purpose != "grant_access" {
                        return None;
                    }
                    let permit_id = value.get("permitId")?.as_str()?;
                    if !is_account_step_up_permit_id(permit_id)
                        || !value.get("deviceSessionCredential")?.is_null()
                        || !value.get("target").is_some_and(is_action_target)
                    {
                        return None;
                    }
                    Some(TransactionPoll::Complete {
                        account: binding,
                        account_email: account_email.clone(),
                        purpose: "step_up".into(),
                        device_session_credential: None,
                        permit_id: Some(permit_id.to_string()),
                        action_purpose: Some(action_purpose.to_string()),
                        target: serde_json::from_value(value.get("target")?.clone()).ok(),
                    })
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// Sign the desktop pairing bootstrap body exactly as
/// `signDesktopPairingBootstrap` does — returns the request with `proof`.
pub fn sign_desktop_pairing_bootstrap(
    account: &AccountAuthorityBinding,
    credential: &str,
    client_public_key: &str,
    body_without_proof: &Value,
    sign: &dyn Fn(&[u8]) -> Vec<u8>,
) -> Value {
    let nonce = format!("desktop.{}", b64u_encode(&crate::keys::random_bytes(24)));
    let body_digest = account_desktop_proof_digest(body_without_proof);
    let credential_digest = b64u_encode(&Sha256::digest(credential.as_bytes())[..]);
    let transcript = account_desktop_session_transcript(
        "POST",
        ROUTE_DESKTOP_PAIRING_BOOTSTRAP,
        account,
        client_public_key,
        &credential_digest,
        &nonce,
        &body_digest,
    );
    let mut request = body_without_proof.clone();
    request.as_object_mut().unwrap().insert(
        "proof".into(),
        json!({
            "credential": credential,
            "clientPublicKey": client_public_key,
            "nonce": nonce,
            "bodyDigest": body_digest,
            "signature": b64u_encode(&sign(transcript.as_bytes())),
        }),
    );
    request
}

/// A pairing-bootstrap request body (without `proof`) for one invite target.
pub fn pairing_bootstrap_body(
    tenant_id: &str,
    route_id: &str,
    entry_device_id: &str,
    entry_device_public_key: &str,
    endpoint_pin_ref: &str,
    mode: &str,
) -> Value {
    json!({
        "tenantId": tenant_id,
        "routeId": route_id,
        "entryDeviceId": entry_device_id,
        "entryDevicePublicKey": entry_device_public_key,
        "endpointPinRef": endpoint_pin_ref,
        "mode": mode,
    })
}

/// Fresh opaque operation id for account-tracked operations.
pub fn new_operation_id(prefix: &str) -> String {
    format!("{}.{}", prefix, generate_opaque_id())
}
