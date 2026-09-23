import { createGateway } from "@meshrix/gateway";
import { createGatewayPolicy } from "@meshrix/capabilities/gateway-policy";
import { createGatewayPermitAuthority } from "@meshrix/foundation/security/gateway-permit";

const context = { tenant: "demo", principal: "operator", authGeneration: "auth-1", grant: { revision: "grant-1", routes: ["tool.echo"], methods: ["tools/call"] } };
const gateway = createGateway({
  policy: createGatewayPolicy(),
  permits: createGatewayPermitAuthority(),
  descriptors: [{ kind: "tool", publicName: "echo", upstreamName: "echo", route: { logicalRoute: "tool.echo", upstreamIdentity: "local", endpointIdentity: "local.echo", protocolVersion: "2026-07-28", schemaDigest: "none", policyRef: "default", revision: "route-1", effectClass: "read" } }],
  upstream: { async invoke({ request }) { return { status: 200, body: { resultType: "complete", value: request.params } }; } }
});
await gateway.start();
console.log(await gateway.invoke(context, { routeRef: "tool.echo", method: "tools/call", params: { traceId: "business", value: "kept" } }));
await gateway.close();
