/**
 * Canonical set of all valid transition result types.
 * Shared across schema, verifier, runtime, selector, and tests.
 */
export const VALID_TRANSITION_RESULTS = Object.freeze([
  "legal_transition",
  "illegal_transition",
  "ignored_idempotent_event",
  "requires_policy",
  "requires_approval",
  "requires_external_receipt",
  "deferred_async_transition"
]);

/**
 * Transition result types considered reachable for BFS/traversal.
 * illegal_transition and ignored_idempotent_event do not advance state.
 */
export const REACHABLE_TRANSITION_RESULTS = Object.freeze([
  "legal_transition",
  "requires_policy",
  "requires_approval",
  "requires_external_receipt",
  "deferred_async_transition"
]);

/**
 * Transition result types that provide intrinsic protection for
 * high-risk events (through their own evidence checks).
 */
export const HIGH_RISK_PROTECTION_RESULTS = Object.freeze([
  "requires_policy",
  "requires_approval",
  "requires_external_receipt",
  "deferred_async_transition"
]);
