import { describe, expect, it } from "vitest";

import { containsSensitiveReportData } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import {
  INTERACTION_COST_BASELINE_CATALOG,
  INTERACTION_COST_COUNTER_NAMES,
  INTERACTION_COST_NON_CERTIFICATION_REASON,
  INTERACTION_COST_PROFILES,
  INTERACTION_COST_WORKLOAD_IDS,
  assertCapacityNeverCertified,
  assertCollaborativeTurnInvariants,
  pairingByWorkloadId,
  workloadById
} from "../../../tools/verifiers/interaction-cost-baseline-catalog.ts";
import {
  INTERACTION_COST_BASELINE_REPORT_RELATIVE_PATH,
  INTERACTION_COST_BASELINE_VERIFIER,
  assertInteractionCostBaseline,
  buildInteractionCostBaselineReport,
  measureInteractionCostBaseline,
  measureInteractionCostScenario,
  replayInteractionCostBaseline
} from "../../../tools/server-scripts/interaction-cost-baseline.ts";

const ABSOLUTE_PATH_PATTERN: any = /(?:\/(?:Users|home|private|var\/folders|root)\/|[A-Za-z]:\\)/u;
const PAYLOAD_TEXT_PATTERN: any = /private file content|raw prompt body|hello world/iu;

function serialized(value?: any) : any {
  return JSON.stringify(value);
}

describe("agent-service interaction cost baseline", () : any => {
  it("freezes equivalent legacy and collaborative pairings for every required workload", () : any => {
    expect(INTERACTION_COST_PROFILES).toEqual(["legacy", "collaborative"]);
    expect(INTERACTION_COST_WORKLOAD_IDS).toEqual([
      "cold-open",
      "warm-read",
      "dirty-turn",
      "reconnect",
      "conflict",
      "revocation",
      "explicit-effect"
    ]);
    expect(INTERACTION_COST_BASELINE_CATALOG.pairings).toHaveLength(INTERACTION_COST_WORKLOAD_IDS.length);
    for (const workloadId of INTERACTION_COST_WORKLOAD_IDS) {
      const spec: any = workloadById(workloadId);
      const pairing: any = pairingByWorkloadId(workloadId);
      expect(spec.seed).toBeGreaterThan(0);
      expect(pairing.legacyScenarioId).toBe(`legacy/${workloadId}`);
      expect(pairing.collaborativeScenarioId).toBe(`collaborative/${workloadId}`);
      expect(pairing.identities).toEqual(INTERACTION_COST_BASELINE_CATALOG.work.identities);
      expect(pairing.seed).toBe(spec.seed);
    }
    expect(INTERACTION_COST_BASELINE_CATALOG.nonCertification).toEqual({
      capacityCertified: false,
      reason: INTERACTION_COST_NON_CERTIFICATION_REASON
    });
    expect(INTERACTION_COST_BASELINE_CATALOG.connectorRuntimePresent).toBe(false);
  });

  it("reports every required counter for both profiles", () : any => {
    const measurement: any = measureInteractionCostBaseline();
    expect(measurement.pairs).toHaveLength(7);
    for (const pair of measurement.pairs) {
      expect(INTERACTION_COST_PROFILES).toContain(pair.legacy.profile);
      expect(INTERACTION_COST_PROFILES).toContain(pair.collaborative.profile);
      expect(Object.keys(pair.legacy.counters).sort()).toEqual([...INTERACTION_COST_COUNTER_NAMES].sort());
      expect(Object.keys(pair.collaborative.counters).sort()).toEqual([...INTERACTION_COST_COUNTER_NAMES].sort());
      expect(pair.legacy.workFingerprint).toBe(pair.collaborative.workFingerprint);
      expect(pair.legacy.identities).toEqual(pair.collaborative.identities);
    }
    expect(assertInteractionCostBaseline(measurement)).toBe(true);
  });

  it("replays identical counters", () : any => {
    const replay: any = replayInteractionCostBaseline();
    expect(replay.identical).toBe(true);
    const again: any = measureInteractionCostBaseline();
    expect(again.pairs.map((pair?: any) : any => pair.legacy.counters)).toEqual(
      replay.first.pairs.map((pair?: any) : any => pair.legacy.counters)
    );
    expect(again.pairs.map((pair?: any) : any => pair.collaborative.counters)).toEqual(
      replay.first.pairs.map((pair?: any) : any => pair.collaborative.counters)
    );
  });

  it("measures a clean collaborative turn as zero applies and a dirty turn as one Change Set apply", () : any => {
    const warm: any = measureInteractionCostScenario("collaborative", "warm-read");
    const dirty: any = measureInteractionCostScenario("collaborative", "dirty-turn");
    const effect: any = measureInteractionCostScenario("collaborative", "explicit-effect");
    expect(warm.counters.applyCalls).toBe(0);
    expect(warm.counters.modelVisibleRemoteReads).toBe(0);
    expect(warm.counters.modelContextBytes).toBe(0);
    expect(dirty.counters.changeSetApplyCalls).toBe(1);
    expect(dirty.counters.applyCalls).toBe(1);
    expect(effect.counters.changeSetApplyCalls).toBe(0);
    expect(effect.counters.effectCommandCalls).toBe(1);
    expect(assertCollaborativeTurnInvariants(warm)).toBe(true);
    expect(assertCollaborativeTurnInvariants(dirty)).toBe(true);
    expect(assertCollaborativeTurnInvariants(effect)).toBe(true);

    const legacyWarm: any = measureInteractionCostScenario("legacy", "warm-read");
    const legacyDirty: any = measureInteractionCostScenario("legacy", "dirty-turn");
    expect(legacyWarm.counters.repeatedReads).toBeGreaterThan(0);
    expect(legacyWarm.counters.catalogBytes).toBeGreaterThan(0);
    expect(legacyWarm.counters.schemaBytes).toBeGreaterThan(0);
    expect(legacyDirty.counters.applyCalls).toBeGreaterThan(1);
  });

  it("keeps reports privacy-safe and does not certify capacity", () : any => {
    const measurement: any = measureInteractionCostBaseline();
    const report: any = buildInteractionCostBaselineReport(measurement, {
      generatedAt: "1970-01-01T00:00:00.000Z",
      deterministicReplay: true,
      focusedSuitePassed: true
    });
    const text: any = serialized(report);
    expect(report.capacityCertified).toBe(false);
    expect(report.summary.capacityCertified).toBe(false);
    expect(report.nonCertificationReason).toBe(INTERACTION_COST_NON_CERTIFICATION_REASON);
    expect(report.verifier).toBe(INTERACTION_COST_BASELINE_VERIFIER);
    expect(INTERACTION_COST_BASELINE_REPORT_RELATIVE_PATH.startsWith("build/reports/")).toBe(true);
    expect(containsSensitiveReportData(report)).toBe(false);
    expect(ABSOLUTE_PATH_PATTERN.test(text)).toBe(false);
    expect(PAYLOAD_TEXT_PATTERN.test(text)).toBe(false);
    expect(assertCapacityNeverCertified(report)).toBe(true);
    expect(() : any => assertCapacityNeverCertified({ capacityCertified: true })).toThrow(
      /never certify capacity/
    );
  });
});
