import { randomUUID } from "node:crypto";
import { redactForMaintenanceAudit } from "./audit-store.ts";
import { EVENT_TYPES, cloneRun, nowIso, summarizeRun } from "./reporting.ts";
import { dispatchSkipReason, isTerminalRunStatus } from "./validation.ts";
import { summarizeError, summarizeForLog } from "@meshrix/foundation/observability/runtime-logger";

export function createMaintenanceRunExecutor({
  toolRegistry,
  operationPermissionStore,
  maintenanceAuthorizationAuthority,
  workQueuePort,
  logMaintenance,
  publish,
  audit,
  saveRun,
  runs,
  state
}: Record<string, any>) : any {
  if (!workQueuePort || ["submit", "cancel", "resume", "observe"].some(
    (method?: any) : any => typeof workQueuePort[method] !== "function"
  )) {
    throw new TypeError("Maintenance agent requires the canonical workQueuePort.");
  }
  const completionWaiters: any = new Map<any, any>();

  function setWaiter(runId?: any) : any {
    if (!completionWaiters.has(runId)) {
      let resolve: any;
      let reject: any;
      const promise: any = new Promise((promiseResolve?: any, promiseReject?: any) : any => {
        resolve = promiseResolve;
        reject = promiseReject;
      });
      completionWaiters.set(runId, { promise, resolve, reject });
    }
    return completionWaiters.get(runId);
  }

  function finishWaiter(runId?: any, value?: any) : any {
    const waiter: any = completionWaiters.get(runId);
    if (!waiter) {
      return;
    }
    completionWaiters.delete(runId);
    waiter.resolve(value);
  }

  async function executeStep(run?: any, step?: any, rawStep?: any) : Promise<any> {
    const currentAuthorization: any = await maintenanceAuthorizationAuthority.revalidate(
      run.authorization,
      { requiredScope: "maintenance:run", planHash: run.planHash }
    );
    if (run.approvalAuthorization) {
      await maintenanceAuthorizationAuthority.revalidate(
        run.approvalAuthorization,
        { requiredScope: "maintenance:approve", planHash: run.planHash }
      );
    }
    const toolExecutionId: any = `tool_exec_${randomUUID()}`;
    const traceId: any = `trace_${run.runId}_${step.stepId}`;
    logMaintenance("info", "maintenance.agent.tool.started", {
      runId: run.runId,
      stepId: step.stepId,
      toolId: rawStep.toolId,
      risk: step.risk,
      input: summarizeForLog(rawStep.input || {})
    });
    step.status = "running";
    step.startedAt = nowIso();
    await saveRun(run);
    await publish(EVENT_TYPES.toolStarted, {
      run: summarizeRun(run),
      step: {
        stepId: step.stepId,
        toolId: step.toolId,
        risk: step.risk,
        reason: step.reason
      }
    });
    await audit({
      action: "tool.started",
      runId: run.runId,
      stepId: step.stepId,
      status: "started",
      risk: step.risk,
      actor: run.actor,
      details: {
        toolId: step.toolId,
        input: rawStep.input || {}
      }
    });

    const startedAtMs: any = Date.now();
    try {
      const output: any = await toolRegistry.runTool(rawStep.toolId, rawStep.input || {}, {
        traceId,
        run,
        step,
        approved: run.requiresApproval === false || Boolean(run.approvedAt),
        maintenanceAuthorization: currentAuthorization
      });
      step.status = "completed";
      step.completedAt = nowIso();
      step.durationMs = Date.now() - startedAtMs;
      step.output = redactForMaintenanceAudit(output);
      await saveRun(run);
      await publish(EVENT_TYPES.toolCompleted, {
        run: summarizeRun(run),
        step: {
          stepId: step.stepId,
          toolId: step.toolId,
          status: step.status,
          risk: step.risk,
          durationMs: step.durationMs,
          output: step.output
        }
      });
      await audit({
        action: "tool.completed",
        runId: run.runId,
        stepId: step.stepId,
        status: "completed",
        risk: step.risk,
        actor: run.actor,
        details: {
          toolId: step.toolId,
          durationMs: step.durationMs,
          output: step.output
        }
      });
      await operationPermissionStore.appendExecution({
        toolExecutionId,
        traceId,
        toolId: `maintenance-agent.${rawStep.toolId}`,
        toolVersion: "v0.0.1:platform:maintenance-agent-1",
        toolsetIds: ["meshrix.runtime.maintain"],
        subjectType: "agent-profile",
        subjectId: currentAuthorization.workloadPrincipal.subjectId,
        grantId: currentAuthorization.binding.grant.grantId,
        agentId: currentAuthorization.workloadPrincipal.agentId,
        profileId: currentAuthorization.workloadPrincipal.profileId,
        operationId: rawStep.toolId,
        risk: step.risk,
        decision: "allow",
        input: rawStep.input || {},
        result: output,
        status: "ok",
        durationMs: step.durationMs,
        startedAt: step.startedAt,
        finishedAt: step.completedAt
      });
      await operationPermissionStore.appendMetric({
        traceId,
        toolId: `maintenance-agent.${rawStep.toolId}`,
        profileId: "maintenance-agent",
        status: "ok",
        risk: step.risk,
        durationMs: step.durationMs
      });
      logMaintenance("info", "maintenance.agent.tool.completed", {
        runId: run.runId,
        stepId: step.stepId,
        toolId: rawStep.toolId,
        risk: step.risk,
        durationMs: step.durationMs,
        output: summarizeForLog(output)
      });
      return { ok: true };
    } catch (error: any) {
      step.status = "failed";
      step.completedAt = nowIso();
      step.durationMs = Date.now() - startedAtMs;
      step.error = error instanceof Error ? error.message : "维护工具执行失败。";
      await saveRun(run);
      await publish(EVENT_TYPES.toolFailed, {
        run: summarizeRun(run),
        step: {
          stepId: step.stepId,
          toolId: step.toolId,
          status: step.status,
          risk: step.risk,
          durationMs: step.durationMs,
          error: step.error
        }
      });
      await audit({
        action: "tool.failed",
        runId: run.runId,
        stepId: step.stepId,
        status: "failed",
        risk: step.risk,
        actor: run.actor,
        details: {
          toolId: step.toolId,
          durationMs: step.durationMs,
          error: step.error
        }
      });
      await operationPermissionStore.appendExecution({
        toolExecutionId,
        traceId,
        toolId: `maintenance-agent.${rawStep.toolId}`,
        toolVersion: "v0.0.1:platform:maintenance-agent-1",
        toolsetIds: ["meshrix.runtime.maintain"],
        subjectType: "agent-profile",
        subjectId: run.authorization.workloadPrincipal.subjectId,
        grantId: run.authorization.grant.grantId,
        agentId: run.authorization.workloadPrincipal.agentId,
        profileId: run.authorization.workloadPrincipal.profileId,
        operationId: rawStep.toolId,
        risk: step.risk,
        decision: "allow",
        input: rawStep.input || {},
        result: {},
        status: "failed",
        errorCode: "maintenance_agent_tool_failed",
        reasonCode: "maintenance_agent_tool_failed",
        durationMs: step.durationMs,
        startedAt: step.startedAt,
        finishedAt: step.completedAt
      });
      await operationPermissionStore.appendMetric({
        traceId,
        toolId: `maintenance-agent.${rawStep.toolId}`,
        profileId: "maintenance-agent",
        status: "failed",
        risk: step.risk,
        reasonCode: "maintenance_agent_tool_failed",
        durationMs: step.durationMs
      });
      logMaintenance("error", "maintenance.agent.tool.failed", {
        runId: run.runId,
        stepId: step.stepId,
        toolId: rawStep.toolId,
        risk: step.risk,
        durationMs: step.durationMs,
        error: summarizeError(error)
      });
      return { ok: false, error: step.error };
    }
  }

  async function executeRun(run?: any, { signal = null }: Record<string, any> = {}) : Promise<any> {
    const requestCancellation: any = () : any => {
      run.cancelRequested = true;
    };
    if (signal?.aborted) requestCancellation();
    signal?.addEventListener?.("abort", requestCancellation, { once: true });
    logMaintenance("info", "maintenance.agent.run.started", {
      runId: run.runId,
      trigger: run.trigger,
      source: run.source,
      intent: run.intent,
      risk: run.risk,
      stepCount: run.plan?.steps?.length || 0
    });
    state.activeRunId = run.runId;
    run.status = "running";
    run.startedAt = run.startedAt || nowIso();
    await saveRun(run);
    await publish(EVENT_TYPES.runStarted, { run: summarizeRun(run) });
    await audit({
      action: "run.started",
      runId: run.runId,
      status: "started",
      risk: run.risk,
      actor: run.actor,
      details: {
        intent: run.intent,
        planHash: run.planHash
      }
    });

    let hasFailedReadOnlyStep: any = false;
    try {
      for (const [index, rawStep] of run.plan.steps.entries()) {
        const step: any = run.steps[index];
        if (run.cancelRequested) {
          logMaintenance("warn", "maintenance.agent.step.cancelled", {
            runId: run.runId,
            stepId: step.stepId,
            toolId: rawStep.toolId
          });
          step.status = "cancelled";
          step.completedAt = nowIso();
          continue;
        }
        const result: any = await executeStep(run, step, rawStep);
        if (!result.ok) {
          if (rawStep.risk === "read_only" && run.risk === "read_only") {
            hasFailedReadOnlyStep = true;
            continue;
          }
          run.status = "failed";
          run.error = result.error;
          break;
        }
      }

      if (run.cancelRequested) {
        run.status = "cancelled";
        run.error = "管理员已取消维护运行。";
      } else if (run.status === "running") {
        run.status = hasFailedReadOnlyStep ? "completed_with_errors" : "completed";
      }
      run.completedAt = nowIso();
      await saveRun(run);
      await publish(EVENT_TYPES.runCompleted, { run: cloneRun(run) });
      await audit({
        action: "run.completed",
        runId: run.runId,
        status: run.status,
        risk: run.risk,
        actor: run.actor,
        details: {
          intent: run.intent,
          error: run.error || ""
        }
      });
      finishWaiter(run.runId, cloneRun(run));
      logMaintenance(run.status === "failed" ? "error" : "info", "maintenance.agent.run.completed", {
        runId: run.runId,
        status: run.status,
        risk: run.risk,
        error: run.error || ""
      });
    } catch (error: any) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : "维护运行失败。";
      run.completedAt = nowIso();
      await saveRun(run);
      await publish(EVENT_TYPES.runCompleted, { run: cloneRun(run) });
      await audit({
        action: "run.failed",
        runId: run.runId,
        status: "failed",
        risk: run.risk,
        actor: run.actor,
        details: {
          error: run.error
        }
      });
      finishWaiter(run.runId, cloneRun(run));
      logMaintenance("error", "maintenance.agent.run.failed", {
        runId: run.runId,
        risk: run.risk,
        error: summarizeError(error)
      });
    } finally {
      signal?.removeEventListener?.("abort", requestCancellation);
      state.activeRunId = "";
      logMaintenance("debug", "maintenance.agent.run.released", {
        runId: run.runId
      });
    }
  }

  async function dispatchQueuedRun(runId?: any, { signal = null }: Record<string, any> = {}) : Promise<any> {
    logMaintenance("info", "maintenance.agent.queue.dispatch.started", {
      runId
    });
    if (state.closed) {
      logMaintenance("warn", "maintenance.agent.queue.dispatch.skipped", {
        runId,
        reason: "closed"
      });
      finishWaiter(runId, cloneRun(runs.get(runId)));
      return null;
    }
    const run: any = runs.get(runId);
    const skipReason: any = dispatchSkipReason(run);
    if (skipReason) {
      logMaintenance("warn", "maintenance.agent.queue.dispatch.skipped", {
        runId,
        reason: skipReason
      });
      finishWaiter(runId, cloneRun(run));
      return cloneRun(run);
    }
    await executeRun(run, { signal });
    return cloneRun(runs.get(runId));
  }

  async function enqueueRun(run?: any, { wait = true }: Record<string, any> = {}) : Promise<any> {
    logMaintenance("info", "maintenance.agent.run.enqueue.requested", {
      runId: run.runId,
      wait,
      status: run.status,
      risk: run.risk
    });
    const waiter: any = setWaiter(run.runId);
    if (run.status !== "running") {
      run.status = "queued";
      await saveRun(run);
      await workQueuePort.submit(run);
    }
    if (wait) {
      await waiter.promise.catch(() : any => null);
      return cloneRun(runs.get(run.runId));
    }
    return cloneRun(run);
  }

  async function resumeRun(run?: any) : Promise<any> {
    setWaiter(run.runId);
    return workQueuePort.resume(run);
  }

  async function cancelRun(run?: any) : Promise<any> {
    await workQueuePort.cancel(run);
    finishWaiter(run.runId, cloneRun(run));
  }

  async function prepareClose() : Promise<any> {
    const activeRun: any = runs.get(state.activeRunId);
    if (activeRun && !isTerminalRunStatus(activeRun.status)) {
      activeRun.cancelRequested = true;
    }
    for (const [runId, waiter] of completionWaiters) {
      waiter.resolve(cloneRun(runs.get(runId)));
    }
    completionWaiters.clear();
  }

  return {
    enqueueRun,
    resumeRun,
    cancelRun,
    dispatchQueuedRun,
    finishWaiter,
    prepareClose
  };
}
