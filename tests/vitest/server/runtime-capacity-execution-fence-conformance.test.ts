import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createManualQueueTimeSource,
  createQueueWorkerRuntime,
  createSqliteWorkQueueStore
} from "../../../packages/foundation/src/work-queue/index.ts";
import {
  verifyWorkQueueStateMachineProof,
  WORK_QUEUE_STATES
} from "../../../packages/foundation/src/workflow/state-machine/work-queue/state-machine.ts";

const roots: any[] = [];

async function makeStore(policy: Record<string, any> = {}) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-capacity-execution-fence-"));
  roots.push(userDataPath);
  const timeSource: any = createManualQueueTimeSource(1_700_000_000_000);
  return {
    timeSource,
    store: createSqliteWorkQueueStore({
      userDataPath,
      timeSource,
      policy: {
        retryBackoff: {
          strategy: "exponential",
          initialDelayMs: 1,
          multiplier: 1,
          maxDelayMs: 1,
          jitter: "none"
        },
        ...policy
      }
    })
  };
}

async function setupFixture(store: any) : Promise<any> {
  const queueDefinitionId: any = "queue.execution-fence";
  store.registerQueueDefinition({
    queueDefinitionId,
    label: "queue.execution-fence",
    ownerCapability: "runtime-capacity-execution-fence-conformance"
  });
  function enqueue(key: any) : any {
    return store.enqueue({
      queueDefinitionId,
      queueDefinitionVersion: 1,
      queueDefinition: { queueDefinitionId, queueDefinitionVersion: 1 },
      scope: {},
      schedulingScope: {},
      dedupeKey: key,
      workItemId: key,
      payloadRef: { kind: "execution-fence", key },
      ownerRef: { capability: "runtime-capacity-execution-fence-conformance" },
      priority: 0
    });
  }
  function claim(workerId: any, batchSize: any = 10) : any {
    return store.claim({ queueDefinitionId, workerId, batchSize });
  }
  return { queueDefinitionId, enqueue, claim };
}

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("runtime capacity execution fence conformance", () : any => {
  it("keeps an unconfirmed attempt in in_doubt retaining credit and lease generation, never overlapping a later claim", async () : Promise<any> => {
    const { store, timeSource } = await makeStore();
    const fixture: any = await setupFixture(store);
    fixture.enqueue("fence-1");
    const claimed: any = fixture.claim("worker-1").claimed[0];
    expect(claimed.lease.leaseSeq).toBe(1);

    const inDoubt: any = store.markInDoubt({
      workItemId: claimed.workItem.workItemId,
      leaseId: claimed.lease.leaseId,
      reason: "handler_timeout_unconfirmed"
    });
    expect(inDoubt.interrupted).toBe(true);
    expect(inDoubt.workItem.state).toBe(WORK_QUEUE_STATES.IN_DOUBT);
    expect(inDoubt.workItem.lease?.leaseSeq).toBe(1);
    expect(inDoubt.workItem.lease?.leaseId).toBe(claimed.lease.leaseId);

    const second: any = fixture.claim("worker-2");
    expect(second.claimed.length).toBe(0);
    expect(second.reconciled.length).toBe(0);
    timeSource.advance(60_000);
    const afterExpiry: any = fixture.claim("worker-2");
    expect(afterExpiry.claimed.length).toBe(0);
    expect(afterExpiry.reconciled.length).toBe(0);
    const stillInDoubt: any = store.inspect({ workItemId: claimed.workItem.workItemId });
    expect(stillInDoubt.workItem.state).toBe(WORK_QUEUE_STATES.IN_DOUBT);
    expect(stillInDoubt.workItem.lease?.leaseSeq).toBe(1);
  });

  it("settles an in_doubt attempt exactly once through a durable sink receipt", async () : Promise<any> => {
    const { store } = await makeStore();
    const fixture: any = await setupFixture(store);
    fixture.enqueue("fence-2");
    const claimed: any = fixture.claim("worker-1").claimed[0];
    store.markInDoubt({ workItemId: "fence-2", leaseId: claimed.lease.leaseId });

    const receipt: any = store.recordSinkReceipt({
      workItemId: "fence-2",
      generation: claimed.lease.leaseSeq,
      sinkId: "complete",
      effectId: "effect-2"
    });
    expect(receipt.recorded).toBe(true);
    const duplicate: any = store.recordSinkReceipt({
      workItemId: "fence-2",
      generation: claimed.lease.leaseSeq,
      sinkId: "complete",
      effectId: "effect-2-dup"
    });
    expect(duplicate.recorded).toBe(false);
    expect(duplicate.idempotent).toBe(true);

    const reconciled: any = store.reconcileInDoubt({ workItemId: "fence-2" });
    expect(reconciled.count).toBe(1);
    expect(reconciled.reconciled[0].state).toBe(WORK_QUEUE_STATES.COMPLETED);
    const settledAgain: any = store.reconcileInDoubt({ workItemId: "fence-2" });
    expect(settledAgain.count).toBe(0);
    const completed: any = store.inspect({ workItemId: "fence-2" });
    expect(completed.workItem.state).toBe(WORK_QUEUE_STATES.COMPLETED);
  });

  it("moves crashed running attempts to in_doubt on lease expiry without takeover, then reconciles via fence", async () : Promise<any> => {
    const { store, timeSource } = await makeStore();
    const fixture: any = await setupFixture(store);
    fixture.enqueue("crash-1");
    const original: any = fixture.claim("worker-before-crash", 10).claimed[0];

    timeSource.advance(31_000);
    const firstAfterRestart: any = fixture.claim("worker-after-restart", 10);
    expect(firstAfterRestart.recovered.length).toBe(1);
    expect(firstAfterRestart.recovered[0].state).toBe(WORK_QUEUE_STATES.IN_DOUBT);
    expect(firstAfterRestart.recovered[0].lease?.leaseSeq).toBe(original.lease.leaseSeq);
    expect(firstAfterRestart.claimed.length).toBe(0);

    const noTakeover: any = fixture.claim("worker-after-restart", 10);
    expect(noTakeover.claimed.length).toBe(0);
    expect(noTakeover.reconciled.length).toBe(0);
    expect(() : any => store.complete({
      workItemId: "crash-1",
      leaseId: original.lease.leaseId
    })).toThrow(/not leased/);

    store.recordSinkReceipt({
      workItemId: "crash-1",
      generation: original.lease.leaseSeq,
      sinkId: "complete",
      effectId: "crash-effect-1"
    });
    const reconciled: any = fixture.claim("worker-after-restart", 10);
    expect(reconciled.reconciled.length).toBe(1);
    expect(reconciled.reconciled[0].state).toBe(WORK_QUEUE_STATES.COMPLETED);
  });

  it("rejects stale generation fences and stale leases", async () : Promise<any> => {
    const { store } = await makeStore();
    const fixture: any = await setupFixture(store);
    fixture.enqueue("stale-1");
    const claimed: any = fixture.claim("worker-1").claimed[0];
    store.markInDoubt({ workItemId: "stale-1", leaseId: claimed.lease.leaseId });

    store.recordSinkReceipt({
      workItemId: "stale-1",
      generation: claimed.lease.leaseSeq - 1,
      sinkId: "complete",
      effectId: "stale-effect"
    });
    const staleReconcile: any = store.reconcileInDoubt({ workItemId: "stale-1" });
    expect(staleReconcile.count).toBe(0);

    fixture.enqueue("stale-2");
    const running: any = fixture.claim("worker-1").claimed[0];
    expect(() : any => store.markInDoubt({
      workItemId: "stale-2",
      leaseId: "stale-lease"
    })).toThrow(/Lease fence rejected/);
    store.markInDoubt({ workItemId: "stale-2", leaseId: running.lease.leaseId });
    expect(() : any => store.acknowledgeTermination({
      workItemId: "stale-2",
      leaseId: "stale-lease",
      toState: "completed"
    })).toThrow(/Lease fence rejected/);
  });

  it("acknowledges termination into retry, failed, or completed and records terminal fences", async () : Promise<any> => {
    const { store } = await makeStore();
    const fixture: any = await setupFixture(store);

    fixture.enqueue("ack-1");
    const retryLease: any = fixture.claim("worker-1").claimed[0].lease;
    store.markInDoubt({ workItemId: "ack-1", leaseId: retryLease.leaseId });
    const retry: any = store.acknowledgeTermination({
      workItemId: "ack-1",
      leaseId: retryLease.leaseId,
      toState: "retry",
      delayMs: 60_000
    });
    expect(retry.acknowledged).toBe(true);
    expect(retry.workItem.state).toBe(WORK_QUEUE_STATES.RETRY_WAIT);
    expect(retry.workItem.lease).toBeNull();
    expect(retry.delayMs).toBe(60_000);

    fixture.enqueue("ack-2");
    const failLease: any = fixture.claim("worker-1").claimed[0].lease;
    store.markInDoubt({ workItemId: "ack-2", leaseId: failLease.leaseId });
    const failed: any = store.acknowledgeTermination({
      workItemId: "ack-2",
      leaseId: failLease.leaseId,
      toState: "failed",
      reason: "handler_terminated_failed"
    });
    expect(failed.acknowledged).toBe(true);
    expect(failed.workItem.state).toBe(WORK_QUEUE_STATES.FAILED);
    expect(failed.workItem.lease).toBeNull();

    fixture.enqueue("ack-3");
    const completeLease: any = fixture.claim("worker-1").claimed[0].lease;
    store.markInDoubt({ workItemId: "ack-3", leaseId: completeLease.leaseId });
    const completed: any = store.acknowledgeTermination({
      workItemId: "ack-3",
      leaseId: completeLease.leaseId,
      toState: "completed",
      effectId: "ack-effect-3"
    });
    expect(completed.acknowledged).toBe(true);
    expect(completed.workItem.state).toBe(WORK_QUEUE_STATES.COMPLETED);

    fixture.enqueue("ack-4");
    const invalidLease: any = fixture.claim("worker-1").claimed[0].lease;
    store.markInDoubt({ workItemId: "ack-4", leaseId: invalidLease.leaseId });
    expect(() : any => store.acknowledgeTermination({
      workItemId: "ack-4",
      leaseId: invalidLease.leaseId,
      toState: "cancelled"
    })).toThrow(/Unsupported termination settlement state/);
  });

  it("supports operator cancel and expire from in_doubt", async () : Promise<any> => {
    const { store } = await makeStore();
    const fixture: any = await setupFixture(store);

    fixture.enqueue("op-1");
    const cancelLease: any = fixture.claim("worker-1").claimed[0].lease;
    store.markInDoubt({ workItemId: "op-1", leaseId: cancelLease.leaseId });
    const cancelled: any = store.cancel({ workItemId: "op-1", reason: "operator" });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.workItem.state).toBe(WORK_QUEUE_STATES.CANCELLED);

    fixture.enqueue("op-2");
    const expireLease: any = fixture.claim("worker-1").claimed[0].lease;
    store.markInDoubt({ workItemId: "op-2", leaseId: expireLease.leaseId });
    const expired: any = store.expire({ workItemId: "op-2", force: true, reason: "deadline" });
    expect(expired.expired).toBe(true);
    expect(expired.workItem.state).toBe(WORK_QUEUE_STATES.EXPIRED);
  });

  it("runs bounded reconciliation batches over in_doubt rows", async () : Promise<any> => {
    const { store } = await makeStore();
    const fixture: any = await setupFixture(store);
    const leases: any[] = [];
    for (let index: any = 0; index < 5; index += 1) {
      const key: any = `batch-${index}`;
      fixture.enqueue(key);
      leases.push(fixture.claim("worker-1").claimed[0].lease);
    }
    for (let index: any = 0; index < 5; index += 1) {
      const key: any = `batch-${index}`;
      store.markInDoubt({ workItemId: key, leaseId: leases[index].leaseId });
      store.recordSinkReceipt({ workItemId: key, generation: leases[index].leaseSeq, sinkId: "complete" });
    }
    const bounded: any = store.reconcileInDoubt({ limit: 2 });
    expect(bounded.count).toBe(2);
    const rest: any = store.reconcileInDoubt({ limit: 2 });
    expect(rest.count).toBe(2);
    const last: any = store.reconcileInDoubt({ limit: 2 });
    expect(last.count).toBe(1);
    const none: any = store.reconcileInDoubt({ limit: 2 });
    expect(none.count).toBe(0);
  });

  it("isolates non-terminable handler timeouts into in_doubt while terminable handlers retry immediately", async () : Promise<any> => {
    const { store } = await makeStore();
    const fixture: any = await setupFixture(store);

    fixture.enqueue("runtime-1");
    const first: any = fixture.claim("worker-1").claimed[0];
    const nonTerminable: any = createQueueWorkerRuntime({
      store,
      workerId: "worker-1",
      maxHandlerDurationMs: 5
    });
    const timedOut: any = await nonTerminable.runLeased({
      workItem: first.workItem,
      lease: first.lease,
      handler: async () : Promise<any> => new Promise(() : any => {})
    });
    expect(timedOut.interrupted).toBe(true);
    expect(timedOut.inDoubt).toBe(true);
    expect(timedOut.error?.code).toBe("queue_handler_timeout");
    const fenced: any = store.inspect({ workItemId: "runtime-1" });
    expect(fenced.workItem.state).toBe(WORK_QUEUE_STATES.IN_DOUBT);

    fixture.enqueue("runtime-2");
    const second: any = fixture.claim("worker-1").claimed[0];
    const terminableHandler: any = async () : Promise<any> => new Promise(() : any => {});
    terminableHandler.terminable = true;
    const terminableRuntime: any = createQueueWorkerRuntime({
      store,
      workerId: "worker-1",
      maxHandlerDurationMs: 5
    });
    const retried: any = await terminableRuntime.runLeased({
      workItem: second.workItem,
      lease: second.lease,
      handler: terminableHandler
    });
    expect(retried.interrupted).toBe(true);
    expect(retried.inDoubt).toBeUndefined();
    const requeued: any = store.inspect({ workItemId: "runtime-2" });
    expect(requeued.workItem.state).toBe(WORK_QUEUE_STATES.QUEUED);
  });

  it("verifies the state machine proof admits in_doubt transitions", async () : Promise<any> => {
    const proof: any = verifyWorkQueueStateMachineProof();
    expect(proof.ok).toBe(true);
    expect(proof.states).toBe(9);
    expect(proof.matrixCells).toBe(144);
    expect(WORK_QUEUE_STATES.IN_DOUBT).toBe("in_doubt");
  });
});
