import { computed, onMounted } from "vue";
import type { McpAuthorizationRequest } from "../lib/authorization-governance-client";
import type { OperationPermissionPendingOperation } from "../lib/operation-permission-client";
import { useServerConsoleShellContext } from "./serverConsoleShellContext";

type ApprovalFlowStatus = "all" | "pending" | "approved" | "rejected";

export type ApprovalFlowCard = {
  key: string;
  kind: "authorization";
  tone: string;
  label: string;
  title: string;
  summary: string;
  meta: string[];
  request: McpAuthorizationRequest;
} | {
  key: string;
  kind: "pendingOperation";
  tone: string;
  label: string;
  title: string;
  summary: string;
  meta: string[];
  pendingOperation: OperationPermissionPendingOperation;
};

function mcpAuthorizationStatusLabel(status: unknown) {
  if (status === "pending") return "待审批";
  if (status === "approved") return "已批准";
  if (status === "rejected") return "已拒绝";
  if (status === "issuing") return "签发中";
  if (status === "consumed") return "已消费";
  if (status === "expired") return "已过期";
  if (status === "failed") return "失败";
  return String(status || "未知状态");
}

function pendingOperationStatusLabel(status: unknown) {
  if (status === "pending") return "待审批";
  if (status === "approved") return "已批准";
  if (status === "rejected") return "已拒绝";
  if (status === "completed") return "已完成";
  if (status === "expired") return "已过期";
  if (status === "failed") return "失败";
  return String(status || "未知状态");
}

function approvalTone(status: unknown) {
  if (["pending", "issuing"].includes(String(status || ""))) return "warning";
  if (["approved", "completed", "consumed"].includes(String(status || ""))) return "success";
  return "danger";
}

function pendingOperationTitle(operation: OperationPermissionPendingOperation) {
  return operation.toolId || operation.operationId || operation.pendingOperationId;
}

function pendingOperationSummary(operation: OperationPermissionPendingOperation) {
  return `原因：${operation.riskReason || operation.reasonCode || operation.approvalScope || "需要人工审批"}`;
}

function timestampOfCard(card: ApprovalFlowCard) {
  const record = card.kind === "authorization" ? card.request : card.pendingOperation;
  const timestamps = record as Record<string, unknown>;
  return Date.parse(String(timestamps.resolvedAt || timestamps.completedAt || timestamps.createdAt || "")) || 0;
}

function exactApprovalIds(label: string, values: string[] | undefined) {
  return `${label} ${values?.length ? values.join(", ") : "无"}`;
}

function localMcpInstallEvidence(request: McpAuthorizationRequest) {
  return [
    exactApprovalIds("工具集 ID", request.toolsets),
    exactApprovalIds("工具 ID", request.requestedTools),
    exactApprovalIds("权限域 ID", request.requestedScopes),
    ...(request.processKeyFingerprints || []).map(
      (entry) => `进程密钥指纹 ${entry.target}: ${entry.fingerprint}`,
    ),
  ];
}

export function mcpAuthorizationApprovalCard(request: McpAuthorizationRequest): ApprovalFlowCard {
  const isLocalInstall = request.requestKind === "local_mcp_install";
  return {
    key: `authorization:${request.requestId}`,
    kind: "authorization",
    tone: approvalTone(request.status),
    label: isLocalInstall ? "MCP 本机安装授权" : "MCP 客户端授权",
    title: request.clientName || "Unknown Client",
    summary: isLocalInstall
      ? `目标：${request.targets?.join(", ") || "未知"}；最高风险：${request.maxRisk || "read_only"}`
      : `用途说明：${request.reason || "无"}`,
    meta: [
      mcpAuthorizationStatusLabel(request.status),
      isLocalInstall && request.verificationCode ? `验证码 ${request.verificationCode}` : "",
      isLocalInstall ? `请求 ${request.requestId}` : "",
      ...(isLocalInstall
        ? localMcpInstallEvidence(request)
        : [
            `工具 ${request.requestedTools?.length || 0} 个`,
            `权限域 ${request.requestedScopes?.length || 0} 个`,
          ]),
    ].filter(Boolean),
    request,
  };
}

export function useApprovalFlowViewController() {
  const { approvalFlowConsole } = useServerConsoleShellContext();
  const {
    busyKey,
    mcpAuthorizationRequests,
    mcpAuthorizationStatus,
    mcpAuthorizationStatusOptionBarOptions,
    operationPermissionPendingOperations,
    operationPermissionPendingStatus,
    refreshMcpAuthorizationRequests,
    refreshOperationPermissionPendingOperations,
    resolveMcpAuthorizationRequest,
    resolveOperationPermissionPendingOperation,
  } = approvalFlowConsole;

  const approvalFlowStatus = computed<ApprovalFlowStatus>({
    get: () => mcpAuthorizationStatus.value,
    set: (status) => {
      mcpAuthorizationStatus.value = status;
      operationPermissionPendingStatus.value = status;
      void refreshApprovalFlow();
    },
  });
  const approvalFlowStatusOptionBarOptions = mcpAuthorizationStatusOptionBarOptions;

  const approvalFlowCards = computed<ApprovalFlowCard[]>(() => [
    ...mcpAuthorizationRequests.value.map(mcpAuthorizationApprovalCard),
    ...operationPermissionPendingOperations.value.map((pendingOperation: OperationPermissionPendingOperation): ApprovalFlowCard => ({
      key: `pendingOperation:${pendingOperation.pendingOperationId}`,
      kind: "pendingOperation" as const,
      tone: approvalTone(pendingOperation.status),
      label: "Operation Permission 审批",
      title: pendingOperationTitle(pendingOperation),
      summary: pendingOperationSummary(pendingOperation),
      meta: [
        pendingOperationStatusLabel(pendingOperation.status),
        pendingOperation.risk ? `风险 ${pendingOperation.risk}` : "",
        pendingOperation.approvalScope ? `范围 ${pendingOperation.approvalScope}` : "",
      ].filter(Boolean),
      pendingOperation,
    })),
  ].sort((left, right) => timestampOfCard(right) - timestampOfCard(left)));

  function refreshApprovalFlow({ reset = false } = {}) {
    if (reset) {
      mcpAuthorizationStatus.value = "pending";
      operationPermissionPendingStatus.value = "pending";
    }
    return Promise.all([
      refreshMcpAuthorizationRequests(),
      refreshOperationPermissionPendingOperations(),
    ]);
  }

  function authorizationBusy(request: McpAuthorizationRequest) {
    return busyKey.value === `mcp-authorization-requests:resolve:${request.requestId}`;
  }

  function approveAuthorization(request: McpAuthorizationRequest) {
    void resolveMcpAuthorizationRequest(request.requestId, "approved");
  }

  function rejectAuthorization(request: McpAuthorizationRequest) {
    void resolveMcpAuthorizationRequest(request.requestId, "rejected");
  }

  function pendingOperationBusy(operation: OperationPermissionPendingOperation) {
    return busyKey.value === `operation-permission-pending:resolve:${operation.pendingOperationId}`;
  }

  function approvePendingOperation(operation: OperationPermissionPendingOperation) {
    void resolveOperationPermissionPendingOperation(operation.pendingOperationId, "approved");
  }

  function rejectPendingOperation(operation: OperationPermissionPendingOperation) {
    void resolveOperationPermissionPendingOperation(operation.pendingOperationId, "rejected");
  }

  onMounted(() => {
    void refreshApprovalFlow({ reset: true });
  });

  return {
    approvalFlowCards,
    approvalFlowStatus,
    approvalFlowStatusOptionBarOptions,
    approveAuthorization,
    approvePendingOperation,
    authorizationBusy,
    mcpAuthorizationStatusOptionBarOptions,
    pendingOperationBusy,
    refreshApprovalFlow,
    rejectAuthorization,
    rejectPendingOperation,
  };
}
