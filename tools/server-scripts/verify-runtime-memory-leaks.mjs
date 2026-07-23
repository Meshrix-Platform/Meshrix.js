#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  positiveGrowth,
  theilSenSlope
} from "./lib/resource-discipline-analysis.mjs";
import { RESOURCE_DISCIPLINE_POLICY } from "./lib/resource-discipline-policy.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const startServerPath = path.join(repoRoot, "tools", "server-scripts", "start-server.mjs");
const preloadPath = path.join(
  repoRoot,
  "tools",
  "server-scripts",
  "lib",
  "runtime-memory-profiler-preload.mjs"
);
const highRiskWorkloadPath = path.join(
  repoRoot,
  "tools",
  "server-scripts",
  "lib",
  "resource-high-risk-workload-child.mjs"
);
const reportPath = path.join(repoRoot, "build", "reports", "runtime-resource-discipline.json");
const policy = RESOURCE_DISCIPLINE_POLICY;
const memoryPolicy = policy.memoryLeak;
const highRiskPolicy = policy.highRiskWorkloads;
const selectedHighRiskProfile =
  process.env.LICO_RESOURCE_LOAD_PROFILE === "release" ? "release" : highRiskPolicy.profile;
const MESSAGE_KIND = "lico.resource-discipline.memory-sample";
const MAX_CAPTURED_CHILD_OUTPUT_BYTES = 64 * 1024;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeReasonCode(error, fallback = "runtime_memory_check_failed") {
  const value = String(error?.code || error?.reasonCode || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) ? value : fallback;
}

function boundedOutputCollector() {
  let chunks = [];
  let bytes = 0;
  return {
    push(chunk) {
      const value = Buffer.from(chunk);
      chunks.push(value);
      bytes += value.byteLength;
      while (bytes > MAX_CAPTURED_CHILD_OUTPUT_BYTES && chunks.length > 1) {
        bytes -= chunks[0].byteLength;
        chunks = chunks.slice(1);
      }
    },
    clear() {
      chunks = [];
      bytes = 0;
    }
  };
}

async function waitForReady(child, readyFilePath) {
  const deadline = Date.now() + memoryPolicy.startupTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const error = new Error("Server exited before the memory check became ready.");
      error.code = "MEMORY_CHECK_STARTUP_EXITED";
      throw error;
    }
    try {
      const ready = JSON.parse(await fs.readFile(readyFilePath, "utf8"));
      if (ready?.status === "ready" && Number(ready?.port) > 0) return ready;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(25);
  }
  const error = new Error("Server did not become ready within the memory check budget.");
  error.code = "MEMORY_CHECK_STARTUP_TIMEOUT";
  throw error;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ timedOut: false, code: child?.exitCode ?? null });
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ timedOut: true, code: null });
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ timedOut: false, code });
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForChildExit(child, memoryPolicy.shutdownTimeoutMs);
}

let nextSampleId = 0;
function requestMemorySample(child, { captureProfile = false } = {}) {
  const id = ++nextSampleId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("message", onMessage);
      const error = new Error("Memory sample timed out.");
      error.code = "MEMORY_SAMPLE_TIMEOUT";
      reject(error);
    }, memoryPolicy.sampleTimeoutMs);
    function settle() {
      clearTimeout(timeout);
      child.off("message", onMessage);
    }
    function onMessage(message) {
      if (message?.kind !== MESSAGE_KIND || message.id !== id) return;
      settle();
      if (message.ok !== true) {
        const error = new Error("Professional heap profiler rejected the sample.");
        error.code = message.reasonCode || "MEMORY_PROFILE_SAMPLE_FAILED";
        reject(error);
        return;
      }
      resolve(message);
    }
    child.on("message", onMessage);
    child.send({ kind: MESSAGE_KIND, id, captureProfile }, (error) => {
      if (!error) return;
      settle();
      reject(error);
    });
  });
}

async function runRequestBatch(baseUrl, requestCount) {
  let nextRequest = 0;
  const statusCounts = new Map();
  const workers = Array.from(
    { length: Math.min(memoryPolicy.concurrency, requestCount) },
    async () => {
      while (true) {
        const current = nextRequest;
        nextRequest += 1;
        if (current >= requestCount) return;
        const response = await fetch(`${baseUrl}/api/healthz`, {
          headers: { "User-Agent": "resource-discipline-memory-check" },
          signal: AbortSignal.timeout(memoryPolicy.requestTimeoutMs)
        });
        await response.arrayBuffer();
        statusCounts.set(response.status, (statusCounts.get(response.status) || 0) + 1);
      }
    }
  );
  await Promise.all(workers);
  return statusCounts;
}

function mergeStatusCounts(target, incoming) {
  for (const [status, count] of incoming) {
    target.set(status, (target.get(status) || 0) + count);
  }
}

async function directoryStats(rootPath) {
  const pending = [rootPath];
  let bytes = 0;
  let files = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(entryPath);
        bytes += stat.size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

async function countNewlines(filePath) {
  const handle = await fs.open(filePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let lines = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return lines;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] === 10) lines += 1;
      }
    }
  } finally {
    await handle.close();
  }
}

async function runtimeLogStats(userDataPath) {
  const logRoot = path.join(userDataPath, "logs", "runtime");
  const entries = await fs.readdir(logRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  let bytes = 0;
  let records = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(logRoot, entry.name);
    const stat = await fs.stat(filePath);
    bytes += stat.size;
    records += await countNewlines(filePath);
  }
  return { bytes, records };
}

function addMaximumViolation(violations, code, actual, maximum) {
  if (actual > maximum) violations.push(code);
}

function compactMemorySample(sample) {
  return {
    heapUsedBytes: sample.memory.heapUsed,
    rssBytes: sample.memory.rss,
    externalBytes: sample.memory.external,
    arrayBufferBytes: sample.memory.arrayBuffers,
    profiledInUseBytes: sample.profile.inUseBytes,
    profiledInUseObjects: sample.profile.inUseObjects,
    profilerSampleCount: sample.profile.sampleCount
  };
}

async function writeJsonAtomically(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx"
  });
  await fs.rename(temporary, filePath);
}

function createChildEnvironment(runRoot, profilePath) {
  const environment = { ...process.env };
  for (const key of [
    "NODE_OPTIONS",
    "LICO_EDITION",
    "LICO_FEATURE_PROFILE",
    "LICO_RUNTIME_CONFIG",
    "LICO_REQUIRE_RUNTIME_CONFIG",
    "LICO_SERVER_DATA_DIR",
    "LICO_SERVER_PORT",
    "LICO_SERVER_READY_FILE"
  ]) {
    delete environment[key];
  }
  return {
    ...environment,
    NO_COLOR: "1",
    LICO_HTTP_RATE_LIMIT_IP_PER_MINUTE: "1000000",
    LICO_HTTP_RATE_LIMIT_SUBJECT_PER_MINUTE: "1000000",
    LICO_HTTP_RATE_LIMIT_TENANT_PER_MINUTE: "1000000",
    LICO_LOG_LEVEL: policy.logging.requiredDefaultLevel,
    LICO_MEMORY_GC_PASSES: String(memoryPolicy.gcPasses),
    LICO_MEMORY_PROFILE_INTERVAL_BYTES: String(memoryPolicy.heapProfileIntervalBytes),
    LICO_MEMORY_PROFILE_STACK_DEPTH: String(memoryPolicy.heapProfileStackDepth),
    LICO_MEMORY_PROFILE_PATH: profilePath,
    TMPDIR: runRoot
  };
}

function compactHighRiskFacts(value) {
  const output = {};
  for (const [key, fact] of Object.entries(value || {})) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)) continue;
    if (typeof fact === "boolean") {
      output[key] = fact;
    } else if (typeof fact === "number" && Number.isFinite(fact)) {
      output[key] = fact;
    } else if (
      typeof fact === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(fact)
    ) {
      output[key] = fact;
    }
  }
  return output;
}

function compactHighRiskResult(message) {
  if (
    message?.kind !== "lico.resource-discipline.high-risk-result" ||
    message.profile !== selectedHighRiskProfile ||
    message.syntheticDataOnly !== true ||
    !Array.isArray(message.scenarios)
  ) {
    const error = new Error("High-risk workload result is invalid.");
    error.code = "HIGH_RISK_WORKLOAD_RESULT_INVALID";
    throw error;
  }
  const required = new Set(highRiskPolicy.requiredScenarioIds);
  const scenarios = message.scenarios.map((scenario) => {
    const id = String(scenario?.id || "");
    if (!required.delete(id)) {
      const error = new Error("High-risk workload scenario identity is invalid.");
      error.code = "HIGH_RISK_WORKLOAD_SCENARIO_INVALID";
      throw error;
    }
    const numeric = {};
    for (const key of [
      "operationCount",
      "durationMs",
      "operationsPerSecond",
      "peakHeapGrowthBytes",
      "peakRssGrowthBytes",
      "peakExternalGrowthBytes",
      "settledHeapGrowthBytes",
      "eventLoopDelayMaxMs"
    ]) {
      const value = Number(scenario[key]);
      if (!Number.isFinite(value) || value < 0) {
        const error = new Error("High-risk workload metric is invalid.");
        error.code = "HIGH_RISK_WORKLOAD_METRIC_INVALID";
        throw error;
      }
      numeric[key] = value;
    }
    return {
      id,
      ...numeric,
      facts: compactHighRiskFacts(scenario.facts)
    };
  });
  if (required.size > 0 || scenarios.length !== highRiskPolicy.requiredScenarioIds.length) {
    const error = new Error("High-risk workload coverage is incomplete.");
    error.code = "HIGH_RISK_WORKLOAD_COVERAGE_INCOMPLETE";
    throw error;
  }
  const byId = Object.fromEntries(scenarios.map((scenario) => [scenario.id, scenario]));
  if (
    byId.protocol_events.operationCount <
      (selectedHighRiskProfile === "release" ? 1_000_000 : highRiskPolicy.minimumProtocolEvents) ||
    byId.job_projection.operationCount <
      (selectedHighRiskProfile === "release" ? 100_000 : highRiskPolicy.minimumJobRecords)
  ) {
    const error = new Error("High-risk workload scale is below policy.");
    error.code = "HIGH_RISK_WORKLOAD_SCALE_INCOMPLETE";
    throw error;
  }
  return {
    profile: String(message.profile || ""),
    syntheticDataOnly: true,
    scenarios
  };
}

async function runHighRiskWorkloads(runRoot) {
  const workloadRoot = path.join(runRoot, "high-risk-workloads");
  await fs.mkdir(workloadRoot, { recursive: true, mode: 0o700 });
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  environment.LICO_RESOURCE_LOAD_PROFILE = selectedHighRiskProfile;
  const workloadOutput = boundedOutputCollector();
  highRiskChild = spawn(process.execPath, [
    "--expose-gc",
    highRiskWorkloadPath,
    workloadRoot
  ], {
    cwd: repoRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  highRiskChild.stdout.on("data", (chunk) => workloadOutput.push(chunk));
  highRiskChild.stderr.on("data", (chunk) => workloadOutput.push(chunk));
  try {
    return await new Promise((resolve, reject) => {
      let result = null;
      const timeout = setTimeout(() => {
        const error = new Error("High-risk workload timed out.");
        error.code = "HIGH_RISK_WORKLOAD_TIMEOUT";
        highRiskChild.kill("SIGKILL");
        reject(error);
      }, selectedHighRiskProfile === "release" ? 600_000 : highRiskPolicy.timeoutMs);
      const settle = (callback) => {
        clearTimeout(timeout);
        callback();
      };
      highRiskChild.on("message", (message) => {
        try {
          result = compactHighRiskResult(message);
        } catch (error) {
          settle(() => reject(error));
        }
      });
      highRiskChild.once("error", (error) => settle(() => reject(error)));
      highRiskChild.once("exit", (code, signal) => {
        if (code === 0 && !signal && result) {
          settle(() => resolve(result));
          return;
        }
        const error = new Error("High-risk workload process failed.");
        error.code = "HIGH_RISK_WORKLOAD_EXITED";
        settle(() => reject(error));
      });
    });
  } finally {
    workloadOutput.clear();
    await stopChild(highRiskChild).catch(() => null);
    highRiskChild = null;
  }
}

const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lico-resource-discipline-"));
const userDataPath = path.join(runRoot, "data");
const readyFilePath = path.join(runRoot, "private-ready.json");
const privateProfilePath = path.join(runRoot, "runtime-heap.pb.gz");
const output = boundedOutputCollector();
let child = null;
let highRiskChild = null;

try {
  child = spawn(process.execPath, [
    "--expose-gc",
    "--import",
    preloadPath,
    startServerPath,
    "--port",
    "0",
    "--strict-port",
    "--ready-file",
    readyFilePath,
    "--profile",
    "default",
    "--data-dir",
    userDataPath
  ], {
    cwd: repoRoot,
    env: createChildEnvironment(runRoot, privateProfilePath),
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));

  const ready = await waitForReady(child, readyFilePath);
  const baseUrl = `http://${ready.host}:${ready.port}`;
  await runRequestBatch(baseUrl, memoryPolicy.warmupRequests);
  await delay(250);

  const storageBaseline = await directoryStats(userDataPath);
  const logBaseline = await runtimeLogStats(userDataPath);
  const samples = [];
  const baseline = await requestMemorySample(child);
  samples.push({ requests: 0, ...baseline });
  const statusCounts = new Map();

  for (let round = 1; round <= memoryPolicy.measurementRounds; round += 1) {
    const counts = await runRequestBatch(baseUrl, memoryPolicy.requestsPerRound);
    mergeStatusCounts(statusCounts, counts);
    await delay(100);
    const sample = await requestMemorySample(child, {
      captureProfile: round === memoryPolicy.measurementRounds
    });
    samples.push({
      requests: round * memoryPolicy.requestsPerRound,
      ...sample
    });
  }

  const storageFinal = await directoryStats(userDataPath);
  const logFinal = await runtimeLogStats(userDataPath);
  await stopChild(child);
  child = null;
  const highRiskWorkloads = await runHighRiskWorkloads(runRoot);
  const initial = samples[0];
  const final = samples.at(-1);
  const heapGrowthBytes = positiveGrowth(final.memory.heapUsed, initial.memory.heapUsed);
  const heapSlopeBytesPerRequest = Math.max(
    0,
    theilSenSlope(samples, (sample) => sample.memory.heapUsed)
  );
  const profileGrowthBytes = positiveGrowth(
    final.profile.inUseBytes,
    initial.profile.inUseBytes
  );
  const profileSlopeBytesPerRequest = Math.max(
    0,
    theilSenSlope(samples, (sample) => sample.profile.inUseBytes)
  );
  const externalGrowthBytes = positiveGrowth(
    final.memory.external + final.memory.arrayBuffers,
    initial.memory.external + initial.memory.arrayBuffers
  );
  const rssGrowthBytes = positiveGrowth(final.memory.rss, initial.memory.rss);
  const storageGrowthBytes = positiveGrowth(storageFinal.bytes, storageBaseline.bytes);
  const logGrowthBytes = positiveGrowth(logFinal.bytes, logBaseline.bytes);
  const logRecordGrowth = positiveGrowth(logFinal.records, logBaseline.records);
  const violations = [];

  addMaximumViolation(
    violations,
    "heap_growth_exceeded",
    heapGrowthBytes,
    memoryPolicy.maxHeapGrowthBytes
  );
  addMaximumViolation(
    violations,
    "heap_slope_exceeded",
    heapSlopeBytesPerRequest,
    memoryPolicy.maxHeapSlopeBytesPerRequest
  );
  addMaximumViolation(
    violations,
    "profiled_heap_growth_exceeded",
    profileGrowthBytes,
    memoryPolicy.maxProfileGrowthBytes
  );
  addMaximumViolation(
    violations,
    "profiled_heap_slope_exceeded",
    profileSlopeBytesPerRequest,
    memoryPolicy.maxProfileSlopeBytesPerRequest
  );
  addMaximumViolation(
    violations,
    "external_memory_growth_exceeded",
    externalGrowthBytes,
    memoryPolicy.maxExternalGrowthBytes
  );
  addMaximumViolation(
    violations,
    "rss_growth_exceeded",
    rssGrowthBytes,
    memoryPolicy.maxRssGrowthBytes
  );
  addMaximumViolation(
    violations,
    "persistent_storage_growth_exceeded",
    storageGrowthBytes,
    policy.persistence.maxLoadGrowthBytes
  );
  addMaximumViolation(
    violations,
    "runtime_log_growth_exceeded",
    logGrowthBytes,
    policy.logging.maxLoadGrowthBytes
  );
  addMaximumViolation(
    violations,
    "runtime_log_record_growth_exceeded",
    logRecordGrowth,
    policy.logging.maxLoadRecordGrowth
  );
  addMaximumViolation(
    violations,
    "temporary_profile_growth_exceeded",
    Number(final.profile.encodedBytes || 0),
    memoryPolicy.maxFailureProfileBytes
  );
  const unexpectedStatuses = [...statusCounts.entries()]
    .filter(([status]) => status !== 200)
    .reduce((total, [, count]) => total + count, 0);
  if (unexpectedStatuses > 0) violations.push("load_requests_failed");
  const completedRequests = [...statusCounts.values()].reduce((total, count) => total + count, 0);
  if (completedRequests !== memoryPolicy.measurementRounds * memoryPolicy.requestsPerRound) {
    violations.push("load_request_count_incomplete");
  }
  for (const scenario of highRiskWorkloads.scenarios) {
    addMaximumViolation(
      violations,
      `${scenario.id}_settled_heap_growth_exceeded`,
      scenario.settledHeapGrowthBytes,
      highRiskPolicy.maxSettledHeapGrowthBytes
    );
    addMaximumViolation(
      violations,
      `${scenario.id}_peak_rss_growth_exceeded`,
      scenario.peakRssGrowthBytes,
      highRiskPolicy.maxPeakRssGrowthBytes
    );
    addMaximumViolation(
      violations,
      `${scenario.id}_peak_external_growth_exceeded`,
      scenario.peakExternalGrowthBytes,
      highRiskPolicy.maxPeakExternalGrowthBytes
    );
    addMaximumViolation(
      violations,
      `${scenario.id}_event_loop_delay_exceeded`,
      scenario.eventLoopDelayMaxMs,
      highRiskPolicy.maxEventLoopDelayMs
    );
  }

  const report = {
    schemaVersion: "runtime-resource-discipline-report",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/verify-runtime-memory-leaks.mjs",
    priority: policy.priority,
    framework: {
      name: memoryPolicy.framework,
      version: memoryPolicy.frameworkVersion,
      format: "pprof",
      forcedGarbageCollection: true,
      toolCacheRetention: memoryPolicy.toolCacheRetention,
      toolCacheCleanupAttempted: false,
      diagnosticArtifactRetention: memoryPolicy.diagnosticArtifactRetention,
      profileSha256: final.profile.profileSha256,
      temporaryProfileBytes: final.profile.encodedBytes,
      rawProfileRetained: false
    },
    workload: {
      warmupRequests: memoryPolicy.warmupRequests,
      measurementRounds: memoryPolicy.measurementRounds,
      requestsPerRound: memoryPolicy.requestsPerRound,
      completedRequests,
      concurrency: memoryPolicy.concurrency,
      statusCounts: Object.fromEntries(
        [...statusCounts.entries()].sort(([left], [right]) => left - right)
      )
    },
    highRiskWorkloads,
    memory: {
      baseline: compactMemorySample(initial),
      final: compactMemorySample(final),
      heapGrowthBytes,
      heapSlopeBytesPerRequest,
      profiledHeapGrowthBytes: profileGrowthBytes,
      profiledHeapSlopeBytesPerRequest: profileSlopeBytesPerRequest,
      externalGrowthBytes,
      rssGrowthBytes,
      maxObservedHeapBytes: Math.max(...samples.map((sample) => sample.memory.heapUsed)),
      maxObservedRssBytes: Math.max(...samples.map((sample) => sample.memory.rss))
    },
    persistence: {
      baselineBytes: storageBaseline.bytes,
      finalBytes: storageFinal.bytes,
      growthBytes: storageGrowthBytes,
      fileGrowth: storageFinal.files - storageBaseline.files
    },
    logging: {
      baselineBytes: logBaseline.bytes,
      finalBytes: logFinal.bytes,
      growthBytes: logGrowthBytes,
      recordGrowth: logRecordGrowth
    },
    summary: {
      releaseReady: violations.length === 0,
      violations
    }
  };

  await writeJsonAtomically(reportPath, report);
  output.clear();
  console.log(
    `[resource-discipline] memoryLeakFree=${report.summary.releaseReady} ` +
    `framework=${report.framework.name} requests=${completedRequests} ` +
    `violations=${violations.length}`
  );
  if (violations.length > 0) process.exitCode = 1;
} catch (error) {
  output.clear();
  console.error(`[resource-discipline] failed reasonCode=${safeReasonCode(error)}`);
  process.exitCode = 1;
} finally {
  await stopChild(child).catch(() => null);
  await stopChild(highRiskChild).catch(() => null);
  await fs.rm(runRoot, { recursive: true, force: true });
}
