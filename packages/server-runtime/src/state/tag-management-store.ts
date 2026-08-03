import fs from "node:fs";
import path from "node:path";
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
import { ensureTagManagementSchema } from "./tag-management-schema.ts";

export { TAG_MANAGEMENT_PROTOCOL_VERSION } from "./tag-management-codec.ts";

function roleTagId(roleId?: any) : any {
  return `role:${normalizeIdSegment(roleId, "role")}`;
}

function teamTagId(teamId?: any) : any {
  return `group:team:${normalizeIdSegment(teamId, "team")}`;
}

function departmentTagId(departmentId?: any) : any {
  return `group:department:${normalizeIdSegment(departmentId, "department")}`;
}

function agentGroupTagId(groupId?: any) : any {
  return `group:agent:${normalizeIdSegment(groupId, "agent-group")}`;
}

function agentBindingTagId(agentId?: any) : any {
  return `character:agent:${normalizeIdSegment(agentId, "agent")}`;
}

function toolProfileTagId(profileId?: any) : any {
  return `character:tool-profile:${normalizeIdSegment(profileId, "profile")}`;
}

function normalizeRole(input: Record<string, any> = {}, fallback: Record<string, any> = {}) : any {
  const roleId: any = normalizeIdSegment(input.roleId || input.id || fallback.roleId, "role");
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

function normalizeTeam(input: Record<string, any> = {}, fallback: Record<string, any> = {}) : any {
  const teamId: any = normalizeIdSegment(input.teamId || input.id || fallback.teamId, "team");
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

function normalizeDepartment(input: Record<string, any> = {}, fallback: Record<string, any> = {}) : any {
  const departmentId: any = normalizeIdSegment(input.departmentId || input.id || fallback.departmentId, "department");
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

function normalizeAgentGroup(input: Record<string, any> = {}, fallback: Record<string, any> = {}) : any {
  const groupId: any = normalizeIdSegment(input.groupId || input.id || fallback.groupId, "agent-group");
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

function normalizeAgentBinding(input: Record<string, any> = {}, fallback: Record<string, any> = {}) : any {
  const agentId: any = normalizeIdSegment(input.agentId || input.id || input.profileId || fallback.agentId, "agent");
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

function normalizeToolProfile(input: Record<string, any> = {}, fallback: Record<string, any> = {}) : any {
  const id: any = normalizeIdSegment(input.id || input.profileId || fallback.id, "profile");
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

export function getTagManagementDatabasePath(userDataPath: any = "") : any {
  return path.join(userDataPath || ServerConfig.getDataDir(), "security", "tag-management", "tag-management.sqlite");
}

export function createTagManagementStore({
  userDataPath = "",
  rootPath = "",
  db: injectedDatabase = null
}: Record<string, any> = {}) : any {
  const resolvedUserDataPath: any = path.resolve(userDataPath || ServerConfig.getDataDir());
  const resolvedRoot: any = rootPath ||
    path.join(resolvedUserDataPath, "security", "tag-management");
  if (!injectedDatabase) {
    fs.mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  }
  const db: any = injectedDatabase || openSqliteDatabase(path.join(resolvedRoot, "tag-management.sqlite"));
  const ownsDatabase: any = !injectedDatabase;
  try {
    return createTagManagementStoreFromDatabase({
      db,
      ownsDatabase,
      resolvedUserDataPath,
      resolvedRoot
    });
  } catch (error: any) {
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
}: Record<string, any>) : any {
  let closed: any = false;
  const changeHandlers: any = new Set<any>();
  ensureTagManagementSchema(db);

  const tagUpsert: any = db.prepare(`
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
  const projectionUpsert: any = db.prepare(`
    INSERT INTO tag_management_projections (
      tag_id, entity_type, entity_id, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tag_id, entity_type, entity_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);

  function appendEvent(eventType?: any, { tagId = "", entityType = "", entityId = "", payload = {} }: Record<string, any> = {}) : any {
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

  function getTag(tagId?: any) : any {
    return tagFromRow(db.prepare("SELECT * FROM tag_management_tags WHERE tag_id = ?").get(String(tagId || "")));
  }

  function listTags({ kind = "", includeArchived = true, status = "", parentTagId = undefined }: Record<string, any> = {}) : any {
    const clauses: any[] = [];
    const params: any[] = [];
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
    const where: any = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`SELECT * FROM tag_management_tags ${where} ORDER BY kind ASC, parent_tag_id ASC, tag_id ASC`)
      .all(...params)
      .map(tagFromRow);
  }

  function assertParentAllowed(tagId?: any, parentTagId?: any) : any {
    assertTagParentChangeAllowed({ getTag, tagId, parentTagId });
  }

  function canonicalTagInput(input: Record<string, any> = {}, fallback: Record<string, any> = {}) : any {
    const kind: any = normalizeKind(input.kind || fallback.kind || "custom");
    const tagId: any = normalizeTagId(input.tagId || input.id || fallback.tagId, kind);
    const parentTagId: any = String(input.parentTagId ?? fallback.parentTagId ?? "").trim();
    assertParentAllowed(tagId, parentTagId);
    const status: any = normalizeStatus(input.status, fallback.status || ACTIVE_STATUS);
    const incomingEnabled: any = input.enabled ?? fallback.enabled ?? true;
    const enabled: any = status === ARCHIVED_STATUS ? false : incomingEnabled !== false;
    const metadata: Record<string, any> = {
      ...(objectOrNull(input.metadata) || objectOrNull(fallback.metadata) || {})
    };
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

  function upsertTag(input: Record<string, any> = {}, options: Record<string, any> = {}) : any {
    const existing: any = getTag(input.tagId || input.id);
    const tag: any = canonicalTagInput(input, existing || {});
    const before: any = existing ? JSON.stringify({
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
    const saved: any = getTag(tag.tagId);
    const after: any = JSON.stringify({
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

  function archiveTag(tagId?: any, input: Record<string, any> = {}) : any {
    const existing: any = getTag(tagId);
    if (!existing) {
      throw new Error(`Unknown tag: ${tagId}`);
    }
    if (existing.system) {
      throw new Error("System tags cannot be archived.");
    }
    const saved: any = upsertTag({
      ...existing,
      enabled: false,
      status: ARCHIVED_STATUS,
      metadata: {
        ...existing.metadata,
        archiveReason: String(input.reason || existing.metadata?.archiveReason || "").trim()
      }
    }, { eventType: "archive" });
    return saved;
  }

  function restoreTag(tagId?: any) : any {
    const existing: any = getTag(tagId);
    if (!existing) {
      throw new Error(`Unknown tag: ${tagId}`);
    }
    return upsertTag({
      ...existing,
      enabled: true,
      status: ACTIVE_STATUS
    }, { eventType: "restore" });
  }

  function getEffectiveScopePrerequisites(tagId?: any) : any {
    return effectiveScopePrerequisitesForTag({ getTag, tagId });
  }

  function canonicalProjections(...collections: any[]) : any {
    const projectionsByKey: any = new Map<any, any>();
    for (const collection of collections) {
      for (const item of Array.isArray(collection) ? collection : []) {
        if (!item?.entityType || !item?.entityId) continue;
        const projection: Record<string, any> = {
          entityType: String(item.entityType),
          entityId: String(item.entityId),
          payload: objectOrNull(item.payload) || {}
        };
        projectionsByKey.set(`${projection.entityType}\u0000${projection.entityId}`, projection);
      }
    }
    return [...projectionsByKey.values()];
  }

  function upsertProjection({ tagId, entityType, entityId, payload = {} }: Record<string, any> = {}) : any {
    const normalizedTagId: any = String(tagId || "").trim();
    const normalizedEntityType: any = String(entityType || "").trim();
    const normalizedEntityId: any = String(entityId || "").trim();
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
    return getProjection(normalizedEntityType, normalizedEntityId);
  }

  function rememberProjectionOnTag(tagId?: any, projection?: any) : any {
    const tag: any = getTag(tagId);
    if (!tag) {
      return;
    }
    const metadata: any = objectOrNull(tag.metadata) || {};
    const existing: any = Array.isArray(metadata.projections)
      ? metadata.projections
      : [];
    const projections: any = canonicalProjections(existing, [projection]);
    db.prepare("UPDATE tag_management_tags SET metadata_json = ?, updated_at = ? WHERE tag_id = ?")
      .run(stringifyJson({ ...metadata, projections }, {}), nowIso(), tagId);
  }

  function getProjection(entityType?: any, entityId?: any) : any {
    return projectionFromRow(db.prepare(`
      SELECT * FROM tag_management_projections
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(String(entityType || ""), String(entityId || "")));
  }

  function hasProjection(entityType?: any, entityId?: any) : any {
    return Boolean(getProjection(entityType, entityId));
  }

  function listProjections({ entityType = "", kind = "", includeArchived = true }: Record<string, any> = {}) : any {
    const clauses: any[] = ["1 = 1"];
    const params: any[] = [];
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
    `).all(...params).map(projectionFromRow);
  }

  function upsertProjectedTag({ tag, entityType, entityId, payload, options = {} }: Record<string, any>) : any {
    const existingMetadata: any = objectOrNull(getTag(tag.tagId)?.metadata) || {};
    const incomingMetadata: any = objectOrNull(tag.metadata) || {};
    const metadata: Record<string, any> = {
      ...existingMetadata,
      ...incomingMetadata,
      projections: canonicalProjections(
        existingMetadata.projections,
        incomingMetadata.projections,
        [{ entityType, entityId, payload }]
      )
    };
    const savedTag: any = upsertTag({
      ...tag,
      metadata
    }, {
      ...options,
      entityType,
      entityId
    });
    upsertProjection({ tagId: savedTag.tagId, entityType, entityId, payload });
    return payload;
  }

  function projectionPayload(entityType?: any, entityId?: any) : any {
    return getProjection(entityType, entityId)?.payload || null;
  }

  function upsertAuthorizationRole(input: Record<string, any> = {}, options: Record<string, any> = {}) : any {
    const existing: any = projectionPayload("authorization.role", input.roleId || input.id);
    const role: any = normalizeRole(input, existing || {});
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

  function listAuthorizationRoles({ includeDisabled = true }: Record<string, any> = {}) : any {
    return listProjections({ entityType: "authorization.role", includeArchived: includeDisabled })
      .map((projection?: any) : any => projection.payload)
      .filter((role?: any) : any => includeDisabled || role.enabled !== false);
  }

  function getAuthorizationRole(roleId?: any) : any {
    return projectionPayload("authorization.role", normalizeIdSegment(roleId, "role"));
  }

  function upsertAuthorizationTeam(input: Record<string, any> = {}, options: Record<string, any> = {}) : any {
    const existing: any = projectionPayload("authorization.team", input.teamId || input.id);
    const team: any = normalizeTeam(input, existing || {});
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

  function listAuthorizationTeams({ includeDisabled = true }: Record<string, any> = {}) : any {
    return listProjections({ entityType: "authorization.team", includeArchived: includeDisabled })
      .map((projection?: any) : any => projection.payload)
      .filter((team?: any) : any => includeDisabled || team.enabled !== false);
  }

  function getAuthorizationTeam(teamId?: any) : any {
    return projectionPayload("authorization.team", normalizeIdSegment(teamId, "team"));
  }

  function upsertAuthorizationDepartment(input: Record<string, any> = {}, options: Record<string, any> = {}) : any {
    const existing: any = projectionPayload("authorization.department", input.departmentId || input.id);
    const department: any = normalizeDepartment(input, existing || {});
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

  function listAuthorizationDepartments({ includeDisabled = true }: Record<string, any> = {}) : any {
    return listProjections({ entityType: "authorization.department", includeArchived: includeDisabled })
      .map((projection?: any) : any => projection.payload)
      .filter((department?: any) : any => includeDisabled || department.enabled !== false);
  }

  function getAuthorizationDepartment(departmentId?: any) : any {
    return projectionPayload("authorization.department", normalizeIdSegment(departmentId, "department"));
  }

  function upsertAuthorizationAgentGroup(input: Record<string, any> = {}, options: Record<string, any> = {}) : any {
    const existing: any = projectionPayload("authorization.agent-group", input.groupId || input.id);
    const group: any = normalizeAgentGroup(input, existing || {});
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

  function listAuthorizationAgentGroups({ includeDisabled = true }: Record<string, any> = {}) : any {
    return listProjections({ entityType: "authorization.agent-group", includeArchived: includeDisabled })
      .map((projection?: any) : any => projection.payload)
      .filter((group?: any) : any => includeDisabled || group.enabled !== false);
  }

  function getAuthorizationAgentGroup(groupId?: any) : any {
    return projectionPayload("authorization.agent-group", normalizeIdSegment(groupId, "agent-group"));
  }

  function upsertAuthorizationAgentBinding(input: Record<string, any> = {}, options: Record<string, any> = {}) : any {
    const existing: any = projectionPayload("authorization.agent-binding", input.agentId || input.id || input.profileId);
    const binding: any = normalizeAgentBinding(input, existing || {});
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

  function listAuthorizationAgentBindings({ includeDisabled = true }: Record<string, any> = {}) : any {
    return listProjections({ entityType: "authorization.agent-binding", includeArchived: includeDisabled })
      .map((projection?: any) : any => projection.payload)
      .filter((binding?: any) : any => includeDisabled || binding.enabled !== false);
  }

  function getAuthorizationAgentBinding(agentId?: any) : any {
    return projectionPayload("authorization.agent-binding", normalizeIdSegment(agentId, "agent"));
  }

  function upsertToolProfile(input: Record<string, any> = {}, options: Record<string, any> = {}) : any {
    const existing: any = projectionPayload("operation-permission.profile", input.id || input.profileId);
    const profile: any = normalizeToolProfile(input, existing || {});
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

  function listToolProfiles({ includeDisabled = false }: Record<string, any> = {}) : any {
    return listProjections({ entityType: "operation-permission.profile", includeArchived: includeDisabled })
      .map((projection?: any) : any => projection.payload)
      .filter((profile?: any) : any => includeDisabled || profile.enabled !== false);
  }

  function seedToolProfiles(profiles: any = []) : any {
    let created: any = 0;
    for (const profile of Array.isArray(profiles) ? profiles : []) {
      const id: any = String(profile?.id || profile?.profileId || "").trim();
      if (!id || hasProjection("operation-permission.profile", id)) {
        continue;
      }
      upsertToolProfile(profile, { eventType: "seed" });
      created += 1;
    }
    return { created };
  }

  function rebuildProjections() : any {
    db.prepare("DELETE FROM tag_management_projections").run();
    let count: any = 0;
    for (const tag of listTags({ includeArchived: true })) {
      const projectionsByKey: any = new Map<any, any>();
      if (Array.isArray(tag.metadata?.projections)) {
        for (const projection of tag.metadata.projections) {
          if (projection?.entityType && projection?.entityId) {
            projectionsByKey.set(`${projection.entityType}\u0000${projection.entityId}`, projection);
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

  function listEvents({ limit = 100, tagId = "", eventType = "" }: Record<string, any> = {}) : any {
    const clauses: any[] = [];
    const params: any[] = [];
    if (tagId) {
      clauses.push("tag_id = ?");
      params.push(String(tagId));
    }
    if (eventType) {
      clauses.push("event_type = ?");
      params.push(String(eventType));
    }
    const where: any = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(Number(limit || 100), 500)));
    return db.prepare(`
      SELECT * FROM tag_management_events
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params).map(eventFromRow);
  }

  function getPolicyRevision() : any {
    const row: any = db.prepare(`
      SELECT count(*) AS revision, max(created_at) AS updated_at
      FROM tag_management_events
    `).get();
    return {
      protocolVersion: TAG_MANAGEMENT_PROTOCOL_VERSION,
      revision: Number(row?.revision || 0),
      updatedAt: row?.updated_at || ""
    };
  }

  function organizationGovernanceError(code?: any, message?: any, options: Record<string, any> = {}) : any {
    const error: Error & Record<string, any> = new Error(message);
    error.code = code;
    error.statusCode = Number(options.statusCode || 409);
    if (Number.isInteger(options.currentRevision)) error.currentRevision = options.currentRevision;
    return error;
  }

  function getOrganizationGovernance() : any {
    const metadata: any = db.prepare(
      "SELECT * FROM organization_governance_snapshot WHERE singleton_id = 1"
    ).get();
    if (!metadata) {
      throw organizationGovernanceError(
        "organization_governance_unavailable",
        "Organization governance snapshot is unavailable.",
        { statusCode: 503 }
      );
    }
    if (!Boolean(metadata.configured)) {
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
    const nodes: any[] = db.prepare(
      "SELECT * FROM organization_governance_nodes ORDER BY ordinal ASC"
    ).all().map((row?: any) : any => ({
      nodeId: row.node_id,
      nodeType: row.node_type,
      parentId: row.parent_id,
      name: row.name,
      ...(row.organization_level === null ? {} : { organizationLevel: Number(row.organization_level) })
    }));
    const tags: any[] = db.prepare(`
      SELECT tag.* FROM organization_governance_template_ownership owner
      JOIN tag_management_tags tag ON tag.tag_id = owner.entity_id
      WHERE owner.entity_type = 'tag'
      ORDER BY tag.tag_id ASC
    `).all().map((row?: any) : any => {
      const tag: any = tagFromRow(row);
      return {
        tagId: tag.tagId,
        kind: tag.kind,
        label: tag.label,
        parentTagId: tag.parentTagId,
        description: tag.description,
        scopePrerequisites: tag.scopePrerequisites
      };
    });
    const roles: any[] = db.prepare(`
      SELECT projection.payload_json FROM organization_governance_template_ownership owner
      JOIN tag_management_projections projection
        ON projection.entity_type = 'authorization.role' AND projection.entity_id = owner.entity_id
      WHERE owner.entity_type = 'role'
      ORDER BY owner.entity_id ASC
    `).all().map((row?: any) : any => {
      const payload: any = parseJson(row.payload_json, {});
      return {
        roleId: payload.roleId,
        name: payload.name,
        scopeNodeId: payload.scopeNodeId,
        scopeNodeType: payload.scopeNodeType,
        managementActions: uniqueStrings(payload.managementActions),
        businessResourceActions: [],
        assignedSubjectIds: []
      };
    });
    return {
      protocolVersion: "v0.0.1:authorization:organization-governance-1",
      schemaVersion: metadata.schema_version,
      configured: true,
      revision: Number(metadata.revision),
      templateKey: metadata.template_key,
      templateName: metadata.template_name,
      description: metadata.description,
      organizationDepth: Number(metadata.organization_depth),
      nodes,
      tags,
      roles,
      publishedAt: metadata.published_at
    };
  }

  const publishOrganizationGovernanceTransaction: any = db.transaction(
    (draft?: any, expectedRevision?: any, publishedAt?: any) : any => {
      const current: any = getOrganizationGovernance();
      if (current.revision !== expectedRevision) {
        throw organizationGovernanceError(
          "organization_governance_revision_conflict",
          "Organization governance revision is stale.",
          { currentRevision: current.revision }
        );
      }
      const ownershipRows: any[] = db.prepare(
        "SELECT entity_type, entity_id FROM organization_governance_template_ownership"
      ).all();
      const ownedTags: any = new Set<any>(ownershipRows.filter((row?: any) : any => row.entity_type === "tag")
        .map((row?: any) : any => row.entity_id));
      const ownedRoles: any = new Set<any>(ownershipRows.filter((row?: any) : any => row.entity_type === "role")
        .map((row?: any) : any => row.entity_id));
      for (const tag of draft.tags) {
        if (getTag(tag.tagId) && !ownedTags.has(tag.tagId)) {
          throw organizationGovernanceError(
            "organization_governance_collision",
            "Organization template tag collides with an unmanaged tag."
          );
        }
      }
      const draftTagsById: any = new Map<any, any>(
        draft.tags.map((tag?: any) : any => [tag.tagId, tag])
      );
      for (const role of draft.roles) {
        if ((getAuthorizationRole(role.roleId) || getTag(roleTagId(role.roleId))) && !ownedRoles.has(role.roleId)) {
          throw organizationGovernanceError(
            "organization_governance_collision",
            "Organization template role collides with an unmanaged role."
          );
        }
      }

      const nextTagIds: any = new Set<any>(draft.tags.map((tag?: any) : any => tag.tagId));
      const nextRoleIds: any = new Set<any>(draft.roles.map((role?: any) : any => role.roleId));
      for (const tagId of ownedTags) {
        if (nextTagIds.has(tagId)) continue;
        const existing: any = getTag(tagId);
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
        const existing: any = getAuthorizationRole(roleId);
        if (!existing) continue;
        const disabled: any = { ...existing, enabled: false, businessResourceActions: [], assignedSubjectIds: [] };
        projectionUpsert.run(
          roleTagId(roleId), "authorization.role", roleId, stringifyJson(disabled, {}), publishedAt
        );
        const roleTag: any = getTag(roleTagId(roleId));
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
      const insertNode: any = db.prepare(`
        INSERT INTO organization_governance_nodes (
          ordinal, node_id, node_type, parent_id, name, organization_level
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertOwnership: any = db.prepare(`
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
        const existing: any = getTag(tag.tagId);
        tagUpsert.run(
          tag.tagId, tag.kind, tag.label, tag.description, tag.parentTagId, 1, 0, ACTIVE_STATUS,
          stringifyJson(tag.scopePrerequisites, []),
          stringifyJson({ organizationTemplate: { templateKey: draft.templateKey, entityId: tag.tagId } }, {}),
          existing?.createdAt || publishedAt, publishedAt
        );
        insertOwnership.run("tag", tag.tagId, draft.templateKey);
      }
      for (const role of draft.roles) {
        const rolePayload: any = {
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
        const tagId: any = roleTagId(role.roleId);
        const existingTag: any = getTag(tagId);
        const scopeTag: any = draftTagsById.get(role.scopeNodeId);
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

  function publishOrganizationGovernance(draft?: any, expectedRevision?: any) : any {
    const snapshot: any = publishOrganizationGovernanceTransaction.immediate(
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
    db,
    isClosed() : any {
      return closed || db.open === false;
    },
    close() : any {
      if (closed || (ownsDatabase && db.open === false)) {
        closed = true;
        return;
      }
      if (ownsDatabase) db.close();
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
    registerChangeHandler(handler?: any) : any {
      if (typeof handler !== "function") return () : any => {};
      changeHandlers.add(handler);
      return () : any => changeHandlers.delete(handler);
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
