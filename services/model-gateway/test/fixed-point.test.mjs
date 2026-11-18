import assert from "node:assert/strict";
import test from "node:test";

import {
  addNanos,
  amountToNanos,
  microsToAmount,
  mulNanos,
  nanosToMicrosCeil
} from "../internal/fixed-point.mjs";

test("token rates preserve exact nanounits and round the aggregate ledger charge up once", () => {
  const rate = amountToNanos({ currency: "USD", units: 0, nanos: 3 });
  const totalNanos = addNanos(mulNanos(rate, 1), mulNanos(rate, 1));
  assert.equal(totalNanos, 6n);
  const chargeMicros = nanosToMicrosCeil(totalNanos);
  assert.equal(chargeMicros, 1);
  assert.deepEqual(microsToAmount("USD", chargeMicros), { currency: "USD", units: 0, nanos: 1_000 });
});

test("pricing and charge arithmetic reject malformed values and bounded overflow", () => {
  assert.throws(() => amountToNanos({ currency: "usd", units: 0, nanos: 3 }), /currency/u);
  assert.throws(() => amountToNanos({ currency: "USD", units: 0, nanos: 1_000_000_000 }), /at most/u);
  assert.throws(() => nanosToMicrosCeil(BigInt(Number.MAX_SAFE_INTEGER) * 1_000n + 1_000n), /safe integer range/u);
});
