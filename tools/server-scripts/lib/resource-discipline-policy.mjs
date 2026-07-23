const KIB = 1024;
const MIB = 1024 * KIB;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export const RESOURCE_DISCIPLINE_POLICY = deepFreeze({
  id: "resource-discipline",
  priority: "p0-non-negotiable",
  logging: {
    requiredDefaultLevel: "info",
    maxLoadGrowthBytes: 64 * KIB,
    maxLoadRecordGrowth: 8,
    maxRuntimeRecordBytes: 64 * KIB,
    routineProbePersistence: "forbidden"
  },
  persistence: {
    maxLoadGrowthBytes: 2 * MIB,
    unboundedAppend: "forbidden",
    requireAgeLimit: true,
    requireByteLimit: true,
    requireCardinalityLimit: true,
    requireRecordLimit: true
  },
  memoryLeak: {
    framework: "@datadog/pprof",
    frameworkVersion: "5.16.0",
    toolCacheRetention: "preserve-local",
    diagnosticArtifactRetention: "temporary-private",
    warmupRequests: 256,
    measurementRounds: 6,
    requestsPerRound: 384,
    concurrency: 32,
    gcPasses: 3,
    heapProfileIntervalBytes: 256 * KIB,
    heapProfileStackDepth: 64,
    maxHeapGrowthBytes: 8 * MIB,
    maxHeapSlopeBytesPerRequest: 2 * KIB,
    maxProfileGrowthBytes: 16 * MIB,
    maxProfileSlopeBytesPerRequest: 4 * KIB,
    maxExternalGrowthBytes: 16 * MIB,
    maxRssGrowthBytes: 128 * MIB,
    maxFailureProfileBytes: 8 * MIB,
    requestTimeoutMs: 5_000,
    startupTimeoutMs: 30_000,
    sampleTimeoutMs: 15_000,
    shutdownTimeoutMs: 15_000
  }
});
