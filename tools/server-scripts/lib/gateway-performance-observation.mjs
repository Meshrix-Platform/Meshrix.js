import {
  RUNTIME_PERFORMANCE_OBSERVATION_KIND,
  RUNTIME_PERFORMANCE_OBSERVATION_SCHEMA_VERSION
} from "./runtime-performance-observation-contract.mjs";

export const GATEWAY_PERFORMANCE_OBSERVATION_SCHEMA =
  "v0.0.1:performance:gateway-observation-report-1";
export const MAX_RUNTIME_PERFORMANCE_SAMPLES = 4_096;
const MIN_RUNTIME_PERFORMANCE_SAMPLES = 2;
const MAX_PHASES = 16;

function finiteNumber(value, fallback = 0, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? number : fallback;
}

function count(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function round(value, digits = 4) {
  return Number(finiteNumber(value).toFixed(digits));
}

function peak(values) {
  return values.length > 0 ? Math.max(...values) : 0;
}

function safePhaseName(value, index) {
  const name = String(value || "");
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(name)
    ? name
    : `phase-${index + 1}`;
}

function numericFieldsAreValid(value, fields) {
  return fields.every((field) => {
    const number = Number(value?.[field]);
    return Number.isFinite(number) && number >= 0;
  });
}

export function isRuntimePerformanceObservation(value) {
  return Boolean(
    value &&
    value.kind === RUNTIME_PERFORMANCE_OBSERVATION_KIND &&
    value.schemaVersion === RUNTIME_PERFORMANCE_OBSERVATION_SCHEMA_VERSION &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    numericFieldsAreValid(value.cpu, ["ratioOneCore"]) &&
    numericFieldsAreValid(value.memory, [
      "rssBytes",
      "heapUsedBytes",
      "externalBytes",
      "arrayBufferBytes"
    ]) &&
    numericFieldsAreValid(value.eventLoop, [
      "utilization",
      "delaySampleCount",
      "p50Ms",
      "p95Ms",
      "p99Ms",
      "maxMs"
    ]) &&
    typeof value.gc?.supported === "boolean" &&
    numericFieldsAreValid(value.gc, ["count", "durationMs", "maxDurationMs"]) &&
    numericFieldsAreValid(value.ipc, ["backpressureSignals"])
  );
}

function projectPhases(loadReport) {
  const source = Array.isArray(loadReport?.phases) ? loadReport.phases : [];
  return source.slice(0, MAX_PHASES).map((phase, index) => ({
    name: safePhaseName(phase?.name, index),
    issued: count(phase?.issued),
    completed: count(phase?.completed),
    ok: count(phase?.ok),
    failed: count(phase?.failed),
    durationMs: round(phase?.durationMs, 3),
    requestsPerSecond: round(phase?.requestsPerSecond, 3),
    p50Ms: round(phase?.p50Ms, 3),
    p95Ms: round(phase?.p95Ms, 3),
    safetyStop: phase?.safetyStop === true
  }));
}

function aggregateObservations(observations) {
  const valid = observations.filter(isRuntimePerformanceObservation);
  return {
    valid,
    aggregate: {
      sampleCount: valid.length,
      peakCpuRatioOneCore: round(peak(valid.map((sample) => sample.cpu.ratioOneCore)), 6),
      peakRssBytes: count(peak(valid.map((sample) => sample.memory.rssBytes))),
      peakHeapUsedBytes: count(peak(valid.map((sample) => sample.memory.heapUsedBytes))),
      peakExternalBytes: count(peak(valid.map((sample) => sample.memory.externalBytes))),
      peakArrayBufferBytes: count(peak(valid.map((sample) => sample.memory.arrayBufferBytes))),
      peakEventLoopUtilization: round(
        peak(valid.map((sample) => sample.eventLoop.utilization)),
        6
      ),
      eventLoopDelay: {
        peakIntervalP50Ms: round(
          peak(valid.map((sample) => sample.eventLoop.p50Ms)),
          4
        ),
        peakIntervalP95Ms: round(
          peak(valid.map((sample) => sample.eventLoop.p95Ms)),
          4
        ),
        peakIntervalP99Ms: round(
          peak(valid.map((sample) => sample.eventLoop.p99Ms)),
          4
        ),
        maxMs: round(peak(valid.map((sample) => sample.eventLoop.maxMs)), 4)
      },
      gc: {
        supported: valid.length > 0 && valid.every((sample) => sample.gc.supported),
        count: valid.reduce((total, sample) => total + count(sample.gc.count), 0),
        durationMs: round(
          valid.reduce((total, sample) => total + finiteNumber(sample.gc.durationMs), 0),
          4
        ),
        maxDurationMs: round(
          peak(valid.map((sample) => sample.gc.maxDurationMs)),
          4
        )
      },
      ipcBackpressureSignals: count(
        peak(valid.map((sample) => sample.ipc.backpressureSignals))
      )
    }
  };
}

export function reduceGatewayPerformanceObservation({
  loadReport,
  observations = [],
  childExitCode = null,
  childTimedOut = false,
  droppedObservationCount = 0,
  invalidObservationCount = 0,
  observerIntervalMs = 0,
  generatedAt = new Date().toISOString()
} = {}) {
  const boundedObservations = observations.slice(0, MAX_RUNTIME_PERFORMANCE_SAMPLES);
  const { valid, aggregate } = aggregateObservations(boundedObservations);
  const phases = projectPhases(loadReport);
  const configuredRequests = count(loadReport?.options?.requests);
  const violations = [];

  if (!loadReport || typeof loadReport !== "object") {
    violations.push("load_report_missing");
  }
  if (childTimedOut) violations.push("load_process_timed_out");
  if (childExitCode !== 0) violations.push("load_process_failed");
  if (loadReport?.releaseReady !== true) violations.push("load_smoke_failed");
  if (loadReport?.summary?.reportLeakScan !== true) {
    violations.push("load_report_privacy_unverified");
  }
  if (loadReport?.summary?.resourceSafetyCutoff === true) {
    violations.push("resource_safety_cutoff");
  }
  if (phases.length === 0) violations.push("load_phases_missing");
  if (Array.isArray(loadReport?.phases) && loadReport.phases.length > MAX_PHASES) {
    violations.push("load_phase_limit_exceeded");
  }
  if (
    configuredRequests > 0 &&
    phases.some((phase) => phase.completed !== configuredRequests)
  ) {
    violations.push("load_phase_incomplete");
  }
  if (valid.length < MIN_RUNTIME_PERFORMANCE_SAMPLES) {
    violations.push("runtime_observation_incomplete");
  }
  if (valid.length !== boundedObservations.length || invalidObservationCount > 0) {
    violations.push("runtime_observation_invalid");
  }
  if (observations.length > MAX_RUNTIME_PERFORMANCE_SAMPLES) {
    violations.push("runtime_observation_limit_exceeded");
  }
  if (!aggregate.gc.supported) violations.push("gc_observation_unavailable");
  if (droppedObservationCount > 0 || aggregate.ipcBackpressureSignals > 0) {
    violations.push("runtime_observation_dropped");
  }

  return {
    schemaVersion: GATEWAY_PERFORMANCE_OBSERVATION_SCHEMA,
    generatedAt,
    verifier: "tools/server-scripts/observe-mcp-gateway-load.mjs",
    claim: "observed_smoke",
    workload: {
      concurrency: count(loadReport?.options?.concurrency),
      requestsPerPhase: configuredRequests,
      durationLimitMs: count(loadReport?.options?.durationMs),
      phaseCount: phases.length,
      phases
    },
    observation: {
      intervalMs: count(observerIntervalMs),
      droppedSampleCount: count(droppedObservationCount),
      invalidSampleCount: count(invalidObservationCount),
      ...aggregate
    },
    privacy: {
      boundedProjection: true,
      rawChildOutputRetained: false,
      rawRuntimeDataRetained: false,
      requestOrResponseBodiesRetained: false
    },
    summary: {
      observedSmokeReady: violations.length === 0,
      capacityCertified: false,
      violations
    }
  };
}
