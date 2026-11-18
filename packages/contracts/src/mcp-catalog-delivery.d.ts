export declare const MCP_CATALOG_DELIVERY_SCHEMA_VERSION: "v0.0.1:mcp-catalog-delivery:wire-1";
export declare const MCP_CATALOG_LIST_CHANGED_METHOD: "notifications/tools/list_changed";
export declare const MCP_CATALOG_ACKNOWLEDGE_METHOD: "meshrix/catalog/acknowledge";
export declare const MCP_PROXY_SESSION_HEADER: "X-Meshrix.js-Mcp-Proxy-Session";
export declare const MCP_PROXY_SESSION_HEADER_LOWER: string;
export declare const MCP_PROXY_SESSION_MAX_BYTES: 64;

export interface McpCatalogRevisionFacts {
  sourceRevision: number;
  catalogRevision: string;
  audienceRevision: number;
  partitionKeys: readonly string[];
}

export interface McpCatalogInvalidation {
  schemaVersion: typeof MCP_CATALOG_DELIVERY_SCHEMA_VERSION;
  reasonCode: string;
  sourceRevision: number;
  catalogRevision: string;
  audienceRevision: number;
  affectedPartitions: readonly string[];
}

export declare function normalizeMcpProxySessionId(value: unknown): string;
export declare function parseMcpCatalogInvalidation(value: unknown): McpCatalogInvalidation | null;
export declare function parseMcpCatalogFacts(value: unknown): McpCatalogRevisionFacts | null;
export declare function parseMcpCatalogAcknowledgement(value: unknown): McpCatalogRevisionFacts | null;
export declare function createMcpCatalogInvalidation(value: {
  reasonCode: string;
  sourceRevision: number;
  catalogRevision: string;
  audienceRevision: number;
  affectedPartitions: readonly string[];
}): McpCatalogInvalidation;
