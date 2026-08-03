// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it } from "vitest";
import {
  createAuthorizationGovernanceCardContext,
  provideAuthorizationGovernanceCardContext,
  useAuthorizationGovernanceCardContext,
} from "../../../apps/console/composables/authorizationGovernanceCardContext";

function makePermissionsContext() : any {
  return {
    authorizationGovernance: { roles: [] },
    authorizationGovernanceEditorBody: "{}",
    authorizationGovernanceEditorKind: "role",
    authorizationGovernanceEditorKinds: [{ label: "Role", value: "role" }],
    authorizationGovernanceEditorStatus: "ready",
    authorizationGovernanceError: "",
    authorizationGovernanceMetrics: { roles: 1 },
    authorizationGovernanceSaving: false,
    ignored: "ignore",
    itemText: (item: unknown) : any => JSON.stringify(item),
    policyCount: (items: unknown[]) : any => items.length,
    resetAuthorizationGovernanceEditor: () : any => undefined,
    saveAuthorizationGovernanceEditor: () : any => undefined,
    shortList: (items: unknown[]) : any => items.slice(0, 2),
  } as any;
}

describe("authorization governance card context behavior", () : any => {
  it("creates a narrow card context and provides it", () : any => {
    const source: any = makePermissionsContext();
    const context: any = createAuthorizationGovernanceCardContext(source);
    const observed: Record<string, unknown> = {};
    const Consumer: any = defineComponent({
      setup() : any {
        observed.context = useAuthorizationGovernanceCardContext();
        return () : any => h("span", "governance consumer");
      },
    });
    const Host: any = defineComponent({
      setup() : any {
        provideAuthorizationGovernanceCardContext(context);
        return () : any => h(Consumer);
      },
    });

    const wrapper: any = mount(Host);

    expect(wrapper.text()).toBe("governance consumer");
    expect(observed.context).toBe(context);
    expect(context.authorizationGovernance).toBe(
      source.authorizationGovernance,
    );
    expect(context.authorizationGovernanceEditorKinds).toBe(
      source.authorizationGovernanceEditorKinds,
    );
    expect(context.itemText({ id: "role-a" })).toBe('{"id":"role-a"}');
    expect(context.policyCount([1, 2, 3])).toBe(3);
    expect(context.shortList([1, 2, 3])).toEqual([1, 2]);
    expect("ignored" in context).toBe(false);
  });

  it("throws an explicit error without a provider", () : any => {
    expect(() : any => useAuthorizationGovernanceCardContext()).toThrow(
      "Authorization governance card context is not available",
    );
  });
});
