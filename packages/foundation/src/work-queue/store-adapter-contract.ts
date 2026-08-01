export const WORK_QUEUE_STORE_ADAPTER_METHODS: readonly any[] = Object.freeze([
  "enqueue",
  "claim",
  "complete",
  "retry",
  "progress",
  "checkpoint",
  "expire",
  "cancel",
  "cancelRunning",
  "fail",
  "recover",
  "inspect",
  "rebuildProjection"
]);

export const WORK_QUEUE_BACKGROUND_WRITE_METHODS: readonly any[] = Object.freeze([
  "writeFallbackCoordinatorState",
  "writeSnapshotState",
  "writeCompactionState",
  "writeInternalHealthState"
]);

export function validateWorkQueueStoreAdapterShape(adapter?: any) : any {
  const missing: any[] = [];
  if (!adapter || typeof adapter !== "object") {
    return {
      ok: false,
      missing: [...WORK_QUEUE_STORE_ADAPTER_METHODS],
      errors: ["Adapter must be an object."]
    };
  }

  for (const method of WORK_QUEUE_STORE_ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") {
      missing.push(method);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    errors: missing.map((method?: any) : any => `Missing store adapter method: ${method}`)
  };
}

export function validateQueueBackgroundWriteAspectShape(aspect?: any) : any {
  const missing: any[] = [];
  if (!aspect || typeof aspect !== "object") {
    return {
      ok: false,
      missing: [...WORK_QUEUE_BACKGROUND_WRITE_METHODS],
      errors: ["Background write aspect must be an object."]
    };
  }

  for (const method of WORK_QUEUE_BACKGROUND_WRITE_METHODS) {
    if (typeof aspect[method] !== "function") {
      missing.push(method);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    errors: missing.map((method?: any) : any => `Missing background write aspect method: ${method}`)
  };
}
