<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import ConsoleInlineAlert from "../../components/ConsoleInlineAlert.vue";
import PublishServiceForm from "./upstream-service-publish/PublishServiceForm.vue";
import PortableServiceImportPanel from "./upstream-service-publish/PortableServiceImportPanel.vue";
import {
  UPSTREAM_SERVICE_DESCRIPTOR_FIELDS,
  type PortableUpstreamServiceImport,
} from "@meshrix/contracts/upstream-service-publishing";
import type { PublishDescriptorForm } from "./upstream-service-publish/publish-form-model";
import { confirmConsoleAction } from "../../composables/console-browser-effects";
import {
  readBrowserLocalStorageItem,
  removeBrowserLocalStorageItem,
  writeBrowserLocalStorageItem,
} from "../../lib/browser-window";
import {
  createUpstreamService,
  replaceUpstreamService,
  disableUpstreamService,
  republishUpstreamService,
  removeUpstreamService,
  listPublishedServices,
  getPublishedService,
  waitForUpstreamServicePublication,
  checkUpstreamServiceRuntimeHealth,
  type UpstreamServiceDescriptor,
  type UpstreamServiceRuntimeHealth,
} from "../../lib/upstream-service-publish-client";

defineOptions({ name: "UpstreamServicePublishView" });

const LOCAL_DRAFT_KEY = "meshrix.console.upstream-service-publish-draft";
const LOCAL_DRAFT_SCHEMA_VERSION = "v0.0.1:console:upstream-service-publish-draft-1";
const LOCAL_DRAFT_MAX_BYTES = 256 * 1024;
const formEditorFields = [
  "serviceKey", "operationKey", "method", "path", "risk",
  "requestRepresentationMode", "responseRepresentationMode", "requestMaxBytes", "responseMaxBytes",
  "requestMediaTypes", "responseMediaTypes",
  "credentialMode", "credentialSelection", "savedCredentialOptions",
] as const;
const localDraftFields = [...new Set([...UPSTREAM_SERVICE_DESCRIPTOR_FIELDS, ...formEditorFields])];

const route = useRoute();
const loading = ref(false);
const error = ref("");
const status = ref("");
const setRevision = ref(0);
const selectedServiceId = ref("");
const selectedServiceRevision = ref(0);
const healthResult = ref<UpstreamServiceRuntimeHealth | null>(null);

function emptyForm(): PublishDescriptorForm {
  return {
  serviceKey: "",
  label: "",
  description: "",
  serviceProtocol: "",
  baseUrl: "",
  operations: [],
  references: [],
  operationKey: "",
  method: "",
  path: "",
  risk: "",
  requestRepresentationMode: "",
  responseRepresentationMode: "",
  requestMaxBytes: "",
  responseMaxBytes: "",
  requestMediaTypes: "",
  responseMediaTypes: "",
  credentialMode: "none",
  credentialSelection: "",
  savedCredentialOptions: [],
  };
}

const form = reactive<PublishDescriptorForm>(emptyForm());

function isSafeDraftValue(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_000 && value.every((entry: unknown) => isSafeDraftValue(entry, depth + 1));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length <= 1_000 && keys.every((key: string) =>
    !["__proto__", "prototype", "constructor"].includes(key) && isSafeDraftValue(record[key], depth + 1)
  );
}

function localDraftFormSnapshot(): Record<string, unknown> {
  return Object.fromEntries(localDraftFields
    .filter((field: string) => Object.prototype.hasOwnProperty.call(form, field))
    .map((field: string) => [field, (form as Record<string, unknown>)[field]]));
}

function readLocalDraft(): { serviceId: string; form: Record<string, unknown> } | null {
  const serialized = readBrowserLocalStorageItem(LOCAL_DRAFT_KEY);
  if (!serialized) return null;
  if (serialized.length > LOCAL_DRAFT_MAX_BYTES) throw new Error("Saved browser draft is too large.");
  const draft = JSON.parse(serialized) as Record<string, unknown>;
  if (
    draft.schemaVersion !== LOCAL_DRAFT_SCHEMA_VERSION ||
    typeof draft.serviceId !== "string" ||
    !draft.form || typeof draft.form !== "object" || Array.isArray(draft.form) ||
    !isSafeDraftValue(draft.form)
  ) {
    throw new Error("Saved browser draft has an invalid format.");
  }
  const storedForm = draft.form as Record<string, unknown>;
  return {
    serviceId: draft.serviceId,
    form: Object.fromEntries(localDraftFields
      .filter((field: string) => Object.prototype.hasOwnProperty.call(storedForm, field))
      .map((field: string) => [field, storedForm[field]])),
  };
}

function clearLocalDraft() {
  removeBrowserLocalStorageItem(LOCAL_DRAFT_KEY);
}

function saveLocalDraft() {
  error.value = "";
  try {
    const serialized = JSON.stringify({
      schemaVersion: LOCAL_DRAFT_SCHEMA_VERSION,
      serviceId: selectedServiceId.value,
      form: localDraftFormSnapshot(),
    });
    if (serialized.length > LOCAL_DRAFT_MAX_BYTES) {
      throw new Error("The form is too large to save in this browser.");
    }
    if (!writeBrowserLocalStorageItem(LOCAL_DRAFT_KEY, serialized)) {
      throw new Error("Browser storage is unavailable.");
    }
    status.value = "Draft saved in this browser.";
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Failed to save the browser draft.";
  }
}

async function refreshServices() {
  loading.value = true;
  error.value = "";
  try {
    const result = await listPublishedServices();
    setRevision.value = result.setRevision;
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Failed to list services.";
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  for (const key of Object.keys(form) as Array<keyof PublishDescriptorForm>) delete form[key];
  Object.assign(form, emptyForm());
  selectedServiceId.value = "";
  selectedServiceRevision.value = 0;
  healthResult.value = null;
  error.value = "";
  status.value = "";
}

function loadImportedDraft(document: PortableUpstreamServiceImport) {
  resetForm();
  form.serviceKey = document.serviceKey;
  Object.assign(form, document.descriptor);
  form.operations = [...(document.descriptor.operations || [])];
  form.references = [...(document.descriptor.references || [])];
  form.savedCredentialOptions = [...form.references];
  form.credentialMode = form.references.length ? "saved" : "none";
  form.credentialSelection = form.references.length ? "0" : "";
  status.value = "Draft loaded. Review it, then select Publish.";
}

async function selectService(serviceId: string) {
  loading.value = true;
  error.value = "";
  try {
    const result = await getPublishedService(serviceId);
    resetForm();
    selectedServiceId.value = serviceId;
    selectedServiceRevision.value = result.service.serviceRevision;
    setRevision.value = result.setRevision;
    Object.assign(form, result.service.descriptor || {});
    form.references = [...result.service.references];
    form.savedCredentialOptions = [...form.references];
    form.credentialMode = form.references.length ? "saved" : "none";
    form.credentialSelection = form.references.length ? "0" : "";
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Failed to load service.";
  } finally {
    loading.value = false;
  }
}

function applyLocalDraftForm(draftForm: Record<string, unknown>) {
  const hasCredentialEditorState = Object.prototype.hasOwnProperty.call(draftForm, "credentialMode") ||
    Object.prototype.hasOwnProperty.call(draftForm, "savedCredentialOptions");
  Object.assign(form, draftForm);
  if (!hasCredentialEditorState) {
    form.savedCredentialOptions = [...(form.references || [])];
    form.credentialMode = form.references?.length ? "saved" : "none";
    form.credentialSelection = form.references?.length ? "0" : "";
  }
}

async function restoreLocalDraft(draft: { serviceId: string; form: Record<string, unknown> }) {
  if (draft.serviceId) {
    await selectService(draft.serviceId);
    if (selectedServiceId.value !== draft.serviceId) return;
  } else {
    resetForm();
  }
  applyLocalDraftForm(draft.form);
  status.value = "Draft restored from this browser.";
}

function descriptorPayload(): UpstreamServiceDescriptor {
  const excluded = new Set([
    "serviceKey", "operationKey", "method", "path", "risk",
    "requestRepresentationMode", "responseRepresentationMode", "requestMaxBytes", "responseMaxBytes",
    "requestMediaTypes", "responseMediaTypes",
    "credentialMode", "credentialSelection", "savedCredentialOptions"
  ]);
  return Object.fromEntries(Object.entries(form).filter(([key, value]: readonly any[]) =>
    !excluded.has(key) && value !== undefined && value !== ""
  )) as unknown as UpstreamServiceDescriptor;
}

async function publishService() {
  if (!selectedServiceId.value && !form.serviceKey.trim()) {
    error.value = "Service identifier is required.";
    return;
  }
  if (!form.serviceProtocol) {
    error.value = "Protocol must be selected explicitly.";
    return;
  }
  if (form.credentialMode === "saved" && !form.references?.length) {
    error.value = "Select a saved credential before publishing, or choose no authentication.";
    return;
  }
  loading.value = true;
  error.value = "";
  status.value = "";
  try {
    let result;
    if (selectedServiceId.value) {
      result = await replaceUpstreamService(
        selectedServiceId.value,
        descriptorPayload(),
        selectedServiceRevision.value,
        setRevision.value
      );
    } else {
      result = await createUpstreamService(form.serviceKey.trim(), descriptorPayload(), setRevision.value);
    }
    selectedServiceId.value = result.serviceId;
    selectedServiceRevision.value = result.serviceRevision;
    setRevision.value = result.setRevision;
    clearLocalDraft();
    status.value = "Service accepted; waiting for server publication.";
    const published = await waitForUpstreamServicePublication(result.serviceId);
    selectedServiceRevision.value = published.service.serviceRevision;
    setRevision.value = published.setRevision;
    status.value = "Service is server-published; checking runtime health.";
    healthResult.value = await checkUpstreamServiceRuntimeHealth(result.serviceId);
    status.value = healthResult.value?.ok === true
      ? "Service is server-published and runtime health passed."
      : "Service is server-published, but runtime health did not pass.";
    await refreshServices();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Publishing failed.";
  } finally {
    loading.value = false;
  }
}

async function disableSelected() {
  if (!selectedServiceId.value) return;
  loading.value = true;
  error.value = "";
  try {
    await disableUpstreamService(selectedServiceId.value, selectedServiceRevision.value, setRevision.value);
    status.value = "Service disabled.";
    await refreshServices();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Disable failed.";
  } finally {
    loading.value = false;
  }
}

async function republishSelected() {
  if (!selectedServiceId.value) return;
  loading.value = true;
  error.value = "";
  try {
    await republishUpstreamService(selectedServiceId.value, selectedServiceRevision.value, setRevision.value);
    status.value = "Service accepted for republishing.";
    await refreshServices();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Republish failed.";
  } finally {
    loading.value = false;
  }
}

async function removeSelected() {
  if (!selectedServiceId.value) return;
  if (!(await confirmConsoleAction(`Delete "${selectedServiceId.value}"?`, {
    title: "Confirm removal",
    tone: "danger",
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
  }))) return;
  loading.value = true;
  error.value = "";
  try {
    await removeUpstreamService(selectedServiceId.value, selectedServiceRevision.value, setRevision.value);
    clearLocalDraft();
    resetForm();
    status.value = "Service removed.";
    await refreshServices();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Remove failed.";
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await refreshServices();
  const serviceId = String(route.query.serviceId || "").trim();
  let draft: ReturnType<typeof readLocalDraft> = null;
  try {
    draft = readLocalDraft();
  } catch (e: unknown) {
    clearLocalDraft();
    error.value = e instanceof Error ? e.message : "Saved browser draft could not be restored.";
  }
  if (serviceId) {
    await selectService(serviceId);
    if (draft?.serviceId === serviceId && selectedServiceId.value === serviceId) {
      applyLocalDraftForm(draft.form);
      status.value = "Draft restored from this browser.";
    }
    return;
  }
  if (draft) await restoreLocalDraft(draft);
});

usePageRefreshHandler(
  (detail: any) => detail.viewId === "admin" && detail.adminView === "upstreamServicePublish",
  refreshServices,
);
</script>

<template>
  <section class="upstream-publish-layout">
    <ConsoleInlineAlert v-if="error" tone="danger">{{ error }}</ConsoleInlineAlert>
    <ConsoleInlineAlert v-if="status" :tone="healthResult && healthResult.ok !== true ? 'danger' : 'success'">{{ status }}</ConsoleInlineAlert>
    <section v-if="healthResult" class="health-result" aria-live="polite">
      <h2>运行时健康检查结果</h2>
      <pre>{{ JSON.stringify(healthResult, null, 2) }}</pre>
    </section>

    <PortableServiceImportPanel
      :loading="loading"
      @load-draft="loadImportedDraft"
    />

    <main class="publish-grid">
      <PublishServiceForm
        :form="form"
        :selected-service-id="selectedServiceId"
        :loading="loading"
        @save="saveLocalDraft"
        @publish="publishService"
        @disable="disableSelected"
        @republish="republishSelected"
        @remove="removeSelected"
      />
    </main>
  </section>
</template>

<style scoped>
.upstream-publish-layout {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  height: 100%;
}
.publish-grid {
  flex: 1;
  min-height: 0;
}

.publish-grid > * {
  min-width: 0;
}
.health-result {
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.health-result h2 { margin: 0 0 0.5rem; font-size: 0.95rem; }
.health-result pre { margin: 0; overflow-x: auto; font-size: 0.8rem; }

</style>
