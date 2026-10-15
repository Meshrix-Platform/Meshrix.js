//! Shared vocabulary for the device-side peer crypto layer — port of
//! `peer-crypto/types.ts` plus the contract-side `peerIdForRouteDevice`.

use crate::error::{entry_error, Result};

/** One device per peer pair: the pairing profile fixes deviceId at 1. */
pub const PEER_DEVICE_ID: u32 = 1;
pub const PEER_ENVELOPE_FORMAT: &str = "meshrix-peer-envelope";
pub const PEER_ENVELOPE_VERSION: u64 = 1;
pub const PEER_PREKEY_BUNDLE_FORMAT: &str = "meshrix-peer-prekey-bundle";
pub const PEER_PREKEY_BUNDLE_VERSION: u64 = 1;
pub const PEER_STORE_RECORD_VERSION: u64 = 1;

/// Serialized ciphertext upper bound; aligned with the relay frame payload cap.
pub const PEER_MAX_CIPHERTEXT_BYTES: usize = 262_144;
pub const PEER_MAX_ENVELOPE_BYTES: usize = 393_216;
pub const PEER_MAX_PLAINTEXT_BYTES: usize = 262_144;
pub const PEER_MAX_PREKEY_ID: u32 = 0xff_ff_ff;

pub const PEER_DEFAULT_ONE_TIME_PREKEY_COUNT: usize = 8;
pub const PEER_DEFAULT_KYBER_PREKEY_COUNT: usize = 8;
pub const PEER_SAFETY_NUMBER_ITERATIONS: u32 = 5200;
pub const PEER_SAFETY_NUMBER_VERSION: u32 = 0;

/// `^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$`
pub fn is_peer_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes[1..].iter().all(|b| {
        b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'~' | b'-')
    })
}

pub fn assert_peer_id(value: &str) -> Result<&str> {
    if !is_peer_id(value) {
        return Err(entry_error(
            "peer_envelope_malformed",
            "The peerId field is not a valid opaque peer identifier.",
        ));
    }
    Ok(value)
}

/// `PEER_CLIENT_ERROR_CODES` — the stable machine-readable vocabulary of the
/// peer-client layer; `isPeerClientError` checks membership.
pub const PEER_CLIENT_ERROR_CODES: &[&str] = &[
    "peer_client_transport",
    "peer_client_conflict",
    "peer_client_unknown_peer",
    "peer_client_trust_unavailable",
    "peer_client_bundle_unavailable",
    "peer_client_store",
    "peer_client_backpressured",
    "peer_client_state",
    "peer_application_authority_unavailable",
    "peer_application_route_revoked",
];

/// `isPeerClientError` — membership check against the stable code set.
pub fn is_peer_client_error_kind(error: &crate::error::EntryError) -> bool {
    PEER_CLIENT_ERROR_CODES.contains(&error.code.as_str())
}
