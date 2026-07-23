import { canonicalJson } from "@lico/contracts/serialization/canonical-json";
import { createHash } from "node:crypto";


export function riskControlDigest(prefix, value) {
  return `sha256:${prefix}:${createHash("sha256").update(`${prefix}\n${canonicalJson(value)}`).digest("hex")}`;
}

function entryDigest(prefix, entry) {
  const { digest: _digest, ...body } = entry;
  return riskControlDigest(prefix, body);
}

function freezeEntries(prefix, entries) {
  return Object.freeze(entries.map((entry) => Object.freeze({
    ...entry,
    digest: entryDigest(prefix, entry)
  })));
}

export const RISK_CONTROL_COMPONENT_CATALOG = freezeEntries("v0.0.1:strategy:risk-control-component-1", [
  { id: "component.mcp-adapter", version: "v1:c1.r1", lifecycle: "active", authority: "LicoMesh MCP adapter" },
  { id: "component.operation-dispatcher", version: "v1:c1.r1", lifecycle: "active", authority: "LicoMesh operation dispatcher" },
  { id: "component.console-auth", version: "v1:c1.r1", lifecycle: "active", authority: "LicoMesh console auth" },
  { id: "component.operation-permission", version: "v1:c1.r1", lifecycle: "active", authority: "Operation Permission v1" },
  { id: "component.capability-kernel", version: "v1:c1.r1", lifecycle: "active", authority: "Capability Kernel" },
  { id: "component.binding-guard", version: "v1:c1.r1", lifecycle: "active", authority: "Capability Binding Guard" },
  { id: "component.operation-policy", version: "v1:c1.r1", lifecycle: "active", authority: "Operation Policy" },
  { id: "component.operation-proof-substrate", version: "v1:c1.r1", lifecycle: "active", authority: "Operation Proof Substrate" },
  { id: "component.checkpoint-tree", version: "v1:c1.r1", lifecycle: "active", authority: "Checkpoint Tree" },
  { id: "component.secret-store", version: "v1:c1.r1", lifecycle: "active", authority: "SecretStore" },
  { id: "component.quota-bulkhead", version: "v1:c1.r1", lifecycle: "active", authority: "Quota and bulkhead runtime" },
  { id: "component.runtime-queue", version: "v1:c1.r1", lifecycle: "active", authority: "LicoMesh Work Queue" },
  { id: "component.runtime-capacity", version: "v1:c1.r1", lifecycle: "active", authority: "Performance capacity gate" },
  { id: "component.audit-store", version: "v1:c1.r1", lifecycle: "active", authority: "Risk and operation audit stores" },
  { id: "component.recovery-package", version: "v1:c1.r1", lifecycle: "active", authority: "Security recovery package" },
  { id: "component.connector-governance", version: "v1:c1.r1", lifecycle: "active", authority: "Connector governance" }
]);

export const RISK_CONTROL_FACT_SOURCE_CATALOG = freezeEntries("v0.0.1:strategy:risk-control-fact-source-1", [
  { id: "fact.mcp-grant", version: "v1:f1.r1", lifecycle: "active", authority: "MCP grant record" },
  { id: "fact.console-session", version: "v1:f1.r1", lifecycle: "active", authority: "Console session store" },
  { id: "fact.tool-grant-store", version: "v1:f1.r1", lifecycle: "active", authority: "Tool grant store" },
  { id: "fact.capability-kernel", version: "v1:f1.r1", lifecycle: "active", authority: "Capability Kernel credential state" },
  { id: "fact.binding-ledger", version: "v1:f1.r1", lifecycle: "active", authority: "Capability binding ledger" },
  { id: "fact.operation-registry", version: "v1:f1.r1", lifecycle: "active", authority: "Operation Registry" },
  { id: "fact.authorization-policy", version: "v1:f1.r1", lifecycle: "active", authority: "Authorization and policy stores" },
  { id: "fact.egress-policy", version: "v1:f1.r1", lifecycle: "active", authority: "Outbound egress policy" },
  { id: "fact.operation-proof", version: "v1:f1.r1", lifecycle: "active", authority: "Operation Proof Substrate" },
  { id: "fact.audit-store", version: "v1:f1.r1", lifecycle: "active", authority: "Audit stores" },
  { id: "fact.checkpoint-tree", version: "v1:f1.r1", lifecycle: "active", authority: "Checkpoint Tree" },
  { id: "fact.secret-store", version: "v1:f1.r1", lifecycle: "active", authority: "SecretStore" },
  { id: "fact.provider-receipt", version: "v1:f1.r1", lifecycle: "active", authority: "Provider receipt or webhook proof" },
  { id: "fact.runtime-health", version: "v1:f1.r1", lifecycle: "active", authority: "Runtime health and capacity facts" }
]);

export const RISK_CONTROL_VERIFIER_CATALOG = freezeEntries("v0.0.1:strategy:risk-control-verifier-1", [
  { id: "verifier.risk-control.registry-integrity", version: "v1:v1.r1", lifecycle: "active", authority: "server:scripts:verify-risk-control-model" },
  { id: "verifier.risk-control.operation-envelope", version: "v1:v1.r1", lifecycle: "active", authority: "operation envelope hash-chain verifier" },
  { id: "verifier.risk-control.evidence-locator", version: "v1:v1.r1", lifecycle: "active", authority: "evidence locator verifier" },
  { id: "verifier.security.authorization-capabilities", version: "v1:v1.r1", lifecycle: "active", authority: "server:verify:authorization-capabilities" },
  { id: "verifier.security.console-auth", version: "v1:v1.r1", lifecycle: "active", authority: "server:verify:console-auth" },
  { id: "verifier.security.operation-permission", version: "v1:v1.r1", lifecycle: "active", authority: "tools/server-scripts/verify-operation-permission-platform.mjs" },
  { id: "verifier.security.mcp-http", version: "v1:v1.r1", lifecycle: "active", authority: "server:verify:mcp-http" },
  { id: "verifier.security.security-hardening", version: "v1:v1.r1", lifecycle: "active", authority: "server:verify:security-hardening" },
  { id: "verifier.platform-managed-migration.completion", version: "v1:v1.r1", lifecycle: "active", authority: "Platform Managed Migration completion verifier" }
]);

export const RISK_CONTROL_EVIDENCE_PROFILE_CATALOG = freezeEntries("v0.0.1:strategy:risk-control-evidence-governance-profile-1", [
  { id: "profile.classification.internal", version: "v1:p1.l1.c1.r1", lifecycle: "active", kind: "classification", semantics: "internal audit evidence" },
  { id: "profile.redaction.standard", version: "v1:p1.l1.c1.r1", lifecycle: "active", kind: "redaction-policy", semantics: "redact secrets, tokens, paths, raw headers, and provider debug payloads" },
  { id: "profile.retention.audit-standard", version: "v1:p1.l1.c1.r1", lifecycle: "active", kind: "retention", semantics: "retain enough evidence for audit, recovery, and replay diagnosis" }
]);

export const RISK_CONTROL_EVIDENCE_STORE_CATALOG = freezeEntries("v0.0.1:strategy:risk-control-evidence-store-1", [
  {
    id: "store.operation-audit",
    version: "v1:s1.l1.c1.r1",
    lifecycle: "active",
    authority: "Operation audit store",
    allowedProfiles: ["profile.classification.internal", "profile.redaction.standard", "profile.retention.audit-standard"]
  },
  {
    id: "store.operation-proof",
    version: "v1:s1.l1.c1.r1",
    lifecycle: "active",
    authority: "Operation Proof Substrate",
    allowedProfiles: ["profile.classification.internal", "profile.redaction.standard", "profile.retention.audit-standard"]
  },
  {
    id: "store.checkpoint-tree",
    version: "v1:s1.l1.c1.r1",
    lifecycle: "active",
    authority: "Checkpoint Tree",
    allowedProfiles: ["profile.classification.internal", "profile.redaction.standard", "profile.retention.audit-standard"]
  }
]);

function byId(entries) {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

export const RISK_CONTROL_CATALOGS = Object.freeze({
  enforcedBy: RISK_CONTROL_COMPONENT_CATALOG,
  factSource: RISK_CONTROL_FACT_SOURCE_CATALOG,
  verifiedBy: RISK_CONTROL_VERIFIER_CATALOG,
  evidenceStore: RISK_CONTROL_EVIDENCE_STORE_CATALOG,
  evidenceProfile: RISK_CONTROL_EVIDENCE_PROFILE_CATALOG
});

export const RISK_CONTROL_CATALOG_INDEXES = Object.freeze({
  enforcedBy: byId(RISK_CONTROL_COMPONENT_CATALOG),
  factSource: byId(RISK_CONTROL_FACT_SOURCE_CATALOG),
  verifiedBy: byId(RISK_CONTROL_VERIFIER_CATALOG),
  evidenceStore: byId(RISK_CONTROL_EVIDENCE_STORE_CATALOG),
  evidenceProfile: byId(RISK_CONTROL_EVIDENCE_PROFILE_CATALOG)
});

export function activeCatalogRef(kind, id) {
  const entry = RISK_CONTROL_CATALOG_INDEXES[kind]?.get(id);
  if (!entry) {
    throw new Error(`Unknown Risk Control ${kind} catalog entry: ${id}`);
  }
  if (entry.lifecycle !== "active") {
    throw new Error(`Risk Control ${kind} catalog entry is not active: ${id}`);
  }
  return Object.freeze({
    id: entry.id,
    version: entry.version,
    digest: entry.digest
  });
}
