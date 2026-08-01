import { createSqliteWorkQueueStore, createQueueDefinitionRegistry } from "../../../packages/foundation/src/work-queue/index.ts";

const [phase, userDataPath, workItemId = "", staleLeaseId = ""] = process.argv.slice(2);
const definitionId: any = "queue.restart.process-fixture";
const scope: Readonly<Record<string, any>> = Object.freeze({ tenantId: "fixture", workspaceId: "restart" });

function createDefinition() : any {
  return createQueueDefinitionRegistry().registerQueueDefinition({
    queueDefinitionId: definitionId,
    label: "queue.restart.process-fixture",
    ownerCapability: "work-queue-restart-fixture"
  });
}

function writeResult(value?: any) : any {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const store: any = createSqliteWorkQueueStore({
  userDataPath,
  policy: {
    retryBackoff: {
      initialDelayMs: 1,
      multiplier: 1,
      maxDelayMs: 1,
      maxJitterBps: 0
    }
  }
});
try {
  const definition: any = createDefinition();
  store.registerQueueDefinition(definition);

  if (phase === "seed") {
    const registry: any = createQueueDefinitionRegistry();
    registry.registerQueueDefinition(definition);
    const enqueued: any = store.enqueue({
      ...registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: definitionId,
        scope,
        dedupeKey: "restart-process-work"
      }),
      payloadRef: { kind: "restart_process_fixture" },
      ownerRef: { capability: "work-queue-restart-fixture" }
    });
    const claimed: any = store.claim({
      queueDefinitionId: definitionId,
      scope,
      workerId: "restart-seed-worker",
      leaseTimeoutMs: 50
    }).claimed[0];
    const checkpoint: any = store.checkpoint({
      workItemId: claimed.workItem.workItemId,
      leaseId: claimed.lease.leaseId,
      checkpointRef: {
        kind: "object",
        ref: "restart-checkpoint",
        revision: "revision-1"
      },
      expectedCheckpointSeq: 0,
      reason: "restart_checkpoint_saved"
    });
    writeResult({
      workItemId: enqueued.workItem.workItemId,
      leaseId: claimed.lease.leaseId,
      leaseSeq: claimed.lease.leaseSeq,
      checkpointSeq: checkpoint.workItem.checkpoint.checkpointSeq,
      checkpointDigest: checkpoint.workItem.checkpoint.checkpointDigest
    });
  } else if (phase === "recover") {
    let staleFenceRejected: any = false;
    try {
      store.complete({ workItemId, leaseId: staleLeaseId });
    } catch {
      staleFenceRejected = true;
    }
    const recovery: any = store.claim({
      queueDefinitionId: definitionId,
      scope,
      workerId: "restart-takeover-worker",
      leaseTimeoutMs: 5_000
    });
    await new Promise((resolve?: any) : any => setTimeout(resolve, 5));
    const takeover: any = store.claim({
      queueDefinitionId: definitionId,
      scope,
      workerId: "restart-takeover-worker",
      leaseTimeoutMs: 5_000
    });
    const claimed: any = takeover.claimed[0];
    if (!claimed) throw new Error("Restart takeover did not claim durable work.");
    const completion: any = store.complete({
      workItemId: claimed.workItem.workItemId,
      leaseId: claimed.lease.leaseId,
      reason: "restart_takeover_completed"
    });
    const replay: any = store.rebuildProjection();
    const inspected: any = store.inspect({ workItemId, includeJournal: true });
    writeResult({
      staleFenceRejected,
      recoveredCount: recovery.recovered.length + takeover.recovered.length,
      recoveryState: recovery.recovered[0]?.state || "",
      claimedWorkItemId: claimed.workItem.workItemId,
      replacementLeaseSeq: claimed.lease.leaseSeq,
      checkpointSeq: claimed.workItem.checkpoint?.checkpointSeq || 0,
      checkpointDigest: claimed.workItem.checkpoint?.checkpointDigest || "",
      completed: completion.completed === true,
      finalState: completion.workItem.state,
      completedTransitionCount: inspected.journal.filter((entry?: any) : any => entry.transition === "complete").length,
      projectionReplayOk: replay.ok === true
    });
  } else {
    throw new Error(`Unknown process restart fixture phase: ${phase}`);
  }
} finally {
  await store.close?.();
}
