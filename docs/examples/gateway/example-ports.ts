import { randomUUID } from "node:crypto";
import type {
  AuthenticatedContext,
  ExecutionPermit,
  GatewayPolicyPort,
  PermitAuthorityPort
} from "@meshrix/gateway";

/** Small in-memory ports for runnable examples; production hosts supply their own authority. */
export function createExampleAuthority() : {
  policy: GatewayPolicyPort;
  permits: PermitAuthorityPort;
} {
  const permitsById = new Map<string, ExecutionPermit>();
  const policy: GatewayPolicyPort = {
    revision: "example-policy-v1",
    decide({ context, route }) {
      const routes = Array.isArray(context.grant.routes) ? context.grant.routes : [];
      if (!routes.includes(route.logicalRoute)) return { allowed: false, reasonCode: "route_not_granted" };
      return {
        allowed: true,
        authority: {
          decisionRef: "example-decision",
          grantRevision: String(context.grant.revision ?? context.authGeneration),
          policyRevision: "example-policy-v1",
          target: route.endpointIdentity,
          effectClass: route.effectClass,
          expiresAt: Date.now() + 30_000
        }
      };
    }
  };

  const permits: PermitAuthorityPort = {
    issue({ context, prepared, audience }) {
      const permit: ExecutionPermit = Object.freeze({
        id: randomUUID(),
        audience,
        target: prepared.authority.target,
        tenant: context.tenant,
        principal: context.principal,
        inputDigest: prepared.inputDigest,
        routeRevision: prepared.route.revision,
        routeRef: prepared.route.logicalRoute,
        grantRevision: prepared.authority.grantRevision,
        policyRevision: prepared.authority.policyRevision,
        ...(prepared.invocation.operationKey ? { operationKey: prepared.invocation.operationKey } : {}),
        expiresAt: prepared.authority.expiresAt,
        state: "issued"
      });
      permitsById.set(permit.id, permit);
      return permit;
    },
    consume({ permit, context, prepared }) {
      const current = permitsById.get(permit.id);
      if (
        !current ||
        current.state !== "issued" ||
        current.tenant !== context.tenant ||
        current.principal !== context.principal ||
        current.inputDigest !== prepared.inputDigest ||
        current.expiresAt <= Date.now()
      ) {
        throw new Error("Example permit is invalid or already consumed.");
      }
      const consumed: ExecutionPermit = Object.freeze({ ...current, state: "consumed" });
      permitsById.set(consumed.id, consumed);
      return consumed;
    }
  };
  return { policy, permits };
}

export function exampleContext(route: string) : AuthenticatedContext {
  return {
    tenant: "demo",
    principal: "operator",
    authGeneration: "auth-1",
    grant: { revision: "grant-1", routes: [route] }
  };
}
