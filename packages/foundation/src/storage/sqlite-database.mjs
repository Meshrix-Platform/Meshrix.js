import Database from "better-sqlite3";

/**
 * The single driver-construction boundary for SQLite-backed capabilities.
 * Callers own schema, transactions and lifecycle; Foundation owns the native
 * driver dependency and creation semantics.
 */
export function openSqliteDatabase(filename, options = undefined) {
  if (typeof filename !== "string" || filename.trim().length === 0) {
    throw new TypeError("SQLite database filename is required.");
  }
  return new Database(filename, options);
}
