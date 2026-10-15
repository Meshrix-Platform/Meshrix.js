const NANOS_PER_UNIT = 1_000_000_000n;
const NANOS_PER_MICRO = 1_000n;
const MAX_SAFE_MICROS = BigInt(Number.MAX_SAFE_INTEGER);
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

function assertSafeNonNegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
}

function assertNonNegativeBigInt(value, label) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError(`${label} must be a non-negative bigint.`);
  }
}

export function validateCurrency(currency) {
  return typeof currency === "string" && CURRENCY_PATTERN.test(currency);
}

export function amountToNanos(amount) {
  if (!amount || typeof amount !== "object" || Array.isArray(amount)) {
    throw new TypeError("amount must be a fixed-point object.");
  }
  if (!validateCurrency(amount.currency)) {
    throw new TypeError("amount.currency must match ^[A-Z]{3}$.");
  }
  assertSafeNonNegative(amount.units, "amount.units");
  assertSafeNonNegative(amount.nanos, "amount.nanos");
  if (amount.nanos > 999_999_999) {
    throw new TypeError("amount.nanos must be at most 999999999.");
  }
  return BigInt(amount.units) * NANOS_PER_UNIT + BigInt(amount.nanos);
}

export function nanosToMicrosCeil(nanos) {
  assertNonNegativeBigInt(nanos, "nanos");
  const micros = (nanos + NANOS_PER_MICRO - 1n) / NANOS_PER_MICRO;
  if (micros > MAX_SAFE_MICROS) throw new RangeError("Fixed-point charge exceeds the safe integer range.");
  return Number(micros);
}

export function microsToAmount(currency, micros) {
  if (!validateCurrency(currency)) {
    throw new TypeError("currency must match ^[A-Z]{3}$.");
  }
  assertSafeNonNegative(micros, "micros");
  return {
    currency,
    units: Math.floor(micros / 1_000_000),
    nanos: (micros % 1_000_000) * 1_000,
  };
}

export function mulNanos(rateNanos, tokens) {
  assertNonNegativeBigInt(rateNanos, "rateNanos");
  assertSafeNonNegative(tokens, "tokens");
  return rateNanos * BigInt(tokens);
}

export function addNanos(...values) {
  return values.reduce((sum, value) => {
    assertNonNegativeBigInt(value, "nanos");
    return sum + value;
  }, 0n);
}
