import path from "node:path";

export const STORAGE_SCHEMA_REVISION: any = 3;

const CORE_SCHEMA_COLUMNS: Readonly<Record<string, any>> = Object.freeze({
  storage_objects: Object.freeze([
    "object_id", "namespace", "storage_rel_path", "sha256", "byte_size",
    "media_type", "metadata_json", "created_at", "updated_at"
  ]),
  storage_object_owners: Object.freeze([
    "object_id", "job_id", "archive_batch_id", "owner_subject_id",
    "owner_user_id", "owner_username", "created_at", "updated_at"
  ]),
  storage_deletion_operations: Object.freeze([
    "operation_id", "owner_id", "job_id", "status", "state_json",
    "error", "created_at", "updated_at"
  ]),
  storage_upload_consumption_receipts: Object.freeze([
    "receipt_id", "session_id", "schema_version", "owner_key",
    "objects_json", "receipt_digest", "created_at"
  ]),
  upload_no_run_custody_staging: Object.freeze([
    "custody_ref", "idempotency_digest", "expected_content_digest",
    "expected_byte_size", "owner_binding_digest", "resource_binding_digest",
    "state", "envelope_id", "pending_identity",
    "committed_plaintext_bytes", "committed_frame_count",
    "committed_ciphertext_digest", "prepared_plaintext_bytes",
    "prepared_frame_count", "prepared_ciphertext_digest",
    "sealed_object_id", "sealed_envelope_digest", "created_at", "updated_at"
  ])
});

const UPGRADEABLE_CORE_TABLES: any = new Set<any>([
  "storage_upload_consumption_receipts",
  "upload_no_run_custody_staging"
]);

function storageSchemaError(code?: any, message?: any, details: Record<string, any> = {}) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  error.reasonCode = code;
  error.details = details;
  return error;
}

function tableNames(db?: any) : any {
  return new Set<any>(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map((row?: any) : any => String(row.name || "")));
}

function tableColumns(db?: any, tableName?: any) : any {
  return new Set<any>(db.prepare(`PRAGMA table_info(${tableName})`).all()
    .map((row?: any) : any => String(row.name || "")));
}

function storedRevision(db?: any, tables?: any) : any {
  if (!tables.has("storage_schema_meta")) return 0;
  const value: any = db.prepare("SELECT value FROM storage_schema_meta WHERE key = 'schema_revision' LIMIT 1").get()?.value;
  const revision: any = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : -1;
}

export function inspectStorageSchemaCompatibility(db?: any) : any {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("Storage schema compatibility inspection requires a database handle.");
  }
  const tables: any = tableNames(db);
  const presentCoreTables: any = Object.keys(CORE_SCHEMA_COLUMNS).filter((table?: any) : any => tables.has(table));
  const missingCoreTables: any = Object.keys(CORE_SCHEMA_COLUMNS).filter((table?: any) : any => !tables.has(table));
  const missingColumns: any = Object.fromEntries(presentCoreTables
    .map((table?: any) : any => {
      const columns: any = tableColumns(db, table);
      return [table, CORE_SCHEMA_COLUMNS[table].filter((column?: any) : any => !columns.has(column))];
    })
    .filter(([, columns]: any[]) : any => columns.length > 0));
  const currentRevision: any = storedRevision(db, tables);
  const empty: any = presentCoreTables.length === 0;
  const knownUpgradeRequired: any =
    missingCoreTables.length > 0 &&
    missingCoreTables.every((table?: any) : any => UPGRADEABLE_CORE_TABLES.has(table)) &&
    Object.keys(missingColumns).length === 0;
  const compatibleShape: any = empty ||
    (
      missingCoreTables.length === 0 &&
      Object.keys(missingColumns).length === 0
    ) ||
    knownUpgradeRequired;
  const revisionSupported: any = currentRevision >= 0 && currentRevision <= STORAGE_SCHEMA_REVISION;
  return Object.freeze({
    ready: compatibleShape && revisionSupported,
    currentRevision,
    targetRevision: STORAGE_SCHEMA_REVISION,
    initializationRequired: empty,
    metadataUpgradeRequired: !empty && currentRevision === 0,
    schemaUpgradeRequired:
      !empty &&
      (
        knownUpgradeRequired ||
        currentRevision < STORAGE_SCHEMA_REVISION
      ),
    futureRevisionDetected: currentRevision > STORAGE_SCHEMA_REVISION,
    missingCoreTableCount: empty ? 0 : missingCoreTables.length,
    missingColumnCount: (Object.values(missingColumns) as any[]).reduce((count?: any, columns?: any) : any => count + columns.length, 0)
  });
}

export function assertStorageSchemaUpgradePreflight(db?: any) : any {
  const result: any = inspectStorageSchemaCompatibility(db);
  if (!result.ready) {
    throw storageSchemaError(
      result.futureRevisionDetected ? "storage_schema_future_revision" : "storage_schema_incompatible",
      "Storage schema is not compatible with this runtime.",
      result
    );
  }
  return result;
}

function applySchemaContributor(db?: any, contributor?: any) : any {
  if (typeof contributor === "function") {
    contributor(db);
    return;
  }
  if (contributor && typeof contributor.initialize === "function") {
    contributor.initialize(db);
  }
}

export function getStorageDatabaseDirectory(userDataPath?: any) : any {
  return path.join(userDataPath, "metadata");
}

export function getStorageDatabasePath(userDataPath?: any) : any {
  return path.join(getStorageDatabaseDirectory(userDataPath), "meshrix.sqlite");
}

export function initializeStorageSchema(db?: any, { schemaContributors = [] }: Record<string, any> = {}) : any {
  if (!db || typeof db.exec !== "function") {
    throw new TypeError("Storage schema initialization requires a database handle.");
  }
  // Probe the opened handle before compatibility inspection. This is read-only,
  // preserves fail-closed ordering, and ensures constructor unwind observes the
  // database's own initialization failure rather than a secondary inspection error.
  db.exec("SELECT 1;");
  assertStorageSchemaUpgradePreflight(db);
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

    CREATE TABLE IF NOT EXISTS storage_upload_consumption_receipts (
      receipt_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      schema_version TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      objects_json TEXT NOT NULL,
      receipt_digest TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_storage_upload_consumption_receipts_session
      ON storage_upload_consumption_receipts(session_id);

    CREATE TABLE IF NOT EXISTS upload_no_run_custody_staging (
      custody_ref TEXT PRIMARY KEY,
      idempotency_digest TEXT NOT NULL UNIQUE,
      expected_content_digest TEXT NOT NULL,
      expected_byte_size INTEGER NOT NULL,
      owner_binding_digest TEXT NOT NULL,
      resource_binding_digest TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('staging', 'sealed')),
      envelope_id TEXT NOT NULL UNIQUE,
      pending_identity TEXT NOT NULL UNIQUE,
      committed_plaintext_bytes INTEGER NOT NULL DEFAULT 0,
      committed_frame_count INTEGER NOT NULL DEFAULT 0,
      committed_ciphertext_digest TEXT NOT NULL,
      prepared_plaintext_bytes INTEGER,
      prepared_frame_count INTEGER,
      prepared_ciphertext_digest TEXT,
      sealed_object_id TEXT,
      sealed_envelope_digest TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (sealed_object_id) REFERENCES storage_objects(object_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_upload_no_run_custody_owner_state
      ON upload_no_run_custody_staging(
        owner_binding_digest, state, updated_at DESC
      );

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

    CREATE TABLE IF NOT EXISTS storage_schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO storage_schema_meta (key, value)
    VALUES ('schema_revision', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(STORAGE_SCHEMA_REVISION));
  db.pragma(`user_version = ${STORAGE_SCHEMA_REVISION}`);

  for (const contributor of schemaContributors) {
    applySchemaContributor(db, contributor);
  }
}
