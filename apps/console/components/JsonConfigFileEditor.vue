<script lang="ts">
import { reactive } from "vue";

type JsonConfigEditorState = {
  text: string;
  savedText: string;
  sourceSignature: string;
  error: string;
  saving: boolean;
};

const jsonConfigEditorSingletons = new Map<string, JsonConfigEditorState>();

function stableJsonText(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? {}, null, 2);
}

function singletonStateFor(fileKey: string, initialText: string) {
  const key = fileKey.trim() || "json-config-editor:default";
  const sourceSignature = initialText;
  const existing = jsonConfigEditorSingletons.get(key);
  if (existing) {
    return existing;
  }
  const state = reactive<JsonConfigEditorState>({
    text: initialText,
    savedText: initialText,
    sourceSignature,
    error: "",
    saving: false,
  });
  jsonConfigEditorSingletons.set(key, state);
  return state;
}
</script>

<script setup lang="ts">
import { computed, watch } from "vue";
import ConfigFoldCard from "./ConfigFoldCard.vue";

const props = withDefaults(defineProps<{
  title: string;
  subtitle?: string;
  fileKey: string;
  modelValue: unknown;
  open?: boolean;
  rows?: number;
  readonly?: boolean;
  cancelLabel?: string;
  saveLabel?: string;
  onSave?: (value: unknown, text: string) => Promise<void> | void;
}>(), {
  rows: 10,
  readonly: false,
  cancelLabel: "取消",
  saveLabel: "保存",
});

const emit = defineEmits<{
  cancel: [];
  save: [value: unknown, text: string];
  parseError: [message: string];
}>();

const state = singletonStateFor(props.fileKey, stableJsonText(props.modelValue));
const dirty = computed(() => state.text !== state.savedText);
const canCommit = computed(() => dirty.value && !state.saving && !props.readonly);

watch(
  () => stableJsonText(props.modelValue),
  (nextText) => {
    if (nextText === state.sourceSignature) {
      return;
    }
    state.sourceSignature = nextText;
    if (!dirty.value) {
      state.text = nextText;
      state.savedText = nextText;
      state.error = "";
    }
  },
);

function cancelEdit() {
  if (!canCommit.value) {
    return;
  }
  state.text = state.savedText;
  state.error = "";
  emit("cancel");
}

async function saveEdit() {
  if (!canCommit.value) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(state.text || "{}");
  } catch (error) {
    state.error = error instanceof Error ? error.message : "JSON 解析失败。";
    emit("parseError", state.error);
    return;
  }
  state.saving = true;
  state.error = "";
  try {
    if (props.onSave) {
      await props.onSave(parsed, state.text);
    }
    state.savedText = stableJsonText(parsed);
    state.text = state.savedText;
    state.sourceSignature = state.savedText;
    emit("save", parsed, state.savedText);
  } catch (error) {
    state.error = error instanceof Error ? error.message : "保存失败。";
    emit("parseError", state.error);
  } finally {
    state.saving = false;
  }
}
</script>

<template>
  <ConfigFoldCard :title="title" :subtitle="subtitle" :open="open || undefined">
    <textarea
      v-model="state.text"
      class="json-config-file-editor-textarea"
      :rows="rows"
      :readonly="readonly"
      spellcheck="false"
    ></textarea>
    <p v-if="state.error" class="json-config-file-editor-error">{{ state.error }}</p>
    <div class="json-config-file-editor-actions">
      <button
        class="tool-button tool-button-ghost"
        type="button"
        :disabled="!canCommit"
        @click="cancelEdit"
      >
        {{ cancelLabel }}
      </button>
      <button
        class="tool-button"
        type="button"
        :disabled="!canCommit"
        @click="saveEdit"
      >
        {{ state.saving ? "保存中" : saveLabel }}
      </button>
    </div>
  </ConfigFoldCard>
</template>

<style scoped>
.json-config-file-editor-textarea {
  width: 100%;
  min-height: 180px;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.55;
}

.json-config-file-editor-error {
  margin: 0;
  color: var(--danger);
  font-size: var(--text-sm);
}

.json-config-file-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
