import { createSqliteWorkQueueStore, createQueueDefinitionRegistry } from "../../../packages/foundation/src/work-queue/index.mjs";

const [phase, userDataPath, workItemId = "", staleLeaseId = ""] = process.argv.slice(2);
const definitionId = "queue.restart.process-fixture";
const scope = Object.freeze({ tenantId: "fixture", workspaceId: "restart" });

function createDefinition() {
  return createQueueDefinitionRegistry().registerQueueDefinition({
    queueDefinitionId: definitionId,
    label: "queue.restart.process-fixture",
    ownerCapability: "work-queue-restart-fixture"
  });
}

function writeResult(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const store = createSqliteWorkQueueStore({
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
  const definition = createDefinition();
  store.registerQueueDefinition(definition);

  if (phase === "seed") {
    const registry = createQueueDefinitionRegistry();
    registry.registerQueueDefinition(definition);
    const enqueued = store.enqueue({
      ...registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: definitionId,
        scope,
        dedupeKey: "restart-process-work"
      }),
      payloadRef: { kind: "restart_process_fixture" },
      ownerRef: { capability: "work-queue-restart-fixture" }
    });
    const claimed = store.claim({
      queueDefinitionId: definitionId,
      scope,
      workerId: "restart-seed-worker",
      leaseTimeoutMs: 50
    }).claimed[0];
    const checkpoint = store.checkpoint({
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
    let staleFenceRejected = false;
    try {
      store.complete({ workItemId, leaseId: staleLeaseId });
    } catch {
      staleFenceRejected = true;
    }
    const recovery = store.claim({
      queueDefinitionId: definitionId,
      scope,
      workerId: "restart-takeover-worker",
      leaseTimeoutMs: 5_000
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const takeover = store.claim({
      queueDefinitionId: definitionId,
      scope,
      workerId: "restart-takeover-worker",
      leaseTimeoutMs: 5_000
    });
    const claimed = takeover.claimed[0];
    if (!claimed) throw new Error("Restart takeover did not claim durable work.");
    const completion = store.complete({
      workItemId: claimed.workItem.workItemId,
      leaseId: claimed.lease.leaseId,
      reason: "restart_takeover_completed"
    });
    const replay = store.rebuildProjection();
    const inspected = store.inspect({ workItemId, includeJournal: true });
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
      completedTransitionCount: inspected.journal.filter((entry) => entry.transition === "complete").length,
      projectionReplayOk: replay.ok === true
    });
  } else {
    throw new Error(`Unknown process restart fixture phase: ${phase}`);
  }
} finally {
  await store.close?.();
}
