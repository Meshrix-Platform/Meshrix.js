// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ getJson: vi.fn() }));
const rpc = vi.hoisted(() => ({ callRpc: vi.fn() }));

vi.mock("@lico/ui-console/bridge-http", () => bridge);
vi.mock("@lico/ui-console/rpc-client", () => rpc);

import {
  loadStrategyDescription,
  previewStrategyCapability,
} from "../../../apps/console/lib/strategy-management";
import StrategyManagementView from "../../../apps/console/views/admin/StrategyManagementView.vue";

beforeEach(() => {
  vi.clearAllMocks();
  bridge.getJson.mockResolvedValue({
    protocolVersion: "strategy-protocol",
    capabilities: [
      "strategy.describe",
      "strategy.workflow_policy.evaluate",
      "strategy.route_policy.evaluate",
    ],
  });
});

describe("Strategy Management Console", () => {
  it("loads only the server capability description without probing on mount", async () => {
    const wrapper = mount(StrategyManagementView);
    try {
      await flushPromises();
      expect(bridge.getJson).toHaveBeenCalledWith("/api/strategy");
      expect(rpc.callRpc).not.toHaveBeenCalled();
      expect(wrapper.text()).toContain("strategy.workflow_policy.evaluate");
      expect(wrapper.text()).toContain("尚未执行预览");
      expect(wrapper.text()).not.toContain("packages/");
      expect(wrapper.text()).not.toContain("运行时策略");
      expect(wrapper.text()).not.toContain("策略项");
    } finally {
      wrapper.unmount();
    }
  });

  it("keeps a truthful empty state when the server describes no capabilities", async () => {
    bridge.getJson.mockResolvedValue({ protocolVersion: "strategy-protocol", capabilities: [] });
    const wrapper = mount(StrategyManagementView);
    try {
      await flushPromises();
      expect(wrapper.text()).toContain("服务端当前未提供策略能力");
      expect(wrapper.find("select").attributes("disabled")).toBeDefined();
      expect(rpc.callRpc).not.toHaveBeenCalled();
    } finally {
      wrapper.unmount();
    }
  });

  it("runs only an explicitly selected preview and renders bounded public facts", async () => {
    rpc.callRpc.mockResolvedValue({
      effect: "deny",
      reasonCode: "workflow_blocked",
      policyType: "workflow-policy",
      evaluatedLayers: ["strategy_management", "workflow_policy"],
      privatePolicy: "must-not-render",
      subject: "must-not-render",
    });
    const wrapper = mount(StrategyManagementView);
    try {
      await flushPromises();
      await wrapper.find("select").setValue("strategy.workflow_policy.evaluate");
      await wrapper.find("textarea").setValue('{"workflowId":"fixture","blocked":true}');
      await wrapper.find(".strategy-preview-actions button").trigger("click");
      await flushPromises();

      expect(rpc.callRpc).toHaveBeenCalledWith("strategy.workflow_policy.evaluate", {
        workflowId: "fixture",
        blocked: true,
      });
      expect(wrapper.attributes("data-preview-state")).toBe("denied");
      expect(wrapper.text()).toContain("workflow_blocked");
      expect(wrapper.text()).not.toContain("must-not-render");
    } finally {
      wrapper.unmount();
    }
  });

  it("bounds invalid input and request failures as error state", async () => {
    const wrapper = mount(StrategyManagementView);
    try {
      await flushPromises();
      await wrapper.find("select").setValue("strategy.route_policy.evaluate");
      await wrapper.find("textarea").setValue("[]");
      await wrapper.find(".strategy-preview-actions button").trigger("click");
      expect(wrapper.attributes("data-preview-state")).toBe("error");
      expect(wrapper.text()).toContain("JSON 对象");
      expect(rpc.callRpc).not.toHaveBeenCalled();

      rpc.callRpc.mockRejectedValue(new Error("preview_unavailable"));
      await wrapper.find("textarea").setValue('{"routeId":"fixture"}');
      await wrapper.find(".strategy-preview-actions button").trigger("click");
      await flushPromises();
      expect(wrapper.attributes("data-preview-state")).toBe("error");
      expect(wrapper.text()).toContain("策略预览失败");
      expect(wrapper.text()).not.toContain("preview_unavailable");
    } finally {
      wrapper.unmount();
    }
  });
});

describe("Strategy Management client", () => {
  it("deduplicates and bounds description capabilities", async () => {
    bridge.getJson.mockResolvedValue({
      protocolVersion: " strategy-protocol ",
      capabilities: ["strategy.workflow_policy.evaluate", "strategy.workflow_policy.evaluate"],
    });
    await expect(loadStrategyDescription()).resolves.toEqual({
      protocolVersion: "strategy-protocol",
      capabilities: ["strategy.workflow_policy.evaluate"],
    });
  });

  it("rejects capabilities outside the server preview namespace without an RPC call", async () => {
    await expect(previewStrategyCapability("strategy.describe", {})).resolves.toEqual({
      state: "error",
      decision: null,
      error: "请选择服务端提供的策略预览能力。",
    });
    expect(rpc.callRpc).not.toHaveBeenCalled();
  });

  it("classifies an explicit allow decision as accepted", async () => {
    rpc.callRpc.mockResolvedValue({ effect: "allow", reasonCode: "route_allowed", allowed: true });
    await expect(previewStrategyCapability("strategy.route_policy.evaluate", { routeId: "fixture" }))
      .resolves.toEqual({
        state: "accepted",
        decision: { effect: "allow", reasonCode: "route_allowed", allowed: true },
        error: "",
      });
  });

  it("unwraps the bounded tool-policy decision envelope", async () => {
    rpc.callRpc.mockResolvedValue({
      decision: {
        effect: "deny",
        allowed: false,
        reasonCode: "missing_required_scope",
        policyType: "tool-policy",
      },
      internalContext: "must-not-project",
    });

    await expect(previewStrategyCapability("strategy.tool_policy.preview", { toolId: "lico.jobs.delete" }))
      .resolves.toEqual({
        state: "denied",
        decision: {
          effect: "deny",
          allowed: false,
          reasonCode: "missing_required_scope",
          policyType: "tool-policy",
        },
        error: "",
      });
  });
});
