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
    const noTakeover: any = store.claim({
      queueDefinitionId: definitionId,
      scope,
      workerId: "restart-takeover-worker",
      leaseTimeoutMs: 5_000
    });
    const fenced: any = recovery.recovered[0];
    if (!fenced) throw new Error("Restart recovery did not fence durable work in_doubt.");
    if (fenced.state !== "in_doubt") throw new Error("Restart recovery left durable work outside in_doubt.");
    if (noTakeover.claimed.some((entry?: any) : any => entry.workItem.workItemId === workItemId)) {
      throw new Error("Restart takeover claimed in_doubt durable work.");
    }
    if (noTakeover.reconciled.some((entry?: any) : any => entry.workItemId === workItemId)) {
      throw new Error("Restart reconciliation settled without a sink receipt.");
    }
    const receipt: any = store.recordSinkReceipt({
      workItemId,
      generation: fenced.lease?.leaseSeq || 0,
      sinkId: "complete",
      effectId: "restart-effect-settled"
    });
    const reconciled: any = store.reconcileInDoubt({ workItemId });
    if (reconciled.count !== 1) throw new Error("In-doubt durable work did not reconcile via sink receipt.");
    const replay: any = store.rebuildProjection();
    const inspected: any = store.inspect({ workItemId, includeJournal: true });
    writeResult({
      staleFenceRejected,
      recoveredCount: recovery.recovered.length + noTakeover.recovered.length,
      recoveryState: fenced.state,
      recoveryLeaseSeq: fenced.lease?.leaseSeq || 0,
      checkpointSeq: fenced.checkpoint?.checkpointSeq || 0,
      checkpointDigest: fenced.checkpoint?.checkpointDigest || "",
      receiptRecorded: receipt.recorded === true,
      reconciled: reconciled.count === 1,
      finalState: reconciled.reconciled[0]?.state || "",
      terminalTransitionCount: inspected.journal.filter((entry?: any) : any => entry.transition === "termination_acknowledged").length,
      projectionReplayOk: replay.ok === true
    });
  } else {
    throw new Error(`Unknown process restart fixture phase: ${phase}`);
  }
} finally {
  await store.close?.();
}
