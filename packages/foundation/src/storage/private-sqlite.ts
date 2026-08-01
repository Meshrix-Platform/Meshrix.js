import fs from "node:fs";
import path from "node:path";

import { ensurePrivateDir } from "./private-file-atomic.ts";

const SQLITE_PRIVATE_SUFFIXES: readonly any[] = Object.freeze(["", "-wal", "-shm", "-journal"]);

function privateSqliteError(message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = "private_sqlite_boundary_invalid";
  return error;
}

function enforcePrivateRegularFile(filePath?: any) : any {
  let stat: any;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw privateSqliteError("SQLite state files must be regular non-symbolic-link files.");
  }
  fs.chmodSync(filePath, 0o600);
}

export function ensurePrivateSqliteLocation(databasePath?: any) : any {
  const resolvedPath: any = path.resolve(String(databasePath || ""));
  ensurePrivateDir(path.dirname(resolvedPath));
  for (const suffix of SQLITE_PRIVATE_SUFFIXES) {
    enforcePrivateRegularFile(`${resolvedPath}${suffix}`);
  }
  return resolvedPath;
}

export function withPrivateFileCreationMask(task?: any) : any {
  if (typeof task !== "function") {
    throw new TypeError("withPrivateFileCreationMask requires a task function.");
  }
  let previousMask: any;
  try {
    previousMask = process.umask(0o077);
  } catch (error: any) {
    if (error?.code === "ERR_WORKER_UNSUPPORTED_OPERATION") return task();
    throw error;
  }
  try {
    return task();
  } finally {
    process.umask(previousMask);
  }
}
