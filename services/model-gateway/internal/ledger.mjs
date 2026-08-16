function emptyAmount(currency) {
  return { currency, units: 0, nanos: 0 };
}

function isSettled(entry) {
  return entry?.state === "settled";
}

export function createLedger({ state, persist }) {
  const entries = state.ledger;

  async function reconcile() {
    let changed = false;
    for (const entry of Object.values(entries)) {
      if (entry?.state === "released") {
        entry.state = "in_doubt";
        changed = true;
      }
    }
    if (changed) await persist();
    return { changed };
  }

  function get(callId) {
    return entries[callId] ?? null;
  }

  function create({ callId, idempotencyKey, modelRef, pricingRevisionRef, currency, reservationRef }) {
    if (idempotencyKey) {
      const existing = Object.values(entries).find((entry) => entry?.idempotencyKey === idempotencyKey);
      if (existing) return { duplicate: true, entry: existing };
    }
    const known = entries[callId];
    if (known) return { duplicate: true, entry: known };
    const entry = {
      callId,
      idempotencyKey: idempotencyKey ?? null,
      modelRef,
      pricingRevisionRef,
      currency,
      reservationRef,
      state: "released",
      attempts: 1,
      amount: emptyAmount(currency),
      inputTokens: 0,
      outputTokens: 0,
      response: null,
    };
    entries[callId] = entry;
    return { duplicate: false, entry };
  }

  function bumpAttempt(callId) {
    const entry = entries[callId];
    if (!entry) return { changed: false };
    entry.attempts += 1;
    return { changed: true };
  }

  function markSettled(callId, { inputTokens, outputTokens, amount, response }) {
    const entry = entries[callId];
    if (!entry || isSettled(entry)) return { changed: false };
    entry.inputTokens = inputTokens;
    entry.outputTokens = outputTokens;
    entry.amount = amount;
    entry.response = response ?? null;
    entry.state = "settled";
    return { changed: true };
  }

  function markInDoubt(callId) {
    const entry = entries[callId];
    if (!entry || isSettled(entry)) return { changed: false };
    entry.state = "in_doubt";
    return { changed: true };
  }

  return Object.freeze({
    reconcile,
    get,
    create,
    bumpAttempt,
    markSettled,
    markInDoubt,
  });
}
