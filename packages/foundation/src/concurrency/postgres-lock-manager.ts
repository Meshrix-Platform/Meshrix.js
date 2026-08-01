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
} from "./lock-manager.ts";

const { Pool } = pg;

const ACQUIRE_SQL: any = `
WITH lock_attempt AS MATERIALIZED (
  SELECT pg_try_advisory_lock($1, $2) AS acquired
)
SELECT
  acquired,
  CASE WHEN acquired THEN pg_current_xact_id()::text ELSE NULL END AS fencing_token
FROM lock_attempt
`;

const TRY_LOCK_SQL: any = "SELECT pg_try_advisory_lock($1, $2) AS acquired";
const UNLOCK_SQL: any = "SELECT pg_advisory_unlock($1, $2) AS unlocked";
const HEARTBEAT_SQL: any = "SELECT 1 AS alive";

class PoolWaitTimeoutError extends Error {}
class BackendQueryTimeoutError extends Error {}

export class PostgresLockBackendError extends Error {
  name: any;
  operation: any;
  constructor(operation?: any) {
    super(`PostgreSQL lock backend failed during ${operation}.`);
    this.name = "PostgresLockBackendError";
    this.operation = operation;
  }
}

/**
 * Map an arbitrary application key into PostgreSQL's two-int32 advisory space.
 * The namespace prevents unrelated framework instances from sharing a keyspace.
 */
export function postgresAdvisoryKey(key?: any, namespace: any = "meshrix") : any {
  const lockKey: any = normalizeLockKey(key);
  const lockNamespace: any = normalizeLockKey(namespace, "Lock namespace");
  const digest: any = crypto
    .createHash("sha256")
    .update(lockNamespace)
    .update("\0")
    .update(lockKey)
    .digest();
  return Object.freeze([digest.readInt32BE(0), digest.readInt32BE(4)]);
}

export class PostgresLockManager extends LockManager {
  _destroyController: any;
  _destroyPromise: any;
  _destroyed: any;
  _entries: any;
  _ownsPool: any;
  _pendingAcquires: any;
  _poolErrorListener: any;
  _poolErrorListenerAttached: any;
  _waitingByKey: any;
  namespace: any;
  pool: any;
  queryTimeoutMs: any;
  retryIntervalMs: any;
  /**
   * @param {object} config
   * @param {object} [config.pool] - Injected node-postgres Pool-compatible object.
   * @param {object} [config.pgConfig] - Options passed to a manager-owned Pool.
   * @param {string} [config.connectionString] - Manager-owned Pool connection URI.
   * @param {string} [config.namespace=meshrix] - Advisory lock key namespace.
   * @param {number} [config.retryIntervalMs=50] - Non-blocking retry cadence.
   */
  constructor(config: Record<string, any> = {}) {
    super({ ...config, backend: "postgres" });
    this.namespace = normalizeLockKey(config.namespace ?? "meshrix", "Lock namespace");
    this.retryIntervalMs = positiveDuration(config.retryIntervalMs, 50, "retryIntervalMs");
    this.queryTimeoutMs = positiveDuration(config.queryTimeoutMs, 5000, "queryTimeoutMs");
    this._entries = new Map<any, any>();
    this._pendingAcquires = new Set<any>();
    this._waitingByKey = new Map<any, any>();
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
      const pgConfig: any = config.pgConfig
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
    this._poolErrorListener = () : any => {
      this._metrics.totalBackendErrors++;
    };
    this.pool.on("error", this._poolErrorListener);
    this._poolErrorListenerAttached = true;
  }

  async acquire(key?: any, options: Record<string, any> = {}) : Promise<any> {
    this._assertActive();
    const pending: any = this._acquire(key, options);
    this._pendingAcquires.add(pending);
    try {
      return await pending;
    } finally {
      this._pendingAcquires.delete(pending);
    }
  }

  async _acquire(key?: any, options: Record<string, any> = {}) : Promise<any> {
    this._assertActive();
    const lockKey: any = normalizeLockKey(key);
    throwIfAcquireAborted(options.signal, lockKey);
    const ttlMs: any = positiveDuration(options.ttlMs, this.config.defaultTtlMs, "ttlMs");
    const waitMs: any = nonNegativeDuration(options.waitMs, this.config.maxWaitMs, "waitMs");
    const waitingForKey: any = this._waitingByKey.get(lockKey) || 0;
    if (waitingForKey >= this.config.maxQueueDepth) {
      throw new LockQueueFullError(lockKey, this.config.maxQueueDepth);
    }
    this._waitingByKey.set(lockKey, waitingForKey + 1);

    const advisoryKey: any = postgresAdvisoryKey(lockKey, this.namespace);
    const deadline: any = Date.now() + waitMs;
    let client: any = null;
    let destroyClient: any = false;
    this._metrics.currentWaiting++;
    try {
      while (true) {
        const attemptDeadline: any = waitMs === 0
          ? Date.now() + this.queryTimeoutMs
          : Math.min(deadline, Date.now() + this.queryTimeoutMs);
        try {
          client = await this._connectBefore(attemptDeadline, options.signal, lockKey);
        } catch (error: any) {
          if (error instanceof LockManagerDestroyedError) throw error;
          if (error instanceof LockAcquireAbortedError) throw error;
          if (error instanceof PoolWaitTimeoutError) {
            this._metrics.totalTimedOut++;
            throw new LockTimeoutError(lockKey, waitMs);
          }
          this._metrics.totalBackendErrors++;
          throw new PostgresLockBackendError("connect");
        }

        let row: any;
        try {
          const result: any = await this._queryBefore(
            client,
            ACQUIRE_SQL,
            advisoryKey,
            attemptDeadline,
            { signal: options.signal, lockKey }
          );
          row = result.rows?.[0] || {};
        } catch (error: any) {
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
          const rawFence: any = String(row.fencing_token || "").trim();
          if (!rawFence) {
            destroyClient = true;
            this._metrics.totalBackendErrors++;
            throw new PostgresLockBackendError("fencing");
          }
          const acquiredAt: any = new Date();
          const handle: any = this._buildHandle({
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
      const remainingForKey: any = Math.max(0, (this._waitingByKey.get(lockKey) || 1) - 1);
      if (remainingForKey === 0) this._waitingByKey.delete(lockKey);
      else this._waitingByKey.set(lockKey, remainingForKey);
      if (client) releasePoolClient(client, destroyClient);
    }
  }

  async release(handle?: any) : Promise<any> {
    if (!handle || handle.released) return;
    const entry: any = this._entries.get(handle.lockKey);
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

  async isLocked(key?: any) : Promise<any> {
    this._assertActive();
    const lockKey: any = normalizeLockKey(key);
    if (this._entries.has(lockKey)) return true;

    const advisoryKey: any = postgresAdvisoryKey(lockKey, this.namespace);
    const deadline: any = Date.now() + this.config.maxWaitMs;
    let client: any = null;
    let destroyClient: any = false;
    try {
      const attemptDeadline: any = Math.min(deadline, Date.now() + this.queryTimeoutMs);
      client = await this._connectBefore(attemptDeadline);
      const result: any = await this._queryBefore(client, TRY_LOCK_SQL, advisoryKey, attemptDeadline);
      const acquired: any = result.rows?.[0]?.acquired === true;
      if (!acquired) return true;
      const unlock: any = await this._queryBefore(
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
    } catch (error: any) {
      if (error instanceof LockManagerDestroyedError) throw error;
      if (error instanceof PostgresLockBackendError) throw error;
      this._metrics.totalBackendErrors++;
      destroyClient = true;
      throw new PostgresLockBackendError("inspect");
    } finally {
      if (client) releasePoolClient(client, destroyClient);
    }
  }

  destroy() : any {
    if (this._destroyPromise) return this._destroyPromise;
    this._destroyed = true;
    this._destroyController.abort();
    this._destroyPromise = this._finishDestroy();
    return this._destroyPromise;
  }

  async _finishDestroy() : Promise<any> {
    await Promise.allSettled([...this._pendingAcquires]);
    await Promise.all([...this._entries.values()].map((entry?: any) : any => {
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

  _detachPoolErrorListener() : any {
    if (!this._poolErrorListenerAttached) return;
    this._poolErrorListenerAttached = false;
    if (typeof this.pool.off === "function") {
      this.pool.off("error", this._poolErrorListener);
    } else {
      this.pool.removeListener("error", this._poolErrorListener);
    }
  }

  _buildHandle({ advisoryKey, client, lockKey, fencingToken, acquiredAt, expiresAt, ttlMs }: Record<string, any>) : any {
    const handle: Record<string, any> = {
      lockKey,
      fencingToken,
      acquiredAt,
      expiresAt,
      released: false,
      release: async () : Promise<any> => this.release(handle),
      heartbeat: async (extendMs: any = this.config.defaultTtlMs) : Promise<any> => this._heartbeatEntry(entry, extendMs)
    };
    const entry: Record<string, any> = {
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
    entry.onClientError = () : any => {
      this._metrics.totalBackendErrors++;
      this._finalizeEntry(entry, "expired", true);
    };
    client.on?.("error", entry.onClientError);
    this._entries.set(lockKey, entry);
    this._resetExpiryTimer(entry, ttlMs);
    return handle;
  }

  async _heartbeatEntry(entry?: any, extendMs?: any) : Promise<any> {
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
    const heartbeatTtlMs: any = positiveDuration(
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

    const heartbeatTask: any = (async () : Promise<any> => {
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
      const extensionMs: any = entry.pendingHeartbeatTtlMs;
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

  _resetExpiryTimer(entry?: any, ttlMs?: any) : any {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() : any => {
      if (!entry.closing) entry.closing = this._beginEntryClose(entry, "expired", false);
      void entry.closing;
    }, ttlMs);
    if (entry.timer.unref) entry.timer.unref();
  }

  async _beginEntryClose(entry?: any, outcome?: any, surfaceFailure?: any) : Promise<any> {
    const heartbeatTask: any = entry.heartbeatTask;
    if (heartbeatTask) await heartbeatTask.catch(() : any => {});
    if (entry.finalized) return;
    return this._unlockEntry(entry, outcome, surfaceFailure);
  }

  async _unlockEntry(entry?: any, outcome?: any, surfaceFailure?: any) : Promise<any> {
    if (entry.finalized) return;
    let destroyClient: any = false;
    let failed: any = false;
    try {
      const result: any = await this._queryBefore(
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

  _finalizeEntry(entry?: any, outcome?: any, destroyClient?: any) : any {
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

  async _connectBefore(deadline?: any, signal: any = null, lockKey: any = "") : Promise<any> {
    throwIfAcquireAborted(signal, lockKey);
    const pending: any = Promise.resolve().then(() : any => this.pool.connect());
    const remaining: any = Math.max(0, deadline - Date.now());
    let timeout: any;
    const timeoutPromise: any = new Promise((_?: any, reject?: any) : any => {
      timeout = setTimeout(() : any => reject(new PoolWaitTimeoutError()), remaining);
    });
    const destroyRace: any = createSignalRace(
      this._destroyController.signal,
      () : any => new LockManagerDestroyedError(this.config.backend)
    );
    const abortRace: any = createAbortRace(signal, lockKey);
    try {
      return await Promise.race([
        pending,
        timeoutPromise,
        destroyRace.promise,
        ...(abortRace ? [abortRace.promise] : [])
      ]);
    } catch (error: any) {
      if (
        error instanceof PoolWaitTimeoutError ||
        error instanceof LockManagerDestroyedError ||
        error instanceof LockAcquireAbortedError
      ) {
        void pending.then((client?: any) : any => releasePoolClient(client, false), () : any => undefined);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      destroyRace.cleanup();
      abortRace?.cleanup();
    }
  }

  async _queryBefore(
    client?: any,
    text?: any,
    values?: any,
    deadline?: any,
    { ignoreDestroy = false, signal = null, lockKey = "" }: Record<string, any> = {}
  ) : Promise<any> {
    if (this._destroyed && !ignoreDestroy) {
      throw new LockManagerDestroyedError(this.config.backend);
    }
    throwIfAcquireAborted(signal, lockKey);
    const pending: any = Promise.resolve().then(() : any => client.query(text, values));
    const remaining: any = Math.max(0, deadline - Date.now());
    let timeout: any;
    const timeoutPromise: any = new Promise((_?: any, reject?: any) : any => {
      timeout = setTimeout(() : any => reject(new BackendQueryTimeoutError()), remaining);
    });
    const destroyRace: any = ignoreDestroy
      ? null
      : createSignalRace(
          this._destroyController.signal,
          () : any => new LockManagerDestroyedError(this.config.backend)
        );
    const abortRace: any = createAbortRace(signal, lockKey);
    try {
      return await Promise.race([
        pending,
        timeoutPromise,
        ...(destroyRace ? [destroyRace.promise] : []),
        ...(abortRace ? [abortRace.promise] : [])
      ]);
    } catch (error: any) {
      if (
        error instanceof BackendQueryTimeoutError ||
        error instanceof LockManagerDestroyedError ||
        error instanceof LockAcquireAbortedError
      ) {
        void pending.catch(() : any => undefined);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      destroyRace?.cleanup();
      abortRace?.cleanup();
    }
  }

  async _waitForRetry(ms?: any, signal: any = null, lockKey: any = "") : Promise<any> {
    throwIfAcquireAborted(signal, lockKey);
    const abortRace: any = createAbortRace(signal, lockKey);
    const destroyRace: any = createSignalRace(
      this._destroyController.signal,
      () : any => new LockManagerDestroyedError(this.config.backend)
    );
    const retryTimer: any = createTimerRace(ms);
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

  async _poolEndBefore() : Promise<any> {
    const pending: any = Promise.resolve().then(() : any => this.pool.end());
    let timeout: any;
    const timeoutPromise: any = new Promise((_?: any, reject?: any) : any => {
      timeout = setTimeout(() : any => reject(new BackendQueryTimeoutError()), this.queryTimeoutMs);
    });
    try {
      return await Promise.race([pending, timeoutPromise]);
    } catch (error: any) {
      if (error instanceof BackendQueryTimeoutError) {
        void pending.then(
          () : any => this._detachPoolErrorListener(),
          () : any => this._detachPoolErrorListener()
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  _assertActive() : any {
    if (this._destroyed) throw new LockManagerDestroyedError(this.config.backend);
  }
}

function releasePoolClient(client?: any, destroy?: any) : any {
  try {
    client.release?.(Boolean(destroy));
  } catch {
    // The pool may already have discarded a disconnected client.
  }
}

function normalizeLockKey(key?: any, label: any = "Lock key") : any {
  const normalized: any = String(key ?? "").trim();
  if (!normalized) throw new TypeError(`${label} must be a non-empty string.`);
  return normalized;
}

function positiveDuration(value?: any, fallback?: any, label?: any) : any {
  const normalized: any = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a positive finite number.`);
  }
  return normalized;
}

function nonNegativeDuration(value?: any, fallback?: any, label?: any) : any {
  const normalized: any = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new TypeError(`${label} must be a non-negative finite number.`);
  }
  return normalized;
}

function throwIfAcquireAborted(signal?: any, key?: any) : any {
  if (signal?.aborted) throw new LockAcquireAbortedError(key);
}

function createTimerRace(ms?: any) : any {
  let timer: any = null;
  const promise: any = new Promise((resolve?: any) : any => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return {
    promise,
    cleanup() : any {
      if (timer) clearTimeout(timer);
    }
  };
}

function createAbortRace(signal?: any, key?: any) : any {
  return createSignalRace(signal, () : any => new LockAcquireAbortedError(key));
}

function createSignalRace(signal?: any, errorFactory?: any) : any {
  if (!signal?.addEventListener) return null;
  let onAbort: any;
  const promise: any = new Promise((_?: any, reject?: any) : any => {
    onAbort = () : any => reject(errorFactory());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return {
    promise,
    cleanup() : any {
      signal.removeEventListener?.("abort", onAbort);
    }
  };
}
