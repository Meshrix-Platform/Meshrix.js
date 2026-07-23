import { createHash } from "node:crypto";

const FALLBACK_TTL_MS = 30_000;
const FALLBACK_HEARTBEAT_MS = 10_000;

export class OperationLockError extends Error {
  constructor(phase) {
    super(`Operation concurrency lock failed during ${phase}.`);
    this.name = "OperationLockError";
    this.phase = phase;
  }
}

export function operationLockKey(operation = {}, concurrencyScope = "default") {
  const group = String(operation.concurrencyGroup || operation.id || "").trim();
  if (!group) throw new TypeError("Operation concurrency group must be a non-empty string.");
  const scopeDigest = createHash("sha256")
    .update(String(concurrencyScope || "default"))
    .digest("hex")
    .slice(0, 24);
  return `operation:${scopeDigest}:${group}`;
}

function positiveDuration(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function lockTiming(lockManager) {
  const ttlMs = positiveDuration(lockManager?.config?.defaultTtlMs, FALLBACK_TTL_MS);
  const configuredHeartbeatMs = positiveDuration(
    lockManager?.config?.heartbeatIntervalMs,
    FALLBACK_HEARTBEAT_MS
  );
  return {
    ttlMs,
    heartbeatMs: Math.max(1, Math.min(configuredHeartbeatMs, Math.floor(ttlMs / 3) || 1))
  };
}

function validHandle(handle) {
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
} = {}) {
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
    const result = await run(null);
    if (signal?.aborted) throw new OperationLockError("aborted");
    return result;
  }
  if (!lockManager || typeof lockManager.acquire !== "function") {
    throw new OperationLockError("unavailable");
  }

  const { ttlMs, heartbeatMs } = lockTiming(lockManager);
  let handle;
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

  const abortController = new AbortController();
  let heartbeatFailure = null;
  let callerAbortFailure = null;
  let heartbeatTask = null;
  let executionSettled = false;

  const abortFromCaller = () => {
    callerAbortFailure ||= new OperationLockError("aborted");
    abortController.abort(callerAbortFailure);
  };
  signal?.addEventListener?.("abort", abortFromCaller, { once: true });
  if (signal?.aborted) abortFromCaller();

  const assertActive = () => {
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
  const operationLock = Object.freeze({
    lockKey: handle.lockKey,
    fencingToken: handle.fencingToken,
    acquiredAt: handle.acquiredAt,
    get expiresAt() {
      return handle.expiresAt;
    },
    signal: abortController.signal,
    assertActive
  });

  const heartbeat = () => {
    if (executionSettled || heartbeatFailure || heartbeatTask) return;
    heartbeatTask = Promise.resolve()
      .then(() => handle.heartbeat(ttlMs))
      .catch(() => {
        heartbeatFailure = new OperationLockError("heartbeat");
        abortController.abort(heartbeatFailure);
      })
      .finally(() => {
        heartbeatTask = null;
      });
  };
  const heartbeatTimer = setInterval(heartbeat, heartbeatMs);
  heartbeatTimer.unref?.();

  let result;
  let executionFailure = null;
  let releaseFailure = null;
  try {
    assertActive();
    result = await run(operationLock);
  } catch (error) {
    executionFailure = error;
  } finally {
    executionSettled = true;
    clearInterval(heartbeatTimer);
    const inFlightHeartbeat = heartbeatTask;
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
