import { describe, expect, it } from "vitest";
import { createCatalogStore } from "@meshrix/gateway";
import { context, descriptor, route, createTestGateway } from "../support";
import { createModernDownstreamAdapter } from "@meshrix/protocols/mcp/modern-downstream";

describe("source catalog versus authorized views", () => {
  it("[GC-039] another subject's publication cannot invalidate a private page or reveal its route", () => {
    const catalog = createCatalogStore();
    const forA = Array.from({ length: 120 }, (_, index) => descriptor({ publicName: `a-${index}`, route: route({ logicalRoute: `a-${index}` }) }));
    const forB = descriptor({ publicName: "only-b", route: route({ logicalRoute: "only-b" }) });
    catalog.publish(forA);
    const a = { ...context, principal: "subject-a", grant: { revision: "grant-a", routes: forA.map((item) => item.route.logicalRoute) } };
    const b = { ...context, principal: "subject-b", grant: { revision: "grant-b", routes: ["only-b"] } };
    const first = catalog.page(a, { kind: "tool", limit: 100 });
    expect(first.nextCursor).toBeDefined();
    catalog.publish([...forA, forB]);
    const second = catalog.page(a, { kind: "tool", limit: 100, cursor: first.nextCursor });
    expect(second.items).toHaveLength(20);
    expect(catalog.page(b, { kind: "tool" }).items.map((item) => item.publicName)).toEqual(["only-b"]);
    expect(() => catalog.page(b, { kind: "tool", cursor: first.nextCursor })).toThrow();
  });

  it("[GC-040] changes in an authorized route explicitly expire its previous cursor", () => {
    const catalog = createCatalogStore();
    const routes = Array.from({ length: 4 }, (_, index) => descriptor({ publicName: `entry-${index}`, route: route({ logicalRoute: `entry-${index}`, revision: "v1" }) }));
    catalog.publish(routes);
    const first = catalog.page(context, { kind: "tool", limit: 2 });
    catalog.publish(routes.map((entry, index) => index === 2 ? { ...entry, route: { ...entry.route, revision: "v2" } } : entry));
    expect(() => catalog.page(context, { kind: "tool", limit: 2, cursor: first.nextCursor })).toThrowError(expect.objectContaining({ code: "catalog_cursor_expired" }));
  });

  it("[GC-041] duplicate upstream names map to stable aliases regardless of source ordering", () => {
    const catalog = createCatalogStore();
    const first = descriptor({ publicName: "collision", route: route({ logicalRoute: "a" }) });
    const second = descriptor({ publicName: "collision", route: route({ logicalRoute: "b" }) });
    catalog.publish([first, second]);
    const before = new Map(catalog.snapshot().descriptors.map((item) => [item.route.logicalRoute, item.publicName]));
    catalog.publish([second, first]);
    const after = new Map(catalog.snapshot().descriptors.map((item) => [item.route.logicalRoute, item.publicName]));
    expect(after).toEqual(before);
    expect(after.get("a")).not.toBe(after.get("b"));
  });

  it("[GC-042] resource and prompt lookups do not stop at the first hundred published routes", async () => {
    const resources = Array.from({ length: 120 }, (_, index) => descriptor({ kind: "resource", publicName: `r-${index}`, upstreamUri: `meshrix://synthetic/${index}`, publicUri: `meshrix://synthetic/${index}`, route: route({ logicalRoute: `resource-${index}`, effectClass: "read", operation: "resources/read" }) }));
    const prompts = Array.from({ length: 120 }, (_, index) => descriptor({ kind: "prompt", publicName: `p-${index}`, upstreamName: `p-${index}`, route: route({ logicalRoute: `prompt-${index}`, effectClass: "read", operation: "prompts/get" }) }));
    const gateway = createTestGateway({ descriptors: [...resources, ...prompts], resources: { read: async ({ route: resolved }) => ({ kind: "complete", value: { contents: [{ uri: resolved.upstreamUri, text: "observed" }] } }) },
      prompts: { get: async ({ name }) => ({ kind: "complete", value: { messages: [{ role: "user", content: { type: "text", text: name } }] } }) } });
    await gateway.start();
    try {
      expect(await gateway.readResource(context, "meshrix://synthetic/119")).toMatchObject({ kind: "complete", value: { contents: [{ text: "observed" }] } });
      expect(await gateway.getPrompt(context, "p-119")).toMatchObject({ kind: "complete", value: { messages: [{ content: { text: "p-119" } }] } });
    } finally { await gateway.close(); }
  });

  it("[GC-026] publishes schema annotations title and prompt argument declarations without promoting annotations to authority", async () => {
    const gateway = createTestGateway({ descriptors: [
      descriptor({ kind: "tool", publicName: "catalog-tool", inputSchema: { type: "object", properties: { value: { type: "string" } } }, outputSchema: { type: "object", properties: { ok: { type: "boolean" } } }, annotations: { readOnlyHint: true, arbitraryHint: "business" }, metadata: { title: "Catalog Tool" }, route: route({ logicalRoute: "tool-route", effectClass: "unknown" }) }),
      descriptor({ kind: "prompt", publicName: "catalog-prompt", metadata: { arguments: [{ name: "label", required: true }] }, route: route({ logicalRoute: "prompt-route", operation: "prompts/get", effectClass: "read" }) })
    ] });
    await gateway.start();
    try {
      const adapter = createModernDownstreamAdapter({ gateway, authenticate: () => context });
      const send = async (method: string, params: Record<string, unknown> = {}) => (await adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id: method, method, params } })).body as Record<string, any>;
      expect((await send("tools/list")).result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "catalog-tool", title: "Catalog Tool", inputSchema: { type: "object", properties: { value: { type: "string" } } }, outputSchema: { type: "object", properties: { ok: { type: "boolean" } } }, annotations: { readOnlyHint: true, arbitraryHint: "business" } })]));
      expect((await send("prompts/list")).result.prompts).toEqual(expect.arrayContaining([expect.objectContaining({ name: "catalog-prompt", arguments: [{ name: "label", required: true }] })]));
      expect((await send("tools/call", { name: "catalog-tool", arguments: {} })).error.data.code).toBe("effect_class_unknown");
    } finally { await gateway.close(); }
  });
});
