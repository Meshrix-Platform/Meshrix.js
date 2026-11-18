import { getJson, postJson, putBinaryJson } from "@meshrix/ui-console/bridge-http";
import type { UploadSessionResponse } from "./types";

export function createUploadSession(payload: Record<string, unknown>) : any {
  return postJson<UploadSessionResponse>("/api/upload-sessions", payload);
}

export function uploadSessionChunk(
  sessionId: string,
  fileIndex: number,
  offset: number,
  chunk: Blob | ArrayBuffer,
) : any {
  return putBinaryJson<UploadSessionResponse>(
    `/api/upload-sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(
      String(fileIndex),
    )}?offset=${encodeURIComponent(String(offset))}`,
    chunk,
  );
}

export function getUploadSession(sessionId: string) : any {
  return getJson<UploadSessionResponse>(`/api/upload-sessions/${encodeURIComponent(sessionId)}`);
}
