//! Staged per-endpoint recovery-key replacement — port of
//! `entry/src/recovery/rotation.ts`.
//!
//! One recovery key is active; a replacement is explicitly staged, published
//! to the vault under the next generation, and then acknowledged endpoint by
//! endpoint. The contract pins `globalComplete` to false and forbids claiming
//! `completed` while endpoints remain pending — this model derives its wire
//! view through `create_rotation_state`/`rotation_transition` so dishonest
//! global claims are structurally impossible.
//!
//! Interruption safety: the incumbent material and the last committed
//! snapshot are never discarded mid-rotation. A crash between staging and
//! acknowledgement leaves a resumable/abortable record; the incumbent key
//! keeps working until every endpoint acknowledges the candidate.

use serde_json::Value;

use crate::b64::b64u_encode;
use crate::error::{entry_error, Result};
use crate::keys::{generate_opaque_id, random_bytes};
use crate::store::{StoredRotation, StoredRotationEndpoint, StoredRotationOutbound};
use crate::transcripts::vault_fetch_transcript;
use crate::wire::recovery::{create_rotation_begin, rotation_transition};

use super::crypto::{derive_recovery_material, RecoveryMaterial};
use super::key::{generate_recovery_key, RecoveryKeyMaterial, ENTRY_RECOVERY_FORMAT_VERSION};

/// `RotationDurablePort` — durable rotation records. Production binds this
/// to `EntryGuiConfig.rotations`; tests may use the in-memory store.
pub trait RotationDurablePort {
    fn load(&mut self, rotation_id: &str) -> Option<StoredRotation>;
    fn load_all(&mut self) -> Vec<StoredRotation>;
    fn save(&mut self, rotation: &StoredRotation) -> Result<()>;
    fn delete(&mut self, rotation_id: &str) -> Result<()>;
}

/// In-memory store — mirrors `InMemoryRotationStore`.
#[derive(Default)]
pub struct InMemoryRotationStore {
    records: std::collections::HashMap<String, StoredRotation>,
}

impl InMemoryRotationStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl RotationDurablePort for InMemoryRotationStore {
    fn load(&mut self, rotation_id: &str) -> Option<StoredRotation> {
        self.records.get(rotation_id).cloned()
    }
    fn load_all(&mut self) -> Vec<StoredRotation> {
        self.records.values().cloned().collect()
    }
    fn save(&mut self, rotation: &StoredRotation) -> Result<()> {
        self.records
            .insert(rotation.rotation_id.clone(), rotation.clone());
        Ok(())
    }
    fn delete(&mut self, rotation_id: &str) -> Result<()> {
        self.records.remove(rotation_id);
        Ok(())
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `administrationProof` — the contract's VaultFetchProof shape signed by the
/// incumbent recovery signing key over the vault_fetch transcript for the
/// rotation's vault — proving incumbent possession without exposing it.
fn administration_proof(material: &RecoveryMaterial, vault_id: &str) -> Value {
    let nonce = format!("rn.rot.{}", b64u_encode(&random_bytes(15)));
    let issued_at = now_iso();
    let signature = b64u_encode(&material.signing.keypair.sign(&vault_fetch_transcript(
        vault_id,
        &material.signing.key_id,
        &nonce,
        &issued_at,
    )));
    serde_json::json!({
        "keyId": material.signing.key_id,
        "nonce": nonce,
        "issuedAt": issued_at,
        "signature": signature,
    })
}

pub struct StagedRotation {
    pub rotation: StoredRotation,
    /// The built `rotation-begin` payloads — replayable for redelivery.
    pub messages: Vec<Value>,
    pub candidate: RecoveryKeyMaterial,
}

pub struct RecoveryRotationManager<S: RotationDurablePort> {
    store: S,
}

impl<S: RotationDurablePort> RecoveryRotationManager<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    /// The active rotation for a recovery key, if one is in flight.
    pub fn active_rotation_for(&mut self, key_id: &str) -> Option<StoredRotation> {
        self.store.load_all().into_iter().find(|r| {
            r.incumbent_key_id == key_id && r.state != "completed" && r.state != "aborted"
        })
    }

    pub fn get(&mut self, rotation_id: &str) -> Option<StoredRotation> {
        self.store.load(rotation_id)
    }

    /// Every persisted rotation record, including terminal ones.
    pub fn load_all(&mut self) -> Vec<StoredRotation> {
        self.store.load_all()
    }

    /// Stage a replacement: generates (or accepts) the candidate secret,
    /// derives its material, and emits a `rotation-begin` per endpoint.
    /// Nothing is published yet — the incumbent remains the only active key.
    pub fn begin(
        &mut self,
        incumbent: &RecoveryMaterial,
        incumbent_generation: u64,
        principal_ref: &str,
        vault_id: &str,
        endpoint_route_ids: &[String],
        candidate_secret: Option<[u8; 32]>,
    ) -> Result<StagedRotation> {
        if self
            .active_rotation_for(&incumbent.signing.key_id)
            .is_some()
        {
            return Err(entry_error(
                "rotation_state_invalid",
                "A rotation for this recovery key is already in flight.",
            ));
        }
        let candidate: RecoveryKeyMaterial = match candidate_secret {
            Some(secret) => RecoveryKeyMaterial {
                secret,
                vault_id: vault_id.to_string(),
                format_version: ENTRY_RECOVERY_FORMAT_VERSION,
            },
            None => generate_recovery_key(Some(vault_id.to_string()))?,
        };
        let candidate_material = derive_recovery_material(&candidate.secret)?;
        let now = now_iso();
        let rotation_id = format!("rot.entry.{}", generate_opaque_id());
        let proof = administration_proof(incumbent, vault_id);
        let mut messages = Vec::with_capacity(endpoint_route_ids.len());
        let mut outbound = Vec::with_capacity(endpoint_route_ids.len());
        let mut endpoints = Vec::with_capacity(endpoint_route_ids.len());
        for endpoint_route_id in endpoint_route_ids {
            let message = create_rotation_begin(
                &format!("{rotation_id}:{endpoint_route_id}"),
                &incumbent.signing.key_id,
                principal_ref,
                incumbent_generation,
                incumbent_generation + 1,
                &candidate_material.signing.public_key,
                &proof,
            );
            messages.push(message.clone());
            outbound.push(StoredRotationOutbound {
                endpoint_route_id: endpoint_route_id.clone(),
                message,
            });
            endpoints.push(StoredRotationEndpoint {
                endpoint_route_id: endpoint_route_id.clone(),
                state: "pending".into(),
                detail: None,
            });
        }
        let rotation = StoredRotation {
            rotation_id,
            incumbent_key_id: incumbent.signing.key_id.clone(),
            incumbent_generation,
            candidate_key_id: candidate_material.signing.key_id.clone(),
            candidate_public_key: candidate_material.signing.public_key.clone(),
            candidate_generation: incumbent_generation + 1,
            principal_ref: principal_ref.into(),
            state: "staged".into(),
            endpoints,
            outbound,
            started_at: now.clone(),
            updated_at: now,
        };
        self.store.save(&rotation)?;
        Ok(StagedRotation {
            rotation,
            messages,
            candidate,
        })
    }

    fn transition(&mut self, rotation: &StoredRotation, event: &str) -> Result<StoredRotation> {
        let next = rotation_transition(&rotation.state, event).ok_or_else(|| {
            entry_error(
                "rotation_state_invalid",
                format!(
                    "Rotation {} in state {} cannot apply {event}.",
                    rotation.rotation_id, rotation.state
                ),
            )
        })?;
        let mut updated = rotation.clone();
        updated.state = next.to_string();
        updated.updated_at = now_iso();
        self.store.save(&updated)?;
        Ok(updated)
    }

    /// Mark the candidate snapshot published to the vault (generation+1).
    pub fn mark_published(&mut self, rotation_id: &str) -> Result<StoredRotation> {
        let rotation = self.require(rotation_id)?;
        self.transition(&rotation, "publish")
    }

    /// Record a per-endpoint outcome. The first acknowledgement moves the
    /// rotation to `acknowledging`; completion requires every endpoint
    /// acknowledged — offline endpoints keep it pending forever, honestly.
    pub fn mark_endpoint(
        &mut self,
        rotation_id: &str,
        endpoint_route_id: &str,
        outcome: &str,
    ) -> Result<StoredRotation> {
        let mut rotation = self.require(rotation_id)?;
        let index = rotation
            .endpoints
            .iter()
            .position(|e| e.endpoint_route_id == endpoint_route_id)
            .ok_or_else(|| {
                entry_error(
                    "rotation_state_invalid",
                    format!("Endpoint {endpoint_route_id} is not part of rotation {rotation_id}."),
                )
            })?;
        if outcome == "acknowledged" && rotation.state == "published" {
            rotation = self.transition(&rotation, "acknowledge")?;
        }
        rotation.endpoints[index].state = outcome.to_string();
        rotation.endpoints[index].detail = None;
        rotation.updated_at = now_iso();
        if rotation.state == "acknowledging"
            && rotation
                .endpoints
                .iter()
                .all(|e| e.state == "acknowledged")
        {
            if let Some(next) = rotation_transition("acknowledging", "complete") {
                rotation.state = next.to_string();
                rotation.updated_at = now_iso();
            }
        }
        self.store.save(&rotation)?;
        Ok(rotation)
    }

    /// The built `rotation-begin` payloads for endpoints that have not yet
    /// acknowledged — the redelivery surface.
    pub fn pending_outbound(&mut self, rotation_id: &str) -> Result<Vec<StoredRotationOutbound>> {
        let rotation = self.require(rotation_id)?;
        Ok(rotation
            .outbound
            .iter()
            .filter(|entry| {
                rotation
                    .endpoints
                    .iter()
                    .find(|e| e.endpoint_route_id == entry.endpoint_route_id)
                    .map(|e| e.state.as_str())
                    != Some("acknowledged")
            })
            .cloned()
            .collect())
    }

    /// Abort a non-terminal rotation. Endpoints keep the incumbent; the
    /// candidate material is dropped by the caller.
    pub fn abort(&mut self, rotation_id: &str) -> Result<StoredRotation> {
        let rotation = self.require(rotation_id)?;
        self.transition(&rotation, "abort")
    }

    /// Wire-shaped per-endpoint view; `globalComplete` is pinned false.
    pub fn wire_state(&mut self, rotation_id: &str) -> Result<Value> {
        let rotation = self.require(rotation_id)?;
        Ok(crate::wire::recovery::create_rotation_state(
            &rotation.rotation_id,
            &rotation.state,
            &rotation
                .endpoints
                .iter()
                .filter(|e| e.state == "acknowledged")
                .map(|e| e.endpoint_route_id.clone())
                .collect::<Vec<_>>(),
            &rotation
                .endpoints
                .iter()
                .filter(|e| e.state != "acknowledged")
                .map(|e| e.endpoint_route_id.clone())
                .collect::<Vec<_>>(),
        ))
    }

    fn require(&mut self, rotation_id: &str) -> Result<StoredRotation> {
        self.store.load(rotation_id).ok_or_else(|| {
            entry_error(
                "rotation_state_invalid",
                format!("Unknown rotation {rotation_id}."),
            )
        })
    }
}
