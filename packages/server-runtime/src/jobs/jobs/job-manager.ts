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
import { assertBoundUploadSessionStore } from "../../state/upload-session-store.ts";
import { errorMessage, type ActiveJobController, type CodedError, type JobDocument, type UploadConsumptionStorageProvider } from "./contracts.ts";

interface RuntimeOptions {
  workerConcurrency?: number;
  [key: string]: unknown;
}

interface UploadSessionStorePort {
  resolveUploadSessionFiles(sessionId: string, input: { owner: Record<string, string> }): Promise<unknown>;
}

function isUploadSessionStore(value: unknown): value is UploadSessionStorePort {
  return typeof value === "object" && value !== null &&
    typeof (value as { resolveUploadSessionFiles?: unknown }).resolveUploadSessionFiles === "function";
}

interface ManagerLogger {
  info(event: string, details: Record<string, unknown>): void;
  warn(event: string, details: Record<string, unknown>): void;
  error(event: string, details: Record<string, unknown>): void;
  debug(event: string, details: Record<string, unknown>): void;
}
interface ProtocolEventBus {
  publish(type: string, payload: object): Promise<unknown>;
}

function requireUploadConsumptionStorageProvider(storageProvider: UploadConsumptionStorageProvider | null) {
  if (
    !storageProvider ||
    typeof storageProvider.commitUploadConsumptionReceipt !== "function"
  ) {
    const error = new TypeError(
      "Job processing requires the canonical upload-consumption storage provider."
    ) as CodedError;
    error.code = "upload_session_storage_provider_unavailable";
    throw error;
  }
  return storageProvider;
}

export function createJobManager({
  userDataPath,
  runtimeOptions = {},
  getRuntimeOptions = null,
  protocolEventBus = null,
  storageProvider = null,
  uploadSessionStore = null,
  processingEnabled = process.env.MESHRIX_IMPORT_WORKER_EXTERNAL !== "1",
  logger = getRuntimeLogger()
}: {
  userDataPath: string;
  runtimeOptions?: RuntimeOptions;
  getRuntimeOptions?: (() => RuntimeOptions) | null;
  protocolEventBus?: ProtocolEventBus | null;
  storageProvider?: UploadConsumptionStorageProvider | null;
  uploadSessionStore?: UploadSessionStorePort | null;
  processingEnabled?: boolean;
  logger?: ManagerLogger;
}) {
  const uploadSessionStoreCandidate = processingEnabled
    ? assertBoundUploadSessionStore(uploadSessionStore, { userDataPath })
    : uploadSessionStore;
  if (uploadSessionStoreCandidate !== null && !isUploadSessionStore(uploadSessionStoreCandidate)) {
    throw new TypeError("Job processing requires the canonical upload session store.");
  }
  const boundUploadSessionStore = uploadSessionStoreCandidate;
  const boundStorageProvider = processingEnabled
    ? requireUploadConsumptionStorageProvider(storageProvider)
    : storageProvider;
  const jobs = new Map<string, JobDocument>();
  const checkpointJobs = new Map<string, string>();
  const activeManifestJobs = new Map<string, string>();
  const jobProjectionStore = createJobProjectionStore({ userDataPath });
  let durableWorkflows: ReturnType<typeof createDurableWorkflowSubstrate>;
  try {
    durableWorkflows = createDurableWorkflowSubstrate({ userDataPath });
  } catch (error) {
    jobProjectionStore.close();
    throw error;
  }
  const workerConcurrency = normalizeWorkerConcurrency(
    runtimeOptions?.workerConcurrency || process.env.MESHRIX_JOB_WORKER_CONCURRENCY
  );
  const activeControllers = new Map<string, ActiveJobController>();
  const dispatchingJobIds = new Set<string>();
  const backgroundTasks = new Set<Promise<void>>();
  const state = {
    readyComplete: false,
    closed: false
  };

  function logJob(level: keyof ManagerLogger, event: string, details: Record<string, unknown> = {}) {
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

  function trackBackgroundTask(label: string, task: PromiseLike<unknown>) {
    let tracked: Promise<void>;
    tracked = Promise.resolve(task)
      .then(() => undefined)
      .catch((error: unknown) => {
        logJob("warn", "jobs.manager.background_task.failed", {
          label,
          error: errorMessage(error)
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
      await Promise.allSettled(backgroundTasks);
    }
  }

  logJob("info", "jobs.manager.created", {
    userDataPath,
    processingMode: processingEnabled ? "internal" : "external",
    schedulerMode: "platform-work-queue"
  });

  const baseCtx = {
    userDataPath,
    runtimeOptions,
    getRuntimeOptions,
    protocolEventBus,
    storageProvider: boundStorageProvider,
    uploadSessionStore: boundUploadSessionStore,
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
    loadJobPayload: (jobId: string) =>
      loadJobPayload(userDataPath, jobId, jobProjectionStore)
  };

  const indexedCtx = Object.assign(baseCtx, createActiveManifestIndex(baseCtx));
  const artifactCtx = Object.assign(indexedCtx, createJobManagerArtifacts(indexedCtx));
  const queueCtx = Object.assign(artifactCtx, createJobManagerQueue(artifactCtx));
  const lifecycleCtx = Object.assign(queueCtx, {
    startQueuedJob: createStartQueuedJob(queueCtx)
  });
  const ctx = Object.assign(lifecycleCtx, {
    ready: (async () => {
    await reconcileJobProjectionArtifacts({
      userDataPath,
      projectionStore: jobProjectionStore
    });
    jobProjectionStore.maintain();
    await reconcileJobProjectionArtifacts({
      userDataPath,
      projectionStore: jobProjectionStore
    });
    await lifecycleCtx.recoverPersistedQueue();
    await lifecycleCtx.replayUploadCleanupJournal();
    })()
  });

  const api = createJobManagerApi(ctx);
  Object.defineProperties(api, {
    storageProvider: {
      enumerable: false,
      value: boundStorageProvider
    },
    uploadSessionStore: {
      enumerable: false,
      value: boundUploadSessionStore
    }
  });
  return api;
}
