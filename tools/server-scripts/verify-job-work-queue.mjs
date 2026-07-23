#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT } from "../../packages/foundation/src/work-queue/index.mjs";
import {
  createQueuedJobWorkflowProvider,
  JOB_WORK_QUEUE_DEFINITION_ID
} from "../../packages/server-runtime/src/composition/queued-job-workflow-provider.mjs";
import { createQueueApplicationPort } from "../../packages/server-runtime/src/composition/queue-application-port.mjs";
import { createJobManager } from "../../packages/server-runtime/src/jobs/jobs/job-manager.mjs";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH = path.join(process.cwd(), "build/reports/job-work-queue.json");
const VERIFIER = "tools/server-scripts/verify-job-work-queue.mjs";
const COMMAND_ID = "job-work-queue";
const SOURCE_FILES = Object.freeze([
  "packages/foundation/src/work-queue/index.mjs",
  "packages/server-runtime/src/composition/queue-application-port.mjs",
  "packages/server-runtime/src/composition/queued-job-workflow-provider.mjs",
  "packages/server-runtime/src/jobs/jobs/job-manager.mjs",
  VERIFIER
]);
const SENSITIVE_REPORT_PATTERNS = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\]|<redacted-secret>)\S+/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{8,}\b|upstream-secret-value/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op|relay_session|relay_turn|delegated_mcp)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u],
  ["raw_payload", /raw prompt body|private file content/u]
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function assertNoLeak(value, label) {
  const text = JSON.stringify(value);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`${label} contains sensitive local or runtime data: ${kind}`);
    }
  }
}

async function writeReport(report) {
  const provenance = {
    producer: "licomesh-core-job-work-queue",
    commandId: COMMAND_ID,
    sourceRevision: await computeVerifierSourceRevision(REPO_ROOT, SOURCE_FILES)
  };
  const finalizedReport = finalizeSensitiveReport(report, { provenance });
  assertNoLeak(finalizedReport, "job work queue report");
  assertNoSensitiveReportLeak(finalizedReport, "job work queue report");
  assertReportProvenance(finalizedReport, provenance);
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(finalizedReport, null, 2)}\n`, "utf8");
}

async function removeTempDirectoryWithRetry(directoryPath) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(directoryPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(error?.code)) {
        throw error;
      }
      await sleep(100 * (attempt + 1));
    }
  }
  throw lastError;
}

async function waitForCompletedJob(provider, jobId, { timeoutMs = 90_000 } = {}) {
  const startedAt = Date.now();
  let lastJob = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastJob = await provider.getJob(jobId);
    if (lastJob?.status === "completed") {
      return lastJob;
    }
    if (lastJob?.status === "failed") {
      throw new Error(`platform job failed: ${lastJob.error || lastJob.stage || jobId}`);
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for queued platform job ${jobId}; last=${JSON.stringify(lastJob)}`);
}

async function waitForCompletedState(provider, { timeoutMs = 30_000 } = {}) {
  const startedAt = Date.now();
  let lastStateCounts = [];
  while (Date.now() - startedAt < timeoutMs) {
    const inspected = await provider.inspectWorkQueue({ limit: 10 });
    lastStateCounts = inspected.stateCounts;
    if (inspected.stateCounts.some((item) => item.state === "completed" && item.count >= 1)) {
      return inspected;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for completed work queue state; last=${JSON.stringify(lastStateCounts)}`);
}

async function waitForJobManagerIdle(jobManager, { timeoutMs = 30_000 } = {}) {
  const startedAt = Date.now();
  let lastSummary = {};
  while (Date.now() - startedAt < timeoutMs) {
    const listed = await jobManager.listJobs({ limit: 10 });
    lastSummary = listed.summary || {};
    const activeCount = Array.isArray(lastSummary.activeJobIds) ? lastSummary.activeJobIds.length : 0;
    const queuedCount = Number(lastSummary.queuedCount || 0);
    const runningCount = Number(lastSummary.runningCount || 0);
    if (activeCount === 0 && queuedCount === 0 && runningCount === 0) {
      return lastSummary;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for job manager idle; last=${JSON.stringify(lastSummary)}`);
}

async function main() {
  const startedAt = new Date();
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-job-work-queue-"));
  const jobManager = createJobManager({
    userDataPath,
    processingEnabled: true,
    runtimeOptions: {
      testHooks: {
        jobDelayMs: 1
      }
    }
  });
  const queueApplicationPort = await createQueueApplicationPort({ userDataPath });
  const provider = await createQueuedJobWorkflowProvider({
    jobManager,
    queueApplicationPort,
    autoStart: true,
    maxInFlight: WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT * 4,
    dispatchBatchSize: 1
  });
  queueApplicationPort.start();

  try {
    const description = provider.describe();
    assert.equal(description.queue.effectiveMaxInFlight, WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT);
    assert.equal(description.queue.maxInFlightClamped, true);
    assert.equal(description.queue.queueDefinitionId, JOB_WORK_QUEUE_DEFINITION_ID);
    assert.equal((await jobManager.listJobs({ limit: 1 })).summary.schedulerMode, "platform-work-queue");
    await provider.pauseWorkQueue({
      reason: "verify_failed_recovery_setup"
    });

    const inputText = [
      "# Platform Queue Verification",
      "",
      "Alice confirmed the private-cloud queue migration on 2026-06-13.",
      "Bob must review the durable state replay before production rollout."
    ].join("\n");
    const checkpointId = `verify_job_work_queue_${Date.now()}`;
    const job = await provider.createJob({
      inputText,
      uploadedFiles: [],
      filePaths: [],
      settings: {
        gatewayRoutingEnabled: true
      },
      checkpointReceipt: {
        checkpointId,
        manifestSha256: sha256(inputText),
        archiveBatchId: `verify_archive_${checkpointId}`,
        clientUid: "verify-job-work-queue",
        sourceType: "verification"
      }
    });

    assert.ok(job?.id, "job id should be generated");
    const queued = await provider.inspectWorkQueue({ limit: 10 });
    assert.equal(
      queued.stateCounts.reduce((total, item) => total + Number(item.count || 0), 0) >= 1,
      true
    );
    const queuedItem = queued.items.find((item) => item.state === "queued");
    assert.ok(queuedItem?.workItemId, "queued work item should be inspectable before dispatch");
    const failedWork = await provider.failWorkQueueItem({
      workItemId: queuedItem.workItemId,
      operationId: "verify.jobs.work_queue.fail",
      reason: "verify_failed_recovery_path"
    });
    assert.equal(failedWork.failed, true, "work item should enter failed for recovery proof");
    assert.equal((await provider.getJob(job.id)).status, "queued", "scheduler failure must not mutate platform job state");
    const recoveredWork = await provider.recoverFailedWorkQueue({
      limit: 10,
      reason: "verify_recover_failed"
    });
    assert.equal(recoveredWork.recoveredCount, 1, "failed-work recovery should recover one work item");
    assert.equal(recoveredWork.failedCount, 0, "failed-work recovery should not fail");
    await provider.resumeWorkQueue({
      reason: "verify_failed_recovery_complete"
    });

    const completedJob = await waitForCompletedJob(provider, job.id);
    const result = await provider.getJobResult(job.id);
    assert.ok(result?.jobId === job.id, "result should belong to the queued job");

    const inspected = await waitForCompletedState(provider);
    const idleSummary = await waitForJobManagerIdle(jobManager);
    const rebuildProof = await provider.rebuildWorkQueueProof({
      reason: "verify_rebuild_projection"
    });
    assert.equal(rebuildProof.ok, true, "provider rebuild proof should be exposed through work queue management");
    const replay = rebuildProof.proof;

    const finishedAt = new Date();
    const report = {
      schemaVersion: "v0.0.1:workflow:job-work-queue-report-1",
      generatedAt: finishedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      verifier: VERIFIER,
      ok: true,
      summary: {
        verificationPassed: true,
        coverageComplete: true,
        stableDefinitionIdentity: description.queue.queueDefinitionId === JOB_WORK_QUEUE_DEFINITION_ID,
        canonicalSchedulerOnly: true,
        protocolVersion: provider.protocolVersion,
        storeKind: description.queue.storeKind,
        jobStatus: completedJob.status,
        activeJobCount: idleSummary.activeJobIds?.length || 0,
        maxInFlightClamped: description.queue.maxInFlightClamped === true,
        effectiveMaxInFlight: description.queue.effectiveMaxInFlight,
        replayReady: replay.ok === true,
        rebuildProofReady: rebuildProof.ok === true
      },
      checks: [
        {
          id: "max-in-flight-hard-limit",
          status: "passed",
          effectiveMaxInFlight: description.queue.effectiveMaxInFlight
        },
        { id: "stable-job-queue-definition", status: "passed" },
        { id: "canonical-platform-work-queue-scheduler", status: "passed" },
        { id: "enqueue-inspect-failed-recovery", status: "passed" },
        { id: "queued-platform-job-completes", status: "passed" },
        { id: "completed-state-observed", status: "passed" },
        { id: "job-manager-idle-after-drain", status: "passed" },
        { id: "projection-rebuild", status: "passed" }
      ],
      stateCounts: inspected.stateCounts
    };
    await writeReport(report);

    console.log(JSON.stringify({
      ok: true,
      report: "build/reports/job-work-queue.json",
      protocolVersion: provider.protocolVersion,
      jobStatus: completedJob.status,
      storeKind: description.queue.storeKind,
      activeJobCount: idleSummary.activeJobIds?.length || 0,
      stateCounts: inspected.stateCounts
    }, null, 2));
  } finally {
    await queueApplicationPort.stop();
    await provider.close();
    await queueApplicationPort.close();
    await jobManager.close();
    await removeTempDirectoryWithRetry(userDataPath);
  }
}

await main();
