import crypto from "node:crypto";

export const SANDBOX_REQUEST_SCHEMA = "v0.0.1:execution-sandbox:request-1";
export const SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA =
  "v0.0.1:execution-sandbox:configured-workload-request-1";
export const SANDBOX_RECEIPT_SCHEMA = "v0.0.1:execution-sandbox:receipt-1";
export const SANDBOX_PROVIDER_CONFORMANCE_SCHEMA = "v0.0.1:execution-sandbox:provider-conformance-1";
export const CONTROLLED_SANDBOX_FINAL_RECEIPT_ID = "31000000-0000-4000-8000-000000000047";

export const SANDBOX_DENIAL_REASONS = Object.freeze({
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

const REQUEST_FIELDS = new Set([
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
const CONFIGURED_WORKLOAD_REQUEST_FIELDS = new Set(
  [...REQUEST_FIELDS].filter((field) => field !== "artifact")
);
const PRINCIPAL_FIELDS = new Set(["subjectRef", "tenantRef", "workspaceRef", "operationRef"]);
const ARTIFACT_FIELDS = new Set(["digest", "runtimeKind", "entryPoint"]);
const INVOCATION_FIELDS = new Set(["args", "workingDirectory"]);
const INPUT_FIELDS = new Set(["handle", "digest", "readOnly"]);
const OUTPUT_FIELDS = new Set(["schema", "maxFiles", "maxBytes", "allowedTypes"]);
const CAPABILITY_FIELDS = new Set([
  "filesystem",
  "network",
  "tools",
  "secretRefs",
  "clock",
  "randomness",
  "subprocesses"
]);
const RESOURCE_FIELDS = new Set([
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
const GOVERNANCE_FIELDS = new Set([
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

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, fields, label) {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object.`);
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new TypeError(`${label} contains unsupported field ${field}.`);
  }
  return value;
}

function requiredText(value, label, max = 512) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > max || normalized.includes("\0")) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return normalized;
}

function optionalText(value, label, max = 512) {
  if (value === undefined || value === null || value === "") return "";
  return requiredText(value, label, max);
}

function sha256(value, label) {
  const digest = requiredText(value, label, 128).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new TypeError(`${label} must be a SHA-256 digest.`);
  return digest;
}

function relativeLogicalPath(value, label, { allowEmpty = false } = {}) {
  const normalized = String(value || "").trim().replace(/\\/gu, "/");
  if (allowEmpty && !normalized) return "";
  requiredText(normalized, label, 1024);
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    normalized.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new TypeError(`${label} must be a normalized sandbox-relative path.`);
  }
  return normalized;
}

function stringList(value, label, { maxItems = 64, maxLength = 512 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${label} must be a bounded array.`);
  const normalized = value.map((entry, index) => optionalText(entry, `${label}[${index}]`, maxLength));
  if (normalized.some((entry) => !entry) || new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} must contain unique non-empty strings.`);
  }
  return Object.freeze(normalized);
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return number;
}

function normalizePrincipal(value) {
  const source = assertObject(value, PRINCIPAL_FIELDS, "principal");
  return Object.freeze({
    subjectRef: requiredText(source.subjectRef, "principal.subjectRef"),
    tenantRef: requiredText(source.tenantRef, "principal.tenantRef"),
    workspaceRef: requiredText(source.workspaceRef, "principal.workspaceRef"),
    operationRef: requiredText(source.operationRef, "principal.operationRef")
  });
}

function normalizeArtifact(value) {
  const source = assertObject(value, ARTIFACT_FIELDS, "artifact");
  return Object.freeze({
    digest: sha256(source.digest, "artifact.digest"),
    runtimeKind: requiredText(source.runtimeKind, "artifact.runtimeKind", 128),
    entryPoint: relativeLogicalPath(source.entryPoint, "artifact.entryPoint")
  });
}

function normalizeInvocation(value) {
  const source = assertObject(value, INVOCATION_FIELDS, "invocation");
  if (!Array.isArray(source.args) || source.args.length > 128) {
    throw new TypeError("invocation.args must be a bounded array.");
  }
  const args = source.args.map((entry, index) => {
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

function normalizeInputs(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new TypeError("inputs must be a non-empty bounded array.");
  }
  const handles = new Set();
  return Object.freeze(value.map((entry, index) => {
    const source = assertObject(entry, INPUT_FIELDS, `inputs[${index}]`);
    const handle = requiredText(source.handle, `inputs[${index}].handle`, 512);
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

function normalizeOutputs(value) {
  const source = assertObject(value, OUTPUT_FIELDS, "outputs");
  return Object.freeze({
    schema: requiredText(source.schema, "outputs.schema", 256),
    maxFiles: positiveInteger(source.maxFiles, "outputs.maxFiles"),
    maxBytes: positiveInteger(source.maxBytes, "outputs.maxBytes"),
    allowedTypes: stringList(source.allowedTypes, "outputs.allowedTypes", { maxItems: 32, maxLength: 128 })
  });
}

function normalizeCapabilities(value) {
  const source = assertObject(value, CAPABILITY_FIELDS, "capabilities");
  const filesystem = stringList(source.filesystem || [], "capabilities.filesystem", { maxItems: 16, maxLength: 128 });
  if (filesystem.some((item) => !["input:read", "scratch:write", "output:write"].includes(item))) {
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

function normalizeResources(value) {
  const source = assertObject(value, RESOURCE_FIELDS, "resources");
  const output = {};
  for (const field of RESOURCE_FIELDS) output[field] = positiveInteger(source[field], `resources.${field}`);
  return Object.freeze(output);
}

function normalizeGovernance(value) {
  const source = assertObject(value, GOVERNANCE_FIELDS, "governance");
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

function optionalTimestamp(value, label) {
  if (value === undefined || value === null || value === "") return "";
  const normalized = requiredText(value, label, 64);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an ISO timestamp.`);
  return new Date(parsed).toISOString();
}

export function normalizeSandboxExecutionRequest(value) {
  const source = assertObject(value, REQUEST_FIELDS, "Sandbox execution request");
  if (source.schemaVersion !== SANDBOX_REQUEST_SCHEMA) {
    throw new TypeError("Sandbox execution request schemaVersion is unsupported.");
  }
  const deadlineAt = requiredText(source.deadlineAt, "deadlineAt", 64);
  const deadlineTime = Date.parse(deadlineAt);
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

export function normalizeSandboxConfiguredWorkloadRequest(value) {
  const source = assertObject(
    value,
    CONFIGURED_WORKLOAD_REQUEST_FIELDS,
    "Sandbox configured workload request"
  );
  if (source.schemaVersion !== SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA) {
    throw new TypeError("Sandbox configured workload request schemaVersion is unsupported.");
  }
  const deadlineAt = requiredText(source.deadlineAt, "deadlineAt", 64);
  const deadlineTime = Date.parse(deadlineAt);
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

export function bindSandboxConfiguredWorkloadRequest(value, artifact) {
  const request = normalizeSandboxConfiguredWorkloadRequest(value);
  return normalizeSandboxExecutionRequest({
    ...request,
    schemaVersion: SANDBOX_REQUEST_SCHEMA,
    artifact
  });
}

export function stableSandboxJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableSandboxJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSandboxJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sandboxDigest(value) {
  return crypto.createHash("sha256").update(stableSandboxJson(value)).digest("hex");
}

export function sandboxApprovalRequestDigest(value) {
  const request = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const governance = request.governance && typeof request.governance === "object" && !Array.isArray(request.governance)
    ? request.governance
    : {};
  const { approvalRequestDigest: _approvalRequestDigest, ...approvalGovernance } = governance;
  return sandboxDigest({ ...request, governance: approvalGovernance });
}

export function controlledRef(value, namespace = "ref") {
  return `${namespace}:${sandboxDigest(String(value || "")).slice(0, 24)}`;
}

export function createSandboxDenialReceipt({ request = null, reasonCode, now = new Date() } = {}) {
  const createdAt = now.toISOString();
  const requestDigest = request ? sandboxDigest(request) : "";
  const runId = requestDigest
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
