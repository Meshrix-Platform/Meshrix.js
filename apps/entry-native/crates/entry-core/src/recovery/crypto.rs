//! Recovery cryptographic profile — port of `recovery-crypto.ts`:
//! - HKDF-SHA-256 derives material under fixed versioned purpose labels —
//!   recovery signing, backup writer authorization, backup encryption.
//! - AES-256-GCM seals snapshot plaintext; the 12-byte IV prefixes the
//!   ciphertext inside the opaque payload; vault/format/generation/revision
//!   are authenticated as AAD. A service-supplied revision is never a nonce.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

use rand::Rng;
use sha2::{Digest, Sha256};

use crate::b64::{b64u_decode, b64u_encode};
use crate::error::{entry_error, Result};
use crate::keys::{
    ed25519_keypair_from_seed, hkdf_label, Ed25519Keypair,
};

/// Versioned purpose labels — never reuse a label for a different purpose.
pub const RECOVERY_LABEL_SIGNING: &str = "meshrix/private-relay/recovery-signing/v1";
pub const RECOVERY_LABEL_BACKUP_WRITER: &str = "meshrix/private-relay/backup-writer/v1";
pub const RECOVERY_LABEL_BACKUP_ENCRYPTION: &str = "meshrix/private-relay/backup-encryption/v1";

#[derive(Debug, Clone)]
pub struct DerivedRecoveryKey {
    /// Opaque key id derived from the public key — stable across reinstalls.
    pub key_id: String,
    /// Raw 32-byte Ed25519 public key, base64url — the vault verifier shape.
    pub public_key: String,
    pub keypair: Ed25519Keypair,
}

#[derive(Debug, Clone)]
pub struct RecoveryMaterial {
    /// Recovery signing key: proves the pre-enrolled recovery authority.
    pub signing: DerivedRecoveryKey,
    /// Backup writer key: authorizes vault CAS writes (enrolled per vault).
    pub writer: DerivedRecoveryKey,
    /// 32-byte AES key sealing snapshot plaintext.
    pub backup_key: [u8; 32],
}

/// `<prefix>.<fp16>` — keyId is opaque to the vault; derive it
/// deterministically from the public key so a fresh device presents the same
/// identity.
fn key_id_for(prefix: &str, public_key_b64: &str) -> String {
    let raw = b64u_decode(public_key_b64, 64).unwrap_or_default();
    let fingerprint = &Sha256::digest(&raw)[..16];
    format!("{prefix}.{}", b64u_encode(fingerprint))
}

/// Derive all recovery material from the 32-byte user-held secret.
pub fn derive_recovery_material(secret: &[u8; 32]) -> Result<RecoveryMaterial> {
    let signing_seed = hkdf_label(secret, RECOVERY_LABEL_SIGNING, 32);
    let writer_seed = hkdf_label(secret, RECOVERY_LABEL_BACKUP_WRITER, 32);
    let backup_key: [u8; 32] = hkdf_label(secret, RECOVERY_LABEL_BACKUP_ENCRYPTION, 32)
        .try_into()
        .expect("32-byte HKDF output");

    let signing_pair = ed25519_keypair_from_seed(&signing_seed.try_into().unwrap())?;
    let writer_pair = ed25519_keypair_from_seed(&writer_seed.try_into().unwrap())?;
    Ok(RecoveryMaterial {
        signing: DerivedRecoveryKey {
            key_id: key_id_for("rckey", &signing_pair.public_key_b64u()),
            public_key: signing_pair.public_key_b64u(),
            keypair: signing_pair,
        },
        writer: DerivedRecoveryKey {
            key_id: key_id_for("wkey", &writer_pair.public_key_b64u()),
            public_key: writer_pair.public_key_b64u(),
            keypair: writer_pair,
        },
        backup_key,
    })
}

/// AAD binding every authenticated envelope field: purpose, vault locator,
/// format, generation and revision. Tampering any of them breaks the tag.
pub fn snapshot_aad(vault_id: &str, format_version: u64, generation: u64, revision: u64) -> Vec<u8> {
    format!(
        "meshrix.private-relay.snapshot|aes-256-gcm|{vault_id}|fmt{format_version}|g{generation}|r{revision}"
    )
    .into_bytes()
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AeadEnvelopeFields {
    pub algorithm: &'static str, // "AES-256-GCM"
    /// Fresh qualified token `sn.<random>` — unique by randomness, not counters.
    pub nonce: String,
    /// base64url(IV(12) || ciphertext || tag(16))
    pub ciphertext: String,
    pub byte_length: usize,
}

/// Seal the canonical bundle JSON. `nonce` is a fresh qualified token; the
/// GCM IV (12 bytes) prefixes the ciphertext inside the opaque payload.
pub fn seal_recovery_snapshot(
    plaintext: &[u8],
    backup_key: &[u8; 32],
    vault_id: &str,
    format_version: u64,
    generation: u64,
    revision: u64,
    iv_override: Option<[u8; 12]>,
) -> Result<AeadEnvelopeFields> {
    let iv = iv_override.unwrap_or_else(|| {
        let mut iv = [0u8; 12];
        rand::rng().fill(&mut iv);
        iv
    });
    let cipher = Aes256Gcm::new_from_slice(backup_key).expect("32-byte key");
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: plaintext,
                aad: &snapshot_aad(vault_id, format_version, generation, revision),
            },
        )
        .map_err(|_| entry_error("snapshot_malformed", "Snapshot sealing failed."))?;
    let mut payload = Vec::with_capacity(12 + ciphertext.len());
    payload.extend_from_slice(&iv);
    payload.extend_from_slice(&ciphertext);
    let mut nonce_rand = [0u8; 15];
    rand::rng().fill(&mut nonce_rand);
    Ok(AeadEnvelopeFields {
        algorithm: "AES-256-GCM",
        nonce: format!("sn.{}", b64u_encode(&nonce_rand)),
        byte_length: payload.len(),
        ciphertext: b64u_encode(&payload),
    })
}

/// Open a sealed snapshot envelope; auth failure → `snapshot_decrypt_failed`.
pub fn open_recovery_snapshot(
    envelope: &serde_json::Value,
    backup_key: &[u8; 32],
    vault_id: &str,
    format_version: u64,
    generation: u64,
    revision: u64,
) -> Result<Vec<u8>> {
    if envelope.get("algorithm").and_then(|v| v.as_str()) != Some("AES-256-GCM") {
        return Err(entry_error(
            "snapshot_malformed",
            format!(
                "Unsupported snapshot algorithm {} — this entry implements AES-256-GCM.",
                envelope
                    .get("algorithm")
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "none".into())
            ),
        ));
    }
    let ciphertext_b64 = envelope
        .get("ciphertext")
        .and_then(|v| v.as_str())
        .ok_or_else(|| entry_error("snapshot_malformed", "Snapshot envelope has no ciphertext."))?;
    let payload = b64u_decode(ciphertext_b64, 4 * 1024 * 1024)
        .map_err(|_| entry_error("snapshot_malformed", "Snapshot ciphertext is not base64url."))?;
    if payload.len() < 12 + 16 {
        return Err(entry_error(
            "snapshot_malformed",
            "Snapshot ciphertext is shorter than the IV+tag floor.",
        ));
    }
    let (iv, ct) = payload.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(backup_key).expect("32-byte key");
    cipher
        .decrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: ct,
                aad: &snapshot_aad(vault_id, format_version, generation, revision),
            },
        )
        .map_err(|_| {
            entry_error(
                "snapshot_decrypt_failed",
                "Snapshot failed authentication — wrong recovery key or tampered ciphertext.",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recovery::key::generate_recovery_key;

    #[test]
    fn material_derivation_deterministic() {
        let key = generate_recovery_key(None).unwrap();
        let a = derive_recovery_material(&key.secret).unwrap();
        let b = derive_recovery_material(&key.secret).unwrap();
        assert_eq!(a.signing.key_id, b.signing.key_id);
        assert_eq!(a.writer.public_key, b.writer.public_key);
        assert_eq!(a.backup_key, b.backup_key);
        assert!(a.signing.key_id.starts_with("rckey."));
        assert!(a.writer.key_id.starts_with("wkey."));
        assert_ne!(a.signing.public_key, a.writer.public_key);
    }

    #[test]
    fn seal_open_roundtrip_and_tamper() {
        let key = generate_recovery_key(None).unwrap();
        let mat = derive_recovery_material(&key.secret).unwrap();
        let plaintext = br#"{"hello":"snapshot"}"#;
        let env = seal_recovery_snapshot(plaintext, &mat.backup_key, "vault.1", 1, 2, 3, None).unwrap();
        assert!(env.nonce.starts_with("sn."));
        let env_json = serde_json::to_value(&env).unwrap();
        let opened =
            open_recovery_snapshot(&env_json, &mat.backup_key, "vault.1", 1, 2, 3).unwrap();
        assert_eq!(opened, plaintext);
        // Wrong AAD fields fail.
        assert!(open_recovery_snapshot(&env_json, &mat.backup_key, "vault.2", 1, 2, 3).is_err());
        assert!(open_recovery_snapshot(&env_json, &mat.backup_key, "vault.1", 1, 2, 4).is_err());
        // Wrong key fails with decrypt error.
        let other = derive_recovery_material(&[9u8; 32]).unwrap();
        let err = open_recovery_snapshot(&env_json, &other.backup_key, "vault.1", 1, 2, 3)
            .unwrap_err();
        assert_eq!(err.code, "snapshot_decrypt_failed");
    }
}

/// Custody blob shape — `serializeRecoveryMaterial`: derived keys only, never
/// the 32-byte root. Key ids + public keys are re-derived on load, so a
/// tampered id cannot redirect writes silently.
#[derive(serde::Serialize, serde::Deserialize)]
struct SerializedRecoveryMaterial {
    v: u32,
    #[serde(rename = "signingKeyId")]
    signing_key_id: String,
    #[serde(rename = "signingPkcs8")]
    signing_pkcs8: String,
    #[serde(rename = "writerKeyId")]
    writer_key_id: String,
    #[serde(rename = "writerPkcs8")]
    writer_pkcs8: String,
    #[serde(rename = "backupKey")]
    backup_key: String,
}

pub fn serialize_recovery_material(material: &RecoveryMaterial) -> Vec<u8> {
    serde_json::to_vec(&SerializedRecoveryMaterial {
        v: 1,
        signing_key_id: material.signing.key_id.clone(),
        signing_pkcs8: b64u_encode(&crate::keys::ed25519_pkcs8_der(&material.signing.keypair.signing_key)),
        writer_key_id: material.writer.key_id.clone(),
        writer_pkcs8: b64u_encode(&crate::keys::ed25519_pkcs8_der(&material.writer.keypair.signing_key)),
        backup_key: b64u_encode(&material.backup_key),
    })
    .expect("recovery material serialization is infallible")
}

/// `deserializeRecoveryMaterial` — rejects malformed blobs and any blob whose
/// stored key ids/public keys disagree with the derived key material.
pub fn deserialize_recovery_material(secret: &[u8]) -> Result<RecoveryMaterial> {
    let parsed: SerializedRecoveryMaterial = serde_json::from_slice(secret).map_err(|_| {
        entry_error("recovery_material_invalid", "The custody-held recovery material is not readable.")
    })?;
    if parsed.v != 1 {
        return Err(entry_error(
            "recovery_material_invalid",
            "The custody-held recovery material has an unknown version.",
        ));
    }
    let signing_der = b64u_decode(&parsed.signing_pkcs8, 64)?;
    let writer_der = b64u_decode(&parsed.writer_pkcs8, 64)?;
    let backup_raw = b64u_decode(&parsed.backup_key, 64)?;
    if backup_raw.len() != 32 {
        return Err(entry_error(
            "recovery_material_invalid",
            "The custody-held backup key has an unexpected length.",
        ));
    }
    let signing_pair = crate::keys::ed25519_keypair_from_pkcs8(&signing_der)?;
    let writer_pair = crate::keys::ed25519_keypair_from_pkcs8(&writer_der)?;
    let signing = DerivedRecoveryKey {
        key_id: key_id_for("rckey", &signing_pair.public_key_b64u()),
        public_key: signing_pair.public_key_b64u(),
        keypair: signing_pair,
    };
    let writer = DerivedRecoveryKey {
        key_id: key_id_for("wkey", &writer_pair.public_key_b64u()),
        public_key: writer_pair.public_key_b64u(),
        keypair: writer_pair,
    };
    if signing.key_id != parsed.signing_key_id || writer.key_id != parsed.writer_key_id {
        return Err(entry_error(
            "recovery_material_invalid",
            "The custody-held recovery material does not match its recorded key ids.",
        ));
    }
    Ok(RecoveryMaterial {
        signing,
        writer,
        backup_key: backup_raw.try_into().unwrap(),
    })
}
