//! macOS Keychain custody — port of `custody-macos.ts`, keeping the
//! documented `security` CLI boundary so existing Keychain items written by
//! the TypeScript client resolve identically:
//!   store:  security add-generic-password    -s <service> -a <account> -w <b64> -U
//!   load:   security find-generic-password   -s <service> -a <account> -w
//!   delete: security delete-generic-password -s <service> -a <account>
//! Secrets travel base64'd through argv — same documented caveat as the TS
//! (transient same-user process inspection), the narrow accepted boundary.

use std::process::{Command, Stdio};

use crate::b64::{b64u_decode, b64u_encode};
use crate::error::{entry_error, Result};

use super::{assert_custody_ref, CustodyAdapter};

const DEFAULT_SERVICE: &str = "com.meshrix.entry.device-custody";
const ACCOUNT_PREFIX: &str = "meshrix-entry/";
/// `security` exits 44 (errSecItemNotFound) / prints this on a missing item.
const NOT_FOUND_TEXT: &str = "could not be found";

pub struct MacosKeychainCustodyAdapter {
    service: String,
}

impl MacosKeychainCustodyAdapter {
    pub fn new() -> Self {
        Self {
            service: DEFAULT_SERVICE.to_string(),
        }
    }

    fn account(ref_: &str) -> Result<String> {
        Ok(format!("{}{}", ACCOUNT_PREFIX, assert_custody_ref(ref_)?))
    }

    fn run_security(args: &[&str]) -> Result<(i32, String, String)> {
        let output = Command::new("security")
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| {
                entry_error(
                    "custody_unavailable",
                    format!("Could not invoke the macOS `security` tool: {e}"),
                )
            })?;
        let code = output.status.code().unwrap_or(1);
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Ok((code, stdout, stderr))
    }

    fn is_not_found(code: i32, stderr: &str) -> bool {
        code == 44 || stderr.contains(NOT_FOUND_TEXT)
    }
}

impl CustodyAdapter for MacosKeychainCustodyAdapter {
    fn kind(&self) -> &'static str {
        "macos-keychain"
    }

    fn available(&self) -> bool {
        matches!(Self::run_security(&["list-keychains"]), Ok((0, _, _)))
    }

    fn store_secret(&self, ref_: &str, secret: &[u8]) -> Result<()> {
        let account = Self::account(ref_)?;
        let encoded = b64u_encode(secret);
        let (code, _, stderr) = Self::run_security(&[
            "add-generic-password",
            "-s",
            &self.service,
            "-a",
            &account,
            "-w",
            &encoded,
            "-U",
        ])?;
        if code != 0 {
            return Err(entry_error(
                "custody_unavailable",
                format!("security add-generic-password failed (exit {code}). {stderr}"),
            ));
        }
        Ok(())
    }

    fn load_secret(&self, ref_: &str) -> Result<Option<Vec<u8>>> {
        let account = Self::account(ref_)?;
        let (code, stdout, stderr) = Self::run_security(&[
            "find-generic-password",
            "-s",
            &self.service,
            "-a",
            &account,
            "-w",
        ])?;
        if code != 0 {
            if Self::is_not_found(code, &stderr) {
                return Ok(None);
            }
            return Err(entry_error(
                "custody_unavailable",
                format!("security find-generic-password failed (exit {code}). {stderr}"),
            ));
        }
        let secret = b64u_decode(stdout.trim(), 256 * 1024)
            .map_err(|_| entry_error("custody_payload_invalid", "The Keychain entry is not valid base64."))?;
        Ok(Some(secret))
    }

    fn delete_secret(&self, ref_: &str) -> Result<()> {
        let account = Self::account(ref_)?;
        let (code, _, stderr) = Self::run_security(&[
            "delete-generic-password",
            "-s",
            &self.service,
            "-a",
            &account,
        ])?;
        if code != 0 && !Self::is_not_found(code, &stderr) {
            return Err(entry_error(
                "custody_unavailable",
                format!("security delete-generic-password failed (exit {code}). {stderr}"),
            ));
        }
        Ok(())
    }
}
