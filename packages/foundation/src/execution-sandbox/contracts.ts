import crypto from "node:crypto";

export const SANDBOX_REQUEST_SCHEMA: any = "v0.0.1:execution-sandbox:request-1";
export const SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA: any =
  "v0.0.1:execution-sandbox:configured-workload-request-1";
export const SANDBOX_RECEIPT_SCHEMA: any = "v0.0.1:execution-sandbox:receipt-1";
export const SANDBOX_PROVIDER_CONFORMANCE_SCHEMA: any = "v0.0.1:execution-sandbox:provider-conformance-1";
export const CONTROLLED_SANDBOX_FINAL_RECEIPT_ID: any = "31000000-0000-4000-8000-000000000047";

export const SANDBOX_DENIAL_REASONS: Readonly<Record<string, any>> = Object.freeze({
  UNCONFIGURED: "sandbox_unconfigured",
  DISABLED: "sandbox_disabled",
  CONFIGURATION_INVALID: "sandbox_configuration_invalid",
  BACKEND_MISSING: "sandbox_backend_missing",
  BACKEND_UNHEALTHY: "sandbox_backend_unhealthy",
  POLICY_UNSUPPORTED: "sandbox_policy_unsupported",
  REQUEST_INVALID: "sandbox_request_invalid",
  AUTHORIZATION_MISSING: "sandbox_authorization_missing",
  GOVERNANCE_STALE: "sandbox_governance_stale",
  GOVERNANCE_REVOKED: "sandbox_governance_revoked",
  APPROVAL_MISSING: "sandbox_approval_missing",
  APPROVAL_STALE: "sandbox_approval_stale",
  APPROVAL_REUSED: "sandbox_approval_reused",
  APPROVAL_CAPACITY_EXHAUSTED: "sandbox_approval_capacity_exhausted",
  INPUT_INTEGRITY_FAILED: "sandbox_input_integrity_failed",
  OUTPUT_INVALID: "sandbox_output_invalid",
  LOG_BUDGET_EXCEEDED: "sandbox_log_budget_exceeded",
  CANCELLED: "sandbox_cancelled",
  TIMED_OUT: "sandbox_timed_out",
  RUNTIME_FAILED: "sandbox_runtime_failed",
  CLEANUP_FAILED: "sandbox_cleanup_failed",
  RECEIPT_PERSISTENCE_FAILED: "sandbox_receipt_persistence_failed"
});

const REQUEST_FIELDS: any = new Set<any>([
  "schemaVersion",
  "workloadKind",
  "principal",
  "artifact",
  "invocation",
  "inputs",
  "outputs",
  "capabilities",
  "resources",
  "governance",
  "idempotencyKey",
  "deadlineAt"
]);
const CONFIGURED_WORKLOAD_REQUEST_FIELDS: any = new Set<any>(
  [...REQUEST_FIELDS].filter((field?: any) : any => field !== "artifact")
);
const PRINCIPAL_FIELDS: any = new Set<any>(["subjectRef", "tenantRef", "workspaceRef", "operationRef"]);
const ARTIFACT_FIELDS: any = new Set<any>(["digest", "runtimeKind", "entryPoint"]);
const INVOCATION_FIELDS: any = new Set<any>(["args", "workingDirectory"]);
const INPUT_FIELDS: any = new Set<any>(["handle", "digest", "readOnly"]);
const OUTPUT_FIELDS: any = new Set<any>(["schema", "maxFiles", "maxBytes", "allowedTypes"]);
const CAPABILITY_FIELDS: any = new Set<any>([
  "filesystem",
  "network",
  "tools",
  "secretRefs",
  "clock",
  "randomness",
  "subprocesses"
]);
const RESOURCE_FIELDS: any = new Set<any>([
  "wallTimeMs",
  "cpuMillis",
  "memoryBytes",
  "processes",
  "fileDescriptors",
  "diskBytes",
  "inodes",
  "fileCount",
  "outputBytes",
  "logBytes",
  "networkBytes",
  "toolCalls"
]);
const GOVERNANCE_FIELDS: any = new Set<any>([
  "grantRef",
  "approvalRef",
  "approvalBindingDigest",
  "approvalSourceDigest",
  "approvalRequestDigest",
  "approvalExpiresAt",
  "authorizationContextDigest",
  "riskDecisionRef",
  "policyRevision",
  "authorized",
  "current",
  "revoked"
]);

function plainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value?: any, fields?: any, label?: any) : any {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object.`);
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new TypeError(`${label} contains unsupported field ${field}.`);
  }
  return value;
}

function requiredText(value?: any, label?: any, max: any = 512) : any {
  const normalized: any = String(value || "").trim();
  if (!normalized || normalized.length > max || normalized.includes("\0")) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return normalized;
}

function optionalText(value?: any, label?: any, max: any = 512) : any {
  if (value === undefined || value === null || value === "") return "";
  return requiredText(value, label, max);
}

function sha256(value?: any, label?: any) : any {
  const digest: any = requiredText(value, label, 128).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new TypeError(`${label} must be a SHA-256 digest.`);
  return digest;
}

function relativeLogicalPath(value?: any, label?: any, { allowEmpty = false }: Record<string, any> = {}) : any {
  const normalized: any = String(value || "").trim().replace(/\\/gu, "/");
  if (allowEmpty && !normalized) return "";
  requiredText(normalized, label, 1024);
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    normalized.split("/").some((segment?: any) : any => segment === ".." || segment === ".")
  ) {
    throw new TypeError(`${label} must be a normalized sandbox-relative path.`);
  }
  return normalized;
}

function stringList(value?: any, label?: any, { maxItems = 64, maxLength = 512 }: Record<string, any> = {}) : any {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${label} must be a bounded array.`);
  const normalized: any = value.map((entry?: any, index?: any) : any => optionalText(entry, `${label}[${index}]`, maxLength));
  if (normalized.some((entry?: any) : any => !entry) || new Set<any>(normalized).size !== normalized.length) {
    throw new TypeError(`${label} must contain unique non-empty strings.`);
  }
  return Object.freeze(normalized);
}

function positiveInteger(value?: any, label?: any) : any {
  const number: any = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return number;
}

function normalizePrincipal(value?: any) : any {
  const source: any = assertObject(value, PRINCIPAL_FIELDS, "principal");
  return Object.freeze({
    subjectRef: requiredText(source.subjectRef, "principal.subjectRef"),
    tenantRef: requiredText(source.tenantRef, "principal.tenantRef"),
    workspaceRef: requiredText(source.workspaceRef, "principal.workspaceRef"),
    operationRef: requiredText(source.operationRef, "principal.operationRef")
  });
}

function normalizeArtifact(value?: any) : any {
  const source: any = assertObject(value, ARTIFACT_FIELDS, "artifact");
  return Object.freeze({
    digest: sha256(source.digest, "artifact.digest"),
    runtimeKind: requiredText(source.runtimeKind, "artifact.runtimeKind", 128),
    entryPoint: relativeLogicalPath(source.entryPoint, "artifact.entryPoint")
  });
}

function normalizeInvocation(value?: any) : any {
  const source: any = assertObject(value, INVOCATION_FIELDS, "invocation");
  if (!Array.isArray(source.args) || source.args.length > 128) {
    throw new TypeError("invocation.args must be a bounded array.");
  }
  const args: any = source.args.map((entry?: any, index?: any) : any => {
    if (["string", "number", "boolean"].includes(typeof entry) && String(entry).length <= 4096) return entry;
    throw new TypeError(`invocation.args[${index}] must be a bounded scalar.`);
  });
  return Object.freeze({
    args: Object.freeze(args),
    workingDirectory: relativeLogicalPath(
      source.workingDirectory || "work",
      "invocation.workingDirectory"
    )
  });
}

function normalizeInputs(value?: any) : any {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new TypeError("inputs must be a non-empty bounded array.");
  }
  const handles: any = new Set<any>();
  return Object.freeze(value.map((entry?: any, index?: any) : any => {
    const source: any = assertObject(entry, INPUT_FIELDS, `inputs[${index}]`);
    const handle: any = requiredText(source.handle, `inputs[${index}].handle`, 512);
    if (handles.has(handle)) throw new TypeError("inputs handles must be unique.");
    handles.add(handle);
    if (source.readOnly !== true) throw new TypeError("Sandbox inputs must be explicitly read-only.");
    return Object.freeze({
      handle,
      digest: sha256(source.digest, `inputs[${index}].digest`),
      readOnly: true
    });
  }));
}

function normalizeOutputs(value?: any) : any {
  const source: any = assertObject(value, OUTPUT_FIELDS, "outputs");
  return Object.freeze({
    schema: requiredText(source.schema, "outputs.schema", 256),
    maxFiles: positiveInteger(source.maxFiles, "outputs.maxFiles"),
    maxBytes: positiveInteger(source.maxBytes, "outputs.maxBytes"),
    allowedTypes: stringList(source.allowedTypes, "outputs.allowedTypes", { maxItems: 32, maxLength: 128 })
  });
}

function normalizeCapabilities(value?: any) : any {
  const source: any = assertObject(value, CAPABILITY_FIELDS, "capabilities");
  const filesystem: any = stringList(source.filesystem || [], "capabilities.filesystem", { maxItems: 16, maxLength: 128 });
  if (filesystem.some((item?: any) : any => !["input:read", "scratch:write", "output:write"].includes(item))) {
    throw new TypeError("capabilities.filesystem contains an unsupported capability.");
  }
  return Object.freeze({
    filesystem,
    network: stringList(source.network || [], "capabilities.network", { maxItems: 32, maxLength: 256 }),
    tools: stringList(source.tools || [], "capabilities.tools", { maxItems: 32, maxLength: 256 }),
    secretRefs: stringList(source.secretRefs || [], "capabilities.secretRefs", { maxItems: 32, maxLength: 256 }),
    clock: source.clock === true,
    randomness: source.randomness === true,
    subprocesses: Number.isSafeInteger(Number(source.subprocesses)) && Number(source.subprocesses) >= 0
      ? Number(source.subprocesses)
      : 0
  });
}

function normalizeResources(value?: any) : any {
  const source: any = assertObject(value, RESOURCE_FIELDS, "resources");
  const output: Record<string, any> = {};
  for (const field of RESOURCE_FIELDS) output[field] = positiveInteger(source[field], `resources.${field}`);
  return Object.freeze(output);
}

function normalizeGovernance(value?: any) : any {
  const source: any = assertObject(value, GOVERNANCE_FIELDS, "governance");
  return Object.freeze({
    grantRef: requiredText(source.grantRef, "governance.grantRef"),
    approvalRef: optionalText(source.approvalRef, "governance.approvalRef"),
    approvalBindingDigest: source.approvalBindingDigest
      ? sha256(source.approvalBindingDigest, "governance.approvalBindingDigest")
      : "",
    approvalSourceDigest: source.approvalSourceDigest
      ? sha256(source.approvalSourceDigest, "governance.approvalSourceDigest")
      : "",
    approvalRequestDigest: source.approvalRequestDigest
      ? sha256(source.approvalRequestDigest, "governance.approvalRequestDigest")
      : "",
    approvalExpiresAt: optionalTimestamp(source.approvalExpiresAt, "governance.approvalExpiresAt"),
    authorizationContextDigest: source.authorizationContextDigest
      ? sha256(source.authorizationContextDigest, "governance.authorizationContextDigest")
      : "",
    riskDecisionRef: requiredText(source.riskDecisionRef, "governance.riskDecisionRef"),
    policyRevision: requiredText(source.policyRevision, "governance.policyRevision"),
    authorized: source.authorized === true,
    current: source.current === true,
    revoked: source.revoked === true
  });
}

function optionalTimestamp(value?: any, label?: any) : any {
  if (value === undefined || value === null || value === "") return "";
  const normalized: any = requiredText(value, label, 64);
  const parsed: any = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an ISO timestamp.`);
  return new Date(parsed).toISOString();
}

export function normalizeSandboxExecutionRequest(value?: any) : any {
  const source: any = assertObject(value, REQUEST_FIELDS, "Sandbox execution request");
  if (source.schemaVersion !== SANDBOX_REQUEST_SCHEMA) {
    throw new TypeError("Sandbox execution request schemaVersion is unsupported.");
  }
  const deadlineAt: any = requiredText(source.deadlineAt, "deadlineAt", 64);
  const deadlineTime: any = Date.parse(deadlineAt);
  if (!Number.isFinite(deadlineTime)) throw new TypeError("deadlineAt must be an ISO timestamp.");
  return Object.freeze({
    schemaVersion: SANDBOX_REQUEST_SCHEMA,
    workloadKind: requiredText(source.workloadKind, "workloadKind", 128),
    principal: normalizePrincipal(source.principal),
    artifact: normalizeArtifact(source.artifact),
    invocation: normalizeInvocation(source.invocation),
    inputs: normalizeInputs(source.inputs),
    outputs: normalizeOutputs(source.outputs),
    capabilities: normalizeCapabilities(source.capabilities),
    resources: normalizeResources(source.resources),
    governance: normalizeGovernance(source.governance),
    idempotencyKey: requiredText(source.idempotencyKey, "idempotencyKey", 256),
    deadlineAt: new Date(deadlineTime).toISOString()
  });
}

export function normalizeSandboxConfiguredWorkloadRequest(value?: any) : any {
  const source: any = assertObject(
    value,
    CONFIGURED_WORKLOAD_REQUEST_FIELDS,
    "Sandbox configured workload request"
  );
  if (source.schemaVersion !== SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA) {
    throw new TypeError("Sandbox configured workload request schemaVersion is unsupported.");
  }
  const deadlineAt: any = requiredText(source.deadlineAt, "deadlineAt", 64);
  const deadlineTime: any = Date.parse(deadlineAt);
  if (!Number.isFinite(deadlineTime)) throw new TypeError("deadlineAt must be an ISO timestamp.");
  return Object.freeze({
    schemaVersion: SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA,
    workloadKind: requiredText(source.workloadKind, "workloadKind", 128),
    principal: normalizePrincipal(source.principal),
    invocation: normalizeInvocation(source.invocation),
    inputs: normalizeInputs(source.inputs),
    outputs: normalizeOutputs(source.outputs),
    capabilities: normalizeCapabilities(source.capabilities),
    resources: normalizeResources(source.resources),
    governance: normalizeGovernance(source.governance),
    idempotencyKey: requiredText(source.idempotencyKey, "idempotencyKey", 256),
    deadlineAt: new Date(deadlineTime).toISOString()
  });
}

export function bindSandboxConfiguredWorkloadRequest(value?: any, artifact?: any) : any {
  const request: any = normalizeSandboxConfiguredWorkloadRequest(value);
  return normalizeSandboxExecutionRequest({
    ...request,
    schemaVersion: SANDBOX_REQUEST_SCHEMA,
    artifact
  });
}

export function stableSandboxJson(value?: any) : any {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableSandboxJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key?: any) : any => `${JSON.stringify(key)}:${stableSandboxJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sandboxDigest(value?: any) : any {
  return crypto.createHash("sha256").update(stableSandboxJson(value)).digest("hex");
}

export function sandboxApprovalRequestDigest(value?: any) : any {
  const request: any = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const governance: any = request.governance && typeof request.governance === "object" && !Array.isArray(request.governance)
    ? request.governance
    : {};
  const { approvalRequestDigest: _approvalRequestDigest, ...approvalGovernance } = governance;
  return sandboxDigest({ ...request, governance: approvalGovernance });
}

export function controlledRef(value?: any, namespace: any = "ref") : any {
  return `${namespace}:${sandboxDigest(String(value || "")).slice(0, 24)}`;
}

export function createSandboxDenialReceipt({ request = null, reasonCode, now = new Date() }: Record<string, any> = {}) : any {
  const createdAt: any = now.toISOString();
  const requestDigest: any = request ? sandboxDigest(request) : "";
  const runId: any = requestDigest
    ? `run:${requestDigest.slice(0, 24)}`
    : `denial:${sandboxDigest({ reasonCode, createdAt }).slice(0, 24)}`;
  return Object.freeze({
    schemaVersion: SANDBOX_RECEIPT_SCHEMA,
    runId,
    requestDigest,
    status: "denied",
    reasonCode: String(reasonCode || SANDBOX_DENIAL_REASONS.REQUEST_INVALID),
    runtimeState: "not_started",
    cleanupState: "not_required",
    outputDisposition: "none",
    createdAt,
    finishedAt: createdAt
  });
}
