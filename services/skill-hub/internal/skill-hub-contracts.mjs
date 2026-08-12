import { createHash } from "node:crypto";

export const WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION = "v0.0.1:workspace:contribution-2";
export const SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA = "v0.0.1:execution-sandbox:configured-workload-request-1";
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

export function text(value) { return String(value ?? "").trim(); }
export function shallowObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
export function hash(value, length = 20) { return createHash("sha256").update(String(value || "")).digest("hex").slice(0, length); }
export function stableId(prefix, input) { return `${prefix}::${hash(JSON.stringify(input))}`; }
export function nowIso() { return new Date().toISOString(); }

export function stableJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function normalizeVisibility(value) {
  const normalized = text(value || "workspace");
  return ["private", "workspace", "public", "restricted"].includes(normalized) ? normalized : "workspace";
}

export function clone(value) { return JSON.parse(JSON.stringify(value)); }

export function refreshSkillHubMetrics(contribution, { assetRecordProjector } = {}) {
  contribution.grants = asArray(contribution.grants);
  contribution.permissionRequests = asArray(contribution.permissionRequests);
  contribution.downloadEvents = asArray(contribution.downloadEvents);
  contribution.usageEvents = asArray(contribution.usageEvents);
  contribution.executionReceipts = asArray(contribution.executionReceipts);
  contribution.reviews = asArray(contribution.reviews);
  contribution.adoptions = asArray(contribution.adoptions);
  contribution.assetRecords = asArray(contribution.assetRecords).map(assetRecordProjector);
  const adoptionWorkspaces = new Set([
    ...contribution.usageEvents.map((event) => event.workspaceId).filter(Boolean),
    ...contribution.adoptions.map((event) => event.targetWorkspaceId).filter(Boolean),
    ...contribution.grants.map((event) => event.targetWorkspaceId).filter(Boolean)
  ]);
  const metrics = contribution.metrics;
  metrics.usageCount = contribution.usageEvents.length;
  metrics.successfulUseCount = contribution.executionReceipts.filter((receipt) => receipt.status === "succeeded").length;
  metrics.uniqueWorkspaceAdoptions = adoptionWorkspaces.size;
  metrics.executionCount = contribution.executionReceipts.length;
  metrics.permissionRequestCount = contribution.permissionRequests.length;
  metrics.permissionGrantCount = contribution.grants.length;
  metrics.downloadCount = contribution.downloadEvents.length;
  metrics.reviewCount = contribution.reviews.length;
  metrics.revocationCount = asArray(contribution.statusHistory).filter((event) => event.state === "revoked").length;
  metrics.successRate = metrics.executionCount > 0 ? metrics.successfulUseCount / metrics.executionCount : 0;
  metrics.rankScore = metrics.usageCount + metrics.executionCount * metrics.successRate + metrics.uniqueWorkspaceAdoptions +
    metrics.downloadCount * 0.5 + metrics.reviewCount + metrics.permissionGrantCount - metrics.rollbackCount - metrics.revocationCount;
  return contribution;
}

export function sandboxDigest(value) { return createHash("sha256").update(stableJson(value)).digest("hex"); }
