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

const tempRoots: any[] = [];

function deferred() : any {
  let resolve: any;
  let reject: any;
  const promise: any = new Promise((resolvePromise?: any, rejectPromise?: any) : any => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function tempDir(prefix?: any) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () : Promise<any> => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("state coordinator behavior", () : any => {
  it("uses fixed backing slots and constant operation steps for enqueue, dequeue, and cancellation", () : any => {
    for (const depth of [1, 32, 64]) {
      const operations: any[] = [];
      const deque: any = new BoundedMutationDeque(64, {
        onOperation: (operation?: any) : any => operations.push(operation)
      });
      const tokens: any[] = [];
      for (let index: any = 0; index < depth; index += 1) {
        tokens.push(deque.enqueue(index));
      }
      const removedIndex: any = depth > 2 ? Math.floor(depth / 2) : -1;
      if (removedIndex >= 0) {
        expect(deque.remove(tokens[removedIndex])).toBe(removedIndex);
      }
      const observed: any[] = [];
      while (deque.size > 0) observed.push(deque.dequeue());
      const expected: any = Array.from({ length: depth }, (_?: any, index?: any) : any => index)
        .filter((index?: any) : any => index !== removedIndex);
      expect(observed).toEqual(expected);
      expect(deque.snapshot()).toMatchObject({
        capacity: 64,
        size: 0,
        backingSlots: 64
      });
      expect(operations.every((operation?: any) : any => operation.steps === 1)).toBe(true);
    }

    const full: any = new BoundedMutationDeque(2);
    expect(full.enqueue("first")).toBeGreaterThanOrEqual(0);
    expect(full.enqueue("second")).toBeGreaterThanOrEqual(0);
    expect(full.enqueue("overflow")).toBe(-1);
  });

  it("enforces lane, global, and active-lane credits without counting active work as queued", async () : Promise<any> => {
    const laneGate: any = deferred();
    const laneCoordinator: any = createStateMutationCoordinator({
      policy: { maxQueuedPerLane: 1, maxQueuedGlobal: 4, maxActiveLanes: 4 }
    });
    const laneActive: any = laneCoordinator.queueStateMutation("lane", () : any => laneGate.promise);
    await Promise.resolve();
    const laneQueued: any = laneCoordinator.queueStateMutation("lane", async () : Promise<any> => "queued");
    const rejectedLaneTask: any = vi.fn();
    expect(laneCoordinator.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 1 });
    await expect(laneCoordinator.queueStateMutation("lane", rejectedLaneTask))
      .rejects.toMatchObject({ code: "STATE_MUTATION_LANE_CAPACITY_EXCEEDED" });
    expect(rejectedLaneTask).not.toHaveBeenCalled();
    laneGate.resolve("active");
    await expect(laneActive).resolves.toBe("active");
    await expect(laneQueued).resolves.toBe("queued");

    const globalCoordinator: any = createStateMutationCoordinator({
      policy: { maxQueuedPerLane: 4, maxQueuedGlobal: 1, maxActiveLanes: 4 }
    });
    const firstGate: any = deferred();
    const secondGate: any = deferred();
    const firstActive: any = globalCoordinator.queueStateMutation("first", () : any => firstGate.promise);
    const secondActive: any = globalCoordinator.queueStateMutation("second", () : any => secondGate.promise);
    await Promise.resolve();
    expect(globalCoordinator.snapshot()).toMatchObject({ activeCount: 2, queuedCount: 0 });
    const firstQueued: any = globalCoordinator.queueStateMutation("first", async () : Promise<any> => "first-queued");
    await expect(globalCoordinator.queueStateMutation("second", async () : Promise<any> => "overflow"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_GLOBAL_CAPACITY_EXCEEDED" });
    firstGate.resolve("first-active");
    secondGate.resolve("second-active");
    await Promise.all([firstActive, secondActive, firstQueued]);

    const laneLimitCoordinator: any = createStateMutationCoordinator({
      policy: { maxActiveLanes: 1 }
    });
    const activeLaneGate: any = deferred();
    const activeLane: any = laneLimitCoordinator.queueStateMutation("one", () : any => activeLaneGate.promise);
    await Promise.resolve();
    await expect(laneLimitCoordinator.queueStateMutation("two", async () : Promise<any> => "blocked"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_LANE_LIMIT_EXCEEDED" });
    activeLaneGate.resolve("done");
    await activeLane;
    await laneLimitCoordinator.waitForStateIdle("one");
    await expect(laneLimitCoordinator.queueStateMutation("two", async () : Promise<any> => "recovered"))
      .resolves.toBe("recovered");
  });

  it("releases queued credits exactly once after queue timeout and repeated abort", async () : Promise<any> => {
    vi.useFakeTimers();
    const coordinator: any = createStateMutationCoordinator({
      policy: {
        maxQueuedPerLane: 1,
        maxQueuedGlobal: 1,
        defaultQueueWaitTimeoutMs: 10,
        maxQueueWaitTimeoutMs: 20,
        defaultExecutionTimeoutMs: 1_000,
        maxExecutionTimeoutMs: 1_000
      }
    });
    const gate: any = deferred();
    const active: any = coordinator.queueStateMutation("timeout", () : any => gate.promise);
    await Promise.resolve();
    const timedOutTask: any = vi.fn();
    const timedOut: any = coordinator.queueStateMutation("timeout", timedOutTask);
    const timedOutAssertion: any = expect(timedOut)
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_WAIT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10);
    await timedOutAssertion;
    expect(timedOutTask).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 0 });

    const abortController: any = new AbortController();
    const abortedTask: any = vi.fn();
    const aborted: any = coordinator.queueStateMutation("timeout", abortedTask, {
      signal: abortController.signal
    });
    abortController.abort();
    abortController.abort();
    await expect(aborted).rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_ABORTED" });
    expect(abortedTask).not.toHaveBeenCalled();

    const replacement: any = coordinator.queueStateMutation("timeout", async () : Promise<any> => "replacement");
    await expect(coordinator.queueStateMutation("timeout", async () : Promise<any> => "overflow"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_LANE_CAPACITY_EXCEEDED" });
    gate.resolve("active");
    await expect(active).resolves.toBe("active");
    await expect(replacement).resolves.toBe("replacement");
  });

  it("separates default and maximum queue-wait and execution timeout bounds", async () : Promise<any> => {
    vi.useFakeTimers();
    const coordinator: any = createStateMutationCoordinator({
      policy: {
        defaultQueueWaitTimeoutMs: 10,
        maxQueueWaitTimeoutMs: 15,
        defaultExecutionTimeoutMs: 20,
        maxExecutionTimeoutMs: 30
      }
    });
    const firstGate: any = deferred();
    const first: any = coordinator.queueStateMutation("bounded-timeouts", async ({ signal }: Record<string, any>) : Promise<any> => {
      await firstGate.promise;
      expect(signal.aborted).toBe(true);
    }, { timeoutMs: 1_000 });
    const firstAssertion: any = expect(first).rejects.toMatchObject({ code: "STATE_MUTATION_TIMEOUT" });
    await Promise.resolve();
    const queued: any = coordinator.queueStateMutation("bounded-timeouts", async () : Promise<any> => "never", {
      queueWaitTimeoutMs: 1_000
    });
    const queuedAssertion: any = expect(queued)
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_WAIT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(14);
    expect(coordinator.snapshot().queuedCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await queuedAssertion;
    await vi.advanceTimersByTimeAsync(15);
    await firstAssertion;
    firstGate.resolve();
    await vi.advanceTimersByTimeAsync(0);

    const defaultGate: any = deferred();
    const defaultActive: any = coordinator.queueStateMutation("default-timeouts", () : any => defaultGate.promise);
    const defaultAssertion: any = expect(defaultActive)
      .rejects.toMatchObject({ code: "STATE_MUTATION_TIMEOUT" });
    await Promise.resolve();
    const defaultQueued: any = coordinator.queueStateMutation("default-timeouts", async () : Promise<any> => "never");
    const defaultQueuedAssertion: any = expect(defaultQueued)
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_WAIT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10);
    await defaultQueuedAssertion;
    await vi.advanceTimersByTimeAsync(10);
    await defaultAssertion;
    defaultGate.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("keeps FIFO lanes isolated and shares one idle deferred while recovering from failure", async () : Promise<any> => {
    const coordinator: any = createStateMutationCoordinator({
      policy: { maxQueuedPerLane: 4, maxQueuedGlobal: 8, maxActiveLanes: 4 }
    });
    const gate: any = deferred();
    const events: any[] = [];
    const first: any = coordinator.queueStateMutation("same", async () : Promise<any> => {
      events.push("first-start");
      await gate.promise;
      events.push("first-end");
      return "first";
    });
    const second: any = coordinator.queueStateMutation("same", async () : Promise<any> => {
      events.push("second");
      throw new Error("synthetic failure");
    });
    const secondOutcome: any = second.catch((error?: any) : any => error);
    const third: any = coordinator.queueStateMutation("same", async () : Promise<any> => {
      events.push("third");
      return "third";
    });
    const idleOne: any = coordinator.waitForStateIdle("same");
    const idleTwo: any = coordinator.waitForStateIdle("same");
    expect(idleOne).toBe(idleTwo);
    await expect(coordinator.queueStateMutation("other", async () : Promise<any> => {
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

  it("fences an actively aborted task until it actually settles", async () : Promise<any> => {
    const coordinator: any = createStateMutationCoordinator();
    const controller: any = new AbortController();
    const gate: any = deferred();
    const taskSettled: any = deferred();
    const active: any = coordinator.queueStateMutation("active-abort", async ({ signal }: Record<string, any>) : Promise<any> => {
      await gate.promise;
      expect(signal.aborted).toBe(true);
      taskSettled.resolve();
    }, { signal: controller.signal });
    await Promise.resolve();
    const queued: any = coordinator.queueStateMutation("active-abort", async () : Promise<any> => "never");
    const queuedAssertion: any = expect(queued)
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_FENCED" });
    controller.abort();
    await expect(active).rejects.toMatchObject({ code: "STATE_MUTATION_ABORTED" });
    await queuedAssertion;
    await expect(coordinator.waitForStateIdle("active-abort"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_FENCED" });
    await expect(coordinator.queueStateMutation("active-abort", async () : Promise<any> => "blocked"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_FENCED" });
    gate.resolve();
    await taskSettled.promise;
    await new Promise((resolve?: any) : any => setImmediate(resolve));
    await expect(coordinator.queueStateMutation("active-abort", async () : Promise<any> => "recovered"))
      .resolves.toBe("recovered");
  });

  it("shares the default authority across entrypoints and exposes privacy-safe aggregate state", async () : Promise<any> => {
    const secretKey: any = "synthetic-secret-state-key";
    const gate: any = deferred();
    const events: any[] = [];
    const direct: any = queueStateMutation(secretKey, async () : Promise<any> => {
      events.push("direct-start");
      await gate.promise;
      events.push("direct-end");
    });
    await Promise.resolve();
    const dispatcher: any = createStateMutationDispatcher();
    const dispatched: any = dispatcher.mutate({
      key: secretKey,
      metadata: { filePath: "/synthetic/private/path" },
      task: async () : Promise<any> => events.push("dispatcher")
    });
    await Promise.resolve();
    expect(events).toEqual(["direct-start"]);
    expect(JSON.stringify(stateMutationSchedulerSnapshot())).not.toContain(secretKey);
    gate.resolve();
    await Promise.all([direct, dispatched]);
    expect(events).toEqual(["direct-start", "direct-end", "dispatcher"]);
  });

  it("rejects oversized and pre-aborted keys before lane creation without logging identifiers", async () : Promise<any> => {
    const logger: Record<string, any> = { debug: vi.fn(), error: vi.fn() };
    const coordinator: any = createStateMutationCoordinator({
      policy: { maxKeyBytes: 8 },
      loggerProvider: () : any => logger
    });
    const oversized: any = "private-key-material";
    const oversizedError: any = await coordinator.queueStateMutation(oversized, async () : Promise<any> => "never")
      .catch((error?: any) : any => error);
    expect(oversizedError).toMatchObject({ code: "STATE_MUTATION_KEY_TOO_LARGE" });
    expect(oversizedError.message).not.toContain(oversized);
    expect(coordinator.snapshot()).toMatchObject({ laneCount: 0, queuedCount: 0 });

    const controller: any = new AbortController();
    controller.abort();
    await expect(coordinator.queueStateMutation("short", async () : Promise<any> => "never", {
      signal: controller.signal
    })).rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_ABORTED" });
    const privateLogger: Record<string, any> = { debug: vi.fn(), error: vi.fn() };
    const privateCoordinator: any = createStateMutationCoordinator({
      policy: {
        maxKeyBytes: 64,
        maxQueuedPerLane: Number.MAX_SAFE_INTEGER,
        maxQueuedGlobal: Number.MAX_SAFE_INTEGER,
        maxActiveLanes: Number.MAX_SAFE_INTEGER
      },
      loggerProvider: () : any => privateLogger
    });
    await privateCoordinator.queueStateMutation("synthetic-private-lane", async () : Promise<any> => "ok");
    const serializedLogs: any = JSON.stringify([...logger.debug.mock.calls, ...logger.error.mock.calls]);
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

  it("fails queued mutations fast while a timed-out task remains the serialization fence", async () : Promise<any> => {
    vi.useFakeTimers();
    const events: any[] = [];
    let releaseFirst: any;
    let markFirstSettled: any;
    const firstTaskSettled: any = new Promise((resolve?: any) : any => {
      releaseFirst = resolve;
    });
    const firstActuallySettled: any = new Promise((resolve?: any) : any => {
      markFirstSettled = resolve;
    });

    const first: any = queueStateMutation("timeout-fence", async ({ signal }: Record<string, any>) : Promise<any> => {
      events.push("first-start");
      await firstTaskSettled;
      expect(signal.aborted).toBe(true);
      events.push("first-end");
      markFirstSettled();
      return "first";
    });
    const second: any = queueStateMutation("timeout-fence", async () : Promise<any> => {
      events.push("second-start");
      return "second";
    });
    const firstRejected: any = expect(first).rejects.toMatchObject({ code: "STATE_MUTATION_TIMEOUT" });
    const secondRejected: any = expect(second).rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_FENCED" });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    await firstRejected;
    await secondRejected;

    await expect(queueStateMutation("timeout-fence", async () : Promise<any> => "third"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_FENCED" });
    await expect(waitForStateIdle("timeout-fence"))
      .rejects.toMatchObject({ code: "STATE_MUTATION_QUEUE_FENCED" });
    expect(events).toEqual(["first-start"]);

    releaseFirst();
    await firstActuallySettled;
    await vi.advanceTimersByTimeAsync(0);
    await expect(queueStateMutation("timeout-fence", async () : Promise<any> => {
      events.push("fourth-start");
      return "fourth";
    })).resolves.toBe("fourth");
    expect(events).toEqual(["first-start", "first-end", "fourth-start"]);
  });

  it("rejects invalid mutation tasks and logs dispatcher failures", async () : Promise<any> => {
    expect(() : any => queueStateMutation("invalid", null)).toThrow(
      "queueStateMutation requires a task function."
    );

    const logger: Record<string, any> = {
      debug: vi.fn(),
      error: vi.fn()
    };
    const dispatcher: any = createStateMutationDispatcher({ logger });

    await expect(dispatcher.mutate({
      key: "bad-dispatch",
      task: null
    })).rejects.toThrow("StateMutationDispatcher.mutate requires a task function.");

    await expect(dispatcher.mutate({
      key: "throwing-dispatch",
      kind: "state.test.throw",
      metadata: { source: "unit" },
      task: async () : Promise<any> => {
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

  it("serializes dispatcher file writes, append helpers, and idle waits", async () : Promise<any> => {
    const root: any = await tempDir("meshrix-state-coordinator-");
    const jsonPath: any = path.join(root, "nested", "state.json");
    const jsonlPath: any = path.join(root, "events", "events.jsonl");
    const dispatcher: any = createStateMutationDispatcher();

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

  it("cleans temporary atomic writes and handles JSON fallback/error branches", async () : Promise<any> => {
    const root: any = await tempDir("meshrix-state-coordinator-files-");
    const directoryTarget: any = path.join(root, "directory-target");
    await fs.mkdir(directoryTarget);

    await expect(atomicWriteFile(directoryTarget, "content")).rejects.toThrow();
    const leftovers: any = await fs.readdir(root);
    expect(leftovers.filter((name?: any) : any => name.startsWith(".directory-target."))).toEqual([]);

    const emptyPath: any = path.join(root, "empty.json");
    await fs.writeFile(emptyPath, "   \n");
    await expect(readJsonFile(emptyPath, { fallback: true })).resolves.toEqual({ fallback: true });

    const invalidPath: any = path.join(root, "invalid.json");
    await fs.writeFile(invalidPath, "{not-json");
    await expect(readJsonFile(invalidPath, {})).rejects.toThrow();
  });

  it("syncs private state bytes before rename and the parent directory after rename", async () : Promise<any> => {
    const root: any = await tempDir("meshrix-state-coordinator-durable-");
    const parentDirectory: any = path.join(root, "private-state");
    const targetPath: any = path.join(parentDirectory, "state.json");
    const events: any[] = [];
    const originalOpen: any = fs.open.bind(fs);
    const originalRename: any = fs.rename.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filePath: any, ...args: any[]) : Promise<any> => {
      const handle: any = await originalOpen(filePath, ...args);
      const resolvedPath: any = path.resolve(String(filePath));
      const kind: any = resolvedPath === path.resolve(parentDirectory)
        ? "directory"
        : path.basename(resolvedPath).startsWith(".state.json.")
          ? "temporary-file"
          : "ancestor-directory";
      const originalSync: any = handle.sync.bind(handle);
      Object.defineProperty(handle, "sync", {
        configurable: true,
        value: async (...syncArgs: any[]) : Promise<any> => {
          events.push(`${kind}:sync`);
          return originalSync(...syncArgs);
        }
      });
      return handle;
    });
    vi.spyOn(fs, "rename").mockImplementation(async (...args: any[]) : Promise<any> => {
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

  it("appends private durable JSONL and removes an unterminated torn tail", async () : Promise<any> => {
    const root: any = await tempDir("meshrix-state-coordinator-jsonl-");
    const eventPath: any = path.join(root, "private-events", "events.jsonl");
    const previousUmask: any = process.umask(0o022);
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

    const invalidTarget: any = path.join(root, "invalid-jsonl-target");
    await fs.mkdir(invalidTarget);
    await expect(appendJsonLine(invalidTarget, { sequence: 3 }))
      .rejects.toMatchObject({ code: "STATE_JSONL_PATH_INVALID" });
  });

  it("compacts bounded JSONL and reads only the retained tail", async () : Promise<any> => {
    const root: any = await tempDir("meshrix-bounded-jsonl-");
    const eventPath: any = path.join(root, "events", "bounded.jsonl");

    for (let sequence: any = 0; sequence < 30; sequence += 1) {
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

    const records: any = await readJsonlTail(eventPath, {
      limit: 3,
      maxScanBytes: 1024,
      reverse: true
    });
    expect(records.map((record?: any) : any => record.sequence)).toEqual([29, 28, 27]);
    await expect(appendBoundedJsonLine(eventPath, {
      sequence: 31,
      detail: "x".repeat(1000)
    }, {
      maxBytes: 2048,
      maxRecordBytes: 512
    })).rejects.toMatchObject({ code: "BOUNDED_JSONL_RECORD_TOO_LARGE" });
  });

  it("heals a torn JSONL tail on read instead of failing", async (): Promise<any> => {
    const root: any = await tempDir("meshrix-bounded-jsonl-torn-");
    const eventPath: any = path.join(root, "events", "torn.jsonl");

    const complete = `${JSON.stringify({ sequence: 1 })}\n${JSON.stringify({ sequence: 2 })}\n`;
    // Simulate a crash mid-append: a partial record without its newline.
    await fs.mkdir(path.dirname(eventPath), { recursive: true });
    await fs.writeFile(eventPath, `${complete}${JSON.stringify({ sequence: 3 }).slice(0, 8)}`, "utf8");

    const records: any = await readJsonlTail(eventPath, { limit: 10 });
    expect(records).toEqual([{ sequence: 1 }, { sequence: 2 }]);

    // The torn tail is physically truncated so later reads and appends see a
    // newline-terminated file.
    expect(await fs.readFile(eventPath, "utf8")).toBe(complete);

    // The healed file accepts further appends normally.
    await appendBoundedJsonLine(eventPath, { sequence: 3 });
    const afterAppend: any = await readJsonlTail(eventPath, { limit: 10 });
    expect(afterAppend.map((record?: any): any => record.sequence)).toEqual([1, 2, 3]);
  });

  it("can ignore atomic writes when the target directory is concurrently removed", async () : Promise<any> => {
    const root: any = await tempDir("meshrix-state-coordinator-missing-parent-");
    const parentDirectory: any = path.join(root, "jobs", "job-1");
    const targetPath: any = path.join(parentDirectory, "meta.json");

    await expect(atomicWriteFile(targetPath, "{}", {
      encoding: "utf8",
      ignoreMissingParent: true,
      onTempFileReady: async () : Promise<any> => {
        await fs.rm(parentDirectory, { recursive: true, force: true });
      }
    })).resolves.toBe(false);

    await expect(fs.stat(parentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(path.join(root, "jobs"))).resolves.toEqual([]);
  });

  it("keeps bounded maps ordered while tolerating invalid map inputs", () : any => {
    expect(setBoundedMapEntry(null, "x", 1, 1)).toBeUndefined();

    const map: any = new Map<any, any>([
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
