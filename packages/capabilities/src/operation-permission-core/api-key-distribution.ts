import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  API_KEY_MANAGEMENT_ACTION,
  assertApiKeyIssuerTarget,
  evaluateApiKeyIssuerScopes,
  organizationLineage,
  organizationLineageDigest
} from "@meshrix/foundation/security/authorization/api-key-issuer-authority";

export const API_KEY_CREDENTIAL_VERSION = "mxak1";
export const API_KEY_CREDENTIAL_PATTERN = /^mxak1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/u;
export const API_KEY_STATUSES = Object.freeze(["active", "revoked", "expired", "exhausted"] as const);

export function reconcileApiKeyOwnerRecoveryAssignments({
  securityPermissions = null
}: Record<string, any> = {}): void {
  const governanceStore: any = securityPermissions?.authorizationGovernanceStore || null;
  if (!governanceStore?.upsertApiKeyRecoveryAssignment ||
      !governanceStore?.listApiKeyRecoveryAssignments) return;
  const organization: any = securityPermissions?.getOrganizationGovernance?.();
  const roots: any[] = organization?.configured === true
    ? (organization.nodes || []).filter((node?: any) : any => !String(node?.parentId || ""))
    : [];
  if (roots.length !== 1) return;
  const rootNodeId: any = String(roots[0]?.nodeId || "").trim();
  if (!rootNodeId) return;
  const assignments: any[] = governanceStore.listApiKeyRecoveryAssignments() || [];
  for (const user of securityPermissions?.listUsers?.() || []) {
    const subjectId: any = String(user?.userId || "").trim();
    if (!subjectId || user?.enabled === false || user?.roleId !== "owner") continue;
    const current: any = assignments.find((assignment?: any) : any =>
      assignment?.subjectId === subjectId &&
      assignment?.rootNodeId === rootNodeId &&
      assignment?.action === API_KEY_MANAGEMENT_ACTION
    );
    if (current?.enabled === true && current?.serverAuthored === true) continue;
    governanceStore.upsertApiKeyRecoveryAssignment({
      subjectId,
      rootNodeId,
      action: API_KEY_MANAGEMENT_ACTION,
      enabled: true
    });
  }
}

export function registerApiKeyOwnerRecoveryAssignmentSync({
  securityPermissions = null
}: Record<string, any> = {}): () => void {
  const governanceStore: any = securityPermissions?.authorizationGovernanceStore || null;
  const tagStore: any = securityPermissions?.tagManagementStore || null;
  if (!governanceStore?.upsertApiKeyRecoveryAssignment ||
      !governanceStore?.listApiKeyRecoveryAssignments) {
    return () : void => {};
  }

  const reconcile: any = () : void => {
    try {
      reconcileApiKeyOwnerRecoveryAssignments({ securityPermissions });
    } catch {
      // Issuer-scope requests remain fail-closed until organization governance can be reconciled.
    }
  };

  reconcile();
  const unsubscribe: any = tagStore?.registerChangeHandler?.((event?: any) : void => {
    if (event?.eventType === "organization-governance-published") reconcile();
  });
  return typeof unsubscribe === "function" ? unsubscribe : () : void => {};
}

export class ApiKeyDistributionError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ApiKeyDistributionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code: string, message: string, statusCode = 400): never {
  throw new ApiKeyDistributionError(code, message, statusCode);
}

function object(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as any)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function exactKeys(value: any, keys: readonly string[], path = "input"): void {
  if (!object(value)) fail("api_key_input_invalid", `${path} must be an object.`);
  const allowed: any = new Set(keys);
  if (Object.keys(value).some((key?: any) : any => !allowed.has(key))) {
    fail("api_key_input_invalid", `${path} contains an unknown field.`);
  }
}

function text(value: any, path: string, maximum = 256): string {
  if (typeof value !== "string") fail("api_key_input_invalid", `${path} must be a string.`);
  const normalized: any = value.trim().normalize("NFC");
  if (!normalized || normalized.length > maximum || /\p{Cc}/u.test(normalized)) {
    fail("api_key_input_invalid", `${path} is invalid.`);
  }
  return normalized;
}

function positiveInteger(value: any, path: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("api_key_input_invalid", `${path} must be a positive integer.`);
  }
  return value;
}

function stringList(value: any, path: string, maximum = 256): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    fail("api_key_input_invalid", `${path} must be a bounded array.`);
  }
  const normalized: any[] = value.map((entry?: any) : any => text(entry, path, 512));
  if (new Set(normalized).size !== normalized.length) {
    fail("api_key_input_invalid", `${path} contains duplicate values.`);
  }
  return normalized.sort();
}

function digest(value: any): string {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("base64url");
}

function parseBase64Url(value: string, expectedBytes: number): Buffer | null {
  try {
    const decoded: any = Buffer.from(value, "base64url");
    return decoded.length === expectedBytes && decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

export function parseApiKeyCredential(credential: any): any {
  if (typeof credential !== "string" || credential.length !== 72 || credential.trim() !== credential) {
    return null;
  }
  const match: any = credential.match(API_KEY_CREDENTIAL_PATTERN);
  if (!match || !parseBase64Url(match[1], 16) || !parseBase64Url(match[2], 32)) return null;
  return Object.freeze({ keyId: match[1], secret: match[2] });
}

function verifierDigest(key: Buffer, keyId: string, secret: string): Buffer {
  if (!Buffer.isBuffer(key) || key.length < 32) {
    fail("api_key_authority_unavailable", "API Key verifier generation is unavailable.", 503);
  }
  return crypto.createHmac("sha256", key)
    .update("meshrix-api-key:v1", "utf8")
    .update(keyId, "ascii")
    .update(secret, "ascii")
    .digest();
}

function normalizePolicy(input: any, registry: any): any {
  exactKeys(input, [
    "protocol", "serviceIds", "capabilityIds", "toolsetIds", "allowedTools", "deniedTools",
    "scopeIds", "maximumRisk", "audience", "resources", "processIdentity", "limits", "catalogFingerprint"
  ], "policy");
  if (input.protocol !== "mcp" || !["low", "medium", "high"].includes(input.maximumRisk)) {
    fail("api_key_input_invalid", "API Key policy protocol or risk is invalid.");
  }
  exactKeys(input.audience, ["serverAudience", "targetIds", "connectorPackageIds"], "policy.audience");
  exactKeys(input.resources, [
    "mode", "workspaceIds", "dataClassifications", "egressClasses", "semanticFamilies",
    "capabilityDomains", "capabilityVerbs", "resourceKinds", "effectKinds", "secretBindingIds",
    "allowedOrigins", "allowedCidrs"
  ], "policy.resources");
  exactKeys(input.processIdentity,
    input.processIdentity?.mode === "required" ? ["mode", "allowedPublicKeyFingerprints"] : ["mode"],
    "policy.processIdentity");
  exactKeys(input.limits, ["maxUses", "requestsPerWindow", "windowSeconds", "maxConcurrentEffects"], "policy.limits");
  if (!["restricted", "unrestricted"].includes(input.resources.mode) ||
      !["optional", "required"].includes(input.processIdentity.mode)) {
    fail("api_key_input_invalid", "API Key policy mode is invalid.");
  }
  const processIdentity: any = input.processIdentity.mode === "required"
    ? Object.freeze({
        mode: "required",
        allowedPublicKeyFingerprints: Object.freeze(stringList(
          input.processIdentity.allowedPublicKeyFingerprints,
          "policy.processIdentity.allowedPublicKeyFingerprints",
          64
        ))
      })
    : Object.freeze({ mode: "optional" });
  if (processIdentity.mode === "required" && processIdentity.allowedPublicKeyFingerprints.length === 0) {
    fail("api_key_input_invalid", "Required process identity must have an allow-list.");
  }
  const normalized: any = {
    protocol: "mcp",
    serviceIds: stringList(input.serviceIds, "policy.serviceIds"),
    capabilityIds: stringList(input.capabilityIds, "policy.capabilityIds"),
    toolsetIds: stringList(input.toolsetIds, "policy.toolsetIds"),
    allowedTools: stringList(input.allowedTools, "policy.allowedTools"),
    deniedTools: stringList(input.deniedTools, "policy.deniedTools"),
    scopeIds: stringList(input.scopeIds, "policy.scopeIds"),
    maximumRisk: input.maximumRisk,
    audience: {
      serverAudience: text(input.audience.serverAudience, "policy.audience.serverAudience", 512),
      targetIds: stringList(input.audience.targetIds, "policy.audience.targetIds"),
      connectorPackageIds: stringList(input.audience.connectorPackageIds, "policy.audience.connectorPackageIds")
    },
    resources: {
      mode: input.resources.mode,
      workspaceIds: stringList(input.resources.workspaceIds, "policy.resources.workspaceIds"),
      dataClassifications: stringList(input.resources.dataClassifications, "policy.resources.dataClassifications"),
      egressClasses: stringList(input.resources.egressClasses, "policy.resources.egressClasses"),
      semanticFamilies: stringList(input.resources.semanticFamilies, "policy.resources.semanticFamilies"),
      capabilityDomains: stringList(input.resources.capabilityDomains, "policy.resources.capabilityDomains"),
      capabilityVerbs: stringList(input.resources.capabilityVerbs, "policy.resources.capabilityVerbs"),
      resourceKinds: stringList(input.resources.resourceKinds, "policy.resources.resourceKinds"),
      effectKinds: stringList(input.resources.effectKinds, "policy.resources.effectKinds"),
      secretBindingIds: stringList(input.resources.secretBindingIds, "policy.resources.secretBindingIds"),
      allowedOrigins: stringList(input.resources.allowedOrigins, "policy.resources.allowedOrigins"),
      allowedCidrs: stringList(input.resources.allowedCidrs, "policy.resources.allowedCidrs")
    },
    processIdentity,
    limits: {
      maxUses: positiveInteger(input.limits.maxUses, "policy.limits.maxUses"),
      requestsPerWindow: positiveInteger(input.limits.requestsPerWindow, "policy.limits.requestsPerWindow"),
      windowSeconds: positiveInteger(input.limits.windowSeconds, "policy.limits.windowSeconds", 86400),
      maxConcurrentEffects: positiveInteger(input.limits.maxConcurrentEffects, "policy.limits.maxConcurrentEffects", 10000)
    },
    catalogFingerprint: text(input.catalogFingerprint, "policy.catalogFingerprint", 512)
  };
  if (normalized.audience.targetIds.length === 0) {
    fail("api_key_input_invalid", "API Key target audience cannot be empty.");
  }
  const catalog: any = registry?.getCatalog?.() || null;
  if (catalog?.fingerprint && normalized.catalogFingerprint !== catalog.fingerprint) {
    fail("api_key_authority_unavailable", "Operation Permission catalog changed.", 503);
  }
  const catalogSets: any[] = [
    [normalized.allowedTools, new Set((catalog?.tools || []).map((item?: any) : any => item.id))],
    [normalized.deniedTools, new Set((catalog?.tools || []).map((item?: any) : any => item.id))],
    [normalized.toolsetIds, new Set((catalog?.toolsets || []).map((item?: any) : any => item.id))],
    [normalized.scopeIds, new Set((catalog?.scopes || []).map((item?: any) : any => item.id))]
  ];
  if (catalog) {
    for (const [values, valid] of catalogSets) {
      if (values.some((value?: any) : any => !valid.has(value))) {
        fail("api_key_input_invalid", "API Key policy references an unknown catalog item.");
      }
    }
  }
  return deepFreeze(JSON.parse(canonicalJson(normalized)));
}

function recordFromRow(row: any, nowMs = Date.now()): any {
  if (!row) return null;
  let status: any = row.status;
  if (status === "active" && Date.parse(row.expires_at) <= nowMs) status = "expired";
  else if (status === "active" && Number(row.use_count) >= Number(row.max_uses)) status = "exhausted";
  return Object.freeze({
    keyId: row.key_id,
    displayPrefix: row.display_prefix,
    credentialFingerprint: row.credential_fingerprint,
    verifierGeneration: row.verifier_generation,
    workloadPrincipalId: row.workload_principal_id,
    workloadDisplayName: row.workload_display_name,
    organizationNodeId: row.organization_node_id,
    organizationLineageDigest: row.organization_lineage_digest,
    organizationRevisionAtIssue: Number(row.organization_revision_at_issue),
    policy: deepFreeze(JSON.parse(row.policy_json)),
    policyFingerprint: row.policy_fingerprint,
    status,
    lifecycleRevision: Number(row.lifecycle_revision),
    useCount: Number(row.use_count),
    createdAt: row.created_at,
    rotatedAt: row.rotated_at || null,
    revokedAt: row.revoked_at || null,
    expiresAt: row.expires_at
  });
}

function errorForInactive(record: any): never {
  if (record.status === "exhausted") fail("api_key_use_limit_reached", "API Key use limit reached.", 429);
  fail("api_key_inactive", "API Key is inactive.", 410);
}

function riskRank(value: any): number {
  return ({
    low: 0,
    read_only: 0,
    medium: 1,
    safe_write: 1,
    high: 2,
    repair_write: 2,
    destructive: 3
  } as Record<string, number>)[String(value || "destructive")] ?? 3;
}

const API_KEY_EVALUATOR_MAX_RISK: Readonly<Record<string, string>> = Object.freeze({
  low: "read_only",
  medium: "safe_write",
  high: "repair_write"
});

export function apiKeyAuthorizationEvaluationInput(authorization: any): any {
  const policy: any = authorization?.policy;
  if (authorization?.credentialKind !== "scoped_api_key" || !object(policy) || !object(policy.resources) ||
      !authorization.workloadPrincipalId || !authorization.organizationNodeId || !authorization.keyId ||
      !authorization.policyFingerprint) {
    fail("api_key_authority_unavailable", "API Key authorization context is unavailable.", 503);
  }
  const resources: any = policy.resources;
  const restriction: any = deepFreeze({
    credentialKind: "scoped_api_key",
    credentialId: String(authorization.keyId),
    policyFingerprint: String(authorization.policyFingerprint),
    toolsets: policy.toolsetIds || [],
    toolAllow: policy.allowedTools || [],
    toolDeny: policy.deniedTools || [],
    scopes: policy.scopeIds || [],
    capabilities: policy.capabilityIds || [],
    dynamicCapabilities: policy.capabilityIds || [],
    maxRisk: API_KEY_EVALUATOR_MAX_RISK[String(policy.maximumRisk || "")] || "read_only",
    allowedWorkspaceIds: resources.workspaceIds || [],
    allowedDataClasses: resources.dataClassifications || [],
    allowedEgress: resources.egressClasses || [],
    allowedServiceIds: policy.serviceIds || [],
    allowedSecretBindings: resources.secretBindingIds || [],
    allowedOrigins: resources.allowedOrigins || [],
    allowedCidrs: resources.allowedCidrs || [],
    allowedStaticSemanticFamilies: resources.semanticFamilies || [],
    allowedCapabilityDomains: resources.capabilityDomains || [],
    allowedCapabilityVerbs: resources.capabilityVerbs || [],
    allowedResourceKinds: resources.resourceKinds || [],
    allowedEffectKinds: resources.effectKinds || []
  });
  const subjectId: any = String(authorization.workloadPrincipalId);
  const subject: any = deepFreeze({
    type: "scoped-api-key",
    subjectId,
    userId: subjectId,
    username: subjectId,
    roleId: "scoped-api-key",
    tenantId: "local",
    organizationNodeId: String(authorization.organizationNodeId),
    scopes: restriction.scopes,
    capabilities: restriction.capabilities,
    maxRisk: restriction.maxRisk,
    allowedWorkspaceIds: restriction.allowedWorkspaceIds,
    allowedDataClasses: restriction.allowedDataClasses,
    allowedEgress: restriction.allowedEgress,
    allowedServiceIds: restriction.allowedServiceIds,
    allowedSecretBindings: restriction.allowedSecretBindings,
    allowedStaticSemanticFamilies: restriction.allowedStaticSemanticFamilies,
    allowedCapabilityDomains: restriction.allowedCapabilityDomains,
    allowedCapabilityVerbs: restriction.allowedCapabilityVerbs,
    allowedResourceKinds: restriction.allowedResourceKinds,
    allowedEffectKinds: restriction.allowedEffectKinds
  });
  return Object.freeze({ restriction, subject });
}

function requireAllowedOperation(policy: any, operation: any): void {
  const toolId: any = String(operation?.toolId || operation?.id || "");
  if (toolId && policy.deniedTools.includes(toolId)) fail("api_key_policy_denied", "API Key policy denied the operation.", 403);
  const dimensions: any[] = [
    [toolId, policy.allowedTools],
    [String(operation?.serviceId || ""), policy.serviceIds],
    [String(operation?.capabilityId || ""), policy.capabilityIds]
  ];
  const suppliedToolsets: any[] = Array.isArray(operation?.toolsetIds) ? operation.toolsetIds : [];
  const suppliedScopes: any[] = Array.isArray(operation?.scopeIds) ? operation.scopeIds : [];
  if (suppliedToolsets.some((value?: any) : any => !policy.toolsetIds.includes(value)) ||
      suppliedScopes.some((value?: any) : any => !policy.scopeIds.includes(value)) ||
      riskRank(operation?.risk) > riskRank(policy.maximumRisk)) {
    fail("api_key_policy_denied", "API Key policy denied the operation.", 403);
  }
  const positiveAuthority: any = dimensions.some(([fact, allowed]) => fact && allowed.includes(fact)) ||
    suppliedToolsets.some((value?: any) : any => policy.toolsetIds.includes(value)) ||
    suppliedScopes.some((value?: any) : any => policy.scopeIds.includes(value));
  if (!positiveAuthority) fail("api_key_policy_denied", "API Key policy denied the operation.", 403);
  if (policy.resources.mode === "restricted") {
    const resource: any = operation?.resourceContext || operation?.resources || {};
    const checks: any[] = [
      [resource.workspaceId, policy.resources.workspaceIds],
      [resource.dataClassification, policy.resources.dataClassifications],
      [resource.egressClass, policy.resources.egressClasses],
      [resource.semanticFamily, policy.resources.semanticFamilies],
      [resource.capabilityDomain, policy.resources.capabilityDomains],
      [resource.capabilityVerb, policy.resources.capabilityVerbs],
      [resource.resourceKind, policy.resources.resourceKinds],
      [resource.effectKind, policy.resources.effectKinds],
      [resource.secretBindingId, policy.resources.secretBindingIds],
      [resource.origin, policy.resources.allowedOrigins]
    ];
    const suppliedChecks: any[] = checks.filter(([fact]) => Boolean(fact));
    const matchedRestriction: any = suppliedChecks.some(([fact, allowed]) => allowed.includes(fact));
    if (suppliedChecks.some(([fact, allowed]) => !allowed.includes(fact)) || !matchedRestriction) {
      fail("api_key_policy_denied", "API Key resource policy denied the operation.", 403);
    }
  }
}

export function createApiKeyDistributionProvider({
  store,
  registry = null,
  securityPermissions = null,
  verifierKeyProvider,
  now = () : any => Date.now(),
  randomBytes = (size: number) : any => crypto.randomBytes(size),
  effectLeaseTtlMs = 5 * 60 * 1000
}: Record<string, any> = {}): any {
  if (!store?.db || !verifierKeyProvider?.getKey || !verifierKeyProvider?.currentGeneration) {
    throw new Error("API Key distribution dependencies are unavailable.");
  }
  const db: any = store.db;

  function authority(subjectId: string): any {
    try {
      reconcileApiKeyOwnerRecoveryAssignments({ securityPermissions });
      const organizationSnapshot: any = securityPermissions?.getOrganizationGovernance?.();
      const governanceSummary: any = securityPermissions?.getGovernanceSummary?.();
      if (
        organizationSnapshot &&
        organizationSnapshot.configured === false &&
        Number.isSafeInteger(Number(organizationSnapshot.revision || 0))
      ) {
        const policyRevision: any = governanceSummary?.policyRevision || {};
        return Object.freeze({
          subjectId,
          roots: Object.freeze([]),
          eligibleNodeIds: Object.freeze([]),
          revision: Object.freeze({
            organizationRevision: Number(organizationSnapshot.revision || 0),
            authorizationRevision: Number(policyRevision.revision || 0),
            authorizationUpdatedAt: String(policyRevision.updatedAt || "")
          })
        });
      }
      return evaluateApiKeyIssuerScopes({
        subjectId,
        organizationSnapshot,
        governanceSummary
      });
    } catch (error: any) {
      if (error?.code) throw error;
      fail("api_key_authority_unavailable", "API Key issuer authority is unavailable.", 503);
    }
  }

  function currentNodes(): any {
    const snapshot: any = securityPermissions?.getOrganizationGovernance?.();
    const nodesById: any = new Map((snapshot?.nodes || []).map((node?: any) : any => [node.nodeId, node]));
    return { snapshot, nodesById };
  }

  function getRow(keyId: string): any {
    return db.prepare("SELECT * FROM api_key_records WHERE key_id = ?").get(keyId);
  }

  function emitEvent(row: any, eventType: string, reasonCode: string, organizationRevision: number): void {
    db.prepare(`INSERT INTO api_key_lifecycle_events (
      event_id, key_id, event_type, reason_code, lifecycle_revision, policy_fingerprint,
      organization_revision, use_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`ake_${crypto.randomUUID()}`, row.key_id, eventType, reasonCode,
        row.lifecycle_revision, row.policy_fingerprint, organizationRevision, row.use_count,
        new Date(now()).toISOString());
  }

  async function getVerifierKey(generation: string): Promise<Buffer> {
    const key: any = await Promise.resolve(verifierKeyProvider.getKey(generation));
    if (!Buffer.isBuffer(key) || key.length < 32) {
      fail("api_key_authority_unavailable", "API Key verifier generation is unavailable.", 503);
    }
    return key;
  }

  async function create(input: Record<string, any> = {}): Promise<any> {
    exactKeys(input, ["subjectId", "workloadDisplayName", "organizationNodeId", "expiresAt", "policy"]);
    const subjectId: any = text(input.subjectId, "subjectId", 256);
    const scopes: any = authority(subjectId);
    const organizationNodeId: any = text(input.organizationNodeId, "organizationNodeId", 160);
    assertApiKeyIssuerTarget(scopes, organizationNodeId);
    const expiresAtMs: any = Date.parse(text(input.expiresAt, "expiresAt", 64));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()) fail("api_key_input_invalid", "expiresAt must be in the future.");
    const policy: any = normalizePolicy(input.policy, registry);
    const { snapshot, nodesById } = currentNodes();
    const lineageDigest: any = organizationLineageDigest(organizationNodeId, nodesById);
    if (snapshot.revision !== scopes.revision.organizationRevision) {
      fail("api_key_authority_stale", "API Key issuer authority changed.", 409);
    }
    const keyId: any = Buffer.from(randomBytes(16)).toString("base64url");
    const secret: any = Buffer.from(randomBytes(32)).toString("base64url");
    if (!parseApiKeyCredential(`${API_KEY_CREDENTIAL_VERSION}.${keyId}.${secret}`)) {
      fail("api_key_authority_unavailable", "Secure API Key generation failed.", 503);
    }
    const apiKey: any = `${API_KEY_CREDENTIAL_VERSION}.${keyId}.${secret}`;
    const verifierGeneration: any = String(verifierKeyProvider.currentGeneration);
    const key: any = await getVerifierKey(verifierGeneration);
    const verifier: any = verifierDigest(key, keyId, secret);
    const createdAt: any = new Date(now()).toISOString();
    const policyJson: any = canonicalJson(policy);
    const policyFingerprint: any = digest(policyJson);
    db.transaction(() : any => {
      const currentScopes: any = authority(subjectId);
      if (canonicalJson(currentScopes.revision) !== canonicalJson(scopes.revision)) {
        fail("api_key_authority_stale", "API Key issuer authority changed.", 409);
      }
      assertApiKeyIssuerTarget(currentScopes, organizationNodeId);
      db.prepare(`INSERT INTO api_key_records (
        key_id, display_prefix, credential_fingerprint, verifier_generation, verifier_digest,
        workload_principal_id, workload_display_name, organization_node_id, organization_lineage_digest,
        organization_revision_at_issue, policy_json, policy_fingerprint, status, lifecycle_revision,
        use_count, max_uses, requests_per_window, window_seconds, max_concurrent_effects,
        created_at, rotated_at, revoked_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, 0, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
        .run(keyId, `mxak1.${keyId.slice(0, 8)}…`, digest(apiKey), verifierGeneration, verifier,
          `workload_${crypto.randomUUID()}`, text(input.workloadDisplayName, "workloadDisplayName", 200),
          organizationNodeId, lineageDigest, snapshot.revision, policyJson, policyFingerprint,
          policy.limits.maxUses, policy.limits.requestsPerWindow, policy.limits.windowSeconds,
          policy.limits.maxConcurrentEffects, createdAt, new Date(expiresAtMs).toISOString());
      emitEvent(getRow(keyId), "created", "api_key_created", snapshot.revision);
    })();
    return Object.freeze({ record: recordFromRow(getRow(keyId), now()), apiKey });
  }

  async function getIssuerScopes(input: Record<string, any> = {}): Promise<any> {
    exactKeys(input, ["subjectId"]);
    const scopes: any = authority(text(input.subjectId, "subjectId", 256));
    const { snapshot, nodesById } = currentNodes();
    if (snapshot?.revision !== scopes.revision.organizationRevision) {
      fail("api_key_authority_stale", "API Key issuer authority changed.", 409);
    }
    const projectNode: any = (nodeId: string) : any => {
      const node: any = nodesById.get(nodeId);
      if (!node) fail("api_key_authority_unavailable", "Organization governance is unavailable.", 503);
      return Object.freeze({
        nodeId: node.nodeId,
        name: String(node.name || node.nodeId),
        breadcrumb: Object.freeze(organizationLineage(nodeId, nodesById)
          .map((lineageNodeId?: any) : any => String(nodesById.get(lineageNodeId)?.name || lineageNodeId))),
        nodeType: node.nodeType
      });
    };
    const catalogFingerprint: any = String(registry?.getCatalog?.()?.fingerprint || "");
    if (!catalogFingerprint) {
      fail("api_key_authority_unavailable", "Operation Permission catalog is unavailable.", 503);
    }
    return Object.freeze({
      organizationRevision: scopes.revision.organizationRevision,
      authorizationRevision: scopes.revision.authorizationRevision,
      authorizationUpdatedAt: scopes.revision.authorizationUpdatedAt,
      catalogFingerprint,
      eligibleRoots: Object.freeze(scopes.roots.map((root?: any) : any => projectNode(root.nodeId))),
      eligibleNodes: Object.freeze(scopes.eligibleNodeIds.map((nodeId?: any) : any => projectNode(nodeId)))
    });
  }

  async function list(input: Record<string, any> = {}): Promise<any> {
    exactKeys(input, ["subjectId", "status", "organizationNodeId", "cursor", "limit"]);
    const scopes: any = authority(text(input.subjectId, "subjectId", 256));
    if (scopes.eligibleNodeIds.length === 0) return Object.freeze({ items: Object.freeze([]), nextCursor: "" });
    const requestedNode: any = input.organizationNodeId ? text(input.organizationNodeId, "organizationNodeId", 160) : "";
    if (requestedNode) assertApiKeyIssuerTarget(scopes, requestedNode);
    const status: any = input.status ? text(input.status, "status", 16) : "";
    if (status && !API_KEY_STATUSES.includes(status as any)) fail("api_key_input_invalid", "status is invalid.");
    const limit: any = input.limit === undefined ? 50 : positiveInteger(input.limit, "limit", 100);
    let cursorCreated: any = "";
    let cursorKeyId: any = "";
    if (input.cursor) {
      try {
        const decoded: any = JSON.parse(Buffer.from(text(input.cursor, "cursor", 1024), "base64url").toString("utf8"));
        cursorCreated = String(decoded.createdAt || "");
        cursorKeyId = String(decoded.keyId || "");
        if (!cursorCreated || !cursorKeyId) throw new Error("invalid");
      } catch {
        fail("api_key_input_invalid", "cursor is invalid.");
      }
    }
    const nodeIds: any[] = requestedNode ? [requestedNode] : [...scopes.eligibleNodeIds];
    const clauses: any[] = [`organization_node_id IN (${nodeIds.map(() : any => "?").join(",")})`];
    const parameters: any[] = [...nodeIds];
    if (status) {
      clauses.push(`(CASE
        WHEN status = 'active' AND expires_at <= ? THEN 'expired'
        WHEN status = 'active' AND use_count >= max_uses THEN 'exhausted'
        ELSE status END) = ?`);
      parameters.push(new Date(now()).toISOString(), status);
    }
    if (cursorCreated) {
      clauses.push("(created_at > ? OR (created_at = ? AND key_id > ?))");
      parameters.push(cursorCreated, cursorCreated, cursorKeyId);
    }
    const rows: any[] = db.prepare(`SELECT * FROM api_key_records WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC, key_id ASC LIMIT ?`).all(...parameters, limit + 1);
    const visible: any[] = rows.slice(0, limit).map((row?: any) : any => recordFromRow(row, now()));
    const last: any = rows.length > limit ? visible[visible.length - 1] : null;
    return Object.freeze({
      items: Object.freeze(visible),
      nextCursor: last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, keyId: last.keyId })).toString("base64url") : ""
    });
  }

  async function scopedRecord(input: any): Promise<{ row: any; scopes: any }> {
    const scopes: any = authority(text(input.subjectId, "subjectId", 256));
    const row: any = getRow(text(input.keyId, "keyId", 64));
    if (!row || !scopes.eligibleNodeIds.includes(row.organization_node_id)) {
      fail("api_key_record_not_found", "API Key record was not found.", 404);
    }
    return { row, scopes };
  }

  async function rotate(input: Record<string, any> = {}): Promise<any> {
    exactKeys(input, ["subjectId", "keyId", "expectedLifecycleRevision"]);
    const { row, scopes } = await scopedRecord(input);
    const expected: any = positiveInteger(input.expectedLifecycleRevision, "expectedLifecycleRevision");
    const projected: any = recordFromRow(row, now());
    if (projected.status !== "active") errorForInactive(projected);
    const secret: any = Buffer.from(randomBytes(32)).toString("base64url");
    const apiKey: any = `${API_KEY_CREDENTIAL_VERSION}.${row.key_id}.${secret}`;
    if (!parseApiKeyCredential(apiKey)) {
      fail("api_key_authority_unavailable", "Secure API Key generation failed.", 503);
    }
    const generation: any = String(verifierKeyProvider.currentGeneration);
    const verifier: any = verifierDigest(await getVerifierKey(generation), row.key_id, secret);
    const rotatedAt: any = new Date(now()).toISOString();
    const result: any = db.transaction(() : any => {
      const currentScopes: any = authority(text(input.subjectId, "subjectId", 256));
      if (canonicalJson(currentScopes.revision) !== canonicalJson(scopes.revision)) {
        fail("api_key_authority_stale", "API Key issuer authority changed.", 409);
      }
      assertApiKeyIssuerTarget(currentScopes, row.organization_node_id);
      const update: any = db.prepare(`UPDATE api_key_records SET
        verifier_generation = ?, verifier_digest = ?, credential_fingerprint = ?,
        lifecycle_revision = lifecycle_revision + 1, rotated_at = ?
        WHERE key_id = ? AND status = 'active' AND lifecycle_revision = ?`)
        .run(generation, verifier, digest(apiKey), rotatedAt, row.key_id, expected);
      if (update.changes !== 1) fail("api_key_revision_stale", "API Key lifecycle revision changed.", 409);
      const current: any = getRow(row.key_id);
      emitEvent(current, "rotated", "api_key_rotated", scopes.revision.organizationRevision);
      return current;
    })();
    return Object.freeze({ record: recordFromRow(result, now()), apiKey });
  }

  async function revoke(input: Record<string, any> = {}): Promise<any> {
    exactKeys(input, ["subjectId", "keyId", "expectedLifecycleRevision", "reasonCode"]);
    const { row, scopes } = await scopedRecord(input);
    const expected: any = positiveInteger(input.expectedLifecycleRevision, "expectedLifecycleRevision");
    const reasonCode: any = text(input.reasonCode, "reasonCode", 64);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(reasonCode)) fail("api_key_input_invalid", "reasonCode is invalid.");
    if (recordFromRow(row, now()).status !== "active") errorForInactive(recordFromRow(row, now()));
    const revokedAt: any = new Date(now()).toISOString();
    const result: any = db.transaction(() : any => {
      const currentScopes: any = authority(text(input.subjectId, "subjectId", 256));
      if (canonicalJson(currentScopes.revision) !== canonicalJson(scopes.revision)) {
        fail("api_key_authority_stale", "API Key issuer authority changed.", 409);
      }
      assertApiKeyIssuerTarget(currentScopes, row.organization_node_id);
      const update: any = db.prepare(`UPDATE api_key_records SET status = 'revoked', revoked_at = ?,
        lifecycle_revision = lifecycle_revision + 1
        WHERE key_id = ? AND status = 'active' AND lifecycle_revision = ?`)
        .run(revokedAt, row.key_id, expected);
      if (update.changes !== 1) fail("api_key_revision_stale", "API Key lifecycle revision changed.", 409);
      db.prepare("DELETE FROM api_key_effect_leases WHERE key_id = ?").run(row.key_id);
      const current: any = getRow(row.key_id);
      emitEvent(current, "revoked", reasonCode, scopes.revision.organizationRevision);
      return current;
    })();
    return recordFromRow(result, now());
  }

  async function verifyProcessIdentity(policy: any, evidence: any): Promise<any> {
    if (!evidence) {
      if (policy.processIdentity.mode === "required") {
        fail("api_key_process_identity_required", "Signed process identity is required.", 403);
      }
      return null;
    }
    const verified: any = evidence.verified === true || evidence.ok === true
      ? evidence
      : await Promise.resolve(securityPermissions?.verifyProcessIdentity?.(evidence));
    if (!verified || (verified.ok !== true && verified.verified !== true)) {
      fail("api_key_process_identity_required", "Signed process identity is invalid.", 403);
    }
    const fingerprint: any = String(verified.publicKeyFingerprint || verified.fingerprint || verified.processIdentityFingerprint || "");
    if (policy.processIdentity.mode === "required" &&
        !policy.processIdentity.allowedPublicKeyFingerprints.includes(fingerprint)) {
      fail("api_key_process_identity_required", "Signed process identity is not allowed.", 403);
    }
    return Object.freeze({ ...verified, fingerprint });
  }

  async function authenticateRuntime(input: Record<string, any> = {}): Promise<any> {
    exactKeys(input, ["credential", "serverAudience", "targetId", "connectorPackageId", "processIdentityEvidence"]);
    const parsed: any = parseApiKeyCredential(input.credential);
    if (!parsed) fail("api_key_invalid", "API Key is invalid.", 401);
    const row: any = getRow(parsed.keyId); // one primary-key lookup; verifier material is never scanned
    if (!row) fail("api_key_invalid", "API Key is invalid.", 401);
    const candidate: any = verifierDigest(await getVerifierKey(row.verifier_generation), parsed.keyId, parsed.secret);
    const stored: any = Buffer.from(row.verifier_digest);
    if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) {
      fail("api_key_invalid", "API Key is invalid.", 401);
    }
    const record: any = recordFromRow(row, now());
    if (record.status !== "active") {
      if (row.status === "active" && ["expired", "exhausted"].includes(record.status)) {
        db.transaction(() : any => {
          const update: any = db.prepare(`UPDATE api_key_records SET status = ?, lifecycle_revision = lifecycle_revision + 1
            WHERE key_id = ? AND status = 'active' AND lifecycle_revision = ?`)
            .run(record.status, row.key_id, row.lifecycle_revision);
          if (update.changes === 1) {
            const current: any = getRow(row.key_id);
            emitEvent(current, record.status, `api_key_${record.status}`, current.organization_revision_at_issue);
          }
        })();
      }
      errorForInactive(record);
    }
    const catalogFingerprint: any = registry?.getCatalog?.()?.fingerprint;
    if (catalogFingerprint && catalogFingerprint !== record.policy.catalogFingerprint) {
      fail("api_key_authority_unavailable", "Operation Permission catalog changed.", 503);
    }
    if (record.policy.audience.serverAudience !== String(input.serverAudience || "") ||
        !record.policy.audience.targetIds.includes(String(input.targetId || "")) ||
        (record.policy.audience.connectorPackageIds.length > 0 &&
          !record.policy.audience.connectorPackageIds.includes(String(input.connectorPackageId || "")))) {
      fail("api_key_policy_denied", "API Key audience is not allowed.", 403);
    }
    const { nodesById } = currentNodes();
    if (!nodesById.has(record.organizationNodeId) ||
        organizationLineageDigest(record.organizationNodeId, nodesById) !== record.organizationLineageDigest) {
      fail("api_key_inactive", "API Key organization lineage changed.", 410);
    }
    const processIdentity: any = await verifyProcessIdentity(record.policy, input.processIdentityEvidence);
    return Object.freeze({
      credentialKind: "scoped_api_key",
      keyId: record.keyId,
      workloadPrincipalId: record.workloadPrincipalId,
      organizationNodeId: record.organizationNodeId,
      lifecycleRevision: record.lifecycleRevision,
      policyFingerprint: record.policyFingerprint,
      policy: record.policy,
      processIdentity,
      credentialFingerprint: record.credentialFingerprint
    });
  }

  function assertAuthorizationCurrent(authorization: any): any {
    if (authorization?.credentialKind !== "scoped_api_key") fail("api_key_invalid", "API Key authorization is invalid.", 401);
    const row: any = getRow(String(authorization.keyId || ""));
    const record: any = recordFromRow(row, now());
    if (!record || record.status !== "active") errorForInactive(record || { status: "revoked" });
    if (record.lifecycleRevision !== authorization.lifecycleRevision ||
        record.policyFingerprint !== authorization.policyFingerprint ||
        record.workloadPrincipalId !== authorization.workloadPrincipalId ||
        record.organizationNodeId !== authorization.organizationNodeId) {
      fail("api_key_revision_stale", "API Key lifecycle changed.", 409);
    }
    const { nodesById } = currentNodes();
    if (!nodesById.has(record.organizationNodeId) ||
        organizationLineageDigest(record.organizationNodeId, nodesById) !== record.organizationLineageDigest) {
      fail("api_key_inactive", "API Key organization lineage changed.", 410);
    }
    return { row, record };
  }

  function revalidateAuthorization(authorization: any): any {
    const { record } = assertAuthorizationCurrent(authorization);
    return Object.freeze({
      credentialKind: "scoped_api_key",
      keyId: record.keyId,
      workloadPrincipalId: record.workloadPrincipalId,
      organizationNodeId: record.organizationNodeId,
      lifecycleRevision: record.lifecycleRevision,
      policyFingerprint: record.policyFingerprint,
      policy: record.policy
    });
  }

  function cleanupExpiredEphemeralState(timestamp: number): void {
    db.prepare(`DELETE FROM api_key_usage_windows WHERE rowid IN (
      SELECT rowid FROM api_key_usage_windows WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT 256
    )`).run(timestamp);
    db.prepare(`DELETE FROM api_key_effect_leases WHERE rowid IN (
      SELECT rowid FROM api_key_effect_leases WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT 256
    )`).run(timestamp);
  }

  async function reserveEffect(input: Record<string, any> = {}): Promise<any> {
    exactKeys(input, ["authorization", "operation"]);
    requireAllowedOperation(input.authorization?.policy, input.operation);
    const timestamp: any = now();
    const leaseId: any = `akl_${crypto.randomUUID()}`;
    const result: any = db.transaction(() : any => {
      const { row, record } = assertAuthorizationCurrent(input.authorization);
      cleanupExpiredEphemeralState(timestamp);
      db.prepare("DELETE FROM api_key_usage_windows WHERE key_id = ? AND expires_at <= ?").run(row.key_id, timestamp);
      db.prepare("DELETE FROM api_key_effect_leases WHERE key_id = ? AND expires_at <= ?").run(row.key_id, timestamp);
      const windowMs: any = record.policy.limits.windowSeconds * 1000;
      const windowStart: any = Math.floor(timestamp / windowMs) * windowMs;
      const usage: any = db.prepare("SELECT request_count FROM api_key_usage_windows WHERE key_id = ? AND window_start = ?")
        .get(row.key_id, windowStart);
      if (Number(usage?.request_count || 0) >= record.policy.limits.requestsPerWindow) {
        fail("api_key_rate_limited", "API Key rate limit reached.", 429);
      }
      const leases: any = db.prepare("SELECT count(*) AS count FROM api_key_effect_leases WHERE key_id = ? AND expires_at > ?")
        .get(row.key_id, timestamp);
      if (Number(leases?.count || 0) >= record.policy.limits.maxConcurrentEffects) {
        fail("api_key_concurrency_limit_reached", "API Key concurrency limit reached.", 429);
      }
      const useUpdate: any = db.prepare(`UPDATE api_key_records SET use_count = use_count + 1,
        status = CASE WHEN use_count + 1 >= max_uses THEN 'exhausted' ELSE status END
        WHERE key_id = ? AND status = 'active' AND lifecycle_revision = ? AND policy_fingerprint = ?
          AND use_count < max_uses AND expires_at > ?`)
        .run(row.key_id, record.lifecycleRevision, record.policyFingerprint, new Date(timestamp).toISOString());
      if (useUpdate.changes !== 1) fail("api_key_use_limit_reached", "API Key use limit reached.", 429);
      db.prepare(`INSERT INTO api_key_usage_windows (key_id, window_start, request_count, expires_at)
        VALUES (?, ?, 1, ?) ON CONFLICT(key_id, window_start) DO UPDATE SET request_count = request_count + 1`)
        .run(row.key_id, windowStart, windowStart + windowMs * 2);
      db.prepare(`INSERT INTO api_key_effect_leases
        (key_id, lease_id, lifecycle_revision, policy_fingerprint, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(row.key_id, leaseId, record.lifecycleRevision, record.policyFingerprint,
          timestamp + effectLeaseTtlMs, new Date(timestamp).toISOString());
      return Object.freeze({
        keyId: row.key_id,
        leaseId,
        lifecycleRevision: record.lifecycleRevision,
        policyFingerprint: record.policyFingerprint,
        expiresAt: new Date(timestamp + effectLeaseTtlMs).toISOString()
      });
    })();
    return result;
  }

  function authorizeOperation(input: Record<string, any> = {}): any {
    exactKeys(input, ["authorization", "operation"]);
    requireAllowedOperation(input.authorization?.policy, input.operation);
    return revalidateAuthorization(input.authorization);
  }

  async function revalidateEffect(lease: any): Promise<void> {
    if (!object(lease)) fail("api_key_revision_stale", "API Key effect lease is invalid.", 409);
    const activeLease: any = db.prepare(`SELECT * FROM api_key_effect_leases
      WHERE key_id = ? AND lease_id = ?`).get(String(lease.keyId || ""), String(lease.leaseId || ""));
    if (!activeLease || Number(activeLease.expires_at) <= now()) {
      fail("api_key_revision_stale", "API Key effect lease expired.", 409);
    }
    const row: any = getRow(activeLease.key_id);
    const record: any = recordFromRow(row, now());
    // Exhaustion caused by this reservation is allowed; all other terminal/lifecycle changes fence it.
    if (!record || !["active", "exhausted"].includes(record.status) || row.status === "revoked" || row.status === "expired" ||
        record.lifecycleRevision !== activeLease.lifecycle_revision ||
        record.policyFingerprint !== activeLease.policy_fingerprint) {
      fail("api_key_revision_stale", "API Key lifecycle changed before effect.", 409);
    }
    const { nodesById } = currentNodes();
    if (!nodesById.has(record.organizationNodeId) ||
        organizationLineageDigest(record.organizationNodeId, nodesById) !== record.organizationLineageDigest) {
      fail("api_key_inactive", "API Key organization lineage changed.", 410);
    }
  }

  async function releaseEffect(lease: any): Promise<void> {
    if (!object(lease)) return;
    db.prepare("DELETE FROM api_key_effect_leases WHERE key_id = ? AND lease_id = ?")
      .run(String(lease.keyId || ""), String(lease.leaseId || ""));
  }

  function explainLookupPlan(): any[] {
    return db.prepare("EXPLAIN QUERY PLAN SELECT * FROM api_key_records WHERE key_id = ?").all("_probe_");
  }

  return Object.freeze({
    getIssuerScopes,
    list,
    create,
    rotate,
    revoke,
    authenticateRuntime,
    revalidateAuthorization,
    authorizeOperation,
    reserveEffect,
    revalidateEffect,
    releaseEffect,
    explainLookupPlan
  });
}
