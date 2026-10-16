//! Meshrix Entry native core — shared domain for the Rust CLI/TUI and egui app.
//!
//! Module map:
//! - `error`        typed entry errors used by the native service and wire layers
//! - `canonical`    canonical JSON used by every signed transcript/digest
//! - `b64`          strict base64url helpers
//! - `keys`         Ed25519 generation/signing, HKDF, fingerprints, opaque ids
//! - `base32`       the recovery-key base32 alphabet (digits 1-8, letters a-y)
//! - `transcripts`  signed transcript builders (recovery challenge, vault proofs)
//! - `custody`      OS custody adapters: macOS Keychain, Windows DPAPI, encrypted file
//! - `identity`     device identity: enroll/load/sign/delete on top of custody
//! - `recovery`     recovery root text, key derivation, snapshot sealing, bundle,
//!                  vault client, snapshot sync, recovery session, rotation
//! - `pairing`      pairing invite + pairing session state machine
//! - `wire`         private-relay + account wire contracts (schemas, limits, parsers)
//! - `relay`        WSS transport, session driver, inner pinned-TLS channel,
//!                  JSON-RPC channel, entry session, pairing/recovery channels
//! - `account`      desktop account client (transactions, pairing bootstrap, revoke)
//! - `cert`         self-signed Ed25519 device certificate minter
//! - `store`        atomic JSON config store (non-secret facts only)
//! - `service`      EntryService — the single facade CLI/TUI/GUI drive
//! - `mcp`          local MCP stdio bridge + editor snippet
//! - `agent`        A4AA agent adaptation, AwP profile registry and execution
//! - `peer`         device↔device Signal crypto: identity, prekey bundles,
//!                  durable store, envelopes, ratchet sessions

pub mod account;
pub mod agent;
pub mod b64;
pub mod base32;
pub mod canonical;
pub mod cert;
pub mod custody;
pub mod endpoint;
pub mod error;
pub mod identity;
pub mod keys;
pub mod mcp;
pub mod pairing;
pub mod peer;
pub mod recovery;
pub mod relay;
pub mod service;
pub mod store;
pub mod transcripts;
pub mod wire;

pub use error::{effect_outcome, EntryError, Result};
