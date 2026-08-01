<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { RouterLink } from "vue-router";
import { useApprovalFlowViewContext } from "../../composables/approvalFlowViewContext";
import type { ApprovalFlowCard } from "../../composables/console-approval-flow-view-controller";
import {
  currentConsoleLocale,
  resolveEffectiveConsoleLocale,
} from "../../i18n/console";

const {
  approvalFlowCards,
  approvalFlowLoading,
  approvalFlowStatus,
  approveAuthorization,
  approvePendingOperation,
  authorizationBusy,
  authorizationResolution,
  pendingOperationBusy,
  pendingOperationResolution,
  rejectAuthorization,
  rejectPendingOperation,
} = useApprovalFlowViewContext();
const approvalCardList = ref<HTMLElement | null>(null);
const approvalListAnnouncement = ref("");

const approvalFlowLocale = computed(() =>
  resolveEffectiveConsoleLocale(currentConsoleLocale.value),
);
function approvalListText(zh: string, en: string) {
  return approvalFlowLocale.value === "en" ? en : zh;
}

const emptyAuthorizationTitle = computed(() => {
  if (approvalFlowStatus.value === "resolved") {
    return approvalListText(
      "没有已处理的审批事项",
      "No Processed Approval Items",
    );
  }
  if (approvalFlowStatus.value === "rejected") {
    return approvalListText(
      "没有已拒绝的审批事项",
      "No Rejected Approval Items",
    );
  }
  if (approvalFlowStatus.value === "all") {
    return approvalListText("没有审批记录", "No Approval Records");
  }
  return approvalListText("没有待决定的审批事项", "No Pending Decisions");
});
const emptyApprovalDescription = computed(() =>
  approvalFlowStatus.value === "pending"
    ? approvalListText(
        "当前没有需要人工决定的审批事项。",
        "No approval items require a manual decision.",
      )
    : approvalListText(
        "当前筛选条件下没有审批记录。",
        "No approval records match the current filter.",
      ),
);

function statusGroupLabel(card: ApprovalFlowCard) {
  return approvalListText(
    `${card.label}：${card.decisionStatus.label} ${card.decisionStatus.value}，${card.executionStatus.label} ${card.executionStatus.value}`,
    `${card.label}: ${card.decisionStatus.label} ${card.decisionStatus.value}; ${card.executionStatus.label} ${card.executionStatus.value}`,
  );
}

function actionGroupLabel(card: ApprovalFlowCard) {
  if (card.kind === "authorization") {
    return card.request.requestKind === "local_mcp_install"
      ? approvalListText(
          "MCP 本机安装授权操作",
          "Local MCP installation authorization actions",
        )
      : approvalListText(
          "MCP 客户端授权操作",
          "MCP client authorization actions",
        );
  }
  return approvalListText(
    "Operation Permission 审批操作",
    "Operation Permission approval actions",
  );
}

function authorizationApprovalLabel(
  card: Extract<ApprovalFlowCard, { kind: "authorization" }>,
) {
  if (authorizationBusy(card.request)) {
    return authorizationResolution(card.request) === "rejected"
      ? approvalListText("正在拒绝…", "Rejecting…")
      : approvalListText("正在批准…", "Approving…");
  }
  return card.request.requestKind === "local_mcp_install"
    ? approvalListText("批准本次安装", "Approve This Installation")
    : approvalListText("批准本次授权", "Approve This Authorization");
}

function authorizationRejectLabel(
  card: Extract<ApprovalFlowCard, { kind: "authorization" }>,
) {
  if (!authorizationBusy(card.request)) {
    return approvalListText("拒绝请求", "Reject Request");
  }
  return authorizationResolution(card.request) === "approved"
    ? approvalListText("正在批准…", "Approving…")
    : approvalListText("正在拒绝…", "Rejecting…");
}

function operationApprovalLabel(
  card: Extract<ApprovalFlowCard, { kind: "pendingOperation" }>,
) {
  if (pendingOperationBusy(card.pendingOperation)) {
    return pendingOperationResolution(card.pendingOperation) === "rejected"
      ? approvalListText("正在拒绝…", "Rejecting…")
      : approvalListText("正在批准…", "Approving…");
  }
  return card.pendingOperation.approvalLayers?.length
    ? approvalListText("通过当前审批层", "Approve Current Layer")
    : approvalListText("批准请求", "Approve Request");
}

function operationRejectLabel(
  card: Extract<ApprovalFlowCard, { kind: "pendingOperation" }>,
) {
  if (!pendingOperationBusy(card.pendingOperation)) {
    return approvalListText("拒绝请求", "Reject Request");
  }
  return pendingOperationResolution(card.pendingOperation) === "approved"
    ? approvalListText("正在批准…", "Approving…")
    : approvalListText("正在拒绝…", "Rejecting…");
}

async function runCardAction(
  card: ApprovalFlowCard,
  action: () => Promise<boolean>,
) {
  const succeeded = await action();
  if (!succeeded) return;
  await nextTick();
  approvalListAnnouncement.value = approvalListText(
    `${card.title} 已处理，审批列表已更新。`,
    `${card.title} was processed. The approval list has been updated.`,
  );
  if (!document.getElementById(`approval-${card.key}`)) {
    approvalCardList.value?.focus();
  }
}
</script>

<template>
  <div
    ref="approvalCardList"
    class="approval-card-list"
    tabindex="-1"
    :aria-busy="approvalFlowLoading"
  >
    <p
      class="approval-flow-live-region"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {{ approvalListAnnouncement }}
    </p>
    <article
      v-for="card in approvalFlowCards"
      :key="card.key"
      :id="`approval-${card.key}`"
      class="approval-request-card"
      :data-tone="card.tone"
      :data-approval-kind="card.kind"
      data-testid="approval-request-card"
    >
      <header class="approval-request-card-header">
        <div class="approval-request-card-heading">
          <span class="approval-request-card-label">{{ card.label }}</span>
          <h4>{{ card.title }}</h4>
        </div>
        <div
          class="approval-request-card-meta"
          role="group"
          :aria-label="statusGroupLabel(card)"
        >
          <span
            class="approval-request-status"
            :data-tone="card.decisionStatus.tone"
          >
            <small>{{ card.decisionStatus.label }}</small>
            <strong>{{ card.decisionStatus.value }}</strong>
          </span>
          <span
            class="approval-request-status"
            :data-tone="card.executionStatus.tone"
          >
            <small>{{ card.executionStatus.label }}</small>
            <strong>{{ card.executionStatus.value }}</strong>
          </span>
        </div>
      </header>

      <p class="approval-request-card-summary">{{ card.summary }}</p>

      <dl class="approval-request-facts">
        <div
          v-for="fact in card.facts"
          :key="`${card.key}:fact:${fact.label}`"
          class="approval-request-fact"
        >
          <dt>{{ fact.label }}</dt>
          <dd :data-protected="fact.protected ? 'true' : undefined">
            {{ fact.value }}
          </dd>
        </div>
      </dl>

      <details
        v-if="card.technicalDetails.length"
        class="approval-request-technical"
        data-section="technical-details"
      >
        <summary>
          <span>{{ approvalListText("技术详情", "Technical Details") }}</span>
          <small>
            {{
              approvalFlowLocale === "en"
                ? `${card.technicalDetails.length} items`
                : `${card.technicalDetails.length} 项`
            }}
          </small>
        </summary>
        <dl class="approval-request-technical-grid">
          <div
            v-for="detail in card.technicalDetails"
            :key="`${card.key}:detail:${detail.label}`"
          >
            <dt>{{ detail.label }}</dt>
            <dd :data-protected="detail.protected ? 'true' : undefined">
              {{ detail.value }}
            </dd>
          </div>
        </dl>
      </details>

      <footer class="approval-request-card-footer">
        <RouterLink
          v-if="card.auditAvailable"
          class="approval-request-audit-link"
          to="/admin/tool-stats"
          data-testid="approval-audit-link"
        >
          {{
            approvalListText("查看最近执行审计", "View Recent Execution Audit")
          }}
          <span aria-hidden="true">→</span>
        </RouterLink>

        <div
          v-if="
            card.kind === 'authorization' && card.request.status === 'pending'
          "
          class="approval-request-card-actions"
          role="group"
          :aria-label="actionGroupLabel(card)"
        >
          <button
            class="configuration-alert-action approval-request-primary-action"
            type="button"
            data-action="mcp-approve"
            :disabled="authorizationBusy(card.request)"
            @click="
              runCardAction(card, () => approveAuthorization(card.request))
            "
          >
            {{ authorizationApprovalLabel(card) }}
          </button>
          <button
            class="configuration-alert-action danger-action"
            type="button"
            data-action="mcp-reject"
            :disabled="authorizationBusy(card.request)"
            @click="
              runCardAction(card, () => rejectAuthorization(card.request))
            "
          >
            {{ authorizationRejectLabel(card) }}
          </button>
        </div>

        <div
          v-else-if="
            card.kind === 'pendingOperation' &&
            card.pendingOperation.status === 'pending'
          "
          class="approval-request-card-actions"
          role="group"
          :aria-label="actionGroupLabel(card)"
        >
          <button
            class="configuration-alert-action approval-request-primary-action"
            type="button"
            data-action="operation-approve"
            :disabled="pendingOperationBusy(card.pendingOperation)"
            @click="
              runCardAction(card, () =>
                approvePendingOperation(card.pendingOperation),
              )
            "
          >
            {{ operationApprovalLabel(card) }}
          </button>
          <button
            class="configuration-alert-action danger-action"
            type="button"
            data-action="operation-reject"
            :disabled="pendingOperationBusy(card.pendingOperation)"
            @click="
              runCardAction(card, () =>
                rejectPendingOperation(card.pendingOperation),
              )
            "
          >
            {{ operationRejectLabel(card) }}
          </button>
        </div>
      </footer>
    </article>

    <article
      v-if="approvalFlowLoading && approvalFlowCards.length === 0"
      class="approval-request-card approval-request-empty-card"
      role="status"
    >
      <strong>{{ approvalListText("正在加载审批事项…", "Loading Approval Items…") }}</strong>
      <span>{{ approvalListText("正在获取最新审批状态。", "Fetching the latest approval state.") }}</span>
    </article>

    <article
      v-else-if="approvalFlowCards.length === 0"
      class="approval-request-card approval-request-empty-card"
    >
      <strong>{{ emptyAuthorizationTitle }}</strong>
      <span>{{ emptyApprovalDescription }}</span>
    </article>
  </div>
</template>
