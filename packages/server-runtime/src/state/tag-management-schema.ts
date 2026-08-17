import type Database from "better-sqlite3";

export function ensureTagManagementSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS tag_management_tags (
      tag_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      parent_tag_id TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      system INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      scope_prerequisites_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tag_management_projections (
      tag_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tag_id, entity_type, entity_id)
    );

    CREATE TABLE IF NOT EXISTS tag_management_events (
      event_id TEXT PRIMARY KEY,
      tag_id TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organization_governance_snapshot (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      configured INTEGER NOT NULL CHECK (configured IN (0, 1)),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      schema_version TEXT NOT NULL,
      template_key TEXT NOT NULL,
      template_name TEXT NOT NULL,
      description TEXT NOT NULL,
      organization_depth INTEGER NOT NULL CHECK (organization_depth >= 0),
      published_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organization_governance_nodes (
      ordinal INTEGER NOT NULL UNIQUE,
      node_id TEXT PRIMARY KEY,
      node_type TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      organization_level INTEGER
    );

    CREATE TABLE IF NOT EXISTS organization_governance_template_ownership (
      entity_type TEXT NOT NULL CHECK (entity_type IN ('tag', 'role')),
      entity_id TEXT NOT NULL,
      template_key TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tag_management_tags_kind ON tag_management_tags(kind);
    CREATE INDEX IF NOT EXISTS idx_tag_management_tags_parent ON tag_management_tags(parent_tag_id);
    CREATE INDEX IF NOT EXISTS idx_tag_management_tags_status ON tag_management_tags(status);
    CREATE INDEX IF NOT EXISTS idx_tag_management_projections_entity ON tag_management_projections(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_tag_management_events_tag ON tag_management_events(tag_id);
    CREATE INDEX IF NOT EXISTS idx_organization_governance_nodes_parent
      ON organization_governance_nodes(parent_id);

    INSERT OR IGNORE INTO organization_governance_snapshot (
      singleton_id, configured, revision, schema_version, template_key, template_name,
      description, organization_depth, published_at
    ) VALUES (
      1, 0, 0, 'v0.0.1:authorization:organization-template-1', '', '', '', 0, ''
    );
  `);

  const migrationVersion = Number(db.pragma("user_version", { simple: true }) || 0);
  if (migrationVersion < 1) {
    db.transaction((): void => {
      db.prepare(`
        DELETE FROM tag_management_projections
        WHERE entity_type = 'authorization.role'
          AND entity_id IN ('admin', 'operator')
      `).run();
      db.prepare(`
        DELETE FROM tag_management_tags
        WHERE tag_id IN ('role:admin', 'role:operator')
      `).run();
      db.pragma("user_version = 1");
    })();
  }
}
