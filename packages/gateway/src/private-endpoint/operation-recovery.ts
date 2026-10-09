import type { AuthenticatedContext, ExecutionPermit, PermitAuthorityPort } from "@meshrix/contracts/gateway";
import {
  PRIVATE_RELAY_NOT_STARTED_EVIDENCE,
  PRIVATE_RELAY_OPERATION_STATES,
  PRIVATE_RELAY_RESULT_AVAILABILITY,
  PRIVATE_RELAY_UNCERTAIN_RETRY_ALLOWED,
  createOperationStatus,
  parseOperationQuery,
  parseOperationStatus
} from "@meshrix/contracts/private-relay";

/**
 * GatewayOperationRecovery implementation owner.
 *
 * This projection turns the endpoint's canonical execution state (the permit
 * authority plus the endpoint-side operation ledger) into the wire-level
 * `operation-query`/`operation-status` schema. It never upgrades certainty:
 * a missing record after the caller actually submitted work, an evicted
 * ledger, or a lost acknowledgement all stay explicit unknown states instead
 * of "not_started".
 */

/** Endpoint-side per-operation record, written by the dispatch pipeline. */
export type EndpointOperationPhase =
  | "received"
  | "refused_pre_dispatch"
  | "dispatched"
  | "settled_complete"
  | "settled_failed"
  | "outcome_uncertain"
  | "cancel_intent";

export interface EndpointOperationRecord {
  readonly operationId: string;
  readonly principalRef: string;
  readonly generation: number;
  readonly phase: EndpointOperationPhase;
  /** Permit receipt id when dispatch reached the permit authority. */
  readonly permitId?: string;
  /** Result still fetchable by the caller. */
  readonly resultAvailable: boolean;
  readonly recordedAt: number;
  readonly updatedAt: number;
}

export interface EndpointOperationLedger {
  record(operationId: string, record: EndpointOperationRecord): void;
  get(operationId: string): EndpointOperationRecord | undefined;
  /**
   * True when the id was recorded before but its record is no longer
   * retrievable (evicted). Implementations that cannot track evictions may
   * omit this; the recovery service then conservatively answers doubt only
   * for ids it can prove were seen.
   */
  seen?(operationId: string): boolean;
  /**
   * True once the eviction watermark itself overflowed: the ledger can no
   * longer prove any absent id was never submitted, so absent-record answers
   * must degrade to doubt instead of the retryable not_started.
   */
  overflowed?(): boolean;
  transition(operationId: string, phase: EndpointOperationPhase, extra?: Partial<EndpointOperationRecord>): EndpointOperationRecord | undefined;
  /** Bounded retention: evict oldest records beyond the cap, tracking what was dropped. */
  evictExpired(now: number): number;
  size(): number;
}

export interface OperationRecoveryOptions {
  readonly permits?: Pick<PermitAuthorityPort, "lookup">;
  readonly maxOperations?: number;
  readonly retentionMs?: number;
  readonly now?: () => number;
}

export class InMemoryOperationLedger implements EndpointOperationLedger {
  readonly #records = new Map<string, EndpointOperationRecord>();
  /**
   * Tombstone watermark covering the recovery retention window: every evicted
   * operation id stays known-evicted for as long as a record would have
   * lived, so an evicted record is never reported as "never submitted". If
   * the watermark itself exceeds the hard cap, `overflowed()` turns true and
   * every absent-record answer degrades to doubt rather than licensing replay.
   */
  readonly #tombstones = new Map<string, number>();
  #tombstoneOverflowed = false;
  readonly #now: () => number;
  readonly #retentionMs: number;
  readonly #max: number;

  constructor(options: { now?: () => number; retentionMs?: number; maxOperations?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#retentionMs = options.retentionMs ?? 15 * 60_000;
    this.#max = Math.min(1_000_000, Math.max(1, options.maxOperations ?? 4_096));
  }

  /** True when the operation was recorded before but its record was evicted. */
  seen(operationId: string): boolean {
    return this.#records.has(operationId) || this.#tombstones.has(operationId);
  }

  /** True once the tombstone watermark overflowed its hard cap. */
  overflowed(): boolean {
    return this.#tombstoneOverflowed;
  }

  record(operationId: string, record: EndpointOperationRecord): void {
    if (this.#records.size >= this.#max && !this.#records.has(operationId)) {
      const oldest = this.#records.keys().next().value;
      if (oldest) this.#evict(oldest);
    }
    this.#records.set(operationId, record);
  }

  #evict(operationId: string, now = this.#now()): void {
    this.#records.delete(operationId);
    this.#tombstones.set(operationId, now);
    // Tombstones live as long as the record would have — that is the window a
    // recovery dialogue can legitimately ask about. Beyond the hard cap the
    // watermark overflows instead of silently re-licensing "not_started".
    if (this.#tombstones.size > this.#max * 2) {
      const oldest = this.#tombstones.keys().next().value;
      if (oldest !== undefined) this.#tombstones.delete(oldest);
      this.#tombstoneOverflowed = true;
    }
  }

  get(operationId: string): EndpointOperationRecord | undefined {
    return this.#records.get(operationId);
  }

  transition(operationId: string, phase: EndpointOperationPhase, extra: Partial<EndpointOperationRecord> = {}): EndpointOperationRecord | undefined {
    const current = this.#records.get(operationId);
    if (!current) return undefined;
    const updated = Object.freeze({ ...current, ...extra, phase, updatedAt: this.#now() });
    this.#records.set(operationId, updated);
    return updated;
  }

  evictExpired(now: number): number {
    let dropped = 0;
    for (const [id, record] of this.#records) {
      if (record.updatedAt + this.#retentionMs <= now) {
        this.#evict(id, now);
        dropped += 1;
      }
    }
    for (const [id, evictedAt] of this.#tombstones) {
      if (evictedAt + this.#retentionMs <= now) this.#tombstones.delete(id);
    }
    return dropped;
  }

  size(): number {
    return this.#records.size;
  }
}

export function createOperationLedger(options: { now?: () => number; retentionMs?: number; maxOperations?: number } = {}): InMemoryOperationLedger {
  return new InMemoryOperationLedger(options);
}

/**
 * Authorize + answer an `operation-query`. Authorization binds the original
 * principal: a query for another principal's operation is refused by returning
 * `status_unavailable` rather than leaking existence.
 */
export class GatewayOperationRecoveryService {
  readonly #ledger: EndpointOperationLedger;
  readonly #permits?: Pick<PermitAuthorityPort, "lookup">;
  readonly #now: () => number;

  constructor(options: OperationRecoveryOptions & { readonly ledger?: EndpointOperationLedger } = {}) {
    this.#ledger = options.ledger ?? new InMemoryOperationLedger(options);
    this.#permits = options.permits;
    this.#now = options.now ?? Date.now;
  }

  get ledger(): EndpointOperationLedger {
    return this.#ledger;
  }

  markReceived(operationId: string, input: { principalRef: string; generation: number }): EndpointOperationRecord {
    const now = this.#now();
    const record = Object.freeze({
      operationId,
      principalRef: input.principalRef,
      // operation-status revision requires a positive generation.
      generation: Math.max(1, Math.floor(input.generation) || 1),
      phase: "received" as const,
      resultAvailable: false,
      recordedAt: now,
      updatedAt: now
    });
    this.#ledger.record(operationId, record);
    return record;
  }

  markRefused(operationId: string): void {
    this.#ledger.transition(operationId, "refused_pre_dispatch");
  }

  markDispatched(operationId: string, permitId: string): void {
    this.#ledger.transition(operationId, "dispatched", { permitId });
  }

  markSettled(operationId: string, outcome: "complete" | "failed", resultAvailable: boolean): void {
    this.#ledger.transition(operationId, outcome === "complete" ? "settled_complete" : "settled_failed", { resultAvailable });
  }

  markUncertain(operationId: string): void {
    this.#ledger.transition(operationId, "outcome_uncertain");
  }

  markCancelIntent(operationId: string): void {
    this.#ledger.transition(operationId, "cancel_intent");
  }

  /**
   * Answer a wire-level operation-query. `context` must be the authenticated
   * caller context; generation mismatches refuse as stale authority.
   */
  async answerQuery(query: unknown, context: AuthenticatedContext): Promise<ReturnType<typeof createOperationStatus> | null> {
    const parsed = parseOperationQuery(query);
    if (!parsed) return null;
    this.#ledger.evictExpired(this.#now());

    const record = this.#ledger.get(String(parsed.operationId));

    // Authorization before any external lookup: the query must bind the
    // original principal and generation.
    const principalRef = context.principal;
    if (record && record.principalRef !== principalRef) {
      return createOperationStatus({ operationId: parsed.operationId, state: "status_unavailable", resultAvailability: "not_applicable", revision: parsed.generation });
    }
    if (record && record.generation > Number(parsed.generation)) {
      return createOperationStatus({ operationId: parsed.operationId, state: "status_unavailable", resultAvailability: "not_applicable", revision: record.generation });
    }

    // A previously seen id — or any id once the watermark overflowed — with
    // no retrievable record is doubt, never "never submitted": the latter
    // would license replay of billed work.
    if (!record && (this.#ledger.seen?.(String(parsed.operationId)) === true || this.#ledger.overflowed?.() === true)) {
      return createOperationStatus({ operationId: parsed.operationId, state: "dispatched_in_doubt", resultAvailability: "not_applicable", revision: parsed.generation });
    }

    // The permit lookup (a receipt point-query in production) is only read
    // when the ledger cannot settle the answer on its own: no local record,
    // or a record still parked at "dispatched".
    const permit = !record || record.phase === "dispatched"
      ? await this.#permits?.lookup?.({ receiptId: String(parsed.operationId), context })
      : undefined;
    const state = this.#resolveState(record, permit);
    const status = {
      operationId: String(parsed.operationId),
      state: state.state,
      notStartedEvidence: state.notStartedEvidence,
      resultAvailability: state.resultAvailability,
      revision: record?.generation ?? Number(parsed.generation)
    };
    return createOperationStatus(status) ?? null;
  }

  #resolveState(
    record: EndpointOperationRecord | undefined,
    permit: ExecutionPermit | undefined
  ): { state: string; notStartedEvidence?: string; resultAvailability: string } {
    if (!record) {
      if (permit) {
        return permit.state === "outcome_unknown"
          ? { state: "dispatched_in_doubt", resultAvailability: "not_applicable" }
          : { state: "in_progress", resultAvailability: "not_applicable" };
      }
      // Never received at this endpoint — honest local evidence only.
      return { state: "not_started", notStartedEvidence: "local_never_submitted", resultAvailability: "not_applicable" };
    }
    switch (record.phase) {
      case "received":
        return { state: "in_progress", resultAvailability: "not_applicable" };
      case "refused_pre_dispatch":
        return { state: "not_started", notStartedEvidence: "endpoint_refused_pre_dispatch", resultAvailability: "not_applicable" };
      case "dispatched":
        if (!permit) {
          // Canonical permit state lost/evicted after dispatch — stay honest.
          return { state: "dispatched_in_doubt", resultAvailability: "not_applicable" };
        }
        if (permit.state === "outcome_unknown") {
          return { state: "dispatched_in_doubt", resultAvailability: "not_applicable" };
        }
        if (permit.state === "consumed") {
          return { state: "in_progress", resultAvailability: "not_applicable" };
        }
        return { state: "status_unavailable", resultAvailability: "not_applicable" };
      case "outcome_uncertain":
        return { state: "dispatched_in_doubt", resultAvailability: "not_applicable" };
      case "settled_complete":
        return record.resultAvailable
          ? { state: "completed", resultAvailability: "available" }
          : { state: "completed_result_unavailable", resultAvailability: "unavailable" };
      case "settled_failed":
        return { state: "failed", resultAvailability: "not_applicable" };
      case "cancel_intent":
        return { state: "cancel_intent_recorded", resultAvailability: "not_applicable" };
      default:
        return { state: "status_unavailable", resultAvailability: "not_applicable" };
    }
  }
}

export function createOperationRecoveryService(options: OperationRecoveryOptions & { ledger?: EndpointOperationLedger } = {}): GatewayOperationRecoveryService {
  return new GatewayOperationRecoveryService(options);
}

/** True when the wire-level status permits a caller to retry the operation. */
export function wireStatusAllowsRetry(status: unknown): boolean {
  const parsed = parseOperationStatus(status);
  return parsed?.state === "not_started";
}

export const OPERATION_RECOVERY_STATES = PRIVATE_RELAY_OPERATION_STATES;
export const NOT_STARTED_EVIDENCE = PRIVATE_RELAY_NOT_STARTED_EVIDENCE;
export const RESULT_AVAILABILITY = PRIVATE_RELAY_RESULT_AVAILABILITY;
export const UNCERTAIN_RETRY_ALLOWED = PRIVATE_RELAY_UNCERTAIN_RETRY_ALLOWED;
