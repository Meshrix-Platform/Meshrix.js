/**
 * Per-operation billing-oriented counters.
 *
 * Two tiers are kept deliberately separate:
 * - `durable` counters are written to the Durable Object's SQLite storage at
 *   coarse transition points (admission, rejection, close, revoke, vault
 *   commits) so billed units survive hibernation eviction.
 * - `ephemeral` counters (per-message, per-byte, per-event) live in memory and
 *   reset on eviction; they are never fused into durable writes per frame.
 *
 * Both are exposed through the internal counters endpoint so engineering
 * checks can verify real reads/writes/events/bytes per useful operation.
 * Nothing here records payload content, nonces, signatures or credentials.
 */

export interface RelayCountersShape {
  storageReads: number;
  storageWrites: number;
  storageDeletes: number;
  alarmRuns: number;
  webSocketEvents: number;
  httpRequests: number;
  messagesIn: number;
  messagesOut: number;
  bytesIn: number;
  bytesOut: number;
  framesForwarded: number;
  framesDropped: number;
  flowCreditsGranted: number;
  rateLimitDrops: number;
  sessionsAdmitted: number;
  sessionsRejected: number;
  sessionsClosed: number;
  sessionsRevoked: number;
  sessionsRestored: number;
  directoryChecks: number;
  vaultReads: number;
  vaultWritesCommitted: number;
  vaultWritesConflicting: number;
  vaultWritesRefused: number;
  vaultFetches: number;
  vaultFetchRefusals: number;
}

export type RelayCounterKey = keyof RelayCountersShape;

export function emptyCounters(): RelayCountersShape {
  return {
    storageReads: 0,
    storageWrites: 0,
    storageDeletes: 0,
    alarmRuns: 0,
    webSocketEvents: 0,
    httpRequests: 0,
    messagesIn: 0,
    messagesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    framesForwarded: 0,
    framesDropped: 0,
    flowCreditsGranted: 0,
    rateLimitDrops: 0,
    sessionsAdmitted: 0,
    sessionsRejected: 0,
    sessionsClosed: 0,
    sessionsRevoked: 0,
    sessionsRestored: 0,
    directoryChecks: 0,
    vaultReads: 0,
    vaultWritesCommitted: 0,
    vaultWritesConflicting: 0,
    vaultWritesRefused: 0,
    vaultFetches: 0,
    vaultFetchRefusals: 0,
  };
}

const DURABLE_KEYS: readonly RelayCounterKey[] = Object.freeze([
  "storageReads",
  "storageWrites",
  "storageDeletes",
  "sessionsAdmitted",
  "sessionsRejected",
  "sessionsClosed",
  "sessionsRevoked",
  "sessionsRestored",
  "vaultWritesCommitted",
  "vaultWritesConflicting",
  "vaultWritesRefused",
  "vaultFetches",
  "vaultFetchRefusals",
]);

export class RelayCounters {
  private durable: RelayCountersShape;
  private ephemeral: RelayCountersShape = emptyCounters();
  private dirty = false;

  constructor(persisted?: Partial<RelayCountersShape> | null) {
    this.durable = { ...emptyCounters(), ...(persisted ?? {}) };
  }

  count(key: RelayCounterKey, amount: number = 1): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (DURABLE_KEYS.includes(key)) {
      this.durable[key] += amount;
      this.dirty = true;
    } else {
      this.ephemeral[key] += amount;
    }
  }

  /** Persist the durable tier; call only at bounded transition points. */
  async flush(put: (key: string, value: RelayCountersShape) => Promise<void>): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await put("counters", { ...this.durable });
  }

  snapshot(): RelayCountersShape {
    const merged = emptyCounters();
    for (const key of Object.keys(merged) as RelayCounterKey[]) {
      merged[key] = this.durable[key] + this.ephemeral[key];
    }
    return merged;
  }
}
