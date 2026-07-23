#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import {
  createManualQueueTimeSource,
  createPostgresWorkQueueStore,
  createQueueDefinitionRegistry
} from "../../packages/foundation/src/work-queue/index.mjs";
import { WORK_QUEUE_STATES } from "../../packages/foundation/src/workflow/state-machine/work-queue/state-machine.mjs";

const runId = `${process.pid}-${Date.now()}`;
const containerName = `lico-work-queue-postgres-${runId}`;
const image = process.env.LICO_WORK_QUEUE_POSTGRES_IMAGE || "postgres:16-alpine";

function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env || {}) }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, Number(options.timeoutMs || 120000));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (options.stream) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (options.stream) process.stderr.write(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} failed code=${code} signal=${signal || ""}`));
    });
  });
}

async function docker(args = [], options = {}) {
  return run("docker", args, options);
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForPostgres(connectionString) {
  let lastError = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const store = await createPostgresWorkQueueStore({ connectionString });
      await store.close();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError || new Error("postgres did not become ready");
}

async function main() {
  await docker(["image", "inspect", image]).catch(() => docker(["pull", image], { timeoutMs: 900000 }));
  const port = await freePort();
  const connectionString = [
    "postgresql://",
    "lico",
    ":",
    "lico",
    "@127.0.0.1:",
    String(port),
    "/lico"
  ].join("");
  let started = false;
  let store = null;
  try {
    await docker([
      "run", "-d",
      "--name", containerName,
      "-e", "POSTGRES_USER=lico",
      "-e", "POSTGRES_PASSWORD=lico",
      "-e", "POSTGRES_DB=lico",
      "-p", `${port}:5432`,
      image
    ], { timeoutMs: 120000 });
    started = true;
    await waitForPostgres(connectionString);

    const timeSource = createManualQueueTimeSource(1000);
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
    const registry = createQueueDefinitionRegistry();
    const definition = registry.registerQueueDefinition({
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
      () => store.registerQueueDefinition({
        ...definition,
        policy: { ...definition.policy, maxInFlight: 99 }
      }),
      (error) => error?.code === "work_queue_definition_conflict"
    );
    const nextDefinition = registry.registerQueueDefinition({
      queueDefinitionId: definition.queueDefinitionId,
      label: definition.label,
      ownerCapability: definition.ownerCapability,
      policy: { maxInFlight: 2 }
    });
    assert.equal((await store.registerQueueDefinition(nextDefinition)).registered, true);
    await assert.rejects(
      () => store.registerQueueDefinition({
        ...nextDefinition,
        queueDefinitionId: "queue.postgres.label-alias",
        queueDefinitionVersion: 1
      }),
      (error) => error?.code === "work_queue_definition_conflict"
    );
    const scope = { tenantId: "postgres", workspaceId: "container" };
    const resolved = registry.resolveQueueDefinitionForEnqueue({
      queueDefinitionId: definition.queueDefinitionId,
      scope,
      dedupeKey: { jobId: "pg-1" }
    });
    const enqueued = await store.enqueue({
      ...resolved,
      payloadRef: { kind: "postgres-smoke", ref: "payload:pg-1" },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    });
    assert.equal(enqueued.workItem.state, WORK_QUEUE_STATES.QUEUED);
    const wrongBoundary = {
      queueDefinitionId: "queue.postgres.not-owned",
      scope: { tenantId: "postgres", workspaceId: "other" }
    };
    assert.equal((await store.inspect({
      workItemId: enqueued.workItem.workItemId,
      ...wrongBoundary
    })).workItem, null);
    for (const mutate of [
      () => store.cancel({ workItemId: enqueued.workItem.workItemId, ...wrongBoundary }),
      () => store.expire({ workItemId: enqueued.workItem.workItemId, force: true, ...wrongBoundary }),
      () => store.fail({ workItemId: enqueued.workItem.workItemId, internal: true, ...wrongBoundary })
    ]) {
      await assert.rejects(mutate, (error) => error?.code === "work_queue_item_not_found");
    }
    const duplicate = await store.enqueue({
      ...resolved,
      payloadRef: { kind: "postgres-smoke", ref: "payload:pg-1" },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    });
    assert.equal(duplicate.deduped, true);
    await assert.rejects(() => store.enqueue({
      ...resolved,
      payloadRef: { kind: "postgres-smoke", ref: "payload:pg-conflict" },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    }), (error) => error?.code === "work_queue_dedupe_conflict");
    await assert.rejects(() => store.enqueue({
      ...registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: definition.queueDefinitionId,
        scope,
        dedupeKey: { jobId: "pg-oversized" }
      }),
      payloadRef: { kind: "postgres-smoke", ref: "x".repeat(128) },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    }), (error) => error?.reason === "payload_ref_bytes");
    const claim = await store.claim({
      queueDefinitionId: definition.queueDefinitionId,
      scope,
      workerId: "postgres-worker",
      leaseTimeoutMs: 100
    });
    assert.equal(claim.claimed.length, 1);
    const running = claim.claimed[0];
    await assert.rejects(() => store.complete({
      workItemId: running.workItem.workItemId,
      leaseId: "wrong-lease"
    }), /Lease fence rejected/);
    await assert.rejects(() => store.fail({
      workItemId: running.workItem.workItemId,
      internal: true
    }), /Lease fence rejected/);
    await assert.rejects(() => store.fail({
      workItemId: running.workItem.workItemId,
      leaseId: "wrong-lease"
    }), /Lease fence rejected/);
    const checkpointRef = {
      kind: "object",
      ref: "postgres-checkpoint-1",
      revision: "revision-1"
    };
    const checkpointed = await store.checkpoint({
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
    await assert.rejects(() => store.checkpoint({
      workItemId: running.workItem.workItemId,
      leaseId: running.lease.leaseId,
      checkpointRef: { kind: "object", ref: "postgres-checkpoint-2" },
      expectedCheckpointSeq: 0
    }), (error) => error?.code === "work_queue_checkpoint_conflict");
    await store.progress({
      workItemId: running.workItem.workItemId,
      leaseId: running.lease.leaseId,
      extendMs: 100
    });
    const completed = await store.complete({
      workItemId: running.workItem.workItemId,
      leaseId: running.lease.leaseId
    });
    assert.equal(completed.workItem.state, WORK_QUEUE_STATES.COMPLETED);

    const expiringResolved = registry.resolveQueueDefinitionForEnqueue({
      queueDefinitionId: definition.queueDefinitionId,
      scope,
      dedupeKey: { jobId: "pg-expiry" }
    });
    const expiring = await store.enqueue({
      ...expiringResolved,
      expiresAtMs: 1_010,
      payloadRef: { kind: "postgres-smoke", ref: "payload:pg-expiry" },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    });
    assert.equal(expiring.workItem.expiresAtMs, 1_010);
    const expiryClaim = await store.claim({
      queueDefinitionId: definition.queueDefinitionId,
      scope,
      workerId: "postgres-expiry-worker",
      leaseTimeoutMs: 100
    });
    assert.equal(expiryClaim.claimed.length, 1);
    assert.equal(expiryClaim.claimed[0].lease.expiresAtMs, 1_010);
    timeSource.advance(10);
    const lateCompletion = await store.complete({
      workItemId: expiryClaim.claimed[0].workItem.workItemId,
      leaseId: expiryClaim.claimed[0].lease.leaseId
    });
    assert.equal(lateCompletion.completed, false);
    assert.equal(lateCompletion.expired, true);
    assert.equal(lateCompletion.workItem.state, WORK_QUEUE_STATES.EXPIRED);

    for (const jobId of ["pg-failed-oldest", "pg-failed-current"]) {
      const failedWork = await store.enqueue({
        ...registry.resolveQueueDefinitionForEnqueue({
          queueDefinitionId: definition.queueDefinitionId,
          scope,
          dedupeKey: { jobId }
        }),
        workItemId: jobId,
        payloadRef: { kind: "pg-fail", ref: jobId },
        ownerRef: { capability: "work-queue-postgres-conformance" }
      });
      const failedClaim = await store.claim({
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

    const capacityDefinition = registry.registerQueueDefinition({
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
    const capacityScope = { tenantId: "postgres-capacity", workspaceId: "container", projectId: "bounded" };
    const admissionResults = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => store.enqueue({
      ...registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: capacityDefinition.queueDefinitionId,
        scope: capacityScope,
        dedupeKey: { index }
      }),
      workItemId: `pg-capacity-${index}`,
      payloadRef: { kind: "capacity", index },
      ownerRef: { capability: "work-queue-postgres-conformance" }
    })));
    assert.equal(admissionResults.filter((entry) => entry.status === "fulfilled").length, 5);
    assert.equal(admissionResults.filter((entry) => entry.status === "rejected").length, 15);
    const capacityClaims = await Promise.all(Array.from({ length: 8 }, (_, index) => store.claim({
      queueDefinitionId: capacityDefinition.queueDefinitionId,
      scope: capacityScope,
      workerId: `postgres-capacity-worker-${index}`,
      batchSize: 2
    })));
    assert.equal(capacityClaims.reduce((count, result) => count + result.claimed.length, 0), 2);

    const agingDefinition = registry.registerQueueDefinition({
      label: "postgres.aging",
      ownerCapability: "work-queue-postgres-conformance",
      policy: {
        fairness: { agingIntervalMs: 1_000, agingBatchSize: 8 }
      }
    });
    await store.registerQueueDefinition(agingDefinition);
    const agingScope = { tenantId: "postgres-aging", workspaceId: "container" };
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
    const agingClaim = await store.claim({
      queueDefinitionId: agingDefinition.queueDefinitionId,
      scope: agingScope,
      workerId: "postgres-aging-worker",
      batchSize: 1
    });
    assert.equal(agingClaim.aged, 1);
    assert.equal(agingClaim.claimed[0].workItem.workItemId, "pg-aged-low");
    assert.equal(agingClaim.claimed[0].workItem.priorityClass, "critical");

    const reservationDefinition = registry.registerQueueDefinition({
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
    const reservationBoundary = { tenantId: "postgres", workspaceId: "reservation" };
    const enqueueReserved = (workItemId, tenantId) => store.enqueue({
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

    const sparsePriorityBatchSize = 280;
    const sparsePriorityDefinition = registry.registerQueueDefinition({
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
    const sparsePriorityScope = {
      tenantId: "postgres-sparse-priority",
      workspaceId: "container",
      projectId: "low-only"
    };
    await Promise.all(Array.from({ length: sparsePriorityBatchSize }, (_, index) => store.enqueue({
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
    const sparsePriorityClaim = await store.claim({
      queueDefinitionId: sparsePriorityDefinition.queueDefinitionId,
      scope: sparsePriorityScope,
      workerId: "postgres-sparse-priority-worker",
      batchSize: sparsePriorityBatchSize
    });
    assert.equal(sparsePriorityClaim.claimed.length, sparsePriorityBatchSize);
    assert.equal(sparsePriorityClaim.claimed.every(({ workItem }) => workItem.priorityClass === "low"), true);

    const cursorRetentionDefinition = registry.registerQueueDefinition({
      label: "postgres.cursor-retention",
      ownerCapability: "work-queue-postgres-conformance"
    });
    await store.registerQueueDefinition(cursorRetentionDefinition);
    const cursorRetentionRequest = registry.resolveQueueDefinitionForEnqueue({
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
    const cursorRetentionClaim = (await store.claim({
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

    const concurrencyDefinition = registry.registerQueueDefinition({
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
    const concurrencyScope = { tenantId: "postgres-concurrency", workspaceId: "container", projectId: "shared" };
    await Promise.all(Array.from({ length: 4 }, (_, index) => store.enqueue({
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
    const concurrencyClaims = await Promise.all(Array.from({ length: 6 }, (_, index) => store.claim({
      queueDefinitionId: concurrencyDefinition.queueDefinitionId,
      scope: concurrencyScope,
      workerId: `postgres-concurrency-worker-${index}`,
      batchSize: 4
    })));
    assert.equal(concurrencyClaims.reduce((count, result) => count + result.claimed.length, 0), 1);

    const repairWork = await store.enqueue({
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
    const detectedRepair = await store.rebuildProjection();
    assert.equal(detectedRepair.ok, false);
    assert.equal(detectedRepair.drift.some((entry) =>
      entry.workItemId === repairWork.workItem.workItemId && entry.reason === "missing_from_projection"), true);
    const appliedRepair = await store.rebuildProjection({ dryRun: false });
    assert.equal(appliedRepair.ok, true);
    assert.equal(appliedRepair.applied, true);
    assert.equal((await store.inspect({ workItemId: repairWork.workItem.workItemId })).workItem.state, WORK_QUEUE_STATES.QUEUED);

    const replay = await store.rebuildProjection();
    assert.equal(replay.ok, true, JSON.stringify(replay, null, 2));
    const inspected = await store.inspect({ states: [WORK_QUEUE_STATES.COMPLETED] });
    assert.equal(inspected.items.some((item) => item.workItemId === completed.workItem.workItemId), true);
    assert.equal(inspected.items.some((item) => item.workItemId === "pg-cursor-retention"), true);
    const expired = await store.inspect({ states: [WORK_QUEUE_STATES.EXPIRED] });
    assert.equal(expired.items.length, 1);
    await store.close();
    store = null;
    console.log(`[work-queue-postgres-container] ok (${inspected.items.length} completed, ${expired.items.length} expired)`);
  } finally {
    await store?.close().catch(() => null);
    if (started) {
      await docker(["rm", "-f", containerName]).catch(() => null);
    }
  }
}

await main();
