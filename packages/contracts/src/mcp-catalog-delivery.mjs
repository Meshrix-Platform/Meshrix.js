export const MCP_CATALOG_DELIVERY_SCHEMA_VERSION = "v0.0.1:mcp-catalog-delivery:wire-1";
export const MCP_CATALOG_LIST_CHANGED_CAPABILITY = "upstream.catalog.list_changed";
export const MCP_CATALOG_LIST_CHANGED_METHOD = "notifications/tools/list_changed";
export const MCP_CATALOG_ACKNOWLEDGE_METHOD = "meshrix/catalog/acknowledge";
export const MCP_PROXY_SESSION_HEADER = "X-Meshrix-Mcp-Proxy-Session";
export const MCP_PROXY_SESSION_HEADER_LOWER = MCP_PROXY_SESSION_HEADER.toLowerCase();
export const MCP_PROXY_SESSION_MAX_BYTES = 64;

const PROXY_SESSION_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_REVISION_TEXT_BYTES = 256;
const MAX_PARTITION_COUNT = 256;
const ALLOWED_INVALIDATION_KEYS = Object.freeze([
  "schemaVersion",
  "reasonCode",
  "sourceRevision",
  "catalogRevision",
  "audienceRevision",
  "affectedPartitions"
]);
const ALLOWED_CATALOG_FACT_KEYS = Object.freeze([
  "sourceRevision",
  "catalogRevision",
  "audienceRevision",
  "partitionKeys"
]);
const ALLOWED_ACKNOWLEDGEMENT_KEYS = ALLOWED_CATALOG_FACT_KEYS;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key, index) => key === keys[index]);
}

function boundedText(value, maxBytes = MAX_REVISION_TEXT_BYTES) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes ? normalized : "";
}

function revision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function opaquePartitionKeys(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PARTITION_COUNT) return null;
  const keys = value.map((entry) => boundedText(entry));
  if (keys.some((entry) => !entry) || new Set(keys).size !== keys.length) return null;
  const sorted = [...keys].sort();
  return keys.every((entry, index) => entry === sorted[index]) ? Object.freeze(keys) : null;
}

export function normalizeMcpProxySessionId(value) {
  if (Array.isArray(value) || typeof value !== "string") return "";
  const normalized = value.trim();
  if (normalized.length < 20 ||
      Buffer.byteLength(normalized, "utf8") > MCP_PROXY_SESSION_MAX_BYTES ||
      !PROXY_SESSION_PATTERN.test(normalized)) return "";
  return normalized;
}

export function parseMcpCatalogInvalidation(value) {
  const expected = [...ALLOWED_INVALIDATION_KEYS].sort();
  if (!hasExactKeys(value, expected) ||
      value.schemaVersion !== MCP_CATALOG_DELIVERY_SCHEMA_VERSION) return null;
  const sourceRevision = revision(value.sourceRevision);
  const audienceRevision = revision(value.audienceRevision);
  const catalogRevision = boundedText(value.catalogRevision);
  const reasonCode = boundedText(value.reasonCode, 128);
  const affectedPartitions = opaquePartitionKeys(value.affectedPartitions);
  if (sourceRevision === null || audienceRevision === null || !catalogRevision ||
      !reasonCode || !affectedPartitions) return null;
  return Object.freeze({
    schemaVersion: MCP_CATALOG_DELIVERY_SCHEMA_VERSION,
    reasonCode,
    sourceRevision,
    catalogRevision,
    audienceRevision,
    affectedPartitions
  });
}

export function parseMcpCatalogFacts(value) {
  const expected = [...ALLOWED_CATALOG_FACT_KEYS].sort();
  if (!hasExactKeys(value, expected)) return null;
  const sourceRevision = revision(value.sourceRevision);
  const audienceRevision = revision(value.audienceRevision);
  const catalogRevision = boundedText(value.catalogRevision);
  const partitionKeys = opaquePartitionKeys(value.partitionKeys);
  if (sourceRevision === null || audienceRevision === null || !catalogRevision || !partitionKeys) return null;
  return Object.freeze({ sourceRevision, catalogRevision, audienceRevision, partitionKeys });
}

export function parseMcpCatalogAcknowledgement(value) {
  const expected = [...ALLOWED_ACKNOWLEDGEMENT_KEYS].sort();
  if (!hasExactKeys(value, expected)) return null;
  return parseMcpCatalogFacts(value);
}

export function createMcpCatalogInvalidation({
  reasonCode,
  sourceRevision,
  catalogRevision,
  audienceRevision,
  affectedPartitions
} = {}) {
  const parsed = parseMcpCatalogInvalidation({
    schemaVersion: MCP_CATALOG_DELIVERY_SCHEMA_VERSION,
    reasonCode,
    sourceRevision,
    catalogRevision,
    audienceRevision,
    affectedPartitions: [...new Set(Array.isArray(affectedPartitions) ? affectedPartitions : [])].sort()
  });
  if (!parsed) throw new TypeError("MCP catalog invalidation does not satisfy the wire contract.");
  return parsed;
}
