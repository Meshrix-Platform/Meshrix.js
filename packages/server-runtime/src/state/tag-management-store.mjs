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
} from "./tag-management-codec.mjs";
import { ensureTagManagementSchema } from "./tag-management-schema.mjs";

export { TAG_MANAGEMENT_PROTOCOL_VERSION } from "./tag-management-codec.mjs";

function roleTagId(roleId) {
  return `role:${normalizeIdSegment(roleId, "role")}`;
}

function teamTagId(teamId) {
  return `group:team:${normalizeIdSegment(teamId, "team")}`;
}

function departmentTagId(departmentId) {
  return `group:department:${normalizeIdSegment(departmentId, "department")}`;
}

function agentGroupTagId(groupId) {
  return `group:agent:${normalizeIdSegment(groupId, "agent-group")}`;
}

function agentBindingTagId(agentId) {
  return `character:agent:${normalizeIdSegment(agentId, "agent")}`;
}

function toolProfileTagId(profileId) {
  return `character:tool-profile:${normalizeIdSegment(profileId, "profile")}`;
}

function normalizeRole(input = {}, fallback = {}) {
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

function normalizeTeam(input = {}, fallback = {}) {
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

function normalizeDepartment(input = {}, fallback = {}) {
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

function normalizeAgentGroup(input = {}, fallback = {}) {
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

function normalizeAgentBinding(input = {}, fallback = {}) {
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

function normalizeToolProfile(input = {}, fallback = {}) {
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

export function getTagManagementDatabasePath(userDataPath = "") {
  return path.join(userDataPath || ServerConfig.getDataDir(), "security", "tag-management", "tag-management.sqlite");
}

export function createTagManagementStore({
  userDataPath = "",
  rootPath = "",
  db: injectedDatabase = null
} = {}) {
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
  } catch (error) {
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
}) {
  let closed = false;
  const changeHandlers = new Set();
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

  function appendEvent(eventType, { tagId = "", entityType = "", entityId = "", payload = {} } = {}) {
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

  function getTag(tagId) {
    return tagFromRow(db.prepare("SELECT * FROM tag_management_tags WHERE tag_id = ?").get(String(tagId || "")));
  }

  function listTags({ kind = "", includeArchived = true, status = "", parentTagId = undefined } = {}) {
    const clauses = [];
    const params = [];
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
      .map(tagFromRow);
  }

  function assertParentAllowed(tagId, parentTagId) {
    assertTagParentChangeAllowed({ getTag, tagId, parentTagId });
  }

  function canonicalTagInput(input = {}, fallback = {}) {
    const kind = normalizeKind(input.kind || fallback.kind || "custom");
    const tagId = normalizeTagId(input.tagId || input.id || fallback.tagId, kind);
    const parentTagId = String(input.parentTagId ?? fallback.parentTagId ?? "").trim();
    assertParentAllowed(tagId, parentTagId);
    const status = normalizeStatus(input.status, fallback.status || ACTIVE_STATUS);
    const incomingEnabled = input.enabled ?? fallback.enabled ?? true;
    const enabled = status === ARCHIVED_STATUS ? false : incomingEnabled !== false;
    const metadata = {
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

  function upsertTag(input = {}, options = {}) {
    const existing = getTag(input.tagId || input.id);
    const tag = canonicalTagInput(input, existing || {});
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

  function archiveTag(tagId, input = {}) {
    const existing = getTag(tagId);
    if (!existing) {
      throw new Error(`Unknown tag: ${tagId}`);
    }
    if (existing.system) {
      throw new Error("System tags cannot be archived.");
    }
    const saved = upsertTag({
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

  function restoreTag(tagId) {
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

  function getEffectiveScopePrerequisites(tagId) {
    return effectiveScopePrerequisitesForTag({ getTag, tagId });
  }

  function canonicalProjections(...collections) {
    const projectionsByKey = new Map();
    for (const collection of collections) {
      for (const item of Array.isArray(collection) ? collection : []) {
        if (!item?.entityType || !item?.entityId) continue;
        const projection = {
          entityType: String(item.entityType),
          entityId: String(item.entityId),
          payload: objectOrNull(item.payload) || {}
        };
        projectionsByKey.set(`${projection.entityType}\u0000${projection.entityId}`, projection);
      }
    }
    return [...projectionsByKey.values()];
  }

  function upsertProjection({ tagId, entityType, entityId, payload = {} } = {}) {
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
    return getProjection(normalizedEntityType, normalizedEntityId);
  }

  function rememberProjectionOnTag(tagId, projection) {
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

  function getProjection(entityType, entityId) {
    return projectionFromRow(db.prepare(`
      SELECT * FROM tag_management_projections
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(String(entityType || ""), String(entityId || "")));
  }

  function hasProjection(entityType, entityId) {
    return Boolean(getProjection(entityType, entityId));
  }

  function listProjections({ entityType = "", kind = "", includeArchived = true } = {}) {
    const clauses = ["1 = 1"];
    const params = [];
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

  function upsertProjectedTag({ tag, entityType, entityId, payload, options = {} }) {
    const existingMetadata = objectOrNull(getTag(tag.tagId)?.metadata) || {};
    const incomingMetadata = objectOrNull(tag.metadata) || {};
    const metadata = {
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
    upsertProjection({ tagId: savedTag.tagId, entityType, entityId, payload });
    return payload;
  }

  function projectionPayload(entityType, entityId) {
    return getProjection(entityType, entityId)?.payload || null;
  }

  function upsertAuthorizationRole(input = {}, options = {}) {
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

  function listAuthorizationRoles({ includeDisabled = true } = {}) {
    return listProjections({ entityType: "authorization.role", includeArchived: includeDisabled })
      .map((projection) => projection.payload)
      .filter((role) => includeDisabled || role.enabled !== false);
  }

  function getAuthorizationRole(roleId) {
    return projectionPayload("authorization.role", normalizeIdSegment(roleId, "role"));
  }

  function upsertAuthorizationTeam(input = {}, options = {}) {
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

  function listAuthorizationTeams({ includeDisabled = true } = {}) {
    return listProjections({ entityType: "authorization.team", includeArchived: includeDisabled })
      .map((projection) => projection.payload)
      .filter((team) => includeDisabled || team.enabled !== false);
  }

  function getAuthorizationTeam(teamId) {
    return projectionPayload("authorization.team", normalizeIdSegment(teamId, "team"));
  }

  function upsertAuthorizationDepartment(input = {}, options = {}) {
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

  function listAuthorizationDepartments({ includeDisabled = true } = {}) {
    return listProjections({ entityType: "authorization.department", includeArchived: includeDisabled })
      .map((projection) => projection.payload)
      .filter((department) => includeDisabled || department.enabled !== false);
  }

  function getAuthorizationDepartment(departmentId) {
    return projectionPayload("authorization.department", normalizeIdSegment(departmentId, "department"));
  }

  function upsertAuthorizationAgentGroup(input = {}, options = {}) {
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

  function listAuthorizationAgentGroups({ includeDisabled = true } = {}) {
    return listProjections({ entityType: "authorization.agent-group", includeArchived: includeDisabled })
      .map((projection) => projection.payload)
      .filter((group) => includeDisabled || group.enabled !== false);
  }

  function getAuthorizationAgentGroup(groupId) {
    return projectionPayload("authorization.agent-group", normalizeIdSegment(groupId, "agent-group"));
  }

  function upsertAuthorizationAgentBinding(input = {}, options = {}) {
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

  function listAuthorizationAgentBindings({ includeDisabled = true } = {}) {
    return listProjections({ entityType: "authorization.agent-binding", includeArchived: includeDisabled })
      .map((projection) => projection.payload)
      .filter((binding) => includeDisabled || binding.enabled !== false);
  }

  function getAuthorizationAgentBinding(agentId) {
    return projectionPayload("authorization.agent-binding", normalizeIdSegment(agentId, "agent"));
  }

  function upsertToolProfile(input = {}, options = {}) {
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

  function listToolProfiles({ includeDisabled = false } = {}) {
    return listProjections({ entityType: "operation-permission.profile", includeArchived: includeDisabled })
      .map((projection) => projection.payload)
      .filter((profile) => includeDisabled || profile.enabled !== false);
  }

  function seedToolProfiles(profiles = []) {
    let created = 0;
    for (const profile of Array.isArray(profiles) ? profiles : []) {
      const id = String(profile?.id || profile?.profileId || "").trim();
      if (!id || hasProjection("operation-permission.profile", id)) {
        continue;
      }
      upsertToolProfile(profile, { eventType: "seed" });
      created += 1;
    }
    return { created };
  }

  function rebuildProjections() {
    db.prepare("DELETE FROM tag_management_projections").run();
    let count = 0;
    for (const tag of listTags({ includeArchived: true })) {
      const projectionsByKey = new Map();
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

  function listEvents({ limit = 100, tagId = "", eventType = "" } = {}) {
    const clauses = [];
    const params = [];
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
    `).all(...params).map(eventFromRow);
  }

  function getPolicyRevision() {
    const row = db.prepare(`
      SELECT count(*) AS revision, max(created_at) AS updated_at
      FROM tag_management_events
    `).get();
    return {
      protocolVersion: TAG_MANAGEMENT_PROTOCOL_VERSION,
      revision: Number(row?.revision || 0),
      updatedAt: row?.updated_at || ""
    };
  }

  return Object.freeze({
    protocolVersion: TAG_MANAGEMENT_PROTOCOL_VERSION,
    userDataPath: resolvedUserDataPath,
    rootPath: resolvedRoot,
    db,
    isClosed() {
      return closed || db.open === false;
    },
    close() {
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
    getAuthorizationTeam,
    getPolicyRevision,
    registerChangeHandler(handler) {
      if (typeof handler !== "function") return () => {};
      changeHandlers.add(handler);
      return () => changeHandlers.delete(handler);
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
