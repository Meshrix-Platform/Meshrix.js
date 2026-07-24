import http from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.mjs";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.mjs";

const cleanup = [];

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function opaqueTransport(maxBytes = 1024 * 1024) {
  return {
    request: { mode: "opaque_stream", maxBytes, mediaTypes: ["application/octet-stream"] },
    response: { mode: "opaque_stream", maxBytes, mediaTypes: ["application/octet-stream"] }
  };
}

function registryFor(baseUrl, maxBytes = 1024 * 1024) {
  const registry = createUpstreamGatewayRegistry();
  installUpstreamRuntimeServices(registry, [{
    serviceId: "binary-fixture",
    serviceProtocol: "http",
    baseUrl,
    allowLocalNetwork: true,
    operations: [{
      operationKey: "convert",
      method: "POST",
      path: "/convert",
      risk: "safe_write",
      requiredScopes: ["gateway:write"],
      payloadTransport: opaqueTransport(maxBytes)
    }]
  }]);
  cleanup.push(() => registry.close());
  return registry;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).reverse().map((close) => close()));
});

describe("native upstream payload transit", () => {
  it("preserves multi-chunk binary bodies and representation headers byte-for-byte", async () => {
    const requestChunks = [];
    const responseBytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x7f, 0x80]);
    const baseUrl = await listen(async (request, response) => {
      for await (const chunk of request) requestChunks.push(Buffer.from(chunk));
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-encoding": "gzip",
        "content-disposition": "attachment; filename=converted.pdf",
        "x-private-upstream": "must-not-forward"
      });
      response.write(responseBytes.subarray(0, 3));
      response.end(responseBytes.subarray(3));
    });
    const registry = registryFor(baseUrl);
    const inputBytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x41, 0x00, 0x42]);
    const received = [];
    const result = await registry.forwardHttpStream({
      serviceId: "binary-fixture",
      operationKey: "convert",
      requestHeaders: {
        "content-type": "application/octet-stream",
        "content-encoding": "identity",
        authorization: "caller-secret-must-not-forward",
        host: "caller.invalid"
      },
      contentLength: null,
      requestStream: Readable.from([inputBytes.subarray(0, 2), inputBytes.subarray(2)])
    }, { subjectId: "owner", scopes: ["gateway:write"] }, {
      async consumeResponse(upstream) {
        expect(upstream.headers).toMatchObject({
          "content-type": "application/octet-stream",
          "content-encoding": "gzip",
          "content-disposition": "attachment; filename=converted.pdf"
        });
        expect(upstream.headers).not.toHaveProperty("x-private-upstream");
        for await (const chunk of upstream.body) received.push(Buffer.from(chunk));
      }
    });
    expect(Buffer.concat(requestChunks)).toEqual(inputBytes);
    expect(Buffer.concat(received)).toEqual(responseBytes);
    expect(result).toMatchObject({ ok: true, requestBytes: inputBytes.byteLength, responseBytes: responseBytes.byteLength });
  });

  it("rejects declared and streamed bodies beyond the published bounds", async () => {
    let hits = 0;
    const baseUrl = await listen(async (request, response) => {
      hits += 1;
      for await (const _chunk of request) { /* drain */ }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(16));
    });
    const registry = registryFor(baseUrl, 8);
    const invoke = (contentLength, requestStream) => registry.forwardHttpStream({
      serviceId: "binary-fixture",
      operationKey: "convert",
      requestHeaders: { "content-type": "application/octet-stream" },
      contentLength,
      requestStream
    }, { subjectId: "owner", scopes: ["gateway:write"] }, {
      consumeResponse: async (upstream) => {
        for await (const _chunk of upstream.body) { /* drain */ }
      }
    });
    await expect(invoke(9, Readable.from([]))).rejects.toMatchObject({ status: 413, reasonCode: "request_body_too_large" });
    expect(hits).toBe(0);
    await expect(invoke(null, Readable.from([Buffer.alloc(9)]))).rejects.toMatchObject({ status: 413, reasonCode: "request_body_too_large" });
  });

  it("propagates caller cancellation and settles the active stream", async () => {
    let upstreamClosed = false;
    let resolveUpstreamClose;
    const upstreamClose = new Promise((resolve) => { resolveUpstreamClose = resolve; });
    const baseUrl = await listen(async (request, response) => {
      for await (const _chunk of request) { /* drain */ }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.from("first"));
      request.once("close", () => { upstreamClosed = true; resolveUpstreamClose(); });
      response.once("close", () => { upstreamClosed = true; resolveUpstreamClose(); });
    });
    const registry = registryFor(baseUrl);
    const controller = new AbortController();
    await expect(registry.forwardHttpStream({
      serviceId: "binary-fixture",
      operationKey: "convert",
      requestHeaders: { "content-type": "application/octet-stream" },
      contentLength: 1,
      requestStream: Readable.from([Buffer.from("x")])
    }, { subjectId: "owner", scopes: ["gateway:write"] }, {
      signal: controller.signal,
      async consumeResponse(upstream) {
        for await (const _chunk of upstream.body) {
          controller.abort(new Error("caller stopped"));
        }
      }
    })).rejects.toMatchObject({ status: 499, reasonCode: "upstream_forward_cancelled" });
    await Promise.race([
      upstreamClose,
      new Promise((resolve) => setTimeout(resolve, 500))
    ]);
    expect(upstreamClosed).toBe(true);
  });
});
