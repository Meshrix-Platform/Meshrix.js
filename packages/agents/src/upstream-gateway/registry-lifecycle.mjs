export function constructWithOwnedResourceCleanup(resource, construct) {
  try {
    return construct();
  } catch (error) {
    try {
      resource?.close?.();
    } catch {
      // Construction cleanup must not replace the original initialization failure.
    }
    throw error;
  }
}

export function createForwardAbortContext(parentSignal = null, timeoutMs = 0) {
  if (
    parentSignal !== null &&
    parentSignal !== undefined &&
    (
      typeof parentSignal.aborted !== "boolean" ||
      typeof parentSignal.addEventListener !== "function" ||
      typeof parentSignal.removeEventListener !== "function"
    )
  ) {
    throw new TypeError("Upstream gateway caller signal must be an AbortSignal.");
  }
  const controller = new AbortController();
  let callerAborted = false;
  let timedOut = false;
  const abortFromCaller = () => {
    if (controller.signal.aborted) return;
    callerAborted = true;
    controller.abort();
  };
  if (parentSignal?.aborted) {
    abortFromCaller();
  } else {
    parentSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, Math.max(1, Number(timeoutMs || 1)));
  timeout.unref?.();
  return {
    signal: controller.signal,
    callerAborted: () => callerAborted,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
}
