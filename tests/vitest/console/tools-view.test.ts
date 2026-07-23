// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ToolsView from "../../../apps/console/views/admin/ToolsView.vue";

const shellContextMock = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock("../../../apps/console/composables/serverConsoleShellContext", () => ({
  useServerConsoleShellContext: () => shellContextMock.current,
}));

function makeOperationPermissionConsole(overrides: Record<string, unknown> = {}) {
  const selectedOperationPermissionToolId = ref("repo.status");
  const selectedOperationPermissionToolsetId = ref("toolset.repo");
  const operationPermissionTools = ref([
    {
      id: "repo.status",
      label: "Repository Status",
      operationId: "repo.status",
      requiredScopes: ["repo.read"],
      risk: "read_only",
      source: "builtin",
      status: "active",
      toolsets: ["toolset.repo"],
    },
    {
      id: "unknown.tool",
      label: "Unknown Tool",
      operationId: "",
      requiredScopes: [],
      risk: "",
      source: "",
      status: "",
      toolsets: ["toolset.repo"],
    },
  ]);
  const operationPermissionMetricsState = ref({
    averageDurationMs: 12.6,
    byStatus: { denied: 2 },
    callsTotal: 20,
    rateLimitedTotal: 1,
  });
  const operationPermissionStatusRows = ref([
    { label: "allowed", value: 10 },
    { label: "denied", value: 2 },
  ]);
  const operationPermissionRiskRows = ref([
    { label: "read_only", value: 8 },
    { label: "destructive", value: 1 },
  ]);
  const operationPermissionToolsets = ref([
    { defaultForAgents: true, grantable: true, id: "toolset.repo", label: "Repository Tools" },
  ]);
  const toolScopes = ref([{ id: "repo.read", label: "Repository Read" }]);
  const operationPermissionToolGroups = computed(() =>
    operationPermissionToolsets.value
      .map((toolset) => {
        const tools = operationPermissionTools.value.filter((tool) => tool.toolsets.includes(toolset.id));
        return {
          activeToolCount: tools.filter((tool) => tool.status === "active").length,
          defaultForAgents: toolset.defaultForAgents === true,
          description: "",
          grantable: toolset.grantable !== false,
          id: toolset.id,
          internalToolCount: tools.filter((tool) => tool.status === "internal").length,
          label: toolset.label,
          maxRisk: "read_only",
          requiredScopes: ["repo.read"],
          sampleToolIds: tools.map((tool) => tool.id),
          toolCount: tools.length,
          toolsetId: toolset.id,
          writeToolCount: 0,
        };
      })
      .filter((group) => group.toolCount > 0),
  );
  const selectedOperationPermissionToolset = computed(
    () => operationPermissionToolGroups.value.find((group) => group.id === selectedOperationPermissionToolsetId.value) || null,
  );
  const selectedOperationPermissionToolsetTools = computed(() =>
    operationPermissionTools.value.filter((tool) => tool.toolsets.includes(selectedOperationPermissionToolsetId.value)),
  );

  return {
    activeOperationPermissionToolCount: computed(() =>
      operationPermissionTools.value.filter((tool) => tool.status === "active").length,
    ),
    defaultAgentToolCount: computed(() =>
      operationPermissionTools.value.filter((tool) => tool.toolsets.includes("toolset.repo")).length,
    ),
    busyKey: ref(""),
    internalOperationPermissionToolCount: computed(() =>
      operationPermissionTools.value.filter((tool) => tool.status === "internal").length,
    ),
    policyPreviewGrantId: ref("grant-a"),
    policyPreviewProfileId: ref("profile-a"),
    policyPreviewProfileOptionBarOptions: ref([
      { label: "Default Agent", value: "profile-a" },
    ]),
    policyPreviewResult: ref({ decision: "allow", reason: "matched" }),
    policyPreviewToolId: ref("repo.status"),
    policyPreviewToolOptionBarOptions: ref([
      { label: "Repository Status", value: "repo.status" },
    ]),
    previewToolPolicy: vi.fn(),
    refreshOperationPermission: vi.fn(),
    selectToolForManagement: vi.fn((toolId: string) => {
      selectedOperationPermissionToolId.value = toolId;
    }),
    selectedOperationPermissionToolId,
    selectedOperationPermissionToolset,
    selectedOperationPermissionToolsetId,
    selectedOperationPermissionToolsetTools,
    selectOperationPermissionToolset: vi.fn((toolsetId: string) => {
      selectedOperationPermissionToolsetId.value = toolsetId;
    }),
    toolGrants: ref([{ id: "grant-a" }]),
    operationPermissionAuditItems: ref([
      {
        durationMs: 42,
        errorCode: "denied",
        finishedAt: "2026-06-04T10:00:00.000Z",
        startedAt: "2026-06-04T09:59:58.000Z",
        status: "failed",
        toolExecutionId: "exec-a",
        toolId: "repo.status",
        traceId: "trace-a",
      },
      {
        durationMs: 8,
        errorCode: "",
        finishedAt: "",
        startedAt: "2026-06-04T09:00:00.000Z",
        status: "ok",
        toolExecutionId: "exec-b",
        toolId: "unknown.tool",
        traceId: "",
      },
    ]),
    operationPermissionCatalogState: ref({ fingerprint: "abcdef1234567890" }),
    operationPermissionMetricsState,
    operationPermissionProfiles: ref([{ id: "profile-a" }]),
    operationPermissionRiskRows,
    operationPermissionStatusRows,
    operationPermissionTools,
    operationPermissionToolGroups,
    operationPermissionToolsets,
    toolScopes,
    ...overrides,
  };
}

function mountToolsView(adminViewValue = "toolList", operationPermissionOverrides: Record<string, unknown> = {}) {
  const adminView = ref(adminViewValue);
  const operationPermissionConsole = makeOperationPermissionConsole(operationPermissionOverrides);
  shellContextMock.current = {
    adminView,
    operationPermissionConsole,
  };
  return {
    adminView,
    operationPermissionConsole,
    wrapper: mount(ToolsView),
  };
}

beforeEach(() => {
  shellContextMock.current = null;
});

describe("ToolsView behavior", () => {
  it("renders tool list, governance controls, labels, fallbacks, and preview action", async () => {
    const { wrapper } = mountToolsView("toolList");

    expect(wrapper.text()).toContain("工具集");
    expect(wrapper.text()).toContain("目录指纹 abcdef123456");
    expect(wrapper.text()).toContain("原子工具 2");
    expect(wrapper.text()).toContain("内部 0");
    expect(wrapper.text()).toContain("Repository Status");
    expect(wrapper.text()).toContain("repo.status");
    expect(wrapper.text()).toContain("builtin");
    expect(wrapper.text()).toContain("Repository Tools");
    expect(wrapper.text()).toContain("Repository Read");
    expect(wrapper.text()).toContain("只读");
    expect(wrapper.text()).toContain("可执行");
    expect(wrapper.text()).toContain("Unknown Tool");
    expect(wrapper.text()).toContain("未声明");
    expect(wrapper.text()).toContain("无操作映射");
    expect(wrapper.text()).toContain("未知");

    const governanceHarness = mountToolsView("toolGovernance");
    expect(governanceHarness.wrapper.text()).toContain("档案 1");
    expect(governanceHarness.wrapper.text()).toContain("授权 1");
    expect(governanceHarness.wrapper.text()).toContain("\"decision\": \"allow\"");

    await governanceHarness.wrapper.find("button.tool-button").trigger("click");
    expect(governanceHarness.operationPermissionConsole.previewToolPolicy).toHaveBeenCalledTimes(1);

    governanceHarness.operationPermissionConsole.busyKey.value = "tool-policy-preview";
    await governanceHarness.wrapper.vm.$nextTick();
    expect(governanceHarness.wrapper.find("button.tool-button").attributes("disabled")).toBeDefined();
    expect(governanceHarness.wrapper.find("button.tool-button").text()).toBe("评估中");
  });

  it("renders empty tool catalog state", () => {
    const { wrapper } = mountToolsView("toolList", {
      activeOperationPermissionToolCount: ref(0),
      internalOperationPermissionToolCount: ref(0),
      policyPreviewResult: ref(null),
      toolGrants: ref([]),
      operationPermissionCatalogState: ref(null),
      operationPermissionProfiles: ref([]),
      operationPermissionToolGroups: ref([]),
      operationPermissionTools: ref([]),
      selectedOperationPermissionToolset: ref(null),
      selectedOperationPermissionToolsetTools: ref([]),
    });

    expect(wrapper.text()).toContain("目录指纹 未加载");
    expect(wrapper.text()).toContain("尚未加载工具目录");
    expect(wrapper.text()).not.toContain("\"decision\"");
  });

  it("renders stats and audit rows with percentages and empty fallbacks", () => {
    const { wrapper } = mountToolsView("toolStats");

    expect(wrapper.text()).toContain("工具统计");
    expect(wrapper.text()).toContain("工具 1/2");
    expect(wrapper.text()).toContain("调用总量");
    expect(wrapper.text()).toContain("20");
    expect(wrapper.text()).toContain("拒绝");
    expect(wrapper.text()).toContain("限流");
    expect(wrapper.text()).toContain("平均耗时");
    expect(wrapper.text()).toContain("13ms");
    expect(wrapper.text()).toContain("状态");
    expect(wrapper.text()).toContain("allowed");
    expect(wrapper.text()).toContain("50%");
    expect(wrapper.text()).toContain("denied");
    expect(wrapper.text()).toContain("10%");
    expect(wrapper.text()).toContain("风险");
    expect(wrapper.text()).toContain("只读");
    expect(wrapper.text()).toContain("40%");
    expect(wrapper.text()).toContain("破坏性");
    expect(wrapper.text()).toContain("5%");
    expect(wrapper.text()).toContain("最近调用");
    expect(wrapper.text()).toContain("exec-a");
    expect(wrapper.text()).toContain("trace-a");
    expect(wrapper.text()).toContain("failed / denied");
    expect(wrapper.text()).toContain("42ms");
    expect(wrapper.text()).toContain("exec-b");
    expect(wrapper.text()).toContain("无 trace");
  });

  it("renders empty stats and audit states when metrics have no rows", () => {
    const { wrapper } = mountToolsView("toolStats", {
      activeOperationPermissionToolCount: ref(0),
      operationPermissionAuditItems: ref([]),
      operationPermissionMetricsState: ref({
        averageDurationMs: 0,
        byStatus: {},
        callsTotal: 0,
        rateLimitedTotal: 0,
      }),
      operationPermissionRiskRows: ref([]),
      operationPermissionStatusRows: ref([]),
      operationPermissionTools: ref([]),
    });

    expect(wrapper.text()).toContain("工具 0/0");
    expect(wrapper.text()).toContain("暂无工具统计");
    expect(wrapper.text()).toContain("暂无工具调用记录");
  });
});
