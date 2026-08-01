import { describe, expect, it, vi } from "vitest";

import { createQueueWorkerRuntime } from "../../../packages/foundation/src/work-queue/worker-runtime.ts";

function leasedFixture() : any {
  return {
    workItem: {
      workItemId: "work-lease-fence",
      queueDefinitionId: "queue.test.lease-fence",
      queueDefinitionVersion: 1,
      payloadKind: "test",
      payloadRef: { kind: "test" },
      ownerRef: { capability: "test" }
    },
    lease: {
      leaseId: "lease-active",
      leaseSeq: 1,
      workerId: "worker-test",
      expiresAtMs: Date.now() + 60
    }
  };
}

describe("work queue worker lease fencing", () : any => {
  it("renews a live lease and fences the terminal transition", async () : Promise<any> => {
    let expiresAtMs: any = Date.now() + 60;
    const store: Record<string, any> = {
      claim: vi.fn(),
      progress: vi.fn(async () : Promise<any> => ({
        progressed: true,
        lease: {
          leaseId: "lease-active",
          leaseSeq: 1,
          workerId: "worker-test",
          expiresAtMs: (expiresAtMs += 60)
        }
      })),
      complete: vi.fn(async () : Promise<any> => ({ completed: true }))
    };
    const runtime: any = createQueueWorkerRuntime({
      store,
      workerId: "worker-test",
      leaseRenewIntervalMs: 10
    });
    const { workItem, lease } = leasedFixture();
    let executionSignal: any;
    await expect(runtime.runLeased({
      workItem,
      lease,
      handler: async (_input?: any, context?: any) : Promise<any> => {
        executionSignal = context.signal;
        await new Promise((resolve?: any) : any => setTimeout(resolve, 35));
        return { action: "completed" };
      }
    })).resolves.toMatchObject({ settled: true, workItemId: workItem.workItemId });

    expect(executionSignal).toBeInstanceOf(AbortSignal);
    expect(executionSignal.aborted).toBe(false);
    expect(store.progress.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(store.progress).toHaveBeenLastCalledWith(expect.objectContaining({
      workItemId: workItem.workItemId,
      leaseId: lease.leaseId,
      reason: "handler_terminal_fence"
    }));
    expect(store.complete).toHaveBeenCalledOnce();
  });

  it("aborts execution and refuses terminal mutation after lease renewal is rejected", async () : Promise<any> => {
    const store: Record<string, any> = {
      claim: vi.fn(),
      progress: vi.fn(async () : Promise<any> => ({ progressed: false })),
      complete: vi.fn(),
      retry: vi.fn()
    };
    const runtime: any = createQueueWorkerRuntime({
      store,
      workerId: "worker-test",
      leaseRenewIntervalMs: 10
    });
    const { workItem, lease } = leasedFixture();
    let executionSignal: any;
    await expect(runtime.runLeased({
      workItem,
      lease,
      handler: async (_input?: any, context?: any) : Promise<any> => {
        executionSignal = context.signal;
        await new Promise((resolve?: any) : any => context.signal.addEventListener("abort", resolve, { once: true }));
        return { action: "completed" };
      }
    })).rejects.toMatchObject({ code: "queue_lease_lost" });

    expect(executionSignal.aborted).toBe(true);
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.retry).not.toHaveBeenCalled();
  });

  it("returns timed-out work to the durable queue through the active lease", async () : Promise<any> => {
    const store: Record<string, any> = {
      claim: vi.fn(),
      progress: vi.fn(async () : Promise<any> => ({
        progressed: true,
        lease: {
          leaseId: "lease-active",
          leaseSeq: 1,
          workerId: "worker-test",
          expiresAtMs: Date.now() + 100
        }
      })),
      complete: vi.fn(),
      retry: vi.fn(async () : Promise<any> => ({ retried: true, workItem: { state: "queued" } }))
    };
    const runtime: any = createQueueWorkerRuntime({
      store,
      workerId: "worker-test",
      leaseRenewIntervalMs: 10,
      maxHandlerDurationMs: 20
    });
    const { workItem, lease } = leasedFixture();
    await expect(runtime.runLeased({
      workItem,
      lease,
      handler: async (_input?: any, context?: any) : Promise<any> => new Promise((resolve?: any) : any => {
        context.signal.addEventListener("abort", () : any => resolve({ action: "completed" }), { once: true });
      })
    })).resolves.toMatchObject({ settled: true, interrupted: true });
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.retry).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: workItem.workItemId,
      leaseId: lease.leaseId,
      delayMs: 0,
      reason: "handler_timeout"
    }));
  });

  it("exposes the durable checkpoint and advances it through the active lease", async () : Promise<any> => {
    const initialCheckpoint: Record<string, any> = {
      checkpointRef: { kind: "object", ref: "checkpoint-1" },
      checkpointDigest: "digest-1",
      checkpointSeq: 1,
      updatedAtMs: 1
    };
    const nextCheckpoint: Record<string, any> = {
      checkpointRef: { kind: "object", ref: "checkpoint-2" },
      checkpointDigest: "digest-2",
      checkpointSeq: 2,
      updatedAtMs: 2
    };
    const store: Record<string, any> = {
      claim: vi.fn(),
      checkpoint: vi.fn(async () : Promise<any> => ({
        checkpointed: true,
        workItem: { checkpoint: nextCheckpoint }
      })),
      progress: vi.fn(async ({ leaseId }: Record<string, any>) : Promise<any> => ({
        progressed: true,
        lease: { leaseId, leaseSeq: 1, workerId: "worker-test", expiresAtMs: Date.now() + 100 }
      })),
      complete: vi.fn(async () : Promise<any> => ({ completed: true }))
    };
    const runtime: any = createQueueWorkerRuntime({ store, workerId: "worker-test" });
    const { workItem, lease } = leasedFixture();
    workItem.checkpoint = initialCheckpoint;

    await runtime.runLeased({
      workItem,
      lease,
      handler: async (_input?: any, context?: any) : Promise<any> => {
        expect(context.checkpoint).toEqual(initialCheckpoint);
        await context.saveCheckpoint({ kind: "object", ref: "checkpoint-2" });
        expect(context.checkpoint).toEqual(nextCheckpoint);
        return { action: "completed" };
      }
    });

    expect(store.checkpoint).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: workItem.workItemId,
      leaseId: lease.leaseId,
      expectedCheckpointSeq: 1,
      checkpointRef: { kind: "object", ref: "checkpoint-2" }
    }));
  });
});
