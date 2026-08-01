import { createTagTreeFromStore } from "./tag-tree.ts";

export const UNIVERSAL_TAG_POLICY_PROTOCOL_VERSION: any = "v0.0.1:operation-permission:universal-tag-policy-1";

function nowIso() : any {
  return new Date().toISOString();
}

function uniqueStrings(values: any = []) : any {
  const input: any = Array.isArray(values) ? values : [values];
  return [...new Set<any>(input.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

function normalizeEntityRefs(value: any = []) : any {
  const input: any = Array.isArray(value) ? value : [value];
  return input
    .map((entry?: any) : any => ({
      entityType: String(entry?.entityType || entry?.type || "").trim(),
      entityId: String(entry?.entityId || entry?.id || "").trim()
    }))
    .filter((entry?: any) : any => entry.entityType && entry.entityId);
}

function revisionNumber(value?: any) : any {
  const parsed: any = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function hasUniversalTagPolicyRules(policy: Record<string, any> = {}) : any {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return false;
  }
  return normalizeEntityRefs(policy.entityRefs || policy.entities).length > 0 ||
    uniqueStrings(policy.denyTags || policy.deniedTags).length > 0 ||
    uniqueStrings(policy.allowTags || policy.allowedTags).length > 0 ||
    uniqueStrings(policy.requiredTags).length > 0 ||
    policy.requireFreshRevision === true ||
    policy.failOnStale === true;
}

function projectionsForEntity(store?: any, entityRef?: any) : any {
  if (typeof store?.listProjections !== "function") {
    return [];
  }
  return store
    .listProjections({
      entityType: entityRef.entityType,
      includeArchived: false
    })
    .filter((projection?: any) : any => String(projection.entityId || "") === entityRef.entityId);
}

function collectEntityTags(store?: any, entityRefs?: any) : any {
  const tagTree: any = createTagTreeFromStore(store);
  return entityRefs.map((entityRef?: any) : any => {
    const directTags: any = uniqueStrings(projectionsForEntity(store, entityRef).map((projection?: any) : any => projection.tagId));
    const effectiveTags: any = tagTree.effectiveTagsFor(directTags);
    return {
      ...entityRef,
      directTags,
      effectiveTags
    };
  });
}

function policyRevisionFromStore(store?: any) : any {
  const revision: any = typeof store?.getPolicyRevision === "function" ? store.getPolicyRevision() : null;
  return {
    protocolVersion: String(revision?.protocolVersion || ""),
    revision: revisionNumber(revision?.revision),
    updatedAt: String(revision?.updatedAt || "")
  };
}

function decision(effect?: any, reasonCode?: any, redactedReason?: any, extra: Record<string, any> = {}) : any {
  return {
    protocolVersion: UNIVERSAL_TAG_POLICY_PROTOCOL_VERSION,
    effect,
    allowed: effect === "allow",
    reasonCode,
    redactedReason,
    evaluatedLayers: ["universal_tag_policy"],
    createdAt: nowIso(),
    ...extra
  };
}

export function evaluateUniversalTagPolicy({
  tagStore = null,
  entityRefs = [],
  entities = [],
  denyTags = [],
  deniedTags = [],
  allowTags = [],
  allowedTags = [],
  requiredTags = [],
  policyRevision = 0,
  failOnStale = false,
  requireFreshRevision = false
}: Record<string, any> = {}) : any {
  if (!tagStore) {
    return decision("deny", "tag_store_unavailable", "Tag policy store is unavailable.", {
      deniedLayer: "tag_policy",
      entityRefs: normalizeEntityRefs(entityRefs.length ? entityRefs : entities),
      policyRevision: { revision: 0, protocolVersion: "", updatedAt: "" },
      stale: true
    });
  }

  const normalizedEntityRefs: any = normalizeEntityRefs(entityRefs.length ? entityRefs : entities);
  const currentRevision: any = policyRevisionFromStore(tagStore);
  const inputRevision: any = revisionNumber(policyRevision?.revision || policyRevision);
  const stale: any = inputRevision > 0 && currentRevision.revision > inputRevision;
  const entityTags: any = collectEntityTags(tagStore, normalizedEntityRefs);
  const effectiveTagSet: any = new Set<any>(entityTags.flatMap((entry?: any) : any => entry.effectiveTags));
  const normalizedDenyTags: any = uniqueStrings([...uniqueStrings(denyTags), ...uniqueStrings(deniedTags)]);
  const normalizedAllowTags: any = uniqueStrings([...uniqueStrings(allowTags), ...uniqueStrings(allowedTags)]);
  const normalizedRequiredTags: any = uniqueStrings(requiredTags);
  const matchedDenyTags: any = normalizedDenyTags.filter((tagId?: any) : any => effectiveTagSet.has(tagId));
  const matchedAllowTags: any = normalizedAllowTags.filter((tagId?: any) : any => effectiveTagSet.has(tagId));
  const missingRequiredTags: any = normalizedRequiredTags.filter((tagId?: any) : any => !effectiveTagSet.has(tagId));
  const base: Record<string, any> = {
    entityRefs: normalizedEntityRefs,
    entityTags,
    policyRevision: currentRevision,
    inputPolicyRevision: inputRevision,
    stale,
    denyTags: normalizedDenyTags,
    allowTags: normalizedAllowTags,
    requiredTags: normalizedRequiredTags,
    matchedDenyTags,
    matchedAllowTags,
    missingRequiredTags
  };

  if (matchedDenyTags.length > 0) {
    return decision("deny", "tag_policy_denied", "A deny tag matched the governed entity.", {
      ...base,
      deniedLayer: "tag_policy"
    });
  }
  if ((failOnStale || requireFreshRevision) && stale) {
    return decision("deny", "tag_policy_stale", "Tag policy revision is stale.", {
      ...base,
      deniedLayer: "tag_policy"
    });
  }
  if (missingRequiredTags.length > 0) {
    return decision("deny", "tag_policy_required_tag_missing", "A required tag is missing from the governed entity.", {
      ...base,
      deniedLayer: "tag_policy"
    });
  }
  if (normalizedAllowTags.length > 0 && matchedAllowTags.length === 0) {
    return decision("deny", "tag_policy_allow_tag_missing", "No allow tag matched the governed entity.", {
      ...base,
      deniedLayer: "tag_policy"
    });
  }
  return decision("allow", "tag_policy_allowed", "Tag policy allowed the governed entity.", base);
}
