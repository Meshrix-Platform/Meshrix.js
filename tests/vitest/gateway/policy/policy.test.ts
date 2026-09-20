import { describe, expect, it } from "vitest";
import { createGatewayPolicy } from "@meshrix/capabilities/gateway-policy";
import { createGatewayPermitAuthority } from "@meshrix/foundation/security/gateway-permit";
import { context, route } from "../support";

describe("gateway policy and final permit", () => {
  it("[CASE-G02] [CASE-G03] treats destructive as high-risk approval by default and allows explicit approval", () => {
    const policy = createGatewayPolicy();
    const invocation = { routeRef: "write", method: "tools/call", params: {} };
    const denied = policy.decide({ context, invocation, route: route({ logicalRoute: "write", effectClass: "destructive" }) });
    expect(denied).toMatchObject({ allowed: false, reasonCode: "approval_required" });
    const allowed = policy.decide({ context: { ...context, grant: { revision: "g", approved: true } }, invocation, route: route({ logicalRoute: "write", effectClass: "destructive" }) });
    expect(allowed.allowed).toBe(true);
  });

  it("[CASE-G06] consumes a permit once and rejects a binding mismatch at the protected sink", () => {
    const policy = createGatewayPolicy();
    const invocation = { routeRef: "route.demo", method: "tools/call", params: { value: 1 } };
    const target = route();
    const decision = policy.decide({ context, invocation, route: target });
    if (!decision.allowed || !decision.authority) throw new Error("expected authority");
    const prepared = { invocation, route: target, authority: decision.authority, inputDigest: "input-1" };
    const permits = createGatewayPermitAuthority();
    const permit = permits.issue({ context, prepared, audience: target.endpointIdentity });
    expect(permits.consume({ permit, context, prepared }).state).toBe("consumed");
    expect(() => permits.consume({ permit, context, prepared })).toThrowError(/replayed/u);
    const otherRoute = route({ endpointIdentity: "other-endpoint" });
    const secondPermit = permits.issue({ context, prepared, audience: target.endpointIdentity });
    expect(() => permits.consume({ permit: secondPermit, context, prepared: { ...prepared, route: otherRoute } })).toThrowError(/binding/u);
  });
});
