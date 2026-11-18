#!/usr/bin/env node
/*
 * Frozen Agent-to-Service interaction-cost catalog.
 *
 * Equivalent legacy and collaborative protocol-shape workloads. This catalog
 * freezes measurement identities, seeds, pairings, and counter names. It does
 * not implement Connector Working View, Core Change Set authority, or Effect
 * Command runtime, and it must never certify capacity.
 */

export const INTERACTION_COST_CATALOG_SCHEMA_VERSION: any =
  "v0.0.1:efficiency:interaction-cost-baseline-catalog-1";
export const INTERACTION_COST_REPORT_SCHEMA_VERSION: any =
  "v0.0.1:efficiency:interaction-cost-baseline-report-1";
export const INTERACTION_COST_NON_CERTIFICATION_REASON: any =
  "baseline_does_not_certify_capacity";
export const INTERACTION_COST_MEASUREMENT_KIND: any = "specified-protocol-shape";

export const INTERACTION_COST_PROFILES: readonly any[] = Object.freeze([
  "legacy",
  "collaborative"
]);

export const INTERACTION_COST_WORKLOAD_IDS: readonly any[] = Object.freeze([
  "cold-open",
  "warm-read",
  "dirty-turn",
  "reconnect",
  "conflict",
  "revocation",
  "explicit-effect"
]);

export const INTERACTION_COST_COUNTER_NAMES: readonly any[] = Object.freeze([
  "modelVisibleToolCalls",
  "modelVisibleRemoteReads",
  "discoveryBytes",
  "catalogBytes",
  "schemaBytes",
  "modelContextBytes",
  "requestBytes",
  "responseBytes",
  "wireBytes",
  "networkRoundTrips",
  "repeatedReads",
  "indexedStatements",
  "scannedEntities",
  "relevantOperations",
  "wakeups",
  "timers",
  "cacheWeight",
  "acknowledgementLatency",
  "subscriberVisibilityLatency",
  "memoryPeak",
  "queuePeak",
  "subscriptionPeak",
  "retryPeak",
  "snapshotPeak",
  "applyCalls",
  "changeSetApplyCalls",
  "effectCommandCalls"
]);

export const INTERACTION_COST_SIZE_CONSTANTS: any = Object.freeze({
  envelopeBytes: 64,
  initializeRequestBytes: 192,
  initializeResponseBytes: 256,
  toolsListRequestBytes: 72,
  catalogEntryBytes: 48,
  compactIndexEntryBytes: 24,
  schemaTypeBytes: 256,
  entityBodyBytes: 4096,
  handleBytes: 40,
  cursorBytes: 48,
  headBytes: 16,
  changeOpBytes: 96,
  ackIdentityBytes: 32,
  missingOpBytes: 80,
  conflictFactBytes: 48,
  effectRequestBytes: 144,
  effectResponseBytes: 96,
  grantRequestBytes: 80,
  grantResponseBytes: 64,
  subscribeRequestBytes: 96,
  subscribeResponseBytes: 80,
  workingSetOpenRequestBytes: 128,
  queueSlotBytes: 256,
  roundTripTicks: 10,
  subscriberFanoutTicks: 4
});

export const INTERACTION_COST_WORK: any = Object.freeze({
  catalogSize: 8,
  workingSetSize: 3,
  schemaTypeCount: 2,
  dirtyIdentityCount: 3,
  reconnectMissingOps: 2,
  conflictRelevantOps: 2,
  identities: Object.freeze({
    workingSetId: "ws.icb.1",
    entityIds: Object.freeze(["ent.icb.a", "ent.icb.b", "ent.icb.c"]),
    principalId: "prin.icb.1",
    grantRef: "gr.icb.1",
    cursorRef: "cur.icb.1"
  })
});

const WORKLOADS: readonly any[] = Object.freeze([
  { id: "cold-open", seed: 7 },
  { id: "warm-read", seed: 11 },
  { id: "dirty-turn", seed: 13 },
  { id: "reconnect", seed: 17 },
  { id: "conflict", seed: 19 },
  { id: "revocation", seed: 23 },
  { id: "explicit-effect", seed: 29 }
]);

export const INTERACTION_COST_BASELINE_CATALOG: any = Object.freeze({
  schemaVersion: INTERACTION_COST_CATALOG_SCHEMA_VERSION,
  reportSchemaVersion: INTERACTION_COST_REPORT_SCHEMA_VERSION,
  profiles: INTERACTION_COST_PROFILES,
  counterNames: INTERACTION_COST_COUNTER_NAMES,
  workloads: WORKLOADS,
  pairings: Object.freeze(WORKLOADS.map((workload?: any) : any => Object.freeze({
    workloadId: workload.id,
    seed: workload.seed,
    legacyScenarioId: `legacy/${workload.id}`,
    collaborativeScenarioId: `collaborative/${workload.id}`,
    identities: INTERACTION_COST_WORK.identities
  }))),
  nonCertification: Object.freeze({
    capacityCertified: false,
    reason: INTERACTION_COST_NON_CERTIFICATION_REASON
  }),
  measurementKind: INTERACTION_COST_MEASUREMENT_KIND,
  connectorRuntimePresent: false,
  changeSetRuntimePresent: false,
  effectCommandRuntimePresent: false,
  work: INTERACTION_COST_WORK
});

export function workloadById(workloadId: any = "") : any {
  return WORKLOADS.find((workload?: any) : any => workload.id === workloadId) || null;
}

export function pairingByWorkloadId(workloadId: any = "") : any {
  return INTERACTION_COST_BASELINE_CATALOG.pairings.find(
    (pairing?: any) : any => pairing.workloadId === workloadId
  ) || null;
}

export function createEmptyInteractionCostCounters() : any {
  const counters: Record<string, any> = {};
  for (const name of INTERACTION_COST_COUNTER_NAMES) {
    counters[name] = 0;
  }
  return counters;
}

export function assertFiniteNonNegativeCounters(counters: Record<string, any> = {}) : any {
  const missing: any[] = [];
  const invalid: any[] = [];
  for (const name of INTERACTION_COST_COUNTER_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(counters, name)) {
      missing.push(name);
      continue;
    }
    const value: any = counters[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      invalid.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Interaction-cost counters missing: ${missing.join(",")}`);
  }
  if (invalid.length > 0) {
    throw new Error(`Interaction-cost counters are not finite non-negative integers: ${invalid.join(",")}`);
  }
  if (counters.wireBytes !== counters.requestBytes + counters.responseBytes) {
    throw new Error("Interaction-cost wireBytes must equal requestBytes plus responseBytes.");
  }
  return true;
}

export function assertCapacityNeverCertified(report: Record<string, any> = {}) : any {
  const reason: any = String(
    report.nonCertificationReason
    || report.summary?.nonCertificationReason
    || ""
  ).trim();
  if (report.capacityCertified === true || report.summary?.capacityCertified === true) {
    throw new Error("Interaction-cost baseline must never certify capacity.");
  }
  if (!/^[a-z][a-z0-9_]{2,64}$/u.test(reason)) {
    throw new Error("Interaction-cost baseline requires a finite non-certification reason.");
  }
  return true;
}

export function assertCollaborativeTurnInvariants(result: Record<string, any> = {}) : any {
  const collaborative: any = result.profile === "collaborative"
    ? result
    : (result.collaborative || null);
  const workloadId: any = String(collaborative?.workloadId || result.workloadId || "");
  const counters: any = collaborative?.counters || {};
  if (workloadId === "warm-read") {
    if (counters.applyCalls !== 0 || counters.changeSetApplyCalls !== 0) {
      throw new Error("Collaborative warm-read must record zero apply calls.");
    }
    if (counters.modelVisibleRemoteReads !== 0 || counters.repeatedReads !== 0) {
      throw new Error("Collaborative warm-read must record zero remote reads.");
    }
    if (counters.catalogBytes !== 0 || counters.schemaBytes !== 0 || counters.modelContextBytes !== 0) {
      throw new Error("Collaborative warm-read must record zero unchanged catalog or schema model-context bytes.");
    }
  }
  if (workloadId === "dirty-turn") {
    if (counters.changeSetApplyCalls !== 1 || counters.applyCalls !== 1) {
      throw new Error("Collaborative dirty-turn must record exactly one Change Set apply.");
    }
    if (counters.effectCommandCalls !== 0) {
      throw new Error("Collaborative dirty-turn must not mix Effect Commands into the Change Set apply.");
    }
  }
  if (workloadId === "explicit-effect") {
    if (counters.changeSetApplyCalls !== 0 || counters.applyCalls !== 0) {
      throw new Error("Collaborative explicit-effect must not record a Change Set apply.");
    }
    if (counters.effectCommandCalls !== 1) {
      throw new Error("Collaborative explicit-effect must record one Effect Command.");
    }
  }
  return true;
}
