import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeQueueDedupeKey } from "../../../packages/foundation/src/work-queue/index.ts";
import { createQueueApplicationPort } from "../../../packages/server-runtime/src/composition/queue-application-port.ts";

async function waitForCompleted(queue?: any, workItemId?: any) : Promise<any> {
  for (let attempt: any = 0; attempt < 100; attempt += 1) {
    const observed: any = await queue.observe({ workItemId });
    if (observed.workItem?.state === "completed") return observed.workItem;
    await new Promise((resolve?: any) : any => setTimeout(resolve, 10));
  }
  throw new Error("Queue application work did not complete.");
}

describe("queue application port", () : any => {
  it("drains an in-flight handler before closing a queue facet", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "queue-facet-close-"));
    const port: any = await createQueueApplicationPort({ userDataPath });
    let release: any;
    let startedResolve: any;
    const started: any = new Promise((resolve?: any) : any => { startedResolve = resolve; });
    const gate: any = new Promise((resolve?: any) : any => { release = resolve; });
    try {
      const queue: any = await port.registerQueue({
        queueDefinitionId: "queue.test.close-drain",
        label: "test.queue.close-drain",
        ownerCapability: "test-close-drain",
        scope: { tenantId: "test", workspaceId: "close-drain" },
        handler: async () : Promise<any> => { startedResolve(); await gate; return { action: "completed" }; }
      });
      await queue.enqueue({ dedupeKey: "close-drain", payloadRef: { kind: "test" }, ownerRef: { capability: "test-close-drain" } });
      void queue.requestDispatch();
      await started;
      let closed: any = false;
      const closing: any = queue.close().then(() : any => { closed = true; });
      await new Promise((resolve?: any) : any => setTimeout(resolve, 20));
      expect(closed).toBe(false);
      release();
      await closing;
      expect(port.describe().queueCount).toBe(0);
      expect(() : any => queue.enqueue({ dedupeKey: "late" })).toThrow(/closed/u);
    } finally {
      release?.();
      await port.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("owns one runtime lifecycle while serving multiple queue facets", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "queue-application-port-"));
    const handled: any[] = [];
    const port: any = await createQueueApplicationPort({ userDataPath });
    try {
      const register: any = (suffix?: any) : any => port.registerQueue({
        queueDefinitionId: `queue.test.${suffix}`,
        label: `test.queue.${suffix}`,
        ownerCapability: `test-${suffix}`,
        scope: { tenantId: "test", workspaceId: suffix },
        maxInFlight: 1,
        batchSize: 1,
        handler: async ({ workItem }: Record<string, any>) : Promise<any> => {
          handled.push(workItem.payloadRef.value);
          return { action: "completed", reason: "test_completed" };
        }
      });
      const first: any = await register("first");
      const second: any = await register("second");
      const firstWork: any = await first.enqueue({
        dedupeKey: normalizeQueueDedupeKey({ value: "first" }),
        payloadRef: { kind: "test", value: "first" },
        ownerRef: { capability: "test-first" }
      });
      const secondWork: any = await second.enqueue({
        dedupeKey: normalizeQueueDedupeKey({ value: "second" }),
        payloadRef: { kind: "test", value: "second" },
        ownerRef: { capability: "test-second" }
      });

      await port.requestDispatch();
      await Promise.all([
        waitForCompleted(first, firstWork.workItem.workItemId),
        waitForCompleted(second, secondWork.workItem.workItemId)
      ]);
      const observed: any = await first.observe({ workItemId: firstWork.workItem.workItemId });
      expect(observed.workItem).not.toHaveProperty("payloadRef");
      expect(observed.workItem).not.toHaveProperty("ownerRef");
      expect(observed.workItem).not.toHaveProperty("lease");
      expect(observed.workItem).not.toHaveProperty("lastError");
      expect(handled.sort()).toEqual(["first", "second"]);
      expect(port.describe()).toMatchObject({ queueCount: 2 });
      expect(Object.keys(port).sort()).toEqual([
        "close",
        "describe",
        "registerQueue",
        "requestDispatch",
        "start",
        "stop"
      ]);
    } finally {
      await port.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("shares bounded round-robin execution credit across queue definitions", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "queue-global-credit-"));
    const port: any = await createQueueApplicationPort({ userDataPath, maxGlobalInFlight: 1 });
    const releases: any[] = [];
    const started: any[] = [];
    let concurrent: any = 0;
    let peakConcurrent: any = 0;
    try {
      const register: any = (suffix?: any) : any => port.registerQueue({
        queueDefinitionId: `queue.test.global-credit.${suffix}`,
        label: `test.queue.global-credit.${suffix}`,
        ownerCapability: `test-global-credit-${suffix}`,
        scope: { tenantId: "test", workspaceId: suffix },
        maxInFlight: 8,
        batchSize: 8,
        handler: async () : Promise<any> => {
          concurrent += 1;
          peakConcurrent = Math.max(peakConcurrent, concurrent);
          started.push(suffix);
          await new Promise((resolve?: any) : any => releases.push(resolve));
          concurrent -= 1;
          return { action: "completed" };
        }
      });
      const first: any = await register("first");
      const second: any = await register("second");
      await first.enqueue({ dedupeKey: "first", ownerRef: {}, payloadRef: { kind: "test" } });
      await second.enqueue({ dedupeKey: "second", ownerRef: {}, payloadRef: { kind: "test" } });

      await first.requestDispatch();
      await new Promise((resolve?: any) : any => setImmediate(resolve));
      expect(started).toHaveLength(1);
      expect(port.describe().globalExecution).toMatchObject({ inFlight: 1, capacity: 1 });
      releases.shift()();
      await new Promise((resolve?: any) : any => setImmediate(resolve));
      await second.requestDispatch();
      await new Promise((resolve?: any) : any => setImmediate(resolve));
      expect(new Set<any>(started)).toEqual(new Set<any>(["first", "second"]));
      expect(peakConcurrent).toBe(1);
      releases.shift()();
    } finally {
      releases.splice(0).forEach((release?: any) : any => release());
      await port.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("keeps observation and mutations inside the registered queue and scope", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "queue-facet-boundary-"));
    const port: any = await createQueueApplicationPort({ userDataPath });
    try {
      const register: any = (suffix?: any) : any => port.registerQueue({
        queueDefinitionId: `queue.test.boundary.${suffix}`,
        label: `test.queue.boundary.${suffix}`,
        ownerCapability: `test-boundary-${suffix}`,
        scope: { tenantId: "test", workspaceId: suffix },
        handler: async () : Promise<any> => ({ action: "completed" })
      });
      const first: any = await register("first");
      const second: any = await register("second");
      const firstWork: any = await first.enqueue({
        scope: { tenantId: "attacker", workspaceId: "override" },
        dedupeKey: "first",
        payloadRef: { kind: "test" },
        ownerRef: { capability: "test-boundary-first" }
      });
      const secondWork: any = await second.enqueue({
        dedupeKey: "second",
        payloadRef: { kind: "test" },
        ownerRef: { capability: "test-boundary-second" }
      });
      const firstId: any = firstWork.workItem.workItemId;
      const secondId: any = secondWork.workItem.workItemId;

      await expect(first.observe({
        workItemId: secondId,
        queueDefinitionId: second.definition.queueDefinitionId,
        scope: { tenantId: "test", workspaceId: "second" }
      })).resolves.toEqual({ workItem: null, journal: [] });
      await expect(first.cancel({ workItemId: secondId })).rejects.toMatchObject({
        code: "work_queue_item_not_found"
      });
      await expect(first.expire({ workItemId: secondId, force: true })).rejects.toMatchObject({
        code: "work_queue_item_not_found"
      });
      await expect(first.fail({ workItemId: secondId })).rejects.toMatchObject({
        code: "work_queue_item_not_found"
      });

      await second.fail({ workItemId: secondId });
      await expect(first.recoverFailed({ workItemId: secondId })).rejects.toMatchObject({
        code: "work_queue_item_not_found"
      });
      await expect(second.recoverFailed({ workItemId: secondId })).resolves.toMatchObject({ recovered: true });
      await expect(first.observe({ workItemId: firstId })).resolves.toMatchObject({
        workItem: { workItemId: firstId, queueDefinitionId: first.definition.queueDefinitionId }
      });
    } finally {
      await port.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("keeps a producer-only facet from claiming work", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "queue-producer-only-"));
    const port: any = await createQueueApplicationPort({ userDataPath, dispatchIntervalMs: 10 });
    let handled: any = 0;
    try {
      const queue: any = await port.registerQueue({
        queueDefinitionId: "queue.test.producer-only",
        label: "test.queue.producer-only",
        ownerCapability: "test-producer-only",
        scope: { tenantId: "test", workspaceId: "producer-only" },
        consumerEnabled: false,
        handler: async () : Promise<any> => { handled += 1; return { action: "completed" }; }
      });
      const admitted: any = await queue.enqueue({
        dedupeKey: "producer-only",
        payloadRef: { kind: "test" },
        ownerRef: { capability: "test-producer-only" }
      });
      expect(queue.describe()).toMatchObject({ consumerEnabled: false });
      await expect(queue.requestDispatch()).resolves.toEqual({
        dispatched: 0,
        reason: "consumer_not_owned"
      });
      port.start();
      await new Promise((resolve?: any) : any => setTimeout(resolve, 75));
      expect(handled).toBe(0);
      await expect(queue.observe({ workItemId: admitted.workItem.workItemId })).resolves.toMatchObject({
        workItem: { state: "queued" }
      });
    } finally {
      await port.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });
});
