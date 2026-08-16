#!/usr/bin/env node
/*
 * Named Agent-to-Service efficiency-profile catalog.
 *
 * Freezes the warm comparison identity, equivalent workloads, privacy-safe
 * counters, and certification thresholds. Certification is measured, not
 * assumed. Environment qualification remains remaining required work after
 * the named Real-Machine Verification Workflow.
 */

import {
  INTERACTION_COST_COUNTER_NAMES,
  INTERACTION_COST_PROFILES,
  INTERACTION_COST_SIZE_CONSTANTS,
  INTERACTION_COST_WORK,
  INTERACTION_COST_WORKLOAD_IDS
} from "./interaction-cost-baseline-catalog.ts";

export const EFFICIENCY_PROFILE_CATALOG_SCHEMA_VERSION: any =
  "v0.0.1:efficiency:named-profile-catalog-1";
export const EFFICIENCY_PROFILE_REPORT_SCHEMA_VERSION: any =
  "v0.0.1:efficiency:named-profile-report-1";
export const EFFICIENCY_PROFILE_MEASUREMENT_KIND: any = "named-warm-profile";
export const EFFICIENCY_NAMED_PROFILE: any = "warm";
export const EFFICIENCY_OWNER_PROFILE: any = "enterprise-single-node";
export const EFFICIENCY_CALL_REDUCTION_THRESHOLD: any = 60;
export const EFFICIENCY_BYTE_REDUCTION_THRESHOLD: any = 70;
export const EFFICIENCY_FINITE_REASON_PATTERN: any = /^[a-z][a-z0-9_]{2,64}$/u;

export const EFFICIENCY_PROFILE_PROFILES: readonly any[] = INTERACTION_COST_PROFILES;
export const EFFICIENCY_PROFILE_COUNTER_NAMES: readonly any[] = INTERACTION_COST_COUNTER_NAMES;
export const EFFICIENCY_PROFILE_SIZE: any = INTERACTION_COST_SIZE_CONSTANTS;
export const EFFICIENCY_PROFILE_WORK: any = INTERACTION_COST_WORK;

export const EFFICIENCY_PROFILE_WORKLOAD_IDS: readonly any[] = Object.freeze([
  ...INTERACTION_COST_WORKLOAD_IDS,
  "concurrent-change"
]);

const WORKLOADS: readonly any[] = Object.freeze([
  { id: "cold-open", seed: 7 },
  { id: "warm-read", seed: 11 },
  { id: "dirty-turn", seed: 13 },
  { id: "reconnect", seed: 17 },
  { id: "conflict", seed: 19 },
  { id: "revocation", seed: 23 },
  { id: "explicit-effect", seed: 29 },
  { id: "concurrent-change", seed: 31 }
]);

export const EFFICIENCY_PROFILE_NON_CERTIFICATION_REASONS: any = Object.freeze({
  ownerProfileNotAuthorized: "owner_profile_not_authorized",
  comparisonNotRun: "comparison_not_run",
  dualCoreGeneration: "dual_core_generation",
  privacyCountersLeak: "privacy_counters_leak",
  completenessIncomplete: "completeness_workloads_incomplete",
  safetyHotPath: "safety_hot_path_depends_on_total_state",
  recoveryIncomplete: "recovery_incomplete",
  unchangedSchemaBytes: "warm_unchanged_schema_bytes_nonzero",
  validCacheRemoteReads: "warm_valid_cache_remote_reads_nonzero",
  cleanTurnApply: "warm_clean_turn_apply_nonzero",
  dirtyTurnChangeSet: "warm_dirty_turn_change_set_exceeded",
  callReduction: "warm_call_reduction_below_threshold",
  byteReduction: "warm_byte_reduction_below_threshold",
  collaborationRuntimeMissing: "collaboration_runtime_not_exercised"
});

export const EFFICIENCY_PROFILE_ASSETS: readonly any[] = Object.freeze([
  Object.freeze({ assetId: "ast.icb.a", entityId: "ent.icb.a", handle: "hdl_icb_a" }),
  Object.freeze({ assetId: "ast.icb.b", entityId: "ent.icb.b", handle: "hdl_icb_b" }),
  Object.freeze({ assetId: "ast.icb.c", entityId: "ent.icb.c", handle: "hdl_icb_c" })
]);

export const EFFICIENCY_PROFILE_CATALOG: any = Object.freeze({
  schemaVersion: EFFICIENCY_PROFILE_CATALOG_SCHEMA_VERSION,
  reportSchemaVersion: EFFICIENCY_PROFILE_REPORT_SCHEMA_VERSION,
  namedProfile: EFFICIENCY_NAMED_PROFILE,
  ownerProfile: EFFICIENCY_OWNER_PROFILE,
  measurementKind: EFFICIENCY_PROFILE_MEASUREMENT_KIND,
  profiles: EFFICIENCY_PROFILE_PROFILES,
  counterNames: EFFICIENCY_PROFILE_COUNTER_NAMES,
  workloads: WORKLOADS,
  pairings: Object.freeze(WORKLOADS.map((workload?: any) : any => Object.freeze({
    workloadId: workload.id,
    seed: workload.seed,
    legacyScenarioId: `legacy/${workload.id}`,
    collaborativeScenarioId: `collaborative/${workload.id}`,
    identities: EFFICIENCY_PROFILE_WORK.identities
  }))),
  thresholds: Object.freeze({
    namedProfile: EFFICIENCY_NAMED_PROFILE,
    callReductionPercent: EFFICIENCY_CALL_REDUCTION_THRESHOLD,
    byteReductionPercent: EFFICIENCY_BYTE_REDUCTION_THRESHOLD
  }),
  work: EFFICIENCY_PROFILE_WORK,
  assets: EFFICIENCY_PROFILE_ASSETS
});

export function efficiencyWorkloadById(workloadId: any = "") : any {
  return WORKLOADS.find((workload?: any) : any => workload.id === workloadId) || null;
}

export function efficiencyPairingByWorkloadId(workloadId: any = "") : any {
  return EFFICIENCY_PROFILE_CATALOG.pairings.find(
    (pairing?: any) : any => pairing.workloadId === workloadId
  ) || null;
}

export function assertFiniteCertificationReason(reason?: any) : any {
  const normalized: any = String(reason || "").trim();
  if (!EFFICIENCY_FINITE_REASON_PATTERN.test(normalized)) {
    throw new Error("Named efficiency profile requires a finite snake_case non-certification reason.");
  }
  return normalized;
}

export function reductionPercent(legacyValue: any = 0, collaborativeValue: any = 0) : any {
  const legacy: any = Number(legacyValue);
  const collaborative: any = Number(collaborativeValue);
  if (!Number.isFinite(legacy) || legacy <= 0) return 0;
  if (!Number.isFinite(collaborative) || collaborative < 0) return 0;
  return ((legacy - collaborative) * 100) / legacy;
}

export function meetsReductionThreshold(
  legacyValue: any = 0,
  collaborativeValue: any = 0,
  thresholdPercent: any = 0
) : any {
  const legacy: any = Number(legacyValue);
  const collaborative: any = Number(collaborativeValue);
  const threshold: any = Number(thresholdPercent);
  if (!Number.isFinite(legacy) || !Number.isFinite(collaborative) || !Number.isFinite(threshold)) {
    return false;
  }
  if (legacy <= 0) return collaborative === 0 && threshold <= 0;
  if (collaborative < 0) return false;
  return (legacy - collaborative) * 100 >= threshold * legacy;
}
