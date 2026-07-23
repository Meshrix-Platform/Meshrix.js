import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LockAcquireAbortedError,
  LockFencingError,
  LockManagerDestroyedError,
  LockQueueFullError,
  LockReleasedError,
  LockTimeoutError,
  MemoryLockManager,
  createLockManager,
  createLockManagerAsync
} from "../../../packages/foundation/src/concurrency/lock-manager.mjs";
import {
  PostgresLockBackendError,
  PostgresLockManager,
  postgresAdvisoryKey
} from "../../../packages/foundation/src/concurrency/postgres-lock-manager.mjs";
import {
  SqliteLockBackendError,
  SqliteLockManager
} from "../../../packages/foundation/src/concurrency/sqlite-lock-manager.mjs";

const resources = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(resources.splice(0).map(async (resource) => {
    await resource.manager?.destroy?.();
    resource.db?.close?.();
  }));
});

describe("memory lock manager", () => {
  it("fails closed for invalid configuration and unknown backends", async () => {
    expect(() => new MemoryLockManager({ defaultTtlMs: 0 })).toThrow(TypeError);
    expect(() => createLockManager()).toThrow("backend must be selected explicitly");
    await expect(createLockManagerAsync()).rejects.toThrow("backend must be selected explicitly");
    expect(() => createLockManager({ backend: "unknown" })).toThrow("Unsupported lock manager backend");
    await expect(createLockManagerAsync({ backend: "unknown" })).rejects.toThrow("Unsupported lock manager backend");
    await expect(new MemoryLockManager().acquire(" ")).rejects.toThrow("Lock key must be a non-empty string");
  });

  it("uses FIFO promotion, preserves waiter TTL, and emits increasing fences", async () => {
    vi.useFakeTimers();
    const manager = new MemoryLockManager({ defaultTtlMs: 100, maxWaitMs: 500 });
    resources.push({ manager });
    const first = await manager.acquire("shared");
    const queued = manager.acquire("shared", { ttlMs: 250 });

    await first.release();
    const second = await queued;
    expect(second.expiresAt.getTime() - second.acquiredAt.getTime()).toBe(250);
    expect(second.fencingToken).not.toBe(first.fencingToken);
    expect(manager.getMetrics()).toMatchObject({
      totalAcquired: 2,
      totalReleased: 1,
      currentActive: 1,
      currentWaiting: 0
    });
  });

  it("promotes a waiter on lease expiry and rejects stale heartbeats", async () => {
    vi.useFakeTimers();
    const manager = new MemoryLockManager({ defaultTtlMs: 20, maxWaitMs: 100 });
    resources.push({ manager });
    const first = await manager.acquire("lease");
    const queued = manager.acquire("lease", { ttlMs: 50 });

    await vi.advanceTimersByTimeAsync(21);
    const second = await queued;
    expect(first.released).toBe(true);
    await expect(first.heartbeat()).rejects.toBeInstanceOf(LockReleasedError);
    expect(second.released).toBe(false);
    expect(manager.getMetrics()).toMatchObject({ totalExpired: 1, currentActive: 1 });
  });

  it("enforces immediate timeout, queue bounds, and fencing identity", async () => {
    const manager = new MemoryLockManager({ maxQueueDepth: 1 });
    resources.push({ manager });
    const first = await manager.acquire("bounded");
    await expect(manager.acquire("bounded", { waitMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    const queued = manager.acquire("bounded", { waitMs: 1000 });
    await expect(manager.acquire("bounded", { waitMs: 1000 })).rejects.toBeInstanceOf(LockQueueFullError);
    const fencingError = await manager.release({
      lockKey: "bounded",
      fencingToken: "stale",
      released: false
    }).catch((error) => error);
    expect(fencingError).toBeInstanceOf(LockFencingError);
    expect(String(fencingError)).not.toMatch(/bounded|stale/);
    expect(fencingError).not.toHaveProperty("token");
    await first.release();
    await (await queued).release();
  });

  it("never resurrects an already elapsed memory lease", async () => {
    const manager = new MemoryLockManager({ defaultTtlMs: 1000 });
    resources.push({ manager });
    const handle = await manager.acquire("stale-heartbeat");
    handle.expiresAt = new Date(Date.now() - 1);
    await expect(handle.heartbeat(1000)).rejects.toBeInstanceOf(LockReleasedError);
    expect(handle.released).toBe(true);
    expect(manager.getMetrics()).toMatchObject({ totalExpired: 1, currentActive: 0 });
  });

  it("lazily expires a memory lease when its timer has not run yet", async () => {
    vi.useFakeTimers();
    const manager = new MemoryLockManager({ defaultTtlMs: 20 });
    resources.push({ manager });
    const first = await manager.acquire("lazy-expiry");
    vi.setSystemTime(Date.now() + 21);

    expect(await manager.isLocked("lazy-expiry")).toBe(false);
    const replacement = await manager.acquire("lazy-expiry", { waitMs: 0 });
    expect(first.released).toBe(true);
    expect(replacement.fencingToken).not.toBe(first.fencingToken);
    expect(manager.getMetrics()).toMatchObject({ totalExpired: 1, currentActive: 1 });
  });
});

describe("SQLite lock manager", () => {
  function createSqliteManager(config = {}) {
    const db = new Database(":memory:");
    const manager = new SqliteLockManager({
      db,
      defaultTtlMs: 100,
      maxWaitMs: 0,
      cleanupIntervalMs: 1000,
      ...config
    });
    resources.push({ db, manager });
    return manager;
  }

  it("persists monotonic fences and rejects duplicate acquisition", async () => {
    const manager = createSqliteManager();
    const first = await manager.acquire("durable", { ttlMs: 250 });
    expect(first.fencingToken).toBe("fence_sqlite_1");
    expect(first.expiresAt.getTime() - first.acquiredAt.getTime()).toBe(250);
    await expect(manager.acquire("durable", { waitMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    await first.release();
    const second = await manager.acquire("durable");
    expect(second.fencingToken).toBe("fence_sqlite_2");
  });

  it("extends a durable lease and marks released handles consistently", async () => {
    vi.useFakeTimers();
    const manager = createSqliteManager({ defaultTtlMs: 20 });
    const handle = await manager.acquire("heartbeat");
    await handle.heartbeat(100);
    await vi.advanceTimersByTimeAsync(25);
    expect(await manager.isLocked("heartbeat")).toBe(true);
    await handle.release();
    expect(handle.released).toBe(true);
    await expect(handle.heartbeat()).rejects.toBeInstanceOf(LockReleasedError);
  });

  it("protects release with the fencing identity and releases locks on destroy", async () => {
    const manager = createSqliteManager();
    const handle = await manager.acquire("identity");
    await expect(manager.release({
      lockKey: "identity",
      fencingToken: "fence_sqlite_0",
      released: false
    })).rejects.toBeInstanceOf(LockFencingError);
    await manager.destroy();
    expect(handle.released).toBe(true);
    await expect(manager.isLocked("identity")).rejects.toBeInstanceOf(LockManagerDestroyedError);
  });

  it("enforces queue depth and reports current SQLite waiters", async () => {
    const manager = createSqliteManager({
      maxQueueDepth: 1,
      maxWaitMs: 250,
      retryIntervalMs: 1
    });
    const first = await manager.acquire("bounded");
    const queued = manager.acquire("bounded");
    await vi.waitFor(() => {
      expect(manager.getMetrics().currentWaiting).toBe(1);
    });
    await expect(manager.acquire("bounded")).rejects.toBeInstanceOf(LockQueueFullError);
    await first.release();
    const second = await queued;
    expect(manager.getMetrics().currentWaiting).toBe(0);
    await second.release();
  });

  it("promotes SQLite contenders in FIFO order", async () => {
    const manager = createSqliteManager({
      maxQueueDepth: 3,
      maxWaitMs: 500,
      retryIntervalMs: 1
    });
    const first = await manager.acquire("sqlite-fifo");
    const order = [];
    const secondPending = manager.acquire("sqlite-fifo").then((handle) => {
      order.push("second");
      return handle;
    });
    const thirdPending = manager.acquire("sqlite-fifo").then((handle) => {
      order.push("third");
      return handle;
    });
    await vi.waitFor(() => expect(manager.getMetrics().currentWaiting).toBe(2));

    await first.release();
    const second = await secondPending;
    expect(order).toEqual(["second"]);
    await second.release();
    const third = await thirdPending;
    expect(order).toEqual(["second", "third"]);
    await third.release();
  });

  it("never resurrects an expired durable row through heartbeat", async () => {
    const manager = createSqliteManager({ defaultTtlMs: 1000 });
    const handle = await manager.acquire("stale-heartbeat");
    manager.db.prepare("UPDATE _lico_locks SET expires_at = ? WHERE lock_key = ?")
      .run(new Date(Date.now() - 1).toISOString(), handle.lockKey);
    await expect(handle.heartbeat(1000)).rejects.toBeInstanceOf(LockReleasedError);
    expect(handle.released).toBe(true);
    const replacement = await manager.acquire("stale-heartbeat");
    expect(replacement.fencingToken).not.toBe(handle.fencingToken);
    await replacement.release();
  });

  it("sanitizes SQLite backend failures", async () => {
    const manager = createSqliteManager();
    const handle = await manager.acquire("private-sqlite-key");
    const prepare = manager.db.prepare.bind(manager.db);
    manager.db.prepare = (sql) => {
      if (String(sql).includes("SELECT fencing_token, expires_at")) {
        throw new Error("private sqlite backend detail");
      }
      return prepare(sql);
    };

    const error = await handle.release().catch((failure) => failure);
    manager.db.prepare = prepare;
    expect(error).toBeInstanceOf(SqliteLockBackendError);
    expect(String(error)).not.toMatch(/private-sqlite-key|private sqlite backend detail/);
    expect(manager.getMetrics().totalBackendErrors).toBe(1);
  });

  it("rejects queued waiters immediately when SQLite shutdown begins", async () => {
    const manager = createSqliteManager({
      maxWaitMs: 10_000,
      retryIntervalMs: 5_000
    });
    const first = await manager.acquire("shutdown-waiter");
    const queued = manager.acquire("shutdown-waiter");
    await vi.waitFor(() => expect(manager.getMetrics().currentWaiting).toBe(1));

    const destroying = manager.destroy();
    await expect(queued).rejects.toBeInstanceOf(LockManagerDestroyedError);
    await destroying;
    expect(first.released).toBe(true);
    expect(manager.getMetrics()).toMatchObject({ currentActive: 0, currentWaiting: 0 });
  });

  it("cleans every local handle when one SQLite destroy delete fails", async () => {
    const db = new Database(":memory:");
    const manager = new SqliteLockManager({ db, cleanupIntervalMs: 1000 });
    const resource = { db, manager };
    resources.push(resource);
    const first = await manager.acquire("destroy-failure-one");
    const second = await manager.acquire("destroy-failure-two");
    const prepare = db.prepare.bind(db);
    let shouldFail = true;
    manager.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (!/^DELETE FROM _lico_locks WHERE lock_key = \? AND fencing_token = \?$/.test(
        String(sql).trim().replace(/\s+/g, " ")
      )) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property !== "run") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (...args) => {
            if (shouldFail) {
              shouldFail = false;
              throw new Error("private backend detail");
            }
            return target.run(...args);
          };
        }
      });
    };

    await expect(manager.destroy()).rejects.toBeInstanceOf(SqliteLockBackendError);
    expect(first.released).toBe(true);
    expect(second.released).toBe(true);
    expect(manager.getMetrics()).toMatchObject({ currentActive: 0, currentWaiting: 0 });
    expect(String(await manager.destroy().catch((error) => error))).not.toContain("private backend detail");

    resource.manager = null;
    resource.db = null;
    db.close();
  });

  it("uses one backoff poller for a hot SQLite key", async () => {
    const manager = createSqliteManager({
      maxQueueDepth: 100,
      maxWaitMs: 80,
      retryIntervalMs: 5,
      maxRetryIntervalMs: 40,
      random: () => 1
    });
    const now = new Date();
    manager.db.prepare(`
      INSERT INTO _lico_locks
        (lock_key, fencing_token, acquired_at, expires_at, heartbeat_at, owner_pid)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "hot-external",
      "external-fence",
      now.toISOString(),
      new Date(now.getTime() + 10_000).toISOString(),
      now.toISOString(),
      1
    );
    const attempt = manager._tryAcquire;
    let attempts = 0;
    manager._tryAcquire = (input) => {
      attempts++;
      return attempt(input);
    };

    const settled = await Promise.allSettled(
      Array.from({ length: 50 }, () => manager.acquire("hot-external"))
    );
    expect(settled.every((entry) => entry.status === "rejected" && entry.reason instanceof LockTimeoutError))
      .toBe(true);
    expect(attempts).toBeLessThan(15);
    expect(manager.getMetrics().currentWaiting).toBe(0);
  });

  it("coordinates leases, fences, and instance shutdown across SQLite connections", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lico-sqlite-lock-cross-instance-"));
    const databasePath = path.join(root, "locks.sqlite");
    const dbA = new Database(databasePath);
    const dbB = new Database(databasePath);
    const managerA = new SqliteLockManager({
      db: dbA,
      defaultTtlMs: 500,
      maxWaitMs: 1_000,
      retryIntervalMs: 1,
      cleanupIntervalMs: 1000
    });
    const managerB = new SqliteLockManager({
      db: dbB,
      defaultTtlMs: 500,
      maxWaitMs: 1_000,
      retryIntervalMs: 1,
      cleanupIntervalMs: 1000
    });
    try {
      const heldByA = await managerA.acquire("cross-instance-shared");
      const independentB = await managerB.acquire("cross-instance-independent", { ttlMs: 2_000 });
      let replacementSettled = false;
      const replacementPending = managerB.acquire("cross-instance-shared").then((handle) => {
        replacementSettled = true;
        return handle;
      });
      await vi.waitFor(() => expect(managerB.getMetrics().currentWaiting).toBe(1));

      await heldByA.heartbeat(500);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(replacementSettled).toBe(false);
      await managerA.destroy();

      const replacement = await replacementPending;
      expect(replacement.fencingToken).not.toBe(heldByA.fencingToken);
      expect(independentB.released).toBe(false);
      expect(await managerB.isLocked("cross-instance-independent")).toBe(true);
      await replacement.release();
      await independentB.release();
    } finally {
      await managerA.destroy().catch(() => {});
      await managerB.destroy().catch(() => {});
      dbA.close();
      dbB.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

class MockPgClient extends EventEmitter {
  constructor(coordinator) {
    super();
    this.coordinator = coordinator;
    this.released = false;
    this.destroyed = false;
    this.failUnlock = false;
  }

  async query(sql, params = []) {
    const key = params.join(":");
    if (sql.includes("pg_try_advisory_lock")) {
      const owner = this.coordinator.locks.get(key);
      const acquired = !owner || owner === this;
      if (acquired) this.coordinator.locks.set(key, this);
      if (sql.includes("pg_current_xact_id")) {
        return {
          rows: [{
            acquired,
            fencing_token: acquired ? String(this.coordinator.nextFence++) : null
          }]
        };
      }
      return { rows: [{ acquired }] };
    }
    if (sql.includes("pg_advisory_unlock")) {
      if (this.failUnlock) throw new Error("sensitive backend detail");
      const unlocked = this.coordinator.locks.get(key) === this;
      if (unlocked) this.coordinator.locks.delete(key);
      return { rows: [{ unlocked }] };
    }
    return { rows: [{ alive: 1 }] };
  }

  release(destroy = false) {
    this.released = true;
    this.destroyed = Boolean(destroy);
    if (destroy) {
      for (const [key, owner] of this.coordinator.locks) {
        if (owner === this) this.coordinator.locks.delete(key);
      }
    }
  }
}

class MockPgPool extends EventEmitter {
  constructor() {
    super();
    this.coordinator = { locks: new Map(), nextFence: 100n };
    this.clients = [];
    this.ended = false;
    this.pendingConnect = false;
  }

  async connect() {
    if (this.pendingConnect) return new Promise(() => {});
    const client = new MockPgClient(this.coordinator);
    this.clients.push(client);
    return client;
  }

  async end() {
    this.ended = true;
  }
}

describe("PostgreSQL lock manager", () => {
  function createPostgresManager(config = {}) {
    const pool = config.pool || new MockPgPool();
    const manager = new PostgresLockManager({
      pool,
      defaultTtlMs: 100,
      maxWaitMs: 20,
      retryIntervalMs: 5,
      ...config
    });
    resources.push({ manager });
    return { manager, pool };
  }

  it("rejects injected pools that cannot report and detach backend errors", () => {
    expect(() => new PostgresLockManager({
      pool: { connect: async () => null }
    })).toThrow("EventEmitter listener methods");
  });

  it("hashes stable namespaced advisory keys without exposing source keys", () => {
    expect(postgresAdvisoryKey("alpha")).toEqual(postgresAdvisoryKey("alpha"));
    expect(postgresAdvisoryKey("alpha", "one")).not.toEqual(postgresAdvisoryKey("alpha", "two"));
    expect(postgresAdvisoryKey("alpha")).toHaveLength(2);
  });

  it("holds a dedicated session, times out contenders, and increments fences", async () => {
    const { manager } = createPostgresManager();
    const first = await manager.acquire("distributed");
    expect(first.fencingToken).toBe("fence_postgres_100");
    await expect(manager.acquire("distributed", { waitMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    await first.release();
    const second = await manager.acquire("distributed");
    expect(second.fencingToken).toBe("fence_postgres_101");
    expect(await manager.isLocked("distributed")).toBe(true);
  });

  it("coordinates managers by namespace and inspects externally held locks", async () => {
    const pool = new MockPgPool();
    const managerA = new PostgresLockManager({ pool, namespace: "deployment-a", maxWaitMs: 50 });
    const managerB = new PostgresLockManager({ pool, namespace: "deployment-a", maxWaitMs: 50 });
    const isolated = new PostgresLockManager({ pool, namespace: "deployment-b", maxWaitMs: 50 });
    resources.push({ manager: managerA }, { manager: managerB }, { manager: isolated });

    const held = await managerA.acquire("shared-logical-key");
    expect(await managerB.isLocked("shared-logical-key")).toBe(true);
    await expect(managerB.acquire("shared-logical-key", { waitMs: 0 }))
      .rejects.toBeInstanceOf(LockTimeoutError);

    const isolatedHandle = await isolated.acquire("shared-logical-key", { waitMs: 0 });
    expect(isolatedHandle.released).toBe(false);
    await held.release();
    expect(await managerB.isLocked("shared-logical-key")).toBe(false);
    const replacement = await managerB.acquire("shared-logical-key");
    expect(replacement.fencingToken).not.toBe(held.fencingToken);
    await replacement.release();
    await isolatedHandle.release();
  });

  it("expires and unlocks application leases", async () => {
    vi.useFakeTimers();
    const { manager, pool } = createPostgresManager({ defaultTtlMs: 20 });
    const handle = await manager.acquire("expiring");
    await vi.advanceTimersByTimeAsync(21);
    expect(handle.released).toBe(true);
    expect(pool.coordinator.locks.size).toBe(0);
    expect(manager.getMetrics()).toMatchObject({ totalExpired: 1, currentActive: 0 });
  });

  it("checks session health on heartbeat and extends expiry", async () => {
    vi.useFakeTimers();
    const { manager } = createPostgresManager({ defaultTtlMs: 20 });
    const handle = await manager.acquire("healthy");
    await handle.heartbeat(100);
    await vi.advanceTimersByTimeAsync(25);
    expect(handle.released).toBe(false);
    await handle.release();
  });

  it("unlocks rather than renewing an elapsed PostgreSQL application lease", async () => {
    const { manager, pool } = createPostgresManager({ defaultTtlMs: 1000 });
    const handle = await manager.acquire("stale-heartbeat");
    handle.expiresAt = new Date(Date.now() - 1);
    await expect(handle.heartbeat(1000)).rejects.toBeInstanceOf(LockReleasedError);
    expect(handle.released).toBe(true);
    expect(pool.coordinator.locks.size).toBe(0);
    expect(manager.getMetrics()).toMatchObject({ totalExpired: 1, currentActive: 0 });
  });

  it("fails closed with sanitized backend errors and destroys failed clients", async () => {
    const { manager, pool } = createPostgresManager();
    const handle = await manager.acquire("release-error");
    pool.clients[0].failUnlock = true;
    const releaseError = await handle.release().catch((error) => error);
    expect(releaseError).toEqual(expect.objectContaining({
      name: "PostgresLockBackendError",
      operation: "release"
    }));
    expect(String(releaseError)).not.toContain("sensitive backend detail");
    expect(pool.clients[0].destroyed).toBe(true);
  });

  it("invalidates a handle when its PostgreSQL session disconnects", async () => {
    const { manager, pool } = createPostgresManager();
    const handle = await manager.acquire("disconnect");
    pool.clients[0].emit("error", new Error("network detail"));
    expect(handle.released).toBe(true);
    await expect(handle.heartbeat()).rejects.toBeInstanceOf(LockReleasedError);
    expect(manager.getMetrics().totalBackendErrors).toBe(1);
  });

  it("observes and detaches injected PostgreSQL pool errors", async () => {
    const { manager, pool } = createPostgresManager();
    expect(pool.listenerCount("error")).toBe(1);
    pool.emit("error", new Error("private pool detail"));
    expect(manager.getMetrics().totalBackendErrors).toBe(1);
    await manager.destroy();
    expect(pool.listenerCount("error")).toBe(0);
    expect(pool.ended).toBe(false);
  });

  it("bounds manager-owned PostgreSQL pool shutdown", async () => {
    const pool = new MockPgPool();
    let settleEnd;
    pool.end = () => new Promise((resolve) => {
      settleEnd = resolve;
    });
    const manager = new PostgresLockManager({ pool, queryTimeoutMs: 5 });
    const resource = { manager };
    resources.push(resource);
    manager._ownsPool = true;

    const error = await manager.destroy().catch((failure) => failure);
    expect(error).toMatchObject({
      name: "PostgresLockBackendError",
      operation: "destroy"
    });
    expect(pool.listenerCount("error")).toBe(1);
    expect(() => pool.emit("error", new Error("late pool detail"))).not.toThrow();
    settleEnd();
    await vi.waitFor(() => expect(pool.listenerCount("error")).toBe(0));
    resource.manager = null;
  });

  it("bounds pool checkout and supports the async factory", async () => {
    vi.useFakeTimers();
    const blockedPool = new MockPgPool();
    blockedPool.pendingConnect = true;
    const { manager } = createPostgresManager({ pool: blockedPool, maxWaitMs: 5 });
    const pending = manager.acquire("pool-bound", { waitMs: 5 });
    const timeoutExpectation = expect(pending).rejects.toBeInstanceOf(LockTimeoutError);
    await vi.advanceTimersByTimeAsync(6);
    await timeoutExpectation;

    const factoryPool = new MockPgPool();
    const fromFactory = await createLockManagerAsync({ backend: "postgres", pool: factoryPool });
    resources.push({ manager: fromFactory });
    expect(fromFactory).toBeInstanceOf(PostgresLockManager);
  });

  it("rejects forged release handles", async () => {
    const { manager } = createPostgresManager();
    await manager.acquire("identity");
    await expect(manager.release({
      lockKey: "identity",
      fencingToken: "fence_postgres_0",
      released: false
    })).rejects.toBeInstanceOf(LockFencingError);
    expect(PostgresLockBackendError).toBeTypeOf("function");
  });

  it("cancels a pool checkout when destroy races with acquisition", async () => {
    const pool = new MockPgPool();
    pool.pendingConnect = true;
    const { manager } = createPostgresManager({ pool, maxWaitMs: 500 });
    const pending = manager.acquire("destroy-during-connect");
    await Promise.resolve();
    const destroying = manager.destroy();
    await expect(pending).rejects.toBeInstanceOf(LockManagerDestroyedError);
    await destroying;
    expect(manager.getMetrics()).toMatchObject({ currentActive: 0, currentWaiting: 0 });
    await expect(manager.acquire("after-destroy")).rejects.toBeInstanceOf(LockManagerDestroyedError);
  });

  it("cancels a pending PostgreSQL pool checkout from the caller signal", async () => {
    const pool = new MockPgPool();
    pool.pendingConnect = true;
    const { manager } = createPostgresManager({ pool, maxWaitMs: 500 });
    const controller = new AbortController();
    const pending = manager.acquire("abort-during-connect", { signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(LockAcquireAbortedError);
    expect(manager.getMetrics()).toMatchObject({ currentActive: 0, currentWaiting: 0 });
  });

  it("destroys a PostgreSQL session when caller aborts an acquire query", async () => {
    let releaseQuery;
    const queryBarrier = new Promise((resolve) => {
      releaseQuery = resolve;
    });
    class AbortQueryClient extends MockPgClient {
      async query(sql, params = []) {
        if (sql.includes("pg_try_advisory_lock") && sql.includes("pg_current_xact_id")) {
          await queryBarrier;
          if (this.destroyed) throw new Error("destroyed client detail");
        }
        return super.query(sql, params);
      }
    }
    class AbortQueryPool extends MockPgPool {
      async connect() {
        const client = new AbortQueryClient(this.coordinator);
        this.clients.push(client);
        return client;
      }
    }
    const pool = new AbortQueryPool();
    const { manager } = createPostgresManager({ pool, maxWaitMs: 500 });
    const controller = new AbortController();
    const pending = manager.acquire("abort-during-query", { signal: controller.signal });
    await vi.waitFor(() => expect(pool.clients).toHaveLength(1));
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(LockAcquireAbortedError);
    expect(pool.clients[0].destroyed).toBe(true);
    releaseQuery();
    await Promise.resolve();
    expect(pool.coordinator.locks.size).toBe(0);
  });

  it("does not return a handle when destroy races with an acquire query", async () => {
    let releaseAcquireQuery;
    const acquireBarrier = new Promise((resolve) => {
      releaseAcquireQuery = resolve;
    });
    class BlockingClient extends MockPgClient {
      async query(sql, params = []) {
        if (sql.includes("pg_try_advisory_lock") && sql.includes("pg_current_xact_id")) {
          await acquireBarrier;
          if (this.destroyed) throw new Error("destroyed client");
        }
        return super.query(sql, params);
      }
    }
    class BlockingPool extends MockPgPool {
      async connect() {
        const client = new BlockingClient(this.coordinator);
        this.clients.push(client);
        return client;
      }
    }
    const pool = new BlockingPool();
    const { manager } = createPostgresManager({ pool, maxWaitMs: 500 });
    const pending = manager.acquire("destroy-during-query");
    await vi.waitFor(() => {
      expect(pool.clients).toHaveLength(1);
    });
    const destroying = manager.destroy();
    await expect(pending).rejects.toBeInstanceOf(LockManagerDestroyedError);
    await destroying;
    expect(pool.clients[0].destroyed).toBe(true);
    releaseAcquireQuery();
    await Promise.resolve();
    expect(pool.coordinator.locks.size).toBe(0);
    expect(manager.getMetrics()).toMatchObject({ currentActive: 0, currentWaiting: 0 });
  });

  it("releases polling clients so a contended key cannot starve unrelated keys", async () => {
    class LimitedPool extends EventEmitter {
      constructor(max = 2) {
        super();
        this.max = max;
        this.active = 0;
        this.waiters = [];
        this.coordinator = { locks: new Map(), nextFence: 500n };
        this.clients = [];
      }

      connect() {
        if (this.active < this.max) return Promise.resolve(this._createClient());
        return new Promise((resolve) => this.waiters.push(resolve));
      }

      _createClient() {
        this.active++;
        const pool = this;
        const client = new MockPgClient(this.coordinator);
        const baseRelease = client.release.bind(client);
        let returned = false;
        client.release = (destroy = false) => {
          if (returned) return;
          returned = true;
          baseRelease(destroy);
          pool.active--;
          const next = pool.waiters.shift();
          if (next) next(pool._createClient());
        };
        this.clients.push(client);
        return client;
      }
    }
    const pool = new LimitedPool(2);
    const { manager } = createPostgresManager({
      pool,
      maxWaitMs: 500,
      retryIntervalMs: 50,
      queryTimeoutMs: 50
    });
    const heldA = await manager.acquire("hot-key");
    const waitingA = manager.acquire("hot-key");
    await vi.waitFor(() => {
      expect(manager.getMetrics().currentWaiting).toBe(1);
      expect(pool.active).toBe(1);
    });

    const heldB = await manager.acquire("independent-key", { waitMs: 100 });
    expect(heldB.released).toBe(false);
    await heldB.release();
    await heldA.release();
    const promotedA = await waitingA;
    await promotedA.release();
    expect(pool.active).toBe(0);
  });

  it("bounds PostgreSQL contention per key without rejecting an independent key", async () => {
    const { manager } = createPostgresManager({
      maxQueueDepth: 1,
      maxWaitMs: 500,
      retryIntervalMs: 20
    });
    const held = await manager.acquire("bounded-hot-key");
    const queued = manager.acquire("bounded-hot-key");
    await vi.waitFor(() => expect(manager.getMetrics().currentWaiting).toBe(1));
    await expect(manager.acquire("bounded-hot-key")).rejects.toBeInstanceOf(LockQueueFullError);

    const independent = await manager.acquire("bounded-independent-key");
    await independent.release();
    await held.release();
    await (await queued).release();
  });

  it("bounds acquire, heartbeat, release, and destroy backend queries", async () => {
    class HangingClient extends MockPgClient {
      constructor(coordinator) {
        super(coordinator);
        this.hangAcquire = false;
        this.hangHeartbeat = false;
        this.hangUnlock = false;
      }

      query(sql, params = []) {
        if (this.hangAcquire && sql.includes("pg_try_advisory_lock") && sql.includes("pg_current_xact_id")) {
          return new Promise(() => {});
        }
        if (this.hangHeartbeat && sql.includes("SELECT 1 AS alive")) {
          return new Promise(() => {});
        }
        if (this.hangUnlock && sql.includes("pg_advisory_unlock")) {
          return new Promise(() => {});
        }
        return super.query(sql, params);
      }
    }
    class HangingPool extends MockPgPool {
      constructor() {
        super();
        this.nextMode = "";
      }

      async connect() {
        const client = new HangingClient(this.coordinator);
        client[`hang${this.nextMode}`] = true;
        this.nextMode = "";
        this.clients.push(client);
        return client;
      }
    }

    const acquirePool = new HangingPool();
    acquirePool.nextMode = "Acquire";
    const acquireManager = new PostgresLockManager({
      pool: acquirePool,
      maxWaitMs: 100,
      queryTimeoutMs: 5
    });
    resources.push({ manager: acquireManager });
    await expect(acquireManager.acquire("hung-acquire")).rejects.toBeInstanceOf(LockTimeoutError);
    expect(acquirePool.clients[0].destroyed).toBe(true);
    await acquireManager.destroy();

    const heartbeatPool = new HangingPool();
    const heartbeatManager = new PostgresLockManager({
      pool: heartbeatPool,
      defaultTtlMs: 100,
      queryTimeoutMs: 5
    });
    resources.push({ manager: heartbeatManager });
    const heartbeatHandle = await heartbeatManager.acquire("hung-heartbeat");
    heartbeatPool.clients[0].hangHeartbeat = true;
    await expect(heartbeatHandle.heartbeat()).rejects.toBeInstanceOf(PostgresLockBackendError);
    expect(heartbeatPool.clients[0].destroyed).toBe(true);

    const releasePool = new HangingPool();
    const releaseManager = new PostgresLockManager({ pool: releasePool, queryTimeoutMs: 5 });
    resources.push({ manager: releaseManager });
    const releaseHandle = await releaseManager.acquire("hung-release");
    releasePool.clients[0].hangUnlock = true;
    await expect(releaseHandle.release()).rejects.toBeInstanceOf(PostgresLockBackendError);
    expect(releasePool.clients[0].destroyed).toBe(true);

    const destroyPool = new HangingPool();
    const destroyManager = new PostgresLockManager({ pool: destroyPool, queryTimeoutMs: 5 });
    resources.push({ manager: destroyManager });
    const destroyHandle = await destroyManager.acquire("hung-destroy");
    destroyPool.clients[0].hangUnlock = true;
    await destroyManager.destroy();
    expect(destroyHandle.released).toBe(true);
    expect(destroyPool.clients[0].destroyed).toBe(true);
  });

  it("coalesces heartbeat, release, and destroy races on one PostgreSQL session", async () => {
    let observeHeartbeat;
    const heartbeatStarted = new Promise((resolve) => {
      observeHeartbeat = resolve;
    });
    let releaseHeartbeat;
    const heartbeatBarrier = new Promise((resolve) => {
      releaseHeartbeat = resolve;
    });
    class RacingClient extends MockPgClient {
      constructor(coordinator) {
        super(coordinator);
        this.unlockQueries = 0;
        this.releaseCalls = 0;
      }

      async query(sql, params = []) {
        if (sql.includes("SELECT 1 AS alive")) {
          observeHeartbeat();
          await heartbeatBarrier;
        }
        if (sql.includes("pg_advisory_unlock")) this.unlockQueries += 1;
        return super.query(sql, params);
      }

      release(destroy = false) {
        this.releaseCalls += 1;
        super.release(destroy);
      }
    }
    class RacingPool extends MockPgPool {
      async connect() {
        const client = new RacingClient(this.coordinator);
        this.clients.push(client);
        return client;
      }
    }
    const pool = new RacingPool();
    const { manager } = createPostgresManager({ pool, queryTimeoutMs: 200 });
    const handle = await manager.acquire("heartbeat-release-destroy-race");
    const heartbeat = handle.heartbeat(500);
    await heartbeatStarted;
    const releasing = handle.release();
    const destroying = manager.destroy();
    releaseHeartbeat();

    await expect(heartbeat).rejects.toBeInstanceOf(LockReleasedError);
    await releasing;
    await destroying;

    expect(pool.clients[0].unlockQueries).toBe(1);
    expect(pool.clients[0].releaseCalls).toBe(1);
    expect(handle.released).toBe(true);
    expect(manager.getMetrics()).toMatchObject({ currentActive: 0, totalReleased: 1 });
  });

  it("clears PostgreSQL retry timers when destroy cancels a contender", async () => {
    vi.useFakeTimers();
    const { manager } = createPostgresManager({
      defaultTtlMs: 1_000,
      maxWaitMs: 10_000,
      retryIntervalMs: 5_000
    });
    const held = await manager.acquire("retry-timer-cleanup");
    const pending = manager.acquire("retry-timer-cleanup");
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(manager.getMetrics().currentWaiting).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(1);

    const destroying = manager.destroy();
    await expect(pending).rejects.toBeInstanceOf(LockManagerDestroyedError);
    await destroying;
    expect(held.released).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

const backendContractCases = [
  ["memory", () => {
    const manager = new MemoryLockManager({
      defaultTtlMs: 30,
      heartbeatIntervalMs: 5,
      maxWaitMs: 250
    });
    resources.push({ manager });
    return manager;
  }],
  ["sqlite", () => {
    const db = new Database(":memory:");
    const manager = new SqliteLockManager({
      db,
      defaultTtlMs: 30,
      heartbeatIntervalMs: 5,
      maxWaitMs: 250,
      retryIntervalMs: 1,
      cleanupIntervalMs: 1000
    });
    resources.push({ db, manager });
    return manager;
  }],
  ["postgres fixture", () => {
    const manager = new PostgresLockManager({
      pool: new MockPgPool(),
      defaultTtlMs: 30,
      heartbeatIntervalMs: 5,
      maxWaitMs: 250,
      retryIntervalMs: 1
    });
    resources.push({ manager });
    return manager;
  }]
];

describe.each(backendContractCases)("%s lock backend contract", (_name, createManager) => {
  it("preserves exclusivity beyond the initial TTL and shuts down fail-closed", async () => {
    const manager = createManager();
    const first = await manager.acquire("backend-contract");
    const queued = manager.acquire("backend-contract");
    await vi.waitFor(() => {
      expect(manager.getMetrics().currentWaiting).toBe(1);
    });

    await first.heartbeat(90);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(first.released).toBe(false);
    expect(await manager.isLocked("backend-contract")).toBe(true);

    await first.release();
    const second = await queued;
    expect(second.fencingToken).not.toBe(first.fencingToken);
    expect(manager.getMetrics().currentWaiting).toBe(0);
    await second.release();

    const heldAtShutdown = await manager.acquire("shutdown-contract");
    await manager.destroy();
    expect(heldAtShutdown.released).toBe(true);
    await expect(manager.acquire("after-shutdown")).rejects.toBeInstanceOf(LockManagerDestroyedError);
  });

  it("cancels a queued acquisition without promoting it later", async () => {
    const manager = createManager();
    const held = await manager.acquire("abort-contract");
    const controller = new AbortController();
    const queued = manager.acquire("abort-contract", {
      waitMs: 200,
      signal: controller.signal
    });
    await vi.waitFor(() => expect(manager.getMetrics().currentWaiting).toBe(1));
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(LockAcquireAbortedError);
    expect(manager.getMetrics().currentWaiting).toBe(0);
    await held.release();
    expect(await manager.isLocked("abort-contract")).toBe(false);
  });
});
