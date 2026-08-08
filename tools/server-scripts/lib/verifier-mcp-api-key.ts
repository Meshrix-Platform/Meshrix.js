import {
  authHeaders,
  installAuthenticatedFetch,
  installedAuthFor
} from "../test-auth-helper.ts";

const consoleAuthByOrigin: any = new Map<any, any>();
const organizationPublicationByOrigin: any = new Map<any, Promise<any>>();

function responseError(payload: Record<string, any> = {}, fallback: any = "request failed") : any {
  return String(payload?.error?.message || payload?.error?.code || payload?.error || fallback);
}

async function requestJson(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(url, options);
  const text: any = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

async function resolveConsoleAuth(server?: any, suppliedAuth: any = null) : Promise<any> {
  if (suppliedAuth?.cookie && suppliedAuth?.csrf) return suppliedAuth;
  if (!server?.url) throw new Error("Verifier API Key issuance requires a real Console session.");
  const origin: any = new URL(server.url).origin;
  if (!consoleAuthByOrigin.has(origin)) {
    consoleAuthByOrigin.set(
      origin,
      installedAuthFor(server) || await installAuthenticatedFetch(server, { setProcessEnv: false })
    );
  }
  return consoleAuthByOrigin.get(origin);
}

async function ensurePublishedOrganizationScope(serviceUrl: string, authenticated: any): Promise<any> {
  const origin: any = new URL(serviceUrl).origin;
  if (!organizationPublicationByOrigin.has(origin)) {
    organizationPublicationByOrigin.set(origin, (async () : Promise<any> => {
      const readHeaders: any = authHeaders(authenticated, { method: "GET" });
      const current: any = await requestJson(`${serviceUrl}/api/authorization/organization-governance`, {
        headers: readHeaders
      });
      if (current.status !== 200 || !current.payload?.snapshot) {
        throw new Error(`Verifier organization lookup failed: ${responseError(current.payload, `HTTP ${current.status}`)}`);
      }
      if (current.payload.snapshot.configured === true) return current.payload.snapshot;

      const imported: any = await requestJson(`${serviceUrl}/api/authorization/organization-governance/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(authenticated, { method: "POST", safetyConfirm: false })
        },
        body: JSON.stringify({ templateKey: "enterprise-group" })
      });
      if (imported.status !== 200 || !imported.payload?.draft) {
        throw new Error(`Verifier organization import failed: ${responseError(imported.payload, `HTTP ${imported.status}`)}`);
      }
      const published: any = await requestJson(`${serviceUrl}/api/authorization/organization-governance/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(authenticated, { method: "POST", safetyConfirm: true })
        },
        body: JSON.stringify({
          ...imported.payload.draft,
          expectedRevision: Number(current.payload.snapshot.revision || 0)
        })
      });
      if (published.status !== 200 || published.payload?.snapshot?.configured !== true) {
        throw new Error(`Verifier organization publication failed: ${responseError(published.payload, `HTTP ${published.status}`)}`);
      }
      return published.payload.snapshot;
    })());
  }
  try {
    return await organizationPublicationByOrigin.get(origin);
  } finally {
    organizationPublicationByOrigin.delete(origin);
  }
}

function toolMatchesAccess(tool: Record<string, any> = {}, access: Record<string, any> = {}) : any {
  const selectedToolsets: any = new Set<any>(access.toolsets || []);
  const selectedServices: any = new Set<any>(access.allowedServiceIds || []);
  const selectedCapabilities: any = new Set<any>(access.dynamicCapabilities || []);
  if (Array.isArray(access.allowedTools) && access.allowedTools.includes(tool.id)) return true;
  if ((tool.toolsets || []).some((value?: any) : any => selectedToolsets.has(value))) return true;
  if (tool.serviceId && selectedServices.has(tool.serviceId)) return true;
  if (tool.capabilityId && selectedCapabilities.has(tool.capabilityId)) return true;
  return false;
}

function stringValues(...candidates: any[]): any[] {
  return [...new Set<any>(candidates
    .flatMap((candidate?: any) : any => Array.isArray(candidate) ? candidate : [])
    .map((value?: any) : any => String(value || "").trim())
    .filter(Boolean))];
}

function verifierMaximumRisk(value?: any) : any {
  const normalized: any = String(value || "").trim();
  if (["high", "repair_write"].includes(normalized)) return "high";
  if (["medium", "safe_write", "write"].includes(normalized)) return "medium";
  return "low";
}

function verifierResourcePolicy(access: Record<string, any> = {}) : any {
  const supplied: any = access.resources && typeof access.resources === "object"
    ? access.resources
    : {};
  const resources: any = {
    workspaceIds: stringValues(supplied.workspaceIds, access.workspaceIds, access.allowedWorkspaceIds),
    dataClassifications: stringValues(supplied.dataClassifications, access.dataClassifications, access.allowedDataClasses),
    egressClasses: stringValues(supplied.egressClasses, access.egressClasses, access.allowedEgress),
    semanticFamilies: stringValues(supplied.semanticFamilies, access.semanticFamilies, access.allowedStaticSemanticFamilies),
    capabilityDomains: stringValues(supplied.capabilityDomains, access.capabilityDomains, access.allowedCapabilityDomains),
    capabilityVerbs: stringValues(supplied.capabilityVerbs, access.capabilityVerbs, access.allowedCapabilityVerbs),
    resourceKinds: stringValues(supplied.resourceKinds, access.resourceKinds, access.allowedResourceKinds),
    effectKinds: stringValues(supplied.effectKinds, access.effectKinds, access.allowedEffectKinds),
    secretBindingIds: stringValues(supplied.secretBindingIds, access.secretBindingIds, access.allowedSecretBindings),
    allowedOrigins: stringValues(supplied.allowedOrigins, access.allowedOrigins),
    allowedCidrs: stringValues(supplied.allowedCidrs, access.allowedCidrs)
  };
  const hasRestriction: any = (Object.values(resources) as any[])
    .some((values?: any) : any => values.length > 0);
  return {
    mode: supplied.mode === "restricted" || access.resourceMode === "restricted" || hasRestriction
      ? "restricted"
      : "unrestricted",
    ...resources
  };
}

export async function issueVerifierMcpApiKey({
  server = null,
  baseUrl = "",
  consoleAuth = null,
  access = {}
}: Record<string, any> = {}) : Promise<any> {
  const serviceUrl: any = String(server?.url || baseUrl || "").replace(/\/+$/u, "");
  if (!serviceUrl) throw new Error("Verifier API Key issuance requires a server URL.");
  const authenticated: any = await resolveConsoleAuth(server, consoleAuth);
  const headers: any = authHeaders(authenticated, { method: "GET" });
  await ensurePublishedOrganizationScope(serviceUrl, authenticated);
  let scopes: any = null;
  for (let attempt: any = 0; attempt < 10; attempt += 1) {
    scopes = await requestJson(`${serviceUrl}/api/operation-permission/v1/api-keys/issuer-scopes`, { headers });
    if (scopes.status !== 200 || scopes.payload?.eligibleNodes?.length) break;
    await new Promise((resolve?: any) : any => setTimeout(resolve, 25));
  }
  const catalog: any = await requestJson(`${serviceUrl}/api/operation-permission/v1/catalog`, { headers });
  if (scopes.status !== 200 || !scopes.payload?.catalogFingerprint) {
    throw new Error(`Verifier API Key issuer scope lookup failed: ${responseError(scopes.payload, `HTTP ${scopes.status}`)}`);
  }
  if (catalog.status !== 200 || !Array.isArray(catalog.payload?.tools)) {
    throw new Error(`Verifier API Key catalog lookup failed: ${responseError(catalog.payload, `HTTP ${catalog.status}`)}`);
  }
  const organizationNodeId: any = String(
    access.organizationNodeId || scopes.payload.eligibleNodes?.[0]?.nodeId || ""
  );
  if (!organizationNodeId) throw new Error("Verifier API Key issuance has no eligible organization scope.");
  const selectedTools: any[] = catalog.payload.tools
    .filter((tool?: any) : any => toolMatchesAccess(tool, access));
  const allowedTools: any[] = selectedTools
    .map((tool?: any) : any => String(tool.id || ""))
    .filter(Boolean);
  if (!allowedTools.length) {
    throw new Error("Verifier API Key access selection did not resolve any current catalog tool.");
  }
  const resources: any = verifierResourcePolicy(access);
  const selectedScopes: any[] = selectedTools
    .flatMap((tool?: any) : any => tool.requiredScopes || tool.scopes || []);
  const created: any = await requestJson(`${serviceUrl}/api/operation-permission/v1/api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(authenticated, { method: "POST", safetyConfirm: true })
    },
    body: JSON.stringify({
      workloadDisplayName: String(access.label || access.connectorVersion || "Verifier MCP workload").slice(0, 120),
      organizationNodeId,
      expiresAt: new Date(Date.now() + Math.min(Number(access.expiresInMs) || 15 * 60_000, 60 * 60_000)).toISOString(),
      policy: {
        protocol: "mcp",
        serviceIds: [...new Set<any>(access.allowedServiceIds || [])],
        capabilityIds: [...new Set<any>(access.dynamicCapabilities || [])],
        toolsetIds: [...new Set<any>(access.toolsets || [])],
        allowedTools,
        deniedTools: [],
        scopeIds: stringValues(access.scopeIds, access.scopes, selectedScopes),
        maximumRisk: verifierMaximumRisk(access.maxRisk),
        audience: {
          serverAudience: new URL(serviceUrl).host,
          targetIds: [...new Set<any>(access.targets || ["codex"])],
          connectorPackageIds: []
        },
        resources,
        processIdentity: { mode: "optional" },
        limits: {
          maxUses: Math.max(1, Number(access.maxUses) || 256),
          requestsPerWindow: Math.max(1, Number(access.requestsPerWindow) || 256),
          windowSeconds: 3600,
          maxConcurrentEffects: Math.max(1, Number(access.maxConcurrentEffects) || 8)
        },
        catalogFingerprint: scopes.payload.catalogFingerprint
      }
    })
  });
  if (created.status !== 201 || !created.payload?.apiKey || !created.payload?.record?.keyId) {
    throw new Error(`Verifier API Key issuance failed: ${responseError(created.payload, `HTTP ${created.status}`)}`);
  }
  return Object.freeze({
    apiKey: String(created.payload.apiKey),
    record: Object.freeze({
      keyId: String(created.payload.record.keyId),
      workloadPrincipalId: String(created.payload.record.workloadPrincipalId || ""),
      lifecycleRevision: Number(created.payload.record.lifecycleRevision || 0)
    })
  });
}

export function verifierMcpApiKeyHeaders({
  apiKey = "",
  target = "codex",
  extraHeaders = {}
}: Record<string, any> = {}) : any {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { "X-Meshrix.js-Api-Key": apiKey } : {}),
    "X-Meshrix.js-MCP-Target": target,
    ...extraHeaders
  };
}

export function createVerifierApiKeyAccess({
  target = "codex",
  label = "verifier"
}: Record<string, any> = {}) : any {
  return Object.freeze({ target: String(target), label: String(label) });
}

export function bindVerifierApiKey({
  identityByToken,
  token,
  record = null
}: Record<string, any> = {}) : any {
  if (!identityByToken || !token) return;
  identityByToken.set(token, Object.freeze({
    credentialKind: "scoped_api_key",
    keyId: String(record?.keyId || "")
  }));
}

export function verifierMcpRequestHeaders({
  token = "",
  target = "codex",
  extraHeaders = {}
}: Record<string, any> = {}) : any {
  return verifierMcpApiKeyHeaders({ apiKey: token, target, extraHeaders });
}
