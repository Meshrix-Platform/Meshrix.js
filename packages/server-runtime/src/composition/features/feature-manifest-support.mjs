export const DEFAULT_EDITION = "core";

export const CORE_FEATURE_INCLUDES = Object.freeze([
  "operation-permission-core",
  "downstream-mcp",
  "upstream-gateway",
  "agent-memory",
  "strategy-management",
  "work-queue-core",
  "agent-gateway",
  "external-gateway"
]);

export const STANDARD_FEATURE_INCLUDES = Object.freeze([
  ...CORE_FEATURE_INCLUDES
]);

export const INTEGRATIONS_FEATURE_INCLUDES = Object.freeze([
  ...STANDARD_FEATURE_INCLUDES
]);

export function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function objectFromEntries(entries = []) {
  const result = {};
  for (const [key, value] of entries) {
    result[key] = value;
  }
  return result;
}
