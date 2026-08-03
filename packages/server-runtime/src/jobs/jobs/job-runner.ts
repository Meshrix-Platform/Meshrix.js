import { createJobPipeline } from "../job-pipeline.ts";
import { createServerRuntime } from "#meshrix/product-api";

function noop() : any {}

function getTestJobDelayMs(runtimeOptions: Record<string, any> = {}) : any {
  const delayValue: any = runtimeOptions?.testHooks?.jobDelayMs;
  const delay: any = Number(delayValue || 0);
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
}

function throwIfAborted(signal?: any) : any {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error: Error & Record<string, any> = new Error("Job execution was cancelled.");
  error.code = "job_execution_aborted";
  throw error;
}

function abortableDelay(delayMs?: any, signal?: any) : any {
  if (delayMs <= 0) return Promise.resolve();
  throwIfAborted(signal);
  return new Promise((resolve?: any, reject?: any) : any => {
    const timer: any = setTimeout(() : any => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort: any = () : any => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error: any) {
        reject(error);
      }
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export async function runSplitJob(userDataPath?: any, payload?: any, options: Record<string, any> = {}) : Promise<any> {
  const reportProgress: any =
    typeof options.onProgress === "function" ? options.onProgress : noop;
  const generatedAt: any = new Date().toISOString();
  const jobId: any = String(options.jobId || options.batchId || generatedAt);
  const testJobDelayMs: any = getTestJobDelayMs(options.runtimeOptions || {});
  const signal: any = options.signal || null;
  throwIfAborted(signal);
  const storageProvider: any = options.storageProvider;
  const uploadSessionStore: any = options.uploadSessionStore;
  if (
    !storageProvider ||
    typeof storageProvider.commitUploadConsumptionReceipt !== "function"
  ) {
    const error: Error & Record<string, any> = new TypeError(
      "Job execution requires an already-composed storage provider."
    );
    error.code = "upload_session_storage_provider_unavailable";
    throw error;
  }
  const runtime: any = await createServerRuntime({
    userDataPath,
    runtimeOptions: options.runtimeOptions || {}
  });

  try {
    throwIfAborted(signal);
    await abortableDelay(testJobDelayMs, signal);
    throwIfAborted(signal);

    const pipeline: any = createJobPipeline({
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
    const context: any = pipeline.createContext();
    const result: any = await pipeline.run(context);
    throwIfAborted(signal);
    return result;
  } finally {
    await runtime.close();
  }
}
