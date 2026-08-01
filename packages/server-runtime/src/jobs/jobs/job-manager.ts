import {
  createDurableWorkflowSubstrate,
  getRuntimeLogger
} from "#meshrix/product-api";
import { createActiveManifestIndex } from "./job-manager-core.ts";
import { createJobManagerArtifacts } from "./job-manager-artifact-events.ts";
import { createJobManagerQueue } from "./job-manager-queue-integration.ts";
import { createStartQueuedJob } from "./job-manager-lifecycle.ts";
import { createJobManagerApi } from "./job-manager-api.ts";
import { loadJobPayload } from "./job-manager-persistence.ts";
import { createJobProjectionStore } from "./job-projection-store.ts";
import { reconcileJobProjectionArtifacts } from "./job-projection-recovery.ts";
import { normalizeWorkerConcurrency } from "./job-manager-validation.ts";

export function createJobManager({
  userDataPath,
  runtimeOptions = {},
  getRuntimeOptions = null,
  protocolEventBus = null,
  storageProvider = null,
  uploadSessionStore = null,
  processingEnabled = process.env.MESHRIX_IMPORT_WORKER_EXTERNAL !== "1",
  logger = getRuntimeLogger()
}: Record<string, any>) : any {
  const jobs: any = new Map<any, any>();
  const checkpointJobs: any = new Map<any, any>();
  const activeManifestJobs: any = new Map<any, any>();
  const jobProjectionStore: any = createJobProjectionStore({ userDataPath });
  let durableWorkflows: any;
  try {
    durableWorkflows = createDurableWorkflowSubstrate({ userDataPath });
  } catch (error: any) {
    jobProjectionStore.close();
    throw error;
  }
  const workerConcurrency: any = normalizeWorkerConcurrency(
    runtimeOptions?.workerConcurrency || process.env.MESHRIX_JOB_WORKER_CONCURRENCY
  );
  const activeControllers: any = new Map<any, any>();
  const dispatchingJobIds: any = new Set<any>();
  const backgroundTasks: any = new Set<any>();
  const state: Record<string, any> = {
    readyComplete: false,
    closed: false
  };

  function logJob(level?: any, event?: any, details: Record<string, any> = {}) : any {
    if (!logger || typeof logger[level] !== "function") {
      return;
    }
    let queuedCount: any = 0;
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

  function resolveCurrentRuntimeOptions() : any {
    if (typeof getRuntimeOptions === "function") {
      return getRuntimeOptions() || runtimeOptions;
    }

    return runtimeOptions;
  }

  function trackBackgroundTask(label?: any, task?: any) : any {
    let tracked: any;
    tracked = Promise.resolve(task)
      .catch((error?: any) : any => {
        logJob("warn", "jobs.manager.background_task.failed", {
          label,
          error: error?.message || String(error || "")
        });
      })
      .finally(() : any => {
        backgroundTasks.delete(tracked);
      });
    backgroundTasks.add(tracked);
    return tracked;
  }

  async function drainBackgroundTasks() : Promise<any> {
    while (backgroundTasks.size > 0) {
      await Promise.allSettled([...backgroundTasks]);
    }
  }

  logJob("info", "jobs.manager.created", {
    userDataPath,
    processingMode: processingEnabled ? "internal" : "external",
    schedulerMode: "platform-work-queue"
  });

  const ctx: Record<string, any> = {
    userDataPath,
    runtimeOptions,
    getRuntimeOptions,
    protocolEventBus,
    storageProvider,
    uploadSessionStore,
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
    loadJobPayload: (jobId?: any) : any =>
      loadJobPayload(userDataPath, jobId, jobProjectionStore)
  };

  Object.assign(ctx, createActiveManifestIndex(ctx));
  Object.assign(ctx, createJobManagerArtifacts(ctx));
  Object.assign(ctx, createJobManagerQueue(ctx));
  ctx.startQueuedJob = createStartQueuedJob(ctx);
  ctx.ready = (async () : Promise<any> => {
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
    await ctx.replayUploadCleanupJournal();
  })();

  return createJobManagerApi(ctx);
}
