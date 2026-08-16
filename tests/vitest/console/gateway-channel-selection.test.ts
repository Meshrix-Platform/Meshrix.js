import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nextTick, ref } from "vue";

import {
  createConsoleGatewayChannelController,
  type ConsoleGatewayChannelController
} from "../../../apps/console/composables/console-gateway-channel-controller";
import type { GatewayChannelState } from "../../../apps/console/lib/gateway-channel-client";

describe("Gateway channel Console controller", () => {
  it("keeps downstream and upstream drafts independent and reflects server generations", async () => {
    const state = ref<GatewayChannelState | null>(null);
    const controller: ConsoleGatewayChannelController = createConsoleGatewayChannelController(state);
    expect(controller.downstream.available.value).toEqual([]);
    expect(controller.upstream.available.value).toEqual([]);

    state.value = {
      ok: true,
      available: {
        downstream: ["meshrix.built-in.downstream", "external-gateway.caddy.downstream"],
        upstream: ["meshrix.built-in.upstream", "external-gateway.nginx.upstream"]
      },
      selections: {
        downstream: { channelId: "meshrix.built-in.downstream", generation: 2 },
        upstream: { channelId: "external-gateway.nginx.upstream", generation: 5 }
      }
    };
    await nextTick();
    expect(controller.downstream.draft.value).toBe("meshrix.built-in.downstream");
    expect(controller.upstream.draft.value).toBe("external-gateway.nginx.upstream");
    controller.downstream.draft.value = "external-gateway.caddy.downstream";
    expect(controller.downstream.changed.value).toBe(true);
    expect(controller.upstream.changed.value).toBe(false);
    expect(controller.downstream.generation.value).toBe(2);
    expect(controller.upstream.generation.value).toBe(5);
  });

  it("renders explicit per-direction selection without proxy lifecycle controls", () => {
    const panelPath = fileURLToPath(new URL(
      "../../../apps/console/components/admin/modules/RuntimeModulesPanel.vue",
      import.meta.url
    ));
    const panel = readFileSync(panelPath, "utf8");
    expect(panel).toContain("下游 Gateway");
    expect(panel).toContain("上游 Gateway");
    expect(panel).toContain("应用下游通道");
    expect(panel).toContain("应用上游通道");
    expect(panel).toContain("启用插件只增加可选项，不会自动改变流量");
    expect(panel).not.toContain("Caddy");
    expect(panel).not.toContain("Nginx");
    expect(panel).not.toContain("外置网关访问地址");
    expect(panel).not.toContain("验证并启用");
  });
});
