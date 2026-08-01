import { createHash } from "node:crypto";

const FALLBACK_TTL_MS: any = 30_000;
const FALLBACK_HEARTBEAT_MS: any = 10_000;

export class OperationLockError extends Error {
  name: any;
  phase: any;
  constructor(phase?: any) {
    super(`Operation concurrency lock failed during ${phase}.`);
    this.name = "OperationLockError";
    this.phase = phase;
  }
}

export function operationLockKey(operation: Record<string, any> = {}, concurrencyScope: any = "default") : any {
  const group: any = String(operation.concurrencyGroup || operation.id || "").trim();
  if (!group) throw new TypeError("Operation concurrency group must be a non-empty string.");
  const scopeDigest: any = createHash("sha256")
    .update(String(concurrencyScope || "default"))
    .digest("hex")
    .slice(0, 24);
  return `operation:${scopeDigest}:${group}`;
}

function positiveDuration(value?: any, fallback?: any) : any {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function lockTiming(lockManager?: any) : any {
  const ttlMs: any = positiveDuration(lockManager?.config?.defaultTtlMs, FALLBACK_TTL_MS);
  const configuredHeartbeatMs: any = positiveDuration(
    lockManager?.config?.heartbeatIntervalMs,
    FALLBACK_HEARTBEAT_MS
  );
  return {
    ttlMs,
    heartbeatMs: Math.max(1, Math.min(configuredHeartbeatMs, Math.floor(ttlMs / 3) || 1))
  };
}

function validHandle(handle?: any) : any {
  return Boolean(
    handle &&
    handle.released !== true &&
    String(handle.lockKey || "").trim() &&
    String(handle.fencingToken || "").trim() &&
    Number.isFinite(handle.expiresAt?.getTime?.()) &&
    handle.expiresAt.getTime() > Date.now() &&
    typeof handle.heartbeat === "function" &&
    typeof handle.release === "function"
  );
}

/**
 * Serialize an operation while its lease is live.
 *
 * The opaque fencing token is passed to the controller as
 * `operationLock.fencingToken`. Durable side-effect stores need an explicit
 * atomic fencing contract to reject stale writers; this helper only claims
 * mutual exclusion while the lease remains live.
 */
export async function withOperationLock({
  operation,
  lockManager,
  concurrencyScope = "default",
  signal = null,
  run
}: Record<string, any> = {}) : Promise<any> {
  if (typeof run !== "function") throw new TypeError("Operation lock requires a run function.");
  if (
    signal !== null &&
    signal !== undefined &&
    (
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function"
    )
  ) {
    throw new TypeError("Operation lock signal must be an AbortSignal.");
  }
  if (signal?.aborted) throw new OperationLockError("aborted");
  if (operation?.concurrencySafe === true) {
    const result: any = await run(null);
    if (signal?.aborted) throw new OperationLockError("aborted");
    return result;
  }
  if (!lockManager || typeof lockManager.acquire !== "function") {
    throw new OperationLockError("unavailable");
  }

  const { ttlMs, heartbeatMs } = lockTiming(lockManager);
  let handle: any;
  try {
    handle = await lockManager.acquire(operationLockKey(operation, concurrencyScope), {
      ttlMs,
      signal
    });
  } catch {
    throw new OperationLockError(signal?.aborted ? "aborted" : "acquire");
  }
  if (signal?.aborted) {
    try {
      await handle?.release?.();
    } catch {
      // A caller-aborted acquisition must remain failed closed.
    }
    throw new OperationLockError("aborted");
  }
  if (!validHandle(handle)) {
    try {
      await handle?.release?.();
    } catch {
      // A malformed lock handle is already a failed-closed acquisition.
    }
    throw new OperationLockError("invalid-handle");
  }

  const abortController: any = new AbortController();
  let heartbeatFailure: any = null;
  let callerAbortFailure: any = null;
  let heartbeatTask: any = null;
  let executionSettled: any = false;

  const abortFromCaller: any = () : any => {
    callerAbortFailure ||= new OperationLockError("aborted");
    abortController.abort(callerAbortFailure);
  };
  signal?.addEventListener?.("abort", abortFromCaller, { once: true });
  if (signal?.aborted) abortFromCaller();

  const assertActive: any = () : any => {
    if (heartbeatFailure) throw heartbeatFailure;
    if (callerAbortFailure) throw callerAbortFailure;
    if (
      handle.released ||
      abortController.signal.aborted ||
      handle.expiresAt.getTime() <= Date.now()
    ) {
      throw new OperationLockError("lease-lost");
    }
  };
  const operationLock: Readonly<Record<string, any>> = Object.freeze({
    lockKey: handle.lockKey,
    fencingToken: handle.fencingToken,
    acquiredAt: handle.acquiredAt,
    get expiresAt() : any {
      return handle.expiresAt;
    },
    signal: abortController.signal,
    assertActive
  });

  const heartbeat: any = () : any => {
    if (executionSettled || heartbeatFailure || heartbeatTask) return;
    heartbeatTask = Promise.resolve()
      .then(() : any => handle.heartbeat(ttlMs))
      .catch(() : any => {
        heartbeatFailure = new OperationLockError("heartbeat");
        abortController.abort(heartbeatFailure);
      })
      .finally(() : any => {
        heartbeatTask = null;
      });
  };
  const heartbeatTimer: any = setInterval(heartbeat, heartbeatMs);
  heartbeatTimer.unref?.();

  let result: any;
  let executionFailure: any = null;
  let releaseFailure: any = null;
  try {
    assertActive();
    result = await run(operationLock);
  } catch (error: any) {
    executionFailure = error;
  } finally {
    executionSettled = true;
    clearInterval(heartbeatTimer);
    const inFlightHeartbeat: any = heartbeatTask;
    if (inFlightHeartbeat) await inFlightHeartbeat;
    if ((handle.released || handle.expiresAt.getTime() <= Date.now()) && !heartbeatFailure) {
      heartbeatFailure = new OperationLockError("lease-lost");
      abortController.abort(heartbeatFailure);
    }
    try {
      await handle.release();
    } catch {
      releaseFailure = new OperationLockError("release");
    }
    signal?.removeEventListener?.("abort", abortFromCaller);
  }

  if (heartbeatFailure) throw heartbeatFailure;
  if (callerAbortFailure) throw callerAbortFailure;
  if (releaseFailure) throw releaseFailure;
  if (executionFailure) throw executionFailure;
  return result;
}
