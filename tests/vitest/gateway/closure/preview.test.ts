import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { context, createTestGateway, descriptor, route } from "../support";

function distribution(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const at = (percentile: number) => Number(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percentile) - 1)].toFixed(3));
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

describe("synthetic preview performance observations", () => {
  it("[GC-064 partial] records three same-process direct/gateway call rounds without inventing a PR82 baseline", async () => {
    const gateway = createTestGateway({ descriptors: [descriptor({ route: route({ effectClass: "read" }), inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } })],
      upstream: { async invoke() { return { status: 200, body: { resultType: "complete", content: [{ type: "text", text: "synthetic" }] } }; } } });
    await gateway.start();
    try {
      const direct = async () => ({ status: 200, body: { resultType: "complete", content: [{ type: "text", text: "synthetic" }] } });
      const proxied = () => gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { value: 1 } });
      for (let warmup = 0; warmup < 20; warmup += 1) { await direct(); await proxied(); }
      const observations: Array<{ round: number; directMs: ReturnType<typeof distribution>; gatewayMs: ReturnType<typeof distribution>; gatewayHeapDeltaMiB: number }> = [];
      for (let round = 0; round < 3; round += 1) {
        const directSamples: number[] = [];
        const gatewaySamples: number[] = [];
        const before = process.memoryUsage().heapUsed;
        for (let sample = 0; sample < 80; sample += 1) {
          const startDirect = performance.now();
          await direct();
          directSamples.push(performance.now() - startDirect);
          const startGateway = performance.now();
          expect((await proxied()).kind).toBe("complete");
          gatewaySamples.push(performance.now() - startGateway);
        }
        observations.push({ round: round + 1, directMs: distribution(directSamples), gatewayMs: distribution(gatewaySamples), gatewayHeapDeltaMiB: Number(((process.memoryUsage().heapUsed - before) / 1024 / 1024).toFixed(2)) });
      }
      expect(observations).toHaveLength(3);
      expect(observations.every((entry) => entry.gatewayMs.p95 >= 0 && entry.gatewayMs.p99 >= entry.gatewayMs.p95)).toBe(true);
      // Direct peer and current gateway are not a committed PR82 baseline comparison.
      // Do not turn these machine-local samples into a 10% acceptance claim.
      console.info(JSON.stringify({ profile: "synthetic-local", baseline: "not_run", conclusion: "uncomparable", observations }));
    } finally { await gateway.close(); }
  }, 30_000);
});
