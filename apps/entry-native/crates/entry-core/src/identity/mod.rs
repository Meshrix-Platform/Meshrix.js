//! Device identity lifecycle — port of `identity/device-identity.ts`.
//! A device identity is a fresh random Ed25519 pair; the private key exists
//! only behind the custody adapter as PKCS#8 DER, and the public key + SPKI
//! fingerprint are the enrolled wire identity.

use crate::custody::{assert_custody_ref, CustodyAdapter};
use crate::error::{entry_error, Result};
use crate::keys::{
    ed25519_keypair_from_pkcs8, ed25519_pkcs8_der, generate_device_id, generate_ed25519_keypair,
    spki_sha256_fingerprint_raw,
};

/// Public device identity — what the wire sees (no private material).
#[derive(Debug, Clone)]
pub struct DeviceIdentity {
    pub device_id: String,
    /// Raw 32-byte Ed25519 public key, base64url — the paired identity key.
    pub public_key: String,
    /// `fp.<sha256(spki)>` fingerprint for pairing display and binding.
    pub fingerprint: String,
}

fn custody_ref(prefix: &str, device_id: &str) -> String {
    // Custody refs are `[a-z0-9._-]`; device ids are opaque-id safe already.
    let sanitized: String = device_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    format!("{prefix}.{sanitized}")
}

/// Generate a fresh device identity and place its private key into custody.
/// Returns public identity material only — the private key is never returned.
pub fn enroll_device_identity(
    custody: &dyn CustodyAdapter,
    ref_prefix: Option<&str>,
    device_id: Option<String>,
) -> Result<DeviceIdentity> {
    let device_id = device_id.unwrap_or_else(generate_device_id);
    let pair = generate_ed25519_keypair();
    let pkcs8 = ed25519_pkcs8_der(&pair.signing_key);
    custody.store_secret(&custody_ref(ref_prefix.unwrap_or("dev"), &device_id), &pkcs8)?;
    Ok(DeviceIdentity {
        device_id,
        public_key: pair.public_key_b64u(),
        fingerprint: spki_sha256_fingerprint_raw(&pair.public_key_raw()),
    })
}

/// Rebuild the signing key from custody; `None` when no key is enrolled.
pub fn load_device_keypair(
    custody: &dyn CustodyAdapter,
    ref_prefix: Option<&str>,
    device_id: &str,
) -> Result<Option<crate::keys::Ed25519Keypair>> {
    let secret = custody.load_secret(&custody_ref(ref_prefix.unwrap_or("dev"), device_id))?;
    match secret {
        None => Ok(None),
        Some(der) => Ok(Some(ed25519_keypair_from_pkcs8(&der)?)),
    }
}

/// Sign a transcript with a custodied device key. Fails closed when absent —
/// returns base64url signature like `signEd25519`.
pub fn sign_with_device_key(
    custody: &dyn CustodyAdapter,
    ref_prefix: Option<&str>,
    device_id: &str,
    transcript: &[u8],
) -> Result<String> {
    let pair = load_device_keypair(custody, ref_prefix, device_id)?
        .ok_or_else(|| entry_error("custody_unavailable", format!("No custodied device key for {device_id}.")))?;
    Ok(crate::b64::b64u_encode(&pair.sign(transcript)))
}

/// Re-derive the public identity for a custodied device key.
pub fn device_identity_from_custody(
    custody: &dyn CustodyAdapter,
    ref_prefix: Option<&str>,
    device_id: &str,
) -> Result<Option<DeviceIdentity>> {
    let pair = match load_device_keypair(custody, ref_prefix, device_id)? {
        Some(p) => p,
        None => return Ok(None),
    };
    Ok(Some(DeviceIdentity {
        device_id: device_id.to_string(),
        public_key: pair.public_key_b64u(),
        fingerprint: spki_sha256_fingerprint_raw(&pair.public_key_raw()),
    }))
}

pub fn delete_device_key(custody: &dyn CustodyAdapter, ref_prefix: Option<&str>, device_id: &str) -> Result<()> {
    custody.delete_secret(&custody_ref(ref_prefix.unwrap_or("dev"), device_id))?;
    Ok(())
}

/// The custody ref for a device — exposed so callers can reference the same
/// name the adapter stores (e.g. config records).
pub fn device_custody_ref(ref_prefix: &str, device_id: &str) -> Result<String> {
    let r = custody_ref(ref_prefix, device_id);
    assert_custody_ref(&r)?;
    Ok(r)
}
