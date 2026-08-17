import { computeDeterministicRetryDelay } from "./policies.ts";
import {
  assertLegalWorkQueueTransition,
  WORK_QUEUE_STATES as RAW_WORK_QUEUE_STATES
} from "../workflow/state-machine/work-queue/state-machine.ts";
import { asInt, getPolicy, jsonString as serializeJsonString, nowFrom, parseJson, rowToWorkItem, toText } from "./store-serialization.ts";
import { WorkQueueCapacityError } from "./scheduling.ts";

const WORK_QUEUE_STATES = RAW_WORK_QUEUE_STATES as Readonly<Record<string, string>>;

export type SqliteValue = string | number | bigint | Buffer | null;
export type SqliteBindings = Readonly<Record<string, SqliteValue>>;

export interface WorkQueueRow {
  [key: string]: unknown;
  work_item_id: string;
  queue_definition_id: string;
  queue_definition_version: number;
  state: string;
  scope_key: string;
  scope_json: string;
  dedupe_key: string;
  owner_ref_json: string;
  payload_ref_json: string;
  payload_kind: string;
  available_at_ms: number;
  expires_at_ms: number;
  attempt: number;
  max_attempts: number;
  lease_id: string;
  lease_seq: number;
  leased_by_worker_id: string;
  lease_expires_at_ms: number;
  fallback_task_id: string;
  last_error_json: string;
  policy_version: string;
  priority: number;
  priority_class: string;
  tenant_id: string;
  workspace_id: string;
  project_id: string;
  concurrency_key: string;
  route_version: string;
  checkpoint_ref_json: string;
  checkpoint_digest: string;
  checkpoint_seq: number;
  checkpoint_updated_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
  last_transition_seq: number;
}

function jsonString(value: unknown, fallback: unknown): string {
  return serializeJsonString(value, fallback) ?? "null";
}

interface SqliteResultRow extends WorkQueueRow {
  count: number;
  pending_transitions: number;
  policy_json: string;
  sink_id: string;
  status: string;
  effect_id: string;
  total: number;
  mode: string;
  reason: string;
  actor_json: string;
  transition: string;
}

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface WorkQueueStatement {
  get(...parameters: Array<SqliteBindings | SqliteValue>): SqliteResultRow | undefined;
  all(...parameters: Array<SqliteBindings | SqliteValue>): SqliteResultRow[];
  run(...parameters: Array<SqliteBindings | SqliteValue>): SqliteRunResult;
  run(parameters: WorkQueueRow): SqliteRunResult;
}

export type WorkQueueStatements = Readonly<Record<string, WorkQueueStatement>>;

export interface QueueIdentityGenerator {
  journalEntryId(): string;
}

export interface QueuePolicy {
  capacity: Readonly<Record<string, number>> & { maxFailed: number };
  retention: {
    cleanupBatchSize: number;
    maxTransitionsPerWorkItem: number;
    maxJournalEntries: number;
    maxTerminalItems: number;
  };
  fairness: {
    agingIntervalMs: number; agingBatchSize: number;
    minReservedLeasesPerPartition: number; reservationScanLimit: number;
  };
  retryBackoff: Parameters<typeof computeDeterministicRetryDelay>[0];
  fallbackRetry: { maxAttempts: number };
  maxAttempts: number;
  leaseTimeoutMs: number;
  policyVersion: string;
}

export interface QueueTimeSourceLike { nowMs(): number }

interface RuntimeOptions {
  statements: WorkQueueStatements;
  timeSource: QueueTimeSourceLike;
  identityGenerator: QueueIdentityGenerator;
  resolvedPolicy: QueuePolicy;
}

export type ProjectionPatch = Partial<Pick<WorkQueueRow,
  "state" | "available_at_ms" | "attempt" | "max_attempts" | "lease_id" |
  "lease_seq" | "leased_by_worker_id" | "lease_expires_at_ms" |
  "fallback_task_id" | "last_error_json" | "updated_at_ms">>;

export interface TransitionInput {
  row: WorkQueueRow;
  transition: string;
  toState: string;
  patch?: ProjectionPatch;
  nowMs: number;
  operationId?: unknown;
  actor?: unknown;
  reason?: unknown;
  policyVersion?: unknown;
}

export interface RuntimeQuery {
  nowMs?: number;
  queueDefinitionId?: string;
  scopeKey?: string;
  workItemId?: string;
  limit?: number;
}

export interface BackgroundWriteInput {
  nowMs?: unknown; entityId?: unknown; workItemId?: unknown; snapshotId?: unknown;
  healthKey?: unknown; backgroundWriteId?: unknown; state?: unknown; value?: unknown;
  status?: unknown; attempt?: unknown; nextRetryAtMs?: unknown; lastError?: unknown;
}

export interface SqliteWorkQueueRuntime {
  appendTransitionInternal(input: TransitionInput & { fromState?: string | null; leaseId?: string; leaseSeq?: number; decision?: unknown }): number;
  transitionProjection(input: TransitionInput): WorkQueueRow;
  recordBackgroundWrite(aspectType?: unknown, input?: BackgroundWriteInput): { backgroundWriteId: string; aspectType: unknown; entityId: string; committedAtMs: number };
  expireEligibleLocked(input?: RuntimeQuery): unknown[];
  materializeDelayedLocked(input?: RuntimeQuery): unknown[];
  recoverExpiredLeasesLocked(input?: RuntimeQuery): unknown[];
  reconcileInDoubtLocked(input?: RuntimeQuery): unknown[];
  requireLeasedRow(workItemId?: unknown, leaseId?: unknown, nowMs?: number, options?: { allowExpired?: boolean }): WorkQueueRow;
}

export function createSqliteWorkQueueRuntime({ statements, timeSource, identityGenerator, resolvedPolicy }: RuntimeOptions): SqliteWorkQueueRuntime {
  function policyForRow(row: WorkQueueRow): QueuePolicy {
    const definition = statements.getDefinitionPolicy.get(
      row.queue_definition_id,
      row.queue_definition_version
    );
    const override = parseJson(definition?.policy_json, {}) as Partial<QueuePolicy>;
    return getPolicy({
      ...resolvedPolicy,
      ...override,
      capacity: { ...resolvedPolicy.capacity, ...override.capacity },
      retention: { ...resolvedPolicy.retention, ...override.retention }
    });
  }

  function boundedCount(statement: WorkQueueStatement, parameters: SqliteBindings, limit: number): number {
    return Number(statement.get({ ...parameters, limit: Number(limit) + 1 })?.count || 0);
  }

  function insertRetentionSnapshot(row: WorkQueueRow, nowMs: number): number {
    statements.deleteJournalByWorkItem.run(row.work_item_id);
    const result = statements.insertJournal.run({
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
    const seq = Number(result.lastInsertRowid);
    statements.updateLastTransitionSeq.run({ seq, work_item_id: row.work_item_id, updated_at_ms: nowMs });
    return seq;
  }

  function compactWorkJournal(workItemId: string, nowMs: number, { force = false }: { force?: boolean } = {}): boolean {
    const row = statements.getWorkItem.get(workItemId);
    if (!row) return false;
    const { retention } = policyForRow(row);
    const count = Number(statements.countJournalByWorkItem.get(workItemId)?.count || 0);
    if (count <= 1 || (!force && count <= retention.maxTransitionsPerWorkItem)) {
      return false;
    }
    insertRetentionSnapshot(row, nowMs);
    return true;
  }

  function deleteTerminalRows(queueDefinitionId: string, excludeWorkItemId: string, limit: number): number {
    const rows = statements.oldestTerminalItems.all({
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

  function retentionMaintenanceThreshold(retention: QueuePolicy["retention"]): number {
    return Math.max(1, Math.min(
      asInt(retention.cleanupBatchSize, 1),
      asInt(retention.maxTransitionsPerWorkItem, 1),
      asInt(retention.maxJournalEntries, 1)
    ));
  }

  function maintainRetentionAfterAppend(row: WorkQueueRow, nowMs: number): boolean {
    const { retention } = policyForRow(row);
    const queueDefinitionId = row.queue_definition_id;
    const threshold = retentionMaintenanceThreshold(retention);
    const pending = Number(statements.incrementRetentionState.get({
      queue_definition_id: queueDefinitionId,
      updated_at_ms: nowMs
    })?.pending_transitions || 0);
    if (pending < threshold) return false;
    statements.resetRetentionState.run({
      queue_definition_id: queueDefinitionId,
      threshold,
      updated_at_ms: nowMs
    });
    const terminalCount = [
      WORK_QUEUE_STATES.COMPLETED,
      WORK_QUEUE_STATES.CANCELLED,
      WORK_QUEUE_STATES.EXPIRED
    ].reduce((total, state) => total + boundedCount(
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

    let journalCount = boundedCount(
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
      const candidates = statements.oldestJournalCandidates.all({
        queue_definition_id: queueDefinitionId,
        exclude_work_item_id: row.work_item_id,
        limit: retention.cleanupBatchSize * retention.maxTransitionsPerWorkItem
      });
      const unique = new Set(candidates.map((candidate) => candidate.work_item_id));
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
      const currentCount = Number(statements.countJournalByWorkItem.get(row.work_item_id)?.count || 0);
      if (currentCount > 1 && compactWorkJournal(row.work_item_id, nowMs, { force: true })) return true;
      throw new WorkQueueCapacityError("queue_journal_retention", retention.maxJournalEntries);
    }
    return false;
  }

  function makeFailedCapacityRoom(row: WorkQueueRow): void {
    const { capacity, retention } = policyForRow(row);
    let failedCount = boundedCount(
      statements.countRetainedState,
      { queue_definition_id: row.queue_definition_id, state: WORK_QUEUE_STATES.FAILED },
      capacity.maxFailed
    );
    if (failedCount < capacity.maxFailed) return;
    const candidates = statements.oldestFailedItems.all({
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
  }: TransitionInput & {
    fromState?: string | null;
    leaseId?: string;
    leaseSeq?: number;
    decision?: unknown;
  }): number {
    assertLegalWorkQueueTransition({ transition, fromState: fromState ?? null, toState });
    const result = statements.insertJournal.run({
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
    const seq = Number(result.lastInsertRowid);
    statements.updateLastTransitionSeq.run({ seq, work_item_id: row.work_item_id, updated_at_ms: nowMs });
    const workJournalCompacted = compactWorkJournal(row.work_item_id, nowMs);
    const queueRetentionMaintained = maintainRetentionAfterAppend(row, nowMs);
    return workJournalCompacted || queueRetentionMaintained ?
      Number(statements.getWorkItem.get(row.work_item_id)?.last_transition_seq || seq) : seq;
  }

  function applyProjectionPatch(row: WorkQueueRow, patch: ProjectionPatch = {}): WorkQueueRow {
    const updated: WorkQueueRow = {
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
    return statements.getWorkItem.get(updated.work_item_id) ?? updated;
  }

  function transitionProjection({ row, transition, toState, patch = {}, nowMs, operationId, actor, reason, policyVersion }: TransitionInput): WorkQueueRow {
    if (toState === WORK_QUEUE_STATES.FAILED && row.state !== WORK_QUEUE_STATES.FAILED) {
      makeFailedCapacityRoom(row);
    }
    const fromState = row.state;
    const journalLeaseId = transition === "claim" ? patch.lease_id : row.lease_id || patch.lease_id || "";
    const journalLeaseSeq = transition === "claim" ? patch.lease_seq : row.lease_seq || patch.lease_seq || 0;
    const nextRow = applyProjectionPatch(row, { ...patch, state: toState, updated_at_ms: nowMs });
    const seq = appendTransitionInternal({
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
    return statements.getWorkItem.get(row.work_item_id) ?? nextRow;
  }

  function recordBackgroundWrite(aspectType?: unknown, input: BackgroundWriteInput = {}) {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const entityId = toText(input.entityId || input.workItemId || input.snapshotId || input.healthKey || aspectType);
    const backgroundWriteId = toText(input.backgroundWriteId || `${String(aspectType)}:${entityId}`);
    statements.insertBackgroundWrite.run({
      background_write_id: backgroundWriteId,
      aspect_type: toText(aspectType),
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

  function expireEligibleLocked({ nowMs = timeSource.nowMs(), queueDefinitionId = "", scopeKey = "", limit = 1000 }: RuntimeQuery = {}): unknown[] {
    const rows = statements.expiredWorkItems.all({
      queued_state: WORK_QUEUE_STATES.QUEUED,
      retry_wait_state: WORK_QUEUE_STATES.RETRY_WAIT,
      running_state: WORK_QUEUE_STATES.RUNNING,
      recovered_state: WORK_QUEUE_STATES.RECOVERED,
      now_ms: nowMs,
      queue_definition_id: toText(queueDefinitionId),
      scope_key: toText(scopeKey),
      limit: Math.max(1, asInt(limit, 1000))
    });
    return rows.map((row) => rowToWorkItem(transitionProjection({
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

  function materializeDelayedLocked({ nowMs = timeSource.nowMs(), queueDefinitionId = "", scopeKey = "", limit = 1000 }: RuntimeQuery = {}): unknown[] {
    const rows = statements.materializeDelayed.all({
      state: WORK_QUEUE_STATES.RETRY_WAIT,
      now_ms: nowMs,
      queue_definition_id: toText(queueDefinitionId),
      scope_key: toText(scopeKey),
      limit: Math.max(1, asInt(limit, 1000))
    });
    return rows.map((row) => rowToWorkItem(transitionProjection({
      row,
      transition: "delay_matured",
      toState: WORK_QUEUE_STATES.QUEUED,
      patch: { available_at_ms: nowMs, lease_id: "", leased_by_worker_id: "", lease_expires_at_ms: 0 },
      nowMs,
      reason: "delay_matured"
    })));
  }

  function recoverExpiredLeasesLocked({ nowMs = timeSource.nowMs(), queueDefinitionId = "", scopeKey = "", limit = 1000 }: RuntimeQuery = {}): unknown[] {
    const rows = statements.expiredLeases.all({
      state: WORK_QUEUE_STATES.RUNNING,
      now_ms: nowMs,
      queue_definition_id: toText(queueDefinitionId),
      scope_key: toText(scopeKey),
      limit: Math.max(1, asInt(limit, 1000))
    });
    const recovered: unknown[] = [];
    for (const row of rows) {
      const updated = transitionProjection({
        row,
        transition: "lease_expired",
        toState: WORK_QUEUE_STATES.IN_DOUBT,
        patch: {
          last_error_json: jsonString({
            type: "lease_expired",
            leaseId: row.lease_id,
            workerId: row.leased_by_worker_id,
            expiredAtMs: nowMs
          }, {})
        },
        nowMs,
        reason: "lease_expired_unconfirmed"
      });
      recovered.push(rowToWorkItem(updated));
    }
    return recovered;
  }

  function reconcileInDoubtLocked({ nowMs = timeSource.nowMs(), queueDefinitionId = "", scopeKey = "", workItemId = "", limit = 1000 }: RuntimeQuery = {}): unknown[] {
    const rows = statements.inDoubtCandidates.all({
      state: WORK_QUEUE_STATES.IN_DOUBT,
      now_ms: nowMs,
      queue_definition_id: toText(queueDefinitionId),
      scope_key: toText(scopeKey),
      work_item_id: toText(workItemId),
      limit: Math.max(1, asInt(limit, 1000))
    });
    const reconciled: unknown[] = [];
    for (const row of rows) {
      const receipts = statements.readSinkFence.all({
        work_item_id: row.work_item_id,
        generation: Number(row.lease_seq || 0)
      });
      const terminalReceipt = receipts.find((receipt) =>
        ["complete", "fail"].includes(String(receipt.sink_id || "")) &&
        receipt.status === "settled"
      );
      if (!terminalReceipt) {
        continue;
      }
      const toState = terminalReceipt.sink_id === "complete"
        ? WORK_QUEUE_STATES.COMPLETED
        : WORK_QUEUE_STATES.FAILED;
      const updated = transitionProjection({
        row,
        transition: "termination_acknowledged",
        toState,
        patch: {
          available_at_ms: nowMs,
          lease_id: "",
          leased_by_worker_id: "",
          lease_expires_at_ms: 0,
          last_error_json: jsonString({
            type: "sink_receipt_reconciled",
            sinkId: terminalReceipt.sink_id,
            effectId: terminalReceipt.effect_id || "",
            generation: Number(row.lease_seq || 0)
          }, {})
        },
        nowMs,
        reason: "sink_receipt_reconciled"
      });
      reconciled.push(rowToWorkItem(updated));
    }
    return reconciled;
  }

  function requireLeasedRow(workItemId?: unknown, leaseId?: unknown, nowMs = timeSource.nowMs(), { allowExpired = false }: { allowExpired?: boolean } = {}): WorkQueueRow {
    const row = statements.getWorkItem.get(toText(workItemId));
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
    reconcileInDoubtLocked,
    requireLeasedRow
  };
}
