import { randomUUID } from "node:crypto";
import type { AuthenticatedContext } from "@meshrix/contracts/gateway";
import type { ModernDownstreamRequest, ModernDownstreamResponse } from "./index.ts";
import { registerMcpGrantSession } from "../notifications.ts";
import { MCP_PROTOCOL_VERSION } from "../adapter/http-mcp-adapter-constants.ts";

// This tools profile follows the initialize / initialized Streamable HTTP lifecycle.
// The published stateless modern profile keeps its own validation and wire format.
export const STANDARD_MCP_VERSIONS: readonly string[] = Object.freeze(["2025-11-25", "2025-06-18", "2025-03-26"]);
const METHODS = new Set(["ping", "tools/list", "tools/call"]);

type RequestId = string | number;
type Reply = ModernDownstreamResponse;
interface Session {
  readonly id: string;
  readonly version: string;
  readonly owner: string;
  readonly requests: Map<RequestId, AbortController>;
  initialized: boolean;
  streamClose?: () => void;
  unregister: () => void;
}
export interface StandardHttpOptions {
  readonly authenticate: (request: ModernDownstreamRequest, id: unknown) => Promise<AuthenticatedContext | Reply>;
  readonly dispatch: (request: ModernDownstreamRequest, context: AuthenticatedContext) => Promise<Reply>;
  readonly subscribe: (request: ModernDownstreamRequest, context: AuthenticatedContext, onAuthorizationLost: () => void) => Reply;
  readonly grantId: (context: AuthenticatedContext) => string;
  readonly serverInfo: Readonly<Record<string, unknown>>;
  readonly maxSessions?: number;
  readonly maxRequestsPerSession?: number;
}
function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}
function headerValues(request: ModernDownstreamRequest, name: string): Array<string | undefined> {
  return Object.entries(request.headers ?? {}).filter(([key]) => key.toLowerCase() === name).flatMap(([, value]) => Array.isArray(value) ? value : [value]);
}
function header(request: ModernDownstreamRequest, name: string): string {
  const values = headerValues(request, name);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : "";
}
function json(status: number, body?: unknown, headers: Record<string, string> = {}): Reply {
  return { status, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body }) };
}
function error(status: number, id: unknown, code: number, message: string): Reply {
  return json(status, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}
function owner(context: AuthenticatedContext): string {
  const authorization = context.metadata?.authorization as Record<string, any> | undefined;
  const key = authorization?.apiKeyAuthorization;
  // Session possession never authenticates a caller. Bind it to the credential
  // identity, while each operation still evaluates the current policy afresh.
  return JSON.stringify([context.tenant, context.principal, key?.keyId ?? context.grant.id ?? "", key?.credentialFingerprint ?? ""]);
}
function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("MCP admission capacity must be a positive integer.");
  return value;
}
export function isStandardHttpRequest(request: ModernDownstreamRequest): boolean {
  if ((request.transport ?? "streamable-http") !== "streamable-http") return false;
  const version = header(request, "mcp-protocol-version");
  const body = record(request.body) ? request.body : {};
  const meta = record(body.params?._meta) ? body.params._meta : {};
  // Never reinterpret a malformed modern envelope as a less strict standard one.
  if (version === MCP_PROTOCOL_VERSION || Object.hasOwn(meta, "io.modelcontextprotocol/protocolVersion") || Object.hasOwn(meta, "io.modelcontextprotocol/clientCapabilities")) return false;
  return body.method === "initialize" || Boolean(header(request, "mcp-session-id")) || STANDARD_MCP_VERSIONS.includes(version) || ["GET", "DELETE"].includes(request.method.toUpperCase());
}

/** Strip modern-only result semantics; unsupported continuations are explicit errors,
 * never an empty successful tool result or an automatic replay of the operation. */
export function standardHttpResult(reply: Reply, id: unknown): Reply {
  const body = record(reply.body) ? reply.body : null;
  if (!body) return reply;
  if (body.error) {
    // Authentication/admission remain HTTP refusals. Method/operation failures
    // are JSON-RPC responses so SDK clients receive their actual error code.
    return { ...reply, status: [401, 429, 503].includes(reply.status) ? reply.status : 200 };
  }
  if (!record(body.result)) return reply;
  const { resultType, ttlMs: _ttl, cacheScope: _scope, ...result } = body.result;
  if (resultType && resultType !== "complete") {
    return json(200, { jsonrpc: "2.0", id, error: { code: -32000, message: "This operation requires a protocol capability not negotiated by this session.", data: { code: "mcp_result_capability_required", resultType, ...(typeof result.requestState === "string" ? { requestState: result.requestState } : {}) } } });
  }
  if (Object.hasOwn(result, "structuredContent") && !record(result.structuredContent)) delete result.structuredContent;
  return { ...reply, body: { ...body, result } };
}

export class StandardHttpSessions {
  readonly #options: StandardHttpOptions;
  readonly #sessions = new Map<string, Session>();
  readonly #maxSessions: number;
  readonly #maxRequests: number;
  #closed = false;
  constructor(options: StandardHttpOptions) {
    this.#options = options;
    this.#maxSessions = positiveLimit(options.maxSessions, 1024);
    this.#maxRequests = positiveLimit(options.maxRequestsPerSession, 128);
  }
  #remove(session: Session): void {
    if (!this.#sessions.delete(session.id)) return;
    session.unregister();
    session.streamClose?.();
    for (const controller of session.requests.values()) controller.abort(new DOMException("MCP session closed.", "AbortError"));
    session.requests.clear();
  }
  close(): void {
    this.#closed = true;
    for (const session of this.#sessions.values()) this.#remove(session);
  }
  async handle(request: ModernDownstreamRequest): Promise<Reply> {
    const method = request.method.toUpperCase();
    const message = record(request.body) ? request.body : {};
    const id = message.id;
    if (["mcp-session-id", "mcp-protocol-version"].some(name => headerValues(request, name).length > 1)) return error(400, id, -32600, "Ambiguous MCP session or version header.");
    if (this.#closed) return error(503, id, -32000, "MCP gateway is closing.");
    if (!["POST", "GET", "DELETE"].includes(method)) return { ...error(405, id, -32600, "Unsupported MCP HTTP method."), headers: { Allow: "POST, GET, DELETE" } };
    if (method === "POST") {
      if (!header(request, "content-type").toLowerCase().startsWith("application/json")) return error(415, id, -32600, "MCP requires application/json.");
      const accept = header(request, "accept").toLowerCase().split(",").map(value => value.trim().split(";")[0]);
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return error(406, id, -32600, "MCP requires acceptance of application/json and text/event-stream.");
      if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || Object.hasOwn(message, "id") && !requestId(id) || message.params !== undefined && !record(message.params)) return error(400, null, -32600, "Invalid JSON-RPC request.");
    }
    if (method === "GET" && !header(request, "accept").toLowerCase().split(",").some(value => value.trim().split(";")[0] === "text/event-stream")) return error(406, null, -32600, "MCP notifications require text/event-stream.");
    const params = record(message.params) ? message.params : {};
    const initializing = method === "POST" && message.method === "initialize";
    if (initializing && (!requestId(id) || typeof params.protocolVersion !== "string" || !params.protocolVersion || !record(params.capabilities) || !record(params.clientInfo) || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string")) return error(400, id, -32602, "Invalid MCP initialization parameters.");
    const sessionId = header(request, "mcp-session-id");
    const session = this.#sessions.get(sessionId);
    if (initializing && sessionId) return error(400, id, -32600, "Initialize requires a new session.");
    if (!initializing && !session) return error(sessionId ? 404 : 400, id, -32000, sessionId ? "MCP session not found." : "Mcp-Session-Id is required.");
    const version = header(request, "mcp-protocol-version");
    if (session && headerValues(request, "mcp-protocol-version").length > 0 && version !== session.version) return error(400, id, -32600, "MCP protocol version does not match this session.");
    // Reserve before asynchronous authentication so a concurrent, authenticated
    // cancellation can reach a request still in admission. No effect runs here.
    let controller: AbortController | undefined;
    if (session && method === "POST" && requestId(id)) {
      if (session.requests.has(id)) return error(400, id, -32600, "Duplicate in-flight request id.");
      if (session.requests.size >= this.#maxRequests) return error(429, id, -32000, "MCP request capacity is unavailable.");
      controller = new AbortController();
      session.requests.set(id, controller);
    }
    const onAbort = (): void => { controller?.abort(request.signal?.reason); };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    try {
      const authenticated = await this.#options.authenticate(request, id);
      if ("status" in authenticated) return authenticated;
      if (this.#closed) return error(503, id, -32000, "MCP gateway is closing.");
      if (request.signal?.aborted) return error(499, id, -32000, "MCP request was cancelled.");
      if (initializing) {
        if (this.#sessions.size >= this.#maxSessions) return error(429, id, -32000, "MCP session capacity is unavailable.");
        const negotiated = STANDARD_MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : STANDARD_MCP_VERSIONS[0];
        const created: Session = { id: randomUUID(), version: negotiated, owner: owner(authenticated), initialized: false, requests: new Map(), unregister: () => {} };
        this.#sessions.set(created.id, created);
        created.unregister = registerMcpGrantSession(this.#options.grantId(authenticated), () => this.#remove(created));
        return json(200, { jsonrpc: "2.0", id, result: { protocolVersion: negotiated, capabilities: { tools: { listChanged: true } }, serverInfo: this.#options.serverInfo } }, { "Mcp-Session-Id": created.id });
      }
      if (!session || this.#sessions.get(session.id) !== session || session.owner !== owner(authenticated)) return error(404, id, -32000, "MCP session not found.");
      if (method === "DELETE") { this.#remove(session); return json(200); }
      if (method === "POST" && !Object.hasOwn(message, "id")) {
        if (message.method === "notifications/initialized") session.initialized = true;
        else if (message.method === "notifications/cancelled" && session.initialized && requestId(params.requestId)) session.requests.get(params.requestId)?.abort(new DOMException("MCP request cancelled by the client.", "AbortError"));
        return json(202);
      }
      if (!session.initialized) return error(400, id, -32600, "MCP session is not initialized.");
      if (method === "GET") {
        if (session.streamClose) return error(409, null, -32000, "An MCP notification stream is already open.");
        const result = this.#options.subscribe(request, authenticated, () => this.#remove(session));
        if (!result.stream) return result;
        const close = (): void => { if (session.streamClose === close) session.streamClose = undefined; result.close?.(); };
        session.streamClose = close;
        return { ...result, notificationProfile: "standard", subscriptionContext: authenticated, close };
      }
      if (!METHODS.has(message.method)) return error(200, id, -32601, "Method not found.");
      if (message.method === "tools/call" && (typeof params.name !== "string" || !params.name || params.arguments !== undefined && !record(params.arguments))) return error(200, id, -32602, "Invalid tool call parameters.");
      if (message.method === "tools/list" && params.cursor !== undefined && typeof params.cursor !== "string") return error(200, id, -32602, "Invalid catalog cursor.");
      if (controller?.signal.aborted) return error(200, id, -32000, "MCP request was cancelled.");
      if (message.method === "ping") return json(200, { jsonrpc: "2.0", id, result: {} });
      try {
        return standardHttpResult(await this.#options.dispatch({ ...request, signal: controller?.signal ?? request.signal }, authenticated), id);
      } catch (failure) {
        const code = (failure as { code?: unknown })?.code;
        if (["catalog_cursor_invalid", "catalog_cursor_forbidden", "catalog_cursor_expired"].includes(String(code))) return error(200, id, -32602, "Invalid catalog cursor.");
        return error(200, id, -32603, "MCP request could not be completed.");
      }
    } finally {
      if (session && controller && session.requests.get(id) === controller) session.requests.delete(id);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}
