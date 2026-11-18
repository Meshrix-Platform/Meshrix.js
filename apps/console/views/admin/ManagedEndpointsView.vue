<script setup lang="ts">
import { computed } from "vue";
import StatusPill from "@meshrix/ui-console/status-pill";
import { formatCompactDate } from "@meshrix/ui-console/console-format-utils";
import { useServerConsoleShellContext } from "#meshrix/console/server-console-shell-context";
import ConsoleEmptyState from "../../components/ConsoleEmptyState.vue";
import ConsoleInlineAlert from "../../components/ConsoleInlineAlert.vue";
import { useManagedEndpointsViewController } from "../../composables/console-managed-endpoints-view-controller";
import { consoleMessages, currentConsoleLocale } from "../../i18n/console";

defineOptions({ name: "ManagedEndpointsView" });

const shell = useServerConsoleShellContext();
const msg = computed(() => consoleMessages[currentConsoleLocale.value].managedEndpoints);

const {
  endpoints,
  observations,
  selectedEndpointId,
  selectedEndpoint,
  selectedTaskId,
  taskDetail,
  pendingPermission,
  endpointTasks,
  publishedCapabilities,
  publishedWorkspaces,
  allowedPublished,
  unpublishedAllowed,
  orgPendingPermissions,
  taskEvents,
  eventsBusy,
  eventsFollowing,
  loading,
  actionBusy,
  error,
  createLabel,
  createKind,
  editLabel,
  allowedIds,
  capabilityId,
  workspaceId,
  inputText,
  enrollmentToken,
  tokenRevealed,
  tokenCopied,
  canManage,
  canExecute,
  canApprove,
  refresh,
  selectEndpoint,
  selectTask,
  refreshTaskDetail,
  refreshTaskEvents,
  toggleTaskEventFollow,
  createEndpoint,
  toggleAllowed,
  removeAllowed,
  savePolicy,
  revokeEndpoint,
  submitTask,
  cancelTask,
  resolvePermission,
  resolvePendingPermission,
  revealToken,
  hideToken,
  copyToken,
  dismissToken,
} = useManagedEndpointsViewController({
  access: {
    authenticated: shell.access.isAuthenticated,
    subject: shell.access.currentUser,
    scopes: shell.access.currentUserScopes,
    featureIds: shell.runtime.activeConsoleFeatureIds,
  },
});

const errorText = computed(() =>
  error.value ? ((msg.value as Record<string, string>)[error.value] ?? error.value) : "",
);

const maskedToken = computed(() =>
  tokenRevealed.value ? enrollmentToken.value : "•".repeat(24),
);

function endpointStateLabel(state: string): string {
  const key =
    state === "active"
      ? "stateActive"
      : state === "revoked"
        ? "stateRevoked"
        : "statePending";
  return (msg.value as Record<string, string>)[key];
}

function endpointStateTone(state: string): string {
  return state === "active" ? "success" : state === "revoked" ? "danger" : "neutral";
}

function taskStateLabel(state: string): string {
  const key =
    state === "succeeded"
      ? "taskStateSucceeded"
      : state === "failed"
        ? "taskStateFailed"
        : state === "cancelled"
          ? "taskStateCancelled"
          : state === "unknown" || state === "in_doubt"
            ? "taskStateUnknown"
            : state === "pending" || state === "queued" || state === "retry_wait"
              ? "taskStatePending"
              : "taskStateRunning";
  return (msg.value as Record<string, string>)[key];
}

function taskStateTone(state: string): string {
  return state === "succeeded"
    ? "success"
    : state === "failed" || state === "cancelled"
      ? "danger"
      : state === "unknown" || state === "in_doubt"
        ? "warning"
        : "neutral";
}

function lastContactLabel(endpointId: string): string {
  const at = observations.value[endpointId];
  return at ? formatCompactDate(new Date(at).toISOString()) : msg.value.notObserved;
}

const JSON_PREVIEW_LIMIT = 4096;

function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

function previewText(value: unknown): string {
  const text = jsonText(value);
  return text.length > JSON_PREVIEW_LIMIT ? `${text.slice(0, JSON_PREVIEW_LIMIT)}…` : text;
}

function isTruncated(value: unknown): boolean {
  return jsonText(value).length > JSON_PREVIEW_LIMIT;
}

const selectedCapability = computed(
  () =>
    publishedCapabilities.value.find(
      (capability) => capability.capabilityId === capabilityId.value,
    ) ?? null,
);

const canSubmitTask = computed(
  () =>
    canExecute.value &&
    selectedEndpoint.value?.state === "active" &&
    Boolean(
      allowedPublished.value.some(
        (capability) => capability.capabilityId === capabilityId.value,
      ),
    ) &&
    !actionBusy.value,
);
const cancellableTask = computed(
  () =>
    taskDetail.value &&
    !["succeeded", "failed", "cancelled"].includes(taskDetail.value.task.state) &&
    !taskDetail.value.task.cancelRequested,
);
const hasResult = computed(
  () => taskDetail.value && taskDetail.value.task.result !== null && taskDetail.value.task.result !== undefined,
);
const hasProgress = computed(
  () => taskDetail.value && taskDetail.value.task.progress !== null && taskDetail.value.task.progress !== undefined,
);
</script>

<template>
  <section class="managed-endpoints-layout" :aria-busy="loading">
    <section class="surface-card">
      <div class="section-header">
        <button
          class="tool-button-ghost"
          data-testid="managed-refresh"
          type="button"
          :disabled="loading"
          @click="refresh"
        >
          {{ loading ? msg.refreshBusy : msg.refresh }}
        </button>
      </div>

      <form v-if="canManage" class="managed-create-form" @submit.prevent="createEndpoint">
        <h3 class="managed-group-title">{{ msg.createTitle }}</h3>
        <label class="field">
          <span>{{ msg.createLabel }}</span>
          <input
            v-model="createLabel"
            data-testid="managed-create-label"
            type="text"
            maxlength="160"
            required
          />
        </label>
        <label class="field">
          <span>{{ msg.createKind }}</span>
          <select v-model="createKind" data-testid="managed-create-kind">
            <option value="workstation">{{ msg.kindWorkstation }}</option>
            <option value="shared">{{ msg.kindShared }}</option>
          </select>
        </label>
        <button
          class="tool-button"
          data-testid="managed-create-submit"
          type="submit"
          :disabled="Boolean(actionBusy) || !createLabel.trim()"
        >
          {{ msg.createSubmit }}
        </button>
      </form>

      <ConsoleInlineAlert v-if="errorText" tone="danger" dismissible @dismiss="error = ''">
        {{ errorText }}
      </ConsoleInlineAlert>

      <section v-if="enrollmentToken" class="managed-enrollment surface-card">
        <h3 class="managed-group-title">{{ msg.enrollmentTitle }}</h3>
        <p class="section-subtitle">{{ msg.enrollmentDescription }}</p>
        <div class="managed-enrollment-row">
          <input
            class="managed-enrollment-value"
            data-testid="managed-enrollment-token"
            :type="tokenRevealed ? 'text' : 'password'"
            :value="maskedToken"
            readonly
            autocomplete="off"
          />
          <button
            class="tool-button-ghost"
            type="button"
            @click="tokenRevealed ? hideToken() : revealToken()"
          >
            {{ tokenRevealed ? msg.enrollmentHide : msg.enrollmentReveal }}
          </button>
          <button class="tool-button-ghost" type="button" @click="copyToken">
            {{ tokenCopied ? msg.enrollmentCopied : msg.enrollmentCopy }}
          </button>
          <button class="tool-button-ghost" type="button" @click="dismissToken">
            {{ msg.enrollmentDismiss }}
          </button>
        </div>
      </section>

      <section v-if="orgPendingPermissions.length" class="managed-permissions-inbox">
        <h3 class="managed-group-title">{{ msg.pendingApprovals }}</h3>
        <div
          v-for="permission in orgPendingPermissions"
          :key="permission.permissionId"
          class="managed-permission"
        >
          <p class="section-subtitle">
            {{ msg.permissionSession }}: {{ permission.prompt.sessionId }} ·
            {{ msg.labelTaskId }}: {{ permission.taskId }}
          </p>
          <pre class="managed-schema">{{ jsonText(permission.prompt.toolCall) }}</pre>
          <p v-if="!canApprove" class="section-subtitle">{{ msg.permissionReadonly }}</p>
          <div v-if="canApprove" class="horizontal-action-group">
            <button
              v-for="option in permission.prompt.options"
              :key="option.optionId"
              class="tool-button"
              :data-testid="`managed-inbox-option-${option.name}`"
              type="button"
              :disabled="Boolean(actionBusy)"
              @click="resolvePendingPermission(permission, option)"
            >
              {{ option.name }}
            </button>
          </div>
          <ul v-else class="managed-permission-options">
            <li v-for="option in permission.prompt.options" :key="option.optionId">
              {{ option.name }}
            </li>
          </ul>
        </div>
      </section>

      <ConsoleEmptyState
        v-if="!loading && !endpoints.length"
        :title="msg.emptyTitle"
        :description="msg.emptyDescription"
      />

      <div v-if="endpoints.length" class="managed-endpoints-master-detail">
        <nav class="managed-device-list" :aria-label="msg.devices">
          <button
            v-for="endpoint in endpoints"
            :key="endpoint.endpointId"
            class="managed-device-item"
            :class="{ 'is-active': endpoint.endpointId === selectedEndpointId }"
            :data-testid="`managed-device-${endpoint.endpointId}`"
            type="button"
            @click="selectEndpoint(endpoint.endpointId)"
          >
            <span class="managed-device-label">{{ endpoint.label }}</span>
            <StatusPill :label="endpointStateLabel(endpoint.state)" :tone="endpointStateTone(endpoint.state)" />
            <span class="managed-device-meta">
              {{ endpoint.kind === 'shared' ? msg.kindShared : msg.kindWorkstation }} ·
              {{ endpoint.publishedCapabilities.length }} {{ msg.capabilities }} ·
              {{ lastContactLabel(endpoint.endpointId) }}
            </span>
          </button>
        </nav>

        <section v-if="selectedEndpoint" class="managed-detail">
          <div class="section-header">
            <div>
              <h3>{{ msg.detail }} · {{ selectedEndpoint.label }}</h3>
              <p class="section-subtitle">
                {{ msg.kind }}: {{ selectedEndpoint.kind === 'shared' ? msg.kindShared : msg.kindWorkstation }} ·
                {{ msg.state }}: {{ endpointStateLabel(selectedEndpoint.state) }} ·
                {{ msg.generation }}: {{ selectedEndpoint.generation }} ·
                {{ msg.lastContact }}: {{ lastContactLabel(selectedEndpoint.endpointId) }}
              </p>
            </div>
            <button
              v-if="canManage && selectedEndpoint.state !== 'revoked'"
              class="tool-button-ghost is-danger"
              type="button"
              :disabled="Boolean(actionBusy)"
              @click="revokeEndpoint"
            >
              {{ msg.revoke }}
            </button>
          </div>

          <form v-if="canManage && selectedEndpoint.state !== 'revoked'" class="managed-policy" @submit.prevent="savePolicy">
            <h4 class="managed-group-title">{{ msg.policyTitle }}</h4>
            <label class="field">
              <span>{{ msg.createLabel }}</span>
              <input v-model="editLabel" type="text" maxlength="160" required />
            </label>
            <fieldset class="managed-capabilities">
              <legend>{{ msg.policyAllowed }}</legend>
              <label
                v-for="capability in publishedCapabilities"
                :key="capability.capabilityId"
                class="managed-capability-toggle"
              >
                <input
                  type="checkbox"
                  :checked="allowedIds.includes(capability.capabilityId)"
                  :data-testid="`managed-capability-toggle-${capability.capabilityId}`"
                  @change="toggleAllowed(capability.capabilityId)"
                />
                <span>{{ capability.label }} ({{ capability.capabilityId }} · {{ msg.capabilityRevision }} {{ capability.revision }})</span>
              </label>
              <ConsoleEmptyState
                v-if="!publishedCapabilities.length"
                :title="msg.capabilityNotPublished"
                compact
              />
            </fieldset>
            <div v-if="unpublishedAllowed.length" class="managed-unpublished">
              <p class="section-subtitle">{{ msg.policyUnpublished }}</p>
              <span v-for="id in unpublishedAllowed" :key="id" class="managed-unpublished-chip">
                {{ id }}
                <button
                  class="tool-button-ghost"
                  type="button"
                  :aria-label="`${msg.policyRemoveUnpublished} ${id}`"
                  @click="removeAllowed(id)"
                >
                  {{ msg.policyRemoveUnpublished }}
                </button>
              </span>
            </div>
            <button
              class="tool-button"
              data-testid="managed-policy-save"
              type="submit"
              :disabled="Boolean(actionBusy)"
            >
              {{ msg.policySave }}
            </button>
          </form>

          <section class="managed-catalog">
            <h4 class="managed-group-title">{{ msg.capabilityCatalog }}</h4>
            <details v-for="capability in publishedCapabilities" :key="capability.capabilityId" class="managed-capability">
              <summary>{{ capability.label }} ({{ capability.capabilityId }})</summary>
              <pre class="managed-schema">{{ jsonText(capability.inputSchema) }}</pre>
            </details>
          </section>

          <section v-if="publishedWorkspaces.length" class="managed-catalog">
            <h4 class="managed-group-title">{{ msg.workspacesTitle }}</h4>
            <details v-for="workspace in publishedWorkspaces" :key="workspace.workspaceId" class="managed-capability">
              <summary>{{ workspace.label }} ({{ workspace.workspaceId }})</summary>
              <pre v-if="workspace.hint !== undefined" class="managed-schema">{{ jsonText(workspace.hint) }}</pre>
            </details>
          </section>

          <form
            v-if="canExecute && selectedEndpoint.state === 'active' && allowedPublished.length"
            class="managed-submit"
            @submit.prevent="submitTask"
          >
            <h4 class="managed-group-title">{{ msg.taskSubmitTitle }}</h4>
            <label class="field">
              <span>{{ msg.taskCapability }}</span>
              <select v-model="capabilityId" data-testid="managed-task-capability">
                <option
                  v-for="capability in allowedPublished"
                  :key="capability.capabilityId"
                  :value="capability.capabilityId"
                >
                  {{ capability.label }} ({{ capability.capabilityId }})
                </option>
              </select>
            </label>
            <label v-if="publishedWorkspaces.length" class="field">
              <span>{{ msg.taskWorkspace }}</span>
              <select v-model="workspaceId" data-testid="managed-task-workspace">
                <option value="">{{ msg.workspaceNone }}</option>
                <option
                  v-for="workspace in publishedWorkspaces"
                  :key="workspace.workspaceId"
                  :value="workspace.workspaceId"
                >
                  {{ workspace.label }} ({{ workspace.workspaceId }})
                </option>
              </select>
            </label>
            <label class="field">
              <span>{{ msg.taskInput }}</span>
              <textarea
                v-model="inputText"
                data-testid="managed-task-input"
                rows="4"
                spellcheck="false"
              ></textarea>
            </label>
            <button
              class="tool-button"
              data-testid="managed-task-submit"
              type="submit"
              :disabled="!canSubmitTask"
            >
              {{ msg.taskSubmit }}
            </button>
          </form>

          <section class="managed-tasks">
            <h4 class="managed-group-title">{{ msg.tasks }}</h4>
            <ConsoleEmptyState v-if="!endpointTasks.length" :title="msg.taskSelect" compact />
            <button
              v-for="task in endpointTasks"
              :key="task.taskId"
              class="managed-task-item"
              :class="{ 'is-active': task.taskId === selectedTaskId }"
              type="button"
              @click="selectTask(task.taskId)"
            >
              <span>{{ task.capabilityId }}</span>
              <StatusPill :label="taskStateLabel(task.state)" :tone="taskStateTone(task.state)" />
              <span class="managed-device-meta">{{ formatCompactDate(new Date(task.createdAtMs).toISOString()) }}</span>
            </button>
          </section>

          <section v-if="taskDetail" class="managed-task-detail">
            <div class="section-header">
              <h4 class="managed-group-title">
                {{ taskDetail.task.capabilityId }} ·
                <StatusPill :label="taskStateLabel(taskDetail.task.state)" :tone="taskStateTone(taskDetail.task.state)" />
              </h4>
              <div class="horizontal-action-group">
                <button
                  class="tool-button-ghost"
                  data-testid="managed-task-refresh"
                  type="button"
                  :disabled="Boolean(actionBusy)"
                  @click="refreshTaskDetail"
                >
                  {{ msg.taskRefresh }}
                </button>
                <button
                  v-if="canExecute && cancellableTask"
                  class="tool-button-ghost is-danger"
                  type="button"
                  :disabled="Boolean(actionBusy)"
                  @click="cancelTask"
                >
                  {{ msg.taskCancel }}
                </button>
              </div>
            </div>

            <dl class="managed-task-meta">
              <dt>{{ msg.labelRequester }}</dt>
              <dd>{{ taskDetail.task.requester?.subjectId }}</dd>
              <dt>{{ msg.labelTaskId }}</dt>
              <dd>{{ taskDetail.task.taskId }}</dd>
              <dt>{{ msg.capabilityRevision }}</dt>
              <dd>{{ taskDetail.task.capabilityRevision }}</dd>
              <template v-if="taskDetail.task.workspaceId">
                <dt>{{ msg.taskWorkspace }}</dt>
                <dd>{{ taskDetail.task.workspaceId }}</dd>
              </template>
              <dt>{{ msg.labelCreated }}</dt>
              <dd>{{ formatCompactDate(new Date(taskDetail.task.createdAtMs).toISOString()) }}</dd>
              <dt>{{ msg.labelUpdated }}</dt>
              <dd>{{ formatCompactDate(new Date(taskDetail.task.updatedAtMs).toISOString()) }}</dd>
              <template v-if="taskDetail.task.errorCode">
                <dt>{{ msg.labelErrorCode }}</dt>
                <dd data-testid="managed-task-errorcode">{{ taskDetail.task.errorCode }}</dd>
              </template>
            </dl>

            <section v-if="pendingPermission" class="managed-permission">
              <h5 class="managed-group-title">{{ msg.permissionTitle }} · {{ msg.permissionPending }}</h5>
              <p>{{ msg.permissionSession }}: {{ pendingPermission.prompt.sessionId }}</p>
              <p>{{ msg.permissionTool }}:</p>
              <pre class="managed-schema" data-testid="managed-permission-toolcall">{{ jsonText(pendingPermission.prompt.toolCall) }}</pre>
              <p v-if="!canApprove" class="section-subtitle">{{ msg.permissionReadonly }}</p>
              <div v-if="canApprove" class="horizontal-action-group">
                <button
                  v-for="option in pendingPermission.prompt.options"
                  :key="option.optionId"
                  class="tool-button"
                  :data-testid="`managed-permission-option-${option.name}`"
                  type="button"
                  :disabled="Boolean(actionBusy)"
                  @click="resolvePermission(option)"
                >
                  {{ option.name }}
                </button>
              </div>
              <ul v-else class="managed-permission-options">
                <li
                  v-for="option in pendingPermission.prompt.options"
                  :key="option.optionId"
                >
                  {{ option.name }}
                </li>
              </ul>
            </section>

            <template v-if="hasProgress">
              <h5 class="managed-group-title">{{ msg.taskProgress }}</h5>
              <pre class="managed-schema" data-testid="managed-task-progress">{{ previewText(taskDetail.task.progress) }}</pre>
              <details v-if="isTruncated(taskDetail.task.progress)" class="managed-full-value">
                <summary>{{ msg.showFullValue }}</summary>
                <pre class="managed-schema">{{ jsonText(taskDetail.task.progress) }}</pre>
              </details>
            </template>
            <template v-if="hasResult">
              <h5 class="managed-group-title">{{ msg.taskResult }}</h5>
              <pre class="managed-schema" data-testid="managed-task-result">{{ previewText(taskDetail.task.result) }}</pre>
              <details v-if="isTruncated(taskDetail.task.result)" class="managed-full-value">
                <summary>{{ msg.showFullValue }}</summary>
                <pre class="managed-schema">{{ jsonText(taskDetail.task.result) }}</pre>
              </details>
            </template>

            <section class="managed-events">
              <div class="section-header">
                <h5 class="managed-group-title">{{ msg.eventsTitle }}</h5>
                <div class="horizontal-action-group">
                  <button
                    class="tool-button-ghost"
                    data-testid="managed-events-refresh"
                    type="button"
                    :disabled="eventsBusy"
                    @click="refreshTaskEvents"
                  >
                    {{ eventsBusy ? msg.refreshBusy : msg.eventsRefresh }}
                  </button>
                  <button
                    class="tool-button-ghost"
                    data-testid="managed-events-follow"
                    type="button"
                    @click="toggleTaskEventFollow"
                  >
                    {{ eventsFollowing ? msg.eventsStop : msg.eventsFollow }}
                  </button>
                </div>
              </div>
              <ConsoleEmptyState v-if="!taskEvents.length" :title="msg.eventsEmpty" compact />
              <ol v-else class="managed-event-list">
                <li v-for="event in taskEvents" :key="event.seq" class="managed-event-item">
                  <div class="managed-event-head">
                    <span class="managed-event-seq">#{{ event.seq }}</span>
                    <span class="managed-event-kind">{{ event.kind }}</span>
                    <span class="managed-device-meta">{{ formatCompactDate(event.at) }}</span>
                  </div>
                  <pre class="managed-schema">{{ previewText(event.payload) }}</pre>
                  <details v-if="isTruncated(event.payload)" class="managed-full-value">
                    <summary>{{ msg.showFullValue }}</summary>
                    <pre class="managed-schema">{{ jsonText(event.payload) }}</pre>
                  </details>
                </li>
              </ol>
            </section>
          </section>
        </section>
      </div>
    </section>
  </section>
</template>

<style scoped>
.managed-endpoints-layout {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}
.section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.section-subtitle {
  color: var(--console-ink-secondary);
  font-size: var(--text-sm);
  margin: 0;
}
.managed-group-title {
  font-size: var(--text-md);
  margin: 0;
}
.managed-create-form,
.managed-policy,
.managed-submit {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--console-rule);
}
.managed-create-form > button,
.managed-policy > button,
.managed-submit > button {
  align-self: flex-start;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-sm);
}
.managed-enrollment {
  padding: var(--space-3);
}
.managed-enrollment-row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
}
.managed-enrollment-value {
  flex: 1 1 16rem;
  font-family: var(--font-mono, monospace);
}
.managed-endpoints-master-detail {
  display: grid;
  grid-template-columns: minmax(14rem, 18rem) minmax(0, 1fr);
  gap: var(--space-4);
  min-width: 0;
  align-items: start;
}
.managed-device-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  position: sticky;
  top: var(--space-3);
}
.managed-device-item,
.managed-task-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--console-rule);
  border-radius: var(--radius-md);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.managed-device-item.is-active,
.managed-task-item.is-active {
  border-color: var(--console-accent, currentColor);
}
.managed-device-label {
  font-weight: 600;
}
.managed-device-meta {
  color: var(--console-ink-secondary);
  font-size: var(--text-xs);
}
.managed-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}
.managed-capabilities {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border: 1px solid var(--console-rule);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}
.managed-capability-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.managed-capability-toggle input[type="checkbox"] {
  width: auto;
  flex: 0 0 auto;
  margin: 0;
}
.managed-unpublished {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.managed-unpublished-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
.managed-catalog,
.managed-tasks,
.managed-task-detail,
.managed-events,
.managed-permissions-inbox,
.managed-permission {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border-top: 1px solid var(--console-rule);
  padding-top: var(--space-3);
}
.managed-event-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.managed-event-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.managed-event-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.managed-event-seq {
  font-family: var(--font-mono, monospace);
  font-size: var(--text-xs);
  color: var(--console-ink-secondary);
}
.managed-event-kind {
  font-family: var(--font-mono, monospace);
  font-size: var(--text-xs);
}
.managed-task-meta {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  margin: 0;
  font-size: var(--text-sm);
}
.managed-task-meta dt {
  color: var(--console-ink-secondary);
}
.managed-task-meta dd {
  margin: 0;
  word-break: break-all;
}
.managed-permission-options {
  margin: 0;
  padding-inline-start: var(--space-5);
}
.managed-schema {
  max-height: 12rem;
  overflow: auto;
  border: 1px solid var(--console-rule);
  border-radius: var(--radius-md);
  padding: var(--space-2);
  font-size: var(--text-xs);
  white-space: pre-wrap;
  word-break: break-word;
}
.managed-full-value summary {
  cursor: pointer;
  color: var(--console-ink-secondary);
  font-size: var(--text-xs);
}
@media (max-width: 640px) {
  .managed-endpoints-master-detail {
    grid-template-columns: minmax(0, 1fr);
  }
  .managed-device-list {
    position: static;
  }
}
</style>
