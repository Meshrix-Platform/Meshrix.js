import { computeDeterministicRetryDelay } from "./policies.ts";
import {
  assertLegalWorkQueueTransition,
  WORK_QUEUE_STATES
} from "../workflow/state-machine/work-queue/state-machine.ts";
import { asInt, getPolicy, jsonString, nowFrom, parseJson, rowToWorkItem, toText } from "./store-serialization.ts";
import { WorkQueueCapacityError } from "./scheduling.ts";

export function createSqliteWorkQueueRuntime({ statements, timeSource, identityGenerator, resolvedPolicy }: Record<string, any>) : any {
  function policyForRow(row?: any) : any {
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

  function boundedCount(statement?: any, parameters?: any, limit?: any) : any {
    return Number(statement.get({ ...parameters, limit: Number(limit) + 1 })?.count || 0);
  }

  function insertRetentionSnapshot(row?: any, nowMs?: any) : any {
    statements.deleteJournalByWorkItem.run(row.work_item_id);
    const result: any = statements.insertJournal.run({
      journal_entry_id: identityGenerator.journalEntryId(),
      work_item_id: row.work_item_id,
      queue_definition_id: row.queue_definition_id,
      queue_definition_version: row.queue_definition_version,
      transition: "retention_snapshot",
      from_state: null,
      to_state: row.state,
      lease_id: row.lease_id || "",
      lease_seq: row.lease_seq || 0,
      operation_id: "work_queue.retention.snapshot",
      actor_json: "{}",
      reason: "bounded_journal_compaction",
      policy_version: row.policy_version || "",
      decision_json: jsonString({ projectionRow: row }, {}),
      created_at_ms: nowMs,
      adopted_time_ms: nowMs
    });
    const seq: any = Number(result.lastInsertRowid);
    statements.updateLastTransitionSeq.run({ seq, work_item_id: row.work_item_id, updated_at_ms: nowMs });
    return seq;
  }

  function compactWorkJournal(workItemId?: any, nowMs?: any, { force = false }: Record<string, any> = {}) : any {
    const row: any = statements.getWorkItem.get(workItemId);
    if (!row) return false;
    const { retention } = policyForRow(row);
    const count: any = Number(statements.countJournalByWorkItem.get(workItemId)?.count || 0);
    if (count <= 1 || (!force && count <= retention.maxTransitionsPerWorkItem)) {
      return false;
    }
    insertRetentionSnapshot(row, nowMs);
    return true;
  }

  function deleteTerminalRows(queueDefinitionId?: any, excludeWorkItemId?: any, limit?: any) : any {
    const rows: any = statements.oldestTerminalItems.all({
      queue_definition_id: queueDefinitionId,
      completed_state: WORK_QUEUE_STATES.COMPLETED,
      cancelled_state: WORK_QUEUE_STATES.CANCELLED,
      expired_state: WORK_QUEUE_STATES.EXPIRED,
      exclude_work_item_id: excludeWorkItemId || "",
      limit: Math.max(0, limit)
    });
    for (const candidate of rows) {
      statements.deleteFallbackTasksByWorkItem.run(candidate.work_item_id);
      statements.deleteJournalByWorkItem.run(candidate.work_item_id);
      statements.deleteWorkItem.run(candidate.work_item_id);
    }
    return rows.length;
  }

  function maintainRetentionBeforeAppend(row?: any, nowMs?: any) : any {
    const { retention } = policyForRow(row);
    const queueDefinitionId: any = row.queue_definition_id;
    const terminalCount: any = [
      WORK_QUEUE_STATES.COMPLETED,
      WORK_QUEUE_STATES.CANCELLED,
      WORK_QUEUE_STATES.EXPIRED
    ].reduce((total?: any, state?: any) : any => total + boundedCount(
      statements.countRetainedState,
      { queue_definition_id: queueDefinitionId, state },
      retention.maxTerminalItems
    ), 0);
    if (terminalCount > retention.maxTerminalItems) {
      deleteTerminalRows(
        queueDefinitionId,
        row.work_item_id,
        Math.min(retention.cleanupBatchSize, terminalCount - retention.maxTerminalItems)
      );
    }

    let journalCount: any = boundedCount(
      statements.countJournalByQueue,
      { queue_definition_id: queueDefinitionId },
      retention.maxJournalEntries
    );
    if (journalCount >= retention.maxJournalEntries) {
      deleteTerminalRows(queueDefinitionId, row.work_item_id, retention.cleanupBatchSize);
      journalCount = boundedCount(
        statements.countJournalByQueue,
        { queue_definition_id: queueDefinitionId },
        retention.maxJournalEntries
      );
    }
    if (journalCount >= retention.maxJournalEntries) {
      const candidates: any = statements.oldestJournalCandidates.all({
        queue_definition_id: queueDefinitionId,
        exclude_work_item_id: row.work_item_id,
        limit: retention.cleanupBatchSize * retention.maxTransitionsPerWorkItem
      });
      const unique: any = new Set<any>(candidates.map((candidate?: any) : any => candidate.work_item_id));
      for (const workItemId of [...unique].slice(0, retention.cleanupBatchSize)) {
        compactWorkJournal(workItemId, nowMs, { force: true });
      }
      journalCount = boundedCount(
        statements.countJournalByQueue,
        { queue_definition_id: queueDefinitionId },
        retention.maxJournalEntries
      );
    }
    if (journalCount >= retention.maxJournalEntries) {
      const currentCount: any = Number(statements.countJournalByWorkItem.get(row.work_item_id)?.count || 0);
      if (currentCount > 0) return true;
      throw new WorkQueueCapacityError("queue_journal_retention", retention.maxJournalEntries);
    }
    return false;
  }

  function makeFailedCapacityRoom(row?: any, nowMs?: any) : any {
    const { capacity, retention } = policyForRow(row);
    let failedCount: any = boundedCount(
      statements.countRetainedState,
      { queue_definition_id: row.queue_definition_id, state: WORK_QUEUE_STATES.FAILED },
      capacity.maxFailed
    );
    if (failedCount < capacity.maxFailed) return;
    const candidates: any = statements.oldestFailedItems.all({
      queue_definition_id: row.queue_definition_id,
      state: WORK_QUEUE_STATES.FAILED,
      exclude_work_item_id: row.work_item_id,
      limit: Math.min(retention.cleanupBatchSize, failedCount - capacity.maxFailed + 1)
    });
    for (const candidate of candidates) {
      statements.deleteFallbackTasksByWorkItem.run(candidate.work_item_id);
      statements.deleteJournalByWorkItem.run(candidate.work_item_id);
      statements.deleteWorkItem.run(candidate.work_item_id);
    }
    failedCount = boundedCount(
      statements.countRetainedState,
      { queue_definition_id: row.queue_definition_id, state: WORK_QUEUE_STATES.FAILED },
      capacity.maxFailed
    );
    if (failedCount >= capacity.maxFailed) {
      throw new WorkQueueCapacityError("queue_failed_retained", capacity.maxFailed);
    }
  }

  function appendTransitionInternal({
    row,
    transition,
    fromState,
    toState,
    leaseId,
    leaseSeq,
    nowMs,
    operationId = "",
    actor = {},
    reason = "",
    policyVersion = "",
    decision = {}
  }: Record<string, any>) : any {
    assertLegalWorkQueueTransition({ transition, fromState: fromState ?? null, toState });
    const forceCompactCurrent: any = maintainRetentionBeforeAppend(row, nowMs);
    const result: any = statements.insertJournal.run({
      journal_entry_id: identityGenerator.journalEntryId(),
      work_item_id: row.work_item_id,
      queue_definition_id: row.queue_definition_id,
      queue_definition_version: row.queue_definition_version,
      transition,
      from_state: fromState ?? null,
      to_state: toState,
      lease_id: leaseId ?? row.lease_id ?? "",
      lease_seq: leaseSeq ?? row.lease_seq ?? 0,
      operation_id: toText(operationId),
      actor_json: jsonString(actor, {}),
      reason: toText(reason),
      policy_version: toText(policyVersion || row.policy_version),
      decision_json: jsonString(decision, {}),
      created_at_ms: nowMs,
      adopted_time_ms: nowMs
    });
    const seq: any = Number(result.lastInsertRowid);
    statements.updateLastTransitionSeq.run({ seq, work_item_id: row.work_item_id, updated_at_ms: nowMs });
    return compactWorkJournal(row.work_item_id, nowMs, { force: forceCompactCurrent }) ?
      Number(statements.getWorkItem.get(row.work_item_id)?.last_transition_seq || seq) : seq;
  }

  function applyProjectionPatch(row?: any, patch: Record<string, any> = {}) : any {
    const updated: Record<string, any> = {
      ...row,
      ...patch,
      work_item_id: row.work_item_id,
      queue_definition_id: row.queue_definition_id,
      queue_definition_version: row.queue_definition_version
    };
    statements.updateStateProjection.run({
      work_item_id: updated.work_item_id,
      state: updated.state,
      available_at_ms: updated.available_at_ms,
      attempt: updated.attempt,
      max_attempts: updated.max_attempts,
      lease_id: updated.lease_id || "",
      lease_seq: updated.lease_seq || 0,
      leased_by_worker_id: updated.leased_by_worker_id || "",
      lease_expires_at_ms: updated.lease_expires_at_ms || 0,
      fallback_task_id: updated.fallback_task_id || "",
      last_error_json: updated.last_error_json || "{}",
      updated_at_ms: updated.updated_at_ms
    });
    return statements.getWorkItem.get(updated.work_item_id);
  }

  function transitionProjection({ row, transition, toState, patch = {}, nowMs, operationId, actor, reason, policyVersion }: Record<string, any>) : any {
    if (toState === WORK_QUEUE_STATES.FAILED && row.state !== WORK_QUEUE_STATES.FAILED) {
      makeFailedCapacityRoom(row, nowMs);
    }
    const fromState: any = row.state;
    const journalLeaseId: any = transition === "claim" ? patch.lease_id : row.lease_id || patch.lease_id || "";
    const journalLeaseSeq: any = transition === "claim" ? patch.lease_seq : row.lease_seq || patch.lease_seq || 0;
    const nextRow: any = applyProjectionPatch(row, { ...patch, state: toState, updated_at_ms: nowMs });
    const seq: any = appendTransitionInternal({
      row: nextRow,
      transition,
      fromState,
      toState,
      leaseId: journalLeaseId,
      leaseSeq: journalLeaseSeq,
      nowMs,
      operationId,
      actor,
      reason,
      policyVersion,
      decision: { projectionPatch: { ...patch, state: toState, updated_at_ms: nowMs } }
    });
    statements.updateLastTransitionSeq.run({ seq, work_item_id: row.work_item_id, updated_at_ms: nowMs });
    return statements.getWorkItem.get(row.work_item_id);
  }

  function recordBackgroundWrite(aspectType?: any, input: Record<string, any> = {}) : any {
    const nowMs: any = nowFrom(timeSource, input.nowMs);
    const entityId: any = toText(input.entityId || input.workItemId || input.snapshotId || input.healthKey || aspectType);
    const backgroundWriteId: any = toText(input.backgroundWriteId || `${aspectType}:${entityId}`);
    statements.insertBackgroundWrite.run({
      background_write_id: backgroundWriteId,
      aspect_type: aspectType,
      entity_id: entityId,
      state_json: jsonString(input.state || input.value || input, {}),
      status: toText(input.status || "committed"),
      attempt: asInt(input.attempt, 0),
      next_retry_at_ms: asInt(input.nextRetryAtMs, 0),
      last_error_json: jsonString(input.lastError || {}, {}),
      created_at_ms: nowMs,
      updated_at_ms: nowMs
    });
    return { backgroundWriteId, aspectType, entityId, committedAtMs: nowMs };
  }

  function expireEligibleLocked({ nowMs, queueDefinitionId = "", scopeKey = "", limit = 1000 }: Record<string, any> = {}) : any {
    const rows: any = statements.expiredWorkItems.all({
      queued_state: WORK_QUEUE_STATES.QUEUED,
      retry_wait_state: WORK_QUEUE_STATES.RETRY_WAIT,
      running_state: WORK_QUEUE_STATES.RUNNING,
      recovered_state: WORK_QUEUE_STATES.RECOVERED,
      now_ms: nowMs,
      queue_definition_id: toText(queueDefinitionId),
      scope_key: toText(scopeKey),
      limit: Math.max(1, asInt(limit, 1000))
    });
    return rows.map((row?: any) : any => rowToWorkItem(transitionProjection({
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
      reason: "work_deadline_reached"
    })));
  }

  function materializeDelayedLocked({ nowMs, queueDefinitionId = "", scopeKey = "", limit = 1000 }: Record<string, any> = {}) : any {
    const rows: any = statements.materializeDelayed.all({
      state: WORK_QUEUE_STATES.RETRY_WAIT,
      now_ms: nowMs,
      queue_definition_id: toText(queueDefinitionId),
      scope_key: toText(scopeKey),
      limit: Math.max(1, asInt(limit, 1000))
    });
    return rows.map((row?: any) : any => rowToWorkItem(transitionProjection({
      row,
      transition: "delay_matured",
      toState: WORK_QUEUE_STATES.QUEUED,
      patch: { available_at_ms: nowMs, lease_id: "", leased_by_worker_id: "", lease_expires_at_ms: 0 },
      nowMs,
      reason: "delay_matured"
    })));
  }

  function recoverExpiredLeasesLocked({ nowMs, queueDefinitionId = "", scopeKey = "", limit = 1000 }: Record<string, any> = {}) : any {
    const rows: any = statements.expiredLeases.all({
      state: WORK_QUEUE_STATES.RUNNING,
      now_ms: nowMs,
      queue_definition_id: toText(queueDefinitionId),
      scope_key: toText(scopeKey),
      limit: Math.max(1, asInt(limit, 1000))
    });
    const recovered: any[] = [];
    for (const row of rows) {
      const exhausted: any = row.attempt >= row.max_attempts;
      const delayMs: any = exhausted ? 0 : computeDeterministicRetryDelay({
        queueDefinitionId: row.queue_definition_id,
        workItemId: row.work_item_id,
        attempt: row.attempt,
        ...resolvedPolicy.retryBackoff
      });
      const toState: any = exhausted
        ? WORK_QUEUE_STATES.FAILED
        : delayMs > 0
          ? WORK_QUEUE_STATES.RETRY_WAIT
          : WORK_QUEUE_STATES.QUEUED;
      const updated: any = transitionProjection({
        row,
        transition: "lease_expired",
        toState,
        patch: {
          available_at_ms: nowMs + delayMs,
          lease_id: "",
          leased_by_worker_id: "",
          lease_expires_at_ms: 0,
          last_error_json: jsonString({
            type: "lease_expired",
            leaseId: row.lease_id,
            workerId: row.leased_by_worker_id,
            expiredAtMs: nowMs
          }, {})
        },
        nowMs,
        reason: exhausted ? "lease_expired_max_attempts_exhausted" : "lease_expired_retry"
      });
      recovered.push(rowToWorkItem(updated));
    }
    return recovered;
  }

  function requireLeasedRow(workItemId?: any, leaseId?: any, nowMs: any = timeSource.nowMs(), { allowExpired = false }: Record<string, any> = {}) : any {
    const row: any = statements.getWorkItem.get(toText(workItemId));
    if (!row) {
      throw new Error(`Work item not found: ${workItemId}`);
    }
    if (row.state !== WORK_QUEUE_STATES.RUNNING) {
      throw new Error(`Work item ${workItemId} is not leased.`);
    }
    if (!leaseId || row.lease_id !== leaseId) {
      throw new Error(`Lease fence rejected for work item ${workItemId}.`);
    }
    if (!allowExpired && row.lease_expires_at_ms > 0 && row.lease_expires_at_ms <= nowMs) {
      throw new Error(`Lease expired for work item ${workItemId}.`);
    }
    return row;
  }

  return {
    appendTransitionInternal,
    transitionProjection,
    recordBackgroundWrite,
    expireEligibleLocked,
    materializeDelayedLocked,
    recoverExpiredLeasesLocked,
    requireLeasedRow
  };
}
