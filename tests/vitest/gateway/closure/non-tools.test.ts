import { describe, expect, it } from "vitest";
import { createModernDownstreamAdapter } from "@meshrix/protocols/mcp/modern-downstream";
import { context, createTestGateway, descriptor, route } from "../support";

describe("non-tool MCP methods", () => {
  it("[GC-043 GC-045 partial] lists a resource template, projects only URI fields and leaves ordinary text unchanged", async () => {
    const sourceTemplate = "meshrix://upstream/data/{name}";
    const sourceUri = "meshrix://upstream/data/widget";
    const observed: string[] = [];
    const gateway = createTestGateway({ descriptors: [descriptor({ kind: "resource_template", publicName: "templated", upstreamUri: sourceTemplate,
      route: route({ logicalRoute: "read-template", operation: "resources/read", effectClass: "read", upstreamUri: sourceTemplate }) })],
      resources: { read: async ({ uri }) => { observed.push(uri); return { kind: "complete", value: { contents: [{ uri, text: `Business text ${sourceUri} stays unchanged.` }] } }; } } });
    await gateway.start();
    try {
      const adapter = createModernDownstreamAdapter({ gateway, authenticate: (request) => request.headers?.["x-subject"] === "outsider"
        ? { ...context, principal: "outsider", grant: { revision: "other", routes: [] } } : context });
      const send = async (method: string, params: Record<string, unknown> = {}, outsider = false) => (await adapter.handle({ method: "POST", headers: { "content-type": "application/json", ...(outsider ? { "x-subject": "outsider" } : {}) }, body: { jsonrpc: "2.0", id: method, method, params } })).body as Record<string, any>;
      const listed = await send("resources/templates/list");
      const uriTemplate = listed.result.resourceTemplates.find((item: Record<string, unknown>) => item.name === "templated")?.uriTemplate as string;
      expect(uriTemplate).toContain("{name}");
      const publicUri = uriTemplate.replace("{name}", "widget");
      const read = await send("resources/read", { uri: publicUri });
      expect(read.result).toMatchObject({ resultType: "complete", contents: [{ uri: publicUri, text: `Business text ${sourceUri} stays unchanged.` }] });
      expect(observed).toEqual([sourceUri]);
      expect((await send("resources/read", { uri: publicUri }, true)).error.data.code).toBe("resource_not_found");
      expect(observed).toHaveLength(1);
      expect((await send("resources/read", { uri: uriTemplate.replace("{name}", "../secret") })).error).toBeDefined();
      expect(observed).toHaveLength(1);
    } finally { await gateway.close(); }
  });

  it("[GC-044] keeps two resource subscriptions separate and closes only the revoked subject", async () => {
    let revokedA = false;
    const a = { ...context, principal: "subject-a", grant: { revision: "a", routes: ["resource-a"] } };
    const b = { ...context, principal: "subject-b", grant: { revision: "b", routes: ["resource-b"] } };
    const gateway = createTestGateway({ descriptors: [
      descriptor({ kind: "resource", publicUri: "meshrix://fixture/a", route: route({ logicalRoute: "resource-a", operation: "resources/read", effectClass: "read" }) }),
      descriptor({ kind: "resource", publicUri: "meshrix://fixture/b", route: route({ logicalRoute: "resource-b", operation: "resources/read", effectClass: "read" }) })
    ] });
    await gateway.start();
    try {
      const adapter = createModernDownstreamAdapter({ gateway, authenticate: async (request) => {
        const subject = request.headers?.["x-subject"] === "a" ? a : b;
        if (subject === a && revokedA) throw Object.assign(new Error("grant revoked"), { status: 403 });
        return subject;
      } });
      const subscribe = async (subject: string) => adapter.handle({ method: "POST", headers: { "content-type": "application/json", "x-subject": subject }, body: { jsonrpc: "2.0", id: subject, method: "subscriptions/listen", params: { notifications: { resourceUpdated: true } } } });
      const aStream = await subscribe("a");
      const bStream = await subscribe("b");
      expect(aStream.status).toBe(200);
      expect(bStream.status).toBe(200);
      const aIterator = aStream.stream![Symbol.asyncIterator]();
      const bIterator = bStream.stream![Symbol.asyncIterator]();
      gateway.publishEvent(a, { type: "resource/updated", payload: { uri: "meshrix://fixture/a" } });
      expect((await aIterator.next()).value).toMatchObject({ method: "notifications/resources/updated" });
      const waitingB = bIterator.next();
      gateway.publishEvent(b, { type: "resource/updated", payload: { uri: "meshrix://fixture/b" } });
      expect((await waitingB).value).toMatchObject({ method: "notifications/resources/updated", params: expect.objectContaining({ uri: "meshrix://fixture/b" }) });
      revokedA = true;
      gateway.publishEvent(a, { type: "resource/updated", payload: { uri: "meshrix://fixture/a" } });
      expect((await aIterator.next()).done).toBe(true);
      gateway.publishEvent(b, { type: "resource/updated", payload: { uri: "meshrix://fixture/b" } });
      expect((await bIterator.next()).done).toBe(false);
      aStream.close?.();
      bStream.close?.();
    } finally { await gateway.close(); }
  });
});
