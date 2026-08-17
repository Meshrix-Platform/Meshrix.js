interface PostgresSchemaPool {
  query(sql: string): Promise<unknown>;
}

const POSTGRES_MIGRATION_REVISION = 12;

export async function ensurePostgresWorkQueueSchema(pool?: PostgresSchemaPool): Promise<void> {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("Postgres work queue schema pool is required.");
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS work_queue_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at_ms BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_definitions (
      queue_definition_id TEXT NOT NULL,
      queue_definition_version INTEGER NOT NULL,
      label TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      owner_capability TEXT NOT NULL,
      allow_deprecated_enqueue BOOLEAN NOT NULL DEFAULT FALSE,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      routes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      label_history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      registered_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL,
      PRIMARY KEY (queue_definition_id, queue_definition_version)
    );

    ALTER TABLE queue_definitions
      DROP CONSTRAINT IF EXISTS queue_definitions_label_key;

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_definition_label
      ON queue_definitions(label);

    CREATE TABLE IF NOT EXISTS work_items (
      work_item_id TEXT PRIMARY KEY,
      queue_definition_id TEXT NOT NULL,
      queue_definition_version INTEGER NOT NULL,
      scope_key TEXT NOT NULL,
      scope_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      dedupe_key TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      owner_ref_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      payload_ref_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      payload_kind TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0,
      available_at_ms BIGINT NOT NULL,
      expires_at_ms BIGINT NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL,
      lease_id TEXT NOT NULL DEFAULT '',
      lease_seq INTEGER NOT NULL DEFAULT 0,
      leased_by_worker_id TEXT NOT NULL DEFAULT '',
      lease_expires_at_ms BIGINT NOT NULL DEFAULT 0,
      concurrency_key TEXT NOT NULL DEFAULT '',
      route_version TEXT NOT NULL DEFAULT '',
      policy_version TEXT NOT NULL DEFAULT '',
      fallback_task_id TEXT NOT NULL DEFAULT '',
      checkpoint_ref_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      checkpoint_digest TEXT NOT NULL DEFAULT '',
      checkpoint_seq INTEGER NOT NULL DEFAULT 0,
      checkpoint_updated_at_ms BIGINT NOT NULL DEFAULT 0,
      last_error_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_transition_seq BIGINT NOT NULL DEFAULT 0,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_claim
      ON work_items(queue_definition_id, scope_key, state, available_at_ms, priority, created_at_ms);

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_lease_expiry
      ON work_items(state, lease_expires_at_ms);

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_concurrency
      ON work_items(queue_definition_id, scope_key, concurrency_key, state);

    ALTER TABLE work_items ADD COLUMN IF NOT EXISTS priority_class TEXT NOT NULL DEFAULT 'normal';
    ALTER TABLE work_items ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE work_items ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE work_items ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE work_items ADD COLUMN IF NOT EXISTS expires_at_ms BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE work_items ADD COLUMN IF NOT EXISTS checkpoint_ref_json JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE work_items ADD COLUMN IF NOT EXISTS checkpoint_digest TEXT NOT NULL DEFAULT '';
    ALTER TABLE work_items ADD COLUMN IF NOT EXISTS checkpoint_seq INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE work_items ADD COLUMN IF NOT EXISTS checkpoint_updated_at_ms BIGINT NOT NULL DEFAULT 0;

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_work_expiry
      ON work_items(state, expires_at_ms);

    UPDATE work_items
    SET priority_class = CASE
          WHEN priority >= 2 THEN 'critical'
          WHEN priority = 1 THEN 'high'
          WHEN priority < 0 THEN 'low'
          ELSE 'normal'
        END,
        tenant_id = COALESCE(scope_json->>'tenantId', ''),
        workspace_id = COALESCE(scope_json->>'workspaceId', ''),
        project_id = COALESCE(scope_json->>'projectId', '');

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_hierarchical_claim
      ON work_items(
        queue_definition_id, state, priority_class,
        tenant_id, workspace_id, project_id,
        available_at_ms, created_at_ms, work_item_id
      );

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_hierarchical_capacity
      ON work_items(
        queue_definition_id, state,
        tenant_id, workspace_id, project_id
      );

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_retention
      ON work_items(queue_definition_id, state, updated_at_ms, work_item_id);

    DROP TABLE IF EXISTS work_queue_fairness_cursors;

    CREATE TABLE IF NOT EXISTS work_queue_virtual_finish (
      queue_definition_id TEXT NOT NULL,
      queue_definition_version INTEGER NOT NULL,
      selector_scope_key TEXT NOT NULL,
      priority_class TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      virtual_finish BIGINT NOT NULL DEFAULT 0,
      updated_at_ms BIGINT NOT NULL,
      PRIMARY KEY (
        queue_definition_id, queue_definition_version, selector_scope_key,
        priority_class, tenant_id, workspace_id, project_id
      )
    );

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_virtual_finish_claim
      ON work_queue_virtual_finish(queue_definition_id, selector_scope_key, priority_class, virtual_finish);

    CREATE TABLE IF NOT EXISTS work_queue_retention_state (
      queue_definition_id TEXT PRIMARY KEY,
      pending_transitions INTEGER NOT NULL DEFAULT 0,
      updated_at_ms BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_queue_transition_journal (
      seq BIGSERIAL PRIMARY KEY,
      journal_entry_id TEXT NOT NULL UNIQUE,
      work_item_id TEXT NOT NULL,
      queue_definition_id TEXT NOT NULL,
      queue_definition_version INTEGER NOT NULL,
      transition TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      lease_id TEXT NOT NULL DEFAULT '',
      lease_seq INTEGER NOT NULL DEFAULT 0,
      operation_id TEXT NOT NULL DEFAULT '',
      actor_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      reason TEXT NOT NULL DEFAULT '',
      policy_version TEXT NOT NULL DEFAULT '',
      decision_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at_ms BIGINT NOT NULL,
      adopted_time_ms BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_journal_item
      ON work_queue_transition_journal(work_item_id, seq);

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_journal_queue
      ON work_queue_transition_journal(queue_definition_id, queue_definition_version, seq);

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_journal_queue_item
      ON work_queue_transition_journal(queue_definition_id, work_item_id, seq);

    CREATE TABLE IF NOT EXISTS work_queue_background_writes (
      background_write_id TEXT PRIMARY KEY,
      aspect_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'committed',
      attempt INTEGER NOT NULL DEFAULT 0,
      next_retry_at_ms BIGINT NOT NULL DEFAULT 0,
      last_error_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_background_writes_type_entity
      ON work_queue_background_writes(aspect_type, entity_id);

    CREATE TABLE IF NOT EXISTS work_queue_fallback_tasks (
      fallback_task_id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      decision_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_fallback_work_item
      ON work_queue_fallback_tasks(work_item_id);

    CREATE TABLE IF NOT EXISTS work_queue_internal_health (
      health_key TEXT PRIMARY KEY,
      state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at_ms BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_queue_controls (
      queue_definition_id TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'active',
      reason TEXT NOT NULL DEFAULT '',
      actor_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at_ms BIGINT NOT NULL,
      PRIMARY KEY (queue_definition_id, scope_key)
    );

    DROP INDEX IF EXISTS idx_work_queue_pg_dedupe_nonterminal;

    WITH ranked AS (
      SELECT work_item_id,
             ROW_NUMBER() OVER (
               PARTITION BY queue_definition_id, scope_key, dedupe_key
               ORDER BY created_at_ms ASC, work_item_id ASC
             ) AS duplicate_rank
      FROM work_items
      WHERE dedupe_key <> ''
    )
    UPDATE work_items
    SET dedupe_key = ''
    WHERE work_item_id IN (
      SELECT work_item_id FROM ranked WHERE duplicate_rank > 1
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_queue_pg_dedupe
      ON work_items(queue_definition_id, scope_key, dedupe_key)
      WHERE dedupe_key <> '';

    CREATE TABLE IF NOT EXISTS work_queue_sink_fences (
      work_item_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      sink_id TEXT NOT NULL,
      effect_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'settled',
      settled_at_ms BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (work_item_id, generation, sink_id)
    );

    CREATE INDEX IF NOT EXISTS idx_work_queue_pg_sink_fence_item
      ON work_queue_sink_fences(work_item_id, generation);

    INSERT INTO work_queue_schema_migrations(version, applied_at_ms)
    VALUES (${POSTGRES_MIGRATION_REVISION}, ${Date.now()})
    ON CONFLICT(version) DO NOTHING;
  `);
}
