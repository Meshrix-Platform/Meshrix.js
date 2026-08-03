<script setup lang="ts">
import { ref } from "vue";
import ConsoleInlineAlert from "../../../components/ConsoleInlineAlert.vue";
import ConfigFoldCard from "../../../components/ConfigFoldCard.vue";
import { triggerBrowserDownload } from "../../../lib/browser-downloads";
import {
  PORTABLE_UPSTREAM_SERVICE_KIND,
  PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION,
  parsePortableUpstreamServiceImport,
  type PortableUpstreamServiceImport,
} from "@meshrix/contracts/upstream-service-publishing";

defineOptions({ name: "PortableServiceImportPanel" });

withDefaults(defineProps<{ loading?: boolean }>(), { loading: false });

const emit = defineEmits<{
  loadDraft: [document: PortableUpstreamServiceImport];
}>();

const text = ref("");
const error = ref("");
const validationStatus = ref("");
const validatedText = ref("");
const validatedDocument = ref<PortableUpstreamServiceImport | null>(null);
const sourceName = ref("");
const portableDocumentPlaceholder =
  `{"kind":"${PORTABLE_UPSTREAM_SERVICE_KIND}",` +
  `"schemaVersion":"${PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION}",` +
  '"serviceKey":"inventory","descriptor":{...}}';
const portableDocumentTemplate: PortableUpstreamServiceImport = {
  kind: PORTABLE_UPSTREAM_SERVICE_KIND,
  schemaVersion: PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION,
  serviceKey: "replace-with-service-key",
  descriptor: {
    serviceProtocol: "http",
    baseUrl: "https://service.example:443",
    operations: [{
      operationKey: "replace-with-operation-key",
      method: "GET",
      path: "/replace-with-path",
      payloadTransport: {
        request: {
          mode: "structured_json",
          maxBytes: 1_048_576,
          mediaTypes: ["application/json"],
        },
        response: {
          mode: "structured_json",
          maxBytes: 1_048_576,
          mediaTypes: ["application/json"],
        },
      },
    }],
  },
};

function downloadTemplate() {
  const contents = `${JSON.stringify(portableDocumentTemplate, null, 2)}\n`;
  triggerBrowserDownload(
    new Blob([contents], { type: "application/json;charset=utf-8" }),
    "meshrix-upstream-service-template.json",
  );
}

async function selectFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  sourceName.value = file.name;
  invalidateValidation();
  try {
    text.value = await file.text();
  } catch (readError) {
    error.value = readError instanceof Error ? readError.message : "Could not read the selected file.";
  } finally {
    input.value = "";
  }
}

function invalidateValidation() {
  error.value = "";
  validationStatus.value = "";
  validatedText.value = "";
  validatedDocument.value = null;
}

function validateDocument() {
  invalidateValidation();
  try {
    validatedDocument.value = parsePortableUpstreamServiceImport(text.value);
    validatedText.value = text.value;
    validationStatus.value = "Configuration format is valid.";
  } catch (parseError) {
    error.value = parseError instanceof Error ? parseError.message : "Import validation failed.";
  }
}

function loadDraft() {
  if (!validatedDocument.value || validatedText.value !== text.value) return;
  emit("loadDraft", validatedDocument.value);
}
</script>

<template>
  <ConfigFoldCard class="portable-import-panel" title="Import service JSON" subtitle="Loads a draft only">
    <div class="import-intro">
      <p>Paste or choose a portable service document, then load it into the editable draft for review.</p>
      <div class="import-source-actions">
        <button
          class="table-action"
          type="button"
          data-action="download-service-json-template"
          :disabled="loading"
          @click="downloadTemplate"
        >
          Download JSON template
        </button>
        <label class="table-action file-picker">
          Choose JSON file
          <input type="file" accept="application/json,.json" :disabled="loading" @change="selectFile" />
        </label>
      </div>
    </div>
    <p v-if="sourceName" class="source-name"><span>Loaded file:</span> <code>{{ sourceName }}</code></p>
    <textarea
      v-model="text"
      rows="8"
      spellcheck="false"
      :placeholder="portableDocumentPlaceholder"
      aria-label="Complete upstream service JSON"
      @input="invalidateValidation"
    ></textarea>
    <ConsoleInlineAlert v-if="error" tone="danger">{{ error }}</ConsoleInlineAlert>
    <ConsoleInlineAlert v-else-if="validationStatus" tone="success">{{ validationStatus }}</ConsoleInlineAlert>
    <footer class="portable-import-actions">
      <button
        class="table-action"
        type="button"
        data-action="validate-service-json"
        :disabled="loading || !text.trim()"
        @click="validateDocument"
      >
        Validate
      </button>
      <button
        class="table-action"
        type="button"
        data-action="load-service-draft"
        :disabled="loading || !validatedDocument || validatedText !== text"
        @click="loadDraft"
      >
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
.import-source-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  white-space: nowrap;
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
.portable-import-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
@media (max-width: 700px) {
  .import-intro { align-items: flex-start; flex-direction: column; }
  .import-source-actions { flex-wrap: wrap; }
}
</style>
