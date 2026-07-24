import { sendJson } from "#meshrix/http-utils";

function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

export function authSubjectFromSession(authSession = null) {
  const user = authSession?.user || {};
  const scopes = [
    ...arrayOfStrings(user.scopes),
    ...arrayOfStrings(authSession?.scopes)
  ];
  return {
    present: Boolean(authSession && (user.userId || user.subjectId || user.username || user.roleId || scopes.length > 0)),
    subjectId: String(user.userId || user.subjectId || user.username || "").trim(),
    userId: String(user.userId || "").trim(),
    username: String(user.username || "").trim(),
    roleId: String(user.roleId || user.role || "").trim(),
    tenantId: String(user.tenantId || "").trim(),
    scopes,
    allowedWorkspaceIds: arrayOfStrings(user.allowedWorkspaceIds || user.workspaceIds),
    allowedJobIds: arrayOfStrings(user.allowedJobIds || user.jobIds)
  };
}

export function canAccessAllJobs(subject = {}) {
  return (
    subject.roleId === "owner" ||
    subject.roleId === "admin" ||
    subject.scopes?.includes?.("auth:admin") ||
    subject.scopes?.includes?.("jobs:admin")
  );
}

export function requestOwnerSubjectFromSession(authSession = null) {
  const subject = authSubjectFromSession(authSession);
  if (subject.present) {
    return {
      ...subject,
      canAccessAll: canAccessAllJobs(subject)
    };
  }

  return {
    present: true,
    subjectId: "public-local",
    userId: "public-local",
    username: "",
    roleId: "",
    tenantId: "local",
    scopes: [],
    allowedWorkspaceIds: [],
    allowedJobIds: [],
    canAccessAll: false
  };
}

function jobOwnerIds(job = {}) {
  const owner = job.owner || {};
  return [
    job.ownerSubjectId,
    job.ownerUserId,
    job.ownerUsername,
    job.createdBySubjectId,
    job.createdByUserId,
    job.createdBy,
    owner.subjectId,
    owner.userId,
    owner.username
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function jobWorkspaceId(job = {}) {
  return String(job.workspaceId || job.workspace_id || job.workspace || job.payload?.workspaceId || "").trim();
}

export function canAccessJob(job = null, authSession = null) {
  if (!job) {
    return false;
  }
  const subject = authSubjectFromSession(authSession);
  if (!subject.present) {
    return true;
  }
  if (canAccessAllJobs(subject)) {
    return true;
  }
  if (subject.allowedJobIds.includes(String(job.id || ""))) {
    return true;
  }
  const workspaceId = jobWorkspaceId(job);
  if (workspaceId && subject.allowedWorkspaceIds.includes(workspaceId)) {
    return true;
  }
  const ownerIds = jobOwnerIds(job);
  if (ownerIds.length === 0) {
    return false;
  }
  const callerIds = [subject.subjectId, subject.userId, subject.username].filter(Boolean);
  return callerIds.some((callerId) => ownerIds.includes(callerId));
}

export function sendForbiddenJob(response) {
  sendJson(response, 403, {
    error: "任务不存在或不可访问。"
  });
}

export function filterJobsForCaller(payload = {}, authSession = null) {
  if (Array.isArray(payload)) {
    return payload.filter((job) => canAccessJob(job, authSession));
  }
  const items = Array.isArray(payload.items)
    ? payload.items.filter((job) => canAccessJob(job, authSession))
    : [];
  return {
    ...payload,
    items,
    summary: {
      ...(payload.summary || {}),
      totalCount: items.length,
      queuedCount: items.filter((job) => job.status === "queued").length,
      runningCount: items.filter((job) => job.status === "running").length,
      completedCount: items.filter((job) => job.status === "completed").length,
      failedCount: items.filter((job) => job.status === "failed").length,
      cancelledCount: items.filter((job) => job.status === "cancelled").length,
      activeJobIds: arrayOfStrings(payload.summary?.activeJobIds).filter((jobId) =>
        items.some((job) => String(job.id || "") === jobId)
      ),
      activeJobId: items.some((job) => String(job.id || "") === payload.summary?.activeJobId)
        ? payload.summary.activeJobId
        : ""
    }
  };
}

function rawObjectOwnerIds(rawObjectEntry = {}) {
  const rawObject = rawObjectEntry.rawObject || {};
  return [
    rawObject.owner_subject_id,
    rawObject.ownerSubjectId,
    rawObject.owner_user_id,
    rawObject.ownerUserId,
    rawObject.owner_username,
    rawObject.ownerUsername
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function rawObjectJobId(rawObjectEntry = {}) {
  const rawObject = rawObjectEntry.rawObject || {};
  return String(rawObject.job_id || rawObject.jobId || "").trim();
}

export async function canAccessRawObjectEntry(rawObjectEntry = {}, authSession = null, jobWorkflow = null) {
  const subject = authSubjectFromSession(authSession);
  if (!subject.present) {
    return true;
  }
  if (canAccessAllJobs(subject)) {
    return true;
  }
  const rawOwnerIds = rawObjectOwnerIds(rawObjectEntry);
  const callerIds = [subject.subjectId, subject.userId, subject.username].filter(Boolean);
  const rawOwnerMatches = rawOwnerIds.length > 0
    ? callerIds.some((callerId) => rawOwnerIds.includes(callerId))
    : null;
  if (rawOwnerIds.length > 0) {
    if (!rawObjectJobId(rawObjectEntry)) {
      return rawOwnerMatches === true;
    }
  }
  const rawJobId = rawObjectJobId(rawObjectEntry);
  if (rawJobId) {
    let jobAccess = false;
    if (subject.allowedJobIds.includes(rawJobId)) {
      jobAccess = true;
    } else if (jobWorkflow && typeof jobWorkflow.getJob === "function") {
      jobAccess = canAccessJob(await jobWorkflow.getJob(rawJobId), authSession);
    }
    return rawOwnerMatches === null ? jobAccess : rawOwnerMatches === true && jobAccess === true;
  }
  return false;
}
