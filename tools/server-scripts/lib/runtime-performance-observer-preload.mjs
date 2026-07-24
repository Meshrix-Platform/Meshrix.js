import process from "node:process";
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver
} from "node:perf_hooks";

import {
  RUNTIME_PERFORMANCE_OBSERVATION_KIND,
  RUNTIME_PERFORMANCE_OBSERVATION_SCHEMA_VERSION
} from "./runtime-performance-observation-contract.mjs";

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function round(value, digits = 4) {
  return Number(finite(value).toFixed(digits));
}

function nanosecondsToMilliseconds(value) {
  return round(Number(value || 0) / 1_000_000, 4);
}

const intervalMs = boundedInteger(
  process.env.MESHRIX_PERFORMANCE_OBSERVER_INTERVAL_MS,
  100,
  50,
  5_000
);
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

let sequence = 0;
let backpressureSignals = 0;
let previousCpu = process.cpuUsage();
let previousWallTime = performance.now();
let previousElu = performance.eventLoopUtilization();
let gcCount = 0;
let gcDurationMs = 0;
let gcMaxDurationMs = 0;
let closed = false;

const gcSupported = PerformanceObserver.supportedEntryTypes.includes("gc");
const gcObserver = gcSupported
  ? new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const duration = Math.max(0, finite(entry.duration));
        gcCount += 1;
        gcDurationMs += duration;
        gcMaxDurationMs = Math.max(gcMaxDurationMs, duration);
      }
    })
  : null;

gcObserver?.observe({ entryTypes: ["gc"] });

function sendObservation(observation) {
  if (typeof process.send !== "function" || !process.connected) return;
  try {
    const accepted = process.send(observation, (error) => {
      if (error) backpressureSignals += 1;
    });
    if (!accepted) backpressureSignals += 1;
  } catch {
    backpressureSignals += 1;
  }
}

function sample(reason = "interval") {
  if (closed && reason !== "final") return;
  const now = performance.now();
  const elapsedMs = Math.max(0.001, now - previousWallTime);
  const cpu = process.cpuUsage(previousCpu);
  const currentElu = performance.eventLoopUtilization();
  const elu = performance.eventLoopUtilization(currentElu, previousElu);
  const memory = process.memoryUsage();
  const histogramCount = Number(eventLoopDelay.count || 0);

  sendObservation({
    kind: RUNTIME_PERFORMANCE_OBSERVATION_KIND,
    schemaVersion: RUNTIME_PERFORMANCE_OBSERVATION_SCHEMA_VERSION,
    sequence: ++sequence,
    reason,
    intervalMs: round(elapsedMs, 3),
    cpu: {
      ratioOneCore: round((cpu.user + cpu.system) / (elapsedMs * 1_000), 6)
    },
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBufferBytes: memory.arrayBuffers
    },
    eventLoop: {
      utilization: round(elu.utilization, 6),
      delaySampleCount: histogramCount,
      p50Ms: histogramCount > 0
        ? nanosecondsToMilliseconds(eventLoopDelay.percentile(50))
        : 0,
      p95Ms: histogramCount > 0
        ? nanosecondsToMilliseconds(eventLoopDelay.percentile(95))
        : 0,
      p99Ms: histogramCount > 0
        ? nanosecondsToMilliseconds(eventLoopDelay.percentile(99))
        : 0,
      maxMs: histogramCount > 0
        ? nanosecondsToMilliseconds(eventLoopDelay.max)
        : 0
    },
    gc: {
      supported: gcSupported,
      count: gcCount,
      durationMs: round(gcDurationMs, 4),
      maxDurationMs: round(gcMaxDurationMs, 4)
    },
    ipc: {
      backpressureSignals
    }
  });

  previousCpu = process.cpuUsage();
  previousWallTime = now;
  previousElu = currentElu;
  gcCount = 0;
  gcDurationMs = 0;
  gcMaxDurationMs = 0;
  eventLoopDelay.reset();
}

const timer = setInterval(() => sample("interval"), intervalMs);
timer.unref();

process.once("beforeExit", () => {
  if (closed) return;
  closed = true;
  sample("final");
  clearInterval(timer);
  eventLoopDelay.disable();
  gcObserver?.disconnect();
});
