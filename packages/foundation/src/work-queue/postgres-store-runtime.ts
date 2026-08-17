import {
  assertLegalWorkQueueTransition,
  WORK_QUEUE_STATES
} from "../workflow/state-machine/work-queue/state-machine.ts";
import { asInt, getPolicy, nowFrom, parseJson, rowToWorkItem, toText } from "./store-serialization.ts";
import { WorkQueueCapacityError } from "./scheduling.ts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

interface WorkItemRow extends QueryResultRow {
  work_item_id: string; queue_definition_id: string; queue_definition_version: number;
  state: string; lease_id: string; lease_seq: number; leased_by_worker_id: string;
  lease_expires_at_ms: number; policy_version: string; available_at_ms: number;
  attempt: number; max_attempts: number; fallback_task_id: string;
  last_error_json: unknown; updated_at_ms: number;
}
interface QueuePolicySection { [key: string]: number; }
interface RetryPolicySection { [key: string]: string | number; }
interface QueuePolicy {
  [key: string]: unknown;
  capacity: QueuePolicySection; retention: QueuePolicySection; retryBackoff?: RetryPolicySection;
  policyVersion?: string;
}
interface RuntimeIdentityGenerator { journalEntryId(): string; }
interface RuntimeTimeSource { nowMs(): number; }
interface RuntimeConfig {
  timeSource: RuntimeTimeSource; identityGenerator: RuntimeIdentityGenerator; resolvedPolicy: QueuePolicy;
}
interface CountRow extends QueryResultRow { count: string | number; }
interface SequenceRow extends QueryResultRow { seq: string | number; last_transition_seq: string | number; }
interface PolicyRow extends QueryResultRow { policy_json: unknown; }
interface RetentionStateRow extends QueryResultRow { pending_transitions: string | number; }
interface SinkReceiptRow extends QueryResultRow { sink_id: string; effect_id: string; status: string; }
type WorkItemPatch = Partial<WorkItemRow>;
interface TransitionInput {
  row: WorkItemRow; transition: string; toState: string; patch?: WorkItemPatch;
  nowMs: number; operationId?: unknown; actor?: object; reason?: unknown; policyVersion?: unknown;
}
interface AppendTransitionInput extends TransitionInput {
  fromState?: string | null; leaseId?: string; leaseSeq?: number; decision?: object;
}
interface SweepInput {
  nowMs: number; queueDefinitionId?: unknown; scopeKey?: unknown; workItemId?: unknown; limit?: unknown;
}
interface BackgroundWriteInput {
  nowMs?: unknown; entityId?: unknown; workItemId?: unknown; snapshotId?: unknown; healthKey?: unknown;
  backgroundWriteId?: unknown; state?: unknown; value?: unknown; status?: unknown; attempt?: unknown;
  nextRetryAtMs?: unknown; lastError?: unknown;
}

export async function queryOne<Row extends QueryResultRow = QueryResultRow>(
  client: Pick<PoolClient, "query">,
  sql: string,
  params: readonly unknown[] = []
): Promise<Row | null> {
  const result = await client.query<Row>(sql, [...params]);
  return result.rows[0] || null;
}

export async function withTransaction<Result>(
  pool: Pick<Pool, "connect">,
  fn: (client: PoolClient) => Promise<Result>
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresWorkQueueRuntime({ timeSource, identityGenerator, resolvedPolicy }: RuntimeConfig) {
  async function policyForRow(client: PoolClient, row: WorkItemRow): Promise<QueuePolicy> {
    const definition = await queryOne<PolicyRow>(client, `
      SELECT policy_json FROM queue_definitions
      WHERE queue_definition_id = $1 AND queue_definition_version = $2
    `, [row.queue_definition_id, row.queue_definition_version]);
    const override = parseJson(definition?.policy_json, {}) as Partial<QueuePolicy>;
    return getPolicy({
      ...resolvedPolicy,
      ...override,
      capacity: { ...resolvedPolicy.capacity, ...override.capacity },
      retention: { ...resolvedPolicy.retention, ...override.retention }
    });
  }

  async function lockQueueRetention(client: PoolClient, queueDefinitionId?: unknown): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [String(queueDefinitionId || "")]
    );
  }

  async function boundedCount(client: PoolClient, sql: string, params: readonly unknown[], limit: unknown): Promise<number> {
    const row = await queryOne<CountRow>(client, sql, [...params, Number(limit) + 1]);
    return Number(row?.count || 0);
  }

  async function insertRetentionSnapshot(client: PoolClient, row: WorkItemRow, nowMs: number): Promise<number> {
    await client.query("DELETE FROM work_queue_transition_journal WHERE work_item_id = $1", [row.work_item_id]);
    const inserted = await queryOne<SequenceRow>(client, `
      INSERT INTO work_queue_transition_journal (
        journal_entry_id, work_item_id, queue_definition_id, queue_definition_version,
        transition, from_state, to_state, lease_id, lease_seq, operation_id,
        actor_json, reason, policy_version, decision_json, created_at_ms, adopted_time_ms
      ) VALUES ($1,$2,$3,$4,'retention_snapshot',NULL,$5,$6,$7,$8,'{}'::jsonb,$9,$10,$11::jsonb,$12,$12)
      RETURNING seq
    `, [
      identityGenerator.journalEntryId(),
      row.work_item_id,
      row.queue_definition_id,
      row.queue_definition_version,
      row.state,
      row.lease_id || "",
      Number(row.lease_seq || 0),
      "work_queue.retention.snapshot",
      "bounded_journal_compaction",
      row.policy_version || "",
      JSON.stringify({ projectionRow: row }),
      nowMs
    ]);
    const seq = Number(inserted?.seq || 0);
    await client.query(
      "UPDATE work_items SET last_transition_seq = $1, updated_at_ms = $2 WHERE work_item_id = $3",
      [seq, nowMs, row.work_item_id]
    );
    return seq;
  }

  async function compactWorkJournal(client: PoolClient, workItemId: unknown, nowMs: number, { force = false }: { force?: boolean } = {}): Promise<boolean> {
    const countRow = await queryOne<CountRow>(client, `
      SELECT COUNT(*) AS count FROM work_queue_transition_journal WHERE work_item_id = $1
    `, [workItemId]);
    const row = await queryOne<WorkItemRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE SKIP LOCKED", [workItemId]);
    if (!row) return false;
    const { retention } = await policyForRow(client, row);
    const count = Number(countRow?.count || 0);
    if (count <= 1 || (!force && count <= retention.maxTransitionsPerWorkItem)) return false;
    await insertRetentionSnapshot(client, row, nowMs);
    return true;
  }

  async function deleteTerminalRows(client: PoolClient, queueDefinitionId: unknown, excludeWorkItemId: unknown, limit: unknown): Promise<number> {
    const selected = await client.query<Pick<WorkItemRow, "work_item_id">>(`
      SELECT work_item_id FROM work_items
      WHERE queue_definition_id = $1
        AND state = ANY($2::text[])
        AND work_item_id <> $3
      ORDER BY updated_at_ms ASC, work_item_id ASC
      LIMIT $4
      FOR UPDATE SKIP LOCKED
    `, [queueDefinitionId, [
      WORK_QUEUE_STATES.COMPLETED,
      WORK_QUEUE_STATES.CANCELLED,
      WORK_QUEUE_STATES.EXPIRED
    ], excludeWorkItemId || "", Math.max(0, Number(limit) || 0)]);
    const ids = selected.rows.map((row) => row.work_item_id);
    if (ids.length === 0) return 0;
    await client.query("DELETE FROM work_queue_fallback_tasks WHERE work_item_id = ANY($1::text[])", [ids]);
    await client.query("DELETE FROM work_queue_transition_journal WHERE work_item_id = ANY($1::text[])", [ids]);
    await client.query("DELETE FROM work_items WHERE work_item_id = ANY($1::text[])", [ids]);
    return ids.length;
  }

  function retentionMaintenanceThreshold(retention: QueuePolicySection): number {
    return Math.max(1, Math.min(
      asInt(retention.cleanupBatchSize, 1),
      asInt(retention.maxTransitionsPerWorkItem, 1),
      asInt(retention.maxJournalEntries, 1)
    ));
  }

  async function maintainRetentionAfterAppend(client: PoolClient, row: WorkItemRow, nowMs: number): Promise<boolean> {
    const { retention } = await policyForRow(client, row);
    const threshold = retentionMaintenanceThreshold(retention);
    const state = await queryOne<RetentionStateRow>(client, `
      INSERT INTO work_queue_retention_state (
        queue_definition_id, pending_transitions, updated_at_ms
      ) VALUES ($1, 1, $2)
      ON CONFLICT(queue_definition_id) DO UPDATE SET
        pending_transitions = work_queue_retention_state.pending_transitions + 1,
        updated_at_ms = EXCLUDED.updated_at_ms
      RETURNING pending_transitions
    `, [row.queue_definition_id, nowMs]);
    if (Number(state?.pending_transitions || 0) < threshold) return false;
    await lockQueueRetention(client, row.queue_definition_id);
    await client.query(`
      UPDATE work_queue_retention_state
      SET pending_transitions = 0, updated_at_ms = $2
      WHERE queue_definition_id = $1 AND pending_transitions >= $3
    `, [row.queue_definition_id, nowMs, threshold]);
    const terminalCount = await boundedCount(client, `
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM work_items
        WHERE queue_definition_id = $1 AND state = ANY($2::text[])
        LIMIT $3
      ) bounded
    `, [row.queue_definition_id, [
      WORK_QUEUE_STATES.COMPLETED,
      WORK_QUEUE_STATES.CANCELLED,
      WORK_QUEUE_STATES.EXPIRED
    ]], retention.maxTerminalItems);
    if (terminalCount > retention.maxTerminalItems) {
      await deleteTerminalRows(
        client,
        row.queue_definition_id,
        row.work_item_id,
        Math.min(retention.cleanupBatchSize, terminalCount - retention.maxTerminalItems)
      );
    }
    const countJournal = () => boundedCount(client, `
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM work_queue_transition_journal
        WHERE queue_definition_id = $1
        LIMIT $2
      ) bounded
    `, [row.queue_definition_id], retention.maxJournalEntries);
    let journalCount = await countJournal();
    if (journalCount >= retention.maxJournalEntries) {
      await deleteTerminalRows(client, row.queue_definition_id, row.work_item_id, retention.cleanupBatchSize);
      journalCount = await countJournal();
    }
    if (journalCount >= retention.maxJournalEntries) {
      const candidates = await client.query<Pick<WorkItemRow, "work_item_id">>(`
        SELECT work_item_id FROM work_queue_transition_journal
        WHERE queue_definition_id = $1 AND work_item_id <> $2
        ORDER BY seq ASC
        LIMIT $3
      `, [
        row.queue_definition_id,
        row.work_item_id,
        retention.cleanupBatchSize * retention.maxTransitionsPerWorkItem
      ]);
      const unique = new Set(candidates.rows.map((candidate) => candidate.work_item_id));
      for (const workItemId of [...unique].slice(0, retention.cleanupBatchSize)) {
        await compactWorkJournal(client, workItemId, nowMs, { force: true });
      }
      journalCount = await countJournal();
    }
    if (journalCount >= retention.maxJournalEntries) {
      const current = await queryOne<CountRow>(client, `
        SELECT COUNT(*) AS count FROM work_queue_transition_journal WHERE work_item_id = $1
      `, [row.work_item_id]);
      if (Number(current?.count || 0) > 1 && await compactWorkJournal(client, row.work_item_id, nowMs, { force: true })) return true;
      throw new WorkQueueCapacityError("queue_journal_retention", retention.maxJournalEntries);
    }
    return false;
  }

  async function makeFailedCapacityRoom(client: PoolClient, row: WorkItemRow, _nowMs: number): Promise<void> {
    const { capacity, retention } = await policyForRow(client, row);
    await lockQueueRetention(client, row.queue_definition_id);
    const countFailed = () => boundedCount(client, `
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM work_items
        WHERE queue_definition_id = $1 AND state = $2
        LIMIT $3
      ) bounded
    `, [row.queue_definition_id, WORK_QUEUE_STATES.FAILED], capacity.maxFailed);
    let failedCount = await countFailed();
    if (failedCount < capacity.maxFailed) return;
    const selected = await client.query<WorkItemRow>(`
      SELECT * FROM work_items
      WHERE queue_definition_id = $1 AND state = $2 AND work_item_id <> $3
      ORDER BY updated_at_ms ASC, work_item_id ASC
      LIMIT $4
      FOR UPDATE SKIP LOCKED
    `, [
      row.queue_definition_id,
      WORK_QUEUE_STATES.FAILED,
      row.work_item_id,
      Math.min(retention.cleanupBatchSize, failedCount - capacity.maxFailed + 1)
    ]);
    for (const candidate of selected.rows) {
      await client.query("DELETE FROM work_queue_fallback_tasks WHERE work_item_id = $1", [candidate.work_item_id]);
      await client.query("DELETE FROM work_queue_transition_journal WHERE work_item_id = $1", [candidate.work_item_id]);
      await client.query("DELETE FROM work_items WHERE work_item_id = $1", [candidate.work_item_id]);
    }
    failedCount = await countFailed();
    if (failedCount >= capacity.maxFailed) {
      throw new WorkQueueCapacityError("queue_failed_retained", capacity.maxFailed);
    }
  }

  async function appendTransitionInternal(client: PoolClient, {
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
  }: AppendTransitionInput): Promise<number> {
    assertLegalWorkQueueTransition({ transition, fromState: fromState ?? null, toState });
    const inserted = await queryOne<SequenceRow>(client, `
      INSERT INTO work_queue_transition_journal (
        journal_entry_id, work_item_id, queue_definition_id, queue_definition_version,
        transition, from_state, to_state, lease_id, lease_seq, operation_id,
        actor_json, reason, policy_version, decision_json, created_at_ms, adopted_time_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb,$15,$16)
      RETURNING seq
    `, [
      identityGenerator.journalEntryId(),
      row.work_item_id,
      row.queue_definition_id,
      row.queue_definition_version,
      transition,
      fromState ?? null,
      toState,
      leaseId ?? row.lease_id ?? "",
      leaseSeq ?? row.lease_seq ?? 0,
      toText(operationId),
      JSON.stringify(actor || {}),
      toText(reason),
      toText(policyVersion || row.policy_version),
      JSON.stringify(decision || {}),
      nowMs,
      nowMs
    ]);
    const seq = Number(inserted?.seq || 0);
    await client.query(`
      UPDATE work_items
      SET last_transition_seq = $1,
          updated_at_ms = $2
      WHERE work_item_id = $3
    `, [seq, nowMs, row.work_item_id]);
    if (await maintainRetentionAfterAppend(client, row, nowMs)) {
      const current = await queryOne<SequenceRow>(client, "SELECT last_transition_seq FROM work_items WHERE work_item_id = $1", [row.work_item_id]);
      return Number(current?.last_transition_seq || seq);
    }
    return seq;
  }

  async function applyProjectionPatch(client: PoolClient, row: WorkItemRow, patch: WorkItemPatch = {}): Promise<WorkItemRow> {
    const updated: WorkItemRow = {
      ...row,
      ...patch,
      work_item_id: row.work_item_id,
      queue_definition_id: row.queue_definition_id,
      queue_definition_version: row.queue_definition_version
    };
    const result = await queryOne<WorkItemRow>(client, `
      UPDATE work_items
      SET state = $2,
          available_at_ms = $3,
          attempt = $4,
          max_attempts = $5,
          lease_id = $6,
          lease_seq = $7,
          leased_by_worker_id = $8,
          lease_expires_at_ms = $9,
          fallback_task_id = $10,
          last_error_json = $11::jsonb,
          updated_at_ms = $12
      WHERE work_item_id = $1
      RETURNING *
    `, [
      updated.work_item_id,
      updated.state,
      updated.available_at_ms,
      updated.attempt,
      updated.max_attempts,
      updated.lease_id || "",
      updated.lease_seq || 0,
      updated.leased_by_worker_id || "",
      updated.lease_expires_at_ms || 0,
      updated.fallback_task_id || "",
      JSON.stringify(parseJson(updated.last_error_json, {})),
      updated.updated_at_ms
    ]);
    if (!result) throw new Error(`Work item projection disappeared: ${row.work_item_id}`);
    return result;
  }

  async function transitionProjection(client: PoolClient, { row, transition, toState, patch = {}, nowMs, operationId, actor, reason, policyVersion }: TransitionInput): Promise<WorkItemRow> {
    if (toState === WORK_QUEUE_STATES.FAILED && row.state !== WORK_QUEUE_STATES.FAILED) {
      await makeFailedCapacityRoom(client, row, nowMs);
    }
    const fromState = row.state;
    const journalLeaseId = transition === "claim" ? patch.lease_id : row.lease_id || patch.lease_id || "";
    const journalLeaseSeq = transition === "claim" ? patch.lease_seq : row.lease_seq || patch.lease_seq || 0;
    const nextRow = await applyProjectionPatch(client, row, { ...patch, state: toState, updated_at_ms: nowMs });
    await appendTransitionInternal(client, {
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
    const result = await queryOne<WorkItemRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1", [row.work_item_id]);
    if (!result) throw new Error(`Work item projection disappeared: ${row.work_item_id}`);
    return result;
  }

  async function recordBackgroundWriteInternal(client: PoolClient, aspectType: unknown, input: BackgroundWriteInput = {}) {
    const nowMs = nowFrom(timeSource, input.nowMs);
    const entityId = toText(input.entityId || input.workItemId || input.snapshotId || input.healthKey || aspectType);
    const backgroundWriteId = toText(input.backgroundWriteId || `${aspectType}:${entityId}`);
    await client.query(`
      INSERT INTO work_queue_background_writes (
        background_write_id, aspect_type, entity_id, state_json, status,
        attempt, next_retry_at_ms, last_error_json, created_at_ms, updated_at_ms
      ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9,$10)
      ON CONFLICT(background_write_id) DO UPDATE SET
        aspect_type = EXCLUDED.aspect_type,
        entity_id = EXCLUDED.entity_id,
        state_json = EXCLUDED.state_json,
        status = EXCLUDED.status,
        attempt = EXCLUDED.attempt,
        next_retry_at_ms = EXCLUDED.next_retry_at_ms,
        last_error_json = EXCLUDED.last_error_json,
        updated_at_ms = EXCLUDED.updated_at_ms
    `, [
      backgroundWriteId,
      aspectType,
      entityId,
      JSON.stringify(input.state || input.value || input || {}),
      toText(input.status || "committed"),
      asInt(input.attempt, 0),
      asInt(input.nextRetryAtMs, 0),
      JSON.stringify(input.lastError || {}),
      nowMs,
      nowMs
    ]);
    return { backgroundWriteId, aspectType, entityId, committedAtMs: nowMs };
  }

  async function expireEligibleLocked(client: PoolClient, { nowMs, queueDefinitionId = "", scopeKey = "", limit = 1000 }: SweepInput): Promise<unknown[]> {
    const rows = (await client.query<WorkItemRow>(`
      SELECT *
      FROM work_items
      WHERE state = ANY($1::text[])
        AND expires_at_ms > 0
        AND expires_at_ms <= $2
        AND ($3 = '' OR queue_definition_id = $3)
        AND ($4 = '' OR scope_key = $4)
      ORDER BY expires_at_ms ASC, created_at_ms ASC
      LIMIT $5
      FOR UPDATE SKIP LOCKED
    `, [[
      WORK_QUEUE_STATES.QUEUED,
      WORK_QUEUE_STATES.RETRY_WAIT,
      WORK_QUEUE_STATES.RUNNING,
      WORK_QUEUE_STATES.RECOVERED
    ], nowMs, toText(queueDefinitionId), toText(scopeKey), Math.max(1, asInt(limit, 1000))])).rows;
    const expired: unknown[] = [];
    for (const row of rows) {
      const updated = await transitionProjection(client, {
        row,
        transition: "expire",
        toState: String(WORK_QUEUE_STATES.EXPIRED),
        patch: {
          available_at_ms: nowMs,
          lease_id: "",
          leased_by_worker_id: "",
          lease_expires_at_ms: 0
        },
        nowMs,
        reason: "work_deadline_reached"
      });
      expired.push(rowToWorkItem(updated));
    }
    return expired;
  }

  async function materializeDelayedLocked(client: PoolClient, { nowMs, queueDefinitionId = "", scopeKey = "", limit = 1000 }: SweepInput): Promise<unknown[]> {
    const result = await client.query<WorkItemRow>(`
      SELECT *
      FROM work_items
      WHERE state = $1
        AND available_at_ms <= $2
        AND ($3 = '' OR queue_definition_id = $3)
        AND ($4 = '' OR scope_key = $4)
      ORDER BY available_at_ms ASC, created_at_ms ASC
      LIMIT $5
      FOR UPDATE SKIP LOCKED
    `, [WORK_QUEUE_STATES.RETRY_WAIT, nowMs, toText(queueDefinitionId), toText(scopeKey), Math.max(1, asInt(limit, 1000))]);
    const changed: unknown[] = [];
    for (const row of result.rows) {
      const updated = await transitionProjection(client, {
        row,
        transition: "delay_matured",
        toState: String(WORK_QUEUE_STATES.QUEUED),
        patch: { available_at_ms: nowMs, lease_id: "", leased_by_worker_id: "", lease_expires_at_ms: 0 },
        nowMs,
        reason: "delay_matured"
      });
      changed.push(rowToWorkItem(updated));
    }
    return changed;
  }

  async function recoverExpiredLeasesLocked(client: PoolClient, { nowMs, queueDefinitionId = "", scopeKey = "", limit = 1000 }: SweepInput): Promise<unknown[]> {
    const result = await client.query<WorkItemRow>(`
      SELECT *
      FROM work_items
      WHERE state = $1
        AND lease_expires_at_ms > 0
        AND lease_expires_at_ms <= $2
        AND ($3 = '' OR queue_definition_id = $3)
        AND ($4 = '' OR scope_key = $4)
      ORDER BY lease_expires_at_ms ASC, created_at_ms ASC
      LIMIT $5
      FOR UPDATE SKIP LOCKED
    `, [WORK_QUEUE_STATES.RUNNING, nowMs, toText(queueDefinitionId), toText(scopeKey), Math.max(1, asInt(limit, 1000))]);
    const recovered: unknown[] = [];
    for (const row of result.rows) {
      const updated = await transitionProjection(client, {
        row,
        transition: "lease_expired",
        toState: String(WORK_QUEUE_STATES.IN_DOUBT),
        patch: {
          last_error_json: {
            type: "lease_expired",
            leaseId: row.lease_id,
            workerId: row.leased_by_worker_id,
            expiredAtMs: nowMs
          }
        },
        nowMs,
        reason: "lease_expired_unconfirmed"
      });
      recovered.push(rowToWorkItem(updated));
    }
    return recovered;
  }

  async function reconcileInDoubtLocked(client: PoolClient, { nowMs, queueDefinitionId = "", scopeKey = "", workItemId = "", limit = 1000 }: SweepInput): Promise<unknown[]> {
    const result = await client.query<WorkItemRow>(`
      SELECT *
      FROM work_items
      WHERE state = $1
        AND ($2 = '' OR queue_definition_id = $2)
        AND ($3 = '' OR scope_key = $3)
        AND ($4 = '' OR work_item_id = $4)
      ORDER BY lease_expires_at_ms ASC, created_at_ms ASC
      LIMIT $5
      FOR UPDATE SKIP LOCKED
    `, [WORK_QUEUE_STATES.IN_DOUBT, toText(queueDefinitionId), toText(scopeKey), toText(workItemId), Math.max(1, asInt(limit, 1000))]);
    const reconciled: unknown[] = [];
    for (const row of result.rows) {
      const receipts = await client.query<SinkReceiptRow>(`
        SELECT sink_id, effect_id, status
        FROM work_queue_sink_fences
        WHERE work_item_id = $1 AND generation = $2
        ORDER BY sink_id ASC
      `, [row.work_item_id, Number(row.lease_seq || 0)]);
      const terminalReceipt = receipts.rows.find((receipt) =>
        ["complete", "fail"].includes(String(receipt.sink_id || "")) &&
        String(receipt.status || "") === "settled"
      );
      if (!terminalReceipt) {
        continue;
      }
      const toState = String(terminalReceipt.sink_id === "complete"
        ? WORK_QUEUE_STATES.COMPLETED
        : WORK_QUEUE_STATES.FAILED);
      const updated = await transitionProjection(client, {
        row,
        transition: "termination_acknowledged",
        toState,
        patch: {
          available_at_ms: nowMs,
          lease_id: "",
          leased_by_worker_id: "",
          lease_expires_at_ms: 0,
          last_error_json: {
            type: "sink_receipt_reconciled",
            sinkId: terminalReceipt.sink_id,
            effectId: terminalReceipt.effect_id || "",
            generation: Number(row.lease_seq || 0)
          }
        },
        nowMs,
        reason: "sink_receipt_reconciled"
      });
      reconciled.push(rowToWorkItem(updated));
    }
    return reconciled;
  }

  async function requireLeasedRow(client: PoolClient, workItemId: unknown, leaseId: unknown, nowMs = timeSource.nowMs(), { allowExpired = false }: { allowExpired?: boolean } = {}): Promise<WorkItemRow> {
    const row = await queryOne<WorkItemRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(workItemId)]);
    if (!row) {
      throw new Error(`Work item not found: ${workItemId}`);
    }
    if (row.state !== WORK_QUEUE_STATES.RUNNING) {
      throw new Error(`Work item ${workItemId} is not leased.`);
    }
    if (!leaseId || row.lease_id !== leaseId) {
      throw new Error(`Lease fence rejected for work item ${workItemId}.`);
    }
    if (!allowExpired && Number(row.lease_expires_at_ms || 0) > 0 && Number(row.lease_expires_at_ms || 0) <= nowMs) {
      throw new Error(`Lease expired for work item ${workItemId}.`);
    }
    return row;
  }

  return {
    appendTransitionInternal,
    transitionProjection,
    recordBackgroundWriteInternal,
    expireEligibleLocked,
    materializeDelayedLocked,
    recoverExpiredLeasesLocked,
    reconcileInDoubtLocked,
    requireLeasedRow
  };
}
