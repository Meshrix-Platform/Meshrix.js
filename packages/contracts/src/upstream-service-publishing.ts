export const UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION =
  "v0.0.1:upstream-service-publishing:command-2";

export const UPSTREAM_PUBLISHING_MAX_COMMAND_BYTES = 128 * 1024;

export const UPSTREAM_PUBLISHING_ACTIONS = Object.freeze([
  "create",
  "replace",
  "disable",
  "remove",
  "republish"
]);

export const UPSTREAM_PUBLISHING_STATES = Object.freeze([
  "rejected",
  "accepted",
  "publishing",
  "server_published",
  "disabled",
  "removed"
]);

export const UPSTREAM_REQUEST_REPRESENTATION_MODES = Object.freeze([
  "structured_json",
  "opaque_stream",
  "artifact_body",
  "artifact_multipart"
]);

export const UPSTREAM_RESPONSE_REPRESENTATION_MODES = Object.freeze([
  "structured_json",
  "opaque_stream",
  "artifact"
]);

export const PORTABLE_UPSTREAM_SERVICE_KIND = "meshrix.upstream-service";
export const PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION =
  "v0.0.1:upstream-service:portable-import-2";

export const UPSTREAM_SERVICE_DESCRIPTOR_FIELDS = Object.freeze([
  "serviceProtocol",
  "label",
  "description",
  "baseUrl",
  "endpoints",
  "healthPath",
  "allowLocalNetwork",
  "visibility",
  "dataClass",
  "tags",
  "references",
  "interfaceSchemas",
  "permissions",
  "approvalPolicy",
  "trafficPolicy",
  "audience",
  "tagPolicy",
  "circuitBreaker",
  "operations",
  "mcp"
]);

export const UPSTREAM_SERVICE_ENDPOINT_FIELDS = Object.freeze([
  "endpointId",
  "baseUrl",
  "weight",
  "disabled",
  "trafficPolicy",
  "circuitBreaker"
]);

export const UPSTREAM_SERVICE_OPERATION_FIELDS = Object.freeze([
  "operationKey",
  "label",
  "protocol",
  "method",
  "path",
  "requiredScopes",
  "risk",
  "requiresApproval",
  "approvalScope",
  "requiredApproval",
  "approvalLayers",
  "timeoutMs",
  "jsonRpcMethod",
  "sensitiveBodyFields",
  "publicResponseFields",
  "requestSchema",
  "responseSchema",
  "payloadTransport"
]);

export const UPSTREAM_PAYLOAD_TRANSPORT_FIELDS = Object.freeze(["request", "response"]);
export const UPSTREAM_PAYLOAD_REQUEST_FIELDS = Object.freeze([
  "mode",
  "maxBytes",
  "mediaTypes",
  "artifactArgument",
  "multipart"
]);
export const UPSTREAM_PAYLOAD_RESPONSE_FIELDS = Object.freeze([
  "mode",
  "maxBytes",
  "mediaTypes",
  "allowRanges"
]);
export const UPSTREAM_MULTIPART_FIELDS = Object.freeze([
  "artifactParts",
  "scalarFields",
  "maxParts"
]);
export const UPSTREAM_ARTIFACT_PART_FIELDS = Object.freeze([
  "argument",
  "partName",
  "required",
  "multiple",
  "maxCount"
]);
export const UPSTREAM_SCALAR_PART_FIELDS = Object.freeze([
  "argument",
  "partName",
  "required"
]);

export type UpstreamRequestRepresentationMode =
  | "structured_json"
  | "opaque_stream"
  | "artifact_body"
  | "artifact_multipart";

export type UpstreamResponseRepresentationMode =
  | "structured_json"
  | "opaque_stream"
  | "artifact";

export interface TypedServiceReference {
  type?: string;
  value?: string;
  reference?: string;
  revision?: number;
  use?: string;
}

export interface UpstreamPayloadTransport {
  request: {
    mode: UpstreamRequestRepresentationMode;
    maxBytes?: number;
    mediaTypes?: string[];
  };
  response?: {
    mode: UpstreamResponseRepresentationMode;
    maxBytes?: number;
    mediaTypes?: string[];
  };
}

export interface UpstreamServiceOperation {
  operationKey: string;
  method: string;
  path: string;
  risk?: string;
  requiresApproval?: boolean;
  payloadTransport: UpstreamPayloadTransport;
}

export interface UpstreamServiceDescriptor {
  serviceProtocol: "http" | "json-rpc";
  label?: string;
  description?: string;
  baseUrl?: string;
  endpoints?: Array<Record<string, unknown>>;
  visibility?: string;
  dataClass?: string;
  tags?: string[];
  references?: TypedServiceReference[];
  operations?: UpstreamServiceOperation[];
  interfaceSchemas?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  approvalPolicy?: Record<string, unknown>;
  trafficPolicy?: Record<string, unknown>;
  audience?: Record<string, unknown>;
  tagPolicy?: Record<string, unknown>;
  circuitBreaker?: Record<string, unknown>;
}

export interface PortableUpstreamServiceImport {
  kind: typeof PORTABLE_UPSTREAM_SERVICE_KIND;
  schemaVersion: typeof PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION;
  serviceKey: string;
  descriptor: UpstreamServiceDescriptor;
}

const SAFE_SERVICE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}(?:\/[A-Za-z][A-Za-z0-9_.-]{0,63}){0,3}$/u;
const PORTABLE_DOCUMENT_FIELDS = new Set(["kind", "schemaVersion", "serviceKey", "descriptor"]);
const PORTABLE_DESCRIPTOR_FIELDS = new Set(
  UPSTREAM_SERVICE_DESCRIPTOR_FIELDS.filter((field) => field !== "mcp")
);
const ENDPOINT_FIELDS = new Set(UPSTREAM_SERVICE_ENDPOINT_FIELDS);
const OPERATION_FIELDS = new Set(UPSTREAM_SERVICE_OPERATION_FIELDS);
const PAYLOAD_TRANSPORT_FIELDS = new Set(UPSTREAM_PAYLOAD_TRANSPORT_FIELDS);

export function isUpstreamPublishingAction(value?: unknown) {
  return typeof value === "string" && UPSTREAM_PUBLISHING_ACTIONS.includes(value);
}

export function isUpstreamPublishingState(value?: unknown) {
  return typeof value === "string" && UPSTREAM_PUBLISHING_STATES.includes(value);
}

export function isUpstreamRequestRepresentationMode(value?: unknown): value is UpstreamRequestRepresentationMode {
  return typeof value === "string" && UPSTREAM_REQUEST_REPRESENTATION_MODES.includes(value);
}

export function isUpstreamResponseRepresentationMode(value?: unknown): value is UpstreamResponseRepresentationMode {
  return typeof value === "string" && UPSTREAM_RESPONSE_REPRESENTATION_MODES.includes(value);
}

export function isUpstreamServiceKey(value?: unknown): value is string {
  return typeof value === "string" && SAFE_SERVICE_KEY.test(value);
}

function isPlainObject(value?: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unknownFields(value: Record<string, unknown>, fields: ReadonlySet<string>): string[] {
  return Object.keys(value).filter((key) => !fields.has(key));
}

function validatePortablePayloadTransport(
  value: unknown,
  operationIndex: number,
  serviceProtocol: unknown
): void {
  if (!isPlainObject(value)) {
    throw new Error(`descriptor.operations[${operationIndex}].payloadTransport must be an object.`);
  }
  const unsupported = unknownFields(value, PAYLOAD_TRANSPORT_FIELDS);
  if (unsupported.length) throw new Error(`Unknown payloadTransport field(s): ${unsupported.join(", ")}.`);
  if (!isPlainObject(value.request)) {
    throw new Error(`descriptor.operations[${operationIndex}].payloadTransport requires a request object.`);
  }
  if (value.response !== undefined && !isPlainObject(value.response)) {
    throw new Error(`descriptor.operations[${operationIndex}].payloadTransport.response must be an object.`);
  }
  if (serviceProtocol === "json-rpc" && value.response === undefined) {
    throw new Error(`descriptor.operations[${operationIndex}] JSON-RPC requires a response representation.`);
  }
  if (!isUpstreamRequestRepresentationMode(value.request.mode) ||
      (value.response !== undefined && !isUpstreamResponseRepresentationMode(value.response.mode))) {
    throw new Error(`descriptor.operations[${operationIndex}] has an invalid representation mode.`);
  }
  const policies: Array<readonly [string, Record<string, unknown>]> = [["request", value.request]];
  if (value.response !== undefined) policies.push(["response", value.response]);
  for (const [direction, policy] of policies) {
    if (!Number.isSafeInteger(Number(policy.maxBytes)) || Number(policy.maxBytes) < 1) {
      throw new Error(`descriptor.operations[${operationIndex}].payloadTransport.${direction}.maxBytes is invalid.`);
    }
    if (!Array.isArray(policy.mediaTypes) || policy.mediaTypes.length === 0) {
      throw new Error(`descriptor.operations[${operationIndex}].payloadTransport.${direction}.mediaTypes is required.`);
    }
  }
  if (value.request.mode === "artifact_body" && typeof value.request.artifactArgument !== "string") {
    throw new Error(`descriptor.operations[${operationIndex}] artifact_body requires artifactArgument.`);
  }
  if (value.request.mode === "artifact_multipart" && !isPlainObject(value.request.multipart)) {
    throw new Error(`descriptor.operations[${operationIndex}] artifact_multipart requires multipart mapping.`);
  }
}

function assertPortableRemoteUrl(value: unknown, field: string): void {
  if (typeof value !== "string" || !value) throw new Error(`${field} must be a remote URL.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a remote URL.`);
  }
  const hasExplicitPort = /^https?:\/\/(?:\[[^\]]+\]|[^/:?#]+):[0-9]{1,5}(?:[/?#]|$)/u.test(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !hasExplicitPort) {
    throw new Error(`${field} must use HTTP(S), an explicit port, and no embedded credentials.`);
  }
}

function validatePortableDescriptor(
  descriptor: Record<string, unknown>
): asserts descriptor is Record<string, unknown> & UpstreamServiceDescriptor {
  const unsupported = unknownFields(descriptor, PORTABLE_DESCRIPTOR_FIELDS);
  if (unsupported.length) throw new Error(`Unknown descriptor field(s): ${unsupported.join(", ")}.`);
  if (descriptor.serviceProtocol !== "http" && descriptor.serviceProtocol !== "json-rpc") {
    throw new Error('descriptor.serviceProtocol must be "http" or "json-rpc".');
  }
  if (descriptor.baseUrl === undefined && (!Array.isArray(descriptor.endpoints) || descriptor.endpoints.length === 0)) {
    throw new Error("descriptor requires baseUrl or at least one endpoint.");
  }
  if (descriptor.baseUrl !== undefined) assertPortableRemoteUrl(descriptor.baseUrl, "descriptor.baseUrl");
  if (descriptor.endpoints !== undefined) {
    if (!Array.isArray(descriptor.endpoints)) throw new Error("descriptor.endpoints must be an array.");
    for (const [index, endpoint] of descriptor.endpoints.entries()) {
      if (!isPlainObject(endpoint)) throw new Error(`descriptor.endpoints[${index}] must be an object.`);
      const unsupportedEndpointFields = unknownFields(endpoint, ENDPOINT_FIELDS);
      if (unsupportedEndpointFields.length) {
        throw new Error(`Unknown descriptor.endpoints[${index}] field(s): ${unsupportedEndpointFields.join(", ")}.`);
      }
      assertPortableRemoteUrl(endpoint.baseUrl, `descriptor.endpoints[${index}].baseUrl`);
    }
  }
  if (!Array.isArray(descriptor.operations) || descriptor.operations.length === 0) {
    throw new Error(`descriptor.operations must contain at least one explicit ${descriptor.serviceProtocol.toUpperCase()} operation.`);
  }
  descriptor.operations.forEach((operation, index) => {
    if (!isPlainObject(operation)) throw new Error(`descriptor.operations[${index}] must be an object.`);
    const unsupportedOperationFields = unknownFields(operation, OPERATION_FIELDS);
    if (unsupportedOperationFields.length) {
      throw new Error(`Unknown descriptor.operations[${index}] field(s): ${unsupportedOperationFields.join(", ")}.`);
    }
    validatePortablePayloadTransport(operation.payloadTransport, index, descriptor.serviceProtocol);
  });
}

export function parsePortableUpstreamServiceImport(text: string): PortableUpstreamServiceImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : "parsing failed"}`);
  }
  if (!isPlainObject(parsed)) throw new Error("Import must be a JSON object.");

  const unsupported = unknownFields(parsed, PORTABLE_DOCUMENT_FIELDS);
  if (unsupported.length) throw new Error(`Unknown top-level field(s): ${unsupported.join(", ")}.`);
  for (const key of PORTABLE_DOCUMENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) throw new Error(`Missing top-level field: ${key}.`);
  }
  if (parsed.kind !== PORTABLE_UPSTREAM_SERVICE_KIND) {
    throw new Error(`kind must be "${PORTABLE_UPSTREAM_SERVICE_KIND}".`);
  }
  if (parsed.schemaVersion !== PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be "${PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION}".`);
  }
  const serviceKey = typeof parsed.serviceKey === "string" ? parsed.serviceKey.trim() : "";
  if (!isUpstreamServiceKey(serviceKey)) {
    throw new Error("serviceKey must be a canonical non-empty service key.");
  }
  if (!isPlainObject(parsed.descriptor)) throw new Error("descriptor must be a JSON object.");
  validatePortableDescriptor(parsed.descriptor);

  return {
    kind: PORTABLE_UPSTREAM_SERVICE_KIND,
    schemaVersion: PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION,
    serviceKey,
    descriptor: parsed.descriptor
  };
}
