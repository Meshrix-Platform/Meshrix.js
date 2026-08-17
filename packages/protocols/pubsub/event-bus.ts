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
const DEFAULT_MAX_RECENT_RECORDS = 2_048;
const DEFAULT_MAX_RECENT_BYTES = 8 * 1024 * 1024;

type UnknownRecord = Record<string, unknown>;

export interface ProtocolEvent extends UnknownRecord {
  schemaVersion: string;
  offset: number;
  id: string;
  traceId?: string;
  requestId?: string;
  spanId?: string;
  topic: string;
  type: string;
  publisher: string;
  publishedAt: string;
  payload: unknown;
}

export interface ProtocolEventCandidate extends Omit<ProtocolEvent, "offset" | "traceId" | "requestId" | "spanId"> {
  traceId: string;
  requestId: string;
  spanId: string;
}

export interface ProtocolEventStore {
  publish(candidate: ProtocolEventCandidate, options?: { retain?: boolean }): Promise<{
    event: Readonly<ProtocolEvent>;
    revision: number;
  }>;
  read(options?: { cursor?: number; topics?: readonly string[]; limit?: number }): Promise<{
    events: ProtocolEvent[];
    nextCursor: number;
    revision: number;
  }>;
  getLatest(topics?: readonly string[]): Promise<ProtocolEvent[]>;
  getRevision(): Promise<number>;
  getStats(): Promise<object>;
}

interface EventLogger {
  debug?(message: string, details?: UnknownRecord): void;
  warn?(message: string, details?: UnknownRecord): void;
  error?(message: string, details?: UnknownRecord): void;
}

export interface ProtocolEventBusOptions {
  eventStore?: ProtocolEventStore;
  logger?: EventLogger;
  maxTopics?: number;
  maxWaiters?: number;
  maxEventBytes?: number;
  maxResponseBytes?: number;
  maxRecentRecords?: number;
  maxRecentBytes?: number;
  pollMinMs?: number;
  pollMaxMs?: number;
}

export interface ProtocolEventPublishOptions {
  trace?: { traceId?: unknown; requestId?: unknown; spanId?: unknown };
  type?: unknown;
  publisher?: unknown;
  retain?: boolean;
}

export interface ProtocolEventReadOptions {
  cursor?: number;
  topics?: readonly string[];
  limit?: number;
}

export interface ProtocolEventSubscribeOptions extends ProtocolEventReadOptions {
  timeoutMs?: number;
  includeSnapshot?: boolean;
  signal?: AbortSignal | null;
}

export interface ProtocolEventPage {
  cursor: number;
  nextCursor: number;
  topics: readonly string[];
  events: ProtocolEvent[];
  snapshots?: ProtocolEvent[];
}

export interface ProtocolEventBusStats extends UnknownRecord {
  waiters: number;
  maxWaiters: number;
  waiterTopics: number;
  runtimeTimers: number;
  recentRecords: number;
  recentBytes: number;
  maxRecentRecords: number;
  maxRecentBytes: number;
  scheduledWakeups: number;
  rejectedPublishes: number;
}

export interface ProtocolEventBus {
  publish(topic: unknown, payload?: UnknownRecord, options?: ProtocolEventPublishOptions): Promise<Readonly<ProtocolEvent>>;
  readEvents(input?: ProtocolEventReadOptions): Promise<ProtocolEventPage>;
  getSnapshots(topics?: readonly string[]): Promise<ProtocolEvent[]>;
  subscribe(input?: ProtocolEventSubscribeOptions): Promise<ProtocolEventPage>;
  getStats(): Promise<Readonly<ProtocolEventBusStats>>;
  close(): Promise<void>;
}

interface InternalEventPage extends ProtocolEventPage {
  responseBytes: number;
  revision: number;
}

interface BoundedEvent {
  event: ProtocolEventCandidate;
  byteLength: number;
}

interface Waiter {
  id: number;
  topics: readonly string[];
  deadline: number;
  generation: number;
  scheduled: boolean;
  settled: boolean;
  reason: string;
  resolve: () => void;
  promise: Promise<void>;
}

interface ScheduleEntry {
  at: number;
  id: number;
  generation: number;
  kind: "poll" | "deadline";
}

interface RecentEvent {
  event: Readonly<ProtocolEvent>;
  bytes: number;
}

function eventBusError(code: string, message: string, statusCode = 500): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

function positiveInteger(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTopic(value: unknown): string {
  return String(value || "").trim().slice(0, 256);
}

function normalizeTopics(topics: readonly unknown[] = [], maxTopics: number): string[] {
  const normalized = [...new Set(topics.map(normalizeTopic).filter(Boolean))].sort();
  if (normalized.length > maxTopics) {
    throw eventBusError(
      "protocol_event_topics_exceeded",
      "Protocol event subscription contains too many topics.",
      400
    );
  }
  return normalized;
}

function limitValue(value: unknown): number {
  return Math.max(1, Math.min(MAX_LIMIT, Number(value || DEFAULT_LIMIT) || DEFAULT_LIMIT));
}

function timeoutValue(value: unknown): number {
  return Math.max(0, Math.min(MAX_TIMEOUT_MS, Number(value || 0) || 0));
}

function requireEventStore(eventStore: ProtocolEventStore | undefined): ProtocolEventStore {
  if (!eventStore) {
    throw new TypeError("ProtocolEventStore.publish is required.");
  }
  for (const method of ["publish", "read", "getLatest", "getRevision", "getStats"] as const) {
    if (typeof eventStore[method] !== "function") {
      throw new TypeError(`ProtocolEventStore.${method} is required.`);
    }
  }
  return eventStore;
}

function boundEventRecord(event: ProtocolEventCandidate, maxEventBytes: number): BoundedEvent {
  const serialized = JSON.stringify(event);
  const byteLength = Buffer.byteLength(serialized);
  if (byteLength <= maxEventBytes) return { event, byteLength };
  const bounded: ProtocolEventCandidate = {
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

function metadataOnlyEvent(event: ProtocolEvent, originalBytes: number): ProtocolEvent {
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

function boundEventPage(
  page: { cursor: number; nextCursor: number; events: ProtocolEvent[]; revision: number },
  maxResponseBytes: number
): Omit<InternalEventPage, "topics"> {
  const events: ProtocolEvent[] = [];
  let responseBytes = 2;
  let truncated = false;
  let cursor = page.cursor;
  for (const event of page.events) {
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
      cursor = Number(event.offset || cursor || 0);
    }
    truncated = true;
    break;
  }
  return {
    cursor,
    events,
    responseBytes,
    nextCursor: truncated
      ? Number(events.at(-1)?.offset || cursor || 0)
      : Number(page.nextCursor || cursor || 0),
    revision: Number(page.revision || 0)
  };
}

function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code || fallback)
    : fallback;
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
}: ProtocolEventBusOptions = {}): ProtocolEventBus {
  const store = requireEventStore(eventStore);
  const topicLimit = positiveInteger(maxTopics, DEFAULT_MAX_TOPICS, 512);
  const waiterLimit = positiveInteger(maxWaiters, MAX_WAITERS, MAX_WAITERS);
  const eventByteLimit = positiveInteger(maxEventBytes, DEFAULT_MAX_EVENT_BYTES, 16 * 1024 * 1024);
  const responseByteLimit = positiveInteger(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 64 * 1024 * 1024);
  const minimumPollMs = positiveInteger(pollMinMs, DEFAULT_POLL_MIN_MS, 1_000);
  const maximumPollMs = Math.max(minimumPollMs, positiveInteger(pollMaxMs, DEFAULT_POLL_MAX_MS, 5_000));
  const recentRecordLimit = positiveInteger(maxRecentRecords, DEFAULT_MAX_RECENT_RECORDS, 65_536);
  const recentByteLimit = positiveInteger(maxRecentBytes, DEFAULT_MAX_RECENT_BYTES, 256 * 1024 * 1024);
  const waiters = new Map<number, Waiter>();
  const waitersByTopic = new Map<string, Set<Waiter>>();
  const allTopicWaiters = new Set<Waiter>();
  const scheduleHeap: ScheduleEntry[] = [];
  const recentEvents: RecentEvent[] = [];
  let recentBytes = 0;
  let recentLastOffset = 0;
  let schedulerTimer: NodeJS.Timeout | null = null;
  let schedulerAt = 0;
  let waiterSequence = 0;
  let scheduledWakeups = 0;
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let rejectedPublishes = 0;

  function heapSwap(left: number, right: number): void {
    const value = scheduleHeap[left];
    scheduleHeap[left] = scheduleHeap[right];
    scheduleHeap[right] = value;
  }

  function heapPush(entry: ScheduleEntry): void {
    scheduleHeap.push(entry);
    let index = scheduleHeap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (scheduleHeap[parent].at <= scheduleHeap[index].at) break;
      heapSwap(parent, index);
      index = parent;
    }
  }

  function heapPop(): ScheduleEntry | null {
    if (scheduleHeap.length === 0) return null;
    const first = scheduleHeap[0];
    const last = scheduleHeap.pop();
    if (scheduleHeap.length > 0 && last) {
      scheduleHeap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < scheduleHeap.length && scheduleHeap[left].at < scheduleHeap[smallest].at) smallest = left;
        if (right < scheduleHeap.length && scheduleHeap[right].at < scheduleHeap[smallest].at) smallest = right;
        if (smallest === index) break;
        heapSwap(index, smallest);
        index = smallest;
      }
    }
    return first;
  }

  function armScheduler(): void {
    if (scheduleHeap.length === 0 || closed) return;
    const nextAt = scheduleHeap[0].at;
    if (schedulerTimer && schedulerAt <= nextAt) return;
    if (schedulerTimer) clearTimeout(schedulerTimer);
    schedulerAt = nextAt;
    schedulerTimer = setTimeout(runScheduler, Math.max(0, nextAt - Date.now()));
    schedulerTimer.unref?.();
  }

  function scheduleWaiter(waiter: Waiter | undefined, reason = "event"): void {
    if (!waiter || waiter.settled || waiter.scheduled) return;
    waiter.scheduled = true;
    waiter.reason = reason;
    scheduledWakeups += 1;
    waiter.resolve();
  }

  function runScheduler(): void {
    schedulerTimer = null;
    schedulerAt = 0;
    const nowMs = Date.now();
    while (scheduleHeap.length > 0 && scheduleHeap[0].at <= nowMs) {
      const entry = heapPop();
      if (!entry) break;
      const waiter = waiters.get(entry.id);
      if (!waiter || waiter.generation !== entry.generation || waiter.settled) continue;
      scheduleWaiter(waiter, entry.kind);
    }
    armScheduler();
  }

  function addWaiterIndex(waiter: Waiter): void {
    waiters.set(waiter.id, waiter);
    if (waiter.topics.length === 0) {
      allTopicWaiters.add(waiter);
    } else {
      for (const topic of waiter.topics) {
        let topicWaiters = waitersByTopic.get(topic);
        if (!topicWaiters) {
          topicWaiters = new Set<Waiter>();
          waitersByTopic.set(topic, topicWaiters);
        }
        topicWaiters.add(waiter);
      }
    }
  }

  function removeWaiterIndex(waiter: Waiter | undefined): void {
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    waiters.delete(waiter.id);
    allTopicWaiters.delete(waiter);
    for (const topic of waiter.topics) {
      const topicWaiters = waitersByTopic.get(topic);
      topicWaiters?.delete(waiter);
      if (topicWaiters?.size === 0) waitersByTopic.delete(topic);
    }
  }

  function registerWaiter(topics: readonly string[], deadline: number, pollAt: number): Waiter {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => { resolve = settle; });
    const waiter: Waiter = {
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
    heapPush({
      at: Math.min(deadline, pollAt),
      id: waiter.id,
      generation: waiter.generation,
      kind: pollAt <= deadline ? "poll" : "deadline"
    });
    if (pollAt < deadline) {
      heapPush({ at: deadline, id: waiter.id, generation: waiter.generation, kind: "deadline" });
    }
    armScheduler();
    return waiter;
  }

  function wakeSubscribers(topic: string): void {
    for (const waiter of allTopicWaiters) scheduleWaiter(waiter, "event");
    for (const waiter of waitersByTopic.get(topic) || []) scheduleWaiter(waiter, "event");
  }

  function appendRecent(event: Readonly<ProtocolEvent>): void {
    const offset = Number(event.offset || 0);
    if (offset <= 0) return;
    if (recentLastOffset > 0 && offset !== recentLastOffset + 1) {
      recentEvents.length = 0;
      recentBytes = 0;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    recentEvents.push({ event, bytes });
    recentBytes += bytes;
    recentLastOffset = offset;
    while (recentEvents.length > recentRecordLimit || recentBytes > recentByteLimit) {
      const removed = recentEvents.shift();
      recentBytes -= removed?.bytes || 0;
    }
  }

  function readRecent(
    cursor: number,
    topics: readonly string[],
    limit: number,
    revision = 0
  ): Omit<InternalEventPage, "topics"> | null {
    if (recentEvents.length === 0) return null;
    const firstOffset = Number(recentEvents[0].event.offset || 0);
    if (cursor < firstOffset - 1) return null;
    const topicSet = topics.length > 0 ? new Set(topics) : null;
    const events: ProtocolEvent[] = [];
    for (const entry of recentEvents) {
      if (entry.event.offset <= cursor) continue;
      if (topicSet && !topicSet.has(entry.event.topic)) continue;
      events.push(entry.event as ProtocolEvent);
      if (events.length >= limitValue(limit)) break;
    }
    return boundEventPage({
      cursor,
      nextCursor: events.length >= limitValue(limit)
        ? Number(events.at(-1)?.offset || cursor)
        : Math.max(cursor, recentLastOffset),
      events,
      revision
    }, responseByteLimit);
  }

  async function publish(
    topic: unknown,
    payload: UnknownRecord = {},
    options: ProtocolEventPublishOptions = {}
  ): Promise<Readonly<ProtocolEvent>> {
    if (closed) {
      throw eventBusError("protocol_event_bus_closed", "Protocol event bus is closed.", 503);
    }
    const normalizedTopic = normalizeTopic(topic);
    if (!normalizedTopic) {
      throw eventBusError("protocol_event_topic_required", "发布事件缺少 topic。", 400);
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
      payload: summarizeForLog(bounded.event.payload, { maxDepth: 4, maxArrayItems: 6, maxObjectKeys: 40 })
    });
    const startedAt = Date.now();
    try {
      const result = await store.publish(bounded.event, { retain: options.retain !== false });
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
    } catch (error: unknown) {
      rejectedPublishes += 1;
      logger?.error?.("event.publish.failed", {
        topic: normalizedTopic,
        type: bounded.event.type,
        reasonCode: errorCode(error, "protocol_event_publish_failed"),
        error: summarizeError(error)
      });
      throw error;
    }
  }

  async function readWithRevision({
    cursor = 0,
    topics = [],
    limit = DEFAULT_LIMIT
  }: ProtocolEventReadOptions = {}): Promise<InternalEventPage> {
    const normalizedTopics = normalizeTopics(topics, topicLimit);
    const afterOffset = Math.max(0, Number(cursor || 0) || 0);
    const page = await store.read({ cursor: afterOffset, topics: normalizedTopics, limit: limitValue(limit) });
    const bounded = boundEventPage({ ...page, cursor: afterOffset }, responseByteLimit);
    return {
      cursor: afterOffset,
      nextCursor: bounded.nextCursor,
      topics: normalizedTopics,
      events: bounded.events,
      responseBytes: bounded.responseBytes,
      revision: bounded.revision
    };
  }

  async function readEvents(input: ProtocolEventReadOptions = {}): Promise<ProtocolEventPage> {
    const { revision: _revision, responseBytes: _responseBytes, ...result } = await readWithRevision(input);
    return result;
  }

  async function getSnapshotPage(
    topics: readonly string[] = [],
    byteBudget = responseByteLimit
  ): Promise<Omit<InternalEventPage, "topics">> {
    const normalizedTopics = normalizeTopics(topics, topicLimit);
    const events = await store.getLatest(normalizedTopics);
    return boundEventPage({ cursor: 0, nextCursor: Number(events.at(-1)?.offset || 0), events, revision: 0 }, byteBudget);
  }

  async function getSnapshots(topics: readonly string[] = []): Promise<ProtocolEvent[]> {
    return (await getSnapshotPage(topics)).events;
  }

  async function addSnapshots(result: InternalEventPage, normalizedTopics: readonly string[]): Promise<void> {
    const remainingBytes = Math.max(2, responseByteLimit - Number(result.responseBytes || 2) + 2);
    result.snapshots = (await getSnapshotPage(normalizedTopics, remainingBytes)).events;
  }

  async function subscribe({
    cursor = 0,
    topics = [],
    timeoutMs = 0,
    limit = DEFAULT_LIMIT,
    includeSnapshot = false,
    signal = null
  }: ProtocolEventSubscribeOptions = {}): Promise<ProtocolEventPage> {
    const safeTimeoutMs = timeoutValue(timeoutMs);
    const subscribeStartedAt = Date.now();
    const normalizedTopics = normalizeTopics(topics, topicLimit);
    const read = (): Promise<InternalEventPage> => readWithRevision({ cursor, topics: normalizedTopics, limit });
    let result = await read();
    if (includeSnapshot) await addSnapshots(result, normalizedTopics);
    if (closed || result.events.length > 0 || safeTimeoutMs <= 0 || signal?.aborted) {
      const { revision: _revision, responseBytes: _responseBytes, ...publicResult } = result;
      return publicResult;
    }
    if (waiters.size >= waiterLimit) {
      logger?.warn?.("event.subscribe.waiter_limit", { waiters: waiters.size, maxWaiters: waiterLimit });
      const { revision: _revision, responseBytes: _responseBytes, ...publicResult } = result;
      return publicResult;
    }

    const deadline = Date.now() + safeTimeoutMs;
    let pollMs = minimumPollMs;
    let lastRevision = result.revision;
    while (!closed && !signal?.aborted && Date.now() < deadline) {
      const waiter = registerWaiter(normalizedTopics, deadline, Math.min(deadline, Date.now() + pollMs));
      const abort = (): void => scheduleWaiter(waiter, "abort");
      signal?.addEventListener("abort", abort, { once: true });
      const recent = readRecent(cursor, normalizedTopics, limit, lastRevision);
      if (recent?.events.length) scheduleWaiter(waiter, "ring");
      if (!waiter.scheduled) {
        const revision = await store.getRevision();
        if (revision !== lastRevision) scheduleWaiter(waiter, "revision");
      }
      await waiter.promise;
      removeWaiterIndex(waiter);
      signal?.removeEventListener("abort", abort);
      if (closed || signal?.aborted || Date.now() >= deadline || waiter.reason === "deadline") break;

      const mustReadStore = waiter.reason === "poll" || waiter.reason === "revision";
      const ringPage = mustReadStore ? null : readRecent(cursor, normalizedTopics, limit, lastRevision);
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

  async function getStats(): Promise<Readonly<ProtocolEventBusStats>> {
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

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    if (schedulerTimer) clearTimeout(schedulerTimer);
    schedulerTimer = null;
    schedulerAt = 0;
    for (const waiter of waiters.values()) scheduleWaiter(waiter, "closed");
    closePromise = Promise.resolve();
    return closePromise;
  }

  return Object.freeze({ publish, readEvents, getSnapshots, subscribe, getStats, close });
}
