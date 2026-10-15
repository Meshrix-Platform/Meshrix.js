//! Device↔device peer crypto — Rust port of `packages/peer-crypto`.
//!
//! Encrypted envelopes ride the admitted private-relay forward session; the
//! relay sees ciphertext only. libsignal's `?Send` store traits confine all
//! crypto execution to the peer runtime's dedicated single thread.

pub mod application;
pub mod application_journal;
pub mod application_engine;
pub mod bridge;
pub mod bundle;
pub mod client;
pub mod client_store;
pub mod envelope;
pub mod identity;
pub mod host;
pub mod overlay;
pub mod runtime;
pub mod session;
pub mod store;
pub mod types;
pub mod wire;

pub use bundle::{generate_peer_prekey_bundle, PeerPreKeyBundle};
pub use envelope::{PeerEnvelope, PeerEnvelopeMessageType};
pub use identity::{
    create_peer_identity, load_peer_identity, replenish_peer_prekeys, rotate_signed_pre_key,
    sign_peer_identity_message, verify_peer_identity_message, PairedSignalIdentity, PeerIdentity,
    PeerPrekeyPoolSize,
};
pub use session::{
    block_peer_identity, peer_safety_number, pin_peer_identity, pinned_identity_matches,
    repin_peer_identity, PeerSession, PeerSessionStores,
};
pub use store::{FilePeerCryptoStore, PeerCryptoStore, PeerIdentityBinding};
pub use types::{is_peer_id, PEER_DEVICE_ID};
pub use crate::wire::recovery::peer_id_for_route_device;
pub mod router;

pub use application::{
    AcpAgentSummary, AcpPermissionResolution, PeerApplicationAddress,
    PeerApplicationDiscoveryRecord, PeerApplicationRecord, PeerApplicationRouteAuthority,
};
pub use client::PeerRouteIdentity;
pub use host::{PeerAttachRequest, PeerHost, PeerHostEvent, PeerHostOptions};
