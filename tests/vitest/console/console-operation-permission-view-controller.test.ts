// @vitest-environment jsdom
import { computed, defineComponent, nextTick, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOperationPermissionViewConsole } from "../../../apps/console/composables/console-operation-permission-view-controller";
import { namespaceServerConsoleShell } from "./console-shell-test-utils";

const authorizationGovernanceClientMock: any = vi.hoisted(() : any => ({
  getAuthorizationGovernance: vi.fn(),
  upsertAuthorizationGovernance: vi.fn(),
}));

const shellContextMock: any = vi.hoisted(() : any => ({
  useServerConsoleShellContext: vi.fn(),
}));

vi.mock("../../../apps/console/lib/authorization-governance-client", () : any => ({
  getAuthorizationGovernance: authorizationGovernanceClientMock.getAuthorizationGovernance,
  upsertAuthorizationGovernance: authorizationGovernanceClientMock.upsertAuthorizationGovernance,
}));

vi.mock("#meshrix/console/server-console-shell-context", () : any => ({
  useServerConsoleShellContext: shellContextMock.useServerConsoleShellContext,
}));

type GovernanceSummary = {
  roles: Array<Record<string, unknown>>;
  teams: Array<Record<string, unknown>>;
  userPolicies: Array<Record<string, unknown>>;
  agentBindings: Array<Record<string, unknown>>;
  agentGroups: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
};

type OperationPermissionGrant = {
  id: string;
  enabled: boolean;
  scopes: string[];
  toolsets: string[];
  toolAllow: string[];
  toolDeny: string[];
};

type OperationPermissionTool = {
  id: string;
  label: string;
};

function deferred<T>() : any {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise: any = new Promise<T>((res?: any, rej?: any) : any => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushPromises() : any {
  return Promise.resolve().then(() : any => Promise.resolve()).then(() : any => nextTick());
}

function makeGovernance(overrides: Partial<GovernanceSummary> = {}): GovernanceSummary {
  return {
    roles: [{ id: "role-1" }],
    teams: [{ id: "team-1" }, { id: "team-2" }],
    userPolicies: [{ id: "user-policy-1" }],
    agentBindings: [{ id: "binding-1" }],
    agentGroups: [{ id: "group-1" }],
    approvals: [{ id: "approval-1" }, { id: "approval-2" }],
    ...overrides,
  };
}

function createOperationPermissionShell() : any {
  const isBusy: any = () => false;
  const issuedToolToken: any = ref("issued-token");
  const newGrantLabel: any = ref("默认智能体");
  const newGrantScopes: any = ref(["scope.read"]);
  const newGrantToolsets: any = ref(["toolset.read"]);
  const policyPreviewGrantId: any = ref("");
  const policyPreviewProfileId: any = ref("");
  const policyPreviewResult: any = ref<Record<string, unknown> | null>(null);
  const policyPreviewToolId: any = ref("tool-a");
  const selectedToolId: any = ref("tool-a");
  const toolGrants: any = ref<OperationPermissionGrant[]>([
    {
      id: "grant-1",
      enabled: true,
      scopes: ["scope.read"],
      toolsets: ["toolset.read"],
      toolAllow: ["tool.allow"],
      toolDeny: [],
    },
    {
      id: "grant-2",
      enabled: false,
      scopes: [],
      toolsets: [],
      toolAllow: [],
      toolDeny: ["tool.deny"],
    },
  ]);
  const operationPermissionTools: any = ref<OperationPermissionTool[]>([
    { id: "tool-a", label: "Tool A" },
    { id: "tool-b", label: "Tool B" },
  ]);
  const operationPermissionToolsets: any = ref([
    { id: "toolset.read", maxRisk: "read_only", grantable: true },
    { id: "toolset.safe", maxRisk: "safe_write", grantable: true },
    { id: "toolset.admin", maxRisk: "high", grantable: true },
  ]);
  const toolScopes: any = ref([
    { id: "scope.read" },
    { id: "scope.write" },
    { id: "scope.admin" },
  ]);
  const policyPreviewToolOptionBarOptions: any = computed(() : any =>
    operationPermissionTools.value.map((tool?: any) : any => ({
      value: tool.id,
      label: `${tool.label} / ${tool.id}`,
    })),
  );
  const policyPreviewProfileOptionBarOptions: any = computed(() : any => [
    { value: "", label: "不绑定档案" },
    { value: "profile-1", label: "默认档案 / profile-1" },
  ]);
  const selectedOperationPermissionTool: any = computed(() : any =>
    operationPermissionTools.value.find((tool?: any) : any => tool.id === selectedToolId.value) ||
    operationPermissionTools.value[0] ||
    null,
  );
  const enabledToolGrantCount: any = computed(() : any => toolGrants.value.filter((grant?: any) : any => grant.enabled).length);
  const selectToolForManagement: any = vi.fn((toolId: string) : any => {
    selectedToolId.value = toolId;
    policyPreviewToolId.value = toolId;
  });
  const grantToolRuleState: any = vi.fn(
    (grant: { toolAllow?: string[]; toolDeny?: string[] }, toolId: string) : any => {
      if ((grant.toolDeny || []).includes(toolId)) {
        return "deny";
      }
      if ((grant.toolAllow || []).includes(toolId)) {
        return "allow";
      }
      return "inherit";
    },
  );
  const grantHasToolset: any = vi.fn((grant: { toolsets?: string[] }, toolsetId: string) : any =>
    (grant.toolsets || []).includes(toolsetId),
  );
  const copyIssuedToolToken: any = vi.fn();
  const createGrant: any = vi.fn();
  const deleteGrant: any = vi.fn();
  const rotateGrant: any = vi.fn();
  const setGrantToolRule: any = vi.fn();
  const toggleGrantToolset: any = vi.fn();
  const toggleNewGrantToolset: any = vi.fn();
  const updateGrant: any = vi.fn();
  const previewToolPolicy: any = vi.fn();

  return {
    isBusy,
    copyIssuedToolToken,
    createGrant,
    deleteGrant,
    enabledToolGrantCount,
    grantHasToolset,
    grantToolRuleState,
    issuedToolToken,
    newGrantLabel,
    newGrantScopes,
    newGrantToolsets,
    policyPreviewGrantId,
    policyPreviewProfileId,
    policyPreviewProfileOptionBarOptions,
    policyPreviewResult,
    policyPreviewToolId,
    policyPreviewToolOptionBarOptions,
    previewToolPolicy,
    rotateGrant,
    selectToolForManagement,
    selectedOperationPermissionTool,
    setGrantToolRule,
    toggleGrantToolset,
    toggleNewGrantToolset,
    toolGrants,
    operationPermissionTools,
    operationPermissionToolsets,
    toolScopes,
    updateGrant,
  };
}

function createHarness() : any {
  const operationPermissionConsole: any = createOperationPermissionShell();
  const shell: Record<string, any> = { operationPermissionConsole };
  shellContextMock.useServerConsoleShellContext.mockReturnValue(namespaceServerConsoleShell(shell));

  let controller: ReturnType<typeof useOperationPermissionViewConsole> | null = null;
  const host: any = defineComponent({
    setup() : any {
      controller = useOperationPermissionViewConsole();
      return () : any => null;
    },
  });
  const wrapper: any = mount(host);

  return {
    controller: controller as ReturnType<typeof useOperationPermissionViewConsole>,
    operationPermissionConsole,
    wrapper,
  };
}

let mountedWrappers: VueWrapper[] = [];

beforeEach(() : any => {
  vi.clearAllMocks();
  authorizationGovernanceClientMock.getAuthorizationGovernance.mockReset();
  authorizationGovernanceClientMock.upsertAuthorizationGovernance.mockReset();
  shellContextMock.useServerConsoleShellContext.mockReset();
});

afterEach(() : any => {
  for (const wrapper of mountedWrappers) {
    wrapper.unmount();
  }
  mountedWrappers = [];
});

describe("console operation permission view controller extra", () : any => {
  it("loads governance, resets the editor on mount, and keeps metrics in sync", async () : Promise<any> => {
    const refreshGate: any = deferred<{ governance: GovernanceSummary }>();
    authorizationGovernanceClientMock.getAuthorizationGovernance.mockReturnValueOnce(refreshGate.promise);

    const harness: any = createHarness();
    mountedWrappers.push(harness.wrapper);

    await nextTick();

    expect(harness.controller.authorizationGovernanceLoading.value).toBe(true);
    expect(harness.controller.authorizationGovernanceEditorKind.value).toBe("team");
    expect(harness.controller.authorizationGovernanceEditorBody.value).toContain("\"team-code\"");
    expect(harness.controller.authorizationGovernanceEditorStatus.value).toBe("");
    expect(harness.controller.authorizationGovernanceEditorKinds.map((kind?: any) : any => kind.value)).toEqual([
      "role",
      "department",
      "team",
      "userPolicy",
      "agentGroup",
      "agentBinding",
      "approval",
    ]);

    refreshGate.resolve({ governance: makeGovernance() });
    await flushPromises();

    expect(harness.controller.authorizationGovernanceLoading.value).toBe(false);
    expect(harness.controller.authorizationGovernanceError.value).toBe("");
    expect(harness.controller.authorizationGovernance.value.teams).toHaveLength(2);
    expect(harness.controller.authorizationGovernanceMetrics.value).toEqual([
      { label: "角色", value: 1 },
      { label: "部门", value: 0 },
      { label: "团队", value: 2 },
      { label: "用户策略", value: 1 },
      { label: "智能体绑定", value: 1 },
      { label: "审批", value: 2 },
    ]);
  });

  it("saves governance, refreshes after save, and reports fallback errors", async () : Promise<any> => {
    authorizationGovernanceClientMock.getAuthorizationGovernance
      .mockResolvedValueOnce({ governance: makeGovernance() });

    const harness: any = createHarness();
    mountedWrappers.push(harness.wrapper);
    await flushPromises();

    const saveGate: any = deferred<void>();
    authorizationGovernanceClientMock.upsertAuthorizationGovernance.mockReturnValueOnce(saveGate.promise);
    authorizationGovernanceClientMock.getAuthorizationGovernance.mockResolvedValueOnce({
      governance: makeGovernance({
        approvals: [{ id: "approval-1" }],
      }),
    });

    harness.controller.authorizationGovernanceEditorKind.value = "agentGroup";
    await nextTick();
    harness.controller.authorizationGovernanceEditorBody.value = JSON.stringify({
      groupId: "group-save",
      label: "Saved group",
    });

    const pendingSave: any = harness.controller.saveAuthorizationGovernanceEditor();
    expect(harness.controller.authorizationGovernanceSaving.value).toBe(true);
    expect(harness.controller.authorizationGovernanceEditorStatus.value).toBe("");
    expect(harness.controller.authorizationGovernanceError.value).toBe("");

    saveGate.resolve();
    await pendingSave;

    expect(authorizationGovernanceClientMock.upsertAuthorizationGovernance).toHaveBeenCalledWith("agentGroup", {
      groupId: "group-save",
      label: "Saved group",
    });
    expect(authorizationGovernanceClientMock.getAuthorizationGovernance).toHaveBeenCalledTimes(2);
    expect(harness.controller.authorizationGovernanceSaving.value).toBe(false);
    expect(harness.controller.authorizationGovernanceEditorStatus.value).toBe("已保存");
    expect(harness.controller.authorizationGovernance.value.approvals).toHaveLength(1);

    harness.controller.authorizationGovernanceEditorBody.value = "{}";
    authorizationGovernanceClientMock.upsertAuthorizationGovernance.mockRejectedValueOnce("bad save");
    await harness.controller.saveAuthorizationGovernanceEditor();

    expect(harness.controller.authorizationGovernanceEditorStatus.value).toBe("保存失败");
    expect(harness.controller.authorizationGovernanceSaving.value).toBe(false);

    authorizationGovernanceClientMock.getAuthorizationGovernance.mockRejectedValueOnce(new Error("load failed"));
    await harness.controller.refreshAuthorizationGovernance();
    expect(harness.controller.authorizationGovernanceLoading.value).toBe(false);
    expect(harness.controller.authorizationGovernanceError.value).toBe("load failed");
  });

  it("switches tool selection and exposes governance formatting helpers", async () : Promise<any> => {
    authorizationGovernanceClientMock.getAuthorizationGovernance.mockResolvedValueOnce({
      governance: makeGovernance({ roles: [] }),
    });

    const harness: any = createHarness();
    mountedWrappers.push(harness.wrapper);
    await flushPromises();

    expect(harness.controller.selectedOperationPermissionTool.value?.id).toBe("tool-a");

    harness.controller.handleSelectedToolChange({
      target: { value: "tool-b" },
    } as unknown as Event);
    expect(harness.operationPermissionConsole.selectToolForManagement).toHaveBeenCalledWith("tool-b");
    expect(harness.controller.selectedOperationPermissionTool.value?.id).toBe("tool-b");

    harness.controller.handleSelectedToolChange({
      target: null,
    } as unknown as Event);
    expect(harness.operationPermissionConsole.selectToolForManagement).toHaveBeenCalledWith("");
    expect(harness.controller.selectedOperationPermissionTool.value?.id).toBe("tool-a");

    expect(harness.controller.itemText({ label: "优先", alias: "备用" }, ["label", "alias"], "fallback")).toBe("优先");
    expect(harness.controller.itemText({}, ["label", "alias"], "fallback")).toBe("fallback");
    expect(harness.controller.shortList(["alpha", "beta", "gamma", "delta"])).toBe("alpha, beta, gamma +1");
    expect(harness.controller.shortList("alpha, beta, gamma")).toBe("alpha, beta, gamma");
    expect(harness.controller.shortList([], "未配置")).toBe("未配置");
    expect(harness.controller.policyCount({ resourcePolicies: [{}, {}] })).toBe(2);
    expect(harness.controller.policyCount({ resourcePolicies: "bad" as unknown as Array<Record<string, unknown>> })).toBe(0);
  });
});
