import { ensurePlanAllowed, evaluateMaintenancePlanPolicy } from "./policy.ts";
import {
  EVENT_TYPES,
  cloneRun,
  createMaintenanceRun,
  maintenancePlanHash,
  maintenanceScheduledRunId,
  publicActor,
  summarizeRun
} from "./reporting.ts";
import { summarizeForLog } from "@meshrix/foundation/observability/runtime-logger";

export function createMaintenanceRunbookPlanning({
  planner,
  getConfig,
  ensureStarted,
  saveRun,
  publish,
  audit,
  enqueueRun,
  captureAuthorization,
  getRun,
  logMaintenance
}: Record<string, any>) : any {
  async function createRunFromPlan({
    plan,
    trigger = "manual",
    authSession = null,
    operationAuthorization = null,
    configuredGrantId = "",
    input = {}
  }: Record<string, any>) : Promise<any> {
    await ensureStarted();
    logMaintenance("info", "maintenance.agent.plan.received", {
      trigger,
      intent: plan?.intent || "",
      source: plan?.source || "",
      stepCount: plan?.steps?.length || 0,
      input: summarizeForLog(input)
    });
    const policy: any = ensurePlanAllowed({ plan, config: getConfig() });
    const planHash: any = maintenancePlanHash(plan);
    const authorization: any = await captureAuthorization({
      operationAuthorization,
      configuredGrantId: configuredGrantId ||
        (!operationAuthorization ? getConfig().workloadGrantId : ""),
      requiredScope: "maintenance:run",
      plannedOperationIds: plan.steps.map((step?: any) : any => step.toolId),
      planHash
    });
    const run: any = createMaintenanceRun({
      plan,
      policy,
      authorization,
      trigger,
      actor: publicActor(authSession),
      input
    });
    if (run.planHash !== authorization.planHash) {
      throw new Error("Maintenance execution authorization is not bound to the current plan.");
    }
    await saveRun(run);
    await publish(EVENT_TYPES.planCreated, {
      run: summarizeRun(run),
      plan: run.plan
    });
    logMaintenance("info", "maintenance.agent.plan.created", {
      runId: run.runId,
      trigger,
      intent: run.intent,
      source: run.source,
      risk: run.risk,
      requiresApproval: run.requiresApproval,
      planHash: run.planHash
    });
    await audit({
      action: "plan.created",
      runId: run.runId,
      status: run.status,
      risk: run.risk,
      actor: run.actor,
      details: {
        plan: run.plan,
        policy
      }
    });
    if (run.status === "awaiting_approval") {
      await publish(EVENT_TYPES.approvalRequired, {
        run: summarizeRun(run),
        planHash: run.planHash,
        approvalReason: run.approvalReason
      });
      await audit({
        action: "approval.required",
        runId: run.runId,
        status: "awaiting_approval",
        risk: run.risk,
        actor: run.actor,
        details: {
          planHash: run.planHash,
          approvalReason: run.approvalReason
        }
      });
      logMaintenance("warn", "maintenance.agent.approval.required", {
        runId: run.runId,
        risk: run.risk,
        planHash: run.planHash,
        approvalReason: run.approvalReason
      });
    }
    return run;
  }

  async function chat(input: Record<string, any> = {}, { authSession = null, operationAuthorization = null }: Record<string, any> = {}) : Promise<any> {
    logMaintenance("info", "maintenance.agent.chat.requested", {
      input: summarizeForLog(input),
      actor: publicActor(authSession)
    });
    await ensureStarted();
    const plan: any = await planner.plan(
      {
        runbook: input.runbook || "",
        message: input.message || input.question || input.intent || "",
        intent: input.intent || "",
        sessionId: input.sessionId || "",
        userId: authSession?.user?.userId || "",
        modelAlias: input.modelAlias || input.alias || "",
        alias: input.modelAlias || input.alias || "",
        agentName: input.agentName || "",
        messages: input.messages || input.transcript || undefined,
        transcript: input.transcript || undefined,
        history: input.history || "",
        recentTurns: input.recentTurns || [],
        contextCompaction: input.contextCompaction,
        contextProfileId: input.contextProfileId || input.compactionProfileId || ""
      },
      getConfig()
    );
    const policy: any = evaluateMaintenancePlanPolicy({ plan, config: getConfig() });
    if (!policy.ok) {
      throw new Error(policy.reason);
    }
    const run: any = await createRunFromPlan({
      plan,
      trigger: "chat",
      authSession,
      operationAuthorization,
      input
    });
    if (run.requiresApproval) {
      logMaintenance("info", "maintenance.agent.chat.awaiting_approval", {
        runId: run.runId,
        risk: run.risk
      });
      return {
        plan: run.plan,
        run: cloneRun(run)
      };
    }
    const completed: any = await enqueueRun(run, { wait: input.wait !== false });
    return {
      plan: run.plan,
      run: completed
    };
  }

  async function startRun(input: Record<string, any> = {}, { authSession = null, operationAuthorization = null }: Record<string, any> = {}) : Promise<any> {
    logMaintenance("info", "maintenance.agent.run.start_requested", {
      input: summarizeForLog(input),
      actor: publicActor(authSession)
    });
    await ensureStarted();
    const plan: any = await planner.plan(
      {
        runbook: input.runbook || "",
        options: input.options || {},
        sessionId: input.sessionId || "",
        messages: input.messages || input.transcript || undefined,
        transcript: input.transcript || undefined,
        history: input.history || "",
        recentTurns: input.recentTurns || [],
        contextCompaction: input.contextCompaction,
        contextProfileId: input.contextProfileId || input.compactionProfileId || ""
      },
      getConfig()
    );
    const run: any = await createRunFromPlan({
      plan,
      trigger: input.trigger || "manual",
      authSession,
      operationAuthorization,
      input
    });
    if (run.requiresApproval) {
      logMaintenance("info", "maintenance.agent.run.awaiting_approval", {
        runId: run.runId,
        risk: run.risk
      });
      return cloneRun(run);
    }
    return enqueueRun(run, { wait: input.wait !== false });
  }

  async function createScheduledRun(schedule?: any) : Promise<any> {
    await ensureStarted();
    const occurrenceAt: any = String(schedule?.occurrenceAt || schedule?.nextRunAt || "").trim();
    if (!occurrenceAt) throw new Error("Scheduled maintenance occurrence timestamp is required.");
    const runId: any = maintenanceScheduledRunId(schedule.id || schedule.runbook, occurrenceAt);
    const existing: any = getRun(runId);
    if (existing) return cloneRun(existing);
    const plan: any = await planner.plan(
      {
        runbook: schedule.runbook,
        intent: schedule.runbook,
        sessionId: `maintenance-schedule-${schedule.id || schedule.runbook}`,
        contextCompaction: { persist: true }
      },
      getConfig()
    );
    const run: any = await createRunFromPlan({
      plan,
      trigger: "schedule",
      operationAuthorization: null,
      configuredGrantId: getConfig().workloadGrantId,
      input: {
        runId,
        scheduleId: schedule.id,
        runbook: schedule.runbook,
        occurrenceAt
      }
    });
    if (!run.requiresApproval) {
      await enqueueRun(run, { wait: false });
    }
    return run;
  }

  return {
    createRunFromPlan,
    createScheduledRun,
    chat,
    startRun
  };
}
