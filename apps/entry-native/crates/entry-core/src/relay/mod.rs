//! Relay transport stack — port of `packages/entry-transport/*` and the
//! `packages/gateway/src/private-endpoint` client-side pieces:
//! `session`        the wire-level session driver (state machine only)
//! `transport`      the WSS WebSocket transport actor
//! `frame_io`       relay-frame ↔ TLS-record pump (AsyncRead/AsyncWrite)
//! `inner_tls`      pinned mutual-TLS 1.3 client (SPKI pin, never CA trust)
//! `inner_channel`  newline JSON-RPC request channel over the TLS stream
//! `entry`          EntryRelaySession — the composed session + channel
//! `pairing`        restricted pair_device pairing channels
//! `recovery`       recover_device round-trip channel
//! `address`        relay URL normalization (wss-only + loopback opt-in)

pub mod address;
pub mod entry;
pub mod frame_io;
pub mod inner_channel;
pub mod inner_tls;
pub mod pairing;
pub mod recovery;
pub mod session;
pub mod transport;

pub use entry::{EntrySession, EntrySessionEvent, EntrySessionOptions};
pub use transport::WssRelayTransport;
