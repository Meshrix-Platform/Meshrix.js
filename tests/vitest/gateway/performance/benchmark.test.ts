import { describe, expect, it } from "vitest";
import { runGatewayBenchmark } from "../../../../tools/server-scripts/benchmark-gateway.ts";

describe("gateway performance evidence", () => {
  it("[CASE-B05] reports an unevaluated profile without inventing performance claims", async () => {
    const report = await runGatewayBenchmark();
    expect(report).toMatchObject({ schemaVersion: "v0.0.1:meshrix:gateway-benchmark-1", evaluated: false, resourceContract: { bounded: true, closeRequired: true, externalNetwork: false } });
    expect(report.measurements).toEqual({});
  });

  it("can run a bounded deterministic sample with explicit evaluation", async () => {
    let calls = 0;
    const report = await runGatewayBenchmark({ iterations: 8, concurrency: 2, evaluate: true, operation: async () => { calls += 1; } });
    expect(report.evaluated).toBe(true);
    expect(calls).toBe(8);
    expect(report.measurements.operationsPerSecond).toBeGreaterThan(0);
  });
});
