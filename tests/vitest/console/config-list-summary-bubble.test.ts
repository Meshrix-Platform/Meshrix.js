// @vitest-environment jsdom
import { mount, VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import ConfigListSummaryBubble from "../../../apps/console/components/ConfigListSummaryBubble.vue";

const mounted: VueWrapper[] = [];

function mountBubble(props: Record<string, unknown> = {}) : any {
  const wrapper: any = mount(ConfigListSummaryBubble, {
    attachTo: document.body,
    props: {
      title: "运行时依赖",
      groups: [],
      ...props,
    },
    global: {
      stubs: {
        Setting: { template: "<svg aria-hidden=\"true\" />" },
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

async function openBubble(wrapper: VueWrapper) : Promise<any> {
  await wrapper.find("button").trigger("click");
  await nextTick();
  await nextTick();
  return document.body.querySelector<HTMLElement>(".config-list-summary-popover");
}

afterEach(() : any => {
  while (mounted.length) {
    mounted.pop()?.unmount();
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ConfigListSummaryBubble", () : any => {
  it("renders accessible defaults and the empty-state popover", async () : Promise<any> => {
    const wrapper: any = mountBubble();

    const button: any = wrapper.find("button");
    expect(button.attributes("aria-label")).toBe("配置 运行时依赖");
    expect(button.attributes("aria-expanded")).toBe("false");
    expect(button.text()).toContain("配置");

    const popover: any = await openBubble(wrapper);

    expect(popover).not.toBeNull();
    expect(button.attributes("aria-expanded")).toBe("true");
    expect(button.attributes("aria-controls")).toMatch(/^config-list-summary-/);
    expect(popover?.getAttribute("role")).toBe("dialog");
    expect(popover?.getAttribute("aria-label")).toBe("运行时依赖 配置列表");
    expect(popover?.textContent).toContain("运行时依赖");
    expect(popover?.textContent).toContain("0 项配置");
    expect(popover?.textContent).toContain("暂无配置项");
    expect(popover?.textContent).toContain("当前目标未返回配置字段。");

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await nextTick();
    expect(document.body.querySelector(".config-list-summary-popover")).toBeNull();
    expect(button.attributes("aria-expanded")).toBe("false");
  });

  it("filters entries and renders configured, unconfigured and required states", async () : Promise<any> => {
    const wrapper: any = mountBubble({
      ariaLabel: "依赖配置明细",
      buttonAriaLabel: "查看配置",
      buttonClass: "plain-button",
      buttonLabel: "明细",
      emptyDescription: "没有字段",
      emptyTitle: "空",
      subtitle: "自定义副标题",
      width: 360,
      groups: [
        {
          kind: "runtime",
          title: "Node.js",
          entries: [
            {
              configured: true,
              description: "从环境变量读取",
              key: "NODE_HOME",
              label: "Node 路径",
              source: "env",
              value: "/usr/local/bin/node",
            },
            {
              configured: false,
              key: "PNPM_HOME",
              label: "pnpm 路径",
              value: "",
            },
            {
              configured: false,
              key: "JAVA_HOME",
              label: "Java 路径",
              required: true,
            },
            {
              key: "",
              label: "",
              value: "",
            },
          ],
        },
        {
          title: "",
          entries: [{ key: "ignored", value: "ignored" }],
        },
      ],
    });

    const popover: any = await openBubble(wrapper);

    expect(wrapper.find("button").classes()).toContain("plain-button");
    expect(wrapper.find("button").attributes("aria-label")).toBe("查看配置");
    expect(popover?.getAttribute("aria-label")).toBe("依赖配置明细");
    expect(popover?.style.getPropertyValue("--config-list-summary-width")).toBe("360px");
    expect(popover?.textContent).toContain("自定义副标题");
    expect(popover?.textContent).toContain("Node.js");
    expect(popover?.textContent).toContain("Node 路径");
    expect(popover?.textContent).toContain("/usr/local/bin/node");
    expect(popover?.textContent).toContain("已配置");
    expect(popover?.textContent).toContain("未配置");
    expect(popover?.textContent).toContain("必填未配置");
    expect(popover?.textContent).toContain("env；从环境变量读取");
    expect(popover?.textContent).not.toContain("ignored");
    expect(popover?.textContent).not.toContain("没有字段");

    const entries: any = Array.from(document.body.querySelectorAll<HTMLElement>(".config-list-summary-entry"));
    expect(entries).toHaveLength(3);
    expect(entries.map((entry?: any) : any => entry.dataset.configured)).toEqual(["true", "false", "false"]);

    const close: any = document.body.querySelector<HTMLElement>(".config-list-summary-close");
    close?.click();
    await nextTick();
    expect(document.body.querySelector(".config-list-summary-popover")).toBeNull();
  });

  it("positions above when lower viewport space is insufficient and closes on escape", async () : Promise<any> => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 180 });

    const wrapper: any = mountBubble({
      width: 640,
      groups: [
        {
          title: "配置",
          entries: [{ key: "TOKEN", value: "secret", configured: true }],
        },
      ],
    });
    const button: any = wrapper.find("button");
    vi.spyOn(button.element, "getBoundingClientRect").mockReturnValue({
      bottom: 170,
      height: 32,
      left: 280,
      right: 316,
      top: 138,
      width: 36,
      x: 280,
      y: 138,
      toJSON: () : any => ({}),
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 96 });

    const popover: any = await openBubble(wrapper);

    expect(popover?.classList.contains("is-above")).toBe(true);
    expect(popover?.style.left).toBe("12px");
    expect(popover?.style.top).toBe("34px");

    window.dispatchEvent(new Event("resize"));
    expect(popover?.style.left).toBe("12px");

    popover?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await nextTick();
    expect(document.body.querySelector(".config-list-summary-popover")).toBeNull();
  });
});
