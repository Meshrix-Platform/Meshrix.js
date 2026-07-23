import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
  isRuntimePerformanceObservation,
  reduceGatewayPerformanceObservation
} from "../../../tools/server-scripts/lib/gateway-performance-observation.mjs";
import {
  RUNTIME_PERFORMANCE_OBSERVATION_SCHEMA_VERSION
} from "../../../tools/server-scripts/lib/runtime-performance-observation-contract.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const preloadPath = path.join(
  repoRoot,
  "tools",
  "server-scripts",
  "lib",
  "runtime-performance-observer-preload.mjs"
);

function observation(sequence, overrides = {}) {
  return {
    kind: "lico.performance.runtime-observation",
    schemaVersion: RUNTIME_PERFORMANCE_OBSERVATION_SCHEMA_VERSION,
    sequence,
    reason: "interval",
    intervalMs: 100,
    cpu: { ratioOneCore: 0.4 },
    memory: {
      rssBytes: 100,
      heapUsedBytes: 50,
      externalBytes: 10,
      arrayBufferBytes: 5
    },
    eventLoop: {
      utilization: 0.5,
      delaySampleCount: 4,
      p50Ms: 1,
      p95Ms: 2,
      p99Ms: 3,
      maxMs: 4
    },
    gc: { supported: true, count: 1, durationMs: 2, maxDurationMs: 2 },
    ipc: { backpressureSignals: 0 },
    ...overrides
  };
}

function loadReport() {
  return {
    releaseReady: true,
    options: {
      concurrency: 8,
      requests: 120,
      durationMs: 8_000,
      reportPath: "should-not-be-projected"
    },
    phases: [
      {
        name: "downstream-mcp-system-health",
        issued: 120,
        completed: 120,
        ok: 120,
        failed: 0,
        durationMs: 500,
        requestsPerSecond: 240,
        p50Ms: 2,
        p95Ms: 5,
        safetyStop: false
      }
    ],
    summary: {
      reportLeakScan: true,
      resourceSafetyCutoff: false
    }
  };
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("observer fixture timed out"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

describe("gateway performance observation", () => {
  it("reduces only bounded numeric observations and never certifies capacity", () => {
    const report = reduceGatewayPerformanceObservation({
      loadReport: loadReport(),
      observations: [
        observation(1),
        observation(2, {
          cpu: { ratioOneCore: 0.8 },
          memory: {
            rssBytes: 150,
            heapUsedBytes: 80,
            externalBytes: 15,
            arrayBufferBytes: 6
          }
        })
      ],
      childExitCode: 0,
      observerIntervalMs: 100,
      generatedAt: "2026-01-01T00:00:00.000Z"
    });

    assert.equal(report.summary.observedSmokeReady, true);
    assert.equal(report.summary.capacityCertified, false);
    assert.equal(report.observation.sampleCount, 2);
    assert.equal(report.observation.peakCpuRatioOneCore, 0.8);
    assert.equal(report.observation.peakRssBytes, 150);
    assert.equal(JSON.stringify(report).includes("should-not-be-projected"), false);
  });

  it("fails closed when observation coverage is incomplete", () => {
    const report = reduceGatewayPerformanceObservation({
      loadReport: loadReport(),
      observations: [observation(1)],
      childExitCode: 0,
      observerIntervalMs: 100
    });

    assert.equal(report.summary.observedSmokeReady, false);
    assert.ok(report.summary.violations.includes("runtime_observation_incomplete"));
  });

  it("rejects negative or non-numeric runtime samples", () => {
    assert.equal(isRuntimePerformanceObservation(observation(1, {
      cpu: { ratioOneCore: -1 }
    })), false);
    assert.equal(isRuntimePerformanceObservation(observation(1, {
      eventLoop: {
        utilization: "invalid",
        delaySampleCount: 4,
        p50Ms: 1,
        p95Ms: 2,
        p99Ms: 3,
        maxMs: 4
      }
    })), false);
  });

  it("collects event-loop, CPU, memory, and GC observations through private IPC", async () => {
    const messages = [];
    const environment = { ...process.env };
    delete environment.NODE_OPTIONS;
    environment.LICO_PERFORMANCE_OBSERVER_INTERVAL_MS = "50";
    const child = spawn(process.execPath, [
      "--import",
      preloadPath,
      "--eval",
      "setTimeout(() => { const until = Date.now() + 30; while (Date.now() < until) {} }, 60); setTimeout(() => {}, 260);"
    ], {
      cwd: repoRoot,
      env: environment,
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    child.on("message", (message) => messages.push(message));

    assert.equal(await waitForExit(child), 0);
    assert.ok(messages.length >= 2);
    assert.ok(messages.every(isRuntimePerformanceObservation));
    assert.ok(messages.some((message) => message.eventLoop.delaySampleCount > 0));
    assert.ok(messages.every((message) => message.gc.supported === true));
  });
});
