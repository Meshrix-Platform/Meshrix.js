import type {
  AuthenticatedContext,
  AuthoritySnapshot,
  GatewayPolicyPort,
  Invocation,
  RouteSnapshot
} from "@meshrix/contracts/gateway";

export interface GatewayPolicyOptions {
  readonly revision?: string;
  readonly now?: () => number;
  readonly requireApprovalFor?: readonly string[];
}

function grantList(grant: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = grant[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function includesOrEmpty(values: readonly string[], candidate: string): boolean {
  return values.length === 0 || values.includes(candidate);
}

export class DefaultGatewayPolicy implements GatewayPolicyPort {
  readonly revision: string;
  readonly #now: () => number;
  readonly #requireApprovalFor: ReadonlySet<string>;

  constructor(options: GatewayPolicyOptions = {}) {
    this.revision = options.revision ?? "policy-1";
    this.#now = options.now ?? Date.now;
    this.#requireApprovalFor = new Set(options.requireApprovalFor ?? ["destructive"]);
  }

  decide(input: { readonly context: AuthenticatedContext; readonly invocation: Invocation; readonly route: RouteSnapshot }) {
    const { context, invocation, route } = input;
    const grant = context.grant;
    if (grant.revoked === true) return { allowed: false, reasonCode: "grant_revoked", message: "The current grant has been revoked." };
    if (typeof grant.expiresAt === "number" && grant.expiresAt <= this.#now()) return { allowed: false, reasonCode: "grant_expired", message: "The current grant has expired." };
    if (typeof grant.tenant === "string" && grant.tenant !== context.tenant || typeof grant.tenantId === "string" && grant.tenantId !== context.tenant) return { allowed: false, reasonCode: "grant_tenant_mismatch", message: "The grant is bound to another tenant." };
    if (typeof grant.principal === "string" && grant.principal !== context.principal || typeof grant.principalId === "string" && grant.principalId !== context.principal) return { allowed: false, reasonCode: "grant_principal_mismatch", message: "The grant is bound to another principal." };
    if (!includesOrEmpty(grantList(grant, "routes"), route.logicalRoute) && !includesOrEmpty(grantList(grant, "routeRefs"), route.logicalRoute)) return { allowed: false, reasonCode: "route_not_granted", message: "The current grant does not include this route." };
    if (!includesOrEmpty(grantList(grant, "methods"), invocation.method)) return { allowed: false, reasonCode: "method_not_granted", message: "The current grant does not include this method." };
    if (route.effectClass === "unknown" && !grantList(grant, "effectClasses").includes("unknown")) return { allowed: false, reasonCode: "effect_class_unknown", message: "The route effect class has not been classified." };
    if (this.#requireApprovalFor.has(route.effectClass) && !grant.approved && !grant.approvalRef && !grant.approvals) return { allowed: false, reasonCode: "approval_required", message: "This effect requires an explicit approval." };
    const now = this.#now();
    const expiresAt = Math.min(
      typeof grant.expiresAt === "number" && grant.expiresAt > now ? grant.expiresAt : now + 15_000,
      now + 60_000
    );
    const authority: AuthoritySnapshot = Object.freeze({
      decisionRef: `decision:${this.revision}:${context.authGeneration}:${route.revision}:${invocation.method}`,
      grantRevision: String(grant.revision ?? context.authGeneration),
      policyRevision: this.revision,
      target: route.endpointIdentity,
      effectClass: route.effectClass,
      ...(typeof grant.approvalRef === "string" ? { approvalRef: grant.approvalRef } : {}),
      ...(typeof grant.approvalRevision === "string" ? { approvalRevision: grant.approvalRevision } : {}),
      expiresAt
    });
    return { allowed: true, authority };
  }

  revalidate(input: { readonly context: AuthenticatedContext; readonly invocation: Invocation; readonly route: RouteSnapshot; readonly authority: AuthoritySnapshot }) {
    const decision = this.decide(input);
    if (!decision.allowed) return decision;
    if (decision.authority?.target !== input.authority.target || decision.authority.policyRevision !== input.authority.policyRevision) return { allowed: false, reasonCode: "authority_changed", message: "The current authority no longer matches the prepared invocation." };
    return decision;
  }
}

export function createGatewayPolicy(options: GatewayPolicyOptions = {}): DefaultGatewayPolicy {
  return new DefaultGatewayPolicy(options);
}
