import { createTagTreeFromStore } from "./tag-tree.mjs";

export const UNIVERSAL_TAG_POLICY_PROTOCOL_VERSION = "v0.0.1:operation-permission:universal-tag-policy-1";

function nowIso() {
  return new Date().toISOString();
}

function uniqueStrings(values = []) {
  const input = Array.isArray(values) ? values : [values];
  return [...new Set(input.map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeEntityRefs(value = []) {
  const input = Array.isArray(value) ? value : [value];
  return input
    .map((entry) => ({
      entityType: String(entry?.entityType || entry?.type || "").trim(),
      entityId: String(entry?.entityId || entry?.id || "").trim()
    }))
    .filter((entry) => entry.entityType && entry.entityId);
}

function revisionNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function hasUniversalTagPolicyRules(policy = {}) {
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

function projectionsForEntity(store, entityRef) {
  if (typeof store?.listProjections !== "function") {
    return [];
  }
  return store
    .listProjections({
      entityType: entityRef.entityType,
      includeArchived: false
    })
    .filter((projection) => String(projection.entityId || "") === entityRef.entityId);
}

function collectEntityTags(store, entityRefs) {
  const tagTree = createTagTreeFromStore(store);
  return entityRefs.map((entityRef) => {
    const directTags = uniqueStrings(projectionsForEntity(store, entityRef).map((projection) => projection.tagId));
    const effectiveTags = tagTree.effectiveTagsFor(directTags);
    return {
      ...entityRef,
      directTags,
      effectiveTags
    };
  });
}

function policyRevisionFromStore(store) {
  const revision = typeof store?.getPolicyRevision === "function" ? store.getPolicyRevision() : null;
  return {
    protocolVersion: String(revision?.protocolVersion || ""),
    revision: revisionNumber(revision?.revision),
    updatedAt: String(revision?.updatedAt || "")
  };
}

function decision(effect, reasonCode, redactedReason, extra = {}) {
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
} = {}) {
  if (!tagStore) {
    return decision("deny", "tag_store_unavailable", "Tag policy store is unavailable.", {
      deniedLayer: "tag_policy",
      entityRefs: normalizeEntityRefs(entityRefs.length ? entityRefs : entities),
      policyRevision: { revision: 0, protocolVersion: "", updatedAt: "" },
      stale: true
    });
  }

  const normalizedEntityRefs = normalizeEntityRefs(entityRefs.length ? entityRefs : entities);
  const currentRevision = policyRevisionFromStore(tagStore);
  const inputRevision = revisionNumber(policyRevision?.revision || policyRevision);
  const stale = inputRevision > 0 && currentRevision.revision > inputRevision;
  const entityTags = collectEntityTags(tagStore, normalizedEntityRefs);
  const effectiveTagSet = new Set(entityTags.flatMap((entry) => entry.effectiveTags));
  const normalizedDenyTags = uniqueStrings([...uniqueStrings(denyTags), ...uniqueStrings(deniedTags)]);
  const normalizedAllowTags = uniqueStrings([...uniqueStrings(allowTags), ...uniqueStrings(allowedTags)]);
  const normalizedRequiredTags = uniqueStrings(requiredTags);
  const matchedDenyTags = normalizedDenyTags.filter((tagId) => effectiveTagSet.has(tagId));
  const matchedAllowTags = normalizedAllowTags.filter((tagId) => effectiveTagSet.has(tagId));
  const missingRequiredTags = normalizedRequiredTags.filter((tagId) => !effectiveTagSet.has(tagId));
  const base = {
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
