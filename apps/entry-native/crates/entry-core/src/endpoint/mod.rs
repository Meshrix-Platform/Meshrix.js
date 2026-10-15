//! `packages/gateway/src/private-endpoint/*` — the machine's own private
//! endpoint half: trust/device identity store, account authority, pairing,
//! relay session composition, recovery, and the personal runtime that lets
//! paired Entry devices call into local agents.

pub mod authority;
pub mod channel;
pub mod endpoint;
pub mod identity_store;
pub mod operation_recovery;
pub mod pairing;
pub mod recovery_flow;
pub mod runtime;
