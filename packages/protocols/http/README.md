# HTTP Protocol

Owns HTTP and console transport, controller facades, bootstrap projection, and response
normalization.

Runtime state, jobs conversion, upload-session persistence, and authorization decisions are
bound by server-runtime composition. Controllers normalize protocol envelopes and dispatch
registered operations; they do not import agents, capabilities, or server-runtime internals.
