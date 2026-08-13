import { createHash, randomUUID } from "node:crypto";
import { getRuntimeLogger, summarizeError, summarizeForLog } from "#meshrix/runtime-logger";
import { traceDetails } from "#meshrix/foundation/observability/trace-context";

const EVENT_SCHEMA_VERSION: any = "v0.0.1:pubsub:event-schema-1";
const DEFAULT_LIMIT: any = 100;
const MAX_LIMIT: any = 500;
const MAX_TIMEOUT_MS: any = 30_000;
const MAX_WAITERS: any = 1_000;
const DEFAULT_MAX_TOPICS: any = 64;
const DEFAULT_MAX_EVENT_BYTES: any = 2 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES: any = 8 * 1024 * 1024;
const DEFAULT_POLL_MIN_MS: any = 25;
const DEFAULT_POLL_MAX_MS: any = 250;
const DEFAULT_MAX_RECENT_RECORDS: any = 2_048;
const DEFAULT_MAX_RECENT_BYTES: any = 8 * 1024 * 1024;

function eventBusError(code?: any, message?: any, statusCode: any = 500) : any {
  return Object.assign(new Error(message), { code, statusCode });
}

function positiveInteger(value?: any, fallback?: any, maximum: any = Number.MAX_SAFE_INTEGER) : any {
  const parsed: any = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function nowIso() : any {
  return new Date().toISOString();
}

function normalizeTopic(value?: any) : any {
  return String(value || "").trim().slice(0, 256);
}

function normalizeTopics(topics?: any, maxTopics?: any) : any {
  const normalized: any = [...new Set<any>((topics || []).map(normalizeTopic).filter(Boolean))].sort();
  if (normalized.length > maxTopics) {
    throw eventBusError(
      "protocol_event_topics_exceeded",
      "Protocol event subscription contains too many topics.",
      400
    );
  }
  return normalized;
}

function limitValue(value?: any) : any {
  return Math.max(1, Math.min(MAX_LIMIT, Number(value || DEFAULT_LIMIT) || DEFAULT_LIMIT));
}

function timeoutValue(value?: any) : any {
  return Math.max(0, Math.min(MAX_TIMEOUT_MS, Number(value || 0) || 0));
}

function requireEventStore(eventStore?: any) : any {
  for (const method of ["publish", "read", "getLatest", "getRevision", "getStats"]) {
    if (typeof eventStore?.[method] !== "function") {
      throw new TypeError(`ProtocolEventStore.${method} is required.`);
    }
  }
  return eventStore;
}

function boundEventRecord(event?: any, maxEventBytes?: any) : any {
  const serialized: any = JSON.stringify(event);
  const byteLength: any = Buffer.byteLength(serialized);
  if (byteLength <= maxEventBytes) return { event, byteLength };
  const bounded: Record<string, any> = {
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

function metadataOnlyEvent(event?: any, originalBytes?: any) : any {
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

function boundEventPage(page?: any, maxResponseBytes?: any) : any {
  const events: any[] = [];
  let responseBytes: any = 2;
  let truncated: any = false;
  for (const event of page.events || []) {
    const serialized: any = JSON.stringify(event);
    const eventBytes: any = Buffer.byteLength(serialized) + 1;
    if (responseBytes + eventBytes <= maxResponseBytes) {
      events.push(event);
      responseBytes += eventBytes;
      continue;
    }
    if (events.length === 0) {
      const bounded: any = metadataOnlyEvent(event, eventBytes);
      const boundedBytes: any = Buffer.byteLength(JSON.stringify(bounded)) + 1;
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

export function createProtocolEventBus({
  eventStore,
  logger = getRuntimeLogger(),
  maxTopics = DEFAULT_MAX_TOPICS,
  maxWaiters = MAX_WAITERS,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxRecentRecords = DEFAULT_MAX_RECENT_RECORDS,
  maxRecentBytes = DEFAULT_MAX_RECENT_BYTES,
  pollMinMs = DEFAULT_POLL_MIN_MS,
  pollMaxMs = DEFAULT_POLL_MAX_MS
}: Record<string, any> = {}) : any {
  const store: any = requireEventStore(eventStore);
  const topicLimit: any = positiveInteger(maxTopics, DEFAULT_MAX_TOPICS, 512);
  const waiterLimit: any = positiveInteger(maxWaiters, MAX_WAITERS, MAX_WAITERS);
  const eventByteLimit: any = positiveInteger(
    maxEventBytes,
    DEFAULT_MAX_EVENT_BYTES,
    16 * 1024 * 1024
  );
  const responseByteLimit: any = positiveInteger(
    maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    64 * 1024 * 1024
  );
  const minimumPollMs: any = positiveInteger(pollMinMs, DEFAULT_POLL_MIN_MS, 1_000);
  const maximumPollMs: any = Math.max(
    minimumPollMs,
    positiveInteger(pollMaxMs, DEFAULT_POLL_MAX_MS, 5_000)
  );
  const recentRecordLimit: any = positiveInteger(maxRecentRecords, DEFAULT_MAX_RECENT_RECORDS, 65_536);
  const recentByteLimit: any = positiveInteger(maxRecentBytes, DEFAULT_MAX_RECENT_BYTES, 256 * 1024 * 1024);
  const waiters: any = new Map<any, any>();
  const waitersByTopic: any = new Map<any, any>();
  const allTopicWaiters: any = new Set<any>();
  const scheduleHeap: any[] = [];
  const recentEvents: any[] = [];
  let recentBytes: any = 0;
  let recentLastOffset: any = 0;
  let schedulerTimer: any = null;
  let schedulerAt: any = 0;
  let waiterSequence: any = 0;
  let scheduledWakeups: any = 0;
  let closed: any = false;
  let closePromise: any = null;
  let rejectedPublishes: any = 0;

  function heapSwap(left?: any, right?: any) : any {
    const value: any = scheduleHeap[left];
    scheduleHeap[left] = scheduleHeap[right];
    scheduleHeap[right] = value;
  }

  function heapPush(entry?: any) : any {
    scheduleHeap.push(entry);
    let index: any = scheduleHeap.length - 1;
    while (index > 0) {
      const parent: any = Math.floor((index - 1) / 2);
      if (scheduleHeap[parent].at <= scheduleHeap[index].at) break;
      heapSwap(parent, index);
      index = parent;
    }
  }

  function heapPop() : any {
    if (scheduleHeap.length === 0) return null;
    const first: any = scheduleHeap[0];
    const last: any = scheduleHeap.pop();
    if (scheduleHeap.length > 0) {
      scheduleHeap[0] = last;
      let index: any = 0;
      while (true) {
        const left: any = index * 2 + 1;
        const right: any = left + 1;
        let smallest: any = index;
        if (left < scheduleHeap.length && scheduleHeap[left].at < scheduleHeap[smallest].at) smallest = left;
        if (right < scheduleHeap.length && scheduleHeap[right].at < scheduleHeap[smallest].at) smallest = right;
        if (smallest === index) break;
        heapSwap(index, smallest);
        index = smallest;
      }
    }
    return first;
  }

  function armScheduler() : any {
    if (scheduleHeap.length === 0 || closed) return;
    const nextAt: any = scheduleHeap[0].at;
    if (schedulerTimer && schedulerAt <= nextAt) return;
    if (schedulerTimer) clearTimeout(schedulerTimer);
    schedulerAt = nextAt;
    const delayMs: any = Math.max(0, nextAt - Date.now());
    schedulerTimer = setTimeout(runScheduler, delayMs);
    schedulerTimer.unref?.();
  }

  function scheduleWaiter(waiter?: any, reason: any = "event") : any {
    if (!waiter || waiter.settled || waiter.scheduled) return;
    waiter.scheduled = true;
    waiter.reason = reason;
    scheduledWakeups += 1;
    waiter.resolve();
  }

  function runScheduler() : any {
    schedulerTimer = null;
    schedulerAt = 0;
    const nowMs: any = Date.now();
    while (scheduleHeap.length > 0 && scheduleHeap[0].at <= nowMs) {
      const entry: any = heapPop();
      const waiter: any = waiters.get(entry.id);
      if (!waiter || waiter.generation !== entry.generation || waiter.settled) continue;
      scheduleWaiter(waiter, entry.kind);
    }
    armScheduler();
  }

  function addWaiterIndex(waiter?: any) : any {
    waiters.set(waiter.id, waiter);
    if (waiter.topics.length === 0) {
      allTopicWaiters.add(waiter);
    } else {
      for (const topic of waiter.topics) {
        let topicWaiters: any = waitersByTopic.get(topic);
        if (!topicWaiters) {
          topicWaiters = new Set<any>();
          waitersByTopic.set(topic, topicWaiters);
        }
        topicWaiters.add(waiter);
      }
    }
  }

  function removeWaiterIndex(waiter?: any) : any {
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    waiters.delete(waiter.id);
    allTopicWaiters.delete(waiter);
    for (const topic of waiter.topics) {
      const topicWaiters: any = waitersByTopic.get(topic);
      topicWaiters?.delete(waiter);
      if (topicWaiters?.size === 0) waitersByTopic.delete(topic);
    }
  }

  function registerWaiter(topics?: any, deadline?: any, pollAt?: any) : any {
    let resolve: any;
    const promise: any = new Promise((settle?: any) : any => { resolve = settle; });
    const waiter: any = {
      id: ++waiterSequence,
      topics,
      deadline,
      generation: 1,
      scheduled: false,
      settled: false,
      reason: "",
      resolve,
      promise
    };
    addWaiterIndex(waiter);
    heapPush({ at: Math.min(deadline, pollAt), id: waiter.id, generation: waiter.generation, kind: pollAt <= deadline ? "poll" : "deadline" });
    if (pollAt < deadline) heapPush({ at: deadline, id: waiter.id, generation: waiter.generation, kind: "deadline" });
    armScheduler();
    return waiter;
  }

  function wakeSubscribers(topic?: any) : any {
    for (const waiter of allTopicWaiters) scheduleWaiter(waiter, "event");
    for (const waiter of waitersByTopic.get(topic) || []) scheduleWaiter(waiter, "event");
  }

  function appendRecent(event?: any) : any {
    const offset: any = Number(event?.offset || 0);
    if (offset <= 0) return;
    if (recentLastOffset > 0 && offset !== recentLastOffset + 1) {
      recentEvents.length = 0;
      recentBytes = 0;
    }
    const bytes: any = Buffer.byteLength(JSON.stringify(event));
    recentEvents.push({ event, bytes });
    recentBytes += bytes;
    recentLastOffset = offset;
    while (recentEvents.length > recentRecordLimit || recentBytes > recentByteLimit) {
      const removed: any = recentEvents.shift();
      recentBytes -= Number(removed?.bytes || 0);
    }
  }

  function readRecent(cursor?: any, topics?: any, limit?: any, revision: any = 0) : any {
    if (recentEvents.length === 0) return null;
    const firstOffset: any = Number(recentEvents[0].event.offset || 0);
    if (Number(cursor) < firstOffset - 1) return null;
    const topicSet: any = topics.length > 0 ? new Set<any>(topics) : null;
    const events: any[] = [];
    for (const entry of recentEvents) {
      if (entry.event.offset <= cursor) continue;
      if (topicSet && !topicSet.has(entry.event.topic)) continue;
      events.push(entry.event);
      if (events.length >= limitValue(limit)) break;
    }
    return boundEventPage({
      cursor,
      nextCursor: events.length >= limitValue(limit)
        ? Number(events.at(-1)?.offset || cursor)
        : Math.max(Number(cursor), recentLastOffset),
      events,
      revision
    }, responseByteLimit);
  }

  async function publish(topic?: any, payload: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
    if (closed) {
      throw eventBusError(
        "protocol_event_bus_closed",
        "Protocol event bus is closed.",
        503
      );
    }
    const normalizedTopic: any = normalizeTopic(topic);
    if (!normalizedTopic) {
      throw eventBusError(
        "protocol_event_topic_required",
        "发布事件缺少 topic。",
        400
      );
    }
    const trace: any = options.trace || traceDetails();
    const bounded: any = boundEventRecord({
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
    const startedAt: any = Date.now();
    try {
      const result: any = await store.publish(bounded.event, {
        retain: options.retain !== false
      });
      appendRecent(result.event);
      wakeSubscribers(normalizedTopic);
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
    } catch (error: any) {
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
  }: Record<string, any> = {}) : Promise<any> {
    const normalizedTopics: any = normalizeTopics(topics, topicLimit);
    const afterOffset: any = Math.max(0, Number(cursor || 0) || 0);
    const page: any = await store.read({
      cursor: afterOffset,
      topics: normalizedTopics,
      limit: limitValue(limit)
    });
    const bounded: any = boundEventPage({
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

  async function readEvents(input: Record<string, any> = {}) : Promise<any> {
    const { revision: _revision, responseBytes: _responseBytes, ...result } =
      await readWithRevision(input);
    return result;
  }

  async function getSnapshotPage(topics: any = [], byteBudget: any = responseByteLimit) : Promise<any> {
    const normalizedTopics: any = normalizeTopics(topics, topicLimit);
    const events: any = await store.getLatest(normalizedTopics);
    return boundEventPage({
      cursor: 0,
      nextCursor: Number(events.at(-1)?.offset || 0),
      events,
      revision: 0
    }, byteBudget);
  }

  async function getSnapshots(topics: any = []) : Promise<any> {
    return (await getSnapshotPage(topics)).events;
  }

  async function addSnapshots(result?: any, normalizedTopics?: any) : Promise<any> {
    const remainingBytes: any = Math.max(
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
  }: Record<string, any> = {}) : Promise<any> {
    const safeTimeoutMs: any = timeoutValue(timeoutMs);
    const subscribeStartedAt: any = Date.now();
    const normalizedTopics: any = normalizeTopics(topics, topicLimit);
    const read: any = () : any => readWithRevision({
      cursor,
      topics: normalizedTopics,
      limit
    });
    let result: any = await read();
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

    const deadline: any = Date.now() + safeTimeoutMs;
    let pollMs: any = minimumPollMs;
    let lastRevision: any = result.revision;
    while (!closed && !signal?.aborted && Date.now() < deadline) {
      const waiter: any = registerWaiter(
        normalizedTopics,
        deadline,
        Math.min(deadline, Date.now() + pollMs)
      );
      const abort: any = () : any => scheduleWaiter(waiter, "abort");
      signal?.addEventListener?.("abort", abort, { once: true });
      // Register before the local-ring and durable revision recheck so a
      // publication between the initial read and waiter insertion cannot be
      // lost. Topic links are installed synchronously in registerWaiter.
      const recent: any = readRecent(cursor, normalizedTopics, limit, lastRevision);
      if (recent?.events?.length > 0) scheduleWaiter(waiter, "ring");
      if (!waiter.scheduled) {
        const revision: any = await store.getRevision();
        if (revision !== lastRevision) scheduleWaiter(waiter, "revision");
      }
      await waiter.promise;
      removeWaiterIndex(waiter);
      signal?.removeEventListener?.("abort", abort);
      if (closed || signal?.aborted || Date.now() >= deadline || waiter.reason === "deadline") break;

      const mustReadStore: any = waiter.reason === "poll" || waiter.reason === "revision";
      const ringPage: any = mustReadStore
        ? null
        : readRecent(cursor, normalizedTopics, limit, lastRevision);
      if (ringPage) {
        result = {
          cursor,
          nextCursor: ringPage.nextCursor,
          topics: normalizedTopics,
          events: ringPage.events,
          responseBytes: ringPage.responseBytes,
          revision: ringPage.revision
        };
      } else {
        result = await read();
      }
      lastRevision = result.revision;
      if (result.events.length > 0) break;
      pollMs = Math.min(maximumPollMs, pollMs * 2);
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

  async function getStats() : Promise<any> {
    return Object.freeze({
      ...(await store.getStats()),
      waiters: waiters.size,
      maxWaiters: waiterLimit,
      waiterTopics: waitersByTopic.size,
      runtimeTimers: schedulerTimer ? 1 : 0,
      recentRecords: recentEvents.length,
      recentBytes,
      maxRecentRecords: recentRecordLimit,
      maxRecentBytes: recentByteLimit,
      scheduledWakeups,
      rejectedPublishes
    });
  }

  function close() : any {
    if (closePromise) return closePromise;
    closed = true;
    if (schedulerTimer) clearTimeout(schedulerTimer);
    schedulerTimer = null;
    schedulerAt = 0;
    for (const waiter of waiters.values()) scheduleWaiter(waiter, "closed");
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
