import { afterEach, describe, expect, it, vi } from "vitest";

import { createMaintenanceToolRegistry } from "#meshrix/agents/maintenance/tool-registry";
import { createMaintenanceRunExecutor } from "../../../packages/agents/src/maintenance/execution.ts";
import { createMaintenanceRun } from "../../../packages/agents/src/maintenance/reporting.ts";

afterEach(() : any => {
  vi.useRealTimers();
});

function maintenanceAuthorization() : any {
  const binding: Record<string, any> = {
    protocolVersion: "v0.0.1:maintenance-agent:workload-authorization-1",
    workloadPrincipal: {
      subjectType: "agent-profile",
      subjectId: "maintenance-agent",
      agentId: "maintenance-agent",
      profileId: "maintenance-agent"
    },
    grant: {
      grantId: "maintenance-test-grant",
      projectionFingerprint: "a".repeat(64),
      policyRevision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    policy: { decisionId: "maintenance-test-policy", governanceRevision: 1 },
    scope: {
      requiredScope: "maintenance:run",
      grantedScopes: ["maintenance:run", "storage:read"],
      plannedOperationIds: ["system.health"]
    },
    planHash: "b".repeat(64),
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z"
  };
  return {
    ok: true,
    workloadPrincipal: binding.workloadPrincipal,
    grant: { id: binding.grant.grantId, scopes: binding.scope.grantedScopes },
    binding
  };
}

describe("maintenance operation dispatch timeout", () : any => {
  it("keeps canonical queue drain pending until an active maintenance tool has settled", async () : Promise<any> => {
    let observeToolStart: any;
    const toolStarted: any = new Promise((resolve?: any) : any => {
      observeToolStart = resolve;
    });
    let releaseTool: any;
    const toolCanFinish: any = new Promise((resolve?: any) : any => {
      releaseTool = resolve;
    });
    const plan: Record<string, any> = {
      source: "test",
      intent: "active-close-barrier",
      summary: "Active close barrier",
      steps: [{ toolId: "system.health", input: {}, risk: "read_only", reason: "test" }]
    };
    const run: any = createMaintenanceRun({
      plan,
      authorization: maintenanceAuthorization().binding,
      policy: { requiresApproval: false, risk: "read_only" }
    });
    run.authorization.planHash = run.planHash;
    const runs: any = new Map<any, any>([[run.runId, run]]);
    const state: Record<string, any> = {
      activeRunId: "",
      closed: false
    };
    const operationPermissionStore: Record<string, any> = {
      appendExecution: vi.fn(),
      appendMetric: vi.fn()
    };
    let executor: any;
    let activeDispatch: any = Promise.resolve();
    const workQueuePort: Record<string, any> = {
      submit: vi.fn(async (submittedRun?: any) : Promise<any> => {
        activeDispatch = executor.dispatchQueuedRun(submittedRun.runId);
      }),
      resume: vi.fn(async (submittedRun?: any) : Promise<any> => {
        activeDispatch = executor.dispatchQueuedRun(submittedRun.runId);
      }),
      cancel: vi.fn(async () : Promise<any> => ({ cancelled: true })),
      observe: vi.fn(async () : Promise<any> => null),
      stop: vi.fn(async () : Promise<any> => activeDispatch)
    };
    executor = createMaintenanceRunExecutor({
      toolRegistry: {
        runTool: vi.fn(async () : Promise<any> => {
          observeToolStart();
          await toolCanFinish;
          return { ok: true };
        })
      },
      operationPermissionStore,
      maintenanceAuthorizationAuthority: {
        revalidate: vi.fn(async (binding?: any) : Promise<any> => ({
          ...maintenanceAuthorization(),
          binding: { ...binding, planHash: run.planHash }
        }))
      },
      workQueuePort,
      logMaintenance: vi.fn(),
      publish: vi.fn(async () : Promise<any> => {}),
      audit: vi.fn(async () : Promise<any> => ({ auditId: "audit-fixture" })),
      saveRun: vi.fn(async () : Promise<any> => run),
      runs,
      state
    });

    await executor.enqueueRun(run, { wait: false });
    await toolStarted;
    let closeSettled: any = false;
    const closing: any = workQueuePort.stop().then(() : any => executor.prepareClose()).then(() : any => {
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

  it("aborts dispatch and waits for settlement before reporting timeout", async () : Promise<any> => {
    vi.useFakeTimers();
    let observeDispatch: any;
    const dispatchStarted: any = new Promise((resolve?: any) : any => {
      observeDispatch = resolve;
    });
    let observeAbort: any;
    const aborted: any = new Promise((resolve?: any) : any => {
      observeAbort = resolve;
    });
    let settleDispatch: any;
    const dispatchSettled: any = new Promise((resolve?: any) : any => {
      settleDispatch = resolve;
    });
    const operationDispatcher: any = vi.fn(async ({ signal }: Record<string, any>) : Promise<any> => {
      signal.addEventListener("abort", observeAbort, { once: true });
      observeDispatch();
      await dispatchSettled;
    });
    const registry: any = createMaintenanceToolRegistry({
      userDataPath: "<user-data>",
      getControllers: () : any => ({}),
      operationDispatcher,
      revalidateMaintenanceAuthorization: vi.fn(async (binding?: any) : Promise<any> => ({
        ...maintenanceAuthorization(),
        binding
      })),
      operationProofSubstrate: {
        beginLifecycle: vi.fn(),
        finishLifecycle: vi.fn(),
        recordReceipt: vi.fn()
      },
      logger: { error: vi.fn() }
    });
    let executionSettled: any = false;
    const outcome: any = registry.runTool("system.health", {}, {
      maintenanceAuthorization: maintenanceAuthorization()
    }).then(
      (value?: any) : any => {
        executionSettled = true;
        return { value };
      },
      (error?: any) : any => {
        executionSettled = true;
        return { error };
      }
    );

    await dispatchStarted;
    await vi.advanceTimersByTimeAsync(5_000);
    await aborted;
    expect(executionSettled).toBe(false);
    settleDispatch();
    const result: any = await outcome;

    expect(operationDispatcher).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.any(AbortSignal)
    }));
    expect(result.error).toMatchObject({
      code: "maintenance_tool_timeout",
      message: "维护工具执行超时：system.health"
    });
  });
});
