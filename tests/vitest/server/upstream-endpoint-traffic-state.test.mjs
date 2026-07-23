import { describe, expect, it, vi } from "vitest";

import { createEndpointTrafficController } from "../../../packages/agents/src/upstream-gateway/endpoint-traffic.mjs";

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
});
