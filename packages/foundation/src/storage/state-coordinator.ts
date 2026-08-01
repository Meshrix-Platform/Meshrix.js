import crypto from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getRuntimeLogger,
  summarizeError
} from "../observability/runtime-logger.ts";

let defaultStateMutationDispatcher: any = null;
export const STATE_MUTATION_TIMEOUT_MS: any = 60_000;
export const STATE_MUTATION_POLICY: Readonly<Record<string, any>> = Object.freeze({
  maxQueuedPerLane: 256,
  maxQueuedGlobal: 4_096,
  maxActiveLanes: 2_048,
  defaultQueueWaitTimeoutMs: 60_000,
  maxQueueWaitTimeoutMs: 300_000,
  defaultExecutionTimeoutMs: STATE_MUTATION_TIMEOUT_MS,
  maxExecutionTimeoutMs: 300_000,
  maxKeyBytes: 4_096
});
const PRIVATE_DIRECTORY_MODE: any = 0o700;
const PRIVATE_FILE_MODE: any = 0o600;
const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES: any = new Set<any>(["EACCES", "EINVAL", "ENOTSUP", "EPERM"]);

function stateMutationError(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  return error;
}

function timeoutError() : any {
  return stateMutationError(
    "STATE_MUTATION_TIMEOUT",
    "State mutation timed out before it reached a safe terminal state."
  );
}

function fencedError() : any {
  return stateMutationError(
    "STATE_MUTATION_QUEUE_FENCED",
    "State mutation queue is fenced by an indeterminate earlier mutation."
  );
}

function schedulerError(code?: any, message?: any) : any {
  return stateMutationError(code, message);
}

function queueAbortedError() : any {
  return schedulerError(
    "STATE_MUTATION_QUEUE_ABORTED",
    "State mutation was cancelled before execution."
  );
}

function activeAbortedError() : any {
  return schedulerError(
    "STATE_MUTATION_ABORTED",
    "State mutation was cancelled while executing."
  );
}

function normalizeKey(key?: any) : any {
  return String(key || "default");
}

function positiveIntegerAtMost(value?: any, fallback?: any, maximum?: any) : any {
  const numeric: any = Number(value);
  return Number.isFinite(numeric) && numeric >= 1
    ? Math.min(Math.floor(numeric), maximum)
    : fallback;
}

function lowerPolicyLimit(value?: any, hardLimit?: any) : any {
  return positiveIntegerAtMost(value, hardLimit, hardLimit);
}

function normalizeStateMutationPolicy(input: Record<string, any> = {}) : any {
  const maxQueueWaitTimeoutMs: any = lowerPolicyLimit(
    input.maxQueueWaitTimeoutMs,
    STATE_MUTATION_POLICY.maxQueueWaitTimeoutMs
  );
  const maxExecutionTimeoutMs: any = lowerPolicyLimit(
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

function createDeferred() : any {
  let resolve: any;
  let reject: any;
  let settled: any = false;
  const promise: any = new Promise((resolvePromise?: any, rejectPromise?: any) : any => {
    resolve = (value?: any) : any => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    reject = (error?: any) : any => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
  });
  promise.catch(() : any => undefined);
  return Object.freeze({ promise, resolve, reject });
}

export class BoundedMutationDeque {
  capacity: any;
  free: any;
  head: any;
  next: any;
  onOperation: any;
  operationCounts: any;
  previous: any;
  size: any;
  tail: any;
  values: any;
  constructor(capacity?: any, { onOperation = null }: Record<string, any> = {}) {
    const normalizedCapacity: any = Number(capacity);
    if (!Number.isSafeInteger(normalizedCapacity) || normalizedCapacity < 1) {
      throw new TypeError("BoundedMutationDeque capacity must be a positive safe integer.");
    }
    this.capacity = normalizedCapacity;
    this.size = 0;
    this.head = -1;
    this.tail = -1;
    this.values = new Array(normalizedCapacity);
    this.next = new Int32Array(normalizedCapacity);
    this.previous = new Int32Array(normalizedCapacity);
    this.next.fill(-1);
    this.previous.fill(-1);
    this.free = new Array(normalizedCapacity);
    for (let index: any = 0; index < normalizedCapacity; index += 1) {
      this.free[index] = normalizedCapacity - index - 1;
    }
    this.onOperation = typeof onOperation === "function" ? onOperation : null;
    this.operationCounts = { enqueue: 0, dequeue: 0, remove: 0 };
  }

  #record(operation?: any) : any {
    this.operationCounts[operation] += 1;
    this.onOperation?.(Object.freeze({
      operation,
      steps: 1,
      size: this.size,
      capacity: this.capacity
    }));
  }

  #unlink(slot?: any) : any {
    const previous: any = this.previous[slot];
    const next: any = this.next[slot];
    if (previous === -1) this.head = next;
    else this.next[previous] = next;
    if (next === -1) this.tail = previous;
    else this.previous[next] = previous;
    const value: any = this.values[slot];
    this.values[slot] = undefined;
    this.next[slot] = -1;
    this.previous[slot] = -1;
    this.free.push(slot);
    this.size -= 1;
    return value;
  }

  enqueue(value?: any) : any {
    this.#record("enqueue");
    if (this.size >= this.capacity) return -1;
    const slot: any = this.free.pop();
    this.values[slot] = value;
    this.previous[slot] = this.tail;
    this.next[slot] = -1;
    if (this.tail === -1) this.head = slot;
    else this.next[this.tail] = slot;
    this.tail = slot;
    this.size += 1;
    return slot;
  }

  dequeue() : any {
    this.#record("dequeue");
    if (this.head === -1) return undefined;
    return this.#unlink(this.head);
  }

  remove(slot?: any) : any {
    this.#record("remove");
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= this.capacity) return undefined;
    if (this.values[slot] === undefined) return undefined;
    return this.#unlink(slot);
  }

  snapshot() : any {
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
}: Record<string, any> = {}) : any {
  const policy: any = normalizeStateMutationPolicy(policyInput);
  const lanes: any = new Map<any, any>();
  const reasonCounts: any = Object.create(null);
  const resolveLogger: any = typeof loggerProvider === "function"
    ? loggerProvider
    : () : any => loggerProvider || null;
  let queuedCount: any = 0;

  function noteReason(code?: any) : any {
    if (!code) return;
    reasonCounts[code] = Number(reasonCounts[code] || 0) + 1;
  }

  function rejectWith(logger?: any, event?: any, error?: any, fields: Record<string, any> = {}) : any {
    noteReason(error.code);
    logger?.error?.(event, {
      ...fields,
      reasonCode: error.code,
      error: summarizeError(error)
    });
    return Promise.reject(error);
  }

  function releaseQueuedEntry(entry?: any) : any {
    if (!entry.queuedCreditHeld) return;
    entry.queuedCreditHeld = false;
    queuedCount -= 1;
    if (entry.queueWaitTimer) clearTimeout(entry.queueWaitTimer);
    entry.queueWaitTimer = null;
    entry.detachQueuedAbort?.();
    entry.detachQueuedAbort = null;
  }

  function settleLaneIfIdle(key?: any, lane?: any) : any {
    if (lane.active || lane.poison || lane.queue.size > 0) return false;
    if (lanes.get(key) === lane) lanes.delete(key);
    lane.idle.resolve();
    return true;
  }

  function rejectQueuedMutations(key?: any, lane?: any) : any {
    let entry: any;
    while ((entry = lane.queue.dequeue()) !== undefined) {
      entry.slot = -1;
      releaseQueuedEntry(entry);
      const error: any = fencedError();
      noteReason(error.code);
      entry.reject(error);
    }
    settleLaneIfIdle(key, lane);
  }

  function startNextMutation(key?: any, lane?: any) : any {
    if (lane.active || lane.poison) return;
    const entry: any = lane.queue.dequeue();
    if (!entry) {
      settleLaneIfIdle(key, lane);
      return;
    }
    entry.slot = -1;
    releaseQueuedEntry(entry);
    if (entry.signal?.aborted) {
      const error: any = queueAbortedError();
      noteReason(error.code);
      entry.reject(error);
      startNextMutation(key, lane);
      return;
    }

    lane.active = entry;
    const logger: any = entry.logger;
    const startedAt: any = Date.now();
    const abortController: any = new AbortController();
    let terminalError: any = null;
    let executionTimer: any = null;
    let detachActiveAbort: any = null;

    logger?.debug?.("state.queue.started", {
      waitedMs: startedAt - entry.queuedAt,
      queuedCount,
      laneCount: lanes.size
    });

    const context: Readonly<Record<string, any>> = Object.freeze({
      signal: abortController.signal,
      assertActive() : any {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason || fencedError();
        }
      }
    });

    const fenceActiveEntry: any = (error?: any, event?: any) : any => {
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

    executionTimer = setTimeout(() : any => {
      fenceActiveEntry(timeoutError(), "state.queue.timed_out");
    }, entry.timeoutMs);
    executionTimer.unref?.();

    if (entry.signal) {
      const abortActive: any = () : any => {
        fenceActiveEntry(activeAbortedError(), "state.queue.aborted");
      };
      entry.signal.addEventListener("abort", abortActive, { once: true });
      detachActiveAbort = () : any => entry.signal.removeEventListener("abort", abortActive);
      if (entry.signal.aborted) abortActive();
    }

    Promise.resolve()
      .then(() : any => entry.task(context))
      .then((result?: any) : any => {
        if (terminalError) return;
        logger?.debug?.("state.queue.completed", {
          waitedMs: startedAt - entry.queuedAt,
          durationMs: Date.now() - startedAt
        });
        entry.resolve(result);
      }, (error?: any) : any => {
        if (terminalError) return;
        logger?.error?.("state.queue.failed", {
          waitedMs: startedAt - entry.queuedAt,
          durationMs: Date.now() - startedAt,
          error: summarizeError(error)
        });
        entry.reject(error);
      })
      .finally(() : any => {
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

  function queueStateMutation(key?: any, task?: any, options: Record<string, any> = {}) : any {
    if (typeof task !== "function") {
      throw new TypeError("queueStateMutation requires a task function.");
    }
    const normalizedKey: any = normalizeKey(key);
    const logger: any = options.logger || resolveLogger();
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

    let lane: any = lanes.get(normalizedKey);
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

    let createdLane: any = false;
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

    const queuedAt: any = Date.now();
    const timeoutMs: any = positiveIntegerAtMost(
      options.timeoutMs,
      policy.defaultExecutionTimeoutMs,
      policy.maxExecutionTimeoutMs
    );
    const queueWaitTimeoutMs: any = positiveIntegerAtMost(
      options.queueWaitTimeoutMs,
      policy.defaultQueueWaitTimeoutMs,
      policy.maxQueueWaitTimeoutMs
    );

    queuedCount += 1;
    let entry: any;
    const operation: any = new Promise((resolve?: any, reject?: any) : any => {
      entry = {
        task,
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

    entry.slot = lane.queue.enqueue(entry);
    if (entry.slot < 0) {
      releaseQueuedEntry(entry);
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

    const cancelQueued: any = (error?: any, event?: any) : any => {
      if (entry.slot < 0) return false;
      const removed: any = lane.queue.remove(entry.slot);
      if (!removed) return false;
      entry.slot = -1;
      releaseQueuedEntry(entry);
      noteReason(error.code);
      entry.reject(error);
      logger?.error?.(event, {
        queuedCount,
        laneCount: lanes.size,
        reasonCode: error.code,
        error: summarizeError(error)
      });
      settleLaneIfIdle(normalizedKey, lane);
      return true;
    };

    entry.queueWaitTimer = setTimeout(() : any => {
      cancelQueued(
        schedulerError(
          "STATE_MUTATION_QUEUE_WAIT_TIMEOUT",
          "State mutation exceeded its queue wait deadline."
        ),
        "state.queue.wait_timed_out"
      );
    }, queueWaitTimeoutMs);
    entry.queueWaitTimer.unref?.();

    if (entry.signal) {
      const abortQueued: any = () : any => cancelQueued(queueAbortedError(), "state.queue.queue_aborted");
      entry.signal.addEventListener("abort", abortQueued, { once: true });
      entry.detachQueuedAbort = () : any => entry.signal.removeEventListener("abort", abortQueued);
    }

    logger?.debug?.("state.queue.enqueued", {
      queueDepthBefore: lane.queue.size - 1 + (lane.active ? 1 : 0),
      queuedCount,
      laneCount: lanes.size
    });
    startNextMutation(normalizedKey, lane);
    return operation;
  }

  function waitForStateIdle(key?: any) : any {
    const normalizedKey: any = normalizeKey(key);
    if (Buffer.byteLength(normalizedKey, "utf8") > policy.maxKeyBytes) {
      return Promise.reject(
        schedulerError("STATE_MUTATION_KEY_TOO_LARGE", "State mutation key exceeds its byte limit.")
      );
    }
    const lane: any = lanes.get(normalizedKey);
    if (!lane) return Promise.resolve();
    if (lane.poison) return Promise.reject(fencedError());
    return lane.idle.promise;
  }

  function snapshot() : any {
    let activeCount: any = 0;
    let fencedCount: any = 0;
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

const defaultStateMutationCoordinator: any = createStateMutationCoordinator();

export function queueStateMutation(key?: any, task?: any, options: Record<string, any> = {}) : any {
  return defaultStateMutationCoordinator.queueStateMutation(key, task, options);
}

export function stateMutationSchedulerSnapshot() : any {
  return defaultStateMutationCoordinator.snapshot();
}

export function createStateMutationDispatcher({ logger = null, coordinator = null }: Record<string, any> = {}) : any {
  const currentLogger: any = () : any => logger || getRuntimeLogger();
  const mutationCoordinator: any = coordinator || defaultStateMutationCoordinator;

  async function mutate({
    key = "default",
    kind = "state.mutation",
    task,
    signal = null,
    queueWaitTimeoutMs,
    timeoutMs
  }: Record<string, any> = {}) : Promise<any> {
    if (typeof task !== "function") {
      throw new TypeError("StateMutationDispatcher.mutate requires a task function.");
    }
    const normalizedKey: any = normalizeKey(key);
    currentLogger()?.debug?.("state.dispatch.enqueued", {
      mutationKind: kind
    });
    return mutationCoordinator.queueStateMutation(normalizedKey, async (mutationContext?: any) : Promise<any> => {
      const startedAt: any = Date.now();
      currentLogger()?.debug?.("state.dispatch.started", {
        mutationKind: kind
      });
      try {
        const result: any = await task(mutationContext);
        currentLogger()?.debug?.("state.dispatch.completed", {
          mutationKind: kind,
          durationMs: Date.now() - startedAt
        });
        return result;
      } catch (error: any) {
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
    async writeJson(filePath?: any, value?: any, options: Record<string, any> = {}) : Promise<any> {
      return mutate({
        key: stateFileKey(filePath),
        kind: options.kind || "state.file.write_json",
        task: () : any => atomicWriteJson(filePath, value, options)
      });
    },
    async appendJsonLine(filePath?: any, value?: any, options: Record<string, any> = {}) : Promise<any> {
      return mutate({
        key: stateFileKey(filePath),
        kind: options.kind || "state.file.append_jsonl",
        task: () : any => appendJsonLine(filePath, value)
      });
    }
  };
}

export function getStateMutationDispatcher() : any {
  if (!defaultStateMutationDispatcher) {
    defaultStateMutationDispatcher = createStateMutationDispatcher();
  }
  return defaultStateMutationDispatcher;
}

export function mutateState(input: Record<string, any> = {}) : any {
  return getStateMutationDispatcher().mutate(input);
}

export function waitForStateIdle(key?: any) : any {
  return defaultStateMutationCoordinator.waitForStateIdle(key);
}

export function stateFileKey(filePath?: any) : any {
  return `file:${path.resolve(filePath)}`;
}

function normalizeAtomicWriteOptions(options: any = "utf8") : any {
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

function isUnsupportedDirectorySync(error?: any) : any {
  return process.platform === "win32" && WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code);
}

async function ensurePrivateStateDirectory(directoryPath?: any) : Promise<any> {
  const missingDirectories: any[] = [];
  let current: any = path.resolve(directoryPath);
  while (true) {
    try {
      const stat: any = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw stateMutationError(
          "STATE_DIRECTORY_PATH_INVALID",
          "State directory ancestry must contain only real directories."
        );
      }
      break;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      missingDirectories.push(current);
      const parent: any = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  await fs.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  try {
    await fs.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
  } catch (error: any) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  }
  for (const createdDirectory of missingDirectories.reverse()) {
    await syncStateDirectory(path.dirname(createdDirectory));
  }
}

async function syncStateDirectory(directoryPath?: any) : Promise<any> {
  let handle: any = null;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch (error: any) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}

async function directoryExists(directoryPath?: any) : Promise<any> {
  try {
    const stat: any = await fs.stat(directoryPath);
    return stat.isDirectory();
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function atomicWriteFile(filePath?: any, data?: any, options: any = "utf8") : Promise<any> {
  const parentDirectory: any = path.dirname(filePath);
  const { writeOptions, ignoreMissingParent, onTempFileReady } = normalizeAtomicWriteOptions(options);
  await ensurePrivateStateDirectory(parentDirectory);
  const tempPath: any = path.join(
    parentDirectory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`
  );
  let handle: any = null;
  try {
    handle = await fs.open(tempPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(data, writeOptions);
    await handle.sync();
    await handle.close();
    handle = null;
    if (onTempFileReady) {
      await onTempFileReady({ filePath, tempPath, parentDirectory });
    }
    await fs.rename(tempPath, filePath);
    try {
      await fs.chmod(filePath, PRIVATE_FILE_MODE);
    } catch (error: any) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
    await syncStateDirectory(parentDirectory);
    return true;
  } catch (error: any) {
    await handle?.close().catch(() : any => null);
    await fs.rm(tempPath, { force: true }).catch(() : any => null);
    if (ignoreMissingParent && error?.code === "ENOENT" && !(await directoryExists(parentDirectory))) {
      return false;
    }
    throw error;
  }
}

export async function atomicWriteJson(filePath?: any, value?: any, { trailingNewline = true, ignoreMissingParent = false }: Record<string, any> = {}) : Promise<any> {
  const payload: any = `${JSON.stringify(value, null, 2)}${trailingNewline ? "\n" : ""}`;
  return atomicWriteFile(filePath, payload, { encoding: "utf8", ignoreMissingParent });
}

export async function atomicWriteJsonThroughState(filePath?: any, value?: any, options: Record<string, any> = {}) : Promise<any> {
  return getStateMutationDispatcher().writeJson(filePath, value, options);
}

export async function readJsonFile(filePath?: any, fallback: any = undefined) : Promise<any> {
  try {
    const content: any = await fs.readFile(filePath, "utf8");
    if (!content.trim()) {
      return fallback;
    }
    return JSON.parse(content);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function truncateTornJsonLineTail(handle?: any) : Promise<any> {
  const stat: any = await handle.stat();
  if (!stat.isFile()) {
    throw stateMutationError("STATE_JSONL_PATH_INVALID", "JSONL state must be a regular file.");
  }
  let cursor: any = Number(stat.size || 0);
  if (cursor === 0) return;
  const chunk: any = Buffer.allocUnsafe(64 * 1024);
  while (cursor > 0) {
    const start: any = Math.max(0, cursor - chunk.length);
    const length: any = cursor - start;
    const { bytesRead } = await handle.read(chunk, 0, length, start);
    for (let index: any = bytesRead - 1; index >= 0; index -= 1) {
      if (chunk[index] !== 0x0a) continue;
      const durableBoundary: any = start + index + 1;
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

export async function appendJsonLine(filePath?: any, value?: any) : Promise<any> {
  const parentDirectory: any = path.dirname(filePath);
  await ensurePrivateStateDirectory(parentDirectory);
  try {
    const existing: any = await fs.lstat(filePath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw stateMutationError("STATE_JSONL_PATH_INVALID", "JSONL state must be a regular file.");
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const flags: any = fsNative.constants.O_APPEND |
    fsNative.constants.O_CREAT |
    fsNative.constants.O_RDWR |
    (fsNative.constants.O_NOFOLLOW || 0);
  let handle: any = null;
  try {
    handle = await fs.open(filePath, flags, PRIVATE_FILE_MODE);
    const stat: any = await handle.stat();
    if (!stat.isFile()) {
      throw stateMutationError("STATE_JSONL_PATH_INVALID", "JSONL state must be a regular file.");
    }
    try {
      await handle.chmod(PRIVATE_FILE_MODE);
    } catch (error: any) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
    await truncateTornJsonLineTail(handle);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await syncStateDirectory(parentDirectory);
  } finally {
    await handle?.close().catch(() : any => null);
  }
}

export async function appendJsonLineSerialized(filePath?: any, value?: any) : Promise<any> {
  return queueStateMutation(stateFileKey(filePath), () : any => appendJsonLine(filePath, value));
}

export function setBoundedMapEntry(map?: any, key?: any, value?: any, maxEntries?: any) : any {
  if (!map || typeof map.set !== "function") {
    return;
  }
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  const safeMax: any = Math.max(1, Number(maxEntries || 1));
  while (map.size > safeMax) {
    const oldestKey: any = map.keys().next().value;
    map.delete(oldestKey);
  }
}
