import { randomUUID } from "node:crypto";
import { sendJson } from "#meshrix/http-utils";
import { requestOwnerSubjectFromSession } from "./jobs-controller-access.ts";
import { publishProtocolEvent } from "./jobs-controller-events.ts";
import {
  createUploadTracePublisher,
  summarizeUploadSessionForTrace,
  summarizeUploadSessionPayload
} from "./jobs-controller-upload-trace.ts";

const MATERIALIZATION_ADMISSION_FIELDS: readonly any[] = Object.freeze([
  "uploadSessionId",
  "workspaceId",
  "expectedWorkspaceRevision",
  "logicalTarget",
  "confirm",
  "safetyConfirm"
]);
const MATERIALIZATION_ADMISSION_FIELD_SET: any = new Set<any>(
  MATERIALIZATION_ADMISSION_FIELDS
);

function closedMaterializationInput(input: Record<string, any> = {}) : any {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).some(
      (field?: any) : any => !MATERIALIZATION_ADMISSION_FIELD_SET.has(field)
    )
  ) {
    throw Object.assign(
      new Error("Materialization input is invalid."),
      {
        code: "materialization_input_invalid",
        statusCode: 400
      }
    );
  }
  return Object.freeze(Object.fromEntries(
    MATERIALIZATION_ADMISSION_FIELDS
      .filter((field?: any) : any => Object.hasOwn(input, field))
      .map((field?: any) : any => [field, input[field]])
  ));
}

function publicMaterializationSubmission(result: Record<string, any> = {}) : any {
  return Object.freeze(Object.fromEntries(
    ["accepted", "deduped", "requestRef", "result"]
      .filter((field?: any) : any => Object.hasOwn(result, field))
      .map((field?: any) : any => [field, result[field]])
  ));
}

export function createUploadSessionHandlers({
  checkpointUploadSessionStore,
  protocolEventBus,
  uploadWorkspaceMaterializationProvider
}: Record<string, any>) : any {
  return {
    async handleUploadWorkspaceMaterialize({
      operation,
      input,
      request,
      response,
      authSession
    }: Record<string, any>) : Promise<any> {
      if (!uploadWorkspaceMaterializationProvider) throw new Error("Upload workspace materialization provider is unavailable.");
      const result: any = await uploadWorkspaceMaterializationProvider.submit({
        request,
        authSession,
        operation,
        input: closedMaterializationInput(input)
      });
      sendJson(
        response,
        result.deduped ? 200 : 202,
        publicMaterializationSubmission(result)
      );
    },
    async handleUploadWorkspaceMaterializationCancel({ requestRef, response, authSession }: Record<string, any>) : Promise<any> {
      if (!uploadWorkspaceMaterializationProvider) {
        throw new Error("Upload workspace materialization provider is unavailable.");
      }
      const cancelled: any = await uploadWorkspaceMaterializationProvider.cancel(requestRef, {
        subject: requestOwnerSubjectFromSession(authSession)
      });
      if (!cancelled) {
        sendJson(response, 404, { error: "Materialization request is unavailable." });
        return;
      }
      sendJson(response, 200, cancelled);
    },
    async handleCreateUploadSession({ requestBody, response, authSession }: Record<string, any>) : Promise<any> {
      const requestId: any = randomUUID();
      const ownerSubject: any = requestOwnerSubjectFromSession(authSession);
      const trace: any = createUploadTracePublisher(protocolEventBus, requestId, {
        http: {
          method: "POST",
          path: "/api/upload-sessions"
        }
      });
      const payload: any = requestBody.length > 0 ? JSON.parse(requestBody.toString("utf8")) : {};
      await trace({
        functionName: "handleCreateUploadSession",
        stage: "request_received",
        message: "收到创建或恢复上传会话请求。",
        request: summarizeUploadSessionPayload(payload, requestBody.length)
      });
      try {
        const session: any = await checkpointUploadSessionStore.createOrResumeUploadSession({
          checkpoint: payload?.checkpoint || {},
          manifest: payload?.manifest || {},
          files: Array.isArray(payload?.files) ? payload.files : [],
          owner: ownerSubject,
          trace
        });
        await publishProtocolEvent(
          protocolEventBus,
          "uploads.session",
          { session },
          { type: "uploads.session.upserted" }
        );
        await trace({
          functionName: "handleCreateUploadSession",
          stage: "response_sent",
          message: "上传会话请求已成功响应。",
          http: {
            method: "POST",
            path: "/api/upload-sessions",
            status: 200
          },
          session: summarizeUploadSessionForTrace(session)
        });
        sendJson(response, 200, session);
      } catch (error: any) {
        const statusCode: any = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        await trace({
          functionName: "handleCreateUploadSession",
          stage: "failed",
          level: "error",
          message: "创建或恢复上传会话失败。",
          http: {
            method: "POST",
            path: "/api/upload-sessions",
            status: statusCode
          },
          errorCode: String(error?.code || "upload_session_create_failed")
        });
        if (statusCode < 500) {
          // 客户端输入导致的失败发生在任何受保护副作用之前：直接以该状态码
          // 响应并返回，避免被分发层的“效果存疑”包装改写成 503。
          sendJson(response, statusCode, {
            code: String(error?.code || "upload_session_create_failed"),
            error: String(error?.message || "请求处理失败。")
          });
          return;
        }
        throw error;
      }
    },

    async handleGetUploadSession({ sessionId, response, authSession }: Record<string, any>) : Promise<any> {
      const requestId: any = randomUUID();
      const ownerSubject: any = requestOwnerSubjectFromSession(authSession);
      const trace: any = createUploadTracePublisher(protocolEventBus, requestId, {
        http: {
          method: "GET",
          path: `/api/upload-sessions/${sessionId}`
        },
        sessionId
      });
      await trace({
        functionName: "handleGetUploadSession",
        stage: "request_received",
        message: "收到上传会话查询请求。"
      });
      const session: any = await checkpointUploadSessionStore.getUploadSession(sessionId, {
        owner: ownerSubject
      });
      if (!session) {
        sendJson(response, 404, {
          error: "上传会话不存在。"
        });
        void trace({
          functionName: "handleGetUploadSession",
          stage: "not_found",
          level: "warn",
          message: "上传会话查询未命中。",
          http: {
            method: "GET",
            path: `/api/upload-sessions/${sessionId}`,
            status: 404
          }
        }).catch(() : any => null);
        return;
      }

      await trace({
        functionName: "handleGetUploadSession",
        stage: "response_sent",
        message: "上传会话查询已成功响应。",
        http: {
          method: "GET",
          path: `/api/upload-sessions/${sessionId}`,
          status: 200
        },
        session: summarizeUploadSessionForTrace(session)
      });
      sendJson(response, 200, session);
    },

    async handleUploadChunk({ sessionId, fileIndex, offset, requestBody, response, authSession }: Record<string, any>) : Promise<any> {
      const requestId: any = randomUUID();
      const ownerSubject: any = requestOwnerSubjectFromSession(authSession);
      const trace: any = createUploadTracePublisher(protocolEventBus, requestId, {
        http: {
          method: "PUT",
          path: `/api/upload-sessions/${sessionId}/files/${fileIndex}`
        },
        sessionId,
        fileIndex: Number(fileIndex),
        offset: Number(offset || 0)
      });
      await trace({
        functionName: "handleUploadChunk",
        stage: "request_received",
        message: "收到上传分块请求。",
        chunkBytes: requestBody.length,
        request: {
          queryOffset: Number(offset || 0),
          fileIndex: Number(fileIndex),
          bodyBytes: requestBody.length,
          contentType: "application/octet-stream"
        }
      });
      const appendResult: any = await checkpointUploadSessionStore.appendUploadSessionChunk({
        sessionId,
        fileIndex,
        offset,
        buffer: requestBody,
        owner: ownerSubject,
        trace
      });

      if (!appendResult.ok) {
        const statusCode: any =
          appendResult.code === "not_found"
            ? 404
            : appendResult.code === "session_expired"
              ? 410
              : appendResult.code === "chunk_bytes_exceeded"
                ? 413
            : appendResult.code === "offset_mismatch" ||
                appendResult.code === "chunk_too_large" ||
                appendResult.code === "sha256_mismatch"
              ? 409
              : 400;
        await trace({
          functionName: "handleUploadChunk",
          stage: "response_failed",
          level: appendResult.code === "offset_mismatch" ? "warning" : "error",
          message: "上传分块请求返回失败响应。",
          code: appendResult.code,
          expectedOffset: appendResult.expectedOffset ?? 0,
          http: {
            method: "PUT",
            path: `/api/upload-sessions/${sessionId}/files/${fileIndex}`,
            status: statusCode
          },
          session: summarizeUploadSessionForTrace(appendResult.session)
        });
        sendJson(response, statusCode, {
          code: appendResult.code,
          error:
            appendResult.code === "offset_mismatch"
              ? "上传偏移不匹配。"
              : appendResult.code === "chunk_too_large"
                ? "上传分块超过剩余文件大小。"
                : appendResult.code === "chunk_bytes_exceeded"
                  ? "上传分块超过服务端安全上限。"
                  : appendResult.code === "session_expired"
                    ? "上传会话已过期。"
                : appendResult.code === "sha256_mismatch"
                  ? "上传文件哈希校验失败，已重置该文件上传进度。"
                  : appendResult.code === "file_not_found"
                    ? "上传文件索引不存在。"
                    : "上传会话不存在。",
          expectedOffset: appendResult.expectedOffset ?? 0,
          session: appendResult.session
        });
        return;
      }

      await publishProtocolEvent(
        protocolEventBus,
        "uploads.session",
        { session: appendResult.session },
        { type: "uploads.session.chunk.accepted" }
      );
      await trace({
        functionName: "handleUploadChunk",
        stage: "response_sent",
        message: "上传分块请求已成功响应。",
        http: {
          method: "PUT",
          path: `/api/upload-sessions/${sessionId}/files/${fileIndex}`,
          status: 200
        },
        session: summarizeUploadSessionForTrace(appendResult.session)
      });
      sendJson(response, 200, appendResult.session);
    }
  };
}
