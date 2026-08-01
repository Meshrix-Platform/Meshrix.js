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
    return String(grant?.metadata?.delegatedMcp?.sourceGrantId || "").trim();
  }

  function delegatedChildren(parentGrantId?: any) : any {
    const resolvedParentGrantId: any = String(parentGrantId || "").trim();
    if (!resolvedParentGrantId) return [];
    return db.prepare("SELECT * FROM tool_grants WHERE type = 'delegated-mcp-child'")
      .all()
      .map(rowToGrant)
      .filter((grant?: any) : any => delegatedParentId(grant) === resolvedParentGrantId);
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
    const queue: any = [String(parentGrantId || "").trim()].filter(Boolean);
    const visited: any = new Set<any>(queue);
    while (queue.length > 0) {
      const currentParentId: any = queue.shift();
      for (const child of delegatedChildren(currentParentId)) {
        if (!visited.has(child.id)) {
          visited.add(child.id);
          queue.push(child.id);
        }
        const timestamp: any = nowIso();
        const updated: Record<string, any> = {
          ...child,
          enabled: false,
          revokedAt: child.revokedAt || timestamp,
          updatedAt: timestamp,
          reason: reason || child.reason
        };
        upsertGrant(updated);
        appendGrantEvent(updated.id, "revoked", {
          reason: updated.reason,
          parentGrantId: currentParentId
        });
        await invalidateGrantCredential(updated, reason || "delegated_parent_grant_changed");
        await notifyChange({
          type: "grant_revoked",
          grantId: updated.id,
          parentGrantId: currentParentId,
          reasonCode: "delegated_parent_grant_changed",
          reason: updated.reason || "delegated_parent_grant_changed"
        });
      }
    }
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
