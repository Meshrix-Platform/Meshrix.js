import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serverToken } from "#lico/client-strings";

import { createJobManager } from "../../../packages/server-runtime/src/jobs/jobs/job-manager.mjs";
import { createJobProjectionStore } from "../../../packages/server-runtime/src/jobs/jobs/job-projection-store.mjs";
import { createUploadSessionConsumption } from "../../../packages/server-runtime/src/jobs/upload-session-consumption.mjs";
import {
  persistJobTerminal
} from "../../../packages/server-runtime/src/jobs/jobs/job-manager-persistence.mjs";

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}));

const executionBehaviorQueue = vi.hoisted(() => []);

function scheduleJobExecution(behavior) {
  executionBehaviorQueue.push(behavior);
}

function pendingJobExecution(options, progress = null) {
  if (progress) options.onProgress?.(progress);
  return new Promise((resolve, reject) => {
    options.signal?.addEventListener?.("abort", () => {
      reject(options.signal.reason || new Error("cancelled"));
    }, { once: true });
  });
}

vi.mock("../../../packages/server-runtime/src/jobs/jobs/job-runner.mjs", () => {
  return {
    runSplitJob: vi.fn(async (_userDataPath, _payload, options = {}) => {
      const behavior = executionBehaviorQueue.shift();
      if (typeof behavior === "function") return behavior(options);
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(options.signal?.reason || new Error("cancelled"));
        options.signal?.addEventListener?.("abort", onAbort, { once: true });
      });
    })
  };
});

vi.mock("#lico/product-api", async () => {
  const actual = await vi.importActual("#lico/product-api");
  return {
    ...actual,
    getRuntimeLogger: vi.fn(() => loggerMock),
    removeImportCheckpoint: vi.fn(async () => null),
    summarizeError: vi.fn((error) => error?.message || String(error || "")),
    summarizeForLog: vi.fn((value) => value),
    traceDetails: vi.fn(() => ({ traceId: "unit-trace" }))
  };
});

const COMPLETED_RESULT = {
  emails: [
    { email: "a@example.com", confidence: 0.9 }
  ],
  transactions: [
    { id: "t-1" }
  ],
  people: [{ name: "Alice" }],
  warnings: [{ code: "w-1" }]
};

async function withTempUserData(callback) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-job-manager-extra-"));
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

async function waitForJobStatus(manager, jobId, status, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;

  while (Date.now() < end) {
    const job = await manager.getJob(jobId);
    if (job && job.status === status) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return null;
}

async function seedPersistedJob(userDataPath, jobId, meta, payload = null) {
  const projectionStore = createJobProjectionStore({ userDataPath });
  projectionStore.importJob(meta);
  projectionStore.close();
  const jobDir = path.join(userDataPath, "jobs", jobId);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, "meta.json"), JSON.stringify(meta), "utf8");
  if (payload !== null) {
    await fs.writeFile(path.join(jobDir, "payload.json"), JSON.stringify(payload), "utf8");
  }
}

describe("job manager extra", () => {
  beforeEach(() => {
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();
    executionBehaviorQueue.length = 0;
  });

  it("创建、列举与读取：持久化元数据与 payload，支持 checkpoint 去重", async () => {
    await withTempUserData(async (userDataPath) => {
      const protocolEventBus = createEventBusSpy();
      const manager = createJobManager({
        userDataPath,
        processingEnabled: false,
        protocolEventBus
      });

      const payload = {
        checkpointReceipt: {
          checkpointId: "demo-checkpoint"
        },
        checkpointId: "demo-checkpoint",
        inputText: "hello world",
        sourceType: "upload"
      };

      const created = await manager.createJob(payload);
      const listed = await manager.listJobs({ limit: 10 });
      const duplicate = await manager.createJob(payload);
      const byId = await manager.getJob(created.id);
      const byCheckpoint = await manager.getJobByCheckpointId("demo-checkpoint");
      const resultPath = path.join(userDataPath, "jobs", created.id, "result.json");
      const metaPath = path.join(userDataPath, "jobs", created.id, "meta.json");
      const payloadPath = path.join(userDataPath, "jobs", created.id, "payload.json");

      expect(created.id).toBe(duplicate.id);
      expect(created.status).toBe("queued");
      expect(byId).toMatchObject({
        id: created.id,
        status: "queued",
        checkpointId: expect.any(String)
      });
      expect(byCheckpoint).toMatchObject({ id: created.id });
      expect(listed.summary).toMatchObject({
        totalCount: 1,
        queuedCount: 1,
        completedCount: 0,
        failedCount: 0,
        processingMode: "external"
      });
      expect(Array.isArray(listed.items)).toBe(true);
      await expect(fs.stat(metaPath)).resolves.toBeTruthy();
      await expect(fs.stat(payloadPath)).resolves.toBeTruthy();
      await expect(fs.stat(resultPath)).rejects.toThrow();
      await expect(fs.readFile(payloadPath, "utf8")).resolves.toContain("hello world");
      await expect(manager.getJobResult(created.id)).rejects.toThrow("任务尚未完成，暂时不能读取结果。");
      await expect(manager.getJob("not-exists")).resolves.toBeNull();
    });
  });

  it("运行流程：从 queued 转到 running 再到 completed 并持久化 result", async () => {
    await withTempUserData(async (userDataPath) => {
      const protocolEventBus = createEventBusSpy();
      scheduleJobExecution(async (options) => {
        options.onProgress?.({ progressPercent: 55, stage: "解析中" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return COMPLETED_RESULT;
      });

      const manager = createJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: true
      });

      const created = await manager.createJob({
        checkpointReceipt: {
          checkpointId: "complete-checkpoint"
        },
        checkpointId: "complete-checkpoint",
        inputText: "complete"
      });
      void manager.dispatchQueuedJob(created.id);

      const running = await waitForJobStatus(manager, created.id, "running");
      expect(running).not.toBeNull();

      const completed = await waitForJobStatus(manager, created.id, "completed");
      expect(completed).not.toBeNull();
      expect(completed).toMatchObject({
        status: "completed",
        stage: "任务已完成",
        resultSummary: {
          emails: 1,
          transactions: 1,
          people: 1,
          warnings: 1
        }
      });

      const finalResult = await manager.getJobResult(created.id);
      expect(finalResult).toMatchObject(COMPLETED_RESULT);

      const list = await manager.listJobs({ limit: 20 });
      expect(list.summary.completedCount).toBe(1);
      expect(list.summary.queuedCount).toBe(0);
      expect(list.summary.processingMode).toBe("internal");

      const resultPath = path.join(userDataPath, "jobs", created.id, "result.json");
      const persisted = JSON.parse(await fs.readFile(resultPath, "utf8"));
      expect(persisted).toMatchObject({
        format: "lico.job-terminal",
        schema: "job-terminal-envelope",
        job: { id: created.id, status: "completed" },
        result: COMPLETED_RESULT
      });
    });
  });

  it("失败路径：执行任务失败后 job 变为 failed 且不能读取 result", async () => {
    await withTempUserData(async (userDataPath) => {
      const protocolEventBus = createEventBusSpy();
      scheduleJobExecution(async () => {
        throw new Error("mock execution failed");
      });

      const manager = createJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: true
      });

      const created = await manager.createJob({
        checkpointReceipt: {
          checkpointId: "failed-checkpoint"
        },
        checkpointId: "failed-checkpoint",
        inputText: "fail now"
      });
      void manager.dispatchQueuedJob(created.id);
      const failed = await waitForJobStatus(manager, created.id, "failed");

      expect(failed).not.toBeNull();
      expect(failed).toMatchObject({
        status: "failed",
        error: "mock execution failed"
      });
      await expect(manager.getJobResult(created.id)).rejects.toThrow("任务尚未完成，暂时不能读取结果。");
    });
  });

  it("丢失队列租约时取消执行并保留 queued 恢复状态", async () => {
    await withTempUserData(async (userDataPath) => {
      let executionSignal = null;
      scheduleJobExecution((options) => {
        executionSignal = options.signal;
        return pendingJobExecution(options);
      });
      const manager = createJobManager({
        userDataPath,
        protocolEventBus: createEventBusSpy(),
        processingEnabled: true
      });
      const created = await manager.createJob({
        checkpointReceipt: { checkpointId: "lease-loss-checkpoint" },
        checkpointId: "lease-loss-checkpoint",
        inputText: "lease loss"
      });
      const controller = new AbortController();
      const dispatched = manager.dispatchQueuedJob(created.id, {
        signal: controller.signal,
        leaseGuard: vi.fn(async () => null)
      });
      expect(await waitForJobStatus(manager, created.id, "running")).not.toBeNull();
      controller.abort(new Error("queue lease lost"));

      await expect(dispatched).resolves.toMatchObject({ completed: false });
      await expect(manager.getJob(created.id)).resolves.toMatchObject({
        status: "queued"
      });
      expect(executionSignal?.aborted).toBe(true);
      await manager.close();
    });
  });

  it("上传会话仅在 canonical persistence receipt 完整时清理，失败时保留到显式删除", async () => {
    await withTempUserData(async (userDataPath) => {
      const protocolEventBus = createEventBusSpy();
      const successfulSessionId = serverToken("upload_session", "cleanup-success");
      const failedSessionId = serverToken("upload_session", "cleanup-failure");
      const successfulSessionRoot = path.join(userDataPath, "upload-sessions", successfulSessionId);
      const failedSessionRoot = path.join(userDataPath, "upload-sessions", failedSessionId);
      await fs.mkdir(successfulSessionRoot, { recursive: true });
      await fs.mkdir(failedSessionRoot, { recursive: true });
      await fs.writeFile(path.join(successfulSessionRoot, "retained.part"), "persisted", "utf8");
      await fs.writeFile(path.join(failedSessionRoot, "retained.part"), "retry", "utf8");

      scheduleJobExecution(async () => ({
        ...COMPLETED_RESULT,
        uploadSessionConsumption: createUploadSessionConsumption({
          expectedFileCount: 1,
          persistedFileCount: 1
        })
      }));
      scheduleJobExecution(async () => {
        throw new Error("persistence failed");
      });

      const manager = createJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: true
      });
      const completedJob = await manager.createJob({
        checkpointReceipt: { checkpointId: "upload-cleanup-success" },
        checkpointId: "upload-cleanup-success",
        uploadSessionId: successfulSessionId
      });
      void manager.dispatchQueuedJob(completedJob.id);
      expect(await waitForJobStatus(manager, completedJob.id, "completed")).not.toBeNull();
      await expect(fs.stat(successfulSessionRoot)).rejects.toThrow();

      const failedJob = await manager.createJob({
        checkpointReceipt: { checkpointId: "upload-cleanup-failure" },
        checkpointId: "upload-cleanup-failure",
        uploadSessionId: failedSessionId
      });
      void manager.dispatchQueuedJob(failedJob.id);
      expect(await waitForJobStatus(manager, failedJob.id, "failed")).not.toBeNull();
      await expect(fs.stat(failedSessionRoot)).resolves.toBeTruthy();

      await manager.deleteJob(failedJob.id);
      await expect(fs.stat(failedSessionRoot)).rejects.toThrow();
    });
  });

  it("完成结果缺少 upload persistence receipt 时保留 staging 并拒绝隐式清理", async () => {
    await withTempUserData(async (userDataPath) => {
      const protocolEventBus = createEventBusSpy();
      const sessionId = serverToken("upload_session", "cleanup-unconsumed");
      const sessionRoot = path.join(userDataPath, "upload-sessions", sessionId);
      await fs.mkdir(sessionRoot, { recursive: true });
      await fs.writeFile(path.join(sessionRoot, "retained.part"), "unconsumed", "utf8");
      scheduleJobExecution(async () => COMPLETED_RESULT);
      const manager = createJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: true
      });
      const created = await manager.createJob({
        checkpointReceipt: { checkpointId: "upload-cleanup-unconsumed" },
        checkpointId: "upload-cleanup-unconsumed",
        uploadSessionId: sessionId
      });
      void manager.dispatchQueuedJob(created.id);

      expect(await waitForJobStatus(manager, created.id, "completed")).not.toBeNull();
      await expect(fs.stat(sessionRoot)).resolves.toBeTruthy();
      expect(loggerMock.warn).toHaveBeenCalledWith(
        "jobs.upload_session.retained",
        expect.objectContaining({
          jobId: created.id,
          reason: "persistence_receipt_missing"
        })
      );
      await manager.deleteJob(created.id);
      await expect(fs.stat(sessionRoot)).rejects.toThrow();
    });
  });

  it("取消进行中任务：deleteJob 会清理运行中任务目录和内存并返回任务快照", async () => {
    await withTempUserData(async (userDataPath) => {
      const protocolEventBus = createEventBusSpy();
      scheduleJobExecution((options) => pendingJobExecution(options, {
        progressPercent: 20,
        stage: "处理中文件"
      }));

      const manager = createJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: true
      });

      const created = await manager.createJob({
        checkpointReceipt: {
          checkpointId: "delete-checkpoint"
        },
        checkpointId: "delete-checkpoint",
        inputText: "cancel me"
      });
      void manager.dispatchQueuedJob(created.id);
      const running = await waitForJobStatus(manager, created.id, "running");
      expect(running).not.toBeNull();

      const deleted = await manager.deleteJob(created.id);
      expect(deleted).toMatchObject({ id: created.id });

      const afterDelete = await manager.getJob(created.id);
      expect(afterDelete).toBeNull();

      const jobDir = path.join(userDataPath, "jobs", created.id);
      await expect(fs.stat(jobDir)).rejects.toThrow();
    });
  });

  it("取消进行中任务会保留可观察的 cancelled 终态和任务工件", async () => {
    await withTempUserData(async (userDataPath) => {
      scheduleJobExecution((options) => pendingJobExecution(options));
      const manager = createJobManager({
        userDataPath,
        protocolEventBus: createEventBusSpy(),
        processingEnabled: true
      });
      const created = await manager.createJob({
        checkpointId: "cancel-running-job",
        inputText: "cancel me"
      });
      void manager.dispatchQueuedJob(created.id);
      expect(await waitForJobStatus(manager, created.id, "running")).not.toBeNull();

      await expect(manager.cancelJob(created.id)).resolves.toMatchObject({
        id: created.id,
        status: "cancelled",
        stage: "任务已取消"
      });
      await expect(fs.stat(path.join(userDataPath, "jobs", created.id, "meta.json")))
        .resolves.toBeTruthy();
      const listed = await manager.listJobs({ limit: 10 });
      expect(listed.summary).toMatchObject({ cancelledCount: 1, runningCount: 0 });
      await manager.close();
    });
  });

  it("关闭管理器时会将运行中任务置为 queued 以便后续重试恢复", async () => {
    await withTempUserData(async (userDataPath) => {
      const protocolEventBus = createEventBusSpy();
      scheduleJobExecution((options) => pendingJobExecution(options, {
        progressPercent: 31,
        stage: "准备回退"
      }));

      const manager = createJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: true
      });

      const created = await manager.createJob({
        checkpointReceipt: {
          checkpointId: "recover-checkpoint"
        },
        checkpointId: "recover-checkpoint",
        inputText: "recover later"
      });
      void manager.dispatchQueuedJob(created.id);

      const running = await waitForJobStatus(manager, created.id, "running");
      expect(running).not.toBeNull();

      await manager.close();
      const recovered = await waitForJobStatus(manager, created.id, "queued");

      expect(recovered).toMatchObject({
        status: "queued",
        stage: "服务已恢复，任务等待重试。"
      });
    });
  });

  it("关闭只回收 active execution，并幂等保留未被 canonical queue 调度的 queued job", async () => {
    await withTempUserData(async (userDataPath) => {
      scheduleJobExecution((options) => pendingJobExecution(options, {
        progressPercent: 25,
        stage: "等待关闭重试"
      }));
      const manager = createJobManager({
        userDataPath,
        protocolEventBus: createEventBusSpy(),
        processingEnabled: true,
        runtimeOptions: {
          workerConcurrency: 1
        }
      });
      const active = await manager.createJob({
        checkpointReceipt: {
          checkpointId: "retry-close-active-checkpoint"
        },
        checkpointId: "retry-close-active-checkpoint",
        inputText: "keep task active"
      });
      void manager.dispatchQueuedJob(active.id);
      expect(await waitForJobStatus(manager, active.id, "running")).not.toBeNull();
      const queued = await manager.createJob({
        checkpointReceipt: {
          checkpointId: "retry-close-queued-checkpoint"
        },
        checkpointId: "retry-close-queued-checkpoint",
        inputText: "retry close persistence"
      });
      expect(await waitForJobStatus(manager, queued.id, "queued")).not.toBeNull();
      const metaPath = path.join(userDataPath, "jobs", queued.id, "meta.json");
      await expect(manager.close()).resolves.toBeUndefined();
      await expect(manager.close()).resolves.toBeUndefined();
      await expect(fs.stat(metaPath)).resolves.toBeTruthy();
      await expect(manager.getJob(queued.id)).resolves.toMatchObject({ status: "queued" });

      const persisted = JSON.parse(await fs.readFile(metaPath, "utf8"));
      expect(persisted).toMatchObject({
        id: queued.id,
        status: "queued",
        stage: "等待执行"
      });
    });
  });

  it("外部模式：queued 任务可直接删除", async () => {
    await withTempUserData(async (userDataPath) => {
      const protocolEventBus = createEventBusSpy();
      const manager = createJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: false
      });

      const created = await manager.createJob({
        checkpointReceipt: {
          checkpointId: "external-delete-checkpoint"
        },
        checkpointId: "external-delete-checkpoint",
        inputText: "external queued job"
      });

      const deleted = await manager.deleteJob(created.id);
      const list = await manager.listJobs({ limit: 10 });

      expect(created.status).toBe("queued");
      expect(deleted).toMatchObject({
        id: created.id,
        status: "queued"
      });
      expect(list.summary).toMatchObject({
        totalCount: 0,
        queuedCount: 0,
        runningCount: 0,
        completedCount: 0,
        failedCount: 0,
        processingMode: "external",
        workerConcurrency: 0
      });
      await expect(manager.getJob(created.id)).resolves.toBeNull();
      await expect(fs.stat(path.join(userDataPath, "jobs", created.id))).rejects.toThrow();
    });
  });

  it("执行任务异常时会将任务落为 failed 并记录错误信息", async () => {
    await withTempUserData(async (userDataPath) => {
      const protocolEventBus = createEventBusSpy();
      scheduleJobExecution(async () => {
        throw new Error("execution task failed unexpectedly");
      });

      const manager = createJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: true
      });

      const created = await manager.createJob({
        checkpointReceipt: {
          checkpointId: "abnormal-exit-checkpoint"
        },
        checkpointId: "abnormal-exit-checkpoint",
        inputText: "exit without result"
      });
      void manager.dispatchQueuedJob(created.id);

      const failed = await waitForJobStatus(manager, created.id, "failed");

      expect(failed).not.toBeNull();
      expect(failed).toMatchObject({
        status: "failed",
        stage: "执行失败"
      });
      expect(String(failed.error || "")).toContain("execution task failed unexpectedly");
    });
  });

  it("启动恢复：磁盘上缺少 payload 的 queued 任务会被标记为 failed", async () => {
    await withTempUserData(async (userDataPath) => {
      const protocolEventBus = createEventBusSpy();
      const jobId = "persisted-missing-payload";

      await seedPersistedJob(userDataPath, jobId, {
        id: jobId,
        status: "queued",
        createdAt: "2026-06-04T08:00:00.000Z",
        updatedAt: "2026-06-04T08:00:00.000Z",
        progressPercent: 27,
        stage: "等待执行",
        checkpointId: "persisted-missing-payload-checkpoint"
      });

      const manager = createJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: true
      });

      const recovered = await waitForJobStatus(manager, jobId, "failed");
      const list = await manager.listJobs({ limit: 10 });

      expect(recovered).not.toBeNull();
      expect(recovered).toMatchObject({
        id: jobId,
        status: "failed",
        stage: "任务恢复失败",
        error: "服务重启后缺少任务 payload，不能继续恢复。"
      });
      expect(list.summary.failedCount).toBe(1);
      expect(list.summary.queuedCount).toBe(0);
    });
  });

  it("启动恢复会显式标记损坏 payload，且不会让持久化任务静默消失", async () => {
    await withTempUserData(async (userDataPath) => {
      const jobId = "persisted-invalid-payload";
      await seedPersistedJob(userDataPath, jobId, {
        id: jobId,
        status: "running",
        createdAt: "2026-06-04T08:00:00.000Z",
        updatedAt: "2026-06-04T08:00:00.000Z",
        progressPercent: 27,
        stage: "执行中",
        checkpointId: "persisted-invalid-payload-checkpoint"
      });
      await fs.writeFile(
        path.join(userDataPath, "jobs", jobId, "payload.json"),
        "{invalid-json",
        "utf8"
      );

      const manager = createJobManager({
        userDataPath,
        protocolEventBus: createEventBusSpy(),
        processingEnabled: true
      });
      const recovered = await waitForJobStatus(manager, jobId, "failed");
      const listed = await manager.listJobs({ limit: 10 });

      expect(recovered).toMatchObject({
        id: jobId,
        status: "failed",
        stage: "任务恢复失败",
        error: "服务重启后任务 payload 已损坏，不能继续恢复。"
      });
      expect(listed.items).toContainEqual(expect.objectContaining({ id: jobId }));
      await manager.close();
    });
  });

  it("重解析：completed 历史任务会生成新的版本并重新进入队列", async () => {
    await withTempUserData(async (userDataPath) => {
      const protocolEventBus = createEventBusSpy();
      scheduleJobExecution(async () => COMPLETED_RESULT);
      scheduleJobExecution(async () => COMPLETED_RESULT);

      const manager = createJobManager({
        userDataPath,
        protocolEventBus,
        processingEnabled: true
      });

      const source = await manager.createJob({
        checkpointReceipt: {
          checkpointId: "reparse-checkpoint"
        },
        checkpointId: "reparse-checkpoint",
        inputText: "retry me",
        sourceType: "upload"
      });
      void manager.dispatchQueuedJob(source.id);

      const sourceCompleted = await waitForJobStatus(manager, source.id, "completed");
      expect(sourceCompleted).not.toBeNull();

      const reparsed = await manager.reparseJob(source.id, {
        settings: {
          mode: "retry"
        }
      });
      void manager.dispatchQueuedJob(reparsed.id);

      expect(reparsed).toMatchObject({
        parentJobId: source.id,
        reparseFromJobId: source.id,
        checkpointId: source.checkpointId,
        versionGroupId: source.versionGroupId,
        versionNumber: source.versionNumber + 1
      });
      expect(reparsed.status).toBe("queued");

      const reparsedCompleted = await waitForJobStatus(manager, reparsed.id, "completed");
      const list = await manager.listJobs({ limit: 10 });

      expect(reparsedCompleted).not.toBeNull();
      expect(reparsedCompleted).toMatchObject({
        id: reparsed.id,
        status: "completed",
        parentJobId: source.id,
        reparseFromJobId: source.id,
        resultSummary: {
          emails: 1,
          transactions: 1,
          people: 1,
          warnings: 1
        }
      });
      expect(list.summary.completedCount).toBe(2);
      expect(list.summary.failedCount).toBe(0);
    });
  });

  it("队列基础设施终态会幂等收口 queued 与 running 任务投影", async () => {
    await withTempUserData(async (userDataPath) => {
      const manager = createJobManager({ userDataPath, processingEnabled: true });
      const queued = await manager.createJob({ inputText: "queued projection" });
      const queuedFailed = await manager.failJobFromQueue(queued.id, {
        stage: "队列执行失败",
        reason: "Queue work reached terminal failure."
      });
      expect(queuedFailed).toMatchObject({ id: queued.id, status: "failed" });
      await expect(manager.failJobFromQueue(queued.id, {
        stage: "ignored replay",
        reason: "ignored replay"
      })).resolves.toMatchObject({ id: queued.id, status: "failed" });

      scheduleJobExecution((options) => pendingJobExecution(options));
      const running = await manager.createJob({ inputText: "running projection" });
      void manager.dispatchQueuedJob(running.id, {
        lease: { leaseId: "queue-lease" },
        leaseGuard: vi.fn(async () => ({ progressed: true }))
      });
      expect(await waitForJobStatus(manager, running.id, "running")).not.toBeNull();
      const runningFailed = await manager.failJobFromQueue(running.id, {
        stage: "队列任务已过期",
        reason: "Queue work expired before completion."
      });
      expect(runningFailed).toMatchObject({ id: running.id, status: "failed" });
      await manager.close();
    });
  });
});
