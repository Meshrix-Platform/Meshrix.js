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

export interface DurableGatewayReceiptPort {
  recordIssued(permit: ExecutionPermit): void;
  recordConsumed(receiptId: string): void;
  recordUnknown(receiptId: string): void;
  lookupReceipt(receiptId: string): ExecutionPermit | undefined;
}

export class GatewayPermitAuthority implements PermitAuthorityPort {
  readonly #now: () => number;
  readonly #permits = new Map<string, ExecutionPermit>();
  readonly #maxRecords: number;
  readonly #receiptLedger?: DurableGatewayReceiptPort;
  #nextExpiry = Number.POSITIVE_INFINITY;

  constructor(options: { readonly now?: () => number; readonly maxRecords?: number; readonly receiptLedger?: DurableGatewayReceiptPort } = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxRecords = Math.min(1_000_000, Math.max(1, Math.floor(options.maxRecords ?? 10_000)));
    this.#receiptLedger = options.receiptLedger;
  }

  #sweepExpired(now: number): void {
    if (now < this.#nextExpiry) return;
    this.#nextExpiry = Number.POSITIVE_INFINITY;
    for (const [id, permit] of this.#permits) {
      if (permit.expiresAt <= now) this.#permits.delete(id);
      else this.#nextExpiry = Math.min(this.#nextExpiry, permit.expiresAt);
    }
  }

  issue(input: { readonly context: AuthenticatedContext; readonly prepared: PreparedInvocation; readonly audience: string }): ExecutionPermit {
    const now = this.#now();
    if (!Number.isFinite(input.prepared.authority.expiresAt) || input.prepared.authority.expiresAt <= now) deny("permit_authority_expired", "Prepared authority is not current.");
    this.#sweepExpired(now);
    if (this.#permits.size >= this.#maxRecords) deny("permit_capacity", "Execution permit capacity is exhausted.", 503);
    const grantRevision = input.prepared.authority.grantRevision;
    const permit: ExecutionPermit = Object.freeze({
      id: `permit_${randomUUID()}`,
      audience: input.audience,
      target: input.prepared.route.endpointIdentity,
      tenant: input.context.tenant,
      principal: input.context.principal,
      inputDigest: input.prepared.inputDigest,
      routeRevision: input.prepared.route.revision,
      routeRef: input.prepared.route.logicalRoute,
      grantRevision,
      policyRevision: input.prepared.authority.policyRevision,
      ...(input.prepared.invocation.operationKey ? { operationKey: input.prepared.invocation.operationKey } : {}),
      expiresAt: Math.min(input.prepared.authority.expiresAt, now + 60_000),
      state: "issued"
    });
    this.#receiptLedger?.recordIssued(permit);
    this.#permits.set(permit.id, permit);
    this.#nextExpiry = Math.min(this.#nextExpiry, permit.expiresAt);
    return permit;
  }

  consume(input: { readonly permit: ExecutionPermit; readonly context: AuthenticatedContext; readonly prepared: PreparedInvocation }): ExecutionPermit {
    const current = this.#permits.get(input.permit.id);
    if (!current || current.state !== "issued") deny("permit_replayed", "Execution permit is unknown, replayed, or already consumed.");
    const now = this.#now();
    if (current.expiresAt <= now) { this.#permits.delete(current.id); deny("permit_expired", "Execution permit has expired."); }
    if (current.tenant !== input.context.tenant || current.principal !== input.context.principal) deny("permit_subject_mismatch", "Execution permit subject does not match.");
    if (current.target !== input.prepared.route.endpointIdentity || current.routeRevision !== input.prepared.route.revision || current.routeRef && current.routeRef !== input.prepared.route.logicalRoute || current.inputDigest !== input.prepared.inputDigest || current.grantRevision !== input.prepared.authority.grantRevision || current.policyRevision !== input.prepared.authority.policyRevision) deny("permit_binding_mismatch", "Execution permit binding does not match the final sink.");
    const consumed = Object.freeze({ ...current, state: "consumed" as const });
    this.#receiptLedger?.recordConsumed(current.id);
    this.#permits.set(current.id, consumed);
    return consumed;
  }

  markOutcomeUnknown(permit: ExecutionPermit): ExecutionPermit {
    const current = this.#permits.get(permit.id);
    if (!current || current.state !== "consumed") deny("permit_unknown", "Execution permit is unavailable.");
    const updated = Object.freeze({ ...current, state: "outcome_unknown" as const });
    this.#receiptLedger?.recordUnknown(current.id);
    this.#permits.set(updated.id, updated);
    return updated;
  }

  lookup(input: { readonly receiptId: string; readonly context: AuthenticatedContext }): ExecutionPermit | undefined {
    this.#sweepExpired(this.#now());
    const permit = this.#permits.get(input.receiptId) ?? this.#receiptLedger?.lookupReceipt(input.receiptId);
    if (!permit || permit.expiresAt <= this.#now() || input.context.grant.revoked === true ||
        permit.tenant !== input.context.tenant || permit.principal !== input.context.principal ||
        permit.grantRevision !== String(input.context.grant.revision ?? input.context.authGeneration)) return undefined;
    return permit;
  }

  stats(): Readonly<{ records: number; unknown: number; maxRecords: number }> {
    this.#sweepExpired(this.#now());
    return Object.freeze({ records: this.#permits.size, unknown: [...this.#permits.values()].filter((permit) => permit.state === "outcome_unknown").length, maxRecords: this.#maxRecords });
  }

  digestFor(input: PreparedInvocation): string {
    return createHash("sha256").update(canonicalJson({ route: input.route.logicalRoute, method: input.invocation.method, params: input.invocation.params })).digest("hex");
  }
}

export function createGatewayPermitAuthority(options: { readonly now?: () => number; readonly maxRecords?: number; readonly receiptLedger?: DurableGatewayReceiptPort } = {}): GatewayPermitAuthority {
  return new GatewayPermitAuthority(options);
}
