import { randomUUID } from "node:crypto";
import { hashClientString } from "#meshrix/client-strings";
import { sendJson } from "#meshrix/http-utils";
import {
  authSubjectFromSession,
  canAccessAllJobs,
  canAccessJob,
  filterJobsForCaller,
  requestOwnerSubjectFromSession,
  sendForbiddenJob
} from "./jobs-controller-access.ts";
import {
  admitJobCreatePayload
} from "./jobs-controller-job-admission.ts";
import { publishProtocolEvent } from "./jobs-controller-events.ts";
import { createUploadTracePublisher } from "./jobs-controller-upload-trace.ts";

function jobCreateError(code?: any) : any {
  return Object.assign(new Error(code), {
    code,
    statusCode: 400
  });
}

function shouldForwardRequest(discoveryState: Record<string, any> = {}) : any {
  return (
    discoveryState.mode === "forward" &&
    discoveryState.forwardBaseUrl &&
    discoveryState.forwardBaseUrl !== discoveryState.advertisedBaseUrl
  );
}

export function createJobHandlers({
  checkpointUploadSessionStore,
  jobWorkflow,
  deletionCoordinator,
  getDiscoveryState,
  proxyApiRequest,
  protocolEventBus,
  resolveArchiveBatchIdentity
}: Record<string, any>) : any {
  return {
    async handleCreateJob({ request, requestBody, response, authSession }: Record<string, any>) : Promise<any> {
      let rawPayload: any;
      try {
        rawPayload = requestBody.length > 0
          ? JSON.parse(requestBody.toString("utf8"))
          : {};
      } catch {
        throw jobCreateError("job_create_payload_invalid_json");
      }
      const admission: any = admitJobCreatePayload(rawPayload, {
        resolveArchiveBatchIdentity
      });
      const payload: any = admission.payload;
      const ownerSubject: any = requestOwnerSubjectFromSession(authSession);
      let checkpointReceipt: any = admission.receipt || null;

      if (admission.kind === "upload-session") {
        checkpointReceipt =
          await checkpointUploadSessionStore.buildCheckpointReceiptFromUploadSession(
            admission.uploadSessionId,
            { owner: ownerSubject }
          );
        if (
          !checkpointReceipt?.ownerSubjectId ||
          checkpointReceipt.ownerSubjectId !== ownerSubject.subjectId
        ) {
          throw jobCreateError("job_create_upload_session_owner_mismatch");
        }
      }

      const uploadTrace: any = admission.kind === "upload-session"
        ? createUploadTracePublisher(protocolEventBus, randomUUID(), {
            http: {
              method: "POST",
              path: "/api/jobs"
            },
            sessionId: admission.uploadSessionId
          })
        : null;
      if (uploadTrace) {
        await uploadTrace({
          functionName: "handleCreateJob",
          stage: "request_received",
          message: "收到基于 upload session 创建任务的请求。",
          request: {
            uploadSessionId: admission.uploadSessionId,
            checkpointPresent: Boolean(payload?.checkpoint?.checkpointId),
            inputKind: admission.kind
          }
        });
        await uploadTrace({
          functionName: "buildCheckpointReceiptFromUploadSession",
          stage: "completed",
          message: "upload session 已转换为 checkpoint receipt。",
          checkpointId: checkpointReceipt.checkpointId,
          manifestSha256: checkpointReceipt.manifestSha256,
          fileCount: checkpointReceipt.fileCount
        });
      }

      const discoveryState: any = getDiscoveryState();
      const shouldForwardJobCreate: any =
        shouldForwardRequest(discoveryState) &&
        admission.kind === "direct-text";

      if (shouldForwardJobCreate) {
        await proxyApiRequest({
          request,
          response,
          requestBody: Buffer.from(JSON.stringify(payload), "utf8"),
          targetBaseUrl: discoveryState.forwardBaseUrl || discoveryState.activeServiceUrl,
          discoveryState
        });
        return;
      }

      let forceNewVersion: any = payload.forceNewVersion === true;
      const existingCheckpointJob: any = await jobWorkflow.getJobByCheckpointId(checkpointReceipt.checkpointId);
      if (!forceNewVersion && existingCheckpointJob) {
        if (!canAccessJob(existingCheckpointJob, authSession)) {
          forceNewVersion = true;
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

      const jobPayload: Record<string, any> = {
        ...payload,
        forceNewVersion,
        ownerSubjectId: ownerSubject.subjectId,
        ownerUserId: ownerSubject.userId || ownerSubject.subjectId,
        ownerUsername: ownerSubject.username,
        ownerRoleId: ownerSubject.roleId,
        ownerTenantId: ownerSubject.tenantId,
        workspaceId: String(payload.workspaceId || "").trim(),
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
        settings: payload.settings || {},
        checkpointReceipt
      };
      const job: any = await jobWorkflow.createJob(jobPayload);
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

    async handleListJobs({ limit, response, authSession }: Record<string, any>) : Promise<any> {
      const subject: any = authSubjectFromSession(authSession);
      const access: any = !subject.present || canAccessAllJobs(subject)
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

    async handleGetJob({ request, requestBody, jobId, response, authSession }: Record<string, any>) : Promise<any> {
      const job: any = await jobWorkflow.getJob(jobId);

      if (job) {
        if (!canAccessJob(job, authSession)) {
          sendForbiddenJob(response);
          return;
        }
        sendJson(response, 200, job);
        return;
      }

      const discoveryState: any = getDiscoveryState();
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

    async handleReparseJob({ request, requestBody, jobId, response, authSession }: Record<string, any>) : Promise<any> {
      const payload: any = requestBody.length > 0 ? JSON.parse(requestBody.toString("utf8")) : {};
      const discoveryState: any = getDiscoveryState();
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

      const sourceJob: any = await jobWorkflow.getJob(jobId);
      if (sourceJob && !canAccessJob(sourceJob, authSession)) {
        sendForbiddenJob(response);
        return;
      }
      const ownerSubject: any = authSubjectFromSession(authSession);
      const reparseOptions: Record<string, any> = {
        settings: payload?.settings
      };
      if (ownerSubject.present) {
        reparseOptions.ownerSubjectId = ownerSubject.subjectId;
        reparseOptions.ownerUserId = ownerSubject.userId;
        reparseOptions.ownerUsername = ownerSubject.username;
        reparseOptions.ownerRoleId = ownerSubject.roleId;
        reparseOptions.ownerTenantId = ownerSubject.tenantId;
      }
      const job: any = await jobWorkflow.reparseJob(jobId, reparseOptions);
      await publishProtocolEvent(
        protocolEventBus,
        "jobs.job",
        { job, parentJobId: jobId },
        { type: "jobs.job.reparse.created" }
      );
      sendJson(response, 202, job);
    },

    async handleDeleteJob({ request, requestBody, jobId, response, authSession }: Record<string, any>) : Promise<any> {
      const job: any = await jobWorkflow.getJob(jobId);
      if (job && !canAccessJob(job, authSession)) {
        sendForbiddenJob(response);
        return;
      }
      const deletionResult: any = await deletionCoordinator.deleteBatch(jobId);

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

      const discoveryState: any = getDiscoveryState();
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

    async handleCancelJob({ jobId, response, authSession }: Record<string, any>) : Promise<any> {
      const job: any = await jobWorkflow.getJob(jobId);
      if (job && !canAccessJob(job, authSession)) {
        sendForbiddenJob(response);
        return;
      }
      const cancelled: any = await jobWorkflow.cancelJob(jobId);
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
