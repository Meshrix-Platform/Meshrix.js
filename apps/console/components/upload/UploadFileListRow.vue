<script setup lang="ts">
import { computed } from "vue";
import BridgeDownloadButton from "../BridgeDownloadButton.vue";
import SegmentedProgressBar from "../SegmentedProgressBar.vue";
import StatusPill from "@meshrix/ui-console/status-pill";
import { currentConsoleLocale, localizeConsoleText, resolveEffectiveConsoleLocale } from "../../i18n/console";
import {
  uploadFileListIcons,
  uploadProgressStepLabels,
  uploadTotalProgressSteps,
  type UploadFileEntry,
  type UploadProgressState,
} from "../../lib/upload-file-list";

const props = withDefaults(defineProps<{
  entry: UploadFileEntry;
  mode?: "upload" | "download";
  progressState: UploadProgressState;
  progressStepLabels?: string[];
  totalProgressSteps?: number;
  fileIconUrl?: string;
  formatBytes?: (bytes: number) => string;
}>(), {
  mode: "upload",
  progressStepLabels: () => uploadProgressStepLabels,
  totalProgressSteps: uploadTotalProgressSteps,
  fileIconUrl: uploadFileListIcons.file,
  formatBytes: (bytes: number) => `${Math.max(0, Number(bytes) || 0)} B`,
});

const isDownloadMode = computed(() => props.mode === "download");
const locale = computed(() => resolveEffectiveConsoleLocale(currentConsoleLocale.value));
function t(value: string) {
  return localizeConsoleText(value, locale.value);
}

const activeStepLabel = computed(() => {
  const activeIndex = Math.max(0, Math.min(props.totalProgressSteps - 1, props.progressState.completedSteps - 1));
  return props.progressStepLabels[activeIndex] || "";
});
</script>

<template>
  <div
    class="upload-file-row"
    :data-mode="isDownloadMode ? 'download' : 'upload'"
  >
    <div class="upload-file-identity">
      <img :src="fileIconUrl" alt="" aria-hidden="true" />
      <div class="upload-file-name-block">
        <span class="upload-file-name" :title="entry.relativePath">{{ entry.relativePath }}</span>
        <small>
          {{ entry.extension }}<template v-if="!isDownloadMode && entry.size > 0"> · {{ formatBytes(entry.size) }}</template>
        </small>
      </div>
    </div>

    <div v-if="!isDownloadMode" class="upload-file-progress">
      <div class="upload-file-progress-meta">
        <span>{{ t(progressState.detail) }}</span>
        <small>{{ t(activeStepLabel) }}</small>
      </div>
      <SegmentedProgressBar
        size="compact"
        :aria-label="`${entry.name} ${t('处理进度')}`"
        :completed-steps="progressState.completedSteps"
        :labels="progressStepLabels"
        :total-steps="totalProgressSteps"
      />
    </div>
    <div v-else class="upload-file-result-meta">
      <span>{{ t(entry.detail || "可下载文件") }}</span>
      <small v-if="entry.size > 0">{{ formatBytes(entry.size) }}</small>
    </div>

    <div v-if="!isDownloadMode" class="upload-file-status">
      <StatusPill :tone="progressState.tone" :label="t(progressState.label)" />
    </div>
    <div v-else class="upload-file-download-actions">
      <BridgeDownloadButton
        v-if="entry.href"
        :href="entry.href"
        :download-name="entry.downloadName || entry.name"
        :label="t(entry.actionLabel || '下载')"
        button-class="tool-button"
      />
      <StatusPill
        v-else
        :tone="entry.statusTone || 'neutral'"
        :label="t(entry.statusLabel || '未生成')"
      />
    </div>
  </div>
</template>

<style scoped>
.upload-file-row {
  display: grid;
  grid-template-columns: minmax(260px, 1.05fr) minmax(260px, 0.9fr) minmax(116px, auto);
  gap: var(--space-4);
  align-items: center;
  min-width: 0;
  padding: var(--space-3-5) var(--space-4);
  border-top: 1px solid var(--border-subtle);
}

.upload-file-row:first-child {
  border-top: 0;
}

.upload-file-row[data-mode="download"] {
  grid-template-columns: minmax(260px, 1.15fr) minmax(180px, 0.75fr) minmax(116px, auto);
}

.upload-file-identity {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.upload-file-identity > img {
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  opacity: 0.82;
  filter: invert(52%) sepia(10%) saturate(472%) hue-rotate(176deg) brightness(91%) contrast(89%);
}

.upload-file-name-block {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.upload-file-name {
  min-width: 0;
  color: var(--text-primary);
  font-size: var(--text-2xl);
  font-weight: 800;
  line-height: var(--leading-snug);
  overflow-wrap: anywhere;
}

.upload-file-name-block small,
.upload-file-progress-meta small,
.upload-file-result-meta small {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 700;
}

.upload-file-progress {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}

.upload-file-progress-meta {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  min-width: 0;
}

.upload-file-result-meta {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.upload-file-progress-meta span,
.upload-file-result-meta span {
  min-width: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-file-status,
.upload-file-download-actions {
  display: flex;
  justify-content: flex-end;
  min-width: 0;
}

.upload-file-download-actions .tool-button {
  min-height: 36px;
  text-decoration: none;
}

@media (max-width: 880px) {
  .upload-file-row {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-3);
  }

  .upload-file-status {
    justify-content: flex-start;
  }
}
</style>
