import { normalizeQueueDedupeKey } from "@lico/foundation/work-queue/index";

export const QUEUED_JOB_WORKFLOW_PROVIDER_PROTOCOL_VERSION = "v0.0.1:workflow:job-workflow-work-queue-1";
export const JOB_WORK_QUEUE_DEFINITION_ID = "queue.jobs.import-parse";
export const JOB_WORK_QUEUE_LABEL = "lico.jobs.import-parse";
export const JOB_WORK_QUEUE_DEFINITION_VERSION = 2;
export const JOB_WORK_QUEUE_POLICY_VERSION = "v0.0.1:workflow:job-work-queue-policy-1";
const JOB_WORK_QUEUE_PRIORITY = 0;
const JOB_WORK_QUEUE_MAX_ATTEMPTS = 3;

function toText(value) {
  return String(value ?? "").trim();
}

function asInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function defaultQueueScope() {
  return { tenantId: "platform", workspaceId: "default" };
}

function summarizeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code || ""
  };
}

function requireManager(manager = null) {
  const required = [
    "createJob",
    "dispatchQueuedJob",
    "getJob",
    "getJobByCheckpointId",
    "getJobResult",
    "listJobs",
    "listQueuedJobAdmissions",
    "reparseJob",
    "deleteJob",
    "cancelJob",
    "failJobFromQueue"
  ];
  const missing = required.filter((name) => typeof manager?.[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`queued job workflow provider is not connected to jobManager: ${missing.join(", ")}`);
  }
  return manager;
}

function jobDedupeKey(job = {}) {
  return normalizeQueueDedupeKey({
    jobId: job.id || "",
    checkpointId: job.checkpointId || "",
    versionGroupId: job.versionGroupId || "",
    versionNumber: job.versionNumber || 1
  });
}

function jobWorkItemId(job = {}) {
  const jobId = toText(job.id);
  if (!jobId) throw new Error("Job queue admission requires job.id.");
  return `job-work:${jobId}`;
}

export async function createQueuedJobWorkflowProvider({
  jobManager,
  queueApplicationPort = null,
  logger = null,
  autoStart = true,
  consumerEnabled = true,
  deletionWaitTimeoutMs = 30_000,
  deletionPollIntervalMs = 25,
  dispatchBatchSize = Number(process.env.LICO_WORK_QUEUE_DISPATCH_BATCH_SIZE || 8),
  maxInFlight = process.env.LICO_WORK_QUEUE_MAX_IN_FLIGHT || 64
} = {}) {
  const manager = requireManager(jobManager);
  if (!queueApplicationPort || typeof queueApplicationPort.registerQueue !== "function") {
    throw new TypeError("Queued job workflow requires an injected queue application port.");
  }
  const applicationPort = queueApplicationPort;
  const reconcileTerminalWorkItem = async (workItem = {}) => {
    if (!["failed", "expired"].includes(toText(workItem.state))) return null;
    const workItemId = toText(workItem.workItemId);
    const jobId = toText(workItem.payloadRef?.jobId) ||
      (workItemId.startsWith("job-work:") ? workItemId.slice("job-work:".length) : "");
    if (!jobId) return null;
    const expired = workItem.state === "expired";
    return manager.failJobFromQueue(jobId, {
      stage: expired ? "队列任务已过期" : "队列执行失败",
      reason: expired ? "Queue work expired before completion." : "Queue work reached terminal failure."
    });
  };
  const queue = await applicationPort.registerQueue({
    queueDefinitionId: JOB_WORK_QUEUE_DEFINITION_ID,
    queueDefinitionVersion: JOB_WORK_QUEUE_DEFINITION_VERSION,
    label: JOB_WORK_QUEUE_LABEL,
    ownerCapability: "platform.job-workflow",
    metadata: {
      platformStateOwner: "jobManager",
      schedulerStateOwner: "queue-application-port"
    },
    policy: {
      policyVersion: JOB_WORK_QUEUE_POLICY_VERSION,
      maxInFlight
    },
    scope: defaultQueueScope(),
    workerId: "platform-job-workflow-worker",
    maxInFlight,
    batchSize: Math.max(1, asInt(dispatchBatchSize, 8)),
    consumerEnabled,
    onTerminal: ({ workItem }) => reconcileTerminalWorkItem(workItem),
    handler: async ({ workItem }, context) => {
      const jobId = toText(workItem.payloadRef?.jobId);
      if (!jobId) {
        return { action: "failed", reason: "job_payload_missing_job_id" };
      }
      const result = await manager.dispatchQueuedJob(jobId, {
        workItemId: workItem.workItemId,
        lease: context.lease,
        signal: context.signal,
        leaseGuard: context.renewLease
      });
      if (result.completed !== true) {
        if (result.job?.status === "completed") {
          return { action: "completed", reason: "platform_job_already_completed" };
        }
        if (result.job?.status === "failed") {
          return { action: "failed", reason: "platform_job_failed" };
        }
        if (result.job?.status === "cancelled") {
          return { action: "cancelled", reason: "platform_job_cancelled" };
        }
        return { action: "retry", reason: "platform_job_not_completed" };
      }
      return {
        action: "completed",
        reason: "platform_job_completed",
        result
      };
    }
  });

  async function enqueueJob(job, input = {}) {
    if (!job?.id) return { enqueued: false, reason: "missing_job_id" };
    const result = await queue.enqueue({
      schedulingScope: {
        tenantId: toText(job.ownerTenantId),
        workspaceId: toText(job.workspaceId),
        projectId: toText(job.projectId)
      },
      dedupeKey: jobDedupeKey(job),
      workItemId: jobWorkItemId(job),
      payloadRef: {
        kind: "import_parse_job",
        jobId: job.id,
        checkpointId: job.checkpointId || "",
        archiveBatchId: job.archiveBatchId || "",
        versionGroupId: job.versionGroupId || "",
        versionNumber: job.versionNumber || 1
      },
      ownerRef: { capability: "platform.job-workflow", jobId: job.id },
      payloadKind: "import_parse_job",
      priority: asInt(input.priority, JOB_WORK_QUEUE_PRIORITY),
      maxAttempts: asInt(input.maxAttempts, JOB_WORK_QUEUE_MAX_ATTEMPTS),
      policyVersion: JOB_WORK_QUEUE_POLICY_VERSION,
      actor: input.actor || { system: "job-workflow-provider" },
      reason: input.reason || "job_workflow_enqueue"
    });
    logger?.info?.("jobs.queue.enqueued", {
      schedulerMode: "queue-application-port",
      jobId: job.id,
      workItemId: result.workItem?.workItemId || "",
      queueDefinitionId: queue.definition.queueDefinitionId,
      deduped: result.deduped === true
    });
    return {
      enqueued: result.accepted !== false,
      deduped: result.deduped === true,
      workItem: result.workItem
    };
  }

  async function repairQueuedAdmissions({ batchSize = 100 } = {}) {
    const limit = Math.max(1, Math.min(200, asInt(batchSize, 100)));
    let cursor = "";
    let scannedCount = 0;
    let admittedCount = 0;
    let dedupedCount = 0;
    do {
      const page = await manager.listQueuedJobAdmissions({ cursor, limit });
      for (const job of page.items || []) {
        const repaired = await enqueueJob(job, {
          operationId: "jobs.queue.repair_admission",
          reason: "job_queue_admission_repaired"
        });
        scannedCount += 1;
        admittedCount += repaired.enqueued ? 1 : 0;
        dedupedCount += repaired.deduped ? 1 : 0;
      }
      cursor = page.done === true ? "" : toText(page.nextCursor);
      if (!page.done && !cursor) {
        throw new Error("Queued job admission repair did not advance its cursor.");
      }
    } while (cursor);
    if (admittedCount > 0) void queue.requestDispatch();
    return { scannedCount, admittedCount, dedupedCount };
  }

  async function reconcileTerminalJobProjections({ limit = 200 } = {}) {
    const inspected = await queue.observe({
      states: ["failed", "expired"],
      limit: Math.max(1, Math.min(200, asInt(limit, 200)))
    });
    let reconciledCount = 0;
    for (const workItem of inspected.items || []) {
      if (await reconcileTerminalWorkItem(workItem)) reconciledCount += 1;
    }
    return { scannedCount: inspected.items?.length || 0, reconciledCount };
  }

  async function waitForDeletionFence(jobId) {
    const deadline = Date.now() + Math.max(1, asInt(deletionWaitTimeoutMs, 30_000));
    const pollIntervalMs = Math.max(1, asInt(deletionPollIntervalMs, 25));
    while (true) {
      const current = await manager.getJob(jobId);
      if (!current || current.status !== "running") return current;
      if (Date.now() >= deadline) {
        const error = new Error(`Timed out waiting for cancelled job execution to stop: ${jobId}`);
        error.code = "job_queue_cancellation_timeout";
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  const provider = Object.freeze({
    protocolVersion: QUEUED_JOB_WORKFLOW_PROVIDER_PROTOCOL_VERSION,
    queueDefinition: queue.definition,
    describe() {
      const base = typeof manager.describe === "function" ? manager.describe() : {};
      return {
        ...base,
        schemaVersion: "v0.0.1:schema:definition-1",
        protocolVersion: QUEUED_JOB_WORKFLOW_PROVIDER_PROTOCOL_VERSION,
        delegatedProtocolVersion: base.protocolVersion || "",
        queue: queue.describe(),
        capabilities: [
          ...(base.capabilities || []),
          "jobs.work-queue.enqueue",
          "jobs.work-queue.inspect",
          "jobs.work-queue.pause",
          "jobs.work-queue.resume",
          "jobs.work-queue.drain",
          "jobs.work-queue.recover-failed"
        ]
      };
    },
    async createJob(input = {}) {
      const job = await manager.createJob(input);
      await enqueueJob(job, {
        operationId: "jobs.create.enqueue",
        priority: JOB_WORK_QUEUE_PRIORITY,
        maxAttempts: JOB_WORK_QUEUE_MAX_ATTEMPTS,
        reason: "job_created"
      });
      void queue.requestDispatch();
      return job;
    },
    async reparseJob(jobId = "", input = {}) {
      const job = await manager.reparseJob(jobId, input);
      await enqueueJob(job, {
        operationId: "jobs.reparse.enqueue",
        reason: "job_reparse_created"
      });
      void queue.requestDispatch();
      return job;
    },
    getJob: (jobId = "") => manager.getJob(jobId),
    getJobWorkflow: (jobId = "") => typeof manager.getJobWorkflow === "function" ? manager.getJobWorkflow(jobId) : null,
    listJobWorkflows: (input = {}) => typeof manager.listJobWorkflows === "function" ? manager.listJobWorkflows(input) : [],
    getJobByCheckpointId: (checkpointId = "") => manager.getJobByCheckpointId(checkpointId),
    getJobResult: (jobId = "") => manager.getJobResult(jobId),
    listJobs: (input = {}) => manager.listJobs(input),
    async cancelJob(jobId = "") {
      const current = await manager.getJob(jobId);
      if (!current) return manager.cancelJob(jobId);
      const workItemId = jobWorkItemId(current);
      const inspected = await queue.observe({ workItemId });
      if (inspected.workItem) {
        await queue.cancel({
          workItemId,
          operationId: "jobs.cancel",
          actor: { system: "job-workflow-provider" },
          reason: "job_cancellation_requested"
        });
      }
      if (current.status === "running" && consumerEnabled !== true) {
        await waitForDeletionFence(jobId);
      }
      return manager.cancelJob(jobId);
    },
    async deleteJob(jobId = "") {
      const current = await manager.getJob(jobId);
      if (!current) return manager.deleteJob(jobId);
      const workItemId = jobWorkItemId(current);
      const inspected = await queue.observe({ workItemId });
      if (inspected.workItem) {
        await queue.cancel({
          workItemId,
          operationId: "jobs.delete.cancel_work",
          actor: { system: "job-workflow-provider" },
          reason: "job_deletion_requested"
        });
      }
      if (current.status === "running" && consumerEnabled !== true) {
        await waitForDeletionFence(jobId);
      }
      return manager.deleteJob(jobId);
    },
    repairQueuedAdmissions,
    reconcileTerminalJobProjections,
    inspectWorkQueue: (input = {}) => queue.observe(input),
    pauseWorkQueue: (input = {}) => queue.pause(input),
    resumeWorkQueue: (input = {}) => queue.resume(input),
    drainWorkQueue: (input = {}) => queue.drain(input),
    failWorkQueueItem: (input = {}) => queue.fail(input),
    async recoverFailedWorkQueue(input = {}) {
      const limit = Math.max(1, asInt(input.limit, 100));
      const inspected = await queue.observe({
        states: ["failed"],
        limit,
        ...(input.workItemId ? { workItemId: input.workItemId } : {})
      });
      const candidates = input.workItemId
        ? [inspected.workItem].filter(Boolean)
        : Array.isArray(inspected.items) ? inspected.items : [];
      const recovered = [];
      const failed = [];
      for (const item of candidates) {
        try {
          recovered.push(await queue.recoverFailed({
            workItemId: item.workItemId,
            operationId: "jobs.work_queue.recover_failed",
            actor: input.actor || { system: "job-workflow-provider" },
            reason: input.reason || "operator_recover_failed"
          }));
        } catch (error) {
          failed.push({ workItemId: item.workItemId || "", error: summarizeError(error) });
        }
      }
      if (recovered.length > 0) void queue.requestDispatch();
      return {
        ok: failed.length === 0,
        queueDefinitionId: queue.definition.queueDefinitionId,
        recoveredCount: recovered.length,
        failedCount: failed.length,
        recovered,
        failed
      };
    },
    async rebuildWorkQueueProof(input = {}) {
      const replay = await queue.rebuildProjection({
        operationId: "jobs.work_queue.rebuild",
        actor: input.actor || { system: "job-workflow-provider" },
        reason: input.reason || "operator_rebuild_projection"
      });
      return { ok: replay.ok === true, queueDefinitionId: queue.definition.queueDefinitionId, proof: replay };
    },
    start() {
      return { started: false, reason: "composition_root_owned" };
    },
    stop() {
      return Promise.resolve({ stopped: false, reason: "composition_root_owned" });
    },
    close() { return Promise.resolve(); }
  });
  await reconcileTerminalJobProjections();
  await repairQueuedAdmissions();
  if (autoStart) provider.start();
  return provider;
}
