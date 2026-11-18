import { getJson, postJson } from "@meshrix/ui-console/bridge-http";
import type {
  ManagedCapability,
  ManagedEndpoint,
  ManagedJson,
  ManagedTaskEvent,
  ManagedWorkspace,
} from "@meshrix/contracts/managed-endpoints";

export type {
  ManagedCapability,
  ManagedEndpoint,
  ManagedJson,
  ManagedTaskEvent,
  ManagedWorkspace,
};

export type ManagedTaskView = {
  taskId: string;
  requestId: string;
  tenantId: string;
  organizationId: string;
  endpointId: string;
  capabilityId: string;
  capabilityRevision: number;
  workspaceId?: string;
  input: ManagedJson;
  requester: { subjectId: string; tenantId: string; organizationId: string };
  workItemId: string;
  state: string;
  cancelRequested: boolean;
  progress: ManagedJson;
  result: ManagedJson;
  errorCode: string;
  createdAtMs: number;
  updatedAtMs: number;
  terminalAtMs: number;
};

export type ManagedPermissionView = {
  permissionId: string;
  taskId: string;
  state: string;
  prompt: {
    sessionId: string;
    toolCall: Record<string, unknown>;
    options: { optionId: string; name: string; kind: string }[];
  };
  selectedOptionId: string | null;
};

export type ManagedEndpointObservation = {
  endpointId: string;
  lastContactAtMs: number | null;
};

export type ManagedInventory = {
  endpoints: ManagedEndpoint[];
  tasks: ManagedTaskView[];
  observations: ManagedEndpointObservation[];
  pendingPermissions: ManagedPermissionView[];
};

export type ManagedTaskDetail = {
  task: ManagedTaskView;
  workItem: {
    workItemId: string;
    queueDefinitionId: string;
    state: string;
    lease: { leaseId: string; leaseSeq: number; expiresAtMs: number } | null;
    payloadRef: { taskId: string };
  } | null;
  pendingPermission: ManagedPermissionView | null;
};

export type ManagedTaskResponse = {
  task: ManagedTaskView;
  idempotent: boolean;
};

export type ManagedPermissionResponse = {
  permission: ManagedPermissionView;
  idempotent: boolean;
};

export type ManagedTaskEventsView = {
  taskId: string;
  after: number;
  lastSeq: number;
  events: ManagedTaskEvent[];
};

export const managedEndpointsClient = {
  list: (): Promise<ManagedInventory> => getJson("/api/endpoints"),
  create: (input: {
    label: string;
    kind: "workstation" | "shared";
    allowedCapabilityIds: string[];
  }): Promise<{ endpoint: ManagedEndpoint; enrollmentToken: string }> =>
    postJson("/api/endpoints", input),
  update: (
    endpointId: string,
    input: { label?: string; allowedCapabilityIds?: string[] },
  ): Promise<{ endpoint: ManagedEndpoint }> =>
    postJson(`/api/endpoints/${encodeURIComponent(endpointId)}`, input),
  revoke: (endpointId: string): Promise<{ endpoint: ManagedEndpoint }> =>
    postJson(
      `/api/endpoints/${encodeURIComponent(endpointId)}/revoke`,
      {},
      { safetyConfirm: true },
    ),
  submit: (input: {
    requestId: string;
    endpointId: string;
    capabilityId: string;
    workspaceId?: string;
    input: unknown;
  }): Promise<ManagedTaskResponse> =>
    postJson("/api/endpoints/tasks", input, { safetyConfirm: true }),
  task: (taskId: string): Promise<ManagedTaskDetail> =>
    getJson(`/api/endpoints/tasks/${encodeURIComponent(taskId)}`),
  events: (
    taskId: string,
    { after = 0, wait = 0 }: { after?: number; wait?: number } = {},
    request: { signal?: AbortSignal } = {},
  ): Promise<ManagedTaskEventsView> => {
    const params = new URLSearchParams();
    params.set("after", String(Math.max(0, Math.trunc(after))));
    if (wait > 0) params.set("wait", String(Math.min(60, Math.trunc(wait))));
    return getJson(
      `/api/endpoints/tasks/${encodeURIComponent(taskId)}/events?${params.toString()}`,
      request,
    );
  },
  cancel: (taskId: string): Promise<ManagedTaskResponse> =>
    postJson(
      `/api/endpoints/tasks/${encodeURIComponent(taskId)}/cancel`,
      {},
      { safetyConfirm: true },
    ),
  resolve: (
    taskId: string,
    permissionId: string,
    selectedOptionId: string,
  ): Promise<ManagedPermissionResponse> =>
    postJson(
      `/api/endpoints/tasks/${encodeURIComponent(taskId)}/permission`,
      { taskId, permissionId, selectedOptionId },
      { safetyConfirm: true },
    ),
};
