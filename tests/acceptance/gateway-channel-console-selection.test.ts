import { describe, expect, it } from "vitest";

import {
  GATEWAY_CHANNELS_CONTRIBUTION_SCHEMA_VERSION,
  type GatewayChannel,
  type GatewayDirection
} from "@meshrix/contracts/plugins/gateway-channel-contract";
import { createGatewayChannelRouter } from "../../packages/server-runtime/src/composition/gateway-channel-router.ts";

function channel(channelId: string, direction: GatewayDirection, kind: "built_in" | "external"): GatewayChannel {
  return Object.freeze({
    channelId, direction, kind,
    trafficModels: ["workspace_application", "gateway_transit"],
    externalAdapter: kind === "external" ? "nginx" : null,
    capabilities: Object.freeze({
      loadDistribution: "bounded", maxConcurrency: 4, maxRatePerSecond: 32,
      circuitBreaker: true, overloadShedding: true, timeoutMs: 750,
      cancellation: true, streaming: true, backpressure: true, degradation: "stable_transport",
    }),
    accepts: () => true,
    execute: async () => Object.freeze({ status: "admitted", envelopeRef: channelId }),
  });
}

describe("Console-only Gateway selection", () => {
  it("changes only the explicitly selected direction and pins in-flight generations", () => {
    const router = createGatewayChannelRouter({
      downstream: channel("built-in:downstream", "downstream", "built_in"),
      upstream: channel("built-in:upstream", "upstream", "built_in"),
    });
    router.registerContribution("external-gateway", Object.freeze({
      schemaVersion: GATEWAY_CHANNELS_CONTRIBUTION_SCHEMA_VERSION, kind: "gatewayChannels",
      channels: [channel("external:downstream", "downstream", "external"), channel("external:upstream", "upstream", "external")],
    }));
    const oldDownstream = router.pin("downstream", "workspace_application");
    const oldUpstream = router.pin("upstream", "workspace_application");

    const committed = router.select({
      direction: "downstream", channelId: "external:downstream", source: "meshrix_console_administrator",
    });
    const snapshot = router.snapshot();

    expect(committed.generation).toBe(1);
    expect(snapshot.selections.downstream.channelId).toBe("external:downstream");
    expect(snapshot.selections.upstream.channelId).toBe("built-in:upstream");
    expect(oldDownstream.channelId).toBe("built-in:downstream");
    expect(oldUpstream.channelId).toBe("built-in:upstream");
  });

  it("rejects non-Console selection authority", () => {
    const router = createGatewayChannelRouter({
      downstream: channel("built-in:downstream", "downstream", "built_in"),
      upstream: channel("built-in:upstream", "upstream", "built_in"),
    });
    expect(() => router.select({ direction: "downstream", channelId: "built-in:downstream", source: "plugin_activation" }))
      .toThrow("gateway_direction_selection_console_only");
  });
});
