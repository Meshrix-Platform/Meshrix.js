/**
 * LockManager contract — interface, base class, and typed errors for durable
 * locking, shared by the memory factory and the SQLite and PostgreSQL backends.
 *
 * Backends import only this acyclic contract module; factory selection lives
 * in lock-manager.ts and never becomes a backend dependency.
 *
 * @module foundation/concurrency/lock-manager-contract
 */

export const LOCK_MANAGER_PROTOCOL: any = "v0.0.1:concurrency:lock-manager-1.0.0";

let memoryFenceSequence: any = BigInt(Date.now()) * 1_000_000n;

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
  _metrics: any;
  config: any;
  /**
   * @param {LockManagerConfig} config
   */
  constructor(config: Record<string, any> = {}) {
    this.config = {
      backend: config.backend || "memory",
      defaultTtlMs: positiveDuration(config.defaultTtlMs, 30000, "defaultTtlMs"),
      maxWaitMs: nonNegativeDuration(config.maxWaitMs, 60000, "maxWaitMs"),
      heartbeatIntervalMs: positiveDuration(config.heartbeatIntervalMs, 10000, "heartbeatIntervalMs"),
      maxQueueDepth: positiveInteger(config.maxQueueDepth, 1000, "maxQueueDepth"),
      maxTotalQueueDepth: positiveInteger(config.maxTotalQueueDepth, 4096, "maxTotalQueueDepth"),
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
  async acquire(key?: any, options: Record<string, any> = {}) : Promise<any> {
    throw new Error("LockManager.acquire() must be implemented by subclass");
  }

  /**
   * Release a lock by its handle.
   * @param {LockHandle} handle
   * @returns {Promise<void>}
   */
  async release(handle?: any) : Promise<any> {
    throw new Error("LockManager.release() must be implemented by subclass");
  }

  /**
   * Check if a lock is held.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async isLocked(key?: any) : Promise<any> {
    throw new Error("LockManager.isLocked() must be implemented by subclass");
  }

  /**
   * Get current metrics.
   * @returns {object}
   */
  getMetrics() : any {
    return { ...this._metrics };
  }

  /**
   * Generate a fencing token.
   * @returns {string}
   */
  static fencingToken() : any {
    memoryFenceSequence += 1n;
    return `fence_memory_${memoryFenceSequence}`;
  }
}

export function normalizeLockKey(key?: any) : any {
  const normalized: any = String(key ?? "").trim();
  if (!normalized) throw new TypeError("Lock key must be a non-empty string.");
  return normalized;
}

export function positiveDuration(value?: any, fallback?: any, label?: any) : any {
  const normalized: any = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a positive finite number.`);
  }
  return normalized;
}

export function nonNegativeDuration(value?: any, fallback?: any, label?: any) : any {
  const normalized: any = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new TypeError(`${label} must be a non-negative finite number.`);
  }
  return normalized;
}

export function positiveInteger(value?: any, fallback?: any, label?: any) : any {
  const normalized: any = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return normalized;
}

export function throwIfAcquireAborted(signal?: any, key?: any) : any {
  if (signal?.aborted) throw new LockAcquireAbortedError(key);
}

/** O(1) FIFO insertion, removal, and cancellation without array tombstones. */
export class IntrusiveWaitQueue {
  head: any = null;
  tail: any = null;
  size: any = 0;

  push(node?: any) : any {
    node.previous = this.tail;
    node.next = null;
    node.queue = this;
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;
    this.size += 1;
    return node;
  }

  remove(node?: any) : any {
    if (!node || node.queue !== this) return false;
    if (node.previous) node.previous.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.previous = node.previous;
    else this.tail = node.previous;
    node.previous = null;
    node.next = null;
    node.queue = null;
    this.size -= 1;
    return true;
  }

  shift() : any {
    const node: any = this.head;
    if (node) this.remove(node);
    return node;
  }
}

/** One lazy-deletion min-heap and one timer for every pending deadline/poll. */
export class DeadlineScheduler {
  _heap: any[] = [];
  _timer: any = null;
  _timerAt: any = 0;
  _closed: any = false;

  schedule(at?: any, run?: any) : any {
    if (this._closed) return null;
    const entry: any = { at: Number(at), run, active: true };
    this._heap.push(entry);
    this._bubbleUp(this._heap.length - 1);
    this._arm();
    return entry;
  }

  cancel(entry?: any) : any {
    if (!entry) return;
    entry.active = false;
    this._discardInactiveHead();
    if (this._heap.length === 0) {
      if (this._timer) clearTimeout(this._timer);
      this._timer = null;
      this._timerAt = 0;
      return;
    }
    if (this._timer && this._timerAt !== this._heap[0].at) {
      clearTimeout(this._timer);
      this._timer = null;
      this._timerAt = 0;
    }
    this._arm();
  }

  close() : any {
    this._closed = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._timerAt = 0;
    this._heap.length = 0;
  }

  get activeTimerCount() : any {
    return this._timer ? 1 : 0;
  }

  _bubbleUp(start?: any) : any {
    let index: any = start;
    while (index > 0) {
      const parent: any = Math.floor((index - 1) / 2);
      if (this._heap[parent].at <= this._heap[index].at) break;
      [this._heap[parent], this._heap[index]] = [this._heap[index], this._heap[parent]];
      index = parent;
    }
  }

  _pop() : any {
    const first: any = this._heap[0];
    const last: any = this._heap.pop();
    if (this._heap.length > 0) {
      this._heap[0] = last;
      let index: any = 0;
      while (true) {
        const left: any = index * 2 + 1;
        const right: any = left + 1;
        let smallest: any = index;
        if (left < this._heap.length && this._heap[left].at < this._heap[smallest].at) smallest = left;
        if (right < this._heap.length && this._heap[right].at < this._heap[smallest].at) smallest = right;
        if (smallest === index) break;
        [this._heap[smallest], this._heap[index]] = [this._heap[index], this._heap[smallest]];
        index = smallest;
      }
    }
    return first;
  }

  _discardInactiveHead() : any {
    while (this._heap.length > 0 && !this._heap[0].active) this._pop();
  }

  _arm() : any {
    this._discardInactiveHead();
    if (this._closed || this._heap.length === 0) return;
    const nextAt: any = this._heap[0].at;
    if (this._timer && this._timerAt <= nextAt) return;
    if (this._timer) clearTimeout(this._timer);
    this._timerAt = nextAt;
    this._timer = setTimeout(() : any => this._drain(), Math.max(0, nextAt - Date.now()));
    this._timer.unref?.();
  }

  _drain() : any {
    this._timer = null;
    this._timerAt = 0;
    const nowMs: any = Date.now();
    this._discardInactiveHead();
    while (this._heap.length > 0 && this._heap[0].at <= nowMs) {
      const entry: any = this._pop();
      if (!entry.active) continue;
      entry.active = false;
      entry.run();
      this._discardInactiveHead();
    }
    this._arm();
  }
}

// --- Error types ---
export class LockTimeoutError extends Error {
  name: any;
  waitMs: any;
  constructor(key?: any, waitMs?: any) {
    super(`Lock acquisition timed out after ${waitMs}ms.`);
    this.name = "LockTimeoutError";
    this.waitMs = waitMs;
  }
}

export class LockAcquireAbortedError extends Error {
  name: any;
  constructor(key?: any) {
    super("Lock acquisition was cancelled.");
    this.name = "LockAcquireAbortedError";
  }
}

export class LockQueueFullError extends Error {
  maxDepth: any;
  name: any;
  constructor(key?: any, maxDepth?: any) {
    super(`Lock queue is full (max ${maxDepth}).`);
    this.name = "LockQueueFullError";
    this.maxDepth = maxDepth;
  }
}

export class LockFencingError extends Error {
  name: any;
  constructor(key?: any, token?: any) {
    super("Lock fencing token mismatch.");
    this.name = "LockFencingError";
  }
}

export class LockReleasedError extends Error {
  name: any;
  constructor(key?: any) {
    super("Lock handle has already been released.");
    this.name = "LockReleasedError";
  }
}

export class LockManagerDestroyedError extends Error {
  backend: any;
  name: any;
  constructor(backend: any = "lock") {
    super(`${backend} lock manager has been destroyed.`);
    this.name = "LockManagerDestroyedError";
    this.backend = backend;
  }
}
