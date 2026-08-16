import { getJson, postJson } from "@meshrix/ui-console/bridge-http";

export type GatewayDirection = "downstream" | "upstream";

export type GatewayChannelSelection = {
  schemaVersion: string;
  direction: GatewayDirection;
  channelId: string;
  generation: number;
  source: string;
};

export type GatewayChannelState = {
  ok: boolean;
  available: Record<GatewayDirection, string[]>;
  selections: Record<GatewayDirection, GatewayChannelSelection>;
};

export function getGatewayChannels(): Promise<GatewayChannelState> {
  return getJson<GatewayChannelState>("/api/runtime/gateway-channels");
}

export function selectGatewayChannel(input: {
  direction: GatewayDirection;
  channelId: string;
  expectedGeneration: number;
}): Promise<GatewayChannelState> {
  return postJson<GatewayChannelState>("/api/runtime/gateway-channels/select", input, { safetyConfirm: true });
}
