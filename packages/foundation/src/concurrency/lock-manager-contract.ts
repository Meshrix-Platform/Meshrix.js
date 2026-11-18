/**
 * LockManager contract — interface, base class, and typed errors for durable
 * locking, shared by the memory factory and the SQLite and PostgreSQL backends.
 *
 * Backends import only this acyclic contract module; factory selection lives
 * in lock-manager.ts and never becomes a backend dependency.
 *
 * @module foundation/concurrency/lock-manager-contract
 */

export const LOCK_MANAGER_PROTOCOL = "v0.0.1:concurrency:lock-manager-1.0.0";

let memoryFenceSequence = BigInt(Date.now()) * 1_000_000n;

export interface LockHandle {
  lockKey: string;
  fencingToken: string;
  acquiredAt: Date;
  expiresAt: Date;
  release(): Promise<void>;
  heartbeat(extendMs?: number): Promise<void>;
  released: boolean;
}

export interface LockManagerConfig {
  [key: string]: unknown;
  backend?: string;
  defaultTtlMs?: number;
  maxWaitMs?: number;
  heartbeatIntervalMs?: number;
  maxQueueDepth?: number;
  maxTotalQueueDepth?: number;
}

export interface NormalizedLockManagerConfig {
  backend: string;
  defaultTtlMs: number;
  maxWaitMs: number;
  heartbeatIntervalMs: number;
  maxQueueDepth: number;
  maxTotalQueueDepth: number;
}

export interface LockAcquireOptions {
  ttlMs?: number;
  waitMs?: number;
  signal?: AbortSignal;
}

export interface LockManagerMetrics {
  totalAcquired: number;
  totalReleased: number;
  totalTimedOut: number;
  totalExpired: number;
  totalBackendErrors: number;
  currentActive: number;
  currentWaiting: number;
}

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
  _metrics: LockManagerMetrics;
  config: NormalizedLockManagerConfig;
  /**
   * @param {LockManagerConfig} config
   */
  constructor(config: LockManagerConfig = {}) {
    this.config = {
      backend: config.backend || "memory",
      defaultTtlMs: positiveDuration(
        config.defaultTtlMs,
        30000,
        "defaultTtlMs",
      ),
      maxWaitMs: nonNegativeDuration(config.maxWaitMs, 60000, "maxWaitMs"),
      heartbeatIntervalMs: positiveDuration(
        config.heartbeatIntervalMs,
        10000,
        "heartbeatIntervalMs",
      ),
      maxQueueDepth: positiveInteger(
        config.maxQueueDepth,
        1000,
        "maxQueueDepth",
      ),
      maxTotalQueueDepth: positiveInteger(
        config.maxTotalQueueDepth,
        4096,
        "maxTotalQueueDepth",
      ),
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
  async acquire(
    _key: string,
    _options: LockAcquireOptions = {},
  ): Promise<LockHandle> {
    throw new Error("LockManager.acquire() must be implemented by subclass");
  }

  /**
   * Release a lock by its handle.
   * @param {LockHandle} handle
   * @returns {Promise<void>}
   */
  async release(_handle: LockHandle): Promise<void> {
    throw new Error("LockManager.release() must be implemented by subclass");
  }

  /**
   * Check if a lock is held.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async isLocked(_key: string): Promise<boolean> {
    throw new Error("LockManager.isLocked() must be implemented by subclass");
  }

  /**
   * Get current metrics.
   * @returns {object}
   */
  getMetrics(): LockManagerMetrics {
    return { ...this._metrics };
  }

  destroy(): void | Promise<void> {
    // Durable backends override this hook; memory-only managers have no external resource.
  }

  /**
   * Generate a fencing token.
   * @returns {string}
   */
  static fencingToken(): string {
    memoryFenceSequence += 1n;
    return `fence_memory_${memoryFenceSequence}`;
  }
}

export function normalizeLockKey(key: unknown): string {
  const normalized = String(key ?? "").trim();
  if (!normalized) throw new TypeError("Lock key must be a non-empty string.");
  return normalized;
}

export function positiveDuration(
  value: unknown,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (
    typeof normalized !== "number" ||
    !Number.isFinite(normalized) ||
    normalized <= 0
  ) {
    throw new TypeError(`${label} must be a positive finite number.`);
  }
  return normalized;
}

export function nonNegativeDuration(
  value: unknown,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (
    typeof normalized !== "number" ||
    !Number.isFinite(normalized) ||
    normalized < 0
  ) {
    throw new TypeError(`${label} must be a non-negative finite number.`);
  }
  return normalized;
}

export function positiveInteger(
  value: unknown,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    normalized <= 0
  ) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return normalized;
}

export function throwIfAcquireAborted(
  signal: AbortSignal | undefined,
  key: string,
): void {
  if (signal?.aborted) throw new LockAcquireAbortedError(key);
}

/** O(1) FIFO insertion, removal, and cancellation without array tombstones. */
export interface IntrusiveWaitNode<T extends IntrusiveWaitNode<T>> {
  previous: T | null;
  next: T | null;
  queue: IntrusiveWaitQueue<T> | null;
}

export class IntrusiveWaitQueue<T extends IntrusiveWaitNode<T>> {
  head: T | null = null;
  tail: T | null = null;
  size = 0;

  push(node: T): T {
    node.previous = this.tail;
    node.next = null;
    node.queue = this;
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;
    this.size += 1;
    return node;
  }

  remove(node: T | null | undefined): boolean {
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

  shift(): T | null {
    const node = this.head;
    if (node) this.remove(node);
    return node;
  }
}

/** One lazy-deletion min-heap and one timer for every pending deadline/poll. */
export class DeadlineScheduler {
  _heap: DeadlineEntry[] = [];
  _timer: NodeJS.Timeout | null = null;
  _timerAt = 0;
  _closed = false;

  schedule(at: number, run: () => void): DeadlineEntry | null {
    if (this._closed) return null;
    const entry: DeadlineEntry = { at: Number(at), run, active: true };
    this._heap.push(entry);
    this._bubbleUp(this._heap.length - 1);
    this._arm();
    return entry;
  }

  cancel(entry: DeadlineEntry | null | undefined): void {
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

  close(): void {
    this._closed = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._timerAt = 0;
    this._heap.length = 0;
  }

  get activeTimerCount(): number {
    return this._timer ? 1 : 0;
  }

  _bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this._heap[parent].at <= this._heap[index].at) break;
      [this._heap[parent], this._heap[index]] = [
        this._heap[index],
        this._heap[parent],
      ];
      index = parent;
    }
  }

  _pop(): DeadlineEntry | undefined {
    const first = this._heap[0];
    const last = this._heap.pop();
    if (this._heap.length > 0 && last) {
      this._heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (
          left < this._heap.length &&
          this._heap[left].at < this._heap[smallest].at
        )
          smallest = left;
        if (
          right < this._heap.length &&
          this._heap[right].at < this._heap[smallest].at
        )
          smallest = right;
        if (smallest === index) break;
        [this._heap[smallest], this._heap[index]] = [
          this._heap[index],
          this._heap[smallest],
        ];
        index = smallest;
      }
    }
    return first;
  }

  _discardInactiveHead(): void {
    while (this._heap.length > 0 && !this._heap[0].active) this._pop();
  }

  _arm(): void {
    this._discardInactiveHead();
    if (this._closed || this._heap.length === 0) return;
    const nextAt = this._heap[0].at;
    if (this._timer && this._timerAt <= nextAt) return;
    if (this._timer) clearTimeout(this._timer);
    this._timerAt = nextAt;
    this._timer = setTimeout(
      () => this._drain(),
      Math.max(0, nextAt - Date.now()),
    );
    this._timer.unref?.();
  }

  _drain(): void {
    this._timer = null;
    this._timerAt = 0;
    const nowMs = Date.now();
    this._discardInactiveHead();
    while (this._heap.length > 0 && this._heap[0].at <= nowMs) {
      const entry = this._pop();
      if (!entry?.active) continue;
      entry.active = false;
      entry.run();
      this._discardInactiveHead();
    }
    this._arm();
  }
}

export interface DeadlineEntry {
  at: number;
  run: () => void;
  active: boolean;
}

// --- Error types ---
export class LockTimeoutError extends Error {
  override name = "LockTimeoutError";
  waitMs: number;
  constructor(_key: string, waitMs: number) {
    super(`Lock acquisition timed out after ${waitMs}ms.`);
    this.waitMs = waitMs;
  }
}

export class LockAcquireAbortedError extends Error {
  override name = "LockAcquireAbortedError";
  constructor(_key: string) {
    super("Lock acquisition was cancelled.");
  }
}

export class LockQueueFullError extends Error {
  maxDepth: number;
  override name = "LockQueueFullError";
  constructor(_key: string, maxDepth: number) {
    super(`Lock queue is full (max ${maxDepth}).`);
    this.maxDepth = maxDepth;
  }
}

export class LockFencingError extends Error {
  override name = "LockFencingError";
  constructor(_key: string, _token: string) {
    super("Lock fencing token mismatch.");
  }
}

export class LockReleasedError extends Error {
  override name = "LockReleasedError";
  constructor(_key: string) {
    super("Lock handle has already been released.");
  }
}

export class LockManagerDestroyedError extends Error {
  backend: string;
  override name = "LockManagerDestroyedError";
  constructor(backend = "lock") {
    super(`${backend} lock manager has been destroyed.`);
    this.backend = backend;
  }
}
