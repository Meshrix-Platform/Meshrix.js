//! OS custody adapters — port of `apps/entry/src/identity/custody*`.
//!
//! Boundary contract identical to the TypeScript interface:
//! refs are lowercase opaque names, secrets are opaque bytes, and adapters
//! never return plaintext to serialized state — `store`/`load`/`delete` only.

mod file;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

pub use file::FileCustodyAdapter;
#[cfg(target_os = "macos")]
pub use macos::MacosKeychainCustodyAdapter;
#[cfg(target_os = "windows")]
pub use windows::WindowsDpapiCustodyAdapter;

use crate::error::{entry_error, Result};

pub use file::{ENTRY_CUSTODY_FILE_LABEL, ENTRY_CUSTODY_FILE_SCHEMA};

/// Custody ref naming shared by all adapters; doubles as a filename component.
/// Same regex as `CUSTODY_REF_PATTERN` in custody-types.ts.
pub const CUSTODY_REF_PATTERN: &str = "^[a-z0-9][a-z0-9._-]{0,127}$";

pub fn assert_custody_ref(ref_: &str) -> Result<&str> {
    let ok = !ref_.is_empty()
        && ref_.len() <= 128
        && ref_.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && ref_
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_' || b == b'-');
    if !ok {
        return Err(entry_error(
            "custody_invalid_ref",
            format!("Custody ref must match {CUSTODY_REF_PATTERN}."),
        ));
    }
    Ok(ref_)
}

/// The narrow adapter interface — identical shape to `CustodyAdapter` in TS.
/// Sync: custody operations are tiny and always called from blocking contexts.
pub trait CustodyAdapter: Send + Sync {
    /// Stable adapter kind, e.g. "macos-keychain".
    fn kind(&self) -> &'static str;
    /// Probe the backing store without writing. Never fails: an unavailable
    /// backend returns false so selection/fallback stays deterministic.
    fn available(&self) -> bool;
    /// Persist secret bytes under `ref`, replacing any prior value.
    fn store_secret(&self, ref_: &str, secret: &[u8]) -> Result<()>;
    /// Load secret bytes; `Ok(None)` when absent. Backend errors return Err.
    fn load_secret(&self, ref_: &str) -> Result<Option<Vec<u8>>>;
    /// Remove the entry; deleting an absent ref is a no-op.
    fn delete_secret(&self, ref_: &str) -> Result<()>;
}

/// Custody selection — same contract as `selectCustodyAdapter`:
/// `auto` picks the platform store on macOS/Windows and requires the file
/// fallback elsewhere; `os` refuses to run without a protected platform
/// store; `file` always selects the encrypted-file fallback (which refuses
/// to run without an explicit 32-byte wrap secret).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CustodyPreference {
    Auto,
    Os,
    File,
}

pub struct CustodyOptions {
    pub preference: CustodyPreference,
    /// Required for `File` and for `Auto` on platforms without an OS adapter.
    pub file: Option<FileCustodyConfig>,
}

pub struct FileCustodyConfig {
    pub data_dir: std::path::PathBuf,
    pub wrap_secret: [u8; 32],
}

pub enum SelectedCustody {
    Adapter(Box<dyn CustodyAdapter>),
    /// "os" | "file" — which class of backend the selection resolved to.
    Selection(&'static str),
}

pub fn select_custody_adapter(options: CustodyOptions) -> Result<Box<dyn CustodyAdapter>> {
    match options.preference {
        CustodyPreference::File => {
            let file = options.file.ok_or_else(|| {
                entry_error(
                    "custody_file_options_missing",
                    "File custody fallback requires an explicit dataDir and wrap secret.",
                )
            })?;
            Ok(Box::new(FileCustodyAdapter::new(file.data_dir, file.wrap_secret)?))
        }
        CustodyPreference::Os | CustodyPreference::Auto => {
            #[cfg(target_os = "macos")]
            {
                return Ok(Box::new(MacosKeychainCustodyAdapter::new()));
            }
            #[cfg(target_os = "windows")]
            {
                let dir = options
                    .file
                    .map(|f| f.data_dir)
                    .or_else(|| directories::ProjectDirs::from("ai", "meshrix", "entry").map(|d| d.data_dir().join("custody")))
                    .ok_or_else(|| entry_error("custody_file_options_missing", "Windows DPAPI custody requires a data directory."))?;
                return Ok(Box::new(WindowsDpapiCustodyAdapter::new(dir)));
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                if options.preference == CustodyPreference::Os {
                    return Err(entry_error(
                        "custody_backend_missing",
                        format!(
                            "No protected OS custody adapter exists for platform \"{}\"; choose the file fallback explicitly.",
                            std::env::consts::OS
                        ),
                    ));
                }
                let file = options.file.ok_or_else(|| {
                    entry_error(
                        "custody_file_options_missing",
                        "File custody fallback requires an explicit dataDir and wrap secret.",
                    )
                })?;
                Ok(Box::new(FileCustodyAdapter::new(file.data_dir, file.wrap_secret)?))
            }
        }
    }
}
