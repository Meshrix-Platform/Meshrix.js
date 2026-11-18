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
  const globalConcurrentLimit = policy.maxGlobalConcurrentCalls;
  const subjectConcurrentLimit = policy.maxSubjectConcurrentCalls;
  const globalRequestByteLimit = policy.maxGlobalRequestBytes;
  const subjectRequestByteLimit = policy.maxSubjectRequestBytes;
  const buckets = new Map();
  const partitions = new Map();
  const aggregate = { concurrent: 0, bytes: 0 };
  const subjects = new Map();
  const requestBuckets = new Map();
  const requestGlobalBucket = createRateBucket(policy.maxGlobalRequestRatePerSecond, now);

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
    const reservation = {
      at: now(),
      inputTokens,
      outputTokens: requestedOutputTokens,
      costMicros: estimatedCostMicros,
    };
    record.window.push(reservation);
    return { ok: true, partitionKey, reservation };
  }

  function release({ partitionKey, reservation, refund = false }) {
    const record = partitions.get(partitionKey);
    if (record && record.concurrent > 0) record.concurrent -= 1;
    if (!refund || !record || !reservation) return;
    const index = record.window.indexOf(reservation);
    if (index >= 0) record.window.splice(index, 1);
    const bucket = buckets.get(partitionKey);
    if (bucket) bucket.tokens = Math.min(bucket.capacity, bucket.tokens + 1);
  }

  // Aggregate (service-wide and per-subject) admission. It is decided before
  // the request body is read, so a denied request buffers zero bytes and
  // never reaches a per-model partition or the provider. The returned
  // reservation must be released once the request finishes.
  function admitRequest({ subject, requestBytes = 0 }) {
    const bytes = Number.isSafeInteger(requestBytes) && requestBytes > 0 ? requestBytes : 0;
    if (bytes > subjectRequestByteLimit || bytes > globalRequestByteLimit) {
      return { ok: false, code: "budget_exceeded" };
    }
    const key = String(subject || "");
    let requestBucket = requestBuckets.get(key);
    if (!requestBucket) {
      requestBucket = createRateBucket(policy.maxSubjectRequestRatePerSecond, now);
      requestBuckets.set(key, requestBucket);
    }
    refill(requestGlobalBucket, policy.maxGlobalRequestRatePerSecond, now);
    refill(requestBucket, policy.maxSubjectRequestRatePerSecond, now);
    if (requestGlobalBucket.tokens < 1 || requestBucket.tokens < 1) return { ok: false, code: "rate_limited" };
    let record = subjects.get(key);
    if (!record) {
      record = { concurrent: 0, bytes: 0 };
      subjects.set(key, record);
    }
    if (aggregate.concurrent >= globalConcurrentLimit ||
        record.concurrent >= subjectConcurrentLimit ||
        aggregate.bytes + bytes > globalRequestByteLimit ||
        record.bytes + bytes > subjectRequestByteLimit) {
      return { ok: false, code: "rate_limited" };
    }
    requestGlobalBucket.tokens -= 1;
    requestBucket.tokens -= 1;
    aggregate.concurrent += 1;
    aggregate.bytes += bytes;
    record.concurrent += 1;
    record.bytes += bytes;
    let released = false;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        aggregate.concurrent -= 1;
        aggregate.bytes -= bytes;
        record.concurrent -= 1;
        record.bytes -= bytes;
        if (record.concurrent === 0) subjects.delete(key);
      }
    };
  }

  return Object.freeze({ admit, release, admitRequest });
}
