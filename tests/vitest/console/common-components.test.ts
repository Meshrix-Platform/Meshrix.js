// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";

import AgentModelOptionBar from "../../../apps/console/components/AgentModelOptionBar.vue";
import BinaryCheckbox from "@meshrix/ui-console/binary-checkbox";
import DataTable from "../../../apps/console/components/DataTable.vue";
import OptionBar from "@meshrix/ui-console/option-bar";
import SegmentedToggle from "../../../apps/console/components/SegmentedToggle.vue";
import SplitToggleCard from "../../../apps/console/components/SplitToggleCard.vue";
import {
  commonComponentRegistry,
  commonComponentReusePolicy,
  AgentModelOptionBar as RegisteredAgentModelOptionBar,
  BinaryCheckbox as RegisteredBinaryCheckbox,
  SegmentedToggle as RegisteredSegmentedToggle,
} from "../../../apps/console/components/common";

const navigateBrowserHashRouteMock = vi.hoisted(() => vi.fn());

vi.mock("../../../apps/console/lib/browser-window", () => ({
  navigateBrowserHashRoute: navigateBrowserHashRouteMock,
}));

const ElSelectStub = defineComponent({
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
  ],
  emits: ["update:modelValue", "change"],
  setup(props, { emit, slots }) {
    return () =>
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
            onChange: (event: Event) => {
              const value = (event.target as HTMLSelectElement).value;
              emit("update:modelValue", value);
              emit("change", value);
            },
          },
          slots.default?.(),
        ),
      ]);
  },
});

const ElOptionStub = defineComponent({
  name: "ElOption",
  props: ["label", "value", "disabled"],
  setup(props, { slots }) {
    return () =>
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

const ElTableStub = defineComponent({
  name: "ElTable",
  props: ["data", "rowKey", "emptyText", "loading"],
  emits: ["scroll", "header-dragend"],
  setup(props, { emit, slots }) {
    return () =>
      h(
        "div",
        {
          class: "meshrix-data-table el-table",
          "data-row-key": typeof props.rowKey === "function" ? "function" : String(props.rowKey ?? ""),
          "data-empty-text": String(props.emptyText ?? ""),
          "data-loading": String(Boolean(props.loading)),
          onScroll: (event: Event) => emit("scroll", event),
        },
        [
          h(
            "button",
            {
              class: "header-dragend-trigger",
              type: "button",
              onClick: (event: Event) => emit("header-dragend", 120, 80, { property: "name" }, event),
            },
            "drag",
          ),
          ...(slots.default?.() || []),
        ],
      );
  },
});

describe("console common components behavior", () => {
  it("toggles BinaryCheckbox and leaves disabled instances unchanged", async () => {
    const wrapper = mount(BinaryCheckbox, {
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

    const disabled = mount(BinaryCheckbox, {
      props: {
        modelValue: true,
        label: "禁用项",
        disabled: true,
      },
    });
    await disabled.trigger("click");
    expect(disabled.emitted("update:modelValue")).toBeUndefined();
    expect(disabled.attributes("data-checked")).toBe("true");

    const readonly = mount(BinaryCheckbox, {
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

  it("renders SegmentedToggle grid state and emits selected values", async () => {
    const wrapper = mount(SegmentedToggle, {
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
    expect(wrapper.findAll('[role="tab"]').map((item) => item.attributes("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);

    await wrapper.findAll("button")[1].trigger("click");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["detail"]);
    expect(wrapper.emitted("change")?.[0]).toEqual(["detail"]);
  });

  it("forwards OptionBar props and Element Plus select events", async () => {
    const wrapper = mount(OptionBar, {
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
    const select = wrapper.find("select");
    expect(select.attributes("data-placeholder")).toBe("请选择");
    expect(select.attributes("data-popper-class")).toBe("custom-popper");
    expect(select.findAll("option").map((option) => option.text())).toEqual(["Alpha", "Beta"]);
    expect(wrapper.findAll(".option-bar-option-swatch")).toHaveLength(3);
    expect(wrapper.findAll(".option-bar-option-icon").length).toBeGreaterThanOrEqual(2);
    expect(wrapper.find(".option-bar-selected-label-stub .option-bar-option-icon").exists()).toBe(true);
    expect(wrapper.find(".option-bar-option-row").attributes("data-has-swatches")).toBe("true");

    await select.setValue("b");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["b"]);
    expect(wrapper.emitted("change")?.[0]).toEqual(["b"]);
  });

  it("normalizes AgentModelOptionBar options and navigates when the model library is empty", async () => {
    navigateBrowserHashRouteMock.mockClear();
    const wrapper = mount(AgentModelOptionBar, {
      props: {
        modelValue: "",
        label: "默认智能体",
        includeEmpty: true,
        options: [
          { agentUid: "agent-a", label: "Agent A" },
          { value: "agent-a", label: "Duplicate" },
          { value: "agent-b", label: "Agent B", enabled: false, reason: "维护中" },
          { value: "", label: "ignored" },
        ],
      },
    });

    expect(wrapper.find(".agent-option-label").text()).toBe("默认智能体");
    expect(wrapper.findAll("option").map((option) => option.text())).toEqual([
      "未分配智能体",
      "Agent A",
      "Agent B（维护中）",
    ]);

    await wrapper.find("select").setValue("agent-a");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["agent-a"]);
    expect(wrapper.emitted("change")?.[0]).toEqual(["agent-a"]);

    const emptyWrapper = mount(AgentModelOptionBar, {
      props: {
        modelValue: "",
        options: [],
        emptyLibraryRoute: "/admin/models",
        emptyLibraryActionIcon: "＋",
        emptyLibraryLabel: "配置模型",
      },
    });
    expect(emptyWrapper.find(".agent-option-shell").attributes("data-empty-library")).toBe("true");
    await emptyWrapper.find("select").trigger("click");
    expect(navigateBrowserHashRouteMock).toHaveBeenCalledWith("/admin/models", "/admin/agent-config");

    const event = new KeyboardEvent("keydown", { key: "Enter" });
    const preventDefault = vi.spyOn(event, "preventDefault");
    await emptyWrapper.find("select").element.dispatchEvent(event);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("wraps DataTable Element Plus events and slots", async () => {
    const rowKey = (row: { id: string }) => row.id;
    const wrapper = mount(DataTable, {
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

    const table = wrapper.find(".meshrix-data-table");
    expect(table.attributes("data-row-key")).toBe("function");
    expect(table.attributes("data-empty-text")).toBe("暂无数据");
    expect(wrapper.find(".table-slot").text()).toBe("列内容");

    await table.trigger("scroll");
    await wrapper.find(".header-dragend-trigger").trigger("click");
    expect(wrapper.emitted("scroll")).toHaveLength(1);
    expect(wrapper.emitted("header-dragend")?.[0].slice(0, 3)).toEqual([120, 80, { property: "name" }]);
  });

  it("toggles SplitToggleCard from summary and ignores nested interactive targets", async () => {
    const wrapper = mount(SplitToggleCard, {
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

  it("exports common component registry entries and reuse policy", () => {
    expect(RegisteredAgentModelOptionBar).toBe(AgentModelOptionBar);
    expect(RegisteredBinaryCheckbox).toBe(BinaryCheckbox);
    expect(RegisteredSegmentedToggle).toBe(SegmentedToggle);
    expect(commonComponentReusePolicy.length).toBeGreaterThan(0);
    expect(commonComponentRegistry.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "BinaryCheckbox",
      "OptionBar",
      "AgentModelOptionBar",
      "SegmentedToggle",
    ]));
    expect(commonComponentRegistry.every((entry) => [
      "apps/console/components/",
      "packages/ui-console/src/",
    ].some((root) => entry.file.startsWith(root)))).toBe(true);
  });
});
