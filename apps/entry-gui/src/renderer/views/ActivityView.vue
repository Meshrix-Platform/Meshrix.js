<script setup lang="ts">
import { ref, watch } from "vue";

import type { GuiApplicationSummary, GuiState } from "../../shared/gui-state.ts";
import { runOp } from "../store.ts";

defineProps<{ state: GuiState }>();

interface PermissionOption { readonly optionId: string; readonly name: string; }
interface PendingPermission {
  readonly permissionRequestId: string;
  readonly title?: string;
  readonly toolCall?: {
    readonly title?: string;
    readonly name?: string;
    readonly content?: readonly { readonly type: string; readonly text?: string }[];
    readonly rawInput?: unknown;
    readonly locations?: readonly { readonly path: string; readonly line: number | null }[];
  };
  readonly options: readonly PermissionOption[];
}
interface ApplicationDetail {
  readonly operationId: string;
  readonly direction: string;
  readonly status: string;
  readonly transportStatus: string;
  readonly prompt: string;
  readonly targetAgentId: string;
  readonly result: unknown;
  readonly progress: { readonly sequence: number; readonly summary: string } | null;
  readonly permission: PendingPermission | null;
  readonly stopReason: string | null;
  readonly errorCode: string | null;
}

const selected = ref<ApplicationDetail | null>(null);
const chosen = ref<string>("");
const loadingId = ref<string | null>(null);
const busy = ref(false);

function formatPermissionInput(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}

function formatPermissionContent(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content.map((item) => item.text ?? item.type).join("\n");
}

async function openOperation(operationId: string): Promise<void> {
  loadingId.value = operationId;
  const result = await runOp<ApplicationDetail>("application.get", { operationId });
  if (result) {
    selected.value = result;
    chosen.value = result.permission?.options[0]?.optionId ?? "";
  }
  loadingId.value = null;
}

async function refresh(): Promise<void> {
  await runOp("application.list");
  if (selected.value) await openOperation(selected.value.operationId);
}

async function resolvePermission(outcome: "selected" | "cancelled"): Promise<void> {
  const current = selected.value;
  const permission = current?.permission;
  if (!current || !permission || (outcome === "selected" && !chosen.value)) return;
  busy.value = true;
  try {
    await runOp("application.resolvePermission", {
      operationId: current.operationId,
      permissionRequestId: permission.permissionRequestId,
      outcome,
      ...(outcome === "selected" ? { optionId: chosen.value } : {})
    });
    await openOperation(current.operationId);
  } finally {
    busy.value = false;
  }
}

async function cancel(operationId: string): Promise<void> {
  await runOp("application.cancel", { operationId });
  await openOperation(operationId);
}

function detailText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

watch(() => selected.value?.operationId, () => { chosen.value = ""; });
</script>

<template>
  <section class="card">
    <div class="title-row"><h2>Agent activity</h2><button class="plain" @click="refresh">Refresh</button></div>
    <p v-if="!state.applications.operations.length">No Agent tasks yet. Calls started by your MCP client will appear here and remain available after reconnects.</p>
    <article v-for="operation in state.applications.operations as readonly GuiApplicationSummary[]" :key="operation.operationId" class="operation">
      <div>
        <strong>{{ operation.agentLabel }}</strong>
        <span class="badge" :class="operation.status">{{ operation.status }}</span>
        <span class="badge">{{ operation.transportStatus }}</span>
        <div>{{ operation.direction }} → {{ operation.targetLabel }} · {{ operation.updatedAt }}</div>
      </div>
      <div class="row">
        <button class="plain" :disabled="loadingId === operation.operationId" @click="openOperation(operation.operationId)">Open details</button>
        <button v-if="['queued', 'sent', 'accepted', 'running', 'permission_required'].includes(operation.status)" class="danger" @click="cancel(operation.operationId)">Cancel</button>
      </div>
    </article>
  </section>

  <section v-if="selected" class="card">
    <h3>Task {{ selected.operationId }}</h3>
    <p><span class="badge">{{ selected.status }}</span> <span class="badge">{{ selected.transportStatus }}</span></p>
    <h4>Request</h4><pre>{{ selected.prompt }}</pre>
    <p v-if="selected.progress" class="progress">{{ selected.progress.summary }}</p>
    <section v-if="selected.permission" class="permission">
      <h4>Permission requested</h4>
      <p>{{ selected.permission.title ?? selected.permission.toolCall?.title ?? selected.permission.toolCall?.name ?? 'The Agent requested a tool permission.' }}</p>
      <div v-if="selected.permission.toolCall?.content?.length" class="permission-detail">
        <h5>Requested action details</h5>
        <pre>{{ formatPermissionContent(selected.permission.toolCall.content) }}</pre>
      </div>
      <div v-if="selected.permission.toolCall?.rawInput !== undefined && selected.permission.toolCall.rawInput !== null" class="permission-detail">
        <h5>Arguments</h5>
        <pre>{{ formatPermissionInput(selected.permission.toolCall.rawInput) }}</pre>
      </div>
      <div v-if="selected.permission.toolCall?.locations?.length" class="permission-detail">
        <h5>Requested files</h5>
        <ul>
          <li v-for="location in selected.permission.toolCall.locations" :key="`${location.path}:${location.line ?? ''}`">
            {{ location.path }}<span v-if="location.line !== null">:{{ location.line }}</span>
          </li>
        </ul>
      </div>
      <label class="field">Choose an action
        <select v-model="chosen">
          <option v-for="option in selected.permission.options" :key="option.optionId" :value="option.optionId">{{ option.name }}</option>
        </select>
      </label>
      <div class="row">
        <button class="primary" :disabled="busy || !chosen" @click="resolvePermission('selected')">Allow selected action</button>
        <button class="danger" :disabled="busy" @click="resolvePermission('cancelled')">Deny</button>
      </div>
    </section>
    <section v-if="selected.result !== null && selected.result !== undefined">
      <h4>Agent result</h4><pre>{{ detailText(selected.result) }}</pre>
    </section>
    <p v-if="selected.stopReason">{{ selected.stopReason }}</p>
    <p v-if="selected.errorCode" class="error">{{ selected.errorCode }}</p>
  </section>
</template>

<style scoped>
.title-row, .operation { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.operation { border-top: 1px solid #8885; padding: 0.7rem 0; }
.operation .row { margin: 0; }
.operation div div { font-size: 0.85rem; margin-top: 0.25rem; }
.hint { opacity: 0.7; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #8882; padding: 0.8rem; border-radius: 0.4rem; }
.progress { border-left: 3px solid #3457d5; padding-left: 0.6rem; }
.permission { border: 1px solid #c39421; border-radius: 0.5rem; padding: 0.8rem; }
.permission-detail { margin: 0.75rem 0; }
.permission-detail h5 { margin: 0 0 0.35rem; }
.field select { display: block; margin-top: 0.25rem; padding: 0.4rem; }
</style>
