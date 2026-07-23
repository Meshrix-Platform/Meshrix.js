// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import DashboardPluginCard from "../../../apps/console/components/dashboard/DashboardPluginCard.vue";

describe("DashboardPluginCard", () => {
  it("checks effective plugins and grays loaded inactive plugins", () => {
    const wrapper = mount(DashboardPluginCard, {
      props: {
        plugins: [
          { id: "inactive-plugin", version: "1.0.0", features: [], effective: false },
          { id: "active-plugin", version: "2.0.0", features: [], effective: true },
        ],
      },
    });

    const items = wrapper.findAll(".dashboard-plugin-item");
    expect(items.map((item) => item.text())).toEqual([
      "active-pluginv2.0.0",
      "inactive-pluginv1.0.0",
    ]);
    expect(items[0].attributes("data-effective")).toBe("true");
    expect(items[0].get('[role="checkbox"]').attributes("aria-checked")).toBe("true");
    expect(items[0].get('[role="checkbox"]').attributes("disabled")).toBeUndefined();
    expect(items[1].attributes("data-effective")).toBe("false");
    expect(items[1].get('[role="checkbox"]').attributes("aria-checked")).toBe("false");
    expect(items[1].get('[role="checkbox"]').attributes("disabled")).toBeDefined();
  });

  it("renders an explicit empty state when no plugins are loaded", () => {
    const wrapper = mount(DashboardPluginCard, { props: { plugins: [] } });
    expect(wrapper.get(".dashboard-plugin-empty").text()).toBe("暂无已装载插件");
    expect(wrapper.text()).toContain("0/0 已生效");
  });
});
