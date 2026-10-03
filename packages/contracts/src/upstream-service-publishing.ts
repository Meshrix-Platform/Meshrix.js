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

export const UPSTREAM_SERVICE_STATES = Object.freeze([
  "publishing",
  "disabled",
  "removed"
] as const);

export const UPSTREAM_PUBLICATION_STATUSES = Object.freeze([
  "publishing",
  "server_published"
] as const);

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

export const UPSTREAM_MCP_DESCRIPTOR_FIELDS = Object.freeze([
  "transport",
  "url",
  "endpoint",
  "baseUrl",
  "headers",
  "toolNamePrefix",
  "prefix",
  "protocolVersion",
  "toolsCacheTtlMs",
  "timeoutMs"
] as const);

export const UPSTREAM_MCP_REMOTE_TRANSPORTS = Object.freeze([
  "http",
  "https",
  "remote",
  "streamable-http",
  "sse"
] as const);

export const UPSTREAM_MCP_PROTOCOL_VERSIONS = Object.freeze([
  "2025-03-26",
  "2025-06-18",
  "2026-07-28"
] as const);

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

export type UpstreamPublishingAction = "create" | "replace" | "disable" | "remove" | "republish";
export type UpstreamServiceState = typeof UPSTREAM_SERVICE_STATES[number];
export type UpstreamServicePublicationStatus = typeof UPSTREAM_PUBLICATION_STATUSES[number];

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

export interface UpstreamMcpDescriptor {
  transport: typeof UPSTREAM_MCP_REMOTE_TRANSPORTS[number];
  url?: string;
  endpoint?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  toolNamePrefix?: string;
  prefix?: string;
  /** Required by portable import validation; the command path normalizes a default. */
  protocolVersion?: typeof UPSTREAM_MCP_PROTOCOL_VERSIONS[number];
  toolsCacheTtlMs?: number;
  timeoutMs?: number;
}

export interface UpstreamPayloadTransport {
  request: {
    mode: UpstreamRequestRepresentationMode;
    maxBytes?: number;
    mediaTypes?: string[];
    artifactArgument?: string;
    multipart?: {
      artifactParts: Array<Record<string, unknown>>;
      scalarFields?: Array<Record<string, unknown>>;
      maxParts?: number;
    };
  };
  response?: {
    mode: UpstreamResponseRepresentationMode;
    maxBytes?: number;
    mediaTypes?: string[];
    allowRanges?: boolean;
  };
}

export interface UpstreamServiceOperation {
  operationKey: string;
  label?: string;
  protocol?: string;
  method: string;
  path: string;
  requiredScopes?: string[];
  risk?: string;
  requiresApproval?: boolean;
  approvalScope?: string;
  requiredApproval?: Record<string, unknown>;
  approvalLayers?: Array<Record<string, unknown>>;
  timeoutMs?: number;
  jsonRpcMethod?: string;
  sensitiveBodyFields?: string[];
  publicResponseFields?: string[];
  requestSchema?: Record<string, unknown>;
  responseSchema?: Record<string, unknown>;
  payloadTransport: UpstreamPayloadTransport;
}

export interface UpstreamServiceDescriptor {
  serviceProtocol: "http" | "json-rpc" | "mcp";
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
  operations?: UpstreamServiceOperation[];
  mcp?: UpstreamMcpDescriptor;
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

/**
 * Authorized publishing command shapes carried on the public publishing
 * boundary. The Agents ingress still parses raw command bytes, enforces the
 * closed field set, ownership, expected revisions, idempotency, and typed
 * reference safety; these types describe the command a producer sends and do
 * not replace that validation. A portable import document keeps its own
 * `PortableUpstreamServiceImport` semantics and is not a command.
 */
export interface UpstreamServicePublishingCommandBase {
  schemaVersion: typeof UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION;
  expectedServiceRevision: number;
  expectedSetRevision: number;
  idempotencyKey: string;
}

export interface UpstreamServiceCreateCommand extends UpstreamServicePublishingCommandBase {
  action: "create";
  serviceKey: string;
  descriptor: UpstreamServiceDescriptor;
}

export interface UpstreamServiceReplaceCommand extends UpstreamServicePublishingCommandBase {
  action: "replace";
  serviceId: string;
  descriptor: UpstreamServiceDescriptor;
}

export interface UpstreamServiceDisableCommand extends UpstreamServicePublishingCommandBase {
  action: "disable";
  serviceId: string;
}

export interface UpstreamServiceRemoveCommand extends UpstreamServicePublishingCommandBase {
  action: "remove";
  serviceId: string;
}

export interface UpstreamServiceRepublishCommand extends UpstreamServicePublishingCommandBase {
  action: "republish";
  serviceId: string;
  descriptor?: UpstreamServiceDescriptor;
}

export type UpstreamServicePublishingCommand =
  | UpstreamServiceCreateCommand
  | UpstreamServiceReplaceCommand
  | UpstreamServiceDisableCommand
  | UpstreamServiceRemoveCommand
  | UpstreamServiceRepublishCommand;

/**
 * Durable service state and publication facts. A durable service is only
 * `publishing`, `disabled`, or `removed`. The separate publication object is
 * `publishing` until the durable published snapshot and the catalog, audience,
 * and protocol revision chain agree, and only `server_published` carries the
 * terminal source/catalog/audience/protocol facts.
 */
export interface UpstreamServicePublicationTerminalFacts {
  sourceRevision: number;
  sourceDigest: string;
  catalogRevision: string;
  audienceRevision: number;
  protocolRevision: number;
}

export interface UpstreamServicePublishingPublication {
  publicationRef: string;
  status: "publishing";
  candidateRevision: number;
  candidateDigest: string;
}

export interface UpstreamServiceServerPublishedPublication {
  publicationRef: string;
  status: "server_published";
  candidateRevision: number;
  candidateDigest: string;
  terminal: UpstreamServicePublicationTerminalFacts;
}

export type UpstreamServicePublication =
  | UpstreamServicePublishingPublication
  | UpstreamServiceServerPublishedPublication;

/** Accepted mutation receipt returned before the durable candidate publishes. */
export interface UpstreamServicePublishingResult {
  ok: true;
  serviceId: string;
  state: UpstreamServiceState;
  serviceRevision: number;
  setRevision: number;
  manifestDigest: string;
  receiptRef: string;
  publication: UpstreamServicePublishingPublication;
  replayed: boolean;
}

export interface PublishedUpstreamServiceSummary {
  serviceId: string;
  state: UpstreamServiceState;
  serviceRevision: number;
  manifestDigest: string;
  publication: UpstreamServicePublication;
}

export interface PublishedUpstreamServiceDetail extends PublishedUpstreamServiceSummary {
  descriptor: UpstreamServiceDescriptor | null;
  references: readonly TypedServiceReference[];
}

export interface UpstreamServiceListResponse {
  ok: true;
  setRevision: number;
  services: readonly PublishedUpstreamServiceSummary[];
}

export interface UpstreamServiceDetailResponse {
  ok: true;
  setRevision: number;
  service: PublishedUpstreamServiceDetail;
}

const SAFE_SERVICE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}(?:\/[A-Za-z][A-Za-z0-9_.-]{0,63}){0,3}$/u;
const PORTABLE_DOCUMENT_FIELDS = new Set(["kind", "schemaVersion", "serviceKey", "descriptor"]);
const PORTABLE_DESCRIPTOR_FIELDS = new Set(UPSTREAM_SERVICE_DESCRIPTOR_FIELDS);
const ENDPOINT_FIELDS = new Set(UPSTREAM_SERVICE_ENDPOINT_FIELDS);
const OPERATION_FIELDS = new Set(UPSTREAM_SERVICE_OPERATION_FIELDS);
const PAYLOAD_TRANSPORT_FIELDS = new Set(UPSTREAM_PAYLOAD_TRANSPORT_FIELDS);
const MCP_DESCRIPTOR_FIELDS = new Set(UPSTREAM_MCP_DESCRIPTOR_FIELDS);
const MCP_REMOTE_TRANSPORTS = new Set<string>(UPSTREAM_MCP_REMOTE_TRANSPORTS);
const MCP_PROTOCOL_VERSIONS = new Set<string>(UPSTREAM_MCP_PROTOCOL_VERSIONS);
const REFERENCE_FIELDS = new Set([
  "type", "reference", "revision", "use", "operationKey", "host", "protocol", "scopes"
]);
const REFERENCE_SCHEMES: Readonly<Record<TypedServiceReference["type"], ReadonlySet<string>>> = Object.freeze({
  credential: new Set(["credential", "secret"]),
  certificate: new Set(["certificate"]),
  "private-key": new Set(["private-key"]),
  "trust-anchor": new Set(["trust-anchor"])
});
const SENSITIVE_MCP_HEADER_NAME = /(?:password|passphrase|secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|cookie|api[_-]?key|credential|private[_-]?key|certificate)/iu;
const INLINE_SECRET_VALUE = /-----BEGIN [A-Z0-9 ]+-----|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}|\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]{8,}\b|\bxox[baprs]-[A-Za-z0-9-]{8,}\b|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu;

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

export function isUpstreamServiceRemoteUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return /^https?:\/\//iu.test(value) && ["http:", "https:"].includes(url.protocol) &&
    Boolean(url.hostname) && !url.username && !url.password;
}

function assertPortableRemoteUrl(value: unknown, field: string): void {
  if (!isUpstreamServiceRemoteUrl(value)) {
    throw new Error(`${field} must use an HTTP(S) URL without embedded credentials.`);
  }
}

function validatePortableReference(value: unknown, index: number): void {
  if (!isPlainObject(value)) throw new Error(`descriptor.references[${index}] must be an object.`);
  const unsupported = unknownFields(value, REFERENCE_FIELDS);
  if (unsupported.length) throw new Error(`Unknown descriptor.references[${index}] field(s): ${unsupported.join(", ")}.`);
  if (typeof value.type !== "string" || !Object.hasOwn(REFERENCE_SCHEMES, value.type)) {
    throw new Error(`descriptor.references[${index}].type must name a supported reference type.`);
  }
  if (typeof value.reference !== "string" || value.reference.length > 512 ||
      !/^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._~:/-]+$/u.test(value.reference)) {
    throw new Error(`descriptor.references[${index}].reference must be a typed reference URI.`);
  }
  const scheme = value.reference.slice(0, value.reference.indexOf(":"));
  if (!REFERENCE_SCHEMES[value.type as TypedServiceReference["type"]].has(scheme) || /[@?#]/u.test(value.reference)) {
    throw new Error(`descriptor.references[${index}].reference does not match its declared type.`);
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
    throw new Error(`descriptor.references[${index}].revision must be a positive safe integer.`);
  }
  if (typeof value.use !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value.use)) {
    throw new Error(`descriptor.references[${index}].use is invalid.`);
  }
  if (value.operationKey !== undefined && (typeof value.operationKey !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value.operationKey))) {
    throw new Error(`descriptor.references[${index}].operationKey is invalid.`);
  }
  if (value.host !== undefined && (typeof value.host !== "string" || value.host.length > 253 ||
      !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/u.test(value.host))) {
    throw new Error(`descriptor.references[${index}].host is invalid.`);
  }
  if (value.protocol !== undefined && (typeof value.protocol !== "string" ||
      !/^[a-z][a-z0-9+.-]{0,31}$/u.test(value.protocol))) {
    throw new Error(`descriptor.references[${index}].protocol is invalid.`);
  }
  if (value.scopes !== undefined) {
    if (!Array.isArray(value.scopes) || value.scopes.length > 128 || value.scopes.some((scope) =>
      typeof scope !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(scope)
    ) || new Set(value.scopes).size !== value.scopes.length) {
      throw new Error(`descriptor.references[${index}].scopes must contain unique valid scope identifiers.`);
    }
  }
}

function validatePortableMcpDescriptor(value: unknown, descriptor: Record<string, unknown>): void {
  if (!isPlainObject(value)) throw new Error("descriptor.mcp must be an object.");
  const unsupported = unknownFields(value, MCP_DESCRIPTOR_FIELDS);
  if (unsupported.length) throw new Error(`Unknown descriptor.mcp field(s): ${unsupported.join(", ")}.`);
  if (typeof value.transport !== "string" || !MCP_REMOTE_TRANSPORTS.has(value.transport.toLowerCase())) {
    throw new Error("descriptor.mcp.transport must select a supported remote HTTP transport.");
  }
  if (typeof value.protocolVersion !== "string" || !MCP_PROTOCOL_VERSIONS.has(value.protocolVersion)) {
    throw new Error("descriptor.mcp.protocolVersion must select a supported upstream MCP version.");
  }
  const remoteUrl = value.url || value.endpoint || value.baseUrl || descriptor.baseUrl;
  assertPortableRemoteUrl(remoteUrl, "descriptor.mcp.url");
  if (Object.hasOwn(descriptor, "operations")) {
    throw new Error("MCP descriptors derive tools from the remote catalog and cannot include operations.");
  }
  if (value.headers !== undefined) {
    if (!isPlainObject(value.headers)) throw new Error("descriptor.mcp.headers must be an object of declarative request headers.");
    for (const [name, headerValue] of Object.entries(value.headers)) {
      if (!name || name.length > 128 || name.normalize("NFC") !== name ||
          /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/u.test(name) ||
          name === "__proto__" || name === "prototype" || name === "constructor") {
        throw new Error("MCP request header names are invalid.");
      }
      if (SENSITIVE_MCP_HEADER_NAME.test(name)) {
        throw new Error("Sensitive header names must use a typed credential reference.");
      }
      if (typeof headerValue !== "string" || !headerValue || headerValue.normalize("NFC") !== headerValue || headerValue.length > 8_192 ||
          /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/u.test(headerValue) ||
          /\$\{|\{\{|<%|\bfile:\/\//u.test(headerValue) || INLINE_SECRET_VALUE.test(headerValue)) {
        throw new Error("MCP request headers must contain non-sensitive declarative string values.");
      }
    }
  }
  for (const field of ["toolNamePrefix", "prefix"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`descriptor.mcp.${field} must be a string.`);
    }
  }
  for (const field of ["toolsCacheTtlMs", "timeoutMs"]) {
    if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]))) {
      throw new Error(`descriptor.mcp.${field} must be a finite number.`);
    }
  }
  validateOptionalExecutionTimeout(value.timeoutMs, "descriptor.mcp.timeoutMs");
}

function validateOptionalExecutionTimeout(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`${field} must be a positive whole number of milliseconds within the supported timer range.`);
  }
}

function validatePortableDescriptor(
  descriptor: Record<string, unknown>
): asserts descriptor is Record<string, unknown> & UpstreamServiceDescriptor {
  const unsupported = unknownFields(descriptor, PORTABLE_DESCRIPTOR_FIELDS);
  if (unsupported.length) throw new Error(`Unknown descriptor field(s): ${unsupported.join(", ")}.`);
  if (descriptor.serviceProtocol !== "http" && descriptor.serviceProtocol !== "json-rpc" && descriptor.serviceProtocol !== "mcp") {
    throw new Error('descriptor.serviceProtocol must be "http", "json-rpc", or "mcp".');
  }
  if (descriptor.allowLocalNetwork !== undefined && typeof descriptor.allowLocalNetwork !== "boolean") {
    throw new Error("descriptor.allowLocalNetwork must be boolean.");
  }
  if (descriptor.serviceProtocol === "mcp") {
    validatePortableMcpDescriptor(descriptor.mcp, descriptor);
    if (descriptor.references !== undefined) {
      if (!Array.isArray(descriptor.references)) throw new Error("descriptor.references must be an array.");
      descriptor.references.forEach(validatePortableReference);
    }
    return;
  }
  if (descriptor.mcp !== undefined) {
    throw new Error("descriptor.mcp is only valid when serviceProtocol is \"mcp\".");
  }
  if (descriptor.references !== undefined) {
    if (!Array.isArray(descriptor.references)) throw new Error("descriptor.references must be an array.");
    descriptor.references.forEach(validatePortableReference);
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
    validateOptionalExecutionTimeout(operation.timeoutMs, `descriptor.operations[${index}].timeoutMs`);
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
