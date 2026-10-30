import { describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";
import { createGatewaySchemaPort } from "@meshrix/server-runtime/composition/gateway-schema-port";
const canned1 = "tools/call";




function mcpRegistry(tools: any[]) : any {
  return createUpstreamGatewayRegistry({
    schemaPort: createGatewaySchemaPort(),
    mcpSessionManager: {
      listTools: async () => ({ tools }),
      invokeGateway: async () => ({ result: { content: [] } }),
      retireScope: async () => ({ retired: 0 }),
      close: async () => {}
    }
  });
}

function mcpService(aliases: Record<string, any> = {}) : any {
  return {
    serviceId: "vault",
    serviceProtocol: "mcp",
    label: "vault",
    allowLocalNetwork: true,
    operations: [{ operationKey: canned1, protocol: "mcp", risk: "read_only", requiredScopes: ["gateway:read"] }],
    mcp: { transport: "http", url: "http://127.0.0.1:9/mcp", protocolVersion: "2025-06-18", aliases }
  };
}

describe("MCP tool aliases", () => {
  it("projects curated public names, titles and descriptions", async () => {
    const registry = mcpRegistry([
      { name: "store", inputSchema: { type: "object" } },
      { name: "fetch", inputSchema: { type: "object" }, description: "raw fetch" }
    ]);
    installUpstreamRuntimeServices(registry, [mcpService({
      store: { name: "kv_store", title: "Key-value store", description: "Curated vault write." },
      fetch: "kv_fetch"
    })]);
    try {
      const listed = await registry.listMcpTools({ serviceId: "vault" });
      const names = listed.items.map((tool: any) => tool.name);
      expect(names).toEqual(["upstream.vault.kv_store", "upstream.vault.kv_fetch"]);
      const store = listed.items.find((tool: any) => tool.name === "upstream.vault.kv_store");
      expect(store.title).toBe("Key-value store");
      expect(store.description).toBe("Curated vault write.");
      // The upstream identity stays visible in the projection metadata.
      expect(store._meta.upstreamToolName).toBe("store");
    } finally {
      await registry.close();
    }
  });

  it("never shadows a public name — a colliding alias leaves the tool unpublished", async () => {
    const registry = mcpRegistry([
      { name: "store", inputSchema: { type: "object" } },
      { name: "store-2", inputSchema: { type: "object" } }
    ]);
    installUpstreamRuntimeServices(registry, [mcpService({
      store: { name: "shared" },
      "store-2": { name: "shared" }
    })]);
    try {
      const listed = await registry.listMcpTools({ serviceId: "vault" });
      // First claim wins; the second colliding tool is dropped, not shadowed.
      expect(listed.items.map((tool: any) => tool.name)).toEqual(["upstream.vault.shared"]);
    } finally {
      await registry.close();
    }
  });
});
