import fs from "node:fs/promises";
import http from "node:http";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startHttpServer } from "../../../apps/server/runtime/http-server.mjs";

class ListenerStub extends EventEmitter {
  constructor() {
    super();
    this.listening = false;
  }

  listen(_port, _host, callback) {
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

const cleanups = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
});

async function startStubbedServer({ discoveryOptions = {} } = {}) {
  vi.spyOn(http, "createServer").mockReturnValue(new ListenerStub());
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-advertised-url-"));
  cleanups.push(() => fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const serverHandle = await startHttpServer({
    userDataPath,
    distPath: "",
    host: "127.0.0.1",
    port: 0,
    discoveryOptions
  });
  cleanups.push(() => serverHandle.close().catch(() => {}));
  return serverHandle;
}

describe("HTTP server advertised base URL", () => {
  it("derives externally-facing URLs from the advertised base URL, including its port", async () => {
    const serverHandle = await startStubbedServer({
      discoveryOptions: { advertisedBaseUrl: "http://127.0.0.1:8228/" }
    });
    expect(serverHandle.port).toBe(43123);
    expect(serverHandle.url).toBe("http://127.0.0.1:8228");
    expect(serverHandle.discovery.advertisedBaseUrl).toBe("http://127.0.0.1:8228");
  });

  it("keeps the socket bind address when no advertised base URL is configured", async () => {
    const serverHandle = await startStubbedServer();
    expect(serverHandle.url).toBe("http://127.0.0.1:43123");
  });
});
