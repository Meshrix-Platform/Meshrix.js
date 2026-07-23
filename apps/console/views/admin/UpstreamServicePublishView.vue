<script setup lang="ts">
import { ref, reactive } from "vue";
import ConsoleInlineAlert from "../../components/ConsoleInlineAlert.vue";
import PublishServiceListPanel from "./upstream-service-publish/PublishServiceListPanel.vue";
import PublishServiceForm from "./upstream-service-publish/PublishServiceForm.vue";
import PortableServiceImportPanel from "./upstream-service-publish/PortableServiceImportPanel.vue";
import type { PortableUpstreamServiceImport } from "@lico/contracts/upstream-service-publishing";
import type { PublishDescriptorForm } from "./upstream-service-publish/publish-form-model";
import { confirmConsoleAction } from "../../composables/console-browser-effects";
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
  type PublishedServiceSummary,
  type UpstreamServiceDescriptor,
  type UpstreamServiceRuntimeHealth,
} from "../../lib/upstream-service-publish-client";

defineOptions({ name: "UpstreamServicePublishView" });

const loading = ref(false);
const error = ref("");
const status = ref("");
const services = ref<PublishedServiceSummary[]>([]);
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
  referenceType: "",
  referenceValue: "",
  referenceRevision: "",
  referenceUse: "",
  };
}

const form = reactive<PublishDescriptorForm>(emptyForm());

async function refreshServices() {
  loading.value = true;
  error.value = "";
  try {
    const result = await listPublishedServices();
    services.value = result.services || [];
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
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Failed to load service.";
  } finally {
    loading.value = false;
  }
}

function descriptorPayload(): UpstreamServiceDescriptor {
  const excluded = new Set([
    "serviceKey", "operationKey", "method", "path", "risk",
    "requestRepresentationMode", "responseRepresentationMode", "requestMaxBytes", "responseMaxBytes",
    "requestMediaTypes", "responseMediaTypes",
    "referenceType", "referenceValue", "referenceRevision", "referenceUse"
  ]);
  return Object.fromEntries(Object.entries(form).filter(([key, value]) =>
    !excluded.has(key) && value !== undefined && value !== ""
  )) as UpstreamServiceDescriptor;
}

async function publishService() {
  if (!selectedServiceId.value && !form.serviceKey.trim()) {
    error.value = "Service key is required.";
    return;
  }
  if (!form.serviceProtocol) {
    error.value = "Protocol must be selected explicitly.";
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
    status.value = "Service accepted; waiting for server publication.";
    const published = await waitForUpstreamServicePublication(result.serviceId);
    selectedServiceRevision.value = published.service.serviceRevision;
    setRevision.value = published.setRevision;
    status.value = "Service is server-published; checking runtime health.";
    healthResult.value = await checkUpstreamServiceRuntimeHealth(result.serviceId);
    status.value = healthResult.value.ok === true
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
    resetForm();
    status.value = "Service removed.";
    await refreshServices();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Remove failed.";
  } finally {
    loading.value = false;
  }
}

refreshServices();
</script>

<template>
  <section class="upstream-publish-layout">
    <header class="publish-toolbar">
      <button class="table-action" type="button" :disabled="loading" @click="refreshServices">
        {{ loading ? "Loading..." : "Refresh" }}
      </button>
      <button class="table-action" type="button" @click="resetForm">New Service</button>
      <span class="toolbar-count" aria-live="polite"><strong>{{ services.length }}</strong> published services</span>
    </header>

    <ConsoleInlineAlert v-if="error" tone="danger">{{ error }}</ConsoleInlineAlert>
    <ConsoleInlineAlert v-if="status" :tone="healthResult && healthResult.ok !== true ? 'danger' : 'success'">{{ status }}</ConsoleInlineAlert>
    <section v-if="healthResult" class="health-result" aria-live="polite">
      <h2>Runtime health result</h2>
      <pre>{{ JSON.stringify(healthResult, null, 2) }}</pre>
    </section>

    <PortableServiceImportPanel
      :loading="loading"
      @load-draft="loadImportedDraft"
    />

    <main class="publish-grid">
      <PublishServiceListPanel
        :services="services"
        :selected-service-id="selectedServiceId"
        @select="selectService"
      />
      <PublishServiceForm
        :form="form"
        :selected-service-id="selectedServiceId"
        :loading="loading"
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
.publish-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.toolbar-count {
  margin-left: auto;
  font-size: 0.85rem;
  opacity: 0.7;
}
.publish-grid {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 1.5rem;
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

@media (max-width: 900px) {
  .publish-toolbar {
    flex-wrap: wrap;
  }

  .toolbar-count {
    flex-basis: 100%;
    margin-left: 0;
  }

  .publish-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
