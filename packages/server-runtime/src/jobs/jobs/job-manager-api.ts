import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { deleteCheckpointTree, serverToken, summarizeForLog, traceDetails } from "#meshrix/product-api";
import { deleteUploadSession } from "../../state/upload-session-store.ts";
import { normalizeCanonicalObjectSource } from "../job-pipeline.ts";
import { getJobDirectory } from "./job-manager-validation.ts";
import { loadJobPayload, loadJobResult, persistJobMeta, persistJobPayload } from "./job-manager-persistence.ts";
import { reconcileJobProjectionArtifacts } from "./job-projection-recovery.ts";
import {
  canReuseJobForPayload,
  normalizeArchiveBatchId,
  normalizeCheckpointId,
  normalizeManifestKey,
  normalizeParentJobId,
  normalizeVersionGroupId,
  shouldForceNewJobVersion
} from "./job-manager-validation.ts";

const MAX_QUEUED_JOB_IDS_IN_SUMMARY: any = 200;

function jobMatchesAccess(job?: any, access?: any) : any {
  if (!access) return true;
  const values: any = (input?: any) : any => new Set<any>(
    (Array.isArray(input) ? input : []).map(String).filter(Boolean)
  );
  const jobIds: any = values(access.jobIds);
  if (jobIds.has(String(job?.id || ""))) return true;
  const workspaceIds: any = values(access.workspaceIds);
  if (
    workspaceIds.has(String(
      job?.workspaceId ||
      job?.workspace_id ||
      job?.workspace ||
      job?.payload?.workspaceId ||
      ""
    ))
  ) {
    return true;
  }
  const principals: any = values(access.principalIds);
  return [
    job?.ownerSubjectId,
    job?.ownerUserId,
    job?.ownerUsername,
    job?.createdBySubjectId,
    job?.createdByUserId,
    job?.createdBy,
    job?.owner?.subjectId,
    job?.owner?.userId,
    job?.owner?.username
  ].some((value?: any) : any => principals.has(String(value || "")));
}

export function createJobManagerApi(ctx?: any) : any {
  const {
    userDataPath,
    processingEnabled,
    workerConcurrency,
    jobs,
    checkpointJobs,
    jobProjectionStore,
    activeControllers,
    durableWorkflows,
    logJob,
    state,
    ready,
    refreshPersistedJobs,
    publishJobEvent,
    cloneJobForApi,
    getActiveManifestJob,
    checkpointTreeIdForJob,
    workflowIdForJob,
    ensureJobCheckpointTree,
    updateJobCheckpointNode,
    rememberActiveManifestJob,
    runQueuedJob,
    forgetActiveManifestJob,
    publishDeletedJobEvent,
    failJob,
    updateJob,
    commitTerminalThenScheduleUploadCleanup,
    loadJobPayload: loadJobPayloadFromContext,
    drainBackgroundTasks
  } = ctx;

  let closePromise: any = null;

  return {
    async commitTerminalThenScheduleUploadCleanup(input?: any) : Promise<any> {
      await ready;
      return commitTerminalThenScheduleUploadCleanup(input);
    },

    async createJob(payload?: any) : Promise<any> {
      logJob("info", "jobs.job.create.requested", {
        payload: summarizeForLog(payload)
      });
      await ready;
      if (state.closed) {
        logJob("error", "jobs.job.create.rejected", {
          reason: "closed"
        });
        throw new Error("后台任务管理器已经关闭。");
      }
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }

      const checkpointId: any = normalizeCheckpointId(payload);
      const manifestKey: any = normalizeManifestKey(payload);
      const archiveBatchId: any = normalizeArchiveBatchId(payload) || serverToken("archive_batch", checkpointId || manifestKey || randomUUID());
      const forceNewVersion: any = shouldForceNewJobVersion(payload);
      const versionGroupId: any = normalizeVersionGroupId(payload, {
        checkpointId,
        manifestKey,
        archiveBatchId
      });
      const versionNumber: any = 1;
      const parentJobId: any = normalizeParentJobId(payload);
      const existingCheckpointJob: any = checkpointId
        ? jobs.get(checkpointJobs.get(checkpointId)) ||
          jobProjectionStore.getByCheckpoint(checkpointId)
        : null;
      if (!forceNewVersion && existingCheckpointJob) {
        const existingJob: any = existingCheckpointJob;
        if (canReuseJobForPayload(existingJob, payload)) {
          await publishJobEvent(existingJob, "jobs.job.reused");
          logJob("info", "jobs.job.create.reused", {
            jobId: existingJob.id,
            checkpointId,
            reason: "checkpoint_id"
          });
          return cloneJobForApi(existingJob);
        }
        logJob("info", "jobs.job.create.reused", {
          jobId: existingJob.id,
          checkpointId,
          reason: "checkpoint_id_owner_mismatch",
          reused: false
        });
      }
      const existingManifestJob: any =
        getActiveManifestJob(manifestKey, archiveBatchId) ||
        jobProjectionStore.getActiveManifest(manifestKey, archiveBatchId);
      if (!forceNewVersion && canReuseJobForPayload(existingManifestJob, payload)) {
        if (checkpointId) {
          checkpointJobs.set(checkpointId, existingManifestJob.id);
        }
        await publishJobEvent(existingManifestJob, "jobs.job.reused");
        logJob("info", "jobs.job.create.reused", {
          jobId: existingManifestJob.id,
          manifestKey,
          reason: "manifest_key"
        });
        return cloneJobForApi(existingManifestJob);
      }

      const now: any = new Date().toISOString();
      const trace: any = traceDetails();
      const job: Record<string, any> = {
        id: randomUUID(),
        trace,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        progressPercent: 0,
        stage: "等待执行",
        checkpointId,
        checkpointTreeId: "",
        workflowId: "",
        checkpointReceipt: payload?.checkpointReceipt || null,
        uploadSessionId: String(payload?.uploadSessionId || ""),
        archiveBatchId,
        versionGroupId,
        versionNumber,
        parentJobId,
        reparseFromJobId: String(payload?.reparseFromJobId || "")
      };
      job.ownerSubjectId = String(payload?.ownerSubjectId || payload?.ownerUserId || payload?.ownerUsername || "").trim();
      job.ownerUserId = String(payload?.ownerUserId || payload?.ownerSubjectId || "").trim();
      job.ownerUsername = String(payload?.ownerUsername || "").trim();
      job.ownerRoleId = String(payload?.ownerRoleId || "").trim();
      job.ownerTenantId = String(payload?.ownerTenantId || "").trim();
      job.workspaceId = String(payload?.workspaceId || payload?.workspace || "").trim();
      job.checkpointTreeId = checkpointTreeIdForJob(job);
      job.workflowId = workflowIdForJob(job);
      try {
        Object.assign(job, jobProjectionStore.create(job));
      } catch (error: any) {
        const concurrent: any = manifestKey
          ? jobProjectionStore.getActiveManifest(manifestKey, archiveBatchId)
          : null;
        if (
          String(error?.code || "").startsWith("SQLITE_CONSTRAINT") &&
          !forceNewVersion &&
          canReuseJobForPayload(concurrent, payload)
        ) {
          await publishJobEvent(concurrent, "jobs.job.reused");
          return cloneJobForApi(concurrent);
        }
        if (String(error?.code || "").startsWith("SQLITE_CONSTRAINT")) {
          throw Object.assign(
            new Error("An active job already owns this manifest admission."),
            {
              code: "job_projection_active_manifest_conflict",
              statusCode: 409
            }
          );
        }
        throw error;
      }
      try {
        await ensureJobCheckpointTree(job, payload);
        await durableWorkflows.startWorkflow({
        workflowId: job.workflowId,
        workflowType: "import_parse_job",
        ownerKind: "import_parse_job",
        ownerId: job.id,
        idempotencyKey: checkpointId || manifestKey || archiveBatchId,
        inputHash: manifestKey || checkpointId || archiveBatchId,
        input: {
          checkpointId,
          archiveBatchId,
          uploadSessionId: job.uploadSessionId || "",
          manifestSha256: manifestKey
        },
        checkpointTreeId: job.checkpointTreeId
        });
        await durableWorkflows.scheduleActivity(job.workflowId, {
        activityId: "queue-wait",
        activityType: "queue_wait",
        idempotencyKey: `${job.id}:queue-wait`,
        input: {
          queueDepthAtAdmission:
            Math.max(
              0,
              Number(jobProjectionStore.getCounts().counts.queued || 0) - 1
            )
        },
        retryPolicy: {
          maxAttempts: 1
        }
        });
        await durableWorkflows.completeActivity(job.workflowId, "queue-wait", {
          queuedAt: now
        });
        await updateJobCheckpointNode(job, {
        nodeId: "queued",
        parentId: "import-parse-job",
        label: "等待后台任务",
        status: "running",
        cursor: {
          queueDepthAtAdmission:
            Math.max(
              0,
              Number(jobProjectionStore.getCounts().counts.queued || 0) - 1
            )
        },
        metadata: {
          checkpointId,
          manifestSha256: manifestKey
        }
        });
        await persistJobMeta(userDataPath, job, jobProjectionStore);
        await persistJobPayload(
          userDataPath,
          job.id,
          payload,
          jobProjectionStore
        );
      } catch (error: any) {
        await durableWorkflows.failWorkflow(
          job.workflowId,
          "Job admission failed."
        ).catch(() : any => null);
        await deleteCheckpointTree({
          userDataPath,
          treeId: job.checkpointTreeId
        }).catch(() : any => null);
        jobProjectionStore.delete(job.id);
        const directoryRemoved: any = await fs.rm(
          getJobDirectory(userDataPath, job.id),
          {
          recursive: true,
          force: true
          }
        ).then(() : any => true, () : any => false);
        if (directoryRemoved) {
          jobProjectionStore.settleDeletion(job.id);
        }
        throw error;
      }
      jobs.set(job.id, job);
      if (checkpointId) checkpointJobs.set(checkpointId, job.id);
      rememberActiveManifestJob(job);
      await publishJobEvent(job, "jobs.job.created");
      logJob("info", "jobs.job.created", {
        jobId: job.id,
        checkpointId,
        archiveBatchId,
        manifestKey,
        uploadSessionId: job.uploadSessionId || "",
        processingEnabled
      });
      return cloneJobForApi(job);
    },

    async reparseJob(jobId?: any, options: Record<string, any> = {}) : Promise<any> {
      logJob("info", "jobs.job.reparse.requested", {
        jobId,
        options: summarizeForLog(options)
      });
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const sourceJob: any = jobs.get(jobId) || jobProjectionStore.get(jobId);
      if (!sourceJob) {
        throw new Error("历史任务不存在，不能重新解析。");
      }

      const sourcePayload: any = await loadJobPayload(
        userDataPath,
        sourceJob.id,
        jobProjectionStore
      );
      const sourceResult: any = sourceJob.status === "completed"
        ? await this.getJobResult(sourceJob.id).catch(() : any => null)
        : null;
      const sourceFiles: any = Array.isArray(sourceResult?.sourceFiles) ? sourceResult.sourceFiles : [];
      const canonicalObjectSources: any[] = [];
      const replayTextSections: any[] = [];

      for (const [index, source] of sourceFiles.entries()) {
        const record: any = source && typeof source === "object" ? source : {};
        const storageRelativePath: any = String(record.storageRelativePath || "").trim();
        if (storageRelativePath) {
          try {
            canonicalObjectSources.push(normalizeCanonicalObjectSource({
              rawObjectId: String(record.rawObjectId || record.id || ""),
              storageRelativePath,
              rawObjectSha256: String(
                record.rawObjectSha256 || record.contentHash || ""
              ),
              rawObjectByteSize: Number(record.rawObjectByteSize),
              originalFileName: String(
                record.originalFileName ||
                  record.originalRelativePath ||
                  record.name ||
                  `source-${index + 1}`
              ),
              mediaType: String(
                record.mediaType || "application/octet-stream"
              ),
              sourceMetadata:
                record.sourceMetadata &&
                typeof record.sourceMetadata === "object" &&
                !Array.isArray(record.sourceMetadata)
                  ? record.sourceMetadata
                  : {}
            }));
            continue;
          } catch {
            // Fall back to the normalized text snapshot when the object reference is invalid.
          }
        }

        const text: any = String(record.text || "").trim();
        if (text) {
          const name: any = String(record.originalFileName || record.name || `source-${index + 1}`);
          replayTextSections.push(`# ${name}\n\n${text}`);
        }
      }

      const replayInputText: any =
        replayTextSections.length > 0
          ? replayTextSections.join("\n\n---\n\n")
          : String(sourcePayload?.inputText || "").trim();
      const hasReplayInput: any =
        canonicalObjectSources.length > 0 ||
          replayInputText.length > 0;

      if (!hasReplayInput) {
        throw new Error("历史任务没有保留可重新解析的原始文件或正文。请重新上传原文件后再解析。");
      }

      const checkpointId: any = normalizeCheckpointId(sourcePayload || sourceJob);
      const manifestKey: any = normalizeManifestKey(sourcePayload || sourceJob);
      const versionGroupId: any = normalizeVersionGroupId(sourceJob.versionGroupId ? sourceJob : sourcePayload || sourceJob, {
        checkpointId,
        manifestKey,
        archiveBatchId: sourceJob.archiveBatchId || ""
      });
      const archiveBatchId: any = serverToken("archive_batch", versionGroupId, randomUUID());
      const checkpointReceipt: Record<string, any> = {
        ...(sourcePayload?.checkpointReceipt || sourceJob.checkpointReceipt || {}),
        checkpointId,
        archiveBatchId,
        versionGroupId,
        reparseFromJobId: sourceJob.id
      };
      const checkpoint: Record<string, any> = {
        ...(sourcePayload?.checkpoint || {}),
        checkpointId,
        archiveBatchId
      };
      const reparsePayload: Record<string, any> = {
        inputText: canonicalObjectSources.length > 0
          ? ""
          : replayInputText,
        canonicalObjectSources,
        uploadSessionId: "",
        checkpoint,
        checkpointId,
        archiveBatchId,
        checkpointReceipt,
        settings: options?.settings || sourcePayload?.settings || {},
        forceNewVersion: true,
        reparseFromJobId: sourceJob.id,
        parentJobId: sourceJob.id,
        versionGroupId,
        ownerSubjectId: String(options?.ownerSubjectId || sourceJob.ownerSubjectId || sourcePayload?.ownerSubjectId || "").trim(),
        ownerUserId: String(options?.ownerUserId || sourceJob.ownerUserId || sourcePayload?.ownerUserId || "").trim(),
        ownerUsername: String(options?.ownerUsername || sourceJob.ownerUsername || sourcePayload?.ownerUsername || "").trim(),
        ownerRoleId: String(options?.ownerRoleId || sourceJob.ownerRoleId || sourcePayload?.ownerRoleId || "").trim(),
        ownerTenantId: String(options?.ownerTenantId || sourceJob.ownerTenantId || sourcePayload?.ownerTenantId || "").trim(),
        workspaceId: String(options?.workspaceId || sourceJob.workspaceId || sourcePayload?.workspaceId || "").trim()
      };
      const job: any = await this.createJob(reparsePayload);
      logJob("info", "jobs.job.reparse.created", {
        parentJobId: sourceJob.id,
        jobId: job?.id || "",
        versionGroupId,
        archiveBatchId
      });
      return job;
    },

    async dispatchQueuedJob(jobId?: any, options: Record<string, any> = {}) : Promise<any> {
      await ready;
      if (!processingEnabled) {
        throw new Error("后台任务执行器未启用，不能调度平台任务。");
      }
      if (state.closed) {
        throw new Error("后台任务管理器已经关闭。");
      }
      const normalizedJobId: any = String(jobId || options.jobId || "").trim();
      if (!normalizedJobId) {
        throw new Error("jobId is required.");
      }
      const currentJob: any = jobs.get(normalizedJobId) || null;
      if (!currentJob) {
        throw new Error(`任务不存在，不能调度：${normalizedJobId}`);
      }
      if (currentJob.status !== "queued") {
        return {
          dispatched: false,
          skipped: true,
          job: cloneJobForApi(currentJob),
          reason: `status_${currentJob.status || "unknown"}`
        };
      }
      const payload: any = options.payload || await loadJobPayload(
        userDataPath,
        normalizedJobId,
        jobProjectionStore
      );
      if (!payload) {
        throw new Error(`任务缺少 payload，不能调度：${normalizedJobId}`);
      }
      const completed: any = await runQueuedJob({
        jobId: normalizedJobId,
        payload,
        signal: options.signal || null,
        leaseGuard: typeof options.leaseGuard === "function" ? options.leaseGuard : null
      });
      return {
        dispatched: true,
        completed: Boolean(completed),
        job: cloneJobForApi(jobs.get(normalizedJobId) || currentJob)
      };
    },

    async getJob(jobId?: any) : Promise<any> {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      return cloneJobForApi(
        jobs.get(jobId) || jobProjectionStore.get(jobId)
      );
    },

    async getJobWorkflow(jobId?: any) : Promise<any> {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const currentJob: any = jobs.get(jobId) || jobProjectionStore.get(jobId);
      if (!currentJob) {
        return null;
      }
      return durableWorkflows.getWorkflow(currentJob.workflowId || workflowIdForJob(currentJob));
    },

    async listJobWorkflows(input: Record<string, any> = {}) : Promise<any> {
      await ready;
      return durableWorkflows.listWorkflows({
        ownerKind: "import_parse_job",
        ...input
      });
    },

    async listJobOwnerships({ cursor = "", limit = 100 }: Record<string, any> = {}) : Promise<any> {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      return jobProjectionStore.listOwnerships({ cursor, limit });
    },

    async listQueuedJobAdmissions({ cursor = "", limit = 100 }: Record<string, any> = {}) : Promise<any> {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const page: any = jobProjectionStore.listQueued({ cursor, limit });
      return {
        ...page,
        items: page.items.map((job?: any) : any => cloneJobForApi(job))
      };
    },

    async listJobs({ cursor = "", limit = 50, access = null }: Record<string, any> = {}) : Promise<any> {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const safeLimit: any = Math.max(1, Math.min(200, Number(limit) || 50));
      const activeJobIds: any = [...activeControllers.keys()].filter((jobId?: any) : any =>
        jobMatchesAccess(jobs.get(jobId), access)
      );
      const page: any = jobProjectionStore.list({
        cursor,
        limit: safeLimit,
        access
      });
      const queuedPage: any = jobProjectionStore.listQueued({
        limit: MAX_QUEUED_JOB_IDS_IN_SUMMARY,
        access
      });
      const projection: any = jobProjectionStore.getCounts();
      const counts: any = access
        ? Object.fromEntries(
            ["queued", "running", "completed", "failed", "cancelled"].map(
              (status?: any) : any => [
                status,
                page.items.filter((job?: any) : any => job.status === status).length
              ]
            )
          )
        : projection.counts;
      const queuedJobIds: any = queuedPage.items.map((job?: any) : any => job.id);

      return {
        summary: {
          totalCount: access ? page.items.length : projection.totalCount,
          queuedCount: Number(counts.queued || 0),
          runningCount: Number(counts.running || 0),
          completedCount: Number(counts.completed || 0),
          failedCount: Number(counts.failed || 0),
          cancelledCount: Number(counts.cancelled || 0),
          activeJobId: activeJobIds[0] || "",
          activeJobIds,
          workerConcurrency: processingEnabled ? workerConcurrency : 0,
          processingMode: processingEnabled ? "internal" : "external",
          schedulerMode: "platform-work-queue",
          queuedJobIds,
          queuedJobIdsTruncated:
            access
              ? !queuedPage.done
              : Number(counts.queued || 0) > queuedJobIds.length
        },
        items: page.items.map((job?: any) : any => cloneJobForApi(job)),
        nextCursor: page.nextCursor,
        done: page.done
      };
    },

    async maintainHistory() : Promise<any> {
      await ready;
      const maintenance: any = jobProjectionStore.maintain();
      const reconciliation: any = await reconcileJobProjectionArtifacts({
        userDataPath,
        projectionStore: jobProjectionStore
      });
      return { ...maintenance, ...reconciliation };
    },

    async getJobByCheckpointId(checkpointId?: any) : Promise<any> {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const normalized: any = normalizeCheckpointId(checkpointId);
      const activeJobId: any = checkpointJobs.get(normalized);
      return cloneJobForApi(
        jobs.get(activeJobId) ||
        jobProjectionStore.getByCheckpoint(normalized)
      );
    },

    async getJobResult(jobId?: any) : Promise<any> {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const currentJob: any = jobs.get(jobId) || jobProjectionStore.get(jobId);

      if (!currentJob) {
        return null;
      }

      if (currentJob.status !== "completed") {
        throw new Error("任务尚未完成，暂时不能读取结果。");
      }

      return loadJobResult(userDataPath, jobId, jobProjectionStore);
    },

    async deleteJob(jobId?: any) : Promise<any> {
      logJob("warn", "jobs.job.delete.requested", {
        jobId
      });
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const currentJob: any = jobs.get(jobId) || jobProjectionStore.get(jobId);

      if (!currentJob) {
        logJob("warn", "jobs.job.delete.skipped", {
          jobId,
          reason: "job_missing"
        });
        return null;
      }

      const deleteReturnJob: any = currentJob.status === "failed" && !currentJob.resultSummary && Number(currentJob.progressPercent || 0) <= 3
        ? {
            ...currentJob,
            status: "queued",
            stage: currentJob.stage === "任务恢复失败" ? currentJob.stage : "等待执行"
          }
        : currentJob;

      const currentActiveController: any = activeControllers.get(jobId);
      if (currentActiveController && typeof currentActiveController.delete === "function") {
        return currentActiveController.delete();
      }

      if (currentJob.status === "running") {
        if (!processingEnabled) {
          throw new Error("任务由外部处理器执行，当前不能从 API 进程直接删除运行中的任务。");
        }
        const activeController: any = activeControllers.get(jobId);
        if (!activeController || typeof activeController.delete !== "function") {
          throw new Error("运行中的任务当前不可删除。");
        }

        return activeController.delete();
      }

      jobs.delete(jobId);
      forgetActiveManifestJob(currentJob);
      if (currentJob.checkpointId) {
        checkpointJobs.delete(currentJob.checkpointId);
      }
      if (currentJob.uploadSessionId) {
        await deleteUploadSession(userDataPath, currentJob.uploadSessionId);
      }
      if (currentJob.checkpointTreeId) {
        await deleteCheckpointTree({
          userDataPath,
          treeId: currentJob.checkpointTreeId
        }).catch(() : any => null);
      }
      if (currentJob.status !== "completed") {
        await durableWorkflows.failWorkflow(currentJob.workflowId || workflowIdForJob(currentJob), "Job deleted.").catch(() : any => null);
      }
      jobProjectionStore.delete(jobId);
      await fs.rm(getJobDirectory(userDataPath, jobId), {
        recursive: true,
        force: true
      });
      jobProjectionStore.settleDeletion(jobId);
      await publishDeletedJobEvent(currentJob);
      logJob("info", "jobs.job.deleted", {
        jobId,
        wasRunning: false,
        status: deleteReturnJob.status
      });
      return cloneJobForApi(deleteReturnJob);
    },

    async cancelJob(jobId?: any) : Promise<any> {
      logJob("warn", "jobs.job.cancel.requested", { jobId });
      await ready;
      if (!processingEnabled) await refreshPersistedJobs();
      const currentJob: any = jobs.get(jobId) || jobProjectionStore.get(jobId);
      if (!currentJob) return null;
      if (["completed", "failed", "cancelled"].includes(currentJob.status)) {
        return cloneJobForApi(currentJob);
      }
      const activeController: any = activeControllers.get(jobId);
      if (activeController?.cancel) return activeController.cancel();
      if (currentJob.status === "running") {
        const error: Error & Record<string, any> = new Error("Running job cancellation is waiting for its queue execution fence.");
        error.code = "job_cancellation_fence_required";
        throw error;
      }
      const finishedAt: any = new Date().toISOString();
      await durableWorkflows.failWorkflow(
        currentJob.workflowId || workflowIdForJob(currentJob),
        "Job cancelled."
      ).catch(() : any => null);
      const cancelledJob: any = await updateJob(jobId, {
        status: "cancelled",
        stage: "任务已取消",
        error: "",
        finishedAt,
        eventType: "jobs.job.cancelled"
      });
      return cloneJobForApi(cancelledJob);
    },

    async failJobFromQueue(jobId?: any, { stage = "队列执行失败", reason = "Queue execution failed." }: Record<string, any> = {}) : Promise<any> {
      await ready;
      if (!processingEnabled) await refreshPersistedJobs();
      const currentJob: any = jobs.get(jobId) || jobProjectionStore.get(jobId);
      if (!currentJob) return null;
      if (["completed", "failed", "cancelled"].includes(currentJob.status)) {
        return cloneJobForApi(currentJob);
      }
      const activeController: any = activeControllers.get(jobId);
      if (activeController?.fail) {
        return activeController.fail({ stage, errorMessage: reason });
      }
      return cloneJobForApi(await failJob(jobId, reason, stage));
    },

    close() : any {
      if (closePromise) return closePromise;
      state.closed = true;
      closePromise = (async () : Promise<any> => {
        logJob("info", "jobs.manager.close.started", {});
        try {
          await ready;
          await Promise.all(
            [...activeControllers.values()].map((activeController?: any) : any =>
              activeController.preserveForRecovery()
            )
          );
          await drainBackgroundTasks();
          logJob("info", "jobs.manager.close.completed", {});
        } finally {
          jobProjectionStore.close();
        }
      })().catch((error?: any) : any => {
        closePromise = null;
        throw error;
      });
      return closePromise;
    }
  };
}
