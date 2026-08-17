import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FileHandle } from "node:fs/promises";

import { openSqliteDatabase } from "./sqlite-database.ts";
import { ensurePrivateSqliteLocation } from "./private-sqlite.ts";
import {
  serviceManifestError,
  sha256ManifestBytes,
  stableManifestJson,
  validateManifestDigest,
  validateManifestRevision,
  validateOpaqueServiceId
} from "./storage-ports.ts";

type JsonRecord = Record<string, unknown>;
type Metadata = Record<string, string>;
type SqliteValue = string | number | Buffer | null;
type SqliteRow = Record<string, SqliteValue>;
type ServiceManifestKind = "published" | "candidate";

export interface ManifestTransactionContext {
  readonly budget: Readonly<ManifestResourceBudget>;
  readonly signal?: AbortSignal;
  readonly deadline: number;
  check(): void;
  touchFile(): void;
  consumeRead(byteCount: number): void;
  consumeWrite(byteCount: number): void;
  inspectCleanupEntry(): void;
}

export interface ManifestPointer {
  setRevision: number;
  setDigest: string;
}

export interface ManifestSnapshotEntry {
  serviceId: string;
  serviceRevision: number;
  manifestDigest: string;
  manifestBytes: Buffer;
}

export interface ManifestSnapshotState {
  pointer: Readonly<ManifestPointer>;
  entries: readonly Readonly<ManifestSnapshotEntry>[];
}

export interface ManifestCommitOutcome extends ManifestPointer {
  requestDigest: string;
  serviceId: string;
  manifestDigest: string;
  expectedServiceRevision: number;
  expectedSetRevision: number;
  serviceRevision: number;
  receiptRef: string;
}

export interface ManifestCommitResult {
  outcome: Readonly<ManifestCommitOutcome>;
  replayed: boolean;
  changed: boolean;
}

export interface ManifestCommitInput {
  serviceId: string;
  expectedServiceRevision: number;
  expectedSetRevision: number;
  manifestBytes: Buffer;
  manifestDigest: string;
  requestDigest: string;
}

export interface ServiceManifestTransaction {
  rootPath: string;
  databasePath: string;
  readSnapshot(kind: ServiceManifestKind, context: ManifestTransactionContext): Promise<ManifestSnapshotState>;
  commitManifest(input: ManifestCommitInput, context: ManifestTransactionContext): Promise<ManifestCommitResult>;
  acknowledgePublished(input: ManifestPointer, context: ManifestTransactionContext): Promise<Readonly<ManifestPointer>>;
}

interface ManifestResourceBudget {
  maxManifestBytes: number;
  maxManifestNodes: number;
  maxReferenceCount: number;
  maxServices: number;
  maxRequestRecords: number;
  maxRequestBytes: number;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxFiles: number;
  maxCleanupEntries: number;
  maxOperationMs: number;
}

const DATABASE_SCHEMA_VERSION = 2;
const REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INITIALIZATION_LOCK_STALE_MS = 60_000;
export const SERVICE_MANIFEST_MAX_UNPUBLISHED_SET_REVISIONS = 256;
const RECEIPT_REF_PATTERN =
  /^urn:meshrix:storage-manifest-receipt:[a-f0-9]{64}$/u;
const EXPECTED_TABLES: readonly string[] = Object.freeze([
  "manifest_authority_meta",
  "manifest_blobs",
  "manifest_services",
  "manifest_service_versions",
  "manifest_requests"
]);
const EMPTY_SERVICES: readonly JsonRecord[] = Object.freeze([]);

export const SERVICE_MANIFEST_POINTER_SCHEMA_VERSION =
  "v0.0.1:storage:service-manifest-pointer-2";
export const SERVICE_MANIFEST_GENERATION_SCHEMA_VERSION =
  "v0.0.1:storage:service-manifest-generation-2";
export const SERVICE_MANIFEST_JOURNAL_SCHEMA_VERSION =
  "v0.0.1:storage:service-manifest-sqlite-1";

function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

export function createManifestTransactionContext({
  budget,
  signal,
  laneSignal,
  startedAt = Date.now()
}: {
  budget: Readonly<ManifestResourceBudget>;
  signal?: AbortSignal;
  laneSignal?: AbortSignal | null;
  startedAt?: number;
}): ManifestTransactionContext {
  const combinedSignal: AbortSignal | undefined = combineSignals([signal, laneSignal ?? undefined]);
  const deadline = startedAt + budget.maxOperationMs;
  let readBytes = 0;
  let writeBytes = 0;
  let files = 0;
  let cleanupEntries = 0;

  function check(): void {
    if (combinedSignal?.aborted) {
      const reason: unknown = combinedSignal.reason;
      if (reason instanceof Error) throw reason;
      throw serviceManifestError(
        "storage_manifest_aborted",
        "Service manifest operation was cancelled before publication."
      );
    }
    if (Date.now() > deadline) {
      throw serviceManifestError(
        "storage_manifest_timeout",
        "Service manifest operation exceeded its elapsed-time budget."
      );
    }
  }

  function touchFile(): void {
    check();
    files += 1;
    if (files > budget.maxFiles) {
      throw serviceManifestError(
        "storage_manifest_budget_exceeded",
        "Service manifest file-operation budget was exceeded."
      );
    }
  }

  function consumeRead(byteCount: number): void {
    check();
    readBytes += Number(byteCount);
    if (readBytes > budget.maxReadBytes) {
      throw serviceManifestError(
        "storage_manifest_budget_exceeded",
        "Service manifest read budget was exceeded."
      );
    }
  }

  function consumeWrite(byteCount: number): void {
    check();
    writeBytes += Number(byteCount);
    if (writeBytes > budget.maxWriteBytes) {
      throw serviceManifestError(
        "storage_manifest_budget_exceeded",
        "Service manifest write budget was exceeded."
      );
    }
  }

  function inspectCleanupEntry(): void {
    check();
    cleanupEntries += 1;
    if (cleanupEntries > budget.maxCleanupEntries) {
      throw serviceManifestError(
        "storage_manifest_cleanup_budget_exceeded",
        "Service manifest cleanup requires more work than the declared budget."
      );
    }
  }

  return Object.freeze({
    budget,
    signal: combinedSignal,
    deadline,
    check,
    touchFile,
    consumeRead,
    consumeWrite,
    inspectCleanupEntry
  });
}

export function serviceManifestSetDigest(services: readonly JsonRecord[] = EMPTY_SERVICES): string {
  return sha256ManifestBytes(
    Buffer.from(stableManifestJson(services), "utf8")
  );
}

const EMPTY_SET_DIGEST = serviceManifestSetDigest(EMPTY_SERVICES);

function transitionSetDigest({
  previousSetDigest,
  setRevision,
  serviceId,
  serviceRevision,
  manifestDigest
}: {
  previousSetDigest: string;
  setRevision: number;
  serviceId: string;
  serviceRevision: number;
  manifestDigest: string;
}): string {
  return sha256ManifestBytes(Buffer.from(stableManifestJson({
    previousSetDigest,
    setRevision,
    serviceId,
    serviceRevision,
    manifestDigest
  }), "utf8"));
}

function requestOutcome({
  requestDigest,
  serviceId,
  manifestDigest,
  expectedServiceRevision,
  expectedSetRevision,
  serviceRevision,
  setRevision,
  setDigest
}: Omit<ManifestCommitOutcome, "receiptRef">): ManifestCommitOutcome {
  const receiptDigest = sha256ManifestBytes(
    Buffer.from(stableManifestJson({
      requestDigest,
      serviceId,
      manifestDigest,
      expectedServiceRevision,
      expectedSetRevision,
      serviceRevision,
      setRevision,
      setDigest
    }), "utf8")
  );
  return Object.freeze({
    requestDigest,
    serviceId,
    manifestDigest,
    expectedServiceRevision,
    expectedSetRevision,
    serviceRevision,
    setRevision,
    setDigest,
    receiptRef: `urn:meshrix:storage-manifest-receipt:${receiptDigest}`
  });
}

interface MetadataRow extends SqliteRow {
  key: string;
  value: string;
}

interface SchemaNameRow extends SqliteRow {
  name: string;
}

interface ManifestBlobRow extends SqliteRow {
  bytes: Buffer;
  byte_size: number;
}

interface ManifestServiceRow extends SqliteRow {
  service_revision: number;
  manifest_digest: string;
}

interface ManifestVersionRow extends SqliteRow {
  service_id: string;
  valid_from_revision: number;
  valid_to_revision: number;
  service_revision: number;
  manifest_digest: string;
}

interface ManifestSnapshotRow extends SqliteRow {
  service_id: string;
  service_revision: number;
  manifest_digest: string;
  bytes: Buffer;
  byte_size: number;
}

interface ManifestRequestRow extends SqliteRow {
  request_digest: string;
  service_id: string;
  manifest_digest: string;
  expected_service_revision: number;
  expected_set_revision: number;
  service_revision: number;
  set_revision: number;
  set_digest: string;
  receipt_ref: string;
}

interface ManifestRequestSequenceRow extends SqliteRow {
  sequence: number;
}

function errorRecord(error: unknown): Record<string, unknown> {
  return error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
}

function errorCode(error: unknown): string {
  return String(errorRecord(error).code || "");
}

function metaRows(db: Database.Database): Metadata {
  const rows = db.prepare("SELECT key,value FROM manifest_authority_meta").all() as MetadataRow[];
  return Object.fromEntries(rows.map((row): [string, string] => [row.key, row.value]));
}

function numberMeta(meta: Metadata, key: string): number {
  const value = Number(meta[key]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw serviceManifestError(
      "storage_manifest_index_invalid",
      "Service manifest index metadata is invalid."
    );
  }
  return value;
}

function verifySchema(db: Database.Database): boolean {
  const expected = new Set<string>(EXPECTED_TABLES);
  const rows = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table'
        AND name IN (
          'manifest_authority_meta',
          'manifest_blobs',
          'manifest_services',
          'manifest_service_versions',
          'manifest_requests'
        )
    `).all() as SchemaNameRow[];
  const existing = new Set<string>(
    rows.map((row): string => row.name)
  );
  if (
    existing.size !== 0 &&
    (
      existing.size !== expected.size ||
      [...expected].some((name): boolean => !existing.has(name))
    )
  ) {
    throw serviceManifestError(
      "storage_manifest_index_incomplete",
      "Service manifest index schema is incomplete."
    );
  }
  return existing.size === 0;
}

function createSchema(
  db: Database.Database,
  { initialize = false }: { initialize?: boolean } = {}
): void {
  const initializing = verifySchema(db);
  if (!initializing) {
    const expectedIndexes = new Set<string>([
      "idx_manifest_versions_visibility",
      "idx_manifest_versions_digest",
      "idx_manifest_versions_retention",
      "idx_manifest_requests_created"
    ]);
    const expectedTriggers = new Set<string>([
      "manifest_services_insert",
      "manifest_services_delete",
      "manifest_requests_insert",
      "manifest_requests_delete"
    ]);
    const indexRows = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='index' AND name LIKE 'idx_manifest_%'
      `).all() as SchemaNameRow[];
    const indexes = new Set<string>(
      indexRows.map((row): string => row.name)
    );
    const triggerRows = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='trigger' AND name LIKE 'manifest_%'
      `).all() as SchemaNameRow[];
    const triggers = new Set<string>(
      triggerRows.map((row): string => row.name)
    );
    if (
      [...expectedIndexes].some((name): boolean => !indexes.has(name)) ||
      [...expectedTriggers].some((name): boolean => !triggers.has(name))
    ) {
      throw serviceManifestError(
        "storage_manifest_index_incomplete",
        "Service manifest index schema is incomplete."
      );
    }
    const meta = metaRows(db);
    for (const key of [
      "schema_version",
      "candidate_set_revision",
      "candidate_set_digest",
      "published_set_revision",
      "published_set_digest",
      "service_count",
      "request_count",
      "request_bytes"
    ]) {
      if (meta[key] === undefined) {
        throw serviceManifestError(
          "storage_manifest_index_incomplete",
          "Service manifest index metadata is incomplete."
        );
      }
    }
    if (Number(meta.schema_version) !== DATABASE_SCHEMA_VERSION) {
      throw serviceManifestError(
        "storage_manifest_index_unsupported",
        "Service manifest index schema is unsupported."
      );
    }
    return;
  }
  if (!initialize) {
    throw serviceManifestError(
      "storage_manifest_index_incomplete",
      "Service manifest index schema is incomplete."
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS manifest_authority_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS manifest_blobs (
      digest TEXT PRIMARY KEY,
      bytes BLOB NOT NULL,
      byte_size INTEGER NOT NULL CHECK(byte_size>=0)
    );
    CREATE TABLE IF NOT EXISTS manifest_services (
      service_id TEXT PRIMARY KEY,
      service_revision INTEGER NOT NULL CHECK(service_revision>0),
      manifest_digest TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS manifest_service_versions (
      service_id TEXT NOT NULL,
      valid_from_revision INTEGER NOT NULL CHECK(valid_from_revision>0),
      valid_to_revision INTEGER NOT NULL DEFAULT 0 CHECK(valid_to_revision>=0),
      service_revision INTEGER NOT NULL CHECK(service_revision>0),
      manifest_digest TEXT NOT NULL,
      PRIMARY KEY(service_id,valid_from_revision)
    );
    CREATE INDEX IF NOT EXISTS idx_manifest_versions_visibility
      ON manifest_service_versions(
        service_id,valid_from_revision,valid_to_revision
      );
    CREATE INDEX IF NOT EXISTS idx_manifest_versions_digest
      ON manifest_service_versions(manifest_digest);
    CREATE INDEX IF NOT EXISTS idx_manifest_versions_retention
      ON manifest_service_versions(
        valid_to_revision,service_id,valid_from_revision
      );
    CREATE TABLE IF NOT EXISTS manifest_requests (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      request_digest TEXT NOT NULL UNIQUE,
      service_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      expected_service_revision INTEGER NOT NULL,
      expected_set_revision INTEGER NOT NULL,
      service_revision INTEGER NOT NULL,
      set_revision INTEGER NOT NULL,
      set_digest TEXT NOT NULL,
      receipt_ref TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      record_bytes INTEGER NOT NULL CHECK(record_bytes>=0)
    );
    CREATE INDEX IF NOT EXISTS idx_manifest_requests_created
      ON manifest_requests(created_at_ms,sequence);
  `);
  const initial: Record<string, string | number> = {
    schema_version: DATABASE_SCHEMA_VERSION,
    candidate_set_revision: 0,
    candidate_set_digest: EMPTY_SET_DIGEST,
    published_set_revision: 0,
    published_set_digest: EMPTY_SET_DIGEST,
    service_count: 0,
    request_count: 0,
    request_bytes: 0
  };
  const insert = db.prepare(
    "INSERT INTO manifest_authority_meta(key,value) VALUES(?,?)"
  );
  db.transaction((): void => {
    for (const [key, value] of Object.entries(initial)) {
      insert.run(key, String(value));
    }
  })();
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS manifest_services_insert
    AFTER INSERT ON manifest_services
    BEGIN
      UPDATE manifest_authority_meta
      SET value=CAST(value AS INTEGER)+1
      WHERE key='service_count';
    END;
    CREATE TRIGGER IF NOT EXISTS manifest_services_delete
    AFTER DELETE ON manifest_services
    BEGIN
      UPDATE manifest_authority_meta
      SET value=CAST(value AS INTEGER)-1
      WHERE key='service_count';
    END;
    CREATE TRIGGER IF NOT EXISTS manifest_requests_insert
    AFTER INSERT ON manifest_requests
    BEGIN
      UPDATE manifest_authority_meta
      SET value=CAST(value AS INTEGER)+1
      WHERE key='request_count';
      UPDATE manifest_authority_meta
      SET value=CAST(value AS INTEGER)+NEW.record_bytes
      WHERE key='request_bytes';
    END;
    CREATE TRIGGER IF NOT EXISTS manifest_requests_delete
    AFTER DELETE ON manifest_requests
    BEGIN
      UPDATE manifest_authority_meta
      SET value=CAST(value AS INTEGER)-1
      WHERE key='request_count';
      UPDATE manifest_authority_meta
      SET value=CAST(value AS INTEGER)-OLD.record_bytes
      WHERE key='request_bytes';
    END;
  `);
}

function databasePathFor(rootPath: string): string {
  return path.join(rootPath, "authority.sqlite");
}

function openAuthorityDatabase(
  rootPath: string,
  { create = false }: { create?: boolean } = {}
): Database.Database | null {
  const databasePath = databasePathFor(rootPath);
  let databaseExists = false;
  try {
    const stat = fsSyncStat(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw serviceManifestError(
        "storage_manifest_file_unsafe",
        "Service manifest index must be a regular non-symbolic-link file."
      );
    }
    databaseExists = true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT" && !create) return null;
    if (errorCode(error) !== "ENOENT") throw error;
  }
  ensurePrivateSqliteLocation(databasePath);
  const db = openSqliteDatabase(databasePath);
  try {
    db.pragma("busy_timeout = 5000");
    if (!databaseExists) db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    createSchema(db, { initialize: create });
    return db;
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}

function assertSafeDirectoryAncestry(directoryPath: string): void {
  let current = path.resolve(directoryPath);
  while (true) {
    try {
      const stat = fsNative.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw serviceManifestError(
          "storage_manifest_directory_unsafe",
          "Service manifest storage ancestry must contain only real directories."
        );
      }
      return;
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function fsSyncStat(filePath: string): fsNative.Stats {
  // lstat is kept behind one small lazy boundary so reader-only access can
  // preserve an absent authority root without creating it.
  return fsNative.lstatSync(filePath);
}

function pointerFromMeta(meta: Metadata, kind: ServiceManifestKind): Readonly<ManifestPointer> {
  const setRevision = numberMeta(meta, `${kind}_set_revision`);
  const setDigest = String(meta[`${kind}_set_digest`] || "");
  validateManifestDigest(setDigest, `${kind} set digest`);
  return Object.freeze({ setRevision, setDigest });
}

function outcomeFromRow(row: ManifestRequestRow | undefined | null): Readonly<ManifestCommitOutcome> | null {
  if (!row) return null;
  const outcome: ManifestCommitOutcome = {
    requestDigest: row.request_digest,
    serviceId: row.service_id,
    manifestDigest: row.manifest_digest,
    expectedServiceRevision: Number(row.expected_service_revision),
    expectedSetRevision: Number(row.expected_set_revision),
    serviceRevision: Number(row.service_revision),
    setRevision: Number(row.set_revision),
    setDigest: row.set_digest,
    receiptRef: row.receipt_ref
  };
  validateManifestDigest(outcome.requestDigest, "request digest");
  validateOpaqueServiceId(outcome.serviceId);
  validateManifestDigest(outcome.manifestDigest, "manifest digest");
  validateManifestRevision(outcome.expectedServiceRevision, "expected service revision");
  validateManifestRevision(outcome.expectedSetRevision, "expected set revision");
  validateManifestRevision(outcome.serviceRevision, "service revision");
  validateManifestRevision(outcome.setRevision, "set revision");
  validateManifestDigest(outcome.setDigest, "set digest");
  if (!RECEIPT_REF_PATTERN.test(outcome.receiptRef)) {
    throw serviceManifestError(
      "storage_manifest_receipt_invalid",
      "Service manifest request receipt reference is invalid."
    );
  }
  return Object.freeze(outcome);
}

function assertRequestMatches(outcome: ManifestCommitOutcome, input: ManifestCommitInput): void {
  if (
    outcome.serviceId !== input.serviceId ||
    outcome.manifestDigest !== input.manifestDigest ||
    outcome.expectedServiceRevision !== input.expectedServiceRevision ||
    outcome.expectedSetRevision !== input.expectedSetRevision
  ) {
    throw serviceManifestError(
      "storage_manifest_replay_conflict",
      "Service manifest request identity was reused with different canonical input."
    );
  }
}

function setMeta(db: Database.Database, key: string, value: string | number): void {
  db.prepare(
    "UPDATE manifest_authority_meta SET value=? WHERE key=?"
  ).run(String(value), key);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withInitializationLock<T>(
  rootPath: string,
  context: ManifestTransactionContext,
  action: () => Promise<T>
): Promise<T> {
  const lockPath = path.join(rootPath, ".authority-initialize.lock");
  const token = `${process.pid}:${randomUUID()}`;
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  await fs.chmod(rootPath, 0o700);
  while (true) {
    context.check();
    try {
      const handle: FileHandle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(token, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch((): undefined => undefined);
      if (
        stat &&
        Date.now() - stat.mtimeMs > INITIALIZATION_LOCK_STALE_MS
      ) {
        const owner = await fs.readFile(lockPath, "utf8").catch((): string => "");
        const ownerPid = Number(owner.split(":", 1)[0]);
        let alive = Number.isSafeInteger(ownerPid) && ownerPid > 0;
        if (alive) {
          try {
            process.kill(ownerPid, 0);
          } catch (ownerError: unknown) {
            alive = errorCode(ownerError) !== "ESRCH";
          }
        }
        if (!alive) {
          const abandoned = `${lockPath}.abandoned-${randomUUID()}`;
          await fs.rename(lockPath, abandoned).catch((renameError: unknown): void => {
            if (errorCode(renameError) !== "ENOENT") throw renameError;
          });
          await fs.rm(abandoned, { force: true });
          continue;
        }
      }
      await delay(10);
    }
  }
  const heartbeat = setInterval((): void => {
    void fs.readFile(lockPath, "utf8").then((owner: string): Promise<void> | void => {
      if (owner.trim() !== token) return;
      return fs.utimes(lockPath, new Date(), new Date());
    }).catch((): void => {});
  }, 5_000);
  heartbeat.unref?.();
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    const owner = await fs.readFile(lockPath, "utf8").catch((): string => "");
    if (owner.trim() === token) {
      await fs.rm(lockPath, { force: true });
    }
  }
}

export function serviceManifestAuthorityRoot(storageRoot: unknown): string {
  if (
    typeof storageRoot !== "string" ||
    !storageRoot.trim() ||
    storageRoot.includes("\u0000")
  ) {
    throw serviceManifestError(
      "storage_manifest_root_invalid",
      "Service manifest storage root is required."
    );
  }
  return path.join(path.resolve(storageRoot), "service-manifests");
}

export function createServiceManifestTransaction({
  storageRoot,
  now = Date.now
}: {
  storageRoot: string;
  now?: () => number;
}): Readonly<ServiceManifestTransaction> {
  const rootPath = serviceManifestAuthorityRoot(storageRoot);
  const databasePath = databasePathFor(rootPath);

  async function ensureAuthority(context: ManifestTransactionContext): Promise<void> {
    context.check();
    assertSafeDirectoryAncestry(rootPath);
    try {
      const existing = openAuthorityDatabase(rootPath, { create: false });
      if (existing) {
        existing.close();
        return;
      }
    } catch (error: unknown) {
      if (errorCode(error) !== "storage_manifest_index_incomplete") throw error;
    }
    await withInitializationLock(rootPath, context, async (): Promise<void> => {
      const db = openAuthorityDatabase(rootPath, { create: true });
      if (!db) throw new Error("Service manifest authority database could not be initialized.");
      db.close();
    });
  }

  async function readSnapshot(
    kind: ServiceManifestKind,
    context: ManifestTransactionContext
  ): Promise<ManifestSnapshotState> {
    context.check();
    assertSafeDirectoryAncestry(rootPath);
    const db = openAuthorityDatabase(rootPath, { create: false });
    if (!db) {
      return Object.freeze({
        pointer: Object.freeze({
          setRevision: 0,
          setDigest: EMPTY_SET_DIGEST
        }),
        entries: Object.freeze([])
      });
    }
    try {
      const meta = metaRows(db);
      const pointer = pointerFromMeta(meta, kind);
      if (pointer.setRevision === 0) {
        return Object.freeze({ pointer, entries: Object.freeze([]) });
      }
      const rows = db.prepare(`
        SELECT v.service_id,v.service_revision,v.manifest_digest,
               b.bytes,b.byte_size
        FROM manifest_service_versions AS v
        JOIN manifest_blobs AS b ON b.digest=v.manifest_digest
        WHERE v.valid_from_revision<=?
          AND (v.valid_to_revision=0 OR v.valid_to_revision>?)
        ORDER BY v.service_id ASC
      `).all(pointer.setRevision, pointer.setRevision) as ManifestSnapshotRow[];
      if (rows.length > context.budget.maxServices) {
        throw serviceManifestError(
          "storage_manifest_budget_exceeded",
          "Service manifest service count exceeds its resource budget."
        );
      }
      const entries = rows.map((row): Readonly<ManifestSnapshotEntry> => {
        const bytes = Buffer.from(row.bytes);
        context.consumeRead(bytes.length);
        if (
          bytes.length !== Number(row.byte_size) ||
          sha256ManifestBytes(bytes) !== String(row.manifest_digest)
        ) {
          throw serviceManifestError(
            "storage_manifest_content_invalid",
            "Service manifest indexed content is not digest-bound."
          );
        }
        return Object.freeze({
          serviceId: row.service_id,
          serviceRevision: row.service_revision,
          manifestDigest: row.manifest_digest,
          manifestBytes: bytes
        });
      });
      return Object.freeze({
        pointer,
        entries: Object.freeze(entries)
      });
    } finally {
      db.close();
    }
  }

  async function commitManifest({
    serviceId,
    expectedServiceRevision,
    expectedSetRevision,
    manifestBytes,
    manifestDigest,
    requestDigest
  }: ManifestCommitInput, context: ManifestTransactionContext): Promise<ManifestCommitResult> {
    await ensureAuthority(context);
    const db = openAuthorityDatabase(rootPath, { create: false });
    if (!db) throw new Error("Service manifest authority database disappeared during commit.");
    try {
      try {
        return db.transaction((): ManifestCommitResult => {
          context.check();
          const existingRequest = outcomeFromRow(db.prepare(`
          SELECT * FROM manifest_requests WHERE request_digest=?
        `).get(requestDigest) as ManifestRequestRow | undefined);
        const input: ManifestCommitInput = {
          manifestBytes,
          serviceId,
          manifestDigest,
          expectedServiceRevision,
          expectedSetRevision,
          requestDigest
        };
        if (existingRequest) {
          assertRequestMatches(existingRequest, input);
          return Object.freeze({
            outcome: existingRequest,
            replayed: true,
            changed: false
          });
        }
        const meta = metaRows(db);
        const candidate = pointerFromMeta(meta, "candidate");
        const published = pointerFromMeta(meta, "published");
        const existingService = db.prepare(`
          SELECT service_revision,manifest_digest
          FROM manifest_services
          WHERE service_id=?
        `).get(serviceId) as ManifestServiceRow | undefined;
        const actualServiceRevision = existingService?.service_revision ?? 0;
        if (expectedServiceRevision !== actualServiceRevision) {
          throw serviceManifestError(
            "storage_manifest_service_revision_stale",
            "Service manifest expected service revision is stale."
          );
        }
        if (expectedSetRevision !== candidate.setRevision) {
          throw serviceManifestError(
            "storage_manifest_set_revision_stale",
            "Service manifest expected set revision is stale."
          );
        }
        const unchanged =
          (existingService?.manifest_digest || "") === manifestDigest;
        const serviceRevision = unchanged
          ? actualServiceRevision
          : actualServiceRevision + 1;
        const setRevision = unchanged
          ? candidate.setRevision
          : candidate.setRevision + 1;
        if (!existingService && !unchanged) {
          const serviceCount = numberMeta(meta, "service_count");
          if (serviceCount + 1 > context.budget.maxServices) {
            throw serviceManifestError(
              "storage_manifest_budget_exceeded",
              "Service manifest service count exceeds its resource budget."
            );
          }
        }
        let setDigest = candidate.setDigest;
        if (!unchanged) {
          if (
            candidate.setRevision - published.setRevision >=
            SERVICE_MANIFEST_MAX_UNPUBLISHED_SET_REVISIONS
          ) {
            throw serviceManifestError(
              "storage_manifest_publication_backlog_exceeded",
              "Service manifest unpublished revision backlog is exhausted."
            );
          }
          setDigest = transitionSetDigest({
            previousSetDigest: candidate.setDigest,
            setRevision,
            serviceId,
            serviceRevision,
            manifestDigest
          });
          const existingBlob = db.prepare(`
            SELECT bytes,byte_size FROM manifest_blobs WHERE digest=?
          `).get(manifestDigest) as ManifestBlobRow | undefined;
          if (existingBlob) {
            const existingBytes = Buffer.from(existingBlob.bytes);
            if (
              existingBytes.length !== Number(existingBlob.byte_size) ||
              !existingBytes.equals(manifestBytes)
            ) {
              throw serviceManifestError(
                "storage_manifest_immutable_conflict",
                "Service manifest indexed content conflicts with its digest."
              );
            }
          } else {
            context.consumeWrite(manifestBytes.length);
            db.prepare(`
              INSERT INTO manifest_blobs(digest,bytes,byte_size)
              VALUES(?,?,?)
            `).run(manifestDigest, manifestBytes, manifestBytes.length);
          }
          if (existingService) {
            db.prepare(`
              UPDATE manifest_service_versions
              SET valid_to_revision=?
              WHERE service_id=? AND valid_to_revision=0
            `).run(setRevision, serviceId);
          }
          db.prepare(`
            INSERT INTO manifest_service_versions(
              service_id,valid_from_revision,valid_to_revision,
              service_revision,manifest_digest
            ) VALUES(?,?,0,?,?)
          `).run(serviceId, setRevision, serviceRevision, manifestDigest);
          db.prepare(`
            INSERT INTO manifest_services(
              service_id,service_revision,manifest_digest
            ) VALUES(?,?,?)
            ON CONFLICT(service_id) DO UPDATE SET
              service_revision=excluded.service_revision,
              manifest_digest=excluded.manifest_digest
          `).run(serviceId, serviceRevision, manifestDigest);
          setMeta(db, "candidate_set_revision", setRevision);
          setMeta(db, "candidate_set_digest", setDigest);
        }
        const outcome = requestOutcome({
          requestDigest,
          serviceId,
          manifestDigest,
          expectedServiceRevision,
          expectedSetRevision,
          serviceRevision,
          setRevision,
          setDigest
        });
        const recordBytes = Buffer.byteLength(stableManifestJson(outcome));
        if (recordBytes > context.budget.maxRequestBytes) {
          throw serviceManifestError(
            "storage_manifest_request_capacity_exceeded",
            "Service manifest request record exceeds its byte budget."
          );
        }
        let removed = 0;
        const cutoff = now() - REQUEST_RETENTION_MS;
        while (removed < context.budget.maxCleanupEntries) {
          const currentMeta = metaRows(db);
          const overCapacity =
            numberMeta(currentMeta, "request_count") + 1 >
              context.budget.maxRequestRecords ||
            numberMeta(currentMeta, "request_bytes") + recordBytes >
              context.budget.maxRequestBytes;
          const oldest = db.prepare(`
            SELECT sequence
            FROM manifest_requests
            WHERE ? OR created_at_ms<=?
            ORDER BY created_at_ms ASC,sequence ASC
            LIMIT 1
          `).get(overCapacity ? 1 : 0, cutoff) as ManifestRequestSequenceRow | undefined;
          if (!oldest) break;
          context.inspectCleanupEntry();
          db.prepare(
            "DELETE FROM manifest_requests WHERE sequence=?"
          ).run(oldest.sequence);
          removed += 1;
        }
        const capacity = metaRows(db);
        if (
          numberMeta(capacity, "request_count") + 1 >
            context.budget.maxRequestRecords ||
          numberMeta(capacity, "request_bytes") + recordBytes >
            context.budget.maxRequestBytes
        ) {
          throw serviceManifestError(
            "storage_manifest_request_capacity_exceeded",
            "Service manifest request history capacity is exhausted."
          );
        }
        context.consumeWrite(recordBytes);
        db.prepare(`
          INSERT INTO manifest_requests(
            request_digest,service_id,manifest_digest,
            expected_service_revision,expected_set_revision,
            service_revision,set_revision,set_digest,receipt_ref,
            created_at_ms,record_bytes
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          outcome.requestDigest,
          outcome.serviceId,
          outcome.manifestDigest,
          outcome.expectedServiceRevision,
          outcome.expectedSetRevision,
          outcome.serviceRevision,
          outcome.setRevision,
          outcome.setDigest,
          outcome.receiptRef,
          now(),
          recordBytes
        );
          return Object.freeze({
            outcome,
            replayed: false,
            changed: !unchanged
          });
        }).immediate();
      } catch (error: unknown) {
        if (errorCode(error) === "SQLITE_CONSTRAINT_PRIMARYKEY") {
          const candidate = pointerFromMeta(metaRows(db), "candidate");
          if (expectedSetRevision !== candidate.setRevision) {
            throw serviceManifestError(
              "storage_manifest_set_revision_stale",
              "Service manifest expected set revision is stale."
            );
          }
        }
        throw error;
      }
    } finally {
      db.close();
    }
  }

  async function acknowledgePublished(
    { setRevision, setDigest }: ManifestPointer,
    context: ManifestTransactionContext
  ): Promise<Readonly<ManifestPointer>> {
    await ensureAuthority(context);
    const db = openAuthorityDatabase(rootPath, { create: false });
    if (!db) throw new Error("Service manifest authority database disappeared during acknowledgement.");
    try {
      return db.transaction((): Readonly<ManifestPointer> => {
        context.check();
        const meta = metaRows(db);
        const candidate = pointerFromMeta(meta, "candidate");
        if (
          candidate.setRevision !== setRevision ||
          candidate.setDigest !== setDigest
        ) {
          throw serviceManifestError(
            "storage_manifest_acknowledgement_stale",
            "Service manifest acknowledgement does not match the current candidate."
          );
        }
        setMeta(db, "published_set_revision", setRevision);
        setMeta(db, "published_set_digest", setDigest);
        const obsolete = db.prepare(`
          SELECT service_id,valid_from_revision,manifest_digest
          FROM manifest_service_versions
          WHERE valid_to_revision<>0 AND valid_to_revision<=?
          ORDER BY valid_to_revision ASC,service_id ASC
          LIMIT ?
        `).all(setRevision, context.budget.maxCleanupEntries) as ManifestVersionRow[];
        for (const row of obsolete) {
          context.inspectCleanupEntry();
          db.prepare(`
            DELETE FROM manifest_service_versions
            WHERE service_id=? AND valid_from_revision=?
          `).run(row.service_id, row.valid_from_revision);
          const retained = db.prepare(`
            SELECT 1 FROM manifest_service_versions
            WHERE manifest_digest=?
            LIMIT 1
          `).get(row.manifest_digest) as SqliteRow | undefined;
          if (!retained) {
            db.prepare(
              "DELETE FROM manifest_blobs WHERE digest=?"
            ).run(row.manifest_digest);
          }
        }
        return candidate;
      }).immediate();
    } finally {
      db.close();
    }
  }

  return Object.freeze({
    rootPath,
    databasePath,
    readSnapshot,
    commitManifest,
    acknowledgePublished
  });
}
