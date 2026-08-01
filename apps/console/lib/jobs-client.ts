import { deleteJson, getJson, postJson } from "@meshrix/ui-console/bridge-http";
import type {
  AgentSettings,
  SplitJob,
  SplitJobListResponse,
  SplitPayload,
  SplitResult,
} from "./types";

export type ReparseJobPayload = {
  settings?: AgentSettings;
};

export function createJob(payload: SplitPayload) : any {
  return postJson<SplitJob>("/api/jobs", payload);
}

export function reparseJob(jobId: string, payload: ReparseJobPayload = {}) : any {
  return postJson<SplitJob>(`/api/jobs/${encodeURIComponent(jobId)}/reparse`, payload);
}

export function listJobs(limit: any = 50) : any {
  return getJson<SplitJobListResponse>(`/api/jobs?limit=${encodeURIComponent(String(limit))}`);
}

export function inspectWorkQueue(limit: any = 100) : any {
  return getJson<any>(`/api/jobs/work-queue?limit=${encodeURIComponent(String(limit))}`);
}

export function pauseWorkQueue(reason: any = "operator_pause") : any {
  return postJson<any>("/api/jobs/work-queue/pause", { reason });
}

export function resumeWorkQueue(reason: any = "operator_resume") : any {
  return postJson<any>("/api/jobs/work-queue/resume", { reason });
}

export function drainWorkQueue(reason: any = "operator_drain") : any {
  return postJson<any>("/api/jobs/work-queue/drain", { reason });
}

export function deleteJob(jobId: string) : any {
  return deleteJson<{ ok: boolean; deletedJob: SplitJob }>(
    `/api/jobs/${encodeURIComponent(jobId)}`,
    { safetyConfirm: true },
  );
}

export function cancelJob(jobId: string) : any {
  return postJson<SplitJob>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {});
}

export function getJob(jobId: string) : any {
  return getJson<SplitJob>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export function getJobResult(jobId: string) : any {
  return getJson<SplitResult>(`/api/jobs/${encodeURIComponent(jobId)}/result`);
}
