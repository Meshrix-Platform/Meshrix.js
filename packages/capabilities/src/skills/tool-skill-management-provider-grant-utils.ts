export function nowIso() : any {
  return new Date().toISOString();
}

export function normalizeGrantTargets(value?: any) : any {
  const items: any = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set<any>(items.map((item?: any) : any => String(item || "").trim()).filter(Boolean))].slice(0, 16);
}

export function normalizeGrantValues(value?: any, limit: any = 64) : any {
  const items: any = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set<any>(items.map((item?: any) : any => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

export function intersectGrantValues(requestedValue?: any, allowedValue?: any, limit: any = 64) : any {
  const allowed: any = normalizeGrantValues(allowedValue, limit);
  const requested: any = normalizeGrantValues(requestedValue, limit);
  if (requested.length === 0) {
    return allowed;
  }
  const allowedSet: any = new Set<any>(allowed);
  return requested.filter((item?: any) : any => allowedSet.has(item));
}

export function grantMetadata(grant?: any) : any {
  return grant?.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
}

const GRANT_RISK_RANK: Readonly<Record<string, number>> = Object.freeze({
  read_only: 0,
  safe_write: 1,
  repair_write: 2,
  destructive: 3
});

function grantRiskRank(risk: any = "read_only") : number {
  return GRANT_RISK_RANK[String(risk || "read_only")] ?? 0;
}

export function grantVisibleRisk(grant: any = null) : string {
  const metadata: any = grantMetadata(grant);
  return String(metadata.maxRisk || grant?.maxRisk || "read_only").trim() || "read_only";
}

export function grantCanSeeTool(tool?: any, grant: any = null) : boolean {
  if (!tool || tool.status !== "active" || !grant) return false;
  const deniedTools: any = new Set<any>(normalizeGrantValues(grant.toolDeny || [], 256));
  if (deniedTools.has(tool.id)) return false;
  const allowedTools: any = new Set<any>(normalizeGrantValues(grant.toolAllow || [], 256));
  if (allowedTools.size > 0 && !allowedTools.has(tool.id)) return false;
  const grantScopes: any = new Set<any>(normalizeGrantValues(grant.scopes || [], 512));
  if ((tool.requiredScopes || []).some((scope?: any) : any => !grantScopes.has(scope))) return false;
  const grantToolsets: any = new Set<any>(normalizeGrantValues(grant.toolsets || [], 256));
  if (grantToolsets.size > 0 && !(tool.toolsets || []).some((toolset?: any) : any => grantToolsets.has(toolset))) {
    return false;
  }
  if (grantRiskRank(tool.risk) > grantRiskRank(grantVisibleRisk(grant))) return false;
  const dynamicCapability: any = tool.dynamicCapability && typeof tool.dynamicCapability === "object" && !Array.isArray(tool.dynamicCapability)
    ? tool.dynamicCapability
    : null;
  if (!dynamicCapability) return true;
  const metadata: any = grantMetadata(grant);
  const dynamicCapabilities: any = new Set<any>([
    ...normalizeGrantValues(grant.dynamicCapabilities || [], 512),
    ...normalizeGrantValues(grant.upstreamCapabilities || [], 512),
    ...normalizeGrantValues(metadata.dynamicCapabilities || [], 512),
    ...normalizeGrantValues(metadata.upstreamCapabilities || [], 512)
  ]);
  const capabilityId: any = String(dynamicCapability.capabilityId || "").trim();
  if (!capabilityId || !dynamicCapabilities.has(capabilityId)) return false;
  const allowedServiceIds: any = new Set<any>([
    ...normalizeGrantValues(grant.allowedServiceIds || [], 512),
    ...normalizeGrantValues(metadata.allowedServiceIds || [], 512)
  ]);
  if (allowedServiceIds.size > 0 && !allowedServiceIds.has(String(dynamicCapability.serviceId || ""))) return false;
  const allowedSecretBindings: any = new Set<any>([
    ...normalizeGrantValues(grant.allowedSecretBindings || [], 512),
    ...normalizeGrantValues(metadata.allowedSecretBindings || [], 512)
  ]);
  return normalizeGrantValues(dynamicCapability.credentialBindingIds || [], 128).every((bindingId?: any) : any =>
    allowedSecretBindings.has(bindingId) || dynamicCapabilities.has(`${capabilityId}:${bindingId}`)
  );
}

export function normalizedTargetKey(value?: any) : any {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

export function normalizedGrantTargetKeys(value?: any) : any {
  return normalizeGrantTargets(value)
    .map((target?: any) : any => normalizedTargetKey(target))
    .filter(Boolean)
    .filter((target?: any, index?: any, values?: any) : any => values.indexOf(target) === index);
}

export function compactText(value?: any) : any {
  return String(value || "").trim();
}

export function positiveInteger(value?: any, fallback: any = 0) : any {
  const parsed: any = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function parseTime(value: any = "") : any {
  const parsed: any = Date.parse(compactText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}
