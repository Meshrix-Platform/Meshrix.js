import type { OperationPermissionScope, OperationPermissionToolset } from "../lib/types";
import { maintenanceAgentRiskLabel } from "./console-status-utils";

export function scopeLabel(scopeId: string, scopes: readonly OperationPermissionScope[] = []) {
  return scopes.find((scope) => scope.id === scopeId)?.label || scopeId;
}

export function toolRiskLabel(risk: string) {
  return maintenanceAgentRiskLabel(risk);
}

export function toolStatusLabel(status: string) {
  const labels: Record<string, string> = {
    active: "可执行",
    internal: "内部运行时",
    disabled: "停用",
    deprecated: "兼容中",
  };
  return labels[status] || status || "未知";
}

export function toolsetLabel(toolsetId: string, toolsets: readonly OperationPermissionToolset[] = []) {
  return toolsets.find((toolset) => toolset.id === toolsetId)?.label || toolsetId;
}
