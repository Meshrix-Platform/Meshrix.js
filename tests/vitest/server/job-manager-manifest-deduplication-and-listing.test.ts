import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const loggerMock: any = vi.hoisted(() : any => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}));

const durableWorkflowRuntimeMock: any = vi.hoisted(() : any => ({
  startWorkflow: vi.fn(async () : Promise<any> => null),
  recoverWorkflow: vi.fn(async () : Promise<any> => null),
  scheduleActivity: vi.fn(async () : Promise<any> => null),
  startActivity: vi.fn(async () : Promise<any> => null),
  completeActivity: vi.fn(async () : Promise<any> => null),
  failActivity: vi.fn(async () : Promise<any> => null),
  failWorkflow: vi.fn(async () : Promise<any> => null),
  completeWorkflow: vi.fn(async () : Promise<any> => null),
  recordSignal: vi.fn(async () : Promise<any> => null),
  heartbeatActivity: vi.fn(async () : Promise<any> => null),
  getWorkflow: vi.fn(async () : Promise<any> => null),
  listWorkflows: vi.fn(async () : Promise<any> => ({ items: [] }))
}));

vi.mock("#meshrix/product-api", async () : Promise<any> => {
  const actual: any = await vi.importActual("#meshrix/product-api");
  return {
    ...actual,
    createDurableWorkflowSubstrate: vi.fn(() : any => durableWorkflowRuntimeMock),
    deleteCheckpointTree: vi.fn(async () : Promise<any> => null),
    finishCheckpointTree: vi.fn(async () : Promise<any> => null),
    getRuntimeLogger: vi.fn(() : any => loggerMock),
    removeImportCheckpoint: vi.fn(async () : Promise<any> => null),
    startCheckpointTree: vi.fn(async () : Promise<any> => null),
    summarizeError: vi.fn((error?: any) : any => error?.message || String(error || "")),
    summarizeForLog: vi.fn((value?: any) : any => value),
    traceDetails: vi.fn(() : any => ({ traceId: "unit-trace" })),
    upsertCheckpointNode: vi.fn(async () : Promise<any> => null)
  };
});

import { createTestJobManager } from "./job-manager-test-harness.ts";
import { createJobProjectionStore } from "../../../packages/server-runtime/src/jobs/jobs/job-projection-store.ts";
import { serverToken } from "#meshrix/product-api";

async function withTempUserData(callback?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-job-manager-focused-extra-"));
  try {
    return await callback(userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

function createEventBusSpy() : any {
  return {
    publish: vi.fn(async () : Promise<any> => null)
  };
}

async function seedPersistedJob(userDataPath?: any, jobId?: any, meta?: any, result: any = null) : Promise<any> {
  const currentMeta: Record<string, any> = {
    ...meta,
    versionGroupId: meta.versionGroupId || serverToken(
      "parse_version_group",
      meta.checkpointId || meta.archiveBatchId || meta.id
    ),
    versionNumber: meta.versionNumber || 1
  };
  const projectionStore: any = createJobProjectionStore({ userDataPath });
  projectionStore.importJob(currentMeta);
  projectionStore.close();
  const jobDir: any = path.join(userDataPath, "jobs", jobId);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "meta.json"), JSON.stringify(currentMeta), "utf8");
  if (result !== null) {
    await fs.writeFile(path.join(jobDir, "result.json"), JSON.stringify({
      format: "meshrix.job-terminal",
      schema: "job-terminal-envelope",
      job: currentMeta,
      result
    }), "utf8");
  }
}

describe("job manager behavior", () : any => {
  beforeEach(() : any => {
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();
    durableWorkflowRuntimeMock.startWorkflow.mockClear();
    durableWorkflowRuntimeMock.recoverWorkflow.mockClear();
    durableWorkflowRuntimeMock.scheduleActivity.mockClear();
    durableWorkflowRuntimeMock.startActivity.mockClear();
    durableWorkflowRuntimeMock.completeActivity.mockClear();
    durableWorkflowRuntimeMock.failActivity.mockClear();
    durableWorkflowRuntimeMock.failWorkflow.mockClear();
    durableWorkflowRuntimeMock.completeWorkflow.mockClear();
    durableWorkflowRuntimeMock.recordSignal.mockClear();
    durableWorkflowRuntimeMock.heartbeatActivity.mockClear();
    durableWorkflowRuntimeMock.getWorkflow.mockClear();
    durableWorkflowRuntimeMock.listWorkflows.mockClear();
  });

  it("会按 manifest 归属复用活动任务，并把第二个 checkpoint 也指向同一任务", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const protocolEventBus: any = createEventBusSpy();
      const archiveBatchId: any = "archive-batch-1";
      const manifestSha256: any = "a".repeat(64);
      const firstCheckpoint: any = "manifest-checkpoint-a";
      const secondCheckpoint: any = "manifest-checkpoint-b";

      const manager: any = createTestJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: false
      });

      const first: any = await manager.createJob({
        checkpointId: firstCheckpoint,
        checkpointReceipt: {
          archiveBatchId,
          checkpointId: firstCheckpoint,
          manifestSha256
        },
        inputText: "first manifest job"
      });
      const reused: any = await manager.createJob({
        checkpointId: secondCheckpoint,
        checkpointReceipt: {
          archiveBatchId,
          checkpointId: secondCheckpoint,
          manifestSha256
        },
        inputText: "second manifest job"
      });

      const byFirstCheckpoint: any = await manager.getJobByCheckpointId(firstCheckpoint);
      const bySecondCheckpoint: any = await manager.getJobByCheckpointId({ checkpointId: secondCheckpoint });

      expect(reused.id).toBe(first.id);
      expect(reused.checkpointId).toBe(serverToken("checkpoint", firstCheckpoint));
      expect(byFirstCheckpoint?.id).toBe(first.id);
      expect(bySecondCheckpoint?.id).toBe(first.id);
      expect(protocolEventBus.publish.mock.calls.map((call?: any) : any => call?.[2]?.type)).toEqual(
        expect.arrayContaining(["jobs.job.created", "jobs.job.reused"])
      );
    });
  });

  it("会对 listJobs 的 limit 做夹紧，并按创建时间倒序返回状态统计与 checkpoint 查询", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const completedId: any = "job-completed";
      const failedId: any = "job-failed";
      const runningId: any = "job-running";
      const queuedId: any = "job-queued";

      await seedPersistedJob(userDataPath, queuedId, {
        id: queuedId,
        status: "queued",
        createdAt: "2026-07-22T09:00:00.000Z",
        updatedAt: "2026-07-22T09:00:00.000Z",
        checkpointId: serverToken("checkpoint", queuedId)
      });
      await seedPersistedJob(userDataPath, runningId, {
        id: runningId,
        status: "running",
        createdAt: "2026-07-22T09:01:00.000Z",
        updatedAt: "2026-07-22T09:01:30.000Z",
        checkpointId: serverToken("checkpoint", runningId)
      });
      await seedPersistedJob(userDataPath, failedId, {
        id: failedId,
        status: "failed",
        createdAt: "2026-07-22T09:02:00.000Z",
        updatedAt: "2026-07-22T09:02:30.000Z",
        checkpointId: serverToken("checkpoint", failedId)
      });
      await seedPersistedJob(userDataPath, completedId, {
        id: completedId,
        status: "completed",
        createdAt: "2026-07-22T09:03:00.000Z",
        updatedAt: "2026-07-22T09:03:30.000Z",
        checkpointId: serverToken("checkpoint", completedId)
      });

      const manager: any = createTestJobManager({
        userDataPath,
        processingEnabled: false
      });

      const lowLimit: any = await manager.listJobs({ limit: -5 });
      const highLimit: any = await manager.listJobs({ limit: 999 });
      const runningLookup: any = await manager.getJobByCheckpointId({
        checkpointReceipt: {
          checkpointId: runningId
        }
      });

      expect(lowLimit.items).toHaveLength(1);
      expect(lowLimit.items[0].id).toBe(completedId);
      expect(highLimit.items.map((job?: any) : any => job.id)).toEqual([
        completedId,
        failedId,
        runningId,
        queuedId
      ]);
      expect(highLimit.summary).toMatchObject({
        totalCount: 4,
        queuedCount: 1,
        runningCount: 1,
        completedCount: 1,
        failedCount: 1,
        processingMode: "external",
        workerConcurrency: 0
      });
      expect(runningLookup).toMatchObject({
        id: runningId,
        checkpointId: serverToken("checkpoint", runningId)
      });
    });
  });

  it("会读取已完成任务的结果，并在删除 completed 任务时不走失败流程", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const protocolEventBus: any = createEventBusSpy();
      const jobId: any = "completed-result-job";
      const result: Record<string, any> = {
        emails: [{ email: "a@example.com", confidence: 0.9 }],
        transactions: [{ id: "t-1" }],
        people: [{ name: "Alice" }],
        warnings: [{ code: "w-1" }]
      };

      await seedPersistedJob(
        userDataPath,
        jobId,
        {
          id: jobId,
          status: "completed",
          createdAt: "2026-07-22T10:00:00.000Z",
          updatedAt: "2026-07-22T10:01:00.000Z",
          finishedAt: "2026-07-22T10:01:00.000Z",
          checkpointId: serverToken("checkpoint", jobId)
        },
        result
      );

      const manager: any = createTestJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: false
      });

      const loadedResult: any = await manager.getJobResult(jobId);
      const deleted: any = await manager.deleteJob(jobId);
      const afterDelete: any = await manager.getJob(jobId);

      expect(loadedResult).toEqual(result);
      expect(deleted).toMatchObject({
        id: jobId,
        status: "completed",
        checkpointId: serverToken("checkpoint", jobId)
      });
      expect(afterDelete).toBeNull();
      expect(durableWorkflowRuntimeMock.failWorkflow).not.toHaveBeenCalled();
      expect(protocolEventBus.publish.mock.calls.map((call?: any) : any => call?.[2]?.type)).toContain(
        "jobs.deleted"
      );
      await expect(fs.stat(path.join(userDataPath, "jobs", jobId))).rejects.toThrow();
    });
  });

  it("会在关闭后拒绝新任务", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const manager: any = createTestJobManager({
        userDataPath,
        processingEnabled: true
      });

      await manager.close();

      await expect(
        manager.createJob({
          checkpointId: "closed-checkpoint",
          inputText: "should fail after close"
        })
      ).rejects.toThrow("后台任务管理器已经关闭。");

    });
  });
});
