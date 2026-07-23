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
} from "@lico/contracts/upstream-service-publishing";
import {
  canonicalizeTypedReferenceManifest,
  SERVICE_MANIFEST_SCHEMA_VERSION
} from "@lico/foundation/storage/storage-ports";
import { parseWithDuplicateRejection, rejectPollutionKeys, rejectUnsafeUnicode } from "./manifest-compiler.mjs";
import { compilePayloadTransport } from "./payload-contract.mjs";

export { UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION } from "@lico/contracts/upstream-service-publishing";

const COMMAND_FIELDS = new Set([
  "schemaVersion",
  "action",
  "serviceKey",
  "serviceId",
  "expectedServiceRevision",
  "expectedSetRevision",
  "idempotencyKey",
  "descriptor"
]);
const DESCRIPTOR_FIELDS = new Set(UPSTREAM_SERVICE_DESCRIPTOR_FIELDS);
const MCP_DESCRIPTOR_FIELDS = new Set([
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
const REMOTE_MCP_TRANSPORTS = new Set(["http", "https", "remote", "streamable-http", "sse"]);
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const OPERATION_FIELDS = new Set(UPSTREAM_SERVICE_OPERATION_FIELDS);
const ENDPOINT_FIELDS = new Set(UPSTREAM_SERVICE_ENDPOINT_FIELDS);
const PAYLOAD_TRANSPORT_FIELDS = new Set(UPSTREAM_PAYLOAD_TRANSPORT_FIELDS);
const PAYLOAD_REQUEST_FIELDS = new Set(UPSTREAM_PAYLOAD_REQUEST_FIELDS);
const PAYLOAD_RESPONSE_FIELDS = new Set(UPSTREAM_PAYLOAD_RESPONSE_FIELDS);
const MULTIPART_FIELDS = new Set(UPSTREAM_MULTIPART_FIELDS);
const ARTIFACT_PART_FIELDS = new Set(UPSTREAM_ARTIFACT_PART_FIELDS);
const SCALAR_PART_FIELDS = new Set(UPSTREAM_SCALAR_PART_FIELDS);
const POLICY_FIELDS = Object.freeze({
  interfaceSchemas: new Set(["request", "response"]),
  permissions: new Set(["requiredScopes"]),
  approvalPolicy: new Set(["required", "scope", "layers"]),
  trafficPolicy: new Set(["perMinute", "burst", "maxConcurrent"]),
  audience: new Set(["organizations", "teams", "roles", "directGrants"]),
  tagPolicy: new Set([
    "entityRefs", "denyTags", "allowTags", "requiredTags", "policyRevision",
    "failOnStale", "requireFreshRevision"
  ]),
  circuitBreaker: new Set(["enabled", "failureThreshold", "cooldownMs"]),
  requiredApproval: new Set(["required", "approvalScope", "approvalLayers"])
});
const JSON_SCHEMA_FIELDS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const",
  "format", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"
]);
const EXECUTABLE_KEYS = new Set([
  "command", "args", "argv", "env", "environment", "headers", "defaultHeaders", "template",
  "expression", "regex", "script", "executable", "cwd", "workingDirectory", "filePath", "filesystemPath"
]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const REQUIRED_SCOPE = Object.freeze({
  create: "gateway:write",
  replace: "gateway:maintain",
  disable: "gateway:maintain",
  remove: "gateway:maintain",
  republish: "gateway:maintain"
});

function publishingError(code, statusCode, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function digest(namespace, ...values) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(values.join("\0"))
    .digest("hex");
}

function opaqueServiceId(ownerSubjectId, serviceKey) {
  const identity = createHash("sha256")
    .update("upstream-service")
    .update("\0")
    .update(ownerSubjectId)
    .update("\0")
    .update(serviceKey)
    .digest("base64url");
  return `svc_${identity}`;
}

function assertPlainObject(value, message) {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  if (!value || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    throw publishingError("upstream_publishing_schema_invalid", 400, message);
  }
  return value;
}

function assertClosedFields(value, fields, label) {
  const unknown = Object.keys(value).filter((key) => !fields.has(key)).sort();
  if (unknown.length > 0) {
    throw publishingError(
      "upstream_publishing_schema_invalid",
      400,
      `${label} contains an unsupported field.`
    );
  }
}

function validateJsonSchema(value, label, depth = 0) {
  if (depth > 8) throw publishingError("upstream_publishing_schema_invalid", 400, `${label} nesting is unsupported.`);
  const schema = assertPlainObject(value, `${label} must be an object.`);
  assertClosedFields(schema, JSON_SCHEMA_FIELDS, label);
  if (schema.properties !== undefined) {
    const properties = assertPlainObject(schema.properties, `${label}.properties must be an object.`);
    if (Object.keys(properties).length > 128) {
      throw publishingError("upstream_publishing_schema_invalid", 400, `${label}.properties exceeds its cardinality limit.`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!SAFE_KEY.test(key)) throw publishingError("upstream_publishing_schema_invalid", 400, `${label}.properties contains an invalid key.`);
      validateJsonSchema(child, `${label}.properties.${key}`, depth + 1);
    }
  }
  if (schema.items !== undefined) validateJsonSchema(schema.items, `${label}.items`, depth + 1);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    throw publishingError("upstream_publishing_schema_invalid", 400, `${label}.additionalProperties must be boolean.`);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => !SAFE_KEY.test(String(key))))) {
    throw publishingError("upstream_publishing_schema_invalid", 400, `${label}.required is invalid.`);
  }
}

function validateClosedPolicy(value, fields, label) {
  if (value === undefined) return;
  const policy = assertPlainObject(value, `${label} must be an object.`);
  assertClosedFields(policy, fields, label);
}

function validatePayloadTransport(operation, serviceProtocol) {
  const transport = assertPlainObject(
    operation.payloadTransport,
    "descriptor.operations.payloadTransport must be an object."
  );
  assertClosedFields(transport, PAYLOAD_TRANSPORT_FIELDS, "descriptor.operations.payloadTransport");
  const request = assertPlainObject(
    transport.request,
    "descriptor.operations.payloadTransport.request must be an object."
  );
  const response = assertPlainObject(
    transport.response,
    "descriptor.operations.payloadTransport.response must be an object."
  );
  assertClosedFields(request, PAYLOAD_REQUEST_FIELDS, "descriptor.operations.payloadTransport.request");
  assertClosedFields(response, PAYLOAD_RESPONSE_FIELDS, "descriptor.operations.payloadTransport.response");
  if (request.multipart !== undefined) {
    const multipart = assertPlainObject(request.multipart, "payloadTransport.request.multipart must be an object.");
    assertClosedFields(multipart, MULTIPART_FIELDS, "payloadTransport.request.multipart");
    if (!Array.isArray(multipart.artifactParts)) {
      throw publishingError("upstream_publishing_descriptor_invalid", 400, "payloadTransport.request.multipart.artifactParts must be an array.");
    }
    multipart.artifactParts.forEach((entry) => {
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
      multipart.scalarFields.forEach((entry) => {
        assertClosedFields(
          assertPlainObject(entry, "Multipart scalar field must be an object."),
          SCALAR_PART_FIELDS,
          "payloadTransport.request.multipart.scalarFields"
        );
      });
    }
  }
  let compiled;
  try {
    compiled = compilePayloadTransport(operation);
  } catch (error) {
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

function validateDescriptorPolicies(descriptor) {
  for (const [field, fields] of Object.entries(POLICY_FIELDS)) {
    validateClosedPolicy(descriptor[field], fields, `descriptor.${field}`);
  }
  if (descriptor.interfaceSchemas !== undefined) {
    for (const [name, schema] of Object.entries(descriptor.interfaceSchemas)) {
      validateJsonSchema(schema, `descriptor.interfaceSchemas.${name}`);
    }
  }
}

function authenticate(subject) {
  const subjectId = typeof subject?.subjectId === "string" ? subject.subjectId.trim() : "";
  if (!subjectId) {
    throw publishingError("upstream_publishing_authentication_required", 401, "Authentication required.");
  }
  rejectUnsafeUnicode(subjectId);
  return {
    subjectId,
    scopes: new Set(Array.isArray(subject.scopes) ? subject.scopes.filter((scope) => typeof scope === "string") : [])
  };
}

function authorize(subject, action) {
  if (subject.scopes.has("gateway:admin") || subject.scopes.has(REQUIRED_SCOPE[action])) return;
  throw publishingError(
    "upstream_publishing_scope_required",
    403,
    `Scope "${REQUIRED_SCOPE[action]}" is required.`
  );
}

function authorizeRead(subject) {
  if (subject.scopes.has("gateway:admin") || subject.scopes.has("gateway:read")) return;
  throw publishingError("upstream_publishing_scope_required", 403, "Scope \"gateway:read\" is required.");
}

function parseCommand(rawCommand) {
  let command;
  try {
    command = parseWithDuplicateRejection(rawCommand);
  } catch (error) {
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

function commandServiceId(command, ownerSubjectId) {
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

function descriptorFromCommand(command, existing) {
  const requiresDescriptor = command.action === "create" || command.action === "replace";
  if (requiresDescriptor && command.descriptor === undefined) {
    throw publishingError("upstream_publishing_descriptor_required", 400, `${command.action} requires a descriptor.`);
  }
  if (command.descriptor !== undefined) {
    const descriptor = assertPlainObject(command.descriptor, "Publishing descriptor must be an object.");
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
  const priorDescriptor = existing?.manifest?.payload?.descriptor;
  if (!priorDescriptor || command.action === "republish" && existing.manifest.payload.state === "removed") {
    throw publishingError("upstream_publishing_descriptor_required", 400, "Republish requires a descriptor after removal.");
  }
  return priorDescriptor;
}

function validateRemoteUrl(value, field) {
  if (typeof value !== "string" || !value) {
    throw publishingError("upstream_publishing_descriptor_invalid", 400, `${field} must be a remote URL.`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw publishingError("upstream_publishing_descriptor_invalid", 400, `${field} must be a remote URL.`);
  }
  const hasExplicitPort = /^https?:\/\/(?:\[[^\]]+\]|[^/:?#]+):[0-9]{1,5}(?:[/?#]|$)/u.test(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !hasExplicitPort) {
    throw publishingError("upstream_publishing_descriptor_invalid", 400, `${field} must use an HTTP transport with an explicit port and no embedded credentials.`);
  }
}

function rejectExecutableContent(value, path = "descriptor") {
  if (typeof value === "string") {
    rejectUnsafeUnicode(value);
    if (/\$\{|\{\{|<%|\bfile:\/\//u.test(value)) {
      throw publishingError("upstream_publishing_executable_input", 400, `${path} contains executable or local-file syntax.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) rejectExecutableContent(value[index], `${path}[${index}]`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    rejectUnsafeUnicode(key);
    if (EXECUTABLE_KEYS.has(key)) {
      throw publishingError("upstream_publishing_executable_input", 400, `${path} contains unsupported executable field "${key}".`);
    }
    rejectExecutableContent(child, `${path}.${key}`);
  }
}

function validateRemoteMcpDescriptor(descriptor) {
  const mcp = assertPlainObject(descriptor.mcp, "Publishing MCP descriptor must be an object.");
  assertClosedFields(mcp, MCP_DESCRIPTOR_FIELDS, "Publishing MCP descriptor");
  const transport = String(mcp.transport || "http").trim().toLowerCase();
  if (!REMOTE_MCP_TRANSPORTS.has(transport) || transport === "stdio") {
    throw publishingError(
      "upstream_publishing_mcp_transport_invalid",
      400,
      "Developer-published MCP services require a remote HTTP transport."
    );
  }
  const remoteUrl = mcp.url || mcp.endpoint || mcp.baseUrl || descriptor.baseUrl;
  validateRemoteUrl(remoteUrl, "descriptor.mcp.url");
  if (descriptor.operations !== undefined) {
    throw publishingError(
      "upstream_publishing_descriptor_invalid",
      400,
      "Developer-published MCP services derive tools/call from the remote catalog and do not accept operations arrays."
    );
  }
}

function validateDescriptorSafety(descriptor) {
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
      let decodedPath = "";
      try {
        decodedPath = decodeURIComponent(operation.path);
      } catch {
        decodedPath = "";
      }
      const pathSegments = decodedPath.split("/");
      if (typeof operation.path !== "string" || !operation.path.startsWith("/") || operation.path.startsWith("//") ||
          operation.path.includes("\\") || operation.path.includes("?") || operation.path.includes("#") ||
          /%2f|%5c/iu.test(operation.path) || !decodedPath || pathSegments.some((segment) => segment === "." || segment === "..")) {
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
      if (operation.requestSchema !== undefined) validateJsonSchema(operation.requestSchema, "descriptor.operations.requestSchema");
      if (operation.responseSchema !== undefined) validateJsonSchema(operation.responseSchema, "descriptor.operations.responseSchema");
    }
  }
}

function existingOwnership(existing, ownerRef) {
  if (!existing) return;
  if (existing.manifest?.metadata?.ownerRef !== ownerRef) {
    throw publishingError("upstream_publishing_owner_required", 403, "Service ownership is required.");
  }
}

function nextManifest({ command, descriptor, existing, ownerRef, serviceKeyRef }) {
  const state = command.action === "disable"
    ? "disabled"
    : command.action === "remove"
      ? "removed"
      : "publishing";
  const references = state === "removed"
    ? []
    : descriptor.references === undefined
      ? existing?.manifest?.references || []
      : descriptor.references;
  const projectedDescriptor = state === "removed"
    ? null
    : Object.fromEntries(Object.entries(descriptor).filter(([key]) => key !== "references"));
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

function mapStorageError(error) {
  const statusCode = error?.code === "storage_manifest_replay_conflict" ||
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
  getPublicationFacts = () => null,
  auditPort
}) {
  if (typeof writerPort?.commitManifestSet !== "function" || typeof readerPort?.getSnapshot !== "function") {
    throw new TypeError("Upstream publishing application requires durable writer and snapshot reader ports.");
  }
  if (typeof auditPort?.append !== "function") {
    throw new TypeError("Upstream publishing application requires an audit append port.");
  }

  function readSubject(subject) {
    const authenticated = authenticate(subject);
    authorizeRead(authenticated);
    return {
      ...authenticated,
      ownerRef: `urn:lico:subject:${digest("upstream-owner", authenticated.subjectId)}`
    };
  }

  function canReadRecord(authenticated, record) {
    return authenticated.scopes.has("gateway:admin") || record.manifest?.metadata?.ownerRef === authenticated.ownerRef;
  }

  function publicationFor(record, candidateSnapshot, publishedSnapshot) {
    const publicationRef = `urn:lico:upstream-publication:${digest(
      "upstream-publication",
      record.serviceId,
      record.serviceRevision,
      record.manifestDigest
    )}`;
    const publishedRecord = publishedSnapshot?.getService?.(record.serviceId) || null;
    const facts = getPublicationFacts?.() || null;
    const serverPublished = Boolean(
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
    async list(subject, { signal } = {}) {
      const authenticated = readSubject(subject);
      const snapshot = await readerPort.getSnapshot({ signal });
      const publishedSnapshot = typeof publishedReaderPort?.getSnapshot === "function"
        ? await publishedReaderPort.getSnapshot({ signal })
        : null;
      const services = snapshot.listServices()
        .filter((record) => canReadRecord(authenticated, record))
        .map((record) => Object.freeze({
          serviceId: record.serviceId,
          state: record.manifest.payload.state,
          serviceRevision: record.serviceRevision,
          manifestDigest: record.manifestDigest,
          publication: publicationFor(record, snapshot, publishedSnapshot)
        }));
      return Object.freeze({ ok: true, setRevision: snapshot.setRevision, services: Object.freeze(services) });
    },
    async get(serviceId, subject, { signal } = {}) {
      const authenticated = readSubject(subject);
      const snapshot = await readerPort.getSnapshot({ signal });
      const publishedSnapshot = typeof publishedReaderPort?.getSnapshot === "function"
        ? await publishedReaderPort.getSnapshot({ signal })
        : null;
      const record = snapshot.getService(serviceId);
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
    async execute(rawCommand, subject, { signal, expectedAction = "", expectedServiceId = "" } = {}) {
      const authenticated = authenticate(subject);
      const command = parseCommand(rawCommand);
      if (expectedAction && command.action !== expectedAction) {
        throw publishingError("upstream_publishing_action_mismatch", 400, "Publishing action does not match the selected operation.");
      }
      if (expectedServiceId && command.serviceId !== expectedServiceId) {
        throw publishingError("upstream_publishing_service_id_mismatch", 400, "Publishing serviceId does not match the route.");
      }
      authorize(authenticated, command.action);
      const serviceId = commandServiceId(command, authenticated.subjectId);
      const ownerRef = `urn:lico:subject:${digest("upstream-owner", authenticated.subjectId)}`;
      const snapshot = await readerPort.getSnapshot({ signal });
      const existing = snapshot.getService(serviceId);

      if (command.action !== "create" && !existing) {
        throw publishingError("upstream_publishing_service_not_found", 404, "Service was not found.");
      }
      existingOwnership(existing, ownerRef);
      const descriptor = descriptorFromCommand(command, existing);
      const serviceKeyRef = existing?.manifest?.metadata?.serviceKeyRef ||
        `urn:lico:service-key:${digest("upstream-service-key", command.serviceKey)}`;
      const manifest = canonicalizeTypedReferenceManifest(
        nextManifest({ command, descriptor, existing, ownerRef, serviceKeyRef })
      ).manifest;
      const requestDigest = digest("upstream-publishing-request", authenticated.subjectId, command.idempotencyKey);

      await auditPort.append(Object.freeze({
        event: "upstream.publishing.request.accepted",
        action: command.action,
        ownerRef,
        serviceRef: `urn:lico:service:${digest("upstream-service-ref", serviceId)}`,
        requestRef: `urn:lico:request:${requestDigest}`
      }));

      let outcome;
      try {
        outcome = await writerPort.commitManifestSet({
          serviceId,
          expectedServiceRevision: command.expectedServiceRevision,
          expectedSetRevision: command.expectedSetRevision,
          manifest,
          requestDigest,
          signal
        });
      } catch (error) {
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
          publicationRef: `urn:lico:upstream-publication:${digest(
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
