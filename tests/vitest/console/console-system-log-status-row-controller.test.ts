import { describe, expect, it } from "vitest";
import { buildSystemStatusLogRows } from "../../../apps/console/composables/console-system-log-status-row-controller";

function readonlyValue<T>(value: T) : any {
  return { value };
}

describe("console system log status row controller behavior", () : any => {
  it("builds status log rows across queue, jobs, processes, alerts, config, tools, and auth audit", () : any => {
    const rows: any = buildSystemStatusLogRows({
      activeMonitorAlerts: readonlyValue([
        {
          active: true,
          alertId: "alert-critical-long-id",
          firstSeenAt: "2026-06-04T10:00:00.000Z",
          lastSeenAt: "2026-06-04T10:02:00.000Z",
          message: "队列中断",
          resourceRef: "queue-a",
          role: "worker",
          ruleId: "queueInterrupted",
          severity: "critical",
          source: "work-queue-observation",
          status: "open",
          title: "Critical alert",
        },
      ] as never),
      agentConfigurationAlerts: readonlyValue([
        {
          alertId: "config-alert-a",
          category: "agent",
          detail: "缺少模型配置",
          status: "open",
          targetId: "module-a",
          title: "Model missing",
          tone: "danger",
        },
      ] as never),
      authAudit: readonlyValue([
        {
          action: "login",
          actor: { userId: "user-a", username: "Ada" },
          auditId: "audit-auth-a",
          createdAt: "2026-06-04T10:09:00.000Z",
          durationMs: 33,
          error: "",
          method: "POST",
          operationId: "auth.login",
          path: "/api/auth/login",
          redactedInput: { password: "<redacted>" },
          status: "ok",
          transport: "http",
        },
        {
          actor: {},
          auditId: "audit-operation-b",
          createdAt: "2026-06-04T10:10:00.000Z",
          error: "denied",
          operationId: "storage.backups.restore",
          redactedOutputSummary: { ok: false },
          status: "failed",
          target: { backupId: "backup-a" },
        },
      ] as never),
      backgroundProcesses: readonlyValue([
        {
          alerts: ["lag"],
          alive: true,
          description: "Queue worker",
          error: "",
          features: ["jobs"],
          label: "Queue Worker",
          lastHeartbeatAt: "2026-06-04T10:04:00.000Z",
          mode: "active",
          monitors: ["heartbeat"],
          pid: 1234,
          processType: "daemon",
          restartCount: 2,
          responsibility: "",
          role: "queue-worker",
          services: ["queue"],
          stale: false,
          startedAt: "2026-06-04T10:00:00.000Z",
          status: "running",
        },
        {
          alive: true,
          label: "",
          lastExit: { error: "exit 1" },
          processType: "service",
          role: "stale-service",
          stale: true,
          status: "stale",
        },
      ] as never),
      backgroundProcessStatus: readonlyValue({
        updatedAt: "2026-06-04T10:03:00.000Z",
      } as never),
      recentJobs: readonlyValue([
        {
          checkpointTreeId: "checkpoint-a",
          createdAt: "2026-06-04T09:50:00.000Z",
          error: "job failed",
          id: "job-long-identifier",
          progressPercent: 67,
          queueId: "queue-a",
          resultSummary: { files: 3 },
          stage: "",
          status: "failed",
          updatedAt: "2026-06-04T10:05:00.000Z",
        },
      ] as never),
      recentMonitorAlertHistory: readonlyValue([
        {
          ackRequired: true,
          acknowledgedAt: "2026-06-04T10:07:00.000Z",
          active: false,
          alertId: "alert-recovered",
          firstSeenAt: "2026-06-04T09:00:00.000Z",
          lastSeenAt: "2026-06-04T09:10:00.000Z",
          message: "恢复",
          recoveredAt: "2026-06-04T10:06:00.000Z",
          role: "",
          ruleId: "heartbeat",
          severity: "warning",
          source: "monitor",
          status: "resolved",
          title: "Recovered alert",
        },
      ] as never),
      operationPermissionAuditItems: readonlyValue([
        {
          agentId: "agent-a",
          decision: "deny",
          durationMs: 15,
          errorCode: "policy_denied",
          finishedAt: "2026-06-04T10:08:00.000Z",
          grantId: "grant-a",
          operationId: "repo.status",
          profileId: "profile-a",
          resultSummary: { allowed: false },
          risk: "read_only",
          startedAt: "2026-06-04T10:07:59.000Z",
          status: "failed",
          toolExecutionId: "tool-execution-a",
          toolId: "",
          traceId: "trace-a",
        },
      ] as never),
      workQueueRows: readonlyValue([
        {
          checkpointTreeId: "checkpoint-a",
          detail: "interrupted by shutdown",
          label: "Queue Item",
          lastHeartbeatAt: "2026-06-04T10:00:30.000Z",
          lifecycleStatus: "interrupted",
          ownerId: "owner-a",
          phase: "run",
          queueId: "queue-a",
          registration: { registrationId: "registration-a" },
          rowId: "row-a",
          sourceLabel: "scheduler",
          startedAt: "2026-06-04T10:00:00.000Z",
          status: "interrupted",
          tone: "danger",
          updatedAt: "2026-06-04T10:01:00.000Z",
        },
      ] as never),
    });

    expect(rows.map((row?: any) : any => row.logId)).toEqual([
      "queue:row-a",
      "job:job-long-identifier",
      "process:queue-worker",
      "process:stale-service",
      "alert:alert-critical-long-id:2026-06-04T10:02:00.000Z",
      "alert:alert-recovered:2026-06-04T09:10:00.000Z",
      "config-alert:config-alert-a",
      "tool-audit:tool-execution-a",
      "operation-audit:audit-auth-a",
      "operation-audit:audit-operation-b",
    ]);

    expect(rows[0]).toMatchObject({
      kindLabel: "任务队列",
      displayId: "queue-a",
      status: "interrupted",
      tone: "danger",
      error: "interrupted by shutdown",
    });
    expect(rows[0].detail).toContain("registration registration-a");

    expect(rows[1]).toMatchObject({
      kindLabel: "服务端任务",
      progressPercent: 67,
      error: "job failed",
    });
    expect(rows[1].detail).toContain("checkpoint checkpoint-a");
    expect(rows[1].target).toContain("队列 queue-a");

    expect(rows[2]).toMatchObject({
      kindLabel: "守护进程",
      progressPercent: 100,
      stage: "Queue worker",
      target: "Queue Worker",
    });
    expect(rows[2].detail).toContain("PID 1234");
    expect(rows[3]).toMatchObject({
      kindLabel: "服务进程",
      progressPercent: 50,
      error: "exit 1",
      target: "stale-service",
    });

    expect(rows[4]).toMatchObject({
      kindLabel: "中断报警",
      progressPercent: 0,
      error: "队列中断",
      target: "Critical alert",
    });
    expect(rows[5]).toMatchObject({
      kindLabel: "监控报警",
      progressPercent: 100,
      statusLabel: "已恢复",
      tone: "success",
    });

    expect(rows[6]).toMatchObject({
      kindLabel: "配置报警",
      progressPercent: 0,
      error: "缺少模型配置",
      target: "agent / Model missing",
    });
    expect(rows[7]).toMatchObject({
      kindLabel: "调用记录",
      statusLabel: "failed，deny",
      target: "repo.status",
      error: "policy_denied",
    });
    expect(rows[7].stage).toContain("只读");
    expect(rows[7].detail).toContain("trace trace-a");

    expect(rows[8]).toMatchObject({
      kindLabel: "认证日志",
      target: "Ada，auth.login",
      statusLabel: "ok",
    });
    expect(rows[8].detail).toContain("<redacted>");
    expect(rows[9]).toMatchObject({
      kindLabel: "操作日志",
      target: "anonymous，storage.backups.restore",
      error: "denied",
    });
    expect(rows[9].detail).toContain("backup-a");
  });

  it("returns no rows when all inputs are empty", () : any => {
    expect(buildSystemStatusLogRows({
      activeMonitorAlerts: readonlyValue([]),
      agentConfigurationAlerts: readonlyValue([]),
      authAudit: readonlyValue([]),
      backgroundProcesses: readonlyValue([]),
      backgroundProcessStatus: readonlyValue(null),
      recentJobs: readonlyValue([]),
      recentMonitorAlertHistory: readonlyValue([]),
      operationPermissionAuditItems: readonlyValue([]),
      workQueueRows: readonlyValue([]),
    })).toEqual([]);
  });
});
