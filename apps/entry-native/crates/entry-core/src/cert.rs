//! Device TLS certificate minter — byte-identical port of `device-cert.ts`.
//!
//! The inner relay channel authenticates the peer by SPKI pin
//! (`sha256(certificate subjectPublicKeyInfo)`), not by CA trust — so the
//! device identity only needs a deterministic, correctly-encoded self-signed
//! certificate carrying the custody-held Ed25519 key. Nothing here is a CA
//! substitute.

use ed25519_dalek::Signer;
use sha2::{Digest, Sha256};

use crate::b64::{b64u_decode, b64u_encode};
use crate::error::{entry_error, Result};
use crate::keys::{ed25519_pkcs8_der, raw_public_key_to_spki_der, Ed25519Keypair};

const OID_ED25519: [u8; 3] = [0x2b, 0x65, 0x70]; // RFC 8410 id-Ed25519
const OID_CN: [u8; 3] = [0x55, 0x04, 0x03]; // X.520 id-at-commonName

fn der_len(length: usize) -> Vec<u8> {
    if length < 0x80 {
        vec![length as u8]
    } else if length <= 0xff {
        vec![0x81, length as u8]
    } else if length <= 0xffff {
        vec![0x82, (length >> 8) as u8, (length & 0xff) as u8]
    } else {
        vec![
            0x83,
            (length >> 16) as u8,
            (length >> 8) as u8,
            (length & 0xff) as u8,
        ]
    }
}

fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len() + 8);
    out.push(tag);
    out.extend_from_slice(&der_len(content.len()));
    out.extend_from_slice(content);
    out
}

fn seq(parts: &[&[u8]]) -> Vec<u8> {
    let mut content = Vec::new();
    for p in parts {
        content.extend_from_slice(p);
    }
    tlv(0x30, &content)
}

fn set(parts: &[&[u8]]) -> Vec<u8> {
    let mut content = Vec::new();
    for p in parts {
        content.extend_from_slice(p);
    }
    tlv(0x31, &content)
}

fn oid(encoded: &[u8]) -> Vec<u8> {
    tlv(0x06, encoded)
}

fn utf8(text: &str) -> Vec<u8> {
    tlv(0x0c, text.as_bytes())
}

fn utc_time(epoch_ms: i64) -> Result<Vec<u8>> {
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(epoch_ms)
        .ok_or_else(|| entry_error("cert_invalid", "UTCTime supports 1950..2049."))?;
    let y = dt.format("%Y").to_string().parse::<i64>().unwrap_or(0);
    if !(1950..=2049).contains(&y) {
        return Err(entry_error(
            "cert_invalid",
            "UTCTime supports 1950..2049; pick a nearer validity window.",
        ));
    }
    let text = format!("{}Z", dt.format("%y%m%d%H%M%S"));
    Ok(tlv(0x17, text.as_bytes()))
}

fn bit_string(bytes: &[u8]) -> Vec<u8> {
    let mut content = Vec::with_capacity(bytes.len() + 1);
    content.push(0x00);
    content.extend_from_slice(bytes);
    tlv(0x03, &content)
}

fn explicit(n: u8, inner: &[u8]) -> Vec<u8> {
    tlv(0xa0 + n, inner)
}

fn integer(bytes: &[u8]) -> Vec<u8> {
    // Strip leading zeros; re-pad if the high bit would read as negative.
    let mut raw: &[u8] = bytes;
    while raw.len() > 1 && raw[0] == 0 && (raw[1] & 0x80) == 0 {
        raw = &raw[1..];
    }
    let mut padded = Vec::with_capacity(raw.len() + 1);
    if raw.first().is_some_and(|b| b & 0x80 != 0) {
        padded.push(0);
    }
    padded.extend_from_slice(raw);
    tlv(0x02, &padded)
}

fn common_name(cn: &str) -> Vec<u8> {
    seq(&[&set(&[&seq(&[&oid(&OID_CN), &utf8(cn)])])])
}

#[derive(Debug, Clone)]
pub struct IssuedDeviceCertificate {
    /// PEM armoring — kept for parity/debug output.
    pub cert_pem: String,
    pub cert_der: Vec<u8>,
    /// `sha256(SPKI DER)` base64url — the inner-channel pin form.
    pub spki_pin: String,
}

/// Issue a self-signed Ed25519 device certificate. `sign` signs the TBS bytes
/// and returns the raw 64-byte Ed25519 signature — in production this is the
/// custody-held device key; the key never leaves the caller.
pub fn issue_device_certificate(
    public_key_raw: &[u8; 32],
    sign: impl Fn(&[u8]) -> [u8; 64],
    subject: Option<&str>,
    serial: Option<&[u8]>,
    not_before_ms: Option<i64>,
    not_after_ms: Option<i64>,
) -> Result<IssuedDeviceCertificate> {
    let spki_der = raw_public_key_to_spki_der(public_key_raw);
    let spki_pin = format!("{}", b64u_encode(&Sha256::digest(&spki_der)));
    let not_before = not_before_ms.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    let not_after =
        not_after_ms.unwrap_or(not_before + 2 * 365 * 24 * 3600 * 1000);
    let mut serial_bytes: Vec<u8> = match serial {
        Some(s) => s.to_vec(),
        None => Sha256::digest(&spki_der)[..16].to_vec(),
    };
    if serial_bytes.is_empty() {
        return Err(entry_error("cert_invalid", "Certificate serial must not be empty."));
    }
    serial_bytes[0] &= 0x7f; // serials are positive integers
    let name = common_name(subject.unwrap_or(&format!("meshrix-entry {}", &spki_pin[..16])));

    let tbs = seq(&[
        &explicit(0, &integer(&[2])), // version v3
        &integer(&serial_bytes),
        &seq(&[&oid(&OID_ED25519)]),  // signature algorithm
        &name,                        // issuer (self-signed)
        &seq(&[&utc_time(not_before)?, &utc_time(not_after)?]),
        &name,                        // subject
        &spki_der,
    ]);
    let signature = sign(&tbs);
    let cert_der = seq(&[&tbs, &seq(&[&oid(&OID_ED25519)]), &bit_string(&signature)]);
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &cert_der);
    let pem = format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
        b64.as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
    );
    Ok(IssuedDeviceCertificate {
        cert_pem: pem,
        cert_der,
        spki_pin,
    })
}

/// Mint a certificate for a custody-loaded keypair (the signing happens
/// in-memory; the custody boundary was crossed once at load).
pub fn device_certificate_for_keypair(keypair: &Ed25519Keypair) -> Result<IssuedDeviceCertificate> {
    let key = keypair.signing_key.clone();
    issue_device_certificate(&keypair.public_key_raw(), move |tbs| key.sign(tbs).to_bytes(), None, None, None, None)
}

/// The pin an endpoint can derive from a stored raw Ed25519 public key
/// (`ed25519SpkiPinFromRaw`).
pub fn ed25519_spki_pin_from_raw(raw_public_key_base64url: &str) -> Option<String> {
    let raw = b64u_decode(raw_public_key_base64url, 64).ok()?;
    if raw.len() != 32 {
        return None;
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&raw);
    Some(b64u_encode(&Sha256::digest(raw_public_key_to_spki_der(&arr))))
}

/// PKCS#8 DER for the custody-loaded signing key — what rustls's client
/// certifier consumes.
pub fn device_key_pkcs8_for_rustls(keypair: &Ed25519Keypair) -> Vec<u8> {
    ed25519_pkcs8_der(&keypair.signing_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::generate_ed25519_keypair;

    #[test]
    fn cert_structure_and_pin() {
        let kp = generate_ed25519_keypair();
        let issued = device_certificate_for_keypair(&kp).unwrap();
        // SPKI pin must equal sha256 of the raw-key SPKI der.
        let expected = ed25519_spki_pin_from_raw(&kp.public_key_b64u()).unwrap();
        assert_eq!(issued.spki_pin, expected);
        // Cert parses as DER: starts with SEQUENCE and embeds the SPKI.
        assert_eq!(issued.cert_der[0], 0x30);
        let spki = raw_public_key_to_spki_der(&kp.public_key_raw());
        assert!(issued
            .cert_der
            .windows(spki.len())
            .any(|w| w == spki.as_slice()));
        assert!(issued.cert_pem.starts_with("-----BEGIN CERTIFICATE-----"));
    }
}
