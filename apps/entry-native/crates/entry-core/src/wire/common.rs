//! Shared field validators — mirror of the `boundedText`/`opaqueId`/
//! `nonceToken`/`revision` helpers the contract parsers use.

use serde_json::{Map, Value};

pub const OPAQUE_ID_MAX: usize = 128;
pub const NONCE_MAX: usize = 96;
pub const KEY_MAX: usize = 256;
pub const SIGNATURE_MAX: usize = 512;
pub const DIGEST_MAX: usize = 96;
pub const MAX_SNAPSHOT_BYTES: usize = 1_048_576;

pub fn is_plain_object(value: &Value) -> bool {
    value.is_object()
}

/// Exact key-set match — the contract's `hasExactKeys`.
pub fn has_exact_keys(value: &Value, expected: &[&str]) -> bool {
    let Some(obj) = value.as_object() else { return false };
    if obj.len() != expected.len() {
        return false;
    }
    expected.iter().all(|k| obj.contains_key(*k))
}

pub fn bounded_text(value: &Value, max_bytes: usize) -> Option<String> {
    let s = value.as_str()?.trim();
    if s.is_empty() || s.len() > max_bytes {
        return None;
    }
    Some(s.to_string())
}

/// `^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$`
pub fn is_opaque_id(s: &str, max_bytes: usize) -> bool {
    let b = s.as_bytes();
    if b.len() < 2 || b.len() > max_bytes {
        return false;
    }
    if !b[0].is_ascii_alphanumeric() {
        return false;
    }
    b.iter().all(|c| {
        c.is_ascii_alphanumeric() || matches!(*c, b'.' | b'_' | b':' | b'-')
    })
}

pub fn opaque_id(value: &Value, max_bytes: usize) -> Option<String> {
    let s = bounded_text(value, max_bytes)?;
    if is_opaque_id(&s, max_bytes) {
        Some(s)
    } else {
        None
    }
}

/// `^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$`
pub fn nonce_token(value: &Value, max_bytes: usize) -> Option<String> {
    let s = bounded_text(value, max_bytes)?;
    let b = s.as_bytes();
    if !(15..=127).contains(&b.len()) || b.len() > max_bytes {
        return None;
    }
    if is_opaque_id(&s, 127) {
        Some(s)
    } else {
        None
    }
}

pub fn base64url_text(value: &Value, max_bytes: usize) -> Option<String> {
    let s = bounded_text(value, max_bytes)?;
    if s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
        Some(s)
    } else {
        None
    }
}

pub fn public_key_material(value: &Value) -> Option<String> {
    base64url_text(value, KEY_MAX)
}

pub fn signature_value(value: &Value) -> Option<String> {
    base64url_text(value, SIGNATURE_MAX)
}

/// `sha256:<64 hex>`
pub fn digest_value(value: &Value) -> Option<String> {
    let s = bounded_text(value, DIGEST_MAX)?;
    if s.len() == 71
        && s.starts_with("sha256:")
        && s[7..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        Some(s)
    } else {
        None
    }
}

/// ISO 8601 instant `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)`.
pub fn instant_value(value: &Value) -> Option<String> {
    let s = bounded_text(value, 64)?;
    let b = s.as_bytes();
    if b.len() < 20 {
        return None;
    }
    let shape = b.len() >= 20
        && b[4] == b'-'
        && b[7] == b'-'
        && (b[10] == b'T' || b[10] == b't')
        && b[13] == b':'
        && b[16] == b':'
        && b[..4].iter().all(|c| c.is_ascii_digit())
        && b[19..].iter().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'Z' | b'z' | b'+' | b'-' | b':'));
    if !shape {
        return None;
    }
    // Must actually parse.
    chrono::DateTime::parse_from_rfc3339(&s.replace('z', "Z"))
        .ok()
        .map(|_| s)
}

/// `revision`: safe non-negative integer.
pub fn revision(value: &Value) -> Option<u64> {
    let n = value.as_u64()?;
    Some(n)
}

/// `positiveRevision`: safe integer >= 1.
pub fn positive_revision(value: &Value) -> Option<u64> {
    let n = value.as_u64()?;
    if n >= 1 {
        Some(n)
    } else {
        None
    }
}

pub fn bool_value(value: &Value) -> Option<bool> {
    value.as_bool()
}

pub fn enum_value<'a>(value: &Value, allowed: &[&'a str]) -> Option<&'a str> {
    let s = value.as_str()?;
    allowed.iter().copied().find(|a| *a == s)
}

/// Opaque base64url bytes budgeted the same way as the contract
/// (`ceil(maxBytes * 4/3) + 8` encoded chars).
pub fn opaque_bytes(value: &Value, max_bytes: usize) -> Option<String> {
    let cap = (max_bytes * 4).div_ceil(3) + 8;
    let s = bounded_text(value, cap)?;
    if s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
        Some(s)
    } else {
        None
    }
}

pub fn get<'a>(obj: &'a Map<String, Value>, key: &str) -> &'a Value {
    static NULL: Value = Value::Null;
    obj.get(key).unwrap_or(&NULL)
}

/// The relay-forbidden key list — semantic material that must never appear
/// in a relay-visible message.
pub const PRIVATE_RELAY_FORBIDDEN_KEYS: &[&str] = &[
    "apiKey", "arguments", "authorization", "catalog", "catalogName", "content",
    "credential", "credentials", "grant", "grantId", "grants", "plaintext",
    "principal", "privateKey", "prompt", "result", "scope", "scopes", "secret",
    "serviceLocation", "toolName", "token", "tool", "upstream", "upstreamHost",
];

pub const PRIVATE_RELAY_SNAPSHOT_FORBIDDEN_KEYS: &[&str] = &[
    "apiKey", "authorization", "catalog", "config", "credential", "credentials",
    "devicePrivateKey", "endpointTrust", "grant", "grants", "keyMaterial",
    "peerName", "plaintext", "principal", "privateKey", "recoverySecret",
    "secret", "tlsKeyLog", "token", "upstream",
];

fn contains_forbidden(value: &Value, forbidden: &[&str], seen: &mut std::collections::HashSet<usize>) -> bool {
    match value {
        Value::Object(map) => {
            let ptr = map as *const _ as usize;
            if !seen.insert(ptr) {
                return false;
            }
            if map.keys().any(|k| forbidden.contains(&k.as_str())) {
                return true;
            }
            map.values().any(|v| contains_forbidden(v, forbidden, seen))
        }
        Value::Array(items) => {
            let ptr = items.as_ptr() as usize;
            if !seen.insert(ptr) {
                return false;
            }
            items.iter().any(|v| contains_forbidden(v, forbidden, seen))
        }
        _ => false,
    }
}

pub fn contains_forbidden_relay_keys(value: &Value) -> bool {
    contains_forbidden(value, PRIVATE_RELAY_FORBIDDEN_KEYS, &mut std::collections::HashSet::new())
}

pub fn contains_forbidden_snapshot_keys(value: &Value) -> bool {
    contains_forbidden(value, PRIVATE_RELAY_SNAPSHOT_FORBIDDEN_KEYS, &mut std::collections::HashSet::new())
}
