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
  /** Canonical HTTP(S) origin (scheme, host and effective port) authorized for this binding. */
  origin?: string;
  host?: string;
  protocol?: string;
  scopes?: string[];
}

/** Credential reference data accepted by the shared upstream material resolver. */
export interface UpstreamCredentialMaterialBinding {
  readonly type?: string;
  readonly reference: string;
  readonly revision?: number;
  readonly operationKey?: string;
  readonly origin?: string;
  readonly host?: string;
  readonly protocol?: string;
  readonly scopes?: readonly string[];
}

/** Plaintext payload returned by a runtime-specific secret authority adapter. */
export interface UpstreamCredentialPayloadResolution {
  readonly payload: unknown;
  readonly secretRef?: string;
  readonly revision?: number;
}

/** The env projection is for configured local stdio only; remote MCP callers use headers alone. */
export interface UpstreamCredentialMaterial {
  readonly headers: Record<string, string>;
  readonly env: Record<string, string>;
  readonly credentialRefCount: number;
  readonly resolvedCredentialRefCount: number;
  readonly credentialRevisions: readonly Readonly<{ secretRef: string; revision: number }>[];
}

export type UpstreamCredentialPayloadResolver = (
  binding: Readonly<UpstreamCredentialMaterialBinding>,
  targetOrigin: string,
  tenantId: string,
  signal?: AbortSignal,
  operationKey?: string,
  requiredScopes?: readonly string[]
) => Promise<UpstreamCredentialPayloadResolution>;

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
  "type", "reference", "revision", "use", "operationKey", "origin", "host", "protocol", "scopes"
]);
const REFERENCE_SCHEMES: Readonly<Record<TypedServiceReference["type"], ReadonlySet<string>>> = Object.freeze({
  credential: new Set(["credential", "secret"]),
  certificate: new Set(["certificate"]),
  "private-key": new Set(["private-key"]),
  "trust-anchor": new Set(["trust-anchor"])
});
const SENSITIVE_MCP_HEADER_NAME = /(?:^|[-_])(?:password|passcode|passphrase|secret|token|auth(?:orization)?|cookie|session|api[_-]?key|credential|private[_-]?key|certificate|bearer)(?:$|[-_])/iu;
const INLINE_SECRET_VALUE = /-----BEGIN [A-Z0-9 ]+-----|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}|\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]{8,}\b|\bxox[baprs]-[A-Za-z0-9-]{8,}\b|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu;
const MCP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const MCP_RESERVED_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "x-meshrix-skill-hub-subject"
]);
const UTF8_ENCODER = new TextEncoder();

function invalidMcpRequestHeaders(): Error & { code: string } {
  return Object.assign(new Error("MCP request headers are invalid."), {
    code: "upstream_mcp_headers_invalid"
  });
}

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

function normalizeMcpHeaders(value: unknown, { contextOnly }: { contextOnly: boolean }): Record<string, string> {
  if (!isPlainObject(value)) throw invalidMcpRequestHeaders();
  const output: Record<string, string> = {};
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (rawName.length > 128 || !MCP_HEADER_NAME_PATTERN.test(rawName) ||
        rawName === "__proto__" || rawName === "prototype" || rawName === "constructor" ||
        seen.has(name) ||
        (contextOnly && (MCP_RESERVED_HEADER_NAMES.has(name) || SENSITIVE_MCP_HEADER_NAME.test(name)))) {
      throw invalidMcpRequestHeaders();
    }
    if (MCP_RESERVED_HEADER_NAMES.has(name)) continue;
    if (typeof rawValue !== "string" || rawValue.length > 8_192 || rawValue.normalize("NFC") !== rawValue ||
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/u.test(rawValue) ||
        (contextOnly && (
          rawValue.length === 0 ||
          /\$\{|\{\{|<%|\bfile:\/\//u.test(rawValue) ||
          INLINE_SECRET_VALUE.test(rawValue)
        ))) {
      throw invalidMcpRequestHeaders();
    }
    totalBytes += UTF8_ENCODER.encode(name).byteLength + UTF8_ENCODER.encode(rawValue).byteLength + 4;
    if (seen.size >= 64 || totalBytes > 32 * 1024) {
      throw invalidMcpRequestHeaders();
    }
    seen.add(name);
    output[name] = rawValue;
  }
  return output;
}

/** Validate declarative MCP context headers. Values, including `$NAME`, remain literal data. */
export function normalizeUpstreamMcpContextHeaders(value: unknown = {}): Record<string, string> {
  return normalizeMcpHeaders(value, { contextOnly: true });
}

/** Validate complete HTTP MCP request headers after credentials have been resolved. */
export function normalizeUpstreamMcpHttpRequestHeaders(value: unknown = {}): Record<string, string> {
  return normalizeMcpHeaders(value, { contextOnly: false });
}

/** Identify request headers that must not cross a change of upstream origin. */
export function isUpstreamCredentialHeaderName(value: unknown): boolean {
  return typeof value === "string" && SENSITIVE_MCP_HEADER_NAME.test(value.toLowerCase());
}

export function isUpstreamServiceOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.origin === value;
  } catch {
    return false;
  }
}

const SECRET_REFERENCE_PATTERN = /^secret:\/\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._~-]*)*$/u;
const CREDENTIAL_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const CREDENTIAL_ENV_MAX_ENTRIES = 1_024;
const CREDENTIAL_ENV_MAX_VALUE_LENGTH = 65_536;
const CREDENTIAL_ENV_MAX_TOTAL_BYTES = 1024 * 1024;

function credentialMaterialError(reasonCode: string, status: number): Error & { status: number; reasonCode: string } {
  const message = reasonCode === "upstream_credential_material_invalid"
    ? "Upstream credential material is invalid."
    : reasonCode === "upstream_credential_resolution_failed"
      ? "Upstream gateway credential resolution failed."
      : "Upstream credential binding was denied.";
  return Object.assign(new Error(message), { status, reasonCode });
}

function cancelledCredentialResolution(): Error & { code: string } {
  return Object.assign(new Error("Upstream credential resolution was cancelled."), {
    name: "AbortError",
    code: "ABORT_ERR"
  });
}

function secretMaterialText(value: unknown): string {
  if (value === undefined || value === null) return "";
  const material = String(value);
  if (/[\r\n\u0000]/u.test(material)) {
    throw credentialMaterialError("upstream_credential_material_invalid", 503);
  }
  return material;
}

function secretPayloadObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw credentialMaterialError("upstream_credential_material_invalid", 503);
  }
  return value;
}

function secretPayloadHeaders(payload: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = Object.create(null);
  const add = (rawName: unknown, rawValue: unknown, { overwrite = true } = {}) => {
    if (rawValue === undefined || rawValue === null) return;
    const name = typeof rawName === "string" ? rawName.toLowerCase() : "";
    const value = secretMaterialText(rawValue);
    if (!name || !value) {
      throw credentialMaterialError("upstream_credential_material_invalid", 503);
    }
    if (overwrite || headers[name] === undefined) headers[name] = value;
  };
  const rawHeaders = payload.headers ?? payload.header;
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (!isPlainObject(rawHeaders)) {
      throw credentialMaterialError("upstream_credential_material_invalid", 503);
    }
    for (const [name, value] of Object.entries(rawHeaders)) add(name, value);
  }
  const explicitHeaderValue = payload.headerValue ?? payload.value;
  if (payload.headerName !== undefined || explicitHeaderValue !== undefined) {
    add(payload.headerName || payload.name, explicitHeaderValue);
  }
  for (const key of ["authorization", "authHeader"]) {
    if (payload[key] !== undefined) add("authorization", payload[key], { overwrite: false });
  }
  let bearerToken = "";
  for (const key of ["bearerToken", "accessToken", "token"]) {
    const candidate = secretMaterialText(payload[key]);
    if (candidate) {
      bearerToken = candidate;
      break;
    }
  }
  if (!bearerToken && isPlainObject(payload.oauth)) {
    bearerToken = secretMaterialText(payload.oauth.accessToken);
  }
  if (bearerToken && headers.authorization === undefined) {
    add("authorization", /^Bearer\s+/iu.test(bearerToken) ? bearerToken : `Bearer ${bearerToken}`);
  }
  let apiKey = "";
  for (const key of ["apiKey", "api_key", "key"]) {
    const candidate = secretMaterialText(payload[key]);
    if (candidate) {
      apiKey = candidate;
      break;
    }
  }
  if (apiKey && headers["x-api-key"] === undefined) add("x-api-key", apiKey);
  try {
    return normalizeUpstreamMcpHttpRequestHeaders(headers);
  } catch {
    throw credentialMaterialError("upstream_credential_material_invalid", 503);
  }
}

function secretPayloadEnvironment(payload: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = Object.create(null);
  let totalBytes = 0;
  let entryCount = 0;
  const add = (name: string, rawValue: unknown) => {
    if (!CREDENTIAL_ENV_NAME_PATTERN.test(name)) return;
    const value = secretMaterialText(rawValue);
    if (!value) return;
    const entryBytes = UTF8_ENCODER.encode(name).byteLength + UTF8_ENCODER.encode(value).byteLength;
    if (name.length > 256 || value.length > CREDENTIAL_ENV_MAX_VALUE_LENGTH ||
        !Number.isSafeInteger(totalBytes + entryBytes) ||
        totalBytes + entryBytes > CREDENTIAL_ENV_MAX_TOTAL_BYTES) {
      throw credentialMaterialError("upstream_credential_material_invalid", 503);
    }
    if (env[name] === undefined) {
      if (entryCount >= CREDENTIAL_ENV_MAX_ENTRIES) {
        throw credentialMaterialError("upstream_credential_material_invalid", 503);
      }
      env[name] = value;
      totalBytes += entryBytes;
      entryCount += 1;
    }
  };
  const rawEnv = payload.env ?? payload.environment;
  if (rawEnv !== undefined && rawEnv !== null) {
    if (!isPlainObject(rawEnv)) {
      throw credentialMaterialError("upstream_credential_material_invalid", 503);
    }
    for (const [name, value] of Object.entries(rawEnv)) add(name, value);
  }
  const explicitName = payload.envName ?? payload.environmentName;
  if (typeof explicitName === "string") add(explicitName, payload.envValue ?? payload.value);
  return Object.fromEntries(Object.entries(env));
}

function credentialOriginScope(origin: string): { host: string; protocol: string } {
  const url = new URL(origin);
  return {
    host: url.hostname.replace(/^\[|\]$/gu, "").toLowerCase(),
    protocol: url.protocol.slice(0, -1).toLowerCase()
  };
}

function bindingMatchesOperation(
  binding: Readonly<UpstreamCredentialMaterialBinding>,
  operationKey: string
): boolean {
  if (binding.operationKey !== undefined && typeof binding.operationKey !== "string") {
    throw credentialMaterialError("upstream_credential_binding_denied", 403);
  }
  const bindingOperationKey = typeof binding.operationKey === "string" ? binding.operationKey.trim() : "";
  if (bindingOperationKey.length > 128) {
    throw credentialMaterialError("upstream_credential_binding_denied", 403);
  }
  return !bindingOperationKey || bindingOperationKey === operationKey;
}

function selectCredentialBindings(
  bindings: readonly UpstreamCredentialMaterialBinding[],
  targetOrigin: string,
  operationKey: string,
  requiredScopes: readonly string[]
): Readonly<UpstreamCredentialMaterialBinding>[] {
  const target = credentialOriginScope(targetOrigin);
  const operationScopeSet = new Set(requiredScopes);
  const selected: Readonly<UpstreamCredentialMaterialBinding>[] = [];
  for (const rawBinding of bindings) {
    if (!isPlainObject(rawBinding)) {
      throw credentialMaterialError("upstream_credential_binding_denied", 403);
    }
    const binding = rawBinding as Readonly<UpstreamCredentialMaterialBinding>;
    if (!bindingMatchesOperation(binding, operationKey)) continue;
    if (binding.type !== undefined && binding.type !== "credential") {
      throw credentialMaterialError("upstream_credential_authority_unsupported", 503);
    }
    const bindingOrigin = typeof binding.origin === "string" ? binding.origin : "";
    if (bindingOrigin) {
      if (!isUpstreamServiceOrigin(bindingOrigin)) {
        throw credentialMaterialError("upstream_credential_binding_denied", 403);
      }
      if (bindingOrigin !== targetOrigin) continue;
    } else {
      const bindingHost = typeof binding.host === "string" ? binding.host.toLowerCase() : "";
      const bindingProtocol = typeof binding.protocol === "string" ? binding.protocol.toLowerCase() : "";
      const hostMatches = !bindingHost || bindingHost === target.host;
      const protocolMatches = !bindingProtocol || bindingProtocol === target.protocol;
      if (!hostMatches || !protocolMatches) continue;
      throw credentialMaterialError("upstream_credential_binding_origin_required", 403);
    }
    const reference = typeof binding.reference === "string" ? binding.reference : "";
    if (!SECRET_REFERENCE_PATTERN.test(reference) || reference.split("/").some((segment) => segment === "." || segment === "..")) {
      throw credentialMaterialError("upstream_credential_authority_unsupported", 503);
    }
    // Internal normalized legacy references use zero to mean "resolve current";
    // portable/published typed references require a positive revision.
    if (binding.revision !== undefined && (!Number.isSafeInteger(binding.revision) || Number(binding.revision) < 0)) {
      throw credentialMaterialError("upstream_credential_binding_denied", 403);
    }
    if ((binding.host !== undefined && typeof binding.host !== "string") ||
        (binding.protocol !== undefined && typeof binding.protocol !== "string")) {
      throw credentialMaterialError("upstream_credential_binding_denied", 403);
    }
    const bindingHost = typeof binding.host === "string" ? binding.host.toLowerCase() : "";
    const bindingProtocol = typeof binding.protocol === "string" ? binding.protocol.toLowerCase() : "";
    if ((bindingHost && bindingHost !== target.host) ||
        (bindingProtocol && bindingProtocol !== target.protocol) ||
        (binding.scopes !== undefined && (!Array.isArray(binding.scopes) || binding.scopes.some((scope) => typeof scope !== "string"))) ||
        (binding.scopes || []).some((scope) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(scope) || !operationScopeSet.has(scope))) {
      throw credentialMaterialError("upstream_credential_binding_denied", 403);
    }
    selected.push(binding);
  }
  return selected;
}

/** Resolve only exact-origin, operation-authorized credential bindings through an injected secret authority. */
export async function resolveUpstreamCredentialMaterial({
  bindings,
  targetOrigin,
  operationKey = "",
  requiredScopes = [],
  tenantId = "",
  signal,
  resolveSecretPayload
}: {
  readonly bindings: readonly UpstreamCredentialMaterialBinding[];
  readonly targetOrigin: string;
  readonly operationKey?: string;
  readonly requiredScopes?: readonly string[];
  readonly tenantId?: string;
  readonly signal?: AbortSignal;
  readonly resolveSecretPayload: UpstreamCredentialPayloadResolver;
}): Promise<UpstreamCredentialMaterial> {
  if (!Array.isArray(bindings) || !Array.isArray(requiredScopes) ||
      requiredScopes.some((scope) => typeof scope !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(scope)) ||
      typeof operationKey !== "string" || operationKey.length > 128 || typeof resolveSecretPayload !== "function") {
    throw credentialMaterialError("upstream_credential_binding_denied", 403);
  }
  const operation = operationKey.trim();
  const scopes = [...requiredScopes];
  const operationCandidates: UpstreamCredentialMaterialBinding[] = [];
  for (const binding of bindings) {
    if (!isPlainObject(binding)) throw credentialMaterialError("upstream_credential_binding_denied", 403);
    const typedBinding = binding as unknown as UpstreamCredentialMaterialBinding;
    if (bindingMatchesOperation(typedBinding, operation)) operationCandidates.push(typedBinding);
  }
  if (operationCandidates.length === 0) {
    return { headers: {}, env: {}, credentialRefCount: 0, resolvedCredentialRefCount: 0, credentialRevisions: [] };
  }
  if (!isUpstreamServiceOrigin(targetOrigin) || typeof tenantId !== "string" || tenantId.length > 256) {
    throw credentialMaterialError("upstream_credential_binding_denied", 403);
  }
  const selected = selectCredentialBindings(operationCandidates, targetOrigin, operation, scopes);
  if (selected.length === 0) {
    return { headers: {}, env: {}, credentialRefCount: 0, resolvedCredentialRefCount: 0, credentialRevisions: [] };
  }
  const materialHeaders: Record<string, string> = Object.create(null);
  const materialEnv: Record<string, string> = Object.create(null);
  const credentialRevisions: Array<{ secretRef: string; revision: number }> = [];
  const assertNotCancelled = () => {
    if (signal?.aborted) throw cancelledCredentialResolution();
  };
  assertNotCancelled();
  for (const binding of selected) {
    assertNotCancelled();
    let resolved: UpstreamCredentialPayloadResolution;
    try {
      resolved = await resolveSecretPayload(binding, targetOrigin, tenantId, signal, operation, scopes);
    } catch (error: unknown) {
      if (signal?.aborted) throw cancelledCredentialResolution();
      const candidate = error as { code?: unknown; status?: unknown; reasonCode?: unknown } | null;
      const rawCode = typeof candidate?.reasonCode === "string"
        ? candidate.reasonCode
        : typeof candidate?.code === "string"
          ? candidate.code
          : "upstream_credential_resolution_failed";
      const reasonCode = /^[a-z][a-z0-9_]{0,127}$/u.test(rawCode)
        ? rawCode
        : "upstream_credential_resolution_failed";
      const status = candidate?.status === 403 || candidate?.code === "local_secret_scope_denied" ? 403 : 503;
      throw Object.assign(credentialMaterialError(reasonCode, status), {
        credentialRefCount: selected.length,
        resolvedCredentialRefCount: credentialRevisions.length
      });
    }
    assertNotCancelled();
    const resolvedRevision = resolved?.revision ?? binding.revision;
    if (!isPlainObject(resolved) ||
        (resolved.secretRef !== undefined && resolved.secretRef !== binding.reference) ||
        !Number.isSafeInteger(resolvedRevision) || Number(resolvedRevision) < 1 ||
        (Number(binding.revision) > 0 && resolvedRevision !== binding.revision)) {
      throw credentialMaterialError("upstream_credential_resolution_failed", 503);
    }
    const payload = secretPayloadObject(resolved.payload);
    const headers = secretPayloadHeaders(payload);
    const env = secretPayloadEnvironment(payload);
    for (const [name, value] of Object.entries(headers)) {
      if (materialHeaders[name] === undefined) materialHeaders[name] = value;
    }
    for (const [name, value] of Object.entries(env)) {
      if (materialEnv[name] === undefined) materialEnv[name] = value;
    }
    credentialRevisions.push({
      secretRef: binding.reference,
      revision: Number(resolvedRevision)
    });
  }
  assertNotCancelled();
  return {
    headers: Object.fromEntries(Object.entries(materialHeaders)),
    env: Object.fromEntries(Object.entries(materialEnv)),
    credentialRefCount: selected.length,
    resolvedCredentialRefCount: credentialRevisions.length,
    credentialRevisions
  };
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
  if (value.origin !== undefined) {
    if (!isUpstreamServiceOrigin(value.origin)) {
      throw new Error(`descriptor.references[${index}].origin is invalid.`);
    }
  }
  if (value.host !== undefined && (typeof value.host !== "string" || value.host.length > 253 ||
      !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/u.test(value.host))) {
    throw new Error(`descriptor.references[${index}].host is invalid.`);
  }
  if (value.protocol !== undefined && (typeof value.protocol !== "string" ||
      !/^[a-z][a-z0-9+.-]{0,31}$/u.test(value.protocol))) {
    throw new Error(`descriptor.references[${index}].protocol is invalid.`);
  }
  if (typeof value.origin === "string") {
    const origin = new URL(value.origin);
    if ((value.host !== undefined && String(value.host).toLowerCase() !== origin.hostname.toLowerCase()) ||
        (value.protocol !== undefined && String(value.protocol).toLowerCase() !== origin.protocol.slice(0, -1))) {
      throw new Error(`descriptor.references[${index}] target fields must match its origin.`);
    }
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
    normalizeUpstreamMcpContextHeaders(value.headers);
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
