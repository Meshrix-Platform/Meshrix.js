import path from "node:path";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import { ensurePrivateDir } from "#meshrix/foundation/storage/private-file-atomic";
import { ensurePrivateSqliteLocation } from "#meshrix/foundation/storage/private-sqlite";

const STORE_SCHEMA_REVISION: any = 1;
const DEFAULT_MAX_RECORDS: any = 100_000;
const DEFAULT_MAX_BYTES: any = 32 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS: any = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_BATCH: any = 256;
const DEFAULT_MAX_LATEST_TOPICS: any = 512;
const DEFAULT_MAX_LATEST_BYTES: any = 16 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES: any = 2 * 1024 * 1024;
const DEFAULT_BUSY_TIMEOUT_MS: any = 5_000;
const STATEMENT_CACHES: any = new WeakMap<object, any>();

function prepareCached(db?: any, sql?: any) : any {
  let cache: any = STATEMENT_CACHES.get(db);
  if (!cache) {
    cache = new Map<any, any>();
    STATEMENT_CACHES.set(db, cache);
  }
  let statement: any = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

function storeError(code?: any, message?: any, statusCode: any = 500) : any {
  return Object.assign(new Error(message), { code, statusCode });
}

function positiveInteger(value?: any, fallback?: any, maximum: any = Number.MAX_SAFE_INTEGER) : any {
  const parsed: any = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function normalizePolicy(policy: Record<string, any> = {}) : any {
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

function eventStorePath(userDataPath?: any) : any {
  return path.join(userDataPath, "protocol-events", "events.sqlite");
}

function eventFromRow(row?: any) : any {
  if (!row) return null;
  const trace: any = JSON.parse(String(row.trace_json || "{}"));
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

function createSchema(db?: any) : any {
  const existingTables: any = new Set<any>(
    prepareCached(db, `
      SELECT name
      FROM sqlite_master
      WHERE type='table'
        AND name IN (
          'protocol_events',
          'protocol_event_latest',
          'protocol_event_meta'
        )
    `).all().map((entry?: any) : any => String(entry.name))
  );
  if (existingTables.size !== 0 && existingTables.size !== 3) {
    throw storeError(
      "protocol_event_store_schema_incomplete",
      "Protocol event store schema is incomplete."
    );
  }
  const initializing: any = existingTables.size === 0;
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
  const initialMeta: any[] = [
    ["schema_version", STORE_SCHEMA_REVISION],
    ["event_count", 0],
    ["event_bytes", 0],
    ["latest_count", 0],
    ["latest_bytes", 0],
    ["revision", 0]
  ];
  if (initializing) {
    const insertMeta: any = prepareCached(db,
      "INSERT INTO protocol_event_meta(key,value) VALUES(?,?)"
    );
    db.transaction(() : any => {
      for (const [key, value] of initialMeta) {
        insertMeta.run(key, value);
      }
    })();
  } else {
    const keys: any = new Set<any>(
      prepareCached(db, "SELECT key FROM protocol_event_meta").all()
        .map((entry?: any) : any => String(entry.key))
    );
    if (initialMeta.some(([key]: any[]) : any => !keys.has(key))) {
      throw storeError(
        "protocol_event_store_meta_incomplete",
        "Protocol event store metadata is incomplete."
      );
    }
  }
  const schemaVersion: any = Number(
    prepareCached(db, "SELECT value FROM protocol_event_meta WHERE key='schema_version'").get()?.value
  );
  if (schemaVersion !== STORE_SCHEMA_REVISION) {
    throw storeError(
      "protocol_event_store_schema_unsupported",
      "Protocol event store schema is unsupported."
    );
  }
}

function readCounters(db?: any) : any {
  const counters: any = Object.fromEntries(
    prepareCached(db, `
      SELECT key,value
      FROM protocol_event_meta
      WHERE key IN ('event_count','event_bytes','latest_count','latest_bytes','revision')
    `).all().map((entry?: any) : any => [entry.key, Number(entry.value)])
  );
  return {
    eventCount: Number(counters.event_count || 0),
    eventBytes: Number(counters.event_bytes || 0),
    latestCount: Number(counters.latest_count || 0),
    latestBytes: Number(counters.latest_bytes || 0),
    revision: Number(counters.revision || 0)
  };
}

function updateCounters(db?: any, counters?: any) : any {
  const update: any = prepareCached(db, "UPDATE protocol_event_meta SET value=? WHERE key=?");
  update.run(counters.eventCount, "event_count");
  update.run(counters.eventBytes, "event_bytes");
  update.run(counters.latestCount, "latest_count");
  update.run(counters.latestBytes, "latest_bytes");
  update.run(counters.revision, "revision");
}

function removeLatestAtOffset(db?: any, offset?: any, counters?: any) : any {
  const latest: any = prepareCached(db,
    "SELECT topic,event_bytes FROM protocol_event_latest WHERE offset=?"
  ).get(offset);
  if (!latest) return;
  prepareCached(db, "DELETE FROM protocol_event_latest WHERE topic=?").run(latest.topic);
  counters.latestCount -= 1;
  counters.latestBytes -= Number(latest.event_bytes);
}

function pruneForAdmission(db?: any, counters?: any, policy?: any, incomingBytes?: any, nowMs?: any) : any {
  const oldest: any = prepareCached(db, `
    SELECT offset,event_bytes,published_at_ms
    FROM protocol_events
    ORDER BY offset ASC
    LIMIT 1
  `);
  const deleteEvent: any = prepareCached(db, "DELETE FROM protocol_events WHERE offset=?");
  const expiresBefore: any = nowMs - policy.maxAgeMs;
  let removed: any = 0;
  while (removed < policy.retentionBatch) {
    const entry: any = oldest.get();
    if (!entry) break;
    const overCapacity: any =
      counters.eventCount + 1 > policy.maxRecords ||
      counters.eventBytes + incomingBytes > policy.maxBytes;
    if (!overCapacity && Number(entry.published_at_ms) > expiresBefore) break;
    removeLatestAtOffset(db, entry.offset, counters);
    deleteEvent.run(entry.offset);
    counters.eventCount -= 1;
    counters.eventBytes -= Number(entry.event_bytes);
    removed += 1;
  }
  return removed;
}

function upsertLatest(db?: any, event?: any, serialized?: any, eventBytes?: any, counters?: any, policy?: any) : any {
  const existing: any = prepareCached(db,
    "SELECT event_bytes FROM protocol_event_latest WHERE topic=?"
  ).get(event.topic);
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
  const oldestLatest: any = prepareCached(db, `
    SELECT topic,event_bytes
    FROM protocol_event_latest
    ORDER BY offset ASC
    LIMIT 1
  `);
  let removed: any = 0;
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
    const entry: any = oldestLatest.get();
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
}: Record<string, any> = {}) : any {
  const policy: any = normalizePolicy(requestedPolicy);
  const selectedPath: any = databasePath || eventStorePath(userDataPath);
  ensurePrivateDir(path.dirname(selectedPath));
  ensurePrivateSqliteLocation(selectedPath);
  const db: any = openSqliteDatabase(selectedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma(`busy_timeout = ${policy.busyTimeoutMs}`);
  createSchema(db);

  const insertEvent: any = prepareCached(db, `
    INSERT INTO protocol_events(
      event_id,schema_version,topic,event_type,publisher,published_at_ms,
      payload_json,payload_bytes,trace_json,event_bytes
    ) VALUES(?,?,?,?,?,?,?,?,?,0)
  `);
  const publishTransaction: any = db.transaction((candidate?: any, retain?: any) : any => {
    const payloadJson: any = JSON.stringify(candidate.payload ?? {});
    const traceJson: any = JSON.stringify({
      traceId: String(candidate.traceId || ""),
      requestId: String(candidate.requestId || ""),
      spanId: String(candidate.spanId || "")
    });
    const payloadBytes: any = Buffer.byteLength(payloadJson);
    const parsedPublishedAt: any = Date.parse(candidate.publishedAt);
    const publishedAtMs: any = Number.isFinite(parsedPublishedAt)
      ? parsedPublishedAt
      : now();
    const normalizedCandidate: Record<string, any> = {
      ...candidate,
      publishedAt: new Date(publishedAtMs).toISOString()
    };
    const admissionBytes: any = Buffer.byteLength(JSON.stringify({
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
    const counters: any = readCounters(db);
    pruneForAdmission(db, counters, policy, admissionBytes, now());
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
    const inserted: any = insertEvent.run(
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
    const event: Readonly<Record<string, any>> = Object.freeze({
      ...normalizedCandidate,
      offset: Number(inserted.lastInsertRowid)
    });
    const serialized: any = JSON.stringify(event);
    const eventBytes: any = Buffer.byteLength(serialized);
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
    if (retain) {
      upsertLatest(db, event, serialized, eventBytes, counters, policy);
    }
    counters.revision += 1;
    updateCounters(db, counters);
    return { event, revision: counters.revision };
  });

  let closed: any = false;
  const requireOpen: any = () : any => {
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
    async publish(candidate?: any, { retain = true }: Record<string, any> = {}) : Promise<any> {
      requireOpen();
      const result: any = publishTransaction(candidate, retain === true);
      if (result.error) throw result.error;
      return result;
    },
    async read({ cursor = 0, topics = [], limit = 100 }: Record<string, any> = {}) : Promise<any> {
      requireOpen();
      const afterOffset: any = Math.max(0, Number(cursor) || 0);
      const safeLimit: any = Math.max(1, Math.min(500, Number(limit) || 100));
      const normalizedTopics: any[] = [...new Set<any>(topics.map(String).filter(Boolean))];
      const params: any[] = [afterOffset];
      let where: any = "offset>?";
      if (normalizedTopics.length > 0) {
        where += ` AND topic IN (${normalizedTopics.map(() : any => "?").join(",")})`;
        params.push(...normalizedTopics);
      }
      params.push(safeLimit);
      const rows: any = prepareCached(db, `
        SELECT *
        FROM protocol_events
        WHERE ${where}
        ORDER BY offset ASC
        LIMIT ?
      `).all(...params);
      const maxOffset: any = Number(
        prepareCached(db, "SELECT COALESCE(MAX(offset),0) AS value FROM protocol_events").get().value
      );
      return {
        events: rows.map(eventFromRow),
        nextCursor: rows.length >= safeLimit
          ? Number(rows.at(-1)?.offset || afterOffset)
          : Math.max(afterOffset, maxOffset),
        revision: readCounters(db).revision
      };
    },
    async getLatest(topics: any = []) : Promise<any> {
      requireOpen();
      const normalizedTopics: any = [...new Set<any>(topics.map(String).filter(Boolean))]
        .slice(0, policy.maxLatestTopics);
      if (normalizedTopics.length === 0) {
        return prepareCached(db, `
          SELECT event_json
          FROM protocol_event_latest
          ORDER BY offset ASC
        `).all().map((entry?: any) : any => JSON.parse(String(entry.event_json)));
      }
      return prepareCached(db, `
        SELECT event_json
        FROM protocol_event_latest
        WHERE topic IN (${normalizedTopics.map(() : any => "?").join(",")})
        ORDER BY offset ASC
      `).all(...normalizedTopics)
        .map((entry?: any) : any => JSON.parse(String(entry.event_json)));
    },
    async getRevision() : Promise<any> {
      requireOpen();
      return readCounters(db).revision;
    },
    async getStats() : Promise<any> {
      requireOpen();
      return Object.freeze({ ...readCounters(db), ...policy });
    },
    explainRead({ topics = [] }: Record<string, any> = {}) : any {
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
    checkpoint() : any {
      requireOpen();
      db.pragma("wal_checkpoint(TRUNCATE)");
    },
    close() : any {
      if (closed) return;
      closed = true;
      db.close();
    }
  });
}

export const PROTOCOL_EVENT_STORE_SCHEMA_REVISION: any = STORE_SCHEMA_REVISION;
