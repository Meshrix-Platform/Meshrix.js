import { createHash } from "node:crypto";
import {
  isUpstreamPublishingAction,
  isUpstreamServiceKey,
  UPSTREAM_ARTIFACT_PART_FIELDS,
  UPSTREAM_MULTIPART_FIELDS,
  UPSTREAM_PAYLOAD_REQUEST_FIELDS,
  UPSTREAM_PAYLOAD_RESPONSE_FIELDS,
  UPSTREAM_PAYLOAD_TRANSPORT_FIELDS,
  UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
  UPSTREAM_SCALAR_PART_FIELDS,
  UPSTREAM_SERVICE_DESCRIPTOR_FIELDS,
  UPSTREAM_SERVICE_ENDPOINT_FIELDS,
  UPSTREAM_SERVICE_OPERATION_FIELDS
} from "@meshrix/contracts/upstream-service-publishing";
import {
  canonicalizeTypedReferenceManifest,
  SERVICE_MANIFEST_SCHEMA_VERSION
} from "@meshrix/foundation/storage/storage-ports";
import { compileClosedJsonSchema } from "@meshrix/foundation/security/closed-json-schema";
import { parseWithDuplicateRejection, rejectPollutionKeys, rejectUnsafeUnicode } from "./manifest-compiler.ts";
import { compilePayloadTransport } from "./payload-contract.ts";

export { UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION } from "@meshrix/contracts/upstream-service-publishing";

const COMMAND_FIELDS: any = new Set<any>([
  "schemaVersion",
  "action",
  "serviceKey",
  "serviceId",
  "expectedServiceRevision",
  "expectedSetRevision",
  "idempotencyKey",
  "descriptor"
]);
const DESCRIPTOR_FIELDS: any = new Set<any>(UPSTREAM_SERVICE_DESCRIPTOR_FIELDS);
const MCP_DESCRIPTOR_FIELDS: any = new Set<any>([
  "transport",
  "url",
  "endpoint",
  "baseUrl",
  "toolNamePrefix",
  "prefix",
  "protocolVersion",
  "toolsCacheTtlMs",
  "timeoutMs"
]);
const REMOTE_MCP_TRANSPORTS: any = new Set<any>(["http", "https", "remote", "streamable-http", "sse"]);
const SAFE_KEY: any = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const SAFE_IDEMPOTENCY_KEY: any = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const OPERATION_FIELDS: any = new Set<any>(UPSTREAM_SERVICE_OPERATION_FIELDS);
const ENDPOINT_FIELDS: any = new Set<any>(UPSTREAM_SERVICE_ENDPOINT_FIELDS);
const PAYLOAD_TRANSPORT_FIELDS: any = new Set<any>(UPSTREAM_PAYLOAD_TRANSPORT_FIELDS);
const PAYLOAD_REQUEST_FIELDS: any = new Set<any>(UPSTREAM_PAYLOAD_REQUEST_FIELDS);
const PAYLOAD_RESPONSE_FIELDS: any = new Set<any>(UPSTREAM_PAYLOAD_RESPONSE_FIELDS);
const MULTIPART_FIELDS: any = new Set<any>(UPSTREAM_MULTIPART_FIELDS);
const ARTIFACT_PART_FIELDS: any = new Set<any>(UPSTREAM_ARTIFACT_PART_FIELDS);
const SCALAR_PART_FIELDS: any = new Set<any>(UPSTREAM_SCALAR_PART_FIELDS);
const POLICY_FIELDS: Readonly<Record<string, any>> = Object.freeze({
  interfaceSchemas: new Set<any>(["request", "response"]),
  permissions: new Set<any>(["requiredScopes"]),
  approvalPolicy: new Set<any>(["required", "scope", "layers"]),
  trafficPolicy: new Set<any>(["perMinute", "burst", "maxConcurrent"]),
  audience: new Set<any>(["organizations", "teams", "roles", "directGrants"]),
  tagPolicy: new Set<any>([
    "entityRefs", "denyTags", "allowTags", "requiredTags", "policyRevision",
    "failOnStale", "requireFreshRevision"
  ]),
  circuitBreaker: new Set<any>(["enabled", "failureThreshold", "cooldownMs"]),
  requiredApproval: new Set<any>(["required", "approvalScope", "approvalLayers"])
});
const EXECUTABLE_KEYS: any = new Set<any>([
  "command", "args", "argv", "env", "environment", "headers", "defaultHeaders", "template",
  "expression", "regex", "script", "executable", "cwd", "workingDirectory", "filePath", "filesystemPath"
]);
const HTTP_METHODS: any = new Set<any>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const REQUIRED_SCOPE: Readonly<Record<string, any>> = Object.freeze({
  create: "gateway:write",
  replace: "gateway:maintain",
  disable: "gateway:maintain",
  remove: "gateway:maintain",
  republish: "gateway:maintain"
});

function publishingError(code?: any, statusCode?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function digest(namespace: any, ...values: any[]) : any {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(values.join("\0"))
    .digest("hex");
}

function opaqueServiceId(ownerSubjectId?: any, serviceKey?: any) : any {
  const identity: any = createHash("sha256")
    .update("upstream-service")
    .update("\0")
    .update(ownerSubjectId)
    .update("\0")
    .update(serviceKey)
    .digest("base64url");
  return `svc_${identity}`;
}

function assertPlainObject(value?: any, message?: any) : any {
  const prototype: any = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  if (!value || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    throw publishingError("upstream_publishing_schema_invalid", 400, message);
  }
  return value;
}

function assertClosedFields(value?: any, fields?: any, label?: any) : any {
  const unknown: any = Object.keys(value).filter((key?: any) : any => !fields.has(key)).sort();
  if (unknown.length > 0) {
    throw publishingError(
      "upstream_publishing_schema_invalid",
      400,
      `${label} contains an unsupported field.`
    );
  }
}

function validateJsonSchema(value?: any, label?: any, { requireTopLevelObject = false }: Record<string, any> = {}) : any {
  try {
    return compileClosedJsonSchema(value, {
      label,
      requireTopLevelObject
    });
  } catch {
    throw publishingError(
      "upstream_publishing_schema_invalid",
      400,
      "Publishing descriptor contains an invalid JSON schema."
    );
  }
}

function validateClosedPolicy(value?: any, fields?: any, label?: any) : any {
  if (value === undefined) return;
  const policy: any = assertPlainObject(value, `${label} must be an object.`);
  assertClosedFields(policy, fields, label);
}

function validatePayloadTransport(operation?: any, serviceProtocol?: any) : any {
  const transport: any = assertPlainObject(
    operation.payloadTransport,
    "descriptor.operations.payloadTransport must be an object."
  );
  assertClosedFields(transport, PAYLOAD_TRANSPORT_FIELDS, "descriptor.operations.payloadTransport");
  const request: any = assertPlainObject(
    transport.request,
    "descriptor.operations.payloadTransport.request must be an object."
  );
  const response: any = assertPlainObject(
    transport.response,
    "descriptor.operations.payloadTransport.response must be an object."
  );
  assertClosedFields(request, PAYLOAD_REQUEST_FIELDS, "descriptor.operations.payloadTransport.request");
  assertClosedFields(response, PAYLOAD_RESPONSE_FIELDS, "descriptor.operations.payloadTransport.response");
  if (request.multipart !== undefined) {
    const multipart: any = assertPlainObject(request.multipart, "payloadTransport.request.multipart must be an object.");
    assertClosedFields(multipart, MULTIPART_FIELDS, "payloadTransport.request.multipart");
    if (!Array.isArray(multipart.artifactParts)) {
      throw publishingError("upstream_publishing_descriptor_invalid", 400, "payloadTransport.request.multipart.artifactParts must be an array.");
    }
    multipart.artifactParts.forEach((entry?: any) : any => {
      assertClosedFields(
        assertPlainObject(entry, "Multipart artifact part must be an object."),
        ARTIFACT_PART_FIELDS,
        "payloadTransport.request.multipart.artifactParts"
      );
    });
    if (multipart.scalarFields !== undefined) {
      if (!Array.isArray(multipart.scalarFields)) {
        throw publishingError("upstream_publishing_descriptor_invalid", 400, "payloadTransport.request.multipart.scalarFields must be an array.");
      }
      multipart.scalarFields.forEach((entry?: any) : any => {
        assertClosedFields(
          assertPlainObject(entry, "Multipart scalar field must be an object."),
          SCALAR_PART_FIELDS,
          "payloadTransport.request.multipart.scalarFields"
        );
      });
    }
  }
  let compiled: any;
  try {
    compiled = compilePayloadTransport(operation);
  } catch (error: any) {
    throw publishingError(
      String(error?.code || "upstream_publishing_descriptor_invalid"),
      Number(error?.status || 400),
      error instanceof Error ? error.message : "Payload transport is invalid."
    );
  }
  if (
    serviceProtocol === "json-rpc" &&
    (compiled.request.mode !== "structured_json" || compiled.response.mode !== "structured_json")
  ) {
    throw publishingError(
      "payload_policy_conflict",
      400,
      "JSON-RPC operations require structured_json request and response representations."
    );
  }
}

function validateDescriptorPolicies(descriptor?: any) : any {
  for (const [field, fields] of (Object.entries(POLICY_FIELDS) as [string, any][])) {
    validateClosedPolicy(descriptor[field], fields, `descriptor.${field}`);
  }
  if (descriptor.interfaceSchemas !== undefined) {
    for (const [name, schema] of (Object.entries(descriptor.interfaceSchemas) as [string, any][])) {
      validateJsonSchema(schema, `descriptor.interfaceSchemas.${name}`, {
        requireTopLevelObject: name === "request"
      });
    }
  }
}

function authenticate(subject?: any) : any {
  const subjectId: any = typeof subject?.subjectId === "string" ? subject.subjectId.trim() : "";
  if (!subjectId) {
    throw publishingError("upstream_publishing_authentication_required", 401, "Authentication required.");
  }
  rejectUnsafeUnicode(subjectId);
  return {
    subjectId,
    scopes: new Set<any>(Array.isArray(subject.scopes) ? subject.scopes.filter((scope?: any) : any => typeof scope === "string") : [])
  };
}

function authorize(subject?: any, action?: any) : any {
  if (subject.scopes.has("gateway:admin") || subject.scopes.has(REQUIRED_SCOPE[action])) return;
  throw publishingError(
    "upstream_publishing_scope_required",
    403,
    `Scope "${REQUIRED_SCOPE[action]}" is required.`
  );
}

function authorizeRead(subject?: any) : any {
  if (subject.scopes.has("gateway:admin") || subject.scopes.has("gateway:read")) return;
  throw publishingError("upstream_publishing_scope_required", 403, "Scope \"gateway:read\" is required.");
}

function parseCommand(rawCommand?: any) : any {
  let command: any;
  try {
    command = parseWithDuplicateRejection(rawCommand);
  } catch (error: any) {
    throw publishingError("upstream_publishing_command_invalid", 400, error.message);
  }
  assertPlainObject(command, "Publishing command must be an object.");
  rejectPollutionKeys(command);
  assertClosedFields(command, COMMAND_FIELDS, "Publishing command");
  if (command.schemaVersion !== UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION) {
    throw publishingError("upstream_publishing_schema_invalid", 400, "Publishing command schemaVersion is unsupported.");
  }
  if (!isUpstreamPublishingAction(command.action)) {
    throw publishingError("upstream_publishing_action_invalid", 400, "Publishing action is unsupported.");
  }
  if (!Number.isSafeInteger(command.expectedServiceRevision) || command.expectedServiceRevision < 0 ||
      !Number.isSafeInteger(command.expectedSetRevision) || command.expectedSetRevision < 0) {
    throw publishingError("upstream_publishing_revision_invalid", 400, "Expected revisions must be non-negative safe integers.");
  }
  if (typeof command.idempotencyKey !== "string" || !SAFE_IDEMPOTENCY_KEY.test(command.idempotencyKey)) {
    throw publishingError("upstream_publishing_idempotency_invalid", 400, "Publishing idempotencyKey is invalid.");
  }
  return command;
}

function commandServiceId(command?: any, ownerSubjectId?: any) : any {
  if (command.action === "create") {
    if (!isUpstreamServiceKey(command.serviceKey)) {
      throw publishingError("upstream_publishing_service_key_invalid", 400, "Create requires a canonical serviceKey.");
    }
    if (command.serviceId !== undefined) {
      throw publishingError("upstream_publishing_schema_invalid", 400, "Create cannot supply a serviceId.");
    }
    return opaqueServiceId(ownerSubjectId, command.serviceKey);
  }
  if (command.serviceKey !== undefined || typeof command.serviceId !== "string" || !command.serviceId.startsWith("svc_")) {
    throw publishingError("upstream_publishing_service_id_invalid", 400, "Publishing mutation requires a server serviceId.");
  }
  return command.serviceId;
}

function descriptorFromCommand(command?: any, existing?: any) : any {
  const requiresDescriptor: any = command.action === "create" || command.action === "replace";
  if (requiresDescriptor && command.descriptor === undefined) {
    throw publishingError("upstream_publishing_descriptor_required", 400, `${command.action} requires a descriptor.`);
  }
  if (command.descriptor !== undefined) {
    const descriptor: any = assertPlainObject(command.descriptor, "Publishing descriptor must be an object.");
    assertClosedFields(descriptor, DESCRIPTOR_FIELDS, "Publishing descriptor");
    if (!Object.hasOwn(descriptor, "serviceProtocol") || !["http", "json-rpc", "mcp"].includes(descriptor.serviceProtocol)) {
      throw publishingError(
        "upstream_publishing_protocol_invalid",
        400,
        "Publishing descriptor requires an explicit HTTP, JSON-RPC, or MCP serviceProtocol."
      );
    }
    validateDescriptorSafety(descriptor);
    return descriptor;
  }
  const priorDescriptor: any = existing?.manifest?.payload?.descriptor;
  if (!priorDescriptor || command.action === "republish" && existing.manifest.payload.state === "removed") {
    throw publishingError("upstream_publishing_descriptor_required", 400, "Republish requires a descriptor after removal.");
  }
  return priorDescriptor;
}

function validateRemoteUrl(value?: any, field?: any) : any {
  if (typeof value !== "string" || !value) {
    throw publishingError("upstream_publishing_descriptor_invalid", 400, `${field} must be a remote URL.`);
  }
  let parsed: any;
  try {
    parsed = new URL(value);
  } catch {
    throw publishingError("upstream_publishing_descriptor_invalid", 400, `${field} must be a remote URL.`);
  }
  const hasExplicitPort: any = /^https?:\/\/(?:\[[^\]]+\]|[^/:?#]+):[0-9]{1,5}(?:[/?#]|$)/u.test(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !hasExplicitPort) {
    throw publishingError("upstream_publishing_descriptor_invalid", 400, `${field} must use an HTTP transport with an explicit port and no embedded credentials.`);
  }
}

function rejectExecutableContent(value?: any, path: any = "descriptor") : any {
  if (typeof value === "string") {
    rejectUnsafeUnicode(value);
    if (/\$\{|\{\{|<%|\bfile:\/\//u.test(value)) {
      throw publishingError("upstream_publishing_executable_input", 400, `${path} contains executable or local-file syntax.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index: any = 0; index < value.length; index += 1) rejectExecutableContent(value[index], `${path}[${index}]`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of (Object.entries(value) as [string, any][])) {
    rejectUnsafeUnicode(key);
    if (EXECUTABLE_KEYS.has(key)) {
      throw publishingError("upstream_publishing_executable_input", 400, `${path} contains unsupported executable field "${key}".`);
    }
    rejectExecutableContent(child, `${path}.${key}`);
  }
}

function validateRemoteMcpDescriptor(descriptor?: any) : any {
  const mcp: any = assertPlainObject(descriptor.mcp, "Publishing MCP descriptor must be an object.");
  assertClosedFields(mcp, MCP_DESCRIPTOR_FIELDS, "Publishing MCP descriptor");
  const transport: any = String(mcp.transport || "http").trim().toLowerCase();
  if (!REMOTE_MCP_TRANSPORTS.has(transport) || transport === "stdio") {
    throw publishingError(
      "upstream_publishing_mcp_transport_invalid",
      400,
      "Developer-published MCP services require a remote HTTP transport."
    );
  }
  const remoteUrl: any = mcp.url || mcp.endpoint || mcp.baseUrl || descriptor.baseUrl;
  validateRemoteUrl(remoteUrl, "descriptor.mcp.url");
  if (descriptor.operations !== undefined) {
    throw publishingError(
      "upstream_publishing_descriptor_invalid",
      400,
      "Developer-published MCP services derive tools/call from the remote catalog and do not accept operations arrays."
    );
  }
}

function validateDescriptorSafety(descriptor?: any) : any {
  rejectExecutableContent(descriptor);
  validateDescriptorPolicies(descriptor);
  if (descriptor.allowLocalNetwork !== undefined && typeof descriptor.allowLocalNetwork !== "boolean") {
    throw publishingError("upstream_publishing_descriptor_invalid", 400, "descriptor.allowLocalNetwork must be boolean.");
  }
  if (descriptor.serviceProtocol === "mcp") {
    validateRemoteMcpDescriptor(descriptor);
    return;
  }
  if (!Array.isArray(descriptor.operations) || descriptor.operations.length === 0) {
    throw publishingError(
      "upstream_publishing_descriptor_invalid",
      400,
      "Publishing descriptor requires at least one explicit operation."
    );
  }
  if (descriptor.baseUrl === undefined && (!Array.isArray(descriptor.endpoints) || descriptor.endpoints.length === 0)) {
    throw publishingError("upstream_publishing_descriptor_invalid", 400, "Publishing descriptor requires an explicit remote endpoint.");
  }
  if (descriptor.baseUrl !== undefined) validateRemoteUrl(descriptor.baseUrl, "descriptor.baseUrl");
  if (descriptor.endpoints !== undefined) {
    if (!Array.isArray(descriptor.endpoints)) {
      throw publishingError("upstream_publishing_descriptor_invalid", 400, "descriptor.endpoints must be an array.");
    }
    for (const endpoint of descriptor.endpoints) {
      assertPlainObject(endpoint, "Publishing endpoint must be an object.");
      assertClosedFields(endpoint, ENDPOINT_FIELDS, "Publishing endpoint");
      validateRemoteUrl(endpoint.baseUrl, "descriptor.endpoints.baseUrl");
      validateClosedPolicy(endpoint.trafficPolicy, POLICY_FIELDS.trafficPolicy, "descriptor.endpoints.trafficPolicy");
      validateClosedPolicy(endpoint.circuitBreaker, POLICY_FIELDS.circuitBreaker, "descriptor.endpoints.circuitBreaker");
    }
  }
  if (descriptor.operations !== undefined) {
    if (!Array.isArray(descriptor.operations)) {
      throw publishingError("upstream_publishing_descriptor_invalid", 400, "descriptor.operations must be an array.");
    }
    for (const operation of descriptor.operations) {
      assertPlainObject(operation, "Publishing operation must be an object.");
      assertClosedFields(operation, OPERATION_FIELDS, "Publishing operation");
      if (typeof operation.operationKey !== "string" || !SAFE_KEY.test(operation.operationKey)) {
        throw publishingError("upstream_publishing_descriptor_invalid", 400, "Publishing operationKey is invalid.");
      }
      let decodedPath: any = "";
      try {
        decodedPath = decodeURIComponent(operation.path);
      } catch {
        decodedPath = "";
      }
      const pathSegments: any = decodedPath.split("/");
      if (typeof operation.path !== "string" || !operation.path.startsWith("/") || operation.path.startsWith("//") ||
          operation.path.includes("\\") || operation.path.includes("?") || operation.path.includes("#") ||
          /%2f|%5c/iu.test(operation.path) || !decodedPath || pathSegments.some((segment?: any) : any => segment === "." || segment === "..")) {
        throw publishingError("upstream_publishing_descriptor_invalid", 400, "Publishing operation path is invalid.");
      }
      if (typeof operation.method !== "string" || !HTTP_METHODS.has(operation.method) || operation.method !== operation.method.toUpperCase()) {
        throw publishingError("upstream_publishing_descriptor_invalid", 400, "Publishing operation method is invalid.");
      }
      if (descriptor.serviceProtocol === "json-rpc") {
        if (operation.method !== "POST" || typeof operation.jsonRpcMethod !== "string" || !SAFE_KEY.test(operation.jsonRpcMethod) ||
            (operation.protocol !== undefined && operation.protocol !== "json-rpc")) {
          throw publishingError("upstream_publishing_descriptor_invalid", 400, "JSON-RPC operations require a canonical jsonRpcMethod and POST transport.");
        }
      } else if (operation.jsonRpcMethod !== undefined || (operation.protocol !== undefined && operation.protocol !== "http")) {
        throw publishingError("upstream_publishing_descriptor_invalid", 400, "HTTP operations cannot declare JSON-RPC routing fields.");
      }
      validateClosedPolicy(operation.requiredApproval, POLICY_FIELDS.requiredApproval, "descriptor.operations.requiredApproval");
      validatePayloadTransport(operation, descriptor.serviceProtocol);
      if (operation.requestSchema !== undefined) {
        validateJsonSchema(operation.requestSchema, "descriptor.operations.requestSchema", {
          requireTopLevelObject: true
        });
      }
      if (operation.responseSchema !== undefined) validateJsonSchema(operation.responseSchema, "descriptor.operations.responseSchema");
    }
  }
}

function existingOwnership(existing?: any, ownerRef?: any) : any {
  if (!existing) return;
  if (existing.manifest?.metadata?.ownerRef !== ownerRef) {
    throw publishingError("upstream_publishing_owner_required", 403, "Service ownership is required.");
  }
}

function nextManifest({ command, descriptor, existing, ownerRef, serviceKeyRef }: Record<string, any>) : any {
  const state: any = command.action === "disable"
    ? "disabled"
    : command.action === "remove"
      ? "removed"
      : "publishing";
  const references: any = state === "removed"
    ? []
    : descriptor.references === undefined
      ? existing?.manifest?.references || []
      : descriptor.references;
  const projectedDescriptor: any = state === "removed"
    ? null
    : Object.fromEntries((Object.entries(descriptor) as [string, any][]).filter(([key]: any[]) : any => key !== "references"));
  return {
    schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
    references,
    payload: {
      state,
      ...(projectedDescriptor ? { descriptor: projectedDescriptor } : {})
    },
    metadata: {
      ownerRef,
      serviceKeyRef,
      action: command.action
    }
  };
}

function mapStorageError(error?: any) : any {
  const statusCode: any = error?.code === "storage_manifest_replay_conflict" ||
      error?.code === "storage_manifest_service_revision_stale" ||
      error?.code === "storage_manifest_set_revision_stale"
    ? 409
    : error?.statusCode;
  if (statusCode) error.statusCode = statusCode;
  return error;
}

export function createUpstreamPublishingApplication({
  writerPort,
  readerPort,
  publishedReaderPort = null,
  getPublicationFacts = () : any => null,
  auditPort
}: Record<string, any>) : any {
  if (typeof writerPort?.commitManifestSet !== "function" || typeof readerPort?.getSnapshot !== "function") {
    throw new TypeError("Upstream publishing application requires durable writer and snapshot reader ports.");
  }
  if (typeof auditPort?.append !== "function") {
    throw new TypeError("Upstream publishing application requires an audit append port.");
  }

  function readSubject(subject?: any) : any {
    const authenticated: any = authenticate(subject);
    authorizeRead(authenticated);
    return {
      ...authenticated,
      ownerRef: `urn:meshrix:subject:${digest("upstream-owner", authenticated.subjectId)}`
    };
  }

  function canReadRecord(authenticated?: any, record?: any) : any {
    return authenticated.scopes.has("gateway:admin") || record.manifest?.metadata?.ownerRef === authenticated.ownerRef;
  }

  function publicationFor(record?: any, candidateSnapshot?: any, publishedSnapshot?: any) : any {
    const publicationRef: any = `urn:meshrix:upstream-publication:${digest(
      "upstream-publication",
      record.serviceId,
      record.serviceRevision,
      record.manifestDigest
    )}`;
    const publishedRecord: any = publishedSnapshot?.getService?.(record.serviceId) || null;
    const facts: any = getPublicationFacts?.() || null;
    const serverPublished: any = Boolean(
      publishedRecord?.serviceRevision === record.serviceRevision &&
      publishedRecord?.manifestDigest === record.manifestDigest &&
      facts?.ready === true &&
      facts.sourceRevision === publishedSnapshot.setRevision &&
      facts.sourceDigest === publishedSnapshot.setDigest
    );
    return Object.freeze({
      publicationRef,
      status: serverPublished ? "server_published" : "publishing",
      candidateRevision: candidateSnapshot.setRevision,
      candidateDigest: candidateSnapshot.setDigest,
      ...(serverPublished ? {
        terminal: Object.freeze({
          sourceRevision: facts.sourceRevision,
          sourceDigest: facts.sourceDigest,
          catalogRevision: facts.catalogRevision,
          audienceRevision: facts.audienceRevision,
          protocolRevision: facts.protocolRevision
        })
      } : {})
    });
  }

  return Object.freeze({
    async list(subject?: any, { signal }: Record<string, any> = {}) : Promise<any> {
      const authenticated: any = readSubject(subject);
      const snapshot: any = await readerPort.getSnapshot({ signal });
      const publishedSnapshot: any = typeof publishedReaderPort?.getSnapshot === "function"
        ? await publishedReaderPort.getSnapshot({ signal })
        : null;
      const services: any = snapshot.listServices()
        .filter((record?: any) : any => canReadRecord(authenticated, record))
        .map((record?: any) : any => Object.freeze({
          serviceId: record.serviceId,
          state: record.manifest.payload.state,
          serviceRevision: record.serviceRevision,
          manifestDigest: record.manifestDigest,
          publication: publicationFor(record, snapshot, publishedSnapshot)
        }));
      return Object.freeze({ ok: true, setRevision: snapshot.setRevision, services: Object.freeze(services) });
    },
    async get(serviceId?: any, subject?: any, { signal }: Record<string, any> = {}) : Promise<any> {
      const authenticated: any = readSubject(subject);
      const snapshot: any = await readerPort.getSnapshot({ signal });
      const publishedSnapshot: any = typeof publishedReaderPort?.getSnapshot === "function"
        ? await publishedReaderPort.getSnapshot({ signal })
        : null;
      const record: any = snapshot.getService(serviceId);
      if (!record) {
        throw publishingError("upstream_publishing_service_not_found", 404, "Service was not found.");
      }
      if (!canReadRecord(authenticated, record)) {
        throw publishingError("upstream_publishing_owner_required", 403, "Service ownership is required.");
      }
      return Object.freeze({
        ok: true,
        setRevision: snapshot.setRevision,
        service: Object.freeze({
          serviceId: record.serviceId,
          state: record.manifest.payload.state,
          serviceRevision: record.serviceRevision,
          manifestDigest: record.manifestDigest,
          publication: publicationFor(record, snapshot, publishedSnapshot),
          descriptor: record.manifest.payload.descriptor || null,
          references: record.manifest.references
        })
      });
    },
    async execute(rawCommand?: any, subject?: any, { signal, expectedAction = "", expectedServiceId = "" }: Record<string, any> = {}) : Promise<any> {
      const authenticated: any = authenticate(subject);
      const command: any = parseCommand(rawCommand);
      if (expectedAction && command.action !== expectedAction) {
        throw publishingError("upstream_publishing_action_mismatch", 400, "Publishing action does not match the selected operation.");
      }
      if (expectedServiceId && command.serviceId !== expectedServiceId) {
        throw publishingError("upstream_publishing_service_id_mismatch", 400, "Publishing serviceId does not match the route.");
      }
      authorize(authenticated, command.action);
      const serviceId: any = commandServiceId(command, authenticated.subjectId);
      const ownerRef: any = `urn:meshrix:subject:${digest("upstream-owner", authenticated.subjectId)}`;
      const snapshot: any = await readerPort.getSnapshot({ signal });
      const existing: any = snapshot.getService(serviceId);

      if (command.action !== "create" && !existing) {
        throw publishingError("upstream_publishing_service_not_found", 404, "Service was not found.");
      }
      existingOwnership(existing, ownerRef);
      const descriptor: any = descriptorFromCommand(command, existing);
      const serviceKeyRef: any = existing?.manifest?.metadata?.serviceKeyRef ||
        `urn:meshrix:service-key:${digest("upstream-service-key", command.serviceKey)}`;
      const manifest: any = canonicalizeTypedReferenceManifest(
        nextManifest({ command, descriptor, existing, ownerRef, serviceKeyRef })
      ).manifest;
      const requestDigest: any = digest("upstream-publishing-request", authenticated.subjectId, command.idempotencyKey);

      await auditPort.append(Object.freeze({
        event: "upstream.publishing.request.accepted",
        action: command.action,
        ownerRef,
        serviceRef: `urn:meshrix:service:${digest("upstream-service-ref", serviceId)}`,
        requestRef: `urn:meshrix:request:${requestDigest}`
      }));

      let outcome: any;
      try {
        outcome = await writerPort.commitManifestSet({
          serviceId,
          expectedServiceRevision: command.expectedServiceRevision,
          expectedSetRevision: command.expectedSetRevision,
          manifest,
          requestDigest,
          signal
        });
      } catch (error: any) {
        throw mapStorageError(error);
      }
      return Object.freeze({
        ok: true,
        serviceId,
        state: manifest.payload.state,
        serviceRevision: outcome.serviceRevision,
        setRevision: outcome.setRevision,
        manifestDigest: outcome.manifestDigest,
        receiptRef: outcome.receiptRef,
        publication: Object.freeze({
          publicationRef: `urn:meshrix:upstream-publication:${digest(
            "upstream-publication",
            serviceId,
            outcome.serviceRevision,
            outcome.manifestDigest
          )}`,
          status: "publishing",
          candidateRevision: outcome.setRevision,
          candidateDigest: outcome.setDigest
        }),
        replayed: outcome.replayed
      });
    }
  });
}
