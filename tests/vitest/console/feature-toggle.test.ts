// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import FeatureToggle from "../../../apps/console/components/FeatureToggle.vue";

describe("FeatureToggle", () => {
  it("renders switch state and emits model updates", async () => {
    const wrapper = mount(FeatureToggle, {
      props: {
        modelValue: false,
        onLabel: "Enabled",
        offLabel: "Disabled",
      },
    });

    expect(wrapper.attributes("role")).toBe("switch");
    expect(wrapper.attributes("aria-checked")).toBe("false");
    expect(wrapper.attributes("aria-label")).toBe("Disabled");

    await wrapper.trigger("click");

    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([true]);
    expect(wrapper.emitted("change")?.[0]).toEqual([true]);
  });

  it("does not emit when disabled", async () => {
    const wrapper = mount(FeatureToggle, {
      props: {
        modelValue: true,
        disabled: true,
        ariaLabel: "Feature enabled",
      },
    });

    await wrapper.trigger("click");

    expect(wrapper.attributes("disabled")).toBeDefined();
    expect(wrapper.attributes("aria-label")).toBe("Feature enabled");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.emitted("change")).toBeUndefined();
  });
});
