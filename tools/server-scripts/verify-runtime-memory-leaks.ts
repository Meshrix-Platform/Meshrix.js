#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  externalMemoryGrowth,
  positiveGrowth,
  theilSenSlope
} from "./lib/resource-discipline-analysis.ts";
import { RESOURCE_DISCIPLINE_POLICY } from "./lib/resource-discipline-policy.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const startServerPath: any = path.join(repoRoot, "tools", "server-scripts", "start-server.ts");
const preloadPath: any = path.join(
  repoRoot,
  "tools",
  "server-scripts",
  "lib",
  "runtime-memory-profiler-preload.ts"
);
const highRiskWorkloadPath: any = path.join(
  repoRoot,
  "tools",
  "server-scripts",
  "lib",
  "resource-high-risk-workload-child.ts"
);
const reportPath: any = path.join(repoRoot, "build", "reports", "runtime-resource-discipline.json");
const policy: any = RESOURCE_DISCIPLINE_POLICY;
const memoryPolicy: any = policy.memoryLeak;
const highRiskPolicy: any = policy.highRiskWorkloads;
const selectedHighRiskProfile: any =
  process.env.MESHRIX_RESOURCE_LOAD_PROFILE === "release" ? "release" : highRiskPolicy.profile;
const MESSAGE_KIND: any = "meshrix.resource-discipline.memory-sample";
const MAX_CAPTURED_CHILD_OUTPUT_BYTES: any = 64 * 1024;

function delay(milliseconds?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, milliseconds));
}

function safeReasonCode(error?: any, fallback: any = "runtime_memory_check_failed") : any {
  const value: any = String(error?.code || error?.reasonCode || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) ? value : fallback;
}

function boundedOutputCollector() : any {
  let chunks: any[] = [];
  let bytes: any = 0;
  return {
    push(chunk?: any) : any {
      const value: any = Buffer.from(chunk);
      chunks.push(value);
      bytes += value.byteLength;
      while (bytes > MAX_CAPTURED_CHILD_OUTPUT_BYTES && chunks.length > 1) {
        bytes -= chunks[0].byteLength;
        chunks = chunks.slice(1);
      }
    },
    clear() : any {
      chunks = [];
      bytes = 0;
    }
  };
}

async function waitForReady(child?: any, readyFilePath?: any) : Promise<any> {
  const deadline: any = Date.now() + memoryPolicy.startupTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const error: Error & Record<string, any> = new Error("Server exited before the memory check became ready.");
      error.code = "MEMORY_CHECK_STARTUP_EXITED";
      throw error;
    }
    try {
      const ready: any = JSON.parse(await fs.readFile(readyFilePath, "utf8"));
      if (ready?.status === "ready" && Number(ready?.port) > 0) return ready;
    } catch (error: any) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(25);
  }
  const error: Error & Record<string, any> = new Error("Server did not become ready within the memory check budget.");
  error.code = "MEMORY_CHECK_STARTUP_TIMEOUT";
  throw error;
}

function waitForChildExit(child?: any, timeoutMs?: any) : any {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ timedOut: false, code: child?.exitCode ?? null });
  }
  return new Promise((resolve?: any) : any => {
    const timeout: any = setTimeout(() : any => {
      child.kill("SIGKILL");
      resolve({ timedOut: true, code: null });
    }, timeoutMs);
    child.once("exit", (code?: any) : any => {
      clearTimeout(timeout);
      resolve({ timedOut: false, code });
    });
  });
}

async function stopChild(child?: any) : Promise<any> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForChildExit(child, memoryPolicy.shutdownTimeoutMs);
}

let nextSampleId: any = 0;
function requestMemorySample(child?: any, { captureProfile = false }: Record<string, any> = {}) : any {
  const id: any = ++nextSampleId;
  return new Promise((resolve?: any, reject?: any) : any => {
    const timeout: any = setTimeout(() : any => {
      child.off("message", onMessage);
      const error: Error & Record<string, any> = new Error("Memory sample timed out.");
      error.code = "MEMORY_SAMPLE_TIMEOUT";
      reject(error);
    }, memoryPolicy.sampleTimeoutMs);
    function settle() : any {
      clearTimeout(timeout);
      child.off("message", onMessage);
    }
    function onMessage(message?: any) : any {
      if (message?.kind !== MESSAGE_KIND || message.id !== id) return;
      settle();
      if (message.ok !== true) {
        const error: Error & Record<string, any> = new Error("Professional heap profiler rejected the sample.");
        error.code = message.reasonCode || "MEMORY_PROFILE_SAMPLE_FAILED";
        reject(error);
        return;
      }
      resolve(message);
    }
    child.on("message", onMessage);
    child.send({ kind: MESSAGE_KIND, id, captureProfile }, (error?: any) : any => {
      if (!error) return;
      settle();
      reject(error);
    });
  });
}

async function runRequestBatch(baseUrl?: any, requestCount?: any) : Promise<any> {
  let nextRequest: any = 0;
  const statusCounts: any = new Map<any, any>();
  const workers: any = Array.from(
    { length: Math.min(memoryPolicy.concurrency, requestCount) },
    async () : Promise<any> => {
      while (true) {
        const current: any = nextRequest;
        nextRequest += 1;
        if (current >= requestCount) return;
        const response: any = await fetch(`${baseUrl}/api/healthz`, {
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

function mergeStatusCounts(target?: any, incoming?: any) : any {
  for (const [status, count] of incoming) {
    target.set(status, (target.get(status) || 0) + count);
  }
}

async function directoryStats(rootPath?: any) : Promise<any> {
  const pending: any[] = [rootPath];
  let bytes: any = 0;
  let files: any = 0;
  while (pending.length > 0) {
    const current: any = pending.pop();
    const entries: any = await fs.readdir(current, { withFileTypes: true }).catch((error?: any) : any => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const entryPath: any = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        const stat: any = await fs.stat(entryPath);
        bytes += stat.size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

async function countNewlines(filePath?: any) : Promise<any> {
  const handle: any = await fs.open(filePath, "r");
  const buffer: any = Buffer.allocUnsafe(64 * 1024);
  let lines: any = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return lines;
      for (let index: any = 0; index < bytesRead; index += 1) {
        if (buffer[index] === 10) lines += 1;
      }
    }
  } finally {
    await handle.close();
  }
}

async function runtimeLogStats(userDataPath?: any) : Promise<any> {
  const logRoot: any = path.join(userDataPath, "logs", "runtime");
  const entries: any = await fs.readdir(logRoot, { withFileTypes: true }).catch((error?: any) : any => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  let bytes: any = 0;
  let records: any = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath: any = path.join(logRoot, entry.name);
    const stat: any = await fs.stat(filePath);
    bytes += stat.size;
    records += await countNewlines(filePath);
  }
  return { bytes, records };
}

function addMaximumViolation(violations?: any, code?: any, actual?: any, maximum?: any) : any {
  if (actual > maximum) violations.push(code);
}

function compactMemorySample(sample?: any) : any {
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

async function writeJsonAtomically(filePath?: any, value?: any) : Promise<any> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary: any = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx"
  });
  await fs.rename(temporary, filePath);
}

const ISOLATED_CHILD_ENV_KEYS: any[] = [
  "NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  "MESHRIX_ACCEPTANCE_GENERATION_WORKER",
  "MESHRIX_ACCEPTANCE_PARALLELISM",
  "MESHRIX_ACCEPTANCE_PROOF_LEDGER_DIR",
  "MESHRIX_ACCEPTANCE_RELEASE_ID",
  "MESHRIX_ACCEPTANCE_SKIP_LEDGER_ANCHOR",
  "MESHRIX_ACCEPTANCE_STARTED_AT_MS",
  "MESHRIX_EDITION",
  "MESHRIX_FEATURE_PROFILE",
  "MESHRIX_RELEASE_PARALLELISM",
  "MESHRIX_RUNTIME_CONFIG",
  "MESHRIX_REQUIRE_RUNTIME_CONFIG",
  "MESHRIX_SERVER_DATA_DIR",
  "MESHRIX_SERVER_PORT",
  "MESHRIX_SERVER_READY_FILE"
];

function createIsolatedChildEnvironment(overrides: Record<string, any> = {}) : any {
  const environment: Record<string, any> = { ...process.env };
  for (const key of ISOLATED_CHILD_ENV_KEYS) {
    delete environment[key];
  }
  return { ...environment, ...overrides };
}

function createChildEnvironment(runRoot?: any, profilePath?: any) : any {
  return createIsolatedChildEnvironment({
    NODE_OPTIONS: "--conditions=source",
    NO_COLOR: "1",
    MESHRIX_HTTP_RATE_LIMIT_IP_PER_MINUTE: "1000000",
    MESHRIX_HTTP_RATE_LIMIT_SUBJECT_PER_MINUTE: "1000000",
    MESHRIX_HTTP_RATE_LIMIT_TENANT_PER_MINUTE: "1000000",
    MESHRIX_LOG_LEVEL: policy.logging.requiredDefaultLevel,
    MESHRIX_MEMORY_GC_PASSES: String(memoryPolicy.gcPasses),
    MESHRIX_MEMORY_PROFILE_INTERVAL_BYTES: String(memoryPolicy.heapProfileIntervalBytes),
    MESHRIX_MEMORY_PROFILE_STACK_DEPTH: String(memoryPolicy.heapProfileStackDepth),
    MESHRIX_MEMORY_PROFILE_PATH: profilePath,
    TMPDIR: runRoot
  });
}

function compactHighRiskFacts(value?: any) : any {
  const output: Record<string, any> = {};
  for (const [key, fact] of (Object.entries(value || {}) as [string, any][])) {
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

function compactHighRiskResult(message?: any) : any {
  if (
    message?.kind !== "meshrix.resource-discipline.high-risk-result" ||
    message.profile !== selectedHighRiskProfile ||
    message.syntheticDataOnly !== true ||
    !Array.isArray(message.scenarios)
  ) {
    const error: Error & Record<string, any> = new Error("High-risk workload result is invalid.");
    error.code = "HIGH_RISK_WORKLOAD_RESULT_INVALID";
    throw error;
  }
  const required: any = new Set<any>(highRiskPolicy.requiredScenarioIds);
  const scenarios: any = message.scenarios.map((scenario?: any) : any => {
    const id: any = String(scenario?.id || "");
    if (!required.delete(id)) {
      const error: Error & Record<string, any> = new Error("High-risk workload scenario identity is invalid.");
      error.code = "HIGH_RISK_WORKLOAD_SCENARIO_INVALID";
      throw error;
    }
    const numeric: Record<string, any> = {};
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
      const value: any = Number(scenario[key]);
      if (!Number.isFinite(value) || value < 0) {
        const error: Error & Record<string, any> = new Error("High-risk workload metric is invalid.");
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
    const error: Error & Record<string, any> = new Error("High-risk workload coverage is incomplete.");
    error.code = "HIGH_RISK_WORKLOAD_COVERAGE_INCOMPLETE";
    throw error;
  }
  const byId: any = Object.fromEntries(scenarios.map((scenario?: any) : any => [scenario.id, scenario]));
  if (
    byId.protocol_events.operationCount <
      (selectedHighRiskProfile === "release" ? 1_000_000 : highRiskPolicy.minimumProtocolEvents) ||
    byId.job_projection.operationCount <
      (selectedHighRiskProfile === "release" ? 100_000 : highRiskPolicy.minimumJobRecords)
  ) {
    const error: Error & Record<string, any> = new Error("High-risk workload scale is below policy.");
    error.code = "HIGH_RISK_WORKLOAD_SCALE_INCOMPLETE";
    throw error;
  }
  return {
    profile: String(message.profile || ""),
    syntheticDataOnly: true,
    scenarios
  };
}

async function runHighRiskWorkloads(runRoot?: any) : Promise<any> {
  const workloadRoot: any = path.join(runRoot, "high-risk-workloads");
  await fs.mkdir(workloadRoot, { recursive: true, mode: 0o700 });
  const environment: any = createIsolatedChildEnvironment({
    MESHRIX_RESOURCE_LOAD_PROFILE: selectedHighRiskProfile
  });
  const workloadOutput: any = boundedOutputCollector();
  highRiskChild = spawn(process.execPath, [
    "--expose-gc",
    highRiskWorkloadPath,
    workloadRoot
  ], {
    cwd: repoRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  highRiskChild.stdout.on("data", (chunk?: any) : any => workloadOutput.push(chunk));
  highRiskChild.stderr.on("data", (chunk?: any) : any => workloadOutput.push(chunk));
  try {
    return await new Promise((resolve?: any, reject?: any) : any => {
      let result: any = null;
      const settle: any = (callback?: any) : any => {
        callback();
      };
      highRiskChild.on("message", (message?: any) : any => {
        try {
          result = compactHighRiskResult(message);
        } catch (error: any) {
          settle(() : any => reject(error));
        }
      });
      highRiskChild.once("error", (error?: any) : any => settle(() : any => reject(error)));
      highRiskChild.once("exit", (code?: any, signal?: any) : any => {
        if (code === 0 && !signal && result) {
          settle(() : any => resolve(result));
          return;
        }
        const error: Error & Record<string, any> = new Error("High-risk workload process failed.");
        error.code = "HIGH_RISK_WORKLOAD_EXITED";
        settle(() : any => reject(error));
      });
    });
  } finally {
    workloadOutput.clear();
    await stopChild(highRiskChild).catch(() : any => null);
    highRiskChild = null;
  }
}

const runRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-resource-discipline-"));
const userDataPath: any = path.join(runRoot, "data");
const readyFilePath: any = path.join(runRoot, "private-ready.json");
const privateProfilePath: any = path.join(runRoot, "runtime-heap.pb.gz");
const output: any = boundedOutputCollector();
let child: any = null;
let highRiskChild: any = null;

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
  child.stdout.on("data", (chunk?: any) : any => output.push(chunk));
  child.stderr.on("data", (chunk?: any) : any => output.push(chunk));

  const ready: any = await waitForReady(child, readyFilePath);
  const baseUrl: any = `http://${ready.host}:${ready.port}`;
  await runRequestBatch(baseUrl, memoryPolicy.warmupRequests);
  await delay(250);

  const storageBaseline: any = await directoryStats(userDataPath);
  const logBaseline: any = await runtimeLogStats(userDataPath);
  const samples: any[] = [];
  const baseline: any = await requestMemorySample(child);
  samples.push({ requests: 0, ...baseline });
  const statusCounts: any = new Map<any, any>();

  for (let round: any = 1; round <= memoryPolicy.measurementRounds; round += 1) {
    const counts: any = await runRequestBatch(baseUrl, memoryPolicy.requestsPerRound);
    mergeStatusCounts(statusCounts, counts);
    await delay(100);
    const sample: any = await requestMemorySample(child, {
      captureProfile: round === memoryPolicy.measurementRounds
    });
    samples.push({
      requests: round * memoryPolicy.requestsPerRound,
      ...sample
    });
  }

  const storageFinal: any = await directoryStats(userDataPath);
  const logFinal: any = await runtimeLogStats(userDataPath);
  await stopChild(child);
  child = null;
  const highRiskWorkloads: any = await runHighRiskWorkloads(runRoot);
  const initial: any = samples[0];
  const final: any = samples.at(-1);
  const heapGrowthBytes: any = positiveGrowth(final.memory.heapUsed, initial.memory.heapUsed);
  const heapSlopeBytesPerRequest: any = Math.max(
    0,
    theilSenSlope(samples, (sample?: any) : any => sample.memory.heapUsed)
  );
  const profileGrowthBytes: any = positiveGrowth(
    final.profile.inUseBytes,
    initial.profile.inUseBytes
  );
  const profileSlopeBytesPerRequest: any = Math.max(
    0,
    theilSenSlope(samples, (sample?: any) : any => sample.profile.inUseBytes)
  );
  const externalGrowthBytes: any = externalMemoryGrowth(
    final.memory.external,
    initial.memory.external
  );
  const rssGrowthBytes: any = positiveGrowth(final.memory.rss, initial.memory.rss);
  const storageGrowthBytes: any = positiveGrowth(storageFinal.bytes, storageBaseline.bytes);
  const logGrowthBytes: any = positiveGrowth(logFinal.bytes, logBaseline.bytes);
  const logRecordGrowth: any = positiveGrowth(logFinal.records, logBaseline.records);
  const violations: any[] = [];

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
  const unexpectedStatuses: any = [...statusCounts.entries()]
    .filter(([status]: any[]) : any => status !== 200)
    .reduce((total: any, [, count]: any[]) : any => total + count, 0);
  if (unexpectedStatuses > 0) violations.push("load_requests_failed");
  const completedRequests: any = [...statusCounts.values()].reduce((total?: any, count?: any) : any => total + count, 0);
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

  const report: Record<string, any> = {
    schemaVersion: "runtime-resource-discipline-report",
    generatedAt: new Date().toISOString(),
    verifier: "tools/server-scripts/verify-runtime-memory-leaks.ts",
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
        [...statusCounts.entries()].sort(([left]: any[], [right]: any[]) : any => left - right)
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
      maxObservedHeapBytes: Math.max(...samples.map((sample?: any) : any => sample.memory.heapUsed)),
      maxObservedRssBytes: Math.max(...samples.map((sample?: any) : any => sample.memory.rss))
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
    `violations=${violations.length} ` +
    `violationCodes=${violations.length > 0 ? violations.join(",") : "none"}`
  );
  if (violations.length > 0) process.exitCode = 1;
} catch (error: any) {
  output.clear();
  console.error(`[resource-discipline] failed reasonCode=${safeReasonCode(error)}`);
  process.exitCode = 1;
} finally {
  await stopChild(child).catch(() : any => null);
  await stopChild(highRiskChild).catch(() : any => null);
  await fs.rm(runRoot, { recursive: true, force: true });
}
