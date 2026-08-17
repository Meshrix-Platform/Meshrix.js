import crypto from "node:crypto";

export const TAG_MANAGEMENT_PROTOCOL_VERSION =
  "v0.0.1:platform:tag-management-1";
export const ARCHIVED_STATUS = "archived";
export const ACTIVE_STATUS = "active";
export type TagKind =
  "role" | "group" | "organization" | "character" | "custom";
export type TagStatus = typeof ACTIVE_STATUS | typeof ARCHIVED_STATUS;
export type JsonRecord = Record<string, unknown>;
export interface TagPolicy {
  resourceType: string;
  resourceId: string;
  actions: string[];
  targetProviders: string[];
  label: string;
}
export interface TagRecord extends JsonRecord {
  protocolVersion: string;
  tagId: string;
  kind: string;
  label: string;
  description: string;
  parentTagId: string;
  enabled: boolean;
  system: boolean;
  status: string;
  scopePrerequisites: unknown;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectionRecord extends JsonRecord {
  protocolVersion: string;
  tagId: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  updatedAt: string;
}
export interface EventRecord extends JsonRecord {
  protocolVersion: string;
  eventId: string;
  tagId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

const VALID_TAG_KINDS = new Set<TagKind>([
  "role",
  "group",
  "organization",
  "character",
  "custom",
]);
function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
function rowText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomId(prefix?: unknown): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function parseJson<Result>(
  value: unknown,
  fallback: Result,
): unknown | Result {
  try {
    if (typeof value !== "string") return fallback;
    const parsed: unknown = JSON.parse(value);
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function stringifyJson(
  value: unknown,
  fallback: unknown = null,
): string {
  return JSON.stringify(value ?? fallback);
}

export function objectOrNull(value?: unknown): JsonRecord | null {
  return record(value);
}

export function uniqueStrings(values: unknown = []): string[] {
  return [
    ...new Set<string>(
      (Array.isArray(values) ? values : [values])
        .flatMap((value) =>
          typeof value === "string" && value.includes(",")
            ? value.split(",")
            : value,
        )
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ];
}

export function normalizeIdSegment(
  value: unknown,
  fallbackPrefix: unknown,
): string {
  const text = String(value || "").trim();
  if (text) {
    return text.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 160);
  }
  return `${fallbackPrefix}_${crypto.randomUUID()}`;
}

export function normalizeTagId(
  value?: unknown,
  kind: unknown = "custom",
): string {
  const text = String(value || "").trim();
  if (text) {
    return text.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 220);
  }
  return `${kind}:${crypto.randomUUID()}`;
}

export function normalizeKind(value?: unknown): TagKind {
  const kind = String(value || "custom").trim() || "custom";
  if (!VALID_TAG_KINDS.has(kind as TagKind)) {
    throw new Error(`Unsupported tag kind: ${kind}`);
  }
  return kind as TagKind;
}

export function normalizeStatus(
  value?: unknown,
  fallback: unknown = ACTIVE_STATUS,
): TagStatus {
  const status =
    String(value || fallback || ACTIVE_STATUS).trim() || ACTIVE_STATUS;
  return status === ARCHIVED_STATUS ? ARCHIVED_STATUS : ACTIVE_STATUS;
}

export function normalizePolicyList(value: unknown = []): TagPolicy[] {
  const source = record(value);
  const input = Array.isArray(value)
    ? value
    : source?.policies || source?.resourcePolicies || [];
  return (Array.isArray(input) ? input : [])
    .map((value): TagPolicy => {
      const entry = record(value) || {};
      const resource = objectOrNull(entry.resource) || {};
      return {
        resourceType:
          String(
            entry.resourceType || entry.type || resource.type || "*",
          ).trim() || "*",
        resourceId:
          String(
            entry.resourceId ||
              entry.id ||
              entry.repoId ||
              entry.repositoryRef ||
              resource.id ||
              "*",
          ).trim() || "*",
        actions: uniqueStrings(
          entry.actions || entry.action || entry.scopes || [],
        ),
        targetProviders: uniqueStrings(
          entry.targetProviders ||
            entry.providers ||
            entry.provider ||
            entry.targets ||
            [],
        ),
        label: String(entry.label || "").trim(),
      };
    })
    .filter((entry) => entry.actions.length > 0);
}

export function tagFromRow(value?: unknown): TagRecord | null {
  const row = record(value);
  if (!row) return null;
  return {
    protocolVersion: TAG_MANAGEMENT_PROTOCOL_VERSION,
    tagId: rowText(row.tag_id),
    kind: rowText(row.kind),
    label: rowText(row.label, rowText(row.tag_id)),
    description: rowText(row.description),
    parentTagId: rowText(row.parent_tag_id),
    enabled: Boolean(row.enabled),
    system: Boolean(row.system),
    status: rowText(row.status, ACTIVE_STATUS),
    scopePrerequisites: parseJson(row.scope_prerequisites_json, []),
    metadata: parseJson(row.metadata_json, {}),
    createdAt: rowText(row.created_at),
    updatedAt: rowText(row.updated_at),
  };
}

export function projectionFromRow(value?: unknown): ProjectionRecord | null {
  const row = record(value);
  if (!row) return null;
  return {
    protocolVersion: TAG_MANAGEMENT_PROTOCOL_VERSION,
    tagId: rowText(row.tag_id),
    entityType: rowText(row.entity_type),
    entityId: rowText(row.entity_id),
    payload: parseJson(row.payload_json, {}),
    updatedAt: rowText(row.updated_at),
  };
}

export function eventFromRow(value?: unknown): EventRecord | null {
  const row = record(value);
  if (!row) return null;
  return {
    protocolVersion: TAG_MANAGEMENT_PROTOCOL_VERSION,
    eventId: rowText(row.event_id),
    tagId: rowText(row.tag_id),
    entityType: rowText(row.entity_type),
    entityId: rowText(row.entity_id),
    eventType: rowText(row.event_type),
    payload: parseJson(row.payload_json, {}),
    createdAt: rowText(row.created_at),
  };
}
