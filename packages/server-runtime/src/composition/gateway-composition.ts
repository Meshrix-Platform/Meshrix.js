import { randomBytes } from "node:crypto";
import {
  createGateway,
  type GatewayKernel,
  type GatewayOptions
} from "@meshrix/gateway";
import { createGatewayPolicy } from "@meshrix/capabilities/gateway-policy";
import { POLICY_ONLY_INPUT_KEYS } from "@meshrix/capabilities/operation-permission-core/runtime-schema";
import { projectedOperationForwardInput } from "@meshrix/agents/upstream-gateway/index";
import { createGatewayPermitAuthority } from "@meshrix/foundation/security/gateway-permit";
import type {
  AuthenticatedContext,
  CatalogDescriptor,
  GatewayApprovalPort,
  GatewayOutcome,
  Invocation,
  RouteSnapshot,
  UpstreamPort,
  UpstreamResponse
} from "@meshrix/contracts/gateway";
import {
  createModernDownstreamAdapter,
  type ModernDownstreamAdapter,
  type ModernDownstreamRequest
} from "@meshrix/protocols/mcp/modern-downstream";
import { MCP_OUTLET_METADATA, meshrixCategorizedTools } from "@meshrix/protocols/mcp/modern-downstream/tools";

export interface PlatformGatewayCompositionOptions extends GatewayOptions {
  readonly platformName?: string;
}

/**
 * The platform composition owns adapters and stores but delegates every
 * protected upstream effect to the gateway kernel's single invoke boundary.
 */
export function createPlatformGateway(options: PlatformGatewayCompositionOptions = {}): GatewayKernel {
  return createGateway({
    ...options,
    // `tagPolicy` and its peers carry platform policy, not operation input; the operation
    // permission core strips them before validating, so the kernel must not assert them
    // against the route's closed operation schema.
    inputEnvelopeKeys: options.inputEnvelopeKeys ?? [...POLICY_ONLY_INPUT_KEYS],
    serverInfo: { platform: options.platformName ?? "meshrix-platform", ...(options.serverInfo ?? {}) }
  });
}

export async function executeThroughPlatformGateway(input: { readonly gateway: GatewayKernel; readonly context: AuthenticatedContext; readonly invocation: import("@meshrix/contracts/gateway").Invocation }): Promise<GatewayOutcome> {
  return input.gateway.invoke(input.context, input.invocation);
}

export interface PlatformMcpGatewayOptions {
  readonly toolSkillManagementProvider: Record<string, any>;
  readonly upstreamGatewayRegistry?: Record<string, any> | null;
  readonly runtimeLogger?: Record<string, any> | null;
  readonly platformName?: string;
}

export interface PlatformMcpGateway {
  readonly gateway: GatewayKernel;
  readonly adapter: ModernDownstreamAdapter;
  close(options?: { readonly drainDeadline?: number }): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function cloneJson<T>(value: T, fallback: unknown = undefined): T | unknown {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function effectClassForRisk(value: unknown): RouteSnapshot["effectClass"] {
  const risk = text(value).toLocaleLowerCase();
  if (risk === "read" || risk === "read_only" || risk === "safe") return "read";
  if (risk === "safe_write" || risk === "write" || risk === "medium") return "safe_write";
  if (risk === "repair_write" || risk === "destructive" || risk === "high") return "destructive";
  return "unknown";
}

function mcpOutletName(tool: Record<string, any>, operationId: string): string {
  const explicit = text(tool.mcpOutlet);
  if (explicit) return explicit;
  return /^(operation_permission\.|gateway\.|external_services\.)/iu.test(operationId)
    ? "meshrix.gateway"
    : "meshrix.discovery";
}

function routeFor({
  routeRef,
  upstreamIdentity,
  endpointIdentity,
  upstreamName,
  effectClass,
  metadata,
  revision
}: Record<string, any>): RouteSnapshot {
  return Object.freeze({
    logicalRoute: routeRef,
    upstreamIdentity,
    endpointIdentity,
    protocolVersion: "2026-07-28",
    schemaDigest: `schema:${revision}`,
    policyRef: "platform-gateway-policy-1",
    revision,
    effectClass,
    operation: "tools/call",
    ...(upstreamName ? { upstreamName } : {}),
    metadata: Object.freeze(metadata)
  });
}

/**
 * The outlet module's own core outlet tools, in the shape `platformToolDescriptor` projects.
 * The advertised name, title, description, input schema, and annotations are the outlet
 * module's, and the architecture category comes from the same `MCP_OUTLET_METADATA` the
 * routed call path resolves an outlet by, so the published descriptor and the served call
 * path cannot drift apart. Only the core outlets are published here: a plugin-contributed
 * outlet arrives through the tool provider with its own validated descriptor.
 */
function coreOutletTools(): readonly Record<string, any>[] {
  return meshrixCategorizedTools()
    .filter((outletTool: Record<string, any>) : boolean => isRecord(MCP_OUTLET_METADATA[text(outletTool.name)]))
    .map((outletTool: Record<string, any>) : Record<string, any> => {
      const toolName = text(outletTool.name);
      const readOnly = outletTool.annotations?.readOnlyHint === true;
      return {
        id: toolName,
        label: text(outletTool.title),
        description: text(outletTool.description),
        inputSchema: outletTool.inputSchema,
        readOnly,
        destructive: outletTool.annotations?.destructiveHint === true,
        // The retired chain published the gateway outlet as a non-read-only route and the
        // discovery outlet as a read; the effect class is what the kernel's annotations and
        // policy read, so it is derived from the outlet's own read-only annotation here.
        risk: readOnly ? "read_only" : "safe_write",
        mcpOutlet: toolName,
        architectureCategory: text(MCP_OUTLET_METADATA[toolName]?.architectureCategory)
      };
    });
}

function platformToolDescriptor(tool: Record<string, any>, catalogRevision: string): CatalogDescriptor | null {
  const name = text(tool.id || tool.operationId || tool.name);
  if (!name) return null;
  const revision = `platform:${catalogRevision}:${name}`;
  const effectClass = effectClassForRisk(tool.risk || tool.safety?.risk || (tool.readOnly === true ? "read_only" : "unknown"));
  const routeRef = `platform:operation:${name}`;
  const metadata = {
    kind: "platform-operation",
    toolId: name,
    // A published upstream operation still carries the manifest facts that admitted it;
    // a downstream catalog peer proves its own audience partition with them.
    ...(tool.upstreamProjectedOperation === true ? {
      upstreamProjectedOperation: true,
      ...(text(tool.protocol) === "mcp" ? { upstreamMcp: true } : { upstreamConfiguredOperation: true }),
      serviceId: text(tool.serviceId),
      serviceRevision: Number(tool.serviceRevision || 0),
      sourceRevision: Number(tool.sourceRevision || 0),
      sourceDigest: text(tool.sourceDigest),
      operationKey: text(tool.operationKey),
      protocol: text(tool.protocol),
      // The projection facts a caller's own arguments are placed by when the projected
      // operation is addressed as a tool. Both are operator-projection facts and the same
      // ones the discovered-tool projection publishes for this operation.
      method: text(tool.method),
      payloadTransport: cloneJson(tool.payloadTransport ?? null),
      ...(isRecord(tool.dynamicCapability)
        ? {
            dynamicCapability: cloneJson(tool.dynamicCapability),
            capabilityId: text(tool.dynamicCapability.capabilityId),
            requiredCapabilities: Object.freeze([text(tool.dynamicCapability.capabilityId)].filter(Boolean))
          }
        : {})
    } : {}),
    operationId: text(tool.operationId || name),
    trafficModel: text(tool.trafficModel || "direct"),
    mcpOutlet: mcpOutletName(tool, text(tool.operationId || name)),
    ...(text(tool.architectureCategory) ? { architectureCategory: text(tool.architectureCategory) } : {}),
    ...(tool.mcpOutletDescriptor === undefined ? {} : { mcpOutletDescriptor: cloneJson(tool.mcpOutletDescriptor) }),
    featureId: text(tool.featureId || tool.feature || ""),
    requiredScopes: Object.freeze(Array.isArray(tool.requiredScopes) ? tool.requiredScopes.map(text).filter(Boolean) : []),
    toolsets: Object.freeze(Array.isArray(tool.toolsets) ? tool.toolsets.map(text).filter(Boolean) : []),
    risk: text(tool.risk || effectClass),
    readOnly: tool.readOnly === true,
    destructive: tool.destructive === true,
    requiresApproval: tool.requiresApproval === true,
    approvalScope: text(tool.approvalScope),
    handlerId: text(tool.handlerId),
    auditPolicy: cloneJson(tool.auditPolicy || { enabled: true, recordInput: true, recordOutput: false }, {}),
    transport: cloneJson(tool.transport || {}, {})
  };
  return Object.freeze({
    kind: "tool",
    publicName: name,
    upstreamName: name,
    description: text(tool.description || tool.label || name),
    inputSchema: cloneJson(tool.inputSchema || { type: "object" }, { type: "object" }),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: cloneJson(tool.outputSchema) }),
    annotations: Object.freeze({
      readOnlyHint: effectClass === "read",
      destructiveHint: effectClass === "destructive"
    }),
    metadata: Object.freeze(metadata),
    route: routeFor({
      routeRef,
      upstreamIdentity: "meshrix-platform",
      endpointIdentity: `platform:${name}`,
      upstreamName: name,
      effectClass,
      revision,
      metadata
    })
  });
}

/**
 * Operator-configured facts plus upstream identity that the downstream `tools/list`
 * metadata must publish. The retired adapter passed the projected tool through with its
 * full `_meta`; the descriptor is a whitelist so a raw upstream payload cannot invent
 * permission evidence. Every key here is written by the platform's own projection from
 * operator service configuration, never from upstream tool annotations.
 */
const UPSTREAM_DESCRIPTOR_META_KEYS: readonly string[] = Object.freeze([
  "upstreamMcp",
  "upstreamProjectedOperation",
  "upstreamConfiguredOperation",
  "toolId",
  "capabilityId",
  "requiredCapabilities",
  "method",
  "serviceRevision",
  "sourceRevision",
  "sourceDigest",
  "protocol",
  "payloadTransport",
  "requiredScopes",
  "toolsets",
  "risk",
  "requiresApproval",
  "capabilityId",
  "requiredCapabilities",
  "dynamicCapability",
  "resourceContext",
  "io.meshrix/gateway-policy"
]);

function upstreamToolMetadata({ meta, serviceId, upstreamToolName, operationKey }: Record<string, any>): Readonly<Record<string, unknown>> {
  const forwarded: Record<string, any> = {};
  for (const key of UPSTREAM_DESCRIPTOR_META_KEYS) {
    const value = meta[key];
    if (value === undefined) continue;
    forwarded[key] = cloneJson(value);
  }
  return Object.freeze({
    kind: "upstream-tool",
    serviceId,
    upstreamToolName,
    operationKey,
    ...forwarded
  });
}

const UPSTREAM_ROUTE_PROJECTION_KEYS: readonly string[] = Object.freeze([
  "upstreamMcp",
  "upstreamConfiguredOperation",
  "protocol",
  "method",
  "payloadTransport"
]);

function upstreamRouteProjectionFacts(meta: Record<string, any>): Readonly<Record<string, unknown>> {
  const facts: Record<string, unknown> = {};
  for (const key of UPSTREAM_ROUTE_PROJECTION_KEYS) {
    const value = meta[key];
    if (value === undefined) continue;
    facts[key] = cloneJson(value);
  }
  return facts;
}

function upstreamToolDescriptor(tool: Record<string, any>, catalogRevision: string): CatalogDescriptor | null {
  const name = text(tool.name);
  const meta = isRecord(tool._meta) ? tool._meta : {};
  if (!name) return null;
  const serviceId = text(meta.serviceId || tool.serviceId);
  const upstreamToolName = text(meta.upstreamToolName || meta.operationKey || tool.upstreamName || name);
  const operationKey = text(meta.operationKey || "tools/call");
  const revision = `upstream:${catalogRevision}:${serviceId || "unknown"}:${name}`;
  const routeRef = `upstream:tool:${serviceId || "unknown"}:${name}`;
  const gatewayPolicy = isRecord(meta["io.meshrix/gateway-policy"]) ? meta["io.meshrix/gateway-policy"] : {};
  const effectClass = effectClassForRisk(gatewayPolicy.effectClass);
  return Object.freeze({
    kind: "tool",
    publicName: name,
    upstreamName: upstreamToolName,
    description: text(tool.description || tool.title || name),
    inputSchema: cloneJson(tool.inputSchema || { type: "object" }, { type: "object" }),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: cloneJson(tool.outputSchema) }),
    annotations: cloneJson(tool.annotations || {}, {}) as Readonly<Record<string, unknown>>,
    metadata: upstreamToolMetadata({ meta, serviceId, upstreamToolName, operationKey }),
    route: routeFor({
      routeRef,
      upstreamIdentity: `upstream:${serviceId || "unknown"}`,
      endpointIdentity: `upstream:${serviceId || "unknown"}:${operationKey}`,
      upstreamName: upstreamToolName,
      effectClass,
      revision,
      metadata: {
        kind: "upstream-tool",
        publicName: name,
        serviceId,
        upstreamToolName,
        operationKey,
        // The Operation Permission identity this discovered tool executes as, plus the
        // operator's approval requirement. Both are platform-projection facts (never
        // upstream annotations), and the kernel needs them to escalate an
        // approval-required route instead of refusing it.
        ...(text(meta.toolId) ? { toolId: text(meta.toolId) } : {}),
        ...(meta.requiresApproval === true ? { requiresApproval: true } : {}),
        ...(isRecord(meta.dynamicCapability) ? { dynamicCapability: cloneJson(meta.dynamicCapability) } : {}),
        // An escalated route comes back to the platform as this route, not as the descriptor
        // that published it, and the escalation has to shape the call the same way the
        // executing path would: the addressed tool's arguments are placed by the operation's
        // request representation, and an MCP tool call travels with the upstream tool it
        // addressed. Those facts are the operator's projection of the operation, so they
        // travel with the route the same way the identity above does.
        ...upstreamRouteProjectionFacts(meta)
      }
    })
  });
}

function authorizationSubject(authorization: Record<string, any>): Record<string, any> {
  if (isRecord(authorization.subject)) return { ...authorization.subject };
  const apiKey = authorization.credentialKind === "scoped_api_key" && isRecord(authorization.apiKeyAuthorization)
    ? authorization.apiKeyAuthorization
    : null;
  const policy = isRecord(apiKey?.policy) ? apiKey.policy : {};
  const grant = isRecord(authorization.grant) ? authorization.grant : {};
  const subjectId = text(apiKey?.workloadPrincipalId || grant.subjectId || grant.id);
  return {
    type: apiKey ? "scoped-api-key" : "tool-grant",
    subjectId,
    grantId: text(apiKey?.id || grant.id),
    grant: apiKey ? { id: text(apiKey.id), subjectId } : { id: text(grant.id), subjectId },
    scopes: [...(apiKey ? policy.scopeIds || [] : grant.scopes || [])].map(text).filter(Boolean),
    toolsets: [...(apiKey ? policy.toolsetIds || [] : grant.toolsets || [])].map(text).filter(Boolean),
    dynamicCapabilities: [...(apiKey ? policy.capabilityIds || [] : grant.dynamicCapabilities || grant.capabilities || [])].map(text).filter(Boolean),
    allowedServiceIds: [...(apiKey ? policy.serviceIds || [] : grant.allowedServiceIds || [])].map(text).filter(Boolean),
    allowedSecretBindings: [...(apiKey ? policy.resources?.secretBindingIds || [] : grant.allowedSecretBindings || [])].map(text).filter(Boolean),
    maxRisk: text(apiKey ? policy.maximumRisk : grant.maxRisk || grant.max_risk)
  };
}

function gatewayGrant({ authorization, routeRefs }: { readonly authorization: Record<string, any>; readonly routeRefs: readonly string[] }): Readonly<Record<string, unknown>> {
  const grant = isRecord(authorization.grant) ? authorization.grant : {};
  const apiKey = authorization.credentialKind === "scoped_api_key" && isRecord(authorization.apiKeyAuthorization)
    ? authorization.apiKeyAuthorization
    : null;
  const policy = isRecord(apiKey?.policy) ? apiKey.policy : {};
  const subject = authorizationSubject(authorization);
  const revision = text(
    apiKey?.policyFingerprint ||
      grant.revision ||
      authorization.authorizationDecision?.revision ||
      authorization.decisionId ||
      authorization.grant?.id ||
      "gateway-auth"
  );
  return Object.freeze({
    ...grant,
    revision,
    tenant: text(authorization.tenantId || grant.tenantId || grant.tenant || subject.tenantId || "local"),
    principal: text(apiKey?.workloadPrincipalId || grant.subjectId || grant.id || subject.subjectId),
    routes: Object.freeze([]),
    routeRefs: Object.freeze([...routeRefs]),
    methods: Object.freeze(["tools/call", "resources/read", "prompts/get", "completion/complete"]),
    ...(apiKey ? {
      scopes: Object.freeze([...(policy.scopeIds || [])]),
      toolsets: Object.freeze([...(policy.toolsetIds || [])]),
      dynamicCapabilities: Object.freeze([...(policy.capabilityIds || [])]),
      maxRisk: text(policy.maximumRisk),
      ...(policy.maximumRisk === "destructive" ? { approved: true } : {})
    } : {})
  });
}

function resultEnvelope(result: Record<string, any>, value: unknown): Record<string, any> {
  if (isRecord(value) && typeof value.resultType === "string") return value;
  return {
    resultType: "complete",
    value,
    ...(result.ok === true ? {} : { isError: true })
  };
}

/**
 * The answer of a route that projects an upstream operation, under the identity it executed
 * as, so a peer reads which governed operation produced the result instead of a bare
 * forwarding envelope. An executed effect and a pending approval the kernel escalated answer
 * under the same envelope: a peer reads how far the effect got from the payload it carries,
 * and a route that answered one way when executed and another when escalated would make that
 * payload unreadable for exactly the calls that must not look like completed ones.
 */
function projectedOperationValue(metadata: Record<string, any>, payload: unknown): unknown {
  if (!isProjectedUpstreamRoute(metadata)) return payload;
  const projected = isRecord(metadata.dynamicCapability) ? metadata.dynamicCapability : null;
  const capabilityId = text(metadata.capabilityId || projected?.capabilityId);
  return {
    operation: text(metadata.toolId),
    capabilityId,
    ...(projected ? { dynamicCapability: cloneJson(projected) } : {}),
    ...(metadata.upstreamMcp === true ? { upstreamMcp: true } : { upstreamConfiguredOperation: true }),
    payload
  };
}

function executionPayload(result: Record<string, any>): unknown {
  if (isRecord(result.payload) && Object.hasOwn(result.payload, "result")) return result.payload.result;
  return result.payload;
}

function requestArguments(params: unknown): Record<string, any> {
  if (!isRecord(params)) return {};
  return isRecord(params.arguments) ? params.arguments : {};
}

/**
 * Whether the route projects an upstream operation. A projected operation is published
 * either as the governed operation tool itself or as a discovered upstream tool executing
 * as one; both descriptors carry the same platform projection facts, and both answer under
 * the operation they executed as.
 */
function isProjectedUpstreamRoute(metadata: Record<string, any>): boolean {
  return metadata.upstreamProjectedOperation === true || metadata.kind === "upstream-tool";
}

/**
 * The Operation Permission input for a route that projects an upstream operation.
 *
 * A projected operation is addressed as a tool, so the caller's arguments have to become
 * the operation's forward input here, at the boundary where the call enters governed
 * execution: the input this hands over is the one a permit is issued for, the one a pending
 * approval records as its original input, and the one an approved resume replays. Shaping it
 * anywhere later would bind the effect to an input the record does not hold.
 *
 * A discovered upstream tool is addressed by its own name, so its caller sends that tool's
 * arguments rather than the operation's forward envelope; the governed operation tool is
 * addressed by the operation's own name and does take the envelope.
 */
function upstreamOperationInput(metadata: Record<string, any>, params: unknown): Record<string, any> {
  const args = requestArguments(params);
  if (!isProjectedUpstreamRoute(metadata)) return args;
  return projectedOperationForwardInput(metadata, args, { discoveredToolCall: metadata.kind === "upstream-tool" });
}

function response(body: unknown): UpstreamResponse {
  return Object.freeze({
    status: 200,
    headers: Object.freeze({ "content-type": "application/json" }),
    body
  });
}

/**
 * Request facts the platform runtime may keep. The raw request never enters the context:
 * a pending approval persists its context, and a Node request object is not cloneable, so
 * carrying it here would break exactly the approval path that has to record it. The
 * request itself already travels as the runtime's own `request` argument.
 */
function executionContextFromRequest(request: unknown): Record<string, any> {
  const rawRequest = isRecord(request) ? request : null;
  const trace = isRecord(rawRequest?.__meshrixTraceContext) ? rawRequest.__meshrixTraceContext : {};
  return Object.freeze({
    transport: "mcp",
    client: text(rawRequest?.headers?.["user-agent"]),
    traceId: text(trace.traceId || rawRequest?.__meshrixRequestId)
  });
}

/**
 * Bind the platform's existing tool and upstream stores to the gateway kernel.
 * Authentication and catalog projection happen at the protocol edge; all
 * execution enters the kernel before this final platform/upstream sink.
 */
export function createPlatformMcpGateway(options: PlatformMcpGatewayOptions): PlatformMcpGateway {
  const toolProvider = options.toolSkillManagementProvider;
  const upstreamRegistry = options.upstreamGatewayRegistry || null;
  const logger = options.runtimeLogger || null;
  let publishedDescriptorSignature = "";

  const upstream: UpstreamPort = Object.freeze({
    async invoke({ context, request, route, signal }: any): Promise<UpstreamResponse> {
      const metadata = isRecord(route.metadata) ? route.metadata : {};
      const authorization = isRecord(context?.metadata?.authorization) ? context.metadata.authorization : {};
      const rawRequest = context?.metadata?.request || null;
      const platformRequestContext = {
        ...executionContextFromRequest(rawRequest),
        signal
      };
      if (metadata.kind === "platform-operation") {
        const input = upstreamOperationInput(metadata, request.params);
        const resolved = typeof toolProvider.resolveMcpWorkspaceInput === "function"
          ? await toolProvider.resolveMcpWorkspaceInput({
              input,
              request: rawRequest,
              context: platformRequestContext,
              signal
            })
          : { input, workspaceDirectory: null };
        const result = await toolProvider.executeTool({
          toolId: text(metadata.toolId),
          input: resolved.input,
          request: rawRequest,
          authorization,
          context: platformRequestContext,
          signal
        });
        const payload = executionPayload(result);
        const publicPayload = typeof toolProvider.publicMcpToolPayload === "function"
          ? await toolProvider.publicMcpToolPayload({
              payload,
              workspaceDirectory: resolved.workspaceDirectory,
              request: rawRequest,
              context: platformRequestContext,
              signal
            })
          : payload;
        // A projected upstream operation answers under the Operation Permission identity it
        // executed as, so a peer reads which governed operation produced the result instead
        // of a bare forwarding envelope.
        return response(resultEnvelope(result, projectedOperationValue(metadata, publicPayload)));
      }
      if (metadata.kind === "upstream-tool") {
        if (!upstreamRegistry || typeof upstreamRegistry.callMcpToolByPublicName !== "function") {
          throw Object.assign(new Error("Upstream gateway registry is unavailable."), { code: "upstream_gateway_unavailable", status: 503 });
        }
        const forwarded = await upstreamRegistry.callMcpToolByPublicName(
          text(metadata.publicName),
          {
            arguments: requestArguments(request.params),
            ...(request.requestState === undefined ? {} : { requestState: request.requestState })
          },
          authorizationSubject(authorization),
          { signal }
        );
        return response(resultEnvelope(forwarded, forwarded?.response ?? forwarded?.payload ?? null));
      }
      throw Object.assign(new Error("Gateway route sink is not configured."), { code: "gateway_route_sink_unavailable", status: 503 });
    }
  });

  /**
   * The kernel escalates an approval-required route here instead of refusing it. The port
   * is approval-only: it may not run the effect the kernel declined to permit. The platform
   * is therefore asked only for an operation that itself declares an approval requirement —
   * that declaration is what makes the platform's execution entry record a pending
   * operation instead of executing. Anything else keeps the kernel's denial.
   */
  const approval: GatewayApprovalPort = Object.freeze({
    async escalate({ context, invocation, route }: { readonly context: AuthenticatedContext; readonly invocation: Invocation; readonly route: RouteSnapshot }): Promise<any> {
      const metadata = isRecord(route.metadata) ? route.metadata : {};
      const toolId = text(metadata.toolId);
      const projected = isRecord(metadata.dynamicCapability) ? metadata.dynamicCapability : null;
      if (!toolId) return undefined;
      const request = context.metadata?.request || null;
      const authorization = isRecord(context.metadata?.authorization) ? context.metadata.authorization : {};
      let result: any;
      try {
        result = await toolProvider.executeTool({
          toolId,
          input: upstreamOperationInput(metadata, invocation.params),
          request,
          authorization,
          // `approvalOnly` asks the platform to record the pending approval the kernel
          // refused for; the execution branch is unreachable for this call, so the
          // escalation can never run the effect the kernel declined to permit.
          context: {
            ...executionContextFromRequest(request),
            approvalOnly: true,
            ...(projected ? { dynamicCapability: projected } : {}),
            signal: invocation.signal
          },
          signal: invocation.signal
        });
      } catch (error) {
        // The escalation is unavailable: the kernel keeps its own denial, which is the
        // honest answer because nothing ran.
        logger?.warn?.("gateway.approval.escalation_unavailable", { code: text((error as any)?.code) || "escalation_failed", toolId });
        return undefined;
      }
      const pending = isRecord(result?.payload) && result.payload.status === "pending_approval" ? result.payload : null;
      if (!pending) return undefined;
      const pendingOperationId = text(pending.pendingOperation?.pendingOperationId);
      return Object.freeze({
        // A projected upstream operation answers with the same envelope its executing path
        // would, so a peer reads the pending approval under the operation it addressed.
        value: projectedOperationValue(metadata, cloneJson(pending)),
        effectOutcome: "not_started",
        ...(pendingOperationId ? { pendingOperationId } : {})
      });
    }
  });

  const gateway = createPlatformGateway({
    platformName: options.platformName,
    policy: createGatewayPolicy({ revision: "platform-gateway-policy-1" }),
    permits: createGatewayPermitAuthority(),
    approval,
    continuationKey: randomBytes(32),
    upstream
  });

  async function syncCatalog(authorization: Record<string, any>, signal?: AbortSignal): Promise<readonly CatalogDescriptor[]> {
    const visible: CatalogDescriptor[] = [];
    const tools = typeof toolProvider.listVisibleTools === "function"
      ? toolProvider.listVisibleTools({ authorization })
      : [];
    const catalogRevision = text(toolProvider.getRefactorInstrumentation?.()?.schemaVersion || "platform");
    // The stable categorized outlets are the Core MCP baseline and the first entries of the
    // surface: a client that cannot see them in `tools/list` cannot address an operation at
    // all, because every operation is called through one of them. They are published as
    // platform descriptors built from the outlet module's own core outlet tools, so the
    // listing carries the same outlet metadata the routed `tools/call` path refuses a wrong
    // outlet by.
    for (const outletTool of coreOutletTools()) {
      const descriptor = platformToolDescriptor(outletTool, catalogRevision);
      if (descriptor) visible.push(descriptor);
    }
    for (const tool of Array.isArray(tools) ? tools : []) {
      const descriptor = isRecord(tool) ? platformToolDescriptor(tool, catalogRevision) : null;
      if (descriptor) visible.push(descriptor);
    }
    if (upstreamRegistry && typeof upstreamRegistry.listMcpTools === "function") {
      try {
        const listed = await upstreamRegistry.listMcpTools({}, { signal });
        for (const tool of Array.isArray(listed?.items) ? listed.items : []) {
          if (!isRecord(tool)) continue;
          const meta = isRecord(tool._meta) ? tool._meta : {};
          const audience = meta.upstreamMcp === true
            ? upstreamRegistry.evaluateDiscoveredMcpToolAudience?.({
                grant: authorization.grant || null,
                restriction: authorization.restriction || null,
                subject: authorization.subject || authorizationSubject(authorization),
                tool,
                purpose: "discovery"
              })
            : upstreamRegistry.evaluateProjectedOperationAudience?.({
                grant: authorization.grant || null,
                restriction: authorization.restriction || null,
                subject: authorization.subject || authorizationSubject(authorization),
                tool: { ...tool, upstreamProjectedOperation: true },
                purpose: "discovery"
              });
          if (audience && audience.allowed !== true) continue;
          const descriptor = upstreamToolDescriptor(tool, catalogRevision);
          if (descriptor) visible.push(descriptor);
        }
      } catch {
        logger?.warn?.("gateway.catalog.upstream_unavailable", { code: "upstream_catalog_unavailable" });
      }
    }
    const unique = new Map<string, CatalogDescriptor>();
    for (const descriptor of visible) {
      unique.set(descriptor.route.logicalRoute, descriptor);
    }
    const publishedDescriptors = [...unique.values()];
    const descriptorSignature = JSON.stringify(publishedDescriptors);
    if (descriptorSignature !== publishedDescriptorSignature) {
      gateway.publishCatalog(publishedDescriptors);
      publishedDescriptorSignature = descriptorSignature;
    }
    return Object.freeze([...unique.values()]);
  }

  async function authenticate(request: ModernDownstreamRequest): Promise<AuthenticatedContext> {
    if (typeof toolProvider.authorizeMcpClientRequest !== "function") {
      throw Object.assign(new Error("MCP authorization provider is unavailable."), { status: 503 });
    }
    const requestWithTransport: any = request;
    const requestBody = requestWithTransport.requestBody || Buffer.from(JSON.stringify(request.body), "utf8");
    const authorization = await toolProvider.authorizeMcpClientRequest({
      request: requestWithTransport.rawRequest || null,
      requiredScopes: [],
      recordUse: false,
      requestBody,
      url: requestWithTransport.url || new URL("http://127.0.0.1/mcp"),
      method: request.method
    });
    if (authorization?.ok !== true) {
      throw Object.assign(new Error(text(authorization?.error || "MCP authorization failed.")), {
        status: Number(authorization?.status || 401),
        code: text(authorization?.reasonCode || "mcp_authorization_denied")
      });
    }
    const visibleDescriptors = await syncCatalog(authorization, requestWithTransport.signal);
    const routeRefs = visibleDescriptors.map((descriptor) => descriptor.route.logicalRoute);
    const subject = authorizationSubject(authorization);
    const tenant = text(authorization.tenantId || authorization.grant?.tenantId || subject.tenantId || "local");
    const principal = text(authorization.workloadPrincipalId || authorization.grant?.subjectId || authorization.grant?.id || subject.subjectId);
    const authGeneration = text(
      authorization.apiKeyAuthorization?.policyFingerprint ||
        authorization.grant?.revision ||
        authorization.grant?.id ||
        authorization.decisionId ||
        "gateway-auth"
    );
    return Object.freeze({
      tenant,
      principal,
      grant: gatewayGrant({ authorization, routeRefs }),
      authGeneration,
      metadata: Object.freeze({
        authorization,
        subject,
        request: requestWithTransport.rawRequest || null
      })
    });
  }

  const adapter = createModernDownstreamAdapter({
    gateway,
    authenticate,
    resultMeta: (context) => {
      const authorization = isRecord(context.metadata?.authorization) ? context.metadata.authorization : {};
      const facts = typeof toolProvider.audienceCatalogFacts === "function"
        ? toolProvider.audienceCatalogFacts({ authorization })
        : null;
      return facts ? { catalogConvergence: cloneJson(facts) } : {};
    },
    serverInfo: { name: options.platformName || "meshrix-platform", protocolVersion: "2026-07-28" }
  });

  return Object.freeze({
    gateway,
    adapter,
    async close(closeOptions = {}): Promise<void> {
      await gateway.close(closeOptions);
    }
  });
}
