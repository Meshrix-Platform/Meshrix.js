import { canonicalJson as stableStringify } from "@lico/contracts/serialization/canonical-json";
import crypto, { randomUUID } from "node:crypto";
import { computeNextRunAt } from "./config.mjs";
import { redactForMaintenanceAudit } from "./audit-store.mjs";
import { planHashableShape } from "./policy.mjs";
import { unifiedRegistrationForTask } from "@lico/foundation/unified-registration-core/unified-registration";
import { maintenanceWorkItemId } from "./work-queue-contract.mjs";

export const EVENT_TYPES = {
  planCreated: "maintenance.agent.plan.created",
  approvalRequired: "maintenance.agent.approval.required",
  runStarted: "maintenance.agent.run.started",
  toolStarted: "maintenance.agent.tool.started",
  toolCompleted: "maintenance.agent.tool.completed",
  toolFailed: "maintenance.agent.tool.failed",
  runCompleted: "maintenance.agent.run.completed"
};

export function nowIso() {
  return new Date().toISOString();
}


function hashPlan(plan) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(planHashableShape(plan)))
    .digest("hex");
}

export function publicActor(authSession) {
  const user = authSession?.user;
  if (!user) {
    return {
      userId: "",
      username: "system",
      roleId: "system"
    };
  }
  return {
    userId: user.userId || "",
    username: user.username || "",
    roleId: user.roleId || ""
  };
}

export function createMaintenanceRun({ plan, policy, trigger = "manual", actor = null, input = {} }) {
  const createdAt = nowIso();
  const runId = String(input.runId || `maintenance_run_${randomUUID()}`);
  const planHashValue = hashPlan(plan);
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    runId,
    status: policy.requiresApproval ? "awaiting_approval" : "queued",
    trigger,
    source: plan.source || "runbook",
    intent: plan.intent,
    summary: plan.summary,
    risk: policy.risk,
    requiresApproval: policy.requiresApproval,
    approvalReason: policy.reason || plan.approvalReason || "",
    planHash: planHashValue,
    plan,
    steps: plan.steps.map((step, index) => ({
      stepId: `${runId}_step_${index + 1}`,
      index,
      toolId: step.toolId,
      input: redactForMaintenanceAudit(step.input || {}),
      risk: step.risk,
      reason: step.reason,
      status: "pending",
      startedAt: "",
      completedAt: "",
      durationMs: 0,
      output: null,
      error: ""
    })),
    actor,
    input: redactForMaintenanceAudit(input),
    createdAt,
    updatedAt: createdAt,
    startedAt: "",
    completedAt: "",
    approvedAt: "",
    approvedBy: null,
    cancelRequested: false,
    error: "",
    auditIds: []
  };
}

export function maintenanceScheduledRunId(scheduleId, occurrenceAt) {
  const digest = crypto.createHash("sha256")
    .update(`${String(scheduleId || "").trim()}\0${String(occurrenceAt || "").trim()}`)
    .digest("hex");
  return `maintenance_run_schedule_${digest.slice(0, 40)}`;
}

export function maintenanceRunQueueId(run) {
  return maintenanceWorkItemId(run?.runId);
}

export function maintenanceRunRegistration(run) {
  return unifiedRegistrationForTask(run, {
    taskType: "maintenance_agent_run",
    taskId: run.runId,
    queueId: maintenanceRunQueueId(run),
    source: "maintenance-agent",
    feature: "智能巡检"
  });
}

export function cloneRun(run) {
  if (!run) {
    return null;
  }
  const cloned = JSON.parse(JSON.stringify(run));
  cloned.unifiedRegistration = maintenanceRunRegistration(cloned);
  return cloned;
}

export function summarizeRun(run) {
  return {
    runId: run.runId,
    status: run.status,
    trigger: run.trigger,
    source: run.source,
    intent: run.intent,
    summary: run.summary,
    risk: run.risk,
    requiresApproval: run.requiresApproval,
    approvalReason: run.approvalReason,
    planHash: run.planHash,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    approvedAt: run.approvedAt,
    actor: run.actor,
    approvedBy: run.approvedBy,
    stepSummary: {
      total: run.steps.length,
      pending: run.steps.filter((step) => step.status === "pending").length,
      running: run.steps.filter((step) => step.status === "running").length,
      completed: run.steps.filter((step) => step.status === "completed").length,
      failed: run.steps.filter((step) => step.status === "failed").length,
      cancelled: run.steps.filter((step) => step.status === "cancelled").length
    },
    error: run.error || "",
    unifiedRegistration: maintenanceRunRegistration(run)
  };
}

export function normalizeConfigNextRunAt(config) {
  const now = new Date();
  return {
    ...config,
    schedules: (config.schedules || []).map((schedule) => ({
      ...schedule,
      nextRunAt:
        schedule.enabled && !schedule.nextRunAt
          ? computeNextRunAt(schedule, now)
          : schedule.nextRunAt || ""
    }))
  };
}
