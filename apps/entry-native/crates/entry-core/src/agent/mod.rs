//! Local ACP agent hosting — owner-only command registry plus subprocess
//! executor over the official `agent-client-protocol` crate.

pub mod detect;
pub mod executor;
pub mod registry;
