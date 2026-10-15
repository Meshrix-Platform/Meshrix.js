import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createLedger } from "../internal/ledger.mjs";

const BOUNDS = {
  maxLedgerPendingEntries: 100,
  maxGlobalRatePerSecond: 100,
  maxSubjectRatePerSecond: 100,
  maxGlobalTotalTokenQuota: 1_000_000,
  maxSubjectTotalTokenQuota: 1_000_000,
  maxGlobalCostQuotaMicros: 1_000_000_000,
  maxSubjectCostQuotaMicros: 1_000_000_000
};

function openLedger(dataRoot) {
  return createLedger({ dataRoot, state: {}, bounds: BOUNDS, now: () => 1_000 });
}

test("settlement has no unused order counter and preserves legacy accounting rows", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "model-settled-order-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  const ledger = openLedger(dataRoot);
  const freshDb = new DatabaseSync(path.join(dataRoot, "ledger.sqlite"));
  assert.equal(freshDb.prepare("PRAGMA table_info(calls)").all().some((column) => column.name === "settled_order"), false);
  freshDb.close();

  const first = ledger.create({
    callId: "call.paid.1", principalRef: "principal.1", idempotencyKey: "idem.paid.1",
    requestFingerprint: "fingerprint.1", modelRef: "model.1", pricingRevisionRef: "price.1",
    currency: "USD", reservationRef: "reservation.1", inputTokens: 10,
    requestedOutputTokens: 8, estimatedCostMicros: 12_000
  });
  assert.equal(first.duplicate, false);
  assert.deepEqual(ledger.markSettled("call.paid.1", {
    inputTokens: 10,
    outputTokens: 6,
    amount: { currency: "USD", units: 0, nanos: 9_000_000 },
    response: { id: "result.1", content: "completed" }
  }), { changed: true });
  assert.deepEqual(ledger.get("call.paid.1"), {
    callId: "call.paid.1", principalRef: "principal.1", idempotencyKey: "idem.paid.1",
    requestFingerprint: "fingerprint.1", modelRef: "model.1", pricingRevisionRef: "price.1",
    currency: "USD", reservationRef: "reservation.1", state: "settled", attempts: 1,
    amount: { currency: "USD", units: 0, nanos: 9_000_000 }, inputTokens: 10, outputTokens: 6
  });
  assert.deepEqual(ledger.findIdempotency("principal.1", "idem.paid.1", "fingerprint.1")?.entry.response,
    { id: "result.1", content: "completed" });
  ledger.close();

  // Simulate an older SQLite schema. Existing metadata is left intact, while
  // new code neither reads it to seed a counter nor writes it on settlement.
  const legacyDb = new DatabaseSync(path.join(dataRoot, "ledger.sqlite"));
  legacyDb.exec("ALTER TABLE calls ADD COLUMN settled_order INTEGER");
  legacyDb.prepare("UPDATE calls SET settled_order=73 WHERE call_id=?").run("call.paid.1");
  legacyDb.close();

  const reopened = openLedger(dataRoot);
  const retry = reopened.create({
    callId: "call.paid.2", principalRef: "principal.1", idempotencyKey: "idem.paid.2",
    requestFingerprint: "fingerprint.2", modelRef: "model.1", pricingRevisionRef: "price.1",
    currency: "USD", reservationRef: "reservation.2", inputTokens: 5,
    requestedOutputTokens: 4, estimatedCostMicros: 5_000
  });
  assert.equal(retry.duplicate, false);
  assert.deepEqual(reopened.markSettled("call.paid.2", {
    inputTokens: 5,
    outputTokens: 3,
    amount: { currency: "USD", units: 0, nanos: 4_000_000 },
    response: { id: "result.2", content: "second completed call" }
  }), { changed: true });
  reopened.close();

  const verifyDb = new DatabaseSync(path.join(dataRoot, "ledger.sqlite"), { readOnly: true });
  const rows = verifyDb.prepare("SELECT call_id,state,facts,response,settled_order FROM calls ORDER BY call_id").all();
  verifyDb.close();
  assert.deepEqual(rows.map((row) => [row.call_id, row.state, row.settled_order]), [
    ["call.paid.1", "settled", 73],
    ["call.paid.2", "settled", null]
  ]);
  assert.deepEqual(JSON.parse(rows[0].facts).amount, { currency: "USD", units: 0, nanos: 9_000_000 });
  assert.deepEqual(JSON.parse(rows[1].facts).amount, { currency: "USD", units: 0, nanos: 4_000_000 });
  assert.deepEqual(JSON.parse(rows[0].response), { id: "result.1", content: "completed" });
  assert.deepEqual(JSON.parse(rows[1].response), { id: "result.2", content: "second completed call" });
});
