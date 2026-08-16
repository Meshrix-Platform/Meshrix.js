import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { containsSensitiveReportData } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";
import {
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED,
  containsForbiddenKeys,
  lookupFactIsAuthority
} from "../../../packages/contracts/src/service-collaboration-contract.ts";
import {
  INTERACTION_COST_COUNTER_NAMES,
  INTERACTION_COST_WORKLOAD_IDS
} from "../../../tools/verifiers/interaction-cost-baseline-catalog.ts";
import {
  EFFICIENCY_BYTE_REDUCTION_THRESHOLD,
  EFFICIENCY_CALL_REDUCTION_THRESHOLD,
  EFFICIENCY_NAMED_PROFILE,
  EFFICIENCY_OWNER_PROFILE,
  EFFICIENCY_PROFILE_CATALOG,
  EFFICIENCY_PROFILE_WORKLOAD_IDS,
  meetsReductionThreshold
} from "../../../tools/verifiers/efficiency-profile-catalog.ts";
import {
  EFFICIENCY_PROFILE_REPORT_RELATIVE_PATH,
  EFFICIENCY_PROFILE_VERIFIER,
  assertEfficiencyProfile,
  buildEfficiencyProfileReport,
  efficiencyWorkFingerprint,
  measureEfficiencyProfile,
  replayEfficiencyProfile,
  scanEfficiencyProfileSource
} from "../../../tools/server-scripts/efficiency-profile.ts";

const PROJECT_ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ABSOLUTE_PATH_PATTERN: any = /(?:\/(?:Users|home|private|var\/folders|root)\/|[A-Za-z]:\\)/u;
const PAYLOAD_TEXT_PATTERN: any = /private file content|raw prompt body|hello world/iu;

function serialized(value?: any) : any {
  return JSON.stringify(value);
}

describe("named agent-service efficiency profile", () : any => {
  it("freezes equivalent workloads including concurrent change and the warm thresholds", () : any => {
    expect(EFFICIENCY_NAMED_PROFILE).toBe("warm");
    expect(EFFICIENCY_OWNER_PROFILE).toBe("enterprise-single-node");
    expect(EFFICIENCY_PROFILE_WORKLOAD_IDS).toEqual([
      ...INTERACTION_COST_WORKLOAD_IDS,
      "concurrent-change"
    ]);
    expect(EFFICIENCY_PROFILE_CATALOG.pairings).toHaveLength(EFFICIENCY_PROFILE_WORKLOAD_IDS.length);
    expect(EFFICIENCY_CALL_REDUCTION_THRESHOLD).toBe(60);
    expect(EFFICIENCY_BYTE_REDUCTION_THRESHOLD).toBe(70);
    expect(meetsReductionThreshold(10, 4, 60)).toBe(true);
    expect(meetsReductionThreshold(10, 5, 60)).toBe(false);
    expect(SERVICE_COLLABORATION_SECOND_CORE_GENERATION_ALLOWED).toBe(false);
    for (const fact of SERVICE_COLLABORATION_LOOKUP_FACTS) {
      expect(lookupFactIsAuthority(fact)).toBe(false);
    }
    expect(scanEfficiencyProfileSource(PROJECT_ROOT).residueAbsent).toBe(true);
  });

  it("compares every workload with privacy-safe counters and exercised collaboration modules", async () : Promise<any> => {
    const measurement: any = await measureEfficiencyProfile();
    expect(measurement.pairs).toHaveLength(EFFICIENCY_PROFILE_WORKLOAD_IDS.length);
    expect(measurement.connectorRuntimePresent).toBe(true);
    expect(measurement.changeSetRuntimePresent).toBe(true);
    expect(measurement.workspaceMigrationPresent).toBe(true);
    expect(measurement.effectCommandRuntimePresent).toBe(true);
    for (const pair of measurement.pairs) {
      expect(Object.keys(pair.legacy.counters).sort()).toEqual([...INTERACTION_COST_COUNTER_NAMES].sort());
      expect(Object.keys(pair.collaborative.counters).sort()).toEqual([...INTERACTION_COST_COUNTER_NAMES].sort());
      expect(pair.legacy.workFingerprint).toBe(pair.collaborative.workFingerprint);
      expect(pair.legacy.workFingerprint).toBe(efficiencyWorkFingerprint(pair.workloadId));
      expect(pair.legacy.identities).toEqual(pair.collaborative.identities);
    }
    expect(assertEfficiencyProfile(measurement)).toBe(true);
  });

  it("replays identical counters and evaluates the warm profile without inventing certification", async () : Promise<any> => {
    const replay: any = await replayEfficiencyProfile();
    expect(replay.identical).toBe(true);
    const warm: any = replay.first.pairs.find((pair?: any) : any => pair.workloadId === "warm-read");
    const dirty: any = replay.first.pairs.find((pair?: any) : any => pair.workloadId === "dirty-turn");
    const effect: any = replay.first.pairs.find((pair?: any) : any => pair.workloadId === "explicit-effect");
    expect(warm.collaborative.counters.schemaBytes).toBe(0);
    expect(warm.collaborative.counters.modelVisibleRemoteReads).toBe(0);
    expect(warm.collaborative.counters.applyCalls).toBe(0);
    expect(dirty.collaborative.counters.changeSetApplyCalls).toBe(1);
    expect(effect.collaborative.counters.changeSetApplyCalls).toBe(0);
    expect(effect.collaborative.counters.effectCommandCalls).toBe(1);
    expect(replay.first.evaluation.warm.cleanTurnApplyCalls).toBe(0);
    expect(replay.first.evaluation.warm.dirtyTurnChangeSetApplyCalls).toBeLessThanOrEqual(1);
    if (replay.first.capacityCertified === true) {
      expect(replay.first.evaluation.warmThresholdsPassed).toBe(true);
      expect(replay.first.evaluation.completenessPassed).toBe(true);
      expect(replay.first.evaluation.privacyPassed).toBe(true);
      expect(replay.first.evaluation.safetyPassed).toBe(true);
      expect(replay.first.evaluation.recoveryPassed).toBe(true);
      expect(replay.first.nonCertificationReason).toBeNull();
    } else {
      expect(replay.first.nonCertificationReason).toMatch(/^[a-z][a-z0-9_]{2,64}$/u);
    }
  });

  it("keeps reports privacy-safe and rejects certification without every threshold", async () : Promise<any> => {
    const measurement: any = await measureEfficiencyProfile();
    const report: any = buildEfficiencyProfileReport(measurement, {
      generatedAt: "1970-01-01T00:00:00.000Z",
      deterministicReplay: true,
      focusedSuitePassed: true
    });
    const text: any = serialized(report);
    expect(report.verifier).toBe(EFFICIENCY_PROFILE_VERIFIER);
    expect(EFFICIENCY_PROFILE_REPORT_RELATIVE_PATH.startsWith("build/reports/")).toBe(true);
    expect(containsForbiddenKeys(report)).toBe(false);
    expect(containsSensitiveReportData(report)).toBe(false);
    expect(ABSOLUTE_PATH_PATTERN.test(text)).toBe(false);
    expect(PAYLOAD_TEXT_PATTERN.test(text)).toBe(false);
    const forged: any = {
      ...measurement,
      capacityCertified: true,
      evaluation: {
        ...measurement.evaluation,
        capacityCertified: true,
        warmThresholdsPassed: false
      }
    };
    expect(() : any => assertEfficiencyProfile(forged)).toThrow(/cannot claim certification/);
  });
});
