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

type UnknownRecord = Record<string, unknown>;
type InvocationScalar = string | number | boolean;

export interface SandboxPrincipal {
  subjectRef: string;
  tenantRef: string;
  workspaceRef: string;
  operationRef: string;
}

export interface SandboxArtifact {
  digest: string;
  runtimeKind: string;
  entryPoint: string;
}

export interface SandboxInvocation {
  args: readonly InvocationScalar[];
  workingDirectory: string;
}

export interface SandboxInput {
  handle: string;
  digest: string;
  readOnly: true;
}

export interface SandboxOutputs {
  schema: string;
  maxFiles: number;
  maxBytes: number;
  allowedTypes: readonly string[];
}

export interface SandboxCapabilities {
  filesystem: readonly string[];
  network: readonly string[];
  tools: readonly string[];
  secretRefs: readonly string[];
  clock: boolean;
  randomness: boolean;
  subprocesses: number;
}

export interface SandboxGovernance {
  grantRef: string;
  approvalRef: string;
  approvalBindingDigest: string;
  approvalSourceDigest: string;
  approvalRequestDigest: string;
  approvalExpiresAt: string;
  authorizationContextDigest: string;
  riskDecisionRef: string;
  policyRevision: string;
  authorized: boolean;
  current: boolean;
  revoked: boolean;
}

export interface SandboxExecutionRequest {
  schemaVersion: typeof SANDBOX_REQUEST_SCHEMA;
  workloadKind: string;
  principal: Readonly<SandboxPrincipal>;
  artifact: Readonly<SandboxArtifact>;
  invocation: Readonly<SandboxInvocation>;
  inputs: readonly Readonly<SandboxInput>[];
  outputs: Readonly<SandboxOutputs>;
  capabilities: Readonly<SandboxCapabilities>;
  resources: Readonly<Record<string, number>>;
  governance: Readonly<SandboxGovernance>;
  idempotencyKey: string;
  deadlineAt: string;
}

export interface SandboxConfiguredWorkloadRequest extends Omit<SandboxExecutionRequest, "schemaVersion" | "artifact"> {
  schemaVersion: typeof SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA;
}

export interface SandboxDenialReceipt {
  schemaVersion: typeof SANDBOX_RECEIPT_SCHEMA;
  runId: string;
  requestDigest: string;
  status: "denied";
  reasonCode: string;
  runtimeState: "not_started";
  cleanupState: "not_required";
  outputDisposition: "none";
  createdAt: string;
  finishedAt: string;
}

const REQUEST_FIELDS = new Set<string>([
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
const CONFIGURED_WORKLOAD_REQUEST_FIELDS = new Set<string>(
  [...REQUEST_FIELDS].filter((field) => field !== "artifact")
);
const PRINCIPAL_FIELDS = new Set<string>(["subjectRef", "tenantRef", "workspaceRef", "operationRef"]);
const ARTIFACT_FIELDS = new Set<string>(["digest", "runtimeKind", "entryPoint"]);
const INVOCATION_FIELDS = new Set<string>(["args", "workingDirectory"]);
const INPUT_FIELDS = new Set<string>(["handle", "digest", "readOnly"]);
const OUTPUT_FIELDS = new Set<string>(["schema", "maxFiles", "maxBytes", "allowedTypes"]);
const CAPABILITY_FIELDS = new Set<string>([
  "filesystem",
  "network",
  "tools",
  "secretRefs",
  "clock",
  "randomness",
  "subprocesses"
]);
const RESOURCE_FIELDS = new Set<string>([
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
const GOVERNANCE_FIELDS = new Set<string>([
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

function plainObject(value: unknown): value is UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value: unknown, fields: ReadonlySet<string>, label: string): UnknownRecord {
  if (!plainObject(value)) throw new TypeError(`${label} must be an object.`);
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new TypeError(`${label} contains unsupported field ${field}.`);
  }
  return value;
}

function requiredText(value: unknown, label: string, max = 512): string {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > max || normalized.includes("\0")) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return normalized;
}

function optionalText(value: unknown, label: string, max = 512): string {
  if (value === undefined || value === null || value === "") return "";
  return requiredText(value, label, max);
}

function sha256(value: unknown, label: string): string {
  const digest = requiredText(value, label, 128).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new TypeError(`${label} must be a SHA-256 digest.`);
  return digest;
}

function relativeLogicalPath(value: unknown, label: string, { allowEmpty = false }: { allowEmpty?: boolean } = {}): string {
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

function stringList(
  value: unknown,
  label: string,
  { maxItems = 64, maxLength = 512 }: { maxItems?: number; maxLength?: number } = {}
): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${label} must be a bounded array.`);
  const normalized = value.map((entry, index) => optionalText(entry, `${label}[${index}]`, maxLength));
  if (normalized.some((entry) => !entry) || new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} must contain unique non-empty strings.`);
  }
  return Object.freeze(normalized);
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return number;
}

function normalizePrincipal(value: unknown): Readonly<SandboxPrincipal> {
  const source = assertObject(value, PRINCIPAL_FIELDS, "principal");
  return Object.freeze({
    subjectRef: requiredText(source.subjectRef, "principal.subjectRef"),
    tenantRef: requiredText(source.tenantRef, "principal.tenantRef"),
    workspaceRef: requiredText(source.workspaceRef, "principal.workspaceRef"),
    operationRef: requiredText(source.operationRef, "principal.operationRef")
  });
}

function normalizeArtifact(value: unknown): Readonly<SandboxArtifact> {
  const source = assertObject(value, ARTIFACT_FIELDS, "artifact");
  return Object.freeze({
    digest: sha256(source.digest, "artifact.digest"),
    runtimeKind: requiredText(source.runtimeKind, "artifact.runtimeKind", 128),
    entryPoint: relativeLogicalPath(source.entryPoint, "artifact.entryPoint")
  });
}

function normalizeInvocation(value: unknown): Readonly<SandboxInvocation> {
  const source = assertObject(value, INVOCATION_FIELDS, "invocation");
  if (!Array.isArray(source.args) || source.args.length > 128) {
    throw new TypeError("invocation.args must be a bounded array.");
  }
  const args = source.args.map((entry, index): InvocationScalar => {
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

function normalizeInputs(value: unknown): readonly Readonly<SandboxInput>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new TypeError("inputs must be a non-empty bounded array.");
  }
  const handles = new Set<string>();
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

function normalizeOutputs(value: unknown): Readonly<SandboxOutputs> {
  const source = assertObject(value, OUTPUT_FIELDS, "outputs");
  return Object.freeze({
    schema: requiredText(source.schema, "outputs.schema", 256),
    maxFiles: positiveInteger(source.maxFiles, "outputs.maxFiles"),
    maxBytes: positiveInteger(source.maxBytes, "outputs.maxBytes"),
    allowedTypes: stringList(source.allowedTypes, "outputs.allowedTypes", { maxItems: 32, maxLength: 128 })
  });
}

function normalizeCapabilities(value: unknown): Readonly<SandboxCapabilities> {
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

function normalizeResources(value: unknown): Readonly<Record<string, number>> {
  const source = assertObject(value, RESOURCE_FIELDS, "resources");
  const output: Record<string, number> = {};
  for (const field of RESOURCE_FIELDS) output[field] = positiveInteger(source[field], `resources.${field}`);
  return Object.freeze(output);
}

function normalizeGovernance(value: unknown): Readonly<SandboxGovernance> {
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

function optionalTimestamp(value: unknown, label: string): string {
  if (value === undefined || value === null || value === "") return "";
  const normalized = requiredText(value, label, 64);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an ISO timestamp.`);
  return new Date(parsed).toISOString();
}

export function normalizeSandboxExecutionRequest(value: unknown): Readonly<SandboxExecutionRequest> {
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

export function normalizeSandboxConfiguredWorkloadRequest(value: unknown): Readonly<SandboxConfiguredWorkloadRequest> {
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

export function bindSandboxConfiguredWorkloadRequest(
  value: unknown,
  artifact: unknown
): Readonly<SandboxExecutionRequest> {
  const request = normalizeSandboxConfiguredWorkloadRequest(value);
  return normalizeSandboxExecutionRequest({
    ...request,
    schemaVersion: SANDBOX_REQUEST_SCHEMA,
    artifact
  });
}

export function stableSandboxJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableSandboxJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSandboxJson((value as UnknownRecord)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value)!;
}

export function sandboxDigest(value: unknown): string {
  return crypto.createHash("sha256").update(stableSandboxJson(value)).digest("hex");
}

export function sandboxApprovalRequestDigest(value: unknown): string {
  const request: UnknownRecord = plainObject(value) ? value : {};
  const governance: UnknownRecord = plainObject(request.governance)
    ? request.governance
    : {};
  const { approvalRequestDigest: _approvalRequestDigest, ...approvalGovernance } = governance;
  return sandboxDigest({ ...request, governance: approvalGovernance });
}

export function controlledRef(value: unknown, namespace = "ref"): string {
  return `${namespace}:${sandboxDigest(String(value || "")).slice(0, 24)}`;
}

export function createSandboxDenialReceipt({
  request = null,
  reasonCode,
  now = new Date()
}: {
  request?: unknown;
  reasonCode?: unknown;
  now?: Date;
} = {}): Readonly<SandboxDenialReceipt> {
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
