#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  createFixedQueueTimeSource,
  createQueueDefinitionRegistry,
  createQueuePushDispatcher,
  createQueueWorkerRuntime,
  createSqliteWorkQueueStore,
  DEFAULT_QUEUE_POLICY,
  WORK_QUEUE_HANDLER_MAX_DURATION_MS
} from "../../packages/foundation/src/work-queue/index.mjs";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH = path.join(process.cwd(), "build/reports/job-work-queue-capacity.json");
const VERIFIER = "tools/server-scripts/verify-job-work-queue-capacity.mjs";
const COMMAND_ID = "job-work-queue-capacity";
const SCHEMA_VERSION = "v0.0.1:workflow:job-work-queue-capacity-report-1";
const SOURCE_FILES = Object.freeze([
  "packages/foundation/src/work-queue/policies.mjs",
  "packages/foundation/src/work-queue/push-dispatcher.mjs",
  "packages/foundation/src/work-queue/sqlite-store.mjs",
  "packages/foundation/src/work-queue/sqlite-store-runtime.mjs",
  "packages/foundation/src/work-queue/worker-runtime.mjs",
  VERIFIER
]);

const FIXTURE_CEILINGS = Object.freeze({
  outstanding: 2,
  payloadRefBytes: Buffer.byteLength(JSON.stringify({ ref: "界界" }), "utf8"),
  delayed: 2,
  inFlight: 2,
  failedRetained: 2,
  terminalRetained: 2,
  journalEntries: 8,
  transitionsPerWorkItem: 3,
  cleanupBatchSize: 2
});
const EXERCISED_HANDLER_DURATION_MS = 10;
const VERIFIER_BUDGETS = Object.freeze({
  durationMs: 15_000,
  cpuMs: 5_000,
  rssBytes: 1024 * 1024 * 1024,
  rssIncreaseBytes: 128 * 1024 * 1024
});

const roots = [];
let fixtureCounter = 0;
let peakRssBytes = process.memoryUsage().rss;
let verifierStage = "startup";

function sampleRss() {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  return peakRssBytes;
}

function baseCapacity(overrides = {}) {
  return {
    ...DEFAULT_QUEUE_POLICY.capacity,
    maxPayloadRefBytes: 512,
    maxOutstanding: 32,
    maxOutstandingPerTenant: 32,
    maxOutstandingPerWorkspace: 32,
    maxOutstandingPerProject: 32,
    maxDelayed: 32,
    maxLeased: 32,
    maxLeasedPerTenant: 32,
    maxLeasedPerWorkspace: 32,
    maxLeasedPerProject: 32,
    maxFailed: 32,
    ...overrides
  };
}

async function createFixture({ capacity = {}, retention = {}, label = "capacity" } = {}) {
  fixtureCounter += 1;
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-work-queue-capacity-"));
  roots.push(userDataPath);
  const queueDefinitionId = `queue.capacity.${label}.${fixtureCounter}`;
  const registry = createQueueDefinitionRegistry();
  const definition = registry.registerQueueDefinition({
    queueDefinitionId,
    label: queueDefinitionId,
    ownerCapability: "queue-capacity-verifier",
    policy: {
      capacity: baseCapacity(capacity),
      retention: {
        ...DEFAULT_QUEUE_POLICY.retention,
        ...retention
      }
    }
  });
  const store = createSqliteWorkQueueStore({
    userDataPath,
    timeSource: createFixedQueueTimeSource(10_000)
  });
  store.registerQueueDefinition(definition);
  sampleRss();
  return { definition, registry, store };
}

function enqueue(fixture, { key, scope = {}, payloadRef = null, delayMs = 0 } = {}) {
  return fixture.store.enqueue({
    ...fixture.registry.resolveQueueDefinitionForEnqueue({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      scope,
      dedupeKey: key
    }),
    workItemId: key,
    payloadRef: payloadRef || { kind: "capacity-reference", ref: key },
    ownerRef: { capability: "queue-capacity-verifier" },
    delayMs
  });
}

function inspectCount(fixture) {
  const inspected = fixture.store.inspect({
    queueDefinitionId: fixture.definition.queueDefinitionId,
    limit: 100
  });
  return inspected.stateCounts.reduce((total, entry) => total + Number(entry.count || 0), 0);
}

async function expectCapacityCutoff(operation, reason, limit) {
  let error = null;
  try {
    await operation();
  } catch (candidate) {
    error = candidate;
  }
  assert.ok(error, `expected capacity cutoff ${reason}`);
  assert.equal(error.code, "work_queue_capacity_exceeded");
  assert.equal(error.reason, reason);
  assert.equal(error.limit, limit);
  return { code: error.code, reason: error.reason, limit: error.limit };
}

async function verifyOutstandingBoundary({ dimension, capacity, scopes }) {
  const fixture = await createFixture({ capacity, label: dimension });
  try {
    for (let index = 0; index < FIXTURE_CEILINGS.outstanding; index += 1) {
      enqueue(fixture, { key: `${dimension}-${index}`, scope: scopes[index] });
    }
    const before = inspectCount(fixture);
    const first = await expectCapacityCutoff(
      () => enqueue(fixture, { key: `${dimension}-rejected-1`, scope: scopes.at(-1) }),
      `${dimension}_outstanding`,
      FIXTURE_CEILINGS.outstanding
    );
    const second = await expectCapacityCutoff(
      () => enqueue(fixture, { key: `${dimension}-rejected-2`, scope: scopes.at(-1) }),
      `${dimension}_outstanding`,
      FIXTURE_CEILINGS.outstanding
    );
    const after = inspectCount(fixture);
    assert.equal(before, FIXTURE_CEILINGS.outstanding);
    assert.equal(after, before);
    assert.deepEqual(second, first);
    return { peak: before, rejectedAttempts: 2, partialWrites: after - before, cutoff: first };
  } finally {
    fixture.store.close();
  }
}

async function verifyPayloadBoundary() {
  const exactPayload = { ref: "界界" };
  const oversizedPayload = { ref: "界界界" };
  const exactBytes = Buffer.byteLength(JSON.stringify(exactPayload), "utf8");
  const oversizedBytes = Buffer.byteLength(JSON.stringify(oversizedPayload), "utf8");
  assert.equal(exactBytes, FIXTURE_CEILINGS.payloadRefBytes);
  const fixture = await createFixture({
    capacity: { maxPayloadRefBytes: exactBytes },
    label: "payload"
  });
  try {
    enqueue(fixture, { key: "payload-exact", payloadRef: exactPayload });
    const before = inspectCount(fixture);
    const cutoff = await expectCapacityCutoff(
      () => enqueue(fixture, { key: "payload-rejected", payloadRef: oversizedPayload }),
      "payload_ref_bytes",
      exactBytes
    );
    const after = inspectCount(fixture);
    assert.equal(after, before);
    return {
      acceptedBytes: exactBytes,
      rejectedBytes: oversizedBytes,
      partialWrites: after - before,
      cutoff
    };
  } finally {
    fixture.store.close();
  }
}

async function verifyDelayedBoundary() {
  const fixture = await createFixture({
    capacity: { maxDelayed: FIXTURE_CEILINGS.delayed },
    label: "delayed"
  });
  try {
    for (let index = 0; index < FIXTURE_CEILINGS.delayed; index += 1) {
      enqueue(fixture, { key: `delayed-${index}`, delayMs: 1_000 });
    }
    const before = inspectCount(fixture);
    const cutoff = await expectCapacityCutoff(
      () => enqueue(fixture, { key: "delayed-rejected", delayMs: 1_000 }),
      "queue_delayed",
      FIXTURE_CEILINGS.delayed
    );
    const after = inspectCount(fixture);
    assert.equal(after, before);
    return { peak: before, partialWrites: after - before, cutoff };
  } finally {
    fixture.store.close();
  }
}

async function verifySlowConsumerBoundary() {
  const fixture = await createFixture({
    capacity: {
      maxLeased: FIXTURE_CEILINGS.inFlight,
      maxLeasedPerTenant: FIXTURE_CEILINGS.inFlight,
      maxLeasedPerWorkspace: FIXTURE_CEILINGS.inFlight,
      maxLeasedPerProject: FIXTURE_CEILINGS.inFlight
    },
    label: "slow-consumer"
  });
  const releases = [];
  const workerRuntime = createQueueWorkerRuntime({
    store: fixture.store,
    workerId: "capacity-worker",
    handlers: {
      "*": async () => {
        await new Promise((resolve) => releases.push(resolve));
        return { action: "completed", reason: "capacity_slow_consumer_released" };
      }
    }
  });
  const dispatcher = createQueuePushDispatcher({
    store: fixture.store,
    workerRuntime,
    queueDefinitionId: fixture.definition.queueDefinitionId,
    workerId: "capacity-dispatcher",
    maxInFlight: FIXTURE_CEILINGS.inFlight
  });
  try {
    for (let index = 0; index < 3; index += 1) {
      enqueue(fixture, { key: `slow-${index}` });
    }
    const first = await dispatcher.dispatchOnce({ batchSize: 3 });
    assert.equal(first.dispatched, FIXTURE_CEILINGS.inFlight);
    assert.equal(dispatcher.status().inFlight, FIXTURE_CEILINGS.inFlight);
    const saturated = await dispatcher.dispatchOnce({ batchSize: 1 });
    assert.equal(saturated.dispatched, 0);
    assert.equal(saturated.backpressure.localSaturated, true);
    const timedOutDrain = await dispatcher.drain({ timeoutMs: 1 });
    assert.deepEqual(timedOutDrain, { drained: false, inFlight: FIXTURE_CEILINGS.inFlight });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, FIXTURE_CEILINGS.inFlight);
    releases.splice(0).forEach((release) => release());
    assert.equal((await dispatcher.drain({ timeoutMs: 2_000 })).drained, true);
    const last = await dispatcher.dispatchOnce({ batchSize: 1 });
    assert.equal(last.dispatched, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 1);
    releases.splice(0).forEach((release) => release());
    assert.equal((await dispatcher.drain({ timeoutMs: 2_000 })).drained, true);
    return {
      peak: FIXTURE_CEILINGS.inFlight,
      saturationReason: "local_backpressure",
      rejectedDispatchCount: 1,
      drainTimeoutObserved: true,
      finalInFlight: dispatcher.status().inFlight
    };
  } finally {
    releases.splice(0).forEach((release) => release());
    await dispatcher.drain({ timeoutMs: 2_000 });
    fixture.store.close();
  }
}

async function verifyCancellation() {
  const fixture = await createFixture({ label: "cancellation" });
  try {
    enqueue(fixture, { key: "cancel-queued" });
    const queuedCancellation = fixture.store.cancel({
      workItemId: "cancel-queued",
      reason: "capacity_verifier_cancelled"
    });
    assert.equal(queuedCancellation.cancelled, true);

    enqueue(fixture, { key: "cancel-running" });
    const claimed = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      workerId: "cancel-worker",
      batchSize: 1
    }).claimed[0];
    const controller = new AbortController();
    let signalObserved = false;
    const workerRuntime = createQueueWorkerRuntime({ store: fixture.store, workerId: "cancel-worker" });
    const execution = workerRuntime.runLeased({
      workItem: claimed.workItem,
      lease: claimed.lease,
      signal: controller.signal,
      handler: async (_input, context) => {
        await new Promise(() => {
          context.signal.addEventListener("abort", () => {
            signalObserved = true;
          }, { once: true });
        });
      }
    });
    const abortReason = new Error("Queue worker execution was cancelled by the capacity verifier.");
    abortReason.code = "queue_worker_aborted";
    controller.abort(abortReason);
    const interrupted = await execution;
    assert.equal(interrupted.interrupted, true);
    assert.equal(signalObserved, true);
    const runningCancellation = fixture.store.cancel({
      workItemId: claimed.workItem.workItemId,
      reason: "capacity_verifier_signal_cancelled"
    });
    assert.equal(runningCancellation.cancelled, true);
    let lateCompletionAccepted = true;
    try {
      fixture.store.complete({
        workItemId: claimed.workItem.workItemId,
        leaseId: claimed.lease.leaseId,
        reason: "capacity_verifier_late_completion"
      });
    } catch {
      lateCompletionAccepted = false;
    }
    assert.equal(lateCompletionAccepted, false);
    const states = fixture.store.inspect({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      limit: 10
    }).stateCounts;
    assert.equal(states.find((entry) => entry.state === "cancelled")?.count, 2);
    return {
      queuedCancellation: "cancelled",
      runningCancellation: "cancelled",
      externalSignalObserved: signalObserved,
      lateCompletionAccepted
    };
  } finally {
    fixture.store.close();
  }
}

async function verifyHandlerDuration() {
  const fixture = await createFixture({ label: "handler-duration" });
  try {
    enqueue(fixture, { key: "handler-timeout" });
    const claimed = fixture.store.claim({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      workerId: "handler-timeout-worker",
      batchSize: 1
    }).claimed[0];
    const workerRuntime = createQueueWorkerRuntime({
      store: fixture.store,
      workerId: "handler-timeout-worker",
      maxHandlerDurationMs: EXERCISED_HANDLER_DURATION_MS
    });
    const interrupted = await workerRuntime.runLeased({
      workItem: claimed.workItem,
      lease: claimed.lease,
      handler: async () => new Promise(() => {})
    });
    assert.equal(interrupted.interrupted, true);
    assert.equal(interrupted.error?.code, "queue_handler_timeout");
    const cancelled = fixture.store.cancel({
      workItemId: claimed.workItem.workItemId,
      reason: "capacity_verifier_timeout_cleanup"
    });
    assert.equal(cancelled.cancelled, true);
    return {
      limitMs: EXERCISED_HANDLER_DURATION_MS,
      cutoffCode: interrupted.error.code,
      terminalState: "cancelled"
    };
  } finally {
    fixture.store.close();
  }
}

async function verifyFailedRetention() {
  const fixture = await createFixture({
    capacity: { maxFailed: FIXTURE_CEILINGS.failedRetained },
    retention: { cleanupBatchSize: FIXTURE_CEILINGS.cleanupBatchSize },
    label: "failed-retention"
  });
  try {
    for (let index = 0; index < 3; index += 1) {
      const key = `failed-${index}`;
      enqueue(fixture, { key });
      const claimed = fixture.store.claim({
        queueDefinitionId: fixture.definition.queueDefinitionId,
        workerId: `failed-worker-${index}`,
        batchSize: 1
      }).claimed[0];
      fixture.store.fail({
        workItemId: claimed.workItem.workItemId,
        leaseId: claimed.lease.leaseId,
        reason: "capacity_verifier_failure"
      });
    }
    const inspected = fixture.store.inspect({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      limit: 10
    });
    const retained = Number(inspected.stateCounts.find((entry) => entry.state === "failed")?.count || 0);
    assert.equal(retained, FIXTURE_CEILINGS.failedRetained);
    assert.equal(fixture.store.inspect({ workItemId: "failed-0" }).workItem, null);
    assert.equal(fixture.store.rebuildProjection().ok, true);
    return { peak: FIXTURE_CEILINGS.failedRetained, retained, retiredOldest: 1 };
  } finally {
    fixture.store.close();
  }
}

async function verifyJournalRetention() {
  const fixture = await createFixture({
    retention: {
      maxTerminalItems: FIXTURE_CEILINGS.terminalRetained,
      maxJournalEntries: FIXTURE_CEILINGS.journalEntries,
      maxTransitionsPerWorkItem: FIXTURE_CEILINGS.transitionsPerWorkItem,
      cleanupBatchSize: FIXTURE_CEILINGS.cleanupBatchSize
    },
    label: "journal-retention"
  });
  try {
    let peakJournalEntries = 0;
    let peakTransitionsPerWorkItem = 0;
    const sampleRetention = () => {
      const current = fixture.store.inspect({
        queueDefinitionId: fixture.definition.queueDefinitionId,
        limit: 10
      });
      let total = 0;
      for (const item of current.items) {
        const count = fixture.store.inspect({ workItemId: item.workItemId, includeJournal: true }).journal.length;
        total += count;
        peakTransitionsPerWorkItem = Math.max(peakTransitionsPerWorkItem, count);
      }
      peakJournalEntries = Math.max(peakJournalEntries, total);
    };
    for (let index = 0; index < 4; index += 1) {
      const key = `journal-${index}`;
      enqueue(fixture, { key });
      sampleRetention();
      const claimed = fixture.store.claim({
        queueDefinitionId: fixture.definition.queueDefinitionId,
        workerId: `journal-worker-${index}`,
        batchSize: 1
      }).claimed[0];
      sampleRetention();
      fixture.store.progress({
        workItemId: claimed.workItem.workItemId,
        leaseId: claimed.lease.leaseId,
        reason: "capacity_verifier_progress"
      });
      sampleRetention();
      fixture.store.complete({
        workItemId: claimed.workItem.workItemId,
        leaseId: claimed.lease.leaseId,
        reason: "capacity_verifier_complete"
      });
      sampleRetention();
    }
    const retained = fixture.store.inspect({
      queueDefinitionId: fixture.definition.queueDefinitionId,
      limit: 10
    });
    assert.ok(retained.items.length <= FIXTURE_CEILINGS.terminalRetained);
    let journalEntries = 0;
    let peakPerItem = 0;
    for (const item of retained.items) {
      const journal = fixture.store.inspect({ workItemId: item.workItemId, includeJournal: true }).journal;
      journalEntries += journal.length;
      peakPerItem = Math.max(peakPerItem, journal.length);
    }
    assert.ok(journalEntries <= FIXTURE_CEILINGS.journalEntries);
    assert.ok(peakPerItem <= FIXTURE_CEILINGS.transitionsPerWorkItem);
    assert.ok(peakJournalEntries <= FIXTURE_CEILINGS.journalEntries);
    assert.ok(peakTransitionsPerWorkItem <= FIXTURE_CEILINGS.transitionsPerWorkItem);
    assert.equal(fixture.store.rebuildProjection().ok, true);
    return {
      terminalRetained: retained.items.length,
      retainedJournalEntries: journalEntries,
      retainedTransitionsPerWorkItem: peakPerItem,
      peakJournalEntries,
      peakTransitionsPerWorkItem,
      replayPassed: true
    };
  } finally {
    fixture.store.close();
  }
}

async function removeRoots() {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
}

async function writeReport(report) {
  const provenance = {
    producer: "licomesh-core-job-work-queue-capacity",
    commandId: COMMAND_ID,
    sourceRevision: await computeVerifierSourceRevision(REPO_ROOT, SOURCE_FILES)
  };
  const finalized = finalizeSensitiveReport(report, { provenance });
  assertNoSensitiveReportLeak(finalized, "job work queue capacity report");
  assertReportProvenance(finalized, provenance);
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
}

async function main() {
  const startedAt = new Date();
  const startedPerformance = performance.now();
  const startedCpu = process.cpuUsage();
  const startedRssBytes = process.memoryUsage().rss;

  verifierStage = "outstanding";
  const outstanding = {
    queue: await verifyOutstandingBoundary({
      dimension: "queue",
      capacity: { maxOutstanding: FIXTURE_CEILINGS.outstanding },
      scopes: [
        { tenantId: "tenant-a", workspaceId: "workspace-a", projectId: "project-a" },
        { tenantId: "tenant-b", workspaceId: "workspace-b", projectId: "project-b" },
        { tenantId: "tenant-c", workspaceId: "workspace-c", projectId: "project-c" }
      ]
    }),
    tenant: await verifyOutstandingBoundary({
      dimension: "tenant",
      capacity: { maxOutstandingPerTenant: FIXTURE_CEILINGS.outstanding },
      scopes: [
        { tenantId: "tenant-a", workspaceId: "workspace-a", projectId: "project-a" },
        { tenantId: "tenant-a", workspaceId: "workspace-b", projectId: "project-b" },
        { tenantId: "tenant-a", workspaceId: "workspace-c", projectId: "project-c" }
      ]
    }),
    workspace: await verifyOutstandingBoundary({
      dimension: "workspace",
      capacity: { maxOutstandingPerWorkspace: FIXTURE_CEILINGS.outstanding },
      scopes: [
        { tenantId: "tenant-a", workspaceId: "workspace-a", projectId: "project-a" },
        { tenantId: "tenant-a", workspaceId: "workspace-a", projectId: "project-b" },
        { tenantId: "tenant-a", workspaceId: "workspace-a", projectId: "project-c" }
      ]
    }),
    project: await verifyOutstandingBoundary({
      dimension: "project",
      capacity: { maxOutstandingPerProject: FIXTURE_CEILINGS.outstanding },
      scopes: Array.from({ length: 3 }, () => ({
        tenantId: "tenant-a",
        workspaceId: "workspace-a",
        projectId: "project-a"
      }))
    })
  };
  verifierStage = "payload";
  const payload = await verifyPayloadBoundary();
  verifierStage = "delayed";
  const delayed = await verifyDelayedBoundary();
  verifierStage = "slow-consumer";
  const slowConsumer = await verifySlowConsumerBoundary();
  verifierStage = "cancellation";
  const cancellation = await verifyCancellation();
  verifierStage = "handler-duration";
  const handlerDuration = await verifyHandlerDuration();
  verifierStage = "failed-retention";
  const failedRetention = await verifyFailedRetention();
  verifierStage = "journal-retention";
  const journalRetention = await verifyJournalRetention();
  sampleRss();

  const durationMs = Math.ceil(performance.now() - startedPerformance);
  const cpuUsage = process.cpuUsage(startedCpu);
  const cpuMs = Math.ceil((cpuUsage.user + cpuUsage.system) / 1000);
  const rssIncreaseBytes = Math.max(0, peakRssBytes - startedRssBytes);
  verifierStage = "resource-budgets";
  assert.ok(durationMs <= VERIFIER_BUDGETS.durationMs, "capacity verifier duration budget exceeded");
  assert.ok(cpuMs <= VERIFIER_BUDGETS.cpuMs, "capacity verifier CPU budget exceeded");
  assert.ok(peakRssBytes <= VERIFIER_BUDGETS.rssBytes, "capacity verifier RSS budget exceeded");
  assert.ok(rssIncreaseBytes <= VERIFIER_BUDGETS.rssIncreaseBytes, "capacity verifier RSS increase budget exceeded");

  const finishedAt = new Date();
  await writeReport({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: finishedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    verifier: VERIFIER,
    ok: true,
    selectedAdapter: "sqlite",
    summary: {
      verificationPassed: true,
      deterministicCutoffs: true,
      zeroPartialAdmissions: true,
      slowConsumerBounded: true,
      cancellationObserved: true,
      handlerDurationRuntimeEnforced: true,
      verifierBudgetsPassed: true
    },
    declaredCeilings: {
      runtimeDefaults: {
        maxPayloadRefBytes: DEFAULT_QUEUE_POLICY.capacity.maxPayloadRefBytes,
        maxOutstanding: DEFAULT_QUEUE_POLICY.capacity.maxOutstanding,
        maxOutstandingPerTenant: DEFAULT_QUEUE_POLICY.capacity.maxOutstandingPerTenant,
        maxOutstandingPerWorkspace: DEFAULT_QUEUE_POLICY.capacity.maxOutstandingPerWorkspace,
        maxOutstandingPerProject: DEFAULT_QUEUE_POLICY.capacity.maxOutstandingPerProject,
        maxDelayed: DEFAULT_QUEUE_POLICY.capacity.maxDelayed,
        maxLeased: DEFAULT_QUEUE_POLICY.capacity.maxLeased,
        maxFailed: DEFAULT_QUEUE_POLICY.capacity.maxFailed,
        maxTerminalItems: DEFAULT_QUEUE_POLICY.retention.maxTerminalItems,
        maxJournalEntries: DEFAULT_QUEUE_POLICY.retention.maxJournalEntries,
        maxTransitionsPerWorkItem: DEFAULT_QUEUE_POLICY.retention.maxTransitionsPerWorkItem
      },
      exercisedDefinitionOverrides: FIXTURE_CEILINGS,
      workerHandlerDurationMs: WORK_QUEUE_HANDLER_MAX_DURATION_MS,
      exercisedWorkerHandlerDurationMs: EXERCISED_HANDLER_DURATION_MS,
      verifierBudgets: VERIFIER_BUDGETS
    },
    measuredPeaks: {
      queueOutstanding: outstanding.queue.peak,
      tenantOutstanding: outstanding.tenant.peak,
      workspaceOutstanding: outstanding.workspace.peak,
      projectOutstanding: outstanding.project.peak,
      payloadRefBytes: payload.acceptedBytes,
      delayed: delayed.peak,
      inFlight: slowConsumer.peak,
      failedRetained: failedRetention.retained,
      terminalRetained: journalRetention.terminalRetained,
      journalEntries: journalRetention.peakJournalEntries,
      transitionsPerWorkItem: journalRetention.peakTransitionsPerWorkItem,
      durationMs,
      cpuMs,
      rssBytes: peakRssBytes,
      rssIncreaseBytes
    },
    cutoffs: {
      queueOutstanding: outstanding.queue.cutoff,
      tenantOutstanding: outstanding.tenant.cutoff,
      workspaceOutstanding: outstanding.workspace.cutoff,
      projectOutstanding: outstanding.project.cutoff,
      payloadRefBytes: payload.cutoff,
      delayed: delayed.cutoff,
      slowConsumer: {
        code: "local_backpressure",
        reason: slowConsumer.saturationReason,
        limit: FIXTURE_CEILINGS.inFlight
      },
      drainTimeout: {
        code: "dispatcher_drain_timeout",
        reason: "in_flight_not_drained",
        limitMs: 1
      },
      handlerDuration: {
        code: handlerDuration.cutoffCode,
        reason: "handler_duration_exceeded",
        limitMs: handlerDuration.limitMs
      }
    },
    mutationSafety: {
      rejectedAdmissionAttempts: Object.values(outstanding)
        .reduce((total, result) => total + result.rejectedAttempts, 0) + 2,
      partialWrites: Object.values(outstanding)
        .reduce((total, result) => total + result.partialWrites, 0) +
        payload.partialWrites + delayed.partialWrites
    },
    cancellation,
    handlerDuration,
    slowConsumer,
    retention: {
      failed: failedRetention,
      journal: journalRetention
    },
    runtimeEnforcement: {
      queueCapacity: "enforced",
      dispatcherCredit: "enforced",
      dispatcherDrainTimeout: "enforced",
      queuedAndRunningCancellation: "enforced",
      workerHandlerDuration: "enforced"
    }
  });

  process.stdout.write(`${JSON.stringify({ ok: true, report: "build/reports/job-work-queue-capacity.json" })}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`job work queue capacity verification failed: ${error?.code || "verification_failed"}; stage=${verifierStage}\n`);
    process.exitCode = 1;
  })
  .finally(removeRoots);
