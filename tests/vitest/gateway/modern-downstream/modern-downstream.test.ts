import { describe, expect, it } from "vitest";
import { createGateway } from "@meshrix/gateway";
import { createModernDownstreamAdapter } from "@meshrix/protocols/mcp/modern-downstream";
import { context, descriptor, QueueUpstream, response } from "../support";

describe("modern MCP downstream adapter", () => {
  it("[CASE-P01 CASE-P04] accepts a neutral client and returns standard catalog and tool results", async () => {
    const upstream = new QueueUpstream([response({ resultType: "complete", value: { content: [{ type: "text", text: "ok" }] } })]);
    const gateway = createGateway({ upstream, descriptors: [descriptor()] });
    await gateway.start();
    try {
      const adapter = createModernDownstreamAdapter({ gateway });
      const initialized = await adapter.handle({ method: "POST", headers: { "content-type": "application/json", "mcp-method": "initialize" }, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {}, clientInfo: { name: "unlisted-client", version: "1" } }, context });
      expect(initialized.status).toBe(200);
      const listed = await adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, context });
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({ result: { tools: [{ name: "demo" }] } });
      const called = await adapter.handle({ method: "POST", headers: { "content-type": "application/json", "mcp-method": "tools/call", "mcp-name": "demo" }, body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "demo", arguments: { traceId: "business" } } }, context });
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
      expect((await adapter.handle({ method: "POST", headers: { "content-type": "application/json", "mcp-method": "tools/list" }, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }, context })).status).toBe(400);
      expect((await adapter.handle({ method: "POST", headers: { "content-type": "application/json", "mcp-protocol-version": "old-version" }, body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, context })).status).toBe(400);
      expect((await adapter.handle({ method: "POST", headers: { "content-type": "application/json", "mcp-name": "other" }, body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "demo" } }, context })).status).toBe(400);
      expect((await adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id: 4, method: "subscriptions/listen", params: {} }, context })).status).toBe(400);
      expect((await adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, body: [], context })).status).toBe(400);
      expect(upstream.requests).toHaveLength(0);
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
      const opened = await adapter.handle({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", id: "sub-1", method: "subscriptions/listen", params: { notifications: { toolsListChanged: true } } },
        context
      });
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
      const opened = await adapter.handle({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", id: "sub-budget", method: "subscriptions/listen", params: { notifications: { toolsListChanged: true } } },
        context
      });
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
      const opened = await adapter.handle({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", id: "sub-revoke", method: "subscriptions/listen", params: { notifications: { toolsListChanged: true } } },
        context
      });
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
      const initialized = await adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, context });
      const capabilities = (initialized.body as { result: { capabilities: Record<string, unknown> } }).result.capabilities;
      expect(capabilities).toEqual({ tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true }, subscriptions: { listen: true } });
      const opened = await adapter.handle({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", id: "sub-cap", method: "subscriptions/listen", params: { notifications: Object.fromEntries(declared.map(([flag]) => [flag, true])) } },
        context
      });
      expect(opened.status).toBe(200);
      const iterator = opened.stream?.[Symbol.asyncIterator]();
      for (const [flag, eventType] of declared) {
        gateway.publishEvent(context, { type: eventType, revision: `revision-${flag}`, payload: { changed: true } });
        await expect(iterator?.next()).resolves.toMatchObject({ value: { params: { _meta: { revision: `revision-${flag}` } } } });
      }
      await iterator?.return?.();
      opened.close?.();
      const undeclared = await adapter.handle({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", id: "sub-undeclared", method: "subscriptions/listen", params: { notifications: { resourceSubscriptions: true } } },
        context
      });
      expect(undeclared.status).toBe(400);
      const unadvertisedMethod = await adapter.handle({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", id: "res-sub", method: "resources/subscribe", params: { uri: "demo://resource" } },
        context
      });
      expect(unadvertisedMethod.status).toBe(400);
    } finally {
      await gateway.close();
    }
  });
});
