//! The one user-held recovery key — port of `recovery-key.ts`.
//!
//! Displayed once as chunked lowercase base32 text — never a hex dump, never
//! persisted by the app:
//!   `mrk1-<5>×n`   e.g. `mrk1-abcde-fghij-…`
//!
//! The text encodes `version(1B) | locatorLen(1B) | locator | secret(32B) |
//! sha256(payload)[0:4]`. The locator is the non-secret vault reference so a
//! fresh install needs no other backup artifact; the checksum catches
//! transcription errors before any network contact.


use rand::Rng;
use sha2::{Digest, Sha256};

use crate::base32::{decode_base32, encode_base32};
use crate::error::{entry_error, Result};

pub const ENTRY_RECOVERY_TEXT_PREFIX: &str = "mrk1";
pub const ENTRY_RECOVERY_SECRET_BYTES: usize = 32;
pub const ENTRY_RECOVERY_FORMAT_VERSION: u8 = 1;
const CHECKSUM_BYTES: usize = 4;
const MAX_LOCATOR_BYTES: usize = 120;

#[derive(Debug, Clone)]
pub struct RecoveryKeyMaterial {
    /// 32-byte high-entropy secret — the user-held key.
    pub secret: [u8; ENTRY_RECOVERY_SECRET_BYTES],
    /// Non-secret vault locator (usually the vaultId); empty when unassigned.
    pub vault_id: String,
    pub format_version: u8,
}

pub fn generate_recovery_key(vault_id: Option<String>) -> Result<RecoveryKeyMaterial> {
    let vault_id = vault_id.unwrap_or_default();
    assert_locator(&vault_id)?;
    let mut secret = [0u8; ENTRY_RECOVERY_SECRET_BYTES];
    rand::rng().fill(&mut secret);
    Ok(RecoveryKeyMaterial {
        secret,
        vault_id,
        format_version: ENTRY_RECOVERY_FORMAT_VERSION,
    })
}

fn assert_locator(locator: &str) -> Result<()> {
    if locator.len() > MAX_LOCATOR_BYTES {
        return Err(entry_error(
            "recovery_key_invalid",
            "Recovery locator exceeds the encode limit.",
        ));
    }
    Ok(())
}

fn checksum(payload: &[u8]) -> [u8; CHECKSUM_BYTES] {
    let digest = Sha256::digest(payload);
    [digest[0], digest[1], digest[2], digest[3]]
}

/// Format the recovery text: `mrk1-` + grouped base32 (groups of 5).
pub fn format_recovery_text(key: &RecoveryKeyMaterial) -> Result<String> {
    assert_locator(&key.vault_id)?;
    let locator = key.vault_id.as_bytes();
    let mut payload = Vec::with_capacity(1 + 1 + locator.len() + ENTRY_RECOVERY_SECRET_BYTES);
    payload.push(key.format_version);
    payload.push(locator.len() as u8);
    payload.extend_from_slice(locator);
    payload.extend_from_slice(&key.secret);
    let mut body = payload.clone();
    body.extend_from_slice(&checksum(&payload));
    let encoded = encode_base32(&body);
    let groups: Vec<&str> = encoded
        .as_bytes()
        .chunks(5)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect();
    Ok(format!("{}-{}", ENTRY_RECOVERY_TEXT_PREFIX, groups.join("-")))
}

/// Parse recovery text back to key material. Accepts surrounding whitespace,
/// extra hyphens/spaces inside the body, and mixed case; rejects unknown
/// prefixes, versions, bad checksums and wrong lengths.
pub fn parse_recovery_text(text: &str) -> Result<RecoveryKeyMaterial> {
    let trimmed = text.trim().to_lowercase();
    let body_start = if let Some(rest) = trimmed.strip_prefix(&format!("{ENTRY_RECOVERY_TEXT_PREFIX}-")) {
        rest
    } else if let Some(rest) = trimmed.strip_prefix(ENTRY_RECOVERY_TEXT_PREFIX) {
        rest
    } else {
        return Err(entry_error(
            "recovery_key_invalid",
            format!("Recovery text must begin with \"{ENTRY_RECOVERY_TEXT_PREFIX}-\"."),
        ));
    };
    let compact: String = body_start.chars().filter(|c| *c != '-' && !c.is_whitespace()).collect();
    if compact.is_empty() || !compact.chars().all(|c| matches!(c, 'a'..='z' | '2'..='7')) {
        return Err(entry_error(
            "recovery_key_invalid",
            "Recovery text contains invalid characters.",
        ));
    }
    let decoded = decode_base32(&compact)
        .map_err(|_| entry_error("recovery_key_invalid", "Recovery text is too short or malformed."))?;
    if decoded.len() < 1 + 1 + ENTRY_RECOVERY_SECRET_BYTES + CHECKSUM_BYTES {
        return Err(entry_error(
            "recovery_key_invalid",
            "Recovery text is too short or malformed.",
        ));
    }
    let payload = &decoded[..decoded.len() - CHECKSUM_BYTES];
    let actual = &decoded[decoded.len() - CHECKSUM_BYTES..];
    if checksum(payload) != actual {
        return Err(entry_error(
            "recovery_key_invalid",
            "Recovery text checksum mismatch — the key was mistyped.",
        ));
    }
    if payload[0] != ENTRY_RECOVERY_FORMAT_VERSION {
        return Err(entry_error(
            "recovery_key_invalid",
            format!("Unsupported recovery format version {}.", payload[0]),
        ));
    }
    let locator_length = payload[1] as usize;
    if 2 + locator_length + ENTRY_RECOVERY_SECRET_BYTES != payload.len() {
        return Err(entry_error(
            "recovery_key_invalid",
            "Recovery text has a malformed locator or secret length.",
        ));
    }
    let vault_id = String::from_utf8(payload[2..2 + locator_length].to_vec())
        .map_err(|_| entry_error("recovery_key_invalid", "Recovery locator is not valid UTF-8."))?;
    let mut secret = [0u8; ENTRY_RECOVERY_SECRET_BYTES];
    secret.copy_from_slice(&payload[2 + locator_length..]);
    Ok(RecoveryKeyMaterial {
        secret,
        vault_id,
        format_version: payload[0],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let key = generate_recovery_key(Some("vault.test-1".into())).unwrap();
        let text = format_recovery_text(&key).unwrap();
        assert!(text.starts_with("mrk1-"));
        let parsed = parse_recovery_text(&text).unwrap();
        assert_eq!(parsed.secret, key.secret);
        assert_eq!(parsed.vault_id, "vault.test-1");
        assert_eq!(parsed.format_version, 1);
    }

    #[test]
    fn tolerant_parse() {
        let key = generate_recovery_key(None).unwrap();
        let text = format_recovery_text(&key).unwrap();
        // Uppercase, spaces and extra hyphens inside the body all parse.
        let messy = format!("  {}  ", text.to_uppercase().replace('-', " - "));
        let parsed = parse_recovery_text(&messy).unwrap();
        assert_eq!(parsed.secret, key.secret);
        // Bare prefix without dash also accepted.
        assert_eq!(
            parse_recovery_text(&text.replacen("mrk1-", "mrk1", 1)).unwrap().secret,
            key.secret
        );
    }

    #[test]
    fn rejects_tamper_and_garbage() {
        let key = generate_recovery_key(None).unwrap();
        let text = format_recovery_text(&key).unwrap();
        assert!(parse_recovery_text("mrk0-abc").is_err());
        assert!(parse_recovery_text(&text[..text.len() - 2]).is_err());
        let mut bad = text.clone();
        bad.replace_range(10..11, "a");
        assert!(parse_recovery_text(&bad).is_err());
        assert!(parse_recovery_text("not-a-key").is_err());
    }
}
