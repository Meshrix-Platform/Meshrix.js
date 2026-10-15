//! Encrypted file custody fallback — byte-compatible port of `custody-file.ts`.
//! Envelope: `{schemaVersion, kind:"entry-custody-file", ref, salt, nonce,
//! ciphertext}` where ciphertext = AES-256-GCM output `ct||tag`, key =
//! HKDF-SHA-256(wrapSecret, ENTRY_CUSTODY_FILE_LABEL), AAD =
//! `"meshrix.entry.custody-file|<ref>" || salt`.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};

use rand::Rng;
use std::fs;
use std::path::{Path, PathBuf};

use crate::b64::{b64u_decode, b64u_encode};
use crate::error::{entry_error, Result};
use crate::keys::hkdf_label;

use super::{assert_custody_ref, CustodyAdapter};

pub const ENTRY_CUSTODY_FILE_SCHEMA: &str = "v0.0.1:entry:custody-file-1";
pub const ENTRY_CUSTODY_FILE_LABEL: &str = "meshrix/entry/custody-file/v1";

const WRAP_SECRET_BYTES: usize = 32;
const SALT_BYTES: usize = 16;
const IV_BYTES: usize = 12;

pub struct FileCustodyAdapter {
    data_dir: PathBuf,
    wrap_secret: [u8; WRAP_SECRET_BYTES],
}

fn custody_path(data_dir: &Path, ref_: &str) -> PathBuf {
    data_dir.join(format!("{}.custody.json", assert_custody_ref(ref_).unwrap_or("invalid")))
}

fn aad_for(ref_: &str, salt: &[u8]) -> Vec<u8> {
    let mut aad = format!("meshrix.entry.custody-file|{ref_}").into_bytes();
    aad.extend_from_slice(salt);
    aad
}

impl FileCustodyAdapter {
    pub fn new(data_dir: PathBuf, wrap_secret: [u8; WRAP_SECRET_BYTES]) -> Result<Self> {
        Ok(Self {
            data_dir,
            wrap_secret,
        })
    }

    fn cipher(&self) -> Aes256Gcm {
        let key = hkdf_label(&self.wrap_secret, ENTRY_CUSTODY_FILE_LABEL, 32);
        Aes256Gcm::new_from_slice(&key).expect("32-byte key is valid AES-256")
    }
}

impl CustodyAdapter for FileCustodyAdapter {
    fn kind(&self) -> &'static str {
        "file"
    }

    fn available(&self) -> bool {
        if fs::create_dir_all(&self.data_dir).is_err() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.data_dir, fs::Permissions::from_mode(0o700));
        }
        self.data_dir.is_dir()
    }

    fn store_secret(&self, ref_: &str, secret: &[u8]) -> Result<()> {
        let ref_ = assert_custody_ref(ref_)?;
        if !self.available() {
            return Err(entry_error(
                "custody_unavailable",
                format!("File custody directory {} is not writable.", self.data_dir.display()),
            ));
        }
        let mut salt = [0u8; SALT_BYTES];
        let mut iv = [0u8; IV_BYTES];
        rand::rng().fill(&mut salt);
        rand::rng().fill(&mut iv);
        let ciphertext = self
            .cipher()
            .encrypt(
                Nonce::from_slice(&iv),
                aes_gcm::aead::Payload {
                    msg: secret,
                    aad: &aad_for(ref_, &salt),
                },
            )
            .map_err(|_| entry_error("custody_payload_invalid", "Custody encryption failed."))?;
        let body = serde_json::json!({
            "schemaVersion": ENTRY_CUSTODY_FILE_SCHEMA,
            "kind": "entry-custody-file",
            "ref": ref_,
            "salt": b64u_encode(&salt),
            "nonce": b64u_encode(&iv),
            "ciphertext": b64u_encode(&ciphertext),
        });
        let file = custody_path(&self.data_dir, ref_);
        let tmp = file.with_extension(format!(
            "{}.{}.tmp",
            std::process::id(),
            b64u_encode(&salt[..6])
        ));
        fs::write(&tmp, format!("{}\n", serde_json::to_string(&body)?))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        fs::rename(&tmp, &file)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&file, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    fn load_secret(&self, ref_: &str) -> Result<Option<Vec<u8>>> {
        let ref_ = assert_custody_ref(ref_)?;
        let file = custody_path(&self.data_dir, ref_);
        let raw = match fs::read_to_string(&file) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let body: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|_| entry_error("custody_payload_invalid", format!("Custody file for {ref_} is malformed.")))?;
        let valid = body.get("schemaVersion").and_then(|v| v.as_str()) == Some(ENTRY_CUSTODY_FILE_SCHEMA)
            && body.get("kind").and_then(|v| v.as_str()) == Some("entry-custody-file")
            && body.get("ref").and_then(|v| v.as_str()) == Some(ref_);
        if !valid {
            return Err(entry_error(
                "custody_payload_invalid",
                format!("Custody file for {ref_} is malformed."),
            ));
        }
        let salt = b64u_decode(body["salt"].as_str().unwrap_or_default(), 64)?;
        let iv = b64u_decode(body["nonce"].as_str().unwrap_or_default(), 64)?;
        let payload = b64u_decode(body["ciphertext"].as_str().unwrap_or_default(), 256 * 1024)?;
        if salt.len() != SALT_BYTES || iv.len() != IV_BYTES || payload.len() < 16 {
            return Err(entry_error(
                "custody_payload_invalid",
                format!("Custody file for {ref_} has invalid fields."),
            ));
        }
        let plaintext = self
            .cipher()
            .decrypt(
                Nonce::from_slice(&iv),
                aes_gcm::aead::Payload {
                    msg: &payload,
                    aad: &aad_for(ref_, &salt),
                },
            )
            .map_err(|_| {
                entry_error(
                    "custody_payload_invalid",
                    format!("Custody file for {ref_} could not be decrypted."),
                )
            })?;
        Ok(Some(plaintext))
    }

    fn delete_secret(&self, ref_: &str) -> Result<()> {
        let ref_ = assert_custody_ref(ref_)?;
        match fs::remove_file(custody_path(&self.data_dir, ref_)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_tamper() {
        let dir = std::env::temp_dir().join(format!("custody-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let adapter = FileCustodyAdapter::new(dir.clone(), [7u8; 32]).unwrap();
        assert!(adapter.available());
        assert!(adapter.load_secret("meshrix.test").unwrap().is_none());
        adapter.store_secret("meshrix.test", b"seed-bytes-here").unwrap();
        assert_eq!(adapter.load_secret("meshrix.test").unwrap().unwrap(), b"seed-bytes-here");
        adapter.store_secret("meshrix.test", b"rotated").unwrap();
        assert_eq!(adapter.load_secret("meshrix.test").unwrap().unwrap(), b"rotated");
        adapter.delete_secret("meshrix.test").unwrap();
        assert!(adapter.load_secret("meshrix.test").unwrap().is_none());
        adapter.delete_secret("meshrix.test").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_bad_refs() {
        assert!(assert_custody_ref("BAD").is_err());
        assert!(assert_custody_ref("").is_err());
        assert!(assert_custody_ref("../escape").is_err());
        assert!(assert_custody_ref("ok.name-1_x").is_ok());
    }
}
