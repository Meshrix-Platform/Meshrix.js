<script setup lang="ts">
import { computed, ref } from "vue";
import { bridge, type BridgeDownloadResult } from "../lib/bridge";

const props = withDefaults(defineProps<{
  href: string;
  label?: string;
  busyLabel?: string;
  downloadName?: string;
  buttonClass?: string;
  disabled?: boolean;
  inline?: boolean;
}>(), {
  label: "下载",
  busyLabel: "下载中",
  downloadName: "",
  buttonClass: "tool-button",
  disabled: false,
  inline: false,
});

const emit = defineEmits<{
  downloaded: [result: BridgeDownloadResult];
  failed: [message: string];
}>();

const busy = ref(false);
const error = ref("");

const isDisabled = computed(() => busy.value || props.disabled || !props.href || props.href === "#");

async function startDownload() {
  if (isDisabled.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await bridge.downloadFile(
      props.href,
      props.downloadName ? { fileName: props.downloadName } : {},
    );
    emit("downloaded", result);
  } catch (nextError) {
    const message = nextError instanceof Error ? nextError.message : "下载失败。";
    error.value = message;
    emit("failed", message);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <span class="bridge-download-button" :data-inline="inline ? 'true' : 'false'">
    <button
      :class="buttonClass"
      type="button"
      :disabled="isDisabled"
      @click="startDownload"
    >
      {{ busy ? busyLabel : label }}
    </button>
    <small v-if="error" class="bridge-download-error">{{ error }}</small>
  </span>
</template>

<style scoped>
.bridge-download-button {
  display: inline-flex;
  max-width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.bridge-download-button[data-inline="true"] {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.bridge-download-error {
  max-width: min(36rem, 100%);
  color: var(--danger);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

.bridge-download-link {
  display: inline;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--brand);
  font: inherit;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.bridge-download-link:hover {
  text-decoration: underline;
}

.bridge-download-link:disabled {
  color: var(--text-disabled);
  cursor: not-allowed;
  text-decoration: none;
}
</style>
