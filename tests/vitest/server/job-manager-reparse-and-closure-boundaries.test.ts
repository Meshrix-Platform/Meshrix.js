import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const executionShouldThrow: any = vi.hoisted(() : any => ({ value: false }));

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

vi.mock("../../../packages/server-runtime/src/jobs/jobs/job-runner.ts", () : any => {
  return {
    runSplitJob: vi.fn(async (_userDataPath?: any, _payload?: any, options: Record<string, any> = {}) : Promise<any> => {
      if (executionShouldThrow.value) {
        throw new Error("mock execution start failure");
      }
      return new Promise((resolve?: any, reject?: any) : any => {
        options.signal?.addEventListener?.("abort", () : any => {
          reject(options.signal.reason || new Error("cancelled"));
        }, { once: true });
      });
    })
  };
});

vi.mock("#meshrix/product-api", async () : Promise<any> => {
  const actual: any = await vi.importActual("#meshrix/product-api");
  return {
    ...actual,
    createDurableWorkflowSubstrate: vi.fn(() : any => durableWorkflowRuntimeMock),
    getRuntimeLogger: vi.fn(() : any => loggerMock),
    removeImportCheckpoint: vi.fn(async () : Promise<any> => null),
    summarizeError: vi.fn((error?: any) : any => error?.message || String(error || "")),
    summarizeForLog: vi.fn((value?: any) : any => value),
    traceDetails: vi.fn(() : any => ({ traceId: "unit-trace" }))
  };
});

import { createJobProjectionStore } from "../../../packages/server-runtime/src/jobs/jobs/job-projection-store.ts";
import { serverToken } from "#meshrix/product-api";
import { createTestJobManager } from "./job-manager-test-harness.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXTURE_DAY_START_MS = Math.floor(Date.now() / DAY_MS) * DAY_MS;

function retainedFixtureTimestamps(meta?: any) : any {
  const current: Record<string, any> = { ...meta };
  for (const key of ["createdAt", "updatedAt", "startedAt", "finishedAt"]) {
    const parsed: any = Date.parse(String(current[key] || ""));
    if (!Number.isFinite(parsed)) continue;
    current[key] = new Date(FIXTURE_DAY_START_MS + ((parsed % DAY_MS) + DAY_MS) % DAY_MS).toISOString();
  }
  return current;
}

async function withTempUserData(callback?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-job-manager-final-extra-"));
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

async function waitForJobStatus(manager?: any, jobId?: any, status?: any, timeoutMs: any = 4000) : Promise<any> {
  const end: any = Date.now() + timeoutMs;

  while (Date.now() < end) {
    const job: any = await manager.getJob(jobId);
    if (job && job.status === status) {
      return job;
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, 25));
  }

  return null;
}

async function seedPersistedJob(userDataPath?: any, jobId?: any, meta?: any, payload: any = null) : Promise<any> {
  const currentMeta: Record<string, any> = {
    ...retainedFixtureTimestamps(meta),
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
  if (payload !== null) {
    await fs.writeFile(path.join(jobDir, "payload.json"), JSON.stringify(payload), "utf8");
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
    executionShouldThrow.value = false;
  });

  it("会在读取持久化 queued 任务时补齐派生字段，并保留队列状态与 checkpoint 查询", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const jobId: any = "persisted-queued-job";
      const checkpointId: any = serverToken("checkpoint", "persisted-queued-checkpoint");

      await seedPersistedJob(userDataPath, jobId, {
        id: jobId,
        status: "queued",
        createdAt: "2026-06-05T08:00:00.000Z",
        updatedAt: "2026-06-05T08:00:00.000Z",
        progressPercent: 12,
        stage: "等待执行",
        checkpointId
      });

      const manager: any = createTestJobManager({
        userDataPath,
        processingEnabled: false
      });

      const job: any = await manager.getJob(jobId);
      const byCheckpoint: any = await manager.getJobByCheckpointId(checkpointId);
      const listed: any = await manager.listJobs({ limit: 0 });
      const meta: any = JSON.parse(await fs.readFile(path.join(userDataPath, "jobs", jobId, "meta.json"), "utf8"));

      expect(job).toMatchObject({ id: jobId, status: "queued", checkpointId });
      expect(job?.archiveBatchId).toEqual(expect.any(String));
      expect(job?.checkpointTreeId).toEqual(expect.any(String));
      expect(job?.workflowId).toEqual(expect.any(String));
      expect(byCheckpoint).toMatchObject({ id: jobId, checkpointId });
      expect(listed.items).toHaveLength(1);
      expect(listed.summary).toMatchObject({
        totalCount: 1,
        queuedCount: 1,
        runningCount: 0,
        completedCount: 0,
        failedCount: 0,
        processingMode: "external",
        workerConcurrency: 0
      });
      expect(meta).toMatchObject({
        id: jobId,
        checkpointId
      });
      expect(meta.archiveBatchId).toEqual(expect.any(String));
      expect(meta.checkpointTreeId).toEqual(expect.any(String));
      expect(meta.workflowId).toEqual(expect.any(String));
    });
  });

  it("会聚合多种任务状态、复用已有 checkpoint，并在取消后发布删除事件", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const protocolEventBus: any = createEventBusSpy();
      const queuedCheckpoint: any = serverToken("checkpoint", "persisted-queued-reuse");

      await seedPersistedJob(userDataPath, "persisted-running-job", {
        id: "persisted-running-job",
        status: "running",
        createdAt: "2026-07-22T08:10:00.000Z",
        updatedAt: "2026-07-22T08:10:05.000Z",
        startedAt: "2026-07-22T08:10:01.000Z",
        progressPercent: 41,
        stage: "执行中",
        checkpointId: serverToken("checkpoint", "persisted-running-job")
      });
      await seedPersistedJob(userDataPath, "persisted-completed-job", {
        id: "persisted-completed-job",
        status: "completed",
        createdAt: "2026-07-22T08:09:00.000Z",
        updatedAt: "2026-07-22T08:09:45.000Z",
        startedAt: "2026-07-22T08:09:10.000Z",
        finishedAt: "2026-07-22T08:09:45.000Z",
        progressPercent: 100,
        stage: "任务已完成",
        checkpointId: serverToken("checkpoint", "persisted-completed-job")
      });
      await seedPersistedJob(userDataPath, "persisted-failed-job", {
        id: "persisted-failed-job",
        status: "failed",
        createdAt: "2026-07-22T08:08:00.000Z",
        updatedAt: "2026-07-22T08:08:20.000Z",
        startedAt: "2026-07-22T08:08:05.000Z",
        finishedAt: "2026-07-22T08:08:20.000Z",
        progressPercent: 18,
        stage: "执行失败",
        error: "历史任务失败",
        checkpointId: serverToken("checkpoint", "persisted-failed-job")
      });
      await seedPersistedJob(userDataPath, "persisted-queued-job", {
        id: "persisted-queued-job",
        status: "queued",
        createdAt: "2026-07-22T08:07:00.000Z",
        updatedAt: "2026-07-22T08:07:00.000Z",
        progressPercent: 0,
        stage: "等待执行",
        checkpointId: queuedCheckpoint
      });

      const manager: any = createTestJobManager({
        userDataPath,
        processingEnabled: false,
        protocolEventBus
      });

      const created: any = await manager.createJob({
        checkpointReceipt: {
          checkpointId: "fresh-created"
        },
        checkpointId: "fresh-created",
        inputText: "new work item"
      });
      const reused: any = await manager.createJob({
        checkpointReceipt: {
          checkpointId: "fresh-created"
        },
        checkpointId: "fresh-created",
        inputText: "new work item"
      });
      const listedBeforeDelete: any = await manager.listJobs({ limit: 20 });
      const byCheckpoint: any = await manager.getJobByCheckpointId("persisted-queued-reuse");
      const deleted: any = await manager.deleteJob(created.id);
      const afterDelete: any = await manager.getJob(created.id);
      const listedAfterDelete: any = await manager.listJobs({ limit: 20 });
      const eventTypes: any = protocolEventBus.publish.mock.calls.map((call?: any) : any => call?.[2]?.type);

      expect(created.id).toBe(reused.id);
      expect(byCheckpoint).toMatchObject({
        id: "persisted-queued-job",
        checkpointId: queuedCheckpoint,
        status: "queued"
      });
      expect(listedBeforeDelete.summary).toMatchObject({
        totalCount: 5,
        queuedCount: 2,
        runningCount: 1,
        completedCount: 1,
        failedCount: 1,
        processingMode: "external",
        workerConcurrency: 0,
        activeJobIds: []
      });
      expect(listedBeforeDelete.items.map((item?: any) : any => item.id)).toEqual(
        expect.arrayContaining([
          created.id,
          "persisted-queued-job",
          "persisted-running-job",
          "persisted-completed-job",
          "persisted-failed-job"
        ])
      );
      expect(deleted).toMatchObject({
        id: created.id,
        checkpointId: serverToken("checkpoint", "fresh-created"),
        status: "queued"
      });
      expect(afterDelete).toBeNull();
      expect(listedAfterDelete.summary).toMatchObject({
        totalCount: 4,
        queuedCount: 1,
        runningCount: 1,
        completedCount: 1,
        failedCount: 1
      });
      expect(eventTypes).toContain("jobs.job.created");
      expect(eventTypes).toContain("jobs.job.reused");
      expect(eventTypes).toContain("jobs.deleted");
      await expect(fs.stat(path.join(userDataPath, "jobs", created.id))).rejects.toThrow();
    });
  });

  it("会在重解析时沿用历史正文并生成新的版本号与父任务引用", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const protocolEventBus: any = createEventBusSpy();
      const checkpointId: any = serverToken("checkpoint", "reparse-source");

      await seedPersistedJob(userDataPath, "reparse-source-job", {
        id: "reparse-source-job",
        status: "completed",
        createdAt: "2026-07-22T07:50:00.000Z",
        updatedAt: "2026-07-22T07:55:00.000Z",
        startedAt: "2026-07-22T07:50:10.000Z",
        finishedAt: "2026-07-22T07:55:00.000Z",
        progressPercent: 100,
        stage: "任务已完成",
        checkpointId
      }, {
        checkpointId,
        inputText: "original payload body",
        sourceType: "upload"
      });

      const manager: any = createTestJobManager({
        userDataPath,
        processingEnabled: false,
        protocolEventBus
      });

      const reparsed: any = await manager.reparseJob("reparse-source-job", {
        settings: {
          retryMode: "manual"
        }
      });
      const listed: any = await manager.listJobs({ limit: 10 });
      const eventTypes: any = protocolEventBus.publish.mock.calls.map((call?: any) : any => call?.[2]?.type);

      expect(reparsed).toMatchObject({
        parentJobId: "reparse-source-job",
        reparseFromJobId: "reparse-source-job",
        checkpointId,
        status: "queued",
        versionNumber: 2
      });
      expect(listed.summary).toMatchObject({
        totalCount: 2,
        queuedCount: 1,
        completedCount: 1,
        failedCount: 0,
        processingMode: "external"
      });
      expect(listed.items.find((item?: any) : any => item.id === reparsed.id)).toMatchObject({
        id: reparsed.id,
        parentJobId: "reparse-source-job",
        reparseFromJobId: "reparse-source-job"
      });
      expect(eventTypes).toContain("jobs.job.created");
      expect(eventTypes).not.toContain("jobs.job.failed");
    });
  });

  it("会在历史 queued 任务缺少 payload 时转为失败并保留失败摘要", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const jobId: any = "missing-payload-job";
      const checkpointId: any = serverToken("checkpoint", "missing-payload");

      await seedPersistedJob(userDataPath, jobId, {
        id: jobId,
        status: "queued",
        createdAt: "2026-06-05T06:10:00.000Z",
        updatedAt: "2026-06-05T06:10:00.000Z",
        progressPercent: 0,
        stage: "等待执行",
        checkpointId
      });

      const manager: any = createTestJobManager({
        userDataPath,
        processingEnabled: true
      });

      const job: any = await waitForJobStatus(manager, jobId, "failed");
      const listed: any = await manager.listJobs({ limit: 5 });

      expect(job).toMatchObject({
        id: jobId,
        status: "failed",
        stage: "任务恢复失败",
        error: "服务重启后缺少任务 payload，不能继续恢复。"
      });
      expect(listed.summary).toMatchObject({
        totalCount: 1,
        queuedCount: 0,
        runningCount: 0,
        completedCount: 0,
        failedCount: 1,
        processingMode: "internal"
      });
    });
  });

  it("会在执行任务失败时将新任务标记为失败并发布失败事件", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      executionShouldThrow.value = true;
      const protocolEventBus: any = createEventBusSpy();
      const manager: any = createTestJobManager({
        userDataPath,
        processingEnabled: true,
        protocolEventBus
      });

      const created: any = await manager.createJob({
        checkpointReceipt: {
          checkpointId: "execution-start-fail-checkpoint"
        },
        checkpointId: "execution-start-fail-checkpoint",
        inputText: "fail-execution"
      });
      void manager.dispatchQueuedJob(created.id);

      const failed: any = await waitForJobStatus(manager, created.id, "failed");
      const eventTypes: any = protocolEventBus.publish.mock.calls.map((call?: any) : any => call?.[2]?.type);

      expect(failed).toMatchObject({
        id: created.id,
        status: "failed",
        stage: "执行失败"
      });
      expect(String(failed?.error || "")).toContain("mock execution start failure");
      expect(eventTypes).toContain("jobs.job.created");
      expect(eventTypes).toContain("jobs.job.failed");
    });
  });

  it("会在关闭后拒绝再创建新任务", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const manager: any = createTestJobManager({
        userDataPath,
        processingEnabled: false
      });

      await manager.close();

      await expect(
        manager.createJob({
          checkpointReceipt: {
            checkpointId: "closed-checkpoint"
          },
          checkpointId: "closed-checkpoint",
          inputText: "should not be accepted"
        })
      ).rejects.toThrow("后台任务管理器已经关闭。");
    });
  });

  it("会拒绝重解析不存在的历史任务，并拒绝没有可重放内容的历史任务", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const completedJobId: any = "completed-without-replay";
      const checkpointId: any = "completed-without-replay-checkpoint";

      await seedPersistedJob(userDataPath, completedJobId, {
        id: completedJobId,
        status: "completed",
        createdAt: "2026-07-22T07:50:00.000Z",
        updatedAt: "2026-07-22T07:55:00.000Z",
        finishedAt: "2026-07-22T07:55:00.000Z",
        progressPercent: 100,
        stage: "任务已完成",
        checkpointId,
        checkpointReceipt: {
          checkpointId
        }
      }, {
        checkpointReceipt: {
          checkpointId
        }
      });

      const manager: any = createTestJobManager({
        userDataPath,
        processingEnabled: false
      });

      await expect(manager.reparseJob("missing-job")).rejects.toThrow("历史任务不存在，不能重新解析。");
      await expect(manager.reparseJob(completedJobId)).rejects.toThrow(
        "历史任务没有保留可重新解析的原始文件或正文。请重新上传原文件后再解析。"
      );
      await manager.close();
    });
  });

  it("会将 worker 并发数裁剪到边界值", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const lowManager: any = createTestJobManager({
        userDataPath,
        processingEnabled: true,
        runtimeOptions: {
          workerConcurrency: "0"
        }
      });
      const highManager: any = createTestJobManager({
        userDataPath,
        processingEnabled: true,
        runtimeOptions: {
          workerConcurrency: 99
        }
      });

      const lowList: any = await lowManager.listJobs({ limit: 1 });
      const highList: any = await highManager.listJobs({ limit: 1 });

      expect(lowList.summary.workerConcurrency).toBe(1);
      expect(highList.summary.workerConcurrency).toBe(16);
    });
  });
});
