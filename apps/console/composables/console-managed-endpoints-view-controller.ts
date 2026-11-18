import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from "vue";
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import type {
  ManagedCapability,
  ManagedEndpoint,
  ManagedTaskEvent,
  ManagedWorkspace,
} from "@meshrix/contracts/managed-endpoints";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  managedEndpointsClient,
  type ManagedInventory,
  type ManagedPermissionView,
  type ManagedTaskDetail,
} from "../lib/managed-endpoints-client";
import { consoleMessages, currentConsoleLocale } from "../i18n/console";
import { confirmConsoleAction } from "./console-browser-effects";
import { buildGovernedConfirmPayload } from "./console-governed-confirm-payload";

export type ManagedEndpointsAccess = {
  authenticated: Readonly<Ref<boolean>>;
  subject: Readonly<Ref<unknown>>;
  scopes: Readonly<Ref<readonly string[]>>;
  featureIds: Readonly<Ref<readonly string[]>>;
};

const REQUIRED_FEATURE = "work-queue-core";
const EVENTS_FOLLOW_WAIT_SECONDS = 30;
const TASK_EVENT_TERMINAL_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
  "in_doubt",
]);

export function useManagedEndpointsViewController(options: {
  client?: typeof managedEndpointsClient;
  access: ManagedEndpointsAccess;
}) {
  const client = options.client ?? managedEndpointsClient;
  const { access } = options;

  const inventory = shallowRef<ManagedInventory | null>(null);
  const selectedEndpointId = ref("");
  const selectedTaskId = ref("");
  const taskDetail = shallowRef<ManagedTaskDetail | null>(null);
  const loading = ref(false);
  const actionBusy = ref("");
  const error = ref("");
  const createLabel = ref("");
  const createKind = ref<"workstation" | "shared">("workstation");
  const editLabel = ref("");
  const allowedIds = ref<string[]>([]);
  const capabilityId = ref("");
  const workspaceId = ref("");
  const inputText = ref("{}");
  const enrollmentToken = ref("");
  const tokenRevealed = ref(false);
  const tokenCopied = ref(false);
  const pendingSubmission = ref<{ intent: string; requestId: string } | null>(null);
  const taskEvents = shallowRef<ManagedTaskEvent[]>([]);
  const eventLastSeq = ref(0);
  const eventsBusy = ref(false);
  const eventsFollowing = ref(false);

  let disposed = false;
  let epoch = 0;
  let taskGeneration = 0;
  let eventsGeneration = 0;
  let eventsAbort: AbortController | null = null;
  let refreshInFlight: { mark: number; snap: string; promise: Promise<void> } | null = null;

  const scopeSet = computed(() => new Set(access.scopes.value));
  const featureSet = computed(() => new Set(access.featureIds.value));
  const hasScope = (scope: string) => scopeSet.value.has(scope);
  const canLoad = computed(
    () =>
      access.authenticated.value &&
      hasScope("endpoints:read") &&
      featureSet.value.has(REQUIRED_FEATURE),
  );
  const canManage = computed(() => canLoad.value && hasScope("endpoints:manage"));
  const canExecute = computed(() => canLoad.value && hasScope("endpoints:execute"));
  const canApprove = computed(() => canLoad.value && hasScope("endpoints:approve"));

  const authSnapshot = computed(() =>
    JSON.stringify({
      authed: access.authenticated.value,
      subject: access.subject.value ?? null,
      scopes: [...access.scopes.value].sort(),
      features: [...access.featureIds.value].sort(),
    }),
  );

  function still(mark: number, snap: string): boolean {
    return !disposed && epoch === mark && authSnapshot.value === snap;
  }

  function guarded(mark: number, snap: string, assign: () => void): void {
    if (still(mark, snap)) assign();
  }

  const endpoints = computed<ManagedEndpoint[]>(() => inventory.value?.endpoints ?? []);
  const observations = computed((): Record<string, number | null> => {
    const source: any = inventory.value;
    const out: Record<string, number | null> = {};
    for (const row of source?.observations ?? []) {
      out[row.endpointId] = row.lastContactAtMs;
    }
    return out;
  });
  const selectedEndpoint = computed(
    () => endpoints.value.find((endpoint) => endpoint.endpointId === selectedEndpointId.value) ?? null,
  );
  const endpointTasks = computed(() =>
    (inventory.value?.tasks ?? [])
      .filter((task) => task.endpointId === selectedEndpointId.value)
      .sort((a, b) => b.createdAtMs - a.createdAtMs),
  );
  const publishedCapabilities = computed(
    (): readonly ManagedCapability[] => selectedEndpoint.value?.publishedCapabilities ?? [],
  );
  const allowedPublished = computed(() =>
    publishedCapabilities.value.filter((capability) =>
      selectedEndpoint.value?.allowedCapabilityIds.includes(capability.capabilityId),
    ),
  );
  const unpublishedAllowed = computed(() =>
    allowedIds.value.filter(
      (id) => !publishedCapabilities.value.some((capability) => capability.capabilityId === id),
    ),
  );
  const publishedWorkspaces = computed(
    (): readonly ManagedWorkspace[] => selectedEndpoint.value?.publishedWorkspaces ?? [],
  );
  const pendingPermission = computed<ManagedPermissionView | null>(
    () => taskDetail.value?.pendingPermission ?? null,
  );
  const orgPendingPermissions = computed<ManagedPermissionView[]>(
    () => inventory.value?.pendingPermissions ?? [],
  );

  function clearSensitive(): void {
    enrollmentToken.value = "";
    tokenRevealed.value = false;
    tokenCopied.value = false;
    pendingSubmission.value = null;
  }

  function resetTaskEvents(): void {
    eventsAbort?.abort();
    eventsAbort = null;
    eventsGeneration += 1;
    taskEvents.value = [];
    eventLastSeq.value = 0;
    eventsBusy.value = false;
    eventsFollowing.value = false;
  }

  function clearContext(): void {
    clearSensitive();
    resetTaskEvents();
    inventory.value = null;
    selectedEndpointId.value = "";
    selectedTaskId.value = "";
    taskDetail.value = null;
    createLabel.value = "";
    createKind.value = "workstation";
    editLabel.value = "";
    allowedIds.value = [];
    capabilityId.value = "";
    workspaceId.value = "";
    inputText.value = "{}";
    loading.value = false;
    actionBusy.value = "";
    error.value = "";
  }

  async function refresh(): Promise<void> {
    const mark = epoch;
    const snap = authSnapshot.value;
    if (refreshInFlight && refreshInFlight.mark === mark && refreshInFlight.snap === snap) {
      return refreshInFlight.promise;
    }
    if (disposed || !canLoad.value) return;
    loading.value = true;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const next = await client.list();
        guarded(mark, snap, () => {
          inventory.value = next;
          error.value = "";
          if (
            selectedEndpointId.value &&
            !next.endpoints.some((endpoint) => endpoint.endpointId === selectedEndpointId.value)
          ) {
            selectedEndpointId.value = "";
            selectedTaskId.value = "";
            taskDetail.value = null;
            taskGeneration += 1;
            resetTaskEvents();
          }
        });
      } catch {
        guarded(mark, snap, () => {
          error.value = "loadFailed";
        });
      } finally {
        guarded(mark, snap, () => {
          loading.value = false;
        });
        if (refreshInFlight?.promise === promise) {
          refreshInFlight = null;
        }
      }
    })();
    refreshInFlight = { mark, snap, promise };
    return promise;
  }

  function syncDraftFromSelection(): void {
    const endpoint = selectedEndpoint.value;
    editLabel.value = endpoint?.label ?? "";
    allowedIds.value = [...(endpoint?.allowedCapabilityIds ?? [])];
    const first = allowedPublished.value[0];
    if (!allowedPublished.value.some((capability) => capability.capabilityId === capabilityId.value)) {
      capabilityId.value = first?.capabilityId ?? "";
    }
    if (!publishedWorkspaces.value.some((workspace) => workspace.workspaceId === workspaceId.value)) {
      workspaceId.value = "";
    }
  }

  function selectEndpoint(endpointId: string): void {
    if (selectedEndpointId.value !== endpointId) {
      taskDetail.value = null;
      selectedTaskId.value = "";
      taskGeneration += 1;
      resetTaskEvents();
    }
    selectedEndpointId.value = endpointId;
    syncDraftFromSelection();
  }

  async function loadTaskDetail(taskId: string): Promise<void> {
    if (!canLoad.value) return;
    const mark = epoch;
    const snap = authSnapshot.value;
    const generation = ++taskGeneration;
    const endpointAtRequest = selectedEndpointId.value;
    try {
      const detail = await client.task(taskId);
      if (generation !== taskGeneration || !still(mark, snap)) return;
      if (selectedTaskId.value !== taskId || detail.task.taskId !== taskId) return;
      if (selectedEndpointId.value !== endpointAtRequest) return;
      if (endpointAtRequest && detail.task.endpointId !== endpointAtRequest) return;
      taskDetail.value = detail;
      const current: any = inventory.value;
      if (current && current.tasks.some((task: any) => task.taskId === taskId)) {
        inventory.value = {
          ...current,
          tasks: current.tasks.map((task: any) => (task.taskId === taskId ? detail.task : task)),
        };
      }
    } catch {
      if (generation !== taskGeneration) return;
      guarded(mark, snap, () => {
        error.value = "actionFailed";
      });
    }
  }

  function selectTask(taskId: string): void {
    if (selectedTaskId.value !== taskId) {
      taskDetail.value = null;
      taskGeneration += 1;
      resetTaskEvents();
    }
    selectedTaskId.value = taskId;
    if (taskId) {
      void loadTaskDetail(taskId);
      void loadTaskEvents(taskId);
    }
  }

  async function refreshTaskDetail(): Promise<void> {
    const taskId = selectedTaskId.value;
    if (!taskId) return;
    await loadTaskDetail(taskId);
  }

  async function pullTaskEvents(
    taskId: string,
    { after, wait, signal }: { after: number; wait?: number; signal?: AbortSignal },
  ): Promise<boolean> {
    const generation = eventsGeneration;
    const mark = epoch;
    const snap = authSnapshot.value;
    try {
      const result = await client.events(taskId, { after, wait }, { signal });
      if (
        generation !== eventsGeneration ||
        !still(mark, snap) ||
        selectedTaskId.value !== taskId ||
        result.taskId !== taskId
      ) {
        return false;
      }
      const merged = new Map<number, ManagedTaskEvent>(
        taskEvents.value.map((event) => [event.seq, event]),
      );
      for (const event of result.events ?? []) merged.set(event.seq, event);
      taskEvents.value = [...merged.values()].sort((a, b) => a.seq - b.seq);
      eventLastSeq.value = Math.max(eventLastSeq.value, Number(result.lastSeq) || 0);
      return true;
    } catch {
      if (signal?.aborted) return false;
      if (generation !== eventsGeneration || !still(mark, snap)) return false;
      error.value = "actionFailed";
      return false;
    }
  }

  async function loadTaskEvents(taskId: string): Promise<void> {
    if (!canLoad.value) return;
    const generation = eventsGeneration;
    const mark = epoch;
    const snap = authSnapshot.value;
    eventsBusy.value = true;
    try {
      await pullTaskEvents(taskId, { after: 0, wait: 0 });
    } finally {
      if (generation === eventsGeneration && still(mark, snap)) {
        eventsBusy.value = false;
      }
    }
  }

  async function refreshTaskEvents(): Promise<void> {
    const taskId = selectedTaskId.value;
    if (!taskId || eventsBusy.value) return;
    await loadTaskEvents(taskId);
  }

  async function followTaskEvents(): Promise<void> {
    const taskId = selectedTaskId.value;
    if (!taskId || eventsFollowing.value || !canLoad.value) return;
    const generation = eventsGeneration;
    const mark = epoch;
    const snap = authSnapshot.value;
    const controller = new AbortController();
    eventsAbort = controller;
    eventsFollowing.value = true;
    try {
      while (
        eventsFollowing.value &&
        generation === eventsGeneration &&
        still(mark, snap) &&
        canLoad.value &&
        selectedTaskId.value === taskId &&
        !TASK_EVENT_TERMINAL_STATES.has(String(taskDetail.value?.task.state ?? ""))
      ) {
        const ok = await pullTaskEvents(taskId, {
          after: eventLastSeq.value,
          wait: EVENTS_FOLLOW_WAIT_SECONDS,
          signal: controller.signal,
        });
        if (!ok) break;
        await loadTaskDetail(taskId);
      }
    } finally {
      if (generation === eventsGeneration && eventsAbort === controller) {
        eventsAbort = null;
        eventsFollowing.value = false;
      }
    }
  }

  function toggleTaskEventFollow(): void {
    if (eventsFollowing.value) {
      eventsFollowing.value = false;
      eventsAbort?.abort();
      return;
    }
    void followTaskEvents();
  }

  async function confirmManaged(effectKey: string, resource: string, risk: string): Promise<boolean> {
    const group = (
      consoleMessages[currentConsoleLocale.value] ?? consoleMessages.en
    ).managedEndpoints as Record<string, string>;
    const copy = buildGovernedConfirmPayload(
      {
        effect: group[effectKey] ?? effectKey,
        resource,
        authority: "governedConfirm.authority.consoleSession",
        duration: "",
        risk,
      },
      currentConsoleLocale.value,
    );
    return confirmConsoleAction(copy.body, {
      title: copy.title,
      confirmLabel: copy.confirmLabel,
      tone: copy.tone,
    });
  }

  async function runAction(
    kind: string,
    allowed: Readonly<Ref<boolean>>,
    action: (mark: number, snap: string) => Promise<void>,
  ): Promise<void> {
    if (disposed || actionBusy.value) return;
    if (!allowed.value) {
      error.value = "scopeRequired";
      return;
    }
    const mark = epoch;
    const snap = authSnapshot.value;
    actionBusy.value = kind;
    error.value = "";
    try {
      await action(mark, snap);
    } finally {
      guarded(mark, snap, () => {
        actionBusy.value = "";
      });
    }
  }

  async function createEndpoint(): Promise<void> {
    const label = createLabel.value.trim();
    const kind = createKind.value;
    await runAction("create", canManage, async (mark, snap) => {
      try {
        const result = await client.create({
          label,
          kind,
          allowedCapabilityIds: [],
        });
        guarded(mark, snap, () => {
          enrollmentToken.value = result.enrollmentToken;
          tokenRevealed.value = false;
          tokenCopied.value = false;
          createLabel.value = "";
        });
        if (!still(mark, snap)) return;
        await refresh();
        if (!still(mark, snap)) return;
        selectEndpoint(result.endpoint.endpointId);
      } catch {
        guarded(mark, snap, () => {
          error.value = "createLostWarning";
        });
      }
    });
  }

  function toggleAllowed(id: string): void {
    allowedIds.value = allowedIds.value.includes(id)
      ? allowedIds.value.filter((entry) => entry !== id)
      : [...allowedIds.value, id];
  }

  function removeAllowed(id: string): void {
    allowedIds.value = allowedIds.value.filter((entry) => entry !== id);
  }

  async function savePolicy(): Promise<void> {
    const endpoint = selectedEndpoint.value;
    if (!endpoint) return;
    const label = editLabel.value.trim() || endpoint.label;
    const ids = [...allowedIds.value];
    await runAction("save", canManage, async (mark, snap) => {
      try {
        await client.update(endpoint.endpointId, { label, allowedCapabilityIds: ids });
      } catch {
        guarded(mark, snap, () => {
          error.value = "actionFailed";
        });
        return;
      }
      if (!still(mark, snap)) return;
      await refresh();
    });
  }

  async function revokeEndpoint(): Promise<void> {
    const endpoint = selectedEndpoint.value;
    if (!endpoint) return;
    const resource = `${endpoint.label} (${endpoint.endpointId})`;
    await runAction("revoke", canManage, async (mark, snap) => {
      const confirmed = await confirmManaged("confirmRevokeEffect", resource, "repair_write");
      if (!confirmed || !still(mark, snap) || !canManage.value) return;
      try {
        await client.revoke(endpoint.endpointId);
      } catch {
        guarded(mark, snap, () => {
          error.value = "actionFailed";
        });
        return;
      }
      if (!still(mark, snap)) return;
      await refresh();
    });
  }

  function submissionIntent(
    endpointId: string,
    capability: string,
    workspace: string,
    input: unknown,
  ): string {
    return canonicalJson({ endpointId, capabilityId: capability, workspaceId: workspace, input });
  }

  async function submitTask(): Promise<void> {
    const endpoint = selectedEndpoint.value;
    if (!endpoint || disposed) return;
    if (!canExecute.value) {
      error.value = "scopeRequired";
      return;
    }
    const capability = capabilityId.value;
    if (
      endpoint.state !== "active" ||
      !capability ||
      !allowedPublished.value.some((entry) => entry.capabilityId === capability)
    ) {
      error.value = "capabilityUnavailable";
      return;
    }
    const workspace = workspaceId.value;
    if (
      workspace &&
      !publishedWorkspaces.value.some((entry) => entry.workspaceId === workspace)
    ) {
      error.value = "workspaceUnavailable";
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputText.value);
    } catch {
      error.value = "invalidJson";
      return;
    }
    const intent = submissionIntent(endpoint.endpointId, capability, workspace, parsed);
    if (pendingSubmission.value && pendingSubmission.value.intent !== intent) {
      pendingSubmission.value = null;
    }
    const requestId = pendingSubmission.value?.requestId ?? `mreq_${crypto.randomUUID()}`;
    const resource = `${endpoint.label} · ${capability}`;
    await runAction("submit", canExecute, async (mark, snap) => {
      const confirmed = await confirmManaged("confirmSubmitEffect", resource, "safe_write");
      if (!confirmed || !still(mark, snap) || !canExecute.value) return;
      try {
        const response = await client.submit({
          requestId,
          endpointId: endpoint.endpointId,
          capabilityId: capability,
          ...(workspace ? { workspaceId: workspace } : {}),
          input: parsed,
        });
        guarded(mark, snap, () => {
          pendingSubmission.value = null;
        });
        if (!still(mark, snap)) return;
        await refresh();
        if (!still(mark, snap)) return;
        if (selectedEndpointId.value === endpoint.endpointId) {
          selectTask(response.task.taskId);
        }
      } catch {
        guarded(mark, snap, () => {
          pendingSubmission.value = { intent, requestId };
          error.value = "actionFailed";
        });
      }
    });
  }

  async function cancelTask(): Promise<void> {
    const detail = taskDetail.value;
    if (!detail) return;
    const taskId = detail.task.taskId;
    const resource = `${detail.task.capabilityId} (${taskId})`;
    await runAction("cancel", canExecute, async (mark, snap) => {
      const confirmed = await confirmManaged("confirmCancelEffect", resource, "safe_write");
      if (!confirmed || !still(mark, snap) || !canExecute.value) return;
      try {
        await client.cancel(taskId);
      } catch {
        guarded(mark, snap, () => {
          error.value = "actionFailed";
        });
        return;
      }
      if (!still(mark, snap)) return;
      await refreshTaskDetail();
    });
  }

  async function resolvePermission(option: { optionId: string; name: string }): Promise<void> {
    const permission = pendingPermission.value;
    const detail = taskDetail.value;
    if (!permission || !detail) return;
    const taskId = detail.task.taskId;
    const permissionId = permission.permissionId;
    const selectedOptionId = option.optionId;
    const resource = `${option.name} · ${permission.prompt.toolCall?.title ?? detail.task.capabilityId}`;
    await runAction("resolve", canApprove, async (mark, snap) => {
      const confirmed = await confirmManaged("confirmResolveEffect", resource, "repair_write");
      if (!confirmed || !still(mark, snap) || !canApprove.value) return;
      try {
        await client.resolve(taskId, permissionId, selectedOptionId);
      } catch {
        guarded(mark, snap, () => {
          error.value = "actionFailed";
        });
        return;
      }
      if (!still(mark, snap)) return;
      await refreshTaskDetail();
    });
  }

  async function resolvePendingPermission(
    permission: ManagedPermissionView,
    option: { optionId: string; name: string },
  ): Promise<void> {
    const taskId = permission.taskId;
    const permissionId = permission.permissionId;
    const selectedOptionId = option.optionId;
    const resource = `${option.name} · ${permission.prompt?.toolCall?.title ?? taskId}`;
    await runAction("resolve", canApprove, async (mark, snap) => {
      const confirmed = await confirmManaged("confirmResolveEffect", resource, "repair_write");
      if (!confirmed || !still(mark, snap) || !canApprove.value) return;
      try {
        await client.resolve(taskId, permissionId, selectedOptionId);
      } catch {
        guarded(mark, snap, () => {
          error.value = "actionFailed";
        });
        return;
      }
      if (!still(mark, snap)) return;
      await refresh();
      if (!still(mark, snap)) return;
      if (selectedTaskId.value === taskId) {
        await refreshTaskDetail();
      }
    });
  }

  function revealToken(): void {
    tokenRevealed.value = true;
  }

  function hideToken(): void {
    tokenRevealed.value = false;
  }

  async function copyToken(): Promise<void> {
    const token = enrollmentToken.value;
    if (!token) return;
    const mark = epoch;
    const snap = authSnapshot.value;
    try {
      await navigator.clipboard.writeText(token);
      guarded(mark, snap, () => {
        if (enrollmentToken.value === token) tokenCopied.value = true;
      });
    } catch {
      guarded(mark, snap, () => {
        if (enrollmentToken.value === token) tokenCopied.value = false;
      });
    }
  }

  function dismissToken(): void {
    enrollmentToken.value = "";
    tokenRevealed.value = false;
    tokenCopied.value = false;
  }

  const unwatch = watch(
    authSnapshot,
    (next, previous) => {
      if (next === previous) return;
      epoch += 1;
      taskGeneration += 1;
      refreshInFlight = null;
      clearContext();
      if (canLoad.value) {
        void refresh();
      }
    },
    { flush: "sync" },
  );

  onMounted(() => {
    if (canLoad.value) void refresh();
  });

  usePageRefreshHandler(
    (detail: { viewId?: string; adminView?: string }) =>
      detail.viewId === "admin" && detail.adminView === "managedEndpoints",
    async () => {
      await refresh();
      if (selectedTaskId.value) {
        await loadTaskDetail(selectedTaskId.value);
        await loadTaskEvents(selectedTaskId.value);
      }
    },
  );

  onBeforeUnmount(() => {
    disposed = true;
    epoch += 1;
    taskGeneration += 1;
    unwatch();
    refreshInFlight = null;
    clearContext();
  });

  return {
    inventory,
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
    eventLastSeq,
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
    canLoad,
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
  };
}
