import fs from "node:fs/promises";
import http from "node:http";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startHttpServer } from "../../../apps/server/runtime/http-server.mjs";
import {
  LockManagerDestroyedError,
  MemoryLockManager
} from "../../../packages/foundation/src/concurrency/lock-manager.mjs";

class ListenerStub extends EventEmitter {
  constructor({ listenError = null } = {}) {
    super();
    this.listenError = listenError;
    this.listening = false;
  }

  listen(_port, _host, callback) {
    if (this.listenError) {
      queueMicrotask(() => this.emit("error", this.listenError));
      return this;
    }
    this.listening = true;
    queueMicrotask(callback);
    return this;
  }

  address() {
    return this.listening
      ? { address: "127.0.0.1", family: "IPv4", port: 43123 }
      : null;
  }

  close(callback) {
    this.listening = false;
    queueMicrotask(() => callback?.());
    return this;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HTTP startup lock safety", () => {
  it("unwinds an injected lock manager when listen fails after composition", async () => {
    const listenError = Object.assign(new Error("address unavailable"), { code: "EADDRINUSE" });
    vi.spyOn(http, "createServer").mockReturnValue(new ListenerStub({ listenError }));
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-startup-lock-"));
    const manager = new MemoryLockManager();

    try {
      await expect(startHttpServer({
        userDataPath,
        distPath: "",
        host: "127.0.0.1",
        port: 43123,
        operationLockManager: manager,
        operationConcurrencyScope: "test-deployment"
      })).rejects.toMatchObject({ code: "EADDRINUSE" });
      await expect(manager.acquire("after-failed-startup"))
        .rejects.toBeInstanceOf(LockManagerDestroyedError);
    } finally {
      manager.destroy();
      await fs.rm(userDataPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20
      });
    }
  });

  it("owns an injected manager and makes successful server close idempotent", async () => {
    vi.spyOn(http, "createServer").mockReturnValue(new ListenerStub());
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-startup-close-lock-"));
    const manager = new MemoryLockManager();
    let serverHandle = null;

    try {
      serverHandle = await startHttpServer({
        userDataPath,
        distPath: "",
        host: "127.0.0.1",
        port: 0,
        operationLockManager: manager,
        operationConcurrencyScope: "test-deployment"
      });
      const firstClose = serverHandle.close();
      const secondClose = serverHandle.close();
      expect(secondClose).toBe(firstClose);
      await firstClose;
      await expect(manager.acquire("after-successful-shutdown"))
        .rejects.toBeInstanceOf(LockManagerDestroyedError);
    } finally {
      await serverHandle?.close?.().catch(() => {});
      manager.destroy();
      await fs.rm(userDataPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20
      });
    }
  });
});
