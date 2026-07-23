import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const readerState = vi.hoisted(() => ({
  mode: "lines",
  lines: [],
  error: null
}));

function createMiniEmitter() {
  const listeners = new Map();
  return {
    on(event, handler) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event).add(handler);
      return this;
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) || [])]) {
        handler(...args);
      }
      return this;
    },
    removeListener(event, handler) {
      listeners.get(event)?.delete(handler);
      return this;
    },
    destroy() {
      this.emit("close");
    },
    close() {
      this.emit("close");
    }
  };
}

const createReadStreamMock = vi.hoisted(() => vi.fn(() => createMiniEmitter()));

const createInterfaceMock = vi.hoisted(() => vi.fn(() => {
  const lines = createMiniEmitter();
  queueMicrotask(() => {
    if (readerState.mode === "error") {
      lines.emit("error", readerState.error || new Error("reader failed"));
      return;
    }
    for (const line of readerState.lines) {
      lines.emit("line", line);
    }
    lines.emit("close");
  });
  return lines;
}));

vi.mock("node:fs", () => ({
  default: {
    createReadStream: createReadStreamMock,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn()
  },
  createReadStream: createReadStreamMock
}));

vi.mock("node:readline", () => ({
  default: {
    createInterface: createInterfaceMock
  },
  createInterface: createInterfaceMock
}));

import { createProtocolEventBus } from "../../../packages/protocols/pubsub/event-bus.mjs";

async function withTempUserData(testCase) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-event-bus-focused-"));
  try {
    return await testCase(userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(() => {
  readerState.mode = "lines";
  readerState.lines = [];
  readerState.error = null;
  createReadStreamMock.mockClear();
  createInterfaceMock.mockClear();
  vi.restoreAllMocks();
});

describe("protocol event bus behavior", () => {
  it("skips malformed JSONL lines and normalizes topic filters", async () => {
    await withTempUserData(async (userDataPath) => {
      readerState.lines = [
        "{not-json",
        JSON.stringify({
          schemaVersion: "v0.0.1:schema:definition-1",
          offset: 2,
          id: "event-2",
          topic: "alpha",
          type: "snapshot",
          publisher: "server",
          publishedAt: "2026-06-05T00:00:00.000Z",
          payload: { value: 2 }
        })
      ];

      const bus = createProtocolEventBus({ userDataPath, logger: logger() });
      const result = await bus.readEvents({
        cursor: 1,
        topics: [" alpha ", "", "alpha", "beta"],
        limit: 10
      });

      expect(result.cursor).toBe(1);
      expect(result.nextCursor).toBe(2);
      expect(result.topics).toEqual(["alpha", "beta"]);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        offset: 2,
        topic: "alpha",
        payload: { value: 2 }
      });
    });
  });

  it("rejects when the JSONL reader emits an unexpected error", async () => {
    await withTempUserData(async (userDataPath) => {
      readerState.mode = "error";
      readerState.error = new Error("stream broke");

      const bus = createProtocolEventBus({ userDataPath, logger: logger() });
      await expect(bus.readEvents({ cursor: 0, limit: 10 })).rejects.toThrow("stream broke");
    });
  });

  it("removes abort listeners after a waiting subscription is cancelled", async () => {
    await withTempUserData(async (userDataPath) => {
      const bus = createProtocolEventBus({ userDataPath, logger: logger() });
      const controller = new AbortController();
      const addSpy = vi.spyOn(AbortSignal.prototype, "addEventListener");
      const removeSpy = vi.spyOn(AbortSignal.prototype, "removeEventListener");

      const pending = bus.subscribe({
        cursor: 0,
        topics: ["missing"],
        timeoutMs: 5000,
        signal: controller.signal
      });

      await waitFor(() => addSpy.mock.calls.some(([eventName]) => eventName === "abort"));
      controller.abort();

      const result = await pending;
      expect(result.events).toEqual([]);
      expect(result.nextCursor).toBe(0);
      expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    });
  });
});
