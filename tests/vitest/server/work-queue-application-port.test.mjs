import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeQueueDedupeKey } from "../../../packages/foundation/src/work-queue/index.mjs";
import { createQueueApplicationPort } from "../../../packages/server-runtime/src/composition/queue-application-port.mjs";

async function waitForCompleted(queue, workItemId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await queue.observe({ workItemId });
    if (observed.workItem?.state === "completed") return observed.workItem;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Queue application work did not complete.");
}

describe("queue application port", () => {
  it("drains an in-flight handler before closing a queue facet", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "queue-facet-close-"));
    const port = await createQueueApplicationPort({ userDataPath });
    let release;
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    try {
      const queue = await port.registerQueue({
        queueDefinitionId: "queue.test.close-drain",
        label: "test.queue.close-drain",
        ownerCapability: "test-close-drain",
        scope: { tenantId: "test", workspaceId: "close-drain" },
        handler: async () => { startedResolve(); await gate; return { action: "completed" }; }
      });
      await queue.enqueue({ dedupeKey: "close-drain", payloadRef: { kind: "test" }, ownerRef: { capability: "test-close-drain" } });
      void queue.requestDispatch();
      await started;
      let closed = false;
      const closing = queue.close().then(() => { closed = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
      release();
      await closing;
      expect(port.describe().queueCount).toBe(0);
      expect(() => queue.enqueue({ dedupeKey: "late" })).toThrow(/closed/u);
    } finally {
      release?.();
      await port.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("owns one runtime lifecycle while serving multiple queue facets", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "queue-application-port-"));
    const handled = [];
    const port = await createQueueApplicationPort({ userDataPath });
    try {
      const register = (suffix) => port.registerQueue({
        queueDefinitionId: `queue.test.${suffix}`,
        label: `test.queue.${suffix}`,
        ownerCapability: `test-${suffix}`,
        scope: { tenantId: "test", workspaceId: suffix },
        maxInFlight: 1,
        batchSize: 1,
        handler: async ({ workItem }) => {
          handled.push(workItem.payloadRef.value);
          return { action: "completed", reason: "test_completed" };
        }
      });
      const first = await register("first");
      const second = await register("second");
      const firstWork = await first.enqueue({
        dedupeKey: normalizeQueueDedupeKey({ value: "first" }),
        payloadRef: { kind: "test", value: "first" },
        ownerRef: { capability: "test-first" }
      });
      const secondWork = await second.enqueue({
        dedupeKey: normalizeQueueDedupeKey({ value: "second" }),
        payloadRef: { kind: "test", value: "second" },
        ownerRef: { capability: "test-second" }
      });

      await port.requestDispatch();
      await Promise.all([
        waitForCompleted(first, firstWork.workItem.workItemId),
        waitForCompleted(second, secondWork.workItem.workItemId)
      ]);
      const observed = await first.observe({ workItemId: firstWork.workItem.workItemId });
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

  it("shares bounded round-robin execution credit across queue definitions", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "queue-global-credit-"));
    const port = await createQueueApplicationPort({ userDataPath, maxGlobalInFlight: 1 });
    const releases = [];
    const started = [];
    let concurrent = 0;
    let peakConcurrent = 0;
    try {
      const register = (suffix) => port.registerQueue({
        queueDefinitionId: `queue.test.global-credit.${suffix}`,
        label: `test.queue.global-credit.${suffix}`,
        ownerCapability: `test-global-credit-${suffix}`,
        scope: { tenantId: "test", workspaceId: suffix },
        maxInFlight: 8,
        batchSize: 8,
        handler: async () => {
          concurrent += 1;
          peakConcurrent = Math.max(peakConcurrent, concurrent);
          started.push(suffix);
          await new Promise((resolve) => releases.push(resolve));
          concurrent -= 1;
          return { action: "completed" };
        }
      });
      const first = await register("first");
      const second = await register("second");
      await first.enqueue({ dedupeKey: "first", ownerRef: {}, payloadRef: { kind: "test" } });
      await second.enqueue({ dedupeKey: "second", ownerRef: {}, payloadRef: { kind: "test" } });

      await first.requestDispatch();
      await new Promise((resolve) => setImmediate(resolve));
      expect(started).toHaveLength(1);
      expect(port.describe().globalExecution).toMatchObject({ inFlight: 1, capacity: 1 });
      releases.shift()();
      await new Promise((resolve) => setImmediate(resolve));
      await second.requestDispatch();
      await new Promise((resolve) => setImmediate(resolve));
      expect(new Set(started)).toEqual(new Set(["first", "second"]));
      expect(peakConcurrent).toBe(1);
      releases.shift()();
    } finally {
      releases.splice(0).forEach((release) => release());
      await port.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("keeps observation and mutations inside the registered queue and scope", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "queue-facet-boundary-"));
    const port = await createQueueApplicationPort({ userDataPath });
    try {
      const register = (suffix) => port.registerQueue({
        queueDefinitionId: `queue.test.boundary.${suffix}`,
        label: `test.queue.boundary.${suffix}`,
        ownerCapability: `test-boundary-${suffix}`,
        scope: { tenantId: "test", workspaceId: suffix },
        handler: async () => ({ action: "completed" })
      });
      const first = await register("first");
      const second = await register("second");
      const firstWork = await first.enqueue({
        scope: { tenantId: "attacker", workspaceId: "override" },
        dedupeKey: "first",
        payloadRef: { kind: "test" },
        ownerRef: { capability: "test-boundary-first" }
      });
      const secondWork = await second.enqueue({
        dedupeKey: "second",
        payloadRef: { kind: "test" },
        ownerRef: { capability: "test-boundary-second" }
      });
      const firstId = firstWork.workItem.workItemId;
      const secondId = secondWork.workItem.workItemId;

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

  it("keeps a producer-only facet from claiming work", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "queue-producer-only-"));
    const port = await createQueueApplicationPort({ userDataPath, dispatchIntervalMs: 10 });
    let handled = 0;
    try {
      const queue = await port.registerQueue({
        queueDefinitionId: "queue.test.producer-only",
        label: "test.queue.producer-only",
        ownerCapability: "test-producer-only",
        scope: { tenantId: "test", workspaceId: "producer-only" },
        consumerEnabled: false,
        handler: async () => { handled += 1; return { action: "completed" }; }
      });
      const admitted = await queue.enqueue({
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
      await new Promise((resolve) => setTimeout(resolve, 75));
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
