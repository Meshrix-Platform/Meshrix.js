// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it } from "vitest";
import {
  provideOperationPermissionView,
  useOperationPermissionViewContext,
} from "../../../apps/console/composables/operationPermissionViewContext";

describe("operation permission view context behavior", () : any => {
  it("provides and reads the permissions view context", () : any => {
    const context: any = {
      isBusy: () => false,
      toolGrants: [{ id: "grant-a" }],
      toolScopes: [{ id: "scope-a" }],
    } as any;
    const observed: Record<string, unknown> = {};
    const Consumer: any = defineComponent({
      setup() : any {
        observed.context = useOperationPermissionViewContext();
        return () : any => h("span", "permissions consumer");
      },
    });
    const Host: any = defineComponent({
      setup() : any {
        provideOperationPermissionView(context);
        return () : any => h(Consumer);
      },
    });

    const wrapper: any = mount(Host);

    expect(wrapper.text()).toBe("permissions consumer");
    expect(observed.context).toBe(context);
  });

  it("throws an explicit error without a provider", () : any => {
    expect(() : any => useOperationPermissionViewContext()).toThrow("Operation Permission view context is not available");
  });
});
