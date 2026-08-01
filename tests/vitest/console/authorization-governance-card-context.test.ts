// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it } from "vitest";
import {
  createAuthorizationGovernanceCardContext,
  provideAuthorizationGovernanceCardContext,
  useAuthorizationGovernanceCardContext,
} from "../../../apps/console/composables/authorizationGovernanceCardContext";
import { mcpAuthorizationApprovalCard } from "../../../apps/console/composables/console-approval-flow-view-controller";

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

  it("distinguishes concurrent same-name MCP installation approvals by request and verification code", () : any => {
    const baseRequest: Record<string, any> = {
      requestKind: "local_mcp_install" as const,
      status: "pending" as const,
      clientName: "Meshrix MCP codex",
      targets: ["codex"],
      toolsets: ["meshrix.runtime.read"],
      maxRisk: "read_only",
      requestedScopes: [],
      requestedTools: [],
      processKeyFingerprints: [],
    };
    const first: any = mcpAuthorizationApprovalCard({
      ...baseRequest,
      requestId: "mcp_auth_req_first",
      verificationCode: "1A2B-3C4D",
    });
    const second: any = mcpAuthorizationApprovalCard({
      ...baseRequest,
      requestId: "mcp_auth_req_second",
      verificationCode: "9E8F-7A6B",
    });

    expect(first.title).toBe(second.title);
    expect(first.facts).toContainEqual({
      label: "核对依据",
      value: "核对码 1A2B-3C4D · 0 个进程密钥指纹",
      protected: true,
    });
    expect(first.technicalDetails).toContainEqual({
      label: "请求 ID",
      value: "mcp_auth_req_first",
      protected: true,
    });
    expect(second.facts).toContainEqual({
      label: "核对依据",
      value: "核对码 9E8F-7A6B · 0 个进程密钥指纹",
      protected: true,
    });
    expect(second.technicalDetails).toContainEqual({
      label: "请求 ID",
      value: "mcp_auth_req_second",
      protected: true,
    });
    expect(first.technicalDetails).not.toEqual(second.technicalDetails);
  });

  it("shows exact local MCP permission IDs and full process-key fingerprints", () : any => {
    const fingerprint: any =
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const card: any = mcpAuthorizationApprovalCard({
      requestKind: "local_mcp_install",
      status: "pending",
      requestId: "mcp_auth_req_evidence",
      clientName: "Meshrix MCP codex",
      targets: ["codex"],
      toolsets: ["meshrix.runtime.read", "meshrix.workspace.write"],
      requestedTools: ["runtime.status.read", "workspace.file.write"],
      requestedScopes: ["runtime:read", "workspace:write"],
      processKeyFingerprints: [{ target: "codex", fingerprint }],
    });

    expect(card.technicalDetails).toContainEqual({
      label: "工具集 ID",
      value: "meshrix.runtime.read, meshrix.workspace.write",
    });
    expect(card.technicalDetails).toContainEqual({
      label: "工具 ID",
      value: "runtime.status.read, workspace.file.write",
    });
    expect(card.technicalDetails).toContainEqual({
      label: "权限域 ID",
      value: "runtime:read, workspace:write",
    });
    expect(card.technicalDetails).toContainEqual({
      label: "进程密钥指纹 · codex",
      value: fingerprint,
      protected: true,
    });
    expect(card.meta.join(" ")).not.toContain(fingerprint);
    expect(card.technicalDetails.map((item?: any) : any => item.value).join(" ")).toContain(
      fingerprint,
    );
  });
});
