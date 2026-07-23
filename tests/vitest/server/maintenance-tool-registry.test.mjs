import { afterEach, describe, expect, it, vi } from "vitest";

import { createMaintenanceToolRegistry } from "#lico/agents/maintenance/tool-registry";
import { createMaintenanceRunExecutor } from "../../../packages/agents/src/maintenance/execution.mjs";
import { createMaintenanceRun } from "../../../packages/agents/src/maintenance/reporting.mjs";

afterEach(() => {
  vi.useRealTimers();
});

describe("maintenance operation dispatch timeout", () => {
  it("keeps canonical queue drain pending until an active maintenance tool has settled", async () => {
    let observeToolStart;
    const toolStarted = new Promise((resolve) => {
      observeToolStart = resolve;
    });
    let releaseTool;
    const toolCanFinish = new Promise((resolve) => {
      releaseTool = resolve;
    });
    const plan = {
      source: "test",
      intent: "active-close-barrier",
      summary: "Active close barrier",
      steps: [{ toolId: "system.health", input: {}, risk: "read_only", reason: "test" }]
    };
    const run = createMaintenanceRun({
      plan,
      policy: { requiresApproval: false, risk: "read_only" }
    });
    const runs = new Map([[run.runId, run]]);
    const state = {
      activeRunId: "",
      closed: false
    };
    const operationPermissionStore = {
      appendExecution: vi.fn(),
      appendMetric: vi.fn()
    };
    let executor;
    let activeDispatch = Promise.resolve();
    const workQueuePort = {
      submit: vi.fn(async (submittedRun) => {
        activeDispatch = executor.dispatchQueuedRun(submittedRun.runId);
      }),
      resume: vi.fn(async (submittedRun) => {
        activeDispatch = executor.dispatchQueuedRun(submittedRun.runId);
      }),
      cancel: vi.fn(async () => ({ cancelled: true })),
      observe: vi.fn(async () => null),
      stop: vi.fn(async () => activeDispatch)
    };
    executor = createMaintenanceRunExecutor({
      toolRegistry: {
        runTool: vi.fn(async () => {
          observeToolStart();
          await toolCanFinish;
          return { ok: true };
        })
      },
      operationPermissionStore,
      workQueuePort,
      logMaintenance: vi.fn(),
      publish: vi.fn(async () => {}),
      audit: vi.fn(async () => ({ auditId: "audit-fixture" })),
      saveRun: vi.fn(async () => run),
      runs,
      state
    });

    await executor.enqueueRun(run, { wait: false });
    await toolStarted;
    let closeSettled = false;
    const closing = workQueuePort.stop().then(() => executor.prepareClose()).then(() => {
      closeSettled = true;
    });
    await Promise.resolve();

    expect(closeSettled).toBe(false);
    expect(run.cancelRequested).toBe(false);
    releaseTool();
    await closing;

    expect(closeSettled).toBe(true);
    expect(state.activeRunId).toBe("");
    expect(run.status).toBe("completed");
    expect(operationPermissionStore.appendExecution).toHaveBeenCalledOnce();
  });

  it("aborts dispatch and waits for settlement before reporting timeout", async () => {
    vi.useFakeTimers();
    let observeDispatch;
    const dispatchStarted = new Promise((resolve) => {
      observeDispatch = resolve;
    });
    let observeAbort;
    const aborted = new Promise((resolve) => {
      observeAbort = resolve;
    });
    let settleDispatch;
    const dispatchSettled = new Promise((resolve) => {
      settleDispatch = resolve;
    });
    const operationDispatcher = vi.fn(async ({ signal }) => {
      signal.addEventListener("abort", observeAbort, { once: true });
      observeDispatch();
      await dispatchSettled;
    });
    const registry = createMaintenanceToolRegistry({
      userDataPath: "<user-data>",
      getControllers: () => ({}),
      operationDispatcher,
      logger: { error: vi.fn() }
    });
    let executionSettled = false;
    const outcome = registry.runTool("system.health").then(
      (value) => {
        executionSettled = true;
        return { value };
      },
      (error) => {
        executionSettled = true;
        return { error };
      }
    );

    await dispatchStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    await aborted;
    expect(executionSettled).toBe(false);
    settleDispatch();
    const result = await outcome;

    expect(operationDispatcher).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.any(AbortSignal)
    }));
    expect(result.error).toMatchObject({
      code: "maintenance_tool_timeout",
      message: "维护工具执行超时：system.health"
    });
  });
});
