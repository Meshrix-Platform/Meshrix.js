#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  isRuntimePerformanceObservation,
  MAX_RUNTIME_PERFORMANCE_SAMPLES,
  reduceGatewayPerformanceObservation
} from "./lib/gateway-performance-observation.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportsRoot = path.join(repoRoot, "build", "reports");
const stressScript = path.join(repoRoot, "tools", "server-scripts", "stress-mcp-gateway.mjs");
const observerPreload = path.join(
  repoRoot,
  "tools",
  "server-scripts",
  "lib",
  "runtime-performance-observer-preload.mjs"
);
const DEFAULT_REPORT = "build/reports/gateway-performance-observation.json";
const MAX_REPORT_BYTES = 128 * 1024;

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const parsed = Number(argValue(name, fallback));
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function safeReasonCode(error, fallback = "performance_observation_failed") {
  const value = String(error?.code || error?.reasonCode || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) ? value : fallback;
}

function resolveReportPath(value) {
  if (path.isAbsolute(value)) {
    const error = new Error("The performance report path must be repository-relative.");
    error.code = "PERFORMANCE_REPORT_PATH_INVALID";
    throw error;
  }
  const resolved = path.resolve(repoRoot, value);
  const relative = path.relative(reportsRoot, resolved);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.extname(resolved) !== ".json"
  ) {
    const error = new Error("The performance report must be a JSON file under build/reports.");
    error.code = "PERFORMANCE_REPORT_PATH_INVALID";
    throw error;
  }
  return resolved;
}

function createChildEnvironment(runRoot, intervalMs) {
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  return {
    ...environment,
    NO_COLOR: "1",
    TMPDIR: runRoot,
    LICO_PERFORMANCE_OBSERVER_INTERVAL_MS: String(intervalMs)
  };
}

function waitForChild(child, timeoutMs) {
  return new Promise((resolve) => {
    let timedOut = false;
    let forceTimer = null;
    let hardTimer = null;
    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve(result);
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        hardTimer = setTimeout(() => {
          const error = new Error("The load process did not stop within its termination budget.");
          error.code = "LOAD_PROCESS_TERMINATION_TIMEOUT";
          finish({ exitCode: null, timedOut: true, error });
        }, 2_000);
        hardTimer.unref();
      }, 2_000);
      forceTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      finish({ exitCode: null, timedOut, error });
    });
    child.once("exit", (exitCode) => {
      finish({ exitCode, timedOut, error: null });
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForChild(child, 2_000);
}

async function readPrivateLoadReport(reportPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(reportPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomically(filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) {
    const error = new Error("The bounded performance report exceeded its byte budget.");
    error.code = "PERFORMANCE_REPORT_BUDGET_EXCEEDED";
    throw error;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fs.writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, filePath);
}

const concurrency = boundedInteger("--concurrency", 8, 1, 512);
// Observed smoke proves the probe path, not capacity. Keep the default workload
// small enough to complete on every supported developer machine within the
// fixed per-phase deadline; capacity profiles own larger request counts.
const requests = boundedInteger("--requests", 40, 1, 100_000);
const durationMs = boundedInteger("--duration-ms", 8_000, 1_000, 600_000);
const observerIntervalMs = boundedInteger("--observer-interval-ms", 100, 50, 5_000);
const timeoutMs = boundedInteger(
  "--timeout-ms",
  Math.min(600_000, durationMs * 4 + 30_000),
  5_000,
  600_000
);
const reportPath = resolveReportPath(argValue("--report", DEFAULT_REPORT));
const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lico-performance-observation-"));
const privateLoadReportPath = path.join(runRoot, "mcp-gateway-load.json");
const observations = [];
let droppedObservationCount = 0;
let invalidObservationCount = 0;
let child = null;

try {
  child = spawn(process.execPath, [
    "--import",
    observerPreload,
    stressScript,
    "--concurrency",
    String(concurrency),
    "--requests",
    String(requests),
    "--duration-ms",
    String(durationMs),
    "--report",
    privateLoadReportPath
  ], {
    cwd: repoRoot,
    env: createChildEnvironment(runRoot, observerIntervalMs),
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });

  child.on("message", (message) => {
    if (!message || message.kind !== "lico.performance.runtime-observation") return;
    if (!isRuntimePerformanceObservation(message)) {
      invalidObservationCount += 1;
      return;
    }
    if (observations.length >= MAX_RUNTIME_PERFORMANCE_SAMPLES) {
      droppedObservationCount += 1;
      return;
    }
    observations.push(message);
  });

  const childResult = await waitForChild(child, timeoutMs);
  const loadReport = await readPrivateLoadReport(privateLoadReportPath);
  const report = reduceGatewayPerformanceObservation({
    loadReport,
    observations,
    childExitCode: childResult.exitCode,
    childTimedOut: childResult.timedOut,
    droppedObservationCount,
    invalidObservationCount,
    observerIntervalMs
  });

  if (childResult.error) {
    report.summary.violations.push(safeReasonCode(childResult.error, "load_process_spawn_failed"));
    report.summary.observedSmokeReady = false;
  }

  const serialized = JSON.stringify(report);
  if (serialized.includes(runRoot) || serialized.includes(os.homedir())) {
    const error = new Error("The performance report contained private local information.");
    error.code = "PERFORMANCE_REPORT_PRIVACY_FAILED";
    throw error;
  }

  await writeJsonAtomically(reportPath, report);
  console.log(
    `[gateway-performance] observedSmokeReady=${report.summary.observedSmokeReady} ` +
    `capacityCertified=${report.summary.capacityCertified} ` +
    `samples=${report.observation.sampleCount} ` +
    `violations=${report.summary.violations.length}`
  );
  if (!report.summary.observedSmokeReady) process.exitCode = 1;
} catch (error) {
  console.error(`[gateway-performance] failed reasonCode=${safeReasonCode(error)}`);
  process.exitCode = 1;
} finally {
  await stopChild(child).catch(() => null);
  await fs.rm(runRoot, { recursive: true, force: true });
}
