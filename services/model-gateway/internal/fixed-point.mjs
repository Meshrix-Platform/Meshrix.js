const MICROS_PER_UNIT = 1_000_000;
const NANOS_PER_MICRO = 1_000;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

function assertSafeNonNegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
}

export function validateCurrency(currency) {
  return typeof currency === "string" && CURRENCY_PATTERN.test(currency);
}

export function amountToMicros(amount) {
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
  return amount.units * MICROS_PER_UNIT + Math.floor(amount.nanos / NANOS_PER_MICRO);
}

export function microsToAmount(currency, micros) {
  if (!validateCurrency(currency)) {
    throw new TypeError("currency must match ^[A-Z]{3}$.");
  }
  assertSafeNonNegative(micros, "micros");
  return {
    currency,
    units: Math.floor(micros / MICROS_PER_UNIT),
    nanos: (micros % MICROS_PER_UNIT) * NANOS_PER_MICRO,
  };
}

export function mulMicros(rateMicros, tokens) {
  assertSafeNonNegative(rateMicros, "rateMicros");
  assertSafeNonNegative(tokens, "tokens");
  const product = BigInt(rateMicros) * BigInt(tokens);
  if (product > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Fixed-point product exceeds the safe integer range.");
  }
  return Number(product);
}

export function addMicros(...values) {
  const total = values.reduce((sum, value) => {
    assertSafeNonNegative(value, "micros");
    return sum + BigInt(value);
  }, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Fixed-point sum exceeds the safe integer range.");
  }
  return Number(total);
}
