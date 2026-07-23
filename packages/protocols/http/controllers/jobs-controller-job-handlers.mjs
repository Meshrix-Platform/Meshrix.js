import { randomUUID } from "node:crypto";
import { hashClientString } from "#lico/client-strings";
import { sendJson } from "#lico/http-utils";
import {
  authSubjectFromSession,
  canAccessAllJobs,
  canAccessJob,
  filterJobsForCaller,
  requestOwnerSubjectFromSession,
  sendForbiddenJob
} from "./jobs-controller-access.mjs";
import { publishProtocolEvent } from "./jobs-controller-events.mjs";
import { createUploadTracePublisher } from "./jobs-controller-upload-trace.mjs";
import { verifyUploadedFiles } from "./jobs-controller-upload-verification.mjs";

function shouldForwardRequest(discoveryState = {}) {
  return (
    discoveryState.mode === "forward" &&
    discoveryState.forwardBaseUrl &&
    discoveryState.forwardBaseUrl !== discoveryState.advertisedBaseUrl
  );
}

export function createJobHandlers({
  userDataPath,
  checkpointUploadSessionStore,
  jobWorkflow,
  deletionCoordinator,
  getDiscoveryState,
  proxyApiRequest,
  protocolEventBus,
  resolveArchiveBatchIdentity
}) {
  return {
    async handleCreateJob({ request, requestBody, response, authSession }) {
      const payload = requestBody.length > 0 ? JSON.parse(requestBody.toString("utf8")) : {};
      const ownerSubject = requestOwnerSubjectFromSession(authSession);
      const forceNewVersion = Boolean(
        payload?.forceNewVersion ||
          payload?.reparse ||
          payload?.createNewVersion ||
          payload?.reparseFromJobId
      );
      const uploadTrace = payload?.uploadSessionId
        ? createUploadTracePublisher(protocolEventBus, randomUUID(), {
            http: {
              method: "POST",
              path: "/api/jobs"
            },
            sessionId: String(payload.uploadSessionId || "")
          })
        : null;
      if (uploadTrace) {
        await uploadTrace({
          functionName: "handleCreateJob",
          stage: "request_received",
          message: "收到基于 upload session 创建任务的请求。",
          request: {
            uploadSessionId: String(payload.uploadSessionId || ""),
            checkpointPresent: Boolean(payload?.checkpoint?.checkpointId),
            uploadedFilesCount: Array.isArray(payload.uploadedFiles) ? payload.uploadedFiles.length : 0,
            filePathsCount: Array.isArray(payload.filePaths) ? payload.filePaths.length : 0,
            inputTextBytes: Buffer.byteLength(String(payload.inputText || ""), "utf8")
          }
        });
      }
      const discoveryState = getDiscoveryState();
      const shouldForwardJobCreate =
        shouldForwardRequest(discoveryState) &&
        !payload?.uploadSessionId;

      if (shouldForwardJobCreate) {
        await proxyApiRequest({
          request,
          response,
          requestBody,
          targetBaseUrl: discoveryState.forwardBaseUrl || discoveryState.activeServiceUrl,
          discoveryState
        });
        return;
      }

      let verifiedUpload;
      if (payload?.uploadSessionId) {
        if (uploadTrace) {
          await uploadTrace({
            functionName: "buildCheckpointReceiptFromUploadSession",
            stage: "start",
            message: "开始把 upload session 转换为 checkpoint receipt。"
          });
        }
        try {
          verifiedUpload = {
            receipt: await checkpointUploadSessionStore.buildCheckpointReceiptFromUploadSession(
              userDataPath,
              payload.uploadSessionId,
              { owner: ownerSubject }
            ),
            uploadedFiles: []
          };
        } catch (error) {
          if (uploadTrace) {
            await uploadTrace({
              functionName: "buildCheckpointReceiptFromUploadSession",
              stage: "failed",
              level: "error",
              message: "upload session 转换 checkpoint receipt 失败。",
              error: String(error?.message || error)
            });
          }
          throw error;
        }
        if (
          !ownerSubject.canAccessAll &&
          verifiedUpload.receipt.ownerSubjectId &&
          verifiedUpload.receipt.ownerSubjectId !== ownerSubject.subjectId
        ) {
          throw new Error("upload session 归属与任务创建主体不一致。");
        }
        if (uploadTrace) {
          await uploadTrace({
            functionName: "buildCheckpointReceiptFromUploadSession",
            stage: "completed",
            message: "upload session 已转换为 checkpoint receipt。",
            checkpointId: verifiedUpload.receipt.checkpointId,
            manifestSha256: verifiedUpload.receipt.manifestSha256,
            fileCount: verifiedUpload.receipt.fileCount
          });
        }
      } else {
        verifiedUpload = verifyUploadedFiles(payload, { resolveArchiveBatchIdentity });
      }
      const checkpointReceipt = verifiedUpload.receipt;
      const existingCheckpointJob = await jobWorkflow.getJobByCheckpointId(checkpointReceipt.checkpointId);
      if (!forceNewVersion && existingCheckpointJob) {
        if (!canAccessJob(existingCheckpointJob, authSession)) {
          payload.forceNewVersion = true;
          payload.createNewVersion = true;
        } else {
          await publishProtocolEvent(
            protocolEventBus,
            "jobs.job",
            { job: existingCheckpointJob },
            { type: "jobs.job.reused" }
          );
          if (uploadTrace) {
            await uploadTrace({
              functionName: "handleCreateJob",
              stage: "job_reused",
              message: "checkpoint 已存在任务，复用原任务。",
              checkpointId: checkpointReceipt.checkpointId,
              jobId: existingCheckpointJob.id,
              status: existingCheckpointJob.status
            });
          }
          sendJson(response, 202, existingCheckpointJob);
          return;
        }
      }

      const jobPayload = {
        ...payload,
        ownerSubjectId: ownerSubject.subjectId,
        ownerUserId: ownerSubject.userId || ownerSubject.subjectId,
        ownerUsername: ownerSubject.username,
        ownerRoleId: ownerSubject.roleId,
        ownerTenantId: ownerSubject.tenantId,
        workspaceId: String(payload.workspaceId || payload.workspace || "").trim(),
        checkpoint: {
          checkpointId: checkpointReceipt.checkpointId,
          archiveBatchId: checkpointReceipt.archiveBatchId || "",
          clientUid: checkpointReceipt.clientUid || "",
          sourceType: checkpointReceipt.sourceType || "",
          providerId: checkpointReceipt.providerId || "",
          externalId: checkpointReceipt.externalId || "",
          syncBatchId: checkpointReceipt.syncBatchId || "",
          contentHash: checkpointReceipt.contentHash || "",
          capturedAt: checkpointReceipt.capturedAt || "",
          modeHash: hashClientString(payload?.checkpoint?.mode || "", "checkpoint.mode")
        },
        checkpointId: checkpointReceipt.checkpointId,
        archiveBatchId: checkpointReceipt.archiveBatchId || "",
        clientUid: checkpointReceipt.clientUid || "",
        sourceType: checkpointReceipt.sourceType || "",
        providerId: checkpointReceipt.providerId || "",
        externalId: checkpointReceipt.externalId || "",
        syncBatchId: checkpointReceipt.syncBatchId || "",
        contentHash: checkpointReceipt.contentHash || "",
        capturedAt: checkpointReceipt.capturedAt || "",
        filePaths: [],
        uploadedFiles: verifiedUpload.uploadedFiles,
        settings: payload.settings || {},
        checkpointReceipt
      };
      const job = await jobWorkflow.createJob(jobPayload);
      if (uploadTrace) {
        await uploadTrace({
          functionName: "handleCreateJob",
          stage: "job_created",
          message: "已创建上传解析任务。",
          checkpointId: checkpointReceipt.checkpointId,
          jobId: job.id,
          status: job.status
        });
      }

      sendJson(response, 202, job);
    },

    async handleListJobs({ limit, response, authSession }) {
      const subject = authSubjectFromSession(authSession);
      const access = !subject.present || canAccessAllJobs(subject)
        ? null
        : {
            principalIds: [
              subject.subjectId,
              subject.userId,
              subject.username
            ],
            workspaceIds: subject.allowedWorkspaceIds,
            jobIds: subject.allowedJobIds
          };
      sendJson(
        response,
        200,
        filterJobsForCaller(
          await jobWorkflow.listJobs({ limit, access }),
          authSession
        )
      );
    },

    async handleGetJob({ request, requestBody, jobId, response, authSession }) {
      const job = await jobWorkflow.getJob(jobId);

      if (job) {
        if (!canAccessJob(job, authSession)) {
          sendForbiddenJob(response);
          return;
        }
        sendJson(response, 200, job);
        return;
      }

      const discoveryState = getDiscoveryState();
      if (shouldForwardRequest(discoveryState)) {
        await proxyApiRequest({
          request,
          response,
          requestBody,
          targetBaseUrl: discoveryState.forwardBaseUrl || discoveryState.activeServiceUrl,
          discoveryState
        });
        return;
      }

      sendJson(response, 404, {
        error: "任务不存在。"
      });
    },

    async handleReparseJob({ request, requestBody, jobId, response, authSession }) {
      const payload = requestBody.length > 0 ? JSON.parse(requestBody.toString("utf8")) : {};
      const discoveryState = getDiscoveryState();
      if (shouldForwardRequest(discoveryState)) {
        await proxyApiRequest({
          request,
          response,
          requestBody,
          targetBaseUrl: discoveryState.forwardBaseUrl || discoveryState.activeServiceUrl,
          discoveryState
        });
        return;
      }

      const sourceJob = await jobWorkflow.getJob(jobId);
      if (sourceJob && !canAccessJob(sourceJob, authSession)) {
        sendForbiddenJob(response);
        return;
      }
      const ownerSubject = authSubjectFromSession(authSession);
      const reparseOptions = {
        settings: payload?.settings
      };
      if (ownerSubject.present) {
        reparseOptions.ownerSubjectId = ownerSubject.subjectId;
        reparseOptions.ownerUserId = ownerSubject.userId;
        reparseOptions.ownerUsername = ownerSubject.username;
        reparseOptions.ownerRoleId = ownerSubject.roleId;
        reparseOptions.ownerTenantId = ownerSubject.tenantId;
      }
      const job = await jobWorkflow.reparseJob(jobId, reparseOptions);
      await publishProtocolEvent(
        protocolEventBus,
        "jobs.job",
        { job, parentJobId: jobId },
        { type: "jobs.job.reparse.created" }
      );
      sendJson(response, 202, job);
    },

    async handleDeleteJob({ request, requestBody, jobId, response, authSession }) {
      const job = await jobWorkflow.getJob(jobId);
      if (job && !canAccessJob(job, authSession)) {
        sendForbiddenJob(response);
        return;
      }
      const deletionResult = await deletionCoordinator.deleteBatch(jobId);

      if (deletionResult?.ok) {
        await publishProtocolEvent(
          protocolEventBus,
          "jobs.deleted",
          deletionResult,
          { type: "jobs.deleted" }
        );
        sendJson(response, 200, deletionResult);
        return;
      }

      const discoveryState = getDiscoveryState();
      if (shouldForwardRequest(discoveryState)) {
        await proxyApiRequest({
          request,
          response,
          requestBody,
          targetBaseUrl: discoveryState.forwardBaseUrl || discoveryState.activeServiceUrl,
          discoveryState
        });
        return;
      }

      sendJson(response, 404, {
        error: "任务不存在。"
      });
    },

    async handleCancelJob({ jobId, response, authSession }) {
      const job = await jobWorkflow.getJob(jobId);
      if (job && !canAccessJob(job, authSession)) {
        sendForbiddenJob(response);
        return;
      }
      const cancelled = await jobWorkflow.cancelJob(jobId);
      if (!cancelled) {
        sendJson(response, 404, { error: "任务不存在。" });
        return;
      }
      await publishProtocolEvent(
        protocolEventBus,
        "jobs.job",
        { job: cancelled },
        { type: "jobs.job.cancelled" }
      );
      sendJson(response, 200, cancelled);
    }
  };
}
