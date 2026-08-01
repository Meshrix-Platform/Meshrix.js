import { hashClientString } from "#meshrix/client-strings";
import { publishProtocolEvent } from "./jobs-controller-events.ts";

function hashForTrace(value?: any, label?: any) : any {
  const text: any = String(value || "");
  return text ? hashClientString(text, `upload.trace.${label}`) : "";
}

export function summarizeUploadSessionForTrace(session?: any) : any {
  if (!session) {
    return null;
  }
  return {
    sessionId: session.sessionId || "",
    checkpointId: session.checkpointId || "",
    manifestDigest: session.manifestDigest || "",
    inputDigest: session.inputDigest || "",
    status: session.status || "",
    files: (session.files || []).map((file?: any) : any => ({
      index: file.index ?? file.fileIndex ?? 0,
      name: file.name || "",
      relativePath: file.relativePath || "",
      byteSize: Number(file.byteSize || 0),
      receivedBytes: Number(file.receivedBytes || 0),
      completed: Boolean(file.completed || file.complete)
    }))
  };
}

export function summarizeUploadSessionPayload(payload: Record<string, any> = {}, requestBodyLength: any = 0) : any {
  const checkpoint: any = payload?.checkpoint || {};
  const manifest: any = payload?.manifest || {};
  const files: any = Array.isArray(payload?.files) ? payload.files : [];
  return {
    requestBodyBytes: requestBodyLength,
    keys: Object.keys(payload || {}).sort(),
    checkpoint: {
      checkpointIdPresent: typeof checkpoint.checkpointId === "string" && checkpoint.checkpointId.trim().length > 0,
      checkpointIdHash: hashForTrace(checkpoint.checkpointId, "checkpoint_id"),
      parentCheckpointIdHash: hashForTrace(checkpoint.parentCheckpointId, "parent_checkpoint_id"),
      mode: String(checkpoint.mode || ""),
      inputDigest: String(checkpoint.inputDigest || ""),
      manifestDigest: String(checkpoint.manifestDigest || "")
    },
    manifest: {
      manifestDigestPresent: typeof manifest.manifestDigest === "string" && manifest.manifestDigest.trim().length > 0,
      inputDigestPresent: typeof manifest.inputDigest === "string" && manifest.inputDigest.trim().length > 0,
      manifestDigest: String(manifest.manifestDigest || ""),
      inputDigest: String(manifest.inputDigest || ""),
      fileCount: Number(manifest.fileCount || files.length || 0),
      totalBytes: Number(manifest.totalBytes || 0),
      fileRecordCount: Array.isArray(manifest.fileRecords) ? manifest.fileRecords.length : 0
    },
    files: files.map((file?: any, index?: any) : any => ({
      index,
      nameHash: hashForTrace(file?.name, "file_name"),
      relativePathHash: hashForTrace(file?.relativePath, "file_relative_path"),
      mediaTypeHash: hashForTrace(file?.mediaType, "file_media_type"),
      sha256: String(file?.sha256 || ""),
      byteSize: Number(file?.byteSize || 0)
    })),
    redaction: {
      rawFileNames: "not_logged",
      rawRelativePaths: "not_logged",
      fileBytes: "not_logged"
    }
  };
}

export function createUploadTracePublisher(protocolEventBus?: any, requestId?: any, base: Record<string, any> = {}) : any {
  return async function traceUpload(event: Record<string, any> = {}) : Promise<any> {
    await publishProtocolEvent(
      protocolEventBus,
      "uploads.trace",
      {
        traceVersion: 1,
        level: event.level || "info",
        scope: event.scope || "upload-session",
        layer: event.layer || "controller",
        functionName: event.functionName || "",
        stage: event.stage || "",
        message: event.message || "",
        ...base,
        ...event,
        requestId,
        redaction: {
          rawFileNames: "not_logged",
          rawRelativePaths: "not_logged",
          fileBytes: "not_logged",
          ...(event.redaction || {})
        }
      },
      {
        type: `uploads.trace.${event.stage || "event"}`,
        retain: false
      }
    );
  };
}
