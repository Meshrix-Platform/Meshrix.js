<script setup lang="ts">
import { computed, nextTick, ref, resolveComponent, watch, type ComputedRef, type Ref } from "vue";
import JsonConfigFileEditor from "../../../components/JsonConfigFileEditor.vue";
import ConsoleEmptyState from "../../../components/ConsoleEmptyState.vue";
import ConsoleInlineAlert from "../../../components/ConsoleInlineAlert.vue";
import HelpTooltip from "../../../components/HelpTooltip.vue";
import MeshrixTabs, { type MeshrixTab } from "../../../components/MeshrixTabs.vue";
import { useConsoleUrlState } from "../../../composables/use-console-url-state";
import { pushConsoleToast } from "../../../composables/console-toast-controller";
import { scrollElementIntoViewById } from "../../../composables/console-browser-effects";
import { createConsoleFormValidation } from "../../../composables/console-form-validation";
import { consoleMessages, currentConsoleLocale } from "../../../i18n/console";
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
  save: [];
  publish: [];
  disable: [];
  republish: [];
  remove: [];
}>();

// The descriptor draft is owned by the parent view; this panel edits it in place.
const form = props.form;

const activeTab: Ref<string> = useConsoleUrlState("publish.tab", "basic");
const operationError = ref("");
const credentialError = ref("");
const savedCredentialOptions = computed(() => Array.isArray(form.savedCredentialOptions) ? form.savedCredentialOptions : []);
// Resolved through the app registry instead of a module import: consumers that
// stub vue-router (tests) keep rendering the alert without the link.
const RouterLink: any = resolveComponent("RouterLink");

// REQ-007 keyed per-field error store (frozen field keys). The six addOperation
// guard clauses map onto it; tab badges and first-invalid focus are projections
// of the store, never stored state.
const validation = createConsoleFormValidation();

// Frozen field keys in visual order, grouped by tab membership.
const OPERATION_FIELDS: readonly string[] = [
  "operationKey", "method", "path",
  "requestRepresentationMode", "requestMaxBytes", "requestMediaTypes",
  "responseRepresentationMode", "responseMaxBytes", "responseMediaTypes",
];
const TAB_FIELDS: Record<string, readonly string[]> = {
  basic: ["serviceProtocol"],
  operations: OPERATION_FIELDS,
  credentials: ["credentialSelection"],
};
const TAB_ORDER: readonly string[] = ["basic", "operations", "credentials", "advanced"];
// Element ids the first-invalid focus targets; field keys that carry their own
// control ids map to themselves.
const FIELD_ELEMENT_IDS: Record<string, string> = {
  serviceProtocol: "upstream-service-protocol",
  credentialSelection: "upstream-service-saved-credential",
};
// Advanced JSON parse state: the escape path (JsonConfigFileEditor) owns its
// own error rendering, so this stays empty — the projection is still declared
// so the tab membership is complete.
const advancedJsonError = ref("");

function tabHasError(tabKey: string): boolean {
  if (tabKey === "advanced") {
    return advancedJsonError.value !== "";
  }
  if (tabKey === "operations" && operationError.value !== "") {
    return true;
  }
  if (tabKey === "credentials" && credentialError.value !== "") {
    return true;
  }
  return (TAB_FIELDS[tabKey] || []).some((field) => validation.fieldError(field) !== "");
}

const formTabs: ComputedRef<MeshrixTab[]> = computed(() => [
  { key: "basic", label: "Service information", draft: tabHasError("basic") },
  { key: "operations", label: "Tool paths", draft: tabHasError("operations") },
  { key: "credentials", label: "Access credentials", draft: tabHasError("credentials") },
  { key: "advanced", label: "Advanced JSON", draft: tabHasError("advanced") },
]);

// The parent view replaces the draft wholesale (service load, import, reset);
// stale per-field errors must not survive a replacement.
watch(() => props.selectedServiceId, () => {
  for (const field of Object.keys(validation.errors)) {
    validation.clearFieldError(field);
  }
  operationError.value = "";
  credentialError.value = "";
});

const publishFormMessages = computed(() => consoleMessages[currentConsoleLocale.value].publishForm);

function updateTags(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  form.tags = value.split(",").map((tag: any) => tag.trim()).filter(Boolean);
}

function saveObjectField(field: typeof descriptorObjectFields[number], value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object.`);
  }
  form[field] = value as Record<string, unknown>;
}

function addOperation() {
  // Re-derive the projection on every attempt: errors from earlier attempts
  // that no longer apply (their fields were fixed by edit) disappear.
  for (const field of OPERATION_FIELDS) {
    validation.clearFieldError(field);
  }
  operationError.value = "";
  const operationKey = form.operationKey?.trim() || "";
  const method = form.method?.trim() || "";
  const path = form.path?.trim() || "";
  const requestMaxBytes = Number(form.requestMaxBytes);
  const responseMaxBytes = Number(form.responseMaxBytes);
  const requestMediaTypes = String(form.requestMediaTypes || "").split(",").map((value: any) => value.trim()).filter(Boolean);
  const responseMediaTypes = String(form.responseMediaTypes || "").split(",").map((value: any) => value.trim()).filter(Boolean);
  const hasResponseConfiguration = Boolean(
    form.responseRepresentationMode ||
    (form.responseMaxBytes !== "" && form.responseMaxBytes !== undefined) ||
    responseMediaTypes.length > 0
  );
  // Guard 1 — required tool path fields: expands into its four fields.
  if (!operationKey || !method || !path || !form.requestRepresentationMode) {
    const message = "Complete all required tool path fields.";
    if (!operationKey) validation.setFieldError("operationKey", message);
    if (!method) validation.setFieldError("method", message);
    if (!path) validation.setFieldError("path", message);
    if (!form.requestRepresentationMode) validation.setFieldError("requestRepresentationMode", message);
    return;
  }
  // Guard 2 — request byte limits.
  if (!Number.isSafeInteger(requestMaxBytes) || requestMaxBytes < 1) {
    validation.setFieldError("requestMaxBytes", "Request byte limits must be positive whole numbers.");
    return;
  }
  // Guard 3 — request media types.
  if (requestMediaTypes.length === 0) {
    validation.setFieldError("requestMediaTypes", "Add at least one request media type.");
    return;
  }
  // Guard 4 — response configuration must be complete or absent.
  if (hasResponseConfiguration && (
    !form.responseRepresentationMode ||
    !Number.isSafeInteger(responseMaxBytes) ||
    responseMaxBytes < 1 ||
    responseMediaTypes.length === 0
  )) {
    const message = "Complete all response fields, or leave the optional response configuration empty.";
    if (!form.responseRepresentationMode) validation.setFieldError("responseRepresentationMode", message);
    if (!Number.isSafeInteger(responseMaxBytes) || responseMaxBytes < 1) validation.setFieldError("responseMaxBytes", message);
    if (responseMediaTypes.length === 0) validation.setFieldError("responseMediaTypes", message);
    return;
  }
  // Guard 5 — JSON-RPC requires Structured JSON for both directions.
  if (
    form.serviceProtocol === "json-rpc" &&
    (form.requestRepresentationMode !== "structured_json" ||
      form.responseRepresentationMode !== "structured_json")
  ) {
    const message = "JSON-RPC tool paths require Structured JSON for both request and response.";
    if (form.requestRepresentationMode !== "structured_json") validation.setFieldError("requestRepresentationMode", message);
    if (form.responseRepresentationMode !== "structured_json") validation.setFieldError("responseRepresentationMode", message);
    return;
  }
  // Guard 6 — duplicate operation identifiers.
  if (form.operations?.some((operation: any) => operation.operationKey === operationKey)) {
    validation.setFieldError("operationKey", "Tool identifiers must be unique within a service.");
    return;
  }
  const payloadTransport: any = {
    request: {
      mode: form.requestRepresentationMode,
      maxBytes: requestMaxBytes,
      mediaTypes: requestMediaTypes,
    },
    ...(hasResponseConfiguration ? {
      response: {
        mode: form.responseRepresentationMode,
        maxBytes: responseMaxBytes,
        mediaTypes: responseMediaTypes,
      }
    } : {})
  };
  (form.operations ||= []).push({
    operationKey,
    method,
    path,
    ...(form.risk ? { risk: form.risk } : {}),
    payloadTransport,
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
  // Local draft mutation only — nothing persists until the parent view saves
  // the descriptor, so undo restores the row in place (§5 H14 of the group
  // Architecture; N14 preserves this when rewriting the form).
  const removed: any = form.operations?.[index];
  form.operations?.splice(index, 1);
  if (removed) {
    pushConsoleToast({
      message: consoleMessages[currentConsoleLocale.value].toast.toolPathRemoved,
      action: {
        label: consoleMessages[currentConsoleLocale.value].toast.undo,
        run: (): void => {
          form.operations?.splice(index, 0, removed);
        },
      },
    });
  }
}

function credentialOptionLabel(reference: Record<string, any>, index: number): string {
  const type = String(reference.type || "Credential").trim();
  const use = String(reference.use || "").trim();
  const revision = Number(reference.revision);
  const name = use || `${type} ${index + 1}`;
  return Number.isSafeInteger(revision) && revision > 0 ? `${name} (revision ${revision})` : name;
}

function sameCredentialReference(left: Record<string, any>, right: Record<string, any>): boolean {
  return ["type", "reference", "revision", "use"].every((field: string) => String(left?.[field] ?? "") === String(right?.[field] ?? ""));
}

function applySavedCredential(index: number): boolean {
  const selected = savedCredentialOptions.value[index];
  if (!selected) {
    credentialError.value = "Select a saved credential before publishing.";
    form.references = [];
    return false;
  }
  form.references = [{ ...selected }];
  credentialError.value = "";
  return true;
}

function updateCredentialMode() {
  credentialError.value = "";
  if (form.credentialMode !== "saved") {
    form.credentialSelection = "";
    form.references = [];
    return;
  }
  if (!savedCredentialOptions.value.length) {
    form.credentialSelection = "";
    form.references = [];
    credentialError.value = "No saved credentials are available. Save a credential in Meshrix before selecting it.";
    return;
  }
  const currentIndex = savedCredentialOptions.value.findIndex((entry: any) =>
    form.references?.some((reference: any) => sameCredentialReference(reference, entry))
  );
  form.credentialSelection = currentIndex >= 0 ? String(currentIndex) : "";
  if (currentIndex >= 0) applySavedCredential(currentIndex);
}

function updateSelectedCredential() {
  credentialError.value = "";
  validation.clearFieldError("credentialSelection");
  const index = Number(form.credentialSelection);
  if (!Number.isSafeInteger(index) || index < 0 || !applySavedCredential(index)) {
    form.credentialSelection = "";
  }
}

// Failed-submit entry point (REQ-014): activates the first tab holding an
// error, then focuses/scrolls its first invalid control. Returns true when
// client-side validation failures were found — the parent view then leaves the
// error to the form instead of raising the page-level alert.
async function focusFirstInvalid(): Promise<boolean> {
  const firstTab: string | null = TAB_ORDER.find((tab) => tabHasError(tab)) ?? null;
  if (!firstTab) {
    return false;
  }
  activeTab.value = firstTab;
  // Cross-tab focus must wait for the newly activated tab's content render.
  await nextTick();
  await nextTick();
  const field: string | undefined = (TAB_FIELDS[firstTab] || []).find(
    (name) => validation.fieldError(name) !== "",
  );
  if (field) {
    const elementId: string = FIELD_ELEMENT_IDS[field] || field;
    scrollElementIntoViewById(elementId);
    const element: HTMLElement | null = document.getElementById(elementId);
    element?.focus?.({ preventScroll: true });
  }
  return true;
}

defineExpose({ focusFirstInvalid });
</script>

<template>
  <section class="publish-form">
    <MeshrixTabs v-model="activeTab" :tabs="formTabs" size="small" aria-label="Service editor sections" />

    <div v-if="activeTab === 'basic'" class="tab-content" role="tabpanel" aria-label="Service information settings">
      <div class="form-field">
        <div class="field-label-row">
          <label for="upstream-service-protocol">Protocol</label>
          <span class="console-form-field-required-marker" aria-hidden="true">*</span>
          <HelpTooltip
            aria-label="Protocol help"
            text="The communication protocol Meshrix uses to call the external service. Choose HTTP for HTTP or REST endpoints, or JSON-RPC for JSON-RPC methods."
          />
        </div>
        <select
          id="upstream-service-protocol"
          v-model="form.serviceProtocol"
          aria-required="true"
          :aria-invalid="validation.fieldError('serviceProtocol') ? 'true' : undefined"
          :aria-describedby="validation.fieldError('serviceProtocol') ? 'console-field-upstream-service-protocol-error' : undefined"
          @change="validation.clearFieldError('serviceProtocol')"
        >
          <option value="">Select protocol</option>
          <option value="http">HTTP</option>
          <option value="json-rpc">JSON-RPC</option>
        </select>
        <span
          v-if="validation.fieldError('serviceProtocol')"
          id="console-field-upstream-service-protocol-error"
          class="console-form-field-error"
          role="alert"
        >{{ validation.fieldError('serviceProtocol') }}</span>
      </div>
      <div class="form-field">
        <div class="field-label-row">
          <label for="upstream-service-url">Service URL *</label>
          <HelpTooltip
            aria-label="Service URL help"
            text="The base address of the external service. Include http:// or https://, the host, and an explicit port. For example: https://api.example:443. Do not include credentials."
            :max-width="420"
          />
        </div>
        <input id="upstream-service-url" v-model="form.baseUrl" type="text" placeholder="http://127.0.0.1:8080" />
      </div>
      <div class="form-field">
        <div class="field-label-row">
          <label for="upstream-service-key">Service identifier *</label>
          <HelpTooltip
            aria-label="Service identifier help"
            text="A unique, stable identifier used by Meshrix to recognize this service. Start with a letter; use letters, numbers, dots, underscores, hyphens, or slash-separated segments. For example: inventory-api. It cannot be changed after publication."
            :max-width="420"
          />
        </div>
        <input id="upstream-service-key" v-model="form.serviceKey" type="text" placeholder="my-service" :disabled="!!selectedServiceId" />
      </div>
      <div class="form-field">
        <div class="field-label-row">
          <label for="upstream-service-name">Service name</label>
          <HelpTooltip
            aria-label="Service name help"
            text="A human-readable name shown in Meshrix. It can differ from the service identifier and can be updated later."
          />
        </div>
        <input id="upstream-service-name" v-model="form.label" type="text" placeholder="My Service" />
      </div>
      <div class="form-field">
        <div class="field-label-row">
          <label for="upstream-service-description">Service description</label>
          <HelpTooltip
            aria-label="Service description help"
            text="A short explanation of what the external service provides, shown to operators when they review the service in Meshrix."
          />
        </div>
        <input id="upstream-service-description" v-model="form.description" type="text" placeholder="Service description" />
      </div>
      <div class="form-field">
        <div class="field-label-row">
          <label for="upstream-service-visibility">Visibility</label>
          <HelpTooltip
            aria-label="Visibility help"
            text="Optional visibility metadata for discovery and governance policies. Enter only a value defined by your organization; otherwise leave it empty."
          />
        </div>
        <input id="upstream-service-visibility" v-model="form.visibility" type="text" placeholder="Leave empty when not configured" />
      </div>
      <div class="form-field">
        <div class="field-label-row">
          <label for="upstream-service-data-class">Data class</label>
          <HelpTooltip
            aria-label="Data class help"
            text="Optional data-classification metadata used by governance policies. Enter only a classification defined by your organization; otherwise leave it empty."
          />
        </div>
        <input id="upstream-service-data-class" v-model="form.dataClass" type="text" placeholder="Leave empty when not configured" />
      </div>
      <div class="form-field">
        <div class="field-label-row">
          <label for="upstream-service-tags">Tags</label>
          <HelpTooltip
            aria-label="Tags help"
            text="Optional comma-separated governance tags used for filtering and policy matching. Use tags already defined by your organization; otherwise leave this empty."
          />
        </div>
        <input id="upstream-service-tags" :value="form.tags?.join(', ') || ''" type="text" placeholder="Comma-separated tags" @input="updateTags" />
      </div>
    </div>

    <div v-if="activeTab === 'operations'" class="tab-content" role="tabpanel" aria-label="Tool paths">
      <p class="form-help">Manual setup covers JSON and native stream payloads. Use service JSON import for artifact payload mappings.</p>
      <div class="operation-builder">
        <div class="field-grid">
          <label class="form-field">
            <span>Tool identifier *</span>
            <input id="operationKey" v-model="form.operationKey" type="text" placeholder="list-items" @input="validation.clearFieldError('operationKey')" />
            <span v-if="validation.fieldError('operationKey')" id="console-field-operationKey-error" class="console-form-field-error" role="alert">{{ validation.fieldError('operationKey') }}</span>
          </label>
          <label class="form-field">
            <span>Method *</span>
            <select id="method" v-model="form.method" @change="validation.clearFieldError('method')">
              <option value="">Select method</option>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select>
            <span v-if="validation.fieldError('method')" id="console-field-method-error" class="console-form-field-error" role="alert">{{ validation.fieldError('method') }}</span>
          </label>
          <label class="form-field">
            <span>Path *</span>
            <input id="path" v-model="form.path" type="text" placeholder="/api/path" @input="validation.clearFieldError('path')" />
            <span v-if="validation.fieldError('path')" id="console-field-path-error" class="console-form-field-error" role="alert">{{ validation.fieldError('path') }}</span>
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
              <select id="requestRepresentationMode" v-model="form.requestRepresentationMode" @change="validation.clearFieldError('requestRepresentationMode')">
                <option value="">Select representation</option>
                <option value="structured_json">Structured JSON</option>
                <option value="opaque_stream">Native stream</option>
              </select>
              <span v-if="validation.fieldError('requestRepresentationMode')" id="console-field-requestRepresentationMode-error" class="console-form-field-error" role="alert">{{ validation.fieldError('requestRepresentationMode') }}</span>
            </label>
            <label class="form-field">
              <span>Maximum bytes *</span>
              <input id="requestMaxBytes" v-model.number="form.requestMaxBytes" type="number" min="1" placeholder="1048576" @input="validation.clearFieldError('requestMaxBytes')" />
              <span v-if="validation.fieldError('requestMaxBytes')" id="console-field-requestMaxBytes-error" class="console-form-field-error" role="alert">{{ validation.fieldError('requestMaxBytes') }}</span>
            </label>
            <label class="form-field">
              <span>Media types *</span>
              <input id="requestMediaTypes" v-model="form.requestMediaTypes" type="text" placeholder="application/json" @input="validation.clearFieldError('requestMediaTypes')" />
              <span v-if="validation.fieldError('requestMediaTypes')" id="console-field-requestMediaTypes-error" class="console-form-field-error" role="alert">{{ validation.fieldError('requestMediaTypes') }}</span>
            </label>
          </fieldset>
          <fieldset>
            <legend class="fieldset-label-row">
              <span>Response (optional)</span>
              <HelpTooltip
                aria-label="Response help"
                text="Leave empty to use governed native passthrough. Meshrix still enforces response size and transport boundaries."
                :max-width="420"
              />
            </legend>
            <label class="form-field">
              <span>Representation</span>
              <select id="responseRepresentationMode" v-model="form.responseRepresentationMode" @change="validation.clearFieldError('responseRepresentationMode')">
                <option value="">Select representation</option>
                <option value="structured_json">Structured JSON</option>
                <option value="opaque_stream">Native stream</option>
              </select>
              <span v-if="validation.fieldError('responseRepresentationMode')" id="console-field-responseRepresentationMode-error" class="console-form-field-error" role="alert">{{ validation.fieldError('responseRepresentationMode') }}</span>
            </label>
            <label class="form-field">
              <span>Maximum bytes</span>
              <input id="responseMaxBytes" v-model.number="form.responseMaxBytes" type="number" min="1" placeholder="1048576" @input="validation.clearFieldError('responseMaxBytes')" />
              <span v-if="validation.fieldError('responseMaxBytes')" id="console-field-responseMaxBytes-error" class="console-form-field-error" role="alert">{{ validation.fieldError('responseMaxBytes') }}</span>
            </label>
            <label class="form-field">
              <span>Media types</span>
              <input id="responseMediaTypes" v-model="form.responseMediaTypes" type="text" placeholder="application/json" @input="validation.clearFieldError('responseMediaTypes')" />
              <span v-if="validation.fieldError('responseMediaTypes')" id="console-field-responseMediaTypes-error" class="console-form-field-error" role="alert">{{ validation.fieldError('responseMediaTypes') }}</span>
            </label>
          </fieldset>
        </div>
        <ConsoleInlineAlert v-if="operationError" tone="danger">{{ operationError }}</ConsoleInlineAlert>
        <div class="builder-actions">
          <button type="button" class="table-action" @click="addOperation">Add tool path</button>
        </div>
      </div>
      <ul class="op-list">
        <li v-for="(op, i) in form.operations" :key="op.operationKey">
          <span class="operation-name"><strong>{{ op.operationKey }}</strong><span>{{ op.method }} {{ op.path }}</span></span>
          <small v-if="op.risk">{{ op.risk }}</small>
          <small>{{ op.payloadTransport.request.mode }} → {{ op.payloadTransport.response?.mode || "governed passthrough" }}</small>
          <button type="button" class="inline-remove" @click="removeOperation(i)">Remove<span class="visually-hidden"> {{ op.operationKey }}</span></button>
        </li>
        <ConsoleEmptyState v-if="!form.operations?.length" as="li" compact title="No tool paths defined." />
      </ul>
    </div>

    <div v-if="activeTab === 'credentials'" class="tab-content" role="tabpanel" aria-label="Access credentials">
      <p class="form-help">Public services can use no authentication. For protected services, select a credential already saved in Meshrix; secret values and reference URIs are never entered here.</p>
      <div class="credential-builder">
        <div class="field-grid">
          <div class="form-field">
            <div class="field-label-row">
              <label for="upstream-service-credential-mode">Access credential</label>
              <HelpTooltip
                aria-label="Access credential help"
                text="Choose no authentication for a public service, or select a credential already saved in Meshrix. This form never accepts a credential URI or secret value."
                :max-width="420"
              />
            </div>
            <select id="upstream-service-credential-mode" v-model="form.credentialMode" @change="updateCredentialMode">
              <option value="none">No authentication</option>
              <option value="saved">Select saved credential</option>
            </select>
          </div>
          <label v-if="form.credentialMode === 'saved'" class="form-field" for="upstream-service-saved-credential">
            <span>Saved credential *</span>
            <select
              id="upstream-service-saved-credential"
              v-model="form.credentialSelection"
              :disabled="!savedCredentialOptions.length"
              :aria-invalid="validation.fieldError('credentialSelection') ? 'true' : undefined"
              :aria-describedby="validation.fieldError('credentialSelection') ? 'console-field-credentialSelection-error' : undefined"
              @change="updateSelectedCredential"
            >
              <option value="">{{ savedCredentialOptions.length ? "Select a saved credential" : "No saved credentials available" }}</option>
              <option v-for="(credential, index) in savedCredentialOptions" :key="`${credential.type || 'credential'}:${index}`" :value="String(index)">
                {{ credentialOptionLabel(credential, index) }}
              </option>
            </select>
            <span
              v-if="validation.fieldError('credentialSelection')"
              id="console-field-credentialSelection-error"
              class="console-form-field-error"
              role="alert"
            >{{ validation.fieldError('credentialSelection') }}</span>
          </label>
        </div>
        <ConsoleInlineAlert v-if="credentialError" tone="danger">
          <template v-if="form.credentialMode === 'saved' && !savedCredentialOptions.length">
            No saved credentials are available.
            <RouterLink
              to="/admin/api-key-distribution"
              class="credential-save-link"
            >{{ publishFormMessages.credentialSaveLink }}</RouterLink>
            before selecting it.
          </template>
          <template v-else>{{ credentialError }}</template>
        </ConsoleInlineAlert>
        <p v-if="form.credentialMode === 'saved' && form.references?.length" class="credential-selection-summary">
          Selected: {{ credentialOptionLabel(form.references[0], 0) }}
        </p>
      </div>
    </div>

    <div v-if="activeTab === 'advanced'" class="tab-content advanced-config-grid" role="tabpanel" aria-label="Advanced service JSON">
      <section class="operation-descriptor-preview" aria-label="Imported tool descriptors">
        <h3>Imported tool descriptors</h3>
        <p class="form-help">Read-only payload mappings and byte envelopes loaded from the service descriptor.</p>
        <div v-if="form.operations?.length" class="operation-descriptor-summary">
          <article v-for="operation in form.operations" :key="operation.operationKey">
            <strong>{{ operation.operationKey }}</strong>
            <span>{{ operation.method }} {{ operation.path }}</span>
            <span>Approval: {{ operation.requiresApproval ? "required" : "not required" }}</span>
            <span>
              Request:
              {{ operation.payloadTransport?.request?.mode || "not configured" }}
              · maxBytes {{ operation.payloadTransport?.request?.maxBytes || "not configured" }}
            </span>
          </article>
        </div>
        <pre>{{ JSON.stringify(form.operations || [], null, 2) }}</pre>
      </section>
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
      <button class="table-action" type="button" :disabled="loading" @click="emit('save')">Save</button>
      <button class="table-action primary" type="button" :disabled="loading || (!selectedServiceId && !form.serviceKey) || (form.credentialMode === 'saved' && !form.references?.length)" @click="emit('publish')">
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
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
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
.operation-descriptor-preview {
  min-width: 0;
  padding: 0.85rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
}
.operation-descriptor-preview h3 {
  margin: 0 0 0.35rem;
  font-size: 0.95rem;
}
.operation-descriptor-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  gap: 0.55rem;
  margin-top: 0.65rem;
}
.operation-descriptor-summary article {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
  padding: 0.65rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  font-size: 0.78rem;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.operation-descriptor-preview pre {
  max-height: 34rem;
  margin: 0.65rem 0 0;
  padding: 0.75rem;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  font-size: 0.78rem;
  line-height: 1.35;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.form-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
}
.field-label-row {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  width: fit-content;
}
/* REQ-007 field contract rendered in this file's own field markup: the
   required marker and the per-field error region follow ConsoleFormField's
   classes so the form and the primitive share one visual language. */
.console-form-field-required-marker {
  color: var(--danger);
  font-size: 0.85rem;
  line-height: 1;
}
.console-form-field-error {
  color: var(--danger);
  font-size: var(--text-xs);
}
/* Tab validity badge: the line variant of MeshrixTabs has no draft visual, so
   the draft dot is scoped here (H7 — MeshrixTabs stays untouched). */
:deep(.meshrix-tab--draft)::after {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: var(--space-1);
  border-radius: 50%;
  background: var(--danger);
}
.credential-save-link {
  color: inherit;
  font-weight: var(--font-semibold);
  text-decoration: underline;
}
.form-field input,
.form-field select {
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xs);
  font-size: 0.85rem;
}
.operation-builder,
.credential-builder {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.85rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
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
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}
.transport-grid legend {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: 0 0.3rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.builder-actions {
  display: flex;
  justify-content: flex-end;
}
.credential-selection-summary {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
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
  border-bottom: 1px solid var(--border-subtle);
}
.operation-name {
  display: flex;
  flex-direction: column;
  min-width: 9rem;
}
.inline-remove {
  margin-left: auto;
  border: 1px solid var(--danger);
  border-radius: var(--radius-xs);
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
  margin: calc(-1 * var(--space-px));
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: auto;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border-subtle);
}
.table-action.primary {
  background: var(--brand);
  color: white;
  border-color: var(--brand);
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
