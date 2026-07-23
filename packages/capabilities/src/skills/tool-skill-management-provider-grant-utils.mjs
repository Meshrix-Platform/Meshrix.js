export function nowIso() {
  return new Date().toISOString();
}

export function normalizeGrantTargets(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 16);
}

export function normalizeGrantValues(value, limit = 64) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

export function intersectGrantValues(requestedValue, allowedValue, limit = 64) {
  const allowed = normalizeGrantValues(allowedValue, limit);
  const requested = normalizeGrantValues(requestedValue, limit);
  if (requested.length === 0) {
    return allowed;
  }
  const allowedSet = new Set(allowed);
  return requested.filter((item) => allowedSet.has(item));
}

export function grantMetadata(grant) {
  return grant?.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
}

export function normalizedTargetKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

export function normalizedGrantTargetKeys(value) {
  return normalizeGrantTargets(value)
    .map((target) => normalizedTargetKey(target))
    .filter(Boolean)
    .filter((target, index, values) => values.indexOf(target) === index);
}

export function compactText(value) {
  return String(value || "").trim();
}

export function positiveInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function parseTime(value = "") {
  const parsed = Date.parse(compactText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

