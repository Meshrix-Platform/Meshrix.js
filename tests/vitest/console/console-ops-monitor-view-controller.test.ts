import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useOpsMonitorViewConsole } from "../../../apps/console/composables/console-ops-monitor-view-controller";
import { namespaceServerConsoleShell } from "./console-shell-test-utils";
import type { MonitorAlertItem } from "../../../apps/console/lib/types";
import { monitorAlertSeverityLabel, monitorAlertSeverityTone } from "../../../apps/console/composables/console-status-utils";

const shellContextMock: any = vi.hoisted(() : any => ({
  useServerConsoleShellContext: vi.fn(),
}));

vi.mock("#meshrix/console/server-console-shell-context", () : any => ({
  useServerConsoleShellContext: shellContextMock.useServerConsoleShellContext,
}));

function makeMonitorAlert(overrides: Record<string, any> = {}): MonitorAlertItem {
  return {
    alertId: "alert-1",
    ruleId: "rule-1",
    severity: "critical",
    title: "客户端线程告警",
    message: "请检查 PID 1 当前状态异常。拉起进程时状态中断。",
    source: "daemon",
    role: "运维进程",
    status: "open",
    active: true,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:03:00.000Z",
    ...overrides,
  };
}

function createFixture(overrides: Record<string, any> = {}) : any {
  const isBusy: any = () => false;
  const backgroundProcesses: any = ref([
    {
      role: "daemon",
      label: "daemon",
      description: "任务守护进程",
      desired: true,
      pid: 11,
      alive: true,
      stale: false,
      status: "running",
      restartCount: 1,
    },
  ]);
  const backgroundProcessStatus: any = ref({
    schemaVersion: "v0.0.1:schema:definition-1",
    ok: true,
    status: "running",
    updatedAt: "2026-01-01T00:00:00.000Z",
    statePath: "/tmp/supervisor.json",
    supervisor: { pid: 11, alive: true, status: "running" },
    processes: backgroundProcesses.value,
  });
  const monitorAlertConfigText: any = ref(JSON.stringify({
    schemaVersion: "v0.0.1:schema:definition-1",
    enabled: true,
    intervalMs: 1000,
    heartbeatStaleMs: 5000,
    rules: {},
    historyLimit: 20,
  }));
  const activeMonitorAlerts: any = ref([makeMonitorAlert({ alertId: "a-1", resourceRef: "q-1", source: "work-queue-observation", role: "daemon" })]);
  const historyAlert: any = makeMonitorAlert({
    alertId: "a-1",
    resourceRef: "q-1",
    source: "work-queue-observation",
    role: "daemon",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:04:00.000Z",
  });
  const recentMonitorAlertHistory: any = ref([
    historyAlert,
    makeMonitorAlert({
      alertId: "a-2",
      status: "recovered",
      active: false,
      ackRequired: true,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:02:00.000Z",
      resourceRef: "q-2",
    }),
  ]);
  const shell: Record<string, any> = {
    acknowledgeMonitorAlert: vi.fn(async () : Promise<any> => undefined),
    backgroundProcessStatus,
    backgroundProcesses,
    backgroundRunningCount: computed(() : any =>
      backgroundProcesses.value.filter((item?: any) : any => item.alive && !item.stale).length,
    ),
    backgroundSupervisorLabel: computed(() : any => (backgroundProcessStatus.value?.supervisor.alive ? "正常" : "守护进程离线")),
    isBusy,
    canAdminMaintenanceAgent: ref(false),
    activeMonitorAlerts,
    monitorAlertConfigText,
    monitorAlertSummary: computed(() : any => ({
      activeCount: 1,
      visibleCount: 1,
      recoveredCount: 0,
      criticalCount: 1,
      warningCount: 0,
      historyCount: 2,
    })),
    monitorAlertState: ref({
      summary: {
        activeCount: 1,
        visibleCount: 1,
        recoveredCount: 0,
        criticalCount: 1,
        warningCount: 0,
        historyCount: 2,
      },
      activeAlerts: activeMonitorAlerts.value,
      history: recentMonitorAlertHistory.value,
    }),
    recentMonitorAlertHistory,
    saveMonitorAlertConfig: vi.fn(async () : Promise<any> => undefined),
    };

  shellContextMock.useServerConsoleShellContext.mockReturnValue(namespaceServerConsoleShell(shell));
  const controller: any = useOpsMonitorViewConsole();

  return {
    shell,
    controller,
  };
}

describe("console ops monitor view controller", () : any => {
  it("映射 shell 字段并保留卡片状态数据与汇总标签", () : any => {
    const { shell, controller } = createFixture();

    expect(controller.backgroundProcessStatus).toBe(shell.backgroundProcessStatus);
    expect(controller.backgroundSupervisorLabel.value).toBe("正常");
    expect(controller.backgroundRunningCount.value).toBe(1);
    expect(controller.monitorAlertSummary.value.criticalCount).toBe(1);
    expect(typeof controller.backgroundProcessTone).toBe("function");
    expect(controller.saveMonitorAlertConfig).toBe(shell.saveMonitorAlertConfig);
  });

  it("去重告警并按 merge key 合并 active + history", () : any => {
    const { controller } = createFixture();
    const merged: any = controller.mergedMonitorAlerts.value;

    const ids: any = merged.map((alert?: any) : any => alert.alertId);
    expect(ids).toEqual(["a-1", "a-2"]);
    expect(merged[0]).toMatchObject({
      alertId: "a-1",
      resourceRef: "q-1",
      source: "work-queue-observation",
    });
  });

  it("可生成包含状态、资源引用与来源的告警明细，并在非生命周期模式下省略状态行", () : any => {
    const { controller } = createFixture();
    const sourceAlert: any = makeMonitorAlert({
      alertId: "a-detail",
      message: "请先检查 PID 9。当前状态 中断。影响 下游任务 依赖丢失。",
      source: "work-queue-observation",
      role: "daemon",
      resourceRef: "queue-9",
      status: "open",
      active: true,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:05:00.000Z",
      acknowledgedAt: "",
    });
    const withLifecycle: any = controller.monitorAlertDetailBullets(sourceAlert, true);

    expect(withLifecycle).toEqual([
      { label: "状态", text: "open" },
      { label: "资源引用", text: "queue-9" },
      { label: "处理", text: "请先检查 PID 9" },
      { label: "状态", text: "当前状态 中断" },
      { label: "影响", text: "影响 下游任务 依赖丢失" },
      { label: "来源", text: "work-queue-observation，daemon" },
    ]);

    const withoutLifecycle: any = controller.monitorAlertDetailBullets(sourceAlert, false);
    expect(withoutLifecycle[0]).toEqual({ label: "资源引用", text: "queue-9" });
    expect(withoutLifecycle.map((item?: any) : any => item.label)).toEqual([
      "资源引用",
      "处理",
      "状态",
      "影响",
      "来源",
    ]);
  });

  it("空消息会回退到占位详情文本并复用告警工具函数映射", () : any => {
    const { controller } = createFixture();
    const emptyBullets: any = controller.monitorAlertDetailBullets(
      makeMonitorAlert({
        alertId: "a-empty",
        message: "",
        source: "",
        role: "",
        resourceRef: "",
      }),
      false,
    );
    expect(emptyBullets).toEqual([{ label: "详情", text: "-" }]);
    expect(controller.monitorAlertSeverityLabel("warning")).toBe("警告");
    expect(controller.monitorAlertSeverityTone("warning")).toBe("warning");
    expect(controller.monitorAlertMergeKey({
      alertId: "a-x",
      ruleId: "r",
      severity: "warning",
      title: "x",
      message: "x",
      source: "s",
      role: "r",
      status: "open",
      active: true,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    } as any)).toBe("a-x:::active");
    expect(controller.monitorAlertMergeKey({
      alertId: "a-x",
      ruleId: "r",
      severity: "warning",
      title: "x",
      message: "x",
      source: "s",
      role: "r",
      status: "open",
      active: true,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: "2026-01-01T00:01:00.000Z",
      acknowledgedAt: "2026-01-01T00:01:30.000Z",
    } as any)).toBe("a-x:2026-01-01T00:01:00.000Z:2026-01-01T00:01:30.000Z:active");
    expect(controller.backgroundProcessLabel("running")).toBe("运行中");
    expect(monitorAlertSeverityTone("critical")).toBe("failed");
    expect(monitorAlertSeverityLabel("critical")).toBe("严重");
    expect(controller.processTypeLabel("daemon")).toBe("守护进程");
    expect(controller.processRelationText({
      services: ["svc-a", "svc-b"],
      monitors: ["m1"],
      alerts: [],
    } as any)).toBe("服务：svc-a，svc-b；监控：m1");
  });
});
