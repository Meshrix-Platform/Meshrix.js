import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash } from "node:crypto";

import { assertQueueDefinitionCanEnqueue, normalizeStructuredQueueScope } from "./definitions.ts";
import { DEFAULT_QUEUE_POLICY } from "./policies.ts";

export const WORK_QUEUE_MAX_CHECKPOINT_REF_BYTES: any = 2 * 1024;
const CHECKPOINT_TOKEN: any = /^[A-Za-z0-9._:-]+$/u;

export function toText(value?: any) : any {
  return String(value ?? "").trim();
}

export function asObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

export function asArray(value?: any, fallback: any = []) : any {
  return Array.isArray(value) ? value : fallback;
}

export function asInt(value?: any, fallback: any = 0) : any {
  const parsed: any = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function asPositiveInt(value?: any, fallback: any = 1) : any {
  return Math.max(1, asInt(value, fallback));
}

export function jsonString(value?: any, fallback: any = null) : any {
  return JSON.stringify(value ?? fallback);
}

export function parseJson(value?: any, fallback?: any) : any {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    const parsed: any = JSON.parse(String(value || ""));
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}


export function normalizeCheckpointRef(value?: any) : any {
  const source: any = asObject(value, null);
  if (!source) {
    const error: Error & Record<string, any> = new Error("Queue checkpointRef must be an object.");
    error.code = "work_queue_checkpoint_invalid";
    throw error;
  }
  const allowed: any = new Set<any>(["kind", "ref", "revision", "digest"]);
  if (Object.keys(source).some((key?: any) : any => !allowed.has(key))) {
    const error: Error & Record<string, any> = new Error("Queue checkpointRef contains unsupported fields.");
    error.code = "work_queue_checkpoint_invalid";
    throw error;
  }
  const checkpointRef: Record<string, any> = {
    kind: toText(source.kind),
    ref: toText(source.ref),
    revision: toText(source.revision),
    digest: toText(source.digest)
  };
  if (!checkpointRef.kind || !checkpointRef.ref ||
      !CHECKPOINT_TOKEN.test(checkpointRef.kind) || !CHECKPOINT_TOKEN.test(checkpointRef.ref) ||
      (checkpointRef.revision && !CHECKPOINT_TOKEN.test(checkpointRef.revision)) ||
      (checkpointRef.digest && !/^sha256:[a-f0-9]{64}$/u.test(checkpointRef.digest))) {
    const error: Error & Record<string, any> = new Error("Queue checkpointRef must contain bounded opaque identifiers.");
    error.code = "work_queue_checkpoint_invalid";
    throw error;
  }
  const serialized: any = stableJson(checkpointRef);
  if (Buffer.byteLength(serialized, "utf8") > WORK_QUEUE_MAX_CHECKPOINT_REF_BYTES) {
    const error: Error & Record<string, any> = new Error("Queue checkpointRef exceeds its byte budget.");
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

export function queueDefinitionSnapshot(definition: Record<string, any> = {}) : any {
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

export function queueDefinitionConflict(message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = "work_queue_definition_conflict";
  return error;
}

export function normalizeScope(scope: Record<string, any> = {}) : any {
  return normalizeStructuredQueueScope(scope);
}

export function scopeKeyFromScope(scope: Record<string, any> = {}) : any {
  return stableJson(normalizeScope(scope));
}

export function workItemMatchesBoundary(row?: any, input: Record<string, any> = {}) : any {
  if (!row) return false;
  const queueDefinitionId: any = toText(
    input.queueDefinitionId || input.queueDefinition?.queueDefinitionId
  );
  if (queueDefinitionId && toText(row.queue_definition_id) !== queueDefinitionId) {
    return false;
  }
  const hasScope: any = Object.hasOwn(input, "scopeKey") || Object.hasOwn(input, "scope");
  const scopeKey: any = Object.hasOwn(input, "scopeKey")
    ? toText(input.scopeKey)
    : hasScope
      ? scopeKeyFromScope(input.scope)
      : "";
  return !hasScope || toText(row.scope_key) === scopeKey;
}

export function requireWorkItemBoundary(row?: any, input: Record<string, any> = {}) : any {
  if (workItemMatchesBoundary(row, input)) return row;
  const error: Error & Record<string, any> = new Error(`Work item not found: ${toText(input.workItemId)}`);
  error.code = "work_queue_item_not_found";
  throw error;
}

export function nowFrom(timeSource?: any, override?: any) : any {
  return asInt(override, asInt(timeSource.nowMs(), Date.now()));
}

export function resolveWorkExpiryAtMs({ nowMs, availableAtMs, expiresAtMs, policy = {} }: Record<string, any> = {}) : any {
  const expiryPolicy: any = asObject(policy.workExpiry, DEFAULT_QUEUE_POLICY.workExpiry);
  const defaultLifetimeMs: any = Math.max(1, asInt(
    expiryPolicy.defaultLifetimeMs,
    DEFAULT_QUEUE_POLICY.workExpiry.defaultLifetimeMs
  ));
  const maxLifetimeMs: any = Math.max(defaultLifetimeMs, asInt(
    expiryPolicy.maxLifetimeMs,
    DEFAULT_QUEUE_POLICY.workExpiry.maxLifetimeMs
  ));
  const requested: any = expiresAtMs === undefined || expiresAtMs === null
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

export function getPolicy(inputPolicy: Record<string, any> = {}) : any {
  const resolved: Record<string, any> = {
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
    const value: any = Number(resolved[group][key]);
    if (!Number.isSafeInteger(value) || value < 1) {
      const error: Error & Record<string, any> = new Error(`Queue policy ${group}.${key} must be a finite positive integer.`);
      error.code = "work_queue_policy_invalid";
      error.reason = `${group}.${key}`;
      throw error;
    }
  }
  return resolved;
}

export function resolveQueueDefinition(input: Record<string, any> = {}, { assertEnqueue = false, allowAllVersions = false }: Record<string, any> = {}) : any {
  const definition: any = asObject(input.queueDefinition || input.definition, {});
  const queueDefinitionId: any = toText(
    input.queueDefinitionId ||
      definition.queueDefinitionId ||
      input.queueId ||
      definition.queueId
  );
  if (!queueDefinitionId) {
    throw new Error("queueDefinitionId is required.");
  }
  const rawVersion: any = input.queueDefinitionVersion ??
    input.version ??
    definition.queueDefinitionVersion ??
    definition.version;
  const queueDefinitionVersion: any = rawVersion === undefined && allowAllVersions
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

export function normalizePayloadRef(value?: any) : any {
  const payloadRef: any = asObject(value, null);
  if (!payloadRef || Object.keys(payloadRef).length === 0) {
    throw new Error("payloadRef is required and must be a structured reference.");
  }
  return payloadRef;
}

export function serializePayloadRef(value?: any) : any {
  const ancestors: any = new Set<any>();
  const visit: any = (candidate?: any, depth?: any) : any => {
    if (depth > 16) throw new TypeError("payloadRef exceeds the supported nesting depth.");
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate !== "object") throw new TypeError("payloadRef contains a non-JSON value.");
    if (ancestors.has(candidate)) throw new TypeError("payloadRef contains a circular reference.");
    const prototype: any = Object.getPrototypeOf(candidate);
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("payloadRef must contain only JSON objects and arrays.");
    }
    ancestors.add(candidate);
    const normalized: any = Array.isArray(candidate)
      ? candidate.map((item?: any) : any => visit(item, depth + 1))
      : Object.fromEntries((Object.entries(candidate) as [string, any][]).map(([key, item]: any[]) : any => [key, visit(item, depth + 1)]));
    ancestors.delete(candidate);
    return normalized;
  };
  try {
    return JSON.stringify(visit(value, 0));
  } catch (cause: any) {
    const error: Error & Record<string, any> = new Error("payloadRef must be a bounded JSON-compatible structured reference.", { cause });
    error.code = "work_queue_payload_ref_invalid";
    throw error;
  }
}

export function assertDedupeFingerprint(existingRow: any, {
  queueDefinitionVersion,
  payloadRef,
  ownerRef,
  schedulingScope = {}
}: Record<string, any>) : any {
  const requestedSchedulingScope: any = normalizeScope(schedulingScope);
  const existingFingerprint: any = stableJson({
    queueDefinitionVersion: Number(existingRow.queue_definition_version || 0),
    payloadRef: parseJson(existingRow.payload_ref_json, {}),
    ownerRef: parseJson(existingRow.owner_ref_json, {}),
    schedulingScope: {
      tenantId: existingRow.tenant_id || "",
      workspaceId: existingRow.workspace_id || "",
      projectId: existingRow.project_id || ""
    }
  });
  const requestedFingerprint: any = stableJson({
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
    const error: Error & Record<string, any> = new Error("The dedupe key is already bound to a different immutable work request.");
    error.code = "work_queue_dedupe_conflict";
    throw error;
  }
}

export function normalizeOwnerRef(value?: any) : any {
  return asObject(value, {});
}

export function rowToWorkItem(row?: any) : any {
  if (!row) {
    return null;
  }
  const leaseId: any = toText(row.lease_id);
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

export function journalRowToTransition(row?: any) : any {
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
