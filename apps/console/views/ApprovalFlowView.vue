<script setup lang="ts">
import { computed } from 'vue';
import ApprovalFlowCardList from '../components/approval/ApprovalFlowCardList.vue';
import SegmentedToggle from '../components/SegmentedToggle.vue';
import { provideApprovalFlowView } from '../composables/approvalFlowViewContext';
import { useApprovalFlowViewController } from '../composables/console-approval-flow-view-controller';
import { currentConsoleLocale, localizeConsoleText, resolveEffectiveConsoleLocale } from '../i18n/console';

const approvalFlow = useApprovalFlowViewController();
provideApprovalFlowView(approvalFlow);
const {
  approvalFlowStatus,
  approvalFlowStatusOptionBarOptions,
} = approvalFlow;

const approvalFlowLocale = computed(() => resolveEffectiveConsoleLocale(currentConsoleLocale.value));
const approvalFlowTitle = computed(() => localizeConsoleText('全平台审批流', approvalFlowLocale.value));
const approvalFlowDescription = computed(() =>
  localizeConsoleText('统一处理需要人工决策的事项。', approvalFlowLocale.value),
);
const approvalFlowStatusLabel = computed(() => localizeConsoleText('审批流状态', approvalFlowLocale.value));
const approvalFlowToggleOptions = computed(() =>
  approvalFlowStatusOptionBarOptions.map((option) => ({
    label: option.label,
    value: String(option.value),
  })),
);
</script>

<template>
  <section class="dashboard-view approval-flow-view">
    <article class="surface-card configuration-alert-card">
      <div class="section-header">
        <div>
          <h3>{{ approvalFlowTitle }}</h3>
          <p>{{ approvalFlowDescription }}</p>
        </div>
        <div class="source-actions">
          <SegmentedToggle
            v-model="approvalFlowStatus"
            :options="approvalFlowToggleOptions"
            :aria-label="approvalFlowStatusLabel"
            size="small"
          />
        </div>
      </div>

      <ApprovalFlowCardList />
    </article>
  </section>
</template>
