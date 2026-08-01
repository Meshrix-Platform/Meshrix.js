import process from "node:process";
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver
} from "node:perf_hooks";

import {
  RUNTIME_PERFORMANCE_OBSERVATION_KIND,
  RUNTIME_PERFORMANCE_OBSERVATION_SCHEMA_VERSION
} from "./runtime-performance-observation-contract.ts";

function boundedInteger(value?: any, fallback?: any, minimum?: any, maximum?: any) : any {
  const parsed: any = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function finite(value?: any, fallback: any = 0) : any {
  return Number.isFinite(value) ? value : fallback;
}

function round(value?: any, digits: any = 4) : any {
  return Number(finite(value).toFixed(digits));
}

function nanosecondsToMilliseconds(value?: any) : any {
  return round(Number(value || 0) / 1_000_000, 4);
}

const intervalMs: any = boundedInteger(
  process.env.MESHRIX_PERFORMANCE_OBSERVER_INTERVAL_MS,
  100,
  50,
  5_000
);
const eventLoopDelay: any = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

let sequence: any = 0;
let backpressureSignals: any = 0;
let previousCpu: any = process.cpuUsage();
let previousWallTime: any = performance.now();
let previousElu: any = performance.eventLoopUtilization();
let gcCount: any = 0;
let gcDurationMs: any = 0;
let gcMaxDurationMs: any = 0;
let closed: any = false;

const gcSupported: any = ((PerformanceObserver as any).supportedEntryTypes || []).includes("gc");
const gcObserver: any = gcSupported
  ? new PerformanceObserver((list?: any) : any => {
      for (const entry of list.getEntries()) {
        const duration: any = Math.max(0, finite(entry.duration));
        gcCount += 1;
        gcDurationMs += duration;
        gcMaxDurationMs = Math.max(gcMaxDurationMs, duration);
      }
    })
  : null;

gcObserver?.observe({ entryTypes: ["gc"] });

function sendObservation(observation?: any) : any {
  if (typeof process.send !== "function" || !process.connected) return;
  try {
    const accepted: any = process.send(observation, (error?: any) : any => {
      if (error) backpressureSignals += 1;
    });
    if (!accepted) backpressureSignals += 1;
  } catch {
    backpressureSignals += 1;
  }
}

function sample(reason: any = "interval") : any {
  if (closed && reason !== "final") return;
  const now: any = performance.now();
  const elapsedMs: any = Math.max(0.001, now - previousWallTime);
  const cpu: any = process.cpuUsage(previousCpu);
  const currentElu: any = performance.eventLoopUtilization();
  const elu: any = performance.eventLoopUtilization(currentElu, previousElu);
  const memory: any = process.memoryUsage();
  const histogramCount: any = Number(eventLoopDelay.count || 0);

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

const timer: any = setInterval(() : any => sample("interval"), intervalMs);
timer.unref();

process.once("beforeExit", () : any => {
  if (closed) return;
  closed = true;
  sample("final");
  clearInterval(timer);
  eventLoopDelay.disable();
  gcObserver?.disconnect();
});
