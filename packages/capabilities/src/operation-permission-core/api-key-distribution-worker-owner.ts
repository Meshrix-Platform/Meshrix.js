import crypto from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  API_KEY_MANAGEMENT_ACTION,
  assertApiKeyIssuerTarget,
  evaluateApiKeyIssuerScopes,
  organizationLineage,
  organizationLineageDigest
} from "@meshrix/foundation/security/authorization/api-key-issuer-authority";
import { toolExecuteCapabilityId } from "@meshrix/foundation/security/authorization/authorization-engine";

export const API_KEY_CREDENTIAL_VERSION = "mxak1";
export const API_KEY_CREDENTIAL_PATTERN = /^mxak1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/u;
export const API_KEY_STATUSES = Object.freeze(["active", "revoked", "expired", "exhausted"] as const);
export const API_KEY_READ_STATUSES = Object.freeze([...API_KEY_STATUSES, "unclaimed"] as const);
/** Minted keys that never complete one successful authentication die here. */
export const API_KEY_UNCLAIMED_WINDOW_MS = 72 * 60 * 60 * 1000;

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

type CapabilitySelection = "catalog" | "exact";

function capabilitySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
}

function requireLiveCatalog(catalog: any): void {
  if (!catalog?.fingerprint || !Array.isArray(catalog.tools) ||
      !Array.isArray(catalog.scopes) || !Array.isArray(catalog.toolsets)) {
    fail("api_key_authority_unavailable", "Current Operation Permission catalog is unavailable.", 503);
  }
}

function requireExactCatalog(catalog: any, fingerprint: string): void {
  requireLiveCatalog(catalog);
  if (catalog.fingerprint !== fingerprint) {
    fail("api_key_authority_unavailable", "Current Operation Permission catalog is unavailable.", 503);
  }
}

function exactCatalogBinding(tool: any) {
  if (typeof tool?.id !== "string" || !tool.id || /[\s*?]/u.test(tool.id) || tool.status !== "active" ||
      !Array.isArray(tool.toolsets) || !tool.toolsets.length || !Array.isArray(tool.requiredScopes) ||
      !["read_only", "safe_write", "repair_write", "destructive"].includes(tool.risk)) return null;
  const cap = tool.dynamicCapability;
  if (cap == null) {
    return tool.upstreamProjectedOperation || tool.serviceId ? null :
      { id: toolExecuteCapabilityId(tool.id), serviceId: "", nativeParent: false };
  }
  if (!object(cap) || typeof cap.capabilityId !== "string" || !cap.capabilityId || /[\s*?]/u.test(cap.capabilityId) ||
      typeof cap.serviceId !== "string" || !cap.serviceId || (tool.serviceId && tool.serviceId !== cap.serviceId) ||
      !(tool.protocol || cap.protocol) || !(tool.operationKey || cap.operationKey) ||
      (cap.risk !== undefined && tool.risk !== cap.risk) || (tool.protocol && cap.protocol && tool.protocol !== cap.protocol) ||
      (tool.operationKey && cap.operationKey && tool.operationKey !== cap.operationKey)) return null;

  const prefix = `cap:upstream:${capabilitySegment(cap.serviceId)}:`;
  if (cap.capabilityId.startsWith("cap:upstream:") && !cap.capabilityId.startsWith(prefix)) return null;
  const nativeParent = (tool.protocol || cap.protocol) === "mcp" &&
    (tool.operationKey || cap.operationKey) === "tools/call" && !cap.upstreamToolName &&
    cap.capabilityId === `${prefix}tools-call`;
  return { id: cap.capabilityId, serviceId: cap.serviceId, nativeParent };
}

type ExactCatalogBinding = NonNullable<ReturnType<typeof exactCatalogBinding>>;

function matchesExactCapability(binding: ExactCatalogBinding, id: string): boolean {
  if (id === binding.id) return true;
  if (!binding.nativeParent || !id.startsWith(`${binding.id}-`)) return false;
  const segment = id.slice(binding.id.length + 1);
  // A truncated native segment can end in '-' only at the 80-character boundary.
  return /^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/u.test(segment) && (segment.length === 80 || !segment.endsWith("-"));
}

function requireExactSelection(policy: any, selectedTools: any[]): void {
  const matched = new Set<string>();
  const services = new Set<string>();
  const invalid = () => fail("api_key_input_invalid", "API Key capability selection does not match the selected catalog tools.");
  if (!selectedTools.length) invalid();
  for (const tool of selectedTools) {
    const binding = exactCatalogBinding(tool);
    if (!binding) return invalid();
    if (binding.serviceId) services.add(binding.serviceId);
    const ids: string[] = policy.capabilityIds.filter((id: string) => matchesExactCapability(binding, id));
    if (!ids.length || (ids.length > 1 && ids.includes(binding.id))) invalid();
    for (const id of ids) {
      if (matched.has(id)) invalid();
      matched.add(id);
    }
  }
  if (matched.size !== policy.capabilityIds.length || policy.serviceIds.some((id: string) => !services.has(id))) invalid();
}

function normalizePolicy(input: any, registry: any, capabilitySelection: CapabilitySelection): any {
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
  // targetIds and connectorPackageIds validate a client-declared identity only
  // when that header is present. An omitted header is not a restriction, even
  // when the stored list is non-empty. A presented value must still be in the list.
  const catalog: any = registry?.getCatalog?.() || null;
  if (capabilitySelection === "exact") requireExactCatalog(catalog, normalized.catalogFingerprint);
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
    const selectedTools: any[] = (catalog.tools || []).filter((tool?: any) : any =>
      normalized.allowedTools.includes(String(tool?.id || ""))
    );
    if (capabilitySelection === "exact") requireExactSelection(normalized, selectedTools);
    const dynamicTools: any[] = selectedTools.filter((tool?: any) : any =>
      tool?.dynamicCapability && typeof tool.dynamicCapability === "object" && !Array.isArray(tool.dynamicCapability)
    );
    if (dynamicTools.length > 0) {
      const derived: any = (field?: any) : any => [...new Set<any>(dynamicTools
        .flatMap((tool?: any) : any => {
          const capability: any = tool.dynamicCapability || {};
          const resource: any = capability.resourceContext || tool.resourceContext || {};
          return typeof field === "function" ? field(tool, capability, resource) : [];
        })
        .map((value?: any) : any => String(value || "").trim())
        .filter(Boolean))].sort();
      const catalogToolsets: any = new Set<any>((catalog.toolsets || []).map((item?: any) : any => item.id));
      const requestedToolsets: any[] = [...normalized.toolsetIds];
      const derivedServiceIds: any[] = derived((_tool?: any, capability?: any) : any => [capability.serviceId]);
      normalized.serviceIds = [...new Set<any>([
        ...normalized.serviceIds,
        ...derivedServiceIds
      ])].sort();
      if (capabilitySelection === "catalog") {
        const selectedServicePrefixes: string[] = normalized.serviceIds.map((id: string) =>
          `cap:upstream:${capabilitySegment(id) || "service"}:`
        );
        normalized.capabilityIds = [...new Set([
          ...normalized.capabilityIds.filter((id: string) => selectedServicePrefixes.some((prefix) => id.startsWith(prefix))),
          ...derived((_tool?: any, capability?: any) : any => [capability.capabilityId]),
          ...selectedTools.filter((tool) => !tool?.dynamicCapability).map((tool) => toolExecuteCapabilityId(tool.id))
        ])].sort();
      }
      normalized.toolsetIds = [...new Set<any>([
        ...derived((tool?: any, capability?: any) : any => [
        ...(tool.toolsets || []),
        ...(capability.toolsets || [])
        ]).filter((toolsetId?: any) : any => catalogToolsets.has(toolsetId)),
        ...requestedToolsets
      ])].sort();
      const selectedToolsetScopes: any[] = (catalog.toolsets || [])
        .filter((toolset?: any) : any => normalized.toolsetIds.includes(toolset.id))
        .flatMap((toolset?: any) : any => toolset.requiredScopes || toolset.scopes || []);
      normalized.scopeIds = [...new Set<any>([
        ...normalized.scopeIds,
        ...derived((tool?: any, capability?: any) : any => [
        ...(tool.requiredScopes || []),
        ...(capability.requiredScopes || [])
        ]),
        ...selectedToolsetScopes
      ])].sort();
      normalized.resources.egressClasses = [...new Set<any>([
        ...normalized.resources.egressClasses,
        ...derived((_tool?: any, _capability?: any, resource?: any) : any => [
          resource.requestedEgress,
          ...(resource.requestedEgresses || [])
        ])
      ])].sort();
      normalized.resources.secretBindingIds = [...new Set<any>([
        ...normalized.resources.secretBindingIds,
        ...derived((_tool?: any, capability?: any, resource?: any) : any => [
          ...(capability.credentialBindingIds || []),
          resource.secretBindingId,
          ...(resource.secretBindingIds || [])
        ])
      ])].sort();
      normalized.resources.mode = normalized.resources.mode === "unrestricted"
        ? "unrestricted"
        : "restricted";
    } else if (capabilitySelection === "catalog" && selectedTools.length > 0) {
      normalized.capabilityIds = [...new Set<any>([
        ...normalized.capabilityIds,
        ...selectedTools.map((tool?: any) : any => toolExecuteCapabilityId(tool.id))
      ])].sort();
    }
    const selectedResourceValues: any = (...keys: string[]) : any[] => [...new Set<any>(selectedTools
      .flatMap((tool?: any) : any => {
        const capability: any = object(tool?.dynamicCapability) ? tool.dynamicCapability : {};
        const resources: any[] = [tool?.resourceContext, capability.resourceContext]
          .filter((value?: any) : any => object(value));
        return resources.flatMap((resource?: any) : any => keys.flatMap((key?: any) : any =>
          Array.isArray(resource[key]) ? resource[key] : [resource[key]]
        ));
      })
      .map((value?: any) : any => String(value || "").trim())
      .filter(Boolean))].sort();
    normalized.resources.semanticFamilies = [...new Set<any>([
      ...normalized.resources.semanticFamilies,
      ...selectedResourceValues("semanticFamily", "semanticFamilies", "staticSemanticFamilyId")
    ])].sort();
    normalized.resources.capabilityDomains = [...new Set<any>([
      ...normalized.resources.capabilityDomains,
      ...selectedResourceValues("capabilityDomain", "capabilityDomains")
    ])].sort();
    normalized.resources.capabilityVerbs = [...new Set<any>([
      ...normalized.resources.capabilityVerbs,
      ...selectedResourceValues("capabilityVerb", "capabilityVerbs")
    ])].sort();
    normalized.resources.resourceKinds = [...new Set<any>([
      ...normalized.resources.resourceKinds,
      ...selectedResourceValues("resourceKind", "resourceKinds")
    ])].sort();
    normalized.resources.effectKinds = [...new Set<any>([
      ...normalized.resources.effectKinds,
      ...selectedResourceValues("effectKind", "effectKinds")
    ])].sort();
    if (selectedTools.length > 0) {
      const operationRiskRank: any = { read_only: 0, low: 0, safe_write: 1, medium: 1, repair_write: 2, destructive: 2, high: 2 };
      const requestedRank: any = operationRiskRank[String(normalized.maximumRisk || "low")] ?? 0;
      const selectedRank: any = Math.max(...selectedTools.map((tool?: any) : any =>
        operationRiskRank[String(tool.dynamicCapability?.risk || tool.risk || "read_only")] ?? 2
      ));
      normalized.maximumRisk = ["low", "medium", "high"][Math.max(requestedRank, selectedRank)] || "high";
    }
  }
  return deepFreeze(JSON.parse(canonicalJson(normalized)));
}

function recordFromRow(row: any, nowMs = Date.now()): any {
  if (!row) return null;
  let status: any = row.status;
  if (status === "active" && Date.parse(row.expires_at) <= nowMs) status = "expired";
  else if (status === "active" && Number(row.use_count) >= Number(row.max_uses)) status = "exhausted";
  else if (status === "active" && !row.claimed_at &&
      Date.parse(row.created_at) + API_KEY_UNCLAIMED_WINDOW_MS <= nowMs) status = "unclaimed";
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
    claimedAt: row.claimed_at || null,
    expiresAt: row.expires_at
  });
}

function errorForInactive(record: any): never {
  if (record.status === "exhausted") fail("api_key_use_limit_reached", "API Key use limit reached.", 429);
  if (record.status === "unclaimed") fail("api_key_unclaimed_expired", "API Key was never claimed and its claim window has closed.", 410);
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

const API_KEY_RESOURCE_DIMENSIONS: ReadonlyArray<Readonly<Record<string, any>>> = Object.freeze([
  Object.freeze({ policyKey: "workspaceIds", factKeys: Object.freeze(["workspaceId", "workspaceIds"]) }),
  Object.freeze({ policyKey: "dataClassifications", factKeys: Object.freeze(["dataClassification", "dataClassifications"]) }),
  Object.freeze({
    policyKey: "egressClasses",
    factKeys: Object.freeze(["egressClass", "egressClasses", "requestedEgress", "requestedEgresses"]),
    dynamicRequired: true
  }),
  Object.freeze({
    policyKey: "semanticFamilies",
    factKeys: Object.freeze(["semanticFamily", "semanticFamilies", "staticSemanticFamilyId"])
  }),
  Object.freeze({
    policyKey: "capabilityDomains",
    factKeys: Object.freeze(["capabilityDomain", "capabilityDomains"]),
    dynamicRequired: true
  }),
  Object.freeze({
    policyKey: "capabilityVerbs",
    factKeys: Object.freeze(["capabilityVerb", "capabilityVerbs"]),
    dynamicRequired: true
  }),
  Object.freeze({
    policyKey: "resourceKinds",
    factKeys: Object.freeze(["resourceKind", "resourceKinds"]),
    dynamicRequired: true
  }),
  Object.freeze({ policyKey: "effectKinds", factKeys: Object.freeze(["effectKind", "effectKinds"]) }),
  Object.freeze({
    policyKey: "secretBindingIds",
    factKeys: Object.freeze(["secretBindingId", "secretBindingIds", "credentialBindingId", "credentialBindingIds"]),
    dynamicDeclarationRequired: true
  }),
  Object.freeze({ policyKey: "allowedOrigins", factKeys: Object.freeze(["origin", "origins", "allowedOrigin", "allowedOrigins"]) }),
  Object.freeze({ policyKey: "allowedCidrs", factKeys: Object.freeze(["cidr", "cidrs", "allowedCidr", "allowedCidrs"]) })
]);

function apiKeyResourceFactSources(operation: any): any[] {
  const descriptor: any = object(operation?.dynamicCapability) ? operation.dynamicCapability : null;
  return [
    operation?.resourceContext,
    operation?.resources,
    descriptor?.resourceContext,
    descriptor
  ].filter((value?: any) : any => object(value));
}

function apiKeyResourceFacts(sources: any[], factKeys: readonly string[]): string[] {
  return [...new Set<any>(sources
    .flatMap((source?: any) : any => factKeys.flatMap((key?: any) : any =>
      Array.isArray(source[key]) ? source[key] : [source[key]]
    ))
    .map((value?: any) : any => String(value || "").trim())
    .filter(Boolean))].sort();
}

export function apiKeyResourcePolicyAllowsOperation(policy: any, operation: any): boolean {
  return resourcePolicyAllowsOperation(policy, operation, null);
}

function resourcePolicyAllowsOperation(policy: any, operation: any, catalogTool: any): boolean {
  const resources: any = object(policy?.resources) ? policy.resources : {};
  const restricted = resources.mode === "restricted";
  if (!restricted && !catalogTool) return true;
  if (restricted && !API_KEY_RESOURCE_DIMENSIONS.some(({ policyKey }) =>
    Array.isArray(resources[policyKey]) && resources[policyKey].length > 0)) return false;

  const descriptor: any = object(operation?.dynamicCapability) ? operation.dynamicCapability : null;
  const dynamicCapability = catalogTool ? Boolean(catalogTool.dynamicCapability) :
    operation?.dynamicCapability === true || Boolean(descriptor) || Boolean(operation?.capabilityId);
  const sources: any[] = apiKeyResourceFactSources(operation);
  const registered = catalogTool ? apiKeyResourceFactSources(catalogTool) : null;
  if (registered && apiKeyResourceFacts([...registered, ...sources], ["serviceId", "serviceIds"])
    .some((id) => id !== catalogTool.dynamicCapability?.serviceId)) return false;
  let matchedFacts = 0;
  let registeredFacts = 0;
  for (const dimension of API_KEY_RESOURCE_DIMENSIONS) {
    const facts = apiKeyResourceFacts(sources, dimension.factKeys);
    const declares = (entries: any[]) => entries.some((source) =>
      dimension.factKeys.some((key: string) => Object.hasOwn(source, key))
    );
    if (registered) {
      const canonical = apiKeyResourceFacts(registered, dimension.factKeys);
      const declared = declares(registered);
      if ((dynamicCapability && dimension.dynamicRequired && !canonical.length) ||
          (dynamicCapability && dimension.dynamicDeclarationRequired && !declared) ||
          (declared && !sameStringSet(facts, canonical))) return false;
      registeredFacts += canonical.length;
    }
    if (dynamicCapability && dimension.dynamicRequired && !facts.length) return false;
    if (dynamicCapability && dimension.dynamicDeclarationRequired && !declares(sources)) return false;
    if (restricted && facts.length) {
      const allowed = new Set((Array.isArray(resources[dimension.policyKey]) ? resources[dimension.policyKey] : [])
        .map((value: any) => String(value || "").trim()).filter(Boolean));
      if (facts.some((fact) => !allowed.has(fact))) return false;
    }
    matchedFacts += facts.length;
  }
  return !restricted || dynamicCapability || (matchedFacts > 0 && (!registered || registeredFacts > 0));
}

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
    id: String(authorization.keyId),
    revision: `${String(authorization.keyId)}:${String(authorization.policyFingerprint)}`,
    resourceMode: resources.mode,
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

/** Canonical API Key operation facts derived from the catalog tool, never the request. */
export function apiKeyCanonicalOperation(tool: any = null): any {
  const dynamicCapability: any = object(tool?.dynamicCapability) ? tool.dynamicCapability : null;
  return {
    id: String(tool?.id || ""),
    toolId: String(tool?.id || ""),
    serviceId: String(tool?.serviceId || ""),
    capabilityId: String(dynamicCapability?.capabilityId || (tool?.id ? toolExecuteCapabilityId(tool.id) : "")),
    dynamicCapability: dynamicCapability || false,
    toolsetIds: tool?.toolsets || [],
    scopeIds: tool?.requiredScopes || [],
    risk: String(tool?.risk || ""),
    resourceContext: object(tool?.resourceContext) ? tool.resourceContext : {},
    requiredCapabilities: dynamicCapability ? [] : undefined
  };
}

function sameStringSet(actual: unknown, expected: unknown): boolean {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  const remaining = new Set(expected);
  return actual.every((id) => typeof id === "string" && remaining.delete(id)) && !remaining.size;
}

/** The operation supplies concrete facts, not a substitute catalog entry. */
function requireExactOperation(policy: any, operation: any, registry: any, toolId: string, capabilityId: string): Record<string, any> {
  const deny = () => fail("api_key_policy_denied", "API Key policy denied the operation.", 403);
  if (!toolId || !capabilityId || operation?.capabilityId !== capabilityId ||
      !policy.allowedTools.includes(toolId) || policy.deniedTools.includes(toolId)) return deny();
  const catalog = registry?.getCatalog?.();
  // Effect authorization revalidates the selected operation against the live
  // catalog rather than a whole-catalog fingerprint: unrelated catalog changes
  // must not fence an issued grant, and a policy record predating a catalog
  // change is still confined to its stored grants either way.
  requireLiveCatalog(catalog);
  const tool = catalog.tools.find((item: any) => item.id === toolId);
  const cap = object(tool?.dynamicCapability) ? tool.dynamicCapability : null;
  const binding = exactCatalogBinding(tool);
  // A tool's capability descriptor — not its governance-facing toolset
  // attachment — carries the canonical operation facts for a dynamic tool; the
  // descriptor's toolsets legitimately exceed the published catalog subset.
  const canonical: any = cap || tool || {};
  if (!binding || !matchesExactCapability(binding, capabilityId) ||
      (operation.toolId !== undefined && operation.toolId !== toolId) || (operation.id !== undefined && operation.id !== toolId) ||
      (operation.operationId !== undefined && operation.operationId !== tool.operationId) ||
      operation.risk !== canonical.risk ||
      !sameStringSet(operation.scopeIds, canonical.requiredScopes) || !sameStringSet(operation.toolsetIds, canonical.toolsets)) return deny();

  const descriptor = object(operation.dynamicCapability) ? operation.dynamicCapability : null;
  if ((operation.serviceId ?? "") !== binding.serviceId ||
      (binding.serviceId && !policy.serviceIds.includes(binding.serviceId)) ||
      (cap ? (!descriptor && operation.dynamicCapability !== true) : Boolean(operation.dynamicCapability))) return deny();
  const protocol = tool.protocol || cap?.protocol;
  const operationKey = tool.operationKey || cap?.operationKey;
  if ((operation.protocol !== undefined && operation.protocol !== protocol) ||
      (operation.operationKey !== undefined && operation.operationKey !== operationKey) ||
      (descriptor && (descriptor.capabilityId !== capabilityId || descriptor.serviceId !== binding.serviceId ||
        descriptor.operationKey !== cap.operationKey || descriptor.protocol !== cap.protocol || descriptor.risk !== cap.risk ||
        !sameStringSet(descriptor.requiredScopes, cap.requiredScopes) || !sameStringSet(descriptor.toolsets, cap.toolsets)))) return deny();

  const name = descriptor?.upstreamToolName ?? operation.upstreamToolName;
  if (operation.upstreamToolName !== undefined && name !== operation.upstreamToolName) return deny();
  if (capabilityId !== binding.id) {
    if (typeof name !== "string" || /[*?]/u.test(name) || `${binding.id}-${capabilitySegment(name)}` !== capabilityId ||
        policy.capabilityIds.includes(binding.id)) return deny();
  } else if ((name || "") !== (cap?.upstreamToolName || "") || (binding.nativeParent &&
      policy.capabilityIds.some((id: string) => id !== binding.id && matchesExactCapability(binding, id)))) return deny();

  return tool;
}

function requireAllowedOperation(policy: any, operation: any, registry: any, capabilitySelection: CapabilitySelection): void {
  const toolId: any = String(operation?.toolId || operation?.id || "");
  const serviceId: any = String(operation?.serviceId || "");
  const capabilityId: any = String(operation?.capabilityId || "");
  const expandedCapabilityIds: any[] = capabilitySelection === "exact" ? (policy.capabilityIds || []) : [...new Set<any>([
    ...(policy.capabilityIds || []),
    ...(policy.capabilityIds || [])
      .filter((value?: any) : any => String(value || "").startsWith("cap:upstream:") && String(value || "").includes(":tools-call-"))
      .map((value?: any) : any => `${String(value).slice(0, String(value).indexOf(":tools-call-"))}:tools-call`)
  ])];
  const needsCapability = capabilitySelection === "exact" || operation?.dynamicCapability === true || Boolean(capabilityId);
  if (needsCapability && (!capabilityId || !expandedCapabilityIds.includes(capabilityId))) {
    fail("api_key_policy_denied", "API Key policy denied the operation.", 403);
  }
  const exactTool = capabilitySelection === "exact" ? requireExactOperation(policy, operation, registry, toolId, capabilityId) : null;
  const dynamicCapability = exactTool ? Boolean(exactTool.dynamicCapability) : needsCapability;
  if ((dynamicCapability && !serviceId) || (!dynamicCapability && toolId && policy.deniedTools.includes(toolId))) {
    fail("api_key_policy_denied", "API Key policy denied the operation.", 403);
  }
  if (serviceId && policy.serviceIds.length > 0 && !policy.serviceIds.includes(serviceId)) {
    fail("api_key_policy_denied", "API Key policy denied the operation.", 403);
  }
  const dimensions: any[] = [
    ...(!dynamicCapability ? [[toolId, policy.allowedTools]] : []),
    [serviceId, policy.serviceIds],
    [capabilityId, expandedCapabilityIds]
  ];
  const suppliedToolsets: any[] = Array.isArray(operation?.toolsetIds) ? operation.toolsetIds : [];
  const suppliedScopes: any[] = Array.isArray(operation?.scopeIds) ? operation.scopeIds : [];
  const toolsetsDenied: any = dynamicCapability
    ? suppliedToolsets.length === 0 || !suppliedToolsets.some((value?: any) : any => policy.toolsetIds.includes(value))
    : suppliedToolsets.some((value?: any) : any => !policy.toolsetIds.includes(value));
  if (toolsetsDenied ||
      suppliedScopes.some((value?: any) : any => !policy.scopeIds.includes(value)) ||
      riskRank(operation?.risk) > riskRank(policy.maximumRisk)) {
    fail("api_key_policy_denied", "API Key policy denied the operation.", 403);
  }
  const positiveAuthority: any = dimensions.some(([fact, allowed]) => fact && allowed.includes(fact)) ||
    suppliedToolsets.some((value?: any) : any => policy.toolsetIds.includes(value)) ||
    suppliedScopes.some((value?: any) : any => policy.scopeIds.includes(value));
  if (!positiveAuthority) fail("api_key_policy_denied", "API Key policy denied the operation.", 403);
  if (!resourcePolicyAllowsOperation(policy, operation, exactTool)) {
    fail("api_key_policy_denied", "API Key resource policy denied the operation.", 403);
  }
}

/** Capability selection is fixed by the owner, never by an issuance or effect request. */
export function createApiKeyDistributionWorkerOwner({
  store,
  registry = null,
  capabilitySelection = "catalog",
  securityPermissions = null,
  verifierKeyProvider,
  now = () : any => Date.now(),
  randomBytes = (size: number) : any => crypto.randomBytes(size)
}: Record<string, any> & { capabilitySelection?: CapabilitySelection } = {}): any {
  if (capabilitySelection !== "catalog" && capabilitySelection !== "exact") {
    throw new TypeError("Invalid API Key capability selection mode.");
  }
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
    const candidate: any = await Promise.resolve(verifierKeyProvider.getKey(generation));
    const key: any = candidate instanceof Uint8Array ? Buffer.from(candidate) : null;
    if (!key || key.length < 32) {
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
    const policy: any = normalizePolicy(input.policy, registry, capabilitySelection);
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
    if (status && !(API_KEY_READ_STATUSES as readonly string[]).includes(status)) fail("api_key_input_invalid", "status is invalid.");
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
        WHEN status = 'active' AND claimed_at IS NULL AND created_at <= ? THEN 'unclaimed'
        ELSE status END) = ?`);
      parameters.push(new Date(now()).toISOString(),
        new Date(now() - API_KEY_UNCLAIMED_WINDOW_MS).toISOString(), status);
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

  function listAudienceGrants(input: Record<string, any> = {}): any {
    exactKeys(input, []);
    const rows: any[] = db.prepare("SELECT * FROM api_key_records WHERE status = 'active' ORDER BY key_id ASC").all();
    return Object.freeze(rows
      .map((row?: any) : any => recordFromRow(row, now()))
      .filter((record?: any) : any => record.status === "active")
      .map((record?: any) : any => Object.freeze({
        id: record.workloadPrincipalId,
        type: "scoped-api-key",
        subjectId: record.workloadPrincipalId,
        organizationId: record.organizationNodeId,
        scopes: Object.freeze([...(record.policy?.scopeIds || [])]),
        toolsets: Object.freeze([...(record.policy?.toolsetIds || [])]),
        dynamicCapabilities: Object.freeze([...(record.policy?.capabilityIds || [])]),
        allowedServiceIds: Object.freeze([...(record.policy?.serviceIds || [])]),
        allowedSecretBindings: Object.freeze([...(record.policy?.resources?.secretBindingIds || [])]),
        maxRisk: ({ low: "read_only", medium: "safe_write", high: "repair_write" } as Record<string, string>)[record.policy?.maximumRisk] || "read_only",
        status: "active"
      })));
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
    // Exhaustion prevents new admissions, not administrator revocation of
    // authority already consumed by a durable queued admission.
    if (!["active", "exhausted"].includes(recordFromRow(row, now()).status)) errorForInactive(recordFromRow(row, now()));
    const revokedAt: any = new Date(now()).toISOString();
    const result: any = db.transaction(() : any => {
      const currentScopes: any = authority(text(input.subjectId, "subjectId", 256));
      if (canonicalJson(currentScopes.revision) !== canonicalJson(scopes.revision)) {
        fail("api_key_authority_stale", "API Key issuer authority changed.", 409);
      }
      assertApiKeyIssuerTarget(currentScopes, row.organization_node_id);
      const update: any = db.prepare(`UPDATE api_key_records SET status = 'revoked', revoked_at = ?,
        lifecycle_revision = lifecycle_revision + 1
        WHERE key_id = ? AND status IN ('active', 'exhausted') AND lifecycle_revision = ?`)
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

  async function authenticateCredential(input: Record<string, any>): Promise<any> {
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
      if (row.status === "active" && ["expired", "exhausted", "unclaimed"].includes(record.status)) {
        // "unclaimed" settles to the stored "expired" status — the stored
        // CHECK only permits the four lifecycle statuses; the event reason
        // preserves that the key died unclaimed.
        const storedStatus: any = record.status === "unclaimed" ? "expired" : record.status;
        db.transaction(() : any => {
          const update: any = db.prepare(`UPDATE api_key_records SET status = ?, lifecycle_revision = lifecycle_revision + 1
            WHERE key_id = ? AND status = 'active' AND lifecycle_revision = ?`)
            .run(storedStatus, row.key_id, row.lifecycle_revision);
          if (update.changes === 1) {
            const current: any = getRow(row.key_id);
            emitEvent(current, storedStatus, `api_key_${record.status}`, current.organization_revision_at_issue);
          }
        })();
      }
      errorForInactive(record);
    }
    const presentedTargetId: string = String(input.targetId || "").trim();
    const presentedConnectorPackageId: string = String(input.connectorPackageId || "").trim();
    const targetIds: any[] = Array.isArray(record.policy.audience.targetIds) ? record.policy.audience.targetIds : [];
    const connectorPackageIds: any[] = Array.isArray(record.policy.audience.connectorPackageIds)
      ? record.policy.audience.connectorPackageIds
      : [];
    if (record.policy.audience.serverAudience !== String(input.serverAudience || "") ||
        (presentedTargetId && targetIds.length > 0 && !targetIds.includes(presentedTargetId)) ||
        (presentedConnectorPackageId && connectorPackageIds.length > 0 &&
          !connectorPackageIds.includes(presentedConnectorPackageId))) {
      fail("api_key_policy_denied", "API Key audience is not allowed.", 403);
    }
    const { nodesById } = currentNodes();
    if (!nodesById.has(record.organizationNodeId) ||
        organizationLineageDigest(record.organizationNodeId, nodesById) !== record.organizationLineageDigest) {
      fail("api_key_inactive", "API Key organization lineage changed.", 410);
    }
    if (!row.claimed_at) {
      // First fully successful authentication claims the key. One write ever
      // per key; claimed rows skip this entirely via the in-memory check.
      db.prepare("UPDATE api_key_records SET claimed_at = ? WHERE key_id = ? AND claimed_at IS NULL")
        .run(new Date(now()).toISOString(), row.key_id);
    }
    return record;
  }

  // Admission identifies possession only. This shape deliberately excludes
  // policy, process evidence and authorization revisions usable by an effect.
  async function authenticateAdmission(input: Record<string, any> = {}): Promise<any> {
    exactKeys(input, ["credential", "serverAudience", "targetId", "connectorPackageId"]);
    const record = await authenticateCredential(input);
    return Object.freeze({
      credentialKind: "api-key-admission",
      subjectId: record.workloadPrincipalId,
      tenantId: record.organizationNodeId
    });
  }

  async function authenticateRuntime(input: Record<string, any> = {}): Promise<any> {
    exactKeys(input, ["credential", "serverAudience", "targetId", "connectorPackageId", "processIdentityEvidence"]);
    const record = await authenticateCredential(input);
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
  }

  async function reserveEffect(input: Record<string, any> = {}): Promise<any> {
    exactKeys(input, ["authorization", "operation"]);
    const timestamp: any = now();
    const leaseId: any = `akl_${crypto.randomUUID()}`;
    const result: any = db.transaction(() : any => {
      const { row, record } = assertAuthorizationCurrent(input.authorization);
      requireAllowedOperation(record.policy, input.operation, registry, capabilitySelection);
      cleanupExpiredEphemeralState(timestamp);
      db.prepare("DELETE FROM api_key_usage_windows WHERE key_id = ? AND expires_at <= ?").run(row.key_id, timestamp);
      const windowMs: any = record.policy.limits.windowSeconds * 1000;
      const windowStart: any = Math.floor(timestamp / windowMs) * windowMs;
      const usage: any = db.prepare("SELECT request_count FROM api_key_usage_windows WHERE key_id = ? AND window_start = ?")
        .get(row.key_id, windowStart);
      if (Number(usage?.request_count || 0) >= record.policy.limits.requestsPerWindow) {
        fail("api_key_rate_limited", "API Key rate limit reached.", 429);
      }
      const leases: any = db.prepare("SELECT count(*) AS count FROM api_key_effect_leases WHERE key_id = ?")
        .get(row.key_id);
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
        (key_id, lease_id, lifecycle_revision, policy_fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run(row.key_id, leaseId, record.lifecycleRevision, record.policyFingerprint, new Date(timestamp).toISOString());
      return Object.freeze({
        keyId: row.key_id,
        leaseId,
        lifecycleRevision: record.lifecycleRevision,
        policyFingerprint: record.policyFingerprint
      });
    })();
    return result;
  }

  function authorizeOperation(input: Record<string, any> = {}): any {
    exactKeys(input, ["authorization", "operation"]);
    const authorization = revalidateAuthorization(input.authorization);
    requireAllowedOperation(authorization.policy, input.operation, registry, capabilitySelection);
    return authorization;
  }

  async function revalidateEffect(lease: any): Promise<any> {
    if (!object(lease)) fail("api_key_revision_stale", "API Key effect lease is invalid.", 409);
    const activeLease: any = db.prepare(`SELECT * FROM api_key_effect_leases
      WHERE key_id = ? AND lease_id = ?`).get(String(lease.keyId || ""), String(lease.leaseId || ""));
    if (!activeLease) fail("api_key_revision_stale", "API Key effect reservation is unavailable.", 409);
    return revalidateAdmittedAuthorization({
      keyId: activeLease.key_id,
      lifecycleRevision: activeLease.lifecycle_revision,
      policyFingerprint: activeLease.policy_fingerprint
    });
  }

  function revalidateAdmittedAuthorization(snapshot: any): any {
    const row: any = getRow(snapshot.keyId);
    const record: any = recordFromRow(row, now());
    // Exhaustion caused by this reservation is allowed; all other terminal/lifecycle changes fence it.
    if (!record || (row && Date.parse(row.expires_at) <= now()) || !["active", "exhausted"].includes(record.status) ||
        row.status === "revoked" || row.status === "expired" ||
        record.lifecycleRevision !== snapshot.lifecycleRevision ||
        record.policyFingerprint !== snapshot.policyFingerprint) {
      if (row && Date.parse(row.expires_at) <= now()) {
        fail("api_key_inactive", "API Key expired before effect.", 410);
      }
      fail("api_key_revision_stale", "API Key lifecycle changed before effect.", 409);
    }
    const { nodesById } = currentNodes();
    if (!nodesById.has(record.organizationNodeId) ||
        organizationLineageDigest(record.organizationNodeId, nodesById) !== record.organizationLineageDigest) {
      fail("api_key_inactive", "API Key organization lineage changed.", 410);
    }
    return Object.freeze({
      credentialKind: "scoped_api_key",
      keyId: record.keyId,
      workloadPrincipalId: record.workloadPrincipalId,
      organizationNodeId: record.organizationNodeId,
      organizationLineageDigest: record.organizationLineageDigest,
      lifecycleRevision: record.lifecycleRevision,
      policyFingerprint: record.policyFingerprint,
      policy: record.policy
    });
  }

  function revalidateDeferredAuthorization(snapshot: any): any {
    exactKeys(snapshot, [
      "keyId", "lifecycleRevision", "policyFingerprint", "workloadPrincipalId",
      "organizationNodeId", "organizationLineageDigest"
    ]);
    const current = revalidateAdmittedAuthorization(snapshot);
    if (current.workloadPrincipalId !== snapshot.workloadPrincipalId ||
        current.organizationNodeId !== snapshot.organizationNodeId ||
        current.organizationLineageDigest !== snapshot.organizationLineageDigest) {
      fail("api_key_revision_stale", "API Key admitted task identity changed.", 409);
    }
    return current;
  }

  async function releaseEffect(lease: any): Promise<void> {
    if (!object(lease)) return;
    db.prepare("DELETE FROM api_key_effect_leases WHERE key_id = ? AND lease_id = ?")
      .run(String(lease.keyId || ""), String(lease.leaseId || ""));
  }

  function explainLookupPlan(): any[] {
    return db.prepare("EXPLAIN QUERY PLAN SELECT * FROM api_key_records WHERE key_id = ?").all("_probe_");
  }

  function close(): void {
    db.prepare("DELETE FROM api_key_effect_leases").run();
  }

  return Object.freeze({
    getIssuerScopes,
    list,
    listAudienceGrants,
    create,
    rotate,
    revoke,
    authenticateAdmission,
    authenticateRuntime,
    revalidateAuthorization,
    authorizeOperation,
    reserveEffect,
    revalidateEffect,
    revalidateDeferredAuthorization,
    releaseEffect,
    close,
    explainLookupPlan
  });
}
