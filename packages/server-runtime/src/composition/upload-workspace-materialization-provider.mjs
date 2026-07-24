import crypto from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import { queueStateMutation } from "#meshrix/state-coordinator";
import { ensurePrivateDir } from "#meshrix/foundation/storage/private-file-atomic";
import { ensurePrivateSqliteLocation } from "#meshrix/foundation/storage/private-sqlite";
import {
  copyStableRegularFile,
  inspectStableFile,
  openRegularFile,
  statSignature
} from "#meshrix/foundation/storage/storage-file-safety";
import { createUploadWorkspaceMaterialization, materializationFailureDisposition } from "../jobs/upload-workspace-materialization.mjs";

const DEFINITION_ID = "queue.jobs.upload-workspace-materialization";
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETAINED = 4096;
const DEFAULT_RETAINED_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_ACTIVE_SCOPE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MATERIALIZATION_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MATERIALIZATION_REQUEST_BYTES = 512 * 1024 * 1024;
const MAX_MATERIALIZATION_FILES = 256;
const MAX_PRUNE_PER_ADMISSION = 32;
const MATERIALIZATION_CUSTODY_DIRECTORY = "upload-workspace-materialization";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function materializationError(code, message, statusCode = 500) {
  return Object.assign(new Error(message), { code, statusCode });
}

function positiveSafeInteger(value, fallback) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function custodyDirectoryName(requestRef) {
  return sha256(String(requestRef || "")).slice(0, 40);
}

function custodyFileName(input = {}) {
  return `${sha256(String(input.sourcePath || "")).slice(0, 24)}-${String(input.contentSha256 || "").slice(0, 64)}.blob`;
}

function resolveCustodyPath(custodyRoot, relativePath) {
  const resolvedRoot = path.resolve(custodyRoot);
  const resolved = path.resolve(resolvedRoot, String(relativePath || ""));
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw materializationError(
      "materialization_custody_path_invalid",
      "Materialization custody path is invalid."
    );
  }
  return resolved;
}

function custodyRelativePath(requestRef, input) {
  return path.join(custodyDirectoryName(requestRef), custodyFileName(input));
}

function ensureCustodyRoot(userDataPath) {
  const jobsRoot = path.join(userDataPath, "jobs");
  const custodyParent = path.join(userDataPath, "custody");
  const custodyRoot = path.join(
    custodyParent,
    MATERIALIZATION_CUSTODY_DIRECTORY
  );
  ensurePrivateDir(jobsRoot);
  ensurePrivateDir(custodyParent);
  ensurePrivateDir(custodyRoot);
  return { jobsRoot, custodyRoot };
}

function assertCustodyBuffer(buffer, { byteSize, contentSha256 } = {}) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length !== Number(byteSize) ||
    sha256(buffer) !== String(contentSha256 || "")
  ) {
    throw materializationError(
      "materialization_upload_digest_mismatch",
      "Immutable upload custody no longer matches its receipt."
    );
  }
  return buffer;
}

function createCustodyContentHandle(custodyRoot, entry = {}) {
  const absolutePath = resolveCustodyPath(custodyRoot, entry.custody_rel_path);
  const byteSize = Number(entry.byte_size);
  const contentSha256 = String(entry.content_sha256 || "");
  return Object.freeze({
    byteLength: byteSize,
    contentSha256,
    async read() {
      const { handle, stat: before } = await openRegularFile(absolutePath);
      try {
        const buffer = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        if (statSignature(before) !== statSignature(after)) {
          throw materializationError(
            "materialization_custody_changed",
            "Immutable upload custody changed while it was being read."
          );
        }
        return assertCustodyBuffer(buffer, { byteSize, contentSha256 });
      } finally {
        await handle.close().catch(() => {});
      }
    }
  });
}

function fenced(message = "materialization_fenced") {
  return Object.assign(new Error(message), { code: "materialization_fenced" });
}

function ensureMaterializationRequestColumns(db) {
  const columns = new Set(
    db.prepare("PRAGMA table_info(materialization_requests)").all().map((row) => row.name)
  );
  if (!columns.has("scope_ref")) {
    db.exec("ALTER TABLE materialization_requests ADD COLUMN scope_ref TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has("input_bytes")) {
    db.exec("ALTER TABLE materialization_requests ADD COLUMN input_bytes INTEGER NOT NULL DEFAULT 0");
  }
}

function backfillMaterializationRequestInputBytes(db) {
  db.exec(`
    UPDATE materialization_requests
    SET input_bytes = (
      SELECT COALESCE(SUM(byte_size), 0)
      FROM materialization_inputs
      WHERE request_ref = materialization_requests.request_ref
    )
    WHERE input_bytes = 0
      AND EXISTS (
        SELECT 1
        FROM materialization_inputs
        WHERE request_ref = materialization_requests.request_ref
      )
  `);
}

function ensureMaterializationInputColumns(db, custodyRoot) {
  const columns = new Set(
    db.prepare("PRAGMA table_info(materialization_inputs)").all().map((row) => row.name)
  );
  if (!columns.has("custody_rel_path")) {
    db.exec("ALTER TABLE materialization_inputs ADD COLUMN custody_rel_path TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has("content")) {
    return;
  }
  const rows = db.prepare(`
    SELECT request_ref, source_path, content_sha256, byte_size, content, custody_rel_path
    FROM materialization_inputs
  `).all();
  const updateCustodyPath = db.prepare(`
    UPDATE materialization_inputs
    SET custody_rel_path = ?
    WHERE request_ref = ? AND source_path = ?
  `);
  for (const row of rows) {
    if (String(row.custody_rel_path || "").trim()) {
      continue;
    }
    const buffer = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content || "");
    const input = {
      sourcePath: row.source_path,
      contentSha256: row.content_sha256,
      byteSize: row.byte_size
    };
    const relativePath = custodyRelativePath(row.request_ref, input);
    const absolutePath = resolveCustodyPath(custodyRoot, relativePath);
    ensurePrivateDir(path.dirname(absolutePath));
    if (!fsNative.existsSync(absolutePath)) {
      fsNative.writeFileSync(absolutePath, buffer, { mode: 0o600 });
    }
    updateCustodyPath.run(relativePath, row.request_ref, row.source_path);
  }
  db.exec(`
    CREATE TABLE materialization_inputs_migrated (
      request_ref TEXT NOT NULL,
      source_path TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      custody_rel_path TEXT NOT NULL,
      PRIMARY KEY(request_ref, source_path),
      FOREIGN KEY(request_ref) REFERENCES materialization_requests(request_ref) ON DELETE CASCADE
    );
    INSERT INTO materialization_inputs_migrated (
      request_ref, source_path, content_sha256, byte_size, custody_rel_path
    )
    SELECT request_ref, source_path, content_sha256, byte_size, custody_rel_path
    FROM materialization_inputs;
    DROP TABLE materialization_inputs;
    ALTER TABLE materialization_inputs_migrated RENAME TO materialization_inputs;
  `);
}

export function createUploadWorkspaceMaterializationTransactionStore({
  userDataPath,
  leaseMs = DEFAULT_LEASE_MS,
  maxRetained = DEFAULT_RETAINED,
  maxRetainedBytes = DEFAULT_RETAINED_BYTES,
  maxActiveScopeBytes = DEFAULT_ACTIVE_SCOPE_BYTES,
  terminalRetentionMs = DEFAULT_TERMINAL_RETENTION_MS,
  now = Date.now
}) {
  const { jobsRoot: root, custodyRoot } = ensureCustodyRoot(userDataPath);
  const file = path.join(root, "upload-workspace-materialization.sqlite");
  ensurePrivateSqliteLocation(file);
  const db = openSqliteDatabase(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS materialization_requests (
    request_ref TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL,
    owner_fence TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
    request_json TEXT NOT NULL, snapshot_json TEXT, result_json TEXT,
    workspace_revision TEXT NOT NULL DEFAULT '', checkpoint_refs_json TEXT NOT NULL DEFAULT '[]',
    scope_ref TEXT NOT NULL DEFAULT '', input_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL)`);
  ensureMaterializationRequestColumns(db);
  db.exec(`CREATE TABLE IF NOT EXISTS materialization_inputs (
    request_ref TEXT NOT NULL,
    source_path TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    custody_rel_path TEXT NOT NULL,
    PRIMARY KEY(request_ref, source_path),
    FOREIGN KEY(request_ref) REFERENCES materialization_requests(request_ref) ON DELETE CASCADE
  )`);
  ensureMaterializationInputColumns(db, custodyRoot);
  backfillMaterializationRequestInputBytes(db);
  db.exec(`CREATE TABLE IF NOT EXISTS materialization_capacity (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    request_count INTEGER NOT NULL CHECK(request_count>=0),
    input_bytes INTEGER NOT NULL CHECK(input_bytes>=0)
  )`);
  if (!db.prepare("SELECT 1 FROM materialization_capacity WHERE singleton=1").get()) {
    db.prepare(`INSERT INTO materialization_capacity(singleton,request_count,input_bytes)
      SELECT 1,
        (SELECT COUNT(*) FROM materialization_requests),
        (SELECT COALESCE(SUM(byte_size),0) FROM materialization_inputs)
    `).run();
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS materialization_capacity_request_insert
    AFTER INSERT ON materialization_requests
    BEGIN
      UPDATE materialization_capacity
      SET request_count=request_count+1
      WHERE singleton=1;
    END;
    CREATE TRIGGER IF NOT EXISTS materialization_capacity_request_delete
    AFTER DELETE ON materialization_requests
    BEGIN
      UPDATE materialization_capacity
      SET request_count=request_count-1
      WHERE singleton=1;
    END;
    CREATE TRIGGER IF NOT EXISTS materialization_capacity_input_insert
    AFTER INSERT ON materialization_inputs
    BEGIN
      UPDATE materialization_capacity
      SET input_bytes=input_bytes+NEW.byte_size
      WHERE singleton=1;
    END;
    CREATE TRIGGER IF NOT EXISTS materialization_capacity_input_delete
    AFTER DELETE ON materialization_inputs
    BEGIN
      UPDATE materialization_capacity
      SET input_bytes=input_bytes-OLD.byte_size
      WHERE singleton=1;
    END`);
  db.exec(`CREATE TABLE IF NOT EXISTS materialization_scope_capacity (
    scope_ref TEXT PRIMARY KEY,
    active_bytes INTEGER NOT NULL CHECK(active_bytes>=0)
  )`);
  if (!db.prepare("SELECT 1 FROM materialization_scope_capacity LIMIT 1").get()) {
    db.exec(`INSERT INTO materialization_scope_capacity(scope_ref,active_bytes)
      SELECT scope_ref,COALESCE(SUM(input_bytes),0)
      FROM materialization_requests
      WHERE scope_ref != '' AND status IN ('queued','running')
      GROUP BY scope_ref`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS materialization_scope_request_insert
    AFTER INSERT ON materialization_requests
    WHEN NEW.scope_ref != '' AND NEW.status IN ('queued','running')
    BEGIN
      INSERT INTO materialization_scope_capacity(scope_ref,active_bytes)
      VALUES(NEW.scope_ref,NEW.input_bytes)
      ON CONFLICT(scope_ref) DO UPDATE SET active_bytes=active_bytes+NEW.input_bytes;
    END;
    CREATE TRIGGER IF NOT EXISTS materialization_scope_request_delete
    AFTER DELETE ON materialization_requests
    WHEN OLD.scope_ref != '' AND OLD.status IN ('queued','running')
    BEGIN
      UPDATE materialization_scope_capacity
      SET active_bytes=active_bytes-OLD.input_bytes
      WHERE scope_ref=OLD.scope_ref;
      DELETE FROM materialization_scope_capacity
      WHERE scope_ref=OLD.scope_ref AND active_bytes=0;
    END;
    CREATE TRIGGER IF NOT EXISTS materialization_scope_request_leave_active
    AFTER UPDATE OF status,input_bytes,scope_ref ON materialization_requests
    WHEN OLD.scope_ref != '' AND OLD.status IN ('queued','running')
    BEGIN
      UPDATE materialization_scope_capacity
      SET active_bytes=active_bytes-OLD.input_bytes
      WHERE scope_ref=OLD.scope_ref;
      DELETE FROM materialization_scope_capacity
      WHERE scope_ref=OLD.scope_ref AND active_bytes=0;
    END;
    CREATE TRIGGER IF NOT EXISTS materialization_scope_request_enter_active
    AFTER UPDATE OF status,input_bytes,scope_ref ON materialization_requests
    WHEN NEW.scope_ref != '' AND NEW.status IN ('queued','running')
    BEGIN
      INSERT INTO materialization_scope_capacity(scope_ref,active_bytes)
      VALUES(NEW.scope_ref,NEW.input_bytes)
      ON CONFLICT(scope_ref) DO UPDATE SET active_bytes=active_bytes+NEW.input_bytes;
    END`);
  const read = db.prepare("SELECT * FROM materialization_requests WHERE request_ref=?");
  const readInputs = db.prepare("SELECT source_path,content_sha256,byte_size,custody_rel_path FROM materialization_inputs WHERE request_ref=? ORDER BY source_path ASC");
  const hydrate = (row) => row ? {
    ...JSON.parse(row.request_json), status: row.status, stage: row.stage,
    snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    workspaceRevision: row.workspace_revision || "",
    checkpointRefs: JSON.parse(row.checkpoint_refs_json || "[]")
  } : null;
  const timestamp = () => new Date(now()).toISOString();
  const requireChange = (changes) => { if (!changes) throw fenced(); };
  const updateOwned = (sql, params) => {
    const current = now();
    requireChange(db.prepare(sql).run(...params(current), current).changes);
  };
  let createTail = Promise.resolve();
  const serializeCreate = (task) => {
    const result = createTail.then(task, task);
    createTail = result.catch(() => {});
    return result;
  };
  const removeCustody = async (requestRef) => {
    const directory = resolveCustodyPath(custodyRoot, custodyDirectoryName(requestRef));
    await fs.rm(directory, { recursive: true, force: true });
  };
  const pruneForCapacity = async (incomingBytes, scopeRef) => {
    const retained = Math.min(
      DEFAULT_RETAINED,
      positiveSafeInteger(maxRetained, DEFAULT_RETAINED)
    );
    const retainedBytes = Math.min(
      DEFAULT_RETAINED_BYTES,
      positiveSafeInteger(maxRetainedBytes, DEFAULT_RETAINED_BYTES)
    );
    const activeScopeBytes = Math.min(
      DEFAULT_ACTIVE_SCOPE_BYTES,
      positiveSafeInteger(maxActiveScopeBytes, DEFAULT_ACTIVE_SCOPE_BYTES)
    );
    const retentionMs = Math.min(
      DEFAULT_TERMINAL_RETENTION_MS,
      positiveSafeInteger(terminalRetentionMs, DEFAULT_TERMINAL_RETENTION_MS)
    );
    if (incomingBytes > retainedBytes) {
      throw materializationError(
        "materialization_custody_capacity_exceeded",
        "Materialization custody capacity is insufficient for this request.",
        503
      );
    }
    const scopeCapacity = db.prepare(
      "SELECT active_bytes FROM materialization_scope_capacity WHERE scope_ref=?"
    ).get(scopeRef);
    if (Number(scopeCapacity?.active_bytes || 0) + incomingBytes > activeScopeBytes) {
      throw materializationError(
        "materialization_scope_capacity_exceeded",
        "Materialization custody capacity is currently full for this scope.",
        503
      );
    }
    const capacity = db.prepare(
      "SELECT request_count,input_bytes FROM materialization_capacity WHERE singleton=1"
    ).get();
    let totalCount = Number(capacity.request_count);
    let totalBytes = Number(capacity.input_bytes);
    const removable = db.prepare(`
      SELECT r.request_ref,r.updated_at,COALESCE(SUM(i.byte_size),0) AS bytes
      FROM materialization_requests r
      LEFT JOIN materialization_inputs i ON i.request_ref=r.request_ref
      WHERE r.status IN ('completed','failed','cancelled')
        AND r.stage NOT IN ('effects_committed_retry_exhausted','evidence_completed_retry_exhausted')
      GROUP BY r.request_ref
      ORDER BY r.updated_at ASC,r.request_ref ASC
      LIMIT ?
    `).all(MAX_PRUNE_PER_ADMISSION);
    const expiresBefore = new Date(now() - retentionMs).toISOString();
    for (const entry of removable) {
      const capacityAvailable =
        totalCount < retained &&
        totalBytes + incomingBytes <= retainedBytes;
      const expired = entry.updated_at <= expiresBefore;
      const retainedCustodyBytes = Number(entry.bytes || 0);
      if (capacityAvailable && !expired && retainedCustodyBytes === 0) break;
      await removeCustody(entry.request_ref);
      if (retainedCustodyBytes > 0) {
        db.prepare("DELETE FROM materialization_inputs WHERE request_ref=?").run(entry.request_ref);
        totalBytes -= retainedCustodyBytes;
      }
      if (
        expired ||
        totalCount >= retained ||
        totalBytes + incomingBytes > retainedBytes
      ) {
        db.prepare("DELETE FROM materialization_requests WHERE request_ref=?").run(entry.request_ref);
        totalCount -= 1;
      }
    }
    if (totalCount >= retained || totalBytes + incomingBytes > retainedBytes) {
      throw materializationError(
        "materialization_custody_capacity_exceeded",
        "Materialization custody capacity is currently full.",
        503
      );
    }
  };
  const persistInput = async (requestRef, input) => {
    const relativePath = custodyRelativePath(requestRef, input);
    const absolutePath = resolveCustodyPath(custodyRoot, relativePath);
    ensurePrivateDir(path.dirname(absolutePath));
    try {
      const existing = await inspectStableFile(absolutePath, {
        changedCode: "materialization_custody_changed"
      });
      if (
        existing.bytes !== Number(input.byteSize) ||
        existing.sha256 !== String(input.contentSha256 || "")
      ) {
        throw materializationError(
          "materialization_upload_digest_mismatch",
          "Existing immutable custody does not match the upload receipt."
        );
      }
      return relativePath;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.cause?.code !== "ENOENT") {
        throw error;
      }
    }
    const sourcePath = String(input.stagedPath || input.sourceFilePath || "").trim();
    if (!sourcePath) {
      throw materializationError(
        "materialization_custody_source_required",
        "Materialization custody requires a staged source file."
      );
    }
    try {
      await copyStableRegularFile({
        sourcePath,
        targetPath: absolutePath,
        expectedBytes: Number(input.byteSize),
        expectedSha256: String(input.contentSha256 || "")
      });
    } catch (error) {
      if (error?.code === "EEXIST" || error?.cause?.code === "EEXIST") {
        const existing = await inspectStableFile(absolutePath, {
          changedCode: "materialization_custody_changed"
        });
        if (
          existing.bytes === Number(input.byteSize) &&
          existing.sha256 === String(input.contentSha256 || "")
        ) {
          return relativePath;
        }
      }
      throw materializationError(
        "materialization_upload_digest_mismatch",
        "Upload content could not be copied into immutable custody."
      );
    }
    return relativePath;
  };
  const releaseCustodyInputs = async (requestRef) => {
    await removeCustody(requestRef);
    db.prepare("DELETE FROM materialization_inputs WHERE request_ref=?").run(requestRef);
  };
  return Object.freeze({
    async create(value, { inputs = [] } = {}) {
      return serializeCreate(async () => {
        if (read.get(value.requestRef)) return { inserted: false };
        if (inputs.length > MAX_MATERIALIZATION_FILES) {
          throw materializationError(
            "materialization_custody_file_limit_exceeded",
            "Materialization custody contains too many files.",
            413
          );
        }
        const incomingBytes = inputs.reduce((total, input) => {
          const byteSize = Number(input.byteSize);
          if (
            !Number.isSafeInteger(byteSize) ||
            byteSize < 0 ||
            byteSize > MAX_MATERIALIZATION_FILE_BYTES
          ) {
            throw materializationError(
              "materialization_custody_size_invalid",
              "Materialization custody byte size is invalid.",
              413
            );
          }
          return total + byteSize;
        }, 0);
        if (incomingBytes > MAX_MATERIALIZATION_REQUEST_BYTES) {
          throw materializationError(
            "materialization_custody_request_limit_exceeded",
            "Materialization custody exceeds the per-request byte limit.",
            413
          );
        }
        const scopeRef = String(value.binding?.subjectRef || sha256(
          `materialization-scope:${value.requestRef}`
        ));
        await pruneForCapacity(incomingBytes, scopeRef);
        const persistedInputs = [];
        try {
          for (const input of inputs) {
            persistedInputs.push({
              ...input,
              custodyRelativePath: await persistInput(value.requestRef, input)
            });
          }
          const insertRequest = db.prepare("INSERT OR IGNORE INTO materialization_requests(request_ref,status,stage,request_json,scope_ref,input_bytes,updated_at) VALUES(?,?,?,?,?,?,?)");
          const insertInput = db.prepare("INSERT INTO materialization_inputs(request_ref,source_path,content_sha256,byte_size,custody_rel_path) VALUES(?,?,?,?,?)");
          const inserted = db.transaction(() => {
            const created = insertRequest.run(
              value.requestRef,
              "queued",
              "admitted",
              JSON.stringify(value),
              scopeRef,
              incomingBytes,
              timestamp()
            ).changes > 0;
            if (created) {
              for (const input of persistedInputs) {
                insertInput.run(
                  value.requestRef,
                  input.sourcePath,
                  input.contentSha256,
                  input.byteSize,
                  input.custodyRelativePath
                );
              }
            }
            return created;
          })();
          return { inserted };
        } catch (error) {
          if (!read.get(value.requestRef)) await removeCustody(value.requestRef);
          throw error;
        }
      });
    },
    async get(ref) { return hydrate(read.get(ref)); },
    async getInputs(ref) {
      return readInputs.all(ref).map((entry) => ({
        sourcePath: entry.source_path,
        contentSha256: entry.content_sha256,
        byteSize: Number(entry.byte_size),
        contentHandle: createCustodyContentHandle(custodyRoot, entry)
      }));
    },
    async begin(ref, { ownerFence }) {
      const current = now();
      const row = read.get(ref);
      if (!row) throw Object.assign(new Error("materialization_request_missing"), { code: "materialization_request_missing" });
      if (row.status === "completed") return hydrate(row);
      if (["failed", "cancelled"].includes(row.status)) {
        throw Object.assign(new Error("materialization_request_terminal"), { code: "materialization_request_terminal" });
      }
      const changes = db.prepare("UPDATE materialization_requests SET status='running',owner_fence=?,lease_until=?,updated_at=? WHERE request_ref=? AND (status!='running' OR lease_until<?)")
        .run(ownerFence, current + leaseMs, timestamp(), ref, current).changes;
      requireChange(changes);
      return hydrate(read.get(ref));
    },
    async renew(ref, { ownerFence }) {
      updateOwned("UPDATE materialization_requests SET lease_until=?,updated_at=? WHERE request_ref=? AND status='running' AND owner_fence=? AND lease_until>=?", (current) => [current + leaseMs, timestamp(), ref, ownerFence]);
    },
    async assertFence(ref, { ownerFence }) {
      const row = read.get(ref);
      if (!row || row.status !== "running" || row.owner_fence !== ownerFence || Number(row.lease_until) < now()) throw fenced();
      return true;
    },
    async recordPreimage(ref, { ownerFence, snapshot }) {
      updateOwned("UPDATE materialization_requests SET stage='preimage_ready',snapshot_json=?,lease_until=?,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?", (current) => [JSON.stringify(snapshot), current + leaseMs, timestamp(), ref, ownerFence]);
    },
    async recordMutationPending(ref, { ownerFence, revision, checkpointRefs }) {
      updateOwned("UPDATE materialization_requests SET stage='mutation_pending',workspace_revision=?,checkpoint_refs_json=?,lease_until=?,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?", (current) => [revision, JSON.stringify(checkpointRefs), current + leaseMs, timestamp(), ref, ownerFence]);
    },
    async recordMutation(ref, { ownerFence, revision, checkpointRefs }) {
      updateOwned("UPDATE materialization_requests SET stage='mutation_applied',workspace_revision=?,checkpoint_refs_json=?,lease_until=?,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?", (current) => [revision, JSON.stringify(checkpointRefs), current + leaseMs, timestamp(), ref, ownerFence]);
    },
    async recordEffectsCommitted(ref, { ownerFence, revision, checkpointRefs }) {
      updateOwned("UPDATE materialization_requests SET stage='effects_committed',workspace_revision=?,checkpoint_refs_json=?,lease_until=?,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?", (current) => [revision, JSON.stringify(checkpointRefs), current + leaseMs, timestamp(), ref, ownerFence]);
    },
    async recordEvidenceCompleted(ref, { ownerFence, result }) {
      updateOwned("UPDATE materialization_requests SET stage='evidence_completed',result_json=?,lease_until=?,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?", (current) => [JSON.stringify(result), current + leaseMs, timestamp(), ref, ownerFence]);
    },
    async complete(ref, { ownerFence, result }) {
      const current = now();
      requireChange(db.prepare("UPDATE materialization_requests SET status='completed',stage='completed',result_json=?,lease_until=0,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?")
        .run(JSON.stringify(result), timestamp(), ref, ownerFence, current).changes);
      await releaseCustodyInputs(ref).catch(() => {});
    },
    async fail(ref, { ownerFence, recoverable, preserveCommitted = false }) {
      const current = now();
      const status = recoverable ? "queued" : "failed";
      const stage = preserveCommitted ? "effects_committed" : recoverable ? "admitted" : "compensation_failed";
      requireChange(db.prepare("UPDATE materialization_requests SET status=?,stage=?,owner_fence='',lease_until=0,updated_at=? WHERE request_ref=? AND owner_fence=? AND lease_until>=?")
        .run(status, stage, timestamp(), ref, ownerFence, current).changes);
      if (!recoverable) await releaseCustodyInputs(ref).catch(() => {});
    },
    async cancelOwned(ref, { ownerFence }) {
      const current = now();
      requireChange(db.prepare("UPDATE materialization_requests SET status='cancelled',stage='cancelled',owner_fence='',lease_until=0,updated_at=? WHERE request_ref=? AND status='running' AND owner_fence=? AND lease_until>=?")
        .run(timestamp(), ref, ownerFence, current).changes);
      await releaseCustodyInputs(ref).catch(() => {});
    },
    async cancelQueued(ref) {
      const changes = db.prepare("UPDATE materialization_requests SET status='cancelled',stage='cancelled',owner_fence='',lease_until=0,updated_at=? WHERE request_ref=? AND status='queued'")
        .run(timestamp(), ref).changes;
      if (changes > 0) await releaseCustodyInputs(ref).catch(() => {});
      return { cancelled: changes > 0 };
    },
    async terminalFail(ref) {
      const changes = db.prepare("UPDATE materialization_requests SET status='failed',stage=CASE stage WHEN 'effects_committed' THEN 'effects_committed_retry_exhausted' WHEN 'evidence_completed' THEN 'evidence_completed_retry_exhausted' ELSE 'retry_exhausted' END,owner_fence='',lease_until=0,updated_at=? WHERE request_ref=? AND status='queued'")
        .run(timestamp(), ref).changes;
      if (changes > 0) await releaseCustodyInputs(ref).catch(() => {});
      return { terminal: changes > 0 };
    },
    count() { return Number(db.prepare("SELECT COUNT(*) AS count FROM materialization_requests").get().count); },
    close() { db.close(); }
  });
}

export async function settleMaterializationQueueFailure({ transactionStore, requestRef, error, attempt, maxAttempts }) {
  const disposition = materializationFailureDisposition(error);
  const exhausted = Number(attempt || 0) >= Number(maxAttempts || 1);
  if (!disposition.retryable || exhausted) {
    await transactionStore.terminalFail(requestRef);
    return { action: "failed", reason: disposition.code };
  }
  return { action: "retry", reason: disposition.code };
}

export async function createUploadWorkspaceMaterializationProvider({ userDataPath, queueApplicationPort, agentWorkspace, uploadSessionStore, operationAuditStore, operationProofSubstrate, transactionStore = null }) {
  const store = transactionStore || createUploadWorkspaceMaterializationTransactionStore({ userDataPath });
  const ownsTransactionStore = !transactionStore;
  const access = (record) => ({ workspaceId: record.workspaceId, actorUserId: record.subject.subjectId });
  const engine = createUploadWorkspaceMaterialization({
    uploadPort: {
      async resolveCompleted({ uploadSessionId, subject }) {
        const [receipt, files] = await Promise.all([
          uploadSessionStore.buildCheckpointReceiptFromUploadSession(userDataPath, uploadSessionId, { owner: subject }),
          uploadSessionStore.resolveUploadSessionFiles(userDataPath, uploadSessionId, { owner: subject })
        ]);
        return { receipt, files };
      }
    },
    workspacePort: {
      async getRevision(record) { const value = await agentWorkspace.workspaceFileRevision(access(record)); if (!value.ok) throw new Error("workspace_revision_unavailable"); return value.revision; },
      async captureSnapshot(record) { const paths = record.targets.map((target) => target.relativePath); const value = await agentWorkspace.captureWorkspaceFileSnapshot({ ...access(record), paths, leaseGuard: record.leaseGuard }); if (!value.ok || value.snapshot?.files?.length !== paths.length) throw new Error("workspace_snapshot_unavailable"); return { complete: true, targetCount: paths.length, snapshot: value.snapshot }; },
      async applyBatch(record) {
        const value = await agentWorkspace.restoreWorkspaceFiles({
          ...access(record),
          files: record.files.map(({ target, contentHandle }) => ({
            path: target.relativePath,
            exists: true,
            contentHandle,
            contentSha256: target.contentSha256,
            byteLength: target.byteSize,
            encoding: "binary"
          })),
          deleteExtraneous: false,
          operationId: record.operationId,
          leaseGuard: record.leaseGuard
        });
        if (!value.ok) throw new Error("workspace_mutation_failed");
        return {
          beforeRoot: value.stateCommit?.beforeRoot,
          afterRoot: value.stateCommit?.afterRoot,
          checkpointRefs: [value.checkpoint?.nodeId || value.stateCommit?.eventId].filter(Boolean)
        };
      },
      async restoreSnapshot(record) { const value = await agentWorkspace.restoreWorkspaceFiles({ ...access(record), ...record.snapshot.snapshot, operationId: record.operationId, leaseGuard: record.leaseGuard, stateRootAllowedOperationIds: [`jobs.upload_workspace_materialize:${record.bindingDigest}`] }); if (!value.ok) throw Object.assign(new Error("workspace_restore_failed"), { code: value.status === 409 ? "materialization_compensation_conflict" : "workspace_restore_failed" }); },
      withMutationLock(workspaceId, task) { return queueStateMutation(`workspace-materialization:${workspaceId}`, task); }
    },
    auditPort: {
      async append(entry) {
        try { return operationAuditStore.append({ ...entry, transport: "job-worker", actor: { type: "system" } }); }
        catch (error) { if (entry.auditId && String(error?.code || "").startsWith("SQLITE_CONSTRAINT")) return { auditId: entry.auditId }; throw error; }
      }
    },
    proofPort: operationProofSubstrate,
    transactionStore: store
  });
  let closing = false;
  const queue = await queueApplicationPort.registerQueue({
    queueDefinitionId: DEFINITION_ID,
    queueDefinitionVersion: 2,
    label: "meshrix.jobs.upload-workspace-materialization",
    ownerCapability: "platform.job-workflow",
    scope: { tenantId: "platform", workspaceId: "governed" },
    workerId: "upload-workspace-materialization-worker",
    maxInFlight: 4,
    batchSize: 4,
    handler: async ({ workItem }, context) => {
      if (closing) return { action: "retry", reason: "materialization_provider_closing" };
      try {
        const ownerFence = `${workItem.workItemId}:${context.lease.leaseSeq}`;
        await engine.execute({
          requestRef: workItem.payloadRef.requestRef,
          ownerFence,
          signal: context.signal,
          renewLease: () => context.renewLease({ reason: "materialization_saga_heartbeat" })
        });
        return { action: "completed", reason: "materialization_completed" };
      } catch (error) {
        return settleMaterializationQueueFailure({ transactionStore: store, requestRef: workItem.payloadRef.requestRef, error, attempt: workItem.attempt, maxAttempts: workItem.maxAttempts });
      }
    }
  });
  return Object.freeze({
    async submit(input) {
      if (closing) throw Object.assign(new Error("materialization_provider_closing"), { code: "materialization_provider_closing" });
      const admitted = await engine.submit(input);
      const record = await engine.get(admitted.requestRef);
      if (record?.status !== "completed") {
        await queue.enqueue({ schedulingScope: { workspaceId: record.workspaceId }, dedupeKey: admitted.requestRef, workItemId: `materialization-work:${record.bindingDigest}`, payloadRef: { requestRef: admitted.requestRef }, ownerRef: { capability: "platform.job-workflow", subjectRef: record.binding.subjectRef }, payloadKind: "upload_workspace_materialization", maxAttempts: 3 });
        void queue.requestDispatch();
      }
      return admitted;
    },
    get: engine.get,
    async cancel(requestRef, { subject } = {}) {
      const record = await engine.get(requestRef);
      if (!record || !subject?.subjectId || record.subject?.subjectId !== subject.subjectId) return null;
      const publicState = (value) => Object.freeze({
        requestRef: value.requestRef,
        status: value.status,
        stage: value.stage
      });
      if (["completed", "failed", "cancelled"].includes(record.status)) return publicState(record);
      await queue.cancel({
        workItemId: `materialization-work:${record.bindingDigest}`,
        operationId: "jobs.upload_workspace_materialization_cancel",
        actor: { system: "platform-job-workflow" },
        reason: "workspace_materialization_cancelled"
      });
      await store.cancelQueued(requestRef);
      return publicState(await engine.get(requestRef));
    },
    async close() {
      if (closing) return;
      closing = true;
      await queue.close({ timeoutMs: 30_000 });
      if (ownsTransactionStore) store.close();
    }
  });
}
