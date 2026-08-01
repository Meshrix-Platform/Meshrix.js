import { computed, onMounted, reactive } from "vue";
import { formatMachineDate } from "./console-format-utils";
import {
  confirmConsoleAction,
  notifyConsoleAction,
} from "./console-browser-effects";
import type { McpAuthorizationRequest } from "../lib/authorization-governance-client";
import type { OperationPermissionPendingOperation } from "../lib/operation-permission-client";
import {
  currentConsoleLocale,
  resolveEffectiveConsoleLocale,
  type ConsoleLocale,
} from "../i18n/console";
import { useServerConsoleShellContext } from "./serverConsoleShellContext";

export type ApprovalFlowStatus = "pending" | "resolved" | "rejected" | "all";

export type ApprovalFlowTone =
  "danger" | "info" | "neutral" | "success" | "warning";

export type ApprovalFlowStatusItem = {
  label: string;
  value: string;
  tone: ApprovalFlowTone;
};

export type ApprovalFlowFact = {
  label: string;
  value: string;
  protected?: boolean;
};

type ApprovalFlowCardBase = {
  key: string;
  tone: ApprovalFlowTone;
  label: string;
  title: string;
  summary: string;
  meta: string[];
  decisionStatus: ApprovalFlowStatusItem;
  executionStatus: ApprovalFlowStatusItem;
  facts: ApprovalFlowFact[];
  technicalDetails: ApprovalFlowFact[];
  auditAvailable: boolean;
};

export type ApprovalFlowCard =
  | (ApprovalFlowCardBase & {
      kind: "authorization";
      request: McpAuthorizationRequest;
    })
  | (ApprovalFlowCardBase & {
      kind: "pendingOperation";
      pendingOperation: OperationPermissionPendingOperation;
    });

function approvalStatusItem(
  label: string,
  value: string,
  tone: ApprovalFlowTone,
): ApprovalFlowStatusItem {
  return { label, value, tone };
}

function approvalLocale(locale?: ConsoleLocale) : any {
  return locale || resolveEffectiveConsoleLocale(currentConsoleLocale.value);
}

function approvalText(locale: ConsoleLocale, zh: string, en: string) : any {
  return locale === "en" ? en : zh;
}

export function isRedactedPublicValue(value: unknown) : any {
  return /^\[redacted(?:-[^\]]+)?\]$/i.test(String(value || "").trim());
}

function protectedProjectionValue(value: string, locale: ConsoleLocale) : any {
  return isRedactedPublicValue(value)
    ? approvalText(locale, "受公共投影保护", "Protected by public projection")
    : value;
}

function operationRequester(
  operation: OperationPermissionPendingOperation,
  locale: ConsoleLocale,
) : any {
  const requester: any = operation.agentId || operation.profileId || "";
  if (isRedactedPublicValue(requester)) {
    return approvalText(
      locale,
      "已授权调用方（身份受保护）",
      "Authorized caller (identity protected)",
    );
  }
  return requester || approvalText(locale, "已授权调用方", "Authorized caller");
}

function safeRequestReference(requestId: string, locale: ConsoleLocale) : any {
  const normalized: any = String(requestId || "").trim();
  if (!normalized || isRedactedPublicValue(normalized)) {
    return approvalText(locale, "不可用", "Unavailable");
  }
  if (normalized.length <= 18) return normalized;
  return `${normalized.slice(0, 10)}…${normalized.slice(-6)}`;
}

function mcpDecisionStatus(
  request: McpAuthorizationRequest,
  locale: ConsoleLocale,
) : any {
  const status: any = request.status;
  const label: any = approvalText(locale, "审批决定", "Approval Decision");
  if (status === "pending") {
    return approvalStatusItem(
      label,
      approvalText(locale, "待决定", "Pending Decision"),
      "warning",
    );
  }
  if (
    ["approved", "issuing", "consumed"].includes(status) ||
    (["expired", "failed"].includes(status) && Boolean(request.resolvedAt))
  ) {
    return approvalStatusItem(
      label,
      approvalText(locale, "已批准", "Approved"),
      "success",
    );
  }
  if (status === "rejected") {
    return approvalStatusItem(
      label,
      approvalText(locale, "已拒绝", "Rejected"),
      "danger",
    );
  }
  if (status === "expired") {
    return approvalStatusItem(
      label,
      approvalText(locale, "已过期", "Expired"),
      "neutral",
    );
  }
  return approvalStatusItem(
    label,
    approvalText(locale, "处理失败", "Processing Failed"),
    "danger",
  );
}

function mcpDeliveryStatus(
  request: McpAuthorizationRequest,
  locale: ConsoleLocale,
) : any {
  const status: any = request.status;
  const label: any = approvalText(locale, "授权交付", "Authorization Delivery");
  if (status === "pending") {
    return approvalStatusItem(
      label,
      approvalText(locale, "等待审批", "Awaiting Approval"),
      "neutral",
    );
  }
  if (status === "approved") {
    return approvalStatusItem(
      label,
      approvalText(locale, "等待签发", "Awaiting Issuance"),
      "warning",
    );
  }
  if (status === "issuing") {
    return approvalStatusItem(
      label,
      approvalText(locale, "签发中", "Issuing"),
      "warning",
    );
  }
  if (status === "consumed") {
    return approvalStatusItem(
      label,
      approvalText(locale, "已交付", "Delivered"),
      "success",
    );
  }
  if (status === "failed") {
    return approvalStatusItem(
      label,
      approvalText(locale, "交付失败", "Delivery Failed"),
      "danger",
    );
  }
  if (status === "expired" && request.resolvedAt) {
    return approvalStatusItem(
      label,
      approvalText(locale, "交付已过期", "Delivery Expired"),
      "danger",
    );
  }
  return approvalStatusItem(
    label,
    approvalText(locale, "未交付", "Not Delivered"),
    "neutral",
  );
}

function operationDecisionStatus(
  operation: OperationPermissionPendingOperation,
  locale: ConsoleLocale,
) : any {
  const status: any = String(operation.status || "");
  const label: any = approvalText(locale, "审批决定", "Approval Decision");
  if (status === "pending") {
    return approvalStatusItem(
      label,
      approvalText(locale, "待决定", "Pending Decision"),
      "warning",
    );
  }
  if (
    ["approved", "completed"].includes(status) ||
    (status === "failed" && operation.resumedToolExecutionId)
  ) {
    return approvalStatusItem(
      label,
      approvalText(locale, "已批准", "Approved"),
      "success",
    );
  }
  if (status === "rejected") {
    return approvalStatusItem(
      label,
      approvalText(locale, "已拒绝", "Rejected"),
      "danger",
    );
  }
  if (["expired", "cancelled"].includes(status)) {
    return approvalStatusItem(
      label,
      status === "expired"
        ? approvalText(locale, "已过期", "Expired")
        : approvalText(locale, "已取消", "Cancelled"),
      "neutral",
    );
  }
  if (status === "replayed") {
    return approvalStatusItem(
      label,
      approvalText(locale, "已处理", "Already Processed"),
      "neutral",
    );
  }
  if (status === "payload_mismatch") {
    return approvalStatusItem(
      label,
      approvalText(locale, "校验失败", "Validation Failed"),
      "danger",
    );
  }
  if (status === "failed") {
    return approvalStatusItem(
      label,
      approvalText(locale, "处理失败", "Processing Failed"),
      "danger",
    );
  }
  return approvalStatusItem(
    label,
    status || approvalText(locale, "未知状态", "Unknown Status"),
    "neutral",
  );
}

function operationExecutionStatus(
  operation: OperationPermissionPendingOperation,
  locale: ConsoleLocale,
) : any {
  const status: any = String(operation.status || "");
  const executionOutcome: any = String(
    operation.executionOutcome ||
      operation.resultSummary?.executionOutcome ||
      "",
  );
  const label: any = approvalText(locale, "执行结果", "Execution Result");
  if (status === "approved") {
    return approvalStatusItem(
      label,
      approvalText(locale, "准备执行", "Preparing to Execute"),
      "warning",
    );
  }
  if (executionOutcome === "continued_pending_approval") {
    return approvalStatusItem(
      label,
      approvalText(
        locale,
        "已推进至下一审批层，尚未执行",
        "Advanced to Next Approval Layer; Not Executed",
      ),
      "warning",
    );
  }
  if (executionOutcome === "executed_once") {
    return approvalStatusItem(
      label,
      approvalText(locale, "已执行一次", "Executed Once"),
      "success",
    );
  }
  if (executionOutcome === "execution_failed") {
    return approvalStatusItem(
      label,
      approvalText(locale, "执行未成功", "Execution Did Not Complete"),
      "danger",
    );
  }
  if (status === "completed") {
    return approvalStatusItem(
      label,
      approvalText(
        locale,
        "处理已完成，执行结果不可用",
        "Processing Complete; Execution Outcome Unavailable",
      ),
      "neutral",
    );
  }
  if (status === "replayed") {
    return approvalStatusItem(
      label,
      approvalText(locale, "未重复执行", "Not Executed Again"),
      "neutral",
    );
  }
  if (status === "payload_mismatch") {
    return approvalStatusItem(
      label,
      approvalText(locale, "未执行", "Not Executed"),
      "neutral",
    );
  }
  if (status === "failed") {
    return approvalStatusItem(
      label,
      approvalText(locale, "未进入执行", "Execution Not Started"),
      "neutral",
    );
  }
  return approvalStatusItem(
    label,
    approvalText(locale, "尚未执行", "Not Executed"),
    "neutral",
  );
}

function approvalTone(
  decisionStatus: ApprovalFlowStatusItem,
  executionStatus: ApprovalFlowStatusItem,
): ApprovalFlowTone {
  if (decisionStatus.tone === "danger" || executionStatus.tone === "danger")
    return "danger";
  if (executionStatus.tone === "success") return "success";
  if (decisionStatus.tone === "warning" || executionStatus.tone === "warning")
    return "warning";
  if (decisionStatus.tone === "success") return "success";
  return "neutral";
}

function riskLabel(risk: unknown, locale: ConsoleLocale) : any {
  if (risk === "read_only") return approvalText(locale, "只读", "Read Only");
  if (risk === "safe_write")
    return approvalText(locale, "受限写入", "Controlled Write");
  if (risk === "repair_write")
    return approvalText(locale, "修复写入", "Repair Write");
  if (risk === "destructive")
    return approvalText(locale, "破坏性操作", "Destructive");
  return String(risk || approvalText(locale, "未声明", "Not Declared"));
}

function riskImpact(risk: unknown, locale: ConsoleLocale) : any {
  if (risk === "read_only") {
    return approvalText(locale, "读取受治理信息", "Read governed information");
  }
  if (risk === "safe_write") {
    return approvalText(locale, "写入受治理数据", "Write governed data");
  }
  if (risk === "repair_write") {
    return approvalText(
      locale,
      "修改或修复受治理状态",
      "Modify or repair governed state",
    );
  }
  if (risk === "destructive") {
    return approvalText(
      locale,
      "可能产生不可逆修改",
      "May cause irreversible changes",
    );
  }
  return approvalText(locale, "执行受治理操作", "Execute a governed operation");
}

function displayDeadline(value: string | undefined, locale: ConsoleLocale) : any {
  return value
    ? formatMachineDate(value, "full")
    : approvalText(locale, "未声明", "Not Declared");
}

function joinValues(values: string[] | undefined, locale: ConsoleLocale) : any {
  return values?.length
    ? values.join(", ")
    : approvalText(locale, "无", "None");
}

function operationHasApprovalLayers(
  operation: OperationPermissionPendingOperation,
) : any {
  return Boolean(operation.approvalLayers?.length);
}

export function operationApprovalTitle(
  operation: OperationPermissionPendingOperation,
) : any {
  const label: any = String(operation.toolLabel || "").trim();
  if (label) return label;
  const toolId: any = String(operation.toolId || "").trim();
  const upstreamOperation: any = /^upstream\.svc_[^.]+\.(.+)$/u.exec(toolId)?.[1];
  return (
    upstreamOperation ||
    toolId ||
    operation.operationId ||
    operation.pendingOperationId
  );
}

function mcpAuthorizationSummary(
  request: McpAuthorizationRequest,
  isLocalInstall: boolean,
  locale: ConsoleLocale,
) : any {
  if (request.status === "pending") {
    return isLocalInstall
      ? approvalText(
          locale,
          "批准后，此客户端可在所列目标安装连接器并获得明确列出的权限。",
          "After approval, this client can install the connector on the listed targets with only the listed permissions.",
        )
      : approvalText(
          locale,
          "批准后，此客户端可访问明确列出的工具与权限域。",
          "After approval, this client can access only the listed tools and scopes.",
        );
  }
  if (request.status === "consumed") {
    return approvalText(
      locale,
      "审批已通过，授权材料已交付；这不代表任何工具已经执行。",
      "Approval passed and authorization was delivered; this does not mean that any tool was executed.",
    );
  }
  if (request.status === "approved" || request.status === "issuing") {
    return approvalText(
      locale,
      "审批已通过，授权交付仍在进行；尚未产生工具执行结果。",
      "Approval passed and authorization delivery is still in progress; no tool execution result exists yet.",
    );
  }
  if (
    (request.status === "failed" || request.status === "expired") &&
    request.resolvedAt
  ) {
    return request.status === "failed"
      ? approvalText(
          locale,
          "审批已通过，但授权交付失败；不会据此推断工具已经执行。",
          "Approval passed, but authorization delivery failed; no tool execution is inferred.",
        )
      : approvalText(
          locale,
          "审批已通过，但授权在交付前过期；未产生工具执行结果。",
          "Approval passed, but authorization expired before delivery; no tool execution result was produced.",
        );
  }
  if (request.status === "rejected") {
    return approvalText(
      locale,
      "请求已拒绝，未交付授权。",
      "The request was rejected and no authorization was delivered.",
    );
  }
  if (request.status === "expired") {
    return approvalText(
      locale,
      "请求在作出决定前过期，未交付授权。",
      "The request expired before a decision and no authorization was delivered.",
    );
  }
  return approvalText(
    locale,
    "请求处理失败，未交付授权。",
    "Request processing failed and no authorization was delivered.",
  );
}

function operationApprovalSummary(
  operation: OperationPermissionPendingOperation,
  locale: ConsoleLocale,
) : any {
  const outcome: any = String(
    operation.executionOutcome ||
      operation.resultSummary?.executionOutcome ||
      "",
  );
  if (outcome === "continued_pending_approval") {
    return approvalText(
      locale,
      "当前审批已通过，请求已进入下一审批阶段；操作尚未执行。",
      "The current approval passed and the request advanced to its next approval stage; the operation has not executed.",
    );
  }
  if (outcome === "executed_once") {
    return approvalText(
      locale,
      "审批已通过，执行许可已消费，操作已完成一次。",
      "Approval passed, the execution permit was consumed, and the operation completed once.",
    );
  }
  if (outcome === "execution_failed") {
    return approvalText(
      locale,
      "审批已通过，但后续执行未成功；决定与执行结果分别记录。",
      "Approval passed, but the subsequent execution did not complete; the decision and execution outcome are recorded separately.",
    );
  }
  if (operation.status === "pending") {
    return operationHasApprovalLayers(operation)
      ? approvalText(
          locale,
          "通过当前审批层后会重新评估；若仍需审批则进入下一层，全部满足后才最多尝试执行一次。",
          "After the current layer passes, the request is re-evaluated. If more approval is required it advances to the next layer; only after every layer is satisfied may execution be attempted once at most.",
        )
      : approvalText(
          locale,
          "批准后会重新评估；只有满足全部规则，系统才最多尝试执行一次。",
          "After approval, the request is re-evaluated; only when every rule is satisfied may execution be attempted once at most.",
        );
  }
  if (operation.status === "rejected") {
    return approvalText(
      locale,
      "请求已拒绝，操作未执行。",
      "The request was rejected and the operation was not executed.",
    );
  }
  if (operation.status === "expired" || operation.status === "cancelled") {
    return approvalText(
      locale,
      "请求已结束，操作未执行。",
      "The request ended without executing the operation.",
    );
  }
  return approvalText(
    locale,
    "审批处理已结束；执行结果不可用，因此界面不会推断操作已经执行。",
    "Approval processing ended, but the execution outcome is unavailable, so the interface does not infer that the operation ran.",
  );
}

function operationDecisionAction(
  operation: OperationPermissionPendingOperation,
  locale: ConsoleLocale,
) : any {
  if (operation.status === "pending") {
    return operationHasApprovalLayers(operation)
      ? approvalText(locale, "通过当前审批层", "Approve Current Layer")
      : approvalText(locale, "批准请求", "Approve Request");
  }
  if (operation.status === "rejected") {
    return approvalText(locale, "已拒绝请求", "Request Rejected");
  }
  return approvalText(locale, "审批已处理", "Approval Processed");
}

function operationNextStep(
  operation: OperationPermissionPendingOperation,
  locale: ConsoleLocale,
) : any {
  const outcome: any = String(
    operation.executionOutcome ||
      operation.resultSummary?.executionOutcome ||
      "",
  );
  if (outcome === "continued_pending_approval") {
    return approvalText(
      locale,
      "等待下一审批阶段；尚未执行",
      "Await the next approval stage; not executed",
    );
  }
  if (outcome === "executed_once") {
    return approvalText(
      locale,
      "执行已完成，可查看最近审计",
      "Execution completed; recent audit is available",
    );
  }
  if (outcome === "execution_failed") {
    return approvalText(
      locale,
      "检查执行失败原因与审计",
      "Review the execution failure and audit",
    );
  }
  if (operation.status === "pending") {
    return operationHasApprovalLayers(operation)
      ? approvalText(
          locale,
          "重新评估；仍需审批则进入下一层",
          "Re-evaluate; advance if more approval is required",
        )
      : approvalText(
          locale,
          "重新评估；满足全部规则后最多尝试执行一次",
          "Re-evaluate; attempt execution once at most after every rule is satisfied",
        );
  }
  return approvalText(locale, "无需进一步审批动作", "No further approval action");
}

function timestampOfCard(card: ApprovalFlowCard) : any {
  const timestamps: any = (
    card.kind === "authorization"
      ? [
          card.request.consumedAt,
          card.request.issuingAt,
          card.request.resolvedAt,
          card.request.createdAt,
        ]
      : [
          card.pendingOperation.completedAt,
          card.pendingOperation.resolvedAt,
          card.pendingOperation.createdAt,
        ]
  ).filter(Boolean);
  return (
    timestamps
      .map((timestamp?: any) : any => Date.parse(String(timestamp)))
      .find((timestamp?: any) : any => Number.isFinite(timestamp)) || 0
  );
}

function mcpAuthorizationTechnicalDetails(
  request: McpAuthorizationRequest,
  locale: ConsoleLocale,
): ApprovalFlowFact[] {
  return [
    {
      label: approvalText(locale, "请求 ID", "Request ID"),
      value: request.requestId,
      protected: true,
    },
    ...(request.reason
      ? [
          {
            label: approvalText(
              locale,
              "客户端说明",
              "Client-provided Reason",
            ),
            value: request.reason,
          },
        ]
      : []),
    {
      label: approvalText(locale, "工具集 ID", "Toolset IDs"),
      value: joinValues(request.toolsets, locale),
    },
    {
      label: approvalText(locale, "工具 ID", "Tool IDs"),
      value: joinValues(request.requestedTools, locale),
    },
    {
      label: approvalText(locale, "权限域 ID", "Scope IDs"),
      value: joinValues(request.requestedScopes, locale),
    },
    ...(request.processKeyFingerprints || []).map((entry?: any) : any => ({
      label: `${approvalText(locale, "进程密钥指纹", "Process Key Fingerprint")} · ${entry.target}`,
      value: entry.fingerprint,
      protected: true,
    })),
    ...(request.createdAt
      ? [
          {
            label: approvalText(locale, "请求时间", "Requested At"),
            value: displayDeadline(request.createdAt, locale),
          },
        ]
      : []),
    ...(request.resolvedAt
      ? [
          {
            label: approvalText(locale, "决定时间", "Decided At"),
            value: displayDeadline(request.resolvedAt, locale),
          },
        ]
      : []),
    ...(request.consumedAt
      ? [
          {
            label: approvalText(locale, "交付时间", "Delivered At"),
            value: displayDeadline(request.consumedAt, locale),
          },
        ]
      : []),
    ...(request.errorCode
      ? [
          {
            label: approvalText(locale, "错误代码", "Error Code"),
            value: request.errorCode,
          },
        ]
      : []),
  ];
}

export function mcpAuthorizationApprovalCard(
  request: McpAuthorizationRequest,
  locale: any = approvalLocale(),
): ApprovalFlowCard {
  const isLocalInstall: any = request.requestKind === "local_mcp_install";
  const decisionStatus: any = mcpDecisionStatus(request, locale);
  const executionStatus: any = mcpDeliveryStatus(request, locale);
  const target: any = request.targets?.length
    ? request.targets.join(", ")
    : request.clientName || approvalText(locale, "未声明", "Not Declared");
  const requestedToolCount: any = request.requestedTools?.length || 0;
  const requestedScopeCount: any = request.requestedScopes?.length || 0;
  const summary: any = mcpAuthorizationSummary(request, isLocalInstall, locale);
  const cardTone: any =
    request.maxRisk === "destructive"
      ? "danger"
      : approvalTone(decisionStatus, executionStatus);
  return {
    key: `authorization:${request.requestId}`,
    kind: "authorization",
    tone: cardTone,
    label: isLocalInstall
      ? approvalText(
          locale,
          "MCP 本机安装授权",
          "Local MCP Installation Authorization",
        )
      : approvalText(locale, "MCP 客户端授权", "MCP Client Authorization"),
    title:
      request.clientName ||
      approvalText(locale, "未标识的 MCP 客户端", "Unidentified MCP client"),
    summary,
    meta: [decisionStatus.value, executionStatus.value],
    decisionStatus,
    executionStatus,
    facts: [
      {
        label: approvalText(
          locale,
          "客户端自报名称",
          "Self-reported client name",
        ),
        value:
          request.clientName ||
          approvalText(
            locale,
            "未标识的 MCP 客户端",
            "Unidentified MCP client",
          ),
      },
      {
        label: approvalText(locale, "动作", "Action"),
        value: isLocalInstall
          ? approvalText(
              locale,
              "安装 MCP 连接器并授予权限",
              "Install the MCP connector and grant permissions",
            )
          : approvalText(locale, "授予 MCP 工具访问", "Grant MCP tool access"),
      },
      { label: approvalText(locale, "对象", "Target"), value: target },
      {
        label: approvalText(locale, "影响", "Impact"),
        value:
          locale === "en"
            ? `${requestedToolCount} ${requestedToolCount === 1 ? "tool" : "tools"} · ${requestedScopeCount} ${requestedScopeCount === 1 ? "scope" : "scopes"}`
            : `${requestedToolCount} 个工具 · ${requestedScopeCount} 个权限域`,
      },
      {
        label: approvalText(locale, "风险", "Risk"),
        value: riskLabel(request.maxRisk, locale),
      },
      {
        label: approvalText(locale, "有效期", "Valid Until"),
        value: displayDeadline(request.expiresAt, locale),
      },
      {
        label: approvalText(locale, "核对依据", "Verification Evidence"),
        value: isLocalInstall
          ? locale === "en"
            ? `Code ${request.verificationCode || "not provided"} · ${request.processKeyFingerprints?.length || 0} process key fingerprints`
            : `核对码 ${request.verificationCode || "未提供"} · ${request.processKeyFingerprints?.length || 0} 个进程密钥指纹`
          : approvalText(
              locale,
              "未提供本机安装证明",
              "No local installation evidence provided",
            ),
        protected: Boolean(request.verificationCode),
      },
    ],
    technicalDetails: mcpAuthorizationTechnicalDetails(request, locale),
    auditAvailable: false,
    request,
  };
}

function operationTechnicalDetails(
  operation: OperationPermissionPendingOperation,
  locale: ConsoleLocale,
): ApprovalFlowFact[] {
  return [
    {
      label: approvalText(locale, "待审批请求 ID", "Pending Request ID"),
      value: operation.pendingOperationId,
      protected: true,
    },
    {
      label: approvalText(locale, "工具 ID", "Tool ID"),
      value: operation.toolId,
    },
    ...(operation.operationId
      ? [
          {
            label: approvalText(locale, "操作 ID", "Operation ID"),
            value: operation.operationId,
          },
        ]
      : []),
    ...(operation.toolVersion
      ? [
          {
            label: approvalText(locale, "工具版本", "Tool Version"),
            value: operation.toolVersion,
          },
        ]
      : []),
    {
      label: approvalText(locale, "工具集 ID", "Toolset IDs"),
      value: joinValues(operation.toolsetIds, locale),
    },
    ...(operation.approvalScope
      ? [
          {
            label: approvalText(locale, "审批范围", "Approval Scope"),
            value: operation.approvalScope,
          },
        ]
      : []),
    ...(operation.approvalLayers?.length
      ? [
          {
            label: approvalText(locale, "审批层", "Approval Layers"),
            value: operation.approvalLayers.join(", "),
          },
        ]
      : []),
    ...(operation.traceId
      ? [
          {
            label: "Trace ID",
            value: protectedProjectionValue(operation.traceId, locale),
            protected: true,
          },
        ]
      : []),
    ...(operation.toolExecutionId
      ? [
          {
            label: approvalText(locale, "初始执行 ID", "Initial Execution ID"),
            value: protectedProjectionValue(operation.toolExecutionId, locale),
            protected: true,
          },
        ]
      : []),
    ...(operation.resumedToolExecutionId
      ? [
          {
            label: approvalText(locale, "恢复执行 ID", "Resumed Execution ID"),
            value: protectedProjectionValue(
              operation.resumedToolExecutionId,
              locale,
            ),
            protected: true,
          },
        ]
      : []),
    ...(operation.grantId
      ? [
          {
            label: "Grant ID",
            value: protectedProjectionValue(operation.grantId, locale),
            protected: true,
          },
        ]
      : []),
    ...(operation.agentId
      ? [
          {
            label: approvalText(locale, "智能体 ID", "Agent ID"),
            value: protectedProjectionValue(operation.agentId, locale),
            protected: true,
          },
        ]
      : []),
    ...(operation.profileId
      ? [
          {
            label: approvalText(locale, "配置档 ID", "Profile ID"),
            value: protectedProjectionValue(operation.profileId, locale),
            protected: true,
          },
        ]
      : []),
    ...(operation.createdAt
      ? [
          {
            label: approvalText(locale, "请求时间", "Requested At"),
            value: displayDeadline(operation.createdAt, locale),
          },
        ]
      : []),
    ...(operation.resolvedAt
      ? [
          {
            label: approvalText(locale, "决定时间", "Decided At"),
            value: displayDeadline(operation.resolvedAt, locale),
          },
        ]
      : []),
    ...(operation.completedAt
      ? [
          {
            label: approvalText(locale, "完成时间", "Completed At"),
            value: displayDeadline(operation.completedAt, locale),
          },
        ]
      : []),
    ...(operation.errorCode
      ? [
          {
            label: approvalText(locale, "错误代码", "Error Code"),
            value: operation.errorCode,
          },
        ]
      : []),
  ];
}

export function operationPermissionApprovalCard(
  operation: OperationPermissionPendingOperation,
  locale: any = approvalLocale(),
): ApprovalFlowCard {
  const decisionStatus: any = operationDecisionStatus(operation, locale);
  const executionStatus: any = operationExecutionStatus(operation, locale);
  const requester: any = operationRequester(operation, locale);
  const title: any = operationApprovalTitle(operation);
  const executionOutcome: any = String(
    operation.executionOutcome ||
      operation.resultSummary?.executionOutcome ||
      "",
  );
  const auditAvailable: any = ["executed_once", "execution_failed"].includes(
    executionOutcome,
  );
  const cardTone: any =
    operation.risk === "destructive"
      ? "danger"
      : approvalTone(decisionStatus, executionStatus);
  return {
    key: `pendingOperation:${operation.pendingOperationId}`,
    kind: "pendingOperation",
    tone: cardTone,
    label: approvalText(
      locale,
      "Operation Permission 审批",
      "Operation Permission Approval",
    ),
    title,
    summary: operationApprovalSummary(operation, locale),
    meta: [decisionStatus.value, executionStatus.value],
    decisionStatus,
    executionStatus,
    facts: [
      {
        label: approvalText(locale, "请求者", "Requester"),
        value: requester,
        protected: Boolean(
          (operation.agentId || operation.profileId) &&
          !isRedactedPublicValue(operation.agentId || operation.profileId),
        ),
      },
      {
        label: approvalText(locale, "动作", "Action"),
        value: operationDecisionAction(operation, locale),
      },
      {
        label: approvalText(locale, "对象", "Target"),
        value: title,
      },
      {
        label: approvalText(locale, "影响", "Impact"),
        value: riskImpact(operation.risk, locale),
      },
      {
        label: approvalText(locale, "风险", "Risk"),
        value: riskLabel(operation.risk, locale),
      },
      ...(operationHasApprovalLayers(operation)
        ? [
            {
              label: approvalText(
                locale,
                "当前审批层",
                "Current Approval Layer",
              ),
              value: joinValues(operation.approvalLayers, locale),
            },
          ]
        : [
            {
              label: approvalText(locale, "审批范围", "Approval Scope"),
              value:
                operation.approvalScope ||
                approvalText(locale, "当前请求", "This Request"),
            },
          ]),
      {
        label: approvalText(locale, "后续", "Next"),
        value: operationNextStep(operation, locale),
      },
      {
        label: approvalText(locale, "有效期", "Valid Until"),
        value: displayDeadline(operation.expiresAt, locale),
      },
    ],
    technicalDetails: operationTechnicalDetails(operation, locale),
    auditAvailable,
    pendingOperation: operation,
  };
}

export function approvalApiStatusForUiStatus(status: ApprovalFlowStatus) : any {
  return status === "pending" || status === "rejected" ? status : "all";
}

export function approvalFlowCardMatchesStatus(
  card: ApprovalFlowCard,
  status: ApprovalFlowStatus,
) : any {
  if (status === "all") return true;
  const record: any =
    card.kind === "authorization" ? card.request : card.pendingOperation;
  const recordStatus: any = String(record.status || "");
  if (status === "pending" || status === "rejected") {
    return recordStatus === status;
  }
  if (card.kind === "authorization") {
    return (
      ["approved", "issuing", "consumed"].includes(recordStatus) ||
      (["expired", "failed"].includes(recordStatus) &&
        Boolean(card.request.resolvedAt))
    );
  }
  if (["approved", "completed"].includes(recordStatus)) return true;
  if (
    recordStatus === "failed" &&
    Boolean(card.pendingOperation.resumedToolExecutionId)
  ) {
    return true;
  }
  return (
    ["failed", "cancelled", "payload_mismatch", "replayed"].includes(
      recordStatus,
    ) && Boolean(card.pendingOperation.resolvedAt)
  );
}

type ApprovalDecisionCopy = {
  confirmLabel: string;
  message: string;
  tone: "danger" | "neutral";
  title: string;
  toastMessage: string;
  toastTitle: string;
};

export function mcpAuthorizationDecisionCopy(
  request: McpAuthorizationRequest,
  resolution: "approved" | "rejected",
  locale: any = approvalLocale(),
): ApprovalDecisionCopy {
  const isLocalInstall: any = request.requestKind === "local_mcp_install";
  const clientName: any =
    request.clientName ||
    approvalText(locale, "未标识的 MCP 客户端", "Unidentified MCP client");
  const target: any =
    request.targets?.join(", ") ||
    approvalText(locale, "未声明", "Not Declared");
  const toolCount: any = request.requestedTools?.length || 0;
  const scopeCount: any = request.requestedScopes?.length || 0;
  const verificationReference: any = request.verificationCode
    ? request.verificationCode
    : safeRequestReference(request.requestId, locale);
  const facts: any =
    locale === "en"
      ? [
          `Self-reported client name: ${clientName}`,
          `Target: ${target}`,
          `Tools: ${toolCount}`,
          `Scopes: ${scopeCount}`,
          `${request.verificationCode ? "Verification code" : "Request reference"}: ${verificationReference}`,
          `Risk: ${riskLabel(request.maxRisk, locale)}`,
          `Valid until: ${displayDeadline(request.expiresAt, locale)}`,
        ].join("\n")
      : [
          `客户端自报名称：${clientName}`,
          `目标：${target}`,
          `工具：${toolCount} 个`,
          `权限域：${scopeCount} 个`,
          `${request.verificationCode ? "核对码" : "请求短句柄"}：${verificationReference}`,
          `风险：${riskLabel(request.maxRisk, locale)}`,
          `有效期：${displayDeadline(request.expiresAt, locale)}`,
        ].join("\n");
  if (resolution === "rejected") {
    return {
      confirmLabel: approvalText(locale, "拒绝请求", "Reject Request"),
      message: `${facts}\n\n${approvalText(locale, "拒绝这一次授权请求？", "Reject this authorization request?")}`,
      tone: "danger",
      title: approvalText(
        locale,
        "拒绝 MCP 授权请求",
        "Reject MCP Authorization Request",
      ),
      toastMessage: approvalText(
        locale,
        "MCP 授权请求已拒绝。",
        "The MCP authorization request was rejected.",
      ),
      toastTitle: approvalText(locale, "审批已完成", "Approval Completed"),
    };
  }
  return {
    confirmLabel: isLocalInstall
      ? approvalText(locale, "批准本次安装", "Approve This Installation")
      : approvalText(locale, "批准本次授权", "Approve This Authorization"),
    message: `${facts}\n\n${
      isLocalInstall
        ? approvalText(
            locale,
            "批准后将为这一次安装请求签发所列权限。",
            "Approval will issue only the listed permissions for this installation request.",
          )
        : approvalText(
            locale,
            "批准后将为这一次授权请求签发所列权限。",
            "Approval will issue only the listed permissions for this authorization request.",
          )
    }`,
    tone: request.maxRisk === "destructive" ? "danger" : "neutral",
    title: isLocalInstall
      ? approvalText(
          locale,
          "确认本次 MCP 安装",
          "Confirm This MCP Installation",
        )
      : approvalText(
          locale,
          "确认本次 MCP 授权",
          "Confirm This MCP Authorization",
        ),
    toastMessage: isLocalInstall
      ? approvalText(
          locale,
          "本次 MCP 安装授权已批准。",
          "This MCP installation authorization was approved.",
        )
      : approvalText(
          locale,
          "本次 MCP 授权已批准。",
          "This MCP authorization was approved.",
        ),
    toastTitle: approvalText(locale, "审批已完成", "Approval Completed"),
  };
}

export function operationPermissionDecisionCopy(
  operation: OperationPermissionPendingOperation,
  resolution: "approved" | "rejected",
  locale: any = approvalLocale(),
): ApprovalDecisionCopy {
  const requester: any = operationRequester(operation, locale);
  const action: any = operationApprovalTitle(operation);
  const impact: any = riskImpact(operation.risk, locale);
  const hasApprovalLayers: any = operationHasApprovalLayers(operation);
  const facts: any =
    locale === "en"
      ? [
          `Requester: ${requester}`,
          `Operation: ${action}`,
          `Risk: ${riskLabel(operation.risk, locale)}`,
          `Impact: ${impact}`,
          `Valid until: ${displayDeadline(operation.expiresAt, locale)}`,
        ].join("\n")
      : [
          `请求者：${requester}`,
          `操作：${action}`,
          `风险：${riskLabel(operation.risk, locale)}`,
          `影响：${impact}`,
          `有效期：${displayDeadline(operation.expiresAt, locale)}`,
        ].join("\n");
  if (resolution === "rejected") {
    return {
      confirmLabel: approvalText(locale, "拒绝请求", "Reject Request"),
      message: `${facts}\n\n${approvalText(locale, "拒绝这一次执行请求？", "Reject this execution request?")}`,
      tone: "danger",
      title: approvalText(
        locale,
        "拒绝 Operation Permission 请求",
        "Reject Operation Permission Request",
      ),
      toastMessage: approvalText(
        locale,
        "Operation Permission 请求已拒绝。",
        "The Operation Permission request was rejected.",
      ),
      toastTitle: approvalText(locale, "审批已完成", "Approval Completed"),
    };
  }
  return {
    confirmLabel: approvalText(
      locale,
      hasApprovalLayers ? "通过当前审批层" : "批准请求",
      hasApprovalLayers ? "Approve Current Layer" : "Approve Request",
    ),
    message: `${facts}\n\n${approvalText(
      locale,
      hasApprovalLayers
        ? "批准后系统会重新评估；若仍需审批则进入下一层，全部满足后才最多尝试执行一次。"
        : "批准后系统会重新评估；只有满足全部规则，才最多尝试执行一次。",
      hasApprovalLayers
        ? "After approval, the system re-evaluates the request. If more approval is required it advances to the next layer; only after every layer is satisfied may execution be attempted once at most."
        : "After approval, the system re-evaluates the request; only when every rule is satisfied may execution be attempted once at most.",
    )}`,
    tone: operation.risk === "destructive" ? "danger" : "neutral",
    title: approvalText(
      locale,
      hasApprovalLayers
        ? "确认通过当前审批层"
        : "确认批准 Operation Permission 请求",
      hasApprovalLayers
        ? "Confirm Current Approval Layer"
        : "Confirm Operation Permission Request",
    ),
    toastMessage: approvalText(
      locale,
      hasApprovalLayers
        ? "当前审批层已处理，流程已重新评估并推进。"
        : "审批请求已处理，流程已重新评估。",
      hasApprovalLayers
        ? "The current approval layer was processed; the flow was re-evaluated and advanced."
        : "The approval request was processed and the flow was re-evaluated.",
    ),
    toastTitle: approvalText(locale, "审批已完成", "Approval Completed"),
  };
}

export function createApprovalFlowActionGuard() : any {
  const inFlightKeys: any = reactive(new Set<string>());

  function isBusy(key: string) : any {
    return inFlightKeys.has(key);
  }

  async function run(key: string, action: () => Promise<boolean>) : Promise<any> {
    if (inFlightKeys.has(key)) return false;
    inFlightKeys.add(key);
    try {
      return await action();
    } finally {
      inFlightKeys.delete(key);
    }
  }

  return { isBusy, run };
}

export function useApprovalFlowViewController() : any {
  const { approvalFlowConsole } = useServerConsoleShellContext();
  const {
    approvalFlowSelectedStatus,
    busyKey,
    mcpAuthorizationRequests,
    operationPermissionPendingOperations,
    resolveMcpAuthorizationRequest,
    resolveOperationPermissionPendingOperation,
    selectApprovalFlowStatus,
  } = approvalFlowConsole;

  const approvalFlowStatus: any = computed<ApprovalFlowStatus>({
    get: () : any => approvalFlowSelectedStatus.value,
    set: (status?: any) : any => {
      void selectApprovalFlowStatus(status);
    },
  });
  const approvalFlowStatusOptionBarOptions: any = [
    { value: "pending", label: "待决定" },
    { value: "resolved", label: "已处理" },
    { value: "rejected", label: "已拒绝" },
    { value: "all", label: "全部" },
  ] satisfies Array<{ value: ApprovalFlowStatus; label: string }>;

  const allApprovalFlowCards: any = computed<ApprovalFlowCard[]>(() : any =>
    [
      ...mcpAuthorizationRequests.value.map((request?: any) : any =>
        mcpAuthorizationApprovalCard(request),
      ),
      ...operationPermissionPendingOperations.value.map((operation?: any) : any =>
        operationPermissionApprovalCard(operation),
      ),
    ].sort((left?: any, right?: any) : any => timestampOfCard(right) - timestampOfCard(left)),
  );
  const approvalFlowCards: any = computed(() : any =>
    allApprovalFlowCards.value.filter((card?: any) : any =>
      approvalFlowCardMatchesStatus(card, approvalFlowSelectedStatus.value),
    ),
  );
  const actionGuard: any = createApprovalFlowActionGuard();
  type ActiveApprovalResolution = "approved" | "rejected";
  const activeResolutionByKey: any = reactive(
    new Map<string, ActiveApprovalResolution>(),
  );
  const approvalFlowLoading: any = computed(() : any =>
    [
      "mcp-authorization-requests:refresh",
      "operation-permission-pending:refresh",
    ].includes(busyKey.value),
  );

  async function runApprovalDecision(
    key: string,
    resolution: ActiveApprovalResolution,
    action: () => Promise<boolean>,
  ) : Promise<any> {
    if (actionGuard.isBusy(key)) return false;
    activeResolutionByKey.set(key, resolution);
    try {
      return await actionGuard.run(key, action);
    } finally {
      activeResolutionByKey.delete(key);
    }
  }

  function refreshApprovalFlow({ reset = false }: Record<string, any> = {}) : any {
    return selectApprovalFlowStatus(
      reset ? "pending" : approvalFlowSelectedStatus.value,
    );
  }

  function authorizationBusy(request: McpAuthorizationRequest) : any {
    const key: any = `authorization:${request.requestId}`;
    return (
      actionGuard.isBusy(key) ||
      busyKey.value ===
        `mcp-authorization-requests:resolve:${request.requestId}`
    );
  }

  function authorizationResolution(request: McpAuthorizationRequest) : any {
    return (
      activeResolutionByKey.get(`authorization:${request.requestId}`) || ""
    );
  }

  function approveAuthorization(request: McpAuthorizationRequest) : any {
    return runApprovalDecision(
      `authorization:${request.requestId}`,
      "approved",
      async () : Promise<any> => {
        const copy: any = mcpAuthorizationDecisionCopy(request, "approved");
        const confirmed: any = await confirmConsoleAction(copy.message, {
          title: copy.title,
          confirmLabel: copy.confirmLabel,
          tone: copy.tone,
        });
        if (!confirmed) return false;
        const succeeded: any = await resolveMcpAuthorizationRequest(
          request.requestId,
          "approved",
        );
        if (succeeded) {
          notifyConsoleAction(copy.toastMessage, {
            tone: "success",
            title: copy.toastTitle,
          });
        }
        return succeeded;
      },
    );
  }

  function rejectAuthorization(request: McpAuthorizationRequest) : any {
    return runApprovalDecision(
      `authorization:${request.requestId}`,
      "rejected",
      async () : Promise<any> => {
        const copy: any = mcpAuthorizationDecisionCopy(request, "rejected");
        const confirmed: any = await confirmConsoleAction(copy.message, {
          title: copy.title,
          tone: copy.tone,
          confirmLabel: copy.confirmLabel,
        });
        if (!confirmed) return false;
        const succeeded: any = await resolveMcpAuthorizationRequest(
          request.requestId,
          "rejected",
        );
        if (succeeded) {
          notifyConsoleAction(copy.toastMessage, {
            tone: "success",
            title: copy.toastTitle,
          });
        }
        return succeeded;
      },
    );
  }

  function pendingOperationBusy(
    operation: OperationPermissionPendingOperation,
  ) : any {
    const key: any = `pendingOperation:${operation.pendingOperationId}`;
    return (
      actionGuard.isBusy(key) ||
      busyKey.value ===
        `operation-permission-pending:resolve:${operation.pendingOperationId}`
    );
  }

  function pendingOperationResolution(
    operation: OperationPermissionPendingOperation,
  ) : any {
    return (
      activeResolutionByKey.get(
        `pendingOperation:${operation.pendingOperationId}`,
      ) || ""
    );
  }

  function approvePendingOperation(
    operation: OperationPermissionPendingOperation,
  ) : any {
    return runApprovalDecision(
      `pendingOperation:${operation.pendingOperationId}`,
      "approved",
      async () : Promise<any> => {
        const copy: any = operationPermissionDecisionCopy(operation, "approved");
        const confirmed: any = await confirmConsoleAction(copy.message, {
          title: copy.title,
          confirmLabel: copy.confirmLabel,
          tone: copy.tone,
        });
        if (!confirmed) return false;
        const succeeded: any = await resolveOperationPermissionPendingOperation(
          operation.pendingOperationId,
          "approved",
        );
        if (succeeded) {
          notifyConsoleAction(copy.toastMessage, {
            tone: "success",
            title: copy.toastTitle,
          });
        }
        return succeeded;
      },
    );
  }

  function rejectPendingOperation(
    operation: OperationPermissionPendingOperation,
  ) : any {
    return runApprovalDecision(
      `pendingOperation:${operation.pendingOperationId}`,
      "rejected",
      async () : Promise<any> => {
        const copy: any = operationPermissionDecisionCopy(operation, "rejected");
        const confirmed: any = await confirmConsoleAction(copy.message, {
          title: copy.title,
          tone: copy.tone,
          confirmLabel: copy.confirmLabel,
        });
        if (!confirmed) return false;
        const succeeded: any = await resolveOperationPermissionPendingOperation(
          operation.pendingOperationId,
          "rejected",
        );
        if (succeeded) {
          notifyConsoleAction(copy.toastMessage, {
            tone: "success",
            title: copy.toastTitle,
          });
        }
        return succeeded;
      },
    );
  }

  onMounted(() : any => {
    void refreshApprovalFlow({ reset: true });
  });

  return {
    approvalFlowCards,
    approvalFlowLoading,
    approvalFlowStatus,
    approvalFlowStatusOptionBarOptions,
    approveAuthorization,
    approvePendingOperation,
    authorizationBusy,
    authorizationResolution,
    pendingOperationBusy,
    pendingOperationResolution,
    refreshApprovalFlow,
    rejectAuthorization,
    rejectPendingOperation,
  };
}
