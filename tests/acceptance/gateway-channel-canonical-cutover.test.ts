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
    externalAdapter: kind === "external" ? "caddy" : null,
    capabilities: Object.freeze({
      loadDistribution: "bounded", maxConcurrency: 8, maxRatePerSecond: 64,
      circuitBreaker: true, overloadShedding: true, timeoutMs: 1_000,
      cancellation: true, streaming: true, backpressure: true, degradation: "stable_transport",
    }),
    accepts: () => true,
    execute: async () => Object.freeze({ status: "admitted", envelopeRef: channelId }),
  });
}

describe("Gateway channel canonical cutover", () => {
  it("plugin activation changes availability without changing traffic", () => {
    const router = createGatewayChannelRouter({
      downstream: channel("built-in:downstream", "downstream", "built_in"),
      upstream: channel("built-in:upstream", "upstream", "built_in"),
    });
    const before = router.snapshot();
    router.registerContribution("external-gateway", Object.freeze({
      schemaVersion: GATEWAY_CHANNELS_CONTRIBUTION_SCHEMA_VERSION, kind: "gatewayChannels",
      channels: [channel("external:downstream", "downstream", "external"), channel("external:upstream", "upstream", "external")],
    }));
    const after = router.snapshot();

    expect(after.available.downstream).toContain("external:downstream");
    expect(after.available.upstream).toContain("external:upstream");
    expect(after.selections).toEqual(before.selections);
  });

  it("an unavailable selected plugin channel fails without built-in fallback", () => {
    const router = createGatewayChannelRouter({
      downstream: channel("built-in:downstream", "downstream", "built_in"),
      upstream: channel("built-in:upstream", "upstream", "built_in"),
    });
    router.registerContribution("external-gateway", Object.freeze({
      schemaVersion: GATEWAY_CHANNELS_CONTRIBUTION_SCHEMA_VERSION, kind: "gatewayChannels",
      channels: [channel("external:downstream", "downstream", "external")],
    }));
    router.select({ direction: "downstream", channelId: "external:downstream", source: "meshrix_console_administrator" });
    router.removeContribution("external-gateway");

    expect(() => router.pin("downstream", "gateway_transit")).toThrow("gateway_selected_channel_unavailable");
    expect(router.snapshot().selections.downstream.channelId).toBe("external:downstream");
  });
});
