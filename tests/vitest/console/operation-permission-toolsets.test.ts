// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setConsoleLocaleState } from "../../../apps/console/i18n/console-locale-state";
import { operationPermissionToolsetName } from "../../../apps/console/i18n/operation-permission-toolsets";
import { toolsetLabel } from "../../../apps/console/composables/console-tool-display-utils";

describe("operation permission toolset labels", () => {
  afterEach(() => {
    setConsoleLocaleState("zh-CN");
  });

  it("localizes known toolset ids for Chinese and English locales", () => {
    setConsoleLocaleState("zh-CN");
    expect(operationPermissionToolsetName("meshrix.gateway.read", "Gateway read")).toBe("网关读取");
    expect(operationPermissionToolsetName("meshrix.agent.workspace", "Agent workspace")).toBe("智能体工作空间");

    setConsoleLocaleState("en");
    expect(operationPermissionToolsetName("meshrix.gateway.read", "Gateway read")).toBe("Gateway read");
  });

  it("falls back through toolsetLabel for unknown ids", () => {
    setConsoleLocaleState("zh-CN");
    expect(toolsetLabel("custom.toolset", [{ id: "custom.toolset", label: "Custom", requiredScopes: [], maxRisk: "low" } as any])).toBe("Custom");
    expect(operationPermissionToolsetName("missing.toolset", "Fallback")).toBe("Fallback");
  });
});
