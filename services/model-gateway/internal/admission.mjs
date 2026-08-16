function createRateBucket(ratePerSecond, now) {
  return {
    capacity: ratePerSecond,
    tokens: ratePerSecond,
    lastRefillMs: now(),
  };
}

function refill(bucket, ratePerSecond, now) {
  const current = now();
  const elapsedSeconds = Math.max(0, (current - bucket.lastRefillMs) / 1000);
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSeconds * ratePerSecond);
  bucket.lastRefillMs = current;
}

export function createAdmissionController({ policy, windowMs, now = Date.now }) {
  if (!policy || typeof policy !== "object") {
    throw new TypeError("admission policy is required.");
  }
  const ratePerSecond = policy.maxRatePerSecond;
  const inputBudget = policy.maxInputTokenBudget;
  const outputBudget = policy.maxRequestedOutputTokenBudget;
  const totalQuota = policy.maxTotalTokenQuota;
  const concurrencyLimit = policy.maxConcurrentCalls;
  const costQuotaMicros = policy.maxCostQuotaMicros;
  const buckets = new Map();
  const partitions = new Map();

  function recordFor(partitionKey) {
    let record = partitions.get(partitionKey);
    if (!record) {
      record = { partitionKey, concurrent: 0, window: [] };
      partitions.set(partitionKey, record);
    }
    return record;
  }

  function windowTotals(record) {
    const cutoff = now() - windowMs;
    record.window = record.window.filter((entry) => entry.at > cutoff);
    let tokens = 0;
    let costMicros = 0;
    for (const entry of record.window) {
      tokens += entry.inputTokens + entry.outputTokens;
      costMicros += entry.costMicros;
    }
    return { tokens, costMicros };
  }

  function admit({ partitionKey, inputTokens, requestedOutputTokens, estimatedCostMicros }) {
    const record = recordFor(partitionKey);
    let bucket = buckets.get(partitionKey);
    if (!bucket) {
      bucket = createRateBucket(ratePerSecond, now);
      buckets.set(partitionKey, bucket);
    }
    refill(bucket, ratePerSecond, now);
    if (bucket.tokens < 1) {
      return { ok: false, code: "rate_limited" };
    }
    if (record.concurrent >= concurrencyLimit) {
      return { ok: false, code: "rate_limited" };
    }
    if (inputTokens > inputBudget) {
      return { ok: false, code: "budget_exceeded" };
    }
    if (requestedOutputTokens > outputBudget) {
      return { ok: false, code: "budget_exceeded" };
    }
    const totals = windowTotals(record);
    if (totals.tokens + inputTokens + requestedOutputTokens > totalQuota) {
      return { ok: false, code: "budget_exceeded" };
    }
    if (totals.costMicros + estimatedCostMicros > costQuotaMicros) {
      return { ok: false, code: "quota_exceeded" };
    }
    bucket.tokens -= 1;
    record.concurrent += 1;
    record.window.push({
      at: now(),
      inputTokens,
      outputTokens: requestedOutputTokens,
      costMicros: estimatedCostMicros,
    });
    return { ok: true, partitionKey };
  }

  function release({ partitionKey }) {
    const record = partitions.get(partitionKey);
    if (record && record.concurrent > 0) record.concurrent -= 1;
  }

  return Object.freeze({ admit, release });
}
