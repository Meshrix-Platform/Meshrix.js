import path from "node:path";

function applySchemaContributor(db, contributor) {
  if (typeof contributor === "function") {
    contributor(db);
    return;
  }
  if (contributor && typeof contributor.initialize === "function") {
    contributor.initialize(db);
  }
}

export function getStorageDatabaseDirectory(userDataPath) {
  return path.join(userDataPath, "metadata");
}

export function getStorageDatabasePath(userDataPath) {
  return path.join(getStorageDatabaseDirectory(userDataPath), "lico.sqlite");
}

export function initializeStorageSchema(db, { schemaContributors = [] } = {}) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS storage_objects (
      object_id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL DEFAULT 'default',
      storage_rel_path TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_storage_objects_namespace
      ON storage_objects(namespace, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_storage_objects_sha256
      ON storage_objects(sha256);

    CREATE TABLE IF NOT EXISTS storage_object_owners (
      object_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL DEFAULT '',
      archive_batch_id TEXT NOT NULL DEFAULT '',
      owner_subject_id TEXT NOT NULL DEFAULT '',
      owner_user_id TEXT NOT NULL DEFAULT '',
      owner_username TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (object_id) REFERENCES storage_objects(object_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_storage_object_owners_job
      ON storage_object_owners(job_id, object_id);
    CREATE INDEX IF NOT EXISTS idx_storage_object_owners_archive_batch
      ON storage_object_owners(archive_batch_id, object_id);

    CREATE TABLE IF NOT EXISTS storage_deletion_operations (
      operation_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      state_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_storage_deletion_operations_status
      ON storage_deletion_operations(status, updated_at);

    CREATE TABLE IF NOT EXISTS opaque_custody_artifacts (
      custody_ref TEXT PRIMARY KEY,
      object_id TEXT UNIQUE,
      seal_idempotency_key TEXT NOT NULL UNIQUE,
      seal_request_digest TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      envelope_digest TEXT NOT NULL,
      plaintext_bytes INTEGER NOT NULL,
      ciphertext_bytes INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      owner_subject_ref TEXT NOT NULL,
      tenant_ref TEXT NOT NULL,
      workspace_ref TEXT NOT NULL,
      key_ref TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('sealed', 'deleted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (object_id) REFERENCES storage_objects(object_id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_opaque_custody_owner_state
      ON opaque_custody_artifacts(tenant_ref, workspace_ref, owner_subject_ref, state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS opaque_custody_promotions (
      promotion_id TEXT PRIMARY KEY,
      custody_ref TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('validating', 'released', 'failed')),
      provider_receipt_digest TEXT NOT NULL,
      reason_code TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (custody_ref) REFERENCES opaque_custody_artifacts(custody_ref) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_opaque_custody_promotions_artifact
      ON opaque_custody_promotions(custody_ref, updated_at DESC);
  `);

  for (const contributor of schemaContributors) {
    applySchemaContributor(db, contributor);
  }
}
