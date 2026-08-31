import crypto from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import {
  getRuntimeLogger,
  summarizeError
} from "../observability/runtime-logger.ts";

type UnknownRecord = Record<string, unknown>;
type StateMutationError = Error & { code: string };
type StateLogger = {
  debug?: (event: string, fields?: UnknownRecord) => void;
  error?: (event: string, fields?: UnknownRecord) => void;
} | null;

export interface StateMutationContext {
  readonly signal: AbortSignal;
  assertActive(): void;
}

export interface StateMutationPolicy {
  maxQueuedPerLane: number;
  maxQueuedGlobal: number;
  maxActiveLanes: number;
  defaultQueueWaitTimeoutMs: number;
  maxQueueWaitTimeoutMs: number;
  defaultExecutionTimeoutMs: number;
  maxExecutionTimeoutMs: number;
  maxKeyBytes: number;
}

interface StateMutationOptions {
  logger?: StateLogger;
  metadata?: UnknownRecord;
  signal?: AbortSignal | null;
  timeoutMs?: unknown;
  queueWaitTimeoutMs?: unknown;
}

interface JsonWriteOptions {
  metadata?: UnknownRecord;
  trailingNewline?: boolean;
  ignoreMissingParent?: boolean;
}

interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
  flag?: string | number;
  ignoreMissingParent?: boolean;
  onTempFileReady?: ((paths: { filePath: string; tempPath: string; parentDirectory: string }) => void | Promise<void>) | null;
  kind?: string;
  metadata?: UnknownRecord;
}

type AtomicWriteInput = string | AtomicWriteOptions;

interface MutationEntry {
  task: (context: StateMutationContext) => unknown | Promise<unknown>;
  logger: StateLogger;
  signal: AbortSignal | null;
  queuedAt: number;
  timeoutMs: number;
  queueWaitTimeoutMs: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  queuedCreditHeld: boolean;
  slot: number;
  queueWaitTimer: NodeJS.Timeout | null;
  detachQueuedAbort: (() => void) | null;
}

interface MutationLane {
  active: MutationEntry | null;
  poison: MutationEntry | null;
  queue: BoundedMutationDeque<MutationEntry>;
  idle: Deferred<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface StateMutationCoordinator {
  readonly policy: Readonly<StateMutationPolicy>;
  queueStateMutation<T = unknown>(
    key: unknown,
    task: (context: StateMutationContext) => T | Promise<T>,
    options?: StateMutationOptions
  ): Promise<T>;
  waitForStateIdle(key: unknown): Promise<void>;
  snapshot(): Readonly<{
    laneCount: number;
    activeCount: number;
    fencedCount: number;
    queuedCount: number;
    capacity: Readonly<StateMutationPolicy>;
    reasonCounts: Readonly<Record<string, number>>;
  }>;
}

interface DequeOperation {
  operation: string;
  steps: number;
  size: number;
  capacity: number;
}

let defaultStateMutationDispatcher: StateMutationDispatcher | null = null;
export const STATE_MUTATION_TIMEOUT_MS = 60_000;
export const STATE_MUTATION_POLICY: Readonly<StateMutationPolicy> = Object.freeze({
  maxQueuedPerLane: 256,
  maxQueuedGlobal: 4_096,
  maxActiveLanes: 2_048,
  defaultQueueWaitTimeoutMs: 60_000,
  maxQueueWaitTimeoutMs: 300_000,
  defaultExecutionTimeoutMs: STATE_MUTATION_TIMEOUT_MS,
  maxExecutionTimeoutMs: 300_000,
  maxKeyBytes: 4_096
});
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set<string>(["EACCES", "EINVAL", "ENOTSUP", "EPERM"]);

function stateMutationError(code: string, message: string): StateMutationError {
  const error = new Error(message) as StateMutationError;
  error.code = code;
  return error;
}

function timeoutError(): StateMutationError {
  return stateMutationError(
    "STATE_MUTATION_TIMEOUT",
    "State mutation timed out before it reached a safe terminal state."
  );
}

function fencedError(): StateMutationError {
  return stateMutationError(
    "STATE_MUTATION_QUEUE_FENCED",
    "State mutation queue is fenced by an indeterminate earlier mutation."
  );
}

function schedulerError(code: string, message: string): StateMutationError {
  return stateMutationError(code, message);
}

function queueAbortedError(): StateMutationError {
  return schedulerError(
    "STATE_MUTATION_QUEUE_ABORTED",
    "State mutation was cancelled before execution."
  );
}

function activeAbortedError(): StateMutationError {
  return schedulerError(
    "STATE_MUTATION_ABORTED",
    "State mutation was cancelled while executing."
  );
}

function normalizeKey(key: unknown): string {
  return String(key || "default");
}

function positiveIntegerAtMost(value: unknown, fallback: number, maximum: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1
    ? Math.min(Math.floor(numeric), maximum)
    : fallback;
}

function lowerPolicyLimit(value: unknown, hardLimit: number): number {
  return positiveIntegerAtMost(value, hardLimit, hardLimit);
}

function normalizeStateMutationPolicy(input: UnknownRecord = {}): Readonly<StateMutationPolicy> {
  const maxQueueWaitTimeoutMs = lowerPolicyLimit(
    input.maxQueueWaitTimeoutMs,
    STATE_MUTATION_POLICY.maxQueueWaitTimeoutMs
  );
  const maxExecutionTimeoutMs = lowerPolicyLimit(
    input.maxExecutionTimeoutMs,
    STATE_MUTATION_POLICY.maxExecutionTimeoutMs
  );
  return Object.freeze({
    maxQueuedPerLane: lowerPolicyLimit(
      input.maxQueuedPerLane,
      STATE_MUTATION_POLICY.maxQueuedPerLane
    ),
    maxQueuedGlobal: lowerPolicyLimit(
      input.maxQueuedGlobal,
      STATE_MUTATION_POLICY.maxQueuedGlobal
    ),
    maxActiveLanes: lowerPolicyLimit(
      input.maxActiveLanes,
      STATE_MUTATION_POLICY.maxActiveLanes
    ),
    defaultQueueWaitTimeoutMs: Math.min(
      lowerPolicyLimit(
        input.defaultQueueWaitTimeoutMs,
        STATE_MUTATION_POLICY.defaultQueueWaitTimeoutMs
      ),
      maxQueueWaitTimeoutMs
    ),
    maxQueueWaitTimeoutMs,
    defaultExecutionTimeoutMs: Math.min(
      lowerPolicyLimit(
        input.defaultExecutionTimeoutMs,
        STATE_MUTATION_POLICY.defaultExecutionTimeoutMs
      ),
      maxExecutionTimeoutMs
    ),
    maxExecutionTimeoutMs,
    maxKeyBytes: lowerPolicyLimit(input.maxKeyBytes, STATE_MUTATION_POLICY.maxKeyBytes)
  });
}

function createDeferred<T = unknown>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  let settled = false;
  const promise = new Promise<T>((resolvePromise, rejectPromise): void => {
    resolve = (value: T): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    reject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
  });
  promise.catch((): undefined => undefined);
  return Object.freeze({ promise, resolve, reject });
}

export class BoundedMutationDeque<T = unknown> {
  readonly capacity: number;
  readonly free: number[];
  head: number;
  readonly next: Int32Array;
  readonly onOperation: ((operation: Readonly<DequeOperation>) => void) | null;
  readonly operationCounts: Record<string, number>;
  readonly previous: Int32Array;
  size: number;
  tail: number;
  readonly values: Array<T | undefined>;
  constructor(capacity: unknown, { onOperation = null }: { onOperation?: ((operation: Readonly<DequeOperation>) => void) | null } = {}) {
    const normalizedCapacity = Number(capacity);
    if (!Number.isSafeInteger(normalizedCapacity) || normalizedCapacity < 1) {
      throw new TypeError("BoundedMutationDeque capacity must be a positive safe integer.");
    }
    this.capacity = normalizedCapacity;
    this.size = 0;
    this.head = -1;
    this.tail = -1;
    this.values = Array.from({ length: normalizedCapacity });
    this.next = new Int32Array(normalizedCapacity);
    this.previous = new Int32Array(normalizedCapacity);
    this.next.fill(-1);
    this.previous.fill(-1);
    this.free = Array.from({ length: normalizedCapacity });
    for (let index = 0; index < normalizedCapacity; index += 1) {
      this.free[index] = normalizedCapacity - index - 1;
    }
    this.onOperation = typeof onOperation === "function" ? onOperation : null;
    this.operationCounts = { enqueue: 0, dequeue: 0, remove: 0 };
  }

  #record(operation: string): void {
    this.operationCounts[operation] += 1;
    this.onOperation?.(Object.freeze({
      operation,
      steps: 1,
      size: this.size,
      capacity: this.capacity
    }));
  }

  #unlink(slot: number): T | undefined {
    const previous = this.previous[slot];
    const next = this.next[slot];
    if (previous === -1) this.head = next;
    else this.next[previous] = next;
    if (next === -1) this.tail = previous;
    else this.previous[next] = previous;
    const value = this.values[slot];
    this.values[slot] = undefined;
    this.next[slot] = -1;
    this.previous[slot] = -1;
    this.free.push(slot);
    this.size -= 1;
    return value;
  }

  enqueue(value: T): number {
    this.#record("enqueue");
    if (this.size >= this.capacity) return -1;
    const slot = this.free.pop();
    if (slot === undefined) return -1;
    this.values[slot] = value;
    this.previous[slot] = this.tail;
    this.next[slot] = -1;
    if (this.tail === -1) this.head = slot;
    else this.next[this.tail] = slot;
    this.tail = slot;
    this.size += 1;
    return slot;
  }

  dequeue(): T | undefined {
    this.#record("dequeue");
    if (this.head === -1) return undefined;
    return this.#unlink(this.head);
  }

  remove(slot: number): T | undefined {
    this.#record("remove");
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= this.capacity) return undefined;
    if (this.values[slot] === undefined) return undefined;
    return this.#unlink(slot);
  }

  snapshot(): Readonly<{ capacity: number; size: number; backingSlots: number; operationCounts: Readonly<Record<string, number>> }> {
    return Object.freeze({
      capacity: this.capacity,
      size: this.size,
      backingSlots: this.values.length,
      operationCounts: Object.freeze({ ...this.operationCounts })
    });
  }
}

export function createStateMutationCoordinator({
  policy: policyInput = {},
  onOperation = null,
  loggerProvider = getRuntimeLogger
}: {
  policy?: UnknownRecord;
  onOperation?: ((operation: Readonly<DequeOperation>) => void) | null;
  loggerProvider?: StateLogger | (() => StateLogger);
} = {}): StateMutationCoordinator {
  const policy = normalizeStateMutationPolicy(policyInput);
  const lanes = new Map<string, MutationLane>();
  const reasonCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  const resolveLogger: () => StateLogger = typeof loggerProvider === "function"
    ? loggerProvider
    : (): StateLogger => loggerProvider || null;
  let queuedCount = 0;

  function noteReason(code?: string): void {
    if (!code) return;
    reasonCounts[code] = Number(reasonCounts[code] || 0) + 1;
  }

  function rejectWith(logger: StateLogger, event: string, error: StateMutationError, fields: UnknownRecord = {}): Promise<never> {
    noteReason(error.code);
    logger?.error?.(event, {
      ...fields,
      reasonCode: error.code,
      error: summarizeError(error)
    });
    return Promise.reject(error);
  }

  function releaseQueuedEntry(entry: MutationEntry): void {
    if (!entry.queuedCreditHeld) return;
    entry.queuedCreditHeld = false;
    queuedCount -= 1;
    if (entry.queueWaitTimer) clearTimeout(entry.queueWaitTimer);
    entry.queueWaitTimer = null;
    entry.detachQueuedAbort?.();
    entry.detachQueuedAbort = null;
  }

  function settleLaneIfIdle(key: string, lane: MutationLane): boolean {
    if (lane.active || lane.poison || lane.queue.size > 0) return false;
    if (lanes.get(key) === lane) lanes.delete(key);
    lane.idle.resolve();
    return true;
  }

  function rejectQueuedMutations(key: string, lane: MutationLane): void {
    let entry: MutationEntry | undefined;
    while ((entry = lane.queue.dequeue()) !== undefined) {
      entry.slot = -1;
      releaseQueuedEntry(entry);
      const error = fencedError();
      noteReason(error.code);
      entry.reject(error);
    }
    settleLaneIfIdle(key, lane);
  }

  function startNextMutation(key: string, lane: MutationLane): void {
    if (lane.active || lane.poison) return;
    const entry = lane.queue.dequeue();
    if (!entry) {
      settleLaneIfIdle(key, lane);
      return;
    }
    entry.slot = -1;
    releaseQueuedEntry(entry);
    if (entry.signal?.aborted) {
      const error = queueAbortedError();
      noteReason(error.code);
      entry.reject(error);
      startNextMutation(key, lane);
      return;
    }

    lane.active = entry;
    const logger = entry.logger;
    const startedAt = Date.now();
    const abortController = new AbortController();
    let terminalError: unknown = null;
    let executionTimer: NodeJS.Timeout | null = null;
    let detachActiveAbort: (() => void) | null = null;

    logger?.debug?.("state.queue.started", {
      waitedMs: startedAt - entry.queuedAt,
      queuedCount,
      laneCount: lanes.size
    });

    const context: Readonly<StateMutationContext> = Object.freeze({
      signal: abortController.signal,
      assertActive(): void {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason || fencedError();
        }
      }
    });

    const fenceActiveEntry = (error: StateMutationError, event: string): void => {
      if (lane.active !== entry || terminalError) return;
      terminalError = error;
      lane.poison = entry;
      noteReason(error.code);
      abortController.abort(error);
      entry.reject(error);
      rejectQueuedMutations(key, lane);
      lane.idle.reject(fencedError());
      logger?.error?.(event, {
        waitedMs: startedAt - entry.queuedAt,
        durationMs: Date.now() - startedAt,
        reasonCode: error.code,
        error: summarizeError(error)
      });
    };

    executionTimer = setTimeout((): void => {
      fenceActiveEntry(timeoutError(), "state.queue.timed_out");
    }, entry.timeoutMs);
    executionTimer.unref?.();

    if (entry.signal) {
      const abortActive = (): void => {
        fenceActiveEntry(activeAbortedError(), "state.queue.aborted");
      };
      entry.signal.addEventListener("abort", abortActive, { once: true });
      detachActiveAbort = (): void => entry.signal?.removeEventListener("abort", abortActive);
      if (entry.signal.aborted) abortActive();
    }

    Promise.resolve()
      .then(() => entry.task(context))
      .then((result: unknown): void => {
        if (terminalError) return;
        logger?.debug?.("state.queue.completed", {
          waitedMs: startedAt - entry.queuedAt,
          durationMs: Date.now() - startedAt
        });
        entry.resolve(result);
      }, (error: unknown): void => {
        if (terminalError) return;
        logger?.error?.("state.queue.failed", {
          waitedMs: startedAt - entry.queuedAt,
          durationMs: Date.now() - startedAt,
          error: summarizeError(error)
        });
        entry.reject(error);
      })
      .finally((): void => {
        if (executionTimer) clearTimeout(executionTimer);
        detachActiveAbort?.();
        if (lane.active !== entry) return;
        lane.active = null;
        if (lane.poison === entry) {
          lane.poison = null;
          logger?.debug?.("state.queue.fence_released", {
            durationMs: Date.now() - startedAt
          });
        }
        startNextMutation(key, lane);
      });
  }

  function queueStateMutation<T = unknown>(
    key: unknown,
    task: (context: StateMutationContext) => T | Promise<T>,
    options: StateMutationOptions = {}
  ): Promise<T> {
    if (typeof task !== "function") {
      throw new TypeError("queueStateMutation requires a task function.");
    }
    const normalizedKey = normalizeKey(key);
    const logger = options.logger || resolveLogger();
    if (Buffer.byteLength(normalizedKey, "utf8") > policy.maxKeyBytes) {
      return rejectWith(
        logger,
        "state.queue.rejected",
        schedulerError("STATE_MUTATION_KEY_TOO_LARGE", "State mutation key exceeds its byte limit.")
      );
    }
    if (options.signal?.aborted) {
      return rejectWith(logger, "state.queue.rejected", queueAbortedError());
    }

    let lane = lanes.get(normalizedKey);
    if (lane?.poison) {
      return rejectWith(logger, "state.queue.rejected", fencedError());
    }
    if (lane && lane.queue.size >= policy.maxQueuedPerLane) {
      return rejectWith(
        logger,
        "state.queue.rejected",
        schedulerError(
          "STATE_MUTATION_LANE_CAPACITY_EXCEEDED",
          "State mutation lane has reached its pending capacity."
        ),
        { queuedCount, laneCount: lanes.size }
      );
    }
    if (queuedCount >= policy.maxQueuedGlobal) {
      return rejectWith(
        logger,
        "state.queue.rejected",
        schedulerError(
          "STATE_MUTATION_GLOBAL_CAPACITY_EXCEEDED",
          "State mutation scheduler has reached its pending capacity."
        ),
        { queuedCount, laneCount: lanes.size }
      );
    }
    if (!lane && lanes.size >= policy.maxActiveLanes) {
      return rejectWith(
        logger,
        "state.queue.rejected",
        schedulerError(
          "STATE_MUTATION_LANE_LIMIT_EXCEEDED",
          "State mutation scheduler has reached its active lane capacity."
        ),
        { queuedCount, laneCount: lanes.size }
      );
    }

    let createdLane = false;
    if (!lane) {
      createdLane = true;
      lane = {
        active: null,
        poison: null,
        queue: new BoundedMutationDeque(policy.maxQueuedPerLane, { onOperation }),
        idle: createDeferred()
      };
      lanes.set(normalizedKey, lane);
    }

    const queuedAt = Date.now();
    const timeoutMs = positiveIntegerAtMost(
      options.timeoutMs,
      policy.defaultExecutionTimeoutMs,
      policy.maxExecutionTimeoutMs
    );
    const queueWaitTimeoutMs = positiveIntegerAtMost(
      options.queueWaitTimeoutMs,
      policy.defaultQueueWaitTimeoutMs,
      policy.maxQueueWaitTimeoutMs
    );

    queuedCount += 1;
    let entry: MutationEntry | undefined;
    const operation = new Promise<unknown>((resolve, reject): void => {
      entry = {
        task: task as (context: StateMutationContext) => unknown | Promise<unknown>,
        logger,
        signal: options.signal || null,
        queuedAt,
        timeoutMs,
        queueWaitTimeoutMs,
        resolve,
        reject,
        queuedCreditHeld: true,
        slot: -1,
        queueWaitTimer: null,
        detachQueuedAbort: null
      };
    });

    if (!entry) throw new Error("State mutation entry was not initialized.");
    const queuedEntry = entry;
    queuedEntry.slot = lane.queue.enqueue(queuedEntry);
    if (queuedEntry.slot < 0) {
      releaseQueuedEntry(queuedEntry);
      if (createdLane) settleLaneIfIdle(normalizedKey, lane);
      return rejectWith(
        logger,
        "state.queue.rejected",
        schedulerError(
          "STATE_MUTATION_LANE_CAPACITY_EXCEEDED",
          "State mutation lane has reached its pending capacity."
        )
      );
    }

    const cancelQueued = (error: StateMutationError, event: string): boolean => {
      if (queuedEntry.slot < 0) return false;
      const removed = lane.queue.remove(queuedEntry.slot);
      if (!removed) return false;
      queuedEntry.slot = -1;
      releaseQueuedEntry(queuedEntry);
      noteReason(error.code);
      queuedEntry.reject(error);
      logger?.error?.(event, {
        queuedCount,
        laneCount: lanes.size,
        reasonCode: error.code,
        error: summarizeError(error)
      });
      settleLaneIfIdle(normalizedKey, lane);
      return true;
    };

    queuedEntry.queueWaitTimer = setTimeout((): void => {
      cancelQueued(
        schedulerError(
          "STATE_MUTATION_QUEUE_WAIT_TIMEOUT",
          "State mutation exceeded its queue wait deadline."
        ),
        "state.queue.wait_timed_out"
      );
    }, queueWaitTimeoutMs);
    queuedEntry.queueWaitTimer.unref?.();

    if (queuedEntry.signal) {
      const abortQueued = (): void => { cancelQueued(queueAbortedError(), "state.queue.queue_aborted"); };
      queuedEntry.signal.addEventListener("abort", abortQueued, { once: true });
      queuedEntry.detachQueuedAbort = (): void => queuedEntry.signal?.removeEventListener("abort", abortQueued);
    }

    logger?.debug?.("state.queue.enqueued", {
      queueDepthBefore: lane.queue.size - 1 + (lane.active ? 1 : 0),
      queuedCount,
      laneCount: lanes.size
    });
    startNextMutation(normalizedKey, lane);
    return operation as Promise<T>;
  }

  function waitForStateIdle(key: unknown): Promise<void> {
    const normalizedKey = normalizeKey(key);
    if (Buffer.byteLength(normalizedKey, "utf8") > policy.maxKeyBytes) {
      return Promise.reject(
        schedulerError("STATE_MUTATION_KEY_TOO_LARGE", "State mutation key exceeds its byte limit.")
      );
    }
    const lane = lanes.get(normalizedKey);
    if (!lane) return Promise.resolve();
    if (lane.poison) return Promise.reject(fencedError());
    return lane.idle.promise;
  }

  function snapshot(): Readonly<{
    laneCount: number;
    activeCount: number;
    fencedCount: number;
    queuedCount: number;
    capacity: Readonly<StateMutationPolicy>;
    reasonCounts: Readonly<Record<string, number>>;
  }> {
    let activeCount = 0;
    let fencedCount = 0;
    for (const lane of lanes.values()) {
      if (lane.active) activeCount += 1;
      if (lane.poison) fencedCount += 1;
    }
    return Object.freeze({
      laneCount: lanes.size,
      activeCount,
      fencedCount,
      queuedCount,
      capacity: policy,
      reasonCounts: Object.freeze({ ...reasonCounts })
    });
  }

  return Object.freeze({
    queueStateMutation,
    waitForStateIdle,
    snapshot,
    policy
  });
}

const defaultStateMutationCoordinator: StateMutationCoordinator = createStateMutationCoordinator();

export function queueStateMutation<T = unknown>(
  key: unknown,
  task: (context: StateMutationContext) => T | Promise<T>,
  options: StateMutationOptions = {}
): Promise<T> {
  return defaultStateMutationCoordinator.queueStateMutation(key, task, options);
}

export function stateMutationSchedulerSnapshot(): Readonly<{
  laneCount: number;
  activeCount: number;
  fencedCount: number;
  queuedCount: number;
  capacity: Readonly<StateMutationPolicy>;
  reasonCounts: Readonly<Record<string, number>>;
}> {
  return defaultStateMutationCoordinator.snapshot();
}

interface StateMutationDispatcher {
  mutate<T = unknown>(input?: {
    key?: unknown;
    kind?: string;
    metadata?: UnknownRecord;
    task?: (context: StateMutationContext) => T | Promise<T>;
    signal?: AbortSignal | null;
    queueWaitTimeoutMs?: unknown;
    timeoutMs?: unknown;
  }): Promise<T>;
  writeJson(filePath: string, value: unknown, options?: JsonWriteOptions & { kind?: string }): Promise<void | boolean>;
  appendJsonLine(filePath: string, value: unknown, options?: { kind?: string }): Promise<void>;
}

export function createStateMutationDispatcher({
  logger = null,
  coordinator = null
}: {
  logger?: StateLogger;
  coordinator?: StateMutationCoordinator | null;
} = {}): StateMutationDispatcher {
  const currentLogger = (): StateLogger => logger || (getRuntimeLogger() as unknown as StateLogger);
  const mutationCoordinator = coordinator || defaultStateMutationCoordinator;

  async function mutate<T = unknown>({
    key = "default",
    kind = "state.mutation",
    metadata: _metadata,
    task,
    signal = null,
    queueWaitTimeoutMs,
    timeoutMs
  }: {
    key?: unknown;
    kind?: string;
    metadata?: UnknownRecord;
    task?: (context: StateMutationContext) => T | Promise<T>;
    signal?: AbortSignal | null;
    queueWaitTimeoutMs?: unknown;
    timeoutMs?: unknown;
  } = {}): Promise<T> {
    if (typeof task !== "function") {
      throw new TypeError("StateMutationDispatcher.mutate requires a task function.");
    }
    const normalizedKey = normalizeKey(key);
    currentLogger()?.debug?.("state.dispatch.enqueued", {
      mutationKind: kind
    });
    return mutationCoordinator.queueStateMutation(normalizedKey, async (mutationContext): Promise<T> => {
      const startedAt = Date.now();
      currentLogger()?.debug?.("state.dispatch.started", {
        mutationKind: kind
      });
      try {
        const result = await task(mutationContext);
        currentLogger()?.debug?.("state.dispatch.completed", {
          mutationKind: kind,
          durationMs: Date.now() - startedAt
        });
        return result;
      } catch (error: unknown) {
        currentLogger()?.error?.("state.dispatch.failed", {
          mutationKind: kind,
          durationMs: Date.now() - startedAt,
          error: summarizeError(error)
        });
        throw error;
      }
    }, {
      logger: currentLogger(),
      signal,
      queueWaitTimeoutMs,
      timeoutMs
    });
  }

  return {
    mutate,
    async writeJson(filePath: string, value: unknown, options: JsonWriteOptions & { kind?: string } = {}): Promise<void | boolean> {
      return mutate({
        key: stateFileKey(filePath),
        kind: options.kind || "state.file.write_json",
        task: (): Promise<void | boolean> => atomicWriteJson(filePath, value, options)
      });
    },
    async appendJsonLine(filePath: string, value: unknown, options: { kind?: string } = {}): Promise<void> {
      return mutate({
        key: stateFileKey(filePath),
        kind: options.kind || "state.file.append_jsonl",
        task: (): Promise<void> => appendJsonLine(filePath, value)
      });
    }
  };
}

export function getStateMutationDispatcher(): StateMutationDispatcher {
  if (!defaultStateMutationDispatcher) {
    defaultStateMutationDispatcher = createStateMutationDispatcher();
  }
  return defaultStateMutationDispatcher;
}

export function mutateState<T = unknown>(input: {
  key?: unknown;
  kind?: string;
  metadata?: UnknownRecord;
  task?: (context: StateMutationContext) => T | Promise<T>;
  signal?: AbortSignal | null;
  queueWaitTimeoutMs?: unknown;
  timeoutMs?: unknown;
} = {}): Promise<T> {
  return getStateMutationDispatcher().mutate(input);
}

export function waitForStateIdle(key: unknown): Promise<void> {
  return defaultStateMutationCoordinator.waitForStateIdle(key);
}

export function stateFileKey(filePath: string): string {
  return `file:${path.resolve(filePath)}`;
}

function normalizeAtomicWriteOptions(options: AtomicWriteInput = "utf8"): {
  writeOptions: string | { encoding?: BufferEncoding; mode?: number; flag?: string | number };
  ignoreMissingParent: boolean;
  onTempFileReady: AtomicWriteOptions["onTempFileReady"];
} {
  if (typeof options === "string" || options == null) {
    return {
      writeOptions: options || "utf8",
      ignoreMissingParent: false,
      onTempFileReady: null
    };
  }
  const {
    ignoreMissingParent = false,
    onTempFileReady = null,
    ...writeOptions
  } = options;
  return {
    writeOptions,
    ignoreMissingParent: ignoreMissingParent === true,
    onTempFileReady: typeof onTempFileReady === "function" ? onTempFileReady : null
  };
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return process.platform === "win32" && WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES.has(
    error && typeof error === "object" ? String((error as { code?: unknown }).code || "") : ""
  );
}

async function ensurePrivateStateDirectory(directoryPath: string): Promise<void> {
  const missingDirectories: string[] = [];
  let current = path.resolve(directoryPath);
  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw stateMutationError(
          "STATE_DIRECTORY_PATH_INVALID",
          "State directory ancestry must contain only real directories."
        );
      }
      break;
    } catch (error: unknown) {
      const code = error && typeof error === "object" ? String((error as { code?: unknown }).code || "") : "";
      if (code !== "ENOENT") throw error;
      missingDirectories.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  await fs.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  try {
    await fs.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
  } catch (error: unknown) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  }
  for (const createdDirectory of missingDirectories.reverse()) {
    await syncStateDirectory(path.dirname(createdDirectory));
  }
}

async function syncStateDirectory(directoryPath: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(directoryPath);
    return stat.isDirectory();
  } catch (error: unknown) {
    const code = error && typeof error === "object" ? String((error as { code?: unknown }).code || "") : "";
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteInput = "utf8"
): Promise<boolean> {
  const parentDirectory = path.dirname(filePath);
  const { writeOptions, ignoreMissingParent, onTempFileReady } = normalizeAtomicWriteOptions(options);
  await ensurePrivateStateDirectory(parentDirectory);
  const tempPath = path.join(
    parentDirectory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`
  );
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(tempPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(
      data,
      writeOptions as Parameters<FileHandle["writeFile"]>[1]
    );
    await handle.sync();
    await handle.close();
    handle = null;
    if (onTempFileReady) {
      await onTempFileReady({ filePath, tempPath, parentDirectory });
    }
    await fs.rename(tempPath, filePath);
    try {
      await fs.chmod(filePath, PRIVATE_FILE_MODE);
    } catch (error: unknown) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
    await syncStateDirectory(parentDirectory);
    return true;
  } catch (error: unknown) {
    await handle?.close().catch((): void => {});
    await fs.rm(tempPath, { force: true }).catch((): void => {});
    const code = error && typeof error === "object" ? String((error as { code?: unknown }).code || "") : "";
    if (ignoreMissingParent && code === "ENOENT" && !(await directoryExists(parentDirectory))) {
      return false;
    }
    throw error;
  }
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  { trailingNewline = true, ignoreMissingParent = false }: JsonWriteOptions = {}
): Promise<boolean> {
  const payload = `${JSON.stringify(value, null, 2)}${trailingNewline ? "\n" : ""}`;
  return atomicWriteFile(filePath, payload, { encoding: "utf8", ignoreMissingParent });
}

export async function atomicWriteJsonThroughState(filePath: string, value: unknown, options: JsonWriteOptions & { kind?: string } = {}): Promise<void | boolean> {
  return getStateMutationDispatcher().writeJson(filePath, value, options);
}

export async function readJsonFile(filePath: string, fallback: unknown = undefined): Promise<unknown> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    if (!content.trim()) {
      return fallback;
    }
    return JSON.parse(content);
  } catch (error: unknown) {
    const code = error && typeof error === "object" ? String((error as { code?: unknown }).code || "") : "";
    if (code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function truncateTornJsonLineTail(filePath: string): Promise<void> {
  const parentDirectory = path.dirname(filePath);
  await ensurePrivateStateDirectory(parentDirectory);
  let handle: FileHandle | null = null;
  try {
    const existing = await fs.lstat(filePath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw stateMutationError("STATE_JSONL_PATH_INVALID", "JSONL state must be a regular file.");
    }
  } catch (error: unknown) {
    const code = error && typeof error === "object" ? String((error as { code?: unknown }).code || "") : "";
    if (code === "ENOENT") return;
    throw error;
  }
  const flags = fsNative.constants.O_RDWR |
    (fsNative.constants.O_NOFOLLOW || 0);
  try {
    handle = await fs.open(filePath, flags, PRIVATE_FILE_MODE);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw stateMutationError("STATE_JSONL_PATH_INVALID", "JSONL state must be a regular file.");
    }
    await truncateTornTailFromHandle(handle);
    await syncStateDirectory(parentDirectory);
  } finally {
    await handle?.close().catch((): void => {});
  }
}

async function truncateTornTailFromHandle(handle: FileHandle): Promise<void> {
  const stat = await handle.stat();
  if (!stat.isFile()) {
    throw stateMutationError("STATE_JSONL_PATH_INVALID", "JSONL state must be a regular file.");
  }
  let cursor = Number(stat.size || 0);
  if (cursor === 0) return;
  const chunk = Buffer.allocUnsafe(64 * 1024);
  while (cursor > 0) {
    const start = Math.max(0, cursor - chunk.length);
    const length = cursor - start;
    const { bytesRead } = await handle.read(chunk, 0, length, start);
    for (let index = bytesRead - 1; index >= 0; index -= 1) {
      if (chunk[index] !== 0x0a) continue;
      const durableBoundary = start + index + 1;
      if (durableBoundary < Number(stat.size)) {
        await handle.truncate(durableBoundary);
        await handle.sync();
      }
      return;
    }
    cursor = start;
  }
  await handle.truncate(0);
  await handle.sync();
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  const parentDirectory = path.dirname(filePath);
  await ensurePrivateStateDirectory(parentDirectory);
  try {
    const existing = await fs.lstat(filePath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw stateMutationError("STATE_JSONL_PATH_INVALID", "JSONL state must be a regular file.");
    }
  } catch (error: unknown) {
    const code = error && typeof error === "object" ? String((error as { code?: unknown }).code || "") : "";
    if (code !== "ENOENT") throw error;
  }
  const flags = fsNative.constants.O_APPEND |
    fsNative.constants.O_CREAT |
    fsNative.constants.O_RDWR |
    (fsNative.constants.O_NOFOLLOW || 0);
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, flags, PRIVATE_FILE_MODE);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw stateMutationError("STATE_JSONL_PATH_INVALID", "JSONL state must be a regular file.");
    }
    try {
      await handle.chmod(PRIVATE_FILE_MODE);
    } catch (error: unknown) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
    await truncateTornTailFromHandle(handle);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await syncStateDirectory(parentDirectory);
  } finally {
    await handle?.close().catch((): void => {});
  }
}

export async function appendJsonLineSerialized(filePath: string, value: unknown): Promise<void> {
  return queueStateMutation(stateFileKey(filePath), (): Promise<void> => appendJsonLine(filePath, value));
}

export function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (!map || typeof map.set !== "function") {
    return;
  }
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  const safeMax = Math.max(1, Number(maxEntries || 1));
  while (map.size > safeMax) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}
