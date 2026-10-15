//! Strict base64url helpers — same alphabet/padding rules as the TS code
//! (`Buffer.toString("base64url")` / strict decoders).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

use crate::error::{entry_error, Result};

const BASE64URL_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn b64u_encode(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

/// Decode base64url exactly like the TS `base64UrlBytes` — length bounded,
/// character set strict, padding rejected.
pub fn b64u_decode(value: &str, max_len: usize) -> Result<Vec<u8>> {
    if value.is_empty() || value.len() > max_len || value.contains('=') {
        return Err(entry_error("base64_invalid", "A base64url value is malformed."));
    }
    if !value.bytes().all(|b| BASE64URL_CHARS.contains(&b)) {
        return Err(entry_error("base64_invalid", "A base64url value is malformed."));
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| entry_error("base64_invalid", "A base64url value is malformed."))
}

/// Decode a base64url value expected to produce exactly `len` bytes.
pub fn b64u_decode_exact<const N: usize>(value: &str) -> Result<[u8; N]> {
    let bytes = b64u_decode(value, 64 * 1024)?;
    bytes
        .try_into()
        .map_err(|_| entry_error("base64_invalid", "A base64url value has the wrong length."))
}
