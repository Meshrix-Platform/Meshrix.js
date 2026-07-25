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
  LockTimeoutError
} from "./lock-manager.mjs";

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
  constructor(operation) {
    super(`SQLite lock backend failed during ${operation}.`);
    this.name = "SqliteLockBackendError";
    this.operation = operation;
  }
}

export class SqliteLockManager extends LockManager {
  /**
   * @param {object} config
   * @param {object} config.db - better-sqlite3 Database instance
   * @param {number} [config.defaultTtlMs=30000]
   * @param {number} [config.maxWaitMs=60000]
   * @param {number} [config.heartbeatIntervalMs=10000]
   * @param {number} [config.cleanupIntervalMs=60000]
   */
  constructor(config = {}) {
    super({ ...config, backend: "sqlite" });
    if (!config.db) {
      throw new Error("SqliteLockManager requires a `db` (better-sqlite3 Database instance).");
    }
    this.db = config.db;
    this._pid = process.pid;
    this._cleanupInterval = null;
    this._cleanupIntervalMs = positiveDuration(config.cleanupIntervalMs, 60000, "cleanupIntervalMs");
    this._retryIntervalMs = positiveDuration(config.retryIntervalMs, 100, "retryIntervalMs");
    this._maxRetryIntervalMs = positiveDuration(
      config.maxRetryIntervalMs,
      Math.max(1000, this._retryIntervalMs),
      "maxRetryIntervalMs"
    );
    this._random = typeof config.random === "function" ? config.random : Math.random;
    this._handles = new Map();
    this._queues = new Map();
    this._pendingAcquires = new Set();
    this._destroyed = false;
    this._destroyPromise = null;

    try {
      this._init();
    } catch {
      this._metrics.totalBackendErrors++;
      throw new SqliteLockBackendError("initialize");
    }
  }

  _init() {
    this.db.exec(TABLE_DDL);
    const cleanupKey = this.db.prepare(
      "DELETE FROM _meshrix_locks WHERE lock_key = ? AND expires_at <= ?"
    );
    const findLock = this.db.prepare(
      "SELECT 1 FROM _meshrix_locks WHERE lock_key = ?"
    );
    const nextFence = this.db.prepare(`
      UPDATE _meshrix_lock_fence_sequence
      SET value = value + 1
      WHERE singleton = 1
      RETURNING CAST(value AS TEXT) AS value
    `);
    const insertLock = this.db.prepare(`
      INSERT INTO _meshrix_locks (lock_key, fencing_token, acquired_at, expires_at, heartbeat_at, owner_pid)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this._tryAcquire = this.db.transaction(({ lockKey, acquiredAtIso, expiresAtIso }) => {
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
        this._pid
      );
      return fencingToken;
    });
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

  async acquire(key, options = {}) {
    this._assertActive();
    const pending = this._acquire(key, options);
    this._pendingAcquires.add(pending);
    try {
      return await pending;
    } finally {
      this._pendingAcquires.delete(pending);
    }
  }

  async _acquire(key, options = {}) {
    this._assertActive();
    const lockKey = normalizeLockKey(key);
    throwIfAcquireAborted(options.signal, lockKey);
    const ttlMs = positiveDuration(options.ttlMs, this.config.defaultTtlMs, "ttlMs");
    const waitMs = nonNegativeDuration(options.waitMs, this.config.maxWaitMs, "waitMs");
    const queue = this._queues.get(lockKey);
    if (!this._handles.has(lockKey) && !queue?.activeCount) {
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

  _attemptAcquire(lockKey, ttlMs) {
    this._assertActive();
    try {
      this._cleanupKey(lockKey);
      const acquiredAt = new Date();
      const expiresAt = new Date(acquiredAt.getTime() + ttlMs);
      const fencingToken = this._tryAcquire({
        acquiredAtIso: acquiredAt.toISOString(),
        expiresAtIso: expiresAt.toISOString(),
        lockKey
      });
      if (!fencingToken) return null;
      this._metrics.totalAcquired++;
      this._metrics.currentActive++;
      return this._buildHandle({ lockKey, fencingToken, acquiredAt, expiresAt });
    } catch (error) {
      if (error instanceof LockManagerDestroyedError) throw error;
      this._metrics.totalBackendErrors++;
      throw new SqliteLockBackendError("acquire");
    }
  }

  _enqueueWaiter(lockKey, ttlMs, waitMs, signal) {
    const queue = this._queueFor(lockKey);
    this._metrics.currentWaiting++;
    return new Promise((resolve, reject) => {
      const waiter = {
        active: true,
        reject,
        resolve,
        timer: null,
        ttlMs,
        signal,
        onAbort: null
      };
      waiter.onAbort = () => {
        if (!waiter.active) return;
        waiter.active = false;
        queue.activeCount--;
        this._metrics.currentWaiting = Math.max(0, this._metrics.currentWaiting - 1);
        clearTimeout(waiter.timer);
        this._discardQueueIfEmpty(lockKey, queue);
        reject(new LockAcquireAbortedError(lockKey));
      };
      waiter.timer = setTimeout(() => {
        if (!waiter.active) return;
        waiter.active = false;
        queue.activeCount--;
        this._metrics.currentWaiting = Math.max(0, this._metrics.currentWaiting - 1);
        this._metrics.totalTimedOut++;
        this._discardQueueIfEmpty(lockKey, queue);
        waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
        reject(new LockTimeoutError(lockKey, waitMs));
      }, waitMs);
      waiter.timer.unref?.();
      queue.items.push(waiter);
      queue.activeCount++;
      waiter.signal?.addEventListener?.("abort", waiter.onAbort, { once: true });
      if (waiter.signal?.aborted) waiter.onAbort();
      this._schedulePoll(lockKey, 0);
    });
  }

  _queueFor(lockKey) {
    let queue = this._queues.get(lockKey);
    if (!queue) {
      queue = {
        activeCount: 0,
        backoffMs: this._retryIntervalMs,
        head: 0,
        items: [],
        pollTimer: null,
        polling: false
      };
      this._queues.set(lockKey, queue);
    }
    return queue;
  }

  _peekWaiter(queue) {
    while (queue.head < queue.items.length && !queue.items[queue.head]?.active) {
      queue.head++;
    }
    if (queue.head > 1024 && queue.head * 2 > queue.items.length) {
      queue.items = queue.items.slice(queue.head);
      queue.head = 0;
    }
    return queue.items[queue.head] || null;
  }

  _schedulePoll(lockKey, delayMs) {
    const queue = this._queues.get(lockKey);
    if (!queue || queue.activeCount === 0 || queue.polling || queue.pollTimer || this._destroyed) return;
    const jitteredDelay = delayMs <= 0
      ? 0
      : Math.max(1, Math.floor(delayMs * (0.5 + Math.min(1, Math.max(0, this._random())) * 0.5)));
    queue.pollTimer = setTimeout(() => {
      queue.pollTimer = null;
      this._pollQueue(lockKey);
    }, jitteredDelay);
    queue.pollTimer.unref?.();
  }

  _pollQueue(lockKey) {
    const queue = this._queues.get(lockKey);
    if (!queue || queue.polling || this._destroyed) return;
    const waiter = this._peekWaiter(queue);
    if (!waiter) {
      this._discardQueueIfEmpty(lockKey, queue);
      return;
    }
    if (this._handles.has(lockKey)) return;

    queue.polling = true;
    let handle = null;
    try {
      handle = this._attemptAcquire(lockKey, waiter.ttlMs);
    } catch (error) {
      this._rejectQueue(lockKey, error);
      return;
    } finally {
      queue.polling = false;
    }

    if (handle) {
      waiter.active = false;
      queue.activeCount--;
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
      this._metrics.currentWaiting = Math.max(0, this._metrics.currentWaiting - 1);
      queue.head++;
      queue.backoffMs = this._retryIntervalMs;
      waiter.resolve(handle);
      this._discardQueueIfEmpty(lockKey, queue);
      return;
    }

    const delayMs = queue.backoffMs;
    queue.backoffMs = Math.min(this._maxRetryIntervalMs, queue.backoffMs * 2);
    this._schedulePoll(lockKey, delayMs);
  }

  _discardQueueIfEmpty(lockKey, queue) {
    if (queue.activeCount > 0) return;
    if (queue.pollTimer) clearTimeout(queue.pollTimer);
    queue.pollTimer = null;
    this._queues.delete(lockKey);
  }

  _rejectQueue(lockKey, error) {
    const queue = this._queues.get(lockKey);
    if (!queue) return;
    if (queue.pollTimer) clearTimeout(queue.pollTimer);
    for (let index = queue.head; index < queue.items.length; index++) {
      const waiter = queue.items[index];
      if (!waiter?.active) continue;
      waiter.active = false;
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
      this._metrics.currentWaiting = Math.max(0, this._metrics.currentWaiting - 1);
      waiter.reject(error);
    }
    queue.activeCount = 0;
    queue.pollTimer = null;
    this._queues.delete(lockKey);
  }

  async release(handle) {
    if (!handle || handle.released) return;
    try {
      const existing = this.db.prepare(
        "SELECT fencing_token, expires_at FROM _meshrix_locks WHERE lock_key = ?"
      ).get(handle.lockKey);

      if (!existing) {
        this._markExpired(handle);
        return;
      }

      if (existing.fencing_token !== handle.fencingToken) {
        throw new LockFencingError(handle.lockKey, handle.fencingToken);
      }
      if (handle.expiresAt.getTime() <= Date.now() || Date.parse(existing.expires_at) <= Date.now()) {
        this.db.prepare("DELETE FROM _meshrix_locks WHERE lock_key = ? AND fencing_token = ?")
          .run(handle.lockKey, handle.fencingToken);
        this._markExpired(handle);
        return;
      }

      const result = this.db.prepare("DELETE FROM _meshrix_locks WHERE lock_key = ? AND fencing_token = ?")
        .run(handle.lockKey, handle.fencingToken);

      if (result.changes === 0) {
        this._markExpired(handle);
        return;
      }
      this._clearHandle(handle);
      handle.released = true;
      this._metrics.totalReleased++;
      this._metrics.currentActive = Math.max(0, this._metrics.currentActive - 1);
      this._schedulePoll(handle.lockKey, 0);
    } catch (error) {
      if (error instanceof LockFencingError) throw error;
      this._metrics.totalBackendErrors++;
      throw new SqliteLockBackendError("release");
    }
  }

  async isLocked(key) {
    this._assertActive();
    const lockKey = normalizeLockKey(key);
    try {
      this._cleanupKey(lockKey);
      const row = this.db.prepare("SELECT 1 FROM _meshrix_locks WHERE lock_key = ?").get(lockKey);
      return Boolean(row);
    } catch {
      this._metrics.totalBackendErrors++;
      throw new SqliteLockBackendError("inspect");
    }
  }

  _cleanupKey(key) {
    const localEntry = this._handles.get(key);
    if (localEntry && localEntry.handle.expiresAt.getTime() <= Date.now()) {
      this._markExpired(localEntry.handle);
    }
    this.db.prepare(
      "DELETE FROM _meshrix_locks WHERE lock_key = ? AND expires_at < ?"
    ).run(key, new Date().toISOString());
  }

  _cleanupExpired() {
    this.db.prepare(
      "DELETE FROM _meshrix_locks WHERE expires_at < ?"
    ).run(new Date().toISOString());
    const now = Date.now();
    for (const { handle } of this._handles.values()) {
      if (!handle.released && handle.expiresAt.getTime() <= now) {
        this._markExpired(handle);
      }
    }
  }

  _buildHandle({ lockKey, fencingToken, acquiredAt, expiresAt }) {
    const handle = {
      lockKey,
      fencingToken,
      acquiredAt,
      expiresAt,
      released: false,
      release: async () => this.release(handle),
      heartbeat: async (extendMs = this.config.defaultTtlMs) => {
        this._assertActive();
        if (handle.released) throw new LockReleasedError(lockKey);
        const heartbeatTtlMs = positiveDuration(extendMs, this.config.defaultTtlMs, "extendMs");
        const heartbeatAt = new Date();
        const nextExpiresAt = new Date(heartbeatAt.getTime() + heartbeatTtlMs);
        let result;
        try {
          result = this.db.prepare(`
            UPDATE _meshrix_locks
            SET expires_at = ?, heartbeat_at = ?
            WHERE lock_key = ? AND fencing_token = ? AND expires_at > ?
          `).run(
            nextExpiresAt.toISOString(),
            heartbeatAt.toISOString(),
            lockKey,
            fencingToken,
            heartbeatAt.toISOString()
          );
        } catch {
          this._metrics.totalBackendErrors++;
          throw new SqliteLockBackendError("heartbeat");
        }
        if (result.changes === 0) {
          this._markExpired(handle);
          throw new LockReleasedError(lockKey);
        }
        handle.expiresAt = nextExpiresAt;
        this._resetExpiryTimer(handle, heartbeatTtlMs);
      },
    };
    this._handles.set(lockKey, { handle, timer: null });
    this._resetExpiryTimer(handle, expiresAt.getTime() - Date.now());
    return handle;
  }

  _resetExpiryTimer(handle, ttlMs) {
    const entry = this._handles.get(handle.lockKey);
    if (!entry || entry.handle.fencingToken !== handle.fencingToken) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      try {
        this.db.prepare(
          "DELETE FROM _meshrix_locks WHERE lock_key = ? AND fencing_token = ? AND expires_at <= ?"
        ).run(handle.lockKey, handle.fencingToken, new Date().toISOString());
      } catch {
        this._metrics.totalBackendErrors++;
        // The durable row still carries its own expiry and will be reclaimed later.
      }
      this._markExpired(handle);
    }, Math.max(1, ttlMs));
    if (entry.timer.unref) entry.timer.unref();
  }

  _clearHandle(handle) {
    const entry = this._handles.get(handle.lockKey);
    if (!entry || entry.handle.fencingToken !== handle.fencingToken) return false;
    if (entry.timer) clearTimeout(entry.timer);
    this._handles.delete(handle.lockKey);
    return true;
  }

  _markExpired(handle) {
    if (!handle || handle.released) return;
    const wasActive = this._clearHandle(handle);
    handle.released = true;
    if (wasActive) {
      this._metrics.currentActive = Math.max(0, this._metrics.currentActive - 1);
      this._metrics.totalExpired++;
    }
    this._schedulePoll(handle.lockKey, 0);
  }

  destroy() {
    if (this._destroyPromise) return this._destroyPromise;
    this._destroyed = true;
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }

    const destroyedError = new LockManagerDestroyedError(this.config.backend);
    for (const lockKey of [...this._queues.keys()]) {
      this._rejectQueue(lockKey, destroyedError);
    }

    this._destroyPromise = this._finishDestroy();
    return this._destroyPromise;
  }

  async _finishDestroy() {
    await Promise.allSettled([...this._pendingAcquires]);
    let cleanupFailed = false;
    let deleteLock = null;
    try {
      deleteLock = this.db.prepare(
        "DELETE FROM _meshrix_locks WHERE lock_key = ? AND fencing_token = ?"
      );
    } catch {
      cleanupFailed = true;
      this._metrics.totalBackendErrors++;
    }

    for (const { handle } of [...this._handles.values()]) {
      try {
        if (deleteLock) deleteLock.run(handle.lockKey, handle.fencingToken);
      } catch {
        cleanupFailed = true;
        this._metrics.totalBackendErrors++;
      } finally {
        const wasActive = this._clearHandle(handle);
        handle.released = true;
        if (wasActive) {
          this._metrics.currentActive = Math.max(0, this._metrics.currentActive - 1);
          this._metrics.totalReleased++;
        }
      }
    }

    if (cleanupFailed) throw new SqliteLockBackendError("destroy");
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

function throwIfAcquireAborted(signal, key) {
  if (signal?.aborted) throw new LockAcquireAbortedError(key);
}
