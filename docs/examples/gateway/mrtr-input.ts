import { createGateway } from "@meshrix/gateway";
import { createGatewayPolicy } from "@meshrix/capabilities/gateway-policy";
import { createGatewayPermitAuthority } from "@meshrix/foundation/security/gateway-permit";

const context = { tenant: "demo", principal: "operator", authGeneration: "auth-1", grant: { revision: "grant-1", routes: ["tool.prepare"], methods: ["tools/call"] } };
const gateway = createGateway({
  policy: createGatewayPolicy(),
  permits: createGatewayPermitAuthority(),
  continuationKey: new Uint8Array(32).fill(7),
  descriptors: [{ kind: "tool", publicName: "prepare", route: { logicalRoute: "tool.prepare", upstreamIdentity: "local", endpointIdentity: "local.prepare", protocolVersion: "2026-07-28", schemaDigest: "none", policyRef: "default", revision: "route-1", effectClass: "read" } }],
  upstream: { async invoke({ request }) { return request.requestState ? { status: 200, body: { resultType: "complete", value: { accepted: request.params } } } : { status: 200, body: { resultType: "input_required", requestState: "upstream-state", inputRequests: [{ id: "confirm" }] } }; } }
});
await gateway.start();
const first = await gateway.invoke(context, { routeRef: "tool.prepare", method: "tools/call", params: {} });
if (first.kind === "input_required" && first.requestState) console.log(await gateway.continue(context, first.requestState, { confirm: { action: "accept" } }));
await gateway.close();
