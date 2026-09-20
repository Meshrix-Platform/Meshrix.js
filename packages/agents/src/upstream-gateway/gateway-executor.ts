import type { AuthenticatedContext, Gateway, Invocation, GatewayOutcome } from "@meshrix/contracts/gateway";

/** Platform-facing execution port; no second upstream business executor. */
export function createGatewayExecutor(gateway: Gateway): Readonly<{
  execute(context: AuthenticatedContext, invocation: Invocation): Promise<GatewayOutcome>;
}> {
  return Object.freeze({ execute: (context, invocation) => gateway.invoke(context, invocation) });
}

