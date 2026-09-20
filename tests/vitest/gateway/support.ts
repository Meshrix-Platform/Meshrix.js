import type { AuthenticatedContext, CatalogDescriptor, RouteSnapshot, UpstreamPort, UpstreamResponse } from "@meshrix/contracts/gateway";

export const context: AuthenticatedContext = Object.freeze({
  tenant: "tenant-demo",
  principal: "principal-demo",
  authGeneration: "auth-1",
  grant: Object.freeze({ revision: "grant-1" }),
  trace: Object.freeze({ traceparent: "00-demo" })
});

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

