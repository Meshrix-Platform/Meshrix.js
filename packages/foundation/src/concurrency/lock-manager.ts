/**
 * LockManager factory — memory backend plus backend selection.
 *
 * The shared interface, base class, and typed errors live in the acyclic
 * contract module lock-manager-contract.ts. SQLite and PostgreSQL backends
 * import only the contract and never this factory module.
 *
 * @module foundation/concurrency/lock-manager
 */
import {
  LOCK_MANAGER_PROTOCOL,
  LockAcquireAbortedError,
  LockFencingError,
  LockManager,
  LockManagerDestroyedError,
  LockQueueFullError,
  LockReleasedError,
  LockTimeoutError,
  DeadlineScheduler,
  IntrusiveWaitQueue,
  normalizeLockKey,
  positiveDuration,
  positiveInteger,
  nonNegativeDuration,
  throwIfAcquireAborted
} from "./lock-manager-contract.ts";

export {
  LOCK_MANAGER_PROTOCOL,
  LockAcquireAbortedError,
  LockFencingError,
  LockManager,
  LockManagerDestroyedError,
  LockQueueFullError,
  LockReleasedError,
  LockTimeoutError
} from "./lock-manager-contract.ts";

/**
 * Memory-based LockManager — unit test use ONLY.
 * Not suitable for multi-process/worker deployments.
 */
export class MemoryLockManager extends LockManager {
  _destroyed: any;
  _locks: any;
  _queues: any;
  _waiterScheduler: any;
  constructor(config: Record<string, any> = {}) {
    super({ ...config, backend: "memory" });
    /** @type {Map<string, { handle: LockHandle, timer: NodeJS.Timeout }>} */
    this._locks = new Map<any, any>();
    /** @type {Map<string, IntrusiveWaitQueue>} */
    this._queues = new Map<any, any>();
    this._waiterScheduler = new DeadlineScheduler();
    this._destroyed = false;
  }

  async acquire(key?: any, options: Record<string, any> = {}) : Promise<any> {
    this._assertActive();
    const lockKey: any = normalizeLockKey(key);
    throwIfAcquireAborted(options.signal, lockKey);
    const ttlMs: any = positiveDuration(options.ttlMs, this.config.defaultTtlMs, "ttlMs");
    const waitMs: any = nonNegativeDuration(options.waitMs, this.config.maxWaitMs, "waitMs");
    const existing: any = this._locks.get(lockKey);
    if (existing && existing.handle.expiresAt.getTime() <= Date.now()) {
      this._expireHandle(lockKey, existing.handle);
    }

    if (this._locks.has(lockKey)) {
      // Lock is held — queue if waitMs > 0
      if (waitMs <= 0) {
        this._metrics.totalTimedOut++;
        throw new LockTimeoutError(lockKey, 0);
      }

      const queue: any = this._queueFor(lockKey);
      if (this._metrics.currentWaiting >= this.config.maxQueueDepth) {
        throw new LockQueueFullError(lockKey, this.config.maxQueueDepth);
      }

      this._metrics.currentWaiting++;
      return new Promise((resolve?: any, reject?: any) : any => {
        const waiter: Record<string, any> = {
          resolve,
          reject,
          deadlineEntry: null,
          active: true,
          ttlMs,
          signal: options.signal,
          onAbort: null
        };
        waiter.onAbort = () : any => {
          if (!waiter.active) return;
          waiter.active = false;
          queue.remove(waiter);
          this._metrics.currentWaiting = Math.max(0, this._metrics.currentWaiting - 1);
          if (queue.size === 0) this._queues.delete(lockKey);
          this._waiterScheduler.cancel(waiter.deadlineEntry);
          reject(new LockAcquireAbortedError(lockKey));
        };
        waiter.deadlineEntry = this._waiterScheduler.schedule(Date.now() + waitMs, () : any => {
          if (!waiter.active) return;
          waiter.active = false;
          queue.remove(waiter);
          this._metrics.currentWaiting = Math.max(0, this._metrics.currentWaiting - 1);
          this._metrics.totalTimedOut++;
          if (queue.size === 0) this._queues.delete(lockKey);
          waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
          reject(new LockTimeoutError(lockKey, waitMs));
        });
        queue.push(waiter);
        waiter.signal?.addEventListener?.("abort", waiter.onAbort, { once: true });
        if (waiter.signal?.aborted) waiter.onAbort();
      });
    }

    return this._createLockHandle(lockKey, ttlMs);
  }

  async release(handle?: any) : Promise<any> {
    if (!handle || handle.released) return;

    const entry: any = this._locks.get(handle.lockKey);
    if (!entry) return;

    if (entry.handle.fencingToken !== handle.fencingToken) {
      throw new LockFencingError(handle.lockKey, handle.fencingToken);
    }
    if (handle.expiresAt.getTime() <= Date.now()) {
      this._expireHandle(handle.lockKey, handle);
      return;
    }

    clearTimeout(entry.timer);
    this._locks.delete(handle.lockKey);
    handle.released = true;
    this._metrics.totalReleased++;
    this._metrics.currentActive--;
    this._promoteNext(handle.lockKey);
  }

  async isLocked(key?: any) : Promise<any> {
    this._assertActive();
    const lockKey: any = normalizeLockKey(key);
    const existing: any = this._locks.get(lockKey);
    if (existing && existing.handle.expiresAt.getTime() <= Date.now()) {
      this._expireHandle(lockKey, existing.handle);
    }
    return this._locks.has(lockKey);
  }

  getMetrics() : any {
    return {
      ...super.getMetrics(),
      queueKeys: this._queues.size,
      waiterTimers: this._waiterScheduler.activeTimerCount
    };
  }

  destroy() : any {
    if (this._destroyed) return;
    this._destroyed = true;

    for (const { handle, timer } of this._locks.values()) {
      clearTimeout(timer);
      if (!handle.released) {
        handle.released = true;
        this._metrics.totalReleased++;
      }
    }
    this._locks.clear();
    this._metrics.currentActive = 0;

    for (const [key, queue] of this._queues) {
      while (queue.size > 0) {
        const waiter: any = queue.shift();
        waiter.active = false;
        this._waiterScheduler.cancel(waiter.deadlineEntry);
        waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
        waiter.reject(new LockManagerDestroyedError(this.config.backend));
      }
      this._queues.delete(key);
    }
    this._metrics.currentWaiting = 0;
    this._waiterScheduler.close();
  }

  _createLockHandle(key?: any, ttlMs: any = this.config.defaultTtlMs) : any {
    const fencingToken: any = LockManager.fencingToken();
    const now: any = new Date();

    const handle: Record<string, any> = {
      lockKey: key,
      fencingToken,
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      released: false,
      release: async () : Promise<any> => this.release(handle),
      heartbeat: async (extendMs: any = this.config.defaultTtlMs) : Promise<any> => {
        if (handle.released) throw new LockReleasedError(key);
        const heartbeatTtlMs: any = positiveDuration(extendMs, this.config.defaultTtlMs, "extendMs");
        // Reset the auto-expiry timer
        const entry: any = this._locks.get(key);
        if (!entry || entry.handle.fencingToken !== handle.fencingToken) {
          handle.released = true;
          throw new LockReleasedError(key);
        }
        if (handle.expiresAt.getTime() <= Date.now()) {
          this._expireHandle(key, handle);
          throw new LockReleasedError(key);
        }
        handle.expiresAt = new Date(Date.now() + heartbeatTtlMs);
        clearTimeout(entry.timer);
        entry.timer = this._expiryTimer(key, handle, heartbeatTtlMs);
      },
    };

    const timer: any = this._expiryTimer(key, handle, ttlMs);

    this._locks.set(key, { handle, timer });
    this._metrics.totalAcquired++;
    this._metrics.currentActive++;

    return handle;
  }

  _queueFor(key?: any) : any {
    let queue: any = this._queues.get(key);
    if (!queue) {
      queue = new IntrusiveWaitQueue();
      this._queues.set(key, queue);
    }
    return queue;
  }

  _promoteNext(key?: any) : any {
    const queue: any = this._queues.get(key);
    if (!queue) return;
    while (queue.size > 0) {
      const next: any = queue.shift();
      if (!next?.active) continue;
      next.active = false;
      this._waiterScheduler.cancel(next.deadlineEntry);
      next.signal?.removeEventListener?.("abort", next.onAbort);
      this._metrics.currentWaiting = Math.max(0, this._metrics.currentWaiting - 1);
      if (queue.size === 0) this._queues.delete(key);
      next.resolve(this._createLockHandle(key, next.ttlMs));
      return;
    }
    this._queues.delete(key);
  }

  _expiryTimer(key?: any, handle?: any, ttlMs?: any) : any {
    const timer: any = setTimeout(() : any => {
      this._expireHandle(key, handle);
    }, ttlMs);
    if (timer.unref) timer.unref();
    return timer;
  }

  _expireHandle(key?: any, handle?: any) : any {
    const entry: any = this._locks.get(key);
    if (!entry || entry.handle.fencingToken !== handle.fencingToken) return false;
    clearTimeout(entry.timer);
    this._locks.delete(key);
    handle.released = true;
    this._metrics.currentActive--;
    this._metrics.totalExpired++;
    this._promoteNext(key);
    return true;
  }

  _assertActive() : any {
    if (this._destroyed) throw new LockManagerDestroyedError(this.config.backend);
  }
}

export function createLockManager(config: Record<string, any> = {}) : any {
  switch (requiredBackend(config)) {
    case "memory":
      return new MemoryLockManager(config);
    case "sqlite":
      throw new Error("SQLite lock manager requires async ESM loading. Use createLockManagerAsync(config).");
    case "postgres":
      throw new Error("Postgres lock manager requires async ESM loading. Use createLockManagerAsync(config).");
    default:
      throw new Error(`Unsupported lock manager backend: ${String(config.backend)}.`);
  }
}

/**
 * Create a LockManager from configuration, including ESM-loaded durable backends.
 * @param {LockManagerConfig} config
 * @returns {Promise<LockManager>}
 */
export async function createLockManagerAsync(config: Record<string, any> = {}) : Promise<any> {
  switch (requiredBackend(config)) {
    case "memory":
      return new MemoryLockManager(config);
    case "sqlite": {
      const { SqliteLockManager } = await import("./sqlite-lock-manager.ts");
      return new SqliteLockManager(config);
    }
    case "postgres": {
      const { PostgresLockManager } = await import("./postgres-lock-manager.ts");
      return new PostgresLockManager(config);
    }
    default:
      throw new Error(`Unsupported lock manager backend: ${String(config.backend)}.`);
  }
}

function requiredBackend(config?: any) : any {
  const backend: any = String(config?.backend ?? "").trim();
  if (!backend) throw new TypeError("Lock manager backend must be selected explicitly.");
  return backend;
}
