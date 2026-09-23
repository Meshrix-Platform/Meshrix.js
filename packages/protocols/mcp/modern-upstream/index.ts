import type { RouteSnapshot, UpstreamPort, UpstreamRequest, UpstreamResponse } from "@meshrix/contracts/gateway";

export interface ModernUpstreamTransport {
  send(input: { readonly request: Readonly<Record<string, unknown>>; readonly headers: Readonly<Record<string, string>>; readonly signal?: AbortSignal }): Promise<UpstreamResponse>;
  close?(): Promise<void> | void;
}

export interface ModernWireRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
}

export function buildModernRequest(request: UpstreamRequest): ModernWireRequest {
  if (request.method === "initialize") throw Object.assign(new Error("Modern upstream requests do not use initialize sessions."), { code: "modern_initialize_forbidden", status: 400 });
  const original = request.params && typeof request.params === "object" && !Array.isArray(request.params) ? request.params as Record<string, unknown> : {};
  const applicationMeta = original._meta && typeof original._meta === "object" && !Array.isArray(original._meta) ? original._meta as Record<string, unknown> : {};
  let params: unknown = {
    ...original,
    _meta: {
      ...applicationMeta,
      "io.modelcontextprotocol/protocolVersion": request.protocolVersion,
      "io.modelcontextprotocol/clientInfo": { name: "meshrix-gateway", version: "0.1.0-alpha.1" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  };
  if (request.requestState !== undefined) {
    params = params && typeof params === "object" && !Array.isArray(params)
      ? { ...(params as Record<string, unknown>), requestState: request.requestState }
      : { value: params, requestState: request.requestState };
  }
  return Object.freeze({ jsonrpc: "2.0", id: request.id, method: request.method, params });
}

export class ModernUpstreamAdapter implements UpstreamPort {
  readonly #transport: ModernUpstreamTransport;
  readonly #clientInfo: Readonly<Record<string, unknown>>;
  readonly #discoveries = new Map<string, Promise<void>>();
  #closed = false;

  constructor(input: { readonly transport: ModernUpstreamTransport; readonly clientInfo?: Readonly<Record<string, unknown>> }) {
    this.#transport = input.transport;
    this.#clientInfo = Object.freeze({ name: "meshrix-gateway", version: "0.1.0-alpha.1", ...(input.clientInfo ?? {}) });
  }

  async invoke(input: { readonly request: UpstreamRequest; readonly route: RouteSnapshot; readonly credential?: unknown; readonly signal?: AbortSignal }): Promise<UpstreamResponse> {
    if (this.#closed) throw Object.assign(new Error("Modern upstream transport is closed."), { code: "modern_transport_closed", status: 503 });
    if (input.request.protocolVersion !== "2026-07-28") throw Object.assign(new Error("Modern upstream version is unsupported."), { code: "modern_version_unsupported", status: 502 });
    if (input.request.method !== "server/discover") {
      let discovery = this.#discoveries.get(input.request.protocolVersion);
      if (!discovery) {
        discovery = (async () => {
          const wire = buildModernRequest({ id: "gateway-discover", method: "server/discover", params: {}, protocolVersion: input.request.protocolVersion, headers: {} });
          const params = wire.params as Record<string, unknown>;
          const reply = await this.#transport.send({ request: { ...wire, params: { ...params, _meta: { ...(params._meta as Record<string, unknown>), "io.modelcontextprotocol/clientInfo": this.#clientInfo } } }, headers: { "Content-Type": "application/json", "Mcp-Protocol-Version": input.request.protocolVersion, "Mcp-Method": "server/discover" }, signal: input.signal });
          const body = reply.body as { result?: { supportedVersions?: unknown; resultType?: unknown } } | undefined;
          if (reply.status >= 400 || body?.result?.resultType !== "complete" || !Array.isArray(body.result.supportedVersions) || !body.result.supportedVersions.includes(input.request.protocolVersion)) throw Object.assign(new Error("Modern MCP version discovery failed."), { code: "modern_discovery_failed", status: 502 });
        })();
        this.#discoveries.set(input.request.protocolVersion, discovery);
      }
      await discovery;
    }
    const wire = buildModernRequest(input.request);
    const name = input.route.upstreamName;
    const headers = Object.freeze({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Method": input.request.method,
      "Mcp-Protocol-Version": input.request.protocolVersion,
      ...(name ? { "Mcp-Name": name } : {}),
      ...(input.credential && typeof input.credential === "object" && !Array.isArray(input.credential) ? Object.fromEntries(Object.entries(input.credential as Record<string, unknown>).filter(([key, value]) => typeof value === "string" && /^(authorization|x-[a-z0-9-]+)$/iu.test(key)).map(([key, value]) => [key, String(value)])) : {})
    });
    const params = wire.params as Record<string, unknown>;
    return this.#transport.send({ request: { ...wire, params: { ...params, _meta: { ...(params._meta as Record<string, unknown>), "io.modelcontextprotocol/clientInfo": this.#clientInfo } } }, headers, signal: input.signal });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#discoveries.clear();
    await this.#transport.close?.();
  }
}

export function createModernUpstreamAdapter(input: { readonly transport: ModernUpstreamTransport; readonly clientInfo?: Readonly<Record<string, unknown>> }): ModernUpstreamAdapter {
  return new ModernUpstreamAdapter(input);
}
