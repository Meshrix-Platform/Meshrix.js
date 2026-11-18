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

export function createForwardAbortContext(parentSignal: any = null, timeoutMs: any = null, ownerSignal: any = null) : any {
  const signals: any[] = [...new Set<any>([parentSignal, ownerSignal].filter((signal?: any) => signal !== null && signal !== undefined))];
  for (const signal of signals) {
    if (
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function"
    ) {
      throw new TypeError("Upstream gateway signal must be an AbortSignal.");
    }
  }
  if (timeoutMs !== null && timeoutMs !== undefined &&
      (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)) {
    throw new TypeError("Upstream gateway timeout must be a positive whole number within the supported timer range.");
  }
  const controller: any = new AbortController();
  let callerAborted: any = false;
  let ownerAborted: any = false;
  let timedOut: any = false;
  const abortFromCaller: any = () : any => {
    if (controller.signal.aborted) return;
    callerAborted = true;
    controller.abort();
  };
  const abortFromOwner: any = () : any => {
    if (controller.signal.aborted) return;
    ownerAborted = true;
    controller.abort();
  };
  if (parentSignal?.aborted) abortFromCaller();
  else parentSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (ownerSignal && ownerSignal !== parentSignal) {
    if (ownerSignal.aborted) abortFromOwner();
    else ownerSignal.addEventListener("abort", abortFromOwner, { once: true });
  }
  let timeout: any = null;
  if (timeoutMs !== null && timeoutMs !== undefined) {
    timeout = setTimeout(() : any => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timeout.unref?.();
  }
  return {
    signal: controller.signal,
    callerAborted: () : any => callerAborted,
    ownerAborted: () : any => ownerAborted,
    timedOut: () : any => timedOut,
    dispose() : any {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromCaller);
      if (ownerSignal && ownerSignal !== parentSignal) ownerSignal.removeEventListener("abort", abortFromOwner);
    }
  };
}
