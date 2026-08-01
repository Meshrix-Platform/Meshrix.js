// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import ConsoleSideNavLink from "../../../apps/console/components/shell/side-nav/ConsoleSideNavLink.vue";

describe("ConsoleSideNavLink", () : any => {
  it("renders a semantic anchor with aria-current when href is provided", () : any => {
    const wrapper: any = mount(ConsoleSideNavLink, {
      props: { active: true, href: "#/admin/jobs", label: "工作队列" },
    });

    const anchor: any = wrapper.find("a.side-link");
    expect(anchor.exists()).toBe(true);
    expect(anchor.attributes("href")).toBe("#/admin/jobs");
    expect(anchor.attributes("aria-current")).toBe("page");
    expect(wrapper.find("button").exists()).toBe(false);
  });

  it("keeps SPA behavior on plain click and native behavior on modified click", async () : Promise<any> => {
    const wrapper: any = mount(ConsoleSideNavLink, {
      props: { href: "#/admin/jobs", label: "工作队列" },
    });
    const anchor: any = wrapper.find("a.side-link");

    const plainClick: any = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
    anchor.element.dispatchEvent(plainClick);
    expect(plainClick.defaultPrevented).toBe(true);
    expect(wrapper.emitted("activate")).toHaveLength(1);

    const metaClick: any = new MouseEvent("click", { button: 0, metaKey: true, bubbles: true, cancelable: true });
    anchor.element.dispatchEvent(metaClick);
    expect(metaClick.defaultPrevented).toBe(false);
    expect(wrapper.emitted("activate")).toHaveLength(1);
  });

  it("falls back to a button when no href is provided", async () : Promise<any> => {
    const wrapper: any = mount(ConsoleSideNavLink, {
      props: { label: "自定义动作" },
    });

    const button: any = wrapper.find("button.side-link");
    expect(button.exists()).toBe(true);
    expect(wrapper.find("a").exists()).toBe(false);

    await button.trigger("click");
    expect(wrapper.emitted("activate")).toHaveLength(1);
  });
});
