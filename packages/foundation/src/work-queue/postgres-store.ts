import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig, QueryResultRow } from "pg";

import { queueIdentityGenerator } from "./identity.ts";
import { computeDeterministicRetryDelay, DEFAULT_QUEUE_POLICY } from "./policies.ts";
import {
  assertLegalWorkQueueTransition,
  isTerminalWorkQueueState,
  WORK_QUEUE_STATES
} from "../workflow/state-machine/work-queue/state-machine.ts";
import { systemQueueTimeSource, type QueueTimeSource } from "./time-source.ts";
import { ensurePostgresWorkQueueSchema } from "./postgres-schema.ts";
import {
  createPostgresWorkQueueRuntime,
  queryOne,
  withTransaction
} from "./postgres-store-runtime.ts";
import {
  asArray,
  asInt,
  asObject,
  asPositiveInt,
  assertDedupeFingerprint,
  getPolicy,
  journalRowToTransition,
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

const { Pool } = pg;
type WorkItemProjectionColumn = typeof WORK_ITEM_PROJECTION_COLUMNS[number];
interface WorkItemProjectionRow extends QueryResultRow {
  work_item_id: string; queue_definition_id: string; queue_definition_version: number;
  scope_key: string; scope_json: unknown; dedupe_key: string; state: string;
  owner_ref_json: unknown; payload_ref_json: unknown; payload_kind: string;
  priority: number; priority_class: string; tenant_id: string; workspace_id: string;
  project_id: string; available_at_ms: number; expires_at_ms: number; attempt: number;
  max_attempts: number; lease_id: string; lease_seq: number; leased_by_worker_id: string;
  lease_expires_at_ms: number; concurrency_key: string; route_version: string;
  policy_version: string; fallback_task_id: string; last_error_json: unknown;
  checkpoint_ref_json: unknown; checkpoint_digest: string; checkpoint_seq: number;
  checkpoint_updated_at_ms: number; last_transition_seq: number; created_at_ms: number;
  updated_at_ms: number;
}
interface CountRow extends QueryResultRow { count: string | number; total: string | number; }
interface PolicyRow extends QueryResultRow { policy_json: unknown; }
interface QueueHierarchy { tenantId: string; workspaceId: string; projectId: string; }
interface NumericPolicySection { [key: string]: number; }
interface RetryPolicy {
  initialDelayMs: number; multiplier: number; maxDelayMs: number; maxJitterBps: number; retrySeed: string;
}
interface QueuePolicy {
  [key: string]: unknown;
  capacity: NumericPolicySection; fairness: NumericPolicySection; retention: NumericPolicySection;
  retryBackoff: RetryPolicy; leaseTimeoutMs: number;
  maxAttempts: number; policyVersion: string;
  fallbackRetry: NumericPolicySection;
}
interface VirtualFinishKey extends QueueHierarchy {
  queueDefinitionId: string; queueDefinitionVersion: number; selectorScopeKey: string; priorityClass: string;
}
interface TransitionCommand {
  row: WorkItemProjectionRow; transition: string; toState: string; patch?: Partial<WorkItemProjectionRow>;
  nowMs: number; operationId?: unknown; actor?: object; reason?: unknown; policyVersion?: unknown;
}
interface QueueCommandInput {
  [key: string]: unknown;
  nowMs?: unknown; entityId?: unknown; workItemId?: unknown; snapshotId?: unknown;
  healthKey?: unknown; backgroundWriteId?: unknown; state?: unknown; value?: unknown;
  status?: unknown; attempt?: unknown; nextRetryAtMs?: unknown; lastError?: unknown;
  scope?: Record<string, unknown>; schedulingScope?: Record<string, unknown>;
  actor?: Record<string, unknown>; route?: { version?: unknown };
  queueDefinition?: Record<string, unknown>;
}
interface QueueControlRow extends QueryResultRow { mode: string; reason: string; updated_at_ms: number; }
interface FullQueueControlRow extends QueueControlRow { queue_definition_id: string; scope_key: string; actor_json: unknown; }
interface StateCountRow extends QueryResultRow { state: string; count: string | number; }
interface TerminalTransitionRow extends QueryResultRow { transition: string; lease_id: string; lease_seq: number; }
interface QueueOperationError extends Error {
  code?: string; expectedCheckpointSeq?: number; actualCheckpointSeq?: number;
}
interface JournalEvent {
  seq: number; workItemId: string; transition: string; toState: string;
  decision: { projectionRow?: WorkItemProjectionRow; projectionPatch?: Record<string, unknown> };
}
interface JournalRow extends QueryResultRow {
  seq: string | number; journal_entry_id: string; work_item_id: string; queue_definition_id: string;
  queue_definition_version: string | number; transition: string; from_state: string | null; to_state: string;
  lease_id: string; lease_seq: string | number; operation_id: string; actor_json: unknown; reason: string;
  policy_version: string; decision_json: unknown; created_at_ms: string | number; adopted_time_ms: string | number;
}

function postgresErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireProjectionRow(value: unknown): WorkItemProjectionRow {
  if (!value || typeof value !== "object") {
    throw new Error("Work item projection is unavailable.");
  }
  const row = value as Partial<WorkItemProjectionRow>;
  if (!row.work_item_id || !row.queue_definition_id || !row.state) {
    throw new Error("Work item projection is incomplete.");
  }
  return row as WorkItemProjectionRow;
}

const WORK_ITEM_PROJECTION_COLUMNS = Object.freeze([
  "work_item_id", "queue_definition_id", "queue_definition_version", "scope_key", "scope_json",
  "dedupe_key", "state", "owner_ref_json", "payload_ref_json", "payload_kind", "priority",
  "priority_class", "tenant_id", "workspace_id", "project_id",
  "available_at_ms", "expires_at_ms", "attempt", "max_attempts", "lease_id", "lease_seq",
  "leased_by_worker_id", "lease_expires_at_ms", "concurrency_key", "route_version",
  "policy_version", "fallback_task_id", "last_error_json", "checkpoint_ref_json",
  "checkpoint_digest", "checkpoint_seq", "checkpoint_updated_at_ms", "last_transition_seq",
  "created_at_ms", "updated_at_ms"
] as const);
const WORK_ITEM_JSON_COLUMNS: ReadonlySet<WorkItemProjectionColumn> = new Set([
  "scope_json", "owner_ref_json", "payload_ref_json", "last_error_json", "checkpoint_ref_json"
]);

function sqlValues(row: Partial<Record<WorkItemProjectionColumn, unknown>>, columns: readonly WorkItemProjectionColumn[]): unknown[] {
  return columns.map((column) => row[column]);
}

function insertPlaceholders(columns: readonly WorkItemProjectionColumn[], offset = 0): string {
  return columns.map((column, index) =>
    `$${index + offset + 1}${WORK_ITEM_JSON_COLUMNS.has(column) ? "::jsonb" : ""}`
  ).join(", ");
}

export async function createPostgresWorkQueueStore({
  connectionString = process.env.MESHRIX_WORK_QUEUE_POSTGRES_URL || process.env.DATABASE_URL || "",
  pool = null,
  poolOptions = {},
  timeSource = systemQueueTimeSource,
  identityGenerator = queueIdentityGenerator,
  policy = DEFAULT_QUEUE_POLICY
}: {
  connectionString?: string;
  pool?: PgPool | null;
  poolOptions?: PoolConfig;
  timeSource?: QueueTimeSource;
  identityGenerator?: typeof queueIdentityGenerator;
  policy?: Record<string, unknown>;
} = {}) {
  const resolvedPolicy: QueuePolicy = getPolicy(policy);
  const database = pool || new Pool({
    connectionString: connectionString || undefined,
    max: Number(poolOptions.max || process.env.MESHRIX_WORK_QUEUE_POSTGRES_POOL_MAX || 10),
    idleTimeoutMillis: Number(poolOptions.idleTimeoutMillis || 30_000),
    connectionTimeoutMillis: Number(poolOptions.connectionTimeoutMillis || 10_000),
    ...poolOptions
  });
  const ownsPool = !pool;
  await ensurePostgresWorkQueueSchema(database);

  const {
    appendTransitionInternal,
    transitionProjection: transitionProjectionInternal,
    recordBackgroundWriteInternal,
    expireEligibleLocked,
    materializeDelayedLocked,
    recoverExpiredLeasesLocked,
    reconcileInDoubtLocked,
    requireLeasedRow
  } = createPostgresWorkQueueRuntime({
    timeSource,
    identityGenerator,
    resolvedPolicy: {
      capacity: resolvedPolicy.capacity,
      retention: resolvedPolicy.retention
    }
  });

  async function cleanupVirtualFinishIfIdle(client: PoolClient, row?: WorkItemProjectionRow | null): Promise<void> {
    if (!row || !isTerminalWorkQueueState(row.state)) return;
    const remaining = await queryOne<QueryResultRow>(client, `
      SELECT 1
      FROM work_items
      WHERE queue_definition_id = $1
        AND scope_key = $2
        AND state <> ALL($3::text[])
      LIMIT 1
    `, [
      row.queue_definition_id,
      row.scope_key,
      [WORK_QUEUE_STATES.COMPLETED, WORK_QUEUE_STATES.CANCELLED, WORK_QUEUE_STATES.EXPIRED]
    ]);
    if (!remaining) {
      await client.query(`
        DELETE FROM work_queue_virtual_finish
        WHERE queue_definition_id = $1 AND selector_scope_key = $2
      `, [row.queue_definition_id, row.scope_key]);
    }
  }

  async function transitionProjection(client: PoolClient, input: TransitionCommand): Promise<WorkItemProjectionRow> {
    const updated = await transitionProjectionInternal(client, input) as WorkItemProjectionRow;
    await cleanupVirtualFinishIfIdle(client, updated);
    return updated;
  }

  async function boundedCount(client: PoolClient, {
    queueDefinitionId,
    states,
    tenantId = "",
    workspaceId = "",
    projectId = "",
    limit
  }: { queueDefinitionId: unknown; states: readonly unknown[]; tenantId?: string; workspaceId?: string; projectId?: string; limit: unknown }): Promise<number> {
    const row = await queryOne<CountRow>(client, `
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM work_items
        WHERE queue_definition_id = $1
          AND state = ANY($2::text[])
          AND ($3 = '' OR tenant_id = $3)
          AND ($4 = '' OR workspace_id = $4)
          AND ($5 = '' OR project_id = $5)
        LIMIT $6
      ) bounded
    `, [queueDefinitionId, states, tenantId, workspaceId, projectId, Number(limit) + 1]);
    return Number(row?.count || 0);
  }

  async function assertAdmissionCapacity(client: PoolClient, { queueDefinitionId, hierarchy, state, policy }: {
    queueDefinitionId: unknown; hierarchy: QueueHierarchy; state: unknown; policy: QueuePolicy;
  }): Promise<void> {
    const capacity = policy.capacity;
    const states: unknown[] = [
      WORK_QUEUE_STATES.QUEUED,
      WORK_QUEUE_STATES.RETRY_WAIT,
      WORK_QUEUE_STATES.RUNNING,
      WORK_QUEUE_STATES.RECOVERED
    ];
    const checks: Array<readonly [string, number, Partial<QueueHierarchy>]> = [
      ["queue_outstanding", capacity.maxOutstanding, {}],
      ["tenant_outstanding", capacity.maxOutstandingPerTenant, { tenantId: hierarchy.tenantId }],
      ["workspace_outstanding", capacity.maxOutstandingPerWorkspace, {
        tenantId: hierarchy.tenantId,
        workspaceId: hierarchy.workspaceId
      }],
      ["project_outstanding", capacity.maxOutstandingPerProject, hierarchy]
    ];
    for (const [reason, limit, scope] of checks) {
      assertCapacityBelow({
        count: await boundedCount(client, { queueDefinitionId, states, ...scope, limit }),
        limit,
        reason
      });
    }
    if (state === WORK_QUEUE_STATES.RETRY_WAIT) {
      assertCapacityBelow({
        count: await boundedCount(client, {
          queueDefinitionId,
          states: [WORK_QUEUE_STATES.RETRY_WAIT],
          limit: capacity.maxDelayed
        }),
        limit: capacity.maxDelayed,
        reason: "queue_delayed"
      });
    }
  }

  async function lockQueueCapacity(client: PoolClient, queueDefinitionId?: unknown): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [String(queueDefinitionId || "")]
    );
  }

  async function advanceVirtualFinish(client: PoolClient, key: VirtualFinishKey, nowMs: number): Promise<void> {
    await client.query(`
      UPDATE work_queue_virtual_finish
      SET virtual_finish = virtual_finish + 1, updated_at_ms = $8
      WHERE queue_definition_id = $1
        AND queue_definition_version = $2
        AND selector_scope_key = $3
        AND priority_class = $4
        AND tenant_id = $5
        AND workspace_id = $6
        AND project_id = $7
    `, [
      key.queueDefinitionId,
      key.queueDefinitionVersion,
      key.selectorScopeKey,
      key.priorityClass,
      key.tenantId,
      key.workspaceId,
      key.projectId,
      nowMs
    ]);
  }

  async function virtualFinishCursor(client: PoolClient, { queueDefinitionId, queueDefinitionVersion, selectorScopeKey }: {
    queueDefinitionId: unknown; queueDefinitionVersion: unknown; selectorScopeKey: unknown;
  }): Promise<number> {
    const row = await queryOne<CountRow>(client, `
      SELECT COALESCE(SUM(virtual_finish), 0)::bigint AS total
      FROM work_queue_virtual_finish
      WHERE queue_definition_id = $1
        AND selector_scope_key = $2
        AND ($3::integer = 0 OR queue_definition_version = $3)
    `, [queueDefinitionId, selectorScopeKey, queueDefinitionVersion]);
    return Number(row?.total || 0) % WORK_QUEUE_PRIORITY_CYCLE.length;
  }

  async function policyForWorkItem(client: PoolClient, row: WorkItemProjectionRow): Promise<QueuePolicy> {
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

  async function promoteAgedCandidates(client: PoolClient, { queueDefinitionId, queueDefinitionVersion, scopeKey, nowMs }: {
    queueDefinitionId: unknown; queueDefinitionVersion: unknown; scopeKey: unknown; nowMs: number;
  }): Promise<number> {
    const definition = await queryOne<PolicyRow>(client, `
      SELECT policy_json FROM queue_definitions
      WHERE queue_definition_id = $1
        AND ($2::integer = 0 OR queue_definition_version = $2)
      ORDER BY queue_definition_version DESC
      LIMIT 1
    `, [queueDefinitionId, queueDefinitionVersion]);
    const policy = getPolicy({
      ...resolvedPolicy,
      ...asObject(parseJson(definition?.policy_json, {}))
    });
    const { agingIntervalMs, agingBatchSize } = policy.fairness;
    const selected = await client.query<Pick<WorkItemProjectionRow, "work_item_id" | "priority" | "priority_class" | "available_at_ms">>(`
      SELECT work_item_id, priority, priority_class, available_at_ms
      FROM work_items
      WHERE queue_definition_id = $1
        AND ($2::integer = 0 OR queue_definition_version = $2)
        AND scope_key = $3
        AND state = ANY($4::text[])
        AND priority_class <> 'critical'
        AND available_at_ms <= $5
      ORDER BY available_at_ms ASC, created_at_ms ASC, work_item_id ASC
      LIMIT $6
      FOR UPDATE SKIP LOCKED
    `, [
      queueDefinitionId,
      queueDefinitionVersion,
      scopeKey,
      [WORK_QUEUE_STATES.QUEUED, WORK_QUEUE_STATES.RECOVERED],
      nowMs - agingIntervalMs,
      agingBatchSize
    ]);
    for (const row of selected.rows) {
      const priorityClass = agedWorkQueuePriorityClass({
        priority: row.priority,
        availableAtMs: row.available_at_ms,
        nowMs,
        agingIntervalMs
      });
      if (priorityClass !== row.priority_class) {
        await client.query(`
          UPDATE work_items SET priority_class = $2, updated_at_ms = $3
          WHERE work_item_id = $1
        `, [row.work_item_id, priorityClass, nowMs]);
      }
    }
    return selected.rows.length;
  }

  async function countUnderReservedPartitions(client: PoolClient, {
    queueDefinitionId,
    scopeKey,
    hierarchy,
    nowMs,
    reservation,
    limit,
    level
  }: {
    queueDefinitionId: unknown; scopeKey: unknown; hierarchy: QueueHierarchy; nowMs: number;
    reservation: number; limit: number; level: "tenant" | "workspace" | "project";
  }): Promise<number> {
    const row = await queryOne<CountRow>(client, `
      WITH pending_partitions AS (
        SELECT DISTINCT
          pending.tenant_id,
          CASE WHEN $11 = 'tenant' THEN '' ELSE pending.workspace_id END AS workspace_id,
          CASE WHEN $11 = 'project' THEN pending.project_id ELSE '' END AS project_id
        FROM work_items pending
        WHERE pending.queue_definition_id = $1
          AND pending.scope_key = $2
          AND pending.state = ANY($3::text[])
          AND pending.available_at_ms <= $4
          AND (pending.expires_at_ms = 0 OR pending.expires_at_ms > $4)
          AND (
            ($11 = 'tenant' AND pending.tenant_id <> $5) OR
            ($11 = 'workspace' AND pending.tenant_id = $5 AND pending.workspace_id <> $6) OR
            ($11 = 'project' AND pending.tenant_id = $5 AND pending.workspace_id = $6 AND pending.project_id <> $7)
          )
      )
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM pending_partitions pending
        WHERE (SELECT COUNT(*) FROM work_items running
          WHERE running.queue_definition_id = $1
            AND running.state = $8
            AND running.tenant_id = pending.tenant_id
            AND ($11 = 'tenant' OR running.workspace_id = pending.workspace_id)
            AND ($11 <> 'project' OR running.project_id = pending.project_id)) < $9
        LIMIT $10
      ) bounded
    `, [
      queueDefinitionId,
      scopeKey,
      [WORK_QUEUE_STATES.QUEUED, WORK_QUEUE_STATES.RECOVERED],
      nowMs,
      hierarchy.tenantId,
      hierarchy.workspaceId,
      hierarchy.projectId,
      WORK_QUEUE_STATES.RUNNING,
      reservation,
      limit,
      level
    ]);
    return Number(row?.count || 0);
  }

  async function hasLeaseCapacity(client: PoolClient, queueDefinitionId: unknown, hierarchy: QueueHierarchy, policy: QueuePolicy, { scopeKey, nowMs }: { scopeKey: unknown; nowMs: number }): Promise<boolean> {
    const { capacity, fairness } = policy;
    const states: unknown[] = [WORK_QUEUE_STATES.RUNNING];
    const queueLeased = await boundedCount(client, {
      queueDefinitionId,
      states,
      limit: capacity.maxLeased
    });
    const tenantLeased = await boundedCount(client, {
        queueDefinitionId,
        states,
        tenantId: hierarchy.tenantId,
        limit: capacity.maxLeasedPerTenant
      });
    const workspaceLeased = await boundedCount(client, {
        queueDefinitionId,
        states,
        tenantId: hierarchy.tenantId,
        workspaceId: hierarchy.workspaceId,
        limit: capacity.maxLeasedPerWorkspace
      });
    const projectLeased = await boundedCount(client, {
        queueDefinitionId,
        states,
        ...hierarchy,
        limit: capacity.maxLeasedPerProject
      });
    if (queueLeased >= capacity.maxLeased ||
        tenantLeased >= capacity.maxLeasedPerTenant ||
        workspaceLeased >= capacity.maxLeasedPerWorkspace ||
        projectLeased >= capacity.maxLeasedPerProject) return false;
    const reservationInput = {
      queueDefinitionId,
      scopeKey,
      hierarchy,
      nowMs,
      reservation: fairness.minReservedLeasesPerPartition,
      limit: fairness.reservationScanLimit
    };
    if (tenantLeased >= reservationInput.reservation &&
        queueLeased + await countUnderReservedPartitions(client, { ...reservationInput, level: "tenant" }) >= capacity.maxLeased) return false;
    if (workspaceLeased >= reservationInput.reservation &&
        tenantLeased + await countUnderReservedPartitions(client, { ...reservationInput, level: "workspace" }) >= capacity.maxLeasedPerTenant) return false;
    if (projectLeased >= reservationInput.reservation &&
        workspaceLeased + await countUnderReservedPartitions(client, { ...reservationInput, level: "project" }) >= capacity.maxLeasedPerWorkspace) return false;
    return true;
  }

  function isWorkExpired(row: WorkItemProjectionRow | null | undefined, nowMs: number): boolean {
    return Number(row?.expires_at_ms || 0) > 0 && Number(row?.expires_at_ms) <= nowMs;
  }

  async function expireRow(client: PoolClient, row: WorkItemProjectionRow, nowMs: number, input: { operationId?: unknown; actor?: object; reason?: unknown } = {}): Promise<WorkItemProjectionRow> {
    return transitionProjection(client, {
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
      operationId: input.operationId,
      actor: input.actor,
      reason: input.reason || "work_deadline_reached"
    });
  }

  async function selectFairCandidate(client: PoolClient, { queueDefinitionId, queueDefinitionVersion, scope, scopeKey, nowMs, priorityCursor }: {
    queueDefinitionId: unknown; queueDefinitionVersion: unknown; scope: Record<string, unknown>;
    scopeKey: unknown; nowMs: number; priorityCursor: number;
  }): Promise<{ row: WorkItemProjectionRow; priorityCursor: number } | null> {
    const fixed = hierarchicalScopeParts(scope);
    let cursor = priorityCursor;
    for (let slot = 0; slot < WORK_QUEUE_PRIORITY_CYCLE.length; slot += 1) {
      const priorityClass = priorityClassAtCursor(cursor);
      cursor = nextPriorityCursor(cursor);
      const rejected: string[] = [];
      for (;;) {
        const candidate = await queryOne<WorkItemProjectionRow>(client, `
          WITH all_partitions AS (
            SELECT projection.queue_definition_version,
                   projection.tenant_id, projection.workspace_id, projection.project_id,
                   projection.virtual_finish
            FROM work_queue_virtual_finish projection
            WHERE projection.queue_definition_id = $1
              AND projection.selector_scope_key = $2
              AND ($3::integer = 0 OR projection.queue_definition_version = $3)
              AND projection.priority_class = $5
              AND ($7 = '' OR projection.tenant_id = $7)
              AND ($8 = '' OR projection.workspace_id = $8)
              AND ($9 = '' OR projection.project_id = $9)
              AND (projection.tenant_id || chr(31) || projection.workspace_id || chr(31) || projection.project_id) <> ALL($11::text[])
          ),
          eligible_partitions AS (
            SELECT all_partitions.*
            FROM all_partitions
            WHERE EXISTS (
              SELECT 1 FROM work_items pending
              WHERE pending.queue_definition_id = $1
                AND pending.scope_key = $2
                AND pending.state = ANY($4::text[])
                AND pending.priority_class = $5
                AND pending.available_at_ms <= $6
                AND (pending.expires_at_ms = 0 OR pending.expires_at_ms > $6)
                AND pending.tenant_id = all_partitions.tenant_id
                AND pending.workspace_id = all_partitions.workspace_id
                AND pending.project_id = all_partitions.project_id
                AND NOT EXISTS (
                  SELECT 1 FROM work_items active
                  WHERE active.queue_definition_id = pending.queue_definition_id
                    AND active.scope_key = pending.scope_key
                    AND active.concurrency_key = pending.concurrency_key
                    AND active.concurrency_key <> ''
                    AND active.state = $10
                    AND active.work_item_id <> pending.work_item_id
                )
            )
          ),
          ranked_partitions AS (
            SELECT ep.*,
                   DENSE_RANK() OVER (ORDER BY ep.tenant_id) - 1 AS tenant_rank,
                   DENSE_RANK() OVER (PARTITION BY ep.tenant_id ORDER BY ep.workspace_id) - 1 AS workspace_rank,
                   DENSE_RANK() OVER (PARTITION BY ep.tenant_id, ep.workspace_id ORDER BY ep.project_id) - 1 AS project_rank,
                   (SELECT SUM(claims.virtual_finish)
                    FROM all_partitions claims
                    WHERE claims.tenant_id = ep.tenant_id) AS tenant_claims,
                   (SELECT SUM(claims.virtual_finish)
                    FROM all_partitions claims
                    WHERE claims.tenant_id = ep.tenant_id
                      AND claims.workspace_id = ep.workspace_id) AS workspace_claims,
                   (SELECT COUNT(DISTINCT tenants.tenant_id) FROM all_partitions tenants) AS tenant_count,
                   (SELECT COUNT(DISTINCT workspaces.workspace_id)
                    FROM all_partitions workspaces
                    WHERE workspaces.tenant_id = ep.tenant_id) AS workspace_count,
                   (SELECT COUNT(DISTINCT projects.project_id)
                    FROM all_partitions projects
                    WHERE projects.tenant_id = ep.tenant_id
                      AND projects.workspace_id = ep.workspace_id) AS project_count
            FROM eligible_partitions ep
          )
          SELECT candidate.*
          FROM ranked_partitions ranked
          JOIN work_items candidate
            ON candidate.queue_definition_id = $1
           AND candidate.scope_key = $2
           AND ($3::integer = 0 OR candidate.queue_definition_version = $3)
           AND candidate.state = ANY($4::text[])
           AND candidate.priority_class = $5
           AND candidate.available_at_ms <= $6
           AND (candidate.expires_at_ms = 0 OR candidate.expires_at_ms > $6)
           AND candidate.queue_definition_version = ranked.queue_definition_version
           AND candidate.tenant_id = ranked.tenant_id
           AND candidate.workspace_id = ranked.workspace_id
           AND candidate.project_id = ranked.project_id
           AND NOT EXISTS (
             SELECT 1 FROM work_items active
             WHERE active.queue_definition_id = candidate.queue_definition_id
               AND active.scope_key = candidate.scope_key
               AND active.concurrency_key = candidate.concurrency_key
               AND active.concurrency_key <> ''
               AND active.state = $10
               AND active.work_item_id <> candidate.work_item_id
           )
          ORDER BY (ranked.tenant_claims * ranked.tenant_count + ranked.tenant_rank) ASC,
                   (ranked.workspace_claims * ranked.workspace_count + ranked.workspace_rank) ASC,
                   (ranked.virtual_finish * ranked.project_count + ranked.project_rank) ASC,
                   candidate.available_at_ms ASC, candidate.created_at_ms ASC, candidate.work_item_id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `, [
          queueDefinitionId,
          scopeKey,
          queueDefinitionVersion,
          [WORK_QUEUE_STATES.QUEUED, WORK_QUEUE_STATES.RECOVERED],
          priorityClass,
          nowMs,
          fixed.tenantId,
          fixed.workspaceId,
          fixed.projectId,
          WORK_QUEUE_STATES.RUNNING,
          rejected
        ]);
        if (!candidate) break;
        const hierarchy: QueueHierarchy = {
          tenantId: candidate.tenant_id,
          workspaceId: candidate.workspace_id,
          projectId: candidate.project_id
        };
        const policy = await policyForWorkItem(client, candidate);
        if (!await hasLeaseCapacity(client, queueDefinitionId, hierarchy, policy, { scopeKey, nowMs })) {
          rejected.push([candidate.tenant_id, candidate.workspace_id, candidate.project_id].join("\u001f"));
          continue;
        }
        return { row: candidate, priorityCursor: cursor };
      }
    }
    return null;
  }

  const store = {
    database,
    kind: "postgres",
    async enqueue(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const { queueDefinitionId, queueDefinitionVersion, queueDefinition } = resolveQueueDefinition(input, { assertEnqueue: true });
        await lockQueueCapacity(client, queueDefinitionId);
        const scope: Record<string, unknown> = normalizeScope(input.scope || {});
        const scopeKey = input.scopeKey ? toText(input.scopeKey) : scopeKeyFromScope(scope);
        const dedupeKey = toText(input.dedupeKey);

        const delayMs = Math.max(0, asInt(input.delayMs, 0));
        const availableAtMs = asInt(input.availableAtMs, delayMs > 0 ? nowMs + delayMs : nowMs);
        const state = String(availableAtMs > nowMs ? WORK_QUEUE_STATES.RETRY_WAIT : WORK_QUEUE_STATES.QUEUED);
        const payloadRef: Record<string, unknown> = normalizePayloadRef(input.payloadRef || input.payload || input.payloadReference);
        const ownerRef: Record<string, unknown> = normalizeOwnerRef(input.ownerRef);
        const queueDefinitionPolicy = asObject(queueDefinition.policy) || {};
        const policyForItem: QueuePolicy = getPolicy({
          ...resolvedPolicy,
          ...queueDefinitionPolicy,
          capacity: {
            ...resolvedPolicy.capacity,
            ...asObject(queueDefinitionPolicy.capacity)
          },
          retention: {
            ...resolvedPolicy.retention,
            ...asObject(queueDefinitionPolicy.retention)
          }
        });
        const expiresAtMs = resolveWorkExpiryAtMs({
          nowMs,
          availableAtMs,
          expiresAtMs: input.expiresAtMs,
          policy: policyForItem
        });
        const payloadRefJson: string = serializePayloadRef(payloadRef);
        assertCapacityAtMost({
          count: Buffer.byteLength(payloadRefJson, "utf8"),
          limit: policyForItem.capacity.maxPayloadRefBytes,
          reason: "payload_ref_bytes"
        });
        if (dedupeKey) {
          const existing = await queryOne<WorkItemProjectionRow>(client, `
            SELECT *
            FROM work_items
            WHERE queue_definition_id = $1
              AND scope_key = $2
              AND dedupe_key = $3
              AND dedupe_key <> ''
            ORDER BY created_at_ms ASC
            LIMIT 1
          `, [queueDefinitionId, scopeKey, dedupeKey]);
          if (existing) {
            assertDedupeFingerprint(existing, { queueDefinitionVersion, payloadRef, ownerRef, schedulingScope: input.schedulingScope ?? scope });
            return { accepted: false, deduped: true, workItem: rowToWorkItem(existing) };
          }
        }
        const normalizedPriority = normalizeWorkQueuePriority(input.priority);
        const hierarchy = hierarchicalScopeParts(input.schedulingScope ?? scope);
        await assertAdmissionCapacity(client, {
          queueDefinitionId,
          hierarchy,
          state,
          policy: policyForItem
        });
        const row: WorkItemProjectionRow = {
          work_item_id: toText(input.workItemId || identityGenerator.workItemId()),
          queue_definition_id: queueDefinitionId,
          queue_definition_version: queueDefinitionVersion,
          scope_key: scopeKey,
          scope_json: scope,
          dedupe_key: dedupeKey,
          state,
          owner_ref_json: ownerRef,
          payload_ref_json: payloadRef,
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
          last_error_json: {},
          checkpoint_ref_json: {},
          checkpoint_digest: "",
          checkpoint_seq: 0,
          checkpoint_updated_at_ms: 0,
          last_transition_seq: 0,
          created_at_ms: nowMs,
          updated_at_ms: nowMs
        };
        const columns = WORK_ITEM_PROJECTION_COLUMNS;
        try {
          await client.query(`
            INSERT INTO work_items (${columns.join(", ")})
            VALUES (${insertPlaceholders(columns)})
          `, sqlValues({
            ...row,
            scope_json: JSON.stringify(row.scope_json),
            owner_ref_json: JSON.stringify(row.owner_ref_json),
            payload_ref_json: payloadRefJson,
            last_error_json: JSON.stringify(row.last_error_json),
            checkpoint_ref_json: JSON.stringify(row.checkpoint_ref_json)
          }, columns));
        } catch (error: unknown) {
          if (dedupeKey && postgresErrorCode(error) === "23505") {
            const existing = await queryOne<WorkItemProjectionRow>(client, `
              SELECT *
              FROM work_items
              WHERE queue_definition_id = $1 AND scope_key = $2 AND dedupe_key = $3
              ORDER BY created_at_ms ASC
              LIMIT 1
            `, [queueDefinitionId, scopeKey, dedupeKey]);
            if (existing) {
              assertDedupeFingerprint(existing, { queueDefinitionVersion, payloadRef, ownerRef, schedulingScope: input.schedulingScope ?? scope });
              return { accepted: false, deduped: true, workItem: rowToWorkItem(existing) };
            }
          }
          throw error;
        }
        await client.query(`
          INSERT INTO work_queue_virtual_finish (
            queue_definition_id, queue_definition_version, selector_scope_key,
            priority_class, tenant_id, workspace_id, project_id, virtual_finish, updated_at_ms
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8)
          ON CONFLICT (
            queue_definition_id, queue_definition_version, selector_scope_key,
            priority_class, tenant_id, workspace_id, project_id
          ) DO UPDATE SET updated_at_ms = EXCLUDED.updated_at_ms
        `, [
          queueDefinitionId,
          queueDefinitionVersion,
          scopeKey,
          row.priority_class,
          row.tenant_id,
          row.workspace_id,
          row.project_id,
          nowMs
        ]);
        const seq = await appendTransitionInternal(client, {
          row,
          transition: "enqueue",
          fromState: null,
          toState: state,
          nowMs,
          operationId: input.operationId,
          actor: input.actor,
          reason: input.reason || "enqueue",
          policyVersion: row.policy_version,
          decision: { projectionRow: row }
        });
        const inserted = await queryOne<WorkItemProjectionRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1", [row.work_item_id]);
        return { accepted: true, deduped: false, transitionSeq: seq, workItem: rowToWorkItem(inserted) };
      });
    },
    async claim(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const { queueDefinitionId, queueDefinitionVersion } = resolveQueueDefinition(input, { allowAllVersions: true });
        await lockQueueCapacity(client, queueDefinitionId);
        const scope: Record<string, unknown> = normalizeScope(input.scope || {});
        const schedulingScope: Record<string, unknown> = normalizeScope(input.schedulingScope ?? scope);
        const scopeKey = input.scopeKey ? toText(input.scopeKey) : scopeKeyFromScope(scope);
        const recoveryScopeKey = scope.tenantId && scope.workspaceId && scope.projectId
          ? scopeKey
          : "";
        const workerId = toText(input.workerId || input.consumerId || identityGenerator.workerId());
        const batchSize = Math.max(1, Math.min(asInt(input.batchSize ?? input.batch ?? input.maxMessages, 1), 500));
        const leaseTimeoutMs = Math.max(1, asInt(input.leaseTimeoutMs, resolvedPolicy.leaseTimeoutMs));
        const expired = await expireEligibleLocked(client, {
          nowMs,
          queueDefinitionId,
          scopeKey: recoveryScopeKey,
          limit: Math.max(100, batchSize * 8)
        });
        const recovered = await recoverExpiredLeasesLocked(client, {
          nowMs,
          queueDefinitionId,
          scopeKey: recoveryScopeKey,
          limit: Math.max(100, batchSize * 8)
        });
        const reconciled = await reconcileInDoubtLocked(client, {
          nowMs,
          queueDefinitionId,
          scopeKey: recoveryScopeKey,
          limit: Math.max(100, batchSize * 8)
        });
        const control = await queryOne<QueueControlRow>(client, `
          SELECT *
          FROM work_queue_controls
          WHERE queue_definition_id = $1 AND scope_key = $2
        `, [queueDefinitionId, scopeKey]);
        if (control && ["paused", "draining"].includes(control.mode)) {
          return {
            workerId,
            claimed: [],
            expired,
            recovered,
            reconciled,
            matured: [],
            control: {
              mode: control.mode,
              reason: control.reason || "",
              updatedAtMs: Number(control.updated_at_ms || 0)
            }
          };
        }
        const matured = await materializeDelayedLocked(client, {
          nowMs,
          queueDefinitionId,
          scopeKey: recoveryScopeKey,
          limit: Math.max(100, batchSize * 8)
        });
        const aged = await promoteAgedCandidates(client, {
          queueDefinitionId,
          queueDefinitionVersion: asInt(queueDefinitionVersion, 0),
          scopeKey,
          nowMs
        });
        const claimed: Array<{ workItem: unknown; lease: { leaseId: string; leaseSeq: number; workerId: string; expiresAtMs: number } }> = [];
        const failed: unknown[] = [];
        let priorityCursor = await virtualFinishCursor(client, {
          queueDefinitionId,
          queueDefinitionVersion: asInt(queueDefinitionVersion, 0),
          selectorScopeKey: scopeKey
        });
        for (let visit = 0; visit < batchSize && claimed.length < batchSize; visit += 1) {
          const selected = await selectFairCandidate(client, {
            queueDefinitionId,
            queueDefinitionVersion: asInt(queueDefinitionVersion, 0),
            scope: schedulingScope,
            scopeKey,
            nowMs,
            priorityCursor
          });
          if (!selected) break;
          priorityCursor = selected.priorityCursor;
          const row = selected.row;
          const partition: VirtualFinishKey = {
            queueDefinitionId,
            queueDefinitionVersion: Number(row.queue_definition_version || 0),
            selectorScopeKey: scopeKey,
            priorityClass: row.priority_class,
            tenantId: row.tenant_id,
            workspaceId: row.workspace_id,
            projectId: row.project_id
          };
          if (Number(row.attempt || 0) >= Number(row.max_attempts || 0)) {
            await advanceVirtualFinish(client, partition, nowMs);
            const failedRow = await transitionProjection(client, {
              row,
              transition: "fail",
              toState: String(WORK_QUEUE_STATES.FAILED),
              patch: {
                available_at_ms: nowMs,
                lease_id: "",
                leased_by_worker_id: "",
                lease_expires_at_ms: 0,
                last_error_json: {
                  type: "max_attempts_exhausted_before_claim",
                  attempt: row.attempt,
                  maxAttempts: row.max_attempts
                }
              },
              nowMs,
              reason: "max_attempts_exhausted_before_claim"
            });
            failed.push(rowToWorkItem(failedRow));
            continue;
          }
          const leaseId = identityGenerator.leaseId();
          const leaseSeq = Number(row.lease_seq || 0) + 1;
          const attempt = Number(row.attempt || 0) + 1;
          const leaseExpiresAtMs = Number(row.expires_at_ms || 0) > 0
            ? Math.min(nowMs + leaseTimeoutMs, Number(row.expires_at_ms))
            : nowMs + leaseTimeoutMs;
          const updated = await transitionProjection(client, {
            row,
            transition: "claim",
            toState: String(WORK_QUEUE_STATES.RUNNING),
            patch: {
              attempt,
              lease_id: leaseId,
              lease_seq: leaseSeq,
              leased_by_worker_id: workerId,
              lease_expires_at_ms: leaseExpiresAtMs,
              last_error_json: {}
            },
            nowMs,
            operationId: input.operationId,
            actor: input.actor || { workerId },
            reason: input.reason || "claim"
          });
          claimed.push({
            workItem: rowToWorkItem(updated),
            lease: { leaseId, leaseSeq, workerId, expiresAtMs: leaseExpiresAtMs }
          });
        }
        return { workerId, claimed, expired, recovered, reconciled, matured, aged, failed };
      });
    },
    async expire(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const row: WorkItemProjectionRow = requireWorkItemBoundary(
          await queryOne<WorkItemProjectionRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]),
          input
        );
        if (row.state === WORK_QUEUE_STATES.EXPIRED) {
          return { expired: true, idempotent: true, workItem: rowToWorkItem(row) };
        }
        if (!new Set<string>([WORK_QUEUE_STATES.QUEUED, WORK_QUEUE_STATES.RETRY_WAIT, WORK_QUEUE_STATES.RUNNING, WORK_QUEUE_STATES.IN_DOUBT, WORK_QUEUE_STATES.RECOVERED]).has(row.state)) {
          return { expired: false, idempotent: true, workItem: rowToWorkItem(row) };
        }
        if (input.force !== true && !isWorkExpired(row, nowMs)) {
          return { expired: false, idempotent: true, workItem: rowToWorkItem(row) };
        }
        return { expired: true, idempotent: false, workItem: rowToWorkItem(await expireRow(client, row, nowMs, input)) };
      });
    },
    async complete(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const current = await queryOne<WorkItemProjectionRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]);
        if (current && current.state === WORK_QUEUE_STATES.COMPLETED) {
          const terminal = await queryOne<TerminalTransitionRow>(client, `
            SELECT transition, lease_id, lease_seq
            FROM work_queue_transition_journal
            WHERE work_item_id = $1
            ORDER BY seq DESC
            LIMIT 1
          `, [current.work_item_id]);
          if (terminal?.transition === "complete" && terminal.lease_id === toText(input.leaseId)) {
            return { completed: true, idempotent: true, workItem: rowToWorkItem(current) };
          }
        }
        if (isWorkExpired(current, nowMs)) {
          return { completed: false, expired: true, workItem: rowToWorkItem(await expireRow(client, requireProjectionRow(current), nowMs, input)) };
        }
        const row = requireProjectionRow(await requireLeasedRow(client, input.workItemId, input.leaseId, nowMs));
        const updated = await transitionProjection(client, {
          row,
          transition: "complete",
          toState: String(WORK_QUEUE_STATES.COMPLETED),
          patch: {
            available_at_ms: nowMs,
            lease_id: "",
            leased_by_worker_id: "",
            lease_expires_at_ms: 0,
            last_error_json: {}
          },
          nowMs,
          operationId: input.operationId,
          actor: input.actor,
          reason: input.reason || "complete"
        });
        await client.query(`
          INSERT INTO work_queue_sink_fences (
            work_item_id, generation, sink_id, effect_id, status, settled_at_ms
          ) VALUES ($1,$2,'complete',$3,'settled',$4)
          ON CONFLICT (work_item_id, generation, sink_id) DO NOTHING
        `, [row.work_item_id, Number(row.lease_seq || 0), toText(input.effectId), nowMs]);
        return { completed: true, workItem: rowToWorkItem(updated) };
      });
    },
    async retry(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const current = await queryOne<WorkItemProjectionRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]);
        if (isWorkExpired(current, nowMs)) {
          return { retried: false, expired: true, workItem: rowToWorkItem(await expireRow(client, requireProjectionRow(current), nowMs, input)) };
        }
        const row = requireProjectionRow(await requireLeasedRow(client, input.workItemId, input.leaseId, nowMs));
        const exhausted = Number(row.attempt || 0) >= Number(row.max_attempts || 0);
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
        if (!exhausted && Number(row.expires_at_ms || 0) > 0 && nowMs + delayMs >= Number(row.expires_at_ms)) {
          return { retried: false, expired: true, workItem: rowToWorkItem(await expireRow(client, row, nowMs, input)) };
        }
        const toState = String(exhausted
          ? WORK_QUEUE_STATES.FAILED
          : delayMs > 0
            ? WORK_QUEUE_STATES.RETRY_WAIT
            : WORK_QUEUE_STATES.QUEUED);
        const updated = await transitionProjection(client, {
          row,
          transition: "retry",
          toState,
          patch: {
            available_at_ms: nowMs + delayMs,
            lease_id: "",
            leased_by_worker_id: "",
            lease_expires_at_ms: 0,
            last_error_json: input.error || input.lastError || {}
          },
          nowMs,
          operationId: input.operationId,
          actor: input.actor,
          reason: input.reason || (exhausted ? "retry_attempts_exhausted" : "retry")
        });
        return { retried: true, retryable: !exhausted, delayMs, workItem: rowToWorkItem(updated) };
      });
    },
    async progress(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const current = await queryOne<WorkItemProjectionRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]);
        if (isWorkExpired(current, nowMs)) {
          return { progressed: false, expired: true, workItem: rowToWorkItem(await expireRow(client, requireProjectionRow(current), nowMs, input)) };
        }
        const row = requireProjectionRow(await requireLeasedRow(client, input.workItemId, input.leaseId, nowMs));
        const extendMs = Math.max(1, asInt(input.extendMs ?? input.leaseTimeoutMs, resolvedPolicy.leaseTimeoutMs));
        const leaseExpiresAtMs = Number(row.expires_at_ms || 0) > 0
          ? Math.min(nowMs + extendMs, Number(row.expires_at_ms))
          : nowMs + extendMs;
        const updated = await transitionProjection(client, {
          row,
          transition: "progress",
          toState: String(WORK_QUEUE_STATES.RUNNING),
          patch: { lease_expires_at_ms: leaseExpiresAtMs },
          nowMs,
          operationId: input.operationId,
          actor: input.actor,
          reason: input.reason || "progress"
        });
        const workItem = rowToWorkItem(updated);
        if (!workItem) throw new Error("Updated work item projection is unavailable.");
        return { progressed: true, lease: workItem.lease, workItem };
      });
    },
    async checkpoint(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const row = requireProjectionRow(await requireLeasedRow(client, input.workItemId, input.leaseId, nowMs));
        const normalized: { checkpointDigest: string; serialized: string } = normalizeCheckpointRef(input.checkpointRef);
        if (row.checkpoint_digest === normalized.checkpointDigest) {
          return { checkpointed: true, idempotent: true, workItem: rowToWorkItem(row) };
        }
        const currentSeq = Number(row.checkpoint_seq || 0);
        if (input.expectedCheckpointSeq !== undefined &&
            asInt(input.expectedCheckpointSeq, -1) !== currentSeq) {
          const error: QueueOperationError = new Error("Queue checkpoint revision does not match the current projection.");
          error.code = "work_queue_checkpoint_conflict";
          error.expectedCheckpointSeq = currentSeq;
          throw error;
        }
        const checkpointSeq = currentSeq + 1;
        const updated = await queryOne<WorkItemProjectionRow>(client, `
          UPDATE work_items
          SET checkpoint_ref_json = $2::jsonb,
              checkpoint_digest = $3,
              checkpoint_seq = $4,
              checkpoint_updated_at_ms = $5,
              updated_at_ms = $5
          WHERE work_item_id = $1
          RETURNING *
        `, [
          row.work_item_id,
          normalized.serialized,
          normalized.checkpointDigest,
          checkpointSeq,
          nowMs
        ]);
        await appendTransitionInternal(client, {
          row: requireProjectionRow(updated),
          transition: "progress",
          fromState: String(WORK_QUEUE_STATES.RUNNING),
          toState: String(WORK_QUEUE_STATES.RUNNING),
          leaseId: row.lease_id,
          leaseSeq: row.lease_seq,
          nowMs,
          operationId: input.operationId,
          actor: input.actor,
          reason: input.reason || "checkpoint",
          decision: { checkpointDigest: normalized.checkpointDigest, checkpointSeq }
        });
        return {
          checkpointed: true,
          idempotent: false,
          workItem: rowToWorkItem(await queryOne(
            client,
            "SELECT * FROM work_items WHERE work_item_id = $1",
            [row.work_item_id]
          ))
        };
      });
    },
    async cancelRunning(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const current = await queryOne<WorkItemProjectionRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]);
        if (current && current.state === WORK_QUEUE_STATES.CANCELLED) {
          const terminal = await queryOne<TerminalTransitionRow>(client, `
            SELECT transition, lease_id, lease_seq
            FROM work_queue_transition_journal
            WHERE work_item_id = $1
            ORDER BY seq DESC
            LIMIT 1
          `, [current.work_item_id]);
          if (terminal?.transition === "cancel_running" && terminal.lease_id === toText(input.leaseId)) {
            return { cancelled: true, idempotent: true, workItem: rowToWorkItem(current) };
          }
        }
        if (isWorkExpired(current, nowMs)) {
          return { cancelled: false, expired: true, workItem: rowToWorkItem(await expireRow(client, requireProjectionRow(current), nowMs, input)) };
        }
        const row = requireProjectionRow(await requireLeasedRow(client, input.workItemId, input.leaseId, nowMs));
        const updated = await transitionProjection(client, {
          row,
          transition: "cancel_running",
          toState: String(WORK_QUEUE_STATES.CANCELLED),
          patch: {
            available_at_ms: nowMs,
            lease_id: "",
            leased_by_worker_id: "",
            lease_expires_at_ms: 0,
            last_error_json: input.reasonDetails || {}
          },
          nowMs,
          operationId: input.operationId,
          actor: input.actor,
          reason: input.reason || "cancel_running"
        });
        return { cancelled: true, workItem: rowToWorkItem(updated) };
      });
    },
    async cancel(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const row: WorkItemProjectionRow = requireWorkItemBoundary(
          await queryOne<WorkItemProjectionRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]),
          input
        );
        if (row.state === WORK_QUEUE_STATES.CANCELLED) {
          return { cancelled: true, idempotent: true, workItem: rowToWorkItem(row) };
        }
        if (row.state === WORK_QUEUE_STATES.COMPLETED) {
          return { cancelled: false, idempotent: true, completed: true, workItem: rowToWorkItem(row) };
        }
        if (isWorkExpired(row, nowMs)) {
          return { cancelled: false, expired: true, workItem: rowToWorkItem(await expireRow(client, row, nowMs, input)) };
        }
        if (!new Set<string>([
          WORK_QUEUE_STATES.QUEUED,
          WORK_QUEUE_STATES.RETRY_WAIT,
          WORK_QUEUE_STATES.RUNNING,
          WORK_QUEUE_STATES.IN_DOUBT,
          WORK_QUEUE_STATES.RECOVERED
        ]).has(row.state)) {
          throw new Error(`Work item ${input.workItemId} cannot be cancelled from state ${row.state}.`);
        }
        const updated = await transitionProjection(client, {
          row,
          transition: "cancel",
          toState: String(WORK_QUEUE_STATES.CANCELLED),
          patch: {
            available_at_ms: nowMs,
            lease_id: "",
            leased_by_worker_id: "",
            lease_expires_at_ms: 0,
            last_error_json: input.reasonDetails || {}
          },
          nowMs,
          operationId: input.operationId,
          actor: input.actor,
          reason: input.reason || "cancel"
        });
        return { cancelled: true, idempotent: false, workItem: rowToWorkItem(updated) };
      });
    },
    async fail(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        let row: WorkItemProjectionRow = requireWorkItemBoundary(
          await queryOne<WorkItemProjectionRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]),
          input
        );
        if (isTerminalWorkQueueState(row.state)) throw new Error(`Cannot fail terminal work item ${input.workItemId}.`);
        if (isWorkExpired(row, nowMs)) {
          return { failed: false, expired: true, workItem: rowToWorkItem(await expireRow(client, row, nowMs, input)) };
        }
        if (row.state === WORK_QUEUE_STATES.RUNNING) {
          row = requireProjectionRow(await requireLeasedRow(client, input.workItemId, input.leaseId, nowMs));
        }
        const fallbackTaskId = toText(input.fallbackTaskId);
        const updated = await transitionProjection(client, {
          row,
          transition: "fail",
          toState: String(WORK_QUEUE_STATES.FAILED),
          patch: {
            available_at_ms: nowMs,
            lease_id: "",
            leased_by_worker_id: "",
            lease_expires_at_ms: 0,
            fallback_task_id: fallbackTaskId || row.fallback_task_id,
            last_error_json: input.error || input.lastError || {}
          },
          nowMs,
          operationId: input.operationId,
          actor: input.actor,
          reason: input.reason || "fail"
        });
        await client.query(`
          INSERT INTO work_queue_sink_fences (
            work_item_id, generation, sink_id, effect_id, status, settled_at_ms
          ) VALUES ($1,$2,'fail',$3,'settled',$4)
          ON CONFLICT (work_item_id, generation, sink_id) DO NOTHING
        `, [row.work_item_id, Number(row.lease_seq || 0), toText(input.effectId), nowMs]);
        return { failed: true, fallbackTaskId, workItem: rowToWorkItem(updated) };
      });
    },
    async recover(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const row: WorkItemProjectionRow = requireWorkItemBoundary(
          await queryOne<WorkItemProjectionRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]),
          input
        );
        if (isWorkExpired(row, nowMs)) {
          throw new Error(`Work item ${input.workItemId} cannot be recovered after its deadline.`);
        }
        await lockQueueCapacity(client, row.queue_definition_id);
        const definition = await queryOne<PolicyRow>(client, `
          SELECT policy_json FROM queue_definitions
          WHERE queue_definition_id = $1 AND queue_definition_version = $2
        `, [row.queue_definition_id, row.queue_definition_version]);
        const override = parseJson(definition?.policy_json, {}) as Partial<QueuePolicy>;
        const policyForItem: QueuePolicy = getPolicy({
          ...resolvedPolicy,
          ...override,
          capacity: { ...resolvedPolicy.capacity, ...override.capacity },
          retention: { ...resolvedPolicy.retention, ...override.retention }
        });
        await assertAdmissionCapacity(client, {
          queueDefinitionId: row.queue_definition_id,
          hierarchy: {
            tenantId: row.tenant_id || "",
            workspaceId: row.workspace_id || "",
            projectId: row.project_id || ""
          },
          state: WORK_QUEUE_STATES.RECOVERED,
          policy: policyForItem
        });
        const updated = await transitionProjection(client, {
          row,
          transition: "recover",
          toState: String(WORK_QUEUE_STATES.RECOVERED),
          patch: {
            attempt: row.attempt,
            available_at_ms: nowMs,
            lease_id: "",
            leased_by_worker_id: "",
            lease_expires_at_ms: 0,
            last_error_json: input.lastError || {}
          },
          nowMs,
          operationId: input.operationId,
          actor: input.actor,
          reason: input.reason || "recover"
        });
        return { recovered: true, workItem: rowToWorkItem(updated) };
      });
    },
    async markInDoubt(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const row = await queryOne<WorkItemProjectionRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]);
        if (!row) {
          throw new Error(`Work item not found: ${input.workItemId}`);
        }
        if (row.state === WORK_QUEUE_STATES.IN_DOUBT) {
          if (toText(input.leaseId) && row.lease_id === toText(input.leaseId)) {
            return { interrupted: true, idempotent: true, workItem: rowToWorkItem(row) };
          }
          return { interrupted: false, idempotent: true, workItem: rowToWorkItem(row) };
        }
        if (row.state !== WORK_QUEUE_STATES.RUNNING) {
          return { interrupted: false, idempotent: true, workItem: rowToWorkItem(row) };
        }
        if (toText(input.leaseId) && row.lease_id !== toText(input.leaseId)) {
          throw new Error(`Lease fence rejected for work item ${input.workItemId}.`);
        }
        const updated = await transitionProjection(client, {
          row,
          transition: "interrupt",
          toState: String(WORK_QUEUE_STATES.IN_DOUBT),
          patch: {
            last_error_json: input.error || {
              type: "handler_unconfirmed",
              reason: input.reason || "handler_timeout"
            }
          },
          nowMs,
          operationId: input.operationId,
          actor: input.actor,
          reason: input.reason || "handler_timeout_unconfirmed"
        });
        return { interrupted: true, idempotent: false, workItem: rowToWorkItem(updated) };
      });
    },
    async acknowledgeTermination(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const row = await queryOne<WorkItemProjectionRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]);
        if (!row) {
          throw new Error(`Work item not found: ${input.workItemId}`);
        }
        if (row.state !== WORK_QUEUE_STATES.IN_DOUBT) {
          return { acknowledged: false, idempotent: true, workItem: rowToWorkItem(row) };
        }
        if (toText(input.leaseId) && row.lease_id !== toText(input.leaseId)) {
          throw new Error(`Lease fence rejected for work item ${input.workItemId}.`);
        }
        const requestedState = toText(input.toState || "");
        const terminalStates: string[] = [
          String(WORK_QUEUE_STATES.COMPLETED),
          String(WORK_QUEUE_STATES.FAILED)
        ];
        if (![
          "retry",
          WORK_QUEUE_STATES.QUEUED,
          WORK_QUEUE_STATES.RETRY_WAIT,
          WORK_QUEUE_STATES.FAILED,
          WORK_QUEUE_STATES.COMPLETED
        ].includes(requestedState)) {
          throw new Error(`Unsupported termination settlement state: ${requestedState}`);
        }
        let delayMs = 0;
        let toState = requestedState;
        if (!terminalStates.includes(requestedState)) {
          const exhausted = Number(row.attempt || 0) >= Number(row.max_attempts || 0);
          if (exhausted) {
            toState = String(WORK_QUEUE_STATES.FAILED);
          } else {
            delayMs = input.delayMs === undefined
              ? computeDeterministicRetryDelay({
                  queueDefinitionId: row.queue_definition_id,
                  workItemId: row.work_item_id,
                  attempt: row.attempt,
                  ...resolvedPolicy.retryBackoff
                })
              : Math.max(0, asInt(input.delayMs, 0));
            toState = String(delayMs > 0
              ? WORK_QUEUE_STATES.RETRY_WAIT
              : WORK_QUEUE_STATES.QUEUED);
          }
        }
        const updated = await transitionProjection(client, {
          row,
          transition: "termination_acknowledged",
          toState,
          patch: {
            available_at_ms: nowMs + (terminalStates.includes(toState) ? 0 : delayMs),
            lease_id: "",
            leased_by_worker_id: "",
            lease_expires_at_ms: 0,
            last_error_json: input.error || {
              type: "termination_acknowledged",
              reason: input.reason || "handler_terminated"
            }
          },
          nowMs,
          operationId: input.operationId,
          actor: input.actor,
          reason: input.reason || "termination_acknowledged"
        });
        if (terminalStates.includes(toState)) {
          await client.query(`
            INSERT INTO work_queue_sink_fences (
              work_item_id, generation, sink_id, effect_id, status, settled_at_ms
            ) VALUES ($1,$2,$3,$4,'settled',$5)
            ON CONFLICT (work_item_id, generation, sink_id) DO NOTHING
          `, [
            row.work_item_id,
            Number(row.lease_seq || 0),
            toState === WORK_QUEUE_STATES.COMPLETED ? "complete" : "fail",
            toText(input.effectId),
            nowMs
          ]);
        }
        return {
          acknowledged: true,
          idempotent: false,
          toState,
          delayMs,
          workItem: rowToWorkItem(updated)
        };
      });
    },
    async recordSinkReceipt(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const row = await queryOne<WorkItemProjectionRow>(client, "SELECT * FROM work_items WHERE work_item_id = $1", [toText(input.workItemId)]);
        const generation = input.generation === undefined
          ? Number(row?.lease_seq || 0)
          : asInt(input.generation, 0);
        const inserted = await client.query(`
          INSERT INTO work_queue_sink_fences (
            work_item_id, generation, sink_id, effect_id, status, settled_at_ms
          ) VALUES ($1,$2,$3,$4,'settled',$5)
          ON CONFLICT (work_item_id, generation, sink_id) DO NOTHING
        `, [
          toText(input.workItemId),
          generation,
          toText(input.sinkId || "effect"),
          toText(input.effectId),
          nowMs
        ]);
        return {
          recorded: Number(inserted.rowCount || 0) > 0,
          idempotent: Number(inserted.rowCount || 0) === 0,
          generation
        };
      });
    },
    async reconcileInDoubt(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const queueDefinitionId = toText(input.queueDefinitionId || input.queueDefinition?.queueDefinitionId);
        const scopeKey = input.scopeKey || (input.scope ? scopeKeyFromScope(input.scope) : "");
        const reconciled = await reconcileInDoubtLocked(client, {
          nowMs,
          queueDefinitionId,
          scopeKey,
          workItemId: toText(input.workItemId || ""),
          limit: input.workItemId ? 1 : Math.max(1, asInt(input.limit, 1000))
        });
        return {
          ok: true,
          reconciled,
          count: reconciled.length
        };
      });
    },
    async inspect(input: QueueCommandInput = {}) {
      if (input.workItemId) {
        const row = await queryOne<WorkItemProjectionRow>(database, "SELECT * FROM work_items WHERE work_item_id = $1", [toText(input.workItemId)]);
        if (!workItemMatchesBoundary(row, input)) return { workItem: null, journal: [] };
        const inspectedRow = requireProjectionRow(row);
        const journal = input.includeJournal
          ? (await database.query("SELECT * FROM work_queue_transition_journal WHERE work_item_id = $1 ORDER BY seq ASC", [inspectedRow.work_item_id])).rows.map(journalRowToTransition)
          : [];
        return { workItem: rowToWorkItem(inspectedRow), journal };
      }
      const queueDefinitionId = toText(input.queueDefinitionId || input.queueDefinition?.queueDefinitionId);
      const scopeKey = input.scopeKey || (input.scope ? scopeKeyFromScope(input.scope) : "");
      const states: string[] = asArray(input.states, []).map(toText).filter(Boolean);
      const limit = Math.max(1, Math.min(asInt(input.limit, 100), 1000));
      const where: string[] = [];
      const params: unknown[] = [];
      if (queueDefinitionId) {
        params.push(queueDefinitionId);
        where.push(`queue_definition_id = $${params.length}`);
      }
      if (scopeKey) {
        params.push(scopeKey);
        where.push(`scope_key = $${params.length}`);
      }
      if (states.length) {
        params.push(states);
        where.push(`state = ANY($${params.length}::text[])`);
      }
      params.push(limit);
      const items = (await database.query<WorkItemProjectionRow>(`
        SELECT *
        FROM work_items
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY priority DESC, available_at_ms ASC, created_at_ms ASC
        LIMIT $${params.length}
      `, params)).rows.map(rowToWorkItem);
      const countParams: unknown[] = [];
      const countWhere: string[] = [];
      if (queueDefinitionId) {
        countParams.push(queueDefinitionId);
        countWhere.push(`queue_definition_id = $${countParams.length}`);
      }
      if (scopeKey) {
        countParams.push(scopeKey);
        countWhere.push(`scope_key = $${countParams.length}`);
      }
      const stateCounts = (await database.query<StateCountRow>(`
        SELECT state, COUNT(*)::integer AS count
        FROM work_items
        ${countWhere.length ? `WHERE ${countWhere.join(" AND ")}` : ""}
        GROUP BY state
        ORDER BY state ASC
      `, countParams)).rows.map((row) => ({ state: row.state, count: Number(row.count || 0) }));
      return { items, stateCounts };
    },
    async rebuildProjection(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const journalRows = (await client.query<JournalRow>("SELECT * FROM work_queue_transition_journal ORDER BY seq ASC")).rows;
        const replayed = new Map<string, WorkItemProjectionRow>();
        const errors: Array<{ seq: number; workItemId: string; error: string }> = [];
        for (const journalRow of journalRows) {
          const transition = journalRowToTransition(journalRow);
          const decision = asObject(transition.decision) || {};
          const event: JournalEvent = {
            ...transition,
            decision: {
              projectionRow: decision.projectionRow ? requireProjectionRow(decision.projectionRow) : undefined,
              projectionPatch: asObject(decision.projectionPatch) || undefined
            }
          };
          const current = replayed.get(event.workItemId) || null;
          try {
            assertLegalWorkQueueTransition({
              transition: event.transition,
              fromState: current ? current.state : null,
              toState: event.toState
            });
          } catch (error: unknown) {
            errors.push({ seq: event.seq, workItemId: event.workItemId, error: errorMessage(error) });
            continue;
          }
          if (event.transition === "enqueue" || event.transition === "retention_snapshot") {
            const projectionRow = event.decision.projectionRow;
            if (!projectionRow) {
              errors.push({ seq: event.seq, workItemId: event.workItemId, error: "projection baseline event has no projectionRow" });
              continue;
            }
            replayed.set(event.workItemId, {
              ...projectionRow,
              state: event.toState,
              last_transition_seq: event.seq
            });
            continue;
          }
          if (!current) {
            errors.push({ seq: event.seq, workItemId: event.workItemId, error: "transition has no prior projection" });
            continue;
          }
          replayed.set(event.workItemId, {
            ...current,
            ...asObject(event.decision.projectionPatch),
            state: event.toState,
            last_transition_seq: event.seq
          });
        }
        const actualRows = (await client.query<WorkItemProjectionRow>("SELECT * FROM work_items ORDER BY work_item_id ASC")).rows;
        const drift: Array<Record<string, unknown>> = [];
        const actualIds = new Set(actualRows.map((row) => row.work_item_id));
        for (const actual of actualRows) {
          const expected = replayed.get(actual.work_item_id);
          if (!expected) {
            drift.push({ workItemId: actual.work_item_id, reason: "missing_from_replay" });
            continue;
          }
          for (const column of ["state", "attempt", "lease_id", "lease_seq", "leased_by_worker_id", "lease_expires_at_ms", "expires_at_ms", "available_at_ms"]) {
            const projectionColumn = column as WorkItemProjectionColumn;
            const expectedValue = column === "expires_at_ms" ? expected[projectionColumn] ?? 0 : expected[projectionColumn] ?? "";
            if (String(actual[column]) !== String(expectedValue)) {
              drift.push({ workItemId: actual.work_item_id, column, actual: actual[column], expected: expected[column] });
            }
          }
        }
        for (const workItemId of replayed.keys()) {
          if (!actualIds.has(workItemId)) {
            drift.push({ workItemId, reason: "missing_from_projection" });
          }
        }
        let applied = false;
        if (input.dryRun === false && errors.length === 0) {
          await client.query("DELETE FROM work_items");
          for (const row of replayed.values()) {
            const values: Partial<Record<WorkItemProjectionColumn, unknown>> = Object.fromEntries(WORK_ITEM_PROJECTION_COLUMNS.map((column) => [
              column,
              WORK_ITEM_JSON_COLUMNS.has(column)
                ? JSON.stringify(parseJson(row[column], {}))
                : row[column]
            ]));
            const placeholders = insertPlaceholders(WORK_ITEM_PROJECTION_COLUMNS)
              .replace("$5", "$5::jsonb")
              .replace("$8", "$8::jsonb")
              .replace("$9", "$9::jsonb")
              .replace("$28", "$28::jsonb");
            await client.query(`
              INSERT INTO work_items (${WORK_ITEM_PROJECTION_COLUMNS.join(", ")})
              VALUES (${placeholders})
            `, sqlValues(values, WORK_ITEM_PROJECTION_COLUMNS));
          }
          await client.query("DELETE FROM work_queue_virtual_finish");
          await client.query(`
            INSERT INTO work_queue_virtual_finish (
              queue_definition_id, queue_definition_version, selector_scope_key,
              priority_class, tenant_id, workspace_id, project_id, virtual_finish, updated_at_ms
            )
            SELECT queue_definition_id, queue_definition_version, scope_key, priority_class,
                   tenant_id, workspace_id, project_id, 0, MAX(updated_at_ms)
            FROM work_items
            GROUP BY queue_definition_id, queue_definition_version, scope_key, priority_class,
                     tenant_id, workspace_id, project_id
          `);
          applied = true;
        }
        return {
          ok: errors.length === 0 && (applied || drift.length === 0),
          applied,
          replayed: replayed.size,
          journalEntries: journalRows.length,
          errors,
          drift: applied ? [] : drift,
          repairedDrift: applied ? drift : []
        };
      });
    },
    async registerQueueDefinition(definition: QueueCommandInput = {}) {
      const nowMs = nowFrom(timeSource, definition.nowMs);
      const queueDefinitionId = toText(definition.queueDefinitionId || definition.id);
      if (!queueDefinitionId) throw new Error("queueDefinitionId is required.");
      const label = toText(definition.label);
      if (!label) throw new Error("Queue definition label is required.");
      const queueDefinitionVersion = asPositiveInt(definition.queueDefinitionVersion ?? definition.version, 1);
      const snapshot: Record<string, unknown> = queueDefinitionSnapshot({
        ...definition,
        queueDefinitionId,
        queueDefinitionVersion,
        label
      });
      return withTransaction(database, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`queue-definition-id:${queueDefinitionId}`]
        );
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`queue-definition-label:${label}`]
        );
        const existing = await queryOne<QueryResultRow>(client, `
          SELECT * FROM queue_definitions
          WHERE queue_definition_id = $1 AND queue_definition_version = $2
          FOR UPDATE
        `, [queueDefinitionId, queueDefinitionVersion]);
        if (existing) {
          if (stableJson(queueDefinitionSnapshot(existing)) === stableJson(snapshot)) {
            return { registered: false, idempotent: true, queueDefinitionId, queueDefinitionVersion };
          }
          throw queueDefinitionConflict(
            `Queue definition ${queueDefinitionId} version ${queueDefinitionVersion} is immutable.`
          );
        }
        const conflictingLabel = await queryOne<QueryResultRow>(client, `
          SELECT queue_definition_id FROM queue_definitions
          WHERE label = $1 AND queue_definition_id <> $2
          LIMIT 1
          FOR UPDATE
        `, [label, queueDefinitionId]);
        if (conflictingLabel) {
          throw queueDefinitionConflict(`Queue definition label is already in use: ${label}`);
        }
        await client.query(`
          INSERT INTO queue_definitions (
            queue_definition_id, queue_definition_version, label, lifecycle_state,
            owner_capability, allow_deprecated_enqueue, metadata_json, policy_json,
            routes_json, label_history_json, registered_at_ms, updated_at_ms
          ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12)
        `, [
          queueDefinitionId,
          queueDefinitionVersion,
          label,
          snapshot.lifecycleState,
          snapshot.ownerCapability,
          snapshot.allowDeprecatedEnqueue,
          JSON.stringify(snapshot.metadata),
          JSON.stringify(snapshot.policy),
          JSON.stringify(snapshot.routes),
          JSON.stringify(snapshot.labelHistory),
          nowMs,
          nowMs
        ]);
        return { registered: true, queueDefinitionId, queueDefinitionVersion };
      });
    },
    async setQueueControl(input: QueueCommandInput = {}) {
      const nowMs = nowFrom(timeSource, input.nowMs);
      const queueDefinitionId = toText(input.queueDefinitionId || input.queueDefinition?.queueDefinitionId);
      if (!queueDefinitionId) throw new Error("queueDefinitionId is required.");
      const scopeKey = input.scopeKey || (input.scope ? scopeKeyFromScope(input.scope) : "");
      const mode = toText(input.mode || "active");
      if (!["active", "paused", "draining"].includes(mode)) throw new Error(`Unknown queue control mode: ${mode}`);
      await database.query(`
        INSERT INTO work_queue_controls (queue_definition_id, scope_key, mode, reason, actor_json, updated_at_ms)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6)
        ON CONFLICT(queue_definition_id, scope_key) DO UPDATE SET
          mode = EXCLUDED.mode,
          reason = EXCLUDED.reason,
          actor_json = EXCLUDED.actor_json,
          updated_at_ms = EXCLUDED.updated_at_ms
      `, [queueDefinitionId, scopeKey, mode, toText(input.reason), JSON.stringify(input.actor || {}), nowMs]);
      return { queueDefinitionId, scopeKey, mode, reason: toText(input.reason), updatedAtMs: nowMs };
    },
    pause(input: QueueCommandInput = {}) {
      return store.setQueueControl({ ...input, mode: "paused" });
    },
    resume(input: QueueCommandInput = {}) {
      return store.setQueueControl({ ...input, mode: "active" });
    },
    drain(input: QueueCommandInput = {}) {
      return store.setQueueControl({ ...input, mode: "draining" });
    },
    async getQueueControl(input: QueueCommandInput = {}) {
      const queueDefinitionId = toText(input.queueDefinitionId || input.queueDefinition?.queueDefinitionId);
      if (!queueDefinitionId) throw new Error("queueDefinitionId is required.");
      const scopeKey = input.scopeKey || (input.scope ? scopeKeyFromScope(input.scope) : "");
      const row = await queryOne<FullQueueControlRow>(database, `
        SELECT *
        FROM work_queue_controls
        WHERE queue_definition_id = $1 AND scope_key = $2
      `, [queueDefinitionId, scopeKey]);
      if (!row) {
        return { queueDefinitionId, scopeKey, mode: "active", reason: "", updatedAtMs: 0 };
      }
      return {
        queueDefinitionId: row.queue_definition_id,
        scopeKey: row.scope_key,
        mode: row.mode,
        reason: row.reason || "",
        actor: parseJson(row.actor_json, {}),
        updatedAtMs: Number(row.updated_at_ms || 0)
      };
    },
    async recordBackgroundWrite(aspectType?: unknown, input: QueueCommandInput = {}) {
      return withTransaction(database, (client) => recordBackgroundWriteInternal(client, aspectType, input));
    },
    async writeFallbackCoordinatorState(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const fallbackTaskId = toText(input.fallbackTaskId || input.entityId || identityGenerator.fallbackTaskId());
        if (input.workItemId) {
          await client.query(`
            INSERT INTO work_queue_fallback_tasks (
              fallback_task_id, work_item_id, state, attempt, max_attempts,
              reason, decision_json, created_at_ms, updated_at_ms
            ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
            ON CONFLICT(fallback_task_id) DO UPDATE SET
              state = EXCLUDED.state,
              attempt = EXCLUDED.attempt,
              max_attempts = EXCLUDED.max_attempts,
              reason = EXCLUDED.reason,
              decision_json = EXCLUDED.decision_json,
              updated_at_ms = EXCLUDED.updated_at_ms
          `, [
            fallbackTaskId,
            toText(input.workItemId),
            toText((asObject(input.state) || {}).state || input.status || "queued"),
            asInt(input.attempt, 0),
            asInt(input.maxAttempts, resolvedPolicy.fallbackRetry.maxAttempts),
            toText(input.reason),
            JSON.stringify(input.state || input.decision || {}),
            nowMs,
            nowMs
          ]);
        }
        return recordBackgroundWriteInternal(client, "fallback_coordinator", { ...input, entityId: fallbackTaskId, nowMs });
      });
    },
    writeSnapshotState(input: QueueCommandInput = {}) {
      return store.recordBackgroundWrite("snapshot", input);
    },
    writeCompactionState(input: QueueCommandInput = {}) {
      return store.recordBackgroundWrite("compaction", input);
    },
    async writeInternalHealthState(input: QueueCommandInput = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const healthKey = toText(input.healthKey || input.entityId || "default");
        await client.query(`
          INSERT INTO work_queue_internal_health (health_key, state_json, updated_at_ms)
          VALUES ($1,$2::jsonb,$3)
          ON CONFLICT(health_key) DO UPDATE SET
            state_json = EXCLUDED.state_json,
            updated_at_ms = EXCLUDED.updated_at_ms
        `, [healthKey, JSON.stringify(input.state || input.value || input || {}), nowMs]);
        return recordBackgroundWriteInternal(client, "internal_health", { ...input, entityId: healthKey, nowMs });
      });
    },
    async close(): Promise<void> {
      if (ownsPool) {
        await database.end();
      }
    }
  };

  return Object.freeze(store);
}
