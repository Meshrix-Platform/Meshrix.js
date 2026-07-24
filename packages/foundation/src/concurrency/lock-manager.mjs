/**
 * LockManager — Interface and factory for durable locking.
 *
 * Supports:
 *  - Memory-lock (unit test only)
 *  - SQLite advisory lock (local mode)
 *  - PostgreSQL advisory lock (optional distributed backend)
 *
 * Each lock acquisition returns an opaque fencing token. Durable writers need
 * an explicit atomic fencing contract before that token rejects stale writes.
 * TTL, heartbeat, timeout, queue, and backend-health metrics are built in.
 *
 * Replaces the dispatcher's process-in Map+Promise-chain locks.
 *
 * @module foundation/concurrency/lock-manager
 */

let memoryFenceSequence = BigInt(Date.now()) * 1_000_000n;

export const LOCK_MANAGER_PROTOCOL = "v0.0.1:concurrency:lock-manager-1.0.0";

/**
 * @typedef {object} LockHandle
 * @property {string} lockKey
 * @property {string} fencingToken
 * @property {Date} acquiredAt
 * @property {Date} expiresAt
 * @property {Function} release - Release the lock
 * @property {Function} heartbeat - Extend the lock TTL
 * @property {boolean} released
 */

/**
 * @typedef {object} LockManagerConfig
 * @property {string} backend - 'memory' | 'sqlite' | 'postgres'
 * @property {number} [defaultTtlMs=30000] - Default TTL in ms
 * @property {number} [maxWaitMs=60000] - Maximum wait time in ms
 * @property {number} [heartbeatIntervalMs=10000] - Heartbeat interval
 * @property {number} [maxQueueDepth=1000] - Maximum queue depth
 */

/**
 * Abstract LockManager interface.
 * Concrete implementations: MemoryLockManager, SqliteLockManager, PostgresLockManager.
 */
export class LockManager {
  /**
   * @param {LockManagerConfig} config
   */
  constructor(config = {}) {
    this.config = {
      backend: config.backend || "memory",
      defaultTtlMs: positiveDuration(config.defaultTtlMs, 30000, "defaultTtlMs"),
      maxWaitMs: nonNegativeDuration(config.maxWaitMs, 60000, "maxWaitMs"),
      heartbeatIntervalMs: positiveDuration(config.heartbeatIntervalMs, 10000, "heartbeatIntervalMs"),
      maxQueueDepth: positiveInteger(config.maxQueueDepth, 1000, "maxQueueDepth"),
    };
    this._metrics = {
      totalAcquired: 0,
      totalReleased: 0,
      totalTimedOut: 0,
      totalExpired: 0,
      totalBackendErrors: 0,
      currentActive: 0,
      currentWaiting: 0,
    };
  }

  /**
   * Acquire a lock.
   * @param {string} key - Lock key
   * @param {object} [options]
   * @param {number} [options.ttlMs] - TTL override
   * @param {number} [options.waitMs] - Wait override
   * @param {AbortSignal} [options.signal] - Cancels an acquisition that has not completed
   * @returns {Promise<LockHandle>}
   */
  async acquire(key, options = {}) {
    throw new Error("LockManager.acquire() must be implemented by subclass");
  }

  /**
   * Release a lock by its handle.
   * @param {LockHandle} handle
   * @returns {Promise<void>}
   */
  async release(handle) {
    throw new Error("LockManager.release() must be implemented by subclass");
  }

  /**
   * Check if a lock is held.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async isLocked(key) {
    throw new Error("LockManager.isLocked() must be implemented by subclass");
  }

  /**
   * Get current metrics.
   * @returns {object}
   */
  getMetrics() {
    return { ...this._metrics };
  }

  /**
   * Generate a fencing token.
   * @returns {string}
   */
  static fencingToken() {
    memoryFenceSequence += 1n;
    return `fence_memory_${memoryFenceSequence}`;
  }
}

/**
 * Memory-based LockManager — unit test use ONLY.
 * Not suitable for multi-process/worker deployments.
 */
export class MemoryLockManager extends LockManager {
  constructor(config = {}) {
    super({ ...config, backend: "memory" });
    /** @type {Map<string, { handle: LockHandle, timer: NodeJS.Timeout }>} */
    this._locks = new Map();
    /** @type {Map<string, { items: Array<object>, head: number, activeCount: number }>} */
    this._queues = new Map();
    this._destroyed = false;
  }

  async acquire(key, options = {}) {
    this._assertActive();
    const lockKey = normalizeLockKey(key);
    throwIfAcquireAborted(options.signal, lockKey);
    const ttlMs = positiveDuration(options.ttlMs, this.config.defaultTtlMs, "ttlMs");
    const waitMs = nonNegativeDuration(options.waitMs, this.config.maxWaitMs, "waitMs");
    const existing = this._locks.get(lockKey);
    if (existing && existing.handle.expiresAt.getTime() <= Date.now()) {
      this._expireHandle(lockKey, existing.handle);
    }

    if (this._locks.has(lockKey)) {
      // Lock is held — queue if waitMs > 0
      if (waitMs <= 0) {
        this._metrics.totalTimedOut++;
        throw new LockTimeoutError(lockKey, 0);
      }

      const queue = this._queueFor(lockKey);
      if (this._metrics.currentWaiting >= this.config.maxQueueDepth) {
        throw new LockQueueFullError(lockKey, this.config.maxQueueDepth);
      }

      this._metrics.currentWaiting++;
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          timer: null,
          active: true,
          ttlMs,
          signal: options.signal,
          onAbort: null
        };
        waiter.onAbort = () => {
          if (!waiter.active) return;
          waiter.active = false;
          queue.activeCount--;
          this._metrics.currentWaiting = Math.max(0, this._metrics.currentWaiting - 1);
          if (queue.activeCount === 0) this._queues.delete(lockKey);
          clearTimeout(waiter.timer);
          reject(new LockAcquireAbortedError(lockKey));
        };
        const timer = setTimeout(() => {
          if (!waiter.active) return;
          waiter.active = false;
          queue.activeCount--;
          this._metrics.currentWaiting = Math.max(0, this._metrics.currentWaiting - 1);
          this._metrics.totalTimedOut++;
          if (queue.activeCount === 0) this._queues.delete(lockKey);
          waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
          reject(new LockTimeoutError(lockKey, waitMs));
        }, waitMs);

        waiter.timer = timer;
        queue.items.push(waiter);
        queue.activeCount++;
        waiter.signal?.addEventListener?.("abort", waiter.onAbort, { once: true });
        if (waiter.signal?.aborted) waiter.onAbort();
      });
    }

    return this._createLockHandle(lockKey, ttlMs);
  }

  async release(handle) {
    if (!handle || handle.released) return;

    const entry = this._locks.get(handle.lockKey);
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

  async isLocked(key) {
    this._assertActive();
    const lockKey = normalizeLockKey(key);
    const existing = this._locks.get(lockKey);
    if (existing && existing.handle.expiresAt.getTime() <= Date.now()) {
      this._expireHandle(lockKey, existing.handle);
    }
    return this._locks.has(lockKey);
  }

  destroy() {
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
      for (let index = queue.head; index < queue.items.length; index += 1) {
        const waiter = queue.items[index];
        if (!waiter?.active) continue;
        waiter.active = false;
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
        waiter.reject(new LockManagerDestroyedError(this.config.backend));
      }
      this._queues.delete(key);
    }
    this._metrics.currentWaiting = 0;
  }

  _createLockHandle(key, ttlMs = this.config.defaultTtlMs) {
    const fencingToken = LockManager.fencingToken();
    const now = new Date();

    const handle = {
      lockKey: key,
      fencingToken,
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      released: false,
      release: async () => this.release(handle),
      heartbeat: async (extendMs = this.config.defaultTtlMs) => {
        if (handle.released) throw new LockReleasedError(key);
        const heartbeatTtlMs = positiveDuration(extendMs, this.config.defaultTtlMs, "extendMs");
        // Reset the auto-expiry timer
        const entry = this._locks.get(key);
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

    const timer = this._expiryTimer(key, handle, ttlMs);

    this._locks.set(key, { handle, timer });
    this._metrics.totalAcquired++;
    this._metrics.currentActive++;

    return handle;
  }

  _queueFor(key) {
    let queue = this._queues.get(key);
    if (!queue) {
      queue = { items: [], head: 0, activeCount: 0 };
      this._queues.set(key, queue);
    }
    return queue;
  }

  _promoteNext(key) {
    const queue = this._queues.get(key);
    if (!queue) return;
    while (queue.head < queue.items.length) {
      const next = queue.items[queue.head++];
      if (!next.active) continue;
      next.active = false;
      queue.activeCount--;
      clearTimeout(next.timer);
      next.signal?.removeEventListener?.("abort", next.onAbort);
      this._metrics.currentWaiting = Math.max(0, this._metrics.currentWaiting - 1);
      if (queue.activeCount === 0) this._queues.delete(key);
      next.resolve(this._createLockHandle(key, next.ttlMs));
      return;
    }
    this._queues.delete(key);
  }

  _expiryTimer(key, handle, ttlMs) {
    const timer = setTimeout(() => {
      this._expireHandle(key, handle);
    }, ttlMs);
    if (timer.unref) timer.unref();
    return timer;
  }

  _expireHandle(key, handle) {
    const entry = this._locks.get(key);
    if (!entry || entry.handle.fencingToken !== handle.fencingToken) return false;
    clearTimeout(entry.timer);
    this._locks.delete(key);
    handle.released = true;
    this._metrics.currentActive--;
    this._metrics.totalExpired++;
    this._promoteNext(key);
    return true;
  }

  _assertActive() {
    if (this._destroyed) throw new LockManagerDestroyedError(this.config.backend);
  }
}

function normalizeLockKey(key) {
  const normalized = String(key ?? "").trim();
  if (!normalized) throw new TypeError("Lock key must be a non-empty string.");
  return normalized;
}

function positiveDuration(value, fallback, label) {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a positive finite number.`);
  }
  return normalized;
}

function nonNegativeDuration(value, fallback, label) {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new TypeError(`${label} must be a non-negative finite number.`);
  }
  return normalized;
}

function positiveInteger(value, fallback, label) {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return normalized;
}

function throwIfAcquireAborted(signal, key) {
  if (signal?.aborted) throw new LockAcquireAbortedError(key);
}

// --- Error types ---

export class LockTimeoutError extends Error {
  constructor(key, waitMs) {
    super(`Lock acquisition timed out after ${waitMs}ms.`);
    this.name = "LockTimeoutError";
    this.waitMs = waitMs;
  }
}

export class LockAcquireAbortedError extends Error {
  constructor(key) {
    super("Lock acquisition was cancelled.");
    this.name = "LockAcquireAbortedError";
  }
}

export class LockQueueFullError extends Error {
  constructor(key, maxDepth) {
    super(`Lock queue is full (max ${maxDepth}).`);
    this.name = "LockQueueFullError";
    this.maxDepth = maxDepth;
  }
}

export class LockFencingError extends Error {
  constructor(key, token) {
    super("Lock fencing token mismatch.");
    this.name = "LockFencingError";
  }
}

export class LockReleasedError extends Error {
  constructor(key) {
    super("Lock handle has already been released.");
    this.name = "LockReleasedError";
  }
}

export class LockManagerDestroyedError extends Error {
  constructor(backend = "lock") {
    super(`${backend} lock manager has been destroyed.`);
    this.name = "LockManagerDestroyedError";
    this.backend = backend;
  }
}

/**
 * Create a LockManager from configuration.
 * @param {LockManagerConfig} config
 * @returns {LockManager}
 */
export function createLockManager(config = {}) {
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
export async function createLockManagerAsync(config = {}) {
  switch (requiredBackend(config)) {
    case "memory":
      return new MemoryLockManager(config);
    case "sqlite": {
      const { SqliteLockManager } = await import("./sqlite-lock-manager.mjs");
      return new SqliteLockManager(config);
    }
    case "postgres": {
      const { PostgresLockManager } = await import("./postgres-lock-manager.mjs");
      return new PostgresLockManager(config);
    }
    default:
      throw new Error(`Unsupported lock manager backend: ${String(config.backend)}.`);
  }
}

function requiredBackend(config) {
  const backend = String(config?.backend ?? "").trim();
  if (!backend) throw new TypeError("Lock manager backend must be selected explicitly.");
  return backend;
}
