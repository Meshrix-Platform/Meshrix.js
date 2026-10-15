//! Relay URL normalization — port of `relay-address.ts`.
//! `wss:` required for non-loopback relays; `ws:` only for literal loopback.

use crate::error::{entry_error, Result};
use url::Url;

const LOOPBACK_HOSTS: &[&str] = &["127.0.0.1", "localhost", "[::1]"];

fn relay_address_error(code: &str, message: &str) -> crate::EntryError {
    entry_error(code, message)
}

/// Normalize an explicitly configured relay base while retaining its route
/// prefix.
pub fn normalize_relay_base(input: &str, allow_insecure_loopback: bool) -> Result<Url> {
    let url = Url::parse(input)
        .map_err(|_| relay_address_error("private_endpoint_relay_invalid", "Relay URL is invalid."))?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(relay_address_error(
            "private_endpoint_relay_invalid",
            "Relay URL must not include credentials, a query or a fragment.",
        ));
    }
    let host = url.host_str().unwrap_or("").to_lowercase();
    let is_wss = url.scheme() == "wss";
    let is_loopback_ws = url.scheme() == "ws" && LOOPBACK_HOSTS.contains(&host.as_str());
    if !is_wss && !(is_loopback_ws && allow_insecure_loopback) {
        if url.scheme() == "ws" {
            return Err(relay_address_error(
                "private_endpoint_relay_unsafe",
                "Relay URL must use wss:; ws: is allowed only for literal loopback fixtures.",
            ));
        }
        return Err(relay_address_error(
            "private_endpoint_relay_invalid",
            "Relay URL must use wss:.",
        ));
    }
    let path = url.path().trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };
    if path.contains("//")
        || path.split('/').filter(|s| !s.is_empty()).any(|segment| {
            segment == "." || segment == ".." || segment.contains('\\') || segment.chars().any(|c| c < '\u{20}' || c == '\u{7f}')
        })
    {
        return Err(relay_address_error(
            "private_endpoint_relay_invalid",
            "Relay URL contains an invalid route prefix.",
        ));
    }
    let mut normalized = url.clone();
    normalized.set_path(path);
    Ok(normalized)
}

/// Convert the configured relay base to HTTP while preserving its prefix.
pub fn relay_http_base(input: &str, allow_insecure_loopback: bool) -> Result<String> {
    let mut url = normalize_relay_base(input, allow_insecure_loopback)?;
    let _ = url.set_scheme(if url.scheme() == "wss" { "https" } else { "http" });
    Ok(url.to_string().trim_end_matches('/').to_string())
}

/// Build a session URL relative to the relay base — never reset its prefix.
pub fn relay_session_url(input: &str, tenant_id: &str, route_id: &str, allow_insecure_loopback: bool) -> Result<String> {
    let mut url = normalize_relay_base(input, allow_insecure_loopback)?;
    let prefix = if url.path() == "/" { "" } else { url.path() };
    url.set_path(&format!(
        "{prefix}/session/{}/{}",
        urlencoding::encode(tenant_id),
        urlencoding::encode(route_id)
    ));
    Ok(url.to_string())
}
