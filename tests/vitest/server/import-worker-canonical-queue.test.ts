import { beforeEach, describe, expect, it, vi } from "vitest";

const createJobManagerMock: any = vi.hoisted(() : any => vi.fn());
const createProtocolEventRuntimeMock: any = vi.hoisted(() : any => vi.fn());
const createQueuedJobWorkflowProviderMock: any = vi.hoisted(() : any => vi.fn());
const createQueueApplicationPortMock: any = vi.hoisted(() : any => vi.fn());

vi.mock("../../../packages/server-runtime/src/jobs/jobs/job-manager.ts", () : any => ({
  createJobManager: createJobManagerMock
}));

vi.mock("../../../packages/server-runtime/src/events/protocol-event-runtime.ts", () : any => ({
  createProtocolEventRuntime: createProtocolEventRuntimeMock
}));

vi.mock("../../../packages/server-runtime/src/composition/queued-job-workflow-provider.ts", () : any => ({
  createQueuedJobWorkflowProvider: createQueuedJobWorkflowProviderMock
}));

vi.mock("../../../packages/server-runtime/src/composition/queue-application-port.ts", () : any => ({
  createQueueApplicationPort: createQueueApplicationPortMock
}));

import { createImportWorkerRuntime } from "../../../packages/server-runtime/src/composition/background-workers/import-worker.ts";

beforeEach(() : any => {
  vi.clearAllMocks();
});

describe("external import worker canonical queue", () : any => {
  it("runs the worker-owned canonical queue lifecycle and reports bounded job state", async () : Promise<any> => {
    const closeJobManager: any = vi.fn(async () : Promise<any> => undefined);
    const closeEventRuntime: any = vi.fn(async () : Promise<any> => undefined);
    const closeProvider: any = vi.fn(async () : Promise<any> => undefined);
    const queueApplicationPort: Record<string, any> = {
      start: vi.fn(),
      stop: vi.fn(async () : Promise<any> => undefined),
      close: vi.fn(async () : Promise<any> => undefined)
    };
    const jobManager: Record<string, any> = { close: closeJobManager };
    const protocolEventBus: Record<string, any> = {};
    const protocolEventRuntime: Record<string, any> = {
      protocolEventBus,
      close: closeEventRuntime
    };
    const provider: Record<string, any> = {
      listJobs: vi.fn(async () : Promise<any> => ({ summary: { queuedCount: 1 } })),
      close: closeProvider
    };
    createProtocolEventRuntimeMock.mockResolvedValue(protocolEventRuntime);
    createJobManagerMock.mockReturnValue(jobManager);
    createQueueApplicationPortMock.mockResolvedValue(queueApplicationPort);
    createQueuedJobWorkflowProviderMock.mockResolvedValue(provider);

    const runtime: any = await createImportWorkerRuntime({ userDataPath: "/data" });

    expect(createJobManagerMock).toHaveBeenCalledWith({
      userDataPath: "/data",
      processingEnabled: true,
      protocolEventBus
    });
    expect(createQueuedJobWorkflowProviderMock).toHaveBeenCalledWith({
      jobManager,
      queueApplicationPort,
      autoStart: true
    });
    expect(queueApplicationPort.start).toHaveBeenCalledOnce();
    await expect(runtime.tick()).resolves.toEqual({
      status: "running",
      details: {
        mode: "external_import_queue_worker",
        jobs: { queuedCount: 1 }
      }
    });
    await runtime.close();
    expect(closeProvider).toHaveBeenCalledOnce();
    expect(queueApplicationPort.stop).toHaveBeenCalledOnce();
    expect(queueApplicationPort.close).toHaveBeenCalledOnce();
    expect(closeJobManager).toHaveBeenCalledOnce();
    expect(closeEventRuntime).toHaveBeenCalledOnce();
    expect(closeProvider.mock.invocationCallOrder[0]).toBeLessThan(closeJobManager.mock.invocationCallOrder[0]);
  });
});
