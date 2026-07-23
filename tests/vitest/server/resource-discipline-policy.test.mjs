import { describe, expect, it } from "vitest";

import {
  median,
  positiveGrowth,
  theilSenSlope
} from "../../../tools/server-scripts/lib/resource-discipline-analysis.mjs";
import { RESOURCE_DISCIPLINE_POLICY } from "../../../tools/server-scripts/lib/resource-discipline-policy.mjs";

describe("priority-zero resource discipline", () => {
  it("publishes immutable hard bounds and the professional heap framework", () => {
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
      }
    });
    expect(Object.isFrozen(RESOURCE_DISCIPLINE_POLICY)).toBe(true);
    expect(Object.isFrozen(RESOURCE_DISCIPLINE_POLICY.memoryLeak)).toBe(true);
  });

  it("uses a robust slope that detects sustained retention without failing on one outlier", () => {
    const sustainedLeak = Array.from({ length: 7 }, (_unused, index) => ({
      requests: index * 100,
      heapUsed: index * 4096 * 100
    }));
    expect(theilSenSlope(sustainedLeak, (sample) => sample.heapUsed)).toBe(4096);
    expect(
      theilSenSlope([
        { requests: 0, heapUsed: 1_000_000 },
        { requests: 100, heapUsed: 1_000_000 },
        { requests: 200, heapUsed: 100_000_000 },
        { requests: 300, heapUsed: 1_000_000 },
        { requests: 400, heapUsed: 1_000_000 }
      ], (sample) => sample.heapUsed)
    ).toBe(0);
    expect(median([9, 1, 5, 3])).toBe(4);
    expect(positiveGrowth(100, 120)).toBe(0);
    expect(positiveGrowth(140, 120)).toBe(20);
  });
});
