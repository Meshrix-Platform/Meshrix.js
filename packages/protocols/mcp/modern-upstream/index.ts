import type { RouteSnapshot, UpstreamPort, UpstreamRequest, UpstreamResponse } from "@meshrix/contracts/gateway";

export interface ModernUpstreamTransport {
  send(input: { readonly request: Readonly<Record<string, unknown>>; readonly headers: Readonly<Record<string, string>>; readonly signal?: AbortSignal }): Promise<UpstreamResponse>;
}

export interface ModernWireRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
}

export function buildModernRequest(request: UpstreamRequest): ModernWireRequest {
  if (request.method === "initialize") throw Object.assign(new Error("Modern upstream requests do not use initialize sessions."), { code: "modern_initialize_forbidden", status: 400 });
  let params: unknown = request.params;
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

  constructor(input: { readonly transport: ModernUpstreamTransport; readonly clientInfo?: Readonly<Record<string, unknown>> }) {
    this.#transport = input.transport;
    this.#clientInfo = Object.freeze({ name: "meshrix-gateway", version: "0.1.0-alpha.1", ...(input.clientInfo ?? {}) });
  }

  async invoke(input: { readonly request: UpstreamRequest; readonly route: RouteSnapshot; readonly credential?: unknown; readonly signal?: AbortSignal }): Promise<UpstreamResponse> {
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
    return this.#transport.send({ request: { ...wire, clientInfo: this.#clientInfo }, headers, signal: input.signal });
  }
}

export function createModernUpstreamAdapter(input: { readonly transport: ModernUpstreamTransport; readonly clientInfo?: Readonly<Record<string, unknown>> }): ModernUpstreamAdapter {
  return new ModernUpstreamAdapter(input);
}
