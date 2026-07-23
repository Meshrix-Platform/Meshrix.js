import { serverToken } from "#lico/product-api";
import { cloneJob } from "./job-manager-projection.mjs";
import {
  loadJobPayload,
  listPersistedJobMetas,
  persistJobMeta,
  loadPersistedJobs
} from "./job-manager-persistence.mjs";
import { normalizeArchiveBatchId, RECOVERY_STAGE_MESSAGE } from "./job-manager-validation.mjs";

export function createJobManagerQueue(ctx) {
  const {
    userDataPath,
    processingEnabled,
    activeControllers,
    dispatchingJobIds,
    jobs,
    checkpointJobs,
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

  function cloneJobForApi(job, options = {}) {
    return cloneJob(job, options);
  }

  async function refreshPersistedJobs() {
    const persistedJobs = await listPersistedJobMetas(userDataPath);
    const knownIds = new Set(persistedJobs.map((job) => job.id).filter(Boolean));

    for (const job of persistedJobs) {
      if (!job.archiveBatchId && job.id) {
        job.archiveBatchId = normalizeArchiveBatchId(job) || serverToken("archive_batch", job.checkpointId || job.id);
        await persistJobMeta(userDataPath, job);
      }
      if (!job.checkpointTreeId && job.id) {
        job.checkpointTreeId = checkpointTreeIdForJob(job);
        await persistJobMeta(userDataPath, job);
      }
      if (!job.workflowId && job.id) {
        job.workflowId = workflowIdForJob(job);
        await persistJobMeta(userDataPath, job);
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
      if (["queued", "running"].includes(job.status)) {
        rememberActiveManifestJob(job);
        await durableWorkflows.recoverWorkflow(job.workflowId, {
          reason: "job_manager_refresh_recovery"
        }).catch(() => null);
      } else {
        forgetActiveManifestJob(job);
      }
    }

    for (const jobId of [...jobs.keys()]) {
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

  async function runQueuedJob(entry) {
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
      return await ctx.startQueuedJob(entry);
    } finally {
      dispatchingJobIds.delete(entry.jobId);
    }
  }

  async function recoverPersistedQueue() {
    logJob("info", "jobs.queue.recovery.started", {
      recoverActive: processingEnabled
    });
    const { jobs: persistedJobs, recoverableEntries } = await loadPersistedJobs(userDataPath, {
      recoverActive: processingEnabled
    });

    for (const job of persistedJobs) {
      if (!job.archiveBatchId && job.id) {
        job.archiveBatchId = normalizeArchiveBatchId(job) || serverToken("archive_batch", job.checkpointId || job.id);
        await persistJobMeta(userDataPath, job);
      }
      if (!job.checkpointTreeId && job.id) {
        job.checkpointTreeId = checkpointTreeIdForJob(job);
        await persistJobMeta(userDataPath, job);
      }
      if (!job.workflowId && job.id) {
        job.workflowId = workflowIdForJob(job);
        await persistJobMeta(userDataPath, job);
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
        await durableWorkflows.recoverWorkflow(job.workflowId, {
          reason: "job_manager_startup_recovery"
        }).catch(() => null);
      }
    }

    state.readyComplete = true;
    logJob("info", "jobs.queue.recovery.completed", {
      persistedJobCount: persistedJobs.length,
      recoverableCount: recoverableEntries.length,
      recoveredQueuedCount: recoverableEntries.length
    });
  }

  return {
    cloneJobForApi,
    refreshPersistedJobs,
    runQueuedJob,
    recoverPersistedQueue
  };
}
