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
