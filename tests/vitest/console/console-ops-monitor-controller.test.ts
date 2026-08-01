import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleOpsMonitorController } from "../../../apps/console/composables/console-ops-monitor-controller";

const opsMonitorClientMock: any = vi.hoisted(() : any => ({
  acknowledgeMonitorAlert: vi.fn(),
  getBackgroundProcesses: vi.fn(),
  getMonitorAlerts: vi.fn(),
  recoverBackgroundSupervisor: vi.fn(),
  saveMonitorAlertConfig: vi.fn(),
}));

vi.mock("../../../apps/console/lib/ops-monitor-client", () : any => ({
  acknowledgeMonitorAlert: opsMonitorClientMock.acknowledgeMonitorAlert,
  getBackgroundProcesses: opsMonitorClientMock.getBackgroundProcesses,
  getMonitorAlerts: opsMonitorClientMock.getMonitorAlerts,
  recoverBackgroundSupervisor: opsMonitorClientMock.recoverBackgroundSupervisor,
  saveMonitorAlertConfig: opsMonitorClientMock.saveMonitorAlertConfig,
}));

function makeBackgroundProcessStatus(overrides: Record<string, unknown> = {}) : any {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    ok: true,
    status: "running",
    updatedAt: "2026-01-01T00:00:00.000Z",
    statePath: "/tmp/supervisor.json",
    supervisor: { pid: 12, alive: true, status: "running" },
    processes: [],
    ...overrides,
  };
}

function makeMonitorAlertState(overrides: Record<string, unknown> = {}) : any {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    ok: true,
    status: "ok",
    updatedAt: "2026-01-01T00:00:00.000Z",
    configPath: "/tmp/monitor-alerts.json",
    statePath: "/tmp/monitor-alerts-state.json",
    config: {
      schemaVersion: "v0.0.1:schema:definition-1",
      enabled: true,
      intervalMs: 1_000,
      heartbeatStaleMs: 5_000,
      historyLimit: 20,
      rules: {},
    },
    summary: {
      activeCount: 1,
      visibleCount: 1,
      recoveredCount: 0,
      criticalCount: 0,
      warningCount: 1,
      historyCount: 2,
    },
    workQueueObservation: null,
    activeAlerts: [],
    history: [],
    ...overrides,
  };
}

function makeMaintenanceRun() : any {
  return {
    runId: "run-maint",
    status: "running",
    startedAt: "2026-01-01T00:01:00.000Z",
    updatedAt: "2026-01-01T00:01:30.000Z",
    createdAt: "2026-01-01T00:01:00.000Z",
    intent: "巡检",
    plan: {
      summary: "巡检计划",
      status: "running",
    },
    unifiedRegistration: {
      schemaVersion: "v0.0.1:schema:definition-1",
      registrationId: "maintenance:run-maint",
      originalType: "task",
      originalId: "run-maint",
      label: "运行巡检",
      status: "running",
      tone: "running",
      source: "maintenance-agent",
      registeredAt: "2026-01-01T00:01:00.000Z",
      route: { originalType: "task", section: "maintenance", behavior: "run" },
      relations: { queueId: "q-maint" },
      attributes: {
        queueId: "q-maint",
        taskType: "maintenance-agent",
        status: "running",
        lifecycleStatus: "running",
        stage: "running",
      },
      originalRef: {},
    },
  };
}

function createFixture(overrides: Record<string, unknown> = {}) : any {
  const busyKey: any = ref("");
  const error: any = ref("");
  const clearAllBusy: any = vi.fn(() : any => {
    busyKey.value = "";
  });
  const setBusy: any = vi.fn((value: string) : any => {
    busyKey.value = value;
  });

  const allMaintenanceAgentRuns: any = overrides.allMaintenanceAgentRuns ?? ref([makeMaintenanceRun() as any]);
  const canAdminMaintenanceAgent: any = overrides.canAdminMaintenanceAgent ?? ref(true);
  const canReadMaintenanceAgent: any = overrides.canReadMaintenanceAgent ?? ref(true);
  const consoleState: any = overrides.consoleState ??
    ref({
      jobs: {
        items: [
          {
            id: "job-open",
            status: "running",
            queueId: "q-open",
            updatedAt: "2026-01-01T00:00:45.000Z",
            createdAt: "2026-01-01T00:00:40.000Z",
            startedAt: "2026-01-01T00:00:45.000Z",
            stage: "parse",
            progressPercent: 20,
          },
          {
            id: "job-unique",
            status: "queued",
            queueId: "q-unique",
            updatedAt: "2026-01-01T00:01:45.000Z",
            createdAt: "2026-01-01T00:01:40.000Z",
            startedAt: "2026-01-01T00:01:40.000Z",
            stage: "parse",
            progressPercent: 40,
          },
        ],
      },
    } as any);

  const controller: any = createConsoleOpsMonitorController({
    allMaintenanceAgentRuns,
    canAdminMaintenanceAgent,
    canReadMaintenanceAgent,
    clearAllBusy,
    consoleState,
    error,
    setBusy,
  });

  if (overrides.monitorAlertState) {
    controller.monitorAlertState.value = (overrides.monitorAlertState as { value: unknown }).value;
  }

  return {
    allMaintenanceAgentRuns,
    canAdminMaintenanceAgent,
    canReadMaintenanceAgent,
    clearAllBusy,
    consoleState,
    controller,
    error,
    busyKey,
    setBusy,
    monitorAlertState: overrides.monitorAlertState ?? (controller.monitorAlertState as any),
  };
}

beforeEach(() : any => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  vi.clearAllMocks();
});

afterEach(() : any => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("console ops monitor controller", () : any => {
  it("暴露告警汇总默认值并在无读权限时跳过刷新", async () : Promise<any> => {
    const { controller, canReadMaintenanceAgent, error } = createFixture({
      canReadMaintenanceAgent: ref(false),
    });

    expect(controller.monitorAlertSummary.value).toEqual({
      activeCount: 0,
      visibleCount: 0,
      recoveredCount: 0,
      criticalCount: 0,
      warningCount: 0,
      historyCount: 0,
    });

    await controller.refreshBackgroundProcesses();
    await controller.refreshMonitorAlerts();

    expect(canReadMaintenanceAgent.value).toBe(false);
    expect(opsMonitorClientMock.getBackgroundProcesses).not.toHaveBeenCalled();
    expect(opsMonitorClientMock.getMonitorAlerts).not.toHaveBeenCalled();
    expect(error.value).toBe("");
  });

  it("刷新后台进程与监控报警时区分静默和可见分支，并正确清理忙状态", async () : Promise<any> => {
    const { controller, clearAllBusy, setBusy, error } = createFixture();
    const backgroundStatus: any = makeBackgroundProcessStatus({
      processes: [
        {
          role: "daemon",
          label: "daemon",
          description: "任务守护进程",
          desired: true,
          pid: 12,
          alive: true,
          stale: false,
          status: "running",
          restartCount: 1,
        },
      ],
    });
    const alertState: any = makeMonitorAlertState({
      summary: {
        activeCount: 3,
        visibleCount: 2,
        recoveredCount: 1,
        criticalCount: 1,
        warningCount: 2,
        historyCount: 4,
      },
      activeAlerts: [
        {
          alertId: "a-1",
          ruleId: "r",
          severity: "warning",
          title: "预警",
          message: "告警文本",
          source: "daemon",
          role: "worker",
          status: "open",
          active: true,
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:01:00.000Z",
        } as any,
      ],
      workQueueObservation: {
        observed: true,
        itemCount: 2,
        statusCounts: { running: 1, interrupted: 1 },
      },
    });

    opsMonitorClientMock.getBackgroundProcesses.mockResolvedValueOnce(backgroundStatus);
    opsMonitorClientMock.getMonitorAlerts
      .mockResolvedValueOnce(alertState)
      .mockResolvedValueOnce(alertState);

    await controller.refreshBackgroundProcesses({ silent: true });
    expect(setBusy).not.toHaveBeenCalled();
    expect(clearAllBusy).not.toHaveBeenCalled();

    await controller.refreshMonitorAlerts({ silent: true });
    expect(clearAllBusy).not.toHaveBeenCalled();

    expect(controller.backgroundSupervisorLabel.value).toBe("正常");
    expect(controller.backgroundRunningCount.value).toBe(1);
    expect(controller.monitorAlertSummary.value).toEqual(alertState.summary);

    await controller.refreshBackgroundProcesses();
    await controller.refreshMonitorAlerts();
    expect(setBusy).toHaveBeenNthCalledWith(1, "background-processes:refresh");
    expect(setBusy).toHaveBeenNthCalledWith(2, "monitor-alerts:refresh");
    expect(clearAllBusy).toHaveBeenCalledTimes(2);
    expect(error.value).toBe("");
  });

  it("确认告警支持权限分支、成功刷新状态与失败文案", async () : Promise<any> => {
    const { controller, canAdminMaintenanceAgent, setBusy, error } = createFixture({
      canAdminMaintenanceAgent: ref(false),
    });

    await controller.acknowledgeMonitorAlert("a-1");
    expect(opsMonitorClientMock.acknowledgeMonitorAlert).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(error.value).toBe("当前账号没有维护配置权限。");

    canAdminMaintenanceAgent.value = true;
    opsMonitorClientMock.acknowledgeMonitorAlert.mockRejectedValueOnce(new Error("ack failed"));
    await controller.acknowledgeMonitorAlert("a-1");
    expect(setBusy).toHaveBeenLastCalledWith("monitor-alert:ack:a-1");
    expect(error.value).toBe("ack failed");

    opsMonitorClientMock.acknowledgeMonitorAlert.mockResolvedValueOnce(
      makeMonitorAlertState({
        summary: {
          ...makeMonitorAlertState().summary,
          activeCount: 0,
        },
      }),
    );
    await controller.acknowledgeMonitorAlert("a-1");
    expect(opsMonitorClientMock.acknowledgeMonitorAlert).toHaveBeenCalledWith("a-1");
    expect(controller.monitorAlertSummary.value.activeCount).toBe(0);
  });

  it("保存告警配置支持权限短路、JSON 解析失败和成功回写状态", async () : Promise<any> => {
    const { controller, canAdminMaintenanceAgent, error, setBusy } = createFixture({
      canAdminMaintenanceAgent: ref(false),
    });
    controller.monitorAlertConfigText.value = "{}";

    await controller.saveMonitorAlertConfig();
    expect(opsMonitorClientMock.saveMonitorAlertConfig).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();

    canAdminMaintenanceAgent.value = true;
    controller.monitorAlertConfigText.value = "{";
    await controller.saveMonitorAlertConfig();
    expect(opsMonitorClientMock.saveMonitorAlertConfig).not.toHaveBeenCalled();
    expect(error.value).toMatch(/Unexpected token|Expected property name/);

    const nextState: any = makeMonitorAlertState({
      summary: {
        ...makeMonitorAlertState().summary,
        activeCount: 4,
        warningCount: 1,
      },
      workQueueObservation: null,
    });
    controller.monitorAlertConfigText.value = JSON.stringify(nextState.config);
    opsMonitorClientMock.saveMonitorAlertConfig.mockResolvedValueOnce(nextState);

    await controller.saveMonitorAlertConfig();
    expect(opsMonitorClientMock.saveMonitorAlertConfig).toHaveBeenCalledWith(nextState.config);
    expect(controller.monitorAlertSummary.value).toEqual(nextState.summary);
    expect(controller.monitorAlertConfigText.value).toContain('"rules"');
  });

  it("恢复后台 Supervisor 时覆盖本地状态并在失败时回退到警报读取", async () : Promise<any> => {
    const { controller, error } = createFixture();
    const status: any = makeBackgroundProcessStatus({
      status: "failed",
      supervisor: { pid: 99, alive: false, status: "failed" },
    });
    const monitorState: any = makeMonitorAlertState({
      summary: {
        ...makeMonitorAlertState().summary,
        activeCount: 5,
      },
    });
    const fallbackMonitorState: any = makeMonitorAlertState({
      summary: {
        ...makeMonitorAlertState().summary,
        activeCount: 2,
      },
    });

    opsMonitorClientMock.getMonitorAlerts.mockResolvedValueOnce(fallbackMonitorState);
    opsMonitorClientMock.recoverBackgroundSupervisor.mockResolvedValueOnce({
      recovery: { ok: false, reason: "daemon missing" },
      backgroundProcessStatus: status,
      monitorAlertState: null,
    });
    await controller.recoverBackgroundSupervisor();

    expect(opsMonitorClientMock.recoverBackgroundSupervisor).toHaveBeenCalledTimes(1);
    expect(opsMonitorClientMock.getMonitorAlerts).toHaveBeenCalledTimes(1);
    expect(controller.backgroundProcessStatus.value).toEqual(status);
    expect(controller.monitorAlertState.value).toEqual(fallbackMonitorState);
    expect(error.value).toBe("拉起后台 Worker 管理进程未成功：daemon missing");

    opsMonitorClientMock.recoverBackgroundSupervisor.mockResolvedValueOnce({
      recovery: { ok: true, reason: "no-op", attempted: true },
      backgroundProcessStatus: makeBackgroundProcessStatus({ status: "running", ok: true }),
      monitorAlertState: monitorState,
    });
    await controller.recoverBackgroundSupervisor();
    expect(controller.monitorAlertState.value).toEqual(monitorState);
    expect(error.value).toBe("");
  });

  it("恢复后台 Supervisor 的客户端请求失败会正确透传错误文本", async () : Promise<any> => {
    const { controller, error } = createFixture();
    opsMonitorClientMock.recoverBackgroundSupervisor.mockRejectedValueOnce(new Error("recover failed"));

    await controller.recoverBackgroundSupervisor();
    expect(error.value).toBe("recover failed");
  });

  it("分别汇总任务队列行和只读工作队列观察指标", async () : Promise<any> => {
    const { allMaintenanceAgentRuns, controller } = createFixture({
      allMaintenanceAgentRuns: ref([makeMaintenanceRun() as any]),
      consoleState: ref({
        jobs: {
          items: [
            {
              id: "job-open",
              status: "running",
              queueId: "q-open",
              updatedAt: "2026-01-01T00:00:50.000Z",
              createdAt: "2026-01-01T00:00:45.000Z",
              startedAt: "2026-01-01T00:00:45.000Z",
              stage: "parse",
              progressPercent: 70,
            },
            {
              id: "job-unique",
              status: "queued",
              queueId: "q-unique",
              updatedAt: "2026-01-01T00:00:40.000Z",
              createdAt: "2026-01-01T00:00:30.000Z",
              startedAt: "2026-01-01T00:00:30.000Z",
              stage: "parse",
              progressPercent: 30,
            },
            {
              id: "job-owner-dupe",
              status: "open",
              ownerId: "owner-dupe",
              queueId: "q-owner",
              updatedAt: "2026-01-01T00:00:35.000Z",
              createdAt: "2026-01-01T00:00:32.000Z",
              startedAt: "2026-01-01T00:00:32.000Z",
              stage: "parse",
              progressPercent: 10,
            },
          ],
        },
      } as any),
    });

    const closedRun: any = makeMaintenanceRun();
    closedRun.runId = "run-maint-closed";
    closedRun.status = "recovered";
    closedRun.unifiedRegistration.attributes.status = "recovered";
    closedRun.unifiedRegistration.status = "recovered";
    closedRun.unifiedRegistration.registrationId = "maintenance:run-maint-closed";

    controller.monitorAlertState.value = {
      ...controller.monitorAlertState.value,
      workQueueObservation: {
        observed: true,
        itemCount: 2,
        statusCounts: { running: 1, interrupted: 1 },
      },
    };
    allMaintenanceAgentRuns.value = [
      ...allMaintenanceAgentRuns.value,
      closedRun as any,
    ];

    const rows: any = controller.workQueueRows.value;
    expect(controller.workQueueObservationState.value).toEqual({
      observed: true,
      itemCount: 2,
      statusCounts: { running: 1, interrupted: 1 },
    });
    expect(rows.length).toBe(5);
    expect(rows.some((row?: any) : any => row.rowId === "maintenance:run-maint")).toBe(true);
    expect(rows.some((row?: any) : any => row.rowId === "maintenance:run-maint-closed")).toBe(true);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowId: "maintenance:run-maint",
          source: "maintenance-agent",
        }),
      ]),
    );
    expect(controller.workQueueSummary.value).toEqual({
      total: 5,
      active: 4,
      interrupted: 0,
      recovered: 1,
    });
    expect(rows.some((row?: any) : any => row.source === "maintenance-agent")).toBe(true);
    expect(rows.some((row?: any) : any => row.source === "split-job")).toBe(true);
  });
});
