import type { ConsoleAuditItem } from "../lib/auth-types";
import type {
  BackgroundProcessItem,
  BackgroundProcessStatus,
  MonitorAlertItem,
  SplitJob,
  OperationPermissionAuditItem,
} from "../lib/types";
import type { SystemLogRow, WorkQueueRow } from "../types/app";
import { jobStatusLabels } from "./console-defaults";
import { jsonPreview } from "@meshrix/ui-console/console-format-utils";
import { asRecord } from "./console-model-utils";
import {
  backgroundProcessLabel,
  backgroundProcessTone,
  monitorAlertSeverityLabel,
  monitorAlertSeverityTone,
  queueLifecycleLabel,
  queueLifecycleTone,
} from "./console-status-utils";
import {
  compactLogDetail,
  genericStatusTone,
  shortId,
  stateProgressPercent,
  type ReadonlyValue,
} from "./console-system-log-row-utils";
import { toolRiskLabel } from "./console-tool-display-utils";

export type ConsoleSystemStatusLogRowOptions = {
  activeMonitorAlerts: ReadonlyValue<MonitorAlertItem[]>;
  authAudit: ReadonlyValue<ConsoleAuditItem[]>;
  backgroundProcesses: ReadonlyValue<BackgroundProcessItem[]>;
  backgroundProcessStatus: ReadonlyValue<BackgroundProcessStatus | null>;
  recentJobs: ReadonlyValue<SplitJob[]>;
  recentMonitorAlertHistory: ReadonlyValue<MonitorAlertItem[]>;
  operationPermissionAuditItems: ReadonlyValue<OperationPermissionAuditItem[]>;
  workQueueRows: ReadonlyValue<WorkQueueRow[]>;
};

export function buildSystemStatusLogRows(options: ConsoleSystemStatusLogRowOptions): SystemLogRow[] {
  const queueRows: any = options.workQueueRows.value.map((row?: any): SystemLogRow => {
    const status: any = row.lifecycleStatus || row.status;
    return {
      logId: `queue:${row.rowId}`,
      kindLabel: "任务队列",
      displayId: shortId(row.queueId || row.rowId),
      target: row.label || row.queueId,
      status,
      statusLabel: queueLifecycleLabel(status),
      tone: row.tone || queueLifecycleTone(status),
      stage: compactLogDetail([row.sourceLabel, row.phase, row.status]),
      occurredAt: row.updatedAt || row.lastHeartbeatAt || row.startedAt || "",
      createdAt: row.startedAt || "",
      progressPercent: stateProgressPercent(status),
      detail: compactLogDetail([
        `队列 ${row.queueId}`,
        row.ownerId ? `owner ${row.ownerId}` : "",
        row.checkpointTreeId ? `checkpoint ${row.checkpointTreeId}` : "",
        row.registration?.registrationId ? `registration ${row.registration.registrationId}` : "",
        row.lastHeartbeatAt ? `heartbeat ${row.lastHeartbeatAt}` : "",
        row.detail,
      ]),
      error: ["failed", "interrupted"].includes(String(row.status || row.lifecycleStatus)) ? row.detail : "",
    };
  });

  const taskRows: any = options.recentJobs.value.map((job?: any): SystemLogRow => ({
    logId: `job:${job.id}`,
    kindLabel: "服务端任务",
    displayId: shortId(job.id),
    target: compactLogDetail([job.id, job.queueId ? `队列 ${job.queueId}` : ""]),
    status: job.status,
    statusLabel: (jobStatusLabels as Record<string, string>)[job.status] || job.status,
    tone: job.status,
    stage: job.stage || job.status,
    occurredAt: job.updatedAt || job.finishedAt || job.startedAt || job.createdAt || "",
    createdAt: job.createdAt || job.startedAt || "",
    progressPercent: Number(job.progressPercent || 0),
    detail: compactLogDetail([
      job.queueId ? `队列 ${job.queueId}` : "",
      job.checkpointTreeId ? `checkpoint ${job.checkpointTreeId}` : "",
      job.resultSummary ? jsonPreview(job.resultSummary) : "",
    ]),
    error: job.error || "",
  }));

  const processRows: any = options.backgroundProcesses.value.map((processItem?: any): SystemLogRow => ({
    logId: `process:${processItem.role}`,
    kindLabel: processItem.processType === "daemon" ? "守护进程" : "服务进程",
    displayId: processItem.role,
    target: processItem.label || processItem.role,
    status: processItem.status,
    statusLabel: backgroundProcessLabel(processItem.status),
    tone: backgroundProcessTone(processItem.status),
    stage: processItem.responsibility || processItem.description || processItem.mode || "",
    occurredAt: processItem.lastHeartbeatAt || processItem.startedAt || options.backgroundProcessStatus.value?.updatedAt || "",
    createdAt: processItem.startedAt || "",
    progressPercent: processItem.alive && !processItem.stale ? 100 : processItem.alive ? 50 : 0,
    detail: compactLogDetail([
      processItem.pid ? `PID ${processItem.pid}` : "",
      processItem.restartCount ? `重启 ${processItem.restartCount}` : "",
      processItem.services?.length ? `服务 ${processItem.services.join("/")}` : "",
      processItem.features?.length ? `功能 ${processItem.features.join("/")}` : "",
      processItem.monitors?.length ? `监控 ${processItem.monitors.join("/")}` : "",
      processItem.alerts?.length ? `报警 ${processItem.alerts.join("/")}` : "",
    ]),
    error: processItem.error || String(asRecord(processItem.lastExit)?.error || ""),
  }));

  const alertRows: any = [...options.activeMonitorAlerts.value, ...options.recentMonitorAlertHistory.value].map((alert?: any): SystemLogRow => {
    const status: any = alert.ackRequired ? "recovered" : alert.status || alert.severity;
    return {
      logId: `alert:${alert.alertId}:${alert.lastSeenAt || alert.resolvedAt || alert.firstSeenAt || ""}`,
      kindLabel: alert.ruleId === "queueInterrupted" ? "中断报警" : "监控报警",
      displayId: shortId(alert.alertId),
      target: alert.title,
      status,
      statusLabel: alert.ackRequired || alert.active === false ? "已恢复" : monitorAlertSeverityLabel(alert.severity),
      tone: alert.ackRequired || alert.active === false ? "success" : monitorAlertSeverityTone(alert.severity),
      stage: compactLogDetail([alert.ruleId, alert.source, alert.role, alert.resourceRef ? `资源 ${alert.resourceRef}` : ""]),
      occurredAt: alert.resolvedAt || alert.lastSeenAt || alert.firstSeenAt || "",
      createdAt: alert.firstSeenAt || "",
      progressPercent: alert.ackRequired || alert.active === false ? 100 : 0,
      detail: compactLogDetail([
        alert.message,
        alert.acknowledgedAt ? `确认 ${alert.acknowledgedAt}` : "",
      ]),
      error: alert.severity === "critical" && alert.active ? alert.message : "",
    };
  });

  const toolAuditRows: any = options.operationPermissionAuditItems.value.map((item?: any): SystemLogRow => ({
    logId: `tool-audit:${item.toolExecutionId}`,
    kindLabel: "调用记录",
    displayId: shortId(item.toolExecutionId),
    target: item.toolId || item.operationId || item.toolExecutionId,
    status: item.status,
    statusLabel: compactLogDetail([item.status, item.decision]),
    tone: genericStatusTone(`${item.status} ${item.decision} ${item.errorCode}`),
    stage: compactLogDetail([item.operationId, toolRiskLabel(item.risk), item.profileId, item.agentId]),
    occurredAt: item.finishedAt || item.startedAt || "",
    createdAt: item.startedAt || "",
    progressPercent: stateProgressPercent(item.status),
    detail: compactLogDetail([
      item.traceId ? `trace ${item.traceId}` : "",
      item.grantId ? `grant ${item.grantId}` : "",
      item.durationMs ? `${item.durationMs}ms` : "",
      item.resultSummary ? jsonPreview(item.resultSummary) : "",
    ]),
    error: item.errorCode || "",
  }));

  const authAuditRows: any = options.authAudit.value.map((item?: any): SystemLogRow => {
    const actor: any = asRecord(item.actor) || {};
    const target: any = asRecord(item.target) || null;
    const redactedInput: any = asRecord(item.redactedInput) || null;
    const redactedOutputSummary: any = asRecord(item.redactedOutputSummary) || null;
    const operationId: any = item.operationId || item.action || "operation";
    const isAuthOperation: any = operationId.startsWith("auth.");
    return {
      logId: `operation-audit:${item.auditId}`,
      kindLabel: isAuthOperation ? "认证日志" : "操作日志",
      displayId: shortId(item.auditId),
      target: compactLogDetail([
        String(item.username || actor.username || actor.userId || item.userId || "anonymous"),
        operationId,
      ]),
      status: item.status,
      statusLabel: item.status,
      tone: genericStatusTone(item.status || item.error),
      stage: compactLogDetail([
        item.method || item.transport,
        item.path,
        item.action || item.risk,
        item.durationMs ? `${item.durationMs}ms` : "",
      ]),
      occurredAt: item.createdAt,
      createdAt: item.createdAt,
      progressPercent: stateProgressPercent(item.status),
      detail: target
        ? jsonPreview(target)
        : redactedInput
          ? jsonPreview(redactedInput)
          : redactedOutputSummary
            ? jsonPreview(redactedOutputSummary)
            : "",
      error: item.error || "",
    };
  });

  return [
    ...queueRows,
    ...taskRows,
    ...processRows,
    ...alertRows,
    ...toolAuditRows,
    ...authAuditRows,
  ];
}
