import { describe, expect, it } from "vitest";
import {
  LockAcquireAbortedError,
  LockQueueFullError,
  MemoryLockManager
} from "../../../packages/foundation/src/concurrency/lock-manager.ts";

describe("bounded lock wait runtime", () : any => {
  it("uses one waiter deadline timer and removes cancelled nodes in constant time", async () : Promise<any> => {
    const manager: any = new MemoryLockManager({
      defaultTtlMs: 5_000,
      maxWaitMs: 2_000,
      maxQueueDepth: 512
    });
    const held: any = await manager.acquire("hot");
    const controllers: any[] = [];
    const pending: any[] = [];
    for (let index: any = 0; index < 256; index += 1) {
      const controller: any = new AbortController();
      controllers.push(controller);
      pending.push(manager.acquire("hot", { signal: controller.signal }).catch((error?: any) : any => error));
    }
    expect(manager.getMetrics()).toMatchObject({ currentWaiting: 256, queueKeys: 1, waiterTimers: 1 });
    controllers.forEach((controller?: any) : any => controller.abort());
    const errors: any = await Promise.all(pending);
    expect(errors.every((error?: any) : any => error instanceof LockAcquireAbortedError)).toBe(true);
    expect(manager.getMetrics()).toMatchObject({ currentWaiting: 0, queueKeys: 0, waiterTimers: 0 });
    await held.release();
    manager.destroy();
  });

  it("enforces a global pending bound across unrelated keys", async () : Promise<any> => {
    const manager: any = new MemoryLockManager({ maxQueueDepth: 2, maxWaitMs: 1_000 });
    const heldA: any = await manager.acquire("a");
    const heldB: any = await manager.acquire("b");
    const first: any = manager.acquire("a").catch((error?: any) : any => error);
    const second: any = manager.acquire("b").catch((error?: any) : any => error);
    await expect(manager.acquire("a")).rejects.toBeInstanceOf(LockQueueFullError);
    manager.destroy();
    await Promise.all([first, second]);
    expect(heldA.released).toBe(true);
    expect(heldB.released).toBe(true);
  });
});
