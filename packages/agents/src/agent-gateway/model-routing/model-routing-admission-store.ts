/*
 * Model-routing admission authority.
 *
 * Slots, rate-window permits, and circuit generations live in one SQLite
 * authority and update transactionally. Admission work is one fixed set of
 * indexed statements independent of ledger history; no whole-file JSON state
 * or directory lock participates. The store is opened only after the one-way
 * migration marker exists; a failed conversion leaves the marker absent and
 * the legacy files untouched so the switch rolls back before the marker.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ServerConfig } from "@meshrix/foundation/config/server-config";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import { runMigrations } from "@meshrix/foundation/storage/sqlite-migrations";

const LEGACY_STATE_FILE: any = path.join("state", "model-routing-state.json");
const LEGACY_LEDGER_FILE: any = path.join("logs", "model-routing-ledger.jsonl");

const MODEL_ROUTING_ADMISSION_DB_RELATIVE: any = path.join("state", "model-routing-admission.sqlite");
const MIGRATION_REVISION: any = 1;
const CIRCUIT_UPDATE_RETRIES: any = 3;

function asObject(value?: any, fallback: Record<string, any> | null = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function asArray(value?: any) : any {
  return Array.isArray(value) ? value : [];
}

function msFromIso(value?: any) : any {
  const ms: any = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

export function getModelRoutingAdmissionDatabasePath(userDataPath: any = "") : any {
  return path.join(
    userDataPath || ServerConfig.getDataDir(),
    MODEL_ROUTING_ADMISSION_DB_RELATIVE,
  );
}

function legacyStatePath(userDataPath: any = "") : any {
  return path.join(userDataPath || ServerConfig.getDataDir(), LEGACY_STATE_FILE);
}

function legacyLedgerPath(userDataPath: any = "") : any {
  return path.join(userDataPath || ServerConfig.getDataDir(), LEGACY_LEDGER_FILE);
}

export function ensureModelRoutingAdmissionSchema(db?: any) : any {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `);
  runMigrations(db, [
    {
      version: MIGRATION_REVISION,
      up: (migrationDb?: any) : any => migrationDb.exec(`
        CREATE TABLE IF NOT EXISTS model_routing_migration (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          migrated_at_ms INTEGER NOT NULL,
          source_state_sha256 TEXT NOT NULL DEFAULT '',
          source_ledger_sha256 TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS model_routing_slots (
          route_id TEXT NOT NULL,
          slot_id TEXT NOT NULL,
          reserved_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          PRIMARY KEY (route_id, slot_id)
        );
        CREATE INDEX IF NOT EXISTS idx_model_routing_slots_expiry
          ON model_routing_slots(route_id, expires_at_ms);

        CREATE TABLE IF NOT EXISTS model_routing_circuits (
          alias TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          failure_count INTEGER NOT NULL DEFAULT 0,
          opened_at_ms INTEGER NOT NULL DEFAULT 0,
          open_until_ms INTEGER NOT NULL DEFAULT 0,
          generation INTEGER NOT NULL DEFAULT 1,
          last_success_at_ms INTEGER NOT NULL DEFAULT 0,
          last_failure_at_ms INTEGER NOT NULL DEFAULT 0,
          last_error TEXT NOT NULL DEFAULT '',
          updated_at_ms INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS model_routing_ledger (
          ledger_id TEXT PRIMARY KEY,
          route_call_id TEXT NOT NULL DEFAULT '',
          route_id TEXT NOT NULL DEFAULT '',
          alias TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          recorded_at_ms INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_model_routing_ledger_window
          ON model_routing_ledger(route_id, status, recorded_at_ms);
        CREATE INDEX IF NOT EXISTS idx_model_routing_ledger_alias
          ON model_routing_ledger(alias);
      `)
    }
  ]);
}

function sha256File(filePath?: any) : any {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readLegacyStateFile(userDataPath: any = "") : any {
  const statePath: any = legacyStatePath(userDataPath);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function readLegacyLedgerRows(userDataPath: any = "") : any[] {
  const ledgerPath: any = legacyLedgerPath(userDataPath);
  if (!fs.existsSync(ledgerPath)) {
    return [];
  }
  const text: any = fs.readFileSync(ledgerPath, "utf8");
  const rows: any[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

/**
 * One-way migration of the legacy JSON state and JSONL ledger into the SQLite
 * authority. The marker is written in the same transaction as the converted
 * rows; any failure rolls back before the marker and leaves legacy files
 * untouched. Pre-switch backups are retained until focused verification
 * succeeds.
 */
export function migrateModelRoutingAdmission({ userDataPath = "" }: Record<string, any> = {}) : any {
  const dbPath: any = getModelRoutingAdmissionDatabasePath(userDataPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db: any = openSqliteDatabase(dbPath);
  try {
    ensureModelRoutingAdmissionSchema(db);
    const marker: any = db.prepare("SELECT migrated_at_ms FROM model_routing_migration WHERE id = 1").get();
    if (marker) {
      return { migrated: false, alreadyMigrated: true };
    }
    const legacyState: any = readLegacyStateFile(userDataPath);
    const legacyRows: any[] = readLegacyLedgerRows(userDataPath);
    const stateDigest: any = legacyState
      ? sha256File(legacyStatePath(userDataPath))
      : "";
    const ledgerDigest: any = fs.existsSync(legacyLedgerPath(userDataPath))
      ? sha256File(legacyLedgerPath(userDataPath))
      : "";

    const insertCircuit: any = db.prepare(`
      INSERT OR REPLACE INTO model_routing_circuits (
        alias, state, failure_count, opened_at_ms, open_until_ms, generation,
        last_success_at_ms, last_failure_at_ms, last_error, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `);
    const insertLedger: any = db.prepare(`
      INSERT OR REPLACE INTO model_routing_ledger (
        ledger_id, route_call_id, route_id, alias, status, recorded_at_ms, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const migratedAtMs: any = Date.now();
    const backupPaths: any[] = [];
    db.transaction(() : any => {
      for (const [alias, circuitEntry] of Object.entries(asObject(legacyState?.circuits))) {
        const circuit: any = circuitEntry;
        insertCircuit.run(
          alias,
          String(circuit?.state || "closed"),
          Number(circuit?.failureCount || 0),
          msFromIso(circuit?.openedAt),
          msFromIso(circuit?.openUntil),
          msFromIso(circuit?.lastSuccessAt),
          msFromIso(circuit?.lastFailureAt),
          String(circuit?.lastError || ""),
          migratedAtMs,
        );
      }
      for (const row of legacyRows) {
        const payload: any = JSON.stringify(row);
        insertLedger.run(
          String(row.ledgerId || ""),
          String(row.routeCallId || ""),
          String(row.routeId || ""),
          String(row.alias || ""),
          String(row.status || ""),
          msFromIso(row.ts),
          payload,
        );
      }
      for (const legacyRelative of [LEGACY_STATE_FILE, LEGACY_LEDGER_FILE]) {
        const sourcePath: any = path.join(userDataPath || ServerConfig.getDataDir(), legacyRelative);
        if (!fs.existsSync(sourcePath)) continue;
        const backupPath: any = `${sourcePath}.bak-${new Date(migratedAtMs).toISOString().replace(/[:.]/gu, "-")}`;
        fs.copyFileSync(sourcePath, backupPath);
        backupPaths.push(backupPath);
      }
      db.prepare(`
        INSERT INTO model_routing_migration (id, migrated_at_ms, source_state_sha256, source_ledger_sha256)
        VALUES (1, ?, ?, ?)
      `).run(migratedAtMs, stateDigest, ledgerDigest);
    })();

    return {
      migrated: true,
      alreadyMigrated: false,
      circuitCount: Object.keys(asObject(legacyState?.circuits)).length,
      ledgerRowCount: legacyRows.length,
      sourceStateSha256: stateDigest,
      sourceLedgerSha256: ledgerDigest,
      backupPaths,
    };
  } catch (error: any) {
    try {
      db.close();
    } catch {
      // Best-effort close; the conversion failure is the primary signal.
    }
    const wrapped: Error & Record<string, any> = new Error(
      `Model routing admission migration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    wrapped.code = "model_routing_admission_migration_failed";
    wrapped.cause = error;
    throw wrapped;
  }
}

function asIso(ms: any = 0) : any {
  return ms > 0 ? new Date(ms).toISOString() : "";
}

export function createModelRoutingAdmissionStore({ userDataPath = "" }: Record<string, any> = {}) : any {
  const migration: any = migrateModelRoutingAdmission({ userDataPath });
  const dbPath: any = getModelRoutingAdmissionDatabasePath(userDataPath);
  const db: any = openSqliteDatabase(dbPath);
  let instrumentation: Record<string, any> = {
    admitStatements: 0,
    outcomeStatements: 0,
    ledgerTailReads: 0,
    openedAfterMigration: migration.alreadyMigrated || migration.migrated,
  };
  ensureModelRoutingAdmissionSchema(db);

  const deleteExpiredSlots: any = db.prepare(
    "DELETE FROM model_routing_slots WHERE route_id = ? AND expires_at_ms < ?",
  );
  const countActiveSlots: any = db.prepare(
    "SELECT COUNT(*) AS n FROM model_routing_slots WHERE route_id = ?",
  );
  const countWindowPermits: any = db.prepare(
    "SELECT COUNT(*) AS n FROM model_routing_ledger WHERE route_id = ? AND status = 'success' AND recorded_at_ms >= ?",
  );
  const insertSlot: any = db.prepare(
    "INSERT INTO model_routing_slots (route_id, slot_id, reserved_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)",
  );
  const deleteSlot: any = db.prepare(
    "DELETE FROM model_routing_slots WHERE route_id = ? AND slot_id = ?",
  );
  const readCircuit: any = db.prepare(
    "SELECT alias, state, failure_count, opened_at_ms, open_until_ms, generation, last_success_at_ms, last_failure_at_ms, last_error FROM model_routing_circuits WHERE alias = ?",
  );
  const insertCircuit: any = db.prepare(`
    INSERT INTO model_routing_circuits (
      alias, state, failure_count, opened_at_ms, open_until_ms, generation,
      last_success_at_ms, last_failure_at_ms, last_error, updated_at_ms
    ) VALUES (?, 'closed', 0, 0, 0, 1, 0, 0, '', ?)
  `);
  const updateCircuitFailure: any = db.prepare(`
    UPDATE model_routing_circuits SET
      state = ?,
      failure_count = failure_count + 1,
      opened_at_ms = ?,
      open_until_ms = ?,
      generation = generation + 1,
      last_failure_at_ms = ?,
      last_error = ?,
      updated_at_ms = ?
    WHERE alias = ? AND generation = ?
  `);
  const updateCircuitSuccess: any = db.prepare(`
    UPDATE model_routing_circuits SET
      state = 'closed',
      failure_count = 0,
      opened_at_ms = 0,
      open_until_ms = 0,
      generation = generation + 1,
      last_success_at_ms = ?,
      last_error = '',
      updated_at_ms = ?
    WHERE alias = ? AND generation = ?
  `);
  const insertLedger: any = db.prepare(`
    INSERT INTO model_routing_ledger (
      ledger_id, route_call_id, route_id, alias, status, recorded_at_ms, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const listCircuits: any = db.prepare("SELECT alias, state, failure_count, opened_at_ms, open_until_ms, generation, last_success_at_ms, last_failure_at_ms, last_error FROM model_routing_circuits ORDER BY alias");
  const listSlots: any = db.prepare("SELECT route_id, slot_id, reserved_at_ms, expires_at_ms FROM model_routing_slots ORDER BY route_id, slot_id");
  const recentLedger: any = db.prepare("SELECT payload_json FROM model_routing_ledger ORDER BY recorded_at_ms DESC, rowid DESC LIMIT ?");

  const admitTransaction: any = db.transaction((admission: Record<string, any>) : any => {
    const routeId: any = String(admission.routeId || "");
    const nowMs: any = Number(admission.nowMs || Date.now());
    const policy: any = asObject(admission.policy);
    const maxConcurrent: any = Number(policy.rateLimit?.maxConcurrent || 0);
    const maxInFlightMs: any = Number(policy.rateLimit?.maxInFlightMs || 0);
    const maxCalls: any = Number(policy.rateLimit?.maxCalls || 0);
    const windowMs: any = Number(policy.rateLimit?.windowMs || 0);
    let active: any = 0;

    if (maxConcurrent > 0) {
      instrumentation.admitStatements += 1;
      deleteExpiredSlots.run(routeId, nowMs);
      instrumentation.admitStatements += 1;
      active = countActiveSlots.get(routeId).n;
      if (active >= maxConcurrent) {
        const error: Error & Record<string, any> = new Error(
          `Model routing concurrency limit exceeded for ${routeId}.`,
        );
        error.code = "model_routing_concurrency_limit_exceeded";
        error.modelRoutingTraffic = {
          algorithm: "sliding_window_success_count_with_concurrency",
          deniedReason: "concurrency_limit_exceeded",
          routeId,
          maxConcurrent,
          inFlightCount: active,
        };
        throw error;
      }
      instrumentation.admitStatements += 1;
      insertSlot.run(routeId, String(admission.slotId || ""), nowMs, nowMs + maxInFlightMs);
    }
    if (maxCalls > 0 && windowMs > 0) {
      instrumentation.admitStatements += 1;
      const permits: any = countWindowPermits.get(routeId, nowMs - windowMs).n;
      if (permits >= maxCalls) {
        throw new Error(`Model routing rate limit exceeded for ${routeId}.`);
      }
    }
    return {
      reserved: maxConcurrent > 0,
      inFlightCount: active + (maxConcurrent > 0 ? 1 : 0),
    };
  });

  function circuitRowToPublic(row: any = null) : any {
    if (!row) {
      return null;
    }
    return {
      alias: row.alias,
      state: row.state,
      failureCount: Number(row.failure_count || 0),
      openedAt: asIso(row.opened_at_ms),
      openUntil: asIso(row.open_until_ms),
      generation: Number(row.generation || 1),
      lastSuccessAt: asIso(row.last_success_at_ms),
      lastFailureAt: asIso(row.last_failure_at_ms),
      lastError: row.last_error,
    };
  }

  return {
    databasePath: dbPath,
    migration,

    admitRouteCall(admission: Record<string, any> = {}) : any {
      const result: any = admitTransaction(admission);
      return {
        reserved: result.reserved,
        traffic: result.reserved
          ? {
              algorithm: "sliding_window_success_count_with_concurrency",
              routeId: String(admission.routeId || ""),
              maxConcurrent: Number(asObject(admission.policy).rateLimit?.maxConcurrent || 0),
              inFlightCount: result.inFlightCount,
            }
          : { algorithm: "sliding_window_success_count", maxConcurrent: 0 },
      };
    },

    releaseRouteCall({ routeId = "", slotId = "", reserved = false }: Record<string, any> = {}) : any {
      if (!reserved) {
        return;
      }
      instrumentation.outcomeStatements += 1;
      deleteSlot.run(String(routeId), String(slotId));
    },

    readCircuitState(alias: any = "") : any {
      const row: any = readCircuit.get(String(alias));
      if (!row) {
        return null;
      }
      return circuitRowToPublic(row);
    },

    listCircuits() : any {
      return listCircuits.all().map(circuitRowToPublic);
    },

    recordCircuitFailure({ alias = "", error = "", policy = {}, nowMs = Date.now() }: Record<string, any> = {}) : any {
      const aliasText: any = String(alias);
      const current: any = readCircuit.get(aliasText);
      if (!current) {
        insertCircuit.run(aliasText, nowMs);
      }
      const circuit: any = readCircuit.get(aliasText);
      const failureCount: any = Number(circuit.failure_count || 0) + 1;
      const shouldOpen: any =
        asObject(policy.circuitBreaker).enabled === true &&
        failureCount >= Number(asObject(policy.circuitBreaker).failureThreshold || 0);
      const openedAtMs: any = shouldOpen ? nowMs : Number(circuit.opened_at_ms || 0);
      const openUntilMs: any = shouldOpen
        ? nowMs + Number(asObject(policy.circuitBreaker).openMs || 0)
        : Number(circuit.open_until_ms || 0);
      for (let attempt: any = 0; attempt < CIRCUIT_UPDATE_RETRIES; attempt += 1) {
        instrumentation.outcomeStatements += 1;
        const updated: any = updateCircuitFailure.run(
          shouldOpen ? "open" : "closed",
          openedAtMs,
          openUntilMs,
          nowMs,
          String(error || ""),
          nowMs,
          aliasText,
          Number(circuit.generation || 1),
        );
        if (updated.changes > 0) {
          return circuitRowToPublic({ ...circuit, state: shouldOpen ? "open" : "closed", failureCount, opened_at_ms: openedAtMs, open_until_ms: openUntilMs, generation: Number(circuit.generation || 1) + 1, last_failure_at_ms: nowMs, last_error: String(error || "") });
        }
        const refreshed: any = readCircuit.get(aliasText);
        if (!refreshed) {
          break;
        }
        circuit.alias = refreshed.alias;
        circuit.state = refreshed.state;
        circuit.failure_count = refreshed.failure_count;
        circuit.opened_at_ms = refreshed.opened_at_ms;
        circuit.open_until_ms = refreshed.open_until_ms;
        circuit.generation = refreshed.generation;
        circuit.last_success_at_ms = refreshed.last_success_at_ms;
        circuit.last_failure_at_ms = refreshed.last_failure_at_ms;
        circuit.last_error = refreshed.last_error;
      }
      const conflict: Error & Record<string, any> = new Error(
        `Model routing circuit update conflict for ${aliasText}.`,
      );
      conflict.code = "model_routing_circuit_update_conflict";
      throw conflict;
    },

    recordCircuitSuccess({ alias = "", nowMs = Date.now() }: Record<string, any> = {}) : any {
      const aliasText: any = String(alias);
      if (!readCircuit.get(aliasText)) {
        insertCircuit.run(aliasText, nowMs);
      }
      for (let attempt: any = 0; attempt < CIRCUIT_UPDATE_RETRIES; attempt += 1) {
        instrumentation.outcomeStatements += 1;
        const circuit: any = readCircuit.get(aliasText);
        const updated: any = updateCircuitSuccess.run(nowMs, nowMs, aliasText, Number(circuit.generation || 1));
        if (updated.changes > 0) {
          return;
        }
      }
      const conflict: Error & Record<string, any> = new Error(
        `Model routing circuit update conflict for ${aliasText}.`,
      );
      conflict.code = "model_routing_circuit_update_conflict";
      throw conflict;
    },

    recordLedgerRow(row: Record<string, any> = {}) : any {
      instrumentation.outcomeStatements += 1;
      insertLedger.run(
        String(row.ledgerId || ""),
        String(row.routeCallId || ""),
        String(row.routeId || ""),
        String(row.alias || ""),
        String(row.status || ""),
        msFromIso(row.ts),
        JSON.stringify(row),
      );
    },

    inspect({ limit = 50 }: Record<string, any> = {}) : any {
      const rows: any[] = recentLedger.all(Number(limit) || 50).map((entry?: any) : any => JSON.parse(entry.payload_json));
      const byStatus: Record<string, any> = {};
      const byAlias: Record<string, any> = {};
      let estimatedUsdTotal: any = 0;
      for (const row of rows) {
        byStatus[row.status] = Number(byStatus[row.status] || 0) + 1;
        byAlias[row.alias] = Number(byAlias[row.alias] || 0) + 1;
        estimatedUsdTotal += Number(row.actualEstimatedUsd || row.budget?.estimatedTotalUsd || 0);
      }
      const slotRows: any[] = listSlots.all();
      const inFlight: Record<string, any> = {};
      for (const slot of slotRows) {
        const routeInFlight: any = inFlight[slot.route_id] || { routeId: slot.route_id, updatedAt: "", slots: {} };
        routeInFlight.slots[slot.slot_id] = asIso(slot.reserved_at_ms);
        inFlight[slot.route_id] = routeInFlight;
      }
      return {
        schemaVersion: "v0.0.1:schema:definition-1",
        protocolVersion: "v0.0.1:strategy:model-routing-1",
        updatedAt: new Date().toISOString(),
        statePath: MODEL_ROUTING_ADMISSION_DB_RELATIVE,
        ledgerPath: MODEL_ROUTING_ADMISSION_DB_RELATIVE,
        state: {
          schemaVersion: "v0.0.1:schema:definition-1",
          protocolVersion: "v0.0.1:strategy:model-routing-1",
          updatedAt: new Date().toISOString(),
          circuits: Object.fromEntries(listCircuits.all().map((entry?: any) : any => [entry.alias, circuitRowToPublic(entry)])),
          inFlight,
        },
        ledgerSummary: {
          total: rows.length,
          byStatus,
          byAlias,
          estimatedUsdTotal: Number(estimatedUsdTotal.toFixed(8)),
        },
        recentLedger: rows,
      };
    },

    getAdmissionInstrumentation() : any {
      return { ...instrumentation };
    },

    close() : any {
      db.close();
    },
  };
}
