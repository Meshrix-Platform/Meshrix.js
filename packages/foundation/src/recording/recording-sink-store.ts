/**
 * recording-sink-store.ts
 *
 * Durable `enterprise_local` RecordingSink for the Meshrix enterprise
 * recording contract (`@meshrix/contracts/recording`). This store is the
 * enterprise-owned local custody side of *selected history* only; minimal
 * correctness state and the mandatory lifecycle proof stay at their own
 * owners and never traverse this surface.
 *
 * Semantics implemented here, all delegated to the contract for validation:
 *
 * - `admit` is the capture gate and runs *before* any serialization. Only a
 *   `required_before_effect` + `pre_effect` admit reserves durable capacity;
 *   when that reservation cannot be made the admission is `reject`ed
 *   `recording_unavailable` and protected work must be refused. Optional
 *   categories `shed` visibly without ever blocking healthy work.
 * - `writeRecord` persists one canonical record envelope — digests and
 *   artifact custody references, never payload bytes — behind the current
 *   policy revision, the category capacity budget and the sink budgets, in a
 *   replay-safe way (same recordId + same canonical record → replayed;
 *   different payload → conflict). A stale admitted revision never
 *   authorizes capture after the policy moved on, and a disabled category
 *   refuses capture entirely — including for in-flight work.
 * - The `content` category keeps bytes in a bounded content-addressed
 *   artifact store (`putArtifact`); records carry `contentDigest` +
 *   `artifactRefs` whose declared `contentBytes` must equal the bytes held
 *   in custody. No raw content ever lands in the index tables.
 * - Retention is enforced per (category, policy revision) cohort so a record
 *   settles under the policy that admitted it; turning a category off never
 *   deletes captured rows.
 * - A post-effect write failure for a required obligation registers a
 *   durable `recording_pending` row so `terminal_record_pending` stays
 *   visible across restarts; `reconcile` retries *recording only* and can
 *   never replay an effect.
 * - Every state transition appends to a digest-chained journal so ordering
 *   and custody are tamper-evident (`verifyIntegrity`). Journal rows are
 *   lifecycle events, not retained records: they grow with event count
 *   rather than retained record count, by design, for the custody lifetime
 *   of the sink. `verifyIntegrity` is the deliberate full-scan audit path.
 * - Hot admission/write paths read single-row capacity counters that are
 *   updated atomically inside the same transactions as the rows they
 *   describe (the `gateway_execution_intent_capacity` convention); the
 *   counters are recalibrated from one aggregate pass at open so a crash
 *   or drift can never silently corrupt capacity accounting.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  RECORDING_CATEGORIES,
  admitRecordingCategory,
  assertRecordingPolicyChange,
  createRecordAdmission,
  createRecordingOutcome,
  parseRecordingPolicy,
  parseRecordingRecord,
  parseRecordingSink,
  recordingCategoryDisabledBetween,
  recordingOutcomeFor
} from "@meshrix/contracts/recording";
import { ensurePrivateDir } from "../storage/private-file-atomic.ts";
import {
  ensurePrivateSqliteLocation,
  withPrivateFileCreationMask
} from "../storage/private-sqlite.ts";
import { openSqliteDatabase } from "../storage/sqlite-database.ts";
import { runMigrations } from "../storage/sqlite-migrations.ts";

type UnknownRecord = Record<string, unknown>;

const SINK_STORE_SCHEMA_VERSION = "v0.0.1:recording:sink-store-1";
const DATABASE_FILE = "recording-sink.sqlite";
const ARTIFACT_DIR = "artifacts";
const GENESIS_DIGEST = `sha256:${"0".repeat(64)}`;
const ARTIFACT_REF_PREFIX = "art.";
const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;
const UNREFERENCED_ARTIFACT_GRACE_MS = 60 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const MAX_DIVERGENCES = 32;
const RETENTION_READ_BATCH = 4_096;
const SQLITE_UNAVAILABLE_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_CANTOPEN",
  "SQLITE_IOERR",
  "SQLITE_LOCKED",
  "SQLITE_NOTADB",
  "SQLITE_PERM",
  "SQLITE_READONLY"
]);
const SINK_FAILURE_CODES = new Set([
  "capacity_exceeded",
  "sink_unavailable",
  "sink_write_failed"
]);

/** Typed refusal; `code` carries contract reason vocabulary where one exists. */
export class RecordingSinkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RecordingSinkError";
    this.code = code;
  }
}

export interface RecordingSinkStoreOptions {
  rootPath?: unknown;
  sink?: unknown;
  policy?: unknown;
  now?: () => number;
  reservationTtlMs?: unknown;
}

export interface RecordingStoredArtifact {
  artifactRef: string;
  contentDigest: string;
  byteSize: number;
}

export interface RecordingPendingObligation {
  operationRef: string;
  category: string;
  obligation: string;
  policyRevision: number;
  reason: string;
  createdAt: string;
}

export interface RecordingRetentionResult {
  prunedRecords: number;
  prunedArtifacts: number;
}

export interface RecordingSinkIntegrity {
  intact: boolean;
  journalEntries: number;
  recordsChecked: number;
  artifactsChecked: number;
  divergences: string[];
}

export interface RecordingRecordWrite {
  status: "written" | "replayed";
  record: UnknownRecord;
}

export interface RecordingArtifactRead extends RecordingStoredArtifact {
  bytes: Buffer;
}

export interface RecordingSinkStore {
  readonly sinkId: string;
  readonly rootPath: string;
  readonly db: Database.Database;
  descriptor(): UnknownRecord;
  getPolicy(): UnknownRecord;
  publishPolicy(nextPolicy: unknown, configurerRole: unknown): UnknownRecord;
  sinkState(category?: unknown): UnknownRecord;
  admit(input?: UnknownRecord): UnknownRecord | null;
  releaseAdmission(admissionId: unknown): boolean;
  putArtifact(input?: UnknownRecord): RecordingStoredArtifact;
  writeRecord(record: unknown): RecordingRecordWrite;
  listRecords(input?: UnknownRecord): UnknownRecord[];
  readArtifact(input?: UnknownRecord): RecordingArtifactRead;
  pendingObligations(): RecordingPendingObligation[];
  outcomeFor(input?: UnknownRecord): UnknownRecord | null;
  reconcile(input?: UnknownRecord): UnknownRecord | null;
  enforceRetention(category?: unknown): RecordingRetentionResult;
  verifyIntegrity(): RecordingSinkIntegrity;
  close(): void;
}

interface RecordRow {
  record_id: string;
  tenant_ref: string;
  operation_ref: string;
  category: string;
  policy_revision: number;
  phase: string;
  occurred_at: string;
  index_bytes: number;
  content_bytes: number;
  occurred_epoch: number;
  record_json: string;
  record_digest: string;
  recorded_at: string;
}

interface CohortRow {
  rowid: number;
  record_id: string;
  occurred_epoch: number;
  index_bytes: number;
  content_bytes: number;
}

interface CounterRow {
  record_count: number;
  record_index_bytes: number;
  artifact_count: number;
  artifact_content_bytes: number;
  reservation_count: number;
  reserved_index_bytes: number;
}

interface CategoryCounterRow {
  record_count: number;
  index_bytes: number;
  content_bytes: number;
  reservation_count: number;
}

interface CohortCounterRow {
  record_count: number;
  index_bytes: number;
  content_bytes: number;
}

interface ArtifactRow {
  artifact_ref: string;
  content_digest: string;
  byte_size: number;
  file_name: string;
  created_at: string;
  created_epoch: number;
}

interface ReservationRow {
  admission_id: string;
  tenant_ref: string;
  operation_ref: string;
  category: string;
  policy_revision: number;
  index_bytes_reserved: number;
  expires_at_epoch: number;
  created_at: string;
}

interface PendingRow {
  operation_ref: string;
  category: string;
  obligation: string;
  policy_revision: number;
  reason: string;
  created_at: string;
}

interface JournalRow {
  seq: number;
  event: string;
  ref: string;
  payload_json: string;
  prev_digest: string;
  digest: string;
  created_at: string;
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function errorCode(error: unknown): string {
  return String(asRecord(error).code || "");
}

function sha256Hex(value: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Digest(value: string | Buffer | Uint8Array): string {
  return `sha256:${sha256Hex(value)}`;
}

function epochOf(iso: string): number {
  const parsed = Date.parse(String(iso || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function generatedId(prefix: string): string {
  return `${prefix}.${randomUUID().replace(/-/g, ".")}`;
}

function mapStoreFailure(error: unknown): string {
  const code = errorCode(error);
  if (code === "SQLITE_FULL" || code === "ENOSPC" || code === "EDQUOTA") {
    return "capacity_exceeded";
  }
  if (SQLITE_UNAVAILABLE_CODES.has(code)
      || ["EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR"].includes(code)) {
    return "sink_unavailable";
  }
  return "sink_write_failed";
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS recording_sink_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version TEXT NOT NULL,
    sink_id TEXT NOT NULL,
    custody TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  -- Single-row capacity counters kept in step with the tables they
  -- describe, inside the same transactions. All hot-path capacity reads are
  -- O(1) row lookups; counters are recalibrated from the base tables once
  -- at open so recovery from a crash or drift is one bounded aggregate pass.
  CREATE TABLE IF NOT EXISTS recording_counters (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    record_count INTEGER NOT NULL,
    record_index_bytes INTEGER NOT NULL,
    artifact_count INTEGER NOT NULL,
    artifact_content_bytes INTEGER NOT NULL,
    reservation_count INTEGER NOT NULL,
    reserved_index_bytes INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recording_category_counters (
    category TEXT PRIMARY KEY,
    record_count INTEGER NOT NULL,
    index_bytes INTEGER NOT NULL,
    content_bytes INTEGER NOT NULL,
    reservation_count INTEGER NOT NULL
  );
  -- Per (category, policy revision) retention-cohort counters: a record
  -- settles under the policy that admitted it, so retention budgets are
  -- accounted per cohort rather than per category.
  CREATE TABLE IF NOT EXISTS recording_cohort_counters (
    category TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    record_count INTEGER NOT NULL,
    index_bytes INTEGER NOT NULL,
    content_bytes INTEGER NOT NULL,
    PRIMARY KEY (category, policy_revision)
  );
  CREATE TABLE IF NOT EXISTS recording_policies (
    policy_revision INTEGER PRIMARY KEY CHECK (policy_revision >= 1),
    policy_json TEXT NOT NULL,
    published_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recording_records (
    record_id TEXT PRIMARY KEY,
    tenant_ref TEXT NOT NULL,
    operation_ref TEXT NOT NULL,
    category TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    phase TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    index_bytes INTEGER NOT NULL CHECK (index_bytes >= 0),
    content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
    occurred_epoch INTEGER NOT NULL DEFAULT 0,
    record_json TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recording_records_cohort
    ON recording_records(category, policy_revision);
  CREATE INDEX IF NOT EXISTS idx_recording_records_cohort_time
    ON recording_records(category, policy_revision, occurred_epoch);
  CREATE INDEX IF NOT EXISTS idx_recording_records_operation
    ON recording_records(operation_ref, category);
  CREATE TABLE IF NOT EXISTS recording_artifacts (
    artifact_ref TEXT PRIMARY KEY,
    content_digest TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    file_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_epoch INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recording_record_artifacts (
    record_id TEXT NOT NULL,
    artifact_ref TEXT NOT NULL,
    PRIMARY KEY (record_id, artifact_ref)
  );
  CREATE INDEX IF NOT EXISTS idx_recording_record_artifacts_ref
    ON recording_record_artifacts(artifact_ref);
  CREATE TABLE IF NOT EXISTS recording_reservations (
    admission_id TEXT PRIMARY KEY,
    tenant_ref TEXT NOT NULL,
    operation_ref TEXT NOT NULL,
    category TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    index_bytes_reserved INTEGER NOT NULL CHECK (index_bytes_reserved >= 0),
    expires_at_epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recording_reservations_operation
    ON recording_reservations(operation_ref, category);
  -- Expiry sweeps run on every admission and record write; the epoch index
  -- keeps each sweep an O(log R + expired) seek instead of a full-table scan.
  CREATE INDEX IF NOT EXISTS idx_recording_reservations_expiry
    ON recording_reservations(expires_at_epoch);
  CREATE TABLE IF NOT EXISTS recording_pending (
    operation_ref TEXT NOT NULL,
    category TEXT NOT NULL,
    obligation TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (operation_ref, category)
  );
  CREATE TABLE IF NOT EXISTS recording_journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    ref TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    prev_digest TEXT NOT NULL,
    digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

class SqliteRecordingSinkStore implements RecordingSinkStore {
  readonly sinkId: string;
  readonly rootPath: string;
  readonly #sink: UnknownRecord;
  readonly #budgets: UnknownRecord;
  readonly #now: () => number;
  readonly #reservationTtlMs: number;
  readonly #artifactsDir: string;
  #db: Database.Database;
  #closed = false;
  #currentPolicy: UnknownRecord | null = null;
  readonly #policyCache = new Map<number, UnknownRecord>();

  constructor(options: RecordingSinkStoreOptions = {}) {
    const rootText = String(options.rootPath || "").trim();
    if (!rootText) {
      throw new TypeError("Recording sink rootPath is required.");
    }
    const sink = parseRecordingSink(options.sink);
    if (!sink) {
      throw new TypeError("Recording sink descriptor does not satisfy the recording contract.");
    }
    this.#sink = sink;
    this.sinkId = String(sink.sinkId);
    this.#budgets = asRecord(sink.budgets);
    this.rootPath = path.resolve(rootText);
    this.#now = typeof options.now === "function" ? options.now : () => Date.now();
    this.#reservationTtlMs = boundedInt(
      options.reservationTtlMs, DEFAULT_RESERVATION_TTL_MS, 1_000, 24 * 60 * 60 * 1000
    );

    ensurePrivateDir(this.rootPath);
    this.#artifactsDir = path.join(this.rootPath, ARTIFACT_DIR);
    ensurePrivateDir(this.#artifactsDir);
    const databasePath = ensurePrivateSqliteLocation(path.join(this.rootPath, DATABASE_FILE));
    this.#db = withPrivateFileCreationMask(() => openSqliteDatabase(databasePath));
    try {
      this.#openSchema();
      this.#openMeta();
      this.#calibrateCounters();
      this.#openPolicy(options.policy);
      this.#sweepOrphanArtifactFiles();
      this.#sweepExpiredReservations();
      ensurePrivateSqliteLocation(databasePath);
    } catch (error: unknown) {
      try {
        this.#db.close();
      } catch {
        // Preserve the constructor's original failure.
      }
      throw error;
    }
  }

  get db(): Database.Database {
    return this.#db;
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new RecordingSinkError("sink_unavailable", "Recording sink is closed.");
    }
  }

  #openSchema(): void {
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    runMigrations(this.#db, [
      { version: 1, up: (db) => db.exec(SCHEMA_SQL) }
    ]);
  }

  #openMeta(): void {
    const row = this.#db.prepare(
      "SELECT schema_version, sink_id, custody FROM recording_sink_meta WHERE singleton = 1"
    ).get() as { schema_version: string; sink_id: string; custody: string } | undefined;
    if (!row) {
      this.#db.prepare(
        "INSERT INTO recording_sink_meta (singleton, schema_version, sink_id, custody, created_at) VALUES (1, ?, ?, ?, ?)"
      ).run(SINK_STORE_SCHEMA_VERSION, this.sinkId, "enterprise_local", this.#iso());
      return;
    }
    if (row.schema_version !== SINK_STORE_SCHEMA_VERSION
        || row.sink_id !== this.sinkId
        || row.custody !== "enterprise_local") {
      throw new RecordingSinkError(
        "recording_sink_identity_mismatch",
        "Recording sink store identity does not match the supplied sink descriptor."
      );
    }
  }

  #openPolicy(provided: unknown): void {
    const row = this.#db.prepare(
      "SELECT policy_json, policy_revision FROM recording_policies ORDER BY policy_revision DESC LIMIT 1"
    ).get() as { policy_json: string; policy_revision: number } | undefined;
    if (row) {
      const stored = parseRecordingPolicy(JSON.parse(row.policy_json));
      if (!stored) {
        throw new RecordingSinkError(
          "recording_sink_store_corrupt",
          "Stored recording policy does not satisfy the recording contract."
        );
      }
      if (provided !== undefined) {
        const given = parseRecordingPolicy(provided);
        if (!given
            || given.policyId !== stored.policyId
            || Number(given.policyRevision) !== Number(stored.policyRevision)) {
          throw new RecordingSinkError(
            "recording_policy_revision_mismatch",
            "Stored recording policy revision does not match the supplied policy; publishPolicy is the only revision path."
          );
        }
      }
      this.#currentPolicy = stored;
      this.#policyCache.set(Number(stored.policyRevision), stored);
      return;
    }
    const initial = parseRecordingPolicy(provided);
    if (!initial) {
      throw new RecordingSinkError(
        "recording_policy_required",
        "A versioned recording-policy document is required to open a fresh recording sink."
      );
    }
    this.#db.transaction(() => {
      this.#db.prepare(
        "INSERT INTO recording_policies (policy_revision, policy_json, published_at) VALUES (?, ?, ?)"
      ).run(Number(initial.policyRevision), canonicalJson(initial), this.#iso());
      this.#journal("policy_published", String(initial.policyId), {
        policyId: initial.policyId,
        policyRevision: initial.policyRevision
      });
    })();
    this.#currentPolicy = initial;
    this.#policyCache.set(Number(initial.policyRevision), initial);
  }

  #policyForRevision(revision: number): UnknownRecord | null {
    const cached = this.#policyCache.get(revision);
    if (cached) return cached;
    const row = this.#db.prepare(
      "SELECT policy_json FROM recording_policies WHERE policy_revision = ?"
    ).get(revision) as { policy_json: string } | undefined;
    if (!row) return null;
    const parsed = parseRecordingPolicy(JSON.parse(row.policy_json));
    if (parsed) {
      this.#policyCache.set(revision, parsed);
    }
    return parsed;
  }

  #journalTail(): string {
    const row = this.#db.prepare(
      "SELECT digest FROM recording_journal ORDER BY seq DESC LIMIT 1"
    ).get() as { digest: string } | undefined;
    return row?.digest || GENESIS_DIGEST;
  }

  /**
   * `prev_digest` is read from the committed/in-transaction tail at insert
   * time rather than cached: if an enclosing transaction rolls back after a
   * journal insert, the rolled-back digest never enters the chain, so a later
   * append still links to the digest that actually persists.
   */
  #journal(event: string, ref: string, payload: UnknownRecord): string {
    const payloadJson = canonicalJson(payload);
    const previous = this.#journalTail();
    const digest = sha256Digest(`${previous}\n${event}\n${ref}\n${payloadJson}`);
    this.#db.prepare(
      "INSERT INTO recording_journal (event, ref, payload_json, prev_digest, digest, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(event, ref, payloadJson, previous, digest, this.#iso());
    return digest;
  }

  /* -------------------------------------------------------------- *
   * Single-row capacity counters, calibrated once at open and kept    *
   * exact by in-transaction increments — the same convention as        *
   * `gateway_execution_intent_capacity` in the continuation ledger.    *
   * -------------------------------------------------------------- */

  /**
   * One bounded aggregate pass at open recomputes every counter row from
   * the base tables. It is the recovery path for a crash between counter
   * and data updates and the upgrade path for any drift; afterwards all
   * hot-path reads are single-row lookups.
   */
  #calibrateCounters(): void {
    const counters = this.#db.prepare(
      `SELECT COUNT(*) AS record_count, COALESCE(SUM(index_bytes), 0) AS record_index_bytes
       FROM recording_records`
    ).get() as { record_count: number; record_index_bytes: number };
    const artifacts = this.#db.prepare(
      `SELECT COUNT(*) AS artifact_count, COALESCE(SUM(byte_size), 0) AS artifact_content_bytes
       FROM recording_artifacts`
    ).get() as { artifact_count: number; artifact_content_bytes: number };
    const reservations = this.#db.prepare(
      `SELECT COUNT(*) AS reservation_count, COALESCE(SUM(index_bytes_reserved), 0) AS reserved_index_bytes
       FROM recording_reservations`
    ).get() as { reservation_count: number; reserved_index_bytes: number };
    this.#db.prepare(
      `INSERT OR REPLACE INTO recording_counters (
        singleton, record_count, record_index_bytes, artifact_count,
        artifact_content_bytes, reservation_count, reserved_index_bytes
      ) VALUES (1, ?, ?, ?, ?, ?, ?)`
    ).run(
      counters.record_count, counters.record_index_bytes,
      artifacts.artifact_count, artifacts.artifact_content_bytes,
      reservations.reservation_count, reservations.reserved_index_bytes
    );
    this.#db.prepare("DELETE FROM recording_category_counters").run();
    this.#db.prepare(
      `INSERT INTO recording_category_counters (category, record_count, index_bytes, content_bytes, reservation_count)
       SELECT category, COUNT(*), COALESCE(SUM(index_bytes), 0), COALESCE(SUM(content_bytes), 0), 0
       FROM recording_records GROUP BY category`
    ).run();
    this.#db.prepare(
      `INSERT OR IGNORE INTO recording_category_counters (category, record_count, index_bytes, content_bytes, reservation_count)
       SELECT category, 0, 0, 0, COUNT(*) FROM recording_reservations GROUP BY category`
    ).run();
    this.#db.prepare(
      `UPDATE recording_category_counters SET reservation_count = (
         SELECT COUNT(*) FROM recording_reservations r
         WHERE r.category = recording_category_counters.category
       )`
    ).run();
    this.#db.prepare("DELETE FROM recording_cohort_counters").run();
    this.#db.prepare(
      `INSERT INTO recording_cohort_counters (category, policy_revision, record_count, index_bytes, content_bytes)
       SELECT category, policy_revision, COUNT(*), COALESCE(SUM(index_bytes), 0), COALESCE(SUM(content_bytes), 0)
       FROM recording_records GROUP BY category, policy_revision`
    ).run();
  }

  #counters(): CounterRow {
    const row = this.#db.prepare(
      "SELECT * FROM recording_counters WHERE singleton = 1"
    ).get() as CounterRow | undefined;
    return row || {
      record_count: 0,
      record_index_bytes: 0,
      artifact_count: 0,
      artifact_content_bytes: 0,
      reservation_count: 0,
      reserved_index_bytes: 0
    };
  }

  #categoryCounter(category: string): CategoryCounterRow {
    const row = this.#db.prepare(
      "SELECT * FROM recording_category_counters WHERE category = ?"
    ).get(category) as CategoryCounterRow | undefined;
    return row || { record_count: 0, index_bytes: 0, content_bytes: 0, reservation_count: 0 };
  }

  #cohortCounter(category: string, revision: number): CohortCounterRow {
    const row = this.#db.prepare(
      "SELECT * FROM recording_cohort_counters WHERE category = ? AND policy_revision = ?"
    ).get(category, revision) as CohortCounterRow | undefined;
    return row || { record_count: 0, index_bytes: 0, content_bytes: 0 };
  }

  #bumpCounters(deltas: {
    records?: number; indexBytes?: number;
    artifacts?: number; artifactBytes?: number;
    reservations?: number; reservedIndex?: number;
  }): void {
    this.#db.prepare(
      `UPDATE recording_counters SET
        record_count = record_count + ?,
        record_index_bytes = record_index_bytes + ?,
        artifact_count = artifact_count + ?,
        artifact_content_bytes = artifact_content_bytes + ?,
        reservation_count = reservation_count + ?,
        reserved_index_bytes = reserved_index_bytes + ?
      WHERE singleton = 1`
    ).run(
      deltas.records || 0, deltas.indexBytes || 0,
      deltas.artifacts || 0, deltas.artifactBytes || 0,
      deltas.reservations || 0, deltas.reservedIndex || 0
    );
  }

  #bumpCategory(category: string, deltas: {
    records?: number; indexBytes?: number; contentBytes?: number; reservations?: number;
  }): void {
    this.#db.prepare(
      `INSERT INTO recording_category_counters (category, record_count, index_bytes, content_bytes, reservation_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(category) DO UPDATE SET
         record_count = record_count + excluded.record_count,
         index_bytes = index_bytes + excluded.index_bytes,
         content_bytes = content_bytes + excluded.content_bytes,
         reservation_count = reservation_count + excluded.reservation_count`
    ).run(
      category,
      deltas.records || 0, deltas.indexBytes || 0,
      deltas.contentBytes || 0, deltas.reservations || 0
    );
  }

  #bumpCohort(category: string, revision: number, deltas: {
    records?: number; indexBytes?: number; contentBytes?: number;
  }): void {
    this.#db.prepare(
      `INSERT INTO recording_cohort_counters (category, policy_revision, record_count, index_bytes, content_bytes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(category, policy_revision) DO UPDATE SET
         record_count = record_count + excluded.record_count,
         index_bytes = index_bytes + excluded.index_bytes,
         content_bytes = content_bytes + excluded.content_bytes`
    ).run(
      category, revision,
      deltas.records || 0, deltas.indexBytes || 0, deltas.contentBytes || 0
    );
    // An emptied cohort keeps no counter row so the table stays bounded by
    // live cohorts rather than by historical revision count.
    this.#db.prepare(
      `DELETE FROM recording_cohort_counters
       WHERE category = ? AND policy_revision = ?
         AND record_count = 0 AND index_bytes = 0 AND content_bytes = 0`
    ).run(category, revision);
  }

  /**
   * Expire stale reservations in one transaction: a backlog after a quiet
   * TTL window must not turn the next admission into a commit/synchronous-
   * fsync storm of per-row implicit commits.
   */
  #sweepExpiredReservations(): void {
    const expired = this.#db.prepare(
      "SELECT * FROM recording_reservations WHERE expires_at_epoch <= ?"
    ).all(this.#now()) as ReservationRow[];
    if (expired.length === 0) return;
    this.#db.transaction(() => {
      for (const row of expired) {
        this.#db.prepare("DELETE FROM recording_reservations WHERE admission_id = ?").run(row.admission_id);
        this.#bumpCounters({ reservations: -1, reservedIndex: -Number(row.index_bytes_reserved) });
        this.#bumpCategory(row.category, { reservations: -1 });
        this.#journal("reservation_expired", row.admission_id, {
          admissionId: row.admission_id,
          operationRef: row.operation_ref,
          category: row.category
        });
      }
    })();
  }

  /** Indexed single-value count for bounded, key-scoped lookups only. */
  #count(sql: string, ...params: (string | number)[]): number {
    const row = this.#db.prepare(sql).get(...params) as { total: number } | undefined;
    return Number(row?.total || 0);
  }

  /**
   * O(1) selection lookup on an already-parsed policy object: identical to
   * `recordingCategorySelectionFor` without re-running the policy parser.
   */
  #selectionIn(policy: UnknownRecord | null, category: string): UnknownRecord | null {
    if (!policy) return null;
    const selection = asRecord(policy.categories)[category];
    return selection !== null && typeof selection === "object" && !Array.isArray(selection)
      ? asRecord(selection)
      : null;
  }

  #selectionForRevision(revision: number, category: string): UnknownRecord | null {
    return this.#selectionIn(this.#policyForRevision(revision), category);
  }

  descriptor(): UnknownRecord {
    return this.#sink;
  }

  getPolicy(): UnknownRecord {
    this.#assertOpen();
    if (!this.#currentPolicy) {
      throw new RecordingSinkError("recording_policy_required", "Recording sink holds no published policy.");
    }
    return this.#currentPolicy;
  }

  /**
   * The live capacity view consumed by the contract admission gate.
   * `bufferedRecords` is scoped to the queried category (held records plus
   * open reservations) so each category's `maxBufferedRecords` bounds its own
   * backlog; `pendingWrites` reports all open pre-effect reservations.
   */
  sinkState(category?: unknown): UnknownRecord {
    const unavailable = {
      sinkRef: this.sinkId,
      available: false,
      bufferedRecords: 0,
      pendingWrites: 0,
      contentBytesRemaining: 0,
      indexBytesRemaining: 0
    };
    if (this.#closed) return unavailable;
    try {
      this.#sweepExpiredReservations();
      const cat = typeof category === "string" ? category : null;
      const totals = this.#counters();
      const scoped = cat === null
        ? { record_count: totals.record_count, reservation_count: totals.reservation_count }
        : this.#categoryCounter(cat);
      return {
        sinkRef: this.sinkId,
        available: true,
        bufferedRecords: scoped.record_count + scoped.reservation_count,
        pendingWrites: totals.reservation_count,
        contentBytesRemaining: Math.max(
          0, Number(this.#budgets.maxContentBytes) - totals.artifact_content_bytes
        ),
        indexBytesRemaining: Math.max(
          0,
          Number(this.#budgets.maxIndexBytes) - totals.record_index_bytes - totals.reserved_index_bytes
        )
      };
    } catch {
      return unavailable;
    }
  }

  /**
   * The capture gate. Evaluation order is contractual — policy selection and
   * privacy first, then role, then sink availability/capacity — with one
   * added sink-local check: a category routed to a different sinkRef is
   * `destination_unselected` here. A `required_before_effect` + `pre_effect`
   * admit takes a durable capacity reservation in the same decision, and any
   * reservation failure converts the admit into `reject`/`recording_unavailable`.
   */
  admit(input: UnknownRecord = {}): UnknownRecord | null {
    this.#assertOpen();
    const policy = this.getPolicy();
    const category = typeof input.category === "string" ? input.category : "";
    const phase = typeof input.phase === "string" ? input.phase : "";
    const selection = this.#selectionIn(policy, category);
    const obligation = selection ? String(selection.obligation) : null;
    const admissionId = typeof input.admissionId === "string" && input.admissionId
      ? input.admissionId
      : generatedId("adm");
    const finish = (decision: string, reason: string, obligationValue: string | null): UnknownRecord => createRecordAdmission({
      admissionId,
      tenantRef: input.tenantRef,
      operationRef: input.operationRef,
      category,
      phase,
      obligation: obligationValue,
      policyRevision: policy.policyRevision,
      decision,
      reason
    });

    if (selection && String(selection.sinkRef) !== this.sinkId) {
      return finish("deny", "destination_unselected", obligation);
    }
    const gate = admitRecordingCategory({
      policy,
      category,
      phase,
      role: input.role,
      fieldNames: input.fieldNames,
      eventCode: input.eventCode,
      sinkState: this.sinkState(category)
    });
    if (!gate) return null;
    if (gate.decision !== "admit") {
      return finish(String(gate.decision), String(gate.reason), gate.obligation as string | null);
    }
    if (gate.obligation !== "required_before_effect" || gate.phase !== "pre_effect") {
      return finish("admit", "none", obligation);
    }
    // Required start record: reserve durable capacity in this decision so a
    // later sink-full discovery cannot silently degrade the obligation.
    try {
      const reserved = this.#reserveCapacity({
        admissionId,
        tenantRef: String(input.tenantRef || ""),
        operationRef: String(input.operationRef || ""),
        category,
        policyRevision: Number(policy.policyRevision),
        indexBytesReserved: Number(asRecord(selection?.capacity).maxRecordBytes) || 1
      });
      if (!reserved) {
        return finish("reject", "recording_unavailable", "required_before_effect");
      }
    } catch {
      return finish("reject", "recording_unavailable", "required_before_effect");
    }
    return finish("admit", "none", "required_before_effect");
  }

  #reserveCapacity(input: {
    admissionId: string;
    tenantRef: string;
    operationRef: string;
    category: string;
    policyRevision: number;
    indexBytesReserved: number;
  }): boolean {
    return this.#db.transaction((): boolean => {
      this.#sweepExpiredReservations();
      const capacity = asRecord(
        this.#selectionIn(this.getPolicy(), input.category)?.capacity
      );
      const scoped = this.#categoryCounter(input.category);
      if (scoped.record_count + scoped.reservation_count >= Number(capacity.maxBufferedRecords)) {
        return false;
      }
      const totals = this.#counters();
      if (totals.reservation_count >= Number(this.#budgets.maxPendingWrites)) return false;
      if (Number(this.#budgets.maxIndexBytes) - totals.record_index_bytes - totals.reserved_index_bytes <= 0) {
        return false;
      }
      this.#db.prepare(
        `INSERT INTO recording_reservations (
          admission_id, tenant_ref, operation_ref, category, policy_revision,
          index_bytes_reserved, expires_at_epoch, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.admissionId, input.tenantRef, input.operationRef, input.category,
        input.policyRevision, input.indexBytesReserved,
        this.#now() + this.#reservationTtlMs, this.#iso()
      );
      this.#bumpCounters({ reservations: 1, reservedIndex: input.indexBytesReserved });
      this.#bumpCategory(input.category, { reservations: 1 });
      this.#journal("reservation_reserved", input.admissionId, {
        admissionId: input.admissionId,
        operationRef: input.operationRef,
        category: input.category,
        policyRevision: input.policyRevision
      });
      return true;
    })();
  }

  /** Releases a durable reservation (operation refused later, or superseded). */
  releaseAdmission(admissionId: unknown): boolean {
    this.#assertOpen();
    const id = String(admissionId || "");
    return this.#db.transaction((): boolean => {
      const row = this.#db.prepare(
        "SELECT * FROM recording_reservations WHERE admission_id = ?"
      ).get(id) as ReservationRow | undefined;
      if (!row) return false;
      this.#db.prepare("DELETE FROM recording_reservations WHERE admission_id = ?").run(id);
      this.#bumpCounters({ reservations: -1, reservedIndex: -Number(row.index_bytes_reserved) });
      this.#bumpCategory(row.category, { reservations: -1 });
      this.#journal("reservation_released", id, {
        admissionId: id,
        operationRef: row.operation_ref,
        category: row.category,
        reason: "released"
      });
      return true;
    })();
  }

  /**
   * Atomically publish a new policy revision (configurer role enforced by the
   * contract). Disabling a category releases its open reservations and — for
   * a previously required category — keeps the owed terminal records of
   * in-flight operations visible as pending obligations instead of claiming
   * they were met.
   */
  publishPolicy(nextPolicy: unknown, configurerRole: unknown): UnknownRecord {
    this.#assertOpen();
    const current = this.getPolicy();
    const admitted = assertRecordingPolicyChange(current, nextPolicy, configurerRole);
    this.#db.transaction(() => {
      this.#db.prepare(
        "INSERT INTO recording_policies (policy_revision, policy_json, published_at) VALUES (?, ?, ?)"
      ).run(Number(admitted.policyRevision), canonicalJson(admitted), this.#iso());
      this.#journal("policy_published", String(admitted.policyId), {
        policyId: admitted.policyId,
        policyRevision: admitted.policyRevision
      });
      for (const category of RECORDING_CATEGORIES) {
        if (!recordingCategoryDisabledBetween(current, admitted, category)) continue;
        const released = this.#db.prepare(
          "SELECT * FROM recording_reservations WHERE category = ?"
        ).all(category) as ReservationRow[];
        for (const row of released) {
          this.#db.prepare("DELETE FROM recording_reservations WHERE admission_id = ?").run(row.admission_id);
          this.#bumpCounters({ reservations: -1, reservedIndex: -Number(row.index_bytes_reserved) });
          this.#bumpCategory(row.category, { reservations: -1 });
          this.#journal("reservation_released", row.admission_id, {
            admissionId: row.admission_id,
            operationRef: row.operation_ref,
            category,
            reason: "category_disabled"
          });
        }
        const oldSelection = this.#selectionIn(current, category);
        if (oldSelection && String(oldSelection.obligation) === "required_before_effect") {
          const owed = this.#db.prepare(
            `SELECT DISTINCT operation_ref FROM recording_records
             WHERE category = ? AND phase = 'pre_effect'
             AND operation_ref NOT IN (
               SELECT operation_ref FROM recording_records
               WHERE category = ? AND phase = 'post_effect'
             )`
          ).all(category, category) as { operation_ref: string }[];
          for (const row of owed) {
            this.#insertPending(row.operation_ref, category, {
              obligation: "required_before_effect",
              policyRevision: Number(current.policyRevision),
              reason: "category_disabled"
            });
          }
          this.#db.prepare(
            "UPDATE recording_pending SET reason = 'category_disabled' WHERE category = ?"
          ).run(category);
        }
      }
    })();
    this.#currentPolicy = admitted;
    this.#policyCache.set(Number(admitted.policyRevision), admitted);
    return admitted;
  }

  /**
   * Store selected content bytes in bounded content-addressed custody. Only
   * digests and the returned `artifactRef` may ever appear in records; bytes
   * stay in the private artifact directory under the content budget.
   */
  putArtifact(input: UnknownRecord = {}): RecordingStoredArtifact {
    this.#assertOpen();
    const selection = this.#selectionIn(this.getPolicy(), "content");
    if (!selection) {
      throw new RecordingSinkError(
        "category_disabled",
        "The content category is not selected by the current recording policy."
      );
    }
    const bytes = input.bytes;
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("putArtifact requires bytes as a Uint8Array.");
    }
    const buffer = Buffer.from(bytes);
    const digestHex = sha256Hex(buffer);
    const artifactRef = `${ARTIFACT_REF_PREFIX}${digestHex}`;
    const existing = this.#db.prepare(
      "SELECT * FROM recording_artifacts WHERE artifact_ref = ?"
    ).get(artifactRef) as ArtifactRow | undefined;
    if (existing) {
      return {
        artifactRef,
        contentDigest: `sha256:${digestHex}`,
        byteSize: Number(existing.byte_size)
      };
    }
    const contentLimit = Math.min(
      Number(this.#budgets.maxContentBytes),
      Number(asRecord(selection.retention).maxContentBytes)
    );
    if (this.#counters().artifact_content_bytes + buffer.length > contentLimit) {
      throw new RecordingSinkError(
        "capacity_exceeded",
        "Recording artifact store exceeds the content-byte budget."
      );
    }
    const filePath = path.join(this.#artifactsDir, digestHex);
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, buffer, { mode: 0o600, flag: "wx" });
      fs.chmodSync(tempPath, 0o600);
      fs.renameSync(tempPath, filePath);
    } catch (error: unknown) {
      fs.rmSync(tempPath, { force: true });
      throw new RecordingSinkError(
        mapStoreFailure(error),
        `Recording artifact store could not persist content bytes: ${String(error)}`
      );
    }
    try {
      this.#db.transaction(() => {
        this.#db.prepare(
          `INSERT INTO recording_artifacts (
            artifact_ref, content_digest, byte_size, file_name, created_at, created_epoch
          ) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(artifactRef, `sha256:${digestHex}`, buffer.length, digestHex, this.#iso(), this.#now());
        this.#bumpCounters({ artifacts: 1, artifactBytes: buffer.length });
        this.#journal("artifact_stored", artifactRef, {
          artifactRef,
          contentDigest: `sha256:${digestHex}`,
          byteSize: buffer.length
        });
      })();
    } catch (error: unknown) {
      fs.rmSync(filePath, { force: true });
      throw new RecordingSinkError(
        mapStoreFailure(error),
        `Recording artifact custody row could not be written: ${String(error)}`
      );
    }
    return {
      artifactRef,
      contentDigest: `sha256:${digestHex}`,
      byteSize: buffer.length
    };
  }

  /**
   * Append a selected-history record behind the current policy revision.
   * Replay-safe by recordId; conflicted ids, stale revisions, disabled
   * categories and unselected fields are refused with typed errors. Required
   * post-effect failures keep the terminal obligation pending.
   */
  writeRecord(record: unknown): RecordingRecordWrite {
    this.#assertOpen();
    const parsed = parseRecordingRecord(record);
    if (!parsed) {
      throw new TypeError("Recording record does not satisfy the recording contract.");
    }
    if (String(parsed.sinkRef) !== this.sinkId) {
      throw new RecordingSinkError(
        "destination_unselected",
        "Record is addressed to a different recording sink."
      );
    }
    const policy = this.getPolicy();
    const category = String(parsed.category);
    const phase = String(parsed.phase);
    const selection = this.#selectionIn(policy, category);
    if (!selection) {
      this.#pendingAfterRefusal(parsed, "category_disabled");
      throw new RecordingSinkError(
        "category_disabled",
        "Recording category is not selected by the current policy revision; capture is refused."
      );
    }
    if (Number(parsed.policyRevision) !== Number(policy.policyRevision)) {
      this.#pendingAfterRefusal(parsed, "policy_superseded");
      throw new RecordingSinkError(
        "policy_superseded",
        "Record was admitted under a superseded policy revision; it must be re-admitted under the current revision."
      );
    }
    const recordJson = canonicalJson(parsed);
    const recordDigest = sha256Digest(recordJson);
    const existing = this.#db.prepare(
      "SELECT record_json FROM recording_records WHERE record_id = ?"
    ).get(String(parsed.recordId)) as { record_json: string } | undefined;
    if (existing) {
      if (existing.record_json === recordJson) {
        return { status: "replayed", record: parsed };
      }
      throw new RecordingSinkError(
        "recording_record_conflict",
        "A different record already exists under this record id."
      );
    }

    const obligation = String(selection.obligation);
    try {
      this.#assertSelectionFields(parsed, selection);
      const artifactRefs = this.#resolveArtifactRefs(parsed);
      const recordBytes = Buffer.byteLength(recordJson, "utf8");
      const maxRecordBytes = Math.min(
        Number(asRecord(selection.capacity).maxRecordBytes),
        Number(this.#budgets.maxRecordBytes)
      );
      if (recordBytes > maxRecordBytes) {
        throw new RecordingSinkError(
          "capacity_exceeded",
          "Recording record envelope exceeds the per-record byte budget."
        );
      }
      const retention = asRecord(selection.retention);
      if (Number(parsed.indexBytes) > Number(retention.maxIndexBytes)
          || Number(parsed.contentBytes) > Number(retention.maxContentBytes)) {
        throw new RecordingSinkError(
          "capacity_exceeded",
          "Recording record can never fit inside the category retention budget."
        );
      }
      this.#db.transaction(() => {
        this.#sweepExpiredReservations();
        // The reservation held for this operation+category is spent by this
        // write: consume it before accounting so its reserved budget is freed
        // for the record that was actually serialized.
        const consumed = this.#db.prepare(
          "SELECT * FROM recording_reservations WHERE operation_ref = ? AND category = ?"
        ).get(String(parsed.operationRef), category) as ReservationRow | undefined;
        if (consumed) {
          this.#db.prepare("DELETE FROM recording_reservations WHERE admission_id = ?").run(consumed.admission_id);
          this.#bumpCounters({ reservations: -1, reservedIndex: -Number(consumed.index_bytes_reserved) });
          this.#bumpCategory(category, { reservations: -1 });
          this.#journal("reservation_consumed", String(parsed.operationRef), {
            operationRef: parsed.operationRef,
            category
          });
        }
        const totals = this.#counters();
        if (totals.record_count + totals.reservation_count >= Number(this.#budgets.maxBufferedRecords)) {
          throw new RecordingSinkError("capacity_exceeded", "Recording sink buffered-record budget is exhausted.");
        }
        const scoped = this.#categoryCounter(category);
        if (scoped.record_count + scoped.reservation_count >= Number(asRecord(selection.capacity).maxBufferedRecords)) {
          throw new RecordingSinkError("capacity_exceeded", "Recording category buffered-record budget is exhausted.");
        }
        const indexRemaining = Number(this.#budgets.maxIndexBytes)
          - totals.record_index_bytes - totals.reserved_index_bytes;
        if (indexRemaining < Number(parsed.indexBytes)) {
          throw new RecordingSinkError("capacity_exceeded", "Recording sink index-byte budget is exhausted.");
        }
        this.#pruneForRetention(category, Number(parsed.policyRevision), selection, {
          indexBytes: Number(parsed.indexBytes),
          contentBytes: Number(parsed.contentBytes)
        });
        this.#db.prepare(
          `INSERT INTO recording_records (
            record_id, tenant_ref, operation_ref, category, policy_revision, phase,
            occurred_at, occurred_epoch, index_bytes, content_bytes, record_json, record_digest, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          String(parsed.recordId), String(parsed.tenantRef), String(parsed.operationRef),
          category, Number(parsed.policyRevision), phase, String(parsed.occurredAt),
          epochOf(String(parsed.occurredAt)),
          Number(parsed.indexBytes), Number(parsed.contentBytes),
          recordJson, recordDigest, this.#iso()
        );
        this.#bumpCounters({ records: 1, indexBytes: Number(parsed.indexBytes) });
        this.#bumpCategory(category, {
          records: 1,
          indexBytes: Number(parsed.indexBytes),
          contentBytes: Number(parsed.contentBytes)
        });
        this.#bumpCohort(category, Number(parsed.policyRevision), {
          records: 1,
          indexBytes: Number(parsed.indexBytes),
          contentBytes: Number(parsed.contentBytes)
        });
        for (const ref of artifactRefs) {
          this.#db.prepare(
            "INSERT INTO recording_record_artifacts (record_id, artifact_ref) VALUES (?, ?)"
          ).run(String(parsed.recordId), ref);
        }
        if (phase === "post_effect") {
          const settled = this.#db.prepare(
            "DELETE FROM recording_pending WHERE operation_ref = ? AND category = ?"
          ).run(String(parsed.operationRef), category);
          if (settled.changes > 0) {
            this.#journal("pending_settled", String(parsed.operationRef), {
              operationRef: parsed.operationRef,
              category
            });
          }
        }
        this.#journal("record_written", String(parsed.recordId), {
          recordId: parsed.recordId,
          operationRef: parsed.operationRef,
          category,
          policyRevision: parsed.policyRevision,
          recordDigest
        });
      })();
    } catch (error: unknown) {
      const code = error instanceof RecordingSinkError ? error.code : mapStoreFailure(error);
      if (obligation === "required_before_effect" && phase === "post_effect") {
        this.#tryMarkPending(
          String(parsed.operationRef), category, obligation,
          Number(parsed.policyRevision), code
        );
      }
      if (error instanceof RecordingSinkError) throw error;
      throw new RecordingSinkError(code, `Recording sink write failed: ${String(error)}`);
    }
    return { status: "written", record: parsed };
  }

  /**
   * After a refused post-effect write, a required terminal obligation from the
   * record's own revision stays visibly owed — off or supersede can prevent
   * capture, but the sink never claims the obligation was met.
   */
  #pendingAfterRefusal(parsed: UnknownRecord, reason: string): void {
    if (String(parsed.phase) !== "post_effect") return;
    const priorSelection = this.#selectionForRevision(
      Number(parsed.policyRevision), String(parsed.category)
    );
    if (priorSelection && String(priorSelection.obligation) === "required_before_effect") {
      try {
        this.#markPending(
          String(parsed.operationRef), String(parsed.category),
          "required_before_effect", Number(parsed.policyRevision), reason
        );
      } catch {
        // The refusal error below is authoritative; a pending-registration
        // failure here is reported on the next outcome pass.
      }
    }
  }

  /** Field/event allowlists are re-verified at the sink, not only at the gate. */
  #assertSelectionFields(parsed: UnknownRecord, selection: UnknownRecord): void {
    const detail = asRecord(parsed.detail);
    const category = String(parsed.category);
    const fieldAllow = (selection.fieldAllow as readonly string[]) || [];
    const eventAllow = (selection.eventAllow as readonly string[]) || [];
    if (category === "content") {
      const names = (detail.fieldNames as readonly string[]) || [];
      if (names.some((name) => !fieldAllow.includes(name))) {
        throw new RecordingSinkError("field_not_selected", "Content record names fields outside the policy allowlist.");
      }
    }
    if (category === "diagnostics"
        && !eventAllow.includes(String(detail.eventCode || ""))) {
      throw new RecordingSinkError("field_not_selected", "Diagnostics event code is outside the policy allowlist.");
    }
    if (category === "usage") {
      const counters = asRecord(detail.counters);
      if (Object.keys(counters).some((key) => !fieldAllow.includes(key))) {
        throw new RecordingSinkError("field_not_selected", "Usage counters name fields outside the policy allowlist.");
      }
    }
  }

  /**
   * Content records hold digest + artifact custody pointers only. Every ref
   * must resolve in this sink's artifact custody and the declared
   * `contentBytes` must equal the bytes actually held — no phantom custody
   * and no under-declared budgets.
   */
  #resolveArtifactRefs(parsed: UnknownRecord): string[] {
    if (String(parsed.category) !== "content") return [];
    const detail = asRecord(parsed.detail);
    const refs = (detail.artifactRefs as readonly string[]) || [];
    let declared = 0;
    for (const ref of refs) {
      const row = this.#db.prepare(
        "SELECT byte_size FROM recording_artifacts WHERE artifact_ref = ?"
      ).get(String(ref)) as { byte_size: number } | undefined;
      if (!row) {
        throw new RecordingSinkError(
          "recording_artifact_unresolved",
          `Content record references artifact custody this sink does not hold: ${String(ref)}`
        );
      }
      declared += Number(row.byte_size);
    }
    if (Number(parsed.contentBytes) !== declared) {
      throw new RecordingSinkError(
        "recording_artifact_bytes_mismatch",
        "Content record declared bytes do not match the artifact custody it references."
      );
    }
    return refs.map(String);
  }

  #markPending(operationRef: string, category: string, obligation: string, policyRevision: number, reason: string): void {
    this.#db.transaction(() => {
      this.#insertPending(operationRef, category, { obligation, policyRevision, reason });
    })();
  }

  /**
   * Best-effort durable marking: when the store itself cannot take another
   * write (full disk, read-only) the owed terminal can be reported but not
   * durably registered — the thrown write error and outcome derivation still
   * keep the obligation truthful (`RECORDING_FULL_STORE_GUARANTEES_TERMINAL_AUDIT`
   * is false precisely because this marking is not always possible).
   */
  #tryMarkPending(operationRef: string, category: string, obligation: string, policyRevision: number, reason: string): void {
    try {
      this.#markPending(operationRef, category, obligation, policyRevision, reason);
    } catch {
      // The write failure remains authoritative; outcome derivation reports
      // the owed terminal from the durable records that do exist.
    }
  }

  #insertPending(operationRef: string, category: string, input: { obligation: string; policyRevision: number; reason: string }): void {
    const inserted = this.#db.prepare(
      `INSERT OR IGNORE INTO recording_pending (
        operation_ref, category, obligation, policy_revision, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(operationRef, category, input.obligation, input.policyRevision, input.reason, this.#iso());
    if (inserted.changes === 0 && input.reason) {
      this.#db.prepare(
        "UPDATE recording_pending SET reason = ? WHERE operation_ref = ? AND category = ?"
      ).run(input.reason, operationRef, category);
      return;
    }
    if (inserted.changes > 0) {
      this.#journal("pending_owed", `${operationRef}/${category}`, {
        operationRef,
        category,
        obligation: input.obligation,
        policyRevision: input.policyRevision,
        reason: input.reason
      });
    }
  }

  /**
   * Retention is enforced per (category, policy revision) cohort: records
   * settle under the policy that admitted them. `incoming` accounts the
   * record about to be written so pruning makes room for it in the same
   * transaction; the incoming record itself is never pruned. Expired rows
   * are always dropped; while any budget is exceeded the oldest remaining
   * rows follow.
   */
  #pruneForRetention(
    category: string,
    revision: number,
    selection: UnknownRecord,
    incoming?: { indexBytes: number; contentBytes: number }
  ): RecordingRetentionResult {
    const retention = asRecord(selection.retention);
    const cutoff = this.#now() - Number(retention.maxAgeSeconds) * 1000;
    const maxRecords = Number(retention.maxRecords);
    const maxIndex = Number(retention.maxIndexBytes);
    const maxContent = Number(retention.maxContentBytes);
    const cohort = this.#cohortCounter(category, revision);
    let count = cohort.record_count + (incoming ? 1 : 0);
    let indexBytes = cohort.index_bytes + Number(incoming?.indexBytes || 0);
    let contentBytes = cohort.content_bytes + Number(incoming?.contentBytes || 0);
    const result: RecordingRetentionResult = { prunedRecords: 0, prunedArtifacts: 0 };
    const overBudget = (): boolean =>
      count > maxRecords || indexBytes > maxIndex || contentBytes > maxContent;
    // Fast path: the cohort fits and no row is expired — verified by a
    // bounded index seek — so the common write skips the row scan entirely.
    const expiredExists = cohort.record_count > 0 && this.#db.prepare(
      `SELECT 1 AS hit FROM recording_records
       WHERE category = ? AND policy_revision = ? AND occurred_epoch < ? LIMIT 1`
    ).get(category, revision, cutoff) !== undefined;
    if (!overBudget() && !expiredExists) {
      return result;
    }
    const affectedArtifactRefs = new Set<string>();
    const pruneRow = (row: CohortRow, reason: "retention_expired" | "retention_budget"): void => {
      const linked = this.#db.prepare(
        "SELECT artifact_ref FROM recording_record_artifacts WHERE record_id = ?"
      ).all(row.record_id) as { artifact_ref: string }[];
      for (const link of linked) affectedArtifactRefs.add(link.artifact_ref);
      this.#db.prepare("DELETE FROM recording_record_artifacts WHERE record_id = ?").run(row.record_id);
      this.#db.prepare("DELETE FROM recording_records WHERE record_id = ?").run(row.record_id);
      this.#bumpCounters({ records: -1, indexBytes: -Number(row.index_bytes) });
      this.#bumpCategory(category, {
        records: -1, indexBytes: -Number(row.index_bytes), contentBytes: -Number(row.content_bytes)
      });
      this.#bumpCohort(category, revision, {
        records: -1, indexBytes: -Number(row.index_bytes), contentBytes: -Number(row.content_bytes)
      });
      this.#journal("record_pruned", row.record_id, {
        recordId: row.record_id,
        category,
        policyRevision: revision,
        reason
      });
      count -= 1;
      indexBytes -= Number(row.index_bytes);
      contentBytes -= Number(row.content_bytes);
      result.prunedRecords += 1;
    };
    // Expired rows first: the (category, policy_revision, occurred_epoch)
    // index selects only deletable rows, so every batch read maps to real
    // deletions instead of re-scanning a non-deletable rowid prefix.
    for (;;) {
      const batch = this.#db.prepare(
        `SELECT rowid, record_id, occurred_epoch, index_bytes, content_bytes
         FROM recording_records
         WHERE category = ? AND policy_revision = ? AND occurred_epoch < ?
         ORDER BY occurred_epoch ASC LIMIT ?`
      ).all(category, revision, cutoff, RETENTION_READ_BATCH) as CohortRow[];
      if (batch.length === 0) break;
      for (const row of batch) pruneRow(row, "retention_expired");
    }
    // Budget eviction runs only while the cohort still exceeds its budget,
    // evicting oldest-first through the same index; it stops as soon as the
    // cohort fits rather than reading rows that cannot be deleted.
    while (overBudget()) {
      const batch = this.#db.prepare(
        `SELECT rowid, record_id, occurred_epoch, index_bytes, content_bytes
         FROM recording_records
         WHERE category = ? AND policy_revision = ?
         ORDER BY occurred_epoch ASC LIMIT ?`
      ).all(category, revision, RETENTION_READ_BATCH) as CohortRow[];
      if (batch.length === 0) break;
      for (const row of batch) {
        if (!overBudget()) break;
        pruneRow(row, "retention_budget");
      }
    }
    if (incoming && overBudget()) {
      throw new RecordingSinkError(
        "capacity_exceeded",
        "Recording retention budget cannot hold the incoming record."
      );
    }
    result.prunedArtifacts += this.#sweepArtifactRefs(affectedArtifactRefs);
    return result;
  }

  /** Delete custody rows + files for artifacts no record references. */
  #sweepArtifactRefs(refs: ReadonlySet<string>): number {
    let pruned = 0;
    for (const ref of refs) {
      const links = this.#count(
        "SELECT COUNT(*) AS total FROM recording_record_artifacts WHERE artifact_ref = ?", ref
      );
      if (links > 0) continue;
      const row = this.#db.prepare(
        "SELECT * FROM recording_artifacts WHERE artifact_ref = ?"
      ).get(ref) as ArtifactRow | undefined;
      if (!row) continue;
      this.#db.prepare("DELETE FROM recording_artifacts WHERE artifact_ref = ?").run(ref);
      this.#bumpCounters({ artifacts: -1, artifactBytes: -Number(row.byte_size) });
      fs.rmSync(path.join(this.#artifactsDir, row.file_name), { force: true });
      this.#journal("artifact_pruned", ref, {
        artifactRef: ref,
        reason: "custody_unreferenced"
      });
      pruned += 1;
    }
    return pruned;
  }

  /** Remove artifact files on disk that have no custody row (crash orphans). */
  #sweepOrphanArtifactFiles(): void {
    const named = new Set(
      (this.#db.prepare("SELECT file_name FROM recording_artifacts").all() as { file_name: string }[])
        .map((row) => row.file_name)
    );
    for (const entry of fs.readdirSync(this.#artifactsDir)) {
      if (entry.endsWith(".tmp") || named.has(entry)) continue;
      fs.rmSync(path.join(this.#artifactsDir, entry), { force: true });
    }
  }

  /**
   * Run retention across every (category, revision) cohort — age expiry, then
   * count/byte budgets — and sweep unreferenced staged artifacts past their
   * grace period.
   */
  enforceRetention(category?: unknown): RecordingRetentionResult {
    this.#assertOpen();
    const categories = typeof category === "string" && category
      ? [category]
      : [...RECORDING_CATEGORIES];
    const result = { prunedRecords: 0, prunedArtifacts: 0 };
    this.#db.transaction(() => {
      for (const cat of categories) {
        const revisions = this.#db.prepare(
          "SELECT DISTINCT policy_revision FROM recording_records WHERE category = ?"
        ).all(cat) as { policy_revision: number }[];
        for (const { policy_revision: revision } of revisions) {
          const selection = this.#selectionForRevision(Number(revision), cat);
          if (!selection) continue;
          const pruned = this.#pruneForRetention(cat, Number(revision), selection);
          result.prunedRecords += pruned.prunedRecords;
          result.prunedArtifacts += pruned.prunedArtifacts;
        }
      }
      const stale = this.#db.prepare(
        `SELECT a.* FROM recording_artifacts a
         WHERE NOT EXISTS (
           SELECT 1 FROM recording_record_artifacts ra WHERE ra.artifact_ref = a.artifact_ref
         ) AND a.created_epoch < ?`
      ).all(this.#now() - UNREFERENCED_ARTIFACT_GRACE_MS) as ArtifactRow[];
      for (const row of stale) {
        this.#db.prepare("DELETE FROM recording_artifacts WHERE artifact_ref = ?").run(row.artifact_ref);
        this.#bumpCounters({ artifacts: -1, artifactBytes: -Number(row.byte_size) });
        fs.rmSync(path.join(this.#artifactsDir, row.file_name), { force: true });
        this.#journal("artifact_pruned", row.artifact_ref, {
          artifactRef: row.artifact_ref,
          reason: "custody_unreferenced"
        });
        result.prunedArtifacts += 1;
      }
    })();
    return result;
  }

  #roleMayRead(category: string, revision: number, role: string): boolean {
    const selection = this.#selectionForRevision(revision, category);
    if (!selection) return false;
    return ((selection.readerRoles as readonly string[]) || []).includes(role);
  }

  /**
   * Role-scoped record reads: a record is returned only when `role` holds a
   * reader role for its category under the revision that captured it —
   * captured records remain readable under their own policy even after the
   * category is later disabled (off stops capture, not legitimate settlement).
   */
  listRecords(input: UnknownRecord = {}): UnknownRecord[] {
    this.#assertOpen();
    const category = String(input.category || "");
    if (!category) {
      throw new TypeError("listRecords requires a recording category.");
    }
    const role = String(input.role || "");
    if (!role) {
      throw new RecordingSinkError("role_unauthorized", "A reader role is required to list records.");
    }
    const conditions = ["category = ?"];
    const params: (string | number)[] = [category];
    if (typeof input.tenantRef === "string" && input.tenantRef) {
      conditions.push("tenant_ref = ?");
      params.push(input.tenantRef);
    }
    if (typeof input.operationRef === "string" && input.operationRef) {
      conditions.push("operation_ref = ?");
      params.push(input.operationRef);
    }
    const limit = boundedInt(input.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const rows = this.#db.prepare(
      `SELECT * FROM recording_records WHERE ${conditions.join(" AND ")} ORDER BY rowid ASC LIMIT ?`
    ).all(...params, limit) as RecordRow[];
    return rows
      .filter((row) => this.#roleMayRead(row.category, Number(row.policy_revision), role))
      .map((row) => JSON.parse(row.record_json) as UnknownRecord);
  }

  /**
   * Read artifact bytes back through custody: the artifact must be referenced
   * by a held record, the caller's role must read that record's category, and
   * the bytes are re-hashed against the recorded digest on every read.
   */
  readArtifact(input: UnknownRecord = {}): RecordingArtifactRead {
    this.#assertOpen();
    const artifactRef = String(input.artifactRef || "");
    const role = String(input.role || "");
    if (!artifactRef) {
      throw new TypeError("readArtifact requires an artifactRef.");
    }
    if (!role) {
      throw new RecordingSinkError("role_unauthorized", "A reader role is required to read artifacts.");
    }
    const row = this.#db.prepare(
      "SELECT * FROM recording_artifacts WHERE artifact_ref = ?"
    ).get(artifactRef) as ArtifactRow | undefined;
    if (!row) {
      throw new RecordingSinkError(
        "recording_artifact_unresolved",
        "Artifact is not held in this sink's custody."
      );
    }
    const links = this.#db.prepare(
      `SELECT DISTINCT r.category AS category, r.policy_revision AS policy_revision
       FROM recording_record_artifacts ra
       JOIN recording_records r ON r.record_id = ra.record_id
       WHERE ra.artifact_ref = ?`
    ).all(artifactRef) as { category: string; policy_revision: number }[];
    if (links.length === 0) {
      throw new RecordingSinkError(
        "role_unauthorized",
        "Artifact has no recorded custody binding; no category read role applies."
      );
    }
    if (!links.some((link) => this.#roleMayRead(link.category, Number(link.policy_revision), role))) {
      throw new RecordingSinkError(
        "role_unauthorized",
        "Reader role is not authorized for this artifact's recording category."
      );
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(this.#artifactsDir, row.file_name));
    } catch (error: unknown) {
      throw new RecordingSinkError(
        "recording_artifact_missing",
        `Recorded artifact bytes are missing from custody: ${errorCode(error) || String(error)}`
      );
    }
    if (bytes.length !== Number(row.byte_size)
        || sha256Hex(bytes) !== String(row.content_digest).replace(/^sha256:/u, "")) {
      throw new RecordingSinkError(
        "recording_artifact_corrupt",
        "Recorded artifact bytes no longer match their custody digest."
      );
    }
    return {
      artifactRef,
      contentDigest: row.content_digest,
      byteSize: Number(row.byte_size),
      bytes
    };
  }

  /** Required terminal obligations still owed (durable across restarts). */
  pendingObligations(): RecordingPendingObligation[] {
    this.#assertOpen();
    const rows = this.#db.prepare(
      "SELECT * FROM recording_pending ORDER BY created_at ASC, operation_ref ASC"
    ).all() as PendingRow[];
    return rows.map((row) => ({
      operationRef: row.operation_ref,
      category: row.category,
      obligation: row.obligation,
      policyRevision: Number(row.policy_revision),
      reason: row.reason,
      createdAt: row.created_at
    }));
  }

  /**
   * Derive the truthful `recording-outcome` message for an operation +
   * category from live sink state: records actually written, whether a
   * required terminal record is still owed, whether the category is enabled
   * now. Returns null only for impossible input combinations the contract
   * refuses to report.
   */
  outcomeFor(input: UnknownRecord = {}): UnknownRecord | null {
    this.#assertOpen();
    const policy = this.getPolicy();
    const operationRef = String(input.operationRef || "");
    const category = String(input.category || "");
    if (!operationRef || !category) {
      throw new TypeError("outcomeFor requires operationRef and category.");
    }
    const selection = this.#selectionIn(policy, category);
    const pending = this.#db.prepare(
      "SELECT * FROM recording_pending WHERE operation_ref = ? AND category = ?"
    ).get(operationRef, category) as PendingRow | undefined;
    const recordsWritten = this.#count(
      "SELECT COUNT(*) AS total FROM recording_records WHERE operation_ref = ? AND category = ?",
      operationRef, category
    );
    const obligation = typeof input.obligation === "string" && input.obligation
      ? input.obligation
      : pending?.obligation
        || (selection ? String(selection.obligation) : "optional");
    // A required terminal record is owed whenever the operation reached a
    // terminal state and no post-effect record exists — derived from durable
    // record state, so the obligation stays visible even when the pending
    // marker itself could not be written (e.g. a full disk). While the
    // operation is still running or never started, its terminal is not due.
    const operationStatus = typeof input.operationStatus === "string" && input.operationStatus
      ? input.operationStatus
      : "status_unavailable";
    const terminalDue = operationStatus !== "not_started" && operationStatus !== "in_progress";
    const hasTerminalRecord = this.#count(
      "SELECT COUNT(*) AS total FROM recording_records WHERE operation_ref = ? AND category = ? AND phase = 'post_effect'",
      operationRef, category
    ) > 0;
    const requiredTerminalOwed = obligation === "required_before_effect"
      && (pending !== undefined || (terminalDue && !hasTerminalRecord));
    const derived = recordingOutcomeFor({
      obligation,
      categoryEnabled: selection !== null,
      recordsWritten,
      requiredTerminalOwed,
      shedAtAdmission: input.shedAtAdmission === true,
      sinkFailure: input.sinkFailure === undefined ? null : input.sinkFailure
    });
    if (!derived) return null;
    if (derived.outcome === "not_recorded"
        && obligation === "required_before_effect"
        && derived.pendingTerminal !== true) {
      // A required obligation with nothing owed and nothing written has no
      // honest outcome to report — the contract itself refuses this tuple.
      return null;
    }
    try {
      return createRecordingOutcome({
        outcomeId: typeof input.outcomeId === "string" && input.outcomeId
          ? input.outcomeId
          : generatedId("out"),
        operationRef,
        category,
        obligation,
        policyRevision: policy.policyRevision,
        outcome: derived.outcome,
        reason: derived.reason,
        operationStatus,
        recordsWritten,
        pendingTerminal: derived.pendingTerminal,
        failure: input.sinkFailure === undefined ? null : input.sinkFailure,
        occurredAt: typeof input.occurredAt === "string" && input.occurredAt
          ? input.occurredAt
          : this.#iso()
      });
    } catch (error: unknown) {
      // Contract-impossible combinations (e.g. a post-effect failure tuple on
      // a not-started operation) have no honest outcome to report.
      if (error instanceof TypeError) return null;
      throw error;
    }
  }

  /**
   * Recording-only reconciliation: retry the missing terminal record and
   * report the honest outcome. This never replays an effect — it only writes
   * recording records the contract still owes.
   */
  reconcile(input: UnknownRecord = {}): UnknownRecord | null {
    this.#assertOpen();
    const operationRef = String(input.operationRef || "");
    const category = String(input.category || "");
    if (!operationRef || !category) {
      throw new TypeError("reconcile requires operationRef and category.");
    }
    let failure: UnknownRecord | null = null;
    if (input.record !== undefined && input.record !== null) {
      try {
        this.writeRecord(input.record);
      } catch (error: unknown) {
        if (!(error instanceof RecordingSinkError)) {
          // A malformed retry record is a caller bug, not a sink failure.
          throw error;
        }
        if (SINK_FAILURE_CODES.has(error.code)) {
          failure = { code: error.code, phase: "settlement" };
        }
        // Policy-level refusals (category_disabled, policy_superseded, field
        // rules, conflicts) are not sink failures: the derived outcome reports
        // the still-owed or now-disabled state truthfully without a failure.
      }
    }
    return this.outcomeFor({
      operationRef,
      category,
      operationStatus: input.operationStatus,
      sinkFailure: failure,
      outcomeId: input.outcomeId,
      occurredAt: input.occurredAt
    });
  }

  /**
   * Verify the digest-chained journal, every stored record digest and every
   * artifact's custody bytes. Tamper-evidence: a rewritten record, a deleted
   * row without a prune event, a broken chain link or mutated artifact bytes
   * all surface as divergences.
   */
  verifyIntegrity(): RecordingSinkIntegrity {
    const divergences: string[] = [];
    const push = (message: string): void => {
      if (divergences.length < MAX_DIVERGENCES) divergences.push(message);
    };
    let journalEntries = 0;
    let recordsChecked = 0;
    let artifactsChecked = 0;
    try {
      const journal = this.#db.prepare(
        "SELECT * FROM recording_journal ORDER BY seq ASC"
      ).all() as JournalRow[];
      journalEntries = journal.length;
      let previous = GENESIS_DIGEST;
      const written = new Set<string>();
      const pruned = new Set<string>();
      for (const row of journal) {
        if (row.prev_digest !== previous) {
          push(`journal link broken at seq ${row.seq}`);
        }
        const expected = sha256Digest(`${row.prev_digest}\n${row.event}\n${row.ref}\n${row.payload_json}`);
        if (row.digest !== expected) {
          push(`journal digest mismatch at seq ${row.seq}`);
        }
        previous = row.digest;
        if (row.event === "record_written") written.add(row.ref);
        if (row.event === "record_pruned") pruned.add(row.ref);
      }
      const records = this.#db.prepare(
        "SELECT record_id, record_json, record_digest FROM recording_records"
      ).all() as { record_id: string; record_json: string; record_digest: string }[];
      recordsChecked = records.length;
      const held = new Set(records.map((row) => row.record_id));
      for (const row of records) {
        if (sha256Digest(row.record_json) !== row.record_digest) {
          push(`record digest mismatch: ${row.record_id}`);
        }
        if (!written.has(row.record_id)) {
          push(`record present without a journal write: ${row.record_id}`);
        }
      }
      for (const ref of written) {
        if (!held.has(ref) && !pruned.has(ref)) {
          push(`journaled record missing without a prune event: ${ref}`);
        }
      }
      // Counter consistency: a row mutation that skipped its counter update
      // shows up here even when the journal itself looks intact.
      const counters = this.#counters();
      const actualRecords = this.#db.prepare(
        "SELECT COUNT(*) AS record_count, COALESCE(SUM(index_bytes), 0) AS index_bytes FROM recording_records"
      ).get() as { record_count: number; index_bytes: number };
      if (counters.record_count !== actualRecords.record_count
          || counters.record_index_bytes !== actualRecords.index_bytes) {
        push("counter divergence: recording record counters disagree with held rows");
      }
      const actualReservations = this.#db.prepare(
        "SELECT COUNT(*) AS reservation_count, COALESCE(SUM(index_bytes_reserved), 0) AS reserved_index_bytes FROM recording_reservations"
      ).get() as { reservation_count: number; reserved_index_bytes: number };
      if (counters.reservation_count !== actualReservations.reservation_count
          || counters.reserved_index_bytes !== actualReservations.reserved_index_bytes) {
        push("counter divergence: reservation counters disagree with held rows");
      }
      const artifacts = this.#db.prepare(
        "SELECT * FROM recording_artifacts"
      ).all() as ArtifactRow[];
      artifactsChecked = artifacts.length;
      const artifactBytes = artifacts.reduce((sum, row) => sum + Number(row.byte_size), 0);
      if (counters.artifact_count !== artifacts.length
          || counters.artifact_content_bytes !== artifactBytes) {
        push("counter divergence: artifact counters disagree with custody rows");
      }
      const named = new Set(artifacts.map((row) => row.file_name));
      for (const row of artifacts) {
        const filePath = path.join(this.#artifactsDir, row.file_name);
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(filePath);
        } catch {
          push(`artifact bytes missing from custody: ${row.artifact_ref}`);
          continue;
        }
        if (bytes.length !== Number(row.byte_size)
            || sha256Hex(bytes) !== String(row.content_digest).replace(/^sha256:/u, "")) {
          push(`artifact digest mismatch: ${row.artifact_ref}`);
        }
      }
      for (const entry of fs.readdirSync(this.#artifactsDir)) {
        if (!entry.endsWith(".tmp") && !named.has(entry)) {
          push(`artifact file outside custody table: ${entry}`);
        }
      }
    } catch (error: unknown) {
      push(`integrity check could not read the store: ${errorCode(error) || String(error)}`);
    }
    return {
      intact: divergences.length === 0,
      journalEntries,
      recordsChecked,
      artifactsChecked,
      divergences
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

/**
 * Open (or create) the durable enterprise_local recording sink under
 * `rootPath`. `sink` is the contract `recording-sink` descriptor; `policy` is
 * required on first open and thereafter must match the stored current
 * revision — revisions move only through `publishPolicy`.
 */
export function createRecordingSinkStore(options: RecordingSinkStoreOptions = {}): RecordingSinkStore {
  return new SqliteRecordingSinkStore(options);
}

export default createRecordingSinkStore;
