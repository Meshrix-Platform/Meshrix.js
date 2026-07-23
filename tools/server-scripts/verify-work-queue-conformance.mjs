import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertQueueDefinitionCanEnqueue,
  createQueueBackgroundWriteAspect,
  createQueueDefinitionRegistry,
  createQueueFallbackCoordinator,
  createQueuePushDispatcher,
  createQueueWorkerRuntime,
  createSqliteWorkQueueStore,
  computeDeterministicBackoff,
  createFixedQueueTimeSource,
  createManualQueueTimeSource,
  createQueueIdentityGenerator,
  normalizeQueueDedupeKey,
  normalizeStructuredQueueScope,
  QUEUE_DEFINITION_STATES,
  runWorkQueueConformanceSuite,
  WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT
} from "../../packages/foundation/src/work-queue/index.mjs";
import {
  verifyWorkQueueStateMachine,
  WORK_QUEUE_STATES
} from "../../packages/foundation/src/workflow/state-machine/work-queue/state-machine.mjs";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeSensitiveReport
} from "./lib/sensitive-report-scan.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH = path.join(process.cwd(), "build/reports/work-queue/latest.json");
const VERIFIER = "tools/server-scripts/verify-work-queue-conformance.mjs";
const COMMAND_ID = "work-queue-conformance";
const SOURCE_FILES = Object.freeze([
  "packages/foundation/src/work-queue/index.mjs",
  "packages/foundation/src/work-queue/sqlite-store.mjs",
  "packages/foundation/src/work-queue/sqlite-schema.mjs",
  "packages/foundation/src/workflow/state-machine/work-queue/state-machine.mjs",
  VERIFIER
]);
const SENSITIVE_REPORT_PATTERNS = Object.freeze([
  ["local_path", /\/Users\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\/u],
  ["bearer_token", /Bearer\s+(?!\[redacted\]|<redacted-secret>)\S+/u],
  ["secret_token", /\bsk-[A-Za-z0-9._-]{8,}\b|upstream-secret-value/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op|relay_session|relay_turn|delegated_mcp)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u],
  ["raw_payload", /raw prompt body|private file content/u]
]);

function assertNoLeak(value, label) {
  const text = JSON.stringify(value);
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`${label} contains sensitive local or runtime data: ${kind}`);
    }
  }
}

function sanitizeDetails(details = {}) {
  return Object.fromEntries(
    Object.entries(details || {}).filter(([key]) => !/id$/iu.test(key))
  );
}

function summarizeChecks(checks = []) {
  return checks.map((check) => ({
    id: check.id,
    status: check.ok === true ? "passed" : "failed",
    details: sanitizeDetails(check.details || {}),
    error: check.ok === true ? "" : String(check.error || "failed")
  }));
}

async function writeReport(report) {
  const provenance = {
    producer: "licomesh-core-work-queue",
    commandId: COMMAND_ID,
    sourceRevision: await computeVerifierSourceRevision(REPO_ROOT, SOURCE_FILES)
  };
  const finalizedReport = finalizeSensitiveReport(report, { provenance });
  assertNoLeak(finalizedReport, "work queue conformance report");
  assertNoSensitiveReportLeak(finalizedReport, "work queue conformance report");
  assertReportProvenance(finalizedReport, provenance);
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(finalizedReport, null, 2)}\n`, "utf8");
}

function createPrng(seed = 1) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

async function withTempQueueStore(testFn) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-work-queue-"));
  const timeSource = createManualQueueTimeSource(10_000);
  const store = createSqliteWorkQueueStore({
    userDataPath,
    timeSource,
    policy: {
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
  try {
    await testFn({ store, timeSource, userDataPath });
  } finally {
    store.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

function createTestQueueDefinition({ label = "sqlite.jobs" } = {}) {
  const registry = createQueueDefinitionRegistry();
  const definition = registry.registerQueueDefinition({
    label,
    ownerCapability: "work-queue-conformance",
    lifecycleState: QUEUE_DEFINITION_STATES.ACTIVE
  });
  return { registry, definition };
}

const startedAt = new Date();
const concreteSuiteReports = [];
const baseSuiteReport = runWorkQueueConformanceSuite();
assert.equal(baseSuiteReport.ok, true, JSON.stringify(baseSuiteReport.checks, null, 2));

const stateMachine = verifyWorkQueueStateMachine();
assert.equal(stateMachine.ok, true);
assert.ok(stateMachine.machine.states.includes(WORK_QUEUE_STATES.RECOVERED));
assert.ok(stateMachine.machine.safeInterventionStates.includes(WORK_QUEUE_STATES.RECOVERED));

const fixedTime = createFixedQueueTimeSource(1_718_400_000_000);
const ids = createQueueIdentityGenerator({
  timeSource: fixedTime,
  randomBytesFn: (length) => Buffer.alloc(length, 0x44)
});
const workItemId = ids.workItemId();
assert.match(workItemId, /^wqwi_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

const manualTime = createManualQueueTimeSource(100);
assert.equal(manualTime.nowMs(), 100);
manualTime.advance(50);
assert.equal(manualTime.nowMs(), 150);

assert.deepEqual(
  normalizeStructuredQueueScope({
    tenantId: " tenant-a ",
    workspaceId: "workspace-a",
    unknown: "ignored"
  }),
  {
    tenantId: "tenant-a",
    workspaceId: "workspace-a"
  }
);

assert.equal(assertQueueDefinitionCanEnqueue({
  queueDefinitionId: "wqdef_example",
  lifecycleState: QUEUE_DEFINITION_STATES.ACTIVE
}), true);

assert.throws(() => assertQueueDefinitionCanEnqueue({
  queueDefinitionId: "wqdef_disabled",
  lifecycleState: QUEUE_DEFINITION_STATES.DISABLED
}), /disabled/);

const queueDefinitionRegistry = createQueueDefinitionRegistry();

const queueDefinitionA = queueDefinitionRegistry.registerQueueDefinition({
  label: "fixture.build-jobs.1",
  ownerCapability: "sample-platform",
  lifecycleState: QUEUE_DEFINITION_STATES.ACTIVE
});
const queueDefinitionA2 = queueDefinitionRegistry.registerQueueDefinition({
  queueDefinitionId: queueDefinitionA.queueDefinitionId,
  label: "fixture.build-jobs.2",
  ownerCapability: "sample-platform",
  lifecycleState: QUEUE_DEFINITION_STATES.ACTIVE
});
assert.equal(queueDefinitionA2.queueDefinitionVersion, queueDefinitionA.queueDefinitionVersion + 1);
assert.equal(queueDefinitionRegistry.resolveQueueDefinition({
  queueDefinitionId: queueDefinitionA.queueDefinitionId,
  queueDefinitionVersion: queueDefinitionA.queueDefinitionVersion
}).label, "fixture.build-jobs.1");

assert.throws(() => queueDefinitionRegistry.registerQueueDefinition({
  label: "fixture.build-jobs.1",
  ownerCapability: "sample-platform"
}), /already in use|label is already/);

const queueDefinitionWithVersion = queueDefinitionRegistry.registerQueueDefinition({
  queueDefinitionId: queueDefinitionA.queueDefinitionId,
  label: "fixture.build-jobs.99",
  ownerCapability: "sample-platform",
  version: 99,
  lifecycleState: QUEUE_DEFINITION_STATES.ACTIVE
});
assert.equal(queueDefinitionWithVersion.queueDefinitionVersion, 99);

const hardCappedDefinition = queueDefinitionRegistry.registerQueueDefinition({
  label: "hard-capped.jobs",
  ownerCapability: "sample-platform",
  policy: {
    maxInFlight: WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT * 4
  },
  lifecycleState: QUEUE_DEFINITION_STATES.ACTIVE
});
assert.equal(hardCappedDefinition.policy.maxInFlight, WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT);
assert.equal(hardCappedDefinition.policy.maxInFlightClamped, true);

const queueDefinitionDeprecated = queueDefinitionRegistry.registerQueueDefinition({
  label: "deprecated.jobs",
  ownerCapability: "sample-platform",
  lifecycleState: QUEUE_DEFINITION_STATES.DEPRECATED
});
assert.throws(() => queueDefinitionRegistry.resolveQueueDefinitionForEnqueue({
  label: "deprecated.jobs",
  scope: { tenantId: "tenant-a", workspaceId: "ws-a", projectId: "p-a", deploymentId: "d-a" }
}), /deprecated/);

const queueDefinitionDisabled = queueDefinitionRegistry.registerQueueDefinition({
  label: "disabled.jobs",
  ownerCapability: "sample-platform",
  lifecycleState: QUEUE_DEFINITION_STATES.DISABLED
});
assert.throws(() => queueDefinitionRegistry.resolveQueueDefinitionForEnqueue({
  label: "disabled.jobs",
  scope: { tenantId: "tenant-a", workspaceId: "ws-a", projectId: "p-a", deploymentId: "d-a" }
}), /disabled/);

assert.throws(() => queueDefinitionRegistry.resolveQueueDefinition({
  label: "missing-label"
}), /unresolved|requires queueDefinitionId or label/);

const scopedQueueDefinitionRegistry = createQueueDefinitionRegistry({
  structuredScopeValidation: ({ scope }) => {
    if (!scope.tenantId || !scope.projectId) {
      throw new Error("tenantId and projectId are required");
    }
    return scope;
  }
});

const scopedDef = scopedQueueDefinitionRegistry.registerQueueDefinition({
  label: "scoped.jobs",
  ownerCapability: "sample-platform",
  lifecycleState: QUEUE_DEFINITION_STATES.ACTIVE
});
const scopedResolve = scopedQueueDefinitionRegistry.resolveQueueDefinitionForEnqueue({
  label: "scoped.jobs",
  scope: { tenantId: "tenant-b", projectId: "proj-1", workspaceId: "ws-b" },
  dedupeKey: { jobId: "j1", attempt: 1 }
});
assert.equal(scopedResolve.queueDefinitionId, scopedDef.queueDefinitionId);
assert.equal(typeof scopedResolve.dedupeKey, "string");
assert.match(scopedResolve.dedupeKey, /^[0-9a-f]{64}$/);
assert.throws(() => scopedQueueDefinitionRegistry.resolveQueueDefinitionForEnqueue({
  label: "scoped.jobs",
  scope: { tenantId: "tenant-b" }
}), /tenantId and projectId/);

const customDedupeQueueDefinitionRegistry = createQueueDefinitionRegistry({
  dedupeKeyNormalizer: ({ dedupeKey }) => `custom-${String(dedupeKey || "").trim().toLowerCase()}`
});
const customDef = customDedupeQueueDefinitionRegistry.registerQueueDefinition({
  label: "custom.jobs",
  ownerCapability: "sample-platform",
  lifecycleState: QUEUE_DEFINITION_STATES.ACTIVE
});
const customResolved = customDedupeQueueDefinitionRegistry.resolveQueueDefinitionForEnqueue({
  queueDefinitionId: customDef.queueDefinitionId,
  scope: { tenantId: "tenant-c", projectId: "proj-c", workspaceId: "ws-c" },
  dedupeKey: "Job-Token"
});
assert.equal(customResolved.dedupeKey, "custom-job-token");

assert.equal(
  normalizeQueueDedupeKey({ a: 1, b: 2 }),
  normalizeQueueDedupeKey({ b: 2, a: 1 })
);

await withTempQueueStore(async ({ store, timeSource }) => {
  const { registry, definition } = createTestQueueDefinition();
  const aspect = createQueueBackgroundWriteAspect({ store });
  const concreteReport = runWorkQueueConformanceSuite({
    storeAdapter: store,
    backgroundWriteAspect: aspect
  });
  assert.equal(concreteReport.ok, true, JSON.stringify(concreteReport.checks, null, 2));
  concreteSuiteReports.push({
    id: "sqlite-store-adapter",
    status: "passed",
    checks: summarizeChecks(concreteReport.checks)
  });

  const resolved = registry.resolveQueueDefinitionForEnqueue({
    queueDefinitionId: definition.queueDefinitionId,
    scope: { tenantId: "tenant-sqlite", workspaceId: "workspace-a" },
    dedupeKey: { jobId: "job-1" }
  });
  store.registerQueueDefinition(definition);
  const enqueued = store.enqueue({
    ...resolved,
    payloadRef: { kind: "sqlite-smoke", ref: "payload:job-1" },
    ownerRef: { capability: "work-queue-conformance" }
  });
  assert.equal(enqueued.accepted, true);
  assert.equal(enqueued.workItem.state, WORK_QUEUE_STATES.QUEUED);

  const duplicate = store.enqueue({
    ...resolved,
    payloadRef: { kind: "sqlite-smoke", ref: "payload:job-1" },
    ownerRef: { capability: "work-queue-conformance" }
  });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.workItem.workItemId, enqueued.workItem.workItemId);

  const claim = store.claim({
    queueDefinitionId: definition.queueDefinitionId,
    scope: resolved.scope,
    workerId: "worker-a",
    leaseTimeoutMs: 100
  });
  assert.equal(claim.claimed.length, 1);
  const leased = claim.claimed[0];
  assert.equal(leased.workItem.state, WORK_QUEUE_STATES.RUNNING);
  assert.throws(() => store.complete({
    workItemId: leased.workItem.workItemId,
    leaseId: "wrong-lease"
  }), /Lease fence rejected/);
  store.progress({
    workItemId: leased.workItem.workItemId,
    leaseId: leased.lease.leaseId,
    extendMs: 100
  });
  const completed = store.complete({
    workItemId: leased.workItem.workItemId,
    leaseId: leased.lease.leaseId
  });
  assert.equal(completed.workItem.state, WORK_QUEUE_STATES.COMPLETED);

  const retryResolved = registry.resolveQueueDefinitionForEnqueue({
    queueDefinitionId: definition.queueDefinitionId,
    scope: { tenantId: "tenant-sqlite", workspaceId: "workspace-a" },
    dedupeKey: { jobId: "job-2" }
  });
  store.enqueue({
    ...retryResolved,
    payloadRef: { kind: "sqlite-smoke", ref: "payload:job-2" },
    ownerRef: { capability: "work-queue-conformance" }
  });
  const retryClaim = store.claim({
    queueDefinitionId: definition.queueDefinitionId,
    scope: retryResolved.scope,
    workerId: "worker-a",
    leaseTimeoutMs: 100
  });
  assert.equal(retryClaim.claimed.length, 1);
  const retryLease = retryClaim.claimed[0];
  const retried = store.retry({
    workItemId: retryLease.workItem.workItemId,
    leaseId: retryLease.lease.leaseId,
    delayMs: 50,
    error: { code: "retry" }
  });
  assert.equal(retried.workItem.state, WORK_QUEUE_STATES.RETRY_WAIT);
  assert.equal(store.claim({
    queueDefinitionId: definition.queueDefinitionId,
    scope: retryResolved.scope,
    workerId: "worker-a"
  }).claimed.length, 0);
  timeSource.advance(60);
  assert.equal(store.claim({
    queueDefinitionId: definition.queueDefinitionId,
    scope: retryResolved.scope,
    workerId: "worker-a"
  }).claimed.length, 1);

  const pausedResolved = registry.resolveQueueDefinitionForEnqueue({
    queueDefinitionId: definition.queueDefinitionId,
    scope: { tenantId: "tenant-sqlite", workspaceId: "workspace-b" },
    dedupeKey: { jobId: "paused" }
  });
  store.enqueue({
    ...pausedResolved,
    payloadRef: { kind: "sqlite-smoke", ref: "payload:paused" },
    ownerRef: { capability: "work-queue-conformance" }
  });
  store.pause({
    queueDefinitionId: definition.queueDefinitionId,
    scope: pausedResolved.scope,
    reason: "verify pause"
  });
  const pausedClaim = store.claim({
    queueDefinitionId: definition.queueDefinitionId,
    scope: pausedResolved.scope,
    workerId: "worker-paused"
  });
  assert.equal(pausedClaim.claimed.length, 0);
  assert.equal(pausedClaim.control.mode, "paused");
  store.resume({
    queueDefinitionId: definition.queueDefinitionId,
    scope: pausedResolved.scope
  });
  assert.equal(store.claim({
    queueDefinitionId: definition.queueDefinitionId,
    scope: pausedResolved.scope,
    workerId: "worker-paused"
  }).claimed.length, 1);

  const fallbackResolved = registry.resolveQueueDefinitionForEnqueue({
    queueDefinitionId: definition.queueDefinitionId,
    scope: { tenantId: "tenant-sqlite", workspaceId: "workspace-c" },
    dedupeKey: { jobId: "fallback" }
  });
  store.enqueue({
    ...fallbackResolved,
    payloadRef: { kind: "sqlite-smoke", ref: "payload:fallback" },
    ownerRef: { capability: "work-queue-conformance" }
  });
  const fallbackCoordinator = createQueueFallbackCoordinator({
    store,
    timeSource,
    fallback: async () => {
      throw new Error("fallback failed");
    },
    policy: {
      fallbackRetry: {
        maxAttempts: 1,
        initialDelayMs: 1,
        multiplier: 1,
        maxDelayMs: 1
      }
    }
  });
  const runtime = createQueueWorkerRuntime({
    store,
    workerId: "worker-fallback",
    fallbackCoordinator,
    handlers: {
      [definition.queueDefinitionId]: async () => {
        throw new Error("handler failed");
      }
    }
  });
  const fallbackRun = await runtime.runOnce({
    queueDefinitionId: definition.queueDefinitionId,
    scope: fallbackResolved.scope
  });
  assert.equal(fallbackRun.results[0].result.failed, true);
  assert.equal(store.inspect({ states: [WORK_QUEUE_STATES.FAILED] }).items.length, 1);

  const replay = store.rebuildProjection();
  assert.equal(replay.ok, true, JSON.stringify(replay, null, 2));
});

await withTempQueueStore(async ({ store }) => {
  const { registry, definition } = createTestQueueDefinition({ label: "push.jobs" });
  const scope = { tenantId: "tenant-push", workspaceId: "workspace-push" };
  for (let index = 0; index < 3; index += 1) {
    const resolved = registry.resolveQueueDefinitionForEnqueue({
      queueDefinitionId: definition.queueDefinitionId,
      scope,
      dedupeKey: { push: index }
    });
    store.enqueue({
      ...resolved,
      payloadRef: { kind: "push-smoke", ref: `payload:push:${index}` },
      ownerRef: { capability: "work-queue-push-smoke" }
    });
  }

  const seen = [];
  const runtime = createQueueWorkerRuntime({
    store,
    workerId: "push-worker",
    handlers: {
      [definition.queueDefinitionId]: async ({ workItem }) => {
        seen.push(workItem.workItemId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { action: "completed" };
      }
    }
  });
  let peerOffered = false;
  const dispatcher = createQueuePushDispatcher({
    store,
    workerRuntime: runtime,
    queueDefinitionId: definition.queueDefinitionId,
    scope,
    maxInFlight: 1,
    peerSelector: async () => ({
      offer: async () => {
        peerOffered = true;
        return { accepted: true };
      }
    })
  });
  const cappedDispatcher = createQueuePushDispatcher({
    store,
    workerRuntime: runtime,
    queueDefinitionId: definition.queueDefinitionId,
    scope,
    maxInFlight: WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT * 4
  });
  assert.equal(cappedDispatcher.status().creditLimit, WORK_QUEUE_LOCAL_MAX_IN_FLIGHT_HARD_LIMIT);
  assert.equal(cappedDispatcher.status().creditLimitClamped, true);

  const first = await dispatcher.dispatchOnce({ batchSize: 2 });
  assert.equal(first.dispatched, 1);
  const saturated = await dispatcher.dispatchOnce({ batchSize: 1 });
  assert.equal(saturated.dispatched, 0);
  assert.equal(saturated.backpressure.localSaturated, true);
  assert.equal(peerOffered, true);
  assert.equal((await dispatcher.drain()).drained, true);
  const second = await dispatcher.dispatchOnce({ batchSize: 2 });
  assert.equal(second.dispatched, 1);
  assert.equal((await dispatcher.drain()).drained, true);
  const third = await dispatcher.dispatchOnce({ batchSize: 2 });
  assert.equal(third.dispatched, 1);
  assert.equal((await dispatcher.drain()).drained, true);
  assert.equal(seen.length, 3);
  assert.equal(store.inspect({ states: [WORK_QUEUE_STATES.COMPLETED] }).items.length, 3);
  assert.equal(store.rebuildProjection().ok, true);
});

{
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-work-queue-restart-"));
  const timeSource = createManualQueueTimeSource(20_000);
  const queueDefinitionId = "queue.verify.restart-takeover";
  const scope = { tenantId: "verify", workspaceId: "restart" };
  const queueDefinition = createQueueDefinitionRegistry().registerQueueDefinition({
    queueDefinitionId,
    label: "verify.restart-takeover",
    ownerCapability: "work-queue-conformance",
    lifecycleState: QUEUE_DEFINITION_STATES.ACTIVE
  });
  let store = createSqliteWorkQueueStore({
    userDataPath,
    timeSource,
    policy: {
      retryBackoff: {
        strategy: "exponential",
        initialDelayMs: 1,
        multiplier: 1,
        maxDelayMs: 1,
        jitter: "none"
      }
    }
  });
  try {
    store.registerQueueDefinition(queueDefinition);
    const admission = {
      queueDefinitionId,
      queueDefinitionVersion: queueDefinition.queueDefinitionVersion,
      scope,
      dedupeKey: normalizeQueueDedupeKey({ jobId: "restart-job" }),
      payloadRef: { kind: "restart-smoke", ref: "payload:restart" },
      ownerRef: { capability: "work-queue-conformance" }
    };
    const enqueued = store.enqueue(admission);
    const original = store.claim({
      queueDefinitionId,
      scope,
      workerId: "worker-before-restart",
      leaseTimeoutMs: 10
    }).claimed[0];
    assert.ok(original?.lease?.leaseId);
    store.close();

    store = createSqliteWorkQueueStore({
      userDataPath,
      timeSource,
      policy: {
        retryBackoff: {
          strategy: "exponential",
          initialDelayMs: 1,
          multiplier: 1,
          maxDelayMs: 1,
          jitter: "none"
        }
      }
    });
    store.registerQueueDefinition(createQueueDefinitionRegistry().registerQueueDefinition({
      queueDefinitionId,
      label: "verify.restart-takeover",
      ownerCapability: "work-queue-conformance",
      lifecycleState: QUEUE_DEFINITION_STATES.ACTIVE
    }));
    assert.equal(store.enqueue(admission).workItem.workItemId, enqueued.workItem.workItemId);
    timeSource.advance(10);
    assert.equal(store.claim({
      queueDefinitionId,
      scope,
      workerId: "worker-after-restart",
      leaseTimeoutMs: 10
    }).recovered.length, 1);
    timeSource.advance(1);
    const takeover = store.claim({
      queueDefinitionId,
      scope,
      workerId: "worker-after-restart",
      leaseTimeoutMs: 10
    }).claimed[0];
    assert.ok(takeover?.lease?.leaseId);
    assert.notEqual(takeover.lease.leaseId, original.lease.leaseId);
    assert.equal(takeover.lease.leaseSeq, original.lease.leaseSeq + 1);
    assert.throws(() => store.complete({
      workItemId: original.workItem.workItemId,
      leaseId: original.lease.leaseId
    }), /Lease fence rejected/);
    assert.equal(store.complete({
      workItemId: takeover.workItem.workItemId,
      leaseId: takeover.lease.leaseId
    }).completed, true);
    assert.equal(store.enqueue(admission).workItem.state, WORK_QUEUE_STATES.COMPLETED);

    const cancellation = store.enqueue({
      ...admission,
      dedupeKey: normalizeQueueDedupeKey({ jobId: "cancel-job" }),
      payloadRef: { kind: "restart-smoke", ref: "payload:cancel" }
    });
    const cancellationLease = store.claim({
      queueDefinitionId,
      scope,
      workerId: "worker-cancel",
      leaseTimeoutMs: 10
    }).claimed[0].lease;
    assert.equal(store.cancel({ workItemId: cancellation.workItem.workItemId }).cancelled, true);
    assert.equal(store.cancel({ workItemId: cancellation.workItem.workItemId }).idempotent, true);
    assert.throws(() => store.complete({
      workItemId: cancellation.workItem.workItemId,
      leaseId: cancellationLease.leaseId
    }), /not leased/);
  } finally {
    store.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

await withTempQueueStore(async ({ store, timeSource }) => {
  const { registry, definition } = createTestQueueDefinition({ label: "expiry.jobs" });
  const scope = { tenantId: "tenant-expiry", workspaceId: "workspace-expiry" };
  const admission = registry.resolveQueueDefinitionForEnqueue({
    queueDefinitionId: definition.queueDefinitionId,
    scope,
    dedupeKey: { jobId: "expiry-job" }
  });
  const enqueued = store.enqueue({
    ...admission,
    expiresAtMs: 10_010,
    payloadRef: { kind: "expiry-smoke", ref: "payload:expiry" }
  });
  assert.equal(enqueued.workItem.expiresAtMs, 10_010);
  const running = store.claim({
    queueDefinitionId: definition.queueDefinitionId,
    scope,
    workerId: "expiry-worker",
    leaseTimeoutMs: 100
  }).claimed[0];
  assert.equal(running.lease.expiresAtMs, 10_010);
  timeSource.advance(10);
  const lateCompletion = store.complete({
    workItemId: running.workItem.workItemId,
    leaseId: running.lease.leaseId
  });
  assert.equal(lateCompletion.completed, false);
  assert.equal(lateCompletion.expired, true);
  assert.equal(lateCompletion.workItem.state, WORK_QUEUE_STATES.EXPIRED);
  assert.equal(store.rebuildProjection().ok, true);
});

await withTempQueueStore(async ({ store, timeSource }) => {
  const { registry, definition } = createTestQueueDefinition({ label: "random.jobs" });
  const scope = { tenantId: "tenant-random", workspaceId: "workspace-random" };
  const rand = createPrng(0x5eed);
  const activeLeases = new Map();
  const staleLeases = [];

  function enqueueRandom(index) {
    const resolved = registry.resolveQueueDefinitionForEnqueue({
      queueDefinitionId: definition.queueDefinitionId,
      scope,
      dedupeKey: { random: index, shard: Math.floor(rand() * 5) }
    });
    const result = store.enqueue({
      ...resolved,
      payloadRef: { kind: "random-smoke", ref: `payload:${index}` },
      ownerRef: { capability: "work-queue-random-smoke" },
      priority: Math.floor(rand() * 5),
      maxAttempts: 4
    });
    return result.workItem;
  }

  for (let index = 0; index < 12; index += 1) {
    enqueueRandom(index);
  }

  for (let step = 0; step < 160; step += 1) {
    const action = Math.floor(rand() * 9);
    if (action === 0) {
      enqueueRandom(1000 + step);
    } else if (action === 1) {
      const claimResult = store.claim({
        queueDefinitionId: definition.queueDefinitionId,
        scope,
        workerId: `random-worker-${step % 3}`,
        batchSize: 2,
        leaseTimeoutMs: 40
      });
      for (const item of claimResult.recovered || []) {
        activeLeases.delete(item.workItemId);
      }
      for (const claimed of claimResult.claimed || []) {
        activeLeases.set(claimed.workItem.workItemId, claimed.lease);
      }
    } else if (activeLeases.size > 0 && action === 2) {
      const [workItemId, lease] = [...activeLeases.entries()][Math.floor(rand() * activeLeases.size)];
      store.complete({ workItemId, leaseId: lease.leaseId });
      assert.equal(store.complete({ workItemId, leaseId: lease.leaseId }).idempotent, true);
      activeLeases.delete(workItemId);
    } else if (activeLeases.size > 0 && action === 3) {
      const [workItemId, lease] = [...activeLeases.entries()][Math.floor(rand() * activeLeases.size)];
      store.retry({ workItemId, leaseId: lease.leaseId, delayMs: Math.floor(rand() * 30) });
      staleLeases.push([workItemId, lease]);
      activeLeases.delete(workItemId);
    } else if (activeLeases.size > 0 && action === 4) {
      const [workItemId, lease] = [...activeLeases.entries()][Math.floor(rand() * activeLeases.size)];
      store.progress({ workItemId, leaseId: lease.leaseId, extendMs: 40 });
    } else if (activeLeases.size > 0 && action === 5) {
      const [workItemId, lease] = [...activeLeases.entries()][Math.floor(rand() * activeLeases.size)];
      store.cancelRunning({ workItemId, leaseId: lease.leaseId });
      assert.equal(store.cancelRunning({ workItemId, leaseId: lease.leaseId }).idempotent, true);
      activeLeases.delete(workItemId);
    } else if (action === 6) {
      timeSource.advance(50);
      const claimResult = store.claim({
        queueDefinitionId: definition.queueDefinitionId,
        scope,
        workerId: "random-recovery",
        batchSize: 1,
        leaseTimeoutMs: 40
      });
      for (const item of claimResult.recovered || []) {
        const replacedLease = activeLeases.get(item.workItemId);
        if (replacedLease) {
          staleLeases.push([item.workItemId, replacedLease]);
        }
        activeLeases.delete(item.workItemId);
      }
      for (const claimed of claimResult.claimed || []) {
        activeLeases.set(claimed.workItem.workItemId, claimed.lease);
      }
    } else if (action === 7) {
      store.pause({ queueDefinitionId: definition.queueDefinitionId, scope, reason: "random-pause" });
      assert.equal(store.claim({
        queueDefinitionId: definition.queueDefinitionId,
        scope,
        workerId: "random-paused"
      }).claimed.length, 0);
      store.resume({ queueDefinitionId: definition.queueDefinitionId, scope });
    } else if (staleLeases.length > 0) {
      const [workItemId, lease] = staleLeases[Math.floor(rand() * staleLeases.length)];
      assert.throws(() => store.complete({ workItemId, leaseId: lease.leaseId }), /leased|Lease/i);
    }

    const replay = store.rebuildProjection();
    assert.equal(replay.ok, true, JSON.stringify({ step, replay }, null, 2));
  }
});

assert.equal(computeDeterministicBackoff({ attempt: 1 }), 1000);
assert.equal(computeDeterministicBackoff({ attempt: 4, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 }), 800);
assert.equal(computeDeterministicBackoff({ attempt: 10, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000 }), 1000);

const finishedAt = new Date();
await writeReport({
  schemaVersion: "v0.0.1:workflow:work-queue-conformance-report-1",
  generatedAt: finishedAt.toISOString(),
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  verifier: VERIFIER,
  ok: true,
  summary: {
    verificationPassed: true,
    coverageComplete: true,
    stableDefinitionRestart: true,
    expiredLeaseReclaimed: true,
    absoluteWorkExpiryEnforced: true,
    staleLeaseCompletionRejected: true,
    terminalAdmissionIdempotent: true,
    cancellationLateCompletionRejected: true,
    stateMachineReady: stateMachine.ok === true,
    baseCheckCount: baseSuiteReport.checks.length,
    concreteSuiteCount: concreteSuiteReports.length,
    stateCount: stateMachine.machine.states.length,
    transitionCount: Object.keys(stateMachine.machine.transitions).length,
    safeInterventionStateCount: stateMachine.machine.safeInterventionStates.length
  },
  checks: [
    ...summarizeChecks(baseSuiteReport.checks),
    { id: "sqlite-store-adapter-smoke", status: "passed" },
    { id: "push-dispatcher-backpressure", status: "passed" },
    { id: "randomized-lease-state-replay", status: "passed" },
    { id: "same-lease-terminal-replay-idempotent", status: "passed" },
    { id: "reclaimed-lease-completion-rejected", status: "passed" },
    { id: "absolute-work-expiry", status: "passed" },
    { id: "stable-definition-restart-takeover", status: "passed" },
    { id: "terminal-admission-global-dedupe", status: "passed" },
    { id: "producer-cancel-late-completion-fenced", status: "passed" },
    { id: "deterministic-backoff", status: "passed" }
  ],
  concreteSuites: concreteSuiteReports,
  stateMachine: {
    states: stateMachine.machine.states,
    terminalStates: stateMachine.machine.terminalStates,
    safeInterventionStates: stateMachine.machine.safeInterventionStates
  }
});

console.log("Work Queue conformance verification PASSED");
