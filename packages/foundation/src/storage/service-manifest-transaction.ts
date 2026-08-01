import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

const DATABASE_SCHEMA_VERSION: any = 2;
const REQUEST_RETENTION_MS: any = 7 * 24 * 60 * 60 * 1000;
const INITIALIZATION_LOCK_STALE_MS: any = 60_000;
export const SERVICE_MANIFEST_MAX_UNPUBLISHED_SET_REVISIONS: any = 256;
const RECEIPT_REF_PATTERN: any =
  /^urn:meshrix:storage-manifest-receipt:[a-f0-9]{64}$/u;
const EXPECTED_TABLES: readonly any[] = Object.freeze([
  "manifest_authority_meta",
  "manifest_blobs",
  "manifest_services",
  "manifest_service_versions",
  "manifest_requests"
]);
const EMPTY_SERVICES: readonly any[] = Object.freeze([]);

export const SERVICE_MANIFEST_POINTER_SCHEMA_VERSION: any =
  "v0.0.1:storage:service-manifest-pointer-2";
export const SERVICE_MANIFEST_GENERATION_SCHEMA_VERSION: any =
  "v0.0.1:storage:service-manifest-generation-2";
export const SERVICE_MANIFEST_JOURNAL_SCHEMA_VERSION: any =
  "v0.0.1:storage:service-manifest-sqlite-1";

function combineSignals(signals?: any) : any {
  const active: any = signals.filter(Boolean);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

export function createManifestTransactionContext({
  budget,
  signal,
  laneSignal,
  startedAt = Date.now()
}: Record<string, any>) : any {
  const combinedSignal: any = combineSignals([signal, laneSignal]);
  const deadline: any = startedAt + budget.maxOperationMs;
  let readBytes: any = 0;
  let writeBytes: any = 0;
  let files: any = 0;
  let cleanupEntries: any = 0;

  function check() : any {
    if (combinedSignal?.aborted) {
      const reason: any = combinedSignal.reason;
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

  function touchFile() : any {
    check();
    files += 1;
    if (files > budget.maxFiles) {
      throw serviceManifestError(
        "storage_manifest_budget_exceeded",
        "Service manifest file-operation budget was exceeded."
      );
    }
  }

  function consumeRead(byteCount?: any) : any {
    check();
    readBytes += Number(byteCount);
    if (readBytes > budget.maxReadBytes) {
      throw serviceManifestError(
        "storage_manifest_budget_exceeded",
        "Service manifest read budget was exceeded."
      );
    }
  }

  function consumeWrite(byteCount?: any) : any {
    check();
    writeBytes += Number(byteCount);
    if (writeBytes > budget.maxWriteBytes) {
      throw serviceManifestError(
        "storage_manifest_budget_exceeded",
        "Service manifest write budget was exceeded."
      );
    }
  }

  function inspectCleanupEntry() : any {
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

export function serviceManifestSetDigest(services?: any) : any {
  return sha256ManifestBytes(
    Buffer.from(stableManifestJson(services), "utf8")
  );
}

const EMPTY_SET_DIGEST: any = serviceManifestSetDigest(EMPTY_SERVICES);

function transitionSetDigest({
  previousSetDigest,
  setRevision,
  serviceId,
  serviceRevision,
  manifestDigest
}: Record<string, any>) : any {
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
}: Record<string, any>) : any {
  const receiptDigest: any = sha256ManifestBytes(
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

function metaRows(db?: any) : any {
  return Object.fromEntries(
    db.prepare("SELECT key,value FROM manifest_authority_meta").all()
      .map((row?: any) : any => [String(row.key), String(row.value)])
  );
}

function numberMeta(meta?: any, key?: any) : any {
  const value: any = Number(meta[key]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw serviceManifestError(
      "storage_manifest_index_invalid",
      "Service manifest index metadata is invalid."
    );
  }
  return value;
}

function verifySchema(db?: any) : any {
  const expected: any = new Set<any>(EXPECTED_TABLES);
  const existing: any = new Set<any>(
    db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table'
        AND name IN (
          'manifest_authority_meta',
          'manifest_blobs',
          'manifest_services',
          'manifest_service_versions',
          'manifest_requests'
        )
    `).all().map((row?: any) : any => String(row.name))
  );
  if (
    existing.size !== 0 &&
    (
      existing.size !== expected.size ||
      [...expected].some((name?: any) : any => !existing.has(name))
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
  db?: any,
  { initialize = false }: Record<string, any> = {}
) : any {
  const initializing: any = verifySchema(db);
  if (!initializing) {
    const expectedIndexes: any = new Set<any>([
      "idx_manifest_versions_visibility",
      "idx_manifest_versions_digest",
      "idx_manifest_versions_retention",
      "idx_manifest_requests_created"
    ]);
    const expectedTriggers: any = new Set<any>([
      "manifest_services_insert",
      "manifest_services_delete",
      "manifest_requests_insert",
      "manifest_requests_delete"
    ]);
    const indexes: any = new Set<any>(
      db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='index' AND name LIKE 'idx_manifest_%'
      `).all().map((row?: any) : any => String(row.name))
    );
    const triggers: any = new Set<any>(
      db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='trigger' AND name LIKE 'manifest_%'
      `).all().map((row?: any) : any => String(row.name))
    );
    if (
      [...expectedIndexes].some((name?: any) : any => !indexes.has(name)) ||
      [...expectedTriggers].some((name?: any) : any => !triggers.has(name))
    ) {
      throw serviceManifestError(
        "storage_manifest_index_incomplete",
        "Service manifest index schema is incomplete."
      );
    }
    const meta: any = metaRows(db);
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
  const initial: Record<string, any> = {
    schema_version: DATABASE_SCHEMA_VERSION,
    candidate_set_revision: 0,
    candidate_set_digest: EMPTY_SET_DIGEST,
    published_set_revision: 0,
    published_set_digest: EMPTY_SET_DIGEST,
    service_count: 0,
    request_count: 0,
    request_bytes: 0
  };
  const insert: any = db.prepare(
    "INSERT INTO manifest_authority_meta(key,value) VALUES(?,?)"
  );
  db.transaction(() : any => {
    for (const [key, value] of (Object.entries(initial) as [string, any][])) {
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

function databasePathFor(rootPath?: any) : any {
  return path.join(rootPath, "authority.sqlite");
}

function openAuthorityDatabase(rootPath?: any, { create = false }: Record<string, any> = {}) : any {
  const databasePath: any = databasePathFor(rootPath);
  let databaseExists: any = false;
  try {
    const stat: any = fsSyncStat(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw serviceManifestError(
        "storage_manifest_file_unsafe",
        "Service manifest index must be a regular non-symbolic-link file."
      );
    }
    databaseExists = true;
  } catch (error: any) {
    if (error?.code === "ENOENT" && !create) return null;
    if (error?.code !== "ENOENT") throw error;
  }
  ensurePrivateSqliteLocation(databasePath);
  const db: any = openSqliteDatabase(databasePath);
  try {
    db.pragma("busy_timeout = 5000");
    if (!databaseExists) db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    createSchema(db, { initialize: create });
    return db;
  } catch (error: any) {
    db.close();
    throw error;
  }
}

function assertSafeDirectoryAncestry(directoryPath?: any) : any {
  let current: any = path.resolve(directoryPath);
  while (true) {
    try {
      const stat: any = fsNative.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw serviceManifestError(
          "storage_manifest_directory_unsafe",
          "Service manifest storage ancestry must contain only real directories."
        );
      }
      return;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent: any = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function fsSyncStat(filePath?: any) : any {
  // lstat is kept behind one small lazy boundary so reader-only access can
  // preserve an absent authority root without creating it.
  return fsNative.lstatSync(filePath);
}

function pointerFromMeta(meta?: any, kind?: any) : any {
  const setRevision: any = numberMeta(meta, `${kind}_set_revision`);
  const setDigest: any = String(meta[`${kind}_set_digest`] || "");
  validateManifestDigest(setDigest, `${kind} set digest`);
  return Object.freeze({ setRevision, setDigest });
}

function outcomeFromRow(row?: any) : any {
  if (!row) return null;
  return Object.freeze({
    requestDigest: String(row.request_digest),
    serviceId: String(row.service_id),
    manifestDigest: String(row.manifest_digest),
    expectedServiceRevision: Number(row.expected_service_revision),
    expectedSetRevision: Number(row.expected_set_revision),
    serviceRevision: Number(row.service_revision),
    setRevision: Number(row.set_revision),
    setDigest: String(row.set_digest),
    receiptRef: String(row.receipt_ref)
  });
}

function assertRequestMatches(outcome?: any, input?: any) : any {
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

function setMeta(db?: any, key?: any, value?: any) : any {
  db.prepare(
    "UPDATE manifest_authority_meta SET value=? WHERE key=?"
  ).run(String(value), key);
}

function delay(milliseconds?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, milliseconds));
}

async function withInitializationLock(rootPath?: any, context?: any, action?: any) : Promise<any> {
  const lockPath: any = path.join(rootPath, ".authority-initialize.lock");
  const token: any = `${process.pid}:${randomUUID()}`;
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  await fs.chmod(rootPath, 0o700);
  while (true) {
    context.check();
    try {
      const handle: any = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(token, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const stat: any = await fs.stat(lockPath).catch(() : any => null);
      if (
        stat &&
        Date.now() - stat.mtimeMs > INITIALIZATION_LOCK_STALE_MS
      ) {
        const owner: any = await fs.readFile(lockPath, "utf8").catch(() : any => "");
        const ownerPid: any = Number(String(owner).split(":", 1)[0]);
        let alive: any = Number.isSafeInteger(ownerPid) && ownerPid > 0;
        if (alive) {
          try {
            process.kill(ownerPid, 0);
          } catch (ownerError: any) {
            alive = ownerError?.code !== "ESRCH";
          }
        }
        if (!alive) {
          const abandoned: any = `${lockPath}.abandoned-${randomUUID()}`;
          await fs.rename(lockPath, abandoned).catch((renameError?: any) : any => {
            if (renameError?.code !== "ENOENT") throw renameError;
          });
          await fs.rm(abandoned, { force: true });
          continue;
        }
      }
      await delay(10);
    }
  }
  const heartbeat: any = setInterval(() : any => {
    void fs.readFile(lockPath, "utf8").then((owner?: any) : any => {
      if (owner.trim() !== token) return;
      return fs.utimes(lockPath, new Date(), new Date());
    }).catch(() : any => {});
  }, 5_000);
  heartbeat.unref?.();
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    const owner: any = await fs.readFile(lockPath, "utf8").catch(() : any => "");
    if (owner.trim() === token) {
      await fs.rm(lockPath, { force: true });
    }
  }
}

export function serviceManifestAuthorityRoot(storageRoot?: any) : any {
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
}: Record<string, any>) : any {
  const rootPath: any = serviceManifestAuthorityRoot(storageRoot);
  const databasePath: any = databasePathFor(rootPath);

  async function ensureAuthority(context?: any) : Promise<any> {
    context.check();
    assertSafeDirectoryAncestry(rootPath);
    try {
      const existing: any = openAuthorityDatabase(rootPath, { create: false });
      if (existing) {
        existing.close();
        return;
      }
    } catch (error: any) {
      if (error?.code !== "storage_manifest_index_incomplete") throw error;
    }
    await withInitializationLock(rootPath, context, async () : Promise<any> => {
      const db: any = openAuthorityDatabase(rootPath, { create: true });
      db.close();
    });
  }

  async function readSnapshot(kind?: any, context?: any) : Promise<any> {
    context.check();
    assertSafeDirectoryAncestry(rootPath);
    let db: any = openAuthorityDatabase(rootPath, { create: false });
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
      const meta: any = metaRows(db);
      const pointer: any = pointerFromMeta(meta, kind);
      if (pointer.setRevision === 0) {
        return Object.freeze({ pointer, entries: Object.freeze([]) });
      }
      const rows: any = db.prepare(`
        SELECT v.service_id,v.service_revision,v.manifest_digest,
               b.bytes,b.byte_size
        FROM manifest_service_versions AS v
        JOIN manifest_blobs AS b ON b.digest=v.manifest_digest
        WHERE v.valid_from_revision<=?
          AND (v.valid_to_revision=0 OR v.valid_to_revision>?)
        ORDER BY v.service_id ASC
      `).all(pointer.setRevision, pointer.setRevision);
      if (rows.length > context.budget.maxServices) {
        throw serviceManifestError(
          "storage_manifest_budget_exceeded",
          "Service manifest service count exceeds its resource budget."
        );
      }
      const entries: any = rows.map((row?: any) : any => {
        const bytes: any = Buffer.from(row.bytes);
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
          serviceId: String(row.service_id),
          serviceRevision: Number(row.service_revision),
          manifestDigest: String(row.manifest_digest),
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
  }: Record<string, any>, context?: any) : Promise<any> {
    await ensureAuthority(context);
    const db: any = openAuthorityDatabase(rootPath, { create: false });
    try {
      try {
        return db.transaction(() : any => {
          context.check();
          const existingRequest: any = outcomeFromRow(db.prepare(`
          SELECT * FROM manifest_requests WHERE request_digest=?
        `).get(requestDigest));
        const input: Record<string, any> = {
          serviceId,
          manifestDigest,
          expectedServiceRevision,
          expectedSetRevision
        };
        if (existingRequest) {
          assertRequestMatches(existingRequest, input);
          return Object.freeze({
            outcome: existingRequest,
            replayed: true,
            changed: false
          });
        }
        const meta: any = metaRows(db);
        const candidate: any = pointerFromMeta(meta, "candidate");
        const published: any = pointerFromMeta(meta, "published");
        const existingService: any = db.prepare(`
          SELECT service_revision,manifest_digest
          FROM manifest_services
          WHERE service_id=?
        `).get(serviceId);
        const actualServiceRevision: any = Number(
          existingService?.service_revision || 0
        );
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
        const unchanged: any =
          String(existingService?.manifest_digest || "") === manifestDigest;
        const serviceRevision: any = unchanged
          ? actualServiceRevision
          : actualServiceRevision + 1;
        const setRevision: any = unchanged
          ? candidate.setRevision
          : candidate.setRevision + 1;
        if (!existingService && !unchanged) {
          const serviceCount: any = numberMeta(meta, "service_count");
          if (serviceCount + 1 > context.budget.maxServices) {
            throw serviceManifestError(
              "storage_manifest_budget_exceeded",
              "Service manifest service count exceeds its resource budget."
            );
          }
        }
        let setDigest: any = candidate.setDigest;
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
          const existingBlob: any = db.prepare(`
            SELECT bytes,byte_size FROM manifest_blobs WHERE digest=?
          `).get(manifestDigest);
          if (existingBlob) {
            const existingBytes: any = Buffer.from(existingBlob.bytes);
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
        const outcome: any = requestOutcome({
          requestDigest,
          serviceId,
          manifestDigest,
          expectedServiceRevision,
          expectedSetRevision,
          serviceRevision,
          setRevision,
          setDigest
        });
        const recordBytes: any = Buffer.byteLength(stableManifestJson(outcome));
        if (recordBytes > context.budget.maxRequestBytes) {
          throw serviceManifestError(
            "storage_manifest_request_capacity_exceeded",
            "Service manifest request record exceeds its byte budget."
          );
        }
        let removed: any = 0;
        const cutoff: any = now() - REQUEST_RETENTION_MS;
        while (removed < context.budget.maxCleanupEntries) {
          const currentMeta: any = metaRows(db);
          const overCapacity: any =
            numberMeta(currentMeta, "request_count") + 1 >
              context.budget.maxRequestRecords ||
            numberMeta(currentMeta, "request_bytes") + recordBytes >
              context.budget.maxRequestBytes;
          const oldest: any = db.prepare(`
            SELECT sequence
            FROM manifest_requests
            WHERE ? OR created_at_ms<=?
            ORDER BY created_at_ms ASC,sequence ASC
            LIMIT 1
          `).get(overCapacity ? 1 : 0, cutoff);
          if (!oldest) break;
          context.inspectCleanupEntry();
          db.prepare(
            "DELETE FROM manifest_requests WHERE sequence=?"
          ).run(oldest.sequence);
          removed += 1;
        }
        const capacity: any = metaRows(db);
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
      } catch (error: any) {
        if (error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
          const candidate: any = pointerFromMeta(metaRows(db), "candidate");
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

  async function acknowledgePublished({ setRevision, setDigest }: Record<string, any>, context?: any) : Promise<any> {
    await ensureAuthority(context);
    const db: any = openAuthorityDatabase(rootPath, { create: false });
    try {
      return db.transaction(() : any => {
        context.check();
        const meta: any = metaRows(db);
        const candidate: any = pointerFromMeta(meta, "candidate");
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
        const obsolete: any = db.prepare(`
          SELECT service_id,valid_from_revision,manifest_digest
          FROM manifest_service_versions
          WHERE valid_to_revision<>0 AND valid_to_revision<=?
          ORDER BY valid_to_revision ASC,service_id ASC
          LIMIT ?
        `).all(setRevision, context.budget.maxCleanupEntries);
        for (const row of obsolete) {
          context.inspectCleanupEntry();
          db.prepare(`
            DELETE FROM manifest_service_versions
            WHERE service_id=? AND valid_from_revision=?
          `).run(row.service_id, row.valid_from_revision);
          const retained: any = db.prepare(`
            SELECT 1 FROM manifest_service_versions
            WHERE manifest_digest=?
            LIMIT 1
          `).get(row.manifest_digest);
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
