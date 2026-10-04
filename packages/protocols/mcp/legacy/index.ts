import type { AuthenticatedContext, RouteSnapshot, UpstreamPort, UpstreamRequest, UpstreamResponse } from "@meshrix/contracts/gateway";

export const LEGACY_MCP_VERSIONS = Object.freeze(["2025-03-26", "2025-06-18", "2025-11-25"] as const);

export interface LegacyTransport {
  send(input: { readonly request: Readonly<Record<string, unknown>>; readonly headers: Readonly<Record<string, string>>; readonly signal?: AbortSignal }): Promise<UpstreamResponse>;
  close?(): Promise<void>;
}

interface Session {
  sessionId?: string;
  promise?: Promise<void>;
  ready: boolean;
  lost: boolean;
}

function credentialHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([name, secret]) => typeof secret === "string" && /^(authorization|x-[a-z0-9-]+)$/iu.test(name)).map(([name, secret]) => [name, String(secret)]));
}

export class LegacyMcpAdapter implements UpstreamPort {
  readonly #version: string;
  readonly #transport: LegacyTransport;
  readonly #sessions = new Map<string, Session>();

  constructor(input: { readonly version: string; readonly transport: LegacyTransport }) {
    if (!(LEGACY_MCP_VERSIONS as readonly string[]).includes(input.version)) throw Object.assign(new Error("Unsupported legacy MCP version."), { code: "legacy_version_unsupported", status: 400 });
    this.#version = input.version;
    this.#transport = input.transport;
  }

  async invoke(input: { readonly context?: AuthenticatedContext; readonly request: UpstreamRequest; readonly route: RouteSnapshot; readonly credential?: unknown; readonly signal?: AbortSignal }): Promise<UpstreamResponse> {
    if (!input.context?.tenant || !input.context.principal) throw Object.assign(new Error("Legacy sessions require an authenticated subject."), { code: "legacy_context_required", status: 401 });
    const key = JSON.stringify([input.context.tenant, input.context.principal, input.context.authGeneration, input.context.grant.revision, input.context.credentialGeneration, input.route.endpointIdentity]);
    let session = this.#sessions.get(key);
    if (!session) {
      if (this.#sessions.size >= 1024) throw Object.assign(new Error("Legacy session capacity is exhausted."), { code: "legacy_session_capacity", status: 503 });
      session = { ready: false, lost: false }; this.#sessions.set(key, session);
    }
    if (session.lost) throw Object.assign(new Error("Legacy MCP session was lost; create a new context."), { code: "legacy_session_lost", status: 410 });
    const auth = credentialHeaders(input.credential);
    const headers = { "Content-Type": "application/json", "Mcp-Protocol-Version": this.#version, ...auth };
    if (!session.ready) {
      session.promise ??= (async () => {
        const initialized = await this.#transport.send({ request: { jsonrpc: "2.0", id: "legacy-init", method: "initialize", params: { protocolVersion: this.#version, capabilities: {}, clientInfo: { name: "meshrix-gateway", version: "0.1.0-alpha.1" } } }, headers, signal: input.signal });
        if (initialized.status >= 400) throw Object.assign(new Error("Legacy MCP initialization failed."), { code: "legacy_initialize_failed", status: initialized.status });
        const body = initialized.body as { result?: { protocolVersion?: unknown } };
        if (body?.result?.protocolVersion !== this.#version) throw Object.assign(new Error("Legacy MCP version was not negotiated."), { code: "legacy_version_unsupported", status: 502 });
        const sessionHeader = Object.entries(initialized.headers ?? {}).find(([name]) => name.toLowerCase() === "mcp-session-id")?.[1];
        if (sessionHeader) session.sessionId = sessionHeader;
        const acknowledged = await this.#transport.send({ request: { jsonrpc: "2.0", method: "notifications/initialized" }, headers: { ...headers, ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}) }, signal: input.signal });
        if (acknowledged.status >= 400) throw Object.assign(new Error("Legacy MCP initialized notification failed."), { code: "legacy_initialized_failed", status: acknowledged.status });
        session.ready = true;
      })().catch((error: unknown) => { session.lost = true; throw error; });
      await session.promise;
    }
    const params = input.request.requestState === undefined
      ? input.request.params
      : input.request.params && typeof input.request.params === "object" && !Array.isArray(input.request.params)
        ? { ...(input.request.params as Record<string, unknown>), requestState: input.request.requestState }
        : { value: input.request.params, requestState: input.request.requestState };
    try {
      const result = await this.#transport.send({ request: { jsonrpc: "2.0", id: input.request.id, method: input.request.method, params }, headers: { ...headers, ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}) }, signal: input.signal });
      if (result.status === 404 || result.status >= 500) session.lost = true;
      return result;
    } catch (error) {
      session.lost = true;
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#transport.close?.();
    this.#sessions.clear();
  }
}

export function createLegacyMcpAdapter(input: { readonly version: string; readonly transport: LegacyTransport }): LegacyMcpAdapter {
  return new LegacyMcpAdapter(input);
}
