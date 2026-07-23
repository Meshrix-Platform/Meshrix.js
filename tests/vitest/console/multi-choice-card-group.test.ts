// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it } from "vitest";
import MultiChoiceCardGroup from "../../../apps/console/components/MultiChoiceCardGroup.vue";

const BinaryCheckboxStub = defineComponent({
  name: "BinaryCheckbox",
  props: {
    disabled: Boolean,
    label: String,
    modelValue: Boolean,
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    return () =>
      h(
        "button",
        {
          class: "binary-checkbox-stub",
          "data-checked": String(props.modelValue),
          disabled: props.disabled,
          type: "button",
          onClick: () => emit("update:modelValue", !props.modelValue),
        },
        props.label,
      );
  },
});

function mountGroup(props: Record<string, unknown> = {}, slots: Record<string, string> = {}) {
  return mount(MultiChoiceCardGroup, {
    global: {
      stubs: {
        BinaryCheckbox: BinaryCheckboxStub,
      },
    },
    props: {
      modelValue: ["beta", "unknown"],
      options: [
        { description: "Alpha description", label: "Alpha", value: "alpha" },
        { description: "Beta description", label: "Beta", value: "beta" },
        { disabled: true, label: "Gamma", value: "gamma" },
      ],
      summary: "Two selected",
      title: "Feature choices",
      ...props,
    },
    slots,
  });
}

describe("MultiChoiceCardGroup behavior", () => {
  it("renders heading, selected state, disabled state, layout, and detail slot", () => {
    const wrapper = mountGroup({ layout: "stacked" }, { details: "<p class=\"details-slot\">Extra details</p>" });
    const cards = wrapper.findAll(".multi-choice-card-option");
    const buttons = wrapper.findAll(".binary-checkbox-stub");

    expect(wrapper.attributes("data-layout")).toBe("stacked");
    expect(wrapper.text()).toContain("Feature choices");
    expect(wrapper.text()).toContain("Two selected");
    expect(wrapper.text()).toContain("Alpha description");
    expect(wrapper.text()).toContain("Beta description");
    expect(wrapper.text()).toContain("Extra details");
    expect(cards.map((card) => card.attributes("data-active"))).toEqual(["false", "true", "false"]);
    expect(cards.map((card) => card.attributes("data-disabled"))).toEqual([undefined, undefined, "true"]);
    expect(buttons.map((button) => button.attributes("data-checked"))).toEqual(["false", "true", "false"]);
    expect(buttons[2].attributes("disabled")).toBeDefined();
  });

  it("emits ordered values when options are checked or unchecked", async () => {
    const wrapper = mountGroup({ modelValue: ["beta"] });
    const buttons = wrapper.findAll(".binary-checkbox-stub");

    await buttons[0].trigger("click");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([["alpha", "beta"]]);
    expect(wrapper.emitted("change")?.[0]).toEqual([["alpha", "beta"]]);

    await wrapper.setProps({ modelValue: ["alpha", "beta"] });
    await buttons[1].trigger("click");
    expect(wrapper.emitted("update:modelValue")?.[1]).toEqual([["alpha"]]);
    expect(wrapper.emitted("change")?.[1]).toEqual([["alpha"]]);
  });

  it("does not emit while the whole group is disabled", async () => {
    const wrapper = mountGroup({ disabled: true, modelValue: ["beta"] });
    const cards = wrapper.findAll(".multi-choice-card-option");

    expect(cards.map((card) => card.attributes("data-disabled"))).toEqual(["true", "true", "true"]);
    await wrapper.findAll(".binary-checkbox-stub")[0].trigger("click");

    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.emitted("change")).toBeUndefined();
  });
});
