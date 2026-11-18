// Managed endpoint operations: organization member/admin surface and the
// device-worker surface of `meshrix.managed-endpoint/1`. Worker operations
// authenticate exclusively through the managed device credential verifier;
// member operations run through ordinary console session or scoped API-key
// authorization with endpoints:* scopes.

const DEVICE_WORKER_VERIFIER = {
  controller: "managedEndpoints",
  method: "verifyManagedEndpointWorkerAuth",
  recordUse: true
};

const ID = { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-z0-9][a-z0-9._:-]*$" };
const PERMISSION_ID = { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" };
const LEASE = {
  taskId: ID,
  leaseId: { type: "string", minLength: 8, maxLength: 160, pattern: "^[A-Za-z0-9._:-]+$" },
  leaseSeq: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
};
const closedInput = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", additionalProperties: false, properties, required
});
const capability = closedInput({
  capabilityId: ID, label: { type: "string", minLength: 1, maxLength: 160 },
  kind: { type: "string", enum: ["command", "agent"] },
  revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  inputSchema: { type: "object" }
}, ["capabilityId", "label", "kind", "revision", "inputSchema"]);
const capabilitySet = { type: "array", maxItems: 256, items: capability };
const leaseRequired = ["taskId", "leaseId", "leaseSeq"];
const WORKER_INPUTS: Record<string, any> = {
  "endpoints.worker.enroll": closedInput({
    enrollmentToken: { type: "string", pattern: "^met_[A-Za-z0-9_-]{20,}$", maxLength: 160 },
    deviceCredential: { type: "string", pattern: "^mdc_[A-Za-z0-9_-]{20,}$", maxLength: 160 },
    capabilities: capabilitySet
  }, ["enrollmentToken", "deviceCredential"]),
  "endpoints.worker.catalog": closedInput({ capabilities: capabilitySet, workspaces: {} }, ["capabilities"]),
  "endpoints.worker.poll": closedInput({
    batchSize: { type: "integer", minimum: 0, maximum: 8 },
    waitMs: { type: "integer", minimum: 0, maximum: 60000 },
    leaseTimeoutMs: { type: "integer", minimum: 5000, maximum: 300000 },
    acknowledgedPermissionIds: { type: "array", maxItems: 256, uniqueItems: true, items: PERMISSION_ID }
  }),
  "endpoints.worker.start": closedInput(LEASE, leaseRequired),
  "endpoints.worker.event": closedInput({ ...LEASE, events: {} }, [...leaseRequired, "events"]),
  "endpoints.worker.permission": closedInput({
    ...LEASE, permissionId: PERMISSION_ID, prompt: { type: "object" }
  }, [...leaseRequired, "permissionId", "prompt"]),
  "endpoints.worker.complete": closedInput({
    ...LEASE, state: { type: "string", enum: ["succeeded", "failed", "cancelled", "unknown"] },
    result: {}, errorCode: { type: "string", maxLength: 160 }
  }, [...leaseRequired, "state", "result"])
};
const MEMBER_INPUTS: Record<string, any> = {
  "endpoints.list": closedInput({}),
  "endpoints.tasks.get": closedInput({ taskId: ID }, ["taskId"]),
  "endpoints.tasks.events": closedInput({ taskId: ID, after: {}, wait: {} }, ["taskId"]),
  "endpoints.tasks.cancel": closedInput({ taskId: ID }, ["taskId"]),
  "endpoints.update": closedInput({
    endpointId: ID, label: { type: "string", minLength: 1, maxLength: 160 },
    allowedCapabilityIds: { type: "array", maxItems: 256, uniqueItems: true, items: ID }
  }, ["endpointId"]),
  "endpoints.revoke": closedInput({ endpointId: ID }, ["endpointId"])
};

export const MANAGED_ENDPOINT_OPERATION_DEFINITIONS: readonly any[] = Object.freeze([
  {
    id: "endpoints.worker.enroll",
    feature: "endpoints",
    label: "注册托管端点",
    target: { controller: "managedEndpoints", method: "handleEnroll" },
    http: { method: "POST", path: "/api/endpoints/enroll", localInForwardMode: true },
    rpc: { method: "endpoints.worker.enroll", body: "params" },
    safety: { readOnly: false, destructive: false, risk: "safe_write" },
    log: { recordInput: false, recordOutput: false },
    requiredScopes: [],
    externalAuth: true,
    externalAuthVerifier: {
      controller: "managedEndpoints",
      method: "verifyManagedEndpointEnrollmentAuth"
    }
  },
  {
    id: "endpoints.worker.catalog",
    feature: "endpoints",
    label: "托管端点能力目录",
    target: { controller: "managedEndpoints", method: "handleWorkerCatalog" },
    http: { method: "POST", path: "/api/endpoints/worker/catalog", localInForwardMode: true },
    rpc: { method: "endpoints.worker.catalog", body: "params" },
    safety: { readOnly: false, destructive: false, risk: "safe_write" },
    log: { recordInput: false, recordOutput: false },
    requiredScopes: [],
    externalAuth: true,
    externalAuthVerifier: DEVICE_WORKER_VERIFIER
  },
  {
    id: "endpoints.worker.poll",
    feature: "endpoints",
    label: "托管端点任务轮询",
    target: { controller: "managedEndpoints", method: "handleWorkerPoll" },
    http: { method: "POST", path: "/api/endpoints/worker/poll", localInForwardMode: true },
    rpc: { method: "endpoints.worker.poll", body: "params" },
    safety: { readOnly: false, destructive: false, risk: "safe_write" },
    log: { recordInput: false, recordOutput: false },
    requiredScopes: [],
    externalAuth: true,
    externalAuthVerifier: DEVICE_WORKER_VERIFIER
  },
  {
    id: "endpoints.worker.start",
    feature: "endpoints",
    label: "托管端点任务开始",
    target: { controller: "managedEndpoints", method: "handleWorkerStart" },
    http: { method: "POST", path: "/api/endpoints/worker/start", localInForwardMode: true },
    rpc: { method: "endpoints.worker.start", body: "params" },
    safety: { readOnly: false, destructive: false, risk: "safe_write" },
    log: { recordInput: false, recordOutput: false },
    requiredScopes: [],
    externalAuth: true,
    externalAuthVerifier: DEVICE_WORKER_VERIFIER
  },
  {
    id: "endpoints.worker.event",
    feature: "endpoints",
    label: "托管端点任务事件",
    target: { controller: "managedEndpoints", method: "handleWorkerEvent" },
    http: { method: "POST", path: "/api/endpoints/worker/event", localInForwardMode: true },
    rpc: { method: "endpoints.worker.event", body: "params" },
    safety: { readOnly: false, destructive: false, risk: "safe_write" },
    log: { recordInput: false, recordOutput: false },
    requiredScopes: [],
    externalAuth: true,
    externalAuthVerifier: DEVICE_WORKER_VERIFIER
  },
  {
    id: "endpoints.worker.permission",
    feature: "endpoints",
    label: "托管端点权限请求",
    target: { controller: "managedEndpoints", method: "handleWorkerPermission" },
    http: { method: "POST", path: "/api/endpoints/worker/permission", localInForwardMode: true },
    rpc: { method: "endpoints.worker.permission", body: "params" },
    safety: { readOnly: false, destructive: false, risk: "safe_write" },
    log: { recordInput: false, recordOutput: false },
    requiredScopes: [],
    externalAuth: true,
    externalAuthVerifier: DEVICE_WORKER_VERIFIER
  },
  {
    id: "endpoints.worker.complete",
    feature: "endpoints",
    label: "托管端点任务完成",
    target: { controller: "managedEndpoints", method: "handleWorkerComplete" },
    http: { method: "POST", path: "/api/endpoints/worker/complete", localInForwardMode: true },
    rpc: { method: "endpoints.worker.complete", body: "params" },
    safety: { readOnly: false, destructive: false, risk: "safe_write" },
    log: { recordInput: false, recordOutput: false },
    requiredScopes: [],
    externalAuth: true,
    externalAuthVerifier: DEVICE_WORKER_VERIFIER
  },
  {
    id: "endpoints.tasks.submit",
    feature: "endpoints",
    label: "提交托管端点任务",
    target: { controller: "managedEndpoints", method: "handleSubmitTask" },
    http: { method: "POST", path: "/api/endpoints/tasks", localInForwardMode: true },
    rpc: { method: "endpoints.tasks.submit", body: "params" },
    safety: { readOnly: false, destructive: false, risk: "safe_write" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["requestId", "capabilityId", "input"],
      properties: {
        requestId: { type: "string", minLength: 8, maxLength: 128 },
        endpointId: { type: "string", maxLength: 128 },
        capabilityId: { type: "string", maxLength: 128 },
        workspaceId: { type: "string", maxLength: 128 },
        input: {}
      }
    },
    requiredScopes: ["endpoints:execute"],
    externalAuth: true,
    externalAuthVerifier: {
      controller: "system",
      method: "verifyConsoleOrToolSkillExternalAuth",
      requiredScopes: ["endpoints:execute"],
      recordUse: true
    }
  },
  {
    id: "endpoints.tasks.get",
    feature: "endpoints",
    label: "托管端点任务详情",
    target: { controller: "managedEndpoints", method: "handleGetTask" },
    http: { method: "GET", path: "/api/endpoints/tasks/:taskId", localInForwardMode: true },
    rpc: {
      method: "endpoints.tasks.get",
      params: [{ name: "taskId", aliases: ["taskId", "task-id", "id"], required: true }]
    },
    safety: { readOnly: true },
    requiredScopes: ["endpoints:read"],
    externalAuth: true,
    externalAuthVerifier: {
      controller: "system",
      method: "verifyConsoleOrToolSkillExternalAuth",
      requiredScopes: ["endpoints:read"],
      recordUse: true
    }
  },
  {
    id: "endpoints.tasks.events",
    feature: "endpoints",
    label: "托管端点任务事件时间线",
    target: { controller: "managedEndpoints", method: "handleTaskEvents" },
    http: {
      method: "GET",
      path: "/api/endpoints/tasks/:taskId/events",
      query: [
        { name: "after", aliases: ["after"] },
        { name: "wait", aliases: ["wait"] }
      ],
      coerce: { after: "number", wait: "number" },
      localInForwardMode: true
    },
    rpc: {
      method: "endpoints.tasks.events",
      params: [
        { name: "taskId", aliases: ["taskId", "task-id", "id"], required: true },
        { name: "after", aliases: ["after"] },
        { name: "wait", aliases: ["wait"] }
      ]
    },
    safety: { readOnly: true },
    requiredScopes: ["endpoints:read"],
    externalAuth: true,
    externalAuthVerifier: {
      controller: "system",
      method: "verifyConsoleOrToolSkillExternalAuth",
      requiredScopes: ["endpoints:read"],
      recordUse: true
    }
  },
  {
    id: "endpoints.tasks.cancel",
    feature: "endpoints",
    label: "取消托管端点任务",
    target: { controller: "managedEndpoints", method: "handleCancelTask" },
    http: { method: "POST", path: "/api/endpoints/tasks/:taskId/cancel", localInForwardMode: true },
    rpc: {
      method: "endpoints.tasks.cancel",
      params: [{ name: "taskId", aliases: ["taskId", "task-id", "id"], required: true }]
    },
    safety: { readOnly: false, destructive: false, risk: "safe_write" },
    requiredScopes: ["endpoints:execute"],
    externalAuth: true,
    externalAuthVerifier: {
      controller: "system",
      method: "verifyConsoleOrToolSkillExternalAuth",
      requiredScopes: ["endpoints:execute"],
      recordUse: true
    }
  },
  {
    id: "endpoints.tasks.permission",
    feature: "endpoints",
    label: "批准托管端点权限",
    target: { controller: "managedEndpoints", method: "handleTaskPermission" },
    http: { method: "POST", path: "/api/endpoints/tasks/:taskId/permission", localInForwardMode: true },
    rpc: {
      method: "endpoints.tasks.permission",
      params: [{ name: "taskId", aliases: ["taskId", "task-id", "id"], required: true }],
      body: "params"
    },
    safety: { readOnly: false, destructive: false, risk: "repair_write" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId", "permissionId", "selectedOptionId"],
      properties: {
        taskId: ID,
        permissionId: PERMISSION_ID,
        selectedOptionId: { type: "string", maxLength: 160 }
      }
    },
    requiredScopes: ["endpoints:approve"],
    externalAuth: true,
    externalAuthVerifier: {
      controller: "system",
      method: "verifyConsoleOrToolSkillExternalAuth",
      requiredScopes: ["endpoints:approve"],
      recordUse: true
    }
  },
  {
    id: "endpoints.list",
    feature: "endpoints",
    label: "托管端点清单",
    target: { controller: "managedEndpoints", method: "handleListEndpoints" },
    http: { method: "GET", path: "/api/endpoints", localInForwardMode: true },
    rpc: { method: "endpoints.list" },
    safety: { readOnly: true },
    requiredScopes: ["endpoints:read"],
    externalAuth: true,
    externalAuthVerifier: {
      controller: "system",
      method: "verifyConsoleOrToolSkillExternalAuth",
      requiredScopes: ["endpoints:read"],
      recordUse: true
    }
  },
  {
    id: "endpoints.create",
    feature: "endpoints",
    label: "创建托管端点",
    target: { controller: "managedEndpoints", method: "handleCreateEndpoint" },
    http: { method: "POST", path: "/api/endpoints", localInForwardMode: true },
    rpc: { method: "endpoints.create", body: "params" },
    safety: { readOnly: false, destructive: false, risk: "safe_write" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: {
        label: { type: "string", minLength: 1, maxLength: 160 },
        kind: { type: "string", enum: ["workstation", "shared"] },
        allowedCapabilityIds: {
          type: "array",
          maxItems: 256,
          items: { type: "string", maxLength: 128 }
        }
      }
    },
    requiredScopes: ["endpoints:manage"],
    externalAuth: true,
    externalAuthVerifier: {
      controller: "system",
      method: "verifyConsoleOrToolSkillExternalAuth",
      requiredScopes: ["endpoints:manage"],
      recordUse: true
    }
  },
  {
    id: "endpoints.update",
    feature: "endpoints",
    label: "更新托管端点",
    target: { controller: "managedEndpoints", method: "handleUpdateEndpoint" },
    http: { method: "POST", path: "/api/endpoints/:endpointId", localInForwardMode: true },
    rpc: {
      method: "endpoints.update",
      params: [{ name: "endpointId", aliases: ["endpointId", "endpoint-id", "id"], required: true }],
      body: "params"
    },
    safety: { readOnly: false, destructive: false, risk: "safe_write" },
    requiredScopes: ["endpoints:manage"],
    externalAuth: true,
    externalAuthVerifier: {
      controller: "system",
      method: "verifyConsoleOrToolSkillExternalAuth",
      requiredScopes: ["endpoints:manage"],
      recordUse: true
    }
  },
  {
    id: "endpoints.revoke",
    feature: "endpoints",
    label: "吊销托管端点",
    target: { controller: "managedEndpoints", method: "handleRevokeEndpoint" },
    http: { method: "POST", path: "/api/endpoints/:endpointId/revoke", localInForwardMode: true },
    rpc: {
      method: "endpoints.revoke",
      params: [{ name: "endpointId", aliases: ["endpointId", "endpoint-id", "id"], required: true }]
    },
    safety: {
      readOnly: false,
      destructive: false,
      risk: "repair_write",
      requiresConfirmation: true,
      approvalScope: "endpoints:manage"
    },
    requiredScopes: ["endpoints:manage"],
    externalAuth: true,
    externalAuthVerifier: {
      controller: "system",
      method: "verifyConsoleOrToolSkillExternalAuth",
      requiredScopes: ["endpoints:manage"],
      recordUse: true
    }
  }
].map((operation: any) => {
  operation = {
    ...operation, errorResponseProjector: { controller: "managedEndpoints", method: "projectErrorResponse" }
  };
  if (operation.id.startsWith("endpoints.worker.")) {
    return { ...operation, confirmationInput: false, inputSchema: WORKER_INPUTS[operation.id] };
  }
  return {
    ...operation, toolId: `meshrix.${operation.id}`,
    inputSchema: MEMBER_INPUTS[operation.id] || operation.inputSchema,
    ...(operation.id === "endpoints.create" ? { log: { recordOutput: false } } : {})
  };
}));
