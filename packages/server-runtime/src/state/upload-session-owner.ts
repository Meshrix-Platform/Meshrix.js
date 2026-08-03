import { hashClientString } from "#meshrix/client-strings";

function text(value?: any) : any {
  return String(value || "").trim();
}

function arrayOfText(value?: any) : any {
  return Array.isArray(value)
    ? value.map((item?: any) : any => text(item)).filter(Boolean)
    : [];
}

export function normalizeUploadSessionOwner(owner: Record<string, any> = {}) : any {
  const scopes: any = arrayOfText(owner.scopes);
  const subjectId: any = text(owner.subjectId || owner.ownerSubjectId || owner.userId || owner.username);
  const userId: any = text(owner.userId || owner.ownerUserId || subjectId);
  const username: any = text(owner.username || owner.ownerUsername);
  const ownerIds: any = [subjectId, userId, username].filter(Boolean);
  if (ownerIds.length === 0) {
    const error: Error & Record<string, any> = new Error("upload session 需要调用者归属。");
    error.code = "upload_owner_required";
    error.statusCode = 400;
    throw error;
  }

  return {
    present: true,
    subjectId: subjectId || userId || username,
    userId,
    username,
    roleId: text(owner.roleId || owner.ownerRoleId || owner.role),
    tenantId: text(owner.tenantId || owner.ownerTenantId || owner.tenant),
    organizationNodeId: text(owner.organizationNodeId || owner.ownerOrganizationNodeId),
    scopes,
    canAccessAll: Boolean(owner.canAccessAll || owner.accessAll || owner.readAll || owner.admin)
  };
}

export function uploadSessionOwnerKey(owner?: any) : any {
  return hashClientString(
    JSON.stringify({
      tenantId: owner.tenantId,
      organizationNodeId: owner.organizationNodeId,
      subjectId: owner.subjectId,
      userId: owner.userId,
      username: owner.username
    }),
    "upload.session.owner"
  );
}

export function uploadSessionOwnerTrace(owner?: any) : any {
  return {
    ownerSubjectHash: hashClientString(owner.subjectId, "upload.owner.subject"),
    ownerUserHash: hashClientString(owner.userId, "upload.owner.user"),
    ownerUsernameHash: hashClientString(owner.username, "upload.owner.username"),
    ownerTenantHash: hashClientString(owner.tenantId, "upload.owner.tenant"),
    ownerOrganizationHash: hashClientString(owner.organizationNodeId, "upload.owner.organization"),
    canAccessAll: owner.canAccessAll === true
  };
}

export function uploadSessionOwnerFields(owner?: any) : any {
  return {
    ownerSubjectId: owner.subjectId,
    ownerUserId: owner.userId,
    ownerUsername: owner.username,
    ownerRoleId: owner.roleId,
    ownerTenantId: owner.tenantId,
    ownerOrganizationNodeId: owner.organizationNodeId,
    ownerKey: uploadSessionOwnerKey(owner)
  };
}

function uploadSessionOwnerIds(meta: Record<string, any> = {}) : any {
  return [
    meta.ownerSubjectId,
    meta.ownerUserId,
    meta.ownerUsername
  ].map((value?: any) : any => text(value)).filter(Boolean);
}

function callerOwnerIds(owner: Record<string, any> = {}) : any {
  return [
    owner.subjectId,
    owner.userId,
    owner.username
  ].map((value?: any) : any => text(value)).filter(Boolean);
}

export function uploadSessionOwnerAccess(meta?: any, ownerInput?: any) : any {
  const owner: any = normalizeUploadSessionOwner(ownerInput);
  const storedOwnerIds: any = uploadSessionOwnerIds(meta);
  if (storedOwnerIds.length === 0) {
    return { ok: false, owner };
  }
  if (owner.canAccessAll) {
    return { ok: true, owner };
  }

  const storedTenantId: any = text(meta.ownerTenantId);
  if (storedTenantId && owner.tenantId && storedTenantId !== owner.tenantId) {
    return { ok: false, owner };
  }

  const storedOrganizationNodeId: any = text(meta.ownerOrganizationNodeId);
  if (
    storedOrganizationNodeId
    && owner.organizationNodeId
    && storedOrganizationNodeId !== owner.organizationNodeId
  ) {
    return { ok: false, reasonCode: "upload_session_organization_mismatch", owner };
  }

  const callerIds: any = callerOwnerIds(owner);
  const ownerMatches: any = callerIds.some((callerId?: any) : any => storedOwnerIds.includes(callerId));
  return {
    ok: ownerMatches,
    reasonCode: ownerMatches ? "upload_session_owner_match" : "upload_session_owner_mismatch",
    owner
  };
}

export function uploadSessionAccessError(sessionId?: any) : any {
  const error: Error & Record<string, any> = new Error(`上传会话不存在或不可访问：${sessionId}`);
  error.code = "upload_session_not_found";
  error.statusCode = 404;
  return error;
}

export function assertUploadSessionOwnerAccess(meta?: any, ownerInput?: any) : any {
  const access: any = uploadSessionOwnerAccess(meta, ownerInput);
  if (!access.ok) {
    throw uploadSessionAccessError(meta?.sessionId || "");
  }
  return access.owner;
}
