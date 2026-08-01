import { asArray, text } from "./support.ts";

export function publicTagPolicyDecision(decision: Record<string, any> = {}) : any {
  return {
    enabled: true,
    allowed: decision.allowed === true,
    reasonCode: text(decision.reasonCode || ""),
    entityRefs: asArray(decision.entityRefs),
    policyRevision: decision.policyRevision || null,
    inputPolicyRevision: decision.inputPolicyRevision || 0,
    stale: decision.stale === true,
    matchedDenyTags: asArray(decision.matchedDenyTags).map(text).filter(Boolean),
    matchedAllowTags: asArray(decision.matchedAllowTags).map(text).filter(Boolean),
    missingRequiredTags: asArray(decision.missingRequiredTags).map(text).filter(Boolean)
  };
}
