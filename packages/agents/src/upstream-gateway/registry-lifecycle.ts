export function constructWithOwnedResourceCleanup(resource?: any, construct?: any) : any {
  try {
    return construct();
  } catch (error: any) {
    try {
      resource?.close?.();
    } catch {
      // Construction cleanup must not replace the original initialization failure.
    }
    throw error;
  }
}

export function createForwardAbortContext(parentSignal: any = null, timeoutMs: any = 0) : any {
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
  const controller: any = new AbortController();
  let callerAborted: any = false;
  let timedOut: any = false;
  const abortFromCaller: any = () : any => {
    if (controller.signal.aborted) return;
    callerAborted = true;
    controller.abort();
  };
  if (parentSignal?.aborted) {
    abortFromCaller();
  } else {
    parentSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout: any = setTimeout(() : any => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, Math.max(1, Number(timeoutMs || 1)));
  timeout.unref?.();
  return {
    signal: controller.signal,
    callerAborted: () : any => callerAborted,
    timedOut: () : any => timedOut,
    dispose() : any {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
}
