import { deleteJson, getJson, postJson } from "@lico/ui-console/bridge-http";
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

export function createJob(payload: SplitPayload) {
  return postJson<SplitJob>("/api/jobs", payload);
}

export function reparseJob(jobId: string, payload: ReparseJobPayload = {}) {
  return postJson<SplitJob>(`/api/jobs/${encodeURIComponent(jobId)}/reparse`, payload);
}

export function listJobs(limit = 50) {
  return getJson<SplitJobListResponse>(`/api/jobs?limit=${encodeURIComponent(String(limit))}`);
}

export function inspectWorkQueue(limit = 100) {
  return getJson<any>(`/api/jobs/work-queue?limit=${encodeURIComponent(String(limit))}`);
}

export function pauseWorkQueue(reason = "operator_pause") {
  return postJson<any>("/api/jobs/work-queue/pause", { reason });
}

export function resumeWorkQueue(reason = "operator_resume") {
  return postJson<any>("/api/jobs/work-queue/resume", { reason });
}

export function drainWorkQueue(reason = "operator_drain") {
  return postJson<any>("/api/jobs/work-queue/drain", { reason });
}

export function deleteJob(jobId: string) {
  return deleteJson<{ ok: boolean; deletedJob: SplitJob }>(
    `/api/jobs/${encodeURIComponent(jobId)}`,
    { safetyConfirm: true },
  );
}

export function cancelJob(jobId: string) {
  return postJson<SplitJob>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {});
}

export function getJob(jobId: string) {
  return getJson<SplitJob>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export function getJobResult(jobId: string) {
  return getJson<SplitResult>(`/api/jobs/${encodeURIComponent(jobId)}/result`);
}
