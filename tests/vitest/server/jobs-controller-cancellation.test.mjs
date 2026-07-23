import { describe, expect, it, vi } from "vitest";

import { createJobHandlers } from "../../../packages/protocols/http/controllers/jobs-controller-job-handlers.mjs";

function responseRecorder() {
  return {
    statusCode: 0,
    payload: null,
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(payload) {
      this.payload = JSON.parse(payload);
    }
  };
}

function cancellationHandler(jobWorkflow, protocolEventBus = null) {
  return createJobHandlers({
    userDataPath: "<user-data>",
    checkpointUploadSessionStore: {},
    jobWorkflow,
    deletionCoordinator: {},
    getDiscoveryState: () => ({}),
    proxyApiRequest: vi.fn(),
    protocolEventBus,
    resolveArchiveBatchIdentity: vi.fn()
  }).handleCancelJob;
}

describe("jobs controller cancellation", () => {
  it("cancels an accessible job and publishes the terminal projection", async () => {
    const queued = { id: "job-cancel", status: "queued", ownerUserId: "user-a" };
    const cancelled = { ...queued, status: "cancelled" };
    const jobWorkflow = {
      getJob: vi.fn(async () => queued),
      cancelJob: vi.fn(async () => cancelled)
    };
    const protocolEventBus = { publish: vi.fn(async () => null) };
    const response = responseRecorder();

    await cancellationHandler(jobWorkflow, protocolEventBus)({
      jobId: queued.id,
      response,
      authSession: { user: { userId: "user-a" } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual(cancelled);
    expect(jobWorkflow.cancelJob).toHaveBeenCalledWith(queued.id);
    expect(protocolEventBus.publish).toHaveBeenCalledWith(
      "jobs.job",
      { job: cancelled },
      { type: "jobs.job.cancelled" }
    );
  });

  it("does not reveal or cancel a job owned by another caller", async () => {
    const jobWorkflow = {
      getJob: vi.fn(async () => ({ id: "job-private", status: "running", ownerUserId: "user-a" })),
      cancelJob: vi.fn()
    };
    const response = responseRecorder();

    await cancellationHandler(jobWorkflow)({
      jobId: "job-private",
      response,
      authSession: { user: { userId: "user-b" } }
    });

    expect(response.statusCode).toBe(403);
    expect(response.payload).toEqual({ error: "任务不存在或不可访问。" });
    expect(jobWorkflow.cancelJob).not.toHaveBeenCalled();
  });

  it("returns not found when no local job can be cancelled", async () => {
    const jobWorkflow = {
      getJob: vi.fn(async () => null),
      cancelJob: vi.fn(async () => null)
    };
    const response = responseRecorder();

    await cancellationHandler(jobWorkflow)({
      jobId: "job-missing",
      response,
      authSession: null
    });

    expect(response.statusCode).toBe(404);
    expect(response.payload).toEqual({ error: "任务不存在。" });
  });
});
