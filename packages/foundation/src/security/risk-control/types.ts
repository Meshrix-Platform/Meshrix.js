export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue; }

export interface CatalogRef {
  id: string;
  version: string;
  digest: string;
}

export interface CatalogEntry extends CatalogRef {
  lifecycle: string;
  authority?: string;
  kind?: string;
  semantics?: string;
  allowedProfiles?: readonly string[];
}

export type CatalogKind = "enforcedBy" | "factSource" | "verifiedBy" | "evidenceStore" | "evidenceProfile";

export interface RiskControlOwner {
  boundaryId: string;
  environmentId: string;
  objectId: string;
}

export interface RiskControlDecision {
  allow: boolean;
  deny: boolean;
  needsApproval: boolean;
  degraded: boolean;
}

export interface RiskControlEvidence {
  store: CatalogRef;
  classificationProfile: CatalogRef;
  redactionPolicyProfile: CatalogRef;
  retentionProfile: CatalogRef;
  requiredFields: string[];
  locatorRequired: boolean;
}

export interface RiskControlPoint {
  controlId: string;
  definitionVersion: string;
  lifecycleState: string;
  owner: RiskControlOwner;
  gate: string;
  enforcedBy: CatalogRef;
  factSource: CatalogRef;
  binds: string[];
  decision: RiskControlDecision;
  failsClosed: { reasonCode: string; status: number };
  evidence: RiskControlEvidence;
  verifiedBy: CatalogRef[];
  displayName: string;
  description: string;
  docsUrl: string;
  sortOrder: number;
  definitionDigest: string;
}

export interface RiskControlPath {
  pathId: string;
  label: string;
  controls: readonly string[];
}

export interface RiskControlBoundary {
  id: string;
  label: string;
  fromEnvironmentId: string;
  toEnvironmentId: string;
  riskOwner: string;
  trustAssumption: string;
}

export interface RiskControlEnvironment { id: string; label: string; role: string; }
export interface RiskControlObject { id: string; label: string; question: string; outcome: string; }

export interface RiskControlGateRecord {
  recordVersion: string;
  envelopeId: string;
  previousRecordDigest: string;
  controlRef: { controlId: string; definitionVersion: string; definitionDigest: string };
  gate: string;
  decision: string;
  reasonCode: string;
  subject: unknown;
  intent: string;
  resource: unknown;
  environment: unknown;
  enforcedBy: CatalogRef;
  factSource: CatalogRef;
  evidence: unknown;
  occurredAt: string;
  recordDigest: string;
}

export interface RiskControlOperationEnvelope {
  envelopeVersion: string;
  operationId: string;
  traceId: string;
  inputHash: string;
  operationAnchorDigest: string;
  gateRecords: RiskControlGateRecord[];
}
