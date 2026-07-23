import { beforeEach, describe, expect, it, vi } from "vitest";

const createJobManagerMock = vi.hoisted(() => vi.fn());
const createProtocolEventRuntimeMock = vi.hoisted(() => vi.fn());
const createQueuedJobWorkflowProviderMock = vi.hoisted(() => vi.fn());
const createQueueApplicationPortMock = vi.hoisted(() => vi.fn());

vi.mock("../../../packages/server-runtime/src/jobs/jobs/job-manager.mjs", () => ({
  createJobManager: createJobManagerMock
}));

vi.mock("../../../packages/server-runtime/src/events/protocol-event-runtime.mjs", () => ({
  createProtocolEventRuntime: createProtocolEventRuntimeMock
}));

vi.mock("../../../packages/server-runtime/src/composition/queued-job-workflow-provider.mjs", () => ({
  createQueuedJobWorkflowProvider: createQueuedJobWorkflowProviderMock
}));

vi.mock("../../../packages/server-runtime/src/composition/queue-application-port.mjs", () => ({
  createQueueApplicationPort: createQueueApplicationPortMock
}));

import { createImportWorkerRuntime } from "../../../packages/server-runtime/src/composition/background-workers/import-worker.mjs";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("external import worker canonical queue", () => {
  it("runs the worker-owned canonical queue lifecycle and reports bounded job state", async () => {
    const closeJobManager = vi.fn(async () => undefined);
    const closeEventRuntime = vi.fn(async () => undefined);
    const closeProvider = vi.fn(async () => undefined);
    const queueApplicationPort = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    };
    const jobManager = { close: closeJobManager };
    const protocolEventBus = {};
    const protocolEventRuntime = {
      protocolEventBus,
      close: closeEventRuntime
    };
    const provider = {
      listJobs: vi.fn(async () => ({ summary: { queuedCount: 1 } })),
      close: closeProvider
    };
    createProtocolEventRuntimeMock.mockResolvedValue(protocolEventRuntime);
    createJobManagerMock.mockReturnValue(jobManager);
    createQueueApplicationPortMock.mockResolvedValue(queueApplicationPort);
    createQueuedJobWorkflowProviderMock.mockResolvedValue(provider);

    const runtime = await createImportWorkerRuntime({ userDataPath: "/data" });

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
