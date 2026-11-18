/**
 * Canonical set of all valid transition result types.
 * Shared across schema, verifier, runtime, selector, and tests.
 */
export type TransitionResultType =
  | "legal_transition"
  | "illegal_transition"
  | "ignored_idempotent_event"
  | "requires_policy"
  | "requires_approval"
  | "requires_external_receipt"
  | "deferred_async_transition";

export type JsonRecord = Record<string, unknown>;
export interface StateDefinition extends JsonRecord { id: string; terminal?: boolean }
export interface EventDefinition extends JsonRecord { id: string }
export interface TransitionCell extends JsonRecord {
  from: string; event: string; to?: string; result: TransitionResultType;
  guards?: string[]; requiredGuards?: string[]; errorCode?: string; sideEffects?: string[];
}
export interface StateMachineDefinition extends JsonRecord {
  machineId: string; entityType: string; version: string; description: string; initialState: string;
  states: StateDefinition[]; events: EventDefinition[]; totalMatrix: TransitionCell[];
  invariants: string[]; proofObligations: string[];
  proofMappings?: Array<{ obligationId: string; method: string; params?: JsonRecord }>;
}
export interface TransitionInput extends JsonRecord {
  entityId?: unknown; currentStatus: string; eventType: string; actor?: unknown; reason?: unknown;
  metadata?: unknown; operationId?: unknown; traceId?: unknown; auditId?: unknown;
  checkpointNodeId?: unknown; policyDecisionId?: unknown; approvalId?: unknown; now?: unknown;
  guardContext?: JsonRecord; resumePointer?: unknown; guardEvaluator?: unknown;
}
export interface GuardResult extends JsonRecord { guardId: string; ok: boolean; reason?: string }
export type GuardEvaluator = (guardIds: string[], context: JsonRecord) => GuardResult[];
export interface ValidationIssue { errorCode: string; message: string }
export interface ValidationResult { ok: boolean; errors: ValidationIssue[] }

export const VALID_TRANSITION_RESULTS: readonly TransitionResultType[] = Object.freeze([
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
export const REACHABLE_TRANSITION_RESULTS: readonly TransitionResultType[] = Object.freeze([
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
export const HIGH_RISK_PROTECTION_RESULTS: readonly TransitionResultType[] = Object.freeze([
  "requires_policy",
  "requires_approval",
  "requires_external_receipt",
  "deferred_async_transition"
]);
