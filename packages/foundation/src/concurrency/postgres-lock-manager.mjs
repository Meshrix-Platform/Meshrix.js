/**
 * PostgreSQL session-level advisory lock manager.
 *
 * Every held lock owns one checked-out client because PostgreSQL advisory locks
 * belong to a session. TTL is an application lease: expiry explicitly unlocks
 * the session, while a dropped session is released by PostgreSQL itself.
 *
 * PostgreSQL's full transaction id supplies an opaque lease-generation token.
 * Durable writers still need an explicit atomic fencing contract.
 *
 * @module foundation/concurrency/postgres-lock-manager
 */

import crypto from "node:crypto";
import pg from "pg";

import {
  LockAcquireAbortedError,
  LockFencingError,
  LockManager,
  LockManagerDestroyedError,
  LockQueueFullError,
  LockReleasedError,
  LockTimeoutError
} from "./lock-manager.mjs";

const { Pool } = pg;

const ACQUIRE_SQL = `
WITH lock_attempt AS MATERIALIZED (
  SELECT pg_try_advisory_lock($1, $2) AS acquired
)
SELECT
  acquired,
  CASE WHEN acquired THEN pg_current_xact_id()::text ELSE NULL END AS fencing_token
FROM lock_attempt
`;

const TRY_LOCK_SQL = "SELECT pg_try_advisory_lock($1, $2) AS acquired";
const UNLOCK_SQL = "SELECT pg_advisory_unlock($1, $2) AS unlocked";
const HEARTBEAT_SQL = "SELECT 1 AS alive";

class PoolWaitTimeoutError extends Error {}
class BackendQueryTimeoutError extends Error {}

export class PostgresLockBackendError extends Error {
  constructor(operation) {
    super(`PostgreSQL lock backend failed during ${operation}.`);
    this.name = "PostgresLockBackendError";
    this.operation = operation;
  }
}

/**
 * Map an arbitrary application key into PostgreSQL's two-int32 advisory space.
 * The namespace prevents unrelated framework instances from sharing a keyspace.
 */
export function postgresAdvisoryKey(key, namespace = "meshrix") {
  const lockKey = normalizeLockKey(key);
  const lockNamespace = normalizeLockKey(namespace, "Lock namespace");
  const digest = crypto
    .createHash("sha256")
    .update(lockNamespace)
    .update("\0")
    .update(lockKey)
    .digest();
  return Object.freeze([digest.readInt32BE(0), digest.readInt32BE(4)]);
}

export class PostgresLockManager extends LockManager {
  /**
   * @param {object} config
   * @param {object} [config.pool] - Injected node-postgres Pool-compatible object.
   * @param {object} [config.pgConfig] - Options passed to a manager-owned Pool.
   * @param {string} [config.connectionString] - Manager-owned Pool connection URI.
   * @param {string} [config.namespace=meshrix] - Advisory lock key namespace.
   * @param {number} [config.retryIntervalMs=50] - Non-blocking retry cadence.
   */
  constructor(config = {}) {
    super({ ...config, backend: "postgres" });
    this.namespace = normalizeLockKey(config.namespace ?? "meshrix", "Lock namespace");
    this.retryIntervalMs = positiveDuration(config.retryIntervalMs, 50, "retryIntervalMs");
    this.queryTimeoutMs = positiveDuration(config.queryTimeoutMs, 5000, "queryTimeoutMs");
    this._entries = new Map();
    this._pendingAcquires = new Set();
    this._waitingByKey = new Map();
    this._destroyed = false;
    this._destroyPromise = null;
    this._destroyController = new AbortController();
    this._ownsPool = !config.pool;

    if (config.pool) {
      if (
        typeof config.pool.connect !== "function" ||
        typeof config.pool.on !== "function" ||
        (typeof config.pool.off !== "function" && typeof config.pool.removeListener !== "function")
      ) {
        throw new TypeError(
          "PostgresLockManager pool must expose connect() and EventEmitter listener methods."
        );
      }
      this.pool = config.pool;
    } else {
      const pgConfig = config.pgConfig
        ? { ...config.pgConfig }
        : config.connectionString
          ? { connectionString: config.connectionString }
          : null;
      if (!pgConfig) {
        throw new Error("PostgresLockManager requires pool, pgConfig, or connectionString.");
      }
      pgConfig.connectionTimeoutMillis ??= this.queryTimeoutMs;
      this.pool = new Pool(pgConfig);
    }
    this._poolErrorListener = () => {
      this._metrics.totalBackendErrors++;
    };
    this.pool.on("error", this._poolErrorListener);
    this._poolErrorListenerAttached = true;
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
    const waitingForKey = this._waitingByKey.get(lockKey) || 0;
    if (waitingForKey >= this.config.maxQueueDepth) {
      throw new LockQueueFullError(lockKey, this.config.maxQueueDepth);
    }
    this._waitingByKey.set(lockKey, waitingForKey + 1);

    const advisoryKey = postgresAdvisoryKey(lockKey, this.namespace);
    const deadline = Date.now() + waitMs;
    let client = null;
    let destroyClient = false;
    this._metrics.currentWaiting++;
    try {
      while (true) {
        const attemptDeadline = waitMs === 0
          ? Date.now() + this.queryTimeoutMs
          : Math.min(deadline, Date.now() + this.queryTimeoutMs);
        try {
          client = await this._connectBefore(attemptDeadline, options.signal, lockKey);
        } catch (error) {
          if (error instanceof LockManagerDestroyedError) throw error;
          if (error instanceof LockAcquireAbortedError) throw error;
          if (error instanceof PoolWaitTimeoutError) {
            this._metrics.totalTimedOut++;
            throw new LockTimeoutError(lockKey, waitMs);
          }
          this._metrics.totalBackendErrors++;
          throw new PostgresLockBackendError("connect");
        }

        let row;
        try {
          const result = await this._queryBefore(
            client,
            ACQUIRE_SQL,
            advisoryKey,
            attemptDeadline,
            { signal: options.signal, lockKey }
          );
          row = result.rows?.[0] || {};
        } catch (error) {
          destroyClient = true;
          if (error instanceof LockManagerDestroyedError) throw error;
          if (error instanceof LockAcquireAbortedError) throw error;
          if (error instanceof BackendQueryTimeoutError) {
            this._metrics.totalTimedOut++;
            throw new LockTimeoutError(lockKey, waitMs);
          }
          this._metrics.totalBackendErrors++;
          throw new PostgresLockBackendError("acquire");
        }

        if (this._destroyed) {
          destroyClient = true;
          throw new LockManagerDestroyedError(this.config.backend);
        }
        if (options.signal?.aborted) {
          destroyClient = true;
          throw new LockAcquireAbortedError(lockKey);
        }

        if (row.acquired === true) {
          const rawFence = String(row.fencing_token || "").trim();
          if (!rawFence) {
            destroyClient = true;
            this._metrics.totalBackendErrors++;
            throw new PostgresLockBackendError("fencing");
          }
          const acquiredAt = new Date();
          const handle = this._buildHandle({
            advisoryKey,
            client,
            lockKey,
            fencingToken: `fence_postgres_${rawFence}`,
            acquiredAt,
            expiresAt: new Date(acquiredAt.getTime() + ttlMs),
            ttlMs
          });
          client = null;
          this._metrics.totalAcquired++;
          this._metrics.currentActive++;
          return handle;
        }

        releasePoolClient(client, false);
        client = null;
        destroyClient = false;
        if (Date.now() >= deadline) {
          this._metrics.totalTimedOut++;
          throw new LockTimeoutError(lockKey, waitMs);
        }
        await this._waitForRetry(
          Math.min(this.retryIntervalMs, Math.max(1, deadline - Date.now())),
          options.signal,
          lockKey
        );
      }
    } finally {
      this._metrics.currentWaiting = Math.max(0, this._metrics.currentWaiting - 1);
      const remainingForKey = Math.max(0, (this._waitingByKey.get(lockKey) || 1) - 1);
      if (remainingForKey === 0) this._waitingByKey.delete(lockKey);
      else this._waitingByKey.set(lockKey, remainingForKey);
      if (client) releasePoolClient(client, destroyClient);
    }
  }

  async release(handle) {
    if (!handle || handle.released) return;
    const entry = this._entries.get(handle.lockKey);
    if (!entry) {
      handle.released = true;
      return;
    }
    if (entry.handle.fencingToken !== handle.fencingToken) {
      throw new LockFencingError(handle.lockKey, handle.fencingToken);
    }
    if (!entry.closing) {
      entry.closing = this._beginEntryClose(
        entry,
        handle.expiresAt.getTime() <= Date.now() ? "expired" : "released",
        true
      );
    }
    return entry.closing;
  }

  async isLocked(key) {
    this._assertActive();
    const lockKey = normalizeLockKey(key);
    if (this._entries.has(lockKey)) return true;

    const advisoryKey = postgresAdvisoryKey(lockKey, this.namespace);
    const deadline = Date.now() + this.config.maxWaitMs;
    let client = null;
    let destroyClient = false;
    try {
      const attemptDeadline = Math.min(deadline, Date.now() + this.queryTimeoutMs);
      client = await this._connectBefore(attemptDeadline);
      const result = await this._queryBefore(client, TRY_LOCK_SQL, advisoryKey, attemptDeadline);
      const acquired = result.rows?.[0]?.acquired === true;
      if (!acquired) return true;
      const unlock = await this._queryBefore(
        client,
        UNLOCK_SQL,
        advisoryKey,
        Date.now() + this.queryTimeoutMs
      );
      if (unlock.rows?.[0]?.unlocked !== true) {
        destroyClient = true;
        this._metrics.totalBackendErrors++;
        throw new PostgresLockBackendError("inspect-unlock");
      }
      return false;
    } catch (error) {
      if (error instanceof LockManagerDestroyedError) throw error;
      if (error instanceof PostgresLockBackendError) throw error;
      this._metrics.totalBackendErrors++;
      destroyClient = true;
      throw new PostgresLockBackendError("inspect");
    } finally {
      if (client) releasePoolClient(client, destroyClient);
    }
  }

  destroy() {
    if (this._destroyPromise) return this._destroyPromise;
    this._destroyed = true;
    this._destroyController.abort();
    this._destroyPromise = this._finishDestroy();
    return this._destroyPromise;
  }

  async _finishDestroy() {
    await Promise.allSettled([...this._pendingAcquires]);
    await Promise.all([...this._entries.values()].map((entry) => {
      if (!entry.closing) entry.closing = this._beginEntryClose(entry, "released", false);
      return entry.closing;
    }));
    if (this._ownsPool) {
      try {
        await this._poolEndBefore();
        this._detachPoolErrorListener();
      } catch {
        this._metrics.totalBackendErrors++;
        throw new PostgresLockBackendError("destroy");
      }
    } else {
      this._detachPoolErrorListener();
    }
  }

  _detachPoolErrorListener() {
    if (!this._poolErrorListenerAttached) return;
    this._poolErrorListenerAttached = false;
    if (typeof this.pool.off === "function") {
      this.pool.off("error", this._poolErrorListener);
    } else {
      this.pool.removeListener("error", this._poolErrorListener);
    }
  }

  _buildHandle({ advisoryKey, client, lockKey, fencingToken, acquiredAt, expiresAt, ttlMs }) {
    const handle = {
      lockKey,
      fencingToken,
      acquiredAt,
      expiresAt,
      released: false,
      release: async () => this.release(handle),
      heartbeat: async (extendMs = this.config.defaultTtlMs) => this._heartbeatEntry(entry, extendMs)
    };
    const entry = {
      advisoryKey,
      client,
      closing: null,
      finalized: false,
      handle,
      heartbeatTask: null,
      pendingHeartbeatTtlMs: 0,
      timer: null,
      onClientError: null
    };
    entry.onClientError = () => {
      this._metrics.totalBackendErrors++;
      this._finalizeEntry(entry, "expired", true);
    };
    client.on?.("error", entry.onClientError);
    this._entries.set(lockKey, entry);
    this._resetExpiryTimer(entry, ttlMs);
    return handle;
  }

  async _heartbeatEntry(entry, extendMs) {
    const { handle } = entry;
    if (handle.released) throw new LockReleasedError(handle.lockKey);
    if (
      this._entries.get(handle.lockKey) !== entry ||
      entry.finalized ||
      entry.closing
    ) {
      handle.released = true;
      throw new LockReleasedError(handle.lockKey);
    }
    const heartbeatTtlMs = positiveDuration(
      extendMs,
      this.config.defaultTtlMs,
      "extendMs"
    );
    entry.pendingHeartbeatTtlMs = Math.max(entry.pendingHeartbeatTtlMs, heartbeatTtlMs);
    if (entry.heartbeatTask) return entry.heartbeatTask;
    if (handle.expiresAt.getTime() <= Date.now()) {
      entry.closing = this._unlockEntry(entry, "expired", false);
      await entry.closing;
      throw new LockReleasedError(handle.lockKey);
    }

    const heartbeatTask = (async () => {
      try {
        await this._queryBefore(
          entry.client,
          HEARTBEAT_SQL,
          [],
          Math.min(handle.expiresAt.getTime(), Date.now() + this.queryTimeoutMs),
          { ignoreDestroy: true }
        );
      } catch {
        this._metrics.totalBackendErrors++;
        this._finalizeEntry(entry, "expired", true);
        throw new PostgresLockBackendError("heartbeat");
      }
      if (entry.finalized || entry.closing) throw new LockReleasedError(handle.lockKey);
      if (handle.expiresAt.getTime() <= Date.now()) {
        entry.closing = this._unlockEntry(entry, "expired", false);
        await entry.closing;
        throw new LockReleasedError(handle.lockKey);
      }
      const extensionMs = entry.pendingHeartbeatTtlMs;
      handle.expiresAt = new Date(Date.now() + extensionMs);
      this._resetExpiryTimer(entry, extensionMs);
    })();
    entry.heartbeatTask = heartbeatTask;
    try {
      return await heartbeatTask;
    } finally {
      if (entry.heartbeatTask === heartbeatTask) {
        entry.heartbeatTask = null;
        entry.pendingHeartbeatTtlMs = 0;
      }
    }
  }

  _resetExpiryTimer(entry, ttlMs) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (!entry.closing) entry.closing = this._beginEntryClose(entry, "expired", false);
      void entry.closing;
    }, ttlMs);
    if (entry.timer.unref) entry.timer.unref();
  }

  async _beginEntryClose(entry, outcome, surfaceFailure) {
    const heartbeatTask = entry.heartbeatTask;
    if (heartbeatTask) await heartbeatTask.catch(() => {});
    if (entry.finalized) return;
    return this._unlockEntry(entry, outcome, surfaceFailure);
  }

  async _unlockEntry(entry, outcome, surfaceFailure) {
    if (entry.finalized) return;
    let destroyClient = false;
    let failed = false;
    try {
      const result = await this._queryBefore(
        entry.client,
        UNLOCK_SQL,
        entry.advisoryKey,
        Date.now() + this.queryTimeoutMs,
        { ignoreDestroy: this._destroyed }
      );
      if (result.rows?.[0]?.unlocked !== true) failed = true;
    } catch {
      failed = true;
      destroyClient = true;
    }
    if (failed) this._metrics.totalBackendErrors++;
    this._finalizeEntry(entry, outcome, destroyClient);
    if (failed && surfaceFailure) throw new PostgresLockBackendError("release");
  }

  _finalizeEntry(entry, outcome, destroyClient) {
    if (entry.finalized) return;
    entry.finalized = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.client.off?.("error", entry.onClientError);
    if (this._entries.get(entry.handle.lockKey) === entry) {
      this._entries.delete(entry.handle.lockKey);
    }
    entry.handle.released = true;
    this._metrics.currentActive = Math.max(0, this._metrics.currentActive - 1);
    if (outcome === "released") this._metrics.totalReleased++;
    else this._metrics.totalExpired++;
    releasePoolClient(entry.client, destroyClient);
  }

  async _connectBefore(deadline, signal = null, lockKey = "") {
    throwIfAcquireAborted(signal, lockKey);
    const pending = Promise.resolve().then(() => this.pool.connect());
    const remaining = Math.max(0, deadline - Date.now());
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new PoolWaitTimeoutError()), remaining);
    });
    const destroyRace = createSignalRace(
      this._destroyController.signal,
      () => new LockManagerDestroyedError(this.config.backend)
    );
    const abortRace = createAbortRace(signal, lockKey);
    try {
      return await Promise.race([
        pending,
        timeoutPromise,
        destroyRace.promise,
        ...(abortRace ? [abortRace.promise] : [])
      ]);
    } catch (error) {
      if (
        error instanceof PoolWaitTimeoutError ||
        error instanceof LockManagerDestroyedError ||
        error instanceof LockAcquireAbortedError
      ) {
        void pending.then((client) => releasePoolClient(client, false), () => undefined);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      destroyRace.cleanup();
      abortRace?.cleanup();
    }
  }

  async _queryBefore(
    client,
    text,
    values,
    deadline,
    { ignoreDestroy = false, signal = null, lockKey = "" } = {}
  ) {
    if (this._destroyed && !ignoreDestroy) {
      throw new LockManagerDestroyedError(this.config.backend);
    }
    throwIfAcquireAborted(signal, lockKey);
    const pending = Promise.resolve().then(() => client.query(text, values));
    const remaining = Math.max(0, deadline - Date.now());
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new BackendQueryTimeoutError()), remaining);
    });
    const destroyRace = ignoreDestroy
      ? null
      : createSignalRace(
          this._destroyController.signal,
          () => new LockManagerDestroyedError(this.config.backend)
        );
    const abortRace = createAbortRace(signal, lockKey);
    try {
      return await Promise.race([
        pending,
        timeoutPromise,
        ...(destroyRace ? [destroyRace.promise] : []),
        ...(abortRace ? [abortRace.promise] : [])
      ]);
    } catch (error) {
      if (
        error instanceof BackendQueryTimeoutError ||
        error instanceof LockManagerDestroyedError ||
        error instanceof LockAcquireAbortedError
      ) {
        void pending.catch(() => undefined);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      destroyRace?.cleanup();
      abortRace?.cleanup();
    }
  }

  async _waitForRetry(ms, signal = null, lockKey = "") {
    throwIfAcquireAborted(signal, lockKey);
    const abortRace = createAbortRace(signal, lockKey);
    const destroyRace = createSignalRace(
      this._destroyController.signal,
      () => new LockManagerDestroyedError(this.config.backend)
    );
    const retryTimer = createTimerRace(ms);
    try {
      await Promise.race([
        retryTimer.promise,
        destroyRace.promise,
        ...(abortRace ? [abortRace.promise] : [])
      ]);
    } finally {
      retryTimer.cleanup();
      destroyRace.cleanup();
      abortRace?.cleanup();
    }
  }

  async _poolEndBefore() {
    const pending = Promise.resolve().then(() => this.pool.end());
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new BackendQueryTimeoutError()), this.queryTimeoutMs);
    });
    try {
      return await Promise.race([pending, timeoutPromise]);
    } catch (error) {
      if (error instanceof BackendQueryTimeoutError) {
        void pending.then(
          () => this._detachPoolErrorListener(),
          () => this._detachPoolErrorListener()
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  _assertActive() {
    if (this._destroyed) throw new LockManagerDestroyedError(this.config.backend);
  }
}

function releasePoolClient(client, destroy) {
  try {
    client.release?.(Boolean(destroy));
  } catch {
    // The pool may already have discarded a disconnected client.
  }
}

function normalizeLockKey(key, label = "Lock key") {
  const normalized = String(key ?? "").trim();
  if (!normalized) throw new TypeError(`${label} must be a non-empty string.`);
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

function createTimerRace(ms) {
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return {
    promise,
    cleanup() {
      if (timer) clearTimeout(timer);
    }
  };
}

function createAbortRace(signal, key) {
  return createSignalRace(signal, () => new LockAcquireAbortedError(key));
}

function createSignalRace(signal, errorFactory) {
  if (!signal?.addEventListener) return null;
  let onAbort;
  const promise = new Promise((_, reject) => {
    onAbort = () => reject(errorFactory());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return {
    promise,
    cleanup() {
      signal.removeEventListener?.("abort", onAbort);
    }
  };
}
