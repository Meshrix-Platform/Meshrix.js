export function ensureTagManagementSchema(db?: any) : any {
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

    CREATE INDEX IF NOT EXISTS idx_tag_management_tags_kind ON tag_management_tags(kind);
    CREATE INDEX IF NOT EXISTS idx_tag_management_tags_parent ON tag_management_tags(parent_tag_id);
    CREATE INDEX IF NOT EXISTS idx_tag_management_tags_status ON tag_management_tags(status);
    CREATE INDEX IF NOT EXISTS idx_tag_management_projections_entity ON tag_management_projections(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_tag_management_events_tag ON tag_management_events(tag_id);
  `);
}
