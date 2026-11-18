import { createJobPipeline } from "../job-pipeline.ts";
import { createServerRuntime } from "#meshrix/product-api";
import type { CodedError, JobPayload, JobResult } from "./contracts.ts";
import type { UploadConsumptionStorageProvider } from "./contracts.ts";

interface RunnerRuntimeOptions {
  testHooks?: { jobDelayMs?: number };
  [key: string]: unknown;
}

interface RunnerOptions {
  onProgress?: (message: Record<string, unknown>) => void | Promise<void>;
  jobId?: string;
  batchId?: string;
  runtimeOptions?: RunnerRuntimeOptions;
  signal?: AbortSignal | null;
  storageProvider?: UploadConsumptionStorageProvider;
  uploadSessionStore?: {
    resolveUploadSessionFiles(sessionId: string, input: { owner: Record<string, string> }): Promise<unknown>;
  };
}

function noop() {}

function getTestJobDelayMs(runtimeOptions: RunnerRuntimeOptions = {}) {
  const delayValue = runtimeOptions?.testHooks?.jobDelayMs;
  const delay = Number(delayValue || 0);
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
}

function throwIfAborted(signal?: AbortSignal | null) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Job execution was cancelled.") as CodedError;
  error.code = "job_execution_aborted";
  throw error;
}

function abortableDelay(delayMs = 0, signal?: AbortSignal | null) {
  if (delayMs <= 0) return Promise.resolve();
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export async function runSplitJob(userDataPath: string, payload: JobPayload, options: RunnerOptions = {}): Promise<JobResult> {
  const reportProgress =
    typeof options.onProgress === "function" ? options.onProgress : noop;
  const generatedAt = new Date().toISOString();
  const jobId = String(options.jobId || options.batchId || generatedAt);
  const testJobDelayMs = getTestJobDelayMs(options.runtimeOptions || {});
  const signal = options.signal || null;
  throwIfAborted(signal);
  const storageProvider = options.storageProvider;
  const uploadSessionStore = options.uploadSessionStore;
  if (
    !storageProvider ||
    typeof storageProvider.commitUploadConsumptionReceipt !== "function"
  ) {
    const error = new TypeError(
      "Job execution requires an already-composed storage provider."
    ) as CodedError;
    error.code = "upload_session_storage_provider_unavailable";
    throw error;
  }
  const runtime = await createServerRuntime({
    userDataPath,
    runtimeOptions: options.runtimeOptions || {}
  });

  try {
    throwIfAborted(signal);
    await abortableDelay(testJobDelayMs, signal);
    throwIfAborted(signal);

    const pipeline = createJobPipeline({
      userDataPath,
      payload,
      runtime,
      storageProvider,
      uploadSessionStore,
      reportProgress,
      jobId,
      generatedAt,
      signal
    });
    const context = pipeline.createContext();
    const result = await pipeline.run(context);
    throwIfAborted(signal);
    return result;
  } finally {
    await runtime.close();
  }
}
