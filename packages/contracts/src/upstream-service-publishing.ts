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
  "contentPolicy",
  "oauth",
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
  "payloadTransport",
  "contentPolicy",
  "responseCache"
]);

export const UPSTREAM_SERVICE_OAUTH_FIELDS = Object.freeze([
  "grantType",
  "tokenUrl",
  "clientId",
  "clientSecretRef",
  "scopes",
  "audience",
  "authMethod"
]);

export const UPSTREAM_OAUTH_GRANT_TYPES = Object.freeze(["client_credentials"]);
export const UPSTREAM_OAUTH_AUTH_METHODS = Object.freeze([
  "client_secret_basic",
  "client_secret_post"
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
  "timeoutMs",
  "aliases"
] as const);

const UPSTREAM_MCP_ALIAS_MAX_ENTRIES = 128;
const UPSTREAM_MCP_ALIAS_KEY_MAX = 128;
const UPSTREAM_MCP_ALIAS_NAME = /^[A-Za-z0-9_-]{1,80}$/u;
const UPSTREAM_MCP_ALIAS_TEXT_MAX = 2048;

export interface UpstreamMcpToolAlias {
  /** Public tool-name segment replacing the upstream name under `upstream.{prefix}.`. */
  name?: string;
  title?: string;
  description?: string;
}

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
  /** Operator curation map: upstream tool name -> public alias. */
  aliases?: Record<string, string | UpstreamMcpToolAlias>;
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
  contentPolicy?: UpstreamServiceContentPolicy;
  responseCache?: UpstreamServiceResponseCache;
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
  contentPolicy?: UpstreamServiceContentPolicy;
  oauth?: UpstreamServiceOauth;
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

const CONTENT_POLICY_FIELDS = new Set(["request"]);
const CONTENT_POLICY_REQUEST_FIELDS = new Set(["rules"]);
const CONTENT_POLICY_RULE_FIELDS = new Set(["id", "path", "deny", "allow"]);
const CONTENT_POLICY_COMPARE_FIELDS = new Set(["gt", "gte", "lt", "lte"]);
const CONTENT_POLICY_DENY_FIELDS = new Set([
  "contains", "matches", "oneOf", "notIn", "eq", "neq", "startsWith", "endsWith", "exists", "compare"
]);
const CONTENT_POLICY_ALLOW_FIELDS = new Set([
  "oneOf", "matches", "notIn", "eq", "neq", "startsWith", "endsWith", "exists", "compare"
]);
const CONTENT_POLICY_MAX_AFFIX_LENGTH = 256;
const CONTENT_POLICY_MAX_RULES = 32;
const CONTENT_POLICY_RULE_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const CONTENT_POLICY_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/u;
const CONTENT_POLICY_MAX_PATH_SEGMENTS = 8;
const CONTENT_POLICY_FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const CONTENT_POLICY_MAX_PATTERN_COUNT = 16;
const CONTENT_POLICY_MAX_PATTERN_LENGTH = 512;
const CONTENT_POLICY_MAX_LITERAL_COUNT = 64;
const CONTENT_POLICY_MAX_LITERAL_LENGTH = 1024;
const CONTENT_POLICY_MAX_ONE_OF_COUNT = 128;
const OAUTH_FIELDS = new Set<string>(UPSTREAM_SERVICE_OAUTH_FIELDS);
const OAUTH_GRANT_TYPES = new Set<string>(UPSTREAM_OAUTH_GRANT_TYPES);
const OAUTH_AUTH_METHODS = new Set<string>(UPSTREAM_OAUTH_AUTH_METHODS);
const OAUTH_CLIENT_ID = /^[\x21-\x7e]{1,256}$/u;
const OAUTH_SECRET_REF = /^secret:\/\/[A-Za-z0-9._~:/-]+$/u;
const OAUTH_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const OAUTH_MAX_SCOPES = 64;
const OAUTH_MAX_AUDIENCE_LENGTH = 1024;

function validateContentPolicyLiteralList(value: unknown, field: string, { maxCount, maxLength }: { maxCount: number; maxLength: number }): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxCount) {
    throw new Error(`${field} must be an array of 1..${maxCount} entries.`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > maxLength) {
      throw new Error(`${field} entries must be strings of 1..${maxLength} characters.`);
    }
  }
}

function validateContentPolicyMatches(value: unknown, field: string): void {
  validateContentPolicyLiteralList(value, field, {
    maxCount: CONTENT_POLICY_MAX_PATTERN_COUNT,
    maxLength: CONTENT_POLICY_MAX_PATTERN_LENGTH
  });
  for (const entry of value as string[]) {
    try {
      new RegExp(entry, "u");
    } catch {
      throw new Error(`${field} contains a pattern that does not compile.`);
    }
  }
}

function validateContentPolicyScalarList(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > CONTENT_POLICY_MAX_ONE_OF_COUNT) {
    throw new Error(`${field} must be an array of 1..${CONTENT_POLICY_MAX_ONE_OF_COUNT} scalar entries.`);
  }
  for (const entry of value) {
    const scalar = entry === null || ["string", "number", "boolean"].includes(typeof entry);
    if (!scalar || (typeof entry === "number" && !Number.isFinite(entry)) ||
        (typeof entry === "string" && entry.length > CONTENT_POLICY_MAX_LITERAL_LENGTH)) {
      throw new Error(`${field} entries must be finite numbers, booleans, null, or strings of at most ${CONTENT_POLICY_MAX_LITERAL_LENGTH} characters.`);
    }
  }
}

function validateContentPolicyScalar(value: unknown, field: string): void {
  const scalar = value === null || ["string", "number", "boolean"].includes(typeof value);
  if (!scalar || (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof value === "string" && value.length > CONTENT_POLICY_MAX_LITERAL_LENGTH)) {
    throw new Error(`${field} must be a finite number, boolean, null, or a string of at most ${CONTENT_POLICY_MAX_LITERAL_LENGTH} characters.`);
  }
}

function validateContentPolicyCompare(value: unknown, field: string): void {
  if (!isPlainObject(value)) throw new Error(`${field} must be an object.`);
  const unsupported = unknownFields(value, CONTENT_POLICY_COMPARE_FIELDS);
  if (unsupported.length) throw new Error(`Unknown ${field} field(s): ${unsupported.join(", ")}.`);
  const declared = Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined);
  if (declared.length === 0) throw new Error(`${field} declares no comparison bound.`);
  for (const key of declared) {
    const bound = (value as Record<string, unknown>)[key];
    if (typeof bound !== "number" || !Number.isFinite(bound)) {
      throw new Error(`${field}.${key} must be a finite number.`);
    }
  }
}

function validateContentPolicyMatcherExtensions(matcher: unknown, field: string): void {
  const rule = matcher as Record<string, unknown>;
  for (const key of ["eq", "neq"] as const) {
    if (rule[key] !== undefined) validateContentPolicyScalar(rule[key], `${field}.${key}`);
  }
  for (const key of ["startsWith", "endsWith"] as const) {
    if (rule[key] !== undefined) {
      const affix = rule[key];
      if (typeof affix !== "string" || affix.length === 0 || affix.length > CONTENT_POLICY_MAX_AFFIX_LENGTH) {
        throw new Error(`${field}.${key} must be a string of 1..${CONTENT_POLICY_MAX_AFFIX_LENGTH} characters.`);
      }
    }
  }
  if (rule.exists !== undefined && typeof rule.exists !== "boolean") {
    throw new Error(`${field}.exists must be a boolean.`);
  }
  if (rule.notIn !== undefined) {
    validateContentPolicyScalarList(rule.notIn, `${field}.notIn`);
  }
  if (rule.compare !== undefined) {
    validateContentPolicyCompare(rule.compare, `${field}.compare`);
  }
}

function validateContentPolicyPath(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${field} must be a selector path of at most 512 characters.`);
  }
  const segments = value.split(".");
  if (segments.length > CONTENT_POLICY_MAX_PATH_SEGMENTS ||
      segments.some((segment) => !CONTENT_POLICY_PATH_SEGMENT.test(segment) || CONTENT_POLICY_FORBIDDEN_SEGMENTS.has(segment))) {
    throw new Error(`${field} must be a dotted path of up to ${CONTENT_POLICY_MAX_PATH_SEGMENTS} safe property segments.`);
  }
}

export function validateUpstreamContentPolicy(value: unknown, field: string = "contentPolicy"): void {
  if (!isPlainObject(value)) throw new Error(`${field} must be an object.`);
  const unsupported = unknownFields(value, CONTENT_POLICY_FIELDS);
  if (unsupported.length) throw new Error(`Unknown ${field} field(s): ${unsupported.join(", ")}.`);
  if (!isPlainObject(value.request)) {
    throw new Error(`${field} requires a request policy object.`);
  }
  const unsupportedRequestFields = unknownFields(value.request, CONTENT_POLICY_REQUEST_FIELDS);
  if (unsupportedRequestFields.length) {
    throw new Error(`Unknown ${field}.request field(s): ${unsupportedRequestFields.join(", ")}.`);
  }
  const rules = value.request.rules;
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > CONTENT_POLICY_MAX_RULES) {
    throw new Error(`${field}.request.rules must be an array of 1..${CONTENT_POLICY_MAX_RULES} rules.`);
  }
  const seenIds = new Set<string>();
  rules.forEach((rule, index) => {
    const label = `${field}.request.rules[${index}]`;
    if (!isPlainObject(rule)) throw new Error(`${label} must be an object.`);
    const unsupportedRuleFields = unknownFields(rule, CONTENT_POLICY_RULE_FIELDS);
    if (unsupportedRuleFields.length) {
      throw new Error(`Unknown ${label} field(s): ${unsupportedRuleFields.join(", ")}.`);
    }
    if (typeof rule.id !== "string" || !CONTENT_POLICY_RULE_ID.test(rule.id)) {
      throw new Error(`${label}.id must be a stable rule identifier.`);
    }
    if (seenIds.has(rule.id)) throw new Error(`${label}.id duplicates an earlier rule id.`);
    seenIds.add(rule.id);
    if (rule.path !== undefined) validateContentPolicyPath(rule.path, `${label}.path`);
    const hasDeny = rule.deny !== undefined;
    const hasAllow = rule.allow !== undefined;
    if (hasDeny === hasAllow) {
      throw new Error(`${label} requires exactly one of deny or allow.`);
    }
    const matcher = hasDeny ? rule.deny : rule.allow;
    const matcherFields = hasDeny ? CONTENT_POLICY_DENY_FIELDS : CONTENT_POLICY_ALLOW_FIELDS;
    if (!isPlainObject(matcher)) throw new Error(`${label}.${hasDeny ? "deny" : "allow"} must be an object.`);
    const unsupportedMatcherFields = unknownFields(matcher, matcherFields);
    if (unsupportedMatcherFields.length) {
      throw new Error(`Unknown ${label}.${hasDeny ? "deny" : "allow"} field(s): ${unsupportedMatcherFields.join(", ")}.`);
    }
    const declared = Object.keys(matcher).filter((key) => matcher[key] !== undefined);
    if (declared.length === 0) {
      throw new Error(`${label}.${hasDeny ? "deny" : "allow"} declares no matcher.`);
    }
    if (matcher.contains !== undefined) validateContentPolicyLiteralList(matcher.contains, `${label}.deny.contains`, {
      maxCount: CONTENT_POLICY_MAX_LITERAL_COUNT,
      maxLength: CONTENT_POLICY_MAX_LITERAL_LENGTH
    });
    if (matcher.matches !== undefined) {
      validateContentPolicyMatches(matcher.matches, `${label}.${hasDeny ? "deny" : "allow"}.matches`);
    }
    if (matcher.oneOf !== undefined) {
      validateContentPolicyScalarList(matcher.oneOf, `${label}.${hasDeny ? "deny" : "allow"}.oneOf`);
    }
    validateContentPolicyMatcherExtensions(matcher, `${label}.${hasDeny ? "deny" : "allow"}`);
    if (hasAllow && rule.path === undefined) {
      throw new Error(`${label}.allow requires a path selector.`);
    }
  });
}

const RESPONSE_CACHE_FIELDS = new Set(["ttlMs", "maxEntries", "maxBytes"]);
const RESPONSE_CACHE_MAX_TTL_MS = 600_000;
const RESPONSE_CACHE_MAX_ENTRIES_LIMIT = 256;
const RESPONSE_CACHE_MAX_BYTES_LIMIT = 256 * 1024;

/**
 * Operation-level response cache declaration. Honored only on `read_only`
 * operations that do not require approval; every bound is capped so a
 * descriptor cannot turn the cache into an unbounded store.
 */
export function validateUpstreamResponseCache(value: unknown, field: string = "responseCache"): void {
  if (!isPlainObject(value)) throw new Error(`${field} must be an object.`);
  const unsupported = unknownFields(value, RESPONSE_CACHE_FIELDS);
  if (unsupported.length) throw new Error(`Unknown ${field} field(s): ${unsupported.join(", ")}.`);
  const ttlMs = Number(value.ttlMs);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > RESPONSE_CACHE_MAX_TTL_MS) {
    throw new Error(`${field}.ttlMs must be a whole number of milliseconds in 1..${RESPONSE_CACHE_MAX_TTL_MS}.`);
  }
  if (value.maxEntries !== undefined) {
    const maxEntries = Number(value.maxEntries);
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > RESPONSE_CACHE_MAX_ENTRIES_LIMIT) {
      throw new Error(`${field}.maxEntries must be a whole number in 1..${RESPONSE_CACHE_MAX_ENTRIES_LIMIT}.`);
    }
  }
  if (value.maxBytes !== undefined) {
    const maxBytes = Number(value.maxBytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > RESPONSE_CACHE_MAX_BYTES_LIMIT) {
      throw new Error(`${field}.maxBytes must be a whole number in 1..${RESPONSE_CACHE_MAX_BYTES_LIMIT}.`);
    }
  }
}

/**
 * Validates a service-level OAuth client declaration. The descriptor only
 * carries public client metadata and a secret:// reference; the client secret
 * itself lives in the local secret store scoped to the token endpoint origin.
 */
export function validateUpstreamOauth(value: unknown, field: string = "oauth"): void {
  if (!isPlainObject(value)) throw new Error(`${field} must be an object.`);
  const unsupported = unknownFields(value, OAUTH_FIELDS);
  if (unsupported.length) throw new Error(`Unknown ${field} field(s): ${unsupported.join(", ")}.`);
  if (value.grantType !== undefined) {
    if (typeof value.grantType !== "string" || !OAUTH_GRANT_TYPES.has(value.grantType)) {
      throw new Error(`${field}.grantType must be "client_credentials".`);
    }
  }
  assertPortableRemoteUrl(value.tokenUrl, `${field}.tokenUrl`);
  if (typeof value.clientId !== "string" || !OAUTH_CLIENT_ID.test(value.clientId)) {
    throw new Error(`${field}.clientId must be a printable client identifier of at most 256 characters.`);
  }
  if (typeof value.clientSecretRef !== "string" || value.clientSecretRef.length > 512 ||
      !OAUTH_SECRET_REF.test(value.clientSecretRef) || /[@?#]/u.test(value.clientSecretRef)) {
    throw new Error(`${field}.clientSecretRef must be a secret:// URI bound through the local secret store.`);
  }
  if (value.scopes !== undefined) {
    if (!Array.isArray(value.scopes) || value.scopes.length > OAUTH_MAX_SCOPES ||
        value.scopes.some((scope) => typeof scope !== "string" || !OAUTH_SCOPE.test(scope)) ||
        new Set(value.scopes).size !== value.scopes.length) {
      throw new Error(`${field}.scopes must contain up to ${OAUTH_MAX_SCOPES} unique scope identifiers.`);
    }
  }
  if (value.audience !== undefined &&
      (typeof value.audience !== "string" || value.audience.length === 0 || value.audience.length > OAUTH_MAX_AUDIENCE_LENGTH)) {
    throw new Error(`${field}.audience must be a string of 1..${OAUTH_MAX_AUDIENCE_LENGTH} characters.`);
  }
  if (value.authMethod !== undefined &&
      (typeof value.authMethod !== "string" || !OAUTH_AUTH_METHODS.has(value.authMethod))) {
    throw new Error(`${field}.authMethod must be "client_secret_basic" or "client_secret_post".`);
  }
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
  if (value.aliases !== undefined) {
    if (!isPlainObject(value.aliases)) throw new Error("descriptor.mcp.aliases must be an object.");
    const entries = Object.entries(value.aliases);
    if (entries.length > UPSTREAM_MCP_ALIAS_MAX_ENTRIES) {
      throw new Error(`descriptor.mcp.aliases supports at most ${UPSTREAM_MCP_ALIAS_MAX_ENTRIES} entries.`);
    }
    for (const [upstreamName, alias] of entries) {
      if (typeof upstreamName !== "string" || upstreamName.length === 0 || upstreamName.length > UPSTREAM_MCP_ALIAS_KEY_MAX ||
          ["__proto__", "constructor", "prototype"].includes(upstreamName)) {
        throw new Error("descriptor.mcp.aliases keys must be bounded upstream tool names.");
      }
      const record = typeof alias === "string" ? { name: alias } : isPlainObject(alias) ? alias : null;
      if (!record) throw new Error("descriptor.mcp.aliases values must be a name string or an object.");
      if (record.name !== undefined && (typeof record.name !== "string" || !UPSTREAM_MCP_ALIAS_NAME.test(record.name))) {
        throw new Error("descriptor.mcp.aliases name must match [A-Za-z0-9_-] within 80 characters.");
      }
      for (const field of ["title", "description"] as const) {
        if (record[field] !== undefined &&
            (typeof record[field] !== "string" || record[field].length > UPSTREAM_MCP_ALIAS_TEXT_MAX)) {
          throw new Error(`descriptor.mcp.aliases ${field} must be a string within ${UPSTREAM_MCP_ALIAS_TEXT_MAX} characters.`);
        }
      }
    }
  }
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
  if (descriptor.contentPolicy !== undefined) {
    validateUpstreamContentPolicy(descriptor.contentPolicy, "descriptor.contentPolicy");
  }
  if (descriptor.oauth !== undefined) {
    validateUpstreamOauth(descriptor.oauth, "descriptor.oauth");
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
    if (operation.contentPolicy !== undefined) {
      validateUpstreamContentPolicy(operation.contentPolicy, `descriptor.operations[${index}].contentPolicy`);
    }
    if (operation.responseCache !== undefined) {
      validateUpstreamResponseCache(operation.responseCache, `descriptor.operations[${index}].responseCache`);
    }
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

/* ------------------------------------------------------------------ */
/* OpenAPI 3.x document -> portable upstream service import draft.     */
/* ------------------------------------------------------------------ */

const OPENAPI_IMPORT_MAX_BYTES = 4 * 1024 * 1024;
const OPENAPI_IMPORT_MAX_OPERATIONS = 256;
const OPENAPI_IMPORT_MAX_SCHEMA_BYTES = 64 * 1024;
const OPENAPI_IMPORT_MAX_REF_DEPTH = 8;
const OPENAPI_HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const OPENAPI_OPERATION_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
// Mirrors the closed JSON-schema vocabulary enforced at publish time; every
// other OpenAPI schema keyword is dropped so the draft compiles unchanged.
const OPENAPI_SCHEMA_KEYWORDS = new Set([
  "type", "enum", "const", "format", "pattern", "properties", "required",
  "additionalProperties", "items", "allOf", "anyOf", "oneOf", "not",
  "maximum", "minimum", "maxItems", "minItems", "maxLength", "minLength",
  "maxProperties", "minProperties"
]);
// Schema-valued keywords whose object value is a map of NAME -> schema; the
// names are data, not keywords, and must survive the keyword filter.
const OPENAPI_SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "dependentSchemas"]);
const OPENAPI_UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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

function openApiImportError(message: string): Error {
  return new Error(`OpenAPI import failed: ${message}`);
}

function openApiPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!isPlainObject(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveOpenApiSchema(
  schema: unknown,
  root: unknown,
  depth: number,
  stack: ReadonlySet<string>,
  unresolved?: Set<string>
): unknown {
  if (depth > OPENAPI_IMPORT_MAX_REF_DEPTH) {
    unresolved?.add("a reference exceeded the resolution depth limit");
    return true;
  }
  if (Array.isArray(schema)) {
    return schema.map((entry) => resolveOpenApiSchema(entry, root, depth + 1, stack, unresolved));
  }
  if (!isPlainObject(schema)) return schema;
  const reference = typeof schema.$ref === "string" ? schema.$ref : "";
  if (reference) {
    // External references are never fetched; recursive ones stop the loop.
    // Every unresolved case is recorded so callers can refuse to publish an
    // allow-all schema in place of the source contract.
    if (!reference.startsWith("#/")) {
      unresolved?.add(`external reference ${reference.slice(0, 120)}`);
      return true;
    }
    if (stack.has(reference)) {
      unresolved?.add(`recursive reference ${reference.slice(0, 120)}`);
      return true;
    }
    const target = openApiPointer(root, reference);
    if (target === undefined) {
      unresolved?.add(`unresolved reference ${reference.slice(0, 120)}`);
      return true;
    }
    const next = new Set<string>(stack);
    next.add(reference);
    return resolveOpenApiSchema(target, root, depth + 1, next, unresolved);
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!OPENAPI_SCHEMA_KEYWORDS.has(key)) continue;
    if (OPENAPI_SCHEMA_MAP_KEYS.has(key)) {
      if (!isPlainObject(value)) continue;
      const resolvedMap: Record<string, unknown> = {};
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        if (OPENAPI_UNSAFE_KEYS.has(propertyName)) continue;
        resolvedMap[propertyName] = resolveOpenApiSchema(propertySchema, root, depth + 1, stack, unresolved);
      }
      output[key] = resolvedMap;
      continue;
    }
    output[key] = resolveOpenApiSchema(value, root, depth + 1, stack, unresolved);
  }
  // OpenAPI 3.0 `nullable` widens a declared type to include null.
  if (schema.nullable === true) {
    if (typeof output.type === "string") output.type = [output.type, "null"];
    else if (Array.isArray(output.type) && !output.type.includes("null")) {
      output.type = [...output.type, "null"];
    }
  }
  return output;
}

function openApiServiceKey(value: unknown): string {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return slug;
}

function openApiOperationKey(operation: Record<string, unknown>, method: string, path: string, used: Set<string>): string {
  const raw = typeof operation.operationId === "string" ? operation.operationId : "";
  let key = raw.replace(/[^A-Za-z0-9_.-]/gu, "_");
  if (!key || !/^[A-Za-z]/u.test(key)) {
    const segments = path
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.replace(/^\{(.+)\}$/u, "by-$1"))
      .map((segment) => segment.replace(/[^A-Za-z0-9]+/gu, "_"))
      .filter(Boolean);
    key = `${method.toLowerCase()}_${segments.join("_") || "root"}`;
    if (!/^[A-Za-z]/u.test(key)) key = `op_${key}`;
  }
  key = key.slice(0, 128);
  if (!OPENAPI_OPERATION_KEY.test(key)) key = `op_${key.slice(0, 124)}`;
  let candidate = key;
  for (let index = 2; used.has(candidate); index += 1) {
    candidate = `${key.slice(0, 120)}_${index}`;
  }
  used.add(candidate);
  return candidate;
}

function openApiJsonMediaTypes(content: unknown): string[] {
  if (!isPlainObject(content)) return [];
  return Object.keys(content).filter((type) =>
    /^application\/json$/iu.test(type) || /^application\/[A-Za-z0-9.+*-]+\+json$/iu.test(type)
  );
}

function openApiServerBaseUrl(document: Record<string, unknown>, override: unknown): string {
  const servers = Array.isArray(document.servers) ? document.servers : [];
  const first = isPlainObject(servers[0]) ? servers[0] : {};
  let candidate = typeof override === "string" && override.trim() ? override.trim() : "";
  if (!candidate && typeof first.url === "string") {
    candidate = first.url.trim();
    const variables = isPlainObject(first.variables) ? first.variables : {};
    candidate = candidate.replace(/\{([A-Za-z][A-Za-z0-9_]{0,63})\}/gu, (match: string, name: string) => {
      const variable = isPlainObject(variables[name]) ? variables[name] : {};
      return typeof variable.default === "string" ? variable.default : match;
    });
  }
  if (!isUpstreamServiceRemoteUrl(candidate)) {
    throw openApiImportError(
      "the document's servers[0].url is not an absolute HTTP(S) URL; pass baseUrl explicitly."
    );
  }
  return candidate;
}

function openApiParameterSchema(
  parameter: Record<string, unknown>,
  root: unknown,
  unresolved?: Set<string>
): Record<string, unknown> {
  const schema = isPlainObject(parameter.schema)
    ? resolveOpenApiSchema(parameter.schema, root, 0, new Set<string>(), unresolved)
    : { type: "string" };
  return isPlainObject(schema) ? schema : { type: "string" };
}

// Object body keywords whose meaning stays identical when moved onto the
// combined caller-argument object. Anything else applies to the body object
// as a whole and cannot be folded without changing its scope.
const OPENAPI_FLAT_BODY_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);

function openApiOperationSchema(
  parameters: Array<Record<string, unknown>>,
  bodySchema: unknown,
  bodyRequired: boolean,
  root: unknown,
  warnings: string[],
  label: string,
  unresolved?: Set<string>
): Record<string, unknown> | undefined {
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  for (const parameter of parameters) {
    const name = typeof parameter.name === "string" ? parameter.name : "";
    if (!name || ["__proto__", "constructor", "prototype"].includes(name)) continue;
    properties[name] = openApiParameterSchema(parameter, root, unresolved);
    if (parameter.required === true || parameter.in === "path") required.add(name);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (isPlainObject(bodySchema)) {
    const merged = bodySchema as Record<string, unknown>;
    if (
      (merged.type === "object" || merged.type === undefined) &&
      isPlainObject(merged.properties) &&
      Object.keys(merged).every((key) => OPENAPI_FLAT_BODY_KEYS.has(key))
    ) {
      // The caller-argument object IS the request body for write operations,
      // so object body properties merge flat into the argument schema.
      for (const [name, value] of Object.entries(merged.properties as Record<string, unknown>)) {
        if (["__proto__", "constructor", "prototype"].includes(name)) continue;
        if (properties[name] === undefined) properties[name] = value;
      }
      for (const name of Array.isArray(merged.required) ? merged.required : []) {
        if (typeof name === "string") required.add(name);
      }
      if (merged.additionalProperties !== undefined) schema.additionalProperties = merged.additionalProperties;
    } else {
      // Body-level constraints (allOf/oneOf/not, property bounds, ...) keep
      // their scope only as a nested body argument; nothing is dropped.
      properties.body = merged;
      if (bodyRequired) required.add("body");
    }
  }
  if (Object.keys(properties).length === 0) return undefined;
  if (required.size > 0) schema.required = [...required];
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > OPENAPI_IMPORT_MAX_SCHEMA_BYTES) {
    warnings.push(`${label}: request schema exceeded ${OPENAPI_IMPORT_MAX_SCHEMA_BYTES} bytes and was dropped.`);
    return undefined;
  }
  return schema;
}

function openApiResponseSchema(
  operation: Record<string, unknown>,
  root: unknown,
  warnings: string[],
  label: string
): Record<string, unknown> | undefined {
  const responses = isPlainObject(operation.responses) ? operation.responses : {};
  for (const [status, response] of Object.entries(responses)) {
    if (!/^2[0-9]{2}$/u.test(status) || !isPlainObject(response)) continue;
    const mediaTypes = openApiJsonMediaTypes(response.content);
    if (mediaTypes.length === 0) continue;
    const media = isPlainObject((response.content as Record<string, unknown>)[mediaTypes[0]])
      ? (response.content as Record<string, unknown>)[mediaTypes[0]] as Record<string, unknown>
      : {};
    if (!isPlainObject(media.schema)) continue;
    const unresolved = new Set<string>();
    const schema = resolveOpenApiSchema(media.schema, root, 0, new Set<string>(), unresolved);
    if (unresolved.size > 0) {
      warnings.push(`${label}: response schema references could not be resolved (${[...unresolved].join("; ")}); the projected operation has no response contract.`);
      return undefined;
    }
    if (isPlainObject(schema) && Buffer.byteLength(JSON.stringify(schema), "utf8") <= OPENAPI_IMPORT_MAX_SCHEMA_BYTES) {
      return schema;
    }
  }
  return undefined;
}

/**
 * Converts an OpenAPI 3.x JSON document into a portable upstream service
 * import draft. The result is a descriptor draft: it validates against the
 * portable-import contract, but callers should review scope and risk
 * assignments before publishing. Non-JSON request bodies (multipart, binary)
 * are reported in `skippedOperations`, never silently approximated.
 */
export function upstreamServiceImportFromOpenApi(
  documentText: string,
  options: { serviceKey?: unknown; baseUrl?: unknown } = {}
): UpstreamServiceOpenApiImport {
  if (typeof documentText !== "string" || documentText.length === 0 ||
      Buffer.byteLength(documentText, "utf8") > OPENAPI_IMPORT_MAX_BYTES) {
    throw openApiImportError(`document must be a JSON text of at most ${OPENAPI_IMPORT_MAX_BYTES} bytes.`);
  }
  let document: unknown;
  try {
    document = JSON.parse(documentText);
  } catch {
    throw openApiImportError("document is not valid JSON (YAML documents need conversion to JSON first).");
  }
  if (!isPlainObject(document)) throw openApiImportError("document must be a JSON object.");
  const version = typeof document.openapi === "string" ? document.openapi : "";
  if (!/^3\./u.test(version)) {
    throw openApiImportError(document.swagger !== undefined
      ? "Swagger/OpenAPI 2.x documents are not supported; convert to OpenAPI 3.x first."
      : "document does not declare an OpenAPI 3.x version.");
  }
  const info = isPlainObject(document.info) ? document.info : {};
  const serviceKey = typeof options.serviceKey === "string" && options.serviceKey.trim()
    ? options.serviceKey.trim()
    : openApiServiceKey(info.title);
  if (!isUpstreamServiceKey(serviceKey)) {
    throw openApiImportError("a serviceKey could not be derived from info.title; pass serviceKey explicitly.");
  }
  const baseUrl = openApiServerBaseUrl(document, options.baseUrl);
  const paths = isPlainObject(document.paths) ? document.paths : {};
  const operations: Array<Record<string, unknown>> = [];
  const skippedOperations: OpenApiImportSkippedOperation[] = [];
  const warnings: string[] = [];
  const usedKeys = new Set<string>();
  for (const [path, pathItem] of Object.entries(paths)) {
    if (typeof path !== "string" || !path.startsWith("/") || !isPlainObject(pathItem)) continue;
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (!OPENAPI_HTTP_METHODS.has(method.toLowerCase()) || !isPlainObject(rawOperation)) continue;
      const operation = rawOperation as Record<string, unknown>;
      const label = `${method.toUpperCase()} ${path}`;
      if (operations.length >= OPENAPI_IMPORT_MAX_OPERATIONS) {
        throw openApiImportError(`document declares more than ${OPENAPI_IMPORT_MAX_OPERATIONS} operations.`);
      }
      const pathParameters = [
        ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(operation.parameters) ? operation.parameters : [])
      ].filter((parameter): parameter is Record<string, unknown> => isPlainObject(parameter));
      const requiredHeader = pathParameters.find((parameter) =>
        parameter.in === "header" && parameter.required === true);
      if (requiredHeader) {
        skippedOperations.push({ path, method, reason: "requires a header parameter" });
        continue;
      }
      const requestBody = isPlainObject(operation.requestBody) ? operation.requestBody : null;
      const requestMediaTypes = requestBody ? openApiJsonMediaTypes(requestBody.content) : [];
      if (requestBody && requestMediaTypes.length === 0) {
        skippedOperations.push({ path, method, reason: "request body has no JSON media type" });
        continue;
      }
      const bodyMedia = requestBody && requestMediaTypes.length > 0
        ? (requestBody.content as Record<string, unknown>)[requestMediaTypes[0]]
        : null;
      const requestUnresolved = new Set<string>();
      const bodySchema = isPlainObject(bodyMedia) && isPlainObject(bodyMedia.schema)
        ? resolveOpenApiSchema(bodyMedia.schema, document, 0, new Set<string>(), requestUnresolved)
        : null;
      const readOnly = ["get", "head", "options"].includes(method.toLowerCase());
      const risk = method.toLowerCase() === "delete" ? "destructive" : readOnly ? "read_only" : "safe_write";
      const requestSchema = openApiOperationSchema(
        pathParameters.filter((parameter) => parameter.in === "path" || parameter.in === "query"),
        bodySchema,
        requestBody?.required === true,
        document,
        warnings,
        label,
        requestUnresolved
      );
      if (requestUnresolved.size > 0) {
        // A request contract that cannot be resolved is never replaced by an
        // allow-all projection: the operation is skipped with its reason.
        skippedOperations.push({
          path,
          method,
          reason: `request schema references could not be resolved (${[...requestUnresolved].join("; ")})`
        });
        continue;
      }
      const responseSchema = openApiResponseSchema(operation, document, warnings, label);
      operations.push({
        operationKey: openApiOperationKey(operation, method, path, usedKeys),
        label: typeof operation.summary === "string" && operation.summary.trim()
          ? operation.summary.trim().slice(0, 160)
          : label,
        method: method.toUpperCase(),
        path,
        requiredScopes: [readOnly ? "gateway:read" : "gateway:write"],
        risk,
        ...(requestSchema ? { requestSchema } : {}),
        ...(responseSchema ? { responseSchema } : {}),
        payloadTransport: {
          request: {
            mode: "structured_json",
            maxBytes: 1024 * 1024,
            mediaTypes: requestMediaTypes.length > 0 ? requestMediaTypes : ["application/json"]
          },
          response: {
            mode: "structured_json",
            maxBytes: 8 * 1024 * 1024,
            mediaTypes: (() => {
              const mediaTypes = new Set<string>();
              const responses = isPlainObject(operation.responses) ? operation.responses : {};
              for (const response of Object.values(responses)) {
                if (isPlainObject(response)) {
                  for (const type of openApiJsonMediaTypes((response as Record<string, unknown>).content)) {
                    mediaTypes.add(type);
                  }
                }
              }
              return mediaTypes.size > 0 ? [...mediaTypes] : ["application/json"];
            })()
          }
        }
      });
    }
  }
  if (operations.length === 0) {
    throw openApiImportError("document exposes no importable HTTP operations.");
  }
  const descriptor: Record<string, unknown> = {
    serviceProtocol: "http",
    label: typeof info.title === "string" && info.title.trim() ? info.title.trim().slice(0, 160) : serviceKey,
    ...(typeof info.description === "string" && info.description.trim()
      ? { description: info.description.trim().slice(0, 2048) }
      : {}),
    baseUrl,
    operations
  };
  validatePortableDescriptor(descriptor);
  return {
    document: {
      kind: PORTABLE_UPSTREAM_SERVICE_KIND,
      schemaVersion: PORTABLE_UPSTREAM_SERVICE_SCHEMA_VERSION,
      serviceKey,
      descriptor: descriptor as PortableUpstreamServiceImport["descriptor"]
    },
    skippedOperations,
    warnings
  };
}
