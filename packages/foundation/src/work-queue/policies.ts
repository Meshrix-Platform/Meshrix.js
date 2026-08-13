import { createHash } from "node:crypto";

export const WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT: any = 8192;

export const DEFAULT_QUEUE_POLICY: Readonly<Record<string, any>> = Object.freeze({
  policyVersion: "v0.0.1:workflow:work-queue-default-1",
  leaseTimeoutMs: 30_000,
  maxInFlight: 1000,
  maxAttempts: 16,
  workExpiry: Object.freeze({
    defaultLifetimeMs: 7 * 24 * 60 * 60 * 1000,
    maxLifetimeMs: 30 * 24 * 60 * 60 * 1000
  }),
  retryBackoff: Object.freeze({
    strategy: "exponential",
    initialDelayMs: 1_000,
    multiplier: 2,
    maxDelayMs: 300_000,
    jitter: "deterministic_sha256",
    retrySeed: "meshrix-work-queue-retry",
    maxJitterBps: 2000
  }),
  fallbackRetry: Object.freeze({
    maxAttempts: 3,
    initialDelayMs: 250,
    multiplier: 2,
    maxDelayMs: 5_000
  }),
  backgroundWriteRetry: Object.freeze({
    maxAttempts: 5,
    initialDelayMs: 100,
    multiplier: 2,
    maxDelayMs: 10_000
  }),
  memoryGuard: Object.freeze({
    maxInMemoryFallbackTasks: 1024,
    maxPendingBackgroundWrites: 4096
  }),
  capacity: Object.freeze({
    maxPayloadRefBytes: 16 * 1024,
    maxOutstanding: 10_000,
    maxOutstandingPerTenant: 2_000,
    maxOutstandingPerWorkspace: 1_000,
    maxOutstandingPerProject: 500,
    maxDelayed: 5_000,
    maxLeased: 1_000,
    maxLeasedPerTenant: 256,
    maxLeasedPerWorkspace: 128,
    maxLeasedPerProject: 64,
    maxFailed: 2_000
  }),
  retention: Object.freeze({
    maxTerminalItems: 5_000,
    maxJournalEntries: 200_000,
    maxTransitionsPerWorkItem: 64,
    cleanupBatchSize: 128
  }),
  fairness: Object.freeze({
    agingIntervalMs: 60_000,
    agingBatchSize: 128,
    minReservedLeasesPerPartition: 1,
    reservationScanLimit: 256
  })
});

function asInt(value?: any, fallback: any = 0) : any {
  const parsed: any = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function resolveQueueMaxInFlight(value?: any, { fallback = DEFAULT_QUEUE_POLICY.maxInFlight }: Record<string, any> = {}) : any {
  const fallbackLimit: any = Math.max(1, asInt(fallback, DEFAULT_QUEUE_POLICY.maxInFlight));
  const requested: any = asInt(value ?? fallbackLimit, fallbackLimit);
  const normalizedRequested: any = Math.max(1, requested);
  const limit: any = Math.min(normalizedRequested, WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT);
  return Object.freeze({
    requested,
    normalizedRequested,
    limit,
    hardLimit: WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT,
    clamped: normalizedRequested !== limit
  });
}

export function normalizeQueueMaxInFlight(value?: any, fallback: any = DEFAULT_QUEUE_POLICY.maxInFlight) : any {
  return resolveQueueMaxInFlight(value, { fallback }).limit;
}

export function computeDeterministicBackoff({
  attempt,
  initialDelayMs = DEFAULT_QUEUE_POLICY.retryBackoff.initialDelayMs,
  multiplier = DEFAULT_QUEUE_POLICY.retryBackoff.multiplier,
  maxDelayMs = DEFAULT_QUEUE_POLICY.retryBackoff.maxDelayMs
}: Record<string, any> = {}) : any {
  const safeAttempt: any = Math.max(1, Math.trunc(Number(attempt || 1)));
  const delay: any = Number(initialDelayMs) * Math.pow(Number(multiplier), safeAttempt - 1);
  return Math.min(Math.trunc(delay), Math.trunc(Number(maxDelayMs)));
}

export function computeDeterministicRetryDelay({
  queueDefinitionId = "",
  workItemId = "",
  attempt,
  retrySeed = DEFAULT_QUEUE_POLICY.retryBackoff.retrySeed,
  maxJitterBps = DEFAULT_QUEUE_POLICY.retryBackoff.maxJitterBps,
  ...backoff
}: Record<string, any> = {}) : any {
  const baseDelayMs: any = computeDeterministicBackoff({ attempt, ...backoff });
  const boundedJitterBps: any = Math.max(0, Math.min(10_000, asInt(maxJitterBps, 0)));
  const jitterCeilingMs: any = Math.floor((baseDelayMs * boundedJitterBps) / 10_000);
  if (jitterCeilingMs <= 0) return baseDelayMs;
  const digest: any = createHash("sha256")
    .update(`${retrySeed}\0${queueDefinitionId}\0${workItemId}\0${Math.max(1, asInt(attempt, 1))}`)
    .digest();
  const jitterMs: any = digest.readUInt32BE(0) % (jitterCeilingMs + 1);
  return baseDelayMs + jitterMs;
}
