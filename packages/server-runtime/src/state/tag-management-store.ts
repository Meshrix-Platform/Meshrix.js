import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import { ServerConfig } from "#meshrix/server-config";
import {
  assertTagParentChangeAllowed,
  effectiveScopePrerequisitesForTag
} from "#meshrix/foundation/security/authorization/tag-tree";
import {
  ACTIVE_STATUS,
  ARCHIVED_STATUS,
  TAG_MANAGEMENT_PROTOCOL_VERSION,
  eventFromRow,
  normalizeIdSegment,
  normalizeKind,
  normalizePolicyList,
  normalizeStatus,
  normalizeTagId,
  nowIso,
  objectOrNull,
  parseJson,
  projectionFromRow,
  randomId,
  stringifyJson,
  tagFromRow,
  uniqueStrings
} from "./tag-management-codec.ts";
import type { EventRecord, JsonRecord, ProjectionRecord, TagRecord, TagPolicy } from "./tag-management-codec.ts";
import { ensureTagManagementSchema } from "./tag-management-schema.ts";

export { TAG_MANAGEMENT_PROTOCOL_VERSION } from "./tag-management-codec.ts";

const changeHandlersByRoot: Map<string, Set<ChangeHandler>> = new Map();

export interface RoleRecord { roleId: string; label: string; description: string; system: boolean; enabled: boolean; scopes: string[]; resourcePolicies: TagPolicy[]; createdAt: string; updatedAt: string; [key: string]: unknown }
export interface TeamRecord { teamId: string; label: string; description: string; enabled: boolean; roleIds: string[]; departmentIds: string[]; memberUserIds: string[]; resourcePolicies: TagPolicy[]; createdAt: string; updatedAt: string; [key: string]: unknown }
export interface DepartmentRecord { departmentId: string; label: string; description: string; parentDepartmentId: string; enabled: boolean; roleIds: string[]; teamIds: string[]; memberUserIds: string[]; resourcePolicies: TagPolicy[]; createdAt: string; updatedAt: string; [key: string]: unknown }
export interface AgentGroupRecord { groupId: string; label: string; description: string; enabled: boolean; resourcePolicies: TagPolicy[]; createdAt: string; updatedAt: string; [key: string]: unknown }
export interface AgentBindingRecord { agentId: string; boundUserId: string; profileId: string; groupIds: string[]; enabled: boolean; resourcePolicies: TagPolicy[]; createdAt: string; updatedAt: string; [key: string]: unknown }
export interface ToolProfileRecord { id: string; label: string; agentType: string; toolsets: string[]; toolAllow: string[]; toolDeny: string[]; maxRisk: string; approvalPolicy: string; concurrencyLimit: number; sandboxPolicy: string; auditTags: string[]; enabled: boolean; [key: string]: unknown }
export interface ProjectionInput { tagId?: string; entityType: string; entityId: string; payload?: unknown }
interface StoreOptions { userDataPath?: string; rootPath?: string; db?: Database.Database | null }
interface DatabaseStoreOptions { db: Database.Database; ownsDatabase: boolean; resolvedUserDataPath: string; resolvedRoot: string }
interface EventInput { tagId?: string; entityType?: string; entityId?: string; payload?: unknown }
export interface UpsertOptions extends JsonRecord { suppressEvent?: boolean; eventType?: string; entityType?: string; entityId?: string; scopePrerequisites?: unknown }
interface OrganizationNode { nodeId: string; nodeType: string; parentId: string; name: string; organizationLevel?: number }
interface OrganizationTag { tagId: string; kind: string; label: string; parentTagId: string; description: string; scopePrerequisites: string[] }
interface OrganizationRole { roleId: string; name: string; scopeNodeId: string; scopeNodeType: string; managementActions: string[]; businessResourceActions: string[]; assignedSubjectIds: string[] }
interface OrganizationGovernanceDraft extends JsonRecord { schemaVersion: string; templateKey: string; templateName: string; description: string; organizationDepth: number; nodes: OrganizationNode[]; tags: OrganizationTag[]; roles: OrganizationRole[] }
export interface OrganizationGovernanceSnapshot extends OrganizationGovernanceDraft { protocolVersion: string; configured: boolean; revision: number; publishedAt: string }
interface OrganizationGovernanceErrorOptions { statusCode?: number; currentRevision?: number }
interface OrganizationGovernanceError extends Error { code: string; statusCode: number; currentRevision?: number }
interface GovernanceOwnershipRow { entityType: string; entityId: string }
type ChangeHandler = (event: Readonly<{ eventType: string }>) => void;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function organizationGovernanceDraft(value: unknown): OrganizationGovernanceDraft | null {
  const source = objectOrNull(value);
  if (!source || !Array.isArray(source.nodes) || !Array.isArray(source.tags) || !Array.isArray(source.roles)) return null;
  const nodes: OrganizationNode[] = [];
  const tags: OrganizationTag[] = [];
  const roles: OrganizationRole[] = [];
  for (const item of source.nodes) {
    const node = objectOrNull(item);
    if (!node || typeof node.nodeId !== "string" || typeof node.nodeType !== "string" ||
        typeof node.parentId !== "string" || typeof node.name !== "string") return null;
    nodes.push({
      nodeId: node.nodeId,
      nodeType: node.nodeType,
      parentId: node.parentId,
      name: node.name,
      ...(typeof node.organizationLevel === "number" ? { organizationLevel: node.organizationLevel } : {})
    });
  }
  for (const item of source.tags) {
    const tag = objectOrNull(item);
    if (!tag || typeof tag.tagId !== "string" || typeof tag.kind !== "string" || typeof tag.label !== "string" ||
        typeof tag.parentTagId !== "string" || typeof tag.description !== "string" || !Array.isArray(tag.scopePrerequisites)) return null;
    tags.push({
      tagId: tag.tagId,
      kind: tag.kind,
      label: tag.label,
      parentTagId: tag.parentTagId,
      description: tag.description,
      scopePrerequisites: uniqueStrings(tag.scopePrerequisites)
    });
  }
  for (const item of source.roles) {
    const role = objectOrNull(item);
    if (!role || typeof role.roleId !== "string" || typeof role.name !== "string" ||
        typeof role.scopeNodeId !== "string" || typeof role.scopeNodeType !== "string" || !Array.isArray(role.managementActions)) return null;
    roles.push({
      roleId: role.roleId,
      name: role.name,
      scopeNodeId: role.scopeNodeId,
      scopeNodeType: role.scopeNodeType,
      managementActions: uniqueStrings(role.managementActions),
      businessResourceActions: uniqueStrings(role.businessResourceActions),
      assignedSubjectIds: uniqueStrings(role.assignedSubjectIds)
    });
  }
  if (typeof source.schemaVersion !== "string" || typeof source.templateKey !== "string" ||
      typeof source.templateName !== "string" || typeof source.description !== "string") return null;
  return {
    schemaVersion: source.schemaVersion,
    templateKey: source.templateKey,
    templateName: source.templateName,
    description: source.description,
    organizationDepth: Number(source.organizationDepth || 0),
    nodes,
    tags,
    roles
  };
}

function sharedChangeHandlers(rootPath: string): Set<ChangeHandler> {
  let handlers = changeHandlersByRoot.get(rootPath);
  if (!handlers) {
    handlers = new Set();
    changeHandlersByRoot.set(rootPath, handlers);
  }
  return handlers;
}

function roleTagId(roleId?: unknown): string {
  return `role:${normalizeIdSegment(roleId, "role")}`;
}

function teamTagId(teamId?: unknown): string {
  return `group:team:${normalizeIdSegment(teamId, "team")}`;
}

function departmentTagId(departmentId?: unknown): string {
  return `group:department:${normalizeIdSegment(departmentId, "department")}`;
}

function agentGroupTagId(groupId?: unknown): string {
  return `group:agent:${normalizeIdSegment(groupId, "agent-group")}`;
}

function agentBindingTagId(agentId?: unknown): string {
  return `character:agent:${normalizeIdSegment(agentId, "agent")}`;
}

function toolProfileTagId(profileId?: unknown): string {
  return `character:tool-profile:${normalizeIdSegment(profileId, "profile")}`;
}

function normalizeRole(input: JsonRecord = {}, fallback: JsonRecord = {}): RoleRecord {
  const roleId = normalizeIdSegment(input.roleId || input.id || fallback.roleId, "role");
  return {
    roleId,
    label: String(input.label || input.name || fallback.label || roleId).trim(),
    description: String(input.description || fallback.description || "").trim(),
    system: Boolean(input.system ?? fallback.system ?? false),
    enabled: input.enabled !== false,
    scopes: uniqueStrings(input.scopes || fallback.scopes || []),
    resourcePolicies: normalizePolicyList(input.resourcePolicies || fallback.resourcePolicies || []),
    createdAt: String(fallback.createdAt || input.createdAt || nowIso()),
    updatedAt: nowIso()
  };
}

function normalizeTeam(input: JsonRecord = {}, fallback: JsonRecord = {}): TeamRecord {
  const teamId = normalizeIdSegment(input.teamId || input.id || fallback.teamId, "team");
  return {
    teamId,
    label: String(input.label || input.name || fallback.label || teamId).trim(),
    description: String(input.description || fallback.description || "").trim(),
    enabled: input.enabled !== false,
    roleIds: uniqueStrings(input.roleIds || input.roles || fallback.roleIds || []),
    departmentIds: uniqueStrings(input.departmentIds || input.departments || fallback.departmentIds || []),
    memberUserIds: uniqueStrings(input.memberUserIds || input.members || fallback.memberUserIds || []),
    resourcePolicies: normalizePolicyList(input.resourcePolicies || fallback.resourcePolicies || []),
    createdAt: String(fallback.createdAt || input.createdAt || nowIso()),
    updatedAt: nowIso()
  };
}

function normalizeDepartment(input: JsonRecord = {}, fallback: JsonRecord = {}): DepartmentRecord {
  const departmentId = normalizeIdSegment(input.departmentId || input.id || fallback.departmentId, "department");
  return {
    departmentId,
    label: String(input.label || input.name || fallback.label || departmentId).trim(),
    description: String(input.description || fallback.description || "").trim(),
    parentDepartmentId: String(input.parentDepartmentId || input.parentId || fallback.parentDepartmentId || "").trim(),
    enabled: input.enabled !== false,
    roleIds: uniqueStrings(input.roleIds || input.roles || fallback.roleIds || []),
    teamIds: uniqueStrings(input.teamIds || input.teams || fallback.teamIds || []),
    memberUserIds: uniqueStrings(input.memberUserIds || input.members || fallback.memberUserIds || []),
    resourcePolicies: normalizePolicyList(input.resourcePolicies || fallback.resourcePolicies || []),
    createdAt: String(fallback.createdAt || input.createdAt || nowIso()),
    updatedAt: nowIso()
  };
}

function normalizeAgentGroup(input: JsonRecord = {}, fallback: JsonRecord = {}): AgentGroupRecord {
  const groupId = normalizeIdSegment(input.groupId || input.id || fallback.groupId, "agent-group");
  return {
    groupId,
    label: String(input.label || input.name || fallback.label || groupId).trim(),
    description: String(input.description || fallback.description || "").trim(),
    enabled: input.enabled !== false,
    resourcePolicies: normalizePolicyList(input.resourcePolicies || fallback.resourcePolicies || []),
    createdAt: String(fallback.createdAt || input.createdAt || nowIso()),
    updatedAt: nowIso()
  };
}

function normalizeAgentBinding(input: JsonRecord = {}, fallback: JsonRecord = {}): AgentBindingRecord {
  const agentId = normalizeIdSegment(input.agentId || input.id || input.profileId || fallback.agentId, "agent");
  return {
    agentId,
    boundUserId: String(input.boundUserId || input.userId || fallback.boundUserId || "").trim(),
    profileId: String(input.profileId || input.agentProfileId || fallback.profileId || "").trim(),
    groupIds: uniqueStrings(input.groupIds || input.groups || fallback.groupIds || []),
    enabled: input.enabled !== false,
    resourcePolicies: normalizePolicyList(input.resourcePolicies || fallback.resourcePolicies || []),
    createdAt: String(fallback.createdAt || input.createdAt || nowIso()),
    updatedAt: nowIso()
  };
}

function normalizeToolProfile(input: JsonRecord = {}, fallback: JsonRecord = {}): ToolProfileRecord {
  const id = normalizeIdSegment(input.id || input.profileId || fallback.id, "profile");
  return {
    id,
    label: String(input.label || input.name || fallback.label || id).trim(),
    agentType: String(input.agentType || input.type || fallback.agentType || "").trim(),
    toolsets: uniqueStrings(input.toolsets || fallback.toolsets || []),
    toolAllow: uniqueStrings(input.toolAllow || input.allowTools || fallback.toolAllow || []),
    toolDeny: uniqueStrings(input.toolDeny || input.denyTools || fallback.toolDeny || []),
    maxRisk: String(input.maxRisk || fallback.maxRisk || "read_only").trim(),
    approvalPolicy: String(input.approvalPolicy || fallback.approvalPolicy || "").trim(),
    concurrencyLimit: Number(input.concurrencyLimit ?? fallback.concurrencyLimit ?? 1),
    sandboxPolicy: String(input.sandboxPolicy || fallback.sandboxPolicy || "").trim(),
    auditTags: uniqueStrings(input.auditTags || fallback.auditTags || []),
    enabled: input.enabled !== false
  };
}

export function getTagManagementDatabasePath(userDataPath = ""): string {
  return path.join(userDataPath || ServerConfig.getDataDir(), "security", "tag-management", "tag-management.sqlite");
}

export function createTagManagementStore({
  userDataPath = "",
  rootPath = "",
  db: injectedDatabase = null
}: StoreOptions = {}) {
  const resolvedUserDataPath = path.resolve(userDataPath || ServerConfig.getDataDir());
  const resolvedRoot = rootPath ||
    path.join(resolvedUserDataPath, "security", "tag-management");
  if (!injectedDatabase) {
    fs.mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  }
  const db = injectedDatabase || openSqliteDatabase(path.join(resolvedRoot, "tag-management.sqlite"));
  const ownsDatabase = !injectedDatabase;
  try {
    return createTagManagementStoreFromDatabase({
      db,
      ownsDatabase,
      resolvedUserDataPath,
      resolvedRoot
    });
  } catch (error: unknown) {
    if (ownsDatabase) {
      try {
        db.close();
      } catch {
        // Preserve the construction failure; cleanup is best effort.
      }
    }
    throw error;
  }
}

function createTagManagementStoreFromDatabase({
  db,
  ownsDatabase,
  resolvedUserDataPath,
  resolvedRoot
}: DatabaseStoreOptions) {
  let closed = false;
  const changeHandlers = sharedChangeHandlers(String(resolvedRoot));
  const ownedChangeHandlers = new Set<ChangeHandler>();
  ensureTagManagementSchema(db);

  const tagUpsert = db.prepare(`
    INSERT INTO tag_management_tags (
      tag_id, kind, label, description, parent_tag_id, enabled, system, status,
      scope_prerequisites_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tag_id) DO UPDATE SET
      kind = excluded.kind,
      label = excluded.label,
      description = excluded.description,
      parent_tag_id = excluded.parent_tag_id,
      enabled = excluded.enabled,
      system = excluded.system,
      status = excluded.status,
      scope_prerequisites_json = excluded.scope_prerequisites_json,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `);
  const projectionUpsert = db.prepare(`
    INSERT INTO tag_management_projections (
      tag_id, entity_type, entity_id, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tag_id, entity_type, entity_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);

  function appendEvent(eventType: string, { tagId = "", entityType = "", entityId = "", payload = {} }: EventInput = {}): void {
    db.prepare(`
      INSERT INTO tag_management_events (event_id, tag_id, entity_type, entity_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomId("tag_event"), tagId, entityType, entityId, eventType, stringifyJson(payload, {}), nowIso());
    for (const handler of changeHandlers) {
      try {
        handler(Object.freeze({ eventType }));
      } catch {
        // The durable tag mutation remains authoritative; subscribers reconcile independently.
      }
    }
  }

  function getTag(tagId?: unknown): TagRecord | null {
    return tagFromRow(db.prepare("SELECT * FROM tag_management_tags WHERE tag_id = ?").get(String(tagId || "")));
  }

  function listTags({ kind = "", includeArchived = true, status = "", parentTagId = undefined }: { kind?: string; includeArchived?: boolean; status?: string; parentTagId?: string } = {}): TagRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (kind) {
      clauses.push("kind = ?");
      params.push(String(kind));
    }
    if (status) {
      clauses.push("status = ?");
      params.push(String(status));
    } else if (!includeArchived) {
      clauses.push("status != ?");
      params.push(ARCHIVED_STATUS);
    }
    if (parentTagId !== undefined) {
      clauses.push("parent_tag_id = ?");
      params.push(String(parentTagId || ""));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT * FROM tag_management_tags ${where} ORDER BY kind ASC, parent_tag_id ASC, tag_id ASC`)
      .all(...params)
      .map(tagFromRow).filter((tag): tag is TagRecord => tag !== null);
  }

  function assertParentAllowed(tagId: string, parentTagId: string): void {
    assertTagParentChangeAllowed({ getTag, tagId, parentTagId });
  }

  function canonicalTagInput(input: JsonRecord = {}, fallback: JsonRecord = {}) {
    const kind = normalizeKind(input.kind || fallback.kind || "custom");
    const tagId = normalizeTagId(input.tagId || input.id || fallback.tagId, kind);
    const parentTagId = String(input.parentTagId ?? fallback.parentTagId ?? "").trim();
    assertParentAllowed(tagId, parentTagId);
    const status = normalizeStatus(input.status, fallback.status || ACTIVE_STATUS);
    const incomingEnabled = input.enabled ?? fallback.enabled ?? true;
    const enabled = status === ARCHIVED_STATUS ? false : incomingEnabled !== false;
    const metadata = objectOrNull(input.metadata) || objectOrNull(fallback.metadata) || {};
    return {
      tagId,
      kind,
      label: String(input.label || input.name || fallback.label || tagId).trim(),
      description: String(input.description || fallback.description || "").trim(),
      parentTagId,
      enabled,
      system: Boolean(input.system ?? fallback.system ?? false),
      status,
      scopePrerequisites: uniqueStrings(input.scopePrerequisites || input.scopesRequired || fallback.scopePrerequisites || []),
      metadata,
      createdAt: String(fallback.createdAt || input.createdAt || nowIso()),
      updatedAt: nowIso()
    };
  }

  function upsertTag(input: JsonRecord = {}, options: UpsertOptions = {}): TagRecord {
    const existing = getTag(input.tagId || input.id);
    const tag = canonicalTagInput(input, record(existing));
    const before = existing ? JSON.stringify({
      kind: existing.kind,
      label: existing.label,
      description: existing.description,
      parentTagId: existing.parentTagId,
      enabled: existing.enabled,
      system: existing.system,
      status: existing.status,
      scopePrerequisites: existing.scopePrerequisites,
      metadata: existing.metadata
    }) : "";
    tagUpsert.run(
      tag.tagId,
      tag.kind,
      tag.label,
      tag.description,
      tag.parentTagId,
      tag.enabled ? 1 : 0,
      tag.system ? 1 : 0,
      tag.status,
      stringifyJson(tag.scopePrerequisites, []),
      stringifyJson(tag.metadata, {}),
      tag.createdAt,
      tag.updatedAt
    );
    const saved = getTag(tag.tagId);
    if (!saved) throw new Error("Tag upsert did not return a durable row.");
    const after = JSON.stringify({
      kind: saved.kind,
      label: saved.label,
      description: saved.description,
      parentTagId: saved.parentTagId,
      enabled: saved.enabled,
      system: saved.system,
      status: saved.status,
      scopePrerequisites: saved.scopePrerequisites,
      metadata: saved.metadata
    });
    if (!options.suppressEvent && before !== after) {
      appendEvent(options.eventType || (existing ? "update" : "create"), {
        tagId: saved.tagId,
        entityType: String(options.entityType || ""),
        entityId: String(options.entityId || ""),
        payload: saved
      });
    }
    return saved;
  }

  function archiveTag(tagId?: unknown, input: JsonRecord = {}): TagRecord {
    const existing = getTag(tagId);
    if (!existing) {
      throw new Error(`Unknown tag: ${tagId}`);
    }
    if (existing.system) {
      throw new Error("System tags cannot be archived.");
    }
    const metadata = record(existing.metadata);
    const saved = upsertTag({
      ...existing,
      enabled: false,
      status: ARCHIVED_STATUS,
      metadata: {
        ...metadata,
        archiveReason: String(input.reason || metadata.archiveReason || "").trim()
      }
    }, { eventType: "archive" });
    return saved;
  }

  function restoreTag(tagId?: unknown): TagRecord {
    const existing = getTag(tagId);
    if (!existing) {
      throw new Error(`Unknown tag: ${tagId}`);
    }
    return upsertTag({
      ...existing,
      enabled: true,
      status: ACTIVE_STATUS
    }, { eventType: "restore" });
  }

  function getEffectiveScopePrerequisites(tagId?: unknown) {
    return effectiveScopePrerequisitesForTag({ getTag, tagId });
  }

  function canonicalProjections(...collections: unknown[]): ProjectionInput[] {
    const projectionsByKey = new Map<string, ProjectionInput>();
    for (const collection of collections) {
      for (const item of Array.isArray(collection) ? collection : []) {
        const itemRecord = record(item);
        if (!itemRecord.entityType || !itemRecord.entityId) continue;
        const projection: ProjectionInput = {
          tagId: String(itemRecord.tagId || ""),
          entityType: String(itemRecord.entityType),
          entityId: String(itemRecord.entityId),
          payload: objectOrNull(itemRecord.payload) || {}
        };
        projectionsByKey.set(`${projection.entityType}\u0000${projection.entityId}`, projection);
      }
    }
    return [...projectionsByKey.values()];
  }

  function upsertProjection(
    { tagId = "", entityType = "", entityId = "", payload = {} }: Partial<ProjectionInput> = {},
    { suppressEvent = false }: { suppressEvent?: boolean } = {}
  ): ProjectionRecord | null {
    const normalizedTagId = String(tagId || "").trim();
    const normalizedEntityType = String(entityType || "").trim();
    const normalizedEntityId = String(entityId || "").trim();
    if (!normalizedTagId || !normalizedEntityType || !normalizedEntityId) {
      throw new Error("Tag projection requires tagId, entityType, and entityId.");
    }
    if (!getTag(normalizedTagId)) {
      throw new Error(`Unknown projection tag: ${normalizedTagId}`);
    }
    projectionUpsert.run(
      normalizedTagId,
      normalizedEntityType,
      normalizedEntityId,
      stringifyJson(payload, {}),
      nowIso()
    );
    rememberProjectionOnTag(normalizedTagId, {
      entityType: normalizedEntityType,
      entityId: normalizedEntityId,
      payload
    });
    if (!suppressEvent) {
      appendEvent("projection-upserted", {
        tagId: normalizedTagId,
        entityType: normalizedEntityType,
        entityId: normalizedEntityId,
        payload
      });
    }
    return getProjection(normalizedEntityType, normalizedEntityId);
  }

  function rememberProjectionOnTag(tagId: unknown, projection: ProjectionInput): void {
    const tag = getTag(tagId);
    if (!tag) {
      return;
    }
    const metadata = objectOrNull(tag.metadata) || {};
    const existing = Array.isArray(metadata.projections)
      ? metadata.projections
      : [];
    const projections = canonicalProjections(existing, [projection]);
    db.prepare("UPDATE tag_management_tags SET metadata_json = ?, updated_at = ? WHERE tag_id = ?")
      .run(stringifyJson({ ...metadata, projections }, {}), nowIso(), tagId);
  }

  function getProjection(entityType?: unknown, entityId?: unknown): ProjectionRecord | null {
    return projectionFromRow(db.prepare(`
      SELECT * FROM tag_management_projections
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(String(entityType || ""), String(entityId || "")));
  }

  function hasProjection(entityType?: unknown, entityId?: unknown): boolean {
    return Boolean(getProjection(entityType, entityId));
  }

  function listProjections({ entityType = "", kind = "", includeArchived = true }: { entityType?: string; kind?: string; includeArchived?: boolean } = {}): ProjectionRecord[] {
    const clauses: string[] = ["1 = 1"];
    const params: Array<string | number> = [];
    if (entityType) {
      clauses.push("p.entity_type = ?");
      params.push(String(entityType));
    }
    if (kind) {
      clauses.push("t.kind = ?");
      params.push(String(kind));
    }
    if (!includeArchived) {
      clauses.push("t.status != ?");
      params.push(ARCHIVED_STATUS);
    }
    return db.prepare(`
      SELECT p.*
      FROM tag_management_projections p
      JOIN tag_management_tags t ON t.tag_id = p.tag_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY p.entity_type ASC, p.entity_id ASC
    `).all(...params).map(projectionFromRow).filter((projection): projection is ProjectionRecord => projection !== null);
  }

  function upsertProjectedTag<Payload extends JsonRecord>({ tag, entityType, entityId, payload, options = {} }: { tag: JsonRecord; entityType: string; entityId: string; payload: Payload; options?: UpsertOptions }): Payload {
    const existingMetadata = objectOrNull(getTag(tag.tagId)?.metadata) || {};
    const incomingMetadata = objectOrNull(tag.metadata) || {};
    const metadata: JsonRecord = {
      ...existingMetadata,
      ...incomingMetadata,
      projections: canonicalProjections(
        existingMetadata.projections,
        incomingMetadata.projections,
        [{ entityType, entityId, payload }]
      )
    };
    const savedTag = upsertTag({
      ...tag,
      metadata
    }, {
      ...options,
      entityType,
      entityId
    });
    if (!savedTag) throw new Error("Projected tag upsert failed.");
    upsertProjection(
      { tagId: savedTag.tagId, entityType, entityId, payload },
      { suppressEvent: options.suppressEvent }
    );
    return payload;
  }

  function projectionPayload(entityType?: unknown, entityId?: unknown): JsonRecord | null {
    return objectOrNull(getProjection(entityType, entityId)?.payload);
  }

  function upsertAuthorizationRole(input: JsonRecord = {}, options: UpsertOptions = {}): RoleRecord {
    const existing = projectionPayload("authorization.role", input.roleId || input.id);
    const role = normalizeRole(input, existing || {});
    return upsertProjectedTag({
      tag: {
        tagId: roleTagId(role.roleId),
        kind: "role",
        label: role.label,
        description: role.description,
        enabled: role.enabled,
        system: role.system,
        scopePrerequisites: options.scopePrerequisites || input.scopePrerequisites || []
      },
      entityType: "authorization.role",
      entityId: role.roleId,
      payload: role,
      options
    });
  }

  function listAuthorizationRoles({ includeDisabled = true }: { includeDisabled?: boolean } = {}): RoleRecord[] {
    return listProjections({ entityType: "authorization.role", includeArchived: includeDisabled })
      .map((projection) => normalizeRole(record(projection.payload), record(projection.payload)))
      .filter((role) => includeDisabled || role.enabled !== false);
  }

  function getAuthorizationRole(roleId?: unknown): RoleRecord | null {
    const payload = projectionPayload("authorization.role", normalizeIdSegment(roleId, "role"));
    return payload ? normalizeRole(payload, payload) : null;
  }

  function upsertAuthorizationTeam(input: JsonRecord = {}, options: UpsertOptions = {}): TeamRecord {
    const existing = projectionPayload("authorization.team", input.teamId || input.id);
    const team = normalizeTeam(input, existing || {});
    return upsertProjectedTag({
      tag: {
        tagId: teamTagId(team.teamId),
        kind: "group",
        label: team.label,
        description: team.description,
        enabled: team.enabled,
        metadata: { groupType: "team" }
      },
      entityType: "authorization.team",
      entityId: team.teamId,
      payload: team,
      options
    });
  }

  function listAuthorizationTeams({ includeDisabled = true }: { includeDisabled?: boolean } = {}): TeamRecord[] {
    return listProjections({ entityType: "authorization.team", includeArchived: includeDisabled })
      .map((projection) => normalizeTeam(record(projection.payload), record(projection.payload)))
      .filter((team) => includeDisabled || team.enabled !== false);
  }

  function getAuthorizationTeam(teamId?: unknown): TeamRecord | null {
    const payload = projectionPayload("authorization.team", normalizeIdSegment(teamId, "team"));
    return payload ? normalizeTeam(payload, payload) : null;
  }

  function upsertAuthorizationDepartment(input: JsonRecord = {}, options: UpsertOptions = {}): DepartmentRecord {
    const existing = projectionPayload("authorization.department", input.departmentId || input.id);
    const department = normalizeDepartment(input, existing || {});
    return upsertProjectedTag({
      tag: {
        tagId: departmentTagId(department.departmentId),
        kind: "group",
        label: department.label,
        description: department.description,
        enabled: department.enabled,
        metadata: { groupType: "department", parentDepartmentId: department.parentDepartmentId }
      },
      entityType: "authorization.department",
      entityId: department.departmentId,
      payload: department,
      options
    });
  }

  function listAuthorizationDepartments({ includeDisabled = true }: { includeDisabled?: boolean } = {}): DepartmentRecord[] {
    return listProjections({ entityType: "authorization.department", includeArchived: includeDisabled })
      .map((projection) => normalizeDepartment(record(projection.payload), record(projection.payload)))
      .filter((department) => includeDisabled || department.enabled !== false);
  }

  function getAuthorizationDepartment(departmentId?: unknown): DepartmentRecord | null {
    const payload = projectionPayload("authorization.department", normalizeIdSegment(departmentId, "department"));
    return payload ? normalizeDepartment(payload, payload) : null;
  }

  function upsertAuthorizationAgentGroup(input: JsonRecord = {}, options: UpsertOptions = {}): AgentGroupRecord {
    const existing = projectionPayload("authorization.agent-group", input.groupId || input.id);
    const group = normalizeAgentGroup(input, existing || {});
    return upsertProjectedTag({
      tag: {
        tagId: agentGroupTagId(group.groupId),
        kind: "group",
        label: group.label,
        description: group.description,
        enabled: group.enabled,
        metadata: { groupType: "agent" }
      },
      entityType: "authorization.agent-group",
      entityId: group.groupId,
      payload: group,
      options
    });
  }

  function listAuthorizationAgentGroups({ includeDisabled = true }: { includeDisabled?: boolean } = {}): AgentGroupRecord[] {
    return listProjections({ entityType: "authorization.agent-group", includeArchived: includeDisabled })
      .map((projection) => normalizeAgentGroup(record(projection.payload), record(projection.payload)))
      .filter((group) => includeDisabled || group.enabled !== false);
  }

  function getAuthorizationAgentGroup(groupId?: unknown): AgentGroupRecord | null {
    const payload = projectionPayload("authorization.agent-group", normalizeIdSegment(groupId, "agent-group"));
    return payload ? normalizeAgentGroup(payload, payload) : null;
  }

  function upsertAuthorizationAgentBinding(input: JsonRecord = {}, options: UpsertOptions = {}): AgentBindingRecord {
    const existing = projectionPayload("authorization.agent-binding", input.agentId || input.id || input.profileId);
    const binding = normalizeAgentBinding(input, existing || {});
    return upsertProjectedTag({
      tag: {
        tagId: agentBindingTagId(binding.agentId),
        kind: "character",
        label: binding.agentId,
        description: binding.profileId ? `Agent binding for ${binding.profileId}` : "Agent binding",
        enabled: binding.enabled,
        metadata: { characterType: "agent-binding" }
      },
      entityType: "authorization.agent-binding",
      entityId: binding.agentId,
      payload: binding,
      options
    });
  }

  function listAuthorizationAgentBindings({ includeDisabled = true }: { includeDisabled?: boolean } = {}): AgentBindingRecord[] {
    return listProjections({ entityType: "authorization.agent-binding", includeArchived: includeDisabled })
      .map((projection) => normalizeAgentBinding(record(projection.payload), record(projection.payload)))
      .filter((binding) => includeDisabled || binding.enabled !== false);
  }

  function getAuthorizationAgentBinding(agentId?: unknown): AgentBindingRecord | null {
    const payload = projectionPayload("authorization.agent-binding", normalizeIdSegment(agentId, "agent"));
    return payload ? normalizeAgentBinding(payload, payload) : null;
  }

  function upsertToolProfile(input: JsonRecord = {}, options: UpsertOptions = {}): ToolProfileRecord {
    const existing = projectionPayload("operation-permission.profile", input.id || input.profileId);
    const profile = normalizeToolProfile(input, existing || {});
    return upsertProjectedTag({
      tag: {
        tagId: toolProfileTagId(profile.id),
        kind: "character",
        label: profile.label,
        description: profile.agentType ? `Tool profile for ${profile.agentType}` : "Tool profile",
        enabled: profile.enabled,
        metadata: { characterType: "tool-profile" }
      },
      entityType: "operation-permission.profile",
      entityId: profile.id,
      payload: profile,
      options
    });
  }

  function listToolProfiles({ includeDisabled = false }: { includeDisabled?: boolean } = {}): ToolProfileRecord[] {
    return listProjections({ entityType: "operation-permission.profile", includeArchived: includeDisabled })
      .map((projection) => normalizeToolProfile(record(projection.payload), record(projection.payload)))
      .filter((profile) => includeDisabled || profile.enabled !== false);
  }

  function seedToolProfiles(profiles: unknown = []): { created: number } {
    let created = 0;
    for (const source of Array.isArray(profiles) ? profiles : []) {
      const profile = record(source);
      const id = String(profile.id || profile.profileId || "").trim();
      if (!id || hasProjection("operation-permission.profile", id)) {
        continue;
      }
      upsertToolProfile(profile, { eventType: "seed" });
      created += 1;
    }
    return { created };
  }

  function rebuildProjections(): { count: number } {
    db.prepare("DELETE FROM tag_management_projections").run();
    let count = 0;
    for (const tag of listTags({ includeArchived: true })) {
      const projectionsByKey = new Map<string, ProjectionInput>();
      const metadata = record(tag.metadata);
      if (Array.isArray(metadata.projections)) {
        for (const source of metadata.projections) {
          const projection = record(source);
          if (typeof projection.entityType === "string" && typeof projection.entityId === "string") {
            projectionsByKey.set(`${projection.entityType}\u0000${projection.entityId}`, {
              entityType: projection.entityType,
              entityId: projection.entityId,
              payload: projection.payload
            });
          }
        }
      }
      for (const projection of projectionsByKey.values()) {
        upsertProjection({
          tagId: tag.tagId,
          entityType: projection.entityType,
          entityId: projection.entityId,
          payload: projection.payload || {}
        });
        count += 1;
      }
    }
    appendEvent("rebuild", { payload: { count } });
    return { count };
  }

  function listEvents({ limit = 100, tagId = "", eventType = "" }: { limit?: number; tagId?: string; eventType?: string } = {}): EventRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (tagId) {
      clauses.push("tag_id = ?");
      params.push(String(tagId));
    }
    if (eventType) {
      clauses.push("event_type = ?");
      params.push(String(eventType));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(Number(limit || 100), 500)));
    return db.prepare(`
      SELECT * FROM tag_management_events
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params).map(eventFromRow).filter((event): event is EventRecord => event !== null);
  }

  function getPolicyRevision(): { protocolVersion: string; revision: number; updatedAt: string } {
    const row = record(db.prepare(`
      SELECT count(*) AS revision, max(created_at) AS updated_at
      FROM tag_management_events
    `).get());
    return {
      protocolVersion: TAG_MANAGEMENT_PROTOCOL_VERSION,
      revision: Number(row?.revision || 0),
      updatedAt: stringValue(row.updated_at)
    };
  }

  function organizationGovernanceError(code: string, message: string, options: OrganizationGovernanceErrorOptions = {}): OrganizationGovernanceError {
    const error = new Error(message) as OrganizationGovernanceError;
    error.code = code;
    error.statusCode = Number(options.statusCode || 409);
    if (Number.isInteger(options.currentRevision)) error.currentRevision = options.currentRevision;
    return error;
  }

  function getOrganizationGovernance(): OrganizationGovernanceSnapshot {
    const metadata = objectOrNull(db.prepare(
      "SELECT * FROM organization_governance_snapshot WHERE singleton_id = 1"
    ).get());
    if (!metadata) {
      throw organizationGovernanceError(
        "organization_governance_unavailable",
        "Organization governance snapshot is unavailable.",
        { statusCode: 503 }
      );
    }
    if (!metadata.configured) {
      return {
        protocolVersion: "v0.0.1:authorization:organization-governance-1",
        schemaVersion: "v0.0.1:authorization:organization-template-1",
        configured: false,
        revision: 0,
        templateKey: "",
        templateName: "",
        description: "",
        organizationDepth: 0,
        nodes: [],
        tags: [],
        roles: [],
        publishedAt: ""
      };
    }
    const nodes: OrganizationNode[] = db.prepare(
      "SELECT * FROM organization_governance_nodes ORDER BY ordinal ASC"
    ).all().map((value) => {
      const row = record(value);
      return {
        nodeId: stringValue(row.node_id),
        nodeType: stringValue(row.node_type),
        parentId: stringValue(row.parent_id),
        name: stringValue(row.name),
        ...(row.organization_level === null ? {} : { organizationLevel: Number(row.organization_level) })
      };
    });
    const tags: OrganizationTag[] = db.prepare(`
      SELECT tag.* FROM organization_governance_template_ownership owner
      JOIN tag_management_tags tag ON tag.tag_id = owner.entity_id
      WHERE owner.entity_type = 'tag'
      ORDER BY tag.tag_id ASC
    `).all().map((row) => tagFromRow(row)).filter((tag): tag is TagRecord => tag !== null).map((tag) => {
      return {
        tagId: tag.tagId,
        kind: tag.kind,
        label: tag.label,
        parentTagId: tag.parentTagId,
        description: tag.description,
        scopePrerequisites: uniqueStrings(tag.scopePrerequisites)
      };
    });
    const roles: OrganizationRole[] = db.prepare(`
      SELECT projection.payload_json FROM organization_governance_template_ownership owner
      JOIN tag_management_projections projection
        ON projection.entity_type = 'authorization.role' AND projection.entity_id = owner.entity_id
      WHERE owner.entity_type = 'role'
      ORDER BY owner.entity_id ASC
    `).all().map((value) => {
      const row = record(value);
      const payload = record(parseJson(row.payload_json, {}));
      return {
        roleId: stringValue(payload.roleId),
        name: stringValue(payload.name),
        scopeNodeId: stringValue(payload.scopeNodeId),
        scopeNodeType: stringValue(payload.scopeNodeType),
        managementActions: uniqueStrings(payload.managementActions),
        businessResourceActions: [],
        assignedSubjectIds: []
      };
    });
    return {
      protocolVersion: "v0.0.1:authorization:organization-governance-1",
      schemaVersion: stringValue(metadata.schema_version),
      configured: true,
      revision: Number(metadata.revision),
      templateKey: stringValue(metadata.template_key),
      templateName: stringValue(metadata.template_name),
      description: stringValue(metadata.description),
      organizationDepth: Number(metadata.organization_depth),
      nodes,
      tags,
      roles,
      publishedAt: stringValue(metadata.published_at)
    };
  }

  const publishOrganizationGovernanceTransaction = db.transaction(
    (draft: OrganizationGovernanceDraft, expectedRevision: number, publishedAt: string): OrganizationGovernanceSnapshot => {
      const current = getOrganizationGovernance();
      if (current.revision !== expectedRevision) {
        throw organizationGovernanceError(
          "organization_governance_revision_conflict",
          "Organization governance revision is stale.",
          { currentRevision: current.revision }
        );
      }
      const ownershipRows: GovernanceOwnershipRow[] = db.prepare(
        "SELECT entity_type, entity_id FROM organization_governance_template_ownership"
      ).all().map((value) => {
        const row = record(value);
        return { entityType: stringValue(row.entity_type), entityId: stringValue(row.entity_id) };
      });
      const ownedTags = new Set(ownershipRows.filter((row) => row.entityType === "tag")
        .map((row) => row.entityId));
      const ownedRoles = new Set(ownershipRows.filter((row) => row.entityType === "role")
        .map((row) => row.entityId));
      for (const tag of draft.tags) {
        if (getTag(tag.tagId) && !ownedTags.has(tag.tagId)) {
          throw organizationGovernanceError(
            "organization_governance_collision",
            "Organization template tag collides with an unmanaged tag."
          );
        }
      }
      const draftTagsById = new Map<string, OrganizationTag>(
        draft.tags.map((tag) => [tag.tagId, tag])
      );
      for (const role of draft.roles) {
        if ((getAuthorizationRole(role.roleId) || getTag(roleTagId(role.roleId))) && !ownedRoles.has(role.roleId)) {
          throw organizationGovernanceError(
            "organization_governance_collision",
            "Organization template role collides with an unmanaged role."
          );
        }
      }

      const nextTagIds = new Set(draft.tags.map((tag) => tag.tagId));
      const nextRoleIds = new Set(draft.roles.map((role) => role.roleId));
      for (const tagId of ownedTags) {
        if (nextTagIds.has(tagId)) continue;
        const existing = getTag(tagId);
        if (!existing) continue;
        tagUpsert.run(
          existing.tagId, existing.kind, existing.label, existing.description, existing.parentTagId,
          0, existing.system ? 1 : 0, ARCHIVED_STATUS,
          stringifyJson(existing.scopePrerequisites, []), stringifyJson(existing.metadata, {}),
          existing.createdAt, publishedAt
        );
      }
      for (const roleId of ownedRoles) {
        if (nextRoleIds.has(roleId)) continue;
        const existing = getAuthorizationRole(roleId);
        if (!existing) continue;
        const disabled: RoleRecord = { ...existing, enabled: false, businessResourceActions: [], assignedSubjectIds: [] };
        projectionUpsert.run(
          roleTagId(roleId), "authorization.role", roleId, stringifyJson(disabled, {}), publishedAt
        );
        const roleTag = getTag(roleTagId(roleId));
        if (roleTag) {
          tagUpsert.run(
            roleTag.tagId, roleTag.kind, roleTag.label, roleTag.description, roleTag.parentTagId,
            0, roleTag.system ? 1 : 0, ARCHIVED_STATUS,
            stringifyJson(roleTag.scopePrerequisites, []), stringifyJson(roleTag.metadata, {}),
            roleTag.createdAt, publishedAt
          );
        }
      }

      db.prepare("DELETE FROM organization_governance_template_ownership").run();
      db.prepare("DELETE FROM organization_governance_nodes").run();
      const insertNode = db.prepare(`
        INSERT INTO organization_governance_nodes (
          ordinal, node_id, node_type, parent_id, name, organization_level
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertOwnership = db.prepare(`
        INSERT INTO organization_governance_template_ownership (entity_type, entity_id, template_key)
        VALUES (?, ?, ?)
      `);
      for (const [index, node] of draft.nodes.entries()) {
        insertNode.run(
          index, node.nodeId, node.nodeType, node.parentId, node.name,
          node.organizationLevel === undefined ? null : node.organizationLevel
        );
      }
      for (const tag of draft.tags) {
        const existing = getTag(tag.tagId);
        tagUpsert.run(
          tag.tagId, tag.kind, tag.label, tag.description, tag.parentTagId, 1, 0, ACTIVE_STATUS,
          stringifyJson(tag.scopePrerequisites, []),
          stringifyJson({ organizationTemplate: { templateKey: draft.templateKey, entityId: tag.tagId } }, {}),
          existing?.createdAt || publishedAt, publishedAt
        );
        insertOwnership.run("tag", tag.tagId, draft.templateKey);
      }
      for (const role of draft.roles) {
        const rolePayload: JsonRecord = {
          roleId: role.roleId,
          name: role.name,
          label: role.name,
          description: "",
          scopeNodeId: role.scopeNodeId,
          scopeNodeType: role.scopeNodeType,
          managementActions: role.managementActions,
          businessResourceActions: [],
          assignedSubjectIds: [],
          resourcePolicies: [],
          scopes: role.managementActions,
          system: false,
          enabled: true,
          createdAt: publishedAt,
          updatedAt: publishedAt
        };
        const tagId = roleTagId(role.roleId);
        const existingTag = getTag(tagId);
        const scopeTag = draftTagsById.get(role.scopeNodeId);
        if (!scopeTag) {
          throw organizationGovernanceError(
            "organization_governance_invalid",
            "Organization role references an unknown scope tag.",
            { statusCode: 400 }
          );
        }
        tagUpsert.run(
          tagId, "role", role.name, "", scopeTag.parentTagId, 1, 0, ACTIVE_STATUS,
          stringifyJson(role.managementActions, []),
          stringifyJson({ organizationTemplate: { templateKey: draft.templateKey, entityId: role.roleId } }, {}),
          existingTag?.createdAt || publishedAt, publishedAt
        );
        projectionUpsert.run(
          tagId, "authorization.role", role.roleId, stringifyJson(rolePayload, {}), publishedAt
        );
        insertOwnership.run("role", role.roleId, draft.templateKey);
      }
      db.prepare(`
        UPDATE organization_governance_snapshot SET
          configured = 1,
          revision = ?,
          schema_version = ?,
          template_key = ?,
          template_name = ?,
          description = ?,
          organization_depth = ?,
          published_at = ?
        WHERE singleton_id = 1
      `).run(
        current.revision + 1, draft.schemaVersion, draft.templateKey, draft.templateName,
        draft.description, draft.organizationDepth, publishedAt
      );
      db.prepare(`
        INSERT INTO tag_management_events (
          event_id, tag_id, entity_type, entity_id, event_type, payload_json, created_at
        ) VALUES (?, '', 'organization-governance', 'organization-governance', 'published', ?, ?)
      `).run(
        randomId("tag_event"),
        stringifyJson({ templateKey: draft.templateKey, revision: current.revision + 1 }, {}),
        publishedAt
      );
      return getOrganizationGovernance();
    }
  );

  function publishOrganizationGovernance(input: unknown, expectedRevision: number): OrganizationGovernanceSnapshot {
    const draft = organizationGovernanceDraft(input);
    if (!draft) {
      throw organizationGovernanceError(
        "organization_governance_invalid",
        "Organization governance draft is invalid.",
        { statusCode: 400 }
      );
    }
    const snapshot = publishOrganizationGovernanceTransaction.immediate(
      draft,
      expectedRevision,
      nowIso()
    );
    for (const handler of changeHandlers) {
      try { handler(Object.freeze({ eventType: "organization-governance-published" })); } catch {
        // Publication is already committed; subscribers reconcile independently.
      }
    }
    return snapshot;
  }

  return Object.freeze({
    protocolVersion: TAG_MANAGEMENT_PROTOCOL_VERSION,
    userDataPath: resolvedUserDataPath,
    rootPath: resolvedRoot,
    isClosed(): boolean {
      return closed || db.open === false;
    },
    close(): void {
      if (closed) return;
      for (const handler of ownedChangeHandlers) changeHandlers.delete(handler);
      ownedChangeHandlers.clear();
      if (changeHandlers.size === 0) changeHandlersByRoot.delete(String(resolvedRoot));
      if (ownsDatabase && db.open !== false) db.close();
      closed = true;
    },
    archiveTag,
    getAuthorizationAgentBinding,
    getAuthorizationDepartment,
    getAuthorizationAgentGroup,
    getAuthorizationRole,
    getOrganizationGovernance,
    getAuthorizationTeam,
    getPolicyRevision,
    registerChangeHandler(handler?: ChangeHandler): () => boolean | void {
      if (typeof handler !== "function") return (): void => {};
      changeHandlers.add(handler);
      ownedChangeHandlers.add(handler);
      return (): boolean => {
        ownedChangeHandlers.delete(handler);
        return changeHandlers.delete(handler);
      };
    },
    getProjection,
    getEffectiveScopePrerequisites,
    getTag,
    hasProjection,
    listAuthorizationAgentBindings,
    listAuthorizationDepartments,
    listAuthorizationAgentGroups,
    listAuthorizationRoles,
    listAuthorizationTeams,
    listEvents,
    listProjections,
    listTags,
    listToolProfiles,
    rebuildProjections,
    restoreTag,
    seedToolProfiles,
    publishOrganizationGovernance,
    upsertAuthorizationAgentBinding,
    upsertAuthorizationDepartment,
    upsertAuthorizationAgentGroup,
    upsertAuthorizationRole,
    upsertAuthorizationTeam,
    upsertProjection,
    upsertTag,
    upsertToolProfile
  });
}
