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
} from "./lib/gateway-performance-observation.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportsRoot: any = path.join(repoRoot, "build", "reports");
const stressScript: any = path.join(repoRoot, "tools", "server-scripts", "stress-mcp-gateway.ts");
const observerPreload: any = path.join(
  repoRoot,
  "tools",
  "server-scripts",
  "lib",
  "runtime-performance-observer-preload.ts"
);
const DEFAULT_REPORT: any = "build/reports/gateway-performance-observation.json";
const MAX_REPORT_BYTES: any = 128 * 1024;

function argValue(name?: any, fallback: any = "") : any {
  const index: any = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function boundedInteger(name?: any, fallback?: any, minimum?: any, maximum?: any) : any {
  const parsed: any = Number(argValue(name, fallback));
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function safeReasonCode(error?: any, fallback: any = "performance_observation_failed") : any {
  const value: any = String(error?.code || error?.reasonCode || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) ? value : fallback;
}

function resolveReportPath(value?: any) : any {
  if (path.isAbsolute(value)) {
    const error: Error & Record<string, any> = new Error("The performance report path must be repository-relative.");
    error.code = "PERFORMANCE_REPORT_PATH_INVALID";
    throw error;
  }
  const resolved: any = path.resolve(repoRoot, value);
  const relative: any = path.relative(reportsRoot, resolved);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.extname(resolved) !== ".json"
  ) {
    const error: Error & Record<string, any> = new Error("The performance report must be a JSON file under build/reports.");
    error.code = "PERFORMANCE_REPORT_PATH_INVALID";
    throw error;
  }
  return resolved;
}

function createChildEnvironment(runRoot?: any, intervalMs?: any) : any {
  const environment: Record<string, any> = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.ELECTRON_RUN_AS_NODE;
  return {
    ...environment,
    NO_COLOR: "1",
    TMPDIR: runRoot,
    MESHRIX_PERFORMANCE_OBSERVER_INTERVAL_MS: String(intervalMs)
  };
}

function waitForChild(child?: any, timeoutMs?: any) : any {
  return new Promise((resolve?: any) : any => {
    let timedOut: any = false;
    let forceTimer: any = null;
    let hardTimer: any = null;
    let settled: any = false;
    function finish(result?: any) : any {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve(result);
    }
    const timeout: any = setTimeout(() : any => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() : any => {
        child.kill("SIGKILL");
        hardTimer = setTimeout(() : any => {
          const error: Error & Record<string, any> = new Error("The load process did not stop within its termination budget.");
          error.code = "LOAD_PROCESS_TERMINATION_TIMEOUT";
          finish({ exitCode: null, timedOut: true, error });
        }, 2_000);
        hardTimer.unref();
      }, 2_000);
      forceTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.once("error", (error?: any) : any => {
      finish({ exitCode: null, timedOut, error });
    });
    child.once("exit", (exitCode?: any) : any => {
      finish({ exitCode, timedOut, error: null });
    });
  });
}

async function stopChild(child?: any) : Promise<any> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForChild(child, 2_000);
}

async function readPrivateLoadReport(reportPath?: any) : Promise<any> {
  try {
    const parsed: any = JSON.parse(await fs.readFile(reportPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomically(filePath?: any, value?: any) : Promise<any> {
  const serialized: any = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) {
    const error: Error & Record<string, any> = new Error("The bounded performance report exceeded its byte budget.");
    error.code = "PERFORMANCE_REPORT_BUDGET_EXCEEDED";
    throw error;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary: any = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fs.writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, filePath);
}

const concurrency: any = boundedInteger("--concurrency", 8, 1, 512);
// Observed smoke proves the probe path, not capacity. Keep the default workload
// small enough to complete on every supported developer machine within the
// fixed per-phase deadline; capacity profiles own larger request counts.
const requests: any = boundedInteger("--requests", 40, 1, 100_000);
const durationMs: any = boundedInteger("--duration-ms", 8_000, 1_000, 600_000);
const observerIntervalMs: any = boundedInteger("--observer-interval-ms", 100, 50, 5_000);
const timeoutMs: any = boundedInteger(
  "--timeout-ms",
  Math.min(600_000, durationMs * 4 + 30_000),
  5_000,
  600_000
);
const reportPath: any = resolveReportPath(argValue("--report", DEFAULT_REPORT));
const runRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-performance-observation-"));
const privateLoadReportPath: any = path.join(runRoot, "mcp-gateway-load.json");
const observations: any[] = [];
let droppedObservationCount: any = 0;
let invalidObservationCount: any = 0;
let child: any = null;

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

  child.on("message", (message?: any) : any => {
    if (!message || message.kind !== "meshrix.performance.runtime-observation") return;
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

  const childResult: any = await waitForChild(child, timeoutMs);
  const loadReport: any = await readPrivateLoadReport(privateLoadReportPath);
  const report: any = reduceGatewayPerformanceObservation({
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

  const serialized: any = JSON.stringify(report);
  if (serialized.includes(runRoot) || serialized.includes(os.homedir())) {
    const error: Error & Record<string, any> = new Error("The performance report contained private local information.");
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
} catch (error: any) {
  console.error(`[gateway-performance] failed reasonCode=${safeReasonCode(error)}`);
  process.exitCode = 1;
} finally {
  await stopChild(child).catch(() : any => null);
  await fs.rm(runRoot, { recursive: true, force: true });
}
