import { randomUUID } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import { ensurePrivateDir } from "#meshrix/foundation/storage/private-file-atomic";
import { ensurePrivateSqliteLocation } from "#meshrix/foundation/storage/private-sqlite";
import {
  normalizeManifestKey,
  SAFE_JOB_ID_PATTERN
} from "./job-manager-validation.ts";
import { errorProperty, isJobDocument, type JobDocument, type JobStatus } from "./contracts.ts";

type SqliteValue = string | number | bigint | Buffer | null;
type SqliteRow = Record<string, SqliteValue>;
type SqliteBind = SqliteValue | Record<string, SqliteValue>;
interface SqliteStatement {
  run(...params: SqliteBind[]): Database.RunResult;
  get(...params: SqliteBind[]): SqliteRow | undefined;
  all(...params: SqliteBind[]): SqliteRow[];
}

interface ProjectionPolicyInput {
  maxRecords?: number;
  maxActiveRecords?: number;
  maxMetadataBytes?: number;
  maxArtifactBytes?: number;
  maxJobMetadataBytes?: number;
  maxPayloadBytes?: number;
  maxResultBytes?: number;
  terminalRetentionMs?: number;
  cleanupBatch?: number;
  busyTimeoutMs?: number;
}

interface JobAccessFilter {
  principalIds?: readonly string[];
  workspaceIds?: readonly string[];
  jobIds?: readonly string[];
}

interface PageInput {
  cursor?: string;
  limit?: number;
}

const SCHEMA_VERSION = 3;
const TERMINAL_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);
const DEFAULT_MAX_RECORDS = 100_000;
const DEFAULT_MAX_ACTIVE_RECORDS = 10_000;
const DEFAULT_MAX_METADATA_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_MAX_JOB_METADATA_BYTES = 256 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024 * 1024;
const DEFAULT_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_BATCH = 64;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_PAGE_SIZE = 200;
const MAX_ACCESS_VALUES = 100;
const STATEMENT_CACHES = new WeakMap<Database.Database, Map<string, SqliteStatement>>();

function prepareCached(db: Database.Database, sql: string): SqliteStatement {
  let cache = STATEMENT_CACHES.get(db);
  if (!cache) {
    cache = new Map<string, SqliteStatement>();
    STATEMENT_CACHES.set(db, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql) as SqliteStatement;
    cache.set(sql, statement);
  }
  return statement;
}

function projectionError(code: string, message: string, statusCode = 500) {
  return Object.assign(new Error(message), { code, statusCode });
}

function positiveInteger(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function normalizePolicy(policy: ProjectionPolicyInput = {}) {
  return Object.freeze({
    maxRecords: positiveInteger(policy.maxRecords, DEFAULT_MAX_RECORDS, 1_000_000),
    maxActiveRecords: positiveInteger(
      policy.maxActiveRecords,
      DEFAULT_MAX_ACTIVE_RECORDS,
      100_000
    ),
    maxMetadataBytes: positiveInteger(
      policy.maxMetadataBytes,
      DEFAULT_MAX_METADATA_BYTES,
      1024 * 1024 * 1024
    ),
    maxArtifactBytes: positiveInteger(
      policy.maxArtifactBytes,
      DEFAULT_MAX_ARTIFACT_BYTES,
      64 * 1024 * 1024 * 1024
    ),
    maxJobMetadataBytes: positiveInteger(
      policy.maxJobMetadataBytes,
      DEFAULT_MAX_JOB_METADATA_BYTES,
      4 * 1024 * 1024
    ),
    maxPayloadBytes: positiveInteger(
      policy.maxPayloadBytes,
      DEFAULT_MAX_PAYLOAD_BYTES,
      1024 * 1024 * 1024
    ),
    maxResultBytes: positiveInteger(
      policy.maxResultBytes,
      DEFAULT_MAX_RESULT_BYTES,
      4 * 1024 * 1024 * 1024
    ),
    terminalRetentionMs: positiveInteger(
      policy.terminalRetentionMs,
      DEFAULT_TERMINAL_RETENTION_MS,
      365 * 24 * 60 * 60 * 1000
    ),
    cleanupBatch: positiveInteger(
      policy.cleanupBatch,
      DEFAULT_CLEANUP_BATCH,
      1_024
    ),
    busyTimeoutMs: positiveInteger(
      policy.busyTimeoutMs,
      DEFAULT_BUSY_TIMEOUT_MS,
      30_000
    )
  });
}

function timestamp(value: unknown, fallback = 0) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStatus(value: unknown): JobStatus {
  const status = String(value || "");
  if (!["queued", "running", ...TERMINAL_STATUSES].includes(status)) {
    throw projectionError(
      "job_projection_status_invalid",
      "Job projection status is invalid."
    );
  }
  return status as JobStatus;
}

function serializeJob(job: JobDocument, maxBytes: number) {
  const serialized = JSON.stringify(job);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maxBytes) {
    throw projectionError(
      "job_projection_metadata_too_large",
      "Job metadata exceeds the projection record limit.",
      413
    );
  }
  return { serialized, bytes };
}

function rowToJob(row: SqliteRow | undefined): JobDocument | null {
  if (!row) return null;
  const job: unknown = JSON.parse(String(row.job_json));
  if (!isJobDocument(job)) {
    throw projectionError("job_projection_record_invalid", "Job projection record is invalid.");
  }
  return {
    ...job,
    id: String(row.id),
    status: normalizeStatus(row.status)
  };
}

function encodeCursor(createdAtMs: number, id: string) {
  return Buffer.from(
    JSON.stringify([Number(createdAtMs), String(id)]),
    "utf8"
  ).toString("base64url");
}

function decodeCursor(cursor?: string) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(String(cursor), "base64url").toString("utf8")
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      !Number.isSafeInteger(Number(decoded[0])) ||
      !SAFE_JOB_ID_PATTERN.test(String(decoded[1]))
    ) {
      return null;
    }
    return { createdAtMs: Number(decoded[0]), id: String(decoded[1]) };
  } catch {
    return null;
  }
}

function normalizedAccessValues(values?: readonly string[]) {
  const normalized = [...new Set<string>(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];
  if (normalized.length > MAX_ACCESS_VALUES) {
    throw projectionError(
      "job_projection_access_filter_too_large",
      "Job access filter exceeds its configured value limit.",
      413
    );
  }
  return normalized;
}

function accessPredicate(access?: JobAccessFilter | null) {
  if (!access) return { clause: "", params: [] };
  const principals = normalizedAccessValues(access.principalIds);
  const workspaceIds = normalizedAccessValues(access.workspaceIds);
  const jobIds = normalizedAccessValues(access.jobIds);
  const clauses: string[] = [];
  const params: string[] = [];
  const addValues = (column: string, values: string[]) => {
    if (values.length === 0) return;
    clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };
  addValues("id", jobIds);
  addValues("workspace_id", workspaceIds);
  addValues("owner_subject_id", principals);
  return {
    clause: clauses.length > 0 ? `(${clauses.join(" OR ")})` : "0",
    params
  };
}

function createSchema(db: Database.Database) {
  const requiredExistingTables = new Set<string>([
    "job_projection_meta",
    "jobs",
    "job_status_counts",
    "job_artifact_journal"
  ]);
  const existingTables = new Set<string>(
    prepareCached(db, `
      SELECT name
      FROM sqlite_master
      WHERE type='table'
        AND name IN (
          'job_projection_meta',
          'jobs',
          'job_status_counts',
          'job_artifact_journal',
          'job_upload_cleanup_journal'
        )
    `).all().map((entry) => String((entry as SqliteRow).name))
  );
  if (
    existingTables.size !== 0 &&
    [...requiredExistingTables].some((table) => !existingTables.has(table))
  ) {
    throw projectionError(
      "job_projection_schema_incomplete",
      "Job projection schema is incomplete."
    );
  }
  const initializing = existingTables.size === 0;
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_projection_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER NOT NULL DEFAULT 0,
      owner_subject_id TEXT NOT NULL DEFAULT '',
      owner_user_id TEXT NOT NULL DEFAULT '',
      owner_username TEXT NOT NULL DEFAULT '',
      owner_tenant_id TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      checkpoint_id TEXT NOT NULL DEFAULT '',
      checkpoint_tree_id TEXT NOT NULL DEFAULT '',
      workflow_id TEXT NOT NULL DEFAULT '',
      manifest_key TEXT NOT NULL DEFAULT '',
      archive_batch_id TEXT NOT NULL DEFAULT '',
      version_group_id TEXT NOT NULL DEFAULT '',
      version_number INTEGER NOT NULL DEFAULT 1,
      parent_job_id TEXT NOT NULL DEFAULT '',
      work_item_id TEXT NOT NULL DEFAULT '',
      payload_ref TEXT NOT NULL DEFAULT '',
      payload_digest TEXT NOT NULL DEFAULT '',
      payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK(payload_bytes>=0),
      result_ref TEXT NOT NULL DEFAULT '',
      result_digest TEXT NOT NULL DEFAULT '',
      result_bytes INTEGER NOT NULL DEFAULT 0 CHECK(result_bytes>=0),
      terminal_digest TEXT NOT NULL DEFAULT '',
      stage_code TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      job_json BLOB NOT NULL,
      metadata_bytes INTEGER NOT NULL CHECK(metadata_bytes>=0)
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_created_id
      ON jobs(created_at_ms DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_owner_created_id
      ON jobs(owner_subject_id,created_at_ms DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_workspace_created_id
      ON jobs(workspace_id,created_at_ms DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created_id
      ON jobs(status,created_at_ms,id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status_id
      ON jobs(status,id);
    CREATE INDEX IF NOT EXISTS idx_jobs_terminal_finished_id
      ON jobs(finished_at_ms,id)
      WHERE status IN ('completed','failed','cancelled');
    CREATE INDEX IF NOT EXISTS idx_jobs_version
      ON jobs(version_group_id,version_number DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_checkpoint
      ON jobs(checkpoint_id,created_at_ms DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_work_item
      ON jobs(work_item_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_version_unique
      ON jobs(version_group_id,version_number)
      WHERE version_group_id<>'';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_manifest
      ON jobs(manifest_key,archive_batch_id)
      WHERE manifest_key<>'' AND status IN ('queued','running');
    CREATE TABLE IF NOT EXISTS job_status_counts (
      status TEXT PRIMARY KEY,
      count INTEGER NOT NULL CHECK(count>=0)
    );
    CREATE TABLE IF NOT EXISTS job_artifact_journal (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      final_ref TEXT NOT NULL,
      digest TEXT NOT NULL DEFAULT '',
      byte_size INTEGER NOT NULL DEFAULT 0 CHECK(byte_size>=0),
      state TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      journal_job_json BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_job_artifact_journal_state
      ON job_artifact_journal(state,created_at_ms,id);
    CREATE TABLE IF NOT EXISTS job_upload_cleanup_journal (
      session_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      receipt_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state='pending'),
      created_at_ms INTEGER NOT NULL,
      UNIQUE(job_id),
      UNIQUE(receipt_id)
    );
    CREATE INDEX IF NOT EXISTS idx_job_upload_cleanup_created
      ON job_upload_cleanup_journal(created_at_ms,session_id);
  `);
  const initialMeta = [
    ["schema_version", SCHEMA_VERSION],
    ["metadata_bytes", 0],
    ["artifact_bytes", 0],
    ["prepared_artifact_bytes", 0],
    ["pending_delete_bytes", 0],
    ["revision", 0]
  ];
  const statuses = ["queued", "running", ...TERMINAL_STATUSES];
  if (initializing) {
    const meta = prepareCached(db,
      "INSERT INTO job_projection_meta(key,value) VALUES(?,?)"
    );
    const count = prepareCached(db,
      "INSERT INTO job_status_counts(status,count) VALUES(?,0)"
    );
    db.transaction(() => {
      for (const [key, value] of initialMeta) meta.run(key, value);
      for (const status of statuses) count.run(status);
    })();
  } else {
    const metaKeys = new Set<string>(
      prepareCached(db, "SELECT key FROM job_projection_meta").all()
        .map((entry) => String((entry as SqliteRow).key))
    );
    const countKeys = new Set<string>(
      prepareCached(db, "SELECT status FROM job_status_counts").all()
        .map((entry) => String((entry as SqliteRow).status))
    );
    if (
      initialMeta.some(([key]) => !metaKeys.has(String(key))) ||
      statuses.some((status) => !countKeys.has(status))
    ) {
      throw projectionError(
        "job_projection_meta_incomplete",
        "Job projection metadata is incomplete."
      );
    }
  }
  let version = Number(
    prepareCached(db,
      "SELECT value FROM job_projection_meta WHERE key='schema_version'"
    ).get()?.value
  );
  if (!initializing && version === 2) {
    prepareCached(
      db,
      "UPDATE job_projection_meta SET value=? WHERE key='schema_version'"
    ).run(SCHEMA_VERSION);
    version = SCHEMA_VERSION;
  }
  if (version !== SCHEMA_VERSION) {
    throw projectionError(
      "job_projection_schema_unsupported",
      "Job projection schema is unsupported."
    );
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS jobs_projection_insert
    AFTER INSERT ON jobs
    BEGIN
      UPDATE job_status_counts SET count=count+1 WHERE status=NEW.status;
      UPDATE job_projection_meta
      SET value=value+NEW.metadata_bytes
      WHERE key='metadata_bytes';
      UPDATE job_projection_meta
      SET value=value+NEW.payload_bytes+NEW.result_bytes
      WHERE key='artifact_bytes';
      UPDATE job_projection_meta SET value=value+1 WHERE key='revision';
    END;
    CREATE TRIGGER IF NOT EXISTS jobs_projection_delete
    AFTER DELETE ON jobs
    BEGIN
      UPDATE job_status_counts SET count=count-1 WHERE status=OLD.status;
      UPDATE job_projection_meta
      SET value=value-OLD.metadata_bytes
      WHERE key='metadata_bytes';
      UPDATE job_projection_meta
      SET value=value-OLD.payload_bytes-OLD.result_bytes
      WHERE key='artifact_bytes';
      UPDATE job_projection_meta SET value=value+1 WHERE key='revision';
    END;
    CREATE TRIGGER IF NOT EXISTS jobs_projection_update
    AFTER UPDATE ON jobs
    BEGIN
      UPDATE job_status_counts
      SET count=count-1
      WHERE status=OLD.status AND OLD.status<>NEW.status;
      UPDATE job_status_counts
      SET count=count+1
      WHERE status=NEW.status AND OLD.status<>NEW.status;
      UPDATE job_projection_meta
      SET value=value+NEW.metadata_bytes-OLD.metadata_bytes
      WHERE key='metadata_bytes';
      UPDATE job_projection_meta
      SET value=value+NEW.payload_bytes+NEW.result_bytes-OLD.payload_bytes-OLD.result_bytes
      WHERE key='artifact_bytes';
      UPDATE job_projection_meta SET value=value+1 WHERE key='revision';
    END;
    CREATE TRIGGER IF NOT EXISTS job_artifact_journal_insert
    AFTER INSERT ON job_artifact_journal
    BEGIN
      UPDATE job_projection_meta
      SET value=value+CASE WHEN NEW.state='prepared' THEN NEW.byte_size ELSE 0 END
      WHERE key='prepared_artifact_bytes';
      UPDATE job_projection_meta
      SET value=value+CASE WHEN NEW.state='pending_delete' THEN NEW.byte_size ELSE 0 END
      WHERE key='pending_delete_bytes';
    END;
    CREATE TRIGGER IF NOT EXISTS job_artifact_journal_update
    AFTER UPDATE ON job_artifact_journal
    BEGIN
      UPDATE job_projection_meta
      SET value=value
        -CASE WHEN OLD.state='prepared' THEN OLD.byte_size ELSE 0 END
        +CASE WHEN NEW.state='prepared' THEN NEW.byte_size ELSE 0 END
      WHERE key='prepared_artifact_bytes';
      UPDATE job_projection_meta
      SET value=value
        -CASE WHEN OLD.state='pending_delete' THEN OLD.byte_size ELSE 0 END
        +CASE WHEN NEW.state='pending_delete' THEN NEW.byte_size ELSE 0 END
      WHERE key='pending_delete_bytes';
    END;
    CREATE TRIGGER IF NOT EXISTS job_artifact_journal_delete
    AFTER DELETE ON job_artifact_journal
    BEGIN
      UPDATE job_projection_meta
      SET value=value-CASE WHEN OLD.state='prepared' THEN OLD.byte_size ELSE 0 END
      WHERE key='prepared_artifact_bytes';
      UPDATE job_projection_meta
      SET value=value-CASE WHEN OLD.state='pending_delete' THEN OLD.byte_size ELSE 0 END
      WHERE key='pending_delete_bytes';
    END;
  `);
}

function readMeta(db: Database.Database) {
  const values = Object.fromEntries(
    prepareCached(db, "SELECT key,value FROM job_projection_meta").all()
      .map((entry) => [String((entry as SqliteRow).key), Number((entry as SqliteRow).value)])
  );
  const counts = Object.fromEntries(
    prepareCached(db, "SELECT status,count FROM job_status_counts").all()
      .map((entry) => [String((entry as SqliteRow).status), Number((entry as SqliteRow).count)])
  );
  return {
    metadataBytes: Number(values.metadata_bytes || 0),
    artifactBytes: Number(values.artifact_bytes || 0),
    preparedArtifactBytes: Number(values.prepared_artifact_bytes || 0),
    pendingDeleteBytes: Number(values.pending_delete_bytes || 0),
    revision: Number(values.revision || 0),
    counts,
    totalCount: Object.values(counts).reduce((sum, count) => sum + Number(count), 0),
    activeCount: Number(counts.queued || 0) + Number(counts.running || 0)
  };
}

function queueDeletion(db: Database.Database, row: SqliteRow, nowMs: number) {
  prepareCached(db, `
    INSERT OR IGNORE INTO job_artifact_journal(
      id,job_id,kind,final_ref,digest,byte_size,state,created_at_ms,
      journal_job_json
    ) VALUES(?,?,?,?,?,?,?,?,NULL)
  `).run(
    `delete:${row.id}`,
    row.id,
    "delete_job",
    path.posix.join("jobs", String(row.id)),
    "",
    Number(row.payload_bytes || 0) + Number(row.result_bytes || 0),
    "pending_delete",
    nowMs
  );
  prepareCached(db, "DELETE FROM jobs WHERE id=?").run(row.id);
}

function pruneForAdmission(
  db: Database.Database,
  policy: ReturnType<typeof normalizePolicy>,
  incomingMetadataBytes: number,
  nowMs: number,
  {
    excludedJobId = "",
    reserveRecord = true
  }: { excludedJobId?: string; reserveRecord?: boolean } = {}
) {
  let removed = 0;
  const expiry = nowMs - policy.terminalRetentionMs;
  while (removed < policy.cleanupBatch) {
    const meta = readMeta(db);
    const overCapacity =
      meta.totalCount + (reserveRecord ? 1 : 0) > policy.maxRecords ||
      meta.metadataBytes + incomingMetadataBytes > policy.maxMetadataBytes;
    const row = overCapacity
      ? prepareCached(db, `
          SELECT id,payload_bytes,result_bytes,finished_at_ms
          FROM jobs INDEXED BY idx_jobs_terminal_finished_id
          WHERE status IN ('completed','failed','cancelled')
            AND id<>?
          ORDER BY finished_at_ms ASC,id ASC
          LIMIT 1
        `).get(excludedJobId)
      : prepareCached(db, `
          SELECT id,payload_bytes,result_bytes,finished_at_ms
          FROM jobs INDEXED BY idx_jobs_terminal_finished_id
          WHERE status IN ('completed','failed','cancelled')
            AND finished_at_ms<=?
            AND id<>?
          ORDER BY finished_at_ms ASC,id ASC
          LIMIT 1
        `).get(expiry, excludedJobId);
    if (!row) break;
    queueDeletion(db, row, nowMs);
    removed += 1;
  }
  return removed;
}

function bindJob(job: JobDocument, serialized: string, bytes: number, existing: SqliteRow | null = null) {
  const createdAtMs = timestamp(job.createdAt, Date.now());
  const updatedAtMs = timestamp(job.updatedAt, createdAtMs);
  const status = normalizeStatus(job.status);
  return {
    id: String(job.id || ""),
    status,
    createdAtMs,
    updatedAtMs,
    finishedAtMs: timestamp(
      job.finishedAt,
      TERMINAL_STATUSES.includes(status) ? updatedAtMs : 0
    ),
    ownerSubjectId: String(
      job.ownerSubjectId ||
      job.createdBySubjectId ||
      job.owner?.subjectId ||
      job.ownerUserId ||
      job.ownerUsername ||
      ""
    ),
    ownerUserId: String(
      job.ownerUserId ||
      job.createdByUserId ||
      job.owner?.userId ||
      job.ownerSubjectId ||
      ""
    ),
    ownerUsername: String(
      job.ownerUsername ||
      job.createdBy ||
      job.owner?.username ||
      ""
    ),
    ownerTenantId: String(job.ownerTenantId || ""),
    workspaceId: String(
      job.workspaceId ||
      job.workspace_id ||
      job.workspace ||
      job.payload?.workspaceId ||
      ""
    ),
    checkpointId: String(job.checkpointId || ""),
    checkpointTreeId: String(job.checkpointTreeId || ""),
    workflowId: String(job.workflowId || ""),
    manifestKey: normalizeManifestKey(job),
    archiveBatchId: String(job.archiveBatchId || ""),
    versionGroupId: String(job.versionGroupId || ""),
    versionNumber: positiveInteger(job.versionNumber, 1),
    parentJobId: String(job.parentJobId || job.reparseFromJobId || ""),
    workItemId: String(job.workItemId || ""),
    payloadRef: String(existing?.payload_ref || ""),
    payloadDigest: String(existing?.payload_digest || ""),
    payloadBytes: Number(existing?.payload_bytes || 0),
    resultRef: String(existing?.result_ref || ""),
    resultDigest: String(existing?.result_digest || ""),
    resultBytes: Number(existing?.result_bytes || 0),
    terminalDigest: String(existing?.terminal_digest || ""),
    stageCode: String(job.stageCode || job.stage || "").slice(0, 256),
    errorCode: String(job.errorCode || "").slice(0, 128),
    revision: Number(existing?.revision || 0) + 1,
    serialized,
    metadataBytes: bytes
  };
}

export function createJobProjectionStore({
  userDataPath,
  policy: requestedPolicy = {},
  now = Date.now
}: {
  userDataPath: string;
  policy?: ProjectionPolicyInput;
  now?: () => number;
}) {
  const policy = normalizePolicy(requestedPolicy);
  const jobsRoot = path.join(userDataPath, "jobs");
  ensurePrivateDir(jobsRoot);
  const databasePath = path.join(jobsRoot, "jobs.sqlite");
  ensurePrivateSqliteLocation(databasePath);
  const db = openSqliteDatabase(databasePath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${policy.busyTimeoutMs}`);
    createSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const upsertTransaction = db.transaction((job: JobDocument, allocateVersion: boolean) => {
    if (!job?.id || !SAFE_JOB_ID_PATTERN.test(String(job.id))) {
      return {
        error: projectionError(
          "job_projection_identity_invalid",
          "Job projection identity is invalid."
        )
      };
    }
    const candidate = allocateVersion && job.versionGroupId
      ? {
          ...job,
          versionNumber: Number(prepareCached(db, `
            SELECT COALESCE(MAX(version_number),0)+1 AS value
            FROM jobs
            WHERE version_group_id=?
          `).get(String(job.versionGroupId))?.value || 1)
        }
      : job;
    const { serialized, bytes } = serializeJob(
      candidate,
      policy.maxJobMetadataBytes
    );
    const existing = prepareCached(db, "SELECT * FROM jobs WHERE id=?").get(job.id);
    if (!existing) {
      pruneForAdmission(db, policy, bytes, now(), { reserveRecord: true });
      const meta = readMeta(db);
      if (meta.totalCount + 1 > policy.maxRecords) {
        return {
          error: projectionError(
            "job_projection_record_capacity_exceeded",
            "Job history record capacity is exhausted.",
            503
          )
        };
      }
      if (meta.metadataBytes + bytes > policy.maxMetadataBytes) {
        return {
          error: projectionError(
            "job_projection_metadata_capacity_exceeded",
            "Job history metadata capacity is exhausted.",
            503
          )
        };
      }
      if (
        ["queued", "running"].includes(candidate.status) &&
        meta.activeCount + 1 > policy.maxActiveRecords
      ) {
        return {
          error: projectionError(
            "job_projection_active_capacity_exceeded",
            "Active job capacity is exhausted.",
            503
          )
        };
      }
    } else {
      const meta = readMeta(db);
      if (
        !["queued", "running"].includes(String(existing.status)) &&
        ["queued", "running"].includes(String(candidate.status)) &&
        meta.activeCount + 1 > policy.maxActiveRecords
      ) {
        return {
          error: projectionError(
            "job_projection_active_capacity_exceeded",
            "Active job capacity is exhausted.",
            503
          )
        };
      }
      if (
        meta.metadataBytes - Number(existing.metadata_bytes) + bytes >
        policy.maxMetadataBytes
      ) {
        pruneForAdmission(
          db,
          policy,
          bytes - Number(existing.metadata_bytes),
          now(),
          {
            excludedJobId: String(job.id),
            reserveRecord: false
          }
        );
        if (
          readMeta(db).metadataBytes - Number(existing.metadata_bytes) + bytes >
          policy.maxMetadataBytes
        ) {
          return {
            error: projectionError(
              "job_projection_metadata_capacity_exceeded",
              "Job history metadata capacity is exhausted.",
              503
            )
          };
        }
      }
    }
    const record = bindJob(candidate, serialized, bytes, existing);
    prepareCached(db, `
      INSERT INTO jobs(
        id,status,created_at_ms,updated_at_ms,finished_at_ms,
        owner_subject_id,owner_user_id,owner_username,owner_tenant_id,workspace_id,
        checkpoint_id,checkpoint_tree_id,workflow_id,manifest_key,archive_batch_id,
        version_group_id,version_number,parent_job_id,work_item_id,
        payload_ref,payload_digest,payload_bytes,result_ref,result_digest,result_bytes,
        terminal_digest,stage_code,error_code,revision,job_json,metadata_bytes
      ) VALUES(
        @id,@status,@createdAtMs,@updatedAtMs,@finishedAtMs,
        @ownerSubjectId,@ownerUserId,@ownerUsername,@ownerTenantId,@workspaceId,
        @checkpointId,@checkpointTreeId,@workflowId,@manifestKey,@archiveBatchId,
        @versionGroupId,@versionNumber,@parentJobId,@workItemId,
        @payloadRef,@payloadDigest,@payloadBytes,@resultRef,@resultDigest,@resultBytes,
        @terminalDigest,@stageCode,@errorCode,@revision,@serialized,@metadataBytes
      )
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        created_at_ms=excluded.created_at_ms,
        updated_at_ms=excluded.updated_at_ms,
        finished_at_ms=excluded.finished_at_ms,
        owner_subject_id=excluded.owner_subject_id,
        owner_user_id=excluded.owner_user_id,
        owner_username=excluded.owner_username,
        owner_tenant_id=excluded.owner_tenant_id,
        workspace_id=excluded.workspace_id,
        checkpoint_id=excluded.checkpoint_id,
        checkpoint_tree_id=excluded.checkpoint_tree_id,
        workflow_id=excluded.workflow_id,
        manifest_key=excluded.manifest_key,
        archive_batch_id=excluded.archive_batch_id,
        version_group_id=excluded.version_group_id,
        version_number=excluded.version_number,
        parent_job_id=excluded.parent_job_id,
        work_item_id=excluded.work_item_id,
        stage_code=excluded.stage_code,
        error_code=excluded.error_code,
        revision=excluded.revision,
        job_json=excluded.job_json,
        metadata_bytes=excluded.metadata_bytes
    `).run(record);
    return { job: rowToJob(prepareCached(db, "SELECT * FROM jobs WHERE id=?").get(job.id)) };
  });

  const deleteTransaction = db.transaction((jobId: string) => {
    const row = prepareCached(db, "SELECT * FROM jobs WHERE id=?").get(jobId);
    if (!row) return null;
    queueDeletion(db, row, now());
    return rowToJob(row);
  });

  let closed = false;
  const requireOpen = () => {
    if (closed) {
      throw projectionError(
        "job_projection_store_closed",
        "Job projection store is closed.",
        503
      );
    }
  };

  function upsert(job: JobDocument, { allocateVersion = false }: { allocateVersion?: boolean } = {}) {
    requireOpen();
    const result = upsertTransaction(job, allocateVersion);
    if (result.error) throw result.error;
    return result.job;
  }

  function list({
    cursor = "",
    limit = 50,
    ownerSubjectId = "",
    statuses = [],
    access = null
  }: PageInput & {
    ownerSubjectId?: string;
    statuses?: JobStatus[];
    access?: JobAccessFilter | null;
  } = {}) {
    requireOpen();
    const safeLimit = positiveInteger(limit, 50, MAX_PAGE_SIZE);
    const decoded = decodeCursor(cursor);
    if (cursor && !decoded) {
      throw projectionError(
        "job_projection_cursor_invalid",
        "Job projection cursor is invalid.",
        400
      );
    }
    const normalizedStatuses = [...new Set<string>(
      statuses.map(String).filter((status) =>
        ["queued", "running", ...TERMINAL_STATUSES].includes(status)
      )
    )];
    const params = [];
    const clauses = [];
    const accessFilter = accessPredicate(access);
    if (accessFilter.clause) {
      clauses.push(accessFilter.clause);
      params.push(...accessFilter.params);
    }
    if (ownerSubjectId) {
      clauses.push("owner_subject_id=?");
      params.push(String(ownerSubjectId));
    }
    if (normalizedStatuses.length > 0) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(",")})`);
      params.push(...normalizedStatuses);
    }
    if (decoded) {
      clauses.push("(created_at_ms<? OR (created_at_ms=? AND id<?))");
      params.push(decoded.createdAtMs, decoded.createdAtMs, decoded.id);
    }
    params.push(safeLimit + 1);
    const rows = prepareCached(db, `
      SELECT *
      FROM jobs
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at_ms DESC,id DESC
      LIMIT ?
    `).all(...params);
    const hasMore = rows.length > safeLimit;
    const pageRows = rows.slice(0, safeLimit);
    const tail = pageRows.at(-1);
    return {
      items: pageRows.map(rowToJob),
      nextCursor: hasMore && tail
        ? encodeCursor(Number(tail.created_at_ms), String(tail.id))
        : "",
      done: !hasMore
    };
  }

  return Object.freeze({
    policy,
    databasePath,
    upsert,
    create(job: JobDocument) {
      requireOpen();
      if (prepareCached(db, "SELECT 1 FROM jobs WHERE id=?").get(job?.id)) {
        throw projectionError(
          "job_projection_identity_conflict",
          "Job projection identity already exists.",
          409
        );
      }
      return upsert(job, { allocateVersion: true });
    },
    importJob(job: JobDocument) {
      return upsert(job);
    },
    get(jobId?: string) {
      requireOpen();
      return rowToJob(
        prepareCached(db, "SELECT * FROM jobs WHERE id=?").get(String(jobId || ""))
      );
    },
    getArtifactInfo(jobId?: string) {
      requireOpen();
      const row = prepareCached(db, `
        SELECT payload_ref,payload_digest,payload_bytes,
               result_ref,result_digest,result_bytes
        FROM jobs
        WHERE id=?
      `).get(String(jobId || ""));
      if (!row) return null;
      return {
        payloadRef: String(row.payload_ref || ""),
        payloadDigest: String(row.payload_digest || ""),
        payloadBytes: Number(row.payload_bytes || 0),
        resultRef: String(row.result_ref || ""),
        resultDigest: String(row.result_digest || ""),
        resultBytes: Number(row.result_bytes || 0)
      };
    },
    getByCheckpoint(checkpointId?: string) {
      requireOpen();
      return rowToJob(prepareCached(db, `
        SELECT *
        FROM jobs
        WHERE checkpoint_id=?
        ORDER BY created_at_ms DESC,id DESC
        LIMIT 1
      `).get(String(checkpointId || "")));
    },
    getActiveManifest(manifestKey?: string, archiveBatchId = "") {
      requireOpen();
      return rowToJob(prepareCached(db, `
        SELECT *
        FROM jobs
        WHERE manifest_key=? AND archive_batch_id=?
          AND status IN ('queued','running')
        ORDER BY created_at_ms ASC,id ASC
        LIMIT 1
      `).get(String(manifestKey || ""), String(archiveBatchId || "")));
    },
    list,
    listActive({ cursor = "", limit = MAX_PAGE_SIZE }: PageInput = {}) {
      return list({
        cursor,
        limit,
        statuses: ["queued", "running"]
      });
    },
    listQueued({ cursor = "", limit = 100, access = null }: PageInput & { access?: JobAccessFilter | null } = {}) {
      requireOpen();
      const safeLimit = positiveInteger(limit, 100, MAX_PAGE_SIZE);
      const normalizedCursor = String(cursor || "");
      const accessFilter = accessPredicate(access);
      const rows = prepareCached(db, `
        SELECT *
        FROM jobs
        WHERE status='queued'
          AND id>?
          ${accessFilter.clause ? `AND ${accessFilter.clause}` : ""}
        ORDER BY id ASC
        LIMIT ?
      `).all(
        normalizedCursor,
        ...accessFilter.params,
        safeLimit + 1
      );
      const hasMore = rows.length > safeLimit;
      const pageRows = rows.slice(0, safeLimit);
      return {
        items: pageRows.map(rowToJob),
        nextCursor: hasMore ? String(pageRows.at(-1)?.id || "") : "",
        done: !hasMore
      };
    },
    listOwnerships({ cursor = "", limit = 100 }: PageInput = {}) {
      const page = list({ cursor, limit });
      return {
        ...page,
        items: page.items.filter((job): job is JobDocument => job !== null).map((job) => ({
          jobId: job.id || "",
          archiveBatchId: job.archiveBatchId || "",
          ownerSubjectId:
            job.ownerSubjectId || job.ownerUserId || job.ownerUsername || "",
          ownerUserId: job.ownerUserId || job.ownerSubjectId || "",
          ownerUsername: job.ownerUsername || ""
        }))
      };
    },
    getCounts() {
      requireOpen();
      return readMeta(db);
    },
    explainList({ ownerSubjectId = "" }: { ownerSubjectId?: string } = {}) {
      requireOpen();
      if (ownerSubjectId) {
        return prepareCached(db, `
          EXPLAIN QUERY PLAN
          SELECT id FROM jobs
          WHERE owner_subject_id=?
          ORDER BY created_at_ms DESC,id DESC
          LIMIT ?
        `).all(String(ownerSubjectId), 10);
      }
      return prepareCached(db, `
        EXPLAIN QUERY PLAN
        SELECT id FROM jobs
        ORDER BY created_at_ms DESC,id DESC
        LIMIT ?
      `).all(10);
    },
    explainTerminalRetention({ overCapacity = false }: { overCapacity?: boolean } = {}) {
      requireOpen();
      if (overCapacity) {
        return prepareCached(db, `
          EXPLAIN QUERY PLAN
          SELECT id FROM jobs INDEXED BY idx_jobs_terminal_finished_id
          WHERE status IN ('completed','failed','cancelled')
            AND id<>?
          ORDER BY finished_at_ms ASC,id ASC
          LIMIT 1
        `).all("");
      }
      return prepareCached(db, `
        EXPLAIN QUERY PLAN
        SELECT id FROM jobs INDEXED BY idx_jobs_terminal_finished_id
        WHERE status IN ('completed','failed','cancelled')
          AND finished_at_ms<=?
          AND id<>?
        ORDER BY finished_at_ms ASC,id ASC
        LIMIT 1
      `).all(Date.now(), "");
    },
    beginArtifact({
      jobId,
      kind,
      finalRef,
      digest,
      byteSize,
      job = null
    }: {
      jobId: string;
      kind: "payload" | "result";
      finalRef: string;
      digest: string;
      byteSize: number;
      job?: JobDocument | null;
    }) {
      requireOpen();
      return db.transaction(() => {
        const normalizedKind = String(kind || "");
        const bytes = Number(byteSize);
        const normalizedJobId = String(jobId || "");
        const normalizedFinalRef = String(finalRef || "");
        const expectedFinalRef = path.posix.join(
          "jobs",
          normalizedJobId,
          normalizedKind === "payload" ? "payload.json" : "result.json"
        );
        const perArtifactLimit = normalizedKind === "payload"
          ? policy.maxPayloadBytes
          : policy.maxResultBytes;
        if (
          !["payload", "result"].includes(normalizedKind) ||
          !SAFE_JOB_ID_PATTERN.test(normalizedJobId) ||
          normalizedFinalRef !== expectedFinalRef ||
          !/^[a-f0-9]{64}$/.test(String(digest || "")) ||
          !Number.isSafeInteger(bytes) ||
          bytes < 0 ||
          bytes > perArtifactLimit
        ) {
          throw projectionError(
            "job_artifact_size_invalid",
            "Job artifact exceeds its configured byte limit.",
            413
          );
        }
        const current = prepareCached(db,
          "SELECT payload_bytes,result_bytes FROM jobs WHERE id=?"
        ).get(normalizedJobId);
        if (!current) {
          throw projectionError(
            "job_projection_missing",
            "Job projection is missing.",
            404
          );
        }
        const existingBytes = normalizedKind === "payload"
          ? Number(current.payload_bytes)
          : Number(current.result_bytes);
        const meta = readMeta(db);
        if (
          meta.artifactBytes +
          meta.preparedArtifactBytes +
          meta.pendingDeleteBytes -
          existingBytes +
          bytes >
          policy.maxArtifactBytes
        ) {
          throw projectionError(
            "job_artifact_capacity_exceeded",
            "Job artifact capacity is exhausted.",
            503
          );
        }
        const journalId = randomUUID();
        const journalJobJson = job
          ? serializeJob(job, policy.maxJobMetadataBytes).serialized
          : null;
        prepareCached(db, `
          INSERT INTO job_artifact_journal(
            id,job_id,kind,final_ref,digest,byte_size,state,created_at_ms,
            journal_job_json
          ) VALUES(?,?,?,?,?,?,?,?,?)
        `).run(
          journalId,
          normalizedJobId,
          normalizedKind,
          normalizedFinalRef,
          String(digest || ""),
          bytes,
          "prepared",
          now(),
          journalJobJson
        );
        return { journalId };
      })();
    },
    publishArtifact(journalId: string) {
      requireOpen();
      return db.transaction(() => {
        const journal = prepareCached(db,
          "SELECT * FROM job_artifact_journal WHERE id=?"
        ).get(journalId);
        if (!journal) return null;
        if (
          !["payload", "result"].includes(String(journal.kind)) ||
          !["prepared", "published"].includes(String(journal.state))
        ) {
          throw projectionError(
            "job_artifact_journal_state_invalid",
            "Job artifact journal state is invalid."
          );
        }
        if (journal.state === "published") {
          return {
            jobId: String(journal.job_id),
            kind: String(journal.kind)
          };
        }
        const column = journal.kind === "payload" ? "payload" : "result";
        const updated = prepareCached(db, `
          UPDATE jobs
          SET ${column}_ref=?,${column}_digest=?,${column}_bytes=?,
              revision=revision+1
          WHERE id=?
        `).run(
          journal.final_ref,
          journal.digest,
          journal.byte_size,
          journal.job_id
        );
        if (updated.changes !== 1) {
          throw projectionError(
            "job_projection_missing",
            "Job projection is missing.",
            404
          );
        }
        prepareCached(db,
          "UPDATE job_artifact_journal SET state='published' WHERE id=?"
        ).run(journalId);
        return {
          jobId: journal.job_id,
          kind: journal.kind
        };
      })();
    },
    settleArtifact(journalId: string) {
      requireOpen();
      prepareCached(db, "DELETE FROM job_artifact_journal WHERE id=?").run(journalId);
    },
    abortArtifact(journalId: string) {
      requireOpen();
      prepareCached(db, "DELETE FROM job_artifact_journal WHERE id=?").run(journalId);
    },
    listArtifactJournal({ limit = DEFAULT_CLEANUP_BATCH }: { limit?: number } = {}) {
      requireOpen();
      const safeLimit = positiveInteger(limit, DEFAULT_CLEANUP_BATCH, 1_024);
      return prepareCached(db, `
        SELECT *
        FROM job_artifact_journal
        ORDER BY created_at_ms ASC,id ASC
        LIMIT ?
      `).all(safeLimit).map((entry) => {
        const row = entry as SqliteRow;
        return ({
        journalId: String(row.id),
        jobId: String(row.job_id),
        kind: String(row.kind),
        finalRef: String(row.final_ref),
        digest: String(row.digest),
        byteSize: Number(row.byte_size),
        state: String(row.state),
        job: row.journal_job_json
          ? JSON.parse(String(row.journal_job_json))
          : null
      });});
    },
    commitUploadCleanupJournal({
      jobId,
      receiptId,
      sessionId
    }: { jobId?: string; receiptId?: string; sessionId?: string } = {}) {
      requireOpen();
      const normalizedJobId = String(jobId || "").trim();
      const normalizedReceiptId = String(receiptId || "").trim();
      const normalizedSessionId = String(sessionId || "").trim();
      if (
        !SAFE_JOB_ID_PATTERN.test(normalizedJobId) ||
        !/^upload_consumption_receipt_[a-f0-9]{32}$/u.test(
          normalizedReceiptId
        ) ||
        !/^upload_session_[a-f0-9]{32}$/u.test(normalizedSessionId)
      ) {
        throw projectionError(
          "upload_cleanup_journal_input_invalid",
          "Upload cleanup journal input is invalid.",
          400
        );
      }
      try {
        return db.transaction(() => {
          const existing = prepareCached(db, `
            SELECT job_id,receipt_id,session_id,state
            FROM job_upload_cleanup_journal
            WHERE session_id=? OR job_id=? OR receipt_id=?
            LIMIT 1
          `).get(
            normalizedSessionId,
            normalizedJobId,
            normalizedReceiptId
          );
          if (existing) {
            if (
              String(existing.job_id) !== normalizedJobId ||
              String(existing.receipt_id) !== normalizedReceiptId ||
              String(existing.session_id) !== normalizedSessionId ||
              String(existing.state) !== "pending"
            ) {
              throw projectionError(
                "upload_cleanup_journal_conflict",
                "Upload cleanup journal identity conflicts with durable state.",
                409
              );
            }
            return {
              jobId: normalizedJobId,
              receiptId: normalizedReceiptId,
              sessionId: normalizedSessionId,
              state: "pending"
            };
          }
          prepareCached(db, `
            INSERT INTO job_upload_cleanup_journal(
              job_id,receipt_id,session_id,state,created_at_ms
            ) VALUES(?,?,?,'pending',?)
          `).run(
            normalizedJobId,
            normalizedReceiptId,
            normalizedSessionId,
            now()
          );
          return {
            jobId: normalizedJobId,
            receiptId: normalizedReceiptId,
            sessionId: normalizedSessionId,
            state: "pending"
          };
        })();
      } catch (error) {
        if (
          errorProperty(error, "code") === "upload_cleanup_journal_conflict" ||
          errorProperty(error, "code") === "upload_cleanup_journal_input_invalid"
        ) {
          throw error;
        }
        throw projectionError(
          "upload_cleanup_journal_commit_failed",
          "Upload cleanup journal commit failed."
        );
      }
    },
    listUploadCleanupJournal({
      limit = DEFAULT_CLEANUP_BATCH
    }: { limit?: number } = {}) {
      requireOpen();
      const safeLimit = positiveInteger(limit, DEFAULT_CLEANUP_BATCH, 1_024);
      return prepareCached(db, `
        SELECT job_id,receipt_id,session_id,state
        FROM job_upload_cleanup_journal
        WHERE state='pending'
        ORDER BY created_at_ms ASC,session_id ASC
        LIMIT ?
      `).all(safeLimit).map((entry) => {
        const row = entry as SqliteRow;
        return {
          jobId: String(row.job_id),
          receiptId: String(row.receipt_id),
          sessionId: String(row.session_id),
          state: String(row.state)
        };
      });
    },
    settleUploadCleanupJournal(sessionId?: string) {
      requireOpen();
      return prepareCached(db, `
        DELETE FROM job_upload_cleanup_journal
        WHERE session_id=? AND state='pending'
      `).run(String(sessionId || "").trim()).changes;
    },
    delete(jobId?: string) {
      requireOpen();
      return deleteTransaction(String(jobId || ""));
    },
    maintain() {
      requireOpen();
      const removed = db.transaction(() =>
        pruneForAdmission(db, policy, 0, now(), {
          reserveRecord: false
        })
      )();
      return {
        removed,
        journalPending: Number(prepareCached(db,
          "SELECT COUNT(*) AS value FROM job_artifact_journal"
        ).get()?.value || 0)
      };
    },
    settleDeletion(jobId?: string) {
      requireOpen();
      prepareCached(db, `
        DELETE FROM job_artifact_journal
        WHERE job_id=? AND kind='delete_job'
      `).run(String(jobId || ""));
    },
    checkpoint() {
      requireOpen();
      db.pragma("wal_checkpoint(TRUNCATE)");
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    }
  });
}

export const JOB_PROJECTION_SCHEMA_VERSION = SCHEMA_VERSION;
