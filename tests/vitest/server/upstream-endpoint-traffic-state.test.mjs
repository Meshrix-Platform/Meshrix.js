import { describe, expect, it, vi } from "vitest";

import { createEndpointTrafficController } from "../../../packages/agents/src/upstream-gateway/endpoint-traffic.mjs";
import {
  MAX_UPSTREAM_ENDPOINTS,
  normalizeEndpoints
} from "../../../packages/agents/src/upstream-gateway/support.mjs";

function controllerWithState() {
  const trafficBuckets = new Map();
  const endpointCursors = new Map();
  const endpointCircuits = new Map();
  const controller = createEndpointTrafficController({
    trafficBuckets,
    endpointCursors,
    endpointCircuits,
    appendAudit: vi.fn(),
    recordMetric: vi.fn(),
    persist: vi.fn()
  });
  return { controller, trafficBuckets, endpointCursors, endpointCircuits };
}

function serviceWithEndpoints(endpoints) {
  return {
    serviceId: "svc_weighted",
    baseUrl: endpoints[0]?.baseUrl || "https://service.invalid:443",
    endpoints: endpoints.map((endpoint) => ({
      baseUrl: "https://service.invalid:443",
      trafficPolicySource: "service",
      trafficPolicyInherited: true,
      circuitBreaker: {
        enabled: true,
        failureThreshold: 3,
        cooldownMs: 60_000
      },
      ...endpoint
    })),
    trafficPolicy: {
      perMinute: 10_000,
      burst: 10_000,
      maxConcurrent: 10_000
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 3,
      cooldownMs: 60_000
    }
  };
}

describe("upstream endpoint traffic state retirement", () => {
  it("reclaims every updated or removed service key without disturbing active services", () => {
    const { controller, trafficBuckets, endpointCursors, endpointCircuits } = controllerWithState();
    trafficBuckets.set("svc_retired::read", { tokens: 0 });
    trafficBuckets.set("svc_retired::read::secondary", { tokens: 0 });
    endpointCursors.set("svc_retired::read", 12);
    endpointCircuits.set("svc_retired::read::primary", { consecutiveFailures: 3 });
    trafficBuckets.set("svc_active::read", { tokens: 1 });
    endpointCursors.set("svc_active::read", 2);
    endpointCircuits.set("svc_active::read::primary", { consecutiveFailures: 0 });

    expect(controller.retireServices(["svc_retired"])).toEqual({ removed: 4 });
    expect([...trafficBuckets.keys()]).toEqual(["svc_active::read"]);
    expect([...endpointCursors.keys()]).toEqual(["svc_active::read"]);
    expect([...endpointCircuits.keys()]).toEqual(["svc_active::read::primary"]);
    expect(controller.retireServices(["svc_retired"])).toEqual({ removed: 0 });
  });

  it("provides smooth weighted fairness with one bounded endpoint pass", async () => {
    const { controller, endpointCursors } = controllerWithState();
    const service = serviceWithEndpoints([
      { endpointId: "heavy", weight: 5 },
      { endpointId: "medium", weight: 3 },
      { endpointId: "light", weight: 2 }
    ]);
    const operation = { operationKey: "read", protocol: "http" };
    const selected = [];
    for (let index = 0; index < 100; index += 1) {
      selected.push(await controller.withTrafficSlot(
        service,
        operation,
        {},
        async (_traffic, endpoint) => endpoint.endpointId
      ));
    }
    expect(Object.fromEntries(
      ["heavy", "medium", "light"].map((endpointId) => [
        endpointId,
        selected.filter((value) => value === endpointId).length
      ])
    )).toEqual({ heavy: 50, medium: 30, light: 20 });
    expect(endpointCursors.get("svc_weighted::read")).toMatchObject({
      signature: JSON.stringify([
        ["heavy", 5],
        ["medium", 3],
        ["light", 2]
      ])
    });
  });

  it("does not accumulate unavailable-endpoint debt or recovery bursts", async () => {
    const { controller, endpointCircuits } = controllerWithState();
    const service = serviceWithEndpoints([
      { endpointId: "heavy", weight: 10 },
      { endpointId: "light", weight: 1 }
    ]);
    const operation = { operationKey: "read", protocol: "http" };
    endpointCircuits.set("svc_weighted::read::heavy", {
      consecutiveFailures: 3,
      openedUntilMs: Date.now() + 60_000
    });
    for (let index = 0; index < 20; index += 1) {
      await expect(controller.withTrafficSlot(
        service,
        operation,
        {},
        async (_traffic, endpoint) => endpoint.endpointId
      )).resolves.toBe("light");
    }
    endpointCircuits.set("svc_weighted::read::heavy", {
      consecutiveFailures: 0,
      openedUntilMs: 0
    });
    const recovered = [];
    for (let index = 0; index < 11; index += 1) {
      recovered.push(await controller.withTrafficSlot(
        service,
        operation,
        {},
        async (_traffic, endpoint) => endpoint.endpointId
      ));
    }
    expect(recovered.filter((value) => value === "heavy")).toHaveLength(10);
    expect(recovered.filter((value) => value === "light")).toHaveLength(1);
  });

  it("checks each configured endpoint once when every circuit is open", () => {
    const { controller, endpointCursors, endpointCircuits } = controllerWithState();
    const endpoints = Array.from(
      { length: MAX_UPSTREAM_ENDPOINTS },
      (_unused, index) => ({
        endpointId: `endpoint-${index}`,
        weight: 16
      })
    );
    const service = serviceWithEndpoints(endpoints);
    const operation = { operationKey: "read", protocol: "http" };
    for (const endpoint of endpoints) {
      endpointCircuits.set(`svc_weighted::read::${endpoint.endpointId}`, {
        consecutiveFailures: 3,
        openedUntilMs: Date.now() + 60_000
      });
    }
    expect(controller.selectEndpointTraffic(
      service,
      operation,
      { consume: true }
    ).traffic.allowed).toBe(false);
    const weights = endpointCursors.get("svc_weighted::read").currentWeights;
    expect(Object.keys(weights)).toHaveLength(MAX_UPSTREAM_ENDPOINTS);
    expect(Object.values(weights).every((value) => value === 0)).toBe(true);
  });

  it("fails immediately when every configured endpoint is disabled", () => {
    const { controller, endpointCursors } = controllerWithState();
    const service = serviceWithEndpoints([
      { endpointId: "first", weight: 5, disabled: true },
      { endpointId: "second", weight: 3, disabled: true }
    ]);
    const selected = controller.selectEndpointTraffic(
      service,
      { operationKey: "read", protocol: "http" },
      { consume: true }
    );
    expect(selected).toMatchObject({
      endpoint: null,
      traffic: {
        allowed: false,
        deniedReason: "no_enabled_endpoint"
      }
    });
    expect(endpointCursors.size).toBe(0);
  });

  it("rejects endpoint count, identity, weight, and total-weight overflow", () => {
    const endpoint = (index, weight = 1) => ({
      endpointId: `endpoint-${index}`,
      baseUrl: "https://service.invalid:443",
      weight
    });
    expect(() => normalizeEndpoints({
      endpoints: Array.from(
        { length: MAX_UPSTREAM_ENDPOINTS + 1 },
        (_unused, index) => endpoint(index)
      )
    })).toThrow(expect.objectContaining({
      code: "upstream_endpoint_count_exceeded"
    }));
    expect(() => normalizeEndpoints({
      endpoints: [endpoint(1, 101)]
    })).toThrow(expect.objectContaining({
      code: "upstream_endpoint_weight_invalid"
    }));
    expect(() => normalizeEndpoints({
      endpoints: [endpoint(1), endpoint(1)]
    })).toThrow(expect.objectContaining({
      code: "upstream_endpoint_identity_conflict"
    }));
    expect(() => normalizeEndpoints({
      endpoints: Array.from(
        { length: 11 },
        (_unused, index) => endpoint(index, 100)
      )
    })).toThrow(expect.objectContaining({
      code: "upstream_endpoint_total_weight_exceeded"
    }));
  });
});
