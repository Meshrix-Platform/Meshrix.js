import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { evaluateUniversalTagPolicy, hasUniversalTagPolicyRules } from "@meshrix/foundation/security/authorization/universal-tag-policy";
import {
  claimFinalProtectedSinkAttempt,
  digestFinalProtectedSinkInput
} from "@meshrix/foundation/security/final-protected-sink-permit";
import { createSecurityAlertStore } from "@meshrix/foundation/security/security-alerts";
import { fetchWithPinnedDns, requestWithPinnedDns } from "@meshrix/foundation/security/outbound-egress-policy";
import { createUpstreamMcpSessionManager } from "@meshrix/protocols/mcp/upstream-mcp-client";
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
} from "./support.ts";
import { publicUpstreamMcpTool, publicUpstreamOperationTool } from "./tool-projection.ts";
import { resolveCredentialMaterial, resolveMcpServiceConfigWithCredentials } from "./credential-material.ts";
import { createGatewayRuntime } from "./registry-runtime.ts";
import {
  assertResponseBodyPolicy,
  bodyMetadata,
  readAsyncBodyBufferWithLimit,
  readResponseBufferWithLimit
} from "./response-policy.ts";
import { publicTagPolicyDecision } from "./tag-policy-decision.ts";
import { createEndpointTrafficController } from "./endpoint-traffic.ts";
import { callerApprovalOverrideFields, pendingApproval, trustedApprovalForForward } from "./approval.ts";
import { compileUpstreamOperationCapability, evaluateDynamicOperationAuthorization, operationWithUpstreamCapability } from "./operation-capability.ts";
import { createMcpForwarder } from "./mcp-forwarder.ts";
import { constructWithOwnedResourceCleanup, createForwardAbortContext } from "./registry-lifecycle.ts";
import { fingerprint } from "./manifest-compiler.ts";
import { upstreamProjectedOperationId } from "./operation-projection.ts";
import { createUpstreamManifestSnapshotCommitter } from "./manifest-snapshot-commit.ts";
import { evaluateAudienceDecision } from "./audience-projection.ts";
import {
  assertDeclaredSha256Digest,
  compilePayloadTransport,
  createPayloadCountingTransform,
  payloadRepresentationError,
  selectRequestRepresentationHeaders,
  selectResponseRepresentationHeaders
} from "./payload-contract.ts";
import { createArtifactBodySource, createMultipartBodyStream } from "./multipart-stream.ts";

const PROJECTED_PROVIDER_INPUT: any = Symbol(
  "meshrix.upstream-gateway.projected-provider-input"
);

export { UPSTREAM_GATEWAY_PROTOCOL_VERSION } from "./support.ts";
export { fingerprint } from "./manifest-compiler.ts";
export { createUpstreamManifestObserver } from "./manifest-observer.ts";
export {
  createUpstreamPublishingApplication,
  UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION
} from "./publishing-application.ts";
export {
  compileUpstreamOperationProjection,
  upstreamProjectedOperationId
} from "./operation-projection.ts";
export {
  AUDIENCE_PUBLICATION_SCHEMA_VERSION,
  AUDIENCE_PUBLICATION_TOPIC,
  compileAudienceProjection,
  createAudiencePublicationEvent,
  evaluateAudienceDecision,
  evaluateAudienceParity,
  opaqueAudiencePartitionKey
} from "./audience-projection.ts";
export { createUpstreamManifestSnapshotCommitter } from "./manifest-snapshot-commit.ts";
export function createUpstreamGatewayRegistry({
  userDataPath = "",
  tagStore = null,
  securityPermissions = null,
  mcpSessionManager = null,
  artifactTransitPort = null,
  secretKeyProvider = null,
  publishSkillHubUpdate = null,
  claimProtectedSinkAttempt = claimFinalProtectedSinkAttempt
}: Record<string, any> = {}) : any {
  const persistenceEnabled: any = Boolean(userDataPath);
  const filePath: any = persistenceEnabled ? runtimePath(userDataPath) : "";
  let services: any = new Map<any, any>();
  let projectedOperationTargets: any = new Map<any, any>();
  let mcpServicesByPublicPrefix: any = new Map<any, any>();
  let configuredOperationsByPublicName: any = new Map<any, any>();
  let manifestSnapshotRevision: Readonly<Record<string, any>> = Object.freeze({ sourceRevision: 0, sourceDigest: "" });
  const trafficBuckets: any = new Map<any, any>();
  const endpointCursors: any = new Map<any, any>();
  const endpointCircuits: any = new Map<any, any>();
  const mcpToolCache: any = new Map<any, any>();
  const skillHubEventSubscriptions: any = new Map<any, any>();
  let targetedCallMapHits: any = 0;
  let targetedServiceIndexHits: any = 0;
  let serviceDiscoveryCount: any = 0;

  function compilePublicToolTargetIndexes(serviceMap: Map<any, any>) : any {
    const mcpByPrefix: any = new Map<any, any>();
    const configuredByName: any = new Map<any, any>();
    for (const service of serviceMap.values()) {
      if (service.disabled === true) continue;
      if (service.serviceProtocol === "mcp") {
        const prefix: any = service.mcp?.toolNamePrefix || safePublicToolSegment(service.serviceId);
        if (mcpByPrefix.has(prefix)) {
          throw new TypeError("Upstream gateway manifest snapshot contains duplicate MCP tool prefixes.");
        }
        mcpByPrefix.set(prefix, service);
        continue;
      }
      for (const operation of asArray(service.operations)) {
        if (!operation?.operationKey) continue;
        const publicName: any = `upstream.${safePublicToolSegment(service.serviceId)}.${safePublicToolSegment(operation.operationKey)}`;
        if (configuredByName.has(publicName)) {
          throw new TypeError("Upstream gateway manifest snapshot contains duplicate public tool names.");
        }
        configuredByName.set(publicName, Object.freeze({ service, operation }));
      }
    }
    return Object.freeze({ mcpByPrefix, configuredByName });
  }

  function clearServiceRuntimeState(serviceIds: any = []) : any {
    const prefixes: any = asArray(serviceIds).map((serviceId?: any) : any => `${serviceId}::`);
    if (prefixes.length === 0) return;
    for (const serviceId of asArray(serviceIds).map(text).filter(Boolean)) {
      const subscription: any = skillHubEventSubscriptions.get(serviceId);
      if (subscription) {
        subscription.controller.abort();
        skillHubEventSubscriptions.delete(serviceId);
      }
    }
    for (const stateMap of [trafficBuckets, endpointCursors, endpointCircuits, mcpToolCache]) {
      for (const key of stateMap.keys()) {
        if (prefixes.some((prefix?: any) : any => String(key).startsWith(prefix))) stateMap.delete(key);
      }
    }
  }
  const securityAlertStore: any = persistenceEnabled
    ? createSecurityAlertStore({ userDataPath })
    : null;
  let closed: any = false;
  let closePromise: any = null;
  const resolvedTagStore: any =
    tagStore ||
    securityPermissions?.tagManagementStore ||
    null;
  const gatewayRuntime: any = constructWithOwnedResourceCleanup(
    securityAlertStore,
    () : any => createGatewayRuntime({
      persistenceEnabled,
      filePath,
      securityAlertStore
    })
  );
  const {
    auditEvents,
    metrics,
    appendAudit,
    appendSecurityAlert,
    recordMetric,
    persist,
    close: closeGatewayRuntime,
    getRefactorInstrumentation
  } = gatewayRuntime;
  const {
    endpointsFor,
    publicEndpoint,
    recordEndpointOutcome,
    retireServices: retireEndpointTrafficServices,
    selectEndpointTraffic,
    withTrafficSlot
  } = constructWithOwnedResourceCleanup(
    securityAlertStore,
    () : any => createEndpointTrafficController({
      trafficBuckets,
      endpointCursors,
      endpointCircuits,
      appendAudit,
      recordMetric,
      persist
    })
  );
  const upstreamMcpSessions: any = mcpSessionManager || createUpstreamMcpSessionManager({
    fetchTransport: fetchConfiguredMcpUpstream
  });
  const forwardMcp: any = constructWithOwnedResourceCleanup(
    securityAlertStore,
    () : any => createMcpForwarder({
      appendAudit,
      mcpSessionManager: upstreamMcpSessions,
      mcpServiceConfigWithCredentials,
      persist,
      publicEndpoint,
      recordEndpointOutcome,
      recordMetric
    })
  );

  function upstreamEgressPolicies(service?: any) : any {
    return {
      egress: {
        allowLocalForConfiguredModelService: service.allowLocalNetwork === true
      }
    };
  }

  function fetchConfiguredUpstream(service?: any, url?: any, init?: any, label?: any) : any {
    return fetchWithPinnedDns({
      url,
      label,
      policies: upstreamEgressPolicies(service),
      init
    });
  }

  function requestConfiguredUpstream(service?: any, url?: any, init?: any, label?: any) : any {
    return requestWithPinnedDns({
      url,
      label,
      policies: upstreamEgressPolicies(service),
      init
    });
  }

  function fetchConfiguredMcpUpstream(url?: any, init?: any, { config = {} }: Record<string, any> = {}) : any {
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

  function requireService(serviceId?: any) : any {
    const service: any = services.get(text(serviceId));
    if (!service) {
      throw new Error(`Upstream service not found: ${serviceId}`);
    }
    return service;
  }
  function operationFor(service?: any, operationKey: any = "") : any {
    const key: any = text(operationKey || "default");
    const operation: any = asArray(service.operations).find((item?: any) : any => item.operationKey === key) ||
      asArray(service.operations)[0];
    if (!operation) {
      throw new Error(`Upstream operation not found: ${key}`);
    }
    return operation;
  }

  function sha256Canonical(value?: any) : any {
    return createHash("sha256")
      .update(canonicalJson(value))
      .digest("hex");
  }

  function finalEffectAuthorityRequired() : any {
    throw Object.assign(
      new Error("A final upstream effect authority is required."),
      {
        code: "upstream_final_effect_authority_required",
        reasonCode: "upstream_final_effect_authority_required",
        status: 403,
        statusCode: 403
      }
    );
  }

  function structuredTargetFacts({
    service,
    operation,
    input,
    endpoint,
    inputDigest
  }: Record<string, any>) : any {
    const targetUrl: any = safeTargetUrl(service, operation, input, endpoint);
    const method: any = configuredHttpMethod(operation);
    const protocol: any = text(operation.protocol || "http").toLowerCase();
    const rpcMethod: any = protocol === "json-rpc"
      ? configuredRpcMethod(operation)
      : "";
    const endpointIdentity: Readonly<Record<string, any>> = Object.freeze({
      endpointId: text(endpoint?.endpointId || "primary"),
      baseUrl: text(endpoint?.baseUrl || service.baseUrl)
    });
    const targetTuple: Readonly<Record<string, any>> = Object.freeze({
      schemaVersion:
        "v0.0.1:upstream-gateway:structured-final-effect-target-1",
      serviceId: service.serviceId,
      operationKey: operation.operationKey,
      protocol,
      method,
      rpcMethod,
      targetUrl: targetUrl.toString(),
      endpoint: endpointIdentity,
      manifestSetRevision: manifestSnapshotRevision.sourceRevision,
      manifestSetDigest: manifestSnapshotRevision.sourceDigest,
      serviceRevision: service.serviceRevision,
      manifestDigest: service.manifestDigest
    });
    const resourceRevision: any = sha256Canonical({
      schemaVersion:
        "v0.0.1:upstream-gateway:structured-resource-revision-1",
      manifestSetRevision: targetTuple.manifestSetRevision,
      manifestSetDigest: targetTuple.manifestSetDigest,
      serviceRevision: targetTuple.serviceRevision,
      manifestDigest: targetTuple.manifestDigest
    });
    return Object.freeze({
      targetUrl,
      method,
      protocol,
      rpcMethod,
      targetSelector: Object.freeze({
        inputDigest,
        operationKey: operation.operationKey,
        serviceId: service.serviceId
      }),
      effect: Object.freeze({
        kind: "upstream-http-request",
        targetDigest: sha256Canonical(targetTuple)
      }),
      resourceRevision
    });
  }

  function currentStructuredTargetFacts({
    serviceId,
    operationKey,
    endpointId,
    input,
    inputDigest
  }: Record<string, any>) : any {
    const currentService: any = services.get(text(serviceId));
    if (!currentService || currentService.disabled === true) {
      throw Object.assign(
        new Error("The current upstream service is unavailable."),
        { code: "upstream_final_effect_resource_stale", statusCode: 403 }
      );
    }
    const currentOperation: any = asArray(currentService.operations).find(
      (candidate?: any) : any => candidate.operationKey === operationKey
    );
    if (
      !currentOperation ||
      currentService.serviceProtocol === "mcp" ||
      currentOperation.protocol === "mcp"
    ) {
      throw Object.assign(
        new Error("The current upstream operation is unavailable."),
        { code: "upstream_final_effect_resource_stale", statusCode: 403 }
      );
    }
    const currentEndpoint: any = endpointsFor(currentService).find(
      (candidate?: any) : any =>
        text(candidate.endpointId || "primary") === text(endpointId || "primary")
    );
    if (!currentEndpoint) {
      throw Object.assign(
        new Error("The current upstream endpoint is unavailable."),
        { code: "upstream_final_effect_resource_stale", statusCode: 403 }
      );
    }
    return structuredTargetFacts({
      service: currentService,
      operation: operationWithUpstreamCapability(
        currentService,
        currentOperation
      ),
      input,
      endpoint: currentEndpoint,
      inputDigest
    });
  }

  function previewFor(service?: any, operation?: any, subject: Record<string, any> = {}) : any {
    const { traffic } = selectEndpointTraffic(service, operation, { consume: false });
    const subjectScopes: any = new Set<any>(asArray(subject.scopes).map(text));
    const roleId: any = text(subject.roleId || subject.role || "");
    const bypass: any = ["owner", "admin"].includes(roleId) ||
      ["auth:admin", "runtime:admin", "gateway:admin"].some((scope?: any) : any => subjectScopes.has(scope));
    const missingScopes: any = bypass ? [] : operation.requiredScopes.filter((scope?: any) : any => !subjectScopes.has(scope));
    const tagPolicy: any = evaluateServiceTagPolicy(service, subject);
    const dynamicAuthorization: any = evaluateDynamicOperationAuthorization(subject, operation);
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

  function uniqueEntityRefs(values: any = []) : any {
    const seen: any = new Set<any>();
    const output: any[] = [];
    for (const entry of asArray(values)) {
      const entityType: any = text(entry?.entityType || entry?.type);
      const entityId: any = text(entry?.entityId || entry?.id);
      if (!entityType || !entityId) continue;
      const key: any = `${entityType}\0${entityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({ entityType, entityId });
    }
    return output;
  }

  function evaluateServiceTagPolicy(service?: any, subject: Record<string, any> = {}) : any {
    if (!hasUniversalTagPolicyRules(service.tagPolicy || {})) {
      return {
        allowed: true,
        public: {
          enabled: false,
          allowed: true
        }
      };
    }
    const configuredEntityRefs: any[] = asArray(
      service.tagPolicy?.entityRefs || service.tagPolicy?.entities
    );
    const callerSubjectId: any = text(subject.subjectId || subject.workloadPrincipalId || subject.id);
    const subjectEntityRefs: any[] = [
      callerSubjectId ? { entityType: "subject", entityId: callerSubjectId } : null,
      (subject.organizationNodeId || subject.organizationId)
        ? { entityType: "organization", entityId: subject.organizationNodeId || subject.organizationId }
        : null,
      subject.teamId ? { entityType: "team", entityId: subject.teamId } : null,
      subject.roleId ? { entityType: "role", entityId: subject.roleId } : null
    ].filter(Boolean);
    // Discovery evaluates caller identity first. A publishing descriptor may also
    // persist a default service entityRef; that must not replace caller audience.
    const entityRefs: any[] = uniqueEntityRefs([...subjectEntityRefs, ...configuredEntityRefs]);
    const decision: any = evaluateUniversalTagPolicy({
      tagStore: resolvedTagStore,
      ...service.tagPolicy,
      entityRefs
    });
    return {
      allowed: decision.allowed === true,
      decision,
      public: publicTagPolicyDecision(decision)
    };
  }

  function rejectServiceTagPolicy(service?: any, operation?: any, decision: Record<string, any> = {}) : any {
    recordMetric({ serviceId: service.serviceId, statusCode: 403, failed: true });
    const audit: any = appendAudit("upstream.tag_policy.denied", {
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

  function rejectCallerApprovalOverride(input: Record<string, any> = {}, service?: any, operation?: any, subject: Record<string, any> = {}) : any {
    const deniedFields: any = callerApprovalOverrideFields(input);
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

  function authorizeForwardPreview(service?: any, operation?: any, subject?: any) : any {
    const preview: any = previewFor(service, operation, subject);
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
      rejectServiceTagPolicy(service, operation, evaluateServiceTagPolicy(service, subject).decision);
    }
    return preview;
  }

  function authorizeMcpDiscoverySubject(subject: Record<string, any> = {}) : any {
    const scopes: any = new Set<any>(asArray(subject.scopes).map(text).filter(Boolean));
    if (["gateway:admin", "gateway:read", "gateway:write"].some((scope?: any) : any => scopes.has(scope))) return;
    throw Object.assign(new Error("Upstream MCP discovery scope denied."), {
      status: 403,
      reasonCode: "upstream_mcp_discovery_scope_denied"
    });
  }

  async function credentialMaterialFor(service?: any, operation: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
    return resolveCredentialMaterial({
      userDataPath,
      service,
      operation,
      secretKeyProvider,
      ...object(options)
    });
  }

  async function mcpServiceConfigWithCredentials(service?: any, operation: Record<string, any> = {}) : Promise<any> {
    return resolveMcpServiceConfigWithCredentials({
      userDataPath,
      service,
      operation,
      secretKeyProvider
    });
  }

  function eventDelay(milliseconds?: any, signal?: any) : any {
    return new Promise((resolve?: any) : any => {
      if (signal?.aborted) return resolve(null);
      const timer: any = setTimeout(resolve, milliseconds);
      timer.unref?.();
      signal?.addEventListener?.("abort", () : any => {
        clearTimeout(timer);
        resolve(null);
      }, { once: true });
    });
  }

  async function ensureSkillHubEventSubscription(service?: any, operation: Record<string, any> = {}) : Promise<any> {
    if (typeof publishSkillHubUpdate !== "function" || skillHubEventSubscriptions.has(service.serviceId)) return;
    const controller: any = new AbortController();
    const state: Record<string, any> = { controller, cursor: 0, ready: null, promise: null };
    skillHubEventSubscriptions.set(service.serviceId, state);
    let resolveReady: any;
    state.ready = new Promise((resolve?: any) : any => { resolveReady = resolve; });
    state.promise = (async () : Promise<any> => {
      let retryMs: any = 250;
      let firstAttempt = true;
      while (!controller.signal.aborted) {
        let pinnedFetch: any = null;
        try {
          const endpoint: any = endpointsFor(service)[0];
          const targetUrl: any = safeTargetUrl(service, { path: `/v1/events?cursor=${state.cursor}` }, {}, endpoint);
          const credentials: any = await credentialMaterialFor(service, operation, { targetUrl });
          pinnedFetch = await fetchConfiguredUpstream(service, targetUrl, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: { ...configuredHeaders(service), ...credentials.headers }
          }, `upstream-gateway.${service.serviceId}.events`);
          const response: any = pinnedFetch.response;
          if (!response.ok || !response.body) throw new Error("Skill Hub event subscription failed.");
          if (firstAttempt) { firstAttempt = false; resolveReady(true); }
          retryMs = 250;
          let buffer: any = "";
          const decoder: any = new TextDecoder();
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            if (Buffer.byteLength(buffer, "utf8") > 64 * 1024) throw new Error("Skill Hub event frame limit exceeded.");
            let separator: any;
            while ((separator = /\r?\n\r?\n/u.exec(buffer))) {
              const boundary: any = separator.index;
              const frame: any = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + separator[0].length);
              const data: any = frame.split(/\r?\n/u)
                .filter((line?: any) : any => line.startsWith("data:"))
                .map((line?: any) : any => line.slice(5).trimStart())
                .join("\n");
              if (!data) continue;
              const event: any = JSON.parse(data);
              if (event?.eventType !== "skill-hub.catalog.changed" || !Number.isSafeInteger(event?.eventId) ||
                  event.eventId <= state.cursor || !/^skill_hub\.[a-z][a-z0-9.]*$/u.test(String(event?.operationId || ""))) continue;
              state.cursor = event.eventId;
              publishSkillHubUpdate(Object.freeze({
                schemaVersion: "v0.0.1:meshrix:skill-hub-update-1",
                revision: event.serviceRevision,
                operationId: event.operationId
              }));
            }
          }
        } catch {
          if (firstAttempt) { firstAttempt = false; resolveReady(false); }
          if (controller.signal.aborted) break;
        } finally {
          await pinnedFetch?.close?.().catch?.(() : any => {});
        }
        await eventDelay(retryMs, controller.signal);
        retryMs = Math.min(retryMs * 2, 10_000);
      }
    })();
    await state.ready;
  }

  function requireArtifactTransitPort() : any {
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

  function rawHeader(headers: Record<string, any> = {}, name: any = "") : any {
    const value: any = headers?.[name.toLowerCase()];
    return Array.isArray(value) ? String(value[0] || "") : String(value || "");
  }

  function artifactNameFromHeaders(headers: Record<string, any> = {}) : any {
    const disposition: any = rawHeader(headers, "content-disposition");
    const encoded: any = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
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

  function requestArguments(input: Record<string, any> = {}) : any {
    return object(input.arguments || input.params || input.payload || input.body);
  }

  function timeoutFor(operation?: any, options: Record<string, any> = {}) : any {
    const requestedTimeoutMs: any = Number(options.timeoutMs || 0);
    return Number.isSafeInteger(requestedTimeoutMs) && requestedTimeoutMs >= 100
      ? Math.min(operation.timeoutMs, requestedTimeoutMs)
      : operation.timeoutMs;
  }

  async function requestBodySourceFor(operation?: any, input?: any, subject?: any, readAccess: Record<string, any> = {}) : Promise<any> {
    const transport: any = compilePayloadTransport(operation);
    const requestPolicy: any = transport.request;
    if (requestPolicy.mode === "artifact_body") {
      const argumentsValue: any = requestArguments(input);
      return createArtifactBodySource({
        reference: argumentsValue[requestPolicy.artifactArgument],
        artifactPort: requireArtifactTransitPort(),
        subject,
        readAccess,
        maxBytes: requestPolicy.maxBytes
      });
    }
    if (requestPolicy.mode === "artifact_multipart") {
      return createMultipartBodyStream({
        mapping: requestPolicy.multipart,
        fields: requestArguments(input),
        artifactPort: requireArtifactTransitPort(),
        subject,
        readAccess,
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
    const rpcMethod: any = operation.protocol === "json-rpc"
      ? configuredRpcMethod(operation)
      : "";
    const source: any = operation.protocol === "json-rpc"
      ? jsonRpcRequestBody(input, operation, rpcMethod)
      : input.bodyJson !== undefined
        ? input.bodyJson
        : input.body === undefined
          ? object(input.payload)
          : input.body;
    const bytes: any = Buffer.from(typeof source === "string" ? source : JSON.stringify(source), "utf8");
    if (bytes.byteLength > requestPolicy.maxBytes) {
      throw payloadRepresentationError("request_body_too_large", "Structured request exceeds its published limit.", 413);
    }
    return Object.freeze({
      contentType: "application/json",
      contentLength: bytes.byteLength,
      replayable: true,
      metadata: null,
      openBody: () : any => Readable.from([bytes]),
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
  }: Record<string, any>) : Promise<any> {
    const transport: any = compilePayloadTransport(operation);
    const targetUrl: any = safeTargetUrl(service, operation, input, endpoint);
    const method: any = configuredHttpMethod(operation);
    const credentials: any = await credentialMaterialFor(service, operation, { targetUrl });
    const sinkInput: any = clone(input);
    const providerInput: any = input?.[PROJECTED_PROVIDER_INPUT];
    const sinkInputDigest: any = digestFinalProtectedSinkInput(
      providerInput ? clone(providerInput) : sinkInput
    );
    const targetFacts: any = structuredTargetFacts({
      service,
      operation,
      input: sinkInput,
      endpoint,
      inputDigest: sinkInputDigest
    });
    const finalProtectedSinkPermit: any = options.finalProtectedSinkPermit;
    if (!finalProtectedSinkPermit && claimProtectedSinkAttempt === claimFinalProtectedSinkAttempt) {
      finalEffectAuthorityRequired();
    }
    const governedExecutionReceipt: any = await claimProtectedSinkAttempt({
      attempt: finalProtectedSinkPermit,
      targetSelector: targetFacts.targetSelector,
      effect: targetFacts.effect,
      resourceRevision: targetFacts.resourceRevision,
      resolveCurrentResource: async () : Promise<any> => {
        const currentFacts: any = currentStructuredTargetFacts({
          serviceId: service.serviceId,
          operationKey: operation.operationKey,
          endpointId: endpoint?.endpointId || "primary",
          input: sinkInput,
          inputDigest: sinkInputDigest
        });
        return Object.freeze({
          effect: currentFacts.effect,
          resourceRevision: currentFacts.resourceRevision
        });
      }
    });
    const source: any = ["GET", "HEAD"].includes(method)
      ? null
      : await requestBodySourceFor(operation, input, subject, {
          governedExecutionReceipt,
          signal: options.signal || null
        });
    const headers: Record<string, any> = {
      ...configuredHeaders(service),
      ...credentials.headers,
      ...(source?.contentType ? { "content-type": source.contentType } : {}),
      ...(Number.isSafeInteger(source?.contentLength) ? { "content-length": String(source.contentLength) } : {}),
      "x-meshrix-gateway-service": service.serviceId
    };
    const requestBodyMetadata: any = bodyMetadata(
      source?.structuredValue,
      operation.sensitiveBodyFields,
      {
        byteLength: Number(source?.contentLength || 0),
        contentType: source?.contentType || ""
      }
    );
    const startedAt: any = Date.now();
    const abortContext: any = createForwardAbortContext(options.signal || null, timeoutFor(operation, options));
    let pinnedRequest: any = null;
    let artifactTransaction: any = null;
    try {
      pinnedRequest = await requestConfiguredUpstream(service, targetUrl, {
        method,
        headers,
        body: source?.openBody?.(),
        signal: abortContext.signal,
        headersTimeout: timeoutFor(operation, options),
        bodyTimeout: timeoutFor(operation, options)
      }, `upstream-gateway.${service.serviceId}.${operation.operationKey}.payload`);
      const response: any = pinnedRequest.response;
      const status: any = Number(response.statusCode || 0);
      const contentType: any = rawHeader(response.headers, "content-type") || "application/octet-stream";
      const responseHeaders: any = selectResponseRepresentationHeaders(response.headers, transport.response);
      const declaredLength: any = Number(rawHeader(response.headers, "content-length") || 0);
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
        const buffer: any = await readAsyncBodyBufferWithLimit(
          response.body || Readable.from([]),
          response.headers,
          transport.response.maxBytes
        );
        assertDeclaredSha256Digest(
          responseHeaders,
          createHash("sha256").update(buffer).digest("hex"),
          "response"
        );
        const responsePolicy: any = assertResponseBodyPolicy(contentType, buffer, operation);
        const audit: any = appendAudit("upstream.forward.completed", {
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
      const artifactResponse: any = transport.response.mode === "artifact" || options.responseAdapter === "artifact";
      if (!artifactResponse) {
        response.body?.destroy?.();
        throw payloadRepresentationError(
          "opaque_response_requires_stream",
          "Opaque responses require native HTTP transit or the artifact response adapter.",
          409
        );
      }
      const artifactPort: any = requireArtifactTransitPort();
      artifactTransaction = await artifactPort.beginWrite(subject, {
        name: artifactNameFromHeaders(response.headers),
        mediaType: contentType
      }, {
        maxBytes: transport.response.maxBytes
      });
      const counter: any = createPayloadCountingTransform(transport.response.maxBytes, {
        tooLargeCode: "upstream_response_too_large",
        tooLargeStatus: 502
      });
      await pipeline(
        response.body || Readable.from([]),
        counter,
        artifactTransaction.writable,
        { signal: abortContext.signal }
      );
      assertDeclaredSha256Digest(responseHeaders, counter.sha256, "response");
      const resource: any = await artifactPort.commit(artifactTransaction, {
        byteLength: counter.byteLength,
        sha256: counter.sha256
      });
      artifactTransaction = null;
      const audit: any = appendAudit("upstream.forward.completed", {
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
    } catch (error: any) {
      if (artifactTransaction) {
        await artifactTransitPort.abort(artifactTransaction, String(error?.code || "artifact_write_aborted")).catch(() : any => {});
      }
      const callerAborted: any = abortContext.callerAborted();
      const timedOut: any = !callerAborted && (abortContext.timedOut() || error?.name === "AbortError");
      const status: any = callerAborted ? 499 : timedOut ? 504 : error?.status || 502;
      const reasonCode: any = callerAborted
        ? "upstream_forward_cancelled"
        : timedOut
          ? "upstream_forward_timeout"
          : text(error?.reasonCode || error?.code || "upstream_forward_failed");
      recordEndpointOutcome(service, operation, endpoint, { statusCode: status, ok: false });
      recordMetric({ serviceId: service.serviceId, statusCode: status, failed: true });
      const audit: any = appendAudit("upstream.forward.failed", {
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
      await pinnedRequest?.close?.().catch?.(() : any => {});
      abortContext.dispose();
    }
  }

  async function listMcpToolsForService(service?: any, {
    refresh = false,
    signal = null,
    onNotification = null
  }: Record<string, any> = {}) : Promise<any> {
    if (service.serviceProtocol !== "mcp") {
      return [];
    }
    const cacheKey: any = `${service.serviceId}::${service.updatedAt || ""}`;
    const cached: any = mcpToolCache.get(cacheKey);
    const ttlMs: any = Number(service.mcp?.toolsCacheTtlMs || 0);
    if (!refresh && cached && ttlMs > 0 && Date.now() - cached.loadedAt <= ttlMs) {
      return clone(cached.tools);
    }
    let listed: any;
    try {
      serviceDiscoveryCount += 1;
      listed = await upstreamMcpSessions.listTools(
        await mcpServiceConfigWithCredentials(service, {
          operationKey: "tools/list",
          requiredScopes: ["gateway:read"]
        }),
        { signal, onNotification }
      );
    } catch (cause: any) {
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
    const tools: any = asArray(listed.tools)
      .filter((tool?: any) : any => text(tool.name))
      .map((tool?: any) : any => publicUpstreamMcpTool({ service, tool }));
    mcpToolCache.set(cacheKey, {
      loadedAt: Date.now(),
      tools,
      byPublicName: new Map<any, any>(
        tools.map((tool?: any) : any => [tool?.name, tool])
      )
    });
    return clone(tools);
  }

  function serviceForPublicMcpToolName(publicName: any = "") : any {
    const parsed: any = parsePublicUpstreamMcpToolName(publicName);
    if (!parsed) return null;
    const service: any = mcpServicesByPublicPrefix.get(parsed.prefix);
    if (!service) return null;
    targetedServiceIndexHits += 1;
    return {
      service,
      upstreamToolName: parsed.upstreamToolName
    };
  }

  function configuredOperationForPublicToolName(publicName: any = "") : any {
    const target: any = configuredOperationsByPublicName.get(String(publicName || "")) || null;
    if (target) targetedServiceIndexHits += 1;
    return target;
  }

  function configuredOperationToolsForService(service?: any) : any {
    if (service.serviceProtocol === "mcp" || service.disabled) return [];
    return asArray(service.operations)
      .filter((operation?: any) : any => operation?.operationKey)
      .map((operation?: any) : any => publicUpstreamOperationTool({ service, operation }));
  }

  async function resolvedMcpOperationForInput(service?: any, operation?: any, input: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
    if (service.serviceProtocol !== "mcp" && operation.protocol !== "mcp") {
      return operation;
    }
    const upstreamToolName: any = text(
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
    const tools: any = await listMcpToolsForService(service, options);
    const publicTool: any = tools.find((tool?: any) : any =>
      tool?._meta?.upstreamToolName === upstreamToolName ||
        tool.name === input.publicToolName ||
        tool.name === input.upstreamPublicToolName
    );
    if (!publicTool) {
      return operation;
    }
    const meta: any = object(publicTool._meta);
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
    listServices() : any {
      const items: any = [...services.values()].map(publicService);
      return {
        protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
        items,
        count: items.length
      };
    },
    getService(serviceId?: any) : any {
      return publicService(requireService(serviceId));
    },
    evaluateProjectedOperationAudience({
      grant = null,
      restriction = null,
      subject = null,
      tool = null,
      purpose = "discovery"
    }: Record<string, any> = {}) : any {
      if (tool?.upstreamProjectedOperation !== true) {
        return Object.freeze({
          allowed: true,
          reasonCode: "audience_not_applicable",
          purpose: purpose === "execution" ? "execution" : "discovery",
          visibleMetadata: true
        });
      }
      const serviceId: any = text(tool.serviceId || tool.dynamicCapability?.serviceId);
      const service: any = services.get(serviceId) || null;
      return evaluateAudienceDecision({
        grant,
        restriction,
        subject,
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
    evaluateDiscoveredMcpToolAudience({
      grant = null,
      restriction = null,
      subject = null,
      tool = null,
      purpose = "discovery"
    }: Record<string, any> = {}) : any {
      const meta: any = object(tool?._meta);
      if (meta.upstreamMcp !== true) {
        return Object.freeze({
          allowed: false,
          reasonCode: "audience_operation_unavailable",
          purpose: purpose === "execution" ? "execution" : "discovery",
          visibleMetadata: false
        });
      }
      const service: any = services.get(text(meta.serviceId)) || null;
      return evaluateAudienceDecision({
        grant,
        restriction,
        subject,
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
    async listMcpTools(input: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
      const requestedServiceId: any = text(input.serviceId || "");
      const refresh: any = input.refresh === true;
      const items: any[] = [];
      for (const service of services.values()) {
        if (requestedServiceId && service.serviceId !== requestedServiceId) continue;
        if (service.disabled) continue;
        if (service.serviceProtocol === "mcp") {
          const tools: any = await listMcpToolsForService(service, {
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
    async callMcpToolByPublicName(publicName: any = "", input: Record<string, any> = {}, subject: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
      const target: any = serviceForPublicMcpToolName(publicName);
      const configuredTarget: any = target ? null : configuredOperationForPublicToolName(publicName);
      if (!target && !configuredTarget) {
        throw Object.assign(new Error(`Upstream MCP tool not found: ${publicName}`), { status: 404 });
      }
      if (configuredTarget) {
        const operationInput: any = object(input.arguments || input.input || input.payload || input);
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
      const cacheKey: any = `${target.service.serviceId}::${target.service.updatedAt || ""}`;
      const ttlMs: any = Number(target.service.mcp?.toolsCacheTtlMs || 0);
      const cached: any = mcpToolCache.get(cacheKey);
      let tool: any = null;
      if (ttlMs > 0 && cached && Date.now() - cached.loadedAt <= ttlMs) {
        targetedCallMapHits += 1;
        tool = cached.byPublicName?.get(publicName) || null;
      } else {
        await listMcpToolsForService(target.service, {
          refresh: true,
          signal: options.signal || null,
          onNotification: options.onNotification || null
        });
        tool = mcpToolCache.get(cacheKey)?.byPublicName?.get(publicName) || null;
      }
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
    previewPolicy(input: Record<string, any> = {}, subject: Record<string, any> = {}) : any {
      const service: any = requireService(input.serviceId);
      const operation: any = operationWithUpstreamCapability(service, operationFor(service, input.operationKey));
      return previewFor(service, operation, subject);
    },
    async health(serviceId?: any) : Promise<any> {
      const service: any = requireService(serviceId);
      if (service.serviceProtocol === "mcp") {
        const startedAt: any = Date.now();
        try {
          const tools: any = await listMcpToolsForService(service, { refresh: true });
          return {
            ok: true,
            serviceId,
            status: 200,
            protocol: "mcp",
            toolCount: tools.length,
            latencyMs: Date.now() - startedAt,
            checkedAt: nowIso()
          };
        } catch (error: any) {
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
      const startedAt: any = Date.now();
      const endpoints: any = endpointsFor(service);
      const checks: any[] = [];
      const controller: any = new AbortController();
      const timeout: any = setTimeout(() : any => controller.abort(), 3000);
      try {
        for (const endpoint of endpoints) {
          const url: any = safeTargetUrl(service, { path: service.healthPath }, {}, endpoint);
          const pinnedFetch: any = await fetchConfiguredUpstream(service, url, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal
          }, `upstream-gateway.${service.serviceId}.health`);
          try {
            const response: any = pinnedFetch.response;
            checks.push({
              endpoint: publicEndpoint(endpoint),
              ok: response.ok,
              status: response.status
            });
            await response.body?.cancel?.().catch?.(() : any => {});
            if (response.ok) break;
          } finally {
            await pinnedFetch.close();
          }
        }
        const firstOk: any = checks.find((item?: any) : any => item.ok) || checks[0] || { ok: false, status: 0 };
        return {
          ok: firstOk.ok,
          serviceId,
          status: firstOk.status,
          endpointCount: endpoints.length,
          healthyEndpointCount: checks.filter((item?: any) : any => item.ok).length,
          endpoints: checks,
          latencyMs: Date.now() - startedAt,
          checkedAt: nowIso()
        };
      } catch (error: any) {
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
    async requestPluginExternalService(request: Record<string, any> = {}, { subject = {}, signal = null }: Record<string, any> = {}) : Promise<any> {
      const serviceRef: any = text(request.serviceRef);
      const operationRef: any = text(request.operationRef);
      const pluginId: any = text(request.pluginId);
      const callerOperationId: any = text(request.operationId);
      const governance: any = object(request.governance);
      if (!pluginId || !serviceRef || !operationRef || operationRef !== callerOperationId ||
          !text(governance.authorizationContextDigest) || !text(governance.riskDecisionRef) ||
          !text(governance.policyRevision)) {
        throw Object.assign(new Error("Plugin external service binding is invalid."), { status: 403 });
      }
      const service: any = requireService(serviceRef);
      if (service.disabled) {
        throw Object.assign(new Error("Upstream service is disabled."), { status: 403 });
      }
      const configuredOperation: any = operationWithUpstreamCapability(
        service,
        operationFor(service, operationRef)
      );
      if (pluginId === "skill-hub") {
        await ensureSkillHubEventSubscription(service, configuredOperation);
      }
      const requestInput: any = object(request.input);
      const timeoutMs: any = Number(request.timeoutMs || 0);
      const forwardOptions: Record<string, any> = {
        signal,
        ...(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100
          ? { timeoutMs: Math.min(timeoutMs, 300_000) }
          : {})
      };
      if (service.serviceProtocol === "mcp" || configuredOperation.protocol === "mcp") {
        const pluginSubject: Record<string, any> = {
          ...subject,
          scopes: [...new Set<any>([...asArray(subject.scopes).map(text).filter(Boolean), "gateway:read"])]
        };
        const protocolMethod: any = text(requestInput.protocolMethod);
        if (protocolMethod === "tools/list") {
          authorizeMcpDiscoverySubject(pluginSubject);
          authorizeForwardPreview(service, configuredOperation, pluginSubject);
          const items: any = await listMcpToolsForService(service, {
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
        const toolName: any = text(requestInput.toolName);
        if (!toolName) {
          throw Object.assign(new Error("Plugin external MCP tool is required."), { status: 400 });
        }
        const forwarded: any = await this.forward({
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

      const pathParameterNames: any = [...text(configuredOperation.path).matchAll(/\{([A-Za-z][A-Za-z0-9_]{0,63})\}/gu)]
        .map((match?: any) : any => match[1]);
      const pathParameters: Record<string, any> = {};
      for (const name of pathParameterNames) {
        if (!Object.hasOwn(requestInput, name)) {
          throw Object.assign(new Error("Plugin external service path parameter is missing."), { status: 400 });
        }
        pathParameters[name] = requestInput[name];
      }
      const providerInput: any = Object.fromEntries((Object.entries(requestInput) as [string, any][])
        .filter(([name]: any[]) : any => !pathParameterNames.includes(name)));
      const method: any = configuredHttpMethod(configuredOperation);
      const forwarded: any = await this.forward({
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
      const response: any = object(forwarded?.response);
      const data: any = Object.hasOwn(response, "json")
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
    previewHttpStream(input: Record<string, any> = {}, subject: Record<string, any> = {}) : any {
      const service: any = requireService(input.serviceId);
      const operation: any = operationWithUpstreamCapability(service, operationFor(service, input.operationKey));
      if (service.disabled) {
        throw Object.assign(new Error("Upstream service is disabled."), { status: 403 });
      }
      const preview: any = authorizeForwardPreview(service, operation, subject);
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
      const payloadTransport: any = compilePayloadTransport(operation);
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
      const method: any = configuredHttpMethod(operation);
      const hasRequestBody: any = !["GET", "HEAD"].includes(method);
      selectRequestRepresentationHeaders(input.requestHeaders || {}, payloadTransport.request, { hasBody: hasRequestBody });
      if (hasRequestBody && input.contentLength !== null && input.contentLength !== undefined) {
        const declaredLength: any = Number(input.contentLength);
        if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
          throw payloadRepresentationError("request_length_invalid", "Request content length is invalid.", 400);
        }
        if (declaredLength > payloadTransport.request.maxBytes) {
          throw payloadRepresentationError("request_body_too_large", "Request body exceeds its published limit.", 413);
        }
      }
      return Object.freeze({ ok: true, serviceId: service.serviceId, operationKey: operation.operationKey });
    },
    async forwardHttpStream(input: Record<string, any> = {}, subject: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
      const service: any = requireService(input.serviceId);
      const operation: any = operationWithUpstreamCapability(service, operationFor(service, input.operationKey));
      if (service.disabled) {
        throw Object.assign(new Error("Upstream service is disabled."), { status: 403 });
      }
      const preview: any = authorizeForwardPreview(service, operation, subject);
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
      const payloadTransport: any = compilePayloadTransport(operation);
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
      return withTrafficSlot(service, operation, preview, async (traffic?: any, endpoint?: any) : Promise<any> => {
        const targetUrl: any = safeTargetUrl(service, operation, input, endpoint);
        const method: any = configuredHttpMethod(operation);
        const hasRequestBody: any = !["GET", "HEAD"].includes(method);
        const credentials: any = await credentialMaterialFor(service, operation, { targetUrl });
        const representationHeaders: any = selectRequestRepresentationHeaders(
          input.requestHeaders || {},
          payloadTransport.request,
          { hasBody: hasRequestBody }
        );
        const declaredLength: any = hasRequestBody && input.contentLength !== null && input.contentLength !== undefined
          ? Number(input.contentLength)
          : null;
        if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > payloadTransport.request.maxBytes) {
          throw payloadRepresentationError("request_body_too_large", "Request body exceeds its published limit.", 413);
        }
        const headers: Record<string, any> = {
          ...configuredHeaders(service),
          ...credentials.headers,
          ...representationHeaders,
          ...(hasRequestBody && declaredLength !== null && Number.isSafeInteger(declaredLength) && declaredLength >= 0
            ? { "content-length": String(declaredLength) }
            : {}),
          "x-meshrix-gateway-service": service.serviceId
        };
        const startedAt: any = Date.now();
        const abortContext: any = createForwardAbortContext(options.signal || null, timeoutFor(operation, options));
        const requestCounter: any = createPayloadCountingTransform(payloadTransport.request.maxBytes, {
          tooLargeCode: "request_body_too_large",
          tooLargeStatus: 413
        });
        const body: any = hasRequestBody
          ? (input.requestStream || Readable.from([])).pipe(requestCounter)
          : undefined;
        let pinnedRequest: any = null;
        try {
          pinnedRequest = await requestConfiguredUpstream(service, targetUrl, {
            method,
            headers,
            body,
            signal: abortContext.signal,
            headersTimeout: timeoutFor(operation, options),
            bodyTimeout: timeoutFor(operation, options)
          }, `upstream-gateway.${service.serviceId}.${operation.operationKey}.stream`);
          const upstreamResponse: any = pinnedRequest.response;
          const status: any = Number(upstreamResponse.statusCode || 0);
          const responseHeaders: any = selectResponseRepresentationHeaders(
            upstreamResponse.headers,
            payloadTransport.response
          );
          const responseDeclaredLength: any = Number(rawHeader(upstreamResponse.headers, "content-length") || 0);
          if (Number.isFinite(responseDeclaredLength) && responseDeclaredLength > payloadTransport.response.maxBytes) {
            upstreamResponse.body?.destroy?.();
            throw payloadRepresentationError(
              "upstream_response_too_large",
              "Upstream response exceeds its published limit.",
              502
            );
          }
          const responseCounter: any = createPayloadCountingTransform(payloadTransport.response.maxBytes, {
            tooLargeCode: "upstream_response_too_large",
            tooLargeStatus: 502
          });
          const responseBody: any = (upstreamResponse.body || Readable.from([])).pipe(responseCounter);
          const cancelResponseBody: any = () : any => responseBody.destroy(
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
          if (hasRequestBody) {
            assertDeclaredSha256Digest(representationHeaders, requestCounter.sha256, "request");
          }
          assertDeclaredSha256Digest(responseHeaders, responseCounter.sha256, "response");
          recordEndpointOutcome(service, operation, endpoint, {
            statusCode: status,
            ok: status >= 200 && status < 300
          });
          const audit: any = appendAudit("upstream.forward.completed", {
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
        } catch (error: any) {
          const callerAborted: any = abortContext.callerAborted();
          const timedOut: any = !callerAborted && (abortContext.timedOut() || error?.name === "AbortError");
          const status: any = callerAborted ? 499 : timedOut ? 504 : error?.status || 502;
          const reasonCode: any = callerAborted
            ? "upstream_forward_cancelled"
            : timedOut
              ? "upstream_forward_timeout"
              : text(error?.reasonCode || error?.code || "upstream_forward_failed");
          recordEndpointOutcome(service, operation, endpoint, { statusCode: status, ok: false });
          recordMetric({ serviceId: service.serviceId, statusCode: status, failed: true });
          const audit: any = appendAudit("upstream.forward.failed", {
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
          await pinnedRequest?.close?.().catch?.(() : any => {});
          abortContext.dispose();
        }
      });
    },
    async openArtifactDownload({ artifactId = "", range = "" }: Record<string, any> = {}, subject: Record<string, any> = {}) : Promise<any> {
      const port: any = requireArtifactTransitPort();
      const reference: any = `artifact:${String(artifactId || "").trim()}`;
      const metadata: any = await port.resolve(reference, subject, "download");
      const total: any = Number(metadata.byteLength || 0);
      let start: any = 0;
      let end: any = Math.max(0, total - 1);
      let partial: any = false;
      const rangeText: any = String(range || "").trim();
      if (rangeText) {
        const match: any = /^bytes=(\d*)-(\d*)$/u.exec(rangeText);
        if (!match || (!match[1] && !match[2]) || rangeText.includes(",")) {
          throw payloadRepresentationError("artifact_range_invalid", "Artifact range is invalid.", 416);
        }
        if (!match[1]) {
          const suffix: any = Number(match[2]);
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
      const source: any = await port.openRead(reference, subject, "download", { start, end });
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
    async forward(input: Record<string, any> = {}, subject: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
      const service: any = requireService(input.serviceId);
      const configuredOperation: any = operationWithUpstreamCapability(service, operationFor(service, input.operationKey));
      const routingOverrideFields: any = callerRoutingOverrideFields(input);
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
      const operation: any = operationWithUpstreamCapability(service, await resolvedMcpOperationForInput(
        service,
        configuredOperation,
        input,
        options
      ));
      const preview: any = authorizeForwardPreview(service, operation, subject);
      if (!preview.traffic.allowed) {
        throw Object.assign(new Error("Upstream gateway traffic limit exceeded."), { status: 429, details: preview });
      }
      rejectCallerApprovalOverride(input, service, operation, subject);
      if (operation.requiresApproval && !trustedApprovalForForward(subject, operation)) {
        return pendingApproval(service, operation);
      }
      return withTrafficSlot(service, operation, preview, async (traffic?: any, endpoint?: any) : Promise<any> => {
        if (service.serviceProtocol === "mcp" || operation.protocol === "mcp") {
          return forwardMcp(service, operation, input, endpoint, options);
        }
        const payloadTransport: any = compilePayloadTransport(operation);
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
        const sinkInput: any = clone(input);
        const providerInput: any = input?.[PROJECTED_PROVIDER_INPUT];
        const sinkInputDigest: any = digestFinalProtectedSinkInput(
          providerInput ? clone(providerInput) : sinkInput
        );
        const targetFacts: any = structuredTargetFacts({
          service,
          operation,
          input: sinkInput,
          endpoint,
          inputDigest: sinkInputDigest
        });
        const finalProtectedSinkPermit: any = options.finalProtectedSinkPermit;
        if (!finalProtectedSinkPermit && claimProtectedSinkAttempt === claimFinalProtectedSinkAttempt) {
          finalEffectAuthorityRequired();
        }
        await claimProtectedSinkAttempt({
          attempt: finalProtectedSinkPermit,
          targetSelector: targetFacts.targetSelector,
          effect: targetFacts.effect,
          resourceRevision: targetFacts.resourceRevision,
          resolveCurrentResource: async () : Promise<any> => {
            const currentFacts: any = currentStructuredTargetFacts({
              serviceId: service.serviceId,
              operationKey: operation.operationKey,
              endpointId: endpoint?.endpointId || "primary",
              input: sinkInput,
              inputDigest: sinkInputDigest
            });
            return Object.freeze({
              effect: currentFacts.effect,
              resourceRevision: currentFacts.resourceRevision
            });
          }
        });
        if (options.signal?.aborted === true) {
          const audit: any = appendAudit("upstream.forward.failed", {
            serviceId: service.serviceId,
            operationKey: operation.operationKey,
            protocol: operation.protocol,
            method: targetFacts.method,
            target: summarizeUrl(targetFacts.targetUrl),
            endpoint: traffic.endpoint,
            circuit: traffic.circuit,
            statusCode: 499,
            reasonCode: "upstream_forward_cancelled"
          });
          persist();
          throw Object.assign(
            new Error("Upstream gateway request was cancelled."),
            {
              code: "upstream_forward_cancelled",
              reasonCode: "upstream_forward_cancelled",
              status: 499,
              statusCode: 499,
              audit
            }
          );
        }
        const targetUrl: any = targetFacts.targetUrl;
        const method: any = targetFacts.method;
        const credentials: any = await credentialMaterialFor(service, operation, { targetUrl });
        const headers: Record<string, any> = {
          ...configuredHeaders(service),
          ...credentials.headers,
          "content-type": "application/json",
          "x-meshrix-gateway-service": service.serviceId
        };
        const rpcMethod: any = targetFacts.rpcMethod;
        const bodySource: any = operation.protocol === "json-rpc"
          ? jsonRpcRequestBody(sinkInput, operation, rpcMethod)
          : sinkInput.bodyJson !== undefined
            ? sinkInput.bodyJson
            : sinkInput.body;
        const body: any = ["GET", "HEAD"].includes(method)
          ? undefined
          : typeof bodySource === "string"
            ? bodySource
            : JSON.stringify(
                bodySource === undefined
                  ? object(sinkInput.payload)
                  : bodySource
              );
        if (body && Buffer.byteLength(body) > payloadTransport.request.maxBytes) {
          throw payloadRepresentationError(
            "request_body_too_large",
            "Structured request exceeds its published limit.",
            413
          );
        }
        const requestBodyMetadata: any = bodyMetadata(bodySource === undefined ? object(sinkInput.payload) : bodySource, operation.sensitiveBodyFields, {
          byteLength: body ? Buffer.byteLength(body) : 0,
          contentType: "application/json"
        });
        const startedAt: any = Date.now();
        const requestedTimeoutMs: any = Number(options.timeoutMs || 0);
        const effectiveTimeoutMs: any = Number.isSafeInteger(requestedTimeoutMs) && requestedTimeoutMs >= 100
          ? Math.min(operation.timeoutMs, requestedTimeoutMs)
          : operation.timeoutMs;
        const abortContext: any = createForwardAbortContext(options.signal || null, effectiveTimeoutMs);
        let pinnedFetch: any = null;
        try {
          pinnedFetch = await fetchConfiguredUpstream(service, targetUrl, {
            method,
            headers,
            body,
            redirect: "manual",
            signal: abortContext.signal
          }, `upstream-gateway.${service.serviceId}.${operation.operationKey}`);
          const response: any = pinnedFetch.response;
          let buffer: any;
          try {
            buffer = await readResponseBufferWithLimit(response, payloadTransport.response.maxBytes);
          } catch (error: any) {
            if (error?.code !== "upstream_response_too_large") throw error;
            recordMetric({ serviceId: service.serviceId, statusCode: response.status, failed: true });
            const audit: any = appendAudit("upstream.forward.rejected", {
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
          const contentType: any = response.headers.get("content-type") || "";
          const responsePolicy: any = assertResponseBodyPolicy(contentType, buffer, operation);
          const responseBodyMetadata: any = bodyMetadata(
            /json/i.test(contentType) ? Buffer.from(buffer).toString("utf8") : undefined,
            operation.sensitiveBodyFields,
            {
              byteLength: buffer.byteLength,
              contentType: contentType || "application/octet-stream"
            }
          );
          const audit: any = appendAudit("upstream.forward.completed", {
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
        } catch (error: any) {
          const callerAborted: any = abortContext.callerAborted();
          const timedOut: any = !callerAborted && (
            abortContext.timedOut() || error?.name === "AbortError"
          );
          const status: any = callerAborted ? 499 : timedOut ? 504 : error?.status || 502;
          const reasonCode: any = callerAborted
            ? "upstream_forward_cancelled"
            : timedOut
              ? "upstream_forward_timeout"
              : text(error?.reasonCode || error?.code || "upstream_forward_failed");
          recordEndpointOutcome(service, operation, endpoint, {
            statusCode: status,
            ok: false
          });
          recordMetric({ serviceId: service.serviceId, statusCode: status, failed: true });
          const audit: any = error?.audit || appendAudit("upstream.forward.failed", {
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
          const publicError: any = callerAborted
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
          await pinnedFetch?.close?.().catch?.(() : any => {});
          abortContext.dispose();
        }
      });
    },
    listAudit(input: Record<string, any> = {}) : any {
      const serviceId: any = text(input.serviceId || "");
      const limit: any = Math.max(1, Math.min(Number(input.limit || 100), 500));
      const items: any = auditEvents
        .filter((event?: any) : any => !serviceId || event.serviceId === serviceId)
        .slice(-limit)
        .reverse();
      return {
        protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
        items: clone(items),
        count: items.length
      };
    },
    getMetrics() : any {
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
    async flushRuntimeState() : Promise<any> {
      return persist();
    },
    isClosed() : any {
      return closed;
    },
    getManifestSnapshotRevision() : any {
      return manifestSnapshotRevision;
    },
    captureManifestSnapshotState() : any {
      return Object.freeze({
        setRevision: manifestSnapshotRevision.sourceRevision,
        setDigest: manifestSnapshotRevision.sourceDigest,
        serviceEntries: Object.freeze([...services.entries()].map(([serviceId, service]: any[]) : any => Object.freeze([serviceId, service]))),
        projectedOperationTargets: Object.freeze([...projectedOperationTargets.entries()].map(([operationId, target]: any[]) : any => Object.freeze([operationId, target])))
      });
    },
    restoreManifestSnapshotState(state?: any) : any {
      if (!state || !Array.isArray(state.serviceEntries) || !Array.isArray(state.projectedOperationTargets)) {
        throw new TypeError("Upstream gateway manifest snapshot rollback state is invalid.");
      }
      services = new Map<any, any>(state.serviceEntries);
      projectedOperationTargets = new Map<any, any>(state.projectedOperationTargets);
      const restoredTargetIndexes: any = compilePublicToolTargetIndexes(services);
      mcpServicesByPublicPrefix = restoredTargetIndexes.mcpByPrefix;
      configuredOperationsByPublicName = restoredTargetIndexes.configuredByName;
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
    replaceFromManifestSnapshot(snapshot?: any, { deferSideEffects = false }: Record<string, any> = {}) : any {
      const entries: any = snapshot?.serviceEntries ||
        (snapshot?.services instanceof Map ? [...snapshot.services.entries()] : null);
      if (!Array.isArray(entries) || !Number.isSafeInteger(snapshot.setRevision)) {
        throw new TypeError("Upstream gateway manifest snapshot is invalid.");
      }
      const next: any = new Map<any, any>(entries);
      if (next.size !== entries.length) {
        throw new TypeError("Upstream gateway manifest snapshot contains duplicate service identities.");
      }
      const nextProjectedTargets: any = new Map<any, any>();
      for (const [serviceId, service] of next) {
        if (service.disabled === true) continue;
        for (const operation of service.operations || []) {
          const operationId: any = upstreamProjectedOperationId(serviceId, operation.operationKey);
          if (nextProjectedTargets.has(operationId)) {
            throw new TypeError("Upstream gateway manifest snapshot contains duplicate projected operations.");
          }
          nextProjectedTargets.set(operationId, Object.freeze({ serviceId, operationKey: operation.operationKey }));
        }
      }
      const nextTargetIndexes: any = compilePublicToolTargetIndexes(next);
      const added: any[] = [];
      const updated: any[] = [];
      const removed: any[] = [];
      for (const [serviceId, service] of next) {
        const existing: any = services.get(serviceId);
        if (!existing) added.push(serviceId);
        else if (existing.manifestDigest !== service.manifestDigest || existing.serviceRevision !== service.serviceRevision) updated.push(serviceId);
      }
      for (const serviceId of services.keys()) {
        if (!next.has(serviceId)) removed.push(serviceId);
      }
      services = next;
      projectedOperationTargets = nextProjectedTargets;
      mcpServicesByPublicPrefix = nextTargetIndexes.mcpByPrefix;
      configuredOperationsByPublicName = nextTargetIndexes.configuredByName;
      manifestSnapshotRevision = Object.freeze({
        sourceRevision: snapshot.setRevision,
        sourceDigest: snapshot.setDigest
      });
      clearServiceRuntimeState([...updated, ...removed]);
      const diff: Readonly<Record<string, any>> = Object.freeze({
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
    async finalizeManifestSnapshot(diff?: any) : Promise<any> {
      if (!diff || !Array.isArray(diff.updated) || !Array.isArray(diff.removed)) {
        throw new TypeError("Upstream gateway manifest snapshot finalization diff is invalid.");
      }
      retireEndpointTrafficServices([...diff.updated, ...diff.removed]);
      const results: any[] = [];
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
    async forwardProjectedOperation(operationId?: any, input: Record<string, any> = {}, subject: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
      const target: any = projectedOperationTargets.get(String(operationId || ""));
      if (!target) {
        throw Object.assign(new Error("Projected upstream operation was not found."), { status: 404 });
      }
      const providerInput: any = clone(input);
      const projectedInput: Record<string, any> = {
        ...providerInput,
        ...target
      };
      Object.defineProperty(projectedInput, PROJECTED_PROVIDER_INPUT, {
        configurable: false,
        enumerable: false,
        value: providerInput,
        writable: false
      });
      return this.forward(projectedInput, subject, options);
    },
    async close() : Promise<any> {
      if (closed) return;
      if (closePromise) return closePromise;
      closePromise = (async () : Promise<any> => {
        let closeFailed: any = false;
        for (const state of skillHubEventSubscriptions.values()) state.controller.abort();
        const subscriptions: any = [...skillHubEventSubscriptions.values()].map((state?: any) : any => state.promise);
        skillHubEventSubscriptions.clear();
        await Promise.allSettled(subscriptions);
        try {
          await closeGatewayRuntime?.();
        } catch {
          closeFailed = true;
        }
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
      } catch (error: any) {
        closePromise = null;
        throw error;
      }
    },
    getRefactorInstrumentation() : any {
      return {
        ...getRefactorInstrumentation(),
        targetedCallMapHits,
        targetedServiceIndexHits,
        serviceDiscoveryCount
      };
    }
  };
}
