<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, resolveComponent, watch } from "vue";
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import ConsoleEmptyState from "../../components/ConsoleEmptyState.vue";
import ConsoleInlineAlert from "../../components/ConsoleInlineAlert.vue";
import PublishServiceForm from "./upstream-service-publish/PublishServiceForm.vue";
import PortableServiceImportPanel from "./upstream-service-publish/PortableServiceImportPanel.vue";
import {
  UPSTREAM_SERVICE_DESCRIPTOR_FIELDS,
  type PortableUpstreamServiceImport,
} from "@meshrix/contracts/upstream-service-publishing";
import type { PublishDescriptorForm } from "./upstream-service-publish/publish-form-model";
import { scrollElementIntoViewById } from "../../composables/console-browser-effects";
import { requestDestructiveConfirm } from "../../composables/console-destructive-operation-registry";
import { createPublishOutcomeModel } from "../../composables/console-publish-outcome-model";
import {
  PUBLISH_DRAFT_STORAGE_KEY,
  createPublishDraftAutosave,
  readPublishDraft,
  removePublishDraft,
  writePublishDraft,
} from "../../composables/console-publish-draft-autosave";
import { useConsoleUrlState } from "../../composables/use-console-url-state";
import { consoleMessages, currentConsoleLocale } from "../../i18n/console";
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

const STABLE_DRAFT_ID_KEY = `${PUBLISH_DRAFT_STORAGE_KEY}:new-draft-id`;
const formEditorFields = [
  "serviceKey", "operationKey", "method", "path", "risk",
  "requestRepresentationMode", "responseRepresentationMode", "requestMaxBytes", "responseMaxBytes",
  "requestMediaTypes", "responseMediaTypes",
  "credentialMode", "credentialSelection", "savedCredentialOptions",
] as const;
const localDraftFields = [...new Set([...UPSTREAM_SERVICE_DESCRIPTOR_FIELDS, ...formEditorFields])];

const loading = ref(false);
const error = ref("");
const status = ref("");
const publishFormRef = ref<InstanceType<typeof PublishServiceForm> | null>(null);
const setRevision = ref(0);
// The selection is URL-held (REQ-008): ?serviceId= deep links resolve through
// the same load path as list clicks, and defaults stay out of the URL.
const selectedServiceId = useConsoleUrlState("serviceId", "");
const selectedServiceRevision = ref(0);
const healthResult = ref<UpstreamServiceRuntimeHealth | null>(null);
const publishedServices = ref<PublishedServiceSummary[]>([]);
const publishListMessages = computed(() => consoleMessages[currentConsoleLocale.value].publishList);
// REQ-017 outcome model: staged progress + interpreted health; the done state
// and selected serviceId are the frozen handoff to N17's success next steps.
const outcome = createPublishOutcomeModel({ serviceId: () => selectedServiceId.value });
const outcomeMessages = computed(() => consoleMessages[currentConsoleLocale.value].publishOutcome);
const journeyMessages = computed(() => consoleMessages[currentConsoleLocale.value].journey);
// Resolved through the app registry instead of a module import: consumers that
// stub vue-router (tests) keep rendering without the links.
const RouterLink: any = resolveComponent("RouterLink");
const healthStatusLabelKeys: Record<string, string> = {
  pass: "statusPass",
  warn: "statusWarn",
  fail: "statusFail",
};

function remediationLabelKey(route: string): string {
  if (route === "/admin/upstream-services") return "remediateGatewayDetail";
  if (route === "/admin/logs") return "remediateLogs";
  return "remediatePublish";
}

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

function localDraftFormSnapshot(): Record<string, unknown> {
  return Object.fromEntries(localDraftFields
    .filter((field: string) => Object.prototype.hasOwnProperty.call(form, field))
    .map((field: string) => [field, (form as Record<string, unknown>)[field]]));
}

function filterDraftFields(storedForm: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(localDraftFields
    .filter((field: string) => Object.prototype.hasOwnProperty.call(storedForm, field))
    .map((field: string) => [field, storedForm[field]]));
}

// --- per-service draft autosave (REQ-016) ---
// The new-service draft key uses a stable draft id generated once per
// browser session (sessionStorage, NOT the URL) so a draft survives reload
// and cross-service edits never overwrite each other.
function readStableDraftId(): string {
  try {
    const existing = window.sessionStorage.getItem(STABLE_DRAFT_ID_KEY);
    if (existing) return existing;
    const fresh = `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(STABLE_DRAFT_ID_KEY, fresh);
    return fresh;
  } catch {
    return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

const stableDraftId = ref(readStableDraftId());
const lastDraftSnapshot = ref("");
const publishDraftMessages = computed(() => consoleMessages[currentConsoleLocale.value].publishDraft);

function draftStorageKey(): string {
  return `${PUBLISH_DRAFT_STORAGE_KEY}:${selectedServiceId.value || `new:${stableDraftId.value}`}`;
}

function currentDraftSnapshot(): string {
  return JSON.stringify({ key: draftStorageKey(), form: localDraftFormSnapshot() });
}

function markDraftClean(): void {
  lastDraftSnapshot.value = currentDraftSnapshot();
}

const draftAutosave = createPublishDraftAutosave({
  draftKey: draftStorageKey,
  serialize: localDraftFormSnapshot,
  restore: (draftForm: Record<string, unknown>) => {
    applyLocalDraftForm(filterDraftFields(draftForm));
    status.value = publishDraftMessages.value.restored;
  },
  isDirty: () => currentDraftSnapshot() !== lastDraftSnapshot.value,
  markClean: markDraftClean,
  onNotice: (message: string, tone: "success" | "danger") => {
    if (tone === "danger") {
      error.value = message;
      status.value = "";
    } else {
      status.value = message;
    }
  },
});

lastDraftSnapshot.value = currentDraftSnapshot();

watch(form, () => draftAutosave.scheduleSave(), { deep: true });

onUnmounted(() => draftAutosave.dispose());

function saveLocalDraft() {
  error.value = "";
  draftAutosave.saveNow();
}

// Moves the legacy single-slot draft into its per-service keyed slot and
// deletes the legacy key — complete migration, no legacy path remains.
function migrateLegacyDraftSlot() {
  const legacyDraft = readPublishDraft(PUBLISH_DRAFT_STORAGE_KEY);
  if (!legacyDraft) return;
  const targetKey = legacyDraft.serviceId
    ? `${PUBLISH_DRAFT_STORAGE_KEY}:${legacyDraft.serviceId}`
    : `${PUBLISH_DRAFT_STORAGE_KEY}:new:${stableDraftId.value}`;
  if (!readPublishDraft(targetKey)) {
    writePublishDraft(targetKey, legacyDraft.serviceId, filterDraftFields(legacyDraft.form));
  }
  removePublishDraft(PUBLISH_DRAFT_STORAGE_KEY);
}

async function restoreDraftSlot(key: string) {
  try {
    await draftAutosave.restoreFor(key);
  } catch (e: unknown) {
    removePublishDraft(key);
    error.value = e instanceof Error ? e.message : "Saved browser draft could not be restored.";
  }
}

async function refreshServices() {
  loading.value = true;
  error.value = "";
  try {
    const result = await listPublishedServices();
    setRevision.value = result.setRevision;
    publishedServices.value = result.services;
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
    // Per-service draft restore: deep links and list clicks share this path.
    await restoreDraftSlot(draftStorageKey());
  } catch (e: unknown) {
    if (serviceId) {
      // A selection that no longer exists (stale deep link or removed row)
      // falls back to the empty-draft state with keyed notice copy — the
      // ref write also elides the dead ?serviceId= from the URL.
      resetForm();
      status.value = publishListMessages.value.staleSelection;
    } else {
      error.value = e instanceof Error ? e.message : "Failed to load service.";
    }
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
  // Client-side validation failures land in the form: activate the first
  // invalid tab and focus its first invalid field before any page-level alert.
  if (await publishFormRef.value?.focusFirstInvalid?.()) {
    return;
  }
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
  outcome.begin("publish-request");
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
    // Clear the pre-publish draft slot (the "new:" slot or the replaced
    // service's slot) — the published descriptor supersedes it.
    const prePublishDraftKey = draftStorageKey();
    selectedServiceId.value = result.serviceId;
    selectedServiceRevision.value = result.serviceRevision;
    setRevision.value = result.setRevision;
    removePublishDraft(prePublishDraftKey);
    markDraftClean();
    status.value = "Service accepted; waiting for server publication.";
    outcome.advance();
    const published = await waitForUpstreamServicePublication(result.serviceId);
    selectedServiceRevision.value = published.service.serviceRevision;
    setRevision.value = published.setRevision;
    status.value = "Service is server-published; checking runtime health.";
    outcome.advance();
    healthResult.value = await checkUpstreamServiceRuntimeHealth(result.serviceId);
    outcome.complete("runtime-health", healthResult.value);
    status.value = healthResult.value?.ok === true
      ? "Service is server-published and runtime health passed."
      : "Service is server-published, but runtime health did not pass.";
    await refreshServices();
  } catch (e: unknown) {
    // The failing stage is the active one at throw time; the health stage can
    // carry the failed payload so its checks still render with remediation.
    const activeStage = outcome.stages.value.find((stage) => stage.state === "active");
    outcome.fail(activeStage?.id || "publish-request");
    error.value = e instanceof Error ? e.message : "Publishing failed.";
  } finally {
    loading.value = false;
  }
}

async function disableSelected() {
  if (!selectedServiceId.value) return;
  if (!(await requestDestructiveConfirm("publish.service.disable", { resource: selectedServiceId.value }))) return;
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
  if (!(await requestDestructiveConfirm("publish.service.republish", { resource: selectedServiceId.value }))) return;
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
  // REQ-010 publish-lane adoption: the registry entry's governed-confirm
  // payload (effect/resource/authority/duration) replaces the previous
  // inline English-only confirm.
  if (!(await requestDestructiveConfirm("publish.service.remove", { resource: selectedServiceId.value }))) return;
  loading.value = true;
  error.value = "";
  try {
    await removeUpstreamService(selectedServiceId.value, selectedServiceRevision.value, setRevision.value);
    const removedDraftKey = draftStorageKey();
    resetForm();
    removePublishDraft(removedDraftKey);
    markDraftClean();
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
  try {
    migrateLegacyDraftSlot();
  } catch (e: unknown) {
    removePublishDraft(PUBLISH_DRAFT_STORAGE_KEY);
    error.value = e instanceof Error ? e.message : "Saved browser draft could not be restored.";
  }
  const serviceId = selectedServiceId.value.trim();
  if (serviceId) {
    await selectService(serviceId);
    return;
  }
  await restoreDraftSlot(draftStorageKey());
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

    <ol v-if="outcome.stages.value.some((stage) => stage.state !== 'pending')" class="publish-stage-strip" aria-live="polite">
      <li
        v-for="stage in outcome.stages.value"
        :key="stage.id"
        class="publish-stage"
        :class="`publish-stage--${stage.state}`"
      >
        {{ outcomeMessages[stage.label] }}
      </li>
    </ol>

    <div
      v-if="outcome.done.value && selectedServiceId"
      class="publish-success-links"
      data-testid="publish-success-links"
    >
      <RouterLink to="/admin/operation-permission" class="journey-next-link">
        {{ journeyMessages.grantToolAccess }}
      </RouterLink>
      <RouterLink
        :to="{ path: '/admin/upstream-services', query: { serviceId: selectedServiceId } }"
        class="journey-next-link"
      >
        {{ journeyMessages.viewInGateway }}
      </RouterLink>
    </div>

    <section v-if="outcome.health.value" class="health-result" aria-live="polite">
      <h2>{{ outcomeMessages.healthTitle }}</h2>
      <ul class="health-checks">
        <li
          v-for="check in outcome.health.value.checks"
          :key="check.id"
          class="health-check"
          :class="`health-check--${check.status}`"
        >
          <span class="health-check-label">{{ outcomeMessages[check.label] }}</span>
          <span class="health-check-status">{{ outcomeMessages[healthStatusLabelKeys[check.status]] }}</span>
          <code v-if="check.id" class="health-check-detail">{{ check.id }}</code>
          <RouterLink
            v-if="check.remediation"
            :to="{ path: check.remediation.route, query: check.remediation.query }"
            class="health-check-remediation"
          >{{ outcomeMessages[remediationLabelKey(check.remediation.route)] }}</RouterLink>
        </li>
      </ul>
      <details class="health-raw-json">
        <summary>{{ outcomeMessages.rawJsonSummary }}</summary>
        <pre>{{ JSON.stringify(outcome.health.value.raw, null, 2) }}</pre>
      </details>
    </section>

    <PortableServiceImportPanel
      :loading="loading"
      @load-draft="loadImportedDraft"
    />

    <section class="published-service-list" :aria-label="publishListMessages.title">
      <template v-if="publishedServices.length">
        <h2 class="published-service-list-title">{{ publishListMessages.title }}</h2>
        <ul class="published-service-rows">
          <li
            v-for="service in publishedServices"
            :key="service.serviceId"
            class="published-service-row"
            :class="{ 'is-selected': service.serviceId === selectedServiceId }"
          >
            <button
              type="button"
              class="published-service-select"
              :aria-label="`Select ${service.serviceId}`"
              :disabled="loading"
              @click="selectService(service.serviceId)"
            >
              <strong class="published-service-id">{{ service.serviceId }}</strong>
              <span class="published-service-summary">
                {{ service.state }} · {{ service.publication.status }} · revision {{ service.serviceRevision }}
              </span>
            </button>
          </li>
        </ul>
      </template>
      <ConsoleEmptyState
        v-else
        :title="publishListMessages.emptyTitle"
        :description="publishListMessages.emptyDescription"
      >
        <template #action>
          <button
            type="button"
            class="published-service-create-action"
            @click="scrollElementIntoViewById('upstream-publish-form')"
          >
            {{ publishListMessages.emptyAction }}
          </button>
        </template>
      </ConsoleEmptyState>
    </section>

    <main id="upstream-publish-form" class="publish-grid">
      <PublishServiceForm
        ref="publishFormRef"
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
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}
.health-result h2 { margin: 0 0 0.5rem; font-size: 0.95rem; }
.health-result pre { margin: 0; overflow-x: auto; font-size: 0.8rem; }

/* REQ-017 outcome rendering — existing tokens only. */
.publish-success-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.journey-next-link {
  color: var(--brand);
  font-weight: var(--font-semibold);
  text-decoration: underline;
  font-size: var(--text-sm);
}
.publish-stage-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: var(--text-sm);
}
.publish-stage {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  color: var(--text-muted);
  background: var(--bg-subtle);
}
.publish-stage--active {
  border-color: var(--brand);
  color: var(--brand);
  background: var(--bg-surface);
  font-weight: var(--font-semibold);
}
.publish-stage--done {
  color: var(--success);
  border-color: var(--success-border);
  background: var(--success-surface);
}
.publish-stage--failed {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--bg-subtle);
}
.health-checks {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  font-size: var(--text-sm);
}
.health-check {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.4rem 0.625rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xs);
  background: var(--bg-surface);
}
.health-check-label {
  font-weight: var(--font-semibold);
}
.health-check-status {
  font-size: var(--text-xs);
  padding: 0.1rem 0.4rem;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
}
.health-check--pass .health-check-status {
  color: var(--success);
  border-color: var(--success-border);
  background: var(--success-surface);
}
.health-check--warn .health-check-status {
  color: var(--warning-text);
  border-color: var(--warning-border);
  background: var(--warning-surface);
}
.health-check--fail .health-check-status {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--bg-subtle);
}
.health-check-detail {
  font-size: 0.75rem;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
.health-check-remediation {
  margin-left: auto;
  font-size: var(--text-xs);
}
.health-raw-json {
  margin-top: 0.625rem;
}
.health-raw-json summary {
  cursor: pointer;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
.health-raw-json pre {
  margin-top: 0.5rem;
}

.published-service-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 30vh;
  overflow-y: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 0.75rem 1rem;
}
.published-service-list-title {
  margin: 0;
  font-size: 0.95rem;
  color: var(--text-secondary);
}
.published-service-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.published-service-select {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.published-service-select:disabled {
  cursor: default;
  opacity: 0.6;
}
.published-service-row.is-selected .published-service-select {
  border-color: var(--border-strong);
  background-color: var(--border-strong);
}
.published-service-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
}
.published-service-summary {
  font-size: 0.8rem;
  color: var(--text-muted);
}
.published-service-create-action {
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

</style>
