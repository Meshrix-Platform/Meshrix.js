<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, resolveComponent, watch } from "vue";
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import ConsoleEmptyState from "../../components/ConsoleEmptyState.vue";
import ConsoleInlineAlert from "../../components/ConsoleInlineAlert.vue";
import PublishServiceForm from "./upstream-service-publish/PublishServiceForm.vue";
import PortableServiceImportPanel from "./upstream-service-publish/PortableServiceImportPanel.vue";
import {
  UPSTREAM_SERVICE_DESCRIPTOR_FIELDS,
  UPSTREAM_MCP_REMOTE_TRANSPORTS,
  type PortableUpstreamServiceImport,
} from "@meshrix/contracts/upstream-service-publishing";
import type { PublishDescriptorForm } from "./upstream-service-publish/publish-form-model";
import { scrollElementIntoViewById } from "../../composables/console-browser-effects";
import { requestDestructiveConfirm } from "../../composables/console-destructive-operation-registry";
import { createPublishOutcomeModel, type AcceptedPublication } from "../../composables/console-publish-outcome-model";
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
  observeUpstreamServicePublication,
  checkUpstreamServiceRuntimeHealth,
  isUpstreamPublicationObservationAbort,
  UpstreamPublicationObservationError,
  type PublishedUpstreamServiceSummary,
  type UpstreamServiceDescriptor,
  type UpstreamServicePublishingResult,
  type UpstreamServiceRuntimeHealth,
} from "../../lib/upstream-service-publish-client";

defineOptions({ name: "UpstreamServicePublishView" });

const STABLE_DRAFT_ID_KEY = `${PUBLISH_DRAFT_STORAGE_KEY}:new-draft-id`;
const formEditorFields = [
  "serviceKey", "operationKey", "method", "path", "risk",
  "requestRepresentationMode", "responseRepresentationMode", "requestMaxBytes", "responseMaxBytes",
  "requestMediaTypes", "responseMediaTypes",
  "mcpTransport", "mcpUrl", "mcpProtocolVersion",
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
const publishedServiceProtocol = ref("");
const healthResult = ref<UpstreamServiceRuntimeHealth | null>(null);
const publishedServices = ref<PublishedUpstreamServiceSummary[]>([]);
const publishListMessages = computed(() => consoleMessages[currentConsoleLocale.value].publishList);
// REQ-017 outcome model: staged progress + interpreted health; the done state
// and selected serviceId feed the success next steps.
const outcome = createPublishOutcomeModel({ serviceId: () => selectedServiceId.value });
const outcomeMessages = computed(() => consoleMessages[currentConsoleLocale.value].publishOutcome);
const journeyMessages = computed(() => consoleMessages[currentConsoleLocale.value].journey);
const observing = computed(() => outcome.observation.value === "observing");
const acceptedPublicationProtocol = ref("");

// --- accepted-publication observation (REQ-017) ---
// One view-owned observer tracks the accepted server revision. The observer
// owns its AbortController and status-query timer; stopping, replacing,
// navigating away or unmounting disposes them without cancelling the accepted
// server publication. A status-query failure only interrupts the observation:
// the retained acceptance stays visible with an explicit resume action.
type OwnedPublicationObservation = {
  generation: number;
  controller: AbortController;
};

let ownedObservation: OwnedPublicationObservation | null = null;
let observationGeneration = 0;
let publicationRun = 0;
const resumeObservationButton = ref<HTMLButtonElement | null>(null);

function invalidatePublicationRun(): void {
  publicationRun += 1;
}

function beginPublicationRun(): number {
  publicationRun += 1;
  // A new run replaces any retained observation before it owns a new one.
  releaseOwnedObservation();
  return publicationRun;
}

function isCurrentPublicationRun(run: number): boolean {
  return run === publicationRun;
}

function releaseOwnedObservation(): void {
  observationGeneration += 1;
  if (ownedObservation) {
    ownedObservation.controller.abort();
    ownedObservation = null;
  }
}

function beginOwnedObservation(): OwnedPublicationObservation {
  releaseOwnedObservation();
  const owned: OwnedPublicationObservation = {
    generation: ++observationGeneration,
    controller: new AbortController(),
  };
  ownedObservation = owned;
  return owned;
}

function isCurrentObservation(owned: OwnedPublicationObservation): boolean {
  return ownedObservation === owned && owned.generation === observationGeneration;
}
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
  mcpTransport: "",
  mcpUrl: "",
  mcpProtocolVersion: "",
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

function loadMcpEditorFields(descriptor: Pick<UpstreamServiceDescriptor | PublishDescriptorForm, "mcp" | "baseUrl">): void {
  const mcp = descriptor.mcp;
  const configuredTransport = String(mcp?.transport || "").toLowerCase();
  form.mcpTransport = UPSTREAM_MCP_REMOTE_TRANSPORTS.some((transport) => transport === configuredTransport)
    ? "http"
    : "";
  form.mcpUrl = String(mcp?.url || mcp?.endpoint || mcp?.baseUrl || descriptor.baseUrl || "");
  form.mcpProtocolVersion = String(mcp?.protocolVersion || "");
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

onUnmounted(() => {
  // Navigation and unmount dispose the owned observer; the accepted server
  // publication keeps running without the Console.
  releaseOwnedObservation();
  draftAutosave.dispose();
});

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
    publishedServices.value = [...result.services];
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Failed to list services.";
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  invalidatePublicationRun();
  releaseOwnedObservation();
  outcome.resetRun();
  for (const key of Object.keys(form) as Array<keyof PublishDescriptorForm>) delete form[key];
  Object.assign(form, emptyForm());
  selectedServiceId.value = "";
  selectedServiceRevision.value = 0;
  publishedServiceProtocol.value = "";
  acceptedPublicationProtocol.value = "";
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
  loadMcpEditorFields(document.descriptor);
  form.savedCredentialOptions = [...form.references];
  form.credentialMode = form.references.length ? "saved" : "none";
  form.credentialSelection = form.references.length ? "0" : "";
  status.value = "Draft loaded. Review it, then select Publish.";
}

async function selectService(serviceId: string) {
  // A selection change replaces the selected publication: dispose the owned
  // observer before the load so no stale result can advance the old run.
  invalidatePublicationRun();
  releaseOwnedObservation();
  outcome.resetRun();
  loading.value = true;
  error.value = "";
  try {
    const result = await getPublishedService(serviceId);
    resetForm();
    selectedServiceId.value = serviceId;
    selectedServiceRevision.value = result.service.serviceRevision;
    setRevision.value = result.setRevision;
    Object.assign(form, result.service.descriptor || {});
    publishedServiceProtocol.value = result.service.descriptor?.serviceProtocol || "";
    loadMcpEditorFields(result.service.descriptor || {});
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
  if (form.serviceProtocol === "mcp" &&
      !["mcpTransport", "mcpUrl", "mcpProtocolVersion"].some((field) => Object.hasOwn(draftForm, field))) {
    loadMcpEditorFields(form);
  }
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
    "mcpTransport", "mcpUrl", "mcpProtocolVersion",
    "credentialMode", "credentialSelection", "savedCredentialOptions"
  ]);
  const descriptor: Record<string, unknown> = Object.fromEntries(Object.entries(form).filter(([key, value]: readonly any[]) =>
    !excluded.has(key) && value !== undefined && value !== ""
  ));
  if (form.serviceProtocol === "mcp") {
    delete descriptor.baseUrl;
    delete descriptor.operations;
    const mcp: Record<string, unknown> = { ...(form.mcp || {}) };
    delete mcp.endpoint;
    delete mcp.baseUrl;
    mcp.transport = form.mcpTransport;
    mcp.url = form.mcpUrl;
    mcp.protocolVersion = form.mcpProtocolVersion;
    descriptor.mcp = mcp;
  } else {
    delete descriptor.mcp;
  }
  return descriptor as unknown as UpstreamServiceDescriptor;
}

function acceptMutationResult(result: UpstreamServicePublishingResult): AcceptedPublication {
  const accepted: AcceptedPublication = {
    serviceId: result.serviceId,
    serviceRevision: result.serviceRevision,
    setRevision: result.setRevision,
  };
  outcome.acceptPublication(accepted);
  return accepted;
}

// Only an authoritative terminal publication advances here. A failed health
// request is its own runtime-health projection; it never rewrites the
// publication stage, and an observation interruption never reaches it.
async function runRuntimeHealth(serviceId: string, run: number): Promise<void> {
  status.value = outcomeMessages.value.observationPublished;
  let health: UpstreamServiceRuntimeHealth;
  try {
    health = await checkUpstreamServiceRuntimeHealth(serviceId);
  } catch (e: unknown) {
    if (!isCurrentPublicationRun(run)) return;
    outcome.fail("runtime-health");
    error.value = e instanceof Error ? e.message : "Runtime health check failed.";
    return;
  }
  if (!isCurrentPublicationRun(run)) return;
  healthResult.value = health;
  outcome.complete("runtime-health", health);
  status.value = health.ok === true
    ? outcomeMessages.value.healthPassed
    : outcomeMessages.value.healthNotPassed;
  await refreshServices();
}

async function observeAcceptedPublication(
  run: number,
  accepted: AcceptedPublication,
  invoker: HTMLElement | null,
): Promise<void> {
  const owned: OwnedPublicationObservation = beginOwnedObservation();
  outcome.beginObservation();
  status.value = "";
  try {
    const published = await observeUpstreamServicePublication(
      { serviceId: accepted.serviceId, serviceRevision: accepted.serviceRevision },
      { signal: owned.controller.signal },
    );
    if (!isCurrentPublicationRun(run) || !isCurrentObservation(owned)) return;
    releaseOwnedObservation();
    publishedServiceProtocol.value = published.service.descriptor?.serviceProtocol ||
      acceptedPublicationProtocol.value ||
      publishedServiceProtocol.value;
    selectedServiceRevision.value = published.service.serviceRevision;
    setRevision.value = published.setRevision;
    outcome.advance();
    outcome.clearPublication();
    await runRuntimeHealth(accepted.serviceId, run);
    await restorePublicationFocus(invoker);
  } catch (e: unknown) {
    if (!isCurrentPublicationRun(run) || !isCurrentObservation(owned)) return;
    releaseOwnedObservation();
    if (isUpstreamPublicationObservationAbort(e)) {
      // An owned request was disposed (explicit stop or replacement); the
      // stop projection already ran and the accepted publication is unchanged.
      return;
    }
    if (e instanceof UpstreamPublicationObservationError && e.reason === "superseded") {
      outcome.clearPublication();
      outcome.fail("gateway-publication");
      error.value = outcomeMessages.value.publicationSuperseded;
      await restorePublicationFocus(invoker);
      return;
    }
    // Temporary observation interruption: no server-failure projection, no
    // resubmission; the accepted publication stays retained for resume.
    outcome.interruptObservation();
    await restorePublicationFocus(invoker);
  }
}

async function stopPublicationObservation(): Promise<void> {
  if (!outcome.acceptedPublication.value) return;
  releaseOwnedObservation();
  outcome.stopObservation();
  status.value = "";
  await nextTick();
  if (document.activeElement === document.body) {
    resumeObservationButton.value?.focus({ preventScroll: true });
  }
}

async function resumePublicationObservation(): Promise<void> {
  const accepted = outcome.acceptedPublication.value;
  if (!accepted) return;
  const run = publicationRun;
  const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  loading.value = true;
  error.value = "";
  try {
    await observeAcceptedPublication(run, accepted, invoker);
  } finally {
    loading.value = false;
    await restorePublicationFocus(invoker);
  }
}

async function restorePublicationFocus(invoker: HTMLElement | null) {
  await nextTick();
  if (invoker?.isConnected && invoker !== document.body && document.activeElement === document.body) {
    invoker.focus({ preventScroll: true });
  }
}

async function publishService() {
  const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
  const run = beginPublicationRun();
  loading.value = true;
  error.value = "";
  status.value = "";
  outcome.begin("publish-request");
  try {
    const descriptor = descriptorPayload();
    let result;
    if (selectedServiceId.value) {
      result = await replaceUpstreamService(
        selectedServiceId.value,
        descriptor,
        selectedServiceRevision.value,
        setRevision.value
      );
    } else {
      result = await createUpstreamService(form.serviceKey.trim(), descriptor, setRevision.value);
    }
    // Clear the pre-publish draft slot (the "new:" slot or the replaced
    // service's slot) — the published descriptor supersedes it.
    const prePublishDraftKey = draftStorageKey();
    selectedServiceId.value = result.serviceId;
    selectedServiceRevision.value = result.serviceRevision;
    setRevision.value = result.setRevision;
    removePublishDraft(prePublishDraftKey);
    markDraftClean();
    const accepted = acceptMutationResult(result);
    acceptedPublicationProtocol.value = descriptor.serviceProtocol || "";
    outcome.advance();
    // The observation owns its own lifetime; the click handler only owns the
    // mutation request.
    void observeAcceptedPublication(run, accepted, invoker);
  } catch (e: unknown) {
    // The failing stage is the active one at throw time; the health stage can
    // carry the failed payload so its checks still render with remediation.
    const activeStage = outcome.stages.value.find((stage) => stage.state === "active");
    outcome.fail(activeStage?.id || "publish-request");
    error.value = e instanceof Error ? e.message : "Publishing failed.";
  } finally {
    loading.value = false;
    await restorePublicationFocus(invoker);
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
  const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!(await requestDestructiveConfirm("publish.service.republish", { resource: selectedServiceId.value }))) return;
  const serviceId = selectedServiceId.value;
  const run = beginPublicationRun();
  loading.value = true;
  error.value = "";
  status.value = "";
  outcome.begin("publish-request");
  try {
    const result = await republishUpstreamService(serviceId, selectedServiceRevision.value, setRevision.value);
    selectedServiceRevision.value = result.serviceRevision;
    setRevision.value = result.setRevision;
    const accepted = acceptMutationResult(result);
    acceptedPublicationProtocol.value = publishedServiceProtocol.value || String(form.serviceProtocol || "");
    outcome.advance();
    void observeAcceptedPublication(run, accepted, invoker);
  } catch (e: unknown) {
    const activeStage = outcome.stages.value.find((stage) => stage.state === "active");
    outcome.fail(activeStage?.id || "publish-request");
    error.value = e instanceof Error ? e.message : "Republish failed.";
  } finally {
    loading.value = false;
    await restorePublicationFocus(invoker);
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
      v-if="outcome.acceptedPublication.value && outcome.observation.value !== 'idle'"
      class="publication-observer"
      data-testid="publication-observer"
      role="status"
      aria-live="polite"
    >
      <span class="publication-observer-status">
        {{ outcome.observation.value === 'observing'
          ? outcomeMessages.observationWaiting
          : outcome.observation.value === 'interrupted'
            ? outcomeMessages.observationInterrupted
            : outcomeMessages.observationStopped }}
      </span>
      <button
        v-if="outcome.observation.value === 'observing'"
        type="button"
        class="publication-observer-action"
        data-testid="publication-observer-stop"
        @click="stopPublicationObservation"
      >
        {{ outcomeMessages.observationStop }}
      </button>
      <button
        v-else
        ref="resumeObservationButton"
        type="button"
        class="publication-observer-action"
        data-testid="publication-observer-resume"
        @click="resumePublicationObservation"
      >
        {{ outcomeMessages.observationResume }}
      </button>
    </div>

    <div
      v-if="outcome.done.value && selectedServiceId"
      class="publish-success-links"
      data-testid="publish-success-links"
    >
      <RouterLink :to="publishedServiceProtocol === 'mcp' ? '/admin/api-key-distribution' : '/admin/operation-permission'" class="journey-next-link">
        {{ publishedServiceProtocol === 'mcp' ? journeyMessages.issueClientKey : journeyMessages.grantToolAccess }}
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
          <code v-if="check.statusCode !== undefined" class="health-check-detail">HTTP {{ check.statusCode }}</code>
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

    <div id="upstream-publish-form" class="publish-grid">
      <PublishServiceForm
        ref="publishFormRef"
        :form="form"
        :selected-service-id="selectedServiceId"
        :loading="loading || observing"
        @save="saveLocalDraft"
        @publish="publishService"
        @disable="disableSelected"
        @republish="republishSelected"
        @remove="removeSelected"
      />
    </div>
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
.publication-observer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.publication-observer-status {
  min-width: 0;
  overflow-wrap: anywhere;
}
.publication-observer-action {
  margin-left: auto;
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  cursor: pointer;
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
  flex-wrap: wrap;
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
  flex: 1 1 12rem;
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
}
.published-service-summary {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
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
