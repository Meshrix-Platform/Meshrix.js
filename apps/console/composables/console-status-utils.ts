import type {
  BackgroundProcessStatus,
  ClientAlignmentState,
} from "../lib/types";
import { clientAlignmentTone } from "@meshrix/ui-console/console-client-display-utils";

export function queueLifecycleTone(status: string) : any {
  const normalized: any = String(status || "").toLowerCase();
  if (["interrupted", "failed", "missing"].includes(normalized)) {
    return "danger";
  }
  if (["recovered", "closed", "completed", "completed_with_errors"].includes(normalized)) {
    return "success";
  }
  if (["running", "open"].includes(normalized)) {
    return "running";
  }
  if (["queued", "awaiting_approval", "standby"].includes(normalized)) {
    return "queued";
  }
  return "neutral";
}

export function queueLifecycleLabel(status: string) : any {
  const labels: Record<string, string> = {
    open: "运行中",
    queued: "排队中",
    running: "运行中",
    awaiting_approval: "待审批",
    interrupted: "已中断",
    recovered: "已恢复",
    closed: "已关闭",
    completed: "已完成",
    completed_with_errors: "有错误",
    failed: "失败",
    cancelled: "已取消",
    rejected: "已拒绝",
  };
  return labels[String(status || "").toLowerCase()] || status || "未知";
}

export function maintenanceAgentStatusTone(status: string) : any {
  if (status === "awaiting_approval" || status === "queued") {
    return "queued";
  }
  if (status === "running") {
    return "running";
  }
  if (status === "completed") {
    return "completed";
  }
  if (status === "completed_with_errors") {
    return "queued";
  }
  return "failed";
}

export function maintenanceAgentStatusLabel(status: string) : any {
  const labels: Record<string, string> = {
    awaiting_approval: "待审批",
    queued: "排队",
    running: "运行中",
    completed: "已完成",
    completed_with_errors: "有错误",
    failed: "失败",
    cancelled: "已取消",
    rejected: "已拒绝",
  };
  return labels[status] || status || "未知";
}

export function backgroundProcessTone(status: string) : any {
  if (status === "running") {
    return "running";
  }
  if (status === "standby") {
    return "queued";
  }
  if (status === "starting") {
    return "queued";
  }
  if (status === "degraded" || status === "stale") {
    return "warning";
  }
  return "failed";
}

export function backgroundProcessLabel(status: string) : any {
  const labels: Record<string, string> = {
    running: "运行中",
    standby: "待接管",
    starting: "启动中",
    degraded: "降级",
    stale: "心跳超时",
    stopped: "已停止",
    exited: "已退出",
    failed: "失败",
    missing: "缺失",
  };
  return labels[status] || status || "未知";
}

export function processTypeLabel(processType?: string) : any {
  return processType === "daemon" ? "守护进程" : "服务进程";
}

export function processRelationText(processItem: BackgroundProcessStatus["processes"][number]) : any {
  const services: any = processItem.services?.length
	    ? `服务：${processItem.services.join("，")}`
    : "";
  const monitors: any = processItem.monitors?.length
	    ? `监控：${processItem.monitors.join("，")}`
    : "";
  const alerts: any = processItem.alerts?.length
	    ? `报警：${processItem.alerts.join("，")}`
    : "";
  return [services, monitors, alerts].filter(Boolean).join("；") || processItem.description || "无关联说明";
}

export function processRelationBullets(processItem: BackgroundProcessStatus["processes"][number]) : any {
  return [
    processItem.services?.length
	      ? { label: "服务", text: processItem.services.join("，") }
      : null,
    processItem.monitors?.length
	      ? { label: "监控", text: processItem.monitors.join("，") }
      : null,
    processItem.alerts?.length
	      ? { label: "报警", text: processItem.alerts.join("，") }
      : null,
  ].filter((item?: any): item is { label: string; text: string } => Boolean(item));
}

export function monitorAlertSeverityTone(severity: string) : any {
  if (severity === "critical") {
    return "failed";
  }
  if (severity === "warning") {
    return "warning";
  }
  return "running";
}

export function monitorAlertSeverityLabel(severity: string) : any {
  const labels: Record<string, string> = {
    critical: "严重",
    warning: "警告",
    info: "提示",
  };
  return labels[severity] || severity || "未知";
}

export function maintenanceAgentRiskLabel(risk: string) : any {
  const labels: Record<string, string> = {
    read_only: "只读",
    safe_write: "安全写入",
    repair_write: "修复写入",
    destructive: "破坏性",
  };
  return labels[risk] || risk || "未知";
}

export function alignmentTone(state: ClientAlignmentState) : any {
  return clientAlignmentTone(state);
}

export function alignmentProgress(state: ClientAlignmentState) : any {
  switch (state) {
    case "aligned":
      return 100;
    case "draining":
      return 68;
    case "outdated":
      return 28;
    case "bootstrap-only":
      return 12;
    case "offline":
      return 0;
    default:
      return 8;
  }
}
