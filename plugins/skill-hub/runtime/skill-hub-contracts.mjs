import { createHash } from "node:crypto";

export const WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION = "v0.0.1:workspace:contribution-2";
export const SANDBOX_CONFIGURED_WORKLOAD_REQUEST_SCHEMA = "v0.0.1:execution-sandbox:configured-workload-request-1";
export const SANDBOX_CUSTODY_PROMOTION_SCHEMA = "v0.0.1:execution-sandbox:opaque-custody-promotion-1";
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const DIGEST = /^[a-f0-9]{64}$/u;
const CUSTODY_HANDLE = /^custody:[A-Za-z0-9._-]{1,160}$/u;

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

function boundedText(value, label, maximum = 512) {
  const normalized = text(value);
  if (!normalized || normalized.length > maximum || normalized.includes("\0")) throw new TypeError(`${label} must be a bounded non-empty string.`);
  return normalized;
}

function digest(value, label) {
  const normalized = boundedText(value, label, 64).toLowerCase();
  if (!DIGEST.test(normalized)) throw new TypeError(`${label} must be a SHA-256 digest.`);
  return normalized;
}

export function custodyPromotionSetDigest({ files } = {}) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 100) throw new TypeError("Custody promotion files must be a non-empty bounded array.");
  const normalizedFiles = files.map((file, index) => {
    if (!file || typeof file !== "object" || Array.isArray(file) || file.promotionSchemaVersion !== SANDBOX_CUSTODY_PROMOTION_SCHEMA) {
      throw new TypeError(`Custody promotion file ${index} is invalid.`);
    }
    const custodyRef = boundedText(file.custodyRef, `files[${index}].custodyRef`, 168);
    if (!CUSTODY_HANDLE.test(custodyRef)) throw new TypeError("Custody handle is invalid.");
    return Object.freeze({
      path: boundedText(file.path, `files[${index}].path`, 1024),
      custodyRef,
      contentDigest: digest(file.contentDigest, `files[${index}].contentDigest`),
      envelopeDigest: digest(file.envelopeDigest, `files[${index}].envelopeDigest`),
      promotionSchemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA
    });
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(normalizedFiles.map((file) => file.path)).size !== normalizedFiles.length) throw new TypeError("Custody promotion file paths must be unique.");
  return sandboxDigest({ promotionSchemaVersion: SANDBOX_CUSTODY_PROMOTION_SCHEMA, files: normalizedFiles });
}
