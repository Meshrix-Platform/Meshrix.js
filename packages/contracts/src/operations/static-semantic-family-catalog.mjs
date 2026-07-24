import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";

export const OPERATION_STATIC_SEMANTIC_FAMILY_CATALOG_KIND = "meshrix.operation.static-semantic-family-catalog";
export const OPERATION_STATIC_SEMANTIC_FAMILY_PROTOCOL_VERSION = "v0.0.1:operation-registry:static-semantic-family-2";


function digestValue(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

const STATIC_SEMANTIC_FAMILIES = Object.freeze([
  {
    familyId: "operation.read",
    version: "v1",
    lifecycle: "active",
    proofProfile: "receipt",
    allowedRisk: ["read_only"],
    requiredGates: ["authorization", "audit", "output-governance"],
    requiredReceiptFields: ["operationId", "grantId"],
    requiredRecoveryContract: false,
    compatibleEffectKinds: ["read", "search", "status_check"]
  },
  {
    familyId: "operation.export",
    version: "v1",
    lifecycle: "active",
    proofProfile: "receipt",
    allowedRisk: ["read_only"],
    requiredGates: ["authorization", "audit", "output-governance"],
    requiredReceiptFields: ["operationId", "grantId", "assetRefs"],
    requiredRecoveryContract: false,
    compatibleEffectKinds: ["artifact_export", "export"]
  },
  {
    familyId: "operation.safe_write",
    version: "v1",
    lifecycle: "active",
    proofProfile: "full",
    allowedRisk: ["safe_write"],
    requiredGates: ["authorization", "audit", "output-governance"],
    requiredReceiptFields: ["operationId", "grantId", "auditRef"],
    requiredRecoveryContract: false,
    compatibleEffectKinds: ["record_created", "record_updated", "safe_write"]
  },
  {
    familyId: "operation.repair_write",
    version: "v1",
    lifecycle: "active",
    proofProfile: "full",
    allowedRisk: ["repair_write"],
    requiredGates: ["authorization", "audit", "operator-review"],
    requiredReceiptFields: ["operationId", "grantId", "auditRef"],
    requiredRecoveryContract: false,
    compatibleEffectKinds: ["repair", "reconcile", "state_repair"]
  },
  {
    familyId: "operation.destructive",
    version: "v1",
    lifecycle: "active",
    proofProfile: "full",
    allowedRisk: ["destructive"],
    requiredGates: ["authorization", "approval", "audit", "operator-review"],
    requiredReceiptFields: ["operationId", "grantId", "auditRef"],
    requiredRecoveryContract: false,
    compatibleEffectKinds: ["delete", "destructive", "irreversible_action"]
  },
  {
    familyId: "operation.model_inference",
    version: "v1",
    lifecycle: "active",
    proofProfile: "full",
    allowedRisk: ["read_only", "safe_write"],
    requiredGates: ["authorization", "model-budget-quota", "output-governance"],
    requiredReceiptFields: ["operationId", "grantId", "outputGovernance"],
    requiredRecoveryContract: false,
    compatibleEffectKinds: ["model_inference", "model_generation"]
  }
].map((family) => Object.freeze({
  protocolVersion: OPERATION_STATIC_SEMANTIC_FAMILY_PROTOCOL_VERSION,
  ...family,
  familyFingerprint: digestValue({
    protocolVersion: OPERATION_STATIC_SEMANTIC_FAMILY_PROTOCOL_VERSION,
    familyId: family.familyId,
    version: family.version,
    proofProfile: family.proofProfile,
    allowedRisk: family.allowedRisk,
    requiredGates: family.requiredGates,
    requiredReceiptFields: family.requiredReceiptFields,
    requiredRecoveryContract: family.requiredRecoveryContract,
    compatibleEffectKinds: family.compatibleEffectKinds
  })
})));

const STATIC_SEMANTIC_FAMILIES_BY_ID = new Map(STATIC_SEMANTIC_FAMILIES.map((family) => [family.familyId, family]));

export function listStaticSemanticFamilies() {
  return STATIC_SEMANTIC_FAMILIES.map((family) => ({ ...family }));
}

export function getStaticSemanticFamily(familyId = "") {
  const id = String(familyId || "").trim();
  const family = STATIC_SEMANTIC_FAMILIES_BY_ID.get(id);
  return family ? { ...family } : null;
}

export function staticSemanticFamilyPublicSummary(family = {}) {
  return {
    protocolVersion: String(family.protocolVersion || OPERATION_STATIC_SEMANTIC_FAMILY_PROTOCOL_VERSION),
    familyId: String(family.familyId || ""),
    version: String(family.version || ""),
    lifecycle: String(family.lifecycle || ""),
    proofProfile: String(family.proofProfile || ""),
    requiredGates: Array.isArray(family.requiredGates) ? [...family.requiredGates] : [],
    familyFingerprint: String(family.familyFingerprint || "")
  };
}

export function listStaticSemanticFamilyPublicSummaries() {
  return listStaticSemanticFamilies().map(staticSemanticFamilyPublicSummary);
}
