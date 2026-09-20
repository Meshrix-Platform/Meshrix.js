import type { AuthenticatedContext, CatalogDescriptor, Gateway, GatewayOutcome, SubscriptionEvent } from "@meshrix/contracts/gateway";
import {
  MCP_SUBSCRIBE_METHOD,
  mcpSubscriptionIdFromRequest,
  parseMcpSubscriptionNotifications
} from "./protocol.ts";
import { registerMcpGatewaySubscription } from "../notifications.ts";
import {
  CATEGORIZED_TOOL_NAMES,
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME
} from "../adapter/http-mcp-adapter-constants.ts";
import {
  MCP_DISCOVER_METHOD,
  isUnauthenticatedMcpMethod,
  mcpCompleteResult
} from "./protocol.ts";
import { mcpDiscoverResult } from "./discovery.ts";
import { mcpVersionInfo } from "./discovery.ts";
import { mcpEnvelopePublic } from "./response.ts";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isGatewayFailure(value: GatewayOutcome): value is Extract<GatewayOutcome, { readonly kind: "failure" }> {
  return value.kind === "failure";
}

/**
 * `tools/call` is the one MCP method whose result is a tool result, not a bare value:
 * peers read `result.structuredContent` and the platform publishes the operation payload
 * there. A tagged `complete` outcome is projected into that envelope instead of nesting
 * it under `value`; a business value that is already a tool result is passed through.
 */
function completeToolResult(result: Exclude<GatewayOutcome, { readonly kind: "failure" }> & { readonly kind: "complete" }): Record<string, unknown> {
  const value = result.value;
  const toolResult = isPlainRecord(value) && Array.isArray(value.content)
    ? value
    : {
        content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }],
        structuredContent: value
      };
  return {
    resultType: "complete",
    ...toolResult,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.requestState === undefined ? {} : { requestState: result.requestState }),
    // A result the kernel answered without executing tags how far the effect got, so a
    // peer never reads a pending approval as a completed one.
    ...(result.effectOutcome === undefined ? {} : { _meta: { "io.meshrix/effect-outcome": result.effectOutcome } })
  };
}

function toProtocolResult(result: Exclude<GatewayOutcome, { readonly kind: "failure" }>): Record<string, unknown> {
  if (result.kind === "complete") return completeToolResult(result);
  if (result.kind === "input_required") return { resultType: "input_required", inputRequests: result.inputRequests, ...(result.requestState === undefined ? {} : { requestState: result.requestState }) };
  return { resultType: result.extension, value: result.value, ...(result.requestState === undefined ? {} : { requestState: result.requestState }) };
}

export interface ModernDownstreamRequest {
  readonly method: string;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
  readonly context?: AuthenticatedContext;
  readonly rawRequest?: unknown;
  readonly requestBody?: Uint8Array;
  readonly url?: URL;
  readonly signal?: AbortSignal;
}

export interface ModernDownstreamResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly stream?: AsyncIterable<unknown>;
  readonly close?: () => void;
}

export interface ModernDownstreamAdapterOptions {
  readonly gateway: Gateway;
  readonly authenticate?: (request: ModernDownstreamRequest) => AuthenticatedContext | Promise<AuthenticatedContext | undefined> | undefined;
  readonly serverInfo?: Readonly<Record<string, unknown>>;
  readonly subscriptionByteBudget?: number;
  /**
   * Result-level `_meta` for catalog enumeration replies. The composition supplies the
   * authorization-partitioned catalog revision facts so a peer can prove the catalog it
   * pulled belongs to its own audience partition.
   */
  readonly resultMeta?: (context: AuthenticatedContext) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

function headersOf(input: Readonly<Record<string, string | string[] | undefined>> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) output[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return output;
}

function json(status: number, body: unknown): ModernDownstreamResponse {
  return Object.freeze({ status, headers: Object.freeze({ "Content-Type": "application/json" }), body });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function failureResponse(id: unknown, outcome: GatewayOutcome): ModernDownstreamResponse {
  if (!isGatewayFailure(outcome)) return json(200, { jsonrpc: "2.0", id, result: toProtocolResult(outcome) });
  const code = outcome.status === 401 ? -32001 : outcome.status === 403 ? -32003 : outcome.status === 404 ? -32004 : -32000;
  // Only the credential and throttling classes are HTTP-level signals. A failed tool call
  // is a JSON-RPC error on a 200 reply, so a peer reads the tagged outcome instead of
  // inferring it from a transport status.
  const status = outcome.status === 401 || outcome.status === 403 || outcome.status === 404 || outcome.status === 429 ? outcome.status : 200;
  return json(status, rpcError(id, code, outcome.message, { code: outcome.code, effectOutcome: outcome.effectOutcome }));
}

const EVENT_TYPE_BY_NOTIFICATION_METHOD: Readonly<Record<string, SubscriptionEvent["type"]>> = Object.freeze({
  "notifications/tools/list_changed": "tools/list_changed",
  "notifications/resources/list_changed": "resources/list_changed",
  "notifications/prompts/list_changed": "prompts/list_changed",
  "notifications/resources/updated": "resource/updated"
});

function subscriptionAuthority(context: AuthenticatedContext): string {
  return JSON.stringify({
    tenant: context.tenant,
    principal: context.principal,
    authGeneration: context.authGeneration,
    grant: context.grant
  });
}

function streamBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function notificationForEvent(event: SubscriptionEvent, subscriptionId: string | number): Record<string, unknown> | null {
  const method = Object.entries(EVENT_TYPE_BY_NOTIFICATION_METHOD)
    .find(([, type]) => type === event.type)?.[0];
  if (!method) return null;
  return {
    jsonrpc: "2.0",
    method,
    params: {
      ...(event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : { event: event.payload }),
      _meta: {
        "io.modelcontextprotocol/subscriptionId": subscriptionId,
        revision: event.revision
      }
    }
  };
}

function catalogItems(gateway: Gateway, context: AuthenticatedContext, kind: CatalogDescriptor["kind"]): readonly CatalogDescriptor[] {
  const items: CatalogDescriptor[] = [];
  let cursor: string | undefined;
  do {
    const page = gateway.catalog(context, { kind, limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/**
 * The operation surface an outlet routes: the concrete catalog operations, without the stable
 * categorized outlets themselves. The outlet descriptors are published in `tools/list` as the
 * entry points a client discovers, but an outlet is never an operation value: `arguments.operation`
 * carries a concrete operation id, and `meshrix.capabilities.list` enumerates the operations a
 * caller can address, so an outlet name must not appear there and must not resolve to a route.
 */
function operationItems(gateway: Gateway, context: AuthenticatedContext): readonly CatalogDescriptor[] {
  return catalogItems(gateway, context, "tool").filter((descriptor: CatalogDescriptor) : boolean => !CATEGORIZED_TOOL_NAMES.has(descriptor.publicName));
}

const MCP_CAPABILITY_OPERATIONS: ReadonlySet<string> = Object.freeze(new Set([
  "meshrix.capabilities.list",
  "meshrix.version",
  "meshrix.mcp.version"
]));

function matchesDescriptor(descriptor: CatalogDescriptor, value: string): boolean {
  return descriptor.publicName === value || descriptor.publicUri === value || descriptor.upstreamName === value || descriptor.upstreamUri === value;
}

function findDescriptor(gateway: Gateway, context: AuthenticatedContext, kind: CatalogDescriptor["kind"], value: string): CatalogDescriptor | undefined {
  return catalogItems(gateway, context, kind).find((descriptor) => matchesDescriptor(descriptor, value));
}

function descriptorOutlet(descriptor: CatalogDescriptor): string {  const meta = descriptor.metadata ?? {};
  const explicit = typeof meta.mcpOutlet === "string" ? meta.mcpOutlet.trim() : "";
  if (explicit) return explicit;
  return /^(operation_permission\.|gateway\.|external_services\.)/iu.test(metadataOperationId(descriptor)) ? MCP_GATEWAY_TOOL_NAME : MCP_DISCOVERY_TOOL_NAME;
}

function metadataOperationId(descriptor: CatalogDescriptor): string {
  const meta = descriptor.metadata ?? {};
  return typeof meta.operationId === "string" ? meta.operationId : "";
}

/**
 * The answer of an operation an outlet routed. A platform operation answers under the platform
 * envelope an MCP peer reads a governed operation result out of — the operation it executed as,
 * its public caller envelope, and the payload under `payload` — because the caller addressed the
 * outlet with an operation id and has to read which operation answered. A route that already
 * projects its own answer (an upstream operation projected as a tool) is passed through exactly
 * as the platform sink answered it, so a projection is never nested in a second envelope.
 */
function outletOperationAnswer({ outcome, descriptor, operation, envelope }: {
  readonly outcome: GatewayOutcome;
  readonly descriptor: CatalogDescriptor;
  readonly operation: string;
  readonly envelope: Readonly<Record<string, unknown>>;
}): GatewayOutcome {
  if (outcome.kind !== "complete") return outcome;
  if (descriptor.metadata?.kind !== "platform-operation") return outcome;
  return {
    ...outcome,
    value: {
      operation,
      ...mcpVersionInfo(),
      envelope: mcpEnvelopePublic({ ...envelope }),
      payload: outcome.value
    }
  };
}

function capabilityEnvelope(outlet: string, items: readonly CatalogDescriptor[]): Record<string, unknown> {
  const operations = items.map((descriptor) => ({
    name: descriptor.publicName,
    title: descriptor.description,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    annotations: descriptor.annotations,
    _meta: descriptor.metadata
  }));
  const outlets: Record<string, any> = {};
  for (const descriptor of items) {
    const name = descriptorOutlet(descriptor);
    const summary = outlets[name] ?? (outlets[name] = { toolName: name, operationCount: 0, operations: [] });
    summary.operationCount += 1;
    summary.operations.push(descriptor.publicName);
  }
  return mcpCompleteResult({
    content: [{ type: "text", text: JSON.stringify(operations, null, 2) }],
    structuredContent: { outlet, operations, outlets }
  });
}

export class ModernDownstreamAdapter {
  readonly #gateway: Gateway;
  readonly #authenticate?: ModernDownstreamAdapterOptions["authenticate"];
  readonly #serverInfo: Readonly<Record<string, unknown>>;
  readonly #subscriptionByteBudget: number;
  readonly #resultMeta?: ModernDownstreamAdapterOptions["resultMeta"];

  constructor(options: ModernDownstreamAdapterOptions) {
    this.#gateway = options.gateway;
    this.#authenticate = options.authenticate;
    this.#serverInfo = Object.freeze({ name: "meshrix-gateway", version: "0.1.0-alpha.1", ...(options.serverInfo ?? {}) });
    this.#subscriptionByteBudget = Math.max(1, Math.floor(options.subscriptionByteBudget ?? 1024 * 1024));
    this.#resultMeta = options.resultMeta;
  }

  /**
   * The stable categorized outlets (`meshrix.discovery` / `meshrix.gateway`) are the
   * advertised entry points: a caller names the outlet and passes the concrete operation
   * plus its input. The outlet is served here, and `tools/list` publishes the outlet
   * descriptors ahead of the authorized catalog tools, so the entry point is discoverable
   * while the operations an outlet routes stay the catalog's.
   */
  async #outletCall(context: AuthenticatedContext, request: ModernDownstreamRequest, id: unknown, outletName: string, params: Record<string, unknown>): Promise<ModernDownstreamResponse> {
    const args = isPlainRecord(params.arguments) ? params.arguments : {};
    const operation = typeof args.operation === "string" ? args.operation.trim() : "";
    if (!operation) return json(400, rpcError(id, -32602, `MCP outlet ${outletName} requires arguments.operation.`));
    const items = operationItems(this.#gateway, context);
    if (MCP_CAPABILITY_OPERATIONS.has(operation)) {
      return json(200, { jsonrpc: "2.0", id, result: capabilityEnvelope(outletName, items) });
    }
    const descriptor = items.find((item) => matchesDescriptor(item, operation));
    // An operation the caller's authorization does not publish is an authorization
    // outcome, not a routing miss, so it is refused as a JSON-RPC denial on a 200 reply.
    if (!descriptor) {
      return json(200, rpcError(id, -32004, `Operation ${operation} is denied: it is not published for this authorization.`, {
        code: "operation_not_published",
        operation,
        requestedTool: outletName,
        effectOutcome: "not_started"
      }));
    }
    const expectedOutlet = descriptorOutlet(descriptor);
    if (expectedOutlet !== outletName) {
      return json(200, rpcError(id, -32602, `Operation ${operation} must be called through ${expectedOutlet}, not ${outletName}.`, {
        code: "operation_outlet_mismatch",
        operation,
        requestedTool: outletName,
        expectedTool: expectedOutlet
      }));
    }
    const outcome = await this.#gateway.invoke(context, {
      routeRef: descriptor.route.logicalRoute,
      method: "tools/call",
      params: { ...params, name: descriptor.upstreamName ?? operation, arguments: isPlainRecord(args.input) ? args.input : {} },
      signal: request.signal,
      ...(typeof args.requestState === "string" ? { requestState: args.requestState } : {}),
      ...(Array.isArray(args.inputResponses) ? { inputResponses: args.inputResponses } : {})
    });
    return failureResponse(id, outletOperationAnswer({ outcome, descriptor, operation, envelope: args }));
  }

  async #catalogResultMeta(context: AuthenticatedContext): Promise<Record<string, unknown>> {
    if (!this.#resultMeta) return {};
    try {
      const meta = await this.#resultMeta(context);
      return meta && typeof meta === "object" ? meta : {};
    } catch {
      return {};
    }
  }

  async #reauthorizeSubscription(request: ModernDownstreamRequest, original: AuthenticatedContext): Promise<AuthenticatedContext | undefined> {
    if (!this.#authenticate) return original;
    try {
      const current = await this.#authenticate({ ...request, context: undefined });
      if (!current || subscriptionAuthority(current) !== subscriptionAuthority(original)) return undefined;
      return current;
    } catch {
      return undefined;
    }
  }

  #subscriptionResponse(request: ModernDownstreamRequest, context: AuthenticatedContext, id: unknown, params: Record<string, unknown>): ModernDownstreamResponse {
    const parsed = parseMcpSubscriptionNotifications(params);
    if (!parsed.ok) return json(400, rpcError(id, -32602, parsed.error));
    const methods = parsed.methods as readonly string[];
    if (methods.length === 0) return json(400, rpcError(id, -32602, "At least one supported MCP subscription notification is required."));
    const kinds = methods
      .map((method) => EVENT_TYPE_BY_NOTIFICATION_METHOD[method])
      .filter((kind): kind is SubscriptionEvent["type"] => typeof kind === "string");
    if (kinds.length === 0) return json(400, rpcError(id, -32602, "The requested MCP subscription notifications are not supported."));

    const subscription = this.#gateway.subscribe(context, kinds);
    const requestedId = mcpSubscriptionIdFromRequest(request.body);
    const subscriptionId = requestedId === "" ? subscription.id : requestedId;
    const unregisterNotificationPort = registerMcpGatewaySubscription({
      methods,
      grantId: (context.grant as Record<string, unknown>)?.id ?? (context.grant as Record<string, unknown>)?.grantId,
      publish: (event: SubscriptionEvent) => {
        (this.#gateway as Gateway & { publishEvent?: (eventContext: AuthenticatedContext, value: SubscriptionEvent) => void }).publishEvent?.(context, event);
      }
    });
    let closed = false;
    let abortListener: (() => void) | undefined;
    const close = (): void => {
      if (closed) return;
      closed = true;
      unregisterNotificationPort();
      subscription.close();
      if (abortListener && request.signal) request.signal.removeEventListener("abort", abortListener);
    };
    if (request.signal) {
      abortListener = close;
      if (request.signal.aborted) close();
      else request.signal.addEventListener("abort", abortListener, { once: true });
    }
    const stream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: (): AsyncIterator<unknown> => {
        const iterator = subscription.events[Symbol.asyncIterator]();
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            if (closed) return { done: true, value: undefined };
            const next = await iterator.next();
            if (next.done) {
              close();
              return { done: true, value: undefined };
            }
            const current = await this.#reauthorizeSubscription(request, context);
            const notification = current ? notificationForEvent(next.value, subscriptionId) : null;
            if (!notification || streamBytes(notification) > this.#subscriptionByteBudget) {
              close();
              return { done: true, value: undefined };
            }
            return { done: false, value: notification };
          },
          return: async (): Promise<IteratorResult<unknown>> => {
            close();
            await iterator.return?.();
            return { done: true, value: undefined };
          }
        };
      }
    };
    return Object.freeze({
      status: 200,
      headers: Object.freeze({
        "Content-Type": "application/json, text/event-stream",
        "MCP-Subscription-Id": String(subscriptionId)
      }),
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          subscriptionId,
          notifications: parsed.notifications,
          transport: "post-stream"
        }
      },
      stream,
      close
    });
  }

  async handle(request: ModernDownstreamRequest): Promise<ModernDownstreamResponse> {
    const headers = headersOf(request.headers);
    if (request.method.toUpperCase() !== "POST") return json(405, rpcError(null, -32600, "MCP gateway requires POST."));
    const contentType = headers["content-type"] ?? "application/json";
    if (!contentType.toLocaleLowerCase().startsWith("application/json")) return json(415, rpcError(null, -32700, "MCP gateway requires application/json."));
    if (Array.isArray(request.body)) return json(400, rpcError(null, -32600, "Batch JSON-RPC requests are not supported on this endpoint."));
    if (!isPlainRecord(request.body) || request.body.jsonrpc !== "2.0" || typeof request.body.method !== "string") return json(400, rpcError(null, -32600, "Invalid JSON-RPC request."));
    const id = request.body.id;
    const method = request.body.method;
    if (headers["mcp-method"] && headers["mcp-method"] !== method) return json(400, rpcError(id, -32600, "Mcp-Method does not match the JSON-RPC method."));
    if (headers["mcp-protocol-version"] && headers["mcp-protocol-version"] !== "2026-07-28") return json(400, rpcError(id, -32600, "Unsupported MCP protocol version."));
    // `server/discover` and `ping` are the unauthenticated handshake methods: a client
    // reads the discovery document before it holds a token.
    if (isUnauthenticatedMcpMethod(method)) {
      return json(200, { jsonrpc: "2.0", id, result: method === MCP_DISCOVER_METHOD ? mcpDiscoverResult({}) : { resultType: "complete" } });
    }
    let context: AuthenticatedContext | undefined;
    try {
      context = await this.#authenticate?.(request) ?? request.context;
    } catch (error) {
      const status = Number((error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode ?? 401);
      const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 401;
      const message = error instanceof Error ? error.message : "MCP authentication failed.";
      // The platform's reason code travels with the refusal, exactly as it does on a
      // denied invocation, so a peer reads why the credential was rejected instead of
      // inferring it from the transport status.
      const code = String((error as { code?: unknown })?.code ?? "").trim();
      return json(safeStatus, rpcError(id, safeStatus === 403 ? -32003 : -32001, message, code ? { code } : undefined));
    }
    if (!context) return json(401, rpcError(id, -32001, "Authenticated context is required."));
    if (method === "initialize") return json(200, { jsonrpc: "2.0", id, result: { protocolVersion: "2026-07-28", capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true }, subscriptions: { listen: true } }, serverInfo: this.#serverInfo } });
    if (method === "notifications/initialized" || method === "notifications/cancelled") return Object.freeze({ status: 202, headers: Object.freeze({}) });
    const params = isPlainRecord(request.body.params) ? request.body.params : {};
    if (method === MCP_SUBSCRIBE_METHOD) return this.#subscriptionResponse(request, context, id, params);
    if (method === "tools/list" || method === "resources/list" || method === "resources/templates/list" || method === "prompts/list") {
      const kind = method === "tools/list" ? "tool" : method === "resources/list" ? "resource" : method === "resources/templates/list" ? "resource_template" : "prompt";
      const page = this.#gateway.catalog(context, { kind, cursor: typeof params.cursor === "string" ? params.cursor : undefined, limit: typeof params.limit === "number" ? params.limit : 50 });
      const key = kind === "tool" ? "tools" : kind === "prompt" ? "prompts" : kind === "resource_template" ? "resourceTemplates" : "resources";
      const resultMeta = kind === "tool" ? await this.#catalogResultMeta(context) : {};
      return json(200, { jsonrpc: "2.0", id, result: { [key]: page.items.map((item) => kind === "tool" ? { name: item.publicName, description: item.description, inputSchema: item.inputSchema, _meta: item.metadata } : kind === "prompt" ? { name: item.publicName, description: item.description, _meta: item.metadata } : { uri: item.publicUri, name: item.publicName, description: item.description, _meta: item.metadata }), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), ...(Object.keys(resultMeta).length > 0 ? { _meta: resultMeta } : {}) } });
    }
    if (method === "tools/call") {
      const name = typeof params.name === "string" ? params.name : "";
      if (CATEGORIZED_TOOL_NAMES.has(name)) return await this.#outletCall(context, request, id, name, params);
      const descriptor = findDescriptor(this.#gateway, context, "tool", name);
      // The catalog is published per authorization: a name the caller's catalog does not
      // contain is refused as an authorization decision, not as a routing miss.
      if (!descriptor) {
        return json(403, rpcError(id, -32003, `Tool ${name} is denied: it is not published for this authorization.`, {
          code: "tool_not_published",
          tool: name,
          effectOutcome: "not_started"
        }));
      }
      if (headers["mcp-name"] && headers["mcp-name"] !== name && headers["mcp-name"] !== descriptor.publicName) return json(400, rpcError(id, -32600, "Mcp-Name does not match the requested tool."));
      const outcome = await this.#gateway.invoke(context, {
        routeRef: descriptor.route.logicalRoute,
        method,
        params: { ...params, name: descriptor.upstreamName ?? name },
        signal: request.signal,
        ...(typeof params.requestState === "string" ? { requestState: params.requestState } : {}),
        ...(Array.isArray(params.inputResponses) ? { inputResponses: params.inputResponses } : {})
      });
      return failureResponse(id, outcome);
    }
    if (method === "resources/read") {
      const uri = typeof params.uri === "string" ? params.uri : "";
      if (!this.#gateway.readResource) return json(501, rpcError(id, -32601, "Resource reads are unavailable."));
      return failureResponse(id, await this.#gateway.readResource(context, uri));
    }
    if (method === "prompts/get") {
      const name = typeof params.name === "string" ? params.name : "";
      if (!this.#gateway.getPrompt) return json(501, rpcError(id, -32601, "Prompt reads are unavailable."));
      return failureResponse(id, await this.#gateway.getPrompt(context, name, isPlainRecord(params.arguments) ? params.arguments : {}));
    }
    if (method === "completion/complete") {
      if (!this.#gateway.completePrompt) return json(501, rpcError(id, -32601, "Prompt completion is unavailable."));
      return failureResponse(id, await this.#gateway.completePrompt(context, params));
    }
    return json(400, rpcError(id, -32601, `Unsupported MCP method: ${method}`));
  }
}

export function createModernDownstreamAdapter(options: ModernDownstreamAdapterOptions): ModernDownstreamAdapter {
  return new ModernDownstreamAdapter(options);
}
