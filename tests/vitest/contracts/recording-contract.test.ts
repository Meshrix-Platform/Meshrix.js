import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  RECORDING_ADMISSION_DECISIONS,
  RECORDING_ADMITTED_REVISION_OVERRIDES_OFF,
  RECORDING_BLANKET_HISTORY_REQUIRED,
  RECORDING_CATEGORIES,
  RECORDING_ENABLE_BACKFILLS_PRIOR_CONTENT,
  RECORDING_EVIDENCE_CLASSES,
  RECORDING_FAILURE_UNDOES_EFFECT,
  RECORDING_HISTORY_IS_OPERATIONAL_STATE,
  RECORDING_KINDS,
  RECORDING_LIFECYCLE_SCHEMA_VERSION,
  RECORDING_MAY_STORE_REUSABLE_PERMIT,
  RECORDING_MINIMAL_CORRECTNESS_STATE,
  RECORDING_OBLIGATIONS,
  RECORDING_OFF_DELETES_CAPTURED_RECORDS,
  RECORDING_OPERATION_STATES,
  RECORDING_OPTIONAL_SHED_STOPS_WORK,
  RECORDING_OUTCOMES,
  RECORDING_POLICY_SCHEMA_VERSION,
  RECORDING_RECORDS_MAY_HOLD_SECRETS,
  RECORDING_RECONCILE_REPLAYS_EFFECT,
  RECORDING_REQUIRED_EVIDENCE,
  RECORDING_REQUIRED_OBLIGATION_CATEGORIES,
  RECORDING_SINK_REQUIRES_DURABLE,
  admitRecordingCategory,
  assertRecordingCorePrivacy,
  assertRecordingDisabledCollectsNothing,
  assertRecordingOutcomeHonest,
  assertRecordingPolicyChange,
  containsForbiddenRecordingKeys,
  createEmptyRecordingPolicy,
  createRecordingPolicy,
  parseRecordingCategorySelection,
  parseRecordingMessage,
  parseRecordingPolicy,
  parseRecordingRecord,
  parseRecordingSinkState,
  recordingAdmissionBlocksOperation,
  recordingCategoryDisabledBetween,
  recordingCategoryEnabled,
  recordingCategoryIsOperationalState,
  recordingCategoryObligation,
  recordingEvidenceClassIsPolicyGated,
  recordingMayReplayEffect,
  recordingObligationOutstanding,
  recordingOutcomeFor,
  recordingRecordCapturedUnderPolicy,
  recordingRoleAuthorized,
  recordingSettlementMayContinue
} from "../../../packages/contracts/src/recording/index.ts";

const PROJECT_ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const corpus: any = JSON.parse(fs.readFileSync(
  path.join(PROJECT_ROOT, "packages/contracts/src/fixtures/recording-corpus.json"),
  "utf8"
));

// Negative-vector credential fields are minted at run time so the published
// fixture carries no literal credential-shaped material.
const canned1 = ["not-a-real-token", "value"].join("-");
const canned2 = ["not-a-real", "secret"].join("-");
corpus.lifecycle.invalid.recordCarriesToken.detail.token = canned1;
corpus.lifecycle.invalid.outcomeSmugglesSecret.secret = canned2;

const fullPolicy: any = corpus.policy.valid["recording-policy-full"];
const requiredPolicy: any = corpus.policy.valid["recording-policy-required-execution"];
const emptyPolicy: any = corpus.policy.valid["recording-policy-empty"];
const sinkHealthy: any = corpus.state.sinkHealthy;
const sinkFull: any = corpus.state.sinkFull;
const sinkDown: any = corpus.state.sinkDown;

describe("enterprise recording contract", () : any => {
  it("freezes versioned schemas, categories, obligations and privacy invariants", () : any => {
    expect(RECORDING_POLICY_SCHEMA_VERSION).toBe("v0.0.1:recording:policy-1");
    expect(RECORDING_LIFECYCLE_SCHEMA_VERSION).toBe("v0.0.1:recording:lifecycle-1");
    expect([...RECORDING_CATEGORIES].sort()).toEqual([
      "content",
      "diagnostics",
      "execution_history",
      "governance_history",
      "usage"
    ]);
    expect([...RECORDING_OBLIGATIONS].sort()).toEqual(["optional", "required_before_effect"]);
    expect([...RECORDING_REQUIRED_OBLIGATION_CATEGORIES].sort()).toEqual([
      "execution_history",
      "governance_history"
    ]);
    expect([...RECORDING_EVIDENCE_CLASSES].sort()).toEqual([
      "minimal_correctness",
      "required_evidence",
      "selected_history"
    ]);
    expect([...RECORDING_ADMISSION_DECISIONS].sort()).toEqual(["admit", "deny", "reject", "shed"]);
    expect([...RECORDING_OUTCOMES].sort()).toEqual([
      "not_recorded",
      "partially_recorded",
      "recorded",
      "recording_degraded",
      "shed",
      "terminal_record_pending"
    ]);
    expect(RECORDING_BLANKET_HISTORY_REQUIRED).toBe(false);
    expect(RECORDING_RECORDS_MAY_HOLD_SECRETS).toBe(false);
    expect(RECORDING_MAY_STORE_REUSABLE_PERMIT).toBe(false);
    expect(RECORDING_ENABLE_BACKFILLS_PRIOR_CONTENT).toBe(false);
    expect(RECORDING_OFF_DELETES_CAPTURED_RECORDS).toBe(false);
    expect(RECORDING_HISTORY_IS_OPERATIONAL_STATE).toBe(false);
    expect(RECORDING_SINK_REQUIRES_DURABLE).toBe(true);
    expect(RECORDING_FAILURE_UNDOES_EFFECT).toBe(false);
    expect(RECORDING_RECONCILE_REPLAYS_EFFECT).toBe(false);
    expect(RECORDING_OPTIONAL_SHED_STOPS_WORK).toBe(false);
    expect(RECORDING_ADMITTED_REVISION_OVERRIDES_OFF).toBe(false);
    expect(RECORDING_MINIMAL_CORRECTNESS_STATE.map((item: any) : any => item.item).sort()).toEqual([
      "execution_intent",
      "grant_revocation",
      "outcome_reconciliation",
      "replay_fence"
    ]);
    expect(RECORDING_REQUIRED_EVIDENCE.map((item: any) : any => item.item)).toEqual(["lifecycle_proof"]);
  });

  it("parses every valid policy and rejects every invalid policy in the neutral corpus", () : any => {
    for (const [name, policy] of Object.entries(corpus.policy.valid)) {
      const parsed: any = parseRecordingPolicy(policy);
      expect(parsed, name).toBeTruthy();
      expect(createRecordingPolicy(policy), name).toBeTruthy();
    }
    for (const [name, policy] of Object.entries(corpus.policy.invalid)) {
      expect(parseRecordingPolicy(policy), name).toBeNull();
    }
    expect(() : any => createRecordingPolicy({ kind: "recording-policy" })).toThrow(TypeError);
    expect(containsForbiddenRecordingKeys(corpus.policy.invalid.policySelectionSmugglesSecret)).toBe(true);
    expect(containsForbiddenRecordingKeys(fullPolicy)).toBe(false);
  });

  it("enables nothing under an empty selection and denies before any collection", () : any => {
    const parsed: any = parseRecordingPolicy(emptyPolicy);
    expect(parsed.categories).toEqual({});
    for (const category of RECORDING_CATEGORIES) {
      expect(recordingCategoryEnabled(emptyPolicy, category), category).toBe(false);
      expect(recordingCategoryObligation(emptyPolicy, category), category).toBeNull();
      const admission: any = admitRecordingCategory({ policy: emptyPolicy, category, phase: "post_effect" });
      expect(admission.decision, category).toBe("deny");
      expect(admission.reason, category).toBe("category_disabled");
      expect(assertRecordingDisabledCollectsNothing(emptyPolicy, category), category).toBe(true);
    }
    expect(() : any => assertRecordingDisabledCollectsNothing(fullPolicy, "usage")).toThrow();
  });

  it("keeps role authority independent per category and per access kind", () : any => {
    expect(recordingRoleAuthorized(fullPolicy, "content", "role.rec.auditor", "read")).toBe(true);
    expect(recordingRoleAuthorized(fullPolicy, "content", "role.rec.auditor", "configure")).toBe(false);
    expect(recordingRoleAuthorized(fullPolicy, "usage", "role.rec.auditor", "read")).toBe(false);
    expect(recordingRoleAuthorized(fullPolicy, "usage", "role.rec.ops", "read")).toBe(true);
    expect(recordingRoleAuthorized(fullPolicy, "usage", "role.rec.ops", "configure")).toBe(false);
    expect(recordingRoleAuthorized(fullPolicy, "usage", "role.rec.admin", "configure")).toBe(true);
    expect(recordingRoleAuthorized(fullPolicy, "telemetry", "role.rec.admin", "read")).toBe(false);
    expect(recordingRoleAuthorized(fullPolicy, "usage", "role.rec.ops", "delete")).toBe(false);
    const denied: any = admitRecordingCategory({
      policy: fullPolicy,
      category: "usage",
      phase: "post_effect",
      role: "role.rec.auditor"
    });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toBe("role_unauthorized");
  });

  it("publishes policy revisions atomically and only for authorized configurers", () : any => {
    const next: any = corpus.state.policyNextDisablesContent;
    const admitted: any = assertRecordingPolicyChange(fullPolicy, next, "role.rec.admin");
    expect(admitted.policyRevision).toBe(4);
    expect(recordingCategoryDisabledBetween(fullPolicy, next, "content")).toBe(true);
    expect(recordingCategoryDisabledBetween(fullPolicy, next, "usage")).toBe(false);
    expect(() : any => assertRecordingPolicyChange(fullPolicy, next, "role.rec.auditor")).toThrow(
      /RECORDING_POLICY_CHANGE_DENIED/
    );
    expect(() : any => assertRecordingPolicyChange(
      fullPolicy,
      { ...next, policyRevision: 3 },
      "role.rec.admin"
    )).toThrow(/RECORDING_POLICY_REVISION_NOT_ADVANCED/);
    expect(() : any => assertRecordingPolicyChange(
      fullPolicy,
      { ...next, policyId: "pol.rec.other" },
      "role.rec.admin"
    )).toThrow(/RECORDING_POLICY_IDENTITY_CHANGED/);
    expect(() : any => assertRecordingPolicyChange(fullPolicy, { kind: "other" }, "role.rec.admin")).toThrow();
  });

  it("lets off win over an admitted earlier revision at every collection point", () : any => {
    const next: any = corpus.state.policyNextDisablesContent;
    for (const phase of ["pre_effect", "post_effect"]) {
      const admission: any = admitRecordingCategory({ policy: next, category: "content", phase });
      expect(admission.decision, phase).toBe("deny");
      expect(admission.reason, phase).toBe("category_disabled");
    }
    const stale: any = corpus.state.recordStaleRevision;
    expect(parseRecordingRecord(stale)).toBeTruthy();
    // Settlement of an already-captured record may continue; new capture may not.
    expect(recordingSettlementMayContinue(stale, next)).toBe(true);
    expect(recordingRecordCapturedUnderPolicy(stale, next)).toBe(false);
    expect(recordingRecordCapturedUnderPolicy(
      corpus.lifecycle.valid["recording-record-execution-started"],
      fullPolicy
    )).toBe(true);
  });

  it("keeps selected history distinct from minimal correctness and required evidence", () : any => {
    for (const category of RECORDING_CATEGORIES) {
      expect(recordingCategoryIsOperationalState(category), category).toBe(false);
    }
    expect(recordingCategoryIsOperationalState("execution_intent")).toBe(true);
    expect(recordingCategoryIsOperationalState("replay_fence")).toBe(true);
    expect(recordingEvidenceClassIsPolicyGated("selected_history")).toBe(true);
    expect(recordingEvidenceClassIsPolicyGated("minimal_correctness")).toBe(false);
    expect(recordingEvidenceClassIsPolicyGated("required_evidence")).toBe(false);
    expect(parseRecordingMessage(corpus.lifecycle.invalid.admissionRelabeledOperational)).toBeNull();
  });

  it("parses every valid lifecycle message and covers every kind", () : any => {
    const kinds: any[] = [];
    for (const [name, message] of Object.entries(corpus.lifecycle.valid)) {
      const parsed: any = parseRecordingMessage(message);
      expect(parsed, name).toBeTruthy();
      kinds.push((parsed as any).kind);
    }
    expect([...new Set<any>(kinds)].sort()).toEqual([...RECORDING_KINDS].sort());
  });

  it("rejects every invalid lifecycle message in the neutral corpus", () : any => {
    for (const [name, message] of Object.entries(corpus.lifecycle.invalid)) {
      expect(parseRecordingMessage(message), name).toBeNull();
    }
    expect(containsForbiddenRecordingKeys(corpus.lifecycle.invalid.recordCarriesToken)).toBe(true);
    expect(containsForbiddenRecordingKeys(corpus.lifecycle.invalid.recordCarriesPayload)).toBe(true);
    expect(containsForbiddenRecordingKeys(corpus.lifecycle.invalid.outcomeSmugglesSecret)).toBe(true);
    expect(containsForbiddenRecordingKeys(corpus.lifecycle.valid["recording-record-content"])).toBe(false);
  });

  it("rejects new admission only when a required start record cannot be reserved", () : any => {
    const preEffect: any = { policy: fullPolicy, category: "execution_history", phase: "pre_effect" };
    const healthy: any = admitRecordingCategory({ ...preEffect, sinkState: sinkHealthy });
    expect(healthy.decision).toBe("admit");
    for (const sinkState of [sinkDown, sinkFull, corpus.state.sinkIndexExhausted]) {
      const admission: any = admitRecordingCategory({ ...preEffect, sinkState });
      expect(admission.decision).toBe("reject");
      expect(admission.reason).toBe("recording_unavailable");
      expect(recordingAdmissionBlocksOperation(admission.decision)).toBe(true);
    }
    const postEffect: any = admitRecordingCategory({
      policy: fullPolicy,
      category: "execution_history",
      phase: "post_effect",
      sinkState: sinkDown
    });
    // A required post-effect write attempts the sink; failure is reported by
    // the outcome, never hidden by the gate.
    expect(postEffect.decision).toBe("admit");
  });

  it("sheds optional categories at capacity without stopping healthy work", () : any => {
    const shedByCapacity: any = admitRecordingCategory({
      policy: fullPolicy, category: "usage", phase: "post_effect", sinkState: sinkFull
    });
    expect(shedByCapacity.decision).toBe("shed");
    expect(shedByCapacity.reason).toBe("capacity_exceeded");
    expect(recordingAdmissionBlocksOperation(shedByCapacity.decision)).toBe(false);
    const shedByDown: any = admitRecordingCategory({
      policy: fullPolicy, category: "usage", phase: "post_effect", sinkState: sinkDown
    });
    expect(shedByDown.decision).toBe("shed");
    expect(shedByDown.reason).toBe("sink_unavailable");
    const shedByIndex: any = admitRecordingCategory({
      policy: fullPolicy, category: "diagnostics", phase: "post_effect",
      sinkState: corpus.state.sinkIndexExhausted
    });
    expect(shedByIndex.decision).toBe("shed");
    const contentDeniedCapacity: any = admitRecordingCategory({
      policy: fullPolicy, category: "content", phase: "post_effect",
      sinkState: corpus.state.sinkContentExhausted
    });
    expect(contentDeniedCapacity.decision).toBe("shed");
    expect(contentDeniedCapacity.reason).toBe("capacity_exceeded");
  });

  it("denies unselected fields and forbidden material before serialization", () : any => {
    const forbidden: any = admitRecordingCategory({
      policy: fullPolicy,
      category: "content",
      phase: "post_effect",
      fieldNames: ["input.summary", "token"]
    });
    expect(forbidden.decision).toBe("deny");
    expect(forbidden.reason).toBe("forbidden_field");
    const unselected: any = admitRecordingCategory({
      policy: fullPolicy,
      category: "content",
      phase: "post_effect",
      fieldNames: ["output.raw"]
    });
    expect(unselected.decision).toBe("deny");
    expect(unselected.reason).toBe("field_not_selected");
    const eventDenied: any = admitRecordingCategory({
      policy: fullPolicy,
      category: "diagnostics",
      phase: "post_effect",
      eventCode: "stack_dump"
    });
    expect(eventDenied.decision).toBe("deny");
    expect(eventDenied.reason).toBe("field_not_selected");
    expect(() : any => assertRecordingCorePrivacy(corpus.lifecycle.invalid.recordCarriesToken)).toThrow();
    expect(assertRecordingCorePrivacy(corpus.lifecycle.valid["recording-record-diagnostics"])).toBe(true);
  });

  it("reports truthful post-effect outcomes and never replays effects", () : any => {
    expect(recordingOutcomeFor({
      obligation: "required_before_effect",
      categoryEnabled: true,
      recordsWritten: 1,
      requiredTerminalOwed: true,
      shedAtAdmission: false,
      sinkFailure: { code: "sink_write_failed", phase: "post_effect" }
    })).toEqual({ outcome: "terminal_record_pending", reason: "sink_write_failed", pendingTerminal: true });
    expect(recordingOutcomeFor({
      obligation: "optional",
      categoryEnabled: true,
      recordsWritten: 0,
      requiredTerminalOwed: false,
      shedAtAdmission: false,
      sinkFailure: { code: "sink_unavailable", phase: "post_effect" }
    })).toEqual({ outcome: "recording_degraded", reason: "sink_unavailable", pendingTerminal: false });
    expect(recordingOutcomeFor({
      obligation: "optional",
      categoryEnabled: true,
      recordsWritten: 0,
      requiredTerminalOwed: false,
      shedAtAdmission: true
    })).toEqual({ outcome: "shed", reason: "capacity_exceeded", pendingTerminal: false });
    expect(recordingOutcomeFor({
      obligation: "required_before_effect",
      categoryEnabled: true,
      recordsWritten: 0,
      requiredTerminalOwed: false,
      shedAtAdmission: true
    })).toBeNull();
    expect(recordingOutcomeFor({
      obligation: "required_before_effect",
      categoryEnabled: false,
      recordsWritten: 0,
      requiredTerminalOwed: true,
      shedAtAdmission: false
    })).toEqual({ outcome: "not_recorded", reason: "category_disabled", pendingTerminal: true });
    expect(recordingOutcomeFor({
      obligation: "optional",
      categoryEnabled: false,
      recordsWritten: 3,
      requiredTerminalOwed: false,
      shedAtAdmission: false
    })).toEqual({ outcome: "partially_recorded", reason: "category_disabled", pendingTerminal: false });
    expect(recordingOutcomeFor({
      obligation: "optional",
      categoryEnabled: true,
      recordsWritten: 2,
      requiredTerminalOwed: false,
      shedAtAdmission: false
    })).toEqual({ outcome: "recorded", reason: "none", pendingTerminal: false });
    for (const state of RECORDING_OPERATION_STATES) {
      expect(recordingMayReplayEffect(state)).toBe(false);
    }
    expect(recordingObligationOutstanding(corpus.lifecycle.valid["recording-outcome-terminal-pending"])).toBe(true);
    expect(recordingObligationOutstanding(corpus.lifecycle.valid["recording-outcome-required-owed"])).toBe(true);
    expect(recordingObligationOutstanding(corpus.lifecycle.valid["recording-outcome-recorded"])).toBe(false);
    expect(assertRecordingOutcomeHonest(corpus.lifecycle.valid["recording-outcome-terminal-pending"])).toBe(true);
    expect(assertRecordingOutcomeHonest(corpus.lifecycle.valid["recording-outcome-degraded"])).toBe(true);
    expect(() : any => assertRecordingOutcomeHonest(
      corpus.lifecycle.invalid.outcomePostEffectUndoesEffect
    )).toThrow();
    expect(() : any => assertRecordingOutcomeHonest(
      corpus.lifecycle.invalid.outcomeRequiredObligationClaimedMet
    )).toThrow();
  });

  it("round-trips constructors and parses a sink state view", () : any => {
    const sink: any = corpus.lifecycle.valid["recording-sink"];
    expect(parseRecordingMessage(sink)).toBeTruthy();
    expect(parseRecordingSinkState(sinkHealthy)).toBeTruthy();
    expect(parseRecordingSinkState({ ...sinkHealthy, available: "yes" })).toBeNull();
    const policy: any = createEmptyRecordingPolicy({
      policyId: "pol.rec.fresh",
      policyRevision: 1,
      issuedAt: "2026-10-09T09:00:00Z",
      issuerRole: "role.rec.admin",
      configurerRoles: ["role.rec.admin"]
    });
    expect(policy.categories).toEqual({});
    expect(parseRecordingCategorySelection(
      (fullPolicy.categories as any).execution_history
    ).obligation).toBe("required_before_effect");
  });
});
