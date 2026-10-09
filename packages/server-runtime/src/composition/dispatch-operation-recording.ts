/**
 * dispatch-operation-recording.ts
 *
 * Binds one operation dispatch to the shared recording producer and maps
 * dispatch facts onto the five selected-history categories. This module is
 * *selected history only*: the mandatory lifecycle proof and minimal
 * correctness state keep their own owners and are never gated here.
 *
 * Category mapping per dispatch:
 * - `execution_history` — `started` at the pre-effect collection point,
 *   `completed`/`failed` at settlement. An `in_doubt` operation writes no
 *   fabricated terminal event; a required obligation stays visibly pending
 *   instead (`RECORDING_FULL_STORE_GUARANTEES_TERMINAL_AUDIT` is false).
 * - `governance_history` — the `policy_decision` (or `approval`) that
 *   authorized the effect, referencing the dispatch authorization decision.
 * - `content` — only fields named by the policy `fieldAllow` ∩ actual input
 *   keys; bytes go to artifact custody and the record carries
 *   `contentDigest` + `artifactRefs` only.
 * - `usage` — per-dispatch counters accumulated into the producer's
 *   tenant+bucket aggregate (no per-request rows).
 * - `diagnostics` — allowlisted event codes for denied/failed/in_doubt
 *   outcomes and post-effect recording write failures.
 */
import {
  recordingProducerForPort,
  sanitizeRecordingRef
} from "@meshrix/foundation/recording/producer";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { firstText, compactStrings } from "./dispatch-operation-support.ts";

type UnknownRecord = Record<string, any>;

const DURATION_BUCKETS: readonly [number, string][] = Object.freeze([
  [10, "lt_10ms"],
  [100, "lt_100ms"],
  [1_000, "lt_1s"],
  [10_000, "lt_10s"]
]);

function durationBucketFor(durationMs: number): string {
  for (const [bound, bucket] of DURATION_BUCKETS) {
    if (durationMs < bound) return bucket;
  }
  return "gte_10s";
}

function effectClassFor(operation: UnknownRecord = {}): string {
  if (operation.readOnly === true) return "read";
  if (operation.destructive === true) return "destructive";
  const risk = String(operation.safety?.risk || "").toLocaleLowerCase();
  if (risk === "read" || risk === "read_only" || risk === "safe") return "read";
  if (risk === "safe_write" || risk === "write" || risk === "medium") return "safe_write";
  if (risk === "repair_write" || risk === "destructive" || risk === "high") return "destructive";
  return "unknown";
}

const RECORDING_STATUS: Readonly<Record<string, string>> = Object.freeze({
  ok: "succeeded",
  succeeded: "succeeded",
  failed: "failed",
  denied: "not_started",
  not_started: "not_started",
  in_doubt: "in_doubt",
  cancelled: "cancelled"
});

const NOOP_RECORDER: UnknownRecord = Object.freeze({
  admitBeforeEffect: (): UnknownRecord => Object.freeze({ ok: true }),
  settle: (): unknown => null,
  report: (): UnknownRecord => Object.freeze({ operationRef: "", outcomes: Object.freeze({}) }),
  session: null
});

/**
 * The per-dispatch recording recorder. `recordingSink` accepts the durable
 * sink port or an already-shared producer (`recordingProducerForPort`
 * normalizes either); a missing/closed port yields the no-op recorder.
 */
export function createDispatchOperationRecorder({
  recordingSink = null,
  operation,
  operationInput = {},
  transport,
  method,
  url,
  request,
  traceContext,
  getActor = () : any => null,
  getAuthSession = () : any => null
}: Record<string, any> = {}) : any {
  const producer: any = recordingProducerForPort(recordingSink);
  if (!producer || !operation?.id) return NOOP_RECORDER;

  const operationRef = sanitizeRecordingRef(
    `op.${operation.id}.${firstText(traceContext?.requestId, traceContext?.traceId)}`
  ) || `op.${sanitizeRecordingRef(operation.id)}.${Date.now().toString(36)}`;
  const subject = (() : UnknownRecord => {
    const actor: any = getActor();
    const authSession: any = getAuthSession();
    const user: any = authSession?.user || actor?.user || actor || {};
    return {
      subjectId: firstText(user.subjectId, actor?.subjectId, user.userId, actor?.userId),
      tenantId: firstText(user.tenantId, actor?.tenantId, authSession?.tenantId),
      grantId: firstText(user.grantId, actor?.grantId)
    };
  })();
  const tenantRef = sanitizeRecordingRef(
    firstText(
      subject.tenantId,
      request?.__meshrixOperationRuntimeAuthorization?.subjectRef,
      "tenant.local"
    )
  ) || "tenant.local";
  const session: any = producer.session({ operationRef, tenantRef });
  const effectClass = effectClassFor(operation);
  const startedAtMs = Date.now();
  let lastSettlement: any = null;

  function decisionRef(): string {
    const authorization: any = request?.__meshrixOperationRuntimeAuthorization;
    return sanitizeRecordingRef(
      firstText(
        authorization?.policy?.decisionId,
        authorization?.decisionId,
        `decision.${operation.id}`
      )
    ) || `decision.${sanitizeRecordingRef(operation.id) || "operation"}`;
  }

  function authorityRefs(): string[] {
    const authorization: any = request?.__meshrixOperationRuntimeAuthorization;
    const refs = compactStrings([
      authorization?.grantRef,
      authorization?.subjectRef,
      subject.subjectId,
      subject.grantId,
      tenantRef
    ]).map((value?: any) : any => sanitizeRecordingRef(value)).filter(Boolean);
    return refs.length > 0 ? refs : ["authority.platform-policy"];
  }

  function governanceEvent(): string {
    const approved = Array.isArray(request?.__meshrixRiskControl?.gateRecords)
      && request.__meshrixRiskControl.gateRecords.some(
        (gate?: any) : any => gate?.decision === "allow"
          && /approve/iu.test(String(gate?.control?.controlId || gate?.controlId || ""))
      );
    return approved ? "approval" : "policy_decision";
  }

  function contentFields(): string[] {
    const selection: any = producer.selectionFor("content");
    if (!selection) return [];
    const allow = new Set<string>((selection.fieldAllow as readonly string[]) || []);
    if (!allow.size || !operationInput || typeof operationInput !== "object" || Array.isArray(operationInput)) {
      return [];
    }
    return Object.keys(operationInput).filter((key: string) : boolean => allow.has(key));
  }

  /**
   * The pre-effect collection point inside the dispatch lock: required
   * categories reserve durable capacity here — before the operation handler
   * can run — or the dispatch is refused `recording_unavailable`.
   */
  function admitBeforeEffect(): any {
    return session.admitBeforeEffect({
      builders: {
        execution_history: () : UnknownRecord => ({
          event: "started",
          effectClass,
          durationBucket: "not_applicable"
        }),
        governance_history: () : UnknownRecord => ({
          governanceEvent: governanceEvent(),
          decisionRef: decisionRef(),
          authorityRefs: authorityRefs()
        })
      }
    });
  }

  /**
   * Post-effect collection point: one gated collect per offered category,
   * then truthful outcome derivation. Called from the proof/audit
   * settlement funnel; must never throw.
   */
  function settle({ status = "", statusCode = 0, error = "" }: Record<string, any> = {}) : any {
    const operationStatus = RECORDING_STATUS[status] || "status_unavailable";
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const executionEvent: string | null = status === "ok" || status === "succeeded"
      ? "completed"
      : status === "failed" ? "failed" : null; // denied: never ran; in_doubt: owed, not fabricated
    const diagnosticsCode = firstText(
      status === "denied" ? "operation.dispatch.denied" : "",
      status === "failed" ? "operation.dispatch.failed" : "",
      status === "in_doubt" ? "operation.dispatch.in_doubt" : ""
    );
    const builders: Record<string, any> = {};
    if (executionEvent) {
      builders.execution_history = () : UnknownRecord => ({
        event: executionEvent,
        effectClass,
        durationBucket: durationBucketFor(durationMs)
      });
    }
    builders.governance_history = () : UnknownRecord => ({
      governanceEvent: governanceEvent(),
      decisionRef: decisionRef(),
      authorityRefs: authorityRefs()
    });
    builders.content = {
      fieldNames: contentFields(),
      build: () : UnknownRecord | null => {
        const names = contentFields();
        if (!names.length) return null;
        const captured: Record<string, any> = {};
        for (const name of names) captured[name] = operationInput[name];
        const bytes = Buffer.from(canonicalJson(captured), "utf8");
        // Custody re-checks the live policy: an off flip between the admit
        // above and this put throws `category_disabled` and captures nothing.
        const artifact = session.putArtifact({ bytes });
        if (!artifact?.artifactRef) return null;
        return {
          detail: {
            fieldNames: names,
            contentDigest: artifact.contentDigest,
            artifactRefs: [artifact.artifactRef]
          },
          contentBytes: artifact.byteSize
        };
      }
    };
    if (diagnosticsCode) {
      builders.diagnostics = {
        eventCode: diagnosticsCode,
        build: () : UnknownRecord => ({
          eventCode: diagnosticsCode,
          counters: { occurrences: 1 }
        })
      };
    }
    const usageCounters: Record<string, number> = {
      "operations.dispatched": 1,
      [`operations.${operationStatus}`]: 1
    };
    try {
      lastSettlement = session.settle({
        operationStatus,
        builders,
        usageCounters
      });
    } catch {
      lastSettlement = null; // recording settlement never faults the dispatch
    }
    if (request && typeof request === "object") {
      request.__meshrixRecordingReport = report();
    }
    return lastSettlement;
  }

  function report(): any {
    return Object.freeze({
      operationRef,
      tenantRef,
      outcomes: Object.freeze({ ...(lastSettlement?.outcomes || {}) }),
      pendingObligations: lastSettlement?.pendingObligations || []
    });
  }

  return Object.freeze({
    admitBeforeEffect,
    settle,
    report,
    session,
    operationRef,
    tenantRef
  });
}
