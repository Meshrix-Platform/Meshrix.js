import type { OperationPermissionScope, OperationPermissionToolset } from "../lib/types";
import { operationPermissionToolsetName } from "../i18n/operation-permission-toolsets";
import { maintenanceAgentRiskLabel } from "./console-status-utils";

export function scopeLabel(scopeId: string, scopes: readonly OperationPermissionScope[] = []) : any {
  return scopes.find((scope?: any) : any => scope.id === scopeId)?.label || scopeId;
}

export function toolRiskLabel(risk: string) : any {
  return maintenanceAgentRiskLabel(risk);
}

export function toolStatusLabel(status: string) : any {
  const labels: Record<string, string> = {
    active: "可执行",
    internal: "内部运行时",
    disabled: "停用",
    deprecated: "兼容中",
  };
  return labels[status] || status || "未知";
}

export function toolsetLabel(toolsetId: string, toolsets: readonly OperationPermissionToolset[] = []) : any {
  const fallback = toolsets.find((toolset?: any) : any => toolset.id === toolsetId)?.label || toolsetId;
  return operationPermissionToolsetName(toolsetId, fallback);
}
