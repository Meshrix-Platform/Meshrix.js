import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveArchiveBatchIdentity } from "../archive-batch-id.mjs";
import {
  isServerToken,
  serverToken
} from "#meshrix/product-api";

export const CLOSE_ABORT_MESSAGE = "服务已关闭，任务已中止。";
export const RECOVERY_STAGE_MESSAGE = "服务已恢复，任务等待重试。";
export const DEFAULT_WORKER_CONCURRENCY = 4;
export const MAX_WORKER_CONCURRENCY = 16;
export const CHECKPOINT_FILE_SAMPLE_LIMIT = 5;
export const SAFE_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function normalizeWorkerConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WORKER_CONCURRENCY;
  }
  return Math.max(1, Math.min(MAX_WORKER_CONCURRENCY, Math.trunc(parsed)));
}

export function getJobsRootPath(userDataPath) {
  return path.join(userDataPath, "jobs");
}

export function assertJobId(jobId) {
  const value = String(jobId || "").trim();
  if (!SAFE_JOB_ID_PATTERN.test(value) || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error("Invalid job id.");
  }
  return value;
}

export function getJobDirectory(userDataPath, jobId) {
  return path.join(getJobsRootPath(userDataPath), assertJobId(jobId));
}

export function getJobMetaPath(userDataPath, jobId) {
  return path.join(getJobDirectory(userDataPath, jobId), "meta.json");
}

export function getJobResultPath(userDataPath, jobId) {
  return path.join(getJobDirectory(userDataPath, jobId), "result.json");
}

export function getJobPayloadPath(userDataPath, jobId) {
  return path.join(getJobDirectory(userDataPath, jobId), "payload.json");
}

export function normalizeCheckpointId(payloadOrValue) {
  const value =
    payloadOrValue && typeof payloadOrValue === "object"
      ? payloadOrValue?.checkpointReceipt?.checkpointId ||
        payloadOrValue?.checkpointId ||
        payloadOrValue?.checkpoint?.checkpointId ||
        ""
      : payloadOrValue;
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return isServerToken(text, "checkpoint") ? text : serverToken("checkpoint", text);
}

export function normalizeManifestKey(payloadOrJob) {
  const value =
    payloadOrJob && typeof payloadOrJob === "object"
      ? payloadOrJob?.checkpointReceipt?.manifestSha256 ||
        payloadOrJob?.checkpointReceipt?.manifestDigest ||
        payloadOrJob?.checkpoint?.manifestDigest ||
        payloadOrJob?.manifestSha256 ||
        ""
      : payloadOrJob;
  const text = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : "";
}

export function normalizeArchiveBatchId(payloadOrJob) {
  const identity = resolveArchiveBatchIdentity({
    archiveBatchId:
      payloadOrJob?.checkpointReceipt?.archiveBatchId ||
      payloadOrJob?.archiveBatchId ||
      payloadOrJob?.checkpoint?.archiveBatchId ||
      "",
    batchId: payloadOrJob?.batchId || payloadOrJob?.checkpoint?.batchId || "",
    clientBatchId: payloadOrJob?.clientBatchId || payloadOrJob?.checkpoint?.clientBatchId || "",
    checkpointId:
      payloadOrJob?.checkpointReceipt?.checkpointId ||
      payloadOrJob?.checkpointId ||
      payloadOrJob?.checkpoint?.checkpointId ||
      "",
    manifestDigest:
      payloadOrJob?.checkpointReceipt?.manifestSha256 ||
      payloadOrJob?.checkpointReceipt?.manifestDigest ||
      payloadOrJob?.checkpoint?.manifestDigest ||
      payloadOrJob?.manifestSha256 ||
      "",
    inputDigest:
      payloadOrJob?.checkpoint?.inputDigest ||
      payloadOrJob?.inputDigest ||
      ""
  });
  return identity.archiveBatchId;
}

export function isTruthyFlag(value) {
  return value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true";
}

export function shouldForceNewJobVersion(payload) {
  return Boolean(
    isTruthyFlag(payload?.forceNewVersion) ||
      isTruthyFlag(payload?.reparse) ||
      isTruthyFlag(payload?.createNewVersion) ||
      payload?.reparseFromJobId ||
      payload?.parentJobId
  );
}

export function jobOwnerIds(jobOrPayload = {}) {
  const owner = jobOrPayload?.owner || {};
  return [
    jobOrPayload?.ownerSubjectId,
    jobOrPayload?.ownerUserId,
    jobOrPayload?.ownerUsername,
    jobOrPayload?.createdBySubjectId,
    jobOrPayload?.createdByUserId,
    jobOrPayload?.createdBy,
    owner.subjectId,
    owner.userId,
    owner.username
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

export function canReuseJobForPayload(existingJob = null, payload = {}) {
  if (!existingJob) {
    return false;
  }
  const existingOwners = jobOwnerIds(existingJob);
  const requestedOwners = jobOwnerIds(payload);
  if (existingOwners.length === 0 || requestedOwners.length === 0) {
    return true;
  }
  return requestedOwners.some((ownerId) => existingOwners.includes(ownerId));
}

export function normalizeVersionGroupId(payloadOrJob, { checkpointId = "", manifestKey = "", archiveBatchId = "" } = {}) {
  const value =
    payloadOrJob && typeof payloadOrJob === "object"
      ? payloadOrJob?.versionGroupId ||
        payloadOrJob?.parseVersionGroupId ||
        payloadOrJob?.checkpointReceipt?.versionGroupId ||
        ""
      : payloadOrJob;
  const explicit = String(value || "").trim();
  if (explicit) {
    return isServerToken(explicit, "parse_version_group")
      ? explicit
      : serverToken("parse_version_group", explicit);
  }
  const stableKey =
    checkpointId ||
    manifestKey ||
    archiveBatchId ||
    String(payloadOrJob?.id || "");
  return stableKey ? serverToken("parse_version_group", stableKey) : serverToken("parse_version_group", randomUUID());
}

export function normalizeParentJobId(payloadOrJob) {
  return String(payloadOrJob?.reparseFromJobId || payloadOrJob?.parentJobId || "").trim();
}
