import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendJsonLine,
  appendJsonLineSerialized,
  atomicWriteFile,
  BoundedMutationDeque,
  createStateMutationCoordinator,
  createStateMutationDispatcher,
  queueStateMutation,
  stateMutationSchedulerSnapshot,
  STATE_MUTATION_POLICY,
  readJsonFile,
  setBoundedMapEntry,
  stateFileKey,
  waitForStateIdle
} from "#meshrix/state-coordinator";
import {
  appendBoundedJsonLine,
  readJsonlTail
} from "#meshrix/foundation/storage/bounded-jsonl";

const tempRoots = [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function tempDir(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("state coordinator behavior", () => {
  it("uses fixed backing slots and constant operation steps for enqueue, dequeue, and cancellation", () => {
    for (const depth of [1, 32, 64]) {
      const operations = [];
      const deque = new BoundedMutationDeque(64, {
        onOperation: (operation) => operations.push(operation)
      });
      const tokens = [];
      for (let index = 0; index < depth; index += 1) {
        tokens.push(deque.enqueue(index));
      }
      const removedIndex = depth > 2 ? Math.floor(depth / 2) : -1;
      if (removedIndex >= 0) {
        expect(deque.remove(tokens[removedIndex])).toBe(removedIndex);
      }
      const observed = [];
      while (deque.size > 0) observed.push(deque.dequeue());
      const expected = Array.from({ length: depth }, (_, index) => index)
        .filter((index) => index !== removedIndex);
      expect(observed).toEqual(expected);
      expect(deque.snapshot()).toMatchObject({
        capacity: 64,
        size: 0,
        backingSlots: 64
      });
      expect(operations.every((operation) => operation.steps === 1)).toBe(true);
    }

    const full = new BoundedMutationDeque(2);
    expect(full.enqueue("first")).toBeGreaterThanOrEqual(0);
    expect(full.enqueue("second")).toBeGreaterThanOrEqual(0);
    expect(full.enqueue("overflow")).toBe(-1);
  });

  it("enforces lane, global, and active-lane credits without counting active work as queued", async () => {
    const laneGate = deferred();
    const laneCoordinator = createStateMutationCoordinator({
      policy: { maxQueuedPerLane: 1, maxQueuedGlobal: 4, maxActiveLanes: 4 }
    });
    const laneActive = laneCoordinator.queueStateMutation("lane", () => laneGate.promise);
    await Promise.resolve();
    const laneQueued = laneCoordinator.queueStateMutation("lane", async () => "queued");
    const rejectedLaneTask = vi.fn();
    expect(laneCoordinator.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 1 });
    await expect(laneCoordinator.queueStateMutation("lane", rejectedLaneTask))
      .rejects.toMatchObject({ code: "STATE_MUTATION_LANE_CAPACITY_EXCEEDED" });
    expect(rejectedLaneTask).not.toHaveBeenCalled();
    laneGate.resolve("active");
    await expect(laneActive).resolves.toBe("active");
    await expect(laneQueued).resolves.toBe("queued");

    const globalCoordinator = createStateMutationCoordinator({
      policy: { maxQueuedPerLane: 4, maxQueuedGlobal: 1, maxActiveLanes: 4 }
    });
    const firstGate = deferred();
    const secondGate = deferred();
    const firstActive = globalCoordinator.queueStateMutation("first", () => firstGate.promise);
    const secondActive = globalCoordinator.queueStateMutation("second", () => secondGate.promise);
    await Promise.resolve();
    expect(globalCoordinator.snapshot()).toMatchObject({ activeCount: 2, queuedCount: 0 });
    const firstQueued = globalCoordinator.queueStateMutation("first", async () => "first-queued");
    await expect(globalCoordinator.queueStateMutation("second", async () => "overflow"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_GLOBAL_CAPACITY_EXCEEDED" });
    firstGate.resolve("first-active");
    secondGate.resolve("second-active");
    await Promise.all([firstActive, secondActive, firstQueued]);

    const laneLimitCoordinator = createStateMutationCoordinator({
      policy: { maxActiveLanes: 1 }
    });
    const activeLaneGate = deferred();
    const activeLane = laneLimitCoordinator.queueStateMutation("one", () => activeLaneGate.promise);
    await Promise.resolve();
    await expect(laneLimitCoordinator.queueStateMutation("two", async () => "blocked"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_LANE_LIMIT_EXCEEDED" });
    activeLaneGate.resolve("done");
    await activeLane;
    await laneLimitCoordinator.waitForStateIdle("one");
    await expect(laneLimitCoordinator.queueStateMutation("two", async () => "recovered"))
      .resolves.toBe("recovered");
  });

  it("releases queued credits exactly once after queue timeout and repeated abort", async () => {
    vi.useFakeTimers();
    const coordinator = createStateMutationCoordinator({
      policy: {
        maxQueuedPerLane: 1,
        maxQueuedGlobal: 1,
        defaultQueueWaitTimeoutMs: 10,
        maxQueueWaitTimeoutMs: 20,
        defaultExecutionTimeoutMs: 1_000,
        maxExecutionTimeoutMs: 1_000
      }
    });
    const gate = deferred();
    const active = coordinator.queueStateMutation("timeout", () => gate.promise);
    await Promise.resolve();
    const timedOutTask = vi.fn();
    const timedOut = coordinator.queueStateMutation("timeout", timedOutTask);
    const timedOutAssertion = expect(timedOut)
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_WAIT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10);
    await timedOutAssertion;
    expect(timedOutTask).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 0 });

    const abortController = new AbortController();
    const abortedTask = vi.fn();
    const aborted = coordinator.queueStateMutation("timeout", abortedTask, {
      signal: abortController.signal
    });
    abortController.abort();
    abortController.abort();
    await expect(aborted).rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_ABORTED" });
    expect(abortedTask).not.toHaveBeenCalled();

    const replacement = coordinator.queueStateMutation("timeout", async () => "replacement");
    await expect(coordinator.queueStateMutation("timeout", async () => "overflow"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_LANE_CAPACITY_EXCEEDED" });
    gate.resolve("active");
    await expect(active).resolves.toBe("active");
    await expect(replacement).resolves.toBe("replacement");
  });

  it("separates default and maximum queue-wait and execution timeout bounds", async () => {
    vi.useFakeTimers();
    const coordinator = createStateMutationCoordinator({
      policy: {
        defaultQueueWaitTimeoutMs: 10,
        maxQueueWaitTimeoutMs: 15,
        defaultExecutionTimeoutMs: 20,
        maxExecutionTimeoutMs: 30
      }
    });
    const firstGate = deferred();
    const first = coordinator.queueStateMutation("bounded-timeouts", async ({ signal }) => {
      await firstGate.promise;
      expect(signal.aborted).toBe(true);
    }, { timeoutMs: 1_000 });
    const firstAssertion = expect(first).rejects.toMatchObject({ code: "STATE_MUTATION_TIMEOUT" });
    await Promise.resolve();
    const queued = coordinator.queueStateMutation("bounded-timeouts", async () => "never", {
      queueWaitTimeoutMs: 1_000
    });
    const queuedAssertion = expect(queued)
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_WAIT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(14);
    expect(coordinator.snapshot().queuedCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await queuedAssertion;
    await vi.advanceTimersByTimeAsync(15);
    await firstAssertion;
    firstGate.resolve();
    await vi.advanceTimersByTimeAsync(0);

    const defaultGate = deferred();
    const defaultActive = coordinator.queueStateMutation("default-timeouts", () => defaultGate.promise);
    const defaultAssertion = expect(defaultActive)
      .rejects.toMatchObject({ code: "STATE_MUTATION_TIMEOUT" });
    await Promise.resolve();
    const defaultQueued = coordinator.queueStateMutation("default-timeouts", async () => "never");
    const defaultQueuedAssertion = expect(defaultQueued)
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_WAIT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10);
    await defaultQueuedAssertion;
    await vi.advanceTimersByTimeAsync(10);
    await defaultAssertion;
    defaultGate.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("keeps FIFO lanes isolated and shares one idle deferred while recovering from failure", async () => {
    const coordinator = createStateMutationCoordinator({
      policy: { maxQueuedPerLane: 4, maxQueuedGlobal: 8, maxActiveLanes: 4 }
    });
    const gate = deferred();
    const events = [];
    const first = coordinator.queueStateMutation("same", async () => {
      events.push("first-start");
      await gate.promise;
      events.push("first-end");
      return "first";
    });
    const second = coordinator.queueStateMutation("same", async () => {
      events.push("second");
      throw new Error("synthetic failure");
    });
    const secondOutcome = second.catch((error) => error);
    const third = coordinator.queueStateMutation("same", async () => {
      events.push("third");
      return "third";
    });
    const idleOne = coordinator.waitForStateIdle("same");
    const idleTwo = coordinator.waitForStateIdle("same");
    expect(idleOne).toBe(idleTwo);
    await expect(coordinator.queueStateMutation("other", async () => {
      events.push("other");
      return "other";
    })).resolves.toBe("other");
    expect(events).toEqual(["first-start", "other"]);
    gate.resolve();
    await expect(first).resolves.toBe("first");
    await expect(secondOutcome).resolves.toMatchObject({ message: "synthetic failure" });
    await expect(third).resolves.toBe("third");
    await Promise.all([idleOne, idleTwo]);
    expect(events).toEqual(["first-start", "other", "first-end", "second", "third"]);
    expect(coordinator.snapshot()).toMatchObject({ laneCount: 0, activeCount: 0, queuedCount: 0 });
  });

  it("fences an actively aborted task until it actually settles", async () => {
    const coordinator = createStateMutationCoordinator();
    const controller = new AbortController();
    const gate = deferred();
    const taskSettled = deferred();
    const active = coordinator.queueStateMutation("active-abort", async ({ signal }) => {
      await gate.promise;
      expect(signal.aborted).toBe(true);
      taskSettled.resolve();
    }, { signal: controller.signal });
    await Promise.resolve();
    const queued = coordinator.queueStateMutation("active-abort", async () => "never");
    const queuedAssertion = expect(queued)
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_FENCED" });
    controller.abort();
    await expect(active).rejects.toMatchObject({ code: "STATE_MUTATION_ABORTED" });
    await queuedAssertion;
    await expect(coordinator.waitForStateIdle("active-abort"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_FENCED" });
    await expect(coordinator.queueStateMutation("active-abort", async () => "blocked"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_FENCED" });
    gate.resolve();
    await taskSettled.promise;
    await new Promise((resolve) => setImmediate(resolve));
    await expect(coordinator.queueStateMutation("active-abort", async () => "recovered"))
      .resolves.toBe("recovered");
  });

  it("shares the default authority across entrypoints and exposes privacy-safe aggregate state", async () => {
    const secretKey = "synthetic-secret-state-key";
    const gate = deferred();
    const events = [];
    const direct = queueStateMutation(secretKey, async () => {
      events.push("direct-start");
      await gate.promise;
      events.push("direct-end");
    });
    await Promise.resolve();
    const dispatcher = createStateMutationDispatcher();
    const dispatched = dispatcher.mutate({
      key: secretKey,
      metadata: { filePath: "/synthetic/private/path" },
      task: async () => events.push("dispatcher")
    });
    await Promise.resolve();
    expect(events).toEqual(["direct-start"]);
    expect(JSON.stringify(stateMutationSchedulerSnapshot())).not.toContain(secretKey);
    gate.resolve();
    await Promise.all([direct, dispatched]);
    expect(events).toEqual(["direct-start", "direct-end", "dispatcher"]);
  });

  it("rejects oversized and pre-aborted keys before lane creation without logging identifiers", async () => {
    const logger = { debug: vi.fn(), error: vi.fn() };
    const coordinator = createStateMutationCoordinator({
      policy: { maxKeyBytes: 8 },
      loggerProvider: () => logger
    });
    const oversized = "private-key-material";
    const oversizedError = await coordinator.queueStateMutation(oversized, async () => "never")
      .catch((error) => error);
    expect(oversizedError).toMatchObject({ code: "STATE_MUTATION_KEY_TOO_LARGE" });
    expect(oversizedError.message).not.toContain(oversized);
    expect(coordinator.snapshot()).toMatchObject({ laneCount: 0, queuedCount: 0 });

    const controller = new AbortController();
    controller.abort();
    await expect(coordinator.queueStateMutation("short", async () => "never", {
      signal: controller.signal
    })).rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_ABORTED" });
    const privateLogger = { debug: vi.fn(), error: vi.fn() };
    const privateCoordinator = createStateMutationCoordinator({
      policy: {
        maxKeyBytes: 64,
        maxQueuedPerLane: Number.MAX_SAFE_INTEGER,
        maxQueuedGlobal: Number.MAX_SAFE_INTEGER,
        maxActiveLanes: Number.MAX_SAFE_INTEGER
      },
      loggerProvider: () => privateLogger
    });
    await privateCoordinator.queueStateMutation("synthetic-private-lane", async () => "ok");
    const serializedLogs = JSON.stringify([...logger.debug.mock.calls, ...logger.error.mock.calls]);
    expect(serializedLogs).not.toContain(oversized);
    expect(serializedLogs).not.toContain("private-key");
    expect(JSON.stringify([...privateLogger.debug.mock.calls, ...privateLogger.error.mock.calls]))
      .not.toContain("synthetic-private-lane");
    expect(Object.keys(coordinator.snapshot())).toEqual([
      "laneCount",
      "activeCount",
      "fencedCount",
      "queuedCount",
      "capacity",
      "reasonCounts"
    ]);
    expect(coordinator.policy.maxQueuedPerLane).toBeLessThanOrEqual(
      STATE_MUTATION_POLICY.maxQueuedPerLane
    );
    expect(privateCoordinator.policy).toMatchObject({
      maxQueuedPerLane: STATE_MUTATION_POLICY.maxQueuedPerLane,
      maxQueuedGlobal: STATE_MUTATION_POLICY.maxQueuedGlobal,
      maxActiveLanes: STATE_MUTATION_POLICY.maxActiveLanes
    });
  });

  it("fails queued mutations fast while a timed-out task remains the serialization fence", async () => {
    vi.useFakeTimers();
    const events = [];
    let releaseFirst;
    let markFirstSettled;
    const firstTaskSettled = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const firstActuallySettled = new Promise((resolve) => {
      markFirstSettled = resolve;
    });

    const first = queueStateMutation("timeout-fence", async ({ signal }) => {
      events.push("first-start");
      await firstTaskSettled;
      expect(signal.aborted).toBe(true);
      events.push("first-end");
      markFirstSettled();
      return "first";
    });
    const second = queueStateMutation("timeout-fence", async () => {
      events.push("second-start");
      return "second";
    });
    const firstRejected = expect(first).rejects.toMatchObject({ code: "STATE_MUTATION_TIMEOUT" });
    const secondRejected = expect(second).rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_FENCED" });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    await firstRejected;
    await secondRejected;

    await expect(queueStateMutation("timeout-fence", async () => "third"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_FENCED" });
    await expect(waitForStateIdle("timeout-fence"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_FENCED" });
    expect(events).toEqual(["first-start"]);

    releaseFirst();
    await firstActuallySettled;
    await vi.advanceTimersByTimeAsync(0);
    await expect(queueStateMutation("timeout-fence", async () => {
      events.push("fourth-start");
      return "fourth";
    })).resolves.toBe("fourth");
    expect(events).toEqual(["first-start", "first-end", "fourth-start"]);
  });

  it("rejects invalid mutation tasks and logs dispatcher failures", async () => {
    expect(() => queueStateMutation("invalid", null)).toThrow(
      "queueStateMutation requires a task function."
    );

    const logger = {
      debug: vi.fn(),
      error: vi.fn()
    };
    const dispatcher = createStateMutationDispatcher({ logger });

    await expect(dispatcher.mutate({
      key: "bad-dispatch",
      task: null
    })).rejects.toThrow("StateMutationDispatcher.mutate requires a task function.");

    await expect(dispatcher.mutate({
      key: "throwing-dispatch",
      kind: "state.test.throw",
      metadata: { source: "unit" },
      task: async () => {
        throw new Error("planned mutation failure");
      }
    })).rejects.toThrow("planned mutation failure");

    expect(logger.error).toHaveBeenCalledWith(
      "state.dispatch.failed",
      expect.objectContaining({
        mutationKind: "state.test.throw"
      })
    );
    await waitForStateIdle("throwing-dispatch");
  });

  it("serializes dispatcher file writes, append helpers, and idle waits", async () => {
    const root = await tempDir("meshrix-state-coordinator-");
    const jsonPath = path.join(root, "nested", "state.json");
    const jsonlPath = path.join(root, "events", "events.jsonl");
    const dispatcher = createStateMutationDispatcher();

    await dispatcher.writeJson(jsonPath, { ok: true }, {
      trailingNewline: false,
      kind: "state.test.write",
      metadata: { file: "state" }
    });
    await dispatcher.appendJsonLine(jsonlPath, { event: 1 }, {
      kind: "state.test.append",
      metadata: { file: "events" }
    });
    await appendJsonLineSerialized(jsonlPath, { event: 2 });
    await waitForStateIdle(stateFileKey(jsonlPath));

    expect(await fs.readFile(jsonPath, "utf8")).toBe(JSON.stringify({ ok: true }, null, 2));
    expect((await fs.readFile(jsonlPath, "utf8")).trim().split("\n")).toEqual([
      JSON.stringify({ event: 1 }),
      JSON.stringify({ event: 2 })
    ]);
  });

  it("cleans temporary atomic writes and handles JSON fallback/error branches", async () => {
    const root = await tempDir("meshrix-state-coordinator-files-");
    const directoryTarget = path.join(root, "directory-target");
    await fs.mkdir(directoryTarget);

    await expect(atomicWriteFile(directoryTarget, "content")).rejects.toThrow();
    const leftovers = await fs.readdir(root);
    expect(leftovers.filter((name) => name.startsWith(".directory-target."))).toEqual([]);

    const emptyPath = path.join(root, "empty.json");
    await fs.writeFile(emptyPath, "   \n");
    await expect(readJsonFile(emptyPath, { fallback: true })).resolves.toEqual({ fallback: true });

    const invalidPath = path.join(root, "invalid.json");
    await fs.writeFile(invalidPath, "{not-json");
    await expect(readJsonFile(invalidPath, {})).rejects.toThrow();
  });

  it("syncs private state bytes before rename and the parent directory after rename", async () => {
    const root = await tempDir("meshrix-state-coordinator-durable-");
    const parentDirectory = path.join(root, "private-state");
    const targetPath = path.join(parentDirectory, "state.json");
    const events = [];
    const originalOpen = fs.open.bind(fs);
    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filePath, ...args) => {
      const handle = await originalOpen(filePath, ...args);
      const resolvedPath = path.resolve(String(filePath));
      const kind = resolvedPath === path.resolve(parentDirectory)
        ? "directory"
        : path.basename(resolvedPath).startsWith(".state.json.")
          ? "temporary-file"
          : "ancestor-directory";
      const originalSync = handle.sync.bind(handle);
      Object.defineProperty(handle, "sync", {
        configurable: true,
        value: async (...syncArgs) => {
          events.push(`${kind}:sync`);
          return originalSync(...syncArgs);
        }
      });
      return handle;
    });
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      events.push("rename");
      return originalRename(...args);
    });

    await atomicWriteFile(targetPath, "durable-state", { encoding: "utf8" });

    expect(events).toEqual([
      "ancestor-directory:sync",
      "temporary-file:sync",
      "rename",
      "directory:sync"
    ]);
    expect((await fs.stat(parentDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(targetPath, "utf8")).toBe("durable-state");
  });

  it("appends private durable JSONL and removes an unterminated torn tail", async () => {
    const root = await tempDir("meshrix-state-coordinator-jsonl-");
    const eventPath = path.join(root, "private-events", "events.jsonl");
    const previousUmask = process.umask(0o022);
    try {
      await appendJsonLineSerialized(eventPath, { sequence: 1 });
      await fs.appendFile(eventPath, '{"sequence":', "utf8");
      await appendJsonLineSerialized(eventPath, { sequence: 2 });
    } finally {
      process.umask(previousUmask);
    }

    expect((await fs.readFile(eventPath, "utf8")).trim().split("\n").map(JSON.parse))
      .toEqual([{ sequence: 1 }, { sequence: 2 }]);
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(eventPath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(eventPath)).mode & 0o777).toBe(0o600);
    }

    const invalidTarget = path.join(root, "invalid-jsonl-target");
    await fs.mkdir(invalidTarget);
    await expect(appendJsonLine(invalidTarget, { sequence: 3 }))
      .rejects.toMatchObject({ code: "STATE_JSONL_PATH_INVALID" });
  });

  it("compacts bounded JSONL and reads only the retained tail", async () => {
    const root = await tempDir("meshrix-bounded-jsonl-");
    const eventPath = path.join(root, "events", "bounded.jsonl");

    for (let sequence = 0; sequence < 30; sequence += 1) {
      await appendBoundedJsonLine(eventPath, {
        sequence,
        detail: "x".repeat(200)
      }, {
        maxBytes: 2048,
        retainedBytes: 1024,
        maxRecordBytes: 512
      });
      expect((await fs.stat(eventPath)).size).toBeLessThanOrEqual(2048);
    }

    const records = await readJsonlTail(eventPath, {
      limit: 3,
      maxScanBytes: 1024,
      reverse: true
    });
    expect(records.map((record) => record.sequence)).toEqual([29, 28, 27]);
    await expect(appendBoundedJsonLine(eventPath, {
      sequence: 31,
      detail: "x".repeat(1000)
    }, {
      maxBytes: 2048,
      maxRecordBytes: 512
    })).rejects.toMatchObject({ code: "BOUNDED_JSONL_RECORD_TOO_LARGE" });
  });

  it("can ignore atomic writes when the target directory is concurrently removed", async () => {
    const root = await tempDir("meshrix-state-coordinator-missing-parent-");
    const parentDirectory = path.join(root, "jobs", "job-1");
    const targetPath = path.join(parentDirectory, "meta.json");

    await expect(atomicWriteFile(targetPath, "{}", {
      encoding: "utf8",
      ignoreMissingParent: true,
      onTempFileReady: async () => {
        await fs.rm(parentDirectory, { recursive: true, force: true });
      }
    })).resolves.toBe(false);

    await expect(fs.stat(parentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(path.join(root, "jobs"))).resolves.toEqual([]);
  });

  it("keeps bounded maps ordered while tolerating invalid map inputs", () => {
    expect(setBoundedMapEntry(null, "x", 1, 1)).toBeUndefined();

    const map = new Map([
      ["first", 1],
      ["second", 2]
    ]);
    setBoundedMapEntry(map, "first", 3, 2);
    expect([...map.entries()]).toEqual([
      ["second", 2],
      ["first", 3]
    ]);

    setBoundedMapEntry(map, "third", 4, 2);
    expect([...map.entries()]).toEqual([
      ["first", 3],
      ["third", 4]
    ]);
  });
});
