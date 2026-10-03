import { createGateway } from "@meshrix/gateway";
import { createExampleAuthority, exampleContext } from "./example-ports.ts";

const context = exampleContext("tool.echo");
const { policy, permits } = createExampleAuthority();
const gateway = createGateway({
  policy,
  permits,
  descriptors: [{ kind: "tool", publicName: "echo", upstreamName: "echo", route: { logicalRoute: "tool.echo", upstreamIdentity: "local", endpointIdentity: "local.echo", protocolVersion: "2026-07-28", schemaDigest: "none", policyRef: "default", revision: "route-1", effectClass: "read" } }],
  upstream: { async invoke({ request }) { return { status: 200, body: { resultType: "complete", value: request.params } }; } }
});
await gateway.start();
console.log(await gateway.invoke(context, { routeRef: "tool.echo", method: "tools/call", params: { traceId: "business", value: "kept" } }));
await gateway.close();
