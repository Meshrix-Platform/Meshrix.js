import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { ServerConfig } from "@meshrix/foundation/config/server-config";
import {
  createResponseProjectionUnavailableError,
  filterStructuredValue,
  normalizeResponseBodyFields,
  normalizeSensitiveBodyFields,
  redactStructuredValue
} from "./response-policy.ts";
import {
  hasCircuitBreakerInput,
  hasTrafficPolicyInput
} from "./policy-source.ts";
import { compilePayloadTransport } from "./payload-contract.ts";

export const UPSTREAM_GATEWAY_PROTOCOL_VERSION: any = "v0.0.1:upstream-gateway:service-registry-1";
export const MAX_UPSTREAM_ENDPOINTS: any = 64;
export const MAX_UPSTREAM_ENDPOINT_WEIGHT: any = 100;
export const MAX_UPSTREAM_TOTAL_ENDPOINT_WEIGHT: any = 1_024;

/** Retired startup config path. Ordinary runtime must not load this file. */

const RUNTIME_FILE: any = path.join("upstream-gateway", "runtime.json");
const SECRET_HEADER_NAMES: any = new Set<any>([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization"
]);
const HTTP_METHODS: any = new Set<any>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const APPROVAL_LAYERS: any = new Set<any>(["user", "team", "department", "agent"]);

const REDACTED_VALUE: any = "[redacted]";

export function nowIso() : any {
  return new Date().toISOString();
}

export function text(value?: any) : any {
  return String(value ?? "").trim();
}

export function asArray(value?: any) : any {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

export function object(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}


export function tryParseJson(value?: any) : any {
  if (typeof value !== "string") return undefined;
  const raw: any = value.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function hash(value?: any, length: any = 24) : any {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}

export function stableId(prefix?: any, value?: any) : any {
  return `${prefix}::${hash(stableJson(value))}`;
}

export function dataRoot(userDataPath: any = "") : any {
  return userDataPath || ServerConfig.getDataDir();
}

export function runtimePath(userDataPath: any = "") : any {
  return path.join(dataRoot(userDataPath), RUNTIME_FILE);
}

export function readJsonSync(filePath?: any, fallback?: any) : any {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export function writeJsonSyncAtomic(filePath?: any, value?: any) : any {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath: any = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  fsSync.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fsSync.renameSync(tmpPath, filePath);
}

export function clone(value?: any) : any {
  return JSON.parse(JSON.stringify(value));
}

export function emptyState() : any {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
    updatedAt: nowIso(),
    services: {},
    auditEvents: [],
    metrics: {
      totalForwardCount: 0,
      totalFailureCount: 0,
      byService: {},
      byStatus: {}
    }
  };
}

export function normalizeState(value: Record<string, any> = {}) : any {
  const fallback: any = emptyState();
  return {
    ...fallback,
    ...object(value),
    services: object(value.services),
    auditEvents: asArray(value.auditEvents),
    metrics: {
      ...fallback.metrics,
      ...object(value.metrics),
      byService: object(value.metrics?.byService),
      byStatus: object(value.metrics?.byStatus)
    }
  };
}

export function normalizeBaseUrl(value?: any, { required = true }: Record<string, any> = {}) : any {
  const raw: any = text(value).replace(/\/+$/, "");
  if (!raw) {
    if (!required) return "";
    throw new Error("Upstream service baseUrl is required.");
  }
  const authority: any = raw.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)/u)?.[1] || "";
  const hostPort: any = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  const hasExplicitPort: any = /:\d+$/u.test(hostPort);
  const parsed: any = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Upstream service baseUrl must use http or https.");
  }
  if (!hasExplicitPort) {
    throw new Error("Upstream service baseUrl must include an explicit port.");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

export function normalizeEndpoint(input: Record<string, any> = {}, index: any = 0, fallback: Record<string, any> = {}) : any {
  const source: any = typeof input === "string" ? { baseUrl: input } : object(input);
  const baseUrl: any = normalizeBaseUrl(source.baseUrl || source.url || source.endpoint || fallback.baseUrl);
  const endpointId: any = safePublicToolSegment(source.endpointId || source.id || fallback.endpointId || `endpoint-${index + 1}`);
  const hasEndpointTrafficPolicy: any = hasTrafficPolicyInput(source);
  const hasServiceTrafficPolicy: any = hasTrafficPolicyInput(fallback);
  const hasEndpointCircuitBreaker: any = hasCircuitBreakerInput(source);
  const hasServiceCircuitBreaker: any = hasCircuitBreakerInput(fallback);
  const requestedWeight: any = source.weight ?? fallback.weight ?? 1;
  const weight: any = Number(requestedWeight);
  if (
    !Number.isSafeInteger(weight) ||
    weight < 1 ||
    weight > MAX_UPSTREAM_ENDPOINT_WEIGHT
  ) {
    throw Object.assign(
      new Error("Upstream endpoint weight is outside the configured limit."),
      { status: 400, code: "upstream_endpoint_weight_invalid" }
    );
  }
  return {
    endpointId,
    baseUrl,
    weight,
    disabled: source.disabled === true || fallback.disabled === true,
    trafficPolicy: normalizeTrafficPolicy(
      hasEndpointTrafficPolicy
        ? source
        : hasServiceTrafficPolicy
          ? fallback
          : {}
    ),
    trafficPolicySource: hasEndpointTrafficPolicy
      ? "endpoint"
      : hasServiceTrafficPolicy
        ? "service"
        : "default",
    trafficPolicyInherited: !hasEndpointTrafficPolicy,
    circuitBreaker: normalizeCircuitBreaker(
      hasEndpointCircuitBreaker
        ? source.circuitBreaker || source
        : hasServiceCircuitBreaker
          ? fallback.circuitBreaker || fallback
          : {}
    ),
    circuitBreakerSource: hasEndpointCircuitBreaker
      ? "endpoint"
      : hasServiceCircuitBreaker
        ? "service"
        : "default",
    circuitBreakerInherited: !hasEndpointCircuitBreaker
  };
}

export function normalizeEndpoints(input: Record<string, any> = {}, existing: Record<string, any> = {}) : any {
  const configured: any = asArray(
    input.endpoints ||
      input.upstreamEndpoints ||
      input.endpointPool ||
      existing.endpoints
  );
  if (configured.length > MAX_UPSTREAM_ENDPOINTS) {
    throw Object.assign(
      new Error("Upstream endpoint count exceeds the configured limit."),
      { status: 400, code: "upstream_endpoint_count_exceeded" }
    );
  }
  const endpoints: any = configured
    .map((endpoint?: any, index?: any) : any => normalizeEndpoint(endpoint, index, {
      trafficPolicy: input.trafficPolicy || existing.trafficPolicy,
      circuitBreaker: input.circuitBreaker || existing.circuitBreaker
    }))
    .filter((endpoint?: any) : any => endpoint.baseUrl);
  if (endpoints.length > 0) {
    if (new Set<any>(endpoints.map((endpoint?: any) : any => endpoint.endpointId)).size !== endpoints.length) {
      throw Object.assign(
        new Error("Upstream endpoint identifiers must be unique."),
        { status: 400, code: "upstream_endpoint_identity_conflict" }
      );
    }
    const totalWeight: any = endpoints.reduce(
      (sum?: any, endpoint?: any) : any => sum + endpoint.weight,
      0
    );
    if (totalWeight > MAX_UPSTREAM_TOTAL_ENDPOINT_WEIGHT) {
      throw Object.assign(
        new Error("Upstream endpoint total weight exceeds the configured limit."),
        { status: 400, code: "upstream_endpoint_total_weight_exceeded" }
      );
    }
    return endpoints;
  }
  return [
    normalizeEndpoint({
      endpointId: "primary",
      baseUrl: input.baseUrl || existing.baseUrl,
      weight: 1
    }, 0, {
      trafficPolicy: input.trafficPolicy || existing.trafficPolicy,
      circuitBreaker: input.circuitBreaker || existing.circuitBreaker
    })
  ];
}

export function normalizePath(value?: any, fallback: any = "/") : any {
  const raw: any = text(value || fallback) || "/";
  const withSlash: any = raw.startsWith("/") ? raw : `/${raw}`;
  const withoutSafeParameters: any = withSlash.replace(/\{[A-Za-z][A-Za-z0-9_]{0,63}\}/gu, "");
  if (
    raw.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(raw) ||
    withSlash.startsWith("//") ||
    withSlash.includes("\\") ||
    withSlash.includes("..") ||
    /[{}]/u.test(withoutSafeParameters) ||
    /[\u0000-\u001f]/u.test(withSlash)
  ) {
    throw new Error("Upstream route path is invalid.");
  }
  return withSlash;
}

export function normalizeMethod(value?: any, fallback: any = "POST") : any {
  const method: any = text(value || fallback).toUpperCase();
  return HTTP_METHODS.has(method) ? method : "POST";
}

export function strictMethod(value?: any, fallback: any = "POST") : any {
  const method: any = text(value || fallback).toUpperCase();
  if (!HTTP_METHODS.has(method)) {
    throw Object.assign(new Error("Upstream configured method is not allowed."), { status: 400 });
  }
  return method;
}

export function normalizeRisk(value?: any) : any {
  const risk: any = text(value || "safe_write");
  return ["read_only", "safe_write", "repair_write", "destructive"].includes(risk) ? risk : "safe_write";
}

export function normalizeProtocol(value?: any) : any {
  const protocol: any = text(value || "http").toLowerCase();
  return ["http", "json-rpc", "mcp"].includes(protocol) ? protocol : "http";
}

export function normalizeServiceProtocol(input: Record<string, any> = {}, existing: Record<string, any> = {}) : any {
  const explicit: any = text(input.serviceProtocol || input.serviceKind || input.kind || input.type || input.protocol || existing.serviceProtocol).toLowerCase();
  const transport: any = text(input.transport || input.mcp?.transport || input.mcp?.type).toLowerCase();
  if (
    explicit === "mcp" ||
    Boolean(input.mcp) ||
    ["stdio", "http", "https", "remote", "streamable-http", "sse"].includes(transport)
  ) {
    return "mcp";
  }
  return "http";
}

export function safePublicToolSegment(value?: any) : any {
  return text(value)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "service";
}

export function sanitizeHeaders(headers: Record<string, any> = {}) : any {
  const output: Record<string, any> = {};
  for (const [key, value] of (Object.entries(object(headers)) as [string, any][])) {
    const name: any = text(key).toLowerCase();
    if (!name || SECRET_HEADER_NAMES.has(name)) {
      continue;
    }
    output[name] = text(value);
  }
  return output;
}

function normalizeTagEntityRefs(value: any = [], serviceId: any = "") : any {
  return asArray(value)
    .map((entry?: any) : any => ({
      entityType: text(entry?.entityType || entry?.type),
      entityId: text(entry?.entityId || entry?.id)
    }))
    .filter((entry?: any) : any => entry.entityType && entry.entityId);
}

export function normalizeServiceTagPolicy(input: Record<string, any> = {}, existing: Record<string, any> = {}, serviceId: any = "") : any {
  const source: any = object(input.tagPolicy || input.securityTagPolicy || existing.tagPolicy);
  if (Object.keys(source).length === 0) {
    return null;
  }
  const entityRefs: any = normalizeTagEntityRefs(source.entityRefs || source.entities, serviceId);
  const normalized: Record<string, any> = {
    entityRefs: entityRefs.length > 0
      ? entityRefs
      : serviceId
        ? [{ entityType: "external_services.service", entityId: serviceId }]
        : [],
    denyTags: asArray(source.denyTags || source.deniedTags).map(text).filter(Boolean),
    allowTags: asArray(source.allowTags || source.allowedTags).map(text).filter(Boolean),
    requiredTags: asArray(source.requiredTags).map(text).filter(Boolean),
    policyRevision: source.policyRevision || source.revision || 0,
    failOnStale: source.failOnStale === true,
    requireFreshRevision: source.requireFreshRevision === true
  };
  return normalized.entityRefs.length > 0 ||
    normalized.denyTags.length > 0 ||
    normalized.allowTags.length > 0 ||
    normalized.requiredTags.length > 0 ||
    normalized.failOnStale ||
    normalized.requireFreshRevision ||
    Number(normalized.policyRevision || 0) > 0
    ? normalized
    : null;
}

export function hasInputField(input: Record<string, any> = {}, field?: any) : any {
  return Object.prototype.hasOwnProperty.call(object(input), field) && input[field] !== undefined;
}

export function callerRoutingOverrideFields(input: Record<string, any> = {}) : any {
  return ["url", "baseUrl", "host", "origin", "path", "method", "headers", "rpcMethod", "methodName"]
    .filter((field?: any) : any => hasInputField(input, field));
}

export function rejectUpstreamDestinationOverrideFields(input: Record<string, any> = {}) : any {
  const fields: any = callerRoutingOverrideFields(input);
  if (fields.length > 0) {
    throw Object.assign(new Error("Upstream request routing fields cannot be supplied by callers."), {
      status: 400,
      reasonCode: "upstream_routing_override_denied",
      fields
    });
  }
}

export function configuredHttpMethod(operation: Record<string, any> = {}) : any {
  return strictMethod(operation.method, "POST");
}

export function configuredRpcMethod(operation: Record<string, any> = {}) : any {
  const configuredMethod: any = text(operation.jsonRpcMethod || operation.operationKey);
  if (!configuredMethod) {
    throw Object.assign(new Error("Upstream JSON-RPC method must be configured by the server descriptor."), { status: 500 });
  }
  return configuredMethod;
}

export function configuredHeaders(service: Record<string, any> = {}) : any {
  return sanitizeHeaders(service.defaultHeaders);
}

export function redactSecretInput(input: Record<string, any> = {}) : any {
  return {
    hasRawCredentialInput: Boolean(
      input.token ||
        input.apiKey ||
        input.authorization ||
        input.password ||
        input.secret ||
        object(input.credentials).token ||
        object(input.credentials).apiKey ||
        object(input.credentials).authorization ||
        object(input.credentials).password ||
        object(input.credentials).secret
    )
  };
}

export function normalizeOperation(input: Record<string, any> = {}, index: any = 0, { serviceProtocol = "http" }: Record<string, any> = {}) : any {
  const operationKey: any = text(input.operationKey || input.operationId || input.key || input.name || `operation-${index + 1}`);
  const method: any = normalizeMethod(input.method, "POST");
  const risk: any = normalizeRisk(input.risk);
  const protocol: any = serviceProtocol === "mcp"
    ? "mcp"
    : normalizeProtocol(input.protocol || input.transport || input.upstreamProtocol);
  const approvalInput: any = object(input.approval);
  const requiredApprovalInput: any = object(input.requiredApproval || approvalInput.requiredApproval);
  const approvalLayers: any = asArray(requiredApprovalInput.approvalLayers || input.approvalLayers)
    .map((layer?: any) : any => text(layer).toLowerCase())
    .filter((layer?: any) : any => APPROVAL_LAYERS.has(layer));
  const requiredApproval: Record<string, any> = {
    ...requiredApprovalInput,
    ...(approvalLayers.length > 0 ? { approvalLayers: [...new Set<any>(approvalLayers)] } : { approvalLayers: [] })
  };
  const payloadTransport: any = serviceProtocol === "mcp" ? null : compilePayloadTransport(input);
  return {
    operationKey,
    label: text(input.label || operationKey),
    protocol,
    method,
    path: normalizePath(input.path || input.routePath || "/", "/"),
    requiredScopes: asArray(input.requiredScopes || (risk === "read_only" ? ["gateway:read"] : ["gateway:write"]))
      .map(text)
      .filter(Boolean),
    risk,
    requiresApproval: input.requiresApproval === true || risk === "repair_write" || risk === "destructive",
    approvalScope: text(input.approvalScope || approvalInput.approvalScope),
    requiredApproval,
    timeoutMs: Math.max(100, Math.min(Number(input.timeoutMs || 3000), 30000)),
    responseMaxBytes: payloadTransport?.response.maxBytes || 8 * 1024 * 1024,
    jsonRpcMethod: text(input.jsonRpcMethod || input.rpcMethod || input.methodName || operationKey),
    sensitiveBodyFields: normalizeSensitiveBodyFields(input.sensitiveBodyFields || input.redactedBodyFields),
    publicResponseFields: normalizeResponseBodyFields(
      input.publicResponseFields ||
        input.responseBodyFields ||
        input.responseFieldsAllowlist ||
        input.allowedResponseFields
    ),
    requestSchema: object(input.requestSchema),
    responseSchema: object(input.responseSchema),
    ...(payloadTransport ? { payloadTransport } : {})
  };
}

export function normalizeMcpTransport(value?: any) : any {
  const transport: any = text(value || "stdio").toLowerCase();
  if (["http", "https", "remote", "streamable-http", "sse"].includes(transport)) {
    return "http";
  }
  return transport === "stdio" ? "stdio" : transport;
}

export function normalizeMcpConfig(input: Record<string, any> = {}, existing: Record<string, any> = {}, { serviceId = "" }: Record<string, any> = {}) : any {
  const source: any = object(input.mcp || input.upstreamMcp || input);
  const previous: any = object(existing.mcp);
  const transport: any = normalizeMcpTransport(source.transport || source.type || previous.transport || "stdio");
  const rawEnv: any = object(source.env || previous.env);
  const env: any = Object.fromEntries((Object.entries(rawEnv) as [string, any][])
    .map(([key, value]: any[]) : any => [text(key), text(value)])
    .filter(([key]: any[]) : any => key));
  const rawHeaders: any = object(source.headers || previous.headers);
  const headers: any = Object.fromEntries((Object.entries(rawHeaders) as [string, any][])
    .map(([key, value]: any[]) : any => [text(key), text(value)])
    .filter(([key]: any[]) : any => key));
  return {
    protocolVersion: "v0.0.1:upstream-gateway:mcp-service-1",
    transport,
    command: text(source.command || previous.command || ""),
    args: asArray(source.args || previous.args).map(String),
    env,
    url: text(source.url || source.endpoint || source.baseUrl || previous.url || ""),
    headers,
    protocolVersionHint: text(source.protocolVersion || previous.protocolVersionHint || ""),
    toolNamePrefix: safePublicToolSegment(source.toolNamePrefix || source.prefix || previous.toolNamePrefix || serviceId),
    toolsCacheTtlMs: Math.max(0, Math.min(Number(source.toolsCacheTtlMs ?? previous.toolsCacheTtlMs ?? 30_000), 600_000)),
    timeoutMs: Math.max(100, Math.min(Number(source.timeoutMs || previous.timeoutMs || 30_000), 300_000))
  };
}

export function publicUrl(value: any = "") : any {
  const raw: any = text(value);
  if (!raw) return "";
  try {
    const parsed: any = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

export function publicMcpConfig(config: Record<string, any> = {}) : any {
  return {
    protocolVersion: config.protocolVersion || "v0.0.1:upstream-gateway:mcp-service-1",
    transport: config.transport || "stdio",
    commandRef: config.command ? stableId("mcp-command", path.basename(config.command)) : "",
    argCount: asArray(config.args).length,
    envCount: Object.keys(object(config.env)).length,
    urlRef: config.url ? stableId("mcp-url", publicUrl(config.url)) : "",
    headerCount: Object.keys(object(config.headers)).length,
    toolNamePrefix: config.toolNamePrefix || "",
    toolsCacheTtlMs: Number(config.toolsCacheTtlMs || 0),
    timeoutMs: Number(config.timeoutMs || 0)
  };
}

export function normalizeTrafficPolicy(input: Record<string, any> = {}) : any {
  const source: any = object(input.trafficPolicy || input.rateLimit);
  const perMinute: any = Math.max(1, Math.min(Number(source.perMinute || input.perMinute || 120), 10000));
  const burst: any = Math.max(1, Math.min(Number(source.burst || input.burst || 30), 10000));
  return {
    algorithm: "token_bucket_with_concurrency",
    routingAlgorithm: "weighted_endpoint_round_robin_with_circuit_breaker",
    perMinute,
    burst,
    maxConcurrent: Math.max(1, Math.min(Number(
      source.maxConcurrent ||
        source.concurrency ||
        source.concurrent ||
        input.maxConcurrent ||
        input.concurrency ||
        burst
    ), 10000))
  };
}

export function normalizeCircuitBreaker(input: Record<string, any> = {}) : any {
  const source: any = object(input.circuitBreaker || input);
  return {
    enabled: source.enabled !== false,
    failureThreshold: Math.max(1, Math.min(Number(
      source.failureThreshold ||
        source.failuresBeforeOpen ||
        source.failureCount ||
        3
    ), 100)),
    cooldownMs: Math.max(100, Math.min(Number(
      source.cooldownMs ||
        source.openMs ||
        source.resetAfterMs ||
        30_000
    ), 3_600_000))
  };
}

export function normalizeService(input: Record<string, any> = {}, existing: Record<string, any> = {}) : any {
  const serviceId: any = text(input.serviceId || input.id || existing.serviceId || stableId("upstream", {
    baseUrl: input.baseUrl,
    label: input.label
  }));
  const serviceProtocol: any = normalizeServiceProtocol(input, existing);
  const mcp: any = serviceProtocol === "mcp"
    ? normalizeMcpConfig(input, existing, { serviceId })
    : null;
  const endpoints: any = serviceProtocol === "mcp"
    ? []
    : normalizeEndpoints(input, existing);
  const operations: any = asArray(input.operations || input.routes || input.operation)
    .filter((item?: any) : any => item && typeof item === "object")
    .map((item?: any, index?: any) : any => normalizeOperation(item, index, { serviceProtocol }));
  const normalizedOperations: any = operations.length ? operations : [
    normalizeOperation({
      operationKey: serviceProtocol === "mcp" ? "tools/call" : "default",
      method: input.method || "POST",
      path: input.path || "/",
      protocol: serviceProtocol === "mcp" ? "mcp" : input.protocol,
      requiredScopes: input.requiredScopes || (serviceProtocol === "mcp" ? ["gateway:write"] : undefined)
    }, 0, { serviceProtocol })
  ];
  const credentialReferences: any = asArray(input.credentialReferences || existing.credentialReferences)
    .filter((entry?: any) : any => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry?: any) : any => ({
      type: text(entry.type),
      reference: text(entry.reference),
      revision: Number(entry.revision || 0),
      use: text(entry.use),
      operationKey: text(entry.operationKey),
      host: text(entry.host).toLowerCase(),
      protocol: text(entry.protocol).toLowerCase(),
      scopes: asArray(entry.scopes).map(text).filter(Boolean)
    }));
  const credentialRefs: any[] = [...new Set<any>([
    ...asArray(input.credentialRefs),
    ...asArray(input.credentialRef),
    ...asArray(input.secretRefs),
    ...asArray(input.secretRef),
    ...credentialReferences.map((entry?: any) : any => entry.reference)
  ].map(text).filter(Boolean))];
  const timestamp: any = nowIso();
  return {
    protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
    serviceId,
    serviceProtocol,
    label: text(input.label || existing.label || serviceId),
    description: text(input.description || existing.description || ""),
    baseUrl: serviceProtocol === "mcp"
      ? text(input.baseUrl || existing.baseUrl || mcp?.url || "")
      : endpoints[0]?.baseUrl || normalizeBaseUrl(input.baseUrl || existing.baseUrl),
    endpoints,
    healthPath: normalizePath(input.healthPath || existing.healthPath || "/health", "/health"),
    disabled: input.disabled === true || existing.disabled === true,
    allowLocalNetwork: input.allowLocalNetwork === undefined
      ? existing.allowLocalNetwork === true
      : input.allowLocalNetwork === true,
    visibility: text(input.visibility || existing.visibility || "private"),
    dataClass: text(input.dataClass || existing.dataClass || "internal"),
    ownerSubjectId: text(input.ownerSubjectId || existing.ownerSubjectId || ""),
    tags: asArray(input.tags || existing.tags).map(text).filter(Boolean),
    credentialRefs,
    credentialReferences,
    tagPolicy: normalizeServiceTagPolicy(input, existing, serviceId),
    redactedCredentialInput: redactSecretInput(input).hasRawCredentialInput,
    defaultHeaders: sanitizeHeaders(input.defaultHeaders || input.headers || existing.defaultHeaders),
    ...(mcp ? { mcp } : {}),
    trafficPolicy: normalizeTrafficPolicy(input.trafficPolicy || existing.trafficPolicy || {}),
    circuitBreaker: normalizeCircuitBreaker(input.circuitBreaker || existing.circuitBreaker || {}),
    operations: normalizedOperations,
    createdAt: existing.createdAt || timestamp,
    updatedAt: timestamp
  };
}

export function publicService(service: Record<string, any> = {}) : any {
  const {
    credentialRefs: privateCredentialRefs,
    credentialReferences: _privateCredentialReferences,
    ...publicFields
  } = service;
  const endpointRef: any = service.baseUrl
    ? stableId("upstream-endpoint", {
        serviceId: service.serviceId,
        serviceProtocol: service.serviceProtocol,
        baseUrl: service.baseUrl
      })
    : "";
  return {
    ...publicFields,
    credentialBindingIds: [...new Set<any>(asArray(privateCredentialRefs)
      .map((reference?: any) : any => text(reference))
      .filter(Boolean)
      .map((reference?: any) : any => `credential:${hash(reference, 16)}`))],
    credentialReferenceCount: asArray(privateCredentialRefs).length,
    redactedCredentialInput: service.redactedCredentialInput === true,
    defaultHeaders: sanitizeHeaders(service.defaultHeaders),
    baseUrl: "",
    endpointRef,
    endpointRedacted: Boolean(endpointRef),
    endpoints: asArray(service.endpoints).map((endpoint?: any) : any => ({
      endpointId: endpoint.endpointId || "",
      endpointRef: endpoint.baseUrl
        ? stableId("upstream-endpoint", {
            serviceId: service.serviceId,
            endpointId: endpoint.endpointId,
            serviceProtocol: service.serviceProtocol,
            baseUrl: endpoint.baseUrl
          })
        : "",
      endpointRedacted: Boolean(endpoint.baseUrl),
      weight: Number(endpoint.weight || 1),
      disabled: endpoint.disabled === true,
      trafficPolicy: normalizeTrafficPolicy(endpoint.trafficPolicy || service.trafficPolicy || {}),
      trafficPolicySource: endpoint.trafficPolicySource || "endpoint",
      trafficPolicyInherited: endpoint.trafficPolicyInherited === true,
      circuitBreaker: normalizeCircuitBreaker(endpoint.circuitBreaker || service.circuitBreaker || {}),
      circuitBreakerSource: endpoint.circuitBreakerSource || "endpoint",
      circuitBreakerInherited: endpoint.circuitBreakerInherited === true
    })),
    endpointCount: asArray(service.endpoints).length || (endpointRef ? 1 : 0),
    ...(service.serviceProtocol === "mcp" ? { mcp: publicMcpConfig(service.mcp) } : {})
  };
}

export function mcpToolReadOnly(tool: Record<string, any> = {}) : any {
  const annotations: any = object(tool.annotations);
  if (annotations.destructiveHint === true) return false;
  if (annotations.readOnlyHint === true) return true;
  return false;
}

export function mcpToolRisk(tool: Record<string, any> = {}) : any {
  const annotations: any = object(tool.annotations);
  // MCP destructiveHint means high-impact / approval-worthy work.
  // Meshrix.js "destructive" is a hard dispatcher block; map to repair_write instead.
  if (annotations.destructiveHint === true) return "repair_write";
  return mcpToolReadOnly(tool) ? "read_only" : "safe_write";
}

export function parsePublicUpstreamMcpToolName(name: any = "") : any {
  const raw: any = text(name);
  if (!raw.startsWith("upstream.")) return null;
  const withoutPrefix: any = raw.slice("upstream.".length);
  const dot: any = withoutPrefix.indexOf(".");
  if (dot <= 0 || dot === withoutPrefix.length - 1) return null;
  return {
    prefix: withoutPrefix.slice(0, dot),
    upstreamToolName: withoutPrefix.slice(dot + 1)
  };
}

export function mcpServiceConfig(service: Record<string, any> = {}) : any {
  return {
    ...object(service.mcp),
    protocolVersion: service.mcp?.protocolVersionHint || undefined
  };
}

export function responseBodyForPublic(contentType?: any, buffer?: any, sensitiveBodyFields: any = [], publicResponseFields: any = []) : any {
  const textBody: any = Buffer.from(buffer).toString("utf8");
  const filteringConfigured: any = normalizeSensitiveBodyFields(sensitiveBodyFields).length > 0 ||
    normalizeResponseBodyFields(publicResponseFields).length > 0;
  if (/json/i.test(contentType)) {
    try {
      const parsed: any = JSON.parse(textBody);
      if (!filteringConfigured) {
        return { json: parsed };
      }
      const redacted: any = redactStructuredValue(parsed, sensitiveBodyFields);
      return { json: filterStructuredValue(redacted, publicResponseFields) };
    } catch {
      if (filteringConfigured) {
        throw createResponseProjectionUnavailableError("Upstream operation response body is not valid JSON.");
      }
      return { text: textBody };
    }
  }
  if (filteringConfigured) {
    throw createResponseProjectionUnavailableError("Upstream operation response content type is not JSON.");
  }
  return { text: textBody };
}

export function jsonRpcRequestBody(input: Record<string, any> = {}, operation: Record<string, any> = {}, rpcMethod: any = "") : any {
  const fullBody: any = input.bodyJson !== undefined ? input.bodyJson : input.body;
  const method: any = text(rpcMethod || operation.jsonRpcMethod || operation.operationKey);
  if (fullBody && typeof fullBody === "object" && !Array.isArray(fullBody) && fullBody.jsonrpc && fullBody.method) {
    return {
      ...fullBody,
      method
    };
  }
  const params: any =
    input.rpcParams !== undefined
      ? input.rpcParams
      : input.params !== undefined
        ? input.params
        : input.payload !== undefined
          ? input.payload
          : fullBody !== undefined
            ? fullBody
            : {};
  return {
    jsonrpc: "2.0",
    id: input.rpcId || input.requestId || `upstream_jsonrpc::${randomUUID()}`,
    method,
    params
  };
}

export function queryFrom(input: Record<string, any> = {}) : any {
  const source: any = object(input.query || input.queryParams);
  const params: any = new URLSearchParams();
  for (const [key, value] of (Object.entries(source) as [string, any][])) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
      continue;
    }
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  return params;
}

export function safeTargetUrl(service?: any, operation?: any, input: Record<string, any> = {}, endpoint: any = null) : any {
  rejectUpstreamDestinationOverrideFields(input);
  const endpointBaseUrl: any = text(endpoint?.baseUrl || service.baseUrl);
  const configuredPath: any = text(operation.path || "/");
  const parameterNames: any = [...configuredPath.matchAll(/\{([A-Za-z][A-Za-z0-9_]{0,63})\}/gu)]
    .map((match?: any) : any => match[1]);
  const pathParameters: any = object(input.pathParameters);
  if (Object.keys(pathParameters).some((name?: any) : any => !parameterNames.includes(name))) {
    throw Object.assign(new Error("Upstream request contains an undeclared path parameter."), { status: 400 });
  }
  const resolvedPath: any = configuredPath.replace(/\{([A-Za-z][A-Za-z0-9_]{0,63})\}/gu, (_match?: any, name?: any) : any => {
    const value: any = pathParameters[name];
    const normalized: any = typeof value === "string" || typeof value === "number"
      ? String(value).trim()
      : "";
    if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
      throw Object.assign(new Error("Upstream request path parameter is missing or invalid."), { status: 400 });
    }
    return encodeURIComponent(normalized);
  });
  if (/[{}]/u.test(resolvedPath)) {
    throw Object.assign(new Error("Upstream request path parameters are incomplete."), { status: 400 });
  }
  const url: any = new URL(resolvedPath, `${endpointBaseUrl}/`);
  const baseUrl: any = new URL(`${endpointBaseUrl}/`);
  if (url.origin !== baseUrl.origin) {
    throw Object.assign(new Error("Upstream configured target origin is outside configured service origin."), { status: 400 });
  }
  const params: any = queryFrom(input);
  for (const [key, value] of params.entries()) {
    url.searchParams.append(key, value);
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  if (url.origin !== baseUrl.origin) {
    throw Object.assign(new Error("Upstream configured target origin is outside configured service origin."), { status: 400 });
  }
  return url;
}

export function summarizeUrl(url?: any) : any {
  return {
    protocol: url.protocol.replace(":", ""),
    hostRef: stableId("upstream-host", url.host),
    hostRedacted: true,
    pathname: url.pathname
  };
}

export { stableJson };
