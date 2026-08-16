import { describe, expect, it } from "vitest";

import { TRAFFIC_MODELS } from "@meshrix/contracts/agent-mcp-traffic";
import {
  GATEWAY_CHANNEL_PLUGIN_ACTIVATION_CHANGES_TRAFFIC,
  GATEWAY_CHANNELS_CONTRIBUTION_SCHEMA_VERSION,
  GATEWAY_CHANNEL_SELECTION_FIELDS,
  GATEWAY_CHANNEL_SELECTION_SOURCE,
  GATEWAY_DIRECT_CHANNEL_NAME,
  GATEWAY_EXTERNAL_CONFIGURATION_AUTHORITY,
  GATEWAY_EXTERNAL_IMPLICIT_FALLBACK,
  GATEWAY_EXTERNAL_LIFECYCLE_AUTHORITY,
  GATEWAY_EXTERNAL_ADAPTER_KINDS,
  assertGatewayChannel,
  assertGatewayChannelCapabilities,
  assertGatewayDirectionSelection,
  assertGatewayExternalAttachment,
  assertPluginGatewayChannelContribution
} from "@meshrix/contracts/plugins/gateway-channel-contract";
import {
  EXTERNAL_GATEWAY_APPLICATION_STAGE_PORT,
  EXTERNAL_GATEWAY_SELECTION_AUTHORITY,
  EXTERNAL_GATEWAY_WORKSPACE_PORT,
  PLUGIN_LIFECYCLE_ACTIVATION_CHANGES_AVAILABILITY,
  PLUGIN_LIFECYCLE_ACTIVATION_CHANGES_TRAFFIC,
  createPluginActivationResult
} from "@meshrix/contracts/plugins/plugin-confinement-contract";

const capabilities = {
  loadDistribution: "bounded",
  maxConcurrency: 256,
  maxRatePerSecond: 4096,
  circuitBreaker: true,
  overloadShedding: true,
  timeoutMs: 60_000,
  cancellation: true,
  streaming: true,
  backpressure: true,
  degradation: "stable_transport"
};

describe("Gateway channel contract", () => {
  it("accepts the same envelopes for both traffic models through built-in and plugin channels", () => {
    for (const kind of ["built_in", "external"] as const) {
      const channel = assertGatewayChannel({
        channelId: `${kind}:downstream:channel-1`,
        direction: "downstream",
        kind,
        trafficModels: [...TRAFFIC_MODELS],
        externalAdapter: kind === "external" ? "caddy" : null,
        capabilities,
        accepts: () => true,
        execute: async () => ({
          stage: "downstream",
          trafficModel: "gateway_transit",
          envelopeRef: "e-1",
          status: "admitted",
          normalizedOutcomeRef: null,
          errorRef: null,
          generationRef: null
        })
      });
      expect(channel.trafficModels).toEqual(TRAFFIC_MODELS);
      expect(channel.accepts(null as never)).toBe(true);
    }
  });

  it("keeps channel capabilities bounded and stable", () => {
    expect(assertGatewayChannelCapabilities(capabilities).degradation).toBe("stable_transport");
    expect(() => assertGatewayChannelCapabilities({
      ...capabilities,
      loadDistribution: "unbounded"
    })).toThrow("gateway_channel_load_distribution_must_be_bounded");
    expect(() => assertGatewayChannelCapabilities({
      ...capabilities,
      maxConcurrency: 0
    })).toThrow("gateway_channel_concurrency_out_of_bounds");
  });

  it("freezes the gatewayChannels plugin contribution", () => {
    const contribution = assertPluginGatewayChannelContribution({
      schemaVersion: GATEWAY_CHANNELS_CONTRIBUTION_SCHEMA_VERSION,
      kind: "gatewayChannels",
      channels: [{
        channelId: "built_in:upstream:channel-1",
        direction: "upstream",
        kind: "built_in",
        trafficModels: [...TRAFFIC_MODELS],
        externalAdapter: null,
        capabilities,
        accepts: () => true,
        execute: async () => ({
          stage: "upstream",
          trafficModel: "gateway_transit",
          envelopeRef: "e-2",
          status: "admitted",
          normalizedOutcomeRef: null,
          errorRef: null,
          generationRef: null
        })
      }]
    });
    expect(contribution.kind).toBe("gatewayChannels");
    expect(Object.isFrozen(contribution.channels)).toBe(true);
  });

  it("keeps plugin activation availability-only and selection Console-only", () => {
    expect(GATEWAY_CHANNEL_PLUGIN_ACTIVATION_CHANGES_TRAFFIC).toBe(false);
    expect(PLUGIN_LIFECYCLE_ACTIVATION_CHANGES_TRAFFIC).toBe(false);
    expect(PLUGIN_LIFECYCLE_ACTIVATION_CHANGES_AVAILABILITY).toBe(true);
    const activation = createPluginActivationResult(["caddy", "nginx", "direct"]);
    expect(activation.trafficChanged).toBe(false);
    expect(GATEWAY_CHANNEL_SELECTION_SOURCE).toBe("meshrix_console_administrator");
    expect(GATEWAY_CHANNEL_SELECTION_FIELDS).toEqual(["direction", "channelId"]);
    expect(() => assertGatewayDirectionSelection({
      schemaVersion: "v0.0.1:gateway:channel-contract-1",
      direction: "downstream",
      channelId: "external:downstream:caddy",
      generation: 3,
      source: "plugin_runtime"
    })).toThrow("gateway_direction_selection_console_only");
    expect(assertGatewayDirectionSelection({
      schemaVersion: "v0.0.1:gateway:channel-contract-1",
      direction: "downstream",
      channelId: "external:downstream:caddy",
      generation: 3,
      source: "meshrix_console_administrator"
    }).source).toBe("meshrix_console_administrator");
  });

  it("attaches Caddy and Nginx only to existing independent instances and keeps direct explicit", () => {
    expect(GATEWAY_EXTERNAL_ADAPTER_KINDS).toEqual(["caddy", "nginx", "direct"]);
    expect(GATEWAY_DIRECT_CHANNEL_NAME).toBe("direct");
    expect(GATEWAY_EXTERNAL_CONFIGURATION_AUTHORITY).toBe("none");
    expect(GATEWAY_EXTERNAL_LIFECYCLE_AUTHORITY).toBe("none");
    expect(GATEWAY_EXTERNAL_IMPLICIT_FALLBACK).toBe(false);
    for (const adapter of ["caddy", "nginx"] as const) {
      expect(assertGatewayExternalAttachment({
        adapter,
        endpointRef: `${adapter}-operator-endpoint`,
        instanceOwnership: "operator_existing",
        configurationAuthority: "none",
        lifecycleAuthority: "none",
        implicitFallback: false
      }).instanceOwnership).toBe("operator_existing");
    }
    expect(assertGatewayExternalAttachment({
      adapter: "direct",
      endpointRef: "direct-operator-endpoint",
      instanceOwnership: "operator_endpoint",
      configurationAuthority: "none",
      lifecycleAuthority: "none",
      implicitFallback: false
    }).implicitFallback).toBe(false);
    expect(assertGatewayChannel({
      channelId: "external:upstream:direct",
      direction: "upstream",
      kind: "external",
      trafficModels: [...TRAFFIC_MODELS],
      externalAdapter: "direct",
      capabilities,
      accepts: () => true,
      execute: async () => ({ status: "admitted" })
    }).externalAdapter).toBe("direct");
    expect(() => assertGatewayExternalAttachment({
      adapter: "nginx",
      endpointRef: "nginx-operator-endpoint",
      instanceOwnership: "operator_existing",
      configurationAuthority: "none",
      lifecycleAuthority: "restart",
      implicitFallback: false
    })).toThrow("gateway_external_attachment_authority_forbidden");
    expect(EXTERNAL_GATEWAY_WORKSPACE_PORT).toBe("none");
    expect(EXTERNAL_GATEWAY_APPLICATION_STAGE_PORT).toBe("none");
    expect(EXTERNAL_GATEWAY_SELECTION_AUTHORITY).toBe("none");
    expect(() => assertGatewayChannel({
      channelId: "built_in:downstream:bad",
      direction: "downstream",
      kind: "built_in",
      trafficModels: [...TRAFFIC_MODELS],
      externalAdapter: "nginx",
      capabilities,
      accepts: () => true,
      execute: async () => ({})
    })).toThrow("gateway_channel_built_in_has_no_external_adapter");
  });
});
