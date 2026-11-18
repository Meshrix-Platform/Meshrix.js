export const UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION: "v0.0.1:upstream-service-publishing:command-2";
export const UPSTREAM_PUBLISHING_MAX_COMMAND_BYTES: 131072;
export const UPSTREAM_PUBLISHING_ACTIONS: readonly ["create", "replace", "disable", "remove", "republish"];
export const UPSTREAM_PUBLISHING_STATES: readonly [
  "rejected",
  "accepted",
  "publishing",
  "server_published",
  "disabled",
  "removed"
];
export function isUpstreamPublishingAction(value: unknown): boolean;
export function isUpstreamPublishingState(value: unknown): boolean;
export const UPSTREAM_REQUEST_REPRESENTATION_MODES: readonly [
  "structured_json",
  "opaque_stream",
  "artifact_body",
  "artifact_multipart"
];
export const UPSTREAM_RESPONSE_REPRESENTATION_MODES: readonly [
  "structured_json",
  "opaque_stream",
  "artifact"
];
export function isUpstreamRequestRepresentationMode(value: unknown): boolean;
export function isUpstreamResponseRepresentationMode(value: unknown): boolean;
export const PORTABLE_UPSTREAM_SERVICE_KIND: "meshrix.upstream-service";
export const PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION: "v0.0.1:upstream-service:portable-import-2";
export const UPSTREAM_SERVICE_DESCRIPTOR_FIELDS: readonly [
  "serviceProtocol", "label", "description", "baseUrl", "endpoints", "healthPath",
  "allowLocalNetwork", "visibility", "dataClass", "tags", "references", "interfaceSchemas",
  "permissions", "approvalPolicy", "trafficPolicy", "audience", "tagPolicy", "circuitBreaker",
  "contentPolicy", "oauth", "operations", "mcp"
];
export const UPSTREAM_SERVICE_OAUTH_FIELDS: readonly [
  "grantType", "tokenUrl", "clientId", "clientSecretRef", "scopes", "audience", "authMethod"
];
export const UPSTREAM_OAUTH_GRANT_TYPES: readonly ["client_credentials"];
export const UPSTREAM_OAUTH_AUTH_METHODS: readonly ["client_secret_basic", "client_secret_post"];
export const UPSTREAM_SERVICE_ENDPOINT_FIELDS: readonly [
  "endpointId", "baseUrl", "weight", "disabled", "trafficPolicy", "circuitBreaker"
];
export const UPSTREAM_SERVICE_OPERATION_FIELDS: readonly [
  "operationKey", "label", "protocol", "method", "path", "requiredScopes", "risk",
  "requiresApproval", "approvalScope", "requiredApproval", "approvalLayers", "timeoutMs",
  "jsonRpcMethod", "sensitiveBodyFields", "publicResponseFields", "requestSchema",
  "responseSchema", "payloadTransport", "contentPolicy", "responseCache"
];
export const UPSTREAM_PAYLOAD_TRANSPORT_FIELDS: readonly ["request", "response"];
export const UPSTREAM_PAYLOAD_REQUEST_FIELDS: readonly [
  "mode", "maxBytes", "mediaTypes", "artifactArgument", "multipart"
];
export const UPSTREAM_PAYLOAD_RESPONSE_FIELDS: readonly [
  "mode", "maxBytes", "mediaTypes", "allowRanges"
];
export const UPSTREAM_MULTIPART_FIELDS: readonly ["artifactParts", "scalarFields", "maxParts"];
export const UPSTREAM_ARTIFACT_PART_FIELDS: readonly [
  "argument", "partName", "required", "multiple", "maxCount"
];
export const UPSTREAM_SCALAR_PART_FIELDS: readonly ["argument", "partName", "required"];

export interface TypedServiceReference {
  type: "credential" | "certificate" | "private-key" | "trust-anchor";
  reference: string;
  revision: number;
  use: string;
  operationKey?: string;
  host?: string;
  protocol?: string;
  scopes?: string[];
}

export type UpstreamRequestRepresentationMode = typeof UPSTREAM_REQUEST_REPRESENTATION_MODES[number];
export type UpstreamResponseRepresentationMode = typeof UPSTREAM_RESPONSE_REPRESENTATION_MODES[number];

export interface UpstreamPayloadTransport {
  request: {
    mode: UpstreamRequestRepresentationMode;
    maxBytes: number;
    mediaTypes: string[];
    artifactArgument?: string;
    multipart?: {
      artifactParts: Array<{
        argument: string;
        partName: string;
        required?: boolean;
        multiple?: boolean;
        maxCount?: number;
      }>;
      scalarFields?: Array<{ argument: string; partName: string; required?: boolean }>;
      maxParts: number;
    };
  };
  response?: {
    mode: UpstreamResponseRepresentationMode;
    maxBytes: number;
    mediaTypes: string[];
    allowRanges?: boolean;
  };
}

type UpstreamContentScalar = string | number | boolean | null;

/**
 * Numeric comparison conjunction: every declared bound must hold, so
 * `{gte: 0, lt: 100}` expresses a range. Bounds are finite numbers and the
 * selected value must be a finite number — a non-numeric selection is a miss
 * on the deny side and a denial on the allow side.
 */
export interface UpstreamServiceContentCompare {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

export interface UpstreamServiceContentRule {
  id: string;
  path?: string;
  deny?: {
    contains?: string[];
    matches?: string[];
    oneOf?: UpstreamContentScalar[];
    notIn?: UpstreamContentScalar[];
    eq?: UpstreamContentScalar;
    neq?: UpstreamContentScalar;
    startsWith?: string;
    endsWith?: string;
    exists?: boolean;
    compare?: UpstreamServiceContentCompare;
  };
  allow?: {
    oneOf?: UpstreamContentScalar[];
    notIn?: UpstreamContentScalar[];
    matches?: string[];
    eq?: UpstreamContentScalar;
    neq?: UpstreamContentScalar;
    startsWith?: string;
    endsWith?: string;
    exists?: boolean;
    compare?: UpstreamServiceContentCompare;
  };
}

export interface UpstreamServiceContentPolicy {
  request?: {
    rules: UpstreamServiceContentRule[];
  };
}

/**
 * Operation-level response cache declaration. Honored only on `read_only`
 * operations that do not require approval; cache hits bypass credential
 * resolution, permit claims and upstream contact but still consume the
 * traffic slot and audit trail.
 */
export interface UpstreamServiceResponseCache {
  /** Milliseconds a stored response stays fresh; 1..600000. */
  ttlMs: number;
  /** Per-service entry cap; 1..256, default 128. */
  maxEntries?: number;
  /** Serialized response byte cap; 1..262144, default 262144. */
  maxBytes?: number;
}

/**
 * Service-level OAuth client lifecycle for the upstream credential path.
 * Only the machine-to-machine client_credentials grant is supported; the
 * client secret stays inside the local secret store and is referenced by URI.
 */
export interface UpstreamServiceOauth {
  grantType: "client_credentials";
  tokenUrl: string;
  clientId: string;
  clientSecretRef: string;
  scopes?: string[];
  audience?: string;
  authMethod?: "client_secret_basic" | "client_secret_post";
}

export interface UpstreamMcpToolAlias {
  /** Public tool-name segment replacing the upstream name under `upstream.{prefix}.`. */
  name?: string;
  title?: string;
  description?: string;
}

export interface UpstreamMcpDescriptor {
  transport: "http" | "https" | "remote" | "streamable-http" | "sse";
  url?: string;
  endpoint?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  toolNamePrefix?: string;
  prefix?: string;
  protocolVersion?: "2025-03-26" | "2025-06-18" | "2026-07-28";
  toolsCacheTtlMs?: number;
  timeoutMs?: number;
  /** Operator curation map: upstream tool name -> public alias. */
  aliases?: Record<string, string | UpstreamMcpToolAlias>;
}

export interface UpstreamServiceDescriptor {
  serviceProtocol?: "http" | "json-rpc" | "mcp";
  label?: string;
  description?: string;
  baseUrl?: string;
  endpoints?: Array<Record<string, unknown>>;
  healthPath?: string;
  allowLocalNetwork?: boolean;
  visibility?: string;
  dataClass?: string;
  tags?: string[];
  references?: TypedServiceReference[];
  interfaceSchemas?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  approvalPolicy?: Record<string, unknown>;
  trafficPolicy?: Record<string, unknown>;
  audience?: Record<string, unknown>;
  tagPolicy?: Record<string, unknown>;
  circuitBreaker?: Record<string, unknown>;
  contentPolicy?: UpstreamServiceContentPolicy;
  oauth?: UpstreamServiceOauth;
  operations?: Array<{
    operationKey: string;
    label?: string;
    method: string;
    path: string;
    protocol?: string;
    risk?: string;
    requiredScopes?: string[];
    requiresApproval?: boolean;
    approvalScope?: string;
    requiredApproval?: {
      required: boolean;
      approvalScope?: string;
      approvalLayers?: Array<Record<string, unknown>>;
    };
    approvalLayers?: Array<Record<string, unknown>>;
    timeoutMs?: number;
    jsonRpcMethod?: string;
    sensitiveBodyFields?: string[];
    publicResponseFields?: string[];
    requestSchema?: Record<string, unknown>;
    responseSchema?: Record<string, unknown>;
    payloadTransport: UpstreamPayloadTransport;
    contentPolicy?: UpstreamServiceContentPolicy;
    responseCache?: UpstreamServiceResponseCache;
  }>;
  mcp?: UpstreamMcpDescriptor;
}

export interface PortableUpstreamServiceImport {
  kind: typeof PORTABLE_UPSTREAM_SERVICE_KIND;
  schemaVersion: typeof PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION;
  serviceKey: string;
  descriptor: UpstreamServiceDescriptor;
}

export function isUpstreamServiceKey(value: unknown): boolean;
export function validateUpstreamContentPolicy(value: unknown, field?: string): void;
export function validateUpstreamResponseCache(value: unknown, field?: string): void;
export function validateUpstreamOauth(value: unknown, field?: string): void;
export function parsePortableUpstreamServiceImport(text: string): PortableUpstreamServiceImport;

export interface OpenApiImportSkippedOperation {
  path: string;
  method: string;
  reason: string;
}

export interface UpstreamServiceOpenApiImport {
  document: PortableUpstreamServiceImport;
  skippedOperations: OpenApiImportSkippedOperation[];
  warnings: string[];
}

export function upstreamServiceImportFromOpenApi(
  documentText: string,
  options?: { serviceKey?: unknown; baseUrl?: unknown }
): UpstreamServiceOpenApiImport;
