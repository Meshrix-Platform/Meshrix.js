import { createHash, randomUUID } from "node:crypto";
import { getRuntimeLogger, summarizeError, summarizeForLog } from "#meshrix/runtime-logger";
import { traceDetails } from "#meshrix/foundation/observability/trace-context";

const EVENT_SCHEMA_VERSION = "v0.0.1:pubsub:event-schema-1";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_TIMEOUT_MS = 30_000;
const MAX_WAITERS = 1_000;
const DEFAULT_MAX_TOPICS = 64;
const DEFAULT_MAX_EVENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_POLL_MIN_MS = 25;
const DEFAULT_POLL_MAX_MS = 250;

function eventBusError(code, message, statusCode = 500) {
  return Object.assign(new Error(message), { code, statusCode });
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeTopic(value) {
  return String(value || "").trim().slice(0, 256);
}

function normalizeTopics(topics, maxTopics) {
  const normalized = [...new Set((topics || []).map(normalizeTopic).filter(Boolean))].sort();
  if (normalized.length > maxTopics) {
    throw eventBusError(
      "protocol_event_topics_exceeded",
      "Protocol event subscription contains too many topics.",
      400
    );
  }
  return normalized;
}

function limitValue(value) {
  return Math.max(1, Math.min(MAX_LIMIT, Number(value || DEFAULT_LIMIT) || DEFAULT_LIMIT));
}

function timeoutValue(value) {
  return Math.max(0, Math.min(MAX_TIMEOUT_MS, Number(value || 0) || 0));
}

function requireEventStore(eventStore) {
  for (const method of ["publish", "read", "getLatest", "getRevision", "getStats"]) {
    if (typeof eventStore?.[method] !== "function") {
      throw new TypeError(`ProtocolEventStore.${method} is required.`);
    }
  }
  return eventStore;
}

function boundEventRecord(event, maxEventBytes) {
  const serialized = JSON.stringify(event);
  const byteLength = Buffer.byteLength(serialized);
  if (byteLength <= maxEventBytes) return { event, byteLength };
  const bounded = {
    ...event,
    payload: {
      oversized: true,
      omittedBytes: byteLength,
      sha256: createHash("sha256").update(serialized).digest("hex"),
      reason: "event_payload_too_large_for_persistence"
    }
  };
  return {
    event: bounded,
    byteLength: Buffer.byteLength(JSON.stringify(bounded))
  };
}

function metadataOnlyEvent(event, originalBytes) {
  return {
    schemaVersion: event.schemaVersion,
    offset: event.offset,
    id: event.id,
    topic: event.topic,
    type: event.type,
    publisher: event.publisher,
    publishedAt: event.publishedAt,
    payload: {
      oversized: true,
      omittedBytes: originalBytes,
      reason: "event_payload_too_large_for_subscription_response"
    }
  };
}

function boundEventPage(page, maxResponseBytes) {
  const events = [];
  let responseBytes = 2;
  let truncated = false;
  for (const event of page.events || []) {
    const serialized = JSON.stringify(event);
    const eventBytes = Buffer.byteLength(serialized) + 1;
    if (responseBytes + eventBytes <= maxResponseBytes) {
      events.push(event);
      responseBytes += eventBytes;
      continue;
    }
    if (events.length === 0) {
      const bounded = metadataOnlyEvent(event, eventBytes);
      const boundedBytes = Buffer.byteLength(JSON.stringify(bounded)) + 1;
      if (responseBytes + boundedBytes <= maxResponseBytes) {
        events.push(bounded);
        responseBytes += boundedBytes;
      }
      page.cursor = Number(event.offset || page.cursor || 0);
    }
    truncated = true;
    break;
  }
  return {
    events,
    responseBytes,
    nextCursor: truncated
      ? Number(events.at(-1)?.offset || page.cursor || 0)
      : Number(page.nextCursor || page.cursor || 0),
    revision: Number(page.revision || 0)
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createProtocolEventBus({
  eventStore,
  logger = getRuntimeLogger(),
  maxTopics = DEFAULT_MAX_TOPICS,
  maxWaiters = MAX_WAITERS,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  pollMinMs = DEFAULT_POLL_MIN_MS,
  pollMaxMs = DEFAULT_POLL_MAX_MS
} = {}) {
  const store = requireEventStore(eventStore);
  const topicLimit = positiveInteger(maxTopics, DEFAULT_MAX_TOPICS, 512);
  const waiterLimit = positiveInteger(maxWaiters, MAX_WAITERS, MAX_WAITERS);
  const eventByteLimit = positiveInteger(
    maxEventBytes,
    DEFAULT_MAX_EVENT_BYTES,
    16 * 1024 * 1024
  );
  const responseByteLimit = positiveInteger(
    maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    64 * 1024 * 1024
  );
  const minimumPollMs = positiveInteger(pollMinMs, DEFAULT_POLL_MIN_MS, 1_000);
  const maximumPollMs = Math.max(
    minimumPollMs,
    positiveInteger(pollMaxMs, DEFAULT_POLL_MAX_MS, 5_000)
  );
  const waiters = new Set();
  let closed = false;
  let closePromise = null;
  let rejectedPublishes = 0;

  function wakeSubscribers() {
    for (const waiter of waiters) waiter();
  }

  async function publish(topic, payload = {}, options = {}) {
    if (closed) {
      throw eventBusError(
        "protocol_event_bus_closed",
        "Protocol event bus is closed.",
        503
      );
    }
    const normalizedTopic = normalizeTopic(topic);
    if (!normalizedTopic) {
      throw eventBusError(
        "protocol_event_topic_required",
        "发布事件缺少 topic。",
        400
      );
    }
    const trace = options.trace || traceDetails();
    const bounded = boundEventRecord({
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: randomUUID(),
      traceId: String(trace.traceId || "").slice(0, 256),
      requestId: String(trace.requestId || "").slice(0, 256),
      spanId: String(trace.spanId || "").slice(0, 256),
      topic: normalizedTopic,
      type: String(options.type || "snapshot").slice(0, 128),
      publisher: String(options.publisher || "server").slice(0, 128),
      publishedAt: nowIso(),
      payload
    }, eventByteLimit);
    logger?.debug?.("event.publish.admitted", {
      topic: normalizedTopic,
      type: bounded.event.type,
      retain: options.retain !== false,
      publisher: bounded.event.publisher,
      eventBytes: bounded.byteLength,
      waiters: waiters.size,
      payload: summarizeForLog(bounded.event.payload, {
        maxDepth: 4,
        maxArrayItems: 6,
        maxObjectKeys: 40
      })
    });
    const startedAt = Date.now();
    try {
      const result = await store.publish(bounded.event, {
        retain: options.retain !== false
      });
      wakeSubscribers();
      logger?.debug?.("event.publish.persisted", {
        topic: normalizedTopic,
        type: result.event.type,
        offset: result.event.offset,
        id: result.event.id,
        retained: options.retain !== false,
        revision: result.revision,
        durationMs: Date.now() - startedAt,
        waiters: waiters.size
      });
      return result.event;
    } catch (error) {
      rejectedPublishes += 1;
      logger?.error?.("event.publish.failed", {
        topic: normalizedTopic,
        type: bounded.event.type,
        reasonCode: String(error?.code || "protocol_event_publish_failed"),
        error: summarizeError(error)
      });
      throw error;
    }
  }

  async function readWithRevision({
    cursor = 0,
    topics = [],
    limit = DEFAULT_LIMIT
  } = {}) {
    const normalizedTopics = normalizeTopics(topics, topicLimit);
    const afterOffset = Math.max(0, Number(cursor || 0) || 0);
    const page = await store.read({
      cursor: afterOffset,
      topics: normalizedTopics,
      limit: limitValue(limit)
    });
    const bounded = boundEventPage({
      ...page,
      cursor: afterOffset
    }, responseByteLimit);
    return {
      cursor: afterOffset,
      nextCursor: bounded.nextCursor,
      topics: normalizedTopics,
      events: bounded.events,
      responseBytes: bounded.responseBytes,
      revision: bounded.revision
    };
  }

  async function readEvents(input = {}) {
    const { revision: _revision, responseBytes: _responseBytes, ...result } =
      await readWithRevision(input);
    return result;
  }

  async function getSnapshotPage(topics = [], byteBudget = responseByteLimit) {
    const normalizedTopics = normalizeTopics(topics, topicLimit);
    const events = await store.getLatest(normalizedTopics);
    return boundEventPage({
      cursor: 0,
      nextCursor: Number(events.at(-1)?.offset || 0),
      events,
      revision: 0
    }, byteBudget);
  }

  async function getSnapshots(topics = []) {
    return (await getSnapshotPage(topics)).events;
  }

  async function addSnapshots(result, normalizedTopics) {
    const remainingBytes = Math.max(
      2,
      responseByteLimit - Number(result.responseBytes || 2) + 2
    );
    result.snapshots = (
      await getSnapshotPage(normalizedTopics, remainingBytes)
    ).events;
  }

  async function subscribe({
    cursor = 0,
    topics = [],
    timeoutMs = 0,
    limit = DEFAULT_LIMIT,
    includeSnapshot = false,
    signal = null
  } = {}) {
    const safeTimeoutMs = timeoutValue(timeoutMs);
    const subscribeStartedAt = Date.now();
    const normalizedTopics = normalizeTopics(topics, topicLimit);
    const read = () => readWithRevision({
      cursor,
      topics: normalizedTopics,
      limit
    });
    let result = await read();
    if (includeSnapshot) await addSnapshots(result, normalizedTopics);
    if (
      closed ||
      result.events.length > 0 ||
      safeTimeoutMs <= 0 ||
      signal?.aborted
    ) {
      const { revision: _revision, responseBytes: _responseBytes, ...publicResult } = result;
      return publicResult;
    }
    if (waiters.size >= waiterLimit) {
      logger?.warn?.("event.subscribe.waiter_limit", {
        waiters: waiters.size,
        maxWaiters: waiterLimit
      });
      const { revision: _revision, responseBytes: _responseBytes, ...publicResult } = result;
      return publicResult;
    }

    let wakeCurrent = null;
    let wakeSequence = 0;
    const wake = () => {
      wakeSequence += 1;
      wakeCurrent?.();
    };
    const abort = () => {
      wakeCurrent?.();
    };
    waiters.add(wake);
    signal?.addEventListener?.("abort", abort, { once: true });
    const deadline = Date.now() + safeTimeoutMs;
    let pollMs = minimumPollMs;
    let lastRevision = result.revision;
    try {
      while (!closed && !signal?.aborted && Date.now() < deadline) {
        const observedWakeSequence = wakeSequence;
        await Promise.race([
          new Promise((resolve) => {
            wakeCurrent = resolve;
          }),
          delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
        ]);
        wakeCurrent = null;
        if (closed || signal?.aborted) break;
        const revision = await store.getRevision();
        if (wakeSequence !== observedWakeSequence || revision !== lastRevision) {
          result = await read();
          lastRevision = result.revision;
          if (result.events.length > 0) break;
        }
        pollMs = Math.min(maximumPollMs, pollMs * 2);
      }
    } finally {
      wakeCurrent = null;
      waiters.delete(wake);
      signal?.removeEventListener?.("abort", abort);
    }
    if (includeSnapshot) await addSnapshots(result, normalizedTopics);
    logger?.debug?.("event.subscribe.completed", {
      cursor: result.cursor,
      nextCursor: result.nextCursor,
      events: result.events.length,
      snapshots: result.snapshots?.length || 0,
      durationMs: Date.now() - subscribeStartedAt,
      mode: result.events.length > 0 ? "event" : signal?.aborted ? "aborted" : "timeout"
    });
    const { revision: _revision, responseBytes: _responseBytes, ...publicResult } = result;
    return publicResult;
  }

  async function getStats() {
    return Object.freeze({
      ...(await store.getStats()),
      waiters: waiters.size,
      maxWaiters: waiterLimit,
      rejectedPublishes
    });
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    wakeSubscribers();
    closePromise = Promise.resolve();
    return closePromise;
  }

  return Object.freeze({
    publish,
    readEvents,
    getSnapshots,
    subscribe,
    getStats,
    close
  });
}
