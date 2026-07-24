import {
  checkpointTreeId,
  finishCheckpointTree,
  startCheckpointTree,
  upsertCheckpointNode,
  workflowId
} from "#meshrix/product-api";
import { normalizeManifestKey } from "./job-manager-validation.mjs";
import { persistJobMeta, persistJobTerminal } from "./job-manager-persistence.mjs";

export function createJobManagerArtifacts(ctx) {
  const {
    userDataPath,
    protocolEventBus,
    durableWorkflows,
    logJob,
    jobs,
    checkpointJobs,
    jobProjectionStore
  } = ctx;

  function retireTerminalJob(job) {
    if (!job || !["completed", "failed", "cancelled"].includes(job.status)) {
      return;
    }
    jobs.delete(job.id);
    if (job.checkpointId) checkpointJobs.delete(job.checkpointId);
    ctx.forgetActiveManifestJob(job);
  }

  function checkpointTreeIdForJob(job) {
    return job?.checkpointTreeId || (job?.id ? checkpointTreeId("job", job.id) : "");
  }

  function workflowIdForJob(job) {
    return job?.workflowId || (job?.id ? workflowId("import_parse_job", job.id) : "");
  }

  async function ensureJobCheckpointTree(job, payload = null) {
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

  async function updateJobCheckpointNode(job, node) {
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

  async function finishJobCheckpoint(job, input = {}) {
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

  async function publishJobEvent(job, type = "jobs.job.updated") {
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

  async function publishDeletedJobEvent(job) {
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

  async function updateJob(jobId, patch) {
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
    const nextJob = {
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

  async function commitJobTerminal(jobId, patch, result) {
    const currentJob = jobs.get(jobId);
    if (!currentJob) return null;
    const { eventType, ...jobPatch } = patch;
    const nextJob = {
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

  async function failJob(jobId, errorMessage, stage) {
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
    failJob
  };
}
