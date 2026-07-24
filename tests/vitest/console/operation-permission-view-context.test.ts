// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it } from "vitest";
import {
  provideOperationPermissionView,
  useOperationPermissionViewContext,
} from "../../../apps/console/composables/operationPermissionViewContext";

describe("operation permission view context behavior", () => {
  it("provides and reads the permissions view context", () => {
    const context = {
      busyKey: "permissions-busy",
      toolGrants: [{ id: "grant-a" }],
      toolScopes: [{ id: "scope-a" }],
    } as any;
    const observed: Record<string, unknown> = {};
    const Consumer = defineComponent({
      setup() {
        observed.context = useOperationPermissionViewContext();
        return () => h("span", "permissions consumer");
      },
    });
    const Host = defineComponent({
      setup() {
        provideOperationPermissionView(context);
        return () => h(Consumer);
      },
    });

    const wrapper = mount(Host);

    expect(wrapper.text()).toBe("permissions consumer");
    expect(observed.context).toBe(context);
  });

  it("throws an explicit error without a provider", () => {
    expect(() => useOperationPermissionViewContext()).toThrow("Operation Permission view context is not available");
  });
});
