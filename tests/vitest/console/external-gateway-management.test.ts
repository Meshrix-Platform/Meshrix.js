import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nextTick, ref } from "vue";
import { createConsoleExternalGatewayController } from "../../../apps/console/composables/console-external-gateway-controller";

describe("External Gateway console controller", () => {
  it("keeps empty configuration in Direct mode and reflects server state", async () => {
    const state = ref(null);
    const controller = createConsoleExternalGatewayController(state);

    expect(controller.activeMode.value).toBe("direct");
    expect(controller.availableAdapters.value).toEqual([]);
    expect(controller.publicBaseUrlDraft.value).toBe("");

    state.value = {
      mode: "external",
      adapterId: "nginx",
      generation: 2,
      availableAdapters: [{ adapterId: "nginx", label: "Nginx" }],
    };

    expect(controller.activeMode.value).toBe("external");
    expect(controller.activeAdapter.value).toBe("nginx");

    state.value = {
      ...state.value,
      profile: { gatewayMode: { publicBaseUrl: "https://gateway.example.invalid:8443" } },
    };
    await nextTick();
    expect(controller.publicBaseUrlDraft.value).toBe("https://gateway.example.invalid:8443");
  });

  it("uses the External Gateway product name and removes the fixed gateway mount placeholder", async () => {
    const defaults = await import("../../../apps/console/composables/console-defaults");
    const panelPath = fileURLToPath(new URL(
      "../../../apps/console/components/admin/modules/RuntimeModulesPanel.vue",
      import.meta.url,
    ));
    const panel = readFileSync(panelPath, "utf8");

    expect(defaults.moduleNameLabels).not.toHaveProperty("gateway");
    expect(defaults.moduleGroupDefinitions.map((group) => group.id)).not.toContain("gateway");
    expect(panel).toContain("外置网关");
    expect(panel).toContain("Caddy");
    expect(panel).toContain("Nginx");
    expect(panel).toContain("外置网关访问地址");
    expect(panel).toContain("IP 地址或域名");
    expect(panel).toContain("验证并启用");
    expect(panel).not.toContain("网关程序路径");
    expect(panel).not.toContain("配置输出目录");
    expect(panel).not.toContain("填写外置模块 .mjs 路径");
  });
});
