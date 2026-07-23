import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeDeterministicRetryDelay,
  DEFAULT_QUEUE_POLICY
} from "../../../packages/foundation/src/work-queue/policies.mjs";
import {
  assertCapacityBelow,
  agedWorkQueuePriorityClass,
  hierarchicalScopeParts,
  nextPriorityCursor,
  normalizeWorkQueuePriority,
  priorityClassAtCursor,
  WORK_QUEUE_PRIORITY_CLASSES,
  WORK_QUEUE_PRIORITY_CYCLE,
  WORK_QUEUE_PRIORITY_WEIGHTS
} from "../../../packages/foundation/src/work-queue/scheduling.mjs";
import {
  createQueueDefinitionRegistry,
  createQueuePushDispatcher,
  createSqliteWorkQueueStore,
  createFixedQueueTimeSource
} from "../../../packages/foundation/src/work-queue/index.mjs";

const roots = [];

async function createFixture(policy = {}) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "work-queue-scheduling-"));
  roots.push(userDataPath);
  const registry = createQueueDefinitionRegistry();
  const definition = registry.registerQueueDefinition({
    queueDefinitionId: "queue.scheduling.fixture",
    label: "queue.scheduling.fixture",
    ownerCapability: "queue-scheduling-test"
  });
  const store = createSqliteWorkQueueStore({
    userDataPath,
    timeSource: createFixedQueueTimeSource(10_000),
    policy
  });
  store.registerQueueDefinition(definition);
  return { store, definition, registry };
}

async function enqueue(fixture, workItemId, scope, priority = 0) {
  return fixture.store.enqueue({
    ...fixture.registry.resolveQueueDefinitionForEnqueue({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope,
      dedupeKey: workItemId
    }),
    workItemId,
    payloadRef: { kind: "scheduling-test", workItemId },
    ownerRef: { capability: "queue-scheduling-test" },
    priority
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("work queue scheduling policy", () => {
  it("persists immutable queue definition versions without label aliasing", async () => {
    const fixture = await createFixture();
    const replay = fixture.store.registerQueueDefinition(fixture.definition);
    expect(replay).toMatchObject({ registered: false, idempotent: true });

    expect(() => fixture.store.registerQueueDefinition({
      ...fixture.definition,
      policy: { ...fixture.definition.policy, maxInFlight: 99 }
    })).toThrow(expect.objectContaining({ code: "work_queue_definition_conflict" }));

    const nextVersion = fixture.registry.registerQueueDefinition({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      label: fixture.definition.label,
      ownerCapability: fixture.definition.ownerCapability,
      policy: { maxInFlight: 2 }
    });
    expect(fixture.store.registerQueueDefinition(nextVersion)).toMatchObject({
      registered: true,
      queueDefinitionVersion: 2
    });

    expect(() => fixture.store.registerQueueDefinition({
      ...nextVersion,
      queueDefinitionId: "queue.scheduling.label-alias",
      queueDefinitionVersion: 1
    })).toThrow(expect.objectContaining({ code: "work_queue_definition_conflict" }));
  });

  it("evolves one stable queue definition through immutable versions", () => {
    const registry = createQueueDefinitionRegistry();
    const first = registry.registerQueueDefinition({
      queueDefinitionId: "queue.stable.definition",
      label: "queue.stable.definition",
      ownerCapability: "queue-definition-test"
    });
    const second = registry.registerQueueDefinition({
      queueDefinitionId: first.queueDefinitionId,
      label: first.label,
      ownerCapability: first.ownerCapability,
      policy: { maxInFlight: 2 }
    });
    const renamed = registry.registerQueueDefinition({
      queueDefinitionId: first.queueDefinitionId,
      queueDefinitionVersion: 3,
      label: "queue.stable.definition-renamed",
      ownerCapability: first.ownerCapability
    });

    expect([first.queueDefinitionVersion, second.queueDefinitionVersion, renamed.queueDefinitionVersion])
      .toEqual([1, 2, 3]);
    expect(second.labelHistory).toEqual([]);
    expect(first.definitionDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.metadata.definitionDigest).toBe(first.definitionDigest);
    expect(second.definitionDigest).not.toBe(first.definitionDigest);
    expect(renamed.labelHistory).toEqual([first.label]);
    expect(registry.resolveQueueDefinition({ queueDefinitionId: first.queueDefinitionId }))
      .toBe(renamed);
    expect(registry.resolveQueueDefinition({ label: first.label })).toBe(renamed);
    expect(() => registry.registerQueueDefinition({
      queueDefinitionId: "queue.other.definition",
      label: first.label,
      ownerCapability: "other-owner"
    })).toThrow(/label is already in use/u);
    expect(() => registry.registerQueueDefinition({
      queueDefinitionId: first.queueDefinitionId,
      label: renamed.label,
      ownerCapability: "other-owner"
    })).toThrow(/owner cannot change/u);
    expect(() => registry.registerQueueDefinition({
      queueDefinitionId: first.queueDefinitionId,
      queueDefinitionVersion: 3,
      label: renamed.label,
      ownerCapability: first.ownerCapability
    })).toThrow(/version 3 already exists/u);
  });

  it("uses a finite deterministic weighted priority cycle", () => {
    const observed = Object.fromEntries(
      Object.values(WORK_QUEUE_PRIORITY_CLASSES).map((priorityClass) => [priorityClass, 0])
    );
    let cursor = 0;
    for (let index = 0; index < WORK_QUEUE_PRIORITY_CYCLE.length * 3; index += 1) {
      observed[priorityClassAtCursor(cursor)] += 1;
      cursor = nextPriorityCursor(cursor);
    }
    for (const [priorityClass, weight] of Object.entries(WORK_QUEUE_PRIORITY_WEIGHTS)) {
      expect(observed[priorityClass]).toBe(weight * 3);
    }
    expect(cursor).toBe(0);
  });

  it("normalizes arbitrary numeric priority into the closed class set", () => {
    expect(normalizeWorkQueuePriority(200)).toEqual({ priority: 2, priorityClass: "critical" });
    expect(normalizeWorkQueuePriority(1)).toEqual({ priority: 1, priorityClass: "high" });
    expect(normalizeWorkQueuePriority(0)).toEqual({ priority: 0, priorityClass: "normal" });
    expect(normalizeWorkQueuePriority(-100)).toEqual({ priority: -1, priorityClass: "low" });
  });

  it("promotes waiting work through the finite priority classes", () => {
    expect(agedWorkQueuePriorityClass({
      priority: -1,
      availableAtMs: 1_000,
      nowMs: 4_000,
      agingIntervalMs: 1_000
    })).toBe("critical");
    expect(agedWorkQueuePriorityClass({
      priority: 0,
      availableAtMs: 1_000,
      nowMs: 2_000,
      agingIntervalMs: 1_000
    })).toBe("high");
  });

  it("normalizes the tenant workspace project hierarchy without inferred values", () => {
    expect(hierarchicalScopeParts({
      tenantId: " tenant-a ",
      workspaceId: " workspace-a ",
      projectId: " project-a "
    })).toEqual({
      tenantId: "tenant-a",
      workspaceId: "workspace-a",
      projectId: "project-a"
    });
    expect(hierarchicalScopeParts({})).toEqual({
      tenantId: "",
      workspaceId: "",
      projectId: ""
    });
  });

  it("rejects capacity at the exact bound with a stable reason", () => {
    expect(() => assertCapacityBelow({
      count: 4,
      limit: 4,
      reason: "project_outstanding"
    })).toThrow(expect.objectContaining({
      code: "work_queue_capacity_exceeded",
      reason: "project_outstanding",
      limit: 4
    }));
    expect(() => assertCapacityBelow({ count: 3, limit: 4, reason: "project_outstanding" }))
      .not.toThrow();
  });

  it("derives bounded retry jitter deterministically from stable queue inputs", () => {
    const input = {
      queueDefinitionId: "queue-fixture",
      workItemId: "work-fixture",
      attempt: 4,
      initialDelayMs: 100,
      multiplier: 2,
      maxDelayMs: 10_000,
      retrySeed: "fixed-seed",
      maxJitterBps: 2000
    };
    const first = computeDeterministicRetryDelay(input);
    const replay = computeDeterministicRetryDelay(input);
    expect(replay).toBe(first);
    expect(first).toBeGreaterThanOrEqual(800);
    expect(first).toBeLessThanOrEqual(960);
    expect(computeDeterministicRetryDelay({ ...input, workItemId: "other-work" }))
      .not.toBe(first);
    expect(DEFAULT_QUEUE_POLICY.retryBackoff.jitter).toBe("deterministic_sha256");
  });

  it("enforces project capacity transactionally without partial admission", async () => {
    const fixture = await createFixture({
      capacity: {
        ...DEFAULT_QUEUE_POLICY.capacity,
        maxOutstandingPerProject: 2
      }
    });
    const scope = { tenantId: "tenant-a", workspaceId: "workspace-a", projectId: "project-a" };
    await enqueue(fixture, "capacity-1", scope);
    await enqueue(fixture, "capacity-2", scope);
    await expect(enqueue(fixture, "capacity-3", scope)).rejects.toMatchObject({
      code: "work_queue_capacity_exceeded",
      reason: "project_outstanding"
    });
    const inspected = fixture.store.inspect({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      limit: 10
    });
    expect(inspected.items.map((item) => item.workItemId).sort()).toEqual([
      "capacity-1",
      "capacity-2"
    ]);
    fixture.store.close();
  });

  it("scopes state counts to the same queue boundary as listed items", async () => {
    const fixture = await createFixture();
    const firstScope = { tenantId: "tenant-a", workspaceId: "first" };
    const secondScope = { tenantId: "tenant-a", workspaceId: "second" };
    await enqueue(fixture, "scope-first", firstScope);
    await enqueue(fixture, "scope-second", secondScope);
    fixture.store.cancel({
      workItemId: "scope-second",
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: secondScope
    });

    const inspected = fixture.store.inspect({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: firstScope
    });
    expect(inspected.items.map((item) => item.workItemId)).toEqual(["scope-first"]);
    expect(inspected.stateCounts).toEqual([{ state: "queued", count: 1 }]);
    fixture.store.close();
  });

  it("never claims work outside the authorization scope boundary", async () => {
    const fixture = await createFixture();
    const ownedScope = { tenantId: "authorization", workspaceId: "owned" };
    const otherScope = { tenantId: "authorization", workspaceId: "other" };
    await enqueue(fixture, "other-scope-older", otherScope);
    await enqueue(fixture, "owned-scope-newer", ownedScope);

    const claim = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: ownedScope,
      workerId: "scope-boundary-worker",
      batchSize: 2
    });

    expect(claim.claimed.map(({ workItem }) => workItem.workItemId))
      .toEqual(["owned-scope-newer"]);
    expect(fixture.store.inspect({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: otherScope
    }).items).toEqual([expect.objectContaining({ workItemId: "other-scope-older", state: "queued" })]);
    fixture.store.close();
  });

  it("keeps authorization scope fixed while fairly rotating per-item scheduling hierarchy", async () => {
    const fixture = await createFixture();
    const boundary = { tenantId: "platform", workspaceId: "job-workflow" };
    const enqueueScheduled = (workItemId, tenantId) => {
      const resolved = fixture.registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: fixture.definition.queueDefinitionId,
        scope: boundary,
        dedupeKey: workItemId
      });
      return fixture.store.enqueue({
        ...resolved,
        workItemId,
        schedulingScope: { tenantId, workspaceId: "workspace-a" },
        payloadRef: { kind: "scheduling-test", workItemId },
        ownerRef: { capability: "queue-scheduling-test" }
      });
    };
    for (const workItemId of ["tenant-a-1", "tenant-a-2", "tenant-a-3"]) {
      enqueueScheduled(workItemId, "tenant-a");
    }
    enqueueScheduled("tenant-b-1", "tenant-b");

    const claim = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: boundary,
      schedulingScope: {},
      workerId: "fair-worker",
      batchSize: 2
    });
    expect(claim.claimed.map(({ workItem }) => workItem.schedulingScope.tenantId))
      .toEqual(["tenant-a", "tenant-b"]);
    expect(claim.claimed.every(({ workItem }) => workItem.scopeKey === claim.claimed[0].workItem.scopeKey))
      .toBe(true);
    fixture.store.close();
  });

  it("fills a bounded batch when only the sparsest weighted priority class has work", async () => {
    const capacity = Object.fromEntries(
      Object.keys(DEFAULT_QUEUE_POLICY.capacity).map((key) => [key, 1_000])
    );
    capacity.maxPayloadRefBytes = DEFAULT_QUEUE_POLICY.capacity.maxPayloadRefBytes;
    const fixture = await createFixture({ capacity });
    const batchSize = 280;
    for (let index = 0; index < batchSize; index += 1) {
      await enqueue(fixture, `low-only-${index}`, {}, -1);
    }

    const claim = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: {},
      workerId: "low-only-worker",
      batchSize
    });

    expect(claim.claimed).toHaveLength(batchSize);
    expect(claim.claimed.every(({ workItem }) => workItem.priorityClass === "low")).toBe(true);
    fixture.store.close();
  });

  it("ages old claimable work without a global priority sort", async () => {
    const fixture = await createFixture({
      fairness: { ...DEFAULT_QUEUE_POLICY.fairness, agingIntervalMs: 1_000, agingBatchSize: 8 }
    });
    const boundary = { tenantId: "platform", workspaceId: "aging" };
    const enqueueAt = (workItemId, priority, availableAtMs) => fixture.store.enqueue({
      ...fixture.registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: fixture.definition.queueDefinitionId,
        scope: boundary,
        dedupeKey: workItemId
      }),
      workItemId,
      schedulingScope: { tenantId: "tenant-a", workspaceId: "workspace-a" },
      payloadRef: { kind: "aging-test", workItemId },
      ownerRef: { capability: "queue-scheduling-test" },
      priority,
      availableAtMs
    });
    enqueueAt("aged-low", -1, 1);
    enqueueAt("new-critical", 2, 10_000);

    const claim = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: boundary,
      schedulingScope: {},
      workerId: "aging-worker",
      batchSize: 1
    });

    expect(claim.aged).toBe(1);
    expect(claim.claimed[0].workItem).toMatchObject({
      workItemId: "aged-low",
      priority: -1,
      priorityClass: "critical"
    });
    fixture.store.close();
  });

  it("reserves parent lease capacity for an active underserved tenant", async () => {
    const fixture = await createFixture({
      capacity: {
        ...DEFAULT_QUEUE_POLICY.capacity,
        maxLeased: 2,
        maxLeasedPerTenant: 2,
        maxLeasedPerWorkspace: 2,
        maxLeasedPerProject: 2
      },
      fairness: {
        ...DEFAULT_QUEUE_POLICY.fairness,
        minReservedLeasesPerPartition: 1,
        reservationScanLimit: 8
      }
    });
    const boundary = { tenantId: "platform", workspaceId: "reservation" };
    const enqueueScheduled = (workItemId, tenantId) => fixture.store.enqueue({
      ...fixture.registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: fixture.definition.queueDefinitionId,
        scope: boundary,
        dedupeKey: workItemId
      }),
      workItemId,
      schedulingScope: { tenantId, workspaceId: "workspace-a", projectId: "project-a" },
      payloadRef: { kind: "reservation-test", workItemId },
      ownerRef: { capability: "queue-scheduling-test" }
    });
    enqueueScheduled("tenant-a-running", "tenant-a");
    const first = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: boundary,
      schedulingScope: { tenantId: "tenant-a" },
      workerId: "reservation-worker-a",
      batchSize: 1
    });
    expect(first.claimed).toHaveLength(1);
    enqueueScheduled("tenant-a-hot", "tenant-a");
    enqueueScheduled("tenant-b-under-served", "tenant-b");

    const hotClaim = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: boundary,
      schedulingScope: { tenantId: "tenant-a" },
      workerId: "reservation-worker-hot",
      batchSize: 1
    });
    expect(hotClaim.claimed).toEqual([]);
    const reservedClaim = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: boundary,
      schedulingScope: { tenantId: "tenant-b" },
      workerId: "reservation-worker-b",
      batchSize: 1
    });
    expect(reservedClaim.claimed[0].workItem.workItemId).toBe("tenant-b-under-served");
    fixture.store.close();
  });

  it("reclaims persisted fairness cursors when a queue boundary becomes terminal", async () => {
    const fixture = await createFixture();
    await enqueue(fixture, "cursor-retention", {}, 0);
    const claimed = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: {},
      workerId: "cursor-retention-worker",
      batchSize: 1
    }).claimed[0];
    expect(fixture.store.database.prepare(
      "SELECT COUNT(*) AS count FROM work_queue_fairness_cursors"
    ).get().count).toBeGreaterThan(0);

    fixture.store.complete({
      workItemId: claimed.workItem.workItemId,
      leaseId: claimed.lease.leaseId
    });

    expect(fixture.store.database.prepare(
      "SELECT COUNT(*) AS count FROM work_queue_fairness_cursors"
    ).get().count).toBe(0);
    fixture.store.close();
  });

  it("requires the current lease fence before failing running work", async () => {
    const fixture = await createFixture();
    await enqueue(fixture, "lease-fenced-fail", {}, 0);
    const claimed = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: {},
      workerId: "lease-fenced-fail-worker",
      batchSize: 1
    }).claimed[0];

    expect(() => fixture.store.fail({
      workItemId: claimed.workItem.workItemId,
      internal: true
    })).toThrow(/Lease fence rejected/u);
    expect(() => fixture.store.fail({
      workItemId: claimed.workItem.workItemId,
      leaseId: "stale-lease"
    })).toThrow(/Lease fence rejected/u);
    expect(fixture.store.inspect({ workItemId: claimed.workItem.workItemId }).workItem.state)
      .toBe("running");

    expect(fixture.store.fail({
      workItemId: claimed.workItem.workItemId,
      leaseId: claimed.lease.leaseId,
      reason: "lease_fenced_fixture"
    })).toMatchObject({ failed: true, workItem: { state: "failed" } });
    fixture.store.close();
  });

  it("persists a lease-fenced opaque checkpoint across retry and reclaim", async () => {
    const fixture = await createFixture();
    await enqueue(fixture, "checkpoint-resume", {}, 0);
    const firstClaim = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: {},
      workerId: "checkpoint-worker-first",
      batchSize: 1
    }).claimed[0];
    const checkpointRef = {
      kind: "object",
      ref: "checkpoint-object-1",
      revision: "revision-1",
      digest: `sha256:${"a".repeat(64)}`
    };

    const saved = fixture.store.checkpoint({
      workItemId: firstClaim.workItem.workItemId,
      leaseId: firstClaim.lease.leaseId,
      checkpointRef,
      expectedCheckpointSeq: 0
    });
    expect(saved).toMatchObject({
      checkpointed: true,
      idempotent: false,
      workItem: { checkpoint: { checkpointRef, checkpointSeq: 1 } }
    });
    expect(fixture.store.checkpoint({
      workItemId: firstClaim.workItem.workItemId,
      leaseId: firstClaim.lease.leaseId,
      checkpointRef,
      expectedCheckpointSeq: 0
    })).toMatchObject({ checkpointed: true, idempotent: true });
    expect(() => fixture.store.checkpoint({
      workItemId: firstClaim.workItem.workItemId,
      leaseId: firstClaim.lease.leaseId,
      checkpointRef: { kind: "object", ref: "checkpoint-object-2" },
      expectedCheckpointSeq: 0
    })).toThrow(expect.objectContaining({ code: "work_queue_checkpoint_conflict" }));
    expect(() => fixture.store.checkpoint({
      workItemId: firstClaim.workItem.workItemId,
      leaseId: firstClaim.lease.leaseId,
      checkpointRef: { kind: "file", ref: "/private/path" },
      expectedCheckpointSeq: 1
    })).toThrow(expect.objectContaining({ code: "work_queue_checkpoint_invalid" }));

    fixture.store.retry({
      workItemId: firstClaim.workItem.workItemId,
      leaseId: firstClaim.lease.leaseId,
      delayMs: 0
    });
    const resumed = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: {},
      workerId: "checkpoint-worker-resumed",
      batchSize: 1
    }).claimed[0];
    expect(resumed.workItem.checkpoint).toMatchObject({ checkpointRef, checkpointSeq: 1 });
    expect(() => fixture.store.checkpoint({
      workItemId: resumed.workItem.workItemId,
      leaseId: firstClaim.lease.leaseId,
      checkpointRef: { kind: "object", ref: "checkpoint-object-2" },
      expectedCheckpointSeq: 1
    })).toThrow(/Lease fence rejected/u);
    fixture.store.complete({
      workItemId: resumed.workItem.workItemId,
      leaseId: resumed.lease.leaseId
    });
    fixture.store.close();
  });

  it("returns from dispatcher drain at the deadline while a slow consumer remains active", async () => {
    let claimed = false;
    let release = null;
    const store = {
      claim() {
        if (claimed) return { claimed: [] };
        claimed = true;
        return {
          claimed: [{
            workItem: { workItemId: "slow-consumer", queueDefinitionId: "queue.slow" },
            lease: { leaseId: "lease-slow" }
          }]
        };
      }
    };
    const workerRuntime = {
      workerId: "slow-worker",
      async runLeased() {
        await new Promise((resolve) => { release = resolve; });
      }
    };
    const dispatcher = createQueuePushDispatcher({
      store,
      workerRuntime,
      queueDefinitionId: "queue.slow",
      maxInFlight: 1
    });
    expect((await dispatcher.dispatchOnce()).dispatched).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await dispatcher.drain({ timeoutMs: 1 })).toEqual({ drained: false, inFlight: 1 });
    release();
    expect(await dispatcher.drain({ timeoutMs: 100 })).toEqual({ drained: true, inFlight: 0 });
  });

  it("reports claim-time infrastructure terminals to the owning projection", async () => {
    const terminal = {
      workItemId: "claim-terminal",
      queueDefinitionId: "queue.terminal",
      state: "failed"
    };
    const onTerminal = vi.fn(async () => null);
    const dispatcher = createQueuePushDispatcher({
      store: {
        claim: vi.fn(async () => ({ claimed: [], failed: [terminal], expired: [] }))
      },
      workerRuntime: { runLeased: vi.fn() },
      queueDefinitionId: "queue.terminal",
      maxInFlight: 1,
      onTerminal
    });

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      dispatched: 0,
      failed: [terminal]
    });
    expect(onTerminal).toHaveBeenCalledWith({ workItem: terminal, source: "claim" });
  });

  it("does not claim after dispatch cancellation and signals already leased work", async () => {
    const preAbortedStore = { claim: vi.fn() };
    const preAborted = createQueuePushDispatcher({
      store: preAbortedStore,
      workerRuntime: { runLeased: vi.fn() },
      queueDefinitionId: "queue.cancel-aware"
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled before dispatch"));
    await expect(preAborted.dispatchOnce({ signal: controller.signal })).resolves.toMatchObject({
      dispatched: 0,
      cancelled: true,
      reason: "dispatch_signal_aborted"
    });
    expect(preAbortedStore.claim).not.toHaveBeenCalled();

    let executionSignal = null;
    const dispatcher = createQueuePushDispatcher({
      store: {
        claim: vi.fn(async () => ({
          claimed: [{
            workItem: { workItemId: "cancel-running", queueDefinitionId: "queue.cancel-aware" },
            lease: { leaseId: "cancel-running-lease" }
          }]
        })),
        inspect: vi.fn(async () => ({
          workItem: { workItemId: "cancel-running", state: "cancelled" }
        }))
      },
      workerRuntime: {
        runLeased: vi.fn(async ({ signal }) => {
          executionSignal = signal;
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return { interrupted: true };
        })
      },
      queueDefinitionId: "queue.cancel-aware"
    });
    await dispatcher.dispatchOnce();
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatcher.cancel("cancel-running")).toEqual({ signalled: true, inFlight: true });
    expect(await dispatcher.drain({ timeoutMs: 100 })).toEqual({ drained: true, inFlight: 0 });
    expect(executionSignal.aborted).toBe(true);
  });

  it("validates and bounds payload references before persistence", async () => {
    const fixture = await createFixture({
      capacity: { ...DEFAULT_QUEUE_POLICY.capacity, maxPayloadRefBytes: 24 }
    });
    const base = fixture.registry.resolveQueueDefinitionForEnqueue({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: {},
      dedupeKey: "payload-bound"
    });
    expect(() => fixture.store.enqueue({
      ...base,
      workItemId: "payload-bound",
      payloadRef: { ref: "界界界界界" }
    })).toThrow(expect.objectContaining({
      code: "work_queue_capacity_exceeded",
      reason: "payload_ref_bytes",
      limit: 24
    }));
    const circular = { ref: "circular" };
    circular.self = circular;
    expect(() => fixture.store.enqueue({
      ...base,
      workItemId: "payload-invalid",
      dedupeKey: "payload-invalid",
      payloadRef: circular
    })).toThrow(expect.objectContaining({ code: "work_queue_payload_ref_invalid" }));
    expect(fixture.store.inspect({ queueDefinitionId: fixture.definition.queueDefinitionId }).items)
      .toEqual([]);
    fixture.store.close();
  });

  it("retires the oldest failed item at the failed retention bound", async () => {
    const fixture = await createFixture({
      capacity: { ...DEFAULT_QUEUE_POLICY.capacity, maxFailed: 1 }
    });
    for (const workItemId of ["failed-oldest", "failed-current"]) {
      await enqueue(fixture, workItemId, {});
      const claimed = fixture.store.claim({
        queueDefinitionId: fixture.definition.queueDefinitionId,
        scope: {},
        workerId: `worker-${workItemId}`,
        batchSize: 1
      }).claimed[0];
      fixture.store.fail({
        workItemId: claimed.workItem.workItemId,
        leaseId: claimed.lease.leaseId,
        reason: "fixture_failure"
      });
    }
    expect(fixture.store.inspect({ workItemId: "failed-oldest", includeJournal: true }))
      .toEqual({ workItem: null, journal: [] });
    expect(fixture.store.inspect({ workItemId: "failed-current" }).workItem.state).toBe("failed");
    expect(fixture.store.rebuildProjection()).toMatchObject({ ok: true, errors: [], drift: [] });
    fixture.store.close();
  });

  it("rejects a dedupe key rebound to a different immutable request", async () => {
    const fixture = await createFixture();
    const request = fixture.registry.resolveQueueDefinitionForEnqueue({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: { tenantId: "tenant-a" },
      dedupeKey: "immutable-request"
    });
    fixture.store.enqueue({
      ...request,
      workItemId: "immutable-original",
      payloadRef: { kind: "reference", objectId: "object-a" },
      ownerRef: { capability: "queue-scheduling-test" }
    });
    expect(fixture.store.enqueue({
      ...request,
      workItemId: "immutable-replay",
      payloadRef: { objectId: "object-a", kind: "reference" },
      ownerRef: { capability: "queue-scheduling-test" }
    })).toMatchObject({ accepted: false, deduped: true });
    expect(() => fixture.store.enqueue({
      ...request,
      workItemId: "immutable-conflict",
      payloadRef: { kind: "reference", objectId: "object-b" },
      ownerRef: { capability: "queue-scheduling-test" }
    })).toThrow(expect.objectContaining({ code: "work_queue_dedupe_conflict" }));
    expect(() => fixture.store.enqueue({
      ...request,
      workItemId: "immutable-hierarchy-conflict",
      schedulingScope: { tenantId: "different-tenant" },
      payloadRef: { kind: "reference", objectId: "object-a" },
      ownerRef: { capability: "queue-scheduling-test" }
    })).toThrow(expect.objectContaining({ code: "work_queue_dedupe_conflict" }));
    fixture.store.close();
  });

  it("bounds terminal projections and transition journals without breaking replay", async () => {
    const fixture = await createFixture({
      retention: {
        ...DEFAULT_QUEUE_POLICY.retention,
        maxTerminalItems: 1,
        maxJournalEntries: 2,
        maxTransitionsPerWorkItem: 2,
        cleanupBatchSize: 2
      }
    });
    for (const workItemId of ["terminal-oldest", "terminal-current"]) {
      await enqueue(fixture, workItemId, {});
      const claimed = fixture.store.claim({
        queueDefinitionId: fixture.definition.queueDefinitionId,
        scope: {},
        workerId: `worker-${workItemId}`,
        batchSize: 1
      }).claimed[0];
      fixture.store.progress({
        workItemId: claimed.workItem.workItemId,
        leaseId: claimed.lease.leaseId,
        reason: "fixture_progress"
      });
      fixture.store.complete({
        workItemId: claimed.workItem.workItemId,
        leaseId: claimed.lease.leaseId,
        reason: "fixture_complete"
      });
    }
    expect(fixture.store.inspect({ workItemId: "terminal-oldest" }).workItem).toBeNull();
    const retained = fixture.store.inspect({ workItemId: "terminal-current", includeJournal: true });
    expect(retained.workItem.state).toBe("completed");
    expect(retained.journal.length).toBeLessThanOrEqual(2);
    expect(retained.journal[0].transition).toBe("retention_snapshot");
    expect(fixture.store.rebuildProjection()).toMatchObject({ ok: true, errors: [], drift: [] });
    fixture.store.close();
  });

  it("detects a journal row missing from the projection and repairs it on apply", async () => {
    const fixture = await createFixture();
    await enqueue(fixture, "projection-repair", {});
    fixture.store.database.prepare("DELETE FROM work_items WHERE work_item_id = ?")
      .run("projection-repair");
    expect(fixture.store.rebuildProjection()).toMatchObject({
      ok: false,
      applied: false,
      drift: [{ workItemId: "projection-repair", reason: "missing_from_projection" }]
    });
    expect(fixture.store.rebuildProjection({ dryRun: false })).toMatchObject({
      ok: true,
      applied: true,
      drift: [],
      repairedDrift: [{ workItemId: "projection-repair", reason: "missing_from_projection" }]
    });
    expect(fixture.store.inspect({ workItemId: "projection-repair" }).workItem.state).toBe("queued");
    fixture.store.close();
  });

  it("rotates deterministically across tenant workspace project partitions", async () => {
    const fixture = await createFixture();
    const boundary = { tenantId: "platform", workspaceId: "fairness" };
    for (const work of [
      ["a-1", "tenant-a", "workspace-a", "project-a"],
      ["a-2", "tenant-a", "workspace-a", "project-b"],
      ["a-3", "tenant-a", "workspace-b", "project-c"],
      ["b-1", "tenant-b", "workspace-c", "project-d"],
      ["b-2", "tenant-b", "workspace-c", "project-e"],
      ["b-3", "tenant-b", "workspace-d", "project-f"]
    ]) {
      const resolved = fixture.registry.resolveQueueDefinitionForEnqueue({
        queueDefinitionId: fixture.definition.queueDefinitionId,
        scope: boundary,
        dedupeKey: work[0]
      });
      fixture.store.enqueue({
        ...resolved,
        workItemId: work[0],
        schedulingScope: {
          tenantId: work[1],
          workspaceId: work[2],
          projectId: work[3]
        },
        payloadRef: { kind: "scheduling-test", workItemId: work[0] },
        ownerRef: { capability: "queue-scheduling-test" }
      });
    }
    const claimed = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: boundary,
      schedulingScope: {},
      workerId: "fair-worker",
      batchSize: 6
    }).claimed;
    expect(claimed).toHaveLength(6);
    expect(claimed.map((item) => item.workItem.schedulingScope.tenantId)).toEqual([
      "tenant-a",
      "tenant-b",
      "tenant-a",
      "tenant-b",
      "tenant-a",
      "tenant-b"
    ]);
    fixture.store.close();
  });

  it("applies weighted service across the finite priority classes", async () => {
    const fixture = await createFixture();
    const boundary = { tenantId: "platform", workspaceId: "weighted" };
    const schedulingScope = { tenantId: "tenant-a", workspaceId: "workspace-a", projectId: "project-a" };
    for (const [priority, count, prefix] of [
      [2, 8, "critical"],
      [1, 4, "high"],
      [0, 2, "normal"],
      [-1, 1, "low"]
    ]) {
      for (let index = 0; index < count; index += 1) {
        const workItemId = `${prefix}-${index}`;
        fixture.store.enqueue({
          ...fixture.registry.resolveQueueDefinitionForEnqueue({
            queueDefinitionId: fixture.definition.queueDefinitionId,
            scope: boundary,
            dedupeKey: workItemId
          }),
          workItemId,
          schedulingScope,
          payloadRef: { kind: "scheduling-test", workItemId },
          ownerRef: { capability: "queue-scheduling-test" },
          priority
        });
      }
    }
    const claimed = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope: boundary,
      schedulingScope: {},
      workerId: "weighted-worker",
      batchSize: 15
    }).claimed;
    const counts = claimed.reduce((result, item) => {
      result[item.workItem.priorityClass] = (result[item.workItem.priorityClass] || 0) + 1;
      return result;
    }, {});
    expect(counts).toEqual(WORK_QUEUE_PRIORITY_WEIGHTS);
    fixture.store.close();
  });
});
