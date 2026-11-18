import { beforeEach, describe, expect, it, vi } from "vitest";

const createJobManagerMock: any = vi.hoisted(() : any => vi.fn());
const createServerCompositionRootMock: any = vi.hoisted(() : any => vi.fn());
const getRuntimeLoggerMock: any = vi.hoisted(() : any => vi.fn());
const createQueuedJobWorkflowProviderMock: any = vi.hoisted(() : any => vi.fn());

vi.mock("../../../packages/server-runtime/src/jobs/jobs/job-manager.ts", () : any => ({
  createJobManager: createJobManagerMock
}));

vi.mock("../../../packages/server-runtime/src/composition/composition-root.ts", () : any => ({
  createServerCompositionRoot: createServerCompositionRootMock
}));

vi.mock("#meshrix/product-api", () : any => ({
  getRuntimeLogger: getRuntimeLoggerMock
}));

vi.mock("../../../packages/server-runtime/src/composition/queued-job-workflow-provider.ts", () : any => ({
  createQueuedJobWorkflowProvider: createQueuedJobWorkflowProviderMock
}));

import { createImportWorkerRuntime } from "../../../packages/server-runtime/src/composition/background-workers/import-worker.ts";

beforeEach(() : any => {
  vi.clearAllMocks();
});

describe("external import worker canonical queue", () : any => {
  it("runs the worker-owned canonical queue lifecycle and reports bounded job state", async () : Promise<any> => {
    const closeJobManager: any = vi.fn(async () : Promise<any> => undefined);
    const closeCompositionRoot: any = vi.fn(async () : Promise<any> => undefined);
    const closeProvider: any = vi.fn(async () : Promise<any> => undefined);
    const queueApplicationPort: Record<string, any> = {
      start: vi.fn(),
      stop: vi.fn(async () : Promise<any> => undefined),
      close: vi.fn(async () : Promise<any> => undefined)
    };
    const jobManager: Record<string, any> = { close: closeJobManager };
    const protocolEventBus: Record<string, any> = {};
    const storageProvider: Record<string, any> = {
      commitUploadConsumptionReceipt: vi.fn()
    };
    const uploadSessionStore: Record<string, any> = {
      resolveUploadSessionFiles: vi.fn()
    };
    const compositionRoot: Record<string, any> = {
      protocolEventBus,
      queueApplicationPort,
      storageProvider,
      uploadSessionStore,
      close: closeCompositionRoot
    };
    const provider: Record<string, any> = {
      listJobs: vi.fn(async () : Promise<any> => ({ summary: { queuedCount: 1 } })),
      close: closeProvider
    };
    const runtimeLogger: Record<string, any> = {};
    getRuntimeLoggerMock.mockReturnValue(runtimeLogger);
    createServerCompositionRootMock.mockResolvedValue(compositionRoot);
    createJobManagerMock.mockReturnValue(jobManager);
    createQueuedJobWorkflowProviderMock.mockResolvedValue(provider);

    const runtime: any = await createImportWorkerRuntime({ userDataPath: "/data" });

    expect(createServerCompositionRootMock).toHaveBeenCalledWith({
      userDataPath: "/data",
      runtimeLogger
    });
    expect(createJobManagerMock).toHaveBeenCalledWith({
      userDataPath: "/data",
      processingEnabled: true,
      protocolEventBus,
      storageProvider,
      uploadSessionStore
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
    expect(queueApplicationPort.close).not.toHaveBeenCalled();
    expect(closeJobManager).toHaveBeenCalledOnce();
    expect(closeCompositionRoot).toHaveBeenCalledOnce();
    expect(closeProvider.mock.invocationCallOrder[0]).toBeLessThan(closeJobManager.mock.invocationCallOrder[0]);
  });

  it("unwinds the workflow provider, root-owned queue, and manager when queue startup fails", async () : Promise<any> => {
    const queueApplicationPort: Record<string, any> = {
      start: vi.fn(() : any => {
        throw new Error("queue startup failed");
      }),
      stop: vi.fn(async () : Promise<any> => undefined)
    };
    const closeJobManager: any = vi.fn(async () : Promise<any> => undefined);
    const closeWorkflowProvider: any = vi.fn(async () : Promise<any> => undefined);
    const closeCompositionRoot: any = vi.fn(async () : Promise<any> => undefined);
    createServerCompositionRootMock.mockResolvedValue({
      protocolEventBus: {},
      queueApplicationPort,
      storageProvider: { commitUploadConsumptionReceipt: vi.fn() },
      uploadSessionStore: { resolveUploadSessionFiles: vi.fn() },
      close: closeCompositionRoot
    });
    createJobManagerMock.mockReturnValue({ close: closeJobManager });
    createQueuedJobWorkflowProviderMock.mockResolvedValue({
      close: closeWorkflowProvider
    });

    await expect(
      createImportWorkerRuntime({ userDataPath: "/data" })
    ).rejects.toThrow("queue startup failed");

    expect(queueApplicationPort.start).toHaveBeenCalledOnce();
    expect(queueApplicationPort.stop).toHaveBeenCalledOnce();
    expect(closeWorkflowProvider).toHaveBeenCalledOnce();
    expect(closeJobManager).toHaveBeenCalledOnce();
    expect(closeCompositionRoot).toHaveBeenCalledOnce();
  });
});
