import { describe, expect, it, vi } from "vitest";

import {
  createQueuedJobWorkflowProvider,
  JOB_WORK_QUEUE_DEFINITION_ID
} from "../../../packages/server-runtime/src/composition/queued-job-workflow-provider.mjs";

function managerFixture() {
  return {
    createJob: vi.fn(async (input = {}) => ({
      id: input.id || "job-created",
      status: "queued",
      checkpointId: "checkpoint-created",
      versionNumber: 1
    })),
    dispatchQueuedJob: vi.fn(),
    getJob: vi.fn(),
    getJobByCheckpointId: vi.fn(),
    getJobResult: vi.fn(),
    listJobs: vi.fn(),
    listQueuedJobAdmissions: vi.fn().mockResolvedValue({
      items: [],
      nextCursor: "",
      done: true
    }),
    reparseJob: vi.fn(),
    deleteJob: vi.fn(),
    cancelJob: vi.fn(),
    failJobFromQueue: vi.fn()
  };
}

function queueApplicationFixture() {
  const failed = { workItemId: "failed-work", state: "failed" };
  const queue = {
    definition: null,
    maxInFlight: { limit: 8 },
    enqueue: vi.fn(async () => ({
      accepted: true,
      deduped: false,
      workItem: { workItemId: "work-created", state: "queued" }
    })),
    observe: vi.fn(async () => ({ items: [failed] })),
    cancel: vi.fn(),
    expire: vi.fn(),
    fail: vi.fn(),
    recoverFailed: vi.fn(async ({ workItemId }) => ({ recovered: true, workItemId })),
    pause: vi.fn(),
    resume: vi.fn(),
    drain: vi.fn(),
    rebuildProjection: vi.fn(async () => ({ ok: true, eventCount: 1 })),
    requestDispatch: vi.fn(async () => ({ dispatched: 1 })),
    describe: vi.fn(() => ({
      queueDefinitionId: JOB_WORK_QUEUE_DEFINITION_ID,
      storeKind: "fixture",
      effectiveMaxInFlight: 8
    }))
  };
  const port = {
    registerQueue: vi.fn(async (input) => {
      queue.definition = {
        queueDefinitionId: input.queueDefinitionId,
        label: input.label,
        queueDefinitionVersion: 1
      };
      return queue;
    }),
    start: vi.fn(),
    stop: vi.fn(),
    close: vi.fn()
  };
  return { port, queue };
}

describe("queued job workflow application port", () => {
  it("requires composition to inject the canonical queue application port", async () => {
    await expect(createQueuedJobWorkflowProvider({
      jobManager: managerFixture(),
      autoStart: false
    })).rejects.toThrow(/injected queue application port/u);
  });

  it("uses the injected queue facet for failed-work recovery and projection proof", async () => {
    const { port, queue } = queueApplicationFixture();
    const provider = await createQueuedJobWorkflowProvider({
      jobManager: managerFixture(),
      queueApplicationPort: port,
      autoStart: false
    });
    expect(provider.queueDefinition.queueDefinitionId).toBe(JOB_WORK_QUEUE_DEFINITION_ID);
    await expect(provider.recoverFailedWorkQueue()).resolves.toMatchObject({
      ok: true,
      recoveredCount: 1,
      failedCount: 0,
      recovered: [{ recovered: true, workItemId: "failed-work" }]
    });
    await expect(provider.rebuildWorkQueueProof()).resolves.toMatchObject({
      ok: true,
      proof: { ok: true, eventCount: 1 }
    });
    expect(queue.observe).toHaveBeenCalledTimes(2);
    expect(queue.observe).toHaveBeenNthCalledWith(1, expect.objectContaining({
      states: ["failed", "expired"]
    }));
    expect(queue.recoverFailed).toHaveBeenCalledOnce();
    expect(queue.rebuildProjection).toHaveBeenCalledOnce();
    await provider.close();
  });

  it("registers a producer-only job facet when this process does not own the consumer", async () => {
    const { port } = queueApplicationFixture();
    await createQueuedJobWorkflowProvider({
      jobManager: managerFixture(),
      queueApplicationPort: port,
      autoStart: false,
      consumerEnabled: false
    });
    expect(port.registerQueue).toHaveBeenCalledWith(expect.objectContaining({
      queueDefinitionId: JOB_WORK_QUEUE_DEFINITION_ID,
      consumerEnabled: false
    }));
  });

  it("submits newly created jobs without exposing queue infrastructure", async () => {
    const { port, queue } = queueApplicationFixture();
    const manager = managerFixture();
    const provider = await createQueuedJobWorkflowProvider({
      jobManager: manager,
      queueApplicationPort: port,
      autoStart: false
    });
    await expect(provider.createJob({ id: "job-created" })).resolves.toMatchObject({ id: "job-created" });
    expect(queue.enqueue).toHaveBeenCalledOnce();
    expect(queue.requestDispatch).toHaveBeenCalledOnce();
    expect(provider.describe().queue).toEqual(expect.objectContaining({
      queueDefinitionId: JOB_WORK_QUEUE_DEFINITION_ID,
      storeKind: "fixture"
    }));
    await provider.close();
  });

  it("cancels durable work and waits for an external execution fence before deletion", async () => {
    const { port, queue } = queueApplicationFixture();
    const manager = managerFixture();
    const running = { id: "job-running", status: "running", versionNumber: 1 };
    manager.getJob
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce({ ...running, status: "queued" });
    manager.deleteJob.mockResolvedValue({ ...running, status: "queued" });
    queue.observe.mockResolvedValue({
      workItem: { workItemId: "job-work:job-running", state: "running" }
    });
    queue.cancel.mockResolvedValue({ cancelled: true });
    const provider = await createQueuedJobWorkflowProvider({
      jobManager: manager,
      queueApplicationPort: port,
      autoStart: false,
      consumerEnabled: false,
      deletionPollIntervalMs: 1
    });

    await expect(provider.deleteJob(running.id)).resolves.toMatchObject({ id: running.id });
    expect(queue.cancel).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: "job-work:job-running",
      operationId: "jobs.delete.cancel_work"
    }));
    expect(manager.deleteJob).toHaveBeenCalledAfter(queue.cancel);
  });

  it("projects cancellation through the queue fence before settling the platform job", async () => {
    const { port, queue } = queueApplicationFixture();
    const manager = managerFixture();
    const queued = { id: "job-cancel", status: "queued", versionNumber: 1 };
    manager.getJob.mockResolvedValue(queued);
    manager.cancelJob.mockResolvedValue({ ...queued, status: "cancelled" });
    queue.observe.mockResolvedValue({
      workItem: { workItemId: "job-work:job-cancel", state: "queued" }
    });
    queue.cancel.mockResolvedValue({ cancelled: true });
    const provider = await createQueuedJobWorkflowProvider({
      jobManager: manager,
      queueApplicationPort: port,
      autoStart: false
    });

    await expect(provider.cancelJob(queued.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(queue.cancel).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: "job-work:job-cancel",
      operationId: "jobs.cancel"
    }));
    expect(manager.cancelJob).toHaveBeenCalledAfter(queue.cancel);
  });

  it("retains job artifacts when an external cancellation fence times out", async () => {
    const { port, queue } = queueApplicationFixture();
    const manager = managerFixture();
    const running = { id: "job-stuck", status: "running", versionNumber: 1 };
    manager.getJob.mockResolvedValue(running);
    queue.observe.mockResolvedValue({
      workItem: { workItemId: "job-work:job-stuck", state: "running" }
    });
    queue.cancel.mockResolvedValue({ cancelled: true });
    const provider = await createQueuedJobWorkflowProvider({
      jobManager: manager,
      queueApplicationPort: port,
      autoStart: false,
      consumerEnabled: false,
      deletionWaitTimeoutMs: 1,
      deletionPollIntervalMs: 1
    });

    await expect(provider.deleteJob(running.id)).rejects.toMatchObject({
      code: "job_queue_cancellation_timeout"
    });
    expect(manager.deleteJob).not.toHaveBeenCalled();
  });

  it("repairs a failed admission with the same deterministic work item id", async () => {
    const manager = managerFixture();
    const job = await manager.createJob({ id: "job-repair" });
    manager.createJob.mockResolvedValue(job);
    const first = queueApplicationFixture();
    first.queue.enqueue.mockRejectedValueOnce(Object.assign(new Error("capacity"), {
      code: "work_queue_capacity_exceeded"
    }));
    const firstProvider = await createQueuedJobWorkflowProvider({
      jobManager: manager,
      queueApplicationPort: first.port,
      autoStart: false
    });
    await expect(firstProvider.createJob({ id: job.id })).rejects.toMatchObject({
      code: "work_queue_capacity_exceeded"
    });
    const failedWorkItemId = first.queue.enqueue.mock.calls[0][0].workItemId;

    manager.listQueuedJobAdmissions.mockResolvedValueOnce({
      items: [job],
      nextCursor: "",
      done: true
    });
    const second = queueApplicationFixture();
    await createQueuedJobWorkflowProvider({
      jobManager: manager,
      queueApplicationPort: second.port,
      autoStart: false
    });
    expect(second.queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: failedWorkItemId,
      dedupeKey: first.queue.enqueue.mock.calls[0][0].dedupeKey
    }));
    expect(second.queue.requestDispatch).toHaveBeenCalledOnce();
  });

  it("propagates the lease signal and does not complete failed job execution", async () => {
    const { port } = queueApplicationFixture();
    const manager = managerFixture();
    manager.dispatchQueuedJob.mockResolvedValue({
      completed: false,
      job: { status: "failed" }
    });
    await createQueuedJobWorkflowProvider({
      jobManager: manager,
      queueApplicationPort: port,
      autoStart: false
    });
    const registration = port.registerQueue.mock.calls[0][0];
    const controller = new AbortController();
    const renewLease = vi.fn();
    await expect(registration.handler({
      workItem: {
        workItemId: "work-failed-job",
        payloadRef: { jobId: "job-failed" }
      }
    }, {
      lease: { leaseId: "lease-failed-job" },
      signal: controller.signal,
      renewLease
    })).resolves.toEqual({
      action: "failed",
      reason: "platform_job_failed"
    });
    expect(manager.dispatchQueuedJob).toHaveBeenCalledWith("job-failed", expect.objectContaining({
      signal: controller.signal,
      leaseGuard: renewLease
    }));
  });

  it("completes the queue replay when the platform job already committed completion", async () => {
    const { port } = queueApplicationFixture();
    const manager = managerFixture();
    manager.dispatchQueuedJob.mockResolvedValue({
      completed: false,
      skipped: true,
      reason: "status_completed",
      job: { id: "job-completed", status: "completed" }
    });
    await createQueuedJobWorkflowProvider({
      jobManager: manager,
      queueApplicationPort: port,
      autoStart: false
    });
    const registration = port.registerQueue.mock.calls[0][0];
    await expect(registration.handler({
      workItem: {
        workItemId: "job-work:job-completed",
        payloadRef: { jobId: "job-completed" }
      }
    }, {
      lease: { leaseId: "lease-completed" },
      signal: new AbortController().signal,
      renewLease: vi.fn()
    })).resolves.toEqual({
      action: "completed",
      reason: "platform_job_already_completed"
    });
  });

  it("projects queue failure and expiry into the platform job terminal authority", async () => {
    const { port } = queueApplicationFixture();
    const manager = managerFixture();
    manager.failJobFromQueue.mockImplementation(async (jobId) => ({ id: jobId, status: "failed" }));
    await createQueuedJobWorkflowProvider({
      jobManager: manager,
      queueApplicationPort: port,
      autoStart: false
    });
    const registration = port.registerQueue.mock.calls[0][0];

    await registration.onTerminal({
      workItem: {
        workItemId: "job-work:job-failed-by-queue",
        state: "failed",
        payloadRef: { jobId: "job-failed-by-queue" }
      }
    });
    await registration.onTerminal({
      workItem: {
        workItemId: "job-work:job-expired-by-queue",
        state: "expired"
      }
    });

    expect(manager.failJobFromQueue).toHaveBeenNthCalledWith(1, "job-failed-by-queue", {
      stage: "队列执行失败",
      reason: "Queue work reached terminal failure."
    });
    expect(manager.failJobFromQueue).toHaveBeenNthCalledWith(2, "job-expired-by-queue", {
      stage: "队列任务已过期",
      reason: "Queue work expired before completion."
    });
  });
});
