import { createJobPipeline } from "../job-pipeline.mjs";
import { createServerRuntime } from "#lico/product-api";

function noop() {}

function getTestJobDelayMs(runtimeOptions = {}) {
  const delayValue = runtimeOptions?.testHooks?.jobDelayMs;
  const delay = Number(delayValue || 0);
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Job execution was cancelled.");
  error.code = "job_execution_aborted";
  throw error;
}

function abortableDelay(delayMs, signal) {
  if (delayMs <= 0) return Promise.resolve();
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
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

export async function runSplitJob(userDataPath, payload, options = {}) {
  const reportProgress =
    typeof options.onProgress === "function" ? options.onProgress : noop;
  const generatedAt = new Date().toISOString();
  const jobId = String(options.jobId || options.batchId || generatedAt);
  const testJobDelayMs = getTestJobDelayMs(options.runtimeOptions || {});
  const signal = options.signal || null;
  throwIfAborted(signal);
  const runtime = await createServerRuntime({
    userDataPath,
    runtimeOptions: options.runtimeOptions || {}
  });
  const { storageProvider } = runtime;

  try {
    throwIfAborted(signal);
    await abortableDelay(testJobDelayMs, signal);
    throwIfAborted(signal);

    const pipeline = createJobPipeline({
      userDataPath,
      payload,
      runtime,
      storageProvider,
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
