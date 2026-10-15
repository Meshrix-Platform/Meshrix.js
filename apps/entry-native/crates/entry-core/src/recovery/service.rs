//! Top-level recovery composition for the fresh-device flow:
//!
//!   recovery text (the only user-supplied artifact)
//!   → deriveRecoveryMaterial (signing + writer + backup keys)
//!   → vault fetch (recovery-key proof) → decrypt bundle
//!   → EntryRecoverySession (fresh device key in custody, endpoint challenge,
//!     typed proof) → fresh admission requiring mutual-TLS rebind.
//!
//! Port of `apps/entry/src/recovery/recovery-service.ts`.

use serde_json::Value;

use crate::error::{entry_error, Result};
use crate::custody::CustodyAdapter;
use crate::identity::DeviceIdentity;

use super::bundle::{assert_bundle_recoverable, BundleConnection, EntryRecoveryBundle};
use super::crypto::{derive_recovery_material, RecoveryMaterial};
use super::key::parse_recovery_text;
use super::session::{EntryRecoverySession, RecoveryBootstrapOutcome, RecoveryEndpointPort};
use super::sync::{SnapshotJournalPort, SnapshotSynchronizer, SyncFetchOutcome};
use super::vault::VaultTransport;

/// Issued by the endpoint admin surface: a fresh-device relay credential for
/// the vault's owning route. The endpoint retires the lost device's slot and
/// fixes the fresh deviceId before `recover_fresh_profile` mints its key.
#[derive(Debug, Clone)]
pub enum RecoveryAccessOutcome {
    Issued {
        device_id: String,
        relay_credential: String,
        tenant_id: String,
        route_id: String,
        admission_generation: u64,
        revocation_revision: u64,
    },
    Refused {
        refusal: String,
    },
}

/// Optional provisioning seam — the endpoint admin surface that turns a vault
/// locator into a fresh-device credential. Production surfaces may not expose
/// it; the service reports `endpoint_unreachable` when it is absent, matching
/// the reference client.
pub trait RecoveryAccessPort: Send + Sync {
    fn provision(
        &self,
        vault_id: &str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<RecoveryAccessOutcome>> + Send + '_>,
    >;
}

#[derive(Debug)]
pub enum FreshRecoveryOutcome {
    Enrolled {
        device: DeviceIdentity,
        connection: BundleConnection,
        bundle: EntryRecoveryBundle,
        admission_generation: u64,
        generation: u64,
        principal_ref: String,
    },
    Refused {
        refusal: String,
    },
    SnapshotMissing,
    SnapshotUnusable {
        reason: String,
    },
}

/// `EntryRecoveryChannel` is already bound to one relay route at connect time;
/// the port's `endpoint_route_id` selects nothing — it is asserted by the
/// channel's admission.
pub struct RecoveryChannelEndpoint<'a> {
    channel: &'a crate::relay::recovery::EntryRecoveryChannel,
}

impl<'a> RecoveryChannelEndpoint<'a> {
    pub fn new(channel: &'a crate::relay::recovery::EntryRecoveryChannel) -> Self {
        Self { channel }
    }
}

impl<'a> RecoveryEndpointPort for RecoveryChannelEndpoint<'a> {
    async fn round_trip(&self, _endpoint_route_id: &str, message: &Value) -> Result<Option<Value>> {
        self.channel.round_trip(message).await.map(Some)
    }
}

pub struct EntryRecoveryService<'a, T: VaultTransport, J: SnapshotJournalPort, E: RecoveryEndpointPort> {
    synchronizer: &'a mut SnapshotSynchronizer<T, J>,
    endpoint: &'a E,
}

impl<'a, T: VaultTransport, J: SnapshotJournalPort, E: RecoveryEndpointPort>
    EntryRecoveryService<'a, T, J, E>
{
    pub fn new(synchronizer: &'a mut SnapshotSynchronizer<T, J>, endpoint: &'a E) -> Self {
        Self { synchronizer, endpoint }
    }

    /// Recover a fresh profile from the user-held recovery text alone.
    /// `route_id` selects the connection inside the decrypted bundle; when the
    /// bundle holds exactly one connection it may be `None`.
    pub async fn recover_fresh_profile(
        &mut self,
        recovery_text: &str,
        custody: &dyn CustodyAdapter,
        route_id: Option<&str>,
        device_id: Option<String>,
    ) -> Result<FreshRecoveryOutcome> {
        let key = parse_recovery_text(recovery_text)?;
        if key.vault_id.is_empty() {
            return Err(entry_error(
                "recovery_locator_missing",
                "Recovery text carries no vault locator; a fresh profile cannot find the snapshot.",
            ));
        }
        let material: RecoveryMaterial = derive_recovery_material(&key.secret)?;
        let fetched = self
            .synchronizer
            .fetch_snapshot(&key.vault_id, &material, None, &[], true)?;
        let bundle = match fetched {
            SyncFetchOutcome::Snapshot { bundle, .. } => bundle,
            SyncFetchOutcome::Refused { refusal, .. } => {
                if refusal == "not_found" {
                    return Ok(FreshRecoveryOutcome::SnapshotMissing);
                }
                return Ok(FreshRecoveryOutcome::SnapshotUnusable {
                    reason: format!("vault refused: {refusal}"),
                });
            }
            SyncFetchOutcome::DecryptFailed => {
                return Ok(FreshRecoveryOutcome::SnapshotUnusable {
                    reason: "decrypt_failed".into(),
                });
            }
            SyncFetchOutcome::AuthorityMismatch => {
                return Ok(FreshRecoveryOutcome::SnapshotUnusable {
                    reason: "authority_mismatch".into(),
                });
            }
            SyncFetchOutcome::Stale { .. } => {
                return Ok(FreshRecoveryOutcome::SnapshotUnusable { reason: "stale".into() });
            }
            SyncFetchOutcome::InvalidResponse => {
                return Ok(FreshRecoveryOutcome::SnapshotUnusable {
                    reason: "invalid_response".into(),
                });
            }
        };
        // Defense in depth: a decryptable bundle is still validated against the
        // forbidden-key surface before anything reads a field from it.
        assert_bundle_recoverable(&bundle.to_json())?;
        let connection = match route_id {
            Some(route_id) => bundle
                .connections
                .iter()
                .find(|candidate| candidate.route_id == route_id)
                .cloned(),
            None => {
                if bundle.connections.len() == 1 {
                    bundle.connections.first().cloned()
                } else {
                    None
                }
            }
        };
        let Some(connection) = connection else {
            return Err(entry_error(
                "recovery_state_invalid",
                match route_id {
                    Some(route_id) =>
                        format!("No recovered connection matches endpoint {route_id}."),
                    None =>
                        "The recovered bundle holds multiple connections; select one by routeId."
                            .to_string(),
                },
            ));
        };
        let session = EntryRecoverySession::new(self.endpoint);
        let enrolled = session.recover(&connection, custody, device_id).await?;
        let enrolled = match enrolled {
            RecoveryBootstrapOutcome::Refused { refusal } => {
                return Ok(FreshRecoveryOutcome::Refused { refusal });
            }
            other => other,
        };
        let RecoveryBootstrapOutcome::Enrolled {
            device,
            admission_generation,
            generation,
            principal_ref,
            ..
        } = enrolled
        else {
            unreachable!()
        };
        Ok(FreshRecoveryOutcome::Enrolled {
            device,
            connection,
            bundle,
            admission_generation,
            generation,
            principal_ref,
        })
    }
}
