import { DatabaseSync } from "node:sqlite";
import { constants, openSync, closeSync, chmodSync } from "node:fs";
import path from "node:path";

// Accounting and completed idempotency facts are durable records, not a cache.
// Complete results remain durable. Only RAM copies expire from the replay cache. SQLite indexes
// keep admission and replay independent of the amount of historical content.
export function createLedger({ dataRoot, state, responseCacheBounds = {}, bounds, now = Date.now, windowMs = 60_000 }) {
  const filename = path.join(dataRoot, "ledger.sqlite");
  const fd = openSync(filename, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
  closeSync(fd);
  chmodSync(filename, 0o600);
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096;
      CREATE TABLE IF NOT EXISTS effect_rates (key TEXT PRIMARY KEY,tokens REAL NOT NULL,refilled_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (
        call_id TEXT PRIMARY KEY, principal TEXT NOT NULL, idem TEXT, fingerprint TEXT,
        state TEXT NOT NULL, created_at INTEGER NOT NULL, partition_key TEXT NOT NULL,
        reserved_tokens INTEGER NOT NULL, reserved_cost INTEGER NOT NULL, facts TEXT NOT NULL,
        response TEXT, response_bytes INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS call_idempotency ON calls(principal,idem) WHERE idem IS NOT NULL;
      CREATE INDEX IF NOT EXISTS call_pending ON calls(state);
      CREATE INDEX IF NOT EXISTS call_window ON calls(created_at,principal);
      CREATE INDEX IF NOT EXISTS call_subject_window ON calls(principal,created_at);
      DROP INDEX IF EXISTS call_hot_response;`);
    for (const suffix of ["-wal", "-shm"]) chmodSync(filename + suffix, 0o600);
  } catch (error) { db.close(); throw error; }
  const limitEntries = responseCacheBounds.maxEntries || 512;
  const limitBytes = responseCacheBounds.maxBytes || 16 * 1024 * 1024;
  const select = db.prepare("SELECT call_id,facts FROM calls WHERE call_id=?");
  const selectResponse = db.prepare("SELECT response FROM calls WHERE call_id=?");
  const unknownOwnerKey = db.prepare("SELECT call_id FROM calls WHERE principal='' AND idem=? LIMIT 1");
  const byKey = db.prepare("SELECT call_id,facts,fingerprint FROM calls WHERE principal=? AND idem=?");
  const pending = db.prepare("SELECT count(*) AS count FROM calls WHERE state='in_doubt'");
  const insert = db.prepare(`INSERT INTO calls (
    call_id,principal,idem,fingerprint,state,created_at,partition_key,
    reserved_tokens,reserved_cost,facts,response,response_bytes
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const totals = db.prepare(`SELECT count(*) AS count,total(reserved_tokens) AS tokens,
    total(reserved_cost) AS cost FROM calls WHERE created_at>?`);
  const subjectTotals = db.prepare(`SELECT count(*) AS count,total(reserved_tokens) AS tokens,
    total(reserved_cost) AS cost FROM calls WHERE principal=? AND created_at>?`);
  const readRate = db.prepare("SELECT tokens,refilled_at FROM effect_rates WHERE key=?");
  const writeRate = db.prepare("INSERT INTO effect_rates VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET tokens=excluded.tokens,refilled_at=excluded.refilled_at");
  const responseCache = new Map();
  let cachedBytes = 0;

  function transaction(task) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = task(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function rememberResponse(callId, encoded) {
    const prior = responseCache.get(callId);
    if (prior) { cachedBytes -= prior.bytes; responseCache.delete(callId); }
    if (encoded === null) return;
    const bytes = Buffer.byteLength(encoded);
    if (bytes > limitBytes) return;
    responseCache.set(callId, { encoded, bytes });
    cachedBytes += bytes;
    while (responseCache.size > limitEntries || cachedBytes > limitBytes) {
      const oldest = responseCache.keys().next().value;
      cachedBytes -= responseCache.get(oldest).bytes;
      responseCache.delete(oldest);
    }
  }
  function project(row) {
    if (!row) return null;
    let encoded = responseCache.get(row.call_id)?.encoded;
    if (encoded === undefined) encoded = selectResponse.get(row.call_id).response;
    rememberResponse(row.call_id, encoded);
    return { ...JSON.parse(row.facts), response: encoded === null ? null : JSON.parse(encoded) };
  }
  // One-time transfer of the unpublished JSON owner. Import is transactional
  // and repeatable after a crash; an existing advanced record is never reverted.
  try { transaction(() => {
    for (const entry of Object.values(state.ledger || {})) {
      if (select.get(entry.callId)) continue;
      const facts = { ...entry, state: entry.state === "released" ? "in_doubt" : entry.state };
      const response = facts.response == null ? null : JSON.stringify(facts.response);
      delete facts.response;
      insert.run(facts.callId, String(facts.principalRef || ""), facts.idempotencyKey || null,
        facts.requestFingerprint || null, facts.state, now(), "imported", Number(facts.inputTokens || 0) + Number(facts.outputTokens || 0),
        Number(facts.amount?.units || 0) * 1_000_000 + Math.ceil(Number(facts.amount?.nanos || 0) / 1000), JSON.stringify(facts), response, response ? Buffer.byteLength(response) : 0);
    }
  }); } catch (error) { db.close(); throw error; }
  delete state.ledger;

  function findIdempotency(principal, key, fingerprint) {
    if (!key) return null;
    if (unknownOwnerKey.get(key)) return { conflict: true, entry: null };
    const row = byKey.get(principal, key);
    if (!row) return null;
    return { conflict: row.fingerprint !== fingerprint, entry: project(row) };
  }
  function create({ callId, principalRef, idempotencyKey, requestFingerprint, modelRef, pricingRevisionRef, currency,
    reservationRef, partitionKey = "", inputTokens = 0, requestedOutputTokens = 0, estimatedCostMicros = 0 }) {
    return transaction(() => {
      const duplicate = findIdempotency(principalRef, idempotencyKey, requestFingerprint);
      if (duplicate) return { duplicate: true, ...duplicate };
      if (pending.get().count >= bounds.maxLedgerPendingEntries) return { denied: "budget_exceeded" };
      const cutoff = now() - windowMs;
      const global = totals.get(cutoff);
      const subject = subjectTotals.get(principalRef, cutoff);
      const tokens = inputTokens + requestedOutputTokens;
      const time = now();
      const rates = [["global", bounds.maxGlobalRatePerSecond], [JSON.stringify(["subject", principalRef]), bounds.maxSubjectRatePerSecond]]
        .map(([key, rate]) => {
          const prior = readRate.get(key);
          const tokens = prior ? Math.min(rate, prior.tokens + Math.max(0, time - prior.refilled_at) * rate / 1000) : rate;
          return { key, tokens };
        });
      if (rates.some((entry) => entry.tokens < 1)) return { denied: "rate_limited" };
      if (global.tokens + tokens > bounds.maxGlobalTotalTokenQuota || subject.tokens + tokens > bounds.maxSubjectTotalTokenQuota) {
        return { denied: "budget_exceeded" };
      }
      if (global.cost + estimatedCostMicros > bounds.maxGlobalCostQuotaMicros || subject.cost + estimatedCostMicros > bounds.maxSubjectCostQuotaMicros) {
        return { denied: "quota_exceeded" };
      }
      const facts = { callId, principalRef, idempotencyKey: idempotencyKey || null, requestFingerprint: requestFingerprint || null,
        modelRef, pricingRevisionRef, currency, reservationRef, state: "in_doubt", attempts: 1,
        amount: { currency, units: 0, nanos: 0 }, inputTokens: 0, outputTokens: 0 };
      for (const rate of rates) writeRate.run(rate.key, rate.tokens - 1, time);
      insert.run(callId, principalRef, idempotencyKey || null, requestFingerprint || null, "in_doubt", now(), partitionKey,
        tokens, estimatedCostMicros, JSON.stringify(facts), null, 0);
      return { duplicate: false, entry: { ...facts, response: null } };
    });
  }
  function markSettled(callId, { inputTokens, outputTokens, amount, response }) {
    const result = transaction(() => {
      const entry = project(select.get(callId));
      if (!entry || entry.state === "settled") return { changed: false };
      const facts = { ...entry, inputTokens, outputTokens, amount, state: "settled" };
      delete facts.response;
      const encoded = response == null ? null : JSON.stringify(response);
      const cost = amount.units * 1_000_000 + Math.ceil(amount.nanos / 1000);
      db.prepare(`UPDATE calls SET state='settled',facts=?,response=?,response_bytes=?,
        reserved_tokens=max(reserved_tokens,?),reserved_cost=max(reserved_cost,?) WHERE call_id=?`).run(
        JSON.stringify(facts), encoded, encoded ? Buffer.byteLength(encoded) : 0, inputTokens + outputTokens, cost, callId);
      return { changed: true };
    });
    if (result.changed) rememberResponse(callId, response == null ? null : JSON.stringify(response));
    return result;
  }
  let closed = false;
  return Object.freeze({
    findIdempotency, create, markSettled,
    get: (callId) => {
      const row = db.prepare("SELECT facts FROM calls WHERE call_id=?").get(callId);
      return row ? JSON.parse(row.facts) : null;
    },
    close: () => { if (!closed) { closed = true; responseCache.clear(); cachedBytes = 0; db.close(); } }
  });
}
