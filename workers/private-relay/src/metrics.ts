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
  mailboxAccepted: number;
  mailboxDuplicate: number;
  mailboxConflict: number;
  mailboxFetched: number;
  mailboxAcked: number;
  mailboxExpired: number;
  mailboxRefusals: number;
  mailboxBundlesPublished: number;
  mailboxBundlesFetched: number;
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
    mailboxAccepted: 0,
    mailboxDuplicate: 0,
    mailboxConflict: 0,
    mailboxFetched: 0,
    mailboxAcked: 0,
    mailboxExpired: 0,
    mailboxRefusals: 0,
    mailboxBundlesPublished: 0,
    mailboxBundlesFetched: 0,
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
  "mailboxAccepted",
  "mailboxDuplicate",
  "mailboxConflict",
  "mailboxAcked",
  "mailboxExpired",
  "mailboxRefusals",
  "mailboxBundlesPublished",
]);

/** Every counter key in declared order — the exposition iterates this set. */
export const RELAY_COUNTER_KEYS: readonly RelayCounterKey[] = Object.freeze(
  Object.keys(emptyCounters()) as RelayCounterKey[],
);

export type RelayCounterScope = "durable" | "ephemeral";

/**
 * Which tier a counter honestly belongs to: durable keys flush to the
 * object's SQLite storage at bounded transitions; every other key lives in
 * memory only and resets on eviction. Exposition labels by this mapping
 * rather than pretending per-frame counters survive restart.
 */
export function counterScope(key: RelayCounterKey): RelayCounterScope {
  return DURABLE_KEYS.includes(key) ? "durable" : "ephemeral";
}

export interface RelayCountersOptions {
  /**
   * Whether durable-tier keys flush to the object's SQLite storage
   * (default `true`). When `false`, `count()` routes **every** key to the
   * in-memory tier — honest semantics: disabled means nothing survives
   * eviction, so no hidden durable map is kept. The durable map then keeps
   * only whatever was loaded at construction, `dirty` is never set and
   * `flush()` is a guaranteed no-op → zero counter writes to DO storage.
   */
  durable?: boolean;
}

export class RelayCounters {
  private durable: RelayCountersShape;
  private ephemeral: RelayCountersShape = emptyCounters();
  private dirty = false;
  private readonly durableEnabled: boolean;

  constructor(persisted?: Partial<RelayCountersShape> | null, options?: RelayCountersOptions) {
    // Previously persisted counters still load when present: disabling
    // persistence freezes the durable tier rather than erasing history.
    this.durable = { ...emptyCounters(), ...(persisted ?? {}) };
    this.durableEnabled = options?.durable !== false;
  }

  count(key: RelayCounterKey, amount: number = 1): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (this.durableEnabled && DURABLE_KEYS.includes(key)) {
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

  /**
   * Three-way view for the internal counters endpoint: `counters` is the
   * merged shape the /admin/counters JSON route has always returned, while
   * `durable`/`ephemeral` expose the honest tier split the Prometheus
   * exposition scopes by — merged values alone could not show which counts
   * survive eviction.
   */
  tieredSnapshot(): { counters: RelayCountersShape; durable: RelayCountersShape; ephemeral: RelayCountersShape } {
    return {
      counters: this.snapshot(),
      durable: { ...this.durable },
      ephemeral: { ...this.ephemeral },
    };
  }
}

// ---------------------------------------------------------------------------
// Prometheus text exposition (version 0.0.4)
// ---------------------------------------------------------------------------

/** Which object class a scraped counter set belongs to. */
export type RelayMetricObject = "session" | "mailbox" | "directory" | "vault";

/**
 * One scraped object's counters plus its exposition labels. Label values are
 * opaque routing ids and fixed enumerations only — never payloads, nonces,
 * signatures, credential material or digests.
 */
export interface RelayMetricSample {
  labels: {
    object: RelayMetricObject;
    tenant: string;
    /** Empty for `directory` and `vault` objects. */
    route: string;
    /** Empty unless `object` is `mailbox`. */
    device: string;
  };
  durable: RelayCountersShape;
  ephemeral: RelayCountersShape;
}

const COUNTER_HELP: Record<RelayCounterKey, string> = {
  storageReads: "Durable Object storage read operations.",
  storageWrites: "Durable Object storage write operations.",
  storageDeletes: "Durable Object storage delete operations.",
  alarmRuns: "Scheduled alarm invocations.",
  webSocketEvents: "WebSocket message, close and error events handled.",
  httpRequests: "Internal HTTP requests handled by the object.",
  messagesIn: "Wire messages received from connected sockets.",
  messagesOut: "Wire messages sent to connected sockets.",
  bytesIn: "Wire bytes received from connected sockets.",
  bytesOut: "Wire bytes sent to connected sockets.",
  framesForwarded: "Opaque frames forwarded to the peer socket.",
  framesDropped: "Frames refused by bounded queues or admission limits.",
  flowCreditsGranted: "Flow-credit grants emitted to senders.",
  rateLimitDrops: "Messages dropped by the inbound message rate limit.",
  sessionsAdmitted: "Sessions admitted after directory authority checks.",
  sessionsRejected: "Session opens rejected with a typed reason.",
  sessionsClosed: "Sessions closed or superseded by a newer connection.",
  sessionsRevoked: "Sessions terminated by a revocation push.",
  sessionsRestored: "Sessions restored through reconnect.",
  directoryChecks: "Directory authority lookups performed.",
  vaultReads: "Vault snapshot reads served.",
  vaultWritesCommitted: "Vault writes committed by compare-and-swap.",
  vaultWritesConflicting: "Vault writes reporting a revision conflict.",
  vaultWritesRefused: "Vault writes refused before commit.",
  vaultFetches: "Vault fetch requests handled.",
  vaultFetchRefusals: "Vault fetch requests refused.",
  mailboxAccepted: "Peer envelopes accepted into a mailbox partition.",
  mailboxDuplicate: "Peer sends answered by the stored idempotent outcome.",
  mailboxConflict: "Peer sends refused as id/envelope conflicts.",
  mailboxFetched: "Peer mailbox pages fetched.",
  mailboxAcked: "Peer acknowledgements durably recorded.",
  mailboxExpired: "Mailbox entries expired or capacity-truncated.",
  mailboxRefusals: "Mailbox requests refused with a typed reason.",
  mailboxBundlesPublished: "Peer prekey bundles published.",
  mailboxBundlesFetched: "Peer prekey bundles fetched.",
};

/** `sessionsAdmitted` → `meshrix_relay_sessions_admitted`. */
export function counterMetricName(key: RelayCounterKey): string {
  return `meshrix_relay_${key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n");
}

/**
 * Render the text exposition format (`text/plain; version=0.0.4`): one
 * HELP/TYPE pair per counter, then every scraped object's samples labeled
 * by the tier each value actually occupies. The `scope` label is derived
 * from the scraped tier data itself — never a mode flag:
 * - a durable-class key reports `scope="durable"` when the SQLite-flushed
 *   tier holds its count (the normal durable deployment);
 * - it reports `scope="ephemeral"` when a persistence-disabled object
 *   routed the count to the in-memory tier — the same value, honestly
 *   labeled as not surviving eviction;
 * - an object that disabled persistence after accumulating durable data
 *   can hold counts in both tiers for one key; both are emitted so the
 *   previously persisted values stay visible;
 * - an untouched counter reports its declared tier at 0.
 * Samples carry counts and opaque ids only.
 */
export function renderPrometheusExposition(samples: RelayMetricSample[]): string {
  const lines: string[] = [];
  for (const key of RELAY_COUNTER_KEYS) {
    const name = counterMetricName(key);
    const declared = counterScope(key);
    lines.push(`# HELP ${name} ${COUNTER_HELP[key]}`);
    lines.push(`# TYPE ${name} counter`);
    for (const sample of samples) {
      const { object, tenant, route, device } = sample.labels;
      const labels = `${name}{object="${escapeLabelValue(object)}",tenant="${escapeLabelValue(tenant)}",`
        + `route="${escapeLabelValue(route)}",device="${escapeLabelValue(device)}"`;
      if (declared === "ephemeral") {
        lines.push(`${labels},scope="ephemeral"} ${sample.ephemeral[key]}`);
        continue;
      }
      if (sample.durable[key] > 0 || sample.ephemeral[key] === 0) {
        lines.push(`${labels},scope="durable"} ${sample.durable[key]}`);
      }
      if (sample.ephemeral[key] > 0) {
        lines.push(`${labels},scope="ephemeral"} ${sample.ephemeral[key]}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
