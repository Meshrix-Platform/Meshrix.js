import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  RECONCILE_INDEX,
  REQUEST_COLUMNS,
  SCHEMA_FINGERPRINT,
  SCHEMA_VERSION,
  canonicalErrorJson,
  digest,
  hydrateStoredRequestRow,
  normalizeRequestRecord,
  parseStoredJson,
  schemaFailure
} from "./model.ts";

/**
 * Private SQLite schema owner for the materialization transaction store.
 *
 * This module owns table creation, canonical layout inspection, data-preserving
 * migration of recognized legacy layouts, and schema integrity verification.
 * The transaction store owns the database connection and calls
 * `ensureCurrentSchema` during initialization.
 */

const LEGACY_WORKTREE_REQUEST_COLUMNS: readonly any[] = Object.freeze([
  "error_json",
  "lease_until",
  "owner_fence",
  "parent_fingerprint",
  "preimage_json",
  "prior_revision",
  "publication_json",
  "published_revision",
  "request_json",
  "request_ref",
  "result_json",
  "stage",
  "status",
  "target_state_digest",
  "updated_at"
]);
const LEGACY_AUXILIARY_TABLES: readonly any[] = Object.freeze([
  "materialization_capacity",
  "materialization_inputs",
  "materialization_scope_capacity"
]);
const LEGACY_AUXILIARY_COLUMNS: Readonly<Record<string, any>> = Object.freeze({
  materialization_capacity: Object.freeze([
    "input_bytes",
    "request_count",
    "singleton"
  ]),
  materialization_inputs: Object.freeze([
    "byte_size",
    "content_sha256",
    "custody_rel_path",
    "request_ref",
    "source_path"
  ]),
  materialization_scope_capacity: Object.freeze([
    "active_bytes",
    "scope_ref"
  ])
});

function tableExists(db?: any, tableName?: any) : any {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function tableColumns(db?: any, tableName?: any) : any {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row?: any) : any => row.name)
    .sort();
}

function tableCount(db?: any, tableName?: any) : any {
  return Number(
    db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
      .get().count
  );
}

function userTables(db?: any) : any {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row?: any) : any => row.name);
}

function userViews(db?: any) : any {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'view'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row?: any) : any => row.name);
}

function tableTriggers(db?: any, tableName?: any) : any {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = ?
    ORDER BY name
  `).all(tableName).map((row?: any) : any => row.name);
}

function userTriggers(db?: any) : any {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'trigger'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row?: any) : any => row.name);
}

function unexpectedRequestIndexes(db?: any) : any {
  return db
    .prepare("PRAGMA index_list(materialization_requests)")
    .all()
    .filter(
      (row?: any) : any =>
        row.origin !== "pk" &&
        row.name !== RECONCILE_INDEX
    );
}

function userDefinedIndexes(db?: any) : any {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index' AND sql IS NOT NULL
    ORDER BY name
  `).all().map((row?: any) : any => row.name);
}

function indexColumns(db?: any, indexName?: any) : any {
  return db
    .prepare(`PRAGMA index_info(${indexName})`)
    .all()
    .map((row?: any) : any => row.name);
}

function assertCanonicalReconcileIndex(db?: any, { required }: Record<string, any> = {}) : any {
  const index: any = db
    .prepare("PRAGMA index_list(materialization_requests)")
    .all()
    .find((row?: any) : any => row.name === RECONCILE_INDEX);
  const exists: any = Boolean(index);
  const indexedFields: any = exists
    ? db
        .prepare(`PRAGMA index_xinfo(${RECONCILE_INDEX})`)
        .all()
        .filter((row?: any) : any => Number(row.key) === 1)
    : [];
  if (
    (required && !exists) ||
    (
      exists &&
      (
        Number(index.unique) !== 0 ||
        Number(index.partial) !== 0 ||
        index.origin !== "c" ||
        indexColumns(db, RECONCILE_INDEX).join("\0") !==
          [
            "status",
            "stage",
            "lease_until",
            "updated_at",
            "request_ref"
          ].join("\0") ||
        indexedFields.some(
          (field?: any) : any =>
            Number(field.desc) !== 0 ||
            field.coll !== "BINARY"
        )
      )
    )
  ) {
    throw schemaFailure(
      "materialization_schema_layout_unknown",
      "Materialization reconciliation index is not canonical."
    );
  }
}

function sameColumns(actual?: any, expected?: any) : any {
  return [...actual].sort().join("\0") ===
    [...expected].sort().join("\0");
}

function createRequestTable(db?: any, tableName?: any) : any {
  db.exec(`
    CREATE TABLE ${tableName} (
      request_ref TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'completed', 'failed', 'cancelled')
      ),
      stage TEXT NOT NULL CHECK (
        stage IN (
          'admitted',
          'publication_intent',
          'temp_reserved',
          'publication_prepared',
          'published',
          'evidence_pending',
          'audit_finalized',
          'proof_finalized',
          'completed',
          'rollback_incomplete'
        )
      ),
      owner_fence TEXT NOT NULL DEFAULT '',
      lease_until INTEGER NOT NULL DEFAULT 0 CHECK (lease_until >= 0),
      request_json TEXT NOT NULL,
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      preimage_json TEXT,
      target_state_digest TEXT NOT NULL DEFAULT '',
      parent_fingerprint TEXT NOT NULL DEFAULT '',
      parent_identity_json TEXT,
      publication_json TEXT,
      prior_revision TEXT NOT NULL DEFAULT '',
      published_revision TEXT NOT NULL DEFAULT '',
      effect_json TEXT,
      evidence_json TEXT,
      result_json TEXT,
      error_json TEXT,
      updated_at TEXT NOT NULL,
      CHECK (
        (
          status = 'running' AND
          owner_fence <> '' AND
          lease_until > 0 AND
          stage IN (
            'admitted',
            'publication_intent',
            'temp_reserved',
            'publication_prepared',
            'published',
            'evidence_pending',
            'audit_finalized',
            'proof_finalized'
          )
        ) OR (
          status = 'queued' AND
          stage = 'admitted' AND
          owner_fence = '' AND
          lease_until = 0
        ) OR (
          status = 'completed' AND
          stage = 'completed' AND
          owner_fence = '' AND
          lease_until = 0
        ) OR (
          status = 'failed' AND
          stage IN ('admitted', 'rollback_incomplete') AND
          owner_fence = '' AND
          lease_until = 0
        ) OR (
          status = 'cancelled' AND
          stage = 'admitted' AND
          owner_fence = '' AND
          lease_until = 0
        )
      ),
      CHECK (
        stage NOT IN (
          'publication_intent',
          'temp_reserved',
          'publication_prepared',
          'published',
          'evidence_pending',
          'audit_finalized',
          'proof_finalized',
          'completed',
          'rollback_incomplete'
        ) OR preimage_json IS NOT NULL
      ),
      CHECK (
        stage NOT IN (
          'publication_intent',
          'temp_reserved',
          'publication_prepared',
          'published',
          'evidence_pending',
          'audit_finalized',
          'proof_finalized',
          'completed'
        ) OR publication_json IS NOT NULL
      ),
      CHECK (
        stage NOT IN (
          'published',
          'evidence_pending',
          'audit_finalized',
          'proof_finalized',
          'completed'
        ) OR effect_json IS NOT NULL
      ),
      CHECK (
        stage NOT IN (
          'evidence_pending',
          'audit_finalized',
          'proof_finalized',
          'completed'
        ) OR evidence_json IS NOT NULL
      ),
      CHECK (
        stage <> 'admitted' OR (
          publication_json IS NULL AND
          effect_json IS NULL AND
          evidence_json IS NULL AND
          result_json IS NULL
        )
      ),
      CHECK (
        stage NOT IN (
          'publication_intent',
          'temp_reserved',
          'publication_prepared'
        ) OR (
          effect_json IS NULL AND
          evidence_json IS NULL AND
          result_json IS NULL
        )
      ),
      CHECK (
        (
          stage IN (
            'published',
            'evidence_pending',
            'audit_finalized',
            'proof_finalized',
            'completed'
          ) AND result_json IS NOT NULL
        ) OR (
          stage IN (
            'admitted',
            'publication_intent',
            'temp_reserved',
            'publication_prepared'
          ) AND result_json IS NULL
        ) OR stage = 'rollback_incomplete'
      ),
      CHECK (
        (status = 'failed' AND error_json IS NOT NULL) OR
        (
          status IN ('running', 'completed', 'cancelled') AND
          error_json IS NULL
        ) OR status = 'queued'
      ),
      CHECK (
        status <> 'cancelled' OR (
          preimage_json IS NULL AND
          target_state_digest = '' AND
          parent_fingerprint = '' AND
          parent_identity_json IS NULL AND
          prior_revision = ''
        )
      ),
      CHECK (
        status <> 'failed' OR
        stage <> 'admitted' OR (
          preimage_json IS NULL AND
          target_state_digest = '' AND
          parent_fingerprint = '' AND
          parent_identity_json IS NULL AND
          prior_revision = ''
        )
      )
    );
  `);
}

function createCurrentIndexes(db?: any) : any {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ${RECONCILE_INDEX}
      ON materialization_requests(
        status,
        stage,
        lease_until,
        updated_at,
        request_ref
      );
  `);
}

function writeSchemaMetadata(db?: any) : any {
  db.exec(`
    CREATE TABLE IF NOT EXISTS materialization_schema_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      schema_fingerprint TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO materialization_schema_meta (
      singleton,
      schema_version,
      schema_fingerprint
    ) VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      schema_version = excluded.schema_version,
      schema_fingerprint = excluded.schema_fingerprint
  `).run(SCHEMA_VERSION, SCHEMA_FINGERPRINT);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function assertAuxiliaryTablesAreEmpty(db?: any) : any {
  for (const tableName of LEGACY_AUXILIARY_TABLES) {
    if (!tableExists(db, tableName)) continue;
    if (
      !sameColumns(
        tableColumns(db, tableName),
        LEGACY_AUXILIARY_COLUMNS[tableName]
      )
    ) {
      throw schemaFailure(
        "materialization_schema_layout_unknown",
        "Legacy materialization table layout is not recognized."
      );
    }
    if (tableCount(db, tableName) > 0) {
      throw schemaFailure(
        "materialization_schema_unsafe_legacy_data",
        "Legacy materialization data requires explicit offline recovery."
      );
    }
  }
}

function dropEmptyAuxiliaryTables(db?: any) : any {
  for (const tableName of LEGACY_AUXILIARY_TABLES) {
    if (tableExists(db, tableName)) {
      if (tableCount(db, tableName) > 0) {
        throw schemaFailure(
          "materialization_schema_unsafe_legacy_data",
          "Legacy materialization data requires explicit offline recovery."
        );
      }
      db.exec(`DROP TABLE ${tableName}`);
    }
  }
}

function normalizeLegacyWorktreeRow(row?: any) : any {
  const request: any = normalizeRequestRecord(
    parseStoredJson(
      row.request_json,
      "Materialization request record"
    )
  );
  if (request.requestRef !== row.request_ref) {
    throw schemaFailure(
      "materialization_schema_data_invalid",
      "Materialization request identity is inconsistent."
    );
  }
  const effectFree: any =
    row.publication_json === null &&
    row.result_json === null &&
    row.published_revision === "";
  if (
    effectFree &&
    row.status === "queued" &&
    ["admitted", "preimage_ready"].includes(row.stage)
  ) {
    return {
      request,
      status: "queued",
      stage: "admitted",
      errorJson: row.error_json
        ? canonicalErrorJson(
            parseStoredJson(
              row.error_json,
              "Legacy materialization error"
            ),
            "materialization_failed"
          )
        : null
    };
  }
  if (
    effectFree &&
    row.status === "running" &&
    ["admitted", "preimage_ready"].includes(row.stage)
  ) {
    return {
      request,
      status: "queued",
      stage: "admitted",
      errorJson: row.error_json
        ? canonicalErrorJson(
            parseStoredJson(
              row.error_json,
              "Legacy materialization error"
            ),
            "materialization_failed"
          )
        : null
    };
  }
  if (
    effectFree &&
    row.status === "failed" &&
    ["failed", "retry_exhausted"].includes(row.stage)
  ) {
    return {
      request,
      status: "failed",
      stage: "admitted",
      errorJson: row.error_json
        ? canonicalErrorJson(
            parseStoredJson(
              row.error_json,
              "Legacy materialization error"
            ),
            "materialization_retry_exhausted"
          )
        : canonicalErrorJson(
            null,
            "materialization_retry_exhausted"
          )
    };
  }
  if (
    effectFree &&
    row.status === "cancelled" &&
    row.stage === "cancelled"
  ) {
    return {
      request,
      status: "cancelled",
      stage: "admitted",
      errorJson: null
    };
  }
  throw schemaFailure(
    "materialization_schema_unsafe_legacy_data",
    "Existing materialization state requires explicit offline recovery."
  );
}

function migrateLegacyWorktreeSchema(db?: any) : any {
  const rows: any = db.prepare(`
    SELECT *
    FROM materialization_requests
    ORDER BY request_ref
  `).all();
  const converted: any = rows.map(normalizeLegacyWorktreeRow);
  createRequestTable(db, "materialization_requests_next");
  const insert: any = db.prepare(`
    INSERT INTO materialization_requests_next (
      request_ref,
      status,
      stage,
      request_json,
      request_digest,
      error_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of converted) {
    const requestJson: any = canonicalJson(row.request);
    insert.run(
      row.request.requestRef,
      row.status,
      row.stage,
      requestJson,
      digest(row.request),
      row.errorJson,
      new Date().toISOString()
    );
  }
  const copied: any = tableCount(
    db,
    "materialization_requests_next"
  );
  if (copied !== rows.length) {
    throw schemaFailure(
      "materialization_schema_migration_incomplete",
      "Materialization schema migration did not preserve every safe row."
    );
  }
  for (const row of db.prepare(`
    SELECT *
    FROM materialization_requests_next
    ORDER BY request_ref
  `).all()) {
    hydrateStoredRequestRow(row);
  }
  db.exec(`
    DROP TABLE materialization_requests;
    ALTER TABLE materialization_requests_next
      RENAME TO materialization_requests;
  `);
}

function assertCurrentSchema(db?: any) : any {
  if (
    userViews(db).length > 0 ||
    userTriggers(db).length > 0 ||
    !sameColumns(
      userTables(db),
      [
        "materialization_requests",
        "materialization_schema_meta"
      ]
    ) ||
    !tableExists(db, "materialization_requests") ||
    !sameColumns(
      tableColumns(db, "materialization_requests"),
      REQUEST_COLUMNS
    ) ||
    tableTriggers(db, "materialization_requests").length > 0 ||
    unexpectedRequestIndexes(db).length > 0 ||
    !sameColumns(
      userDefinedIndexes(db),
      [RECONCILE_INDEX]
    )
  ) {
    throw schemaFailure(
      "materialization_schema_layout_unknown",
      "Materialization schema layout is not recognized."
    );
  }
  if (
    LEGACY_AUXILIARY_TABLES.some((tableName?: any) : any =>
      tableExists(db, tableName)
    )
  ) {
    throw schemaFailure(
      "materialization_schema_layout_unknown",
      "Legacy materialization tables remain in the current schema."
    );
  }
  const hasMetadata: any = tableExists(
    db,
    "materialization_schema_meta"
  );
  if (
    !hasMetadata ||
    !sameColumns(
      tableColumns(db, "materialization_schema_meta"),
      ["schema_fingerprint", "schema_version", "singleton"]
    ) ||
    tableCount(db, "materialization_schema_meta") !== 1
  ) {
    throw schemaFailure(
      "materialization_schema_fingerprint_mismatch",
      "Materialization schema metadata is not recognized."
    );
  }
  const meta: any = hasMetadata
    ? db.prepare(`
        SELECT schema_version AS schemaVersion,
               schema_fingerprint AS schemaFingerprint
        FROM materialization_schema_meta
        WHERE singleton = 1
      `).get()
    : null;
  if (
    Number(meta?.schemaVersion) !== SCHEMA_VERSION ||
    meta?.schemaFingerprint !== SCHEMA_FINGERPRINT
  ) {
    throw schemaFailure(
      "materialization_schema_fingerprint_mismatch",
      "Materialization schema fingerprint is not recognized."
    );
  }
  assertCanonicalReconcileIndex(db, { required: true });
  for (const row of db.prepare(`
    SELECT *
    FROM materialization_requests
    ORDER BY request_ref
  `).all()) {
    hydrateStoredRequestRow(row);
  }
}

function verifyDatabaseIntegrity(db?: any) : any {
  const integrity: any = db.pragma("quick_check", { simple: true });
  if (integrity !== "ok") {
    throw schemaFailure(
      "materialization_schema_integrity_failed",
      "Materialization database integrity verification failed."
    );
  }
  if (db.pragma("foreign_key_check").length > 0) {
    throw schemaFailure(
      "materialization_schema_foreign_key_failed",
      "Materialization database foreign-key verification failed."
    );
  }
}

export function ensureCurrentSchema(db?: any, now: any = Date.now) : any {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.pragma("foreign_keys = ON");
  const userVersion: any = Number(
    db.pragma("user_version", { simple: true }) || 0
  );
  if (userVersion < 0 || userVersion > SCHEMA_VERSION) {
    throw schemaFailure(
      "materialization_schema_version_unsupported",
      "Materialization schema version is not supported."
    );
  }
  if (userVersion === SCHEMA_VERSION) {
    assertCurrentSchema(db);
    verifyDatabaseIntegrity(db);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    return;
  }

  const migrate: any = db.transaction(() : any => {
    const tables: any = userTables(db);
    if (
      userViews(db).length > 0 ||
      userTriggers(db).length > 0
    ) {
      throw schemaFailure(
        "materialization_schema_layout_unknown",
        "Materialization schema views are not recognized."
      );
    }
    if (tableExists(db, "materialization_schema_meta")) {
      throw schemaFailure(
        "materialization_schema_layout_unknown",
        "Unversioned materialization metadata is not recognized."
      );
    }
    const auxiliaryTables: any = LEGACY_AUXILIARY_TABLES.filter(
      (tableName?: any) : any => tableExists(db, tableName)
    );
    assertAuxiliaryTablesAreEmpty(db);
    if (!tableExists(db, "materialization_requests")) {
      if (tables.length > 0) {
        throw schemaFailure(
          "materialization_schema_layout_unknown",
          "Orphaned materialization tables are not a recognized schema."
        );
      }
      createRequestTable(db, "materialization_requests");
    } else {
      const columns: any = tableColumns(
        db,
        "materialization_requests"
      );
      if (sameColumns(columns, REQUEST_COLUMNS)) {
        if (
          !sameColumns(tables, ["materialization_requests"]) ||
          tableTriggers(db, "materialization_requests").length > 0 ||
          unexpectedRequestIndexes(db).length > 0 ||
          userDefinedIndexes(db).some(
            (name?: any) : any => name !== RECONCILE_INDEX
          )
        ) {
          throw schemaFailure(
            "materialization_schema_layout_unknown",
            "The unversioned materialization schema is not canonical."
          );
        }
        assertCanonicalReconcileIndex(db);
        const rows: any = db.prepare(`
          SELECT *
          FROM materialization_requests
          ORDER BY request_ref
        `).all();
        for (const row of rows) hydrateStoredRequestRow(row);
        const current: any = Number(now());
        if (!Number.isFinite(current)) {
          throw schemaFailure(
            "materialization_schema_data_invalid",
            "Materialization migration time is invalid."
          );
        }
        db.prepare(`
          UPDATE materialization_requests
          SET status = 'queued',
              owner_fence = '',
              lease_until = 0,
              updated_at = ?
          WHERE status = 'running'
            AND stage = 'admitted'
            AND lease_until < ?
        `).run(new Date(current).toISOString(), current);
      } else if (
        sameColumns(columns, LEGACY_WORKTREE_REQUEST_COLUMNS)
      ) {
        const allowedLegacyTables: any[] = [
          "materialization_requests",
          ...LEGACY_AUXILIARY_TABLES.filter((tableName?: any) : any =>
            tableExists(db, tableName)
          )
        ];
        if (
          !sameColumns(tables, allowedLegacyTables) ||
          tableTriggers(db, "materialization_requests").length > 0 ||
          userDefinedIndexes(db).length > 0
        ) {
          throw schemaFailure(
            "materialization_schema_layout_unknown",
            "Legacy materialization schema objects are not recognized."
          );
        }
        migrateLegacyWorktreeSchema(db);
        dropEmptyAuxiliaryTables(db);
      } else {
        throw schemaFailure(
          "materialization_schema_layout_unknown",
          "Materialization schema layout requires offline recovery."
        );
      }
    }
    createCurrentIndexes(db);
    writeSchemaMetadata(db);
    assertCurrentSchema(db);
    verifyDatabaseIntegrity(db);
  });
  migrate.immediate();
  assertCurrentSchema(db);
  verifyDatabaseIntegrity(db);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
}
