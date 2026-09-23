import { createId, deepFreeze, nonEmptyText } from "../utils.ts";

export type BusinessContextState = "created" | "active" | "draining" | "closed" | "lost" | "expired";

export interface BusinessContext {
  readonly handle: string;
  readonly tenant: string;
  readonly principal: string;
  readonly grantRevision: string;
  readonly credentialGeneration: string;
  readonly routeRef: string;
  readonly state: BusinessContextState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lostReason?: string;
}

export interface BusinessContextStoreOptions {
  readonly now?: () => number;
  /** Maximum active contexts for one tenant/principal/upstream route partition. */
  readonly maxActive?: number;
  readonly maxActivePerSubjectUpstream?: number;
  readonly maxTombstones?: number;
  readonly tombstoneRetentionMs?: number;
  readonly maxActiveTotal?: number;
  readonly activeLifetimeMs?: number;
}

export interface BusinessContextRetentionBudget {
  readonly maxActivePerSubjectUpstream: number;
  readonly maxTombstones: number;
  readonly tombstoneRetentionMs: number;
  readonly retainedTombstones: number;
  readonly activePartitions: number;
  readonly activeContexts: number;
  readonly maxActiveTotal: number;
  readonly activeLifetimeMs: number;
}

const TERMINAL_STATES: ReadonlySet<BusinessContextState> = new Set(["closed", "lost", "expired"]);

function activePartition(context: Pick<BusinessContext, "tenant" | "principal" | "routeRef">): string {
  return `${context.tenant}\u0000${context.principal}\u0000${context.routeRef}`;
}

export class BusinessContextStore {
  readonly #contexts = new Map<string, BusinessContext>();
  readonly #activeByPartition = new Map<string, number>();
  readonly #now: () => number;
  readonly #maxActivePerSubjectUpstream: number;
  readonly #maxTombstones: number;
  readonly #tombstoneRetentionMs: number;
  readonly #maxActiveTotal: number;
  readonly #activeLifetimeMs: number;
  #activeCount = 0;

  constructor(options: BusinessContextStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxActivePerSubjectUpstream = Math.max(1, Math.floor(options.maxActivePerSubjectUpstream ?? options.maxActive ?? 8));
    this.#maxTombstones = Math.max(1, Math.floor(options.maxTombstones ?? 1_024));
    this.#tombstoneRetentionMs = Math.max(1, Math.floor(options.tombstoneRetentionMs ?? 5 * 60_000));
    this.#maxActiveTotal = Math.max(1, Math.floor(options.maxActiveTotal ?? 4096));
    this.#activeLifetimeMs = Math.max(1, Math.floor(options.activeLifetimeMs ?? 60 * 60_000));
  }

  create(input: Omit<BusinessContext, "handle" | "state" | "createdAt" | "updatedAt">): BusinessContext {
    this.sweep();
    const partition = activePartition(input);
    const active = this.#activeByPartition.get(partition) ?? 0;
    if (active >= this.#maxActivePerSubjectUpstream) throw Object.assign(new Error("Business context capacity is exhausted for this subject and upstream route."), { code: "context_capacity_exceeded", status: 429 });
    if (this.#activeCount >= this.#maxActiveTotal) throw Object.assign(new Error("Global business context capacity is exhausted."), { code: "context_capacity_exceeded", status: 429 });
    const now = this.#now();
    const context = deepFreeze({ ...input, handle: createId("ctx"), state: "active" as const, createdAt: now, updatedAt: now });
    this.#contexts.set(context.handle, context);
    this.#activeByPartition.set(partition, active + 1);
    this.#activeCount += 1;
    return context;
  }

  get(handle: string): BusinessContext {
    this.sweep();
    const normalized = nonEmptyText(handle, "context handle");
    const context = this.#contexts.get(normalized);
    if (!context) throw Object.assign(new Error("Business context is unknown or expired."), { code: "context_unknown", status: 410 });
    if (context.state === "lost" || context.state === "expired" || context.state === "closed") {
      throw Object.assign(new Error("Business context is no longer recoverable."), { code: `context_${context.state}`, status: 410 });
    }
    return context;
  }

  markLost(handle: string, reason: string): BusinessContext {
    return this.#transition(handle, "lost", reason);
  }

  expire(handle: string): BusinessContext {
    return this.#transition(handle, "expired");
  }

  close(handle: string): BusinessContext {
    return this.#transition(handle, "closed");
  }

  list(): readonly BusinessContext[] {
    this.sweep();
    return Object.freeze([...this.#contexts.values()]);
  }

  sweep(now = this.#now()): number {
    const expiry = now - this.#tombstoneRetentionMs;
    let removed = 0;
    for (const [handle, context] of this.#contexts) {
      if ((context.state === "active" || context.state === "created") && context.createdAt + this.#activeLifetimeMs <= now) {
        const partition = activePartition(context);
        const count = this.#activeByPartition.get(partition) ?? 0;
        if (count <= 1) this.#activeByPartition.delete(partition);
        else this.#activeByPartition.set(partition, count - 1);
        this.#activeCount -= 1;
        this.#contexts.set(handle, deepFreeze({ ...context, state: "expired" as const, updatedAt: now }));
      }
      const current = this.#contexts.get(handle)!;
      if (TERMINAL_STATES.has(current.state) && current.updatedAt <= expiry) {
        this.#contexts.delete(handle);
        removed += 1;
      }
    }
    const tombstones = [...this.#contexts.values()]
      .filter((context) => TERMINAL_STATES.has(context.state))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const context of tombstones.slice(0, Math.max(0, tombstones.length - this.#maxTombstones))) {
      this.#contexts.delete(context.handle);
      removed += 1;
    }
    return removed;
  }

  retentionBudget(): BusinessContextRetentionBudget {
    this.sweep();
    return Object.freeze({
      maxActivePerSubjectUpstream: this.#maxActivePerSubjectUpstream,
      maxTombstones: this.#maxTombstones,
      tombstoneRetentionMs: this.#tombstoneRetentionMs,
      retainedTombstones: [...this.#contexts.values()].filter((context) => TERMINAL_STATES.has(context.state)).length,
      activePartitions: this.#activeByPartition.size,
      activeContexts: this.#activeCount,
      maxActiveTotal: this.#maxActiveTotal,
      activeLifetimeMs: this.#activeLifetimeMs
    });
  }

  #transition(handle: string, state: BusinessContextState, lostReason?: string): BusinessContext {
    const current = this.#contexts.get(handle);
    if (!current) throw Object.assign(new Error("Business context is unknown."), { code: "context_unknown", status: 404 });
    const next = deepFreeze({ ...current, state, updatedAt: this.#now(), ...(lostReason ? { lostReason } : {}) });
    this.#contexts.set(handle, next);
    const currentIsActive = current.state === "active" || current.state === "created";
    const nextIsActive = next.state === "active" || next.state === "created";
    if (currentIsActive !== nextIsActive) {
      this.#activeCount += nextIsActive ? 1 : -1;
      const partition = activePartition(current);
      const count = this.#activeByPartition.get(partition) ?? 0;
      if (nextIsActive) this.#activeByPartition.set(partition, count + 1);
      else if (count <= 1) this.#activeByPartition.delete(partition);
      else this.#activeByPartition.set(partition, count - 1);
    }
    this.sweep();
    return next;
  }
}

export function createBusinessContextStore(options: BusinessContextStoreOptions = {}): BusinessContextStore {
  return new BusinessContextStore(options);
}
