import {
  RISK_CONTROL_BOUNDARY_IDS,
  RISK_CONTROL_ENVIRONMENT_IDS,
  RISK_CONTROL_MODEL_VERSION,
  RISK_CONTROL_OBJECT_IDS
} from "../model/index.ts";
import { activeCatalogRef } from "../catalogs/index.ts";
import { defineRiskControlPoint } from "../registry/dsl.ts";

const DEFAULT_VERIFIERS: readonly any[] = Object.freeze([
  activeCatalogRef("verifiedBy", "verifier.risk-control.registry-integrity"),
  activeCatalogRef("verifiedBy", "verifier.risk-control.evidence-locator")
]);

const SPECIFIC_VERIFIERS: Readonly<Record<string, any>> = Object.freeze({
  "verifier.security.authorization-capabilities": activeCatalogRef("verifiedBy", "verifier.security.authorization-capabilities"),
  "verifier.security.console-auth": activeCatalogRef("verifiedBy", "verifier.security.console-auth"),
  "verifier.security.operation-permission": activeCatalogRef("verifiedBy", "verifier.security.operation-permission"),
  "verifier.security.mcp-http": activeCatalogRef("verifiedBy", "verifier.security.mcp-http"),
  "verifier.security.security-hardening": activeCatalogRef("verifiedBy", "verifier.security.security-hardening"),
  "verifier.risk-control.operation-envelope": activeCatalogRef("verifiedBy", "verifier.risk-control.operation-envelope")
});

function owner(boundaryId?: any, objectId?: any) : any {
  return {
    boundaryId,
    environmentId: RISK_CONTROL_ENVIRONMENT_IDS.PLATFORM_RUNTIME,
    objectId
  };
}

function refs({ enforcedBy, factSource, verifiedBy = [] }: Record<string, any>) : any {
  return {
    enforcedBy: activeCatalogRef("enforcedBy", enforcedBy),
    factSource: activeCatalogRef("factSource", factSource),
    verifiedBy: [
      ...DEFAULT_VERIFIERS,
      ...verifiedBy.map((id?: any) : any => SPECIFIC_VERIFIERS[id] || activeCatalogRef("verifiedBy", id))
    ]
  };
}

function control(spec?: any) : any {
  return defineRiskControlPoint({
    definitionVersion: RISK_CONTROL_MODEL_VERSION,
    lifecycleState: "active",
    owner: owner(spec.boundaryId, spec.objectId),
    gate: spec.gate,
    controlId: spec.controlId,
    displayName: spec.displayName,
    description: spec.description || spec.displayName,
    binds: spec.binds || [],
    decision: {
      allow: true,
      deny: true,
      needsApproval: spec.gate === "approve",
      degraded: spec.degraded === true
    },
    failsClosed: {
      reasonCode: spec.reasonCode || `${spec.controlId.replace(/[^a-z0-9]+/g, "_")}_failed`,
      status: spec.status || 403
    },
    evidence: {
      requiredFields: spec.evidenceFields || ["traceId", "controlRef", "decision", "reasonCode"]
    },
    ...refs(spec)
  });
}

const CLIENT: any = RISK_CONTROL_BOUNDARY_IDS.CLIENT_MCP_INGRESS;
const SERVER: any = RISK_CONTROL_BOUNDARY_IDS.SERVER_API_EGRESS;
const PLATFORM: any = RISK_CONTROL_BOUNDARY_IDS.PLATFORM_SELF;
const IDENTITY: any = RISK_CONTROL_OBJECT_IDS.IDENTITY_ADMISSION_AUTHENTICATION;
const POLICY: any = RISK_CONTROL_OBJECT_IDS.PERMISSION_BEHAVIOR_POLICY;
const DATA: any = RISK_CONTROL_OBJECT_IDS.DATA_STATE_SEMANTICS;
const TRAFFIC: any = RISK_CONTROL_OBJECT_IDS.TRAFFIC_RESOURCE_MANAGEMENT;
const AUDIT: any = RISK_CONTROL_OBJECT_IDS.AUDIT_FACT_VERIFICATION;

export const RISK_CONTROL_POINTS: readonly any[] = Object.freeze([
  control({
    boundaryId: CLIENT,
    objectId: IDENTITY,
    gate: "admit",
    controlId: "client.registration.admit",
    displayName: "client registration",
    enforcedBy: "component.mcp-adapter",
    factSource: "fact.mcp-grant",
    verifiedBy: ["verifier.security.mcp-http"],
    binds: ["client", "credential"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: IDENTITY,
    gate: "bind",
    controlId: "client.agent-identity.bind",
    displayName: "agent identity",
    enforcedBy: "component.mcp-adapter",
    factSource: "fact.mcp-grant",
    verifiedBy: ["verifier.security.mcp-http"],
    binds: ["subject", "agentProfile"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: IDENTITY,
    gate: "bind",
    controlId: "client.operator-identity.bind",
    displayName: "user/operator identity",
    enforcedBy: "component.console-auth",
    factSource: "fact.console-session",
    verifiedBy: ["verifier.security.console-auth"],
    binds: ["subject", "session"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: IDENTITY,
    gate: "bind",
    controlId: "client.device-runtime.bind",
    displayName: "device/runtime identity",
    enforcedBy: "component.mcp-adapter",
    factSource: "fact.mcp-grant",
    verifiedBy: ["verifier.security.mcp-http"],
    binds: ["device", "runtime"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: IDENTITY,
    gate: "authorize",
    controlId: "client.mcp-grant.authorize",
    displayName: "MCP grant",
    enforcedBy: "component.operation-permission",
    factSource: "fact.tool-grant-store",
    verifiedBy: ["verifier.security.operation-permission"],
    binds: ["grant", "scopes"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: IDENTITY,
    gate: "bind",
    controlId: "client.opaque-key.bind",
    displayName: "opaque key binding",
    enforcedBy: "component.binding-guard",
    factSource: "fact.binding-ledger",
    verifiedBy: ["verifier.security.operation-permission"],
    binds: ["capabilityKey", "subject"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: IDENTITY,
    gate: "audit-recover",
    controlId: "client.token-session-rotation.audit",
    displayName: "token/session rotation",
    enforcedBy: "component.console-auth",
    factSource: "fact.console-session",
    verifiedBy: ["verifier.security.console-auth"],
    binds: ["session", "credentialFamily"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: IDENTITY,
    gate: "admit",
    controlId: "client.discovery-trust.admit",
    displayName: "discovery trust",
    enforcedBy: "component.mcp-adapter",
    factSource: "fact.operation-registry",
    verifiedBy: ["verifier.security.mcp-http"],
    binds: ["toolProjection", "grant"]
  }),

  control({
    boundaryId: CLIENT,
    objectId: POLICY,
    gate: "authorize",
    controlId: "client.operation-permission.authorize",
    displayName: "operation permission",
    enforcedBy: "component.operation-dispatcher",
    factSource: "fact.authorization-policy",
    verifiedBy: ["verifier.security.authorization-capabilities"],
    binds: ["operation", "subject"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: POLICY,
    gate: "authorize",
    controlId: "client.tool-skill-permission.authorize",
    displayName: "tool/skill permission",
    enforcedBy: "component.operation-permission",
    factSource: "fact.tool-grant-store",
    verifiedBy: ["verifier.security.operation-permission"],
    binds: ["tool", "skill", "grant"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: POLICY,
    gate: "authorize",
    controlId: "client.workspace-scope.authorize",
    displayName: "workspace scope",
    enforcedBy: "component.operation-policy",
    factSource: "fact.authorization-policy",
    verifiedBy: ["verifier.security.authorization-capabilities"],
    binds: ["workspace", "subject"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: POLICY,
    gate: "authorize",
    controlId: "client.data-class.authorize",
    displayName: "dataClass policy",
    enforcedBy: "component.operation-policy",
    factSource: "fact.authorization-policy",
    verifiedBy: ["verifier.security.authorization-capabilities"],
    binds: ["dataClass", "operation"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: POLICY,
    gate: "authorize",
    controlId: "client.egress-policy.authorize",
    displayName: "egress policy",
    enforcedBy: "component.operation-policy",
    factSource: "fact.egress-policy",
    binds: ["egress", "operation"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: POLICY,
    gate: "approve",
    controlId: "client.high-risk-confirmation.approve",
    displayName: "high-risk confirmation",
    enforcedBy: "component.operation-policy",
    factSource: "fact.operation-proof",
    verifiedBy: ["verifier.risk-control.operation-envelope"],
    binds: ["pendingOperation", "approval"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: POLICY,
    gate: "admit",
    controlId: "client.capability-discovery.admit",
    displayName: "capability discovery",
    enforcedBy: "component.mcp-adapter",
    factSource: "fact.operation-registry",
    verifiedBy: ["verifier.security.mcp-http"],
    binds: ["grant", "projection"]
  }),
  control({
    boundaryId: CLIENT,
    objectId: POLICY,
    gate: "authorize",
    controlId: "client.deny-semantics.authorize",
    displayName: "deny semantics",
    enforcedBy: "component.operation-dispatcher",
    factSource: "fact.authorization-policy",
    verifiedBy: ["verifier.security.authorization-capabilities"],
    binds: ["decision", "reasonCode"]
  }),

  ...[
    ["client.upload-semantics.execute", "upload semantics"],
    ["client.file-validation.execute", "file validation"],
    ["client.path-safety.execute", "path safety"],
    ["client.context-semantics.execute", "context semantics"],
    ["client.export-download-semantics.execute", "export/download semantics"],
    ["client.asset-lifecycle.execute", "asset lifecycle"],
    ["client.lifecycle-state.execute", "client lifecycle state"],
    ["client.local-bridge-transport.execute", "local bridge transport semantics"]
  ].map(([controlId, displayName]: any[]) : any => control({
    boundaryId: CLIENT,
    objectId: DATA,
    gate: "execute",
    controlId,
    displayName,
    enforcedBy: "component.operation-dispatcher",
    factSource: "fact.operation-proof",
    verifiedBy: ["verifier.risk-control.operation-envelope"],
    binds: ["resource", "state"]
  })),

  ...[
    ["client.qps-burst.execute", "QPS/burst"],
    ["client.concurrency.execute", "concurrency"],
    ["client.upload-bandwidth.execute", "upload bandwidth"],
    ["client.storage-quota.execute", "storage quota"],
    ["client.context-quota.execute", "context quota"],
    ["client.runtime-distribution.execute", "runtime distribution"],
    ["client.retry-backoff.execute", "retry/backoff"]
  ].map(([controlId, displayName]: any[]) : any => control({
    boundaryId: CLIENT,
    objectId: TRAFFIC,
    gate: "execute",
    controlId,
    displayName,
    enforcedBy: "component.quota-bulkhead",
    factSource: "fact.runtime-health",
    verifiedBy: ["verifier.security.security-hardening"],
    binds: ["subject", "quota"]
  })),

  ...[
    ["client.access-receipt.audit", "access receipt"],
    ["client.loan-record.audit", "loan record"],
    ["client.denied-request.audit", "denied request"],
    ["client.trace-log-redaction.audit", "trace/log redaction"],
    ["client.checkpoint-node.audit", "checkpoint node"],
    ["client.recovery-evidence.audit", "recovery evidence"]
  ].map(([controlId, displayName]: any[]) : any => control({
    boundaryId: CLIENT,
    objectId: AUDIT,
    gate: "audit-recover",
    controlId,
    displayName,
    enforcedBy: "component.audit-store",
    factSource: "fact.audit-store",
    verifiedBy: ["verifier.security.security-hardening"],
    binds: ["trace", "evidence"]
  })),

  ...[
    ["server.upstream-service.admit", "upstream service admission", "component.connector-governance", "fact.operation-registry", "admit"],
    ["server.provider-credential.bind", "provider credential binding", "component.secret-store", "fact.secret-store", "bind"],
    ["server.provider-receipt.audit", "provider receipt audit", "component.audit-store", "fact.provider-receipt", "audit-recover"]
  ].map(([controlId, displayName, enforcedBy, factSource, gate]: any[]) : any => control({
    boundaryId: SERVER,
    objectId: IDENTITY,
    gate,
    controlId,
    displayName,
    enforcedBy,
    factSource,
    verifiedBy: ["verifier.security.security-hardening"],
    binds: ["provider", "credential", "receipt"]
  })),

  ...[
    ["server.egress-policy.authorize", "server egress policy", "component.operation-policy", "fact.egress-policy"],
    ["server.capability-route.authorize", "capability route authorization", "component.capability-kernel", "fact.capability-kernel"]
  ].map(([controlId, displayName, enforcedBy, factSource]: any[]) : any => control({
    boundaryId: SERVER,
    objectId: POLICY,
    gate: "authorize",
    controlId,
    displayName,
    enforcedBy,
    factSource,
    verifiedBy: ["verifier.security.authorization-capabilities"],
    binds: ["operation", "provider", "route"]
  })),

  ...[
    ["server.response-normalization.execute", "response normalization"],
    ["server.provider-state-semantics.execute", "provider state semantics"]
  ].map(([controlId, displayName]: any[]) : any => control({
    boundaryId: SERVER,
    objectId: DATA,
    gate: "execute",
    controlId,
    displayName,
    enforcedBy: "component.operation-dispatcher",
    factSource: "fact.provider-receipt",
    verifiedBy: ["verifier.risk-control.operation-envelope"],
    binds: ["providerResponse", "state"]
  })),

  ...[
    ["server.rate-limit.execute", "provider rate limit"],
    ["server.timeout-retry.execute", "provider timeout and retry"]
  ].map(([controlId, displayName]: any[]) : any => control({
    boundaryId: SERVER,
    objectId: TRAFFIC,
    gate: "execute",
    controlId,
    displayName,
    enforcedBy: "component.runtime-capacity",
    factSource: "fact.runtime-health",
    verifiedBy: ["verifier.security.security-hardening"],
    binds: ["provider", "quota", "retry"]
  })),

  ...[
    ["server.egress-audit.audit", "server egress audit"],
    ["server.redacted-provider-log.audit", "redacted provider log"]
  ].map(([controlId, displayName]: any[]) : any => control({
    boundaryId: SERVER,
    objectId: AUDIT,
    gate: "audit-recover",
    controlId,
    displayName,
    enforcedBy: "component.audit-store",
    factSource: "fact.audit-store",
    verifiedBy: ["verifier.security.security-hardening"],
    binds: ["trace", "providerReceipt", "redaction"]
  })),

  ...[
    ["platform.console-auth.admit", "Console Auth", "component.console-auth", "fact.console-session", "admit"],
    ["platform.secret-store.bind", "SecretStore", "component.secret-store", "fact.secret-store", "bind"],
    ["platform.binding-guard.bind", "Binding Guard", "component.binding-guard", "fact.binding-ledger", "bind"],
    ["platform.capability-kernel.authorize", "Capability Kernel", "component.capability-kernel", "fact.capability-kernel", "authorize"],
    ["platform.credential-redaction.audit", "credential redaction", "component.audit-store", "fact.audit-store", "audit-recover"]
  ].map(([controlId, displayName, enforcedBy, factSource, gate]: any[]) : any => control({
    boundaryId: PLATFORM,
    objectId: IDENTITY,
    gate,
    controlId,
    displayName,
    enforcedBy,
    factSource,
    verifiedBy: ["verifier.security.console-auth", "verifier.security.operation-permission"],
    binds: ["subject", "credential"]
  })),

  ...[
    ["platform.capability-manifest.authorize", "Capability manifest", "component.capability-kernel", "fact.operation-registry"],
    ["platform.capability-verify.authorize", "Capability Kernel verify", "component.capability-kernel", "fact.capability-kernel"],
    ["platform.binding-verify.authorize", "Binding Guard verify", "component.binding-guard", "fact.binding-ledger"],
    ["platform.operation-policy.authorize", "Operation Policy", "component.operation-policy", "fact.authorization-policy"],
    ["platform.operation-permission.authorize", "Operation Permission", "component.operation-permission", "fact.tool-grant-store"],
    ["platform.risk-policy.approve", "risk policy", "component.operation-policy", "fact.operation-proof"]
  ].map(([controlId, displayName, enforcedBy, factSource]: any[]) : any => control({
    boundaryId: PLATFORM,
    objectId: POLICY,
    gate: controlId.endsWith(".approve") ? "approve" : "authorize",
    controlId,
    displayName,
    enforcedBy,
    factSource,
    verifiedBy: ["verifier.security.authorization-capabilities", "verifier.security.operation-permission"],
    binds: ["operation", "capability", "policy"]
  })),

  ...[
    ["platform.canonical-state.execute", "Meshrix canonical state"],
    ["platform.operation-proof.execute", "Operation Proof Substrate"],
    ["platform.state-commit.execute", "StateCommit"],
    ["platform.cas-merkle-state.execute", "CAS/Merkle state"],
    ["platform.checkpoint-tree.execute", "Checkpoint Tree"],
    ["platform.state-vocabulary.execute", "state vocabulary"],
    ["platform.security-recovery-lifecycle.execute", "security recovery lifecycle"]
  ].map(([controlId, displayName]: any[]) : any => control({
    boundaryId: PLATFORM,
    objectId: DATA,
    gate: "execute",
    controlId,
    displayName,
    enforcedBy: "component.operation-proof-substrate",
    factSource: "fact.operation-proof",
    verifiedBy: ["verifier.risk-control.operation-envelope"],
    binds: ["state", "operation"]
  })),

  ...[
    ["platform.budget-policy.execute", "Budget Policy"],
    ["platform.queue-control.execute", "queue control"],
    ["platform.durable-workflow.execute", "durable workflow"],
    ["platform.performance-capacity.execute", "performance capacity gate"],
    ["platform.idempotency.execute", "idempotency"]
  ].map(([controlId, displayName]: any[]) : any => control({
    boundaryId: PLATFORM,
    objectId: TRAFFIC,
    gate: "execute",
    controlId,
    displayName,
    enforcedBy: controlId.includes("queue") || controlId.includes("workflow") ? "component.runtime-queue" : "component.runtime-capacity",
    factSource: "fact.runtime-health",
    verifiedBy: ["verifier.security.security-hardening"],
    binds: ["resource", "budget"]
  })),

  ...[
    ["platform.audit.audit", "Audit", "component.audit-store", "fact.audit-store"],
    ["platform.operation-proof.audit", "Operation Proof Substrate", "component.operation-proof-substrate", "fact.operation-proof"],
    ["platform.checkpoint-tree.audit", "Checkpoint Tree", "component.checkpoint-tree", "fact.checkpoint-tree"],
    ["platform.runtime-logger.audit", "runtime logger", "component.audit-store", "fact.audit-store"],
    ["platform.production-readiness-report.audit", "production readiness report", "component.audit-store", "fact.audit-store"],
    ["platform.security-recovery-package.audit", "security recovery package", "component.recovery-package", "fact.checkpoint-tree"]
  ].map(([controlId, displayName, enforcedBy, factSource]: any[]) : any => control({
    boundaryId: PLATFORM,
    objectId: AUDIT,
    gate: "audit-recover",
    controlId,
    displayName,
    enforcedBy,
    factSource,
    verifiedBy: ["verifier.security.security-hardening"],
    binds: ["audit", "recovery"]
  }))
]);

export function riskControlById() : any {
  return new Map<any, any>(RISK_CONTROL_POINTS.map((controlPoint?: any) : any => [controlPoint.controlId, controlPoint]));
}
