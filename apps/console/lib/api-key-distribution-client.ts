import { getJson, postJson } from "@meshrix/ui-console/bridge-http";

export type ApiKeyStatus = "active" | "revoked" | "expired" | "exhausted";
export type ApiKeyScopeMode = "restricted" | "unrestricted";

export interface ApiKeyIssuerNode {
  nodeId: string;
  name: string;
  breadcrumb: string[];
  nodeType: string;
}

export interface ApiKeyIssuerScopes {
  organizationRevision: number;
  authorizationRevision: number;
  authorizationUpdatedAt?: string;
  catalogFingerprint: string;
  serverAudience?: string;
  eligibleRoots: ApiKeyIssuerNode[];
  eligibleNodes: ApiKeyIssuerNode[];
}

export interface ApiKeyPolicy {
  protocol: "mcp";
  serviceIds: string[];
  capabilityIds: string[];
  toolsetIds: string[];
  allowedTools: string[];
  deniedTools: string[];
  scopeIds: string[];
  maximumRisk: "low" | "medium" | "high";
  audience: {
    serverAudience: string;
    targetIds: string[];
    connectorPackageIds: string[];
  };
  resources: {
    mode: ApiKeyScopeMode;
    workspaceIds: string[];
    dataClassifications: string[];
    egressClasses: string[];
    semanticFamilies: string[];
    capabilityDomains: string[];
    capabilityVerbs: string[];
    resourceKinds: string[];
    effectKinds: string[];
    secretBindingIds: string[];
    allowedOrigins: string[];
    allowedCidrs: string[];
  };
  processIdentity:
    | { mode: "optional" }
    | { mode: "required"; allowedPublicKeyFingerprints: string[] };
  limits: {
    maxUses: number;
    requestsPerWindow: number;
    windowSeconds: number;
    maxConcurrentEffects: number;
  };
  catalogFingerprint: string;
}

export interface ApiKeyRecord {
  keyId: string;
  displayPrefix: string;
  credentialFingerprint: string;
  workloadPrincipalId: string;
  workloadDisplayName: string;
  organizationNodeId: string;
  organizationBreadcrumb?: string[];
  policy: ApiKeyPolicy;
  policyFingerprint: string;
  status: ApiKeyStatus;
  lifecycleRevision: number;
  useCount: number;
  createdAt: string;
  rotatedAt: string | null;
  revokedAt: string | null;
  expiresAt: string;
}

export interface ApiKeyPage {
  records: ApiKeyRecord[];
  nextCursor: string | null;
}

export interface ApiKeyCreateInput {
  workloadDisplayName: string;
  organizationNodeId: string;
  expiresAt: string;
  policy: ApiKeyPolicy;
}

export interface ApiKeyOneTimeResult {
  record: ApiKeyRecord;
  apiKey: string;
}

const ENDPOINT = "/api/operation-permission/v1/api-keys";

function encodePathSegment(value: string): string {
  return encodeURIComponent(String(value || "").trim());
}

export function getApiKeyIssuerScopes(): Promise<ApiKeyIssuerScopes> {
  return getJson<ApiKeyIssuerScopes>(`${ENDPOINT}/issuer-scopes`);
}

export function listApiKeys(input: {
  status?: ApiKeyStatus | "";
  organizationNodeId?: string;
  cursor?: string;
  limit?: number;
} = {}): Promise<ApiKeyPage> {
  const query = new URLSearchParams();
  if (input.status) query.set("status", input.status);
  if (input.organizationNodeId) query.set("organizationNodeId", input.organizationNodeId);
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.limit) query.set("limit", String(input.limit));
  const suffix = query.size ? `?${query.toString()}` : "";
  return getJson<{ items: ApiKeyRecord[]; nextCursor: string }>(`${ENDPOINT}${suffix}`).then((page) => ({
    records: Array.isArray(page.items) ? page.items : [],
    nextCursor: page.nextCursor || null,
  }));
}

export function createApiKey(input: ApiKeyCreateInput): Promise<ApiKeyOneTimeResult> {
  return postJson<ApiKeyOneTimeResult>(ENDPOINT, input, { safetyConfirm: true });
}

export function rotateApiKey(keyId: string, expectedLifecycleRevision: number): Promise<ApiKeyOneTimeResult> {
  return postJson<ApiKeyOneTimeResult>(`${ENDPOINT}/${encodePathSegment(keyId)}/rotate`, {
    expectedLifecycleRevision,
  }, { safetyConfirm: true });
}

export function revokeApiKey(
  keyId: string,
  expectedLifecycleRevision: number,
  reasonCode: "administrator_revoked" = "administrator_revoked",
): Promise<ApiKeyRecord> {
  return postJson<ApiKeyRecord>(`${ENDPOINT}/${encodePathSegment(keyId)}/revoke`, {
    expectedLifecycleRevision,
    reasonCode,
  }, { safetyConfirm: true });
}
