import http from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";

const cleanup: any[] = [];

async function listen(handler?: any) : Promise<any> {
  const server: any = http.createServer(handler);
  await new Promise((resolve?: any, reject?: any) : any => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(() : any => new Promise((resolve?: any) : any => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function opaqueTransport(maxBytes: any = 1024 * 1024) : any {
  return {
    request: { mode: "opaque_stream", maxBytes, mediaTypes: ["application/octet-stream"] },
    response: { mode: "opaque_stream", maxBytes, mediaTypes: ["application/octet-stream"] }
  };
}

function registryFor(baseUrl?: any, maxBytes: any = 1024 * 1024) : any {
  const registry: any = createUpstreamGatewayRegistry();
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
  cleanup.push(() : any => registry.close());
  return registry;
}

afterEach(async () : Promise<any> => {
  await Promise.all(cleanup.splice(0).reverse().map((close?: any) : any => close()));
});

describe("native upstream payload transit", () : any => {
  it("preserves multi-chunk binary bodies and representation headers byte-for-byte", async () : Promise<any> => {
    const requestChunks: any[] = [];
    const responseBytes: any = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x7f, 0x80]);
    const baseUrl: any = await listen(async (request?: any, response?: any) : Promise<any> => {
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
    const registry: any = registryFor(baseUrl);
    const inputBytes: any = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x41, 0x00, 0x42]);
    const received: any[] = [];
    const result: any = await registry.forwardHttpStream({
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
      async consumeResponse(upstream?: any) : Promise<any> {
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

  it("rejects declared and streamed bodies beyond the published bounds", async () : Promise<any> => {
    let hits: any = 0;
    const baseUrl: any = await listen(async (request?: any, response?: any) : Promise<any> => {
      hits += 1;
      for await (const _chunk of request) { /* drain */ }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(16));
    });
    const registry: any = registryFor(baseUrl, 8);
    const invoke: any = (contentLength?: any, requestStream?: any) : any => registry.forwardHttpStream({
      serviceId: "binary-fixture",
      operationKey: "convert",
      requestHeaders: { "content-type": "application/octet-stream" },
      contentLength,
      requestStream
    }, { subjectId: "owner", scopes: ["gateway:write"] }, {
      consumeResponse: async (upstream?: any) : Promise<any> => {
        for await (const _chunk of upstream.body) { /* drain */ }
      }
    });
    await expect(invoke(9, Readable.from([]))).rejects.toMatchObject({ status: 413, reasonCode: "request_body_too_large" });
    expect(hits).toBe(0);
    await expect(invoke(null, Readable.from([Buffer.alloc(9)]))).rejects.toMatchObject({ status: 413, reasonCode: "request_body_too_large" });
  });

  it("propagates caller cancellation and settles the active stream", async () : Promise<any> => {
    let upstreamClosed: any = false;
    let resolveUpstreamClose: any;
    const upstreamClose: any = new Promise((resolve?: any) : any => { resolveUpstreamClose = resolve; });
    const baseUrl: any = await listen(async (request?: any, response?: any) : Promise<any> => {
      for await (const _chunk of request) { /* drain */ }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.from("first"));
      request.once("close", () : any => { upstreamClosed = true; resolveUpstreamClose(); });
      response.once("close", () : any => { upstreamClosed = true; resolveUpstreamClose(); });
    });
    const registry: any = registryFor(baseUrl);
    const controller: any = new AbortController();
    await expect(registry.forwardHttpStream({
      serviceId: "binary-fixture",
      operationKey: "convert",
      requestHeaders: { "content-type": "application/octet-stream" },
      contentLength: 1,
      requestStream: Readable.from([Buffer.from("x")])
    }, { subjectId: "owner", scopes: ["gateway:write"] }, {
      signal: controller.signal,
      async consumeResponse(upstream?: any) : Promise<any> {
        for await (const _chunk of upstream.body) {
          controller.abort(new Error("caller stopped"));
        }
      }
    })).rejects.toMatchObject({ status: 499, reasonCode: "upstream_forward_cancelled" });
    await Promise.race([
      upstreamClose,
      new Promise((resolve?: any) : any => setTimeout(resolve, 500))
    ]);
    expect(upstreamClosed).toBe(true);
  });
});
