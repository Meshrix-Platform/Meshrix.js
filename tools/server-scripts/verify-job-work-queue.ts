#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT } from "../../packages/foundation/src/work-queue/index.ts";
import {
  createQueuedJobWorkflowProvider,
  JOB_WORK_QUEUE_DEFINITION_ID
} from "../../packages/server-runtime/src/composition/queued-job-workflow-provider.ts";
import { createQueueApplicationPort } from "../../packages/server-runtime/src/composition/queue-application-port.ts";
import { createJobManager } from "../../packages/server-runtime/src/jobs/jobs/job-manager.ts";
import { createUploadSessionStore } from "../../packages/server-runtime/src/state/upload-session-store.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.ts";

const REPO_ROOT: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH: any = path.join(process.cwd(), "build/reports/job-work-queue.json");
const VERIFIER: any = "tools/server-scripts/verify-job-work-queue.ts";
const COMMAND_ID: any = "job-work-queue";
const SOURCE_FILES: readonly any[] = Object.freeze([
  "packages/foundation/src/work-queue/index.ts",
  "packages/server-runtime/src/composition/queue-application-port.ts",
  "packages/server-runtime/src/composition/queued-job-workflow-provider.ts",
  "packages/server-runtime/src/jobs/jobs/job-manager.ts",
  VERIFIER
]);
const SENSITIVE_REPORT_PATTERNS: readonly any[] = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\]|<redacted-secret>)\S+/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{8,}\b|upstream-secret-value/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op|relay_session|relay_turn|delegated_mcp)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u],
  ["raw_payload", /raw prompt body|private file content/u]
]);

function sleep(ms?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, Math.max(0, ms)));
}

function sha256(text?: any) : any {
  return createHash("sha256").update(String(text)).digest("hex");
}

function assertNoLeak(value?: any, label?: any) : any {
  const text: any = JSON.stringify(value);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`${label} contains sensitive local or runtime data: ${kind}`);
    }
  }
}

async function writeReport(report?: any) : Promise<any> {
  const provenance: Record<string, any> = {
    producer: "meshrix-core-job-work-queue",
    commandId: COMMAND_ID,
    sourceRevision: await computeVerifierSourceRevision(REPO_ROOT, SOURCE_FILES)
  };
  const finalizedReport: any = finalizeSensitiveReport(report, { provenance });
  assertNoLeak(finalizedReport, "job work queue report");
  assertNoSensitiveReportLeak(finalizedReport, "job work queue report");
  assertReportProvenance(finalizedReport, provenance);
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(finalizedReport, null, 2)}\n`, "utf8");
}

async function removeTempDirectoryWithRetry(directoryPath?: any) : Promise<any> {
  let lastError: any = null;
  for (let attempt: any = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(directoryPath, { recursive: true, force: true });
      return;
    } catch (error: any) {
      lastError = error;
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(error?.code)) {
        throw error;
      }
      await sleep(100 * (attempt + 1));
    }
  }
  throw lastError;
}

async function waitForCompletedJob(provider?: any, jobId?: any, { timeoutMs = 90_000 }: Record<string, any> = {}) : Promise<any> {
  const startedAt: any = Date.now();
  let lastJob: any = null;
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

async function waitForCompletedState(provider?: any, { timeoutMs = 30_000 }: Record<string, any> = {}) : Promise<any> {
  const startedAt: any = Date.now();
  let lastStateCounts: any[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    const inspected: any = await provider.inspectWorkQueue({ limit: 10 });
    lastStateCounts = inspected.stateCounts;
    if (inspected.stateCounts.some((item?: any) : any => item.state === "completed" && item.count >= 1)) {
      return inspected;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for completed work queue state; last=${JSON.stringify(lastStateCounts)}`);
}

async function waitForJobManagerIdle(jobManager?: any, { timeoutMs = 30_000 }: Record<string, any> = {}) : Promise<any> {
  const startedAt: any = Date.now();
  let lastSummary: Record<string, any> = {};
  while (Date.now() - startedAt < timeoutMs) {
    const listed: any = await jobManager.listJobs({ limit: 10 });
    lastSummary = listed.summary || {};
    const activeCount: any = Array.isArray(lastSummary.activeJobIds) ? lastSummary.activeJobIds.length : 0;
    const queuedCount: any = Number(lastSummary.queuedCount || 0);
    const runningCount: any = Number(lastSummary.runningCount || 0);
    if (activeCount === 0 && queuedCount === 0 && runningCount === 0) {
      return lastSummary;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for job manager idle; last=${JSON.stringify(lastSummary)}`);
}

async function main() : Promise<any> {
  const startedAt: any = new Date();
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-job-work-queue-"));
  const rejectUnexpectedUploadAccess: any = async () : Promise<never> => {
    throw new Error("The job work queue verifier does not admit upload-session access.");
  };
  const uploadSessionStore: any = createUploadSessionStore({
    userDataPath,
    custodyPort: {
      begin: rejectUnexpectedUploadAccess,
      append: rejectUnexpectedUploadAccess,
      seal: rejectUnexpectedUploadAccess
    },
    custodyDescribe: rejectUnexpectedUploadAccess
  });
  const jobManager: any = createJobManager({
    userDataPath,
    uploadSessionStore,
    storageProvider: { commitUploadConsumptionReceipt: rejectUnexpectedUploadAccess },
    processingEnabled: true,
    runtimeOptions: {
      testHooks: {
        jobDelayMs: 1
      }
    }
  });
  const queueApplicationPort: any = await createQueueApplicationPort({ userDataPath });
  const provider: any = await createQueuedJobWorkflowProvider({
    jobManager,
    queueApplicationPort,
    autoStart: true,
    maxInFlight: WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT * 4,
    dispatchBatchSize: 1
  });
  queueApplicationPort.start();

  try {
    const description: any = provider.describe();
    assert.equal(description.queue.effectiveMaxInFlight, WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT);
    assert.equal(description.queue.maxInFlightClamped, true);
    assert.equal(description.queue.queueDefinitionId, JOB_WORK_QUEUE_DEFINITION_ID);
    assert.equal((await jobManager.listJobs({ limit: 1 })).summary.schedulerMode, "platform-work-queue");
    await provider.pauseWorkQueue({
      reason: "verify_failed_recovery_setup"
    });

    const inputText: any = [
      "# Platform Queue Verification",
      "",
      "Alice confirmed the private-cloud queue migration on 2026-06-13.",
      "Bob must review the durable state replay before production rollout."
    ].join("\n");
    const checkpointId: any = `verify_job_work_queue_${Date.now()}`;
    const job: any = await provider.createJob({
      inputText,
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
    const queued: any = await provider.inspectWorkQueue({ limit: 10 });
    assert.equal(
      queued.stateCounts.reduce((total?: any, item?: any) : any => total + Number(item.count || 0), 0) >= 1,
      true
    );
    const queuedItem: any = queued.items.find((item?: any) : any => item.state === "queued");
    assert.ok(queuedItem?.workItemId, "queued work item should be inspectable before dispatch");
    const failedWork: any = await provider.failWorkQueueItem({
      workItemId: queuedItem.workItemId,
      operationId: "verify.jobs.work_queue.fail",
      reason: "verify_failed_recovery_path"
    });
    assert.equal(failedWork.failed, true, "work item should enter failed for recovery proof");
    assert.equal((await provider.getJob(job.id)).status, "queued", "scheduler failure must not mutate platform job state");
    const recoveredWork: any = await provider.recoverFailedWorkQueue({
      limit: 10,
      reason: "verify_recover_failed"
    });
    assert.equal(recoveredWork.recoveredCount, 1, "failed-work recovery should recover one work item");
    assert.equal(recoveredWork.failedCount, 0, "failed-work recovery should not fail");
    await provider.resumeWorkQueue({
      reason: "verify_failed_recovery_complete"
    });

    const completedJob: any = await waitForCompletedJob(provider, job.id);
    const result: any = await provider.getJobResult(job.id);
    assert.ok(result?.jobId === job.id, "result should belong to the queued job");

    const inspected: any = await waitForCompletedState(provider);
    const idleSummary: any = await waitForJobManagerIdle(jobManager);
    const rebuildProof: any = await provider.rebuildWorkQueueProof({
      reason: "verify_rebuild_projection"
    });
    assert.equal(rebuildProof.ok, true, "provider rebuild proof should be exposed through work queue management");
    const replay: any = rebuildProof.proof;

    const finishedAt: any = new Date();
    const report: Record<string, any> = {
      schemaVersion: "v0.0.1:workflow:job-work-queue-report-1",
      generatedAt: finishedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      verifier: VERIFIER,
      ok: true,
      summary: {
        releaseReady: true,
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
