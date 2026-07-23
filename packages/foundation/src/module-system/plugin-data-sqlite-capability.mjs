import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openSqliteDatabase } from "../storage/sqlite-database.mjs";

import { ensurePrivateSqliteLocation, withPrivateFileCreationMask } from "../storage/private-sqlite.mjs";

const HOST_SQLITE_DIRECTORY = ".__host_sqlite__";
const DATABASE_FILE = "state.sqlite";
const MAX_RECOVERY_CANDIDATE_BYTES = 1024 * 1024 * 1024;
const activeFacadeCounts = new Map();
const PRAGMA_NAMES = new Set([
  "application_id", "busy_timeout", "cache_size", "foreign_key_check", "foreign_keys",
  "journal_mode", "journal_size_limit", "mmap_size", "page_count", "page_size",
  "quick_check", "synchronous", "trusted_schema", "user_version", "wal_autocheckpoint",
  "wal_checkpoint"
]);
const FORBIDDEN_SQL = [
  /\b(?:attach|detach)\b/iu,
  /\bvacuum\b/iu,
  /\bdatabase_list\b/iu,
  /\bpragma\b/iu,
  /\bpragma_[a-z0-9_]+\s*\(/iu,
  /\b(?:readfile|writefile|load_extension)\s*\(/iu
];

function sqliteCapabilityError(error) {
  const nativeCode = String(error?.code || "");
  const sanitized = new Error("Plugin SQLite operation did not complete.");
  sanitized.name = "PluginSqliteOperationError";
  sanitized.code = nativeCode.startsWith("SQLITE_BUSY") || nativeCode.startsWith("SQLITE_LOCKED")
    ? "PLUGIN_SQLITE_BUSY"
    : nativeCode.startsWith("SQLITE_CONSTRAINT")
      ? "PLUGIN_SQLITE_CONSTRAINT"
      : nativeCode === "PLUGIN_SQLITE_POLICY_DENIED"
        ? nativeCode
        : "PLUGIN_SQLITE_ERROR";
  return sanitized;
}

function denyPolicy() {
  const error = new Error("Plugin SQLite statement is not permitted.");
  error.code = "PLUGIN_SQLITE_POLICY_DENIED";
  throw error;
}

function allowedSql(sql) {
  const text = String(sql || "").trim();
  if (!text || FORBIDDEN_SQL.some((pattern) => pattern.test(text))) denyPolicy();
  return text;
}

function allowedPragma(source) {
  const text = String(source || "").trim();
  const match = /^([a-z_]+)(?:\s*=\s*[-a-z0-9_]+|\s*\(\s*(?:passive|full|restart|truncate)\s*\))?$/iu.exec(text);
  if (!match || !PRAGMA_NAMES.has(match[1].toLowerCase())) denyPolicy();
  return text;
}

function fileBytes(filePath) {
  try { return fs.statSync(filePath).size; } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

function createSqliteFacade(root, databasePath, { trackAuthority = true } = {}) {
  if (trackAuthority) {
    activeFacadeCounts.set(databasePath, Number(activeFacadeCounts.get(databasePath) || 0) + 1);
  }
  let database;
  try {
    database = withPrivateFileCreationMask(() => openSqliteDatabase(databasePath));
  } catch (error) {
    if (trackAuthority) {
      const remaining = Math.max(0, Number(activeFacadeCounts.get(databasePath) || 0) - 1);
      if (remaining === 0) activeFacadeCounts.delete(databasePath);
      else activeFacadeCounts.set(databasePath, remaining);
    }
    throw error;
  }
  let closed = false;

  function releaseAuthority() {
    if (!trackAuthority) return;
    const remaining = Math.max(0, Number(activeFacadeCounts.get(databasePath) || 0) - 1);
    if (remaining === 0) activeFacadeCounts.delete(databasePath);
    else activeFacadeCounts.set(databasePath, remaining);
  }

  function secureFiles() {
    ensurePrivateSqliteLocation(databasePath);
  }

  function invoke(callback) {
    if (closed || !database.open) throw sqliteCapabilityError();
    try {
      const result = callback();
      secureFiles();
      return result;
    } catch (error) {
      throw sqliteCapabilityError(error);
    }
  }

  const facade = Object.create(null);
  Object.defineProperties(facade, {
    prepare: { enumerable: false, value(sql) {
      const statement = invoke(() => database.prepare(allowedSql(sql)));
      return Object.freeze({
        get: (...parameters) => invoke(() => statement.get(...parameters)),
        all: (...parameters) => invoke(() => statement.all(...parameters)),
        run: (...parameters) => invoke(() => statement.run(...parameters)),
        iterate: (...parameters) => {
          const iterator = invoke(() => statement.iterate(...parameters));
          return Object.freeze({
            [Symbol.iterator]() { return this; },
            next: () => invoke(() => iterator.next()),
            return: () => invoke(() => (
              typeof iterator.return === "function" ? iterator.return() : { done: true }
            ))
          });
        }
      });
    } },
    exec: { enumerable: false, value(sql) { return invoke(() => database.exec(allowedSql(sql))); } },
    pragma: { enumerable: false, value(source, options) {
      return invoke(() => database.pragma(allowedPragma(source), options));
    } },
    serialize: { enumerable: false, value() {
      return invoke(() => Object.freeze({
        byteLength: fileBytes(databasePath),
        walBytes: fileBytes(`${databasePath}-wal`),
        fullSnapshotWrites: 0
      }));
    } },
    close: { enumerable: false, value() {
      if (closed) return;
      try {
        database.close();
        secureFiles();
      } catch (error) {
        throw sqliteCapabilityError(error);
      } finally {
        closed = true;
        releaseAuthority();
      }
    } },
    open: { enumerable: false, get() { return !closed && database.open; } },
    inTransaction: { enumerable: false, get() { return !closed && database.inTransaction; } }
  });
  return Object.freeze(facade);
}

export function createPluginDataSqliteFacade(root) {
  const directory = path.join(root, HOST_SQLITE_DIRECTORY);
  try { fs.mkdirSync(directory, { recursive: false, mode: 0o700 }); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) denyPolicy();
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(directory));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) denyPolicy();
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const databasePath = ensurePrivateSqliteLocation(path.join(directory, DATABASE_FILE));
  return createSqliteFacade(root, databasePath);
}

export function replacePluginDataSqliteCandidate(root, candidateImage, validateCandidate) {
  const candidate = Buffer.from(candidateImage || []);
  if (
    candidate.length < 100 ||
    candidate.length > MAX_RECOVERY_CANDIDATE_BYTES ||
    !candidate.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "utf8")) ||
    typeof validateCandidate !== "function"
  ) {
    denyPolicy();
  }
  const directory = path.join(root, HOST_SQLITE_DIRECTORY);
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) denyPolicy();
  const databasePath = ensurePrivateSqliteLocation(path.join(directory, DATABASE_FILE));
  if (Number(activeFacadeCounts.get(databasePath) || 0) > 0) {
    throw Object.assign(new Error("Plugin SQLite authority is already open."), {
      code: "PLUGIN_SQLITE_BUSY"
    });
  }
  const candidatePath = ensurePrivateSqliteLocation(path.join(directory, `.candidate-${randomUUID()}`));
  const backupPath = path.join(directory, `.previous-${randomUUID()}`);
  let candidateFacade = null;
  let movedPrevious = false;
  let committed = false;
  try {
    withPrivateFileCreationMask(() => {
      const descriptor = fs.openSync(candidatePath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, candidate);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    });
    candidateFacade = createSqliteFacade(root, candidatePath, { trackAuthority: false });
    const quickCheck = candidateFacade.pragma("quick_check");
    const quickCheckOk = quickCheck.length === 1 && Object.values(quickCheck[0]).at(0) === "ok";
    if (!quickCheckOk || validateCandidate(candidateFacade) !== true) denyPolicy();
    candidateFacade.close();
    candidateFacade = null;
    for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
      try { fs.rmSync(sidecar); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    if (fs.existsSync(databasePath)) {
      fs.renameSync(databasePath, backupPath);
      movedPrevious = true;
    }
    fs.renameSync(candidatePath, databasePath);
    committed = true;
    ensurePrivateSqliteLocation(databasePath);
    try {
      const directoryDescriptor = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } catch { /* The atomic rename is already committed on filesystems without directory fsync. */ }
    if (movedPrevious) {
      try { fs.rmSync(backupPath, { force: true }); } catch { /* The committed candidate remains authoritative. */ }
    }
    return Object.freeze({ replaced: true, candidateBytes: candidate.length, metadataOnly: true });
  } catch (error) {
    try { candidateFacade?.close(); } catch { /* Preserve replacement failure. */ }
    if (!committed && movedPrevious && !fs.existsSync(databasePath) && fs.existsSync(backupPath)) {
      try { fs.renameSync(backupPath, databasePath); } catch { /* Preserve replacement failure. */ }
    }
    throw error;
  } finally {
    for (const temporaryPath of [candidatePath, `${candidatePath}-wal`, `${candidatePath}-shm`]) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch { /* Best-effort temporary cleanup. */ }
    }
    if (committed) {
      try { fs.rmSync(backupPath, { force: true }); } catch { /* Best-effort superseded generation cleanup. */ }
    }
  }
}

export function isHostPluginDataResource(name) {
  return String(name || "") === HOST_SQLITE_DIRECTORY;
}
