import { sendJson } from "#meshrix/http-utils";

function arrayOfStrings(value?: any) : any {
  return Array.isArray(value)
    ? value.map((item?: any) : any => String(item || "").trim()).filter(Boolean)
    : [];
}

export function authSubjectFromSession(authSession: any = null) : any {
  const user: any = authSession?.user || {};
  const scopes: any[] = [
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
    organizationNodeId: String(user.organizationNodeId || authSession?.organizationNodeId || "").trim(),
    scopes,
    allowedWorkspaceIds: arrayOfStrings(user.allowedWorkspaceIds || user.workspaceIds),
    allowedJobIds: arrayOfStrings(user.allowedJobIds || user.jobIds)
  };
}

export function canAccessAllJobs(subject: Record<string, any> = {}) : any {
  return (
    subject.roleId === "owner" ||
    subject.scopes?.includes?.("auth:admin") ||
    subject.scopes?.includes?.("jobs:admin")
  );
}

export function requestOwnerSubjectFromSession(authSession: any = null) : any {
  const subject: any = authSubjectFromSession(authSession);
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

export function apiKeyUploadAuthSession(apiKeyAuthorization: any = null) : any {
  const policy: any = apiKeyAuthorization?.policy;
  const principalId: any = String(apiKeyAuthorization?.workloadPrincipalId || "").trim();
  const organizationNodeId: any = String(apiKeyAuthorization?.organizationNodeId || "").trim();
  if (
    apiKeyAuthorization?.credentialKind !== "scoped_api_key" ||
    !principalId ||
    !organizationNodeId ||
    !Number.isSafeInteger(apiKeyAuthorization?.lifecycleRevision) ||
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy)
  ) {
    return null;
  }
  const scopes: any = Object.freeze(arrayOfStrings(policy.scopeIds));
  const allowedWorkspaceIds: any = Object.freeze(arrayOfStrings(policy.resources?.workspaceIds));
  return Object.freeze({
    credentialKind: "scoped_api_key",
    apiKeyAuthorization,
    organizationNodeId,
    user: Object.freeze({
      type: "scoped-api-key",
      roleId: "scoped-api-key",
      userId: principalId,
      subjectId: principalId,
      username: principalId,
      organizationNodeId,
      tenantId: "local",
      scopes,
      allowedWorkspaceIds
    })
  });
}

function jobOwnerIds(job: Record<string, any> = {}) : any {
  const owner: any = job.owner || {};
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
  ].map((value?: any) : any => String(value || "").trim()).filter(Boolean);
}

function jobWorkspaceId(job: Record<string, any> = {}) : any {
  return String(job.workspaceId || job.workspace_id || job.workspace || job.payload?.workspaceId || "").trim();
}

export function canAccessJob(job: any = null, authSession: any = null) : any {
  if (!job) {
    return false;
  }
  const subject: any = authSubjectFromSession(authSession);
  if (!subject.present) {
    return false;
  }
  if (canAccessAllJobs(subject)) {
    return true;
  }
  if (subject.allowedJobIds.includes(String(job.id || ""))) {
    return true;
  }
  const workspaceId: any = jobWorkspaceId(job);
  if (workspaceId && subject.allowedWorkspaceIds.includes(workspaceId)) {
    return true;
  }
  const ownerIds: any = jobOwnerIds(job);
  if (ownerIds.length === 0) {
    return false;
  }
  const callerIds: any = [subject.subjectId, subject.userId, subject.username].filter(Boolean);
  return callerIds.some((callerId?: any) : any => ownerIds.includes(callerId));
}

export function sendForbiddenJob(response?: any) : any {
  sendJson(response, 403, {
    error: "任务不存在或不可访问。"
  });
}

export function filterJobsForCaller(payload: Record<string, any> = {}, authSession: any = null) : any {
  if (Array.isArray(payload)) {
    return payload.filter((job?: any) : any => canAccessJob(job, authSession));
  }
  const items: any = Array.isArray(payload.items)
    ? payload.items.filter((job?: any) : any => canAccessJob(job, authSession))
    : [];
  return {
    ...payload,
    items,
    summary: {
      ...(payload.summary || {}),
      totalCount: items.length,
      queuedCount: items.filter((job?: any) : any => job.status === "queued").length,
      runningCount: items.filter((job?: any) : any => job.status === "running").length,
      completedCount: items.filter((job?: any) : any => job.status === "completed").length,
      failedCount: items.filter((job?: any) : any => job.status === "failed").length,
      cancelledCount: items.filter((job?: any) : any => job.status === "cancelled").length,
      activeJobIds: arrayOfStrings(payload.summary?.activeJobIds).filter((jobId?: any) : any =>
        items.some((job?: any) : any => String(job.id || "") === jobId)
      ),
      activeJobId: items.some((job?: any) : any => String(job.id || "") === payload.summary?.activeJobId)
        ? payload.summary.activeJobId
        : ""
    }
  };
}

function rawObjectOwnerIds(rawObjectEntry: Record<string, any> = {}) : any {
  const rawObject: any = rawObjectEntry.rawObject || {};
  return [
    rawObject.owner_subject_id,
    rawObject.ownerSubjectId,
    rawObject.owner_user_id,
    rawObject.ownerUserId,
    rawObject.owner_username,
    rawObject.ownerUsername
  ].map((value?: any) : any => String(value || "").trim()).filter(Boolean);
}

function rawObjectJobId(rawObjectEntry: Record<string, any> = {}) : any {
  const rawObject: any = rawObjectEntry.rawObject || {};
  return String(rawObject.job_id || rawObject.jobId || "").trim();
}

export async function canAccessRawObjectEntry(rawObjectEntry: Record<string, any> = {}, authSession: any = null, jobWorkflow: any = null) : Promise<any> {
  const subject: any = authSubjectFromSession(authSession);
  if (!subject.present) {
    return false;
  }
  if (canAccessAllJobs(subject)) {
    return true;
  }
  const rawOwnerIds: any = rawObjectOwnerIds(rawObjectEntry);
  const callerIds: any = [subject.subjectId, subject.userId, subject.username].filter(Boolean);
  const rawOwnerMatches: any = rawOwnerIds.length > 0
    ? callerIds.some((callerId?: any) : any => rawOwnerIds.includes(callerId))
    : null;
  if (rawOwnerIds.length > 0) {
    if (!rawObjectJobId(rawObjectEntry)) {
      return rawOwnerMatches === true;
    }
  }
  const rawJobId: any = rawObjectJobId(rawObjectEntry);
  if (rawJobId) {
    let jobAccess: any = false;
    if (subject.allowedJobIds.includes(rawJobId)) {
      jobAccess = true;
    } else if (jobWorkflow && typeof jobWorkflow.getJob === "function") {
      jobAccess = canAccessJob(await jobWorkflow.getJob(rawJobId), authSession);
    }
    return rawOwnerMatches === null ? jobAccess : rawOwnerMatches === true && jobAccess === true;
  }
  return false;
}
