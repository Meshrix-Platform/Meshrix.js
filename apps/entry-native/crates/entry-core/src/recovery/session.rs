//! Fresh-device recovery bootstrap — port of `recovery-session.ts`.
//!
//! Runs strictly before normal mutual-TLS/routing enrollment and never on a
//! forwarding session — the only wire purpose here is `recover_device`:
//!   recovery-request → endpoint-issued challenge → typed proof signed by the
//!   *fresh device key* → recovery-result → fresh admission requiring
//!   mutual-TLS rebind.

use serde_json::Value;

use crate::custody::CustodyAdapter;
use crate::error::{entry_error, Result};
use crate::identity::{enroll_device_identity, load_device_keypair, DeviceIdentity};
use crate::transcripts::recovery_proof_transcript;
use crate::wire::recovery::{
    create_recovery_proof, create_recovery_request, parse_recovery_challenge,
    parse_recovery_result, RecoveryResult,
};

use super::bundle::BundleConnection;

/// Narrow endpoint port for the recovery channel — the real transport is the
/// entry relay session opened with `purpose: "recover_device"`.
pub trait RecoveryEndpointPort: Send + Sync {
    /// Send one wire message; `None` when the endpoint stayed silent.
    fn round_trip(
        &self,
        endpoint_route_id: &str,
        message: &Value,
    ) -> impl std::future::Future<Output = Result<Option<Value>>> + Send;
}

#[derive(Debug)]
pub enum RecoveryBootstrapOutcome {
    Enrolled {
        device: DeviceIdentity,
        admission_device_id: String,
        admission_generation: u64,
        generation: u64,
        principal_ref: String,
    },
    Refused {
        refusal: String,
    },
}

/// Clock-skew bound for challenge expiry checks (client side).
const CHALLENGE_EXPIRY_GRACE_MS: i64 = 5_000;

pub struct EntryRecoverySession<'a, T: RecoveryEndpointPort> {
    endpoint: &'a T,
}

impl<'a, T: RecoveryEndpointPort> EntryRecoverySession<'a, T> {
    pub fn new(endpoint: &'a T) -> Self {
        Self { endpoint }
    }

    /// Run the recovery bootstrap for one connection.
    pub async fn recover(
        &self,
        connection: &BundleConnection,
        custody: &dyn CustodyAdapter,
        device_id: Option<String>,
    ) -> Result<RecoveryBootstrapOutcome> {
        let device = enroll_device_identity(custody, None, device_id)?;

        let request = create_recovery_request(
            &connection.route_id,
            &device.device_id,
            &device.public_key,
        );
        let challenge_raw = self
            .endpoint
            .round_trip(&connection.route_id, &request)
            .await?;
        let challenge = match challenge_raw {
            None => {
                return Err(entry_error(
                    "endpoint_unreachable",
                    format!("Endpoint {} did not answer the recovery request.", connection.route_id),
                ))
            }
            Some(raw) => parse_recovery_challenge(&raw).ok_or_else(|| {
                entry_error(
                    "endpoint_unexpected_response",
                    "Endpoint returned a message that is not a valid recovery-challenge.",
                )
            })?,
        };
        if challenge.endpoint_route_id != connection.route_id {
            return Err(entry_error(
                "endpoint_refused",
                "Recovery challenge answered by a different endpoint route than requested.",
            ));
        }
        if challenge.fresh_device_id != device.device_id {
            return Err(entry_error(
                "endpoint_refused",
                "Recovery challenge does not bind this fresh device identity.",
            ));
        }
        if challenge.fresh_device_public_key != device.public_key {
            return Err(entry_error(
                "endpoint_refused",
                "Recovery challenge does not bind this fresh device key.",
            ));
        }
        if challenge.principal_ref != connection.principal_ref {
            return Err(entry_error(
                "endpoint_refused",
                "Recovery challenge principal does not match the paired endpoint principal.",
            ));
        }
        let expected_generation = connection
            .recovery_authority
            .as_ref()
            .map(|a| a.generation)
            .unwrap_or(1);
        if challenge.generation < expected_generation {
            return Err(entry_error(
                "endpoint_refused",
                format!(
                    "Recovery challenge generation {} is older than the known authority generation {}.",
                    challenge.generation, expected_generation
                ),
            ));
        }
        let expires_at = chrono::DateTime::parse_from_rfc3339(&challenge.expires_at)
            .map(|d| d.timestamp_millis())
            .map_err(|_| entry_error("endpoint_unexpected_response", "Recovery challenge has inconsistent timestamps."))?;
        let issued_at = chrono::DateTime::parse_from_rfc3339(&challenge.issued_at)
            .map(|d| d.timestamp_millis())
            .map_err(|_| entry_error("endpoint_unexpected_response", "Recovery challenge has inconsistent timestamps."))?;
        let now = chrono::Utc::now().timestamp_millis();
        if expires_at <= now - CHALLENGE_EXPIRY_GRACE_MS {
            return Err(entry_error("endpoint_refused", "Recovery challenge arrived already expired."));
        }
        if expires_at <= issued_at {
            return Err(entry_error(
                "endpoint_unexpected_response",
                "Recovery challenge has inconsistent timestamps.",
            ));
        }

        let device_key = load_device_keypair(custody, None, &device.device_id)?.ok_or_else(|| {
            entry_error("custody_unavailable", "Fresh device key could not be loaded from custody.")
        })?;
        let transcript = recovery_proof_transcript(
            &challenge.challenge_id,
            &challenge.endpoint_route_id,
            &challenge.principal_ref,
            challenge.generation,
            &device.device_id,
            &device.public_key,
        );
        let signature = crate::b64::b64u_encode(&device_key.sign(transcript.as_bytes()));
        let proof = create_recovery_proof(
            &challenge.challenge_id,
            &challenge.endpoint_route_id,
            &challenge.principal_ref,
            challenge.generation,
            &device.device_id,
            &device.public_key,
            &signature,
        );
        let result_raw = self
            .endpoint
            .round_trip(&connection.route_id, &proof)
            .await?;
        let result = match result_raw.and_then(|raw| parse_recovery_result(&raw)) {
            Some(r) => r,
            None => {
                return Err(entry_error(
                    "endpoint_unexpected_response",
                    "Endpoint returned a message that is not a valid recovery-result.",
                ))
            }
        };
        match result {
            RecoveryResult::Refused { challenge_id, refusal } => {
                if challenge_id != challenge.challenge_id {
                    return Err(entry_error(
                        "endpoint_unexpected_response",
                        "Recovery result answered a different challenge.",
                    ));
                }
                Ok(RecoveryBootstrapOutcome::Refused { refusal })
            }
            RecoveryResult::Enrolled {
                challenge_id,
                device_id: admitted_id,
                admission_generation,
            } => {
                if challenge_id != challenge.challenge_id {
                    return Err(entry_error(
                        "endpoint_unexpected_response",
                        "Recovery result answered a different challenge.",
                    ));
                }
                if admitted_id != device.device_id {
                    return Err(entry_error(
                        "endpoint_unexpected_response",
                        "Recovery admission names a different device than enrolled.",
                    ));
                }
                Ok(RecoveryBootstrapOutcome::Enrolled {
                    device,
                    admission_device_id: admitted_id,
                    admission_generation,
                    generation: challenge.generation,
                    principal_ref: challenge.principal_ref,
                })
            }
        }
    }
}
