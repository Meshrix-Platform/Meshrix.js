import path from "node:path";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import {
  assertAgentWorkspaceMaterializationPort
} from "#meshrix/agents/agent-workspace/agent-workspace-materialization-port";
import { ensurePrivateDir } from "#meshrix/foundation/storage/private-file-atomic";
import { ensurePrivateSqliteLocation } from "#meshrix/foundation/storage/private-sqlite";
import {
  createUploadWorkspaceMaterialization,
  materializationFailureDisposition
} from "../jobs/upload-workspace-materialization/index.ts";
import {
  DEFAULT_LEASE_MS,
  DEFINITION_ID,
  DEFINITION_VERSION,
  MATERIALIZATION_MAX_ATTEMPTS,
  MAX_RECONCILE_BATCH,
  RECONCILE_INDEX,
  REQUEST_COLUMNS,
  SCHEMA_FINGERPRINT,
  SCHEMA_VERSION,
  boundedId,
  canonicalErrorJson,
  closedAdmissionInput,
  digest,
  exactDescriptor,
  exactKeys,
  factsFromRow,
  failure,
  hydrateStoredRequestRow,
  normalizeCompletedResult,
  normalizeFsIdentity,
  normalizeLogicalTarget,
  normalizePublicationIntent,
  normalizePublicationPrepared,
  normalizePublicationReserved,
  normalizePreimage,
  normalizePublishedEffect,
  normalizeRequestRecord,
  normalizeStateEventAnchor,
  normalizedOwner,
  parseStoredJson,
  requestReference,
  sameCanonical,
  sameDescriptor,
  schemaFailure,
  settlementEvidence,
  sha256Digest,
  text
} from "../jobs/upload-workspace-materialization/model.ts";

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

const PROVIDER_FAULT_SCHEMAS: Readonly<Record<string, any>> = Object.freeze({
  afterQueueClaim: Object.freeze({
    leaseSequence: "integer",
    requestRef: "id"
  }),
  afterTransactionCompletedBeforeQueueAck: Object.freeze({
    leaseSequence: "integer",
    requestRef: "id"
  }),
  afterTransactionCreatedBeforeEnqueue: Object.freeze({
    bindingDigest: "digest",
    requestRef: "id"
  })
});

function validProviderFaultValue(value?: any, kind?: any) : any {
  if (kind === "integer") {
    return Number.isSafeInteger(value) && value >= 0;
  }
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 768 &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    (kind !== "digest" || /^[a-f0-9]{64}$/u.test(value))
  );
}

async function invokeProviderFault(observer?: any, callbackName?: any, input?: any) : Promise<any> {
  const schema: any = PROVIDER_FAULT_SCHEMAS[callbackName];
  if (
    !schema ||
    !exactKeys(input, Object.keys(schema)) ||
    (Object.entries(schema) as [string, any][]).some(
      ([key, kind]: any[]) : any => !validProviderFaultValue(input[key], kind)
    )
  ) {
    throw failure(
      "materialization_fault_payload_invalid",
      500,
      "Materialization provider fault payload is invalid."
    );
  }
  const bounded: Readonly<Record<string, any>> = Object.freeze({ ...input });
  await observer?.[callbackName]?.(bounded);
  return bounded;
}

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

function ensureCurrentSchema(db?: any, now: any = Date.now) : any {
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

export function createUploadWorkspaceMaterializationTransactionStore({
  userDataPath,
  leaseMs = DEFAULT_LEASE_MS,
  now = Date.now
}: Record<string, any> = {}) : any {
  const root: any =
    typeof userDataPath === "string" ? userDataPath : "";
  if (
    !root.trim() ||
    typeof now !== "function" ||
    typeof leaseMs !== "number" ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <= 0
  ) {
    throw new TypeError(
      "Materialization transaction store dependencies are invalid."
    );
  }
  const jobsRoot: any = path.join(root, "jobs");
  ensurePrivateDir(jobsRoot);
  const databasePath: any = ensurePrivateSqliteLocation(
    path.join(jobsRoot, "upload-workspace-materialization.sqlite")
  );
  let db: any = null;
  try {
    db = openSqliteDatabase(databasePath);
    ensureCurrentSchema(db, now);
  } catch (error: any) {
    try {
      db?.close?.();
    } catch {
      // Preserve the schema initialization failure.
    }
    throw error;
  }
  const read: any = db.prepare(`
    SELECT *
    FROM materialization_requests
    WHERE request_ref = ?
  `);
  const timestamp: any = () : any => new Date(Number(now())).toISOString();
  const hydrate: any = (row?: any) : any =>
    row ? hydrateStoredRequestRow(row) : null;
  const requireChange: any = (result?: any) : any => {
    if (Number(result?.changes || 0) !== 1) {
      throw failure(
        "materialization_fenced",
        409,
        "Materialization lease fence was lost."
      );
    }
  };
  const assertLiveFence: any = (requestRef?: any, ownerFence?: any) : any => {
    const row: any = read.get(requestRef);
    if (
      !row ||
      row.status !== "running" ||
      row.owner_fence !== ownerFence ||
      Number(row.lease_until) < Number(now())
    ) {
      throw failure(
        "materialization_fenced",
        409,
        "Materialization lease fence was lost."
      );
    }
    hydrate(row);
    return row;
  };
  const walMismatch: any = () : any => failure(
    "materialization_publication_wal_mismatch",
    409,
    "Publication write-ahead descriptor does not match."
  );
  const currentLeaseMs: any = leaseMs;

  return Object.freeze({
    async create(value?: any) : Promise<any> {
      const request: any = normalizeRequestRecord(value);
      const requestJson: any = canonicalJson(request);
      const result: any = db.prepare(`
        INSERT OR IGNORE INTO materialization_requests (
          request_ref,
          status,
          stage,
          request_json,
          request_digest,
          updated_at
        ) VALUES (?, 'queued', 'admitted', ?, ?, ?)
      `).run(
        request.requestRef,
        requestJson,
        digest(request),
        timestamp()
      );
      return Object.freeze({
        inserted: Number(result.changes || 0) === 1
      });
    },
    async get(requestRef?: any) : Promise<any> {
      return hydrate(read.get(requestRef));
    },
    async begin(requestRef?: any, { ownerFence }: Record<string, any> = {}) : Promise<any> {
      const current: any = Number(now());
      const normalizedOwnerFence: any = boundedId(
        ownerFence,
        "Materialization owner fence"
      );
      const existing: any = hydrate(read.get(requestRef));
      if (!existing) {
        throw failure(
          "materialization_request_missing",
          404,
          "Materialization request is missing."
        );
      }
      if (existing.status === "completed") return existing;
      if (["cancelled", "failed"].includes(existing.status)) {
        throw failure(
          "materialization_request_terminal",
          409,
          "Materialization request is terminal."
        );
      }
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET status = 'running',
            owner_fence = ?,
            lease_until = ?,
            error_json = NULL,
            updated_at = ?
        WHERE request_ref = ?
          AND (
            status = 'queued' OR
            (status = 'running' AND lease_until < ?)
          )
      `).run(
        normalizedOwnerFence,
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        current
      ));
      return hydrate(read.get(requestRef));
    },
    async renew(requestRef?: any, { ownerFence }: Record<string, any> = {}) : Promise<any> {
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET lease_until = ?, updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        ownerFence,
        current
      ));
    },
    async assertFence(requestRef?: any, { ownerFence }: Record<string, any> = {}) : Promise<any> {
      assertLiveFence(requestRef, ownerFence);
      return true;
    },
    async recordPreimage(
      requestRef?: any,
      {
        ownerFence,
        preimage,
        targetStateDigest,
        parentFingerprint,
        parentIdentity,
        stateEventAnchor = null
      }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      if (
        row.stage !== "admitted" ||
        row.publication_json
      ) {
        throw walMismatch();
      }
      const request: any = normalizeRequestRecord(
        parseStoredJson(
          row.request_json,
          "Materialization request record"
        )
      );
      const normalizedPreimage: any = normalizePreimage(
        preimage,
        request
      );
      const normalizedAnchor: any = normalizeStateEventAnchor(
        normalizedPreimage.stateEventAnchor
      );
      if (
        stateEventAnchor &&
        !sameCanonical(
          normalizedAnchor,
          normalizeStateEventAnchor(stateEventAnchor)
        )
      ) {
        throw walMismatch();
      }
      const normalizedTargetStateDigest: any = sha256Digest(
        targetStateDigest,
        "Materialization target-state digest"
      );
      const normalizedParentFingerprint: any = sha256Digest(
        parentFingerprint,
        "Materialization parent fingerprint"
      );
      const normalizedParentIdentity: any = normalizeFsIdentity(
        parentIdentity,
        "Materialization parent identity"
      );
      const preimageJson: any = canonicalJson(normalizedPreimage);
      const parentIdentityJson: any = canonicalJson(
        normalizedParentIdentity
      );
      if (row.preimage_json) {
        if (
          row.preimage_json !== preimageJson ||
          row.target_state_digest !==
            normalizedTargetStateDigest ||
          row.parent_fingerprint !==
            normalizedParentFingerprint ||
          row.parent_identity_json !== parentIdentityJson ||
          row.prior_revision !==
            request.expectedWorkspaceRevision
        ) {
          throw walMismatch();
        }
        return hydrate(row);
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET preimage_json = ?,
            target_state_digest = ?,
            parent_fingerprint = ?,
            parent_identity_json = ?,
            prior_revision = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'admitted'
          AND preimage_json IS NULL
          AND publication_json IS NULL
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        preimageJson,
        normalizedTargetStateDigest,
        normalizedParentFingerprint,
        parentIdentityJson,
        request.expectedWorkspaceRevision,
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        ownerFence,
        current
      ));
      return hydrate(read.get(requestRef));
    },
    async recordPublicationIntent(
      requestRef?: any,
      { ownerFence, publication }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const request: any = normalizeRequestRecord(
        parseStoredJson(
          row.request_json,
          "Materialization request record"
        )
      );
      const normalized: any = normalizePublicationIntent(
        publication,
        factsFromRow(row, request)
      );
      const publicationJson: any = canonicalJson(normalized);
      if (row.stage === "publication_intent") {
        if (row.publication_json !== publicationJson) {
          throw walMismatch();
        }
        return hydrate(row);
      }
      if (
        row.stage !== "admitted" ||
        !row.preimage_json ||
        row.publication_json
      ) {
        throw walMismatch();
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'publication_intent',
            publication_json = ?,
            prior_revision = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'admitted'
          AND preimage_json IS NOT NULL
          AND publication_json IS NULL
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        publicationJson,
        normalized.priorRevision,
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        ownerFence,
        current
      ));
      return hydrate(read.get(requestRef));
    },
    async recordTempReserved(
      requestRef?: any,
      { ownerFence, publication }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const request: any = normalizeRequestRecord(
        parseStoredJson(
          row.request_json,
          "Materialization request record"
        )
      );
      const facts: any = factsFromRow(row, request);
      const normalized: any = normalizePublicationReserved(
        publication,
        facts
      );
      const publicationJson: any = canonicalJson(normalized);
      if (row.stage === "temp_reserved") {
        if (row.publication_json !== publicationJson) {
          throw walMismatch();
        }
        return hydrate(row);
      }
      if (
        row.stage !== "publication_intent" ||
        !row.publication_json
      ) {
        throw walMismatch();
      }
      const existing: any = normalizePublicationIntent(
        parseStoredJson(
          row.publication_json,
          "Materialization publication intent"
        ),
        facts
      );
      if (
        existing.intentDigest !== normalized.intentDigest ||
        existing.publicationId !== normalized.publicationId ||
        existing.stateOperationId !==
          normalized.stateOperationId
      ) {
        throw walMismatch();
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'temp_reserved',
            publication_json = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'publication_intent'
          AND publication_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        publicationJson,
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        row.publication_json,
        ownerFence,
        current
      ));
      return hydrate(read.get(requestRef));
    },
    async recordPublicationPrepared(
      requestRef?: any,
      { ownerFence, publication }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const request: any = normalizeRequestRecord(
        parseStoredJson(
          row.request_json,
          "Materialization request record"
        )
      );
      const facts: any = factsFromRow(row, request);
      const normalized: any = normalizePublicationPrepared(
        publication,
        facts
      );
      const publicationJson: any = canonicalJson(normalized);
      if (row.stage === "publication_prepared") {
        if (row.publication_json !== publicationJson) {
          throw walMismatch();
        }
        return hydrate(row);
      }
      if (
        row.stage !== "temp_reserved" ||
        !row.publication_json
      ) {
        throw walMismatch();
      }
      const existing: any = normalizePublicationReserved(
        parseStoredJson(
          row.publication_json,
          "Materialization reservation"
        ),
        facts
      );
      if (
        existing.reservationDigest !==
          normalized.reservationDigest ||
        !sameCanonical(
          existing.preparedIdentity,
          normalized.preparedIdentity
        )
      ) {
        throw walMismatch();
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'publication_prepared',
            publication_json = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'temp_reserved'
          AND publication_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        publicationJson,
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        row.publication_json,
        ownerFence,
        current
      ));
      return hydrate(read.get(requestRef));
    },
    async recordPublished(
      requestRef?: any,
      {
        ownerFence,
        checkpointRef,
        proofDigest,
        publicationId,
        publishedIdentity,
        publishedRevision,
        priorRevision,
        stateOperationId
      }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      if (!row.publication_json) throw walMismatch();
      const request: any = normalizeRequestRecord(
        parseStoredJson(
          row.request_json,
          "Materialization request record"
        )
      );
      const facts: any = factsFromRow(row, request);
      const storedPublication: any = parseStoredJson(
        row.publication_json,
        "Materialization publication"
      );
      if (
        ![
          "publication_prepared",
          "published",
          "evidence_pending",
          "audit_finalized",
          "proof_finalized"
        ].includes(row.stage)
      ) {
        throw walMismatch();
      }
      const publication: any = normalizePublicationPrepared(
        storedPublication,
        facts
      );
      if (
        boundedId(
          priorRevision,
          "Publication prior revision"
        ) !== request.expectedWorkspaceRevision
      ) {
        throw walMismatch();
      }
      const effect: any = normalizePublishedEffect(
        {
          byteCount: request.descriptor.byteCount,
          checkpointRef,
          contentDigest: request.descriptor.contentDigest,
          proofDigest,
          publicationId,
          publishedIdentity,
          publishedRevision,
          stateOperationId
        },
        request,
        publication
      );
      const effectJson: any = canonicalJson(effect);
      const resultJson: any = canonicalJson({
        checkpointRef: effect.checkpointRef
      });
      if (
        [
          "published",
          "evidence_pending",
          "audit_finalized",
          "proof_finalized"
        ].includes(row.stage)
      ) {
        if (
          row.published_revision !== effect.publishedRevision ||
          row.effect_json !== effectJson ||
          row.result_json !== resultJson
        ) {
          throw walMismatch();
        }
        return hydrate(row);
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'published',
            publication_json = ?,
            published_revision = ?,
            prior_revision = ?,
            effect_json = ?,
            result_json = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'publication_prepared'
          AND publication_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        canonicalJson(publication),
        effect.publishedRevision,
        request.expectedWorkspaceRevision,
        effectJson,
        resultJson,
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        row.publication_json,
        ownerFence,
        current
      ));
      return hydrate(read.get(requestRef));
    },
    async recordPrecommitCleaned(
      requestRef?: any,
      {
        ownerFence,
        publicationId,
        reservationDigest
      }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      if (
        ![
          "publication_intent",
          "temp_reserved",
          "publication_prepared",
        ].includes(row.stage) ||
        !row.publication_json
      ) {
        throw walMismatch();
      }
      const currentRecord: any = hydrate(row);
      const publication: any = currentRecord.publication;
      const normalizedReservationDigest: any =
        publication.reservationDigest
          ? sha256Digest(
              reservationDigest,
              "Publication reservation digest"
            )
          : reservationDigest === ""
            ? ""
            : null;
      if (
        boundedId(publicationId, "Publication identity") !==
          publication.publicationId ||
        normalizedReservationDigest !==
          publication.reservationDigest
      ) {
        throw walMismatch();
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'admitted',
            preimage_json = NULL,
            target_state_digest = '',
            parent_fingerprint = '',
            parent_identity_json = NULL,
            publication_json = NULL,
            published_revision = '',
            prior_revision = '',
            effect_json = NULL,
            evidence_json = NULL,
            result_json = NULL,
            error_json = NULL,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage IN (
            'publication_intent',
            'temp_reserved',
            'publication_prepared'
          )
          AND publication_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        row.publication_json,
        ownerFence,
        current
      ));
      return hydrate(read.get(requestRef));
    },
    async recordEvidencePending(
      requestRef?: any,
      { ownerFence }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      if (
        [
          "evidence_pending",
          "audit_finalized",
          "proof_finalized"
        ].includes(row.stage)
      ) {
        return hydrate(row);
      }
      if (
        row.stage !== "published" ||
        !row.publication_json ||
        !row.effect_json ||
        row.evidence_json
      ) {
        throw walMismatch();
      }
      const currentRecord: any = hydrate(row);
      const evidence: any = settlementEvidence({
        request: currentRecord,
        publication: currentRecord.publication,
        effect: currentRecord.effect,
        auditCreatedAt: timestamp()
      });
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'evidence_pending',
            evidence_json = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'published'
          AND evidence_json IS NULL
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        canonicalJson(evidence),
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        ownerFence,
        current
      ));
      return hydrate(read.get(requestRef));
    },
    async recordAuditFinalized(
      requestRef?: any,
      {
        ownerFence,
        auditRef,
        settlementDigest
      }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const currentRecord: any = hydrate(row);
      const evidence: any = currentRecord.evidence;
      const normalizedAuditRef: any = boundedId(
        auditRef,
        "Materialization audit reference"
      );
      if (
        !evidence ||
        settlementDigest !== evidence.settlementDigest ||
        normalizedAuditRef !== `audit:${evidence.auditId}`
      ) {
        throw walMismatch();
      }
      if (
        ["audit_finalized", "proof_finalized"].includes(
          row.stage
        )
      ) {
        if (evidence.auditRef !== normalizedAuditRef) {
          throw walMismatch();
        }
        return currentRecord;
      }
      if (row.stage !== "evidence_pending") {
        throw walMismatch();
      }
      const finalized: Readonly<Record<string, any>> = Object.freeze({
        ...evidence,
        auditRef: normalizedAuditRef
      });
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'audit_finalized',
            evidence_json = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'evidence_pending'
          AND evidence_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        canonicalJson(finalized),
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        row.evidence_json,
        ownerFence,
        current
      ));
      return hydrate(read.get(requestRef));
    },
    async recordProofFinalized(
      requestRef?: any,
      {
        ownerFence,
        proofRef,
        settlementDigest
      }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const currentRecord: any = hydrate(row);
      const evidence: any = currentRecord.evidence;
      const normalizedProofRef: any = boundedId(
        proofRef,
        "Materialization proof reference"
      );
      if (
        !evidence ||
        settlementDigest !== evidence.settlementDigest
      ) {
        throw walMismatch();
      }
      if (row.stage === "proof_finalized") {
        if (evidence.proofRef !== normalizedProofRef) {
          throw walMismatch();
        }
        return currentRecord;
      }
      if (
        row.stage !== "audit_finalized" ||
        !evidence.auditRef
      ) {
        throw walMismatch();
      }
      const finalized: Readonly<Record<string, any>> = Object.freeze({
        ...evidence,
        proofRef: normalizedProofRef
      });
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET stage = 'proof_finalized',
            evidence_json = ?,
            lease_until = ?,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'audit_finalized'
          AND evidence_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        canonicalJson(finalized),
        current + currentLeaseMs,
        timestamp(),
        requestRef,
        row.evidence_json,
        ownerFence,
        current
      ));
      return hydrate(read.get(requestRef));
    },
    async complete(
      requestRef?: any,
      {
        ownerFence,
        result,
        settlementDigest
      }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      const currentRecord: any = hydrate(row);
      const evidence: any = currentRecord.evidence;
      if (
        row.stage !== "proof_finalized" ||
        !evidence ||
        evidence.settlementDigest !== settlementDigest
      ) {
        throw walMismatch();
      }
      const normalizedResult: any = normalizeCompletedResult(
        result,
        {
          request: currentRecord,
          effect: currentRecord.effect,
          evidence
        }
      );
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET status = 'completed',
            stage = 'completed',
            result_json = ?,
            error_json = NULL,
            owner_fence = '',
            lease_until = 0,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'proof_finalized'
          AND evidence_json = ?
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        canonicalJson(normalizedResult),
        timestamp(),
        requestRef,
        row.evidence_json,
        ownerFence,
        current
      ));
      return hydrate(read.get(requestRef));
    },
    async fail(
      requestRef?: any,
      { ownerFence, recoverable, error }: Record<string, any> = {}
    ) : Promise<any> {
      const row: any = assertLiveFence(requestRef, ownerFence);
      if (
        row.stage !== "admitted" ||
        row.publication_json ||
        row.effect_json ||
        row.evidence_json
      ) {
        throw failure(
          "materialization_recovery_required",
          409,
          "Materialization recovery must settle before failure."
        );
      }
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET status = ?,
            stage = 'admitted',
            preimage_json = NULL,
            target_state_digest = '',
            parent_fingerprint = '',
            parent_identity_json = NULL,
            prior_revision = '',
            error_json = ?,
            owner_fence = '',
            lease_until = 0,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND stage = 'admitted'
          AND publication_json IS NULL
          AND effect_json IS NULL
          AND evidence_json IS NULL
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        recoverable ? "queued" : "failed",
        canonicalErrorJson(
          error,
          "materialization_failed"
        ),
        timestamp(),
        requestRef,
        ownerFence,
        current
      ));
      return hydrate(read.get(requestRef));
    },
    async markRollbackIncomplete(
      requestRef?: any,
      { ownerFence, error }: Record<string, any> = {}
    ) : Promise<any> {
      const current: any = Number(now());
      requireChange(db.prepare(`
        UPDATE materialization_requests
        SET status = 'failed',
            stage = 'rollback_incomplete',
            error_json = ?,
            owner_fence = '',
            lease_until = 0,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'running'
          AND (
            stage IN (
              'publication_intent',
              'temp_reserved',
              'publication_prepared',
              'published',
              'evidence_pending',
              'audit_finalized',
              'proof_finalized'
            )
            OR (stage = 'admitted' AND preimage_json IS NOT NULL)
          )
          AND owner_fence = ?
          AND lease_until >= ?
      `).run(
        canonicalErrorJson(
          error,
          "materialization_rollback_incomplete"
        ),
        timestamp(),
        requestRef,
        ownerFence,
        current
      ));
    },
    async cancelQueued(requestRef?: any) : Promise<any> {
      const result: any = db.prepare(`
        UPDATE materialization_requests
        SET status = 'cancelled',
            stage = 'admitted',
            preimage_json = NULL,
            target_state_digest = '',
            parent_fingerprint = '',
            parent_identity_json = NULL,
            prior_revision = '',
            error_json = NULL,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'queued'
          AND stage = 'admitted'
          AND publication_json IS NULL
      `).run(timestamp(), requestRef);
      return Object.freeze({
        cancelled: Number(result.changes || 0) === 1
      });
    },
    async terminalFail(requestRef?: any, error?: any) : Promise<any> {
      const before: any = read.get(requestRef);
      if (!before) {
        return Object.freeze({
          transitioned: false,
          terminal: false,
          status: "missing",
          stage: ""
        });
      }
      const currentRecord: any = hydrate(before);
      if (
        ["cancelled", "completed", "failed"].includes(
          currentRecord.status
        )
      ) {
        return Object.freeze({
          transitioned: false,
          terminal: true,
          status: currentRecord.status,
          stage: currentRecord.stage
        });
      }
      const changed: any = db.prepare(`
        UPDATE materialization_requests
        SET status = 'failed',
            stage = 'admitted',
            preimage_json = NULL,
            target_state_digest = '',
            parent_fingerprint = '',
            parent_identity_json = NULL,
            prior_revision = '',
            error_json = ?,
            owner_fence = '',
            lease_until = 0,
            updated_at = ?
        WHERE request_ref = ?
          AND status = 'queued'
          AND stage = 'admitted'
          AND publication_json IS NULL
          AND effect_json IS NULL
          AND evidence_json IS NULL
      `).run(
        canonicalErrorJson(
          error,
          "materialization_retry_exhausted"
        ),
        timestamp(),
        requestRef
      );
      const after: any = read.get(requestRef);
      const afterRecord: any = after ? hydrate(after) : null;
      return Object.freeze({
        transitioned:
          Number(changed.changes || 0) === 1,
        terminal: Boolean(
          afterRecord &&
          ["cancelled", "completed", "failed"].includes(
            afterRecord.status
          )
        ),
        status: afterRecord?.status || "missing",
        stage: afterRecord?.stage || ""
      });
    },
    async listReconcileCandidates({
      afterRequestRef = "",
      limit = MAX_RECONCILE_BATCH
    }: Record<string, any> = {}) : Promise<any> {
      const boundedLimit: any = Math.max(
        1,
        Math.min(
          MAX_RECONCILE_BATCH,
          Number.isSafeInteger(Number(limit))
            ? Number(limit)
            : MAX_RECONCILE_BATCH
        )
      );
      return db.prepare(`
        SELECT *
        FROM materialization_requests
        WHERE status IN ('queued', 'running')
          AND request_ref > ?
        ORDER BY request_ref ASC
        LIMIT ?
      `).all(text(afterRequestRef), boundedLimit).map(hydrate);
    },
    async retryAfterLease(requestRef?: any) : Promise<any> {
      const row: any = read.get(requestRef);
      if (!row) {
        return Object.freeze({
          delayMs: 1,
          terminal: false,
          status: "missing",
          stage: ""
        });
      }
      const currentRecord: any = hydrate(row);
      const terminal: any = [
        "cancelled",
        "completed",
        "failed"
      ].includes(currentRecord.status);
      return Object.freeze({
        delayMs: terminal
          ? 0
          : Math.max(
              1,
              currentRecord.leaseUntil -
                Number(now()) +
                1
            ),
        terminal,
        status: currentRecord.status,
        stage: currentRecord.stage
      });
    },
    count() : any {
      return Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM materialization_requests"
          )
          .get().count
      );
    },
    close() : any {
      db.close();
    }
  });
}

export async function createUploadWorkspaceMaterializationProvider({
  userDataPath,
  queueApplicationPort,
  workspaceMaterializationPort,
  uploadSessionStore,
  uploadCustodyReadPort,
  deferredProtectedSinkAuthorityPort,
  resolveOperation,
  operationAuditStore,
  operationProofSubstrate,
  transactionStore = null,
  faultInjector = null
}: Record<string, any> = {}) : Promise<any> {
  const privateWorkspaceMaterializationPort: any =
    assertAgentWorkspaceMaterializationPort(
      workspaceMaterializationPort
    );
  for (const [value, methods, label] of [
    [
      queueApplicationPort,
      ["registerQueue"],
      "queueApplicationPort"
    ],
    [
      uploadSessionStore,
      ["resolveUploadSessionFiles"],
      "uploadSessionStore"
    ],
    [uploadCustodyReadPort, ["open"], "uploadCustodyReadPort"],
    [
      deferredProtectedSinkAuthorityPort,
      ["capture", "revalidate", "revoke"],
      "deferredProtectedSinkAuthorityPort"
    ]
  ]) {
    for (const method of methods) {
      if (typeof value?.[method] !== "function") {
        throw new TypeError(`${label}.${method} is required.`);
      }
    }
  }
  if (
    typeof resolveOperation !== "function" ||
    typeof operationAuditStore?.appendIdempotent !== "function" ||
    typeof operationAuditStore?.getById !== "function" ||
    typeof operationProofSubstrate?.beginLifecycle !== "function" ||
    typeof operationProofSubstrate?.finishLifecycle !== "function"
  ) {
    throw new TypeError(
      "Materialization authority and evidence dependencies are required."
    );
  }
  const store: any =
    transactionStore ||
    createUploadWorkspaceMaterializationTransactionStore({
      userDataPath
    });
  const ownsStore: any = !transactionStore;
  for (const method of [
    "assertFence",
    "begin",
    "cancelQueued",
    "complete",
    "create",
    "fail",
    "get",
    "listReconcileCandidates",
    "markRollbackIncomplete",
    "recordAuditFinalized",
    "recordEvidencePending",
    "recordPrecommitCleaned",
    "recordPreimage",
    "recordProofFinalized",
    "recordPublicationIntent",
    "recordPublicationPrepared",
    "recordPublished",
    "recordTempReserved",
    "renew",
    "retryAfterLease",
    "terminalFail"
  ]) {
    if (typeof store?.[method] !== "function") {
      if (ownsStore) store.close();
      throw new TypeError(`transactionStore.${method} is required.`);
    }
  }
  let closing: any = false;

  async function resolveCurrentDescriptor({ record, owner }: Record<string, any>) : Promise<any> {
    const files: any =
      await uploadSessionStore.resolveUploadSessionFiles(
        record.uploadSessionId,
        { owner }
      );
    const descriptor: any = exactDescriptor(
      files,
      record.uploadSessionId
    );
    if (!sameDescriptor(descriptor, record.descriptor)) {
      throw failure(
        "materialization_descriptor_changed",
        409,
        "Upload custody descriptor changed."
      );
    }
    return Object.freeze({
      descriptor,
      resourceRevision: digest(descriptor)
    });
  }

  const workspacePort = Object.freeze({
    withRequest(record?: any, task?: any) : any {
      if (typeof task !== "function") {
        throw new TypeError(
          "Workspace materialization request task is required."
        );
      }
      const descriptor: any = exactDescriptor(
        [{
          byteSize: record?.descriptor?.byteCount,
          contentDigest: record?.descriptor?.contentDigest,
          custodyRef: record?.descriptor?.custodyRef,
          envelopeDigest: record?.descriptor?.envelopeDigest,
          custodyState: record?.descriptor?.state
        }],
        record?.uploadSessionId
      );
      const binding: Readonly<Record<string, any>> = Object.freeze({
        bindingDigest: sha256Digest(
          record?.bindingDigest,
          "Materialization binding digest"
        ),
        byteCount: descriptor.byteCount,
        contentDigest: descriptor.contentDigest,
        expectedWorkspaceRevision: boundedId(
          record?.expectedWorkspaceRevision,
          "Expected workspace revision"
        ),
        logicalTarget: normalizeLogicalTarget(
          record?.logicalTarget
        ),
        operationId: boundedId(
          record?.operationId,
          "Materialization operation"
        ),
        requestRef: boundedId(
          record?.requestRef,
          "Materialization request reference"
        ),
        workspaceId: boundedId(
          record?.workspaceId,
          "Workspace identity"
        )
      });
      return privateWorkspaceMaterializationPort.withRequest(
        binding,
        (bound?: any) : any => task(bound)
      );
    }
  });

  let engine: any;
  try {
    engine = createUploadWorkspaceMaterialization({
      authorityPort: deferredProtectedSinkAuthorityPort,
      custodyReadPort: uploadCustodyReadPort,
      resourcePort: {
        resolveCurrentDescriptor
      },
      workspacePort,
      transactionStore: store,
      resolveOperation,
      auditPort: operationAuditStore,
      proofPort: operationProofSubstrate,
      faultObserver: faultInjector
    });
  } catch (error: any) {
    if (ownsStore) store.close();
    throw error;
  }

  let queue: any;
  try {
    queue = await queueApplicationPort.registerQueue({
    batchSize: 4,
    handler: async ({ workItem }: Record<string, any>, context?: any) : Promise<any> => {
      if (closing) {
        return {
          action: "retry",
          reason: "materialization_provider_closing"
        };
      }
      const requestRef: any = text(workItem?.payloadRef?.requestRef);
      try {
        await invokeProviderFault(faultInjector, "afterQueueClaim", {
          leaseSequence: Number(context?.lease?.leaseSeq || 0),
          requestRef
        });
        await engine.execute({
          ownerFence:
            `${workItem.workItemId}:${context.lease.leaseSeq}`,
          renewLease: () : any =>
            context.renewLease({
              reason: "materialization_lease_heartbeat"
            }),
          requestRef,
          signal: context.signal
        });
        await invokeProviderFault(
          faultInjector,
          "afterTransactionCompletedBeforeQueueAck",
          {
            leaseSequence: Number(context?.lease?.leaseSeq || 0),
            requestRef
          }
        );
        const settled: any = await store.retryAfterLease(requestRef);
        if (!settled.terminal) {
          return {
            action: "retry",
            delayMs: settled.delayMs,
            reason: "materialization_transaction_pending"
          };
        }
        return {
          action: "completed",
          reason: `materialization_${settled.status}`
        };
      } catch (error: any) {
        const disposition: any =
          materializationFailureDisposition(error);
        let settled: any = await store.retryAfterLease(requestRef);
        if (settled.terminal) {
          return {
            action: "completed",
            reason: `materialization_${settled.status}`
          };
        }
        if (error?.abrupt === true) {
          return {
            action: "retry",
            delayMs: settled.delayMs,
            reason: disposition.code
          };
        }
        const exhausted: any =
          Number(workItem?.attempt || 0) >=
          Number(workItem?.maxAttempts || 1);
        if (!disposition.retryable || exhausted) {
          const terminal: any = await store.terminalFail(requestRef, {
            code: disposition.code
          });
          settled = await store.retryAfterLease(requestRef);
          if (terminal.terminal && settled.terminal) {
            return {
              action: "completed",
              reason: disposition.code
            };
          }
          if (settled.terminal) {
            return {
              action: "completed",
              reason: `materialization_${settled.status}`
            };
          }
        }
        return {
          action: "retry",
          delayMs: settled.delayMs,
          reason: disposition.code
        };
      }
    },
    label: "meshrix.jobs.upload-workspace-materialization",
    maxInFlight: 4,
    ownerCapability: "platform.job-workflow",
    queueDefinitionId: DEFINITION_ID,
    queueDefinitionVersion: DEFINITION_VERSION,
    scope: {
      tenantId: "platform",
      workspaceId: "governed"
    },
      workerId: "upload-workspace-materialization-worker"
    });
    for (const method of [
      "cancel",
      "close",
      "enqueue",
      "requestDispatch"
    ]) {
      if (typeof queue?.[method] !== "function") {
        throw new TypeError(`queue.${method} is required.`);
      }
    }
  } catch (error: any) {
    await Promise.resolve()
      .then(() : any => queue?.close?.({ timeoutMs: 0 }))
      .catch(() : any => null);
    if (ownsStore) store.close();
    throw error;
  }

  async function enqueue(
    record?: any,
    { requestDispatch = true }: Record<string, any> = {}
  ) : Promise<any> {
    const requestRef: any = boundedId(
      record?.requestRef,
      "Materialization request reference"
    );
    const bindingDigest: any = sha256Digest(
      record?.bindingDigest,
      "Materialization binding digest"
    );
    const workspaceId: any = boundedId(
      record?.workspaceId,
      "Workspace identity"
    );
    await queue.enqueue({
      dedupeKey: requestRef,
      maxAttempts: MATERIALIZATION_MAX_ATTEMPTS,
      ownerRef: {
        capability: "platform.job-workflow",
        subjectRef: digest(requestRef)
      },
      payloadKind: "upload_workspace_materialization",
      payloadRef: {
        requestRef
      },
      schedulingScope: {
        workspaceId
      },
      workItemId: `materialization-work:${bindingDigest}`
    });
    if (requestDispatch) {
      void Promise.resolve()
        .then(() : any => queue.requestDispatch())
        .catch(() : any => null);
    }
  }

  async function reconcilePendingRequests() : Promise<any> {
    let afterRequestRef: any = "";
    let reconciled: any = false;
    for (;;) {
      const records: any = await store.listReconcileCandidates({
        afterRequestRef,
        limit: MAX_RECONCILE_BATCH
      });
      if (!Array.isArray(records)) {
        throw new TypeError(
          "transactionStore.listReconcileCandidates must return an array."
        );
      }
      if (records.length > MAX_RECONCILE_BATCH) {
        throw new TypeError(
          "transactionStore.listReconcileCandidates exceeded its limit."
        );
      }
      for (const record of records) {
        const requestRef: any = boundedId(
          record?.requestRef,
          "Materialization request reference"
        );
        if (requestRef <= afterRequestRef) {
          throw new TypeError(
            "transactionStore.listReconcileCandidates is not ordered."
          );
        }
        await enqueue(record, { requestDispatch: false });
        afterRequestRef = requestRef;
        reconciled = true;
      }
      if (records.length < MAX_RECONCILE_BATCH) break;
    }
    if (reconciled) {
      void Promise.resolve()
        .then(() : any => queue.requestDispatch())
        .catch(() : any => null);
    }
  }

  try {
    await reconcilePendingRequests();
  } catch (error: any) {
    closing = true;
    await Promise.resolve()
      .then(() : any => queue.close({ timeoutMs: 0 }))
      .catch(() : any => null);
    if (ownsStore) store.close();
    throw error;
  }

  function publicAdmission(record?: any, { deduped = false }: Record<string, any> = {}) : any {
    return Object.freeze({
      accepted: true,
      deduped,
      requestRef: record.requestRef,
      ...(record.status === "completed"
        ? {
            result: Object.freeze({
              ...record.result,
              replayed: true,
              status: "completed"
            })
          }
        : {})
    });
  }

  return Object.freeze({
    async submit({
      request,
      authSession,
      operation,
      input
    }: Record<string, any> = {}) : Promise<any> {
      if (closing) {
        throw failure(
          "materialization_provider_closing",
          503,
          "Materialization provider is closing."
        );
      }
      if (
        operation?.id !==
        "jobs.upload_workspace_materialize"
      ) {
        throw failure(
          "materialization_operation_invalid",
          400,
          "Materialization operation is invalid."
        );
      }
      const closedInput: any = closedAdmissionInput(input);
      const owner: any = normalizedOwner(authSession);
      const requestRef: any = requestReference(closedInput, owner);
      const existing: any = await store.get(requestRef);
      if (existing?.status === "completed") {
        return publicAdmission(existing, { deduped: true });
      }
      if (existing?.status === "cancelled") {
        throw failure(
          "materialization_cancelled",
          409,
          "Materialization request was cancelled."
        );
      }
      if (existing?.status === "failed") {
        throw failure(
          "materialization_terminal_failed",
          409,
          "Materialization request is terminal."
        );
      }
      if (existing) {
        await enqueue(existing);
        return publicAdmission(existing, { deduped: true });
      }
      const files: any =
        await uploadSessionStore.resolveUploadSessionFiles(
          closedInput.uploadSessionId,
          { owner }
        );
      const descriptor: any = exactDescriptor(
        files,
        closedInput.uploadSessionId
      );
      const captured: any =
        await deferredProtectedSinkAuthorityPort.capture({
          authSession,
          input: closedInput,
          operation,
          request
        });
      const resourceRevision: any = digest(descriptor);
      const bindingDigest: any = digest({
        authorityBindingDigest:
          captured.authorityBindingDigest,
        descriptor,
        expectedWorkspaceRevision:
          closedInput.expectedWorkspaceRevision,
        logicalTarget: closedInput.logicalTarget,
        operationId: operation.id,
        requestDigest: captured.requestDigest,
        requestRef,
        uploadSessionId: closedInput.uploadSessionId,
        workspaceId: closedInput.workspaceId
      });
      const record: Readonly<Record<string, any>> = Object.freeze({
        approvalIntentDigest:
          captured.approvalIntentDigest,
        authorityBindingDigest:
          captured.authorityBindingDigest,
        authorityRef: captured.authorityRef,
        bindingDigest,
        descriptor,
        expectedWorkspaceRevision:
          closedInput.expectedWorkspaceRevision,
        logicalTarget: closedInput.logicalTarget,
        operationId: operation.id,
        requestDigest: captured.requestDigest,
        requestRef,
        resourceRevision,
        uploadSessionId: closedInput.uploadSessionId,
        workspaceId: closedInput.workspaceId
      });
      let created: any;
      try {
        created = await store.create(record);
      } catch (error: any) {
        await Promise.resolve()
          .then(() : any =>
            deferredProtectedSinkAuthorityPort.revoke({
              authorityRef: captured.authorityRef,
              reason: "materialization_admission_failed"
            })
          )
          .catch(() : any => null);
        throw error;
      }
      if (created.inserted !== true) {
        await deferredProtectedSinkAuthorityPort.revoke({
          authorityRef: captured.authorityRef,
          reason: "materialization_admission_race"
        });
        const raced: any = await store.get(requestRef);
        if (!raced) {
          throw failure(
            "materialization_admission_failed",
            500,
            "Materialization admission failed."
          );
        }
        if (raced.status === "cancelled") {
          throw failure(
            "materialization_cancelled",
            409,
            "Materialization request was cancelled."
          );
        }
        if (raced.status === "failed") {
          throw failure(
            "materialization_terminal_failed",
            409,
            "Materialization request is terminal."
          );
        }
        if (raced.status !== "completed") {
          await enqueue(raced);
        }
        return publicAdmission(raced, { deduped: true });
      }
      await invokeProviderFault(
        faultInjector,
        "afterTransactionCreatedBeforeEnqueue",
        {
          bindingDigest: record.bindingDigest,
          requestRef: record.requestRef
        }
      );
      await enqueue(record);
      return publicAdmission(record);
    },
    get(requestRef?: any) : any {
      return engine.get(requestRef);
    },
    async cancel(requestRef?: any, { subject }: Record<string, any> = {}) : Promise<any> {
      const record: any = await store.get(requestRef);
      if (!record) return null;
      let expectedRef: any;
      try {
        expectedRef = requestReference(
          {
            expectedWorkspaceRevision:
              record.expectedWorkspaceRevision,
            logicalTarget: record.logicalTarget,
            uploadSessionId: record.uploadSessionId,
            workspaceId: record.workspaceId
          },
          normalizedOwner(subject)
        );
      } catch {
        return null;
      }
      if (expectedRef !== requestRef) return null;
      if (
        ["cancelled", "completed", "failed"].includes(
          record.status
        )
      ) {
        return Object.freeze({
          requestRef,
          stage: record.stage,
          status: record.status
        });
      }
      await queue.cancel({
        actor: {
          system: "platform-job-workflow"
        },
        operationId:
          "jobs.upload_workspace_materialization_cancel",
        reason: "workspace_materialization_cancelled",
        workItemId:
          `materialization-work:${record.bindingDigest}`
      });
      await store.cancelQueued(requestRef);
      const cancelled: any = await store.get(requestRef);
      return Object.freeze({
        requestRef,
        stage: cancelled.stage,
        status: cancelled.status
      });
    },
    async close() : Promise<any> {
      if (closing) return;
      closing = true;
      try {
        await queue.close({ timeoutMs: 30_000 });
      } finally {
        if (ownsStore) store.close();
      }
    }
  });
}
