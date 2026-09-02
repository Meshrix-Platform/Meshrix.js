import { describe, expect, it, vi } from "vitest";

import { createEndpointTrafficController } from "../../../packages/agents/src/upstream-gateway/endpoint-traffic.ts";
import {
  MAX_UPSTREAM_ENDPOINTS,
  normalizeEndpoints
} from "../../../packages/agents/src/upstream-gateway/support.ts";

function controllerWithState() : any {
  const trafficBuckets: any = new Map<any, any>();
  const endpointCursors: any = new Map<any, any>();
  const endpointCircuits: any = new Map<any, any>();
  const controller: any = createEndpointTrafficController({
    trafficBuckets,
    endpointCursors,
    endpointCircuits,
    appendAudit: vi.fn(),
    recordMetric: vi.fn(),
    persist: vi.fn()
  });
  return { controller, trafficBuckets, endpointCursors, endpointCircuits };
}

function serviceWithEndpoints(endpoints?: any) : any {
  return {
    serviceId: "svc_weighted",
    baseUrl: endpoints[0]?.baseUrl || "https://service.invalid:443",
    endpoints: endpoints.map((endpoint?: any) : any => ({
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

describe("upstream endpoint traffic state retirement", () : any => {
  it("reclaims every updated or removed service key without disturbing active services", () : any => {
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

  it("provides smooth weighted fairness with one bounded endpoint pass", async () : Promise<any> => {
    const { controller, endpointCursors } = controllerWithState();
    const service: any = serviceWithEndpoints([
      { endpointId: "heavy", weight: 5 },
      { endpointId: "medium", weight: 3 },
      { endpointId: "light", weight: 2 }
    ]);
    const operation: Record<string, any> = { operationKey: "read", protocol: "http" };
    const selected: any[] = [];
    for (let index: any = 0; index < 100; index += 1) {
      selected.push(await controller.withTrafficSlot(
        service,
        operation,
        {},
        async (_traffic?: any, endpoint?: any) : Promise<any> => endpoint.endpointId
      ));
    }
    expect(Object.fromEntries(
      ["heavy", "medium", "light"].map((endpointId?: any) : any => [
        endpointId,
        selected.filter((value?: any) : any => value === endpointId).length
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

  it("does not accumulate unavailable-endpoint debt or recovery bursts", async () : Promise<any> => {
    const { controller, endpointCircuits } = controllerWithState();
    const service: any = serviceWithEndpoints([
      { endpointId: "heavy", weight: 10 },
      { endpointId: "light", weight: 1 }
    ]);
    const operation: Record<string, any> = { operationKey: "read", protocol: "http" };
    endpointCircuits.set("svc_weighted::read::heavy", {
      consecutiveFailures: 3,
      openedUntilMs: Date.now() + 60_000
    });
    for (let index: any = 0; index < 20; index += 1) {
      await expect(controller.withTrafficSlot(
        service,
        operation,
        {},
        async (_traffic?: any, endpoint?: any) : Promise<any> => endpoint.endpointId
      )).resolves.toBe("light");
    }
    endpointCircuits.set("svc_weighted::read::heavy", {
      consecutiveFailures: 0,
      openedUntilMs: 0
    });
    const recovered: any[] = [];
    for (let index: any = 0; index < 11; index += 1) {
      recovered.push(await controller.withTrafficSlot(
        service,
        operation,
        {},
        async (_traffic?: any, endpoint?: any) : Promise<any> => endpoint.endpointId
      ));
    }
    expect(recovered.filter((value?: any) : any => value === "heavy")).toHaveLength(10);
    expect(recovered.filter((value?: any) : any => value === "light")).toHaveLength(1);
  });

  it("checks each configured endpoint once when every circuit is open", () : any => {
    const { controller, endpointCursors, endpointCircuits } = controllerWithState();
    const endpoints: any = Array.from(
      { length: MAX_UPSTREAM_ENDPOINTS },
      (_unused?: any, index?: any) : any => ({
        endpointId: `endpoint-${index}`,
        weight: 16
      })
    );
    const service: any = serviceWithEndpoints(endpoints);
    const operation: Record<string, any> = { operationKey: "read", protocol: "http" };
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
    const weights: any = endpointCursors.get("svc_weighted::read").currentWeights;
    expect(Object.keys(weights)).toHaveLength(MAX_UPSTREAM_ENDPOINTS);
    expect((Object.values(weights) as any[]).every((value?: any) : any => value === 0)).toBe(true);
  });

  it("returns a stable reason code when an open circuit denies traffic", async () : Promise<any> => {
    const { controller, endpointCircuits } = controllerWithState();
    const service: any = serviceWithEndpoints([{ endpointId: "primary", weight: 1 }]);
    const operation: Record<string, any> = { operationKey: "read", protocol: "http" };
    endpointCircuits.set("svc_weighted::read::primary", {
      consecutiveFailures: 3,
      openedUntilMs: Date.now() + 60_000
    });
    await expect(controller.withTrafficSlot(
      service,
      operation,
      {},
      async () : Promise<any> => "unreachable"
    )).rejects.toMatchObject({
      code: "upstream_gateway_circuit_open",
      reasonCode: "upstream_gateway_circuit_open",
      status: 429,
      details: { traffic: { deniedReason: "circuit_open" } }
    });
  });

  it("fails immediately when every configured endpoint is disabled", () : any => {
    const { controller, endpointCursors } = controllerWithState();
    const service: any = serviceWithEndpoints([
      { endpointId: "first", weight: 5, disabled: true },
      { endpointId: "second", weight: 3, disabled: true }
    ]);
    const selected: any = controller.selectEndpointTraffic(
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

  it("rejects endpoint count, identity, weight, and total-weight overflow", () : any => {
    const endpoint: any = (index?: any, weight: any = 1) : any => ({
      endpointId: `endpoint-${index}`,
      baseUrl: "https://service.invalid:443",
      weight
    });
    expect(() : any => normalizeEndpoints({
      endpoints: Array.from(
        { length: MAX_UPSTREAM_ENDPOINTS + 1 },
        (_unused?: any, index?: any) : any => endpoint(index)
      )
    })).toThrow(expect.objectContaining({
      code: "upstream_endpoint_count_exceeded"
    }));
    expect(() : any => normalizeEndpoints({
      endpoints: [endpoint(1, 101)]
    })).toThrow(expect.objectContaining({
      code: "upstream_endpoint_weight_invalid"
    }));
    expect(() : any => normalizeEndpoints({
      endpoints: [endpoint(1), endpoint(1)]
    })).toThrow(expect.objectContaining({
      code: "upstream_endpoint_identity_conflict"
    }));
    expect(() : any => normalizeEndpoints({
      endpoints: Array.from(
        { length: 11 },
        (_unused?: any, index?: any) : any => endpoint(index, 100)
      )
    })).toThrow(expect.objectContaining({
      code: "upstream_endpoint_total_weight_exceeded"
    }));
  });
});
