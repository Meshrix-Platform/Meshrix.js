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

function uploadCleanupError(code?: any, message?: any, statusCode: any = 500) : any {
  return Object.assign(new Error(message), { code, statusCode });
}

export function createJobManagerArtifacts(ctx?: any) : any {
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

  function retireTerminalJob(job?: any) : any {
    if (!job || !["completed", "failed", "cancelled"].includes(job.status)) {
      return;
    }
    jobs.delete(job.id);
    if (job.checkpointId) checkpointJobs.delete(job.checkpointId);
    ctx.forgetActiveManifestJob(job);
  }

  function checkpointTreeIdForJob(job?: any) : any {
    return job?.checkpointTreeId || (job?.id ? checkpointTreeId("job", job.id) : "");
  }

  function workflowIdForJob(job?: any) : any {
    return job?.workflowId || (job?.id ? workflowId("import_parse_job", job.id) : "");
  }

  async function ensureJobCheckpointTree(job?: any, payload: any = null) : Promise<any> {
    if (!job?.id) {
      return "";
    }
    const treeId: any = checkpointTreeIdForJob(job);
    const manifestKey: any = normalizeManifestKey(payload || job);
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

  async function updateJobCheckpointNode(job?: any, node?: any) : Promise<any> {
    const treeId: any = checkpointTreeIdForJob(job);
    if (!treeId) {
      return null;
    }
    return upsertCheckpointNode({
      userDataPath,
      treeId,
      ...node
    }).catch(() : any => null);
  }

  async function finishJobCheckpoint(job?: any, input: Record<string, any> = {}) : Promise<any> {
    const treeId: any = checkpointTreeIdForJob(job);
    if (!treeId) {
      return null;
    }
    return finishCheckpointTree({
      userDataPath,
      treeId,
      ...input
    }).catch(() : any => null);
  }

  async function publishJobEvent(job?: any, type: any = "jobs.job.updated") : Promise<any> {
    if (!protocolEventBus || typeof protocolEventBus.publish !== "function") {
      return null;
    }
    return protocolEventBus.publish(
      "jobs.job",
      {
        job: ctx.cloneJobForApi(job)
      },
      { type, trace: job.trace || null }
    );
  }

  async function publishDeletedJobEvent(job?: any) : Promise<any> {
    if (!protocolEventBus || typeof protocolEventBus.publish !== "function") {
      return null;
    }
    return protocolEventBus.publish(
      "jobs.deleted",
      {
        job: ctx.cloneJobForApi(job)
      },
      { type: "jobs.deleted", trace: job.trace || null }
    );
  }

  async function updateJob(jobId?: any, patch?: any) : Promise<any> {
    const currentJob: any = jobs.get(jobId);

    if (!currentJob) {
      logJob("warn", "jobs.job.update.skipped", {
        jobId,
        reason: "job_missing",
        patch
      });
      return null;
    }

    const { eventType, ...jobPatch } = patch;
    const nextJob: Record<string, any> = {
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

  async function commitJobTerminal(jobId?: any, patch?: any, result?: any) : Promise<any> {
    const currentJob: any = jobs.get(jobId);
    if (!currentJob) return null;
    const { eventType, ...jobPatch } = patch;
    const nextJob: Record<string, any> = {
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

  async function requireDurableUploadReceipt(receiptId?: any, sessionId?: any) : Promise<any> {
    if (
      typeof storageProvider?.getUploadConsumptionReceipt !== "function"
    ) {
      throw uploadCleanupError(
        "upload_consumption_receipt_store_unavailable",
        "Durable upload-consumption receipt storage is unavailable.",
        503
      );
    }
    const receipt: any = await storageProvider.getUploadConsumptionReceipt(
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

  async function attemptUploadCleanup(entry?: any) : Promise<any> {
    try {
      await deleteUploadSession(userDataPath, entry.sessionId);
      jobProjectionStore.settleUploadCleanupJournal(entry.sessionId);
      return true;
    } catch (error: any) {
      logJob("warn", "jobs.upload_session.cleanup.deferred", {
        jobId: entry.jobId,
        reason: String(error?.code || "upload_session_cleanup_failed")
      });
      return false;
    }
  }

  async function validateCleanupEntry(entry?: any) : Promise<any> {
    const job: any = jobProjectionStore.get(entry.jobId);
    if (
      !job ||
      job.status !== "completed" ||
      String(job.uploadSessionId || "") !== entry.sessionId ||
      String(job.uploadConsumptionReceiptId || "") !== entry.receiptId
    ) {
      return null;
    }
    const result: any = await loadJobResult(
      userDataPath,
      entry.jobId,
      jobProjectionStore
    ).catch(() : any => null);
    if (
      String(result?.uploadConsumptionReceiptId || "") !== entry.receiptId
    ) {
      return null;
    }
    await requireDurableUploadReceipt(entry.receiptId, entry.sessionId);
    return job;
  }

  async function replayUploadCleanupJournal() : Promise<any> {
    const entries: any = jobProjectionStore.listUploadCleanupJournal();
    for (const entry of entries) {
      try {
        const job: any = await validateCleanupEntry(entry);
        if (!job) {
          logJob("warn", "jobs.upload_session.cleanup.retained", {
            jobId: entry.jobId,
            reason: "durable_terminal_or_receipt_missing"
          });
          continue;
        }
        await attemptUploadCleanup(entry);
      } catch (error: any) {
        logJob("warn", "jobs.upload_session.cleanup.retained", {
          jobId: entry.jobId,
          reason: String(error?.code || "cleanup_revalidation_failed")
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
  }: Record<string, any> = {}) : Promise<any> {
    const normalizedJobId: any = String(jobId || "").trim();
    const normalizedReceiptId: any = String(receiptId || "").trim();
    const normalizedSessionId: any = String(sessionId || "").trim();
    const currentJob: any =
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

    let terminalJob: any = currentJob;
    if (currentJob.status !== "completed") {
      const terminalResult: Record<string, any> = {
        ...(result && typeof result === "object" && !Array.isArray(result)
          ? result
          : {}),
        uploadConsumptionReceiptId: normalizedReceiptId
      };
      terminalJob = await commitJobTerminal(
        normalizedJobId,
        {
          ...terminalPatch,
          uploadConsumptionReceiptId: normalizedReceiptId
        },
        terminalResult
      );
    } else {
      const persistedResult: any = await loadJobResult(
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

    const journal: any = jobProjectionStore.commitUploadCleanupJournal({
      jobId: normalizedJobId,
      receiptId: normalizedReceiptId,
      sessionId: normalizedSessionId
    });
    await attemptUploadCleanup(journal);
    return terminalJob;
  }

  async function failJob(jobId?: any, errorMessage?: any, stage?: any) : Promise<any> {
    const finishedAt: any = new Date().toISOString();
    const currentJob: any = ctx.jobs.get(jobId);
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
      await durableWorkflows.failActivity(currentJob.workflowId || workflowIdForJob(currentJob), "job-execution", errorMessage || stage || "Job failed.").catch(() : any => null);
      await durableWorkflows.failWorkflow(currentJob.workflowId || workflowIdForJob(currentJob), errorMessage || stage || "Job failed.").catch(() : any => null);
    }
    logJob("error", "jobs.job.fail_requested", {
      jobId,
      stage,
      errorMessage
    });
    const failedJob: any = await updateJob(jobId, {
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
