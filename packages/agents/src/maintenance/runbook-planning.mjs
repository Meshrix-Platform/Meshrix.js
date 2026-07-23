import { ensurePlanAllowed, evaluateMaintenancePlanPolicy } from "./policy.mjs";
import {
  EVENT_TYPES,
  cloneRun,
  createMaintenanceRun,
  maintenanceScheduledRunId,
  publicActor,
  summarizeRun
} from "./reporting.mjs";
import { summarizeForLog } from "@lico/foundation/observability/runtime-logger";

export function createMaintenanceRunbookPlanning({
  planner,
  getConfig,
  ensureStarted,
  saveRun,
  publish,
  audit,
  enqueueRun,
  getRun,
  logMaintenance
}) {
  async function createRunFromPlan({ plan, trigger = "manual", authSession = null, input = {} }) {
    await ensureStarted();
    logMaintenance("info", "maintenance.agent.plan.received", {
      trigger,
      intent: plan?.intent || "",
      source: plan?.source || "",
      stepCount: plan?.steps?.length || 0,
      input: summarizeForLog(input)
    });
    const policy = ensurePlanAllowed({ plan, config: getConfig() });
    const run = createMaintenanceRun({
      plan,
      policy,
      trigger,
      actor: publicActor(authSession),
      input
    });
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

  async function chat(input = {}, { authSession = null } = {}) {
    logMaintenance("info", "maintenance.agent.chat.requested", {
      input: summarizeForLog(input),
      actor: publicActor(authSession)
    });
    await ensureStarted();
    const plan = await planner.plan(
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
    const policy = evaluateMaintenancePlanPolicy({ plan, config: getConfig() });
    if (!policy.ok) {
      throw new Error(policy.reason);
    }
    const run = await createRunFromPlan({
      plan,
      trigger: "chat",
      authSession,
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
    const completed = await enqueueRun(run, { wait: input.wait !== false });
    return {
      plan: run.plan,
      run: completed
    };
  }

  async function startRun(input = {}, { authSession = null } = {}) {
    logMaintenance("info", "maintenance.agent.run.start_requested", {
      input: summarizeForLog(input),
      actor: publicActor(authSession)
    });
    await ensureStarted();
    const plan = await planner.plan(
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
    const run = await createRunFromPlan({
      plan,
      trigger: input.trigger || "manual",
      authSession,
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

  async function createScheduledRun(schedule) {
    await ensureStarted();
    const occurrenceAt = String(schedule?.occurrenceAt || schedule?.nextRunAt || "").trim();
    if (!occurrenceAt) throw new Error("Scheduled maintenance occurrence timestamp is required.");
    const runId = maintenanceScheduledRunId(schedule.id || schedule.runbook, occurrenceAt);
    const existing = getRun(runId);
    if (existing) return cloneRun(existing);
    const plan = await planner.plan(
      {
        runbook: schedule.runbook,
        intent: schedule.runbook,
        sessionId: `maintenance-schedule-${schedule.id || schedule.runbook}`,
        contextCompaction: { persist: true }
      },
      getConfig()
    );
    const run = await createRunFromPlan({
      plan,
      trigger: "schedule",
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
