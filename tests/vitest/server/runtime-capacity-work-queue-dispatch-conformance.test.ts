import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createQueuePushDispatcher,
  createQueueWorkerRuntime,
  createSqliteWorkQueueStore
} from "../../../packages/foundation/src/work-queue/index.ts";
import { createQueueApplicationPort } from "../../../packages/server-runtime/src/composition/queue-application-port.ts";

const roots: any[] = [];

async function makeStore() : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-capacity-dispatch-"));
  roots.push(userDataPath);
  return createSqliteWorkQueueStore({ userDataPath });
}

async function makeRuntime(store?: any, handlers: Record<string, any> = {}) : Promise<any> {
  return createQueueWorkerRuntime({
    store,
    workerId: "dispatch-conformance-worker",
    handlers
  });
}

function deferred() : any {
  let resolve: any = null;
  const promise: any = new Promise((done?: any) : any => {
    resolve = done;
  });
  return { promise, resolve };
}

async function sleep(ms: any = 5) : Promise<any> {
  await new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

async function waitUntil(predicate?: any, timeoutMs: any = 2000) : Promise<any> {
  const startedAt: any = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("runtime capacity work queue dispatch conformance", () : any => {
  it("reserves credit synchronously before claim and never oversubscribes the limit", async () : Promise<any> => {
    const store: any = await makeStore();
    const runtime: any = await makeRuntime(store);
    const dispatcher: any = createQueuePushDispatcher({
      store: {
        claim: async () : Promise<any> => {
          await claimGate.promise;
          return { claimed: [], recovered: [], matured: [], failed: [], expired: [] };
        }
      },
      workerRuntime: runtime,
      queueDefinitionId: "queue.reserve.sync",
      maxInFlight: 2
    });
    const claimGate: any = deferred();

    const first: any = dispatcher.dispatchOnce({ batchSize: 2 });
    const second: any = dispatcher.dispatchOnce({ batchSize: 2 });

    const midFlight: any = dispatcher.status();
    expect(midFlight.reserved).toBe(2);
    expect(midFlight.inFlight).toBe(0);
    expect(midFlight.reserved + midFlight.inFlight).toBeLessThanOrEqual(2);
    expect(midFlight.availableCredit).toBe(0);

    claimGate.resolve();
    const [firstResult, secondResult]: any[] = await Promise.all([first, second]);
    expect(firstResult.dispatched).toBe(0);
    expect(secondResult.dispatched).toBe(0);
    const after: any = dispatcher.status();
    expect(after.reserved).toBe(0);
    expect(after.inFlight).toBe(0);
    expect(after.reserved + after.inFlight).toBeLessThanOrEqual(2);
  });

  it("converts only returned leases to in-flight and reclaims the unused reservation", async () : Promise<any> => {
    const store: any = await makeStore();
    const runtime: any = await makeRuntime(store, {
      "queue.partial.claim": async () : Promise<any> => ({ action: "completed" })
    });
    const dispatcher: any = createQueuePushDispatcher({
      store,
      workerRuntime: runtime,
      queueDefinitionId: "queue.partial.claim",
      maxInFlight: 3
    });
    store.registerQueueDefinition({
      queueDefinitionId: "queue.partial.claim",
      label: "queue.partial.claim",
      ownerCapability: "runtime-capacity-dispatch-conformance"
    });
    store.enqueue({
      queueDefinitionId: "queue.partial.claim",
      queueDefinitionVersion: 1,
      queueDefinition: {
        queueDefinitionId: "queue.partial.claim",
        queueDefinitionVersion: 1
      },
      scope: {},
      schedulingScope: {},
      dedupeKey: "partial-1",
      workItemId: "partial-1",
      payloadRef: { kind: "dispatch-conformance", workItemId: "partial-1" },
      ownerRef: { capability: "runtime-capacity-dispatch-conformance" },
      priority: 0
    });

    const result: any = await dispatcher.dispatchOnce({ batchSize: 3 });
    expect(result.dispatched).toBe(1);
    const status: any = dispatcher.status();
    expect(status.inFlight).toBe(1);
    expect(status.reserved).toBe(0);
    expect(status.reserved + status.inFlight).toBeLessThanOrEqual(3);
    expect(status.availableCredit).toBe(2);
    await dispatcher.drain({ timeoutMs: 2000 });
    expect(dispatcher.status().inFlight).toBe(0);
  });

  it("reclaims the full reservation when the claim fails", async () : Promise<any> => {
    const store: any = await makeStore();
    const runtime: any = await makeRuntime(store);
    const dispatcher: any = createQueuePushDispatcher({
      store: {
        claim: async () : Promise<any> => {
          throw new Error("claim failed");
        }
      },
      workerRuntime: runtime,
      queueDefinitionId: "queue.claim.failure",
      maxInFlight: 2
    });

    await expect(dispatcher.dispatchOnce({ batchSize: 2 })).rejects.toThrow("claim failed");
    const status: any = dispatcher.status();
    expect(status.reserved).toBe(0);
    expect(status.inFlight).toBe(0);
    expect(status.reserved + status.inFlight).toBeLessThanOrEqual(2);
  });

  it("reclaims the reservation on an empty claim", async () : Promise<any> => {
    const store: any = await makeStore();
    const runtime: any = await makeRuntime(store);
    const dispatcher: any = createQueuePushDispatcher({
      store,
      workerRuntime: runtime,
      queueDefinitionId: "queue.empty.claim",
      maxInFlight: 2
    });
    store.registerQueueDefinition({
      queueDefinitionId: "queue.empty.claim",
      label: "queue.empty.claim",
      ownerCapability: "runtime-capacity-dispatch-conformance"
    });

    const result: any = await dispatcher.dispatchOnce({ batchSize: 2 });
    expect(result.dispatched).toBe(0);
    const status: any = dispatcher.status();
    expect(status.reserved).toBe(0);
    expect(status.reserved + status.inFlight).toBeLessThanOrEqual(2);
  });

  it("never reserves credit when dispatch is aborted before claim", async () : Promise<any> => {
    const store: any = await makeStore();
    const runtime: any = await makeRuntime(store);
    const dispatcher: any = createQueuePushDispatcher({
      store,
      workerRuntime: runtime,
      queueDefinitionId: "queue.abort.before.claim",
      maxInFlight: 2
    });
    const controller: any = new AbortController();
    controller.abort(new Error("cancelled before claim"));

    const result: any = await dispatcher.dispatchOnce({ batchSize: 2, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    const status: any = dispatcher.status();
    expect(status.reserved).toBe(0);
    expect(status.reserved + status.inFlight).toBeLessThanOrEqual(2);
  });

  it("exposes no unreserved dispatch bypass on the worker runtime", async () : Promise<any> => {
    const store: any = await makeStore();
    const runtime: any = await makeRuntime(store);
    expect(runtime.runOnce).toBeUndefined();
    expect(runtime.startPolling).toBeUndefined();
    expect(typeof runtime.runLeased).toBe("function");
  });

  it("coalesces triggers per queue and preserves cross-queue progress", async () : Promise<any> => {
    const store: any = await makeStore();
    const claimGate: any = deferred();
    let countA: any = 0;
    let countB: any = 0;
    const gatedStore: any = {
      ...store,
      claim: async (input: Record<string, any> = {}) : Promise<any> => {
        if (input.queueDefinitionId === "queue.a.coalesce") {
          await claimGate.promise;
        }
        return store.claim(input);
      }
    };
    const port: any = await createQueueApplicationPort({
      store: gatedStore,
      logger: { error: () : any => {}, warn: () : any => {}, info: () : any => {}, debug: () : any => {} }
    });
    const queueA: any = await port.registerQueue({
      queueDefinitionId: "queue.a.coalesce",
      label: "queue.a.coalesce",
      ownerCapability: "runtime-capacity-dispatch-conformance",
      maxInFlight: 2,
      batchSize: 1,
      handler: async () : Promise<any> => {
        countA += 1;
        return { action: "completed" };
      }
    });
    const queueB: any = await port.registerQueue({
      queueDefinitionId: "queue.b.progress",
      label: "queue.b.progress",
      ownerCapability: "runtime-capacity-dispatch-conformance",
      maxInFlight: 2,
      batchSize: 2,
      handler: async () : Promise<any> => {
        countB += 1;
        return { action: "completed" };
      }
    });
    await queueA.enqueue({
      workItemId: "a-1",
      payloadRef: { kind: "dispatch-conformance", workItemId: "a-1" },
      ownerRef: { capability: "runtime-capacity-dispatch-conformance" }
    });
    await queueA.enqueue({
      workItemId: "a-2",
      payloadRef: { kind: "dispatch-conformance", workItemId: "a-2" },
      ownerRef: { capability: "runtime-capacity-dispatch-conformance" }
    });
    await queueB.enqueue({
      workItemId: "b-1",
      payloadRef: { kind: "dispatch-conformance", workItemId: "b-1" },
      ownerRef: { capability: "runtime-capacity-dispatch-conformance" }
    });
    await queueB.enqueue({
      workItemId: "b-2",
      payloadRef: { kind: "dispatch-conformance", workItemId: "b-2" },
      ownerRef: { capability: "runtime-capacity-dispatch-conformance" }
    });

    const triggers: any[] = [];
    for (let index: any = 0; index < 5; index += 1) {
      triggers.push(port.requestDispatch("queue.a.coalesce"));
    }
    await sleep(20);
    expect(countA).toBe(0);
    expect(port.describe().globalExecution.reserved).toBe(1);

    const tick: any = port.requestDispatch();
    await waitUntil(() : any => countB === 2);
    expect(countB).toBe(2);
    expect(countA).toBe(0);

    claimGate.resolve();
    await Promise.all(triggers);
    await tick;
    await waitUntil(() : any => countA === 2);
    expect(countA).toBeLessThanOrEqual(2);
    expect(countB).toBe(2);
    await port.close();
  });
});
