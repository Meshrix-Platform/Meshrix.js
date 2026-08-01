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
  "operations", "mcp"
];
export const UPSTREAM_SERVICE_ENDPOINT_FIELDS: readonly [
  "endpointId", "baseUrl", "weight", "disabled", "trafficPolicy", "circuitBreaker"
];
export const UPSTREAM_SERVICE_OPERATION_FIELDS: readonly [
  "operationKey", "label", "protocol", "method", "path", "requiredScopes", "risk",
  "requiresApproval", "approvalScope", "requiredApproval", "approvalLayers", "timeoutMs",
  "jsonRpcMethod", "sensitiveBodyFields", "publicResponseFields", "requestSchema",
  "responseSchema", "payloadTransport"
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
  response: {
    mode: UpstreamResponseRepresentationMode;
    maxBytes: number;
    mediaTypes: string[];
    allowRanges?: boolean;
  };
}

export interface UpstreamServiceDescriptor {
  serviceProtocol?: "http" | "json-rpc";
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
  }>;
}

export interface PortableUpstreamServiceImport {
  kind: typeof PORTABLE_UPSTREAM_SERVICE_KIND;
  schemaVersion: typeof PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION;
  serviceKey: string;
  descriptor: UpstreamServiceDescriptor;
}

export function isUpstreamServiceKey(value: unknown): boolean;
export function parsePortableUpstreamServiceImport(text: string): PortableUpstreamServiceImport;
