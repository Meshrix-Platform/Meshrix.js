import pg from "pg";

import { queueIdentityGenerator } from "./identity.mjs";
import { computeDeterministicRetryDelay, DEFAULT_QUEUE_POLICY } from "./policies.mjs";
import {
  assertLegalWorkQueueTransition,
  isTerminalWorkQueueState,
  WORK_QUEUE_STATES
} from "../workflow/state-machine/work-queue/state-machine.mjs";
import { systemQueueTimeSource } from "./time-source.mjs";
import { ensurePostgresWorkQueueSchema } from "./postgres-schema.mjs";
import {
  createPostgresWorkQueueRuntime,
  queryOne,
  withTransaction
} from "./postgres-store-runtime.mjs";
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
} from "./store-serialization.mjs";
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

const { Pool } = pg;
const WORK_ITEM_PROJECTION_COLUMNS = Object.freeze([
  "work_item_id", "queue_definition_id", "queue_definition_version", "scope_key", "scope_json",
  "dedupe_key", "state", "owner_ref_json", "payload_ref_json", "payload_kind", "priority",
  "priority_class", "tenant_id", "workspace_id", "project_id",
  "available_at_ms", "expires_at_ms", "attempt", "max_attempts", "lease_id", "lease_seq",
  "leased_by_worker_id", "lease_expires_at_ms", "concurrency_key", "route_version",
  "policy_version", "fallback_task_id", "last_error_json", "checkpoint_ref_json",
  "checkpoint_digest", "checkpoint_seq", "checkpoint_updated_at_ms", "last_transition_seq",
  "created_at_ms", "updated_at_ms"
]);
const WORK_ITEM_JSON_COLUMNS = new Set([
  "scope_json", "owner_ref_json", "payload_ref_json", "last_error_json", "checkpoint_ref_json"
]);

function sqlValues(row, columns) {
  return columns.map((column) => row[column]);
}

function insertPlaceholders(columns, offset = 0) {
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
} = {}) {
  const resolvedPolicy = getPolicy(policy);
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
    requireLeasedRow
  } = createPostgresWorkQueueRuntime({ timeSource, identityGenerator, resolvedPolicy });

  async function cleanupFairnessCursorsIfIdle(client, row) {
    if (!row || !isTerminalWorkQueueState(row.state)) return;
    const remaining = await queryOne(client, `
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
        DELETE FROM work_queue_fairness_cursors
        WHERE queue_definition_id = $1 AND selector_scope_key = $2
      `, [row.queue_definition_id, row.scope_key]);
    }
  }

  async function transitionProjection(client, input) {
    const updated = await transitionProjectionInternal(client, input);
    await cleanupFairnessCursorsIfIdle(client, updated);
    return updated;
  }

  async function boundedCount(client, {
    queueDefinitionId,
    states,
    tenantId = "",
    workspaceId = "",
    projectId = "",
    limit
  }) {
    const row = await queryOne(client, `
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

  async function assertAdmissionCapacity(client, { queueDefinitionId, hierarchy, state, policy }) {
    const capacity = policy.capacity;
    const states = [
      WORK_QUEUE_STATES.QUEUED,
      WORK_QUEUE_STATES.RETRY_WAIT,
      WORK_QUEUE_STATES.RUNNING,
      WORK_QUEUE_STATES.RECOVERED
    ];
    const checks = [
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

  async function lockQueueCapacity(client, queueDefinitionId) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [String(queueDefinitionId || "")]
    );
  }

  async function lockedCursor(client, key, nowMs) {
    const values = [
      key.queueDefinitionId,
      key.queueDefinitionVersion,
      key.selectorScopeKey,
      key.priorityClass,
      key.level,
      key.parentKey
    ];
    await client.query(`
      INSERT INTO work_queue_fairness_cursors (
        queue_definition_id, queue_definition_version, selector_scope_key,
        priority_class, level, parent_key, cursor_value, updated_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,'',$7)
      ON CONFLICT DO NOTHING
    `, [...values, nowMs]);
    return queryOne(client, `
      SELECT cursor_value
      FROM work_queue_fairness_cursors
      WHERE queue_definition_id = $1
        AND queue_definition_version = $2
        AND selector_scope_key = $3
        AND priority_class = $4
        AND level = $5
        AND parent_key = $6
      FOR UPDATE
    `, values);
  }

  async function writeCursor(client, key, value, nowMs) {
    await client.query(`
      UPDATE work_queue_fairness_cursors
      SET cursor_value = $7, updated_at_ms = $8
      WHERE queue_definition_id = $1
        AND queue_definition_version = $2
        AND selector_scope_key = $3
        AND priority_class = $4
        AND level = $5
        AND parent_key = $6
    `, [
      key.queueDefinitionId,
      key.queueDefinitionVersion,
      key.selectorScopeKey,
      key.priorityClass,
      key.level,
      key.parentKey,
      String(value),
      nowMs
    ]);
  }

  async function nextPartition(client, {
    column,
    fixedValue,
    parentWhere = "",
    parentValues = [],
    base,
    key,
    nowMs
  }) {
    if (fixedValue) return fixedValue;
    const cursorRow = await lockedCursor(client, key, nowMs);
    const cursor = cursorRow?.cursor_value || "";
    const query = async (fromStart) => queryOne(client, `
      SELECT ${column} AS value
      FROM work_items
      WHERE queue_definition_id = $1
        AND ($2::integer = 0 OR queue_definition_version = $2)
        AND state = ANY($3::text[])
        AND priority_class = $4
        AND available_at_ms <= $5
        AND (expires_at_ms = 0 OR expires_at_ms > $5)
        AND scope_key = $6
        ${parentWhere}
        AND ($7::boolean OR ${column} > $8)
      GROUP BY ${column}
      ORDER BY ${column} ASC
      LIMIT 1
    `, [
      base.queueDefinitionId,
      base.queueDefinitionVersion,
      [WORK_QUEUE_STATES.QUEUED, WORK_QUEUE_STATES.RECOVERED],
      base.priorityClass,
      base.nowMs,
      base.scopeKey,
      fromStart,
      cursor,
      ...parentValues
    ]);
    let row = await query(false);
    if (!row) row = await query(true);
    if (!row) return null;
    await writeCursor(client, key, row.value, nowMs);
    return row.value;
  }

  async function policyForWorkItem(client, row) {
    const definition = await queryOne(client, `
      SELECT policy_json FROM queue_definitions
      WHERE queue_definition_id = $1 AND queue_definition_version = $2
    `, [row.queue_definition_id, row.queue_definition_version]);
    const override = parseJson(definition?.policy_json, {});
    return getPolicy({
      ...resolvedPolicy,
      ...override,
      capacity: { ...resolvedPolicy.capacity, ...(override.capacity || {}) },
      retention: { ...resolvedPolicy.retention, ...(override.retention || {}) }
    });
  }

  async function promoteAgedCandidates(client, { queueDefinitionId, queueDefinitionVersion, scopeKey, nowMs }) {
    const definition = await queryOne(client, `
      SELECT policy_json FROM queue_definitions
      WHERE queue_definition_id = $1
        AND ($2::integer = 0 OR queue_definition_version = $2)
      ORDER BY queue_definition_version DESC
      LIMIT 1
    `, [queueDefinitionId, queueDefinitionVersion]);
    const policy = getPolicy({
      ...resolvedPolicy,
      ...parseJson(definition?.policy_json, {})
    });
    const { agingIntervalMs, agingBatchSize } = policy.fairness;
    const selected = await client.query(`
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

  async function countUnderReservedPartitions(client, {
    queueDefinitionId,
    scopeKey,
    hierarchy,
    nowMs,
    reservation,
    limit,
    level
  }) {
    const row = await queryOne(client, `
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

  async function hasLeaseCapacity(client, queueDefinitionId, hierarchy, policy, { scopeKey, nowMs }) {
    const { capacity, fairness } = policy;
    const states = [WORK_QUEUE_STATES.RUNNING];
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

  function isWorkExpired(row, nowMs) {
    return Number(row?.expires_at_ms || 0) > 0 && Number(row.expires_at_ms) <= nowMs;
  }

  async function expireRow(client, row, nowMs, input = {}) {
    return transitionProjection(client, {
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

  async function selectFairCandidate(client, { queueDefinitionId, queueDefinitionVersion, scope, scopeKey, nowMs }) {
    const fixed = hierarchicalScopeParts(scope);
    const priorityKey = {
      queueDefinitionId,
      queueDefinitionVersion,
      selectorScopeKey: scopeKey,
      priorityClass: "*",
      level: "priority",
      parentKey: ""
    };
    const priorityRow = await lockedCursor(client, priorityKey, nowMs);
    let priorityCursor = Number(priorityRow?.cursor_value || 0);
    for (let priorityVisit = 0; priorityVisit < WORK_QUEUE_PRIORITY_CYCLE.length; priorityVisit += 1) {
      const priorityClass = priorityClassAtCursor(priorityCursor);
      priorityCursor = nextPriorityCursor(priorityCursor);
      await writeCursor(client, priorityKey, priorityCursor, nowMs);
      const base = { queueDefinitionId, queueDefinitionVersion, priorityClass, scopeKey, nowMs };
      const tenantId = await nextPartition(client, {
        column: "tenant_id",
        fixedValue: fixed.tenantId,
        base,
        key: { ...priorityKey, priorityClass, level: "tenant" },
        nowMs
      });
      if (tenantId === null) continue;
      const workspaceId = await nextPartition(client, {
        column: "workspace_id",
        fixedValue: fixed.workspaceId,
        parentWhere: "AND tenant_id = $9",
        parentValues: [tenantId],
        base,
        key: { ...priorityKey, priorityClass, level: "workspace", parentKey: tenantId },
        nowMs
      });
      if (workspaceId === null) continue;
      const projectId = await nextPartition(client, {
        column: "project_id",
        fixedValue: fixed.projectId,
        parentWhere: "AND tenant_id = $9 AND workspace_id = $10",
        parentValues: [tenantId, workspaceId],
        base,
        key: {
          ...priorityKey,
          priorityClass,
          level: "project",
          parentKey: JSON.stringify([tenantId, workspaceId])
        },
        nowMs
      });
      if (projectId === null) continue;
      const hierarchy = { tenantId, workspaceId, projectId };
      const candidate = await queryOne(client, `
      SELECT * FROM work_items candidate
      WHERE candidate.queue_definition_id = $1
        AND ($2::integer = 0 OR candidate.queue_definition_version = $2)
        AND candidate.state = ANY($3::text[])
        AND candidate.priority_class = $4
        AND candidate.available_at_ms <= $5
        AND (candidate.expires_at_ms = 0 OR candidate.expires_at_ms > $5)
        AND candidate.scope_key = $6
        AND candidate.tenant_id = $7
        AND candidate.workspace_id = $8
        AND candidate.project_id = $9
        AND NOT EXISTS (
          SELECT 1 FROM work_items active
          WHERE active.queue_definition_id = candidate.queue_definition_id
            AND active.scope_key = candidate.scope_key
            AND active.concurrency_key = candidate.concurrency_key
            AND active.concurrency_key <> ''
            AND active.state = $10
            AND active.work_item_id <> candidate.work_item_id
        )
      ORDER BY candidate.available_at_ms ASC, candidate.created_at_ms ASC, candidate.work_item_id ASC
      LIMIT 1
      FOR UPDATE OF candidate SKIP LOCKED
    `, [
      queueDefinitionId,
      queueDefinitionVersion,
      [WORK_QUEUE_STATES.QUEUED, WORK_QUEUE_STATES.RECOVERED],
      priorityClass,
      nowMs,
      scopeKey,
      tenantId,
      workspaceId,
      projectId,
      WORK_QUEUE_STATES.RUNNING
      ]);
      if (!candidate) continue;
      const policy = await policyForWorkItem(client, candidate);
      if (!await hasLeaseCapacity(client, queueDefinitionId, hierarchy, policy, { scopeKey, nowMs })) continue;
      return candidate;
    }
    return null;
  }

  const store = {
    database,
    kind: "postgres",
    async enqueue(input = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const { queueDefinitionId, queueDefinitionVersion, queueDefinition } = resolveQueueDefinition(input, { assertEnqueue: true });
        await lockQueueCapacity(client, queueDefinitionId);
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
          const existing = await queryOne(client, `
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
        const row = {
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
        } catch (error) {
          if (dedupeKey && error?.code === "23505") {
            const existing = await queryOne(client, `
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
        const inserted = await queryOne(client, "SELECT * FROM work_items WHERE work_item_id = $1", [row.work_item_id]);
        return { accepted: true, deduped: false, transitionSeq: seq, workItem: rowToWorkItem(inserted) };
      });
    },
    async claim(input = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const { queueDefinitionId, queueDefinitionVersion } = resolveQueueDefinition(input, { allowAllVersions: true });
        await lockQueueCapacity(client, queueDefinitionId);
        const scope = normalizeScope(input.scope || {});
        const schedulingScope = normalizeScope(input.schedulingScope ?? scope);
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
        const control = await queryOne(client, `
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
        const claimed = [];
        const failed = [];
        const maxVisits = Math.min(
          asPositiveInt(resolvedPolicy.fairness.maxVisitsPerClaim, 4096),
          Math.max(WORK_QUEUE_PRIORITY_CYCLE.length, batchSize * WORK_QUEUE_PRIORITY_CYCLE.length)
        );
        for (let visit = 0; visit < maxVisits && claimed.length < batchSize; visit += 1) {
          const row = await selectFairCandidate(client, {
            queueDefinitionId,
            queueDefinitionVersion: asInt(queueDefinitionVersion, 0),
            scope: schedulingScope,
            scopeKey,
            nowMs
          });
          if (!row) continue;
          if (Number(row.attempt || 0) >= Number(row.max_attempts || 0)) {
            const failedRow = await transitionProjection(client, {
              row,
              transition: "fail",
              toState: WORK_QUEUE_STATES.FAILED,
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
            toState: WORK_QUEUE_STATES.RUNNING,
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
        return { workerId, claimed, expired, recovered, matured, aged, failed };
      });
    },
    async expire(input = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const row = requireWorkItemBoundary(
          await queryOne(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]),
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
        return { expired: true, idempotent: false, workItem: rowToWorkItem(await expireRow(client, row, nowMs, input)) };
      });
    },
    async complete(input = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const current = await queryOne(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]);
        if (current?.state === WORK_QUEUE_STATES.COMPLETED) {
          const terminal = await queryOne(client, `
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
          return { completed: false, expired: true, workItem: rowToWorkItem(await expireRow(client, current, nowMs, input)) };
        }
        const row = await requireLeasedRow(client, input.workItemId, input.leaseId, nowMs);
        const updated = await transitionProjection(client, {
          row,
          transition: "complete",
          toState: WORK_QUEUE_STATES.COMPLETED,
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
        return { completed: true, workItem: rowToWorkItem(updated) };
      });
    },
    async retry(input = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const current = await queryOne(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]);
        if (isWorkExpired(current, nowMs)) {
          return { retried: false, expired: true, workItem: rowToWorkItem(await expireRow(client, current, nowMs, input)) };
        }
        const row = await requireLeasedRow(client, input.workItemId, input.leaseId, nowMs);
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
        const toState = exhausted
          ? WORK_QUEUE_STATES.FAILED
          : delayMs > 0
            ? WORK_QUEUE_STATES.RETRY_WAIT
            : WORK_QUEUE_STATES.QUEUED;
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
    async progress(input = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const current = await queryOne(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]);
        if (isWorkExpired(current, nowMs)) {
          return { progressed: false, expired: true, workItem: rowToWorkItem(await expireRow(client, current, nowMs, input)) };
        }
        const row = await requireLeasedRow(client, input.workItemId, input.leaseId, nowMs);
        const extendMs = Math.max(1, asInt(input.extendMs ?? input.leaseTimeoutMs, resolvedPolicy.leaseTimeoutMs));
        const leaseExpiresAtMs = Number(row.expires_at_ms || 0) > 0
          ? Math.min(nowMs + extendMs, Number(row.expires_at_ms))
          : nowMs + extendMs;
        const updated = await transitionProjection(client, {
          row,
          transition: "progress",
          toState: WORK_QUEUE_STATES.RUNNING,
          patch: { lease_expires_at_ms: leaseExpiresAtMs },
          nowMs,
          operationId: input.operationId,
          actor: input.actor,
          reason: input.reason || "progress"
        });
        return { progressed: true, lease: rowToWorkItem(updated).lease, workItem: rowToWorkItem(updated) };
      });
    },
    async checkpoint(input = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const row = await requireLeasedRow(client, input.workItemId, input.leaseId, nowMs);
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
        const updated = await queryOne(client, `
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
    async cancelRunning(input = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const current = await queryOne(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]);
        if (current?.state === WORK_QUEUE_STATES.CANCELLED) {
          const terminal = await queryOne(client, `
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
          return { cancelled: false, expired: true, workItem: rowToWorkItem(await expireRow(client, current, nowMs, input)) };
        }
        const row = await requireLeasedRow(client, input.workItemId, input.leaseId, nowMs);
        const updated = await transitionProjection(client, {
          row,
          transition: "cancel_running",
          toState: WORK_QUEUE_STATES.CANCELLED,
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
    async cancel(input = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const row = requireWorkItemBoundary(
          await queryOne(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]),
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
        if (![
          WORK_QUEUE_STATES.QUEUED,
          WORK_QUEUE_STATES.RETRY_WAIT,
          WORK_QUEUE_STATES.RUNNING,
          WORK_QUEUE_STATES.RECOVERED
        ].includes(row.state)) {
          throw new Error(`Work item ${input.workItemId} cannot be cancelled from state ${row.state}.`);
        }
        const updated = await transitionProjection(client, {
          row,
          transition: "cancel",
          toState: WORK_QUEUE_STATES.CANCELLED,
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
    async fail(input = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        let row = requireWorkItemBoundary(
          await queryOne(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]),
          input
        );
        if (isTerminalWorkQueueState(row.state)) throw new Error(`Cannot fail terminal work item ${input.workItemId}.`);
        if (isWorkExpired(row, nowMs)) {
          return { failed: false, expired: true, workItem: rowToWorkItem(await expireRow(client, row, nowMs, input)) };
        }
        if (row.state === WORK_QUEUE_STATES.RUNNING) {
          row = await requireLeasedRow(client, input.workItemId, input.leaseId, nowMs);
        }
        const fallbackTaskId = toText(input.fallbackTaskId);
        const updated = await transitionProjection(client, {
          row,
          transition: "fail",
          toState: WORK_QUEUE_STATES.FAILED,
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
        return { failed: true, fallbackTaskId, workItem: rowToWorkItem(updated) };
      });
    },
    async recover(input = {}) {
      return withTransaction(database, async (client) => {
        const nowMs = nowFrom(timeSource, input.nowMs);
        const row = requireWorkItemBoundary(
          await queryOne(client, "SELECT * FROM work_items WHERE work_item_id = $1 FOR UPDATE", [toText(input.workItemId)]),
          input
        );
        if (isWorkExpired(row, nowMs)) {
          throw new Error(`Work item ${input.workItemId} cannot be recovered after its deadline.`);
        }
        await lockQueueCapacity(client, row.queue_definition_id);
        const definition = await queryOne(client, `
          SELECT policy_json FROM queue_definitions
          WHERE queue_definition_id = $1 AND queue_definition_version = $2
        `, [row.queue_definition_id, row.queue_definition_version]);
        const override = parseJson(definition?.policy_json, {});
        const policyForItem = getPolicy({
          ...resolvedPolicy,
          ...override,
          capacity: { ...resolvedPolicy.capacity, ...(override.capacity || {}) },
          retention: { ...resolvedPolicy.retention, ...(override.retention || {}) }
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
          toState: WORK_QUEUE_STATES.RECOVERED,
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
    async inspect(input = {}) {
      if (input.workItemId) {
        const row = await queryOne(database, "SELECT * FROM work_items WHERE work_item_id = $1", [toText(input.workItemId)]);
        if (!workItemMatchesBoundary(row, input)) return { workItem: null, journal: [] };
        const journal = input.includeJournal
          ? (await database.query("SELECT * FROM work_queue_transition_journal WHERE work_item_id = $1 ORDER BY seq ASC", [row.work_item_id])).rows.map(journalRowToTransition)
          : [];
        return { workItem: rowToWorkItem(row), journal };
      }
      const queueDefinitionId = toText(input.queueDefinitionId || input.queueDefinition?.queueDefinitionId);
      const scopeKey = input.scopeKey || (input.scope ? scopeKeyFromScope(input.scope) : "");
      const states = asArray(input.states, []).map(toText).filter(Boolean);
      const limit = Math.max(1, Math.min(asInt(input.limit, 100), 1000));
      const where = [];
      const params = [];
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
      const items = (await database.query(`
        SELECT *
        FROM work_items
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY priority DESC, available_at_ms ASC, created_at_ms ASC
        LIMIT $${params.length}
      `, params)).rows.map(rowToWorkItem);
      const countParams = [];
      const countWhere = [];
      if (queueDefinitionId) {
        countParams.push(queueDefinitionId);
        countWhere.push(`queue_definition_id = $${countParams.length}`);
      }
      if (scopeKey) {
        countParams.push(scopeKey);
        countWhere.push(`scope_key = $${countParams.length}`);
      }
      const stateCounts = (await database.query(`
        SELECT state, COUNT(*)::integer AS count
        FROM work_items
        ${countWhere.length ? `WHERE ${countWhere.join(" AND ")}` : ""}
        GROUP BY state
        ORDER BY state ASC
      `, countParams)).rows.map((row) => ({ state: row.state, count: Number(row.count || 0) }));
      return { items, stateCounts };
    },
    async rebuildProjection(input = {}) {
      return withTransaction(database, async (client) => {
        const journalRows = (await client.query("SELECT * FROM work_queue_transition_journal ORDER BY seq ASC")).rows;
        const replayed = new Map();
        const errors = [];
        for (const journalRow of journalRows) {
          const event = journalRowToTransition(journalRow);
          const current = replayed.get(event.workItemId) || null;
          try {
            assertLegalWorkQueueTransition({
              transition: event.transition,
              fromState: current ? current.state : null,
              toState: event.toState
            });
          } catch (error) {
            errors.push({ seq: event.seq, workItemId: event.workItemId, error: error.message });
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
        const actualRows = (await client.query("SELECT * FROM work_items ORDER BY work_item_id ASC")).rows;
        const drift = [];
        const actualIds = new Set(actualRows.map((row) => row.work_item_id));
        for (const actual of actualRows) {
          const expected = replayed.get(actual.work_item_id);
          if (!expected) {
            drift.push({ workItemId: actual.work_item_id, reason: "missing_from_replay" });
            continue;
          }
          for (const column of ["state", "attempt", "lease_id", "lease_seq", "leased_by_worker_id", "lease_expires_at_ms", "expires_at_ms", "available_at_ms"]) {
            const expectedValue = column === "expires_at_ms" ? expected[column] ?? 0 : expected[column] ?? "";
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
            const values = Object.fromEntries(WORK_ITEM_PROJECTION_COLUMNS.map((column) => [
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
    async registerQueueDefinition(definition = {}) {
      const nowMs = nowFrom(timeSource, definition.nowMs);
      const queueDefinitionId = toText(definition.queueDefinitionId || definition.id);
      if (!queueDefinitionId) throw new Error("queueDefinitionId is required.");
      const label = toText(definition.label);
      if (!label) throw new Error("Queue definition label is required.");
      const queueDefinitionVersion = asPositiveInt(definition.queueDefinitionVersion ?? definition.version, 1);
      const snapshot = queueDefinitionSnapshot({
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
        const existing = await queryOne(client, `
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
        const conflictingLabel = await queryOne(client, `
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
    async setQueueControl(input = {}) {
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
    pause(input = {}) {
      return store.setQueueControl({ ...input, mode: "paused" });
    },
    resume(input = {}) {
      return store.setQueueControl({ ...input, mode: "active" });
    },
    drain(input = {}) {
      return store.setQueueControl({ ...input, mode: "draining" });
    },
    async getQueueControl(input = {}) {
      const queueDefinitionId = toText(input.queueDefinitionId || input.queueDefinition?.queueDefinitionId);
      if (!queueDefinitionId) throw new Error("queueDefinitionId is required.");
      const scopeKey = input.scopeKey || (input.scope ? scopeKeyFromScope(input.scope) : "");
      const row = await queryOne(database, `
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
    async recordBackgroundWrite(aspectType, input = {}) {
      return withTransaction(database, (client) => recordBackgroundWriteInternal(client, aspectType, input));
    },
    async writeFallbackCoordinatorState(input = {}) {
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
            toText(input.state?.state || input.status || "queued"),
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
    writeSnapshotState(input = {}) {
      return store.recordBackgroundWrite("snapshot", input);
    },
    writeCompactionState(input = {}) {
      return store.recordBackgroundWrite("compaction", input);
    },
    async writeInternalHealthState(input = {}) {
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
    async close() {
      if (ownsPool) {
        await database.end();
      }
    }
  };

  return Object.freeze(store);
}
