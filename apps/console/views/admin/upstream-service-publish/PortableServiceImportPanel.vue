<script setup lang="ts">
import { ref } from "vue";
import ConsoleInlineAlert from "../../../components/ConsoleInlineAlert.vue";
import ConfigFoldCard from "../../../components/ConfigFoldCard.vue";
import {
  PORTABLE_UPSTREAM_SERVICE_KIND,
  PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION,
  parsePortableUpstreamServiceImport,
  type PortableUpstreamServiceImport,
} from "@lico/contracts/upstream-service-publishing";

defineOptions({ name: "PortableServiceImportPanel" });

withDefaults(defineProps<{ loading?: boolean }>(), { loading: false });

const emit = defineEmits<{
  loadDraft: [document: PortableUpstreamServiceImport];
}>();

const text = ref("");
const error = ref("");
const sourceName = ref("");
const portableDocumentPlaceholder =
  `{"kind":"${PORTABLE_UPSTREAM_SERVICE_KIND}",` +
  `"schemaVersion":"${PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION}",` +
  '"serviceKey":"inventory","descriptor":{...}}';

async function selectFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  sourceName.value = file.name;
  error.value = "";
  try {
    text.value = await file.text();
  } catch (readError) {
    error.value = readError instanceof Error ? readError.message : "Could not read the selected file.";
  } finally {
    input.value = "";
  }
}

function loadDraft() {
  error.value = "";
  try {
    const document = parsePortableUpstreamServiceImport(text.value);
    emit("loadDraft", document);
  } catch (parseError) {
    error.value = parseError instanceof Error ? parseError.message : "Import validation failed.";
  }
}
</script>

<template>
  <ConfigFoldCard class="portable-import-panel" title="Import service JSON" subtitle="Loads a draft only">
    <div class="import-intro">
      <p>Paste or choose a portable service document, then load it into the editable draft for review.</p>
      <label class="table-action file-picker">
        Choose JSON file
        <input type="file" accept="application/json,.json" :disabled="loading" @change="selectFile" />
      </label>
    </div>
    <p v-if="sourceName" class="source-name"><span>Loaded file:</span> <code>{{ sourceName }}</code></p>
    <textarea
      v-model="text"
      rows="8"
      spellcheck="false"
      :placeholder="portableDocumentPlaceholder"
      aria-label="Complete upstream service JSON"
    ></textarea>
    <ConsoleInlineAlert v-if="error" tone="danger">{{ error }}</ConsoleInlineAlert>
    <footer>
      <button class="table-action" type="button" :disabled="loading || !text.trim()" @click="loadDraft">
        Load draft
      </button>
    </footer>
  </ConfigFoldCard>
</template>

<style scoped>
.import-intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.portable-import-panel p { margin: 0; }
.portable-import-panel p,
.source-name { font-size: 0.8rem; opacity: 0.75; }
.source-name code { font-family: var(--font-mono); }
.portable-import-panel textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: 0.8rem;
}
.file-picker { cursor: pointer; white-space: nowrap; }
.file-picker input { display: none; }
.portable-import-panel footer { justify-content: flex-end; }
@media (max-width: 700px) {
  .import-intro { align-items: flex-start; flex-direction: column; }
}
</style>
