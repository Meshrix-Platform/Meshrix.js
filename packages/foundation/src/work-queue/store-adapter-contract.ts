export const WORK_QUEUE_STORE_ADAPTER_METHODS = Object.freeze([
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
  "markInDoubt",
  "acknowledgeTermination",
  "recordSinkReceipt",
  "reconcileInDoubt",
  "inspect",
  "rebuildProjection"
] as const);

export const WORK_QUEUE_BACKGROUND_WRITE_METHODS = Object.freeze([
  "writeFallbackCoordinatorState",
  "writeSnapshotState",
  "writeCompactionState",
  "writeInternalHealthState"
] as const);

type StoreAdapterMethod = typeof WORK_QUEUE_STORE_ADAPTER_METHODS[number];
type BackgroundWriteMethod = typeof WORK_QUEUE_BACKGROUND_WRITE_METHODS[number];
interface ShapeValidation<Method extends string> {
  ok: boolean;
  missing: Method[];
  errors: string[];
}

function callableProperty(value: object, property: string): boolean {
  return typeof (value as Record<string, unknown>)[property] === "function";
}

export function validateWorkQueueStoreAdapterShape(adapter?: unknown): ShapeValidation<StoreAdapterMethod> {
  const missing: StoreAdapterMethod[] = [];
  if (!adapter || typeof adapter !== "object") {
    return {
      ok: false,
      missing: [...WORK_QUEUE_STORE_ADAPTER_METHODS],
      errors: ["Adapter must be an object."]
    };
  }

  for (const method of WORK_QUEUE_STORE_ADAPTER_METHODS) {
    if (!callableProperty(adapter, method)) {
      missing.push(method);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    errors: missing.map((method) => `Missing store adapter method: ${method}`)
  };
}

export function validateQueueBackgroundWriteAspectShape(aspect?: unknown): ShapeValidation<BackgroundWriteMethod> {
  const missing: BackgroundWriteMethod[] = [];
  if (!aspect || typeof aspect !== "object") {
    return {
      ok: false,
      missing: [...WORK_QUEUE_BACKGROUND_WRITE_METHODS],
      errors: ["Background write aspect must be an object."]
    };
  }

  for (const method of WORK_QUEUE_BACKGROUND_WRITE_METHODS) {
    if (!callableProperty(aspect, method)) {
      missing.push(method);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    errors: missing.map((method) => `Missing background write aspect method: ${method}`)
  };
}
