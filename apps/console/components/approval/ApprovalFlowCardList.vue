<script setup lang="ts">
import { computed } from "vue";
import { useApprovalFlowViewContext } from "../../composables/approvalFlowViewContext";
import { currentConsoleLocale, localizeConsoleText, resolveEffectiveConsoleLocale } from "../../i18n/console";

const {
  approvalFlowCards,
  approveAuthorization,
  approvePendingOperation,
  authorizationBusy,
  pendingOperationBusy,
  rejectAuthorization,
  rejectPendingOperation,
} = useApprovalFlowViewContext();

const approvalFlowLocale = computed(() => resolveEffectiveConsoleLocale(currentConsoleLocale.value));
const emptyAuthorizationTitle = computed(() => localizeConsoleText("没有待处理的授权请求", approvalFlowLocale.value));
const emptyApprovalDescription = computed(() =>
  localizeConsoleText("当前没有需要人工处理的审批事项。", approvalFlowLocale.value),
);
</script>

<template>
  <div class="approval-card-list">
    <article
      v-for="card in approvalFlowCards"
      :key="card.key"
      :id="`approval-${card.key}`"
      class="approval-request-card"
      :data-tone="card.tone"
    >
      <header class="approval-request-card-header">
        <div>
          <span class="approval-request-card-label">{{ card.label }}</span>
          <strong>{{ card.title }}</strong>
        </div>
        <div class="approval-request-card-meta">
          <span v-for="item in card.meta" :key="`${card.key}:${item}`">{{ item }}</span>
        </div>
      </header>
      <p>{{ card.summary }}</p>

      <div
        v-if="card.kind === 'authorization' && card.request.status === 'pending'"
        class="approval-request-card-actions"
      >
        <button
          class="configuration-alert-action"
          type="button"
          :disabled="authorizationBusy(card.request)"
          @click="approveAuthorization(card.request)"
        >
          批准
        </button>
        <button
          class="configuration-alert-action danger-action"
          type="button"
          :disabled="authorizationBusy(card.request)"
          @click="rejectAuthorization(card.request)"
        >
          拒绝
        </button>
      </div>

      <div
        v-else-if="card.kind === 'pendingOperation' && card.pendingOperation.status === 'pending'"
        class="approval-request-card-actions"
      >
        <button
          class="configuration-alert-action"
          type="button"
          :disabled="pendingOperationBusy(card.pendingOperation)"
          @click="approvePendingOperation(card.pendingOperation)"
        >
          批准
        </button>
        <button
          class="configuration-alert-action danger-action"
          type="button"
          :disabled="pendingOperationBusy(card.pendingOperation)"
          @click="rejectPendingOperation(card.pendingOperation)"
        >
          拒绝
        </button>
      </div>

    </article>

    <article v-if="approvalFlowCards.length === 0" class="approval-request-card approval-request-empty-card">
      <strong>{{ emptyAuthorizationTitle }}</strong>
      <span>{{ emptyApprovalDescription }}</span>
    </article>
  </div>
</template>
