import { describe, expect, it } from "vitest";
import { createModernDownstreamAdapter } from "@meshrix/protocols/mcp/modern-downstream";
import { context, descriptor, modernHttpRequest, modernRequestMessage, QueueUpstream, response, createTestGateway as createGateway } from "../support";

describe("modern MCP downstream adapter", () => {
  it("[CASE-P01 CASE-P04] accepts a neutral client and returns standard catalog and tool results", async () => {
    const upstream = new QueueUpstream([response({ resultType: "complete", value: { content: [{ type: "text", text: "ok" }] } })]);
    const gateway = createGateway({ upstream, descriptors: [descriptor()] });
    await gateway.start();
    try {
      const adapter = createModernDownstreamAdapter({ gateway });
      const initialized = await adapter.handle({ ...modernHttpRequest("initialize", 1), context });
      expect(initialized).toMatchObject({ status: 404, body: { error: { code: -32601 } } });
      const listed = await adapter.handle({ ...modernHttpRequest("tools/list", 2), context });
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({ result: { tools: [{ name: "demo" }], ttlMs: 0, cacheScope: "private" } });
      const called = await adapter.handle({ ...modernHttpRequest("tools/call", 3, { name: "demo", arguments: { traceId: "business" } }), context });
      expect(called.status).toBe(200);
      expect(called.body).toMatchObject({ result: { resultType: "complete" } });
      expect(upstream.requests[0].request.params).toMatchObject({ name: "demo" });
    } finally {
      await gateway.close();
    }
  });

  it("[CASE-P02] rejects mismatched headers and batch requests before calling upstream", async () => {
    const upstream = new QueueUpstream();
    const gateway = createGateway({ upstream, descriptors: [descriptor()] });
    await gateway.start();
    try {
      const adapter = createModernDownstreamAdapter({ gateway });
      const mismatch = modernHttpRequest("tools/list", 1, {}, {}, { "Mcp-Method": "tools/call" });
      expect(await adapter.handle({ ...mismatch, context })).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
      const oldVersion = modernHttpRequest("tools/list", 2, {}, { "io.modelcontextprotocol/protocolVersion": "old-version" }, { "MCP-Protocol-Version": "old-version" });
      expect(await adapter.handle({ ...oldVersion, context })).toMatchObject({ status: 400, body: { error: { code: -32022 } } });
      const nameMismatch = modernHttpRequest("tools/call", 3, { name: "demo" });
      nameMismatch.headers["Mcp-Name"] = "other";
      expect(await adapter.handle({ ...nameMismatch, context })).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
      const subscription = await adapter.handle({ ...modernHttpRequest("subscriptions/listen", 4), context });
      expect(subscription).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
      const missingHeader = modernHttpRequest("tools/list", 5);
      delete (missingHeader.headers as Record<string, string>)["Mcp-Method"];
      expect(await adapter.handle({ ...missingHeader, context })).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
      const missingMetadata = { ...modernHttpRequest("tools/list", 6), body: { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} } };
      expect(await adapter.handle({ ...missingMetadata, context })).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
      expect((await adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, body: [], context })).status).toBe(400);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      await gateway.close();
    }
  });

  it("returns private zero-TTL metadata for every authorization-scoped catalog and resource-read result", async () => {
    const gateway = {
      catalog: () => ({ items: [] }),
      readResource: async () => ({ kind: "complete" as const, value: { contents: [], ttlMs: 60_000, cacheScope: "public" } })
    };
    const adapter = createModernDownstreamAdapter({ gateway: gateway as any });
    for (const method of ["tools/list", "resources/list", "resources/templates/list", "prompts/list"]) {
      const result = await adapter.handle({ ...modernHttpRequest(method, method), context });
      expect(result.body).toMatchObject({ result: { ttlMs: 0, cacheScope: "private" } });
    }
    const readRequest = modernHttpRequest("resources/read", "resource-read", { uri: "demo://private/资料" });
    expect(readRequest.headers["Mcp-Name"]).toMatch(/^=\?base64\?/u);
    const resource = await adapter.handle({ ...readRequest, context });
    expect(resource.body).toMatchObject({ result: { contents: [], ttlMs: 0, cacheScope: "private" } });
  });

  it("requires request metadata on stdio without requiring HTTP mirror headers", async () => {
    const upstream = new QueueUpstream([response({ resultType: "complete", content: [{ type: "text", text: "ok" }] })]);
    const gateway = createGateway({ upstream, descriptors: [descriptor()] });
    await gateway.start();
    try {
      const adapter = createModernDownstreamAdapter({ gateway });
      const invalidRequests = [
        { jsonrpc: "2.0", id: "stdio-missing", method: "tools/call", params: { name: "demo", arguments: {} } },
        { jsonrpc: "2.0", id: "stdio-malformed", method: "tools/call", params: { name: "demo", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": [] } } }
      ];
      for (const body of invalidRequests) {
        expect(await adapter.handle({ transport: "stdio", method: "POST", body, context })).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
        expect(upstream.requests).toHaveLength(0);
      }
      const accepted = await adapter.handle({ transport: "stdio", method: "POST", body: modernRequestMessage("tools/call", "stdio-valid", { name: "demo", arguments: {} }), context });
      expect(accepted).toMatchObject({ status: 200, body: { result: { resultType: "complete" } } });
      expect(upstream.requests).toHaveLength(1);
    } finally {
      await gateway.close();
    }
  });

  it("[CASE-C05 CASE-C06 CASE-C07] opens a POST stream and re-authorizes every delivery", async () => {
    const gateway = createGateway({
      upstream: new QueueUpstream(),
      descriptors: [descriptor()]
    });
    await gateway.start();
    let authenticateCalls = 0;
    try {
      const adapter = createModernDownstreamAdapter({
        gateway,
        authenticate: async () => {
          authenticateCalls += 1;
          return context;
        },
        subscriptionByteBudget: 4096
      });
      const opened = await adapter.handle({ ...modernHttpRequest("subscriptions/listen", "sub-1", { notifications: { toolsListChanged: true } }), context });
      expect(opened.status).toBe(200);
      expect(opened.body).toMatchObject({ result: { subscriptionId: "sub-1", transport: "post-stream" } });
      const iterator = opened.stream?.[Symbol.asyncIterator]();
      expect(iterator).toBeDefined();
      gateway.publishEvent(context, { type: "tools/list_changed", revision: "revision-1", payload: { changed: true } });
      await expect(iterator?.next()).resolves.toMatchObject({
        value: { method: "notifications/tools/list_changed", params: { _meta: { revision: "revision-1", "io.modelcontextprotocol/subscriptionId": "sub-1" } } }
      });
      expect(authenticateCalls).toBe(2);
      gateway.publishEvent(context, { type: "tools/list_changed", revision: "revision-2", payload: { changed: true } });
      await expect(iterator?.next()).resolves.toMatchObject({
        value: { method: "notifications/tools/list_changed", params: { _meta: { revision: "revision-2", "io.modelcontextprotocol/subscriptionId": "sub-1" } } }
      });
      expect(authenticateCalls).toBe(3);
      await iterator?.return?.();
      opened.close?.();
    } finally {
      await gateway.close();
    }
  });

  it("[CASE-C06] closes the stream when one delivery exceeds the adapter byte budget", async () => {
    const gateway = createGateway({ upstream: new QueueUpstream(), descriptors: [descriptor()] });
    await gateway.start();
    try {
      const adapter = createModernDownstreamAdapter({ gateway, subscriptionByteBudget: 256 });
      const opened = await adapter.handle({ ...modernHttpRequest("subscriptions/listen", "sub-budget", { notifications: { toolsListChanged: true } }), context });
      expect(opened.status).toBe(200);
      const iterator = opened.stream?.[Symbol.asyncIterator]();
      gateway.publishEvent(context, { type: "tools/list_changed", revision: "oversized", payload: { blob: "x".repeat(1024) } });
      await expect(iterator?.next()).resolves.toMatchObject({ done: true });
      await iterator?.return?.();
      opened.close?.();
    } finally {
      await gateway.close();
    }
  });

  it("[CASE-C07] stops delivering once a delivery is no longer authorized", async () => {
    const gateway = createGateway({ upstream: new QueueUpstream(), descriptors: [descriptor()] });
    await gateway.start();
    let authorized = true;
    try {
      const adapter = createModernDownstreamAdapter({
        gateway,
        authenticate: async () => (authorized ? context : { ...context, grant: Object.freeze({ revision: "grant-2" }) })
      });
      const opened = await adapter.handle({ ...modernHttpRequest("subscriptions/listen", "sub-revoke", { notifications: { toolsListChanged: true } }), context });
      expect(opened.status).toBe(200);
      const iterator = opened.stream?.[Symbol.asyncIterator]();
      authorized = false;
      gateway.publishEvent(context, { type: "tools/list_changed", revision: "revoked", payload: { changed: true } });
      await expect(iterator?.next()).resolves.toMatchObject({ done: true });
      await iterator?.return?.();
      opened.close?.();
    } finally {
      await gateway.close();
    }
  });

  it("[CASE-C05] serves every declared subscription capability and rejects undeclared ones", async () => {
    const gateway = createGateway({ upstream: new QueueUpstream(), descriptors: [descriptor()] });
    await gateway.start();
    try {
      const adapter = createModernDownstreamAdapter({ gateway });
      const declared = [
        ["toolsListChanged", "tools/list_changed"],
        ["resourcesListChanged", "resources/list_changed"],
        ["promptsListChanged", "prompts/list_changed"],
        ["resourceUpdated", "resource/updated"]
      ] as const;
      const initialized = await adapter.handle({ ...modernHttpRequest("initialize", 1), context });
      expect(initialized).toMatchObject({ status: 404, body: { error: { code: -32601 } } });
      const opened = await adapter.handle({ ...modernHttpRequest("subscriptions/listen", "sub-cap", { notifications: Object.fromEntries(declared.map(([flag]) => [flag, true])) }), context });
      expect(opened.status).toBe(200);
      const iterator = opened.stream?.[Symbol.asyncIterator]();
      for (const [flag, eventType] of declared) {
        gateway.publishEvent(context, { type: eventType, revision: `revision-${flag}`, payload: { changed: true } });
        await expect(iterator?.next()).resolves.toMatchObject({ value: { params: { _meta: { revision: `revision-${flag}` } } } });
      }
      await iterator?.return?.();
      opened.close?.();
      const undeclared = await adapter.handle({ ...modernHttpRequest("subscriptions/listen", "sub-undeclared", { notifications: { resourceSubscriptions: true } }), context });
      expect(undeclared.status).toBe(400);
      const unadvertisedMethod = await adapter.handle({ ...modernHttpRequest("resources/subscribe", "res-sub", { uri: "demo://resource" }), context });
      expect(unadvertisedMethod).toMatchObject({ status: 404, body: { error: { code: -32601 } } });
    } finally {
      await gateway.close();
    }
  });

  it("[GC-028] projects authentication diagnostics to a closed public refusal", async () => {
    const privateMarker = "<authentication-private-diagnostic>";
    const upstream = new QueueUpstream();
    const gateway = createGateway({ upstream, descriptors: [descriptor()] });
    await gateway.start();
    try {
      const adapter = createModernDownstreamAdapter({
        gateway,
        authenticate: () => { throw Object.assign(new Error(privateMarker), { code: privateMarker, status: 401, cause: new Error(privateMarker) }); }
      });
      const denied = await adapter.handle(modernHttpRequest("tools/call", "auth-denied", { name: "demo", arguments: {} }));
      expect(denied).toMatchObject({ status: 401, body: { error: { code: -32001, message: "Authentication failed." } } });
      expect(JSON.stringify(denied.body)).not.toContain(privateMarker);
      expect(upstream.requests).toHaveLength(0);
      const platformDenied = createModernDownstreamAdapter({
        gateway,
        authenticate: () => { throw Object.assign(new Error("provider detail"), { code: "api_key_inactive", status: 401 }); }
      });
      const refusal = await platformDenied.handle(modernHttpRequest("tools/call", "auth-platform", { name: "demo", arguments: {} }));
      expect(refusal).toMatchObject({ status: 401, body: { error: { message: "Authentication failed.", data: { code: "api_key_inactive" } } } });
    } finally {
      await gateway.close();
    }
  });
});
