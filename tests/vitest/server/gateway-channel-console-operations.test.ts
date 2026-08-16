import { describe, expect, it } from "vitest";

import {
  assertGatewayChannel,
  assertPluginGatewayChannelContribution
} from "@meshrix/contracts/plugins/gateway-channel-contract";
import {
  BUILT_IN_UPSTREAM_CHANNEL_ID,
  createBuiltInGatewayChannel,
  createGatewayChannelRouter,
  type GatewayChannelRouter
} from "../../../packages/server-runtime/src/composition/gateway-channel-router.ts";
import {
  executeRuntimeMountOperation
} from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/runtime-admin-executors.ts";

function consoleSession(): Record<string, unknown> {
  return { user: { userId: "fixture-owner" } };
}

interface OperationResponse {
  readonly status: number;
  readonly payload?: Record<string, unknown>;
  readonly body?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

function responsePayload(response: OperationResponse): Record<string, unknown> {
  return response.payload ?? response.body ?? response;
}

function fixtureRouter(): GatewayChannelRouter {
  const router = createGatewayChannelRouter({
    downstream: createBuiltInGatewayChannel("downstream"),
    upstream: createBuiltInGatewayChannel("upstream")
  });
  const channel = assertGatewayChannel({
    channelId: "fixture.external.downstream",
    direction: "downstream",
    kind: "external",
    trafficModels: ["workspace_application", "gateway_transit"],
    externalAdapter: "direct",
    capabilities: {
      loadDistribution: "bounded",
      maxConcurrency: 1,
      maxRatePerSecond: 1,
      circuitBreaker: true,
      overloadShedding: true,
      timeoutMs: 1_000,
      cancellation: true,
      streaming: true,
      backpressure: true,
      degradation: "stable_transport"
    },
    accepts: () => true,
    execute: async () => ({ stage: "downstream", status: "admitted" })
  });
  router.registerContribution("fixture", assertPluginGatewayChannelContribution({
    schemaVersion: "v0.0.1:plugin:gateway-channels-1",
    kind: "gatewayChannels",
    channels: [channel]
  }));
  return router;
}

describe("Gateway channel Console operations", () => {
  it("requires a Console session before reading or selecting", async () => {
    const router = fixtureRouter();
    const before = router.snapshot();
    const response = await executeRuntimeMountOperation({
      operationId: "runtime.gateway_channels.select",
      input: { direction: "downstream", channelId: "fixture.external.downstream", expectedGeneration: 0 },
      context: { gatewayChannelRouter: router }
    });
    expect(response.status).toBe(403);
    expect(responsePayload(response)).toMatchObject({
      error: { code: "gateway_channel_console_session_required" }
    });
    expect(router.snapshot()).toEqual(before);
  });

  it("switches only the requested direction and advances only its generation", async () => {
    const router = fixtureRouter();
    const response = await executeRuntimeMountOperation({
      operationId: "runtime.gateway_channels.select",
      input: { direction: "downstream", channelId: "fixture.external.downstream", expectedGeneration: 0 },
      context: { gatewayChannelRouter: router, authSession: consoleSession() }
    });
    const payload = responsePayload(response);
    expect(response.status).toBe(200);
    expect(payload.selections.downstream).toMatchObject({ channelId: "fixture.external.downstream", generation: 1 });
    expect(payload.selections.upstream).toMatchObject({ channelId: BUILT_IN_UPSTREAM_CHANNEL_ID, generation: 0 });
  });

  it("rejects stale and unavailable selections without changing either direction", async () => {
    const router = fixtureRouter();
    const first = await executeRuntimeMountOperation({
      operationId: "runtime.gateway_channels.select",
      input: { direction: "downstream", channelId: "fixture.external.downstream", expectedGeneration: 0 },
      context: { gatewayChannelRouter: router, authSession: consoleSession() }
    });
    expect(first.status).toBe(200);
    const before = router.snapshot();
    const stale = await executeRuntimeMountOperation({
      operationId: "runtime.gateway_channels.select",
      input: { direction: "downstream", channelId: "fixture.external.downstream", expectedGeneration: 0 },
      context: { gatewayChannelRouter: router, authSession: consoleSession() }
    });
    const unavailable = await executeRuntimeMountOperation({
      operationId: "runtime.gateway_channels.select",
      input: { direction: "upstream", channelId: "missing.channel", expectedGeneration: 0 },
      context: { gatewayChannelRouter: router, authSession: consoleSession() }
    });
    expect(stale.status).toBe(409);
    expect(responsePayload(stale)).toMatchObject({ error: { code: "gateway_channel_selection_stale" } });
    expect(unavailable.status).toBe(409);
    expect(responsePayload(unavailable)).toMatchObject({ error: { code: "gateway_selected_channel_unavailable" } });
    expect(router.snapshot()).toEqual(before);
  });
});
