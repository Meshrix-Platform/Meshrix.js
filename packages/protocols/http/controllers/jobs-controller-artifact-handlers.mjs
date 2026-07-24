import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { contentDispositionHeader, sendJson } from "#meshrix/http-utils";
import {
  canAccessJob,
  canAccessRawObjectEntry,
  sendForbiddenJob
} from "./jobs-controller-access.mjs";

const RAW_OBJECT_DOWNLOAD_CONCURRENCY_LIMIT = 32;

function shouldForwardRequest(discoveryState = {}) {
  return (
    discoveryState.mode === "forward" &&
    discoveryState.forwardBaseUrl &&
    discoveryState.forwardBaseUrl !== discoveryState.advertisedBaseUrl
  );
}

async function proxyMissingJobIfForwarded({
  request,
  requestBody,
  response,
  getDiscoveryState,
  proxyApiRequest
}) {
  const discoveryState = getDiscoveryState();
  if (!shouldForwardRequest(discoveryState)) {
    return false;
  }
  await proxyApiRequest({
    request,
    response,
    requestBody,
    targetBaseUrl: discoveryState.forwardBaseUrl || discoveryState.activeServiceUrl,
    discoveryState
  });
  return true;
}

export function createJobArtifactHandlers({
  userDataPath,
  jobWorkflow,
  storageObjectProvider,
  loadNormalizedDocumentStoreRuntime,
  getDiscoveryState,
  proxyApiRequest
}) {
  let activeRawObjectDownloads = 0;

  return {
    async handleGetJobResult({ request, requestBody, jobId, response, authSession }) {
      const job = await jobWorkflow.getJob(jobId);

      if (job) {
        if (!canAccessJob(job, authSession)) {
          sendForbiddenJob(response);
          return;
        }
        if (job.status !== "completed") {
          sendJson(response, 409, {
            error: "任务尚未完成。"
          });
          return;
        }

        const result = await jobWorkflow.getJobResult(jobId);
        sendJson(response, 200, result);
        return;
      }

      if (await proxyMissingJobIfForwarded({ request, requestBody, response, getDiscoveryState, proxyApiRequest })) {
        return;
      }

      sendJson(response, 404, {
        error: "任务不存在。"
      });
    },

    async handleListNormalizedDocuments({ request, requestBody, jobId, response, authSession }) {
      const job = await jobWorkflow.getJob(jobId);

      if (job) {
        if (!canAccessJob(job, authSession)) {
          sendForbiddenJob(response);
          return;
        }
        if (job.status !== "completed") {
          sendJson(response, 409, {
            error: "任务尚未完成。"
          });
          return;
        }

        try {
          const { loadNormalizedDocumentsManifest } = await loadNormalizedDocumentStoreRuntime();
          sendJson(response, 200, await loadNormalizedDocumentsManifest(userDataPath, jobId));
        } catch (error) {
          if (error?.code === "ENOENT") {
            sendJson(response, 404, {
              error: "归一化文档清单不存在。"
            });
            return;
          }
          throw error;
        }
        return;
      }

      if (await proxyMissingJobIfForwarded({ request, requestBody, response, getDiscoveryState, proxyApiRequest })) {
        return;
      }

      sendJson(response, 404, {
        error: "任务不存在。"
      });
    },

    async handleGetNormalizedDocument({ request, requestBody, jobId, documentId, response, authSession }) {
      const job = await jobWorkflow.getJob(jobId);

      if (job) {
        if (!canAccessJob(job, authSession)) {
          sendForbiddenJob(response);
          return;
        }
        if (job.status !== "completed") {
          sendJson(response, 409, {
            error: "任务尚未完成。"
          });
          return;
        }

        let manifest;
        try {
          const { loadNormalizedDocumentsManifest } = await loadNormalizedDocumentStoreRuntime();
          manifest = await loadNormalizedDocumentsManifest(userDataPath, jobId);
        } catch (error) {
          if (error?.code === "ENOENT") {
            sendJson(response, 404, {
              error: "归一化文档清单不存在。"
            });
            return;
          }
          throw error;
        }

        const {
          normalizedContentType,
          resolveNormalizedDocumentEntry,
          resolveNormalizedDocumentPath
        } = await loadNormalizedDocumentStoreRuntime();
        const entry = resolveNormalizedDocumentEntry(manifest, documentId);
        if (!entry) {
          sendJson(response, 404, {
            error: "归一化文档不存在。"
          });
          return;
        }

        const filePath = resolveNormalizedDocumentPath(userDataPath, jobId, entry);
        const buffer = await fs.readFile(filePath);
        response.writeHead(200, {
          "Content-Type": normalizedContentType(filePath),
          "Content-Disposition": contentDispositionHeader(
            "attachment",
            path.basename(entry.relativePath || entry.title || "normalized-document")
          ),
          "Cache-Control": "no-store"
        });
        response.end(buffer);
        return;
      }

      if (await proxyMissingJobIfForwarded({ request, requestBody, response, getDiscoveryState, proxyApiRequest })) {
        return;
      }

      sendJson(response, 404, {
        error: "任务不存在。"
      });
    },

    async handleGetRawObject({ objectId, response, authSession, signal }) {
      if (!storageObjectProvider) {
        sendJson(response, 404, {
          error: "原始文件存储未启用。"
        });
        return;
      }
      const id = String(objectId || "").trim();
      const storedObject = id ? storageObjectProvider.getObject(id) : null;
      const storageRelativePath = String(storedObject?.storageRelativePath || "").trim();
      const rawObject = storedObject
        ? {
            ...(storedObject.metadata || {}),
            objectId: storedObject.objectId,
            storageRelativePath,
            sha256: storedObject.sha256,
            byteSize: storedObject.byteSize,
            mediaType: storedObject.mediaType
          }
        : null;
      const rawObjectEntry = rawObject && storageRelativePath
        ? {
            rawObject,
            contentType: storedObject.mediaType || "application/octet-stream",
            fileName: rawObject.originalFileName || `${id}.bin`,
            storageRelativePath
          }
        : null;

      if (!rawObjectEntry) {
        sendJson(response, 404, {
          error: "原始邮件不存在。"
        });
        return;
      }

      if (!(await canAccessRawObjectEntry(rawObjectEntry, authSession, jobWorkflow))) {
        sendJson(response, 403, {
          error: "原始邮件不存在或不可访问。"
        });
        return;
      }

      if (activeRawObjectDownloads >= RAW_OBJECT_DOWNLOAD_CONCURRENCY_LIMIT) {
        sendJson(response, 503, {
          error: "原始文件下载容量已满，请稍后重试。",
          code: "raw_object_download_capacity_exceeded"
        });
        return;
      }
      activeRawObjectDownloads += 1;
      let openedObject = null;
      try {
        openedObject = await storageObjectProvider.openObjectReadStream({
          storageRelativePath: rawObjectEntry.storageRelativePath,
          signal
        });
        response.writeHead(200, {
          "Content-Type": rawObjectEntry.contentType || "application/octet-stream",
          "Content-Disposition": contentDispositionHeader("attachment", rawObjectEntry.fileName),
          "Cache-Control": "no-store",
          "Content-Length": openedObject.byteSize
        });
        await pipeline(
          openedObject.stream,
          response,
          signal ? { signal } : {}
        );
      } catch (error) {
        openedObject?.stream.destroy();
        throw error;
      } finally {
        activeRawObjectDownloads -= 1;
      }
    }
  };
}
