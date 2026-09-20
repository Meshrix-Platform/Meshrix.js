import type { AuthenticatedContext, Gateway, Invocation, GatewayOutcome } from "@meshrix/contracts/gateway";

/** Thin protocol-neutral adapter used by platform HTTP/MCP assembly. */
export function createGatewayProtocolAdapter(gateway: Gateway): Readonly<{
  invoke(context: AuthenticatedContext, invocation: Invocation): Promise<GatewayOutcome>;
  catalog(context: AuthenticatedContext, query?: Parameters<Gateway["catalog"]>[1]): ReturnType<Gateway["catalog"]>;
}> {
  return Object.freeze({
    invoke: (context, invocation) => gateway.invoke(context, invocation),
    catalog: (context, query) => gateway.catalog(context, query)
  });
}

