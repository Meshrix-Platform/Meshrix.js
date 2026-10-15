//! Pairing domain — port of `apps/entry/src/pairing/*`:
//! `invite`   the `meshrix-entry://pair#<b64u>` invite artifact
//! `session`  the trusted-pairing handshake state machine

pub mod invite;
pub mod session;

pub use invite::{
    encode_pairing_invite, invite_to_trust_binding, parse_pairing_invite_text, PairingInvite,
    PairingRecoveryAuthority, ENTRY_PAIRING_KIND, ENTRY_PAIRING_SCHEMA, ENTRY_PAIRING_URI_PREFIX,
};
pub use session::{EnrolledDeviceRecord, PairingSession, PairingState};
