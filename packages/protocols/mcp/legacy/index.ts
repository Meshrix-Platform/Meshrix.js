import type { RouteSnapshot, UpstreamPort, UpstreamRequest, UpstreamResponse } from "@meshrix/contracts/gateway";

export const LEGACY_MCP_VERSIONS = Object.freeze(["2025-03-26", "2025-06-18", "2025-11-25"] as const);

export interface LegacyTransport {
  send(input: { readonly request: Readonly<Record<string, unknown>>; readonly headers: Readonly<Record<string, string>>; readonly signal?: AbortSignal }): Promise<UpstreamResponse>;
  close?(): Promise<void>;
}

export class LegacyMcpAdapter implements UpstreamPort {
  readonly #version: string;
  readonly #transport: LegacyTransport;
  #sessionId: string | undefined;
  #initialized = false;

  constructor(input: { readonly version: string; readonly transport: LegacyTransport }) {
    if (!(LEGACY_MCP_VERSIONS as readonly string[]).includes(input.version)) throw Object.assign(new Error("Unsupported legacy MCP version."), { code: "legacy_version_unsupported", status: 400 });
    this.#version = input.version;
    this.#transport = input.transport;
  }

  async invoke(input: { readonly request: UpstreamRequest; readonly route: RouteSnapshot; readonly credential?: unknown; readonly signal?: AbortSignal }): Promise<UpstreamResponse> {
    if (!this.#initialized) {
      const initialized = await this.#transport.send({ request: { jsonrpc: "2.0", id: "legacy-init", method: "initialize", params: { protocolVersion: this.#version, capabilities: {}, clientInfo: { name: "meshrix-gateway", version: "0.1.0-alpha.1" } } }, headers: { "Content-Type": "application/json", "Mcp-Protocol-Version": this.#version }, signal: input.signal });
      if (initialized.status >= 400) return initialized;
      const body = initialized.body as { result?: { sessionId?: unknown }; sessionId?: unknown };
      const sessionId = body?.result?.sessionId ?? body?.sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) this.#sessionId = sessionId;
      this.#initialized = true;
    }
    const params = input.request.requestState === undefined
      ? input.request.params
      : input.request.params && typeof input.request.params === "object" && !Array.isArray(input.request.params)
        ? { ...(input.request.params as Record<string, unknown>), requestState: input.request.requestState }
        : { value: input.request.params, requestState: input.request.requestState };
    return this.#transport.send({ request: { jsonrpc: "2.0", id: input.request.id, method: input.request.method, params }, headers: { "Content-Type": "application/json", "Mcp-Protocol-Version": this.#version, ...(this.#sessionId ? { "Mcp-Session-Id": this.#sessionId } : {}) }, signal: input.signal });
  }

  async close(): Promise<void> {
    await this.#transport.close?.();
    this.#sessionId = undefined;
    this.#initialized = false;
  }
}

export function createLegacyMcpAdapter(input: { readonly version: string; readonly transport: LegacyTransport }): LegacyMcpAdapter {
  return new LegacyMcpAdapter(input);
}
