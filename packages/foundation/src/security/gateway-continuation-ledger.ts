import type Database from "better-sqlite3";
import type { ExecutionPermit } from "@meshrix/contracts/gateway";
import { openSqliteDatabase } from "../storage/sqlite-database.ts";
import { ensurePrivateSqliteLocation, withPrivateFileCreationMask } from "../storage/private-sqlite.ts";
import { runMigrations } from "../storage/sqlite-migrations.ts";

type Outcome = "executing" | "consumed" | "outcome_unknown";

function refusal(code: string, message: string, status = 409): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status });
}

/** Private single-file, transactional replay fence for a deliberately persistent key profile. */
export class SqliteGatewayContinuationLedger {
  readonly #db: Database.Database;
  readonly #now: () => number;
  readonly #maxEntries: number;
  readonly #maxReceiptEntries: number;
  #closed = false;

  constructor(options: { readonly filePath: string; readonly now?: () => number; readonly maxEntries?: number; readonly maxReceiptEntries?: number }) {
    const path = ensurePrivateSqliteLocation(options.filePath);
    this.#now = options.now ?? Date.now;
    this.#maxEntries = Math.max(1, Math.min(1_000_000, Math.floor(options.maxEntries ?? 10_000)));
    this.#maxReceiptEntries = Math.max(1, Math.min(1_000_000, Math.floor(options.maxReceiptEntries ?? 10_000)));
    this.#db = withPrivateFileCreationMask(() => openSqliteDatabase(path));
    try {
      this.#db.pragma("journal_mode = WAL");
      this.#db.pragma("synchronous = FULL");
      this.#db.pragma("busy_timeout = 5000");
      runMigrations(this.#db, [{ version: 1, up: (db) => db.exec(`
        CREATE TABLE IF NOT EXISTS gateway_continuation_claims (
          token_id TEXT PRIMARY KEY,
          state TEXT NOT NULL CHECK (state IN ('executing', 'consumed', 'outcome_unknown')),
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS gateway_continuation_claims_expiry ON gateway_continuation_claims(expires_at);
      `) }, { version: 2, up: (db) => db.exec(`
        CREATE TABLE IF NOT EXISTS gateway_execution_receipts (
          receipt_id TEXT PRIMARY KEY,
          tenant TEXT NOT NULL,
          principal TEXT NOT NULL,
          grant_revision TEXT NOT NULL,
          route_ref TEXT NOT NULL,
          route_revision TEXT NOT NULL,
          target TEXT NOT NULL,
          input_digest TEXT NOT NULL,
          policy_revision TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('issued', 'consumed', 'outcome_unknown')),
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS gateway_execution_receipts_expiry ON gateway_execution_receipts(expires_at);
      `) }]);
      ensurePrivateSqliteLocation(path);
    } catch (error) { this.#db.close(); throw error; }
  }

  #assertOpen(): void { if (this.#closed) throw refusal("continuation_ledger_closed", "Replay ledger is closed.", 503); }

  claim(id: string, expiresAt: number): void {
    this.#assertOpen();
    const now = this.#now();
    if (!id || id.length > 128 || !Number.isSafeInteger(expiresAt) || expiresAt <= now) throw refusal("continuation_invalid", "Replay claim is invalid.", 400);
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM gateway_continuation_claims WHERE expires_at <= ?").run(now);
      const existing = this.#db.prepare("SELECT state FROM gateway_continuation_claims WHERE token_id = ?").get(id) as { state: Outcome } | undefined;
      if (existing) throw refusal(existing.state === "outcome_unknown" ? "continuation_outcome_unknown" : existing.state === "executing" ? "continuation_in_progress" : "continuation_replayed", "Continuation has already been claimed.");
      const count = this.#db.prepare("SELECT count(*) AS total FROM gateway_continuation_claims").get() as { total: number };
      if (count.total >= this.#maxEntries) throw refusal("continuation_capacity", "Replay ledger capacity is exhausted.", 503);
      this.#db.prepare("INSERT INTO gateway_continuation_claims(token_id, state, expires_at) VALUES (?, 'executing', ?)").run(id, expiresAt);
    }).immediate();
  }

  settle(id: string, outcome: "consumed" | "outcome_unknown"): void {
    this.#assertOpen();
    const updated = this.#db.prepare("UPDATE gateway_continuation_claims SET state = ? WHERE token_id = ? AND state = 'executing'").run(outcome, id);
    if (updated.changes === 0 && this.state(id) === "executing") throw refusal("continuation_ledger_conflict", "Replay ledger settlement did not commit.", 503);
  }

  release(id: string): void {
    this.#assertOpen();
    this.#db.prepare("DELETE FROM gateway_continuation_claims WHERE token_id = ? AND state = 'executing'").run(id);
  }

  state(id: string): Outcome | undefined {
    this.#assertOpen();
    return (this.#db.prepare("SELECT state FROM gateway_continuation_claims WHERE token_id = ?").get(id) as { state?: Outcome } | undefined)?.state;
  }

  recordIssued(permit: ExecutionPermit): void {
    this.#assertOpen();
    if (!permit.routeRef || permit.expiresAt <= this.#now()) throw refusal("permit_binding_mismatch", "Receipt has no current route binding.", 403);
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM gateway_execution_receipts WHERE expires_at <= ?").run(this.#now());
      const count = this.#db.prepare("SELECT count(*) AS total FROM gateway_execution_receipts").get() as { total: number };
      if (count.total >= this.#maxReceiptEntries) throw refusal("permit_capacity", "Durable receipt capacity is exhausted.", 503);
      this.#db.prepare(`INSERT INTO gateway_execution_receipts(receipt_id,tenant,principal,grant_revision,route_ref,route_revision,target,input_digest,policy_revision,state,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,'issued',?)`).run(permit.id, permit.tenant, permit.principal, permit.grantRevision, permit.routeRef, permit.routeRevision, permit.target, permit.inputDigest, permit.policyRevision, permit.expiresAt);
    }).immediate();
  }

  recordConsumed(id: string): void {
    this.#assertOpen();
    const updated = this.#db.prepare("UPDATE gateway_execution_receipts SET state = 'consumed' WHERE receipt_id = ? AND state = 'issued' AND expires_at > ?").run(id, this.#now());
    if (updated.changes !== 1) throw refusal("permit_replayed", "Durable receipt was already consumed or expired.", 403);
  }

  recordUnknown(id: string): void {
    this.#assertOpen();
    const updated = this.#db.prepare("UPDATE gateway_execution_receipts SET state = 'outcome_unknown' WHERE receipt_id = ? AND state = 'consumed'").run(id);
    if (updated.changes !== 1 && this.lookupReceipt(id)?.state !== "outcome_unknown") throw refusal("permit_unknown", "Durable outcome receipt is unavailable.", 503);
  }

  lookupReceipt(id: string): ExecutionPermit | undefined {
    this.#assertOpen();
    const row = this.#db.prepare(`SELECT receipt_id,tenant,principal,grant_revision,route_ref,route_revision,target,input_digest,policy_revision,state,expires_at
      FROM gateway_execution_receipts WHERE receipt_id = ? AND expires_at > ?`).get(id, this.#now()) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return Object.freeze({ id: String(row.receipt_id), tenant: String(row.tenant), principal: String(row.principal), grantRevision: String(row.grant_revision),
      routeRef: String(row.route_ref), routeRevision: String(row.route_revision), target: String(row.target), audience: String(row.target),
      inputDigest: String(row.input_digest), policyRevision: String(row.policy_revision), state: row.state as ExecutionPermit["state"], expiresAt: Number(row.expires_at) });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

export function createSqliteGatewayContinuationLedger(options: { readonly filePath: string; readonly now?: () => number; readonly maxEntries?: number; readonly maxReceiptEntries?: number }): SqliteGatewayContinuationLedger {
  return new SqliteGatewayContinuationLedger(options);
}
