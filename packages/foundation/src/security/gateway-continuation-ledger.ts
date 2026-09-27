import type Database from "better-sqlite3";
import type { ExecutionPermit } from "@meshrix/contracts/gateway";
import { openSqliteDatabase } from "../storage/sqlite-database.ts";
import { ensurePrivateSqliteLocation, withPrivateFileCreationMask } from "../storage/private-sqlite.ts";
import { runMigrations } from "../storage/sqlite-migrations.ts";
import { acquireStorageRuntimeLease } from "../storage/storage-lifecycle-lock.ts";

type Outcome = "executing" | "consumed" | "outcome_unknown";
type IntentPhase = "dispatch_started" | "not_started" | "succeeded" | "failed";

interface DurableIntentBinding {
  readonly id: string;
  readonly tenant: string;
  readonly principal: string;
  readonly grantRevision: string;
  readonly routeRef: string;
  readonly routeRevision: string;
  readonly target: string;
  readonly inputDigest: string;
  readonly policyRevision: string;
}

function refusal(code: string, message: string, status = 409): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status });
}

/** Private single-file, transactional replay fence for a deliberately persistent key profile. */
export class SqliteGatewayContinuationLedger {
  readonly #db: Database.Database;
  readonly #runtimeLease?: ReturnType<typeof acquireStorageRuntimeLease>;
  readonly #now: () => number;
  readonly #maxEntries: number;
  readonly #maxReceiptEntries: number;
  readonly #maxIntentEntries: number;
  readonly #maxTerminalEntries: number;
  #closed = false;

  constructor(options: { readonly filePath: string; readonly ownershipRoot?: string; readonly now?: () => number; readonly maxEntries?: number; readonly maxReceiptEntries?: number; readonly maxIntentEntries?: number; readonly maxTerminalEntries?: number }) {
    this.#now = options.now ?? Date.now;
    this.#maxEntries = Math.max(1, Math.min(1_000_000, Math.floor(options.maxEntries ?? 10_000)));
    this.#maxReceiptEntries = Math.max(1, Math.min(1_000_000, Math.floor(options.maxReceiptEntries ?? 10_000)));
    this.#maxIntentEntries = Math.max(1, Math.min(1_000_000, Math.floor(options.maxIntentEntries ?? 10_000)));
    this.#maxTerminalEntries = Math.max(1, Math.min(1_000_000, Math.floor(options.maxTerminalEntries ?? 10_000)));
    this.#runtimeLease = options.ownershipRoot === undefined ? undefined : acquireStorageRuntimeLease(options.ownershipRoot);
    let openedDatabase: Database.Database | undefined;
    try {
      const path = ensurePrivateSqliteLocation(options.filePath);
      this.#db = openedDatabase = withPrivateFileCreationMask(() => openSqliteDatabase(path));
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
      `) }, { version: 3, up: (db) => db.exec(`
        CREATE TABLE IF NOT EXISTS gateway_execution_intents (
          intent_id TEXT PRIMARY KEY,
          tenant TEXT NOT NULL,
          principal TEXT NOT NULL,
          grant_revision TEXT NOT NULL,
          route_ref TEXT NOT NULL,
          route_revision TEXT NOT NULL,
          target TEXT NOT NULL,
          input_digest TEXT NOT NULL,
          policy_revision TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatch_started', 'not_started', 'succeeded', 'failed', 'in_doubt')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS gateway_execution_intents_unresolved ON gateway_execution_intents(state)
          WHERE state IN ('prepared', 'dispatch_started', 'in_doubt');
        CREATE INDEX IF NOT EXISTS gateway_execution_intents_terminal_order ON gateway_execution_intents(updated_at, intent_id)
          WHERE state IN ('not_started', 'succeeded', 'failed');
        CREATE TABLE IF NOT EXISTS gateway_execution_intent_capacity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          terminal_count INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO gateway_execution_intent_capacity(singleton, terminal_count) VALUES (1, 0);
        UPDATE gateway_execution_intent_capacity SET terminal_count = (
          SELECT count(*) FROM gateway_execution_intents WHERE state IN ('not_started', 'succeeded', 'failed')
        ) WHERE singleton = 1;
      `) }]);
      if (options.ownershipRoot !== undefined) {
        this.#db.transaction(() => {
          this.#db.prepare(`UPDATE gateway_execution_receipts SET state = 'outcome_unknown'
            WHERE state = 'consumed' AND receipt_id IN (
              SELECT intent_id FROM gateway_execution_intents WHERE state = 'dispatch_started'
            )`).run();
          this.#db.prepare("UPDATE gateway_execution_intents SET state = 'in_doubt', updated_at = ? WHERE state = 'dispatch_started'").run(this.#now());
        }).immediate();
      }
      ensurePrivateSqliteLocation(path);
    } catch (error) {
      try { openedDatabase?.close(); } catch { /* preserve the initialization failure */ }
      this.#runtimeLease?.release();
      throw error;
    }
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
    this.#recordIssued(permit, false);
  }

  recordIssuedWithIntent(permit: ExecutionPermit): void {
    this.#recordIssued(permit, true);
  }

  #recordIssued(permit: ExecutionPermit, prepareIntent: boolean): void {
    this.#assertOpen();
    const now = this.#now();
    if (!permit.routeRef || permit.expiresAt <= now) throw refusal("permit_binding_mismatch", "Receipt has no current route binding.", 403);
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM gateway_execution_receipts WHERE expires_at <= ?").run(now);
      const count = this.#db.prepare("SELECT count(*) AS total FROM gateway_execution_receipts").get() as { total: number };
      if (count.total >= this.#maxReceiptEntries) throw refusal("permit_capacity", "Durable receipt capacity is exhausted.", 503);
      if (prepareIntent) {
        const unresolved = this.#db.prepare("SELECT count(*) AS total FROM gateway_execution_intents WHERE state IN ('prepared', 'dispatch_started', 'in_doubt')").get() as { total: number };
        if (unresolved.total >= this.#maxIntentEntries) throw refusal("gateway_intent_capacity", "Durable execution intent capacity is exhausted.", 503);
      }
      this.#db.prepare(`INSERT INTO gateway_execution_receipts(receipt_id,tenant,principal,grant_revision,route_ref,route_revision,target,input_digest,policy_revision,state,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,'issued',?)`).run(permit.id, permit.tenant, permit.principal, permit.grantRevision, permit.routeRef, permit.routeRevision, permit.target, permit.inputDigest, permit.policyRevision, permit.expiresAt);
      if (prepareIntent) this.#db.prepare(`INSERT INTO gateway_execution_intents(intent_id,tenant,principal,grant_revision,route_ref,route_revision,target,input_digest,policy_revision,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'prepared',?,?)`).run(permit.id, permit.tenant, permit.principal, permit.grantRevision, permit.routeRef, permit.routeRevision, permit.target, permit.inputDigest, permit.policyRevision, now, now);
    }).immediate();
  }

  recordConsumed(id: string): void {
    this.#assertOpen();
    const updated = this.#db.prepare("UPDATE gateway_execution_receipts SET state = 'consumed' WHERE receipt_id = ? AND state = 'issued' AND expires_at > ?").run(id, this.#now());
    if (updated.changes !== 1) throw refusal("permit_replayed", "Durable receipt was already consumed or expired.", 403);
  }

  hasIntent(id: string): boolean {
    this.#assertOpen();
    return this.#db.prepare("SELECT 1 FROM gateway_execution_intents WHERE intent_id = ?").get(id) !== undefined;
  }

  recordUnknown(id: string): void {
    this.#assertOpen();
    this.#db.transaction(() => {
      const intent = this.#db.prepare("SELECT state FROM gateway_execution_intents WHERE intent_id = ?").get(id) as { state: string } | undefined;
      if (intent) {
        if (intent.state === "in_doubt" || intent.state === "not_started" || intent.state === "succeeded" || intent.state === "failed") return;
        if (intent.state !== "dispatch_started") throw refusal("gateway_intent_transition_conflict", "A prepared execution intent cannot become uncertain before dispatch.", 503);
        this.#db.prepare("UPDATE gateway_execution_receipts SET state = 'outcome_unknown' WHERE receipt_id = ? AND state = 'consumed'").run(id);
        this.#db.prepare("UPDATE gateway_execution_intents SET state = 'in_doubt', updated_at = ? WHERE intent_id = ? AND state = 'dispatch_started'").run(this.#now(), id);
        return;
      }
      const updated = this.#db.prepare("UPDATE gateway_execution_receipts SET state = 'outcome_unknown' WHERE receipt_id = ? AND state = 'consumed'").run(id);
      if (updated.changes !== 1 && this.lookupReceipt(id)?.state !== "outcome_unknown") throw refusal("permit_unknown", "Durable outcome receipt is unavailable.", 503);
    }).immediate();
  }

  transitionExecutionIntent(permit: ExecutionPermit, phase: IntentPhase): void {
    this.#assertOpen();
    const binding = this.#intentBinding(permit);
    const fromStates = phase === "dispatch_started" ? ["prepared"]
      : phase === "not_started" ? ["prepared", "dispatch_started"]
        : ["dispatch_started"];
    const placeholders = fromStates.map(() => "?").join(",");
    this.#db.transaction(() => {
      const updated = this.#db.prepare(`UPDATE gateway_execution_intents SET state = ?, updated_at = ?
        WHERE intent_id = ? AND tenant = ? AND principal = ? AND grant_revision = ? AND route_ref = ? AND route_revision = ? AND target = ? AND input_digest = ? AND policy_revision = ? AND state IN (${placeholders})`)
        .run(phase, this.#now(), binding.id, binding.tenant, binding.principal, binding.grantRevision, binding.routeRef, binding.routeRevision, binding.target, binding.inputDigest, binding.policyRevision, ...fromStates);
      if (updated.changes === 1) {
        if (phase === "not_started" || phase === "succeeded" || phase === "failed") this.#retainTerminal(binding.id);
        return;
      }
      const current = this.#db.prepare("SELECT tenant,principal,grant_revision,route_ref,route_revision,target,input_digest,policy_revision,state FROM gateway_execution_intents WHERE intent_id = ?").get(binding.id) as Record<string, unknown> | undefined;
      if (current && this.#matchesIntent(current, binding) && current.state === phase) return;
      throw refusal("gateway_intent_transition_conflict", "Durable execution intent transition is unavailable.", 503);
    }).immediate();
  }

  #retainTerminal(currentIntentId: string): void {
    const updated = this.#db.prepare("UPDATE gateway_execution_intent_capacity SET terminal_count = terminal_count + 1 WHERE singleton = 1 RETURNING terminal_count").get() as { terminal_count: number } | undefined;
    if (!updated) throw refusal("gateway_intent_capacity_unavailable", "Durable execution intent retention is unavailable.", 503);
    if (updated.terminal_count <= this.#maxTerminalEntries) return;
    const oldest = this.#db.prepare(`SELECT intent_id FROM gateway_execution_intents
      WHERE state IN ('not_started', 'succeeded', 'failed') AND intent_id != ? ORDER BY updated_at, intent_id LIMIT 1`).get(currentIntentId) as { intent_id: string } | undefined;
    if (!oldest) throw refusal("gateway_intent_capacity_unavailable", "Durable execution intent retention is unavailable.", 503);
    this.#db.prepare("DELETE FROM gateway_execution_intents WHERE intent_id = ? AND state IN ('not_started', 'succeeded', 'failed')").run(oldest.intent_id);
    this.#db.prepare("UPDATE gateway_execution_intent_capacity SET terminal_count = terminal_count - 1 WHERE singleton = 1").run();
  }

  #intentBinding(permit: ExecutionPermit): DurableIntentBinding {
    if (!permit.routeRef) throw refusal("permit_binding_mismatch", "Execution intent has no route binding.", 403);
    return { id: permit.id, tenant: permit.tenant, principal: permit.principal, grantRevision: permit.grantRevision,
      routeRef: permit.routeRef, routeRevision: permit.routeRevision, target: permit.target, inputDigest: permit.inputDigest, policyRevision: permit.policyRevision };
  }

  #matchesIntent(row: Record<string, unknown>, binding: DurableIntentBinding): boolean {
    return row.tenant === binding.tenant && row.principal === binding.principal && row.grant_revision === binding.grantRevision &&
      row.route_ref === binding.routeRef && row.route_revision === binding.routeRevision && row.target === binding.target &&
      row.input_digest === binding.inputDigest && row.policy_revision === binding.policyRevision;
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
    try { this.#db.close(); }
    finally { this.#runtimeLease?.release(); }
  }
}

export function createSqliteGatewayContinuationLedger(options: { readonly filePath: string; readonly ownershipRoot?: string; readonly now?: () => number; readonly maxEntries?: number; readonly maxReceiptEntries?: number; readonly maxIntentEntries?: number; readonly maxTerminalEntries?: number }): SqliteGatewayContinuationLedger {
  return new SqliteGatewayContinuationLedger(options);
}
