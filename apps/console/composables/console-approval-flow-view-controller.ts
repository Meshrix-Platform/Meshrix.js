import { computed, onMounted, reactive } from "vue";
import { formatMachineDate } from "@meshrix/ui-console/console-format-utils";
import {
  confirmConsoleAction,
  notifyConsoleAction,
} from "./console-browser-effects";
import type { OperationPermissionPendingOperation } from "../lib/operation-permission-client";
import {
  currentConsoleLocale,
  resolveEffectiveConsoleLocale,
  type ConsoleLocale,
} from "../i18n/console";
import {
  buildGovernedConfirmPayload,
  type GovernedConfirmPayload,
} from "./console-governed-confirm-payload";
import { useServerConsoleShellContext } from "@meshrix/ui-console/server-console-shell-context";

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

export type ApprovalFlowCard = ApprovalFlowCardBase & {
  kind: "pendingOperation";
  pendingOperation: OperationPermissionPendingOperation;
};

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
  const timestamps: any = [
    card.pendingOperation.completedAt,
    card.pendingOperation.resolvedAt,
    card.pendingOperation.createdAt,
  ].filter(Boolean);
  return (
    timestamps
      .map((timestamp?: any) : any => Date.parse(String(timestamp)))
      .find((timestamp?: any) : any => Number.isFinite(timestamp)) || 0
  );
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
  const record: any = card.pendingOperation;
  const recordStatus: any = String(record.status || "");
  if (status === "pending" || status === "rejected") {
    return recordStatus === status;
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

export function operationPermissionDecisionCopy(
  operation: OperationPermissionPendingOperation,
  resolution: "approved" | "rejected",
  locale: any = approvalLocale(),
): GovernedConfirmPayload {
  // Facts are assembled here and resolved into copy inside the shared builder:
  // effect = risk impact, resource = the operation, authority = the requester,
  // duration = the deadline, risk = the operation risk enum.
  return buildGovernedConfirmPayload(
    {
      effect: riskImpact(operation.risk, locale),
      resource: operationApprovalTitle(operation),
      authority: operationRequester(operation, locale),
      duration: displayDeadline(operation.expiresAt, locale),
      risk: String(operation.risk || ""),
    },
    locale,
    {
      resolution,
      hasApprovalLayers: operationHasApprovalLayers(operation),
    },
  );
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
    isBusy,
    operationPermissionPendingOperations,
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
    operationPermissionPendingOperations.value
      .map((operation?: any) : any => operationPermissionApprovalCard(operation))
      .sort((left?: any, right?: any) : any => timestampOfCard(right) - timestampOfCard(left)),
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
    isBusy("operation-permission-pending:refresh"),
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

  function pendingOperationBusy(
    operation: OperationPermissionPendingOperation,
  ) : any {
    const key: any = `pendingOperation:${operation.pendingOperationId}`;
    return (
      actionGuard.isBusy(key) ||
      isBusy(`operation-permission-pending:resolve:${operation.pendingOperationId}`)
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
        const confirmed: any = await confirmConsoleAction(copy.body, {
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
        const confirmed: any = await confirmConsoleAction(copy.body, {
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
    approvePendingOperation,
    pendingOperationBusy,
    pendingOperationResolution,
    refreshApprovalFlow,
    rejectPendingOperation,
  };
}
