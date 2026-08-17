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
import pg, { type PoolConfig } from "pg";

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
  type DeadlineEntry,
  type IntrusiveWaitNode,
  type LockAcquireOptions,
  type LockHandle,
  type LockManagerConfig,
  type LockManagerMetrics,
} from "./lock-manager-contract.ts";

const { Pool } = pg;

const SCHEMA_SQL = `
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

const ACQUIRE_SQL = `
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

const INSPECT_SQL = `
SELECT EXISTS (
  SELECT 1 FROM _meshrix_lock_leases
  WHERE namespace = $1 AND lock_key = $2 AND expires_at > clock_timestamp()
) AS locked
`;

const RELEASE_SQL = `
DELETE FROM _meshrix_lock_leases
WHERE namespace = $1 AND lock_key = $2 AND owner_id = $3
  AND fencing_token = $4::bigint AND expires_at > clock_timestamp()
RETURNING fencing_token::text
`;

const EXPIRE_SQL = `
DELETE FROM _meshrix_lock_leases
WHERE namespace = $1 AND lock_key = $2 AND owner_id = $3
  AND fencing_token = $4::bigint AND expires_at <= clock_timestamp()
RETURNING fencing_token::text
`;

const HEARTBEAT_SQL = `
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

type QueryValue = string | number | boolean | Date | null;
type LeaseOutcome = "released" | "expired";
interface QueryResult<Row> {
  rows: Row[];
}
interface PgClient {
  query<Row>(text: string, values?: QueryValue[]): Promise<QueryResult<Row>>;
  release(destroy?: boolean): void;
}
interface PgPool {
  options?: { max?: number };
  connect(): Promise<PgClient>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): PgPool;
  off?(event: "error", listener: (error: Error) => void): PgPool;
  removeListener?(event: "error", listener: (error: Error) => void): PgPool;
}
interface PostgresConfig extends LockManagerConfig {
  pool?: PgPool;
  pgConfig?: PoolConfig;
  connectionString?: string;
  namespace?: string;
  retryIntervalMs?: number;
  queryTimeoutMs?: number;
  maxPoolCredits?: number;
}
interface AcquireRow {
  fencing_token: string;
  acquired_at: Date;
  expires_at: Date;
  lease_ms: string;
}
interface InspectRow {
  locked: boolean;
}
interface FenceRow {
  fencing_token: string;
}
interface HeartbeatRow {
  expires_at: Date;
  lease_ms: string;
}
interface PoolCredit {
  released: boolean;
}
interface LocalNode extends IntrusiveWaitNode<LocalNode> {
  active: boolean;
  promoted: boolean;
  deadlineEntry: DeadlineEntry | null;
  onAbort: (() => void) | null;
  resolve: (node: LocalNode) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
}
interface CreditNode extends IntrusiveWaitNode<CreditNode> {
  active: boolean;
  deadlineEntry: DeadlineEntry | null;
  onAbort: (() => void) | null;
  resolve: (credit: PoolCredit) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
}
interface Entry {
  closing: Promise<void> | null;
  finalized: boolean;
  handle: LockHandle;
  heartbeatTask: Promise<void> | null;
  ownerId: string;
  pendingHeartbeatTtlMs: number;
  rawFence: string;
  timer: NodeJS.Timeout | null;
}
interface BuildHandleOptions {
  lockKey: string;
  ownerId: string;
  fencingToken: string;
  rawFence: string;
  acquiredAt: Date;
  expiresAt: Date;
  ttlMs: number;
}
interface OperationOptions {
  ignoreDestroy?: boolean;
  signal?: AbortSignal;
  lockKey?: string;
}
interface ExtendedMetrics extends LockManagerMetrics {
  queueKeys: number;
  waiterTimers: number;
  activePoolCredits: number;
  waitingPoolCredits: number;
  maxPoolCredits: number;
}
interface Race<T> {
  promise: Promise<T>;
  cleanup(): void;
}

export class PostgresLockBackendError extends Error {
  override name = "PostgresLockBackendError";
  operation: string;
  constructor(operation: string) {
    super(`PostgreSQL lock backend failed during ${operation}.`);
    this.operation = operation;
  }
}

export class PostgresLockManager extends LockManager {
  _activePoolCredits: number;
  _clientCredits: WeakMap<PgClient, PoolCredit>;
  _destroyController: AbortController;
  _destroyPromise: Promise<void> | null;
  _destroyed: boolean;
  _entries: Map<string, Entry>;
  _ownsPool: boolean;
  _pendingAcquires: Set<Promise<LockHandle>>;
  _poolErrorListener: (error: Error) => void;
  _poolErrorListenerAttached: boolean;
  _localQueues: Map<string, IntrusiveWaitQueue<LocalNode>>;
  _poolCreditQueue: IntrusiveWaitQueue<CreditNode>;
  _schemaReady: Promise<void> | null;
  _scheduler: DeadlineScheduler;
  namespace: string;
  pool: PgPool;
  queryTimeoutMs: number;
  maxPoolCredits: number;
  retryIntervalMs: number;
  /**
   * @param {object} config
   * @param {object} [config.pool] - Injected node-postgres Pool-compatible object.
   * @param {object} [config.pgConfig] - Options passed to a manager-owned Pool.
   * @param {string} [config.connectionString] - Manager-owned Pool connection URI.
   * @param {string} [config.namespace=meshrix] - Advisory lock key namespace.
   * @param {number} [config.retryIntervalMs=50] - Non-blocking retry cadence.
   */
  constructor(config: PostgresConfig = {}) {
    super({ ...config, backend: "postgres" });
    this.namespace = normalizeLockKey(
      config.namespace ?? "meshrix",
      "Lock namespace",
    );
    this.retryIntervalMs = positiveDuration(
      config.retryIntervalMs,
      50,
      "retryIntervalMs",
    );
    this.queryTimeoutMs = positiveDuration(
      config.queryTimeoutMs,
      5000,
      "queryTimeoutMs",
    );
    this.maxPoolCredits = positiveInteger(
      config.maxPoolCredits,
      Number(config.pool?.options?.max) || 16,
      "maxPoolCredits",
    );
    this._entries = new Map();
    this._pendingAcquires = new Set();
    this._localQueues = new Map();
    this._poolCreditQueue = new IntrusiveWaitQueue();
    this._activePoolCredits = 0;
    this._clientCredits = new WeakMap();
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
        (typeof config.pool.off !== "function" &&
          typeof config.pool.removeListener !== "function")
      ) {
        throw new TypeError(
          "PostgresLockManager pool must expose connect() and EventEmitter listener methods.",
        );
      }
      this.pool = config.pool;
    } else {
      const pgConfig: PoolConfig | null = config.pgConfig
        ? { ...config.pgConfig }
        : config.connectionString
          ? { connectionString: config.connectionString }
          : null;
      if (!pgConfig) {
        throw new Error(
          "PostgresLockManager requires pool, pgConfig, or connectionString.",
        );
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
    const waitMs = nonNegativeDuration(
      options.waitMs,
      this.config.maxWaitMs,
      "waitMs",
    );
    const localQueue = this._localQueues.get(lockKey);
    if (localQueue && localQueue.size >= this.config.maxQueueDepth) {
      throw new LockQueueFullError(lockKey, this.config.maxQueueDepth);
    }
    if (this._metrics.currentWaiting >= this.config.maxTotalQueueDepth) {
      throw new LockQueueFullError(lockKey, this.config.maxTotalQueueDepth);
    }
    const deadline = Date.now() + waitMs;
    this._metrics.currentWaiting++;
    let turn = null;
    try {
      turn = await this._waitForLocalTurn(
        lockKey,
        deadline,
        options.signal,
        waitMs,
      );
      return await this._acquireLeader(lockKey, {
        ...options,
        waitMs: Math.max(0, deadline - Date.now()),
      });
    } finally {
      if (turn) this._releaseLocalTurn(lockKey, turn);
      this._metrics.currentWaiting = Math.max(
        0,
        this._metrics.currentWaiting - 1,
      );
    }
  }

  async _acquireLeader(
    lockKey: string,
    options: LockAcquireOptions = {},
  ): Promise<LockHandle> {
    this._assertActive();
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

    const deadline = Date.now() + waitMs;
    let client = null;
    let destroyClient = false;
    try {
      while (true) {
        const ownerId = randomUUID();
        const attemptDeadline =
          waitMs === 0
            ? Date.now() + this.queryTimeoutMs
            : Math.min(deadline, Date.now() + this.queryTimeoutMs);
        try {
          client = await this._connectBefore(
            attemptDeadline,
            options.signal,
            lockKey,
          );
          await this._ensureSchema(
            client,
            attemptDeadline,
            options.signal,
            lockKey,
          );
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

        let row: AcquireRow | undefined;
        try {
          const result = await this._queryBefore<AcquireRow>(
            client,
            ACQUIRE_SQL,
            [this.namespace, lockKey, ownerId, ttlMs],
            attemptDeadline,
            { signal: options.signal, lockKey },
          );
          row = result.rows[0];
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

        if (row?.fencing_token) {
          const rawFence = String(row.fencing_token).trim();
          if (!rawFence) {
            destroyClient = true;
            this._metrics.totalBackendErrors++;
            throw new PostgresLockBackendError("fencing");
          }
          const acquiredAt = new Date(row.acquired_at);
          const expiresAt = new Date(row.expires_at);
          const leaseMs = positiveDuration(
            Number(row.lease_ms),
            ttlMs,
            "leaseMs",
          );
          this._releaseClient(client, false);
          client = null;
          const handle = this._buildHandle({
            lockKey,
            ownerId,
            fencingToken: `fence_postgres_${rawFence}`,
            rawFence,
            acquiredAt,
            expiresAt,
            ttlMs: leaseMs,
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
          lockKey,
        );
      }
    } finally {
      if (client) this._releaseClient(client, destroyClient);
    }
  }

  _waitForLocalTurn(
    lockKey: string,
    deadline: number,
    signal: AbortSignal | undefined,
    waitMs: number,
  ): Promise<LocalNode> {
    let queue = this._localQueues.get(lockKey);
    if (!queue) {
      queue = new IntrusiveWaitQueue();
      this._localQueues.set(lockKey, queue);
    }
    let resolve!: (node: LocalNode) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<LocalNode>((accepted, rejected) => {
      resolve = accepted;
      reject = rejected;
    });
    const node: LocalNode = {
      active: true,
      promoted: false,
      deadlineEntry: null,
      onAbort: null,
      resolve,
      reject,
      signal,
      previous: null,
      next: null,
      queue: null,
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
    const rejectPending = (error: Error): void => {
      if (!node.active) return;
      node.active = false;
      queue.remove(node);
      this._scheduler.cancel(node.deadlineEntry);
      if (node.onAbort) node.signal?.removeEventListener("abort", node.onAbort);
      if (queue.size === 0) this._localQueues.delete(lockKey);
      reject(error);
    };
    node.onAbort = () => rejectPending(new LockAcquireAbortedError(lockKey));
    node.deadlineEntry = this._scheduler.schedule(deadline, () => {
      this._metrics.totalTimedOut++;
      rejectPending(new LockTimeoutError(lockKey, waitMs));
    });
    signal?.addEventListener?.("abort", node.onAbort, { once: true });
    if (signal?.aborted) node.onAbort();
    return promise;
  }

  _releaseLocalTurn(lockKey: string, node: LocalNode): void {
    const queue = this._localQueues.get(lockKey);
    if (!queue || queue.head !== node) return;
    node.active = false;
    queue.remove(node);
    const next = queue.head;
    if (!next) {
      this._localQueues.delete(lockKey);
      return;
    }
    next.active = false;
    next.promoted = true;
    this._scheduler.cancel(next.deadlineEntry);
    if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort);
    next.resolve(next);
  }

  override async release(handle: LockHandle): Promise<void> {
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
      entry.closing = this._beginEntryClose(entry, "released", true);
    }
    return entry.closing;
  }

  override async isLocked(key: string): Promise<boolean> {
    this._assertActive();
    const lockKey = normalizeLockKey(key);
    if (this._entries.has(lockKey)) return true;

    const deadline = Date.now() + this.config.maxWaitMs;
    let client = null;
    let destroyClient = false;
    try {
      const attemptDeadline = Math.min(
        deadline,
        Date.now() + this.queryTimeoutMs,
      );
      client = await this._connectBefore(attemptDeadline);
      await this._ensureSchema(client, attemptDeadline);
      const result = await this._queryBefore<InspectRow>(
        client,
        INSPECT_SQL,
        [this.namespace, lockKey],
        attemptDeadline,
      );
      return result.rows?.[0]?.locked === true;
    } catch (error) {
      if (error instanceof LockManagerDestroyedError) throw error;
      if (error instanceof PostgresLockBackendError) throw error;
      this._metrics.totalBackendErrors++;
      destroyClient = true;
      throw new PostgresLockBackendError("inspect");
    } finally {
      if (client) this._releaseClient(client, destroyClient);
    }
  }

  override getMetrics(): ExtendedMetrics {
    return {
      ...super.getMetrics(),
      queueKeys: this._localQueues.size,
      waiterTimers: this._scheduler.activeTimerCount,
      activePoolCredits: this._activePoolCredits,
      waitingPoolCredits: this._poolCreditQueue.size,
      maxPoolCredits: this.maxPoolCredits,
    };
  }

  destroy(): Promise<void> {
    if (this._destroyPromise) return this._destroyPromise;
    this._destroyed = true;
    this._destroyController.abort();
    const destroyedError = new LockManagerDestroyedError(this.config.backend);
    for (const [lockKey, queue] of this._localQueues) {
      let node = queue.head;
      while (node) {
        const next = node.next;
        if (!node.promoted) {
          node.active = false;
          queue.remove(node);
          this._scheduler.cancel(node.deadlineEntry);
          if (node.onAbort)
            node.signal?.removeEventListener("abort", node.onAbort);
          node.reject(destroyedError);
        }
        node = next;
      }
      if (queue.size === 0) this._localQueues.delete(lockKey);
    }
    while (this._poolCreditQueue.size > 0) {
      const node = this._poolCreditQueue.shift();
      if (!node) continue;
      node.active = false;
      this._scheduler.cancel(node.deadlineEntry);
      if (node.onAbort) node.signal?.removeEventListener("abort", node.onAbort);
      node.reject(destroyedError);
    }
    this._scheduler.close();
    this._destroyPromise = this._finishDestroy();
    return this._destroyPromise;
  }

  async _finishDestroy(): Promise<void> {
    await Promise.allSettled(this._pendingAcquires);
    await Promise.all(
      [...this._entries.values()].map((entry) => {
        if (!entry.closing)
          entry.closing = this._beginEntryClose(entry, "released", false);
        return entry.closing;
      }),
    );
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

  _detachPoolErrorListener(): void {
    if (!this._poolErrorListenerAttached) return;
    this._poolErrorListenerAttached = false;
    if (typeof this.pool.off === "function") {
      this.pool.off("error", this._poolErrorListener);
    } else {
      this.pool.removeListener?.("error", this._poolErrorListener);
    }
  }

  _buildHandle({
    lockKey,
    ownerId,
    fencingToken,
    rawFence,
    acquiredAt,
    expiresAt,
    ttlMs,
  }: BuildHandleOptions): LockHandle {
    const handle: LockHandle = {
      lockKey,
      fencingToken,
      acquiredAt,
      expiresAt,
      released: false,
      release: async () => this.release(handle),
      heartbeat: async (extendMs = this.config.defaultTtlMs) =>
        this._heartbeatEntry(entry, extendMs),
    };
    const entry: Entry = {
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

  async _heartbeatEntry(entry: Entry, extendMs: number): Promise<void> {
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
      "extendMs",
    );
    entry.pendingHeartbeatTtlMs = Math.max(
      entry.pendingHeartbeatTtlMs,
      heartbeatTtlMs,
    );
    if (entry.heartbeatTask) return entry.heartbeatTask;
    const heartbeatTask = (async () => {
      try {
        const result = await this._leaseQuery<HeartbeatRow>(
          HEARTBEAT_SQL,
          [
            this.namespace,
            handle.lockKey,
            entry.ownerId,
            entry.rawFence,
            entry.pendingHeartbeatTtlMs,
          ],
          Date.now() + this.queryTimeoutMs,
          { ignoreDestroy: true },
        );
        const row = result.rows?.[0];
        if (!row) {
          this._finalizeEntry(entry, "expired");
          throw new LockReleasedError(handle.lockKey);
        }
        const leaseMs = positiveDuration(
          Number(row.lease_ms),
          entry.pendingHeartbeatTtlMs,
          "leaseMs",
        );
        handle.expiresAt = new Date(row.expires_at);
        this._resetExpiryTimer(entry, leaseMs);
      } catch {
        if (entry.finalized) throw new LockReleasedError(handle.lockKey);
        this._metrics.totalBackendErrors++;
        this._finalizeEntry(entry, "expired");
        throw new PostgresLockBackendError("heartbeat");
      }
      if (entry.finalized || entry.closing)
        throw new LockReleasedError(handle.lockKey);
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

  _resetExpiryTimer(entry: Entry, ttlMs: number): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (!entry.closing)
        entry.closing = this._beginEntryClose(entry, "expired", false);
      void entry.closing;
    }, ttlMs);
    if (entry.timer.unref) entry.timer.unref();
  }

  async _beginEntryClose(
    entry: Entry,
    outcome: LeaseOutcome,
    surfaceFailure: boolean,
  ): Promise<void> {
    const heartbeatTask = entry.heartbeatTask;
    if (heartbeatTask) await heartbeatTask.catch(() => {});
    if (entry.finalized) return;
    return this._unlockEntry(entry, outcome, surfaceFailure);
  }

  async _unlockEntry(
    entry: Entry,
    outcome: LeaseOutcome,
    surfaceFailure: boolean,
  ): Promise<void> {
    if (entry.finalized) return;
    let failed = false;
    try {
      const sql = outcome === "expired" ? EXPIRE_SQL : RELEASE_SQL;
      const result = await this._leaseQuery<FenceRow>(
        sql,
        [this.namespace, entry.handle.lockKey, entry.ownerId, entry.rawFence],
        Date.now() + this.queryTimeoutMs,
        { ignoreDestroy: this._destroyed },
      );
      if (!result.rows?.[0]?.fencing_token && outcome === "released")
        outcome = "expired";
    } catch {
      failed = true;
    }
    if (failed) this._metrics.totalBackendErrors++;
    this._finalizeEntry(entry, outcome);
    if (failed && surfaceFailure) throw new PostgresLockBackendError("release");
  }

  _finalizeEntry(entry: Entry, outcome: LeaseOutcome): void {
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

  async _ensureSchema(
    client: PgClient,
    deadline: number,
    signal?: AbortSignal,
    lockKey = "",
  ): Promise<void> {
    if (!this._schemaReady) {
      const initializing = this._queryBefore<never>(
        client,
        SCHEMA_SQL,
        [],
        deadline,
        { signal, lockKey },
      ).then(() => undefined);
      const ready = initializing.catch((error: Error) => {
        if (this._schemaReady === ready) this._schemaReady = null;
        throw error;
      });
      this._schemaReady = ready;
    }
    return this._schemaReady;
  }

  async _leaseQuery<Row>(
    text: string,
    values: QueryValue[],
    deadline = Date.now() + this.queryTimeoutMs,
    { ignoreDestroy = false, signal, lockKey = "" }: OperationOptions = {},
  ): Promise<QueryResult<Row>> {
    let client: PgClient | null = null;
    let destroyClient = false;
    try {
      client = await this._connectBefore(deadline, signal, lockKey, {
        ignoreDestroy,
      });
      await this._ensureSchema(client, deadline, signal, lockKey);
      return await this._queryBefore<Row>(client, text, values, deadline, {
        ignoreDestroy,
        signal,
        lockKey,
      });
    } catch (error) {
      destroyClient = Boolean(client);
      throw error;
    } finally {
      if (client) this._releaseClient(client, destroyClient);
    }
  }

  _acquirePoolCredit(
    deadline: number,
    signal?: AbortSignal,
    lockKey = "",
    { ignoreDestroy = false }: OperationOptions = {},
  ): Promise<PoolCredit> {
    throwIfAcquireAborted(signal, lockKey);
    if (this._destroyed && !ignoreDestroy) {
      return Promise.reject(new LockManagerDestroyedError(this.config.backend));
    }
    if (this._activePoolCredits < this.maxPoolCredits) {
      this._activePoolCredits += 1;
      return Promise.resolve({ released: false });
    }
    if (this._poolCreditQueue.size >= this.config.maxTotalQueueDepth) {
      return Promise.reject(
        new LockQueueFullError(lockKey, this.config.maxTotalQueueDepth),
      );
    }
    return new Promise<PoolCredit>((resolve, reject) => {
      const node: CreditNode = {
        active: true,
        deadlineEntry: null,
        onAbort: null,
        reject,
        resolve,
        signal,
        previous: null,
        next: null,
        queue: null,
      };
      const rejectPending = (error: Error): void => {
        if (!node.active) return;
        node.active = false;
        this._poolCreditQueue.remove(node);
        this._scheduler.cancel(node.deadlineEntry);
        if (node.onAbort) signal?.removeEventListener("abort", node.onAbort);
        reject(error);
      };
      node.onAbort = () => rejectPending(new LockAcquireAbortedError(lockKey));
      node.deadlineEntry = this._scheduler.schedule(deadline, () => {
        rejectPending(new PoolWaitTimeoutError());
      });
      this._poolCreditQueue.push(node);
      signal?.addEventListener?.("abort", node.onAbort, { once: true });
      if (signal?.aborted) node.onAbort();
    });
  }

  _releasePoolCredit(token: PoolCredit | undefined): void {
    if (!token || token.released) return;
    token.released = true;
    this._activePoolCredits = Math.max(0, this._activePoolCredits - 1);
    while (this._poolCreditQueue.size > 0 && !this._destroyed) {
      const node = this._poolCreditQueue.shift();
      if (!node?.active) continue;
      node.active = false;
      this._scheduler.cancel(node.deadlineEntry);
      if (node.onAbort) node.signal?.removeEventListener("abort", node.onAbort);
      this._activePoolCredits += 1;
      node.resolve({ released: false });
      break;
    }
  }

  _releaseClient(client: PgClient, destroy: boolean): void {
    const credit = this._clientCredits.get(client);
    this._clientCredits.delete(client);
    releasePoolClient(client, destroy);
    this._releasePoolCredit(credit);
  }

  async _connectBefore(
    deadline: number,
    signal?: AbortSignal,
    lockKey = "",
    { ignoreDestroy = false }: OperationOptions = {},
  ): Promise<PgClient> {
    throwIfAcquireAborted(signal, lockKey);
    const credit = await this._acquirePoolCredit(deadline, signal, lockKey, {
      ignoreDestroy,
    });
    const pending = Promise.resolve().then(() => this.pool.connect());
    const remaining = Math.max(0, deadline - Date.now());
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new PoolWaitTimeoutError()), remaining);
    });
    const destroyRace = ignoreDestroy
      ? null
      : createSignalRace(
          this._destroyController.signal,
          () => new LockManagerDestroyedError(this.config.backend),
        );
    const abortRace = createAbortRace(signal, lockKey);
    try {
      const client = await Promise.race([
        pending,
        timeoutPromise,
        ...(destroyRace ? [destroyRace.promise] : []),
        ...(abortRace ? [abortRace.promise] : []),
      ]);
      this._clientCredits.set(client, credit);
      return client;
    } catch (error) {
      this._releasePoolCredit(credit);
      if (
        error instanceof PoolWaitTimeoutError ||
        error instanceof LockManagerDestroyedError ||
        error instanceof LockAcquireAbortedError
      ) {
        void pending.then(
          (client) => releasePoolClient(client, false),
          () => undefined,
        );
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      destroyRace?.cleanup();
      abortRace?.cleanup();
    }
  }

  async _queryBefore<Row>(
    client: PgClient,
    text: string,
    values: QueryValue[],
    deadline: number,
    { ignoreDestroy = false, signal, lockKey = "" }: OperationOptions = {},
  ): Promise<QueryResult<Row>> {
    if (this._destroyed && !ignoreDestroy) {
      throw new LockManagerDestroyedError(this.config.backend);
    }
    throwIfAcquireAborted(signal, lockKey);
    const pending = Promise.resolve().then(() =>
      client.query<Row>(text, values),
    );
    const remaining = Math.max(0, deadline - Date.now());
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new BackendQueryTimeoutError()),
        remaining,
      );
    });
    const destroyRace = ignoreDestroy
      ? null
      : createSignalRace(
          this._destroyController.signal,
          () => new LockManagerDestroyedError(this.config.backend),
        );
    const abortRace = createAbortRace(signal, lockKey);
    try {
      return await Promise.race([
        pending,
        timeoutPromise,
        ...(destroyRace ? [destroyRace.promise] : []),
        ...(abortRace ? [abortRace.promise] : []),
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
      if (timeout) clearTimeout(timeout);
      destroyRace?.cleanup();
      abortRace?.cleanup();
    }
  }

  async _waitForRetry(
    ms: number,
    signal?: AbortSignal,
    lockKey = "",
  ): Promise<void> {
    throwIfAcquireAborted(signal, lockKey);
    const abortRace = createAbortRace(signal, lockKey);
    const destroyRace = createSignalRace(
      this._destroyController.signal,
      () => new LockManagerDestroyedError(this.config.backend),
    );
    const retryTimer = createTimerRace(ms);
    try {
      await Promise.race([
        retryTimer.promise,
        destroyRace!.promise,
        ...(abortRace ? [abortRace.promise] : []),
      ]);
    } finally {
      retryTimer.cleanup();
      destroyRace!.cleanup();
      abortRace?.cleanup();
    }
  }

  async _poolEndBefore(): Promise<void> {
    const pending = Promise.resolve().then(() => this.pool.end());
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new BackendQueryTimeoutError()),
        this.queryTimeoutMs,
      );
    });
    try {
      return await Promise.race([pending, timeoutPromise]);
    } catch (error) {
      if (error instanceof BackendQueryTimeoutError) {
        void pending.then(
          () => this._detachPoolErrorListener(),
          () => this._detachPoolErrorListener(),
        );
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  _assertActive(): void {
    if (this._destroyed)
      throw new LockManagerDestroyedError(this.config.backend);
  }
}

function releasePoolClient(client: PgClient, destroy: boolean): void {
  try {
    client.release(Boolean(destroy));
  } catch {
    // The pool may already have discarded a disconnected client.
  }
}

function normalizeLockKey(key: string, label = "Lock key"): string {
  const normalized = String(key ?? "").trim();
  if (!normalized) throw new TypeError(`${label} must be a non-empty string.`);
  return normalized;
}

function positiveDuration(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a positive finite number.`);
  }
  return normalized;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return normalized;
}

function nonNegativeDuration(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new TypeError(`${label} must be a non-negative finite number.`);
  }
  return normalized;
}

function throwIfAcquireAborted(
  signal: AbortSignal | undefined,
  key: string,
): void {
  if (signal?.aborted) throw new LockAcquireAbortedError(key);
}

function createTimerRace(ms: number): Race<void> {
  let timer: NodeJS.Timeout | null = null;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return {
    promise,
    cleanup(): void {
      if (timer) clearTimeout(timer);
    },
  };
}

function createAbortRace(
  signal: AbortSignal | undefined,
  key: string,
): Race<never> | null {
  return createSignalRace(signal, () => new LockAcquireAbortedError(key));
}

function createSignalRace(
  signal: AbortSignal | undefined,
  errorFactory: () => Error,
): Race<never> | null {
  if (!signal) return null;
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(errorFactory());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return {
    promise,
    cleanup(): void {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
}
