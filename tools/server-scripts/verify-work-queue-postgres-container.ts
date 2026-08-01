#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import {
  createManualQueueTimeSource,
  createPostgresWorkQueueStore,
  createQueueDefinitionRegistry
} from "../../packages/foundation/src/work-queue/index.ts";
import { WORK_QUEUE_STATES } from "../../packages/foundation/src/workflow/state-machine/work-queue/state-machine.ts";

const runId: any = `${process.pid}-${Date.now()}`;
const containerName: any = `meshrix-work-queue-postgres-${runId}`;
const image: any = process.env.MESHRIX_WORK_QUEUE_POSTGRES_IMAGE || "postgres:16-alpine";

function run(command?: any, args: any = [], options: Record<string, any> = {}) : any {
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env || {}) }
    });
    let stdout: any = "";
    let stderr: any = "";
    const timer: any = setTimeout(() : any => {
      child.kill("SIGTERM");
      setTimeout(() : any => child.kill("SIGKILL"), 5000).unref();
    }, Number(options.timeoutMs || 120000));
    child.stdout.on("data", (chunk?: any) : any => {
      stdout += chunk.toString("utf8");
      if (options.stream) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk?: any) : any => {
      stderr += chunk.toString("utf8");
      if (options.stream) process.stderr.write(chunk);
    });
    child.once("error", (error?: any) : any => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code?: any, signal?: any) : any => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} failed code=${code} signal=${signal || ""}`));
    });
  });
}

async function docker(args: any = [], options: Record<string, any> = {}) : Promise<any> {
  return run("docker", args, options);
}

async function freePort() : Promise<any> {
  const server: any = http.createServer();
  await new Promise((resolve?: any, reject?: any) : any => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: any = server.address();
  await new Promise((resolve?: any, reject?: any) : any => server.close((error?: any) : any => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForPostgres(connectionString?: any) : Promise<any> {
  let lastError: any = null;
  for (let attempt: any = 0; attempt < 80; attempt += 1) {
    try {
      const store: any = await createPostgresWorkQueueStore({ connectionString });
      await store.close();
      return;
    } catch (error: any) {
      lastError = error;
      await new Promise((resolve?: any) : any => setTimeout(resolve, 1000));
    }
  }
  throw lastError || new Error("postgres did not become ready");
}

async function main() : Promise<any> {
  await docker(["image", "inspect", image]).catch(() : any => docker(["pull", image], { timeoutMs: 900000 }));
  const port: any = await freePort();
  const connectionString: any = [
    "postgresql://",
    "meshrix",
    ":",
    "meshrix",
    "@127.0.0.1:",
    String(port),
    "/meshrix"
  ].join("");
  let started: any = false;
  let store: any = null;
  try {
    await docker([
      "run", "-d",
      "--name", containerName,
      "-e", "POSTGRES_USER=meshrix",
      "-e", "POSTGRES_PASSWORD=meshrix",
      "-e", "POSTGRES_DB=meshrix",
      "-p", `${port}:5432`,
      image
    ], { timeoutMs: 120000 });
    started = true;
    await waitForPostgres(connectionString);

    const timeSource: any = createManualQueueTimeSource(1000);
    store = await createPostgresWorkQueueStore({
      connectionString,
      timeSource,
      policy: {
        capacity: {
          maxPayloadRefBytes: 64,
          maxFailed: 1
        },
        retryBackoff: {
          strategy: "exponential",
          initialDelayMs: 25,
          multiplier: 1,
          maxDelayMs: 25,
          jitter: "none"
        },
        fallbackRetry: {
          maxAttempts: 1,
          initialDelayMs: 1,
          multiplier: 1,
          maxDelayMs: 1
        }
      }
    });
    const registry: any = createQueueDefinitionRegistry();
    const definition: any = registry.registerQueueDefinition({
      label: "postgres.jobs",
      ownerCapability: "work-queue-postgres-conformance"
    });
    await store.registerQueueDefinition(definition);
    assert.deepEqual(
      await store.registerQueueDefinition(definition),
      {
        registered: false,
        idempotent: true,
        queueDefinitionId: definition.queueDefinitionId,
        queueDefinitionVersion: definition.queueDefinitionVersion
      }
    );
    await assert.rejects(
      () : any => store.registerQueueDefinition({
        ...definition,
        policy: { ...definition.policy, maxInFlight: 99 }
      }),
      (error?: any) : any => error?.code === "work_queue_definition_conflict"
    );
    const nextDefinition: any = registry.registerQueueDefinition({
      queueDefinitionId: definition.queueDefinitionId,
      label: definition.label,
      ownerCapability: definition.ownerCapability,
      policy: { maxInFlight: 2 }
    });
    assert.equal((await store.registerQueueDefinition(nextDefinition)).registered, true);
    await assert.rejects(
      () : any => store.registerQueueDefinition({
        ...nextDefinition,
        queueDefinitionId: "queue.postgres.label-alias",
        queueDefinitionVersion: 1
      }),
      (error?: any) : any => error?.code === "work_queue_definition_conflict"
    );
    const scope: Record<string, any> = { tenantId: "postgres", workspaceId: "container" };
    const resolved: any = registry.resolveQueueDefinitionForEnqueue({
      queueDefinitionId: definition.queueDefinitionId,
      scope,
      dedupeKey: { jobId: "pg-1" }
    });
    const enqueued: any = await store.enqueue({
      ...resolved,
      payloadRef: { kind: "postgres-smoke", ref: "payload:pg-1" },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    });
    assert.equal(enqueued.workItem.state, WORK_QUEUE_STATES.QUEUED);
    const wrongBoundary: Record<string, any> = {
      queueDefinitionId: "queue.postgres.not-owned",
      scope: { tenantId: "postgres", workspaceId: "other" }
    };
    assert.equal((await store.inspect({
      workItemId: enqueued.workItem.workItemId,
      ...wrongBoundary
    })).workItem, null);
    for (const mutate of [
      () : any => store.cancel({ workItemId: enqueued.workItem.workItemId, ...wrongBoundary }),
      () : any => store.expire({ workItemId: enqueued.workItem.workItemId, force: true, ...wrongBoundary }),
      () : any => store.fail({ workItemId: enqueued.workItem.workItemId, internal: true, ...wrongBoundary })
    ]) {
      await assert.rejects(mutate, (error?: any) : any => error?.code === "work_queue_item_not_found");
    }
    const duplicate: any = await store.enqueue({
      ...resolved,
      payloadRef: { kind: "postgres-smoke", ref: "payload:pg-1" },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    });
    assert.equal(duplicate.deduped, true);
    await assert.rejects(() : any => store.enqueue({
      ...resolved,
      payloadRef: { kind: "postgres-smoke", ref: "payload:pg-conflict" },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    }), (error?: any) : any => error?.code === "work_queue_dedupe_conflict");
    await assert.rejects(() : any => store.enqueue({
      ...registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: definition.queueDefinitionId,
        scope,
        dedupeKey: { jobId: "pg-oversized" }
      }),
      payloadRef: { kind: "postgres-smoke", ref: "x".repeat(128) },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    }), (error?: any) : any => error?.reason === "payload_ref_bytes");
    const claim: any = await store.claim({
      queueDefinitionId: definition.queueDefinitionId,
      scope,
      workerId: "postgres-worker",
      leaseTimeoutMs: 100
    });
    assert.equal(claim.claimed.length, 1);
    const running: any = claim.claimed[0];
    await assert.rejects(() : any => store.complete({
      workItemId: running.workItem.workItemId,
      leaseId: "wrong-lease"
    }), /Lease fence rejected/);
    await assert.rejects(() : any => store.fail({
      workItemId: running.workItem.workItemId,
      internal: true
    }), /Lease fence rejected/);
    await assert.rejects(() : any => store.fail({
      workItemId: running.workItem.workItemId,
      leaseId: "wrong-lease"
    }), /Lease fence rejected/);
    const checkpointRef: Record<string, any> = {
      kind: "object",
      ref: "postgres-checkpoint-1",
      revision: "revision-1"
    };
    const checkpointed: any = await store.checkpoint({
      workItemId: running.workItem.workItemId,
      leaseId: running.lease.leaseId,
      checkpointRef,
      expectedCheckpointSeq: 0
    });
    assert.equal(checkpointed.workItem.checkpoint.checkpointSeq, 1);
    assert.deepEqual(checkpointed.workItem.checkpoint.checkpointRef, {
      ...checkpointRef,
      digest: ""
    });
    assert.equal((await store.checkpoint({
      workItemId: running.workItem.workItemId,
      leaseId: running.lease.leaseId,
      checkpointRef,
      expectedCheckpointSeq: 0
    })).idempotent, true);
    await assert.rejects(() : any => store.checkpoint({
      workItemId: running.workItem.workItemId,
      leaseId: running.lease.leaseId,
      checkpointRef: { kind: "object", ref: "postgres-checkpoint-2" },
      expectedCheckpointSeq: 0
    }), (error?: any) : any => error?.code === "work_queue_checkpoint_conflict");
    await store.progress({
      workItemId: running.workItem.workItemId,
      leaseId: running.lease.leaseId,
      extendMs: 100
    });
    const completed: any = await store.complete({
      workItemId: running.workItem.workItemId,
      leaseId: running.lease.leaseId
    });
    assert.equal(completed.workItem.state, WORK_QUEUE_STATES.COMPLETED);

    const expiringResolved: any = registry.resolveQueueDefinitionForEnqueue({
      queueDefinitionId: definition.queueDefinitionId,
      scope,
      dedupeKey: { jobId: "pg-expiry" }
    });
    const expiring: any = await store.enqueue({
      ...expiringResolved,
      expiresAtMs: 1_010,
      payloadRef: { kind: "postgres-smoke", ref: "payload:pg-expiry" },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    });
    assert.equal(expiring.workItem.expiresAtMs, 1_010);
    const expiryClaim: any = await store.claim({
      queueDefinitionId: definition.queueDefinitionId,
      scope,
      workerId: "postgres-expiry-worker",
      leaseTimeoutMs: 100
    });
    assert.equal(expiryClaim.claimed.length, 1);
    assert.equal(expiryClaim.claimed[0].lease.expiresAtMs, 1_010);
    timeSource.advance(10);
    const lateCompletion: any = await store.complete({
      workItemId: expiryClaim.claimed[0].workItem.workItemId,
      leaseId: expiryClaim.claimed[0].lease.leaseId
    });
    assert.equal(lateCompletion.completed, false);
    assert.equal(lateCompletion.expired, true);
    assert.equal(lateCompletion.workItem.state, WORK_QUEUE_STATES.EXPIRED);

    for (const jobId of ["pg-failed-oldest", "pg-failed-current"]) {
      const failedWork: any = await store.enqueue({
        ...registry.resolveQueueDefinitionForEnqueue({
          queueDefinitionId: definition.queueDefinitionId,
          scope,
          dedupeKey: { jobId }
        }),
        workItemId: jobId,
        payloadRef: { kind: "pg-fail", ref: jobId },
        ownerRef: { capability: "work-queue-postgres-conformance" }
      });
      const failedClaim: any = await store.claim({
        queueDefinitionId: definition.queueDefinitionId,
        scope,
        workerId: `worker-${jobId}`,
        batchSize: 1
      });
      assert.equal(failedClaim.claimed[0].workItem.workItemId, failedWork.workItem.workItemId);
      await store.fail({
        workItemId: failedWork.workItem.workItemId,
        leaseId: failedClaim.claimed[0].lease.leaseId,
        reason: "postgres_capacity_fixture"
      });
    }
    assert.equal((await store.inspect({ workItemId: "pg-failed-oldest" })).workItem, null);
    assert.equal((await store.inspect({ workItemId: "pg-failed-current" })).workItem.state, WORK_QUEUE_STATES.FAILED);

    const capacityDefinition: any = registry.registerQueueDefinition({
      label: "postgres.capacity",
      ownerCapability: "work-queue-postgres-conformance",
      policy: {
        capacity: {
          maxOutstanding: 5,
          maxOutstandingPerTenant: 5,
          maxOutstandingPerWorkspace: 5,
          maxOutstandingPerProject: 5,
          maxDelayed: 5,
          maxLeased: 2,
          maxLeasedPerTenant: 2,
          maxLeasedPerWorkspace: 2,
          maxLeasedPerProject: 2
        }
      }
    });
    await store.registerQueueDefinition(capacityDefinition);
    const capacityScope: Record<string, any> = { tenantId: "postgres-capacity", workspaceId: "container", projectId: "bounded" };
    const admissionResults: any = await Promise.allSettled(Array.from({ length: 20 }, (_?: any, index?: any) : any => store.enqueue({
      ...registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: capacityDefinition.queueDefinitionId,
        scope: capacityScope,
        dedupeKey: { index }
      }),
      workItemId: `pg-capacity-${index}`,
      payloadRef: { kind: "capacity", index },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    })));
    assert.equal(admissionResults.filter((entry?: any) : any => entry.status === "fulfilled").length, 5);
    assert.equal(admissionResults.filter((entry?: any) : any => entry.status === "rejected").length, 15);
    const capacityClaims: any = await Promise.all(Array.from({ length: 8 }, (_?: any, index?: any) : any => store.claim({
      queueDefinitionId: capacityDefinition.queueDefinitionId,
      scope: capacityScope,
      workerId: `postgres-capacity-worker-${index}`,
      batchSize: 2
    })));
    assert.equal(capacityClaims.reduce((count?: any, result?: any) : any => count + result.claimed.length, 0), 2);

    const agingDefinition: any = registry.registerQueueDefinition({
      label: "postgres.aging",
      ownerCapability: "work-queue-postgres-conformance",
      policy: {
        fairness: { agingIntervalMs: 1_000, agingBatchSize: 8 }
      }
    });
    await store.registerQueueDefinition(agingDefinition);
    const agingScope: Record<string, any> = { tenantId: "postgres-aging", workspaceId: "container" };
    await store.enqueue({
      ...registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: agingDefinition.queueDefinitionId,
        scope: agingScope,
        dedupeKey: "aged-low"
      }),
      workItemId: "pg-aged-low",
      payloadRef: { kind: "aging" },
      ownerRef: { capability: "work-queue-postgres-conformance" },
      priority: -1
    });
    timeSource.advance(4_000);
    await store.enqueue({
      ...registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: agingDefinition.queueDefinitionId,
        scope: agingScope,
        dedupeKey: "new-critical"
      }),
      workItemId: "pg-new-critical",
      payloadRef: { kind: "aging" },
      ownerRef: { capability: "work-queue-postgres-conformance" },
      priority: 2
    });
    const agingClaim: any = await store.claim({
      queueDefinitionId: agingDefinition.queueDefinitionId,
      scope: agingScope,
      workerId: "postgres-aging-worker",
      batchSize: 1
    });
    assert.equal(agingClaim.aged, 1);
    assert.equal(agingClaim.claimed[0].workItem.workItemId, "pg-aged-low");
    assert.equal(agingClaim.claimed[0].workItem.priorityClass, "critical");

    const reservationDefinition: any = registry.registerQueueDefinition({
      label: "postgres.reservation",
      ownerCapability: "work-queue-postgres-conformance",
      policy: {
        capacity: {
          maxOutstanding: 8,
          maxOutstandingPerTenant: 8,
          maxOutstandingPerWorkspace: 8,
          maxOutstandingPerProject: 8,
          maxDelayed: 8,
          maxLeased: 2,
          maxLeasedPerTenant: 2,
          maxLeasedPerWorkspace: 2,
          maxLeasedPerProject: 2
        },
        fairness: {
          minReservedLeasesPerPartition: 1,
          reservationScanLimit: 8
        }
      }
    });
    await store.registerQueueDefinition(reservationDefinition);
    const reservationBoundary: Record<string, any> = { tenantId: "postgres", workspaceId: "reservation" };
    const enqueueReserved: any = (workItemId?: any, tenantId?: any) : any => store.enqueue({
      ...registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: reservationDefinition.queueDefinitionId,
        scope: reservationBoundary,
        dedupeKey: workItemId
      }),
      workItemId,
      schedulingScope: { tenantId, workspaceId: "workspace-a", projectId: "project-a" },
      payloadRef: { kind: "reservation" },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    });
    await enqueueReserved("pg-tenant-a-running", "tenant-a");
    assert.equal((await store.claim({
      queueDefinitionId: reservationDefinition.queueDefinitionId,
      scope: reservationBoundary,
      schedulingScope: { tenantId: "tenant-a" },
      workerId: "postgres-reservation-a",
      batchSize: 1
    })).claimed.length, 1);
    await enqueueReserved("pg-tenant-a-hot", "tenant-a");
    await enqueueReserved("pg-tenant-b-under-served", "tenant-b");
    assert.equal((await store.claim({
      queueDefinitionId: reservationDefinition.queueDefinitionId,
      scope: reservationBoundary,
      schedulingScope: { tenantId: "tenant-a" },
      workerId: "postgres-reservation-hot",
      batchSize: 1
    })).claimed.length, 0);
    assert.equal((await store.claim({
      queueDefinitionId: reservationDefinition.queueDefinitionId,
      scope: reservationBoundary,
      schedulingScope: { tenantId: "tenant-b" },
      workerId: "postgres-reservation-b",
      batchSize: 1
    })).claimed[0].workItem.workItemId, "pg-tenant-b-under-served");

    const sparsePriorityBatchSize: any = 280;
    const sparsePriorityDefinition: any = registry.registerQueueDefinition({
      label: "postgres.sparse-priority",
      ownerCapability: "work-queue-postgres-conformance",
      policy: {
        capacity: {
          maxOutstanding: sparsePriorityBatchSize,
          maxOutstandingPerTenant: sparsePriorityBatchSize,
          maxOutstandingPerWorkspace: sparsePriorityBatchSize,
          maxOutstandingPerProject: sparsePriorityBatchSize,
          maxDelayed: sparsePriorityBatchSize,
          maxLeased: sparsePriorityBatchSize,
          maxLeasedPerTenant: sparsePriorityBatchSize,
          maxLeasedPerWorkspace: sparsePriorityBatchSize,
          maxLeasedPerProject: sparsePriorityBatchSize
        }
      }
    });
    await store.registerQueueDefinition(sparsePriorityDefinition);
    const sparsePriorityScope: Record<string, any> = {
      tenantId: "postgres-sparse-priority",
      workspaceId: "container",
      projectId: "low-only"
    };
    await Promise.all(Array.from({ length: sparsePriorityBatchSize }, (_?: any, index?: any) : any => store.enqueue({
      ...registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: sparsePriorityDefinition.queueDefinitionId,
        scope: sparsePriorityScope,
        dedupeKey: { index }
      }),
      workItemId: `pg-low-only-${index}`,
      payloadRef: { kind: "sparse-priority", index },
      ownerRef: { capability: "work-queue-postgres-conformance" },
      priority: -1
    })));
    const sparsePriorityClaim: any = await store.claim({
      queueDefinitionId: sparsePriorityDefinition.queueDefinitionId,
      scope: sparsePriorityScope,
      workerId: "postgres-sparse-priority-worker",
      batchSize: sparsePriorityBatchSize
    });
    assert.equal(sparsePriorityClaim.claimed.length, sparsePriorityBatchSize);
    assert.equal(sparsePriorityClaim.claimed.every(({ workItem }: Record<string, any>) : any => workItem.priorityClass === "low"), true);

    const cursorRetentionDefinition: any = registry.registerQueueDefinition({
      label: "postgres.cursor-retention",
      ownerCapability: "work-queue-postgres-conformance"
    });
    await store.registerQueueDefinition(cursorRetentionDefinition);
    const cursorRetentionRequest: any = registry.resolveQueueDefinitionForEnqueue({
      queueDefinitionId: cursorRetentionDefinition.queueDefinitionId,
      scope: {},
      dedupeKey: "cursor-retention"
    });
    await store.enqueue({
      ...cursorRetentionRequest,
      workItemId: "pg-cursor-retention",
      payloadRef: { kind: "cursor-retention" },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    });
    const cursorRetentionClaim: any = (await store.claim({
      queueDefinitionId: cursorRetentionDefinition.queueDefinitionId,
      scope: {},
      workerId: "postgres-cursor-retention-worker",
      batchSize: 1
    })).claimed[0];
    assert.ok(Number((await store.database.query(`
      SELECT COUNT(*) AS count FROM work_queue_fairness_cursors
      WHERE queue_definition_id = $1
    `, [cursorRetentionDefinition.queueDefinitionId])).rows[0].count) > 0);
    await store.complete({
      workItemId: cursorRetentionClaim.workItem.workItemId,
      leaseId: cursorRetentionClaim.lease.leaseId
    });
    assert.equal(Number((await store.database.query(`
      SELECT COUNT(*) AS count FROM work_queue_fairness_cursors
      WHERE queue_definition_id = $1
    `, [cursorRetentionDefinition.queueDefinitionId])).rows[0].count), 0);

    const concurrencyDefinition: any = registry.registerQueueDefinition({
      label: "postgres.concurrency-key",
      ownerCapability: "work-queue-postgres-conformance",
      policy: {
        capacity: {
          maxOutstanding: 10,
          maxOutstandingPerTenant: 10,
          maxOutstandingPerWorkspace: 10,
          maxOutstandingPerProject: 10,
          maxDelayed: 10,
          maxLeased: 10,
          maxLeasedPerTenant: 10,
          maxLeasedPerWorkspace: 10,
          maxLeasedPerProject: 10
        }
      }
    });
    await store.registerQueueDefinition(concurrencyDefinition);
    const concurrencyScope: Record<string, any> = { tenantId: "postgres-concurrency", workspaceId: "container", projectId: "shared" };
    await Promise.all(Array.from({ length: 4 }, (_?: any, index?: any) : any => store.enqueue({
      ...registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: concurrencyDefinition.queueDefinitionId,
        scope: concurrencyScope,
        dedupeKey: { index }
      }),
      workItemId: `pg-concurrency-${index}`,
      concurrencyKey: "shared-resource",
      payloadRef: { kind: "concurrency", index },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    })));
    const concurrencyClaims: any = await Promise.all(Array.from({ length: 6 }, (_?: any, index?: any) : any => store.claim({
      queueDefinitionId: concurrencyDefinition.queueDefinitionId,
      scope: concurrencyScope,
      workerId: `postgres-concurrency-worker-${index}`,
      batchSize: 4
    })));
    assert.equal(concurrencyClaims.reduce((count?: any, result?: any) : any => count + result.claimed.length, 0), 1);

    const repairWork: any = await store.enqueue({
      ...registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: definition.queueDefinitionId,
        scope,
        dedupeKey: { jobId: "pg-projection-repair" }
      }),
      workItemId: "pg-projection-repair",
      payloadRef: { kind: "repair", ref: "projection" },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    });
    await store.database.query("DELETE FROM work_items WHERE work_item_id = $1", [repairWork.workItem.workItemId]);
    const detectedRepair: any = await store.rebuildProjection();
    assert.equal(detectedRepair.ok, false);
    assert.equal(detectedRepair.drift.some((entry?: any) : any =>
      entry.workItemId === repairWork.workItem.workItemId && entry.reason === "missing_from_projection"), true);
    const appliedRepair: any = await store.rebuildProjection({ dryRun: false });
    assert.equal(appliedRepair.ok, true);
    assert.equal(appliedRepair.applied, true);
    assert.equal((await store.inspect({ workItemId: repairWork.workItem.workItemId })).workItem.state, WORK_QUEUE_STATES.QUEUED);

    const replay: any = await store.rebuildProjection();
    assert.equal(replay.ok, true, JSON.stringify(replay, null, 2));
    const inspected: any = await store.inspect({ states: [WORK_QUEUE_STATES.COMPLETED] });
    assert.equal(inspected.items.some((item?: any) : any => item.workItemId === completed.workItem.workItemId), true);
    assert.equal(inspected.items.some((item?: any) : any => item.workItemId === "pg-cursor-retention"), true);
    const expired: any = await store.inspect({ states: [WORK_QUEUE_STATES.EXPIRED] });
    assert.equal(expired.items.length, 1);
    await store.close();
    store = null;
    console.log(`[work-queue-postgres-container] ok (${inspected.items.length} completed, ${expired.items.length} expired)`);
  } finally {
    await store?.close().catch(() : any => null);
    if (started) {
      await docker(["rm", "-f", containerName]).catch(() : any => null);
    }
  }
}

await main();
