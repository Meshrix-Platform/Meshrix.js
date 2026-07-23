import fs from "node:fs";
import path from "node:path";

import { ensurePrivateDir } from "./private-file-atomic.mjs";

const SQLITE_PRIVATE_SUFFIXES = Object.freeze(["", "-wal", "-shm", "-journal"]);

function privateSqliteError(message) {
  const error = new Error(message);
  error.code = "private_sqlite_boundary_invalid";
  return error;
}

function enforcePrivateRegularFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw privateSqliteError("SQLite state files must be regular non-symbolic-link files.");
  }
  fs.chmodSync(filePath, 0o600);
}

export function ensurePrivateSqliteLocation(databasePath) {
  const resolvedPath = path.resolve(String(databasePath || ""));
  ensurePrivateDir(path.dirname(resolvedPath));
  for (const suffix of SQLITE_PRIVATE_SUFFIXES) {
    enforcePrivateRegularFile(`${resolvedPath}${suffix}`);
  }
  return resolvedPath;
}

export function withPrivateFileCreationMask(task) {
  if (typeof task !== "function") {
    throw new TypeError("withPrivateFileCreationMask requires a task function.");
  }
  let previousMask;
  try {
    previousMask = process.umask(0o077);
  } catch (error) {
    if (error?.code === "ERR_WORKER_UNSUPPORTED_OPERATION") return task();
    throw error;
  }
  try {
    return task();
  } finally {
    process.umask(previousMask);
  }
}
