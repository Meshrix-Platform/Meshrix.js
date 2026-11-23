// Canonical wire contract for organization-managed endpoints.
// `meshrix.managed-endpoint/1` is the language-neutral protocol shared by the
// server (this package) and independently owned native managed-device agents.
// Server checks use these closed schemas as neutral protocol fixtures; they
// never import or execute any client repository.

export const MANAGED_ENDPOINT_PROTOCOL = "meshrix.managed-endpoint/1" as const;

export type ManagedJson =
  | null
  | boolean
  | number
  | string
  | ManagedJson[]
  | { [key: string]: ManagedJson };

export interface ManagedActor {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly subjectId: string;
}

export interface ManagedCapability {
  readonly capabilityId: string;
  readonly label: string;
  readonly kind: "command" | "agent";
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly revision: number;
}

export interface ManagedWorkspace {
  readonly workspaceId: string;
  readonly label: string;
  readonly hint?: ManagedJson;
}

export interface ManagedEndpoint {
  readonly endpointId: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly label: string;
  readonly kind: "workstation" | "shared";
  readonly state: "pending" | "active" | "revoked";
  readonly generation: number;
  readonly allowedCapabilityIds: readonly string[];
  readonly publishedCapabilities: readonly ManagedCapability[];
  readonly publishedWorkspaces: readonly ManagedWorkspace[];
}

export interface ManagedTaskRequest {
  readonly requestId: string;
  readonly endpointId?: string;
  readonly capabilityId: string;
  readonly workspaceId?: string;
  readonly input: ManagedJson;
  readonly signature?: ManagedSignature;
}

export interface ManagedTaskAssignment {
  readonly protocol: typeof MANAGED_ENDPOINT_PROTOCOL;
  readonly taskId: string;
  readonly endpointId: string;
  readonly organizationId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: number;
  readonly workspaceId?: string;
  readonly input: ManagedJson;
  readonly leaseId: string;
  readonly leaseSeq: number;
  readonly signature?: ManagedSignature;
}

export interface ManagedTaskOutcome {
  readonly taskId: string;
  readonly leaseId: string;
  readonly leaseSeq: number;
  readonly state: "succeeded" | "failed" | "cancelled" | "unknown";
  readonly result: ManagedJson;
  readonly errorCode?: string;
}

export interface ManagedTaskStartResponse {
  readonly taskId: string;
  readonly leaseId: string;
  readonly leaseSeq: number;
  readonly authorized: boolean;
  readonly cancelRequested: boolean;
}

// --- Detached attestations (opaque to the server) ---
// `signature` is an optional detached attestation produced by an authority
// outside this protocol's custody — on a task request it attests the dispatch
// tuple the requesting authority committed to, and the same envelope shape
// carries an organization's signature policy sheet. The server validates only
// the envelope's structure and bounds and relays it byte-for-byte; it never
// interprets `payload`, verifies `signature` or holds key material.

export const MANAGED_SIGNATURE_ALGORITHM_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
export const MANAGED_SIGNATURE_KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
export const MANAGED_SIGNATURE_VALUE_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;
export const MANAGED_SIGNATURE_PAYLOAD_MAX_BYTES = 8 * 1024;
export const MANAGED_SIGNATURE_POLICY_MAX_BYTES = 32 * 1024;

export interface ManagedSignature {
  readonly algorithm: string;
  readonly keyId: string;
  readonly payload: ManagedJson;
  readonly signature: string;
}

export const MANAGED_ENDPOINT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
export const MANAGED_CAPABILITY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
export const MANAGED_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;
export const MANAGED_LEASE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/u;
export const MANAGED_DEVICE_CREDENTIAL_PATTERN = /^mdc_[A-Za-z0-9_-]{20,}$/u;
export const MANAGED_ENROLLMENT_TOKEN_PATTERN = /^met_[A-Za-z0-9_-]{20,}$/u;

export const MANAGED_TASK_INPUT_MAX_BYTES = 64 * 1024;
export const MANAGED_TASK_RESULT_MAX_BYTES = 256 * 1024;
export const MANAGED_CAPABILITY_MAX_COUNT = 256;
export const MANAGED_ENDPOINT_LABEL_MAX = 160;
export const MANAGED_ENDPOINT_MAX_COUNT = 4096;
export const MANAGED_WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
export const MANAGED_WORKSPACE_MAX_COUNT = 64;
export const MANAGED_WORKSPACE_HINT_MAX_BYTES = 4 * 1024;

function failure(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, statusCode: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      failure(code, `Field is not part of the managed endpoint contract: ${key}`);
    }
  }
}

function boundedText(
  value: unknown,
  field: string,
  code: string,
  { max = 160, pattern = null as RegExp | null, optional = false, trim = true } = {}
): string {
  if (value === undefined || value === null) {
    if (optional) return "";
    failure(code, `Field ${field} is required.`);
  }
  if (typeof value !== "string") failure(code, `Field ${field} must be a string.`);
  const text = trim ? value.trim() : value;
  if (!text || text.length > max || (pattern && !pattern.test(text))) {
    failure(code, `Field ${field} is invalid.`);
  }
  return text;
}

function boundedInteger(
  value: unknown,
  field: string,
  code: string,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {}
): number {
  if (typeof value !== "number") failure(code, `Field ${field} must be a number.`);
  const parsed = value;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    failure(code, `Field ${field} is not a bounded integer.`);
  }
  return parsed;
}

export function assertManagedJson(value: unknown, field: string, code: string, maxBytes: number): ManagedJson {
  const active = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (depth > 64) failure(code, `Field ${field} exceeds its nesting budget.`);
    if (item === null || typeof item === "boolean" || typeof item === "string") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER) {
        failure(code, `Field ${field} contains an unsafe JSON number.`);
      }
      return;
    }
    if (typeof item !== "object" || active.has(item) ||
        (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype &&
          Object.getPrototypeOf(item) !== null)) {
      failure(code, `Field ${field} must contain only JSON values.`);
    }
    active.add(item);
    for (const entry of Object.values(item)) visit(entry, depth + 1);
    active.delete(item);
  }
  visit(value, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(value === undefined ? null : value);
  } catch {
    failure(code, `Field ${field} must be JSON-serializable.`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    failure(code, `Field ${field} exceeds its byte budget.`);
  }
  return (value === undefined ? null : value) as ManagedJson;
}

export function assertManagedTaskStartResponse(value: unknown): ManagedTaskStartResponse {
  const code = "managed_task_start_invalid";
  if (!isRecord(value)) failure(code, "Managed start response must be an object.");
  exactKeys(value, ["taskId", "leaseId", "leaseSeq", "authorized", "cancelRequested"], code);
  if (typeof value.authorized !== "boolean" || typeof value.cancelRequested !== "boolean" ||
      (value.authorized && value.cancelRequested)) {
    failure(code, "Managed start authorization flags are invalid.");
  }
  return Object.freeze({
    taskId: boundedText(value.taskId, "taskId", code),
    leaseId: boundedText(value.leaseId, "leaseId", code, { pattern: MANAGED_LEASE_ID_PATTERN }),
    leaseSeq: boundedInteger(value.leaseSeq, "leaseSeq", code, { min: 1 }),
    authorized: value.authorized,
    cancelRequested: value.cancelRequested
  });
}

export function assertManagedFields(value: unknown, keys: readonly string[], code = "managed_body_invalid"): Record<string, unknown> {
  if (!isRecord(value)) failure(code, "Managed input must be an object.");
  exactKeys(value, keys, code);
  return value;
}

export function assertManagedId(value: unknown, field: string, pattern = MANAGED_ENDPOINT_ID_PATTERN): string {
  return boundedText(value, field, "managed_body_invalid", { pattern });
}

export function assertManagedInteger(value: unknown, field: string, min: number, max: number): number {
  return boundedInteger(value, field, "managed_body_invalid", { min, max });
}

export function assertManagedCapabilityIds(value: unknown): readonly string[] {
  return stringIdList(value, "allowedCapabilityIds", "managed_capability_set_invalid");
}

function stringIdList(
  value: unknown,
  field: string,
  code: string,
  { max = MANAGED_CAPABILITY_MAX_COUNT } = {}
): readonly string[] {
  if (!Array.isArray(value)) {
    failure(code, `Field ${field} must be an array.`);
  }
  const items = value.map((entry) => boundedText(entry, field, code, {
    pattern: MANAGED_CAPABILITY_ID_PATTERN
  }));
  if (items.length > max || new Set(items).size !== items.length) {
    failure(code, `Field ${field} exceeds its bounded item set.`);
  }
  return Object.freeze(items);
}

export function assertManagedActor(value: unknown): ManagedActor {
  const code = "managed_actor_invalid";
  if (!isRecord(value)) failure(code, "Managed actor must be an object.");
  exactKeys(value, ["tenantId", "organizationId", "subjectId"], code);
  const actor: ManagedActor = Object.freeze({
    tenantId: boundedText(value.tenantId, "tenantId", code, { pattern: MANAGED_ENDPOINT_ID_PATTERN }),
    organizationId: boundedText(value.organizationId, "organizationId", code, { pattern: MANAGED_ENDPOINT_ID_PATTERN }),
    subjectId: boundedText(value.subjectId, "subjectId", code, { max: 160 })
  });
  return actor;
}

export function assertManagedCapability(value: unknown): ManagedCapability {
  const code = "managed_capability_invalid";
  if (!isRecord(value)) failure(code, "Managed capability must be an object.");
  exactKeys(value, ["capabilityId", "label", "kind", "inputSchema", "revision"], code);
  const kind = boundedText(value.kind, "kind", code);
  if (kind !== "command" && kind !== "agent") {
    failure(code, "Managed capability kind must be command or agent.");
  }
  if (!isRecord(value.inputSchema)) {
    failure(code, "Managed capability inputSchema must be a JSON object.");
  }
  assertManagedJson(value.inputSchema, "inputSchema", code, 16 * 1024);
  const capability: ManagedCapability = Object.freeze({
    capabilityId: boundedText(value.capabilityId, "capabilityId", code, {
      pattern: MANAGED_CAPABILITY_ID_PATTERN
    }),
    label: boundedText(value.label, "label", code, { max: MANAGED_ENDPOINT_LABEL_MAX }),
    kind: kind as ManagedCapability["kind"],
    inputSchema: Object.freeze({ ...value.inputSchema }),
    revision: boundedInteger(value.revision, "revision", code, { min: 1 })
  });
  return capability;
}

export function assertManagedEndpoint(value: unknown): ManagedEndpoint {
  const code = "managed_endpoint_invalid";
  if (!isRecord(value)) failure(code, "Managed endpoint must be an object.");
  exactKeys(value, [
    "endpointId", "tenantId", "organizationId", "label", "kind",
    "state", "generation", "allowedCapabilityIds", "publishedCapabilities", "publishedWorkspaces"
  ], code);
  const kind = boundedText(value.kind, "kind", code);
  if (kind !== "workstation" && kind !== "shared") {
    failure(code, "Managed endpoint kind must be workstation or shared.");
  }
  const state = boundedText(value.state, "state", code);
  if (!["pending", "active", "revoked"].includes(state)) {
    failure(code, "Managed endpoint state must be pending, active or revoked.");
  }
  if (!Array.isArray(value.publishedCapabilities)) {
    failure(code, "Managed endpoint publishedCapabilities must be an array.");
  }
  if (value.publishedCapabilities.length > MANAGED_CAPABILITY_MAX_COUNT) {
    failure(code, "Managed endpoint publishedCapabilities exceeds its bounded set.");
  }
  const endpoint: ManagedEndpoint = Object.freeze({
    endpointId: boundedText(value.endpointId, "endpointId", code, {
      pattern: MANAGED_ENDPOINT_ID_PATTERN
    }),
    tenantId: boundedText(value.tenantId, "tenantId", code, { pattern: MANAGED_ENDPOINT_ID_PATTERN }),
    organizationId: boundedText(value.organizationId, "organizationId", code, {
      pattern: MANAGED_ENDPOINT_ID_PATTERN
    }),
    label: boundedText(value.label, "label", code, { max: MANAGED_ENDPOINT_LABEL_MAX }),
    kind: kind as ManagedEndpoint["kind"],
    state: state as ManagedEndpoint["state"],
    generation: boundedInteger(value.generation, "generation", code, { min: 0 }),
    allowedCapabilityIds: stringIdList(value.allowedCapabilityIds, "allowedCapabilityIds", code),
    publishedCapabilities: Object.freeze(
      value.publishedCapabilities.map((capability) => assertManagedCapability(capability))
    ),
    publishedWorkspaces: assertManagedWorkspaceList(value.publishedWorkspaces)
  });
  return endpoint;
}

export function assertManagedWorkspace(value: unknown): ManagedWorkspace {
  const code = "managed_workspace_invalid";
  if (!isRecord(value)) failure(code, "Managed workspace must be an object.");
  exactKeys(value, ["workspaceId", "label", "hint"], code);
  const workspace: ManagedWorkspace = Object.freeze({
    workspaceId: boundedText(value.workspaceId, "workspaceId", code, {
      pattern: MANAGED_WORKSPACE_ID_PATTERN
    }),
    label: boundedText(value.label, "label", code, { max: MANAGED_ENDPOINT_LABEL_MAX }),
    ...(value.hint === undefined
      ? {}
      : { hint: assertManagedJson(value.hint, "hint", code, MANAGED_WORKSPACE_HINT_MAX_BYTES) })
  });
  return workspace;
}

export function assertManagedWorkspaceList(value: unknown): readonly ManagedWorkspace[] {
  const code = "managed_workspace_set_invalid";
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MANAGED_WORKSPACE_MAX_COUNT) {
    failure(code, "Managed workspace set is invalid.");
  }
  const workspaces = value.map((entry) => assertManagedWorkspace(entry));
  if (new Set(workspaces.map((entry) => entry.workspaceId)).size !== workspaces.length) {
    failure(code, "Managed workspace set is duplicated.");
  }
  return Object.freeze(workspaces);
}

export function assertManagedSignaturePolicy(value: unknown): ManagedJson {
  const code = "managed_signature_policy_invalid";
  if (!isRecord(value)) failure(code, "Managed signature policy must be an object.");
  return assertManagedJson(value, "policy", code, MANAGED_SIGNATURE_POLICY_MAX_BYTES);
}

export function assertManagedSignature(value: unknown): ManagedSignature {
  const code = "managed_signature_invalid";
  if (!isRecord(value)) failure(code, "Managed signature must be an object.");
  exactKeys(value, ["algorithm", "keyId", "payload", "signature"], code);
  // The envelope is relayed byte-for-byte, so the submitted strings themselves
  // must satisfy the declared patterns and bounds — a padded value that would
  // only pass after trimming is rejected rather than silently preserved.
  boundedText(value.algorithm, "algorithm", code, { pattern: MANAGED_SIGNATURE_ALGORITHM_PATTERN, trim: false });
  boundedText(value.keyId, "keyId", code, { pattern: MANAGED_SIGNATURE_KEY_ID_PATTERN, trim: false });
  assertManagedJson(value.payload, "payload", code, MANAGED_SIGNATURE_PAYLOAD_MAX_BYTES);
  boundedText(value.signature, "signature", code, {
    max: 2048, pattern: MANAGED_SIGNATURE_VALUE_PATTERN, trim: false
  });
  // Content is relayed exactly as submitted — the server never interprets,
  // re-encodes or verifies the envelope it carries to the device.
  return Object.freeze({
    algorithm: value.algorithm as string,
    keyId: value.keyId as string,
    payload: value.payload as ManagedSignature["payload"],
    signature: value.signature as string
  });
}

export function assertManagedTaskRequest(value: unknown): ManagedTaskRequest {
  const code = "managed_task_request_invalid";
  if (!isRecord(value)) failure(code, "Managed task request must be an object.");
  exactKeys(value, ["requestId", "endpointId", "capabilityId", "workspaceId", "input", "signature"], code);
  const request: ManagedTaskRequest = Object.freeze({
    requestId: boundedText(value.requestId, "requestId", code, {
      pattern: MANAGED_REQUEST_ID_PATTERN
    }),
    ...(boundedText(value.endpointId, "endpointId", code, {
      pattern: MANAGED_ENDPOINT_ID_PATTERN, optional: true
    })
      ? {
          endpointId: boundedText(value.endpointId, "endpointId", code, {
            pattern: MANAGED_ENDPOINT_ID_PATTERN
          })
        }
      : {}),
    capabilityId: boundedText(value.capabilityId, "capabilityId", code, {
      pattern: MANAGED_CAPABILITY_ID_PATTERN
    }),
    ...(boundedText(value.workspaceId, "workspaceId", code, {
      pattern: MANAGED_WORKSPACE_ID_PATTERN, optional: true
    })
      ? { workspaceId: boundedText(value.workspaceId, "workspaceId", code, { pattern: MANAGED_WORKSPACE_ID_PATTERN }) }
      : {}),
    input: assertManagedJson(value.input, "input", code, MANAGED_TASK_INPUT_MAX_BYTES),
    ...(value.signature === undefined ? {} : { signature: assertManagedSignature(value.signature) })
  });
  return request;
}

export function assertManagedTaskAssignment(value: unknown): ManagedTaskAssignment {
  const code = "managed_task_assignment_invalid";
  if (!isRecord(value)) failure(code, "Managed task assignment must be an object.");
  exactKeys(value, [
    "protocol", "taskId", "endpointId", "organizationId", "capabilityId",
    "capabilityRevision", "workspaceId", "input", "leaseId", "leaseSeq", "signature"
  ], code);
  if (value.protocol !== MANAGED_ENDPOINT_PROTOCOL) {
    failure(code, "Managed task assignment protocol is not current.");
  }
  const assignment: ManagedTaskAssignment = Object.freeze({
    protocol: MANAGED_ENDPOINT_PROTOCOL,
    taskId: boundedText(value.taskId, "taskId", code, { max: 160 }),
    endpointId: boundedText(value.endpointId, "endpointId", code, {
      pattern: MANAGED_ENDPOINT_ID_PATTERN
    }),
    organizationId: boundedText(value.organizationId, "organizationId", code, {
      pattern: MANAGED_ENDPOINT_ID_PATTERN
    }),
    capabilityId: boundedText(value.capabilityId, "capabilityId", code, {
      pattern: MANAGED_CAPABILITY_ID_PATTERN
    }),
    capabilityRevision: boundedInteger(value.capabilityRevision, "capabilityRevision", code, { min: 1 }),
    ...(boundedText(value.workspaceId, "workspaceId", code, {
      pattern: MANAGED_WORKSPACE_ID_PATTERN, optional: true
    })
      ? { workspaceId: boundedText(value.workspaceId, "workspaceId", code, { pattern: MANAGED_WORKSPACE_ID_PATTERN }) }
      : {}),
    input: assertManagedJson(value.input, "input", code, MANAGED_TASK_INPUT_MAX_BYTES),
    leaseId: boundedText(value.leaseId, "leaseId", code, { pattern: MANAGED_LEASE_ID_PATTERN }),
    leaseSeq: boundedInteger(value.leaseSeq, "leaseSeq", code, { min: 1 }),
    ...(value.signature === undefined ? {} : { signature: assertManagedSignature(value.signature) })
  });
  return assignment;
}

export function assertManagedTaskOutcome(value: unknown): ManagedTaskOutcome {
  const code = "managed_task_outcome_invalid";
  if (!isRecord(value)) failure(code, "Managed task outcome must be an object.");
  exactKeys(value, ["taskId", "leaseId", "leaseSeq", "state", "result", "errorCode"], code);
  const state = boundedText(value.state, "state", code);
  if (!["succeeded", "failed", "cancelled", "unknown"].includes(state)) {
    failure(code, "Managed task outcome state is invalid.");
  }
  const outcome: ManagedTaskOutcome = Object.freeze({
    taskId: boundedText(value.taskId, "taskId", code, { max: 160 }),
    leaseId: boundedText(value.leaseId, "leaseId", code, { pattern: MANAGED_LEASE_ID_PATTERN }),
    leaseSeq: boundedInteger(value.leaseSeq, "leaseSeq", code, { min: 1 }),
    state: state as ManagedTaskOutcome["state"],
    result: assertManagedJson(value.result, "result", code, MANAGED_TASK_RESULT_MAX_BYTES),
    ...(boundedText(value.errorCode, "errorCode", code, { max: 120, optional: true })
      ? { errorCode: boundedText(value.errorCode, "errorCode", code, { max: 120 }) }
      : {})
  });
  return outcome;
}

// --- Log relay primitives (zero-copy, device-journal authority) ---
// Frames are byte-opaque: `data` is base64 so the server relays bytes without
// interpreting or re-encoding them. The server never persists frames; the
// device journal is the sole durable authority and any read — live or
// historical — requires the device online.

export const MANAGED_LOG_FRAME_MAX_BYTES = 64 * 1024;
export const MANAGED_LOG_BATCH_MAX_FRAMES = 64;
export const MANAGED_FETCH_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;

export interface ManagedLogFrame {
  readonly seq: number;
  readonly data: string;
  readonly eof?: boolean;
}

export interface ManagedLogAppendBody {
  readonly taskId: string;
  readonly leaseId: string;
  readonly leaseSeq: number;
  readonly frames: readonly ManagedLogFrame[];
  readonly fetchId?: string;
}

// Server→worker directive delivered inside a poll `controls` entry. The
// worker replays the requested journal segment via `worker.log.append`
// carrying the same `fetchId` so the relay can bind frames to the waiting
// member stream.
export interface ManagedLogFetchDirective {
  readonly type: "log-fetch";
  readonly taskId: string;
  readonly fetchId: string;
  readonly fromSeq: number;
}

export function assertManagedLogFrame(value: unknown): ManagedLogFrame {
  const code = "managed_log_frame_invalid";
  if (!isRecord(value)) failure(code, "Managed log frame must be an object.");
  exactKeys(value, ["seq", "data", "eof"], code);
  const data = boundedText(value.data, "data", code, {
    max: Math.ceil(MANAGED_LOG_FRAME_MAX_BYTES / 3) * 4 + 8
  });
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
    failure(code, "Managed log frame data must be base64.");
  }
  return Object.freeze({
    seq: boundedInteger(value.seq, "seq", code, { min: 1 }),
    data,
    ...(typeof value.eof === "boolean" ? { eof: value.eof } : {})
  });
}

export function assertManagedLogAppend(value: unknown): ManagedLogAppendBody {
  const code = "managed_log_append_invalid";
  if (!isRecord(value)) failure(code, "Managed log append must be an object.");
  exactKeys(value, ["taskId", "leaseId", "leaseSeq", "frames", "fetchId"], code);
  if (!Array.isArray(value.frames) || value.frames.length > MANAGED_LOG_BATCH_MAX_FRAMES) {
    failure(code, "Managed log append frames exceed their bounded set.");
  }
  return Object.freeze({
    taskId: boundedText(value.taskId, "taskId", code),
    leaseId: boundedText(value.leaseId, "leaseId", code, { pattern: MANAGED_LEASE_ID_PATTERN }),
    leaseSeq: boundedInteger(value.leaseSeq, "leaseSeq", code, { min: 1 }),
    frames: Object.freeze(value.frames.map((frame) => assertManagedLogFrame(frame))),
    ...(boundedText(value.fetchId, "fetchId", code, { pattern: MANAGED_FETCH_ID_PATTERN, optional: true })
      ? { fetchId: boundedText(value.fetchId, "fetchId", code, { pattern: MANAGED_FETCH_ID_PATTERN }) }
      : {})
  });
}

export function assertManagedLogFetchDirective(value: unknown): ManagedLogFetchDirective {
  const code = "managed_log_fetch_invalid";
  if (!isRecord(value)) failure(code, "Managed log fetch directive must be an object.");
  exactKeys(value, ["type", "taskId", "fetchId", "fromSeq"], code);
  if (value.type !== "log-fetch") failure(code, "Managed log fetch directive type is invalid.");
  return Object.freeze({
    type: "log-fetch",
    taskId: boundedText(value.taskId, "taskId", code),
    fetchId: boundedText(value.fetchId, "fetchId", code, { pattern: MANAGED_FETCH_ID_PATTERN }),
    fromSeq: boundedInteger(value.fromSeq, "fromSeq", code, { min: 1 })
  });
}

// --- Task events (structured timeline, server-durable, replayable) ---
// `worker.event` is the single device entry point; `tasks.events` is the
// member read. `seq` is assigned by the device, strictly increasing per task;
// `task.*` kinds are reserved for protocol lifecycle and never accepted from
// a worker. Events persist server-side (≤256 per task) and are replayable
// without the device online — the deliberate asymmetry against the byte log.

export const MANAGED_EVENT_KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,4}$/u;
export const MANAGED_EVENT_KIND_MAX = 80;
export const MANAGED_EVENT_PAYLOAD_MAX_BYTES = 16 * 1024;
export const MANAGED_EVENT_BATCH_MAX = 64;
export const MANAGED_EVENT_MAX_COUNT = 256;
export const MANAGED_TASK_EVENTS_WAIT_MAX_MS = 60_000;
export const MANAGED_EVENT_RESERVED_PREFIX = "task.";

export interface ManagedTaskEvent {
  readonly seq: number;
  readonly kind: string;
  readonly at: string;
  readonly payload: ManagedJson;
}

export function assertManagedTaskEvent(value: unknown): ManagedTaskEvent {
  const code = "managed_event_invalid";
  if (!isRecord(value)) failure(code, "Managed task event must be an object.");
  exactKeys(value, ["seq", "kind", "at", "payload"], code);
  const kind = boundedText(value.kind, "kind", code, {
    max: MANAGED_EVENT_KIND_MAX, pattern: MANAGED_EVENT_KIND_PATTERN
  });
  const at = boundedText(value.at, "at", code, { max: 64 });
  if (Number.isNaN(Date.parse(at))) failure(code, "Managed task event at must be an ISO-8601 timestamp.");
  return Object.freeze({
    seq: boundedInteger(value.seq, "seq", code, { min: 1 }),
    kind,
    at,
    payload: assertManagedJson(value.payload, "payload", code, MANAGED_EVENT_PAYLOAD_MAX_BYTES)
  });
}

export function assertManagedTaskEventBatch(value: unknown): readonly ManagedTaskEvent[] {
  const code = "managed_event_batch_invalid";
  if (!Array.isArray(value) || value.length > MANAGED_EVENT_BATCH_MAX) {
    failure(code, "Managed task event batch exceeds its bounded set.");
  }
  const events = value.map((entry) => assertManagedTaskEvent(entry));
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].kind.startsWith(MANAGED_EVENT_RESERVED_PREFIX)) {
      failure(code, "Managed task event kind is reserved for the protocol.");
    }
    if (index > 0 && events[index].seq <= events[index - 1].seq) {
      failure(code, "Managed task event seq must be strictly increasing within a batch.");
    }
  }
  return Object.freeze(events);
}
