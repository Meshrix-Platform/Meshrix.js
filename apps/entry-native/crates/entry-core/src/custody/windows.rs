//! Windows DPAPI custody — same store as `custody-windows.ts` (CurrentUser
//! ProtectedData blobs persisted as files), but calls `CryptProtectData`
//! directly instead of shelling through PowerShell: the .NET ProtectedData
//! API the TS adapter invokes is the same OS facility.

use std::fs;
use std::path::PathBuf;

use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};

use crate::b64::{b64u_decode, b64u_encode};
use crate::error::{entry_error, Result};

use super::{assert_custody_ref, CustodyAdapter};

pub struct WindowsDpapiCustodyAdapter {
    data_dir: PathBuf,
}

impl WindowsDpapiCustodyAdapter {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    fn path(&self, ref_: &str) -> PathBuf {
        self.data_dir.join(format!("{}.custody.dpapi", ref_))
    }

    fn protect(secret: &[u8]) -> Result<Vec<u8>> {
        unsafe {
            let mut input = CRYPT_INTEGER_BLOB {
                cbData: secret.len() as u32,
                pbData: secret.as_ptr() as *mut u8,
            };
            let mut output = CRYPT_INTEGER_BLOB::default();
            CryptProtectData(&mut input, None, None, None, None, 0, &mut output).map_err(|e| {
                entry_error("custody_unavailable", format!("CryptProtectData failed: {e}"))
            })?;
            let blob = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
                output.pbData as *mut core::ffi::c_void,
            )));
            Ok(blob)
        }
    }

    fn unprotect(blob: &[u8]) -> Result<Vec<u8>> {
        unsafe {
            let mut input = CRYPT_INTEGER_BLOB {
                cbData: blob.len() as u32,
                pbData: blob.as_ptr() as *mut u8,
            };
            let mut output = CRYPT_INTEGER_BLOB::default();
            CryptUnprotectData(&mut input, None, None, None, None, 0, &mut output).map_err(|_| {
                entry_error(
                    "custody_payload_invalid",
                    "The DPAPI blob could not be unprotected on this account.",
                )
            })?;
            let secret = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
                output.pbData as *mut core::ffi::c_void,
            )));
            Ok(secret)
        }
    }
}

impl CustodyAdapter for WindowsDpapiCustodyAdapter {
    fn kind(&self) -> &'static str {
        "windows-dpapi"
    }

    fn available(&self) -> bool {
        fs::create_dir_all(&self.data_dir).is_ok() && self.data_dir.is_dir()
    }

    fn store_secret(&self, ref_: &str, secret: &[u8]) -> Result<()> {
        let ref_ = assert_custody_ref(ref_)?;
        if !self.available() {
            return Err(entry_error(
                "custody_unavailable",
                format!("DPAPI custody directory {} is not writable.", self.data_dir.display()),
            ));
        }
        let blob = Self::protect(secret)?;
        fs::write(self.path(ref_), b64u_encode(&blob))?;
        Ok(())
    }

    fn load_secret(&self, ref_: &str) -> Result<Option<Vec<u8>>> {
        let ref_ = assert_custody_ref(ref_)?;
        let raw = match fs::read_to_string(self.path(ref_)) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let blob = b64u_decode(raw.trim(), 256 * 1024)?;
        Ok(Some(Self::unprotect(&blob)?))
    }

    fn delete_secret(&self, ref_: &str) -> Result<()> {
        let ref_ = assert_custody_ref(ref_)?;
        match fs::remove_file(self.path(ref_)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}
