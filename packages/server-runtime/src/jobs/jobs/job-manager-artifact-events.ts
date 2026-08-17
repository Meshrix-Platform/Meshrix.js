import {
  checkpointTreeId,
  finishCheckpointTree,
  startCheckpointTree,
  upsertCheckpointNode,
  workflowId
} from "#meshrix/product-api";
import { deleteUploadSession } from "../../state/upload-session-store.ts";
import { normalizeManifestKey } from "./job-manager-validation.ts";
import {
  loadJobResult,
  persistJobMeta,
  persistJobTerminal
} from "./job-manager-persistence.ts";
import { cloneJob } from "./job-manager-projection.ts";
import { errorProperty, type JobDocument, type JobPatch, type JobPayload, type JobResult } from "./contracts.ts";
import type { createJobProjectionStore } from "./job-projection-store.ts";

interface CleanupEntry { jobId: string; receiptId: string; sessionId: string; state?: string }
interface ArtifactContext {
  userDataPath: string;
  protocolEventBus: { publish(type: string, payload: object, metadata?: object): Promise<unknown> } | null;
  durableWorkflows: Record<string, (...args: unknown[]) => Promise<unknown>>;
  logJob(level: string, event: string, details?: Record<string, unknown>): void;
  jobs: Map<string, JobDocument>;
  checkpointJobs: Map<string, string>;
  jobProjectionStore: ReturnType<typeof createJobProjectionStore>;
  storageProvider: import("./contracts.ts").UploadConsumptionStorageProvider | null;
  forgetActiveManifestJob(job?: JobDocument | null): void;
  rememberActiveManifestJob(job: JobDocument): void;
}

function uploadCleanupError(code: string, message: string, statusCode = 500) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function createJobManagerArtifacts(ctx: ArtifactContext) {
  const {
    userDataPath,
    protocolEventBus,
    durableWorkflows,
    logJob,
    jobs,
    checkpointJobs,
    jobProjectionStore,
    storageProvider
  } = ctx;

  function retireTerminalJob(job?: JobDocument | null) {
    if (!job || !["completed", "failed", "cancelled"].includes(job.status)) {
      return;
    }
    jobs.delete(job.id);
    if (job.checkpointId) checkpointJobs.delete(job.checkpointId);
    ctx.forgetActiveManifestJob(job);
  }

  function checkpointTreeIdForJob(job?: JobDocument | null) {
    return job?.checkpointTreeId || (job?.id ? checkpointTreeId("job", job.id) : "");
  }

  function workflowIdForJob(job?: JobDocument | null) {
    return job?.workflowId || (job?.id ? workflowId("import_parse_job", job.id) : "");
  }

  async function ensureJobCheckpointTree(job: JobDocument, payload: JobPayload | null = null) {
    if (!job?.id) {
      return "";
    }
    const treeId = checkpointTreeIdForJob(job);
    const manifestKey = normalizeManifestKey(payload || job);
    await startCheckpointTree({
      userDataPath,
      treeId,
      kind: "import_parse_job",
      ownerId: job.id,
      inputHash: manifestKey || job.checkpointId || job.id,
      rootNodeId: "import-parse-job",
      rootLabel: "导入解析任务",
      metadata: {
        jobId: job.id,
        workflowId: workflowIdForJob(job),
        checkpointId: job.checkpointId || "",
        archiveBatchId: job.archiveBatchId || "",
        uploadSessionId: job.uploadSessionId || "",
        manifestSha256: manifestKey,
        gatewaySourceId: payload?.gatewaySource?.sourceId || ""
      },
      resumePolicy: {
        mode: "job-payload+import-entry-checkpoint",
        idempotencyKey: "checkpointId/manifestSha256",
        reusableState: "jobs/<jobId>/payload.json + jobs/<jobId>/import-checkpoint"
      },
      resetOnInputHashChange: false
    });
    return treeId;
  }

  async function updateJobCheckpointNode(job: JobDocument, node: Record<string, unknown>) {
    const treeId = checkpointTreeIdForJob(job);
    if (!treeId) {
      return null;
    }
    return upsertCheckpointNode({
      userDataPath,
      treeId,
      ...node
    }).catch(() => null);
  }

  async function finishJobCheckpoint(job: JobDocument, input: Record<string, unknown> = {}) {
    const treeId = checkpointTreeIdForJob(job);
    if (!treeId) {
      return null;
    }
    return finishCheckpointTree({
      userDataPath,
      treeId,
      ...input
    }).catch(() => null);
  }

  async function publishJobEvent(job: JobDocument, type = "jobs.job.updated") {
    if (!protocolEventBus || typeof protocolEventBus.publish !== "function") {
      return null;
    }
    return protocolEventBus.publish(
      "jobs.job",
      {
        job: cloneJob(job)
      },
      { type, trace: job.trace || null }
    );
  }

  async function publishDeletedJobEvent(job: JobDocument) {
    if (!protocolEventBus || typeof protocolEventBus.publish !== "function") {
      return null;
    }
    return protocolEventBus.publish(
      "jobs.deleted",
      {
        job: cloneJob(job)
      },
      { type: "jobs.deleted", trace: job.trace || null }
    );
  }

  async function updateJob(jobId: string, patch: JobPatch) {
    const currentJob = jobs.get(jobId);

    if (!currentJob) {
      logJob("warn", "jobs.job.update.skipped", {
        jobId,
        reason: "job_missing",
        patch
      });
      return null;
    }

    const { eventType, ...jobPatch } = patch;
    const nextJob: JobDocument = {
      ...currentJob,
      ...jobPatch,
      updatedAt: new Date().toISOString()
    };
    await persistJobMeta(userDataPath, nextJob, jobProjectionStore);
    ctx.forgetActiveManifestJob(currentJob);
    Object.assign(currentJob, nextJob);
    if (["queued", "running"].includes(currentJob.status)) {
      ctx.rememberActiveManifestJob(currentJob);
    }
    await publishJobEvent(currentJob, eventType || "jobs.job.updated");
    retireTerminalJob(currentJob);
    logJob("info", "jobs.job.updated", {
      jobId,
      status: currentJob.status,
      stage: currentJob.stage,
      progressPercent: currentJob.progressPercent,
      eventType: eventType || "jobs.job.updated",
      patch
    });
    return currentJob;
  }

  async function commitJobTerminal(jobId: string, patch: JobPatch, result: JobResult) {
    const currentJob = jobs.get(jobId);
    if (!currentJob) return null;
    const { eventType, ...jobPatch } = patch;
    const nextJob: JobDocument = {
      ...currentJob,
      ...jobPatch,
      status: "completed",
      updatedAt: new Date().toISOString()
    };
    await persistJobTerminal(
      userDataPath,
      nextJob,
      result,
      jobProjectionStore
    );
    ctx.forgetActiveManifestJob(currentJob);
    Object.assign(currentJob, nextJob);
    await publishJobEvent(currentJob, eventType || "jobs.job.completed");
    retireTerminalJob(currentJob);
    logJob("info", "jobs.job.updated", {
      jobId,
      status: currentJob.status,
      stage: currentJob.stage,
      progressPercent: currentJob.progressPercent,
      eventType: eventType || "jobs.job.completed"
    });
    return currentJob;
  }

  async function requireDurableUploadReceipt(receiptId: string, sessionId: string) {
    if (
      typeof storageProvider?.getUploadConsumptionReceipt !== "function"
    ) {
      throw uploadCleanupError(
        "upload_consumption_receipt_store_unavailable",
        "Durable upload-consumption receipt storage is unavailable.",
        503
      );
    }
    const receipt = await storageProvider.getUploadConsumptionReceipt(
      receiptId
    );
    if (
      !receipt ||
      String(receipt.receiptId || "") !== String(receiptId || "") ||
      String(receipt.sessionId || "") !== String(sessionId || "")
    ) {
      throw uploadCleanupError(
        "upload_consumption_receipt_missing",
        "The upload-consumption receipt is not durable for this session.",
        409
      );
    }
    return receipt;
  }

  async function attemptUploadCleanup(entry: CleanupEntry) {
    try {
      await deleteUploadSession(userDataPath, entry.sessionId);
      jobProjectionStore.settleUploadCleanupJournal(entry.sessionId);
      return true;
    } catch (error) {
      logJob("warn", "jobs.upload_session.cleanup.deferred", {
        jobId: entry.jobId,
        reason: String(errorProperty(error, "code") || "upload_session_cleanup_failed")
      });
      return false;
    }
  }

  async function validateCleanupEntry(entry: CleanupEntry) {
    const job = jobProjectionStore.get(entry.jobId);
    if (
      !job ||
      job.status !== "completed" ||
      String(job.uploadSessionId || "") !== entry.sessionId ||
      String(job.uploadConsumptionReceiptId || "") !== entry.receiptId
    ) {
      return null;
    }
    const result = await loadJobResult(
      userDataPath,
      entry.jobId,
      jobProjectionStore
    ).catch(() => null);
    if (
      String(result?.uploadConsumptionReceiptId || "") !== entry.receiptId
    ) {
      return null;
    }
    await requireDurableUploadReceipt(entry.receiptId, entry.sessionId);
    return job;
  }

  async function replayUploadCleanupJournal() {
    const entries = jobProjectionStore.listUploadCleanupJournal();
    for (const entry of entries) {
      try {
        const job = await validateCleanupEntry(entry);
        if (!job) {
          logJob("warn", "jobs.upload_session.cleanup.retained", {
            jobId: entry.jobId,
            reason: "durable_terminal_or_receipt_missing"
          });
          continue;
        }
        await attemptUploadCleanup(entry);
      } catch (error) {
        logJob("warn", "jobs.upload_session.cleanup.retained", {
          jobId: entry.jobId,
          reason: String(errorProperty(error, "code") || "cleanup_revalidation_failed")
        });
      }
    }
  }

  async function commitTerminalThenScheduleUploadCleanup({
    jobId,
    receiptId,
    sessionId,
    terminalPatch = {},
    result = null
  }: {
    jobId?: string; receiptId?: string; sessionId?: string;
    terminalPatch?: JobPatch; result?: JobResult | null;
  } = {}) {
    const normalizedJobId = String(jobId || "").trim();
    const normalizedReceiptId = String(receiptId || "").trim();
    const normalizedSessionId = String(sessionId || "").trim();
    const currentJob =
      jobs.get(normalizedJobId) ||
      jobProjectionStore.get(normalizedJobId);
    if (!currentJob) {
      throw uploadCleanupError(
        "job_projection_missing",
        "The job required for upload cleanup is missing.",
        404
      );
    }
    if (
      !normalizedReceiptId ||
      !normalizedSessionId ||
      String(currentJob.uploadSessionId || "") !== normalizedSessionId
    ) {
      throw uploadCleanupError(
        "upload_cleanup_binding_invalid",
        "Upload cleanup does not match the job session.",
        409
      );
    }
    await requireDurableUploadReceipt(
      normalizedReceiptId,
      normalizedSessionId
    );

    let terminalJob = currentJob;
    if (currentJob.status !== "completed") {
      const terminalResult = {
        ...(result && typeof result === "object" && !Array.isArray(result)
          ? result
          : {}),
        uploadConsumptionReceiptId: normalizedReceiptId
      };
      const committedJob = await commitJobTerminal(
        normalizedJobId,
        {
          ...terminalPatch,
          uploadConsumptionReceiptId: normalizedReceiptId
        },
        terminalResult
      );
      if (!committedJob) {
        throw uploadCleanupError("job_missing", "Completed job is unavailable.", 404);
      }
      terminalJob = committedJob;
    } else {
      const persistedResult = await loadJobResult(
        userDataPath,
        normalizedJobId,
        jobProjectionStore
      );
      if (
        String(currentJob.uploadConsumptionReceiptId || "") !==
          normalizedReceiptId ||
        String(persistedResult?.uploadConsumptionReceiptId || "") !==
          normalizedReceiptId
      ) {
        throw uploadCleanupError(
          "upload_cleanup_terminal_conflict",
          "The durable job terminal conflicts with the upload receipt.",
          409
        );
      }
    }

    const journal = jobProjectionStore.commitUploadCleanupJournal({
      jobId: normalizedJobId,
      receiptId: normalizedReceiptId,
      sessionId: normalizedSessionId
    });
    await attemptUploadCleanup(journal);
    return terminalJob;
  }

  async function failJob(jobId: string, errorMessage: string, stage: string) {
    const finishedAt = new Date().toISOString();
    const currentJob = ctx.jobs.get(jobId);
    if (currentJob) {
      await updateJobCheckpointNode(currentJob, {
        nodeId: "job-failed",
        parentId: "import-parse-job",
        label: stage || "任务失败",
        status: "failed",
        error: errorMessage || "",
        cursor: {
          progressPercent: Number(currentJob.progressPercent || 0),
          stage: stage || ""
        }
      });
      await finishJobCheckpoint(currentJob, {
        status: "failed",
        message: errorMessage || stage || "Job failed.",
        metadata: {
          stage: stage || "",
          progressPercent: Number(currentJob.progressPercent || 0)
        }
      });
      await durableWorkflows.failActivity(currentJob.workflowId || workflowIdForJob(currentJob), "job-execution", errorMessage || stage || "Job failed.").catch(() => null);
      await durableWorkflows.failWorkflow(currentJob.workflowId || workflowIdForJob(currentJob), errorMessage || stage || "Job failed.").catch(() => null);
    }
    logJob("error", "jobs.job.fail_requested", {
      jobId,
      stage,
      errorMessage
    });
    const failedJob = await updateJob(jobId, {
      status: "failed",
      stage,
      error: errorMessage,
      finishedAt
    });
    if (failedJob) {
    }
    return failedJob;
  }

  return {
    checkpointTreeIdForJob,
    workflowIdForJob,
    ensureJobCheckpointTree,
    updateJobCheckpointNode,
    finishJobCheckpoint,
    publishJobEvent,
    publishDeletedJobEvent,
    updateJob,
    commitJobTerminal,
    commitTerminalThenScheduleUploadCleanup,
    replayUploadCleanupJournal,
    failJob
  };
}
