import crypto from "node:crypto";
import { normalizeQueueDedupeKey } from "@meshrix/foundation/work-queue/index";
import {
  maintenanceQueueContextRef,
  maintenanceWorkItemId
} from "#meshrix/agents/maintenance/work-queue-contract";

export const MAINTENANCE_WORK_QUEUE_PROTOCOL_VERSION: any =
  "v0.0.1:workflow:maintenance-work-queue-1";
export const MAINTENANCE_WORK_QUEUE_DEFINITION_ID: any = "queue.maintenance.runs";
export const MAINTENANCE_WORK_QUEUE_LABEL: any = "meshrix.maintenance.runs";
export const MAINTENANCE_WORK_QUEUE_DEFINITION_VERSION: any = 3;

const MAINTENANCE_GOVERNANCE_REVISION: any = "maintenance-run-governance-1";
const SHA256_HEX: any = /^[a-f0-9]{64}$/u;

const QUEUE_SCOPE: Readonly<Record<string, any>> = Object.freeze({
  tenantId: "platform",
  workspaceId: "maintenance"
});

function maintenanceGovernanceShape(run?: any) : any {
  const planHash: any = String(run?.planHash || "").trim().toLowerCase();
  if (!SHA256_HEX.test(planHash)) {
    throw new TypeError("Maintenance queue admission requires a valid plan hash.");
  }
  const status: any = String(run?.status || "").trim();
  if (!["queued", "running"].includes(status)) {
    throw new TypeError("Maintenance queue admission requires a dispatchable run.");
  }
  const approvedAt: any = String(run?.approvedAt || "").trim();
  const requiresApproval: any = run?.requiresApproval === true;
  if (requiresApproval || (String(run?.risk || "") === "repair_write" && !approvedAt)) {
    throw new TypeError("Maintenance queue admission requires completed approval governance.");
  }
  const approvedBy: any = run?.approvedBy && typeof run.approvedBy === "object"
    ? run.approvedBy
    : {};
  const approvalActorDigest: any = approvedAt
    ? crypto.createHash("sha256").update(JSON.stringify({
        userId: String(approvedBy.userId || ""),
        username: String(approvedBy.username || ""),
        roleId: String(approvedBy.roleId || "")
      })).digest("hex")
    : "";
  const authorization: any = run?.authorization;
  if (
    !authorization ||
    !String(authorization.grant?.grantId || "").trim() ||
    !String(authorization.grant?.projectionFingerprint || "").trim() ||
    !Number(authorization.grant?.policyRevision || 0) ||
    !Number(authorization.policy?.governanceRevision || 0) ||
    !String(authorization.scope?.requiredScope || "").trim() ||
    String(authorization.planHash || "").trim().toLowerCase() !== planHash ||
    !Number.isFinite(Date.parse(String(authorization.expiresAt || "")))
  ) {
    throw new TypeError("Maintenance queue admission requires current execution authorization.");
  }
  const approvalAuthorization: any = run?.approvalAuthorization || null;
  if (approvedAt && (
    !approvalAuthorization ||
    !String(approvalAuthorization.grant?.grantId || "").trim() ||
    !String(approvalAuthorization.grant?.projectionFingerprint || "").trim() ||
    String(approvalAuthorization.planHash || "").trim().toLowerCase() !== planHash ||
    !Number.isFinite(Date.parse(String(approvalAuthorization.expiresAt || "")))
  )) {
    throw new TypeError("Maintenance queue admission requires current approval authorization.");
  }
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
    permission: "maintenance:run",
    workloadPrincipal: String(authorization.workloadPrincipal?.subjectId || ""),
    grantId: String(authorization.grant.grantId),
    grantProjectionFingerprint: String(authorization.grant.projectionFingerprint),
    grantPolicyRevision: Number(authorization.grant.policyRevision),
    governancePolicyRevision: Number(authorization.policy.governanceRevision),
    authorizationScope: String(authorization.scope.requiredScope),
    authorizationExpiresAt: String(authorization.expiresAt),
    approvalGrantId: String(approvalAuthorization?.grant?.grantId || ""),
    approvalGrantProjectionFingerprint: String(
      approvalAuthorization?.grant?.projectionFingerprint || ""
    ),
    approvalAuthorizationExpiresAt: String(approvalAuthorization?.expiresAt || "")
  });
}

export function maintenanceQueueGovernanceBinding(run?: any) : any {
  const shape: any = maintenanceGovernanceShape(run);
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
}: Record<string, any> = {}) : Promise<any> {
  if (capabilitySelected !== true) return null;
  if (typeof getMaintenanceAgent !== "function") {
    throw new TypeError("Maintenance work queue requires getMaintenanceAgent.");
  }
  if (!queueApplicationPort || typeof queueApplicationPort.registerQueue !== "function") {
    throw new TypeError("Maintenance work queue requires an injected queue application port.");
  }
  const queue: any = await queueApplicationPort.registerQueue({
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
    handler: async ({ workItem }: Record<string, any>, context?: any) : Promise<any> => {
      let contextRef: any = "";
      try {
        contextRef = maintenanceQueueContextRef(workItem.payloadRef?.contextRef);
      } catch {
        return { action: "failed", reason: "maintenance_context_ref_invalid" };
      }
      const maintenanceAgent: any = getMaintenanceAgent();
      if (
        typeof maintenanceAgent?.getRun !== "function" ||
        typeof maintenanceAgent?.dispatchQueuedRun !== "function" ||
        typeof maintenanceAgent?.revalidateRunAuthorization !== "function"
      ) {
        throw new Error("Maintenance work queue is not connected to the maintenance agent.");
      }
      const persistedRun: any = await maintenanceAgent.getRun(contextRef);
      if (!persistedRun) {
        return { action: "failed", reason: "maintenance_run_context_unavailable" };
      }
      let currentGovernance: any;
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
      try {
        await maintenanceAgent.revalidateRunAuthorization(persistedRun);
      } catch {
        await maintenanceAgent.denyQueuedRunAuthorization?.(
          contextRef,
          "maintenance_authorization_denied"
        );
        return { action: "failed", reason: "maintenance_authorization_denied" };
      }
      const run: any = await maintenanceAgent.dispatchQueuedRun(contextRef, {
        workItemId: workItem.workItemId,
        signal: context.signal
      });
      if (!run) {
        return { action: "failed", reason: "maintenance_run_context_unavailable" };
      }
      return {
        action: run?.status === "cancelled"
          ? "cancelled"
          : ["failed", "rejected"].includes(run?.status)
            ? "failed"
            : "completed",
        reason: run?.status === "cancelled"
          ? "maintenance_run_cancelled"
          : ["failed", "rejected"].includes(run?.status)
            ? "maintenance_run_failed"
            : "maintenance_run_dispatched"
      };
    }
  });

  async function submit(run?: any) : Promise<any> {
    const contextRef: any = maintenanceQueueContextRef(run?.runId);
    const workItemId: any = maintenanceWorkItemId(contextRef);
    const governance: any = maintenanceQueueGovernanceBinding(run);
    const result: any = await queue.enqueue({
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
      actor: {
        subjectType: run.authorization.workloadPrincipal.subjectType,
        subjectId: run.authorization.workloadPrincipal.subjectId,
        agentId: run.authorization.workloadPrincipal.agentId,
        profileId: run.authorization.workloadPrincipal.profileId
      },
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

  async function observe(run?: any) : Promise<any> {
    const contextRef: any = maintenanceQueueContextRef(run?.runId || run);
    const inspected: any = await queue.observe({ workItemId: maintenanceWorkItemId(contextRef) });
    const item: any = inspected.workItem || null;
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

  async function cancel(run?: any) : Promise<any> {
    const contextRef: any = maintenanceQueueContextRef(run?.runId || run);
    const result: any = await queue.cancel({
      workItemId: maintenanceWorkItemId(contextRef),
      operationId: "maintenance.work_queue.cancel",
      actor: {
        subjectType: run?.authorization?.workloadPrincipal?.subjectType || "agent-profile",
        subjectId: run?.authorization?.workloadPrincipal?.subjectId || "maintenance-agent",
        agentId: run?.authorization?.workloadPrincipal?.agentId || "maintenance-agent",
        profileId: run?.authorization?.workloadPrincipal?.profileId || "maintenance-agent"
      },
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

  async function resume(run?: any) : Promise<any> {
    const contextRef: any = maintenanceQueueContextRef(run?.runId || run);
    const workItemId: any = maintenanceWorkItemId(contextRef);
    const inspected: any = await queue.observe({ workItemId });
    const state: any = inspected.workItem?.state || "";
    let result: any;
    if (!state) {
      const durableRun: any = run && typeof run === "object"
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
        actor: {
          subjectType: run?.authorization?.workloadPrincipal?.subjectType || "agent-profile",
          subjectId: run?.authorization?.workloadPrincipal?.subjectId || "maintenance-agent",
          agentId: run?.authorization?.workloadPrincipal?.agentId || "maintenance-agent",
          profileId: run?.authorization?.workloadPrincipal?.profileId || "maintenance-agent"
        },
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

  const provider: Readonly<Record<string, any>> = Object.freeze({
    protocolVersion: MAINTENANCE_WORK_QUEUE_PROTOCOL_VERSION,
    queueDefinition: queue.definition,
    submit,
    cancel,
    resume,
    observe,
    start() : any {
      if (consumerEnabled) void queue.requestDispatch();
      return consumerEnabled
        ? { started: true }
        : { started: false, reason: "consumer_not_owned" };
    },
    stop() : any {
      return Promise.resolve({ stopped: true, reason: "queue_application_port_owned" });
    },
    describe() : any {
      return {
        protocolVersion: MAINTENANCE_WORK_QUEUE_PROTOCOL_VERSION,
        ...queue.describe()
      };
    },
    close() : any {
      return Promise.resolve({ closed: true, reason: "queue_application_port_owned" });
    }
  });
  if (autoStart) provider.start();
  return provider;
}
