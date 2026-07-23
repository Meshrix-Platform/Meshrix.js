import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}));

const durableWorkflowRuntimeMock = vi.hoisted(() => ({
  startWorkflow: vi.fn(async () => null),
  recoverWorkflow: vi.fn(async () => null),
  scheduleActivity: vi.fn(async () => null),
  startActivity: vi.fn(async () => null),
  completeActivity: vi.fn(async () => null),
  failActivity: vi.fn(async () => null),
  failWorkflow: vi.fn(async () => null),
  completeWorkflow: vi.fn(async () => null),
  recordSignal: vi.fn(async () => null),
  heartbeatActivity: vi.fn(async () => null),
  getWorkflow: vi.fn(async () => null),
  listWorkflows: vi.fn(async () => ({ items: [] }))
}));

vi.mock("#lico/product-api", async () => {
  const actual = await vi.importActual("#lico/product-api");
  return {
    ...actual,
    createDurableWorkflowSubstrate: vi.fn(() => durableWorkflowRuntimeMock),
    deleteCheckpointTree: vi.fn(async () => null),
    finishCheckpointTree: vi.fn(async () => null),
    getRuntimeLogger: vi.fn(() => loggerMock),
    removeImportCheckpoint: vi.fn(async () => null),
    startCheckpointTree: vi.fn(async () => null),
    summarizeError: vi.fn((error) => error?.message || String(error || "")),
    summarizeForLog: vi.fn((value) => value),
    traceDetails: vi.fn(() => ({ traceId: "unit-trace" })),
    upsertCheckpointNode: vi.fn(async () => null)
  };
});

import { createJobManager } from "../../../packages/server-runtime/src/jobs/jobs/job-manager.mjs";
import { serverToken } from "#lico/product-api";

async function withTempUserData(callback) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-job-manager-focused-extra-"));
  try {
    return await callback(userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

function createEventBusSpy() {
  return {
    publish: vi.fn(async () => null)
  };
}

async function seedPersistedJob(userDataPath, jobId, meta, result = null) {
  const jobDir = path.join(userDataPath, "jobs", jobId);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "meta.json"), JSON.stringify(meta), "utf8");
  if (result !== null) {
    await fs.writeFile(path.join(jobDir, "result.json"), JSON.stringify({
      format: "lico.job-terminal",
      schema: "job-terminal-envelope",
      job: meta,
      result
    }), "utf8");
  }
}

describe("job manager behavior", () => {
  beforeEach(() => {
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

  it("会按 manifest 归属复用活动任务，并把第二个 checkpoint 也指向同一任务", async () => {
    await withTempUserData(async (userDataPath) => {
      const protocolEventBus = createEventBusSpy();
      const archiveBatchId = "archive-batch-1";
      const manifestSha256 = "a".repeat(64);
      const firstCheckpoint = "manifest-checkpoint-a";
      const secondCheckpoint = "manifest-checkpoint-b";

      const manager = createJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: false
      });

      const first = await manager.createJob({
        checkpointId: firstCheckpoint,
        checkpointReceipt: {
          archiveBatchId,
          checkpointId: firstCheckpoint,
          manifestSha256
        },
        inputText: "first manifest job"
      });
      const reused = await manager.createJob({
        checkpointId: secondCheckpoint,
        checkpointReceipt: {
          archiveBatchId,
          checkpointId: secondCheckpoint,
          manifestSha256
        },
        inputText: "second manifest job"
      });

      const byFirstCheckpoint = await manager.getJobByCheckpointId(firstCheckpoint);
      const bySecondCheckpoint = await manager.getJobByCheckpointId({ checkpointId: secondCheckpoint });

      expect(reused.id).toBe(first.id);
      expect(reused.checkpointId).toBe(serverToken("checkpoint", firstCheckpoint));
      expect(byFirstCheckpoint?.id).toBe(first.id);
      expect(bySecondCheckpoint?.id).toBe(first.id);
      expect(protocolEventBus.publish.mock.calls.map((call) => call?.[2]?.type)).toEqual(
        expect.arrayContaining(["jobs.job.created", "jobs.job.reused"])
      );
    });
  });

  it("会对 listJobs 的 limit 做夹紧，并按创建时间倒序返回状态统计与 checkpoint 查询", async () => {
    await withTempUserData(async (userDataPath) => {
      const completedId = "job-completed";
      const failedId = "job-failed";
      const runningId = "job-running";
      const queuedId = "job-queued";

      await seedPersistedJob(userDataPath, queuedId, {
        id: queuedId,
        status: "queued",
        createdAt: "2026-06-05T09:00:00.000Z",
        updatedAt: "2026-06-05T09:00:00.000Z",
        checkpointId: serverToken("checkpoint", queuedId)
      });
      await seedPersistedJob(userDataPath, runningId, {
        id: runningId,
        status: "running",
        createdAt: "2026-06-05T09:01:00.000Z",
        updatedAt: "2026-06-05T09:01:30.000Z",
        checkpointId: serverToken("checkpoint", runningId)
      });
      await seedPersistedJob(userDataPath, failedId, {
        id: failedId,
        status: "failed",
        createdAt: "2026-06-05T09:02:00.000Z",
        updatedAt: "2026-06-05T09:02:30.000Z",
        checkpointId: serverToken("checkpoint", failedId)
      });
      await seedPersistedJob(userDataPath, completedId, {
        id: completedId,
        status: "completed",
        createdAt: "2026-06-05T09:03:00.000Z",
        updatedAt: "2026-06-05T09:03:30.000Z",
        checkpointId: serverToken("checkpoint", completedId)
      });

      const manager = createJobManager({
        userDataPath,
        processingEnabled: false
      });

      const lowLimit = await manager.listJobs({ limit: -5 });
      const highLimit = await manager.listJobs({ limit: 999 });
      const runningLookup = await manager.getJobByCheckpointId({
        checkpointReceipt: {
          checkpointId: runningId
        }
      });

      expect(lowLimit.items).toHaveLength(1);
      expect(lowLimit.items[0].id).toBe(completedId);
      expect(highLimit.items.map((job) => job.id)).toEqual([
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

  it("会读取已完成任务的结果，并在删除 completed 任务时不走失败流程", async () => {
    await withTempUserData(async (userDataPath) => {
      const protocolEventBus = createEventBusSpy();
      const jobId = "completed-result-job";
      const result = {
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
          createdAt: "2026-06-05T10:00:00.000Z",
          updatedAt: "2026-06-05T10:01:00.000Z",
          finishedAt: "2026-06-05T10:01:00.000Z",
          checkpointId: serverToken("checkpoint", jobId)
        },
        result
      );

      const manager = createJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: false
      });

      const loadedResult = await manager.getJobResult(jobId);
      const deleted = await manager.deleteJob(jobId);
      const afterDelete = await manager.getJob(jobId);

      expect(loadedResult).toEqual(result);
      expect(deleted).toMatchObject({
        id: jobId,
        status: "completed",
        checkpointId: serverToken("checkpoint", jobId)
      });
      expect(afterDelete).toBeNull();
      expect(durableWorkflowRuntimeMock.failWorkflow).not.toHaveBeenCalled();
      expect(protocolEventBus.publish.mock.calls.map((call) => call?.[2]?.type)).toContain(
        "jobs.deleted"
      );
      await expect(fs.stat(path.join(userDataPath, "jobs", jobId))).rejects.toThrow();
    });
  });

  it("会在关闭后拒绝新任务", async () => {
    await withTempUserData(async (userDataPath) => {
      const manager = createJobManager({
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
