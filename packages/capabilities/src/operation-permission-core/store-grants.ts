import crypto from "node:crypto";
import {
  apiCapabilityId,
  evaluateAuthorizationPolicy,
  toolExecuteCapabilityId
} from "@meshrix/foundation/security/authorization/authorization-engine";
import {
  bindingContextFromGrant,
  bindingContextFromRequest,
  bindingContextMismatch,
  credentialBindingMetadata,
  credentialMetadataFromIssue,
  hashToken,
  localMcpTargetBindingDecision,
  normalizeDynamicUpstreamCapabilities,
  normalizeGrantInput,
  randomId,
  readBearerToken,
  rejectUnknownGrantCapabilities,
  resolveGrantCapabilities,
  safeCompare,
  sanitizeGrantMetadata,
  sourceIpFromRequest,
  stampGrantPolicyRevision,
  stringifyJson,
  nowIso
} from "./store-utils.ts";
import { createGrantEventStore } from "./store-grant-events.ts";
import { publicGrant, rowToGrant, summarizeValue } from "./store-models.ts";
import { createGrantProcessIdentityMethods } from "./store-process-identity.ts";
import { createDelegatedGrantSecurity } from "./store-delegated-grant-security.ts";
import { createConsumeGrantUseStatement } from "./store-grant-use.ts";

export function createGrantStoreMethods(ctx?: any) : any {
  const {
    db,
    registry,
    capabilityResolver,
    resolvedCapabilityKeyProvider,
    resolvedCapabilityBindingGuard
  } = ctx;
  const toPublicGrant: any = (grant?: any) : any => publicGrant(grant, {
    catalogFingerprint: ctx.currentCatalogFingerprint()
  });
  const { appendGrantEvent, listGrantEvents } = createGrantEventStore({ db });
  const {
    recordMcpTargetBindingDenial,
    verifyLocalMcpProcessIdentity
  } = createGrantProcessIdentityMethods(ctx, { appendGrantEvent });

  const upsertGrantStmt: any = db.prepare(`
    INSERT INTO tool_grants (
      id, label, type, enabled, toolsets_json, tool_allow_json, tool_deny_json, scopes_json,
      expires_at, max_uses, rate_limit_json, allowed_origins_json, allowed_cidrs_json,
      metadata_json, reason, token_hash, token_prefix, token_family_id, use_count,
      created_at, updated_at, revoked_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      type = excluded.type,
      enabled = excluded.enabled,
      toolsets_json = excluded.toolsets_json,
      tool_allow_json = excluded.tool_allow_json,
      tool_deny_json = excluded.tool_deny_json,
      scopes_json = excluded.scopes_json,
      expires_at = excluded.expires_at,
      max_uses = excluded.max_uses,
      rate_limit_json = excluded.rate_limit_json,
      allowed_origins_json = excluded.allowed_origins_json,
      allowed_cidrs_json = excluded.allowed_cidrs_json,
      metadata_json = excluded.metadata_json,
      reason = excluded.reason,
      token_hash = excluded.token_hash,
      token_prefix = excluded.token_prefix,
      token_family_id = excluded.token_family_id,
      use_count = excluded.use_count,
      updated_at = excluded.updated_at,
      revoked_at = excluded.revoked_at,
      last_used_at = excluded.last_used_at
  `);

  const consumeGrantUseStmt: any = createConsumeGrantUseStatement(db);
  const ownerRowsStmt: any = db.prepare(`
    SELECT owner_kind AS ownerKind, owner_id AS ownerId, owner_generation AS ownerGeneration
    FROM tool_grant_owners
    WHERE grant_id = ?
    ORDER BY owner_kind, owner_id
  `);
  const insertOwnerStmt: any = db.prepare(`
    INSERT INTO tool_grant_owners (grant_id, owner_kind, owner_id, owner_generation, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertOwnerAuthorityStmt: any = db.prepare(`
    INSERT INTO tool_grant_owner_authorities (
      owner_kind, owner_id, owner_generation, state, first_seen_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?)
    ON CONFLICT(owner_kind, owner_id, owner_generation) DO NOTHING
  `);

  function grantOwners(grantId?: any) : any {
    return ownerRowsStmt.all(String(grantId || "")).map((owner?: any) : any => Object.freeze(owner));
  }

  function hydrateGrant(row?: any) : any {
    const grant: any = rowToGrant(row);
    if (!grant) return null;
    const owners: any = grantOwners(grant.id);
    return {
      ...grant,
      owners,
      ownerIntegrity: { valid: owners.length > 0 }
    };
  }

  function hydrateGrants(rows?: any) : any {
    if (rows.length === 0) return [];
    const grantIds: any = new Set<any>(rows.map((row?: any) : any => row.id));
    const ownerRows: any = db.prepare(`
      SELECT grant_id, owner_kind AS ownerKind, owner_id AS ownerId, owner_generation AS ownerGeneration
      FROM tool_grant_owners
      ORDER BY grant_id, owner_kind, owner_id, owner_generation
    `).all().filter((owner?: any) : any => grantIds.has(owner.grant_id));
    const ownersByGrantId: any = new Map<any, any>();
    for (const owner of ownerRows) {
      const list: any = ownersByGrantId.get(owner.grant_id) || [];
      list.push(Object.freeze({
        ownerKind: owner.ownerKind,
        ownerId: owner.ownerId,
        ownerGeneration: owner.ownerGeneration
      }));
      ownersByGrantId.set(owner.grant_id, list);
    }
    return rows.map((row?: any) : any => {
      const grant: any = rowToGrant(row);
      const owners: any = ownersByGrantId.get(grant.id) || [];
      return { ...grant, owners, ownerIntegrity: { valid: owners.length > 0 } };
    });
  }

  function normalizeGrantAgainstCurrentCatalog(input: Record<string, any> = {}, fallback: Record<string, any> = {}) : any {
    const grant: any = normalizeGrantInput(input, fallback);
    if (!grant.toolsets?.length || !registry || typeof registry.resolveToolset !== "function") return grant;
    const resolution: any = registry.resolveToolset({
      toolsets: grant.toolsets,
      toolAllow: grant.toolAllow,
      toolDeny: grant.toolDeny
    });
    const resolvedToolsets: any = new Set<any>(Array.isArray(resolution.toolsets) ? resolution.toolsets : grant.toolsets);
    const missingToolset: any = grant.toolsets.find((toolsetId?: any) : any => !resolvedToolsets.has(toolsetId));
    if (missingToolset) {
      const error: Error & Record<string, any> = new Error("Operation Permission grant references an unknown toolset.");
      error.code = "operation_permission_grant_toolset_unknown";
      throw error;
    }
    return {
      ...grant,
      scopes: [...new Set<any>((Array.isArray(resolution.requiredScopes) ? resolution.requiredScopes : grant.scopes)
        .map(String).filter(Boolean))].sort()
    };
  }

  function rejectCallerGrantOwner(input: Record<string, any> = {}) : any {
    const metadata: any = input?.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : {};
    const forbidden: any[] = ["owner", "ownerKind", "ownerId", "owners", "pluginId", "grantOwner"];
    if (forbidden.some((field?: any) : any => Object.hasOwn(input, field) || Object.hasOwn(metadata, field))) {
      const error: Error & Record<string, any> = new Error("Operation Permission grant owner is resolved by the active catalog authority.");
      error.code = "operation_permission_grant_owner_not_caller_controlled";
      throw error;
    }
  }

  function closedOwner(tool: Record<string, any> = {}) : any {
    const ownerKind: any = String(tool.ownerKind || "").trim();
    const ownerId: any = String(tool.ownerId || "").trim();
    if ((ownerKind !== "core" && ownerKind !== "plugin") || !ownerId) {
      const error: Error & Record<string, any> = new Error("Operation catalog tool owner is missing or unknown.");
      error.code = "operation_permission_unknown_catalog_owner";
      throw error;
    }
    if (ownerKind === "core") return { ownerKind, ownerId, ownerGeneration: "core" };
    const authority: any = db.prepare(`
      SELECT owner_generation AS ownerGeneration
      FROM tool_grant_owner_authorities
      WHERE owner_kind = 'plugin' AND owner_id = ? AND state = 'active'
    `).get(ownerId);
    if (!authority?.ownerGeneration) {
      const error: Error & Record<string, any> = new Error("Plugin grant owner generation is not active.");
      error.code = "operation_permission_plugin_owner_generation_inactive";
      throw error;
    }
    return { ownerKind, ownerId, ownerGeneration: authority.ownerGeneration };
  }

  function resolveGrantOwners(grant?: any) : any {
    const delegatedParentId: any = String(grant?.metadata?.delegatedMcp?.sourceGrantId || "").trim();
    if (String(grant?.type || "") === "delegated-mcp-child") {
      const parent: any = delegatedParentId ? getGrant(delegatedParentId) : null;
      if (!parent?.ownerIntegrity?.valid) {
        const error: Error & Record<string, any> = new Error("Delegated grant parent has no valid catalog owner binding.");
        error.code = "operation_permission_parent_owner_invalid";
        throw error;
      }
      return parent.owners;
    }
    if (registry && typeof registry.resolveToolset === "function" && typeof registry.listTools === "function") {
      const resolved: any = registry.resolveToolset({
        toolsets: grant.toolsets,
        scopes: grant.toolsets?.length ? [] : grant.scopes,
        toolAllow: grant.toolAllow,
        toolDeny: grant.toolDeny
      });
      const selected: any = new Map<any, any>((resolved.tools || []).map((tool?: any) : any => [tool.id, tool]));
      const capabilities: any = resolveGrantCapabilities(grant, { registry, capabilityResolver });
      const allTools: any = registry.listTools();
      if (capabilities.includes("cap:tool:*")) {
        for (const tool of allTools) selected.set(tool.id, tool);
      } else {
        const allowedCapabilityIds: any = new Set<any>(capabilities);
        for (const tool of allTools) {
          if (allowedCapabilityIds.has(toolExecuteCapabilityId(tool.id))) selected.set(tool.id, tool);
        }
      }
      const owners: any = new Map<any, any>();
      for (const tool of selected.values()) {
        const owner: any = closedOwner(tool);
        owners.set(`${owner.ownerKind}:${owner.ownerId}:${owner.ownerGeneration}`, owner);
      }
      if (owners.size === 0) owners.set("core:core-platform:core", {
        ownerKind: "core",
        ownerId: "core-platform",
        ownerGeneration: "core"
      });
      return [...owners.values()];
    }
    if (typeof capabilityResolver === "function") {
      return [{ ownerKind: "core", ownerId: "core-platform", ownerGeneration: "core" }];
    }
    const error: Error & Record<string, any> = new Error("Operation Permission grant owner authority is unavailable.");
    error.code = "operation_permission_grant_owner_authority_unavailable";
    throw error;
  }

  function replaceGrantOwners(grantId?: any, owners?: any, createdAt?: any) : any {
    db.prepare("DELETE FROM tool_grant_owners WHERE grant_id = ?").run(grantId);
    for (const owner of owners) {
      const authority: any = db.prepare(`
        SELECT state FROM tool_grant_owner_authorities
        WHERE owner_kind = ? AND owner_id = ? AND owner_generation = ?
      `).get(owner.ownerKind, owner.ownerId, owner.ownerGeneration);
      if (authority?.state !== "active") {
        const error: Error & Record<string, any> = new Error("Grant owner generation changed before persistence.");
        error.code = "operation_permission_plugin_owner_generation_changed";
        throw error;
      }
      insertOwnerStmt.run(grantId, owner.ownerKind, owner.ownerId, owner.ownerGeneration, createdAt);
    }
  }

  function assertGrantOwnersActive(owners: any = []) : any {
    if (!Array.isArray(owners) || owners.length === 0) {
      const error: Error & Record<string, any> = new Error("Grant owner binding is missing.");
      error.code = "operation_permission_grant_owner_missing";
      throw error;
    }
    for (const owner of owners) {
      const authority: any = db.prepare(`
        SELECT state FROM tool_grant_owner_authorities
        WHERE owner_kind = ? AND owner_id = ? AND owner_generation = ?
      `).get(owner.ownerKind, owner.ownerId, owner.ownerGeneration);
      if (authority?.state !== "active") {
        const error: Error & Record<string, any> = new Error("Grant owner generation is no longer active.");
        error.code = "operation_permission_plugin_owner_generation_inactive";
        throw error;
      }
    }
  }

  function grantOwnersAreActive(grantId?: any) : any {
    const ownerCount: any = db.prepare(`
      SELECT count(*) AS count FROM tool_grant_owners WHERE grant_id = ?
    `).get(grantId)?.count || 0;
    if (ownerCount === 0) return false;
    const inactive: any = db.prepare(`
      SELECT 1 AS present
      FROM tool_grant_owners AS owner
      LEFT JOIN tool_grant_owner_authorities AS authority
        ON authority.owner_kind = owner.owner_kind
       AND authority.owner_id = owner.owner_id
       AND authority.owner_generation = owner.owner_generation
      WHERE owner.grant_id = ?
        AND (authority.state IS NULL OR authority.state <> 'active')
      LIMIT 1
    `).get(grantId);
    return !inactive;
  }

  const seenAt: any = nowIso();
  insertOwnerAuthorityStmt.run("core", "core-platform", "core", seenAt, seenAt);

  function upsertGrant(grant?: any) : any {
    upsertGrantStmt.run(
      grant.id,
      grant.label,
      grant.type,
      grant.enabled ? 1 : 0,
      stringifyJson(grant.toolsets),
      stringifyJson(grant.toolAllow),
      stringifyJson(grant.toolDeny),
      stringifyJson(grant.scopes),
      grant.expiresAt,
      grant.maxUses,
      stringifyJson(grant.rateLimit),
      stringifyJson(grant.allowedOrigins),
      stringifyJson(grant.allowedCidrs),
      stringifyJson(sanitizeGrantMetadata(grant.metadata)),
      grant.reason,
      grant.tokenHash,
      grant.tokenPrefix,
      grant.tokenFamilyId,
      grant.useCount,
      grant.createdAt,
      grant.updatedAt,
      grant.revokedAt,
      grant.lastUsedAt
    );
    return grant;
  }

  function getGrant(grantId?: any) : any {
    return hydrateGrant(db.prepare("SELECT * FROM tool_grants WHERE id = ?").get(String(grantId || "")));
  }

  function listGrants({ includeRevoked = false }: Record<string, any> = {}) : any {
    const rows: any = includeRevoked
      ? db.prepare("SELECT * FROM tool_grants ORDER BY created_at DESC").all()
      : db.prepare("SELECT * FROM tool_grants WHERE revoked_at = '' ORDER BY created_at DESC").all();
    return hydrateGrants(rows).map(toPublicGrant);
  }

  const {
    activeDelegatedParent,
    invalidateGrantCredential,
    policyIntegrityDenial,
    revokeDelegatedDescendants
  } = createDelegatedGrantSecurity({
    db,
    rowToGrant,
    getGrant,
    upsertGrant,
    toPublicGrant,
    appendGrantEvent,
    capabilityKeyProvider: resolvedCapabilityKeyProvider,
    capabilityBindingGuard: resolvedCapabilityBindingGuard,
    notifyChange: ctx.notifyChange,
    nowIso
  });

  async function createGrant(input: Record<string, any> = {}) : Promise<any> {
    rejectCallerGrantOwner(input);
    rejectUnknownGrantCapabilities(input);
    const policyRevision: any = ctx.currentGovernancePolicyRevision();
    const baseGrant: any = normalizeGrantAgainstCurrentCatalog({
      ...input,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });
    const capabilities: any = resolveGrantCapabilities(baseGrant, { registry, capabilityResolver });
    if (capabilities.length === 0) {
      throw new Error("Operation Permission grants require at least one kernel capability.");
    }
    if (getGrant(baseGrant.id)) {
      const error: Error & Record<string, any> = new Error("Operation Permission grant identifier is already terminally reserved.");
      error.code = "operation_permission_grant_id_reserved";
      throw error;
    }
    const owners: any = resolveGrantOwners(baseGrant);
    let token: any = "";
    let credentialMetadata: Record<string, any> = {};
    if (resolvedCapabilityKeyProvider) {
      const issued: any = await resolvedCapabilityKeyProvider.issue({
        credentialId: baseGrant.id,
        capabilities,
        trustedCapabilityPermissions: capabilities,
        expiresAt: baseGrant.expiresAt || "9999-12-31T23:59:59.999Z",
        replaceCredential: true,
        replacementReason: "grant_reissued",
        metadata: {
          grantId: baseGrant.id,
          grantType: baseGrant.type
        }
      });
      token = issued.capabilityKey;
      credentialMetadata = credentialMetadataFromIssue(issued);
      if (typeof resolvedCapabilityBindingGuard?.bindCapabilityKey === "function") {
        const binding: any = await resolvedCapabilityBindingGuard.bindCapabilityKey({
          capabilityKey: token,
          credentialId: baseGrant.id,
          context: bindingContextFromGrant(baseGrant),
          expiresAt: issued.expiresAt || baseGrant.expiresAt || "9999-12-31T23:59:59.999Z",
          replaceCredential: true,
          replacementReason: "grant_reissued"
        });
        credentialMetadata = {
          ...credentialMetadata,
          ...credentialBindingMetadata(binding)
        };
      }
    } else {
      throw new Error("Capability Kernel provider is required to issue Operation Permission grants.");
    }
    const grant: any = normalizeGrantAgainstCurrentCatalog({
      ...baseGrant,
      metadata: {
        ...stampGrantPolicyRevision(sanitizeGrantMetadata(baseGrant.metadata), policyRevision),
        ...credentialMetadata
      },
      tokenHash: hashToken(token),
      tokenPrefix: `${token.slice(0, 10)}...`
    });
    try {
      db.transaction(() : any => {
        upsertGrant(grant);
        replaceGrantOwners(grant.id, owners, grant.createdAt);
      })();
    } catch (error: any) {
      await resolvedCapabilityKeyProvider?.invalidateCredential?.({
        credentialId: grant.id,
        reason: "grant_persistence_failed"
      }).catch(() : any => {});
      throw error;
    }
    const persistedGrant: any = getGrant(grant.id);
    const publicCreatedGrant: any = toPublicGrant(persistedGrant);
    appendGrantEvent(grant.id, "created", {
      scopes: grant.scopes,
      credentialProtocol: grant.metadata.credentialProtocol || "",
      capabilitySetHash: grant.metadata.capabilitySetHash || "",
      capabilityCount: grant.metadata.capabilityCount || 0,
      policyRevision: grant.metadata.policyRevision || 0,
      toolsets: grant.toolsets,
      catalogFingerprint: publicCreatedGrant.projection?.catalogFingerprint || "",
      projectionFingerprint: publicCreatedGrant.projectionFingerprint || ""
    });
    await ctx.notifyChange({
      type: "grant_created",
      grantId: grant.id,
      reasonCode: "grant_created"
    });
    return {
      grant: publicCreatedGrant,
      token
    };
  }

  async function updateGrant(grantId?: any, patch: Record<string, any> = {}) : Promise<any> {
    const existing: any = getGrant(grantId);
    if (!existing) {
      return null;
    }
    rejectCallerGrantOwner(patch);
    if (existing.revokedAt || existing.enabled === false) {
      const error: Error & Record<string, any> = new Error("Terminal Operation Permission grants cannot be updated.");
      error.code = "operation_permission_grant_terminal";
      throw error;
    }
    rejectUnknownGrantCapabilities(patch);
    const updated: any = normalizeGrantAgainstCurrentCatalog(
      {
        ...patch,
        id: existing.id,
        tokenHash: existing.tokenHash,
        tokenPrefix: existing.tokenPrefix,
        tokenFamilyId: existing.tokenFamilyId,
        createdAt: existing.createdAt,
        updatedAt: nowIso(),
        useCount: existing.useCount,
        lastUsedAt: existing.lastUsedAt,
        revokedAt: existing.revokedAt
      },
      existing
    );
    const owners: any = resolveGrantOwners(updated);
    db.transaction(() : any => {
      assertGrantOwnersActive(existing.owners);
      upsertGrant(updated);
      replaceGrantOwners(updated.id, owners, existing.createdAt);
    })();
    await revokeDelegatedDescendants(updated.id, "delegated_parent_grant_updated");
    const publicUpdatedGrant: any = toPublicGrant(getGrant(updated.id));
    appendGrantEvent(updated.id, "updated", {
      patch: summarizeValue(patch),
      catalogFingerprint: publicUpdatedGrant.projection?.catalogFingerprint || "",
      projectionFingerprint: publicUpdatedGrant.projectionFingerprint || ""
    });
    await ctx.notifyChange({
      type: "grant_updated",
      grantId: updated.id,
      reasonCode: "grant_updated"
    });
    return publicUpdatedGrant;
  }

  async function deleteGrant(grantId?: any) : Promise<any> {
    const existing: any = getGrant(grantId);
    if (!existing) {
      return false;
    }
    await revokeGrant(existing.id, "grant_deleted");
    appendGrantEvent(existing.id, "deleted", { terminal: true });
    await ctx.notifyChange({
      type: "grant_deleted",
      grantId: existing.id,
      reasonCode: "grant_deleted"
    });
    return true;
  }

  async function revokeGrant(grantId?: any, reason: any = "") : Promise<any> {
    const existing: any = getGrant(grantId);
    if (!existing) {
      return null;
    }
    if (existing.revokedAt || existing.enabled === false) return toPublicGrant(existing);
    const updated: Record<string, any> = {
      ...existing,
      enabled: false,
      revokedAt: nowIso(),
      updatedAt: nowIso(),
      reason: reason || existing.reason
    };
    upsertGrant(updated);
    await revokeDelegatedDescendants(updated.id, reason || "delegated_parent_grant_revoked");
    await invalidateGrantCredential(updated, reason || "grant_revoked");
    appendGrantEvent(updated.id, "revoked", { reason: updated.reason });
    await ctx.notifyChange({
      type: "grant_revoked",
      grantId: updated.id,
      reasonCode: "grant_revoked",
      reason: updated.reason || "grant_revoked"
    });
    return toPublicGrant(getGrant(updated.id));
  }

  async function rotateGrantToken(grantId?: any) : Promise<any> {
    const existing: any = getGrant(grantId);
    if (!existing) {
      return null;
    }
    if (existing.revokedAt || existing.enabled === false) {
      const error: Error & Record<string, any> = new Error("Terminal Operation Permission grants cannot be rotated.");
      error.code = "operation_permission_grant_terminal";
      throw error;
    }
    assertGrantOwnersActive(existing.owners);
    const policyRevision: any = ctx.currentGovernancePolicyRevision();
    const capabilities: any = resolveGrantCapabilities(existing, { registry, capabilityResolver });
    await revokeDelegatedDescendants(existing.id, "delegated_parent_grant_rotated");
    await invalidateGrantCredential(existing, "grant_token_rotated");
    let token: any = "";
    let credentialMetadata: Record<string, any> = {};
    if (resolvedCapabilityKeyProvider) {
      const issued: any = await resolvedCapabilityKeyProvider.issue({
        credentialId: existing.id,
        capabilities,
        trustedCapabilityPermissions: capabilities,
        expiresAt: existing.expiresAt || "9999-12-31T23:59:59.999Z",
        replaceCredential: true,
        replacementReason: "grant_token_rotated",
        metadata: {
          grantId: existing.id,
          grantType: existing.type
        }
      });
      token = issued.capabilityKey;
      credentialMetadata = credentialMetadataFromIssue(issued);
      if (typeof resolvedCapabilityBindingGuard?.bindCapabilityKey === "function") {
        const binding: any = await resolvedCapabilityBindingGuard.bindCapabilityKey({
          capabilityKey: token,
          credentialId: existing.id,
          context: bindingContextFromGrant(existing),
          expiresAt: issued.expiresAt || existing.expiresAt || "9999-12-31T23:59:59.999Z",
          replaceCredential: true,
          replacementReason: "grant_token_rotated"
        });
        credentialMetadata = {
          ...credentialMetadata,
          ...credentialBindingMetadata(binding)
        };
      }
    } else {
      throw new Error("Capability Kernel provider is required to rotate Operation Permission grants.");
    }
    const updated: Record<string, any> = {
      ...existing,
      enabled: true,
      metadata: {
        ...stampGrantPolicyRevision(sanitizeGrantMetadata(existing.metadata), policyRevision),
        ...credentialMetadata
      },
      tokenHash: hashToken(token),
      tokenPrefix: `${token.slice(0, 10)}...`,
      tokenFamilyId: randomId("token_family"),
      updatedAt: nowIso(),
      revokedAt: ""
    };
    try {
      db.transaction(() : any => {
        assertGrantOwnersActive(existing.owners);
        upsertGrant(updated);
      })();
    } catch (error: any) {
      await resolvedCapabilityKeyProvider?.invalidateCredential?.({
        credentialId: updated.id,
        reason: "grant_rotation_owner_changed"
      }).catch(() : any => {});
      throw error;
    }
    appendGrantEvent(updated.id, "rotated", { tokenPrefix: updated.tokenPrefix });
    await ctx.notifyChange({
      type: "grant_token_rotated",
      grantId: updated.id,
      reasonCode: "grant_token_rotated"
    });
    return {
      grant: toPublicGrant(getGrant(updated.id)),
      token
    };
  }

  function revocationDigest(value?: any) : any {
    return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  function normalizePluginOwnerGeneration(value?: any) : any {
    const generation: any = String(value || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(generation)) {
      const error: Error & Record<string, any> = new Error("Plugin grant owner generation must be an artifact digest.");
      error.code = "operation_permission_plugin_owner_generation_invalid";
      throw error;
    }
    return generation;
  }

  function registerPluginGrantOwner({ pluginId, generationDigest }: Record<string, any> = {}) : any {
    const ownerId: any = String(pluginId || "").trim();
    const generation: any = normalizePluginOwnerGeneration(generationDigest);
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId)) {
      const error: Error & Record<string, any> = new Error("Plugin grant owner identifier is invalid.");
      error.code = "operation_permission_plugin_owner_invalid";
      throw error;
    }
    const timestamp: any = nowIso();
    db.transaction(() : any => {
      const exact: any = db.prepare(`
        SELECT state FROM tool_grant_owner_authorities
        WHERE owner_kind = 'plugin' AND owner_id = ? AND owner_generation = ?
      `).get(ownerId, generation);
      if (exact?.state === "retiring" || exact?.state === "retired") {
        const error: Error & Record<string, any> = new Error("Plugin grant owner generation is not eligible for activation.");
        error.code = exact.state === "retiring"
          ? "operation_permission_plugin_owner_generation_retiring"
          : "operation_permission_plugin_owner_generation_retired";
        throw error;
      }
      const current: any = db.prepare(`
        SELECT owner_generation, state FROM tool_grant_owner_authorities
        WHERE owner_kind = 'plugin' AND owner_id = ? AND state IN ('active', 'retiring')
      `).get(ownerId);
      if (current && current.owner_generation !== generation) {
        const error: Error & Record<string, any> = new Error("A different plugin grant owner generation is still current.");
        error.code = "operation_permission_plugin_owner_generation_conflict";
        throw error;
      }
      if (current?.state === "retiring") {
        const error: Error & Record<string, any> = new Error("Plugin grant owner generation is still retiring.");
        error.code = "operation_permission_plugin_owner_generation_retiring";
        throw error;
      }
      if (!exact) insertOwnerAuthorityStmt.run("plugin", ownerId, generation, timestamp, timestamp);
      const registered: any = db.prepare(`
        SELECT state FROM tool_grant_owner_authorities
        WHERE owner_kind = 'plugin' AND owner_id = ? AND owner_generation = ?
      `).get(ownerId, generation);
      if (registered?.state !== "active") {
        throw new Error("Plugin grant owner generation registration did not become active.");
      }
    })();
    return Object.freeze({
      ok: true,
      state: "active",
      ownerGenerationDigest: generation,
      receiptDigest: revocationDigest({
        protocol: "operation-permission-plugin-owner-registration",
        pluginOwnerDigest: revocationDigest(ownerId),
        generation
      })
    });
  }

  function ownerRevocationReceipt(job?: any) : any {
    return Object.freeze({
      ok: true,
      complete: job.status === "complete",
      status: job.status,
      processedCount: Math.max(0, Number(job.processed_count || 0)),
      revokedCount: Math.max(0, Number(job.revoked_count || 0)),
      alreadyRevokedCount: Math.max(0, Number(job.already_revoked_count || 0)),
      cursor: job.status === "complete" ? "" : String(job.cursor_token || ""),
      receiptDigest: String(job.receipt_digest || "")
    });
  }

  function assertPluginOwnerAuthority(pluginId?: any, ownerGeneration?: any) : any {
    const persistedOwner: any = db.prepare(`
      SELECT 1 AS present FROM tool_grant_owner_authorities
      WHERE owner_kind = 'plugin' AND owner_id = ? AND owner_generation = ? LIMIT 1
    `).get(pluginId, ownerGeneration);
    const persistedJob: any = db.prepare(`
      SELECT 1 AS present FROM tool_grant_owner_revocations
      WHERE plugin_id = ? AND owner_generation = ? LIMIT 1
    `).get(pluginId, ownerGeneration);
    if (!persistedOwner && !persistedJob) {
      const error: Error & Record<string, any> = new Error("Plugin grant owner is unknown to Operation Permission.");
      error.code = "operation_permission_unknown_plugin_owner";
      throw error;
    }
  }

  async function invalidateOwnerRevocationTargets(idempotencyKey?: any, batchSize?: any) : Promise<any> {
    const targets: any = db.prepare(`
      SELECT target.grant_id, target.capability_invalidated, target.binding_invalidated
      FROM tool_grant_owner_revocation_targets AS target
      WHERE target.idempotency_key = ? AND target.accounted = 0
      ORDER BY target.grant_id
      LIMIT ?
    `).all(idempotencyKey, batchSize);
    for (const target of targets) {
      try {
        if (!target.capability_invalidated && typeof resolvedCapabilityKeyProvider?.invalidateCredential === "function") {
          await resolvedCapabilityKeyProvider.invalidateCredential({
            credentialId: target.grant_id,
            reason: "plugin_owner_retired"
          });
          db.prepare(`
            UPDATE tool_grant_owner_revocation_targets
            SET capability_invalidated = 1, updated_at = ?
            WHERE idempotency_key = ? AND grant_id = ?
          `).run(nowIso(), idempotencyKey, target.grant_id);
        }
        if (!target.binding_invalidated && typeof resolvedCapabilityBindingGuard?.invalidateCapabilityKeyBinding === "function") {
          await resolvedCapabilityBindingGuard.invalidateCapabilityKeyBinding({
            credentialId: target.grant_id,
            reason: "plugin_owner_retired"
          });
          db.prepare(`
            UPDATE tool_grant_owner_revocation_targets
            SET binding_invalidated = 1, updated_at = ?
            WHERE idempotency_key = ? AND grant_id = ?
          `).run(nowIso(), idempotencyKey, target.grant_id);
        }
        if (typeof resolvedCapabilityKeyProvider?.invalidateCredential !== "function") {
          db.prepare(`UPDATE tool_grant_owner_revocation_targets SET capability_invalidated = 1, updated_at = ? WHERE idempotency_key = ? AND grant_id = ?`)
            .run(nowIso(), idempotencyKey, target.grant_id);
        }
        if (typeof resolvedCapabilityBindingGuard?.invalidateCapabilityKeyBinding !== "function") {
          db.prepare(`UPDATE tool_grant_owner_revocation_targets SET binding_invalidated = 1, updated_at = ? WHERE idempotency_key = ? AND grant_id = ?`)
            .run(nowIso(), idempotencyKey, target.grant_id);
        }
      } catch {
        const error: Error & Record<string, any> = new Error("Plugin-owner grant credential revocation is pending recovery.");
        error.code = "operation_permission_plugin_owner_revocation_pending";
        throw error;
      }
    }
  }

  function finalizeOwnerRevocationTargets(idempotencyKey?: any) : any {
    return db.transaction(() : any => {
      const pending: any = db.prepare(`
        SELECT grant_id, newly_revoked, capability_invalidated, binding_invalidated
        FROM tool_grant_owner_revocation_targets
        WHERE idempotency_key = ? AND accounted = 0
        ORDER BY grant_id
      `).all(idempotencyKey);
      if (pending.some((target?: any) : any => !target.capability_invalidated || !target.binding_invalidated)) return false;
      if (pending.length === 0) return true;
      const newlyRevoked: any = pending.reduce((count?: any, target?: any) : any => count + (target.newly_revoked ? 1 : 0), 0);
      const lastGrantId: any = pending.at(-1).grant_id;
      const job: any = db.prepare(`
        SELECT plugin_id, owner_generation FROM tool_grant_owner_revocations WHERE idempotency_key = ?
      `).get(idempotencyKey);
      if (!job) throw new Error("Plugin-owner grant revocation job is missing.");
      const committedCursor: any = revocationDigest({
        key: idempotencyKey,
        ownerId: job.plugin_id,
        ownerGeneration: job.owner_generation,
        lastGrantId
      });
      const timestamp: any = nowIso();
      db.prepare(`
        UPDATE tool_grant_owner_revocations
        SET owner_cursor_grant_id = ?, processed_count = processed_count + ?,
            revoked_count = revoked_count + ?, already_revoked_count = already_revoked_count + ?,
            cursor_token = ?, updated_at = ?
        WHERE idempotency_key = ?
      `).run(
        lastGrantId,
        pending.length,
        newlyRevoked,
        pending.length - newlyRevoked,
        committedCursor,
        timestamp,
        idempotencyKey
      );
      db.prepare(`
        UPDATE tool_grant_owner_revocation_targets
        SET accounted = 1, updated_at = ?
        WHERE idempotency_key = ? AND accounted = 0
      `).run(timestamp, idempotencyKey);
      return true;
    })();
  }

  async function revokeGrantsByPluginOwner({
    pluginId,
    generationDigest,
    idempotencyKey,
    cursor = "",
    batchSize = 64
  }: Record<string, any> = {}) : Promise<any> {
    const ownerId: any = String(pluginId || "").trim();
    const ownerGeneration: any = normalizePluginOwnerGeneration(generationDigest);
    const key: any = String(idempotencyKey || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(ownerId) || !key || key.length > 256) {
      const error: Error & Record<string, any> = new Error("Plugin-owner grant revocation requires a closed owner and idempotency key.");
      error.code = "operation_permission_plugin_owner_revocation_invalid";
      throw error;
    }
    const limit: any = Math.max(1, Math.min(256, Math.trunc(Number(batchSize) || 64)));
    assertPluginOwnerAuthority(ownerId, ownerGeneration);
    const timestamp: any = nowIso();
    db.transaction(() : any => {
      const existingJob: any = db.prepare("SELECT plugin_id, owner_generation FROM tool_grant_owner_revocations WHERE idempotency_key = ?")
        .get(key);
      if (existingJob) return;
      const authority: any = db.prepare(`
        SELECT state FROM tool_grant_owner_authorities
        WHERE owner_kind = 'plugin' AND owner_id = ? AND owner_generation = ?
      `).get(ownerId, ownerGeneration);
      if (authority?.state === "retired") {
        const digest: any = revocationDigest({
          protocol: "operation-permission-plugin-owner-revocation",
          pluginOwnerDigest: revocationDigest(ownerId),
          ownerGeneration,
          idempotencyDigest: revocationDigest(key),
          processedCount: 0,
          revokedCount: 0,
          alreadyRevokedCount: 0,
          alreadyRetired: true
        });
        db.prepare(`
          INSERT INTO tool_grant_owner_revocations (
            idempotency_key, plugin_id, owner_generation, status, receipt_digest,
            created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, 'complete', ?, ?, ?, ?)
        `).run(key, ownerId, ownerGeneration, digest, timestamp, timestamp, timestamp);
        return;
      }
      if (authority?.state === "retiring") {
        const error: Error & Record<string, any> = new Error("Plugin grant owner generation is retiring under another request.");
        error.code = "operation_permission_plugin_owner_generation_retiring";
        throw error;
      }
      const retired: any = db.prepare(`
        UPDATE tool_grant_owner_authorities
        SET state = 'retiring', updated_at = ?
        WHERE owner_kind = 'plugin' AND owner_id = ? AND owner_generation = ? AND state = 'active'
      `).run(timestamp, ownerId, ownerGeneration);
      if (retired.changes !== 1) {
        const error: Error & Record<string, any> = new Error("Plugin grant owner generation is not active for retirement.");
        error.code = "operation_permission_plugin_owner_generation_inactive";
        throw error;
      }
      db.prepare(`
        INSERT INTO tool_grant_owner_revocations (
          idempotency_key, plugin_id, owner_generation, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?)
      `).run(key, ownerId, ownerGeneration, timestamp, timestamp);
    })();
    let job: any = db.prepare("SELECT * FROM tool_grant_owner_revocations WHERE idempotency_key = ?").get(key);
    if (!job || job.plugin_id !== ownerId || job.owner_generation !== ownerGeneration) {
      const error: Error & Record<string, any> = new Error("Plugin-owner grant revocation idempotency key conflicts with another owner.");
      error.code = "operation_permission_plugin_owner_revocation_conflict";
      throw error;
    }
    if (cursor && cursor !== job.cursor_token) {
      const error: Error & Record<string, any> = new Error("Plugin-owner grant revocation cursor is stale or invalid.");
      error.code = "operation_permission_plugin_owner_revocation_cursor_invalid";
      throw error;
    }
    if (job.status === "complete") return ownerRevocationReceipt(job);
    if (!cursor && job.cursor_token) return ownerRevocationReceipt(job);

    await invalidateOwnerRevocationTargets(key, limit);
    finalizeOwnerRevocationTargets(key);
    job = db.prepare("SELECT * FROM tool_grant_owner_revocations WHERE idempotency_key = ?").get(key);
    const ownerRows: any = db.prepare(`
      SELECT grant_id
      FROM tool_grant_owners
      WHERE owner_kind = 'plugin' AND owner_id = ? AND owner_generation = ? AND grant_id > ?
      ORDER BY grant_id
      LIMIT ?
    `).all(ownerId, ownerGeneration, job.owner_cursor_grant_id, limit);

    if (ownerRows.length === 0) {
      const completeAt: any = nowIso();
      const digest: any = revocationDigest({
        protocol: "operation-permission-plugin-owner-revocation",
        pluginOwnerDigest: revocationDigest(ownerId),
        ownerGeneration,
        idempotencyDigest: revocationDigest(key),
        processedCount: job.processed_count,
        revokedCount: job.revoked_count,
        alreadyRevokedCount: job.already_revoked_count
      });
      db.transaction(() : any => {
        db.prepare(`
          UPDATE tool_grant_owner_revocations
          SET status = 'complete', cursor_token = '', receipt_digest = ?, updated_at = ?, completed_at = ?
          WHERE idempotency_key = ?
        `).run(digest, completeAt, completeAt, key);
        const retired: any = db.prepare(`
          UPDATE tool_grant_owner_authorities
          SET state = 'retired', updated_at = ?, retired_at = ?
          WHERE owner_kind = 'plugin' AND owner_id = ? AND owner_generation = ? AND state = 'retiring'
        `).run(completeAt, completeAt, ownerId, ownerGeneration);
        if (retired.changes !== 1) throw new Error("Plugin grant owner retirement state changed unexpectedly.");
      })();
      await ctx.notifyChange({
        type: "plugin_owner_grants_revoked",
        reasonCode: "plugin_owner_retired",
        receiptDigest: digest,
        revokedCount: job.revoked_count
      });
      return ownerRevocationReceipt(
        db.prepare("SELECT * FROM tool_grant_owner_revocations WHERE idempotency_key = ?").get(key)
      );
    }

    db.transaction(() : any => {
      const stageAt: any = nowIso();
      for (const { grant_id: grantId } of ownerRows) {
        const grant: any = getGrant(grantId);
        if (!grant) throw new Error("Plugin-owner grant index references a missing grant.");
        const newlyRevoked: any = !grant.revokedAt && grant.enabled !== false;
        if (newlyRevoked) {
          upsertGrant({
            ...grant,
            enabled: false,
            revokedAt: stageAt,
            updatedAt: stageAt,
            reason: "plugin_owner_retired"
          });
          appendGrantEvent(grant.id, "revoked", {
            reasonCode: "plugin_owner_retired",
            ownerKind: "plugin",
            ownerIdDigest: revocationDigest(ownerId)
          });
        }
        db.prepare(`
          INSERT INTO tool_grant_owner_revocation_targets (
            idempotency_key, grant_id, newly_revoked, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(idempotency_key, grant_id) DO NOTHING
        `).run(key, grant.id, newlyRevoked ? 1 : 0, stageAt, stageAt);
      }
    })();

    await invalidateOwnerRevocationTargets(key, limit);
    finalizeOwnerRevocationTargets(key);
    job = db.prepare("SELECT * FROM tool_grant_owner_revocations WHERE idempotency_key = ?").get(key);
    return ownerRevocationReceipt(job);
  }

  function finishGrantAuthorization({
    grant,
    parentGrant = null,
    request,
    sourceIp = "",
    requiredScopes = [],
    tool = null,
    context = {},
    recordUse = true
  }: Record<string, any>) : any {
    const integrityDenial: any = policyIntegrityDenial(grant);
    if (integrityDenial) return integrityDenial;
    const resolvedSourceIp: any = sourceIp || sourceIpFromRequest(request);
    const perMinute: any = Math.max(0, Number(grant.rateLimit?.perMinute || 0));
    let grantRateLimited: any = false;
    if (perMinute > 0) {
      const since: any = new Date(Date.now() - 60_000).toISOString();
      const count: any = db.prepare(`
        SELECT count(*) AS count FROM tool_metric_events
        WHERE grant_id = ? AND created_at >= ?
      `).get(grant.id, since).count;
      grantRateLimited = count >= perMinute;
    }
    const operation: Record<string, any> = {
        id: String(tool?.operationId || "tool.grant.authorize"),
        requiredScopes: Array.isArray(requiredScopes) ? requiredScopes : [],
        safety: { risk: "read_only" },
        readOnly: true
      };
    const policyInput: Record<string, any> = {
      operation,
      tool,
      grant: toPublicGrant(grant),
      request,
      context: {
        ...context,
        toolExpected: Boolean(tool),
        grantRateLimited,
        sourceIp: resolvedSourceIp
      },
      grantRequired: true,
      enforceConfirmation: false
    };
    const authorizationDecision: any = evaluateAuthorizationPolicy(policyInput);
    const grantBoundaryAllowsRuntimeGate: any = authorizationDecision.allowed ||
      authorizationDecision.effect === "require_approval" ||
      authorizationDecision.effect === "require_confirmation";
    if (!grantBoundaryAllowsRuntimeGate) {
      const errorByReason: Record<string, any> = {
        grant_expired: "工具授权已过期。",
        grant_max_uses: "工具授权已超过最大使用次数。",
        origin_not_allowed: "当前请求来源暂未匹配到该工具的可用授权，请核实授权配置以启用该能力。",
        cidr_not_allowed: "当前网络来源暂未开通访问权限，如需调用请调整授权清单。",
        rate_limited: "工具授权已超过限流阈值。"
      };
      return {
        ok: false,
        status: authorizationDecision.reasonCode === "rate_limited" ? 429 : 403,
        error: errorByReason[authorizationDecision.reasonCode] || "工具授权策略拒绝了该请求。",
        reasonCode: authorizationDecision.reasonCode,
        missingCapabilities: authorizationDecision.missingCapabilities || [],
        missingScopes: authorizationDecision.missingScopes || [],
        grant: toPublicGrant(grant),
        authorizationDecision
      };
    }
    if (parentGrant) {
      const parentAuthorizationDecision: any = evaluateAuthorizationPolicy({
        ...policyInput,
        grant: toPublicGrant(parentGrant),
        context: {
          ...policyInput.context,
          grantRateLimited: false
        }
      });
      const parentBoundaryAllowsRuntimeGate: any = parentAuthorizationDecision.allowed ||
        parentAuthorizationDecision.effect === "require_approval" ||
        parentAuthorizationDecision.effect === "require_confirmation";
      if (!parentBoundaryAllowsRuntimeGate) {
        return {
          ok: false,
          status: 403,
          error: "Delegated MCP parent grant denied the requested operation.",
          reasonCode: `delegated_parent_${parentAuthorizationDecision.reasonCode || "denied"}`,
          missingCapabilities: parentAuthorizationDecision.missingCapabilities || [],
          missingScopes: parentAuthorizationDecision.missingScopes || [],
          grant: toPublicGrant(grant),
          authorizationDecision: parentAuthorizationDecision
        };
      }
    }
    if (recordUse === false) {
      if (!grantOwnersAreActive(grant.id) || (parentGrant && !grantOwnersAreActive(parentGrant.id))) {
        return {
          ok: false,
          status: 403,
          error: "Grant owner generation changed during authorization.",
          reasonCode: "grant_owner_generation_inactive",
          missingCapabilities: [],
          missingScopes: [],
          grant: toPublicGrant(grant),
          authorizationDecision: { ok: false, reasonCode: "grant_owner_generation_inactive" }
        };
      }
      return {
        ok: true,
        grant: toPublicGrant(grant),
        sourceIp: resolvedSourceIp,
        authorizationDecision
      };
    }
    const usedAt: any = nowIso();
    const parentGrantId: any = parentGrant?.id || "";
    const consumed: any = consumeGrantUseStmt.run(
      usedAt,
      grant.id,
      grant.tokenHash,
      grant.updatedAt,
      usedAt,
      parentGrantId,
      parentGrantId,
      parentGrant?.updatedAt || "",
      usedAt
    );
    if (consumed.changes !== 1) {
      const current: any = getGrant(grant.id);
      const reasonCode: any = current && Number(current.maxUses || 0) > 0 && Number(current.useCount || 0) >= Number(current.maxUses || 0)
        ? "grant_max_uses"
        : parentGrantId
          ? "delegated_parent_grant_changed"
          : "grant_changed_during_authorization";
      return {
        ok: false,
        status: 403,
        error: reasonCode === "grant_max_uses"
          ? "工具授权已超过最大使用次数。"
          : "Grant policy changed during authorization.",
        reasonCode,
        missingCapabilities: [],
        missingScopes: [],
        grant: toPublicGrant(current || grant),
        authorizationDecision: { ok: false, reasonCode }
      };
    }
    const updated: any = getGrant(grant.id);
    return {
      ok: true,
      grant: toPublicGrant(updated),
      sourceIp: resolvedSourceIp
    };
  }

  async function authorizeOpaqueToolCapability({
    token,
    grant,
    parentGrant = null,
    request,
    context = {},
    tool,
    requiredScopes = [],
    recordUse = true
  }: Record<string, any>) : Promise<any> {
    const requiredCapability: any = toolExecuteCapabilityId(tool.id);
    const credentialDecision: any = await resolvedCapabilityKeyProvider.verify({
      capabilityKey: token,
      requiredCapability
    });
    if (!credentialDecision.ok) {
      const reasonCode: any = credentialDecision.reasonCode === "missing_capabilities"
        ? "missing_capabilities"
        : "invalid_token";
      return {
        ok: false,
        status: reasonCode === "missing_capabilities" ? 403 : 401,
        error: reasonCode === "missing_capabilities"
          ? "工具访问密钥缺少执行该工具所需的 Capability。"
          : "工具访问令牌无效或已停用。",
        reasonCode,
        missingCapabilities: credentialDecision.missingCapabilities || [requiredCapability],
        missingScopes: [],
        grant: toPublicGrant(grant),
        authorizationDecision: credentialDecision
      };
    }
    if (credentialDecision.credentialId && credentialDecision.credentialId !== grant.id) {
      return {
        ok: false,
        status: 401,
        error: "工具访问令牌与授权记录不匹配。",
        reasonCode: "credential_binding_mismatch",
        missingCapabilities: [],
        missingScopes: [],
        grant: toPublicGrant(grant),
        authorizationDecision: credentialDecision
      };
    }
    if (typeof resolvedCapabilityBindingGuard?.verifyCapabilityKeyBinding === "function") {
      const boundContext: any = bindingContextFromGrant(grant);
      const requestBindingContext: any = bindingContextFromRequest({ request, context });
      const contextMismatch: any = bindingContextMismatch(boundContext, requestBindingContext);
      if (!contextMismatch.ok) {
        return {
          ok: false,
          status: 403,
          error: "工具访问密钥与当前用户或智能体绑定不匹配。",
          reasonCode: contextMismatch.reasonCode || "capability_binding_denied",
          missingCapabilities: [],
          missingScopes: [],
          grant: toPublicGrant(grant),
          authorizationDecision: contextMismatch
        };
      }
      const bindingDecision: any = await resolvedCapabilityBindingGuard.verifyCapabilityKeyBinding({
        capabilityKey: token,
        credentialId: grant.id,
        context: requestBindingContext
      });
      if (!bindingDecision.ok) {
        return {
          ok: false,
          status: 403,
          error: "工具访问密钥与当前用户或智能体绑定不匹配。",
          reasonCode: bindingDecision.reasonCode || "capability_binding_denied",
          missingCapabilities: [],
          missingScopes: [],
          grant: toPublicGrant(grant),
          authorizationDecision: bindingDecision
        };
      }
    }
    const dynamicCapability: any = context?.dynamicCapability && typeof context.dynamicCapability === "object" && !Array.isArray(context.dynamicCapability)
      ? context.dynamicCapability
      : null;
    if (dynamicCapability) {
      const capabilityId: any = String(dynamicCapability.capabilityId || "").trim();
      const serviceId: any = String(dynamicCapability.serviceId || dynamicCapability.resourceContext?.serviceId || "").trim();
      const grantedDynamicCapabilities: any = new Set<any>(normalizeDynamicUpstreamCapabilities(grant.dynamicCapabilities));
      if (!capabilityId || !capabilityId.startsWith("cap:upstream:") || !grantedDynamicCapabilities.has(capabilityId)) {
        return {
          ok: false,
          status: 403,
          error: "工具访问授权未包含该上游服务操作。",
          reasonCode: "missing_dynamic_upstream_capability",
          missingCapabilities: capabilityId ? [capabilityId] : [],
          missingScopes: [],
          grant: toPublicGrant(grant),
          authorizationDecision: {
            ok: false,
            reasonCode: "missing_dynamic_upstream_capability",
            requiredCapabilities: capabilityId ? [capabilityId] : []
          }
        };
      }
      const allowedServiceIds: any = new Set<any>(grant.allowedServiceIds || []);
      if (serviceId && allowedServiceIds.size > 0 && !allowedServiceIds.has(serviceId)) {
        return {
          ok: false,
          status: 403,
          error: "工具访问授权未包含该上游服务。",
          reasonCode: "upstream_service_binding_denied",
          missingCapabilities: [capabilityId],
          missingScopes: [],
          grant: toPublicGrant(grant),
          authorizationDecision: { ok: false, reasonCode: "upstream_service_binding_denied", requiredCapabilities: [capabilityId] }
        };
      }
      const allowedSecretBindings: any = new Set<any>(grant.allowedSecretBindings || []);
      const credentialBindingIds: any[] = [...new Set<any>((Array.isArray(dynamicCapability.credentialBindingIds)
        ? dynamicCapability.credentialBindingIds
        : []).map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
      const missingCredentialBindings: any = credentialBindingIds.filter((bindingId?: any) : any =>
        !allowedSecretBindings.has(bindingId) && !grantedDynamicCapabilities.has(`${capabilityId}:${bindingId}`)
      );
      if (missingCredentialBindings.length > 0) {
        return {
          ok: false,
          status: 403,
          error: "工具访问授权未绑定该上游凭据。",
          reasonCode: "upstream_credential_binding_denied",
          missingCapabilities: missingCredentialBindings.map((bindingId?: any) : any => `${capabilityId}:${bindingId}`),
          missingScopes: [],
          grant: toPublicGrant(grant),
          authorizationDecision: {
            ok: false,
            reasonCode: "upstream_credential_binding_denied",
            requiredCapabilities: missingCredentialBindings.map((bindingId?: any) : any => `${capabilityId}:${bindingId}`)
          }
        };
      }
    }
    return finishGrantAuthorization({
      grant,
      parentGrant,
      request,
      sourceIp: sourceIpFromRequest(request),
      requiredScopes,
      tool,
      context,
      recordUse
    });
  }

  async function authorizeRequest({
    request,
    requiredScopes = [],
    tool = null,
    context = {},
    recordUse = true,
    requestBody = Buffer.alloc(0),
    url = null,
    method = "GET"
  }: Record<string, any> = {}) : Promise<any> {
    const token: any = readBearerToken(request);
    if (!token) {
      return {
        ok: false,
        status: 401,
        error: "缺少工具访问令牌。",
        reasonCode: "missing_token"
      };
    }
    const tokenHash: any = hashToken(token);
    const rows: any = db.prepare("SELECT * FROM tool_grants WHERE enabled = 1 AND revoked_at = ''").all();
    const grant: any = rows.map(hydrateGrant).find((item?: any) : any => safeCompare(item.tokenHash, tokenHash));
    if (!grant) {
      return {
        ok: false,
        status: 401,
        error: "工具访问令牌无效或已停用。",
        reasonCode: "invalid_token"
      };
    }
    const integrityDenial: any = policyIntegrityDenial(grant);
    if (integrityDenial) return integrityDenial;
    if (!grant.ownerIntegrity?.valid) {
      appendGrantEvent(grant.id, "owner_integrity_denied", { reasonCode: "grant_owner_binding_missing" });
      return {
        ok: false,
        status: 503,
        error: "Stored grant owner binding failed integrity validation.",
        reasonCode: "grant_owner_binding_missing",
        missingCapabilities: [],
        missingScopes: [],
        grant: toPublicGrant(grant),
        authorizationDecision: { ok: false, reasonCode: "grant_owner_binding_missing" }
      };
    }
    if (!grantOwnersAreActive(grant.id)) {
      appendGrantEvent(grant.id, "owner_integrity_denied", { reasonCode: "grant_owner_generation_inactive" });
      return {
        ok: false,
        status: 403,
        error: "Stored grant owner generation is no longer active.",
        reasonCode: "grant_owner_generation_inactive",
        missingCapabilities: [],
        missingScopes: [],
        grant: toPublicGrant(grant),
        authorizationDecision: { ok: false, reasonCode: "grant_owner_generation_inactive" }
      };
    }
    const delegatedParent: any = activeDelegatedParent(grant);
    if (!delegatedParent.ok) return delegatedParent;
    if (!token.startsWith("ock_")) {
      return {
        ok: false,
        status: 401,
        error: "工具访问令牌使用了非当前格式。",
        reasonCode: "non_current_token_protocol",
        grant: toPublicGrant(grant)
      };
    }
    const targetBindingDecision: any = localMcpTargetBindingDecision(grant, request);
    if (!targetBindingDecision.ok) {
      recordMcpTargetBindingDenial({ grant, request, decision: targetBindingDecision });
      return {
        ok: false,
        status: 403,
        error: "MCP client identity does not match the issued local grant target.",
        reasonCode: targetBindingDecision.reasonCode,
        missingCapabilities: [],
        missingScopes: [],
        grant: toPublicGrant(grant),
        authorizationDecision: targetBindingDecision
      };
    }
    const processIdentityDecision: any = await verifyLocalMcpProcessIdentity({
      grant,
      request,
      requestBody,
      url,
      method
    });
    if (!processIdentityDecision.ok) {
      return {
        ok: false,
        status: processIdentityDecision.status || 401,
        error: processIdentityDecision.error || "MCP client process identity is required for this local grant.",
        reasonCode: processIdentityDecision.reasonCode || "process_identity_denied",
        missingCapabilities: [],
        missingScopes: [],
        grant: toPublicGrant(grant),
        authorizationDecision: {
          ok: false,
          reasonCode: processIdentityDecision.reasonCode || "process_identity_denied",
          requiredCapabilities: [apiCapabilityId("mcp.request")]
        }
      };
    }
    if (tool?.id) {
      if (typeof resolvedCapabilityKeyProvider?.verify !== "function") {
        return {
          ok: false,
          status: 503,
          error: "Capability Kernel 不可用，无法验证工具访问密钥。",
          reasonCode: "capability_kernel_unavailable",
          missingCapabilities: [toolExecuteCapabilityId(tool.id)],
          missingScopes: [],
          grant: toPublicGrant(grant),
          authorizationDecision: {
            ok: false,
            reasonCode: "capability_kernel_unavailable",
            requiredCapabilities: [toolExecuteCapabilityId(tool.id)]
          }
        };
      }
      return authorizeOpaqueToolCapability({
        token,
        grant,
        parentGrant: delegatedParent.parentGrant,
        request,
        context,
        tool,
        requiredScopes,
        recordUse
      });
    }
    return finishGrantAuthorization({
      grant,
      parentGrant: delegatedParent.parentGrant,
      request,
      sourceIp: sourceIpFromRequest(request),
      requiredScopes,
      context,
      recordUse
    });
  }

  function authorizeGrantForExecution({
    grantId,
    expectedProjectionFingerprint = "",
    request,
    requiredScopes = [],
    tool = null,
    context = {}
  }: Record<string, any> = {}) : any {
    const grant: any = getGrant(String(grantId || ""));
    if (!grant || grant.enabled === false || grant.revokedAt) {
      return {
        ok: false,
        status: 403,
        error: "Tool grant is no longer active.",
        reasonCode: "execution_grant_inactive"
      };
    }
    const integrityDenial: any = policyIntegrityDenial(grant);
    if (integrityDenial) return integrityDenial;
    if (!grant.ownerIntegrity?.valid) {
      return {
        ok: false,
        status: 503,
        error: "Stored grant owner binding failed integrity validation.",
        reasonCode: "grant_owner_binding_missing"
      };
    }
    if (!grantOwnersAreActive(grant.id)) {
      return {
        ok: false,
        status: 403,
        error: "Stored grant owner generation is no longer active.",
        reasonCode: "grant_owner_generation_inactive"
      };
    }
    if (
      expectedProjectionFingerprint &&
      toPublicGrant(grant).projectionFingerprint !== String(expectedProjectionFingerprint)
    ) {
      return {
        ok: false,
        status: 409,
        error: "Tool grant changed after authorization was captured.",
        reasonCode: "execution_grant_revision_changed"
      };
    }
    const delegatedParent: any = activeDelegatedParent(grant);
    if (!delegatedParent.ok) return delegatedParent;
    return finishGrantAuthorization({
      grant,
      parentGrant: delegatedParent.parentGrant,
      request,
      requiredScopes,
      tool,
      context,
      recordUse: false
    });
  }

  return {
    listGrants,
    getGrant: (grantId?: any) : any => toPublicGrant(getGrant(grantId)),
    getRawGrant: getGrant,
    createGrant,
    updateGrant,
    deleteGrant,
    revokeGrant,
    rotateGrantToken,
    registerPluginGrantOwner,
    revokeGrantsByPluginOwner,
    authorizeRequest,
    authorizeGrantForExecution,
    appendGrantEvent,
    listGrantEvents
  };
}
