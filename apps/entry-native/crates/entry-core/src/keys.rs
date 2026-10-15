//! Ed25519 keypair/signing primitives — port of `apps/entry/src/keys.ts`.
//! The private key shape kept in custody is the JWK `{kty:OKP,crv:Ed25519,d,x}`
//! where `d` is the raw 32-byte seed (identical to Node's `exportKey("jwk")`).

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;

use rand::Rng;
use sha2::Sha256;

use crate::b64::b64u_encode;
use crate::error::{entry_error, Result};

pub const ENTRY_KDF_SALT: &[u8] = b"meshrix/entry/recovery-root/v1";

/// DER prefix of an Ed25519 SubjectPublicKeyInfo (`300a`+ the RFC 8410
/// `id-Ed25519` algorithm OID).
const ED25519_SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

/// PKCS#8 DER prefix for an Ed25519 private key (`OneAsymmetricKey` with the
/// RFC 8410 `id-Ed25519` algorithm id); Node's
/// `export({format:"der",type:"pkcs8"})` produces exactly `prefix || seed`
/// = 48 bytes.
const ED25519_PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// A device/Ed25519 keypair. The custodied secret is the 48-byte PKCS#8 DER
/// (`to_pkcs8_der`), byte-identical to what the TypeScript client stores.
#[derive(Debug, Clone)]
pub struct Ed25519Keypair {
    pub signing_key: SigningKey,
}

impl Ed25519Keypair {
    pub fn public_key_raw(&self) -> [u8; 32] {
        self.signing_key.verifying_key().to_bytes()
    }

    /// Raw 32-byte public key as base64url (Node `publicKeyToBase64` result).
    pub fn public_key_b64u(&self) -> String {
        b64u_encode(&self.public_key_raw())
    }

    pub fn sign(&self, data: &[u8]) -> Vec<u8> {
        self.signing_key.sign(data).to_bytes().to_vec()
    }
}

pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    rand::rng().fill(buf.as_mut_slice());
    buf
}

pub fn generate_ed25519_keypair() -> Ed25519Keypair {
    let mut seed = [0u8; 32];
    rand::rng().fill(&mut seed);
    ed25519_keypair_from_seed(&seed).expect("fresh 32-byte seed is always valid")
}

/// Rebuild a keypair from a raw 32-byte seed — mirrors `ed25519KeypairFromSeed`.
pub fn ed25519_keypair_from_seed(seed: &[u8; 32]) -> Result<Ed25519Keypair> {
    Ok(Ed25519Keypair {
        signing_key: SigningKey::from_bytes(seed),
    })
}

/// Node-compatible PKCS#8 DER (48 bytes) — the exact bytes kept in custody.
pub fn ed25519_pkcs8_der(signing_key: &SigningKey) -> Vec<u8> {
    let mut der = Vec::with_capacity(48);
    der.extend_from_slice(&ED25519_PKCS8_PREFIX);
    der.extend_from_slice(&signing_key.to_bytes());
    der
}

/// Rebuild from the custodied PKCS#8 DER (accepts the 48-byte Node shape or a
/// bare 32-byte seed for forward compatibility).
pub fn ed25519_keypair_from_pkcs8(der: &[u8]) -> Result<Ed25519Keypair> {
    let invalid = || entry_error("custody_payload_invalid", "Custodied key is not PKCS#8 Ed25519.");
    let seed: [u8; 32] = if der.len() == 48 && der[..16] == ED25519_PKCS8_PREFIX {
        der[16..].try_into().map_err(|_| invalid())?
    } else if der.len() == 32 {
        der.try_into().map_err(|_| invalid())?
    } else {
        return Err(invalid());
    };
    ed25519_keypair_from_seed(&seed)
}

/// Raw public key → SPKI DER (44 bytes, prefix + key).
pub fn raw_public_key_to_spki_der(public: &[u8; 32]) -> Vec<u8> {
    let mut der = Vec::with_capacity(44);
    der.extend_from_slice(&ED25519_SPKI_PREFIX);
    der.extend_from_slice(public);
    der
}

/// `spkiSha256Fingerprint` — `fp.` + base64url(sha256(SPKI DER of raw key)).
pub fn spki_sha256_fingerprint_raw(public: &[u8; 32]) -> String {
    use sha2::Digest;
    let spki = raw_public_key_to_spki_der(public);
    let digest = Sha256::digest(&spki);
    format!("fp.{}", b64u_encode(&digest))
}

/// Same fingerprint when the input is already SPKI DER.
pub fn spki_sha256_fingerprint_der(spki_der: &[u8]) -> String {
    use sha2::Digest;
    let digest = Sha256::digest(spki_der);
    format!("fp.{}", b64u_encode(&digest))
}

/// HKDF-SHA256: salt = ENTRY_KDF_SALT, ikm = key, info = label.
/// Mirrors `hkdfLabel` exactly (Node `hkdf("sha256", key, salt, label, len)`).
pub fn hkdf_label(key: &[u8], label: &str, out_len: usize) -> Vec<u8> {
    let hk = Hkdf::<Sha256>::new(Some(ENTRY_KDF_SALT), key);
    let mut out = vec![0u8; out_len];
    hk.expand(label.as_bytes(), &mut out)
        .expect("HKDF expand with valid length");
    out
}

pub fn sign_ed25519(signing_key: &SigningKey, data: &[u8]) -> Vec<u8> {
    signing_key.sign(data).to_bytes().to_vec()
}

pub fn verify_ed25519(public: &[u8; 32], data: &[u8], signature: &[u8]) -> Result<()> {
    let vk = VerifyingKey::from_bytes(public)
        .map_err(|_| entry_error("signature_invalid", "The public key is malformed."))?;
    let sig_bytes: [u8; 64] = signature
        .try_into()
        .map_err(|_| entry_error("signature_invalid", "The signature is malformed."))?;
    let sig = Signature::from_bytes(&sig_bytes);
    vk.verify(data, &sig)
        .map_err(|_| entry_error("signature_invalid", "The signature does not verify."))
}

/// `randomBytes(9).toString("base64url")` → 12-char id suffix.
pub fn generate_opaque_id() -> String {
    let mut buf = [0u8; 9];
    rand::rng().fill(&mut buf);
    b64u_encode(&buf)
}

/// `generateDeviceId` — `dev.entry.<opaque>` ≤ 64 chars.
pub fn generate_device_id() -> String {
    format!("dev.entry.{}", generate_opaque_id())
}

/// `randomBytes(24).toString("base64url")` — challenge id / nonce material.
pub fn generate_nonce() -> String {
    let mut buf = [0u8; 24];
    rand::rng().fill(&mut buf);
    b64u_encode(&buf)
}

pub fn sha256_b64u(data: &[u8]) -> String {
    use sha2::Digest;
    b64u_encode(&Sha256::digest(data))
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    let d = Sha256::digest(data);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keypair_roundtrip_via_pkcs8() {
        let kp = generate_ed25519_keypair();
        let der = ed25519_pkcs8_der(&kp.signing_key);
        assert_eq!(der.len(), 48);
        let back = ed25519_keypair_from_pkcs8(&der).unwrap();
        assert_eq!(kp.public_key_raw(), back.public_key_raw());
        let sig = kp.sign(b"hello");
        verify_ed25519(&kp.public_key_raw(), b"hello", &sig).unwrap();
        // A truncated/garbage blob must fail closed.
        assert!(ed25519_keypair_from_pkcs8(&der[..40]).is_err());
    }

    #[test]
    fn spki_der_shape() {
        let kp = generate_ed25519_keypair();
        let der = raw_public_key_to_spki_der(&kp.public_key_raw());
        assert_eq!(der.len(), 44);
        assert_eq!(&der[..12], &ED25519_SPKI_PREFIX);
        assert_eq!(&der[12..], &kp.public_key_raw());
        assert!(spki_sha256_fingerprint_raw(&kp.public_key_raw()).starts_with("fp."));
    }

    #[test]
    fn hkdf_deterministic() {
        let a = hkdf_label(b"root-secret-32-bytes-aaaaaaaaaaaaaaaa", "label", 32);
        let b = hkdf_label(b"root-secret-32-bytes-aaaaaaaaaaaaaaaa", "label", 32);
        let c = hkdf_label(b"root-secret-32-bytes-aaaaaaaaaaaaaaaa", "other", 32);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 32);
    }
}
