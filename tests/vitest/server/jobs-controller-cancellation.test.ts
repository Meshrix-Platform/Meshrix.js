import { describe, expect, it, vi } from "vitest";

import { createJobHandlers } from "../../../packages/protocols/http/controllers/jobs-controller-job-handlers.ts";

function responseRecorder() : any {
  return {
    statusCode: 0,
    payload: null,
    writeHead(statusCode?: any) : any {
      this.statusCode = statusCode;
    },
    end(payload?: any) : any {
      this.payload = JSON.parse(payload);
    }
  };
}

function cancellationHandler(jobWorkflow?: any, protocolEventBus: any = null) : any {
  return createJobHandlers({
    userDataPath: "<user-data>",
    checkpointUploadSessionStore: {},
    jobWorkflow,
    deletionCoordinator: {},
    getDiscoveryState: () : any => ({}),
    proxyApiRequest: vi.fn(),
    protocolEventBus,
    resolveArchiveBatchIdentity: vi.fn()
  }).handleCancelJob;
}

describe("jobs controller cancellation", () : any => {
  it("cancels an accessible job and publishes the terminal projection", async () : Promise<any> => {
    const queued: Record<string, any> = { id: "job-cancel", status: "queued", ownerUserId: "user-a" };
    const cancelled: Record<string, any> = { ...queued, status: "cancelled" };
    const jobWorkflow: Record<string, any> = {
      getJob: vi.fn(async () : Promise<any> => queued),
      cancelJob: vi.fn(async () : Promise<any> => cancelled)
    };
    const protocolEventBus: Record<string, any> = { publish: vi.fn(async () : Promise<any> => null) };
    const response: any = responseRecorder();

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

  it("does not reveal or cancel a job owned by another caller", async () : Promise<any> => {
    const jobWorkflow: Record<string, any> = {
      getJob: vi.fn(async () : Promise<any> => ({ id: "job-private", status: "running", ownerUserId: "user-a" })),
      cancelJob: vi.fn()
    };
    const response: any = responseRecorder();

    await cancellationHandler(jobWorkflow)({
      jobId: "job-private",
      response,
      authSession: { user: { userId: "user-b" } }
    });

    expect(response.statusCode).toBe(403);
    expect(response.payload).toEqual({ error: "任务不存在或不可访问。" });
    expect(jobWorkflow.cancelJob).not.toHaveBeenCalled();
  });

  it("returns not found when no local job can be cancelled", async () : Promise<any> => {
    const jobWorkflow: Record<string, any> = {
      getJob: vi.fn(async () : Promise<any> => null),
      cancelJob: vi.fn(async () : Promise<any> => null)
    };
    const response: any = responseRecorder();

    await cancellationHandler(jobWorkflow)({
      jobId: "job-missing",
      response,
      authSession: null
    });

    expect(response.statusCode).toBe(404);
    expect(response.payload).toEqual({ error: "任务不存在。" });
  });
});
