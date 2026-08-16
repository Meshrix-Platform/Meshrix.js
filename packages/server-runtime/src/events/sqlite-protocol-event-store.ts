import path from "node:path";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import { ensurePrivateDir } from "#meshrix/foundation/storage/private-file-atomic";
import { ensurePrivateSqliteLocation } from "#meshrix/foundation/storage/private-sqlite";
import type Database from "better-sqlite3";

const STORE_SCHEMA_REVISION = 2;
const DEFAULT_MAX_RECORDS = 100_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_BATCH = 256;
const DEFAULT_MAX_LATEST_TOPICS = 512;
const DEFAULT_MAX_LATEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const STATEMENT_CACHES = new WeakMap<Database.Database, Map<string, Database.Statement>>();

type UnknownRecord = Record<string, unknown>;

export interface ProtocolEventStorePolicy {
  maxRecords: number;
  maxBytes: number;
  maxAgeMs: number;
  retentionBatch: number;
  maxLatestTopics: number;
  maxLatestBytes: number;
  maxEventBytes: number;
  busyTimeoutMs: number;
}

export interface ProtocolEvent extends UnknownRecord {
  schemaVersion: string;
  offset: number;
  id: string;
  traceId: string;
  requestId: string;
  spanId: string;
  topic: string;
  type: string;
  publisher: string;
  publishedAt: string;
  payload: unknown;
}

export interface ProtocolEventCandidate extends UnknownRecord {
  schemaVersion: string;
  id: string;
  traceId: string;
  requestId: string;
  spanId: string;
  topic: string;
  type: string;
  publisher: string;
  publishedAt: string;
  payload: unknown;
}

interface StoreCounters {
  eventCount: number;
  eventBytes: number;
  latestCount: number;
  latestBytes: number;
  revision: number;
  retentionPending: number;
}

export interface SqliteProtocolEventStore {
  policy: ProtocolEventStorePolicy;
  databasePath: string;
  publish(candidate: ProtocolEventCandidate, options?: { retain?: boolean }): Promise<{ event: Readonly<ProtocolEvent>; revision: number }>;
  read(options?: { cursor?: number; topics?: readonly string[]; limit?: number }): Promise<{ events: ProtocolEvent[]; nextCursor: number; revision: number }>;
  getLatest(topics?: readonly string[]): Promise<ProtocolEvent[]>;
  getRevision(): Promise<number>;
  getStats(): Promise<Readonly<StoreCounters & ProtocolEventStorePolicy>>;
  explainRead(options?: { topics?: readonly string[] }): unknown[];
  checkpoint(): void;
  close(): void;
}

function prepareCached(db: Database.Database, sql: string): Database.Statement {
  let cache = STATEMENT_CACHES.get(db);
  if (!cache) {
    cache = new Map<string, Database.Statement>();
    STATEMENT_CACHES.set(db, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

function storeError(code: string, message: string, statusCode = 500): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

function positiveInteger(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function normalizePolicy(policy: Partial<ProtocolEventStorePolicy> = {}): ProtocolEventStorePolicy {
  return Object.freeze({
    maxRecords: positiveInteger(policy.maxRecords, DEFAULT_MAX_RECORDS, 1_000_000),
    maxBytes: positiveInteger(policy.maxBytes, DEFAULT_MAX_BYTES, 1024 * 1024 * 1024),
    maxAgeMs: positiveInteger(policy.maxAgeMs, DEFAULT_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000),
    retentionBatch: positiveInteger(policy.retentionBatch, DEFAULT_RETENTION_BATCH, 4_096),
    maxLatestTopics: positiveInteger(
      policy.maxLatestTopics,
      DEFAULT_MAX_LATEST_TOPICS,
      10_000
    ),
    maxLatestBytes: positiveInteger(
      policy.maxLatestBytes,
      DEFAULT_MAX_LATEST_BYTES,
      256 * 1024 * 1024
    ),
    maxEventBytes: positiveInteger(
      policy.maxEventBytes,
      DEFAULT_MAX_EVENT_BYTES,
      16 * 1024 * 1024
    ),
    busyTimeoutMs: positiveInteger(
      policy.busyTimeoutMs,
      DEFAULT_BUSY_TIMEOUT_MS,
      30_000
    )
  });
}

function eventStorePath(userDataPath = ""): string {
  return path.join(userDataPath, "protocol-events", "events.sqlite");
}

function eventFromRow(row?: UnknownRecord): ProtocolEvent | null {
  if (!row) return null;
  const parsedTrace: unknown = JSON.parse(String(row.trace_json || "{}"));
  const trace = parsedTrace && typeof parsedTrace === "object" && !Array.isArray(parsedTrace)
    ? parsedTrace as UnknownRecord
    : {};
  return {
    schemaVersion: String(row.schema_version || ""),
    offset: Number(row.offset),
    id: String(row.event_id || ""),
    traceId: String(trace.traceId || ""),
    requestId: String(trace.requestId || ""),
    spanId: String(trace.spanId || ""),
    topic: String(row.topic || ""),
    type: String(row.event_type || ""),
    publisher: String(row.publisher || ""),
    publishedAt: new Date(Number(row.published_at_ms)).toISOString(),
    payload: JSON.parse(String(row.payload_json || "{}"))
  };
}

function createSchema(db: Database.Database): void {
  const existingTables = new Set<string>(
    prepareCached(db, `
      SELECT name
      FROM sqlite_master
      WHERE type='table'
        AND name IN (
          'protocol_events',
          'protocol_event_latest',
          'protocol_event_meta'
        )
    `).all().map((entry) => String((entry as UnknownRecord).name))
  );
  if (existingTables.size !== 0 && existingTables.size !== 3) {
    throw storeError(
      "protocol_event_store_schema_incomplete",
      "Protocol event store schema is incomplete."
    );
  }
  const initializing = existingTables.size === 0;
  db.exec(`
    CREATE TABLE IF NOT EXISTS protocol_events (
      offset INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      schema_version TEXT NOT NULL,
      topic TEXT NOT NULL,
      event_type TEXT NOT NULL,
      publisher TEXT NOT NULL,
      published_at_ms INTEGER NOT NULL,
      payload_json BLOB NOT NULL,
      payload_bytes INTEGER NOT NULL CHECK(payload_bytes>=0),
      trace_json BLOB NOT NULL,
      event_bytes INTEGER NOT NULL CHECK(event_bytes>=0)
    );
    CREATE INDEX IF NOT EXISTS idx_protocol_events_topic_offset
      ON protocol_events(topic,offset);
    CREATE INDEX IF NOT EXISTS idx_protocol_events_published_offset
      ON protocol_events(published_at_ms,offset);
    CREATE TABLE IF NOT EXISTS protocol_event_latest (
      topic TEXT PRIMARY KEY,
      offset INTEGER NOT NULL,
      event_json BLOB NOT NULL,
      event_bytes INTEGER NOT NULL CHECK(event_bytes>=0)
    );
    CREATE INDEX IF NOT EXISTS idx_protocol_event_latest_offset
      ON protocol_event_latest(offset);
    CREATE TABLE IF NOT EXISTS protocol_event_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
  const initialMeta: Array<readonly [string, number]> = [
    ["schema_version", STORE_SCHEMA_REVISION],
    ["event_count", 0],
    ["event_bytes", 0],
    ["latest_count", 0],
    ["latest_bytes", 0],
    ["revision", 0],
    ["retention_pending", 0]
  ];
  if (initializing) {
    const insertMeta = prepareCached(db,
      "INSERT INTO protocol_event_meta(key,value) VALUES(?,?)"
    );
    db.transaction(() => {
      for (const [key, value] of initialMeta) {
        insertMeta.run(key, value);
      }
    })();
  } else {
    const keys = new Set<string>(
      prepareCached(db, "SELECT key FROM protocol_event_meta").all()
        .map((entry) => String((entry as UnknownRecord).key))
    );
    const existingRevision = Number(
      (prepareCached(db, "SELECT value FROM protocol_event_meta WHERE key='schema_version'").get() as UnknownRecord | undefined)?.value
    );
    if (existingRevision === 1 && !keys.has("retention_pending")) {
      db.transaction(() => {
        prepareCached(db, "INSERT INTO protocol_event_meta(key,value) VALUES('retention_pending',0)").run();
        prepareCached(db, "UPDATE protocol_event_meta SET value=? WHERE key='schema_version'")
          .run(STORE_SCHEMA_REVISION);
      })();
      keys.add("retention_pending");
    }
    if (initialMeta.some(([key]) => !keys.has(key))) {
      throw storeError(
        "protocol_event_store_meta_incomplete",
        "Protocol event store metadata is incomplete."
      );
    }
  }
  const schemaVersion = Number(
    (prepareCached(db, "SELECT value FROM protocol_event_meta WHERE key='schema_version'").get() as UnknownRecord | undefined)?.value
  );
  if (schemaVersion !== STORE_SCHEMA_REVISION) {
    throw storeError(
      "protocol_event_store_schema_unsupported",
      "Protocol event store schema is unsupported."
    );
  }
}

function readCounters(db: Database.Database): StoreCounters {
  const counters = Object.fromEntries(
    prepareCached(db, `
      SELECT key,value
      FROM protocol_event_meta
      WHERE key IN ('event_count','event_bytes','latest_count','latest_bytes','revision','retention_pending')
    `).all().map((entry) => {
      const row = entry as UnknownRecord;
      return [String(row.key), Number(row.value)];
    })
  ) as Record<string, number>;
  return {
    eventCount: Number(counters.event_count || 0),
    eventBytes: Number(counters.event_bytes || 0),
    latestCount: Number(counters.latest_count || 0),
    latestBytes: Number(counters.latest_bytes || 0),
    revision: Number(counters.revision || 0),
    retentionPending: Number(counters.retention_pending || 0)
  };
}

function updateCounters(db: Database.Database, counters: StoreCounters): void {
  const update = prepareCached(db, "UPDATE protocol_event_meta SET value=? WHERE key=?");
  update.run(counters.eventCount, "event_count");
  update.run(counters.eventBytes, "event_bytes");
  update.run(counters.latestCount, "latest_count");
  update.run(counters.latestBytes, "latest_bytes");
  update.run(counters.revision, "revision");
  update.run(counters.retentionPending, "retention_pending");
}

function pruneAtWatermark(db: Database.Database, counters: StoreCounters, policy: ProtocolEventStorePolicy, incomingBytes: number, nowMs: number): number {
  const expiresBefore = nowMs - policy.maxAgeMs;
  const candidates = prepareCached(db, `
    SELECT offset,event_bytes,published_at_ms
    FROM protocol_events
    ORDER BY offset ASC
    LIMIT ?
  `).all(policy.retentionBatch) as UnknownRecord[];
  let removedCount = 0;
  let removedBytes = 0;
  let watermark = 0;
  for (const entry of candidates) {
    const overCapacity =
      counters.eventCount - removedCount + 1 > policy.maxRecords ||
      counters.eventBytes - removedBytes + incomingBytes > policy.maxBytes;
    if (!overCapacity && Number(entry.published_at_ms) > expiresBefore) break;
    watermark = Number(entry.offset);
    removedCount += 1;
    removedBytes += Number(entry.event_bytes);
  }
  if (watermark <= 0) return 0;
  const latestTotals = prepareCached(db, `
    SELECT COUNT(*) AS count,COALESCE(SUM(event_bytes),0) AS bytes
    FROM protocol_event_latest
    WHERE offset<=?
  `).get(watermark) as UnknownRecord;
  prepareCached(db, "DELETE FROM protocol_event_latest WHERE offset<=?").run(watermark);
  prepareCached(db, "DELETE FROM protocol_events WHERE offset<=?").run(watermark);
  counters.eventCount -= removedCount;
  counters.eventBytes -= removedBytes;
  counters.latestCount -= Number(latestTotals.count || 0);
  counters.latestBytes -= Number(latestTotals.bytes || 0);
  counters.retentionPending = 0;
  return removedCount;
}

function upsertLatest(
  db: Database.Database,
  event: ProtocolEvent,
  serialized: string,
  eventBytes: number,
  counters: StoreCounters,
  policy: ProtocolEventStorePolicy
): void {
  const existing = prepareCached(db,
    "SELECT event_bytes FROM protocol_event_latest WHERE topic=?"
  ).get(event.topic) as UnknownRecord | undefined;
  prepareCached(db, `
    INSERT INTO protocol_event_latest(topic,offset,event_json,event_bytes)
    VALUES(?,?,?,?)
    ON CONFLICT(topic) DO UPDATE SET
      offset=excluded.offset,
      event_json=excluded.event_json,
      event_bytes=excluded.event_bytes
  `).run(event.topic, event.offset, serialized, eventBytes);
  if (existing) {
    counters.latestBytes += eventBytes - Number(existing.event_bytes);
  } else {
    counters.latestCount += 1;
    counters.latestBytes += eventBytes;
  }
  const oldestLatest = prepareCached(db, `
    SELECT topic,event_bytes
    FROM protocol_event_latest
    ORDER BY offset ASC
    LIMIT 1
  `);
  let removed = 0;
  while (
    counters.latestCount > policy.maxLatestTopics ||
    counters.latestBytes > policy.maxLatestBytes
  ) {
    if (removed >= policy.maxLatestTopics + 1) {
      throw storeError(
        "protocol_event_latest_capacity_exceeded",
        "Protocol event latest snapshot capacity is exhausted.",
        503
      );
    }
    const entry = oldestLatest.get() as UnknownRecord | undefined;
    if (!entry) break;
    prepareCached(db, "DELETE FROM protocol_event_latest WHERE topic=?").run(entry.topic);
    counters.latestCount -= 1;
    counters.latestBytes -= Number(entry.event_bytes);
    removed += 1;
  }
}

export function createSqliteProtocolEventStore({
  userDataPath,
  databasePath = "",
  policy: requestedPolicy = {},
  now = Date.now
}: {
  userDataPath?: string;
  databasePath?: string;
  policy?: Partial<ProtocolEventStorePolicy>;
  now?: () => number;
} = {}): SqliteProtocolEventStore {
  const policy = normalizePolicy(requestedPolicy);
  const selectedPath = databasePath || eventStorePath(userDataPath);
  ensurePrivateDir(path.dirname(selectedPath));
  ensurePrivateSqliteLocation(selectedPath);
  const db = openSqliteDatabase(selectedPath) as Database.Database;
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma(`busy_timeout = ${policy.busyTimeoutMs}`);
  createSchema(db);

  const insertEvent = prepareCached(db, `
    INSERT INTO protocol_events(
      event_id,schema_version,topic,event_type,publisher,published_at_ms,
      payload_json,payload_bytes,trace_json,event_bytes
    ) VALUES(?,?,?,?,?,?,?,?,?,0)
  `);
  const publishTransaction = db.transaction((candidate: ProtocolEventCandidate, retain: boolean) => {
    const payloadJson = JSON.stringify(candidate.payload ?? {});
    const traceJson = JSON.stringify({
      traceId: String(candidate.traceId || ""),
      requestId: String(candidate.requestId || ""),
      spanId: String(candidate.spanId || "")
    });
    const payloadBytes = Buffer.byteLength(payloadJson);
    const parsedPublishedAt = Date.parse(candidate.publishedAt);
    const publishedAtMs = Number.isFinite(parsedPublishedAt)
      ? parsedPublishedAt
      : now();
    const normalizedCandidate: ProtocolEventCandidate = {
      ...candidate,
      publishedAt: new Date(publishedAtMs).toISOString()
    };
    const admissionBytes = Buffer.byteLength(JSON.stringify({
      ...normalizedCandidate,
      offset: Number.MAX_SAFE_INTEGER
    }));
    if (
      admissionBytes > policy.maxEventBytes ||
      admissionBytes > policy.maxBytes
    ) {
      return {
        error: storeError(
          "protocol_event_record_too_large",
          "Protocol event exceeds the configured record byte limit.",
          413
        )
      };
    }
    const counters = readCounters(db);
    const maintenanceDue = counters.retentionPending >= policy.retentionBatch;
    const capacityPressure =
      counters.eventCount + 1 > policy.maxRecords ||
      counters.eventBytes + admissionBytes > policy.maxBytes;
    if (maintenanceDue || capacityPressure) {
      pruneAtWatermark(db, counters, policy, admissionBytes, now());
    }
    if (
      counters.eventCount + 1 > policy.maxRecords ||
      counters.eventBytes + admissionBytes > policy.maxBytes
    ) {
      counters.revision += 1;
      updateCounters(db, counters);
      return {
        error: storeError(
          "protocol_event_capacity_exceeded",
          "Protocol event retention capacity is exhausted.",
          503
        )
      };
    }
    const inserted = insertEvent.run(
      normalizedCandidate.id,
      normalizedCandidate.schemaVersion,
      normalizedCandidate.topic,
      normalizedCandidate.type,
      normalizedCandidate.publisher,
      publishedAtMs,
      payloadJson,
      payloadBytes,
      traceJson
    );
    const event: Readonly<ProtocolEvent> = Object.freeze({
      ...normalizedCandidate,
      offset: Number(inserted.lastInsertRowid)
    });
    const serialized = JSON.stringify(event);
    const eventBytes = Buffer.byteLength(serialized);
    if (eventBytes > policy.maxEventBytes) {
      throw storeError(
        "protocol_event_record_too_large",
        "Protocol event exceeds the configured record byte limit.",
        413
      );
    }
    prepareCached(db, "UPDATE protocol_events SET event_bytes=? WHERE offset=?")
      .run(eventBytes, event.offset);
    counters.eventCount += 1;
    counters.eventBytes += eventBytes;
    counters.retentionPending += 1;
    if (retain) {
      upsertLatest(db, event, serialized, eventBytes, counters, policy);
    }
    counters.revision += 1;
    updateCounters(db, counters);
    return { event, revision: counters.revision };
  });

  let closed = false;
  const requireOpen = (): void => {
    if (closed) {
      throw storeError(
        "protocol_event_store_closed",
        "Protocol event store is closed.",
        503
      );
    }
  };

  return Object.freeze({
    policy,
    databasePath: selectedPath,
    async publish(candidate: ProtocolEventCandidate, { retain = true }: { retain?: boolean } = {}) {
      requireOpen();
      const result = publishTransaction(candidate, retain === true);
      if (result.error) throw result.error;
      return { event: result.event, revision: result.revision };
    },
    async read({ cursor = 0, topics = [], limit = 100 }: { cursor?: number; topics?: readonly string[]; limit?: number } = {}) {
      requireOpen();
      const afterOffset = Math.max(0, Number(cursor) || 0);
      const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
      const normalizedTopics = [...new Set(topics.map(String).filter(Boolean))];
      const params: Array<string | number> = [afterOffset];
      let where = "offset>?";
      if (normalizedTopics.length > 0) {
        where += ` AND topic IN (${normalizedTopics.map(() => "?").join(",")})`;
        params.push(...normalizedTopics);
      }
      params.push(safeLimit);
      const rows = prepareCached(db, `
        SELECT *
        FROM protocol_events
        WHERE ${where}
        ORDER BY offset ASC
        LIMIT ?
      `).all(...params) as UnknownRecord[];
      const maxOffset = Number(
        (prepareCached(db, "SELECT COALESCE(MAX(offset),0) AS value FROM protocol_events").get() as UnknownRecord).value
      );
      return {
        events: rows.map(eventFromRow).filter((event): event is ProtocolEvent => event !== null),
        nextCursor: rows.length >= safeLimit
          ? Number(rows.at(-1)?.offset || afterOffset)
          : Math.max(afterOffset, maxOffset),
        revision: readCounters(db).revision
      };
    },
    async getLatest(topics: readonly string[] = []): Promise<ProtocolEvent[]> {
      requireOpen();
      const normalizedTopics = [...new Set(topics.map(String).filter(Boolean))]
        .slice(0, policy.maxLatestTopics);
      if (normalizedTopics.length === 0) {
        return prepareCached(db, `
          SELECT event_json
          FROM protocol_event_latest
          ORDER BY offset ASC
        `).all().map((entry) => JSON.parse(String((entry as UnknownRecord).event_json)) as ProtocolEvent);
      }
      return prepareCached(db, `
        SELECT event_json
        FROM protocol_event_latest
        WHERE topic IN (${normalizedTopics.map(() => "?").join(",")})
        ORDER BY offset ASC
      `).all(...normalizedTopics)
        .map((entry) => JSON.parse(String((entry as UnknownRecord).event_json)) as ProtocolEvent);
    },
    async getRevision(): Promise<number> {
      requireOpen();
      return readCounters(db).revision;
    },
    async getStats() {
      requireOpen();
      return Object.freeze({ ...readCounters(db), ...policy });
    },
    explainRead({ topics = [] }: { topics?: readonly string[] } = {}): unknown[] {
      requireOpen();
      if (topics.length > 0) {
        return prepareCached(db, `
          EXPLAIN QUERY PLAN
          SELECT offset
          FROM protocol_events
          WHERE topic=? AND offset>?
          ORDER BY offset ASC
          LIMIT ?
        `).all(String(topics[0]), 0, 10);
      }
      return prepareCached(db, `
        EXPLAIN QUERY PLAN
        SELECT offset
        FROM protocol_events
        WHERE offset>?
        ORDER BY offset ASC
        LIMIT ?
      `).all(0, 10);
    },
    checkpoint(): void {
      requireOpen();
      db.pragma("wal_checkpoint(TRUNCATE)");
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    }
  });
}

export const PROTOCOL_EVENT_STORE_SCHEMA_REVISION = STORE_SCHEMA_REVISION;
