// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";

import BinaryCheckbox from "@meshrix/ui-console/binary-checkbox";
import ConsoleEmptyState from "../../../apps/console/components/ConsoleEmptyState.vue";
import ConsoleInlineAlert from "../../../apps/console/components/ConsoleInlineAlert.vue";
import DataTable from "../../../apps/console/components/DataTable.vue";
import FeatureToggle from "../../../apps/console/components/FeatureToggle.vue";
import OptionBar from "@meshrix/ui-console/option-bar";
import SegmentedToggle from "../../../apps/console/components/SegmentedToggle.vue";
import SplitToggleCard from "../../../apps/console/components/SplitToggleCard.vue";
import {
  commonComponentRegistry,
  commonComponentReusePolicy,
  BinaryCheckbox as RegisteredBinaryCheckbox,
  FeatureToggle as RegisteredFeatureToggle,
  SegmentedToggle as RegisteredSegmentedToggle,
} from "../../../apps/console/components/common";

const navigateBrowserHashRouteMock: any = vi.hoisted(() : any => vi.fn());

vi.mock("@meshrix/ui-console/browser-window", () : any => ({
  navigateBrowserHashRoute: navigateBrowserHashRouteMock,
}));

const ElSelectStub: any = defineComponent({
  name: "ElSelect",
  props: [
    "modelValue",
    "multiple",
    "collapseTags",
    "collapseTagsTooltip",
    "teleported",
    "filterable",
    "placeholder",
    "persistent",
    "popperClass",
    "disabled",
    "clearable",
    "size",
    "emptyValues",
  ],
  emits: ["update:modelValue", "change"],
  setup(props: any, { emit, slots }: Record<string, any>) : any {
    return () : any =>
      h("div", { class: "option-bar-select-stub-shell" }, [
        h("div", { class: "option-bar-selected-label-stub" }, slots.label?.({
          label: props.modelValue === "a" ? "Alpha" : String(props.modelValue ?? ""),
          value: props.modelValue,
          index: 0,
        })),
        h(
          "select",
          {
            class: "option-bar-select-stub",
            multiple: Boolean(props.multiple),
            disabled: Boolean(props.disabled),
            value: props.modelValue as string,
            "data-placeholder": props.placeholder,
            "data-popper-class": props.popperClass,
            "data-size": props.size,
            onChange: (event: Event) : any => {
              const value: any = (event.target as HTMLSelectElement).value;
              emit("update:modelValue", value);
              emit("change", value);
            },
          },
          slots.default?.(),
        ),
      ]);
  },
});

const ElOptionStub: any = defineComponent({
  name: "ElOption",
  props: ["label", "value", "disabled"],
  setup(props: any, { slots }: Record<string, any>) : any {
    return () : any =>
      h(
        "option",
        {
          value: String(props.value ?? ""),
          disabled: Boolean(props.disabled),
        },
        slots.default?.() || String(props.label ?? ""),
      );
  },
});

const ElTableStub: any = defineComponent({
  name: "ElTable",
  props: ["data", "rowKey", "emptyText", "loading"],
  emits: ["scroll", "header-dragend"],
  setup(props: any, { emit, slots }: Record<string, any>) : any {
    return () : any =>
      h(
        "div",
        {
          class: "meshrix-data-table el-table",
          "data-row-key": typeof props.rowKey === "function" ? "function" : String(props.rowKey ?? ""),
          "data-empty-text": String(props.emptyText ?? ""),
          "data-loading": String(Boolean(props.loading)),
          onScroll: (event: Event) : any => emit("scroll", event),
        },
        [
          h(
            "button",
            {
              class: "header-dragend-trigger",
              type: "button",
              onClick: (event: Event) : any => emit("header-dragend", 120, 80, { property: "name" }, event),
            },
            "drag",
          ),
          ...(slots.default?.() || []),
        ],
      );
  },
});

describe("console common components behavior", () : any => {
  it("toggles BinaryCheckbox and leaves disabled instances unchanged", async () : Promise<any> => {
    const wrapper: any = mount(BinaryCheckbox, {
      props: {
        modelValue: false,
        label: "允许上传",
      },
    });

    expect(wrapper.attributes("role")).toBe("checkbox");
    expect(wrapper.attributes("aria-checked")).toBe("false");
    await wrapper.trigger("click");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([true]);
    expect(wrapper.emitted("change")?.[0]).toEqual([true]);

    const disabled: any = mount(BinaryCheckbox, {
      props: {
        modelValue: true,
        label: "禁用项",
        disabled: true,
      },
    });
    await disabled.trigger("click");
    expect(disabled.emitted("update:modelValue")).toBeUndefined();
    expect(disabled.attributes("data-checked")).toBe("true");

    const readonly: any = mount(BinaryCheckbox, {
      props: {
        modelValue: true,
        label: "只读项",
        readonly: true,
      },
    });
    await readonly.trigger("click");
    expect(readonly.emitted("update:modelValue")).toBeUndefined();
    expect(readonly.attributes("aria-readonly")).toBe("true");
  });

  it("renders labeled FeatureToggle state and emits boolean changes", async () : Promise<any> => {
    const wrapper: any = mount(FeatureToggle, {
      props: {
        modelValue: false,
        label: "启用",
        ariaLabel: "启用标签",
      },
    });

    expect(wrapper.attributes("role")).toBe("switch");
    expect(wrapper.attributes("aria-checked")).toBe("false");
    expect(wrapper.attributes("aria-label")).toBe("启用标签");
    expect(wrapper.find(".feature-toggle-label").text()).toBe("启用");
    await wrapper.trigger("click");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([true]);
    expect(wrapper.emitted("change")?.[0]).toEqual([true]);
  });

  it("renders SegmentedToggle grid state and emits selected values", async () : Promise<any> => {
    const wrapper: any = mount(SegmentedToggle, {
      props: {
        modelValue: "summary",
        ariaLabel: "视图",
        size: "large",
        options: [
          { label: "摘要", value: "summary" },
          { label: "详情", value: "detail" },
          { label: "日志", value: "logs" },
        ],
      },
    });

    expect(wrapper.attributes("role")).toBe("tablist");
    expect(wrapper.attributes("aria-label")).toBe("视图");
    expect(wrapper.classes()).toContain("size-large");
    expect(wrapper.attributes("style")).toContain("repeat(3, minmax(0, 1fr))");
    expect(wrapper.findAll('[role="tab"]').map((item?: any) : any => item.attributes("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);

    await wrapper.findAll("button")[1].trigger("click");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["detail"]);
    expect(wrapper.emitted("change")?.[0]).toEqual(["detail"]);
  });

  it("forwards OptionBar props and Element Plus select events", async () : Promise<any> => {
    const wrapper: any = mount(OptionBar, {
      props: {
        modelValue: "a",
        label: "模式",
        placeholder: "请选择",
        multiple: false,
        filterable: true,
        persistent: true,
        disabled: false,
        clearable: true,
        size: "small",
        popperClass: "custom-popper",
        options: [
          { value: "a", label: "Alpha", swatches: ["#111111", "#2563eb", "#60a5fa"], icon: "moon" },
          { value: "b", label: "Beta", disabled: true },
        ],
      },
      global: {
        stubs: {
          ElSelect: ElSelectStub,
          ElOption: ElOptionStub,
        },
      },
    });

    expect(wrapper.find(".option-bar-label").text()).toBe("模式");
    const select: any = wrapper.find("select");
    expect(select.attributes("data-placeholder")).toBe("请选择");
    expect(select.attributes("data-popper-class")).toBe("custom-popper");
    expect(wrapper.findComponent({ name: "ElSelect" }).props("emptyValues")).toEqual([null, undefined]);
    expect(select.findAll("option").map((option?: any) : any => option.text())).toEqual(["Alpha", "Beta"]);
    expect(wrapper.findAll(".option-bar-option-swatch")).toHaveLength(3);
    expect(wrapper.findAll(".option-bar-option-icon").length).toBeGreaterThanOrEqual(2);
    expect(wrapper.find(".option-bar-selected-label-stub .option-bar-option-icon").exists()).toBe(true);
    expect(wrapper.find(".option-bar-option-row").attributes("data-has-swatches")).toBe("true");

    await select.setValue("b");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["b"]);
    expect(wrapper.emitted("change")?.[0]).toEqual(["b"]);
  });

  it("wraps DataTable Element Plus events and slots", async () : Promise<any> => {
    const rowKey: any = (row: { id: string }) : any => row.id;
    const wrapper: any = mount(DataTable, {
      props: {
        data: [{ id: "row-1", name: "Alpha" }],
        rowKey,
        emptyText: "暂无数据",
        loading: true,
      },
      slots: {
        default: '<span class="table-slot">列内容</span>',
      },
      global: {
        directives: {
          loading: {},
        },
        stubs: {
          ElTable: ElTableStub,
        },
      },
    });

    const table: any = wrapper.find(".meshrix-data-table");
    expect(table.attributes("data-row-key")).toBe("function");
    expect(table.attributes("data-empty-text")).toBe("暂无数据");
    expect(wrapper.find(".table-slot").text()).toBe("列内容");

    await table.trigger("scroll");
    await wrapper.find(".header-dragend-trigger").trigger("click");
    expect(wrapper.emitted("scroll")).toHaveLength(1);
    expect(wrapper.emitted("header-dragend")?.[0].slice(0, 3)).toEqual([120, 80, { property: "name" }]);
  });

  it("toggles SplitToggleCard from summary and ignores nested interactive targets", async () : Promise<any> => {
    const wrapper: any = mount(SplitToggleCard, {
      props: {
        as: "article",
        expanded: true,
        expandedLabel: "收起",
        collapsedLabel: "展开",
      },
      slots: {
        summary: '<span class="summary-text">摘要</span><button class="nested-button">内部按钮</button>',
        default: '<div class="body-text">详情</div>',
      },
    });

    expect(wrapper.element.tagName).toBe("ARTICLE");
    expect(wrapper.find(".split-toggle-card__summary").attributes("aria-expanded")).toBe("true");
    expect(wrapper.find(".body-text").text()).toBe("详情");

    await wrapper.find(".nested-button").trigger("click");
    expect(wrapper.emitted("toggle")).toBeUndefined();

    await wrapper.find(".split-toggle-card__summary").trigger("click");
    await wrapper.find(".split-toggle-card__toggle").trigger("click");
    await wrapper.find(".split-toggle-card__summary").trigger("keydown.space");
    expect(wrapper.emitted("toggle")).toHaveLength(3);
  });

  it("omits the empty state action region when no next step is provided", () : any => {
    const wrapper: any = mount(ConsoleEmptyState, {
      props: { title: "暂无上游服务" },
    });
    expect(wrapper.find(".console-empty-state-title").text()).toBe("暂无上游服务");
    expect(wrapper.find(".console-empty-state-actions").exists()).toBe(false);
  });

  it("renders a startable next step in the empty state action region", () : any => {
    const wrapper: any = mount(ConsoleEmptyState, {
      props: { title: "暂无上游服务", description: "发布一个上游服务后，这里会显示它的运行时快照。" },
      slots: { action: "<a class=\"table-action\" href=\"#/admin/publish-upstream-service\">发布服务</a>" },
    });
    expect(wrapper.find(".console-empty-state-description").text()).toBe(
      "发布一个上游服务后，这里会显示它的运行时快照。",
    );
    const actions: any = wrapper.find(".console-empty-state-actions");
    expect(actions.exists()).toBe(true);
    expect(actions.classes()).toContain("horizontal-action-group");
    expect(actions.find("a.table-action").text()).toBe("发布服务");
  });

  it("keeps list semantics when the empty state renders as a list item", () : any => {
    const wrapper: any = mount(ConsoleEmptyState, {
      props: { title: "暂无操作", as: "li", compact: true },
      slots: { action: "<button class=\"table-action\" type=\"button\">添加工具路径</button>" },
    });
    expect(wrapper.element.tagName).toBe("LI");
    expect(wrapper.classes()).toContain("is-compact");
    expect(wrapper.find(".console-empty-state-actions button").text()).toBe("添加工具路径");
  });

  it("renders inline alert text without an action region by default", () : any => {
    const wrapper: any = mount(ConsoleInlineAlert, {
      props: { tone: "danger" },
      slots: { default: "策略能力加载失败。" },
    });
    expect(wrapper.attributes("role")).toBe("alert");
    expect(wrapper.classes()).toContain("tone-danger");
    expect(wrapper.find(".console-inline-alert-main").text()).toBe("策略能力加载失败。");
    expect(wrapper.find(".console-inline-alert-actions").exists()).toBe(false);
    expect(wrapper.find(".console-inline-alert-dismiss").exists()).toBe(false);
  });

  it("exposes recovery actions and dismissal through the inline alert action region", async () : Promise<any> => {
    const wrapper: any = mount(ConsoleInlineAlert, {
      props: { tone: "danger", title: "无法加载", dismissible: true },
      slots: {
        default: "策略能力加载失败。",
        action: "<button class=\"table-action\" type=\"button\">重试</button>",
      },
    });
    expect(wrapper.find(".console-inline-alert-title").text()).toBe("无法加载");
    const actions: any = wrapper.find(".console-inline-alert-actions");
    expect(actions.exists()).toBe(true);
    // Sibling controls in one row must share the horizontal action-group contract.
    expect(actions.classes()).toContain("horizontal-action-group");
    expect(actions.find("button.table-action").text()).toBe("重试");

    const dismiss: any = wrapper.find(".console-inline-alert-dismiss");
    expect(dismiss.attributes("aria-label")).toBe("关闭提示");
    await dismiss.trigger("click");
    expect(wrapper.emitted("dismiss")).toHaveLength(1);
  });

  it("keeps status semantics for non-danger inline alert tones", () : any => {
    const wrapper: any = mount(ConsoleInlineAlert, {
      props: { tone: "success" },
      slots: { default: "已发布" },
    });
    expect(wrapper.attributes("role")).toBe("status");
    expect(wrapper.classes()).toContain("tone-success");
  });

  it("exports common component registry entries and reuse policy", () : any => {
    expect(RegisteredBinaryCheckbox).toBe(BinaryCheckbox);
    expect(RegisteredFeatureToggle).toBe(FeatureToggle);
    expect(RegisteredSegmentedToggle).toBe(SegmentedToggle);
    expect(commonComponentReusePolicy.length).toBeGreaterThan(0);
    expect(commonComponentRegistry.map((entry?: any) : any => entry.name)).toEqual(expect.arrayContaining([
      "BinaryCheckbox",
      "FeatureToggle",
      "OptionBar",
      "SegmentedToggle",
    ]));
    expect(commonComponentRegistry.every((entry?: any) : any => [
      "apps/console/components/",
      "apps/console/composables/",
      "packages/ui-console/src/",
    ].some((root?: any) : any => entry.file.startsWith(root)))).toBe(true);
  });
});
