import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash } from "node:crypto";

import { assertQueueDefinitionCanEnqueue, normalizeStructuredQueueScope } from "./definitions.mjs";
import { DEFAULT_QUEUE_POLICY } from "./policies.mjs";

export const WORK_QUEUE_MAX_CHECKPOINT_REF_BYTES = 2 * 1024;
const CHECKPOINT_TOKEN = /^[A-Za-z0-9._:-]+$/u;

export function toText(value) {
  return String(value ?? "").trim();
}

export function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

export function asArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

export function asInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function asPositiveInt(value, fallback = 1) {
  return Math.max(1, asInt(value, fallback));
}

export function jsonString(value, fallback = null) {
  return JSON.stringify(value ?? fallback);
}

export function parseJson(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}


export function normalizeCheckpointRef(value) {
  const source = asObject(value, null);
  if (!source) {
    const error = new Error("Queue checkpointRef must be an object.");
    error.code = "work_queue_checkpoint_invalid";
    throw error;
  }
  const allowed = new Set(["kind", "ref", "revision", "digest"]);
  if (Object.keys(source).some((key) => !allowed.has(key))) {
    const error = new Error("Queue checkpointRef contains unsupported fields.");
    error.code = "work_queue_checkpoint_invalid";
    throw error;
  }
  const checkpointRef = {
    kind: toText(source.kind),
    ref: toText(source.ref),
    revision: toText(source.revision),
    digest: toText(source.digest)
  };
  if (!checkpointRef.kind || !checkpointRef.ref ||
      !CHECKPOINT_TOKEN.test(checkpointRef.kind) || !CHECKPOINT_TOKEN.test(checkpointRef.ref) ||
      (checkpointRef.revision && !CHECKPOINT_TOKEN.test(checkpointRef.revision)) ||
      (checkpointRef.digest && !/^sha256:[a-f0-9]{64}$/u.test(checkpointRef.digest))) {
    const error = new Error("Queue checkpointRef must contain bounded opaque identifiers.");
    error.code = "work_queue_checkpoint_invalid";
    throw error;
  }
  const serialized = stableJson(checkpointRef);
  if (Buffer.byteLength(serialized, "utf8") > WORK_QUEUE_MAX_CHECKPOINT_REF_BYTES) {
    const error = new Error("Queue checkpointRef exceeds its byte budget.");
    error.code = "work_queue_checkpoint_capacity_exceeded";
    error.limit = WORK_QUEUE_MAX_CHECKPOINT_REF_BYTES;
    throw error;
  }
  return {
    checkpointRef,
    serialized,
    checkpointDigest: createHash("sha256").update(serialized).digest("hex")
  };
}

export function queueDefinitionSnapshot(definition = {}) {
  return {
    queueDefinitionId: toText(definition.queueDefinitionId ?? definition.queue_definition_id),
    queueDefinitionVersion: asPositiveInt(
      definition.queueDefinitionVersion ?? definition.queue_definition_version,
      1
    ),
    label: toText(definition.label),
    lifecycleState: toText(definition.lifecycleState ?? definition.lifecycle_state ?? "active"),
    ownerCapability: toText(definition.ownerCapability ?? definition.owner_capability ?? "system"),
    allowDeprecatedEnqueue: definition.allowDeprecatedEnqueue === true
      || definition.allow_deprecated_enqueue === true
      || definition.allow_deprecated_enqueue === 1,
    metadata: parseJson(definition.metadata ?? definition.metadata_json, {}),
    policy: parseJson(definition.policy ?? definition.policy_json, {}),
    routes: parseJson(definition.routes ?? definition.routes_json, []),
    labelHistory: parseJson(definition.labelHistory ?? definition.label_history_json, [])
  };
}

export function queueDefinitionConflict(message) {
  const error = new Error(message);
  error.code = "work_queue_definition_conflict";
  return error;
}

export function normalizeScope(scope = {}) {
  return normalizeStructuredQueueScope(scope);
}

export function scopeKeyFromScope(scope = {}) {
  return stableJson(normalizeScope(scope));
}

export function workItemMatchesBoundary(row, input = {}) {
  if (!row) return false;
  const queueDefinitionId = toText(
    input.queueDefinitionId || input.queueDefinition?.queueDefinitionId
  );
  if (queueDefinitionId && toText(row.queue_definition_id) !== queueDefinitionId) {
    return false;
  }
  const hasScope = Object.hasOwn(input, "scopeKey") || Object.hasOwn(input, "scope");
  const scopeKey = Object.hasOwn(input, "scopeKey")
    ? toText(input.scopeKey)
    : hasScope
      ? scopeKeyFromScope(input.scope)
      : "";
  return !hasScope || toText(row.scope_key) === scopeKey;
}

export function requireWorkItemBoundary(row, input = {}) {
  if (workItemMatchesBoundary(row, input)) return row;
  const error = new Error(`Work item not found: ${toText(input.workItemId)}`);
  error.code = "work_queue_item_not_found";
  throw error;
}

export function nowFrom(timeSource, override) {
  return asInt(override, asInt(timeSource.nowMs(), Date.now()));
}

export function resolveWorkExpiryAtMs({ nowMs, availableAtMs, expiresAtMs, policy = {} } = {}) {
  const expiryPolicy = asObject(policy.workExpiry, DEFAULT_QUEUE_POLICY.workExpiry);
  const defaultLifetimeMs = Math.max(1, asInt(
    expiryPolicy.defaultLifetimeMs,
    DEFAULT_QUEUE_POLICY.workExpiry.defaultLifetimeMs
  ));
  const maxLifetimeMs = Math.max(defaultLifetimeMs, asInt(
    expiryPolicy.maxLifetimeMs,
    DEFAULT_QUEUE_POLICY.workExpiry.maxLifetimeMs
  ));
  const requested = expiresAtMs === undefined || expiresAtMs === null
    ? nowMs + defaultLifetimeMs
    : Number(expiresAtMs);
  if (!Number.isSafeInteger(requested)) {
    throw new Error("expiresAtMs must be a safe integer timestamp.");
  }
  if (requested <= nowMs) {
    throw new Error("expiresAtMs must be later than the admission time.");
  }
  if (requested <= availableAtMs) {
    throw new Error("expiresAtMs must be later than availableAtMs.");
  }
  if (requested - nowMs > maxLifetimeMs) {
    throw new Error("expiresAtMs exceeds the queue work lifetime limit.");
  }
  return requested;
}

export function getPolicy(inputPolicy = {}) {
  const resolved = {
    ...DEFAULT_QUEUE_POLICY,
    ...asObject(inputPolicy),
    retryBackoff: {
      ...DEFAULT_QUEUE_POLICY.retryBackoff,
      ...asObject(inputPolicy.retryBackoff)
    },
    workExpiry: {
      ...DEFAULT_QUEUE_POLICY.workExpiry,
      ...asObject(inputPolicy.workExpiry)
    },
    fallbackRetry: {
      ...DEFAULT_QUEUE_POLICY.fallbackRetry,
      ...asObject(inputPolicy.fallbackRetry)
    },
    backgroundWriteRetry: {
      ...DEFAULT_QUEUE_POLICY.backgroundWriteRetry,
      ...asObject(inputPolicy.backgroundWriteRetry)
    },
    memoryGuard: {
      ...DEFAULT_QUEUE_POLICY.memoryGuard,
      ...asObject(inputPolicy.memoryGuard)
    },
    capacity: {
      ...DEFAULT_QUEUE_POLICY.capacity,
      ...asObject(inputPolicy.capacity)
    },
    retention: {
      ...DEFAULT_QUEUE_POLICY.retention,
      ...asObject(inputPolicy.retention)
    },
    fairness: {
      ...DEFAULT_QUEUE_POLICY.fairness,
      ...asObject(inputPolicy.fairness)
    }
  };
  for (const [group, key] of [
    ["capacity", "maxPayloadRefBytes"],
    ["capacity", "maxOutstanding"],
    ["capacity", "maxOutstandingPerTenant"],
    ["capacity", "maxOutstandingPerWorkspace"],
    ["capacity", "maxOutstandingPerProject"],
    ["capacity", "maxDelayed"],
    ["capacity", "maxLeased"],
    ["capacity", "maxLeasedPerTenant"],
    ["capacity", "maxLeasedPerWorkspace"],
    ["capacity", "maxLeasedPerProject"],
    ["capacity", "maxFailed"],
    ["retention", "maxTerminalItems"],
    ["retention", "maxJournalEntries"],
    ["retention", "maxTransitionsPerWorkItem"],
    ["retention", "cleanupBatchSize"]
    , ["fairness", "maxVisitsPerClaim"]
    , ["fairness", "agingIntervalMs"]
    , ["fairness", "agingBatchSize"]
    , ["fairness", "minReservedLeasesPerPartition"]
    , ["fairness", "reservationScanLimit"]
  ]) {
    const value = Number(resolved[group][key]);
    if (!Number.isSafeInteger(value) || value < 1) {
      const error = new Error(`Queue policy ${group}.${key} must be a finite positive integer.`);
      error.code = "work_queue_policy_invalid";
      error.reason = `${group}.${key}`;
      throw error;
    }
  }
  return resolved;
}

export function resolveQueueDefinition(input = {}, { assertEnqueue = false, allowAllVersions = false } = {}) {
  const definition = asObject(input.queueDefinition || input.definition, {});
  const queueDefinitionId = toText(
    input.queueDefinitionId ||
      definition.queueDefinitionId ||
      input.queueId ||
      definition.queueId
  );
  if (!queueDefinitionId) {
    throw new Error("queueDefinitionId is required.");
  }
  const rawVersion = input.queueDefinitionVersion ??
    input.version ??
    definition.queueDefinitionVersion ??
    definition.version;
  const queueDefinitionVersion = rawVersion === undefined && allowAllVersions
    ? 0
    : asPositiveInt(rawVersion, 1);
  if (assertEnqueue && Object.keys(definition).length) {
    assertQueueDefinitionCanEnqueue(definition);
  }
  return {
    queueDefinitionId,
    queueDefinitionVersion,
    queueDefinition: definition
  };
}

export function normalizePayloadRef(value) {
  const payloadRef = asObject(value, null);
  if (!payloadRef || Object.keys(payloadRef).length === 0) {
    throw new Error("payloadRef is required and must be a structured reference.");
  }
  return payloadRef;
}

export function serializePayloadRef(value) {
  const ancestors = new Set();
  const visit = (candidate, depth) => {
    if (depth > 16) throw new TypeError("payloadRef exceeds the supported nesting depth.");
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate !== "object") throw new TypeError("payloadRef contains a non-JSON value.");
    if (ancestors.has(candidate)) throw new TypeError("payloadRef contains a circular reference.");
    const prototype = Object.getPrototypeOf(candidate);
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("payloadRef must contain only JSON objects and arrays.");
    }
    ancestors.add(candidate);
    const normalized = Array.isArray(candidate)
      ? candidate.map((item) => visit(item, depth + 1))
      : Object.fromEntries(Object.entries(candidate).map(([key, item]) => [key, visit(item, depth + 1)]));
    ancestors.delete(candidate);
    return normalized;
  };
  try {
    return JSON.stringify(visit(value, 0));
  } catch (cause) {
    const error = new Error("payloadRef must be a bounded JSON-compatible structured reference.", { cause });
    error.code = "work_queue_payload_ref_invalid";
    throw error;
  }
}

export function assertDedupeFingerprint(existingRow, {
  queueDefinitionVersion,
  payloadRef,
  ownerRef,
  schedulingScope = {}
}) {
  const requestedSchedulingScope = normalizeScope(schedulingScope);
  const existingFingerprint = stableJson({
    queueDefinitionVersion: Number(existingRow.queue_definition_version || 0),
    payloadRef: parseJson(existingRow.payload_ref_json, {}),
    ownerRef: parseJson(existingRow.owner_ref_json, {}),
    schedulingScope: {
      tenantId: existingRow.tenant_id || "",
      workspaceId: existingRow.workspace_id || "",
      projectId: existingRow.project_id || ""
    }
  });
  const requestedFingerprint = stableJson({
    queueDefinitionVersion: Number(queueDefinitionVersion || 0),
    payloadRef,
    ownerRef,
    schedulingScope: {
      tenantId: requestedSchedulingScope.tenantId || "",
      workspaceId: requestedSchedulingScope.workspaceId || "",
      projectId: requestedSchedulingScope.projectId || ""
    }
  });
  if (existingFingerprint !== requestedFingerprint) {
    const error = new Error("The dedupe key is already bound to a different immutable work request.");
    error.code = "work_queue_dedupe_conflict";
    throw error;
  }
}

export function normalizeOwnerRef(value) {
  return asObject(value, {});
}

export function rowToWorkItem(row) {
  if (!row) {
    return null;
  }
  const leaseId = toText(row.lease_id);
  return {
    workItemId: row.work_item_id,
    queueDefinitionId: row.queue_definition_id,
    queueDefinitionVersion: Number(row.queue_definition_version || 0),
    scopeKey: row.scope_key,
    scope: parseJson(row.scope_json, {}),
    schedulingScope: {
      tenantId: row.tenant_id || "",
      workspaceId: row.workspace_id || "",
      projectId: row.project_id || ""
    },
    dedupeKey: row.dedupe_key || "",
    state: row.state,
    ownerRef: parseJson(row.owner_ref_json, {}),
    payloadRef: parseJson(row.payload_ref_json, {}),
    payloadKind: row.payload_kind || "",
    priority: Number(row.priority || 0),
    priorityClass: row.priority_class || "normal",
    availableAtMs: Number(row.available_at_ms || 0),
    expiresAtMs: Number(row.expires_at_ms || 0),
    attempt: Number(row.attempt || 0),
    maxAttempts: Number(row.max_attempts || 0),
    lease: leaseId
      ? {
          leaseId,
          leaseSeq: Number(row.lease_seq || 0),
          workerId: row.leased_by_worker_id,
          expiresAtMs: Number(row.lease_expires_at_ms || 0)
        }
      : null,
    concurrencyKey: row.concurrency_key || "",
    routeVersion: row.route_version || "",
    policyVersion: row.policy_version || "",
    fallbackTaskId: row.fallback_task_id || "",
    checkpoint: Number(row.checkpoint_seq || 0) > 0
      ? {
          checkpointRef: parseJson(row.checkpoint_ref_json, {}),
          checkpointDigest: row.checkpoint_digest || "",
          checkpointSeq: Number(row.checkpoint_seq || 0),
          updatedAtMs: Number(row.checkpoint_updated_at_ms || 0)
        }
      : null,
    lastError: parseJson(row.last_error_json, {}),
    createdAtMs: Number(row.created_at_ms || 0),
    updatedAtMs: Number(row.updated_at_ms || 0),
    lastTransitionSeq: Number(row.last_transition_seq || 0)
  };
}

export function journalRowToTransition(row) {
  return {
    seq: Number(row.seq || 0),
    journalEntryId: row.journal_entry_id,
    workItemId: row.work_item_id,
    queueDefinitionId: row.queue_definition_id,
    queueDefinitionVersion: Number(row.queue_definition_version || 0),
    transition: row.transition,
    fromState: row.from_state || null,
    toState: row.to_state,
    leaseId: row.lease_id || "",
    leaseSeq: Number(row.lease_seq || 0),
    operationId: row.operation_id || "",
    actor: parseJson(row.actor_json, {}),
    reason: row.reason || "",
    policyVersion: row.policy_version || "",
    decision: parseJson(row.decision_json, {}),
    createdAtMs: Number(row.created_at_ms || 0),
    adoptedTimeMs: Number(row.adopted_time_ms || 0)
  };
}

export { stableJson };
