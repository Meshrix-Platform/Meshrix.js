import {
  createDurableWorkflowSubstrate,
  getRuntimeLogger
} from "#meshrix/product-api";
import { createActiveManifestIndex } from "./job-manager-core.mjs";
import { createJobManagerArtifacts } from "./job-manager-artifact-events.mjs";
import { createJobManagerQueue } from "./job-manager-queue-integration.mjs";
import { createStartQueuedJob } from "./job-manager-lifecycle.mjs";
import { createJobManagerApi } from "./job-manager-api.mjs";
import { loadJobPayload } from "./job-manager-persistence.mjs";
import { createJobProjectionStore } from "./job-projection-store.mjs";
import { reconcileJobProjectionArtifacts } from "./job-projection-recovery.mjs";
import { normalizeWorkerConcurrency } from "./job-manager-validation.mjs";

export function createJobManager({
  userDataPath,
  runtimeOptions = {},
  getRuntimeOptions = null,
  protocolEventBus = null,
  processingEnabled = process.env.MESHRIX_IMPORT_WORKER_EXTERNAL !== "1",
  logger = getRuntimeLogger()
}) {
  const jobs = new Map();
  const checkpointJobs = new Map();
  const activeManifestJobs = new Map();
  const jobProjectionStore = createJobProjectionStore({ userDataPath });
  let durableWorkflows;
  try {
    durableWorkflows = createDurableWorkflowSubstrate({ userDataPath });
  } catch (error) {
    jobProjectionStore.close();
    throw error;
  }
  const workerConcurrency = normalizeWorkerConcurrency(
    runtimeOptions?.workerConcurrency || process.env.MESHRIX_JOB_WORKER_CONCURRENCY
  );
  const activeControllers = new Map();
  const dispatchingJobIds = new Set();
  const backgroundTasks = new Set();
  const state = {
    readyComplete: false,
    closed: false
  };

  function logJob(level, event, details = {}) {
    if (!logger || typeof logger[level] !== "function") {
      return;
    }
    let queuedCount = 0;
    try {
      queuedCount = Number(
        jobProjectionStore.getCounts().counts.queued || 0
      );
    } catch {
      queuedCount = 0;
    }
    logger[level](event, {
      processingEnabled,
      workerConcurrency,
      activeCount: activeControllers.size,
      queuedCount,
      ...details
    });
  }

  function resolveCurrentRuntimeOptions() {
    if (typeof getRuntimeOptions === "function") {
      return getRuntimeOptions() || runtimeOptions;
    }

    return runtimeOptions;
  }

  function trackBackgroundTask(label, task) {
    let tracked;
    tracked = Promise.resolve(task)
      .catch((error) => {
        logJob("warn", "jobs.manager.background_task.failed", {
          label,
          error: error?.message || String(error || "")
        });
      })
      .finally(() => {
        backgroundTasks.delete(tracked);
      });
    backgroundTasks.add(tracked);
    return tracked;
  }

  async function drainBackgroundTasks() {
    while (backgroundTasks.size > 0) {
      await Promise.allSettled([...backgroundTasks]);
    }
  }

  logJob("info", "jobs.manager.created", {
    userDataPath,
    processingMode: processingEnabled ? "internal" : "external",
    schedulerMode: "platform-work-queue"
  });

  const ctx = {
    userDataPath,
    runtimeOptions,
    getRuntimeOptions,
    protocolEventBus,
    processingEnabled,
    logger,
    jobs,
    checkpointJobs,
    activeManifestJobs,
    jobProjectionStore,
    durableWorkflows,
    workerConcurrency,
    activeControllers,
    dispatchingJobIds,
    backgroundTasks,
    state,
    logJob,
    trackBackgroundTask,
    drainBackgroundTasks,
    resolveCurrentRuntimeOptions,
    loadJobPayload: (jobId) =>
      loadJobPayload(userDataPath, jobId, jobProjectionStore)
  };

  Object.assign(ctx, createActiveManifestIndex(ctx));
  Object.assign(ctx, createJobManagerArtifacts(ctx));
  Object.assign(ctx, createJobManagerQueue(ctx));
  ctx.startQueuedJob = createStartQueuedJob(ctx);
  ctx.ready = (async () => {
    await reconcileJobProjectionArtifacts({
      userDataPath,
      projectionStore: jobProjectionStore
    });
    jobProjectionStore.maintain();
    await reconcileJobProjectionArtifacts({
      userDataPath,
      projectionStore: jobProjectionStore
    });
    await ctx.recoverPersistedQueue();
  })();

  return createJobManagerApi(ctx);
}
