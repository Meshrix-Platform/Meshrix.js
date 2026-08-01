import crypto from "node:crypto";

export const TAG_MANAGEMENT_PROTOCOL_VERSION: any = "v0.0.1:platform:tag-management-1";
export const ARCHIVED_STATUS: any = "archived";
export const ACTIVE_STATUS: any = "active";

const VALID_TAG_KINDS: any = new Set<any>(["role", "group", "organization", "character", "custom"]);

export function nowIso() : any {
  return new Date().toISOString();
}

export function randomId(prefix?: any) : any {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function parseJson(value?: any, fallback?: any) : any {
  try {
    const parsed: any = JSON.parse(value || "");
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value?: any, fallback: any = null) : any {
  return JSON.stringify(value ?? fallback);
}

export function objectOrNull(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function uniqueStrings(values: any = []) : any {
  return [...new Set<any>((Array.isArray(values) ? values : [values])
    .flatMap((value?: any) : any => typeof value === "string" && value.includes(",") ? value.split(",") : value)
    .map((value?: any) : any => String(value || "").trim())
    .filter(Boolean))];
}

export function normalizeIdSegment(value?: any, fallbackPrefix?: any) : any {
  const text: any = String(value || "").trim();
  if (text) {
    return text.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 160);
  }
  return `${fallbackPrefix}_${crypto.randomUUID()}`;
}

export function normalizeTagId(value?: any, kind: any = "custom") : any {
  const text: any = String(value || "").trim();
  if (text) {
    return text.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 220);
  }
  return `${kind}:${crypto.randomUUID()}`;
}

export function normalizeKind(value?: any) : any {
  const kind: any = String(value || "custom").trim() || "custom";
  if (!VALID_TAG_KINDS.has(kind)) {
    throw new Error(`Unsupported tag kind: ${kind}`);
  }
  return kind;
}

export function normalizeStatus(value?: any, fallback: any = ACTIVE_STATUS) : any {
  const status: any = String(value || fallback || ACTIVE_STATUS).trim() || ACTIVE_STATUS;
  return status === ARCHIVED_STATUS ? ARCHIVED_STATUS : ACTIVE_STATUS;
}

export function normalizePolicyList(value: any = []) : any {
  const input: any = Array.isArray(value) ? value : value?.policies || value?.resourcePolicies || [];
  return (Array.isArray(input) ? input : []).map((entry?: any) : any => {
    const resource: any = objectOrNull(entry.resource) || {};
    return {
      resourceType: String(entry.resourceType || entry.type || resource.type || "*").trim() || "*",
      resourceId: String(entry.resourceId || entry.id || entry.repoId || entry.repositoryRef || resource.id || "*").trim() || "*",
      actions: uniqueStrings(entry.actions || entry.action || entry.scopes || []),
      targetProviders: uniqueStrings(entry.targetProviders || entry.providers || entry.provider || entry.targets || []),
      label: String(entry.label || "").trim()
    };
  }).filter((entry?: any) : any => entry.actions.length > 0);
}

export function tagFromRow(row?: any) : any {
  if (!row) return null;
  return {
    protocolVersion: TAG_MANAGEMENT_PROTOCOL_VERSION,
    tagId: row.tag_id,
    kind: row.kind,
    label: row.label || row.tag_id,
    description: row.description || "",
    parentTagId: row.parent_tag_id || "",
    enabled: Boolean(row.enabled),
    system: Boolean(row.system),
    status: row.status || ACTIVE_STATUS,
    scopePrerequisites: parseJson(row.scope_prerequisites_json, []),
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function projectionFromRow(row?: any) : any {
  if (!row) return null;
  return {
    protocolVersion: TAG_MANAGEMENT_PROTOCOL_VERSION,
    tagId: row.tag_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: parseJson(row.payload_json, {}),
    updatedAt: row.updated_at
  };
}

export function eventFromRow(row?: any) : any {
  if (!row) return null;
  return {
    protocolVersion: TAG_MANAGEMENT_PROTOCOL_VERSION,
    eventId: row.event_id,
    tagId: row.tag_id,
    entityType: row.entity_type || "",
    entityId: row.entity_id || "",
    eventType: row.event_type,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at
  };
}
