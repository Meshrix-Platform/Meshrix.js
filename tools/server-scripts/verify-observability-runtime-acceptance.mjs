#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  createExecutiveReportStore,
  EXECUTIVE_REPORT_PROTOCOL_VERSION
} from "../../packages/foundation/src/observability/executive-report.mjs";
import {
  buildProductionHealthReport,
  PRODUCTION_HEALTH_REPORT_TYPE
} from "../../packages/foundation/src/observability/report-reader.mjs";
import {
  OBSERVABILITY_BUDGETS,
  createBoundedSnapshotCache,
  createBoundedWorkQueue,
  startObservabilityBudgetObservation
} from "../../packages/foundation/src/observability/observability-budgets.mjs";
import { createBoundedMetricRegistry } from "../../packages/foundation/src/observability/metric-registry.mjs";
import { createPublishingObservationSink } from "../../packages/foundation/src/observability/upstream-publication.mjs";
import {
  monitorAlertConfigPath,
  monitorAlertStatePath
} from "../../packages/server-runtime/src/composition/devops/monitor-alerts.mjs";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeAndPublishSensitiveReport
} from "./lib/sensitive-report-scan.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH = path.join(ROOT, "build/reports/observability-runtime-acceptance.json");
const PLAN_FILE = "docs/plans/end-to-end-release/current-baseline/Plan.md";
const REQUIREMENTS = Object.freeze(["REQ-REL-003", "REQ-REL-009", "REQ-REL-010", "REQ-REL-011", "REQ-REL-024", "REQ-REL-025", "REQ-USP-013"]);
const REPORT_SCHEMA_VERSION = "v0.0.1:observability:runtime-acceptance-report-1";
const VERIFIER = "tools/server-scripts/verify-observability-runtime-acceptance.mjs";
const COMMAND_ID = "observability-runtime";
const SOURCE_FILES = Object.freeze([
  "packages/foundation/src/observability/alert-service.mjs",
  "packages/foundation/src/observability/executive-report.mjs",
  "packages/foundation/src/observability/metric-registry.mjs",
  "packages/foundation/src/observability/observability-budgets.mjs",
  "packages/foundation/src/observability/report-reader.mjs",
  "packages/foundation/src/observability/sensitive-report-scan.mjs",
  "packages/foundation/src/observability/upstream-publication.mjs",
  "packages/server-runtime/src/composition/devops/monitor-alerts.mjs",
  "tools/server-scripts/system-inspection-daemon.mjs",
  VERIFIER
]);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lico-observability-runtime-"));
const checks = [];

function record(id, evidence = {}) {
  checks.push({ id, status: "passed", evidence });
}

async function writeProductionReadinessFixture(reportRoot) {
  const runId = "observability-runtime-acceptance";
  const runRoot = path.join(reportRoot, runId);
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(path.join(runRoot, "report.json"), `${JSON.stringify({
    schemaVersion: "v0.0.1:schema:definition-1",
    reportType: "v0.0.1:platform:production-readiness-1",
    runId,
    generatedAt: "2026-01-01T00:00:00.000Z",
    mode: "full",
    overallStatus: "pass",
    productionClaimAllowed: false,
    releaseClaim: "verification-fixture",
    summary: { pass: 1, fail: 0, timeout: 0, blockedP0: 0 },
    coverage: {
      required: ["observability-runtime"],
      byRequirement: { "observability-runtime": ["observability-runtime"] },
      missing: []
    },
    gates: [{
      id: "observability-runtime",
      title: "Observability runtime",
      blockerLevel: "P0",
      owner: "platform-observability",
      coverage: ["observability-runtime"],
      status: "pass",
      evidencePath: "build/reports/observability-runtime-acceptance.json",
      commands: [{ command: "node tools/server-scripts/verify-observability-runtime-acceptance.mjs", exitCode: 0, timedOut: false, elapsedMs: 1 }],
      nextStep: ""
    }]
  }, null, 2)}\n`, "utf8");
}

async function verifyProductionHealthRuntime() {
  const reportRoot = path.join(tempRoot, "production-readiness");
  const dataRoot = path.join(tempRoot, "production-health-data");
  await writeProductionReadinessFixture(reportRoot);
  const health = await buildProductionHealthReport({
    repoRoot: ROOT,
    reportRoot,
    userDataPath: dataRoot,
    capabilityKernelBackend: "local-file",
    capabilityBindingBackend: "local-file"
  });
  assert.equal(health.reportType, PRODUCTION_HEALTH_REPORT_TYPE);
  assert.equal(health.status, "pass");
  assertReportProvenance(health, {
    producer: "licomesh-core-observability",
    commandId: "production-health.read",
    sourceRevision: PRODUCTION_HEALTH_REPORT_TYPE
  });
  assert.equal(health.latestReport?.runId, "observability-runtime-acceptance");
  assert.equal(health.coverage?.missing?.length, 0);
  assert.equal(health.gates.some((gate) => gate.id === "observability-runtime" && gate.status === "pass"), true);
  record("production-health-runtime", {
    reportType: health.reportType,
    status: health.status,
    gateProjected: true
  });
  return health;
}

async function verifyExecutiveReportRetention(productionHealth) {
  const dataRoot = path.join(tempRoot, "executive-report-data");
  const store = createExecutiveReportStore({ userDataPath: dataRoot });
  for (let index = 0; index < 55; index += 1) {
    await store.generate({
      reportId: `executive-report-${index}`,
      generatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      headline: `Executive report ${index}`,
      productionHealth
    });
  }
  const listed = await store.list();
  assert.equal(listed.protocolVersion, EXECUTIVE_REPORT_PROTOCOL_VERSION);
  assert.equal(listed.reports.length, 50);
  assert.equal(listed.reports[0].reportId, "executive-report-54");
  assert.equal(await store.get("executive-report-0"), null);
  assert.equal((await store.get("executive-report-54"))?.reportId, "executive-report-54");
  assertReportProvenance(listed.reports[0], {
    producer: "licomesh-core-observability",
    commandId: "executive-report.generate",
    sourceRevision: EXECUTIVE_REPORT_PROTOCOL_VERSION
  });
  const concurrentStore = createExecutiveReportStore({
    userDataPath: path.join(tempRoot, "executive-report-concurrent-data")
  });
  const concurrentBuilds = Array.from({ length: 20 }, (_, index) => concurrentStore.generate({
    reportId: `concurrent-report-${index}`,
    generatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
    productionHealth
  }));
  const queuePeak = concurrentStore.observabilityBudgets();
  await Promise.all(concurrentBuilds);
  const concurrentReports = (await concurrentStore.list()).reports;
  assert.equal(concurrentReports.length, 20);
  assert.equal(new Set(concurrentReports.map((report) => report.reportId)).size, 20);
  record("executive-report-generation-retention", {
    protocolVersion: listed.protocolVersion,
    retainedReportCount: listed.reports.length,
    oldestReportPruned: true,
    latestReportReadable: true,
    concurrentGenerationSerialized: true,
    queuePeak: queuePeak.queue,
    cacheAfterList: concurrentStore.observabilityBudgets().cache
  });
}

async function verifySystemInspectionSingleCycle() {
  const dataRoot = path.join(tempRoot, "inspection-data");
  const configPath = monitorAlertConfigPath(dataRoot);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify({
    schemaVersion: "v0.0.1:schema:definition-1",
    enabled: true,
    supervisorRecovery: { enabled: false },
    rules: {}
  }, null, 2)}\n`, "utf8");
  await execFileAsync(process.execPath, [
    path.join(ROOT, "tools/server-scripts/system-inspection-daemon.mjs"),
    "--project-root",
    ROOT,
    "--data-dir",
    dataRoot,
    "--once"
  ], {
    cwd: ROOT,
    env: { ...process.env, LICO_SERVER_DATA_DIR: dataRoot },
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
  const state = JSON.parse(await fs.readFile(monitorAlertStatePath(dataRoot), "utf8"));
  assert.equal(state.inspectionDaemon?.status, "running");
  assert.equal(state.inspectionDaemon?.runtime, "node");
  assert.equal(state.inspectionDaemon?.pid, undefined);
  assert.equal(state.inspectionDaemon?.projectRoot, undefined);
  assert.equal(state.inspectionDaemon?.dataDir, undefined);
  assert.equal(Boolean(state.updatedAt), true);
  assert.equal(Array.isArray(state.systemStatus?.registrations), true);
  record("system-inspection-single-cycle", {
    stateWritten: true,
    daemonHeartbeatProjected: true,
    unifiedRegistrationsProjected: true,
    privateRuntimeIdentityOmitted: true
  });
}

async function verifySystemInspectionArgumentContract() {
  const script = path.join(ROOT, "tools/server-scripts/system-inspection-daemon.mjs");
  await assert.rejects(
    execFileAsync(process.execPath, [script, "--data-dir", "--once"], {
      cwd: ROOT,
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    }),
    (error) => error?.code === 1 && /Missing value for system-inspection option/.test(error?.stderr || "")
  );
  await assert.rejects(
    execFileAsync(process.execPath, [script, "--once", "--once"], {
      cwd: ROOT,
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    }),
    (error) => error?.code === 1 && /Duplicate system-inspection option/.test(error?.stderr || "")
  );
  record("system-inspection-strict-arguments", {
    missingValueRejected: true,
    duplicateOptionRejected: true
  });
}

function verifyBoundedMetricsAndPublishingObservationContract() {
  const metrics = createBoundedMetricRegistry({
    families: ["alerts"],
    statuses: ["firing"],
    reasons: ["condition_matched"],
    stages: ["evaluate"],
    maxSeries: 1
  });
  metrics.record({
    family: "alerts",
    status: "firing",
    reason: "condition_matched",
    stage: "evaluate",
    durationMs: 5
  });
  assert.throws(() => metrics.record({
    family: "alerts",
    status: "subject-controlled",
    reason: "condition_matched",
    stage: "evaluate"
  }), (error) => error?.code === "observability_metric_dimension_rejected");

  const sink = createPublishingObservationSink();
  const partitionHash = "a".repeat(16);
  const stages = ["compile", "persist", "project", "notify", "pull", "acknowledge", "publish"];
  for (const [index, stage] of stages.entries()) {
    sink.publish({
      stage,
      outcome: "succeeded",
      reason: stage === "publish" ? "server_published" : "accepted",
      revision: 2,
      previousRevision: 1,
      durationMs: index + 1,
      lagMs: stage === "publish" ? 10 : 0,
      affectedPartitionHashes: [partitionHash],
      occurredAt: "2026-01-01T00:00:00.000Z"
    });
  }
  const publication = sink.snapshot();
  assert.equal(publication.latestRevision, 2);
  assert.deepEqual(publication.revisions[0].stages, [...stages].sort());
  assert.equal(JSON.stringify(publication).includes(partitionHash), false);
  record("bounded-metrics-publishing-observation-contract", {
    evidenceClass: "contract_producer_fixture",
    productionEvidenceStatus: "missing",
    clientAdoptionClaim: false,
    productionEvidenceBlocker: "upstream_service_publishing_production_producer_missing",
    metricSeriesCount: metrics.snapshot().seriesCount,
    uncontrolledDimensionRejected: true,
    publicationRevision: publication.latestRevision,
    publicationStageCount: publication.revisions[0].stages.length,
    partitionIdentityOmitted: true,
    budgets: {
      maxMetricSeries: OBSERVABILITY_BUDGETS.maxMetricSeries,
      maxPublicationPartitions: OBSERVABILITY_BUDGETS.maxPublicationPartitions,
      maxPublicationRevisions: OBSERVABILITY_BUDGETS.maxPublicationRevisions
    }
  });
}

async function verifyObservabilityBudgetCutoffs() {
  const cutoffCodes = [];
  for (const [kind, observation, budgets] of [
    ["duration", startObservabilityBudgetObservation({
      now: (() => { const values = [0, 6]; return () => values.shift(); })(),
      cpuUsage: () => ({ user: 0, system: 0 }),
      rss: () => 0
    }), { ...OBSERVABILITY_BUDGETS, maxCycleDurationMs: 5 }],
    ["cpu", startObservabilityBudgetObservation({
      now: () => 0,
      cpuUsage: (started) => started ? { user: 2_000, system: 0 } : { user: 0, system: 0 },
      rss: () => 0
    }), { ...OBSERVABILITY_BUDGETS, maxCycleCpuMs: 1 }],
    ["rss", startObservabilityBudgetObservation({
      now: () => 0,
      cpuUsage: () => ({ user: 0, system: 0 }),
      rss: (() => { const values = [0, 2]; return () => values.shift(); })()
    }), { ...OBSERVABILITY_BUDGETS, maxCycleRssDeltaBytes: 1 }]
  ]) {
    assert.throws(() => observation.finish({ budgets }), (error) => {
      cutoffCodes.push(error?.code || `${kind}_cutoff_missing`);
      return error?.code === `observability_${kind}_budget_exceeded`;
    });
  }

  const queue = createBoundedWorkQueue({ maxConcurrent: 1, maxPending: 1 });
  let release;
  const active = queue.run(() => new Promise((resolve) => { release = resolve; }));
  const pending = queue.run(() => "pending-complete");
  const queuePeak = queue.snapshot();
  assert.throws(() => queue.run(() => "overflow"), (error) => {
    cutoffCodes.push(error?.code || "queue_cutoff_missing");
    return error?.code === "observability_work_queue_budget_exceeded";
  });
  await Promise.resolve();
  release("active-complete");
  await Promise.all([active, pending]);

  const cache = createBoundedSnapshotCache({ maxEntries: 1, overflow: "error" });
  cache.set("first", Object.freeze({ status: "complete" }));
  assert.throws(() => cache.set("second", Object.freeze({ status: "overflow" })), (error) => {
    cutoffCodes.push(error?.code || "cache_cutoff_missing");
    return error?.code === "observability_snapshot_cache_budget_exceeded";
  });

  record("observability-budget-cutoffs", {
    evidenceClass: "deterministic_budget_fixture",
    queuePeak,
    cachePeak: cache.snapshot(),
    cutoffCodes: cutoffCodes.sort(),
    configuredBudgets: {
      maxWorkQueueDepth: OBSERVABILITY_BUDGETS.maxWorkQueueDepth,
      maxConcurrentReportBuilds: OBSERVABILITY_BUDGETS.maxConcurrentReportBuilds,
      maxReports: OBSERVABILITY_BUDGETS.maxReports,
      maxMetricSeries: OBSERVABILITY_BUDGETS.maxMetricSeries,
      maxCycleDurationMs: OBSERVABILITY_BUDGETS.maxCycleDurationMs,
      maxCycleCpuMs: OBSERVABILITY_BUDGETS.maxCycleCpuMs,
      maxCycleRssDeltaBytes: OBSERVABILITY_BUDGETS.maxCycleRssDeltaBytes
    }
  });
}

let readyForReleaseReduction = false;
const runtimeBudget = startObservabilityBudgetObservation();
try {
  const productionHealth = await verifyProductionHealthRuntime();
  await verifyExecutiveReportRetention(productionHealth);
  await verifySystemInspectionSingleCycle();
  await verifySystemInspectionArgumentContract();
  verifyBoundedMetricsAndPublishingObservationContract();
  await verifyObservabilityBudgetCutoffs();
  const observed = runtimeBudget.finish();
  record("observability-load-baseline", {
    observed,
    configuredBudgets: {
      maxCycleDurationMs: OBSERVABILITY_BUDGETS.maxCycleDurationMs,
      maxCycleCpuMs: OBSERVABILITY_BUDGETS.maxCycleCpuMs,
      maxCycleRssDeltaBytes: OBSERVABILITY_BUDGETS.maxCycleRssDeltaBytes
    },
    withinBudget: true
  });
  readyForReleaseReduction = true;
} catch {
  checks.push({
    id: "observability-runtime-acceptance",
    status: "failed",
    evidence: { errorCode: "observability_runtime_acceptance_failed" }
  });
}

const revision = await computeVerifierSourceRevision(ROOT, SOURCE_FILES);
const reportInput = {
  schemaVersion: REPORT_SCHEMA_VERSION,
  verifier: VERIFIER,
  generatedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  readyForReleaseReduction,
  dependencies: {
    upstreamServicePublishingProductionEvidence: {
      status: "blocked",
      reasonCode: "upstream_service_publishing_production_producer_missing",
      acceptedAsProductionEvidence: false
    }
  },
  checks,
  summary: {
    readyForReleaseReduction,
    checkCount: checks.length,
    failedCount: checks.filter((check) => check.status !== "passed").length,
    reportLeakScan: false
  }
};

try {
  const provenance = {
    producer: "licomesh-core-observability",
    commandId: COMMAND_ID,
    sourceRevision: revision
  };
  const report = await finalizeAndPublishSensitiveReport(reportInput, {
    filePath: REPORT_PATH,
    schemaVersion: REPORT_SCHEMA_VERSION,
    verifier: VERIFIER,
    provenance,
    checkpointDigest: await computeVerifierSourceRevision(ROOT, [PLAN_FILE]),
    requirements: REQUIREMENTS
  });
  assertNoSensitiveReportLeak(report, "observability runtime acceptance report");
  assertReportProvenance(report, provenance);
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

if (!readyForReleaseReduction) {
  console.error("[observability-runtime-acceptance] failed");
  process.exit(1);
}
console.log(`[observability-runtime-acceptance] verified checks=${checks.length}`);
