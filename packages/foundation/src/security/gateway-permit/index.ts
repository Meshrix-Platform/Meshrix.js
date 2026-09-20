import { createHash, randomUUID } from "node:crypto";
import type {
  AuthenticatedContext,
  ExecutionPermit,
  PermitAuthorityPort,
  PreparedInvocation
} from "@meshrix/contracts/gateway";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";

function deny(code: string, message: string, status = 403): never {
  throw Object.assign(new Error(message), { code, status });
}

export class GatewayPermitAuthority implements PermitAuthorityPort {
  readonly #now: () => number;
  readonly #permits = new Map<string, ExecutionPermit>();

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  issue(input: { readonly context: AuthenticatedContext; readonly prepared: PreparedInvocation; readonly audience: string }): ExecutionPermit {
    const now = this.#now();
    const grantRevision = input.prepared.authority.grantRevision;
    const permit: ExecutionPermit = Object.freeze({
      id: `permit_${randomUUID()}`,
      audience: input.audience,
      target: input.prepared.route.endpointIdentity,
      tenant: input.context.tenant,
      principal: input.context.principal,
      inputDigest: input.prepared.inputDigest,
      routeRevision: input.prepared.route.revision,
      grantRevision,
      policyRevision: input.prepared.authority.policyRevision,
      ...(input.prepared.invocation.operationKey ? { operationKey: input.prepared.invocation.operationKey } : {}),
      expiresAt: Math.min(input.prepared.authority.expiresAt, now + 60_000),
      state: "issued"
    });
    this.#permits.set(permit.id, permit);
    return permit;
  }

  consume(input: { readonly permit: ExecutionPermit; readonly context: AuthenticatedContext; readonly prepared: PreparedInvocation }): ExecutionPermit {
    const current = this.#permits.get(input.permit.id);
    if (!current || current.state !== "issued") deny("permit_replayed", "Execution permit is unknown, replayed, or already consumed.");
    const now = this.#now();
    if (current.expiresAt <= now) { this.#permits.delete(current.id); deny("permit_expired", "Execution permit has expired."); }
    if (current.tenant !== input.context.tenant || current.principal !== input.context.principal) deny("permit_subject_mismatch", "Execution permit subject does not match.");
    if (current.target !== input.prepared.route.endpointIdentity || current.routeRevision !== input.prepared.route.revision || current.inputDigest !== input.prepared.inputDigest) deny("permit_binding_mismatch", "Execution permit binding does not match the final sink.");
    const consumed = Object.freeze({ ...current, state: "consumed" as const });
    this.#permits.set(current.id, consumed);
    return consumed;
  }

  markOutcomeUnknown(permit: ExecutionPermit): ExecutionPermit {
    const current = this.#permits.get(permit.id);
    if (!current || current.state !== "consumed") deny("permit_unknown", "Execution permit is unavailable.");
    const updated = Object.freeze({ ...current, state: "outcome_unknown" as const });
    this.#permits.set(updated.id, updated);
    return updated;
  }

  digestFor(input: PreparedInvocation): string {
    return createHash("sha256").update(canonicalJson({ route: input.route.logicalRoute, method: input.invocation.method, params: input.invocation.params })).digest("hex");
  }
}

export function createGatewayPermitAuthority(options: { readonly now?: () => number } = {}): GatewayPermitAuthority {
  return new GatewayPermitAuthority(options);
}
