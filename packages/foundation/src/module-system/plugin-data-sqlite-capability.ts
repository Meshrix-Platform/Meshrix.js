import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openSqliteDatabase } from "../storage/sqlite-database.ts";

import { ensurePrivateSqliteLocation, withPrivateFileCreationMask } from "../storage/private-sqlite.ts";

const HOST_SQLITE_DIRECTORY: any = ".__host_sqlite__";
const DATABASE_FILE: any = "state.sqlite";
const MAX_RECOVERY_CANDIDATE_BYTES: any = 1024 * 1024 * 1024;
const activeFacadeCounts: any = new Map<any, any>();
const PRAGMA_NAMES: any = new Set<any>([
  "application_id", "busy_timeout", "cache_size", "foreign_key_check", "foreign_keys",
  "journal_mode", "journal_size_limit", "mmap_size", "page_count", "page_size",
  "quick_check", "synchronous", "trusted_schema", "user_version", "wal_autocheckpoint",
  "wal_checkpoint"
]);
const FORBIDDEN_SQL: any[] = [
  /\b(?:attach|detach)\b/iu,
  /\bvacuum\b/iu,
  /\bdatabase_list\b/iu,
  /\bpragma\b/iu,
  /\bpragma_[a-z0-9_]+\s*\(/iu,
  /\b(?:readfile|writefile|load_extension)\s*\(/iu
];

function sqliteCapabilityError(error?: any) : any {
  const nativeCode: any = String(error?.code || "");
  const sanitized: Error & Record<string, any> = new Error("Plugin SQLite operation did not complete.");
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

function denyPolicy() : any {
  const error: Error & Record<string, any> = new Error("Plugin SQLite statement is not permitted.");
  error.code = "PLUGIN_SQLITE_POLICY_DENIED";
  throw error;
}

function allowedSql(sql?: any) : any {
  const text: any = String(sql || "").trim();
  if (!text || FORBIDDEN_SQL.some((pattern?: any) : any => pattern.test(text))) denyPolicy();
  return text;
}

function allowedPragma(source?: any) : any {
  const text: any = String(source || "").trim();
  const match: any = /^([a-z_]+)(?:\s*=\s*[-a-z0-9_]+|\s*\(\s*(?:passive|full|restart|truncate)\s*\))?$/iu.exec(text);
  if (!match || !PRAGMA_NAMES.has(match[1].toLowerCase())) denyPolicy();
  return text;
}

function fileBytes(filePath?: any) : any {
  try { return fs.statSync(filePath).size; } catch (error: any) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

function createSqliteFacade(root?: any, databasePath?: any, { trackAuthority = true }: Record<string, any> = {}) : any {
  if (trackAuthority) {
    activeFacadeCounts.set(databasePath, Number(activeFacadeCounts.get(databasePath) || 0) + 1);
  }
  let database: any;
  try {
    database = withPrivateFileCreationMask(() : any => openSqliteDatabase(databasePath));
  } catch (error: any) {
    if (trackAuthority) {
      const remaining: any = Math.max(0, Number(activeFacadeCounts.get(databasePath) || 0) - 1);
      if (remaining === 0) activeFacadeCounts.delete(databasePath);
      else activeFacadeCounts.set(databasePath, remaining);
    }
    throw error;
  }
  let closed: any = false;

  function releaseAuthority() : any {
    if (!trackAuthority) return;
    const remaining: any = Math.max(0, Number(activeFacadeCounts.get(databasePath) || 0) - 1);
    if (remaining === 0) activeFacadeCounts.delete(databasePath);
    else activeFacadeCounts.set(databasePath, remaining);
  }

  function secureFiles() : any {
    ensurePrivateSqliteLocation(databasePath);
  }

  function invoke(callback?: any) : any {
    if (closed || !database.open) throw sqliteCapabilityError();
    try {
      const result: any = callback();
      secureFiles();
      return result;
    } catch (error: any) {
      throw sqliteCapabilityError(error);
    }
  }

  const facade: any = Object.create(null);
  Object.defineProperties(facade, {
    prepare: { enumerable: false, value(sql?: any) : any {
      const statement: any = invoke(() : any => database.prepare(allowedSql(sql)));
      return Object.freeze({
        get: (...parameters: any[]) : any => invoke(() : any => statement.get(...parameters)),
        all: (...parameters: any[]) : any => invoke(() : any => statement.all(...parameters)),
        run: (...parameters: any[]) : any => invoke(() : any => statement.run(...parameters)),
        iterate: (...parameters: any[]) : any => {
          const iterator: any = invoke(() : any => statement.iterate(...parameters));
          return Object.freeze({
            [Symbol.iterator]() : any { return this; },
            next: () : any => invoke(() : any => iterator.next()),
            return: () : any => invoke(() : any => (
              typeof iterator.return === "function" ? iterator.return() : { done: true }
            ))
          });
        }
      });
    } },
    exec: { enumerable: false, value(sql?: any) : any { return invoke(() : any => database.exec(allowedSql(sql))); } },
    pragma: { enumerable: false, value(source?: any, options?: any) : any {
      return invoke(() : any => database.pragma(allowedPragma(source), options));
    } },
    serialize: { enumerable: false, value() : any {
      return invoke(() : any => Object.freeze({
        byteLength: fileBytes(databasePath),
        walBytes: fileBytes(`${databasePath}-wal`),
        fullSnapshotWrites: 0
      }));
    } },
    close: { enumerable: false, value() : any {
      if (closed) return;
      try {
        database.close();
        secureFiles();
      } catch (error: any) {
        throw sqliteCapabilityError(error);
      } finally {
        closed = true;
        releaseAuthority();
      }
    } },
    open: { enumerable: false, get() : any { return !closed && database.open; } },
    inTransaction: { enumerable: false, get() : any { return !closed && database.inTransaction; } }
  });
  return Object.freeze(facade);
}

export function createPluginDataSqliteFacade(root?: any) : any {
  const directory: any = path.join(root, HOST_SQLITE_DIRECTORY);
  try { fs.mkdirSync(directory, { recursive: false, mode: 0o700 }); } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  const directoryStat: any = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) denyPolicy();
  const relative: any = path.relative(fs.realpathSync(root), fs.realpathSync(directory));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) denyPolicy();
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const databasePath: any = ensurePrivateSqliteLocation(path.join(directory, DATABASE_FILE));
  return createSqliteFacade(root, databasePath);
}

export function replacePluginDataSqliteCandidate(root?: any, candidateImage?: any, validateCandidate?: any) : any {
  const candidate: any = Buffer.from(candidateImage || []);
  if (
    candidate.length < 100 ||
    candidate.length > MAX_RECOVERY_CANDIDATE_BYTES ||
    !candidate.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "utf8")) ||
    typeof validateCandidate !== "function"
  ) {
    denyPolicy();
  }
  const directory: any = path.join(root, HOST_SQLITE_DIRECTORY);
  const directoryStat: any = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) denyPolicy();
  const databasePath: any = ensurePrivateSqliteLocation(path.join(directory, DATABASE_FILE));
  if (Number(activeFacadeCounts.get(databasePath) || 0) > 0) {
    throw Object.assign(new Error("Plugin SQLite authority is already open."), {
      code: "PLUGIN_SQLITE_BUSY"
    });
  }
  const candidatePath: any = ensurePrivateSqliteLocation(path.join(directory, `.candidate-${randomUUID()}`));
  const backupPath: any = path.join(directory, `.previous-${randomUUID()}`);
  let candidateFacade: any = null;
  let movedPrevious: any = false;
  let committed: any = false;
  try {
    withPrivateFileCreationMask(() : any => {
      const descriptor: any = fs.openSync(candidatePath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, candidate);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    });
    candidateFacade = createSqliteFacade(root, candidatePath, { trackAuthority: false });
    const quickCheck: any = candidateFacade.pragma("quick_check");
    const quickCheckOk: any = quickCheck.length === 1 && (Object.values(quickCheck[0]) as any[]).at(0) === "ok";
    if (!quickCheckOk || validateCandidate(candidateFacade) !== true) denyPolicy();
    candidateFacade.close();
    candidateFacade = null;
    for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
      try { fs.rmSync(sidecar); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
    if (fs.existsSync(databasePath)) {
      fs.renameSync(databasePath, backupPath);
      movedPrevious = true;
    }
    fs.renameSync(candidatePath, databasePath);
    committed = true;
    ensurePrivateSqliteLocation(databasePath);
    try {
      const directoryDescriptor: any = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } catch { /* The atomic rename is already committed on filesystems without directory fsync. */ }
    if (movedPrevious) {
      try { fs.rmSync(backupPath, { force: true }); } catch { /* The committed candidate remains authoritative. */ }
    }
    return Object.freeze({ replaced: true, candidateBytes: candidate.length, metadataOnly: true });
  } catch (error: any) {
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

export function isHostPluginDataResource(name?: any) : any {
  return String(name || "") === HOST_SQLITE_DIRECTORY;
}
