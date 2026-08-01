export const DEFAULT_EDITION: any = "core";

export const CORE_FEATURE_INCLUDES: readonly any[] = Object.freeze([
  "operation-permission-core",
  "downstream-mcp",
  "upstream-gateway",
  "agent-memory",
  "strategy-management",
  "work-queue-core",
  "agent-gateway",
  "external-gateway"
]);

export const STANDARD_FEATURE_INCLUDES: readonly any[] = Object.freeze([
  ...CORE_FEATURE_INCLUDES
]);

export const INTEGRATIONS_FEATURE_INCLUDES: readonly any[] = Object.freeze([
  ...STANDARD_FEATURE_INCLUDES
]);

export function uniqueStrings(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => String(value || "").trim()).filter(Boolean))];
}

export function objectFromEntries(entries: any = []) : any {
  const result: Record<string, any> = {};
  for (const [key, value] of entries) {
    result[key] = value;
  }
  return result;
}
