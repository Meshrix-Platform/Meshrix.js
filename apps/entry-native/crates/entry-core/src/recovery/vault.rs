//! Recovery vault client — port of `vault-client.ts`.
//!
//! A `vault-fetch` carries a typed `vault_fetch` proof signed by the recovery
//! signing key; a `vault-write` carries an `expectedRevision` CAS plus a
//! `vault_write` proof signed by the enrolled writer key. Every request gets
//! a fresh random nonce — uniqueness never depends on a service revision.

use serde_json::{json, Value};

use crate::b64::b64u_encode;
use crate::error::{entry_error, Result};
use crate::keys::{generate_opaque_id, Ed25519Keypair};
use crate::transcripts::{vault_fetch_transcript, vault_snapshot_digest, vault_write_transcript};
use crate::wire::recovery::{
    create_vault_fetch, create_vault_write, parse_encrypted_recovery_snapshot,
    parse_vault_fetch_refused, parse_vault_snapshot, parse_vault_write_result,
    vault_write_committed, VaultSnapshot, VaultWriteResult,
};

/// Signing material bound to a derived recovery key.
pub struct VaultSigningMaterial<'a> {
    pub key_id: &'a str,
    pub keypair: &'a Ed25519Keypair,
}

#[derive(Debug)]
pub enum VaultFetchOutcome {
    Snapshot(VaultSnapshot),
    Refused { refusal: String, retryable: bool },
    InvalidResponse,
}

#[derive(Debug)]
pub enum VaultWriteOutcome {
    Committed { committed_revision: u64 },
    Conflict { current_revision: u64 },
    Refused { retryable: bool },
    InvalidResponse,
}

/// Narrow transport port — tests drive a neutral peer; production uses the
/// HTTPS transport below.
pub trait VaultTransport: Send + Sync {
    fn post(&self, vault_id: &str, message: &Value) -> Result<(u16, Value)>;
}

/// HTTPS POST transport: `POST {baseUrl}/vault/{vaultId}` with a JSON body.
pub struct HttpsVaultTransport {
    base_url: String,
    agent: ureq::Agent,
}

impl HttpsVaultTransport {
    pub fn new(base_url: &str) -> Result<Self> {
        let normalized = base_url.trim_end_matches('/');
        if !normalized.starts_with("https://") && !normalized.starts_with("http://127.0.0.1") && !normalized.starts_with("http://localhost") {
            return Err(entry_error(
                "vault_transport_error",
                "The vault service URL must be HTTPS (loopback HTTP allowed for fixtures).",
            ));
        }
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(30)))
            .http_status_as_error(false)
            .build()
            .into();
        Ok(Self {
            base_url: normalized.to_string(),
            agent,
        })
    }
}

impl VaultTransport for HttpsVaultTransport {
    fn post(&self, vault_id: &str, message: &Value) -> Result<(u16, Value)> {
        let url = format!("{}/vault/{}", self.base_url, urlencoding::encode(vault_id));
        let mut response = self
            .agent
            .post(&url)
            .content_type("application/json")
            .send_json(message)
            .map_err(|e| {
                entry_error("vault_transport_error", "Vault request could not be completed.")
                    .caused_by(e)
            })?;
        let body_text = response
            .body_mut()
            .read_to_string()
            .map_err(|e| entry_error("vault_transport_error", "Vault response could not be read.").caused_by(e))?;
        let status = response.status().as_u16();
        let body = if body_text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&body_text).unwrap_or(Value::Null)
        };
        Ok((status, body))
    }
}

pub struct RecoveryVaultClient<T: VaultTransport> {
    transport: T,
    nonce_factory: Box<dyn Fn() -> String + Send + Sync>,
}

impl<T: VaultTransport> RecoveryVaultClient<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            nonce_factory: Box::new(|| format!("n.entry.{}", generate_opaque_id())),
        }
    }

    fn issued_now() -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    /// Fetch the committed snapshot using only recovery-key possession — no
    /// device credential, session or account login is involved.
    pub fn fetch_snapshot(&self, vault_id: &str, recovery_key: &VaultSigningMaterial) -> Result<VaultFetchOutcome> {
        let nonce = (self.nonce_factory)();
        let issued_at = Self::issued_now();
        let signature = b64u_encode(
            &recovery_key
                .keypair
                .sign(&vault_fetch_transcript(vault_id, recovery_key.key_id, &nonce, &issued_at)),
        );
        let fetch_proof = json!({
            "keyId": recovery_key.key_id,
            "nonce": nonce,
            "issuedAt": issued_at,
            "signature": signature,
        });
        let message = create_vault_fetch(vault_id, &fetch_proof);
        let (status, body) = self.transport.post(vault_id, &message)?;
        if status == 429 || status == 503 {
            return Ok(VaultFetchOutcome::Refused {
                refusal: "rate_limited".into(),
                retryable: true,
            });
        }
        if let Some(snapshot) = parse_vault_snapshot(&body) {
            if snapshot.vault_id == vault_id {
                return Ok(VaultFetchOutcome::Snapshot(snapshot));
            }
        }
        if let Some(refused) = parse_vault_fetch_refused(&body) {
            return Ok(VaultFetchOutcome::Refused {
                refusal: refused.refusal,
                retryable: refused.retryable,
            });
        }
        Ok(VaultFetchOutcome::InvalidResponse)
    }

    /// Bounded CAS write. `expected_revision` is the committed revision this
    /// write builds on (0 for the first snapshot); the snapshot's own
    /// `revision` must equal `expected_revision + 1`.
    pub fn write_snapshot(
        &self,
        vault_id: &str,
        expected_revision: u64,
        snapshot: &Value,
        writer_key: &VaultSigningMaterial,
    ) -> Result<VaultWriteOutcome> {
        // Sign over the canonical digest of the FULL protected snapshot — the
        // vault refuses the write when any covered field is substituted. A
        // snapshot that cannot satisfy the wire schema signs a fixed sentinel
        // and lets the vault return the honest refusal.
        let snapshot_digest = if parse_encrypted_recovery_snapshot(snapshot).is_some() {
            vault_snapshot_digest(snapshot)
        } else {
            format!("sha256:{}", "0".repeat(64))
        };
        let nonce = (self.nonce_factory)();
        let signature = b64u_encode(&writer_key.keypair.sign(&vault_write_transcript(
            vault_id,
            writer_key.key_id,
            &nonce,
            expected_revision,
            &snapshot_digest,
        )));
        let write_auth = json!({
            "writerKeyId": writer_key.key_id,
            "nonce": nonce,
            "snapshotDigest": snapshot_digest,
            "signature": signature,
        });
        let message = create_vault_write(vault_id, expected_revision, snapshot.clone(), &write_auth);
        let (status, body) = self.transport.post(vault_id, &message)?;
        if status == 429 || status == 503 {
            return Ok(VaultWriteOutcome::Refused { retryable: true });
        }
        match parse_vault_write_result(&body) {
            Some(VaultWriteResult::Committed {
                vault_id: id,
                committed_revision,
                ..
            }) if id == vault_id => {
                if !vault_write_committed(expected_revision, &parse_vault_write_result(&body).unwrap(), vault_id) {
                    return Ok(VaultWriteOutcome::InvalidResponse);
                }
                Ok(VaultWriteOutcome::Committed { committed_revision })
            }
            Some(VaultWriteResult::Conflict {
                vault_id: id,
                current_revision,
                ..
            }) if id == vault_id => Ok(VaultWriteOutcome::Conflict { current_revision }),
            Some(VaultWriteResult::Refused { vault_id: id, .. }) if id == vault_id => {
                Ok(VaultWriteOutcome::Refused { retryable: false })
            }
            _ => Ok(VaultWriteOutcome::InvalidResponse),
        }
    }
}
