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
} from "../../../packages/foundation/src/concurrency/lock-manager.ts";
import {
  PostgresLockBackendError,
  PostgresLockManager,
  postgresAdvisoryKey
} from "../../../packages/foundation/src/concurrency/postgres-lock-manager.ts";
import {
  SqliteLockBackendError,
  SqliteLockManager
} from "../../../packages/foundation/src/concurrency/sqlite-lock-manager.ts";

const resources: any[] = [];

afterEach(async () : Promise<any> => {
  vi.useRealTimers();
  await Promise.all(resources.splice(0).map(async (resource?: any) : Promise<any> => {
    await resource.manager?.destroy?.();
    resource.db?.close?.();
  }));
});

describe("memory lock manager", () : any => {
  it("fails closed for invalid configuration and unknown backends", async () : Promise<any> => {
    expect(() : any => new MemoryLockManager({ defaultTtlMs: 0 })).toThrow(TypeError);
    expect(() : any => createLockManager()).toThrow("backend must be selected explicitly");
    await expect(createLockManagerAsync()).rejects.toThrow("backend must be selected explicitly");
    expect(() : any => createLockManager({ backend: "unknown" })).toThrow("Unsupported lock manager backend");
    await expect(createLockManagerAsync({ backend: "unknown" })).rejects.toThrow("Unsupported lock manager backend");
    await expect(new MemoryLockManager().acquire(" ")).rejects.toThrow("Lock key must be a non-empty string");
  });

  it("uses FIFO promotion, preserves waiter TTL, and emits increasing fences", async () : Promise<any> => {
    vi.useFakeTimers();
    const manager: any = new MemoryLockManager({ defaultTtlMs: 100, maxWaitMs: 500 });
    resources.push({ manager });
    const first: any = await manager.acquire("shared");
    const queued: any = manager.acquire("shared", { ttlMs: 250 });

    await first.release();
    const second: any = await queued;
    expect(second.expiresAt.getTime() - second.acquiredAt.getTime()).toBe(250);
    expect(second.fencingToken).not.toBe(first.fencingToken);
    expect(manager.getMetrics()).toMatchObject({
      totalAcquired: 2,
      totalReleased: 1,
      currentActive: 1,
      currentWaiting: 0
    });
  });

  it("promotes a waiter on lease expiry and rejects stale heartbeats", async () : Promise<any> => {
    vi.useFakeTimers();
    const manager: any = new MemoryLockManager({ defaultTtlMs: 20, maxWaitMs: 100 });
    resources.push({ manager });
    const first: any = await manager.acquire("lease");
    const queued: any = manager.acquire("lease", { ttlMs: 50 });

    await vi.advanceTimersByTimeAsync(21);
    const second: any = await queued;
    expect(first.released).toBe(true);
    await expect(first.heartbeat()).rejects.toBeInstanceOf(LockReleasedError);
    expect(second.released).toBe(false);
    expect(manager.getMetrics()).toMatchObject({ totalExpired: 1, currentActive: 1 });
  });

  it("enforces immediate timeout, queue bounds, and fencing identity", async () : Promise<any> => {
    const manager: any = new MemoryLockManager({ maxQueueDepth: 1 });
    resources.push({ manager });
    const first: any = await manager.acquire("bounded");
    await expect(manager.acquire("bounded", { waitMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    const queued: any = manager.acquire("bounded", { waitMs: 1000 });
    await expect(manager.acquire("bounded", { waitMs: 1000 })).rejects.toBeInstanceOf(LockQueueFullError);
    const fencingError: any = await manager.release({
      lockKey: "bounded",
      fencingToken: "stale",
      released: false
    }).catch((error?: any) : any => error);
    expect(fencingError).toBeInstanceOf(LockFencingError);
    expect(String(fencingError)).not.toMatch(/bounded|stale/);
    expect(fencingError).not.toHaveProperty("token");
    await first.release();
    await (await queued).release();
  });

  it("never resurrects an already elapsed memory lease", async () : Promise<any> => {
    const manager: any = new MemoryLockManager({ defaultTtlMs: 1000 });
    resources.push({ manager });
    const handle: any = await manager.acquire("stale-heartbeat");
    handle.expiresAt = new Date(Date.now() - 1);
    await expect(handle.heartbeat(1000)).rejects.toBeInstanceOf(LockReleasedError);
    expect(handle.released).toBe(true);
    expect(manager.getMetrics()).toMatchObject({ totalExpired: 1, currentActive: 0 });
  });

  it("lazily expires a memory lease when its timer has not run yet", async () : Promise<any> => {
    vi.useFakeTimers();
    const manager: any = new MemoryLockManager({ defaultTtlMs: 20 });
    resources.push({ manager });
    const first: any = await manager.acquire("lazy-expiry");
    vi.setSystemTime(Date.now() + 21);

    expect(await manager.isLocked("lazy-expiry")).toBe(false);
    const replacement: any = await manager.acquire("lazy-expiry", { waitMs: 0 });
    expect(first.released).toBe(true);
    expect(replacement.fencingToken).not.toBe(first.fencingToken);
    expect(manager.getMetrics()).toMatchObject({ totalExpired: 1, currentActive: 1 });
  });
});

describe("SQLite lock manager", () : any => {
  function createSqliteManager(config: Record<string, any> = {}) : any {
    const db: any = new Database(":memory:");
    const manager: any = new SqliteLockManager({
      db,
      defaultTtlMs: 100,
      maxWaitMs: 0,
      cleanupIntervalMs: 1000,
      ...config
    });
    resources.push({ db, manager });
    return manager;
  }

  it("persists monotonic fences and rejects duplicate acquisition", async () : Promise<any> => {
    const manager: any = createSqliteManager();
    const first: any = await manager.acquire("durable", { ttlMs: 250 });
    expect(first.fencingToken).toBe("fence_sqlite_1");
    expect(first.expiresAt.getTime() - first.acquiredAt.getTime()).toBe(250);
    await expect(manager.acquire("durable", { waitMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    await first.release();
    const second: any = await manager.acquire("durable");
    expect(second.fencingToken).toBe("fence_sqlite_2");
  });

  it("extends a durable lease and marks released handles consistently", async () : Promise<any> => {
    vi.useFakeTimers();
    const manager: any = createSqliteManager({ defaultTtlMs: 20 });
    const handle: any = await manager.acquire("heartbeat");
    await handle.heartbeat(100);
    await vi.advanceTimersByTimeAsync(25);
    expect(await manager.isLocked("heartbeat")).toBe(true);
    await handle.release();
    expect(handle.released).toBe(true);
    await expect(handle.heartbeat()).rejects.toBeInstanceOf(LockReleasedError);
  });

  it("protects release with the fencing identity and releases locks on destroy", async () : Promise<any> => {
    const manager: any = createSqliteManager();
    const handle: any = await manager.acquire("identity");
    await expect(manager.release({
      lockKey: "identity",
      fencingToken: "fence_sqlite_0",
      released: false
    })).rejects.toBeInstanceOf(LockFencingError);
    await manager.destroy();
    expect(handle.released).toBe(true);
    await expect(manager.isLocked("identity")).rejects.toBeInstanceOf(LockManagerDestroyedError);
  });

  it("enforces queue depth and reports current SQLite waiters", async () : Promise<any> => {
    const manager: any = createSqliteManager({
      maxQueueDepth: 1,
      maxWaitMs: 250,
      retryIntervalMs: 1
    });
    const first: any = await manager.acquire("bounded");
    const queued: any = manager.acquire("bounded");
    await vi.waitFor(() : any => {
      expect(manager.getMetrics().currentWaiting).toBe(1);
    });
    await expect(manager.acquire("bounded")).rejects.toBeInstanceOf(LockQueueFullError);
    await first.release();
    const second: any = await queued;
    expect(manager.getMetrics().currentWaiting).toBe(0);
    await second.release();
  });

  it("promotes SQLite contenders in FIFO order", async () : Promise<any> => {
    const manager: any = createSqliteManager({
      maxQueueDepth: 3,
      maxWaitMs: 500,
      retryIntervalMs: 1
    });
    const first: any = await manager.acquire("sqlite-fifo");
    const order: any[] = [];
    const secondPending: any = manager.acquire("sqlite-fifo").then((handle?: any) : any => {
      order.push("second");
      return handle;
    });
    const thirdPending: any = manager.acquire("sqlite-fifo").then((handle?: any) : any => {
      order.push("third");
      return handle;
    });
    await vi.waitFor(() : any => expect(manager.getMetrics().currentWaiting).toBe(2));

    await first.release();
    const second: any = await secondPending;
    expect(order).toEqual(["second"]);
    await second.release();
    const third: any = await thirdPending;
    expect(order).toEqual(["second", "third"]);
    await third.release();
  });

  it("never resurrects an expired durable row through heartbeat", async () : Promise<any> => {
    const manager: any = createSqliteManager({ defaultTtlMs: 1000 });
    const handle: any = await manager.acquire("stale-heartbeat");
    manager.db.prepare("UPDATE _meshrix_locks SET expires_at = ? WHERE lock_key = ?")
      .run(new Date(Date.now() - 1).toISOString(), handle.lockKey);
    await expect(handle.heartbeat(1000)).rejects.toBeInstanceOf(LockReleasedError);
    expect(handle.released).toBe(true);
    const replacement: any = await manager.acquire("stale-heartbeat");
    expect(replacement.fencingToken).not.toBe(handle.fencingToken);
    await replacement.release();
  });

  it("sanitizes SQLite backend failures", async () : Promise<any> => {
    const manager: any = createSqliteManager();
    const handle: any = await manager.acquire("private-sqlite-key");
    const prepare: any = manager.db.prepare.bind(manager.db);
    manager.db.prepare = (sql?: any) : any => {
      if (String(sql).includes("SELECT fencing_token, expires_at")) {
        throw new Error("private sqlite backend detail");
      }
      return prepare(sql);
    };

    const error: any = await handle.release().catch((failure?: any) : any => failure);
    manager.db.prepare = prepare;
    expect(error).toBeInstanceOf(SqliteLockBackendError);
    expect(String(error)).not.toMatch(/private-sqlite-key|private sqlite backend detail/);
    expect(manager.getMetrics().totalBackendErrors).toBe(1);
  });

  it("rejects queued waiters immediately when SQLite shutdown begins", async () : Promise<any> => {
    const manager: any = createSqliteManager({
      maxWaitMs: 10_000,
      retryIntervalMs: 5_000
    });
    const first: any = await manager.acquire("shutdown-waiter");
    const queued: any = manager.acquire("shutdown-waiter");
    await vi.waitFor(() : any => expect(manager.getMetrics().currentWaiting).toBe(1));

    const destroying: any = manager.destroy();
    await expect(queued).rejects.toBeInstanceOf(LockManagerDestroyedError);
    await destroying;
    expect(first.released).toBe(true);
    expect(manager.getMetrics()).toMatchObject({ currentActive: 0, currentWaiting: 0 });
  });

  it("cleans every local handle when one SQLite destroy delete fails", async () : Promise<any> => {
    const db: any = new Database(":memory:");
    const manager: any = new SqliteLockManager({ db, cleanupIntervalMs: 1000 });
    const resource: Record<string, any> = { db, manager };
    resources.push(resource);
    const first: any = await manager.acquire("destroy-failure-one");
    const second: any = await manager.acquire("destroy-failure-two");
    const prepare: any = db.prepare.bind(db);
    let shouldFail: any = true;
    manager.db.prepare = (sql?: any) : any => {
      const statement: any = prepare(sql);
      if (!/^DELETE FROM _meshrix_locks WHERE lock_key = \? AND fencing_token = \?$/.test(
        String(sql).trim().replace(/\s+/g, " ")
      )) return statement;
      return new Proxy(statement, {
        get(target?: any, property?: any) : any {
          if (property !== "run") {
            const value: any = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (...args: any[]) : any => {
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
    expect(String(await manager.destroy().catch((error?: any) : any => error))).not.toContain("private backend detail");

    resource.manager = null;
    resource.db = null;
    db.close();
  });

  it("uses one backoff poller for a hot SQLite key", async () : Promise<any> => {
    const manager: any = createSqliteManager({
      maxQueueDepth: 100,
      maxWaitMs: 80,
      retryIntervalMs: 5,
      maxRetryIntervalMs: 40,
      random: () : any => 1
    });
    const now: any = new Date();
    manager.db.prepare(`
      INSERT INTO _meshrix_locks
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
    const attempt: any = manager._tryAcquire;
    let attempts: any = 0;
    manager._tryAcquire = (input?: any) : any => {
      attempts++;
      return attempt(input);
    };

    const settled: any = await Promise.allSettled(
      Array.from({ length: 50 }, () : any => manager.acquire("hot-external"))
    );
    expect(settled.every((entry?: any) : any => entry.status === "rejected" && entry.reason instanceof LockTimeoutError))
      .toBe(true);
    expect(attempts).toBeLessThan(15);
    expect(manager.getMetrics().currentWaiting).toBe(0);
  });

  it("coordinates leases, fences, and instance shutdown across SQLite connections", async () : Promise<any> => {
    const root: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-sqlite-lock-cross-instance-"));
    const databasePath: any = path.join(root, "locks.sqlite");
    const dbA: any = new Database(databasePath);
    const dbB: any = new Database(databasePath);
    const managerA: any = new SqliteLockManager({
      db: dbA,
      defaultTtlMs: 500,
      maxWaitMs: 1_000,
      retryIntervalMs: 1,
      cleanupIntervalMs: 1000
    });
    const managerB: any = new SqliteLockManager({
      db: dbB,
      defaultTtlMs: 500,
      maxWaitMs: 1_000,
      retryIntervalMs: 1,
      cleanupIntervalMs: 1000
    });
    try {
      const heldByA: any = await managerA.acquire("cross-instance-shared");
      const independentB: any = await managerB.acquire("cross-instance-independent", { ttlMs: 2_000 });
      let replacementSettled: any = false;
      const replacementPending: any = managerB.acquire("cross-instance-shared").then((handle?: any) : any => {
        replacementSettled = true;
        return handle;
      });
      await vi.waitFor(() : any => expect(managerB.getMetrics().currentWaiting).toBe(1));

      await heldByA.heartbeat(500);
      await new Promise((resolve?: any) : any => setTimeout(resolve, 40));
      expect(replacementSettled).toBe(false);
      await managerA.destroy();

      const replacement: any = await replacementPending;
      expect(replacement.fencingToken).not.toBe(heldByA.fencingToken);
      expect(independentB.released).toBe(false);
      expect(await managerB.isLocked("cross-instance-independent")).toBe(true);
      await replacement.release();
      await independentB.release();
    } finally {
      await managerA.destroy().catch(() : any => {});
      await managerB.destroy().catch(() : any => {});
      dbA.close();
      dbB.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

class MockPgClient extends EventEmitter {
  coordinator: any;
  destroyed: any;
  failUnlock: any;
  released: any;
  constructor(coordinator?: any) {
    super();
    this.coordinator = coordinator;
    this.released = false;
    this.destroyed = false;
    this.failUnlock = false;
  }

  async query(sql?: any, params: any = []) : Promise<any> {
    const key: any = params.join(":");
    if (sql.includes("pg_try_advisory_lock")) {
      const owner: any = this.coordinator.locks.get(key);
      const acquired: any = !owner || owner === this;
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
      const unlocked: any = this.coordinator.locks.get(key) === this;
      if (unlocked) this.coordinator.locks.delete(key);
      return { rows: [{ unlocked }] };
    }
    return { rows: [{ alive: 1 }] };
  }

  release(destroy: any = false) : any {
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
  clients: any;
  coordinator: any;
  ended: any;
  pendingConnect: any;
  constructor() {
    super();
    this.coordinator = { locks: new Map<any, any>(), nextFence: 100n };
    this.clients = [];
    this.ended = false;
    this.pendingConnect = false;
  }

  async connect() : Promise<any> {
    if (this.pendingConnect) return new Promise(() : any => {});
    const client: any = new MockPgClient(this.coordinator);
    this.clients.push(client);
    return client;
  }

  async end() : Promise<any> {
    this.ended = true;
  }
}

describe("PostgreSQL lock manager", () : any => {
  function createPostgresManager(config: Record<string, any> = {}) : any {
    const pool: any = config.pool || new MockPgPool();
    const manager: any = new PostgresLockManager({
      pool,
      defaultTtlMs: 100,
      maxWaitMs: 20,
      retryIntervalMs: 5,
      ...config
    });
    resources.push({ manager });
    return { manager, pool };
  }

  it("rejects injected pools that cannot report and detach backend errors", () : any => {
    expect(() : any => new PostgresLockManager({
      pool: { connect: async () : Promise<any> => null }
    })).toThrow("EventEmitter listener methods");
  });

  it("hashes stable namespaced advisory keys without exposing source keys", () : any => {
    expect(postgresAdvisoryKey("alpha")).toEqual(postgresAdvisoryKey("alpha"));
    expect(postgresAdvisoryKey("alpha", "one")).not.toEqual(postgresAdvisoryKey("alpha", "two"));
    expect(postgresAdvisoryKey("alpha")).toHaveLength(2);
  });

  it("holds a dedicated session, times out contenders, and increments fences", async () : Promise<any> => {
    const { manager } = createPostgresManager();
    const first: any = await manager.acquire("distributed");
    expect(first.fencingToken).toBe("fence_postgres_100");
    await expect(manager.acquire("distributed", { waitMs: 0 })).rejects.toBeInstanceOf(LockTimeoutError);
    await first.release();
    const second: any = await manager.acquire("distributed");
    expect(second.fencingToken).toBe("fence_postgres_101");
    expect(await manager.isLocked("distributed")).toBe(true);
  });

  it("coordinates managers by namespace and inspects externally held locks", async () : Promise<any> => {
    const pool: any = new MockPgPool();
    const managerA: any = new PostgresLockManager({ pool, namespace: "deployment-a", maxWaitMs: 50 });
    const managerB: any = new PostgresLockManager({ pool, namespace: "deployment-a", maxWaitMs: 50 });
    const isolated: any = new PostgresLockManager({ pool, namespace: "deployment-b", maxWaitMs: 50 });
    resources.push({ manager: managerA }, { manager: managerB }, { manager: isolated });

    const held: any = await managerA.acquire("shared-logical-key");
    expect(await managerB.isLocked("shared-logical-key")).toBe(true);
    await expect(managerB.acquire("shared-logical-key", { waitMs: 0 }))
      .rejects.toBeInstanceOf(LockTimeoutError);

    const isolatedHandle: any = await isolated.acquire("shared-logical-key", { waitMs: 0 });
    expect(isolatedHandle.released).toBe(false);
    await held.release();
    expect(await managerB.isLocked("shared-logical-key")).toBe(false);
    const replacement: any = await managerB.acquire("shared-logical-key");
    expect(replacement.fencingToken).not.toBe(held.fencingToken);
    await replacement.release();
    await isolatedHandle.release();
  });

  it("expires and unlocks application leases", async () : Promise<any> => {
    vi.useFakeTimers();
    const { manager, pool } = createPostgresManager({ defaultTtlMs: 20 });
    const handle: any = await manager.acquire("expiring");
    await vi.advanceTimersByTimeAsync(21);
    expect(handle.released).toBe(true);
    expect(pool.coordinator.locks.size).toBe(0);
    expect(manager.getMetrics()).toMatchObject({ totalExpired: 1, currentActive: 0 });
  });

  it("checks session health on heartbeat and extends expiry", async () : Promise<any> => {
    vi.useFakeTimers();
    const { manager } = createPostgresManager({ defaultTtlMs: 20 });
    const handle: any = await manager.acquire("healthy");
    await handle.heartbeat(100);
    await vi.advanceTimersByTimeAsync(25);
    expect(handle.released).toBe(false);
    await handle.release();
  });

  it("unlocks rather than renewing an elapsed PostgreSQL application lease", async () : Promise<any> => {
    const { manager, pool } = createPostgresManager({ defaultTtlMs: 1000 });
    const handle: any = await manager.acquire("stale-heartbeat");
    handle.expiresAt = new Date(Date.now() - 1);
    await expect(handle.heartbeat(1000)).rejects.toBeInstanceOf(LockReleasedError);
    expect(handle.released).toBe(true);
    expect(pool.coordinator.locks.size).toBe(0);
    expect(manager.getMetrics()).toMatchObject({ totalExpired: 1, currentActive: 0 });
  });

  it("fails closed with sanitized backend errors and destroys failed clients", async () : Promise<any> => {
    const { manager, pool } = createPostgresManager();
    const handle: any = await manager.acquire("release-error");
    pool.clients[0].failUnlock = true;
    const releaseError: any = await handle.release().catch((error?: any) : any => error);
    expect(releaseError).toEqual(expect.objectContaining({
      name: "PostgresLockBackendError",
      operation: "release"
    }));
    expect(String(releaseError)).not.toContain("sensitive backend detail");
    expect(pool.clients[0].destroyed).toBe(true);
  });

  it("invalidates a handle when its PostgreSQL session disconnects", async () : Promise<any> => {
    const { manager, pool } = createPostgresManager();
    const handle: any = await manager.acquire("disconnect");
    pool.clients[0].emit("error", new Error("network detail"));
    expect(handle.released).toBe(true);
    await expect(handle.heartbeat()).rejects.toBeInstanceOf(LockReleasedError);
    expect(manager.getMetrics().totalBackendErrors).toBe(1);
  });

  it("observes and detaches injected PostgreSQL pool errors", async () : Promise<any> => {
    const { manager, pool } = createPostgresManager();
    expect(pool.listenerCount("error")).toBe(1);
    pool.emit("error", new Error("private pool detail"));
    expect(manager.getMetrics().totalBackendErrors).toBe(1);
    await manager.destroy();
    expect(pool.listenerCount("error")).toBe(0);
    expect(pool.ended).toBe(false);
  });

  it("bounds manager-owned PostgreSQL pool shutdown", async () : Promise<any> => {
    const pool: any = new MockPgPool();
    let settleEnd: any;
    pool.end = () : any => new Promise((resolve?: any) : any => {
      settleEnd = resolve;
    });
    const manager: any = new PostgresLockManager({ pool, queryTimeoutMs: 5 });
    const resource: Record<string, any> = { manager };
    resources.push(resource);
    manager._ownsPool = true;

    const error: any = await manager.destroy().catch((failure?: any) : any => failure);
    expect(error).toMatchObject({
      name: "PostgresLockBackendError",
      operation: "destroy"
    });
    expect(pool.listenerCount("error")).toBe(1);
    expect(() : any => pool.emit("error", new Error("late pool detail"))).not.toThrow();
    settleEnd();
    await vi.waitFor(() : any => expect(pool.listenerCount("error")).toBe(0));
    resource.manager = null;
  });

  it("bounds pool checkout and supports the async factory", async () : Promise<any> => {
    vi.useFakeTimers();
    const blockedPool: any = new MockPgPool();
    blockedPool.pendingConnect = true;
    const { manager } = createPostgresManager({ pool: blockedPool, maxWaitMs: 5 });
    const pending: any = manager.acquire("pool-bound", { waitMs: 5 });
    const timeoutExpectation: any = expect(pending).rejects.toBeInstanceOf(LockTimeoutError);
    await vi.advanceTimersByTimeAsync(6);
    await timeoutExpectation;

    const factoryPool: any = new MockPgPool();
    const fromFactory: any = await createLockManagerAsync({ backend: "postgres", pool: factoryPool });
    resources.push({ manager: fromFactory });
    expect(fromFactory).toBeInstanceOf(PostgresLockManager);
  });

  it("rejects forged release handles", async () : Promise<any> => {
    const { manager } = createPostgresManager();
    await manager.acquire("identity");
    await expect(manager.release({
      lockKey: "identity",
      fencingToken: "fence_postgres_0",
      released: false
    })).rejects.toBeInstanceOf(LockFencingError);
    expect(PostgresLockBackendError).toBeTypeOf("function");
  });

  it("cancels a pool checkout when destroy races with acquisition", async () : Promise<any> => {
    const pool: any = new MockPgPool();
    pool.pendingConnect = true;
    const { manager } = createPostgresManager({ pool, maxWaitMs: 500 });
    const pending: any = manager.acquire("destroy-during-connect");
    await Promise.resolve();
    const destroying: any = manager.destroy();
    await expect(pending).rejects.toBeInstanceOf(LockManagerDestroyedError);
    await destroying;
    expect(manager.getMetrics()).toMatchObject({ currentActive: 0, currentWaiting: 0 });
    await expect(manager.acquire("after-destroy")).rejects.toBeInstanceOf(LockManagerDestroyedError);
  });

  it("cancels a pending PostgreSQL pool checkout from the caller signal", async () : Promise<any> => {
    const pool: any = new MockPgPool();
    pool.pendingConnect = true;
    const { manager } = createPostgresManager({ pool, maxWaitMs: 500 });
    const controller: any = new AbortController();
    const pending: any = manager.acquire("abort-during-connect", { signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(LockAcquireAbortedError);
    expect(manager.getMetrics()).toMatchObject({ currentActive: 0, currentWaiting: 0 });
  });

  it("destroys a PostgreSQL session when caller aborts an acquire query", async () : Promise<any> => {
    let releaseQuery: any;
    const queryBarrier: any = new Promise((resolve?: any) : any => {
      releaseQuery = resolve;
    });
    class AbortQueryClient extends MockPgClient {
      async query(sql?: any, params: any = []) : Promise<any> {
        if (sql.includes("pg_try_advisory_lock") && sql.includes("pg_current_xact_id")) {
          await queryBarrier;
          if (this.destroyed) throw new Error("destroyed client detail");
        }
        return super.query(sql, params);
      }
    }
    class AbortQueryPool extends MockPgPool {
      async connect() : Promise<any> {
        const client: any = new AbortQueryClient(this.coordinator);
        this.clients.push(client);
        return client;
      }
    }
    const pool: any = new AbortQueryPool();
    const { manager } = createPostgresManager({ pool, maxWaitMs: 500 });
    const controller: any = new AbortController();
    const pending: any = manager.acquire("abort-during-query", { signal: controller.signal });
    await vi.waitFor(() : any => expect(pool.clients).toHaveLength(1));
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(LockAcquireAbortedError);
    expect(pool.clients[0].destroyed).toBe(true);
    releaseQuery();
    await Promise.resolve();
    expect(pool.coordinator.locks.size).toBe(0);
  });

  it("does not return a handle when destroy races with an acquire query", async () : Promise<any> => {
    let releaseAcquireQuery: any;
    const acquireBarrier: any = new Promise((resolve?: any) : any => {
      releaseAcquireQuery = resolve;
    });
    class BlockingClient extends MockPgClient {
      async query(sql?: any, params: any = []) : Promise<any> {
        if (sql.includes("pg_try_advisory_lock") && sql.includes("pg_current_xact_id")) {
          await acquireBarrier;
          if (this.destroyed) throw new Error("destroyed client");
        }
        return super.query(sql, params);
      }
    }
    class BlockingPool extends MockPgPool {
      async connect() : Promise<any> {
        const client: any = new BlockingClient(this.coordinator);
        this.clients.push(client);
        return client;
      }
    }
    const pool: any = new BlockingPool();
    const { manager } = createPostgresManager({ pool, maxWaitMs: 500 });
    const pending: any = manager.acquire("destroy-during-query");
    await vi.waitFor(() : any => {
      expect(pool.clients).toHaveLength(1);
    });
    const destroying: any = manager.destroy();
    await expect(pending).rejects.toBeInstanceOf(LockManagerDestroyedError);
    await destroying;
    expect(pool.clients[0].destroyed).toBe(true);
    releaseAcquireQuery();
    await Promise.resolve();
    expect(pool.coordinator.locks.size).toBe(0);
    expect(manager.getMetrics()).toMatchObject({ currentActive: 0, currentWaiting: 0 });
  });

  it("releases polling clients so a contended key cannot starve unrelated keys", async () : Promise<any> => {
    class LimitedPool extends EventEmitter {
  active: any;
  clients: any;
  coordinator: any;
  max: any;
  waiters: any;
      constructor(max: any = 2) {
        super();
        this.max = max;
        this.active = 0;
        this.waiters = [];
        this.coordinator = { locks: new Map<any, any>(), nextFence: 500n };
        this.clients = [];
      }

      connect() : any {
        if (this.active < this.max) return Promise.resolve(this._createClient());
        return new Promise((resolve?: any) : any => this.waiters.push(resolve));
      }

      _createClient() : any {
        this.active++;
        const pool: any = this;
        const client: any = new MockPgClient(this.coordinator);
        const baseRelease: any = client.release.bind(client);
        let returned: any = false;
        client.release = (destroy: any = false) : any => {
          if (returned) return;
          returned = true;
          baseRelease(destroy);
          pool.active--;
          const next: any = pool.waiters.shift();
          if (next) next(pool._createClient());
        };
        this.clients.push(client);
        return client;
      }
    }
    const pool: any = new LimitedPool(2);
    const { manager } = createPostgresManager({
      pool,
      maxWaitMs: 500,
      retryIntervalMs: 50,
      queryTimeoutMs: 50
    });
    const heldA: any = await manager.acquire("hot-key");
    const waitingA: any = manager.acquire("hot-key");
    await vi.waitFor(() : any => {
      expect(manager.getMetrics().currentWaiting).toBe(1);
      expect(pool.active).toBe(1);
    });

    const heldB: any = await manager.acquire("independent-key", { waitMs: 100 });
    expect(heldB.released).toBe(false);
    await heldB.release();
    await heldA.release();
    const promotedA: any = await waitingA;
    await promotedA.release();
    expect(pool.active).toBe(0);
  });

  it("bounds PostgreSQL contention per key without rejecting an independent key", async () : Promise<any> => {
    const { manager } = createPostgresManager({
      maxQueueDepth: 1,
      maxWaitMs: 500,
      retryIntervalMs: 20
    });
    const held: any = await manager.acquire("bounded-hot-key");
    const queued: any = manager.acquire("bounded-hot-key");
    await vi.waitFor(() : any => expect(manager.getMetrics().currentWaiting).toBe(1));
    await expect(manager.acquire("bounded-hot-key")).rejects.toBeInstanceOf(LockQueueFullError);

    const independent: any = await manager.acquire("bounded-independent-key");
    await independent.release();
    await held.release();
    await (await queued).release();
  });

  it("bounds acquire, heartbeat, release, and destroy backend queries", async () : Promise<any> => {
    class HangingClient extends MockPgClient {
  hangAcquire: any;
  hangHeartbeat: any;
  hangUnlock: any;
      constructor(coordinator?: any) {
        super(coordinator);
        this.hangAcquire = false;
        this.hangHeartbeat = false;
        this.hangUnlock = false;
      }

      query(sql?: any, params: any = []) : any {
        if (this.hangAcquire && sql.includes("pg_try_advisory_lock") && sql.includes("pg_current_xact_id")) {
          return new Promise(() : any => {});
        }
        if (this.hangHeartbeat && sql.includes("SELECT 1 AS alive")) {
          return new Promise(() : any => {});
        }
        if (this.hangUnlock && sql.includes("pg_advisory_unlock")) {
          return new Promise(() : any => {});
        }
        return super.query(sql, params);
      }
    }
    class HangingPool extends MockPgPool {
  nextMode: any;
      constructor() {
        super();
        this.nextMode = "";
      }

      async connect() : Promise<any> {
        const client: any = new HangingClient(this.coordinator);
        client[`hang${this.nextMode}`] = true;
        this.nextMode = "";
        this.clients.push(client);
        return client;
      }
    }

    const acquirePool: any = new HangingPool();
    acquirePool.nextMode = "Acquire";
    const acquireManager: any = new PostgresLockManager({
      pool: acquirePool,
      maxWaitMs: 100,
      queryTimeoutMs: 5
    });
    resources.push({ manager: acquireManager });
    await expect(acquireManager.acquire("hung-acquire")).rejects.toBeInstanceOf(LockTimeoutError);
    expect(acquirePool.clients[0].destroyed).toBe(true);
    await acquireManager.destroy();

    const heartbeatPool: any = new HangingPool();
    const heartbeatManager: any = new PostgresLockManager({
      pool: heartbeatPool,
      defaultTtlMs: 100,
      queryTimeoutMs: 5
    });
    resources.push({ manager: heartbeatManager });
    const heartbeatHandle: any = await heartbeatManager.acquire("hung-heartbeat");
    heartbeatPool.clients[0].hangHeartbeat = true;
    await expect(heartbeatHandle.heartbeat()).rejects.toBeInstanceOf(PostgresLockBackendError);
    expect(heartbeatPool.clients[0].destroyed).toBe(true);

    const releasePool: any = new HangingPool();
    const releaseManager: any = new PostgresLockManager({ pool: releasePool, queryTimeoutMs: 5 });
    resources.push({ manager: releaseManager });
    const releaseHandle: any = await releaseManager.acquire("hung-release");
    releasePool.clients[0].hangUnlock = true;
    await expect(releaseHandle.release()).rejects.toBeInstanceOf(PostgresLockBackendError);
    expect(releasePool.clients[0].destroyed).toBe(true);

    const destroyPool: any = new HangingPool();
    const destroyManager: any = new PostgresLockManager({ pool: destroyPool, queryTimeoutMs: 5 });
    resources.push({ manager: destroyManager });
    const destroyHandle: any = await destroyManager.acquire("hung-destroy");
    destroyPool.clients[0].hangUnlock = true;
    await destroyManager.destroy();
    expect(destroyHandle.released).toBe(true);
    expect(destroyPool.clients[0].destroyed).toBe(true);
  });

  it("coalesces heartbeat, release, and destroy races on one PostgreSQL session", async () : Promise<any> => {
    let observeHeartbeat: any;
    const heartbeatStarted: any = new Promise((resolve?: any) : any => {
      observeHeartbeat = resolve;
    });
    let releaseHeartbeat: any;
    const heartbeatBarrier: any = new Promise((resolve?: any) : any => {
      releaseHeartbeat = resolve;
    });
    class RacingClient extends MockPgClient {
  releaseCalls: any;
  unlockQueries: any;
      constructor(coordinator?: any) {
        super(coordinator);
        this.unlockQueries = 0;
        this.releaseCalls = 0;
      }

      async query(sql?: any, params: any = []) : Promise<any> {
        if (sql.includes("SELECT 1 AS alive")) {
          observeHeartbeat();
          await heartbeatBarrier;
        }
        if (sql.includes("pg_advisory_unlock")) this.unlockQueries += 1;
        return super.query(sql, params);
      }

      release(destroy: any = false) : any {
        this.releaseCalls += 1;
        super.release(destroy);
      }
    }
    class RacingPool extends MockPgPool {
      async connect() : Promise<any> {
        const client: any = new RacingClient(this.coordinator);
        this.clients.push(client);
        return client;
      }
    }
    const pool: any = new RacingPool();
    const { manager } = createPostgresManager({ pool, queryTimeoutMs: 200 });
    const handle: any = await manager.acquire("heartbeat-release-destroy-race");
    const heartbeat: any = handle.heartbeat(500);
    await heartbeatStarted;
    const releasing: any = handle.release();
    const destroying: any = manager.destroy();
    releaseHeartbeat();

    await expect(heartbeat).rejects.toBeInstanceOf(LockReleasedError);
    await releasing;
    await destroying;

    expect(pool.clients[0].unlockQueries).toBe(1);
    expect(pool.clients[0].releaseCalls).toBe(1);
    expect(handle.released).toBe(true);
    expect(manager.getMetrics()).toMatchObject({ currentActive: 0, totalReleased: 1 });
  });

  it("clears PostgreSQL retry timers when destroy cancels a contender", async () : Promise<any> => {
    vi.useFakeTimers();
    const { manager } = createPostgresManager({
      defaultTtlMs: 1_000,
      maxWaitMs: 10_000,
      retryIntervalMs: 5_000
    });
    const held: any = await manager.acquire("retry-timer-cleanup");
    const pending: any = manager.acquire("retry-timer-cleanup");
    for (let index: any = 0; index < 8; index++) await Promise.resolve();
    expect(manager.getMetrics().currentWaiting).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(1);

    const destroying: any = manager.destroy();
    await expect(pending).rejects.toBeInstanceOf(LockManagerDestroyedError);
    await destroying;
    expect(held.released).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

const backendContractCases: any[] = [
  ["memory", () : any => {
    const manager: any = new MemoryLockManager({
      defaultTtlMs: 30,
      heartbeatIntervalMs: 5,
      maxWaitMs: 250
    });
    resources.push({ manager });
    return manager;
  }],
  ["sqlite", () : any => {
    const db: any = new Database(":memory:");
    const manager: any = new SqliteLockManager({
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
  ["postgres fixture", () : any => {
    const manager: any = new PostgresLockManager({
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

describe.each(backendContractCases)("%s lock backend contract", (_name?: any, createManager?: any) : any => {
  it("preserves exclusivity beyond the initial TTL and shuts down fail-closed", async () : Promise<any> => {
    const manager: any = createManager();
    const first: any = await manager.acquire("backend-contract");
    const queued: any = manager.acquire("backend-contract");
    await vi.waitFor(() : any => {
      expect(manager.getMetrics().currentWaiting).toBe(1);
    });

    await first.heartbeat(90);
    await new Promise((resolve?: any) : any => setTimeout(resolve, 40));
    expect(first.released).toBe(false);
    expect(await manager.isLocked("backend-contract")).toBe(true);

    await first.release();
    const second: any = await queued;
    expect(second.fencingToken).not.toBe(first.fencingToken);
    expect(manager.getMetrics().currentWaiting).toBe(0);
    await second.release();

    const heldAtShutdown: any = await manager.acquire("shutdown-contract");
    await manager.destroy();
    expect(heldAtShutdown.released).toBe(true);
    await expect(manager.acquire("after-shutdown")).rejects.toBeInstanceOf(LockManagerDestroyedError);
  });

  it("cancels a queued acquisition without promoting it later", async () : Promise<any> => {
    const manager: any = createManager();
    const held: any = await manager.acquire("abort-contract");
    const controller: any = new AbortController();
    const queued: any = manager.acquire("abort-contract", {
      waitMs: 200,
      signal: controller.signal
    });
    await vi.waitFor(() : any => expect(manager.getMetrics().currentWaiting).toBe(1));
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(LockAcquireAbortedError);
    expect(manager.getMetrics().currentWaiting).toBe(0);
    await held.release();
    expect(await manager.isLocked("abort-contract")).toBe(false);
  });
});
