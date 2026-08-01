#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import {
  INTEGRATION_TASK_SUPERVISOR_PROTOCOL_VERSION,
  IntegrationTaskSupervisorError,
  createIntegrationTaskSupervisor
} from "../../packages/server-runtime/src/composition/integration-task-supervisor.ts";
import {
  executeSystemCoreOperation
} from "../../packages/server-runtime/src/composition/console-domain/operation-executors/system-observation-executors.ts";

const REPORT_PATH: any = "build/reports/integration-task-supervisor.json";
const REPORT_SCHEMA_VERSION: any =
  "v0.0.1:platform:integration-task-supervisor-report-1";
const SECRET_MARKER: any = "verifier-private-adapter-value";
const EXPECTED_ASSERTIONS: readonly any[] = Object.freeze([
  "integration.empty.no_adapter",
  "integration.readiness.start_gate",
  "integration.invalid.isolated",
  "integration.connect.retry_bounded",
  "integration.connect.timeout_fenced",
  "integration.task.concurrency_bounded",
  "integration.task.failure_typed",
  "integration.task.cancellation_fenced",
  "integration.shutdown.bounded",
  "integration.server.lifecycle_wiring",
  "integration.health.bounded_projection",
  "integration.evidence.privacy_safe"
]);

function delay(ms?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

async function waitFor(predicate?: any, {
  timeoutMs = 1_000,
  intervalMs = 5,
  code = "condition_timeout"
}: Record<string, any> = {}) : Promise<any> {
  const startedAt: any = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error(code);
}

function adapterState(supervisor?: any, adapterId?: any) : any {
  return supervisor.snapshot().adapters.find((adapter?: any) : any => adapter.id === adapterId);
}

function assertion(id?: any, passed?: any, details: Record<string, any> = {}) : any {
  return Object.freeze({
    id,
    passed: passed === true,
    ...details
  });
}

const assertions: any[] = [];

async function check(id?: any, verify?: any) : Promise<any> {
  try {
    const details: any = await verify();
    assertions.push(assertion(id, true, details));
  } catch {
    assertions.push(assertion(id, false, {
      code: "integration_supervisor_assertion_failed"
    }));
  }
}

await check("integration.empty.no_adapter", async () : Promise<any> => {
  const supervisor: any = createIntegrationTaskSupervisor();
  const before: any = supervisor.snapshot();
  assert.equal(before.summary.declaredAdapterCount, 0);
  assert.equal(before.summary.activeJobCount, 0);
  const running: any = supervisor.start({ coreReady: true });
  assert.equal(running.lifecycleState, "running");
  assert.equal(running.summary.admittedAdapterCount, 0);
  const stopped: any = await supervisor.shutdown();
  assert.equal(stopped.lifecycleState, "stopped");
  return { admittedAdapterCount: 0 };
});

await check("integration.readiness.start_gate", async () : Promise<any> => {
  let connectCalls: any = 0;
  const supervisor: any = createIntegrationTaskSupervisor({
    adapters: [{
      id: "readiness-fixture",
      enabled: true,
      configured: true,
      async connect() : Promise<any> {
        connectCalls += 1;
      },
      async execute() : Promise<any> {
        return { ok: true };
      }
    }]
  });
  const waiting: any = supervisor.start({ coreReady: false });
  assert.equal(waiting.lifecycleState, "waiting_core");
  await delay(20);
  assert.equal(connectCalls, 0);
  const startedAt: any = Date.now();
  const running: any = supervisor.start({ coreReady: true });
  const startElapsedMs: any = Date.now() - startedAt;
  assert.equal(running.lifecycleState, "running");
  assert.ok(startElapsedMs < 100);
  await waitFor(() : any => adapterState(supervisor, "readiness-fixture")?.state === "ready");
  assert.equal(connectCalls, 1);
  await supervisor.shutdown();
  return {
    connectBeforeCoreReady: false,
    asynchronousStart: true
  };
});

await check("integration.invalid.isolated", async () : Promise<any> => {
  let forbiddenCalls: any = 0;
  const supervisor: any = createIntegrationTaskSupervisor({
    adapters: [
      {
        id: "disabled-fixture",
        enabled: false,
        configured: true,
        async connect() : Promise<any> {
          forbiddenCalls += 1;
        },
        async execute() : Promise<any> {
          forbiddenCalls += 1;
        }
      },
      {
        id: "unconfigured-fixture",
        enabled: true,
        configured: false,
        async connect() : Promise<any> {
          forbiddenCalls += 1;
        },
        async execute() : Promise<any> {
          forbiddenCalls += 1;
        }
      },
      {
        id: "invalid-fixture",
        enabled: true,
        configured: true
      }
    ]
  });
  supervisor.start({ coreReady: true });
  await delay(25);
  assert.equal(forbiddenCalls, 0);
  const snapshot: any = supervisor.snapshot();
  assert.equal(snapshot.adapters[0].state, "disabled");
  assert.equal(snapshot.adapters[1].state, "unconfigured");
  assert.equal(snapshot.adapters[2].state, "invalid");
  await supervisor.shutdown();
  return {
    isolatedStateCount: 3
  };
});

await check("integration.connect.retry_bounded", async () : Promise<any> => {
  let attempts: any = 0;
  const supervisor: any = createIntegrationTaskSupervisor({
    maxConnectAttempts: 3,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 20,
    adapters: [{
      id: "retry-fixture",
      enabled: true,
      configured: true,
      async connect() : Promise<any> {
        attempts += 1;
        if (attempts < 3) throw new Error(SECRET_MARKER);
        return { connected: true };
      },
      async execute() : Promise<any> {
        return { ok: true };
      }
    }]
  });
  supervisor.start({ coreReady: true });
  await waitFor(() : any => adapterState(supervisor, "retry-fixture")?.state === "ready");
  assert.equal(attempts, 3);
  assert.equal(adapterState(supervisor, "retry-fixture").connectAttempts, 3);
  await supervisor.shutdown();
  return {
    attempts,
    maximumAttempts: 3
  };
});

await check("integration.connect.timeout_fenced", async () : Promise<any> => {
  const supervisor: any = createIntegrationTaskSupervisor({
    connectTimeoutMs: 20,
    maxConnectAttempts: 3,
    adapters: [{
      id: "connect-timeout-fixture",
      enabled: true,
      configured: true,
      async connect() : Promise<any> {
        return new Promise(() : any => {});
      },
      async execute() : Promise<any> {
        return { ok: true };
      }
    }]
  });
  const startedAt: any = Date.now();
  supervisor.start({ coreReady: true });
  await waitFor(() : any => adapterState(supervisor, "connect-timeout-fixture")?.fenced === true);
  const state: any = adapterState(supervisor, "connect-timeout-fixture");
  assert.equal(state.code, "integration_connect_timeout");
  assert.equal(state.connectAttempts, 1);
  assert.ok(Date.now() - startedAt < 500);
  await supervisor.shutdown();
  return {
    fenced: true,
    attempts: 1
  };
});

await check("integration.task.concurrency_bounded", async () : Promise<any> => {
  let releaseFirst: any;
  let running: any = 0;
  let maximumRunning: any = 0;
  const firstGate: any = new Promise((resolve?: any) : any => {
    releaseFirst = resolve;
  });
  const supervisor: any = createIntegrationTaskSupervisor({
    maxConcurrent: 1,
    maxQueued: 1,
    adapters: [{
      id: "concurrency-fixture",
      enabled: true,
      configured: true,
      async execute({ input }: Record<string, any>) : Promise<any> {
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        try {
          if (input.order === 1) await firstGate;
          return { order: input.order };
        } finally {
          running -= 1;
        }
      }
    }]
  });
  supervisor.start({ coreReady: true });
  await waitFor(() : any => adapterState(supervisor, "concurrency-fixture")?.state === "ready");
  const first: any = supervisor.execute("concurrency-fixture", { order: 1 });
  await waitFor(() : any => adapterState(supervisor, "concurrency-fixture")?.runningTasks === 1);
  const second: any = supervisor.execute("concurrency-fixture", { order: 2 });
  await assert.rejects(
    () : any => supervisor.execute("concurrency-fixture", { order: 3 }),
    (error?: any) : any => error instanceof IntegrationTaskSupervisorError &&
      error.code === "integration_task_queue_full"
  );
  releaseFirst();
  assert.deepEqual(await first, { order: 1 });
  assert.deepEqual(await second, { order: 2 });
  assert.equal(maximumRunning, 1);
  await supervisor.shutdown();
  return {
    maximumRunning,
    queueLimitEnforced: true
  };
});

await check("integration.task.failure_typed", async () : Promise<any> => {
  const supervisor: any = createIntegrationTaskSupervisor({
    adapters: [{
      id: "failure-fixture",
      enabled: true,
      configured: true,
      async execute() : Promise<any> {
        throw new Error(SECRET_MARKER);
      }
    }]
  });
  supervisor.start({ coreReady: true });
  await waitFor(() : any => adapterState(supervisor, "failure-fixture")?.state === "ready");
  await assert.rejects(
    () : any => supervisor.execute("failure-fixture", {
      privateValue: SECRET_MARKER
    }),
    (error?: any) : any => {
      assert.ok(error instanceof IntegrationTaskSupervisorError);
      assert.equal(error.code, "integration_task_failed");
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes(SECRET_MARKER), false);
      return true;
    }
  );
  assert.equal(adapterState(supervisor, "failure-fixture").state, "ready");
  await supervisor.shutdown();
  return {
    typedError: true,
    capabilityScoped: true
  };
});

await check("integration.task.cancellation_fenced", async () : Promise<any> => {
  const supervisor: any = createIntegrationTaskSupervisor({
    taskTimeoutMs: 250,
    adapters: [{
      id: "cancellation-fixture",
      enabled: true,
      configured: true,
      async execute() : Promise<any> {
        return new Promise(() : any => {});
      }
    }]
  });
  supervisor.start({ coreReady: true });
  await waitFor(() : any => adapterState(supervisor, "cancellation-fixture")?.state === "ready");
  const controller: any = new AbortController();
  const pending: any = supervisor.execute(
    "cancellation-fixture",
    { privateValue: SECRET_MARKER },
    { signal: controller.signal }
  );
  await waitFor(() : any => adapterState(supervisor, "cancellation-fixture")?.runningTasks === 1);
  controller.abort();
  await assert.rejects(
    () : any => pending,
    (error?: any) : any => error instanceof IntegrationTaskSupervisorError &&
      error.code === "integration_task_cancelled"
  );
  const state: any = adapterState(supervisor, "cancellation-fixture");
  assert.equal(state.fenced, true);
  assert.equal(state.state, "degraded");
  await supervisor.shutdown();
  return {
    fenced: true
  };
});

await check("integration.shutdown.bounded", async () : Promise<any> => {
  const supervisor: any = createIntegrationTaskSupervisor({
    closeTimeoutMs: 20,
    shutdownTimeoutMs: 50,
    adapters: [{
      id: "close-timeout-fixture",
      enabled: true,
      configured: true,
      async connect() : Promise<any> {
        return { connected: true };
      },
      async execute() : Promise<any> {
        return { ok: true };
      },
      async close() : Promise<any> {
        return new Promise(() : any => {});
      }
    }]
  });
  supervisor.start({ coreReady: true });
  await waitFor(() : any => adapterState(supervisor, "close-timeout-fixture")?.state === "ready");
  const startedAt: any = Date.now();
  const stopped: any = await supervisor.shutdown();
  const elapsedMs: any = Date.now() - startedAt;
  assert.equal(stopped.lifecycleState, "stopped");
  assert.equal(stopped.adapters[0].code, "integration_close_timeout");
  assert.ok(elapsedMs < 500);
  assert.deepEqual(await supervisor.shutdown(), stopped);
  return {
    bounded: true,
    closeFailureAbsorbed: true
  };
});

await check("integration.server.lifecycle_wiring", async () : Promise<any> => {
  const userDataPath: any = await fs.mkdtemp(
    path.join(os.tmpdir(), "meshrix-integration-supervisor-")
  );
  let server: any = null;
  let connected: any = false;
  try {
    server = await startHttpServer({
      userDataPath,
      distPath: "",
      runtimeOptions: {
        cwd: path.resolve(import.meta.dirname, "../.."),
        enabledPlugins: [],
        pluginConfigurations: {},
        disableFileLogging: true
      },
      pluginHostPorts: {
        integrationSupervisorOptions: {
          closeTimeoutMs: 20,
          shutdownTimeoutMs: 100
        },
        integrationAdapters: [{
          id: "server-lifecycle-fixture",
          enabled: true,
          configured: true,
          async connect() : Promise<any> {
            connected = true;
          },
          async execute() : Promise<any> {
            return { ok: true };
          },
          async close() : Promise<any> {
            return new Promise(() : any => {});
          }
        }]
      },
      host: "127.0.0.1",
      port: 0
    });
    await waitFor(() : any => connected === true);
    const response: any = await fetch(`${server.url}/api/healthz`);
    const health: any = await response.json();
    assert.equal(response.status, 200);
    assert.equal(health.ok, true);
    assert.equal(health.optionalIntegrations.lifecycleState, "running");
    assert.equal(health.optionalIntegrations.readyAdapterCount, 1);
    const closeStartedAt: any = Date.now();
    await server.close();
    server = null;
    assert.ok(Date.now() - closeStartedAt < 2_000);
    return {
      startedAfterCoreAdmission: true,
      closeTimeoutAbsorbed: true
    };
  } finally {
    await server?.close?.().catch(() : any => {});
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});

await check("integration.health.bounded_projection", async () : Promise<any> => {
  const supervisor: any = createIntegrationTaskSupervisor();
  supervisor.start({ coreReady: true });
  const health: any = await executeSystemCoreOperation({
    operationId: "system.health",
    context: {
      discoveryState: {
        serverId: "fixture",
        mode: "active",
        activeServiceUrl: "http://fixture.invalid"
      },
      integrationTaskSupervisorSnapshot: supervisor.snapshot()
    }
  });
  assert.equal(health.status, 200);
  assert.equal(health.payload.ok, true);
  assert.deepEqual(health.payload.optionalIntegrations, {
    lifecycleState: "running",
    acceptingTasks: true,
    admittedAdapterCount: 0,
    readyAdapterCount: 0,
    degradedAdapterCount: 0,
    inactiveAdapterCount: 0
  });
  await supervisor.shutdown();
  return {
    coreHealthIndependent: true,
    boundedProjection: true
  };
});

await check("integration.evidence.privacy_safe", async () : Promise<any> => {
  const supervisor: any = createIntegrationTaskSupervisor({
    adapters: [{
      id: "privacy-fixture",
      enabled: true,
      configured: true,
      async connect() : Promise<any> {
        throw new Error(SECRET_MARKER);
      },
      async execute() : Promise<any> {
        return { ok: true };
      }
    }],
    maxConnectAttempts: 1
  });
  supervisor.start({ coreReady: true });
  await waitFor(() : any => adapterState(supervisor, "privacy-fixture")?.state === "degraded");
  const serialized: any = JSON.stringify(supervisor.snapshot());
  assert.equal(serialized.includes(SECRET_MARKER), false);
  assert.equal(serialized.includes("Error"), false);
  await supervisor.shutdown();
  return {
    reportLeakScan: true
  };
});

const assertionIds: any = assertions.map((item?: any) : any => item.id);
assert.deepEqual(assertionIds, EXPECTED_ASSERTIONS);
const failedAssertions: any = assertions.filter((item?: any) : any => item.passed !== true);
const finishedAt: any = new Date().toISOString();
const report: Record<string, any> = {
  schemaVersion: REPORT_SCHEMA_VERSION,
  verifier: "tools/server-scripts/verify-integration-task-supervisor.ts",
  generatedAt: finishedAt,
  finishedAt,
  protocolVersion: INTEGRATION_TASK_SUPERVISOR_PROTOCOL_VERSION,
  assertions,
  summary: {
    assertionCount: assertions.length,
    failedAssertionCount: failedAssertions.length,
    emptyConfigurationVerified: assertions[0]?.passed === true,
    coreReadinessGateVerified: assertions[1]?.passed === true,
    invalidAdapterIsolationVerified: assertions[2]?.passed === true,
    boundedRetryVerified: assertions[3]?.passed === true,
    timeoutFencingVerified: assertions[4]?.passed === true,
    concurrencyAndQueueBoundsVerified: assertions[5]?.passed === true,
    typedFailureVerified: assertions[6]?.passed === true,
    cancellationVerified: assertions[7]?.passed === true,
    boundedShutdownVerified: assertions[8]?.passed === true,
    serverLifecycleWiringVerified: assertions[9]?.passed === true,
    healthProjectionVerified: assertions[10]?.passed === true,
    reportLeakScan: assertions[11]?.passed === true,
    releaseReady: failedAssertions.length === 0
  }
};
assert.equal(JSON.stringify(report).includes(SECRET_MARKER), false);
await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (failedAssertions.length > 0) {
  console.error(
    `[integration-task-supervisor] failed=${failedAssertions.length} report=${REPORT_PATH}`
  );
  process.exitCode = 1;
} else {
  console.log(
    `[integration-task-supervisor] releaseReady=true assertions=${assertions.length} report=${REPORT_PATH}`
  );
}
