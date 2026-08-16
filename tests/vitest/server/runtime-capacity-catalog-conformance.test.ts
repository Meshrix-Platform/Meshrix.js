import { describe, expect, it } from "vitest";

import {
  assertConformanceNeverCertifies,
  createDeterministicCounterSet,
  replayCatalogDeterminism,
  replayClosedLoopDeterminism,
  RUNTIME_CAPACITY_WORKLOAD_CATALOG,
  runClosedLoopWorkload,
  runOpenLoopWorkload,
  workloadById
} from "../../../tools/verifiers/runtime-capacity-workload-catalog.ts";
import { containsSensitiveReportData } from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";

describe("runtime capacity workload catalog", () : any => {
  it("replays every closed-loop workload with identical counters", async () : Promise<any> => {
    const replay: any = await replayCatalogDeterminism();
    expect(replay.identical).toBe(true);
    expect(replay.workloadCount).toBe(RUNTIME_CAPACITY_WORKLOAD_CATALOG.closedLoop.length);
    for (const result of replay.results) {
      expect(result.first).toEqual(result.second);
      expect(Number.isInteger(result.first.statements)).toBe(true);
    }
  });

  it("produces reproducible closed-loop and open-loop schemas", async () : Promise<any> => {
    const closed: any = runClosedLoopWorkload(workloadById("external-gateway-admission"), null);
    const replay: any = await replayClosedLoopDeterminism("external-gateway-admission");
    expect(closed.mode).toBe("closed");
    expect(closed.iterations).toBe(200);
    expect(closed.counters).toEqual(replay.first);
    const open: any = await runOpenLoopWorkload(workloadById("mcp-discovery"), null);
    expect(open.mode).toBe("open");
    expect(open.concurrency).toBe(8);
    expect(open.counters.credits).toBeGreaterThan(0);
    expect(open.counters.wakeups).toBe(open.counters.credits);
  });

  it("supports deterministic counter sets without protected payloads", () : any => {
    const counterSet: any = createDeterministicCounterSet();
    counterSet.record("statements", 3);
    counterSet.record("objectBytes", 4096);
    const snapshot: any = counterSet.snapshot();
    expect(snapshot.statements).toBe(3);
    expect(snapshot.objectBytes).toBe(4096);
    expect(containsSensitiveReportData(snapshot)).toBe(false);
    expect(() : any => counterSet.record("unknown", 1)).toThrow(/Unknown deterministic counter kind/);
  });

  it("never lets conformance evidence certify capacity", () : any => {
    expect(() : any => assertConformanceNeverCertifies({ capacityCertified: true })).toThrow(
      /never certify capacity/
    );
    expect(assertConformanceNeverCertifies({ capacityCertified: false })).toBe(true);
    expect(assertConformanceNeverCertifies({})).toBe(true);
  });

  it("keeps every catalog workload inside the authorized catalog", () : any => {
    for (const workload of RUNTIME_CAPACITY_WORKLOAD_CATALOG.workloads) {
      expect(workloadById(workload.id)).toEqual(workload);
      expect(workload.seed).toBeGreaterThan(0);
      expect(workload.counters.length).toBeGreaterThan(0);
    }
    expect(workloadById("not-a-workload")).toBeNull();
  });
});
