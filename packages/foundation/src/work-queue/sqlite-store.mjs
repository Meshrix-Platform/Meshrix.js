import fs from "node:fs";
import path from "node:path";
import { openSqliteDatabase } from "../storage/sqlite-database.mjs";

import { queueIdentityGenerator } from "./identity.mjs";
import { computeDeterministicRetryDelay, DEFAULT_QUEUE_POLICY } from "./policies.mjs";
import {
  isTerminalWorkQueueState,
  WORK_QUEUE_STATES
} from "../workflow/state-machine/work-queue/state-machine.mjs";
import { systemQueueTimeSource } from "./time-source.mjs";
import { ensureSqliteWorkQueueSchema } from "./sqlite-schema.mjs";
import { prepareSqliteWorkQueueStatements } from "./sqlite-statements.mjs";
import { createSqliteWorkQueueRuntime } from "./sqlite-store-runtime.mjs";
import { rebuildSqliteProjection } from "./sqlite-rebuild-projection.mjs";
import {
  assertCapacityAtMost,
  assertCapacityBelow,
  agedWorkQueuePriorityClass,
  hierarchicalScopeParts,
  nextPriorityCursor,
  normalizeWorkQueuePriority,
  priorityClassAtCursor,
  WORK_QUEUE_PRIORITY_CYCLE
} from "./scheduling.mjs";
import {
  asArray,
  asInt,
  asPositiveInt,
  assertDedupeFingerprint,
  getPolicy,
  journalRowToTransition,
  jsonString,
  normalizeCheckpointRef,
  normalizeOwnerRef,
  normalizePayloadRef,
  serializePayloadRef,
  normalizeScope,
  nowFrom,
  parseJson,
  queueDefinitionConflict,
  queueDefinitionSnapshot,
  resolveQueueDefinition,
  resolveWorkExpiryAtMs,
  rowToWorkItem,
  scopeKeyFromScope,
  stableJson,
  toText,
  workItemMatchesBoundary,
  requireWorkItemBoundary
} from "./store-serialization.mjs";

export function getWorkQueueDatabaseDirectory(userDataPath) {
  return path.join(String(userDataPath || ""), "work-queue");
}

export function getWorkQueueDatabasePath(userDataPath) {
  return path.join(getWorkQueueDatabaseDirectory(userDataPath), "work-queue.sqlite");
}

export function createSqliteWorkQueueStore({
  userDataPath = "",
  databasePath = "",
  db = null,
  timeSource = systemQueueTimeSource,
  identityGenerator = queueIdentityGenerator,
  policy = DEFAULT_QUEUE_POLICY
} = {}) {
  const resolvedPolicy = getPolicy(policy);
  const resolvedDatabasePath = db ? "" : path.resolve(databasePath || getWorkQueueDatabasePath(userDataPath));
  if (!db && !resolvedDatabasePath) {
    throw new Error("Work queue SQLite store requires userDataPath or databasePath.");
  }
  if (!db) {
    fs.mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true });
  }
  const database = db || openSqliteDatabase(resolvedDatabasePath);
  const ownsDatabase = !db;
  try {
    return createSqliteWorkQueueStoreFromDatabase({
      database,
      ownsDatabase,
      resolvedDatabasePath,
      timeSource,
      identityGenerator,
      resolvedPolicy
    });
  } catch (error) {
    if (ownsDatabase) {
      try {
        database.close();
      } catch {
        // Preserve the construction failure; cleanup is best effort.
      }
    }
    throw error;
  }
}

function createSqliteWorkQueueStoreFromDatabase({
  database,
  ownsDatabase,
  resolvedDatabasePath,
  timeSource,
  identityGenerator,
  resolvedPolicy
}) {
  let closed = false;
  ensureSqliteWorkQueueSchema(database);

  const statements = prepareSqliteWorkQueueStatements(database);

  const {
    appendTransitionInternal,
    transitionProjection: transitionProjectionInternal,
    recordBackgroundWrite,
    expireEligibleLocked,
    materializeDelayedLocked,
    recoverExpiredLeasesLocked,
    requireLeasedRow
  } = createSqliteWorkQueueRuntime({ statements, timeSource, identityGenerator, resolvedPolicy });

  function cleanupFairnessCursorsIfIdle(row) {
    if (!row || !isTerminalWorkQueueState(row.state)) return;
    const boundary = {
      queue_definition_id: row.queue_definition_id,
      scope_key: row.scope_key,
      completed_state: WORK_QUEUE_STATES.COMPLETED,
      cancelled_state: WORK_QUEUE_STATES.CANCELLED,
      expired_state: WORK_QUEUE_STATES.EXPIRED
    };
    if (Number(statements.countNonterminalByBoundary.get(boundary)?.count || 0) === 0) {
      statements.deleteFairnessCursorsByBoundary.run(boundary);
    }
  }

  function transitionProjection(input) {
    const updated = transitionProjectionInternal(input);
    cleanupFairnessCursorsIfIdle(updated);
    return updated;
  }

  function boundedCount(statement, filters, limit) {
    return Number(statement.get({ ...filters, limit: Number(limit) + 1 })?.count || 0);
  }

  function assertAdmissionCapacity({ queueDefinitionId, hierarchy, state, policy }) {
    const capacity = policy.capacity;
    const empty = { tenant_id: "", workspace_id: "", project_id: "" };
    const checks = [
      ["queue_outstanding", capacity.maxOutstanding, empty],
      ["tenant_outstanding", capacity.maxOutstandingPerTenant, {
        ...empty,
        tenant_id: hierarchy.tenantId
      }],
      ["workspace_outstanding", capacity.maxOutstandingPerWorkspace, {
        ...empty,
        tenant_id: hierarchy.tenantId,
        workspace_id: hierarchy.workspaceId
      }],
      ["project_outstanding", capacity.maxOutstandingPerProject, {
        tenant_id: hierarchy.tenantId,
        workspace_id: hierarchy.workspaceId,
        project_id: hierarchy.projectId
      }]
    ];
    for (const [reason, limit, filters] of checks) {
      assertCapacityBelow({
        count: boundedCount(statements.countOutstanding, {
          queue_definition_id: queueDefinitionId,
          ...filters
        }, limit),
        limit,
        reason
      });
    }
    if (state === WORK_QUEUE_STATES.RETRY_WAIT) {
      assertCapacityBelow({
        count: boundedCount(statements.countStateByHierarchy, {
          queue_definition_id: queueDefinitionId,
          state: WORK_QUEUE_STATES.RETRY_WAIT,
          ...empty
        }, capacity.maxDelayed),
        limit: capacity.maxDelayed,
        reason: "queue_delayed"
      });
    }
  }

  function cursorKey({ queueDefinitionId, queueDefinitionVersion, selectorScopeKey, priorityClass, level, parentKey }) {
    return {
      queue_definition_id: queueDefinitionId,
      queue_definition_version: queueDefinitionVersion,
      selector_scope_key: selectorScopeKey,
      priority_class: priorityClass,
      level,
      parent_key: parentKey
    };
  }

  function readCursor(key) {
    return statements.getFairnessCursor.get(key)?.cursor_value || "";
  }

  function writeCursor(key, value, nowMs) {
    statements.upsertFairnessCursor.run({
      ...key,
      cursor_value: String(value),
      updated_at_ms: nowMs
    });
  }

  function nextPartition(statement, fixedValue, parameters, key, nowMs) {
    if (fixedValue) return fixedValue;
    const previous = readCursor(key);
    let row = statement.get({ ...parameters, cursor: previous, from_start: 0 });
    if (!row) row = statement.get({ ...parameters, cursor: "", from_start: 1 });
    if (!row) return null;
    writeCursor(key, row.value, nowMs);
    return row.value;
  }

  function countLeased(queueDefinitionId, hierarchy, limit) {
    return boundedCount(statements.countStateByHierarchy, {
      queue_definition_id: queueDefinitionId,
      state: WORK_QUEUE_STATES.RUNNING,
      tenant_id: hierarchy.tenantId || "",
      workspace_id: hierarchy.workspaceId || "",
      project_id: hierarchy.projectId || ""
    }, limit);
  }

  function policyForWorkItem(row) {
    const definition = statements.getDefinitionPolicy.get(
      row.queue_definition_id,
      row.queue_definition_version
    );
    const override = parseJson(definition?.policy_json, {});
    return getPolicy({
      ...resolvedPolicy,
      ...override,
      capacity: { ...resolvedPolicy.capacity, ...(override.capacity || {}) },
      retention: { ...resolvedPolicy.retention, ...(override.retention || {}) }
    });
  }

  function hasLeaseCapacity(queueDefinitionId, hierarchy, policy, { scopeKey, nowMs }) {
    const { capacity, fairness } = policy;
    const queueLeased = countLeased(queueDefinitionId, {}, capacity.maxLeased);
    const tenantLeased = countLeased(
      queueDefinitionId,
      { tenantId: hierarchy.tenantId },
      capacity.maxLeasedPerTenant
    );
    const workspaceLeased = countLeased(queueDefinitionId, {
        tenantId: hierarchy.tenantId,
        workspaceId: hierarchy.workspaceId
      }, capacity.maxLeasedPerWorkspace);
    const projectLeased = countLeased(queueDefinitionId, hierarchy, capacity.maxLeasedPerProject);
    if (queueLeased >= capacity.maxLeased ||
        tenantLeased >= capacity.maxLeasedPerTenant ||
        workspaceLeased >= capacity.maxLeasedPerWorkspace ||
        projectLeased >= capacity.maxLeasedPerProject) return false;
    const reservation = fairness.minReservedLeasesPerPartition;
    const reservationInput = {
      queue_definition_id: queueDefinitionId,
      scope_key: scopeKey,
      queued_state: WORK_QUEUE_STATES.QUEUED,
      recovered_state: WORK_QUEUE_STATES.RECOVERED,
      running_state: WORK_QUEUE_STATES.RUNNING,
      now_ms: nowMs,
      reservation,
      limit: fairness.reservationScanLimit,
      ...{
        tenant_id: hierarchy.tenantId,
        workspace_id: hierarchy.workspaceId,
        project_id: hierarchy.projectId
      }
    };
    const reserved = (statement) => Number(statement.get(reservationInput)?.count || 0);
    if (tenantLeased >= reservation &&
        queueLeased + reserved(statements.countUnderReservedTenants) >= capacity.maxLeased) return false;
    if (workspaceLeased >= reservation &&
        tenantLeased + reserved(statements.countUnderReservedWorkspaces) >= capacity.maxLeasedPerTenant) return false;
    if (projectLeased >= reservation &&
        workspaceLeased + reserved(statements.countUnderReservedProjects) >= capacity.maxLeasedPerWorkspace) return false;
    return true;
  }

  function promoteAgedCandidates({ queueDefinitionId, queueDefinitionVersion, scopeKey, nowMs }) {
    const definition = statements.getLatestDefinitionPolicy.get({
      queue_definition_id: queueDefinitionId,
      queue_definition_version: queueDefinitionVersion
    });
    const policy = getPolicy({
      ...resolvedPolicy,
      ...parseJson(definition?.policy_json, {})
    });
    const { agingIntervalMs, agingBatchSize } = policy.fairness;
    const rows = statements.agedCandidates.all({
      queue_definition_id: queueDefinitionId,
      queue_definition_version: queueDefinitionVersion,
      scope_key: scopeKey,
      queued_state: WORK_QUEUE_STATES.QUEUED,
      recovered_state: WORK_QUEUE_STATES.RECOVERED,
      critical_class: "critical",
      aging_threshold_ms: nowMs - agingIntervalMs,
      limit: agingBatchSize
    });
    for (const row of rows) {
      const priorityClass = agedWorkQueuePriorityClass({
        priority: row.priority,
        availableAtMs: row.available_at_ms,
        nowMs,
        agingIntervalMs
      });
      if (priorityClass !== row.priority_class) {
        statements.updatePriorityClass.run({
          work_item_id: row.work_item_id,
          priority_class: priorityClass,
          updated_at_ms: nowMs
        });
      }
    }
    return rows.length;
  }

  function selectFairCandidate({ queueDefinitionId, queueDefinitionVersion, scope, selectorScopeKey, nowMs }) {
    const fixed = hierarchicalScopeParts(scope);
    const priorityKey = cursorKey({
      queueDefinitionId,
      queueDefinitionVersion,
      selectorScopeKey,
      priorityClass: "*",
      level: "priority",
      parentKey: ""
    });
    let priorityCursor = Number(readCursor(priorityKey) || 0);
    for (let priorityVisit = 0; priorityVisit < WORK_QUEUE_PRIORITY_CYCLE.length; priorityVisit += 1) {
      const priorityClass = priorityClassAtCursor(priorityCursor);
      priorityCursor = nextPriorityCursor(priorityCursor);
      writeCursor(priorityKey, priorityCursor, nowMs);
      const base = {
        queue_definition_id: queueDefinitionId,
        queue_definition_version: queueDefinitionVersion,
        scope_key: selectorScopeKey,
        state: WORK_QUEUE_STATES.QUEUED,
        recovered_state: WORK_QUEUE_STATES.RECOVERED,
        priority_class: priorityClass,
        now_ms: nowMs
      };
      const tenantId = nextPartition(statements.nextFairTenant, fixed.tenantId, base, cursorKey({
        queueDefinitionId,
        queueDefinitionVersion,
        selectorScopeKey,
        priorityClass,
        level: "tenant",
        parentKey: ""
      }), nowMs);
      if (tenantId === null) continue;
      const workspaceId = nextPartition(statements.nextFairWorkspace, fixed.workspaceId, {
        ...base,
        tenant_id: tenantId
      }, cursorKey({
        queueDefinitionId,
        queueDefinitionVersion,
        selectorScopeKey,
        priorityClass,
        level: "workspace",
        parentKey: tenantId
      }), nowMs);
      if (workspaceId === null) continue;
      const projectId = nextPartition(statements.nextFairProject, fixed.projectId, {
        ...base,
        tenant_id: tenantId,
        workspace_id: workspaceId
      }, cursorKey({
        queueDefinitionId,
        queueDefinitionVersion,
        selectorScopeKey,
        priorityClass,
        level: "project",
        parentKey: JSON.stringify([tenantId, workspaceId])
      }), nowMs);
      if (projectId === null) continue;
      const hierarchy = { tenantId, workspaceId, projectId };
      const candidate = statements.fairLeafCandidate.get({
        ...base,
        tenant_id: tenantId,
        workspace_id: workspaceId,
        project_id: projectId
      }) || null;
      if (!candidate) continue;
      if (!hasLeaseCapacity(
        queueDefinitionId,
        hierarchy,
        policyForWorkItem(candidate),
        { scopeKey: selectorScopeKey, nowMs }
      )) continue;
      return candidate;
    }
    return null;
  }

  const enqueueTx = database.transaction((input = {}) => {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const { queueDefinitionId, queueDefinitionVersion, queueDefinition } = resolveQueueDefinition(input, {
      assertEnqueue: true
    });
    const scope = normalizeScope(input.scope || {});
    const scopeKey = input.scopeKey ? toText(input.scopeKey) : scopeKeyFromScope(scope);
    const dedupeKey = toText(input.dedupeKey);

    const delayMs = Math.max(0, asInt(input.delayMs, 0));
    const availableAtMs = asInt(input.availableAtMs, delayMs > 0 ? nowMs + delayMs : nowMs);
    const state = availableAtMs > nowMs ? WORK_QUEUE_STATES.RETRY_WAIT : WORK_QUEUE_STATES.QUEUED;
    const payloadRef = normalizePayloadRef(input.payloadRef || input.payload || input.payloadReference);
    const ownerRef = normalizeOwnerRef(input.ownerRef);
    const policyForItem = getPolicy({
      ...resolvedPolicy,
      ...(queueDefinition.policy || {}),
      capacity: {
        ...resolvedPolicy.capacity,
        ...(queueDefinition.policy?.capacity || {})
      },
      retention: {
        ...resolvedPolicy.retention,
        ...(queueDefinition.policy?.retention || {})
      }
    });
    const expiresAtMs = resolveWorkExpiryAtMs({
      nowMs,
      availableAtMs,
      expiresAtMs: input.expiresAtMs,
      policy: policyForItem
    });
    const payloadRefJson = serializePayloadRef(payloadRef);
    assertCapacityAtMost({
      count: Buffer.byteLength(payloadRefJson, "utf8"),
      limit: policyForItem.capacity.maxPayloadRefBytes,
      reason: "payload_ref_bytes"
    });
    if (dedupeKey) {
      const existing = statements.getDedupe.get(queueDefinitionId, scopeKey, dedupeKey);
      if (existing) {
        assertDedupeFingerprint(existing, { queueDefinitionVersion, payloadRef, ownerRef, schedulingScope: input.schedulingScope ?? scope });
        return {
          accepted: false,
          deduped: true,
          workItem: rowToWorkItem(existing)
        };
      }
    }
    const workItemId = toText(input.workItemId || identityGenerator.workItemId());
    const normalizedPriority = normalizeWorkQueuePriority(input.priority);
    const hierarchy = hierarchicalScopeParts(input.schedulingScope ?? scope);
    assertAdmissionCapacity({
      queueDefinitionId,
      hierarchy,
      state,
      policy: policyForItem
    });
    const row = {
      work_item_id: workItemId,
      queue_definition_id: queueDefinitionId,
      queue_definition_version: queueDefinitionVersion,
      scope_key: scopeKey,
      scope_json: jsonString(scope, {}),
      dedupe_key: dedupeKey,
      state,
      owner_ref_json: jsonString(ownerRef, {}),
      payload_ref_json: payloadRefJson,
      payload_kind: toText(input.payloadKind || payloadRef.kind || payloadRef.type),
      priority: normalizedPriority.priority,
      priority_class: normalizedPriority.priorityClass,
      tenant_id: hierarchy.tenantId,
      workspace_id: hierarchy.workspaceId,
      project_id: hierarchy.projectId,
      available_at_ms: availableAtMs,
      expires_at_ms: expiresAtMs,
      attempt: 0,
      max_attempts: asPositiveInt(input.maxAttempts ?? policyForItem.maxAttempts, resolvedPolicy.maxAttempts),
      lease_id: "",
      lease_seq: 0,
      leased_by_worker_id: "",
      lease_expires_at_ms: 0,
      concurrency_key: toText(input.concurrencyKey),
      route_version: toText(input.routeVersion || input.route?.version),
      policy_version: toText(input.policyVersion || policyForItem.policyVersion || resolvedPolicy.policyVersion),
      fallback_task_id: "",
      last_error_json: jsonString({}, {}),
      checkpoint_ref_json: jsonString({}, {}),
      checkpoint_digest: "",
      checkpoint_seq: 0,
      checkpoint_updated_at_ms: 0,
      last_transition_seq: 0,
      created_at_ms: nowMs,
      updated_at_ms: nowMs
    };

    try {
      statements.insertWorkItem.run(row);
    } catch (error) {
      if (dedupeKey && /UNIQUE constraint failed/i.test(String(error.message))) {
        const existing = statements.getDedupe.get(queueDefinitionId, scopeKey, dedupeKey);
        if (existing) {
          assertDedupeFingerprint(existing, { queueDefinitionVersion, payloadRef, ownerRef, schedulingScope: input.schedulingScope ?? scope });
          return {
            accepted: false,
            deduped: true,
            workItem: rowToWorkItem(existing)
          };
        }
      }
      throw error;
    }

    const seq = appendTransitionInternal({
      row,
      transition: "enqueue",
      fromState: null,
      toState: state,
      nowMs,
      operationId: input.operationId,
      actor: input.actor,
      reason: input.reason || "enqueue",
      policyVersion: row.policy_version,
      decision: {
        projectionRow: row
      }
    });
    const inserted = statements.getWorkItem.get(workItemId);
    return {
      accepted: true,
      deduped: false,
      transitionSeq: seq,
      workItem: rowToWorkItem(inserted)
    };
  });

  const claimTx = database.transaction((input = {}) => {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const { queueDefinitionId, queueDefinitionVersion } = resolveQueueDefinition(input, {
      allowAllVersions: true
    });
    const scope = normalizeScope(input.scope || {});
    const schedulingScope = normalizeScope(input.schedulingScope ?? scope);
    const scopeKey = input.scopeKey ? toText(input.scopeKey) : scopeKeyFromScope(scope);
    const recoveryScopeKey = scope.tenantId && scope.workspaceId && scope.projectId
      ? scopeKey
      : "";
    const workerId = toText(input.workerId || input.consumerId || identityGenerator.workerId());
    const batchSize = Math.max(1, Math.min(asInt(input.batchSize ?? input.batch ?? input.maxMessages, 1), 500));
    const leaseTimeoutMs = Math.max(1, asInt(input.leaseTimeoutMs, resolvedPolicy.leaseTimeoutMs));

    const expired = expireEligibleLocked({
      nowMs,
      queueDefinitionId,
      scopeKey: recoveryScopeKey,
      limit: Math.max(100, batchSize * 8)
    });
    const recovered = recoverExpiredLeasesLocked({
      nowMs,
      queueDefinitionId,
      scopeKey: recoveryScopeKey,
      limit: Math.max(100, batchSize * 8)
    });
    const control = statements.getQueueControl.get({
      queue_definition_id: queueDefinitionId,
      scope_key: scopeKey
    });
    if (control && ["paused", "draining"].includes(control.mode)) {
      return {
        workerId,
        claimed: [],
        expired,
        recovered,
        matured: [],
        control: {
          mode: control.mode,
          reason: control.reason || "",
          updatedAtMs: control.updated_at_ms
        }
      };
    }
    const matured = materializeDelayedLocked({
      nowMs,
      queueDefinitionId,
      scopeKey: recoveryScopeKey,
      limit: Math.max(100, batchSize * 8)
    });
    const aged = promoteAgedCandidates({
      queueDefinitionId,
      queueDefinitionVersion: asInt(queueDefinitionVersion, 0),
      scopeKey,
      nowMs
    });

    const claimed = [];
    const failed = [];
    const maxVisits = Math.min(
      asPositiveInt(resolvedPolicy.fairness.maxVisitsPerClaim, 4096),
      Math.max(WORK_QUEUE_PRIORITY_CYCLE.length, batchSize * WORK_QUEUE_PRIORITY_CYCLE.length)
    );
    for (let visit = 0; visit < maxVisits && claimed.length < batchSize; visit += 1) {
      const row = selectFairCandidate({
        queueDefinitionId,
        queueDefinitionVersion: asInt(queueDefinitionVersion, 0),
        scope: schedulingScope,
        selectorScopeKey: scopeKey,
        nowMs
      });
      if (!row) continue;
      if (row.attempt >= row.max_attempts) {
        const failedRow = transitionProjection({
          row,
          transition: "fail",
          toState: WORK_QUEUE_STATES.FAILED,
          patch: {
            available_at_ms: nowMs,
            lease_id: "",
            leased_by_worker_id: "",
            lease_expires_at_ms: 0,
            last_error_json: jsonString({
              type: "max_attempts_exhausted_before_claim",
              attempt: row.attempt,
              maxAttempts: row.max_attempts
            }, {})
          },
          nowMs,
          reason: "max_attempts_exhausted_before_claim"
        });
        failed.push(rowToWorkItem(failedRow));
        continue;
      }
      const leaseId = identityGenerator.leaseId();
      const leaseSeq = row.lease_seq + 1;
      const attempt = row.attempt + 1;
      const leaseExpiresAtMs = row.expires_at_ms > 0
        ? Math.min(nowMs + leaseTimeoutMs, row.expires_at_ms)
        : nowMs + leaseTimeoutMs;
      const updated = transitionProjection({
        row,
        transition: "claim",
        toState: WORK_QUEUE_STATES.RUNNING,
        patch: {
          attempt,
          lease_id: leaseId,
          lease_seq: leaseSeq,
          leased_by_worker_id: workerId,
          lease_expires_at_ms: leaseExpiresAtMs,
          last_error_json: jsonString({}, {})
        },
        nowMs,
        operationId: input.operationId,
        actor: input.actor || { workerId },
        reason: input.reason || "claim"
      });
      claimed.push({
        workItem: rowToWorkItem(updated),
        lease: {
          leaseId,
          leaseSeq,
          workerId,
          expiresAtMs: leaseExpiresAtMs
        }
      });
    }

    return {
      workerId,
      claimed,
      expired,
      recovered,
      matured,
      aged,
      failed
    };
  });

  function expireRow(row, nowMs, input = {}) {
    return transitionProjection({
      row,
      transition: "expire",
      toState: WORK_QUEUE_STATES.EXPIRED,
      patch: {
        available_at_ms: nowMs,
        lease_id: "",
        leased_by_worker_id: "",
        lease_expires_at_ms: 0
      },
      nowMs,
      operationId: input.operationId,
      actor: input.actor,
      reason: input.reason || "work_deadline_reached"
    });
  }

  function isWorkExpired(row, nowMs) {
    return Number(row?.expires_at_ms || 0) > 0 && Number(row.expires_at_ms) <= nowMs;
  }

  const expireTx = database.transaction((input = {}) => {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const row = requireWorkItemBoundary(
      statements.getWorkItem.get(toText(input.workItemId)),
      input
    );
    if (row.state === WORK_QUEUE_STATES.EXPIRED) {
      return { expired: true, idempotent: true, workItem: rowToWorkItem(row) };
    }
    if (![WORK_QUEUE_STATES.QUEUED, WORK_QUEUE_STATES.RETRY_WAIT, WORK_QUEUE_STATES.RUNNING, WORK_QUEUE_STATES.RECOVERED].includes(row.state)) {
      return { expired: false, idempotent: true, workItem: rowToWorkItem(row) };
    }
    if (input.force !== true && !isWorkExpired(row, nowMs)) {
      return { expired: false, idempotent: true, workItem: rowToWorkItem(row) };
    }
    return { expired: true, idempotent: false, workItem: rowToWorkItem(expireRow(row, nowMs, input)) };
  });

  const completeTx = database.transaction((input = {}) => {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const current = statements.getWorkItem.get(toText(input.workItemId));
    if (current?.state === WORK_QUEUE_STATES.COMPLETED) {
      const terminal = statements.getLastTransition.get(current.work_item_id);
      if (terminal?.transition === "complete" && terminal.lease_id === toText(input.leaseId)) {
        return { completed: true, idempotent: true, workItem: rowToWorkItem(current) };
      }
    }
    if (isWorkExpired(current, nowMs)) {
      return { completed: false, expired: true, workItem: rowToWorkItem(expireRow(current, nowMs, input)) };
    }
    const row = requireLeasedRow(input.workItemId, input.leaseId, nowMs);
    const updated = transitionProjection({
      row,
      transition: "complete",
      toState: WORK_QUEUE_STATES.COMPLETED,
      patch: {
        available_at_ms: nowMs,
        lease_id: "",
        leased_by_worker_id: "",
        lease_expires_at_ms: 0,
        last_error_json: jsonString({}, {})
      },
      nowMs,
      operationId: input.operationId,
      actor: input.actor,
      reason: input.reason || "complete"
    });
    return { completed: true, workItem: rowToWorkItem(updated) };
  });

  const retryTx = database.transaction((input = {}) => {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const current = statements.getWorkItem.get(toText(input.workItemId));
    if (isWorkExpired(current, nowMs)) {
      return { retried: false, expired: true, workItem: rowToWorkItem(expireRow(current, nowMs, input)) };
    }
    const row = requireLeasedRow(input.workItemId, input.leaseId, nowMs);
    const exhausted = row.attempt >= row.max_attempts;
    const delayMs = exhausted
      ? 0
      : input.delayMs === undefined
        ? computeDeterministicRetryDelay({
            queueDefinitionId: row.queue_definition_id,
            workItemId: row.work_item_id,
            attempt: row.attempt,
            ...resolvedPolicy.retryBackoff
          })
        : Math.max(0, asInt(input.delayMs, 0));
    if (!exhausted && row.expires_at_ms > 0 && nowMs + delayMs >= row.expires_at_ms) {
      return { retried: false, expired: true, workItem: rowToWorkItem(expireRow(row, nowMs, input)) };
    }
    const toState = exhausted
      ? WORK_QUEUE_STATES.FAILED
      : delayMs > 0
        ? WORK_QUEUE_STATES.RETRY_WAIT
        : WORK_QUEUE_STATES.QUEUED;
    const updated = transitionProjection({
      row,
      transition: "retry",
      toState,
      patch: {
        available_at_ms: nowMs + delayMs,
        lease_id: "",
        leased_by_worker_id: "",
        lease_expires_at_ms: 0,
        last_error_json: jsonString(input.error || input.lastError || {}, {})
      },
      nowMs,
      operationId: input.operationId,
      actor: input.actor,
      reason: input.reason || (exhausted ? "retry_attempts_exhausted" : "retry")
    });
    return {
      retried: true,
      retryable: !exhausted,
      delayMs,
      workItem: rowToWorkItem(updated)
    };
  });

  const progressTx = database.transaction((input = {}) => {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const current = statements.getWorkItem.get(toText(input.workItemId));
    if (isWorkExpired(current, nowMs)) {
      return { progressed: false, expired: true, workItem: rowToWorkItem(expireRow(current, nowMs, input)) };
    }
    const row = requireLeasedRow(input.workItemId, input.leaseId, nowMs);
    const extendMs = Math.max(1, asInt(input.extendMs ?? input.leaseTimeoutMs, resolvedPolicy.leaseTimeoutMs));
    const leaseExpiresAtMs = row.expires_at_ms > 0
      ? Math.min(nowMs + extendMs, row.expires_at_ms)
      : nowMs + extendMs;
    const updated = transitionProjection({
      row,
      transition: "progress",
      toState: WORK_QUEUE_STATES.RUNNING,
      patch: {
        lease_expires_at_ms: leaseExpiresAtMs
      },
      nowMs,
      operationId: input.operationId,
      actor: input.actor,
      reason: input.reason || "progress"
    });
    return {
      progressed: true,
      lease: rowToWorkItem(updated).lease,
      workItem: rowToWorkItem(updated)
    };
  });

  const checkpointTx = database.transaction((input = {}) => {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const row = requireLeasedRow(input.workItemId, input.leaseId, nowMs);
    const normalized = normalizeCheckpointRef(input.checkpointRef);
    if (row.checkpoint_digest === normalized.checkpointDigest) {
      return { checkpointed: true, idempotent: true, workItem: rowToWorkItem(row) };
    }
    const currentSeq = Number(row.checkpoint_seq || 0);
    if (input.expectedCheckpointSeq !== undefined &&
        asInt(input.expectedCheckpointSeq, -1) !== currentSeq) {
      const error = new Error("Queue checkpoint revision does not match the current projection.");
      error.code = "work_queue_checkpoint_conflict";
      error.expectedCheckpointSeq = currentSeq;
      throw error;
    }
    const checkpointSeq = currentSeq + 1;
    statements.updateCheckpoint.run({
      work_item_id: row.work_item_id,
      checkpoint_ref_json: normalized.serialized,
      checkpoint_digest: normalized.checkpointDigest,
      checkpoint_seq: checkpointSeq,
      checkpoint_updated_at_ms: nowMs,
      updated_at_ms: nowMs
    });
    const updated = statements.getWorkItem.get(row.work_item_id);
    appendTransitionInternal({
      row: updated,
      transition: "progress",
      fromState: WORK_QUEUE_STATES.RUNNING,
      toState: WORK_QUEUE_STATES.RUNNING,
      leaseId: row.lease_id,
      leaseSeq: row.lease_seq,
      nowMs,
      operationId: input.operationId,
      actor: input.actor,
      reason: input.reason || "checkpoint",
      decision: { checkpointDigest: normalized.checkpointDigest, checkpointSeq }
    });
    return { checkpointed: true, idempotent: false, workItem: rowToWorkItem(
      statements.getWorkItem.get(row.work_item_id)
    ) };
  });

  const cancelRunningTx = database.transaction((input = {}) => {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const current = statements.getWorkItem.get(toText(input.workItemId));
    if (current?.state === WORK_QUEUE_STATES.CANCELLED) {
      const terminal = statements.getLastTransition.get(current.work_item_id);
      if (terminal?.transition === "cancel_running" && terminal.lease_id === toText(input.leaseId)) {
        return { cancelled: true, idempotent: true, workItem: rowToWorkItem(current) };
      }
    }
    if (isWorkExpired(current, nowMs)) {
      return { cancelled: false, expired: true, workItem: rowToWorkItem(expireRow(current, nowMs, input)) };
    }
    const row = requireLeasedRow(input.workItemId, input.leaseId, nowMs);
    const updated = transitionProjection({
      row,
      transition: "cancel_running",
      toState: WORK_QUEUE_STATES.CANCELLED,
      patch: {
        available_at_ms: nowMs,
        lease_id: "",
        leased_by_worker_id: "",
        lease_expires_at_ms: 0,
        last_error_json: jsonString(input.reasonDetails || {}, {})
      },
      nowMs,
      operationId: input.operationId,
      actor: input.actor,
      reason: input.reason || "cancel_running"
    });
    return { cancelled: true, workItem: rowToWorkItem(updated) };
  });

  const cancelTx = database.transaction((input = {}) => {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const row = requireWorkItemBoundary(
      statements.getWorkItem.get(toText(input.workItemId)),
      input
    );
    if (row.state === WORK_QUEUE_STATES.CANCELLED) {
      return { cancelled: true, idempotent: true, workItem: rowToWorkItem(row) };
    }
    if (row.state === WORK_QUEUE_STATES.COMPLETED) {
      return { cancelled: false, idempotent: true, completed: true, workItem: rowToWorkItem(row) };
    }
    if (isWorkExpired(row, nowMs)) {
      return { cancelled: false, expired: true, workItem: rowToWorkItem(expireRow(row, nowMs, input)) };
    }
    if (![
      WORK_QUEUE_STATES.QUEUED,
      WORK_QUEUE_STATES.RETRY_WAIT,
      WORK_QUEUE_STATES.RUNNING,
      WORK_QUEUE_STATES.RECOVERED
    ].includes(row.state)) {
      throw new Error(`Work item ${input.workItemId} cannot be cancelled from state ${row.state}.`);
    }
    const updated = transitionProjection({
      row,
      transition: "cancel",
      toState: WORK_QUEUE_STATES.CANCELLED,
      patch: {
        available_at_ms: nowMs,
        lease_id: "",
        leased_by_worker_id: "",
        lease_expires_at_ms: 0,
        last_error_json: jsonString(input.reasonDetails || {}, {})
      },
      nowMs,
      operationId: input.operationId,
      actor: input.actor,
      reason: input.reason || "cancel"
    });
    return { cancelled: true, idempotent: false, workItem: rowToWorkItem(updated) };
  });

  const failTx = database.transaction((input = {}) => {
    const nowMs = nowFrom(timeSource, input.nowMs);
    let row = requireWorkItemBoundary(
      statements.getWorkItem.get(toText(input.workItemId)),
      input
    );
    if (isTerminalWorkQueueState(row.state)) {
      throw new Error(`Cannot fail terminal work item ${input.workItemId}.`);
    }
    if (isWorkExpired(row, nowMs)) {
      return { failed: false, expired: true, workItem: rowToWorkItem(expireRow(row, nowMs, input)) };
    }
    if (row.state === WORK_QUEUE_STATES.RUNNING) {
      row = requireLeasedRow(input.workItemId, input.leaseId, nowMs);
    }
    const fallbackTaskId = toText(input.fallbackTaskId);
    const updated = transitionProjection({
      row,
      transition: "fail",
      toState: WORK_QUEUE_STATES.FAILED,
      patch: {
        available_at_ms: nowMs,
        lease_id: "",
        leased_by_worker_id: "",
        lease_expires_at_ms: 0,
        fallback_task_id: fallbackTaskId || row.fallback_task_id,
        last_error_json: jsonString(input.error || input.lastError || {}, {})
      },
      nowMs,
      operationId: input.operationId,
      actor: input.actor,
      reason: input.reason || "fail"
    });
    return { failed: true, fallbackTaskId, workItem: rowToWorkItem(updated) };
  });

  const recoverTx = database.transaction((input = {}) => {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const row = requireWorkItemBoundary(
      statements.getWorkItem.get(toText(input.workItemId)),
      input
    );
    if (isWorkExpired(row, nowMs)) {
      throw new Error(`Work item ${input.workItemId} cannot be recovered after its deadline.`);
    }
    const policyForItem = policyForWorkItem(row);
    assertAdmissionCapacity({
      queueDefinitionId: row.queue_definition_id,
      hierarchy: {
        tenantId: row.tenant_id || "",
        workspaceId: row.workspace_id || "",
        projectId: row.project_id || ""
      },
      state: WORK_QUEUE_STATES.RECOVERED,
      policy: policyForItem
    });
    const updated = transitionProjection({
      row,
      transition: "recover",
      toState: WORK_QUEUE_STATES.RECOVERED,
      patch: {
        attempt: row.attempt,
        available_at_ms: nowMs,
        lease_id: "",
        leased_by_worker_id: "",
        lease_expires_at_ms: 0,
        last_error_json: jsonString(input.lastError || {}, {})
      },
      nowMs,
      operationId: input.operationId,
      actor: input.actor,
      reason: input.reason || "recover"
    });
    return { recovered: true, workItem: rowToWorkItem(updated) };
  });

  function inspect(input = {}) {
    if (input.workItemId) {
      const row = statements.getWorkItem.get(toText(input.workItemId));
      if (!workItemMatchesBoundary(row, input)) {
        return { workItem: null, journal: [] };
      }
      const journal = input.includeJournal
        ? database.prepare(`
            SELECT *
            FROM work_queue_transition_journal
            WHERE work_item_id = ?
            ORDER BY seq ASC
          `).all(row.work_item_id).map(journalRowToTransition)
        : [];
      return { workItem: rowToWorkItem(row), journal };
    }

    const queueDefinitionId = toText(input.queueDefinitionId || input.queueDefinition?.queueDefinitionId);
    const scopeKey = input.scopeKey || (input.scope ? scopeKeyFromScope(input.scope) : "");
    const states = asArray(input.states, []).map(toText).filter(Boolean);
    const limit = Math.max(1, Math.min(asInt(input.limit, 100), 1000));
    const where = [];
    const params = {};
    if (queueDefinitionId) {
      where.push("queue_definition_id = @queue_definition_id");
      params.queue_definition_id = queueDefinitionId;
    }
    if (scopeKey) {
      where.push("scope_key = @scope_key");
      params.scope_key = scopeKey;
    }
    if (states.length) {
      where.push(`state IN (${states.map((_, index) => `@state_${index}`).join(", ")})`);
      states.forEach((state, index) => {
        params[`state_${index}`] = state;
      });
    }
    params.limit = limit;
    const sql = `
      SELECT *
      FROM work_items
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY priority DESC, available_at_ms ASC, created_at_ms ASC
      LIMIT @limit
    `;
    const items = database.prepare(sql).all(params).map(rowToWorkItem);
    const countWhere = [];
    const countParams = {};
    if (queueDefinitionId) {
      countWhere.push("queue_definition_id = @queue_definition_id");
      countParams.queue_definition_id = queueDefinitionId;
    }
    if (scopeKey) {
      countWhere.push("scope_key = @scope_key");
      countParams.scope_key = scopeKey;
    }
    const stateCounts = database.prepare(`
      SELECT state, COUNT(*) AS count
      FROM work_items
      ${countWhere.length ? `WHERE ${countWhere.join(" AND ")}` : ""}
      GROUP BY state
      ORDER BY state ASC
    `).all(countParams)
      .map((row) => ({ state: row.state, count: row.count }));
    return { items, stateCounts };
  }

  const rebuildProjectionTx = database.transaction((input = {}) => rebuildSqliteProjection({ database, statements, input }));

  const registerQueueDefinitionTx = database.transaction((definition = {}) => {
    const nowMs = nowFrom(timeSource, definition.nowMs);
    const queueDefinitionId = toText(definition.queueDefinitionId || definition.id);
    if (!queueDefinitionId) {
      throw new Error("queueDefinitionId is required.");
    }
    const label = toText(definition.label);
    if (!label) {
      throw new Error("Queue definition label is required.");
    }
    const queueDefinitionVersion = asPositiveInt(
      definition.queueDefinitionVersion ?? definition.version,
      1
    );
    const snapshot = queueDefinitionSnapshot({
      ...definition,
      queueDefinitionId,
      queueDefinitionVersion,
      label
    });
    const existing = database.prepare(`
      SELECT * FROM queue_definitions
      WHERE queue_definition_id = ? AND queue_definition_version = ?
    `).get(queueDefinitionId, queueDefinitionVersion);
    if (existing) {
      if (stableJson(queueDefinitionSnapshot(existing)) === stableJson(snapshot)) {
        return { registered: false, idempotent: true, queueDefinitionId, queueDefinitionVersion };
      }
      throw queueDefinitionConflict(
        `Queue definition ${queueDefinitionId} version ${queueDefinitionVersion} is immutable.`
      );
    }
    const conflictingLabel = database.prepare(`
      SELECT queue_definition_id FROM queue_definitions
      WHERE label = ? AND queue_definition_id <> ?
      LIMIT 1
    `).get(label, queueDefinitionId);
    if (conflictingLabel) {
      throw queueDefinitionConflict(`Queue definition label is already in use: ${label}`);
    }
    statements.insertDefinition.run({
      queue_definition_id: queueDefinitionId,
      queue_definition_version: queueDefinitionVersion,
      label,
      lifecycle_state: snapshot.lifecycleState,
      owner_capability: snapshot.ownerCapability,
      allow_deprecated_enqueue: snapshot.allowDeprecatedEnqueue ? 1 : 0,
      metadata_json: jsonString(snapshot.metadata, {}),
      policy_json: jsonString(snapshot.policy, {}),
      routes_json: jsonString(snapshot.routes, []),
      label_history_json: jsonString(snapshot.labelHistory, []),
      registered_at_ms: nowMs,
      updated_at_ms: nowMs
    });
    return { registered: true, queueDefinitionId, queueDefinitionVersion };
  });

  const setQueueControlTx = database.transaction((input = {}) => {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const queueDefinitionId = toText(input.queueDefinitionId || input.queueDefinition?.queueDefinitionId);
    if (!queueDefinitionId) {
      throw new Error("queueDefinitionId is required.");
    }
    const scopeKey = input.scopeKey || (input.scope ? scopeKeyFromScope(input.scope) : "");
    const mode = toText(input.mode || "active");
    if (!["active", "paused", "draining"].includes(mode)) {
      throw new Error(`Unknown queue control mode: ${mode}`);
    }
    statements.upsertQueueControl.run({
      queue_definition_id: queueDefinitionId,
      scope_key: scopeKey,
      mode,
      reason: toText(input.reason),
      actor_json: jsonString(input.actor || {}, {}),
      updated_at_ms: nowMs
    });
    return {
      queueDefinitionId,
      scopeKey,
      mode,
      reason: toText(input.reason),
      updatedAtMs: nowMs
    };
  });

  function getQueueControl(input = {}) {
    const queueDefinitionId = toText(input.queueDefinitionId || input.queueDefinition?.queueDefinitionId);
    if (!queueDefinitionId) {
      throw new Error("queueDefinitionId is required.");
    }
    const scopeKey = input.scopeKey || (input.scope ? scopeKeyFromScope(input.scope) : "");
    const row = statements.getQueueControl.get({
      queue_definition_id: queueDefinitionId,
      scope_key: scopeKey
    });
    if (!row) {
      return {
        queueDefinitionId,
        scopeKey,
        mode: "active",
        reason: "",
        updatedAtMs: 0
      };
    }
    return {
      queueDefinitionId: row.queue_definition_id,
      scopeKey: row.scope_key,
      mode: row.mode,
      reason: row.reason || "",
      actor: parseJson(row.actor_json, {}),
      updatedAtMs: row.updated_at_ms
    };
  }

  function writeInternalHealthState(input = {}) {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const healthKey = toText(input.healthKey || input.entityId || "default");
    statements.upsertHealth.run({
      health_key: healthKey,
      state_json: jsonString(input.state || input.value || input, {}),
      updated_at_ms: nowMs
    });
    return recordBackgroundWrite("internal_health", {
      ...input,
      entityId: healthKey,
      nowMs
    });
  }

  const store = {
    database,
    databasePath: resolvedDatabasePath,
    enqueue: enqueueTx,
    claim: claimTx,
    complete: completeTx,
    retry: retryTx,
    progress: progressTx,
    checkpoint: checkpointTx,
    expire: expireTx,
    cancel: cancelTx,
    cancelRunning: cancelRunningTx,
    fail: failTx,
    recover: recoverTx,
    inspect,
    rebuildProjection: rebuildProjectionTx,
    registerQueueDefinition: registerQueueDefinitionTx,
    setQueueControl: setQueueControlTx,
    pause(input = {}) {
      return setQueueControlTx({
        ...input,
        mode: "paused"
      });
    },
    resume(input = {}) {
      return setQueueControlTx({
        ...input,
        mode: "active"
      });
    },
    drain(input = {}) {
      return setQueueControlTx({
        ...input,
        mode: "draining"
      });
    },
    getQueueControl,
    recordBackgroundWrite,
    writeFallbackCoordinatorState(input = {}) {
      const nowMs = nowFrom(timeSource, input.nowMs);
      const fallbackTaskId = toText(input.fallbackTaskId || input.entityId || identityGenerator.fallbackTaskId());
      if (input.workItemId) {
        statements.insertFallbackTask.run({
          fallback_task_id: fallbackTaskId,
          work_item_id: toText(input.workItemId),
          state: toText(input.state?.state || input.status || "queued"),
          attempt: asInt(input.attempt, 0),
          max_attempts: asInt(input.maxAttempts, resolvedPolicy.fallbackRetry.maxAttempts),
          reason: toText(input.reason),
          decision_json: jsonString(input.state || input.decision || {}, {}),
          created_at_ms: nowMs,
          updated_at_ms: nowMs
        });
      }
      return recordBackgroundWrite("fallback_coordinator", {
        ...input,
        entityId: fallbackTaskId,
        nowMs
      });
    },
    writeSnapshotState(input = {}) {
      return recordBackgroundWrite("snapshot", input);
    },
    writeCompactionState(input = {}) {
      return recordBackgroundWrite("compaction", input);
    },
    writeInternalHealthState,
    isClosed() {
      return closed || (ownsDatabase && database.open === false);
    },
    close() {
      if (closed || (ownsDatabase && database.open === false)) {
        closed = true;
        return;
      }
      if (ownsDatabase) database.close();
      closed = true;
    }
  };

  return Object.freeze(store);
}
