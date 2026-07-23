import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {
  atomicWriteFile,
  atomicWriteJsonThroughState,
  queueStateMutation,
  stateFileKey,
  waitForStateIdle
} from "#lico/state-coordinator";
import { getRuntimeLogger, summarizeError, summarizeForLog } from "#lico/runtime-logger";
import { traceDetails } from "#lico/foundation/observability/trace-context";

const EVENT_SCHEMA_VERSION = "v0.0.1:pubsub:event-schema-1";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_TIMEOUT_MS = 30000;
const MAX_MEMORY_EVENTS = 5000;
const MAX_WAITERS = 1000;
const MAX_RETURNED_EVENT_LINE_CHARS = 2_000_000;
const OFFSET_TAIL_SCAN_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENT_LOG_BYTES = 32 * 1024 * 1024;
const DEFAULT_RETAINED_EVENT_LOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_MEMORY_EVENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_LATEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RETAINED_TOPICS = 512;
const DEFAULT_MAX_EVENT_BYTES = 2 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function normalizeTopic(value) {
  return String(value || "").trim().slice(0, 256);
}

function normalizeTopics(topics = []) {
  return [...new Set((topics || []).map(normalizeTopic).filter(Boolean))].sort();
}

function getEventRootPath(userDataPath) {
  return path.join(userDataPath, "protocol-events");
}

function getEventsPath(userDataPath) {
  return path.join(getEventRootPath(userDataPath), "events.jsonl");
}

function getStatePath(userDataPath) {
  return path.join(getEventRootPath(userDataPath), "state.json");
}

function getLatestPath(userDataPath) {
  return path.join(getEventRootPath(userDataPath), "latest.json");
}

async function ensureEventRoot(userDataPath) {
  await fs.mkdir(getEventRootPath(userDataPath), { recursive: true });
}

async function readJsonFile(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    if (!content.trim()) {
      return fallback;
    }
    return JSON.parse(content);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    if (error instanceof SyntaxError) {
      return fallback;
    }
    throw error;
  }
}

async function readState(userDataPath) {
  const state = await readJsonFile(getStatePath(userDataPath), {});
  return {
    nextOffset: Math.max(1, Number(state.nextOffset || 1))
  };
}

async function writeState(userDataPath, state) {
  await atomicWriteJsonThroughState(getStatePath(userDataPath), state, {
    trailingNewline: false,
    kind: "events.state.write"
  });
}

async function readLatest(userDataPath) {
  const latest = await readJsonFile(getLatestPath(userDataPath), {});
  return latest && typeof latest === "object" ? latest : {};
}

async function writeLatest(userDataPath, latest) {
  await atomicWriteJsonThroughState(getLatestPath(userDataPath), latest, {
    trailingNewline: false,
    kind: "events.latest.write"
  });
}

function topicMatches(event, topics) {
  return topics.length === 0 || topics.includes(event.topic);
}

function parseEventLine(line) {
  if (!line.trim()) {
    return null;
  }
  if (line.length > MAX_RETURNED_EVENT_LINE_CHARS) {
    const offset = Number(line.match(/"offset"\s*:\s*(\d+)/)?.[1] || 0);
    const topic = String(line.match(/"topic"\s*:\s*"([^"]+)"/)?.[1] || "");
    const id = String(line.match(/"id"\s*:\s*"([^"]+)"/)?.[1] || "");
    const type = String(line.match(/"type"\s*:\s*"([^"]+)"/)?.[1] || "snapshot");
    const publisher = String(line.match(/"publisher"\s*:\s*"([^"]+)"/)?.[1] || "server");
    const publishedAt = String(line.match(/"publishedAt"\s*:\s*"([^"]+)"/)?.[1] || "");
    if (!offset || !topic) {
      return null;
    }
    return {
      schemaVersion: EVENT_SCHEMA_VERSION,
      offset,
      id,
      topic,
      type,
      publisher,
      publishedAt,
      payload: {
        oversized: true,
        omittedChars: line.length,
        reason: "event_payload_too_large_for_inline_subscription"
      }
    };
  }
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function readJsonlLines(filePath, onLine) {
  await new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    const stream = fsSync.createReadStream(filePath, { encoding: "utf8" });
    const finish = (error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    stream.on("error", (error) => {
      if (error?.code === "ENOENT") {
        finish();
        return;
      }
      if (stopped && error?.code === "ERR_STREAM_PREMATURE_CLOSE") {
        finish();
        return;
      }
      finish(error);
    });
    const lines = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });
    lines.on("line", (line) => {
      if (stopped) {
        return;
      }
      const shouldContinue = onLine(line);
      if (shouldContinue === false) {
        stopped = true;
        lines.close();
        stream.destroy();
      }
    });
    lines.on("error", finish);
    lines.on("close", () => finish());
  });
}

function limitValue(value) {
  return Math.max(1, Math.min(MAX_LIMIT, Number(value || DEFAULT_LIMIT) || DEFAULT_LIMIT));
}

function timeoutValue(value) {
  return Math.max(0, Math.min(MAX_TIMEOUT_MS, Number(value || 0) || 0));
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function boundEventRecord(event, maxEventBytes) {
  const serialized = JSON.stringify(event);
  const byteLength = Buffer.byteLength(serialized);
  if (byteLength <= maxEventBytes) return { event, serialized, byteLength };
  const bounded = {
    ...event,
    payload: {
      oversized: true,
      omittedBytes: byteLength,
      sha256: createHash("sha256").update(serialized).digest("hex"),
      reason: "event_payload_too_large_for_persistence"
    }
  };
  const boundedSerialized = JSON.stringify(bounded);
  return {
    event: bounded,
    serialized: boundedSerialized,
    byteLength: Buffer.byteLength(boundedSerialized)
  };
}

function boundLatestSnapshots(latest, { maxBytes, maxTopics }) {
  const entries = Object.entries(latest || {})
    .filter(([, event]) => event && typeof event === "object")
    .sort((left, right) => Number(right[1].offset || 0) - Number(left[1].offset || 0));
  const retained = {};
  let retainedBytes = 2;
  let retainedCount = 0;
  for (const [topic, event] of entries) {
    if (retainedCount >= maxTopics) break;
    const entryBytes = Buffer.byteLength(JSON.stringify(topic)) +
      Buffer.byteLength(JSON.stringify(event)) + 2;
    if (retainedBytes + entryBytes > maxBytes && retainedBytes > 2) continue;
    retained[topic] = event;
    retainedBytes += entryBytes;
    retainedCount += 1;
  }
  return retained;
}

async function readRecentCompleteLines(filePath, maxBytes) {
  let handle = null;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    let content = buffer.subarray(0, offset).toString("utf8");
    if (start > 0) {
      const firstLineBreak = content.indexOf("\n");
      content = firstLineBreak >= 0 ? content.slice(firstLineBreak + 1) : "";
    }
    return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close().catch(() => null);
  }
}

export function createProtocolEventBus({
  userDataPath,
  logger = getRuntimeLogger(),
  maxEventLogBytes = DEFAULT_MAX_EVENT_LOG_BYTES,
  retainedEventLogBytes = DEFAULT_RETAINED_EVENT_LOG_BYTES,
  maxMemoryEventBytes = DEFAULT_MAX_MEMORY_EVENT_BYTES,
  maxLatestBytes = DEFAULT_MAX_LATEST_BYTES,
  maxRetainedTopics = DEFAULT_MAX_RETAINED_TOPICS,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES
} = {}) {
  const eventLogByteLimit = positiveInteger(maxEventLogBytes, DEFAULT_MAX_EVENT_LOG_BYTES, 1024 * 1024 * 1024);
  const retainedLogByteLimit = Math.min(
    eventLogByteLimit,
    positiveInteger(retainedEventLogBytes, DEFAULT_RETAINED_EVENT_LOG_BYTES, eventLogByteLimit)
  );
  const memoryEventByteLimit = positiveInteger(maxMemoryEventBytes, DEFAULT_MAX_MEMORY_EVENT_BYTES, 256 * 1024 * 1024);
  const latestByteLimit = positiveInteger(maxLatestBytes, DEFAULT_MAX_LATEST_BYTES, 256 * 1024 * 1024);
  const retainedTopicLimit = positiveInteger(maxRetainedTopics, DEFAULT_MAX_RETAINED_TOPICS, 10_000);
  const eventByteLimit = Math.min(
    eventLogByteLimit,
    positiveInteger(maxEventBytes, DEFAULT_MAX_EVENT_BYTES, 16 * 1024 * 1024)
  );
  const waiters = new Set();
  let publishQueue = Promise.resolve();
  let nextOffset = null;
  let closed = false;
  let closePromise = null;
  const memoryEvents = [];
  const memoryEventSizes = new WeakMap();
  let memoryEventBytes = 0;

  function rememberEvent(event, byteLength) {
    memoryEvents.push(event);
    memoryEventSizes.set(event, byteLength);
    memoryEventBytes += byteLength;
    while (memoryEvents.length > MAX_MEMORY_EVENTS || memoryEventBytes > memoryEventByteLimit) {
      const removed = memoryEvents.shift();
      memoryEventBytes -= memoryEventSizes.get(removed) || 0;
    }
  }

  async function appendAndCompactEventLog(serialized) {
    const eventsPath = getEventsPath(userDataPath);
    await queueStateMutation(stateFileKey(eventsPath), async () => {
      await fs.appendFile(eventsPath, `${serialized}\n`, "utf8");
      const stat = await fs.stat(eventsPath);
      if (stat.size <= eventLogByteLimit) return;
      const retainedLines = await readRecentCompleteLines(
        eventsPath,
        retainedLogByteLimit + eventByteLimit
      );
      let retained = retainedLines;
      let content = retained.length ? `${retained.join("\n")}\n` : `${serialized}\n`;
      while (retained.length > 1 && Buffer.byteLength(content) > retainedLogByteLimit) {
        retained = retained.slice(1);
        content = `${retained.join("\n")}\n`;
      }
      await atomicWriteFile(eventsPath, content, "utf8");
    });
  }

  async function readLastPersistedOffset() {
    const eventsPath = getEventsPath(userDataPath);
    let handle = null;
    try {
      const stat = await fs.stat(eventsPath);
      if (!stat.size) {
        return 0;
      }
      const length = Math.min(stat.size, OFFSET_TAIL_SCAN_BYTES);
      const start = Math.max(0, stat.size - length);
      const buffer = Buffer.alloc(length);
      handle = await fs.open(eventsPath, "r");
      await handle.read(buffer, 0, length, start);
      const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines.reverse()) {
        const offset = Number(line.match(/"offset"\s*:\s*(\d+)/)?.[1] || 0);
        if (offset > 0) {
          return offset;
        }
      }
      return 0;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return 0;
      }
      throw error;
    } finally {
      await handle?.close?.();
    }
  }

  async function ensureNextOffset() {
    if (nextOffset !== null) {
      return nextOffset;
    }
    await ensureEventRoot(userDataPath);
    const state = await readState(userDataPath);
    const lastPersistedOffset = Number(state.nextOffset || 1) > 1
      ? Number(state.nextOffset || 1) - 1
      : await readLastPersistedOffset();
    nextOffset = Math.max(1, Number(state.nextOffset || 1), lastPersistedOffset + 1);
    if (nextOffset !== Number(state.nextOffset || 1)) {
      await writeState(userDataPath, { nextOffset });
    }
    return nextOffset;
  }

  function readMemoryEvents({ cursor = 0, topics = [], limit = DEFAULT_LIMIT } = {}) {
    const normalizedTopics = normalizeTopics(topics);
    const safeLimit = limitValue(limit);
    const afterOffset = Math.max(0, Number(cursor || 0) || 0);
    const events = [];
    let nextCursor = afterOffset;
    for (const event of memoryEvents) {
      const offset = Number(event.offset || 0);
      if (offset <= afterOffset) {
        nextCursor = Math.max(nextCursor, offset);
        continue;
      }
      nextCursor = Math.max(nextCursor, offset);
      if (!topicMatches(event, normalizedTopics)) {
        continue;
      }
      events.push(event);
      if (events.length >= safeLimit) {
        break;
      }
    }
    return {
      cursor: afterOffset,
      nextCursor,
      topics: normalizedTopics,
      events
    };
  }

  async function readEvents({ cursor = 0, topics = [], limit = DEFAULT_LIMIT } = {}) {
    await ensureEventRoot(userDataPath);
    await waitForStateIdle(stateFileKey(getEventsPath(userDataPath)));
    const normalizedTopics = normalizeTopics(topics);
    const safeLimit = limitValue(limit);
    const afterOffset = Math.max(0, Number(cursor || 0) || 0);
    const events = [];
    let nextCursor = afterOffset;

    if (
      memoryEvents.length > 0 &&
      afterOffset >= Number(memoryEvents[0]?.offset || 0) - 1
    ) {
      return readMemoryEvents({ cursor, topics, limit });
    }

    await readJsonlLines(getEventsPath(userDataPath), (line) => {
      const event = parseEventLine(line);
      if (!event) {
        return true;
      }
      const offset = Number(event.offset || 0);
      if (offset <= afterOffset) {
        nextCursor = Math.max(nextCursor, offset);
        return true;
      }

      nextCursor = Math.max(nextCursor, offset);
      if (!topicMatches(event, normalizedTopics)) {
        return true;
      }
      events.push(event);
      if (events.length >= safeLimit) {
        return false;
      }
      return true;
    });

    return {
      cursor: afterOffset,
      nextCursor,
      topics: normalizedTopics,
      events
    };
  }

  async function getSnapshots(topics = []) {
    const normalizedTopics = normalizeTopics(topics);
    const latest = await readLatest(userDataPath);
    return Object.values(latest)
      .filter((event) => event && topicMatches(event, normalizedTopics))
      .sort((left, right) => Number(left.offset || 0) - Number(right.offset || 0));
  }

  function wakeSubscribers() {
    for (const waiter of [...waiters]) {
      waiter();
    }
  }

  async function publish(topic, payload = {}, options = {}) {
    if (closed) throw new Error("Protocol event bus is closed.");
    const normalizedTopic = normalizeTopic(topic);
    if (!normalizedTopic) {
      throw new Error("发布事件缺少 topic。");
    }

    logger?.debug?.("event.publish.enqueued", {
      topic: normalizedTopic,
      type: String(options.type || "snapshot"),
      retain: options.retain !== false,
      publisher: String(options.publisher || "server"),
      waiters: waiters.size,
      payload: summarizeForLog(payload, { maxDepth: 4, maxArrayItems: 6, maxObjectKeys: 40 })
    });
    const queuedAt = Date.now();
    publishQueue = publishQueue.catch(() => {}).then(async () => {
      const startedAt = Date.now();
      await ensureEventRoot(userDataPath);
      const offset = await ensureNextOffset();
      const trace = options.trace || traceDetails();
      const candidateEvent = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        offset,
        id: randomUUID(),
        traceId: trace.traceId,
        requestId: trace.requestId,
        spanId: trace.spanId,
        topic: normalizedTopic,
        type: String(options.type || "snapshot"),
        publisher: String(options.publisher || "server"),
        publishedAt: nowIso(),
        payload
      };
      const bounded = boundEventRecord(candidateEvent, eventByteLimit);
      const event = bounded.event;
      await appendAndCompactEventLog(bounded.serialized);
      nextOffset = offset + 1;
      await writeState(userDataPath, {
        nextOffset
      });
      if (options.retain !== false) {
        const latest = await readLatest(userDataPath);
        latest[normalizedTopic] = event;
        await writeLatest(userDataPath, boundLatestSnapshots(latest, {
          maxBytes: latestByteLimit,
          maxTopics: retainedTopicLimit
        }));
      }
      rememberEvent(event, bounded.byteLength);
      wakeSubscribers();
      logger?.debug?.("event.publish.persisted", {
        topic: normalizedTopic,
        type: event.type,
        offset,
        id: event.id,
        retained: options.retain !== false,
        waitedMs: startedAt - queuedAt,
        durationMs: Date.now() - startedAt,
        memoryEvents: memoryEvents.length,
        memoryEventBytes,
        waiters: waiters.size
      });
      return event;
    }).catch((error) => {
      logger?.error?.("event.publish.failed", {
        topic: normalizedTopic,
        type: String(options.type || "snapshot"),
        error: summarizeError(error)
      });
      throw error;
    });

    return publishQueue;
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
    logger?.debug?.("event.subscribe.requested", {
      cursor,
      topics: normalizeTopics(topics),
      timeoutMs: safeTimeoutMs,
      limit: limitValue(limit),
      includeSnapshot
    });
    const read = async () => {
      const result = await readEvents({ cursor, topics, limit });
      if (includeSnapshot) {
        result.snapshots = await getSnapshots(topics);
      }
      return result;
    };

    const immediate = await read();
    if (closed || immediate.events.length > 0 || safeTimeoutMs <= 0) {
      logger?.debug?.("event.subscribe.completed", {
        mode: "immediate",
        cursor: immediate.cursor,
        nextCursor: immediate.nextCursor,
        events: immediate.events.length,
        snapshots: immediate.snapshots?.length || 0,
        durationMs: Date.now() - subscribeStartedAt
      });
      return immediate;
    }
    if (signal?.aborted) {
      logger?.debug?.("event.subscribe.completed", {
        mode: "aborted-before-wait",
        cursor: immediate.cursor,
        nextCursor: immediate.nextCursor,
        events: immediate.events.length,
        durationMs: Date.now() - subscribeStartedAt
      });
      return immediate;
    }

    await new Promise((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(timer);
        waiters.delete(finish);
        signal?.removeEventListener?.("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, safeTimeoutMs);
      if (closed) {
        finish();
        return;
      }
      if (waiters.size >= MAX_WAITERS) {
        logger?.warn?.("event.subscribe.waiter_limit", {
          waiters: waiters.size,
          maxWaiters: MAX_WAITERS
        });
        finish();
        return;
      }
      waiters.add(finish);
      signal?.addEventListener?.("abort", finish, { once: true });
    });

    const result = await read();
    logger?.debug?.("event.subscribe.completed", {
      mode: "waited",
      cursor: result.cursor,
      nextCursor: result.nextCursor,
      events: result.events.length,
      snapshots: result.snapshots?.length || 0,
      durationMs: Date.now() - subscribeStartedAt
    });
    return result;
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    wakeSubscribers();
    closePromise = publishQueue.catch(() => {});
    return closePromise;
  }

  return {
    publish,
    readEvents,
    getSnapshots,
    subscribe,
    close
  };
}
