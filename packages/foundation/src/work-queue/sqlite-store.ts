import fs from "node:fs";
import path from "node:path";
import { openSqliteDatabase } from "../storage/sqlite-database.ts";

import { queueIdentityGenerator } from "./identity.ts";
import { computeDeterministicRetryDelay, DEFAULT_QUEUE_POLICY } from "./policies.ts";
import {
  isTerminalWorkQueueState,
  WORK_QUEUE_STATES
} from "../workflow/state-machine/work-queue/state-machine.ts";
import { systemQueueTimeSource } from "./time-source.ts";
import { ensureSqliteWorkQueueSchema } from "./sqlite-schema.ts";
import { prepareSqliteWorkQueueStatements } from "./sqlite-statements.ts";
import { createSqliteWorkQueueRuntime } from "./sqlite-store-runtime.ts";
import { rebuildSqliteProjection } from "./sqlite-rebuild-projection.ts";
import {
  assertCapacityAtMost,
  assertCapacityBelow,
  agedWorkQueuePriorityClass,
  hierarchicalScopeParts,
  nextPriorityCursor,
  normalizeWorkQueuePriority,
  priorityClassAtCursor,
  WORK_QUEUE_PRIORITY_CYCLE
} from "./scheduling.ts";
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
} from "./store-serialization.ts";

export function getWorkQueueDatabaseDirectory(userDataPath?: any) : any {
  return path.join(String(userDataPath || ""), "work-queue");
}

export function getWorkQueueDatabasePath(userDataPath?: any) : any {
  return path.join(getWorkQueueDatabaseDirectory(userDataPath), "work-queue.sqlite");
}

export function createSqliteWorkQueueStore({
  userDataPath = "",
  databasePath = "",
  db = null,
  timeSource = systemQueueTimeSource,
  identityGenerator = queueIdentityGenerator,
  policy = DEFAULT_QUEUE_POLICY
}: Record<string, any> = {}) : any {
  const resolvedPolicy: any = getPolicy(policy);
  const resolvedDatabasePath: any = db ? "" : path.resolve(databasePath || getWorkQueueDatabasePath(userDataPath));
  if (!db && !resolvedDatabasePath) {
    throw new Error("Work queue SQLite store requires userDataPath or databasePath.");
  }
  if (!db) {
    fs.mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true });
  }
  const database: any = db || openSqliteDatabase(resolvedDatabasePath);
  const ownsDatabase: any = !db;
  try {
    return createSqliteWorkQueueStoreFromDatabase({
      database,
      ownsDatabase,
      resolvedDatabasePath,
      timeSource,
      identityGenerator,
      resolvedPolicy
    });
  } catch (error: any) {
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
}: Record<string, any>) : any {
  let closed: any = false;
  ensureSqliteWorkQueueSchema(database);

  const statements: any = prepareSqliteWorkQueueStatements(database);

  const {
    appendTransitionInternal,
    transitionProjection: transitionProjectionInternal,
    recordBackgroundWrite,
    expireEligibleLocked,
    materializeDelayedLocked,
    recoverExpiredLeasesLocked,
    requireLeasedRow
  } = createSqliteWorkQueueRuntime({ statements, timeSource, identityGenerator, resolvedPolicy });

  function cleanupFairnessCursorsIfIdle(row?: any) : any {
    if (!row || !isTerminalWorkQueueState(row.state)) return;
    const boundary: Record<string, any> = {
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

  function transitionProjection(input?: any) : any {
    const updated: any = transitionProjectionInternal(input);
    cleanupFairnessCursorsIfIdle(updated);
    return updated;
  }

  function boundedCount(statement?: any, filters?: any, limit?: any) : any {
    return Number(statement.get({ ...filters, limit: Number(limit) + 1 })?.count || 0);
  }

  function assertAdmissionCapacity({ queueDefinitionId, hierarchy, state, policy }: Record<string, any>) : any {
    const capacity: any = policy.capacity;
    const empty: Record<string, any> = { tenant_id: "", workspace_id: "", project_id: "" };
    const checks: any[] = [
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

  function cursorKey({ queueDefinitionId, queueDefinitionVersion, selectorScopeKey, priorityClass, level, parentKey }: Record<string, any>) : any {
    return {
      queue_definition_id: queueDefinitionId,
      queue_definition_version: queueDefinitionVersion,
      selector_scope_key: selectorScopeKey,
      priority_class: priorityClass,
      level,
      parent_key: parentKey
    };
  }

  function readCursor(key?: any) : any {
    return statements.getFairnessCursor.get(key)?.cursor_value || "";
  }

  function writeCursor(key?: any, value?: any, nowMs?: any) : any {
    statements.upsertFairnessCursor.run({
      ...key,
      cursor_value: String(value),
      updated_at_ms: nowMs
    });
  }

  function nextPartition(statement?: any, fixedValue?: any, parameters?: any, key?: any, nowMs?: any) : any {
    if (fixedValue) return fixedValue;
    const previous: any = readCursor(key);
    let row: any = statement.get({ ...parameters, cursor: previous, from_start: 0 });
    if (!row) row = statement.get({ ...parameters, cursor: "", from_start: 1 });
    if (!row) return null;
    writeCursor(key, row.value, nowMs);
    return row.value;
  }

  function countLeased(queueDefinitionId?: any, hierarchy?: any, limit?: any) : any {
    return boundedCount(statements.countStateByHierarchy, {
      queue_definition_id: queueDefinitionId,
      state: WORK_QUEUE_STATES.RUNNING,
      tenant_id: hierarchy.tenantId || "",
      workspace_id: hierarchy.workspaceId || "",
      project_id: hierarchy.projectId || ""
    }, limit);
  }

  function policyForWorkItem(row?: any) : any {
    const definition: any = statements.getDefinitionPolicy.get(
      row.queue_definition_id,
      row.queue_definition_version
    );
    const override: any = parseJson(definition?.policy_json, {});
    return getPolicy({
      ...resolvedPolicy,
      ...override,
      capacity: { ...resolvedPolicy.capacity, ...(override.capacity || {}) },
      retention: { ...resolvedPolicy.retention, ...(override.retention || {}) }
    });
  }

  function hasLeaseCapacity(queueDefinitionId: any, hierarchy: any, policy: any, { scopeKey, nowMs }: Record<string, any>) : any {
    const { capacity, fairness } = policy;
    const queueLeased: any = countLeased(queueDefinitionId, {}, capacity.maxLeased);
    const tenantLeased: any = countLeased(
      queueDefinitionId,
      { tenantId: hierarchy.tenantId },
      capacity.maxLeasedPerTenant
    );
    const workspaceLeased: any = countLeased(queueDefinitionId, {
        tenantId: hierarchy.tenantId,
        workspaceId: hierarchy.workspaceId
      }, capacity.maxLeasedPerWorkspace);
    const projectLeased: any = countLeased(queueDefinitionId, hierarchy, capacity.maxLeasedPerProject);
    if (queueLeased >= capacity.maxLeased ||
        tenantLeased >= capacity.maxLeasedPerTenant ||
        workspaceLeased >= capacity.maxLeasedPerWorkspace ||
        projectLeased >= capacity.maxLeasedPerProject) return false;
    const reservation: any = fairness.minReservedLeasesPerPartition;
    const reservationInput: Record<string, any> = {
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
    const reserved: any = (statement?: any) : any => Number(statement.get(reservationInput)?.count || 0);
    if (tenantLeased >= reservation &&
        queueLeased + reserved(statements.countUnderReservedTenants) >= capacity.maxLeased) return false;
    if (workspaceLeased >= reservation &&
        tenantLeased + reserved(statements.countUnderReservedWorkspaces) >= capacity.maxLeasedPerTenant) return false;
    if (projectLeased >= reservation &&
        workspaceLeased + reserved(statements.countUnderReservedProjects) >= capacity.maxLeasedPerWorkspace) return false;
    return true;
  }

  function promoteAgedCandidates({ queueDefinitionId, queueDefinitionVersion, scopeKey, nowMs }: Record<string, any>) : any {
    const definition: any = statements.getLatestDefinitionPolicy.get({
      queue_definition_id: queueDefinitionId,
      queue_definition_version: queueDefinitionVersion
    });
    const policy: any = getPolicy({
      ...resolvedPolicy,
      ...parseJson(definition?.policy_json, {})
    });
    const { agingIntervalMs, agingBatchSize } = policy.fairness;
    const rows: any = statements.agedCandidates.all({
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
      const priorityClass: any = agedWorkQueuePriorityClass({
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

  function selectFairCandidate({ queueDefinitionId, queueDefinitionVersion, scope, selectorScopeKey, nowMs }: Record<string, any>) : any {
    const fixed: any = hierarchicalScopeParts(scope);
    const priorityKey: any = cursorKey({
      queueDefinitionId,
      queueDefinitionVersion,
      selectorScopeKey,
      priorityClass: "*",
      level: "priority",
      parentKey: ""
    });
    let priorityCursor: any = Number(readCursor(priorityKey) || 0);
    for (let priorityVisit: any = 0; priorityVisit < WORK_QUEUE_PRIORITY_CYCLE.length; priorityVisit += 1) {
      const priorityClass: any = priorityClassAtCursor(priorityCursor);
      priorityCursor = nextPriorityCursor(priorityCursor);
      writeCursor(priorityKey, priorityCursor, nowMs);
      const base: Record<string, any> = {
        queue_definition_id: queueDefinitionId,
        queue_definition_version: queueDefinitionVersion,
        scope_key: selectorScopeKey,
        state: WORK_QUEUE_STATES.QUEUED,
        recovered_state: WORK_QUEUE_STATES.RECOVERED,
        priority_class: priorityClass,
        now_ms: nowMs
      };
      const tenantId: any = nextPartition(statements.nextFairTenant, fixed.tenantId, base, cursorKey({
        queueDefinitionId,
        queueDefinitionVersion,
        selectorScopeKey,
        priorityClass,
        level: "tenant",
        parentKey: ""
      }), nowMs);
      if (tenantId === null) continue;
      const workspaceId: any = nextPartition(statements.nextFairWorkspace, fixed.workspaceId, {
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
      const projectId: any = nextPartition(statements.nextFairProject, fixed.projectId, {
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
      const hierarchy: Record<string, any> = { tenantId, workspaceId, projectId };
      const candidate: any = statements.fairLeafCandidate.get({
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

  const enqueueTx: any = database.transaction((input: Record<string, any> = {}) : any => {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    const { queueDefinitionId, queueDefinitionVersion, queueDefinition } = resolveQueueDefinition(input, {
      assertEnqueue: true
    });
    const scope: any = normalizeScope(input.scope || {});
    const scopeKey: any = input.scopeKey ? toText(input.scopeKey) : scopeKeyFromScope(scope);
    const dedupeKey: any = toText(input.dedupeKey);

    const delayMs: any = Math.max(0, asInt(input.delayMs, 0));
    const availableAtMs: any = asInt(input.availableAtMs, delayMs > 0 ? nowMs + delayMs : nowMs);
    const state: any = availableAtMs > nowMs ? WORK_QUEUE_STATES.RETRY_WAIT : WORK_QUEUE_STATES.QUEUED;
    const payloadRef: any = normalizePayloadRef(input.payloadRef || input.payload || input.payloadReference);
    const ownerRef: any = normalizeOwnerRef(input.ownerRef);
    const policyForItem: any = getPolicy({
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
    const expiresAtMs: any = resolveWorkExpiryAtMs({
      nowMs,
      availableAtMs,
      expiresAtMs: input.expiresAtMs,
      policy: policyForItem
    });
    const payloadRefJson: any = serializePayloadRef(payloadRef);
    assertCapacityAtMost({
      count: Buffer.byteLength(payloadRefJson, "utf8"),
      limit: policyForItem.capacity.maxPayloadRefBytes,
      reason: "payload_ref_bytes"
    });
    if (dedupeKey) {
      const existing: any = statements.getDedupe.get(queueDefinitionId, scopeKey, dedupeKey);
      if (existing) {
        assertDedupeFingerprint(existing, { queueDefinitionVersion, payloadRef, ownerRef, schedulingScope: input.schedulingScope ?? scope });
        return {
          accepted: false,
          deduped: true,
          workItem: rowToWorkItem(existing)
        };
      }
    }
    const workItemId: any = toText(input.workItemId || identityGenerator.workItemId());
    const normalizedPriority: any = normalizeWorkQueuePriority(input.priority);
    const hierarchy: any = hierarchicalScopeParts(input.schedulingScope ?? scope);
    assertAdmissionCapacity({
      queueDefinitionId,
      hierarchy,
      state,
      policy: policyForItem
    });
    const row: Record<string, any> = {
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
    } catch (error: any) {
      if (dedupeKey && /UNIQUE constraint failed/i.test(String(error.message))) {
        const existing: any = statements.getDedupe.get(queueDefinitionId, scopeKey, dedupeKey);
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

    const seq: any = appendTransitionInternal({
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
    const inserted: any = statements.getWorkItem.get(workItemId);
    return {
      accepted: true,
      deduped: false,
      transitionSeq: seq,
      workItem: rowToWorkItem(inserted)
    };
  });

  const claimTx: any = database.transaction((input: Record<string, any> = {}) : any => {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    const { queueDefinitionId, queueDefinitionVersion } = resolveQueueDefinition(input, {
      allowAllVersions: true
    });
    const scope: any = normalizeScope(input.scope || {});
    const schedulingScope: any = normalizeScope(input.schedulingScope ?? scope);
    const scopeKey: any = input.scopeKey ? toText(input.scopeKey) : scopeKeyFromScope(scope);
    const recoveryScopeKey: any = scope.tenantId && scope.workspaceId && scope.projectId
      ? scopeKey
      : "";
    const workerId: any = toText(input.workerId || input.consumerId || identityGenerator.workerId());
    const batchSize: any = Math.max(1, Math.min(asInt(input.batchSize ?? input.batch ?? input.maxMessages, 1), 500));
    const leaseTimeoutMs: any = Math.max(1, asInt(input.leaseTimeoutMs, resolvedPolicy.leaseTimeoutMs));

    const expired: any = expireEligibleLocked({
      nowMs,
      queueDefinitionId,
      scopeKey: recoveryScopeKey,
      limit: Math.max(100, batchSize * 8)
    });
    const recovered: any = recoverExpiredLeasesLocked({
      nowMs,
      queueDefinitionId,
      scopeKey: recoveryScopeKey,
      limit: Math.max(100, batchSize * 8)
    });
    const control: any = statements.getQueueControl.get({
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
    const matured: any = materializeDelayedLocked({
      nowMs,
      queueDefinitionId,
      scopeKey: recoveryScopeKey,
      limit: Math.max(100, batchSize * 8)
    });
    const aged: any = promoteAgedCandidates({
      queueDefinitionId,
      queueDefinitionVersion: asInt(queueDefinitionVersion, 0),
      scopeKey,
      nowMs
    });

    const claimed: any[] = [];
    const failed: any[] = [];
    const maxVisits: any = Math.min(
      asPositiveInt(resolvedPolicy.fairness.maxVisitsPerClaim, 4096),
      Math.max(WORK_QUEUE_PRIORITY_CYCLE.length, batchSize * WORK_QUEUE_PRIORITY_CYCLE.length)
    );
    for (let visit: any = 0; visit < maxVisits && claimed.length < batchSize; visit += 1) {
      const row: any = selectFairCandidate({
        queueDefinitionId,
        queueDefinitionVersion: asInt(queueDefinitionVersion, 0),
        scope: schedulingScope,
        selectorScopeKey: scopeKey,
        nowMs
      });
      if (!row) continue;
      if (row.attempt >= row.max_attempts) {
        const failedRow: any = transitionProjection({
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
      const leaseId: any = identityGenerator.leaseId();
      const leaseSeq: any = row.lease_seq + 1;
      const attempt: any = row.attempt + 1;
      const leaseExpiresAtMs: any = row.expires_at_ms > 0
        ? Math.min(nowMs + leaseTimeoutMs, row.expires_at_ms)
        : nowMs + leaseTimeoutMs;
      const updated: any = transitionProjection({
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

  function expireRow(row?: any, nowMs?: any, input: Record<string, any> = {}) : any {
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

  function isWorkExpired(row?: any, nowMs?: any) : any {
    return Number(row?.expires_at_ms || 0) > 0 && Number(row.expires_at_ms) <= nowMs;
  }

  const expireTx: any = database.transaction((input: Record<string, any> = {}) : any => {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    const row: any = requireWorkItemBoundary(
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

  const completeTx: any = database.transaction((input: Record<string, any> = {}) : any => {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    const current: any = statements.getWorkItem.get(toText(input.workItemId));
    if (current?.state === WORK_QUEUE_STATES.COMPLETED) {
      const terminal: any = statements.getLastTransition.get(current.work_item_id);
      if (terminal?.transition === "complete" && terminal.lease_id === toText(input.leaseId)) {
        return { completed: true, idempotent: true, workItem: rowToWorkItem(current) };
      }
    }
    if (isWorkExpired(current, nowMs)) {
      return { completed: false, expired: true, workItem: rowToWorkItem(expireRow(current, nowMs, input)) };
    }
    const row: any = requireLeasedRow(input.workItemId, input.leaseId, nowMs);
    const updated: any = transitionProjection({
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

  const retryTx: any = database.transaction((input: Record<string, any> = {}) : any => {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    const current: any = statements.getWorkItem.get(toText(input.workItemId));
    if (isWorkExpired(current, nowMs)) {
      return { retried: false, expired: true, workItem: rowToWorkItem(expireRow(current, nowMs, input)) };
    }
    const row: any = requireLeasedRow(input.workItemId, input.leaseId, nowMs);
    const exhausted: any = row.attempt >= row.max_attempts;
    const delayMs: any = exhausted
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
    const toState: any = exhausted
      ? WORK_QUEUE_STATES.FAILED
      : delayMs > 0
        ? WORK_QUEUE_STATES.RETRY_WAIT
        : WORK_QUEUE_STATES.QUEUED;
    const updated: any = transitionProjection({
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

  const progressTx: any = database.transaction((input: Record<string, any> = {}) : any => {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    const current: any = statements.getWorkItem.get(toText(input.workItemId));
    if (isWorkExpired(current, nowMs)) {
      return { progressed: false, expired: true, workItem: rowToWorkItem(expireRow(current, nowMs, input)) };
    }
    const row: any = requireLeasedRow(input.workItemId, input.leaseId, nowMs);
    const extendMs: any = Math.max(1, asInt(input.extendMs ?? input.leaseTimeoutMs, resolvedPolicy.leaseTimeoutMs));
    const leaseExpiresAtMs: any = row.expires_at_ms > 0
      ? Math.min(nowMs + extendMs, row.expires_at_ms)
      : nowMs + extendMs;
    const updated: any = transitionProjection({
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

  const checkpointTx: any = database.transaction((input: Record<string, any> = {}) : any => {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    const row: any = requireLeasedRow(input.workItemId, input.leaseId, nowMs);
    const normalized: any = normalizeCheckpointRef(input.checkpointRef);
    if (row.checkpoint_digest === normalized.checkpointDigest) {
      return { checkpointed: true, idempotent: true, workItem: rowToWorkItem(row) };
    }
    const currentSeq: any = Number(row.checkpoint_seq || 0);
    if (input.expectedCheckpointSeq !== undefined &&
        asInt(input.expectedCheckpointSeq, -1) !== currentSeq) {
      const error: Error & Record<string, any> = new Error("Queue checkpoint revision does not match the current projection.");
      error.code = "work_queue_checkpoint_conflict";
      error.expectedCheckpointSeq = currentSeq;
      throw error;
    }
    const checkpointSeq: any = currentSeq + 1;
    statements.updateCheckpoint.run({
      work_item_id: row.work_item_id,
      checkpoint_ref_json: normalized.serialized,
      checkpoint_digest: normalized.checkpointDigest,
      checkpoint_seq: checkpointSeq,
      checkpoint_updated_at_ms: nowMs,
      updated_at_ms: nowMs
    });
    const updated: any = statements.getWorkItem.get(row.work_item_id);
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

  const cancelRunningTx: any = database.transaction((input: Record<string, any> = {}) : any => {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    const current: any = statements.getWorkItem.get(toText(input.workItemId));
    if (current?.state === WORK_QUEUE_STATES.CANCELLED) {
      const terminal: any = statements.getLastTransition.get(current.work_item_id);
      if (terminal?.transition === "cancel_running" && terminal.lease_id === toText(input.leaseId)) {
        return { cancelled: true, idempotent: true, workItem: rowToWorkItem(current) };
      }
    }
    if (isWorkExpired(current, nowMs)) {
      return { cancelled: false, expired: true, workItem: rowToWorkItem(expireRow(current, nowMs, input)) };
    }
    const row: any = requireLeasedRow(input.workItemId, input.leaseId, nowMs);
    const updated: any = transitionProjection({
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

  const cancelTx: any = database.transaction((input: Record<string, any> = {}) : any => {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    const row: any = requireWorkItemBoundary(
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
    const updated: any = transitionProjection({
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

  const failTx: any = database.transaction((input: Record<string, any> = {}) : any => {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    let row: any = requireWorkItemBoundary(
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
    const fallbackTaskId: any = toText(input.fallbackTaskId);
    const updated: any = transitionProjection({
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

  const recoverTx: any = database.transaction((input: Record<string, any> = {}) : any => {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    const row: any = requireWorkItemBoundary(
      statements.getWorkItem.get(toText(input.workItemId)),
      input
    );
    if (isWorkExpired(row, nowMs)) {
      throw new Error(`Work item ${input.workItemId} cannot be recovered after its deadline.`);
    }
    const policyForItem: any = policyForWorkItem(row);
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
    const updated: any = transitionProjection({
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

  function inspect(input: Record<string, any> = {}) : any {
    if (input.workItemId) {
      const row: any = statements.getWorkItem.get(toText(input.workItemId));
      if (!workItemMatchesBoundary(row, input)) {
        return { workItem: null, journal: [] };
      }
      const journal: any = input.includeJournal
        ? database.prepare(`
            SELECT *
            FROM work_queue_transition_journal
            WHERE work_item_id = ?
            ORDER BY seq ASC
          `).all(row.work_item_id).map(journalRowToTransition)
        : [];
      return { workItem: rowToWorkItem(row), journal };
    }

    const queueDefinitionId: any = toText(input.queueDefinitionId || input.queueDefinition?.queueDefinitionId);
    const scopeKey: any = input.scopeKey || (input.scope ? scopeKeyFromScope(input.scope) : "");
    const states: any = asArray(input.states, []).map(toText).filter(Boolean);
    const limit: any = Math.max(1, Math.min(asInt(input.limit, 100), 1000));
    const where: any[] = [];
    const params: Record<string, any> = {};
    if (queueDefinitionId) {
      where.push("queue_definition_id = @queue_definition_id");
      params.queue_definition_id = queueDefinitionId;
    }
    if (scopeKey) {
      where.push("scope_key = @scope_key");
      params.scope_key = scopeKey;
    }
    if (states.length) {
      where.push(`state IN (${states.map((_?: any, index?: any) : any => `@state_${index}`).join(", ")})`);
      states.forEach((state?: any, index?: any) : any => {
        params[`state_${index}`] = state;
      });
    }
    params.limit = limit;
    const sql: any = `
      SELECT *
      FROM work_items
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY priority DESC, available_at_ms ASC, created_at_ms ASC
      LIMIT @limit
    `;
    const items: any = database.prepare(sql).all(params).map(rowToWorkItem);
    const countWhere: any[] = [];
    const countParams: Record<string, any> = {};
    if (queueDefinitionId) {
      countWhere.push("queue_definition_id = @queue_definition_id");
      countParams.queue_definition_id = queueDefinitionId;
    }
    if (scopeKey) {
      countWhere.push("scope_key = @scope_key");
      countParams.scope_key = scopeKey;
    }
    const stateCounts: any = database.prepare(`
      SELECT state, COUNT(*) AS count
      FROM work_items
      ${countWhere.length ? `WHERE ${countWhere.join(" AND ")}` : ""}
      GROUP BY state
      ORDER BY state ASC
    `).all(countParams)
      .map((row?: any) : any => ({ state: row.state, count: row.count }));
    return { items, stateCounts };
  }

  const rebuildProjectionTx: any = database.transaction((input: Record<string, any> = {}) : any => rebuildSqliteProjection({ database, statements, input }));

  const registerQueueDefinitionTx: any = database.transaction((definition: Record<string, any> = {}) : any => {
    const nowMs: any = nowFrom(timeSource, definition.nowMs);
    const queueDefinitionId: any = toText(definition.queueDefinitionId || definition.id);
    if (!queueDefinitionId) {
      throw new Error("queueDefinitionId is required.");
    }
    const label: any = toText(definition.label);
    if (!label) {
      throw new Error("Queue definition label is required.");
    }
    const queueDefinitionVersion: any = asPositiveInt(
      definition.queueDefinitionVersion ?? definition.version,
      1
    );
    const snapshot: any = queueDefinitionSnapshot({
      ...definition,
      queueDefinitionId,
      queueDefinitionVersion,
      label
    });
    const existing: any = database.prepare(`
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
    const conflictingLabel: any = database.prepare(`
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

  const setQueueControlTx: any = database.transaction((input: Record<string, any> = {}) : any => {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    const queueDefinitionId: any = toText(input.queueDefinitionId || input.queueDefinition?.queueDefinitionId);
    if (!queueDefinitionId) {
      throw new Error("queueDefinitionId is required.");
    }
    const scopeKey: any = input.scopeKey || (input.scope ? scopeKeyFromScope(input.scope) : "");
    const mode: any = toText(input.mode || "active");
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

  function getQueueControl(input: Record<string, any> = {}) : any {
    const queueDefinitionId: any = toText(input.queueDefinitionId || input.queueDefinition?.queueDefinitionId);
    if (!queueDefinitionId) {
      throw new Error("queueDefinitionId is required.");
    }
    const scopeKey: any = input.scopeKey || (input.scope ? scopeKeyFromScope(input.scope) : "");
    const row: any = statements.getQueueControl.get({
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

  function writeInternalHealthState(input: Record<string, any> = {}) : any {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    const healthKey: any = toText(input.healthKey || input.entityId || "default");
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

  const store: Record<string, any> = {
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
    pause(input: Record<string, any> = {}) : any {
      return setQueueControlTx({
        ...input,
        mode: "paused"
      });
    },
    resume(input: Record<string, any> = {}) : any {
      return setQueueControlTx({
        ...input,
        mode: "active"
      });
    },
    drain(input: Record<string, any> = {}) : any {
      return setQueueControlTx({
        ...input,
        mode: "draining"
      });
    },
    getQueueControl,
    recordBackgroundWrite,
    writeFallbackCoordinatorState(input: Record<string, any> = {}) : any {
      const nowMs: any = nowFrom(timeSource, input.nowMs);
      const fallbackTaskId: any = toText(input.fallbackTaskId || input.entityId || identityGenerator.fallbackTaskId());
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
    writeSnapshotState(input: Record<string, any> = {}) : any {
      return recordBackgroundWrite("snapshot", input);
    },
    writeCompactionState(input: Record<string, any> = {}) : any {
      return recordBackgroundWrite("compaction", input);
    },
    writeInternalHealthState,
    isClosed() : any {
      return closed || (ownsDatabase && database.open === false);
    },
    close() : any {
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
