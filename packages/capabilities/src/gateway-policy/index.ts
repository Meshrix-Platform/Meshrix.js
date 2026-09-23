import type {
  AuthenticatedContext,
  AuthoritySnapshot,
  GatewayPolicyPort,
  Invocation,
  RouteSnapshot
} from "@meshrix/contracts/gateway";
import { createHash } from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";

export interface GatewayPolicyOptions {
  readonly revision?: string;
  readonly now?: () => number;
  readonly requireApprovalFor?: readonly string[];
}

function grantList(grant: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = grant[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function grants(grant: Readonly<Record<string, unknown>>, keys: readonly string[], candidate: string): boolean {
  const present = keys.filter((key) => Object.hasOwn(grant, key));
  if (present.length === 0) return false;
  return present.every((key) => {
    const selection = grant[key];
    return selection === "all" || Array.isArray(selection) && selection.includes(candidate) ||
      !!selection && typeof selection === "object" && !Array.isArray(selection) &&
        (selection as Record<string, unknown>).mode === "all" ||
      !!selection && typeof selection === "object" && !Array.isArray(selection) &&
        (selection as Record<string, unknown>).mode === "only" &&
        Array.isArray((selection as Record<string, unknown>).items) &&
        ((selection as Record<string, unknown>).items as unknown[]).includes(candidate);
  });
}

function approved(context: AuthenticatedContext, route: RouteSnapshot, invocation: Invocation, now: number): boolean {
  // Only the authentication/approval port may populate platform-owned metadata.
  const evidence = context.metadata?.approval;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  const value = evidence as Record<string, unknown>;
  return value.status === "approved" && typeof value.ref === "string" && value.ref.length > 0 &&
    value.tenant === context.tenant && value.principal === context.principal &&
    value.target === route.endpointIdentity && value.routeRef === route.logicalRoute &&
    value.routeRevision === route.revision && value.grantRevision === String(context.grant.revision ?? context.authGeneration) &&
    value.method === invocation.method &&
    value.inputDigest === createHash("sha256").update(canonicalJson({ method: invocation.method, routeRef: route.logicalRoute, params: invocation.params })).digest("hex") &&
    typeof value.expiresAt === "number" && value.expiresAt > now;
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
    if (!grants(grant, ["routes", "routeRefs"], route.logicalRoute)) return { allowed: false, reasonCode: "route_not_granted", message: "The current grant does not include this route." };
    const routeMethodMatches = route.operation === invocation.method || route.operation === "prompts/get" && invocation.method === "completion/complete" && grants(grant, ["methods"], invocation.method);
    if (route.operation && !routeMethodMatches || !route.operation && !Object.hasOwn(grant, "methods") || Object.hasOwn(grant, "methods") && !grants(grant, ["methods"], invocation.method)) return { allowed: false, reasonCode: "method_not_granted", message: "The route and current grant do not include this method." };
    if (route.effectClass === "unknown" && !grantList(grant, "effectClasses").includes("unknown")) return { allowed: false, reasonCode: "effect_class_unknown", message: "The route effect class has not been classified." };
    if (this.#requireApprovalFor.has(route.effectClass) && !approved(context, route, invocation, this.#now())) return { allowed: false, reasonCode: "approval_required", message: "This effect requires a verified approval." };
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
      ...(approved(context, route, invocation, now) ? { approvalRef: (context.metadata!.approval as { ref: string }).ref, approvalRevision: String((context.metadata!.approval as { revision?: unknown }).revision ?? "") } : {}),
      expiresAt
    });
    return { allowed: true, authority };
  }

  revalidate(input: { readonly context: AuthenticatedContext; readonly invocation: Invocation; readonly route: RouteSnapshot; readonly authority: AuthoritySnapshot }) {
    const decision = this.decide(input);
    if (!decision.allowed) return decision;
    if (decision.authority?.target !== input.authority.target || decision.authority.policyRevision !== input.authority.policyRevision || decision.authority.grantRevision !== input.authority.grantRevision || decision.authority.approvalRef !== input.authority.approvalRef || decision.authority.approvalRevision !== input.authority.approvalRevision) return { allowed: false, reasonCode: "authority_changed", message: "The current authority no longer matches the prepared invocation." };
    return decision;
  }
}

export function createGatewayPolicy(options: GatewayPolicyOptions = {}): DefaultGatewayPolicy {
  return new DefaultGatewayPolicy(options);
}
