export const MCP_CATALOG_DELIVERY_SCHEMA_VERSION: any = "v0.0.1:mcp-catalog-delivery:wire-1";
export const MCP_CATALOG_LIST_CHANGED_CAPABILITY: any = "upstream.catalog.list_changed";
export const MCP_CATALOG_LIST_CHANGED_METHOD: any = "notifications/tools/list_changed";
export const MCP_CATALOG_ACKNOWLEDGE_METHOD: any = "meshrix/catalog/acknowledge";
export const MCP_PROXY_SESSION_HEADER: any = "X-Meshrix.js-Mcp-Proxy-Session";
export const MCP_PROXY_SESSION_HEADER_LOWER: any = MCP_PROXY_SESSION_HEADER.toLowerCase();
export const MCP_PROXY_SESSION_MAX_BYTES: any = 64;

const PROXY_SESSION_PATTERN: any = /^[A-Za-z0-9_-]+$/u;
const MAX_REVISION_TEXT_BYTES: any = 256;
const MAX_PARTITION_COUNT: any = 256;
const ALLOWED_INVALIDATION_KEYS: readonly any[] = Object.freeze([
  "schemaVersion",
  "reasonCode",
  "sourceRevision",
  "catalogRevision",
  "audienceRevision",
  "affectedPartitions"
]);
const ALLOWED_CATALOG_FACT_KEYS: readonly any[] = Object.freeze([
  "sourceRevision",
  "catalogRevision",
  "audienceRevision",
  "partitionKeys"
]);
const ALLOWED_ACKNOWLEDGEMENT_KEYS: any = ALLOWED_CATALOG_FACT_KEYS;

function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value?: any, expected?: any) : any {
  if (!isPlainObject(value)) return false;
  const keys: any = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key?: any, index?: any) : any => key === keys[index]);
}

function boundedText(value?: any, maxBytes: any = MAX_REVISION_TEXT_BYTES) : any {
  if (typeof value !== "string") return "";
  const normalized: any = value.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes ? normalized : "";
}

function revision(value?: any) : any {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function opaquePartitionKeys(value?: any) : any {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PARTITION_COUNT) return null;
  const keys: any = value.map((entry?: any) : any => boundedText(entry));
  if (keys.some((entry?: any) : any => !entry) || new Set<any>(keys).size !== keys.length) return null;
  const sorted: any = [...keys].sort();
  return keys.every((entry?: any, index?: any) : any => entry === sorted[index]) ? Object.freeze(keys) : null;
}

export function normalizeMcpProxySessionId(value?: any) : any {
  if (Array.isArray(value) || typeof value !== "string") return "";
  const normalized: any = value.trim();
  if (normalized.length < 20 ||
      Buffer.byteLength(normalized, "utf8") > MCP_PROXY_SESSION_MAX_BYTES ||
      !PROXY_SESSION_PATTERN.test(normalized)) return "";
  return normalized;
}

export function parseMcpCatalogInvalidation(value?: any) : any {
  const expected: any = [...ALLOWED_INVALIDATION_KEYS].sort();
  if (!hasExactKeys(value, expected) ||
      value.schemaVersion !== MCP_CATALOG_DELIVERY_SCHEMA_VERSION) return null;
  const sourceRevision: any = revision(value.sourceRevision);
  const audienceRevision: any = revision(value.audienceRevision);
  const catalogRevision: any = boundedText(value.catalogRevision);
  const reasonCode: any = boundedText(value.reasonCode, 128);
  // An empty affectedPartitions list is a valid global catalog invalidation
  // (key-only deployments have zero grants, so no audience partitions exist).
  const affectedPartitions: any = opaquePartitionKeys(value.affectedPartitions) || (
    Array.isArray(value.affectedPartitions) && value.affectedPartitions.length === 0
      ? Object.freeze([])
      : null
  );
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

export function parseMcpCatalogFacts(value?: any) : any {
  const expected: any = [...ALLOWED_CATALOG_FACT_KEYS].sort();
  if (!hasExactKeys(value, expected)) return null;
  const sourceRevision: any = revision(value.sourceRevision);
  const audienceRevision: any = revision(value.audienceRevision);
  const catalogRevision: any = boundedText(value.catalogRevision);
  const partitionKeys: any = opaquePartitionKeys(value.partitionKeys);
  if (sourceRevision === null || audienceRevision === null || !catalogRevision || !partitionKeys) return null;
  return Object.freeze({ sourceRevision, catalogRevision, audienceRevision, partitionKeys });
}

export function parseMcpCatalogAcknowledgement(value?: any) : any {
  const expected: any = [...ALLOWED_ACKNOWLEDGEMENT_KEYS].sort();
  if (!hasExactKeys(value, expected)) return null;
  return parseMcpCatalogFacts(value);
}

export function createMcpCatalogInvalidation({
  reasonCode,
  sourceRevision,
  catalogRevision,
  audienceRevision,
  affectedPartitions
}: Record<string, any> = {}) : any {
  const parsed: any = parseMcpCatalogInvalidation({
    schemaVersion: MCP_CATALOG_DELIVERY_SCHEMA_VERSION,
    reasonCode,
    sourceRevision,
    catalogRevision,
    audienceRevision,
    affectedPartitions: [...new Set<any>(Array.isArray(affectedPartitions) ? affectedPartitions : [])].sort()
  });
  if (!parsed) throw new TypeError("MCP catalog invalidation does not satisfy the wire contract.");
  return parsed;
}
