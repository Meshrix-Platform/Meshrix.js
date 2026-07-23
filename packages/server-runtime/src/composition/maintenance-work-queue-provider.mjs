import crypto from "node:crypto";
import { normalizeQueueDedupeKey } from "@lico/foundation/work-queue/index";
import {
  maintenanceQueueContextRef,
  maintenanceWorkItemId
} from "#lico/agents/maintenance/work-queue-contract";

export const MAINTENANCE_WORK_QUEUE_PROTOCOL_VERSION =
  "v0.0.1:workflow:maintenance-work-queue-1";
export const MAINTENANCE_WORK_QUEUE_DEFINITION_ID = "queue.maintenance.runs";
export const MAINTENANCE_WORK_QUEUE_LABEL = "lico.maintenance.runs";
export const MAINTENANCE_WORK_QUEUE_DEFINITION_VERSION = 3;

const MAINTENANCE_GOVERNANCE_REVISION = "maintenance-run-governance-1";
const SHA256_HEX = /^[a-f0-9]{64}$/u;

const QUEUE_SCOPE = Object.freeze({
  tenantId: "platform",
  workspaceId: "maintenance"
});

function maintenanceGovernanceShape(run) {
  const planHash = String(run?.planHash || "").trim().toLowerCase();
  if (!SHA256_HEX.test(planHash)) {
    throw new TypeError("Maintenance queue admission requires a valid plan hash.");
  }
  const status = String(run?.status || "").trim();
  if (!["queued", "running"].includes(status)) {
    throw new TypeError("Maintenance queue admission requires a dispatchable run.");
  }
  const approvedAt = String(run?.approvedAt || "").trim();
  const requiresApproval = run?.requiresApproval === true;
  if (requiresApproval || (String(run?.risk || "") === "repair_write" && !approvedAt)) {
    throw new TypeError("Maintenance queue admission requires completed approval governance.");
  }
  const approvedBy = run?.approvedBy && typeof run.approvedBy === "object"
    ? run.approvedBy
    : {};
  const approvalActorDigest = approvedAt
    ? crypto.createHash("sha256").update(JSON.stringify({
        userId: String(approvedBy.userId || ""),
        username: String(approvedBy.username || ""),
        roleId: String(approvedBy.roleId || "")
      })).digest("hex")
    : "";
  return Object.freeze({
    revision: MAINTENANCE_GOVERNANCE_REVISION,
    adapterPolicyVersion: MAINTENANCE_WORK_QUEUE_PROTOCOL_VERSION,
    runSchemaVersion: String(run?.schemaVersion || ""),
    runId: maintenanceQueueContextRef(run?.runId),
    planHash,
    risk: String(run?.risk || "").trim(),
    approvedAt,
    approvalActorDigest,
    assignment: "maintenance-agent-worker",
    permission: "maintenance:run"
  });
}

export function maintenanceQueueGovernanceBinding(run) {
  const shape = maintenanceGovernanceShape(run);
  return Object.freeze({
    governanceRevision: MAINTENANCE_GOVERNANCE_REVISION,
    governanceDigest: `sha256:${crypto.createHash("sha256")
      .update(JSON.stringify(shape))
      .digest("hex")}`
  });
}

export async function createMaintenanceWorkQueueProvider({
  getMaintenanceAgent,
  queueApplicationPort,
  capabilitySelected = false,
  autoStart = true,
  consumerEnabled = true,
  dispatchOnSubmit = true,
  dispatchBatchSize = 8,
  maxInFlight = 1
} = {}) {
  if (capabilitySelected !== true) return null;
  if (typeof getMaintenanceAgent !== "function") {
    throw new TypeError("Maintenance work queue requires getMaintenanceAgent.");
  }
  if (!queueApplicationPort || typeof queueApplicationPort.registerQueue !== "function") {
    throw new TypeError("Maintenance work queue requires an injected queue application port.");
  }
  const queue = await queueApplicationPort.registerQueue({
    queueDefinitionId: MAINTENANCE_WORK_QUEUE_DEFINITION_ID,
    queueDefinitionVersion: MAINTENANCE_WORK_QUEUE_DEFINITION_VERSION,
    label: MAINTENANCE_WORK_QUEUE_LABEL,
    ownerCapability: "maintenance-agent-runbooks",
    metadata: {
      platformStateOwner: "maintenance-agent",
      queueStateOwner: "queue-application-port"
    },
    policy: {
      policyVersion: MAINTENANCE_WORK_QUEUE_PROTOCOL_VERSION,
      maxInFlight
    },
    scope: QUEUE_SCOPE,
    workerId: "maintenance-agent-worker",
    maxInFlight,
    batchSize: dispatchBatchSize,
    consumerEnabled,
    handler: async ({ workItem }, context) => {
      let contextRef = "";
      try {
        contextRef = maintenanceQueueContextRef(workItem.payloadRef?.contextRef);
      } catch {
        return { action: "failed", reason: "maintenance_context_ref_invalid" };
      }
      const maintenanceAgent = getMaintenanceAgent();
      if (
        typeof maintenanceAgent?.getRun !== "function" ||
        typeof maintenanceAgent?.dispatchQueuedRun !== "function"
      ) {
        throw new Error("Maintenance work queue is not connected to the maintenance agent.");
      }
      const persistedRun = await maintenanceAgent.getRun(contextRef);
      if (!persistedRun) {
        return { action: "failed", reason: "maintenance_run_context_unavailable" };
      }
      let currentGovernance;
      try {
        currentGovernance = maintenanceQueueGovernanceBinding(persistedRun);
      } catch {
        return { action: "failed", reason: "maintenance_governance_invalid" };
      }
      if (
        workItem.payloadRef?.governanceRevision !== currentGovernance.governanceRevision ||
        workItem.payloadRef?.governanceDigest !== currentGovernance.governanceDigest
      ) {
        return { action: "failed", reason: "maintenance_governance_changed" };
      }
      const run = await maintenanceAgent.dispatchQueuedRun(contextRef, {
        workItemId: workItem.workItemId,
        signal: context.signal
      });
      if (!run) {
        return { action: "failed", reason: "maintenance_run_context_unavailable" };
      }
      return {
        action: run?.status === "cancelled" ? "cancelled" : "completed",
        reason: run?.status === "cancelled"
          ? "maintenance_run_cancelled"
          : "maintenance_run_dispatched"
      };
    }
  });

  async function submit(run) {
    const contextRef = maintenanceQueueContextRef(run?.runId);
    const workItemId = maintenanceWorkItemId(contextRef);
    const governance = maintenanceQueueGovernanceBinding(run);
    const result = await queue.enqueue({
      schedulingScope: QUEUE_SCOPE,
      dedupeKey: normalizeQueueDedupeKey({ contextRef: workItemId }),
      workItemId,
      payloadRef: Object.freeze({
        kind: "maintenance_agent_run",
        contextRef,
        ...governance
      }),
      payloadKind: "maintenance_agent_run",
      ownerRef: { capability: "maintenance-agent-runbooks" },
      maxAttempts: 3,
      actor: { system: "maintenance-agent" },
      reason: "maintenance_run_queued",
      policyVersion: MAINTENANCE_WORK_QUEUE_PROTOCOL_VERSION
    });
    if (dispatchOnSubmit) void queue.requestDispatch();
    return {
      accepted: result.accepted !== false,
      deduped: result.deduped === true,
      workItemId: result.workItem?.workItemId || ""
    };
  }

  async function observe(run) {
    const contextRef = maintenanceQueueContextRef(run?.runId || run);
    const inspected = await queue.observe({ workItemId: maintenanceWorkItemId(contextRef) });
    const item = inspected.workItem || null;
    return item
      ? Object.freeze({
          workItemId: item.workItemId,
          state: item.state,
          attempt: item.attempt,
          maxAttempts: item.maxAttempts,
          availableAtMs: item.availableAtMs,
          expiresAtMs: item.expiresAtMs
        })
      : null;
  }

  async function cancel(run) {
    const contextRef = maintenanceQueueContextRef(run?.runId || run);
    const result = await queue.cancel({
      workItemId: maintenanceWorkItemId(contextRef),
      operationId: "maintenance.work_queue.cancel",
      actor: { system: "maintenance-agent" },
      reason: "maintenance_run_cancelled"
    });
    return {
      cancelled: result.cancelled === true,
      idempotent: result.idempotent === true,
      completed: result.completed === true,
      workItemId: result.workItem?.workItemId || "",
      state: result.workItem?.state || ""
    };
  }

  async function resume(run) {
    const contextRef = maintenanceQueueContextRef(run?.runId || run);
    const workItemId = maintenanceWorkItemId(contextRef);
    const inspected = await queue.observe({ workItemId });
    const state = inspected.workItem?.state || "";
    let result;
    if (!state) {
      const durableRun = run && typeof run === "object"
        ? run
        : await getMaintenanceAgent()?.getRun?.(contextRef);
      if (!durableRun) {
        return {
          accepted: false,
          deduped: false,
          recovered: false,
          workItemId,
          state: ""
        };
      }
      result = await submit(durableRun);
    } else if (state === "failed") {
      result = await queue.recoverFailed({
        workItemId,
        operationId: "maintenance.work_queue.resume",
        actor: { system: "maintenance-agent" },
        reason: "maintenance_run_resumed"
      });
    } else {
      result = {
        accepted: true,
        deduped: true,
        workItem: inspected.workItem
      };
    }
    if (dispatchOnSubmit && !["completed", "cancelled", "expired"].includes(state)) {
      void queue.requestDispatch();
    }
    return {
      accepted: result.accepted !== false,
      deduped: result.deduped === true,
      recovered: result.recovered === true,
      workItemId: result.workItem?.workItemId || result.workItemId || workItemId,
      state: result.workItem?.state || state
    };
  }

  const provider = Object.freeze({
    protocolVersion: MAINTENANCE_WORK_QUEUE_PROTOCOL_VERSION,
    queueDefinition: queue.definition,
    submit,
    cancel,
    resume,
    observe,
    start() {
      if (consumerEnabled) void queue.requestDispatch();
      return consumerEnabled
        ? { started: true }
        : { started: false, reason: "consumer_not_owned" };
    },
    stop() {
      return Promise.resolve({ stopped: true, reason: "queue_application_port_owned" });
    },
    describe() {
      return {
        protocolVersion: MAINTENANCE_WORK_QUEUE_PROTOCOL_VERSION,
        ...queue.describe()
      };
    },
    close() {
      return Promise.resolve({ closed: true, reason: "queue_application_port_owned" });
    }
  });
  if (autoStart) provider.start();
  return provider;
}
