import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { deleteCheckpointTree, resolveStoredObjectPath, serverToken, summarizeForLog, traceDetails } from "#lico/product-api";
import { deleteUploadSession } from "../../state/upload-session-store.mjs";
import { getJobDirectory } from "./job-manager-validation.mjs";
import { loadJobPayload, loadJobResult, persistJobMeta, persistJobPayload } from "./job-manager-persistence.mjs";
import { reconcileJobProjectionArtifacts } from "./job-projection-recovery.mjs";
import {
  canReuseJobForPayload,
  normalizeArchiveBatchId,
  normalizeCheckpointId,
  normalizeManifestKey,
  normalizeParentJobId,
  normalizeVersionGroupId,
  shouldForceNewJobVersion
} from "./job-manager-validation.mjs";

const MAX_QUEUED_JOB_IDS_IN_SUMMARY = 200;

function jobMatchesAccess(job, access) {
  if (!access) return true;
  const values = (input) => new Set(
    (Array.isArray(input) ? input : []).map(String).filter(Boolean)
  );
  const jobIds = values(access.jobIds);
  if (jobIds.has(String(job?.id || ""))) return true;
  const workspaceIds = values(access.workspaceIds);
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
  const principals = values(access.principalIds);
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
  ].some((value) => principals.has(String(value || "")));
}

export function createJobManagerApi(ctx) {
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
    loadJobPayload: loadJobPayloadFromContext,
    drainBackgroundTasks
  } = ctx;

  let closePromise = null;

  return {
    async createJob(payload) {
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

      const checkpointId = normalizeCheckpointId(payload);
      const manifestKey = normalizeManifestKey(payload);
      const archiveBatchId = normalizeArchiveBatchId(payload) || serverToken("archive_batch", checkpointId || manifestKey || randomUUID());
      const forceNewVersion = shouldForceNewJobVersion(payload);
      const versionGroupId = normalizeVersionGroupId(payload, {
        checkpointId,
        manifestKey,
        archiveBatchId
      });
      const versionNumber = 1;
      const parentJobId = normalizeParentJobId(payload);
      const existingCheckpointJob = checkpointId
        ? jobs.get(checkpointJobs.get(checkpointId)) ||
          jobProjectionStore.getByCheckpoint(checkpointId)
        : null;
      if (!forceNewVersion && existingCheckpointJob) {
        const existingJob = existingCheckpointJob;
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
      const existingManifestJob =
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

      const now = new Date().toISOString();
      const trace = traceDetails();
      const job = {
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
      } catch (error) {
        const concurrent = manifestKey
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
      } catch (error) {
        await durableWorkflows.failWorkflow(
          job.workflowId,
          "Job admission failed."
        ).catch(() => null);
        await deleteCheckpointTree({
          userDataPath,
          treeId: job.checkpointTreeId
        }).catch(() => null);
        jobProjectionStore.delete(job.id);
        const directoryRemoved = await fs.rm(
          getJobDirectory(userDataPath, job.id),
          {
          recursive: true,
          force: true
          }
        ).then(() => true, () => false);
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

    async reparseJob(jobId, options = {}) {
      logJob("info", "jobs.job.reparse.requested", {
        jobId,
        options: summarizeForLog(options)
      });
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const sourceJob = jobs.get(jobId) || jobProjectionStore.get(jobId);
      if (!sourceJob) {
        throw new Error("历史任务不存在，不能重新解析。");
      }

      const sourcePayload = await loadJobPayload(
        userDataPath,
        sourceJob.id,
        jobProjectionStore
      );
      const sourceResult = sourceJob.status === "completed"
        ? await this.getJobResult(sourceJob.id).catch(() => null)
        : null;
      const sourceFiles = Array.isArray(sourceResult?.sourceFiles) ? sourceResult.sourceFiles : [];
      const replayUploadedFiles = [];
      const replayTextSections = [];

      for (const [index, source] of sourceFiles.entries()) {
        const record = source && typeof source === "object" ? source : {};
        const storageRelativePath = String(record.storageRelativePath || "").trim();
        if (storageRelativePath) {
          const stagedPath = resolveStoredObjectPath(userDataPath, storageRelativePath);
          try {
            const stats = await fs.stat(stagedPath);
            if (stats.isFile()) {
              const originalName = String(
                record.originalFileName ||
                  record.originalRelativePath ||
                  record.name ||
                  `source-${index + 1}`
              );
              replayUploadedFiles.push({
                name: String(record.rawObjectId || record.id || originalName),
                relativePath: String(record.originalRelativePath || originalName),
                originalFileName: originalName,
                mediaType: String(record.mediaType || "application/octet-stream"),
                stagedPath,
                sha256: String(record.rawObjectSha256 || record.contentHash || ""),
                byteSize: Number(record.rawObjectByteSize || stats.size || 0),
                clientUid: String(record.clientUid || sourcePayload?.clientUid || ""),
                sourceType: String(record.sourceType || sourcePayload?.sourceType || "upload"),
                providerId: String(record.providerId || ""),
                externalId: String(record.externalId || ""),
                syncBatchId: String(record.syncBatchId || ""),
                contentHash: String(record.contentHash || record.rawObjectSha256 || ""),
                capturedAt: String(record.capturedAt || ""),
                sourceMetadata:
                  record.sourceMetadata && typeof record.sourceMetadata === "object" && !Array.isArray(record.sourceMetadata)
                    ? record.sourceMetadata
                    : {}
              });
              continue;
            }
          } catch {
            // Fall back to the parsed text snapshot below when the raw object is no longer available.
          }
        }

        const text = String(record.text || "").trim();
        if (text) {
          const name = String(record.originalFileName || record.name || `source-${index + 1}`);
          replayTextSections.push(`# ${name}\n\n${text}`);
        }
      }

      const replayInputText =
        replayTextSections.length > 0
          ? replayTextSections.join("\n\n---\n\n")
          : String(sourcePayload?.inputText || "").trim();
      const hasReplayInput =
        replayUploadedFiles.length > 0 ||
          replayInputText.length > 0;

      if (!hasReplayInput) {
        throw new Error("历史任务没有保留可重新解析的原始文件或正文。请重新上传原文件后再解析。");
      }

      const checkpointId = normalizeCheckpointId(sourcePayload || sourceJob);
      const manifestKey = normalizeManifestKey(sourcePayload || sourceJob);
      const versionGroupId = normalizeVersionGroupId(sourceJob.versionGroupId ? sourceJob : sourcePayload || sourceJob, {
        checkpointId,
        manifestKey,
        archiveBatchId: sourceJob.archiveBatchId || ""
      });
      const archiveBatchId = serverToken("archive_batch", versionGroupId, randomUUID());
      const checkpointReceipt = {
        ...(sourcePayload?.checkpointReceipt || sourceJob.checkpointReceipt || {}),
        checkpointId,
        archiveBatchId,
        versionGroupId,
        reparseFromJobId: sourceJob.id
      };
      const checkpoint = {
        ...(sourcePayload?.checkpoint || {}),
        checkpointId,
        archiveBatchId
      };
      const reparsePayload = {
        ...(sourcePayload || {}),
        inputText: replayUploadedFiles.length > 0
          ? ""
          : replayInputText,
        filePaths: [],
        uploadedFiles: replayUploadedFiles,
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
      const job = await this.createJob(reparsePayload);
      logJob("info", "jobs.job.reparse.created", {
        parentJobId: sourceJob.id,
        jobId: job?.id || "",
        versionGroupId,
        archiveBatchId
      });
      return job;
    },

    async dispatchQueuedJob(jobId, options = {}) {
      await ready;
      if (!processingEnabled) {
        throw new Error("后台任务执行器未启用，不能调度平台任务。");
      }
      if (state.closed) {
        throw new Error("后台任务管理器已经关闭。");
      }
      const normalizedJobId = String(jobId || options.jobId || "").trim();
      if (!normalizedJobId) {
        throw new Error("jobId is required.");
      }
      const currentJob = jobs.get(normalizedJobId) || null;
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
      const payload = options.payload || await loadJobPayload(
        userDataPath,
        normalizedJobId,
        jobProjectionStore
      );
      if (!payload) {
        throw new Error(`任务缺少 payload，不能调度：${normalizedJobId}`);
      }
      const completed = await runQueuedJob({
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

    async getJob(jobId) {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      return cloneJobForApi(
        jobs.get(jobId) || jobProjectionStore.get(jobId)
      );
    },

    async getJobWorkflow(jobId) {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const currentJob = jobs.get(jobId) || jobProjectionStore.get(jobId);
      if (!currentJob) {
        return null;
      }
      return durableWorkflows.getWorkflow(currentJob.workflowId || workflowIdForJob(currentJob));
    },

    async listJobWorkflows(input = {}) {
      await ready;
      return durableWorkflows.listWorkflows({
        ownerKind: "import_parse_job",
        ...input
      });
    },

    async listJobOwnerships({ cursor = "", limit = 100 } = {}) {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      return jobProjectionStore.listOwnerships({ cursor, limit });
    },

    async listQueuedJobAdmissions({ cursor = "", limit = 100 } = {}) {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const page = jobProjectionStore.listQueued({ cursor, limit });
      return {
        ...page,
        items: page.items.map((job) => cloneJobForApi(job))
      };
    },

    async listJobs({ cursor = "", limit = 50, access = null } = {}) {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
      const activeJobIds = [...activeControllers.keys()].filter((jobId) =>
        jobMatchesAccess(jobs.get(jobId), access)
      );
      const page = jobProjectionStore.list({
        cursor,
        limit: safeLimit,
        access
      });
      const queuedPage = jobProjectionStore.listQueued({
        limit: MAX_QUEUED_JOB_IDS_IN_SUMMARY,
        access
      });
      const projection = jobProjectionStore.getCounts();
      const counts = access
        ? Object.fromEntries(
            ["queued", "running", "completed", "failed", "cancelled"].map(
              (status) => [
                status,
                page.items.filter((job) => job.status === status).length
              ]
            )
          )
        : projection.counts;
      const queuedJobIds = queuedPage.items.map((job) => job.id);

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
        items: page.items.map((job) => cloneJobForApi(job)),
        nextCursor: page.nextCursor,
        done: page.done
      };
    },

    async maintainHistory() {
      await ready;
      const maintenance = jobProjectionStore.maintain();
      const reconciliation = await reconcileJobProjectionArtifacts({
        userDataPath,
        projectionStore: jobProjectionStore
      });
      return { ...maintenance, ...reconciliation };
    },

    async getJobByCheckpointId(checkpointId) {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const normalized = normalizeCheckpointId(checkpointId);
      const activeJobId = checkpointJobs.get(normalized);
      return cloneJobForApi(
        jobs.get(activeJobId) ||
        jobProjectionStore.getByCheckpoint(normalized)
      );
    },

    async getJobResult(jobId) {
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const currentJob = jobs.get(jobId) || jobProjectionStore.get(jobId);

      if (!currentJob) {
        return null;
      }

      if (currentJob.status !== "completed") {
        throw new Error("任务尚未完成，暂时不能读取结果。");
      }

      return loadJobResult(userDataPath, jobId, jobProjectionStore);
    },

    async deleteJob(jobId) {
      logJob("warn", "jobs.job.delete.requested", {
        jobId
      });
      await ready;
      if (!processingEnabled) {
        await refreshPersistedJobs();
      }
      const currentJob = jobs.get(jobId) || jobProjectionStore.get(jobId);

      if (!currentJob) {
        logJob("warn", "jobs.job.delete.skipped", {
          jobId,
          reason: "job_missing"
        });
        return null;
      }

      const deleteReturnJob = currentJob.status === "failed" && !currentJob.resultSummary && Number(currentJob.progressPercent || 0) <= 3
        ? {
            ...currentJob,
            status: "queued",
            stage: currentJob.stage === "任务恢复失败" ? currentJob.stage : "等待执行"
          }
        : currentJob;

      const currentActiveController = activeControllers.get(jobId);
      if (currentActiveController && typeof currentActiveController.delete === "function") {
        return currentActiveController.delete();
      }

      if (currentJob.status === "running") {
        if (!processingEnabled) {
          throw new Error("任务由外部处理器执行，当前不能从 API 进程直接删除运行中的任务。");
        }
        const activeController = activeControllers.get(jobId);
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
        }).catch(() => null);
      }
      if (currentJob.status !== "completed") {
        await durableWorkflows.failWorkflow(currentJob.workflowId || workflowIdForJob(currentJob), "Job deleted.").catch(() => null);
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

    async cancelJob(jobId) {
      logJob("warn", "jobs.job.cancel.requested", { jobId });
      await ready;
      if (!processingEnabled) await refreshPersistedJobs();
      const currentJob = jobs.get(jobId) || jobProjectionStore.get(jobId);
      if (!currentJob) return null;
      if (["completed", "failed", "cancelled"].includes(currentJob.status)) {
        return cloneJobForApi(currentJob);
      }
      const activeController = activeControllers.get(jobId);
      if (activeController?.cancel) return activeController.cancel();
      if (currentJob.status === "running") {
        const error = new Error("Running job cancellation is waiting for its queue execution fence.");
        error.code = "job_cancellation_fence_required";
        throw error;
      }
      const finishedAt = new Date().toISOString();
      await durableWorkflows.failWorkflow(
        currentJob.workflowId || workflowIdForJob(currentJob),
        "Job cancelled."
      ).catch(() => null);
      const cancelledJob = await updateJob(jobId, {
        status: "cancelled",
        stage: "任务已取消",
        error: "",
        finishedAt,
        eventType: "jobs.job.cancelled"
      });
      return cloneJobForApi(cancelledJob);
    },

    async failJobFromQueue(jobId, { stage = "队列执行失败", reason = "Queue execution failed." } = {}) {
      await ready;
      if (!processingEnabled) await refreshPersistedJobs();
      const currentJob = jobs.get(jobId) || jobProjectionStore.get(jobId);
      if (!currentJob) return null;
      if (["completed", "failed", "cancelled"].includes(currentJob.status)) {
        return cloneJobForApi(currentJob);
      }
      const activeController = activeControllers.get(jobId);
      if (activeController?.fail) {
        return activeController.fail({ stage, errorMessage: reason });
      }
      return cloneJobForApi(await failJob(jobId, reason, stage));
    },

    close() {
      if (closePromise) return closePromise;
      state.closed = true;
      closePromise = (async () => {
        logJob("info", "jobs.manager.close.started", {});
        try {
          await ready;
          await Promise.all(
            [...activeControllers.values()].map((activeController) =>
              activeController.preserveForRecovery()
            )
          );
          await drainBackgroundTasks();
          logJob("info", "jobs.manager.close.completed", {});
        } finally {
          jobProjectionStore.close();
        }
      })().catch((error) => {
        closePromise = null;
        throw error;
      });
      return closePromise;
    }
  };
}
