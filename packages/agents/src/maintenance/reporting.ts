import { canonicalJson as stableStringify } from "@meshrix/contracts/serialization/canonical-json";
import crypto, { randomUUID } from "node:crypto";
import { computeNextRunAt } from "./config.ts";
import { redactForMaintenanceAudit } from "./audit-store.ts";
import { planHashableShape } from "./policy.ts";
import { unifiedRegistrationForTask } from "@meshrix/foundation/unified-registration-core/unified-registration";
import { maintenanceWorkItemId } from "./work-queue-contract.ts";

export const EVENT_TYPES: Record<string, any> = {
  planCreated: "maintenance.agent.plan.created",
  approvalRequired: "maintenance.agent.approval.required",
  runStarted: "maintenance.agent.run.started",
  toolStarted: "maintenance.agent.tool.started",
  toolCompleted: "maintenance.agent.tool.completed",
  toolFailed: "maintenance.agent.tool.failed",
  runCompleted: "maintenance.agent.run.completed"
};

export function nowIso() : any {
  return new Date().toISOString();
}


export function maintenancePlanHash(plan?: any) : any {
  return crypto
    .createHash("sha256")
    .update(stableStringify(planHashableShape(plan)))
    .digest("hex");
}

export function publicActor(authSession?: any) : any {
  const user: any = authSession?.user;
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

export function createMaintenanceRun({
  plan,
  policy,
  authorization,
  trigger = "manual",
  actor = null,
  input = {}
}: Record<string, any>) : any {
  const createdAt: any = nowIso();
  const runId: any = String(input.runId || `maintenance_run_${randomUUID()}`);
  const planHashValue: any = maintenancePlanHash(plan);
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
    authorization,
    plan,
    steps: plan.steps.map((step?: any, index?: any) : any => ({
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

export function maintenanceScheduledRunId(scheduleId?: any, occurrenceAt?: any) : any {
  const digest: any = crypto.createHash("sha256")
    .update(`${String(scheduleId || "").trim()}\0${String(occurrenceAt || "").trim()}`)
    .digest("hex");
  return `maintenance_run_schedule_${digest.slice(0, 40)}`;
}

export function maintenanceRunQueueId(run?: any) : any {
  return maintenanceWorkItemId(run?.runId);
}

export function maintenanceRunRegistration(run?: any) : any {
  return unifiedRegistrationForTask(run, {
    taskType: "maintenance_agent_run",
    taskId: run.runId,
    queueId: maintenanceRunQueueId(run),
    source: "maintenance-agent",
    feature: "智能巡检"
  });
}

export function cloneRun(run?: any) : any {
  if (!run) {
    return null;
  }
  const cloned: any = JSON.parse(JSON.stringify(run));
  cloned.unifiedRegistration = maintenanceRunRegistration(cloned);
  return cloned;
}

export function summarizeRun(run?: any) : any {
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
      pending: run.steps.filter((step?: any) : any => step.status === "pending").length,
      running: run.steps.filter((step?: any) : any => step.status === "running").length,
      completed: run.steps.filter((step?: any) : any => step.status === "completed").length,
      failed: run.steps.filter((step?: any) : any => step.status === "failed").length,
      cancelled: run.steps.filter((step?: any) : any => step.status === "cancelled").length
    },
    error: run.error || "",
    unifiedRegistration: maintenanceRunRegistration(run)
  };
}

export function normalizeConfigNextRunAt(config?: any) : any {
  const now: any = new Date();
  return {
    ...config,
    schedules: (config.schedules || []).map((schedule?: any) : any => ({
      ...schedule,
      nextRunAt:
        schedule.enabled && !schedule.nextRunAt
          ? computeNextRunAt(schedule, now)
          : schedule.nextRunAt || ""
    }))
  };
}
