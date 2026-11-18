import { describe, expect, it } from "vitest";

import {
  externalMemoryGrowth,
  median,
  positiveGrowth,
  theilSenSlope
} from "../../../tools/server-scripts/lib/resource-discipline-analysis.ts";
import { RESOURCE_DISCIPLINE_POLICY } from "../../../tools/server-scripts/lib/resource-discipline-policy.ts";

describe("priority-zero resource discipline", () : any => {
  it("publishes immutable hard bounds and the professional heap framework", () : any => {
    expect(RESOURCE_DISCIPLINE_POLICY).toMatchObject({
      priority: "p0-non-negotiable",
      logging: {
        routineProbePersistence: "forbidden"
      },
      persistence: {
        unboundedAppend: "forbidden"
      },
      memoryLeak: {
        framework: "@datadog/pprof",
        frameworkVersion: "5.16.0",
        toolCacheRetention: "preserve-local",
        diagnosticArtifactRetention: "temporary-private",
        gcPasses: 3
      },
      highRiskWorkloads: {
        profile: "quick",
        minimumProtocolEvents: 100_000,
        minimumJobRecords: 10_000,
        maxSettledHeapGrowthBytes: 2 * 1024 * 1024
      }
    });
    expect(Object.isFrozen(RESOURCE_DISCIPLINE_POLICY)).toBe(true);
    expect(Object.isFrozen(RESOURCE_DISCIPLINE_POLICY.memoryLeak)).toBe(true);
    expect(Object.isFrozen(RESOURCE_DISCIPLINE_POLICY.highRiskWorkloads)).toBe(true);
    expect(RESOURCE_DISCIPLINE_POLICY.highRiskWorkloads.requiredScenarioIds)
      .toHaveLength(8);
  });

  it("uses a robust slope that detects sustained retention without failing on one outlier", () : any => {
    const sustainedLeak: any = Array.from({ length: 7 }, (_unused?: any, index?: any) : any => ({
      requests: index * 100,
      heapUsed: index * 4096 * 100
    }));
    expect(theilSenSlope(sustainedLeak, (sample?: any) : any => sample.heapUsed)).toBe(4096);
    expect(
      theilSenSlope([
        { requests: 0, heapUsed: 1_000_000 },
        { requests: 100, heapUsed: 1_000_000 },
        { requests: 200, heapUsed: 100_000_000 },
        { requests: 300, heapUsed: 1_000_000 },
        { requests: 400, heapUsed: 1_000_000 }
      ], (sample?: any) : any => sample.heapUsed)
    ).toBe(0);
    expect(median([9, 1, 5, 3])).toBe(4);
    expect(positiveGrowth(100, 120)).toBe(0);
    expect(positiveGrowth(140, 120)).toBe(20);
  });

  it("does not double-count ArrayBuffer memory already included in external", () : any => {
    expect(externalMemoryGrowth(96 * 1024 * 1024, 64 * 1024 * 1024)).toBe(32 * 1024 * 1024);
  });
});
