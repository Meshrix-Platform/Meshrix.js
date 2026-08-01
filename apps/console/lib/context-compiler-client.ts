import { getJson, postJson } from "@meshrix/ui-console/bridge-http";

export type ContextCompilerResponse = Record<string, unknown>;

export function getContextProfiles() : any {
  return getJson<ContextCompilerResponse>("/api/context/profiles");
}

export function saveContextProfiles(payload: Record<string, unknown>) : any {
  return postJson<ContextCompilerResponse>("/api/context/profiles", payload);
}

export function previewContextPack(payload: Record<string, unknown>) : any {
  return postJson<ContextCompilerResponse>("/api/context/preview", payload);
}

export function listContextBuildRecords(limit: any = 50) : any {
  return getJson<ContextCompilerResponse>(
    `/api/context/build-records?limit=${encodeURIComponent(String(limit))}`,
  );
}

export function runContextEvaluation(payload: Record<string, unknown>) : any {
  return postJson<ContextCompilerResponse>("/api/context/evaluation/runs", payload);
}
