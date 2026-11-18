import { hashClientString } from "#meshrix/client-strings";

type UnknownRecord = Record<string, unknown>;
export interface UploadSessionOwner extends UnknownRecord {
  present: true;
  subjectId: string;
  userId: string;
  username: string;
  roleId: string;
  tenantId: string;
  organizationNodeId: string;
  scopes: string[];
  canAccessAll: boolean;
}
export interface UploadSessionOwnerAccess {
  ok: boolean;
  reasonCode?: string;
  owner: UploadSessionOwner;
}

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function text(value: unknown): string {
  return String(value || "").trim();
}

function arrayOfText(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function codedError(message: string, code: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

export function normalizeUploadSessionOwner(ownerValue: unknown = {}): UploadSessionOwner {
  const owner = record(ownerValue);
  const scopes = arrayOfText(owner.scopes);
  const subjectId = text(owner.subjectId || owner.ownerSubjectId || owner.userId || owner.username);
  const userId = text(owner.userId || owner.ownerUserId || subjectId);
  const username = text(owner.username || owner.ownerUsername);
  if (![subjectId, userId, username].some(Boolean)) {
    throw codedError("upload session 需要调用者归属。", "upload_owner_required", 400);
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

export function uploadSessionOwnerKey(owner: UploadSessionOwner): string {
  return hashClientString(JSON.stringify({
    tenantId: owner.tenantId,
    organizationNodeId: owner.organizationNodeId,
    subjectId: owner.subjectId,
    userId: owner.userId,
    username: owner.username
  }), "upload.session.owner");
}

export function uploadSessionOwnerTrace(owner: UploadSessionOwner): UnknownRecord {
  return {
    ownerSubjectHash: hashClientString(owner.subjectId, "upload.owner.subject"),
    ownerUserHash: hashClientString(owner.userId, "upload.owner.user"),
    ownerUsernameHash: hashClientString(owner.username, "upload.owner.username"),
    ownerTenantHash: hashClientString(owner.tenantId, "upload.owner.tenant"),
    ownerOrganizationHash: hashClientString(owner.organizationNodeId, "upload.owner.organization"),
    canAccessAll: owner.canAccessAll === true
  };
}

export function uploadSessionOwnerFields(owner: UploadSessionOwner): UnknownRecord {
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

function uploadSessionOwnerIds(meta: UnknownRecord): string[] {
  return [meta.ownerSubjectId, meta.ownerUserId, meta.ownerUsername].map(text).filter(Boolean);
}

function callerOwnerIds(owner: UploadSessionOwner): string[] {
  return [owner.subjectId, owner.userId, owner.username].map(text).filter(Boolean);
}

export function uploadSessionOwnerAccess(metaValue: unknown, ownerInput: unknown): UploadSessionOwnerAccess {
  const meta = record(metaValue);
  const owner = normalizeUploadSessionOwner(ownerInput);
  const storedOwnerIds = uploadSessionOwnerIds(meta);
  if (storedOwnerIds.length === 0) return { ok: false, owner };
  if (owner.canAccessAll) return { ok: true, owner };

  const storedTenantId = text(meta.ownerTenantId);
  if (storedTenantId && owner.tenantId && storedTenantId !== owner.tenantId) return { ok: false, owner };
  const storedOrganizationNodeId = text(meta.ownerOrganizationNodeId);
  if (storedOrganizationNodeId && owner.organizationNodeId && storedOrganizationNodeId !== owner.organizationNodeId) {
    return { ok: false, reasonCode: "upload_session_organization_mismatch", owner };
  }

  const ownerMatches = callerOwnerIds(owner).some((callerId) => storedOwnerIds.includes(callerId));
  return {
    ok: ownerMatches,
    reasonCode: ownerMatches ? "upload_session_owner_match" : "upload_session_owner_mismatch",
    owner
  };
}

export function uploadSessionAccessError(sessionId: unknown): Error & { code: string; statusCode: number } {
  return codedError(`上传会话不存在或不可访问：${String(sessionId || "")}`, "upload_session_not_found", 404);
}

export function assertUploadSessionOwnerAccess(metaValue: unknown, ownerInput: unknown): UploadSessionOwner {
  const meta = record(metaValue);
  const access = uploadSessionOwnerAccess(meta, ownerInput);
  if (!access.ok) throw uploadSessionAccessError(meta.sessionId);
  return access.owner;
}
