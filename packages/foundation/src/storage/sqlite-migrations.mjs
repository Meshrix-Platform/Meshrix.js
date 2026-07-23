/**
 * sqlite-migrations.mjs
 *
 * Lightweight schema migration runner for SQLite (better-sqlite3).
 *
 * Usage:
 *   import { runMigrations } from "./sqlite-migrations.mjs";
 *
 *   runMigrations(db, [
 *     { version: 1, up: (db) => db.exec("ALTER TABLE foo ADD COLUMN bar TEXT NOT NULL DEFAULT ''") },
 *     { version: 2, up: (db) => db.exec("CREATE INDEX IF NOT EXISTS ...") },
 *   ]);
 *
 * Migrations run inside a single transaction. The current schema version is
 * stored in SQLite's built-in PRAGMA user_version so no extra bookkeeping
 * table is required.
 */

/**
 * @param {import("better-sqlite3").Database} db
 * @param {Array<{ version: number; up: (db: import("better-sqlite3").Database) => void }>} migrations
 *   Must be sorted ascending by version, starting at version 1.
 */
export function runMigrations(db, migrations) {
  if (!migrations || migrations.length === 0) {
    return;
  }

  // Read the current schema version (0 = fresh database).
  const { user_version: currentVersion } = db.pragma("user_version", { simple: true })
    ? { user_version: db.pragma("user_version", { simple: true }) }
    : { user_version: 0 };

  const pending = migrations
    .slice()
    .sort((a, b) => a.version - b.version)
    .filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    return;
  }

  const highestVersion = pending[pending.length - 1].version;

  db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
    }
    // PRAGMA cannot be parameterized — version is a trusted integer.
    db.pragma(`user_version = ${highestVersion}`);
  })();
}
