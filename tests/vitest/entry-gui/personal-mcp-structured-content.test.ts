import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { createPersonalApplicationMcpBridge } from "../../../apps/entry-gui/src/main/personal-mcp.ts";
import type { GuiLoopbackClient } from "../../../apps/entry-gui/src/shared/loopback-client.ts";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON-RPC response object.");
  return value as Record<string, unknown>;
}

describe("personal MCP structured tool results", () => {
  it("uses the official result schema for array and missing-record responses through a standard client", async () => {
    const bridge = createPersonalApplicationMcpBridge({
      client: {
        async invoke<T>(op: string): Promise<{ ok: true; value: T }> {
          return { ok: true, value: (op === "application.list" ? [] : null) as T };
        }
      } as unknown as GuiLoopbackClient
    });
    const server = new McpServer({ name: "meshrix-personal-test", version: "0.1.0" });
    const register = (name: string, inputSchema: Record<string, z.ZodTypeAny> = {}) => {
      server.registerTool(name, { inputSchema }, async (args) => {
        const rpc = asRecord(await bridge.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args }
        }));
        const result = asRecord(rpc.result);
        return result as never;
      });
    };
    register("meshrix_list_tasks");
    register("meshrix_get_task", { operationId: z.string() });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "meshrix-standard-test-client", version: "0.1.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const list = await client.callTool({ name: "meshrix_list_tasks", arguments: {} });
      expect(CallToolResultSchema.parse(list).structuredContent).toEqual({ items: [] });
      expect(list.content[0]).toMatchObject({ type: "text", text: "[]" });

      const missing = await client.callTool({ name: "meshrix_get_task", arguments: { operationId: "missing" } });
      expect(CallToolResultSchema.parse(missing).structuredContent).toEqual({ found: false });
      expect(missing.content[0]).toMatchObject({ type: "text", text: "null" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
