import {
  GATEWAY_CHANNEL_SELECTION_SOURCE,
  assertGatewayChannel,
  assertPluginGatewayChannelContribution,
  type GatewayChannel,
  type GatewayChannelExecutionResult,
  type GatewayChannelSelection,
  type GatewayChannelsPluginContribution,
  type GatewayDirection,
} from "@meshrix/contracts/plugins/gateway-channel-contract";
import type { TrafficModel } from "@meshrix/contracts/agent-mcp-traffic";

export const BUILT_IN_DOWNSTREAM_CHANNEL_ID = "meshrix.built-in.downstream";
export const BUILT_IN_UPSTREAM_CHANNEL_ID = "meshrix.built-in.upstream";

export function createBuiltInGatewayChannel(direction: GatewayDirection): GatewayChannel {
  return assertGatewayChannel({
    channelId: direction === "downstream" ? BUILT_IN_DOWNSTREAM_CHANNEL_ID : BUILT_IN_UPSTREAM_CHANNEL_ID,
    direction,
    kind: "built_in",
    trafficModels: ["workspace_application", "gateway_transit"],
    externalAdapter: null,
    capabilities: {
      loadDistribution: "bounded",
      maxConcurrency: 1_024,
      maxRatePerSecond: 100_000,
      circuitBreaker: true,
      overloadShedding: true,
      timeoutMs: 300_000,
      cancellation: true,
      streaming: true,
      backpressure: true,
      degradation: "stable_transport",
    },
    accepts(value: unknown): boolean {
      if (!value || typeof value !== "object" || !Object.isFrozen(value)) return false;
      return (value as { stage?: unknown }).stage === direction;
    },
    async execute(value: unknown): Promise<GatewayChannelExecutionResult> {
      if (!value || typeof value !== "object") throw new Error("gateway_builtin_envelope_invalid");
      return Object.freeze({
        stage: direction,
        envelopeRef: `${direction}:built-in`,
        status: "admitted",
        normalizedOutcomeRef: `${direction}:admitted`,
        errorRef: null,
        generationRef: null,
      });
    },
  });
}

export interface PinnedGatewayChannel {
  readonly channel: GatewayChannel;
  readonly channelId: string;
  readonly direction: GatewayDirection;
  readonly generation: number;
}

export interface GatewayChannelRouterSnapshot {
  readonly available: Readonly<Record<GatewayDirection, readonly string[]>>;
  readonly selections: Readonly<Record<GatewayDirection, GatewayChannelSelection>>;
}

export interface GatewayChannelRouter {
  registerContribution(pluginId: string, contribution: unknown): void;
  removeContribution(pluginId: string): void;
  select(input: Readonly<{ direction: GatewayDirection; channelId: string; source: string }>): GatewayChannelSelection;
  pin(direction: GatewayDirection, trafficModel: TrafficModel): PinnedGatewayChannel;
  execute(pin: PinnedGatewayChannel, envelope: unknown): Promise<GatewayChannelExecutionResult>;
  snapshot(): GatewayChannelRouterSnapshot;
}

function selection(direction: GatewayDirection, channelId: string, generation: number): GatewayChannelSelection {
  return Object.freeze({
    schemaVersion: "v0.0.1:meshrix:gateway-channel-selection-1",
    direction,
    channelId,
    generation,
    source: GATEWAY_CHANNEL_SELECTION_SOURCE,
  });
}

export function createGatewayChannelRouter(input: Readonly<{
  downstream: GatewayChannel;
  upstream: GatewayChannel;
}>): GatewayChannelRouter {
  const builtIns = Object.freeze({
    downstream: assertGatewayChannel(input.downstream),
    upstream: assertGatewayChannel(input.upstream),
  });
  if (builtIns.downstream.direction !== "downstream" || builtIns.upstream.direction !== "upstream") {
    throw new Error("gateway_builtin_direction_invalid");
  }
  if (builtIns.downstream.kind !== "built_in" || builtIns.upstream.kind !== "built_in") {
    throw new Error("gateway_builtin_kind_required");
  }

  const contributions = new Map<string, GatewayChannelsPluginContribution>();
  const selections: Record<GatewayDirection, GatewayChannelSelection> = {
    downstream: selection("downstream", builtIns.downstream.channelId, 0),
    upstream: selection("upstream", builtIns.upstream.channelId, 0),
  };

  function available(direction: GatewayDirection): Map<string, GatewayChannel> {
    const channels = new Map<string, GatewayChannel>([[builtIns[direction].channelId, builtIns[direction]]]);
    for (const contribution of contributions.values()) {
      for (const channel of contribution.channels) {
        if (channel.direction !== direction) continue;
        if (channels.has(channel.channelId)) throw new Error("gateway_channel_id_conflict");
        channels.set(channel.channelId, channel);
      }
    }
    return channels;
  }

  return Object.freeze({
    registerContribution(pluginId: string, raw: unknown): void {
      if (!pluginId.trim()) throw new Error("gateway_plugin_id_required");
      const contribution = assertPluginGatewayChannelContribution(raw);
      contributions.set(pluginId, contribution);
      available("downstream");
      available("upstream");
    },
    removeContribution(pluginId: string): void {
      contributions.delete(pluginId);
    },
    select(candidate: Readonly<{ direction: GatewayDirection; channelId: string; source: string }>): GatewayChannelSelection {
      if (candidate.source !== GATEWAY_CHANNEL_SELECTION_SOURCE) {
        throw new Error("gateway_direction_selection_console_only");
      }
      const channel = available(candidate.direction).get(candidate.channelId);
      if (!channel) throw new Error("gateway_selected_channel_unavailable");
      const committed = selection(candidate.direction, channel.channelId, selections[candidate.direction].generation + 1);
      selections[candidate.direction] = committed;
      return committed;
    },
    pin(direction: GatewayDirection, trafficModel: TrafficModel): PinnedGatewayChannel {
      const current = selections[direction];
      const channel = available(direction).get(current.channelId);
      if (!channel) throw new Error("gateway_selected_channel_unavailable");
      if (!channel.trafficModels.includes(trafficModel)) throw new Error("gateway_selected_channel_incompatible");
      return Object.freeze({ channel, channelId: channel.channelId, direction, generation: current.generation });
    },
    async execute(pin: PinnedGatewayChannel, envelope: unknown): Promise<GatewayChannelExecutionResult> {
      if (!pin.channel.accepts(envelope)) throw new Error("gateway_channel_envelope_rejected");
      return pin.channel.execute(envelope);
    },
    snapshot(): GatewayChannelRouterSnapshot {
      return Object.freeze({
        available: Object.freeze({
          downstream: Object.freeze([...available("downstream").keys()]),
          upstream: Object.freeze([...available("upstream").keys()]),
        }),
        selections: Object.freeze({ downstream: selections.downstream, upstream: selections.upstream }),
      });
    },
  });
}
