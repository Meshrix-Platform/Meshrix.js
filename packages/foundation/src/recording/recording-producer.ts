/**
 * recording-producer.ts
 *
 * Category-gated *selected history* producer for the Meshrix enterprise
 * recording contract (`@meshrix/contracts/recording`). This module is the
 * generic producer half of the recording architecture: it binds one
 * durable RecordingSink port (the committed `recording-sink-store` or any
 * port with the same synchronous surface) to operation-level collection
 * sessions so dispatch, audit and gateway producers never re-implement the
 * admission rules.
 *
 * Contract semantics this producer enforces — delegated to the contract
 * and the sink for authoritative validation:
 *
 * - **Live revision at every collection point.** `policy()` and every
 *   `admit`/`writeRecord` call read the sink's *current* revision; no
 *   decision or selection is cached across a collection boundary. An off
 *   flip during an in-flight operation therefore stops capture at the
 *   next collection point, and an admission taken under an older revision
 *   can never override a later off (`RECORDING_ADMITTED_REVISION_OVERRIDES_OFF`
 *   is false).
 * - **Admit before work.** `collect` gates on the sink's `admit` decision
 *   before `build` is invoked, so a disabled or unselected category causes
 *   no record construction, no serialization, no buffering, no enqueueing
 *   and no write.
 * - **Required categories reserve before the effect.**
 *   `session.admitBeforeEffect` admits every selected
 *   `required_before_effect` category at `pre_effect`; the sink takes a
 *   durable capacity reservation in that same decision, and a `reject`
 *   (`recording_unavailable`) refuses protected work *before* it starts.
 *   Optional categories are never written at `pre_effect` — they defer to
 *   post-effect collection so no duplicate start record is paid for a
 *   history entry no obligation requires.
 * - **Optional failure never cancels work.** Every sink call is isolated;
 *   optional shed/deny/write failures are reported on the result and via
 *   truthful `recording-outcome` derivation (`recording_degraded`,
 *   `shed`, `not_recorded`) while the operation keeps its real status
 *   (`RECORDING_OPTIONAL_SHED_STOPS_WORK` /
 *   `RECORDING_FAILURE_UNDOES_EFFECT` are false).
 * - **Off stops capture, not settlement.** Records captured before an off
 *   flip stay readable and retention-scoped under their admitting
 *   revision; owed required terminal records remain visible through
 *   `pendingObligations` and are retried — recording only — through
 *   `reconcileOperation` / `session.settlePending`
 *   (`RECORDING_OFF_DELETES_CAPTURED_RECORDS` /
 *   `RECORDING_RECONCILE_REPLAYS_EFFECT` are false).
 * - **Usage is aggregated, not per-request.** `noteUsage` accumulates
 *   bounded counters per `(tenantRef, bucketStart)` only while the
 *   `usage` category is enabled — an off flip stops accumulation, not just
 *   the flush — and `flushUsage` writes one aggregate record per closed
 *   bucket, so history growth is bounded by buckets, never by requests
 *   or chunks.
 */
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  RECORDING_CATEGORIES,
  RECORDING_REQUIRED_OBLIGATION_CATEGORIES,
  createRecordingRecord,
  recordingCategorySelectionFor
} from "@meshrix/contracts/recording";

export const RECORDING_PRODUCER_PROTOCOL_VERSION = "v0.0.1:recording:producer-1";

type UnknownRecord = Record<string, unknown>;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u;
const SINK_FAILURE_CODES: ReadonlySet<string> = new Set([
  "capacity_exceeded",
  "sink_unavailable",
  "sink_write_failed"
]);
const DEFAULT_USAGE_BUCKET_MS = 60 * 60 * 1000;
const DEFAULT_MAX_PENDING_USAGE_BUCKETS = 32;
const USAGE_COUNTER_LIMIT = 32;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function errorCode(error: unknown): string {
  return String((error as { code?: unknown })?.code || "");
}

/**
 * Names a recording identifier from arbitrary caller context. Admission and
 * record ids are opaque labels, never payload material; untrusted or empty
 * input degrades to a bounded sanitized label instead of a contract error.
 */
export function sanitizeRecordingRef(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let candidate = raw.replace(/[^A-Za-z0-9._:-]+/gu, "_").replace(/^[^A-Za-z0-9]+/u, "");
  while (candidate && Buffer.byteLength(candidate, "utf8") > 128) {
    candidate = candidate.slice(0, -1);
  }
  return OPAQUE_ID_PATTERN.test(candidate) ? candidate : "";
}

function deterministicRef(prefix: string, ...parts: unknown[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("|"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}${digest}`;
}

function normalizeCounterEntries(counters: unknown): [string, number][] {
  const entries: [string, number][] = [];
  if (!counters || typeof counters !== "object" || Array.isArray(counters)) return entries;
  for (const [key, value] of Object.entries(counters as UnknownRecord)) {
    if (!OPAQUE_ID_PATTERN.test(key)) continue;
    if (!Number.isSafeInteger(value) || (value as number) <= 0) continue;
    entries.push([key, value as number]);
    if (entries.length >= USAGE_COUNTER_LIMIT) break;
  }
  return entries;
}

export interface RecordingProducerOptions {
  sink?: unknown;
  now?: () => number;
  usageBucketMs?: number;
  maxPendingUsageBuckets?: number;
}

/**
 * One gated collection call: the category+phase gate runs against the
 * sink's live policy revision, then — only on `admit` — `build` constructs
 * the category detail (or a `{detail, contentBytes}` envelope) for write.
 */
export interface RecordingCollectInput {
  category?: unknown;
  phase?: unknown;
  role?: unknown;
  fieldNames?: unknown;
  eventCode?: unknown;
  recordId?: unknown;
  occurredAt?: unknown;
  contentBytes?: unknown;
  build?: ((admission: UnknownRecord) => unknown) | unknown;
}

interface PendingUsageBucket {
  tenantRef: string;
  bucketStartMs: number;
  counters: Record<string, number>;
}

/**
 * The shared producer facade over one durable sink. Constructed once per
 * sink (see `recordingProducerForPort`) so usage aggregation spans all
 * operations of the process; each operation still gets its own
 * `session(...)`.
 */
export function createRecordingProducer(options: RecordingProducerOptions = {}) {
  const sink = (options.sink || null) as UnknownRecord | null;
  const now: () => number = typeof options.now === "function" ? options.now : Date.now;
  const usageBucketMs: number = Number.isSafeInteger(options.usageBucketMs) && Number(options.usageBucketMs) >= 1000
    ? Number(options.usageBucketMs)
    : DEFAULT_USAGE_BUCKET_MS;
  const maxPendingUsageBuckets: number =
    Number.isSafeInteger(options.maxPendingUsageBuckets) && Number(options.maxPendingUsageBuckets) >= 1
      ? Number(options.maxPendingUsageBuckets)
      : DEFAULT_MAX_PENDING_USAGE_BUCKETS;
  const pendingUsage = new Map<string, PendingUsageBucket>();
  /**
   * Selection lookups are memoized per live policy object only: `policy()`
   * re-reads the sink on every call, so an off flip still surfaces a new
   * object identity and re-parses, while repeated collection points under
   * one revision never re-validate the same document.
   */
  const selectionsByPolicy = new WeakMap<UnknownRecord, Map<string, UnknownRecord | null>>();
  let closed = false;

  function iso(epochMs?: number): string {
    return new Date(epochMs === undefined ? now() : epochMs).toISOString();
  }

  /** The sink's live policy revision — never cached across a call. */
  function policy(): UnknownRecord | null {
    if (!sink || closed) return null;
    try {
      return (sink.getPolicy as () => UnknownRecord)() || null;
    } catch {
      return null;
    }
  }

  /** The live category selection under the current policy revision. */
  function selectionFor(category: unknown): UnknownRecord | null {
    const current = policy();
    if (!current) return null;
    let byCategory = selectionsByPolicy.get(current);
    if (!byCategory) {
      byCategory = new Map();
      selectionsByPolicy.set(current, byCategory);
    }
    const key = String(category ?? "");
    if (!byCategory.has(key)) {
      const selection = recordingCategorySelectionFor(current, key);
      byCategory.set(key, selection ? (selection as UnknownRecord) : null);
    }
    return byCategory.get(key) ?? null;
  }

  /**
   * The cheapest gate every producer-side accumulation must pass first:
   * whether the category is selected under the live revision. Callers use
   * this before maintaining any in-memory buffer so a disabled category
   * collects nothing — no serialization, no buffering, no copies.
   */
  function categoryEnabled(category: unknown): boolean {
    return selectionFor(category) !== null;
  }

  function usageOperationRef(bucket: PendingUsageBucket): string {
    return `usage.${sanitizeRecordingRef(bucket.tenantRef) || "local"}.${bucket.bucketStartMs}`;
  }

  function writeUsageBucket(bucket: PendingUsageBucket): boolean {
    const selection = selectionFor("usage");
    if (!selection) return true; // off: drop the buffered aggregate, never capture it
    const fieldAllow = new Set((selection.fieldAllow as readonly string[]) || []);
    const counters: Record<string, number> = {};
    for (const key of Object.keys(bucket.counters)) {
      if (fieldAllow.has(key)) counters[key] = bucket.counters[key];
    }
    if (Object.keys(counters).length === 0) return true; // nothing allowlisted: nothing captured
    const operationRef = usageOperationRef(bucket);
    let admission: UnknownRecord | null = null;
    try {
      admission = (sink!.admit as (input: UnknownRecord) => UnknownRecord | null)({
        tenantRef: bucket.tenantRef,
        operationRef,
        category: "usage",
        phase: "post_effect",
        fieldNames: Object.keys(counters)
      });
    } catch {
      return false; // sink unreachable: keep the bounded bucket for the next flush
    }
    if (!admission || admission.decision !== "admit") return true; // deny/shed: honest drop
    const recordId = deterministicRef("rec.usage.", bucket.tenantRef, bucket.bucketStartMs);
    const detail = { counters, bucketStart: iso(bucket.bucketStartMs) };
    const skeleton: UnknownRecord = {
      recordId,
      tenantRef: bucket.tenantRef,
      operationRef,
      category: "usage",
      evidenceClass: "selected_history",
      policyRevision: Number(admission.policyRevision),
      sinkRef: sink!.sinkId,
      phase: "post_effect",
      occurredAt: iso(),
      detail,
      indexBytes: 1,
      contentBytes: 0
    };
    const indexBytes = Buffer.byteLength(canonicalJson(skeleton), "utf8");
    skeleton.indexBytes = indexBytes;
    const indexBytesFinal = Buffer.byteLength(canonicalJson(skeleton), "utf8");
    let record: UnknownRecord;
    try {
      record = createRecordingRecord({ ...skeleton, indexBytes: indexBytesFinal }) as UnknownRecord;
    } catch {
      return true; // producer-side shape bug: do not spin on it
    }
    try {
      (sink!.writeRecord as (record: unknown) => UnknownRecord)(record);
      return true;
    } catch {
      return false; // transient sink failure: bucket stays buffered, bounded
    }
  }

  /**
   * Accumulate aggregate usage counters for one tenant+bucket. This is the
   * *only* buffering the producer performs, and it is gated on the live
   * `usage` selection so an off flip stops accumulation, not only the write.
   */
  function noteUsage(input: UnknownRecord = {}): boolean {
    if (!sink || closed) return false;
    const tenantRef = sanitizeRecordingRef(input.tenantRef) || "tenant.local";
    if (!categoryEnabled("usage")) return false;
    const entries = normalizeCounterEntries(input.counters);
    if (entries.length === 0) return false;
    const bucketStartMs = Math.floor(now() / usageBucketMs) * usageBucketMs;
    const key = `${tenantRef}|${bucketStartMs}`;
    let bucket = pendingUsage.get(key);
    if (!bucket) {
      if (pendingUsage.size >= maxPendingUsageBuckets) {
        for (const [evictKey, evictBucket] of pendingUsage) {
          if (evictKey === key || evictBucket.bucketStartMs >= bucketStartMs) continue;
          pendingUsage.delete(evictKey); // oldest non-current bucket is dropped, never captured
          break;
        }
      }
      bucket = {
        tenantRef,
        bucketStartMs,
        counters: {}
      };
      pendingUsage.set(key, bucket);
    }
    for (const [counter, delta] of entries) {
      if (Object.keys(bucket.counters).length >= USAGE_COUNTER_LIMIT
          && bucket.counters[counter] === undefined) continue;
      bucket.counters[counter] = (bucket.counters[counter] || 0) + delta;
    }
    flushStaleUsage();
    return true;
  }

  /** Write aggregate records for every bucket that has rolled past its window. */
  function flushStaleUsage(): number {
    const currentBucket = Math.floor(now() / usageBucketMs) * usageBucketMs;
    let flushed = 0;
    for (const [key, bucket] of [...pendingUsage]) {
      if (bucket.bucketStartMs >= currentBucket) continue;
      if (writeUsageBucket(bucket)) {
        pendingUsage.delete(key);
        flushed += 1;
      }
    }
    return flushed;
  }

  /** Force-flush every pending bucket (e.g. sink owner shutdown). */
  function flushUsage(input: UnknownRecord = {}): number {
    const force = input.force === true;
    let flushed = 0;
    for (const [key, bucket] of [...pendingUsage]) {
      if (!force) {
        const currentBucket = Math.floor(now() / usageBucketMs) * usageBucketMs;
        if (bucket.bucketStartMs >= currentBucket) continue;
      }
      if (writeUsageBucket(bucket)) {
        pendingUsage.delete(key);
        flushed += 1;
      }
    }
    return flushed;
  }

  function pendingUsageBuckets(): number {
    return pendingUsage.size;
  }

  /** Truthful outcome derivation for one operation+category, live revision. */
  function outcomeFor(input: UnknownRecord = {}): UnknownRecord | null {
    if (!sink || closed) return null;
    try {
      return (sink.outcomeFor as (value: UnknownRecord) => UnknownRecord | null)(input) || null;
    } catch {
      return null;
    }
  }

  /**
   * Recording-only reconciliation for obligations still owed by an
   * operation. `record` (when supplied by the caller) is retried through the
   * sink's own reconcile path under the current revision; no effect is ever
   * replayed from this path (`RECORDING_RECONCILE_REPLAYS_EFFECT` is false).
   */
  function reconcileOperation(input: UnknownRecord = {}): UnknownRecord[] {
    if (!sink || closed) return [];
    const operationRef = sanitizeRecordingRef(input.operationRef);
    if (!operationRef) return [];
    const categories = new Set(
      Array.isArray(input.categories) && input.categories.length > 0
        ? input.categories.map(String)
        : RECORDING_CATEGORIES
    );
    let pending: UnknownRecord[] = [];
    try {
      pending = ((sink.pendingObligations as () => UnknownRecord[])() || [])
        .filter((row) => String(row.operationRef) === operationRef && categories.has(String(row.category)));
    } catch {
      return [];
    }
    const outcomes: UnknownRecord[] = [];
    for (const obligation of pending) {
      const category = String(obligation.category);
      let record: unknown;
      if (typeof input.buildRecord === "function") {
        try {
          record = input.buildRecord({ category, obligation, operationRef });
        } catch {
          record = undefined;
        }
      }
      try {
        const outcome = (sink.reconcile as (value: UnknownRecord) => UnknownRecord | null)({
          operationRef,
          category,
          operationStatus: input.operationStatus,
          ...(record !== undefined && record !== null ? { record } : {})
        });
        if (outcome) outcomes.push(outcome);
      } catch {
        // The obligation stays visibly owed; reconciliation reports, never hides.
      }
    }
    return outcomes;
  }

  function pendingObligationsFor(operationRef: unknown): UnknownRecord[] {
    if (!sink || closed) return [];
    const ref = sanitizeRecordingRef(operationRef);
    if (!ref) return [];
    try {
      return ((sink.pendingObligations as () => UnknownRecord[])() || [])
        .filter((row) => String(row.operationRef) === ref);
    } catch {
      return [];
    }
  }

  /**
   * Content custody pass-through used inside a `build` callback (i.e. only
   * after `admit`). The sink re-checks the live `content` selection, so an
   * off flip between admission and build still refuses bytes here.
   */
  function putArtifact(input: UnknownRecord = {}): UnknownRecord | null {
    if (!sink || closed || typeof sink.putArtifact !== "function") return null;
    return (sink.putArtifact as (value: UnknownRecord) => UnknownRecord)(input) || null;
  }

  function close(): void {
    if (closed) return;
    try {
      flushUsage({ force: true });
    } catch {
      // Producer shutdown never fails the owner; pending buckets drop unrecorded.
    }
    closed = true;
    pendingUsage.clear();
  }

  /* -------------------------------------------------------------- *
   * Per-operation recording session.                                  *
   * -------------------------------------------------------------- */

  function createSession(sessionInput: UnknownRecord = {}) {
    const operationRef = sanitizeRecordingRef(sessionInput.operationRef)
      || deterministicRef("op.", randomUUID());
    const tenantRef = sanitizeRecordingRef(sessionInput.tenantRef) || "tenant.local";
    const role = sessionInput.role === undefined ? undefined : String(sessionInput.role || "");
    const touched = new Set<string>();
    const failures = new Map<string, { code: string; phase: string }>();
    const openReservationIds: string[] = [];
    let shedAtAdmission = new Set<string>();
    const REQUIRED_SET: ReadonlySet<string> = new Set(RECORDING_REQUIRED_OBLIGATION_CATEGORIES);

    /**
     * Obligations can only exist for `required_before_effect` categories —
     * the sink registers them on required terminal failure or a mid-flight
     * policy off. A session that never touched one (and never failed a
     * required write) cannot owe anything, so the durable pending scan is
     * skipped on the common optional-only path.
     */
    function sessionPendingObligations(): UnknownRecord[] {
      for (const category of new Set<string>([...touched, ...failures.keys()])) {
        if (REQUIRED_SET.has(category)) return pendingObligationsFor(operationRef);
      }
      return [];
    }

    function releaseReservation(admission: UnknownRecord | null): void {
      const admissionId = String(admission?.admissionId || "");
      if (!admissionId || admission?.decision !== "admit") return;
      if (admission.obligation !== "required_before_effect" || admission.phase !== "pre_effect") return;
      try {
        if ((sink!.releaseAdmission as (id: unknown) => boolean)(admissionId)) {
          const index = openReservationIds.indexOf(admissionId);
          if (index >= 0) openReservationIds.splice(index, 1);
        }
      } catch {
        // Reservation expiry/policy flips release it durably regardless.
      }
    }

    const POLICY_REFUSAL_CODES: ReadonlySet<string> = new Set([
      "category_disabled",
      "policy_superseded",
      "role_unauthorized",
      "forbidden_field",
      "field_not_selected",
      "phase_mismatch",
      "destination_unselected",
      "recording_policy_required",
      "recording_artifact_unresolved",
      "recording_artifact_bytes_mismatch",
      "recording_artifact_missing",
      "recording_artifact_corrupt"
    ]);

    function failureFor(error: unknown, phase: string): { code: string; phase: string } {
      const code = errorCode(error);
      return {
        code: SINK_FAILURE_CODES.has(code) ? code : "sink_write_failed",
        phase: phase === "pre_effect" ? "pre_effect" : phase === "settlement" ? "settlement" : "post_effect"
      };
    }

    /** Errors carrying a policy/custody refusal code are refusals, not sink failures. */
    function refusalCode(error: unknown): string | null {
      const code = errorCode(error);
      return POLICY_REFUSAL_CODES.has(code) ? code : null;
    }

    /**
     * Build + write one record behind an existing `admit` decision. The
     * caller's `build` runs only after admission — disabled or refused
     * categories never reach serialization.
     */
    function writeAdmittedRecord(
      admission: UnknownRecord,
      input: RecordingCollectInput
    ): UnknownRecord {
      const category = String(input.category);
      const phase = String(input.phase === "pre_effect" ? "pre_effect" : "post_effect");
      const result: UnknownRecord = {
        collected: false,
        decision: "admit",
        reason: "none",
        admission,
        recordId: "",
        policyRevision: Number(admission.policyRevision)
      };
      let built: unknown;
      try {
        built = typeof input.build === "function"
          ? (input.build as (admission: UnknownRecord) => unknown)(admission)
          : input.build;
      } catch (error) {
        // e.g. an artifact custody put racing an off flip — a refusal, not
        // a sink failure; anything else is a producer-side fault.
        const refused = refusalCode(error);
        if (refused) {
          result.refused = refused;
        } else {
          result.failure = failureFor(error, phase);
          failures.set(category, result.failure as { code: string; phase: string });
        }
        releaseReservation(admission);
        return result;
      }
      const builtRecord = asRecord(built);
      const detail = built && typeof built === "object" && Object.hasOwn(builtRecord, "detail")
        ? builtRecord.detail
        : built;
      if (detail === null || detail === undefined) {
        result.skipped = true;
        releaseReservation(admission);
        return result;
      }
      const contentBytes = Number(
        Object.hasOwn(builtRecord, "contentBytes") ? builtRecord.contentBytes : input.contentBytes
      ) || 0;
      const recordId = sanitizeRecordingRef(input.recordId)
        || deterministicRef("rec.", operationRef, category, phase);
      const occurredAt = typeof input.occurredAt === "string" && input.occurredAt
        ? input.occurredAt
        : iso();
      const skeleton: UnknownRecord = {
        recordId,
        tenantRef,
        operationRef,
        category,
        evidenceClass: "selected_history",
        policyRevision: Number(admission.policyRevision),
        sinkRef: String((sink as UnknownRecord).sinkId || ""),
        phase,
        occurredAt,
        detail,
        indexBytes: 1,
        contentBytes
      };
      skeleton.indexBytes = Buffer.byteLength(canonicalJson(skeleton), "utf8");
      skeleton.indexBytes = Buffer.byteLength(canonicalJson(skeleton), "utf8");
      let record: UnknownRecord;
      try {
        record = createRecordingRecord(skeleton) as UnknownRecord;
      } catch {
        result.failure = { code: "sink_write_failed", phase };
        failures.set(category, result.failure as { code: string; phase: string });
        releaseReservation(admission);
        return result;
      }
      try {
        const write = (sink!.writeRecord as (value: unknown) => UnknownRecord)(record);
        result.collected = write?.status === "written" || write?.status === "replayed";
        result.writeStatus = String(write?.status || "");
        result.recordId = recordId;
        touched.add(category);
      } catch (error) {
        const code = errorCode(error);
        if (SINK_FAILURE_CODES.has(code)) {
          result.failure = { code, phase };
          failures.set(category, result.failure as { code: string; phase: string });
        } else {
          // category_disabled / policy_superseded / field_not_selected /
          // artifact custody refusals: a later revision outranks capture.
          result.refused = code || "category_disabled";
        }
        releaseReservation(admission);
      }
      return result;
    }

    /**
     * One gated collection point: admit under the live revision first, then
     * — only on `admit` — build and write. Every failure is isolated on the
     * result so optional categories can never fault the operation.
     */
    function collect(input: RecordingCollectInput = {}): UnknownRecord {
      const category = String(input.category || "");
      const phase = input.phase === "pre_effect" ? "pre_effect" : "post_effect";
      const result: UnknownRecord = {
        collected: false,
        decision: "unavailable",
        reason: "sink_unavailable",
        recordId: "",
        policyRevision: 0
      };
      if (!sink || closed || !RECORDING_CATEGORIES.includes(category as never)) {
        result.reason = "recording_unavailable";
        return result;
      }
      let admission: UnknownRecord | null = null;
      try {
        admission = (sink.admit as (value: UnknownRecord) => UnknownRecord | null)({
          tenantRef,
          operationRef,
          category,
          phase,
          role,
          fieldNames: input.fieldNames,
          eventCode: input.eventCode
        });
      } catch (error) {
        const refused = refusalCode(error);
        if (refused) {
          result.decision = "deny";
          result.reason = refused;
          result.refused = refused;
        } else {
          result.failure = failureFor(error, phase);
          failures.set(category, result.failure as { code: string; phase: string });
        }
        return result;
      }
      if (!admission) {
        result.decision = "unavailable";
        result.reason = "recording_unavailable";
        return result;
      }
      result.decision = String(admission.decision);
      result.reason = String(admission.reason || "none");
      result.policyRevision = Number(admission.policyRevision) || 0;
      result.admission = admission;
      if (admission.decision !== "admit") {
        if (admission.decision === "shed") shedAtAdmission.add(category);
        if (admission.decision === "deny" || admission.decision === "shed") {
          result.refused = String(admission.reason || "");
        }
        return result;
      }
      if (admission.obligation === "required_before_effect" && phase === "pre_effect") {
        openReservationIds.push(String(admission.admissionId));
      }
      return writeAdmittedRecord(admission, input);
    }

    /**
     * The pre-effect collection point for required categories. Only
     * `required_before_effect` selections are admitted here — optional
     * categories defer to post-effect collection so they never pay a
     * second durable write for a start record no obligation needs. Every
     * required category admits first so a `reject` cannot leave a sibling
     * half-reserved; only then are admitted start records written. A denied
     * or rejected required category returns `{ ok: false }` — the caller
     * must refuse the effect.
     */
    function admitBeforeEffect(input: UnknownRecord = {}): UnknownRecord {
      const report: UnknownRecord = {
        ok: true,
        operationRef,
        blocked: null,
        admissions: {},
        results: {}
      };
      if (!sink || closed) return report;
      const current = policy();
      if (!current) return report; // no policy → nothing selected → nothing required
      const builders = asRecord(input.builders);
      const plan: { category: string; build: unknown }[] = [];
      for (const category of RECORDING_REQUIRED_OBLIGATION_CATEGORIES) {
        const selection = selectionFor(category);
        if (!selection) continue; // off under the live revision: no collection point
        if (String(selection.obligation) !== "required_before_effect") continue; // optional: post-effect only
        plan.push({ category, build: builders[category] });
      }
      const admitted: { category: string; build: unknown; admission: UnknownRecord }[] = [];
      let blocked: UnknownRecord | null = null;
      for (const item of plan) {
        let admission: UnknownRecord | null = null;
        try {
          admission = (sink.admit as (value: UnknownRecord) => UnknownRecord | null)({
            tenantRef,
            operationRef,
            category: item.category,
            phase: "pre_effect",
            role
          });
        } catch (error) {
          blocked = {
            category: item.category,
            decision: "reject",
            reason: "recording_unavailable",
            errorCode: errorCode(error) || "sink_unavailable"
          };
          continue;
        }
        if (!admission) {
          blocked = { category: item.category, decision: "reject", reason: "recording_unavailable" };
          continue;
        }
        (report.admissions as UnknownRecord)[item.category] = admission;
        touched.add(item.category);
        if (admission.decision !== "admit") {
          blocked = {
            category: item.category,
            decision: String(admission.decision),
            reason: String(admission.reason || "recording_unavailable"),
            admission
          };
          continue;
        }
        openReservationIds.push(String(admission.admissionId));
        admitted.push({ ...item, admission });
      }
      if (blocked) {
        for (const item of admitted) releaseReservation(item.admission);
        report.ok = false;
        report.blocked = blocked;
        report.reasonCode = "recording_unavailable";
        return report;
      }
      for (const item of admitted) {
        const result = writeAdmittedRecord(item.admission, {
          category: item.category,
          phase: "pre_effect",
          build: item.build
        });
        (report.results as UnknownRecord)[item.category] = result;
        if (result.collected !== true) {
          for (const rest of admitted) releaseReservation(rest.admission);
          report.ok = false;
          report.blocked = {
            category: item.category,
            decision: "reject",
            reason: "recording_unavailable",
            result
          };
          report.reasonCode = "recording_unavailable";
          return report;
        }
      }
      return report;
    }

    /**
     * Post-effect settlement: one gated collect per offered category, usage
     * accumulation, then truthful outcome derivation for every category the
     * session touched or still owes. Never throws — settlement cannot turn
     * a healthy effect into a failure or rewrite it as not started.
     */
    function settle(input: UnknownRecord = {}): UnknownRecord {
      const operationStatus = String(input.operationStatus || "status_unavailable");
      const results: UnknownRecord = {};
      const outcomes: UnknownRecord = {};
      const builders = asRecord(input.builders);
      if (sink && !closed) {
        for (const category of RECORDING_CATEGORIES) {
          if (category === "usage") continue;
          const builder = builders[category];
          if (builder === undefined || builder === null) continue;
          const descriptor = typeof builder === "function" ? { build: builder } : asRecord(builder);
          const build = typeof descriptor.build === "function" ? descriptor.build : null;
          if (!build) continue;
          try {
            results[category] = collect({
              category,
              phase: "post_effect",
              role,
              fieldNames: descriptor.fieldNames,
              eventCode: descriptor.eventCode,
              recordId: descriptor.recordId,
              occurredAt: descriptor.occurredAt,
              contentBytes: descriptor.contentBytes,
              build
            });
          } catch (error) {
            results[category] = {
              collected: false,
              decision: "unavailable",
              failure: failureFor(error, "post_effect")
            };
            failures.set(category, { code: "sink_write_failed", phase: "post_effect" });
          }
        }
        if (input.usageCounters && typeof input.usageCounters === "object") {
          try {
            noteUsage({ tenantRef, operationRef, counters: input.usageCounters });
          } catch {
            // Usage accumulation is best-effort and never faults the operation.
          }
        }
      }
      const reported = new Set<string>([...touched, ...Object.keys(results)]);
      for (const category of reported) {
        if (!RECORDING_CATEGORIES.includes(category as never)) continue;
        const outcome = outcomeFor({
          operationRef,
          category,
          operationStatus,
          shedAtAdmission: shedAtAdmission.has(category) ? true : undefined,
          sinkFailure: failures.get(category) || null
        });
        if (outcome) outcomes[category] = outcome;
      }
      for (const admissionId of [...openReservationIds]) {
        try {
          (sink?.releaseAdmission as ((id: unknown) => boolean) | undefined)?.(admissionId);
        } catch {
          // Expiry and policy flips release reservations durably.
        }
      }
      openReservationIds.length = 0;
      return Object.freeze({
        operationRef,
        operationStatus,
        results: Object.freeze(results),
        outcomes: Object.freeze(outcomes),
        pendingObligations: Object.freeze(sessionPendingObligations())
      });
    }

    /**
     * Settlement for obligations captured before an off flip or a transient
     * failure: retry the owed post-effect records under the *current* policy
     * (a still-disabled category stays pending; a re-enabled or still-required
     * one clears). Never replays the effect — this is recording-only work.
     */
    function settlePending(input: UnknownRecord = {}): UnknownRecord {
      const owed = sessionPendingObligations();
      const results: UnknownRecord = {};
      const outcomes: UnknownRecord = {};
      const builders = asRecord(input.builders);
      for (const obligation of owed) {
        const category = String(obligation.category);
        const builder = builders[category];
        if (typeof builder === "function") {
          results[category] = collect({ category, phase: "post_effect", role, build: builder });
        } else {
          results[category] = { collected: false, pending: true, reason: String(obligation.reason || "") };
        }
        const outcome = outcomeFor({
          operationRef,
          category,
          operationStatus: input.operationStatus
        });
        if (outcome) outcomes[category] = outcome;
      }
      return Object.freeze({ operationRef, results: Object.freeze(results), outcomes: Object.freeze(outcomes) });
    }

    return Object.freeze({
      operationRef,
      tenantRef,
      collect,
      admitBeforeEffect,
      settle,
      settlePending,
      putArtifact,
      pendingObligations: () : UnknownRecord[] => sessionPendingObligations(),
      outcomeFor: (input: UnknownRecord = {}) : UnknownRecord | null =>
        outcomeFor({ ...input, operationRef }),
      touched: () : string[] => [...touched]
    });
  }

  return Object.freeze({
    protocolVersion: RECORDING_PRODUCER_PROTOCOL_VERSION,
    policy,
    selectionFor,
    categoryEnabled,
    session: createSession,
    noteUsage,
    flushUsage,
    flushStaleUsage,
    pendingUsageBuckets,
    outcomeFor,
    reconcileOperation,
    pendingObligationsFor,
    putArtifact,
    close
  });
}

/**
 * Resolve a shared producer for a sink port. Dispatch surfaces may carry a
 * RecordingSinkStore (or any port with `admit`/`writeRecord`/`getPolicy`) or
 * an already-created producer; both resolve to one producer per sink per
 * process so usage aggregation is shared and per-operation work stays
 * session-scoped.
 */
const producersBySink = new WeakMap<object, unknown>();

export type RecordingProducer = ReturnType<typeof createRecordingProducer>;
export type RecordingProducerSession = ReturnType<RecordingProducer["session"]>;

export function recordingProducerForPort(
  port: unknown,
  options: RecordingProducerOptions = {}
): RecordingProducer | null {
  if (!port || typeof port !== "object") return null;
  const candidate = port as UnknownRecord;
  if (typeof candidate.session === "function" && typeof candidate.noteUsage === "function") {
    return candidate as unknown as RecordingProducer;
  }
  if (
    typeof candidate.admit === "function" &&
    typeof candidate.writeRecord === "function" &&
    typeof candidate.getPolicy === "function"
  ) {
    let producer = producersBySink.get(candidate as object);
    if (!producer) {
      producer = createRecordingProducer({ ...options, sink: port });
      producersBySink.set(candidate as object, producer);
    }
    return producer as RecordingProducer;
  }
  return null;
}
