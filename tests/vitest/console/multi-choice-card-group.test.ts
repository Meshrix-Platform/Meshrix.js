// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it } from "vitest";
import MultiChoiceCardGroup from "../../../apps/console/components/MultiChoiceCardGroup.vue";

const BinaryCheckboxStub: any = defineComponent({
  name: "BinaryCheckbox",
  props: {
    disabled: Boolean,
    label: String,
    modelValue: Boolean,
  },
  emits: ["update:modelValue"],
  setup(props: any, { emit }: Record<string, any>) : any {
    return () : any =>
      h(
        "button",
        {
          class: "binary-checkbox-stub",
          "data-checked": String(props.modelValue),
          disabled: props.disabled,
          type: "button",
          onClick: () : any => emit("update:modelValue", !props.modelValue),
        },
        props.label,
      );
  },
});

function mountGroup(props: Record<string, unknown> = {}, slots: Record<string, string> = {}) : any {
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

describe("MultiChoiceCardGroup behavior", () : any => {
  it("renders heading, selected state, disabled state, layout, and detail slot", () : any => {
    const wrapper: any = mountGroup({ layout: "stacked" }, { details: "<p class=\"details-slot\">Extra details</p>" });
    const cards: any = wrapper.findAll(".multi-choice-card-option");
    const buttons: any = wrapper.findAll(".binary-checkbox-stub");

    expect(wrapper.attributes("data-layout")).toBe("stacked");
    expect(wrapper.text()).toContain("Feature choices");
    expect(wrapper.text()).toContain("Two selected");
    expect(wrapper.text()).toContain("Alpha description");
    expect(wrapper.text()).toContain("Beta description");
    expect(wrapper.text()).toContain("Extra details");
    expect(cards.map((card?: any) : any => card.attributes("data-active"))).toEqual(["false", "true", "false"]);
    expect(cards.map((card?: any) : any => card.attributes("data-disabled"))).toEqual([undefined, undefined, "true"]);
    expect(buttons.map((button?: any) : any => button.attributes("data-checked"))).toEqual(["false", "true", "false"]);
    expect(buttons[2].attributes("disabled")).toBeDefined();
  });

  it("emits ordered values when options are checked or unchecked", async () : Promise<any> => {
    const wrapper: any = mountGroup({ modelValue: ["beta"] });
    const buttons: any = wrapper.findAll(".binary-checkbox-stub");

    await buttons[0].trigger("click");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([["alpha", "beta"]]);
    expect(wrapper.emitted("change")?.[0]).toEqual([["alpha", "beta"]]);

    await wrapper.setProps({ modelValue: ["alpha", "beta"] });
    await buttons[1].trigger("click");
    expect(wrapper.emitted("update:modelValue")?.[1]).toEqual([["alpha"]]);
    expect(wrapper.emitted("change")?.[1]).toEqual([["alpha"]]);
  });

  it("does not emit while the whole group is disabled", async () : Promise<any> => {
    const wrapper: any = mountGroup({ disabled: true, modelValue: ["beta"] });
    const cards: any = wrapper.findAll(".multi-choice-card-option");

    expect(cards.map((card?: any) : any => card.attributes("data-disabled"))).toEqual(["true", "true", "true"]);
    await wrapper.findAll(".binary-checkbox-stub")[0].trigger("click");

    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.emitted("change")).toBeUndefined();
  });
});
