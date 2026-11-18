export function createDelegatedGrantSecurity({
  db,
  rowToGrant,
  getGrant,
  upsertGrant,
  toPublicGrant,
  appendGrantEvent,
  capabilityKeyProvider,
  capabilityBindingGuard,
  notifyChange,
  nowIso
}: Record<string, any>) : any {
  function delegatedParentId(grant: any = null) : any {
    return String(grant?.parentGrantId || "").trim();
  }

  function delegatedDescendants(parentGrantId?: any) : any {
    const resolvedParentGrantId: any = String(parentGrantId || "").trim();
    if (!resolvedParentGrantId) return [];
    return db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM tool_grants
        WHERE parent_grant_id = ? AND type = 'delegated-mcp-child'
        UNION
        SELECT child.id
        FROM tool_grants AS child
        JOIN descendants AS parent ON child.parent_grant_id = parent.id
        WHERE child.type = 'delegated-mcp-child'
      )
      SELECT grant.*
      FROM descendants
      JOIN tool_grants AS grant ON grant.id = descendants.id
      ORDER BY grant.id
    `).all(resolvedParentGrantId).map(rowToGrant);
  }

  async function invalidateGrantCredential(grant?: any, reason?: any) : Promise<any> {
    if (!grant) return;
    if (typeof capabilityKeyProvider?.invalidateCredential === "function") {
      await capabilityKeyProvider.invalidateCredential({ credentialId: grant.id, reason });
    }
    if (typeof capabilityBindingGuard?.invalidateCapabilityKeyBinding === "function") {
      await capabilityBindingGuard.invalidateCapabilityKeyBinding({ credentialId: grant.id, reason });
    }
  }

  async function revokeDelegatedDescendants(parentGrantId?: any, reason?: any) : Promise<any> {
    const rootGrantId: string = String(parentGrantId || "").trim();
    if (!rootGrantId) return { revokedCount: 0, reachedVertices: 0, reachedEdges: 0 };
    const descendants: any[] = delegatedDescendants(rootGrantId);
    const childrenByParent: Map<string, any[]> = new Map();
    for (const child of descendants) {
      const list: any[] = childrenByParent.get(child.parentGrantId) || [];
      list.push(child);
      childrenByParent.set(child.parentGrantId, list);
    }
    const queue: string[] = [rootGrantId];
    const visited: Set<string> = new Set([rootGrantId]);
    const ordered: any[] = [];
    let head: number = 0;
    while (head < queue.length) {
      const currentParentId: string = queue[head++];
      for (const child of childrenByParent.get(currentParentId) || []) {
        if (visited.has(child.id)) {
          throw new Error("operation_permission_delegated_parent_cycle");
        }
        visited.add(child.id);
        queue.push(child.id);
        ordered.push(child);
      }
    }
    if (ordered.length !== descendants.length) {
      throw new Error("operation_permission_delegated_parent_graph_incomplete");
    }
    const timestamp: any = nowIso();
    const updatedDescendants: any[] = ordered.map((child?: any) : any => ({
      ...child,
      enabled: false,
      revokedAt: child.revokedAt || timestamp,
      updatedAt: timestamp,
      reason: reason || child.reason
    }));
    db.transaction(() : any => {
      for (const updated of updatedDescendants) {
        upsertGrant(updated);
        appendGrantEvent(updated.id, "revoked", {
          reason: updated.reason,
          parentGrantId: updated.parentGrantId
        });
      }
    })();
    for (const updated of updatedDescendants) {
      await invalidateGrantCredential(updated, reason || "delegated_parent_grant_changed");
      await notifyChange({
        type: "grant_revoked",
        grantId: updated.id,
        parentGrantId: updated.parentGrantId,
        reasonCode: "delegated_parent_grant_changed",
        reason: updated.reason || "delegated_parent_grant_changed"
      });
    }
    return {
      revokedCount: updatedDescendants.length,
      reachedVertices: visited.size,
      reachedEdges: updatedDescendants.length
    };
  }

  function policyIntegrityDenial(grant?: any, { parent = false }: Record<string, any> = {}) : any {
    if (grant?.policyIntegrity?.valid !== false) return null;
    const reasonCode: any = parent ? "delegated_parent_policy_corrupt" : "grant_policy_corrupt";
    appendGrantEvent(grant.id, "policy_integrity_denied", {
      reasonCode,
      invalidFields: grant.policyIntegrity.invalidFields || []
    });
    void notifyChange({ type: "grant_policy_integrity_denied", grantId: grant.id, reasonCode });
    return {
      ok: false,
      status: 503,
      error: "Stored grant policy failed integrity validation.",
      reasonCode,
      missingCapabilities: [],
      missingScopes: [],
      grant: toPublicGrant(grant),
      authorizationDecision: { ok: false, reasonCode }
    };
  }

  function activeDelegatedParent(grant?: any) : any {
    if (String(grant?.type || "") !== "delegated-mcp-child") {
      return { ok: true, parentGrant: null };
    }
    const parentGrantId: any = delegatedParentId(grant);
    const parentGrant: any = parentGrantId ? getGrant(parentGrantId) : null;
    if (!parentGrant || parentGrant.enabled === false || parentGrant.revokedAt) {
      return {
        ok: false,
        status: 403,
        error: "Delegated MCP parent grant is not active.",
        reasonCode: "delegated_parent_grant_inactive",
        grant: toPublicGrant(grant)
      };
    }
    if (parentGrant.expiresAt && Date.parse(parentGrant.expiresAt) <= Date.now()) {
      return {
        ok: false,
        status: 403,
        error: "Delegated MCP parent grant is expired.",
        reasonCode: "delegated_parent_grant_expired",
        grant: toPublicGrant(grant)
      };
    }
    const integrityDenial: any = policyIntegrityDenial(parentGrant, { parent: true });
    return integrityDenial
      ? { ...integrityDenial, parentGrant: null }
      : { ok: true, parentGrant };
  }

  return {
    activeDelegatedParent,
    invalidateGrantCredential,
    policyIntegrityDenial,
    revokeDelegatedDescendants
  };
}
