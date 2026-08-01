import fs from "node:fs/promises";
import http from "node:http";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startHttpServer } from "../../../apps/server/runtime/http-server.ts";

class ListenerStub extends EventEmitter {
  listening: any;
  constructor() {
    super();
    this.listening = false;
  }

  listen(_port?: any, _host?: any, callback?: any) : any {
    this.listening = true;
    queueMicrotask(callback);
    return this;
  }

  address() : any {
    return this.listening
      ? { address: "127.0.0.1", family: "IPv4", port: 43123 }
      : null;
  }

  close(callback?: any) : any {
    this.listening = false;
    queueMicrotask(() : any => callback?.());
    return this;
  }
}

const cleanups: any[] = [];

afterEach(async () : Promise<any> => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).reverse().map((cleanup?: any) : any => cleanup()));
});

async function startStubbedServer({ discoveryOptions = {} }: Record<string, any> = {}) : Promise<any> {
  vi.spyOn(http, "createServer").mockReturnValue(new ListenerStub());
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-advertised-url-"));
  cleanups.push(() : any => fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const serverHandle: any = await startHttpServer({
    userDataPath,
    distPath: "",
    host: "127.0.0.1",
    port: 0,
    discoveryOptions
  });
  cleanups.push(() : any => serverHandle.close().catch(() : any => {}));
  return serverHandle;
}

describe("HTTP server advertised base URL", () : any => {
  it("derives externally-facing URLs from the advertised base URL, including its port", async () : Promise<any> => {
    const serverHandle: any = await startStubbedServer({
      discoveryOptions: { advertisedBaseUrl: "http://127.0.0.1:8228/" }
    });
    expect(serverHandle.port).toBe(43123);
    expect(serverHandle.url).toBe("http://127.0.0.1:8228");
    expect(serverHandle.discovery.advertisedBaseUrl).toBe("http://127.0.0.1:8228");
  });

  it("keeps the socket bind address when no advertised base URL is configured", async () : Promise<any> => {
    const serverHandle: any = await startStubbedServer();
    expect(serverHandle.url).toBe("http://127.0.0.1:43123");
  });
});
