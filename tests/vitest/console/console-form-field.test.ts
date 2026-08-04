// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { h } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import ConsoleFormField from "../../../apps/console/components/ConsoleFormField.vue";
import { createConsoleFormValidation } from "../../../apps/console/composables/console-form-validation";
import { commonComponentRegistry } from "../../../apps/console/components/common";
import {
  consoleMessages,
  currentConsoleLocale,
  setConsoleLocaleState,
} from "../../../apps/console/i18n/console";

afterEach(() : any => {
  setConsoleLocaleState("zh-CN");
});

function mountField(options: {
  props: Record<string, unknown>;
  control?: string;
  slots?: Record<string, any>;
}) : any {
  return mount(ConsoleFormField, {
    props: options.props as any,
    slots: {
      // Consumers bind the slot props onto the single root control so the
      // field's id/aria wiring lands on it (the documented contract).
      default: (field: any) : any => h("input", { ...field, type: "text" }),
      ...(options.slots || {}),
    },
  });
}

describe("ConsoleFormField aria wiring", () : any => {
  it("wires label/for/id deterministically around the slotted control", () : any => {
    const wrapper: any = mountField({
      props: { fieldId: "job-name", label: "任务名称" },
    });

    const label: any = wrapper.find("label.console-form-field");
    expect(label.exists()).toBe(true);
    expect(label.attributes("for")).toBe("job-name");
    const control: any = wrapper.find("input");
    expect(control.attributes("id")).toBe("job-name");
    expect(label.text()).toContain("任务名称");
  });

  it("emits aria-invalid only while an error is shown", () : any => {
    const clean: any = mountField({
      props: { fieldId: "job-name", label: "任务名称" },
    });
    expect(clean.find("input").attributes("aria-invalid")).toBeUndefined();

    const invalid: any = mountField({
      props: { fieldId: "job-name", label: "任务名称", error: "名称为必填项" },
    });
    expect(invalid.find("input").attributes("aria-invalid")).toBe("true");
  });

  it("wires aria-required and renders the marker with keyed accessible text", () : any => {
    const optional: any = mountField({
      props: { fieldId: "job-name", label: "任务名称" },
    });
    expect(optional.find("input").attributes("aria-required")).toBeUndefined();
    expect(optional.find(".console-form-field-required-marker").exists()).toBe(false);

    const required: any = mountField({
      props: { fieldId: "job-name", label: "任务名称", required: true },
    });
    expect(required.find("input").attributes("aria-required")).toBe("true");
    const marker: any = required.find(".console-form-field-required-marker");
    expect(marker.exists()).toBe(true);
    expect(marker.text()).toBe("*");
    expect(marker.attributes("aria-hidden")).toBe("true");
    const accessibleName: any = required.find(".console-form-field-visually-hidden");
    expect(accessibleName.text()).toBe(consoleMessages[currentConsoleLocale.value].formField.required);
  });

  it("unions error and help ids in aria-describedby in stable order", () : any => {
    const plain: any = mountField({
      props: { fieldId: "job-name", label: "任务名称" },
    });
    expect(plain.find("input").attributes("aria-describedby")).toBeUndefined();

    const withBoth: any = mountField({
      props: {
        fieldId: "job-name",
        label: "任务名称",
        error: "名称为必填项",
        help: "提交后可修改",
      },
    });
    expect(withBoth.find("input").attributes("aria-describedby")).toBe(
      "console-field-job-name-error console-field-job-name-help",
    );

    const helpOnly: any = mountField({
      props: { fieldId: "job-name", label: "任务名称", help: "提交后可修改" },
    });
    expect(helpOnly.find("input").attributes("aria-describedby")).toBe(
      "console-field-job-name-help",
    );
  });

  it("renders the error region with role=alert and the help region with its id", () : any => {
    const wrapper: any = mountField({
      props: {
        fieldId: "job-name",
        label: "任务名称",
        error: "名称为必填项",
        help: "提交后可修改",
      },
    });

    const errorRegion: any = wrapper.find("#console-field-job-name-error");
    expect(errorRegion.exists()).toBe(true);
    expect(errorRegion.attributes("role")).toBe("alert");
    expect(errorRegion.text()).toContain("名称为必填项");
    const helpRegion: any = wrapper.find("#console-field-job-name-help");
    expect(helpRegion.exists()).toBe(true);
    expect(helpRegion.text()).toContain("提交后可修改");
  });

  it("lets help and error slots override the prop content", () : any => {
    const wrapper: any = mountField({
      props: { fieldId: "job-name", label: "任务名称", error: "名称为必填项" },
      slots: {
        error: (slotProps: any) : any => h("strong", `自定义错误：${slotProps.message}`),
        help: () : any => h("em", "自定义帮助"),
      },
    });

    expect(wrapper.find("#console-field-job-name-error strong").text()).toBe("自定义错误：名称为必填项");
    expect(wrapper.find("#console-field-job-name-help em").text()).toBe("自定义帮助");
    // Slot-provided regions still drive the control wiring.
    expect(wrapper.find("input").attributes("aria-describedby")).toBe(
      "console-field-job-name-error console-field-job-name-help",
    );
  });

  it("fails when fieldId is missing or blank", () : any => {
    expect(() : any => mountField({ props: { label: "任务名称" } })).toThrow(
      "ConsoleFormField requires a non-empty fieldId",
    );
    expect(() : any => mountField({ props: { fieldId: "  ", label: "任务名称" } })).toThrow(
      "ConsoleFormField requires a non-empty fieldId",
    );
  });
});

describe("createConsoleFormValidation", () : any => {
  it("sets, reads, and clears errors keyed by field name", () : any => {
    const validation: any = createConsoleFormValidation();

    expect(validation.fieldError("name")).toBe("");
    expect(validation.hasErrors.value).toBe(false);

    validation.setFieldError("name", "名称为必填项");
    validation.setFieldError("protocol", "请选择协议");
    expect(validation.fieldError("name")).toBe("名称为必填项");
    expect(validation.errors.name).toBe("名称为必填项");
    expect(validation.errors.protocol).toBe("请选择协议");
    expect(validation.hasErrors.value).toBe(true);

    validation.clearFieldError("name");
    expect(validation.fieldError("name")).toBe("");
    expect(validation.fieldError("protocol")).toBe("请选择协议");
    expect(validation.hasErrors.value).toBe(true);

    validation.clearFieldError("protocol");
    expect(validation.hasErrors.value).toBe(false);
  });

  it("overwrites an existing error and treats clearing a missing key as a no-op", () : any => {
    const validation: any = createConsoleFormValidation();

    validation.setFieldError("name", "第一条");
    validation.setFieldError("name", "第二条");
    expect(validation.fieldError("name")).toBe("第二条");

    expect(() : any => validation.clearFieldError("missing")).not.toThrow();
    expect(validation.hasErrors.value).toBe(true);
    expect(validation.fieldError("name")).toBe("第二条");
  });
});

describe("ConsoleFormField registry entries", () : any => {
  it("registers the component and the validation store with usage rules", () : any => {
    const fieldEntry: any = commonComponentRegistry.find(
      (entry: any) : boolean => entry.name === "ConsoleFormField",
    );
    expect(fieldEntry).toBeTruthy();
    expect(fieldEntry.file).toBe("apps/console/components/ConsoleFormField.vue");
    expect(fieldEntry.usageRule).toBeTruthy();

    const validationEntry: any = commonComponentRegistry.find(
      (entry: any) : boolean => entry.name === "ConsoleFormValidation",
    );
    expect(validationEntry).toBeTruthy();
    expect(validationEntry.file).toBe("apps/console/composables/console-form-validation.ts");
    expect(validationEntry.usageRule).toBeTruthy();
  });

  it("keeps the required-marker copy keyed in both locales", () : any => {
    expect(consoleMessages["zh-CN"].formField.required).toBeTruthy();
    expect(consoleMessages.en.formField.required).toBeTruthy();
  });
});
