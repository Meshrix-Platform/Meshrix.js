import { PROTOCOL_OPERATION_DEFINITIONS } from "./protocol-operation-definitions.mjs";
import { listStaticSemanticFamilyPublicSummaries } from "./static-semantic-family-catalog.mjs";

export const STATIC_SEMANTIC_FAMILY_COUNT = listStaticSemanticFamilyPublicSummaries().length;

function parseOperationBody(value) {
  if (value === null || value === undefined) {
    return {};
  }
  if (Buffer.isBuffer(value)) {
    if (value.length === 0) {
      return {};
    }
    return parseOperationBody(value.toString("utf8"));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }
    try {
      return parseOperationBody(JSON.parse(trimmed));
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function isReadOnlyPrompt(context = {}) {
  const input = {
    ...parseOperationBody(context.requestBody),
    ...(context.params && typeof context.params === "object" ? context.params : {})
  };
  const mode = String(input.mode || input.promptMode || input.askMode || "").trim().toLowerCase();
  if (mode === "read" || mode === "read_only" || mode === "readonly") {
    return true;
  }
  if (input.readOnly === true || input.readOnly === 1 || input.readOnly === "true") {
    return true;
  }
  if (input.noWrite === true || input.noWrite === 1 || input.noWrite === "true") {
    return true;
  }
  return false;
}

export function resolveAcpPromptRisk(context = {}) {
  return isReadOnlyPrompt(context) ? "read_only" : "repair_write";
}

const UPSTREAM_GATEWAY_SERVICE_ID_PARAMS = Object.freeze([
  { name: "serviceId", aliases: ["service-id", "serviceId", "upstreamId", "upstream-id", "id"], required: true }
]);

function upstreamGatewayInputSchema(required = []) {
  return {
    type: "object",
    required,
    additionalProperties: false,
    properties: {
      serviceId: { type: "string" },
      operationKey: { type: "string" },
      artifactId: { type: "string" },
      toolName: { type: "string" },
      arguments: { type: "object" },
      query: { type: "object" },
      params: { type: "object" },
      rpcParams: { type: "object" },
      rpcId: { type: "string" },
      body: {},
      bodyJson: {},
      payload: { type: "object" },
      secretBindingId: { type: "string" },
      reason: { type: "string" },
      limit: { type: "number" },
      approved: { type: "boolean" },
      approvalApproved: { type: "boolean" }
    }
  };
}

function upstreamGatewayOperation({
  id,
  method = "POST",
  path,
  label,
  scopes,
  risk = "read_only",
  concurrencySafe = undefined,
  timeoutMs = 30_000,
  params = [],
  query = [],
  required = [],
  rawJsonBytes = false
}) {
  const normalizedMethod = String(method || "POST").toUpperCase();
  const bodyBound = !["GET", "HEAD", "OPTIONS"].includes(normalizedMethod);
  const command = id.split(".");
  return {
    id,
    feature: id.startsWith("external_services.") ? "external_services" : "gateway",
    label,
    description: `Governed upstream gateway operation for ${id}.`,
    target: { controller: "system", method: "handleUpstreamGatewayOperation" },
    http: { method: normalizedMethod, path, query, localInForwardMode: true, ...(rawJsonBytes ? { rawJsonBytes: true } : {}) },
    rpc: bodyBound
      ? { method: id, body: "params", params }
      : { method: id, params, query },
    cli: {
      command,
      usage: bodyBound ? `${command.join(" ")} --body request.json` : command.join(" ")
    },
    requiredScopes: scopes,
    readOnly: risk === "read_only",
    concurrencySafe: concurrencySafe === undefined ? risk === "read_only" : concurrencySafe === true,
    execution: {
      timeoutMs: Math.max(100, Math.min(Number(timeoutMs || 30_000), 300_000))
    },
    safety: {
      risk,
      requiresConfirmation: risk === "repair_write" || risk === "destructive",
      approvalScope: risk === "read_only" ? "" : scopes[0] || "gateway:write"
    },
    aspects: ["upstream-gateway", "operation-permission", "mcp"],
    inputSchema: upstreamGatewayInputSchema(required),
    audit: { recordInput: false, metadataOnly: true },
    log: { recordInput: false }
  };
}

const UPSTREAM_GATEWAY_OPERATION_DEFINITIONS = Object.freeze([
  upstreamGatewayOperation({
    id: "external_services.publications.list",
    method: "GET",
    path: "/api/gateway/v1/services",
    label: "List owned upstream service publications",
    scopes: ["gateway:read"]
  }),
  upstreamGatewayOperation({
    id: "external_services.publications.get",
    method: "GET",
    path: "/api/gateway/v1/services/:serviceId",
    label: "Read owned upstream service publication",
    scopes: ["gateway:read"],
    params: UPSTREAM_GATEWAY_SERVICE_ID_PARAMS,
    required: ["serviceId"]
  }),
  upstreamGatewayOperation({
    id: "external_services.create",
    method: "POST",
    path: "/api/gateway/v1/services",
    label: "Create upstream service publication",
    scopes: ["gateway:write"],
    risk: "safe_write",
    rawJsonBytes: true
  }),
  upstreamGatewayOperation({
    id: "external_services.replace",
    method: "PUT",
    path: "/api/gateway/v1/services/:serviceId",
    label: "Replace upstream service publication",
    scopes: ["gateway:maintain"],
    risk: "safe_write",
    params: UPSTREAM_GATEWAY_SERVICE_ID_PARAMS,
    required: ["serviceId"],
    rawJsonBytes: true
  }),
  upstreamGatewayOperation({
    id: "external_services.disable",
    method: "POST",
    path: "/api/gateway/v1/services/:serviceId/disable",
    label: "Disable upstream service publication",
    scopes: ["gateway:maintain"],
    risk: "safe_write",
    params: UPSTREAM_GATEWAY_SERVICE_ID_PARAMS,
    required: ["serviceId"],
    rawJsonBytes: true
  }),
  upstreamGatewayOperation({
    id: "external_services.remove",
    method: "DELETE",
    path: "/api/gateway/v1/services/:serviceId",
    label: "Remove upstream service publication",
    scopes: ["gateway:maintain"],
    risk: "destructive",
    params: UPSTREAM_GATEWAY_SERVICE_ID_PARAMS,
    required: ["serviceId"],
    rawJsonBytes: true
  }),
  upstreamGatewayOperation({
    id: "external_services.republish",
    method: "POST",
    path: "/api/gateway/v1/services/:serviceId/republish",
    label: "Republish upstream service",
    scopes: ["gateway:maintain"],
    risk: "safe_write",
    params: UPSTREAM_GATEWAY_SERVICE_ID_PARAMS,
    required: ["serviceId"],
    rawJsonBytes: true
  }),
  upstreamGatewayOperation({
    id: "external_services.list",
    method: "GET",
    path: "/api/gateway/v1/external-services",
    label: "列出上游服务",
    scopes: ["gateway:read"],
    query: [{ name: "limit", aliases: ["limit"] }]
  }),
  upstreamGatewayOperation({
    id: "external_services.get",
    method: "GET",
    path: "/api/gateway/v1/external-services/:serviceId",
    label: "读取上游服务",
    scopes: ["gateway:read"],
    params: UPSTREAM_GATEWAY_SERVICE_ID_PARAMS,
    required: ["serviceId"]
  }),
  upstreamGatewayOperation({
    id: "external_services.health",
    method: "GET",
    path: "/api/gateway/v1/external-services/:serviceId/health",
    label: "检查上游服务健康",
    scopes: ["gateway:read"],
    params: UPSTREAM_GATEWAY_SERVICE_ID_PARAMS,
    required: ["serviceId"]
  }),
  upstreamGatewayOperation({
    id: "gateway.policy.preview",
    path: "/api/gateway/v1/policy/preview",
    label: "预览上游转发策略",
    scopes: ["gateway:read"]
  }),
  upstreamGatewayOperation({
    id: "gateway.forward",
    path: "/api/gateway/v1/forward",
    label: "执行受治理上游转发",
    scopes: ["gateway:write"],
    risk: "safe_write",
    concurrencySafe: true,
    timeoutMs: 180_000,
    required: ["serviceId"]
  }),
  upstreamGatewayOperation({
    id: "gateway.payload.transit",
    path: "/api/gateway/v1/transit/:serviceId/:operationKey",
    label: "Stream a governed upstream operation payload",
    scopes: ["gateway:write"],
    risk: "safe_write",
    concurrencySafe: true,
    timeoutMs: 300_000,
    params: [
      ...UPSTREAM_GATEWAY_SERVICE_ID_PARAMS,
      { name: "operationKey", aliases: ["operation-key", "operationKey"], required: true }
    ],
    required: ["serviceId", "operationKey"]
  }),
  upstreamGatewayOperation({
    id: "gateway.artifacts.get",
    method: "GET",
    path: "/api/gateway/v1/artifacts/:artifactId",
    label: "Download an owner-bound upstream artifact",
    scopes: ["gateway:read"],
    params: [{ name: "artifactId", aliases: ["artifact-id", "artifactId"], required: true }],
    required: ["artifactId"]
  }),
  upstreamGatewayOperation({
    id: "gateway.audit",
    method: "GET",
    path: "/api/gateway/v1/audit",
    label: "读取上游网关审计",
    scopes: ["gateway:read"],
    query: [
      { name: "serviceId", aliases: ["service-id", "serviceId"] },
      { name: "limit", aliases: ["limit"] }
    ]
  }),
  upstreamGatewayOperation({
    id: "gateway.metrics",
    method: "GET",
    path: "/api/gateway/v1/metrics",
    label: "读取上游网关指标",
    scopes: ["gateway:read"]
  })
]);

const SECURITY_ALERT_OPERATION_DEFINITIONS = Object.freeze([
  {
    id: "security_alerts.list",
    feature: "security_alerts",
    label: "列出安全告警",
    description: "List redacted security alerts generated by identity, gateway, path, and package isolation controls.",
    target: { controller: "system", method: "handleSecurityAlertsOperation" },
    http: {
      method: "GET",
      path: "/api/security-alerts/v1/alerts",
      localInForwardMode: true,
      query: [
        { name: "limit", aliases: ["limit"] },
        { name: "status", aliases: ["status"] },
        { name: "severity", aliases: ["severity"] },
        { name: "reasonCode", aliases: ["reason-code", "reasonCode"] },
        { name: "traceId", aliases: ["trace-id", "traceId"] }
      ],
      coerce: { limit: "number" }
    },
    rpc: {
      method: "security_alerts.list",
      query: [
        { name: "limit", aliases: ["limit"] },
        { name: "status", aliases: ["status"] },
        { name: "severity", aliases: ["severity"] },
        { name: "reasonCode", aliases: ["reason-code", "reasonCode"] },
        { name: "traceId", aliases: ["trace-id", "traceId"] }
      ]
    },
    cli: { command: ["security", "alerts"], usage: "security alerts [--limit 100]" },
    requiredScopes: ["console:read"],
    readOnly: true,
    concurrencySafe: true,
    aspects: ["security-alerts", "observability", "redaction"],
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    audit: { recordInput: false, metadataOnly: true },
    log: { recordInput: false }
  },
  {
    id: "security_alerts.ack",
    feature: "security_alerts",
    label: "确认安全告警",
    description: "Acknowledge one redacted security alert.",
    target: { controller: "system", method: "handleSecurityAlertsOperation" },
    http: { method: "POST", path: "/api/security-alerts/v1/alerts/:alertId/ack", localInForwardMode: true },
    rpc: {
      method: "security_alerts.ack",
      params: [{ name: "alertId", aliases: ["alert-id", "alertId", "id"], required: true }],
      body: "params"
    },
    cli: { command: ["security", "alerts", "ack"], usage: "security alerts ack --id ALERT_ID" },
    requiredScopes: ["runtime:admin"],
    safety: { risk: "safe_write" },
    aspects: ["security-alerts", "observability", "redaction"],
    inputSchema: {
      type: "object",
      required: ["alertId"],
      additionalProperties: false,
      properties: { alertId: { type: "string" }, acknowledgedBy: { type: "string" } }
    },
    audit: { recordInput: false, metadataOnly: true },
    log: { recordInput: false }
  },
  {
    id: "security_alerts.export",
    feature: "security_alerts",
    label: "导出安全告警",
    description: "Export redacted security alerts as structured JSON and JSONL.",
    target: { controller: "system", method: "handleSecurityAlertsOperation" },
    http: {
      method: "GET",
      path: "/api/security-alerts/v1/export",
      localInForwardMode: true,
      query: [
        { name: "limit", aliases: ["limit"] },
        { name: "status", aliases: ["status"] },
        { name: "severity", aliases: ["severity"] }
      ],
      coerce: { limit: "number" }
    },
    rpc: { method: "security_alerts.export", query: [{ name: "limit", aliases: ["limit"] }] },
    cli: { command: ["security", "alerts", "export"], usage: "security alerts export [--limit 100]" },
    requiredScopes: ["console:read"],
    readOnly: true,
    concurrencySafe: true,
    aspects: ["security-alerts", "observability", "redaction"],
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    audit: { recordInput: false, metadataOnly: true },
    log: { recordInput: false }
  },
  {
    id: "security_alerts.prune",
    feature: "security_alerts",
    label: "清理安全告警",
    description: "Prune expired security alerts according to an explicit retention window.",
    target: { controller: "system", method: "handleSecurityAlertsOperation" },
    http: { method: "POST", path: "/api/security-alerts/v1/prune", localInForwardMode: true },
    rpc: { method: "security_alerts.prune", body: "params" },
    cli: { command: ["security", "alerts", "prune"], usage: "security alerts prune --body prune.json" },
    requiredScopes: ["runtime:admin"],
    safety: { risk: "repair_write" },
    aspects: ["security-alerts", "observability", "redaction"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { retentionDays: { type: "number" } }
    },
    audit: { recordInput: false, metadataOnly: true },
    log: { recordInput: false }
  }
]);

export const OPERATION_REGISTRY_GOVERNED_DEFINITIONS = Object.freeze([
  ...PROTOCOL_OPERATION_DEFINITIONS,
  ...UPSTREAM_GATEWAY_OPERATION_DEFINITIONS,
  ...SECURITY_ALERT_OPERATION_DEFINITIONS
]);
