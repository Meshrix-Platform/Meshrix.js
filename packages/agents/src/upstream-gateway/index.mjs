import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { evaluateUniversalTagPolicy, hasUniversalTagPolicyRules } from "@lico/foundation/security/authorization/universal-tag-policy";
import { createSecurityAlertStore } from "@lico/foundation/security/security-alerts";
import { fetchWithPinnedDns, requestWithPinnedDns } from "@lico/foundation/security/outbound-egress-policy";
import { createUpstreamMcpSessionManager } from "@lico/protocols/mcp/upstream-mcp-client";
import {
  UPSTREAM_GATEWAY_PROTOCOL_VERSION,
  asArray,
  callerRoutingOverrideFields,
  clone,
  configuredHeaders,
  configuredHttpMethod,
  configuredRpcMethod,
  jsonRpcRequestBody,
  nowIso,
  object,
  parsePublicUpstreamMcpToolName,
  publicService,
  rejectUpstreamDestinationOverrideFields,
  responseBodyForPublic,
  runtimePath,
  safePublicToolSegment,
  safeTargetUrl,
  summarizeUrl,
  text
} from "./support.mjs";
import { publicUpstreamMcpTool, publicUpstreamOperationTool } from "./tool-projection.mjs";
import { resolveCredentialMaterial, resolveMcpServiceConfigWithCredentials } from "./credential-material.mjs";
import { createGatewayRuntime } from "./registry-runtime.mjs";
import {
  assertResponseBodyPolicy,
  bodyMetadata,
  readAsyncBodyBufferWithLimit,
  readResponseBufferWithLimit
} from "./response-policy.mjs";
import { publicTagPolicyDecision } from "./tag-policy-decision.mjs";
import { createEndpointTrafficController } from "./endpoint-traffic.mjs";
import { callerApprovalOverrideFields, pendingApproval, trustedApprovalForForward } from "./approval.mjs";
import { compileUpstreamOperationCapability, evaluateDynamicOperationAuthorization, operationWithUpstreamCapability } from "./operation-capability.mjs";
import { createMcpForwarder } from "./mcp-forwarder.mjs";
import { constructWithOwnedResourceCleanup, createForwardAbortContext } from "./registry-lifecycle.mjs";
import { fingerprint } from "./manifest-compiler.mjs";
import { upstreamProjectedOperationId } from "./operation-projection.mjs";
import { createUpstreamManifestSnapshotCommitter } from "./manifest-snapshot-commit.mjs";
import { evaluateAudienceDecision } from "./audience-projection.mjs";
import {
  compilePayloadTransport,
  createPayloadCountingTransform,
  payloadRepresentationError,
  selectRequestRepresentationHeaders,
  selectResponseRepresentationHeaders
} from "./payload-contract.mjs";
import { createArtifactBodySource, createMultipartBodyStream } from "./multipart-stream.mjs";

export { UPSTREAM_GATEWAY_PROTOCOL_VERSION } from "./support.mjs";
export { fingerprint } from "./manifest-compiler.mjs";
export { createUpstreamManifestObserver } from "./manifest-observer.mjs";
export {
  createUpstreamPublishingApplication,
  UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION
} from "./publishing-application.mjs";
export {
  compileUpstreamOperationProjection,
  upstreamProjectedOperationId
} from "./operation-projection.mjs";
export {
  AUDIENCE_PUBLICATION_SCHEMA_VERSION,
  AUDIENCE_PUBLICATION_TOPIC,
  compileAudienceProjection,
  createAudiencePublicationEvent,
  evaluateAudienceDecision,
  evaluateAudienceParity,
  opaqueAudiencePartitionKey
} from "./audience-projection.mjs";
export { createUpstreamManifestSnapshotCommitter } from "./manifest-snapshot-commit.mjs";
export function createUpstreamGatewayRegistry({
  userDataPath = "",
  tagStore = null,
  securityPermissions = null,
  mcpSessionManager = null,
  artifactTransitPort = null
} = {}) {
  const persistenceEnabled = Boolean(userDataPath);
  const filePath = persistenceEnabled ? runtimePath(userDataPath) : "";
  let services = new Map();
  let projectedOperationTargets = new Map();
  let manifestSnapshotRevision = Object.freeze({ sourceRevision: 0, sourceDigest: "" });
  const trafficBuckets = new Map();
  const endpointCursors = new Map();
  const endpointCircuits = new Map();
  const mcpToolCache = new Map();

  function clearServiceRuntimeState(serviceIds = []) {
    const prefixes = asArray(serviceIds).map((serviceId) => `${serviceId}::`);
    if (prefixes.length === 0) return;
    for (const stateMap of [trafficBuckets, endpointCursors, endpointCircuits, mcpToolCache]) {
      for (const key of stateMap.keys()) {
        if (prefixes.some((prefix) => String(key).startsWith(prefix))) stateMap.delete(key);
      }
    }
  }
  const securityAlertStore = persistenceEnabled
    ? createSecurityAlertStore({ userDataPath })
    : null;
  let closed = false;
  let closePromise = null;
  const resolvedTagStore =
    tagStore ||
    securityPermissions?.tagManagementStore ||
    null;
  const {
    auditEvents,
    metrics,
    appendAudit,
    appendSecurityAlert,
    recordMetric,
    refreshRuntimeStateFromDisk,
    persist
  } = constructWithOwnedResourceCleanup(
    securityAlertStore,
    () => createGatewayRuntime({
      persistenceEnabled,
      filePath,
      securityAlertStore
    })
  );
  const {
    endpointsFor,
    publicEndpoint,
    recordEndpointOutcome,
    retireServices: retireEndpointTrafficServices,
    selectEndpointTraffic,
    withTrafficSlot
  } = constructWithOwnedResourceCleanup(
    securityAlertStore,
    () => createEndpointTrafficController({
      trafficBuckets,
      endpointCursors,
      endpointCircuits,
      appendAudit,
      recordMetric,
      persist
    })
  );
  const upstreamMcpSessions = mcpSessionManager || createUpstreamMcpSessionManager({
    fetchTransport: fetchConfiguredMcpUpstream
  });
  const forwardMcp = constructWithOwnedResourceCleanup(
    securityAlertStore,
    () => createMcpForwarder({
      appendAudit,
      mcpSessionManager: upstreamMcpSessions,
      mcpServiceConfigWithCredentials,
      persist,
      publicEndpoint,
      recordEndpointOutcome,
      recordMetric
    })
  );

  function upstreamEgressPolicies(service) {
    return {
      egress: {
        allowLocalForConfiguredModelService: service.allowLocalNetwork === true
      }
    };
  }

  function fetchConfiguredUpstream(service, url, init, label) {
    return fetchWithPinnedDns({
      url,
      label,
      policies: upstreamEgressPolicies(service),
      init
    });
  }

  function requestConfiguredUpstream(service, url, init, label) {
    return requestWithPinnedDns({
      url,
      label,
      policies: upstreamEgressPolicies(service),
      init
    });
  }

  function fetchConfiguredMcpUpstream(url, init, { config = {} } = {}) {
    return fetchWithPinnedDns({
      url,
      label: `upstream-gateway.${text(config.gatewayServiceId || "mcp")}.mcp`,
      policies: {
        egress: {
          allowLocalForConfiguredModelService: config.allowLocalNetwork === true
        }
      },
      init
    });
  }

  function requireService(serviceId) {
    const service = services.get(text(serviceId));
    if (!service) {
      throw new Error(`Upstream service not found: ${serviceId}`);
    }
    return service;
  }
  function operationFor(service, operationKey = "") {
    const key = text(operationKey || "default");
    const operation = asArray(service.operations).find((item) => item.operationKey === key) ||
      asArray(service.operations)[0];
    if (!operation) {
      throw new Error(`Upstream operation not found: ${key}`);
    }
    return operation;
  }
  function previewFor(service, operation, subject = {}) {
    const { traffic } = selectEndpointTraffic(service, operation, { consume: false });
    const subjectScopes = new Set(asArray(subject.scopes).map(text));
    const roleId = text(subject.roleId || subject.role || "");
    const bypass = ["owner", "admin"].includes(roleId) ||
      ["auth:admin", "runtime:admin", "gateway:admin"].some((scope) => subjectScopes.has(scope));
    const missingScopes = bypass ? [] : operation.requiredScopes.filter((scope) => !subjectScopes.has(scope));
    const tagPolicy = evaluateServiceTagPolicy(service);
    const dynamicAuthorization = evaluateDynamicOperationAuthorization(subject, operation);
    return {
      protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
      serviceId: service.serviceId,
      operationKey: operation.operationKey,
      allowed: !service.disabled && missingScopes.length === 0 && traffic.allowed && tagPolicy.allowed && dynamicAuthorization.allowed,
      disabled: service.disabled === true,
      requiredScopes: operation.requiredScopes,
      missingScopes,
      risk: operation.risk,
      dynamicCapability: operation.dynamicCapability || compileUpstreamOperationCapability(service, operation),
      dynamicAuthorization,
      requiresApproval: operation.requiresApproval === true,
      traffic: {
        allowed: traffic.allowed,
        algorithm: traffic.algorithm,
        routingAlgorithm: traffic.routingAlgorithm,
        endpoint: traffic.endpoint,
        circuit: traffic.circuit,
        perMinute: traffic.perMinute,
        burst: traffic.burst,
        maxConcurrent: traffic.maxConcurrent,
        remainingTokens: traffic.remainingTokens,
        inFlight: traffic.inFlight,
        serviceLimit: traffic.serviceLimit,
        endpointLimit: traffic.endpointLimit,
        retryAfterMs: traffic.retryAfterMs,
        deniedReason: traffic.deniedReason,
        deniedScope: traffic.deniedScope,
        resetAt: traffic.resetAt
      },
      tagPolicy: tagPolicy.public
    };
  }

  function evaluateServiceTagPolicy(service) {
    if (!hasUniversalTagPolicyRules(service.tagPolicy || {})) {
      return {
        allowed: true,
        public: {
          enabled: false,
          allowed: true
        }
      };
    }
    const decision = evaluateUniversalTagPolicy({
      tagStore: resolvedTagStore,
      ...service.tagPolicy
    });
    return {
      allowed: decision.allowed === true,
      decision,
      public: publicTagPolicyDecision(decision)
    };
  }

  function rejectServiceTagPolicy(service, operation, decision = {}) {
    recordMetric({ serviceId: service.serviceId, statusCode: 403, failed: true });
    const audit = appendAudit("upstream.tag_policy.denied", {
      serviceId: service.serviceId,
      operationKey: operation.operationKey,
      protocol: operation.protocol,
      reason: text(decision.reasonCode || "tag_policy_denied"),
      tagPolicy: publicTagPolicyDecision(decision)
    });
    persist();
    throw Object.assign(new Error("Upstream gateway tag policy denied."), {
      status: 403,
      details: {
        protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
        serviceId: service.serviceId,
        operationKey: operation.operationKey,
        tagPolicy: publicTagPolicyDecision(decision)
      },
      audit
    });
  }

  function rejectCallerApprovalOverride(input = {}, service, operation, subject = {}) {
    const deniedFields = callerApprovalOverrideFields(input);
    if (deniedFields.length === 0) return;
    appendSecurityAlert({
      reasonCode: "upstream_approval_override_denied",
      severity: "critical",
      title: "Upstream gateway caller approval override denied",
      serviceId: service.serviceId,
      operationKey: operation.operationKey,
      evidence: {
        serviceId: service.serviceId,
        operationKey: operation.operationKey,
        deniedFields,
        subjectType: subject?.type || "subject"
      }
    });
    recordMetric({ serviceId: service.serviceId, statusCode: 400, failed: true });
    persist();
    throw Object.assign(new Error("Upstream gateway approval cannot be supplied by request body."), {
      status: 400,
      reasonCode: "upstream_approval_override_denied",
      details: {
        protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
        serviceId: service.serviceId,
        operationKey: operation.operationKey,
        deniedFields,
        reasonCode: "upstream_approval_override_denied"
      }
    });
  }

  function authorizeForwardPreview(service, operation, subject) {
    const preview = previewFor(service, operation, subject);
    if (preview.missingScopes.length > 0) {
      throw Object.assign(new Error("Upstream gateway scope denied."), { status: 403, details: preview });
    }
    if (!preview.dynamicAuthorization.allowed) {
      throw Object.assign(new Error("Upstream gateway dynamic operation capability denied."), {
        status: 403,
        reasonCode: preview.dynamicAuthorization.reasonCode,
        details: {
          protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
          serviceId: service.serviceId,
          operationKey: operation.operationKey,
          reasonCode: preview.dynamicAuthorization.reasonCode
        }
      });
    }
    if (preview.tagPolicy?.enabled && !preview.tagPolicy.allowed) {
      rejectServiceTagPolicy(service, operation, evaluateServiceTagPolicy(service).decision);
    }
    return preview;
  }

  function authorizeMcpDiscoverySubject(subject = {}) {
    const scopes = new Set(asArray(subject.scopes).map(text).filter(Boolean));
    if (["gateway:admin", "gateway:read", "gateway:write"].some((scope) => scopes.has(scope))) return;
    throw Object.assign(new Error("Upstream MCP discovery scope denied."), {
      status: 403,
      reasonCode: "upstream_mcp_discovery_scope_denied"
    });
  }

  async function credentialMaterialFor(service, operation = {}, options = {}) {
    return resolveCredentialMaterial({
      userDataPath,
      service,
      operation,
      ...object(options)
    });
  }

  async function mcpServiceConfigWithCredentials(service, operation = {}) {
    return resolveMcpServiceConfigWithCredentials({
      userDataPath,
      service,
      operation
    });
  }

  function requireArtifactTransitPort() {
    if (
      !artifactTransitPort ||
      typeof artifactTransitPort.openRead !== "function" ||
      typeof artifactTransitPort.beginWrite !== "function" ||
      typeof artifactTransitPort.commit !== "function" ||
      typeof artifactTransitPort.abort !== "function"
    ) {
      throw payloadRepresentationError(
        "artifact_transit_unavailable",
        "Artifact transit is unavailable.",
        503
      );
    }
    return artifactTransitPort;
  }

  function rawHeader(headers = {}, name = "") {
    const value = headers?.[name.toLowerCase()];
    return Array.isArray(value) ? String(value[0] || "") : String(value || "");
  }

  function artifactNameFromHeaders(headers = {}) {
    const disposition = rawHeader(headers, "content-disposition");
    const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
    if (encoded) {
      try {
        return decodeURIComponent(encoded);
      } catch {
        // Fall through to the quoted filename.
      }
    }
    return /filename="([^"]+)"/iu.exec(disposition)?.[1] ||
      /filename=([^;\s]+)/iu.exec(disposition)?.[1] ||
      "upstream-artifact.bin";
  }

  function requestArguments(input = {}) {
    return object(input.arguments || input.params || input.payload || input.body);
  }

  function timeoutFor(operation, options = {}) {
    const requestedTimeoutMs = Number(options.timeoutMs || 0);
    return Number.isSafeInteger(requestedTimeoutMs) && requestedTimeoutMs >= 100
      ? Math.min(operation.timeoutMs, requestedTimeoutMs)
      : operation.timeoutMs;
  }

  async function requestBodySourceFor(operation, input, subject) {
    const transport = compilePayloadTransport(operation);
    const requestPolicy = transport.request;
    if (requestPolicy.mode === "artifact_body") {
      const argumentsValue = requestArguments(input);
      return createArtifactBodySource({
        reference: argumentsValue[requestPolicy.artifactArgument],
        artifactPort: requireArtifactTransitPort(),
        subject,
        maxBytes: requestPolicy.maxBytes
      });
    }
    if (requestPolicy.mode === "artifact_multipart") {
      return createMultipartBodyStream({
        mapping: requestPolicy.multipart,
        fields: requestArguments(input),
        artifactPort: requireArtifactTransitPort(),
        subject,
        maxBytes: requestPolicy.maxBytes
      });
    }
    if (requestPolicy.mode === "opaque_stream") {
      throw payloadRepresentationError(
        "artifact_staging_required",
        "Opaque request streaming requires the native HTTP transit route.",
        409
      );
    }
    const rpcMethod = operation.protocol === "json-rpc"
      ? configuredRpcMethod(operation)
      : "";
    const source = operation.protocol === "json-rpc"
      ? jsonRpcRequestBody(input, operation, rpcMethod)
      : input.bodyJson !== undefined
        ? input.bodyJson
        : input.body === undefined
          ? object(input.payload)
          : input.body;
    const bytes = Buffer.from(typeof source === "string" ? source : JSON.stringify(source), "utf8");
    if (bytes.byteLength > requestPolicy.maxBytes) {
      throw payloadRepresentationError("request_body_too_large", "Structured request exceeds its published limit.", 413);
    }
    return Object.freeze({
      contentType: "application/json",
      contentLength: bytes.byteLength,
      replayable: true,
      metadata: null,
      openBody: () => Readable.from([bytes]),
      structuredValue: source
    });
  }

  async function forwardRepresentationOperation({
    service,
    operation,
    input,
    subject,
    options,
    traffic,
    endpoint
  }) {
    const transport = compilePayloadTransport(operation);
    const targetUrl = safeTargetUrl(service, operation, input, endpoint);
    const method = configuredHttpMethod(operation);
    const credentials = await credentialMaterialFor(service, operation, { targetUrl });
    const source = ["GET", "HEAD"].includes(method)
      ? null
      : await requestBodySourceFor(operation, input, subject);
    const headers = {
      ...configuredHeaders(service),
      ...credentials.headers,
      ...(source?.contentType ? { "content-type": source.contentType } : {}),
      ...(Number.isSafeInteger(source?.contentLength) ? { "content-length": String(source.contentLength) } : {}),
      "x-licomesh-gateway-service": service.serviceId
    };
    const requestBodyMetadata = bodyMetadata(
      source?.structuredValue,
      operation.sensitiveBodyFields,
      {
        byteLength: Number(source?.contentLength || 0),
        contentType: source?.contentType || ""
      }
    );
    const startedAt = Date.now();
    const abortContext = createForwardAbortContext(options.signal || null, timeoutFor(operation, options));
    let pinnedRequest = null;
    let artifactTransaction = null;
    try {
      pinnedRequest = await requestConfiguredUpstream(service, targetUrl, {
        method,
        headers,
        body: source?.openBody?.(),
        signal: abortContext.signal,
        headersTimeout: timeoutFor(operation, options),
        bodyTimeout: timeoutFor(operation, options)
      }, `upstream-gateway.${service.serviceId}.${operation.operationKey}.payload`);
      const response = pinnedRequest.response;
      const status = Number(response.statusCode || 0);
      const contentType = rawHeader(response.headers, "content-type") || "application/octet-stream";
      const responseHeaders = selectResponseRepresentationHeaders(response.headers, transport.response);
      const declaredLength = Number(rawHeader(response.headers, "content-length") || 0);
      if (Number.isFinite(declaredLength) && declaredLength > transport.response.maxBytes) {
        response.body?.destroy?.();
        throw payloadRepresentationError(
          "upstream_response_too_large",
          "Upstream response exceeds its published limit.",
          502
        );
      }
      recordEndpointOutcome(service, operation, endpoint, {
        statusCode: status,
        ok: status >= 200 && status < 300
      });
      if (transport.response.mode === "structured_json") {
        const buffer = await readAsyncBodyBufferWithLimit(
          response.body || Readable.from([]),
          response.headers,
          transport.response.maxBytes
        );
        const responsePolicy = assertResponseBodyPolicy(contentType, buffer, operation);
        const audit = appendAudit("upstream.forward.completed", {
          serviceId: service.serviceId,
          operationKey: operation.operationKey,
          protocol: operation.protocol,
          method,
          target: summarizeUrl(targetUrl),
          endpoint: traffic.endpoint,
          circuit: traffic.circuit,
          statusCode: status,
          requestBody: requestBodyMetadata,
          responseBody: bodyMetadata(Buffer.from(buffer).toString("utf8"), operation.sensitiveBodyFields, {
            byteLength: buffer.byteLength,
            contentType
          }),
          responsePolicy: {
            schemaValidated: responsePolicy.schemaValidated === true,
            projectionValidated: responsePolicy.projectionValidated === true,
            publicFieldCount: asArray(operation.publicResponseFields).length
          },
          responseBytes: buffer.byteLength,
          durationMs: Date.now() - startedAt
        });
        recordMetric({ serviceId: service.serviceId, statusCode: status, failed: status < 200 || status >= 300 });
        persist();
        return {
          protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
          ok: status >= 200 && status < 300,
          serviceId: service.serviceId,
          operationKey: operation.operationKey,
          dynamicCapability: operation.dynamicCapability,
          upstream: {
            status,
            endpoint: traffic.endpoint,
            contentType,
            responseBytes: buffer.byteLength,
            durationMs: Date.now() - startedAt
          },
          response: responseBodyForPublic(contentType, buffer, operation.sensitiveBodyFields, operation.publicResponseFields),
          auditId: audit.auditId
        };
      }
      const artifactResponse = transport.response.mode === "artifact" || options.responseAdapter === "artifact";
      if (!artifactResponse) {
        response.body?.destroy?.();
        throw payloadRepresentationError(
          "opaque_response_requires_stream",
          "Opaque responses require native HTTP transit or the artifact response adapter.",
          409
        );
      }
      const artifactPort = requireArtifactTransitPort();
      artifactTransaction = await artifactPort.beginWrite(subject, {
        name: artifactNameFromHeaders(response.headers),
        mediaType: contentType
      }, {
        maxBytes: transport.response.maxBytes
      });
      const counter = createPayloadCountingTransform(transport.response.maxBytes, {
        tooLargeCode: "upstream_response_too_large",
        tooLargeStatus: 502
      });
      await pipeline(
        response.body || Readable.from([]),
        counter,
        artifactTransaction.writable,
        { signal: abortContext.signal }
      );
      const resource = await artifactPort.commit(artifactTransaction, {
        byteLength: counter.byteLength,
        sha256: counter.sha256
      });
      artifactTransaction = null;
      const audit = appendAudit("upstream.forward.completed", {
        serviceId: service.serviceId,
        operationKey: operation.operationKey,
        protocol: operation.protocol,
        method,
        target: summarizeUrl(targetUrl),
        endpoint: traffic.endpoint,
        circuit: traffic.circuit,
        statusCode: status,
        requestBody: requestBodyMetadata,
        responseBody: bodyMetadata(undefined, operation.sensitiveBodyFields, {
          byteLength: resource.byteLength,
          contentType
        }),
        responseBytes: resource.byteLength,
        responseRepresentation: "artifact",
        durationMs: Date.now() - startedAt
      });
      recordMetric({ serviceId: service.serviceId, statusCode: status, failed: status < 200 || status >= 300 });
      persist();
      return {
        protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
        ok: status >= 200 && status < 300,
        serviceId: service.serviceId,
        operationKey: operation.operationKey,
        dynamicCapability: operation.dynamicCapability,
        upstream: {
          status,
          endpoint: traffic.endpoint,
          contentType,
          responseBytes: resource.byteLength,
          durationMs: Date.now() - startedAt
        },
        response: { artifact: resource, headers: responseHeaders },
        resource,
        auditId: audit.auditId
      };
    } catch (error) {
      if (artifactTransaction) {
        await artifactTransitPort.abort(artifactTransaction, String(error?.code || "artifact_write_aborted")).catch(() => {});
      }
      const callerAborted = abortContext.callerAborted();
      const timedOut = !callerAborted && (abortContext.timedOut() || error?.name === "AbortError");
      const status = callerAborted ? 499 : timedOut ? 504 : error?.status || 502;
      const reasonCode = callerAborted
        ? "upstream_forward_cancelled"
        : timedOut
          ? "upstream_forward_timeout"
          : text(error?.reasonCode || error?.code || "upstream_forward_failed");
      recordEndpointOutcome(service, operation, endpoint, { statusCode: status, ok: false });
      recordMetric({ serviceId: service.serviceId, statusCode: status, failed: true });
      const audit = appendAudit("upstream.forward.failed", {
        serviceId: service.serviceId,
        operationKey: operation.operationKey,
        protocol: operation.protocol,
        method,
        target: summarizeUrl(targetUrl),
        endpoint: traffic.endpoint,
        circuit: traffic.circuit,
        statusCode: status,
        requestBody: requestBodyMetadata,
        reasonCode,
        durationMs: Date.now() - startedAt
      });
      persist();
      throw Object.assign(error instanceof Error ? error : new Error("Upstream gateway forwarding failed."), {
        status,
        reasonCode,
        audit
      });
    } finally {
      await pinnedRequest?.close?.().catch?.(() => {});
      abortContext.dispose();
    }
  }

  async function listMcpToolsForService(service, {
    refresh = false,
    signal = null,
    onNotification = null
  } = {}) {
    if (service.serviceProtocol !== "mcp") {
      return [];
    }
    const cacheKey = `${service.serviceId}::${service.updatedAt || ""}`;
    const cached = mcpToolCache.get(cacheKey);
    const ttlMs = Number(service.mcp?.toolsCacheTtlMs || 0);
    if (!refresh && cached && ttlMs > 0 && Date.now() - cached.loadedAt <= ttlMs) {
      return clone(cached.tools);
    }
    let listed;
    try {
      listed = await upstreamMcpSessions.listTools(
        await mcpServiceConfigWithCredentials(service, {
          operationKey: "tools/list",
          requiredScopes: ["gateway:read"]
        }),
        { signal, onNotification }
      );
    } catch (cause) {
      if (signal?.aborted || cause?.name === "AbortError") {
        throw Object.assign(new Error("Upstream MCP discovery was cancelled."), {
          status: 499,
          reasonCode: "upstream_mcp_cancelled",
          cause
        });
      }
      throw Object.assign(new Error("Upstream MCP discovery failed."), {
        status: 502,
        reasonCode: "upstream_mcp_discovery_failed",
        cause
      });
    }
    const tools = asArray(listed.tools)
      .filter((tool) => text(tool.name))
      .map((tool) => publicUpstreamMcpTool({ service, tool }));
    mcpToolCache.set(cacheKey, {
      loadedAt: Date.now(),
      tools
    });
    return clone(tools);
  }

  function serviceForPublicMcpToolName(publicName = "") {
    const parsed = parsePublicUpstreamMcpToolName(publicName);
    if (!parsed) return null;
    for (const service of services.values()) {
      if (service.serviceProtocol !== "mcp") continue;
      const prefix = service.mcp?.toolNamePrefix || safePublicToolSegment(service.serviceId);
      if (prefix === parsed.prefix) {
        return {
          service,
          upstreamToolName: parsed.upstreamToolName
        };
      }
    }
    return null;
  }

  function configuredOperationForPublicToolName(publicName = "") {
    const parsed = parsePublicUpstreamMcpToolName(publicName);
    if (!parsed) return null;
    for (const service of services.values()) {
      if (service.serviceProtocol === "mcp") continue;
      const prefix = safePublicToolSegment(service.serviceId);
      if (prefix !== parsed.prefix) continue;
      const operation = asArray(service.operations).find((item) =>
        safePublicToolSegment(item.operationKey) === parsed.upstreamToolName
      );
      if (operation) {
        return { service, operation };
      }
    }
    return null;
  }

  function configuredOperationToolsForService(service) {
    if (service.serviceProtocol === "mcp" || service.disabled) return [];
    return asArray(service.operations)
      .filter((operation) => operation?.operationKey)
      .map((operation) => publicUpstreamOperationTool({ service, operation }));
  }

  async function resolvedMcpOperationForInput(service, operation, input = {}, options = {}) {
    if (service.serviceProtocol !== "mcp" && operation.protocol !== "mcp") {
      return operation;
    }
    const upstreamToolName = text(
      input.toolName ||
        input.name ||
        input.mcpTool ||
        input.upstreamToolName ||
        operation.toolName ||
        (operation.operationKey !== "tools/call" ? operation.operationKey : "")
    );
    if (!upstreamToolName) {
      return operation;
    }
    const tools = await listMcpToolsForService(service, options);
    const publicTool = tools.find((tool) =>
      tool?._meta?.upstreamToolName === upstreamToolName ||
        tool.name === input.publicToolName ||
        tool.name === input.upstreamPublicToolName
    );
    if (!publicTool) {
      return operation;
    }
    const meta = object(publicTool._meta);
    return {
      ...operation,
      dynamicCapability: meta.dynamicCapability || compileUpstreamOperationCapability(service, operation, { upstreamToolName }),
      requiredScopes: asArray(meta.requiredScopes || operation.requiredScopes).map(text).filter(Boolean),
      risk: text(meta.risk || operation.risk),
      requiresApproval: meta.requiresApproval === true ||
        meta.risk === "repair_write" ||
        meta.risk === "destructive" ||
        operation.requiresApproval === true
    };
  }

  return {
    protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
    listServices() {
      const items = [...services.values()].map(publicService);
      return {
        protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
        items,
        count: items.length
      };
    },
    getService(serviceId) {
      return publicService(requireService(serviceId));
    },
    evaluateProjectedOperationAudience({ grant = null, tool = null, purpose = "discovery" } = {}) {
      if (tool?.upstreamProjectedOperation !== true) {
        return Object.freeze({
          allowed: true,
          reasonCode: "audience_not_applicable",
          purpose: purpose === "execution" ? "execution" : "discovery",
          visibleMetadata: true
        });
      }
      const serviceId = text(tool.serviceId || tool.dynamicCapability?.serviceId);
      const service = services.get(serviceId) || null;
      return evaluateAudienceDecision({
        grant,
        service,
        tagStore: resolvedTagStore,
        purpose,
        operation: {
          id: text(tool.operationId),
          toolId: text(tool.id),
          requiredScopes: asArray(tool.requiredScopes),
          toolsets: asArray(tool.toolsets),
          safety: { risk: text(tool.risk || tool.dynamicCapability?.risk || "read_only") },
          _meta: {
            serviceId,
            risk: text(tool.risk || tool.dynamicCapability?.risk || "read_only"),
            dynamicCapability: tool.dynamicCapability || null
          }
        }
      });
    },
    evaluateDiscoveredMcpToolAudience({ grant = null, tool = null, purpose = "discovery" } = {}) {
      const meta = object(tool?._meta);
      if (meta.upstreamMcp !== true) {
        return Object.freeze({
          allowed: false,
          reasonCode: "audience_operation_unavailable",
          purpose: purpose === "execution" ? "execution" : "discovery",
          visibleMetadata: false
        });
      }
      const service = services.get(text(meta.serviceId)) || null;
      return evaluateAudienceDecision({
        grant,
        service,
        tagStore: resolvedTagStore,
        purpose,
        operation: {
          id: text(tool.name),
          toolId: text(tool.name),
          requiredScopes: asArray(meta.requiredScopes),
          toolsets: asArray(meta.toolsets),
          safety: { risk: text(meta.risk || meta.dynamicCapability?.risk || "read_only") },
          _meta: {
            serviceId: text(meta.serviceId),
            risk: text(meta.risk || meta.dynamicCapability?.risk || "read_only"),
            dynamicCapability: meta.dynamicCapability || null
          }
        }
      });
    },
    async listMcpTools(input = {}, options = {}) {
      const requestedServiceId = text(input.serviceId || "");
      const refresh = input.refresh === true;
      const items = [];
      for (const service of services.values()) {
        if (requestedServiceId && service.serviceId !== requestedServiceId) continue;
        if (service.disabled) continue;
        if (service.serviceProtocol === "mcp") {
          const tools = await listMcpToolsForService(service, {
            refresh,
            signal: options.signal || null,
            onNotification: options.onNotification || null
          });
          items.push(...tools);
        } else {
          items.push(...configuredOperationToolsForService(service));
        }
      }
      return {
        protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
        items,
        count: items.length
      };
    },
    async callMcpToolByPublicName(publicName = "", input = {}, subject = {}, options = {}) {
      const target = serviceForPublicMcpToolName(publicName);
      const configuredTarget = target ? null : configuredOperationForPublicToolName(publicName);
      if (!target && !configuredTarget) {
        throw Object.assign(new Error(`Upstream MCP tool not found: ${publicName}`), { status: 404 });
      }
      if (configuredTarget) {
        const operationInput = object(input.arguments || input.input || input.payload || input);
        return this.forward({
          serviceId: configuredTarget.service.serviceId,
          operationKey: configuredTarget.operation.operationKey,
          ...(configuredTarget.operation.protocol === "json-rpc"
            ? { rpcParams: operationInput }
            : ["GET", "HEAD"].includes(configuredTarget.operation.method)
              ? { query: operationInput }
              : { body: operationInput })
        }, subject, options);
      }
      authorizeMcpDiscoverySubject(subject);
      const tools = await listMcpToolsForService(target.service, options);
      const tool = tools.find((item) => item.name === publicName);
      if (!tool) {
        throw Object.assign(new Error(`Upstream MCP tool not found: ${publicName}`), { status: 404 });
      }
      return this.forward({
        ...input,
        serviceId: target.service.serviceId,
        operationKey: "tools/call",
        toolName: target.upstreamToolName,
        upstreamPublicToolName: publicName
      }, subject, options);
    },
    previewPolicy(input = {}, subject = {}) {
      const service = requireService(input.serviceId);
      const operation = operationWithUpstreamCapability(service, operationFor(service, input.operationKey));
      return previewFor(service, operation, subject);
    },
    async health(serviceId) {
      const service = requireService(serviceId);
      if (service.serviceProtocol === "mcp") {
        const startedAt = Date.now();
        try {
          const tools = await listMcpToolsForService(service, { refresh: true });
          return {
            ok: true,
            serviceId,
            status: 200,
            protocol: "mcp",
            toolCount: tools.length,
            latencyMs: Date.now() - startedAt,
            checkedAt: nowIso()
          };
        } catch (error) {
          return {
            ok: false,
            serviceId,
            status: 0,
            protocol: "mcp",
            latencyMs: Date.now() - startedAt,
            checkedAt: nowIso(),
            error: text(error?.reasonCode || "upstream_mcp_health_failed")
          };
        }
      }
      const startedAt = Date.now();
      const endpoints = endpointsFor(service);
      const checks = [];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        for (const endpoint of endpoints) {
          const url = safeTargetUrl(service, { path: service.healthPath }, {}, endpoint);
          const pinnedFetch = await fetchConfiguredUpstream(service, url, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal
          }, `upstream-gateway.${service.serviceId}.health`);
          try {
            const response = pinnedFetch.response;
            checks.push({
              endpoint: publicEndpoint(endpoint),
              ok: response.ok,
              status: response.status
            });
            await response.body?.cancel?.().catch?.(() => {});
            if (response.ok) break;
          } finally {
            await pinnedFetch.close();
          }
        }
        const firstOk = checks.find((item) => item.ok) || checks[0] || { ok: false, status: 0 };
        return {
          ok: firstOk.ok,
          serviceId,
          status: firstOk.status,
          endpointCount: endpoints.length,
          healthyEndpointCount: checks.filter((item) => item.ok).length,
          endpoints: checks,
          latencyMs: Date.now() - startedAt,
          checkedAt: nowIso()
        };
      } catch (error) {
        return {
          ok: false,
          serviceId,
          status: 0,
          latencyMs: Date.now() - startedAt,
          checkedAt: nowIso(),
          error: error instanceof Error ? error.name : "health_failed"
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    async requestPluginExternalService(request = {}, { subject = {}, signal = null } = {}) {
      const serviceRef = text(request.serviceRef);
      const operationRef = text(request.operationRef);
      const pluginId = text(request.pluginId);
      const callerOperationId = text(request.operationId);
      const governance = object(request.governance);
      if (!pluginId || !serviceRef || !operationRef || operationRef !== callerOperationId ||
          !text(governance.authorizationContextDigest) || !text(governance.riskDecisionRef) ||
          !text(governance.policyRevision)) {
        throw Object.assign(new Error("Plugin external service binding is invalid."), { status: 403 });
      }
      const service = requireService(serviceRef);
      if (service.disabled) {
        throw Object.assign(new Error("Upstream service is disabled."), { status: 403 });
      }
      const configuredOperation = operationWithUpstreamCapability(
        service,
        operationFor(service, operationRef)
      );
      const requestInput = object(request.input);
      const timeoutMs = Number(request.timeoutMs || 0);
      const forwardOptions = {
        signal,
        ...(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100
          ? { timeoutMs: Math.min(timeoutMs, 300_000) }
          : {})
      };
      if (service.serviceProtocol === "mcp" || configuredOperation.protocol === "mcp") {
        const pluginSubject = {
          ...subject,
          scopes: [...new Set([...asArray(subject.scopes).map(text).filter(Boolean), "gateway:read"])]
        };
        const protocolMethod = text(requestInput.protocolMethod);
        if (protocolMethod === "tools/list") {
          authorizeMcpDiscoverySubject(pluginSubject);
          authorizeForwardPreview(service, configuredOperation, pluginSubject);
          const items = await listMcpToolsForService(service, {
            refresh: requestInput.refresh === true,
            signal
          });
          return Object.freeze({
            ok: true,
            status: 200,
            data: Object.freeze({ items: clone(items), count: items.length })
          });
        }
        if (protocolMethod !== "tools/call") {
          throw Object.assign(new Error("Plugin external MCP method is invalid."), { status: 400 });
        }
        const toolName = text(requestInput.toolName);
        if (!toolName) {
          throw Object.assign(new Error("Plugin external MCP tool is required."), { status: 400 });
        }
        const forwarded = await this.forward({
          serviceId: serviceRef,
          operationKey: operationRef,
          toolName,
          arguments: object(requestInput.arguments),
          ...(request.idempotencyKey ? { idempotencyKey: text(request.idempotencyKey) } : {})
        }, pluginSubject, forwardOptions);
        return Object.freeze({
          ok: forwarded?.ok === true,
          status: forwarded?.ok === true ? 200 : Number(forwarded?.upstream?.status || 502),
          data: clone(forwarded?.response ?? null),
          ...(forwarded?.auditId ? { receiptRef: text(forwarded.auditId) } : {})
        });
      }

      const pathParameterNames = [...text(configuredOperation.path).matchAll(/\{([A-Za-z][A-Za-z0-9_]{0,63})\}/gu)]
        .map((match) => match[1]);
      const pathParameters = {};
      for (const name of pathParameterNames) {
        if (!Object.hasOwn(requestInput, name)) {
          throw Object.assign(new Error("Plugin external service path parameter is missing."), { status: 400 });
        }
        pathParameters[name] = requestInput[name];
      }
      const providerInput = Object.fromEntries(Object.entries(requestInput)
        .filter(([name]) => !pathParameterNames.includes(name)));
      const method = configuredHttpMethod(configuredOperation);
      const forwarded = await this.forward({
        serviceId: serviceRef,
        operationKey: operationRef,
        ...(pathParameterNames.length > 0 ? { pathParameters } : {}),
        ...(configuredOperation.protocol === "json-rpc"
          ? { rpcParams: providerInput }
          : ["GET", "HEAD"].includes(method)
            ? { query: providerInput }
            : { body: providerInput }),
        ...(request.idempotencyKey ? { idempotencyKey: text(request.idempotencyKey) } : {})
      }, subject, forwardOptions);
      const response = object(forwarded?.response);
      const data = Object.hasOwn(response, "json")
        ? response.json
        : Object.hasOwn(response, "text")
          ? response.text
          : response;
      return Object.freeze({
        ok: forwarded?.ok === true,
        status: Number(forwarded?.upstream?.status || (forwarded?.ok === true ? 200 : 502)),
        data: clone(data),
        ...(forwarded?.auditId ? { receiptRef: text(forwarded.auditId) } : {})
      });
    },
    previewHttpStream(input = {}, subject = {}) {
      const service = requireService(input.serviceId);
      const operation = operationWithUpstreamCapability(service, operationFor(service, input.operationKey));
      if (service.disabled) {
        throw Object.assign(new Error("Upstream service is disabled."), { status: 403 });
      }
      const preview = authorizeForwardPreview(service, operation, subject);
      if (!preview.traffic.allowed) {
        throw Object.assign(new Error("Upstream gateway traffic limit exceeded."), { status: 429, details: preview });
      }
      if (operation.requiresApproval && !trustedApprovalForForward(subject, operation)) {
        throw payloadRepresentationError(
          "artifact_staging_required",
          "Approval-bound payloads must be staged as owner-bound artifacts.",
          409
        );
      }
      const payloadTransport = compilePayloadTransport(operation);
      if (
        payloadTransport.request.mode !== "opaque_stream" ||
        payloadTransport.response.mode !== "opaque_stream"
      ) {
        throw payloadRepresentationError(
          "payload_policy_conflict",
          "Direct HTTP transit requires opaque_stream request and response modes.",
          409
        );
      }
      const method = configuredHttpMethod(operation);
      const hasRequestBody = !["GET", "HEAD"].includes(method);
      selectRequestRepresentationHeaders(input.requestHeaders || {}, payloadTransport.request, { hasBody: hasRequestBody });
      if (hasRequestBody && input.contentLength !== null && input.contentLength !== undefined) {
        const declaredLength = Number(input.contentLength);
        if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
          throw payloadRepresentationError("request_length_invalid", "Request content length is invalid.", 400);
        }
        if (declaredLength > payloadTransport.request.maxBytes) {
          throw payloadRepresentationError("request_body_too_large", "Request body exceeds its published limit.", 413);
        }
      }
      return Object.freeze({ ok: true, serviceId: service.serviceId, operationKey: operation.operationKey });
    },
    async forwardHttpStream(input = {}, subject = {}, options = {}) {
      const service = requireService(input.serviceId);
      const operation = operationWithUpstreamCapability(service, operationFor(service, input.operationKey));
      if (service.disabled) {
        throw Object.assign(new Error("Upstream service is disabled."), { status: 403 });
      }
      const preview = authorizeForwardPreview(service, operation, subject);
      if (!preview.traffic.allowed) {
        throw Object.assign(new Error("Upstream gateway traffic limit exceeded."), { status: 429, details: preview });
      }
      if (operation.requiresApproval && !trustedApprovalForForward(subject, operation)) {
        throw payloadRepresentationError(
          "artifact_staging_required",
          "Approval-bound payloads must be staged as owner-bound artifacts.",
          409
        );
      }
      const payloadTransport = compilePayloadTransport(operation);
      if (
        payloadTransport.request.mode !== "opaque_stream" ||
        payloadTransport.response.mode !== "opaque_stream"
      ) {
        throw payloadRepresentationError(
          "payload_policy_conflict",
          "Direct HTTP transit requires opaque_stream request and response modes.",
          409
        );
      }
      if (typeof options.consumeResponse !== "function") {
        throw new TypeError("Native payload transit requires a response consumer.");
      }
      return withTrafficSlot(service, operation, preview, async (traffic, endpoint) => {
        const targetUrl = safeTargetUrl(service, operation, input, endpoint);
        const method = configuredHttpMethod(operation);
        const hasRequestBody = !["GET", "HEAD"].includes(method);
        const credentials = await credentialMaterialFor(service, operation, { targetUrl });
        const representationHeaders = selectRequestRepresentationHeaders(
          input.requestHeaders || {},
          payloadTransport.request,
          { hasBody: hasRequestBody }
        );
        const declaredLength = hasRequestBody && input.contentLength !== null && input.contentLength !== undefined
          ? Number(input.contentLength)
          : null;
        if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > payloadTransport.request.maxBytes) {
          throw payloadRepresentationError("request_body_too_large", "Request body exceeds its published limit.", 413);
        }
        const headers = {
          ...configuredHeaders(service),
          ...credentials.headers,
          ...representationHeaders,
          ...(hasRequestBody && declaredLength !== null && Number.isSafeInteger(declaredLength) && declaredLength >= 0
            ? { "content-length": String(declaredLength) }
            : {}),
          "x-licomesh-gateway-service": service.serviceId
        };
        const startedAt = Date.now();
        const abortContext = createForwardAbortContext(options.signal || null, timeoutFor(operation, options));
        const requestCounter = createPayloadCountingTransform(payloadTransport.request.maxBytes, {
          tooLargeCode: "request_body_too_large",
          tooLargeStatus: 413
        });
        const body = hasRequestBody
          ? (input.requestStream || Readable.from([])).pipe(requestCounter)
          : undefined;
        let pinnedRequest = null;
        try {
          pinnedRequest = await requestConfiguredUpstream(service, targetUrl, {
            method,
            headers,
            body,
            signal: abortContext.signal,
            headersTimeout: timeoutFor(operation, options),
            bodyTimeout: timeoutFor(operation, options)
          }, `upstream-gateway.${service.serviceId}.${operation.operationKey}.stream`);
          const upstreamResponse = pinnedRequest.response;
          const status = Number(upstreamResponse.statusCode || 0);
          const responseHeaders = selectResponseRepresentationHeaders(
            upstreamResponse.headers,
            payloadTransport.response
          );
          const responseDeclaredLength = Number(rawHeader(upstreamResponse.headers, "content-length") || 0);
          if (Number.isFinite(responseDeclaredLength) && responseDeclaredLength > payloadTransport.response.maxBytes) {
            upstreamResponse.body?.destroy?.();
            throw payloadRepresentationError(
              "upstream_response_too_large",
              "Upstream response exceeds its published limit.",
              502
            );
          }
          const responseCounter = createPayloadCountingTransform(payloadTransport.response.maxBytes, {
            tooLargeCode: "upstream_response_too_large",
            tooLargeStatus: 502
          });
          const responseBody = (upstreamResponse.body || Readable.from([])).pipe(responseCounter);
          const cancelResponseBody = () => responseBody.destroy(
            abortContext.signal.reason instanceof Error
              ? abortContext.signal.reason
              : new Error("Upstream response stream was cancelled.")
          );
          abortContext.signal.addEventListener("abort", cancelResponseBody, { once: true });
          try {
            await options.consumeResponse({
              status,
              headers: responseHeaders,
              body: responseBody,
              signal: abortContext.signal
            });
          } finally {
            abortContext.signal.removeEventListener("abort", cancelResponseBody);
          }
          recordEndpointOutcome(service, operation, endpoint, {
            statusCode: status,
            ok: status >= 200 && status < 300
          });
          const audit = appendAudit("upstream.forward.completed", {
            serviceId: service.serviceId,
            operationKey: operation.operationKey,
            protocol: operation.protocol,
            method,
            target: summarizeUrl(targetUrl),
            endpoint: traffic.endpoint,
            circuit: traffic.circuit,
            statusCode: status,
            requestBody: bodyMetadata(undefined, operation.sensitiveBodyFields, {
              byteLength: requestCounter.byteLength,
              contentType: representationHeaders["content-type"] || ""
            }),
            responseBody: bodyMetadata(undefined, operation.sensitiveBodyFields, {
              byteLength: responseCounter.byteLength,
              contentType: responseHeaders["content-type"] || "application/octet-stream"
            }),
            responseBytes: responseCounter.byteLength,
            requestRepresentation: "opaque_stream",
            responseRepresentation: "opaque_stream",
            durationMs: Date.now() - startedAt
          });
          recordMetric({ serviceId: service.serviceId, statusCode: status, failed: status < 200 || status >= 300 });
          persist();
          return Object.freeze({
            ok: status >= 200 && status < 300,
            status,
            requestBytes: requestCounter.byteLength,
            responseBytes: responseCounter.byteLength,
            auditId: audit.auditId
          });
        } catch (error) {
          const callerAborted = abortContext.callerAborted();
          const timedOut = !callerAborted && (abortContext.timedOut() || error?.name === "AbortError");
          const status = callerAborted ? 499 : timedOut ? 504 : error?.status || 502;
          const reasonCode = callerAborted
            ? "upstream_forward_cancelled"
            : timedOut
              ? "upstream_forward_timeout"
              : text(error?.reasonCode || error?.code || "upstream_forward_failed");
          recordEndpointOutcome(service, operation, endpoint, { statusCode: status, ok: false });
          recordMetric({ serviceId: service.serviceId, statusCode: status, failed: true });
          const audit = appendAudit("upstream.forward.failed", {
            serviceId: service.serviceId,
            operationKey: operation.operationKey,
            protocol: operation.protocol,
            method,
            target: summarizeUrl(targetUrl),
            endpoint: traffic.endpoint,
            circuit: traffic.circuit,
            statusCode: status,
            requestBody: bodyMetadata(undefined, operation.sensitiveBodyFields, {
              byteLength: requestCounter.byteLength,
              contentType: representationHeaders["content-type"] || ""
            }),
            reasonCode,
            durationMs: Date.now() - startedAt
          });
          persist();
          throw Object.assign(error instanceof Error ? error : new Error("Upstream payload transit failed."), {
            status,
            reasonCode,
            audit
          });
        } finally {
          await pinnedRequest?.close?.().catch?.(() => {});
          abortContext.dispose();
        }
      });
    },
    async openArtifactDownload({ artifactId = "", range = "" } = {}, subject = {}) {
      const port = requireArtifactTransitPort();
      const reference = `artifact:${String(artifactId || "").trim()}`;
      const metadata = await port.resolve(reference, subject, "download");
      const total = Number(metadata.byteLength || 0);
      let start = 0;
      let end = Math.max(0, total - 1);
      let partial = false;
      const rangeText = String(range || "").trim();
      if (rangeText) {
        const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeText);
        if (!match || (!match[1] && !match[2]) || rangeText.includes(",")) {
          throw payloadRepresentationError("artifact_range_invalid", "Artifact range is invalid.", 416);
        }
        if (!match[1]) {
          const suffix = Number(match[2]);
          if (!Number.isSafeInteger(suffix) || suffix < 1) {
            throw payloadRepresentationError("artifact_range_invalid", "Artifact range is invalid.", 416);
          }
          start = Math.max(0, total - suffix);
        } else {
          start = Number(match[1]);
          end = match[2] ? Number(match[2]) : end;
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= total) {
          throw payloadRepresentationError("artifact_range_invalid", "Artifact range is unsatisfiable.", 416);
        }
        end = Math.min(end, total - 1);
        partial = true;
      }
      const source = await port.openRead(reference, subject, "download", { start, end });
      return Object.freeze({
        status: partial ? 206 : 200,
        headers: Object.freeze({
          "content-type": metadata.mediaType || "application/octet-stream",
          "content-length": String(partial ? end - start + 1 : total),
          "accept-ranges": "bytes",
          ...(partial ? { "content-range": `bytes ${start}-${end}/${total}` } : {})
        }),
        name: metadata.name,
        body: source.open()
      });
    },
    async forward(input = {}, subject = {}, options = {}) {
      const service = requireService(input.serviceId);
      const configuredOperation = operationWithUpstreamCapability(service, operationFor(service, input.operationKey));
      const routingOverrideFields = callerRoutingOverrideFields(input);
      if (routingOverrideFields.length > 0) {
        appendSecurityAlert({
          reasonCode: "upstream_routing_override_denied",
          severity: "critical",
          title: "Upstream gateway caller routing override denied",
          serviceId: service.serviceId,
          operationKey: configuredOperation.operationKey,
          evidence: {
            serviceId: service.serviceId,
            operationKey: configuredOperation.operationKey,
            deniedFields: routingOverrideFields,
            subjectType: subject?.type || "subject"
          }
        });
        rejectUpstreamDestinationOverrideFields(input);
      }
      if (service.disabled) {
        throw Object.assign(new Error("Upstream service is disabled."), { status: 403 });
      }
      if (service.serviceProtocol === "mcp" || configuredOperation.protocol === "mcp") {
        authorizeMcpDiscoverySubject(subject);
      } else {
        authorizeForwardPreview(service, configuredOperation, subject);
      }
      const operation = operationWithUpstreamCapability(service, await resolvedMcpOperationForInput(
        service,
        configuredOperation,
        input,
        options
      ));
      const preview = authorizeForwardPreview(service, operation, subject);
      if (!preview.traffic.allowed) {
        throw Object.assign(new Error("Upstream gateway traffic limit exceeded."), { status: 429, details: preview });
      }
      rejectCallerApprovalOverride(input, service, operation, subject);
      if (operation.requiresApproval && !trustedApprovalForForward(subject, operation)) {
        return pendingApproval(service, operation);
      }
      return withTrafficSlot(service, operation, preview, async (traffic, endpoint) => {
        if (service.serviceProtocol === "mcp" || operation.protocol === "mcp") {
          return forwardMcp(service, operation, input, endpoint, options);
        }
        const payloadTransport = compilePayloadTransport(operation);
        if (
          payloadTransport.request.mode !== "structured_json" ||
          payloadTransport.response.mode !== "structured_json"
        ) {
          return forwardRepresentationOperation({
            service,
            operation,
            input,
            subject,
            options,
            traffic,
            endpoint
          });
        }
        const targetUrl = safeTargetUrl(service, operation, input, endpoint);
        const method = configuredHttpMethod(operation);
        const credentials = await credentialMaterialFor(service, operation, { targetUrl });
        const headers = {
          ...configuredHeaders(service),
          ...credentials.headers,
          "content-type": "application/json",
          "x-licomesh-gateway-service": service.serviceId
        };
        const rpcMethod = operation.protocol === "json-rpc"
          ? configuredRpcMethod(operation)
          : "";
        const bodySource = operation.protocol === "json-rpc"
          ? jsonRpcRequestBody(input, operation, rpcMethod)
          : input.bodyJson !== undefined
            ? input.bodyJson
            : input.body;
        const body = ["GET", "HEAD"].includes(method)
          ? undefined
          : typeof bodySource === "string"
            ? bodySource
            : JSON.stringify(bodySource === undefined ? object(input.payload) : bodySource);
        if (body && Buffer.byteLength(body) > payloadTransport.request.maxBytes) {
          throw payloadRepresentationError(
            "request_body_too_large",
            "Structured request exceeds its published limit.",
            413
          );
        }
        const requestBodyMetadata = bodyMetadata(bodySource === undefined ? object(input.payload) : bodySource, operation.sensitiveBodyFields, {
          byteLength: body ? Buffer.byteLength(body) : 0,
          contentType: "application/json"
        });
        const startedAt = Date.now();
        const requestedTimeoutMs = Number(options.timeoutMs || 0);
        const effectiveTimeoutMs = Number.isSafeInteger(requestedTimeoutMs) && requestedTimeoutMs >= 100
          ? Math.min(operation.timeoutMs, requestedTimeoutMs)
          : operation.timeoutMs;
        const abortContext = createForwardAbortContext(options.signal || null, effectiveTimeoutMs);
        let pinnedFetch = null;
        try {
          pinnedFetch = await fetchConfiguredUpstream(service, targetUrl, {
            method,
            headers,
            body,
            redirect: "manual",
            signal: abortContext.signal
          }, `upstream-gateway.${service.serviceId}.${operation.operationKey}`);
          const response = pinnedFetch.response;
          let buffer;
          try {
            buffer = await readResponseBufferWithLimit(response, payloadTransport.response.maxBytes);
          } catch (error) {
            if (error?.code !== "upstream_response_too_large") throw error;
            recordMetric({ serviceId: service.serviceId, statusCode: response.status, failed: true });
            const audit = appendAudit("upstream.forward.rejected", {
              serviceId: service.serviceId,
              operationKey: operation.operationKey,
              protocol: operation.protocol,
              reason: "response_too_large",
              statusCode: response.status,
              requestBody: requestBodyMetadata,
              responseBody: bodyMetadata(undefined, operation.sensitiveBodyFields, {
                byteLength: error.receivedBytes,
                contentType: response.headers.get("content-type") || "application/octet-stream"
              }),
              responseBytes: error.receivedBytes,
              limitBytes: payloadTransport.response.maxBytes
            });
            persist();
            throw Object.assign(error, { audit });
          }
          recordEndpointOutcome(service, operation, endpoint, {
            statusCode: response.status,
            ok: response.ok
          });
          const contentType = response.headers.get("content-type") || "";
          const responsePolicy = assertResponseBodyPolicy(contentType, buffer, operation);
          const responseBodyMetadata = bodyMetadata(
            /json/i.test(contentType) ? Buffer.from(buffer).toString("utf8") : undefined,
            operation.sensitiveBodyFields,
            {
              byteLength: buffer.byteLength,
              contentType: contentType || "application/octet-stream"
            }
          );
          const audit = appendAudit("upstream.forward.completed", {
            serviceId: service.serviceId,
            operationKey: operation.operationKey,
            protocol: operation.protocol,
              method,
              target: summarizeUrl(targetUrl),
              endpoint: traffic.endpoint,
              circuit: traffic.circuit,
              statusCode: response.status,
            requestBody: requestBodyMetadata,
            responseBody: responseBodyMetadata,
            responsePolicy: {
              schemaValidated: responsePolicy.schemaValidated === true,
              projectionValidated: responsePolicy.projectionValidated === true,
              publicFieldCount: asArray(operation.publicResponseFields).length
            },
            responseBytes: buffer.byteLength,
            durationMs: Date.now() - startedAt
          });
          recordMetric({ serviceId: service.serviceId, statusCode: response.status, failed: !response.ok });
          persist();
          return {
            protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
            ok: response.ok,
            serviceId: service.serviceId,
            operationKey: operation.operationKey,
            dynamicCapability: operation.dynamicCapability,
            upstream: {
              status: response.status,
              endpoint: traffic.endpoint,
              contentType,
              responseBytes: buffer.byteLength,
              durationMs: Date.now() - startedAt
            },
            response: responseBodyForPublic(contentType, buffer, operation.sensitiveBodyFields, operation.publicResponseFields),
            auditId: audit.auditId
          };
        } catch (error) {
          const callerAborted = abortContext.callerAborted();
          const timedOut = !callerAborted && (
            abortContext.timedOut() || error?.name === "AbortError"
          );
          const status = callerAborted ? 499 : timedOut ? 504 : error?.status || 502;
          const reasonCode = callerAborted
            ? "upstream_forward_cancelled"
            : timedOut
              ? "upstream_forward_timeout"
              : text(error?.reasonCode || error?.code || "upstream_forward_failed");
          recordEndpointOutcome(service, operation, endpoint, {
            statusCode: status,
            ok: false
          });
          recordMetric({ serviceId: service.serviceId, statusCode: status, failed: true });
          const audit = error?.audit || appendAudit("upstream.forward.failed", {
            serviceId: service.serviceId,
            operationKey: operation.operationKey,
            protocol: operation.protocol,
            method,
            target: summarizeUrl(targetUrl),
            endpoint: traffic.endpoint,
            circuit: traffic.circuit,
            statusCode: status,
            requestBody: requestBodyMetadata,
            reasonCode,
            durationMs: Date.now() - startedAt
          });
          persist();
          const publicError = callerAborted
            ? new Error("Upstream gateway request was cancelled.")
            : timedOut
              ? new Error("Upstream gateway request timed out.")
              : error instanceof Error
                ? error
                : new Error("Upstream gateway forwarding failed.");
          throw Object.assign(publicError, {
            status,
            reasonCode,
            audit
          });
        } finally {
          await pinnedFetch?.close?.().catch?.(() => {});
          abortContext.dispose();
        }
      });
    },
    listAudit(input = {}) {
      refreshRuntimeStateFromDisk();
      const serviceId = text(input.serviceId || "");
      const limit = Math.max(1, Math.min(Number(input.limit || 100), 500));
      const items = auditEvents
        .filter((event) => !serviceId || event.serviceId === serviceId)
        .slice(-limit)
        .reverse();
      return {
        protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
        items: clone(items),
        count: items.length
      };
    },
    getMetrics() {
      refreshRuntimeStateFromDisk();
      return {
        protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
        ...clone(metrics),
        boundedRuntimeState: {
          trafficBucketCount: trafficBuckets.size,
          endpointCursorCount: endpointCursors.size,
          endpointCircuitCount: endpointCircuits.size,
          mcpToolCacheCount: mcpToolCache.size
        }
      };
    },
    isClosed() {
      return closed;
    },
    getManifestSnapshotRevision() {
      return manifestSnapshotRevision;
    },
    captureManifestSnapshotState() {
      return Object.freeze({
        setRevision: manifestSnapshotRevision.sourceRevision,
        setDigest: manifestSnapshotRevision.sourceDigest,
        serviceEntries: Object.freeze([...services.entries()].map(([serviceId, service]) => Object.freeze([serviceId, service]))),
        projectedOperationTargets: Object.freeze([...projectedOperationTargets.entries()].map(([operationId, target]) => Object.freeze([operationId, target])))
      });
    },
    restoreManifestSnapshotState(state) {
      if (!state || !Array.isArray(state.serviceEntries) || !Array.isArray(state.projectedOperationTargets)) {
        throw new TypeError("Upstream gateway manifest snapshot rollback state is invalid.");
      }
      services = new Map(state.serviceEntries);
      projectedOperationTargets = new Map(state.projectedOperationTargets);
      manifestSnapshotRevision = Object.freeze({
        sourceRevision: Number.isSafeInteger(state.setRevision) ? state.setRevision : 0,
        sourceDigest: String(state.setDigest || "")
      });
      trafficBuckets.clear();
      endpointCursors.clear();
      endpointCircuits.clear();
      mcpToolCache.clear();
      return { ok: true };
    },
    replaceFromManifestSnapshot(snapshot, { deferSideEffects = false } = {}) {
      const entries = snapshot?.serviceEntries ||
        (snapshot?.services instanceof Map ? [...snapshot.services.entries()] : null);
      if (!Array.isArray(entries) || !Number.isSafeInteger(snapshot.setRevision)) {
        throw new TypeError("Upstream gateway manifest snapshot is invalid.");
      }
      const next = new Map(entries);
      if (next.size !== entries.length) {
        throw new TypeError("Upstream gateway manifest snapshot contains duplicate service identities.");
      }
      const nextProjectedTargets = new Map();
      for (const [serviceId, service] of next) {
        if (service.disabled === true) continue;
        for (const operation of service.operations || []) {
          const operationId = upstreamProjectedOperationId(serviceId, operation.operationKey);
          if (nextProjectedTargets.has(operationId)) {
            throw new TypeError("Upstream gateway manifest snapshot contains duplicate projected operations.");
          }
          nextProjectedTargets.set(operationId, Object.freeze({ serviceId, operationKey: operation.operationKey }));
        }
      }
      const added = [];
      const updated = [];
      const removed = [];
      for (const [serviceId, service] of next) {
        const existing = services.get(serviceId);
        if (!existing) added.push(serviceId);
        else if (existing.manifestDigest !== service.manifestDigest || existing.serviceRevision !== service.serviceRevision) updated.push(serviceId);
      }
      for (const serviceId of services.keys()) {
        if (!next.has(serviceId)) removed.push(serviceId);
      }
      services = next;
      projectedOperationTargets = nextProjectedTargets;
      manifestSnapshotRevision = Object.freeze({
        sourceRevision: snapshot.setRevision,
        sourceDigest: snapshot.setDigest
      });
      clearServiceRuntimeState([...updated, ...removed]);
      const diff = Object.freeze({
        setRevision: snapshot.setRevision,
        setDigest: snapshot.setDigest,
        added: Object.freeze(added),
        updated: Object.freeze(updated),
        removed: Object.freeze(removed)
      });
      if (!deferSideEffects) {
        void this.finalizeManifestSnapshot(diff);
      }
      return diff;
    },
    async finalizeManifestSnapshot(diff) {
      if (!diff || !Array.isArray(diff.updated) || !Array.isArray(diff.removed)) {
        throw new TypeError("Upstream gateway manifest snapshot finalization diff is invalid.");
      }
      retireEndpointTrafficServices([...diff.updated, ...diff.removed]);
      const results = [];
      for (const serviceId of diff.updated) {
        try {
          results.push(await upstreamMcpSessions.retireScope?.(serviceId));
        } catch {
          results.push(Object.freeze({ retired: 0, deferred: true }));
        }
      }
      for (const serviceId of diff.removed) {
        try {
          results.push(await upstreamMcpSessions.retireScope?.(serviceId, { remove: true }));
        } catch {
          results.push(Object.freeze({ retired: 0, removed: false, deferred: true }));
        }
      }
      return Object.freeze({
        finalized: true,
        updated: diff.updated.length,
        removed: diff.removed.length,
        retirements: Object.freeze(results)
      });
    },
    async forwardProjectedOperation(operationId, input = {}, subject = {}, options = {}) {
      const target = projectedOperationTargets.get(String(operationId || ""));
      if (!target) {
        throw Object.assign(new Error("Projected upstream operation was not found."), { status: 404 });
      }
      return this.forward({ ...input, ...target }, subject, options);
    },
    async close() {
      if (closed) return;
      if (closePromise) return closePromise;
      closePromise = (async () => {
        let closeFailed = false;
        try {
          await upstreamMcpSessions.close();
        } catch {
          closeFailed = true;
        }
        try {
          await securityAlertStore?.close?.();
        } catch {
          closeFailed = true;
        }
        if (closeFailed) {
          throw new Error("Upstream gateway registry did not close cleanly.");
        }
        closed = true;
      })();
      try {
        await closePromise;
      } catch (error) {
        closePromise = null;
        throw error;
      }
    }
  };
}
