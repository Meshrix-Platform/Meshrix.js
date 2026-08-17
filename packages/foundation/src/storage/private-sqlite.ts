import fs from "node:fs";
import path from "node:path";

import { ensurePrivateDir } from "./private-file-atomic.ts";

const SQLITE_PRIVATE_SUFFIXES: readonly string[] = Object.freeze(["", "-wal", "-shm", "-journal"]);

function privateSqliteError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "private_sqlite_boundary_invalid";
  return error;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code || "") : "";
}

function enforcePrivateRegularFile(filePath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw privateSqliteError("SQLite state files must be regular non-symbolic-link files.");
  }
  fs.chmodSync(filePath, 0o600);
}

export function ensurePrivateSqliteLocation(databasePath: unknown): string {
  const resolvedPath = path.resolve(String(databasePath || ""));
  ensurePrivateDir(path.dirname(resolvedPath));
  for (const suffix of SQLITE_PRIVATE_SUFFIXES) {
    enforcePrivateRegularFile(`${resolvedPath}${suffix}`);
  }
  return resolvedPath;
}

export function withPrivateFileCreationMask<T>(task: (() => T) | undefined): T {
  if (typeof task !== "function") {
    throw new TypeError("withPrivateFileCreationMask requires a task function.");
  }
  let previousMask: number;
  try {
    previousMask = process.umask(0o077);
  } catch (error: unknown) {
    if (errorCode(error) === "ERR_WORKER_UNSUPPORTED_OPERATION") return task();
    throw error;
  }
  try {
    return task();
  } finally {
    process.umask(previousMask);
  }
}
