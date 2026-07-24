// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import ConsoleEmptyState from "../../../apps/console/components/ConsoleEmptyState.vue";
import ConsoleInlineAlert from "../../../apps/console/components/ConsoleInlineAlert.vue";

describe("ConsoleEmptyState", () => {
  it("renders title, optional description and action slot", () => {
    const wrapper = mount(ConsoleEmptyState, {
      props: { title: "暂无任务记录", description: "当前筛选条件下没有匹配任务。" },
      slots: { default: '<button class="empty-action">重试</button>' },
    });

    expect(wrapper.classes()).toContain("console-empty-state");
    expect(wrapper.find(".console-empty-state-title").text()).toBe("暂无任务记录");
    expect(wrapper.find(".console-empty-state-description").text()).toBe("当前筛选条件下没有匹配任务。");
    expect(wrapper.find(".empty-action").exists()).toBe(true);
  });

  it("omits the description node when not provided and supports compact danger variants", () => {
    const wrapper = mount(ConsoleEmptyState, {
      props: { title: "加载失败", tone: "danger", compact: true },
    });

    expect(wrapper.find(".console-empty-state-description").exists()).toBe(false);
    expect(wrapper.classes()).toContain("is-compact");
    expect(wrapper.classes()).toContain("tone-danger");
  });

  it("renders as a list item when used inside list containers", () => {
    const wrapper = mount(ConsoleEmptyState, {
      props: { title: "暂无操作", as: "li" },
    });

    expect(wrapper.element.tagName).toBe("LI");
  });
});

describe("ConsoleInlineAlert", () => {
  it("defaults to info tone with status role", () => {
    const wrapper = mount(ConsoleInlineAlert, {
      slots: { default: "已同步 3 个文件" },
    });

    expect(wrapper.classes()).toContain("tone-info");
    expect(wrapper.attributes("role")).toBe("status");
    expect(wrapper.text()).toBe("已同步 3 个文件");
  });

  it("maps danger tone to the alert role", () => {
    const wrapper = mount(ConsoleInlineAlert, {
      props: { tone: "danger" },
      slots: { default: "保存失败" },
    });

    expect(wrapper.classes()).toContain("tone-danger");
    expect(wrapper.attributes("role")).toBe("alert");
  });

  it("supports success tone", () => {
    const wrapper = mount(ConsoleInlineAlert, {
      props: { tone: "success" },
      slots: { default: "已保存" },
    });

    expect(wrapper.classes()).toContain("tone-success");
    expect(wrapper.attributes("role")).toBe("status");
  });
});
