import { getJson, postJson } from "@lico/ui-console/bridge-http";

export type TagManagementTag = {
  protocolVersion: string;
  tagId: string;
  kind: "role" | "group" | "organization" | "character" | "custom" | string;
  label: string;
  description: string;
  parentTagId: string;
  enabled: boolean;
  system: boolean;
  status: string;
  scopePrerequisites: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type TagManagementProjection = {
  protocolVersion: string;
  tagId: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  updatedAt: string;
};

export type TagManagementAuditItem = {
  protocolVersion: string;
  eventId: string;
  tagId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type TagManagementListResponse<T> = {
  items: T[];
  count: number;
};

export type TagManagementTagResponse = {
  tag: TagManagementTag;
};

function queryString(params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") {
      continue;
    }
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function listTagManagementTags(params: {
  kind?: string;
  status?: string;
  includeArchived?: boolean;
  parentTagId?: string;
} = {}) {
  return getJson<TagManagementListResponse<TagManagementTag>>(
    `/api/tag-management/v1/tags${queryString(params)}`,
  );
}

export function getTagManagementTag(tagId: string) {
  return getJson<TagManagementTagResponse>(`/api/tag-management/v1/tags/${encodeURIComponent(tagId)}`);
}

export function upsertTagManagementTag(payload: Partial<TagManagementTag> & Record<string, unknown>) {
  return postJson<TagManagementTagResponse>("/api/tag-management/v1/tags", payload, {
    safetyConfirm: true,
  });
}

export function archiveTagManagementTag(tagId: string, reason = "") {
  return postJson<TagManagementTagResponse>(
    `/api/tag-management/v1/tags/${encodeURIComponent(tagId)}/archive`,
    { reason },
    { safetyConfirm: true },
  );
}

export function restoreTagManagementTag(tagId: string) {
  return postJson<TagManagementTagResponse>(
    `/api/tag-management/v1/tags/${encodeURIComponent(tagId)}/restore`,
    {},
    { safetyConfirm: true },
  );
}

export function listTagManagementProjections(params: {
  entityType?: string;
  kind?: string;
  includeArchived?: boolean;
} = {}) {
  return getJson<TagManagementListResponse<TagManagementProjection>>(
    `/api/tag-management/v1/projections${queryString(params)}`,
  );
}

export function rebuildTagManagementProjections() {
  return postJson<Record<string, unknown>>("/api/tag-management/v1/projections/rebuild", {}, {
    safetyConfirm: true,
  });
}

export function listTagManagementAudit(params: {
  limit?: number;
  tagId?: string;
  eventType?: string;
} = {}) {
  return getJson<TagManagementListResponse<TagManagementAuditItem>>(
    `/api/tag-management/v1/audit${queryString(params)}`,
  );
}
