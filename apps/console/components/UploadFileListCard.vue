<script setup lang="ts">
import { computed } from "vue";
import UploadFileListRow from "./upload/UploadFileListRow.vue";
import UploadSplitButton from "./upload/UploadSplitButton.vue";
import { currentConsoleLocale, localizeConsoleText, resolveEffectiveConsoleLocale } from "../i18n/console";
import type { SplitJob } from "../lib/types";
import {
  buildUploadFileEntries,
  resolveUploadProgressState,
  summarizeUploadSelection,
  uploadFileListIcons,
  uploadProgressStepLabels,
  uploadTotalProgressSteps,
  type FileListResultEntry,
  type UploadFileEntry,
  type UploadProgressState,
} from "../lib/upload-file-list";

const props = withDefaults(defineProps<{
  files?: File[];
  mode?: "upload" | "download";
  title?: string;
  summary?: string;
  resultFiles?: FileListResultEntry[];
  canSubmit?: boolean;
  canWriteJobs?: boolean;
  busyKey?: string;
  ingestJob?: SplitJob | null;
  ingestProgress?: string;
  jobStatusLabels?: Record<string, string>;
  jobStatusTone?: (status: string) => string;
  formatBytes?: (bytes: number) => string;
}>(), {
  files: () => [],
  mode: "upload",
  title: "文件列表",
  summary: "",
  resultFiles: () => [],
  canSubmit: false,
  canWriteJobs: false,
  busyKey: "",
  ingestJob: null,
  ingestProgress: "",
  jobStatusLabels: () => ({}),
  jobStatusTone: () => "neutral",
  formatBytes: (bytes: number) => `${Math.max(0, Number(bytes) || 0)} B`,
});

const emit = defineEmits<{
  preview: [];
  select: [files: File[]];
  upload: [];
}>();

const fileIconUrl = uploadFileListIcons.file;
const folderIconUrl = uploadFileListIcons.folder;
const totalProgressSteps = uploadTotalProgressSteps;
const locale = computed(() => resolveEffectiveConsoleLocale(currentConsoleLocale.value));
function t(value: string) {
  return localizeConsoleText(value, locale.value);
}

const isBusy = computed(() => props.busyKey === "upload:ingest");
const isDownloadMode = computed(() => props.mode === "download");
const progressStepLabels = computed(() => uploadProgressStepLabels.map((label) => t(label)));

const fileEntries = computed<UploadFileEntry[]>(() =>
  buildUploadFileEntries({
    files: props.files,
    mode: props.mode,
    resultFiles: props.resultFiles,
  }),
);

const selectedSummary = computed(() =>
  t(
    summarizeUploadSelection({
      files: props.files,
      fileEntries: fileEntries.value,
      formatBytes: props.formatBytes,
      mode: props.mode,
      summary: props.summary,
    }),
  ),
);

const progressState = computed<UploadProgressState>(() => {
  const state = resolveUploadProgressState({
    files: props.files,
    ingestJob: props.ingestJob,
    ingestProgress: props.ingestProgress,
    isBusy: isBusy.value,
    jobStatusLabels: props.jobStatusLabels,
    jobStatusTone: props.jobStatusTone,
  });
  return {
    ...state,
    detail: t(state.detail),
    label: t(state.label),
  };
});

const canStartUpload = computed(() =>
  !isDownloadMode.value &&
  props.canWriteJobs &&
  props.canSubmit &&
  props.files.length > 0 &&
  !isBusy.value,
);

const canChooseFiles = computed(() => props.canWriteJobs && !isBusy.value);
</script>

<template>
  <section class="upload-file-list-card" :aria-label="t('文件列表')" :data-mode="mode">
    <header class="upload-file-list-header">
      <div class="upload-file-list-title">
        <h4>{{ t(title) }}</h4>
        <span>{{ selectedSummary }}</span>
      </div>
      <UploadSplitButton
        v-if="!isDownloadMode"
        :disabled="!canChooseFiles"
        @select="emit('select', $event)"
      />
    </header>

    <div class="upload-file-list-body">
      <div v-if="fileEntries.length === 0" class="upload-file-list-empty">
        <img :src="folderIconUrl" alt="" aria-hidden="true" />
        <span>{{ t("暂无文件") }}</span>
      </div>
      <UploadFileListRow
        v-for="entry in fileEntries"
        :key="entry.key"
        :entry="entry"
        :mode="mode"
        :progress-state="progressState"
        :progress-step-labels="progressStepLabels"
        :total-progress-steps="totalProgressSteps"
        :file-icon-url="fileIconUrl"
        :format-bytes="formatBytes"
      />
    </div>

    <footer v-if="!isDownloadMode" class="upload-file-list-footer">
      <div class="upload-file-job-summary">
        <span v-if="ingestJob">{{ t("任务") }} {{ ingestJob.id }}</span>
        <span v-else>{{ t(ingestProgress || "等待开始") }}</span>
      </div>
      <div class="upload-file-actions">
        <button
          class="tool-button tool-button-ghost"
          type="button"
          :disabled="!canWriteJobs || files.length === 0 || isBusy"
          @click="emit('preview')"
        >
          {{ t("预览解析") }}
        </button>
        <button
          class="primary-action"
          type="button"
          :disabled="!canStartUpload"
          @click="emit('upload')"
        >
          {{ t(isBusy ? "入库中" : "开始入库") }}
        </button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.upload-file-list-card {
  display: grid;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
}

.upload-file-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-width: 0;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-subtle);
}

.upload-file-list-title {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.upload-file-list-title h4 {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--text-2xl);
  font-weight: 800;
}

.upload-file-list-title span,
.upload-file-job-summary {
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-weight: 700;
}

.upload-file-list-body {
  display: grid;
  min-width: 0;
  max-height: 430px;
  overflow: auto;
}

.upload-file-list-empty {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 72px;
  padding: 18px 16px;
  color: var(--text-muted);
  font-weight: 700;
}

.upload-file-list-empty img {
  width: 24px;
  height: 24px;
  opacity: 0.64;
  filter: invert(52%) sepia(10%) saturate(472%) hue-rotate(176deg) brightness(91%) contrast(89%);
}

.upload-file-list-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-width: 0;
  padding: 12px 16px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-subtle);
}

.upload-file-job-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-file-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

@media (max-width: 880px) {
  .upload-file-list-header,
  .upload-file-list-footer {
    align-items: stretch;
    flex-direction: column;
  }

  .upload-file-actions {
    width: 100%;
  }

  .upload-file-actions > button {
    flex: 1 1 120px;
  }
}
</style>
