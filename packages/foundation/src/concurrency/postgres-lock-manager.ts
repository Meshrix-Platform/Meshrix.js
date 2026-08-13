/**
 * PostgreSQL database-time lease lock manager.
 *
 * Each operation uses a short checked-out client. Lease ownership and expiry
 * live in one row whose timestamps and monotonically increasing fence are
 * assigned by PostgreSQL, so no process clock or session lifetime is authority.
 *
 * @module foundation/concurrency/postgres-lock-manager
 */

import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  LockAcquireAbortedError,
  LockFencingError,
  LockManager,
  LockManagerDestroyedError,
  LockQueueFullError,
  LockReleasedError,
  LockTimeoutError,
  DeadlineScheduler,
  IntrusiveWaitQueue
} from "./lock-manager-contract.ts";

const { Pool } = pg;

const SCHEMA_SQL: any = `
CREATE SEQUENCE IF NOT EXISTS _meshrix_lock_fence_sequence AS BIGINT;
CREATE TABLE IF NOT EXISTS _meshrix_lock_leases (
  namespace TEXT NOT NULL,
  lock_key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (namespace, lock_key)
);
CREATE INDEX IF NOT EXISTS idx_meshrix_lock_leases_expires
  ON _meshrix_lock_leases (expires_at);
`;

const ACQUIRE_SQL: any = `
WITH database_time AS MATERIALIZED (
  SELECT clock_timestamp() AS now_at
), acquired AS (
  INSERT INTO _meshrix_lock_leases (
    namespace, lock_key, owner_id, fencing_token, acquired_at, expires_at, heartbeat_at
  )
  SELECT $1, $2, $3, nextval('_meshrix_lock_fence_sequence'), now_at,
         now_at + ($4::double precision * interval '1 millisecond'), now_at
  FROM database_time
  ON CONFLICT (namespace, lock_key) DO UPDATE SET
    owner_id = EXCLUDED.owner_id,
    fencing_token = nextval('_meshrix_lock_fence_sequence'),
    acquired_at = EXCLUDED.acquired_at,
    expires_at = EXCLUDED.expires_at,
    heartbeat_at = EXCLUDED.heartbeat_at
  WHERE _meshrix_lock_leases.expires_at <= (SELECT now_at FROM database_time)
  RETURNING owner_id, fencing_token::text, acquired_at, expires_at
)
SELECT owner_id, fencing_token, acquired_at, expires_at,
       GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - clock_timestamp())) * 1000))::bigint AS lease_ms
FROM acquired
`;

const INSPECT_SQL: any = `
SELECT EXISTS (
  SELECT 1 FROM _meshrix_lock_leases
  WHERE namespace = $1 AND lock_key = $2 AND expires_at > clock_timestamp()
) AS locked
`;

const RELEASE_SQL: any = `
DELETE FROM _meshrix_lock_leases
WHERE namespace = $1 AND lock_key = $2 AND owner_id = $3
  AND fencing_token = $4::bigint AND expires_at > clock_timestamp()
RETURNING fencing_token::text
`;

const EXPIRE_SQL: any = `
DELETE FROM _meshrix_lock_leases
WHERE namespace = $1 AND lock_key = $2 AND owner_id = $3
  AND fencing_token = $4::bigint AND expires_at <= clock_timestamp()
RETURNING fencing_token::text
`;

const HEARTBEAT_SQL: any = `
WITH database_time AS MATERIALIZED (
  SELECT clock_timestamp() AS now_at
)
UPDATE _meshrix_lock_leases SET
  heartbeat_at = (SELECT now_at FROM database_time),
  expires_at = (SELECT now_at FROM database_time) + ($5::double precision * interval '1 millisecond')
WHERE namespace = $1 AND lock_key = $2 AND owner_id = $3
  AND fencing_token = $4::bigint
  AND expires_at > (SELECT now_at FROM database_time)
RETURNING expires_at,
  GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - clock_timestamp())) * 1000))::bigint AS lease_ms
`;

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

export class PostgresLockManager extends LockManager {
  _activePoolCredits: any;
  _clientCredits: any;
  _destroyController: any;
  _destroyPromise: any;
  _destroyed: any;
  _entries: any;
  _ownsPool: any;
  _pendingAcquires: any;
  _poolErrorListener: any;
  _poolErrorListenerAttached: any;
  _localQueues: any;
  _poolCreditQueue: any;
  _schemaReady: any;
  _scheduler: any;
  namespace: any;
  pool: any;
  queryTimeoutMs: any;
  maxPoolCredits: any;
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
    this.maxPoolCredits = positiveInteger(
      config.maxPoolCredits,
      Number(config.pool?.options?.max) || 16,
      "maxPoolCredits"
    );
    this._entries = new Map<any, any>();
    this._pendingAcquires = new Set<any>();
    this._localQueues = new Map<any, any>();
    this._poolCreditQueue = new IntrusiveWaitQueue();
    this._activePoolCredits = 0;
    this._clientCredits = new WeakMap<any, any>();
    this._schemaReady = null;
    this._scheduler = new DeadlineScheduler();
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
    const waitMs: any = nonNegativeDuration(options.waitMs, this.config.maxWaitMs, "waitMs");
    const localQueue: any = this._localQueues.get(lockKey);
    if (localQueue?.size >= this.config.maxQueueDepth) {
      throw new LockQueueFullError(lockKey, this.config.maxQueueDepth);
    }
    if (this._metrics.currentWaiting >= this.config.maxTotalQueueDepth) {
      throw new LockQueueFullError(lockKey, this.config.maxTotalQueueDepth);
    }
    const deadline: any = Date.now() + waitMs;
    this._metrics.currentWaiting++;
    let turn: any = null;
    try {
      turn = await this._waitForLocalTurn(lockKey, deadline, options.signal, waitMs);
      return await this._acquireLeader(lockKey, {
        ...options,
        waitMs: Math.max(0, deadline - Date.now())
      });
    } finally {
      if (turn) this._releaseLocalTurn(lockKey, turn);
      this._metrics.currentWaiting = Math.max(0, this._metrics.currentWaiting - 1);
    }
  }

  async _acquireLeader(lockKey?: any, options: Record<string, any> = {}) : Promise<any> {
    this._assertActive();
    throwIfAcquireAborted(options.signal, lockKey);
    const ttlMs: any = positiveDuration(options.ttlMs, this.config.defaultTtlMs, "ttlMs");
    const waitMs: any = nonNegativeDuration(options.waitMs, this.config.maxWaitMs, "waitMs");

    const deadline: any = Date.now() + waitMs;
    let client: any = null;
    let destroyClient: any = false;
    try {
      while (true) {
        const ownerId: any = randomUUID();
        const attemptDeadline: any = waitMs === 0
          ? Date.now() + this.queryTimeoutMs
          : Math.min(deadline, Date.now() + this.queryTimeoutMs);
        try {
          client = await this._connectBefore(attemptDeadline, options.signal, lockKey);
          await this._ensureSchema(client, attemptDeadline, options.signal, lockKey);
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
            [this.namespace, lockKey, ownerId, ttlMs],
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

        if (row.fencing_token) {
          const rawFence: any = String(row.fencing_token).trim();
          if (!rawFence) {
            destroyClient = true;
            this._metrics.totalBackendErrors++;
            throw new PostgresLockBackendError("fencing");
          }
          const acquiredAt: any = new Date(row.acquired_at);
          const expiresAt: any = new Date(row.expires_at);
          const leaseMs: any = positiveDuration(Number(row.lease_ms), ttlMs, "leaseMs");
          this._releaseClient(client, false);
          client = null;
          const handle: any = this._buildHandle({
            lockKey,
            ownerId,
            fencingToken: `fence_postgres_${rawFence}`,
            rawFence,
            acquiredAt,
            expiresAt,
            ttlMs: leaseMs
          });
          this._metrics.totalAcquired++;
          this._metrics.currentActive++;
          return handle;
        }

        this._releaseClient(client, false);
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
      if (client) this._releaseClient(client, destroyClient);
    }
  }

  _waitForLocalTurn(lockKey?: any, deadline?: any, signal?: any, waitMs?: any) : any {
    let queue: any = this._localQueues.get(lockKey);
    if (!queue) {
      queue = new IntrusiveWaitQueue();
      this._localQueues.set(lockKey, queue);
    }
    let resolve: any;
    let reject: any;
    const promise: any = new Promise((accepted?: any, rejected?: any) : any => {
      resolve = accepted;
      reject = rejected;
    });
    const node: any = {
      active: true,
      promoted: false,
      deadlineEntry: null,
      onAbort: null,
      resolve,
      reject,
      signal
    };
    queue.push(node);
    if (queue.head === node) {
      node.promoted = true;
      return Promise.resolve(node);
    }
    if (waitMs <= 0) {
      queue.remove(node);
      if (queue.size === 0) this._localQueues.delete(lockKey);
      return Promise.reject(new LockTimeoutError(lockKey, waitMs));
    }
    const rejectPending: any = (error?: any) : any => {
      if (!node.active) return;
      node.active = false;
      queue.remove(node);
      this._scheduler.cancel(node.deadlineEntry);
      node.signal?.removeEventListener?.("abort", node.onAbort);
      if (queue.size === 0) this._localQueues.delete(lockKey);
      reject(error);
    };
    node.onAbort = () : any => rejectPending(new LockAcquireAbortedError(lockKey));
    node.deadlineEntry = this._scheduler.schedule(deadline, () : any => {
      this._metrics.totalTimedOut++;
      rejectPending(new LockTimeoutError(lockKey, waitMs));
    });
    signal?.addEventListener?.("abort", node.onAbort, { once: true });
    if (signal?.aborted) node.onAbort();
    return promise;
  }

  _releaseLocalTurn(lockKey?: any, node?: any) : any {
    const queue: any = this._localQueues.get(lockKey);
    if (!queue || queue.head !== node) return;
    node.active = false;
    queue.remove(node);
    const next: any = queue.head;
    if (!next) {
      this._localQueues.delete(lockKey);
      return;
    }
    next.active = false;
    next.promoted = true;
    this._scheduler.cancel(next.deadlineEntry);
    next.signal?.removeEventListener?.("abort", next.onAbort);
    next.resolve(next);
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
      entry.closing = this._beginEntryClose(entry, "released", true);
    }
    return entry.closing;
  }

  async isLocked(key?: any) : Promise<any> {
    this._assertActive();
    const lockKey: any = normalizeLockKey(key);
    if (this._entries.has(lockKey)) return true;

    const deadline: any = Date.now() + this.config.maxWaitMs;
    let client: any = null;
    let destroyClient: any = false;
    try {
      const attemptDeadline: any = Math.min(deadline, Date.now() + this.queryTimeoutMs);
      client = await this._connectBefore(attemptDeadline);
      await this._ensureSchema(client, attemptDeadline);
      const result: any = await this._queryBefore(
        client,
        INSPECT_SQL,
        [this.namespace, lockKey],
        attemptDeadline
      );
      return result.rows?.[0]?.locked === true;
    } catch (error: any) {
      if (error instanceof LockManagerDestroyedError) throw error;
      if (error instanceof PostgresLockBackendError) throw error;
      this._metrics.totalBackendErrors++;
      destroyClient = true;
      throw new PostgresLockBackendError("inspect");
    } finally {
      if (client) this._releaseClient(client, destroyClient);
    }
  }

  getMetrics() : any {
    return {
      ...super.getMetrics(),
      queueKeys: this._localQueues.size,
      waiterTimers: this._scheduler.activeTimerCount,
      activePoolCredits: this._activePoolCredits,
      waitingPoolCredits: this._poolCreditQueue.size,
      maxPoolCredits: this.maxPoolCredits
    };
  }

  destroy() : any {
    if (this._destroyPromise) return this._destroyPromise;
    this._destroyed = true;
    this._destroyController.abort();
    const destroyedError: any = new LockManagerDestroyedError(this.config.backend);
    for (const [lockKey, queue] of this._localQueues) {
      let node: any = queue.head;
      while (node) {
        const next: any = node.next;
        if (!node.promoted) {
          node.active = false;
          queue.remove(node);
          this._scheduler.cancel(node.deadlineEntry);
          node.signal?.removeEventListener?.("abort", node.onAbort);
          node.reject(destroyedError);
        }
        node = next;
      }
      if (queue.size === 0) this._localQueues.delete(lockKey);
    }
    while (this._poolCreditQueue.size > 0) {
      const node: any = this._poolCreditQueue.shift();
      node.active = false;
      this._scheduler.cancel(node.deadlineEntry);
      node.signal?.removeEventListener?.("abort", node.onAbort);
      node.reject(destroyedError);
    }
    this._scheduler.close();
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

  _buildHandle({ lockKey, ownerId, fencingToken, rawFence, acquiredAt, expiresAt, ttlMs }: Record<string, any>) : any {
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
      closing: null,
      finalized: false,
      handle,
      heartbeatTask: null,
      ownerId,
      pendingHeartbeatTtlMs: 0,
      rawFence,
      timer: null,
    };
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
    const heartbeatTask: any = (async () : Promise<any> => {
      try {
        const result: any = await this._leaseQuery(
          HEARTBEAT_SQL,
          [this.namespace, handle.lockKey, entry.ownerId, entry.rawFence, entry.pendingHeartbeatTtlMs],
          Date.now() + this.queryTimeoutMs,
          { ignoreDestroy: true }
        );
        const row: any = result.rows?.[0];
        if (!row) {
          this._finalizeEntry(entry, "expired");
          throw new LockReleasedError(handle.lockKey);
        }
        const leaseMs: any = positiveDuration(
          Number(row.lease_ms),
          entry.pendingHeartbeatTtlMs,
          "leaseMs"
        );
        handle.expiresAt = new Date(row.expires_at);
        this._resetExpiryTimer(entry, leaseMs);
      } catch {
        if (entry.finalized) throw new LockReleasedError(handle.lockKey);
        this._metrics.totalBackendErrors++;
        this._finalizeEntry(entry, "expired");
        throw new PostgresLockBackendError("heartbeat");
      }
      if (entry.finalized || entry.closing) throw new LockReleasedError(handle.lockKey);
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
    let failed: any = false;
    try {
      const sql: any = outcome === "expired" ? EXPIRE_SQL : RELEASE_SQL;
      const result: any = await this._leaseQuery(
        sql,
        [this.namespace, entry.handle.lockKey, entry.ownerId, entry.rawFence],
        Date.now() + this.queryTimeoutMs,
        { ignoreDestroy: this._destroyed }
      );
      if (!result.rows?.[0]?.fencing_token && outcome === "released") outcome = "expired";
    } catch {
      failed = true;
    }
    if (failed) this._metrics.totalBackendErrors++;
    this._finalizeEntry(entry, outcome);
    if (failed && surfaceFailure) throw new PostgresLockBackendError("release");
  }

  _finalizeEntry(entry?: any, outcome?: any) : any {
    if (entry.finalized) return;
    entry.finalized = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (this._entries.get(entry.handle.lockKey) === entry) {
      this._entries.delete(entry.handle.lockKey);
    }
    entry.handle.released = true;
    this._metrics.currentActive = Math.max(0, this._metrics.currentActive - 1);
    if (outcome === "released") this._metrics.totalReleased++;
    else this._metrics.totalExpired++;
  }

  async _ensureSchema(client?: any, deadline?: any, signal: any = null, lockKey: any = "") : Promise<any> {
    if (!this._schemaReady) {
      const initializing: any = this._queryBefore(
        client,
        SCHEMA_SQL,
        [],
        deadline,
        { signal, lockKey }
      ).then(() : any => undefined);
      const ready: any = initializing.catch((error?: any) : any => {
        if (this._schemaReady === ready) this._schemaReady = null;
        throw error;
      });
      this._schemaReady = ready;
    }
    return this._schemaReady;
  }

  async _leaseQuery(
    text?: any,
    values?: any,
    deadline: any = Date.now() + this.queryTimeoutMs,
    { ignoreDestroy = false, signal = null, lockKey = "" }: Record<string, any> = {}
  ) : Promise<any> {
    let client: any = null;
    let destroyClient: any = false;
    try {
      client = await this._connectBefore(deadline, signal, lockKey, { ignoreDestroy });
      await this._ensureSchema(client, deadline, signal, lockKey);
      return await this._queryBefore(client, text, values, deadline, {
        ignoreDestroy,
        signal,
        lockKey
      });
    } catch (error: any) {
      destroyClient = Boolean(client);
      throw error;
    } finally {
      if (client) this._releaseClient(client, destroyClient);
    }
  }

  _acquirePoolCredit(
    deadline?: any,
    signal: any = null,
    lockKey: any = "",
    { ignoreDestroy = false }: Record<string, any> = {}
  ) : any {
    throwIfAcquireAborted(signal, lockKey);
    if (this._destroyed && !ignoreDestroy) {
      return Promise.reject(new LockManagerDestroyedError(this.config.backend));
    }
    if (this._activePoolCredits < this.maxPoolCredits) {
      this._activePoolCredits += 1;
      return Promise.resolve({ released: false });
    }
    if (this._poolCreditQueue.size >= this.config.maxTotalQueueDepth) {
      return Promise.reject(new LockQueueFullError(lockKey, this.config.maxTotalQueueDepth));
    }
    return new Promise((resolve?: any, reject?: any) : any => {
      const node: any = {
        active: true,
        deadlineEntry: null,
        onAbort: null,
        reject,
        resolve,
        signal
      };
      const rejectPending: any = (error?: any) : any => {
        if (!node.active) return;
        node.active = false;
        this._poolCreditQueue.remove(node);
        this._scheduler.cancel(node.deadlineEntry);
        signal?.removeEventListener?.("abort", node.onAbort);
        reject(error);
      };
      node.onAbort = () : any => rejectPending(new LockAcquireAbortedError(lockKey));
      node.deadlineEntry = this._scheduler.schedule(deadline, () : any => {
        rejectPending(new PoolWaitTimeoutError());
      });
      this._poolCreditQueue.push(node);
      signal?.addEventListener?.("abort", node.onAbort, { once: true });
      if (signal?.aborted) node.onAbort();
    });
  }

  _releasePoolCredit(token?: any) : any {
    if (!token || token.released) return;
    token.released = true;
    this._activePoolCredits = Math.max(0, this._activePoolCredits - 1);
    while (this._poolCreditQueue.size > 0 && !this._destroyed) {
      const node: any = this._poolCreditQueue.shift();
      if (!node?.active) continue;
      node.active = false;
      this._scheduler.cancel(node.deadlineEntry);
      node.signal?.removeEventListener?.("abort", node.onAbort);
      this._activePoolCredits += 1;
      node.resolve({ released: false });
      break;
    }
  }

  _releaseClient(client?: any, destroy?: any) : any {
    const credit: any = this._clientCredits.get(client);
    this._clientCredits.delete(client);
    releasePoolClient(client, destroy);
    this._releasePoolCredit(credit);
  }

  async _connectBefore(
    deadline?: any,
    signal: any = null,
    lockKey: any = "",
    { ignoreDestroy = false }: Record<string, any> = {}
  ) : Promise<any> {
    throwIfAcquireAborted(signal, lockKey);
    const credit: any = await this._acquirePoolCredit(deadline, signal, lockKey, { ignoreDestroy });
    const pending: any = Promise.resolve().then(() : any => this.pool.connect());
    const remaining: any = Math.max(0, deadline - Date.now());
    let timeout: any;
    const timeoutPromise: any = new Promise((_?: any, reject?: any) : any => {
      timeout = setTimeout(() : any => reject(new PoolWaitTimeoutError()), remaining);
    });
    const destroyRace: any = ignoreDestroy ? null : createSignalRace(
      this._destroyController.signal,
      () : any => new LockManagerDestroyedError(this.config.backend)
    );
    const abortRace: any = createAbortRace(signal, lockKey);
    try {
      const client: any = await Promise.race([
        pending,
        timeoutPromise,
        ...(destroyRace ? [destroyRace.promise] : []),
        ...(abortRace ? [abortRace.promise] : [])
      ]);
      this._clientCredits.set(client, credit);
      return client;
    } catch (error: any) {
      this._releasePoolCredit(credit);
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
      destroyRace?.cleanup();
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

function positiveInteger(value?: any, fallback?: any, label?: any) : any {
  const normalized: any = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
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
