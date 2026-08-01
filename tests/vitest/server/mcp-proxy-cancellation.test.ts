import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchJson } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/http-json-client.ts";
import {
  createProxyStdioTransport,
  encodeStdioJsonRpc,
  MCP_STDIO_FRAMING_CONTENT_LENGTH
} from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/proxy-command.ts";

afterEach(() : any => {
  vi.unstubAllGlobals();
});

describe("MCP stdio proxy cancellation", () : any => {
  it("cancels only the matching concurrent request and cleans active dispatches", async () : Promise<any> => {
    const writes: any[] = [];
    const forwardedMessages: any[] = [];
    let cancelledRequestObserved: any = false;
    let cancellationSignalReason: any;
    let unrelatedRequestCompleted: any = false;

    const forwardMessage: any = ({ message, signal }: Record<string, any>) : any => {
      forwardedMessages.push(message);
      if (message.id === "slow-request") {
        return new Promise((resolve?: any, reject?: any) : any => {
          const rejectCancelled: any = () : any => {
            cancelledRequestObserved = true;
            cancellationSignalReason = signal.reason;
            const error: any = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          };
          if (signal.aborted) {
            rejectCancelled();
            return;
          }
          signal.addEventListener("abort", rejectCancelled, { once: true });
        });
      }
      if (message.id === "unrelated-request") {
        return Promise.resolve().then(() : any => {
          unrelatedRequestCompleted = true;
          return { jsonrpc: "2.0", id: message.id, result: { ok: true } };
        });
      }
      return Promise.resolve({});
    };
    const transport: any = createProxyStdioTransport({
      baseUrl: "http://gateway.invalid",
      token: "test-token",
      target: "test-client",
      forwardMessage,
      writeMessage(payload?: any, framing?: any) : any {
        writes.push({ payload, framing });
      }
    });

    transport.push(Buffer.concat([
      encodeStdioJsonRpc({
        jsonrpc: "2.0",
        id: "slow-request",
        method: "tools/call",
        params: { name: "fixture.slow" }
      }, MCP_STDIO_FRAMING_CONTENT_LENGTH),
      encodeStdioJsonRpc({
        jsonrpc: "2.0",
        id: "unrelated-request",
        method: "tools/call",
        params: { name: "fixture.fast" }
      }, MCP_STDIO_FRAMING_CONTENT_LENGTH),
      encodeStdioJsonRpc({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "slow-request", reason: "client stopped waiting" }
      }, MCP_STDIO_FRAMING_CONTENT_LENGTH),
      encodeStdioJsonRpc({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "unknown-request" }
      }, MCP_STDIO_FRAMING_CONTENT_LENGTH)
    ]));
    await transport.close();

    transport.push(encodeStdioJsonRpc({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "unrelated-request" }
    }, MCP_STDIO_FRAMING_CONTENT_LENGTH));
    await transport.close();

    expect(cancelledRequestObserved).toBe(true);
    expect(cancellationSignalReason).toMatchObject({
      name: "AbortError",
      message: "MCP request cancelled."
    });
    expect(unrelatedRequestCompleted).toBe(true);
    expect(forwardedMessages.map(({ method }: Record<string, any>) : any => method)).toEqual([
      "tools/call",
      "tools/call",
      "notifications/cancelled"
    ]);
    expect(forwardedMessages.at(-1)?.params).toEqual({ requestId: "slow-request" });
    expect(writes).toHaveLength(1);
    expect(writes.every(({ framing }: Record<string, any>) : any => framing === MCP_STDIO_FRAMING_CONTENT_LENGTH)).toBe(true);
    expect(writes.some(({ payload }: Record<string, any>) : any => payload.id === "slow-request")).toBe(false);
    expect(writes.find(({ payload }: Record<string, any>) : any => payload.id === "unrelated-request")?.payload.result).toEqual({ ok: true });
    expect(writes.some(({ payload }: Record<string, any>) : any => payload.id === undefined)).toBe(false);
    expect(transport.activeRequestCount).toBe(0);
    expect(transport.pendingDispatchCount).toBe(0);
  });

  it("bounds JSONL frames, Content-Length frames, and incomplete input buffers", async () : Promise<any> => {
    const forwardedMessages: any[] = [];
    const jsonlWrites: any[] = [];
    const jsonlTransport: any = createProxyStdioTransport({
      maxFrameBytes: 96,
      maxBufferBytes: 512,
      forwardMessage: async ({ message }: Record<string, any>) : Promise<any> => {
        forwardedMessages.push(message);
        return {};
      },
      writeMessage(payload?: any, framing?: any) : any {
        jsonlWrites.push({ payload, framing });
      }
    });

    jsonlTransport.push(Buffer.concat([
      encodeStdioJsonRpc({
        jsonrpc: "2.0",
        id: "oversized-jsonl",
        method: "tools/call",
        params: { value: "x".repeat(128) }
      }),
      encodeStdioJsonRpc({ jsonrpc: "2.0", method: "notifications/initialized" })
    ]));
    await jsonlTransport.close();

    expect(jsonlTransport.inputFailed).toBe(false);
    expect(jsonlWrites).toEqual([{
      payload: {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "MCP stdio frame limit exceeded." }
      },
      framing: "jsonl"
    }]);
    expect(forwardedMessages).toEqual([{
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }]);

    const contentLengthWrites: any[] = [];
    const contentLengthTransport: any = createProxyStdioTransport({
      maxFrameBytes: 96,
      maxBufferBytes: 512,
      forwardMessage: vi.fn(),
      writeMessage(payload?: any, framing?: any) : any {
        contentLengthWrites.push({ payload, framing });
      }
    });
    contentLengthTransport.push(encodeStdioJsonRpc({
      jsonrpc: "2.0",
      id: "oversized-content-length",
      method: "tools/call",
      params: { value: "x".repeat(128) }
    }, MCP_STDIO_FRAMING_CONTENT_LENGTH));

    expect(contentLengthTransport.inputFailed).toBe(true);
    expect(contentLengthWrites).toEqual([{
      payload: {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "MCP stdio frame limit exceeded." }
      },
      framing: MCP_STDIO_FRAMING_CONTENT_LENGTH
    }]);

    const bufferWrites: any[] = [];
    const bufferTransport: any = createProxyStdioTransport({
      maxFrameBytes: 128,
      maxBufferBytes: 16,
      forwardMessage: vi.fn(),
      writeMessage(payload?: any, framing?: any) : any {
        bufferWrites.push({ payload, framing });
      }
    });
    bufferTransport.push(Buffer.from("a".repeat(17), "utf8"));

    expect(bufferTransport.inputFailed).toBe(true);
    expect(bufferWrites).toEqual([{
      payload: {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "MCP stdio input buffer limit exceeded." }
      },
      framing: "jsonl"
    }]);
  });

  it("rejects excess active requests while accepting cancellation at full capacity", async () : Promise<any> => {
    const forwardedMessages: any[] = [];
    const writes: any[] = [];
    let activeRequestCancelled: any = false;
    const transport: any = createProxyStdioTransport({
      maxActiveRequests: 1,
      maxPendingDispatches: 2,
      forwardMessage({ message, signal }: Record<string, any>) : any {
        forwardedMessages.push(message);
        if (message.id === "active-request") {
          return new Promise((resolve?: any, reject?: any) : any => {
            signal.addEventListener("abort", () : any => {
              activeRequestCancelled = true;
              reject(signal.reason);
            }, { once: true });
          });
        }
        return Promise.resolve({});
      },
      writeMessage(payload?: any, framing?: any) : any {
        writes.push({ payload, framing });
      }
    });

    transport.push(Buffer.concat([
      encodeStdioJsonRpc({
        jsonrpc: "2.0",
        id: "active-request",
        method: "tools/call"
      }, MCP_STDIO_FRAMING_CONTENT_LENGTH),
      encodeStdioJsonRpc({
        jsonrpc: "2.0",
        id: "excess-request",
        method: "tools/call"
      }, MCP_STDIO_FRAMING_CONTENT_LENGTH),
      encodeStdioJsonRpc({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "active-request" }
      }, MCP_STDIO_FRAMING_CONTENT_LENGTH)
    ]));

    expect(activeRequestCancelled).toBe(true);
    expect(transport.pendingWorkCount).toBeLessThanOrEqual(2);
    await transport.close();

    expect(forwardedMessages.map(({ method }: Record<string, any>) : any => method)).toEqual([
      "tools/call",
      "notifications/cancelled"
    ]);
    expect(writes).toEqual([{
      payload: {
        jsonrpc: "2.0",
        id: "excess-request",
        error: { code: -32000, message: "MCP proxy request capacity exceeded." }
      },
      framing: MCP_STDIO_FRAMING_CONTENT_LENGTH
    }]);
    expect(transport.activeRequestCount).toBe(0);
    expect(transport.pendingDispatchCount).toBe(0);
    expect(transport.pendingWorkCount).toBe(0);
  });

  it("caps pending notification and dispatch work independently of active requests", async () : Promise<any> => {
    const forwardedMessages: any[] = [];
    const completions: any[] = [];
    const writes: any[] = [];
    const transport: any = createProxyStdioTransport({
      maxActiveRequests: 4,
      maxPendingDispatches: 2,
      forwardMessage({ message }: Record<string, any>) : any {
        forwardedMessages.push(message);
        return new Promise((resolve?: any) : any => completions.push(resolve));
      },
      writeMessage(payload?: any, framing?: any) : any {
        writes.push({ payload, framing });
      }
    });

    transport.push(Buffer.concat([
      encodeStdioJsonRpc({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }),
      encodeStdioJsonRpc({ jsonrpc: "2.0", id: "pending-cap-request", method: "tools/list" }),
      encodeStdioJsonRpc({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 2 } }),
      encodeStdioJsonRpc({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 3 } })
    ]));

    expect(forwardedMessages.map(({ params }: Record<string, any>) : any => params?.progress)).toEqual([1, 2]);
    expect(transport.activeRequestCount).toBe(0);
    expect(transport.pendingDispatchCount).toBe(2);
    expect(transport.pendingWorkCount).toBe(2);
    expect(writes).toEqual([{
      payload: {
        jsonrpc: "2.0",
        id: "pending-cap-request",
        error: { code: -32000, message: "MCP proxy request capacity exceeded." }
      },
      framing: "jsonl"
    }]);

    for (const complete of completions) {
      complete({});
    }
    await transport.close();

    expect(transport.pendingDispatchCount).toBe(0);
    expect(transport.pendingWorkCount).toBe(0);
  });

  it("keeps cancellation responsive while stdout is waiting for drain", async () : Promise<any> => {
    const writable: any = new EventEmitter();
    const frames: any[] = [];
    writable.write = vi.fn((frame?: any) : any => {
      frames.push(Buffer.from(frame));
      return false;
    });
    const forwarded: any[] = [];
    let cancelled: any = false;
    const transport: any = createProxyStdioTransport({
      writable,
      outputDrainTimeoutMs: 1_000,
      forwardMessage({ message, signal }: Record<string, any>) : any {
        forwarded.push(message);
        if (message.id === "blocked-output") {
          return Promise.resolve({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
        }
        if (message.id === "cancel-while-blocked") {
          return new Promise((resolve?: any, reject?: any) : any => {
            signal.addEventListener("abort", () : any => {
              cancelled = true;
              reject(signal.reason);
            }, { once: true });
          });
        }
        return Promise.resolve(null);
      }
    });

    transport.push(encodeStdioJsonRpc({
      jsonrpc: "2.0",
      id: "blocked-output",
      method: "tools/list"
    }, MCP_STDIO_FRAMING_CONTENT_LENGTH));
    await vi.waitFor(() : any => expect(transport.outputSnapshot.blocked).toBe(true));
    expect(frames[0].subarray(0, 15).toString("ascii")).toBe("Content-Length:");

    transport.push(Buffer.concat([
      encodeStdioJsonRpc({
        jsonrpc: "2.0",
        id: "cancel-while-blocked",
        method: "tools/call"
      }),
      encodeStdioJsonRpc({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "cancel-while-blocked" }
      })
    ]));

    expect(cancelled).toBe(true);
    expect(forwarded.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "cancel-while-blocked" }
    });
    expect(writable.write).toHaveBeenCalledTimes(1);

    writable.emit("drain");
    await transport.close();
    expect(frames).toHaveLength(1);
    expect(transport.outputSnapshot).toMatchObject({
      pendingBytes: 0,
      pendingMessages: 0,
      blocked: false,
      failed: false
    });
  });

  it("fails input without growing a permanently backpressured stdout buffer", async () : Promise<any> => {
    const writable: any = new EventEmitter();
    const frames: any[] = [];
    writable.write = vi.fn((frame?: any) : any => {
      frames.push(Buffer.from(frame));
      return false;
    });
    const transport: any = createProxyStdioTransport({
      writable,
      maxOutputQueuedBytes: 512,
      maxOutputQueuedMessages: 2,
      outputDrainTimeoutMs: 1_000,
      forwardMessage: async ({ message }: Record<string, any>) : Promise<any> => ({
        jsonrpc: "2.0",
        id: message.id,
        result: { value: "x".repeat(32) }
      })
    });

    transport.push(Buffer.concat([1, 2, 3].map((id?: any) : any => encodeStdioJsonRpc({
      jsonrpc: "2.0",
      id,
      method: "tools/list"
    }))));

    await expect(transport.close()).rejects.toMatchObject({
      code: "MCP_PROXY_OUTPUT_FAILED",
      message: "MCP proxy output capacity exceeded."
    });
    expect(writable.write).toHaveBeenCalledTimes(1);
    expect(frames[0].length).toBeLessThanOrEqual(512);
    expect(transport.inputFailed).toBe(true);
    expect(transport.outputSnapshot).toMatchObject({
      pendingBytes: 0,
      pendingMessages: 0,
      blocked: false,
      failed: true,
      maxQueuedBytes: 512,
      maxQueuedMessages: 2
    });

    transport.push(encodeStdioJsonRpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list"
    }));
    expect(writable.write).toHaveBeenCalledTimes(1);
  });

  it("keeps the timeout active when an external abort signal is supplied", async () : Promise<any> => {
    let combinedSignal: any;
    vi.stubGlobal("fetch", vi.fn((_url?: any, options?: any) : any => {
      combinedSignal = options.signal;
      return new Promise((resolve?: any, reject?: any) : any => {
        const rejectAborted: any = () : any => reject(options.signal.reason);
        if (options.signal.aborted) {
          rejectAborted();
          return;
        }
        options.signal.addEventListener("abort", rejectAborted, { once: true });
      });
    }));
    const externalController: any = new AbortController();

    await expect(fetchJson("http://gateway.invalid/mcp", {
      signal: externalController.signal,
      timeoutMs: 5
    })).rejects.toMatchObject({ name: "TimeoutError" });

    expect(combinedSignal).not.toBe(externalController.signal);
    expect(combinedSignal.aborted).toBe(true);
    expect(externalController.signal.aborted).toBe(false);
  });

  it("propagates an external abort before the timeout", async () : Promise<any> => {
    vi.stubGlobal("fetch", vi.fn((_url?: any, options?: any) : any => new Promise((resolve?: any, reject?: any) : any => {
      const rejectAborted: any = () : any => reject(options.signal.reason);
      if (options.signal.aborted) {
        rejectAborted();
        return;
      }
      options.signal.addEventListener("abort", rejectAborted, { once: true });
    })));
    const externalController: any = new AbortController();
    const expectedReason: any = new Error("client cancellation");
    const response: any = fetchJson("http://gateway.invalid/mcp", {
      signal: externalController.signal,
      timeoutMs: 1000
    });

    externalController.abort(expectedReason);

    await expect(response).rejects.toBe(expectedReason);
  });
});
