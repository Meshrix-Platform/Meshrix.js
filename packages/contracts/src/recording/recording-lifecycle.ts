/**
 * Enterprise recording lifecycle contract: the RecordingSink descriptor,
 * RecordAdmission gate decisions, per-category RecordingRecord envelopes and
 * truthful post-effect RecordingOutcome reports.
 *
 * Everything here is *selected history*: every message declares
 * `evidenceClass: "selected_history"` and is gated by the current
 * RecordingPolicy revision. Minimal correctness state (grants/revocation,
 * replay fences, execution intents, outcome reconciliation) and the mandatory
 * lifecycle proof are owned elsewhere and never traverse this surface.
 */
import {
  RECORDING_CATEGORIES,
  RECORDING_ENABLE_BACKFILLS_PRIOR_CONTENT,
  RECORDING_FORBIDDEN_KEYS,
  RECORDING_OBLIGATIONS,
  RECORDING_PHASES,
  RECORDING_REQUIRED_OBLIGATION_CATEGORIES,
  containsForbiddenRecordingKeys,
  parseRecordingPolicy,
  recordingCategorySelectionFor
} from "./recording-policy.ts";

export const RECORDING_LIFECYCLE_SCHEMA_VERSION = "v0.0.1:recording:lifecycle-1";

export const RECORDING_KINDS = Object.freeze([
  "recording-sink",
  "record-admission",
  "recording-record",
  "recording-outcome"
]);
export const RECORDING_SINK_CUSTODY = Object.freeze([
  "enterprise_local"
]);
export const RECORDING_ADMISSION_DECISIONS = Object.freeze([
  "admit",
  "deny",
  "shed",
  "reject"
]);
export const RECORDING_DENY_REASONS = Object.freeze([
  "category_disabled",
  "policy_superseded",
  "role_unauthorized",
  "forbidden_field",
  "field_not_selected",
  "phase_mismatch",
  "destination_unselected"
]);
export const RECORDING_SHED_REASONS = Object.freeze([
  "capacity_exceeded",
  "rate_limited",
  "sink_unavailable"
]);
export const RECORDING_REJECT_REASONS = Object.freeze([
  "recording_unavailable"
]);
export const RECORDING_OUTCOMES = Object.freeze([
  "recorded",
  "partially_recorded",
  "shed",
  "not_recorded",
  "recording_degraded",
  "terminal_record_pending"
]);
export const RECORDING_OUTCOME_REASONS = Object.freeze([
  "none",
  "category_disabled",
  "policy_superseded",
  "capacity_exceeded",
  "rate_limited",
  "sink_unavailable",
  "sink_write_failed"
]);
export const RECORDING_OPERATION_STATES = Object.freeze([
  "not_started",
  "in_progress",
  "succeeded",
  "failed",
  "cancelled",
  "in_doubt",
  "status_unavailable"
]);
export const RECORDING_EXECUTION_EVENTS = Object.freeze([
  "started",
  "completed",
  "failed"
]);
export const RECORDING_EFFECT_CLASSES = Object.freeze([
  "read",
  "safe_write",
  "destructive",
  "unknown"
]);
export const RECORDING_DURATION_BUCKETS = Object.freeze([
  "lt_10ms",
  "lt_100ms",
  "lt_1s",
  "lt_10s",
  "gte_10s",
  "not_applicable"
]);
export const RECORDING_GOVERNANCE_EVENTS = Object.freeze([
  "administration",
  "grant_change",
  "policy_decision",
  "approval",
  "revocation"
]);
export const RECORDING_FAILURE_CODES = Object.freeze([
  "sink_unavailable",
  "sink_write_failed",
  "capacity_exceeded"
]);
export const RECORDING_FAILURE_PHASES = Object.freeze([
  "pre_effect",
  "post_effect",
  "settlement"
]);

export const RECORDING_LIFECYCLE_LIMITS = Object.freeze({
  maxOpaqueIdBytes: 128,
  maxArtifactRefs: 16,
  maxAuthorityRefs: 16,
  maxFieldNames: 64,
  maxCounters: 32,
  maxRecordBytes: 262_144,
  maxContentBytes: 1_073_741_824,
  maxIndexBytes: 65_536,
  maxBufferedRecords: 65_536,
  maxPendingWrites: 65_536,
  maxSinkBytes: 1_099_511_627_776
});

export const RECORDING_SINK_REQUIRES_DURABLE = true;
export const RECORDING_FAILURE_UNDOES_EFFECT = false;
export const RECORDING_RECONCILE_REPLAYS_EFFECT = false;
export const RECORDING_OPTIONAL_SHED_STOPS_WORK = false;
export const RECORDING_FULL_STORE_GUARANTEES_TERMINAL_AUDIT = false;
export const RECORDING_ADMITTED_REVISION_OVERRIDES_OFF = false;

const FAIL = Symbol("recording-lifecycle-fail");
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
type UnknownRecord = Record<string, unknown>;
type FieldParser<T> = (value: unknown, source: UnknownRecord) => T | typeof FAIL;
type ParserSpec = Record<string, FieldParser<unknown>>;
type ParsedSpec<T extends ParserSpec> = Readonly<{
  [K in keyof T]: Exclude<ReturnType<T[K]>, typeof FAIL>;
}>;
type RecordingParser = (value?: unknown) => Readonly<UnknownRecord> | null;

const KIND_PARSERS: Record<string, RecordingParser> = {};

function isPlainObject(value?: unknown): value is UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is UnknownRecord {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key, index) => key === keys[index]);
}

function boundedText(value: unknown, maxBytes: number = RECORDING_LIFECYCLE_LIMITS.maxOpaqueIdBytes): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes ? normalized : "";
}

function revision(value?: unknown): number | typeof FAIL {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : FAIL;
}

function positiveRevision(value?: unknown): number | typeof FAIL {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : FAIL;
}

function boolValue(value?: unknown): boolean | typeof FAIL {
  return typeof value === "boolean" ? value : FAIL;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | typeof FAIL {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : FAIL;
}

function opaqueId(value: unknown, maxBytes: number = RECORDING_LIFECYCLE_LIMITS.maxOpaqueIdBytes): string | typeof FAIL {
  const normalized = boundedText(value, maxBytes);
  return normalized && OPAQUE_ID_PATTERN.test(normalized) ? normalized : FAIL;
}

function digestValue(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, RECORDING_LIFECYCLE_LIMITS.maxOpaqueIdBytes);
  return normalized && DIGEST_PATTERN.test(normalized) ? normalized : FAIL;
}

function instantValue(value?: unknown): string | typeof FAIL {
  const normalized = boundedText(value, 64);
  return normalized && ISO_INSTANT_PATTERN.test(normalized) ? normalized : FAIL;
}

function parseObject<T extends ParserSpec>(value: unknown, spec: T): ParsedSpec<T> | null {
  const keys = Object.keys(spec).sort();
  if (!hasExactKeys(value, keys) || containsForbiddenRecordingKeys(value)) return null;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(spec)) {
    const parsed = spec[key](value[key], value);
    if (parsed === FAIL) return null;
    output[key] = parsed;
  }
  return Object.freeze(output) as ParsedSpec<T>;
}

function parseArray<T>(
  value: unknown,
  parseItem: (value: unknown) => T | typeof FAIL | null,
  max: number,
  allowEmpty: boolean = true
): readonly T[] | typeof FAIL {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) return FAIL;
  const items: T[] = [];
  for (const entry of value) {
    const item = parseItem(entry);
    if (item === FAIL || item == null) return FAIL;
    items.push(item);
  }
  return Object.freeze(items);
}

function uniqueIds(value: unknown, max: number, allowEmpty = true): readonly string[] | typeof FAIL {
  const items = parseArray(value, (entry) => opaqueId(entry), max, allowEmpty);
  if (items === FAIL) return FAIL;
  return items.length === new Set(items).size ? items : FAIL;
}

function counterMap(value: unknown, max: number, allowEmpty = false): Readonly<Record<string, number>> | typeof FAIL {
  if (!isPlainObject(value)) return FAIL;
  const keys = Object.keys(value);
  if (keys.length > max || (!allowEmpty && keys.length === 0)) return FAIL;
  const output: Record<string, number> = {};
  for (const key of keys) {
    if (opaqueId(key) === FAIL) return FAIL;
    const counter = value[key];
    if (!Number.isSafeInteger(counter) || (counter as number) < 0) return FAIL;
    output[key] = counter as number;
  }
  return Object.freeze(output);
}

function created<T>(parseFn: (value: unknown) => T | null, value: unknown, message: string): T {
  const parsed = parseFn(value);
  if (!parsed) throw new TypeError(message);
  return parsed;
}

function envelope(kind: string, extras: Record<string, unknown> = {}): UnknownRecord {
  return {
    schemaVersion: RECORDING_LIFECYCLE_SCHEMA_VERSION,
    kind,
    ...extras
  };
}

function commonRemote<T extends ParserSpec>(kind: string, extra: T) {
  return {
    schemaVersion: (entry: unknown) => entry === RECORDING_LIFECYCLE_SCHEMA_VERSION ? entry : FAIL,
    kind: (entry: unknown) => entry === kind ? entry : FAIL,
    ...extra
  };
}

function selectedHistory(entry: unknown): string | typeof FAIL {
  return entry === "selected_history" ? entry as string : FAIL;
}

/* ------------------------------------------------------------------ *
 * RecordingSink: the narrow enterprise-owned local durable destination.  *
 * ------------------------------------------------------------------ */

export function parseRecordingSinkBudgets(value?: unknown) {
  return parseObject(value, {
    maxRecordBytes: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= RECORDING_LIFECYCLE_LIMITS.maxRecordBytes ? entry as number : FAIL
    ),
    maxContentBytes: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 0
        && (entry as number) <= RECORDING_LIFECYCLE_LIMITS.maxSinkBytes ? entry as number : FAIL
    ),
    maxIndexBytes: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= RECORDING_LIFECYCLE_LIMITS.maxSinkBytes ? entry as number : FAIL
    ),
    maxBufferedRecords: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= RECORDING_LIFECYCLE_LIMITS.maxBufferedRecords ? entry as number : FAIL
    ),
    maxPendingWrites: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= RECORDING_LIFECYCLE_LIMITS.maxPendingWrites ? entry as number : FAIL
    )
  });
}

export function parseRecordingSink(value?: unknown) {
  return parseObject(value, commonRemote("recording-sink", {
    sinkId: (entry) => opaqueId(entry),
    custody: (entry) => enumValue(entry, RECORDING_SINK_CUSTODY),
    // The baseline sink is durable enterprise-owned storage; a volatile sink
    // would falsify "recorded" outcomes.
    durable: (entry) => entry === true ? entry : FAIL,
    budgets: (entry) => parseRecordingSinkBudgets(entry) || FAIL
  }));
}

/**
 * Live capacity view a sink reports at admission time. Separate content and
 * index budgets enforce the split retention model: large content bytes and
 * index/metadata never share one pool.
 */
export function parseRecordingSinkState(value?: unknown) {
  return parseObject(value, {
    sinkRef: (entry) => opaqueId(entry),
    available: boolValue,
    bufferedRecords: revision,
    pendingWrites: revision,
    contentBytesRemaining: revision,
    indexBytesRemaining: revision
  });
}

/* ------------------------------------------------------------------ *
 * RecordAdmission: the gate decision at each collection point.          *
 * ------------------------------------------------------------------ */

export function parseRecordAdmission(value?: unknown) {
  const parsed = parseObject(value, commonRemote("record-admission", {
    admissionId: (entry) => opaqueId(entry),
    tenantRef: (entry) => opaqueId(entry),
    operationRef: (entry) => opaqueId(entry),
    category: (entry) => enumValue(entry, RECORDING_CATEGORIES),
    evidenceClass: selectedHistory,
    phase: (entry) => enumValue(entry, RECORDING_PHASES),
    obligation: (entry) => entry === null ? null : enumValue(entry, RECORDING_OBLIGATIONS),
    policyRevision: positiveRevision,
    decision: (entry) => enumValue(entry, RECORDING_ADMISSION_DECISIONS),
    reason: (entry) => enumValue(entry, [
      "none",
      ...RECORDING_DENY_REASONS,
      ...RECORDING_SHED_REASONS,
      ...RECORDING_REJECT_REASONS
    ])
  }));
  if (!parsed) return null;
  const obligation = parsed.obligation as string | null;
  // Only categories eligible for a required obligation own a pre-effect
  // collection point; at any other point the gate may only document a deny.
  if (parsed.phase === "pre_effect"
      && !RECORDING_REQUIRED_OBLIGATION_CATEGORIES.includes(parsed.category as never)
      && parsed.decision !== "deny") {
    return null;
  }
  switch (parsed.decision) {
    case "admit":
      if (parsed.reason !== "none" || obligation === null) return null;
      break;
    case "deny":
      if (!RECORDING_DENY_REASONS.includes(parsed.reason as never)) return null;
      break;
    case "shed":
      if (!RECORDING_SHED_REASONS.includes(parsed.reason as never)) return null;
      if (obligation !== "optional") return null;
      break;
    case "reject":
      if (parsed.reason !== "recording_unavailable") return null;
      if (obligation !== "required_before_effect" || parsed.phase !== "pre_effect") return null;
      break;
    default:
      return null;
  }
  return parsed;
}

/* ------------------------------------------------------------------ *
 * RecordingRecord: one bounded selected-history record per category.    *
 * ------------------------------------------------------------------ */

function parseContentDetail(value?: unknown) {
  const parsed = parseObject(value, {
    fieldNames: (entry) => uniqueIds(entry, RECORDING_LIFECYCLE_LIMITS.maxFieldNames, false),
    contentDigest: (entry) => digestValue(entry),
    artifactRefs: (entry) => uniqueIds(entry, RECORDING_LIFECYCLE_LIMITS.maxArtifactRefs)
  });
  return parsed;
}

function parseExecutionHistoryDetail(value?: unknown) {
  const parsed = parseObject(value, {
    event: (entry) => enumValue(entry, RECORDING_EXECUTION_EVENTS),
    effectClass: (entry) => enumValue(entry, RECORDING_EFFECT_CLASSES),
    durationBucket: (entry) => enumValue(entry, RECORDING_DURATION_BUCKETS)
  });
  if (!parsed) return null;
  if (parsed.event === "started" && parsed.durationBucket !== "not_applicable") return null;
  if (parsed.event !== "started" && parsed.durationBucket === "not_applicable") return null;
  return parsed;
}

function parseGovernanceHistoryDetail(value?: unknown) {
  return parseObject(value, {
    governanceEvent: (entry) => enumValue(entry, RECORDING_GOVERNANCE_EVENTS),
    decisionRef: (entry) => opaqueId(entry),
    authorityRefs: (entry) => uniqueIds(entry, RECORDING_LIFECYCLE_LIMITS.maxAuthorityRefs, false)
  });
}

function parseUsageDetail(value?: unknown) {
  return parseObject(value, {
    counters: (entry) => counterMap(entry, RECORDING_LIFECYCLE_LIMITS.maxCounters),
    bucketStart: instantValue
  });
}

function parseDiagnosticsDetail(value?: unknown) {
  return parseObject(value, {
    eventCode: (entry) => opaqueId(entry),
    counters: (entry) => counterMap(entry, 8)
  });
}

const DETAIL_PARSERS: Record<string, (value?: unknown) => Readonly<UnknownRecord> | null> = {
  content: parseContentDetail,
  execution_history: parseExecutionHistoryDetail,
  governance_history: parseGovernanceHistoryDetail,
  usage: parseUsageDetail,
  diagnostics: parseDiagnosticsDetail
};

export function parseRecordingRecord(value?: unknown) {
  if (!isPlainObject(value) || containsForbiddenRecordingKeys(value)) return null;
  const category = typeof value.category === "string" ? value.category : "";
  const detailParser = DETAIL_PARSERS[category];
  if (!detailParser) return null;
  const parsed = parseObject(value, commonRemote("recording-record", {
    recordId: (entry) => opaqueId(entry),
    tenantRef: (entry) => opaqueId(entry),
    operationRef: (entry) => opaqueId(entry),
    category: (entry) => enumValue(entry, RECORDING_CATEGORIES),
    evidenceClass: selectedHistory,
    policyRevision: positiveRevision,
    sinkRef: (entry) => opaqueId(entry),
    phase: (entry) => enumValue(entry, RECORDING_PHASES),
    occurredAt: instantValue,
    detail: (entry) => detailParser(entry) || FAIL,
    indexBytes: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 1
        && (entry as number) <= RECORDING_LIFECYCLE_LIMITS.maxIndexBytes ? entry as number : FAIL
    ),
    contentBytes: (entry) => (
      Number.isSafeInteger(entry) && (entry as number) >= 0
        && (entry as number) <= RECORDING_LIFECYCLE_LIMITS.maxContentBytes ? entry as number : FAIL
    )
  }));
  if (!parsed) return null;
  const contentBytes = parsed.contentBytes as number;
  const detail = parsed.detail as UnknownRecord;
  if (parsed.phase === "pre_effect"
      && !RECORDING_REQUIRED_OBLIGATION_CATEGORIES.includes(category as never)) return null;
  if (category !== "content" && contentBytes !== 0) return null;
  if (category === "content" && contentBytes > 0
      && (detail.artifactRefs as readonly string[]).length === 0) return null;
  return parsed;
}

/* ------------------------------------------------------------------ *
 * RecordingOutcome: truthful post-effect recording status.              *
 * ------------------------------------------------------------------ */

export function parseRecordingFailure(value?: unknown) {
  return parseObject(value, {
    code: (entry) => enumValue(entry, RECORDING_FAILURE_CODES),
    phase: (entry) => enumValue(entry, RECORDING_FAILURE_PHASES)
  });
}

export function parseRecordingOutcome(value?: unknown) {
  const parsed = parseObject(value, commonRemote("recording-outcome", {
    outcomeId: (entry) => opaqueId(entry),
    operationRef: (entry) => opaqueId(entry),
    category: (entry) => enumValue(entry, RECORDING_CATEGORIES),
    evidenceClass: selectedHistory,
    obligation: (entry) => enumValue(entry, RECORDING_OBLIGATIONS),
    policyRevision: positiveRevision,
    outcome: (entry) => enumValue(entry, RECORDING_OUTCOMES),
    reason: (entry) => enumValue(entry, RECORDING_OUTCOME_REASONS),
    operationStatus: (entry) => enumValue(entry, RECORDING_OPERATION_STATES),
    recordsWritten: revision,
    pendingTerminal: boolValue,
    failure: (entry) => entry === null ? null : parseRecordingFailure(entry),
    occurredAt: instantValue
  }));
  if (!parsed) return null;
  const recordsWritten = parsed.recordsWritten as number;
  const pendingTerminal = parsed.pendingTerminal === true;
  const failure = parsed.failure as UnknownRecord | null;
  const obligation = parsed.obligation as string;
  const outcome = parsed.outcome as string;
  const reason = parsed.reason as string;
  const operationStatus = parsed.operationStatus as string;

  // A post-effect or settlement failure can only exist after an effect was
  // attempted; it can never rewrite a started operation as not_started.
  if (failure && failure.phase !== "pre_effect" && operationStatus === "not_started") return null;
  switch (outcome) {
    case "recorded":
      if (reason !== "none" || failure !== null || pendingTerminal || recordsWritten < 1) return null;
      break;
    case "partially_recorded":
      if (recordsWritten < 1 || (reason === "none" && failure === null)) return null;
      break;
    case "shed":
      if (obligation !== "optional") return null;
      if (!["capacity_exceeded", "rate_limited", "sink_unavailable"].includes(reason)) return null;
      if (failure !== null) return null;
      break;
    case "not_recorded":
      if (recordsWritten !== 0 || failure !== null) return null;
      if (!["category_disabled", "policy_superseded", "none"].includes(reason)) return null;
      // A required terminal obligation that was prevented — by an off toggle
      // or a superseded revision — stays visibly owed instead of silently met.
      if (obligation === "required_before_effect" && !pendingTerminal) return null;
      break;
    case "recording_degraded":
      if (failure === null || !["sink_unavailable", "sink_write_failed"].includes(reason)) return null;
      if (operationStatus === "not_started") return null;
      break;
    case "terminal_record_pending":
      if (!pendingTerminal || obligation !== "required_before_effect") return null;
      if (operationStatus === "not_started") return null;
      break;
    default:
      return null;
  }
  return parsed;
}

KIND_PARSERS["recording-sink"] = parseRecordingSink;
KIND_PARSERS["record-admission"] = parseRecordAdmission;
KIND_PARSERS["recording-record"] = parseRecordingRecord;
KIND_PARSERS["recording-outcome"] = parseRecordingOutcome;

export function parseRecordingMessage(value?: unknown) {
  if (!isPlainObject(value) || containsForbiddenRecordingKeys(value)) return null;
  const parser = typeof value.kind === "string" ? KIND_PARSERS[value.kind] : undefined;
  return parser ? parser(value) : null;
}

/* ------------------------------------------------------------------ *
 * Admission gate and settlement semantics.                              *
 * ------------------------------------------------------------------ */

/**
 * The collection gate every producer must pass before serializing or
 * enqueueing a record for a category. Returns the decision fields that a
 * `record-admission` message then documents, or null for malformed input.
 *
 * Order of evaluation is contractual: policy selection and privacy first,
 * then role, then sink availability/capacity. A category absent from the
 * current revision denies before any collection — an empty policy therefore
 * admits nothing, and an admitted earlier revision never overrides off.
 */
export function admitRecordingCategory(input: {
  policy?: unknown;
  category?: unknown;
  phase?: unknown;
  role?: unknown;
  fieldNames?: unknown;
  eventCode?: unknown;
  sinkState?: unknown;
} = {}) {
  const policy = parseRecordingPolicy(input?.policy);
  const category = enumValue(input?.category, RECORDING_CATEGORIES);
  const phase = enumValue(input?.phase, RECORDING_PHASES);
  if (!policy || category === FAIL || phase === FAIL) return null;
  const selection = recordingCategorySelectionFor(policy, category);
  const deny = (reason: string, obligation: string | null = null) => Object.freeze({
    decision: "deny" as const,
    reason,
    category,
    phase,
    obligation,
    policyRevision: policy.policyRevision
  });
  if (!selection) return deny("category_disabled");
  const obligation = String(selection.obligation);
  if (obligation === "required_before_effect"
      && !RECORDING_REQUIRED_OBLIGATION_CATEGORIES.includes(category as never)) return null;

  if (input.role !== undefined
      && ![...(selection.readerRoles as readonly string[]), ...(selection.configurerRoles as readonly string[])]
        .includes(String(input.role))) {
    return deny("role_unauthorized", obligation);
  }
  if (input.fieldNames !== undefined) {
    const names = Array.isArray(input.fieldNames) ? input.fieldNames : null;
    if (!names || names.some((name) => typeof name !== "string" || !name)) return null;
    if (names.some((name) => RECORDING_FORBIDDEN_KEYS.includes(name))) {
      return deny("forbidden_field", obligation);
    }
    if (names.some((name) => !(selection.fieldAllow as readonly string[]).includes(name))) {
      return deny("field_not_selected", obligation);
    }
  }
  if (input.eventCode !== undefined
      && !(selection.eventAllow as readonly string[]).includes(String(input.eventCode))) {
    return deny("field_not_selected", obligation);
  }
  if (phase === "pre_effect"
      && !RECORDING_REQUIRED_OBLIGATION_CATEGORIES.includes(category as never)) {
    return deny("phase_mismatch", obligation);
  }

  const sink = input.sinkState === undefined ? null : parseRecordingSinkState(input.sinkState);
  if (input.sinkState !== undefined && !sink) return null;
  const unavailable = sink !== null && sink.available !== true;
  const overCapacity = sink !== null && sink.available === true && (
    (sink.bufferedRecords as number) >= (selection.capacity.maxBufferedRecords as number)
      || (sink.indexBytesRemaining as number) <= 0
      || (category === "content" && (sink.contentBytesRemaining as number) <= 0)
  );
  if (unavailable || overCapacity) {
    const reason = unavailable ? "sink_unavailable" : "capacity_exceeded";
    if (obligation === "required_before_effect" && phase === "pre_effect") {
      // The required start record cannot be reserved before protected
      // dispatch: new operation admission is rejected, not silently degraded.
      return Object.freeze({
        decision: "reject" as const,
        reason: "recording_unavailable",
        category,
        phase,
        obligation,
        policyRevision: policy.policyRevision
      });
    }
    if (obligation === "optional") {
      return Object.freeze({
        decision: "shed" as const,
        reason,
        category,
        phase,
        obligation,
        policyRevision: policy.policyRevision
      });
    }
    // A required post-effect write attempt proceeds to the sink; its failure
    // is reported by the outcome, never by shedding the obligation.
    return Object.freeze({
      decision: "admit" as const,
      reason: "none",
      category,
      phase,
      obligation,
      policyRevision: policy.policyRevision
    });
  }
  return Object.freeze({
    decision: "admit" as const,
    reason: "none",
    category,
    phase,
    obligation,
    policyRevision: policy.policyRevision
  });
}

/** Only a rejected required-before-effect admission blocks protected work. */
export function recordingAdmissionBlocksOperation(decision: unknown): boolean {
  return decision === "reject";
}

/**
 * The truthful outcome for a category once an operation's effects are known.
 * A recording failure after an external effect cannot undo the effect:
 * required terminal records that could not be durably written surface as
 * `terminal_record_pending`, optional categories as `recording_degraded`, and
 * the operation keeps its real status.
 */
export function recordingOutcomeFor(input: {
  obligation?: unknown;
  categoryEnabled?: unknown;
  recordsWritten?: unknown;
  requiredTerminalOwed?: unknown;
  shedAtAdmission?: unknown;
  sinkFailure?: unknown;
} = {}) {
  const obligation = enumValue(input?.obligation, RECORDING_OBLIGATIONS);
  const enabled = boolValue(input?.categoryEnabled);
  const recordsWritten = revision(input?.recordsWritten);
  const terminalOwed = boolValue(input?.requiredTerminalOwed);
  const shed = boolValue(input?.shedAtAdmission);
  if (obligation === FAIL || enabled === FAIL || recordsWritten === FAIL
      || terminalOwed === FAIL || shed === FAIL) return null;
  const failure = input?.sinkFailure === undefined || input?.sinkFailure === null
    ? null
    : parseRecordingFailure(input.sinkFailure);
  if (input?.sinkFailure !== undefined && input?.sinkFailure !== null && !failure) return null;

  if (!enabled) {
    if ((recordsWritten as number) > 0) {
      // Captured records stand; the off toggle stopped all later collection.
      return Object.freeze({
        outcome: "partially_recorded",
        reason: "category_disabled",
        pendingTerminal: obligation === "required_before_effect" && terminalOwed
      });
    }
    return Object.freeze({
      outcome: "not_recorded",
      reason: "category_disabled",
      pendingTerminal: obligation === "required_before_effect" && terminalOwed
    });
  }
  if (shed) {
    // Required obligations never shed; the pre-effect reject owns that path.
    if (obligation !== "optional") return null;
    return Object.freeze({
      outcome: "shed",
      reason: failure ? String(failure.code) : "capacity_exceeded",
      pendingTerminal: false
    });
  }
  if (failure) {
    const reason = String(failure.code);
    if (obligation === "required_before_effect" && terminalOwed) {
      return Object.freeze({ outcome: "terminal_record_pending", reason, pendingTerminal: true });
    }
    return Object.freeze({
      outcome: "recording_degraded",
      reason,
      pendingTerminal: obligation === "required_before_effect" && terminalOwed
    });
  }
  if (terminalOwed) {
    return Object.freeze({
      outcome: "terminal_record_pending",
      reason: "none",
      pendingTerminal: true
    });
  }
  if ((recordsWritten as number) > 0) {
    return Object.freeze({ outcome: "recorded", reason: "none", pendingTerminal: false });
  }
  return Object.freeze({ outcome: "not_recorded", reason: "none", pendingTerminal: false });
}

/** Whether a required terminal record is still owed after this outcome. */
export function recordingObligationOutstanding(outcome: unknown): boolean {
  const parsed = parseRecordingOutcome(outcome);
  return parsed !== null && parsed.pendingTerminal === true;
}

/** Reconciliation may rewrite missing recording only — never the effect. */
export function recordingMayReplayEffect(outcome?: unknown): boolean {
  if (RECORDING_RECONCILE_REPLAYS_EFFECT !== false) {
    throw new Error("Recording reconciliation must never replay a completed effect.");
  }
  return false;
}

/** Whether a captured record may finish legitimate settlement under policy. */
export function recordingSettlementMayContinue(record: unknown, currentPolicy: unknown): boolean {
  const parsedRecord = parseRecordingRecord(record);
  const policy = parseRecordingPolicy(currentPolicy);
  if (!parsedRecord || !policy) return false;
  // Already-captured bounded records settle under their retention/access
  // policy even after off; off forbids capture, not settlement or deletion.
  return (parsedRecord.policyRevision as number) <= (policy.policyRevision as number);
}

/** A record counts as captured only under the policy revision that admitted it. */
export function recordingRecordCapturedUnderPolicy(record: unknown, policy: unknown): boolean {
  const parsedRecord = parseRecordingRecord(record);
  const parsedPolicy = parseRecordingPolicy(policy);
  if (!parsedRecord || !parsedPolicy) return false;
  if (parsedRecord.policyRevision !== parsedPolicy.policyRevision) return false;
  if (RECORDING_ENABLE_BACKFILLS_PRIOR_CONTENT !== false) {
    throw new Error("A later enable can never backfill content that was not collected.");
  }
  return recordingCategorySelectionFor(parsedPolicy, parsedRecord.category) !== null;
}

export function assertRecordingOutcomeHonest(value?: unknown) {
  const parsed = parseRecordingOutcome(value);
  if (!parsed) {
    throw new Error("Recording outcome must be a versioned recording-outcome message.");
  }
  if (RECORDING_FAILURE_UNDOES_EFFECT !== false) {
    throw new Error("A recording failure after an external effect cannot undo it.");
  }
  if (RECORDING_FULL_STORE_GUARANTEES_TERMINAL_AUDIT !== false
      && parsed.outcome === "terminal_record_pending" && parsed.pendingTerminal !== true) {
    throw new Error("A pending terminal record must stay visibly owed.");
  }
  return true;
}

/** Disabled categories cause no collection, serialization, enqueue or write. */
export function assertRecordingDisabledCollectsNothing(policy: unknown, category: unknown, phase: unknown = "post_effect") {
  const admission = admitRecordingCategory({ policy, category, phase });
  if (!admission) {
    throw new Error("Recording admission requires a parsed policy, category and phase.");
  }
  if (admission.decision === "admit") {
    throw new Error("A disabled recording category must deny before any collection.");
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Constructors.                                                        *
 * ------------------------------------------------------------------ */

export function createRecordingSink(value: Record<string, unknown> = {}) {
  return created(parseRecordingSink, envelope("recording-sink", {
    sinkId: value.sinkId,
    custody: value.custody || "enterprise_local",
    durable: value.durable === true,
    budgets: value.budgets
  }), "RecordingSink does not satisfy the recording contract.");
}

export function createRecordAdmission(value: Record<string, unknown> = {}) {
  return created(parseRecordAdmission, envelope("record-admission", {
    admissionId: value.admissionId,
    tenantRef: value.tenantRef,
    operationRef: value.operationRef,
    category: value.category,
    evidenceClass: "selected_history",
    phase: value.phase,
    obligation: value.obligation === undefined ? null : value.obligation,
    policyRevision: value.policyRevision,
    decision: value.decision,
    reason: value.reason
  }), "RecordAdmission does not satisfy the recording contract.");
}

export function createRecordingRecord(value: Record<string, unknown> = {}) {
  return created(parseRecordingRecord, envelope("recording-record", {
    recordId: value.recordId,
    tenantRef: value.tenantRef,
    operationRef: value.operationRef,
    category: value.category,
    evidenceClass: "selected_history",
    policyRevision: value.policyRevision,
    sinkRef: value.sinkRef,
    phase: value.phase,
    occurredAt: value.occurredAt,
    detail: value.detail,
    indexBytes: value.indexBytes,
    contentBytes: value.contentBytes === undefined ? 0 : value.contentBytes
  }), "RecordingRecord does not satisfy the recording contract.");
}

export function createRecordingOutcome(value: Record<string, unknown> = {}) {
  return created(parseRecordingOutcome, envelope("recording-outcome", {
    outcomeId: value.outcomeId,
    operationRef: value.operationRef,
    category: value.category,
    evidenceClass: "selected_history",
    obligation: value.obligation,
    policyRevision: value.policyRevision,
    outcome: value.outcome,
    reason: value.reason,
    operationStatus: value.operationStatus,
    recordsWritten: value.recordsWritten === undefined ? 0 : value.recordsWritten,
    pendingTerminal: value.pendingTerminal === true,
    failure: value.failure === undefined ? null : value.failure,
    occurredAt: value.occurredAt
  }), "RecordingOutcome does not satisfy the recording contract.");
}
