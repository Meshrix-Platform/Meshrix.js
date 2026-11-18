/**
 * SqliteLockManager — SQLite-based durable lock manager using advisory locks
 * via a dedicated locks table with TTL and heartbeat support.
 *
 * Survives process restarts: expired locks are automatically reclaimed.
 *
 * @module foundation/concurrency/sqlite-lock-manager
 */

import {
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
  nonNegativeDuration,
  throwIfAcquireAborted,
} from "./lock-manager-contract.ts";
import type {
  DeadlineEntry,
  IntrusiveWaitNode,
  LockAcquireOptions,
  LockHandle,
  LockManagerConfig,
  LockManagerMetrics,
} from "./lock-manager-contract.ts";
import type Database from "better-sqlite3";

const TABLE_DDL = `
CREATE TABLE IF NOT EXISTS _meshrix_locks (
  lock_key TEXT PRIMARY KEY,
  fencing_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  owner_pid INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meshrix_locks_expires ON _meshrix_locks(expires_at);

CREATE TABLE IF NOT EXISTS _meshrix_lock_fence_sequence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  value INTEGER NOT NULL CHECK (value >= 0)
);

INSERT OR IGNORE INTO _meshrix_lock_fence_sequence (singleton, value) VALUES (1, 0);
`;

export class SqliteLockBackendError extends Error {
  override name = "SqliteLockBackendError";
  operation: string;
  constructor(operation: string) {
    super(`SQLite lock backend failed during ${operation}.`);
    this.operation = operation;
  }
}

interface SqliteLockManagerConfig extends LockManagerConfig {
  db?: Database.Database;
  cleanupIntervalMs?: number;
  retryIntervalMs?: number;
  maxRetryIntervalMs?: number;
  random?: () => number;
}

interface SqliteLockEntry {
  handle: LockHandle;
  expiryEntry: DeadlineEntry | null;
}

interface SqliteWaiter extends IntrusiveWaitNode<SqliteWaiter> {
  active: boolean;
  reject: (reason: Error) => void;
  resolve: (handle: LockHandle) => void;
  deadlineEntry: DeadlineEntry | null;
  ttlMs: number;
  signal?: AbortSignal;
  onAbort: () => void;
}

class SqliteWaitQueue extends IntrusiveWaitQueue<SqliteWaiter> {
  backoffMs = 0;
  pollEntry: DeadlineEntry | null = null;
  polling = false;
}

interface SqliteLockMetrics extends LockManagerMetrics {
  queueKeys: number;
  waiterTimers: number;
}

interface TryAcquireInput {
  lockKey: string;
  acquiredAtIso: string;
  expiresAtIso: string;
}

interface FenceSequenceRow {
  value: string;
}

interface ExistingLockRow {
  fencing_token: string;
  expires_at: string;
}

export class SqliteLockManager extends LockManager {
  _cleanupInterval: NodeJS.Timeout | null;
  _cleanupIntervalMs: number;
  _destroyPromise: Promise<void> | null;
  _destroyed: boolean;
  _handles: Map<string, SqliteLockEntry>;
  _maxRetryIntervalMs: number;
  _pendingAcquires: Set<Promise<LockHandle>>;
  _pid: number;
  _queues: Map<string, SqliteWaitQueue>;
  _random: () => number;
  _retryIntervalMs: number;
  _scheduler: DeadlineScheduler;
  _tryAcquire!: (input: TryAcquireInput) => string | null;
  db: Database.Database;
  /**
   * @param {object} config
   * @param {object} config.db - better-sqlite3 Database instance
   * @param {number} [config.defaultTtlMs=30000]
   * @param {number} [config.maxWaitMs=60000]
   * @param {number} [config.heartbeatIntervalMs=10000]
   * @param {number} [config.cleanupIntervalMs=60000]
   */
  constructor(config: SqliteLockManagerConfig = {}) {
    super({ ...config, backend: "sqlite" });
    if (!config.db) {
      throw new Error(
        "SqliteLockManager requires a `db` (better-sqlite3 Database instance).",
      );
    }
    this.db = config.db;
    this._pid = process.pid;
    this._cleanupInterval = null;
    this._cleanupIntervalMs = positiveDuration(
      config.cleanupIntervalMs,
      60000,
      "cleanupIntervalMs",
    );
    this._retryIntervalMs = positiveDuration(
      config.retryIntervalMs,
      100,
      "retryIntervalMs",
    );
    this._maxRetryIntervalMs = positiveDuration(
      config.maxRetryIntervalMs,
      Math.max(1000, this._retryIntervalMs),
      "maxRetryIntervalMs",
    );
    this._random =
      typeof config.random === "function" ? config.random : Math.random;
    this._handles = new Map<string, SqliteLockEntry>();
    this._queues = new Map<string, SqliteWaitQueue>();
    this._scheduler = new DeadlineScheduler();
    this._pendingAcquires = new Set<Promise<LockHandle>>();
    this._destroyed = false;
    this._destroyPromise = null;

    try {
      this._init();
    } catch {
      this._metrics.totalBackendErrors++;
      throw new SqliteLockBackendError("initialize");
    }
  }

  _init(): void {
    this.db.exec(TABLE_DDL);
    const cleanupKey = this.db.prepare(
      "DELETE FROM _meshrix_locks WHERE lock_key = ? AND expires_at <= ?",
    );
    const findLock = this.db.prepare(
      "SELECT 1 FROM _meshrix_locks WHERE lock_key = ?",
    );
    const nextFence = this.db.prepare<[], FenceSequenceRow>(`
      UPDATE _meshrix_lock_fence_sequence
      SET value = value + 1
      WHERE singleton = 1
      RETURNING CAST(value AS TEXT) AS value
    `);
    const insertLock = this.db.prepare(`
      INSERT INTO _meshrix_locks (lock_key, fencing_token, acquired_at, expires_at, heartbeat_at, owner_pid)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this._tryAcquire = this.db.transaction(
      ({
        lockKey,
        acquiredAtIso,
        expiresAtIso,
      }: TryAcquireInput): string | null => {
        cleanupKey.run(lockKey, acquiredAtIso);
        if (findLock.get(lockKey)) return null;
        const sequence = nextFence.get();
        if (!sequence?.value) {
          throw new Error("SQLite lock fencing sequence is unavailable.");
        }
        const fencingToken = `fence_sqlite_${sequence.value}`;
        insertLock.run(
          lockKey,
          fencingToken,
          acquiredAtIso,
          expiresAtIso,
          acquiredAtIso,
          this._pid,
        );
        return fencingToken;
      },
    );
    // Start periodic cleanup of expired locks
    this._cleanupInterval = setInterval(() => {
      try {
        this._cleanupExpired();
      } catch {
        this._metrics.totalBackendErrors++;
      }
    }, this._cleanupIntervalMs);
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  override async acquire(
    key: string,
    options: LockAcquireOptions = {},
  ): Promise<LockHandle> {
    this._assertActive();
    const pending = this._acquire(key, options);
    this._pendingAcquires.add(pending);
    try {
      return await pending;
    } finally {
      this._pendingAcquires.delete(pending);
    }
  }

  async _acquire(
    key: string,
    options: LockAcquireOptions = {},
  ): Promise<LockHandle> {
    this._assertActive();
    const lockKey = normalizeLockKey(key);
    throwIfAcquireAborted(options.signal, lockKey);
    const ttlMs = positiveDuration(
      options.ttlMs,
      this.config.defaultTtlMs,
      "ttlMs",
    );
    const waitMs = nonNegativeDuration(
      options.waitMs,
      this.config.maxWaitMs,
      "waitMs",
    );
    const queue = this._queues.get(lockKey);
    if (!this._handles.has(lockKey) && !queue?.size) {
      const handle = this._attemptAcquire(lockKey, ttlMs);
      if (handle) return handle;
    }
    if (waitMs <= 0) {
      this._metrics.totalTimedOut++;
      throw new LockTimeoutError(lockKey, waitMs);
    }
    if (this._metrics.currentWaiting >= this.config.maxQueueDepth) {
      throw new LockQueueFullError(lockKey, this.config.maxQueueDepth);
    }

    return this._enqueueWaiter(lockKey, ttlMs, waitMs, options.signal);
  }

  _attemptAcquire(lockKey: string, ttlMs: number): LockHandle | null {
    this._assertActive();
    try {
      this._cleanupKey(lockKey);
      const acquiredAt = new Date();
      const expiresAt = new Date(acquiredAt.getTime() + ttlMs);
      const fencingToken = this._tryAcquire({
        acquiredAtIso: acquiredAt.toISOString(),
        expiresAtIso: expiresAt.toISOString(),
        lockKey,
      });
      if (!fencingToken) return null;
      this._metrics.totalAcquired++;
      this._metrics.currentActive++;
      return this._buildHandle({
        lockKey,
        fencingToken,
        acquiredAt,
        expiresAt,
      });
    } catch (error) {
      if (error instanceof LockManagerDestroyedError) throw error;
      this._metrics.totalBackendErrors++;
      throw new SqliteLockBackendError("acquire");
    }
  }

  _enqueueWaiter(
    lockKey: string,
    ttlMs: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<LockHandle> {
    const queue = this._queueFor(lockKey);
    this._metrics.currentWaiting++;
    return new Promise<LockHandle>((resolve, reject) => {
      const waiter: SqliteWaiter = {
        active: true,
        reject,
        resolve,
        previous: null,
        next: null,
        queue: null,
        deadlineEntry: null,
        ttlMs,
        signal,
        onAbort: () => undefined,
      };
      waiter.onAbort = () => {
        if (!waiter.active) return;
        waiter.active = false;
        queue.remove(waiter);
        this._metrics.currentWaiting = Math.max(
          0,
          this._metrics.currentWaiting - 1,
        );
        this._scheduler.cancel(waiter.deadlineEntry);
        this._discardQueueIfEmpty(lockKey, queue);
        reject(new LockAcquireAbortedError(lockKey));
      };
      waiter.deadlineEntry = this._scheduler.schedule(
        Date.now() + waitMs,
        () => {
          if (!waiter.active) return;
          waiter.active = false;
          queue.remove(waiter);
          this._metrics.currentWaiting = Math.max(
            0,
            this._metrics.currentWaiting - 1,
          );
          this._metrics.totalTimedOut++;
          this._discardQueueIfEmpty(lockKey, queue);
          waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
          reject(new LockTimeoutError(lockKey, waitMs));
        },
      );
      queue.push(waiter);
      waiter.signal?.addEventListener?.("abort", waiter.onAbort, {
        once: true,
      });
      if (waiter.signal?.aborted) waiter.onAbort();
      this._schedulePoll(lockKey, 0);
    });
  }

  _queueFor(lockKey: string): SqliteWaitQueue {
    let queue = this._queues.get(lockKey);
    if (!queue) {
      queue = new SqliteWaitQueue();
      queue.backoffMs = this._retryIntervalMs;
      queue.pollEntry = null;
      queue.polling = false;
      this._queues.set(lockKey, queue);
    }
    return queue;
  }

  _peekWaiter(queue: SqliteWaitQueue): SqliteWaiter | null {
    return queue.head || null;
  }

  _schedulePoll(lockKey: string, delayMs: number): void {
    const queue = this._queues.get(lockKey);
    if (
      !queue ||
      queue.size === 0 ||
      queue.polling ||
      queue.pollEntry ||
      this._destroyed
    )
      return;
    const jitteredDelay =
      delayMs <= 0
        ? 0
        : Math.max(
            1,
            Math.floor(
              delayMs * (0.5 + Math.min(1, Math.max(0, this._random())) * 0.5),
            ),
          );
    queue.pollEntry = this._scheduler.schedule(
      Date.now() + jitteredDelay,
      () => {
        queue.pollEntry = null;
        this._pollQueue(lockKey);
      },
    );
  }

  _pollQueue(lockKey: string): void {
    const queue = this._queues.get(lockKey);
    if (!queue || queue.polling || this._destroyed) return;
    const waiter = this._peekWaiter(queue);
    if (!waiter) {
      this._discardQueueIfEmpty(lockKey, queue);
      return;
    }
    if (this._handles.has(lockKey)) return;

    queue.polling = true;
    let handle: LockHandle | null = null;
    try {
      handle = this._attemptAcquire(lockKey, waiter.ttlMs);
    } catch (error) {
      this._rejectQueue(
        lockKey,
        error instanceof Error ? error : new SqliteLockBackendError("acquire"),
      );
      return;
    } finally {
      queue.polling = false;
    }

    if (handle) {
      waiter.active = false;
      queue.remove(waiter);
      this._scheduler.cancel(waiter.deadlineEntry);
      waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
      this._metrics.currentWaiting = Math.max(
        0,
        this._metrics.currentWaiting - 1,
      );
      queue.backoffMs = this._retryIntervalMs;
      waiter.resolve(handle);
      this._discardQueueIfEmpty(lockKey, queue);
      return;
    }

    const delayMs = queue.backoffMs;
    queue.backoffMs = Math.min(this._maxRetryIntervalMs, queue.backoffMs * 2);
    this._schedulePoll(lockKey, delayMs);
  }

  _discardQueueIfEmpty(lockKey: string, queue: SqliteWaitQueue): void {
    if (queue.size > 0) return;
    this._scheduler.cancel(queue.pollEntry);
    queue.pollEntry = null;
    this._queues.delete(lockKey);
  }

  _rejectQueue(lockKey: string, error: Error): void {
    const queue = this._queues.get(lockKey);
    if (!queue) return;
    this._scheduler.cancel(queue.pollEntry);
    while (queue.size > 0) {
      const waiter = queue.shift();
      if (!waiter) continue;
      waiter.active = false;
      this._scheduler.cancel(waiter.deadlineEntry);
      waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
      this._metrics.currentWaiting = Math.max(
        0,
        this._metrics.currentWaiting - 1,
      );
      waiter.reject(error);
    }
    queue.pollEntry = null;
    this._queues.delete(lockKey);
  }

  override async release(handle: LockHandle): Promise<void> {
    if (!handle || handle.released) return;
    try {
      const existing = this.db
        .prepare<[string], ExistingLockRow>(
          "SELECT fencing_token, expires_at FROM _meshrix_locks WHERE lock_key = ?",
        )
        .get(handle.lockKey);

      if (!existing) {
        this._markExpired(handle);
        return;
      }

      if (existing.fencing_token !== handle.fencingToken) {
        throw new LockFencingError(handle.lockKey, handle.fencingToken);
      }
      if (
        handle.expiresAt.getTime() <= Date.now() ||
        Date.parse(existing.expires_at) <= Date.now()
      ) {
        this.db
          .prepare(
            "DELETE FROM _meshrix_locks WHERE lock_key = ? AND fencing_token = ?",
          )
          .run(handle.lockKey, handle.fencingToken);
        this._markExpired(handle);
        return;
      }

      const result = this.db
        .prepare(
          "DELETE FROM _meshrix_locks WHERE lock_key = ? AND fencing_token = ?",
        )
        .run(handle.lockKey, handle.fencingToken);

      if (result.changes === 0) {
        this._markExpired(handle);
        return;
      }
      this._clearHandle(handle);
      handle.released = true;
      this._metrics.totalReleased++;
      this._metrics.currentActive = Math.max(
        0,
        this._metrics.currentActive - 1,
      );
      this._schedulePoll(handle.lockKey, 0);
    } catch (error) {
      if (error instanceof LockFencingError) throw error;
      this._metrics.totalBackendErrors++;
      throw new SqliteLockBackendError("release");
    }
  }

  override async isLocked(key: string): Promise<boolean> {
    this._assertActive();
    const lockKey = normalizeLockKey(key);
    try {
      this._cleanupKey(lockKey);
      const row = this.db
        .prepare("SELECT 1 FROM _meshrix_locks WHERE lock_key = ?")
        .get(lockKey);
      return Boolean(row);
    } catch {
      this._metrics.totalBackendErrors++;
      throw new SqliteLockBackendError("inspect");
    }
  }

  override getMetrics(): SqliteLockMetrics {
    return {
      ...super.getMetrics(),
      queueKeys: this._queues.size,
      waiterTimers: this._scheduler.activeTimerCount,
    };
  }

  _cleanupKey(key: string): void {
    const localEntry = this._handles.get(key);
    if (localEntry && localEntry.handle.expiresAt.getTime() <= Date.now()) {
      this._markExpired(localEntry.handle);
    }
    this.db
      .prepare(
        "DELETE FROM _meshrix_locks WHERE lock_key = ? AND expires_at < ?",
      )
      .run(key, new Date().toISOString());
  }

  _cleanupExpired(): void {
    this.db
      .prepare("DELETE FROM _meshrix_locks WHERE expires_at < ?")
      .run(new Date().toISOString());
    const now = Date.now();
    for (const { handle } of this._handles.values()) {
      if (!handle.released && handle.expiresAt.getTime() <= now) {
        this._markExpired(handle);
      }
    }
  }

  _buildHandle({
    lockKey,
    fencingToken,
    acquiredAt,
    expiresAt,
  }: {
    lockKey: string;
    fencingToken: string;
    acquiredAt: Date;
    expiresAt: Date;
  }): LockHandle {
    const handle: LockHandle = {
      lockKey,
      fencingToken,
      acquiredAt,
      expiresAt,
      released: false,
      release: async (): Promise<void> => this.release(handle),
      heartbeat: async (extendMs = this.config.defaultTtlMs): Promise<void> => {
        this._assertActive();
        if (handle.released) throw new LockReleasedError(lockKey);
        const heartbeatTtlMs = positiveDuration(
          extendMs,
          this.config.defaultTtlMs,
          "extendMs",
        );
        const heartbeatAt = new Date();
        const nextExpiresAt = new Date(heartbeatAt.getTime() + heartbeatTtlMs);
        let changes = 0;
        try {
          const result = this.db
            .prepare(
              `
            UPDATE _meshrix_locks
            SET expires_at = ?, heartbeat_at = ?
            WHERE lock_key = ? AND fencing_token = ? AND expires_at > ?
          `,
            )
            .run(
              nextExpiresAt.toISOString(),
              heartbeatAt.toISOString(),
              lockKey,
              fencingToken,
              heartbeatAt.toISOString(),
            );
          changes = result.changes;
        } catch {
          this._metrics.totalBackendErrors++;
          throw new SqliteLockBackendError("heartbeat");
        }
        if (changes === 0) {
          this._markExpired(handle);
          throw new LockReleasedError(lockKey);
        }
        handle.expiresAt = nextExpiresAt;
        this._resetExpiryTimer(handle, heartbeatTtlMs);
      },
    };
    this._handles.set(lockKey, { handle, expiryEntry: null });
    this._resetExpiryTimer(handle, expiresAt.getTime() - Date.now());
    return handle;
  }

  _resetExpiryTimer(handle: LockHandle, ttlMs: number): void {
    const entry = this._handles.get(handle.lockKey);
    if (!entry || entry.handle.fencingToken !== handle.fencingToken) return;
    this._scheduler.cancel(entry.expiryEntry);
    entry.expiryEntry = this._scheduler.schedule(
      Date.now() + Math.max(1, ttlMs),
      () => {
        try {
          this.db
            .prepare(
              "DELETE FROM _meshrix_locks WHERE lock_key = ? AND fencing_token = ? AND expires_at <= ?",
            )
            .run(handle.lockKey, handle.fencingToken, new Date().toISOString());
        } catch {
          this._metrics.totalBackendErrors++;
          // The durable row still carries its own expiry and will be reclaimed later.
        }
        this._markExpired(handle);
      },
    );
  }

  _clearHandle(handle: LockHandle): boolean {
    const entry = this._handles.get(handle.lockKey);
    if (!entry || entry.handle.fencingToken !== handle.fencingToken)
      return false;
    this._scheduler.cancel(entry.expiryEntry);
    this._handles.delete(handle.lockKey);
    return true;
  }

  _markExpired(handle: LockHandle | null | undefined): void {
    if (!handle || handle.released) return;
    const wasActive = this._clearHandle(handle);
    handle.released = true;
    if (wasActive) {
      this._metrics.currentActive = Math.max(
        0,
        this._metrics.currentActive - 1,
      );
      this._metrics.totalExpired++;
    }
    this._schedulePoll(handle.lockKey, 0);
  }

  destroy(): Promise<void> {
    if (this._destroyPromise) return this._destroyPromise;
    this._destroyed = true;
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }

    const destroyedError = new LockManagerDestroyedError(this.config.backend);
    for (const lockKey of this._queues.keys()) {
      this._rejectQueue(lockKey, destroyedError);
    }
    this._scheduler.close();

    this._destroyPromise = this._finishDestroy();
    return this._destroyPromise;
  }

  async _finishDestroy(): Promise<void> {
    await Promise.allSettled(this._pendingAcquires);
    let cleanupFailed = false;
    let deleteLock: Database.Statement | null = null;
    try {
      deleteLock = this.db.prepare(
        "DELETE FROM _meshrix_locks WHERE lock_key = ? AND fencing_token = ?",
      );
    } catch {
      cleanupFailed = true;
      this._metrics.totalBackendErrors++;
    }

    for (const { handle } of this._handles.values()) {
      try {
        if (deleteLock) deleteLock.run(handle.lockKey, handle.fencingToken);
      } catch {
        cleanupFailed = true;
        this._metrics.totalBackendErrors++;
      } finally {
        const wasActive = this._clearHandle(handle);
        handle.released = true;
        if (wasActive) {
          this._metrics.currentActive = Math.max(
            0,
            this._metrics.currentActive - 1,
          );
          this._metrics.totalReleased++;
        }
      }
    }

    if (cleanupFailed) throw new SqliteLockBackendError("destroy");
  }

  _assertActive(): void {
    if (this._destroyed)
      throw new LockManagerDestroyedError(this.config.backend);
  }
}
