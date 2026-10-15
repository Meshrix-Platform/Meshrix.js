//! Recovery domain — port of `apps/entry/src/recovery/*`:
//! `key`      the user-held `mrk1-` text (one-time display, never persisted)
//! `crypto`   HKDF material derivation + AES-256-GCM snapshot seal/open
//! `vault`    the HTTPS vault client (fetch + CAS write)
//! `session`  recover_device endpoint round-trips (fresh-device enrollment)
//! `bundle`   typed snapshot bundle build/parse/merge

pub mod bundle;
pub mod crypto;
pub mod key;
pub mod session;
pub mod vault;

pub use crypto::{
    derive_recovery_material, open_recovery_snapshot, seal_recovery_snapshot, snapshot_aad,
    DerivedRecoveryKey, RecoveryMaterial, RECOVERY_LABEL_BACKUP_ENCRYPTION,
    RECOVERY_LABEL_BACKUP_WRITER, RECOVERY_LABEL_SIGNING,
};
pub use key::{
    format_recovery_text, generate_recovery_key, parse_recovery_text, RecoveryKeyMaterial,
    ENTRY_RECOVERY_FORMAT_VERSION, ENTRY_RECOVERY_SECRET_BYTES, ENTRY_RECOVERY_TEXT_PREFIX,
};
pub mod service;
pub mod sync;
pub mod rotation;
