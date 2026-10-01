import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";

/**
 * Explicit model for governed upload-workspace materialization.
 *
 * This module owns the named identities, request/descriptor normalization,
 * publication and settlement evidence shapes, and the durable state union the
 * engine, the transaction store and the provider all share. Every ingestion
 * boundary accepts `unknown` and returns a validated model value; stage and
 * status select which facts are required, so an illegal persisted combination
 * is rejected here instead of being carried as an optional bag.
 */

export const UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID =
  "jobs.upload_workspace_materialize";
export const UPLOAD_WORKSPACE_MATERIALIZATION_SCHEMA_VERSION =
  "v0.0.1:jobs:upload-workspace-materialization-3";
export const DEFINITION_ID =
  "queue.jobs.upload-workspace-materialization";
export const DEFINITION_VERSION = 3;
export const DEFAULT_LEASE_MS = 60_000;
export const MAX_DESCRIPTOR_BYTES = 64 * 1024 * 1024;
export const SCHEMA_VERSION = 1;
export const SCHEMA_FINGERPRINT_VERSION =
  "v0.0.1:server-runtime:upload-workspace-materialization-schema-1";
export const PUBLICATION_INTENT_VERSION =
  "v0.0.1:agent-workspace:materialization-publication-intent-2";
export const PUBLICATION_RESERVATION_VERSION =
  "v0.0.1:agent-workspace:materialization-publication-reservation-1";
export const PUBLICATION_PROOF_VERSION =
  "v0.0.1:agent-workspace:materialization-publication-proof-2";
export const SETTLEMENT_VERSION =
  "v0.0.1:server-runtime:upload-workspace-materialization-settlement-1";
export const RECONCILE_INDEX =
  "idx_materialization_requests_reconcile";
export const MAX_RECONCILE_BATCH = 256;
export const MATERIALIZATION_MAX_ATTEMPTS = 1_000_000;

export type MaterializationStatus =
  "cancelled" | "completed" | "failed" | "queued" | "running";

export type MaterializationStage =
  | "admitted"
  | "publication_intent"
  | "temp_reserved"
  | "publication_prepared"
  | "published"
  | "evidence_pending"
  | "audit_finalized"
  | "proof_finalized"
  | "completed"
  | "rollback_incomplete";

export const REQUEST_STATUSES: readonly MaterializationStatus[] = Object.freeze([
  "cancelled",
  "completed",
  "failed",
  "queued",
  "running"
]);
export const REQUEST_STAGES: readonly MaterializationStage[] = Object.freeze([
  "admitted",
  "publication_intent",
  "temp_reserved",
  "publication_prepared",
  "published",
  "evidence_pending",
  "audit_finalized",
  "proof_finalized",
  "completed",
  "rollback_incomplete"
]);
export const REQUEST_COLUMNS: readonly string[] = Object.freeze([
  "effect_json",
  "error_json",
  "evidence_json",
  "lease_until",
  "owner_fence",
  "parent_fingerprint",
  "parent_identity_json",
  "preimage_json",
  "prior_revision",
  "publication_json",
  "published_revision",
  "request_digest",
  "request_json",
  "request_ref",
  "result_json",
  "stage",
  "status",
  "target_state_digest",
  "updated_at"
]);
export const REQUEST_RECORD_KEYS: readonly string[] = Object.freeze([
  "approvalIntentDigest",
  "authorityBindingDigest",
  "authorityRef",
  "bindingDigest",
  "descriptor",
  "expectedWorkspaceRevision",
  "logicalTarget",
  "operationId",
  "requestDigest",
  "requestRef",
  "resourceRevision",
  "uploadSessionId",
  "workspaceId"
]);
export const PUBLICATION_KEYS: readonly string[] = Object.freeze([
  "byteCount",
  "contentDigest",
  "intentDigest",
  "logicalTargetDigest",
  "parentFingerprint",
  "parentIdentity",
  "preparedIdentity",
  "priorRevision",
  "proofDigest",
  "publicationId",
  "reservationDigest",
  "stateEventAnchor",
  "stateOperationId",
  "targetStateDigest",
  "tempLeafRef"
]);
export const EFFECT_KEYS: readonly string[] = Object.freeze([
  "byteCount",
  "checkpointRef",
  "contentDigest",
  "proofDigest",
  "publicationId",
  "publishedIdentity",
  "publishedRevision",
  "stateOperationId"
]);
export const EVIDENCE_KEYS: readonly string[] = Object.freeze([
  "auditCreatedAt",
  "auditId",
  "auditRef",
  "proofOutcomeKey",
  "proofRef",
  "settlementDigest"
]);

export const MATERIALIZATION_RECOVERY_STAGES:
  readonly MaterializationStage[] = Object.freeze([
    "publication_intent",
    "temp_reserved",
    "publication_prepared",
    "published",
    "evidence_pending",
    "audit_finalized",
    "proof_finalized"
  ]);
export const MATERIALIZATION_PRECOMMIT_RECOVERY_STAGES:
  readonly MaterializationStage[] = Object.freeze([
    "publication_intent",
    "temp_reserved",
    "publication_prepared"
  ]);
export const MATERIALIZATION_COMMITTED_STAGES:
  readonly MaterializationStage[] = Object.freeze([
    "published",
    "evidence_pending",
    "audit_finalized",
    "proof_finalized"
  ]);

export interface MaterializationFailure extends Error {
  readonly code: string;
  readonly statusCode: number;
}

export function digest(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
}

export function text(value: unknown): string {
  return String(value || "").trim();
}

export function failure(
  code: string,
  statusCode: number,
  message: string
): MaterializationFailure {
  return Object.assign(new Error(message), { code, statusCode });
}

export function schemaFailure(
  code: string,
  message: string
): MaterializationFailure {
  return failure(code, 500, message);
}

export function storedDataFailure(message: string): MaterializationFailure {
  return failure(
    "materialization_schema_data_invalid",
    409,
    message
  );
}

function digestSchema(): string {
  return digest({
    version: SCHEMA_FINGERPRINT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    requestColumns: REQUEST_COLUMNS,
    statuses: REQUEST_STATUSES,
    stages: REQUEST_STAGES
  });
}

export const SCHEMA_FINGERPRINT = digestSchema();

export interface MaterializationDescriptor {
  readonly byteCount: number;
  readonly contentDigest: string;
  readonly custodyRef: string;
  readonly envelopeDigest: string;
  readonly resourceRef: string;
  readonly state: "sealed_no_run";
}

export interface MaterializationOwner {
  readonly subjectId: string;
  readonly tenantId: string;
  readonly userId: string;
}

export interface MaterializationRequestReferenceFacts {
  readonly expectedWorkspaceRevision: string;
  readonly logicalTarget: string;
  readonly uploadSessionId: string;
  readonly workspaceId: string;
}

export interface MaterializationClosedAdmissionInput
  extends MaterializationRequestReferenceFacts {
  readonly safetyConfirm: true;
}

export interface MaterializationRequestRecord {
  readonly approvalIntentDigest: string;
  readonly authorityBindingDigest: string;
  readonly authorityRef: string;
  readonly bindingDigest: string;
  readonly descriptor: MaterializationDescriptor;
  readonly expectedWorkspaceRevision: string;
  readonly logicalTarget: string;
  readonly operationId: typeof UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID;
  readonly requestDigest: string;
  readonly requestRef: string;
  readonly resourceRevision: string;
  readonly uploadSessionId: string;
  readonly workspaceId: string;
}

export interface MaterializationStateEventAnchor {
  readonly eventHash: string;
  readonly offset: number;
}

export interface MaterializationFsIdentity {
  readonly birthtimeNs: string;
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
}

export interface MaterializationPreparedFsIdentity
  extends MaterializationFsIdentity {
  readonly byteCount: number;
  readonly contentDigest: string;
}

export interface MaterializationPreimage {
  readonly workspaceId: string;
  readonly stateRoot: string;
  readonly files: readonly unknown[];
  readonly stateEventAnchor: MaterializationStateEventAnchor;
  readonly [key: string]: unknown;
}

export interface MaterializationPublicationFacts {
  readonly request: MaterializationRequestRecord;
  readonly parentFingerprint: string;
  readonly parentIdentity: MaterializationFsIdentity;
  readonly stateEventAnchor: MaterializationStateEventAnchor;
  readonly targetStateDigest: string;
}

export interface PublicationBase {
  readonly byteCount: number;
  readonly contentDigest: string;
  readonly intentDigest: string;
  readonly logicalTargetDigest: string;
  readonly parentFingerprint: string;
  readonly parentIdentity: MaterializationFsIdentity;
  readonly preparedIdentity: MaterializationPreparedFsIdentity | null;
  readonly priorRevision: string;
  readonly proofDigest: string;
  readonly publicationId: string;
  readonly reservationDigest: string;
  readonly stateEventAnchor: MaterializationStateEventAnchor;
  readonly stateOperationId: string;
  readonly targetStateDigest: string;
  readonly tempLeafRef: string;
}

export type PublicationIntentFacts = Omit<PublicationBase, "intentDigest">;

export interface PublicationIntent extends PublicationBase {
  readonly preparedIdentity: null;
  readonly reservationDigest: "";
  readonly proofDigest: "";
}

export interface PublicationReservation extends PublicationBase {
  readonly preparedIdentity: MaterializationPreparedFsIdentity;
  readonly reservationDigest: string;
  readonly proofDigest: "";
}

export interface PublicationPrepared extends PublicationBase {
  readonly preparedIdentity: MaterializationPreparedFsIdentity;
  readonly reservationDigest: string;
  readonly proofDigest: string;
}

export type MaterializationPublication =
  | PublicationIntent
  | PublicationReservation
  | PublicationPrepared;

export interface MaterializationPublishedEffect {
  readonly byteCount: number;
  readonly checkpointRef: string;
  readonly contentDigest: string;
  readonly proofDigest: string;
  readonly publicationId: string;
  readonly publishedIdentity: MaterializationPreparedFsIdentity;
  readonly publishedRevision: string;
  readonly stateOperationId: string;
}

export interface MaterializationSettlementEvidence {
  readonly auditCreatedAt: string;
  readonly auditId: string;
  readonly auditRef: string;
  readonly proofOutcomeKey: string;
  readonly proofRef: string;
  readonly settlementDigest: string;
}

export interface MaterializationStoredError {
  readonly code: string;
}

export interface MaterializationCheckpointResult {
  readonly checkpointRef: string;
}

export interface MaterializationCompletedResult {
  readonly auditRef: string;
  readonly byteCount: number;
  readonly checkpointRef: string;
  readonly contentDigest: string;
  readonly proofRef: string;
  readonly replayed: false;
  readonly requestRef: string;
  readonly schemaVersion: string;
  readonly status: "completed";
  readonly workspaceRevision: string;
}

export interface MaterializationOperationResult {
  readonly schemaVersion: string;
  readonly status: "completed";
  readonly replayed: boolean;
  readonly requestRef: string;
  readonly contentDigest: string;
  readonly byteCount: number;
  readonly workspaceRevision: string;
  readonly checkpointRef: string;
  readonly auditRef: string;
  readonly proofRef: string;
}

export interface MaterializationResultFields {
  readonly requestRef: string;
  readonly contentDigest: string;
  readonly byteCount: number;
  readonly workspaceRevision: string;
  readonly checkpointRef: string;
  readonly auditRef?: string;
  readonly proofRef?: string;
}

export interface MaterializationDurableStateBase
  extends MaterializationRequestRecord {
  readonly status: MaterializationStatus;
  readonly stage: MaterializationStage;
  readonly ownerFence: string;
  readonly leaseUntil: number;
  readonly preimage: MaterializationPreimage | null;
  readonly targetStateDigest: string;
  readonly parentFingerprint: string;
  readonly parentIdentity: MaterializationFsIdentity | null;
  readonly publication: MaterializationPublication | null;
  readonly publishedIdentity: MaterializationPreparedFsIdentity | null;
  readonly priorRevision: string;
  readonly publishedRevision: string;
  readonly effect: MaterializationPublishedEffect | null;
  readonly evidence: MaterializationSettlementEvidence | null;
  readonly result:
    | MaterializationCheckpointResult
    | MaterializationCompletedResult
    | null;
  readonly error: MaterializationStoredError | null;
}

export interface MaterializationAdmittedState
  extends MaterializationDurableStateBase {
  readonly status: "queued" | "running" | "failed" | "cancelled";
  readonly stage: "admitted";
  readonly publication: null;
  readonly publishedIdentity: null;
  readonly effect: null;
  readonly evidence: null;
  readonly result: null;
}

interface MaterializationPublicationStateBase
  extends MaterializationDurableStateBase {
  readonly status: "running";
  readonly preimage: MaterializationPreimage;
  readonly parentIdentity: MaterializationFsIdentity;
}

export interface MaterializationPublicationIntentState
  extends MaterializationPublicationStateBase {
  readonly stage: "publication_intent";
  readonly publication: PublicationIntent;
  readonly publishedIdentity: null;
  readonly publishedRevision: "";
  readonly effect: null;
  readonly evidence: null;
  readonly result: null;
  readonly error: null;
}

export interface MaterializationTempReservedState
  extends MaterializationPublicationStateBase {
  readonly stage: "temp_reserved";
  readonly publication: PublicationReservation;
  readonly publishedIdentity: null;
  readonly publishedRevision: "";
  readonly effect: null;
  readonly evidence: null;
  readonly result: null;
  readonly error: null;
}

export interface MaterializationPublicationPreparedState
  extends MaterializationPublicationStateBase {
  readonly stage: "publication_prepared";
  readonly publication: PublicationPrepared;
  readonly publishedIdentity: null;
  readonly publishedRevision: "";
  readonly effect: null;
  readonly evidence: null;
  readonly result: null;
  readonly error: null;
}

export interface MaterializationPublishedState
  extends MaterializationPublicationStateBase {
  readonly stage: "published";
  readonly publication: PublicationPrepared;
  readonly publishedIdentity: MaterializationPreparedFsIdentity;
  readonly effect: MaterializationPublishedEffect;
  readonly evidence: null;
  readonly result: MaterializationCheckpointResult;
  readonly error: null;
}

export interface MaterializationEvidencePendingState
  extends MaterializationPublicationStateBase {
  readonly stage: "evidence_pending";
  readonly publication: PublicationPrepared;
  readonly publishedIdentity: MaterializationPreparedFsIdentity;
  readonly effect: MaterializationPublishedEffect;
  readonly evidence: MaterializationSettlementEvidence;
  readonly result: MaterializationCheckpointResult;
  readonly error: null;
}

export interface MaterializationAuditFinalizedState
  extends MaterializationPublicationStateBase {
  readonly stage: "audit_finalized";
  readonly publication: PublicationPrepared;
  readonly publishedIdentity: MaterializationPreparedFsIdentity;
  readonly effect: MaterializationPublishedEffect;
  readonly evidence: MaterializationSettlementEvidence;
  readonly result: MaterializationCheckpointResult;
  readonly error: null;
}

export interface MaterializationProofFinalizedState
  extends MaterializationPublicationStateBase {
  readonly stage: "proof_finalized";
  readonly publication: PublicationPrepared;
  readonly publishedIdentity: MaterializationPreparedFsIdentity;
  readonly effect: MaterializationPublishedEffect;
  readonly evidence: MaterializationSettlementEvidence;
  readonly result: MaterializationCheckpointResult;
  readonly error: null;
}

export interface MaterializationCompletedState
  extends MaterializationDurableStateBase {
  readonly status: "completed";
  readonly stage: "completed";
  readonly ownerFence: "";
  readonly leaseUntil: 0;
  readonly preimage: MaterializationPreimage;
  readonly parentIdentity: MaterializationFsIdentity;
  readonly publication: PublicationPrepared;
  readonly publishedIdentity: MaterializationPreparedFsIdentity;
  readonly effect: MaterializationPublishedEffect;
  readonly evidence: MaterializationSettlementEvidence;
  readonly result: MaterializationCompletedResult;
  readonly error: null;
}

export interface MaterializationRollbackIncompleteState
  extends MaterializationDurableStateBase {
  readonly status: "failed";
  readonly stage: "rollback_incomplete";
  readonly ownerFence: "";
  readonly leaseUntil: 0;
  readonly error: MaterializationStoredError;
}

export type MaterializationPublicationState =
  | MaterializationPublicationIntentState
  | MaterializationTempReservedState
  | MaterializationPublicationPreparedState;

export type MaterializationCommittedState =
  | MaterializationPublishedState
  | MaterializationEvidencePendingState
  | MaterializationAuditFinalizedState
  | MaterializationProofFinalizedState;

export type MaterializationRecoveryState =
  | MaterializationPublicationState
  | MaterializationCommittedState;

export type MaterializationRunningAdmittedState =
  MaterializationAdmittedState & { readonly status: "running" };

export type MaterializationRunningState =
  | MaterializationRunningAdmittedState
  | MaterializationRecoveryState;

export type MaterializationDurableState =
  | MaterializationAdmittedState
  | MaterializationRecoveryState
  | MaterializationCompletedState
  | MaterializationRollbackIncompleteState;

export type MaterializationExecutionResult =
  | MaterializationDurableState
  | MaterializationOperationResult;

export function isMaterializationRecoveryState(
  state: MaterializationDurableState
): state is MaterializationRecoveryState {
  return MATERIALIZATION_RECOVERY_STAGES.includes(state.stage);
}

export function isMaterializationPrecommitState(
  state: MaterializationDurableState
): state is MaterializationPublicationState {
  return MATERIALIZATION_PRECOMMIT_RECOVERY_STAGES.includes(state.stage);
}

export function isMaterializationCommittedState(
  state: MaterializationDurableState
): state is MaterializationCommittedState {
  return MATERIALIZATION_COMMITTED_STAGES.includes(state.stage);
}

export function isMaterializationCompletedState(
  state: MaterializationDurableState | null
): state is MaterializationCompletedState {
  return state !== null && state.stage === "completed";
}

export function isMaterializationRunningState(
  state: MaterializationDurableState
): state is MaterializationRunningState {
  return state.stage === "admitted"
    ? state.status === "running"
    : isMaterializationRecoveryState(state);
}

function isClosedRecord(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value as object).sort().join("\0") ===
      [...keys].sort().join("\0")
  );
}

export function exactKeys(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  return isClosedRecord(value, keys);
}

function isStoredRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isMaterializationStatus(
  value: unknown
): value is MaterializationStatus {
  return typeof value === "string" &&
    (REQUEST_STATUSES as readonly string[]).includes(value);
}

function isMaterializationStage(
  value: unknown
): value is MaterializationStage {
  return typeof value === "string" &&
    (REQUEST_STAGES as readonly string[]).includes(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function storedText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizedOwner(value: unknown = {}): MaterializationOwner {
  const record = isStoredRecord(value) ? value : {};
  const user = record.user || record;
  const userRecord = isStoredRecord(user) ? user : {};
  const subjectCandidate: unknown =
    userRecord.subjectId ?? userRecord.userId ?? userRecord.id;
  const tenantCandidate: unknown =
    userRecord.tenantId ?? userRecord.tenant ?? "default";
  const validIdentity = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate === candidate.trim() &&
    candidate.length <= 768 &&
    !/[\u0000-\u001f\u007f]/u.test(candidate);
  if (
    !validIdentity(subjectCandidate) ||
    !validIdentity(tenantCandidate)
  ) {
    throw failure(
      "materialization_subject_required",
      401,
      "Authenticated materialization subject is required."
    );
  }
  return Object.freeze({
    subjectId: subjectCandidate,
    tenantId: tenantCandidate,
    userId: subjectCandidate
  });
}

export function normalizeLogicalTarget(value: unknown): string {
  const logicalTarget =
    typeof value === "string" ? value : "";
  const segments = logicalTarget.split("/");
  if (
    !logicalTarget ||
    logicalTarget !== logicalTarget.trim() ||
    logicalTarget.length > 768 ||
    logicalTarget.startsWith("/") ||
    logicalTarget.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(logicalTarget) ||
    segments.some(
      (segment: string): boolean =>
        !segment ||
        segment.startsWith(".")
    )
  ) {
    throw failure(
      "materialization_path_invalid",
      400,
      "Workspace materialization target is invalid."
    );
  }
  return logicalTarget;
}

export function closedAdmissionId(
  value: unknown,
  label: string
): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > 768 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw failure(
      "materialization_input_invalid",
      400,
      `${label} is invalid.`
    );
  }
  return value;
}

export function closedAdmissionInput(
  value: unknown = {}
): MaterializationClosedAdmissionInput {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw failure(
      "materialization_input_invalid",
      400,
      "Materialization input is invalid."
    );
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set<string>([
    "expectedWorkspaceRevision",
    "logicalTarget",
    "safetyConfirm",
    "uploadSessionId",
    "workspaceId"
  ]);
  if (Object.keys(candidate).some((key: string): boolean => !allowed.has(key))) {
    throw failure(
      "materialization_input_invalid",
      400,
      "Materialization input contains unsupported fields."
    );
  }
  if (
    !Object.hasOwn(candidate, "safetyConfirm") ||
    typeof candidate.safetyConfirm !== "boolean"
  ) {
    throw failure(
      "materialization_input_invalid",
      400,
      "Materialization safety confirmation is invalid."
    );
  }
  const input = Object.freeze({
    expectedWorkspaceRevision:
      closedAdmissionId(
        candidate.expectedWorkspaceRevision,
        "Expected workspace revision"
      ),
    logicalTarget: normalizeLogicalTarget(candidate.logicalTarget),
    safetyConfirm: candidate.safetyConfirm === true,
    uploadSessionId: closedAdmissionId(
      candidate.uploadSessionId,
      "Upload session"
    ),
    workspaceId: closedAdmissionId(
      candidate.workspaceId,
      "Workspace identity"
    )
  });
  if (
    input.safetyConfirm !== true
  ) {
    throw failure(
      "materialization_input_invalid",
      400,
      "Materialization input is incomplete."
    );
  }
  return Object.freeze({
    ...input,
    safetyConfirm: true
  });
}

export function requestReference(
  input: MaterializationRequestReferenceFacts,
  owner: unknown
): string {
  return `materialization:${digest({
    operationId: UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID,
    ownerBinding: digest(owner),
    uploadSessionId: input.uploadSessionId,
    workspaceId: input.workspaceId,
    expectedWorkspaceRevision: input.expectedWorkspaceRevision,
    logicalTarget: input.logicalTarget
  })}`;
}

export function exactDescriptor(
  files: unknown,
  uploadSessionId: unknown
): MaterializationDescriptor {
  if (!Array.isArray(files) || files.length !== 1) {
    throw failure(
      "materialization_descriptor_invalid",
      409,
      "Completed upload must contain exactly one sealed object."
    );
  }
  const file = isStoredRecord(files[0]) ? files[0] : {};
  const byteCount: unknown = file.byteSize;
  const descriptorText = (value: unknown): string =>
    typeof value === "string" &&
    value &&
    value === value.trim() &&
    value.length <= 768 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
      ? value
      : "";
  const descriptor = Object.freeze({
    byteCount,
    contentDigest: descriptorText(file.contentDigest),
    custodyRef: descriptorText(file.custodyRef),
    envelopeDigest: descriptorText(file.envelopeDigest),
    resourceRef: `upload-resource:${uploadSessionId}:0`,
    state: descriptorText(file.custodyState)
  });
  if (
    descriptor.state !== "sealed_no_run" ||
    !descriptor.custodyRef ||
    !/^[a-f0-9]{64}$/u.test(descriptor.contentDigest) ||
    !/^[a-f0-9]{64}$/u.test(descriptor.envelopeDigest) ||
    !isSafeCount(byteCount) ||
    byteCount > MAX_DESCRIPTOR_BYTES
  ) {
    throw failure(
      "materialization_descriptor_invalid",
      409,
      "Completed upload custody descriptor is invalid."
    );
  }
  return Object.freeze({
    byteCount,
    contentDigest: descriptor.contentDigest,
    custodyRef: descriptor.custodyRef,
    envelopeDigest: descriptor.envelopeDigest,
    resourceRef: descriptor.resourceRef,
    state: descriptor.state
  });
}

export function sameDescriptor(
  left: unknown,
  right: unknown
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function normalizeRequestRecord(
  value: unknown
): MaterializationRequestRecord {
  if (!exactKeys(value, REQUEST_RECORD_KEYS)) {
    throw failure(
      "materialization_request_record_invalid",
      409,
      "Materialization request record is not a closed binding."
    );
  }
  const descriptorValue = isStoredRecord(value.descriptor)
    ? value.descriptor
    : null;
  const descriptor = exactDescriptor(
    [{
      byteSize: descriptorValue?.byteCount,
      contentDigest: descriptorValue?.contentDigest,
      custodyRef: descriptorValue?.custodyRef,
      envelopeDigest: descriptorValue?.envelopeDigest,
      custodyState: descriptorValue?.state
    }],
    value.uploadSessionId
  );
  if (
    descriptor.resourceRef !== text(descriptorValue?.resourceRef) ||
    !sameDescriptor(descriptor, value.descriptor)
  ) {
    throw failure(
      "materialization_request_record_invalid",
      409,
      "Materialization descriptor binding is invalid."
    );
  }
  const normalized: MaterializationRequestRecord = Object.freeze({
    approvalIntentDigest: sha256Digest(
      value.approvalIntentDigest,
      "Approval-intent digest"
    ),
    authorityBindingDigest: sha256Digest(
      value.authorityBindingDigest,
      "Authority-binding digest"
    ),
    authorityRef: boundedId(
      value.authorityRef,
      "Authority reference"
    ),
    bindingDigest: sha256Digest(
      value.bindingDigest,
      "Materialization binding digest"
    ),
    descriptor,
    expectedWorkspaceRevision: boundedId(
      value.expectedWorkspaceRevision,
      "Expected workspace revision"
    ),
    logicalTarget: normalizeLogicalTarget(value.logicalTarget),
    operationId: UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID,
    requestDigest: sha256Digest(
      value.requestDigest,
      "Materialization request digest"
    ),
    requestRef: boundedId(
      value.requestRef,
      "Materialization request reference"
    ),
    resourceRevision: sha256Digest(
      value.resourceRevision,
      "Materialization resource revision"
    ),
    uploadSessionId: boundedId(
      value.uploadSessionId,
      "Upload session"
    ),
    workspaceId: boundedId(
      value.workspaceId,
      "Workspace identity"
    )
  });
  const expectedResourceRevision = digest(normalized.descriptor);
  const expectedBindingDigest = digest({
    authorityBindingDigest: normalized.authorityBindingDigest,
    descriptor: normalized.descriptor,
    expectedWorkspaceRevision:
      normalized.expectedWorkspaceRevision,
    logicalTarget: normalized.logicalTarget,
    operationId: normalized.operationId,
    requestDigest: normalized.requestDigest,
    requestRef: normalized.requestRef,
    uploadSessionId: normalized.uploadSessionId,
    workspaceId: normalized.workspaceId
  });
  if (
    normalized.operationId !==
      UPLOAD_WORKSPACE_MATERIALIZATION_OPERATION_ID ||
    !/^materialization:[a-f0-9]{64}$/u.test(
      normalized.requestRef
    ) ||
    normalized.resourceRevision !== expectedResourceRevision ||
    normalized.bindingDigest !== expectedBindingDigest
  ) {
    throw failure(
      "materialization_request_record_invalid",
      409,
      "Materialization request binding is not canonical."
    );
  }
  return normalized;
}

export function boundedId(
  value: unknown,
  label: string
): string {
  const normalized =
    typeof value === "string" ? value : "";
  if (
    !normalized ||
    normalized !== normalized.trim() ||
    normalized.length > 768 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      `${label} is invalid.`
    );
  }
  return normalized;
}

export function sha256Digest(
  value: unknown,
  label: string
): string {
  const normalized =
    typeof value === "string" ? value : "";
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      `${label} is invalid.`
    );
  }
  return normalized;
}

export function safeCount(
  value: unknown,
  label: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      `${label} is invalid.`
    );
  }
  return value;
}

export function normalizeStateEventAnchor(
  value: unknown
): MaterializationStateEventAnchor {
  if (!exactKeys(value, ["eventHash", "offset"])) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      "Publication state-event anchor is invalid."
    );
  }
  return Object.freeze({
    eventHash: sha256Digest(
      text(value.eventHash).replace(/^sha256:/u, ""),
      "Publication state-event hash"
    ),
    offset: safeCount(
      value.offset,
      "Publication state-event offset"
    )
  });
}

export function normalizeFsIdentity(
  value: unknown,
  label: string
): MaterializationFsIdentity;
export function normalizeFsIdentity(
  value: unknown,
  label: string,
  options: {
    prepared: true;
    byteCount: number;
    contentDigest: string;
  }
): MaterializationPreparedFsIdentity;
export function normalizeFsIdentity(
  value: unknown,
  label: string,
  options: {
    prepared?: boolean;
    byteCount?: number | null;
    contentDigest?: string;
  } = {}
): MaterializationFsIdentity | MaterializationPreparedFsIdentity {
  const prepared = options.prepared === true;
  const byteCount = options.byteCount ?? null;
  const contentDigest = options.contentDigest ?? "";
  const keys = prepared
    ? [
        "birthtimeNs",
        "byteCount",
        "contentDigest",
        "dev",
        "ino",
        "mode"
      ]
    : ["birthtimeNs", "dev", "ino", "mode"];
  if (!exactKeys(value, keys)) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      `${label} is invalid.`
    );
  }
  const birthtimeNs = boundedId(
    value.birthtimeNs,
    `${label} birth time`
  );
  const dev = boundedId(value.dev, "Prepared publication device");
  const ino = boundedId(value.ino, "Prepared publication inode");
  const mode = safeCount(value.mode, `${label} mode`);
  if (
    !/^\d+$/u.test(birthtimeNs) ||
    !/^\d+$/u.test(dev) ||
    !/^\d+$/u.test(ino)
  ) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      `${label} is invalid.`
    );
  }
  if (prepared) {
    const preparedByteCount = safeCount(
      value.byteCount,
      `${label} byte count`
    );
    const preparedContentDigest = sha256Digest(
      value.contentDigest,
      `${label} content digest`
    );
    if (
      preparedByteCount !== byteCount ||
      preparedContentDigest !== contentDigest ||
      mode !== 0o600
    ) {
      throw failure(
        "materialization_publication_wal_invalid",
        409,
        `${label} does not match its publication binding.`
      );
    }
    return Object.freeze({
      birthtimeNs,
      byteCount: preparedByteCount,
      contentDigest: preparedContentDigest,
      dev,
      ino,
      mode
    });
  }
  return Object.freeze({
    birthtimeNs,
    dev,
    ino,
    mode
  });
}

export function normalizeTempLeaf(value: unknown): string {
  const normalized = boundedId(
    value,
    "Publication temporary leaf"
  );
  if (
    !/^\.meshrix-materialization-[A-Za-z0-9_-]{16,128}(?:\.tmp)?$/u
      .test(normalized) ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("..")
  ) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      "Publication temporary leaf is invalid."
    );
  }
  return normalized;
}

export function publicationIntentDigest(
  publication: PublicationIntentFacts
): string {
  return digest({
    version: PUBLICATION_INTENT_VERSION,
    publicationId: publication.publicationId,
    tempLeafRef: publication.tempLeafRef,
    stateOperationId: publication.stateOperationId,
    priorRevision: publication.priorRevision,
    stateEventAnchor: publication.stateEventAnchor,
    logicalTargetDigest: publication.logicalTargetDigest,
    parentFingerprint: publication.parentFingerprint,
    parentIdentity: publication.parentIdentity,
    targetStateDigest: publication.targetStateDigest,
    contentDigest: publication.contentDigest,
    byteCount: publication.byteCount
  });
}

export function publicationReservationDigest(
  publication: Pick<PublicationBase, "intentDigest">,
  preparedIdentity: unknown
): string {
  return digest({
    version: PUBLICATION_RESERVATION_VERSION,
    intentDigest: publication.intentDigest,
    preparedIdentity
  });
}

export function publicationProofDigest(
  publication: Pick<
    PublicationBase,
    "intentDigest" | "reservationDigest" | "preparedIdentity"
  >
): string {
  return digest({
    version: PUBLICATION_PROOF_VERSION,
    intentDigest: publication.intentDigest,
    reservationDigest: publication.reservationDigest,
    preparedIdentity: publication.preparedIdentity
  });
}

export function normalizePublicationBase(
  value: unknown,
  facts: MaterializationPublicationFacts
): PublicationBase {
  if (!exactKeys(value, PUBLICATION_KEYS)) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      "Publication descriptor is not an exact closed binding."
    );
  }
  const publication: PublicationIntentFacts = {
    byteCount: safeCount(value.byteCount, "Publication byte count"),
    contentDigest: sha256Digest(
      value.contentDigest,
      "Publication content digest"
    ),
    logicalTargetDigest: sha256Digest(
      value.logicalTargetDigest,
      "Publication logical-target digest"
    ),
    parentFingerprint: sha256Digest(
      value.parentFingerprint,
      "Publication parent fingerprint"
    ),
    parentIdentity: normalizeFsIdentity(
      value.parentIdentity,
      "Publication parent identity"
    ),
    priorRevision: boundedId(
      value.priorRevision,
      "Publication prior revision"
    ),
    preparedIdentity: null,
    proofDigest: "",
    publicationId: boundedId(
      value.publicationId,
      "Publication identity"
    ),
    reservationDigest: "",
    stateEventAnchor: normalizeStateEventAnchor(
      value.stateEventAnchor
    ),
    stateOperationId: boundedId(
      value.stateOperationId,
      "Publication state operation"
    ),
    targetStateDigest: sha256Digest(
      value.targetStateDigest,
      "Publication target-state digest"
    ),
    tempLeafRef: normalizeTempLeaf(value.tempLeafRef)
  };
  const intentDigest = publicationIntentDigest(publication);
  if (
    publication.byteCount !== facts.request.descriptor.byteCount ||
    publication.contentDigest !==
      facts.request.descriptor.contentDigest ||
    publication.logicalTargetDigest !==
      digest(facts.request.logicalTarget) ||
    publication.parentFingerprint !== facts.parentFingerprint ||
    !sameCanonical(
      publication.parentIdentity,
      facts.parentIdentity
    ) ||
    publication.priorRevision !==
      facts.request.expectedWorkspaceRevision ||
    publication.targetStateDigest !== facts.targetStateDigest ||
    !sameCanonical(
      publication.stateEventAnchor,
      facts.stateEventAnchor
    ) ||
    intentDigest !==
      sha256Digest(value.intentDigest, "Publication intent digest")
  ) {
    throw failure(
      "materialization_publication_wal_mismatch",
      409,
      "Publication intent does not match its persisted request facts."
    );
  }
  return Object.freeze({ ...publication, intentDigest });
}

export function normalizePublicationIntent(
  value: unknown,
  facts: MaterializationPublicationFacts
): PublicationIntent {
  const publication = normalizePublicationBase(value, facts);
  if (!exactKeys(value, PUBLICATION_KEYS)) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      "Publication descriptor is not an exact closed binding."
    );
  }
  if (
    value.preparedIdentity !== null ||
    text(value.reservationDigest) ||
    text(value.proofDigest)
  ) {
    throw failure(
      "materialization_publication_wal_mismatch",
      409,
      "Publication intent unexpectedly contains reservation evidence."
    );
  }
  return Object.freeze({
    ...publication,
    preparedIdentity: null,
    reservationDigest: "",
    proofDigest: ""
  });
}

export function normalizePublicationReserved(
  value: unknown,
  facts: MaterializationPublicationFacts
): PublicationReservation {
  const publication = normalizePublicationBase(value, facts);
  if (!exactKeys(value, PUBLICATION_KEYS)) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      "Publication descriptor is not an exact closed binding."
    );
  }
  const preparedIdentity = normalizeFsIdentity(
    value.preparedIdentity,
    "Prepared publication identity",
    {
      prepared: true,
      byteCount: publication.byteCount,
      contentDigest: publication.contentDigest
    }
  );
  const reservationDigest = publicationReservationDigest(
    publication,
    preparedIdentity
  );
  if (
    reservationDigest !== sha256Digest(
      value.reservationDigest,
      "Publication reservation digest"
    ) ||
    text(value.proofDigest)
  ) {
    throw failure(
      "materialization_publication_wal_mismatch",
      409,
      "Publication reservation is not canonical."
    );
  }
  return Object.freeze({
    ...publication,
    preparedIdentity,
    reservationDigest,
    proofDigest: ""
  });
}

export function normalizePublicationPrepared(
  value: unknown,
  facts: MaterializationPublicationFacts
): PublicationPrepared {
  if (!exactKeys(value, PUBLICATION_KEYS)) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      "Publication descriptor is not an exact closed binding."
    );
  }
  const reserved = normalizePublicationReserved(
    {
      ...value,
      proofDigest: ""
    },
    facts
  );
  const proofDigest = publicationProofDigest(reserved);
  if (
    proofDigest !== sha256Digest(
      value.proofDigest,
      "Publication proof digest"
    )
  ) {
    throw failure(
      "materialization_publication_wal_mismatch",
      409,
      "Publication proof is not canonical."
    );
  }
  return Object.freeze({
    ...reserved,
    proofDigest
  });
}

export function sameCanonical(
  left: unknown,
  right: unknown
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function canonicalClone(value: unknown): unknown {
  return JSON.parse(canonicalJson(value));
}

export function normalizePreimage(
  value: unknown,
  request: MaterializationRequestRecord
): MaterializationPreimage {
  if (!isStoredRecord(value)) {
    throw failure(
      "materialization_preimage_incomplete",
      409,
      "Materialization preimage does not match its request."
    );
  }
  const candidate = value;
  if (
    candidate.workspaceId !== request.workspaceId ||
    candidate.stateRoot !== request.expectedWorkspaceRevision
  ) {
    throw failure(
      "materialization_preimage_incomplete",
      409,
      "Materialization preimage does not match its request."
    );
  }
  const files = Array.isArray(candidate.files) ? candidate.files : [];
  const entry = isStoredRecord(files[0]) ? files[0] : {};
  const entryPath =
    typeof entry.relativePath === "string"
      ? entry.relativePath
      : typeof entry.path === "string"
        ? entry.path
        : "";
  if (
    files.length !== 1 ||
    entryPath !== request.logicalTarget ||
    entry.exists !== false
  ) {
    throw failure(
      "materialization_preimage_incomplete",
      409,
      "Materialization preimage does not prove a missing target."
    );
  }
  normalizeStateEventAnchor(candidate.stateEventAnchor);
  return Object.freeze(canonicalClone(candidate)) as MaterializationPreimage;
}

export function factsFromRow(
  row: Record<string, unknown>,
  request: MaterializationRequestRecord
): MaterializationPublicationFacts {
  if (
    !row.preimage_json ||
    !row.parent_identity_json ||
    !row.parent_fingerprint ||
    !row.target_state_digest
  ) {
    throw failure(
      "materialization_publication_wal_mismatch",
      409,
      "Materialization publication facts are incomplete."
    );
  }
  const preimage = normalizePreimage(
    parseStoredJson(
      row.preimage_json,
      "Materialization preimage"
    ),
    request
  );
  return Object.freeze({
    request,
    parentFingerprint: sha256Digest(
      row.parent_fingerprint,
      "Materialization parent fingerprint"
    ),
    parentIdentity: normalizeFsIdentity(
      parseStoredJson(
        row.parent_identity_json,
        "Materialization parent identity"
      ),
      "Materialization parent identity"
    ),
    stateEventAnchor: normalizeStateEventAnchor(
      preimage.stateEventAnchor
    ),
    targetStateDigest: sha256Digest(
      row.target_state_digest,
      "Materialization target-state digest"
    )
  });
}

export function normalizePublishedEffect(
  value: unknown,
  request: MaterializationRequestRecord,
  publication: PublicationPrepared
): MaterializationPublishedEffect {
  if (!exactKeys(value, EFFECT_KEYS)) {
    throw failure(
      "materialization_publication_wal_invalid",
      409,
      "Published materialization receipt is not closed."
    );
  }
  const effect: MaterializationPublishedEffect = Object.freeze({
    byteCount: safeCount(
      value.byteCount,
      "Published byte count"
    ),
    checkpointRef: boundedId(
      value.checkpointRef,
      "Published checkpoint"
    ),
    contentDigest: sha256Digest(
      value.contentDigest,
      "Published content digest"
    ),
    proofDigest: sha256Digest(
      value.proofDigest,
      "Published proof digest"
    ),
    publicationId: boundedId(
      value.publicationId,
      "Published publication identity"
    ),
    publishedIdentity: normalizeFsIdentity(
      value.publishedIdentity,
      "Published file identity",
      {
        prepared: true,
        byteCount: publication.byteCount,
        contentDigest: publication.contentDigest
      }
    ),
    publishedRevision: boundedId(
      value.publishedRevision,
      "Published workspace revision"
    ),
    stateOperationId: boundedId(
      value.stateOperationId,
      "Published state operation"
    )
  });
  if (
    effect.byteCount !== request.descriptor.byteCount ||
    effect.contentDigest !== request.descriptor.contentDigest ||
    effect.proofDigest !== publication.proofDigest ||
    effect.publicationId !== publication.publicationId ||
    effect.stateOperationId !== publication.stateOperationId ||
    effect.publishedRevision ===
      request.expectedWorkspaceRevision ||
    !sameCanonical(
      effect.publishedIdentity,
      publication.preparedIdentity
    )
  ) {
    throw failure(
      "materialization_publication_wal_mismatch",
      409,
      "Published materialization receipt does not match its WAL."
    );
  }
  return effect;
}

export function settlementEvidence({
  request,
  publication,
  effect,
  auditCreatedAt,
  auditRef = "",
  proofRef = ""
}: {
  request: MaterializationRequestRecord;
  publication: PublicationPrepared;
  effect: MaterializationPublishedEffect;
  auditCreatedAt: string;
  auditRef?: string;
  proofRef?: string;
}): MaterializationSettlementEvidence {
  const settlementDigest = digest({
    version: SETTLEMENT_VERSION,
    bindingDigest: request.bindingDigest,
    publicationProofDigest: publication.proofDigest,
    publishedRevision: effect.publishedRevision,
    checkpointRef: effect.checkpointRef,
    status: "succeeded"
  });
  const auditId =
    `materialization_audit_${digest({
      version: SETTLEMENT_VERSION,
      kind: "audit",
      settlementDigest
    })}`;
  return Object.freeze({
    auditCreatedAt,
    auditId,
    auditRef,
    proofOutcomeKey:
      `${request.bindingDigest}:succeeded:${settlementDigest}`,
    proofRef,
    settlementDigest
  });
}

export function normalizeEvidence(
  value: unknown,
  {
    request,
    publication,
    effect,
    stage
  }: {
    request: MaterializationRequestRecord;
    publication: PublicationPrepared;
    effect: MaterializationPublishedEffect;
    stage: MaterializationStage;
  }
): MaterializationSettlementEvidence {
  if (!exactKeys(value, EVIDENCE_KEYS)) {
    throw failure(
      "materialization_evidence_wal_incomplete",
      409,
      "Materialization evidence descriptor is not closed."
    );
  }
  const auditCreatedAt = text(value.auditCreatedAt);
  if (
    !auditCreatedAt ||
    !Number.isFinite(Date.parse(auditCreatedAt)) ||
    new Date(auditCreatedAt).toISOString() !== auditCreatedAt
  ) {
    throw failure(
      "materialization_evidence_wal_incomplete",
      409,
      "Materialization audit timestamp is invalid."
    );
  }
  const expected = settlementEvidence({
    request,
    publication,
    effect,
    auditCreatedAt,
    auditRef: value.auditRef
      ? boundedId(
          value.auditRef,
          "Materialization audit reference"
        )
      : "",
    proofRef: value.proofRef
      ? boundedId(
          value.proofRef,
          "Materialization proof reference"
        )
      : ""
  });
  if (
    expected.auditId !== value.auditId ||
    expected.proofOutcomeKey !== value.proofOutcomeKey ||
    expected.settlementDigest !== value.settlementDigest ||
    (
      expected.auditRef &&
      expected.auditRef !== `audit:${expected.auditId}`
    ) ||
    (
      expected.proofRef &&
      (
        !expected.proofRef.startsWith("proof:") ||
        expected.proofRef.length <= "proof:".length
      )
    )
  ) {
    throw failure(
      "materialization_evidence_wal_mismatch",
      409,
      "Materialization evidence binding is not canonical."
    );
  }
  if (
    (stage === "evidence_pending" &&
      (expected.auditRef || expected.proofRef)) ||
    (stage === "audit_finalized" &&
      (!expected.auditRef || expected.proofRef)) ||
    (["proof_finalized", "completed"].includes(stage) &&
      (!expected.auditRef || !expected.proofRef))
  ) {
    throw failure(
      "materialization_evidence_wal_mismatch",
      409,
      "Materialization evidence references do not match their stage."
    );
  }
  if (expected.proofRef && !expected.auditRef) {
    throw failure(
      "materialization_evidence_wal_mismatch",
      409,
      "Materialization proof evidence requires finalized audit evidence."
    );
  }
  return expected;
}

export function normalizeStoredError(
  value: unknown
): MaterializationStoredError {
  if (!exactKeys(value, ["code"])) {
    throw storedDataFailure(
      "Materialization error state is not closed."
    );
  }
  return Object.freeze({
    code: boundedId(value.code, "Materialization error code")
  });
}

export function canonicalErrorJson(
  value: unknown,
  fallbackCode: string
): string {
  const record = isStoredRecord(value) ? value : null;
  const candidate =
    typeof record?.code === "string"
      ? record.code
      : fallbackCode;
  return canonicalJson(
    normalizeStoredError({ code: candidate })
  );
}

export function normalizeCheckpointResult(
  value: unknown,
  effect: MaterializationPublishedEffect
): MaterializationCheckpointResult {
  if (
    !exactKeys(value, ["checkpointRef"]) ||
    boundedId(
      value.checkpointRef,
      "Materialization result checkpoint"
    ) !== effect.checkpointRef
  ) {
    throw storedDataFailure(
      "Materialization checkpoint result is inconsistent."
    );
  }
  return Object.freeze({
    checkpointRef: effect.checkpointRef
  });
}

export function normalizeCompletedResult(
  value: unknown,
  {
    request,
    effect,
    evidence
  }: {
    request: MaterializationRequestRecord;
    effect: MaterializationPublishedEffect;
    evidence: MaterializationSettlementEvidence;
  }
): MaterializationCompletedResult {
  if (
    !exactKeys(value, [
      "auditRef",
      "byteCount",
      "checkpointRef",
      "contentDigest",
      "proofRef",
      "replayed",
      "requestRef",
      "schemaVersion",
      "status",
      "workspaceRevision"
    ])
  ) {
    throw storedDataFailure(
      "Completed materialization result is not closed."
    );
  }
  if (value.replayed !== false) {
    throw storedDataFailure(
      "Completed materialization result is inconsistent."
    );
  }
  const normalized: MaterializationCompletedResult = Object.freeze({
    auditRef: boundedId(
      value.auditRef,
      "Materialization result audit reference"
    ),
    byteCount: safeCount(
      value.byteCount,
      "Materialization result byte count"
    ),
    checkpointRef: boundedId(
      value.checkpointRef,
      "Materialization result checkpoint"
    ),
    contentDigest: sha256Digest(
      value.contentDigest,
      "Materialization result content digest"
    ),
    proofRef: boundedId(
      value.proofRef,
      "Materialization result proof reference"
    ),
    replayed: value.replayed,
    requestRef: boundedId(
      value.requestRef,
      "Materialization result request"
    ),
    schemaVersion: boundedId(
      value.schemaVersion,
      "Materialization result schema"
    ),
    status: "completed",
    workspaceRevision: boundedId(
      value.workspaceRevision,
      "Materialization result workspace revision"
    )
  });
  if (
    normalized.schemaVersion !==
      UPLOAD_WORKSPACE_MATERIALIZATION_SCHEMA_VERSION ||
    normalized.status !== "completed" ||
    normalized.replayed !== false ||
    normalized.requestRef !== request.requestRef ||
    normalized.contentDigest !==
      request.descriptor.contentDigest ||
    normalized.byteCount !== request.descriptor.byteCount ||
    normalized.workspaceRevision !== effect.publishedRevision ||
    normalized.checkpointRef !== effect.checkpointRef ||
    normalized.auditRef !== evidence.auditRef ||
    normalized.proofRef !== evidence.proofRef
  ) {
    throw storedDataFailure(
      "Completed materialization result is inconsistent."
    );
  }
  return normalized;
}

function isPublicationIntent(
  value: MaterializationPublication | null
): value is PublicationIntent {
  return value !== null && value.preparedIdentity === null;
}

function isPublicationReservation(
  value: MaterializationPublication | null
): value is PublicationReservation {
  return value !== null &&
    value.preparedIdentity !== null &&
    value.proofDigest === "";
}

function isPublicationPrepared(
  value: MaterializationPublication | null
): value is PublicationPrepared {
  return value !== null && value.proofDigest !== "";
}

function isCompletedResult(
  value:
    | MaterializationCheckpointResult
    | MaterializationCompletedResult
): value is MaterializationCompletedResult {
  return "schemaVersion" in value;
}

export function parseStoredJson(
  value: unknown,
  label: string
): unknown {
  try {
    return JSON.parse(String(value));
  } catch {
    throw schemaFailure(
      "materialization_schema_data_invalid",
      `${label} is not valid JSON.`
    );
  }
}

export function hydrateStoredRequestRow(
  input: unknown
): MaterializationDurableState {
  if (!isStoredRecord(input)) {
    throw storedDataFailure(
      "Persisted materialization row shape is invalid."
    );
  }
  const row = input;
  if (
    !sameColumnSet(Object.keys(row), REQUEST_COLUMNS) ||
    !isMaterializationStatus(row.status) ||
    !isMaterializationStage(row.stage)
  ) {
    throw storedDataFailure(
      "Persisted materialization row shape is invalid."
    );
  }
  const status = row.status;
  const stage = row.stage;
  const leaseUntil = row.lease_until;
  const ownerFence = row.owner_fence;
  const running = status === "running";
  const timestampValue = row.updated_at;
  if (
    typeof leaseUntil !== "number" ||
    !Number.isSafeInteger(leaseUntil) ||
    leaseUntil < 0 ||
    typeof ownerFence !== "string" ||
    (ownerFence &&
      boundedId(
        ownerFence,
        "Materialization owner fence"
      ) !== ownerFence) ||
    typeof timestampValue !== "string" ||
    !Number.isFinite(Date.parse(timestampValue)) ||
    new Date(timestampValue).toISOString() !== timestampValue ||
    (running && (!ownerFence || leaseUntil <= 0)) ||
    (!running && (ownerFence || leaseUntil !== 0)) ||
    (status === "queued" && stage !== "admitted") ||
    (status === "completed" && stage !== "completed") ||
    (status === "cancelled" && stage !== "admitted") ||
    (status === "failed" &&
      !["admitted", "rollback_incomplete"].includes(stage)) ||
    (running &&
      ["completed", "rollback_incomplete"].includes(stage))
  ) {
    throw storedDataFailure(
      "Persisted materialization lifecycle state is invalid."
    );
  }

  const request = normalizeRequestRecord(
    parseStoredJson(
      row.request_json,
      "Materialization request record"
    )
  );
  if (
    request.requestRef !== row.request_ref ||
    row.request_json !== canonicalJson(request) ||
    digest(request) !==
      sha256Digest(
        row.request_digest,
        "Materialization request-record digest"
      )
  ) {
    throw storedDataFailure(
      "Persisted materialization request binding is invalid."
    );
  }

  const factPresence: boolean[] = [
    row.preimage_json !== null,
    Boolean(row.target_state_digest),
    Boolean(row.parent_fingerprint),
    row.parent_identity_json !== null,
    Boolean(row.prior_revision)
  ];
  const hasFacts = factPresence.every(Boolean);
  if (
    factPresence.some(Boolean) !== hasFacts ||
    (
      !hasFacts &&
      (
        row.preimage_json !== null ||
        row.target_state_digest !== "" ||
        row.parent_fingerprint !== "" ||
        row.parent_identity_json !== null ||
        row.prior_revision !== ""
      )
    ) ||
    (["failed", "cancelled"].includes(status) &&
      stage === "admitted" &&
      hasFacts)
  ) {
    throw storedDataFailure(
      "Persisted materialization preimage facts are incomplete."
    );
  }
  const preimage = hasFacts
    ? normalizePreimage(
        parseStoredJson(
          row.preimage_json,
          "Materialization preimage"
        ),
        request
      )
    : null;
  const parentIdentity = hasFacts
    ? normalizeFsIdentity(
        parseStoredJson(
          row.parent_identity_json,
          "Materialization parent identity"
        ),
        "Materialization parent identity"
      )
    : null;
  if (
    hasFacts &&
    (
      row.preimage_json !== canonicalJson(preimage) ||
      row.parent_identity_json !== canonicalJson(parentIdentity) ||
      sha256Digest(
        row.target_state_digest,
        "Materialization target-state digest"
      ) !== row.target_state_digest ||
      sha256Digest(
        row.parent_fingerprint,
        "Materialization parent fingerprint"
      ) !== row.parent_fingerprint ||
      row.prior_revision !== request.expectedWorkspaceRevision
    )
  ) {
    throw storedDataFailure(
      "Persisted materialization preimage facts are inconsistent."
    );
  }

  const publicationRequired: boolean = [
    "publication_intent",
    "temp_reserved",
    "publication_prepared",
    "published",
    "evidence_pending",
    "audit_finalized",
    "proof_finalized",
    "completed"
  ].includes(stage);
  const hasPublication = row.publication_json !== null;
  if (
    (publicationRequired && !hasPublication) ||
    (hasPublication && !hasFacts) ||
    (!publicationRequired &&
      stage !== "rollback_incomplete" &&
      hasPublication)
  ) {
    throw storedDataFailure(
      "Persisted materialization publication state is incomplete."
    );
  }
  let facts: MaterializationPublicationFacts | null = null;
  if (hasPublication) {
    if (!preimage || !parentIdentity) {
      throw storedDataFailure(
        "Persisted materialization publication facts are incomplete."
      );
    }
    facts = Object.freeze({
      request,
      parentFingerprint: storedText(row.parent_fingerprint),
      parentIdentity,
      stateEventAnchor: normalizeStateEventAnchor(
        preimage.stateEventAnchor
      ),
      targetStateDigest: storedText(row.target_state_digest)
    });
  }
  let publication: MaterializationPublication | null = null;
  if (hasPublication && facts) {
    const candidate = parseStoredJson(
      row.publication_json,
      "Materialization publication"
    );
    if (stage === "publication_intent") {
      publication = normalizePublicationIntent(candidate, facts);
    } else if (stage === "temp_reserved") {
      publication = normalizePublicationReserved(candidate, facts);
    } else if (
      [
        "publication_prepared",
        "published",
        "evidence_pending",
        "audit_finalized",
        "proof_finalized",
        "completed"
      ].includes(stage)
    ) {
      publication = normalizePublicationPrepared(candidate, facts);
    } else if (stage === "rollback_incomplete") {
      const stored = isStoredRecord(candidate) ? candidate : {};
      publication = stored.proofDigest
        ? normalizePublicationPrepared(candidate, facts)
        : stored.reservationDigest
          ? normalizePublicationReserved(candidate, facts)
          : normalizePublicationIntent(candidate, facts);
    } else {
      throw storedDataFailure(
        "Persisted materialization publication stage is invalid."
      );
    }
    if (row.publication_json !== canonicalJson(publication)) {
      throw storedDataFailure(
        "Persisted materialization publication is not canonical."
      );
    }
  }

  const effectRequired: boolean = [
    "published",
    "evidence_pending",
    "audit_finalized",
    "proof_finalized",
    "completed"
  ].includes(stage);
  const hasEffect = row.effect_json !== null;
  if (
    (effectRequired && !hasEffect) ||
    (hasEffect && !publication?.proofDigest) ||
    (!effectRequired &&
      stage !== "rollback_incomplete" &&
      hasEffect)
  ) {
    throw storedDataFailure(
      "Persisted materialization effect state is incomplete."
    );
  }
  let effect: MaterializationPublishedEffect | null = null;
  if (hasEffect) {
    if (!isPublicationPrepared(publication)) {
      throw storedDataFailure(
        "Persisted materialization effect state is incomplete."
      );
    }
    effect = normalizePublishedEffect(
      parseStoredJson(
        row.effect_json,
        "Materialization published effect"
      ),
      request,
      publication
    );
  }
  if (
    effect &&
    (
      row.effect_json !== canonicalJson(effect) ||
      row.published_revision !== effect.publishedRevision
    )
  ) {
    throw storedDataFailure(
      "Persisted materialization effect is inconsistent."
    );
  }
  if (!effect && row.published_revision !== "") {
    throw storedDataFailure(
      "Published revision exists without a committed effect."
    );
  }

  const evidenceRequired: boolean = [
    "evidence_pending",
    "audit_finalized",
    "proof_finalized",
    "completed"
  ].includes(stage);
  const hasEvidence = row.evidence_json !== null;
  if (
    (evidenceRequired && !hasEvidence) ||
    (hasEvidence && !effect) ||
    (!evidenceRequired &&
      stage !== "rollback_incomplete" &&
      hasEvidence)
  ) {
    throw storedDataFailure(
      "Persisted materialization evidence state is incomplete."
    );
  }
  let evidence: MaterializationSettlementEvidence | null = null;
  if (hasEvidence) {
    if (!effect || !isPublicationPrepared(publication)) {
      throw storedDataFailure(
        "Persisted materialization evidence state is incomplete."
      );
    }
    evidence = normalizeEvidence(
      parseStoredJson(
        row.evidence_json,
        "Materialization evidence"
      ),
      {
        request,
        publication,
        effect,
        stage
      }
    );
  }
  if (
    evidence &&
    row.evidence_json !== canonicalJson(evidence)
  ) {
    throw storedDataFailure(
      "Persisted materialization evidence is not canonical."
    );
  }

  const hasResult = row.result_json !== null;
  const parsedResult: unknown = hasResult
    ? parseStoredJson(
        row.result_json,
        "Materialization result"
      )
    : null;
  let result:
    | MaterializationCheckpointResult
    | MaterializationCompletedResult
    | null = null;
  if (stage === "completed") {
    if (!hasResult || !effect || !evidence) {
      throw storedDataFailure(
        "Completed materialization state is incomplete."
      );
    }
    result = normalizeCompletedResult(parsedResult, {
      request,
      effect,
      evidence
    });
  } else if (
    effect &&
    [
      "published",
      "evidence_pending",
      "audit_finalized",
      "proof_finalized",
      "rollback_incomplete"
    ].includes(stage)
  ) {
    if (!hasResult) {
      throw storedDataFailure(
        "Committed materialization checkpoint is missing."
      );
    }
    result = normalizeCheckpointResult(parsedResult, effect);
  } else if (hasResult) {
    throw storedDataFailure(
      "Materialization result exists before a committed effect."
    );
  }
  if (result && row.result_json !== canonicalJson(result)) {
    throw storedDataFailure(
      "Persisted materialization result is not canonical."
    );
  }

  const hasError = row.error_json !== null;
  const error = hasError
    ? normalizeStoredError(
        parseStoredJson(
          row.error_json,
          "Materialization error"
        )
      )
    : null;
  if (
    (error && row.error_json !== canonicalJson(error)) ||
    (status === "failed" && !error) ||
    (
      ["running", "completed", "cancelled"].includes(
        status
      ) &&
      error
    )
  ) {
    throw storedDataFailure(
      "Persisted materialization error state is inconsistent."
    );
  }

  const base = Object.freeze({
    ...request,
    ownerFence,
    leaseUntil,
    preimage,
    targetStateDigest: storedText(row.target_state_digest),
    parentFingerprint: storedText(row.parent_fingerprint),
    parentIdentity,
    publication,
    publishedIdentity: publication?.preparedIdentity || null,
    priorRevision: storedText(row.prior_revision),
    publishedRevision: storedText(row.published_revision),
    effect,
    evidence,
    result,
    error
  });

  switch (stage) {
    case "admitted": {
      if (
        status === "completed" ||
        publication ||
        effect ||
        evidence ||
        result
      ) {
        throw storedDataFailure(
          "Persisted materialization admitted state is not effect-free."
        );
      }
      return Object.freeze({
        ...base,
        status,
        stage: "admitted",
        publication: null,
        publishedIdentity: null,
        effect: null,
        evidence: null,
        result: null
      });
    }
    case "publication_intent": {
      if (status !== "running") {
        throw storedDataFailure(
          "Persisted materialization lifecycle state is invalid."
        );
      }
      if (
        !preimage ||
        !parentIdentity ||
        !isPublicationIntent(publication) ||
        effect ||
        evidence ||
        result
      ) {
        throw storedDataFailure(
          "Persisted materialization publication state is incomplete."
        );
      }
      return Object.freeze({
        ...base,
        status: "running",
        stage: "publication_intent",
        preimage,
        parentIdentity,
        publication,
        publishedIdentity: null,
        publishedRevision: "",
        effect: null,
        evidence: null,
        result: null,
        error: null
      });
    }
    case "temp_reserved": {
      if (status !== "running") {
        throw storedDataFailure(
          "Persisted materialization lifecycle state is invalid."
        );
      }
      if (
        !preimage ||
        !parentIdentity ||
        !isPublicationReservation(publication) ||
        effect ||
        evidence ||
        result
      ) {
        throw storedDataFailure(
          "Persisted materialization publication state is incomplete."
        );
      }
      return Object.freeze({
        ...base,
        status: "running",
        stage: "temp_reserved",
        preimage,
        parentIdentity,
        publication,
        publishedIdentity: null,
        publishedRevision: "",
        effect: null,
        evidence: null,
        result: null,
        error: null
      });
    }
    case "publication_prepared": {
      if (status !== "running") {
        throw storedDataFailure(
          "Persisted materialization lifecycle state is invalid."
        );
      }
      if (
        !preimage ||
        !parentIdentity ||
        !isPublicationPrepared(publication) ||
        effect ||
        evidence ||
        result
      ) {
        throw storedDataFailure(
          "Persisted materialization publication state is incomplete."
        );
      }
      return Object.freeze({
        ...base,
        status: "running",
        stage: "publication_prepared",
        preimage,
        parentIdentity,
        publication,
        publishedIdentity: null,
        publishedRevision: "",
        effect: null,
        evidence: null,
        result: null,
        error: null
      });
    }
    case "published": {
      if (status !== "running") {
        throw storedDataFailure(
          "Persisted materialization lifecycle state is invalid."
        );
      }
      if (
        !preimage ||
        !parentIdentity ||
        !isPublicationPrepared(publication) ||
        !effect ||
        !result ||
        evidence
      ) {
        throw storedDataFailure(
          "Persisted materialization committed state is incomplete."
        );
      }
      return Object.freeze({
        ...base,
        status: "running",
        stage: "published",
        preimage,
        parentIdentity,
        publication,
        publishedIdentity: publication.preparedIdentity,
        publishedRevision: effect.publishedRevision,
        effect,
        evidence: null,
        result,
        error: null
      });
    }
    case "evidence_pending":
    case "audit_finalized":
    case "proof_finalized": {
      if (status !== "running") {
        throw storedDataFailure(
          "Persisted materialization lifecycle state is invalid."
        );
      }
      if (
        !preimage ||
        !parentIdentity ||
        !isPublicationPrepared(publication) ||
        !effect ||
        !evidence ||
        !result
      ) {
        throw storedDataFailure(
          "Persisted materialization settlement state is incomplete."
        );
      }
      const settlement = {
        ...base,
        status: "running" as const,
        preimage,
        parentIdentity,
        publication,
        publishedIdentity: publication.preparedIdentity,
        publishedRevision: effect.publishedRevision,
        effect,
        evidence,
        result,
        error: null
      };
      if (stage === "evidence_pending") {
        return Object.freeze({
          ...settlement,
          stage: "evidence_pending"
        });
      }
      if (stage === "audit_finalized") {
        return Object.freeze({
          ...settlement,
          stage: "audit_finalized"
        });
      }
      return Object.freeze({
        ...settlement,
        stage: "proof_finalized"
      });
    }
    case "completed": {
      if (
        status !== "completed" ||
        !preimage ||
        !parentIdentity ||
        !isPublicationPrepared(publication) ||
        !effect ||
        !evidence ||
        !result ||
        !isCompletedResult(result) ||
        ownerFence !== "" ||
        leaseUntil !== 0 ||
        error
      ) {
        throw storedDataFailure(
          "Completed materialization state is incomplete."
        );
      }
      return Object.freeze({
        ...base,
        status: "completed",
        stage: "completed",
        ownerFence: "",
        leaseUntil: 0,
        preimage,
        parentIdentity,
        publication,
        publishedIdentity: publication.preparedIdentity,
        publishedRevision: effect.publishedRevision,
        effect,
        evidence,
        result,
        error: null
      });
    }
    case "rollback_incomplete": {
      if (status !== "failed" || !error) {
        throw storedDataFailure(
          "Persisted materialization rollback state is incomplete."
        );
      }
      return Object.freeze({
        ...base,
        status: "failed",
        stage: "rollback_incomplete",
        ownerFence: "",
        leaseUntil: 0,
        error
      });
    }
  }
}

function sameColumnSet(
  actual: readonly string[],
  expected: readonly string[]
): boolean {
  return [...actual].sort().join("\0") ===
    [...expected].sort().join("\0");
}

/* Engine port contracts. */

export type MaterializationFaultPayload = Record<string, string | number>;
export type MaterializationFaultObserver = Record<
  string,
  ((input: MaterializationFaultPayload) => Promise<void> | void) | undefined
>;

export interface MaterializationFenceInput {
  readonly ownerFence?: string;
}

export interface MaterializationRecordPreimageInput
  extends MaterializationFenceInput {
  readonly parentFingerprint: unknown;
  readonly parentIdentity: unknown;
  readonly preimage: unknown;
  readonly stateEventAnchor?: unknown;
  readonly targetStateDigest: unknown;
}

export interface MaterializationRecordPublicationInput<
  P extends MaterializationPublication
> extends MaterializationFenceInput {
  readonly publication: P;
}

export interface MaterializationRecordPublishedInput
  extends MaterializationFenceInput {
  readonly checkpointRef: string;
  readonly proofDigest: string;
  readonly publicationId: string;
  readonly publishedIdentity: MaterializationPreparedFsIdentity;
  readonly publishedRevision: string;
  readonly priorRevision: string;
  readonly stateOperationId: string;
}

export interface MaterializationTransactionPort {
  assertFence(requestRef: string, input: MaterializationFenceInput): unknown;
  begin(
    requestRef: string,
    input: MaterializationFenceInput
  ):
    | MaterializationRunningState
    | MaterializationCompletedState
    | Promise<
        MaterializationRunningState | MaterializationCompletedState
      >;
  complete(
    requestRef: string,
    input: MaterializationFenceInput & {
      result: MaterializationOperationResult;
      settlementDigest: string;
    }
  ): MaterializationDurableState | Promise<MaterializationDurableState>;
  fail(
    requestRef: string,
    input: MaterializationFenceInput & {
      error: { readonly code: string };
      recoverable: boolean;
    }
  ): unknown;
  get(
    requestRef: string
  ): MaterializationDurableState | null |
    Promise<MaterializationDurableState | null>;
  markRollbackIncomplete(
    requestRef: string,
    input: MaterializationFenceInput & {
      error: { readonly code: string };
    }
  ): unknown;
  recordAuditFinalized(
    requestRef: string,
    input: MaterializationFenceInput & {
      auditRef: string;
      settlementDigest: string;
    }
  ): MaterializationDurableState | Promise<MaterializationDurableState>;
  recordEvidencePending(
    requestRef: string,
    input: MaterializationFenceInput
  ): MaterializationDurableState | Promise<MaterializationDurableState>;
  recordPrecommitCleaned(
    requestRef: string,
    input: MaterializationFenceInput & {
      publicationId: string;
      reservationDigest: string;
    }
  ): MaterializationDurableState | Promise<MaterializationDurableState>;
  recordPreimage(
    requestRef: string,
    input: MaterializationRecordPreimageInput
  ): MaterializationDurableState | Promise<MaterializationDurableState>;
  recordProofFinalized(
    requestRef: string,
    input: MaterializationFenceInput & {
      proofRef: string;
      settlementDigest: string;
    }
  ): MaterializationDurableState | Promise<MaterializationDurableState>;
  recordPublicationIntent(
    requestRef: string,
    input: MaterializationRecordPublicationInput<PublicationIntent>
  ): MaterializationPublicationIntentState |
    Promise<MaterializationPublicationIntentState>;
  recordPublicationPrepared(
    requestRef: string,
    input: MaterializationRecordPublicationInput<PublicationPrepared>
  ): MaterializationPublicationPreparedState |
    Promise<MaterializationPublicationPreparedState>;
  recordPublished(
    requestRef: string,
    input: MaterializationRecordPublishedInput
  ): MaterializationDurableState | Promise<MaterializationDurableState>;
  recordTempReserved(
    requestRef: string,
    input: MaterializationRecordPublicationInput<PublicationReservation>
  ): MaterializationTempReservedState |
    Promise<MaterializationTempReservedState>;
  renew(requestRef: string, input: MaterializationFenceInput): unknown;
}

/* Transaction store contract. */

export interface MaterializationStoreCreateResult {
  readonly inserted: boolean;
}

export interface MaterializationStoreCancelResult {
  readonly cancelled: boolean;
}

export interface MaterializationStoreTerminalState {
  readonly transitioned: boolean;
  readonly terminal: boolean;
  readonly status: MaterializationStatus | "missing";
  readonly stage: MaterializationStage | "";
}

export interface MaterializationStoreLeaseState {
  readonly delayMs: number;
  readonly terminal: boolean;
  readonly status: MaterializationStatus | "missing";
  readonly stage: MaterializationStage | "";
}

export interface MaterializationStoreReconcileInput {
  readonly afterRequestRef?: string;
  readonly limit?: number;
}

export interface MaterializationTransactionStore
  extends MaterializationTransactionPort {
  create(request: unknown): Promise<MaterializationStoreCreateResult>;
  cancelQueued(
    requestRef: string
  ): Promise<MaterializationStoreCancelResult>;
  terminalFail(
    requestRef: string,
    error: unknown
  ): Promise<MaterializationStoreTerminalState>;
  listReconcileCandidates(
    input?: MaterializationStoreReconcileInput
  ): Promise<MaterializationDurableState[]>;
  retryAfterLease(
    requestRef: string
  ): Promise<MaterializationStoreLeaseState>;
  count(): number;
  close(): void;
}

export interface MaterializationAuthorityRevalidationInput {
  readonly authorityBindingDigest: string;
  readonly authorityRef: string;
  readonly input: MaterializationClosedAdmissionInput;
  readonly operation: MaterializationResolvedOperation;
  readonly requestDigest: string;
  readonly resourceBinding: {
    readonly descriptor: MaterializationDescriptor;
    readonly expectedWorkspaceRevision: string;
    readonly logicalTarget: string;
    readonly targetStateDigest: string;
    readonly workspaceId: string;
  };
}

export interface MaterializationResolvedOperation {
  readonly id: string;
}

export interface MaterializationAuthorityDecision {
  readonly allowed?: boolean;
  readonly revoked?: boolean;
  readonly reasonCode?: string;
  readonly subject?: {
    readonly subjectId?: string;
    readonly tenantId?: string;
  };
  readonly context?: Readonly<Record<string, string>>;
  readonly custodyAuthorizationReceipt?: unknown;
  readonly authorityBindingDigest?: string;
  readonly approvalIntentDigest?: string;
}

export interface MaterializationAuthorityPort {
  revalidate(
    input: MaterializationAuthorityRevalidationInput
  ): MaterializationAuthorityDecision |
    Promise<MaterializationAuthorityDecision>;
}

export interface MaterializationCustodyOpenInput {
  readonly authorizationReceipt: unknown;
  readonly byteCount: number;
  readonly contentDigest: string;
  readonly custodyRef: string;
  readonly envelopeDigest: string;
  readonly maxBytes: number;
  readonly owner: MaterializationOwner;
  readonly resourceRef: string;
  readonly signal: AbortSignal | null;
}

export interface MaterializationCustodyStream {
  readonly stream?: AsyncIterable<Buffer>;
}

export interface MaterializationCustodyReadPort {
  open(
    input: MaterializationCustodyOpenInput
  ): MaterializationCustodyStream |
    Promise<MaterializationCustodyStream>;
}

export interface MaterializationResolvedDescriptor {
  readonly descriptor: MaterializationDescriptor;
  readonly resourceRevision: string;
}

export interface MaterializationResourceResolveInput {
  readonly record: MaterializationRequestRecord;
  readonly owner: MaterializationOwner;
  readonly target: MaterializationTargetInspection;
}

export interface MaterializationResourcePort {
  resolveCurrentDescriptor(
    input: MaterializationResourceResolveInput
  ): MaterializationResolvedDescriptor |
    Promise<MaterializationResolvedDescriptor>;
}

export interface MaterializationTargetInspection {
  readonly ok: boolean;
  readonly code?: string;
  readonly status?: number;
  readonly targetStateDigest?: string;
  readonly parentFingerprint?: string;
  readonly parentIdentity?: MaterializationFsIdentity;
  readonly anchor?: MaterializationStateEventAnchor;
}

export interface MaterializationLeaseGuardInput {
  readonly leaseGuard: () => unknown;
  readonly signal?: AbortSignal | null;
}

export interface MaterializationPreimageCapture {
  readonly ok: boolean;
  readonly code?: string;
  readonly status?: number;
  readonly preimage?: unknown;
  readonly priorRevision?: string;
}

export interface MaterializationWorkspaceRecoveryInput {
  readonly leaseGuard: () => unknown;
  readonly preimage: MaterializationPreimage | null;
  readonly publication: MaterializationPublication | null;
  readonly signal: AbortSignal | null;
}

export interface MaterializationPublishedReceipt {
  readonly ok: true;
  readonly contentDigest: string;
  readonly byteCount: number;
  readonly beforeRevision: string;
  readonly workspaceRevision: string;
  readonly publishedRevision: string;
  readonly publishedIdentity: MaterializationPreparedFsIdentity;
  readonly checkpointRef: string;
  readonly publicationId: string;
  readonly stateOperationId: string;
  readonly proofDigest: string;
}

export interface MaterializationRecoveryResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly status?: number;
  readonly disposition?: "retry" | "committed";
  readonly receipt?: MaterializationPublishedReceipt;
  readonly workspaceRevision?: string;
}

export interface MaterializationPublicationCallbackInput {
  readonly intentDigest: string;
  readonly publicationId: string;
  readonly stateOperationId: string;
}

export interface MaterializationReservationCallbackInput
  extends MaterializationPublicationCallbackInput {
  readonly reservationDigest: string;
}

export interface MaterializationProofCallbackInput
  extends MaterializationPublicationCallbackInput {
  readonly proofDigest: string;
}

export interface MaterializationChunkCallbackInput {
  readonly copiedBytes: number;
  readonly publicationId: string;
  readonly stateOperationId: string;
}

export interface MaterializationReceiptCallbackInput
  extends MaterializationProofCallbackInput {
  readonly checkpointRef: string;
  readonly publishedRevision: string;
}

export interface MaterializationWorkspaceMaterializeInput {
  readonly publication: PublicationIntent;
  readonly leaseGuard: () => unknown;
  readonly signal: AbortSignal | null;
  readonly claimPublicationAuthority: () => Promise<AsyncIterable<Buffer>>;
  readonly recordTempReserved: (
    publication: PublicationReservation
  ) => Promise<PublicationReservation>;
  readonly recordPublicationPrepared: (
    publication: PublicationPrepared
  ) => Promise<PublicationPrepared>;
  readonly afterDirectoryWorkerBoundBeforeReserve?: (
    input: MaterializationPublicationCallbackInput
  ) => Promise<unknown>;
  readonly afterTempInodeReservedBeforeWal?: (
    input: MaterializationPublicationCallbackInput
  ) => Promise<unknown>;
  readonly afterTempReservedBeforeFirstWrite?: (
    input: MaterializationReservationCallbackInput
  ) => Promise<unknown>;
  readonly afterFirstChunkWrittenBeforeContinue?: (
    input: MaterializationChunkCallbackInput
  ) => Promise<unknown>;
  readonly afterPublicationPreparedBeforeLink?: (
    input: MaterializationProofCallbackInput
  ) => Promise<unknown>;
  readonly afterPublicationLinkedBeforeTempUnlink?: (
    input: MaterializationProofCallbackInput
  ) => Promise<unknown>;
  readonly afterPublishedFileDurableBeforeStateCommit?: (
    input: MaterializationProofCallbackInput
  ) => Promise<unknown>;
  readonly afterStateAndCheckpointDurableBeforeReceipt?: (
    input: MaterializationReceiptCallbackInput
  ) => Promise<unknown>;
}

export interface MaterializationWorkspaceSession {
  getRevision(): Promise<string>;
  inspectTarget(
    input: MaterializationLeaseGuardInput
  ): Promise<MaterializationTargetInspection>;
  capturePreimage(
    input: MaterializationLeaseGuardInput
  ): Promise<MaterializationPreimageCapture>;
  recover(
    input: MaterializationWorkspaceRecoveryInput
  ): Promise<MaterializationRecoveryResult>;
  materialize(
    input: MaterializationWorkspaceMaterializeInput
  ): Promise<MaterializationPublishedReceipt>;
}

export interface MaterializationWorkspacePort {
  withRequest<T>(
    record: MaterializationDurableState,
    task: (workspace: MaterializationWorkspaceSession) => Promise<T>
  ): Promise<T>;
}

export interface MaterializationAuditAppendInput {
  readonly action: "materialize";
  readonly auditId: string;
  readonly createdAt: string;
  readonly input: {
    readonly bindingDigest: string;
    readonly publicationProofDigest: string;
    readonly settlementDigest: string;
  };
  readonly operationId: string;
  readonly output: {
    readonly checkpointRef: string;
    readonly contentDigest: string;
    readonly workspaceRevision: string;
  };
  readonly requestId: string;
  readonly status: "completed";
  readonly transport: "job-worker";
}

export interface MaterializationAuditReceipt {
  readonly auditId: string;
}

export interface MaterializationAuditPort {
  appendIdempotent(
    input: MaterializationAuditAppendInput
  ): MaterializationAuditReceipt | Promise<MaterializationAuditReceipt>;
  getById(id: string): unknown;
}

export interface MaterializationProofEntry {
  readonly status?: string;
  readonly ledgerEventId?: string;
  readonly proof?: {
    readonly terminal?: boolean;
  };
}

export interface MaterializationProofBeginInput {
  readonly idempotencyKey: string;
  readonly input: {
    readonly bindingDigest: string;
    readonly resourceRevision: string;
  };
  readonly operationId: string;
  readonly workspaceId: string;
}

export interface MaterializationProofFinishInput {
  readonly entry?: MaterializationProofEntry | null;
  readonly ledgerEventId?: string;
  readonly auditId?: string;
  readonly idempotencyKey: string;
  readonly outcomeIdempotencyKey: string;
  readonly receiptRefs?: readonly string[];
  readonly result: Readonly<Record<string, unknown>>;
  readonly status: "failed" | "in_doubt" | "succeeded";
  readonly outcomeKind?: string;
  readonly failed?: boolean;
  readonly error?: string;
}

export interface MaterializationProofReceipt {
  readonly ledgerEventId?: string;
}

export interface MaterializationProofPort {
  beginLifecycle(
    input: MaterializationProofBeginInput
  ): MaterializationProofEntry | Promise<MaterializationProofEntry>;
  finishLifecycle(
    input: MaterializationProofFinishInput
  ): MaterializationProofReceipt | Promise<MaterializationProofReceipt>;
}
