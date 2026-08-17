import { serverToken } from "#meshrix/product-api";
import { cloneJob } from "./job-manager-projection.ts";
import { persistJobMeta } from "./job-manager-persistence.ts";
import { normalizeArchiveBatchId, RECOVERY_STAGE_MESSAGE } from "./job-manager-validation.ts";
import { errorProperty, type ActiveJobController, type JobDocument } from "./contracts.ts";
import type { createJobProjectionStore } from "./job-projection-store.ts";

interface QueueEntry { jobId: string; [key: string]: unknown }
interface QueueContext {
  userDataPath: string;
  processingEnabled: boolean;
  activeControllers: Map<string, ActiveJobController>;
  dispatchingJobIds: Set<string>;
  jobs: Map<string, JobDocument>;
  checkpointJobs: Map<string, string>;
  jobProjectionStore: ReturnType<typeof createJobProjectionStore>;
  durableWorkflows: {
    recoverWorkflow(workflowId: string, input: { reason: string }): Promise<unknown>;
  };
  logJob(level: string, event: string, details?: Record<string, unknown>): void;
  state: { closed: boolean; readyComplete: boolean };
  checkpointTreeIdForJob(job: JobDocument): string;
  workflowIdForJob(job: JobDocument): string;
  ensureJobCheckpointTree(job: JobDocument): Promise<unknown>;
  updateJobCheckpointNode(job: JobDocument, node: Record<string, unknown>): Promise<unknown>;
  rememberActiveManifestJob(job: JobDocument): void;
  forgetActiveManifestJob(job?: JobDocument | null): void;
  startQueuedJob?: (entry: QueueEntry) => Promise<boolean>;
  loadJobPayload(jobId: string): Promise<object | null>;
}

export function createJobManagerQueue(ctx: QueueContext) {
  const {
    userDataPath,
    processingEnabled,
    activeControllers,
    dispatchingJobIds,
    jobs,
    checkpointJobs,
    jobProjectionStore,
    durableWorkflows,
    logJob,
    state,
    checkpointTreeIdForJob,
    workflowIdForJob,
    ensureJobCheckpointTree,
    updateJobCheckpointNode,
    rememberActiveManifestJob,
    forgetActiveManifestJob,
  } = ctx;

  function cloneJobForApi(job?: JobDocument | null, options: { includeCheckpointFiles?: boolean } = {}) {
    return cloneJob(job, options);
  }

  async function forEachActiveProjection(visit: (job: JobDocument) => Promise<void>) {
    let cursor = "";
    do {
      const page = jobProjectionStore.listActive({ cursor, limit: 200 });
      for (const job of page.items) {
        if (job) await visit(job);
      }
      cursor = page.nextCursor;
      if (page.done) break;
    } while (cursor);
  }

  async function normalizeRecoveredJob(job: JobDocument) {
    let changed = false;
    if (!job.archiveBatchId && job.id) {
      job.archiveBatchId =
        normalizeArchiveBatchId(job) ||
        serverToken("archive_batch", job.checkpointId || job.id);
      changed = true;
    }
    if (!job.checkpointTreeId && job.id) {
      job.checkpointTreeId = checkpointTreeIdForJob(job);
      changed = true;
    }
    if (!job.workflowId && job.id) {
      job.workflowId = workflowIdForJob(job);
      changed = true;
    }
    if (changed) {
      await persistJobMeta(userDataPath, job, jobProjectionStore);
    }
    return job;
  }

  async function refreshPersistedJobs() {
    const knownIds = new Set<string>();
    await forEachActiveProjection(async (projectedJob) => {
      const job = await normalizeRecoveredJob(projectedJob);
      knownIds.add(job.id);
      if (job.checkpointTreeId && ["queued", "running"].includes(job.status)) {
        await ensureJobCheckpointTree(job).catch(() => null);
        await updateJobCheckpointNode(job, {
          nodeId: "recovered-queue",
          parentId: "import-parse-job",
          label: RECOVERY_STAGE_MESSAGE,
          status: "running",
          cursor: {
            status: job.status,
            progressPercent: Number(job.progressPercent || 0),
            stage: job.stage || ""
          }
        });
      }
      jobs.set(job.id, job);
      if (job.checkpointId) {
        checkpointJobs.set(job.checkpointId, job.id);
      }
      if (["queued", "running"].includes(job.status)) {
        rememberActiveManifestJob(job);
        await durableWorkflows.recoverWorkflow(job.workflowId || workflowIdForJob(job), {
          reason: "job_manager_refresh_recovery"
        }).catch(() => null);
      } else {
        forgetActiveManifestJob(job);
      }
    });

    for (const jobId of Array.from(jobs.keys())) {
      if (!knownIds.has(jobId)) {
        const current = jobs.get(jobId);
        jobs.delete(jobId);
        if (current?.checkpointId) {
          checkpointJobs.delete(current.checkpointId);
        }
        forgetActiveManifestJob(current);
      }
    }
  }

  async function runQueuedJob(entry: QueueEntry) {
    if (!processingEnabled || state.closed || !entry?.jobId) {
      logJob("warn", "jobs.queue.dispatch.skipped", {
        jobId: entry?.jobId || "",
        reason: !processingEnabled ? "processing_disabled" : state.closed ? "closed" : "missing_job_id"
      });
      return false;
    }
    const queuedJob = jobs.get(entry.jobId);
    if (!queuedJob || queuedJob.status !== "queued") {
      logJob("warn", "jobs.queue.dispatch.skipped", {
        jobId: entry.jobId,
        reason: !queuedJob ? "job_missing" : `status_${queuedJob.status}`
      });
      return false;
    }
    if (dispatchingJobIds.has(entry.jobId) || activeControllers.has(entry.jobId)) {
      logJob("info", "jobs.queue.dispatch.deduped", { jobId: entry.jobId });
      return false;
    }
    dispatchingJobIds.add(entry.jobId);
    logJob("info", "jobs.queue.dispatch.started", {
      jobId: entry.jobId,
      checkpointId: queuedJob.checkpointId || "",
      uploadSessionId: queuedJob.uploadSessionId || ""
    });
    try {
      if (!ctx.startQueuedJob) {
        throw new Error("Job queue executor is unavailable.");
      }
      return await ctx.startQueuedJob(entry);
    } finally {
      dispatchingJobIds.delete(entry.jobId);
    }
  }

  async function recoverPersistedQueue() {
    logJob("info", "jobs.queue.recovery.started", {
      recoverActive: processingEnabled
    });
    let persistedJobCount = 0;
    let recoverableCount = 0;
    await forEachActiveProjection(async (projectedJob) => {
      const job = await normalizeRecoveredJob(projectedJob);
      persistedJobCount += 1;
      if (processingEnabled && ["queued", "running"].includes(job.status)) {
        let payload = null;
        let payloadInvalid = false;
        try {
          payload = await ctx.loadJobPayload(job.id);
        } catch (error) {
          if (errorProperty(error, "name") !== "JobPersistenceError") throw error;
          payloadInvalid = true;
        }
        const recoveredAt = new Date().toISOString();
        if (payload) {
          job.status = "queued";
          job.stage = RECOVERY_STAGE_MESSAGE;
          job.error = "";
          job.finishedAt = undefined;
          job.updatedAt = recoveredAt;
          await persistJobMeta(userDataPath, job, jobProjectionStore);
          recoverableCount += 1;
        } else {
          job.status = "failed";
          job.stage = "任务恢复失败";
          job.error = payloadInvalid
            ? "服务重启后任务 payload 已损坏，不能继续恢复。"
            : "服务重启后缺少任务 payload，不能继续恢复。";
          job.finishedAt = recoveredAt;
          job.updatedAt = recoveredAt;
          await persistJobMeta(userDataPath, job, jobProjectionStore);
          return;
        }
      }
      if (job.checkpointTreeId && ["queued", "running"].includes(job.status)) {
        await ensureJobCheckpointTree(job).catch(() => null);
        await updateJobCheckpointNode(job, {
          nodeId: "recovered-queue",
          parentId: "import-parse-job",
          label: RECOVERY_STAGE_MESSAGE,
          status: "running",
          cursor: {
            status: job.status,
            progressPercent: Number(job.progressPercent || 0),
            stage: job.stage || ""
          }
        });
      }
      jobs.set(job.id, job);
      if (job.checkpointId) {
        checkpointJobs.set(job.checkpointId, job.id);
      }
      rememberActiveManifestJob(job);
      if (["queued", "running"].includes(job.status)) {
        await durableWorkflows.recoverWorkflow(job.workflowId || workflowIdForJob(job), {
          reason: "job_manager_startup_recovery"
        }).catch(() => null);
      }
    });

    state.readyComplete = true;
    logJob("info", "jobs.queue.recovery.completed", {
      persistedJobCount,
      recoverableCount,
      recoveredQueuedCount: recoverableCount
    });
  }

  return {
    cloneJobForApi,
    refreshPersistedJobs,
    runQueuedJob,
    recoverPersistedQueue
  };
}
