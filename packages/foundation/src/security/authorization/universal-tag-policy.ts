import { createTagTreeFromStore, type TagLookup } from "./tag-tree.ts";

export const UNIVERSAL_TAG_POLICY_PROTOCOL_VERSION = "v0.0.1:operation-permission:universal-tag-policy-1";

interface EntityRef { entityType: string; entityId: string; }
interface EntityTagSet extends EntityRef { directTags: string[]; effectiveTags: string[]; }
interface ProjectionRecord { entityId?: unknown; tagId?: unknown; }
interface PolicyRevision { protocolVersion: string; revision: number; updatedAt: string; }
interface UniversalTagStore extends TagLookup {
  listProjections(input: { entityType: string; includeArchived: boolean }): ProjectionRecord[];
  getPolicyRevision?(): unknown;
}
interface UniversalTagPolicyInput {
  tagStore?: UniversalTagStore | null; entityRefs?: unknown; entities?: unknown; denyTags?: unknown; deniedTags?: unknown;
  allowTags?: unknown; allowedTags?: unknown; requiredTags?: unknown; policyRevision?: unknown;
  failOnStale?: boolean; requireFreshRevision?: boolean;
}
interface UniversalTagPolicyShape {
  entityRefs?: unknown; entities?: unknown; denyTags?: unknown; deniedTags?: unknown; allowTags?: unknown;
  allowedTags?: unknown; requiredTags?: unknown; requireFreshRevision?: unknown; failOnStale?: unknown;
}
interface UniversalTagDecision {
  protocolVersion: string; effect: string; allowed: boolean; reasonCode: string; redactedReason: string;
  evaluatedLayers: string[]; createdAt: string; [key: string]: unknown;
}

function nowIso(): string { return new Date().toISOString(); }
function uniqueStrings(values: unknown = []): string[] {
  const input = Array.isArray(values) ? values : [values];
  return [...new Set(input.map((value) => String(value || "").trim()).filter(Boolean))];
}
function normalizeEntityRefs(value: unknown = []): EntityRef[] {
  const input = Array.isArray(value) ? value : [value];
  return input.flatMap((entry): EntityRef[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const entityType = String(record.entityType || record.type || "").trim();
    const entityId = String(record.entityId || record.id || "").trim();
    return entityType && entityId ? [{ entityType, entityId }] : [];
  });
}
function revisionNumber(value?: unknown): number {
  const parsed = Number(value || 0); return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
export function hasUniversalTagPolicyRules(policy: UniversalTagPolicyShape = {}): boolean {
  return normalizeEntityRefs(policy.entityRefs || policy.entities).length > 0 || uniqueStrings(policy.denyTags || policy.deniedTags).length > 0 ||
    uniqueStrings(policy.allowTags || policy.allowedTags).length > 0 || uniqueStrings(policy.requiredTags).length > 0 ||
    policy.requireFreshRevision === true || policy.failOnStale === true;
}
function projectionsForEntity(store: UniversalTagStore, entityRef: EntityRef): ProjectionRecord[] {
  if (typeof store.listProjections !== "function") return [];
  return store.listProjections({ entityType: entityRef.entityType, includeArchived: false })
    .filter((projection) => String(projection.entityId || "") === entityRef.entityId);
}
function collectEntityTags(store: UniversalTagStore, entityRefs: EntityRef[]): EntityTagSet[] {
  const tagTree = createTagTreeFromStore(store);
  return entityRefs.map((entityRef) => {
    const directTags = uniqueStrings(projectionsForEntity(store, entityRef).map((projection) => projection.tagId));
    return { ...entityRef, directTags, effectiveTags: tagTree.effectiveTagsFor(directTags) };
  });
}
function policyRevisionFromStore(store: UniversalTagStore): PolicyRevision {
  const value = store.getPolicyRevision?.();
  const revision = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { protocolVersion: String(revision.protocolVersion || ""), revision: revisionNumber(revision.revision), updatedAt: String(revision.updatedAt || "") };
}
function decision(effect: string, reasonCode: string, redactedReason: string, extra: Record<string, unknown> = {}): UniversalTagDecision {
  return { protocolVersion: UNIVERSAL_TAG_POLICY_PROTOCOL_VERSION, effect, allowed: effect === "allow", reasonCode, redactedReason,
    evaluatedLayers: ["universal_tag_policy"], createdAt: nowIso(), ...extra };
}
function policyRevisionValue(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).revision : value;
}

export function evaluateUniversalTagPolicy({ tagStore = null, entityRefs = [], entities = [], denyTags = [], deniedTags = [],
  allowTags = [], allowedTags = [], requiredTags = [], policyRevision = 0, failOnStale = false, requireFreshRevision = false }: UniversalTagPolicyInput = {}): UniversalTagDecision {
  const normalizedEntityRefs = normalizeEntityRefs(Array.isArray(entityRefs) && entityRefs.length ? entityRefs : entities);
  if (!tagStore) return decision("deny", "tag_store_unavailable", "Tag policy store is unavailable.", {
    deniedLayer: "tag_policy", entityRefs: normalizedEntityRefs, policyRevision: { revision: 0, protocolVersion: "", updatedAt: "" }, stale: true
  });
  const currentRevision = policyRevisionFromStore(tagStore); const inputRevision = revisionNumber(policyRevisionValue(policyRevision));
  const stale = inputRevision > 0 && currentRevision.revision > inputRevision; const entityTags = collectEntityTags(tagStore, normalizedEntityRefs);
  const effectiveTagSet = new Set(entityTags.flatMap((entry) => entry.effectiveTags));
  const normalizedDenyTags = uniqueStrings([...uniqueStrings(denyTags), ...uniqueStrings(deniedTags)]);
  const normalizedAllowTags = uniqueStrings([...uniqueStrings(allowTags), ...uniqueStrings(allowedTags)]); const normalizedRequiredTags = uniqueStrings(requiredTags);
  const matchedDenyTags = normalizedDenyTags.filter((tagId) => effectiveTagSet.has(tagId));
  const matchedAllowTags = normalizedAllowTags.filter((tagId) => effectiveTagSet.has(tagId));
  const missingRequiredTags = normalizedRequiredTags.filter((tagId) => !effectiveTagSet.has(tagId));
  const base: Record<string, unknown> = { entityRefs: normalizedEntityRefs, entityTags, policyRevision: currentRevision, inputPolicyRevision: inputRevision,
    stale, denyTags: normalizedDenyTags, allowTags: normalizedAllowTags, requiredTags: normalizedRequiredTags, matchedDenyTags, matchedAllowTags, missingRequiredTags };
  if (matchedDenyTags.length) return decision("deny", "tag_policy_denied", "A deny tag matched the governed entity.", { ...base, deniedLayer: "tag_policy" });
  if ((failOnStale || requireFreshRevision) && stale) return decision("deny", "tag_policy_stale", "Tag policy revision is stale.", { ...base, deniedLayer: "tag_policy" });
  if (missingRequiredTags.length) return decision("deny", "tag_policy_required_tag_missing", "A required tag is missing from the governed entity.", { ...base, deniedLayer: "tag_policy" });
  if (normalizedAllowTags.length && !matchedAllowTags.length) return decision("deny", "tag_policy_allow_tag_missing", "No allow tag matched the governed entity.", { ...base, deniedLayer: "tag_policy" });
  return decision("allow", "tag_policy_allowed", "Tag policy allowed the governed entity.", base);
}
