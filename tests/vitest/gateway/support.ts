import type { AuthenticatedContext, CatalogDescriptor, RouteSnapshot, UpstreamPort, UpstreamResponse } from "@meshrix/contracts/gateway";
import { createGateway, type GatewayOptions } from "@meshrix/gateway";
import { createGatewayPolicy } from "@meshrix/capabilities/gateway-policy";
import { createGatewayPermitAuthority } from "@meshrix/foundation/security/gateway-permit";
import { mcpModernJsonRpcMessage, mcpModernRequestHeaders } from "@meshrix/protocols/mcp/modern-downstream/protocol";

/** Tests deliberately inject governance; the distributed kernel has no platform fallback. */
export function createTestGateway(options: GatewayOptions = {}) {
  return createGateway({ policy: createGatewayPolicy(), permits: createGatewayPermitAuthority(), ...options });
}

export const context: AuthenticatedContext = Object.freeze({
  tenant: "tenant-demo",
  principal: "principal-demo",
  authGeneration: "auth-1",
  grant: Object.freeze({ revision: "grant-1", routes: "all" }),
  trace: Object.freeze({ traceparent: "00-demo" })
});

export function modernRequestMessage(method: string, id: string | number, params: Record<string, unknown> = {}, extraMeta: Record<string, unknown> = {}): Record<string, unknown> {
  return mcpModernJsonRpcMessage({ jsonrpc: "2.0", id, method, params }, extraMeta);
}

export function modernHttpRequest(method: string, id: string | number, params: Record<string, unknown> = {}, extraMeta: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) {
  const body = modernRequestMessage(method, id, params, extraMeta);
  return {
    method: "POST",
    headers: mcpModernRequestHeaders(body, { "content-type": "application/json", ...extraHeaders }),
    body
  };
}

export function route(overrides: Partial<RouteSnapshot> = {}): RouteSnapshot {
  return Object.freeze({
    logicalRoute: "route.demo",
    upstreamIdentity: "upstream.demo",
    endpointIdentity: "endpoint.demo",
    protocolVersion: "2026-07-28",
    schemaDigest: "schema-demo",
    policyRef: "policy-demo",
    revision: "route-1",
    effectClass: "read",
    operation: "tools/call",
    upstreamName: "demo",
    ...overrides
  });
}

export function descriptor(overrides: Partial<CatalogDescriptor> = {}): CatalogDescriptor {
  return Object.freeze({
    kind: "tool",
    publicName: "demo",
    upstreamName: "demo",
    description: "Demo tool",
    inputSchema: { type: "object" },
    route: route(),
    ...overrides
  });
}

export function response(body: unknown, status = 200): UpstreamResponse {
  return Object.freeze({ status, headers: Object.freeze({ "content-type": "application/json" }), body });
}

export class QueueUpstream implements UpstreamPort {
  readonly requests: Array<{ request: Parameters<UpstreamPort["invoke"]>[0]["request"]; route: RouteSnapshot }> = [];
  readonly #responses: Array<UpstreamResponse | Awaited<ReturnType<UpstreamPort["invoke"]>>>;
  readonly #handler?: (input: Parameters<UpstreamPort["invoke"]>[0]) => Promise<UpstreamResponse>;

  constructor(responses: Array<UpstreamResponse | Awaited<ReturnType<UpstreamPort["invoke"]>>> = [], handler?: (input: Parameters<UpstreamPort["invoke"]>[0]) => Promise<UpstreamResponse>) {
    this.#responses = responses;
    this.#handler = handler;
  }

  async invoke(input: Parameters<UpstreamPort["invoke"]>[0]): Promise<UpstreamResponse> {
    this.requests.push({ request: input.request, route: input.route });
    if (this.#handler) return this.#handler(input);
    const next = this.#responses.shift();
    if (!next) return response({ content: [{ type: "text", text: "ok" }] });
    return next as UpstreamResponse;
  }
}

export function key(): Uint8Array {
  return new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
}
