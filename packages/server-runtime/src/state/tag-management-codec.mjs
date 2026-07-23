import crypto from "node:crypto";

export const TAG_MANAGEMENT_PROTOCOL_VERSION = "v0.0.1:platform:tag-management-1";
export const ARCHIVED_STATUS = "archived";
export const ACTIVE_STATUS = "active";

const VALID_TAG_KINDS = new Set(["role", "group", "organization", "character", "custom"]);

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value, fallback = null) {
  return JSON.stringify(value ?? fallback);
}

export function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .flatMap((value) => typeof value === "string" && value.includes(",") ? value.split(",") : value)
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

export function normalizeIdSegment(value, fallbackPrefix) {
  const text = String(value || "").trim();
  if (text) {
    return text.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 160);
  }
  return `${fallbackPrefix}_${crypto.randomUUID()}`;
}

export function normalizeTagId(value, kind = "custom") {
  const text = String(value || "").trim();
  if (text) {
    return text.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 220);
  }
  return `${kind}:${crypto.randomUUID()}`;
}

export function normalizeKind(value) {
  const kind = String(value || "custom").trim() || "custom";
  if (!VALID_TAG_KINDS.has(kind)) {
    throw new Error(`Unsupported tag kind: ${kind}`);
  }
  return kind;
}

export function normalizeStatus(value, fallback = ACTIVE_STATUS) {
  const status = String(value || fallback || ACTIVE_STATUS).trim() || ACTIVE_STATUS;
  return status === ARCHIVED_STATUS ? ARCHIVED_STATUS : ACTIVE_STATUS;
}

export function normalizePolicyList(value = []) {
  const input = Array.isArray(value) ? value : value?.policies || value?.resourcePolicies || [];
  return (Array.isArray(input) ? input : []).map((entry) => {
    const resource = objectOrNull(entry.resource) || {};
    return {
      resourceType: String(entry.resourceType || entry.type || resource.type || "*").trim() || "*",
      resourceId: String(entry.resourceId || entry.id || entry.repoId || entry.repositoryRef || resource.id || "*").trim() || "*",
      actions: uniqueStrings(entry.actions || entry.action || entry.scopes || []),
      targetProviders: uniqueStrings(entry.targetProviders || entry.providers || entry.provider || entry.targets || []),
      label: String(entry.label || "").trim()
    };
  }).filter((entry) => entry.actions.length > 0);
}

export function tagFromRow(row) {
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

export function projectionFromRow(row) {
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

export function eventFromRow(row) {
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
