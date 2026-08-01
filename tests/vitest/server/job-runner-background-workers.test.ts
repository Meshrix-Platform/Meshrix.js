import { beforeEach, describe, expect, it, vi } from "vitest";

const createJobPipelineMock: any = vi.hoisted(() : any => vi.fn());
const createServerRuntimeMock: any = vi.hoisted(() : any => vi.fn());

vi.mock("../../../packages/server-runtime/src/jobs/job-pipeline.ts", () : any => ({
  createJobPipeline: createJobPipelineMock
}));

vi.mock("#meshrix/product-api", () : any => ({
  createServerRuntime: createServerRuntimeMock
}));

import { runSplitJob } from "../../../packages/server-runtime/src/jobs/jobs/job-runner.ts";
import { createBackgroundWorkerRuntime } from "../../../packages/server-runtime/src/composition/background-workers/registry.ts";

beforeEach(() : any => {
  vi.clearAllMocks();
});

describe("job runner and background worker wrappers", () : any => {
  it("runs split jobs through the pipeline and closes runtime on success", async () : Promise<any> => {
    const storageProvider: Record<string, any> = {
      protocolVersion: "fixture-storage",
      putObjectsFromFiles: vi.fn()
    };
    const runtime: Record<string, any> = {
      storageProvider,
      close: vi.fn(async () : Promise<any> => undefined)
    };
    const context: Record<string, any> = { jobId: "job-1" };
    const pipeline: Record<string, any> = {
      createContext: vi.fn(() : any => context),
      run: vi.fn(async (input?: any) : Promise<any> => ({ ok: true, input }))
    };
    const onProgress: any = vi.fn();
    createServerRuntimeMock.mockResolvedValue(runtime);
    createJobPipelineMock.mockReturnValue(pipeline);
    const payload: Record<string, any> = {
      checkpointReceipt: {
        archiveBatchId: "receipt-archive",
        checkpointId: "checkpoint-1",
        manifestSha256: "manifest-1"
      },
      batchId: "batch-1",
      clientBatchId: "client-batch-1",
      inputDigest: "input-1"
    };

    await expect(runSplitJob("/data", payload, {
      jobId: "job-1",
      runtimeOptions: { featureFlags: { test: true } },
      onProgress
    })).resolves.toEqual({ ok: true, input: context });

    expect(createServerRuntimeMock).toHaveBeenCalledWith({
      userDataPath: "/data",
      runtimeOptions: { featureFlags: { test: true } }
    });
    expect(createJobPipelineMock).toHaveBeenCalledWith({
      userDataPath: "/data",
      payload,
      runtime,
      storageProvider,
      reportProgress: onProgress,
      jobId: "job-1",
      generatedAt: expect.any(String),
      signal: null
    });
    expect(pipeline.createContext).toHaveBeenCalledOnce();
    expect(pipeline.run).toHaveBeenCalledWith(context);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("still closes runtime when the pipeline throws", async () : Promise<any> => {
    const error: any = new Error("pipeline failed");
    const runtime: Record<string, any> = {
      storageProvider: {
        protocolVersion: "fixture-storage",
        putObjectsFromFiles: vi.fn()
      },
      close: vi.fn(async () : Promise<any> => undefined)
    };
    createServerRuntimeMock.mockResolvedValue(runtime);
    createJobPipelineMock.mockReturnValue({
      createContext: vi.fn(() : any => ({ jobId: "job-error" })),
      run: vi.fn(async () : Promise<any> => {
        throw error;
      })
    });
    await expect(runSplitJob("/data", {
      checkpoint: {
        batchId: "",
        clientBatchId: "",
        checkpointId: "",
        manifestDigest: ""
      }
    }, {
      jobId: "job-error",
      batchId: "batch-fallback"
    })).rejects.toThrow("pipeline failed");

    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("cancels the admission delay and closes the runtime before pipeline mutations", async () : Promise<any> => {
    const runtime: Record<string, any> = {
      storageProvider: {
        protocolVersion: "fixture-storage",
        putObjectsFromFiles: vi.fn()
      },
      close: vi.fn(async () : Promise<any> => undefined)
    };
    createServerRuntimeMock.mockResolvedValue(runtime);
    const controller: any = new AbortController();
    const execution: any = runSplitJob("/data", { settings: {} }, {
      jobId: "job-cancelled",
      runtimeOptions: { testHooks: { jobDelayMs: 10_000 } },
      signal: controller.signal
    });

    controller.abort(new Error("queue lease lost"));

    await expect(execution).rejects.toThrow("queue lease lost");
    expect(createJobPipelineMock).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("creates standby agent worker runtime and rejects unknown worker roles", async () : Promise<any> => {
    const runtime: any = await createBackgroundWorkerRuntime({
      role: "agent-worker",
      userDataPath: "/data"
    });

    expect(runtime.mode).toBe("standby");
    await expect(runtime.tick()).resolves.toEqual({
      status: "standby",
      details: {
        mode: "supervised_process_ready",
        note: "该后台角色由守护进程按需托管；智能体是否可用以模型库配置和探测状态为准。"
      }
    });
    await expect(runtime.close()).resolves.toBeUndefined();
    await expect(createBackgroundWorkerRuntime({
      role: "missing-worker",
      userDataPath: "/data"
    })).rejects.toThrow("Unknown background worker role: missing-worker");
  });
});
