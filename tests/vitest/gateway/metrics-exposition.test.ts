import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { renderUpstreamGatewayMetricsExposition } from "../../../packages/agents/src/upstream-gateway/metrics-exposition.ts";
import { installUpstreamRuntimeServices, structuredUpstreamServiceFixture } from "../../helpers/upstream-runtime-snapshot.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";

const SUBJECT = {
  type: "tool-grant",
  subjectId: "operator",
  grantId: "grant",
  grant: {
    id: "grant",
    subjectId: "operator",
    dynamicCapabilities: ["cap:upstream:guarded:run"]
  },
  scopes: ["gateway:read", "gateway:write"],
  dynamicCapabilities: ["cap:upstream:guarded:run"]
};

describe("Upstream gateway metrics exposition", () => {
  it("renders Prometheus 0.0.4 text with bounded labels after real forwards", async () => {
    const peer = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const address = peer.address();
    if (!address || typeof address === "string") throw new Error("Synthetic upstream peer is unavailable.");
    const registry = createUpstreamGatewayRegistry({
      schemaPort: createGatewaySchemaPort(),
      claimProtectedSinkAttempt: async () => Object.freeze({ id: "claim-1", consumed: true })
    });
    installUpstreamRuntimeServices(registry, [structuredUpstreamServiceFixture({
      serviceId: "guarded",
      serviceProtocol: "http",
      label: "guarded",
      allowLocalNetwork: true,
      baseUrl: `http://127.0.0.1:${address.port}`,
      operations: [{
        operationKey: "run",
        method: "POST",
        path: "/run",
        risk: "read_only",
        requiredScopes: ["gateway:write"]
      }]
    })]);
    try {
      await registry.forward({ serviceId: "guarded", operationKey: "run", body: { n: 1 } }, SUBJECT);
      await registry.forward({ serviceId: "guarded", operationKey: "run", body: { n: 2 } }, SUBJECT);
      const metrics = registry.getMetrics();
      expect(metrics.totalForwardCount).toBe(2);
      expect(metrics.byService.guarded).toBe(2);
      expect(typeof metrics.shedMetricDimensions).toBe("number");

      const exposition = renderUpstreamGatewayMetricsExposition(metrics);
      expect(exposition).toContain("# TYPE meshrix_upstream_forward_total counter");
      expect(exposition).toContain("meshrix_upstream_forward_total 2");
      expect(exposition).toContain('meshrix_upstream_forward_total{service="guarded"} 2');
      expect(exposition).toContain('meshrix_upstream_forward_status_total{status="200"} 2');
      expect(exposition).toContain("# TYPE meshrix_upstream_runtime_traffic_buckets gauge");
      expect(exposition).toContain("meshrix_upstream_metric_dimensions_shed_total 0");
      expect(exposition.endsWith("\n")).toBe(true);
      // Bounded labels only — no caller subject, payload or grant identity.
      expect(exposition).not.toContain("operator");
      expect(exposition).not.toContain("grant");
    } finally {
      await registry.close();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
    }
  });

  it("escapes label values and tolerates sparse snapshots", () => {
    const text = renderUpstreamGatewayMetricsExposition({
      protocolVersion: "upstream-gateway/v1",
      totalForwardCount: 1,
      byService: { 'svc"\\\nname': 1 },
      boundedRuntimeState: {
        trafficBucketCount: 0,
        endpointCursorCount: 0,
        endpointCircuitCount: 0,
        mcpToolCacheCount: 0
      }
    } as any);
    expect(text).toContain('meshrix_upstream_forward_total{service="svc\\"\\\\\\nname"} 1');
    expect(text).toContain("meshrix_upstream_forward_failures_total 0");
  });
});
