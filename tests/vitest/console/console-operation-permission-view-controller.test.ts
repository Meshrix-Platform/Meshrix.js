// @vitest-environment jsdom
import { computed, defineComponent, nextTick, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOperationPermissionViewConsole } from "../../../apps/console/composables/console-operation-permission-view-controller";

const authorizationGovernanceClientMock = vi.hoisted(() => ({
  getAuthorizationGovernance: vi.fn(),
  upsertAuthorizationGovernance: vi.fn(),
}));

const shellContextMock = vi.hoisted(() => ({
  useServerConsoleShellContext: vi.fn(),
}));

vi.mock("../../../apps/console/lib/authorization-governance-client", () => ({
  getAuthorizationGovernance: authorizationGovernanceClientMock.getAuthorizationGovernance,
  upsertAuthorizationGovernance: authorizationGovernanceClientMock.upsertAuthorizationGovernance,
}));

vi.mock("../../../apps/console/composables/serverConsoleShellContext", () => ({
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => nextTick());
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

function createOperationPermissionShell() {
  const busyKey = ref("");
  const issuedToolToken = ref("issued-token");
  const newGrantLabel = ref("默认智能体");
  const newGrantScopes = ref(["scope.read"]);
  const newGrantToolsets = ref(["toolset.read"]);
  const policyPreviewGrantId = ref("");
  const policyPreviewProfileId = ref("");
  const policyPreviewResult = ref<Record<string, unknown> | null>(null);
  const policyPreviewToolId = ref("tool-a");
  const selectedToolId = ref("tool-a");
  const toolGrants = ref<OperationPermissionGrant[]>([
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
  const operationPermissionTools = ref<OperationPermissionTool[]>([
    { id: "tool-a", label: "Tool A" },
    { id: "tool-b", label: "Tool B" },
  ]);
  const operationPermissionToolsets = ref([
    { id: "toolset.read", maxRisk: "read_only", grantable: true },
    { id: "toolset.safe", maxRisk: "safe_write", grantable: true },
    { id: "toolset.admin", maxRisk: "high", grantable: true },
  ]);
  const toolScopes = ref([
    { id: "scope.read" },
    { id: "scope.write" },
    { id: "scope.admin" },
  ]);
  const policyPreviewToolOptionBarOptions = computed(() =>
    operationPermissionTools.value.map((tool) => ({
      value: tool.id,
      label: `${tool.label} / ${tool.id}`,
    })),
  );
  const policyPreviewProfileOptionBarOptions = computed(() => [
    { value: "", label: "不绑定档案" },
    { value: "profile-1", label: "默认档案 / profile-1" },
  ]);
  const selectedOperationPermissionTool = computed(() =>
    operationPermissionTools.value.find((tool) => tool.id === selectedToolId.value) ||
    operationPermissionTools.value[0] ||
    null,
  );
  const enabledToolGrantCount = computed(() => toolGrants.value.filter((grant) => grant.enabled).length);
  const selectToolForManagement = vi.fn((toolId: string) => {
    selectedToolId.value = toolId;
    policyPreviewToolId.value = toolId;
  });
  const grantToolRuleState = vi.fn(
    (grant: { toolAllow?: string[]; toolDeny?: string[] }, toolId: string) => {
      if ((grant.toolDeny || []).includes(toolId)) {
        return "deny";
      }
      if ((grant.toolAllow || []).includes(toolId)) {
        return "allow";
      }
      return "inherit";
    },
  );
  const grantHasToolset = vi.fn((grant: { toolsets?: string[] }, toolsetId: string) =>
    (grant.toolsets || []).includes(toolsetId),
  );
  const copyIssuedToolToken = vi.fn();
  const createGrant = vi.fn();
  const deleteGrant = vi.fn();
  const rotateGrant = vi.fn();
  const setGrantToolRule = vi.fn();
  const toggleGrantToolset = vi.fn();
  const toggleNewGrantToolset = vi.fn();
  const updateGrant = vi.fn();
  const previewToolPolicy = vi.fn();

  return {
    busyKey,
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

function createHarness() {
  const operationPermissionConsole = createOperationPermissionShell();
  const shell = { operationPermissionConsole };
  shellContextMock.useServerConsoleShellContext.mockReturnValue(shell);

  let controller: ReturnType<typeof useOperationPermissionViewConsole> | null = null;
  const host = defineComponent({
    setup() {
      controller = useOperationPermissionViewConsole();
      return () => null;
    },
  });
  const wrapper = mount(host);

  return {
    controller: controller as ReturnType<typeof useOperationPermissionViewConsole>,
    operationPermissionConsole,
    wrapper,
  };
}

let mountedWrappers: VueWrapper[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  authorizationGovernanceClientMock.getAuthorizationGovernance.mockReset();
  authorizationGovernanceClientMock.upsertAuthorizationGovernance.mockReset();
  shellContextMock.useServerConsoleShellContext.mockReset();
});

afterEach(() => {
  for (const wrapper of mountedWrappers) {
    wrapper.unmount();
  }
  mountedWrappers = [];
});

describe("console operation permission view controller extra", () => {
  it("loads governance, resets the editor on mount, and keeps metrics in sync", async () => {
    const refreshGate = deferred<{ governance: GovernanceSummary }>();
    authorizationGovernanceClientMock.getAuthorizationGovernance.mockReturnValueOnce(refreshGate.promise);

    const harness = createHarness();
    mountedWrappers.push(harness.wrapper);

    await nextTick();

    expect(harness.controller.authorizationGovernanceLoading.value).toBe(true);
    expect(harness.controller.authorizationGovernanceEditorKind.value).toBe("team");
    expect(harness.controller.authorizationGovernanceEditorBody.value).toContain("\"team-code\"");
    expect(harness.controller.authorizationGovernanceEditorStatus.value).toBe("");
    expect(harness.controller.authorizationGovernanceEditorKinds.map((kind) => kind.value)).toEqual([
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

  it("saves governance, refreshes after save, and reports fallback errors", async () => {
    authorizationGovernanceClientMock.getAuthorizationGovernance
      .mockResolvedValueOnce({ governance: makeGovernance() });

    const harness = createHarness();
    mountedWrappers.push(harness.wrapper);
    await flushPromises();

    const saveGate = deferred<void>();
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

    const pendingSave = harness.controller.saveAuthorizationGovernanceEditor();
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

  it("switches tool selection and exposes governance formatting helpers", async () => {
    authorizationGovernanceClientMock.getAuthorizationGovernance.mockResolvedValueOnce({
      governance: makeGovernance({ roles: [] }),
    });

    const harness = createHarness();
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
