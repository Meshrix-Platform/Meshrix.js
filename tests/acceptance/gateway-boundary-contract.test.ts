import { describe, expect, it } from "vitest";

import { runGatewayBoundaryFinalScenario } from "../../tools/server-scripts/gateway-boundary-final.ts";

describe("Gateway boundary contract acceptance", () => {
  it("closes the sequential dual-Gateway, detachment, and one-way maintenance boundary", async () => {
    const receipt = await runGatewayBoundaryFinalScenario();

    expect(receipt).toEqual({
      schemaVersion: "v0.0.1:gateway-boundary-final:receipt-1",
      ok: true,
      trafficModels: 2,
      mandatoryStageOrders: 8,
      transitWorkspaceCalls: 0,
      consoleDirectionSwitches: 4,
      pinnedDrain: { downstreamGeneration: 1, upstreamGeneration: 0 },
      hiddenFallbackCalls: 0,
      modelGateway: {
        disabledOperations: 0,
        attachedServiceCalls: 2,
        postDetachServiceCalls: 0
      },
      maintenance: {
        configurationInputs: 1,
        inboundControlSurfaces: 0,
        meshrixInboundEdges: 0
      }
    });
  });
});
