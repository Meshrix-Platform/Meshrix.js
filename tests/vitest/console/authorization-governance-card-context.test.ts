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

function makePermissionsContext() {
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
    itemText: (item: unknown) => JSON.stringify(item),
    policyCount: (items: unknown[]) => items.length,
    resetAuthorizationGovernanceEditor: () => undefined,
    saveAuthorizationGovernanceEditor: () => undefined,
    shortList: (items: unknown[]) => items.slice(0, 2),
  } as any;
}

describe("authorization governance card context behavior", () => {
  it("creates a narrow card context and provides it", () => {
    const source = makePermissionsContext();
    const context = createAuthorizationGovernanceCardContext(source);
    const observed: Record<string, unknown> = {};
    const Consumer = defineComponent({
      setup() {
        observed.context = useAuthorizationGovernanceCardContext();
        return () => h("span", "governance consumer");
      },
    });
    const Host = defineComponent({
      setup() {
        provideAuthorizationGovernanceCardContext(context);
        return () => h(Consumer);
      },
    });

    const wrapper = mount(Host);

    expect(wrapper.text()).toBe("governance consumer");
    expect(observed.context).toBe(context);
    expect(context.authorizationGovernance).toBe(source.authorizationGovernance);
    expect(context.authorizationGovernanceEditorKinds).toBe(source.authorizationGovernanceEditorKinds);
    expect(context.itemText({ id: "role-a" })).toBe("{\"id\":\"role-a\"}");
    expect(context.policyCount([1, 2, 3])).toBe(3);
    expect(context.shortList([1, 2, 3])).toEqual([1, 2]);
    expect("ignored" in context).toBe(false);
  });

  it("throws an explicit error without a provider", () => {
    expect(() => useAuthorizationGovernanceCardContext()).toThrow(
      "Authorization governance card context is not available",
    );
  });

  it("distinguishes concurrent same-name MCP installation approvals by request and verification code", () => {
    const baseRequest = {
      requestKind: "local_mcp_install" as const,
      status: "pending" as const,
      clientName: "Meshrix MCP codex",
      targets: ["codex"],
      toolsets: ["meshrix.runtime.read"],
      maxRisk: "read_only",
      requestedScopes: [],
      requestedTools: [],
      processKeyFingerprints: []
    };
    const first = mcpAuthorizationApprovalCard({
      ...baseRequest,
      requestId: "mcp_auth_req_first",
      verificationCode: "1A2B-3C4D"
    });
    const second = mcpAuthorizationApprovalCard({
      ...baseRequest,
      requestId: "mcp_auth_req_second",
      verificationCode: "9E8F-7A6B"
    });

    expect(first.title).toBe(second.title);
    expect(first.meta).toContain("验证码 1A2B-3C4D");
    expect(first.meta).toContain("请求 mcp_auth_req_first");
    expect(second.meta).toContain("验证码 9E8F-7A6B");
    expect(second.meta).toContain("请求 mcp_auth_req_second");
    expect(first.meta).not.toEqual(second.meta);
  });

  it("shows exact local MCP permission IDs and full process-key fingerprints", () => {
    const fingerprint = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const card = mcpAuthorizationApprovalCard({
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

    expect(card.meta).toContain("工具集 ID meshrix.runtime.read, meshrix.workspace.write");
    expect(card.meta).toContain("工具 ID runtime.status.read, workspace.file.write");
    expect(card.meta).toContain("权限域 ID runtime:read, workspace:write");
    expect(card.meta).toContain(`进程密钥指纹 codex: ${fingerprint}`);
    expect(card.meta).not.toContain("工具集 2 个");
    expect(card.meta.join(" ")).toContain(fingerprint);
  });
});
