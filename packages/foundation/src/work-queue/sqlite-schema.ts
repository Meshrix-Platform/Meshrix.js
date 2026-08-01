import { runMigrations } from "../storage/sqlite-migrations.ts";
const SQLITE_BASE_MIGRATION_REVISION: any = 1;
const SQLITE_DEDUPE_MIGRATION_REVISION: any = 2;
const SQLITE_SCHEDULING_MIGRATION_REVISION: any = 3;
const SQLITE_EXPIRY_MIGRATION_REVISION: any = 5;
const SQLITE_RETENTION_MIGRATION_REVISION: any = 7;
const SQLITE_DEFINITION_IMMUTABILITY_MIGRATION_REVISION: any = 8;
const SQLITE_CHECKPOINT_MIGRATION_REVISION: any = 9;

export function ensureSqliteWorkQueueSchema(db?: any) : any {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  runMigrations(db, [
    {
      version: SQLITE_BASE_MIGRATION_REVISION,
      up: (migrationDb?: any) : any => migrationDb.exec(`
        CREATE TABLE IF NOT EXISTS queue_definitions (
          queue_definition_id TEXT NOT NULL,
          queue_definition_version INTEGER NOT NULL,
          label TEXT NOT NULL,
          lifecycle_state TEXT NOT NULL,
          owner_capability TEXT NOT NULL,
          allow_deprecated_enqueue INTEGER NOT NULL DEFAULT 0,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          policy_json TEXT NOT NULL DEFAULT '{}',
          routes_json TEXT NOT NULL DEFAULT '[]',
          label_history_json TEXT NOT NULL DEFAULT '[]',
          registered_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (queue_definition_id, queue_definition_version),
          UNIQUE (label)
        );

        CREATE TABLE IF NOT EXISTS work_items (
          work_item_id TEXT PRIMARY KEY,
          queue_definition_id TEXT NOT NULL,
          queue_definition_version INTEGER NOT NULL,
          scope_key TEXT NOT NULL,
          scope_json TEXT NOT NULL,
          dedupe_key TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL,
          owner_ref_json TEXT NOT NULL DEFAULT '{}',
          payload_ref_json TEXT NOT NULL DEFAULT '{}',
          payload_kind TEXT NOT NULL DEFAULT '',
          priority INTEGER NOT NULL DEFAULT 0,
          available_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL,
          lease_id TEXT NOT NULL DEFAULT '',
          lease_seq INTEGER NOT NULL DEFAULT 0,
          leased_by_worker_id TEXT NOT NULL DEFAULT '',
          lease_expires_at_ms INTEGER NOT NULL DEFAULT 0,
          concurrency_key TEXT NOT NULL DEFAULT '',
          route_version TEXT NOT NULL DEFAULT '',
          policy_version TEXT NOT NULL DEFAULT '',
          fallback_task_id TEXT NOT NULL DEFAULT '',
          checkpoint_ref_json TEXT NOT NULL DEFAULT '{}',
          checkpoint_digest TEXT NOT NULL DEFAULT '',
          checkpoint_seq INTEGER NOT NULL DEFAULT 0,
          checkpoint_updated_at_ms INTEGER NOT NULL DEFAULT 0,
          last_error_json TEXT NOT NULL DEFAULT '{}',
          last_transition_seq INTEGER NOT NULL DEFAULT 0,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_work_queue_claim
          ON work_items(queue_definition_id, scope_key, state, available_at_ms, priority, created_at_ms);

        CREATE INDEX IF NOT EXISTS idx_work_queue_lease_expiry
          ON work_items(state, lease_expires_at_ms);

        CREATE INDEX IF NOT EXISTS idx_work_queue_concurrency
          ON work_items(queue_definition_id, scope_key, concurrency_key, state);

        CREATE TABLE IF NOT EXISTS work_queue_transition_journal (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
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
          actor_json TEXT NOT NULL DEFAULT '{}',
          reason TEXT NOT NULL DEFAULT '',
          policy_version TEXT NOT NULL DEFAULT '',
          decision_json TEXT NOT NULL DEFAULT '{}',
          created_at_ms INTEGER NOT NULL,
          adopted_time_ms INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_work_queue_journal_item
          ON work_queue_transition_journal(work_item_id, seq);

        CREATE INDEX IF NOT EXISTS idx_work_queue_journal_queue
          ON work_queue_transition_journal(queue_definition_id, queue_definition_version, seq);

        CREATE TABLE IF NOT EXISTS work_queue_background_writes (
          background_write_id TEXT PRIMARY KEY,
          aspect_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          state_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'committed',
          attempt INTEGER NOT NULL DEFAULT 0,
          next_retry_at_ms INTEGER NOT NULL DEFAULT 0,
          last_error_json TEXT NOT NULL DEFAULT '{}',
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_work_queue_background_writes_type_entity
          ON work_queue_background_writes(aspect_type, entity_id);

        CREATE TABLE IF NOT EXISTS work_queue_fallback_tasks (
          fallback_task_id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL,
          state TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 0,
          reason TEXT NOT NULL DEFAULT '',
          decision_json TEXT NOT NULL DEFAULT '{}',
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS work_queue_internal_health (
          health_key TEXT PRIMARY KEY,
          state_json TEXT NOT NULL DEFAULT '{}',
          updated_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS work_queue_controls (
          queue_definition_id TEXT NOT NULL,
          scope_key TEXT NOT NULL DEFAULT '',
          mode TEXT NOT NULL DEFAULT 'active',
          reason TEXT NOT NULL DEFAULT '',
          actor_json TEXT NOT NULL DEFAULT '{}',
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (queue_definition_id, scope_key)
        );
      `)
    },
    {
      version: SQLITE_DEDUPE_MIGRATION_REVISION,
      up: (migrationDb?: any) : any => migrationDb.exec(`
        DROP INDEX IF EXISTS idx_work_queue_dedupe_nonterminal;

        WITH ranked AS (
          SELECT rowid,
                 ROW_NUMBER() OVER (
                   PARTITION BY queue_definition_id, scope_key, dedupe_key
                   ORDER BY created_at_ms ASC, work_item_id ASC
                 ) AS duplicate_rank
          FROM work_items
          WHERE dedupe_key <> ''
        )
        UPDATE work_items
        SET dedupe_key = ''
        WHERE rowid IN (SELECT rowid FROM ranked WHERE duplicate_rank > 1);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_queue_dedupe
          ON work_items(queue_definition_id, scope_key, dedupe_key)
          WHERE dedupe_key <> '';
      `)
    },
    {
      version: SQLITE_SCHEDULING_MIGRATION_REVISION,
      up: (migrationDb?: any) : any => migrationDb.exec(`
        ALTER TABLE work_items ADD COLUMN priority_class TEXT NOT NULL DEFAULT 'normal';
        ALTER TABLE work_items ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE work_items ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE work_items ADD COLUMN project_id TEXT NOT NULL DEFAULT '';

        UPDATE work_items
        SET priority_class = CASE
              WHEN priority >= 2 THEN 'critical'
              WHEN priority = 1 THEN 'high'
              WHEN priority < 0 THEN 'low'
              ELSE 'normal'
            END,
            tenant_id = COALESCE(json_extract(scope_json, '$.tenantId'), ''),
            workspace_id = COALESCE(json_extract(scope_json, '$.workspaceId'), ''),
            project_id = COALESCE(json_extract(scope_json, '$.projectId'), '');

        CREATE INDEX IF NOT EXISTS idx_work_queue_hierarchical_claim
          ON work_items(
            queue_definition_id, state, priority_class,
            tenant_id, workspace_id, project_id,
            available_at_ms, created_at_ms, work_item_id
          );

        CREATE INDEX IF NOT EXISTS idx_work_queue_hierarchical_capacity
          ON work_items(
            queue_definition_id, state,
            tenant_id, workspace_id, project_id
          );

        CREATE TABLE IF NOT EXISTS work_queue_fairness_cursors (
          queue_definition_id TEXT NOT NULL,
          queue_definition_version INTEGER NOT NULL,
          selector_scope_key TEXT NOT NULL,
          priority_class TEXT NOT NULL,
          level TEXT NOT NULL,
          parent_key TEXT NOT NULL,
          cursor_value TEXT NOT NULL DEFAULT '',
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (
            queue_definition_id, queue_definition_version, selector_scope_key,
            priority_class, level, parent_key
          )
        );
      `)
    },
    {
      version: SQLITE_EXPIRY_MIGRATION_REVISION,
      up: (migrationDb?: any) : any => {
        const columns: any = new Set<any>(
          migrationDb.prepare("PRAGMA table_info(work_items)").all().map((column?: any) : any => column.name)
        );
        if (!columns.has("expires_at_ms")) {
          migrationDb.exec("ALTER TABLE work_items ADD COLUMN expires_at_ms INTEGER NOT NULL DEFAULT 0;");
        }
        migrationDb.exec(`
          DELETE FROM work_queue_fairness_cursors
          WHERE instr(parent_key, char(0)) > 0;

          CREATE INDEX IF NOT EXISTS idx_work_queue_work_expiry
            ON work_items(state, expires_at_ms);
        `);
      }
    },
    {
      version: SQLITE_RETENTION_MIGRATION_REVISION,
      up: (migrationDb?: any) : any => {
        const columns: any = new Set<any>(
          migrationDb.prepare("PRAGMA table_info(work_items)").all().map((column?: any) : any => column.name)
        );
        if (["queue_definition_id", "state", "updated_at_ms", "work_item_id"].every((column?: any) : any => columns.has(column))) {
          migrationDb.exec(`
            CREATE INDEX IF NOT EXISTS idx_work_queue_retention
              ON work_items(queue_definition_id, state, updated_at_ms, work_item_id);
          `);
        }
        const hasJournal: any = Boolean(migrationDb.prepare(`
          SELECT 1 AS present FROM sqlite_master
          WHERE type = 'table' AND name = 'work_queue_transition_journal'
        `).get());
        if (hasJournal) {
          migrationDb.exec(`
            CREATE INDEX IF NOT EXISTS idx_work_queue_journal_queue_item
              ON work_queue_transition_journal(queue_definition_id, work_item_id, seq);
          `);
        }
      }
    },
    {
      version: SQLITE_DEFINITION_IMMUTABILITY_MIGRATION_REVISION,
      up: (migrationDb?: any) : any => migrationDb.exec(`
        ALTER TABLE queue_definitions RENAME TO queue_definitions_with_legacy_label_constraint;

        CREATE TABLE queue_definitions (
          queue_definition_id TEXT NOT NULL,
          queue_definition_version INTEGER NOT NULL,
          label TEXT NOT NULL,
          lifecycle_state TEXT NOT NULL,
          owner_capability TEXT NOT NULL,
          allow_deprecated_enqueue INTEGER NOT NULL DEFAULT 0,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          policy_json TEXT NOT NULL DEFAULT '{}',
          routes_json TEXT NOT NULL DEFAULT '[]',
          label_history_json TEXT NOT NULL DEFAULT '[]',
          registered_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (queue_definition_id, queue_definition_version)
        );

        INSERT INTO queue_definitions
        SELECT * FROM queue_definitions_with_legacy_label_constraint;

        DROP TABLE queue_definitions_with_legacy_label_constraint;

        CREATE INDEX idx_work_queue_definition_label
          ON queue_definitions(label);
      `)
    },
    {
      version: SQLITE_CHECKPOINT_MIGRATION_REVISION,
      up: (migrationDb?: any) : any => {
        const columns: any = new Set<any>(
          migrationDb.prepare("PRAGMA table_info(work_items)").all().map((column?: any) : any => column.name)
        );
        for (const [column, declaration] of [
          ["checkpoint_ref_json", "TEXT NOT NULL DEFAULT '{}'"],
          ["checkpoint_digest", "TEXT NOT NULL DEFAULT ''"],
          ["checkpoint_seq", "INTEGER NOT NULL DEFAULT 0"],
          ["checkpoint_updated_at_ms", "INTEGER NOT NULL DEFAULT 0"]
        ]) {
          if (!columns.has(column)) migrationDb.exec(`ALTER TABLE work_items ADD COLUMN ${column} ${declaration};`);
        }
      }
    }
  ]);
}
