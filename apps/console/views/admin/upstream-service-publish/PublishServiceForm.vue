<script setup lang="ts">
import { ref } from "vue";
import JsonConfigFileEditor from "../../../components/JsonConfigFileEditor.vue";
import ConsoleEmptyState from "../../../components/ConsoleEmptyState.vue";
import ConsoleInlineAlert from "../../../components/ConsoleInlineAlert.vue";
import LicoTabs, { type LicoTab } from "../../../components/LicoTabs.vue";
import { descriptorObjectFields, type PublishDescriptorForm } from "./publish-form-model";

defineOptions({ name: "PublishServiceForm" });

const props = withDefaults(defineProps<{
  form: PublishDescriptorForm;
  selectedServiceId?: string;
  loading?: boolean;
}>(), {
  selectedServiceId: "",
  loading: false
});

const emit = defineEmits<{
  publish: [];
  disable: [];
  republish: [];
  remove: [];
}>();

// The descriptor draft is owned by the parent view; this panel edits it in place.
const form = props.form;

const activeTab = ref("basic");
const operationError = ref("");
const referenceError = ref("");
const formTabs: LicoTab[] = [
  { key: "basic", label: "Basic" },
  { key: "operations", label: "Service operations" },
  { key: "references", label: "References" },
  { key: "advanced", label: "Advanced JSON" },
];

function updateTags(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  form.tags = value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function saveObjectField(field: typeof descriptorObjectFields[number], value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object.`);
  }
  form[field] = value as Record<string, unknown>;
}

function addOperation() {
  operationError.value = "";
  const operationKey = form.operationKey?.trim() || "";
  const method = form.method?.trim() || "";
  const path = form.path?.trim() || "";
  const requestMaxBytes = Number(form.requestMaxBytes);
  const responseMaxBytes = Number(form.responseMaxBytes);
  const requestMediaTypes = String(form.requestMediaTypes || "").split(",").map((value) => value.trim()).filter(Boolean);
  const responseMediaTypes = String(form.responseMediaTypes || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!operationKey || !method || !path || !form.requestRepresentationMode || !form.responseRepresentationMode) {
    operationError.value = "Complete all required operation fields.";
    return;
  }
  if (!Number.isSafeInteger(requestMaxBytes) || requestMaxBytes < 1 || !Number.isSafeInteger(responseMaxBytes) || responseMaxBytes < 1) {
    operationError.value = "Request and response byte limits must be positive whole numbers.";
    return;
  }
  if (requestMediaTypes.length === 0 || responseMediaTypes.length === 0) {
    operationError.value = "Add at least one request and response media type.";
    return;
  }
  if (
    form.serviceProtocol === "json-rpc" &&
    (form.requestRepresentationMode !== "structured_json" || form.responseRepresentationMode !== "structured_json")
  ) {
    operationError.value = "JSON-RPC operations require Structured JSON for both request and response.";
    return;
  }
  if (form.operations?.some((operation) => operation.operationKey === operationKey)) {
    operationError.value = "Operation keys must be unique within a service.";
    return;
  }
  (form.operations ||= []).push({
    operationKey,
    method,
    path,
    ...(form.risk ? { risk: form.risk } : {}),
    payloadTransport: {
      request: {
        mode: form.requestRepresentationMode,
        maxBytes: requestMaxBytes,
        mediaTypes: requestMediaTypes,
      },
      response: {
        mode: form.responseRepresentationMode,
        maxBytes: responseMaxBytes,
        mediaTypes: responseMediaTypes,
      },
    },
  });
  form.operationKey = "";
  form.method = "";
  form.path = "";
  form.risk = "";
  form.requestRepresentationMode = "";
  form.responseRepresentationMode = "";
  form.requestMaxBytes = "";
  form.responseMaxBytes = "";
  form.requestMediaTypes = "";
  form.responseMediaTypes = "";
}

function removeOperation(index: number) {
  form.operations?.splice(index, 1);
}

function addReference() {
  referenceError.value = "";
  const revision = Number(form.referenceRevision);
  if (!form.referenceType || !form.referenceValue?.trim() || !form.referenceUse?.trim()) {
    referenceError.value = "Complete all required reference fields.";
    return;
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    referenceError.value = "Reference revision must be a positive whole number.";
    return;
  }
  (form.references ||= []).push({
    type: form.referenceType,
    reference: form.referenceValue.trim(),
    revision,
    use: form.referenceUse.trim()
  });
  form.referenceType = "";
  form.referenceValue = "";
  form.referenceRevision = "";
  form.referenceUse = "";
}

function removeReference(index: number) {
  form.references?.splice(index, 1);
}
</script>

<template>
  <section class="publish-form">
    <LicoTabs v-model="activeTab" :tabs="formTabs" size="small" aria-label="Service editor sections" />

    <div v-if="activeTab === 'basic'" class="tab-content" role="tabpanel" aria-label="Basic service settings">
      <label class="form-field">
        <span>Service key *</span>
        <input v-model="form.serviceKey" type="text" placeholder="my-service" :disabled="!!selectedServiceId" />
      </label>
      <label class="form-field">
        <span>Label</span>
        <input v-model="form.label" type="text" placeholder="My Service" />
      </label>
      <label class="form-field">
        <span>Description</span>
        <input v-model="form.description" type="text" placeholder="Service description" />
      </label>
      <label class="form-field">
        <span>Protocol</span>
        <select v-model="form.serviceProtocol">
          <option value="">Select protocol</option>
          <option value="http">HTTP</option>
          <option value="json-rpc">JSON-RPC</option>
        </select>
      </label>
      <label class="form-field">
        <span>Base URL *</span>
        <input v-model="form.baseUrl" type="text" placeholder="http://127.0.0.1:8080" />
      </label>
      <label class="form-field">
        <span>Visibility</span>
        <input v-model="form.visibility" type="text" placeholder="Leave empty when not configured" />
      </label>
      <label class="form-field">
        <span>Data class</span>
        <input v-model="form.dataClass" type="text" placeholder="Leave empty when not configured" />
      </label>
      <label class="form-field">
        <span>Tags</span>
        <input :value="form.tags?.join(', ') || ''" type="text" placeholder="Comma-separated tags" @input="updateTags" />
      </label>
    </div>

    <div v-if="activeTab === 'operations'" class="tab-content" role="tabpanel" aria-label="Service operations">
      <p class="form-help">Manual setup covers JSON and native stream payloads. Use service JSON import for artifact payload mappings.</p>
      <div class="operation-builder">
        <div class="field-grid">
          <label class="form-field">
            <span>Operation key *</span>
            <input v-model="form.operationKey" type="text" placeholder="list-items" />
          </label>
          <label class="form-field">
            <span>Method *</span>
            <select v-model="form.method">
              <option value="">Select method</option>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select>
          </label>
          <label class="form-field">
            <span>Path *</span>
            <input v-model="form.path" type="text" placeholder="/api/path" />
          </label>
          <label class="form-field">
            <span>Risk</span>
            <select v-model="form.risk">
              <option value="">Not configured</option>
              <option value="read_only">Read only</option>
              <option value="safe_write">Safe write</option>
              <option value="repair_write">Repair write</option>
              <option value="destructive">Destructive</option>
            </select>
          </label>
        </div>
        <div class="transport-grid">
          <fieldset>
            <legend>Request</legend>
            <label class="form-field">
              <span>Representation *</span>
              <select v-model="form.requestRepresentationMode">
                <option value="">Select representation</option>
                <option value="structured_json">Structured JSON</option>
                <option value="opaque_stream">Native stream</option>
              </select>
            </label>
            <label class="form-field">
              <span>Maximum bytes *</span>
              <input v-model.number="form.requestMaxBytes" type="number" min="1" placeholder="1048576" />
            </label>
            <label class="form-field">
              <span>Media types *</span>
              <input v-model="form.requestMediaTypes" type="text" placeholder="application/json" />
            </label>
          </fieldset>
          <fieldset>
            <legend>Response</legend>
            <label class="form-field">
              <span>Representation *</span>
              <select v-model="form.responseRepresentationMode">
                <option value="">Select representation</option>
                <option value="structured_json">Structured JSON</option>
                <option value="opaque_stream">Native stream</option>
              </select>
            </label>
            <label class="form-field">
              <span>Maximum bytes *</span>
              <input v-model.number="form.responseMaxBytes" type="number" min="1" placeholder="1048576" />
            </label>
            <label class="form-field">
              <span>Media types *</span>
              <input v-model="form.responseMediaTypes" type="text" placeholder="application/json" />
            </label>
          </fieldset>
        </div>
        <ConsoleInlineAlert v-if="operationError" tone="danger">{{ operationError }}</ConsoleInlineAlert>
        <div class="builder-actions">
          <button type="button" class="table-action" @click="addOperation">Add operation</button>
        </div>
      </div>
      <ul class="op-list">
        <li v-for="(op, i) in form.operations" :key="op.operationKey">
          <span class="operation-name"><strong>{{ op.operationKey }}</strong><span>{{ op.method }} {{ op.path }}</span></span>
          <small v-if="op.risk">{{ op.risk }}</small>
          <small>{{ op.payloadTransport.request.mode }} → {{ op.payloadTransport.response.mode }}</small>
          <button type="button" class="inline-remove" @click="removeOperation(i)">Remove<span class="visually-hidden"> {{ op.operationKey }}</span></button>
        </li>
        <ConsoleEmptyState v-if="!form.operations?.length" as="li" compact title="No operations defined." />
      </ul>
    </div>

    <div v-if="activeTab === 'references'" class="tab-content" role="tabpanel" aria-label="Service references">
      <p class="form-help">Reference URIs point to governed credentials. Do not paste secret values.</p>
      <div class="reference-builder">
        <div class="field-grid">
          <label class="form-field">
            <span>Reference type *</span>
            <select v-model="form.referenceType">
              <option value="">Select type</option>
              <option value="credential">Credential</option>
              <option value="certificate">Certificate</option>
              <option value="private-key">Private key</option>
              <option value="trust-anchor">Trust anchor</option>
            </select>
          </label>
          <label class="form-field">
            <span>Reference URI *</span>
            <input v-model="form.referenceValue" type="text" placeholder="credential://vault/service" />
          </label>
          <label class="form-field">
            <span>Reference revision *</span>
            <input v-model.number="form.referenceRevision" type="number" min="1" placeholder="1" />
          </label>
          <label class="form-field">
            <span>Reference use *</span>
            <input v-model="form.referenceUse" type="text" placeholder="request-auth" />
          </label>
        </div>
        <ConsoleInlineAlert v-if="referenceError" tone="danger">{{ referenceError }}</ConsoleInlineAlert>
        <div class="builder-actions">
          <button type="button" class="table-action" @click="addReference">Add reference</button>
        </div>
      </div>
      <ul class="op-list">
        <li v-for="(reference, i) in form.references" :key="`${reference.type}:${reference.reference}:${reference.revision}`">
          <strong>{{ reference.type }}</strong> {{ reference.reference }} (r{{ reference.revision }})
          <button type="button" class="inline-remove" @click="removeReference(i)">Remove<span class="visually-hidden"> {{ reference.reference }}</span></button>
        </li>
        <ConsoleEmptyState v-if="!form.references?.length" as="li" compact title="No references defined." />
      </ul>
    </div>

    <div v-if="activeTab === 'advanced'" class="tab-content advanced-config-grid" role="tabpanel" aria-label="Advanced service JSON">
      <JsonConfigFileEditor
        v-for="field in descriptorObjectFields"
        :key="`${selectedServiceId || 'new'}:${field}`"
        :title="field"
        subtitle="Optional explicit configuration; an empty editor does not create a default."
        :file-key="`upstream-publishing:${selectedServiceId || 'new'}:${field}`"
        :model-value="form[field] || {}"
        :rows="6"
        save-label="Apply"
        @save="(value) => saveObjectField(field, value)"
      />
    </div>

    <div class="form-actions">
      <button class="table-action primary" type="button" :disabled="loading || (!selectedServiceId && !form.serviceKey)" @click="emit('publish')">
        {{ selectedServiceId ? 'Update' : 'Publish' }}
      </button>
      <button v-if="selectedServiceId" class="table-action" type="button" :disabled="loading" @click="emit('disable')">Disable</button>
      <button v-if="selectedServiceId" class="table-action" type="button" :disabled="loading" @click="emit('republish')">Republish</button>
      <button v-if="selectedServiceId" class="table-action danger" type="button" :disabled="loading" @click="emit('remove')">Remove</button>
    </div>
  </section>
</template>

<style scoped>
.publish-form {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  overflow-y: auto;
}
.tab-content {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.form-help {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.form-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
}
.form-field input,
.form-field select {
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 0.85rem;
}
.operation-builder,
.reference-builder {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-subtle);
}
.field-grid,
.transport-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}
.transport-grid fieldset {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  min-width: 0;
  margin: 0;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
}
.transport-grid legend {
  padding: 0 0.3rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.builder-actions {
  display: flex;
  justify-content: flex-end;
}
.op-list {
  list-style: none;
  padding: 0;
  margin: 0;
  font-size: 0.85rem;
}
.op-list li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.55rem 0;
  border-bottom: 1px solid var(--border);
}
.operation-name {
  display: flex;
  flex-direction: column;
  min-width: 9rem;
}
.inline-remove {
  margin-left: auto;
  border: 1px solid var(--danger);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  color: var(--danger);
  font-size: 0.78rem;
  padding: 0.2rem 0.45rem;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.form-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: auto;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}
.table-action.primary {
  background: var(--primary);
  color: white;
  border-color: var(--primary);
}
.table-action.danger {
  color: var(--danger);
  border-color: var(--danger);
}
@media (max-width: 760px) {
  .field-grid,
  .transport-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
