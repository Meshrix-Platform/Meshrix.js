<script setup lang="ts">
import ConfigFoldCard from "../../../components/ConfigFoldCard.vue";
import { formatCompactDate } from "../../../composables/console-format-utils";

export interface ContextBuildRecordRow {
  recordId: string;
  createdAt: string;
  profileId: string;
  totalTokens: number;
  sourceTokens: number;
  triggerReason: string;
  compressionMode: string;
  preservedEvidenceIds: string[];
  droppedReferenceCount: number;
  humanOperatorGuidanceCount: number;
}

withDefaults(defineProps<{
  records?: ContextBuildRecordRow[];
  highlighted?: boolean;
}>(), {
  records: () => [],
  highlighted: false,
});
</script>

<template>
  <ConfigFoldCard
    title="最近上下文编译记录"
    data-config-target="approval-flow-agent"
    :data-config-highlighted="highlighted"
    open
  >
    <div class="context-build-record-list">
      <article
        v-for="record in records"
        :key="record.recordId"
        class="context-build-record"
      >
        <div>
          <strong>{{ record.profileId }}</strong>
          <span>{{ formatCompactDate(record.createdAt) }}</span>
          <span>{{ record.compressionMode }}</span>
          <span>{{ record.triggerReason }}</span>
        </div>
        <small>token {{ record.totalTokens.toLocaleString() }}</small>
        <small>source {{ record.sourceTokens.toLocaleString() }}</small>
        <small>保留证据 {{ record.preservedEvidenceIds.length }}</small>
        <small>丢弃 {{ record.droppedReferenceCount }}</small>
        <small>人工指导 {{ record.humanOperatorGuidanceCount }}</small>
        <code>{{ record.recordId }}</code>
      </article>
      <div v-if="!records.length" class="empty-note">
        暂无上下文编译记录。
      </div>
    </div>
  </ConfigFoldCard>
</template>
